//! Project-scoped, query-only repository for the existing EKG SQLite schema.

mod import;
mod schema;
mod snapshot;
mod write;

pub use schema::*;
pub use write::*;

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::time::Instant;

use ekg_contracts::{
    ArtifactRecord, CaseCounts, CaseDetailLevel, CommandRunRecord, EdgeRecord, ErrorCode,
    EvidenceKind, EvidenceRecord, GetCaseInput, GetCaseResult, KnowledgeEvent, KnowledgeQueryItem,
    NodeRecord, NodeStatus, NodeType, PreflightGuardrail, PreflightInput, PreflightResult,
    ProjectAliasRecord, ProjectRecord, ProjectReference, ProjectWithAliasesRecord,
    QueryKnowledgeInput, QueryKnowledgeResult, RecentActivityInput, RecentActivityResult,
    RelationType, Validate,
};
use ekg_core::{
    ExpansionConfig, ExpansionEdge, ExpansionNode, ExpansionResult, GuardrailContext,
    GuardrailCriteria, GuardrailEnforcement, HierarchyEdge, HierarchyRecord, KnowledgeHierarchy,
    RelevanceCandidate, RelevanceContext, compact_preflight, evaluate_guardrail, expand_bounded,
    rank_cases,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde_json::Value;

#[derive(Debug)]
pub enum StorageError {
    Contract(ErrorCode),
    Sqlite(rusqlite::Error),
    InvalidStoredData(&'static str),
    ProjectNotFound,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreflightMetrics {
    pub cache_hit: bool,
    pub candidate_count: usize,
    pub card_count: usize,
    pub execution_micros: u128,
}

#[derive(Debug, Clone)]
pub struct PreflightExecution {
    pub result: PreflightResult,
    pub metrics: PreflightMetrics,
}

#[derive(Clone)]
struct CachedPreflight {
    result: PreflightResult,
    candidate_count: usize,
}

impl From<rusqlite::Error> for StorageError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}

pub struct ReadRepository {
    connection: Connection,
    preflight_cache: RefCell<BTreeMap<String, CachedPreflight>>,
    preflight_order: RefCell<VecDeque<String>>,
}

impl ReadRepository {
    pub fn open(database_path: &str) -> Result<Self, StorageError> {
        let connection = Connection::open(database_path)?;
        connection.pragma_update(None, "query_only", true)?;
        Ok(Self {
            connection,
            preflight_cache: RefCell::new(BTreeMap::new()),
            preflight_order: RefCell::new(VecDeque::new()),
        })
    }

    pub fn query_knowledge(
        &self,
        input: &QueryKnowledgeInput,
    ) -> Result<QueryKnowledgeResult, StorageError> {
        input.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(&input.project)?;
        let limit = input.limit.unwrap_or(20);
        let mut conditions = vec!["cases.project_id = ?".to_owned()];
        let mut parameters = vec![SqlValue::Text(project_id.clone())];
        let mut search_join = "";

        if let Some(text) = input
            .text
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            search_join = "JOIN node_search ON node_search.node_id = nodes.id";
            if let Some(query) = build_fts_query(text) {
                conditions.push("node_search MATCH ?".to_owned());
                parameters.push(SqlValue::Text(query));
            } else {
                conditions.push("(node_search.title LIKE ? OR node_search.body LIKE ?)".to_owned());
                let term = format!("%{text}%");
                parameters.push(SqlValue::Text(term.clone()));
                parameters.push(SqlValue::Text(term));
            }
        }
        if let Some(types) = input.node_types.as_deref().filter(|v| !v.is_empty()) {
            conditions.push(format!("nodes.type IN ({})", placeholders(types.len())));
            parameters.extend(
                types
                    .iter()
                    .map(|value| SqlValue::Text(node_type_text(*value).to_owned())),
            );
        }
        if let Some(statuses) = input.statuses.as_deref().filter(|v| !v.is_empty()) {
            conditions.push(format!(
                "nodes.status IN ({})",
                placeholders(statuses.len())
            ));
            parameters.extend(
                statuses
                    .iter()
                    .map(|value| SqlValue::Text(status_text(*value).to_owned())),
            );
        }
        if let Some(domain) = trimmed(&input.domain) {
            conditions.push("EXISTS (SELECT 1 FROM nodes domain_node WHERE domain_node.case_id = cases.id AND domain_node.type = 'Problem' AND json_extract(domain_node.data, '$.domain') = ?)".to_owned());
            parameters.push(SqlValue::Text(domain.to_owned()));
        }
        if let Some(file) = trimmed(&input.file) {
            conditions.push("EXISTS (SELECT 1 FROM nodes file_node WHERE file_node.case_id = cases.id AND file_node.data LIKE ?)".to_owned());
            parameters.push(SqlValue::Text(format!("%{file}%")));
        }
        if let Some(command) = trimmed(&input.command) {
            conditions.push("(EXISTS (SELECT 1 FROM nodes command_node WHERE command_node.case_id = cases.id AND command_node.data LIKE ?) OR EXISTS (SELECT 1 FROM command_runs WHERE command_runs.case_id = cases.id AND command_runs.project_id = cases.project_id AND command_runs.command LIKE ?))".to_owned());
            let pattern = format!("%{command}%");
            parameters.push(SqlValue::Text(pattern.clone()));
            parameters.push(SqlValue::Text(pattern));
        }
        if let Some(fingerprint) = trimmed(&input.fingerprint) {
            conditions.push("EXISTS (SELECT 1 FROM fingerprints JOIN nodes problem_node ON problem_node.id = fingerprints.problem_node_id WHERE fingerprints.project_id = cases.project_id AND problem_node.case_id = cases.id AND fingerprints.value = ?)".to_owned());
            parameters.push(SqlValue::Text(fingerprint.to_owned()));
        }
        parameters.push(SqlValue::Integer((limit + 1) as i64));
        let sql = format!(
            "SELECT nodes.id, nodes.case_id, nodes.type, nodes.status, nodes.data, nodes.created_at, cases.project_id, cases.title FROM nodes JOIN cases ON cases.id = nodes.case_id {search_join} WHERE {} ORDER BY nodes.created_at DESC, nodes.id DESC LIMIT ?",
            conditions.join(" AND ")
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(parameters), |row| {
            let data_text: String = row.get(4)?;
            let data =
                serde_json::from_str::<BTreeMap<String, Value>>(&data_text).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        4,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
            let node_type_text: String = row.get(2)?;
            let status_text: String = row.get(3)?;
            let node_type = parse_node_type(&node_type_text).ok_or_else(|| {
                rusqlite::Error::InvalidColumnType(2, "type".into(), rusqlite::types::Type::Text)
            })?;
            let status = parse_status(&status_text).ok_or_else(|| {
                rusqlite::Error::InvalidColumnType(3, "status".into(), rusqlite::types::Type::Text)
            })?;
            Ok(KnowledgeQueryItem {
                project_id: row.get(6)?,
                case_id: row.get(1)?,
                case_title: row.get(7)?,
                node: NodeRecord {
                    id: row.get(0)?,
                    case_id: row.get(1)?,
                    node_type,
                    status,
                    data,
                    created_at: row.get(5)?,
                },
            })
        })?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let truncated = items.len() > limit;
        items.truncate(limit);
        Ok(QueryKnowledgeResult {
            items,
            limit,
            truncated,
        })
    }

    pub fn list_projects(&self) -> Result<Vec<ProjectWithAliasesRecord>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT id, name, description, canonical_root, created_at FROM projects ORDER BY created_at, id",
        )?;
        let projects = statement
            .query_map([], |row| {
                Ok(ProjectRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    root: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        projects
            .into_iter()
            .map(|project| {
                let mut aliases = self.connection.prepare(
                    "SELECT id, project_id, root, created_at FROM project_aliases WHERE project_id = ? ORDER BY created_at, id",
                )?;
                let aliases = aliases
                    .query_map(params![project.id], |row| {
                        Ok(ProjectAliasRecord {
                            id: row.get(0)?,
                            project_id: row.get(1)?,
                            root: row.get(2)?,
                            created_at: row.get(3)?,
                        })
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(ProjectWithAliasesRecord { project, aliases })
            })
            .collect()
    }

    pub fn resolve_project_record(
        &self,
        reference: &ProjectReference,
    ) -> Result<ProjectRecord, StorageError> {
        reference.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(reference)?;
        self.connection
            .query_row(
                "SELECT id, name, description, canonical_root, created_at FROM projects WHERE id = ?",
                params![project_id],
                |row| {
                    Ok(ProjectRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        description: row.get(2)?,
                        root: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                },
            )
            .map_err(StorageError::from)
    }

    pub fn list_recent_activity(
        &self,
        input: &RecentActivityInput,
    ) -> Result<RecentActivityResult, StorageError> {
        input.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(&input.project)?;
        let after_sequence = input.after_sequence.unwrap_or(0);
        let limit = input.limit.unwrap_or(25);
        let mut statement = self.connection.prepare(
            "SELECT sequence, project_id, type, aggregate_id, payload, occurred_at FROM (SELECT sequence, project_id, type, aggregate_id, payload, occurred_at FROM events WHERE project_id = ? AND sequence > ? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence ASC",
        )?;
        let mut events = statement
            .query_map(params![project_id, after_sequence, limit + 1], |row| {
                let payload: String = row.get(4)?;
                Ok(KnowledgeEvent {
                    sequence: row.get(0)?,
                    project_id: row.get(1)?,
                    event_type: row.get(2)?,
                    aggregate_id: row.get(3)?,
                    payload: serde_json::from_str(&payload).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            4,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?,
                    occurred_at: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let truncated = events.len() > limit;
        if truncated {
            events.remove(0);
        }
        let next_sequence = events.last().map_or(after_sequence, |event| event.sequence);
        Ok(RecentActivityResult {
            events,
            limit,
            truncated,
            next_sequence,
        })
    }

    pub fn get_case(&self, input: &GetCaseInput) -> Result<GetCaseResult, StorageError> {
        input.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(&input.project)?;
        let (id, title, status, created_at): (String, String, String, String) = self
            .connection
            .query_row(
                "SELECT id, title, status, created_at FROM cases WHERE id = ? AND project_id = ?",
                params![input.case_id, project_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?
            .ok_or(StorageError::ProjectNotFound)?;
        let status = parse_status(&status).ok_or(StorageError::InvalidStoredData("case status"))?;
        let count = |sql: &str| -> Result<usize, StorageError> {
            Ok(self
                .connection
                .query_row(sql, params![project_id, input.case_id], |row| {
                    row.get::<_, usize>(0)
                })?)
        };
        let counts = CaseCounts {
            nodes: count(
                "SELECT count(*) FROM nodes JOIN cases ON cases.id = nodes.case_id WHERE cases.project_id = ? AND nodes.case_id = ?",
            )?,
            edges: count(
                "SELECT count(*) FROM edges JOIN cases ON cases.id = edges.case_id WHERE cases.project_id = ? AND edges.case_id = ?",
            )?,
            evidence: count(
                "SELECT count(*) FROM evidence JOIN nodes ON nodes.id = evidence.node_id WHERE evidence.project_id = ? AND nodes.case_id = ?",
            )?,
            artifacts: count(
                "SELECT count(*) FROM artifacts LEFT JOIN nodes ON nodes.id = artifacts.node_id WHERE artifacts.project_id = ? AND (nodes.case_id = ? OR artifacts.node_id IS NULL)",
            )?,
            command_runs: count(
                "SELECT count(*) FROM command_runs WHERE project_id = ? AND case_id = ?",
            )?,
            history: count("SELECT count(*) FROM events WHERE project_id = ? AND case_id = ?")?,
        };
        let detail = input.detail.unwrap_or(CaseDetailLevel::Graph);
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut evidence = Vec::new();
        let mut artifacts = Vec::new();
        let mut command_runs = Vec::new();
        if detail != CaseDetailLevel::Summary {
            let mut statement = self.connection.prepare("SELECT id, case_id, type, status, data, created_at FROM nodes WHERE case_id = ? ORDER BY created_at, id LIMIT 1000")?;
            nodes = statement
                .query_map(params![input.case_id], |row| {
                    let node_type: String = row.get(2)?;
                    let status: String = row.get(3)?;
                    let data: String = row.get(4)?;
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        node_type,
                        status,
                        data,
                        row.get::<_, String>(5)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|row| {
                    Ok(NodeRecord {
                        id: row.0,
                        case_id: row.1,
                        node_type: parse_node_type(&row.2)
                            .ok_or(StorageError::InvalidStoredData("node type"))?,
                        status: parse_status(&row.3)
                            .ok_or(StorageError::InvalidStoredData("node status"))?,
                        data: serde_json::from_str(&row.4)
                            .map_err(|_| StorageError::InvalidStoredData("node data"))?,
                        created_at: row.5,
                    })
                })
                .collect::<Result<Vec<_>, StorageError>>()?;
            let mut statement = self.connection.prepare("SELECT id, case_id, source_id, relation, target_id, created_at FROM edges WHERE case_id = ? ORDER BY created_at, id LIMIT 1000")?;
            edges = statement
                .query_map(params![input.case_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|row| {
                    Ok(EdgeRecord {
                        id: row.0,
                        case_id: row.1,
                        source_id: row.2,
                        relation: parse_relation(&row.3)
                            .ok_or(StorageError::InvalidStoredData("edge relation"))?,
                        target_id: row.4,
                        created_at: row.5,
                    })
                })
                .collect::<Result<Vec<_>, StorageError>>()?;
            let mut statement = self.connection.prepare("SELECT evidence.id, evidence.project_id, evidence.node_id, evidence.kind, evidence.command, evidence.exit_status, evidence.data, evidence.created_at FROM evidence JOIN nodes ON nodes.id = evidence.node_id WHERE evidence.project_id = ? AND nodes.case_id = ? ORDER BY evidence.created_at, evidence.id LIMIT 1000")?;
            evidence = statement
                .query_map(params![project_id, input.case_id], |row| {
                    let kind: String = row.get(3)?;
                    let command: Option<String> = row.get(4)?;
                    let data: String = row.get(6)?;
                    Ok(EvidenceRecord {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        node_id: row.get(2)?,
                        kind: if kind == "human" {
                            EvidenceKind::Human
                        } else {
                            EvidenceKind::Automated
                        },
                        command: command
                            .map(|value| serde_json::from_str(&value))
                            .transpose()
                            .map_err(|error| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    4,
                                    rusqlite::types::Type::Text,
                                    Box::new(error),
                                )
                            })?,
                        exit_status: row.get(5)?,
                        data: serde_json::from_str(&data).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                6,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                        created_at: row.get(7)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut statement = self.connection.prepare("SELECT artifacts.id, artifacts.project_id, artifacts.node_id, artifacts.kind, artifacts.uri, artifacts.digest, artifacts.is_external, artifacts.metadata, artifacts.created_at FROM artifacts LEFT JOIN nodes ON nodes.id = artifacts.node_id WHERE artifacts.project_id = ? AND (nodes.case_id = ? OR artifacts.node_id IS NULL) ORDER BY artifacts.created_at, artifacts.id LIMIT 1000")?;
            artifacts = statement
                .query_map(params![project_id, input.case_id], |row| {
                    let metadata: String = row.get(7)?;
                    Ok(ArtifactRecord {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        node_id: row.get(2)?,
                        kind: row.get(3)?,
                        uri: row.get(4)?,
                        digest: row.get(5)?,
                        is_external: row.get::<_, i64>(6)? == 1,
                        metadata: serde_json::from_str(&metadata).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                7,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                        created_at: row.get(8)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut statement = self.connection.prepare("SELECT id, project_id, case_id, attempt_node_id, command, working_directory, exit_status, signal, duration_ms, excerpt, raw_log_path, raw_log_digest, started_at, finished_at FROM command_runs WHERE project_id = ? AND case_id = ? ORDER BY started_at, id LIMIT 1000")?;
            command_runs = statement
                .query_map(params![project_id, input.case_id], |row| {
                    let command: String = row.get(4)?;
                    Ok(CommandRunRecord {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        case_id: row.get(2)?,
                        attempt_id: row.get(3)?,
                        command: serde_json::from_str(&command).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                4,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?,
                        working_directory: row.get(5)?,
                        exit_status: row.get(6)?,
                        signal: row.get(7)?,
                        duration_ms: row.get(8)?,
                        excerpt: row.get(9)?,
                        raw_log_path: row.get(10)?,
                        raw_log_digest: row.get(11)?,
                        started_at: row.get(12)?,
                        finished_at: row.get(13)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
        }
        let mut history = Vec::new();
        let mut history_next_before_sequence = None;
        if detail == CaseDetailLevel::Full {
            let history_limit = input.history_limit.unwrap_or(50);
            // SQLite INTEGER values are signed 64-bit. An absent or larger unsigned
            // cursor means "before every persisted event", so cap it to the largest
            // representable database sequence before binding.
            let before = input
                .history_before_sequence
                .unwrap_or(i64::MAX as u64)
                .min(i64::MAX as u64);
            let mut statement = self.connection.prepare("SELECT sequence, project_id, type, aggregate_id, payload, occurred_at FROM events WHERE project_id = ? AND case_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?")?;
            history = statement
                .query_map(
                    params![project_id, input.case_id, before, history_limit + 1],
                    |row| {
                        let payload: String = row.get(4)?;
                        Ok(KnowledgeEvent {
                            sequence: row.get(0)?,
                            project_id: row.get(1)?,
                            event_type: row.get(2)?,
                            aggregate_id: row.get(3)?,
                            payload: serde_json::from_str(&payload).map_err(|error| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    4,
                                    rusqlite::types::Type::Text,
                                    Box::new(error),
                                )
                            })?,
                            occurred_at: row.get(5)?,
                        })
                    },
                )?
                .collect::<Result<Vec<_>, _>>()?;
            if history.len() > history_limit {
                history.pop();
                history_next_before_sequence = history.last().map(|event| event.sequence);
            }
            history.reverse();
        }
        Ok(GetCaseResult {
            id,
            project_id,
            title,
            status,
            created_at,
            nodes,
            edges,
            detail,
            counts,
            evidence,
            artifacts,
            command_runs,
            history,
            history_next_before_sequence,
        })
    }

    pub fn import_preview_path_hints(
        &self,
        project: &ProjectReference,
        preview_id: &str,
    ) -> Result<Vec<String>, StorageError> {
        project.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(project)?;
        let manifest: String = self
            .connection
            .query_row(
                "SELECT source_manifest FROM import_previews WHERE id = ? AND project_id = ?",
                params![preview_id, project_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(StorageError::ProjectNotFound)?;
        let manifests: Vec<Value> = serde_json::from_str(&manifest)
            .map_err(|_| StorageError::InvalidStoredData("import source manifest"))?;
        manifests
            .into_iter()
            .map(|value| {
                value
                    .get("pathHint")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or(StorageError::InvalidStoredData("import source path hint"))
            })
            .collect()
    }

    pub fn load_hierarchy(
        &self,
        project: &ProjectReference,
    ) -> Result<KnowledgeHierarchy, StorageError> {
        project.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(project)?;
        let revision: i64 = self.connection.query_row(
            "SELECT coalesce(max(sequence), 0) FROM events WHERE project_id = ?",
            params![project_id],
            |row| row.get(0),
        )?;
        let mut builders = BTreeMap::<String, HierarchyBuilder>::new();
        let mut statement = self.connection.prepare(
            "SELECT cases.id, cases.title, cases.status, nodes.type, nodes.status, nodes.data FROM cases LEFT JOIN nodes ON nodes.case_id = cases.id WHERE cases.project_id = ? ORDER BY cases.id, nodes.created_at, nodes.id",
        )?;
        let rows = statement.query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?;
        for row in rows {
            let (case_id, title, case_status, node_type, node_status, data_text) = row?;
            let builder = builders
                .entry(case_id.clone())
                .or_insert_with(|| HierarchyBuilder {
                    case_id,
                    status: parse_status(&case_status).unwrap_or(NodeStatus::Candidate),
                    domain: "general".into(),
                    text_parts: vec![title],
                    ..HierarchyBuilder::default()
                });
            if let (Some(node_type), Some(node_status), Some(data_text)) =
                (node_type, node_status, data_text)
            {
                let data: Value = serde_json::from_str(&data_text)
                    .map_err(|_| StorageError::InvalidStoredData("node data"))?;
                builder.text_parts.push(data_text);
                if node_type == "Problem" {
                    if let Some(domain) = data.get("domain").and_then(Value::as_str) {
                        builder.domain = domain.to_owned();
                    }
                }
                collect_structural_values(&data, &mut builder.files, &mut builder.commands);
                if node_status == "verified"
                    && matches!(node_type.as_str(), "RootCause" | "Solution")
                {
                    builder.verified_conclusion = data
                        .get("summary")
                        .or_else(|| data.get("explanation"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .or(builder.verified_conclusion.take());
                }
            }
        }
        let mut statement = self.connection.prepare(
            "SELECT nodes.case_id, fingerprints.value FROM fingerprints JOIN nodes ON nodes.id = fingerprints.problem_node_id JOIN cases ON cases.id = nodes.case_id WHERE fingerprints.project_id = ? AND cases.project_id = ?",
        )?;
        for row in statement.query_map(params![project_id, project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (case_id, fingerprint) = row?;
            if let Some(builder) = builders.get_mut(&case_id) {
                builder.fingerprints.insert(fingerprint);
            }
        }
        let mut statement = self.connection.prepare(
            "SELECT case_id, command FROM command_runs WHERE project_id = ? AND case_id IS NOT NULL",
        )?;
        for row in statement.query_map(params![project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (case_id, command_text) = row?;
            if let Some(builder) = builders.get_mut(&case_id) {
                let command = serde_json::from_str::<Vec<String>>(&command_text)
                    .unwrap_or_default()
                    .join(" ");
                if !command.is_empty() {
                    builder.commands.insert(command);
                }
            }
        }
        let records = builders
            .into_values()
            .map(|builder| builder.record(&project_id))
            .collect::<Vec<_>>();
        let mut edges = Vec::new();
        for left in 0..records.len() {
            for right in (left + 1)..records.len() {
                if records[left].domain == records[right].domain
                    && share_structural_key(&records[left], &records[right])
                {
                    edges.push(HierarchyEdge::new(
                        &records[left].case_id,
                        &records[right].case_id,
                    ));
                }
            }
        }
        Ok(KnowledgeHierarchy::build(revision, records, edges))
    }

    pub fn expand_case_graph(
        &self,
        project: &ProjectReference,
        case_ids: &[String],
        exact_node_ids: &[String],
        semantic_scores: &[(String, u16)],
        config: ExpansionConfig,
    ) -> Result<ExpansionResult, StorageError> {
        project.validate().map_err(StorageError::Contract)?;
        if case_ids.is_empty() || case_ids.len() > 100 || exact_node_ids.is_empty() {
            return Err(StorageError::Contract(ErrorCode::InvalidArgument));
        }
        let project_id = self.resolve_project(project)?;
        let exact = exact_node_ids.iter().collect::<BTreeSet<_>>();
        let semantic = semantic_scores.iter().cloned().collect::<BTreeMap<_, _>>();
        let mut parameters = vec![SqlValue::Text(project_id.clone())];
        parameters.extend(case_ids.iter().cloned().map(SqlValue::Text));
        let node_sql = format!(
            "SELECT nodes.id, nodes.type, nodes.status FROM nodes JOIN cases ON cases.id = nodes.case_id WHERE cases.project_id = ? AND cases.id IN ({}) ORDER BY nodes.id",
            placeholders(case_ids.len())
        );
        let mut statement = self.connection.prepare(&node_sql)?;
        let nodes = statement
            .query_map(params_from_iter(parameters), |row| {
                let node_id = row.get::<_, String>(0)?;
                let node_type_text = row.get::<_, String>(1)?;
                let status_text = row.get::<_, String>(2)?;
                Ok((node_id, node_type_text, status_text))
            })?
            .map(|row| {
                let (node_id, node_type_text, status_text) = row?;
                Ok(ExpansionNode {
                    project_id: project_id.clone(),
                    exact_score: u32::from(exact.contains(&node_id)),
                    semantic_score: semantic.get(&node_id).copied(),
                    node_id,
                    node_type: parse_node_type(&node_type_text)
                        .ok_or(StorageError::InvalidStoredData("node type"))?,
                    status: parse_status(&status_text)
                        .ok_or(StorageError::InvalidStoredData("node status"))?,
                })
            })
            .collect::<Result<Vec<_>, StorageError>>()?;

        let mut parameters = vec![SqlValue::Text(project_id.clone())];
        parameters.extend(case_ids.iter().cloned().map(SqlValue::Text));
        let edge_sql = format!(
            "SELECT edges.source_id, edges.relation, edges.target_id FROM edges JOIN cases ON cases.id = edges.case_id WHERE cases.project_id = ? AND cases.id IN ({}) ORDER BY edges.source_id, edges.relation, edges.target_id",
            placeholders(case_ids.len())
        );
        let mut statement = self.connection.prepare(&edge_sql)?;
        let edges = statement
            .query_map(params_from_iter(parameters), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .map(|row| {
                let (source_id, relation, target_id) = row?;
                Ok(ExpansionEdge {
                    source_id,
                    relation: parse_relation(&relation)
                        .ok_or(StorageError::InvalidStoredData("edge relation"))?,
                    target_id,
                })
            })
            .collect::<Result<Vec<_>, StorageError>>()?;

        expand_bounded(&project_id, exact_node_ids, &nodes, &edges, config)
            .map_err(|_| StorageError::Contract(ErrorCode::InvalidArgument))
    }

    pub fn preflight(&self, input: &PreflightInput) -> Result<PreflightResult, StorageError> {
        Ok(self.preflight_with_metrics(input)?.result)
    }

    pub fn preflight_with_metrics(
        &self,
        input: &PreflightInput,
    ) -> Result<PreflightExecution, StorageError> {
        let started = Instant::now();
        input.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(&input.project)?;
        let revision: i64 = self.connection.query_row(
            "SELECT coalesce(max(sequence), 0) FROM events WHERE project_id = ?",
            params![project_id],
            |row| row.get(0),
        )?;
        let key = format!(
            "{project_id}:{revision}:{}",
            serde_json::to_string(input)
                .map_err(|_| StorageError::InvalidStoredData("preflight input"))?,
        );
        if let Some(cached) = self.preflight_cache.borrow().get(&key).cloned() {
            return Ok(PreflightExecution {
                metrics: PreflightMetrics {
                    cache_hit: true,
                    candidate_count: cached.candidate_count,
                    card_count: cached.result.cards.len(),
                    execution_micros: started.elapsed().as_micros(),
                },
                result: cached.result,
            });
        }
        let (result, candidate_count) = self.build_preflight(input, &project_id)?;
        self.remember_preflight(
            key,
            CachedPreflight {
                result: result.clone(),
                candidate_count,
            },
        );
        Ok(PreflightExecution {
            metrics: PreflightMetrics {
                cache_hit: false,
                candidate_count,
                card_count: result.cards.len(),
                execution_micros: started.elapsed().as_micros(),
            },
            result,
        })
    }

    fn build_preflight(
        &self,
        input: &PreflightInput,
        project_id: &str,
    ) -> Result<(PreflightResult, usize), StorageError> {
        let limit = input.limit.unwrap_or(5).min(5);
        let context_text = format!(
            "{} {} {} {}",
            input.task_description,
            input.changed_files.as_deref().unwrap_or_default().join(" "),
            input.command.as_deref().unwrap_or_default().join(" "),
            input.fingerprint.as_deref().unwrap_or_default(),
        );
        let candidate_case_ids = self.candidate_case_ids(project_id, &context_text)?;
        let fingerprint_case_ids = if let Some(fingerprint) = trimmed(&input.fingerprint) {
            let mut statement = self.connection.prepare(
                "SELECT DISTINCT nodes.case_id FROM fingerprints JOIN nodes ON nodes.id = fingerprints.problem_node_id JOIN cases ON cases.id = nodes.case_id WHERE fingerprints.project_id = ? AND cases.project_id = ? AND fingerprints.value = ?",
            )?;
            statement
                .query_map(params![project_id, project_id, fingerprint], |row| {
                    row.get(0)
                })?
                .collect::<Result<Vec<String>, _>>()?
        } else {
            Vec::new()
        };
        let mut nodes = self.nodes_for_cases(project_id, &candidate_case_ids)?;
        let mut guardrails = Vec::<PreflightGuardrail>::new();
        let mut statement = self.connection.prepare(
            "SELECT nodes.id, nodes.case_id, nodes.type, nodes.status, nodes.data, nodes.created_at, guardrails.enforcement, guardrails.criteria FROM guardrails JOIN nodes ON nodes.id = guardrails.node_id JOIN cases ON cases.id = nodes.case_id WHERE guardrails.project_id = ? AND cases.project_id = ? ORDER BY nodes.created_at DESC",
        )?;
        let rows = statement.query_map(params![project_id, project_id], |row| {
            let node = node_from_columns(row, 0)?;
            let enforcement: String = row.get(6)?;
            let criteria_text: String = row.get(7)?;
            Ok((node, enforcement, criteria_text))
        })?;
        for row in rows {
            let (node, enforcement, criteria_text) = row?;
            let criteria_value: Value = serde_json::from_str(&criteria_text)
                .map_err(|_| StorageError::InvalidStoredData("guardrail criteria"))?;
            let criteria = guardrail_criteria(&criteria_value);
            let command_text = input.command.as_deref().unwrap_or_default().join(" ");
            let file_text = input
                .changed_files
                .as_deref()
                .unwrap_or_default()
                .join("\n");
            let enforcement = match enforcement.as_str() {
                "advise" => GuardrailEnforcement::Advise,
                "warn" => GuardrailEnforcement::Warn,
                "block" => GuardrailEnforcement::Block,
                _ => return Err(StorageError::InvalidStoredData("guardrail enforcement")),
            };
            let evaluation = evaluate_guardrail(
                &criteria,
                node.status,
                enforcement,
                GuardrailContext {
                    task: &input.task_description,
                    command: &command_text,
                    files: &file_text,
                },
            );
            if evaluation.matches {
                if !nodes.iter().any(|candidate| candidate.id == node.id) {
                    nodes.push(node.clone());
                }
                guardrails.push(PreflightGuardrail {
                    node,
                    blocks: evaluation.blocks,
                });
            }
        }
        guardrails.sort_by(|left, right| {
            right
                .blocks
                .cmp(&left.blocks)
                .then_with(|| left.node.id.cmp(&right.node.id))
        });
        let mut case_ids = nodes
            .iter()
            .map(|node| node.case_id.clone())
            .collect::<Vec<_>>();
        case_ids.extend(
            guardrails
                .iter()
                .map(|guardrail| guardrail.node.case_id.clone()),
        );
        case_ids.sort();
        case_ids.dedup();
        let case_rows = self.case_rows(project_id, &case_ids)?;
        let candidates = case_rows
            .into_iter()
            .map(|(case_id, case_title, case_status)| RelevanceCandidate {
                nodes: nodes
                    .iter()
                    .filter(|node| node.case_id == case_id)
                    .cloned()
                    .collect(),
                guardrails: guardrails
                    .iter()
                    .filter(|item| item.node.case_id == case_id)
                    .cloned()
                    .collect(),
                case_id,
                case_title,
                case_status,
            })
            .collect();
        let now_epoch_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_millis() as i64);
        let cards = rank_cases(
            &RelevanceContext {
                task_description: input.task_description.clone(),
                changed_files: input.changed_files.clone().unwrap_or_default(),
                command: input.command.clone().unwrap_or_default(),
                fingerprint_case_ids,
                now_epoch_ms,
            },
            candidates,
        )
        .into_iter()
        .take(limit)
        .collect();
        let uncertain = nodes
            .iter()
            .filter(|node| {
                matches!(node.status, NodeStatus::Open | NodeStatus::Candidate)
                    && node.node_type != NodeType::Attempt
            })
            .take(limit)
            .cloned()
            .collect();
        let result = compact_preflight(
            PreflightResult {
                blocked: guardrails.iter().any(|guardrail| guardrail.blocks),
                cards,
                guardrails: vec![],
                failed_attempts: vec![],
                root_causes: vec![],
                solutions: vec![],
                uncertain,
                truncated: false,
                expansion_case_ids: vec![],
            },
            12 * 1024,
        );
        Ok((result, case_ids.len()))
    }

    fn remember_preflight(&self, key: String, value: CachedPreflight) {
        let mut cache = self.preflight_cache.borrow_mut();
        let mut order = self.preflight_order.borrow_mut();
        cache.insert(key.clone(), value);
        order.push_back(key);
        while order.len() > 256 {
            if let Some(oldest) = order.pop_front() {
                cache.remove(&oldest);
            }
        }
    }

    fn candidate_case_ids(
        &self,
        project_id: &str,
        context: &str,
    ) -> Result<Vec<String>, StorageError> {
        let Some(query) = build_fts_query_with_join(context, " OR ") else {
            return Ok(Vec::new());
        };
        let mut statement = self.connection.prepare(
            "SELECT DISTINCT nodes.case_id FROM node_search JOIN nodes ON nodes.id = node_search.node_id JOIN cases ON cases.id = nodes.case_id WHERE node_search MATCH ? AND cases.project_id = ? LIMIT 1000",
        )?;
        Ok(statement
            .query_map(params![query, project_id], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?)
    }

    fn nodes_for_cases(
        &self,
        project_id: &str,
        case_ids: &[String],
    ) -> Result<Vec<NodeRecord>, StorageError> {
        if case_ids.is_empty() {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT nodes.id, nodes.case_id, nodes.type, nodes.status, nodes.data, nodes.created_at FROM nodes JOIN cases ON cases.id = nodes.case_id WHERE cases.project_id = ? AND nodes.case_id IN ({}) ORDER BY nodes.created_at DESC LIMIT 10000",
            placeholders(case_ids.len()),
        );
        let mut values = vec![SqlValue::Text(project_id.to_owned())];
        values.extend(case_ids.iter().cloned().map(SqlValue::Text));
        let mut statement = self.connection.prepare(&sql)?;
        Ok(statement
            .query_map(params_from_iter(values), |row| node_from_columns(row, 0))?
            .collect::<Result<Vec<_>, _>>()?)
    }

    fn case_rows(
        &self,
        project_id: &str,
        case_ids: &[String],
    ) -> Result<Vec<(String, String, NodeStatus)>, StorageError> {
        if case_ids.is_empty() {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT id, title, status FROM cases WHERE project_id = ? AND id IN ({})",
            placeholders(case_ids.len())
        );
        let mut values = vec![SqlValue::Text(project_id.to_owned())];
        values.extend(case_ids.iter().cloned().map(SqlValue::Text));
        let mut statement = self.connection.prepare(&sql)?;
        Ok(statement
            .query_map(params_from_iter(values), |row| {
                let status_text: String = row.get(2)?;
                let status = parse_status(&status_text).ok_or_else(|| {
                    rusqlite::Error::InvalidColumnType(
                        2,
                        "status".into(),
                        rusqlite::types::Type::Text,
                    )
                })?;
                Ok((row.get(0)?, row.get(1)?, status))
            })?
            .collect::<Result<Vec<_>, _>>()?)
    }

    fn resolve_project(&self, input: &ProjectReference) -> Result<String, StorageError> {
        let found = if let Some(project_id) = &input.project_id {
            self.connection
                .query_row(
                    "SELECT id FROM projects WHERE id = ?",
                    params![project_id],
                    |row| row.get(0),
                )
                .optional()?
        } else if let Some(root) = &input.project_root {
            let root = std::fs::canonicalize(root)
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|_| root.to_owned());
            self.connection.query_row(
                "SELECT id FROM projects WHERE canonical_root = ? UNION SELECT projects.id FROM project_aliases JOIN projects ON projects.id = project_aliases.project_id WHERE project_aliases.root = ? LIMIT 1",
                params![root, root], |row| row.get(0),
            ).optional()?
        } else {
            None
        };
        found.ok_or(StorageError::ProjectNotFound)
    }
}

fn build_fts_query(text: &str) -> Option<String> {
    build_fts_query_with_join(text, " AND ")
}

fn build_fts_query_with_join(text: &str, joiner: &str) -> Option<String> {
    let mut terms = Vec::<String>::new();
    let mut current = String::new();
    for character in text.chars() {
        if character.is_alphanumeric() || matches!(character, '_' | '.' | '-') {
            current.push(character);
        } else if !current.is_empty() {
            push_term(&mut terms, std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        push_term(&mut terms, current);
    }
    if terms.is_empty() {
        None
    } else {
        Some(
            terms
                .into_iter()
                .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(joiner),
        )
    }
}

fn node_from_columns(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<NodeRecord> {
    let data_text: String = row.get(offset + 4)?;
    let data = serde_json::from_str::<BTreeMap<String, Value>>(&data_text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            offset + 4,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    let node_type_text: String = row.get(offset + 2)?;
    let status_text: String = row.get(offset + 3)?;
    let node_type = parse_node_type(&node_type_text).ok_or_else(|| {
        rusqlite::Error::InvalidColumnType(offset + 2, "type".into(), rusqlite::types::Type::Text)
    })?;
    let status = parse_status(&status_text).ok_or_else(|| {
        rusqlite::Error::InvalidColumnType(offset + 3, "status".into(), rusqlite::types::Type::Text)
    })?;
    Ok(NodeRecord {
        id: row.get(offset)?,
        case_id: row.get(offset + 1)?,
        node_type,
        status,
        data,
        created_at: row.get(offset + 5)?,
    })
}

fn guardrail_criteria(value: &Value) -> GuardrailCriteria {
    GuardrailCriteria {
        task_includes_all: value_strings(value, "taskIncludes"),
        task_includes_any: value_strings(value, "taskIncludesAny"),
        command_includes_all: value_strings(value, "commandIncludes"),
        command_includes_any: value_strings(value, "commandIncludesAny"),
        file_includes_all: value_strings(value, "fileIncludes"),
        file_includes_any: value_strings(value, "fileIncludesAny"),
    }
}

fn value_strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

struct HierarchyBuilder {
    case_id: String,
    status: NodeStatus,
    domain: String,
    text_parts: Vec<String>,
    fingerprints: BTreeSet<String>,
    files: BTreeSet<String>,
    commands: BTreeSet<String>,
    verified_conclusion: Option<String>,
}

impl Default for HierarchyBuilder {
    fn default() -> Self {
        Self {
            case_id: String::new(),
            status: NodeStatus::Candidate,
            domain: "general".into(),
            text_parts: Vec::new(),
            fingerprints: BTreeSet::new(),
            files: BTreeSet::new(),
            commands: BTreeSet::new(),
            verified_conclusion: None,
        }
    }
}

impl HierarchyBuilder {
    fn record(self, project_id: &str) -> HierarchyRecord {
        HierarchyRecord {
            project_id: project_id.to_owned(),
            domain: self.domain,
            case_id: self.case_id,
            status: self.status,
            text: self.text_parts.join(" "),
            fingerprints: self.fingerprints.into_iter().collect(),
            files: self.files.into_iter().collect(),
            commands: self.commands.into_iter().collect(),
            verified_conclusion: self.verified_conclusion,
        }
    }
}

fn collect_structural_values(
    value: &Value,
    files: &mut BTreeSet<String>,
    commands: &mut BTreeSet<String>,
) {
    let Some(object) = value.as_object() else {
        return;
    };
    for (key, item) in object {
        let target = if key.to_ascii_lowercase().contains("file") {
            Some(&mut *files)
        } else if key.to_ascii_lowercase().contains("command") {
            Some(&mut *commands)
        } else {
            None
        };
        if let Some(target) = target {
            if let Some(text) = item.as_str() {
                target.insert(text.to_owned());
            }
            if let Some(items) = item.as_array() {
                target.extend(items.iter().filter_map(Value::as_str).map(str::to_owned));
            }
        }
    }
}

fn share_structural_key(left: &HierarchyRecord, right: &HierarchyRecord) -> bool {
    intersects(&left.fingerprints, &right.fingerprints)
        || intersects(&left.files, &right.files)
        || intersects(&left.commands, &right.commands)
}

fn intersects(left: &[String], right: &[String]) -> bool {
    left.iter().any(|value| right.contains(value))
}

fn push_term(terms: &mut Vec<String>, term: String) {
    if !matches!(
        term.to_ascii_uppercase().as_str(),
        "AND" | "OR" | "NOT" | "NEAR"
    ) && !terms.contains(&term)
    {
        terms.push(term);
    }
}

fn trimmed(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty())
}
fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
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
fn status_text(value: NodeStatus) -> &'static str {
    match value {
        NodeStatus::Open => "open",
        NodeStatus::Candidate => "candidate",
        NodeStatus::Verified => "verified",
        NodeStatus::Regressed => "regressed",
        NodeStatus::Retired => "retired",
    }
}
fn parse_node_type(value: &str) -> Option<NodeType> {
    Some(match value {
        "Problem" => NodeType::Problem,
        "Attempt" => NodeType::Attempt,
        "RootCause" => NodeType::RootCause,
        "Solution" => NodeType::Solution,
        "Verification" => NodeType::Verification,
        "SuccessCase" => NodeType::SuccessCase,
        "Guardrail" => NodeType::Guardrail,
        "Artifact" => NodeType::Artifact,
        _ => return None,
    })
}
fn parse_status(value: &str) -> Option<NodeStatus> {
    Some(match value {
        "open" => NodeStatus::Open,
        "candidate" => NodeStatus::Candidate,
        "verified" => NodeStatus::Verified,
        "regressed" => NodeStatus::Regressed,
        "retired" => NodeStatus::Retired,
        _ => return None,
    })
}

fn parse_relation(value: &str) -> Option<RelationType> {
    match value {
        "ATTEMPTS_TO_SOLVE" => Some(RelationType::AttemptsToSolve),
        "PRECEDED_BY" => Some(RelationType::PrecededBy),
        "FAILED_BECAUSE" => Some(RelationType::FailedBecause),
        "CAUSES" => Some(RelationType::Causes),
        "ADDRESSES" => Some(RelationType::Addresses),
        "VERIFIED_BY" => Some(RelationType::VerifiedBy),
        "REFERENCES" => Some(RelationType::References),
        "INCLUDES" => Some(RelationType::Includes),
        "PREVENTS" => Some(RelationType::Prevents),
        "SUPERSEDES" => Some(RelationType::Supersedes),
        _ => None,
    }
}
