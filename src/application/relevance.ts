import type { NodeRecord } from '../cases/case-graph.js'
import type { NodeStatus } from '../domain/graph-rules.js'
import type {
  PreflightCard,
  PreflightGuardrail,
  PreflightMatchReason,
  PreflightResult,
} from './contracts.js'

export const RELEVANCE_WEIGHTS = {
  exactFingerprint: 1_000,
  blockingGuardrail: 900,
  exactFile: 500,
  exactCommand: 350,
  verifiedKnowledge: 200,
  textMatch: 40,
  candidate30DayPenalty: -80,
  candidate90DayPenalty: -400,
  regressedPenalty: -250,
  retiredPenalty: -1_000,
} as const

const COMMON_TERMS = new Set([
  'build', 'test', 'tests', 'project', 'change', 'update', 'error', 'issue', 'fix',
  'with', 'from', 'this', 'that', 'keep', 'verify', 'the', 'and', 'for',
])

export interface RelevanceCandidate {
  caseId: string
  caseTitle: string
  caseStatus: NodeStatus
  nodes: NodeRecord[]
  guardrails: PreflightGuardrail[]
}

export interface RelevanceContext {
  taskDescription: string
  changedFiles?: string[]
  command?: string[]
  fingerprintCaseIds?: string[]
}

export function rankCases(
  context: RelevanceContext,
  candidates: RelevanceCandidate[],
  now = new Date(),
): PreflightCard[] {
  const task = context.taskDescription.toLocaleLowerCase()
  const changedFiles = (context.changedFiles ?? []).map((value) => value.toLocaleLowerCase())
  const command = (context.command ?? []).join(' ').toLocaleLowerCase()
  const meaningfulTerms = [...new Set(
    `${task} ${changedFiles.join(' ')} ${command}`
      .split(/[^^\p{L}\p{N}_.-]+/u)
      .map((value) => value.toLocaleLowerCase())
      .filter((value) => value.length >= 3 && !COMMON_TERMS.has(value)),
  )]
  const fingerprintCases = new Set(context.fingerprintCaseIds ?? [])

  return candidates.flatMap((candidate): PreflightCard[] => {
    const serialized = JSON.stringify({ title: candidate.caseTitle, nodes: candidate.nodes })
      .toLocaleLowerCase()
    const reasons: PreflightMatchReason[] = []
    let score = 0
    if (fingerprintCases.has(candidate.caseId)) {
      score += RELEVANCE_WEIGHTS.exactFingerprint
      reasons.push({ kind: 'exact-fingerprint', value: 'normalized failure fingerprint' })
    }
    const blocking = candidate.guardrails.some((item) => item.blocks)
    if (blocking) {
      score += RELEVANCE_WEIGHTS.blockingGuardrail
      reasons.push({ kind: 'blocking-guardrail', value: 'verified blocking guardrail' })
    }
    const exactFile = changedFiles.find((file) => file && serialized.includes(file))
    if (exactFile) {
      score += RELEVANCE_WEIGHTS.exactFile
      reasons.push({ kind: 'exact-file', value: exactFile })
    }
    if (command && serialized.includes(command)) {
      score += RELEVANCE_WEIGHTS.exactCommand
      reasons.push({ kind: 'exact-command', value: command })
    }
    const verified = candidate.nodes.some((node) =>
      node.status === 'verified' && (node.type === 'RootCause' || node.type === 'Solution'))
    if (verified) {
      score += RELEVANCE_WEIGHTS.verifiedKnowledge
      reasons.push({ kind: 'verified-knowledge', value: 'verified root cause or solution' })
    }
    const matchedTerms = meaningfulTerms.filter((term) => serialized.includes(term))
    if (matchedTerms.length > 0) {
      score += Math.min(4, matchedTerms.length) * RELEVANCE_WEIGHTS.textMatch
      reasons.push({ kind: 'text', value: matchedTerms.slice(0, 3).join(', ') })
    }
    const newest = candidate.nodes.reduce((latest, node) =>
      Math.max(latest, Date.parse(node.createdAt) || 0), 0)
    const ageDays = newest ? (now.getTime() - newest) / 86_400_000 : 0
    if (candidate.nodes.some((node) => node.status === 'candidate')) {
      if (ageDays >= 90) score += RELEVANCE_WEIGHTS.candidate90DayPenalty
      else if (ageDays >= 30) score += RELEVANCE_WEIGHTS.candidate30DayPenalty
    }
    if (candidate.caseStatus === 'regressed') score += RELEVANCE_WEIGHTS.regressedPenalty
    if (candidate.caseStatus === 'retired') score += RELEVANCE_WEIGHTS.retiredPenalty
    if (score <= 0 || reasons.length === 0) return []
    return [{
      caseId: candidate.caseId,
      caseTitle: candidate.caseTitle,
      score,
      whyMatched: reasons,
      failedAttempt: newestNode(candidate.nodes, (node) => node.type === 'Attempt' && node.data.outcome === 'failed'),
      rootCause: newestNode(candidate.nodes, (node) => node.type === 'RootCause' && node.status === 'verified'),
      solution: newestNode(candidate.nodes, (node) => node.type === 'Solution' && node.status === 'verified'),
      ...(candidate.guardrails.length > 0 && { guardrails: candidate.guardrails }),
    }]
  }).sort((left, right) => right.score - left.score || left.caseId.localeCompare(right.caseId))
}

