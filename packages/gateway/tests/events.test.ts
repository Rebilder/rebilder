import { describe, expect, it } from 'vitest'
import type { RebilderEventV0 } from '@rebilder/events'
import {
  handleRequest,
  type CollectionSource,
  type DocumentSource,
  type GatewayConfig,
} from '../src/index'
import {
  BROWSER_CHROME_HEADERS,
  CATALOG_PATH,
  CLAUDE_CODE_HEADERS,
  GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS,
  PDP_PATH,
  POLICY_PATH,
  PROTOCOL_CLIENT_HEADERS,
  STORE_ORIGIN,
  makeRequest,
  pathMatchedSources,
} from './fixtures'

function collectingConfig(overrides: Partial<GatewayConfig> = {}): {
  config: GatewayConfig
  events: RebilderEventV0[]
} {
  const events: RebilderEventV0[] = []
  const config: GatewayConfig = {
    storeId: 'store_test',
    sources: pathMatchedSources(),
    onEvent: (event) => {
      events.push(event)
    },
    ...overrides,
  }
  return { config, events }
}

/** Structural assertions for the RebilderEventV0 contract. */
function expectEventShape(event: RebilderEventV0): void {
  expect(typeof event.event_id).toBe('string')
  expect(event.event_id.length).toBeGreaterThan(0)
  expect(typeof event.ts).toBe('string')
  expect(Number.isNaN(Date.parse(event.ts))).toBe(false)
  expect(typeof event.store_id).toBe('string')
  expect(['agent', 'human', 'protocol', 'crawler']).toContain(event.requester.kind)
  expect(typeof event.requester.verified).toBe('boolean')
  expect(typeof event.request.url).toBe('string')
  // Always an object (never null/undefined); populated keys are covered by
  // the dedicated intent-signals suite below.
  expect(typeof event.request.intent_signals).toBe('object')
  expect(event.request.intent_signals).not.toBeNull()
  expect(Array.isArray(event.request.intent_signals)).toBe(false)
  expect(['markdown', 'html-variant', 'protocol']).toContain(event.response.path)
  expect(typeof event.response.render_ms).toBe('number')
  expect(Number.isFinite(event.response.render_ms)).toBe(true)
  expect(event.response.render_ms).toBeGreaterThanOrEqual(0)
  expect(event.outcome).toBeUndefined() // joined async, never at emission time
  // events 0.2.0 — every event handleRequest emits declares its coverage.
  expect(['sourced', 'unsourced', 'not-applicable']).toContain(event.response.coverage)
}

// ---------------------------------------------------------------------------
// Universal-path fixtures (a dentist — no product API, ever), used only to
// prove response.source names the resolver that actually answered.
// ---------------------------------------------------------------------------

const DOCUMENT_PATH = '/services/teeth-whitening'
const COLLECTION_PATH = '/services'

const documentSource: DocumentSource = {
  url: `${STORE_ORIGIN}${DOCUMENT_PATH}`,
  title: 'Teeth whitening',
  kind: 'service',
  facts: [{ label: 'Appointment length', value: { type: 'number', value: 90, unit: 'minutes' } }],
}

const collectionSource: CollectionSource = {
  url: `${STORE_ORIGIN}${COLLECTION_PATH}`,
  title: 'Services',
  items: [{ url: `${STORE_ORIGIN}${DOCUMENT_PATH}`, title: 'Teeth whitening' }],
}

/** All five source kinds wired, each on its own path. */
function allFiveSources(): GatewayConfig['sources'] {
  return {
    ...pathMatchedSources(),
    document: (url: URL) => (url.pathname === DOCUMENT_PATH ? documentSource : null),
    collection: (url: URL) => (url.pathname === COLLECTION_PATH ? collectionSource : null),
  }
}

