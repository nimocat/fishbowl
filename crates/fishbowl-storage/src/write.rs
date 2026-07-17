use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};

use crate::{DiskCapture, DiskSnapshot};
use chrono::Utc;
use fishbowl_contracts::{
    ApplyCaseMergeInput, ArtifactWriteResult, CheckpointSkipReason, CheckpointWorkInput,
    CheckpointWorkResult, CheckpointWrite, CheckpointWriteResult, CleanupDisposition,
    CloseCaseInput, CloseCaseResult, CommandResultWriteResult, CommandStartedResult,
    DiskArtifactKind, DiskGrowthEntry, FinalizeWorkInput, FinalizeWorkResult,
    FinishDiskObservationInput, FinishDiskObservationResult, MarkRegressionInput,
    MergeProposalContract, NodeStatus, NodeWriteResult, ProjectAliasRecord, ProjectRecord,
    ProjectReference, ProjectWithAliasesRecord, PromotionStatus, RecordArtifactInput,
    RecordAttemptInput, RecordCheckpointInput, RecordCheckpointResult, RecordCommandResultInput,
    RecordCommandStartedInput, RecordGuardrailInput, RecordProblemInput, RecordRootCauseInput,
    RecordSolutionInput, RecordVerificationInput, RegisterProjectInput, RegressionOutcomeContract,
    RegressionResultContract, ReportRelevanceInput, SourceKey, StartDiskObservationInput,
    StartDiskObservationResult, SuggestCaseMergesInput, UpdateProjectInput, Validate,
    WriteAttemptData, WriteProblemData, WriteRootCauseData, WriteSolutionData,
    WriteVerificationData,
};
use fishbowl_core::{
    ApplicabilityBoundary, PromotionEvidence, PromotionRequirement, RegressionOutcome,
    evaluate_promotion, evaluate_regression,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde::de::DeserializeOwned;
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
    Io(std::io::Error),
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

impl From<std::io::Error> for WriteError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
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
    pub(crate) connection: Connection,
}

impl WriteRepository {
    pub fn open(database_path: &str) -> Result<Self, WriteError> {
        let connection = Connection::open(database_path)?;
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(Self { connection })
    }

    pub fn register_project(
        &mut self,
        input: RegisterProjectInput,
    ) -> Result<ProjectRecord, WriteError> {
        validate_project_fields(&input.name, input.description.as_deref())?;
        validate_operation_id(input.operation_id.as_deref())?;
        let root = canonical_path(&input.root)?;
        let transaction = self.connection.savepoint()?;
        if let Some(result) = replay_unscoped_project_operation(
            &transaction,
            input.operation_id.as_deref(),
            "register_project",
        )? {
            transaction.commit()?;
            return Ok(result);
        }
        require_available_root(&transaction, &root)?;
        let now = timestamp();
        let project = ProjectRecord {
            id: id(),
            name: redact_string(input.name.trim()),
            description: input
                .description
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(redact_string),
            root,
            created_at: now.clone(),
        };
        transaction.execute(
            "INSERT INTO projects (id, name, description, canonical_root, created_at) VALUES (?, ?, ?, ?, ?)",
            params![project.id, project.name, project.description, project.root, project.created_at],
        )?;
        append_event(
            &transaction,
            &project.id,
            None,
            "project.registered",
            &project.id,
            &serde_json::to_value(&project)?,
            &now,
        )?;
        store_operation(
            &transaction,
            &project.id,
            input.operation_id.as_deref(),
            "register_project",
            &project,
        )?;
        transaction.commit()?;
        Ok(project)
    }

