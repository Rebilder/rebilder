/**
 * The commerce-only-config compatibility freeze.
 *
 * A `GatewayConfig` whose `sources` are exactly `{product, policies, catalog}`
 * is what every merchant integration is wired as today. This file pins what
 * such a config produces — response body, status, the complete response header
 * set, and the complete emitted event — so that adding sources to
 * `GatewaySources` later cannot change it. A merchant who never touches their
 * config must get byte-identical output before and after.
 *
 * Three things are frozen, and each catches a different regression:
 *
 * 1. **Output.** Bodies are inline string literals, not snapshots (see
 *    `packages/render-md/tests/commerce-frozen.test.ts` for the reasoning:
 *    `vitest -u` regenerates a snapshot, it cannot regenerate a literal). The
 *    renderers themselves are frozen in that file; what is frozen here is that
 *    the gateway hands them the right source object and passes the result
 *    through unmodified.
 * 2. **Resolution order.** product → policies → catalog, first match wins, and
 *    no lower-precedence source is even consulted once a higher one matches. A
 *    new source resolving ahead of `product` would be a silent behaviour
 *    change for every existing merchant; the call-order assertions below fail
 *    if that happens.
 * 3. **The event.** Compared with `toEqual` on the whole object, so a field
 *    added to `RebilderEventV0` and populated on the commerce path fails here
 *    rather than showing up unannounced in a merchant's warehouse.
 *
 * The `commerceOnlySources` / `commerceOnlyConfig` consts below are also a
 * compile-time assertion: if a future source or config field is added as
 * *required* rather than optional, this file stops typechecking. That is the
 * intended failure — new sources must be additive.
 */

import { describe, expect, it } from 'vitest'
import type { RebilderEventV0 } from '@rebilder/events'
import { handleRequest, type GatewayConfig, type GatewaySources } from '../src/index'
import {
  BROWSER_CHROME_HEADERS,
  CATALOG_PATH,
  CLAUDE_CODE_HEADERS,
  PDP_PATH,
  POLICY_PATH,
  STORE_ORIGIN,
  catalog,
  makeRequest,
  policies,
  product,
} from './fixtures'

const byteLength = (s: string): number => new TextEncoder().encode(s).length

const UNMATCHED_PATH = '/about-us'

/**
 * Exactly the three commerce sources — no more. Typed as `GatewaySources`
 * rather than inferred so that a newly *required* source breaks typecheck.
 */
const commerceOnlySources: GatewaySources = {
  product: (url) => (url.pathname === PDP_PATH ? product : null),
  policies: (url) => (url.pathname.startsWith('/policies') ? policies : null),
  catalog: (url) => (url.pathname === CATALOG_PATH ? catalog : null),
}

function commerceOnlyConfig(events?: RebilderEventV0[]): GatewayConfig {
  const config: GatewayConfig = {
    storeId: 'store_test',
    sources: commerceOnlySources,
  }
  if (events === undefined) return config
  return {
    ...config,
    onEvent: (event) => {
      events.push(event)
    },
  }
}

/**
 * The event with its three unavoidably volatile fields replaced, so the rest
 * of the object can be compared exhaustively with `toEqual`. Each volatile
 * field is separately asserted to be well-formed before being replaced —
 * "volatile" must not become "unchecked".
 */
function frozenEvent(event: RebilderEventV0): unknown {
  expect(event.event_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  )
  expect(Number.isNaN(Date.parse(event.ts))).toBe(false)
  expect(Number.isFinite(event.response.render_ms)).toBe(true)
  expect(event.response.render_ms).toBeGreaterThanOrEqual(0)
  return {
    ...event,
    event_id: '<uuid>',
    ts: '<iso>',
    response: { ...event.response, render_ms: '<ms>' },
  }
}

