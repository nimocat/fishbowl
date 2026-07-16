import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import Database from 'better-sqlite3'

import { KnowledgeService } from '../dist/application/knowledge-service.js'

const root = mkdtempSync(join(tmpdir(), 'ekg-rust-shadow-'))
const databasePath = join(root, 'knowledge.db')
let projectARoot = join(root, 'project-a')
let projectAAlias = join(root, 'project-a-worktree')
let projectBRoot = join(root, 'project-b')
mkdirSync(projectARoot)
mkdirSync(projectAAlias)
mkdirSync(projectBRoot)
projectARoot = realpathSync(projectARoot)
projectAAlias = realpathSync(projectAAlias)
projectBRoot = realpathSync(projectBRoot)
const database = new Database(databasePath)
database.exec(`
  PRAGMA user_version = 7;
  PRAGMA application_id = 1162561281;
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, description TEXT, canonical_root TEXT, created_at TEXT);
  CREATE TABLE project_aliases (id TEXT PRIMARY KEY, project_id TEXT, root TEXT, created_at TEXT);
  CREATE TABLE cases (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT, created_at TEXT);
  CREATE TABLE nodes (id TEXT PRIMARY KEY, case_id TEXT, type TEXT, status TEXT, data TEXT, created_at TEXT);
  CREATE TABLE fingerprints (id TEXT PRIMARY KEY, project_id TEXT, problem_node_id TEXT, algorithm TEXT, value TEXT, created_at TEXT);
  CREATE TABLE command_runs (id TEXT PRIMARY KEY, project_id TEXT, case_id TEXT, attempt_node_id TEXT, command TEXT, working_directory TEXT, exit_status INTEGER, signal TEXT, duration_ms INTEGER, excerpt TEXT, raw_log_path TEXT, raw_log_digest TEXT, started_at TEXT, finished_at TEXT);
  CREATE TABLE guardrails (id TEXT PRIMARY KEY, project_id TEXT, node_id TEXT, enforcement TEXT, criteria TEXT, created_at TEXT);
  CREATE TABLE events (sequence INTEGER PRIMARY KEY, project_id TEXT, case_id TEXT);
  CREATE VIRTUAL TABLE node_search USING fts5(project_id UNINDEXED, node_id UNINDEXED, title, body, tokenize='unicode61');
  INSERT INTO projects VALUES ('project-a','A',NULL,'/synthetic/a','2026-07-16T00:00:00Z');
  INSERT INTO projects VALUES ('project-b','B',NULL,'/synthetic/b','2026-07-16T00:00:00Z');
  INSERT INTO project_aliases VALUES ('alias-a','project-a','/synthetic/a-worktree','2026-07-16T00:00:00Z');
  INSERT INTO cases VALUES ('case-camera','project-a','Camera lifecycle','verified','2026-07-16T00:00:00Z');
  INSERT INTO cases VALUES ('case-chinese','project-a','相机预览','candidate','2026-07-15T00:00:00Z');
  INSERT INTO cases VALUES ('case-other','project-b','Other project','verified','2026-07-16T00:00:00Z');
  INSERT INTO cases VALUES ('case-policy','project-a','CoreML device policy','verified','2026-07-16T00:00:00Z');
  INSERT INTO nodes VALUES ('problem-camera','case-camera','Problem','open','{"summary":"camera session hang","domain":"ios","file":"CameraView.swift"}','2026-07-16T00:00:00Z');
  INSERT INTO nodes VALUES ('solution-camera','case-camera','Solution','verified','{"summary":"camera session fix","file":"CameraView.swift","command":"xcodebuild"}','2026-07-16T00:02:00Z');
  INSERT INTO nodes VALUES ('problem-chinese','case-chinese','Problem','open','{"summary":"相机预览会话卡顿","domain":"ios"}','2026-07-15T00:00:00Z');
  INSERT INTO nodes VALUES ('solution-other','case-other','Solution','verified','{"summary":"camera session fix"}','2026-07-16T00:03:00Z');
  INSERT INTO nodes VALUES ('guard-policy','case-policy','Guardrail','verified','{"guidance":"CoreML physical device only"}','2026-07-16T00:04:00Z');
  INSERT INTO node_search VALUES ('project-a','problem-camera','Camera lifecycle','camera session hang ios CameraView.swift');
  INSERT INTO node_search VALUES ('project-a','solution-camera','Camera lifecycle','camera session fix CameraView.swift xcodebuild');
  INSERT INTO node_search VALUES ('project-a','problem-chinese','相机预览','相机预览会话卡顿 ios');
  INSERT INTO node_search VALUES ('project-b','solution-other','Other project','camera session fix');
  INSERT INTO node_search VALUES ('project-a','guard-policy','CoreML device policy','CoreML physical device xcodebuild Inference.swift');
  INSERT INTO fingerprints VALUES ('fp-camera','project-a','problem-camera','v1','camera hang','2026-07-16T00:00:00Z');
  INSERT INTO command_runs VALUES ('run-camera','project-a','case-camera',NULL,'["xcodebuild"]','/synthetic/a',0,NULL,1,'pass',NULL,NULL,'2026-07-16T00:00:00Z','2026-07-16T00:00:00Z');
  INSERT INTO guardrails VALUES ('rule-policy','project-a','guard-policy','block','{"taskIncludes":["CoreML"],"commandIncludes":["xcodebuild"],"fileIncludes":["Inference.swift"]}','2026-07-16T00:04:00Z');
`)
database.prepare('UPDATE projects SET canonical_root = ? WHERE id = ?').run(projectARoot, 'project-a')
database.prepare('UPDATE projects SET canonical_root = ? WHERE id = ?').run(projectBRoot, 'project-b')
database.prepare('UPDATE project_aliases SET root = ? WHERE id = ?').run(projectAAlias, 'alias-a')

