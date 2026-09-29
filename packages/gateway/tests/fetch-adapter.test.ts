/**
 * The framework-neutral `(request, next) => Response` middleware.
 *
 * Every framework recipe on the docs site (SvelteKit, Astro, React Router,
 * Hono, Netlify Edge) mounts exactly this function, so these tests pin the
 * three promises those recipes make: markdown short-circuits without calling
 * `next`, everything else calls `next` exactly once and comes back with the
 * negotiation headers, and nothing the gateway does can take the page down.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RebilderEventV0 } from '@rebilder/events'
import type { GatewayConfig } from '../src/index'
import { createFetchMiddleware, negotiationHeaders } from '../src/adapters/fetch/index'
import {
  BROWSER_CHROME_HEADERS,
  CLAUDE_CODE_HEADERS,
  GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS,
  PDP_PATH,
  STORE_ORIGIN,
  makeRequest,
  pathMatchedSources,
} from './fixtures'

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { storeId: 'store_test', sources: pathMatchedSources(), ...overrides }
}

const html = () =>
  new Response('<!doctype html><title>page</title>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', vary: 'Accept-Encoding' },
  })

describe('createFetchMiddleware — markdown path', () => {
  it('answers an agent with markdown and never calls next', async () => {
    const next = vi.fn(html)
    const gateway = createFetchMiddleware(config())
    const res = await gateway(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), next)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('vary')).toBe('Accept')
    expect(res.headers.get('x-rebilder-path')).toBe('markdown')
    const body = await res.text()
    expect(body).toContain('Trail Runner 2')
    expect(body).toContain('$89.00')
  })

  it('emits one markdown event per served request', async () => {
    const events: RebilderEventV0[] = []
    const gateway = createFetchMiddleware(config({ onEvent: (event) => void events.push(event) }))
    await gateway(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), html)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.response.path).toBe('markdown')
  })
})

describe('createFetchMiddleware — everything else', () => {
  it('calls next exactly once for a browser and returns its body', async () => {
    const next = vi.fn(html)
    const gateway = createFetchMiddleware(config())
    const res = await gateway(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(await res.text()).toBe('<!doctype html><title>page</title>')
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })

  it('adds Vary: Accept and keeps the framework’s own Vary tokens', async () => {
    const gateway = createFetchMiddleware(config())
    const res = await gateway(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS), html)
    const vary = (res.headers.get('vary') ?? '').toLowerCase()
    expect(vary).toContain('accept-encoding')
    expect(vary.split(',').map((token) => token.trim())).toContain('accept')
  })

  it('serves Googlebot the page, even when it asks for markdown', async () => {
    const next = vi.fn(html)
    const gateway = createFetchMiddleware(config())
    const res = await gateway(makeRequest(PDP_PATH, GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })

  it('passes an agent through when no source answers the URL', async () => {
    const next = vi.fn(html)
    const gateway = createFetchMiddleware(config())
    const res = await gateway(makeRequest('/no-such-page', CLAUDE_CODE_HEADERS), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })

  it('advertises the markdown alternate only when the match router confirms one', async () => {
    const withRouter = createFetchMiddleware(
      config({ sources: { ...pathMatchedSources(), match: () => 'product' } }),
    )
    const advertised = await withRouter(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS), html)
    expect(advertised.headers.get('link')).toBe(
      `<${STORE_ORIGIN}${PDP_PATH}>; rel="alternate"; type="text/markdown"`,
    )

    const withoutRouter = createFetchMiddleware(config())
    const silent = await withoutRouter(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS), html)
    expect(silent.headers.get('link')).toBeNull()
  })

  it('decorates a response whose headers are immutable, as fetch() returns', async () => {
    // Workers, Deno and Netlify hand back `fetch()` responses with frozen
    // headers. Mutating them in place throws; the adapter must copy.
    const frozen = await fetch('data:text/html,<p>origin</p>')
    expect(() => frozen.headers.set('x-probe', '1')).toThrow()
    const gateway = createFetchMiddleware(config())
    const res = await gateway(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS), () => frozen)
    expect(res.headers.get('vary')).toBe('Accept')
    expect(await res.text()).toBe('<p>origin</p>')
  })

  it('leaves a 304 alone rather than inventing a body for it', async () => {
    const gateway = createFetchMiddleware(config())
    const res = await gateway(
      makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS),
      () => new Response(null, { status: 304 }),
    )
    expect(res.status).toBe(304)
  })
})

describe('createFetchMiddleware — failure containment', () => {
  it('falls through to next when a source throws', async () => {
    const next = vi.fn(html)
    const gateway = createFetchMiddleware(
      config({
        sources: {
          product: () => {
            throw new Error('resolver blew up')
          },
        },
      }),
    )
    const res = await gateway(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(200)
  })

  it('falls through to next when the config itself is broken', async () => {
    // A resolver map that throws on property access fails inside the core,
    // before any resolver runs. The page must still render.
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('broken config')
        },
      },
    )
    const next = vi.fn(html)
    const gateway = createFetchMiddleware({ storeId: 'store_test', sources: hostile })
    const res = await gateway(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(200)
  })

  it('lets an error from next propagate: it is the application’s, not ours', async () => {
    const gateway = createFetchMiddleware(config())
    await expect(
      gateway(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS), () => {
        throw new Error('app route failed')
      }),
    ).rejects.toThrow('app route failed')
  })
})

describe('negotiationHeaders', () => {
  it('returns Vary: Accept for any URL the middleware is mounted on', () => {
    expect(negotiationHeaders(config(), new URL(`${STORE_ORIGIN}${PDP_PATH}`))).toEqual([
      ['Vary', 'Accept'],
    ])
  })

  it('adds the Link advertisement when the match router confirms a source', () => {
    const url = new URL(`${STORE_ORIGIN}${PDP_PATH}`)
    const pairs = negotiationHeaders(
      config({ sources: { ...pathMatchedSources(), match: () => 'product' } }),
      url,
    )
    expect(pairs).toEqual([
      ['Link', `<${url.href}>; rel="alternate"; type="text/markdown"`],
      ['Vary', 'Accept'],
    ])
  })

  it('treats a throwing router as no match rather than failing the response', () => {
    const pairs = negotiationHeaders(
      config({
        sources: {
          ...pathMatchedSources(),
          match: () => {
            throw new Error('bad predicate')
          },
        },
      }),
      new URL(`${STORE_ORIGIN}${PDP_PATH}`),
    )
    expect(pairs).toEqual([['Vary', 'Accept']])
  })
})
