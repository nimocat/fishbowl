import type Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  KnowledgeService,
  KnowledgeServiceError,
  canonicalizePath,
  closeDatabase,
  openDatabase,
} from '../../src/index.js'

describe('KnowledgeService', () => {
  let database: Database.Database
  let service: KnowledgeService
  let sandbox: string
  let dataRoot: string
  let rootA: string
  let rootB: string

  beforeEach(() => {
    database = openDatabase(':memory:')
    sandbox = mkdtempSync(join(tmpdir(), 'ekg-knowledge-service-'))
    dataRoot = join(sandbox, 'data')
    rootA = join(sandbox, 'project-a')
    rootB = join(sandbox, 'project-b')
    mkdirSync(dataRoot)
    mkdirSync(rootA)
    mkdirSync(rootB)
    service = new KnowledgeService(database, { dataRoot })
  })

  afterEach(() => {
    closeDatabase(database)
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('provides project registration, listing, resolution, and transactional updates', () => {
    const alias = join(sandbox, 'project-a-worktree')
    mkdirSync(alias)
    const project = service.registerProject({
      name: 'Project A',
      root: rootA,
      description: 'Initial',
    })

    const updated = service.updateProject({
      project: { projectId: project.id },
      name: 'Project Alpha',
      description: 'token=project-secret',
      addAlias: alias,
    })

    expect(updated).toMatchObject({
      id: project.id,
      name: 'Project Alpha',
      description: 'token=[REDACTED]',
      aliases: [{ projectId: project.id }],
    })
    expect(service.listProjects()).toEqual([updated])
    expect(service.resolveProject({ projectRoot: alias }).id).toBe(project.id)
    expectServiceError(
      () => service.resolveProject({ projectId: 'missing-project' }),
      'NOT_FOUND',
    )
    expectServiceError(
      () => service.registerProject({ name: 'Duplicate', root: rootA }),
      'CONFLICT',
    )
    expect(
      database.prepare("SELECT type FROM events WHERE type = 'project.updated'").all(),
    ).toHaveLength(1)
  })

  it('returns compact Case graphs by default and pages full indexed history', () => {
    const registered = service.registerProject({ name: 'Project A', root: rootA })
    const project = { projectId: registered.id }
    const problem = service.recordProblem({
      project,
      caseTitle: 'Large diagnostic Case',
      data: { summary: 'Streaming analysis is slow', domain: 'performance' },
    })
    for (let index = 0; index < 30; index += 1) {
      service.recordAttempt({
        project,
        caseId: problem.caseId,
        problemId: problem.nodeId,
        data: {
          hypothesis: `Probe ${index}`,
          change: 'Measure one bounded window',
          outcome: 'failed',
          failureExplanation: 'Synthetic performance fixture',
        },
      })
    }

    const graph = service.getCase({ project, caseId: problem.caseId })
    expect(graph.detail).toBe('graph')
    expect(graph.nodes).toHaveLength(31)
    expect(graph.history).toEqual([])
    expect(graph.historyNextBeforeSequence).toBeNull()
    expect(graph.counts).toMatchObject({ nodes: 31, edges: 30 })
    expect(Buffer.byteLength(JSON.stringify(graph))).toBeLessThan(128 * 1024)

    const full = service.getCase({
      project,
      caseId: problem.caseId,
      detail: 'full',
      historyLimit: 10,
    })
    expect(full.history).toHaveLength(10)
    expect(full.historyNextBeforeSequence).toBe(full.history[0]?.sequence)

    const older = service.getCase({
      project,
      caseId: problem.caseId,
      detail: 'full',
      historyLimit: 10,
      historyBeforeSequence: full.historyNextBeforeSequence as number,
    })
    expect(older.history.at(-1)?.sequence).toBeLessThan(full.history[0]?.sequence as number)

    const summary = service.getCase({
      project,
      caseId: problem.caseId,
      detail: 'summary',
    })
    expect(summary.nodes).toEqual([])
    expect(summary.edges).toEqual([])
    expect(summary.counts.nodes).toBe(31)
  })

  it('records bounded checkpoints atomically and retries them idempotently', () => {
    const projectA = service.registerProject({ name: 'Project A', root: rootA })
    const projectB = service.registerProject({ name: 'Project B', root: rootB })
    const problemA = service.recordProblem({
      project: { projectId: projectA.id },
      data: { summary: 'A failure' },
    })
    const problemB = service.recordProblem({
      project: { projectId: projectB.id },
      data: { summary: 'B failure' },
    })
    const before = countKnowledgeRows()

    const checkpointFailure = expectServiceError(() => service.recordCheckpoint({
      project: { projectId: projectA.id },
      operationId: 'invalid-checkpoint',
      writes: [
        {
          kind: 'attempt',
          input: {
            caseId: problemA.caseId,
            problemId: problemA.nodeId,
            data: { hypothesis: 'A1', change: 'Probe A1', outcome: 'failed' },
          },
        },
        {
          kind: 'attempt',
          input: {
            caseId: problemB.caseId,
            problemId: problemB.nodeId,
            data: { hypothesis: 'B1', change: 'Probe B1', outcome: 'failed' },
          },
        },
      ],
    }), 'OWNERSHIP_MISMATCH')
    expect(checkpointFailure.details).toEqual({ itemIndex: 1, kind: 'attempt' })
    expect(countKnowledgeRows()).toEqual(before)

    const unsupportedFailure = expectServiceError(() => service.recordCheckpoint({
      project: { projectId: projectA.id },
      operationId: 'unsupported-checkpoint',
      writes: [{ kind: 'token=checkpoint-secret', input: {} }],
    } as never), 'VALIDATION_FAILED')
    expect(unsupportedFailure.details).toEqual({ itemIndex: 0, kind: 'unknown' })
    expect(countKnowledgeRows()).toEqual(before)

    const input = {
      project: { projectId: projectA.id },
      operationId: 'valid-checkpoint',
      writes: [
        {
          kind: 'attempt' as const,
          input: {
            caseId: problemA.caseId,
            problemId: problemA.nodeId,
            operationId: 'checkpoint-attempt-1',
            data: { hypothesis: 'A1', change: 'Probe A1', outcome: 'failed' as const },
          },
        },
        {
          kind: 'attempt' as const,
          input: {
            caseId: problemA.caseId,
            problemId: problemA.nodeId,
            operationId: 'checkpoint-attempt-2',
            data: { hypothesis: 'A2', change: 'Probe A2', outcome: 'inconclusive' as const },
          },
        },
      ],
    }
    const created = service.recordCheckpoint(input)
    expect(created.created).toBe(true)
    expect(created.results).toHaveLength(2)
    expect(service.recordCheckpoint(input)).toEqual({ ...created, created: false })
  })

  it('records a complete two-project troubleshooting journey and preserves history on regression', () => {
    const projectA = service.registerProject({ name: 'Project A', root: rootA })
    const projectB = service.registerProject({ name: 'Project B', root: rootB })
    const project = { projectId: projectA.id }
    const rawFingerprint = `${rootA}/src/build.ts:91:4 failed at 2026-07-13T20:00:00Z token=fingerprint-secret`

    const problem = service.recordProblem({
      project,
      caseTitle: 'Build cannot resolve generated module',
      operationId: 'problem-operation',
      sourceKey: { kind: 'manual', key: 'build-module-failure' },
      data: {
        summary: 'Generated module missing; password=summary-secret',
        symptoms: ['Build exits 1'],
        domain: 'build',
        fingerprint: rawFingerprint,
      },
    })
    const duplicateProblem = service.recordProblem({
      project,
      caseTitle: 'Ignored duplicate title',
      operationId: 'problem-operation',
      data: { summary: 'Ignored duplicate payload' },
    })

    expect(duplicateProblem).toEqual({ ...problem, created: false })

    const firstAttempt = service.recordAttempt({
      project,
      caseId: problem.caseId,
      problemId: problem.nodeId,
      operationId: 'attempt-1',
      data: {
        hypothesis: 'The cache is stale',
        change: 'Cleared the cache',
        outcome: 'failed',
        command: ['npm', 'run', 'clean'],
        failureExplanation: 'Generated source was still absent',
      },
    })
    const secondAttempt = service.recordAttempt({
      project,
      caseId: problem.caseId,
      problemId: problem.nodeId,
      previousAttemptId: firstAttempt.nodeId,
      data: {
        hypothesis: 'Dependencies are stale',
        change: 'Reinstalled dependencies',
        outcome: 'failed',
        command: ['npm', 'install'],
        failureExplanation: 'Generation still did not run',
      },
    })
    const successfulAttempt = service.recordAttempt({
      project,
      caseId: problem.caseId,
      problemId: problem.nodeId,
      previousAttemptId: secondAttempt.nodeId,
      data: {
        hypothesis: 'Generation must run before compilation',
        change: 'Added the generation step',
        outcome: 'succeeded',
        decisiveDifference: 'Runs generation before compilation',
      },
    })
    const cause = service.recordRootCause({
      project,
      caseId: problem.caseId,
      problemId: problem.nodeId,
      failedAttemptIds: [firstAttempt.nodeId, secondAttempt.nodeId],
      status: 'verified',
      humanConfirmed: true,
      data: {
        explanation: 'The build omitted source generation',
        evidence: ['Build trace shows compilation before generation'],
        confidence: 0.98,
      },
    })
    const solution = service.recordSolution({
      project,
      caseId: problem.caseId,
      rootCauseId: cause.nodeId,
      data: {
        summary: 'Generate sources before compiling',
        applicability: ['Node 22'],
        applicabilityBoundary: { runtime: ['node-22'] },
        limitations: ['Requires the generator binary'],
        decisiveDifference: 'Runs generation before compilation',
        humanVerificationRequired: true,
      },
    })

    const automated = service.recordVerification({
      project,
      caseId: problem.caseId,
      solutionId: solution.nodeId,
      data: {
        kind: 'automated',
        succeeded: true,
        command: ['npm', 'test', '--', '--token=verification-secret'],
        exitStatus: 0,
        excerpt: '72 passed\nAuthorization: Bearer verification-secret',
      },
    })
    expect(automated.promotion).toEqual({
      status: 'candidate',
      missingRequirements: ['required-human-verification', 'human-confirmation'],
    })

    const artifact = service.recordArtifactReference({
      project,
      caseId: problem.caseId,
      verificationId: automated.nodeId,
      data: {
        kind: 'test-report',
        uri: join(rootA, 'reports', 'results.json'),
        digest: 'sha256:test-report',
      },
      metadata: { note: 'token=artifact-secret' },
    })
    const human = service.recordVerification({
      project,
      caseId: problem.caseId,
      solutionId: solution.nodeId,
      data: {
        kind: 'human',
        succeeded: true,
        humanConfirmed: true,
        environment: { os: 'darwin' },
        excerpt: 'Verified generated output visually',
      },
    })

    expect(human.promotion).toEqual({ status: 'verified', missingRequirements: [] })

    const guardrail = service.recordGuardrail({
      project,
      caseId: problem.caseId,
      rootCauseId: cause.nodeId,
      status: 'verified',
      data: {
        guidance: 'Run generation before npm test',
        enforcement: 'block',
        criteria: { commandIncludes: ['npm', 'test'] },
      },
    })
    const command = service.recordCommandResult({
      project,
      caseId: problem.caseId,
      attemptId: successfulAttempt.nodeId,
      operationId: 'command-result-1',
      command: ['npm', 'test', '--token=command-secret'],
      workingDirectory: rootA,
      exitStatus: 0,
      durationMs: 321,
      excerpt: 'passed\npassword=command-output-secret',
      startedAt: '2026-07-13T20:00:00.000Z',
      finishedAt: '2026-07-13T20:00:00.321Z',
    })
    expect(service.recordCommandResult({
      project,
      caseId: problem.caseId,
      attemptId: successfulAttempt.nodeId,
      operationId: 'command-result-1',
      command: ['ignored'],
      workingDirectory: rootA,
      exitStatus: 1,
      durationMs: 1,
      excerpt: 'ignored',
      startedAt: '2026-07-13T20:00:00.000Z',
      finishedAt: '2026-07-13T20:00:00.001Z',
    })).toEqual({ ...command, created: false })

    const preflight = service.preflight({
      project,
      taskDescription: 'Validate generated sources',
      changedFiles: ['src/build.ts'],
      command: ['npm', 'test'],
    })
    expect(preflight.blocked).toBe(true)
    expect(preflight.guardrails.map((item) => item.node.id)).toContain(guardrail.nodeId)
    expect(preflight.failedAttempts).toHaveLength(1)
    expect([firstAttempt.nodeId, secondAttempt.nodeId])
      .toContain(preflight.failedAttempts[0]?.id)
    expect(preflight.cards).toHaveLength(1)
    expect(preflight.solutions.map((node) => node.id)).toContain(solution.nodeId)
    expect(preflight.rootCauses.map((node) => node.id)).toContain(cause.nodeId)

    const query = service.queryKnowledge({
      project,
      text: 'generation',
      domain: 'build',
      nodeTypes: ['Problem', 'RootCause', 'Solution'],
      statuses: ['open', 'verified'],
      command: 'npm',
      fingerprint: rawFingerprint,
      limit: 20,
    })
    expect(query.items.some((item) => item.node.id === cause.nodeId)).toBe(true)
    expect(query.items.every((item) => item.projectId === projectA.id)).toBe(true)
    expect(query.limit).toBe(20)

    const caseBeforeRegression = service.getCase({ project, caseId: problem.caseId })
    expect(caseBeforeRegression.status).toBe('verified')
    expect(caseBeforeRegression.nodes.filter((node) => node.type === 'Attempt')).toHaveLength(3)
    expect(caseBeforeRegression.nodes.filter((node) => node.type === 'SuccessCase')).toHaveLength(1)
    expect(caseBeforeRegression.evidence).toHaveLength(2)
    expect(caseBeforeRegression.artifacts.map((item) => item.id)).toContain(artifact.artifactId)
    expect(caseBeforeRegression.commandRuns.map((item) => item.id)).toContain(command.commandRunId)
    expect(caseBeforeRegression.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: secondAttempt.nodeId,
        relation: 'PRECEDED_BY',
        targetId: firstAttempt.nodeId,
      }),
      expect.objectContaining({
        sourceId: successfulAttempt.nodeId,
        relation: 'PRECEDED_BY',
        targetId: secondAttempt.nodeId,
      }),
    ]))

    const closed = service.closeCase({ project, caseId: problem.caseId })
    expect(closed.promotion.status).toBe('verified')

    expect(service.queryKnowledge({
      project: { projectId: projectB.id },
      text: 'generation',
    }).items).toEqual([])
    expect(() => service.getCase({
      project: { projectId: projectB.id },
      caseId: problem.caseId,
    })).toThrow(KnowledgeServiceError)

    const regression = service.markRegression({
      project,
      caseId: problem.caseId,
      solutionId: solution.nodeId,
      fingerprint: rawFingerprint,
      observedContext: { runtime: 'node-22' },
    })
    expect(regression).toEqual({ outcome: 'regressed', caseId: problem.caseId })

    const regressedCase = service.getCase({ project, caseId: problem.caseId })
    expect(regressedCase.status).toBe('regressed')
    expect(regressedCase.nodes.find((node) => node.id === solution.nodeId)?.status).toBe(
      'regressed',
    )
    expect(regressedCase.nodes).toHaveLength(caseBeforeRegression.nodes.length)
    expect(regressedCase.evidence).toEqual(caseBeforeRegression.evidence)

    service.recordAttempt({
      project,
      caseId: problem.caseId,
      problemId: problem.nodeId,
      previousAttemptId: successfulAttempt.nodeId,
      data: {
        hypothesis: 'The old fix may still apply',
        change: 'Retried the old fix',
        outcome: 'failed',
        failureExplanation: 'The fingerprint recurred',
      },
    })
    const investigation = service.getCase({ project, caseId: problem.caseId })
    expect(investigation.status).toBe('regressed')
    expect(investigation.nodes.find((node) => node.id === solution.nodeId)?.status).toBe(
      'regressed',
    )
    expect(investigation.nodes).toHaveLength(regressedCase.nodes.length + 1)

    const activity = service.listRecentActivity({ project, limit: 5 })
    expect(activity.events).toHaveLength(5)
    expect(activity.events.some((event) => event.type === 'case.regressed')).toBe(true)
    expect(activity.events.every((event) => event.projectId === projectA.id)).toBe(true)

    const persisted = JSON.stringify({
      nodes: database.prepare('SELECT data FROM nodes').all(),
      events: database.prepare('SELECT payload FROM events').all(),
      search: database.prepare('SELECT title, body FROM node_search').all(),
      commands: database.prepare('SELECT command, excerpt FROM command_runs').all(),
      artifacts: database.prepare('SELECT metadata FROM artifacts').all(),
    })
    expect(persisted).not.toMatch(
      /summary-secret|fingerprint-secret|verification-secret|artifact-secret|human-secret|command-secret|command-output-secret/,
    )
  })

  it('rejects invalid, oversized, and cross-project writes without partial state or events', () => {
    const projectA = service.registerProject({ name: 'Project A', root: rootA })
    const projectB = service.registerProject({ name: 'Project B', root: rootB })
    const problem = service.recordProblem({
      project: { projectId: projectA.id },
      caseTitle: 'Owned by A',
      sourceKey: { kind: 'test', key: 'owned-node' },
      data: { summary: 'Failure' },
    })
    const before = countKnowledgeRows()

    expectServiceError(
      () => service.recordAttempt({
        project: { projectId: projectA.id },
        caseId: problem.caseId,
        problemId: problem.nodeId,
        sourceKey: { kind: 'test', key: 'owned-node' },
        data: { hypothesis: 'Collision', change: 'None', outcome: 'failed' },
      }),
      'OPERATION_CONFLICT',
    )
    expectServiceError(
      () => service.recordAttempt({
        project: { projectId: projectB.id },
        caseId: problem.caseId,
        problemId: problem.nodeId,
        data: { hypothesis: 'Wrong owner', change: 'None', outcome: 'failed' },
      }),
      'OWNERSHIP_MISMATCH',
    )
    expectServiceError(
      () => service.recordAttempt({
        project: { projectId: projectA.id },
        caseId: problem.caseId,
        problemId: problem.nodeId,
        data: { hypothesis: '', change: '', outcome: 'unknown' as 'failed' },
      }),
      'VALIDATION_FAILED',
    )
    expectServiceError(
      () => service.recordAttempt({
        project: { projectId: projectA.id },
        caseId: problem.caseId,
        problemId: problem.nodeId,
        data: { hypothesis: 'Large', change: 'x'.repeat(70_000), outcome: 'failed' },
      }),
      'PAYLOAD_TOO_LARGE',
    )
    expect(countKnowledgeRows()).toEqual(before)
  })

  it('requires the successful Attempt to state the decisive difference before promotion', () => {
    const projectRecord = service.registerProject({ name: 'Project A', root: rootA })
    const project = { projectId: projectRecord.id }
    const problem = service.recordProblem({
      project,
      caseTitle: 'Promotion gate',
      data: { summary: 'Failure' },
    })
    service.recordAttempt({
      project,
      caseId: problem.caseId,
      problemId: problem.nodeId,
      data: {
        hypothesis: 'This works',
        change: 'Applied fix',
        outcome: 'succeeded',
      },
    })
    const cause = service.recordRootCause({
      project,
      caseId: problem.caseId,
      problemId: problem.nodeId,
      status: 'verified',
      humanConfirmed: true,
      data: { explanation: 'Known cause', evidence: ['trace'], confidence: 1 },
    })
    const solution = service.recordSolution({
      project,
      caseId: problem.caseId,
      rootCauseId: cause.nodeId,
      data: {
        summary: 'Fix',
        applicability: ['all'],
        limitations: ['none known'],
        decisiveDifference: 'Recorded only on the Solution',
      },
    })

    const verification = service.recordVerification({
      project,
      caseId: problem.caseId,
      solutionId: solution.nodeId,
      data: { kind: 'automated', succeeded: true, command: ['npm', 'test'], exitStatus: 0 },
    })

    expect(verification.promotion).toEqual({
      status: 'candidate',
      missingRequirements: ['human-confirmation', 'decisive-difference'],
    })
  })

  it('requires a verified RootCause and explicit human confirmation before promotion', () => {
    const registered = service.registerProject({ name: 'Project A', root: rootA })
    const project = { projectId: registered.id }
    const problem = service.recordProblem({ project, data: { summary: 'Failure' } })
    service.recordAttempt({
      project, caseId: problem.caseId, problemId: problem.nodeId,
      data: { hypothesis: 'Fix', change: 'Apply fix', outcome: 'succeeded', decisiveDifference: 'Changed input' },
    })
    const cause = service.recordRootCause({
      project, caseId: problem.caseId, problemId: problem.nodeId, status: 'candidate',
      data: { explanation: 'Cause', evidence: ['trace'], confidence: 1 },
    })
    const solution = service.recordSolution({
      project, caseId: problem.caseId, rootCauseId: cause.nodeId,
      data: { summary: 'Fix', applicability: ['all'], limitations: ['known'], decisiveDifference: 'Changed input' },
    })
    service.recordVerification({
      project, caseId: problem.caseId, solutionId: solution.nodeId,
      data: { kind: 'automated', succeeded: true, command: ['test'], exitStatus: 0 },
    })
    const unconfirmed = service.recordVerification({
      project, caseId: problem.caseId, solutionId: solution.nodeId,
      data: { kind: 'human', succeeded: true },
    })

    expect(unconfirmed.promotion.status).toBe('candidate')
    expect(unconfirmed.promotion.missingRequirements).toEqual(expect.arrayContaining([
      'verified-root-cause', 'human-confirmation',
    ]))
  })

  it('matches preflight knowledge before applying the result limit', () => {
    const registered = service.registerProject({ name: 'Project A', root: rootA })
    const project = { projectId: registered.id }
    for (let index = 0; index < 101; index += 1) {
      const unrelated = service.recordProblem({ project, data: { summary: `Unrelated ${index}` } })
      service.recordAttempt({
        project, caseId: unrelated.caseId, problemId: unrelated.nodeId,
        data: { hypothesis: 'Other', change: 'Other', outcome: 'failed' },
      })
    }
    const relevant = service.recordProblem({ project, data: { summary: 'Xcode generation failed', domain: 'build' } })
    const attempt = service.recordAttempt({
      project, caseId: relevant.caseId, problemId: relevant.nodeId,
      data: { hypothesis: 'Tuist cache', change: 'Regenerate Xcode project', outcome: 'failed', command: ['tuist', 'generate'] },
    })

    const result = service.preflight({ project, taskDescription: 'regenerate Xcode with tuist', command: ['tuist', 'generate'], limit: 1 })
    expect(result.failedAttempts.map((node) => node.id)).toEqual([attempt.nodeId])
  })

  it('matches Guardrails before applying the caller limit', () => {
    const registered = service.registerProject({ name: 'Project A', root: rootA })
    const project = { projectId: registered.id }
    const problem = service.recordProblem({ project, data: { summary: 'Build failure' } })
    const cause = service.recordRootCause({
      project, caseId: problem.caseId, problemId: problem.nodeId,
      data: { explanation: 'Generation was skipped', evidence: ['trace'], confidence: 1 },
    })
    const applicable = service.recordGuardrail({
      project, caseId: problem.caseId, rootCauseId: cause.nodeId, status: 'verified',
      data: { guidance: 'Generate first', enforcement: 'block', criteria: { commandIncludes: ['npm', 'test'] } },
    })
    const unrelated = service.recordGuardrail({
      project, caseId: problem.caseId, rootCauseId: cause.nodeId, status: 'verified',
      data: { guidance: 'Unrelated', enforcement: 'block', criteria: { commandIncludes: ['cargo', 'test'] } },
    })
    database.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run('2026-07-13T19:00:00.000Z', applicable.nodeId)
    database.prepare('UPDATE nodes SET created_at = ? WHERE id = ?').run('2026-07-13T21:00:00.000Z', unrelated.nodeId)

    const result = service.preflight({
      project, taskDescription: 'test generated output', command: ['npm', 'test'], limit: 1,
    })

    expect(result.blocked).toBe(true)
    expect(result.guardrails.map((item) => item.node.id)).toEqual([applicable.nodeId])
  })

  it('rejects RootCause links to succeeded and inconclusive Attempts', () => {
    const registered = service.registerProject({ name: 'Project A', root: rootA })
    const project = { projectId: registered.id }
    const problem = service.recordProblem({ project, data: { summary: 'Failure' } })
    for (const outcome of ['succeeded', 'inconclusive'] as const) {
      const attempt = service.recordAttempt({
        project, caseId: problem.caseId, problemId: problem.nodeId,
        data: {
          hypothesis: `${outcome} hypothesis`, change: `${outcome} change`, outcome,
          ...(outcome === 'succeeded' ? { decisiveDifference: 'It worked' } : {}),
        },
      })
      expectServiceError(() => service.recordRootCause({
        project, caseId: problem.caseId, problemId: problem.nodeId,
        failedAttemptIds: [attempt.nodeId],
        data: { explanation: 'Cause', evidence: ['trace'], confidence: 1 },
      }), 'VALIDATION_FAILED')
    }
  })

  it('persists complete validated raw-log artifact metadata', () => {
    const registered = service.registerProject({ name: 'Project A', root: rootA })
    const project = { projectId: registered.id }
    mkdirSync(join(dataRoot, 'logs'))
    const paths = [
      join(dataRoot, 'logs', '..', 'logs', 'one.log'),
      join(dataRoot, 'logs', 'two.log'),
    ]
    const canonicalPaths = [
      canonicalizePath(join(dataRoot, 'logs', 'one.log')),
      canonicalizePath(join(dataRoot, 'logs', 'two.log')),
    ]
    const digest = 'a'.repeat(64)

    service.recordCommandResult({
      project, command: ['npm', 'test'], workingDirectory: rootA, exitStatus: 0,
      durationMs: 2, excerpt: 'passed', startedAt: '2026-07-13T20:00:00.000Z',
      finishedAt: '2026-07-13T20:00:00.002Z',
      rawLogArtifact: {
        kind: 'command-log', digestAlgorithm: 'sha256', digest, byteSize: 17,
        retainedByteSize: 11, paths, segmentCount: 2, truncated: true,
      },
    })

    const artifact = database.prepare("SELECT uri, digest, metadata FROM artifacts WHERE kind = 'command-log'").get() as {
      uri: string; digest: string; metadata: string
    }
    expect(artifact).toMatchObject({ uri: canonicalPaths[0], digest })
    expect(JSON.parse(artifact.metadata)).toEqual({
      commandRunId: expect.any(String), digestAlgorithm: 'sha256', byteSize: 17,
      retainedByteSize: 11, paths: canonicalPaths, segmentCount: 2, truncated: true,
    })
  })

  it('rejects raw-log paths outside project and service-data boundaries without mutation', () => {
    const registered = service.registerProject({ name: 'Project A', root: rootA })
    service.registerProject({ name: 'Project B', root: rootB })
    const outside = join(sandbox, 'outside')
    const logLink = join(dataRoot, 'linked-logs')
    mkdirSync(outside)
    symlinkSync(outside, logLink, 'dir')
    const base = {
      project: { projectId: registered.id }, command: ['npm', 'test'], workingDirectory: rootA,
      exitStatus: 0, durationMs: 1, excerpt: 'passed',
      startedAt: '2026-07-13T20:00:00.000Z', finishedAt: '2026-07-13T20:00:00.001Z',
    }
    const artifact = (path: string) => ({
      kind: 'command-log' as const, digestAlgorithm: 'sha256' as const,
      digest: 'a'.repeat(64), byteSize: 1, retainedByteSize: 1,
      paths: [path], segmentCount: 1, truncated: false,
    })

    for (const input of [
      { rawLogArtifact: artifact('/etc/ekg-command.log') },
      { rawLogPath: join(rootB, 'sibling-project.log'), rawLogDigest: 'legacy-digest' },
      { rawLogArtifact: artifact(join(logLink, 'escaped.log')) },
    ]) {
      expectServiceError(() => service.recordCommandResult({ ...base, ...input }), 'PATH_OUTSIDE_PROJECT')
    }
    expect(database.prepare('SELECT * FROM command_runs').all()).toEqual([])
    expect(database.prepare('SELECT * FROM artifacts').all()).toEqual([])
  })

  it('derives the raw-log boundary from a file-backed database path', () => {
    const fileDatabase = openDatabase(join(dataRoot, 'knowledge.db'))
    try {
      const fileService = new KnowledgeService(fileDatabase)
      const project = fileService.registerProject({ name: 'File-backed', root: rootA })
      mkdirSync(join(dataRoot, 'logs'))
      const validLog = join(dataRoot, 'logs', 'command.log')
      fileService.recordCommandResult({
        project: { projectId: project.id }, command: ['npm', 'test'], workingDirectory: rootA,
        exitStatus: 0, durationMs: 1, excerpt: 'passed', rawLogPath: validLog,
        rawLogDigest: 'legacy-digest', startedAt: '2026-07-13T20:00:00.000Z',
        finishedAt: '2026-07-13T20:00:00.001Z',
      })
      expect((fileDatabase.prepare('SELECT raw_log_path FROM command_runs').get() as {
        raw_log_path: string
      }).raw_log_path).toBe(canonicalizePath(validLog))

      expectServiceError(() => fileService.recordCommandResult({
        project: { projectId: project.id }, command: ['npm', 'test'], workingDirectory: rootA,
        exitStatus: 0, durationMs: 1, excerpt: 'passed', rawLogPath: join(rootB, 'command.log'),
        rawLogDigest: 'legacy-digest', startedAt: '2026-07-13T20:00:00.000Z',
        finishedAt: '2026-07-13T20:00:00.001Z',
      }), 'PATH_OUTSIDE_PROJECT')
    } finally {
      closeDatabase(fileDatabase)
    }
  })

  it('rejects inconsistent raw-log artifact metadata', () => {
    const registered = service.registerProject({ name: 'Project A', root: rootA })
    expectServiceError(() => service.recordCommandResult({
      project: { projectId: registered.id }, command: ['npm', 'test'], workingDirectory: rootA,
      exitStatus: 0, durationMs: 1, excerpt: 'passed',
      startedAt: '2026-07-13T20:00:00.000Z', finishedAt: '2026-07-13T20:00:00.001Z',
      rawLogArtifact: {
        kind: 'command-log', digestAlgorithm: 'sha256', digest: 'a'.repeat(64),
        byteSize: 10, retainedByteSize: 11, paths: ['/one.log'], segmentCount: 2,
        truncated: false,
      },
    }), 'VALIDATION_FAILED')
    expect(database.prepare('SELECT * FROM command_runs').all()).toEqual([])
    expect(database.prepare('SELECT * FROM artifacts').all()).toEqual([])
  })

  it('rolls back a command result when its event cannot be appended', () => {
    const project = service.registerProject({ name: 'Project A', root: rootA })
    database.exec(`
      CREATE TRIGGER reject_command_event
      BEFORE INSERT ON events
      WHEN NEW.type = 'command.recorded'
      BEGIN
        SELECT RAISE(ABORT, 'simulated event failure');
      END;
    `)

    expect(() => service.recordCommandResult({
      project: { projectId: project.id },
      command: ['npm', 'test'],
      workingDirectory: rootA,
      exitStatus: 0,
      durationMs: 1,
      excerpt: 'passed',
      startedAt: '2026-07-13T20:00:00.000Z',
      finishedAt: '2026-07-13T20:00:00.001Z',
    })).toThrow(/simulated event failure/)
    expect(database.prepare('SELECT * FROM command_runs').all()).toEqual([])
  })

  it('records durable command start and completion events for interrupted-run recovery', () => {
    const registered = service.registerProject({ name: 'Project A', root: rootA })
    const project = { projectId: registered.id }
    service.recordCommandStarted({
      project, commandRunId: 'run-lifecycle', command: ['tool', '--token', 'secret'],
      workingDirectory: rootA, startedAt: '2026-07-13T20:00:00.000Z',
    })
    service.recordCommandResult({
      project, commandRunId: 'run-lifecycle', command: ['tool', '--token', 'secret'],
      workingDirectory: rootA, exitStatus: 1, durationMs: 10, excerpt: 'failed',
      startedAt: '2026-07-13T20:00:00.000Z', finishedAt: '2026-07-13T20:00:00.010Z',
    })
    const events = service.listRecentActivity({ project, limit: 20 }).events
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'command.started', 'command.completed',
    ]))
    expect(JSON.stringify(events)).not.toContain('secret')
  })

  function countKnowledgeRows(): Record<string, number> {
    return Object.fromEntries(
      ['cases', 'nodes', 'edges', 'events', 'source_keys'].map((table) => {
        const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
          count: number
        }
        return [table, row.count]
      }),
    )
  }

  function expectServiceError(callback: () => unknown, code: string): KnowledgeServiceError {
    try {
      callback()
      throw new Error('Expected KnowledgeServiceError')
    } catch (error) {
      expect(error).toBeInstanceOf(KnowledgeServiceError)
      expect((error as KnowledgeServiceError).code).toBe(code)
      return error as KnowledgeServiceError
    }
  }
})
