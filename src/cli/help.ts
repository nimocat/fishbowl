interface HelpEntry {
  usage: string
  description: string
  details?: string[]
  example?: string
}

const HELP: Record<string, HelpEntry> = {
  version: { usage: 'version | --version | -V', description: 'Print the Fishbowl CLI version.' },
  update: { usage: 'update', description: 'Safely update a clean official source installation.', details: ['Human-operated only; Agents use Fishbowl through MCP.', 'Requires the official origin, the main branch, and a clean worktree.'], example: 'fishbowl update' },
  serve: { usage: 'serve [--port <number>]', description: 'Print the authenticated local Trace Bench URL.', details: ['The compatibility --port option is accepted; the native daemon reuses its persisted user-level loopback port.'], example: 'fishbowl serve' },
  mcp: { usage: 'mcp --stdio', description: 'Start the stdio MCP adapter for an MCP Host.', details: ['Configure this in Codex, Claude Desktop, or another MCP Host; do not run it interactively.'], example: 'node /absolute/path/to/fishbowl/dist/cli/main.js mcp --stdio' },
  'project register': { usage: 'project register --root <path> --name <name> [--description <text>]', description: 'Register an existing project root.', example: 'fishbowl project register --root "$PWD" --name "My Project"' },
  'project list': { usage: 'project list', description: 'List registered projects and worktree aliases.', example: 'fishbowl project list' },
  'project resolve': { usage: 'project resolve [--id <project-id> | --root <path>]', description: 'Resolve a project by ID, canonical root, or alias.', example: 'fishbowl project resolve --root "$PWD"' },
  'project update': { usage: 'project update --project <project-id> [--name <name>] [--description <text>] [--add-alias <path>]', description: 'Update project metadata or add a worktree alias.' },
  query: { usage: 'query --project <project-id> [--filters-json <json>] [text...]', description: 'Search bounded project-scoped engineering knowledge.', example: 'fishbowl query --project <id> "database migration"' },
  preflight: { usage: 'preflight --project <project-id> --task <text> [--command-json <json>] [--changed-files-json <json>]', description: 'Check known failures, solutions, and guardrails before work.' },
  checkpoint: { usage: 'checkpoint (--project <id> | --project-root <path>) --task <text> --outcome <failed|succeeded|inconclusive> --summary <text> [--operation <id>] [--data-json <json>]', description: 'Record a bounded human-operated work checkpoint.', details: ['Agents must call the checkpoint_work MCP tool directly instead of this command.'] },
  run: { usage: 'run --project <project-id> [--task <text>] [--case <id>] [--attempt <id>] [--changed-files-json <json>] -- <command> [args...]', description: 'Run a child command with Fishbowl preflight and bounded result capture.', example: 'fishbowl run --project <id> -- npm test' },
  'case start': { usage: 'case start --project <id> [--title <text>] --data-json <json> [--operation <id>]', description: 'Start a Case with a Problem node.' },
  'case attempt': { usage: 'case attempt --project <id> --case <id> --problem <id> [--previous-attempt <id>] --data-json <json> [--operation <id>]', description: 'Record an Attempt in an existing Case.' },
  'case root-cause': { usage: 'case root-cause --project <id> --case <id> --problem <id> [--failed-attempts-json <json>] [--status <candidate|verified>] [--human-confirmed] --data-json <json> [--operation <id>]', description: 'Record an evidenced RootCause.' },
  'case solution': { usage: 'case solution --project <id> --case <id> --root-cause <id> --data-json <json> [--operation <id>]', description: 'Record a Solution linked to a RootCause.' },
  'case verify': { usage: 'case verify --project <id> --case <id> --solution <id> --data-json <json> [--operation <id>]', description: 'Record Verification for a Solution.' },
  'case close': { usage: 'case close --project <id> --case <id> [--operation <id>]', description: 'Evaluate promotion requirements and close a Case.' },
  'case regress': { usage: 'case regress --project <id> --case <id> --solution <id> --fingerprint <value> --context-json <json> [--operation <id>]', description: 'Mark matching verified knowledge as regressed.' },
  'import preview': { usage: 'import preview --project <id> --sources-json <json>', description: 'Preview bounded import proposals without graph mutation.' },
  'import apply': { usage: 'import apply --project <id> --preview <id> --proposals-json <json> --operation <id>', description: 'Apply explicitly selected proposals from a current preview.' },
  'import graph': { usage: 'import graph --project <id> --file <path> --operation <id>', description: 'Import a versioned Fishbowl graph archive.' },
  export: { usage: 'export --project <id> [--output <path>]', description: 'Export a redacted versioned project graph.' },
  activity: { usage: 'activity --project <id> [--after <sequence>] [--limit <count>]', description: 'List bounded recent project activity.' },
  'disk start': { usage: 'disk start --project <id> --operation <id> --task <text>', description: 'Start a bounded regenerable-artifact observation.' },
  'disk finish': { usage: 'disk finish --project <id> --operation <id> --observation <id>', description: 'Finish an artifact observation and attribute growth.' },
  'disk list': { usage: 'disk list --project <id> [--limit <count>]', description: 'List recent disk observations.' },
  'disk candidates': { usage: 'disk candidates --project <id> [--limit <count>]', description: 'List explainable cleanup candidates without deleting files.' },
  integrity: { usage: 'integrity', description: 'Run a read-only native database integrity check.', example: 'fishbowl integrity' },
  'daemon foreground': { usage: 'daemon foreground', description: 'Run the native daemon in the foreground for human diagnostics.' },
  'daemon status': { usage: 'daemon status', description: 'Show the published daemon descriptor and process status.' },
  'daemon stop': { usage: 'daemon stop', description: 'Authenticate, stop, and wait for the current daemon.' },
  'daemon install': { usage: 'daemon install', description: 'Install or refresh the current-user daemon registration.', details: ['Reuses the owner-only daemon.port setting and returns only after authenticated readiness.', 'A fixed-port conflict is reported without silently selecting another port.'], example: 'fishbowl daemon install' },
  'daemon uninstall': { usage: 'daemon uninstall', description: 'Remove current-user daemon registration while preserving data.' },
  'daemon doctor': { usage: 'daemon doctor', description: 'Verify authenticated daemon health and show recovery context.', example: 'fishbowl daemon doctor' },
}

