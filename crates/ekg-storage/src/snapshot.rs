use std::collections::{BTreeMap, BTreeSet};

use chrono::Utc;
use ekg_contracts::{
    EvidenceKind, ExportProjectGraphInput, ImportProjectGraphInput, ImportProjectGraphResult,
    NodeStatus, NodeType, ProjectGraphSnapshot, ProjectReference, RelationType, SnapshotArtifact,
    SnapshotCase, SnapshotCreatedCounts, SnapshotEdge, SnapshotEvidence, SnapshotFingerprint,
    SnapshotGuardrail, SnapshotNode, SnapshotProject, Validate,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::de::DeserializeOwned;
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{WriteError, WriteRepository};

const FORMAT: &str = "engineering-knowledge-graph";
const VERSION: u32 = 1;
const MAX_ARCHIVE_BYTES: usize = 1024 * 1024;
const MAX_COLLECTION: usize = 10_000;

impl WriteRepository {
    pub fn export_project_graph(
        &mut self,
        input: ExportProjectGraphInput,
    ) -> Result<ProjectGraphSnapshot, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        let project_id = resolve_project(&self.connection, &input.project)?;
        let project = self.connection.query_row(
            "SELECT id, name, description, created_at FROM projects WHERE id = ?",
            [&project_id],
            |row| {
                Ok(SnapshotProject {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    created_at: row.get(3)?,
                })
            },
        )?;
        let mut roots = vec![self.connection.query_row(
            "SELECT canonical_root FROM projects WHERE id = ?",
            [&project_id],
            |row| row.get::<_, String>(0),
        )?];
        roots.extend(collect(
            &self.connection,
            "SELECT root FROM project_aliases WHERE project_id = ? ORDER BY created_at, id",
            &project_id,
            |row| row.get(0),
        )?);
        roots.extend(roots.clone().into_iter().filter_map(|root| {
            root.strip_prefix("/private/var/")
                .map(|value| format!("/var/{value}"))
        }));
        let cases = collect(
            &self.connection,
            "SELECT id, project_id, title, status, created_at FROM cases WHERE project_id = ? ORDER BY created_at, id LIMIT 10001",
            &project_id,
            |row| {
                Ok(SnapshotCase {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    title: row.get(2)?,
                    status: parse(row.get::<_, String>(3)?)?,
                    created_at: row.get(4)?,
                })
            },
        )?;
        let nodes = collect(
            &self.connection,
            "SELECT nodes.id, nodes.case_id, nodes.type, nodes.status, nodes.data, nodes.created_at FROM nodes JOIN cases ON cases.id = nodes.case_id WHERE cases.project_id = ? ORDER BY nodes.created_at, nodes.id LIMIT 10001",
            &project_id,
            |row| {
                Ok(SnapshotNode {
                    id: row.get(0)?,
                    case_id: row.get(1)?,
                    node_type: parse(row.get::<_, String>(2)?)?,
                    status: parse(row.get::<_, String>(3)?)?,
                    data: serde_json::from_str(&row.get::<_, String>(4)?).map_err(json_sql)?,
                    created_at: row.get(5)?,
                })
            },
        )?;
        let edges = collect(
            &self.connection,
            "SELECT edges.id, edges.case_id, edges.source_id, edges.relation, edges.target_id, edges.created_at FROM edges JOIN cases ON cases.id = edges.case_id WHERE cases.project_id = ? ORDER BY edges.created_at, edges.id LIMIT 10001",
            &project_id,
            |row| {
                Ok(SnapshotEdge {
                    id: row.get(0)?,
                    case_id: row.get(1)?,
                    source_id: row.get(2)?,
                    relation: parse(row.get::<_, String>(3)?)?,
                    target_id: row.get(4)?,
                    created_at: row.get(5)?,
                })
            },
        )?;
        let evidence = collect(
            &self.connection,
            "SELECT id, project_id, node_id, kind, command, exit_status, data, created_at FROM evidence WHERE project_id = ? ORDER BY created_at, id LIMIT 10001",
            &project_id,
            |row| {
                let command: Option<String> = row.get(4)?;
                Ok(SnapshotEvidence {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    node_id: row.get(2)?,
                    kind: parse(row.get::<_, String>(3)?)?,
                    command: command
                        .map(|value| serde_json::from_str(&value).map_err(json_sql))
                        .transpose()?,
                    exit_status: row.get(5)?,
                    data: serde_json::from_str(&row.get::<_, String>(6)?).map_err(json_sql)?,
                    created_at: row.get(7)?,
                })
            },
        )?;
        let fingerprints = collect(
            &self.connection,
            "SELECT id, project_id, problem_node_id, algorithm, value, created_at FROM fingerprints WHERE project_id = ? ORDER BY created_at, id LIMIT 10001",
            &project_id,
            |row| {
                Ok(SnapshotFingerprint {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    problem_node_id: row.get(2)?,
                    algorithm: row.get(3)?,
                    value: row.get(4)?,
                    created_at: row.get(5)?,
                })
            },
        )?;
        let guardrails = collect(
            &self.connection,
            "SELECT id, project_id, node_id, enforcement, criteria, created_at FROM guardrails WHERE project_id = ? ORDER BY created_at, id LIMIT 10001",
            &project_id,
            |row| {
                Ok(SnapshotGuardrail {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    node_id: row.get(2)?,
                    enforcement: row.get(3)?,
                    criteria: serde_json::from_str(&row.get::<_, String>(4)?).map_err(json_sql)?,
                    created_at: row.get(5)?,
                })
            },
        )?;
        let artifacts = collect(
            &self.connection,
            "SELECT id, project_id, node_id, kind, uri, digest, is_external, metadata, created_at FROM artifacts WHERE project_id = ? AND kind <> 'command-log' ORDER BY created_at, id LIMIT 10001",
            &project_id,
            |row| {
                Ok(SnapshotArtifact {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    node_id: row.get(2)?,
                    kind: row.get(3)?,
                    uri: row.get(4)?,
                    digest: row.get(5)?,
                    is_external: row.get::<_, i64>(6)? == 1,
                    metadata: serde_json::from_str(&row.get::<_, String>(7)?).map_err(json_sql)?,
                    created_at: row.get(8)?,
                })
            },
        )?;
        ensure_collection_bounds([
            cases.len(),
            nodes.len(),
            edges.len(),
            evidence.len(),
            fingerprints.len(),
            guardrails.len(),
            artifacts.len(),
        ])?;
        let mut archive = ProjectGraphSnapshot {
            format: FORMAT.into(),
            version: VERSION,
            exported_at: timestamp(),
            project,
            cases,
            nodes,
            edges,
            evidence,
            fingerprints,
            guardrails,
            artifacts,
        };
        redact_snapshot(&mut archive, &roots);
        ensure_archive_bytes(&archive)?;
        Ok(archive)
    }

    pub fn import_project_graph(
        &mut self,
        input: ImportProjectGraphInput,
    ) -> Result<ImportProjectGraphResult, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        if input.operation_id.trim().is_empty() {
            return Err(WriteError::Validation("operation id"));
        }
        ensure_archive_bytes(&input.archive)?;
        validate_archive(&input.archive)?;
        let transaction = self.connection.savepoint()?;
        let target = resolve_project(&transaction, &input.project)?;
        if let Some(result) = replay(&transaction, &target, &input.operation_id)? {
            transaction.commit()?;
            return Ok(result);
        }
        let target_root: String = transaction.query_row(
            "SELECT canonical_root FROM projects WHERE id = ?",
            [&target],
            |row| row.get(0),
        )?;
        let mut archive = input.archive;
        normalize_local_artifacts(&mut archive, &target_root)?;
        let mut id_map = BTreeMap::from([(archive.project.id.clone(), target.clone())]);
        for (kind, ids) in [
            (
                "case",
                archive.cases.iter().map(|v| &v.id).collect::<Vec<_>>(),
            ),
            ("node", archive.nodes.iter().map(|v| &v.id).collect()),
            ("edge", archive.edges.iter().map(|v| &v.id).collect()),
            ("evidence", archive.evidence.iter().map(|v| &v.id).collect()),
            (
                "fingerprint",
                archive.fingerprints.iter().map(|v| &v.id).collect(),
            ),
            (
                "guardrail",
                archive.guardrails.iter().map(|v| &v.id).collect(),
            ),
            (
                "artifact",
                archive.artifacts.iter().map(|v| &v.id).collect(),
            ),
        ] {
            for source in ids {
                id_map.insert(source.clone(), deterministic_id(&target, kind, source));
            }
        }
        let mut created = SnapshotCreatedCounts::default();
        for record in &archive.cases {
            let id = mapped(&id_map, &record.id)?;
            if !exists(&transaction, "cases", id)? {
                let status = if record.status == NodeStatus::Verified {
                    NodeStatus::Candidate
                } else {
                    record.status
                };
                transaction.execute("INSERT INTO cases (id, project_id, title, status, created_at) VALUES (?, ?, ?, ?, ?)", params![id, target, record.title, status_text(status), record.created_at])?;
                created.cases += 1;
            }
        }
        for record in &archive.nodes {
            let id = mapped(&id_map, &record.id)?;
            if !exists(&transaction, "nodes", id)? {
                let downgrade = record.status == NodeStatus::Verified
                    && matches!(
                        record.node_type,
                        NodeType::RootCause
                            | NodeType::Solution
                            | NodeType::SuccessCase
                            | NodeType::Guardrail
                    );
                let status = if downgrade {
                    NodeStatus::Candidate
                } else {
                    record.status
                };
                let data = redact_value(Value::Object(record.data.clone().into_iter().collect()));
                transaction.execute("INSERT INTO nodes (id, case_id, type, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)", params![id, mapped(&id_map, &record.case_id)?, type_text(record.node_type), status_text(status), serde_json::to_string(&data)?, record.created_at])?;
                let title = archive
                    .cases
                    .iter()
                    .find(|case| case.id == record.case_id)
                    .ok_or(WriteError::Validation("snapshot case"))?
                    .title
                    .clone();
                transaction.execute("INSERT INTO node_search (project_id, node_id, title, body) VALUES (?, ?, ?, ?)", params![target, id, title, serde_json::to_string(&data)?])?;
                created.nodes += 1;
            }
        }
        for record in &archive.edges {
            let id = mapped(&id_map, &record.id)?;
            if !exists(&transaction, "edges", id)? {
                transaction.execute("INSERT INTO edges (id, case_id, source_id, relation, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", params![id, mapped(&id_map, &record.case_id)?, mapped(&id_map, &record.source_id)?, relation_text(record.relation), mapped(&id_map, &record.target_id)?, record.created_at])?;
                created.edges += 1;
            }
        }
        import_auxiliary(&transaction, &target, &archive, &id_map, &mut created)?;
        let result = ImportProjectGraphResult {
            source_project_id: archive.project.id,
            target_project_id: target.clone(),
            id_map,
            created,
        };
        if result.created != SnapshotCreatedCounts::default() {
            transaction.execute("INSERT INTO events (project_id, type, aggregate_id, payload, occurred_at) VALUES (?, 'snapshot.imported', ?, ?, ?)", params![target, target, serde_json::to_string(&serde_json::json!({"sourceProjectId": result.source_project_id, "created": result.created}))?, timestamp()])?;
        }
        transaction.execute("INSERT INTO operation_results (id, project_id, operation_id, kind, result, created_at) VALUES (?, ?, ?, 'import_project_graph', ?, ?)", params![Uuid::new_v4().to_string(), target, input.operation_id, serde_json::to_string(&result)?, timestamp()])?;
        transaction.commit()?;
        Ok(result)
    }
}

