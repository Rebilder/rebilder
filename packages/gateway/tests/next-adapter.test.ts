import { describe, expect, it, vi } from 'vitest'
import type { RebilderEventV0 } from '@rebilder/events'
import type { GatewayConfig } from '../src/index'
import { createGatewayProxy, createGatewayRouteHandler } from '../src/adapters/next/index'
import {
  BROWSER_CHROME_HEADERS,
  CLAUDE_CODE_HEADERS,
  GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS,
  PDP_PATH,
  makeRequest,
  pathMatchedSources,
} from './fixtures'

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { storeId: 'store_test', sources: pathMatchedSources(), ...overrides }
}

/**
 * THE HTML HALF OF A NEGOTIATED URL.
 *
 * The gateway always set `Vary: Accept` on the markdown it serves, and the
 * README always told merchants that caches must key on Accept. The HTML
 * response comes from the merchant's app, so nothing enforced it — and the
 * team that wrote the package missed it on its own site. These pin the fix at
 * the adapter, where a merchant gets it without knowing the rule exists.
 */
describe('createGatewayProxy — negotiation headers on the pass-through', () => {
  const html = () =>
    new Response('<!doctype html><title>x</title>', {
      headers: { 'content-type': 'text/html; charset=utf-8', Vary: 'rsc, next-router-state-tree' },
    })

  it('adds Vary: Accept to the fallthrough response', async () => {
    const proxy = createGatewayProxy(config(), html)
    const res = await proxy(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS))
    expect(res.headers.get('vary')?.toLowerCase()).toContain('accept')
  })

  it('keeps the framework’s own Vary tokens', async () => {
    // Appending rather than replacing is load-bearing: Next's RSC tokens make
    // client navigation correct, and trading one cache bug for another is not
    // a fix.
    const proxy = createGatewayProxy(config(), html)
    const res = await proxy(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS))
    expect(res.headers.get('vary')?.toLowerCase()).toContain('next-router-state-tree')
  })

  it('does not duplicate a Vary the app already declared', async () => {
    const proxy = createGatewayProxy(
      config(),
      () => new Response('x', { headers: { Vary: 'Accept-Encoding, Accept' } }),
    )
    const res = await proxy(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS))
    const accepts = (res.headers.get('vary') ?? '')
      .split(',')
      .filter((token) => token.trim().toLowerCase() === 'accept')
    expect(accepts).toHaveLength(1)
  })

  it('advertises the markdown alternate when a match router confirms one', async () => {
    const proxy = createGatewayProxy(
      config({ sources: { ...config().sources, match: () => 'product' } }),
      html,
    )
    const res = await proxy(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS))
    expect(res.headers.get('link')).toContain('rel="alternate"')
    expect(res.headers.get('link')).toContain('type="text/markdown"')
  })

  it('advertises nothing when the router says this URL has no source', async () => {
    // Pointing an agent at a representation that does not exist turns "I did
    // not know" into "you lied", which is strictly worse than silence.
    const proxy = createGatewayProxy(
      config({ sources: { ...config().sources, match: () => null } }),
      html,
    )
    const res = await proxy(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS))
    expect(res.headers.get('link')).toBeNull()
  })

  it('advertises nothing when there is no router to ask', async () => {
    const proxy = createGatewayProxy(config(), html)
    expect(
      (await proxy(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS))).headers.get('link'),
    ).toBeNull()
  })

  it('survives a throwing match router — the HTML response still goes out', async () => {
    const proxy = createGatewayProxy(
      config({
        sources: {
          ...config().sources,
          match: () => {
            throw new Error('merchant bug')
          },
        },
      }),
      html,
    )
    const res = await proxy(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS))
    expect(res.status).toBe(200)
    expect(res.headers.get('link')).toBeNull()
  })

  it('leaves the one-argument form returning null, so published installs keep working', async () => {
    const proxy = createGatewayProxy(config())
    expect(await proxy(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS))).toBeNull()
  })
})

