import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v3'

import type { AwaitableKnowledgeBackend } from '../application/backend.js'
import { OperationMetrics } from '../application/operation-metrics.js'

const MAX_ID_LENGTH = 200
const MAX_TEXT_LENGTH = 4_096
const MAX_PATH_LENGTH = 4_096
const MAX_EXCERPT_LENGTH = 16_384
const MAX_ARRAY_LENGTH = 100
const MAX_ARCHIVE_ENTRIES = 10_000

const id = z.string().trim().min(1).max(MAX_ID_LENGTH)
const text = z.string().trim().min(1).max(MAX_TEXT_LENGTH)
const path = z.string().trim().min(1).max(MAX_PATH_LENGTH)
const timestamp = z.string().datetime({ offset: true })
const stringList = z.array(text).max(MAX_ARRAY_LENGTH)
const nonEmptyStringList = stringList.min(1)
const argv = z.array(z.string().min(1).max(MAX_TEXT_LENGTH)).min(1).max(MAX_ARRAY_LENGTH)
const nodeType = z.enum([
  'Problem',
  'Attempt',
  'RootCause',
  'Solution',
  'Verification',
  'SuccessCase',
  'Guardrail',
  'Artifact',
])
const nodeStatus = z.enum(['open', 'candidate', 'verified', 'regressed', 'retired'])
const relation = z.enum([
  'ATTEMPTS_TO_SOLVE',
  'PRECEDED_BY',
  'FAILED_BECAUSE',
  'CAUSES',
  'ADDRESSES',
  'VERIFIED_BY',
  'REFERENCES',
  'PREVENTS',
  'INCLUDES',
  'SUPERSEDES',
])
const stringRecord = z
  .record(z.string().max(MAX_TEXT_LENGTH))
  .refine((value) => Object.keys(value).length <= MAX_ARRAY_LENGTH, 'Too many entries')
const boundedJsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().max(MAX_EXCERPT_LENGTH),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(boundedJsonValue).max(MAX_ARRAY_LENGTH),
    z
      .record(boundedJsonValue)
      .refine((value) => Object.keys(value).length <= MAX_ARRAY_LENGTH, 'Too many entries'),
  ]),
)
const metadataRecord = z
  .record(boundedJsonValue)
  .refine((value) => Object.keys(value).length <= MAX_ARRAY_LENGTH, 'Too many entries')

const projectReference = z
  .object({
    projectId: id.optional().describe('Registered project UUID.'),
    projectRoot: path.optional().describe('Exact registered canonical root or worktree alias.'),
  })
  .strict()
  .refine(
    (reference) => Number(reference.projectId !== undefined) + Number(reference.projectRoot !== undefined) === 1,
    'Provide exactly one of projectId or projectRoot',
  )
  .describe('Explicit reference to exactly one registered project.')

const sourceKey = z
  .object({
    kind: text.describe('Stable source namespace, such as manual or importer name.'),
    key: text.describe('Stable source-local identity used for idempotency.'),
  })
  .strict()

const operationFields = {
  operationId: id.optional().describe('Caller-generated idempotency key.'),
  sourceKey: sourceKey.optional().describe('Stable source identity for deduplicating a node.'),
}

const problemData = z
  .object({
    summary: text.describe('Concise observed problem statement.'),
    symptoms: stringList.optional().describe('Observed symptoms.'),
    firstObservedAt: timestamp.optional().describe('UTC timestamp when first observed.'),
    domain: text.optional().describe('Engineering domain, such as build or database.'),
    fingerprint: text.optional().describe('Failure text to normalize into a project-scoped fingerprint.'),
  })
  .strict()

const attemptData = z
  .object({
    hypothesis: text.describe('Hypothesis tested by this attempt.'),
    change: text.describe('Investigation or change performed.'),
    outcome: z.enum(['failed', 'succeeded', 'inconclusive']),
    command: argv.optional().describe('Command argv used by the attempt.'),
    failureExplanation: text.optional().describe('Why a failed attempt did not solve the problem.'),
    decisiveDifference: text.optional().describe('What distinguished a successful attempt.'),
  })
  .strict()

const rootCauseData = z
  .object({
    explanation: text.describe('Causal explanation supported by evidence.'),
    evidence: nonEmptyStringList.describe('Concrete evidence supporting this cause.'),
    rejectedAlternatives: stringList.optional().describe('Alternative causes ruled out.'),
    confidence: z.number().min(0).max(1).describe('Confidence from 0 through 1.'),
  })
  .strict()

