import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process'

import type { NodeStatus, NodeType } from '../domain/graph-rules.js'
import { validateNodeData } from '../domain/node-data.js'
import { isPathWithinBoundary } from '../domain/policies.js'
import { ProjectRegistry } from '../projects/project-registry.js'
import type { ProjectReference } from '../application/contracts.js'
import {
  IMPORT_PARSER_VERSION,
  parseImportContent,
  type ImportProposalDraft,
} from './parsers.js'

const MAX_SOURCE_BYTES = 1024 * 1024
const MAX_SOURCES = 32
const DEFAULT_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000
const GIT_MAX_BUFFER_BYTES = 1024 * 1024

export type ImportServiceErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'OWNERSHIP_MISMATCH'
  | 'PATH_OUTSIDE_PROJECT'
  | 'SOURCE_TOO_LARGE'
  | 'SOURCE_READ_FAILED'
  | 'STALE_PREVIEW'
  | 'EXPIRED_PREVIEW'
  | 'INVALID_ARCHIVE'
  | 'OPERATION_CONFLICT'

export class ImportServiceError extends Error {
  constructor(
    public readonly code: ImportServiceErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ImportServiceError'
  }
}

export type ImportSource =
  | { kind: 'file'; path: string }
  | { kind: 'git'; range: string }

export interface PreviewImportInput {
  project: ProjectReference
  sources: ImportSource[]
}

export interface ImportProposal {
  id: string
  sourceKey: string
  nodeType: NodeType
  status: 'candidate'
  caseTitle: string
  data: Record<string, unknown>
}

export interface ImportPreviewResult {
  previewId: string
  projectId: string
  parserVersion: string
  sourceDigest: string
  createdAt: string
  expiresAt: string
  proposals: ImportProposal[]
}

export interface ApplyImportInput {
  project: ProjectReference
  previewId: string
  proposalIds: string[]
  operationId: string
}

export interface ApplyImportResult {
  previewId: string
  proposalIds: string[]
  caseIds: string[]
  nodeIds: string[]
  created: number
}

