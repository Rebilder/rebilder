/**
 * commands.test.ts — `diff`, `init`, `badge`, and the concurrency pool.
 *
 * `diff` gets the most attention because it is the command with the strongest
 * temptation to be wrong: showing "here is your HTML, here is your markdown" is
 * a great demo and a copyright problem, and the assertion that no body text
 * reaches the output is what keeps it honest.
 */

import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli'
import { mapWithConcurrency } from '../src/commands/check'
import { runBadge } from '../src/commands/badge'
import { detectFramework, runInit } from '../src/commands/init'
import { LINKED_PARITY_NOTE } from '../src/markdown-copy'
import { createFakeRuntime, evidenceOutcome, FIXTURES, loadEvidence } from './support'

const URL = 'https://basecamp-supply.example/products/alpine-trail-pack-28l'
const UTF8 = { NO_COLOR: '1', LANG: 'en_US.UTF-8' }

describe('diff', () => {
  it('shows both sides of the one bundle a check would have produced', async () => {
    const fake = createFakeRuntime({ outcomes: [evidenceOutcome(FIXTURES.gatewayMd)], env: UTF8 })
    await runCli(['diff', URL], fake.runtime)
    const text = fake.stdout()
    expect(fake.probedUrls).toEqual([URL]) // one probe, two views
    expect(text).toContain('text/markdown')
    expect(text).toContain('text/html')
    expect(text).toContain('Substance parity')
  })

  it('says when the parity check compared a linked Markdown copy, not the two columns', async () => {
    for (const format of ['pretty', 'markdown']) {
      const linked = createFakeRuntime({
        outcomes: [evidenceOutcome(FIXTURES.linkedCopy)],
        env: UTF8,
      })
      await runCli(['diff', URL, '--format', format], linked.runtime)
      expect(linked.stdout(), format).toContain(LINKED_PARITY_NOTE)

      for (const fixture of [FIXTURES.gatewayMd, FIXTURES.linkedCopyBroken]) {
        const other = createFakeRuntime({ outcomes: [evidenceOutcome(fixture)], env: UTF8 })
        await runCli(['diff', URL, '--format', format], other.runtime)
        expect(other.stdout(), `${format} ${fixture}`).not.toContain(LINKED_PARITY_NOTE)
      }
    }
  })

  it('names the Markdown copy the parity check used in JSON output', async () => {
    const cases: [string, string][] = [
      [FIXTURES.gatewayMd, 'page-address'],
      [FIXTURES.linkedCopy, 'linked'],
      [FIXTURES.linkedCopyBroken, 'none'],
    ]
    for (const [fixture, expected] of cases) {
      const fake = createFakeRuntime({ outcomes: [evidenceOutcome(fixture)], env: UTF8 })
      await runCli(['diff', URL, '--format', 'json'], fake.runtime)
      expect((JSON.parse(fake.stdout()) as { markdownCopy: string }).markdownCopy, fixture).toBe(
        expected,
      )
    }
  })

  it('reports the two Accept headers and asserts they are the only difference', async () => {
    const fake = createFakeRuntime({ outcomes: [evidenceOutcome(FIXTURES.gatewayMd)], env: UTF8 })
    await runCli(['diff', URL], fake.runtime)
    const evidence = loadEvidence(FIXTURES.gatewayMd)
    const agentUa = evidence.probes.agent.requestHeaders['user-agent']
    const browserUa = evidence.probes.browser.requestHeaders['user-agent']
    expect(agentUa).toBe(browserUa)
    expect(fake.stdout()).toContain('differ in the Accept header and in nothing else')
  })

  it('shows the byte and token difference the gateway makes', async () => {
    const fake = createFakeRuntime({ outcomes: [evidenceOutcome(FIXTURES.gatewayMd)], env: UTF8 })
    await runCli(['diff', URL, '--format', 'json'], fake.runtime)
    const parsed = JSON.parse(fake.stdout()) as {
      agent: { bytes: number; approxTokens: number; contentType: string }
      browser: { bytes: number; approxTokens: number; contentType: string }
    }
    expect(parsed.agent.contentType).toContain('text/markdown')
    expect(parsed.browser.contentType).toContain('text/html')
    expect(parsed.agent.bytes).toBeLessThan(parsed.browser.bytes)
    expect(parsed.agent.approxTokens).toBeLessThan(parsed.browser.approxTokens)
  })

  it('never prints an excerpt of either representation', async () => {
    const evidence = loadEvidence(FIXTURES.gatewayMd)
    const bodies = [evidence.probes.agent, evidence.probes.browser]
      .flatMap((record) => (record.result.ok ? [record.result.capture.body ?? ''] : []))
      .filter((body) => body.length > 200)
    expect(bodies.length).toBe(2)

    for (const format of ['pretty', 'json', 'markdown']) {
      const fake = createFakeRuntime({ outcomes: [evidenceOutcome(FIXTURES.gatewayMd)], env: UTF8 })
      await runCli(['diff', URL, '--format', format], fake.runtime)
      for (const body of bodies) {
        expect(fake.stdout().includes(body.slice(100, 180)), format).toBe(false)
      }
    }
  })

  it('a rejected target renders without a crash and carries the notice', async () => {
    const fake = createFakeRuntime({
      probe: () => Promise.resolve({ ok: false, rejection: 'policy-rejected', detail: 'reserved' }),
      env: UTF8,
    })
    await runCli(['diff', URL], fake.runtime)
    expect(fake.stdout()).toContain('REJECTED')
    expect(fake.stdout()).toContain('ARS measures format and retrievability')
  })
})