const solutionData = z
  .object({
    summary: text.describe('Change that addresses the root cause.'),
    applicability: nonEmptyStringList.describe('Contexts where the solution applies.'),
    limitations: nonEmptyStringList.describe('Known limitations.'),
    sideEffects: stringList.optional().describe('Known side effects.'),
    decisiveDifference: text.describe('Difference from unsuccessful attempts.'),
    applicabilityBoundary: z.record(stringList).optional().describe('Context dimensions and accepted values.'),
    humanVerificationRequired: z.boolean().optional(),
    nonAutomatableReason: text.optional().describe('Why automated verification is unavailable.'),
  })
  .strict()

const verificationData = z
  .object({
    kind: z.enum(['automated', 'human']),
    succeeded: z.boolean(),
    humanConfirmed: z.boolean().optional().describe('Explicit auditable confirmation by a human actor.'),
    environment: stringRecord.optional().describe('Bounded verification environment facts, never secrets.'),
    command: argv.optional().describe('Verification command argv.'),
    exitStatus: z.number().int().optional(),
    sourceRevision: text.optional(),
    excerpt: z.string().min(1).max(MAX_EXCERPT_LENGTH).optional().describe('Bounded evidence excerpt.'),
  })
  .strict()

const artifactData = z
  .object({
    kind: text.describe('Artifact kind, such as test-report.'),
    uri: path.describe('Project-contained path or explicit external URI.'),
    digest: text.optional(),
    mediaType: text.optional(),
  })
  .strict()

const criteriaData = z
  .object({
    taskIncludes: nonEmptyStringList.optional(),
    commandIncludes: nonEmptyStringList.optional(),
    fileIncludes: nonEmptyStringList.optional(),
  })
  .strict()
  .refine(
    (criteria) =>
      criteria.taskIncludes !== undefined ||
      criteria.commandIncludes !== undefined ||
      criteria.fileIncludes !== undefined,
    'Provide at least one matching criterion',
  )

const guardrailData = z
  .object({
    guidance: text.describe('Actionable guidance when criteria match.'),
    enforcement: z.enum(['advise', 'warn', 'block']),
    criteria: criteriaData,
  })
  .strict()