/**
 * The full frozen header NAME set. An added header is a change, not a detail —
 * which is why this is asserted as a complete list rather than a subset.
 *
 * `etag` and `link` joined it deliberately. The ETag makes a markdown response
 * revalidatable, so a CDN can answer a repeat fetch with a 304 instead of a
 * re-render; the canonical Link tells an agent holding markdown which URL it
 * represents, which HTML carries in a `<link>` and markdown has nowhere else to
 * put. Their VALUES are content-derived, so they are shape-checked below while
 * the stable three stay pinned to exact strings.
 */
// Compatibility metadata is additive; source body and validators stay frozen.
const MARKDOWN_HEADER_NAMES = ['content-type', 'etag', 'link', 'vary', 'x-rebilder-path', 'x-rebilder-profile', 'x-rebilder-profile-id', 'x-rebilder-profile-version']

const MARKDOWN_HEADERS: [string, string][] = [
  ['content-type', 'text/markdown; charset=utf-8'],
  ['vary', 'Accept'],
  ['x-rebilder-path', 'markdown'],
  ['x-rebilder-profile', 'baseline@1'],
  ['x-rebilder-profile-id', 'baseline'],
  ['x-rebilder-profile-version', '1'],
]

/** `W/"<hash>-<length>"`, both hex. Weak: the renderer is deterministic, but a
 *  strong validator would promise byte-identity across future formatting work. */
const ETAG_SHAPE = /^W\/"[0-9a-f]+-[0-9a-f]+"$/

function expectMarkdownHeaders(res: Response, canonical: string): void {
  expect([...res.headers.keys()].sort()).toEqual(MARKDOWN_HEADER_NAMES)
  for (const [name, value] of MARKDOWN_HEADERS) expect(res.headers.get(name)).toBe(value)
  expect(res.headers.get('etag')).toMatch(ETAG_SHAPE)
  expect(res.headers.get('link')).toBe(`<${canonical}>; rel="canonical"`)
}

// ---------------------------------------------------------------------------
// Frozen bodies
// ---------------------------------------------------------------------------

const PRODUCT_BODY = [
  '# [Trail Runner 2](https://store.example.com/products/trail-runner-2)',
  '',
  '- **Brand:** Acme Outdoors',
  '- **Price:** ~~$120.00~~ $89.00',
  '- **Availability:** In stock',
  '- **Shipping:** Free standard shipping on orders over $50. Standard shipping is $5.95.',
  '  - Free shipping threshold: $50.00',
  '  - Delivery estimate: 3-5 days',
  '- **Returns:** 30-day returns on unworn shoes.',
  '  - Return window: 30 days',
  '  - Policy: https://store.example.com/policies/returns',
  '',
  '## Variants',
  '',
  '| ID | Title | Options | Price | Availability |',
  '| --- | --- | --- | --- | --- |',
  '| v-8 | Size 8 | size: 8 | $89.00 | In stock |',
  '| v-10 | Size 10 | size: 10 | $94.00 | Out of stock |',
  '',
  '## Description',
  '',
  'The Trail Runner 2 is built for long days on technical terrain. Recycled mesh upper, 6 mm drop, re-profiled lugs for mud without debris on hardpack.',
].join('\n')

const POLICIES_BODY = [
  '# [Shipping policy](https://store.example.com/policies/shipping)',
  '',
  'Orders ship within 2 business days. Free standard shipping on orders over $50.',
  '',
  '# [Returns policy](https://store.example.com/policies/returns)',
  '',
  'Unworn shoes may be returned within 30 days for a full refund.',
].join('\n')

const CATALOG_BODY = [
  '# Catalog',
  '',
  '| Title | Price | Availability |',
  '| --- | --- | --- |',
  '| [Trail Runner 2](https://store.example.com/products/trail-runner-2) | $89.00 | In stock |',
  '| [Ridge Hiker](https://store.example.com/products/ridge-hiker) | $149.00 | Preorder |',
].join('\n')