    pub fn update_project(
        &mut self,
        input: UpdateProjectInput,
    ) -> Result<ProjectWithAliasesRecord, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        if input.name.is_none() && input.description.is_none() && input.add_alias.is_none() {
            return Err(WriteError::Validation("project update"));
        }
        if let Some(name) = input.name.as_deref() {
            validate_project_fields(name, None)?;
        }
        let updates_metadata = input.name.is_some() || input.description.is_some();
        validate_operation_id(input.operation_id.as_deref())?;
        let alias = input.add_alias.as_deref().map(canonical_path).transpose()?;
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        if let Some(result) = replay_operation::<ProjectWithAliasesRecord>(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "update_project",
        )? {
            transaction.commit()?;
            return Ok(result);
        }
        let current = load_project(&transaction, &project_id)?;
        let name = input
            .name
            .as_deref()
            .map(str::trim)
            .map(redact_string)
            .unwrap_or(current.name);
        let description = match input.description {
            None => current.description,
            Some(None) => None,
            Some(Some(ref value)) => {
                if value.trim().is_empty() {
                    None
                } else {
                    Some(redact_string(value.trim()))
                }
            }
        };
        let now = timestamp();
        if updates_metadata {
            transaction.execute(
                "UPDATE projects SET name = ?, description = ? WHERE id = ?",
                params![name, description, project_id],
            )?;
            append_event(
                &transaction,
                &project_id,
                None,
                "project.updated",
                &project_id,
                &json!({"id": project_id, "name": name, "description": description}),
                &now,
            )?;
        }
        if let Some(root) = alias {
            require_available_root(&transaction, &root)?;
            let alias_id = id();
            transaction.execute(
                "INSERT INTO project_aliases (id, project_id, root, created_at) VALUES (?, ?, ?, ?)",
                params![alias_id, project_id, root, now],
            )?;
            append_event(
                &transaction,
                &project_id,
                None,
                "project.alias_added",
                &alias_id,
                &json!({"id": alias_id, "projectId": project_id, "root": root, "createdAt": now}),
                &now,
            )?;
        }
        let result = load_project_with_aliases(&transaction, &project_id)?;
        store_operation(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "update_project",
            &result,
        )?;
        transaction.commit()?;
        Ok(result)
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
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        if let Some(mut result) = replay_operation::<NodeWriteResult>(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "record_problem",
        )? {
            result.created = false;
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
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        if let Some(mut result) = replay_operation::<NodeWriteResult>(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "record_attempt",
        )? {
            result.created = false;
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

    pub fn record_command_started(
        &mut self,
        input: RecordCommandStartedInput,
    ) -> Result<CommandStartedResult, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        if input.command_run_id.trim().is_empty()
            || input.command.is_empty()
            || input.command.iter().any(|part| part.trim().is_empty())
        {
            return Err(WriteError::Validation("command start"));
        }
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        require_project_path(&transaction, &project_id, &input.working_directory)?;
        let result = CommandStartedResult {
            command_run_id: redact_string(&input.command_run_id),
        };
        append_event(
            &transaction,
            &project_id,
            None,
            "command.started",
            &result.command_run_id,
            &json!({
                "commandRunId": result.command_run_id,
                "command": input.command.into_iter().map(|part| redact_string(&part)).collect::<Vec<_>>(),
                "workingDirectory": input.working_directory,
                "startedAt": input.started_at,
            }),
            &timestamp(),
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn record_command_result(
        &mut self,
        input: RecordCommandResultInput,
    ) -> Result<CommandResultWriteResult, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        if input.command.is_empty() || input.command.iter().any(|part| part.trim().is_empty()) {
            return Err(WriteError::Validation("command result"));
        }
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        if let Some(mut result) = replay_operation::<CommandResultWriteResult>(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "record_command_result",
        )? {
            result.created = false;
            transaction.commit()?;
            return Ok(result);
        }
        require_project_path(&transaction, &project_id, &input.working_directory)?;
        if let Some(case_id) = &input.case_id {
            require_case(&transaction, &project_id, case_id)?;
        }
        if let Some(attempt_id) = &input.attempt_id {
            let case_id = input
                .case_id
                .as_deref()
                .ok_or(WriteError::Validation("attempt requires case"))?;
            require_node(&transaction, &project_id, case_id, attempt_id, "Attempt")?;
        }
        let command_run_id = input.command_run_id.clone().unwrap_or_else(id);
        let command = input
            .command
            .iter()
            .map(|part| redact_string(part))
            .collect::<Vec<_>>();
        let excerpt = redact_string(&input.excerpt);
        transaction.execute(
            "INSERT INTO command_runs (id, project_id, case_id, attempt_node_id, command, working_directory, exit_status, signal, duration_ms, excerpt, raw_log_path, raw_log_digest, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                command_run_id,
                project_id,
                input.case_id,
                input.attempt_id,
                serde_json::to_string(&command)?,
                input.working_directory,
                input.exit_status,
                input.signal.as_deref().map(redact_string),
                input.duration_ms,
                excerpt,
                input.raw_log_path.as_deref().map(redact_string),
                input.raw_log_digest.as_deref().map(redact_string),
                input.started_at,
                input.finished_at,
            ],
        )?;
        let result = CommandResultWriteResult {
            command_run_id: command_run_id.clone(),
            created: true,
        };
        let now = timestamp();
        append_event(
            &transaction,
            &project_id,
            input.case_id.as_deref(),
            "command.recorded",
            &command_run_id,
            &json!({"commandRunId": command_run_id, "caseId": input.case_id, "attemptId": input.attempt_id, "command": command, "exitStatus": input.exit_status, "excerpt": excerpt}),
            &now,
        )?;
        append_event(
            &transaction,
            &project_id,
            input.case_id.as_deref(),
            "command.completed",
            &command_run_id,
            &json!({"commandRunId": command_run_id, "caseId": input.case_id, "exitStatus": input.exit_status, "signal": input.signal}),
            &now,
        )?;
        store_operation(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "record_command_result",
            &result,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn record_root_cause(
        &mut self,
        input: RecordRootCauseInput,
    ) -> Result<NodeWriteResult, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        if input.data.explanation.trim().is_empty()
            || input.data.evidence.is_empty()
            || input
                .data
                .evidence
                .iter()
                .any(|item| item.trim().is_empty())
            || !input.data.confidence.is_finite()
            || !(0.0..=1.0).contains(&input.data.confidence)
            || input.status.is_some_and(|status| {
                !matches!(status, NodeStatus::Candidate | NodeStatus::Verified)
            })
            || input.status == Some(NodeStatus::Verified) && !input.human_confirmed
        {
            return Err(WriteError::Validation("root cause"));
        }
        validate_identity(input.operation_id.as_deref(), input.source_key.as_ref())?;
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        if let Some(mut result) = replay_operation::<NodeWriteResult>(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "record_root_cause",
        )? {
            result.created = false;
            transaction.commit()?;
            return Ok(result);
        }
        if let Some(result) = replay_source(
            &transaction,
            &project_id,
            input.source_key.as_ref(),
            "RootCause",
        )? {
            store_operation(
                &transaction,
                &project_id,
                input.operation_id.as_deref(),
                "record_root_cause",
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
        for attempt_id in &input.failed_attempt_ids {
            require_node(
                &transaction,
                &project_id,
                &input.case_id,
                attempt_id,
                "Attempt",
            )?;
            let data: String = transaction.query_row(
                "SELECT data FROM nodes WHERE id = ?",
                params![attempt_id],
                |row| row.get(0),
            )?;
            if serde_json::from_str::<Value>(&data)?
                .get("outcome")
                .and_then(Value::as_str)
                != Some("failed")
            {
                return Err(WriteError::Validation("root cause failed attempt"));
            }
        }
        let now = timestamp();
        let data = redact_value(serde_json::to_value(&input.data)?);
        let node_id = insert_node(
            &transaction,
            NodeInsert {
                project_id: &project_id,
                case_id: &input.case_id,
                case_title: &case_title,
                node_type: "RootCause",
                status: status_text(input.status.unwrap_or(NodeStatus::Candidate)),
                data: &data,
                now: &now,
            },
        )?;
        add_edge(
            &transaction,
            &project_id,
            &input.case_id,
            &node_id,
            "CAUSES",
            &input.problem_id,
            &now,
        )?;
        for attempt_id in &input.failed_attempt_ids {
            add_edge(
                &transaction,
                &project_id,
                &input.case_id,
                attempt_id,
                "FAILED_BECAUSE",
                &node_id,
                &now,
            )?;
        }
        let promotion = evaluate_case_promotion(&transaction, &project_id, &input.case_id, true)?;
        let result = NodeWriteResult {
            case_id: input.case_id,
            node_id: node_id.clone(),
            promotion,
            created: true,
        };
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
            "record_root_cause",
            &result,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn record_solution(
        &mut self,
        input: RecordSolutionInput,
    ) -> Result<NodeWriteResult, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        if input.data.summary.trim().is_empty()
            || input.data.applicability.is_empty()
            || input.data.limitations.is_empty()
            || input.data.decisive_difference.trim().is_empty()
        {
            return Err(WriteError::Validation("solution"));
        }
        validate_identity(input.operation_id.as_deref(), input.source_key.as_ref())?;
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        if let Some(mut result) = replay_operation::<NodeWriteResult>(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "record_solution",
        )? {
            result.created = false;
            transaction.commit()?;
            return Ok(result);
        }
        if let Some(result) = replay_source(
            &transaction,
            &project_id,
            input.source_key.as_ref(),
            "Solution",
        )? {
            store_operation(
                &transaction,
                &project_id,
                input.operation_id.as_deref(),
                "record_solution",
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
            &input.root_cause_id,
            "RootCause",
        )?;
        let now = timestamp();
        let data = redact_value(serde_json::to_value(&input.data)?);
        let node_id = insert_node(
            &transaction,
            NodeInsert {
                project_id: &project_id,
                case_id: &input.case_id,
                case_title: &case_title,
                node_type: "Solution",
                status: "candidate",
                data: &data,
                now: &now,
            },
        )?;
        add_edge(
            &transaction,
            &project_id,
            &input.case_id,
            &node_id,
            "ADDRESSES",
            &input.root_cause_id,
            &now,
        )?;
        let promotion = evaluate_case_promotion(&transaction, &project_id, &input.case_id, true)?;
        let result = NodeWriteResult {
            case_id: input.case_id,
            node_id: node_id.clone(),
            promotion,
            created: true,
        };
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
            "record_solution",
            &result,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn record_verification(
        &mut self,
        input: RecordVerificationInput,
    ) -> Result<NodeWriteResult, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        const ENVIRONMENT_KEYS: [&str; 6] = [
            "os",
            "toolVersion",
            "architecture",
            "scheme",
            "destination",
            "configuration",
        ];
        if !matches!(input.data.kind.as_str(), "automated" | "human")
            || input.data.kind == "automated" && input.data.human_confirmed
            || input
                .data
                .environment
                .keys()
                .any(|key| !ENVIRONMENT_KEYS.contains(&key.as_str()))
        {
            return Err(WriteError::Validation("verification"));
        }
        validate_identity(input.operation_id.as_deref(), input.source_key.as_ref())?;
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        if let Some(mut result) = replay_operation::<NodeWriteResult>(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "record_verification",
        )? {
            result.created = false;
            transaction.commit()?;
            return Ok(result);
        }
        if let Some(result) = replay_source(
            &transaction,
            &project_id,
            input.source_key.as_ref(),
            "Verification",
        )? {
            store_operation(
                &transaction,
                &project_id,
                input.operation_id.as_deref(),
                "record_verification",
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
            &input.solution_id,
            "Solution",
        )?;
        let now = timestamp();
        let data = redact_value(serde_json::to_value(&input.data)?);
        let node_id = insert_node(
            &transaction,
            NodeInsert {
                project_id: &project_id,
                case_id: &input.case_id,
                case_title: &case_title,
                node_type: "Verification",
                status: if input.data.succeeded {
                    "verified"
                } else {
                    "open"
                },
                data: &data,
                now: &now,
            },
        )?;
        add_edge(
            &transaction,
            &project_id,
            &input.case_id,
            &input.solution_id,
            "VERIFIED_BY",
            &node_id,
            &now,
        )?;
        transaction.execute(
            "INSERT INTO evidence (id, project_id, node_id, kind, command, exit_status, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![id(), project_id, node_id, input.data.kind, input.data.command.as_ref().map(serde_json::to_string).transpose()?, input.data.exit_status, serde_json::to_string(&data)?, now],
        )?;
        append_event(
            &transaction,
            &project_id,
            Some(&input.case_id),
            "verification.recorded",
            &node_id,
            &json!({"caseId": input.case_id, "solutionId": input.solution_id, "verificationId": node_id, "kind": input.data.kind, "succeeded": input.data.succeeded}),
            &now,
        )?;
        let promotion = evaluate_case_promotion(&transaction, &project_id, &input.case_id, true)?;
        let result = NodeWriteResult {
            case_id: input.case_id,
            node_id: node_id.clone(),
            promotion,
            created: true,
        };
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
            "record_verification",
            &result,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn record_artifact(
        &mut self,
        input: RecordArtifactInput,
    ) -> Result<ArtifactWriteResult, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        if input.data.kind.trim().is_empty() || input.data.uri.trim().is_empty() {
            return Err(WriteError::Validation("artifact"));
        }
        validate_identity(input.operation_id.as_deref(), input.source_key.as_ref())?;
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        if let Some(mut result) = replay_operation::<ArtifactWriteResult>(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "record_artifact",
        )? {
            result.created = false;
            transaction.commit()?;
            return Ok(result);
        }
        if !input.is_external {
            require_project_path(&transaction, &project_id, &input.data.uri)?;
        }
        let case_title = require_case(&transaction, &project_id, &input.case_id)?;
        require_node(
            &transaction,
            &project_id,
            &input.case_id,
            &input.verification_id,
            "Verification",
        )?;
        let now = timestamp();
        let data = redact_value(serde_json::to_value(&input.data)?);
        let node_id = insert_node(
            &transaction,
            NodeInsert {
                project_id: &project_id,
                case_id: &input.case_id,
                case_title: &case_title,
                node_type: "Artifact",
                status: "candidate",
                data: &data,
                now: &now,
            },
        )?;
        add_edge(
            &transaction,
            &project_id,
            &input.case_id,
            &input.verification_id,
            "REFERENCES",
            &node_id,
            &now,
        )?;
        let artifact_id = id();
        transaction.execute(
            "INSERT INTO artifacts (id, project_id, node_id, kind, uri, digest, is_external, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![artifact_id, project_id, node_id, input.data.kind, redact_string(&input.data.uri), input.data.digest.as_deref().map(redact_string), i64::from(input.is_external), serde_json::to_string(&redact_value(serde_json::to_value(&input.metadata)?))?, now],
        )?;
        append_event(
            &transaction,
            &project_id,
            Some(&input.case_id),
            "artifact.recorded",
            &artifact_id,
            &json!({"caseId": input.case_id, "nodeId": node_id, "artifactId": artifact_id}),
            &now,
        )?;
        let result = ArtifactWriteResult {
            case_id: input.case_id.clone(),
            node_id: node_id.clone(),
            artifact_id,
            promotion: evaluate_case_promotion(&transaction, &project_id, &input.case_id, false)?,
            created: true,
        };
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
            "record_artifact",
            &result,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn record_guardrail(
        &mut self,
        input: RecordGuardrailInput,
    ) -> Result<NodeWriteResult, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        let criteria_count = input.data.criteria.task_includes.len()
            + input.data.criteria.command_includes.len()
            + input.data.criteria.file_includes.len()
            + input.data.criteria.task_includes_any.len()
            + input.data.criteria.command_includes_any.len()
            + input.data.criteria.file_includes_any.len();
        if input.data.guidance.trim().is_empty()
            || !matches!(input.data.enforcement.as_str(), "advise" | "warn" | "block")
            || criteria_count == 0
            || input.status.is_some_and(|status| {
                !matches!(status, NodeStatus::Candidate | NodeStatus::Verified)
            })
        {
            return Err(WriteError::Validation("guardrail"));
        }
        validate_identity(input.operation_id.as_deref(), input.source_key.as_ref())?;
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        if let Some(mut result) = replay_operation::<NodeWriteResult>(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "record_guardrail",
        )? {
            result.created = false;
            transaction.commit()?;
            return Ok(result);
        }
        let case_title = require_case(&transaction, &project_id, &input.case_id)?;
        require_node(
            &transaction,
            &project_id,
            &input.case_id,
            &input.root_cause_id,
            "RootCause",
        )?;
        let now = timestamp();
        let data = redact_value(serde_json::to_value(&input.data)?);
        let node_id = insert_node(
            &transaction,
            NodeInsert {
                project_id: &project_id,
                case_id: &input.case_id,
                case_title: &case_title,
                node_type: "Guardrail",
                status: status_text(input.status.unwrap_or(NodeStatus::Candidate)),
                data: &data,
                now: &now,
            },
        )?;
        add_edge(
            &transaction,
            &project_id,
            &input.case_id,
            &node_id,
            "PREVENTS",
            &input.root_cause_id,
            &now,
        )?;
        transaction.execute(
            "INSERT INTO guardrails (id, project_id, node_id, enforcement, criteria, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            params![id(), project_id, node_id, input.data.enforcement, serde_json::to_string(&input.data.criteria)?, now],
        )?;
        append_event(
            &transaction,
            &project_id,
            Some(&input.case_id),
            "guardrail.recorded",
            &node_id,
            &json!({"caseId": input.case_id, "guardrailId": node_id, "enforcement": input.data.enforcement}),
            &now,
        )?;
        let result = NodeWriteResult {
            case_id: input.case_id.clone(),
            node_id: node_id.clone(),
            promotion: evaluate_case_promotion(&transaction, &project_id, &input.case_id, false)?,
            created: true,
        };
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
            "record_guardrail",
            &result,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn close_case(&mut self, input: CloseCaseInput) -> Result<CloseCaseResult, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        if let Some(result) = replay_operation::<CloseCaseResult>(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "close_case",
        )? {
            transaction.commit()?;
            return Ok(result);
        }
        require_case(&transaction, &project_id, &input.case_id)?;
        let promotion = evaluate_case_promotion(&transaction, &project_id, &input.case_id, true)?;
        let result = CloseCaseResult {
            case_id: input.case_id.clone(),
            promotion,
        };
        let now = timestamp();
        append_event(
            &transaction,
            &project_id,
            Some(&input.case_id),
            "case.closed",
            &input.case_id,
            &serde_json::to_value(&result)?,
            &now,
        )?;
        store_operation(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "close_case",
            &result,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn mark_regression(
        &mut self,
        input: MarkRegressionInput,
    ) -> Result<RegressionResultContract, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        if input.fingerprint.trim().is_empty() {
            return Err(WriteError::Validation("regression fingerprint"));
        }
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        if let Some(result) = replay_operation::<RegressionResultContract>(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "mark_regression",
        )? {
            transaction.commit()?;
            return Ok(result);
        }
        require_case(&transaction, &project_id, &input.case_id)?;
        require_node(
            &transaction,
            &project_id,
            &input.case_id,
            &input.solution_id,
            "Solution",
        )?;
        let (solution_status, solution_data): (String, String) = transaction.query_row(
            "SELECT status, data FROM nodes WHERE id = ?",
            params![input.solution_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if solution_status != "verified" {
            return Err(WriteError::Validation("verified solution required"));
        }
        let stored_fingerprint = transaction
            .query_row(
                "SELECT fingerprints.value FROM fingerprints JOIN nodes ON nodes.id = fingerprints.problem_node_id WHERE fingerprints.project_id = ? AND nodes.case_id = ? ORDER BY fingerprints.created_at LIMIT 1",
                params![project_id, input.case_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let data = serde_json::from_str::<Value>(&solution_data)?;
        let boundary = data
            .get("applicabilityBoundary")
            .cloned()
            .map(serde_json::from_value::<ApplicabilityBoundary>)
            .transpose()?
            .unwrap_or_default();
        let observed = input
            .observed_context
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect::<Vec<_>>();
        let outcome = match evaluate_regression(
            stored_fingerprint.as_deref() == Some(input.fingerprint.trim()),
            &boundary,
            &observed,
        ) {
            RegressionOutcome::Regressed => RegressionOutcomeContract::Regressed,
            RegressionOutcome::OutsideApplicability => {
                RegressionOutcomeContract::OutsideApplicability
            }
            RegressionOutcome::DifferentFingerprint => {
                RegressionOutcomeContract::DifferentFingerprint
            }
        };
        let result = RegressionResultContract {
            outcome: outcome.clone(),
            case_id: input.case_id.clone(),
        };
        if outcome == RegressionOutcomeContract::Regressed {
            transaction.execute(
                "UPDATE nodes SET status = 'regressed' WHERE id = ?",
                params![input.solution_id],
            )?;
            transaction.execute(
                "UPDATE cases SET status = 'regressed' WHERE id = ? AND project_id = ?",
                params![input.case_id, project_id],
            )?;
            append_event(
                &transaction,
                &project_id,
                Some(&input.case_id),
                "case.regressed",
                &input.case_id,
                &json!({"outcome": outcome, "caseId": input.case_id, "solutionId": input.solution_id, "observedContext": redact_value(serde_json::to_value(&input.observed_context)?)}),
                &timestamp(),
            )?;
        }
        store_operation(
            &transaction,
            &project_id,
            input.operation_id.as_deref(),
            "mark_regression",
            &result,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn report_relevance(&mut self, input: ReportRelevanceInput) -> Result<(), WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        if input.context_digest.len() != 64
            || !input
                .context_digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(WriteError::Validation("context digest"));
        }
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        require_case(&transaction, &project_id, &input.case_id)?;
        transaction.execute(
            "INSERT INTO relevance_feedback (id, project_id, case_id, context_digest, useful, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            params![id(), project_id, input.case_id, input.context_digest.to_ascii_lowercase(), i64::from(input.useful), timestamp()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn suggest_case_merges(
        &mut self,
        input: SuggestCaseMergesInput,
    ) -> Result<Vec<MergeProposalContract>, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        let cases = transaction
            .prepare("SELECT id, title FROM cases WHERE project_id = ? AND status <> 'retired' ORDER BY created_at DESC, id DESC LIMIT 200")?
            .query_map(params![project_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        let limit = input.limit.unwrap_or(20).clamp(1, 25);
        let now = timestamp();
        let mut proposals = Vec::new();
        for left in 0..cases.len() {
            for right in (left + 1)..cases.len() {
                if proposals.len() >= limit {
                    break;
                }
                let score = title_similarity(&cases[left].1, &cases[right].1);
                if score < 0.6 {
                    continue;
                }
                if let Some(existing) = load_merge_proposal_pair(
                    &transaction,
                    &project_id,
                    &cases[left].0,
                    &cases[right].0,
                )? {
                    proposals.push(existing);
                    continue;
                }
                let proposal = MergeProposalContract {
                    id: id(),
                    project_id: project_id.clone(),
                    source_case_id: cases[left].0.clone(),
                    target_case_id: cases[right].0.clone(),
                    score,
                    reasons: vec!["similar-case-title".into()],
                    status: "proposed".into(),
                    created_at: now.clone(),
                    updated_at: now.clone(),
                };
                transaction.execute(
                    "INSERT INTO case_merge_proposals (id, project_id, source_case_id, target_case_id, score, reasons, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params![proposal.id, proposal.project_id, proposal.source_case_id, proposal.target_case_id, proposal.score, serde_json::to_string(&proposal.reasons)?, proposal.status, proposal.created_at, proposal.updated_at],
                )?;
                proposals.push(proposal);
            }
        }
        transaction.commit()?;
        Ok(proposals)
    }

    pub fn apply_case_merge(
        &mut self,
        input: ApplyCaseMergeInput,
    ) -> Result<MergeProposalContract, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        if let Some(result) = replay_operation::<MergeProposalContract>(
            &transaction,
            &project_id,
            Some(&input.operation_id),
            "apply_case_merge",
        )? {
            transaction.commit()?;
            return Ok(result);
        }
        let mut proposal = load_merge_proposal(&transaction, &project_id, &input.proposal_id)?
            .ok_or(WriteError::OwnershipMismatch)?;
        if proposal.status == "rejected" {
            return Err(WriteError::Validation("rejected merge"));
        }
        let now = timestamp();
        transaction.execute(
            "UPDATE cases SET status = 'retired' WHERE id = ? AND project_id = ?",
            params![proposal.source_case_id, project_id],
        )?;
        transaction.execute(
            "INSERT OR IGNORE INTO case_supersessions (project_id, source_case_id, target_case_id, proposal_id, created_at) VALUES (?, ?, ?, ?, ?)",
            params![project_id, proposal.source_case_id, proposal.target_case_id, proposal.id, now],
        )?;
        transaction.execute(
            "UPDATE case_merge_proposals SET status = 'applied', updated_at = ? WHERE id = ?",
            params![now, proposal.id],
        )?;
        proposal.status = "applied".into();
        proposal.updated_at = now.clone();
        append_event(
            &transaction,
            &project_id,
            Some(&proposal.target_case_id),
            "case.merge.applied",
            &proposal.id,
            &serde_json::to_value(&proposal)?,
            &now,
        )?;
        store_operation(
            &transaction,
            &project_id,
            Some(&input.operation_id),
            "apply_case_merge",
            &proposal,
        )?;
        transaction.commit()?;
        Ok(proposal)
    }

    pub fn record_checkpoint(
        &mut self,
        input: RecordCheckpointInput,
    ) -> Result<RecordCheckpointResult, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        if input.operation_id.trim().is_empty()
            || input.writes.is_empty()
            || input.writes.len() > 25
        {
            return Err(WriteError::Validation("checkpoint"));
        }
        self.connection
            .execute_batch("SAVEPOINT rust_record_checkpoint")?;
        let outcome = (|| {
            let project_id = resolve_project(&self.connection, &input.project)?;
            if let Some(mut replay) = replay_operation::<RecordCheckpointResult>(
                &self.connection,
                &project_id,
                Some(&input.operation_id),
                "record_checkpoint",
            )? {
                replay.created = false;
                return Ok(replay);
            }
            let mut results = Vec::with_capacity(input.writes.len());
            for write in input.writes {
                let result = match write {
                    CheckpointWrite::Problem(value) => {
                        CheckpointWriteResult::Node(self.record_problem(RecordProblemInput {
                            project: input.project.clone(),
                            operation_id: value.operation_id,
                            source_key: value.source_key,
                            case_id: value.case_id,
                            case_title: value.case_title,
                            data: value.data,
                        })?)
                    }
                    CheckpointWrite::Attempt(value) => {
                        CheckpointWriteResult::Node(self.record_attempt(RecordAttemptInput {
                            project: input.project.clone(),
                            operation_id: value.operation_id,
                            source_key: value.source_key,
                            case_id: value.case_id,
                            problem_id: value.problem_id,
                            previous_attempt_id: value.previous_attempt_id,
                            data: value.data,
                        })?)
                    }
                    CheckpointWrite::RootCause(value) => CheckpointWriteResult::Node(
                        self.record_root_cause(RecordRootCauseInput {
                            project: input.project.clone(),
                            operation_id: value.operation_id,
                            source_key: value.source_key,
                            case_id: value.case_id,
                            problem_id: value.problem_id,
                            failed_attempt_ids: value.failed_attempt_ids,
                            status: value.status,
                            human_confirmed: value.human_confirmed,
                            data: value.data,
                        })?,
                    ),
                    CheckpointWrite::Solution(value) => {
                        CheckpointWriteResult::Node(self.record_solution(RecordSolutionInput {
                            project: input.project.clone(),
                            operation_id: value.operation_id,
                            source_key: value.source_key,
                            case_id: value.case_id,
                            root_cause_id: value.root_cause_id,
                            data: value.data,
                        })?)
                    }
                    CheckpointWrite::Verification(value) => CheckpointWriteResult::Node(
                        self.record_verification(RecordVerificationInput {
                            project: input.project.clone(),
                            operation_id: value.operation_id,
                            source_key: value.source_key,
                            case_id: value.case_id,
                            solution_id: value.solution_id,
                            data: value.data,
                        })?,
                    ),
                    CheckpointWrite::Artifact(value) => CheckpointWriteResult::Artifact(
                        self.record_artifact(RecordArtifactInput {
                            project: input.project.clone(),
                            operation_id: value.operation_id,
                            source_key: value.source_key,
                            case_id: value.case_id,
                            verification_id: value.verification_id,
                            data: value.data,
                            metadata: value.metadata,
                            is_external: value.is_external,
                        })?,
                    ),
                    CheckpointWrite::Guardrail(value) => CheckpointWriteResult::Node(
                        self.record_guardrail(RecordGuardrailInput {
                            project: input.project.clone(),
                            operation_id: value.operation_id,
                            source_key: value.source_key,
                            case_id: value.case_id,
                            root_cause_id: value.root_cause_id,
                            status: value.status,
                            data: value.data,
                        })?,
                    ),
                };
                results.push(result);
            }
            let result = RecordCheckpointResult {
                results,
                created: true,
            };
            store_operation(
                &self.connection,
                &project_id,
                Some(&input.operation_id),
                "record_checkpoint",
                &result,
            )?;
            Ok(result)
        })();
        match outcome {
            Ok(result) => {
                self.connection
                    .execute_batch("RELEASE rust_record_checkpoint")?;
                Ok(result)
            }
            Err(error) => {
                self.connection.execute_batch(
                    "ROLLBACK TO rust_record_checkpoint; RELEASE rust_record_checkpoint",
                )?;
                Err(error)
            }
        }
    }

    pub fn checkpoint_work(
        &mut self,
        input: CheckpointWorkInput,
    ) -> Result<CheckpointWorkResult, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        if input.operation_id.trim().is_empty()
            || input.task.trim().is_empty()
            || input.summary.trim().is_empty()
            || !matches!(
                input.outcome.as_str(),
                "failed" | "succeeded" | "inconclusive"
            )
        {
            return Err(WriteError::Validation("checkpoint work"));
        }
        self.connection
            .execute_batch("SAVEPOINT rust_checkpoint_work")?;
        let outcome = (|| {
            let project_id = resolve_project(&self.connection, &input.project)?;
            if let Some(replay) = replay_operation::<CheckpointWorkResult>(
                &self.connection,
                &project_id,
                Some(&input.operation_id),
                "checkpoint_work",
            )? {
                return Ok(replay);
            }
            if input.importance.as_deref() == Some("routine") && input.outcome == "succeeded" {
                let result = CheckpointWorkResult {
                    recorded: false,
                    reason: Some(CheckpointSkipReason::RoutineSuccess),
                    created_case: false,
                    case_id: None,
                    problem_id: None,
                    attempt_id: None,
                    root_cause_id: None,
                    solution_id: None,
                };
                store_operation(
                    &self.connection,
                    &project_id,
                    Some(&input.operation_id),
                    "checkpoint_work",
                    &result,
                )?;
                return Ok(result);
            }
            let (case_id, problem_id, previous_attempt_id, created_case) =
                if let Some(case_id) = &input.case_id {
                    let (problem, previous) = case_anchor(&self.connection, &project_id, case_id)?;
                    (case_id.clone(), problem, previous, false)
                } else {
                    let problem = self.record_problem(RecordProblemInput {
                        project: input.project.clone(),
                        operation_id: Some(format!("{}:problem", input.operation_id)),
                        source_key: None,
                        case_id: None,
                        case_title: Some(input.task.clone()),
                        data: WriteProblemData {
                            summary: input.task.clone(),
                            symptoms: vec![input.summary.clone()],
                            first_observed_at: None,
                            domain: None,
                            fingerprint: input.fingerprint.clone(),
                        },
                    })?;
                    (problem.case_id, problem.node_id, None, problem.created)
                };
            let attempt = self.record_attempt(RecordAttemptInput {
                project: input.project.clone(),
                operation_id: Some(format!("{}:attempt", input.operation_id)),
                source_key: None,
                case_id: case_id.clone(),
                problem_id: problem_id.clone(),
                previous_attempt_id,
                data: WriteAttemptData {
                    hypothesis: input.task.clone(),
                    change: input.summary.clone(),
                    outcome: input.outcome.clone(),
                    command: input.command.clone(),
                    failure_explanation: (input.outcome == "failed").then(|| input.summary.clone()),
                    decisive_difference: (input.outcome == "succeeded")
                        .then(|| input.summary.clone()),
                },
            })?;
            let root_cause_id = if let Some(root) = &input.root_cause {
                Some(
                    self.record_root_cause(RecordRootCauseInput {
                        project: input.project.clone(),
                        operation_id: Some(format!("{}:root-cause", input.operation_id)),
                        source_key: None,
                        case_id: case_id.clone(),
                        problem_id: problem_id.clone(),
                        failed_attempt_ids: if input.outcome == "failed" {
                            vec![attempt.node_id.clone()]
                        } else {
                            Vec::new()
                        },
                        status: Some(NodeStatus::Candidate),
                        human_confirmed: false,
                        data: WriteRootCauseData {
                            explanation: root.explanation.clone(),
                            evidence: if input.evidence.is_empty() {
                                vec![input.summary.clone()]
                            } else {
                                input.evidence.clone()
                            },
                            rejected_alternatives: root.rejected_alternatives.clone(),
                            confidence: root.confidence,
                        },
                    })?
                    .node_id,
                )
            } else {
                None
            };
            let solution_id = if let Some(solution) = &input.solution {
                let root_cause_id = root_cause_id.as_ref().ok_or(WriteError::Validation(
                    "checkpoint solution requires root cause",
                ))?;
                Some(
                    self.record_solution(RecordSolutionInput {
                        project: input.project.clone(),
                        operation_id: Some(format!("{}:solution", input.operation_id)),
                        source_key: None,
                        case_id: case_id.clone(),
                        root_cause_id: root_cause_id.clone(),
                        data: WriteSolutionData {
                            summary: solution.summary.clone(),
                            applicability: solution.applicability.clone(),
                            limitations: solution.limitations.clone(),
                            side_effects: Vec::new(),
                            decisive_difference: solution.decisive_difference.clone(),
                            applicability_boundary: Default::default(),
                            human_verification_required: input.human_confirmed,
                            non_automatable_reason: None,
                        },
                    })?
                    .node_id,
                )
            } else {
                None
            };
            let result = CheckpointWorkResult {
                recorded: true,
                reason: None,
                created_case,
                case_id: Some(case_id),
                problem_id: Some(problem_id),
                attempt_id: Some(attempt.node_id),
                root_cause_id,
                solution_id,
            };
            store_operation(
                &self.connection,
                &project_id,
                Some(&input.operation_id),
                "checkpoint_work",
                &result,
            )?;
            Ok(result)
        })();
        finish_outer_savepoint(&self.connection, "rust_checkpoint_work", outcome)
    }

    pub fn finalize_work(
        &mut self,
        input: FinalizeWorkInput,
    ) -> Result<FinalizeWorkResult, WriteError> {
        input.project.validate().map_err(|_| WriteError::Contract)?;
        validate_finalize(&input)?;
        self.connection
            .execute_batch("SAVEPOINT rust_finalize_work")?;
        let outcome = (|| {
            let project_id = resolve_project(&self.connection, &input.project)?;
            if let Some(replay) = replay_operation::<FinalizeWorkResult>(
                &self.connection,
                &project_id,
                Some(&input.operation_id),
                "finalize_work",
            )? {
                return Ok(replay);
            }
            let (case_id, problem_id, mut previous_attempt_id, created_case) =
                if let Some(case_id) = &input.case_id {
                    let (problem, previous) = case_anchor(&self.connection, &project_id, case_id)?;
                    (case_id.clone(), problem, previous, false)
                } else {
                    let problem = self.record_problem(RecordProblemInput {
                        project: input.project.clone(),
                        operation_id: Some(format!("{}:problem", input.operation_id)),
                        source_key: None,
                        case_id: None,
                        case_title: Some(input.task.clone()),
                        data: WriteProblemData {
                            summary: input.task.clone(),
                            symptoms: vec![input.summary.clone()],
                            first_observed_at: None,
                            domain: None,
                            fingerprint: input.fingerprint.clone(),
                        },
                    })?;
                    (problem.case_id, problem.node_id, None, problem.created)
                };
            let mut attempt_ids = Vec::new();
            for (index, failed) in input.failed_attempts.iter().enumerate() {
                let attempt = self.record_attempt(RecordAttemptInput {
                    project: input.project.clone(),
                    operation_id: Some(format!("{}:failed-attempt:{index}", input.operation_id)),
                    source_key: None,
                    case_id: case_id.clone(),
                    problem_id: problem_id.clone(),
                    previous_attempt_id,
                    data: WriteAttemptData {
                        hypothesis: failed.hypothesis.clone(),
                        change: failed.change.clone(),
                        outcome: "failed".into(),
                        command: failed.command.clone(),
                        failure_explanation: Some(failed.failure_explanation.clone()),
                        decisive_difference: None,
                    },
                })?;
                previous_attempt_id = Some(attempt.node_id.clone());
                attempt_ids.push(attempt.node_id);
            }
            if input.outcome == "succeeded" {
                let attempt = self.record_attempt(RecordAttemptInput {
                    project: input.project.clone(),
                    operation_id: Some(format!("{}:succeeded-attempt", input.operation_id)),
                    source_key: None,
                    case_id: case_id.clone(),
                    problem_id: problem_id.clone(),
                    previous_attempt_id,
                    data: WriteAttemptData {
                        hypothesis: input.task.clone(),
                        change: input.summary.clone(),
                        outcome: "succeeded".into(),
                        command: None,
                        failure_explanation: None,
                        decisive_difference: Some(
                            input
                                .solution
                                .as_ref()
                                .map_or(input.summary.clone(), |value| {
                                    value.decisive_difference.clone()
                                }),
                        ),
                    },
                })?;
                attempt_ids.push(attempt.node_id);
            }
            let root_cause_id = if let Some(root) = &input.root_cause {
                Some(
                    self.record_root_cause(RecordRootCauseInput {
                        project: input.project.clone(),
                        operation_id: Some(format!("{}:root-cause", input.operation_id)),
                        source_key: None,
                        case_id: case_id.clone(),
                        problem_id: problem_id.clone(),
                        failed_attempt_ids: attempt_ids
                            .iter()
                            .take(input.failed_attempts.len())
                            .cloned()
                            .collect(),
                        status: Some(NodeStatus::Candidate),
                        human_confirmed: false,
                        data: WriteRootCauseData {
                            explanation: root.explanation.clone(),
                            evidence: root.evidence.clone(),
                            rejected_alternatives: root.rejected_alternatives.clone(),
                            confidence: root.confidence,
                        },
                    })?
                    .node_id,
                )
            } else {
                None
            };
            let solution_id =
                if let (Some(solution), Some(root_cause_id)) = (&input.solution, &root_cause_id) {
                    Some(
                        self.record_solution(RecordSolutionInput {
                            project: input.project.clone(),
                            operation_id: Some(format!("{}:solution", input.operation_id)),
                            source_key: None,
                            case_id: case_id.clone(),
                            root_cause_id: root_cause_id.clone(),
                            data: WriteSolutionData {
                                summary: solution.summary.clone(),
                                applicability: solution.applicability.clone(),
                                limitations: solution.limitations.clone(),
                                side_effects: Vec::new(),
                                decisive_difference: solution.decisive_difference.clone(),
                                applicability_boundary: Default::default(),
                                human_verification_required: false,
                                non_automatable_reason: None,
                            },
                        })?
                        .node_id,
                    )
                } else {
                    None
                };
            let mut verification_ids = Vec::new();
            if let Some(solution_id) = &solution_id {
                for (index, verification) in input.verifications.iter().enumerate() {
                    let result = self.record_verification(RecordVerificationInput {
                        project: input.project.clone(),
                        operation_id: Some(format!("{}:verification:{index}", input.operation_id)),
                        source_key: None,
                        case_id: case_id.clone(),
                        solution_id: solution_id.clone(),
                        data: WriteVerificationData {
                            kind: if verification.kind == "automated" {
                                "automated".into()
                            } else {
                                "human".into()
                            },
                            succeeded: verification.succeeded,
                            human_confirmed: verification.human_confirmed,
                            environment: verification.environment.clone(),
                            command: verification.command.clone(),
                            exit_status: None,
                            source_revision: None,
                            excerpt: Some(verification.excerpt.clone()),
                        },
                    })?;
                    verification_ids.push(result.node_id);
                }
            }
            let mut artifact_ids = Vec::new();
            if let Some(commit) = &input.commit {
                artifact_ids.push(record_delivery_artifact(&self.connection, &project_id, &case_id, &problem_id, "git-commit", &format!("git:commit:{}", commit.sha),
                    json!({"sha": commit.sha, "message": commit.message, "branch": commit.branch, "files": input.files}))?);
            }
            artifact_ids.push(record_delivery_artifact(
                &self.connection,
                &project_id,
                &case_id,
                &problem_id,
                "git-merge",
                &format!(
                    "git:merge:{}",
                    input
                        .merge
                        .merge_commit
                        .as_deref()
                        .unwrap_or(&input.merge.status)
                ),
                serde_json::to_value(&input.merge)?,
            )?);
            let result = FinalizeWorkResult {
                recorded: true,
                created_case,
                case_id: case_id.clone(),
                problem_id,
                attempt_ids,
                root_cause_id,
                solution_id,
                verification_ids,
                artifact_ids,
                merge_recorded: true,
                promotion: evaluate_case_promotion(&self.connection, &project_id, &case_id, false)?,
            };
            store_operation(
                &self.connection,
                &project_id,
                Some(&input.operation_id),
                "finalize_work",
                &result,
            )?;
            Ok(result)
        })();
        finish_outer_savepoint(&self.connection, "rust_finalize_work", outcome)
    }
}

fn finish_outer_savepoint<T>(
    connection: &Connection,
    name: &str,
    outcome: Result<T, WriteError>,
) -> Result<T, WriteError> {
    match outcome {
        Ok(result) => {
            connection.execute_batch(&format!("RELEASE {name}"))?;
            Ok(result)
        }
        Err(error) => {
            connection.execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}"))?;
            Err(error)
        }
    }
}

fn case_anchor(
    connection: &Connection,
    project_id: &str,
    case_id: &str,
) -> Result<(String, Option<String>), WriteError> {
    require_case(connection, project_id, case_id)?;
    let problem_id = connection
        .query_row(
            "SELECT nodes.id FROM nodes JOIN cases ON cases.id = nodes.case_id WHERE nodes.case_id = ? AND nodes.type = 'Problem' AND cases.project_id = ? ORDER BY nodes.created_at, nodes.id LIMIT 1",
            params![case_id, project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or(WriteError::Validation("case problem"))?;
    let previous = connection
        .query_row(
            "SELECT nodes.id FROM nodes JOIN cases ON cases.id = nodes.case_id WHERE nodes.case_id = ? AND nodes.type = 'Attempt' AND cases.project_id = ? ORDER BY nodes.created_at DESC, nodes.id DESC LIMIT 1",
            params![case_id, project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok((problem_id, previous))
}

fn validate_finalize(input: &FinalizeWorkInput) -> Result<(), WriteError> {
    if input.operation_id.trim().is_empty()
        || input.task.trim().is_empty()
        || input.summary.trim().is_empty()
        || !matches!(
            input.outcome.as_str(),
            "failed" | "succeeded" | "inconclusive"
        )
        || !matches!(
            input.merge.status.as_str(),
            "merged" | "pending" | "not-required" | "conflict"
        )
    {
        return Err(WriteError::Validation("finalize"));
    }
    if input.outcome == "succeeded"
        && (input.commit.is_none() || !input.verifications.iter().any(|item| item.succeeded))
    {
        return Err(WriteError::Validation("successful finalize evidence"));
    }
    if input.outcome != "succeeded" && input.failed_attempts.is_empty() {
        return Err(WriteError::Validation("failed finalize attempts"));
    }
    if !input.verifications.is_empty() && input.solution.is_none() {
        return Err(WriteError::Validation("finalize verification solution"));
    }
    if input.solution.is_some() && input.root_cause.is_none() {
        return Err(WriteError::Validation("finalize solution root cause"));
    }
    for verification in &input.verifications {
        if !matches!(verification.kind.as_str(), "automated" | "device" | "human")
            || verification.kind == "automated"
                && verification.command.as_ref().is_none_or(Vec::is_empty)
            || verification.kind == "device"
                && verification
                    .environment
                    .get("destination")
                    .is_none_or(|value| value.trim().is_empty())
            || verification.kind == "automated" && verification.human_confirmed
        {
            return Err(WriteError::Validation("finalize verification"));
        }
    }
    Ok(())
}

fn record_delivery_artifact(
    connection: &Connection,
    project_id: &str,
    case_id: &str,
    problem_id: &str,
    kind: &str,
    uri: &str,
    metadata: Value,
) -> Result<String, WriteError> {
    let case_title = require_case(connection, project_id, case_id)?;
    require_node(connection, project_id, case_id, problem_id, "Problem")?;
    let now = timestamp();
    let data = json!({"kind": kind, "uri": redact_string(uri)});
    let node_id = insert_node(
        connection,
        NodeInsert {
            project_id,
            case_id,
            case_title: &case_title,
            node_type: "Artifact",
            status: "candidate",
            data: &data,
            now: &now,
        },
    )?;
    add_edge(
        connection,
        project_id,
        case_id,
        problem_id,
        "REFERENCES",
        &node_id,
        &now,
    )?;
    let artifact_id = id();
    connection.execute(
        "INSERT INTO artifacts (id, project_id, node_id, kind, uri, digest, is_external, metadata, created_at) VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)",
        params![artifact_id, project_id, node_id, kind, redact_string(uri), serde_json::to_string(&redact_value(metadata))?, now],
    )?;
    append_event(
        connection,
        project_id,
        Some(case_id),
        "artifact.recorded",
        &artifact_id,
        &json!({"caseId": case_id, "nodeId": node_id, "artifactId": artifact_id}),
        &now,
    )?;
    Ok(artifact_id)
}

fn validate_project_fields(name: &str, description: Option<&str>) -> Result<(), WriteError> {
    if name.trim().is_empty() || name.len() > 16_384 {
        return Err(WriteError::Validation("project name"));
    }
    if description.is_some_and(|value| value.len() > 16_384) {
        return Err(WriteError::Validation("project description"));
    }
    Ok(())
}

fn validate_operation_id(operation_id: Option<&str>) -> Result<(), WriteError> {
    if operation_id.is_some_and(|value| value.trim().is_empty() || value.len() > 4096) {
        return Err(WriteError::Validation("operation id"));
    }
    Ok(())
}

fn canonical_path(path: &str) -> Result<String, WriteError> {
    if path.trim().is_empty() {
        return Err(WriteError::Validation("project root"));
    }
    Ok(std::fs::canonicalize(path)?.to_string_lossy().into_owned())
}

fn require_available_root(connection: &Connection, root: &str) -> Result<(), WriteError> {
    let exists = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE canonical_root = ? UNION ALL SELECT 1 FROM project_aliases WHERE root = ?)",
        params![root, root],
        |row| row.get::<_, i64>(0),
    )? != 0;
    if exists {
        Err(WriteError::SourceConflict)
    } else {
        Ok(())
    }
}

fn replay_unscoped_project_operation(
    connection: &Connection,
    operation_id: Option<&str>,
    kind: &str,
) -> Result<Option<ProjectRecord>, WriteError> {
    let Some(operation_id) = operation_id else {
        return Ok(None);
    };
    let mut statement = connection.prepare(
        "SELECT kind, result FROM operation_results WHERE operation_id = ? ORDER BY created_at LIMIT 2",
    )?;
    let rows = statement
        .query_map([operation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if rows.len() > 1 || rows.first().is_some_and(|(stored, _)| stored != kind) {
        return Err(WriteError::OperationConflict);
    }
    rows.first()
        .map(|(_, result)| serde_json::from_str(result).map_err(WriteError::from))
        .transpose()
}

fn load_project(connection: &Connection, project_id: &str) -> Result<ProjectRecord, WriteError> {
    connection
        .query_row(
            "SELECT id, name, description, canonical_root, created_at FROM projects WHERE id = ?",
            [project_id],
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
        .optional()?
        .ok_or(WriteError::ProjectNotFound)
}

fn load_project_with_aliases(
    connection: &Connection,
    project_id: &str,
) -> Result<ProjectWithAliasesRecord, WriteError> {
    let project = load_project(connection, project_id)?;
    let mut statement = connection.prepare(
        "SELECT id, project_id, root, created_at FROM project_aliases WHERE project_id = ? ORDER BY created_at, rowid",
    )?;
    let aliases = statement
        .query_map([project_id], |row| {
            Ok(ProjectAliasRecord {
                id: row.get(0)?,
                project_id: row.get(1)?,
                root: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ProjectWithAliasesRecord { project, aliases })
}

impl WriteRepository {
    pub fn start_disk_observation(
        &mut self,
        input: StartDiskObservationInput,
        snapshot: DiskSnapshot,
    ) -> Result<StartDiskObservationResult, WriteError> {
        self.start_disk_observation_capture(input, DiskCapture::uncached(snapshot))
    }

    pub fn start_disk_observation_capture(
        &mut self,
        input: StartDiskObservationInput,
        capture: DiskCapture,
    ) -> Result<StartDiskObservationResult, WriteError> {
        input.validate().map_err(|_| WriteError::Contract)?;
        validate_disk_capture(&capture)?;
        let snapshot = &capture.snapshot;
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        if let Some(mut replay) = replay_operation::<StartDiskObservationResult>(
            &transaction,
            &project_id,
            Some(&input.operation_id),
            "start_disk_observation",
        )? {
            replay.created = false;
            transaction.commit()?;
            return Ok(replay);
        }
        let observation_id = id();
        let started_at = timestamp();
        let task = redact_string(input.task.trim());
        transaction.execute(
            "INSERT INTO disk_observations (id,project_id,task,status,started_at,baseline_tracked_bytes,overlapping_observations,scanned_entries,scan_truncated) VALUES (?,?,?,'running',?,?,?,?,?)",
            params![
                observation_id,
                project_id,
                task,
                started_at,
                as_i64(snapshot.tracked_bytes)?,
                0_i64,
                as_i64(snapshot.scanned_entries as u64)?,
                bool_i64(snapshot.truncated),
            ],
        )?;
        for entry in &snapshot.entries {
            transaction.execute(
                "INSERT INTO disk_observation_entries (observation_id,project_id,relative_path,kind,baseline_bytes,created_by_observation) VALUES (?,?,?,?,?,0)",
                params![
                    observation_id,
                    project_id,
                    entry.relative_path,
                    disk_kind_text(entry.kind),
                    as_i64(entry.bytes)?,
                ],
            )?;
        }
        store_disk_measurement_cache(&transaction, &project_id, &capture)?;
        let result = StartDiskObservationResult {
            observation_id: observation_id.clone(),
            project_id: project_id.clone(),
            started_at: started_at.clone(),
            baseline_tracked_bytes: snapshot.tracked_bytes,
            tracked_paths: snapshot.entries.len(),
            scanned_entries: snapshot.scanned_entries,
            scan_truncated: snapshot.truncated,
            cache_hits: capture.cache_hits,
            cache_misses: capture.cache_misses,
            created: true,
        };
        append_event(
            &transaction,
            &project_id,
            None,
            "disk.observation.started",
            &observation_id,
            &json!({
                "observationId": observation_id,
                "baselineTrackedBytes": snapshot.tracked_bytes,
                "trackedPaths": snapshot.entries.len(),
                "scanTruncated": snapshot.truncated,
                "cacheHits": capture.cache_hits,
                "cacheMisses": capture.cache_misses,
            }),
            &started_at,
        )?;
        store_operation(
            &transaction,
            &project_id,
            Some(&input.operation_id),
            "start_disk_observation",
            &result,
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn finish_disk_observation(
        &mut self,
        input: FinishDiskObservationInput,
        snapshot: DiskSnapshot,
    ) -> Result<FinishDiskObservationResult, WriteError> {
        self.finish_disk_observation_capture(input, DiskCapture::uncached(snapshot))
    }

    pub fn finish_disk_observation_capture(
        &mut self,
        input: FinishDiskObservationInput,
        capture: DiskCapture,
    ) -> Result<FinishDiskObservationResult, WriteError> {
        input.validate().map_err(|_| WriteError::Contract)?;
        validate_disk_capture(&capture)?;
        let snapshot = &capture.snapshot;
        let transaction = self.connection.savepoint()?;
        let project_id = resolve_project(&transaction, &input.project)?;
        if let Some(replay) = replay_operation::<FinishDiskObservationResult>(
            &transaction,
            &project_id,
            Some(&input.operation_id),
            "finish_disk_observation",
        )? {
            transaction.commit()?;
            return Ok(replay);
        }
        let (started_at, baseline_tracked_bytes, status, baseline_scanned_entries, baseline_truncated): (
            String,
            i64,
            String,
            i64,
            i64,
        ) = transaction
            .query_row(
                "SELECT started_at,baseline_tracked_bytes,status,scanned_entries,scan_truncated FROM disk_observations WHERE id=? AND project_id=?",
                params![input.observation_id, project_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?
            .ok_or(WriteError::OwnershipMismatch)?;
        if status != "running" {
            return Err(WriteError::Validation("disk observation completed"));
        }
        let finished_at = timestamp();
        let overlapping_observations: i64 = transaction.query_row(
            "SELECT count(*) FROM disk_observations WHERE project_id=? AND id<>? AND started_at<=? AND COALESCE(finished_at,?)>=?",
            params![project_id,input.observation_id,finished_at,finished_at,started_at],
            |row| row.get(0),
        )?;
        let mut baseline = BTreeMap::<String, (DiskArtifactKind, u64)>::new();
        {
            let mut statement = transaction.prepare(
                "SELECT relative_path,kind,baseline_bytes FROM disk_observation_entries WHERE project_id=? AND observation_id=?",
            )?;
            let rows = statement.query_map(params![project_id, input.observation_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                let (path, kind, bytes) = row?;
                baseline.insert(
                    path,
                    (
                        parse_disk_kind(&kind).ok_or(WriteError::Validation("disk kind"))?,
                        bytes as u64,
                    ),
                );
            }
        }
        let final_entries = snapshot
            .entries
            .iter()
            .map(|entry| (entry.relative_path.clone(), (entry.kind, entry.bytes)))
            .collect::<BTreeMap<_, _>>();
        let paths = baseline
            .keys()
            .chain(final_entries.keys())
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut entries = Vec::new();
        let mut positive_growth_bytes = 0_u64;
        for path in paths {
            let (kind, baseline_bytes) = match baseline.get(&path).copied() {
                Some(entry) => entry,
                None => (
                    final_entries
                        .get(&path)
                        .map(|entry| entry.0)
                        .ok_or(WriteError::Validation("disk entry"))?,
                    0,
                ),
            };
            let final_bytes = final_entries.get(&path).map_or(0, |entry| entry.1);
            let delta_bytes = signed_delta(final_bytes, baseline_bytes)?;
            let created_by_observation = baseline_bytes == 0 && final_bytes > 0;
            let scan_truncated = baseline_truncated != 0 || snapshot.truncated;
            let cleanup_disposition = if overlapping_observations > 0 {
                CleanupDisposition::Shared
            } else if !scan_truncated
                && created_by_observation
                && kind != DiskArtifactKind::TemporaryOutput
            {
                CleanupDisposition::Eligible
            } else {
                CleanupDisposition::Review
            };
            if delta_bytes > 0 {
                positive_growth_bytes = positive_growth_bytes.saturating_add(delta_bytes as u64);
            }
            transaction.execute(
                "INSERT INTO disk_observation_entries (observation_id,project_id,relative_path,kind,baseline_bytes,final_bytes,delta_bytes,created_by_observation,cleanup_disposition) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(observation_id,relative_path) DO UPDATE SET final_bytes=excluded.final_bytes,delta_bytes=excluded.delta_bytes,created_by_observation=excluded.created_by_observation,cleanup_disposition=excluded.cleanup_disposition",
                params![
                    input.observation_id,
                    project_id,
                    path,
                    disk_kind_text(kind),
                    as_i64(baseline_bytes)?,
                    as_i64(final_bytes)?,
                    delta_bytes,
                    bool_i64(created_by_observation),
                    cleanup_text(cleanup_disposition),
                ],
            )?;
            if delta_bytes != 0 {
                entries.push(DiskGrowthEntry {
                    relative_path: path,
                    kind,
                    baseline_bytes,
                    final_bytes,
                    delta_bytes,
                    created_by_observation,
                    cleanup_disposition,
                });
            }
        }
        entries.sort_by(|left, right| {
            right
                .delta_bytes
                .cmp(&left.delta_bytes)
                .then_with(|| left.relative_path.cmp(&right.relative_path))
        });
        let delta_bytes = signed_delta(snapshot.tracked_bytes, baseline_tracked_bytes as u64)?;
        transaction.execute(
            "UPDATE disk_observations SET status='completed',finished_at=?,final_tracked_bytes=?,delta_bytes=?,positive_growth_bytes=?,overlapping_observations=?,scanned_entries=scanned_entries+?,scan_truncated=CASE WHEN scan_truncated=1 OR ?=1 THEN 1 ELSE 0 END WHERE id=? AND project_id=?",
            params![
                finished_at,
                as_i64(snapshot.tracked_bytes)?,
                delta_bytes,
                as_i64(positive_growth_bytes)?,
                overlapping_observations,
                as_i64(snapshot.scanned_entries as u64)?,
                bool_i64(snapshot.truncated),
                input.observation_id,
                project_id,
            ],
        )?;
        store_disk_measurement_cache(&transaction, &project_id, &capture)?;
        let scanned_entries = usize::try_from(baseline_scanned_entries)
            .map_err(|_| WriteError::Validation("disk scan count"))?
            .saturating_add(snapshot.scanned_entries);
        let scan_truncated = baseline_truncated != 0 || snapshot.truncated;
        let result = FinishDiskObservationResult {
            observation_id: input.observation_id.clone(),
            project_id: project_id.clone(),
            started_at,
            finished_at: finished_at.clone(),
            baseline_tracked_bytes: baseline_tracked_bytes as u64,
            final_tracked_bytes: snapshot.tracked_bytes,
            delta_bytes,
            positive_growth_bytes,
            overlapping_observations: overlapping_observations as usize,
            scanned_entries,
            scan_truncated,
            cache_hits: capture.cache_hits,
            cache_misses: capture.cache_misses,
            entries,
        };
        append_event(
            &transaction,
            &project_id,
            None,
            "disk.observation.completed",
            &input.observation_id,
            &json!({
                "observationId": input.observation_id,
                "deltaBytes": delta_bytes,
                "positiveGrowthBytes": positive_growth_bytes,
                "overlappingObservations": overlapping_observations,
                "scanTruncated": scan_truncated,
                "cacheHits": capture.cache_hits,
                "cacheMisses": capture.cache_misses,
            }),
            &finished_at,
        )?;
        store_operation(
            &transaction,
            &project_id,
            Some(&input.operation_id),
            "finish_disk_observation",
            &result,
        )?;
        transaction.commit()?;
        Ok(result)
    }
}

struct NodeInsert<'a> {
    project_id: &'a str,
    case_id: &'a str,
    case_title: &'a str,
    node_type: &'a str,
    status: &'a str,
    data: &'a Value,
    now: &'a str,
}

fn insert_node(transaction: &Connection, input: NodeInsert<'_>) -> Result<String, WriteError> {
    let node_id = id();
    transaction.execute(
        "INSERT INTO nodes (id, case_id, type, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        params![
            node_id,
            input.case_id,
            input.node_type,
            input.status,
            serde_json::to_string(input.data)?,
            input.now
        ],
    )?;
    index_node(
        transaction,
        input.project_id,
        &node_id,
        input.case_title,
        input.data,
    )?;
    append_event(
        transaction,
        input.project_id,
        Some(input.case_id),
        "node.added",
        &node_id,
        &json!({"caseId": input.case_id, "nodeId": node_id, "type": input.node_type, "status": input.status}),
        input.now,
    )?;
    Ok(node_id)
}

fn title_similarity(left: &str, right: &str) -> f64 {
    let tokenize = |value: &str| {
        value
            .to_lowercase()
            .split(|character: char| !character.is_alphanumeric())
            .filter(|term| !term.is_empty())
            .map(str::to_owned)
            .collect::<std::collections::BTreeSet<_>>()
    };
    let left = tokenize(left);
    let right = tokenize(right);
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let intersection = left.intersection(&right).count();
    let union = left.union(&right).count();
    intersection as f64 / union as f64
}

fn load_merge_proposal_pair(
    connection: &Connection,
    project_id: &str,
    source_case_id: &str,
    target_case_id: &str,
) -> Result<Option<MergeProposalContract>, WriteError> {
    let id = connection
        .query_row(
            "SELECT id FROM case_merge_proposals WHERE project_id = ? AND source_case_id = ? AND target_case_id = ?",
            params![project_id, source_case_id, target_case_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    id.map(|id| load_merge_proposal(connection, project_id, &id))
        .transpose()
        .map(Option::flatten)
}

fn load_merge_proposal(
    connection: &Connection,
    project_id: &str,
    proposal_id: &str,
) -> Result<Option<MergeProposalContract>, WriteError> {
    connection
        .query_row(
            "SELECT id, project_id, source_case_id, target_case_id, score, reasons, status, created_at, updated_at FROM case_merge_proposals WHERE id = ? AND project_id = ?",
            params![proposal_id, project_id],
            |row| {
                let reasons = row.get::<_, String>(5)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, f64>(4)?,
                    reasons,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .optional()?
        .map(|row| {
            Ok(MergeProposalContract {
                id: row.0,
                project_id: row.1,
                source_case_id: row.2,
                target_case_id: row.3,
                score: row.4,
                reasons: serde_json::from_str(&row.5)?,
                status: row.6,
                created_at: row.7,
                updated_at: row.8,
            })
        })
        .transpose()
}

fn evaluate_case_promotion(
    transaction: &Connection,
    project_id: &str,
    case_id: &str,
    mutate: bool,
) -> Result<PromotionStatus, WriteError> {
    require_case(transaction, project_id, case_id)?;
    let root_rows = transaction
        .prepare("SELECT status, data FROM nodes WHERE case_id = ? AND type = 'RootCause'")?
        .query_map(params![case_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let root_cause_verified = root_rows.iter().any(|(status, _)| status == "verified");
    let root_cause_evidence_count = root_rows
        .iter()
        .filter_map(|(_, data)| serde_json::from_str::<Value>(data).ok())
        .filter_map(|data| data.get("evidence").and_then(Value::as_array).map(Vec::len))
        .sum();
    let solution_rows = transaction
        .prepare("SELECT id, data FROM nodes WHERE case_id = ? AND type = 'Solution' ORDER BY created_at DESC, id DESC")?
        .query_map(params![case_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let solution = solution_rows
        .first()
        .and_then(|(_, data)| serde_json::from_str::<Value>(data).ok());
    let solution_id = solution_rows.first().map(|(id, _)| id.as_str());
    let verifications = if let Some(solution_id) = solution_id {
        transaction
            .prepare("SELECT nodes.data FROM edges JOIN nodes ON nodes.id = edges.target_id WHERE edges.case_id = ? AND edges.source_id = ? AND edges.relation = 'VERIFIED_BY' AND nodes.type = 'Verification'")?
            .query_map(params![case_id, solution_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter_map(|data| serde_json::from_str::<Value>(&data).ok())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let successful_automated_verification_count = verifications
        .iter()
        .filter(|data| {
            data.get("kind").and_then(Value::as_str) == Some("automated")
                && data.get("succeeded").and_then(Value::as_bool) == Some(true)
        })
        .count();
    let human_verification_present = verifications.iter().any(|data| {
        data.get("kind").and_then(Value::as_str) == Some("human")
            && data.get("succeeded").and_then(Value::as_bool) == Some(true)
    });
    let human_confirmed = verifications.iter().any(|data| {
        data.get("kind").and_then(Value::as_str) == Some("human")
            && data.get("succeeded").and_then(Value::as_bool) == Some(true)
            && data.get("humanConfirmed").and_then(Value::as_bool) == Some(true)
    });
    let strings = |key: &str| {
        solution
            .as_ref()
            .and_then(|data| data.get(key))
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let evaluation = evaluate_promotion(&PromotionEvidence {
        root_cause_evidence_count,
        root_cause_verified,
        successful_automated_verification_count,
        non_automatable_reason: solution
            .as_ref()
            .and_then(|data| data.get("nonAutomatableReason"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        human_verification_required: solution
            .as_ref()
            .and_then(|data| data.get("humanVerificationRequired"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        human_verification_present,
        human_confirmed,
        applicability: strings("applicability"),
        limitations: strings("limitations"),
        decisive_difference: solution
            .as_ref()
            .and_then(|data| data.get("decisiveDifference"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    });
    if mutate && evaluation.eligible {
        transaction.execute(
            "UPDATE cases SET status = 'verified' WHERE id = ? AND project_id = ?",
            params![case_id, project_id],
        )?;
        if let Some(solution_id) = solution_id {
            transaction.execute(
                "UPDATE nodes SET status = 'verified' WHERE id = ?",
                params![solution_id],
            )?;
        }
    }
    Ok(PromotionStatus {
        status: if evaluation.eligible {
            NodeStatus::Verified
        } else {
            NodeStatus::Candidate
        },
        missing_requirements: evaluation
            .missing_requirements
            .into_iter()
            .map(requirement_text)
            .map(str::to_owned)
            .collect(),
    })
}

fn requirement_text(requirement: PromotionRequirement) -> &'static str {
    match requirement {
        PromotionRequirement::RootCauseEvidence => "root-cause-evidence",
        PromotionRequirement::VerifiedRootCause => "verified-root-cause",
        PromotionRequirement::AutomatedVerificationOrException => {
            "automated-verification-or-exception"
        }
        PromotionRequirement::RequiredHumanVerification => "required-human-verification",
        PromotionRequirement::HumanConfirmation => "human-confirmation",
        PromotionRequirement::Applicability => "applicability",
        PromotionRequirement::Limitations => "limitations",
        PromotionRequirement::DecisiveDifference => "decisive-difference",
    }
}

fn status_text(status: NodeStatus) -> &'static str {
    match status {
        NodeStatus::Open => "open",
        NodeStatus::Candidate => "candidate",
        NodeStatus::Verified => "verified",
        NodeStatus::Regressed => "regressed",
        NodeStatus::Retired => "retired",
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
    transaction: &Connection,
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
        let root = std::fs::canonicalize(root)
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|_| root.to_owned());
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
    transaction: &Connection,
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
    transaction: &Connection,
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

fn replay_operation<T: DeserializeOwned>(
    transaction: &Connection,
    project_id: &str,
    operation_id: Option<&str>,
    kind: &str,
) -> Result<Option<T>, WriteError> {
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
    let result = serde_json::from_str(&result)?;
    Ok(Some(result))
}

fn require_project_path(
    transaction: &Connection,
    project_id: &str,
    path: &str,
) -> Result<(), WriteError> {
    let canonical = transaction.query_row(
        "SELECT canonical_root FROM projects WHERE id = ?",
        params![project_id],
        |row| row.get::<_, String>(0),
    )?;
    let mut roots = vec![canonical];
    roots.extend(
        transaction
            .prepare("SELECT root FROM project_aliases WHERE project_id = ?")?
            .query_map(params![project_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?,
    );
    if roots
        .iter()
        .any(|root| path == root || path.starts_with(&format!("{}/", root.trim_end_matches('/'))))
    {
        Ok(())
    } else {
        Err(WriteError::OwnershipMismatch)
    }
}

fn replay_source(
    transaction: &Connection,
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
    transaction: &Connection,
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
    transaction: &Connection,
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
    transaction: &Connection,
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
    transaction: &Connection,
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
    transaction: &Connection,
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

fn validate_disk_snapshot(snapshot: &DiskSnapshot) -> Result<(), WriteError> {
    if snapshot.entries.len() > 256 || snapshot.scanned_entries > 250_000 {
        return Err(WriteError::Validation("disk snapshot bounds"));
    }
    let mut paths = BTreeSet::new();
    let mut tracked_bytes = 0_u64;
    for entry in &snapshot.entries {
        let relative_path = entry.relative_path.trim();
        if relative_path.is_empty() || relative_path.len() > 4_096 {
            return Err(WriteError::Validation("disk relative path"));
        }
        let path = Path::new(relative_path);
        if path.is_absolute()
            || path.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(WriteError::Validation("disk relative path"));
        }
        if !paths.insert(relative_path.to_owned()) {
            return Err(WriteError::Validation("duplicate disk path"));
        }
        tracked_bytes = tracked_bytes
            .checked_add(entry.bytes)
            .ok_or(WriteError::Validation("disk bytes"))?;
        as_i64(entry.bytes)?;
    }
    if tracked_bytes != snapshot.tracked_bytes {
        return Err(WriteError::Validation("disk tracked bytes"));
    }
    as_i64(snapshot.tracked_bytes)?;
    Ok(())
}

fn validate_disk_capture(capture: &DiskCapture) -> Result<(), WriteError> {
    validate_disk_snapshot(&capture.snapshot)?;
    let stamp_count = capture
        .cache_entries
        .iter()
        .try_fold(0_usize, |total, entry| {
            total.checked_add(entry.directory_stamps.len())
        });
    if capture.cache_entries.len() > 256 || stamp_count.is_none_or(|count| count > 250_000) {
        return Err(WriteError::Validation("disk cache bounds"));
    }
    let snapshots = capture
        .snapshot
        .entries
        .iter()
        .map(|entry| (entry.relative_path.as_str(), (entry.kind, entry.bytes)))
        .collect::<BTreeMap<_, _>>();
    let mut paths = BTreeSet::new();
    for entry in &capture.cache_entries {
        if !paths.insert(entry.relative_path.as_str())
            || snapshots.get(entry.relative_path.as_str()) != Some(&(entry.kind, entry.bytes))
            || entry.directory_stamps.is_empty()
        {
            return Err(WriteError::Validation("disk cache entry"));
        }
        for stamp in &entry.directory_stamps {
            if stamp.relative_path != "." {
                validate_relative_path(&stamp.relative_path)?;
            }
        }
    }
    Ok(())
}

fn store_disk_measurement_cache(
    transaction: &Connection,
    project_id: &str,
    capture: &DiskCapture,
) -> Result<(), WriteError> {
    if capture.cache_entries.is_empty() {
        return Ok(());
    }
    let now = timestamp();
    let current = capture
        .snapshot
        .entries
        .iter()
        .map(|entry| entry.relative_path.as_str())
        .collect::<BTreeSet<_>>();
    for entry in &capture.cache_entries {
        let stamps = serde_json::to_string(&entry.directory_stamps)?;
        if stamps.len() > 16 * 1024 * 1024 {
            return Err(WriteError::Validation("disk cache bytes"));
        }
        transaction.execute(
            "INSERT INTO disk_measurement_cache (project_id,relative_path,kind,bytes,truncated,directory_stamps,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id,relative_path) DO UPDATE SET kind=excluded.kind,bytes=excluded.bytes,truncated=excluded.truncated,directory_stamps=excluded.directory_stamps,updated_at=excluded.updated_at",
            params![
                project_id,
                entry.relative_path,
                disk_kind_text(entry.kind),
                as_i64(entry.bytes)?,
                bool_i64(entry.truncated),
                stamps,
                now,
            ],
        )?;
    }
    if capture.discovery_complete {
        let mut statement = transaction
            .prepare("SELECT relative_path FROM disk_measurement_cache WHERE project_id=?")?;
        let stored = statement
            .query_map([project_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for relative_path in stored {
            if !current.contains(relative_path.as_str()) {
                transaction.execute(
                    "DELETE FROM disk_measurement_cache WHERE project_id=? AND relative_path=?",
                    params![project_id, relative_path],
                )?;
            }
        }
    }
    Ok(())
}

fn validate_relative_path(relative_path: &str) -> Result<(), WriteError> {
    if relative_path.trim().is_empty() || relative_path.len() > 4_096 {
        return Err(WriteError::Validation("disk relative path"));
    }
    let path = Path::new(relative_path);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        Err(WriteError::Validation("disk relative path"))
    } else {
        Ok(())
    }
}

fn as_i64(value: u64) -> Result<i64, WriteError> {
    i64::try_from(value).map_err(|_| WriteError::Validation("disk bytes"))
}

fn signed_delta(final_bytes: u64, baseline_bytes: u64) -> Result<i64, WriteError> {
    let delta = i128::from(final_bytes) - i128::from(baseline_bytes);
    i64::try_from(delta).map_err(|_| WriteError::Validation("disk delta"))
}

fn bool_i64(value: bool) -> i64 {
    i64::from(value)
}

fn disk_kind_text(kind: DiskArtifactKind) -> &'static str {
    match kind {
        DiskArtifactKind::BuildCache => "build-cache",
        DiskArtifactKind::DependencyCache => "dependency-cache",
        DiskArtifactKind::GeneratedOutput => "generated-output",
        DiskArtifactKind::TemporaryOutput => "temporary-output",
    }
}

fn parse_disk_kind(value: &str) -> Option<DiskArtifactKind> {
    match value {
        "build-cache" => Some(DiskArtifactKind::BuildCache),
        "dependency-cache" => Some(DiskArtifactKind::DependencyCache),
        "generated-output" => Some(DiskArtifactKind::GeneratedOutput),
        "temporary-output" => Some(DiskArtifactKind::TemporaryOutput),
        _ => None,
    }
}

fn cleanup_text(disposition: CleanupDisposition) -> &'static str {
    match disposition {
        CleanupDisposition::Eligible => "eligible",
        CleanupDisposition::Review => "review",
        CleanupDisposition::Shared => "shared",
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
        let credential = lower.trim_start_matches('-');
        if ["password:", "token:", "authorization:", "secret:"].contains(&credential) {
            parts.push(part.into());
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
        .any(|prefix| credential.starts_with(prefix))
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
