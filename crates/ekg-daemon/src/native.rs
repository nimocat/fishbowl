use std::path::Path;
use std::sync::Mutex;

use ekg_contracts::{DaemonOperation, ErrorCode, ProjectReference};
use ekg_storage::{
    DatabaseManager, DiskCapture, ReadRepository, StorageError, WriteError, WriteRepository,
    capture_project_disk_cached,
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
}

impl NativeDispatcher {
    pub fn open(database_path: &Path) -> Result<Self, ProtocolError> {
        DatabaseManager::open(database_path).map_err(|_| internal())?;
        let path = database_path.to_str().ok_or_else(internal)?;
        Ok(Self {
            reads: Mutex::new(ReadRepository::open(path).map_err(map_storage)?),
            writes: Mutex::new(WriteRepository::open(path).map_err(map_write)?),
        })
    }
}

impl RpcDispatcher for NativeDispatcher {
    fn dispatch(&self, operation: &DaemonOperation) -> Result<Value, ProtocolError> {
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
            DaemonOperation::StartDiskObservation(input) => {
                let capture = self.capture_disk(&input.project)?;
                encode(
                    self.write()?
                        .start_disk_observation_capture(input.clone(), capture)
                        .map_err(map_write)?,
                )
            }
            DaemonOperation::FinishDiskObservation(input) => {
                let capture = self.capture_disk(&input.project)?;
                encode(
                    self.write()?
                        .finish_disk_observation_capture(input.clone(), capture)
                        .map_err(map_write)?,
                )
            }
            DaemonOperation::ListDiskObservations(input) => encode(
                self.read()?
                    .list_disk_observations(input)
                    .map_err(map_storage)?,
            ),
            DaemonOperation::ListCleanupCandidates(input) => encode(
                self.read()?
                    .list_cleanup_candidates(input)
                    .map_err(map_storage)?,
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
    fn capture_disk(&self, reference: &ProjectReference) -> Result<DiskCapture, ProtocolError> {
        let (project, cache) = {
            let repository = self.read()?;
            (
                repository
                    .resolve_project_record(reference)
                    .map_err(map_storage)?,
                repository
                    .load_disk_measurement_cache(reference)
                    .map_err(map_storage)?,
            )
        };
        let root = reference.project_root.as_deref().unwrap_or(&project.root);
        capture_project_disk_cached(Path::new(root), &cache).map_err(|_| internal())
    }

    fn read(&self) -> Result<std::sync::MutexGuard<'_, ReadRepository>, ProtocolError> {
        self.reads.lock().map_err(|_| internal())
    }

    fn write(&self) -> Result<std::sync::MutexGuard<'_, WriteRepository>, ProtocolError> {
        self.writes.lock().map_err(|_| internal())
    }
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
        WriteError::Contract | WriteError::Validation(_) => {
            ProtocolError::new(ErrorCode::InvalidArgument, "Request argument is invalid")
        }
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
