//! Explicit-content import parsing and transactional proposal application.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{Duration, Utc};
use ekg_contracts::{
    ApplyImportContentInput, ApplyImportContentResult, ImportContentSource, ImportPreviewResult,
    ImportProposalRecord, NodeStatus, NodeType, PreviewImportContentInput, ProjectReference,
    Validate,
};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{WriteError, WriteRepository};

const PARSER_VERSION: &str = "import-parser-v1";
const MAX_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_SOURCES: usize = 32;
const MAX_PROPOSALS_PER_SOURCE: usize = 100;
const MAX_PROPOSAL_TEXT_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceManifest {
    path_hint: String,
    digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposalPayload {
    status: NodeStatus,
    case_title: String,
    data: BTreeMap<String, Value>,
}

struct ProposalRow {
    id: String,
    source_key: String,
    node_type: NodeType,
    payload: ProposalPayload,
}

impl WriteRepository {
    pub fn preview_import_content(
        &mut self,
        input: PreviewImportContentInput,
    ) -> Result<ImportPreviewResult, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        validate_sources(&input.sources)?;
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        let manifests = manifests(&input.sources);
        let source_digest = digest_json(&manifests)?;
        let created_at = timestamp();
        let expires_at =
            (Utc::now() + Duration::hours(24)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let preview_id = id();
        let mut proposals = Vec::new();
        for (source_index, source) in input.sources.iter().enumerate() {
            let source_digest = &manifests[source_index].digest;
            for (proposal_index, draft) in parse_content(source).into_iter().enumerate() {
                proposals.push(ImportProposalRecord {
                    id: id(),
                    source_key: format!("{source_digest}:{source_index}:{proposal_index}"),
                    node_type: draft.node_type,
                    status: NodeStatus::Candidate,
                    case_title: draft.case_title,
                    data: draft.data,
                });
            }
        }
        transaction.execute(
            "INSERT INTO import_previews (id,project_id,source_digest,status,created_at,parser_version,source_manifest,expires_at) VALUES (?,?,?,'pending',?,?,?,?)",
            params![preview_id, project_id, source_digest, created_at, PARSER_VERSION, serde_json::to_string(&manifests)?, expires_at],
        )?;
        for proposal in &proposals {
            let payload = ProposalPayload {
                status: proposal.status,
                case_title: proposal.case_title.clone(),
                data: proposal.data.clone(),
            };
            transaction.execute(
                "INSERT INTO import_proposals (id,project_id,preview_id,source_key,node_type,payload,created_at) VALUES (?,?,?,?,?,?,?)",
                params![proposal.id, project_id, preview_id, proposal.source_key, node_type_text(proposal.node_type), serde_json::to_string(&payload)?, created_at],
            )?;
        }
        let result = ImportPreviewResult {
            preview_id,
            project_id,
            parser_version: PARSER_VERSION.into(),
            source_digest,
            created_at,
            expires_at,
            proposals,
        };
        transaction.commit()?;
        Ok(result)
    }

    pub fn apply_import_content(
        &mut self,
        input: ApplyImportContentInput,
    ) -> Result<ApplyImportContentResult, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        validate_sources(&input.sources)?;
        if input.operation_id.trim().is_empty()
            || input.preview_id.trim().is_empty()
            || input.proposal_ids.is_empty()
        {
            return Err(WriteError::Validation("apply import"));
        }
        let selected = deduplicate(input.proposal_ids);
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        if let Some(mut result) = replay_operation(&transaction, &project_id, &input.operation_id)?
        {
            if result.preview_id != input.preview_id || result.proposal_ids != selected {
                return Err(WriteError::OperationConflict);
            }
            result.created = 0;
            transaction.commit()?;
            return Ok(result);
        }
        let preview = transaction
            .query_row(
                "SELECT project_id,source_digest,status,expires_at FROM import_previews WHERE id=?",
                [&input.preview_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()?
            .ok_or(WriteError::Validation("import preview"))?;
        if preview.0 != project_id {
            return Err(WriteError::OwnershipMismatch);
        }
        if preview.2 != "pending" || DateTimeOrd::expired(&preview.3) {
            return Err(WriteError::Validation("stale preview"));
        }
        if digest_json(&manifests(&input.sources))? != preview.1 {
            return Err(WriteError::Validation("stale preview"));
        }
        let rows = load_proposals(&transaction, &project_id, &input.preview_id)?;
        let by_id: BTreeMap<_, _> = rows.into_iter().map(|row| (row.id.clone(), row)).collect();
        if selected
            .iter()
            .any(|proposal_id| !by_id.contains_key(proposal_id))
        {
            return Err(WriteError::OwnershipMismatch);
        }
        let now = timestamp();
        let mut cases_by_title: BTreeMap<String, String> = BTreeMap::new();
        let mut case_ids = Vec::new();
        let mut node_ids = Vec::new();
        let mut imported = Vec::new();
        for proposal_id in &selected {
            let row = by_id
                .get(proposal_id)
                .expect("selected proposal was checked");
            validate_proposal(row)?;
            let case_id = if let Some(case_id) = cases_by_title.get(&row.payload.case_title) {
                case_id.clone()
            } else {
                let case_id = id();
                transaction.execute(
                    "INSERT INTO cases (id,project_id,title,status,created_at) VALUES (?,?,?,'candidate',?)",
                    params![case_id, project_id, row.payload.case_title, now],
                )?;
                append_event(
                    &transaction,
                    &project_id,
                    &case_id,
                    "case.created",
                    &case_id,
                    &json!({"caseId":case_id,"source":"import"}),
                    &now,
                )?;
                cases_by_title.insert(row.payload.case_title.clone(), case_id.clone());
                case_id
            };
            let node_id = id();
            transaction.execute(
                "INSERT INTO nodes (id,case_id,type,status,data,created_at) VALUES (?,?,?,'candidate',?,?)",
                params![node_id, case_id, node_type_text(row.node_type), serde_json::to_string(&row.payload.data)?, now],
            )?;
            transaction.execute(
                "INSERT INTO node_search (project_id,node_id,title,body) VALUES (?,?,?,?)",
                params![
                    project_id,
                    node_id,
                    row.payload.case_title,
                    serde_json::to_string(&row.payload.data)?
                ],
            )?;
            transaction.execute(
                "INSERT INTO source_keys (id,project_id,source_kind,source_key,node_id,created_at) VALUES (?,?,'import',?,?,?)",
                params![id(), project_id, format!("{}:{}", input.preview_id, row.source_key), node_id, now],
            )?;
            append_event(
                &transaction,
                &project_id,
                &case_id,
                "node.added",
                &node_id,
                &json!({"caseId":case_id,"nodeId":node_id,"type":node_type_text(row.node_type),"status":"candidate","source":"import"}),
                &now,
            )?;
            case_ids.push(case_id.clone());
            node_ids.push(node_id.clone());
            imported.push((case_id, node_id, row.node_type));
        }
        link_attempts(&transaction, &project_id, &imported, &now)?;
        let placeholders = std::iter::repeat_n("?", selected.len())
            .collect::<Vec<_>>()
            .join(",");
        let mut values = vec![
            rusqlite::types::Value::Text(project_id.clone()),
            rusqlite::types::Value::Text(input.preview_id.clone()),
        ];
        values.extend(selected.iter().cloned().map(rusqlite::types::Value::Text));
        transaction.execute(&format!("UPDATE import_proposals SET selected=1 WHERE project_id=? AND preview_id=? AND id IN ({placeholders})"), params_from_iter(values))?;
        transaction.execute(
            "UPDATE import_previews SET status='applied',applied_at=? WHERE id=? AND project_id=?",
            params![now, input.preview_id, project_id],
        )?;
        let result = ApplyImportContentResult {
            preview_id: input.preview_id,
            proposal_ids: selected,
            case_ids,
            node_ids,
            created: imported.len(),
        };
        transaction.execute("INSERT INTO operation_results (id,project_id,operation_id,kind,result,created_at) VALUES (?,?,?,'apply_import',?,?)",params![id(),project_id,input.operation_id,serde_json::to_string(&result)?,now])?;
        transaction.commit()?;
        Ok(result)
    }
}

#[derive(Clone)]
struct Draft {
    node_type: NodeType,
    case_title: String,
    data: BTreeMap<String, Value>,
}

fn parse_content(source: &ImportContentSource) -> Vec<Draft> {
    if source.path_hint.to_ascii_lowercase().ends_with(".json") {
        if let Ok(value) = serde_json::from_str::<Value>(&source.content) {
            let mut findings = Vec::new();
            collect_failures(&value, "", &mut findings);
            if !findings.is_empty() {
                return findings;
            }
        }
    }
    parse_text(&source.content)
}

fn parse_text(content: &str) -> Vec<Draft> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let content = normalized
        .lines()
        .map(redact_string)
        .collect::<Vec<_>>()
        .join("\n");
    let lines: Vec<_> = content.lines().collect();
    let headings: Vec<_> = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            line.trim_start()
                .strip_prefix('#')
                .and_then(|rest| rest.trim_start().strip_prefix(|c: char| c == '#'))
                .map(|_| index)
                .or_else(|| line.trim_start().strip_prefix('#').map(|_| index))
        })
        .collect();
    if headings.is_empty() {
        let nonempty: Vec<_> = lines
            .iter()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
            .collect();
        return nonempty
            .first()
            .map(|title| vec![problem(title, &nonempty[1..].join("\n"))])
            .unwrap_or_default();
    }
    headings
        .iter()
        .take(MAX_PROPOSALS_PER_SOURCE)
        .enumerate()
        .map(|(position, start)| {
            let line = lines[*start].trim_start_matches('#').trim();
            let end = headings.get(position + 1).copied().unwrap_or(lines.len());
            problem(line, &lines[start + 1..end].join("\n"))
        })
        .collect()
}