describe('event emission — every handled request emits exactly one event', () => {
  it('markdown response → one event with response.path=markdown', async () => {
    const { config, events } = collectingConfig()
    await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), config)
    expect(events).toHaveLength(1)
    const event = events[0]!
    expectEventShape(event)
    expect(event.store_id).toBe('store_test')
    expect(event.requester).toEqual({ kind: 'agent', platform: 'claude-code', verified: false })
    expect(event.request.url).toBe(`${STORE_ORIGIN}${PDP_PATH}`)
    expect(event.request.accept).toBe(CLAUDE_CODE_HEADERS['accept'])
    expect(event.response.path).toBe('markdown')
  })

  it('human pass-through → one event with response.path=html-variant', async () => {
    const { config, events } = collectingConfig()
    const referer = `${STORE_ORIGIN}/collections/trail`
    await handleRequest(makeRequest(PDP_PATH, { ...BROWSER_CHROME_HEADERS, referer }), config)
    expect(events).toHaveLength(1)
    const event = events[0]!
    expectEventShape(event)
    expect(event.requester.kind).toBe('human')
    expect(event.requester.platform).toBeUndefined()
    expect(event.request.referrer).toBe(referer)
    expect(event.response.path).toBe('html-variant')
  })

  it('crawler pass-through → html-variant event, first-class crawler kind, platform preserved', async () => {
    // crawlers ride the human/HTML serving path but are recorded with the
    // first-class 'crawler' kind (events v0 + 0002_events.sql check constraint).
    const { config, events } = collectingConfig()
    await handleRequest(makeRequest(PDP_PATH, GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS), config)
    expect(events).toHaveLength(1)
    const event = events[0]!
    expectEventShape(event)
    expect(event.requester.kind).toBe('crawler')
    expect(event.requester.platform).toBe('googlebot')
    expect(event.response.path).toBe('html-variant')
  })

  it('protocol route pass-through → event records response.path=protocol', async () => {
    const { config, events } = collectingConfig()
    await handleRequest(makeRequest('/mcp', PROTOCOL_CLIENT_HEADERS), config)
    expect(events).toHaveLength(1)
    const event = events[0]!
    expectEventShape(event)
    expect(event.requester.kind).toBe('protocol')
    expect(event.response.path).toBe('protocol')
  })

  it('agent pass-through (no source matched) → html-variant event', async () => {
    const { config, events } = collectingConfig()
    await handleRequest(makeRequest('/about-us', CLAUDE_CODE_HEADERS), config)
    expect(events).toHaveLength(1)
    expect(events[0]!.response.path).toBe('html-variant')
  })

  it('a throwing source still emits an event (recorded as the html pass-through)', async () => {
    const { config, events } = collectingConfig({
      sources: {
        product: () => {
          throw new Error('merchant bug')
        },
      },
    })
    const res = await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), config)
    expect(res).toBeNull()
    expect(events).toHaveLength(1)
    expect(events[0]!.response.path).toBe('html-variant')
  })

  it('event_ids are unique across events', async () => {
    const { config, events } = collectingConfig()
    await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), config)
    await handleRequest(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS), config)
    await handleRequest(makeRequest('/mcp', PROTOCOL_CLIENT_HEADERS), config)
    expect(new Set(events.map((e) => e.event_id)).size).toBe(3)
  })
})

describe('event emission — onEvent can never block or break a response', () => {
  it('works with no onEvent configured', async () => {
    const config: GatewayConfig = { storeId: 'store_test', sources: pathMatchedSources() }
    const res = await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), config)
    expect(res?.status).toBe(200)
  })

  it('swallows a synchronously throwing onEvent', async () => {
    const { config } = collectingConfig({
      onEvent: () => {
        throw new Error('sink down')
      },
    })
    const res = await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), config)
    expect(res?.status).toBe(200)
    expect(await res!.text()).toContain('$89.00')
  })

  it('swallows an async-rejecting onEvent with no unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', listener)
    try {
      const { config } = collectingConfig({
        onEvent: () => Promise.reject(new Error('async sink down')),
      })
      const res = await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), config)
      expect(res?.status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', listener)
    }
  })

  it('does not await a slow onEvent (fire-and-forget)', async () => {
    let settled = false
    const { config } = collectingConfig({
      onEvent: () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            settled = true
            resolve()
          }, 250),
        ),
    })
    const start = performance.now()
    const res = await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), config)
    const elapsed = performance.now() - start
    expect(res?.status).toBe(200)
    expect(settled).toBe(false) // response returned before the sink settled
    expect(elapsed).toBeLessThan(200)
  })
})