const GROUPS: Record<string, { description: string; commands: string[] }> = {
  project: { description: 'Register and resolve project scope.', commands: ['project register', 'project list', 'project resolve', 'project update'] },
  case: { description: 'Human-operated low-level Case graph mutations.', commands: ['case start', 'case attempt', 'case root-cause', 'case solution', 'case verify', 'case close', 'case regress'] },
  import: { description: 'Preview and apply explicit graph imports.', commands: ['import preview', 'import apply', 'import graph'] },
  disk: { description: 'Observe regenerable project artifacts without automatic deletion.', commands: ['disk start', 'disk finish', 'disk list', 'disk candidates'] },
  daemon: { description: 'Install and diagnose the current-user native daemon.', commands: ['daemon install', 'daemon doctor', 'daemon status', 'daemon stop', 'daemon uninstall', 'daemon foreground'] },
}

const LEGACY_DATA_TOPICS = new Set([
  'project register', 'project list', 'project resolve', 'project update',
  'query', 'preflight', 'checkpoint', 'run',
  'case start', 'case attempt', 'case root-cause', 'case solution', 'case verify', 'case close', 'case regress',
  'import preview', 'import apply', 'import graph', 'export', 'activity',
  'disk start', 'disk finish', 'disk list', 'disk candidates',
])

export const HELP_TOPICS = Object.freeze(Object.keys(HELP))