fn collect_failures(value: &Value, suite: &str, findings: &mut Vec<Draft>) {
    if findings.len() >= MAX_PROPOSALS_PER_SOURCE {
        return;
    }
    match value {
        Value::Array(values) => {
            for value in values {
                collect_failures(value, suite, findings)
            }
        }
        Value::Object(map) => {
            let next = map
                .get("name")
                .or_else(|| map.get("testFilePath"))
                .and_then(Value::as_str)
                .unwrap_or(suite);
            let title = map
                .get("title")
                .or_else(|| map.get("fullName"))
                .and_then(Value::as_str);
            let status = map
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_ascii_lowercase);
            if let (Some(title), Some(status)) = (title, status) {
                if ["failed", "failure", "broken", "error"].contains(&status.as_str()) {
                    let case_title = if next.is_empty() {
                        title.into()
                    } else {
                        format!("{next}: {title}")
                    };
                    let detail = map
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or(&status);
                    findings.push(problem(&case_title, detail));
                    findings.push(attempt(&case_title, detail));
                }
            }
            for (key, child) in map {
                if key != "failureMessages" {
                    collect_failures(child, next, findings)
                }
            }
        }
        _ => {}
    }
}
fn problem(title: &str, detail: &str) -> Draft {
    let summary = safe_text(title);
    let mut data = BTreeMap::from([(
        "summary".into(),
        Value::String(if summary.is_empty() {
            "Imported issue".into()
        } else {
            summary.clone()
        }),
    )]);
    let detail = safe_text(detail);
    if !detail.is_empty() {
        data.insert("symptoms".into(), Value::Array(vec![Value::String(detail)]));
    }
    Draft {
        node_type: NodeType::Problem,
        case_title: if summary.is_empty() {
            "Imported issue".into()
        } else {
            summary
        },
        data,
    }
}
fn attempt(title: &str, detail: &str) -> Draft {
    let title = safe_text(title);
    Draft {
        node_type: NodeType::Attempt,
        case_title: title.clone(),
        data: BTreeMap::from([
            (
                "hypothesis".into(),
                Value::String("Imported test execution".into()),
            ),
            ("change".into(), Value::String(format!("Ran test: {title}"))),
            ("outcome".into(), Value::String("failed".into())),
            (
                "failureExplanation".into(),
                Value::String(safe_text(detail)),
            ),
        ]),
    }
}
fn safe_text(value: &str) -> String {
    let value = redact_string(value.trim());
    if value.len() <= MAX_PROPOSAL_TEXT_BYTES {
        return value;
    }
    let mut end = MAX_PROPOSAL_TEXT_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1
    }
    value[..end].into()
}
fn validate_sources(sources: &[ImportContentSource]) -> Result<(), WriteError> {
    if sources.is_empty() || sources.len() > MAX_SOURCES {
        return Err(WriteError::Validation("import sources"));
    }
    if sources
        .iter()
        .any(|source| source.path_hint.trim().is_empty() || source.content.len() > MAX_SOURCE_BYTES)
    {
        return Err(WriteError::Validation("import source"));
    }
    Ok(())
}
fn manifests(sources: &[ImportContentSource]) -> Vec<SourceManifest> {
    sources
        .iter()
        .map(|source| SourceManifest {
            path_hint: source.path_hint.clone(),
            digest: digest(source.content.as_bytes()),
        })
        .collect()
}
fn digest_json<T: Serialize>(value: &T) -> Result<String, WriteError> {
    Ok(digest(&serde_json::to_vec(value)?))
}
fn digest(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}
fn deduplicate(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}
fn validate_proposal(row: &ProposalRow) -> Result<(), WriteError> {
    if row.payload.status != NodeStatus::Candidate || row.payload.case_title.trim().is_empty() {
        return Err(WriteError::Validation("import proposal"));
    }
    match row.node_type {
        NodeType::Problem
            if row
                .payload
                .data
                .get("summary")
                .and_then(Value::as_str)
                .is_some() =>
        {
            Ok(())
        }
        NodeType::Attempt
            if ["hypothesis", "change", "outcome"]
                .iter()
                .all(|key| row.payload.data.get(*key).and_then(Value::as_str).is_some()) =>
        {
            Ok(())
        }
        _ => Err(WriteError::Validation("import proposal data")),
    }
}
fn load_proposals(
    c: &Connection,
    project: &str,
    preview: &str,
) -> Result<Vec<ProposalRow>, WriteError> {
    let mut statement=c.prepare("SELECT id,source_key,node_type,payload FROM import_proposals WHERE project_id=? AND preview_id=? ORDER BY created_at,rowid")?;
    Ok(statement
        .query_map(params![project, preview], |row| {
            let node_type = parse_node_type(&row.get::<_, String>(2)?).ok_or_else(|| {
                rusqlite::Error::InvalidColumnType(
                    2,
                    "node_type".into(),
                    rusqlite::types::Type::Text,
                )
            })?;
            let payload = serde_json::from_str(&row.get::<_, String>(3)?).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(ProposalRow {
                id: row.get(0)?,
                source_key: row.get(1)?,
                node_type,
                payload,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?)
}
fn link_attempts(
    c: &Connection,
    project: &str,
    nodes: &[(String, String, NodeType)],
    now: &str,
) -> Result<(), WriteError> {
    for (case_id, node_id, node_type) in nodes {
        if *node_type != NodeType::Attempt {
            continue;
        }
        if let Some((_, problem_id, _)) = nodes
            .iter()
            .find(|(candidate, _, kind)| candidate == case_id && *kind == NodeType::Problem)
        {
            let edge = id();
            c.execute("INSERT INTO edges (id,case_id,source_id,relation,target_id,created_at) VALUES (?,?,?,'ATTEMPTS_TO_SOLVE',?,?)",params![edge,case_id,node_id,problem_id,now])?;
            append_event(
                c,
                project,
                case_id,
                "edge.added",
                &edge,
                &json!({"caseId":case_id,"sourceId":node_id,"relation":"ATTEMPTS_TO_SOLVE","targetId":problem_id}),
                now,
            )?;
        }
    }
    Ok(())
}
fn replay_operation(
    c: &Connection,
    project: &str,
    operation: &str,
) -> Result<Option<ApplyImportContentResult>, WriteError> {
    let row = c
        .query_row(
            "SELECT kind,result FROM operation_results WHERE project_id=? AND operation_id=?",
            params![project, operation],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    match row {
        None => Ok(None),
        Some((kind, _)) if kind != "apply_import" => Err(WriteError::OperationConflict),
        Some((_, result)) => Ok(Some(serde_json::from_str(&result)?)),
    }
}
fn resolve_project(c: &Connection, r: &ProjectReference) -> Result<String, WriteError> {
    let by_id = r
        .project_id
        .as_ref()
        .map(|id| {
            c.query_row("SELECT id FROM projects WHERE id=?", [id], |row| row.get(0))
                .optional()
        })
        .transpose()?
        .flatten();
    let by_root=r.project_root.as_ref().map(|root|c.query_row("SELECT projects.id FROM projects LEFT JOIN project_aliases ON project_aliases.project_id=projects.id WHERE canonical_root=? OR project_aliases.root=?",params![root,root],|row|row.get(0)).optional()).transpose()?.flatten();
    match (by_id, by_root) {
        (Some(a), Some(b)) if a != b => Err(WriteError::OwnershipMismatch),
        (Some(id), _) | (_, Some(id)) => Ok(id),
        _ => Err(WriteError::ProjectNotFound),
    }
}
fn append_event(
    c: &Connection,
    project: &str,
    case_id: &str,
    event: &str,
    aggregate: &str,
    payload: &Value,
    now: &str,
) -> Result<(), WriteError> {
    c.execute("INSERT INTO events (project_id,case_id,type,aggregate_id,payload,occurred_at) VALUES (?,?,?,?,?,?)",params![project,case_id,event,aggregate,serde_json::to_string(payload)?,now])?;
    Ok(())
}
fn parse_node_type(value: &str) -> Option<NodeType> {
    match value {
        "Problem" => Some(NodeType::Problem),
        "Attempt" => Some(NodeType::Attempt),
        _ => None,
    }
}
fn node_type_text(value: NodeType) -> &'static str {
    match value {
        NodeType::Problem => "Problem",
        NodeType::Attempt => "Attempt",
        NodeType::RootCause => "RootCause",
        NodeType::Solution => "Solution",
        NodeType::Verification => "Verification",
        NodeType::SuccessCase => "SuccessCase",
        NodeType::Guardrail => "Guardrail",
        NodeType::Artifact => "Artifact",
    }
}
fn redact_string(value: &str) -> String {
    value
        .split_whitespace()
        .scan(false, |next, part| {
            if *next {
                *next = false;
                return Some("[REDACTED]".into());
            }
            let lower = part.to_ascii_lowercase();
            if ["token:", "password:", "authorization:", "secret:"].contains(&lower.as_str()) {
                *next = true;
                Some(part.into())
            } else if ["token=", "password=", "authorization=", "secret="]
                .iter()
                .any(|marker| lower.starts_with(marker))
            {
                let key = part.split_once('=').map(|(key, _)| key).unwrap_or("");
                Some(format!("{key}=[REDACTED]"))
            } else {
                Some(part.into())
            }
        })
        .collect::<Vec<String>>()
        .join(" ")
}
fn id() -> String {
    Uuid::new_v4().to_string()
}
fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
struct DateTimeOrd;
impl DateTimeOrd {
    fn expired(value: &str) -> bool {
        chrono::DateTime::parse_from_rfc3339(value).map_or(true, |expires| Utc::now() > expires)
    }
}