// ---------------------------------------------------------------------------
// events 0.2.0 — response.source and response.coverage (design §4.5)
// ---------------------------------------------------------------------------

describe('response.coverage — the Agent Miss Report in one field', () => {
  it.each([
    ['product', PDP_PATH, 'product'],
    ['policies', POLICY_PATH, 'policies'],
    ['catalog', CATALOG_PATH, 'catalog'],
    ['document', DOCUMENT_PATH, 'document'],
    ['collection', COLLECTION_PATH, 'collection'],
  ])('%s match → coverage=sourced, source names the resolver', async (_name, path, source) => {
    const { config, events } = collectingConfig({ sources: allFiveSources() })
    const res = await handleRequest(makeRequest(path, CLAUDE_CODE_HEADERS), config)
    expect(res?.status).toBe(200)
    expect(events).toHaveLength(1)
    expect(events[0]!.response.path).toBe('markdown')
    expect(events[0]!.response.coverage).toBe('sourced')
    expect(events[0]!.response.source).toBe(source)
  })

  it('agent asked for markdown, nothing matched → THE miss', async () => {
    const { config, events } = collectingConfig({ sources: allFiveSources() })
    const res = await handleRequest(makeRequest('/about-us', CLAUDE_CODE_HEADERS), config)
    expect(res).toBeNull()
    expect(events).toHaveLength(1)
    const event = events[0]!
    // The serving path is the pass-through — which is exactly why coverage is
    // a separate field. `path` alone cannot tell this from a human page view.
    expect(event.response.path).toBe('html-variant')
    expect(event.response.coverage).toBe('unsourced')
    expect(event.response.source).toBe('none')
  })

  it('a human on the same unmatched URL is NOT a miss', async () => {
    const { config, events } = collectingConfig({ sources: allFiveSources() })
    await handleRequest(makeRequest('/about-us', BROWSER_CHROME_HEADERS), config)
    expect(events[0]!.response.path).toBe('html-variant')
    expect(events[0]!.response.coverage).toBe('not-applicable')
    expect(events[0]!.response.source).toBeUndefined()
  })

  it('a crawler is never a miss (Googlebot always gets canonical HTML)', async () => {
    const { config, events } = collectingConfig({ sources: allFiveSources() })
    await handleRequest(makeRequest('/about-us', GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS), config)
    expect(events[0]!.requester.kind).toBe('crawler')
    expect(events[0]!.response.coverage).toBe('not-applicable')
  })

  it('a protocol probe is not a miss', async () => {
    const { config, events } = collectingConfig({ sources: allFiveSources() })
    await handleRequest(makeRequest('/mcp', PROTOCOL_CLIENT_HEADERS), config)
    expect(events[0]!.response.path).toBe('protocol')
    expect(events[0]!.response.coverage).toBe('not-applicable')
    expect(events[0]!.response.source).toBeUndefined()
  })

  it('a throwing source is a miss, not a crash and not a silent sourced', async () => {
    const { config, events } = collectingConfig({
      sources: {
        product: () => {
          throw new Error('merchant bug')
        },
      },
    })
    const res = await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), config)
    expect(res).toBeNull()
    expect(events[0]!.response.coverage).toBe('unsourced')
    expect(events[0]!.response.source).toBe('none')
  })

  it('a source that resolves but fails to render is a miss (the agent got HTML)', async () => {
    const { config, events } = collectingConfig({
      sources: {
        // A malformed money amount: render-md rejects it, resolveMarkdown
        // returns null, the merchant serves HTML. Reporting that as
        // `sourced` would hide a real defect from the Miss Report.
        product: () => ({
          url: `${STORE_ORIGIN}${PDP_PATH}`,
          title: 'Broken',
          price: { amount: Number.NaN, currency: 'USD' },
          availability: 'in_stock' as const,
        }),
      },
    })
    const res = await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), config)
    expect(res).toBeNull()
    expect(events[0]!.response.coverage).toBe('unsourced')
    expect(events[0]!.response.source).toBe('none')
  })

  it('a resolver that hangs past sourceTimeoutMs is a miss, not a hang', async () => {
    const { config, events } = collectingConfig({
      sourceTimeoutMs: 5,
      sources: { product: () => new Promise(() => {}) },
    })
    const res = await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), config)
    expect(res).toBeNull()
    expect(events[0]!.response.coverage).toBe('unsourced')
  })
})

