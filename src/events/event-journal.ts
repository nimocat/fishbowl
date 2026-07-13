import type Database from 'better-sqlite3'

interface EventRow {
  sequence: number
  project_id: string
  type: string
  aggregate_id: string
  payload: string
  occurred_at: string
}

export interface KnowledgeEvent {
  sequence: number
  projectId: string
  type: string
  aggregateId: string
  payload: unknown
  occurredAt: string
}

export class EventJournal {
  constructor(private readonly database: Database.Database) {}

  listAfter(sequence: number, projectId?: string): KnowledgeEvent[] {
    const rows = projectId
      ? (this.database
          .prepare(
            `SELECT * FROM events
             WHERE sequence > ? AND project_id = ?
             ORDER BY sequence ASC`,
          )
          .all(sequence, projectId) as EventRow[])
      : (this.database
          .prepare('SELECT * FROM events WHERE sequence > ? ORDER BY sequence ASC')
          .all(sequence) as EventRow[])

    return rows.map((row) => ({
      sequence: row.sequence,
      projectId: row.project_id,
      type: row.type,
      aggregateId: row.aggregate_id,
      payload: JSON.parse(row.payload) as unknown,
      occurredAt: row.occurred_at,
    }))
  }
}
