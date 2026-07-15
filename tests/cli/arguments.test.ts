import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { defaultDataDirectory, parseArguments } from '../../src/cli/arguments.js'

describe('CLI arguments', () => {
  it('uses EKG_DATA_DIR or a user-local directory rather than cwd', () => {
    expect(defaultDataDirectory({ EKG_DATA_DIR: '/var/ekg' }, '/home/test')).toBe('/var/ekg')
    expect(defaultDataDirectory({}, '/home/test')).toBe(
      process.platform === 'darwin'
        ? '/home/test/Library/Application Support/EKG'
        : process.platform === 'win32'
          ? '/home/test/AppData/Local/EKG'
          : '/home/test/.local/share/ekg',
    )
    expect(defaultDataDirectory()).toBe(
      process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'EKG')
        : process.platform === 'win32'
          ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'EKG')
          : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'ekg'),
    )
  })

  it('parses global data directory and exact run argv without reinterpretation', () => {
    expect(
      parseArguments([
        '--data-dir',
        '/tmp/ekg',
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
      dataDirectory: '/tmp/ekg',
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
})
