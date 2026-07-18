import { homedir } from 'node:os'
import { resolveDaemonPaths } from '../daemon/config.js'

export interface ParsedArguments {
  dataDirectory: string
  embedded: boolean
  command: CliCommand
}

export type CliCommand =
  | { kind: 'help'; topic: string[] }
  | { kind: 'version' }
  | { kind: 'update' }
  | { kind: 'serve'; port?: number }
  | { kind: 'mcp-stdio' }
  | { kind: 'project-register'; root: string; name: string; description?: string }
  | { kind: 'project-list' }
  | { kind: 'project-resolve'; projectId?: string; projectRoot?: string }
  | { kind: 'project-update'; projectId: string; name?: string; description?: string; addAlias?: string }
  | { kind: 'query'; projectId: string; text?: string; filters: Record<string, unknown> }
  | { kind: 'preflight'; projectId: string; taskDescription: string; command?: string[]; changedFiles: string[] }
  | { kind: 'run'; projectId: string; taskDescription: string; commandCaseId?: string; attemptId?: string; changedFiles: string[]; argv: string[] }
  | { kind: 'case-start'; projectId: string; caseTitle?: string; data: Record<string, unknown>; operationId?: string }
  | { kind: 'case-attempt'; projectId: string; caseId: string; problemId: string; previousAttemptId?: string; data: Record<string, unknown>; operationId?: string }
  | { kind: 'case-root-cause'; projectId: string; caseId: string; problemId: string; failedAttemptIds: string[]; status?: 'candidate' | 'verified'; humanConfirmed: boolean; data: Record<string, unknown>; operationId?: string }
  | { kind: 'case-solution'; projectId: string; caseId: string; rootCauseId: string; data: Record<string, unknown>; operationId?: string }
  | { kind: 'case-verify'; projectId: string; caseId: string; solutionId: string; data: Record<string, unknown>; operationId?: string }
  | { kind: 'case-close'; projectId: string; caseId: string; operationId?: string }
  | { kind: 'case-regress'; projectId: string; caseId: string; solutionId: string; fingerprint: string; observedContext: Record<string, string>; operationId?: string }
  | { kind: 'import-preview'; projectId: string; sources: unknown[] }
  | { kind: 'import-apply'; projectId: string; previewId: string; proposalIds: string[]; operationId: string }
  | { kind: 'import-graph'; projectId: string; file: string; operationId: string }
  | { kind: 'export'; projectId: string; output?: string }
  | { kind: 'activity'; projectId: string; afterSequence?: number; limit?: number }
  | { kind: 'disk-start'; projectId: string; operationId: string; task: string }
  | { kind: 'disk-finish'; projectId: string; operationId: string; observationId: string }
  | { kind: 'disk-list'; projectId: string; limit?: number }
  | { kind: 'disk-candidates'; projectId: string; limit?: number }
  | { kind: 'integrity' }
  | { kind: 'checkpoint'; projectId?: string; projectRoot?: string; operationId?: string; task: string; outcome: 'failed' | 'succeeded' | 'inconclusive'; summary: string; data: Record<string, unknown> }
  | { kind: 'daemon'; action: 'foreground' | 'status' | 'stop' | 'install' | 'uninstall' | 'doctor' }

export function defaultDataDirectory(
  environment: Record<string, string | undefined> = process.env,
  home = homedir(),
): string {
  return resolveDaemonPaths({ platform: process.platform, home, environment }).dataDirectory
}

class ArgumentReader {
  constructor(private readonly values: string[]) {}

  take(): string {
    const value = this.values.shift()
    if (value === undefined) throw new Error('Missing command')
    return value
  }

  remaining(): string[] {
    return [...this.values]
  }

