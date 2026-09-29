/**
 * args.test.ts — the parser, including every way a person gets it wrong.
 *
 * The interesting cases are not "does `--format json` parse". They are the ones
 * where a wrong value would otherwise be accepted and quietly change behaviour:
 * `--format html` (not a format), `--fail-on Z` (not a grade), `--concurrency 0`
 * (not a count), `diff --fail-on A` (a flag that would look like it gated and
 * would not). Every one of those is exit 2 with nothing fetched.
 */

import { describe, expect, it } from 'vitest'
import { normalizeDomain, parseCommandLine } from '../src/args'
import { UsageError } from '../src/exit'

const expectUsageError = (argv: string[]): UsageError => {
  try {
    parseCommandLine(argv)
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError)
    return error as UsageError
  }
  throw new Error(`expected a UsageError for: ${argv.join(' ')}`)
}

describe('check', () => {
  it('defaults: pretty, no threshold, concurrency 1, https only', () => {
    const parsed = parseCommandLine(['check', 'https://example.com/a'])
    expect(parsed.kind).toBe('command')
    if (parsed.kind !== 'command' || parsed.command.name !== 'check') throw new Error('shape')
    expect(parsed.command).toEqual({
      name: 'check',
      urls: ['https://example.com/a'],
      format: 'pretty',
      failOn: null,
      out: null,
      allowPrivate: false,
      allowHttp: false,
      concurrency: 1,
    })
  })

  it('--fail-on defaults to nothing — a tool that fails a build by default gets `|| true`', () => {
    const parsed = parseCommandLine(['check', 'https://example.com'])
    if (parsed.kind !== 'command' || parsed.command.name !== 'check') throw new Error('shape')
    expect(parsed.command.failOn).toBeNull()
  })

  it('takes several URLs', () => {
    const parsed = parseCommandLine(['check', 'https://a.example', 'https://b.example'])
    if (parsed.kind !== 'command' || parsed.command.name !== 'check') throw new Error('shape')
    expect(parsed.command.urls).toEqual(['https://a.example', 'https://b.example'])
  })

  it('accepts every documented format and grade', () => {
    for (const format of ['pretty', 'json', 'markdown', 'junit']) {
      const parsed = parseCommandLine(['check', 'https://x.example', '--format', format])
      if (parsed.kind !== 'command' || parsed.command.name !== 'check') throw new Error('shape')
      expect(parsed.command.format).toBe(format)
    }
    for (const grade of ['A', 'B', 'C', 'D', 'F']) {
      const parsed = parseCommandLine(['check', 'https://x.example', '--fail-on', grade])
      if (parsed.kind !== 'command' || parsed.command.name !== 'check') throw new Error('shape')
      expect(parsed.command.failOn).toBe(grade)
    }
  })

  it('upper-cases a lower-case grade rather than rejecting it', () => {
    const parsed = parseCommandLine(['check', 'https://x.example', '--fail-on', 'b'])
    if (parsed.kind !== 'command' || parsed.command.name !== 'check') throw new Error('shape')
    expect(parsed.command.failOn).toBe('B')
  })

  it('--allow-private implies --allow-http', () => {
    const parsed = parseCommandLine(['check', 'http://staging.internal', '--allow-private'])
    if (parsed.kind !== 'command' || parsed.command.name !== 'check') throw new Error('shape')
    expect(parsed.command.allowPrivate).toBe(true)
    expect(parsed.command.allowHttp).toBe(true)
  })

  it('--allow-http alone does not imply --allow-private', () => {
    const parsed = parseCommandLine(['check', 'http://example.com', '--allow-http'])
    if (parsed.kind !== 'command' || parsed.command.name !== 'check') throw new Error('shape')
    expect(parsed.command.allowPrivate).toBe(false)
    expect(parsed.command.allowHttp).toBe(true)
  })

  it('rejects an unknown format', () => {
    expect(expectUsageError(['check', 'https://x.example', '--format', 'html']).message).toContain(
      '--format must be one of',
    )
  })

  it('rejects a grade that is not a grade', () => {
    expect(expectUsageError(['check', 'https://x.example', '--fail-on', 'Z']).message).toContain(
      '--fail-on must be one of',
    )
  })

  it('rejects a non-numeric, zero, or oversized concurrency', () => {
    expect(
      expectUsageError(['check', 'https://x.example', '--concurrency', 'many']).message,
    ).toContain('positive integer')
    expect(
      expectUsageError(['check', 'https://x.example', '--concurrency', '0']).message,
    ).toContain('at least 1')
    expect(
      expectUsageError(['check', 'https://x.example', '--concurrency', '99']).message,
    ).toContain('capped at 8')
  })

  it('rejects check with no URL', () => {
    expect(expectUsageError(['check']).message).toContain('at least one URL')
  })

  it('rejects an unknown option', () => {
    expect(() => parseCommandLine(['check', 'https://x.example', '--upload'])).toThrow(UsageError)
  })
})