export function compactPreflight(
  input: Omit<PreflightResult, 'truncated' | 'expansionCaseIds'> & Partial<Pick<PreflightResult, 'truncated' | 'expansionCaseIds'>>,
  maxBytes = 12 * 1024,
): PreflightResult {
  const originalIds = input.cards.map((card) => card.caseId)
  const cards = input.cards.slice(0, 5).map(compactCard)
  const result: PreflightResult = {
    ...input,
    cards,
    guardrails: cards.flatMap((card) => card.guardrails ?? []),
    failedAttempts: cards.flatMap((card) => card.failedAttempt ? [card.failedAttempt] : []),
    rootCauses: cards.flatMap((card) => card.rootCause ? [card.rootCause] : []),
    solutions: cards.flatMap((card) => card.solution ? [card.solution] : []),
    uncertain: input.uncertain.slice(0, 3).map(compactNode),
    truncated: originalIds.length > cards.length,
    expansionCaseIds: originalIds.slice(cards.length),
  }
  while (Buffer.byteLength(JSON.stringify(result)) >= maxBytes && result.cards.length > 1) {
    const removed = result.cards.pop()
    if (removed) result.expansionCaseIds.unshift(removed.caseId)
    result.truncated = true
    result.guardrails = result.cards.flatMap((card) => card.guardrails ?? [])
    result.failedAttempts = result.cards.flatMap((card) => card.failedAttempt ? [card.failedAttempt] : [])
    result.rootCauses = result.cards.flatMap((card) => card.rootCause ? [card.rootCause] : [])
    result.solutions = result.cards.flatMap((card) => card.solution ? [card.solution] : [])
  }
  if (Buffer.byteLength(JSON.stringify(result)) >= maxBytes && result.uncertain.length > 0) {
    result.uncertain = []
    result.truncated = true
  }
  return result
}

function newestNode(nodes: NodeRecord[], predicate: (node: NodeRecord) => boolean): NodeRecord | undefined {
  return nodes.filter(predicate).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
}

function compactCard(card: PreflightCard): PreflightCard {
  return {
    ...card,
    caseTitle: card.caseTitle.slice(0, 300),
    whyMatched: card.whyMatched.slice(0, 4),
    ...(card.failedAttempt && { failedAttempt: compactNode(card.failedAttempt) }),
    ...(card.rootCause && { rootCause: compactNode(card.rootCause) }),
    ...(card.solution && { solution: compactNode(card.solution) }),
    ...(card.guardrails && { guardrails: card.guardrails.slice(0, 2).map((item) => ({ ...item, node: compactNode(item.node) })) }),
  }
}

function compactNode(node: NodeRecord): NodeRecord {
  const data: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node.data).slice(0, 8)) {
    if (typeof value === 'string') data[key] = value.slice(0, 160)
    else if (Array.isArray(value)) data[key] = value.slice(0, 3).map((item) =>
      typeof item === 'string' ? item.slice(0, 120) : item)
    else data[key] = value
  }
  return { ...node, data }
}