describe('init', () => {
  it.each([
    ['next.config.ts', 'next'],
    ['shopify.app.toml', 'shopify'],
    ['svelte.config.js', 'sveltekit'],
    ['nuxt.config.ts', 'nuxt'],
    ['astro.config.mjs', 'astro'],
    ['react-router.config.ts', 'react-router'],
    ['remix.config.js', 'remix'],
    ['wrangler.toml', 'edge'],
    ['wrangler.jsonc', 'edge'],
    ['netlify.toml', 'netlify'],
    ['vercel.json', 'vercel'],
    ['deno.json', 'deno'],
    ['bun.lock', 'bun'],
  ])('detects from the marker file %s as %s', async (file, expected) => {
    const fake = createFakeRuntime({ files: { [file]: '' } })
    const detected = await detectFramework(fake.runtime)
    expect(detected.framework).toBe(expected)
    expect(detected.reason).toContain(file)
  })

  it.each([
    ['next', 'next'],
    ['express', 'node'],
    ['fastify', 'node'],
    ['hono', 'hono'],
    ['@sveltejs/kit', 'sveltekit'],
    ['nuxt', 'nuxt'],
    ['astro', 'astro'],
    ['@react-router/dev', 'react-router'],
    ['@remix-run/node', 'remix'],
    ['@shopify/shopify-api', 'shopify'],
    ['@shopify/shopify-app-remix', 'shopify'],
    ['wrangler', 'edge'],
    ['@netlify/edge-functions', 'netlify'],
    ['@vercel/functions', 'vercel'],
  ])('detects "%s" in package.json as %s', async (dependency, expected) => {
    const fake = createFakeRuntime({
      files: { 'package.json': JSON.stringify({ dependencies: { [dependency]: '1' } }) },
    })
    const detected = await detectFramework(fake.runtime)
    expect(detected.framework).toBe(expected)
    expect(detected.reason).toContain(dependency)
  })

  it('prefers the framework over the runtime it deploys to', async () => {
    // A Hono app on Workers wants Hono middleware, not a Worker that replaces
    // the app; a SvelteKit site on Netlify wants the SvelteKit hook.
    const hono = createFakeRuntime({
      files: {
        'wrangler.toml': '',
        'package.json': JSON.stringify({
          dependencies: { hono: '4' },
          devDependencies: { wrangler: '4' },
        }),
      },
    })
    expect((await detectFramework(hono.runtime)).framework).toBe('hono')

    const svelte = createFakeRuntime({
      files: {
        'netlify.toml': '',
        'package.json': JSON.stringify({ devDependencies: { '@sveltejs/kit': '2' } }),
      },
    })
    expect((await detectFramework(svelte.runtime)).framework).toBe('sveltekit')
  })

  it('falls back to the fetch middleware and SAYS SO — a guess with a visible reason is a 30-second fix', async () => {
    const fake = createFakeRuntime({ files: {} })
    const detected = await detectFramework(fake.runtime)
    expect(detected.framework).toBe('fetch')
    expect(detected.reason).toContain('no framework marker found')
    expect(detected.reason).toContain('--framework')
  })

  it('survives an unparseable package.json', async () => {
    const fake = createFakeRuntime({ files: { 'package.json': '{ not json' } })
    const detected = await detectFramework(fake.runtime)
    expect(detected.framework).toBe('fetch')
  })

  it.each([
    ['fetch', 'createFetchMiddleware', '@rebilder/gateway/fetch'],
    ['sveltekit', 'export const handle: Handle', 'src/hooks.server.ts'],
    ['nuxt', 'negotiationHeaders', 'server/middleware/rebilder.ts'],
    ['astro', 'defineMiddleware', 'src/middleware.ts'],
    ['react-router', 'Route.MiddlewareFunction[]', 'app/root.tsx'],
    ['remix', 'createGatewayMiddleware', '@remix-run/express'],
    ['hono', 'c.req.raw', 'new Hono()'],
    ['bun', 'Bun.serve', 'createFetchMiddleware'],
    ['deno', 'Deno.serve', 'createFetchMiddleware'],
    ['netlify', 'context.next()', 'netlify/edge-functions/rebilder.ts'],
    ['vercel', "from '@vercel/functions'", 'negotiationHeaders'],
  ])('--framework %s scaffolds its own mounting snippet', async (framework, marker, where) => {
    const fake = createFakeRuntime({ files: {} })
    const scaffold = await runInit(
      { name: 'init', framework, format: 'pretty', out: null },
      fake.runtime,
    )
    expect(scaffold.framework).toBe(framework)
    expect(scaffold.contents).toContain('TODO')
    expect(scaffold.contents).toContain(marker)
    expect(scaffold.contents).toContain(where)
    // The mounting snippet is commented out: it belongs in another file, and
    // compiling it here would import the framework into the config module.
    const lines = scaffold.contents.trimEnd().split('\n')
    const header = lines.findIndex((line) => line.startsWith('/* ──'))
    expect(header).toBeGreaterThan(-1)
    for (const line of lines.slice(header + 1)) expect(line.startsWith('//'), line).toBe(true)
    // Every scaffold points at the full guide for its framework.
    expect(
      scaffold.notes.some((note) => note.includes('https://rebilder.com/docs/adapters/')),
    ).toBe(true)
  })

  it('states D2.1 at the weight the ruleset gives it', async () => {
    const fake = createFakeRuntime({ files: {} })
    const scaffold = await runInit(
      { name: 'init', framework: 'next', format: 'pretty', out: null },
      fake.runtime,
    )
    const note = scaffold.notes.find((entry) => entry.includes('D2.1'))
    expect(note).toContain('D2.1 (9 points)')
  })

  it('refuses an unknown framework and lists the supported ones', async () => {
    const fake = createFakeRuntime({ files: {} })
    const code = await runCli(['init', '--framework', 'rails'], fake.runtime)
    expect(code).toBe(2)
    expect(fake.stderr()).toContain('sveltekit')
  })

  it('--framework overrides detection', async () => {
    const fake = createFakeRuntime({ files: { 'next.config.ts': '' } })
    await runCli(['init', '--framework', 'edge'], fake.runtime)
    expect(fake.stdout()).toContain('chosen with --framework')
    expect(fake.stdout()).toContain('createGatewayFetchHandler')
  })

  it('the scaffold is a skeleton with TODOs, not a working config', async () => {
    const fake = createFakeRuntime({ files: { 'next.config.ts': '' } })
    await runCli(['init', '--out', 'lib/gateway-config.ts'], fake.runtime)
    const written = fake.written.get('lib/gateway-config.ts') ?? ''
    expect(written).toContain('TODO')
    expect(written).toContain('createGatewayProxy')
    expect(written).toContain('GatewayConfig')
    // self-hosted serving, restated in the file the merchant is about to read.
    expect(fake.stdout()).toContain('SDK serves without a Rebilder account or subscription')
  })
})