  option(name: string): string | undefined {
    const index = this.values.indexOf(name)
    if (index === -1) return undefined
    const value = this.values[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
    this.values.splice(index, 2)
    return value
  }

  required(name: string): string {
    const value = this.option(name)
    if (value === undefined || value.trim() === '') throw new Error(`${name} is required`)
    return value
  }

  json<T>(name: string, fallback?: T): T {
    const raw = this.option(name)
    if (raw === undefined && fallback !== undefined) return fallback
    if (raw === undefined) throw new Error(`${name} is required`)
    try {
      return JSON.parse(raw) as T
    } catch {
      throw new Error(`${name} must be valid JSON`)
    }
  }

  integer(name: string): number | undefined {
    const raw = this.option(name)
    if (raw === undefined) return undefined
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
    return value
  }

  flag(name: string): boolean {
    const index = this.values.indexOf(name)
    if (index === -1) return false
    this.values.splice(index, 1)
    return true
  }

  assertEmpty(): void {
    if (this.values.length > 0) throw new Error(`Unexpected argument: ${this.values[0]}`)
  }
}

function projectId(reader: ArgumentReader): string {
  return reader.required('--project')
}

function data(reader: ArgumentReader): Record<string, unknown> {
  return reader.json<Record<string, unknown>>('--data-json')
}

function checkpointData(reader: ArgumentReader): Record<string, unknown> {
  const value = reader.json<Record<string, unknown>>('--data-json', {})
  if (!isObject(value)) throw new Error('checkpoint --data-json must be a JSON object')
  const allowed = new Set([
    'caseId', 'importance', 'fingerprint', 'files', 'command', 'evidence',
    'rootCause', 'solution', 'humanConfirmed',
  ])
  const unsupported = Object.keys(value).find((key) => !allowed.has(key))
  if (unsupported) throw new Error(`checkpoint --data-json has unsupported field: ${unsupported}`)
  for (const field of ['caseId', 'fingerprint'] as const) {
    if (value[field] !== undefined && !nonEmptyString(value[field])) {
      throw new Error(`checkpoint --data-json ${field} must be a non-empty string`)
    }
  }
  if (value.importance !== undefined && !['routine', 'notable', 'critical'].includes(String(value.importance))) {
    throw new Error('checkpoint --data-json importance must be routine, notable, or critical')
  }
  for (const field of ['files', 'evidence'] as const) validateStringArray(value[field], field, false)
  validateStringArray(value.command, 'command', true)
  if (value.humanConfirmed !== undefined && typeof value.humanConfirmed !== 'boolean') {
    throw new Error('checkpoint --data-json humanConfirmed must be boolean')
  }
  if (value.rootCause !== undefined) {
    if (!isObject(value.rootCause)
      || !exactKeys(value.rootCause, ['explanation', 'confidence', 'rejectedAlternatives'])
      || !nonEmptyString(value.rootCause.explanation)
      || typeof value.rootCause.confidence !== 'number'
      || !Number.isFinite(value.rootCause.confidence)
      || value.rootCause.confidence < 0
      || value.rootCause.confidence > 1) {
      throw new Error('checkpoint --data-json rootCause must be an object with explanation (string) and confidence (number from 0 to 1)')
    }
    validateStringArray(value.rootCause.rejectedAlternatives, 'rootCause.rejectedAlternatives', false)
  }
  if (value.solution !== undefined) {
    if (!isObject(value.solution)
      || !exactKeys(value.solution, ['summary', 'applicability', 'limitations', 'decisiveDifference'])
      || !nonEmptyString(value.solution.summary)
      || !nonEmptyString(value.solution.decisiveDifference)) {
      throw new Error('checkpoint --data-json solution must be an object with summary, applicability, limitations, and decisiveDifference')
    }
    validateStringArray(value.solution.applicability, 'solution.applicability', true, true)
    validateStringArray(value.solution.limitations, 'solution.limitations', true, true)
  }
  return value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const keys = Object.keys(value)
  return keys.every((key) => allowed.includes(key))
}

function validateStringArray(value: unknown, field: string, requireNonEmpty: boolean, required = false): void {
  if (value === undefined && !required) return
  if (!Array.isArray(value)
    || (requireNonEmpty && value.length === 0)
    || value.some((item) => !nonEmptyString(item))) {
    const qualifier = requireNonEmpty ? 'a non-empty array' : 'an array'
    throw new Error(`checkpoint --data-json ${field} must be ${qualifier} of non-empty strings`)
  }
}

function operationId(reader: ArgumentReader): string | undefined {
  return reader.option('--operation')
}

export function parseArguments(argv: string[]): ParsedArguments {
  const values = [...argv]
  let dataDirectory = defaultDataDirectory()
  let embedded = false
  while (values[0] === '--data-dir' || values[0] === '--embedded') {
    if (values[0] === '--embedded') {
      embedded = true
      values.splice(0, 1)
      continue
    }
    if (!values[1]) throw new Error('--data-dir requires a value')
    dataDirectory = values[1]
    embedded = true // Backward-compatible explicit test/recovery mode.
    values.splice(0, 2)
  }
  if (values.length === 0) return { dataDirectory, embedded, command: { kind: 'help', topic: [] } }
  if (values[0] === 'help' || values[0] === '--help' || values[0] === '-h') {
    values.shift()
    return {
      dataDirectory,
      embedded,
      command: {
        kind: 'help',
        topic: helpTopic(values.filter(value => value !== '--help' && value !== '-h')),
      },
    }
  }
  if (values[1] === 'help') {
    return {
      dataDirectory,
      embedded,
      command: { kind: 'help', topic: helpTopic([values[0]!, ...values.slice(2)]) },
    }
  }
  const childBoundary = values.indexOf('--')
  const helpSearchEnd = childBoundary === -1 ? values.length : childBoundary
  const helpIndex = values.slice(0, helpSearchEnd).findIndex(value => value === '--help' || value === '-h')
  if (helpIndex !== -1) {
    return { dataDirectory, embedded, command: { kind: 'help', topic: helpTopic(values.slice(0, helpIndex)) } }
  }
  if (values[0] === 'version' || values[0] === '--version' || values[0] === '-V') {
    if (values.length > 1) throw new Error(`Unexpected argument: ${values[1]}`)
    return { dataDirectory, embedded, command: { kind: 'version' } }
  }
  const reader = new ArgumentReader(values)
  const commandName = reader.take()
  let command: CliCommand

  if (commandName === 'update') {
    command = { kind: 'update' }
  } else if (commandName === 'serve') {
    command = { kind: 'serve', port: reader.integer('--port') }
  } else if (commandName === 'daemon') {
    const action = reader.take()
    if (!['foreground', 'status', 'stop', 'install', 'uninstall', 'doctor'].includes(action)) {
      throw new Error(`Unknown daemon command: ${action}`)
    }
    command = { kind: 'daemon', action: action as Extract<CliCommand, { kind: 'daemon' }>['action'] }
  } else if (commandName === 'mcp') {
    if (reader.take() !== '--stdio') throw new Error('mcp requires --stdio')
    command = { kind: 'mcp-stdio' }
  } else if (commandName === 'project') {
    const action = reader.take()
    if (action === 'register') command = { kind: 'project-register', root: reader.required('--root'), name: reader.required('--name'), description: reader.option('--description') }
    else if (action === 'list') command = { kind: 'project-list' }
    else if (action === 'resolve') command = { kind: 'project-resolve', projectId: reader.option('--id'), projectRoot: reader.option('--root') }
    else if (action === 'update') command = { kind: 'project-update', projectId: projectId(reader), name: reader.option('--name'), description: reader.option('--description'), addAlias: reader.option('--add-alias') }
    else throw new Error(`Unknown project command: ${action}`)
  } else if (commandName === 'query') {
    const id = projectId(reader)
    const filters = reader.json<Record<string, unknown>>('--filters-json', {})
    const supportedFilters = new Set([
      'domain', 'nodeTypes', 'statuses', 'file', 'command', 'fingerprint', 'limit',
    ])
    const unsupported = Object.keys(filters).find((key) => !supportedFilters.has(key))
    if (unsupported) throw new Error(`Unsupported query filter: ${unsupported}`)
    const rest = reader.remaining()
    if (rest.some((value) => value.startsWith('--'))) throw new Error(`Unexpected argument: ${rest.find((value) => value.startsWith('--'))}`)
    command = { kind: 'query', projectId: id, text: rest.join(' ').trim() || undefined, filters }
    return { dataDirectory, embedded, command }
  } else if (commandName === 'preflight') {
    command = { kind: 'preflight', projectId: projectId(reader), taskDescription: reader.required('--task'), command: reader.json<string[]>('--command-json', []), changedFiles: reader.json<string[]>('--changed-files-json', []) }
  } else if (commandName === 'checkpoint') {
    const selectedProjectId = reader.option('--project')
    const selectedProjectRoot = reader.option('--project-root')
    if (Number(selectedProjectId !== undefined) + Number(selectedProjectRoot !== undefined) !== 1) {
      throw new Error('checkpoint requires exactly one of --project or --project-root')
    }
    const outcome = reader.required('--outcome')
    if (!['failed', 'succeeded', 'inconclusive'].includes(outcome)) {
      throw new Error('--outcome must be failed, succeeded, or inconclusive')
    }
    command = {
      kind: 'checkpoint', projectId: selectedProjectId, projectRoot: selectedProjectRoot,
      operationId: reader.option('--operation'), task: reader.required('--task'),
      outcome: outcome as 'failed' | 'succeeded' | 'inconclusive',
      summary: reader.required('--summary'), data: checkpointData(reader),
    }
  } else if (commandName === 'run') {
    const separator = values.indexOf('--')
    if (separator === -1) throw new Error('run requires -- before the child argv')
    const commandValues = values.splice(separator + 1)
    values.splice(separator)
    command = { kind: 'run', projectId: projectId(reader), taskDescription: reader.option('--task') ?? commandValues.join(' '), commandCaseId: reader.option('--case'), attemptId: reader.option('--attempt'), changedFiles: reader.json<string[]>('--changed-files-json', []), argv: commandValues }
    if (commandValues.length === 0) throw new Error('run requires a child command')
  } else if (commandName === 'case') {
    const action = reader.take()
    const id = projectId(reader)
    if (action === 'start') command = { kind: 'case-start', projectId: id, caseTitle: reader.option('--title'), data: data(reader), operationId: operationId(reader) }
    else if (action === 'attempt') command = { kind: 'case-attempt', projectId: id, caseId: reader.required('--case'), problemId: reader.required('--problem'), previousAttemptId: reader.option('--previous-attempt'), data: data(reader), operationId: operationId(reader) }
    else if (action === 'root-cause') command = { kind: 'case-root-cause', projectId: id, caseId: reader.required('--case'), problemId: reader.required('--problem'), failedAttemptIds: reader.json<string[]>('--failed-attempts-json', []), status: reader.option('--status') as 'candidate' | 'verified' | undefined, humanConfirmed: reader.flag('--human-confirmed'), data: data(reader), operationId: operationId(reader) }
    else if (action === 'solution') command = { kind: 'case-solution', projectId: id, caseId: reader.required('--case'), rootCauseId: reader.required('--root-cause'), data: data(reader), operationId: operationId(reader) }
    else if (action === 'verify') command = { kind: 'case-verify', projectId: id, caseId: reader.required('--case'), solutionId: reader.required('--solution'), data: data(reader), operationId: operationId(reader) }
    else if (action === 'close') command = { kind: 'case-close', projectId: id, caseId: reader.required('--case'), operationId: operationId(reader) }
    else if (action === 'regress') command = { kind: 'case-regress', projectId: id, caseId: reader.required('--case'), solutionId: reader.required('--solution'), fingerprint: reader.required('--fingerprint'), observedContext: reader.json<Record<string, string>>('--context-json'), operationId: operationId(reader) }
    else throw new Error(`Unknown case command: ${action}`)
  } else if (commandName === 'import') {
    const action = reader.take()
    const id = projectId(reader)
    if (action === 'preview') command = { kind: 'import-preview', projectId: id, sources: reader.json<unknown[]>('--sources-json') }
    else if (action === 'apply') command = { kind: 'import-apply', projectId: id, previewId: reader.required('--preview'), proposalIds: reader.json<string[]>('--proposals-json'), operationId: reader.required('--operation') }
    else if (action === 'graph') command = { kind: 'import-graph', projectId: id, file: reader.required('--file'), operationId: reader.required('--operation') }
    else throw new Error(`Unknown import command: ${action}`)
  } else if (commandName === 'export') {
    command = { kind: 'export', projectId: projectId(reader), output: reader.option('--output') }
  } else if (commandName === 'activity') {
    command = { kind: 'activity', projectId: projectId(reader), afterSequence: reader.integer('--after'), limit: reader.integer('--limit') }
  } else if (commandName === 'disk') {
    const action = reader.take()
    const id = projectId(reader)
    if (action === 'start') command = { kind: 'disk-start', projectId: id, operationId: reader.required('--operation'), task: reader.required('--task') }
    else if (action === 'finish') command = { kind: 'disk-finish', projectId: id, operationId: reader.required('--operation'), observationId: reader.required('--observation') }
    else if (action === 'list') command = { kind: 'disk-list', projectId: id, limit: reader.integer('--limit') }
    else if (action === 'candidates') command = { kind: 'disk-candidates', projectId: id, limit: reader.integer('--limit') }
    else throw new Error(`Unknown disk command: ${action}`)
  } else if (commandName === 'integrity') {
    command = { kind: 'integrity' }
  } else {
    throw new Error(`Unknown command: ${commandName}`)
  }

  reader.assertEmpty()
  if (command.kind === 'update' && embedded) {
    throw new Error('update does not accept --data-dir or --embedded')
  }
  return { dataDirectory, embedded, command }
}

function helpTopic(values: string[]): string[] {
  const first = values[0]
  if (!first) return []
  const grouped = new Set(['project', 'case', 'import', 'disk', 'daemon'])
  const second = values[1]
  if (grouped.has(first) && second && !second.startsWith('-')) return [first, second]
  return [first]
}