fn import_auxiliary(
    connection: &Connection,
    target: &str,
    archive: &ProjectGraphSnapshot,
    ids: &BTreeMap<String, String>,
    created: &mut SnapshotCreatedCounts,
) -> Result<(), WriteError> {
    for r in &archive.evidence {
        let id = mapped(ids, &r.id)?;
        if !exists(connection, "evidence", id)? {
            connection.execute("INSERT INTO evidence (id,project_id,node_id,kind,command,exit_status,data,created_at) VALUES (?,?,?,?,?,?,?,?)",params![id,target,mapped(ids,&r.node_id)?,evidence_text(r.kind),r.command.as_ref().map(serde_json::to_string).transpose()?,r.exit_status,serde_json::to_string(&redact_value(Value::Object(r.data.clone().into_iter().collect())))?,r.created_at])?;
            created.evidence += 1;
        }
    }
    for r in &archive.fingerprints {
        let id = mapped(ids, &r.id)?;
        if !exists(connection, "fingerprints", id)? {
            connection.execute("INSERT INTO fingerprints (id,project_id,problem_node_id,algorithm,value,created_at) VALUES (?,?,?,?,?,?)",params![id,target,mapped(ids,&r.problem_node_id)?,r.algorithm,r.value,r.created_at])?;
            created.fingerprints += 1;
        }
    }
    for r in &archive.guardrails {
        let id = mapped(ids, &r.id)?;
        if !exists(connection, "guardrails", id)? {
            connection.execute("INSERT INTO guardrails (id,project_id,node_id,enforcement,criteria,created_at) VALUES (?,?,?,?,?,?)",params![id,target,mapped(ids,&r.node_id)?,r.enforcement,serde_json::to_string(&r.criteria)?,r.created_at])?;
            created.guardrails += 1;
        }
    }
    for r in &archive.artifacts {
        let id = mapped(ids, &r.id)?;
        if !exists(connection, "artifacts", id)? {
            connection.execute("INSERT INTO artifacts (id,project_id,node_id,kind,uri,digest,is_external,metadata,created_at) VALUES (?,?,?,?,?,?,?,?,?)",params![id,target,r.node_id.as_ref().map(|v|mapped(ids,v)).transpose()?,r.kind,r.uri,r.digest,if r.is_external { 1 } else { 0 },serde_json::to_string(&redact_value(Value::Object(r.metadata.clone().into_iter().collect())))?,r.created_at])?;
            created.artifacts += 1;
        }
    }
    Ok(())
}

