//! Project-scoped, query-only repository for the existing EKG SQLite schema.

use std::collections::BTreeMap;

use ekg_contracts::{
    ErrorCode, KnowledgeQueryItem, NodeRecord, NodeStatus, NodeType, QueryKnowledgeInput,
    QueryKnowledgeResult, Validate,
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

impl From<rusqlite::Error> for StorageError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}

pub struct ReadRepository {
    connection: Connection,
}

impl ReadRepository {
    pub fn open(database_path: &str) -> Result<Self, StorageError> {
        let connection = Connection::open(database_path)?;
        connection.pragma_update(None, "query_only", true)?;
        Ok(Self { connection })
    }

    pub fn query_knowledge(
        &self,
        input: &QueryKnowledgeInput,
    ) -> Result<QueryKnowledgeResult, StorageError> {
        input.validate().map_err(StorageError::Contract)?;
        let project_id = self.resolve_project(input)?;
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

    fn resolve_project(&self, input: &QueryKnowledgeInput) -> Result<String, StorageError> {
        let found = if let Some(project_id) = &input.project.project_id {
            self.connection
                .query_row(
                    "SELECT id FROM projects WHERE id = ?",
                    params![project_id],
                    |row| row.get(0),
                )
                .optional()?
        } else if let Some(root) = &input.project.project_root {
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
                .join(" AND "),
        )
    }
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
