import type {
  ArtifactData,
  AttemptData,
  GuardrailData,
  ProblemData,
  RootCauseData,
  SolutionData,
  VerificationData,
} from '../domain/node-data.js'
import type { NodeStatus, NodeType } from '../domain/graph-rules.js'
import type { KnowledgeEvent } from '../events/event-journal.js'
import type { Project, ProjectWithAliases } from '../projects/project-registry.js'
import type { CaseSnapshot, NodeRecord } from '../cases/case-graph.js'
import type { RawLogArtifactMetadata } from '../logs/raw-log-store.js'
import type {
  ApplyImportInput,
  ApplyImportResult,
  ImportPreviewResult,
  PreviewImportInput,
} from '../imports/import-service.js'
import type {
  ExportProjectGraphInput,
  ImportProjectGraphInput,
  ImportProjectGraphResult,
  ProjectGraphSnapshot,
} from '../imports/snapshot.js'

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
}

export interface KnowledgeQueryResult {
  items: KnowledgeQueryItem[]
  limit: number
  truncated: boolean
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

export interface PreflightInput {
  project: ProjectReference
  taskDescription: string
  changedFiles?: string[]
  command?: string[]
  fingerprint?: string
  limit?: number
}

export interface PreflightGuardrail {
  node: NodeRecord
  blocks: boolean
}

export interface PreflightResult {
  blocked: boolean
  guardrails: PreflightGuardrail[]
  failedAttempts: NodeRecord[]
  rootCauses: NodeRecord[]
  solutions: NodeRecord[]
  uncertain: NodeRecord[]
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
  recordCommandStarted(input: RecordCommandStartedInput): CommandStartedResult
  recordCommandResult(input: RecordCommandResultInput): CommandResultWriteResult
  closeCase(input: CloseCaseInput): CloseCaseResult
  markRegression(input: MarkRegressionInput): RegressionResult
  previewImport(input: PreviewImportInput): ImportPreviewResult
  applyImport(input: ApplyImportInput): ApplyImportResult
  exportProjectGraph(input: ExportProjectGraphInput): ProjectGraphSnapshot
  importProjectGraph(input: ImportProjectGraphInput): ImportProjectGraphResult
}