const service = new KnowledgeService(database, { dataRoot: root })
const binary = join(process.cwd(), 'target/release/ekg-rust-core')
const child = spawn(binary, [databasePath], { stdio: ['pipe', 'pipe', 'inherit'] })
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
const templates = [
  { project: { projectId: 'project-a' }, text: 'camera session', limit: 20 },
  { project: { projectRoot: projectAAlias }, text: '相机预览', limit: 20 },
  { project: { projectId: 'project-a' }, nodeTypes: ['Solution'], statuses: ['verified'], limit: 20 },
  { project: { projectId: 'project-a' }, domain: 'ios', limit: 20 },
  { project: { projectId: 'project-a' }, file: 'CameraView.swift', limit: 20 },
  { project: { projectId: 'project-a' }, command: 'xcodebuild', limit: 20 },
  { project: { projectId: 'project-a' }, fingerprint: 'camera hang', limit: 20 },
  { project: { projectId: 'project-a' }, limit: 1 },
  { project: { projectId: 'project-b' }, text: 'camera session', limit: 20 },
  { project: { projectId: 'project-a' }, text: 'camera', domain: 'ios', nodeTypes: ['Problem'], limit: 20 },
]

const durations = []
let mismatches = 0
const mismatchDiagnostics = []
const preflightDurations = []
let preflightMismatches = 0
try {
  for (let index = 0; index < 1000; index += 1) {
    const input = templates[index % templates.length]
    const expected = service.queryKnowledge(input)
    const request = {
      protocolVersion: 1,
      requestId: `shadow-${index}`,
      operation: 'queryKnowledge',
      input,
    }
    const started = process.hrtime.bigint()
    child.stdin.write(`${JSON.stringify(request)}\n`)
    const next = await lines.next()
    durations.push(Number(process.hrtime.bigint() - started) / 1_000_000)
    if (next.done) throw new Error('Rust daemon closed before completing shadow replay')
    const response = JSON.parse(next.value)
    if (!response.ok || canonicalJson(response.result) !== canonicalJson(expected)) {
      mismatches += 1
      if (mismatchDiagnostics.length < 20) {
        mismatchDiagnostics.push({
          requestId: request.requestId,
          reason: response.ok ? 'RESULT_MISMATCH' : 'RUST_FAILURE',
        })
      }
    }
  }
  const preflightTemplates = [
    { project: { projectId: 'project-a' }, taskDescription: 'CoreML physical device', changedFiles: ['Inference.swift'], command: ['xcodebuild'], limit: 5 },
    { project: { projectId: 'project-a' }, taskDescription: 'camera lifecycle', changedFiles: ['CameraView.swift'], limit: 5 },
    { project: { projectId: 'project-a' }, taskDescription: 'camera hang', fingerprint: 'camera hang', limit: 5 },
    { project: { projectRoot: projectAAlias }, taskDescription: '相机预览会话卡顿', limit: 5 },
    { project: { projectId: 'project-a' }, taskDescription: 'build test fix', limit: 5 },
  ]
  for (let index = 0; index < 1000; index += 1) {
    const input = preflightTemplates[index % preflightTemplates.length]
    const expected = service.preflight(input)
    const request = {
      protocolVersion: 1,
      requestId: `preflight-shadow-${index}`,
      operation: 'preflight',
      input,
    }
    const started = process.hrtime.bigint()
    child.stdin.write(`${JSON.stringify(request)}\n`)
    const next = await lines.next()
    preflightDurations.push(Number(process.hrtime.bigint() - started) / 1_000_000)
    if (next.done) throw new Error('Rust daemon closed before completing preflight shadow replay')
    const response = JSON.parse(next.value)
    if (!response.ok || canonicalJson(response.result) !== canonicalJson(expected)) {
      preflightMismatches += 1
      if (mismatchDiagnostics.length < 20) {
        mismatchDiagnostics.push({
          requestId: request.requestId,
          reason: response.ok ? 'PREFLIGHT_RESULT_MISMATCH' : 'RUST_FAILURE',
        })
      }
    }
  }
} finally {
  child.stdin.end()
  database.close()
  rmSync(root, { recursive: true, force: true })
}

durations.sort((left, right) => left - right)
const p50 = durations[499]
const p95 = durations[949]
const p99 = durations[989]
preflightDurations.sort((left, right) => left - right)
const preflightP50 = preflightDurations[499]
const preflightP95 = preflightDurations[949]
const preflightP99 = preflightDurations[989]
console.log(`EKG_RUST_QUERY_SHADOW count=1000 mismatches=${mismatches} p50_ms=${p50.toFixed(3)} p95_ms=${p95.toFixed(3)} p99_ms=${p99.toFixed(3)}`)
console.log(`EKG_RUST_PREFLIGHT_SHADOW count=1000 mismatches=${preflightMismatches} p50_ms=${preflightP50.toFixed(3)} p95_ms=${preflightP95.toFixed(3)} p99_ms=${preflightP99.toFixed(3)}`)
if (mismatchDiagnostics.length > 0) console.error(JSON.stringify(mismatchDiagnostics))
if (mismatches !== 0) process.exitCode = 1
if (preflightMismatches !== 0) process.exitCode = 1
if (p95 >= 50) process.exitCode = 1
if (preflightP95 >= 50) process.exitCode = 1

function canonicalJson(value) {
  return JSON.stringify(sortObjectKeys(value))
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortObjectKeys(value[key])]),
  )
}