fn validate_archive(a: &ProjectGraphSnapshot) -> Result<(), WriteError> {
    if a.format != FORMAT || a.version != VERSION {
        return Err(WriteError::Validation("snapshot format"));
    }
    ensure_collection_bounds([
        a.cases.len(),
        a.nodes.len(),
        a.edges.len(),
        a.evidence.len(),
        a.fingerprints.len(),
        a.guardrails.len(),
        a.artifacts.len(),
    ])?;
    let cases: BTreeSet<_> = a.cases.iter().map(|v| v.id.as_str()).collect();
    let nodes: BTreeMap<_, _> = a.nodes.iter().map(|v| (v.id.as_str(), v)).collect();
    if a.cases.iter().any(|v| v.project_id != a.project.id) {
        return Err(WriteError::OwnershipMismatch);
    }
    if a.nodes.iter().any(|v| !cases.contains(v.case_id.as_str())) {
        return Err(WriteError::Validation("snapshot node case"));
    }
    if a.edges.iter().any(|v| {
        !cases.contains(v.case_id.as_str())
            || nodes
                .get(v.source_id.as_str())
                .is_none_or(|n| n.case_id != v.case_id)
            || nodes
                .get(v.target_id.as_str())
                .is_none_or(|n| n.case_id != v.case_id)
    }) {
        return Err(WriteError::OwnershipMismatch);
    }
    let mut edge_keys = BTreeSet::new();
    let mut case_edges: BTreeMap<&str, Vec<(&str, &str)>> = BTreeMap::new();
    for edge in &a.edges {
        let source = nodes
            .get(edge.source_id.as_str())
            .ok_or(WriteError::Validation("snapshot edge source"))?;
        let target = nodes
            .get(edge.target_id.as_str())
            .ok_or(WriteError::Validation("snapshot edge target"))?;
        if !allowed_relation(source.node_type, edge.relation, target.node_type) {
            return Err(WriteError::Validation("snapshot relation"));
        }
        if !edge_keys.insert((
            edge.case_id.as_str(),
            edge.source_id.as_str(),
            edge.relation,
            edge.target_id.as_str(),
        )) {
            return Err(WriteError::Validation("snapshot duplicate relation"));
        }
        case_edges
            .entry(&edge.case_id)
            .or_default()
            .push((&edge.source_id, &edge.target_id));
    }
    if case_edges.values().any(|edges| !is_acyclic(edges)) {
        return Err(WriteError::Validation("snapshot cycle"));
    }
    if a.evidence
        .iter()
        .any(|v| v.project_id != a.project.id || !nodes.contains_key(v.node_id.as_str()))
        || a.fingerprints.iter().any(|v| {
            v.project_id != a.project.id
                || nodes
                    .get(v.problem_node_id.as_str())
                    .is_none_or(|n| n.node_type != NodeType::Problem)
        })
        || a.guardrails.iter().any(|v| {
            v.project_id != a.project.id
                || nodes
                    .get(v.node_id.as_str())
                    .is_none_or(|n| n.node_type != NodeType::Guardrail)
        })
        || a.artifacts.iter().any(|v| {
            v.project_id != a.project.id
                || v.node_id.as_ref().is_some_and(|id| {
                    nodes
                        .get(id.as_str())
                        .is_none_or(|n| n.node_type != NodeType::Artifact)
                })
        })
    {
        return Err(WriteError::OwnershipMismatch);
    }
    let ids = std::iter::once(&a.project.id)
        .chain(a.cases.iter().map(|v| &v.id))
        .chain(a.nodes.iter().map(|v| &v.id))
        .chain(a.edges.iter().map(|v| &v.id))
        .chain(a.evidence.iter().map(|v| &v.id))
        .chain(a.fingerprints.iter().map(|v| &v.id))
        .chain(a.guardrails.iter().map(|v| &v.id))
        .chain(a.artifacts.iter().map(|v| &v.id));
    let mut seen = BTreeSet::new();
    for id in ids {
        if Uuid::parse_str(id).is_err() || !seen.insert(id) {
            return Err(WriteError::Validation("snapshot id"));
        }
    }
    Ok(())
}

