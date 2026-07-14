import type Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  GitCommandRunner,
  ImportService,
  ImportServiceError,
  KnowledgeService,
  canonicalizePath,
  closeDatabase,
  openDatabase,
} from '../../src/index.js'

describe('ImportService', () => {
  let database: Database.Database
  let service: KnowledgeService
  let sandbox: string
  let dataRoot: string
  let rootA: string
  let rootB: string
  let projectAId: string
  let projectBId: string

  beforeEach(() => {
    database = openDatabase(':memory:')
    sandbox = mkdtempSync(join(tmpdir(), 'ekg-import-'))
    dataRoot = join(sandbox, 'data')
    rootA = join(sandbox, 'project-a')
    rootB = join(sandbox, 'project-b')
    mkdirSync(dataRoot)
    mkdirSync(rootA)
    mkdirSync(rootB)
    service = new KnowledgeService(database, { dataRoot })
    projectAId = service.registerProject({ name: 'A', root: rootA }).id
    projectBId = service.registerProject({ name: 'B', root: rootB }).id
  })

  afterEach(() => {
    closeDatabase(database)
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('previews only explicit bounded project files without graph or event mutations', () => {
    const markdown = join(rootA, 'incident.md')
    const report = join(rootA, 'report.json')
    writeFileSync(markdown, '# Compiler failure\n\nBuild exits with token=secret.\n')
    writeFileSync(
      report,
      JSON.stringify({
        testResults: [
          {
            name: 'build suite',
            assertionResults: [{ title: 'resolves generated module', status: 'failed' }],
          },
        ],
      }),
    )
    const before = graphCounts(database, projectAId)

    const preview = service.previewImport({
      project: { projectId: projectAId },
      sources: [
        { kind: 'file', path: markdown },
        { kind: 'file', path: report },
      ],
    })

    expect(preview.parserVersion).toMatch(/^import-parser-v\d+$/)
    expect(preview.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(preview.proposals).toHaveLength(3)
    expect(preview.proposals.every((proposal) => proposal.status === 'candidate')).toBe(true)
    expect(preview.proposals.map((proposal) => proposal.nodeType)).toEqual([
      'Problem',
      'Problem',
      'Attempt',
    ])
    expect(preview.proposals[1]?.caseTitle).toBe(preview.proposals[2]?.caseTitle)
    expect(JSON.stringify(preview)).not.toContain('secret')
    expect(graphCounts(database, projectAId)).toEqual(before)
  })

  it('rejects paths outside real project boundaries, symlink escapes, and oversized files', () => {
    const outside = join(sandbox, 'outside.md')
    const link = join(rootA, 'escape.md')
    const large = join(rootA, 'large.txt')
    writeFileSync(outside, 'outside')
    symlinkSync(outside, link)
    writeFileSync(large, Buffer.alloc(1_048_577, 'x'))

    expectImportError(
      () =>
        service.previewImport({
          project: { projectId: projectAId },
          sources: [{ kind: 'file', path: outside }],
        }),
      'PATH_OUTSIDE_PROJECT',
    )
    expectImportError(
      () =>
        service.previewImport({
          project: { projectId: projectAId },
          sources: [{ kind: 'file', path: link }],
        }),
      'PATH_OUTSIDE_PROJECT',
    )
    expectImportError(
      () =>
        service.previewImport({
          project: { projectId: projectAId },
          sources: [{ kind: 'file', path: large }],
        }),
      'SOURCE_TOO_LARGE',
    )
  })

  it('resolves Git ranges to commits and invokes git with argv and shell false', () => {
    const calls: Array<{
      file: string
      args: readonly string[]
      shell: string | boolean | undefined
    }> = []
    const outputs = [
      '1111111111111111111111111111111111111111\n',
      '2222222222222222222222222222222222222222\n',
      '2222222222222222222222222222222222222222\n',
      'commit 2222222\n\nFix compiler failure\n',
    ]
    const runner = new GitCommandRunner((file, args, options) => {
      calls.push({ file, args, shell: options.shell })
      return { status: 0, stdout: outputs.shift() ?? '', stderr: '' }
    })
    const imports = new ImportService(database, { gitRunner: runner })

    const preview = imports.preview({
      project: { projectId: projectAId },
      sources: [{ kind: 'git', range: 'release~1..release' }],
    })

    expect(preview.proposals).toHaveLength(1)
    expect(calls).toEqual([
      {
        file: 'git',
        args: ['rev-parse', '--verify', 'release~1^{commit}'],
        shell: false,
      },
      {
        file: 'git',
        args: ['rev-parse', '--verify', 'release^{commit}'],
        shell: false,
      },
      {
        file: 'git',
        args: [
          'rev-list',
          '--reverse',
          '1111111111111111111111111111111111111111..2222222222222222222222222222222222222222',
        ],
        shell: false,
      },
      {
        file: 'git',
        args: [
          'show',
          '--no-ext-diff',
          '--no-renames',
          '--format=fuller',
          '2222222222222222222222222222222222222222',
        ],
        shell: false,
      },
    ])
  })

  it('bounds aggregate Git range reads', () => {
    const commits = [
      '2222222222222222222222222222222222222222',
      '3333333333333333333333333333333333333333',
    ]
    const outputs = [
      '1111111111111111111111111111111111111111\n',
      '3333333333333333333333333333333333333333\n',
      `${commits.join('\n')}\n`,
      'x'.repeat(600_000),
      'y'.repeat(600_000),
    ]
    const imports = new ImportService(database, {
      gitRunner: new GitCommandRunner(() => ({
        status: 0,
        stdout: outputs.shift() ?? '',
        stderr: '',
      })),
    })

    expectImportError(
      () =>
        imports.preview({
          project: { projectId: projectAId },
          sources: [{ kind: 'git', range: 'base..head' }],
        }),
      'SOURCE_TOO_LARGE',
    )
  })

  it('rejects stale and expired previews without mutating the graph', () => {
    const source = join(rootA, 'notes.txt')
    writeFileSync(source, 'Original failure')
    const preview = service.previewImport({
      project: { projectId: projectAId },
      sources: [{ kind: 'file', path: source }],
    })
    const before = graphCounts(database, projectAId)
    writeFileSync(source, 'Changed failure')

    expectImportError(
      () =>
        service.applyImport({
          project: { projectId: projectAId },
          previewId: preview.previewId,
          proposalIds: [preview.proposals[0]!.id],
          operationId: 'stale-apply',
        }),
      'STALE_PREVIEW',
    )
    expect(graphCounts(database, projectAId)).toEqual(before)

    const missing = service.previewImport({
      project: { projectId: projectAId },
      sources: [{ kind: 'file', path: source }],
    })
    rmSync(source)
    expectImportError(
      () =>
        service.applyImport({
          project: { projectId: projectAId },
          previewId: missing.previewId,
          proposalIds: [missing.proposals[0]!.id],
          operationId: 'missing-source-apply',
        }),
      'STALE_PREVIEW',
    )

    const clock = { now: Date.parse('2026-07-13T20:00:00.000Z') }
    const imports = new ImportService(database, {
      now: () => new Date(clock.now),
      previewTtlMs: 10,
    })
    writeFileSync(source, 'Stable failure')
    const expiring = imports.preview({
      project: { projectId: projectAId },
      sources: [{ kind: 'file', path: source }],
    })
    clock.now += 11
    expectImportError(
      () =>
        imports.apply({
          project: { projectId: projectAId },
          previewId: expiring.previewId,
          proposalIds: [expiring.proposals[0]!.id],
          operationId: 'expired-apply',
        }),
      'EXPIRED_PREVIEW',
    )
  })

  it('applies selected proposals atomically, idempotently, and only for the owning project', () => {
    const source = join(rootA, 'cases.md')
    writeFileSync(source, '# First failure\nDetails\n\n# Second failure\nDetails\n')
    const preview = service.previewImport({
      project: { projectId: projectAId },
      sources: [{ kind: 'file', path: source }],
    })
    const selected = preview.proposals[1]!

    expectImportError(
      () =>
        service.applyImport({
          project: { projectId: projectBId },
          previewId: preview.previewId,
          proposalIds: [selected.id],
          operationId: 'wrong-owner',
        }),
      'OWNERSHIP_MISMATCH',
    )

    const first = service.applyImport({
      project: { projectId: projectAId },
      previewId: preview.previewId,
      proposalIds: [selected.id],
      operationId: 'apply-selected',
    })
    const duplicate = service.applyImport({
      project: { projectId: projectAId },
      previewId: preview.previewId,
      proposalIds: [selected.id],
      operationId: 'apply-selected',
    })
    expectImportError(
      () =>
        service.applyImport({
          project: { projectId: projectAId },
          previewId: preview.previewId,
          proposalIds: [preview.proposals[0]!.id],
          operationId: 'apply-selected',
        }),
      'OPERATION_CONFLICT',
    )

    expect(first).toMatchObject({ created: 1, proposalIds: [selected.id] })
    expect(duplicate).toEqual({ ...first, created: 0 })
    expect(graphCounts(database, projectAId)).toMatchObject({ cases: 1, nodes: 1 })
    expect(
      database.prepare('SELECT data, status FROM nodes').get() as {
        data: string
        status: string
      },
    ).toMatchObject({ status: 'candidate' })
    expect(
      JSON.parse((database.prepare('SELECT data FROM nodes').get() as { data: string }).data),
    ).toMatchObject({ summary: 'Second failure' })
  })

  it('applies grouped Problem and Attempt proposals into one candidate Case', () => {
    const report = join(rootA, 'grouped.json')
    writeFileSync(report, JSON.stringify({
      testResults: [{ name: 'build', assertionResults: [{ title: 'compiles', status: 'failed', message: 'missing module' }] }],
    }))
    const preview = service.previewImport({
      project: { projectId: projectAId }, sources: [{ kind: 'file', path: report }],
    })
    const result = service.applyImport({
      project: { projectId: projectAId }, previewId: preview.previewId,
      proposalIds: preview.proposals.map((proposal) => proposal.id), operationId: 'grouped-apply',
    })

    expect(new Set(result.caseIds)).toHaveLength(1)
    expect(graphCounts(database, projectAId)).toMatchObject({ cases: 1, nodes: 2, edges: 1 })
    expect(database.prepare(
      'SELECT COUNT(*) AS count FROM events WHERE project_id = ? AND case_id = ?',
    ).get(projectAId, result.caseIds[0])).toEqual({ count: 4 })
  })

  it('exports a recursively redacted versioned archive and imports it repeat-safely', () => {
    const problem = service.recordProblem({
      project: { projectId: projectAId },
      caseTitle: 'Portable case',
      data: {
        summary: 'token=graph-secret',
        symptoms: ['password=nested-secret'],
      },
    })
    database
      .prepare(
        `INSERT INTO artifacts
         (id, project_id, node_id, kind, uri, digest, is_external, metadata, created_at)
         VALUES (?, ?, NULL, ?, ?, NULL, 0, ?, ?)`,
      )
      .run(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        projectAId,
        'report',
        join(rootA, 'build.log'),
        JSON.stringify({
          nested: { apiKey: 'artifact-secret' },
          rawLogPath: '/tmp/raw.log',
          raw_log_path: '/tmp/raw-snake.log',
        }),
        new Date().toISOString(),
      )

    const archive = service.exportProjectGraph({ project: { projectId: projectAId } })
    const serialized = JSON.stringify(archive)

    expect(archive).toMatchObject({
      format: 'engineering-knowledge-graph',
      version: 1,
      project: { id: projectAId, name: 'A' },
    })
    expect(archive).toHaveProperty('cases')
    expect(archive).toHaveProperty('nodes')
    expect(archive).toHaveProperty('edges')
    expect(archive).toHaveProperty('evidence')
    expect(archive).toHaveProperty('fingerprints')
    expect(archive).toHaveProperty('guardrails')
    expect(archive).toHaveProperty('artifacts')
    expect(serialized).not.toContain(rootA)
    expect(serialized).not.toContain('graph-secret')
    expect(serialized).not.toContain('nested-secret')
    expect(serialized).not.toContain('artifact-secret')
    expect(serialized).not.toContain('rawLogPath')
    expect(serialized).not.toContain('raw_log_path')

    const first = service.importProjectGraph({
      project: { projectId: projectBId },
      archive,
      operationId: 'snapshot-import-1',
    })
    const repeated = service.importProjectGraph({
      project: { projectId: projectBId },
      archive,
      operationId: 'snapshot-import-2',
    })

    expect(first.created).toMatchObject({ cases: 1, nodes: 1, artifacts: 1 })
    expect(repeated.created).toMatchObject({ cases: 0, nodes: 0, artifacts: 0 })
    expect(first.idMap[projectAId]).toBe(projectBId)
    expect(first.idMap[problem.caseId]).toBe(repeated.idMap[problem.caseId])
    expect(graphCounts(database, projectBId)).toMatchObject({ cases: 1, nodes: 1 })
  })

  it('validates the full snapshot before any mutation', () => {
    service.recordProblem({
      project: { projectId: projectAId },
      caseTitle: 'Source case',
      data: { summary: 'Source problem' },
    })
    const archive = service.exportProjectGraph({ project: { projectId: projectAId } })
    const malformed = structuredClone(archive)
    malformed.nodes.push({
      id: 'not-a-uuid',
      caseId: 'missing-case',
      type: 'Problem',
      status: 'candidate',
      data: { summary: 'Bad' },
      createdAt: new Date().toISOString(),
    })
    const before = graphCounts(database, projectBId)

    expectImportError(
      () =>
        service.importProjectGraph({
          project: { projectId: projectBId },
          archive: malformed,
          operationId: 'malformed-import',
        }),
      'INVALID_ARCHIVE',
    )
    expect(graphCounts(database, projectBId)).toEqual(before)

    const structurallyMalformed = structuredClone(archive) as unknown as Record<string, unknown>
    structurallyMalformed.cases = [null]
    expectImportError(
      () =>
        service.importProjectGraph({
          project: { projectId: projectBId },
          archive: structurallyMalformed as never,
          operationId: 'structurally-malformed-import',
        }),
      'INVALID_ARCHIVE',
    )
    expect(graphCounts(database, projectBId)).toEqual(before)

    const invalidRelation = structuredClone(archive)
    invalidRelation.nodes.push({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      caseId: invalidRelation.cases[0]!.id,
      type: 'Attempt',
      status: 'candidate',
      data: { hypothesis: 'Try it', change: 'Changed it', outcome: 'failed' },
      createdAt: new Date().toISOString(),
    })
    invalidRelation.edges.push({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      caseId: invalidRelation.cases[0]!.id,
      sourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      relation: 'ADDRESSES',
      targetId: invalidRelation.nodes[0]!.id,
      createdAt: new Date().toISOString(),
    })
    expectImportError(
      () =>
        service.importProjectGraph({
          project: { projectId: projectBId },
          archive: invalidRelation,
          operationId: 'invalid-relation-import',
        }),
      'INVALID_ARCHIVE',
    )
    expect(graphCounts(database, projectBId)).toEqual(before)
  })

  it('validates local snapshot artifact URIs atomically and preserves external references', () => {
    const problem = service.recordProblem({
      project: { projectId: projectAId },
      caseTitle: 'Artifact source',
      data: { summary: 'Source problem' },
    })
    database.prepare(`
      INSERT INTO nodes (id, case_id, type, status, data, created_at)
      VALUES (?, ?, 'Artifact', 'candidate', ?, ?)
    `).run(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      problem.caseId,
      JSON.stringify({ kind: 'report', uri: join(rootA, 'report.json') }),
      '2026-07-13T20:00:00.000Z',
    )
    database.prepare(`
      INSERT INTO artifacts
        (id, project_id, node_id, kind, uri, digest, is_external, metadata, created_at)
      VALUES (?, ?, ?, 'report', ?, NULL, 0, '{}', ?)
    `).run(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      projectAId,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      join(rootA, 'report.json'),
      '2026-07-13T20:00:00.000Z',
    )
    const archive = service.exportProjectGraph({ project: { projectId: projectAId } })
    const outside = join(sandbox, 'outside')
    const linked = join(rootB, 'linked')
    mkdirSync(outside)
    symlinkSync(outside, linked, 'dir')
    const before = snapshotCounts(database, projectBId)

    for (const [operationId, uri] of [
      ['snapshot-etc-path', '/etc/ekg-report.json'],
      ['snapshot-sibling-path', join(rootA, 'report.json')],
      ['snapshot-symlink-path', join(linked, 'report.json')],
    ] as const) {
      const invalid = structuredClone(archive)
      invalid.artifacts[0]!.uri = uri
      expectImportError(() => service.importProjectGraph({
        project: { projectId: projectBId }, archive: invalid, operationId,
      }), 'PATH_OUTSIDE_PROJECT')
      expect(snapshotCounts(database, projectBId)).toEqual(before)
    }

    const mismatchedNodeUri = structuredClone(archive)
    mismatchedNodeUri.artifacts[0]!.uri = join(rootB, 'report.json')
    mismatchedNodeUri.nodes.find((node) => node.type === 'Artifact')!.data.uri = '/etc/node-report.json'
    expectImportError(() => service.importProjectGraph({
      project: { projectId: projectBId }, archive: mismatchedNodeUri,
      operationId: 'snapshot-invalid-node-uri',
    }), 'PATH_OUTSIDE_PROJECT')
    expect(snapshotCounts(database, projectBId)).toEqual(before)

    const valid = structuredClone(archive)
    valid.artifacts[0]!.uri = join(rootB, 'reports', '..', 'report.json')
    valid.nodes.find((node) => node.type === 'Artifact')!.data.uri = join(rootB, 'reports', '..', 'report.json')
    service.importProjectGraph({
      project: { projectId: projectBId }, archive: valid, operationId: 'snapshot-valid-local-path',
    })
    expect(database.prepare('SELECT uri FROM artifacts WHERE project_id = ?').get(projectBId))
      .toEqual({ uri: canonicalizePath(join(rootB, 'report.json')) })

    const external = structuredClone(archive)
    external.artifacts[0]!.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    external.artifacts[0]!.uri = '/etc/external-reference.json'
    external.artifacts[0]!.isExternal = true
    external.nodes.find((node) => node.type === 'Artifact')!.data.uri = '/etc/external-reference.json'
    const rootC = join(sandbox, 'project-c')
    mkdirSync(rootC)
    const projectCId = service.registerProject({ name: 'C', root: rootC }).id
    service.importProjectGraph({
      project: { projectId: projectCId }, archive: external, operationId: 'snapshot-external-reference',
    })
    expect(database.prepare('SELECT uri, is_external FROM artifacts WHERE project_id = ? AND uri = ?')
      .get(projectCId, '/etc/external-reference.json'))
      .toEqual({ uri: '/etc/external-reference.json', is_external: 1 })
    const externalNode = database.prepare(`
      SELECT nodes.data FROM nodes JOIN cases ON cases.id = nodes.case_id
      WHERE cases.project_id = ? AND nodes.type = 'Artifact'
    `).get(projectCId) as { data: string }
    expect(JSON.parse(externalNode.data)).toMatchObject({ uri: '/etc/external-reference.json' })
  })

  it('redacts incoming snapshots before persistence and rejects oversized archives', () => {
    service.recordProblem({
      project: { projectId: projectAId },
      data: { summary: 'Source problem' },
    })
    const archive = service.exportProjectGraph({ project: { projectId: projectAId } })
    archive.nodes[0]!.data = {
      summary: 'token=import-secret',
      symptoms: ['--password separate-secret'],
    }
    service.importProjectGraph({
      project: { projectId: projectBId }, archive, operationId: 'redacted-import',
    })
    expect(JSON.stringify(database.prepare(`
      SELECT nodes.data, node_search.body FROM nodes
      JOIN cases ON cases.id = nodes.case_id
      JOIN node_search ON node_search.node_id = nodes.id
      WHERE cases.project_id = ?
    `).all(projectBId))).not.toMatch(/import-secret|separate-secret/)

    const oversized = structuredClone(archive)
    oversized.project.description = 'x'.repeat(2 * 1024 * 1024)
    expectImportError(() => service.importProjectGraph({
      project: { projectId: projectBId }, archive: oversized, operationId: 'oversized-import',
    }), 'INVALID_ARCHIVE')
  })

  it('downgrades imported trusted assertions to candidates, including blocking Guardrails', () => {
    const problem = service.recordProblem({ project: { projectId: projectAId }, data: { summary: 'Failure' } })
    const records = [
      ['11111111-1111-4111-8111-111111111111', 'RootCause', { explanation: 'Cause', evidence: ['asserted'], confidence: 1 }],
      ['22222222-2222-4222-8222-222222222222', 'Solution', { summary: 'Fix', applicability: ['all'], limitations: ['none'], decisiveDifference: 'Changed it' }],
      ['33333333-3333-4333-8333-333333333333', 'SuccessCase', { summary: 'Success' }],
      ['44444444-4444-4444-8444-444444444444', 'Guardrail', { guidance: 'Never run it', enforcement: 'block', criteria: { commandIncludes: ['npm'] } }],
    ] as const
    const createdAt = '2026-07-13T20:00:00.000Z'
    const insertNode = database.prepare('INSERT INTO nodes (id, case_id, type, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    for (const [id, type, data] of records) insertNode.run(id, problem.caseId, type, 'verified', JSON.stringify(data), createdAt)
    database.prepare('UPDATE cases SET status = ? WHERE id = ?').run('verified', problem.caseId)
    database.prepare('INSERT INTO guardrails (id, project_id, node_id, enforcement, criteria, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('55555555-5555-4555-8555-555555555555', projectAId, records[3][0], 'block', JSON.stringify({ commandIncludes: ['npm'] }), createdAt)

    const archive = service.exportProjectGraph({ project: { projectId: projectAId } })
    const imported = service.importProjectGraph({
      project: { projectId: projectBId }, archive, operationId: 'untrusted-snapshot',
    })
    const importedCase = database.prepare('SELECT status FROM cases WHERE id = ?').get(imported.idMap[problem.caseId]) as { status: string }
    const importedNodes = database.prepare(`SELECT type, status FROM nodes WHERE id IN (?, ?, ?, ?) ORDER BY type`)
      .all(...records.map(([id]) => imported.idMap[id])) as Array<{ type: string; status: string }>

    expect(importedCase.status).toBe('candidate')
    expect(importedNodes).toEqual([
      { type: 'Guardrail', status: 'candidate' },
      { type: 'RootCause', status: 'candidate' },
      { type: 'Solution', status: 'candidate' },
      { type: 'SuccessCase', status: 'candidate' },
    ])
    const preflight = service.preflight({
      project: { projectId: projectBId }, taskDescription: 'run npm', command: ['npm', 'test'], limit: 1,
    })
    expect(preflight.blocked).toBe(false)
  })

  it('bounds structure before recursive redaction and rejects oversized export collections', () => {
    const archive = service.exportProjectGraph({ project: { projectId: projectAId } })
    const deeplyNested: Record<string, unknown> = {}
    let cursor = deeplyNested
    for (let depth = 0; depth < 20_000; depth += 1) {
      const next: Record<string, unknown> = {}
      cursor.next = next
      cursor = next
    }
    archive.project.description = deeplyNested as unknown as string
    expectImportError(() => service.importProjectGraph({
      project: { projectId: projectBId }, archive, operationId: 'deep-import',
    }), 'INVALID_ARCHIVE')

    const insertCase = database.prepare('INSERT INTO cases (id, project_id, title, status, created_at) VALUES (?, ?, ?, ?, ?)')
    database.transaction(() => {
      for (let index = 0; index <= 10_000; index += 1) {
        insertCase.run(`case-${index}`, projectAId, `Case ${index}`, 'open', '2026-07-13T20:00:00.000Z')
      }
    })()
    expectImportError(() => service.exportProjectGraph({ project: { projectId: projectAId } }), 'INVALID_ARCHIVE')
  })

  it('rejects exports whose aggregate encoded bytes exceed the archive limit', () => {
    const problem = service.recordProblem({ project: { projectId: projectAId }, data: { summary: 'Small' } })
    database.prepare('UPDATE nodes SET data = ? WHERE id = ?')
      .run(JSON.stringify({ summary: 'x'.repeat(2 * 1024 * 1024) }), problem.nodeId)

    expectImportError(() => service.exportProjectGraph({ project: { projectId: projectAId } }), 'INVALID_ARCHIVE')
  })
})

function graphCounts(database: Database.Database, projectId: string): {
  cases: number
  nodes: number
  edges: number
  events: number
} {
  const count = (table: 'cases' | 'nodes' | 'edges' | 'events'): number => {
    const joins =
      table === 'nodes' || table === 'edges'
        ? ` JOIN cases ON cases.id = ${table}.case_id WHERE cases.project_id = ?`
        : ' WHERE project_id = ?'
    return (
      database.prepare(`SELECT count(*) AS count FROM ${table}${joins}`).get(projectId) as {
        count: number
      }
    ).count
  }
  return { cases: count('cases'), nodes: count('nodes'), edges: count('edges'), events: count('events') }
}

function snapshotCounts(database: Database.Database, projectId: string): Record<string, number> {
  return Object.fromEntries(
    ['cases', 'nodes', 'edges', 'artifacts', 'events', 'operation_results'].map((table) => {
      const joins = table === 'nodes' || table === 'edges'
        ? ` JOIN cases ON cases.id = ${table}.case_id WHERE cases.project_id = ?`
        : ' WHERE project_id = ?'
      const row = database.prepare(`SELECT count(*) AS count FROM ${table}${joins}`).get(projectId) as {
        count: number
      }
      return [table, row.count]
    }),
  )
}

function expectImportError(operation: () => unknown, code: ImportServiceError['code']): void {
  try {
    operation()
    throw new Error(`Expected ImportServiceError ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ImportServiceError)
    expect((error as ImportServiceError).code).toBe(code)
  }
}
