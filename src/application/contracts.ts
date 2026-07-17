import type { RawLogArtifactMetadata } from '../logs/raw-log-store.js'

// These are wire DTOs shared by the TypeScript adapters and the Rust daemon.
// They intentionally contain no validation, persistence, ranking, or policy logic.
export type NodeType = 'Problem' | 'Attempt' | 'RootCause' | 'Solution' | 'Verification' | 'SuccessCase' | 'Guardrail' | 'Artifact'
export type NodeStatus = 'open' | 'candidate' | 'verified' | 'regressed' | 'retired'
export type RelationType = 'ATTEMPTS_TO_SOLVE' | 'PRECEDED_BY' | 'FAILED_BECAUSE' | 'CAUSES' | 'ADDRESSES' | 'VERIFIED_BY' | 'REFERENCES' | 'INCLUDES' | 'PREVENTS' | 'SUPERSEDES'

export interface ProblemData { summary: string; symptoms?: string[]; firstObservedAt?: string; domain?: string; fingerprint?: string }
export interface AttemptData { hypothesis: string; change: string; outcome: 'failed' | 'succeeded' | 'inconclusive'; command?: string[]; failureExplanation?: string; decisiveDifference?: string }
export interface RootCauseData { explanation: string; evidence: string[]; rejectedAlternatives?: string[]; confidence: number }
export interface SolutionData { summary: string; applicability: string[]; limitations: string[]; sideEffects?: string[]; decisiveDifference: string }
export interface VerificationData { kind: 'automated' | 'human'; succeeded: boolean; humanConfirmed?: boolean; environment?: Record<string, string>; command?: string[]; exitStatus?: number; sourceRevision?: string; excerpt?: string }
export interface GuardrailData { guidance: string; enforcement: 'advise' | 'warn' | 'block'; criteria: { taskIncludes?: string[]; commandIncludes?: string[]; fileIncludes?: string[] } }
export interface ArtifactData { kind: string; uri: string; digest?: string; mediaType?: string }

export interface Project { id: string; name: string; description: string | null; root: string; createdAt: string }
export interface ProjectAlias { id: string; projectId: string; root: string; createdAt: string }
export interface ProjectWithAliases extends Project { aliases: ProjectAlias[] }
export interface KnowledgeEvent { sequence: number; projectId: string; type: string; aggregateId: string; payload: unknown; occurredAt: string }
export interface NodeRecord { id: string; caseId: string; type: NodeType; status: NodeStatus; data: Record<string, unknown>; createdAt: string }
export interface EdgeRecord { id: string; caseId: string; sourceId: string; relation: RelationType; targetId: string; createdAt: string }
export interface CaseSnapshot { id: string; projectId: string; title: string; status: NodeStatus; createdAt: string; nodes: NodeRecord[]; edges: EdgeRecord[] }

export type ImportSource = { kind: 'file'; path: string } | { kind: 'git'; range: string }
export interface PreviewImportInput { project: ProjectReference; sources: ImportSource[] }
export interface ImportProposal { id: string; sourceKey: string; nodeType: NodeType; status: 'candidate'; caseTitle: string; data: Record<string, unknown> }
export interface ImportPreviewResult { previewId: string; projectId: string; parserVersion: string; sourceDigest: string; createdAt: string; expiresAt: string; proposals: ImportProposal[] }
export interface ApplyImportInput { project: ProjectReference; previewId: string; proposalIds: string[]; operationId: string }
export interface ApplyImportResult { previewId: string; proposalIds: string[]; caseIds: string[]; nodeIds: string[]; created: number }

