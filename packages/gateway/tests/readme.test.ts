/**
 * The README is the page npm shows, and its code is the code people paste.
 *
 * Every TypeScript block in README.md is a file in examples/, byte for byte.
 * Those files are compiled by this package's `tsc` run (tsconfig.json includes
 * examples/ and maps `@rebilder/gateway` to the source), so a renamed export or
 * a changed signature fails the typecheck rather than a merchant's build. The
 * examples that do not need a framework installed also run here, so the config
 * the README calls complete really does serve markdown.
 *
 * The rest pins what a README on npm must not do: link relative paths (the
 * source repository is private, so they 404), or carry contributor steps and
 * internal paths. Contributor notes live in CONTRIBUTING.md.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { handleRequest } from '../src/index'
import { gatewayConfig } from '../examples/gateway-config'
import { handle } from '../examples/sveltekit'
import worker from '../examples/worker'

const ROOT = path.resolve(__dirname, '..')
const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
const EXAMPLES = readdirSync(path.join(ROOT, 'examples')).filter(
  (file) => file.endsWith('.ts') && !file.endsWith('.d.ts'),
)

/** Every ```ts fence body in the README. */
const README_BLOCKS = [...README.matchAll(/```ts\n([\s\S]*?)\n```/g)].map((match) => match[1])

const agent = (pathname: string) =>
  new Request(`https://example.com${pathname}`, { headers: { accept: 'text/markdown' } })

const browser = (pathname: string) =>
  new Request(`https://example.com${pathname}`, {
    headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605.1.15' },
  })

describe('README code blocks are the typechecked examples', () => {
  it.each(EXAMPLES)('examples/%s appears in the README verbatim', (file) => {
    const source = readFileSync(path.join(ROOT, 'examples', file), 'utf8').trimEnd()
    expect(README_BLOCKS, `README has no block equal to examples/${file}`).toContain(source)
  })

  it('every TypeScript block in the README is an example file', () => {
    const sources = EXAMPLES.map((file) =>
      readFileSync(path.join(ROOT, 'examples', file), 'utf8').trimEnd(),
    )
    for (const block of README_BLOCKS) {
      expect(sources, `README block is not in examples/:\n${block}`).toContain(block)
    }
  })
})

describe('the README config is complete, and works', () => {
  it('serves the example page to an agent as markdown with its facts', async () => {
    const res = await handleRequest(agent('/services/bike-fitting'), gatewayConfig)
    expect(res?.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    const body = (await res?.text()) ?? ''
    expect(body).toContain('Bike fitting')
    expect(body).toContain('£180.00')
    expect(body).toContain('**Booking required:** Yes')
  })

  it('passes a browser through to your HTML', async () => {
    expect(await handleRequest(browser('/services/bike-fitting'), gatewayConfig)).toBeNull()
  })

  it('passes an agent through on a page the config does not describe', async () => {
    expect(await handleRequest(agent('/blog/some-post'), gatewayConfig)).toBeNull()
  })

  it('the SvelteKit hook serves markdown and falls through to resolve', async () => {
    const resolve = () => new Response('<!doctype html><title>page</title>')
    const markdown = await handle({ event: { request: agent('/services/bike-fitting') }, resolve })
    expect(markdown.headers.get('content-type')).toContain('text/markdown')
    const html = await handle({ event: { request: browser('/services/bike-fitting') }, resolve })
    expect(await html.text()).toBe('<!doctype html><title>page</title>')
    expect(html.headers.get('vary')).toBe('Accept')
  })

  it('the Worker serves markdown without touching the origin', async () => {
    const res = await worker.fetch(agent('/services/bike-fitting'))
    expect(res.headers.get('content-type')).toContain('text/markdown')
  })
})

describe('the README reads correctly on npm', () => {
  it('uses absolute links only; npm renders the README outside the repository', () => {
    for (const [, target] of README.matchAll(/\]\(([^)]+)\)/g)) {
      expect(target, `relative link ${target}`).toMatch(/^https:\/\//)
    }
  })

  it('links the full docs it replaced', () => {
    for (const page of ['quickstart', 'adapters/nextjs', 'adapters/node', 'adapters/cloudflare']) {
      expect(README).toContain(`https://rebilder.com/docs/${page}`)
    }
    expect(README).toContain('https://rebilder.com/docs/adapters/frameworks')
  })

  it('carries no contributor steps or internal paths', () => {
    // Other-product names are rejected for every mirrored file, READMEs
    // included, by the scan that runs before each public source sync.
    for (const forbidden of [
      'pnpm --filter',
      'apps/',
      'infra/',
      'docs/design',
      'ARCHITECTURE.md',
    ]) {
      expect(README, forbidden).not.toContain(forbidden)
    }
  })

  it('shows a curl check that asks for markdown', () => {
    expect(README).toContain('curl -H "Accept: text/markdown"')
  })

  it('says once, plainly, that @rebilder/protocols is not yet on npm', () => {
    expect(README.match(/@rebilder\/protocols/g)).toHaveLength(1)
    expect(README).toContain('`@rebilder/protocols`, is not yet published to npm')
  })

  it('stays short enough to read on the package page', () => {
    const lines = README.trimEnd().split('\n').length
    expect(lines).toBeGreaterThanOrEqual(60)
    expect(lines).toBeLessThanOrEqual(125)
  })
})