describe('badge', () => {
  it('always names its subject — a domain-less badge is misappropriable', () => {
    const snippet = runBadge({ name: 'badge', domain: 'example.com', format: 'pretty', out: null })
    expect(snippet.markdown).toContain('example.com')
    expect(snippet.html).toContain('example.com')
    expect(snippet.svgUrl).toBe('https://rebilder.com/badge/example.com.svg')
    expect(snippet.html).toContain('alt="Agent Readability Score for example.com"')
  })

  it('never puts a score in the query string', () => {
    const snippet = runBadge({ name: 'badge', domain: 'example.com', format: 'pretty', out: null })
    expect(snippet.svgUrl).not.toContain('?')
    expect(snippet.markdown).not.toMatch(/score=|grade=/)
  })

  it('states the opt-in, the neutral fallback, and the 30-day decay', () => {
    const snippet = runBadge({ name: 'badge', domain: 'example.com', format: 'pretty', out: null })
    const notes = snippet.notes.join(' ')
    expect(notes).toContain('verified opted-in')
    expect(notes).toContain('not rated')
    expect(notes).toContain('30 days')
    expect(notes).toContain('never purchasable')
  })
})

describe('the concurrency pool', () => {
  it('preserves input order regardless of completion order', async () => {
    const delays = [30, 1, 15, 2]
    const result = await mapWithConcurrency(delays, 4, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay))
      return index
    })
    expect(result).toEqual([0, 1, 2, 3])
  })

  it('never runs more lanes than requested', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return null
    })
    expect(peak).toBe(2)
  })

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([])
  })
})
