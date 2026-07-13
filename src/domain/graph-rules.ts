import { InvalidGraphError } from './errors.js'

export const nodeTypes = [
  'Problem',
  'Attempt',
  'RootCause',
  'Solution',
  'Verification',
  'SuccessCase',
  'Guardrail',
  'Artifact',
] as const

export type NodeType = (typeof nodeTypes)[number]

export const nodeStatuses = [
  'open',
  'candidate',
  'verified',
  'regressed',
  'retired',
] as const

export type NodeStatus = (typeof nodeStatuses)[number]

export const relationTypes = [
  'ATTEMPTS_TO_SOLVE',
  'PRECEDED_BY',
  'FAILED_BECAUSE',
  'CAUSES',
  'ADDRESSES',
  'VERIFIED_BY',
  'REFERENCES',
  'INCLUDES',
  'PREVENTS',
  'SUPERSEDES',
] as const

export type RelationType = (typeof relationTypes)[number]

const allowedRelations = new Set<string>([
  'Attempt:ATTEMPTS_TO_SOLVE:Problem',
  'Attempt:PRECEDED_BY:Attempt',
  'Attempt:FAILED_BECAUSE:RootCause',
  'RootCause:CAUSES:Problem',
  'Solution:ADDRESSES:RootCause',
  'Solution:VERIFIED_BY:Verification',
  'Verification:REFERENCES:Artifact',
  'SuccessCase:INCLUDES:Problem',
  'SuccessCase:INCLUDES:Attempt',
  'SuccessCase:INCLUDES:RootCause',
  'SuccessCase:INCLUDES:Solution',
  'SuccessCase:INCLUDES:Verification',
  'Guardrail:PREVENTS:RootCause',
  'Solution:SUPERSEDES:Solution',
])

export function validateRelation(
  source: NodeType,
  relation: RelationType,
  target: NodeType,
): void {
  if (!allowedRelations.has(`${source}:${relation}:${target}`)) {
    throw new InvalidGraphError(
      `Invalid relation: ${source} --${relation}--> ${target}`,
    )
  }
}

export function assertAcyclic(
  edges: ReadonlyArray<{ sourceId: string; targetId: string }>,
): void {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const targets = adjacency.get(edge.sourceId) ?? []
    targets.push(edge.targetId)
    adjacency.set(edge.sourceId, targets)
    if (!adjacency.has(edge.targetId)) {
      adjacency.set(edge.targetId, [])
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()

  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      throw new InvalidGraphError('Relation would create a cycle inside the Case')
    }
    if (visited.has(nodeId)) {
      return
    }

    visiting.add(nodeId)
    for (const targetId of adjacency.get(nodeId) ?? []) {
      visit(targetId)
    }
    visiting.delete(nodeId)
    visited.add(nodeId)
  }

  for (const nodeId of adjacency.keys()) {
    visit(nodeId)
  }
}
