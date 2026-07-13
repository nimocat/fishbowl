import type { NodeDataByType } from '../domain/node-data.js'
import type { NodeType } from '../domain/graph-rules.js'
import { boundedRedactedExcerpt, redactSecrets } from '../security/redaction.js'

export const IMPORT_PARSER_VERSION = 'import-parser-v1'

const MAX_PROPOSALS_PER_SOURCE = 100
const MAX_PROPOSAL_TEXT_BYTES = 8 * 1024

export interface ImportProposalDraft<T extends NodeType = NodeType> {
  nodeType: T
  status: 'candidate'
  caseTitle: string
  data: NodeDataByType[T]
}

function safeText(input: string): string {
  return boundedRedactedExcerpt(input.trim(), MAX_PROPOSAL_TEXT_BYTES)
}

function problem(title: string, details?: string): ImportProposalDraft<'Problem'> {
  const summary = safeText(title) || 'Imported issue'
  const detail = details ? safeText(details) : ''
  return {
    nodeType: 'Problem',
    status: 'candidate',
    caseTitle: summary,
    data: {
      summary,
      ...(detail ? { symptoms: [detail] } : {}),
    },
  }
}

export function parseTextImport(content: string): ImportProposalDraft[] {
  const redacted = redactSecrets(content).replace(/\r\n?/g, '\n')
  const heading = /^#{1,6}\s+(.+)$/gm
  const matches = [...redacted.matchAll(heading)]
  if (matches.length === 0) {
    const lines = redacted.split('\n').map((line) => line.trim()).filter(Boolean)
    return lines.length === 0 ? [] : [problem(lines[0] as string, lines.slice(1).join('\n'))]
  }
  return matches.slice(0, MAX_PROPOSALS_PER_SOURCE).map((match, index) => {
    const start = (match.index ?? 0) + match[0].length
    const end = matches[index + 1]?.index ?? redacted.length
    return problem(match[1] as string, redacted.slice(start, end))
  })
}

interface TestFinding {
  title: string
  status: string
  details?: string
}

function collectTestFindings(value: unknown, findings: TestFinding[], suite = ''): void {
  if (findings.length >= MAX_PROPOSALS_PER_SOURCE || !value || typeof value !== 'object') {
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTestFindings(item, findings, suite)
    }
    return
  }
  const record = value as Record<string, unknown>
  const nextSuite =
    typeof record.name === 'string' ? record.name : typeof record.testFilePath === 'string' ? record.testFilePath : suite
  const title =
    typeof record.title === 'string'
      ? record.title
      : typeof record.fullName === 'string'
        ? record.fullName
        : undefined
  const status = typeof record.status === 'string' ? record.status.toLowerCase() : undefined
  if (title && status && ['failed', 'failure', 'broken', 'error'].includes(status)) {
    const messages = Array.isArray(record.failureMessages)
      ? record.failureMessages.filter((entry): entry is string => typeof entry === 'string').join('\n')
      : typeof record.message === 'string'
        ? record.message
        : undefined
    findings.push({ title: suite ? `${suite}: ${title}` : title, status, details: messages })
  }
  for (const [key, child] of Object.entries(record)) {
    if (key !== 'failureMessages' && typeof child === 'object') {
      collectTestFindings(child, findings, nextSuite)
    }
  }
}

export function parseJsonTestReport(content: string): ImportProposalDraft[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return parseTextImport(content)
  }
  const findings: TestFinding[] = []
  collectTestFindings(parsed, findings)
  return findings.flatMap((finding): ImportProposalDraft[] => {
    const caseTitle = safeText(finding.title)
    const detail = safeText(finding.details ?? `Test status: ${finding.status}`)
    return [
      problem(caseTitle, detail),
      {
        nodeType: 'Attempt',
        status: 'candidate',
        caseTitle,
        data: {
          hypothesis: 'Imported test execution',
          change: `Ran test: ${caseTitle}`,
          outcome: 'failed',
          failureExplanation: detail,
        },
      },
    ]
  }).slice(0, MAX_PROPOSALS_PER_SOURCE)
}

export function parseImportContent(pathHint: string, content: string): ImportProposalDraft[] {
  return pathHint.toLowerCase().endsWith('.json')
    ? parseJsonTestReport(content)
    : parseTextImport(content)
}