fn allowed_relation(source: NodeType, relation: RelationType, target: NodeType) -> bool {
    matches!(
        (source, relation, target),
        (
            NodeType::Attempt,
            RelationType::AttemptsToSolve,
            NodeType::Problem
        ) | (
            NodeType::Attempt,
            RelationType::PrecededBy,
            NodeType::Attempt
        ) | (
            NodeType::Attempt,
            RelationType::FailedBecause,
            NodeType::RootCause
        ) | (NodeType::RootCause, RelationType::Causes, NodeType::Problem)
            | (
                NodeType::Solution,
                RelationType::Addresses,
                NodeType::RootCause
            )
            | (
                NodeType::Solution,
                RelationType::VerifiedBy,
                NodeType::Verification
            )
            | (
                NodeType::Verification,
                RelationType::References,
                NodeType::Artifact
            )
            | (
                NodeType::Problem,
                RelationType::References,
                NodeType::Artifact
            )
            | (
                NodeType::SuccessCase,
                RelationType::Includes,
                NodeType::Problem
            )
            | (
                NodeType::SuccessCase,
                RelationType::Includes,
                NodeType::Attempt
            )
            | (
                NodeType::SuccessCase,
                RelationType::Includes,
                NodeType::RootCause
            )
            | (
                NodeType::SuccessCase,
                RelationType::Includes,
                NodeType::Solution
            )
            | (
                NodeType::SuccessCase,
                RelationType::Includes,
                NodeType::Verification
            )
            | (
                NodeType::Guardrail,
                RelationType::Prevents,
                NodeType::RootCause
            )
            | (
                NodeType::Solution,
                RelationType::Supersedes,
                NodeType::Solution
            )
    )
}