describe('diff', () => {
  it('takes exactly one URL', () => {
    const parsed = parseCommandLine(['diff', 'https://x.example'])
    if (parsed.kind !== 'command' || parsed.command.name !== 'diff') throw new Error('shape')
    expect(parsed.command.url).toBe('https://x.example')
    expect(expectUsageError(['diff']).message).toContain('needs a URL')
    expect(expectUsageError(['diff', 'https://a.example', 'https://b.example']).message).toContain(
      'exactly one URL',
    )
  })

  it('REFUSES --fail-on rather than ignoring it', () => {
    // Silently dropping a flag someone put in a CI file is how a check that
    // appears to gate stops gating without anyone noticing.
    expect(expectUsageError(['diff', 'https://x.example', '--fail-on', 'A']).message).toContain(
      'not supported by `diff`',
    )
  })
})

describe('init', () => {
  it('takes no positionals and accepts --framework', () => {
    const parsed = parseCommandLine(['init', '--framework', 'next'])
    if (parsed.kind !== 'command' || parsed.command.name !== 'init') throw new Error('shape')
    expect(parsed.command.framework).toBe('next')
    expect(expectUsageError(['init', 'next']).message).toContain('no positional arguments')
  })
})

describe('badge', () => {
  it('normalises a domain and rejects anything that is not one', () => {
    const parsed = parseCommandLine(['badge', 'Example.COM'])
    if (parsed.kind !== 'command' || parsed.command.name !== 'badge') throw new Error('shape')
    expect(parsed.command.domain).toBe('example.com')
    expect(normalizeDomain('https://shop.example.com/products/x')).toBe('shop.example.com')
    expect(normalizeDomain('example.com.')).toBe('example.com')
    expect(() => normalizeDomain('localhost')).toThrow(UsageError)
    expect(() => normalizeDomain('not a domain')).toThrow(UsageError)
    expect(() => normalizeDomain('-bad.example.com')).toThrow(UsageError)
    expect(expectUsageError(['badge']).message).toContain('needs a domain')
  })
})

describe('help and version', () => {
  it('bare invocation is help, not an error', () => {
    expect(parseCommandLine([])).toEqual({ kind: 'help', topic: null })
  })

  it('--help, help, and help <command>', () => {
    expect(parseCommandLine(['--help'])).toEqual({ kind: 'help', topic: null })
    expect(parseCommandLine(['help'])).toEqual({ kind: 'help', topic: null })
    expect(parseCommandLine(['help', 'check'])).toEqual({ kind: 'help', topic: 'check' })
    expect(parseCommandLine(['check', '--help'])).toEqual({ kind: 'help', topic: 'check' })
  })

  it('--version', () => {
    expect(parseCommandLine(['--version'])).toEqual({ kind: 'version' })
    expect(parseCommandLine(['-v'])).toEqual({ kind: 'version' })
  })

  it('rejects an unknown command', () => {
    expect(expectUsageError(['scan', 'https://x.example']).message).toContain('unknown command')
    expect(expectUsageError(['help', 'scan']).message).toContain('unknown command')
  })
})