export interface SnapshotCase { id: string; projectId: string; title: string; status: NodeStatus; createdAt: string }
export interface SnapshotNode { id: string; caseId: string; type: NodeType; status: NodeStatus; data: Record<string, unknown>; createdAt: string }
export interface SnapshotEdge { id: string; caseId: string; sourceId: string; relation: RelationType; targetId: string; createdAt: string }
export interface SnapshotEvidence { id: string; projectId: string; nodeId: string; kind: 'automated' | 'human'; command: string[] | null; exitStatus: number | null; data: Record<string, unknown>; createdAt: string }
export interface SnapshotFingerprint { id: string; projectId: string; problemNodeId: string; algorithm: string; value: string; createdAt: string }
export interface SnapshotGuardrail { id: string; projectId: string; nodeId: string; enforcement: 'advise' | 'warn' | 'block'; criteria: Record<string, unknown>; createdAt: string }
export interface SnapshotArtifact { id: string; projectId: string; nodeId: string | null; kind: string; uri: string; digest: string | null; isExternal: boolean; metadata: Record<string, unknown>; createdAt: string }
export type ProjectGraphSnapshotFormat = 'fishbowl' | 'engineering-knowledge-graph'
export interface ProjectGraphSnapshot { format: ProjectGraphSnapshotFormat; version: 1; exportedAt: string; project: { id: string; name: string; description: string | null; createdAt: string }; cases: SnapshotCase[]; nodes: SnapshotNode[]; edges: SnapshotEdge[]; evidence: SnapshotEvidence[]; fingerprints: SnapshotFingerprint[]; guardrails: SnapshotGuardrail[]; artifacts: SnapshotArtifact[] }
export interface ExportProjectGraphInput { project: ProjectReference }
export interface ImportProjectGraphInput { project: ProjectReference; archive: ProjectGraphSnapshot; operationId: string }
export interface ImportProjectGraphResult { sourceProjectId: string; targetProjectId: string; idMap: Record<string, string>; created: { cases: number; nodes: number; edges: number; evidence: number; fingerprints: number; guardrails: number; artifacts: number } }

export interface ProjectReference {
  projectId?: string
  projectRoot?: string
}

export interface OperationIdentity {
  operationId?: string
  sourceKey?: { kind: string; key: string }
}

export interface PromotionStatus {
  status: 'candidate' | 'verified'
  missingRequirements: string[]
}

export interface NodeWriteResult {
  caseId: string
  nodeId: string
  promotion: PromotionStatus
  created: boolean
}

export interface RegisterProjectInput {
  name: string
  root: string
  description?: string
}

export interface UpdateProjectInput {
  project: ProjectReference
  name?: string
  description?: string | null
  addAlias?: string
}

export interface QueryKnowledgeInput {
  project: ProjectReference
  text?: string
  domain?: string
  nodeTypes?: NodeType[]
  statuses?: NodeStatus[]
  file?: string
  command?: string
  fingerprint?: string
  limit?: number
}

export interface KnowledgeQueryItem {
  projectId: string
  caseId: string
  caseTitle: string
  node: NodeRecord
  whyMatched?: RetrievalReason[]
  supportingPath?: string[]
}

export type RetrievalMatchKind =
  | 'exact-text'
  | 'exact-fingerprint'
  | 'exact-file'
  | 'exact-command'
  | 'domain-route'
  | 'prefix-route'
  | 'k-shell-community'
  | 'ppr-path'
  | 'verified-trust'

export interface RetrievalReason {
  kind: RetrievalMatchKind
  value: string
}

export interface RetrievalDiagnostics {
  mode: 'exact' | 'hybrid' | 'exact-fallback'
  seedCount: number
  candidateCaseCount: number
  visitedNodes: number
  visitedEdges: number
  iterations: number
}

export interface KnowledgeQueryResult {
  items: KnowledgeQueryItem[]
  limit: number
  truncated: boolean
  diagnostics?: RetrievalDiagnostics
}

export interface GetCaseInput {
  project: ProjectReference
  caseId: string
  detail?: CaseDetailLevel
  historyLimit?: number
  historyBeforeSequence?: number
}

export type CaseDetailLevel = 'summary' | 'graph' | 'full'

export interface CaseCounts {
  nodes: number
  edges: number
  evidence: number
  artifacts: number
  commandRuns: number
  history: number
}

export interface EvidenceRecord {
  id: string
  projectId: string
  nodeId: string
  kind: 'automated' | 'human'
  command: string[] | null
  exitStatus: number | null
  data: Record<string, unknown>
  createdAt: string
}

export interface ArtifactRecord {
  id: string
  projectId: string
  nodeId: string | null
  kind: string
  uri: string
  digest: string | null
  isExternal: boolean
  metadata: Record<string, unknown>
  createdAt: string
}

export interface CommandRunRecord {
  id: string
  projectId: string
  caseId: string | null
  attemptId: string | null
  command: string[]
  workingDirectory: string
  exitStatus: number | null
  signal: string | null
  durationMs: number
  excerpt: string
  rawLogPath: string | null
  rawLogDigest: string | null
  startedAt: string
  finishedAt: string
}

export interface CaseDetail extends CaseSnapshot {
  detail: CaseDetailLevel
  counts: CaseCounts
  evidence: EvidenceRecord[]
  artifacts: ArtifactRecord[]
  commandRuns: CommandRunRecord[]
  history: KnowledgeEvent[]
  historyNextBeforeSequence: number | null
}

