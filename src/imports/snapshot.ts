import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'

import type { ProjectReference } from '../application/contracts.js'
import { assertAcyclic, nodeStatuses, nodeTypes, relationTypes, validateRelation, type NodeStatus, type NodeType, type RelationType } from '../domain/graph-rules.js'
import { validateNodeData } from '../domain/node-data.js'
import { canonicalizePath, isPathWithinBoundary } from '../domain/policies.js'
import { ProjectRegistry } from '../projects/project-registry.js'
import { redactArgv, redactSecrets } from '../security/redaction.js'
import { ImportServiceError } from './import-service.js'

export const SNAPSHOT_FORMAT = 'engineering-knowledge-graph'
export const SNAPSHOT_VERSION = 1

export interface SnapshotCase {
  id: string
  projectId: string
  title: string
  status: NodeStatus
  createdAt: string
}

export interface SnapshotNode {
  id: string
  caseId: string
  type: NodeType
  status: NodeStatus
  data: Record<string, unknown>
  createdAt: string
}

export interface SnapshotEdge {
  id: string
  caseId: string
  sourceId: string
  relation: RelationType
  targetId: string
  createdAt: string
}

export interface SnapshotEvidence {
  id: string
  projectId: string
  nodeId: string
  kind: 'automated' | 'human'
  command: string[] | null
  exitStatus: number | null
  data: Record<string, unknown>
  createdAt: string
}

export interface SnapshotFingerprint {
  id: string
  projectId: string
  problemNodeId: string
  algorithm: string
  value: string
  createdAt: string
}

export interface SnapshotGuardrail {
  id: string
  projectId: string
  nodeId: string
  enforcement: 'advise' | 'warn' | 'block'
  criteria: Record<string, unknown>
  createdAt: string
}

export interface SnapshotArtifact {
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

export interface ProjectGraphSnapshot {
  format: typeof SNAPSHOT_FORMAT
  version: typeof SNAPSHOT_VERSION
  exportedAt: string
  project: {
    id: string
    name: string
    description: string | null
    createdAt: string
  }
  cases: SnapshotCase[]
  nodes: SnapshotNode[]
  edges: SnapshotEdge[]
  evidence: SnapshotEvidence[]
  fingerprints: SnapshotFingerprint[]
  guardrails: SnapshotGuardrail[]
  artifacts: SnapshotArtifact[]
}

export interface ExportProjectGraphInput {
  project: ProjectReference
}

export interface ImportProjectGraphInput {
  project: ProjectReference
  archive: ProjectGraphSnapshot
  operationId: string
}

export interface ImportProjectGraphResult {
  sourceProjectId: string
  targetProjectId: string
  idMap: Record<string, string>
  created: {
    cases: number
    nodes: number
    edges: number
    evidence: number
    fingerprints: number
    guardrails: number
    artifacts: number
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
}

interface EdgeRow {
  id: string
  case_id: string
  source_id: string
  relation: RelationType
  target_id: string
  created_at: string
}

interface EvidenceRow {
  id: string
  project_id: string
  node_id: string
  kind: 'automated' | 'human'
  command: string | null
  exit_status: number | null
  data: string
  created_at: string
}

interface FingerprintRow {
  id: string
  project_id: string
  problem_node_id: string
  algorithm: string
  value: string
  created_at: string
}

interface GuardrailRow {
  id: string
  project_id: string
  node_id: string
  enforcement: 'advise' | 'warn' | 'block'
  criteria: string
  created_at: string
}

interface ArtifactRow {
  id: string
  project_id: string
  node_id: string | null
  kind: string
  uri: string
  digest: string | null
  is_external: number
  metadata: string
  created_at: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OMITTED_KEYS = /^(?:canonical_?root|local_?root|raw_?logs?|raw_?log_?path)$/i
const MAX_ARCHIVE_BYTES = 1024 * 1024
const MAX_ARCHIVE_COLLECTION_ENTRIES = 10_000
const MAX_ARCHIVE_DEPTH = 64
const MAX_ARCHIVE_STRUCTURE_ENTRIES = 100_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function invalid(message: string, details?: unknown): never {
  throw new ImportServiceError('INVALID_ARCHIVE', message, details)
}

function parseJson(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>
}

function recursivelyRedact(value: unknown, roots: string[]): unknown {
  if (typeof value === 'string') {
    let safe = redactSecrets(value)
    for (const root of roots.sort((a, b) => b.length - a.length)) {
      safe = safe.split(root).join('[PROJECT_ROOT]')
    }
    return safe
  }
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === 'string')) return redactArgv(value)
    return value.map((entry) => recursivelyRedact(entry, roots))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !OMITTED_KEYS.test(key))
        .map(([key, entry]) => [
          key,
          /^(?:token|password|passwd|secret|api[_-]?key)$/i.test(key)
            ? '[REDACTED]'
            : recursivelyRedact(entry, roots),
        ]),
    )
  }
  return value
}

