import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

import {
  validateRelation,
  type NodeStatus,
  type NodeType,
  type RelationType,
} from '../domain/graph-rules.js'
import {
  CaseNotFoundError,
  InvalidGraphError,
  ProjectNotFoundError,
} from '../domain/errors.js'

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

export interface CaseRecord {
  id: string
  projectId: string
  title: string
  status: NodeStatus
  createdAt: string
}

export interface NodeInput {
  type: NodeType
  status: NodeStatus
  data: Record<string, unknown>
}

export interface NodeRecord extends NodeInput {
  id: string
  caseId: string
  createdAt: string
}

export interface EdgeInput {
  sourceId: string
  relation: RelationType
  targetId: string
}

export interface EdgeRecord extends EdgeInput {
  id: string
  caseId: string
  createdAt: string
}

export interface CaseSnapshot extends CaseRecord {
  nodes: NodeRecord[]
  edges: EdgeRecord[]
}

function toCase(row: CaseRow): CaseRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
  }
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

function toEdge(row: EdgeRow): EdgeRecord {
  return {
    id: row.id,
    caseId: row.case_id,
    sourceId: row.source_id,
    relation: row.relation,
    targetId: row.target_id,
    createdAt: row.created_at,
  }
}

export class CaseGraph {
  constructor(private readonly database: Database.Database) {}

  createCase(projectId: string, inputTitle: string): CaseRecord {
    const project = this.database
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(projectId)
    if (!project) {
      throw new ProjectNotFoundError(projectId)
    }

    const record: CaseRecord = {
      id: randomUUID(),
      projectId,
      title: inputTitle.trim(),
      status: 'open',
      createdAt: new Date().toISOString(),
    }

    return this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO cases (id, project_id, title, status, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(record.id, record.projectId, record.title, record.status, record.createdAt)
      this.appendEvent(projectId, record.id, 'case.created', record.id, record)
      return record
    })()
  }

  addNode(caseId: string, input: NodeInput): NodeRecord {
    const caseRecord = this.requireCase(caseId)
    const record: NodeRecord = {
      id: randomUUID(),
      caseId,
      type: input.type,
      status: input.status,
      data: input.data,
      createdAt: new Date().toISOString(),
    }

    return this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO nodes (id, case_id, type, status, data, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.caseId,
          record.type,
          record.status,
          JSON.stringify(record.data),
          record.createdAt,
        )
      this.appendEvent(caseRecord.projectId, caseId, 'node.added', record.id, record)
      return record
    })()
  }

  addEdge(caseId: string, input: EdgeInput): EdgeRecord {
    const caseRecord = this.requireCase(caseId)
    const record: EdgeRecord = {
      id: randomUUID(),
      caseId,
      ...input,
      createdAt: new Date().toISOString(),
    }

    return this.database.transaction(() => {
      const source = this.findNode(input.sourceId)
      const target = this.findNode(input.targetId)
      if (!source || !target || source.case_id !== caseId || target.case_id !== caseId) {
        throw new InvalidGraphError('Edge endpoints must belong to the selected Case')
      }

      validateRelation(source.type, input.relation, target.type)
      if (this.wouldCreateCycle(caseRecord.projectId, caseId, input.sourceId, input.targetId)) {
        throw new InvalidGraphError('Graph relations must remain acyclic')
      }

      this.database
        .prepare(
          `INSERT INTO edges (id, case_id, source_id, relation, target_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.caseId,
          record.sourceId,
          record.relation,
          record.targetId,
          record.createdAt,
        )
      this.appendEvent(caseRecord.projectId, caseId, 'edge.added', record.id, record)
      return record
    })()
  }

  getCase(projectId: string, caseId: string): CaseSnapshot {
    const row = this.database
      .prepare('SELECT * FROM cases WHERE id = ? AND project_id = ?')
      .get(caseId, projectId) as CaseRow | undefined
    if (!row) {
      throw new CaseNotFoundError(caseId)
    }

    const nodes = this.database
      .prepare('SELECT * FROM nodes WHERE case_id = ? ORDER BY rowid LIMIT 1000')
      .all(caseId) as NodeRow[]
    const edges = this.database
      .prepare('SELECT * FROM edges WHERE case_id = ? ORDER BY rowid LIMIT 2000')
      .all(caseId) as EdgeRow[]

    return {
      ...toCase(row),
      nodes: nodes.map(toNode),
      edges: edges.map(toEdge),
    }
  }

  private requireCase(caseId: string): CaseRecord {
    const row = this.database
      .prepare('SELECT * FROM cases WHERE id = ?')
      .get(caseId) as CaseRow | undefined
    if (!row) {
      throw new CaseNotFoundError(caseId)
    }
    return toCase(row)
  }

  private findNode(nodeId: string): NodeRow | undefined {
    return this.database
      .prepare('SELECT * FROM nodes WHERE id = ?')
      .get(nodeId) as NodeRow | undefined
  }

  private wouldCreateCycle(
    projectId: string,
    caseId: string,
    sourceId: string,
    targetId: string,
  ): boolean {
    if (sourceId === targetId) return true
    return this.database.prepare(
      `WITH RECURSIVE reachable(id) AS (
         SELECT edges.target_id
         FROM edges JOIN cases ON cases.id = edges.case_id
         WHERE cases.project_id = ? AND edges.case_id = ? AND edges.source_id = ?
         UNION
         SELECT edges.target_id
         FROM edges
         JOIN reachable ON edges.source_id = reachable.id
         JOIN cases ON cases.id = edges.case_id
         WHERE cases.project_id = ? AND edges.case_id = ?
       )
       SELECT 1 FROM reachable WHERE id = ? LIMIT 1`,
    ).get(projectId, caseId, targetId, projectId, caseId, sourceId) !== undefined
  }

  private appendEvent(
    projectId: string,
    caseId: string,
    type: string,
    aggregateId: string,
    payload: unknown,
  ): void {
    this.database
      .prepare(
        `INSERT INTO events (project_id, case_id, type, aggregate_id, payload, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, caseId, type, aggregateId, JSON.stringify(payload), new Date().toISOString())
  }
}
