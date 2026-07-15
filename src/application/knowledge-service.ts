import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'

import { CaseGraph, type NodeRecord } from '../cases/case-graph.js'
import {
  AmbiguousProjectReferenceError,
  ProjectConflictError,
  ProjectNotFoundError,
} from '../domain/errors.js'
import { normalizeFingerprint } from '../domain/fingerprint.js'
import type { NodeStatus, NodeType } from '../domain/graph-rules.js'
import { validateNodeData, type NodeDataByType } from '../domain/node-data.js'
import {
  DEFAULT_PAYLOAD_LIMIT_BYTES,
  canonicalizePath,
  evaluateGuardrail,
  evaluatePromotion,
  evaluateRegression,
  isPathWithinBoundary,
  validatePayloadSize,
} from '../domain/policies.js'
import { ProjectRegistry, type Project, type ProjectWithAliases } from '../projects/project-registry.js'
import { boundedRedactedExcerpt, redactArgv, redactSecrets } from '../security/redaction.js'
import {
  ImportService,
  type ApplyImportInput,
  type ApplyImportResult,
  type ImportPreviewResult,
  type PreviewImportInput,
} from '../imports/import-service.js'
import {
  SnapshotService,
  type ExportProjectGraphInput,
  type ImportProjectGraphInput,
  type ImportProjectGraphResult,
  type ProjectGraphSnapshot,
} from '../imports/snapshot.js'
import type {
  ArtifactRecord,
  ArtifactWriteResult,
  CaseDetail,
  CheckpointWorkInput,
  CheckpointWorkResult,
  ApplyCaseMergeInput,
  CloseCaseInput,
  CloseCaseResult,
  CommandResultWriteResult,
  CommandRunRecord,
  EvidenceRecord,
  GetCaseInput,
  KnowledgeQueryResult,
  KnowledgeServiceContract,
  MarkRegressionInput,
  MergeProposal,
  NodeWriteResult,
  OperationIdentity,
  PreflightInput,
  PreflightResult,
  ProjectReference,
  QueryKnowledgeInput,
  RecentActivityInput,
  RecentActivityResult,
  ReportRelevanceInput,
  RecordArtifactInput,
  RecordAttemptInput,
  RecordCommandResultInput,
  RecordCommandStartedInput,
  RecordCheckpointInput,
  RecordCheckpointResult,
  RecordGuardrailInput,
  RecordProblemInput,
  RecordRootCauseInput,
  RecordSolutionInput,
  RecordVerificationInput,
  RegisterProjectInput,
  RegressionResult,
  ServiceSolutionData,
  SuggestCaseMergesInput,
  UpdateProjectInput,
} from './contracts.js'
import {
  buildFtsQuery,
  matchingCandidateCaseIds,
  matchingFingerprintCaseIds,
} from './query-planner.js'
import { compactPreflight, rankCases } from './relevance.js'
import { PreflightCache } from './preflight-cache.js'

const DEFAULT_QUERY_LIMIT = 25
const MAX_QUERY_LIMIT = 100
const MAX_EXCERPT_BYTES = 8 * 1024

export type KnowledgeServiceErrorCode =
  | 'INVALID_ARGUMENT'
  | 'VALIDATION_FAILED'
  | 'PAYLOAD_TOO_LARGE'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'OWNERSHIP_MISMATCH'
  | 'OPERATION_CONFLICT'
  | 'PATH_OUTSIDE_PROJECT'

export class KnowledgeServiceError extends Error {
  constructor(
    public readonly code: KnowledgeServiceErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'KnowledgeServiceError'
  }
}

interface CaseRow {
  id: string
  project_id: string
  title: string
  status: NodeStatus
  created_at: string
}

interface NodeRow {
  id: string
  case_id: string
  type: NodeType
  status: NodeStatus
  data: string
  created_at: string
  project_id?: string
  case_title?: string
}

interface MergeProposalRow {
  id: string
  project_id: string
  source_case_id: string
  target_case_id: string
  score: number
  reasons: string
  status: MergeProposal['status']
  created_at: string
  updated_at: string
}

interface OperationRow {
  kind: string
  result: string
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value)
  }
  if (Array.isArray(value)) {
    return value.map(redactValue)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        typeof entry === 'string' && /^(?:token|password|passwd|secret|api[_-]?key)$/i.test(key)
          ? '[REDACTED]'
          : redactValue(entry),
      ]),
    )
  }
  return value
}

function toNode(row: NodeRow): NodeRecord {
  return {
    id: row.id,
    caseId: row.case_id,
    type: row.type,
    status: row.status,
    data: JSON.parse(row.data) as Record<string, unknown>,
    createdAt: row.created_at,
  }
}

function toMergeProposal(row: MergeProposalRow): MergeProposal {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceCaseId: row.source_case_id,
    targetCaseId: row.target_case_id,
    score: row.score,
    reasons: JSON.parse(row.reasons) as string[],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function titleSimilarity(left: string, right: string): number {
  const tokenize = (value: string) => new Set(
    value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 3),
  )
  const leftTerms = tokenize(left)
  const rightTerms = tokenize(right)
  if (leftTerms.size === 0 || rightTerms.size === 0) return 0
  const intersection = [...leftTerms].filter((term) => rightTerms.has(term)).length
  const union = new Set([...leftTerms, ...rightTerms]).size
  return intersection / union
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_QUERY_LIMIT
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new KnowledgeServiceError('INVALID_ARGUMENT', 'limit must be a positive integer')
  }
  return Math.min(value, MAX_QUERY_LIMIT)
}

export class KnowledgeService implements KnowledgeServiceContract {
  private readonly preflightCache = new PreflightCache<PreflightResult>()
  private readonly projects: ProjectRegistry
  private readonly graph: CaseGraph
  private readonly imports: ImportService
  private readonly snapshots: SnapshotService
  private readonly dataRoot: string | undefined

  constructor(
    private readonly database: Database.Database,
    options: { dataRoot?: string } = {},
  ) {
    this.dataRoot = options.dataRoot
      ? canonicalizePath(options.dataRoot)
      : database.name !== ':memory:'
        ? canonicalizePath(dirname(resolve(database.name)))
        : undefined
    this.projects = new ProjectRegistry(database)
    this.graph = new CaseGraph(database)
    this.imports = new ImportService(database)
    this.snapshots = new SnapshotService(database, { dataRoot: this.dataRoot })
  }

  registerProject(input: RegisterProjectInput): Project {
    this.assertPayload(input)
    return this.translateProjectError(() =>
      this.projects.register({
        ...input,
        name: redactSecrets(input.name),
        description: input.description ? redactSecrets(input.description) : undefined,
      }),
    )
  }

  listProjects(): ProjectWithAliases[] {
    return this.projects.list()
  }

  resolveProject(reference: ProjectReference): Project {
    return this.translateProjectError(() => this.projects.resolve(reference))
  }

  updateProject(input: UpdateProjectInput): ProjectWithAliases {
    this.assertPayload(input)
    const project = this.resolveProject(input.project)
    return this.translateProjectError(() =>
      this.database.transaction(() => {
        if (input.name !== undefined || input.description !== undefined) {
          this.projects.update(project.id, {
            name: input.name === undefined ? undefined : redactSecrets(input.name),
            description:
              input.description === undefined || input.description === null
                ? input.description
                : redactSecrets(input.description),
          })
        }
        if (input.addAlias) {
          this.projects.addAlias(project.id, input.addAlias)
        }
        return this.projects.list().find((candidate) => candidate.id === project.id) as ProjectWithAliases
      })(),
    )
  }