function assertBoundedStructure(input: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }]
  const seen = new WeakSet<object>()
  let entryCount = 0
  let encodedBytes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    entryCount += 1
    if (entryCount > MAX_ARCHIVE_STRUCTURE_ENTRIES) invalid('Archive exceeds structural entry limit')
    if (current.depth > MAX_ARCHIVE_DEPTH) invalid('Archive exceeds nesting depth')
    const value = current.value
    if (value === null) encodedBytes += 4
    else if (typeof value === 'string') encodedBytes += Buffer.byteLength(JSON.stringify(value), 'utf8')
    else if (typeof value === 'number') encodedBytes += Buffer.byteLength(JSON.stringify(value), 'utf8')
    else if (typeof value === 'boolean') encodedBytes += value ? 4 : 5
    else if (typeof value === 'object') {
      if (seen.has(value)) invalid('Archive must be an acyclic JSON tree')
      seen.add(value)
      if (Array.isArray(value)) {
        encodedBytes += 2 + Math.max(0, value.length - 1)
        for (const child of value) pending.push({ value: child, depth: current.depth + 1 })
      } else {
        const entries = Object.entries(value as Record<string, unknown>)
        encodedBytes += 2 + Math.max(0, entries.length - 1)
        for (const [key, child] of entries) {
          encodedBytes += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1
          pending.push({ value: child, depth: current.depth + 1 })
        }
      }
    } else {
      invalid('Archive must contain only JSON values')
    }
    if (encodedBytes > MAX_ARCHIVE_BYTES) invalid('Archive exceeds byte limit')
  }
}