fn is_acyclic(edges: &[(&str, &str)]) -> bool {
    let mut adjacency: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut indegree: BTreeMap<&str, usize> = BTreeMap::new();
    for (source, target) in edges {
        adjacency.entry(source).or_default().push(target);
        adjacency.entry(target).or_default();
        indegree.entry(source).or_default();
        *indegree.entry(target).or_default() += 1;
    }
    let mut ready: Vec<_> = indegree
        .iter()
        .filter_map(|(node, degree)| (*degree == 0).then_some(*node))
        .collect();
    let mut visited = 0;
    while let Some(node) = ready.pop() {
        visited += 1;
        for target in adjacency.get(node).into_iter().flatten() {
            let degree = indegree.get_mut(target).expect("target has indegree");
            *degree -= 1;
            if *degree == 0 {
                ready.push(target);
            }
        }
    }
    visited == indegree.len()
}

fn collect<T, F>(c: &Connection, sql: &str, project: &str, mut f: F) -> Result<Vec<T>, WriteError>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    Ok(c.prepare(sql)?
        .query_map([project], |r| f(r))?
        .collect::<Result<Vec<_>, _>>()?)
}
fn parse<T: DeserializeOwned>(value: String) -> rusqlite::Result<T> {
    serde_json::from_value(Value::String(value)).map_err(json_sql)
}
fn json_sql(e: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
}
fn ensure_collection_bounds<const N: usize>(sizes: [usize; N]) -> Result<(), WriteError> {
    if sizes.into_iter().any(|v| v > MAX_COLLECTION) {
        Err(WriteError::Validation("snapshot collection"))
    } else {
        Ok(())
    }
}
fn ensure_archive_bytes(a: &ProjectGraphSnapshot) -> Result<(), WriteError> {
    if serde_json::to_vec(a)?.len() > MAX_ARCHIVE_BYTES {
        Err(WriteError::Validation("snapshot bytes"))
    } else {
        Ok(())
    }
}
fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn deterministic_id(project: &str, kind: &str, source: &str) -> String {
    let mut h = Sha256::new();
    h.update(format!("{project}:{kind}:{source}"));
    let mut x = hex::encode(h.finalize())[..32].to_string().into_bytes();
    x[12] = b'5';
    let n = (x[16] as char).to_digit(16).unwrap();
    x[16] = char::from_digit((n & 3) | 8, 16).unwrap() as u8;
    let s = String::from_utf8(x).unwrap();
    format!(
        "{}-{}-{}-{}-{}",
        &s[..8],
        &s[8..12],
        &s[12..16],
        &s[16..20],
        &s[20..]
    )
}
fn mapped<'a>(ids: &'a BTreeMap<String, String>, id: &str) -> Result<&'a str, WriteError> {
    ids.get(id)
        .map(String::as_str)
        .ok_or(WriteError::Validation("snapshot id map"))
}
fn exists(c: &Connection, table: &str, id: &str) -> Result<bool, WriteError> {
    Ok(c.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = ?)"),
        [id],
        |r| r.get::<_, i64>(0),
    )? != 0)
}
fn replay(
    c: &Connection,
    project: &str,
    op: &str,
) -> Result<Option<ImportProjectGraphResult>, WriteError> {
    let row = c
        .query_row(
            "SELECT kind,result FROM operation_results WHERE project_id=? AND operation_id=?",
            params![project, op],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    match row {
        None => Ok(None),
        Some((kind, _)) if kind != "import_project_graph" => Err(WriteError::OperationConflict),
        Some((_, v)) => Ok(Some(serde_json::from_str(&v)?)),
    }
}
fn resolve_project(c: &Connection, r: &ProjectReference) -> Result<String, WriteError> {
    let by_id = r
        .project_id
        .as_ref()
        .map(|id| {
            c.query_row("SELECT id FROM projects WHERE id=?", [id], |x| x.get(0))
                .optional()
        })
        .transpose()?
        .flatten();
    let by_root = r.project_root.as_ref().map(|root| {
        let root = std::fs::canonicalize(root)
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|_| root.to_owned());
        c.query_row("SELECT projects.id FROM projects LEFT JOIN project_aliases ON project_aliases.project_id=projects.id WHERE canonical_root=? OR project_aliases.root=?",params![root,root],|x|x.get(0)).optional().map_err(WriteError::from)
    }).transpose()?.flatten();
    match (by_id, by_root) {
        (Some(a), Some(b)) if a != b => Err(WriteError::OwnershipMismatch),
        (Some(v), _) | (_, Some(v)) => Ok(v),
        _ => Err(WriteError::ProjectNotFound),
    }
}
fn redact_snapshot(a: &mut ProjectGraphSnapshot, roots: &[String]) {
    a.project.name = redact_path_string(&redact_string(&a.project.name), roots);
    a.project.description = a
        .project
        .description
        .as_deref()
        .map(|value| redact_path_string(&redact_string(value), roots));
    for c in &mut a.cases {
        c.title = redact_path_string(&redact_string(&c.title), roots)
    }
    for n in &mut a.nodes {
        n.data = as_map(redact_paths(
            redact_value(Value::Object(n.data.clone().into_iter().collect())),
            roots,
        ))
    }
    for e in &mut a.evidence {
        e.command = e.command.take().map(|v| {
            v.into_iter()
                .map(|x| redact_path_string(&redact_string(&x), roots))
                .collect()
        });
        e.data = as_map(redact_paths(
            redact_value(Value::Object(e.data.clone().into_iter().collect())),
            roots,
        ))
    }
    for a in &mut a.artifacts {
        a.uri = redact_path_string(&redact_string(&a.uri), roots);
        a.metadata = as_map(redact_paths(
            redact_value(Value::Object(a.metadata.clone().into_iter().collect())),
            roots,
        ))
    }
}