type GitExecutor = (
  file: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr'>

export class GitCommandRunner {
  constructor(
    private readonly executor: GitExecutor = (file, args, options) =>
      spawnSync(file, args, options),
  ) {}

  run(cwd: string, args: string[]): string {
    const result = this.executor('git', args, {
      cwd,
      shell: false,
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER_BYTES,
    })
    if (result.status !== 0) {
      throw new ImportServiceError(
        'SOURCE_READ_FAILED',
        `Git command failed: git ${args.join(' ')}`,
        result.stderr.trim(),
      )
    }
    if (Buffer.byteLength(result.stdout, 'utf8') > MAX_SOURCE_BYTES) {
      throw new ImportServiceError('SOURCE_TOO_LARGE', 'Git source exceeds the import limit')
    }
    return result.stdout
  }
}

interface FileManifest {
  kind: 'file'
  path: string
  digest: string
}

interface GitManifest {
  kind: 'git'
  root: string
  range: string
  baseCommit: string
  headCommit: string
  commits: string[]
  digest: string
}

type SourceManifest = FileManifest | GitManifest

interface PreviewRow {
  id: string
  project_id: string
  source_digest: string
  status: 'pending' | 'applied' | 'stale'
  parser_version: string
  source_manifest: string
  created_at: string
  expires_at: string
}

interface ProposalRow {
  id: string
  source_key: string
  node_type: NodeType
  payload: string
}

interface StoredProposalPayload {
  status: 'candidate'
  caseTitle: string
  data: Record<string, unknown>
}

export interface ImportServiceOptions {
  gitRunner?: GitCommandRunner
  now?: () => Date
  previewTtlMs?: number
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function sourceDigest(manifests: SourceManifest[]): string {
  return sha256(JSON.stringify(manifests))
}

function isCommit(value: string): boolean {
  return /^[a-f0-9]{40}$/.test(value)
}

export class ImportService {
  private readonly projects: ProjectRegistry
  private readonly git: GitCommandRunner
  private readonly now: () => Date
  private readonly previewTtlMs: number

  constructor(
    private readonly database: Database.Database,
    options: ImportServiceOptions = {},
  ) {
    this.projects = new ProjectRegistry(database)
    this.git = options.gitRunner ?? new GitCommandRunner()
    this.now = options.now ?? (() => new Date())
    this.previewTtlMs = options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS
  }

  preview(input: PreviewImportInput): ImportPreviewResult {
    const project = this.projects.resolve(input.project)
    if (!Array.isArray(input.sources) || input.sources.length === 0 || input.sources.length > MAX_SOURCES) {
      throw new ImportServiceError(
        'INVALID_ARGUMENT',
        `sources must contain between 1 and ${MAX_SOURCES} explicit entries`,
      )
    }
    const roots = this.projectRoots(project.id)
    const manifests: SourceManifest[] = []
    const drafts: Array<{ sourceKey: string; draft: ImportProposalDraft }> = []
    for (const [sourceIndex, source] of input.sources.entries()) {
      const acquired = source.kind === 'file'
        ? this.acquireFile(source.path, roots)
        : this.acquireGit(source.range, project.root)
      manifests.push(acquired.manifest)
      for (const [proposalIndex, draft] of parseImportContent(acquired.pathHint, acquired.content).entries()) {
        drafts.push({
          sourceKey: `${acquired.manifest.digest}:${sourceIndex}:${proposalIndex}`,
          draft,
        })
      }
    }
    const createdAt = this.now().toISOString()
    const expiresAt = new Date(this.now().getTime() + this.previewTtlMs).toISOString()
    const previewId = randomUUID()
    const digest = sourceDigest(manifests)
    const proposals = drafts.map(({ sourceKey, draft }): ImportProposal => ({
      id: randomUUID(),
      sourceKey,
      nodeType: draft.nodeType,
      status: 'candidate',
      caseTitle: draft.caseTitle,
      data: draft.data as unknown as Record<string, unknown>,
    }))

    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO import_previews
           (id, project_id, source_digest, status, created_at, parser_version, source_manifest, expires_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(
          previewId,
          project.id,
          digest,
          createdAt,
          IMPORT_PARSER_VERSION,
          JSON.stringify(manifests),
          expiresAt,
        )
      const insert = this.database.prepare(
        `INSERT INTO import_proposals
         (id, project_id, preview_id, source_key, node_type, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const proposal of proposals) {
        insert.run(
          proposal.id,
          project.id,
          previewId,
          proposal.sourceKey,
          proposal.nodeType,
          JSON.stringify({
            status: proposal.status,
            caseTitle: proposal.caseTitle,
            data: proposal.data,
          }),
          createdAt,
        )
      }
    })()

    return {
      previewId,
      projectId: project.id,
      parserVersion: IMPORT_PARSER_VERSION,
      sourceDigest: digest,
      createdAt,
      expiresAt,
      proposals,
    }
  }

  apply(input: ApplyImportInput): ApplyImportResult {
    const project = this.projects.resolve(input.project)
    if (!input.operationId?.trim()) {
      throw new ImportServiceError('INVALID_ARGUMENT', 'operationId is required')
    }
    const duplicate = this.readOperation(project.id, input.operationId)
    if (duplicate) {
      const requestedIds = [...new Set(input.proposalIds)]
      if (
        duplicate.previewId !== input.previewId ||
        JSON.stringify(duplicate.proposalIds) !== JSON.stringify(requestedIds)
      ) {
        throw new ImportServiceError(
          'OPERATION_CONFLICT',
          'Operation ID was already used with a different preview or selection',
        )
      }
      return { ...duplicate, created: 0 }
    }
    const preview = this.requirePreview(project.id, input.previewId)
    if (preview.status !== 'pending') {
      throw new ImportServiceError('STALE_PREVIEW', 'Preview is no longer pending')
    }
    if (this.now().getTime() > Date.parse(preview.expires_at)) {
      throw new ImportServiceError('EXPIRED_PREVIEW', 'Preview has expired')
    }
    const manifests = JSON.parse(preview.source_manifest) as SourceManifest[]
    let refreshed: SourceManifest[]
    try {
      refreshed = this.refreshManifests(manifests, this.projectRoots(project.id))
    } catch (error) {
      throw new ImportServiceError('STALE_PREVIEW', 'Import sources are no longer readable', error)
    }
    if (sourceDigest(refreshed) !== preview.source_digest) {
      throw new ImportServiceError('STALE_PREVIEW', 'Import sources changed after preview')
    }
    if (!Array.isArray(input.proposalIds) || input.proposalIds.length === 0) {
      throw new ImportServiceError('INVALID_ARGUMENT', 'At least one proposal ID is required')
    }
    const selectedIds = [...new Set(input.proposalIds)]
    const rows = this.database
      .prepare(
        `SELECT id, source_key, node_type, payload FROM import_proposals
         WHERE project_id = ? AND preview_id = ?`,
      )
      .all(project.id, preview.id) as ProposalRow[]
    const byId = new Map(rows.map((row) => [row.id, row]))
    if (selectedIds.some((id) => !byId.has(id))) {
      throw new ImportServiceError(
        'OWNERSHIP_MISMATCH',
        'Every selected proposal must belong to the selected project and preview',
      )
    }

    return this.database.transaction(() => {
      const caseIds: string[] = []
      const nodeIds: string[] = []
      const casesByTitle = new Map<string, string>()
      const importedNodes: Array<{ caseId: string; nodeId: string; type: NodeType }> = []
      const timestamp = this.now().toISOString()
      for (const proposalId of selectedIds) {
        const row = byId.get(proposalId) as ProposalRow
        const payload = JSON.parse(row.payload) as StoredProposalPayload
        const validation = validateNodeData(row.node_type, payload.data)
        if (!validation.valid) {
          throw new ImportServiceError('INVALID_ARGUMENT', 'Stored proposal is invalid', validation.issues)
        }
        let caseId = casesByTitle.get(payload.caseTitle)
        if (!caseId) {
          caseId = randomUUID()
          casesByTitle.set(payload.caseTitle, caseId)
          this.database
            .prepare(
              `INSERT INTO cases (id, project_id, title, status, created_at)
               VALUES (?, ?, ?, 'candidate', ?)`,
            )
            .run(caseId, project.id, payload.caseTitle, timestamp)
          this.appendEvent(project.id, 'case.created', caseId, { caseId, source: 'import' }, timestamp)
        }
        const nodeId = randomUUID()
        this.database
          .prepare(
            `INSERT INTO nodes (id, case_id, type, status, data, created_at)
             VALUES (?, ?, ?, 'candidate', ?, ?)`,
          )
          .run(nodeId, caseId, row.node_type, JSON.stringify(validation.data), timestamp)
        this.database
          .prepare('INSERT INTO node_search (project_id, node_id, title, body) VALUES (?, ?, ?, ?)')
          .run(project.id, nodeId, payload.caseTitle, JSON.stringify(validation.data))
        this.database
          .prepare(
            `INSERT INTO source_keys
             (id, project_id, source_kind, source_key, node_id, created_at)
             VALUES (?, ?, 'import', ?, ?, ?)`,
          )
          .run(randomUUID(), project.id, `${preview.id}:${row.source_key}`, nodeId, timestamp)
        this.appendEvent(
          project.id,
          'node.added',
          nodeId,
          { caseId, nodeId, type: row.node_type, status: 'candidate', source: 'import' },
          timestamp,
        )
        caseIds.push(caseId)
        nodeIds.push(nodeId)
        importedNodes.push({ caseId, nodeId, type: row.node_type })
      }
      for (const attempt of importedNodes.filter((node) => node.type === 'Attempt')) {
        const problem = importedNodes.find((node) =>
          node.caseId === attempt.caseId && node.type === 'Problem')
        if (!problem) continue
        const edgeId = randomUUID()
        this.database.prepare(
          `INSERT INTO edges (id, case_id, source_id, relation, target_id, created_at)
           VALUES (?, ?, ?, 'ATTEMPTS_TO_SOLVE', ?, ?)`,
        ).run(edgeId, attempt.caseId, attempt.nodeId, problem.nodeId, timestamp)
        this.appendEvent(project.id, 'edge.added', edgeId, {
          caseId: attempt.caseId,
          sourceId: attempt.nodeId,
          relation: 'ATTEMPTS_TO_SOLVE',
          targetId: problem.nodeId,
        }, timestamp)
      }
      this.database
        .prepare(
          `UPDATE import_proposals SET selected = 1
           WHERE project_id = ? AND preview_id = ? AND id IN (${selectedIds.map(() => '?').join(', ')})`,
        )
        .run(project.id, preview.id, ...selectedIds)
      this.database
        .prepare(
          `UPDATE import_previews SET status = 'applied', applied_at = ?
           WHERE id = ? AND project_id = ?`,
        )
        .run(timestamp, preview.id, project.id)
      const result: ApplyImportResult = {
        previewId: preview.id,
        proposalIds: selectedIds,
        caseIds,
        nodeIds,
        created: selectedIds.length,
      }
      this.storeOperation(project.id, input.operationId, result, timestamp)
      return result
    })()
  }

  private acquireFile(path: string, roots: string[]): { manifest: FileManifest; content: string; pathHint: string } {
    let realPath: string
    try {
      realPath = realpathSync(path)
    } catch (error) {
      throw new ImportServiceError('SOURCE_READ_FAILED', `Cannot read import source: ${path}`, error)
    }
    if (!isPathWithinBoundary(realPath, roots)) {
      throw new ImportServiceError('PATH_OUTSIDE_PROJECT', 'Import files must be inside the selected project')
    }
    const stat = statSync(realPath)
    if (!stat.isFile()) {
      throw new ImportServiceError('INVALID_ARGUMENT', 'Import source must be an explicit file')
    }
    if (stat.size > MAX_SOURCE_BYTES) {
      throw new ImportServiceError('SOURCE_TOO_LARGE', `Import source exceeds ${MAX_SOURCE_BYTES} bytes`)
    }
    const bytes = readFileSync(realPath)
    if (bytes.byteLength > MAX_SOURCE_BYTES) {
      throw new ImportServiceError('SOURCE_TOO_LARGE', `Import source exceeds ${MAX_SOURCE_BYTES} bytes`)
    }
    return {
      manifest: { kind: 'file', path: realPath, digest: sha256(bytes) },
      content: bytes.toString('utf8'),
      pathHint: realPath,
    }
  }

  private acquireGit(range: string, root: string): { manifest: GitManifest; content: string; pathHint: string } {
    const parts = range.split('..')
    if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim() || range.includes('...')) {
      throw new ImportServiceError('INVALID_ARGUMENT', 'Git source must be an explicit base..head range')
    }
    const baseCommit = this.git.run(root, ['rev-parse', '--verify', `${parts[0]}^{commit}`]).trim()
    const headCommit = this.git.run(root, ['rev-parse', '--verify', `${parts[1]}^{commit}`]).trim()
    if (!isCommit(baseCommit) || !isCommit(headCommit)) {
      throw new ImportServiceError('SOURCE_READ_FAILED', 'Git range did not resolve to immutable commits')
    }
    const commits = this.git
      .run(root, ['rev-list', '--reverse', `${baseCommit}..${headCommit}`])
      .trim()
      .split('\n')
      .filter(Boolean)
    if (commits.length === 0 || commits.some((commit) => !isCommit(commit))) {
      throw new ImportServiceError('INVALID_ARGUMENT', 'Git range must contain at least one commit')
    }
    const content = this.readGitCommits(root, commits)
    return {
      manifest: {
        kind: 'git',
        root,
        range,
        baseCommit,
        headCommit,
        commits,
        digest: sha256(content),
      },
      content,
      pathHint: 'git-range.txt',
    }
  }

  private refreshManifests(manifests: SourceManifest[], roots: string[]): SourceManifest[] {
    return manifests.map((manifest) => {
      if (manifest.kind === 'file') {
        return this.acquireFile(manifest.path, roots).manifest
      }
      if (!isPathWithinBoundary(manifest.root, roots)) {
        throw new ImportServiceError('PATH_OUTSIDE_PROJECT', 'Git root is outside the selected project')
      }
      const content = this.readGitCommits(manifest.root, manifest.commits)
      return { ...manifest, digest: sha256(content) }
    })
  }

  private readGitCommits(root: string, commits: string[]): string {
    let content = ''
    for (const commit of commits) {
      const next = this.git.run(root, [
        'show',
        '--no-ext-diff',
        '--no-renames',
        '--format=fuller',
        commit,
      ])
      if (Buffer.byteLength(content, 'utf8') + Buffer.byteLength(next, 'utf8') > MAX_SOURCE_BYTES) {
        throw new ImportServiceError('SOURCE_TOO_LARGE', 'Git range exceeds the import limit')
      }
      content += `${content ? '\n' : ''}${next}`
    }
    return content
  }

  private projectRoots(projectId: string): string[] {
    const project = this.projects.list().find((candidate) => candidate.id === projectId)
    return project ? [project.root, ...project.aliases.map((alias) => alias.root)] : []
  }

  private requirePreview(projectId: string, previewId: string): PreviewRow {
    const row = this.database
      .prepare('SELECT * FROM import_previews WHERE id = ?')
      .get(previewId) as PreviewRow | undefined
    if (!row) {
      throw new ImportServiceError('NOT_FOUND', `Import preview not found: ${previewId}`)
    }
    if (row.project_id !== projectId) {
      throw new ImportServiceError('OWNERSHIP_MISMATCH', 'Import preview belongs to another project')
    }
    return row
  }

  private readOperation(projectId: string, operationId: string): ApplyImportResult | undefined {
    const row = this.database
      .prepare(
        `SELECT kind, result FROM operation_results
         WHERE project_id = ? AND operation_id = ?`,
      )
      .get(projectId, operationId) as { kind: string; result: string } | undefined
    if (!row) return undefined
    if (row.kind !== 'apply_import') {
      throw new ImportServiceError('OPERATION_CONFLICT', 'Operation ID was used for another action')
    }
    return JSON.parse(row.result) as ApplyImportResult
  }

  private storeOperation(
    projectId: string,
    operationId: string,
    result: ApplyImportResult,
    timestamp: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO operation_results
         (id, project_id, operation_id, kind, result, created_at)
         VALUES (?, ?, ?, 'apply_import', ?, ?)`,
      )
      .run(randomUUID(), projectId, operationId, JSON.stringify(result), timestamp)
  }

  private appendEvent(
    projectId: string,
    type: string,
    aggregateId: string,
    payload: unknown,
    timestamp: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO events (project_id, type, aggregate_id, payload, occurred_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(projectId, type, aggregateId, JSON.stringify(payload), timestamp)
  }
}