export interface RecentActivityInput {
  project: ProjectReference
  afterSequence?: number
  limit?: number
}

export interface RecentActivityResult {
  events: KnowledgeEvent[]
  limit: number
  truncated: boolean
  nextSequence: number
}

export type DiskArtifactKind = 'build-cache' | 'dependency-cache' | 'generated-output' | 'temporary-output'
export type CleanupDisposition = 'eligible' | 'review' | 'shared'
export interface StartDiskObservationInput { project: ProjectReference; operationId: string; task: string }
export interface StartDiskObservationResult { observationId: string; projectId: string; startedAt: string; baselineTrackedBytes: number; trackedPaths: number; scannedEntries: number; scanTruncated: boolean; cacheHits: number; cacheMisses: number; created: boolean }
export interface FinishDiskObservationInput { project: ProjectReference; operationId: string; observationId: string }
export interface DiskGrowthEntry { relativePath: string; kind: DiskArtifactKind; baselineBytes: number; finalBytes: number; deltaBytes: number; createdByObservation: boolean; cleanupDisposition: CleanupDisposition }
export interface FinishDiskObservationResult { observationId: string; projectId: string; startedAt: string; finishedAt: string; baselineTrackedBytes: number; finalTrackedBytes: number; deltaBytes: number; positiveGrowthBytes: number; overlappingObservations: number; scannedEntries: number; scanTruncated: boolean; cacheHits: number; cacheMisses: number; entries: DiskGrowthEntry[] }
export interface ListDiskObservationsInput { project: ProjectReference; limit?: number }
export interface DiskObservationSummary { observationId: string; task: string; status: string; startedAt: string; finishedAt?: string; baselineTrackedBytes: number; finalTrackedBytes?: number; deltaBytes?: number; positiveGrowthBytes?: number; overlappingObservations: number; scanTruncated: boolean }
export interface ListDiskObservationsResult { observations: DiskObservationSummary[]; limit: number; truncated: boolean }
export interface ListCleanupCandidatesInput { project: ProjectReference; limit?: number }
export interface DiskCleanupCandidate { observationId: string; task: string; relativePath: string; kind: DiskArtifactKind; attributedGrowthBytes: number; reclaimableBytes: number; createdByObservation: boolean; cleanupDisposition: CleanupDisposition; finishedAt: string }
export interface ListCleanupCandidatesResult { candidates: DiskCleanupCandidate[]; limit: number; truncated: boolean }

export interface PreflightInput {
  project: ProjectReference
  taskDescription: string
  changedFiles?: string[]
  command?: string[]
  fingerprint?: string
  limit?: number
  detail?: 'brief' | 'standard' | 'full'
}

export interface PreflightGuardrail {
  node: NodeRecord
  blocks: boolean
}

export interface PreflightMatchReason {
  kind: 'exact-fingerprint' | 'blocking-guardrail' | 'exact-file' | 'exact-command' | 'verified-knowledge' | 'text'
  value: string
}

export interface PreflightCard {
  caseId: string
  caseTitle: string
  score: number
  whyMatched: PreflightMatchReason[]
  failedAttempt?: NodeRecord
  rootCause?: NodeRecord
  solution?: NodeRecord
  guardrails?: PreflightGuardrail[]
}

export interface PreflightResult {
  blocked: boolean
  cards: PreflightCard[]
  guardrails: PreflightGuardrail[]
  failedAttempts: NodeRecord[]
  rootCauses: NodeRecord[]
  solutions: NodeRecord[]
  uncertain: NodeRecord[]
  truncated: boolean
  expansionCaseIds: string[]
}

export interface RecordProblemInput extends OperationIdentity {
  project: ProjectReference
  caseId?: string
  caseTitle?: string
  data: ProblemData
}

export interface RecordAttemptInput extends OperationIdentity {
  project: ProjectReference
  caseId: string
  problemId: string
  previousAttemptId?: string
  data: AttemptData
}

export interface RecordRootCauseInput extends OperationIdentity {
  project: ProjectReference
  caseId: string
  problemId: string
  failedAttemptIds?: string[]
  status?: Extract<NodeStatus, 'candidate' | 'verified'>
  humanConfirmed?: boolean
  data: RootCauseData
}

export interface ServiceSolutionData extends SolutionData {
  applicabilityBoundary?: Record<string, string[]>
  humanVerificationRequired?: boolean
  nonAutomatableReason?: string
}