const checkpointWrite = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('problem'),
    input: z.object({
      caseId: id.optional(),
      caseTitle: text.optional(),
      data: problemData,
      ...operationFields,
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('attempt'),
    input: z.object({
      caseId: id,
      problemId: id,
      previousAttemptId: id.optional(),
      data: attemptData,
      ...operationFields,
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('rootCause'),
    input: z.object({
      caseId: id,
      problemId: id,
      failedAttemptIds: z.array(id).max(MAX_ARRAY_LENGTH).optional(),
      status: z.enum(['candidate', 'verified']).optional(),
      humanConfirmed: z.boolean().optional(),
      data: rootCauseData,
      ...operationFields,
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('solution'),
    input: z.object({
      caseId: id,
      rootCauseId: id,
      data: solutionData,
      ...operationFields,
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('verification'),
    input: z.object({
      caseId: id,
      solutionId: id,
      data: verificationData,
      ...operationFields,
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('artifact'),
    input: z.object({
      caseId: id,
      verificationId: id,
      data: artifactData,
      metadata: metadataRecord.optional(),
      isExternal: z.boolean().optional(),
      ...operationFields,
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('guardrail'),
    input: z.object({
      caseId: id,
      rootCauseId: id,
      status: z.enum(['candidate', 'verified']).optional(),
      data: guardrailData,
      ...operationFields,
    }).strict(),
  }).strict(),
])

const projectResult = z.object({
  id,
  name: text,
  root: path,
  description: z.string().max(MAX_TEXT_LENGTH).nullable(),
  createdAt: timestamp,
})
const projectWithAliasesResult = projectResult.extend({
  aliases: z.array(z.object({ id, projectId: id, root: path, createdAt: timestamp })).max(MAX_ARRAY_LENGTH),
})
const promotionResult = z.object({
  status: z.enum(['candidate', 'verified']),
  missingRequirements: stringList,
})
const nodeWriteResult = z.object({
  caseId: id,
  nodeId: id,
  promotion: promotionResult,
  created: z.boolean(),
})
const nodeResult = z.object({
  id,
  caseId: id,
  type: nodeType,
  status: nodeStatus,
  data: z.record(boundedJsonValue),
  createdAt: timestamp,
})
const edgeResult = z.object({
  id,
  caseId: id,
  sourceId: id,
  relation,
  targetId: id,
  createdAt: timestamp,
})
const eventResult = z.object({
  sequence: z.number().int().nonnegative(),
  projectId: id,
  type: text,
  aggregateId: id,
  payload: boundedJsonValue,
  occurredAt: timestamp,
})
const genericRecord = z.record(boundedJsonValue)

function outputSchema<T extends z.ZodTypeAny>(result: T) {
  return z.object({ ok: z.literal(true), result })
}

const readOnly: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
const additiveWrite: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}
const idempotentWrite: ToolAnnotations = { ...additiveWrite, idempotentHint: true }

type ErrorWithCode = Error & { code?: unknown }

const errorActions: Record<string, string> = {
  INVALID_ARGUMENT: 'Correct the arguments and call the tool again.',
  VALIDATION_FAILED: 'Correct the fields described by the error and retry.',
  PAYLOAD_TOO_LARGE: 'Reduce array counts or text sizes and retry.',
  NOT_FOUND: 'Check the selected project and identifier, then retry.',
  CONFLICT: 'Resolve the conflicting existing record before retrying.',
  OWNERSHIP_MISMATCH: 'Use identifiers that belong to the explicitly selected project.',
  OPERATION_CONFLICT: 'Use a new operationId or repeat the original operation unchanged.',
  PATH_OUTSIDE_PROJECT: 'Use a path inside the selected project or mark an artifact external.',
  SOURCE_TOO_LARGE: 'Select a smaller explicit import source.',
  SOURCE_READ_FAILED: 'Check that the explicit source exists and is readable.',
  STALE_PREVIEW: 'Create a new import preview and approve that preview.',
  EXPIRED_PREVIEW: 'Create a new import preview and apply it before expiry.',
  INVALID_ARCHIVE: 'Export a fresh supported graph snapshot and retry the import.',
}

const domainErrorCodes: Record<string, string> = {
  ProjectNotFoundError: 'NOT_FOUND',
  AmbiguousProjectReferenceError: 'INVALID_ARGUMENT',
  ProjectConflictError: 'CONFLICT',
  CaseNotFoundError: 'NOT_FOUND',
  InvalidGraphError: 'VALIDATION_FAILED',
}

function errorResult(error: unknown): CallToolResult {
  const candidate = error instanceof Error ? (error as ErrorWithCode) : undefined
  const serviceCode = typeof candidate?.code === 'string' ? candidate.code : undefined
  const code =
    serviceCode && errorActions[serviceCode]
      ? serviceCode
      : domainErrorCodes[candidate?.name ?? ''] ?? 'INTERNAL_ERROR'
  const message = code === 'INTERNAL_ERROR' ? 'Unexpected service failure' : candidate?.message ?? code
  const action = errorActions[code] ?? 'Retry once; if the failure persists, report the tool operation.'
  return {
    isError: true,
    content: [{ type: 'text', text: `[${code}] ${message}. ${action}` }],
  }
}

function successResult(toolName: string, result: unknown): CallToolResult {
  const count = Array.isArray(result) ? ` (${result.length} items)` : ''
  return {
    content: [{ type: 'text', text: `${toolName} succeeded${count}.` }],
    structuredContent: { ok: true, result },
  }
}

function responseBytes(result: unknown): number {
  try {
    const encoded = JSON.stringify(result)
    return encoded === undefined ? 0 : new TextEncoder().encode(encoded).byteLength
  } catch {
    return 0
  }
}

function resultItemCount(result: unknown): number | null {
  if (Array.isArray(result)) return result.length
  if (result === null || typeof result !== 'object') return null
  for (const key of ['items', 'events', 'results']) {
    const value = (result as Record<string, unknown>)[key]
    if (Array.isArray(value)) return value.length
  }
  return null
}

async function invokeWithMetrics(
  metrics: OperationMetrics,
  toolName: string,
  operation: () => unknown | Promise<unknown>,
): Promise<CallToolResult> {
  const startedAt = performance.now()
  try {
    const result = await operation()
    metrics.record({
      operation: toolName,
      ok: true,
      errorCode: null,
      durationMs: performance.now() - startedAt,
      responseBytes: responseBytes(result),
      itemCount: resultItemCount(result),
      occurredAt: new Date().toISOString(),
    })
    return successResult(toolName, result)
  } catch (error) {
    const candidate = error as { code?: unknown }
    metrics.record({
      operation: toolName,
      ok: false,
      errorCode: typeof candidate?.code === 'string' ? candidate.code : 'INTERNAL_ERROR',
      durationMs: performance.now() - startedAt,
      responseBytes: 0,
      itemCount: null,
      occurredAt: new Date().toISOString(),
    })
    return errorResult(error)
  }
}

export function createMcpServer(service: AwaitableKnowledgeBackend): McpServer {
  const metrics = new OperationMetrics()
  const invoke = (toolName: string, operation: () => unknown | Promise<unknown>): Promise<CallToolResult> =>
    invokeWithMetrics(metrics, toolName, operation)
  const server = new McpServer({
    name: 'engineering-knowledge-graph',
    version: '0.1.0',
  })

  server.registerTool(
    'register_project',
    {
      description: 'Register one project from an explicit canonical root path.',
      inputSchema: z
        .object({
          name: text.describe('Human-readable project name.'),
          root: path.describe('Existing project root path.'),
          description: z.string().max(MAX_TEXT_LENGTH).optional(),
        })
        .strict(),
      outputSchema: outputSchema(projectResult),
      annotations: { ...additiveWrite, openWorldHint: true },
    },
    (input) => invoke('register_project', () => service.registerProject(input)),
  )

  server.registerTool(
    'list_projects',
    {
      description: 'List registered projects and their worktree aliases.',
      inputSchema: z.object({}).strict(),
      outputSchema: outputSchema(z.array(projectWithAliasesResult).max(MAX_ARRAY_LENGTH)),
      annotations: readOnly,
    },
    () => invoke('list_projects', () => service.listProjects()),
  )

  server.registerTool(
    'resolve_project',
    {
      description: 'Resolve an explicit project ID, canonical root, or worktree alias.',
      inputSchema: z.object({ project: projectReference }).strict(),
      outputSchema: outputSchema(projectResult),
      annotations: readOnly,
    },
    ({ project }) => invoke('resolve_project', () => service.resolveProject(project)),
  )

  server.registerTool(
    'update_project',
    {
      description: 'Update project metadata or add one explicit worktree alias.',
      inputSchema: z
        .object({
          project: projectReference,
          name: text.optional(),
          description: z.string().max(MAX_TEXT_LENGTH).nullable().optional(),
          addAlias: path.optional().describe('Existing worktree root to register as an alias.'),
        })
        .strict()
        .refine(
          (input) => input.name !== undefined || input.description !== undefined || input.addAlias !== undefined,
          'Provide at least one update',
        ),
      outputSchema: outputSchema(projectWithAliasesResult),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (input) => invoke('update_project', () => service.updateProject(input)),
  )

  server.registerTool(
    'query_knowledge',
    {
      description: 'Search bounded knowledge within one explicitly selected project.',
      inputSchema: z
        .object({
          project: projectReference,
          text: text.optional(),
          domain: text.optional(),
          nodeTypes: z.array(nodeType).min(1).max(nodeType.options.length).optional(),
          statuses: z.array(nodeStatus).min(1).max(nodeStatus.options.length).optional(),
          file: path.optional(),
          command: text.optional(),
          fingerprint: text.optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .strict(),
      outputSchema: outputSchema(
        z.object({
          items: z
            .array(
              z.object({
                projectId: id,
                caseId: id,
                caseTitle: text,
                node: nodeResult,
              }),
            )
            .max(100),
          limit: z.number().int().min(1).max(100),
          truncated: z.boolean(),
        }),
      ),
      annotations: readOnly,
    },
    (input) => invoke('query_knowledge', () => service.queryKnowledge(input)),
  )

  server.registerTool(
    'get_case',
    {
      description: 'Get one project-owned Case using a bounded summary, graph, or paged full projection.',
      inputSchema: z.object({
        project: projectReference,
        caseId: id,
        detail: z.enum(['summary', 'graph', 'full']).optional(),
        historyLimit: z.number().int().min(1).max(100).optional(),
        historyBeforeSequence: z.number().int().positive().optional(),
      }).strict(),
      outputSchema: outputSchema(
        z
          .object({
            id,
            projectId: id,
            title: text,
            status: nodeStatus,
            createdAt: timestamp,
            detail: z.enum(['summary', 'graph', 'full']),
            counts: z.object({
              nodes: z.number().int().nonnegative(),
              edges: z.number().int().nonnegative(),
              evidence: z.number().int().nonnegative(),
              artifacts: z.number().int().nonnegative(),
              commandRuns: z.number().int().nonnegative(),
              history: z.number().int().nonnegative(),
            }),
            nodes: z.array(nodeResult).max(MAX_ARCHIVE_ENTRIES),
            edges: z.array(edgeResult).max(MAX_ARCHIVE_ENTRIES),
            evidence: z.array(genericRecord).max(MAX_ARCHIVE_ENTRIES),
            artifacts: z.array(genericRecord).max(MAX_ARCHIVE_ENTRIES),
            commandRuns: z.array(genericRecord).max(MAX_ARCHIVE_ENTRIES),
            history: z.array(eventResult).max(MAX_ARCHIVE_ENTRIES),
            historyNextBeforeSequence: z.number().int().positive().nullable(),
          })
          .strict(),
      ),
      annotations: readOnly,
    },
    (input) => invoke('get_case', () => service.getCase(input)),
  )

  server.registerTool(
    'get_preflight_guidance',
    {
      description: 'Evaluate known failures, solutions, uncertainty, and Guardrails before work begins.',
      inputSchema: z
        .object({
          project: projectReference,
          taskDescription: text,
          changedFiles: z.array(path).max(MAX_ARRAY_LENGTH).optional(),
          command: argv.optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .strict(),
      outputSchema: outputSchema(
        z.object({
          blocked: z.boolean(),
          guardrails: z
            .array(z.object({ node: nodeResult, blocks: z.boolean() }))
            .max(100),
          failedAttempts: z.array(nodeResult).max(100),
          rootCauses: z.array(nodeResult).max(100),
          solutions: z.array(nodeResult).max(100),
          uncertain: z.array(nodeResult).max(100),
        }),
      ),
      annotations: readOnly,
    },
    (input) => invoke('get_preflight_guidance', () => service.preflight(input)),
  )

  server.registerTool(
    'list_recent_activity',
    {
      description: 'List bounded project activity after an optional sequence cursor.',
      inputSchema: z
        .object({
          project: projectReference,
          afterSequence: z.number().int().nonnegative().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .strict(),
      outputSchema: outputSchema(
        z.object({
          events: z.array(eventResult).max(100),
          limit: z.number().int().min(1).max(100),
          truncated: z.boolean(),
          nextSequence: z.number().int().nonnegative(),
        }),
      ),
      annotations: readOnly,
    },
    (input) => invoke('list_recent_activity', () => service.listRecentActivity(input)),
  )

  server.registerTool(
    'get_operation_metrics',
    {
      description: 'Return bounded in-memory latency, error, and response-size aggregates for this server process.',
      inputSchema: z.object({}).strict(),
      outputSchema: outputSchema(z.array(z.object({
        operation: text,
        count: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
        p50DurationMs: z.number().nonnegative(),
        p95DurationMs: z.number().nonnegative(),
        maxDurationMs: z.number().nonnegative(),
        maxResponseBytes: z.number().nonnegative(),
      }).strict()).max(100)),
      annotations: readOnly,
    },
    () => invoke('get_operation_metrics', () => metrics.aggregates()),
  )

  server.registerTool(
    'record_problem',
    {
      description: 'Start or extend a Case with one observed Problem.',
      inputSchema: z
        .object({
          project: projectReference,
          caseId: id.optional(),
          caseTitle: text.optional(),
          data: problemData,
          ...operationFields,
        })
        .strict(),
      outputSchema: outputSchema(nodeWriteResult),
      annotations: additiveWrite,
    },
    (input) => invoke('record_problem', () => service.recordProblem(input)),
  )

  server.registerTool(
    'record_attempt',
    {
      description: 'Record one failed, successful, or inconclusive Attempt in a Case.',
      inputSchema: z
        .object({
          project: projectReference,
          caseId: id,
          problemId: id,
          previousAttemptId: id.optional(),
          data: attemptData,
          ...operationFields,
        })
        .strict(),
      outputSchema: outputSchema(nodeWriteResult),
      annotations: additiveWrite,
    },
    (input) => invoke('record_attempt', () => service.recordAttempt(input)),
  )

  server.registerTool(
    'record_root_cause',
    {
      description: 'Record an evidenced RootCause linked to its Problem and failed Attempts.',
      inputSchema: z
        .object({
          project: projectReference,
          caseId: id,
          problemId: id,
          failedAttemptIds: z.array(id).max(MAX_ARRAY_LENGTH).optional(),
          status: z.enum(['candidate', 'verified']).optional(),
          humanConfirmed: z.boolean().optional().describe('Required when status is verified.'),
          data: rootCauseData,
          ...operationFields,
        })
        .strict(),
      outputSchema: outputSchema(nodeWriteResult),
      annotations: additiveWrite,
    },
    (input) => invoke('record_root_cause', () => service.recordRootCause(input)),
  )

  server.registerTool(
    'record_solution',
    {
      description: 'Record a Solution with applicability, limitations, and decisive difference.',
      inputSchema: z
        .object({
          project: projectReference,
          caseId: id,
          rootCauseId: id,
          data: solutionData,
          ...operationFields,
        })
        .strict(),
      outputSchema: outputSchema(nodeWriteResult),
      annotations: additiveWrite,
    },
    (input) => invoke('record_solution', () => service.recordSolution(input)),
  )

  server.registerTool(
    'record_verification',
    {
      description: 'Record automated or human Verification evidence for a Solution.',
      inputSchema: z
        .object({
          project: projectReference,
          caseId: id,
          solutionId: id,
          data: verificationData,
          ...operationFields,
        })
        .strict(),
      outputSchema: outputSchema(nodeWriteResult),
      annotations: additiveWrite,
    },
    (input) => invoke('record_verification', () => service.recordVerification(input)),
  )

  server.registerTool(
    'record_artifact_reference',
    {
      description: 'Record bounded metadata pointing to a retained or external verification artifact.',
      inputSchema: z
        .object({
          project: projectReference,
          caseId: id,
          verificationId: id,
          data: artifactData,
          metadata: metadataRecord.optional(),
          isExternal: z.boolean().optional(),
          ...operationFields,
        })
        .strict(),
      outputSchema: outputSchema(nodeWriteResult.extend({ artifactId: id })),
      annotations: additiveWrite,
    },
    (input) =>
      invoke('record_artifact_reference', () => service.recordArtifactReference(input)),
  )

  server.registerTool(
    'record_guardrail',
    {
      description: 'Record project-scoped preflight guidance linked to an evidenced RootCause.',
      inputSchema: z
        .object({
          project: projectReference,
          caseId: id,
          rootCauseId: id,
          status: z.enum(['candidate', 'verified']).optional(),
          data: guardrailData,
          ...operationFields,
        })
        .strict(),
      outputSchema: outputSchema(nodeWriteResult),
      annotations: additiveWrite,
    },
    (input) => invoke('record_guardrail', () => service.recordGuardrail(input)),
  )

  server.registerTool(
    'report_relevance',
    {
      description: 'Record whether one returned Case was useful using only a caller-computed context digest.',
      inputSchema: z.object({
        project: projectReference,
        caseId: id,
        contextDigest: z.string().regex(/^[a-f0-9]{64}$/i),
        useful: z.boolean(),
      }).strict(),
      outputSchema: outputSchema(z.object({ recorded: z.literal(true) })),
      annotations: additiveWrite,
    },
    (input) => invoke('report_relevance', () => service.reportRelevance(input)),
  )

  server.registerTool(
    'suggest_case_merges',
    {
      description: 'Propose similar Cases for human review; this never merges automatically.',
      inputSchema: z.object({ project: projectReference, limit: z.number().int().min(1).max(25).optional() }).strict(),
      outputSchema: outputSchema(z.array(genericRecord).max(25)),
      annotations: additiveWrite,
    },
    (input) => invoke('suggest_case_merges', () => service.suggestCaseMerges(input)),
  )

  server.registerTool(
    'apply_case_merge',
    {
      description: 'Explicitly apply one reviewed Case merge proposal and retire its source Case.',
      inputSchema: z.object({ project: projectReference, proposalId: id, operationId: id }).strict(),
      outputSchema: outputSchema(genericRecord),
      annotations: idempotentWrite,
    },
    (input) => invoke('apply_case_merge', () => service.applyCaseMerge(input)),
  )

  server.registerTool(
    'checkpoint_work',
    {
      description: 'Concise idempotent capture of failed, notable, or critical engineering work.',
      inputSchema: z.object({
        project: projectReference,
        operationId: id,
        caseId: id.optional(),
        task: text,
        outcome: z.enum(['failed', 'succeeded', 'inconclusive']),
        summary: text,
        importance: z.enum(['routine', 'notable', 'critical']).optional(),
        fingerprint: text.optional(),
        files: z.array(path).max(MAX_ARRAY_LENGTH).optional(),
        command: argv.optional(),
        evidence: stringList.optional(),
        rootCause: z.object({
          explanation: text,
          confidence: z.number().min(0).max(1),
          rejectedAlternatives: stringList.optional(),
        }).strict().optional(),
        solution: z.object({
          summary: text,
          applicability: nonEmptyStringList,
          limitations: nonEmptyStringList,
          decisiveDifference: text,
        }).strict().optional(),
        humanConfirmed: z.boolean().optional(),
      }).strict(),
      outputSchema: outputSchema(z.object({
        recorded: z.boolean(),
        reason: z.literal('routine-success').optional(),
        createdCase: z.boolean(),
        caseId: id.optional(),
        problemId: id.optional(),
        attemptId: id.optional(),
        rootCauseId: id.optional(),
        solutionId: id.optional(),
      })),
      annotations: idempotentWrite,
    },
    (input) => invoke('checkpoint_work', () => service.checkpointWork(input)),
  )

  server.registerTool(
    'record_checkpoint',
    {
      description: 'Atomically record a bounded checkpoint of existing knowledge write commands.',
      inputSchema: z.object({
        project: projectReference,
        operationId: id,
        writes: z.array(checkpointWrite).min(1).max(25),
      }).strict(),
      outputSchema: outputSchema(z.object({
        results: z.array(z.union([
          nodeWriteResult.extend({ artifactId: id }),
          nodeWriteResult,
        ])).max(25),
        created: z.boolean(),
      })),
      annotations: idempotentWrite,
    },
    (input) => invoke('record_checkpoint', () => service.recordCheckpoint(input)),
  )

  server.registerTool(
    'record_command_result',
    {
      description: 'Record a bounded redacted command result without executing a command.',
      inputSchema: z
        .object({
          project: projectReference,
          operationId: id.optional(),
          caseId: id.optional(),
          attemptId: id.optional(),
          command: argv,
          workingDirectory: path,
          exitStatus: z.number().int().nullable().optional(),
          signal: text.nullable().optional(),
          durationMs: z.number().int().nonnegative().max(2_147_483_647),
          excerpt: z.string().max(MAX_EXCERPT_LENGTH),
          rawLogPath: path.nullable().optional(),
          rawLogDigest: text.nullable().optional(),
          rawLogArtifact: z.object({
            kind: z.literal('command-log'),
            digestAlgorithm: z.literal('sha256'),
            digest: z.string().regex(/^[a-f0-9]{64}$/),
            byteSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            retainedByteSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            paths: z.array(path).min(1).max(10_000),
            segmentCount: z.number().int().positive().max(10_000),
            truncated: z.boolean(),
          }).strict().refine((artifact) => artifact.retainedByteSize <= artifact.byteSize, {
            message: 'retainedByteSize must not exceed byteSize',
            path: ['retainedByteSize'],
          }).refine((artifact) => artifact.segmentCount === artifact.paths.length, {
            message: 'segmentCount must equal paths.length',
            path: ['segmentCount'],
          }).nullable().optional(),
          startedAt: timestamp,
          finishedAt: timestamp,
        })
        .strict()
        .refine((input) => input.attemptId === undefined || input.caseId !== undefined, {
          message: 'caseId is required when attemptId is provided',
          path: ['caseId'],
        }),
      outputSchema: outputSchema(z.object({ commandRunId: id, created: z.boolean() })),
      annotations: additiveWrite,
    },
    (input) => invoke('record_command_result', () => service.recordCommandResult(input)),
  )

  server.registerTool(
    'close_case',
    {
      description: 'Evaluate promotion requirements and close one project-owned Case.',
      inputSchema: z
        .object({ project: projectReference, caseId: id, operationId: id })
        .strict(),
      outputSchema: outputSchema(z.object({ caseId: id, promotion: promotionResult })),
      annotations: { ...idempotentWrite, destructiveHint: true },
    },
    (input) => invoke('close_case', () => service.closeCase(input)),
  )

  server.registerTool(
    'mark_regression',
    {
      description: 'Mark matching verified knowledge regressed while preserving immutable history.',
      inputSchema: z
        .object({
          project: projectReference,
          caseId: id,
          solutionId: id,
          fingerprint: text,
          observedContext: stringRecord,
          operationId: id,
        })
        .strict(),
      outputSchema: outputSchema(
        z.object({
          outcome: z.enum(['regressed', 'outside-applicability', 'different-fingerprint']),
          caseId: id,
        }),
      ),
      annotations: { ...idempotentWrite, destructiveHint: true },
    },
    (input) => invoke('mark_regression', () => service.markRegression(input)),
  )

  const importSource = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('file'), path }).strict(),
    z.object({ kind: z.literal('git'), range: text.describe('Explicit base..head Git range.') }).strict(),
  ])
  server.registerTool(
    'preview_import',
    {
      description: 'Preview candidate nodes from explicit project files or Git ranges without graph mutation.',
      inputSchema: z
        .object({
          project: projectReference,
          sources: z.array(importSource).min(1).max(32),
        })
        .strict(),
      outputSchema: outputSchema(
        z.object({
          previewId: id,
          projectId: id,
          parserVersion: text,
          sourceDigest: text,
          createdAt: timestamp,
          expiresAt: timestamp,
          proposals: z.array(genericRecord).max(MAX_ARCHIVE_ENTRIES),
        }),
      ),
      annotations: { ...additiveWrite, openWorldHint: true },
    },
    (input) => invoke('preview_import', () => service.previewImport(input)),
  )

  server.registerTool(
    'apply_import',
    {
      description: 'Apply an explicitly approved selection from a current import preview.',
      inputSchema: z
        .object({
          project: projectReference,
          previewId: id,
          proposalIds: z.array(id).min(1).max(MAX_ARCHIVE_ENTRIES),
          operationId: id,
        })
        .strict(),
      outputSchema: outputSchema(
        z.object({
          previewId: id,
          proposalIds: z.array(id).max(MAX_ARCHIVE_ENTRIES),
          caseIds: z.array(id).max(MAX_ARCHIVE_ENTRIES),
          nodeIds: z.array(id).max(MAX_ARCHIVE_ENTRIES),
          created: z.number().int().nonnegative(),
        }),
      ),
      annotations: idempotentWrite,
    },
    (input) => invoke('apply_import', () => service.applyImport(input)),
  )

  const snapshotCase = z.object({
    id,
    projectId: id,
    title: text,
    status: nodeStatus,
    createdAt: timestamp,
  })
  const snapshotNode = nodeResult
  const snapshotEdge = edgeResult
  const snapshotEvidence = z.object({
    id,
    projectId: id,
    nodeId: id,
    kind: z.enum(['automated', 'human']),
    command: argv.nullable(),
    exitStatus: z.number().int().nullable(),
    data: z.record(boundedJsonValue),
    createdAt: timestamp,
  })
  const snapshotFingerprint = z.object({
    id,
    projectId: id,
    problemNodeId: id,
    algorithm: text,
    value: text,
    createdAt: timestamp,
  })
  const snapshotGuardrail = z.object({
    id,
    projectId: id,
    nodeId: id,
    enforcement: z.enum(['advise', 'warn', 'block']),
    criteria: z.record(boundedJsonValue),
    createdAt: timestamp,
  })
  const snapshotArtifact = z.object({
    id,
    projectId: id,
    nodeId: id.nullable(),
    kind: text,
    uri: path,
    digest: text.nullable(),
    isExternal: z.boolean(),
    metadata: z.record(boundedJsonValue),
    createdAt: timestamp,
  })
  const snapshot = z
    .object({
      format: z.literal('engineering-knowledge-graph'),
      version: z.literal(1),
      exportedAt: timestamp,
      project: z.object({
        id,
        name: text,
        description: z.string().max(MAX_TEXT_LENGTH).nullable(),
        createdAt: timestamp,
      }),
      cases: z.array(snapshotCase).max(MAX_ARCHIVE_ENTRIES),
      nodes: z.array(snapshotNode).max(MAX_ARCHIVE_ENTRIES),
      edges: z.array(snapshotEdge).max(MAX_ARCHIVE_ENTRIES),
      evidence: z.array(snapshotEvidence).max(MAX_ARCHIVE_ENTRIES),
      fingerprints: z.array(snapshotFingerprint).max(MAX_ARCHIVE_ENTRIES),
      guardrails: z.array(snapshotGuardrail).max(MAX_ARCHIVE_ENTRIES),
      artifacts: z.array(snapshotArtifact).max(MAX_ARCHIVE_ENTRIES),
    })
    .strict()

  server.registerTool(
    'export_project_graph',
    {
      description: 'Export one project as a versioned redacted portable graph snapshot.',
      inputSchema: z.object({ project: projectReference }).strict(),
      outputSchema: outputSchema(snapshot),
      annotations: readOnly,
    },
    (input) => invoke('export_project_graph', () => service.exportProjectGraph(input)),
  )

  server.registerTool(
    'import_project_graph',
    {
      description: 'Import a validated graph snapshot into one explicitly selected target project.',
      inputSchema: z
        .object({
          project: projectReference,
          archive: snapshot,
          operationId: id,
        })
        .strict(),
      outputSchema: outputSchema(
        z.object({
          sourceProjectId: id,
          targetProjectId: id,
          idMap: z.record(id),
          created: z.object({
            cases: z.number().int().nonnegative(),
            nodes: z.number().int().nonnegative(),
            edges: z.number().int().nonnegative(),
            evidence: z.number().int().nonnegative(),
            fingerprints: z.number().int().nonnegative(),
            guardrails: z.number().int().nonnegative(),
            artifacts: z.number().int().nonnegative(),
          }),
        }),
      ),
      annotations: idempotentWrite,
    },
    (input) => invoke('import_project_graph', () => service.importProjectGraph(input)),
  )

  return server
}
