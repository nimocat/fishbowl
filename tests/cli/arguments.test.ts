import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { defaultDataDirectory, parseArguments } from '../../src/cli/arguments.js'

describe('CLI arguments', () => {
  it('uses FISHBOWL_DATA_DIR or a user-local directory rather than cwd', () => {
    expect(defaultDataDirectory({ FISHBOWL_DATA_DIR: '/var/fishbowl' }, '/home/test')).toBe('/var/fishbowl')
    expect(defaultDataDirectory({}, '/home/test')).toBe(
      process.platform === 'darwin'
        ? '/home/test/Library/Application Support/Fishbowl'
        : process.platform === 'win32'
          ? '/home/test/AppData/Local/Fishbowl'
          : '/home/test/.local/share/fishbowl',
    )
    expect(defaultDataDirectory()).toBe(
      process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'Fishbowl')
        : process.platform === 'win32'
          ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Fishbowl')
          : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'fishbowl'),
    )
  })

  it('treats bare invocation and common help spellings as help commands', () => {
    expect(parseArguments([]).command).toEqual({ kind: 'help', topic: [] })
    expect(parseArguments(['help']).command).toEqual({ kind: 'help', topic: [] })
    expect(parseArguments(['--help']).command).toEqual({ kind: 'help', topic: [] })
    expect(parseArguments(['-h']).command).toEqual({ kind: 'help', topic: [] })
    expect(parseArguments(['help', 'project', 'register']).command)
      .toEqual({ kind: 'help', topic: ['project', 'register'] })
    expect(parseArguments(['help', 'query', '--project', 'p']).command)
      .toEqual({ kind: 'help', topic: ['query'] })
    expect(parseArguments(['project', 'register', '--help']).command)
      .toEqual({ kind: 'help', topic: ['project', 'register'] })
    expect(parseArguments(['query', '--project', 'p', '--help']).command)
      .toEqual({ kind: 'help', topic: ['query'] })
    expect(parseArguments(['mcp', '--stdio', '--help']).command)
      .toEqual({ kind: 'help', topic: ['mcp'] })
    expect(parseArguments(['version', '--help']).command)
      .toEqual({ kind: 'help', topic: ['version'] })
    expect(parseArguments(['project', 'help']).command)
      .toEqual({ kind: 'help', topic: ['project'] })
    expect(parseArguments(['project', 'help', 'register', '--name', 'Example']).command)
      .toEqual({ kind: 'help', topic: ['project', 'register'] })
    expect(parseArguments(['--version']).command).toEqual({ kind: 'version' })
    expect(parseArguments(['-V']).command).toEqual({ kind: 'version' })
    expect(parseArguments([
      'run', '--project', 'p', '--', 'tool', '--help',
    ]).command).toMatchObject({ kind: 'run', argv: ['tool', '--help'] })
  })

  it('parses global data directory and exact run argv without reinterpretation', () => {
    expect(
      parseArguments([
        '--data-dir',
        '/tmp/fishbowl',
        'run',
        '--project',
        'project-a',
        '--task',
        'test argv',
        '--',
        'node',
        '-e',
        'console.log("a b")',
        '--literal=$HOME',
      ]),
    ).toEqual({
      dataDirectory: '/tmp/fishbowl',
      embedded: true,
      command: {
        kind: 'run',
        projectId: 'project-a',
        taskDescription: 'test argv',
        changedFiles: [],
        argv: ['node', '-e', 'console.log("a b")', '--literal=$HOME'],
      },
    })
  })

  it('parses structured case and import values only from JSON', () => {
    expect(
      parseArguments([
        'case',
        'root-cause',
        '--project',
        'project-a',
        '--case',
        'case-a',
        '--problem',
        'problem-a',
        '--failed-attempts-json',
        '["attempt-a"]',
        '--status',
        'verified',
        '--data-json',
        '{"explanation":"cause","evidence":["trace"],"confidence":0.9}',
      ]).command,
    ).toMatchObject({
      kind: 'case-root-cause',
      failedAttemptIds: ['attempt-a'],
      status: 'verified',
      data: { explanation: 'cause', evidence: ['trace'], confidence: 0.9 },
    })

    expect(() =>
      parseArguments(['import', 'preview', '--project', 'p', '--sources-json', 'not-json']),
    ).toThrow(/valid JSON/)
  })

  it('rejects query filter keys that could override explicit project scope', () => {
    expect(() =>
      parseArguments([
        'query', '--project', 'project-a', '--filters-json',
        '{"project":{"projectId":"project-b"}}',
      ]),
    ).toThrow(/Unsupported query filter: project/)
  })

  it('parses daemon lifecycle commands without project scope', () => {
    expect(parseArguments(['daemon', 'install']).command).toEqual({ kind: 'daemon', action: 'install' })
    expect(parseArguments(['daemon', 'foreground']).command).toEqual({ kind: 'daemon', action: 'foreground' })
  })

  it('parses the human-operated self-update command without options', () => {
    expect(parseArguments(['update']).command).toEqual({ kind: 'update' })
    expect(() => parseArguments(['update', '--force'])).toThrow(/Unexpected argument/)
    expect(() => parseArguments(['--embedded', 'update'])).toThrow(/does not accept --data-dir or --embedded/)
  })

  it('rejects the retired disk observation command', () => {
    expect(() => parseArguments(['disk', 'start', '--project', 'project-a'])).toThrow(/Unknown command: disk/)
  })
})
