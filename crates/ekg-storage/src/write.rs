use chrono::Utc;
use ekg_contracts::{
    NodeStatus, NodeWriteResult, ProjectReference, PromotionStatus, RecordAttemptInput,
    RecordProblemInput, SourceKey, Validate,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Debug)]
pub enum WriteError {
    Contract,
    Validation(&'static str),
    ProjectNotFound,
    OwnershipMismatch,
    OperationConflict,
    SourceConflict,
    InjectedFailure(WriteFaultPoint),
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
}

impl From<rusqlite::Error> for WriteError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}

impl From<serde_json::Error> for WriteError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteFaultPoint {
    AfterCase,
    AfterNode,
    AfterEvent,
    BeforeOperationResult,
}

pub struct WriteRepository {
    connection: Connection,
}

impl WriteRepository {
    pub fn open(database_path: &str) -> Result<Self, WriteError> {
        let connection = Connection::open(database_path)?;
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(Self { connection })
    }

    pub fn record_problem(
        &mut self,
        input: RecordProblemInput,
    ) -> Result<NodeWriteResult, WriteError> {
        self.record_problem_with_fault(input, None)
    }

    pub fn record_problem_with_fault(
        &mut self,
        input: RecordProblemInput,
        fault: Option<WriteFaultPoint>,
    ) -> Result<NodeWriteResult, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        if input.data.summary.trim().is_empty() {
            return Err(WriteError::Validation("problem summary"));
        }
        validate_identity(input.operation_id.as_deref(), input.source_key.as_ref())?;
        let transaction = self.connection.transaction()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        if let Some(result) = replay_operation(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "record_problem",
        )? {
            transaction.commit()?;
            return Ok(result);
        }
        if let Some(result) = replay_source(
            &transaction,
            &project_id,
            input.source_key.as_ref(),
            "Problem",
        )? {
            store_operation(
                &transaction,
                &project_id,
                input.operation_id.as_deref(),
                "record_problem",
                &result,
            )?;
            transaction.commit()?;
            return Ok(result);
        }

        if let Some(fingerprint) = input
            .data
            .fingerprint
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let existing = transaction
                .query_row(
                    "SELECT nodes.case_id, nodes.id FROM fingerprints JOIN nodes ON nodes.id = fingerprints.problem_node_id WHERE fingerprints.project_id = ? AND fingerprints.value = ?",
                    params![project_id, fingerprint],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            if let Some((case_id, node_id)) = existing {
                let result = result(case_id, node_id, false);
                store_operation(
                    &transaction,
                    &project_id,
                    input.operation_id.as_deref(),
                    "record_problem",
                    &result,
                )?;
                transaction.commit()?;
                return Ok(result);
            }
        }

        let now = timestamp();
        let (case_id, case_title, created_case) = if let Some(case_id) = &input.case_id {
            let title = require_case(&transaction, &project_id, case_id)?;
            (case_id.clone(), title, false)
        } else {
            let case_id = id();
            let title = redact_string(
                input
                    .case_title
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(&input.data.summary),
            );
            transaction.execute(
                "INSERT INTO cases (id, project_id, title, status, created_at) VALUES (?, ?, ?, 'open', ?)",
                params![case_id, project_id, title, now],
            )?;
            append_event(
                &transaction,
                &project_id,
                Some(&case_id),
                "case.created",
                &case_id,
                &json!({"caseId": case_id, "title": title}),
                &now,
            )?;
            maybe_fail(fault, WriteFaultPoint::AfterCase)?;
            (case_id, title, true)
        };