export interface RecordSolutionInput extends OperationIdentity {
  project: ProjectReference
  caseId: string
  rootCauseId: string
  data: ServiceSolutionData
}

export interface RecordVerificationInput extends OperationIdentity {
  project: ProjectReference
  caseId: string
  solutionId: string
  data: VerificationData
}

export interface RecordArtifactInput extends OperationIdentity {
  project: ProjectReference
  caseId: string
  verificationId: string
  data: ArtifactData
  metadata?: Record<string, unknown>
  isExternal?: boolean
}

export interface ArtifactWriteResult extends NodeWriteResult {
  artifactId: string
}

export interface RecordGuardrailInput extends OperationIdentity {
  project: ProjectReference
  caseId: string
  rootCauseId: string
  status?: Extract<NodeStatus, 'candidate' | 'verified'>
  data: GuardrailData
}

export type CheckpointWrite =
  | { kind: 'problem'; input: Omit<RecordProblemInput, 'project'> }
  | { kind: 'attempt'; input: Omit<RecordAttemptInput, 'project'> }
  | { kind: 'rootCause'; input: Omit<RecordRootCauseInput, 'project'> }
  | { kind: 'solution'; input: Omit<RecordSolutionInput, 'project'> }
  | { kind: 'verification'; input: Omit<RecordVerificationInput, 'project'> }
  | { kind: 'artifact'; input: Omit<RecordArtifactInput, 'project'> }
  | { kind: 'guardrail'; input: Omit<RecordGuardrailInput, 'project'> }

export interface RecordCheckpointInput {
  project: ProjectReference
  operationId: string
  writes: CheckpointWrite[]
}

export interface RecordCheckpointResult {
  results: Array<NodeWriteResult | ArtifactWriteResult>
  created: boolean
}

export interface CheckpointWorkInput {
  project: ProjectReference
  operationId: string
  caseId?: string
  task: string
  outcome: 'failed' | 'succeeded' | 'inconclusive'
  summary: string
  importance?: 'routine' | 'notable' | 'critical'
  fingerprint?: string
  files?: string[]
  command?: string[]
  evidence?: string[]
  rootCause?: { explanation: string; confidence: number; rejectedAlternatives?: string[] }
  solution?: { summary: string; applicability: string[]; limitations: string[]; decisiveDifference: string }
  humanConfirmed?: boolean
}

export interface CheckpointWorkResult {
  recorded: boolean
  reason?: 'routine-success'
  createdCase: boolean
  caseId?: string
  problemId?: string
  attemptId?: string
  rootCauseId?: string
  solutionId?: string
}

export interface FinalizeCommitInput {
  sha: string
  message: string
  branch?: string
}

export interface FinalizeFailedAttemptInput {
  hypothesis: string
  change: string
  failureExplanation: string
  command?: string[]
}

export interface FinalizeRootCauseInput {
  explanation: string
  confidence: number
  evidence: string[]
  rejectedAlternatives?: string[]
}

export interface FinalizeSolutionInput {
  summary: string
  applicability: string[]
  limitations: string[]
  decisiveDifference: string
}

export interface FinalizeVerificationEnvironment {
  destination?: string
  os?: string
  toolVersion?: string
  architecture?: string
  scheme?: string
  configuration?: string
}

export interface FinalizeVerificationInput {
  kind: 'automated' | 'device' | 'human'
  succeeded: boolean
  command?: string[]
  excerpt: string
  environment?: FinalizeVerificationEnvironment
  humanConfirmed?: boolean
}

export interface FinalizeMergeInput {
  status: 'merged' | 'pending' | 'not-required' | 'conflict'
  sourceBranch?: string
  targetBranch?: string
  mergeCommit?: string
  summary?: string
}

export interface FinalizeWorkInput {
  project: ProjectReference
  operationId: string
  caseId?: string
  task: string
  outcome: 'failed' | 'succeeded' | 'inconclusive'
  summary: string
  fingerprint?: string
  files?: string[]
  commit?: FinalizeCommitInput
  failedAttempts?: FinalizeFailedAttemptInput[]
  rootCause?: FinalizeRootCauseInput
  solution?: FinalizeSolutionInput
  verifications?: FinalizeVerificationInput[]
  merge: FinalizeMergeInput
}

export interface FinalizeWorkResult {
  recorded: true
  createdCase: boolean
  caseId: string
  problemId: string
  attemptIds: string[]
  rootCauseId?: string
  solutionId?: string
  verificationIds: string[]
  artifactIds: string[]
  mergeRecorded: boolean
  promotion: PromotionStatus
}

