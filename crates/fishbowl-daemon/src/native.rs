use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use fishbowl_contracts::{DaemonOperation, ErrorCode, OperationMetricAggregate, ProjectReference};
use fishbowl_storage::{
    DatabaseManager, ReadRepository, StorageError, WriteError, WriteRepository,
};
use serde::Serialize;
use serde_json::{Value, json};

use crate::http::RpcDispatcher;
use crate::protocol::ProtocolError;
use crate::source::{acquire_apply, acquire_preview};

/// Native single-process dispatch boundary. Reads and writes use separate
/// SQLite connections, while each connection is serialized independently.
/// No TypeScript callback is reachable from this type.
pub struct NativeDispatcher {
    reads: Mutex<ReadRepository>,
    writes: Mutex<WriteRepository>,
    metrics: Mutex<DaemonMetrics>,
}

impl NativeDispatcher {
    pub fn open(database_path: &Path) -> Result<Self, ProtocolError> {
        DatabaseManager::open(database_path).map_err(|_| internal())?;
        let path = database_path.to_str().ok_or_else(internal)?;
        Ok(Self {
            reads: Mutex::new(ReadRepository::open(path).map_err(map_storage)?),
            writes: Mutex::new(WriteRepository::open(path).map_err(map_write)?),
            metrics: Mutex::new(DaemonMetrics::new(1_000)),
        })
    }
}

impl RpcDispatcher for NativeDispatcher {
    fn dispatch(&self, operation: &DaemonOperation) -> Result<Value, ProtocolError> {
        if let DaemonOperation::GetOperationMetrics(input) = operation {
            let project_id = self
                .read()?
                .resolve_project_record(&input.project)
                .map_err(map_storage)?
                .id;
            return encode(
                self.metrics
                    .lock()
                    .map_err(|_| internal())?
                    .aggregates(&project_id),
            );
        }
        let started = Instant::now();
        let result = self.dispatch_operation(operation);
        let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let response_bytes = result
            .as_ref()
            .ok()
            .and_then(|value| serde_json::to_vec(value).ok())
            .and_then(|value| u64::try_from(value.len()).ok())
            .unwrap_or(0);
        if let (Some(project_id), Ok(mut metrics)) =
            (self.metric_project_id(operation), self.metrics.lock())
        {
            metrics.record(DaemonMetricSample {
                project_id,
                operation: operation_name(operation),
                error: result.is_err(),
                duration_ms,
                response_bytes,
            });
        }
        result
    }
}

impl NativeDispatcher {
    fn metric_project_id(&self, operation: &DaemonOperation) -> Option<String> {
        let reference = operation_project_reference(operation)?;
        self.read()
            .ok()?
            .resolve_project_record(&reference)
            .ok()
            .map(|project| project.id)
    }