describe('commerce-only config — frozen markdown responses', () => {
  it.each([
    ['product', PDP_PATH, PRODUCT_BODY, 803],
    ['policies', POLICY_PATH, POLICIES_BODY, 272],
    ['catalog', CATALOG_PATH, CATALOG_BODY, 242],
  ])('%s: status, header set, and body are byte-identical', async (_name, path, body, bytes) => {
    const req = makeRequest(path, CLAUDE_CODE_HEADERS)
    const res = await handleRequest(req, commerceOnlyConfig())
    expect(res).toBeInstanceOf(Response)
    expect(res!.status).toBe(200)
    expectMarkdownHeaders(res!, req.url)
    const text = await res!.text()
    expect(text).toBe(body)
    expect(byteLength(text)).toBe(bytes)
  })

  it('a URL no commerce source matches passes through to HTML (null)', async () => {
    expect(
      await handleRequest(makeRequest(UNMATCHED_PATH, CLAUDE_CODE_HEADERS), commerceOnlyConfig()),
    ).toBeNull()
  })

  it('a human on a matching URL passes through to HTML (null)', async () => {
    expect(
      await handleRequest(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS), commerceOnlyConfig()),
    ).toBeNull()
  })
})

describe('commerce-only config — frozen emitted events', () => {
  // The `source` / `coverage` values below are the deliberate, signed-off
  // events 0.2.0 addition (design §4.5; packages/events/CHANGELOG.md 0.2.0).
  // They are additive and optional on the type, so this file failing was the
  // intended alarm, not a break — and the frozen values here are now the
  // freeze. Everything else about a commerce-only config is unchanged: same
  // bodies, same status, same headers, same resolution order.
  it.each([
    ['product', PDP_PATH, 'markdown', 'sourced', 'product'],
    ['policies', POLICY_PATH, 'markdown', 'sourced', 'policies'],
    ['catalog', CATALOG_PATH, 'markdown', 'sourced', 'catalog'],
    ['unmatched', UNMATCHED_PATH, 'html-variant', 'unsourced', 'none'],
  ])(
    '%s: exactly one event, whole object frozen',
    async (_name, path, responsePath, coverage, source) => {
      const events: RebilderEventV0[] = []
      await handleRequest(makeRequest(path, CLAUDE_CODE_HEADERS), commerceOnlyConfig(events))
      expect(events).toHaveLength(1)
      expect(frozenEvent(events[0]!)).toEqual({
        event_id: '<uuid>',
        ts: '<iso>',
        store_id: 'store_test',
        requester: { kind: 'agent', platform: 'claude-code', verified: false },
        request: {
          url: `${STORE_ORIGIN}${path}`,
          intent_signals: {},
          accept: CLAUDE_CODE_HEADERS['accept'],
        },
        response: { path: responsePath, render_ms: '<ms>', coverage, source, ...(responsePath === 'markdown' ? { profile_id: 'baseline', profile_version: 1, compatibility_runtime: 1 } : {}) },
      })
    },
  )
})

// ---------------------------------------------------------------------------
// Resolution order
// ---------------------------------------------------------------------------

/**
 * Sources that record which of them the gateway consulted, in order. `matches`
 * decides which ones return data; a `false` source returns null (no match).
 */
function recordingSources(
  calls: string[],
  matches: { product?: boolean; policies?: boolean; catalog?: boolean } = {},
): GatewaySources {
  return {
    product: () => {
      calls.push('product')
      return matches.product === true ? product : null
    },
    policies: () => {
      calls.push('policies')
      return matches.policies === true ? policies : null
    },
    catalog: () => {
      calls.push('catalog')
      return matches.catalog === true ? catalog : null
    },
  }
}