export interface ReportRelevanceInput {
  project: ProjectReference
  caseId: string
  contextDigest: string
  useful: boolean
}

export interface MergeProposal {
  id: string
  projectId: string
  sourceCaseId: string
  targetCaseId: string
  score: number
  reasons: string[]
  status: 'proposed' | 'applied' | 'rejected'
  createdAt: string
  updatedAt: string
}

export interface SuggestCaseMergesInput { project: ProjectReference; limit?: number }
export interface ApplyCaseMergeInput extends OperationIdentity { project: ProjectReference; proposalId: string; operationId: string }

export interface RecordCommandResultInput {
  project: ProjectReference
  commandRunId?: string
  operationId?: string
  caseId?: string
  attemptId?: string
  command: string[]
  workingDirectory: string
  exitStatus?: number | null
  signal?: string | null
  durationMs: number
  excerpt: string
  rawLogPath?: string | null
  rawLogDigest?: string | null
  rawLogArtifact?: RawLogArtifactMetadata | null
  startedAt: string
  finishedAt: string
}

export interface RecordCommandStartedInput {
  project: ProjectReference
  commandRunId: string
  command: string[]
  workingDirectory: string
  startedAt: string
}

export interface CommandStartedResult {
  commandRunId: string
}

export interface CommandResultWriteResult {
  commandRunId: string
  created: boolean
}

export interface CloseCaseInput {
  project: ProjectReference
  caseId: string
  operationId?: string
}

export interface CloseCaseResult {
  caseId: string
  promotion: PromotionStatus
}

export interface MarkRegressionInput {
  project: ProjectReference
  caseId: string
  solutionId: string
  fingerprint: string
  observedContext: Record<string, string>
  operationId?: string
}

export interface RegressionResult {
  outcome: 'regressed' | 'outside-applicability' | 'different-fingerprint'
  caseId: string
}

export type ProjectResult = Project
export type ProjectListResult = ProjectWithAliases[]

export interface KnowledgeServiceContract {
  registerProject(input: RegisterProjectInput): ProjectResult
  listProjects(): ProjectListResult
  resolveProject(reference: ProjectReference): ProjectResult
  updateProject(input: UpdateProjectInput): ProjectWithAliases
  queryKnowledge(input: QueryKnowledgeInput): KnowledgeQueryResult
  getCase(input: GetCaseInput): CaseDetail
  listRecentActivity(input: RecentActivityInput): RecentActivityResult
  preflight(input: PreflightInput): PreflightResult
  recordProblem(input: RecordProblemInput): NodeWriteResult
  recordAttempt(input: RecordAttemptInput): NodeWriteResult
  recordRootCause(input: RecordRootCauseInput): NodeWriteResult
  recordSolution(input: RecordSolutionInput): NodeWriteResult
  recordVerification(input: RecordVerificationInput): NodeWriteResult
  recordArtifactReference(input: RecordArtifactInput): ArtifactWriteResult
  recordGuardrail(input: RecordGuardrailInput): NodeWriteResult
  recordCheckpoint(input: RecordCheckpointInput): RecordCheckpointResult
  checkpointWork(input: CheckpointWorkInput): CheckpointWorkResult
  finalizeWork(input: FinalizeWorkInput): FinalizeWorkResult
  startDiskObservation(input: StartDiskObservationInput): StartDiskObservationResult
  finishDiskObservation(input: FinishDiskObservationInput): FinishDiskObservationResult
  listDiskObservations(input: ListDiskObservationsInput): ListDiskObservationsResult
  listCleanupCandidates(input: ListCleanupCandidatesInput): ListCleanupCandidatesResult
  reportRelevance(input: ReportRelevanceInput): { recorded: true }
  suggestCaseMerges(input: SuggestCaseMergesInput): MergeProposal[]
  applyCaseMerge(input: ApplyCaseMergeInput): MergeProposal
  recordCommandStarted(input: RecordCommandStartedInput): CommandStartedResult
  recordCommandResult(input: RecordCommandResultInput): CommandResultWriteResult
  closeCase(input: CloseCaseInput): CloseCaseResult
  markRegression(input: MarkRegressionInput): RegressionResult
  previewImport(input: PreviewImportInput): ImportPreviewResult
  applyImport(input: ApplyImportInput): ApplyImportResult
  exportProjectGraph(input: ExportProjectGraphInput): ProjectGraphSnapshot
  importProjectGraph(input: ImportProjectGraphInput): ImportProjectGraphResult
}