  queryKnowledge(input: QueryKnowledgeInput): KnowledgeQueryResult {
    const project = this.resolveProject(input.project)
    const limit = boundedLimit(input.limit)
    const conditions = ['cases.project_id = ?']
    const parameters: unknown[] = [project.id]
    let searchJoin = ''

    if (input.text?.trim()) {
      searchJoin = 'JOIN node_search ON node_search.node_id = nodes.id'
      const ftsQuery = buildFtsQuery(input.text)
      if (ftsQuery) {
        conditions.push('node_search MATCH ?')
        parameters.push(ftsQuery)
      } else {
        conditions.push('(node_search.title LIKE ? OR node_search.body LIKE ?)')
        const term = `%${input.text.trim()}%`
        parameters.push(term, term)
      }
    }
    if (input.nodeTypes?.length) {
      conditions.push(`nodes.type IN (${input.nodeTypes.map(() => '?').join(', ')})`)
      parameters.push(...input.nodeTypes)
    }
    if (input.statuses?.length) {
      conditions.push(`nodes.status IN (${input.statuses.map(() => '?').join(', ')})`)
      parameters.push(...input.statuses)
    }
    if (input.domain?.trim()) {
      conditions.push(`EXISTS (
        SELECT 1 FROM nodes domain_node
        WHERE domain_node.case_id = cases.id
          AND domain_node.type = 'Problem'
          AND json_extract(domain_node.data, '$.domain') = ?
      )`)
      parameters.push(input.domain.trim())
    }
    if (input.file?.trim()) {
      conditions.push(`EXISTS (
        SELECT 1 FROM nodes file_node
        WHERE file_node.case_id = cases.id AND file_node.data LIKE ?
      )`)
      parameters.push(`%${input.file.trim()}%`)
    }
    if (input.command?.trim()) {
      conditions.push(`(
        EXISTS (SELECT 1 FROM nodes command_node
          WHERE command_node.case_id = cases.id AND command_node.data LIKE ?)
        OR EXISTS (SELECT 1 FROM command_runs
          WHERE command_runs.case_id = cases.id AND command_runs.project_id = cases.project_id
            AND command_runs.command LIKE ?)
      )`)
      parameters.push(`%${input.command.trim()}%`, `%${input.command.trim()}%`)
    }
    if (input.fingerprint?.trim()) {
      const fingerprint = normalizeFingerprint(redactSecrets(input.fingerprint), {
        projectRoots: this.projectRoots(project.id),
      })
      conditions.push(`EXISTS (
        SELECT 1 FROM fingerprints
        JOIN nodes problem_node ON problem_node.id = fingerprints.problem_node_id
        WHERE fingerprints.project_id = cases.project_id
          AND problem_node.case_id = cases.id
          AND fingerprints.value = ?
      )`)
      parameters.push(fingerprint)
    }

    const rows = this.database
      .prepare(
        `SELECT nodes.*, cases.project_id, cases.title AS case_title
         FROM nodes
         JOIN cases ON cases.id = nodes.case_id
         ${searchJoin}
         WHERE ${conditions.join(' AND ')}
         ORDER BY nodes.created_at DESC, nodes.id DESC
         LIMIT ?`,
      )
      .all(...parameters, limit + 1) as NodeRow[]

    return {
      items: rows.slice(0, limit).map((row) => ({
        projectId: row.project_id as string,
        caseId: row.case_id,
        caseTitle: row.case_title as string,
        node: toNode(row),
      })),
      limit,
      truncated: rows.length > limit,
    }
  }

  getCase(input: GetCaseInput): CaseDetail {
    const project = this.resolveProject(input.project)
    const caseRecord = this.requireCase(project.id, input.caseId)
    const detail = input.detail ?? 'graph'
    if (!['summary', 'graph', 'full'].includes(detail)) {
      throw new KnowledgeServiceError('INVALID_ARGUMENT', 'detail must be summary, graph, or full')
    }
    const historyLimit = input.historyLimit === undefined ? 50 : boundedLimit(input.historyLimit)
    const historyBeforeSequence = input.historyBeforeSequence ?? Number.MAX_SAFE_INTEGER
    if (!Number.isSafeInteger(historyBeforeSequence) || historyBeforeSequence < 1) {
      throw new KnowledgeServiceError(
        'INVALID_ARGUMENT',
        'historyBeforeSequence must be a positive safe integer',
      )
    }
    const counts = this.database.prepare(
      `SELECT
        (SELECT count(*) FROM nodes
          JOIN cases node_cases ON node_cases.id = nodes.case_id
          WHERE node_cases.project_id = ? AND nodes.case_id = ?) AS nodes,
        (SELECT count(*) FROM edges
          JOIN cases edge_cases ON edge_cases.id = edges.case_id
          WHERE edge_cases.project_id = ? AND edges.case_id = ?) AS edges,
        (SELECT count(*) FROM evidence
          JOIN nodes ON nodes.id = evidence.node_id
          WHERE evidence.project_id = ? AND nodes.case_id = ?) AS evidence,
        (SELECT count(*) FROM artifacts
          LEFT JOIN nodes ON nodes.id = artifacts.node_id
          WHERE artifacts.project_id = ? AND (nodes.case_id = ? OR artifacts.node_id IS NULL)) AS artifacts,
        (SELECT count(*) FROM command_runs WHERE project_id = ? AND case_id = ?) AS commandRuns,
        (SELECT count(*) FROM events WHERE project_id = ? AND case_id = ?) AS history`,
    ).get(
      project.id,
      input.caseId,
      project.id,
      input.caseId,
      project.id,
      input.caseId,
      project.id,
      input.caseId,
      project.id,
      input.caseId,
      project.id,
      input.caseId,
    ) as CaseDetail['counts']
    const snapshot = detail === 'summary'
      ? {
          id: caseRecord.id,
          projectId: caseRecord.project_id,
          title: caseRecord.title,
          status: caseRecord.status,
          createdAt: caseRecord.created_at,
          nodes: [],
          edges: [],
        }
      : this.graph.getCase(project.id, input.caseId)
    const evidenceRows = detail === 'summary' ? [] : this.database
      .prepare(
        `SELECT evidence.* FROM evidence
         JOIN nodes ON nodes.id = evidence.node_id
         WHERE evidence.project_id = ? AND nodes.case_id = ?
         ORDER BY evidence.created_at, evidence.id LIMIT 500`,
      )
      .all(project.id, input.caseId) as Array<{
        id: string
        project_id: string
        node_id: string
        kind: 'automated' | 'human'
        command: string | null
        exit_status: number | null
        data: string
        created_at: string
      }>
    const artifactRows = detail === 'summary' ? [] : this.database
      .prepare(
        `SELECT artifacts.* FROM artifacts
         LEFT JOIN nodes ON nodes.id = artifacts.node_id
         WHERE artifacts.project_id = ? AND (nodes.case_id = ? OR artifacts.node_id IS NULL)
         ORDER BY artifacts.created_at, artifacts.id LIMIT 500`,
      )
      .all(project.id, input.caseId) as Array<{
        id: string
        project_id: string
        node_id: string | null
        kind: string
        uri: string
        digest: string | null
        is_external: number
        metadata: string
        created_at: string
      }>
    const commandRows = detail === 'summary' ? [] : this.database
      .prepare(
        `SELECT * FROM command_runs
         WHERE project_id = ? AND case_id = ?
         ORDER BY started_at, id LIMIT 500`,
      )
      .all(project.id, input.caseId) as Array<{
        id: string
        project_id: string
        case_id: string | null
        attempt_node_id: string | null
        command: string
        working_directory: string
        exit_status: number | null
        signal: string | null
        duration_ms: number
        excerpt: string
        raw_log_path: string | null
        raw_log_digest: string | null
        started_at: string
        finished_at: string
      }>

    const historyRows = detail === 'full'
      ? this.database.prepare(
        `SELECT * FROM events
         WHERE project_id = ? AND case_id = ? AND sequence < ?
         ORDER BY sequence DESC LIMIT ?`,
      ).all(project.id, input.caseId, historyBeforeSequence, historyLimit + 1) as Array<{
        sequence: number
        project_id: string
        type: string
        aggregate_id: string
        payload: string
        occurred_at: string
      }>
      : []
    const selectedHistory = historyRows.slice(0, historyLimit)

    return {
      ...snapshot,
      detail,
      counts,
      evidence: evidenceRows.map((row): EvidenceRecord => ({
        id: row.id,
        projectId: row.project_id,
        nodeId: row.node_id,
        kind: row.kind,
        command: row.command ? (JSON.parse(row.command) as string[]) : null,
        exitStatus: row.exit_status,
        data: JSON.parse(row.data) as Record<string, unknown>,
        createdAt: row.created_at,
      })),
      artifacts: artifactRows.map((row): ArtifactRecord => ({
        id: row.id,
        projectId: row.project_id,
        nodeId: row.node_id,
        kind: row.kind,
        uri: row.uri,
        digest: row.digest,
        isExternal: row.is_external === 1,
        metadata: JSON.parse(row.metadata) as Record<string, unknown>,
        createdAt: row.created_at,
      })),
      commandRuns: commandRows.map((row): CommandRunRecord => ({
        id: row.id,
        projectId: row.project_id,
        caseId: row.case_id,
        attemptId: row.attempt_node_id,
        command: JSON.parse(row.command) as string[],
        workingDirectory: row.working_directory,
        exitStatus: row.exit_status,
        signal: row.signal,
        durationMs: row.duration_ms,
        excerpt: row.excerpt,
        rawLogPath: row.raw_log_path,
        rawLogDigest: row.raw_log_digest,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      })),
      history: selectedHistory.reverse().map((row) => ({
        sequence: row.sequence,
        projectId: row.project_id,
        type: row.type,
        aggregateId: row.aggregate_id,
        payload: JSON.parse(row.payload) as unknown,
        occurredAt: row.occurred_at,
      })),
      historyNextBeforeSequence:
        historyRows.length > historyLimit
          ? (selectedHistory[0]?.sequence ?? null)
          : null,
    }
  }

