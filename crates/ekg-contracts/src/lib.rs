//! Versioned, language-neutral contracts for the Rust daemon boundary.
//!
//! Deserialization is deliberately strict. Semantic size and exclusivity
//! constraints are enforced by [`Validate`] before any request reaches policy
//! or storage code.

use std::collections::BTreeMap;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
const MAX_REQUEST_ID: usize = 200;
const MAX_REFERENCE: usize = 4096;
const MAX_TEXT: usize = 16_384;
const MAX_FILTERS: usize = 100;
const MAX_RESULTS: usize = 1000;

pub trait Validate {
    fn validate(&self) -> Result<(), ErrorCode>;
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidArgument,
    ValidationFailed,
    PayloadTooLarge,
    NotFound,
    Conflict,
    OwnershipMismatch,
    OperationConflict,
    PathOutsideProject,
    InvalidRequest,
    ProtocolMismatch,
    InternalError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorBody {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FailureEnvelope {
    pub ok: False,
    pub request_id: String,
    pub error: ErrorBody,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuccessEnvelope<T> {
    pub ok: True,
    pub request_id: String,
    pub result: T,
}

impl<T: Validate> Validate for SuccessEnvelope<T> {
    fn validate(&self) -> Result<(), ErrorCode> {
        validate_string(&self.request_id, MAX_REQUEST_ID, ErrorCode::InvalidRequest)?;
        self.result.validate()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct True;

impl Serialize for True {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(true)
    }
}

impl<'de> Deserialize<'de> for True {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if bool::deserialize(deserializer)? {
            Ok(Self)
        } else {
            Err(D::Error::custom("expected true"))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct False;

impl Serialize for False {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(false)
    }
}

impl<'de> Deserialize<'de> for False {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if bool::deserialize(deserializer)? {
            Err(D::Error::custom("expected false"))
        } else {
            Ok(Self)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectReference {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub root: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectAliasRecord {
    pub id: String,
    pub project_id: String,
    pub root: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectWithAliasesRecord {
    #[serde(flatten)]
    pub project: ProjectRecord,
    pub aliases: Vec<ProjectAliasRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterProjectInput {
    pub name: String,
    pub root: String,
    pub description: Option<String>,
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateProjectInput {
    pub project: ProjectReference,
    pub name: Option<String>,
    pub description: Option<Option<String>>,
    pub add_alias: Option<String>,
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotProject {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotCase {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub status: NodeStatus,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotNode {
    pub id: String,
    pub case_id: String,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    pub status: NodeStatus,
    pub data: BTreeMap<String, Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotEdge {
    pub id: String,
    pub case_id: String,
    pub source_id: String,
    pub relation: RelationType,
    pub target_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotEvidence {
    pub id: String,
    pub project_id: String,
    pub node_id: String,
    pub kind: EvidenceKind,
    pub command: Option<Vec<String>>,
    pub exit_status: Option<i32>,
    pub data: BTreeMap<String, Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotFingerprint {
    pub id: String,
    pub project_id: String,
    pub problem_node_id: String,
    pub algorithm: String,
    pub value: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotGuardrail {
    pub id: String,
    pub project_id: String,
    pub node_id: String,
    pub enforcement: String,
    pub criteria: BTreeMap<String, Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotArtifact {
    pub id: String,
    pub project_id: String,
    pub node_id: Option<String>,
    pub kind: String,
    pub uri: String,
    pub digest: Option<String>,
    pub is_external: bool,
    pub metadata: BTreeMap<String, Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectGraphSnapshot {
    pub format: String,
    pub version: u32,
    pub exported_at: String,
    pub project: SnapshotProject,
    pub cases: Vec<SnapshotCase>,
    pub nodes: Vec<SnapshotNode>,
    pub edges: Vec<SnapshotEdge>,
    pub evidence: Vec<SnapshotEvidence>,
    pub fingerprints: Vec<SnapshotFingerprint>,
    pub guardrails: Vec<SnapshotGuardrail>,
    pub artifacts: Vec<SnapshotArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportProjectGraphInput {
    pub project: ProjectReference,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportProjectGraphInput {
    pub project: ProjectReference,
    pub archive: ProjectGraphSnapshot,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotCreatedCounts {
    pub cases: usize,
    pub nodes: usize,
    pub edges: usize,
    pub evidence: usize,
    pub fingerprints: usize,
    pub guardrails: usize,
    pub artifacts: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportProjectGraphResult {
    pub source_project_id: String,
    pub target_project_id: String,
    pub id_map: BTreeMap<String, String>,
    pub created: SnapshotCreatedCounts,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportContentSource {
    pub path_hint: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewImportContentInput {
    pub project: ProjectReference,
    pub sources: Vec<ImportContentSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportProposalRecord {
    pub id: String,
    pub source_key: String,
    pub node_type: NodeType,
    pub status: NodeStatus,
    pub case_title: String,
    pub data: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportPreviewResult {
    pub preview_id: String,
    pub project_id: String,
    pub parser_version: String,
    pub source_digest: String,
    pub created_at: String,
    pub expires_at: String,
    pub proposals: Vec<ImportProposalRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyImportContentInput {
    pub project: ProjectReference,
    pub preview_id: String,
    pub proposal_ids: Vec<String>,
    pub operation_id: String,
    pub sources: Vec<ImportContentSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyImportContentResult {
    pub preview_id: String,
    pub proposal_ids: Vec<String>,
    pub case_ids: Vec<String>,
    pub node_ids: Vec<String>,
    pub created: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ImportSourceRequest {
    File { path: String },
    Git { range: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewImportInput {
    pub project: ProjectReference,
    pub sources: Vec<ImportSourceRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyImportInput {
    pub project: ProjectReference,
    pub preview_id: String,
    pub proposal_ids: Vec<String>,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceKey {
    pub kind: String,
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromotionStatus {
    pub status: NodeStatus,
    pub missing_requirements: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeWriteResult {
    pub case_id: String,
    pub node_id: String,
    pub promotion: PromotionStatus,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteProblemData {
    pub summary: String,
    #[serde(default)]
    pub symptoms: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_observed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordProblemInput {
    pub project: ProjectReference,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_key: Option<SourceKey>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub case_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub case_title: Option<String>,
    pub data: WriteProblemData,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteAttemptData {
    pub hypothesis: String,
    pub change: String,
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_explanation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decisive_difference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordAttemptInput {
    pub project: ProjectReference,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_key: Option<SourceKey>,
    pub case_id: String,
    pub problem_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_attempt_id: Option<String>,
    pub data: WriteAttemptData,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordCommandStartedInput {
    pub project: ProjectReference,
    pub command_run_id: String,
    pub command: Vec<String>,
    pub working_directory: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandStartedResult {
    pub command_run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordCommandResultInput {
    pub project: ProjectReference,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub case_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
    pub command: Vec<String>,
    pub working_directory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    pub duration_ms: u64,
    pub excerpt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_log_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_log_digest: Option<String>,
    pub started_at: String,
    pub finished_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandResultWriteResult {
    pub command_run_id: String,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteRootCauseData {
    pub explanation: String,
    pub evidence: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rejected_alternatives: Vec<String>,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordRootCauseInput {
    pub project: ProjectReference,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_key: Option<SourceKey>,
    pub case_id: String,
    pub problem_id: String,
    #[serde(default)]
    pub failed_attempt_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<NodeStatus>,
    #[serde(default)]
    pub human_confirmed: bool,
    pub data: WriteRootCauseData,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteSolutionData {
    pub summary: String,
    pub applicability: Vec<String>,
    pub limitations: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub side_effects: Vec<String>,
    pub decisive_difference: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub applicability_boundary: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub human_verification_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub non_automatable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordSolutionInput {
    pub project: ProjectReference,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_key: Option<SourceKey>,
    pub case_id: String,
    pub root_cause_id: String,
    pub data: WriteSolutionData,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteVerificationData {
    pub kind: String,
    pub succeeded: bool,
    #[serde(default)]
    pub human_confirmed: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub environment: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordVerificationInput {
    pub project: ProjectReference,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_key: Option<SourceKey>,
    pub case_id: String,
    pub solution_id: String,
    pub data: WriteVerificationData,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteArtifactData {
    pub kind: String,
    pub uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordArtifactInput {
    pub project: ProjectReference,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_key: Option<SourceKey>,
    pub case_id: String,
    pub verification_id: String,
    pub data: WriteArtifactData,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
    #[serde(default)]
    pub is_external: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactWriteResult {
    pub case_id: String,
    pub node_id: String,
    pub artifact_id: String,
    pub promotion: PromotionStatus,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteGuardrailCriteria {
    #[serde(default)]
    pub task_includes: Vec<String>,
    #[serde(default)]
    pub command_includes: Vec<String>,
    #[serde(default)]
    pub file_includes: Vec<String>,
    #[serde(default)]
    pub task_includes_any: Vec<String>,
    #[serde(default)]
    pub command_includes_any: Vec<String>,
    #[serde(default)]
    pub file_includes_any: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteGuardrailData {
    pub guidance: String,
    pub enforcement: String,
    pub criteria: WriteGuardrailCriteria,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordGuardrailInput {
    pub project: ProjectReference,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_key: Option<SourceKey>,
    pub case_id: String,
    pub root_cause_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<NodeStatus>,
    pub data: WriteGuardrailData,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseCaseInput {
    pub project: ProjectReference,
    pub case_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseCaseResult {
    pub case_id: String,
    pub promotion: PromotionStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RegressionOutcomeContract {
    Regressed,
    OutsideApplicability,
    DifferentFingerprint,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkRegressionInput {
    pub project: ProjectReference,
    pub case_id: String,
    pub solution_id: String,
    pub fingerprint: String,
    pub observed_context: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegressionResultContract {
    pub outcome: RegressionOutcomeContract,
    pub case_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportRelevanceInput {
    pub project: ProjectReference,
    pub case_id: String,
    pub context_digest: String,
    pub useful: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeProposalContract {
    pub id: String,
    pub project_id: String,
    pub source_case_id: String,
    pub target_case_id: String,
    pub score: f64,
    pub reasons: Vec<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuggestCaseMergesInput {
    pub project: ProjectReference,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyCaseMergeInput {
    pub project: ProjectReference,
    pub proposal_id: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", content = "input", rename_all = "camelCase")]
pub enum CheckpointWrite {
    Problem(CheckpointProblemInput),
    Attempt(CheckpointAttemptInput),
    RootCause(CheckpointRootCauseInput),
    Solution(CheckpointSolutionInput),
    Verification(CheckpointVerificationInput),
    Artifact(CheckpointArtifactInput),
    Guardrail(CheckpointGuardrailInput),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointProblemInput {
    pub operation_id: Option<String>,
    pub source_key: Option<SourceKey>,
    pub case_id: Option<String>,
    pub case_title: Option<String>,
    pub data: WriteProblemData,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointAttemptInput {
    pub operation_id: Option<String>,
    pub source_key: Option<SourceKey>,
    pub case_id: String,
    pub problem_id: String,
    pub previous_attempt_id: Option<String>,
    pub data: WriteAttemptData,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointRootCauseInput {
    pub operation_id: Option<String>,
    pub source_key: Option<SourceKey>,
    pub case_id: String,
    pub problem_id: String,
    #[serde(default)]
    pub failed_attempt_ids: Vec<String>,
    pub status: Option<NodeStatus>,
    #[serde(default)]
    pub human_confirmed: bool,
    pub data: WriteRootCauseData,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointSolutionInput {
    pub operation_id: Option<String>,
    pub source_key: Option<SourceKey>,
    pub case_id: String,
    pub root_cause_id: String,
    pub data: WriteSolutionData,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointVerificationInput {
    pub operation_id: Option<String>,
    pub source_key: Option<SourceKey>,
    pub case_id: String,
    pub solution_id: String,
    pub data: WriteVerificationData,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointArtifactInput {
    pub operation_id: Option<String>,
    pub source_key: Option<SourceKey>,
    pub case_id: String,
    pub verification_id: String,
    pub data: WriteArtifactData,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
    #[serde(default)]
    pub is_external: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointGuardrailInput {
    pub operation_id: Option<String>,
    pub source_key: Option<SourceKey>,
    pub case_id: String,
    pub root_cause_id: String,
    pub status: Option<NodeStatus>,
    pub data: WriteGuardrailData,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordCheckpointInput {
    pub project: ProjectReference,
    pub operation_id: String,
    pub writes: Vec<CheckpointWrite>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum CheckpointWriteResult {
    Node(NodeWriteResult),
    Artifact(ArtifactWriteResult),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordCheckpointResult {
    pub results: Vec<CheckpointWriteResult>,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointWorkInput {
    pub project: ProjectReference,
    pub operation_id: String,
    pub case_id: Option<String>,
    pub task: String,
    pub outcome: String,
    pub summary: String,
    pub importance: Option<String>,
    pub fingerprint: Option<String>,
    #[serde(default)]
    pub files: Vec<String>,
    pub command: Option<Vec<String>>,
    #[serde(default)]
    pub evidence: Vec<String>,
    pub root_cause: Option<CheckpointRootCauseAssertion>,
    pub solution: Option<CheckpointSolutionAssertion>,
    #[serde(default)]
    pub human_confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointRootCauseAssertion {
    pub explanation: String,
    pub confidence: f64,
    #[serde(default)]
    pub rejected_alternatives: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointSolutionAssertion {
    pub summary: String,
    pub applicability: Vec<String>,
    pub limitations: Vec<String>,
    pub decisive_difference: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CheckpointSkipReason {
    RoutineSuccess,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointWorkResult {
    pub recorded: bool,
    pub reason: Option<CheckpointSkipReason>,
    pub created_case: bool,
    pub case_id: Option<String>,
    pub problem_id: Option<String>,
    pub attempt_id: Option<String>,
    pub root_cause_id: Option<String>,
    pub solution_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum DiskArtifactKind {
    BuildCache,
    DependencyCache,
    GeneratedOutput,
    TemporaryOutput,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CleanupDisposition {
    Eligible,
    Review,
    Shared,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartDiskObservationInput {
    pub project: ProjectReference,
    pub operation_id: String,
    pub task: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartDiskObservationResult {
    pub observation_id: String,
    pub project_id: String,
    pub started_at: String,
    pub baseline_tracked_bytes: u64,
    pub tracked_paths: usize,
    pub scanned_entries: usize,
    pub scan_truncated: bool,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinishDiskObservationInput {
    pub project: ProjectReference,
    pub operation_id: String,
    pub observation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiskGrowthEntry {
    pub relative_path: String,
    pub kind: DiskArtifactKind,
    pub baseline_bytes: u64,
    pub final_bytes: u64,
    pub delta_bytes: i64,
    pub created_by_observation: bool,
    pub cleanup_disposition: CleanupDisposition,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinishDiskObservationResult {
    pub observation_id: String,
    pub project_id: String,
    pub started_at: String,
    pub finished_at: String,
    pub baseline_tracked_bytes: u64,
    pub final_tracked_bytes: u64,
    pub delta_bytes: i64,
    pub positive_growth_bytes: u64,
    pub overlapping_observations: usize,
    pub scanned_entries: usize,
    pub scan_truncated: bool,
    pub entries: Vec<DiskGrowthEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListDiskObservationsInput {
    pub project: ProjectReference,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiskObservationSummary {
    pub observation_id: String,
    pub task: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub baseline_tracked_bytes: u64,
    pub final_tracked_bytes: Option<u64>,
    pub delta_bytes: Option<i64>,
    pub positive_growth_bytes: Option<u64>,
    pub overlapping_observations: usize,
    pub scan_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListDiskObservationsResult {
    pub observations: Vec<DiskObservationSummary>,
    pub limit: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListCleanupCandidatesInput {
    pub project: ProjectReference,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiskCleanupCandidate {
    pub observation_id: String,
    pub task: String,
    pub relative_path: String,
    pub kind: DiskArtifactKind,
    pub attributed_growth_bytes: u64,
    pub reclaimable_bytes: u64,
    pub created_by_observation: bool,
    pub cleanup_disposition: CleanupDisposition,
    pub finished_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListCleanupCandidatesResult {
    pub candidates: Vec<DiskCleanupCandidate>,
    pub limit: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinalizeCommitInput {
    pub sha: String,
    pub message: String,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinalizeFailedAttemptInput {
    pub hypothesis: String,
    pub change: String,
    pub failure_explanation: String,
    pub command: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinalizeRootCauseInput {
    pub explanation: String,
    pub confidence: f64,
    pub evidence: Vec<String>,
    #[serde(default)]
    pub rejected_alternatives: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinalizeSolutionInput {
    pub summary: String,
    pub applicability: Vec<String>,
    pub limitations: Vec<String>,
    pub decisive_difference: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinalizeVerificationInput {
    pub kind: String,
    pub succeeded: bool,
    pub command: Option<Vec<String>>,
    pub excerpt: String,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    #[serde(default)]
    pub human_confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinalizeMergeInput {
    pub status: String,
    pub source_branch: Option<String>,
    pub target_branch: Option<String>,
    pub merge_commit: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinalizeWorkInput {
    pub project: ProjectReference,
    pub operation_id: String,
    pub case_id: Option<String>,
    pub task: String,
    pub outcome: String,
    pub summary: String,
    pub fingerprint: Option<String>,
    #[serde(default)]
    pub files: Vec<String>,
    pub commit: Option<FinalizeCommitInput>,
    #[serde(default)]
    pub failed_attempts: Vec<FinalizeFailedAttemptInput>,
    pub root_cause: Option<FinalizeRootCauseInput>,
    pub solution: Option<FinalizeSolutionInput>,
    #[serde(default)]
    pub verifications: Vec<FinalizeVerificationInput>,
    pub merge: FinalizeMergeInput,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinalizeWorkResult {
    pub recorded: bool,
    pub created_case: bool,
    pub case_id: String,
    pub problem_id: String,
    pub attempt_ids: Vec<String>,
    pub root_cause_id: Option<String>,
    pub solution_id: Option<String>,
    pub verification_ids: Vec<String>,
    pub artifact_ids: Vec<String>,
    pub merge_recorded: bool,
    pub promotion: PromotionStatus,
}

impl Validate for ProjectReference {
    fn validate(&self) -> Result<(), ErrorCode> {
        match (&self.project_id, &self.project_root) {
            (Some(id), None) => validate_string(id, MAX_REFERENCE, ErrorCode::InvalidArgument),
            (None, Some(root)) => validate_string(root, MAX_REFERENCE, ErrorCode::InvalidArgument),
            _ => Err(ErrorCode::InvalidArgument),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestEnvelope {
    pub protocol_version: u32,
    pub request_id: String,
    #[serde(flatten)]
    pub operation: DaemonOperation,
}

impl Validate for RequestEnvelope {
    fn validate(&self) -> Result<(), ErrorCode> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(ErrorCode::ProtocolMismatch);
        }
        validate_string(&self.request_id, MAX_REQUEST_ID, ErrorCode::InvalidRequest)?;
        self.operation.validate()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "operation", content = "input")]
pub enum DaemonOperation {
    #[serde(rename = "registerProject")]
    RegisterProject(RegisterProjectInput),
    #[serde(rename = "listProjects")]
    ListProjects(EmptyInput),
    #[serde(rename = "resolveProject")]
    ResolveProject(ProjectReference),
    #[serde(rename = "updateProject")]
    UpdateProject(UpdateProjectInput),
    #[serde(rename = "queryKnowledge")]
    QueryKnowledge(QueryKnowledgeInput),
    #[serde(rename = "preflight")]
    Preflight(PreflightInput),
    #[serde(rename = "getCase")]
    GetCase(GetCaseInput),
    #[serde(rename = "listRecentActivity")]
    ListRecentActivity(RecentActivityInput),
    #[serde(rename = "recordProblem")]
    RecordProblem(RecordProblemInput),
    #[serde(rename = "recordAttempt")]
    RecordAttempt(RecordAttemptInput),
    #[serde(rename = "recordRootCause")]
    RecordRootCause(RecordRootCauseInput),
    #[serde(rename = "recordSolution")]
    RecordSolution(RecordSolutionInput),
    #[serde(rename = "recordVerification")]
    RecordVerification(RecordVerificationInput),
    #[serde(rename = "recordArtifactReference")]
    RecordArtifactReference(RecordArtifactInput),
    #[serde(rename = "recordGuardrail")]
    RecordGuardrail(RecordGuardrailInput),
    #[serde(rename = "recordCheckpoint")]
    RecordCheckpoint(RecordCheckpointInput),
    #[serde(rename = "checkpointWork")]
    CheckpointWork(CheckpointWorkInput),
    #[serde(rename = "finalizeWork")]
    FinalizeWork(FinalizeWorkInput),
    #[serde(rename = "startDiskObservation")]
    StartDiskObservation(StartDiskObservationInput),
    #[serde(rename = "finishDiskObservation")]
    FinishDiskObservation(FinishDiskObservationInput),
    #[serde(rename = "listDiskObservations")]
    ListDiskObservations(ListDiskObservationsInput),
    #[serde(rename = "listCleanupCandidates")]
    ListCleanupCandidates(ListCleanupCandidatesInput),
    #[serde(rename = "reportRelevance")]
    ReportRelevance(ReportRelevanceInput),
    #[serde(rename = "suggestCaseMerges")]
    SuggestCaseMerges(SuggestCaseMergesInput),
    #[serde(rename = "applyCaseMerge")]
    ApplyCaseMerge(ApplyCaseMergeInput),
    #[serde(rename = "recordCommandStarted")]
    RecordCommandStarted(RecordCommandStartedInput),
    #[serde(rename = "recordCommandResult")]
    RecordCommandResult(RecordCommandResultInput),
    #[serde(rename = "closeCase")]
    CloseCase(CloseCaseInput),
    #[serde(rename = "markRegression")]
    MarkRegression(MarkRegressionInput),
    #[serde(rename = "previewImport")]
    PreviewImport(PreviewImportInput),
    #[serde(rename = "applyImport")]
    ApplyImport(ApplyImportInput),
    #[serde(rename = "exportProjectGraph")]
    ExportProjectGraph(ExportProjectGraphInput),
    #[serde(rename = "importProjectGraph")]
    ImportProjectGraph(ImportProjectGraphInput),
}

impl Validate for DaemonOperation {
    fn validate(&self) -> Result<(), ErrorCode> {
        match self {
            Self::QueryKnowledge(value) => value.validate(),
            Self::Preflight(value) => value.validate(),
            Self::GetCase(value) => value.validate(),
            Self::ResolveProject(value) => value.validate(),
            Self::ListRecentActivity(value) => value.validate(),
            Self::StartDiskObservation(value) => value.validate(),
            Self::FinishDiskObservation(value) => value.validate(),
            Self::ListDiskObservations(value) => value.validate(),
            Self::ListCleanupCandidates(value) => value.validate(),
            Self::ListProjects(_) => Ok(()),
            _ => Ok(()),
        }
    }
}

impl Validate for StartDiskObservationInput {
    fn validate(&self) -> Result<(), ErrorCode> {
        self.project.validate()?;
        validate_string(
            &self.operation_id,
            MAX_REQUEST_ID,
            ErrorCode::InvalidArgument,
        )?;
        validate_string(&self.task, MAX_TEXT, ErrorCode::InvalidArgument)
    }
}

impl Validate for FinishDiskObservationInput {
    fn validate(&self) -> Result<(), ErrorCode> {
        self.project.validate()?;
        validate_string(
            &self.operation_id,
            MAX_REQUEST_ID,
            ErrorCode::InvalidArgument,
        )?;
        validate_string(
            &self.observation_id,
            MAX_REFERENCE,
            ErrorCode::InvalidArgument,
        )
    }
}

impl Validate for ListDiskObservationsInput {
    fn validate(&self) -> Result<(), ErrorCode> {
        self.project.validate()?;
        validate_optional_limit(self.limit)
    }
}

impl Validate for ListCleanupCandidatesInput {
    fn validate(&self) -> Result<(), ErrorCode> {
        self.project.validate()?;
        validate_optional_limit(self.limit)
    }
}

fn validate_optional_limit(limit: Option<usize>) -> Result<(), ErrorCode> {
    if limit.is_some_and(|value| value == 0 || value > 100) {
        Err(ErrorCode::PayloadTooLarge)
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct EmptyInput {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecentActivityInput {
    pub project: ProjectReference,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

impl Validate for RecentActivityInput {
    fn validate(&self) -> Result<(), ErrorCode> {
        self.project.validate()?;
        validate_limit(self.limit)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecentActivityResult {
    pub events: Vec<KnowledgeEvent>,
    pub limit: usize,
    pub truncated: bool,
    pub next_sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryKnowledgeInput {
    pub project: ProjectReference,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_types: Option<Vec<NodeType>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statuses: Option<Vec<NodeStatus>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

impl Validate for QueryKnowledgeInput {
    fn validate(&self) -> Result<(), ErrorCode> {
        self.project.validate()?;
        for value in [
            &self.text,
            &self.domain,
            &self.file,
            &self.command,
            &self.fingerprint,
        ]
        .into_iter()
        .flatten()
        {
            validate_string(value, MAX_TEXT, ErrorCode::InvalidArgument)?;
        }
        validate_len(self.node_types.as_deref(), MAX_FILTERS)?;
        validate_len(self.statuses.as_deref(), MAX_FILTERS)?;
        validate_limit(self.limit)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreflightInput {
    pub project: ProjectReference,
    pub task_description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_files: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<DetailLevel>,
}

impl Validate for PreflightInput {
    fn validate(&self) -> Result<(), ErrorCode> {
        self.project.validate()?;
        validate_string(&self.task_description, MAX_TEXT, ErrorCode::InvalidArgument)?;
        validate_string_vec(self.changed_files.as_deref())?;
        validate_string_vec(self.command.as_deref())?;
        if let Some(value) = &self.fingerprint {
            validate_string(value, MAX_TEXT, ErrorCode::InvalidArgument)?;
        }
        validate_limit(self.limit)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetCaseInput {
    pub project: ProjectReference,
    pub case_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<CaseDetailLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_limit: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_before_sequence: Option<u64>,
}

impl Validate for GetCaseInput {
    fn validate(&self) -> Result<(), ErrorCode> {
        self.project.validate()?;
        validate_string(&self.case_id, MAX_REFERENCE, ErrorCode::InvalidArgument)?;
        validate_limit(self.history_limit)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DetailLevel {
    Brief,
    Standard,
    Full,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CaseDetailLevel {
    Summary,
    Graph,
    Full,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum NodeType {
    Problem,
    Attempt,
    RootCause,
    Solution,
    Verification,
    SuccessCase,
    Guardrail,
    Artifact,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NodeStatus {
    Open,
    Candidate,
    Verified,
    Regressed,
    Retired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeRecord {
    pub id: String,
    pub case_id: String,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    pub status: NodeStatus,
    pub data: BTreeMap<String, Value>,
    pub created_at: String,
}

impl Validate for NodeRecord {
    fn validate(&self) -> Result<(), ErrorCode> {
        for value in [&self.id, &self.case_id, &self.created_at] {
            validate_string(value, MAX_REFERENCE, ErrorCode::InvalidRequest)?;
        }
        if self.data.len() > MAX_FILTERS {
            return Err(ErrorCode::PayloadTooLarge);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeQueryItem {
    pub project_id: String,
    pub case_id: String,
    pub case_title: String,
    pub node: NodeRecord,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub why_matched: Vec<RetrievalReason>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub supporting_path: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RetrievalMatchKind {
    ExactText,
    ExactFingerprint,
    ExactFile,
    ExactCommand,
    DomainRoute,
    PrefixRoute,
    KShellCommunity,
    PprPath,
    VerifiedTrust,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetrievalReason {
    pub kind: RetrievalMatchKind,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetrievalDiagnostics {
    pub mode: RetrievalMode,
    pub seed_count: usize,
    pub candidate_case_count: usize,
    pub visited_nodes: usize,
    pub visited_edges: usize,
    pub iterations: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RetrievalMode {
    Exact,
    Hybrid,
    ExactFallback,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryKnowledgeResult {
    pub items: Vec<KnowledgeQueryItem>,
    pub limit: usize,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<RetrievalDiagnostics>,
}

impl Validate for QueryKnowledgeResult {
    fn validate(&self) -> Result<(), ErrorCode> {
        if self.items.len() > MAX_RESULTS || self.limit > MAX_RESULTS {
            return Err(ErrorCode::PayloadTooLarge);
        }
        for item in &self.items {
            item.node.validate()?;
            if item.why_matched.len() > 8 || item.supporting_path.len() > 8 {
                return Err(ErrorCode::PayloadTooLarge);
            }
            for reason in &item.why_matched {
                validate_string(&reason.value, 256, ErrorCode::PayloadTooLarge)?;
            }
            for node_id in &item.supporting_path {
                validate_string(node_id, MAX_REFERENCE, ErrorCode::PayloadTooLarge)?;
            }
        }
        if let Some(diagnostics) = &self.diagnostics {
            if diagnostics.seed_count > 16
                || diagnostics.candidate_case_count > 64
                || diagnostics.visited_nodes > 256
                || diagnostics.visited_edges > 1024
                || diagnostics.iterations > 20
            {
                return Err(ErrorCode::PayloadTooLarge);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreflightGuardrail {
    pub node: NodeRecord,
    pub blocks: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum MatchKind {
    ExactFingerprint,
    BlockingGuardrail,
    ExactFile,
    ExactCommand,
    VerifiedKnowledge,
    Text,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MatchReason {
    pub kind: MatchKind,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreflightCard {
    pub case_id: String,
    pub case_title: String,
    pub score: f64,
    pub why_matched: Vec<MatchReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_attempt: Option<NodeRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_cause: Option<NodeRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solution: Option<NodeRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guardrails: Option<Vec<PreflightGuardrail>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreflightResult {
    pub blocked: bool,
    pub cards: Vec<PreflightCard>,
    pub guardrails: Vec<PreflightGuardrail>,
    pub failed_attempts: Vec<NodeRecord>,
    pub root_causes: Vec<NodeRecord>,
    pub solutions: Vec<NodeRecord>,
    pub uncertain: Vec<NodeRecord>,
    pub truncated: bool,
    pub expansion_case_ids: Vec<String>,
}

impl Validate for PreflightResult {
    fn validate(&self) -> Result<(), ErrorCode> {
        for len in [
            self.cards.len(),
            self.guardrails.len(),
            self.failed_attempts.len(),
            self.root_causes.len(),
            self.solutions.len(),
            self.uncertain.len(),
            self.expansion_case_ids.len(),
        ] {
            if len > MAX_RESULTS {
                return Err(ErrorCode::PayloadTooLarge);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RelationType {
    AttemptsToSolve,
    PrecededBy,
    FailedBecause,
    Causes,
    Addresses,
    VerifiedBy,
    References,
    Includes,
    Prevents,
    Supersedes,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EdgeRecord {
    pub id: String,
    pub case_id: String,
    pub source_id: String,
    pub relation: RelationType,
    pub target_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaseCounts {
    pub nodes: usize,
    pub edges: usize,
    pub evidence: usize,
    pub artifacts: usize,
    pub command_runs: usize,
    pub history: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceRecord {
    pub id: String,
    pub project_id: String,
    pub node_id: String,
    pub kind: EvidenceKind,
    pub command: Option<Vec<String>>,
    pub exit_status: Option<i32>,
    pub data: BTreeMap<String, Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EvidenceKind {
    Automated,
    Human,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactRecord {
    pub id: String,
    pub project_id: String,
    pub node_id: Option<String>,
    pub kind: String,
    pub uri: String,
    pub digest: Option<String>,
    pub is_external: bool,
    pub metadata: BTreeMap<String, Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandRunRecord {
    pub id: String,
    pub project_id: String,
    pub case_id: Option<String>,
    pub attempt_id: Option<String>,
    pub command: Vec<String>,
    pub working_directory: String,
    pub exit_status: Option<i32>,
    pub signal: Option<String>,
    pub duration_ms: u64,
    pub excerpt: String,
    pub raw_log_path: Option<String>,
    pub raw_log_digest: Option<String>,
    pub started_at: String,
    pub finished_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeEvent {
    pub sequence: u64,
    pub project_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub aggregate_id: String,
    pub payload: Value,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetCaseResult {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub status: NodeStatus,
    pub created_at: String,
    pub nodes: Vec<NodeRecord>,
    pub edges: Vec<EdgeRecord>,
    pub detail: CaseDetailLevel,
    pub counts: CaseCounts,
    pub evidence: Vec<EvidenceRecord>,
    pub artifacts: Vec<ArtifactRecord>,
    pub command_runs: Vec<CommandRunRecord>,
    pub history: Vec<KnowledgeEvent>,
    pub history_next_before_sequence: Option<u64>,
}

impl Validate for GetCaseResult {
    fn validate(&self) -> Result<(), ErrorCode> {
        for len in [
            self.nodes.len(),
            self.edges.len(),
            self.evidence.len(),
            self.artifacts.len(),
            self.command_runs.len(),
            self.history.len(),
        ] {
            if len > MAX_RESULTS {
                return Err(ErrorCode::PayloadTooLarge);
            }
        }
        Ok(())
    }
}

fn validate_string(value: &str, max: usize, code: ErrorCode) -> Result<(), ErrorCode> {
    if value.trim().is_empty() || value.len() > max {
        Err(code)
    } else {
        Ok(())
    }
}

fn validate_len<T>(value: Option<&[T]>, max: usize) -> Result<(), ErrorCode> {
    if value.is_some_and(|items| items.len() > max) {
        Err(ErrorCode::PayloadTooLarge)
    } else {
        Ok(())
    }
}

fn validate_string_vec(value: Option<&[String]>) -> Result<(), ErrorCode> {
    validate_len(value, MAX_FILTERS)?;
    for item in value.into_iter().flatten() {
        validate_string(item, MAX_TEXT, ErrorCode::InvalidArgument)?;
    }
    Ok(())
}

fn validate_limit(value: Option<usize>) -> Result<(), ErrorCode> {
    if value.is_some_and(|limit| limit == 0 || limit > MAX_RESULTS) {
        Err(ErrorCode::InvalidArgument)
    } else {
        Ok(())
    }
}
