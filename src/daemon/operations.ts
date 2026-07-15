import type { KnowledgeServiceContract } from '../application/contracts.js'
import type { DaemonOperation } from './protocol.js'

type UnaryMethod = (input: never) => unknown

const METHOD_BY_OPERATION: Record<Exclude<DaemonOperation, 'listProjects'>, keyof KnowledgeServiceContract> = {
  registerProject: 'registerProject',
  resolveProject: 'resolveProject',
  updateProject: 'updateProject',
  queryKnowledge: 'queryKnowledge',
  getCase: 'getCase',
  listRecentActivity: 'listRecentActivity',
  preflight: 'preflight',
  recordProblem: 'recordProblem',
  recordAttempt: 'recordAttempt',
  recordRootCause: 'recordRootCause',
  recordSolution: 'recordSolution',
  recordVerification: 'recordVerification',
  recordArtifactReference: 'recordArtifactReference',
  recordGuardrail: 'recordGuardrail',
  recordCheckpoint: 'recordCheckpoint',
  checkpointWork: 'checkpointWork',
  recordCommandStarted: 'recordCommandStarted',
  recordCommandResult: 'recordCommandResult',
  closeCase: 'closeCase',
  markRegression: 'markRegression',
  previewImport: 'previewImport',
  applyImport: 'applyImport',
  exportProjectGraph: 'exportProjectGraph',
  importProjectGraph: 'importProjectGraph',
}

export function dispatchDaemonOperation(
  service: KnowledgeServiceContract,
  operation: DaemonOperation,
  input: unknown,
): unknown {
  if (operation === 'listProjects') return service.listProjects()
  const method = service[METHOD_BY_OPERATION[operation]] as UnaryMethod
  return method.call(service, input as never)
}