describe('commerce resolution order is frozen: product → policies → catalog', () => {
  it('product matching short-circuits: policies and catalog are never consulted', async () => {
    const calls: string[] = []
    const res = await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: recordingSources(calls, { product: true, policies: true, catalog: true }),
    })
    expect(calls).toEqual(['product'])
    expect(await res!.text()).toBe(PRODUCT_BODY)
  })

  it('policies matching short-circuits catalog', async () => {
    const calls: string[] = []
    const res = await handleRequest(makeRequest(POLICY_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: recordingSources(calls, { policies: true, catalog: true }),
    })
    expect(calls).toEqual(['product', 'policies'])
    expect(await res!.text()).toBe(POLICIES_BODY)
  })

  it('catalog is last and is reached only when nothing above it matched', async () => {
    const calls: string[] = []
    const res = await handleRequest(makeRequest(CATALOG_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: recordingSources(calls, { catalog: true }),
    })
    expect(calls).toEqual(['product', 'policies', 'catalog'])
    expect(await res!.text()).toBe(CATALOG_BODY)
  })

  it('no match anywhere consults all three, in order, then passes through', async () => {
    const calls: string[] = []
    const res = await handleRequest(makeRequest(UNMATCHED_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: recordingSources(calls),
    })
    expect(calls).toEqual(['product', 'policies', 'catalog'])
    expect(res).toBeNull()
  })

  it('an empty policies array is a no-match and resolution continues to catalog', async () => {
    const calls: string[] = []
    const res = await handleRequest(makeRequest(POLICY_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: {
        policies: () => {
          calls.push('policies')
          return []
        },
        catalog: () => {
          calls.push('catalog')
          return catalog
        },
      },
    })
    expect(calls).toEqual(['policies', 'catalog'])
    expect(await res!.text()).toBe(CATALOG_BODY)
  })

  it('a throwing source is a no-match: resolution continues to the next source', async () => {
    const calls: string[] = []
    const res = await handleRequest(makeRequest(POLICY_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: {
        product: () => {
          calls.push('product')
          throw new Error('merchant bug')
        },
        policies: () => {
          calls.push('policies')
          return policies
        },
      },
    })
    expect(calls).toEqual(['product', 'policies'])
    expect(await res!.text()).toBe(POLICIES_BODY)
  })

  it('a matched source whose render fails passes through — it never falls back down the order', async () => {
    // Serving the returns policy on a product URL would be worse than serving
    // HTML (render.ts's stated contract). Frozen: the lower-precedence source
    // is not even consulted.
    const calls: string[] = []
    const res = await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: {
        product: () => {
          calls.push('product')
          // render-md throws rather than rounding a non-integer minor unit.
          return { ...product, price: { amount: 89.5, currency: 'USD' } }
        },
        policies: () => {
          calls.push('policies')
          return policies
        },
      },
    })
    expect(res).toBeNull()
    expect(calls).toEqual(['product'])
  })
})

describe('commerce-only config — maxBytes still reaches the renderers', () => {
  it('a 700-byte budget truncates the product body and nothing else changes', async () => {
    const req = makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS)
    const res = await handleRequest(req, { ...commerceOnlyConfig(), maxBytes: 700 })
    expectMarkdownHeaders(res!, req.url)
    const text = await res!.text()
    expect(text).toBe(
      [
        '# [Trail Runner 2](https://store.example.com/products/trail-runner-2)',
        '',
        '- **Brand:** Acme Outdoors',
        '- **Price:** ~~$120.00~~ $89.00',
        '- **Availability:** In stock',
        '- **Shipping:** Free standard shipping on orders over $50. Standard shipping is $5.95.',
        '  - Free shipping threshold: $50.00',
        '  - Delivery estimate: 3-5 days',
        '- **Returns:** 30-day returns on unworn shoes.',
        '  - Return window: 30 days',
        '  - Policy: https://store.example.com/policies/returns',
        '',
        '## Variants',
        '',
        '| ID | Title | Options | Price | Availability |',
        '| --- | --- | --- | --- | --- |',
        '| v-8 | Size 8 | size: 8 | $89.00 | In stock |',
        '| v-10 | Size 10 | size: 10 | $94.00 | Out of stock |',
        '',
        '*Truncated to fit size budget; remaining content omitted.*',
      ].join('\n'),
    )
    expect(byteLength(text)).toBe(697)
  })
})