fn redact_paths(value: Value, roots: &[String]) -> Value {
    match value {
        Value::String(value) => Value::String(redact_path_string(&value, roots)),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| redact_paths(value, roots))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, redact_paths(value, roots)))
                .collect(),
        ),
        value => value,
    }
}

fn redact_path_string(value: &str, roots: &[String]) -> String {
    let mut output = value.to_owned();
    let mut roots = roots.to_vec();
    roots.sort_by_key(|root| std::cmp::Reverse(root.len()));
    for root in roots {
        output = output.replace(&root, "[PROJECT_ROOT]");
    }
    output
}

fn normalize_local_artifacts(
    archive: &mut ProjectGraphSnapshot,
    target_root: &str,
) -> Result<(), WriteError> {
    let mut local_nodes = BTreeSet::new();
    for artifact in &mut archive.artifacts {
        if artifact.is_external {
            continue;
        }
        artifact.uri = normalize_local_uri(&artifact.uri, target_root)?;
        if let Some(node_id) = &artifact.node_id {
            local_nodes.insert(node_id.clone());
        }
    }
    for node in &mut archive.nodes {
        if node.node_type != NodeType::Artifact || !local_nodes.contains(&node.id) {
            continue;
        }
        let uri = node
            .data
            .get("uri")
            .and_then(Value::as_str)
            .ok_or(WriteError::Validation("artifact uri"))?;
        node.data.insert(
            "uri".into(),
            Value::String(normalize_local_uri(uri, target_root)?),
        );
    }
    Ok(())
}

