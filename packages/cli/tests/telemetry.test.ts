/**
 * telemetry.test.ts — the zero-telemetry contract, asserted against the source.
 *
 * WHY A SOURCE SCAN AND NOT A MOCK. "We never upload anything" cannot be proved
 * by a test that exercises the paths someone thought to exercise; the upload
 * that matters is the one added later, in a path with no test. So this file
 * reads every `.ts` under `src/` and asserts that no socket-opening node builtin
 * is imported, that `fetch(` is never called, and that no URL constant points at
 * our own API. The one seam through which a request can leave the process is
 * `@rebilder/agent-readability/probe`, which addresses the target the operator
 * named and nothing else.
 *
 * THE CONCRETE SCENARIO THIS PROTECTS (design §5.6): a developer runs
 * `rebilder check --allow-private http://staging.internal.corp` inside CI. If the
 * binary reported anything home, internal hostnames and paths would leave a
 * private network and land on a third party's servers — from a command whose
 * whole purpose was to keep the check local. The `--allow-private` capability and
 * the no-telemetry guarantee are only safe as a pair.
 *
 * The ESLint config carries the same rule as `no-restricted-imports`, so a
 * violation fails lint too. Two mechanisms because a lint rule can be disabled
 * inline, and an inline disable in this package is exactly the diff worth
 * failing a test over.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli'
import { BADGE_ORIGIN } from '../src/commands/badge'
import { createFakeRuntime, evidenceOutcome, FIXTURES } from './support'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '..', 'src')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

const FILES = sourceFiles(SRC).map((path) => ({
  path: path.slice(SRC.length + 1),
  text: readFileSync(path, 'utf8'),
}))

describe('no socket in this package', () => {
  it('finds source files at all (a scan over nothing proves nothing)', () => {
    expect(FILES.length).toBeGreaterThan(10)
  })

  it.each(['node:http', 'node:https', 'node:net', 'node:dgram', 'node:tls', 'undici'])(
    'never imports %s',
    (module) => {
      for (const file of FILES) {
        expect(file.text.includes(`from '${module}'`), `${file.path} imports ${module}`).toBe(false)
        expect(file.text.includes(`import('${module}')`), `${file.path} imports ${module}`).toBe(
          false,
        )
      }
    },
  )

  it('never calls fetch, XMLHttpRequest, or navigator.sendBeacon', () => {
    for (const file of FILES) {
      // Comments name `fetch` when explaining why there isn't one; a CALL is
      // what matters, so the pattern requires the parenthesis and excludes the
      // comment lines that discuss it.
      for (const [index, line] of file.text.split('\n').entries()) {
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '')
        expect(/\bfetch\s*\(/.test(code), `${file.path}:${index + 1} calls fetch`).toBe(false)
        expect(/sendBeacon|XMLHttpRequest|WebSocket/.test(code), `${file.path}:${index + 1}`).toBe(
          false,
        )
      }
    }
  })

  it('has no eslint-disable of the socket or fetch restrictions', () => {
    for (const file of FILES) {
      expect(
        /eslint-disable.*no-restricted-(imports|globals)/.test(file.text),
        `${file.path} disables the socket restriction`,
      ).toBe(false)
    }
  })

  it('the only rebilder.com URLs in the package are the badge embed and printed doc links, none fetched', () => {
    for (const file of FILES) {
      for (const match of file.text.matchAll(/https:\/\/[a-z0-9.-]*rebilder\.com[^\s'"`)]*/g)) {
        const url = match[0]
        // `/docs/` links are printed in `init` notes for a person to open.
        // The fetch and socket tests above are what prove none is requested.
        const allowed =
          url === BADGE_ORIGIN ||
          url.startsWith(`${BADGE_ORIGIN}/badge/`) ||
          url.startsWith(`${BADGE_ORIGIN}/readable/`) ||
          url.startsWith(`${BADGE_ORIGIN}/docs/adapters`) ||
          url === `${BADGE_ORIGIN}/spec/ars` ||
          url === `${BADGE_ORIGIN}/bots`
        expect(allowed, `${file.path} names ${url}`).toBe(true)
      }
    }
  })

  it('declares exactly one runtime dependency, and it is the scorer', () => {
    const manifest = JSON.parse(readFileSync(resolve(HERE, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies).toEqual({ '@rebilder/agent-readability': 'workspace:*' })
  })
})

describe('no command reaches the network except through the probe', () => {
  it('badge builds its snippet locally — we never learn which domain was asked about', async () => {
    const fake = createFakeRuntime()
    await runCli(['badge', 'internal-staging.corp'], fake.runtime)
    expect(fake.probeSetups).toEqual([])
    expect(fake.probedUrls).toEqual([])
    expect(fake.stdout()).toContain('internal-staging.corp')
  })

  it('init reads the working directory and probes nothing', async () => {
    const fake = createFakeRuntime({
      files: { 'package.json': JSON.stringify({ dependencies: { express: '4' } }) },
    })
    await runCli(['init'], fake.runtime)
    expect(fake.probeSetups).toEqual([])
    expect(fake.stdout()).toContain('node')
  })

  it('help and version probe nothing', async () => {
    for (const argv of [['--help'], ['help', 'check'], ['--version'], []]) {
      const fake = createFakeRuntime()
      await runCli(argv, fake.runtime)
      expect(fake.probeSetups).toEqual([])
    }
  })

  it('check requests exactly the URLs it was given, and nothing else', async () => {
    const fake = createFakeRuntime({
      outcomes: [evidenceOutcome(FIXTURES.rawHtml), evidenceOutcome(FIXTURES.gatewayMd)],
    })
    await runCli(['check', 'https://a.example/x', 'https://b.example/y'], fake.runtime)
    expect(fake.probedUrls).toEqual(['https://a.example/x', 'https://b.example/y'])
  })

  it('--allow-private is passed through per invocation and defaults off', async () => {
    const off = createFakeRuntime({ outcomes: [evidenceOutcome(FIXTURES.rawHtml)] })
    await runCli(['check', 'https://a.example'], off.runtime)
    expect(off.probeSetups[0]).toEqual({ allowPrivate: false, allowHttp: false, urlCount: 1 })

    const on = createFakeRuntime({ outcomes: [evidenceOutcome(FIXTURES.rawHtml)] })
    await runCli(['check', 'http://staging.internal', '--allow-private'], on.runtime)
    expect(on.probeSetups[0]).toEqual({ allowPrivate: true, allowHttp: true, urlCount: 1 })
  })

  it('the probe budget is sized to the URL count, not left at the single-shot floor', async () => {
    const { budgetFor } = await import('../src/runtime')
    // Seven per URL: five §3.3 requests, the ARS 0.3 linked Markdown copy, and
    // the robots retry.
    expect(budgetFor(1)).toBe(20)
    expect(budgetFor(10)).toBe(74)
    expect(budgetFor(50)).toBe(354)
  })
})