        let node_id = id();
        let data = redact_value(serde_json::to_value(&input.data)?);
        transaction.execute(
            "INSERT INTO nodes (id, case_id, type, status, data, created_at) VALUES (?, ?, 'Problem', 'open', ?, ?)",
            params![node_id, case_id, serde_json::to_string(&data)?, now],
        )?;
        index_node(&transaction, &project_id, &node_id, &case_title, &data)?;
        maybe_fail(fault, WriteFaultPoint::AfterNode)?;
        append_event(
            &transaction,
            &project_id,
            Some(&case_id),
            "node.added",
            &node_id,
            &json!({"caseId": case_id, "nodeId": node_id, "type": "Problem", "status": "open"}),
            &now,
        )?;
        maybe_fail(fault, WriteFaultPoint::AfterEvent)?;
        if let Some(fingerprint) = data.get("fingerprint").and_then(Value::as_str) {
            transaction.execute(
                "INSERT INTO fingerprints (id, project_id, problem_node_id, algorithm, value, created_at) VALUES (?, ?, ?, 'normalized-v1', ?, ?)",
                params![id(), project_id, node_id, fingerprint, now],
            )?;
        }
        let write_result = result(case_id, node_id.clone(), true);
        store_source(
            &transaction,
            &project_id,
            input.source_key.as_ref(),
            &node_id,
            &now,
        )?;
        maybe_fail(fault, WriteFaultPoint::BeforeOperationResult)?;
        store_operation(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "record_problem",
            &write_result,
        )?;
        transaction.commit()?;
        let _ = created_case;
        Ok(write_result)
    }

    pub fn record_attempt(
        &mut self,
        input: RecordAttemptInput,
    ) -> Result<NodeWriteResult, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        if input.data.hypothesis.trim().is_empty()
            || input.data.change.trim().is_empty()
            || !matches!(
                input.data.outcome.as_str(),
                "failed" | "succeeded" | "inconclusive"
            )
        {
            return Err(WriteError::Validation("attempt data"));
        }
        validate_identity(input.operation_id.as_deref(), input.source_key.as_ref())?;
        let transaction = self.connection.transaction()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        if let Some(result) = replay_operation(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "record_attempt",
        )? {
            transaction.commit()?;
            return Ok(result);
        }
        if let Some(result) = replay_source(
            &transaction,
            &project_id,
            input.source_key.as_ref(),
            "Attempt",
        )? {
            store_operation(
                &transaction,
                &project_id,
                input.operation_id.as_deref(),
                "record_attempt",
                &result,
            )?;
            transaction.commit()?;
            return Ok(result);
        }
        let case_title = require_case(&transaction, &project_id, &input.case_id)?;
        require_node(
            &transaction,
            &project_id,
            &input.case_id,
            &input.problem_id,
            "Problem",
        )?;
        if let Some(previous) = &input.previous_attempt_id {
            require_node(
                &transaction,
                &project_id,
                &input.case_id,
                previous,
                "Attempt",
            )?;
        }
        let now = timestamp();
        let node_id = id();
        let data = redact_value(serde_json::to_value(&input.data)?);
        let status = if input.data.outcome == "succeeded" {
            "candidate"
        } else {
            "open"
        };
        transaction.execute(
            "INSERT INTO nodes (id, case_id, type, status, data, created_at) VALUES (?, ?, 'Attempt', ?, ?, ?)",
            params![node_id, input.case_id, status, serde_json::to_string(&data)?, now],
        )?;
        index_node(&transaction, &project_id, &node_id, &case_title, &data)?;
        append_event(
            &transaction,
            &project_id,
            Some(&input.case_id),
            "node.added",
            &node_id,
            &json!({"caseId": input.case_id, "nodeId": node_id, "type": "Attempt", "status": status}),
            &now,
        )?;
        add_edge(
            &transaction,
            &project_id,
            &input.case_id,
            &node_id,
            "ATTEMPTS_TO_SOLVE",
            &input.problem_id,
            &now,
        )?;
        if let Some(previous) = &input.previous_attempt_id {
            add_edge(
                &transaction,
                &project_id,
                &input.case_id,
                &node_id,
                "PRECEDED_BY",
                previous,
                &now,
            )?;
        }
        let write_result = result(input.case_id, node_id.clone(), true);
        store_source(
            &transaction,
            &project_id,
            input.source_key.as_ref(),
            &node_id,
            &now,
        )?;
        store_operation(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "record_attempt",
            &write_result,
        )?;
        transaction.commit()?;
        Ok(write_result)
    }
}

fn validate_identity(
    operation_id: Option<&str>,
    source: Option<&SourceKey>,
) -> Result<(), WriteError> {
    if operation_id.is_some_and(|value| value.trim().is_empty())
        || source.is_some_and(|value| value.kind.trim().is_empty() || value.key.trim().is_empty())
    {
        return Err(WriteError::Validation("operation identity"));
    }
    Ok(())
}

