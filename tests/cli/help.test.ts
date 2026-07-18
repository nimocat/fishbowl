import { describe, expect, it } from 'vitest'

import { HELP_TOPICS, formatCliError, formatHelp } from '../../src/cli/help.js'

describe('CLI help', () => {
  it('provides a useful top-level orientation without starting the daemon', () => {
    const help = formatHelp([])

    expect(help).toContain('Usage: fishbowl <command> [options]')
    expect(help).toContain('fishbowl project register')
    expect(help).toContain('fishbowl query')
    expect(help).toContain('fishbowl update')
    expect(help).toContain('fishbowl daemon doctor')
    expect(help).toMatch(/Agents.*MCP/i)
    expect(help).toContain('fishbowl help <command>')
  })

  it('documents every public command with usage and discoverable parent help', () => {
    for (const topic of HELP_TOPICS) {
      const help = formatHelp(topic.split(' '))
      expect(help, topic).toContain(`Usage: fishbowl ${topic}`)
      expect(help, topic).toContain('Run `fishbowl help`')
    }

    expect(formatHelp(['project'])).toContain('fishbowl project register')
    expect(formatHelp(['case'])).toContain('fishbowl case root-cause')
    expect(formatHelp(['project', 'register'])).toContain('--root <path>')
    expect(formatHelp(['serve'])).toContain('--port <number>')
    expect(formatHelp(['query'])).toMatch(/legacy.*recovery/i)
  })

  it('adds command-specific recovery and typo suggestions to errors', () => {
    expect(formatCliError(['project', 'register'], '--root is required')).toMatchObject({
      usage: expect.stringContaining('fishbowl project register'),
      hint: expect.stringContaining('--root <path>'),
      help: 'fishbowl help project register',
    })
    expect(formatCliError(['projct'], 'Unknown command: projct')).toMatchObject({
      hint: expect.stringContaining('Did you mean `project`?'),
      help: 'fishbowl help',
    })
    expect(formatCliError(['daemon', 'doctr'], 'Unknown daemon command: doctr').hint)
      .toContain('Did you mean `doctor`?')
  })
})