// ---------------------------------------------------------------------------
// Intent signals (events v0.4) — captured from the RAW url + referrer, while
// request.url stays allowlist-filtered. The two are deliberately decoupled.
// ---------------------------------------------------------------------------

describe('request.intent_signals — populated at emission', () => {
  async function signalsFor(
    path: string,
    headers: Record<string, string> = CLAUDE_CODE_HEADERS,
  ): Promise<Record<string, unknown>> {
    const { config, events } = collectingConfig({ sources: allFiveSources() })
    await handleRequest(makeRequest(path, headers), config)
    expect(events).toHaveLength(1)
    return events[0]!.request.intent_signals
  }

  it('records a search query in intent_signals while the URL stays clean', async () => {
    const { config, events } = collectingConfig({ sources: allFiveSources() })
    await handleRequest(makeRequest('/search?q=trail+boots', CLAUDE_CODE_HEADERS), config)
    const event = events[0]!
    expect(event.request.intent_signals).toEqual({ query: 'trail boots', query_param: 'q' })
    expect(event.request.url).not.toContain('?') // free text never rides the URL
  })

  it('drops a query the scrubber rejects — nothing recorded anywhere', async () => {
    const { config, events } = collectingConfig({ sources: allFiveSources() })
    await handleRequest(
      makeRequest('/search?q=jane.doe%40example.com', CLAUDE_CODE_HEADERS),
      config,
    )
    const event = events[0]!
    expect(event.request.intent_signals['query']).toBeUndefined()
    expect(JSON.stringify(event)).not.toContain('jane.doe')
  })

  it('classifies an AI-platform referrer on a HUMAN request (AI-referred visitor)', async () => {
    const signals = await signalsFor(PDP_PATH, {
      ...BROWSER_CHROME_HEADERS,
      referer: 'https://chatgpt.com/c/abc123',
    })
    expect(signals).toEqual({ referrer_platform: 'chatgpt' })
  })

  it('records sanitized utm params (utm_source=chatgpt.com convention)', async () => {
    const signals = await signalsFor(`${PDP_PATH}?utm_source=chatgpt.com&utm_medium=referral`, {
      ...BROWSER_CHROME_HEADERS,
    })
    expect(signals['utm_source']).toBe('chatgpt.com')
    expect(signals['utm_medium']).toBe('referral')
  })

  it('an ordinary same-site referrer produces no signal', async () => {
    const signals = await signalsFor(PDP_PATH, {
      ...BROWSER_CHROME_HEADERS,
      referer: `${STORE_ORIGIN}/collections/trail`,
    })
    expect(signals).toEqual({})
  })

  it('protocol path: reads the intent channel headers into the event and strips them', async () => {
    const { stampIntentSignalHeaders, buildProtocolIntentSignals } =
      await import('@rebilder/events')
    const { config, events } = collectingConfig({
      protocols: async () => {
        const res = new Response('{}', { headers: { 'content-type': 'application/json' } })
        stampIntentSignalHeaders(
          res.headers,
          buildProtocolIntentSignals({
            tool: 'mcp.search_catalog',
            query: 'trail boots',
            resultCount: 0,
          }),
        )
        return res
      },
    })
    const res = await handleRequest(makeRequest('/mcp', PROTOCOL_CLIENT_HEADERS), config)
    expect(res?.status).toBe(200)
    // Stripped: through the gateway the headers are an internal channel.
    expect(res?.headers.get('x-rebilder-intent-tool')).toBeNull()
    expect(res?.headers.get('x-rebilder-intent-query')).toBeNull()
    expect(res?.headers.get('x-rebilder-intent-results')).toBeNull()
    expect(events).toHaveLength(1)
    expect(events[0]!.request.intent_signals).toEqual({
      capability_version: 1,
      requested_capability: 'catalog.search',
      tool: 'mcp.search_catalog',
      query: 'trail boots',
      query_param: 'mcp.search_catalog',
      result_count: 0,
    })
  })
})