export function formatHelp(topicParts: string[]): string {
  const topic = normalizeTopic(topicParts)
  if (!topic) return mainHelp()
  const group = GROUPS[topic]
  if (group) {
    const compatibilityNote = topic === 'daemon'
      ? []
      : ['', 'Compatibility: these data commands are for explicit human recovery; Agents use MCP tools.']
    return [
      `Fishbowl ${topic} — ${group.description}`,
      '',
      `Usage: fishbowl ${topic} <command> [options]`,
      '',
      'Commands:',
      ...group.commands.map(commandLine),
      ...compatibilityNote,
      '',
      `Run \`fishbowl help ${topic} <command>\` for command details.`,
      'Run `fishbowl help` for all command groups.',
      '',
    ].join('\n')
  }
  const entry = HELP[topic]
  if (!entry) {
    const suggestion = nearest(topic, [...Object.keys(GROUPS), ...HELP_TOPICS])
    throw new Error(`Unknown help topic: ${topic}${suggestion ? `. Did you mean ${suggestion}?` : ''}`)
  }
  const details = [
    ...(LEGACY_DATA_TOPICS.has(topic)
      ? ['Legacy/manual recovery compatibility only; coding Agents must use Fishbowl MCP tools.']
      : []),
    ...(entry.details ?? []),
  ]
  return [
    `Fishbowl — ${entry.description}`,
    '',
    `Usage: fishbowl ${entry.usage}`,
    ...(details.length ? ['', 'Notes:', ...details.map(line => `  - ${line}`)] : []),
    ...(entry.example ? ['', 'Example:', `  ${entry.example}`] : []),
    '',
    'Run `fishbowl help` to list all commands.',
    '',
  ].join('\n')
}

export function formatCliError(argv: string[], message: string): { usage: string; hint: string; help: string } {
  const topicParts = topicFromArguments(argv)
  const topic = normalizeTopic(topicParts)
  const entry = HELP[topic]
  const parent = topicParts[0]
  const exactGroup = GROUPS[topic]
  const group = exactGroup ?? (parent ? GROUPS[parent] : undefined)
  const usage = entry
    ? `Usage: fishbowl ${entry.usage}`
    : exactGroup
      ? `Usage: fishbowl ${topic} <command> [options]`
      : group && parent
        ? `Usage: fishbowl ${parent} <command> [options]`
      : 'Usage: fishbowl <command> [options]'
  const helpTopic = entry || exactGroup ? topic : group && parent ? parent : undefined
  const help = helpTopic ? `fishbowl help ${helpTopic}` : 'fishbowl help'
  return { usage, hint: errorHint(topicParts, message, entry, group), help }
}

function mainHelp(): string {
  return [
    'Fishbowl — local, project-scoped engineering knowledge.',
    '',
    'Usage: fishbowl <command> [options]',
    '       fishbowl help <command>',
    '       fishbowl <command> --help',
    '       fishbowl --version',
    '',
    'Human installation and diagnostics:',
    '  fishbowl daemon install              Install the current-user daemon',
    '  fishbowl daemon doctor               Verify authenticated daemon health',
    '  fishbowl integrity                    Check the database without mutation',
    '  fishbowl update                       Update an official source installation',
    '',
    'Legacy/manual recovery data commands (Agents use MCP instead):',
    ...['project register', 'project list', 'query', 'preflight', 'checkpoint', 'run', 'serve', 'update'].map(commandLine),
    '',
    'Command groups:',
    ...Object.entries(GROUPS).map(([name, value]) => `  ${name.padEnd(12)} ${value.description}`),
    '',
    'Maintenance:',
    ...['daemon doctor', 'daemon status', 'integrity', 'export', 'activity'].map(commandLine),
    '',
    'Global compatibility options:',
    '  --data-dir <path>   Explicit embedded test/recovery data directory',
    '  --embedded          Use embedded test/recovery mode',
    '',
    'Agent integration:',
    '  Agents must use the configured Fishbowl MCP tools directly. Data-oriented CLI',
    '  commands remain only for legacy compatibility and explicit human recovery.',
    '  Configure an MCP Host with: fishbowl mcp --stdio',
    '',
    'Help and recovery:',
    '  fishbowl help <command>               Show command usage and examples',
    '  fishbowl daemon doctor                Diagnose daemon connectivity',
    '  fishbowl integrity                    Check the database without mutation',
    '',
  ].join('\n')
}