describe('createGatewayProxy', () => {
  it('short-circuits agent traffic with a markdown Response', async () => {
    const proxy = createGatewayProxy(config())
    const res = await proxy(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS))
    expect(res).toBeInstanceOf(Response)
    expect(res?.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res?.headers.get('vary')).toBe('Accept')
    expect(await res!.text()).toContain('$89.00')
  })

  it('returns null for humans (caller continues with NextResponse.next())', async () => {
    const proxy = createGatewayProxy(config())
    expect(await proxy(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS))).toBeNull()
  })

  it('returns null for crawlers asking for markdown (consistent source content)', async () => {
    const proxy = createGatewayProxy(config())
    expect(await proxy(makeRequest(PDP_PATH, GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS))).toBeNull()
  })
})

describe('createGatewayRouteHandler', () => {
  it('records one miss against the canonical path even when a source throws', async () => {
    const events: RebilderEventV0[] = []
    const handler = createGatewayRouteHandler(
      config({
        sources: {
          product: () => {
            throw new Error('source failed')
          },
        },
        onEvent: (event) => {
          events.push(event)
        },
      }),
      { stripPrefix: '/md' },
    )
    expect(
      (await handler(makeRequest('/md/products/missing?token=private', CLAUDE_CODE_HEADERS)))
        .status,
    ).toBe(404)
    expect(events).toHaveLength(1)
    expect(events[0]!.request.url).toBe('https://store.example.com/products/missing')
    expect(events[0]!.response).toMatchObject({
      path: 'markdown',
      source: 'none',
      coverage: 'unsourced',
    })
  })

  it('honors the same access policy before invoking a dedicated route source', async () => {
    const product = vi.fn(() => null)
    const events: RebilderEventV0[] = []
    const handler = createGatewayRouteHandler(
      config({
        access: { default: 'deny' },
        sources: { product },
        onEvent: (event) => {
          events.push(event)
        },
      }),
    )
    expect((await handler(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS))).status).toBe(403)
    expect(product).not.toHaveBeenCalled()
    expect(events).toHaveLength(1)
    expect(events[0]!.response).toMatchObject({ path: 'denied', coverage: 'not-applicable' })
  })

  it('marks install diagnostics and contains event-sink failures', async () => {
    const events: RebilderEventV0[] = []
    const handler = createGatewayRouteHandler(
      config({
        onEvent: (event) => {
          events.push(event)
          return Promise.reject(new Error('ingest down'))
        },
      }),
    )
    const response = await handler(
      makeRequest(PDP_PATH, {
        accept: 'text/markdown',
        'user-agent': 'rebilder-install-check/0.1',
      }),
    )
    expect(response.status).toBe(200)
    expect(events[0]!.request.intent_signals).toMatchObject({ diagnostic: 'install-check' })
  })
  it('always renders markdown, even for a plain browser request', async () => {
    const handler = createGatewayRouteHandler(config())
    const res = await handler(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('x-rebilder-path')).toBe('markdown')
    expect(await res.text()).toContain('$89.00')
  })

  it('strips the route prefix before consulting sources', async () => {
    const handler = createGatewayRouteHandler(config(), { stripPrefix: '/md' })
    const res = await handler(makeRequest(`/md${PDP_PATH}`, BROWSER_CHROME_HEADERS))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Trail Runner 2')
  })

  it('strips the prefix on whole segments only', async () => {
    const handler = createGatewayRouteHandler(config(), { stripPrefix: '/md' })
    // '/mdx...' must NOT be treated as '/md' + 'x...'
    const res = await handler(makeRequest(`/mdx${PDP_PATH}`, BROWSER_CHROME_HEADERS))
    expect(res.status).toBe(404)
  })

  it('returns 404 JSON when no source matches', async () => {
    const handler = createGatewayRouteHandler(config())
    const res = await handler(makeRequest('/no-such-page', BROWSER_CHROME_HEADERS))
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toMatchObject({ error: 'not_found' })
  })

  it('returns 404 (never a 500) when the source throws', async () => {
    const handler = createGatewayRouteHandler(
      config({
        sources: {
          product: () => {
            throw new Error('merchant bug')
          },
        },
      }),
    )
    const res = await handler(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS))
    expect(res.status).toBe(404)
  })

  it('emits a markdown event for served requests', async () => {
    const events: RebilderEventV0[] = []
    const handler = createGatewayRouteHandler(
      config({
        onEvent: (event) => {
          events.push(event)
        },
      }),
    )
    await handler(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS))
    expect(events).toHaveLength(1)
    expect(events[0]!.response.path).toBe('markdown')
    expect(events[0]!.requester.kind).toBe('agent')
  })
})