// ---------------------------------------------------------------------------
// Query-string filtering at emission (design §4.5, final paragraph)
// ---------------------------------------------------------------------------

describe('request.url — query string filtered at emission', () => {
  async function urlFor(path: string, headers = CLAUDE_CODE_HEADERS): Promise<string> {
    const { config, events } = collectingConfig({ sources: allFiveSources() })
    await handleRequest(makeRequest(path, headers), config)
    expect(events).toHaveLength(1)
    return events[0]!.request.url
  }

  it('leaves a URL with no query string byte-identical', async () => {
    expect(await urlFor(PDP_PATH)).toBe(`${STORE_ORIGIN}${PDP_PATH}`)
  })

  it('drops tracking params that would fragment the Miss Report', async () => {
    expect(await urlFor(`${PDP_PATH}?utm_source=chatgpt&utm_campaign=spring&gclid=abc`)).toBe(
      `${STORE_ORIGIN}${PDP_PATH}`,
    )
  })

  it('drops agent-supplied free text (it would surface verbatim in Console)', async () => {
    expect(await urlFor(`${PDP_PATH}?q=cheapest%20trail%20shoe%20under%20%2480`)).toBe(
      `${STORE_ORIGIN}${PDP_PATH}`,
    )
  })

  it.each([
    ['a password reset token', '/account/reset?token=eyJhbGciOi.secret.value'],
    ['a magic link code', '/auth/callback?code=pkce_9f3a&email=someone%40mailbox.test'],
    ['a session id', '/cart?sid=6f0b1c2d3e4f'],
  ])('drops %s — it must never reach a Pro report', async (_name, path) => {
    const url = await urlFor(path)
    expect(url).not.toContain('?')
    expect(url).not.toMatch(/secret|pkce_9f3a|mailbox\.test|6f0b1c2d3e4f/)
  })

  it('drops a fragment (magic links put access tokens there)', async () => {
    expect(await urlFor(`${PDP_PATH}#access_token=abc123`)).toBe(`${STORE_ORIGIN}${PDP_PATH}`)
  })

  it('keeps the allowlisted params that identify WHICH page this is', async () => {
    expect(await urlFor(`${CATALOG_PATH}?page=3&utm_source=x`)).toBe(
      `${STORE_ORIGIN}${CATALOG_PATH}?page=3`,
    )
    expect(await urlFor(`${PDP_PATH}?variant=v-10&sku=TR2-10`)).toBe(
      `${STORE_ORIGIN}${PDP_PATH}?sku=TR2-10&variant=v-10`,
    )
    expect(await urlFor(`${PDP_PATH}?locale=fr-CA&currency=CAD&lang=fr`)).toBe(
      `${STORE_ORIGIN}${PDP_PATH}?currency=CAD&lang=fr&locale=fr-CA`,
    )
  })

  it('normalizes case and order so one page groups to one row', async () => {
    const a = await urlFor(`${PDP_PATH}?variant=v-10&sku=TR2-10`)
    const b = await urlFor(`${PDP_PATH}?SKU=TR2-10&Variant=v-10`)
    expect(b).toBe(a)
  })

  it('filters the URL on every path, not just markdown', async () => {
    expect(await urlFor(`${PDP_PATH}?utm_source=x`, BROWSER_CHROME_HEADERS)).toBe(
      `${STORE_ORIGIN}${PDP_PATH}`,
    )
    expect(await urlFor(`/mcp?token=abc`, PROTOCOL_CLIENT_HEADERS)).toBe(`${STORE_ORIGIN}/mcp`)
  })
})