function commandLine(topic: string): string {
  const entry = HELP[topic]!
  return `  ${(`fishbowl ${topic}`).padEnd(34)} ${entry.description}`
}

function normalizeTopic(parts: string[]): string {
  return parts.map(value => value.trim().toLowerCase()).filter(Boolean).join(' ')
}

function topicFromArguments(argv: string[]): string[] {
  const values = [...argv]
  while (values[0] === '--embedded' || values[0] === '--data-dir') {
    if (values.shift() === '--data-dir') values.shift()
  }
  if (values[0] === 'help' || values[0] === '--help' || values[0] === '-h') values.shift()
  const first = values[0]
  if (!first || first.startsWith('-')) return []
  if (GROUPS[first]) {
    const second = values[1]
    return second && !second.startsWith('-') && second !== 'help' ? [first, second] : [first]
  }
  return [first]
}

function errorHint(topicParts: string[], message: string, entry?: HelpEntry, group?: { commands: string[] }): string {
  const required = message.match(/^(--[\w-]+) (?:is required|requires a value)/)?.[1]
  if (required && entry) {
    const valueShape = entry.usage.match(new RegExp(`${escapeRegExp(required)}\\s+<[^>]+>`))?.[0] ?? required
    return `Provide ${valueShape}, then retry. See \`fishbowl help ${normalizeTopic(topicParts)}\` for a complete example.`
  }
  const unknown = message.match(/^Unknown (?:\w+ )?command: (.+)$/)?.[1]
  if (unknown) {
    const parent = topicParts[0]
    const candidates = parent && topicParts.length > 1 && GROUPS[parent]
      ? GROUPS[parent].commands.map(value => value.split(' ')[1]!)
      : [...Object.keys(GROUPS), ...HELP_TOPICS.filter(value => !value.includes(' '))]
    const suggestion = nearest(unknown, candidates)
    return suggestion
      ? `Did you mean \`${suggestion}\`? Run \`fishbowl help ${topicParts.length > 1 ? `${topicParts[0]} ` : ''}${suggestion}\`.`
      : 'Run `fishbowl help` to list supported commands.'
  }
  if (message.includes('Missing command')) {
    return group
      ? `Choose one of: ${group.commands.map(value => value.split(' ').at(-1)).join(', ')}.`
      : 'Run `fishbowl help` to choose a command.'
  }
  if (/valid JSON|JSON object/.test(message)) return 'Pass strict JSON as one quoted argument; use a file or PowerShell here-string for complex payloads.'
  if (/daemon|ECONNREFUSED|unavailable/i.test(message)) return 'Run `fishbowl daemon doctor`; if it is not installed, run `fishbowl daemon install`.'
  if (/working tree|origin|main branch|fast-forward/i.test(message)) return 'Run `git status --short`, resolve the reported checkout condition, then retry `fishbowl update`.'
  if (message.startsWith('Unexpected argument:')) return `Remove the unsupported argument or inspect \`${entry ? `fishbowl help ${normalizeTopic(topicParts)}` : 'fishbowl help'}\`.`
  return entry
    ? `Review \`fishbowl help ${normalizeTopic(topicParts)}\` and retry with the documented options.`
    : 'Run `fishbowl help` to list commands, examples, and recovery checks.'
}

function nearest(input: string, candidates: string[]): string | undefined {
  let best: { value: string; distance: number } | undefined
  for (const candidate of candidates) {
    const distance = editDistance(input.toLowerCase(), candidate.toLowerCase())
    if (!best || distance < best.distance) best = { value: candidate, distance }
  }
  return best && best.distance <= Math.max(2, Math.floor(input.length / 3)) ? best.value : undefined
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = row[0]!
    row[0] = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const previous = row[rightIndex]!
      row[rightIndex] = Math.min(
        row[rightIndex]! + 1,
        row[rightIndex - 1]! + 1,
        diagonal + Number(left[leftIndex - 1] !== right[rightIndex - 1]),
      )
      diagonal = previous
    }
  }
  return row[right.length]!
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
