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

  it('parses explicit disk observation lifecycle and cleanup queries', () => {
    expect(parseArguments([
      'disk', 'start', '--project', 'project-a', '--operation', 'task-1-start', '--task', 'build feature',
    ]).command).toEqual({
      kind: 'disk-start', projectId: 'project-a', operationId: 'task-1-start', task: 'build feature',
    })
    expect(parseArguments([
      'disk', 'finish', '--project', 'project-a', '--operation', 'task-1-finish', '--observation', 'observation-a',
    ]).command).toEqual({
      kind: 'disk-finish', projectId: 'project-a', operationId: 'task-1-finish', observationId: 'observation-a',
    })
    expect(parseArguments(['disk', 'candidates', '--project', 'project-a', '--limit', '12']).command)
      .toEqual({ kind: 'disk-candidates', projectId: 'project-a', limit: 12 })
  })
})