    fn dispatch_operation(&self, operation: &DaemonOperation) -> Result<Value, ProtocolError> {
        match operation {
            DaemonOperation::RegisterProject(input) => encode(
                self.write()?
                    .register_project(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::ListProjects(_) => {
                encode(self.read()?.list_projects().map_err(map_storage)?)
            }
            DaemonOperation::ResolveProject(input) => encode(
                self.read()?
                    .resolve_project_record(input)
                    .map_err(map_storage)?,
            ),
            DaemonOperation::UpdateProject(input) => encode(
                self.write()?
                    .update_project(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::QueryKnowledge(input) => {
                encode(self.read()?.query_knowledge(input).map_err(map_storage)?)
            }
            DaemonOperation::GetOperationResult(input) => encode(
                self.read()?
                    .get_operation_result(input)
                    .map_err(map_storage)?,
            ),
            DaemonOperation::GetOperationMetrics(_) => {
                unreachable!("metrics are handled before dispatch")
            }
            DaemonOperation::Preflight(input) => {
                encode(self.read()?.preflight(input).map_err(map_storage)?)
            }
            DaemonOperation::ListRecentActivity(input) => encode(
                self.read()?
                    .list_recent_activity(input)
                    .map_err(map_storage)?,
            ),
            DaemonOperation::GetCase(input) => {
                encode(self.read()?.get_case(input).map_err(map_storage)?)
            }
            DaemonOperation::RecordProblem(input) => encode(
                self.write()?
                    .record_problem(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::RecordAttempt(input) => encode(
                self.write()?
                    .record_attempt(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::RecordRootCause(input) => encode(
                self.write()?
                    .record_root_cause(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::PromoteRootCause(input) => encode(
                self.write()?
                    .promote_root_cause(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::RecordSolution(input) => encode(
                self.write()?
                    .record_solution(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::RecordVerification(input) => encode(
                self.write()?
                    .record_verification(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::RecordArtifactReference(input) => encode(
                self.write()?
                    .record_artifact(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::RecordGuardrail(input) => encode(
                self.write()?
                    .record_guardrail(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::RecordCheckpoint(input) => encode(
                self.write()?
                    .record_checkpoint(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::CheckpointWork(input) => encode(
                self.write()?
                    .checkpoint_work(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::FinalizeWork(input) => encode(
                self.write()?
                    .finalize_work(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::ReportRelevance(input) => {
                self.write()?
                    .report_relevance(input.clone())
                    .map_err(map_write)?;
                Ok(json!({"recorded": true}))
            }
            DaemonOperation::SuggestCaseMerges(input) => encode(
                self.write()?
                    .suggest_case_merges(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::ApplyCaseMerge(input) => encode(
                self.write()?
                    .apply_case_merge(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::SupersedeSolution(input) => encode(
                self.write()?
                    .supersede_solution(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::RecordCommandStarted(input) => encode(
                self.write()?
                    .record_command_started(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::RecordCommandResult(input) => encode(
                self.write()?
                    .record_command_result(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::CloseCase(input) => {
                encode(self.write()?.close_case(input.clone()).map_err(map_write)?)
            }
            DaemonOperation::MarkRegression(input) => encode(
                self.write()?
                    .mark_regression(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::PreviewImport(input) => {
                let acquired = {
                    let repository = self.read()?;
                    acquire_preview(&repository, input)?
                };
                encode(
                    self.write()?
                        .preview_import_content(acquired)
                        .map_err(map_write)?,
                )
            }
            DaemonOperation::ApplyImport(input) => {
                let acquired = {
                    let repository = self.read()?;
                    acquire_apply(&repository, input)?
                };
                encode(
                    self.write()?
                        .apply_import_content(acquired)
                        .map_err(map_write)?,
                )
            }
            DaemonOperation::ExportProjectGraph(input) => encode(
                self.write()?
                    .export_project_graph(input.clone())
                    .map_err(map_write)?,
            ),
            DaemonOperation::ImportProjectGraph(input) => encode(
                self.write()?
                    .import_project_graph(input.clone())
                    .map_err(map_write)?,
            ),
        }
    }
}

impl NativeDispatcher {
    fn read(&self) -> Result<std::sync::MutexGuard<'_, ReadRepository>, ProtocolError> {
        self.reads.lock().map_err(|_| internal())
    }

    fn write(&self) -> Result<std::sync::MutexGuard<'_, WriteRepository>, ProtocolError> {
        self.writes.lock().map_err(|_| internal())
    }
}

#[derive(Debug, Clone)]
struct DaemonMetricSample {
    project_id: String,
    operation: String,
    error: bool,
    duration_ms: u64,
    response_bytes: u64,
}

struct DaemonMetrics {
    capacity: usize,
    samples: VecDeque<DaemonMetricSample>,
}

impl DaemonMetrics {
    fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            samples: VecDeque::new(),
        }
    }

    fn record(&mut self, sample: DaemonMetricSample) {
        self.samples.push_back(sample);
        while self.samples.len() > self.capacity {
            self.samples.pop_front();
        }
    }

    fn aggregates(&self, project_id: &str) -> Vec<OperationMetricAggregate> {
        let mut grouped = BTreeMap::<&str, Vec<&DaemonMetricSample>>::new();
        for sample in self
            .samples
            .iter()
            .filter(|sample| sample.project_id == project_id)
        {
            grouped.entry(&sample.operation).or_default().push(sample);
        }
        grouped
            .into_iter()
            .map(|(operation, samples)| {
                let mut durations = samples
                    .iter()
                    .map(|sample| sample.duration_ms)
                    .collect::<Vec<_>>();
                durations.sort_unstable();
                OperationMetricAggregate {
                    operation: operation.to_owned(),
                    daemon_phase_detail: "dispatch-total".into(),
                    count: samples.len() as u64,
                    errors: samples.iter().filter(|sample| sample.error).count() as u64,
                    p50_duration_ms: percentile(&durations, 50),
                    p95_duration_ms: percentile(&durations, 95),
                    max_duration_ms: durations.last().copied().unwrap_or(0),
                    max_response_bytes: samples
                        .iter()
                        .map(|sample| sample.response_bytes)
                        .max()
                        .unwrap_or(0),
                    p95_daemon_queue_ms: 0,
                    p95_daemon_execution_ms: percentile(&durations, 95),
                    p95_daemon_serialization_ms: 0,
                    p95_transport_ms: 0,
                    p95_mcp_host_ms: 0,
                }
            })
            .collect()
    }
}

fn percentile(sorted: &[u64], percent: usize) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let index = (sorted.len() * percent).div_ceil(100).saturating_sub(1);
    sorted[index.min(sorted.len() - 1)]
}

fn operation_name(operation: &DaemonOperation) -> String {
    let name = serde_json::to_value(operation)
        .ok()
        .and_then(|value| {
            value
                .get("operation")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "unknown".into());
    let mut result = String::with_capacity(name.len() + 4);
    for character in name.chars() {
        if character.is_ascii_uppercase() {
            result.push('_');
            result.push(character.to_ascii_lowercase());
        } else {
            result.push(character);
        }
    }
    result
}

fn operation_project_reference(operation: &DaemonOperation) -> Option<ProjectReference> {
    let value = serde_json::to_value(operation).ok()?;
    let input = value.get("input")?;
    let reference = input.get("project").unwrap_or(input);
    serde_json::from_value(reference.clone()).ok()
}

fn encode<T: Serialize>(value: T) -> Result<Value, ProtocolError> {
    serde_json::to_value(value).map_err(|_| internal())
}

fn map_storage(error: StorageError) -> ProtocolError {
    match error {
        StorageError::Contract(code) => ProtocolError::new(code, "Request argument is invalid"),
        StorageError::ProjectNotFound => {
            ProtocolError::new(ErrorCode::NotFound, "Project was not found")
        }
        StorageError::Sqlite(_) | StorageError::InvalidStoredData(_) => internal(),
    }
}

fn map_write(error: WriteError) -> ProtocolError {
    match error {
        WriteError::Contract => {
            ProtocolError::new(ErrorCode::InvalidArgument, "Request argument is invalid")
        }
        WriteError::Validation(detail) => ProtocolError::new(
            ErrorCode::ValidationFailed,
            format!("Validation failed: {detail}"),
        ),
        WriteError::ProjectNotFound => {
            ProtocolError::new(ErrorCode::NotFound, "Project was not found")
        }
        WriteError::OwnershipMismatch => ProtocolError::new(
            ErrorCode::OwnershipMismatch,
            "Referenced record does not belong to the project",
        ),
        WriteError::OperationConflict | WriteError::SourceConflict => ProtocolError::new(
            ErrorCode::OperationConflict,
            "Operation identity was already used for different input",
        ),
        WriteError::InjectedFailure(_)
        | WriteError::Sqlite(_)
        | WriteError::Json(_)
        | WriteError::Io(_) => internal(),
    }
}

fn internal() -> ProtocolError {
    ProtocolError::new(ErrorCode::InternalError, "Unexpected service failure")
}

#[cfg(test)]
mod tests {
    use super::{DaemonMetricSample, DaemonMetrics};

    #[test]
    fn daemon_metrics_keep_a_bounded_shared_window() {
        let mut metrics = DaemonMetrics::new(2);
        for (duration_ms, error) in [(1, false), (2, true), (3, false)] {
            metrics.record(DaemonMetricSample {
                project_id: "project-a".into(),
                operation: "query_knowledge".into(),
                error,
                duration_ms,
                response_bytes: duration_ms * 10,
            });
        }
        let aggregate = &metrics.aggregates("project-a")[0];
        assert_eq!(aggregate.count, 2);
        assert_eq!(aggregate.errors, 1);
        assert_eq!(aggregate.p50_duration_ms, 2);
        assert_eq!(aggregate.p95_duration_ms, 3);
        assert_eq!(aggregate.max_response_bytes, 30);
    }

    #[test]
    fn daemon_metrics_never_mix_projects() {
        let mut metrics = DaemonMetrics::new(4);
        for (project_id, duration_ms) in [("project-a", 7), ("project-b", 700)] {
            metrics.record(DaemonMetricSample {
                project_id: project_id.into(),
                operation: "query_knowledge".into(),
                error: false,
                duration_ms,
                response_bytes: duration_ms,
            });
        }

        let project_a = &metrics.aggregates("project-a")[0];
        assert_eq!(project_a.count, 1);
        assert_eq!(project_a.p95_duration_ms, 7);
        let project_b = &metrics.aggregates("project-b")[0];
        assert_eq!(project_b.count, 1);
        assert_eq!(project_b.p95_duration_ms, 700);
        assert!(metrics.aggregates("project-c").is_empty());
    }
}