fn resolve_project(
    transaction: &Transaction<'_>,
    project: &ProjectReference,
) -> Result<String, WriteError> {
    let project_id = if let Some(project_id) = &project.project_id {
        transaction
            .query_row(
                "SELECT id FROM projects WHERE id = ?",
                params![project_id],
                |row| row.get(0),
            )
            .optional()?
    } else if let Some(root) = &project.project_root {
        transaction
            .query_row(
                "SELECT id FROM projects WHERE canonical_root = ? UNION SELECT project_id FROM project_aliases WHERE root = ? LIMIT 1",
                params![root, root],
                |row| row.get(0),
            )
            .optional()?
    } else {
        None
    };
    project_id.ok_or(WriteError::ProjectNotFound)
}

fn require_case(
    transaction: &Transaction<'_>,
    project_id: &str,
    case_id: &str,
) -> Result<String, WriteError> {
    transaction
        .query_row(
            "SELECT title FROM cases WHERE id = ? AND project_id = ?",
            params![case_id, project_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(WriteError::OwnershipMismatch)
}

fn require_node(
    transaction: &Transaction<'_>,
    project_id: &str,
    case_id: &str,
    node_id: &str,
    node_type: &str,
) -> Result<(), WriteError> {
    let found = transaction
        .query_row(
            "SELECT 1 FROM nodes JOIN cases ON cases.id = nodes.case_id WHERE nodes.id = ? AND nodes.case_id = ? AND nodes.type = ? AND cases.project_id = ?",
            params![node_id, case_id, node_type, project_id],
            |_| Ok(()),
        )
        .optional()?;
    found.ok_or(WriteError::OwnershipMismatch)
}

fn replay_operation(
    transaction: &Transaction<'_>,
    project_id: &str,
    operation_id: Option<&str>,
    kind: &str,
) -> Result<Option<NodeWriteResult>, WriteError> {
    let Some(operation_id) = operation_id else {
        return Ok(None);
    };
    let row = transaction
        .query_row(
            "SELECT kind, result FROM operation_results WHERE project_id = ? AND operation_id = ?",
            params![project_id, operation_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((stored_kind, result)) = row else {
        return Ok(None);
    };
    if stored_kind != kind {
        return Err(WriteError::OperationConflict);
    }
    let mut result: NodeWriteResult = serde_json::from_str(&result)?;
    result.created = false;
    Ok(Some(result))
}

fn replay_source(
    transaction: &Transaction<'_>,
    project_id: &str,
    source: Option<&SourceKey>,
    expected_type: &str,
) -> Result<Option<NodeWriteResult>, WriteError> {
    let Some(source) = source else {
        return Ok(None);
    };
    let row = transaction
        .query_row(
            "SELECT nodes.case_id, nodes.id, nodes.type FROM source_keys JOIN nodes ON nodes.id = source_keys.node_id JOIN cases ON cases.id = nodes.case_id WHERE source_keys.project_id = ? AND source_keys.source_kind = ? AND source_keys.source_key = ? AND cases.project_id = ?",
            params![project_id, source.kind, source.key, project_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )
        .optional()?;
    let Some((case_id, node_id, node_type)) = row else {
        return Ok(None);
    };
    if node_type != expected_type {
        return Err(WriteError::SourceConflict);
    }
    Ok(Some(result(case_id, node_id, false)))
}

fn store_source(
    transaction: &Transaction<'_>,
    project_id: &str,
    source: Option<&SourceKey>,
    node_id: &str,
    now: &str,
) -> Result<(), WriteError> {
    if let Some(source) = source {
        transaction.execute(
            "INSERT INTO source_keys (id, project_id, source_kind, source_key, node_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            params![id(), project_id, source.kind, source.key, node_id, now],
        )?;
    }
    Ok(())
}

fn store_operation<T: Serialize>(
    transaction: &Transaction<'_>,
    project_id: &str,
    operation_id: Option<&str>,
    kind: &str,
    result: &T,
) -> Result<(), WriteError> {
    if let Some(operation_id) = operation_id {
        transaction.execute(
            "INSERT INTO operation_results (id, project_id, operation_id, kind, result, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            params![id(), project_id, operation_id, kind, serde_json::to_string(result)?, timestamp()],
        )?;
    }
    Ok(())
}

fn add_edge(
    transaction: &Transaction<'_>,
    project_id: &str,
    case_id: &str,
    source_id: &str,
    relation: &str,
    target_id: &str,
    now: &str,
) -> Result<(), WriteError> {
    let edge_id = id();
    transaction.execute(
        "INSERT INTO edges (id, case_id, source_id, relation, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        params![edge_id, case_id, source_id, relation, target_id, now],
    )?;
    append_event(
        transaction,
        project_id,
        Some(case_id),
        "edge.added",
        &edge_id,
        &json!({"caseId": case_id, "edgeId": edge_id, "sourceId": source_id, "relation": relation, "targetId": target_id}),
        now,
    )
}

fn append_event(
    transaction: &Transaction<'_>,
    project_id: &str,
    case_id: Option<&str>,
    event_type: &str,
    aggregate_id: &str,
    payload: &Value,
    occurred_at: &str,
) -> Result<(), WriteError> {
    transaction.execute(
        "INSERT INTO events (project_id, type, aggregate_id, payload, occurred_at, case_id) VALUES (?, ?, ?, ?, ?, ?)",
        params![project_id, event_type, aggregate_id, serde_json::to_string(&redact_value(payload.clone()))?, occurred_at, case_id],
    )?;
    Ok(())
}

fn index_node(
    transaction: &Transaction<'_>,
    project_id: &str,
    node_id: &str,
    title: &str,
    data: &Value,
) -> Result<(), WriteError> {
    transaction.execute(
        "INSERT INTO node_search (project_id, node_id, title, body) VALUES (?, ?, ?, ?)",
        params![project_id, node_id, title, serde_json::to_string(data)?],
    )?;
    Ok(())
}

fn result(case_id: String, node_id: String, created: bool) -> NodeWriteResult {
    NodeWriteResult {
        case_id,
        node_id,
        promotion: PromotionStatus {
            status: NodeStatus::Candidate,
            missing_requirements: vec![
                "root-cause-evidence".into(),
                "verified-root-cause".into(),
                "automated-verification-or-exception".into(),
                "human-confirmation".into(),
                "applicability".into(),
                "limitations".into(),
                "decisive-difference".into(),
            ],
        },
        created,
    }
}

fn redact_value(value: Value) -> Value {
    match value {
        Value::String(value) => Value::String(redact_string(&value)),
        Value::Array(values) => Value::Array(values.into_iter().map(redact_value).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| {
                    let lowered = key.to_ascii_lowercase();
                    if [
                        "password",
                        "token",
                        "authorization",
                        "secret",
                        "api_key",
                        "apikey",
                    ]
                    .iter()
                    .any(|term| lowered.contains(term))
                    {
                        (key, Value::String("[REDACTED]".into()))
                    } else {
                        (key, redact_value(value))
                    }
                })
                .collect(),
        ),
        other => other,
    }
}

fn redact_string(value: &str) -> String {
    let mut redact_next = false;
    let mut parts = Vec::new();
    for part in value.split_whitespace() {
        if redact_next {
            parts.push("[REDACTED]".into());
            redact_next = false;
            continue;
        }
        let lower = part.to_ascii_lowercase();
        if ["password:", "token:", "authorization:", "secret:"]
            .iter()
            .any(|marker| lower == *marker)
        {
            parts.push(format!("{part}[REDACTED]"));
            redact_next = true;
        } else if [
            "password=",
            "password:",
            "token=",
            "token:",
            "authorization=",
            "secret=",
        ]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
        {
            let separator = part.find(['=', ':']).unwrap_or(part.len());
            parts.push(format!(
                "{}[REDACTED]",
                &part[..=separator.min(part.len() - 1)]
            ));
        } else {
            parts.push(part.to_owned());
        }
    }
    if parts.is_empty() {
        String::new()
    } else {
        parts.shrink_to_fit();
        parts.join(" ")
    }
}

fn maybe_fail(
    configured: Option<WriteFaultPoint>,
    current: WriteFaultPoint,
) -> Result<(), WriteError> {
    if configured == Some(current) {
        Err(WriteError::InjectedFailure(current))
    } else {
        Ok(())
    }
}

fn id() -> String {
    Uuid::new_v4().to_string()
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
