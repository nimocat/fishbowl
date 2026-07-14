import type Database from 'better-sqlite3'

const SEARCH_TERM = /[\p{L}\p{N}_.-]+/gu
const FTS_OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR'])

function terms(text: string): string[] {
  return [...new Set((text.match(SEARCH_TERM) ?? []).filter(
    (term) => !FTS_OPERATORS.has(term.toLocaleUpperCase()),
  ))]
}

function quotedPrefix(term: string): string {
  return `"${term.replaceAll('"', '""')}"*`
}

export function buildFtsQuery(text: string): string | null {
  const selected = terms(text.trim())
  return selected.length > 0 ? selected.map(quotedPrefix).join(' AND ') : null
}

export function buildFtsCandidateQuery(text: string): string | null {
  const selected = terms(text.trim())
  return selected.length > 0 ? selected.map(quotedPrefix).join(' OR ') : null
}

export function matchingCaseIds(
  database: Database.Database,
  projectId: string,
  text: string,
  limit: number,
): string[] {
  return runCaseMatch(database, projectId, buildFtsQuery(text), limit)
}

export function matchingCandidateCaseIds(
  database: Database.Database,
  projectId: string,
  text: string,
  limit: number,
): string[] {
  return runCaseMatch(database, projectId, buildFtsCandidateQuery(text), limit)
}

export function matchingFingerprintCaseIds(
  database: Database.Database,
  projectId: string,
  fingerprint: string,
): string[] {
  const rows = database.prepare(
    `SELECT nodes.case_id
     FROM fingerprints
     JOIN nodes ON nodes.id = fingerprints.problem_node_id
     JOIN cases ON cases.id = nodes.case_id
     WHERE fingerprints.project_id = ?
       AND cases.project_id = ?
       AND fingerprints.value = ?`,
  ).all(projectId, projectId, fingerprint) as Array<{ case_id: string }>
  return [...new Set(rows.map((row) => row.case_id))]
}

function runCaseMatch(
  database: Database.Database,
  projectId: string,
  query: string | null,
  limit: number,
): string[] {
  if (!query) return []
  const rows = database.prepare(
    `SELECT nodes.case_id
     FROM node_search
     JOIN nodes ON nodes.id = node_search.node_id
     JOIN cases ON cases.id = nodes.case_id
     WHERE node_search MATCH ? AND cases.project_id = ?
     ORDER BY bm25(node_search), nodes.created_at DESC
     LIMIT ?`,
  ).all(query, projectId, Math.max(limit, 1) * 4) as Array<{ case_id: string }>
  return [...new Set(rows.map((row) => row.case_id))].slice(0, limit)
}