fn normalize_local_uri(uri: &str, target_root: &str) -> Result<String, WriteError> {
    let candidate = if uri == "[PROJECT_ROOT]" {
        std::path::PathBuf::from(target_root)
    } else if let Some(suffix) = uri.strip_prefix("[PROJECT_ROOT]/") {
        std::path::Path::new(target_root).join(suffix)
    } else {
        std::path::PathBuf::from(uri)
    };
    if !candidate.is_absolute() {
        return Err(WriteError::Validation("local snapshot artifact path"));
    }
    let normalized = normalize_lexical(&candidate);
    let root = normalize_lexical(std::path::Path::new(target_root));
    if !normalized.starts_with(&root) {
        return Err(WriteError::Validation("local snapshot artifact path"));
    }
    Ok(normalized.to_string_lossy().into_owned())
}

fn normalize_lexical(path: &std::path::Path) -> std::path::PathBuf {
    let mut output = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                output.pop();
            }
            std::path::Component::CurDir => {}
            component => output.push(component.as_os_str()),
        }
    }
    output
}
fn as_map(v: Value) -> BTreeMap<String, Value> {
    match v {
        Value::Object(m) => m.into_iter().collect(),
        _ => BTreeMap::new(),
    }
}
fn redact_value(v: Value) -> Value {
    match v {
        Value::String(s) => Value::String(redact_string(&s)),
        Value::Array(v) => Value::Array(v.into_iter().map(redact_value).collect()),
        Value::Object(m) => Value::Object(
            m.into_iter()
                .map(|(k, v)| {
                    let secret = [
                        "token", "password", "passwd", "secret", "api_key", "api-key",
                    ]
                    .contains(&k.to_ascii_lowercase().as_str());
                    (
                        k,
                        if secret {
                            Value::String("[REDACTED]".into())
                        } else {
                            redact_value(v)
                        },
                    )
                })
                .collect(),
        ),
        v => v,
    }
}
fn redact_string(v: &str) -> String {
    v.split_whitespace()
        .scan(false, |next, p| {
            if *next {
                *next = false;
                return Some("[REDACTED]".into());
            }
            let lower = p.to_ascii_lowercase();
            if ["token:", "password:", "authorization:", "secret:"].contains(&lower.as_str()) {
                *next = true;
                Some(p.into())
            } else if ["token=", "password=", "authorization=", "secret="]
                .iter()
                .any(|m| lower.starts_with(m))
            {
                Some(format!(
                    "{}[REDACTED]",
                    p.split_once(['=', ':'])
                        .map(|(k, _)| format!("{k}="))
                        .unwrap_or_default()
                ))
            } else {
                Some(p.into())
            }
        })
        .collect::<Vec<String>>()
        .join(" ")
}
fn status_text(v: NodeStatus) -> &'static str {
    match v {
        NodeStatus::Open => "open",
        NodeStatus::Candidate => "candidate",
        NodeStatus::Verified => "verified",
        NodeStatus::Regressed => "regressed",
        NodeStatus::Retired => "retired",
    }
}
fn type_text(v: NodeType) -> &'static str {
    match v {
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
fn relation_text(v: RelationType) -> &'static str {
    match v {
        RelationType::AttemptsToSolve => "ATTEMPTS_TO_SOLVE",
        RelationType::PrecededBy => "PRECEDED_BY",
        RelationType::FailedBecause => "FAILED_BECAUSE",
        RelationType::Causes => "CAUSES",
        RelationType::Addresses => "ADDRESSES",
        RelationType::VerifiedBy => "VERIFIED_BY",
        RelationType::References => "REFERENCES",
        RelationType::Includes => "INCLUDES",
        RelationType::Prevents => "PREVENTS",
        RelationType::Supersedes => "SUPERSEDES",
    }
}
fn evidence_text(v: EvidenceKind) -> &'static str {
    match v {
        EvidenceKind::Automated => "automated",
        EvidenceKind::Human => "human",
    }
}