  listRecentActivity(input: RecentActivityInput): RecentActivityResult {
    const project = this.resolveProject(input.project)
    const limit = boundedLimit(input.limit)
    const afterSequence = input.afterSequence ?? 0
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new KnowledgeServiceError(
        'INVALID_ARGUMENT',
        'afterSequence must be a non-negative integer',
      )
    }
    const rows = this.database
      .prepare(
        `SELECT * FROM (
           SELECT * FROM events
           WHERE project_id = ? AND sequence > ?
           ORDER BY sequence DESC LIMIT ?
         ) ORDER BY sequence ASC`,
      )
      .all(project.id, afterSequence, limit + 1) as Array<{
        sequence: number
        project_id: string
        type: string
        aggregate_id: string
        payload: string
        occurred_at: string
      }>
    const selected = rows.length > limit ? rows.slice(rows.length - limit) : rows
    const events = selected.map((row) => ({
      sequence: row.sequence,
      projectId: row.project_id,
      type: row.type,
      aggregateId: row.aggregate_id,
      payload: JSON.parse(row.payload) as unknown,
      occurredAt: row.occurred_at,
    }))
    return {
      events,
      limit,
      truncated: rows.length > limit,
      nextSequence: events.at(-1)?.sequence ?? afterSequence,
    }
  }

  preflight(input: PreflightInput): PreflightResult {
    this.assertPayload(input)
    const project = this.resolveProject(input.project)
    const revision = (this.database.prepare(
      'SELECT coalesce(max(sequence), 0) AS revision FROM events WHERE project_id = ?',
    ).get(project.id) as { revision: number }).revision
    const cacheKey = this.preflightCache.key(project.id, revision, {
      taskDescription: input.taskDescription.trim().toLocaleLowerCase(),
      changedFiles: input.changedFiles ?? [],
      command: input.command ?? [],
      fingerprint: input.fingerprint ?? '',
      limit: input.limit ?? 5,
      detail: input.detail ?? 'standard',
    })
    const cached = this.preflightCache.get(cacheKey)
    if (cached) return cached
    const limit = boundedLimit(input.limit)
    const context = [
      input.taskDescription,
      ...(input.changedFiles ?? []),
      ...(input.command ?? []),
      input.fingerprint ?? '',
    ].join(' ').toLocaleLowerCase()
    const textCandidateCaseIds = matchingCandidateCaseIds(
      this.database,
      project.id,
      context,
      1_000,
    )
    const fingerprintCaseIds = input.fingerprint?.trim()
      ? matchingFingerprintCaseIds(
          this.database,
          project.id,
          normalizeFingerprint(redactSecrets(input.fingerprint), {
            projectRoots: this.projectRoots(project.id),
          }),
        )
      : []
    const candidateCaseIds = [...new Set([...textCandidateCaseIds, ...fingerprintCaseIds])]
    const nodes = this.projectNodes(
      project.id,
      candidateCaseIds.length > 0 ? candidateCaseIds : undefined,
      candidateCaseIds.length > 0 ? undefined : 1_000,
    )
    const guardrailRows = this.database
      .prepare(
        `SELECT nodes.*, guardrails.enforcement, guardrails.criteria
         FROM guardrails
         JOIN nodes ON nodes.id = guardrails.node_id
         JOIN cases ON cases.id = nodes.case_id
         WHERE guardrails.project_id = ? AND cases.project_id = ?
         ORDER BY nodes.created_at DESC`,
      )
      .all(project.id, project.id) as Array<NodeRow & {
        enforcement: 'advise' | 'warn' | 'block'
        criteria: string
      }>
    const guardrails = guardrailRows.flatMap((row) => {
      const evaluation = evaluateGuardrail(
        {
          status: row.status,
          enforcement: row.enforcement,
          criteria: JSON.parse(row.criteria) as Record<string, string[]>,
        },
        {
          taskDescription: input.taskDescription,
          command: input.command ?? [],
          changedFiles: input.changedFiles ?? [],
        },
      )
      return evaluation.matches ? [{ node: toNode(row), blocks: evaluation.blocks }] : []
    }).sort((left, right) => Number(right.blocks) - Number(left.blocks))
    const allCaseIds = [...new Set([
      ...nodes.map((node) => node.caseId),
      ...guardrails.map((item) => item.node.caseId),
    ])]
    const caseRows = allCaseIds.length === 0 ? [] : this.database.prepare(
      `SELECT id, title, status FROM cases
       WHERE project_id = ? AND id IN (${allCaseIds.map(() => '?').join(', ')})`,
    ).all(project.id, ...allCaseIds) as Array<{ id: string; title: string; status: NodeStatus }>
    const cards = rankCases({
      taskDescription: input.taskDescription,
      changedFiles: input.changedFiles,
      command: input.command,
      fingerprintCaseIds,
    }, caseRows.map((row) => ({
      caseId: row.id,
      caseTitle: row.title,
      caseStatus: row.status,
      nodes: nodes.filter((node) => node.caseId === row.id),
      guardrails: guardrails.filter((item) => item.node.caseId === row.id),
    }))).slice(0, Math.min(limit, 5))
    const result = compactPreflight({
      blocked: guardrails.some((guardrail) => guardrail.blocks),
      cards,
      guardrails: [],
      failedAttempts: [],
      rootCauses: [],
      solutions: [],
      uncertain: nodes.filter(
        (node) =>
          (node.status === 'open' || node.status === 'candidate') &&
          node.type !== 'Attempt',
      ).slice(0, Math.min(limit, 5)),
    })
    this.preflightCache.set(cacheKey, result)
    return result
  }

  recordCheckpoint(input: RecordCheckpointInput): RecordCheckpointResult {
    const project = this.resolveProject(input.project)
    this.assertPayload(input)
    if (!input.operationId.trim()) {
      throw new KnowledgeServiceError('VALIDATION_FAILED', 'operationId is required')
    }
    if (!Array.isArray(input.writes) || input.writes.length < 1 || input.writes.length > 25) {
      throw new KnowledgeServiceError('VALIDATION_FAILED', 'writes must contain between 1 and 25 items')
    }
    const supportedKinds = new Set([
      'problem', 'attempt', 'rootCause', 'solution', 'verification', 'artifact', 'guardrail',
    ])
    for (const [itemIndex, write] of input.writes.entries()) {
      const rawKind = write && typeof write === 'object' && typeof write.kind === 'string'
        ? write.kind
        : null
      if (!write || typeof write !== 'object' || rawKind === null || !supportedKinds.has(rawKind)
        || !write.input || typeof write.input !== 'object') {
        throw new KnowledgeServiceError('VALIDATION_FAILED', 'checkpoint write is invalid', {
          itemIndex,
          kind: rawKind !== null && supportedKinds.has(rawKind) ? rawKind : 'unknown',
        })
      }
    }
    return this.database.transaction(() => {
      const duplicate = this.readOperation<RecordCheckpointResult>(
        project.id,
        input.operationId,
        'record_checkpoint',
      )
      if (duplicate) return { ...duplicate, created: false }
      const results: RecordCheckpointResult['results'] = []
      for (const [itemIndex, write] of input.writes.entries()) {
        try {
          const scopedProject = { projectId: project.id }
          switch (write.kind) {
            case 'problem':
              results.push(this.recordProblem({ ...write.input, project: scopedProject }))
              break
            case 'attempt':
              results.push(this.recordAttempt({ ...write.input, project: scopedProject }))
              break
            case 'rootCause':
              results.push(this.recordRootCause({ ...write.input, project: scopedProject }))
              break
            case 'solution':
              results.push(this.recordSolution({ ...write.input, project: scopedProject }))
              break
            case 'verification':
              results.push(this.recordVerification({ ...write.input, project: scopedProject }))
              break
            case 'artifact':
              results.push(this.recordArtifactReference({ ...write.input, project: scopedProject }))
              break
            case 'guardrail':
              results.push(this.recordGuardrail({ ...write.input, project: scopedProject }))
              break
          }
        } catch (error) {
          if (error instanceof KnowledgeServiceError) {
            throw new KnowledgeServiceError(error.code, error.message, {
              itemIndex,
              kind: write.kind,
            })
          }
          throw error
        }
      }
      const result: RecordCheckpointResult = { results, created: true }
      this.storeOperation(project.id, input.operationId, 'record_checkpoint', result)
      return result
    })()
  }

  checkpointWork(input: CheckpointWorkInput): CheckpointWorkResult {
    const project = this.resolveProject(input.project)
    this.assertPayload(input)
    if (!input.operationId?.trim() || !input.task?.trim() || !input.summary?.trim()) {
      throw new KnowledgeServiceError('VALIDATION_FAILED', 'operationId, task, and summary are required')
    }
    if (input.importance === 'routine' && input.outcome === 'succeeded') {
      return this.database.transaction(() => {
        const duplicate = this.readOperation<CheckpointWorkResult>(project.id, input.operationId, 'checkpoint_work')
        if (duplicate) return duplicate
        const result: CheckpointWorkResult = { recorded: false, reason: 'routine-success', createdCase: false }
        this.storeOperation(project.id, input.operationId, 'checkpoint_work', result)
        return result
      })()
    }
    return this.database.transaction(() => {
      const duplicate = this.readOperation<CheckpointWorkResult>(project.id, input.operationId, 'checkpoint_work')
      if (duplicate) return duplicate
      const scopedProject = { projectId: project.id }
      let createdCase = false
      let caseId = input.caseId
      let problemId: string
      let previousAttemptId: string | undefined
      if (caseId) {
        const snapshot = this.graph.getCase(project.id, caseId)
        const problem = snapshot.nodes.find((node) => node.type === 'Problem')
        if (!problem) throw new KnowledgeServiceError('NOT_FOUND', 'Case has no Problem node')
        problemId = problem.id
        previousAttemptId = snapshot.nodes
          .filter((node) => node.type === 'Attempt')
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.id
      } else {
        const problem = this.recordProblem({
          project: scopedProject,
          operationId: `${input.operationId}:problem`,
          caseTitle: input.task,
          data: {
            summary: input.task,
            symptoms: [input.summary],
            ...(input.fingerprint && { fingerprint: input.fingerprint }),
          },
        })
        caseId = problem.caseId
        problemId = problem.nodeId
        createdCase = problem.created
      }
      const attempt = this.recordAttempt({
        project: scopedProject,
        operationId: `${input.operationId}:attempt`,
        caseId,
        problemId,
        previousAttemptId,
        data: {
          hypothesis: input.task,
          change: input.summary,
          outcome: input.outcome,
          ...(input.command?.length && { command: input.command }),
          ...(input.outcome === 'failed' && { failureExplanation: input.summary }),
          ...(input.outcome === 'succeeded' && { decisiveDifference: input.summary }),
        },
      })
      let rootCauseId: string | undefined
      if (input.rootCause) {
        const rootCause = this.recordRootCause({
          project: scopedProject,
          operationId: `${input.operationId}:root-cause`,
          caseId,
          problemId,
          failedAttemptIds: input.outcome === 'failed' ? [attempt.nodeId] : [],
          status: 'candidate',
          humanConfirmed: false,
          data: {
            explanation: input.rootCause.explanation,
            confidence: input.rootCause.confidence,
            evidence: input.evidence?.length ? input.evidence : [input.summary],
            rejectedAlternatives: input.rootCause.rejectedAlternatives,
          },
        })
        rootCauseId = rootCause.nodeId
      }
      let solutionId: string | undefined
      if (input.solution) {
        if (!rootCauseId) {
          throw new KnowledgeServiceError('VALIDATION_FAILED', 'solution requires rootCause')
        }
        const solution = this.recordSolution({
          project: scopedProject,
          operationId: `${input.operationId}:solution`,
          caseId,
          rootCauseId,
          data: input.solution,
        })
        solutionId = solution.nodeId
      }
      const result: CheckpointWorkResult = {
        recorded: true,
        createdCase,
        caseId,
        problemId,
        attemptId: attempt.nodeId,
        rootCauseId,
        solutionId,
      }
      this.storeOperation(project.id, input.operationId, 'checkpoint_work', result)
      return result
    })()
  }

  reportRelevance(input: ReportRelevanceInput): { recorded: true } {
    const project = this.resolveProject(input.project)
    this.requireCase(project.id, input.caseId)
    if (!/^[a-f0-9]{64}$/i.test(input.contextDigest)) {
      throw new KnowledgeServiceError('VALIDATION_FAILED', 'contextDigest must be a 64-character hex digest')
    }
    this.database.prepare(
      `INSERT INTO relevance_feedback
       (id, project_id, case_id, context_digest, useful, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), project.id, input.caseId, input.contextDigest.toLocaleLowerCase(), Number(input.useful), new Date().toISOString())
    return { recorded: true }
  }

  suggestCaseMerges(input: SuggestCaseMergesInput): MergeProposal[] {
    const project = this.resolveProject(input.project)
    const limit = Math.min(boundedLimit(input.limit), 25)
    const cases = this.database.prepare(
      `SELECT id, title FROM cases
       WHERE project_id = ? AND status <> 'retired'
       ORDER BY created_at DESC LIMIT 200`,
    ).all(project.id) as Array<{ id: string; title: string }>
    const proposals: MergeProposal[] = []
    const now = new Date().toISOString()
    for (let left = 0; left < cases.length && proposals.length < limit; left += 1) {
      for (let right = left + 1; right < cases.length && proposals.length < limit; right += 1) {
        const source = cases[left] as { id: string; title: string }
        const target = cases[right] as { id: string; title: string }
        const score = titleSimilarity(source.title, target.title)
        if (score < 0.6) continue
        const existing = this.database.prepare(
          `SELECT * FROM case_merge_proposals
           WHERE project_id = ? AND source_case_id = ? AND target_case_id = ?`,
        ).get(project.id, source.id, target.id) as MergeProposalRow | undefined
        if (existing) {
          proposals.push(toMergeProposal(existing))
          continue
        }
        const proposal: MergeProposal = {
          id: randomUUID(), projectId: project.id, sourceCaseId: source.id,
          targetCaseId: target.id, score, reasons: ['similar-case-title'], status: 'proposed',
          createdAt: now, updatedAt: now,
        }
        this.database.prepare(
          `INSERT INTO case_merge_proposals
           (id, project_id, source_case_id, target_case_id, score, reasons, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(proposal.id, project.id, source.id, target.id, score, JSON.stringify(proposal.reasons), proposal.status, now, now)
        proposals.push(proposal)
      }
    }
    return proposals
  }

  applyCaseMerge(input: ApplyCaseMergeInput): MergeProposal {
    const project = this.resolveProject(input.project)
    return this.database.transaction(() => {
      const duplicate = this.readOperation<MergeProposal>(project.id, input.operationId, 'apply_case_merge')
      if (duplicate) return duplicate
      const row = this.database.prepare(
        'SELECT * FROM case_merge_proposals WHERE id = ? AND project_id = ?',
      ).get(input.proposalId, project.id) as MergeProposalRow | undefined
      if (!row) throw new KnowledgeServiceError('NOT_FOUND', 'Merge proposal not found')
      if (row.status === 'rejected') throw new KnowledgeServiceError('INVALID_ARGUMENT', 'Rejected merge proposal cannot be applied')
      const now = new Date().toISOString()
      this.database.prepare("UPDATE cases SET status = 'retired' WHERE id = ? AND project_id = ?")
        .run(row.source_case_id, project.id)
      this.database.prepare(
        `INSERT OR IGNORE INTO case_supersessions
         (project_id, source_case_id, target_case_id, proposal_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(project.id, row.source_case_id, row.target_case_id, row.id, now)
      this.database.prepare(
        "UPDATE case_merge_proposals SET status = 'applied', updated_at = ? WHERE id = ?",
      ).run(now, row.id)
      const result = toMergeProposal({ ...row, status: 'applied', updated_at: now })
      this.appendEvent(project.id, row.target_case_id, 'case.merge.applied', row.id, result)
      this.storeOperation(project.id, input.operationId, 'apply_case_merge', result)
      return result
    })()
  }

  recordProblem(input: RecordProblemInput): NodeWriteResult {
    const project = this.resolveProject(input.project)
    return this.idempotentNodeWrite(project.id, 'record_problem', input, () => {
      const data = this.prepareNodeData('Problem', input.data, project.id)
      const fingerprint = data.fingerprint
      if (fingerprint) {
        const existing = this.database
          .prepare(
            `SELECT nodes.* FROM fingerprints
             JOIN nodes ON nodes.id = fingerprints.problem_node_id
             WHERE fingerprints.project_id = ? AND fingerprints.value = ?`,
          )
          .get(project.id, fingerprint) as NodeRow | undefined
        if (existing) {
          return {
            caseId: existing.case_id,
            nodeId: existing.id,
            promotion: this.evaluateCasePromotion(existing.case_id, false),
            created: false,
          }
        }
      }
      const caseRecord = input.caseId
        ? this.requireCase(project.id, input.caseId)
        : this.graph.createCase(
            project.id,
            redactSecrets(input.caseTitle?.trim() || data.summary),
          )
      const node = this.graph.addNode(caseRecord.id, {
        type: 'Problem',
        status: 'open',
        data,
      })
      this.indexNode(project.id, caseRecord.title, node)
      if (fingerprint) {
        this.database
          .prepare(
            `INSERT INTO fingerprints
             (id, project_id, problem_node_id, algorithm, value, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(randomUUID(), project.id, node.id, 'normalized-v1', fingerprint, new Date().toISOString())
        this.appendEvent(project.id, caseRecord.id, 'fingerprint.recorded', node.id, {
          caseId: caseRecord.id,
          problemId: node.id,
          algorithm: 'normalized-v1',
        })
      }
      return {
        caseId: caseRecord.id,
        nodeId: node.id,
        promotion: this.evaluateCasePromotion(caseRecord.id, false),
        created: true,
      }
    })
  }

  recordAttempt(input: RecordAttemptInput): NodeWriteResult {
    const project = this.resolveProject(input.project)
    return this.idempotentNodeWrite(project.id, 'record_attempt', input, () => {
      const caseRecord = this.requireCase(project.id, input.caseId)
      this.requireNode(project.id, input.caseId, input.problemId, 'Problem')
      if (input.previousAttemptId) {
        this.requireNode(project.id, input.caseId, input.previousAttemptId, 'Attempt')
      }
      const data = this.prepareNodeData('Attempt', input.data, project.id)
      const node = this.graph.addNode(input.caseId, {
        type: 'Attempt',
        status: data.outcome === 'succeeded' ? 'candidate' : 'open',
        data,
      })
      this.graph.addEdge(input.caseId, {
        sourceId: node.id,
        relation: 'ATTEMPTS_TO_SOLVE',
        targetId: input.problemId,
      })
      if (input.previousAttemptId) {
        this.graph.addEdge(input.caseId, {
          sourceId: node.id,
          relation: 'PRECEDED_BY',
          targetId: input.previousAttemptId,
        })
      }
      this.indexNode(project.id, caseRecord.title, node)
      return {
        caseId: input.caseId,
        nodeId: node.id,
        promotion: this.evaluateCasePromotion(input.caseId, true),
        created: true,
      }
    })
  }

  recordRootCause(input: RecordRootCauseInput): NodeWriteResult {
    const project = this.resolveProject(input.project)
    return this.idempotentNodeWrite(project.id, 'record_root_cause', input, () => {
      const caseRecord = this.requireCase(project.id, input.caseId)
      this.requireNode(project.id, input.caseId, input.problemId, 'Problem')
      for (const attemptId of input.failedAttemptIds ?? []) {
        const attempt = this.requireNode(project.id, input.caseId, attemptId, 'Attempt')
        if (attempt.data.outcome !== 'failed') {
          throw new KnowledgeServiceError(
            'VALIDATION_FAILED',
            `Attempt ${attemptId} must have outcome=failed to support a RootCause`,
          )
        }
      }
      if (input.status === 'verified' && input.humanConfirmed !== true) {
        throw new KnowledgeServiceError(
          'VALIDATION_FAILED',
          'humanConfirmed=true is required to record a verified RootCause',
        )
      }
      const data = this.prepareNodeData('RootCause', input.data, project.id)
      const node = this.graph.addNode(input.caseId, {
        type: 'RootCause',
        status: input.status ?? 'candidate',
        data,
      })
      this.graph.addEdge(input.caseId, {
        sourceId: node.id,
        relation: 'CAUSES',
        targetId: input.problemId,
      })
      for (const attemptId of input.failedAttemptIds ?? []) {
        this.graph.addEdge(input.caseId, {
          sourceId: attemptId,
          relation: 'FAILED_BECAUSE',
          targetId: node.id,
        })
      }
      this.indexNode(project.id, caseRecord.title, node)
      return {
        caseId: input.caseId,
        nodeId: node.id,
        promotion: this.evaluateCasePromotion(input.caseId, true),
        created: true,
      }
    })
  }

  recordSolution(input: RecordSolutionInput): NodeWriteResult {
    const project = this.resolveProject(input.project)
    return this.idempotentNodeWrite(project.id, 'record_solution', input, () => {
      const caseRecord = this.requireCase(project.id, input.caseId)
      this.requireNode(project.id, input.caseId, input.rootCauseId, 'RootCause')
      const data = this.prepareNodeData('Solution', input.data, project.id)
      const node = this.graph.addNode(input.caseId, {
        type: 'Solution',
        status: 'candidate',
        data,
      })
      this.graph.addEdge(input.caseId, {
        sourceId: node.id,
        relation: 'ADDRESSES',
        targetId: input.rootCauseId,
      })
      this.indexNode(project.id, caseRecord.title, node)
      return {
        caseId: input.caseId,
        nodeId: node.id,
        promotion: this.evaluateCasePromotion(input.caseId, true),
        created: true,
      }
    })
  }

  recordVerification(input: RecordVerificationInput): NodeWriteResult {
    const project = this.resolveProject(input.project)
    return this.idempotentNodeWrite(project.id, 'record_verification', input, () => {
      const caseRecord = this.requireCase(project.id, input.caseId)
      this.requireNode(project.id, input.caseId, input.solutionId, 'Solution')
      const data = this.prepareNodeData('Verification', input.data, project.id)
      const node = this.graph.addNode(input.caseId, {
        type: 'Verification',
        status: data.succeeded ? 'verified' : 'open',
        data,
      })
      this.graph.addEdge(input.caseId, {
        sourceId: input.solutionId,
        relation: 'VERIFIED_BY',
        targetId: node.id,
      })
      this.database
        .prepare(
          `INSERT INTO evidence
           (id, project_id, node_id, kind, command, exit_status, data, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          project.id,
          node.id,
          data.kind,
          data.command ? JSON.stringify(data.command) : null,
          data.exitStatus ?? null,
          JSON.stringify(data),
          node.createdAt,
        )
      this.appendEvent(project.id, input.caseId, 'verification.recorded', node.id, {
        caseId: input.caseId,
        solutionId: input.solutionId,
        verificationId: node.id,
        kind: data.kind,
        succeeded: data.succeeded,
      })
      this.indexNode(project.id, caseRecord.title, node)
      return {
        caseId: input.caseId,
        nodeId: node.id,
        promotion: this.evaluateCasePromotion(input.caseId, true),
        created: true,
      }
    })
  }

  recordArtifactReference(input: RecordArtifactInput): ArtifactWriteResult {
    const project = this.resolveProject(input.project)
    return this.database.transaction(() => {
      const duplicate = this.readOperation<ArtifactWriteResult>(
        project.id,
        input.operationId,
        'record_artifact',
      )
      if (duplicate) {
        return { ...duplicate, created: false }
      }
      this.assertPayload(input)
      const sourceNode = this.readSourceNode(project.id, input.sourceKey)
      if (sourceNode) {
        const artifact = this.database
          .prepare('SELECT id FROM artifacts WHERE project_id = ? AND node_id = ?')
          .get(project.id, sourceNode.id) as { id: string } | undefined
        if (!artifact) {
          throw new KnowledgeServiceError(
            'OPERATION_CONFLICT',
            'Source key belongs to a non-Artifact node',
          )
        }
        const result: ArtifactWriteResult = {
          caseId: sourceNode.case_id,
          nodeId: sourceNode.id,
          artifactId: artifact.id,
          promotion: this.evaluateCasePromotion(sourceNode.case_id, false),
          created: false,
        }
        this.storeOperation(project.id, input.operationId, 'record_artifact', result)
        return result
      }
      const caseRecord = this.requireCase(project.id, input.caseId)
      this.requireNode(project.id, input.caseId, input.verificationId, 'Verification')
      if (!input.isExternal && !isPathWithinBoundary(input.data.uri, this.projectRoots(project.id))) {
        throw new KnowledgeServiceError(
          'PATH_OUTSIDE_PROJECT',
          'Artifact paths must be inside the selected project unless marked external',
        )
      }
      const data = this.prepareNodeData('Artifact', input.data, project.id)
      const metadata = redactValue(input.metadata ?? {}) as Record<string, unknown>
      const node = this.graph.addNode(input.caseId, {
        type: 'Artifact',
        status: 'candidate',
        data,
      })
      this.graph.addEdge(input.caseId, {
        sourceId: input.verificationId,
        relation: 'REFERENCES',
        targetId: node.id,
      })
      const artifactId = randomUUID()
      this.database
        .prepare(
          `INSERT INTO artifacts
           (id, project_id, node_id, kind, uri, digest, is_external, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifactId,
          project.id,
          node.id,
          data.kind,
          data.uri,
          data.digest ?? null,
          input.isExternal ? 1 : 0,
          JSON.stringify(metadata),
          node.createdAt,
        )
      this.appendEvent(project.id, input.caseId, 'artifact.recorded', artifactId, {
        caseId: input.caseId,
        nodeId: node.id,
        artifactId,
      })
      this.indexNode(project.id, caseRecord.title, node)
      const result: ArtifactWriteResult = {
        caseId: input.caseId,
        nodeId: node.id,
        artifactId,
        promotion: this.evaluateCasePromotion(input.caseId, false),
        created: true,
      }
      this.storeOperation(project.id, input.operationId, 'record_artifact', result)
      this.storeSourceKey(project.id, input.sourceKey, node.id)
      return result
    })()
  }

  recordGuardrail(input: RecordGuardrailInput): NodeWriteResult {
    const project = this.resolveProject(input.project)
    return this.idempotentNodeWrite(project.id, 'record_guardrail', input, () => {
      const caseRecord = this.requireCase(project.id, input.caseId)
      this.requireNode(project.id, input.caseId, input.rootCauseId, 'RootCause')
      const data = this.prepareNodeData('Guardrail', input.data, project.id)
      const node = this.graph.addNode(input.caseId, {
        type: 'Guardrail',
        status: input.status ?? 'candidate',
        data,
      })
      this.graph.addEdge(input.caseId, {
        sourceId: node.id,
        relation: 'PREVENTS',
        targetId: input.rootCauseId,
      })
      this.database
        .prepare(
          `INSERT INTO guardrails
           (id, project_id, node_id, enforcement, criteria, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          project.id,
          node.id,
          data.enforcement,
          JSON.stringify(data.criteria),
          node.createdAt,
        )
      this.appendEvent(project.id, input.caseId, 'guardrail.recorded', node.id, {
        caseId: input.caseId,
        guardrailId: node.id,
        enforcement: data.enforcement,
      })
      this.indexNode(project.id, caseRecord.title, node)
      return {
        caseId: input.caseId,
        nodeId: node.id,
        promotion: this.evaluateCasePromotion(input.caseId, false),
        created: true,
      }
    })
  }

  recordCommandResult(input: RecordCommandResultInput): CommandResultWriteResult {
    const project = this.resolveProject(input.project)
    return this.database.transaction(() => {
      const duplicate = this.readOperation<CommandResultWriteResult>(
        project.id,
        input.operationId,
        'record_command_result',
      )
      if (duplicate) {
        return { ...duplicate, created: false }
      }
      this.assertPayload(input)
      if (!Array.isArray(input.command) || input.command.length === 0 || input.command.some((part) => !part)) {
        throw new KnowledgeServiceError('VALIDATION_FAILED', 'command must contain argv values')
      }
      if (!Number.isInteger(input.durationMs) || input.durationMs < 0) {
        throw new KnowledgeServiceError(
          'VALIDATION_FAILED',
          'durationMs must be a non-negative integer',
        )
      }
      if (!isPathWithinBoundary(input.workingDirectory, this.projectRoots(project.id))) {
        throw new KnowledgeServiceError(
          'PATH_OUTSIDE_PROJECT',
          'workingDirectory must be inside the selected project',
        )
      }
      if (input.caseId) {
        this.requireCase(project.id, input.caseId)
      }
      if (input.attemptId) {
        if (!input.caseId) {
          throw new KnowledgeServiceError(
            'INVALID_ARGUMENT',
            'caseId is required when attemptId is provided',
          )
        }
        this.requireNode(project.id, input.caseId, input.attemptId, 'Attempt')
      }
      const commandRunId = input.commandRunId ?? randomUUID()
      const command = redactArgv(input.command)
      const excerpt = boundedRedactedExcerpt(input.excerpt, MAX_EXCERPT_BYTES)
      const rawLogArtifact = input.rawLogArtifact
      if (rawLogArtifact && (
        rawLogArtifact.kind !== 'command-log' ||
        rawLogArtifact.digestAlgorithm !== 'sha256' ||
        !/^[a-f0-9]{64}$/.test(rawLogArtifact.digest) ||
        !Number.isSafeInteger(rawLogArtifact.byteSize) || rawLogArtifact.byteSize < 0 ||
        !Number.isSafeInteger(rawLogArtifact.retainedByteSize) || rawLogArtifact.retainedByteSize < 0 ||
        rawLogArtifact.retainedByteSize > rawLogArtifact.byteSize ||
        !Array.isArray(rawLogArtifact.paths) || rawLogArtifact.paths.length === 0 ||
        rawLogArtifact.paths.some((path) => typeof path !== 'string' || path.length === 0) ||
        rawLogArtifact.segmentCount !== rawLogArtifact.paths.length ||
        typeof rawLogArtifact.truncated !== 'boolean'
      )) {
        throw new KnowledgeServiceError('VALIDATION_FAILED', 'rawLogArtifact metadata is invalid')
      }
      let legacyPaths: string[] | undefined
      if (!rawLogArtifact && input.rawLogPath) {
        try {
          const parsed = JSON.parse(input.rawLogPath) as unknown
          if (Array.isArray(parsed) && parsed.every((path) => typeof path === 'string' && path.length > 0)) {
            legacyPaths = parsed
          }
        } catch {
          // A legacy single path is stored directly rather than as a JSON array.
        }
        legacyPaths ??= [input.rawLogPath]
      }
      const suppliedPaths = rawLogArtifact?.paths ?? legacyPaths
      const artifactPaths = suppliedPaths?.map((path) => {
        const canonicalPath = canonicalizePath(path)
        if (!isPathWithinBoundary(canonicalPath, this.localArtifactRoots(project.id))) {
          throw new KnowledgeServiceError(
            'PATH_OUTSIDE_PROJECT',
            'Raw log paths must be inside the selected project or service data directory',
          )
        }
        return redactSecrets(canonicalPath)
      })
      const rawLogPath = artifactPaths
        ? rawLogArtifact || artifactPaths.length > 1
          ? JSON.stringify(artifactPaths)
          : artifactPaths[0]!
        : null
      const rawLogDigest = rawLogArtifact?.digest ?? (input.rawLogDigest ? redactSecrets(input.rawLogDigest) : null)
      this.database
        .prepare(
          `INSERT INTO command_runs
           (id, project_id, case_id, attempt_node_id, command, working_directory,
            exit_status, signal, duration_ms, excerpt, raw_log_path, raw_log_digest,
            started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          commandRunId,
          project.id,
          input.caseId ?? null,
          input.attemptId ?? null,
          JSON.stringify(command),
          input.workingDirectory,
          input.exitStatus ?? null,
          input.signal ? redactSecrets(input.signal) : null,
          input.durationMs,
          excerpt,
          rawLogPath,
          rawLogDigest,
          input.startedAt,
          input.finishedAt,
        )
      if (rawLogPath && rawLogDigest) {
        let paths: string[] = []
        try {
          const parsed = JSON.parse(rawLogPath) as unknown
          if (Array.isArray(parsed) && parsed.every((path) => typeof path === 'string')) paths = parsed
        } catch {
          paths = [rawLogPath]
        }
        const artifactId = randomUUID()
        this.database.prepare(
          `INSERT INTO artifacts
           (id, project_id, node_id, kind, uri, digest, is_external, metadata, created_at)
           VALUES (?, ?, NULL, 'command-log', ?, ?, 0, ?, ?)`,
        ).run(
          artifactId,
          project.id,
          paths[0] ?? rawLogPath,
          rawLogDigest,
          JSON.stringify(rawLogArtifact ? {
            commandRunId,
            digestAlgorithm: rawLogArtifact.digestAlgorithm,
            byteSize: rawLogArtifact.byteSize,
            retainedByteSize: rawLogArtifact.retainedByteSize,
            paths,
            segmentCount: rawLogArtifact.segmentCount,
            truncated: rawLogArtifact.truncated,
          } : { commandRunId, paths }),
          input.finishedAt,
        )
        this.appendEvent(project.id, input.caseId ?? null, 'artifact.recorded', artifactId, {
          artifactId,
          commandRunId,
          kind: 'command-log',
        })
      }
      const result: CommandResultWriteResult = { commandRunId, created: true }
      this.appendEvent(project.id, input.caseId ?? null, 'command.recorded', commandRunId, {
        ...result,
        caseId: input.caseId ?? null,
        attemptId: input.attemptId ?? null,
        command,
        exitStatus: input.exitStatus ?? null,
        excerpt,
      })
      this.appendEvent(project.id, input.caseId ?? null, 'command.completed', commandRunId, {
        ...result,
        caseId: input.caseId ?? null,
        exitStatus: input.exitStatus ?? null,
        signal: input.signal ?? null,
      })
      this.storeOperation(project.id, input.operationId, 'record_command_result', result)
      return result
    })()
  }

  recordCommandStarted(input: RecordCommandStartedInput): { commandRunId: string } {
    const project = this.resolveProject(input.project)
    this.assertPayload(input)
    if (!input.commandRunId.trim() || input.command.length === 0) {
      throw new KnowledgeServiceError('VALIDATION_FAILED', 'commandRunId and command are required')
    }
    if (!isPathWithinBoundary(input.workingDirectory, this.projectRoots(project.id))) {
      throw new KnowledgeServiceError('PATH_OUTSIDE_PROJECT', 'workingDirectory must be inside the selected project')
    }
    const result = { commandRunId: redactSecrets(input.commandRunId) }
    this.appendEvent(project.id, null, 'command.started', result.commandRunId, {
      ...result,
      command: redactArgv(input.command),
      workingDirectory: input.workingDirectory,
      startedAt: input.startedAt,
    })
    return result
  }

  closeCase(input: CloseCaseInput): CloseCaseResult {
    const project = this.resolveProject(input.project)
    return this.database.transaction(() => {
      const duplicate = this.readOperation<CloseCaseResult>(
        project.id,
        input.operationId,
        'close_case',
      )
      if (duplicate) {
        return duplicate
      }
      this.assertPayload(input)
      this.requireCase(project.id, input.caseId)
      const promotion = this.evaluateCasePromotion(input.caseId, true)
      const result = { caseId: input.caseId, promotion }
      this.appendEvent(project.id, input.caseId, 'case.closed', input.caseId, result)
      this.storeOperation(project.id, input.operationId, 'close_case', result)
      return result
    })()
  }

  markRegression(input: MarkRegressionInput): RegressionResult {
    const project = this.resolveProject(input.project)
    return this.database.transaction(() => {
      const duplicate = this.readOperation<RegressionResult>(
        project.id,
        input.operationId,
        'mark_regression',
      )
      if (duplicate) {
        return duplicate
      }
      this.assertPayload(input)
      this.requireCase(project.id, input.caseId)
      const solution = this.requireNode(
        project.id,
        input.caseId,
        input.solutionId,
        'Solution',
      )
      if (solution.status !== 'verified') {
        throw new KnowledgeServiceError('VALIDATION_FAILED', 'Only a verified Solution can regress')
      }
      const storedFingerprint = this.database
        .prepare(
          `SELECT fingerprints.value FROM fingerprints
           JOIN nodes ON nodes.id = fingerprints.problem_node_id
           WHERE fingerprints.project_id = ? AND nodes.case_id = ?
           ORDER BY fingerprints.created_at LIMIT 1`,
        )
        .get(project.id, input.caseId) as { value: string } | undefined
      const observedFingerprint = normalizeFingerprint(redactSecrets(input.fingerprint), {
        projectRoots: this.projectRoots(project.id),
      })
      const solutionData = solution.data as unknown as ServiceSolutionData
      const outcome = evaluateRegression({
        fingerprintMatches: storedFingerprint?.value === observedFingerprint,
        applicabilityBoundary: solutionData.applicabilityBoundary ?? {},
        observedContext: input.observedContext,
      })
      const result: RegressionResult = { outcome, caseId: input.caseId }
      if (outcome === 'regressed') {
        this.setNodeStatus(project.id, solution.id, 'regressed')
        this.setCaseStatus(project.id, input.caseId, 'regressed')
        this.appendEvent(project.id, input.caseId, 'case.regressed', input.caseId, {
          ...result,
          solutionId: solution.id,
          observedContext: redactValue(input.observedContext),
        })
      }
      this.storeOperation(project.id, input.operationId, 'mark_regression', result)
      return result
    })()
  }

  previewImport(input: PreviewImportInput): ImportPreviewResult {
    return this.imports.preview(input)
  }

  applyImport(input: ApplyImportInput): ApplyImportResult {
    return this.imports.apply(input)
  }

  exportProjectGraph(input: ExportProjectGraphInput): ProjectGraphSnapshot {
    return this.snapshots.exportProject(input)
  }

  importProjectGraph(input: ImportProjectGraphInput): ImportProjectGraphResult {
    return this.snapshots.importProject(input)
  }

  private idempotentNodeWrite<T extends OperationIdentity>(
    projectId: string,
    kind: string,
    input: T,
    write: () => NodeWriteResult,
  ): NodeWriteResult {
    return this.database.transaction(() => {
      const duplicate = this.readOperation<NodeWriteResult>(projectId, input.operationId, kind)
      if (duplicate) {
        return { ...duplicate, created: false }
      }
      this.assertPayload(input)
      const sourceNode = this.readSourceNode(projectId, input.sourceKey)
      if (sourceNode) {
        const expectedType: Record<string, NodeType> = {
          record_problem: 'Problem',
          record_attempt: 'Attempt',
          record_root_cause: 'RootCause',
          record_solution: 'Solution',
          record_verification: 'Verification',
          record_guardrail: 'Guardrail',
        }
        if (sourceNode.type !== expectedType[kind]) {
          throw new KnowledgeServiceError(
            'OPERATION_CONFLICT',
            `Source key belongs to a ${sourceNode.type}, not a ${expectedType[kind]}`,
          )
        }
        return {
          caseId: sourceNode.case_id,
          nodeId: sourceNode.id,
          promotion: this.evaluateCasePromotion(sourceNode.case_id, false),
          created: false,
        }
      }
      const result = write()
      this.storeOperation(projectId, input.operationId, kind, result)
      this.storeSourceKey(projectId, input.sourceKey, result.nodeId)
      return result
    })()
  }

  private prepareNodeData<T extends NodeType>(
    type: T,
    input: NodeDataByType[T] | ServiceSolutionData,
    projectId: string,
  ): NodeDataByType[T] & Record<string, unknown> {
    this.assertPayload(input)
    const redacted = redactValue(input) as Record<string, unknown>
    if ((type === 'Attempt' || type === 'Verification') && Array.isArray(redacted.command)) {
      redacted.command = redactArgv(redacted.command.filter((part): part is string => typeof part === 'string'))
    }
    if (type === 'Verification' && typeof redacted.excerpt === 'string') {
      redacted.excerpt = boundedRedactedExcerpt(redacted.excerpt, MAX_EXCERPT_BYTES)
    }
    if (type === 'Problem' && typeof redacted.fingerprint === 'string') {
      redacted.fingerprint = normalizeFingerprint(redacted.fingerprint, {
        projectRoots: this.projectRoots(projectId),
      })
    }
    const validation = validateNodeData(type, redacted)
    if (!validation.valid) {
      throw new KnowledgeServiceError(
        'VALIDATION_FAILED',
        `Invalid ${type} payload`,
        validation.issues,
      )
    }
    return validation.data as NodeDataByType[T] & Record<string, unknown>
  }

  private evaluateCasePromotion(caseId: string, mutate: boolean): CloseCaseResult['promotion'] {
    const solutionRow = this.database
      .prepare(
        `SELECT * FROM nodes
         WHERE case_id = ? AND type = 'Solution' AND status <> 'regressed'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(caseId) as NodeRow | undefined
    if (!solutionRow) {
      if (mutate) {
        const caseRecord = this.database.prepare('SELECT project_id, status FROM cases WHERE id = ?').get(caseId) as {
          project_id: string
          status: NodeStatus
        }
        if (caseRecord.status !== 'regressed') {
          this.setCaseStatus(caseRecord.project_id, caseId, 'candidate')
        }
      }
      return {
        status: 'candidate',
        missingRequirements: evaluatePromotion({
          rootCauseEvidenceCount: 0,
          rootCauseVerified: false,
          successfulAutomatedVerificationCount: 0,
          nonAutomatableReason: null,
          humanVerificationRequired: false,
          humanVerificationPresent: false,
          humanConfirmed: false,
          applicability: [],
          limitations: [],
          decisiveDifference: '',
        }).missingRequirements,
      }
    }
    const solution = toNode(solutionRow)
    const solutionData = solution.data as unknown as ServiceSolutionData
    const causeRow = this.database
      .prepare(
        `SELECT target.* FROM edges
         JOIN nodes target ON target.id = edges.target_id
         WHERE edges.case_id = ? AND edges.source_id = ? AND edges.relation = 'ADDRESSES'
         LIMIT 1`,
      )
      .get(caseId, solution.id) as NodeRow | undefined
    const causeData = causeRow
      ? (JSON.parse(causeRow.data) as NodeDataByType['RootCause'])
      : undefined
    const verificationRows = this.database
      .prepare(
        `SELECT verification.* FROM edges
         JOIN nodes verification ON verification.id = edges.target_id
         WHERE edges.case_id = ? AND edges.source_id = ?
           AND edges.relation = 'VERIFIED_BY'`,
      )
      .all(caseId, solution.id) as NodeRow[]
    const verifications = verificationRows.map(
      (row) => JSON.parse(row.data) as NodeDataByType['Verification'],
    )
    const successfulAttemptRow = this.database
      .prepare(
        `SELECT data FROM nodes
         WHERE case_id = ? AND type = 'Attempt'
           AND json_extract(data, '$.outcome') = 'succeeded'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(caseId) as { data: string } | undefined
    const successfulAttempt = successfulAttemptRow
      ? (JSON.parse(successfulAttemptRow.data) as NodeDataByType['Attempt'])
      : undefined
    const evaluation = evaluatePromotion({
      rootCauseEvidenceCount: causeData?.evidence.length ?? 0,
      rootCauseVerified: causeRow?.status === 'verified',
      successfulAutomatedVerificationCount: verifications.filter(
        (verification) => verification.kind === 'automated' && verification.succeeded,
      ).length,
      nonAutomatableReason: solutionData.nonAutomatableReason ?? null,
      humanVerificationRequired: solutionData.humanVerificationRequired ?? false,
      humanVerificationPresent: verifications.some(
        (verification) => verification.kind === 'human' && verification.succeeded,
      ),
      humanConfirmed: verifications.some(
        (verification) => verification.kind === 'human' && verification.succeeded && verification.humanConfirmed === true,
      ),
      applicability: solutionData.applicability,
      limitations: solutionData.limitations,
      decisiveDifference: successfulAttempt?.decisiveDifference ?? '',
    })
    if (mutate) {
      const caseRecord = this.database.prepare('SELECT project_id, title FROM cases WHERE id = ?').get(caseId) as {
        project_id: string
        title: string
      }
      if (evaluation.eligible) {
        this.promoteCase(caseRecord.project_id, caseId, solution.id, caseRecord.title)
      } else {
        this.setCaseStatus(caseRecord.project_id, caseId, 'candidate')
      }
    }
    return {
      status: evaluation.eligible ? 'verified' : 'candidate',
      missingRequirements: evaluation.missingRequirements,
    }
  }

  private promoteCase(
    projectId: string,
    caseId: string,
    solutionId: string,
    caseTitle: string,
  ): void {
    this.setNodeStatus(projectId, solutionId, 'verified')
    this.setCaseStatus(projectId, caseId, 'verified')
    let successCase = this.database
      .prepare("SELECT * FROM nodes WHERE case_id = ? AND type = 'SuccessCase' LIMIT 1")
      .get(caseId) as NodeRow | undefined
    if (!successCase) {
      const node = this.graph.addNode(caseId, {
        type: 'SuccessCase',
        status: 'verified',
        data: { summary: `Verified path for ${caseTitle}` },
      })
      this.indexNode(projectId, caseTitle, node)
      successCase = this.database.prepare('SELECT * FROM nodes WHERE id = ?').get(node.id) as NodeRow
    }
    const included = new Set(
      (this.database
        .prepare("SELECT target_id FROM edges WHERE source_id = ? AND relation = 'INCLUDES'")
        .all(successCase.id) as Array<{ target_id: string }>).map((row) => row.target_id),
    )
    const nodes = this.database
      .prepare(
        `SELECT id FROM nodes
         WHERE case_id = ? AND type IN ('Problem', 'Attempt', 'RootCause', 'Solution', 'Verification')
         ORDER BY rowid`,
      )
      .all(caseId) as Array<{ id: string }>
    for (const node of nodes) {
      if (!included.has(node.id)) {
        this.graph.addEdge(caseId, {
          sourceId: successCase.id,
          relation: 'INCLUDES',
          targetId: node.id,
        })
      }
    }
  }

  private requireCase(projectId: string, caseId: string): CaseRow {
    const row = this.database.prepare('SELECT * FROM cases WHERE id = ?').get(caseId) as
      | CaseRow
      | undefined
    if (!row) {
      throw new KnowledgeServiceError('NOT_FOUND', `Case not found: ${caseId}`)
    }
    if (row.project_id !== projectId) {
      throw new KnowledgeServiceError(
        'OWNERSHIP_MISMATCH',
        `Case ${caseId} does not belong to the selected project`,
      )
    }
    return row
  }

  private requireNode(
    projectId: string,
    caseId: string,
    nodeId: string,
    expectedType?: NodeType,
  ): NodeRecord {
    const row = this.database
      .prepare(
        `SELECT nodes.*, cases.project_id FROM nodes
         JOIN cases ON cases.id = nodes.case_id WHERE nodes.id = ?`,
      )
      .get(nodeId) as NodeRow | undefined
    if (!row) {
      throw new KnowledgeServiceError('NOT_FOUND', `Node not found: ${nodeId}`)
    }
    if (row.project_id !== projectId || row.case_id !== caseId) {
      throw new KnowledgeServiceError(
        'OWNERSHIP_MISMATCH',
        `Node ${nodeId} does not belong to the selected project and Case`,
      )
    }
    if (expectedType && row.type !== expectedType) {
      throw new KnowledgeServiceError(
        'VALIDATION_FAILED',
        `Node ${nodeId} must be a ${expectedType}`,
      )
    }
    return toNode(row)
  }

  private projectRoots(projectId: string): string[] {
    const project = this.projects.list().find((candidate) => candidate.id === projectId)
    if (!project) {
      return []
    }
    const roots = [project.root, ...project.aliases.map((alias) => alias.root)]
    return [...new Set(roots.flatMap((root) => [root, root.replace(/^\/private(?=\/var\/)/, '')]))]
  }

  private localArtifactRoots(projectId: string): string[] {
    return this.dataRoot
      ? [...this.projectRoots(projectId), this.dataRoot]
      : this.projectRoots(projectId)
  }

  private projectNodes(projectId: string, caseIds?: string[], limit?: number): NodeRecord[] {
    if (caseIds?.length === 0) return []
    const caseCondition = caseIds
      ? ` AND cases.id IN (${caseIds.map(() => '?').join(', ')})`
      : ''
    const limitClause = limit === undefined ? '' : ' LIMIT ?'
    const rows = this.database
      .prepare(
        `SELECT nodes.* FROM nodes
         JOIN cases ON cases.id = nodes.case_id
         WHERE cases.project_id = ?${caseCondition}
         ORDER BY nodes.created_at, nodes.rowid${limitClause}`,
      )
      .all(projectId, ...(caseIds ?? []), ...(limit === undefined ? [] : [limit])) as NodeRow[]
    return rows.map(toNode)
  }

  private indexNode(projectId: string, caseTitle: string, node: NodeRecord): void {
    this.database
      .prepare(
        'INSERT INTO node_search (project_id, node_id, title, body) VALUES (?, ?, ?, ?)',
      )
      .run(projectId, node.id, redactSecrets(caseTitle), JSON.stringify(node.data))
  }

  private setCaseStatus(projectId: string, caseId: string, status: NodeStatus): void {
    const current = this.requireCase(projectId, caseId)
    if (current.status === status) {
      return
    }
    this.database.prepare('UPDATE cases SET status = ? WHERE id = ? AND project_id = ?').run(
      status,
      caseId,
      projectId,
    )
    this.appendEvent(projectId, caseId, 'case.status_changed', caseId, {
      caseId,
      previousStatus: current.status,
      status,
    })
  }

  private setNodeStatus(projectId: string, nodeId: string, status: NodeStatus): void {
    const row = this.database
      .prepare(
        `SELECT nodes.status, nodes.case_id FROM nodes
         JOIN cases ON cases.id = nodes.case_id
         WHERE nodes.id = ? AND cases.project_id = ?`,
      )
      .get(nodeId, projectId) as { status: NodeStatus; case_id: string } | undefined
    if (!row) {
      throw new KnowledgeServiceError('NOT_FOUND', `Node not found: ${nodeId}`)
    }
    if (row.status === status) {
      return
    }
    this.database.prepare('UPDATE nodes SET status = ? WHERE id = ?').run(status, nodeId)
    this.appendEvent(projectId, row.case_id, 'node.status_changed', nodeId, {
      caseId: row.case_id,
      nodeId,
      previousStatus: row.status,
      status,
    })
  }

  private readOperation<T>(
    projectId: string,
    operationId: string | undefined,
    kind: string,
  ): T | undefined {
    if (!operationId) {
      return undefined
    }
    const safeOperationId = redactSecrets(operationId)
    const row = this.database
      .prepare(
        'SELECT kind, result FROM operation_results WHERE project_id = ? AND operation_id = ?',
      )
      .get(projectId, safeOperationId) as OperationRow | undefined
    if (!row) {
      return undefined
    }
    if (row.kind !== kind) {
      throw new KnowledgeServiceError(
        'OPERATION_CONFLICT',
        `Operation ID ${safeOperationId} was already used for ${row.kind}`,
      )
    }
    return JSON.parse(row.result) as T
  }

  private storeOperation(
    projectId: string,
    operationId: string | undefined,
    kind: string,
    result: unknown,
  ): void {
    if (!operationId) {
      return
    }
    const safeOperationId = redactSecrets(operationId)
    this.database
      .prepare(
        `INSERT INTO operation_results
         (id, project_id, operation_id, kind, result, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        projectId,
        safeOperationId,
        kind,
        JSON.stringify(result),
        new Date().toISOString(),
      )
  }

  private readSourceNode(
    projectId: string,
    sourceKey: OperationIdentity['sourceKey'],
  ): NodeRow | undefined {
    if (!sourceKey) {
      return undefined
    }
    const sourceKind = redactSecrets(sourceKey.kind)
    const key = redactSecrets(sourceKey.key)
    return this.database
      .prepare(
        `SELECT nodes.* FROM source_keys
         JOIN nodes ON nodes.id = source_keys.node_id
         WHERE source_keys.project_id = ? AND source_keys.source_kind = ?
           AND source_keys.source_key = ?`,
      )
      .get(projectId, sourceKind, key) as NodeRow | undefined
  }

  private storeSourceKey(
    projectId: string,
    sourceKey: OperationIdentity['sourceKey'],
    nodeId: string,
  ): void {
    if (!sourceKey) {
      return
    }
    this.database
      .prepare(
        `INSERT INTO source_keys
         (id, project_id, source_kind, source_key, node_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        projectId,
        redactSecrets(sourceKey.kind),
        redactSecrets(sourceKey.key),
        nodeId,
        new Date().toISOString(),
      )
  }

  private appendEvent(
    projectId: string,
    caseId: string | null,
    type: string,
    aggregateId: string,
    payload: unknown,
  ): void {
    const safePayload = redactValue(payload)
    this.assertPayload(safePayload)
    this.database
      .prepare(
        `INSERT INTO events (project_id, case_id, type, aggregate_id, payload, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        caseId,
        type,
        aggregateId,
        JSON.stringify(safePayload),
        new Date().toISOString(),
      )
  }

  private assertPayload(payload: unknown): void {
    const size = validatePayloadSize(payload, DEFAULT_PAYLOAD_LIMIT_BYTES)
    if (!size.valid) {
      throw new KnowledgeServiceError(
        'PAYLOAD_TOO_LARGE',
        `Payload is ${size.byteLength} bytes; limit is ${size.limitBytes}`,
        size,
      )
    }
  }

  private translateProjectError<T>(operation: () => T): T {
    try {
      return operation()
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        throw new KnowledgeServiceError('NOT_FOUND', error.message)
      }
      if (error instanceof ProjectConflictError) {
        throw new KnowledgeServiceError('CONFLICT', error.message)
      }
      if (error instanceof AmbiguousProjectReferenceError) {
        throw new KnowledgeServiceError('INVALID_ARGUMENT', error.message)
      }
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new KnowledgeServiceError('INVALID_ARGUMENT', error.message)
      }
      throw error
    }
  }
}
