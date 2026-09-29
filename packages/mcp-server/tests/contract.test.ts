/**
 * contract.test.ts — the promises this package makes in prose, asserted against
 * the source that has to keep them.
 *
 * "Zero telemetry" and "the probe cannot be talked into a private host" are
 * README sentences. A README sentence is not a control. These tests read the
 * shipped source and fail if the sentence stops being true — which is the only
 * version of the guarantee worth stating in public.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { SERVER_NAME, SERVER_VERSION } from '../src/version'
import { DEFAULT_INDEX_BASE_URL, isValidDomain, resolveIndexBaseUrl } from '../src/index-client'
import {
  DEFAULT_PROBE_BUDGET,
  MAX_PROBE_BUDGET,
  MIN_PROBE_BUDGET,
  probeBudgetFromEnv,
} from '../src/scanner'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')
const srcRoot = path.join(packageRoot, 'src')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : []
  })
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

/**
 * Source with comments and template-literal bodies removed. These files explain
 * themselves at length — including quoting the very specifiers they must not
 * import — and `install_snippet` emits code containing import statements. A
 * scanner that cannot tell code from prose would either fail on a comment or be
 * disabled for being noisy, and a disabled check is not a check.
 */
function codeOf(file: string): string {
  return read(file)
    .replace(/\/\*[^]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/`(?:[^`\\]|\\[^])*`/g, '``')
}

/**
 * Code with string literals blanked as well — for the checks that are about
 * IDENTIFIERS. Tool descriptions are prose that says things like "fetch one
 * page", and a rule that cannot tell that from calling `fetch` would be
 * suppressed within a week.
 */
function identifiersOf(file: string): string {
  return codeOf(file)
    .replace(/'(?:[^'\\]|\\[^])*'/g, "''")
    .replace(/"(?:[^"\\]|\\[^])*"/g, '""')
}

const FILES = sourceFiles(srcRoot)

describe('zero telemetry', () => {
  it('has exactly one file that can make a network call, and it is the index client', () => {
    // The bare global, not a property access and not `fetchImpl`/`doFetch`: the
    // ESLint rule in this package bans the identifier everywhere except that one
    // file, and this asserts the same thing against the shipped source.
    const callers = FILES.filter((file) => /(^|[^.\w])fetch\b/.test(identifiersOf(file)))
    expect(callers.map((file) => path.relative(packageRoot, file))).toEqual(['src/index-client.ts'])
  })

  it('points that call at our own origin and nowhere else', () => {
    expect(DEFAULT_INDEX_BASE_URL).toBe('https://rebilder.com')
    const source = read(path.join(srcRoot, 'index-client.ts'))
    const urls = source.match(/https?:\/\/[a-z0-9.-]+/gi) ?? []
    for (const url of urls) expect(url).toMatch(/^https:\/\/rebilder\.com/)
  })

  it('never names an analytics, telemetry or reporting endpoint', () => {
    for (const file of FILES) {
      expect(read(file)).not.toMatch(/sendBeacon|posthog|segment\.io|amplitude|datadog/i)
    }
  })

  it('rejects an index base URL that is not https, or that carries credentials', () => {
    expect(resolveIndexBaseUrl('https://index.example.com')).toBe('https://index.example.com')
    expect(resolveIndexBaseUrl('http://evil.example')).toBe(DEFAULT_INDEX_BASE_URL)
    expect(resolveIndexBaseUrl('https://user:pass@evil.example')).toBe(DEFAULT_INDEX_BASE_URL)
    expect(resolveIndexBaseUrl('https://evil.example/?x=1')).toBe(DEFAULT_INDEX_BASE_URL)
    expect(resolveIndexBaseUrl('not a url')).toBe(DEFAULT_INDEX_BASE_URL)
    expect(resolveIndexBaseUrl(undefined)).toBe(DEFAULT_INDEX_BASE_URL)
  })
})

describe('the local probe is unreachable from here', () => {
  it('imports probeStrict and never ./probe/local', () => {
    for (const file of FILES) {
      expect(codeOf(file)).not.toContain('agent-readability/probe/local')
      expect(identifiersOf(file)).not.toMatch(/\bprobeLocal\b/)
    }
    expect(read(path.join(srcRoot, 'scanner.ts'))).toContain('probeStrict')
  })

  it('has no environment variable that unlocks a private host', () => {
    const deps = read(path.join(srcRoot, 'deps.ts'))
    expect(deps).not.toMatch(/ALLOW_PRIVATE|ALLOW_HTTP/i)
  })
})

describe('the politeness limiter is not bypassable', () => {
  it('clamps the one override that exists', () => {
    expect(probeBudgetFromEnv(undefined)).toBe(DEFAULT_PROBE_BUDGET)
    expect(probeBudgetFromEnv('nonsense')).toBe(DEFAULT_PROBE_BUDGET)
    expect(probeBudgetFromEnv('1')).toBe(MIN_PROBE_BUDGET)
    expect(probeBudgetFromEnv('999999')).toBe(MAX_PROBE_BUDGET)
    expect(probeBudgetFromEnv(' 42 ')).toBe(42)
    expect(probeBudgetFromEnv('-5')).toBe(MIN_PROBE_BUDGET)
  })

  it('builds the limiter itself rather than accepting one from a caller', () => {
    const scanner = read(path.join(srcRoot, 'scanner.ts'))
    expect(scanner).toContain('createLimiter(')
    // No option named `limiter` on the public factory: a consumer cannot pass a
    // no-op one, and no tool argument reaches it either.
    expect(scanner).not.toMatch(/limiter\??:\s*Limiter/)
  })
})

describe('zero runtime dependencies outside the workspace', () => {
  it('declares only @rebilder/agent-readability', () => {
    const manifest: unknown = JSON.parse(read(path.join(packageRoot, 'package.json')))
    const dependencies = (manifest as { dependencies?: Record<string, string> }).dependencies ?? {}
    expect(Object.keys(dependencies)).toEqual(['@rebilder/agent-readability'])
    expect(dependencies['@rebilder/agent-readability']).toBe('workspace:*')
  })

  it('imports nothing outside node: builtins and the workspace', () => {
    const specifier = /from\s+'([^']+)'/g
    for (const file of FILES) {
      for (const match of codeOf(file).matchAll(specifier)) {
        const spec = match[1] ?? ''
        if (spec.startsWith('.') || spec.startsWith('node:')) continue
        expect(spec).toMatch(/^@rebilder\/agent-readability(\/probe)?$/)
      }
    }
  })

  it('reports its own version honestly', () => {
    const manifest: unknown = JSON.parse(read(path.join(packageRoot, 'package.json')))
    expect((manifest as { version: string }).version).toBe(SERVER_VERSION)
    expect((manifest as { name: string }).name).toBe(SERVER_NAME)
  })
})

describe('domain validation', () => {
  it('accepts registrable domains and rejects everything else', () => {
    for (const domain of ['example.com', 'a.co.uk', 'xn--80ak6aa92e.com', 'sub.example.com']) {
      expect(isValidDomain(domain)).toBe(true)
    }
    for (const domain of [
      '',
      'example',
      'exa mple.com',
      '-example.com',
      'example-.com',
      '10.0.0.1',
      'https://example.com',
      'example.com/path',
      `${'a'.repeat(64)}.com`,
      `${'a.'.repeat(200)}com`,
    ]) {
      expect(isValidDomain(domain)).toBe(false)
    }
  })

  it('is case- and trailing-dot-insensitive, because resolvers are', () => {
    expect(isValidDomain('EXAMPLE.com.')).toBe(true)
  })
})

describe('README', () => {
  const readme = read(path.join(packageRoot, 'README.md'))

  it('distinguishes website inspection from merchant negotiation capabilities', () => {
    expect(readme).toContain('inspects websites and generates installation snippets')
    expect(readme).toContain(
      'does not expose a merchant catalog, negotiate offers or publish changes',
    )
  })

  it('states the zero-telemetry contract and the current transport scope', () => {
    expect(readme).toMatch(/never upload/i)
    expect(readme).toMatch(/HTTP transport is not included in this package/i)
  })
})