function deterministicId(targetProjectId: string, kind: string, sourceId: string): string {
  const hex = createHash('sha256')
    .update(`${targetProjectId}:${kind}:${sourceId}`)
    .digest('hex')
    .slice(0, 32)
    .split('')
  hex[12] = '5'
  hex[16] = ((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16)
  const value = hex.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function assertId(id: unknown, label: string, seen: Set<string>): asserts id is string {
  if (typeof id !== 'string' || !UUID.test(id)) invalid(`${label} must be a UUID`)
  if (seen.has(id)) invalid(`Duplicate archive ID: ${id}`)
  seen.add(id)
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${label} must be a non-empty string`)
}

function validateArchive(input: unknown): ProjectGraphSnapshot {
  assertBoundedStructure(input)
  if (!isRecord(input)) invalid('Archive must be an object')
  const archive = input as unknown as ProjectGraphSnapshot
  if (archive.format !== SNAPSHOT_FORMAT || archive.version !== SNAPSHOT_VERSION) {
    invalid(`Unsupported snapshot format or version`)
  }
  if (!isRecord(archive.project)) invalid('Archive project metadata is required')
  const collections = ['cases', 'nodes', 'edges', 'evidence', 'fingerprints', 'guardrails', 'artifacts'] as const
  for (const collection of collections) {
    if (
      !Array.isArray(archive[collection]) ||
      !(archive[collection] as unknown[]).every(isRecord)
    ) {
      invalid(`${collection} must contain only objects`)
    }
    if (archive[collection].length > MAX_ARCHIVE_COLLECTION_ENTRIES) {
      invalid(`${collection} exceeds entry limit`)
    }
  }
  const seen = new Set<string>()
  assertId(archive.project.id, 'project.id', seen)
  assertString(archive.project.name, 'project.name')
  assertString(archive.project.createdAt, 'project.createdAt')
  assertString(archive.exportedAt, 'exportedAt')
  if (archive.project.description !== null && typeof archive.project.description !== 'string') {
    invalid('project.description must be a string or null')
  }
  const cases = new Map<string, SnapshotCase>()
  for (const record of archive.cases) {
    assertId(record.id, 'case.id', seen)
    if (record.projectId !== archive.project.id) invalid(`Case ${record.id} has invalid project ownership`)
    assertString(record.title, 'case.title')
    assertString(record.createdAt, 'case.createdAt')
    if (!nodeStatuses.includes(record.status)) invalid(`Case ${record.id} has invalid status`)
    cases.set(record.id, record)
  }
  const nodes = new Map<string, SnapshotNode>()
  for (const record of archive.nodes) {
    assertId(record.id, 'node.id', seen)
    if (!cases.has(record.caseId)) invalid(`Node ${record.id} references a missing Case`)
    if (!nodeTypes.includes(record.type) || !nodeStatuses.includes(record.status)) invalid(`Node ${record.id} has invalid type or status`)
    const validation = validateNodeData(record.type, record.data)
    if (!validation.valid) invalid(`Node ${record.id} has invalid data`, validation.issues)
    assertString(record.createdAt, 'node.createdAt')
    nodes.set(record.id, record)
  }
  const edgesByCase = new Map<string, Array<{ sourceId: string; targetId: string }>>()
  const edgeKeys = new Set<string>()
  for (const record of archive.edges) {
    assertId(record.id, 'edge.id', seen)
    const source = nodes.get(record.sourceId)
    const target = nodes.get(record.targetId)
    if (!cases.has(record.caseId) || !source || !target || source.caseId !== record.caseId || target.caseId !== record.caseId) {
      invalid(`Edge ${record.id} has invalid ownership or endpoints`)
    }
    if (!relationTypes.includes(record.relation)) invalid(`Edge ${record.id} has invalid relation`)
    const edgeKey = `${record.caseId}:${record.sourceId}:${record.relation}:${record.targetId}`
    if (edgeKeys.has(edgeKey)) invalid(`Duplicate graph relation: ${edgeKey}`)
    edgeKeys.add(edgeKey)
    try {
      validateRelation(source.type, record.relation, target.type)
    } catch (error) {
      invalid(`Edge ${record.id} has invalid relation`, error)
    }
    const caseEdges = edgesByCase.get(record.caseId) ?? []
    caseEdges.push(record)
    edgesByCase.set(record.caseId, caseEdges)
    assertString(record.createdAt, 'edge.createdAt')
  }
  for (const edges of edgesByCase.values()) {
    try {
      assertAcyclic(edges)
    } catch (error) {
      invalid('Archive graph contains a cycle', error)
    }
  }
  for (const record of archive.evidence) {
    assertId(record.id, 'evidence.id', seen)
    if (record.projectId !== archive.project.id || !nodes.has(record.nodeId)) invalid(`Evidence ${record.id} has invalid ownership`)
    if (record.kind !== 'automated' && record.kind !== 'human') invalid(`Evidence ${record.id} has invalid kind`)
    if (record.command !== null && (!Array.isArray(record.command) || !record.command.every((part) => typeof part === 'string'))) invalid(`Evidence ${record.id} has invalid command`)
    if (record.exitStatus !== null && !Number.isInteger(record.exitStatus)) invalid(`Evidence ${record.id} has invalid exit status`)
    if (!isRecord(record.data)) invalid(`Evidence ${record.id} data must be an object`)
    assertString(record.createdAt, 'evidence.createdAt')
  }
  const fingerprintKeys = new Set<string>()
  for (const record of archive.fingerprints) {
    assertId(record.id, 'fingerprint.id', seen)
    if (record.projectId !== archive.project.id || nodes.get(record.problemNodeId)?.type !== 'Problem') invalid(`Fingerprint ${record.id} has invalid ownership`)
    assertString(record.algorithm, 'fingerprint.algorithm')
    assertString(record.value, 'fingerprint.value')
    assertString(record.createdAt, 'fingerprint.createdAt')
    const key = `${record.algorithm}:${record.value}`
    if (fingerprintKeys.has(key)) invalid(`Duplicate fingerprint: ${key}`)
    fingerprintKeys.add(key)
  }
  const guardrailNodes = new Set<string>()
  for (const record of archive.guardrails) {
    assertId(record.id, 'guardrail.id', seen)
    if (record.projectId !== archive.project.id || nodes.get(record.nodeId)?.type !== 'Guardrail') invalid(`Guardrail ${record.id} has invalid ownership`)
    if (!['advise', 'warn', 'block'].includes(record.enforcement)) invalid(`Guardrail ${record.id} has invalid enforcement`)
    if (!isRecord(record.criteria)) invalid(`Guardrail ${record.id} criteria must be an object`)
    if (guardrailNodes.has(record.nodeId)) invalid(`Duplicate Guardrail row for node ${record.nodeId}`)
    guardrailNodes.add(record.nodeId)
    assertString(record.createdAt, 'guardrail.createdAt')
  }
  const artifactNodes = new Set<string>()
  for (const record of archive.artifacts) {
    assertId(record.id, 'artifact.id', seen)
    if (record.projectId !== archive.project.id || (record.nodeId !== null && nodes.get(record.nodeId)?.type !== 'Artifact')) invalid(`Artifact ${record.id} has invalid ownership`)
    assertString(record.kind, 'artifact.kind')
    assertString(record.uri, 'artifact.uri')
    if (record.digest !== null && typeof record.digest !== 'string') invalid(`Artifact ${record.id} has invalid digest`)
    if (typeof record.isExternal !== 'boolean') invalid(`Artifact ${record.id} has invalid external flag`)
    if (!isRecord(record.metadata)) invalid(`Artifact ${record.id} metadata must be an object`)
    if (record.nodeId && artifactNodes.has(record.nodeId)) invalid(`Duplicate Artifact row for node ${record.nodeId}`)
    if (record.nodeId) artifactNodes.add(record.nodeId)
    assertString(record.createdAt, 'artifact.createdAt')
  }
  return archive
}

export class SnapshotService {
  private readonly projects: ProjectRegistry

  constructor(
    private readonly database: Database.Database,
    private readonly options: { dataRoot?: string } = {},
  ) {
    this.projects = new ProjectRegistry(database)
  }

  exportProject(input: ExportProjectGraphInput): ProjectGraphSnapshot {
    const project = this.projects.resolve(input.project)
    const fullProject = this.projects.list().find((candidate) => candidate.id === project.id)!
    const roots = [fullProject.root, ...fullProject.aliases.map((alias) => alias.root)].flatMap(
      (root) => [root, root.replace(/^\/private(?=\/var\/)/, '')],
    )
    const exportLimit = MAX_ARCHIVE_COLLECTION_ENTRIES + 1
    const cases = this.database.prepare('SELECT * FROM cases WHERE project_id = ? ORDER BY created_at, id LIMIT ?').all(project.id, exportLimit) as CaseRow[]
    const nodes = this.database.prepare(`SELECT nodes.* FROM nodes JOIN cases ON cases.id = nodes.case_id WHERE cases.project_id = ? ORDER BY nodes.created_at, nodes.id LIMIT ?`).all(project.id, exportLimit) as NodeRow[]
    const edges = this.database.prepare(`SELECT edges.* FROM edges JOIN cases ON cases.id = edges.case_id WHERE cases.project_id = ? ORDER BY edges.created_at, edges.id LIMIT ?`).all(project.id, exportLimit) as EdgeRow[]
    const evidence = this.database.prepare('SELECT * FROM evidence WHERE project_id = ? ORDER BY created_at, id LIMIT ?').all(project.id, exportLimit) as EvidenceRow[]
    const fingerprints = this.database.prepare('SELECT * FROM fingerprints WHERE project_id = ? ORDER BY created_at, id LIMIT ?').all(project.id, exportLimit) as FingerprintRow[]
    const guardrails = this.database.prepare('SELECT * FROM guardrails WHERE project_id = ? ORDER BY created_at, id LIMIT ?').all(project.id, exportLimit) as GuardrailRow[]
    const artifacts = this.database.prepare("SELECT * FROM artifacts WHERE project_id = ? AND kind <> 'command-log' ORDER BY created_at, id LIMIT ?").all(project.id, exportLimit) as ArtifactRow[]
    for (const [name, collection] of Object.entries({ cases, nodes, edges, evidence, fingerprints, guardrails, artifacts })) {
      if (collection.length > MAX_ARCHIVE_COLLECTION_ENTRIES) invalid(`${name} exceeds entry limit`)
    }
    const archive: ProjectGraphSnapshot = {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      exportedAt: new Date().toISOString(),
      project: { id: project.id, name: project.name, description: project.description, createdAt: project.createdAt },
      cases: cases.map((row) => ({ id: row.id, projectId: row.project_id, title: row.title, status: row.status, createdAt: row.created_at })),
      nodes: nodes.map((row) => ({ id: row.id, caseId: row.case_id, type: row.type, status: row.status, data: parseJson(row.data), createdAt: row.created_at })),
      edges: edges.map((row) => ({ id: row.id, caseId: row.case_id, sourceId: row.source_id, relation: row.relation, targetId: row.target_id, createdAt: row.created_at })),
      evidence: evidence.map((row) => ({ id: row.id, projectId: row.project_id, nodeId: row.node_id, kind: row.kind, command: row.command ? JSON.parse(row.command) : null, exitStatus: row.exit_status, data: parseJson(row.data), createdAt: row.created_at })),
      fingerprints: fingerprints.map((row) => ({ id: row.id, projectId: row.project_id, problemNodeId: row.problem_node_id, algorithm: row.algorithm, value: row.value, createdAt: row.created_at })),
      guardrails: guardrails.map((row) => ({ id: row.id, projectId: row.project_id, nodeId: row.node_id, enforcement: row.enforcement, criteria: parseJson(row.criteria), createdAt: row.created_at })),
      artifacts: artifacts.map((row) => ({ id: row.id, projectId: row.project_id, nodeId: row.node_id, kind: row.kind, uri: row.uri, digest: row.digest, isExternal: row.is_external === 1, metadata: parseJson(row.metadata), createdAt: row.created_at })),
    }
    assertBoundedStructure(archive)
    return recursivelyRedact(archive, roots) as ProjectGraphSnapshot
  }

  importProject(input: ImportProjectGraphInput): ImportProjectGraphResult {
    const project = this.projects.resolve(input.project)
    if (!input.operationId?.trim()) throw new ImportServiceError('INVALID_ARGUMENT', 'operationId is required')
    const prior = this.database.prepare(`SELECT kind, result FROM operation_results WHERE project_id = ? AND operation_id = ?`).get(project.id, input.operationId) as { kind: string; result: string } | undefined
    if (prior) {
      if (prior.kind !== 'import_project_graph') throw new ImportServiceError('OPERATION_CONFLICT', 'Operation ID was used for another action')
      return JSON.parse(prior.result) as ImportProjectGraphResult
    }
    assertBoundedStructure(input.archive)
    const archive = validateArchive(recursivelyRedact(input.archive, []))
    const fullProject = this.projects.list().find((candidate) => candidate.id === project.id)!
    const projectRoots = [fullProject.root, ...fullProject.aliases.map((alias) => alias.root)]
    const localRoots = this.options.dataRoot
      ? [...projectRoots, this.options.dataRoot]
      : projectRoots
    const normalizeLocalUri = (uri: string): string => {
      const localUri = uri === '[PROJECT_ROOT]'
        ? fullProject.root
        : uri.startsWith('[PROJECT_ROOT]/')
          ? `${fullProject.root}/${uri.slice('[PROJECT_ROOT]/'.length)}`
          : uri
      const canonicalUri = canonicalizePath(localUri)
      if (!isPathWithinBoundary(canonicalUri, localRoots)) {
        throw new ImportServiceError(
          'PATH_OUTSIDE_PROJECT',
          'Snapshot artifact paths must be inside the destination project or service data directory',
        )
      }
      return canonicalUri
    }
    const artifactsByNode = new Map(
      archive.artifacts
        .filter((artifact): artifact is SnapshotArtifact & { nodeId: string } => artifact.nodeId !== null)
        .map((artifact) => [artifact.nodeId, artifact]),
    )
    for (const artifact of archive.artifacts) {
      if (artifact.isExternal) continue
      artifact.uri = normalizeLocalUri(artifact.uri)
    }
    for (const node of archive.nodes) {
      if (node.type !== 'Artifact' || artifactsByNode.get(node.id)?.isExternal) continue
      node.data.uri = normalizeLocalUri(node.data.uri as string)
    }
    const idMap: Record<string, string> = { [archive.project.id]: project.id }
    const map = (kind: string, sourceId: string): string => idMap[sourceId] ??= deterministicId(project.id, kind, sourceId)
    for (const record of archive.cases) map('case', record.id)
    for (const record of archive.nodes) map('node', record.id)
    for (const record of archive.edges) map('edge', record.id)
    for (const record of archive.evidence) map('evidence', record.id)
    for (const record of archive.fingerprints) map('fingerprint', record.id)
    for (const record of archive.guardrails) map('guardrail', record.id)
    for (const record of archive.artifacts) map('artifact', record.id)
    const created = { cases: 0, nodes: 0, edges: 0, evidence: 0, fingerprints: 0, guardrails: 0, artifacts: 0 }
    const exists = (table: string, id: string): boolean => Boolean(this.database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id))

    return this.database.transaction(() => {
      for (const record of archive.cases) {
        const id = map('case', record.id)
        if (!exists('cases', id)) {
          const status = record.status === 'verified' ? 'candidate' : record.status
          this.database.prepare(`INSERT INTO cases (id, project_id, title, status, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, project.id, record.title, status, record.createdAt)
          created.cases += 1
        }
      }
      for (const record of archive.nodes) {
        const id = map('node', record.id)
        if (!exists('nodes', id)) {
          const status = record.status === 'verified' && ['RootCause', 'Solution', 'SuccessCase', 'Guardrail'].includes(record.type)
            ? 'candidate'
            : record.status
          this.database.prepare(`INSERT INTO nodes (id, case_id, type, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, map('case', record.caseId), record.type, status, JSON.stringify(record.data), record.createdAt)
          const title = archive.cases.find((item) => item.id === record.caseId)!.title
          this.database.prepare('INSERT INTO node_search (project_id, node_id, title, body) VALUES (?, ?, ?, ?)').run(project.id, id, title, JSON.stringify(record.data))
          created.nodes += 1
        }
      }
      for (const record of archive.edges) {
        const id = map('edge', record.id)
        if (!exists('edges', id)) {
          this.database.prepare(`INSERT INTO edges (id, case_id, source_id, relation, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, map('case', record.caseId), map('node', record.sourceId), record.relation, map('node', record.targetId), record.createdAt)
          created.edges += 1
        }
      }
      for (const record of archive.evidence) {
        const id = map('evidence', record.id)
        if (!exists('evidence', id)) {
          this.database.prepare(`INSERT INTO evidence (id, project_id, node_id, kind, command, exit_status, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, project.id, map('node', record.nodeId), record.kind, record.command ? JSON.stringify(record.command) : null, record.exitStatus, JSON.stringify(record.data), record.createdAt)
          created.evidence += 1
        }
      }
      for (const record of archive.fingerprints) {
        const id = map('fingerprint', record.id)
        if (!exists('fingerprints', id)) {
          this.database.prepare(`INSERT INTO fingerprints (id, project_id, problem_node_id, algorithm, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, project.id, map('node', record.problemNodeId), record.algorithm, record.value, record.createdAt)
          created.fingerprints += 1
        }
      }
      for (const record of archive.guardrails) {
        const id = map('guardrail', record.id)
        if (!exists('guardrails', id)) {
          this.database.prepare(`INSERT INTO guardrails (id, project_id, node_id, enforcement, criteria, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, project.id, map('node', record.nodeId), record.enforcement, JSON.stringify(record.criteria), record.createdAt)
          created.guardrails += 1
        }
      }
      for (const record of archive.artifacts) {
        const id = map('artifact', record.id)
        if (!exists('artifacts', id)) {
          this.database.prepare(`INSERT INTO artifacts (id, project_id, node_id, kind, uri, digest, is_external, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, project.id, record.nodeId ? map('node', record.nodeId) : null, record.kind, record.uri, record.digest, record.isExternal ? 1 : 0, JSON.stringify(record.metadata), record.createdAt)
          created.artifacts += 1
        }
      }
      const result: ImportProjectGraphResult = { sourceProjectId: archive.project.id, targetProjectId: project.id, idMap, created }
      if (Object.values(created).some((count) => count > 0)) {
        this.database.prepare(`INSERT INTO events (project_id, type, aggregate_id, payload, occurred_at) VALUES (?, 'snapshot.imported', ?, ?, ?)`).run(project.id, project.id, JSON.stringify({ sourceProjectId: archive.project.id, created }), new Date().toISOString())
      }
      this.database.prepare(`INSERT INTO operation_results (id, project_id, operation_id, kind, result, created_at) VALUES (?, ?, ?, 'import_project_graph', ?, ?)`).run(randomUUID(), project.id, input.operationId, JSON.stringify(result), new Date().toISOString())
      return result
    })()
  }
}
