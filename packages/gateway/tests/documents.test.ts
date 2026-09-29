/**
 * The universal path: `document` and `collection` sources, the `match` router,
 * the resolver timeout, and the per-source byte budget.
 *
 * `sources-compat.test.ts` is the other half of this file's job — it freezes
 * what a commerce-only config does, and it must keep passing unchanged. What
 * is tested here is everything that only exists once five sources do:
 *
 * - the two new sources render, and the gateway passes the renderer's output
 *   through unmodified (inline literals, for the reason stated in
 *   sources-compat.test.ts: `vitest -u` cannot regenerate a string literal);
 * - the appended resolution order — product → policies → catalog → document →
 *   collection — with the call log asserted, not just the body;
 * - `match` calls **at most one** resolver, which is the entire reason five
 *   optional sources are affordable on the edge hot path;
 * - the shapes that used to be a 500 on the merchant's live site. A `policies`
 *   value that is not an array, or a `collection` with no `items`, reached
 *   `.length` inside `resolveMarkdown`, which `handleRequest` does not wrap in
 *   a try/catch. Those are no-matches now, and the tests below are the proof;
 * - a resolver that never settles is cut off and treated as a no-match, so
 *   "a failing source cannot break your page" covers hangs and not only
 *   throws.
 */

import { describe, expect, it } from 'vitest'
import {
  generateLlmsTxt,
  handleRequest,
  type CollectionSource,
  type DocumentSource,
  type GatewayConfig,
  type GatewaySources,
  type SourceKind,
} from '../src/index'
import {
  CLAUDE_CODE_HEADERS,
  GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS,
  PDP_PATH,
  STORE_ORIGIN,
  catalog,
  makeRequest,
  policies,
  product,
} from './fixtures'

const byteLength = (s: string): number => new TextEncoder().encode(s).length

/**
 * The full frozen header set — identical to the commerce path's, which is the
 * point: a universal document and a PDP come out of the same response builder,
 * so a header added for one is added for both. `etag` and `link` are
 * content-derived, so their names are pinned here and their values shape-checked
 * at the call site.
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

function expectMarkdownHeaders(res: Response, canonical: string): void {
  expect([...res.headers.keys()].sort()).toEqual(MARKDOWN_HEADER_NAMES)
  for (const [name, value] of MARKDOWN_HEADERS) expect(res.headers.get(name)).toBe(value)
  expect(res.headers.get('etag')).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/)
  expect(res.headers.get('link')).toBe(`<${canonical}>; rel="canonical"`)
}

// ---------------------------------------------------------------------------
// Universal fixtures: a dental clinic using document and collection sources.
// ---------------------------------------------------------------------------

const DOCUMENT_PATH = '/services/teeth-whitening'
const COLLECTION_PATH = '/services'
const UNMATCHED_PATH = '/about-us'

const document: DocumentSource = {
  url: `${STORE_ORIGIN}${DOCUMENT_PATH}`,
  title: 'Teeth whitening',
  kind: 'service',
  summary: 'In-clinic whitening, one 90-minute appointment.',
  updated: '2026-07-14',
  facts: [
    { label: 'Price', value: { type: 'money', value: { amount: 32000, currency: 'USD' } } },
    { label: 'Appointment length', value: { type: 'number', value: 90, unit: 'minutes' } },
    { label: 'Referral required', value: { type: 'boolean', value: false } },
  ],
  actions: [{ label: 'Book online', url: `${STORE_ORIGIN}/book`, kind: 'book' }],
  contact: { phone: '+1-555-0142' },
  sections: [
    {
      heading: 'What to expect',
      body: 'A hygienist fits a tray and applies the gel in three passes.',
    },
  ],
  related: [{ title: 'Dental implants', url: `${STORE_ORIGIN}/services/implants` }],
}

const collection: CollectionSource = {
  url: `${STORE_ORIGIN}${COLLECTION_PATH}`,
  title: 'Services',
  items: [
    {
      url: `${STORE_ORIGIN}${DOCUMENT_PATH}`,
      title: 'Teeth whitening',
      summary: 'One 90-minute appointment.',
    },
    { url: `${STORE_ORIGIN}/services/implants`, title: 'Dental implants' },
  ],
}

const DOCUMENT_BODY = [
  '# [Teeth whitening](https://store.example.com/services/teeth-whitening)',
  '',
  '> In-clinic whitening, one 90-minute appointment.',
  '',
  '- **Updated:** 2026-07-14',
  '- **Price:** $320.00',
  '- **Appointment length:** 90 minutes',
  '- **Referral required:** No',
  '',
  '## Contact',
  '',
  '- **Phone:** +1-555-0142',
  '',
  '## Actions',
  '',
  '- [Book online](https://store.example.com/book)',
  '',
  '## What to expect',
  '',
  'A hygienist fits a tray and applies the gel in three passes.',
  '',
  '## Related',
  '',
  '- [Dental implants](https://store.example.com/services/implants)',
].join('\n')

const COLLECTION_BODY = [
  '# [Services](https://store.example.com/services)',
  '',
  '- [Teeth whitening](https://store.example.com/services/teeth-whitening)',
  '  - One 90-minute appointment.',
  '- [Dental implants](https://store.example.com/services/implants)',
].join('\n')

/** A clinic's whole wiring: two sources, no commerce anywhere. */
const universalSources: GatewaySources = {
  document: (url) => (url.pathname === DOCUMENT_PATH ? document : null),
  collection: (url) => (url.pathname === COLLECTION_PATH ? collection : null),
}

function universalConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { storeId: 'store_clinic', sources: universalSources, ...overrides }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * ETag and canonical Link. Both were missing until an ARS scan of our own
 * homepage scored `contract-discovery.cache-validators` at 0/3 — a markdown
 * response nothing could revalidate, from the company selling the markdown.
 */
describe('the markdown response is revalidatable and self-locating', () => {
  it('carries a weak ETag derived from the body', async () => {
    const res = await handleRequest(
      makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS),
      universalConfig(),
    )
    expect(res!.headers.get('etag')).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/)
  })

  it('gives the same body the same ETag, every time', async () => {
    // Determinism is the whole contract of a validator. A renderer that
    // produced a fresh ETag per request would make every cache miss.
    const once = await handleRequest(
      makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS),
      universalConfig(),
    )
    const twice = await handleRequest(
      makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS),
      universalConfig(),
    )
    expect(once!.headers.get('etag')).toBe(twice!.headers.get('etag'))
  })

  it('gives a different body a different ETag', async () => {
    // The other half: a validator that never changes is worse than none, since
    // a cache would serve stale facts forever.
    const doc = await handleRequest(
      makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS),
      universalConfig(),
    )
    const list = await handleRequest(
      makeRequest(COLLECTION_PATH, CLAUDE_CODE_HEADERS),
      universalConfig(),
    )
    expect(doc!.headers.get('etag')).not.toBe(list!.headers.get('etag'))
  })

  it('changes the ETag when a truncation budget changes the body', async () => {
    const full = await handleRequest(
      makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS),
      universalConfig(),
    )
    const cut = await handleRequest(makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS), {
      ...universalConfig(),
      maxBytes: 200,
    })
    expect(await cut!.text()).not.toBe(await full!.text())
    expect(cut!.headers.get('etag')).not.toBe(full!.headers.get('etag'))
  })

  it('states its canonical URL, which markdown has no <link> to carry', async () => {
    const req = makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS)
    const res = await handleRequest(req, universalConfig())
    expect(res!.headers.get('link')).toBe(`<${req.url}>; rel="canonical"`)
  })
})

describe('universal sources render through the standard markdown response', () => {
  it.each([
    ['document', DOCUMENT_PATH, DOCUMENT_BODY, 493],
    ['collection', COLLECTION_PATH, COLLECTION_BODY, 217],
  ])('%s: status, header set, and body', async (_name, path, body, bytes) => {
    const req = makeRequest(path, CLAUDE_CODE_HEADERS)
    const res = await handleRequest(req, universalConfig())
    expect(res).toBeInstanceOf(Response)
    expect(res!.status).toBe(200)
    expectMarkdownHeaders(res!, req.url)
    const text = await res!.text()
    expect(text).toBe(body)
    expect(byteLength(text)).toBe(bytes)
  })

  it('a URL no source matches passes through to HTML', async () => {
    expect(
      await handleRequest(makeRequest(UNMATCHED_PATH, CLAUDE_CODE_HEADERS), universalConfig()),
    ).toBeNull()
  })

  it('a crawler asking for markdown never reaches the document path (consistent source content)', async () => {
    // Googlebot always receives canonical HTML, so no resolver is even called.
    const calls: string[] = []
    const res = await handleRequest(makeRequest(DOCUMENT_PATH, GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS), {
      storeId: 'store_clinic',
      sources: recordingSources(calls, { document: true }),
    })
    expect(res).toBeNull()
    expect(calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Resolution order
// ---------------------------------------------------------------------------

interface Matches {
  product?: boolean
  policies?: boolean
  catalog?: boolean
  document?: boolean
  collection?: boolean
}

/** All five sources, recording which the gateway consulted, in order. */
function recordingSources(calls: string[], matches: Matches = {}): GatewaySources {
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
    document: () => {
      calls.push('document')
      return matches.document === true ? document : null
    },
    collection: () => {
      calls.push('collection')
      return matches.collection === true ? collection : null
    },
  }
}

const ALL_FIVE = ['product', 'policies', 'catalog', 'document', 'collection']

describe('resolution order: product → policies → catalog → document → collection', () => {
  it('document is consulted fourth and short-circuits collection', async () => {
    const calls: string[] = []
    const res = await handleRequest(makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: recordingSources(calls, { document: true, collection: true }),
    })
    expect(calls).toEqual(['product', 'policies', 'catalog', 'document'])
    expect(await res!.text()).toBe(DOCUMENT_BODY)
  })

  it('collection is last and is reached only when nothing above it matched', async () => {
    const calls: string[] = []
    const res = await handleRequest(makeRequest(COLLECTION_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: recordingSources(calls, { collection: true }),
    })
    expect(calls).toEqual(ALL_FIVE)
    expect(await res!.text()).toBe(COLLECTION_BODY)
  })

  it('commerce still outranks the universal sources: a matching product wins alone', async () => {
    // The compatibility promise in prose: a commerce merchant who adds
    // site-wide documents keeps their PDPs rendering as PDPs.
    const calls: string[] = []
    const res = await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: recordingSources(calls, { product: true, document: true, collection: true }),
    })
    expect(calls).toEqual(['product'])
    expect(await res!.text()).toContain('# [Trail Runner 2]')
  })

  it('no match anywhere consults all five, in order, then passes through', async () => {
    const calls: string[] = []
    const res = await handleRequest(makeRequest(UNMATCHED_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: recordingSources(calls),
    })
    expect(calls).toEqual(ALL_FIVE)
    expect(res).toBeNull()
  })

  it('a collection with an empty items array is a no-match', async () => {
    const res = await handleRequest(makeRequest(COLLECTION_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: { collection: () => ({ url: `${STORE_ORIGIN}${COLLECTION_PATH}`, items: [] }) },
    })
    expect(res).toBeNull()
  })
})

describe('a throwing source is a no-match for every one of the five', () => {
  it.each(ALL_FIVE)('%s throwing does not break the request', async (throwing) => {
    const calls: string[] = []
    const sources = recordingSources(calls, { collection: true })
    const thrower = () => {
      calls.push(throwing)
      throw new Error('merchant bug')
    }
    const res = await handleRequest(makeRequest(COLLECTION_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: { ...sources, [throwing]: thrower },
    })
    expect(calls).toEqual(ALL_FIVE)
    // Every source above `collection` throwing still leaves collection to
    // answer; `collection` itself throwing passes through to HTML.
    expect(res === null ? null : await res.text()).toBe(
      throwing === 'collection' ? null : COLLECTION_BODY,
    )
  })

  it('a rejecting async source is a no-match too', async () => {
    const res = await handleRequest(makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: {
        document: () => Promise.reject(new Error('upstream 503')),
        collection: () => collection,
      },
    })
    expect(await res!.text()).toBe(COLLECTION_BODY)
  })
})

// ---------------------------------------------------------------------------
// Malformed source values — the 500s this PR removes
// ---------------------------------------------------------------------------

/**
 * Merchant resolvers are ordinary application code and are frequently written
 * in JavaScript, so the types below are a promise, not a guarantee. Each cast
 * models one shape a real resolver returns by accident — a bare object where
 * an array was expected, an API response passed straight through. Before the
 * `Array.isArray` guards each of these threw inside `resolveMarkdown`, which
 * `handleRequest` does not catch: a 500 on the merchant's live site, caused
 * by us, on the path whose entire promise is that it cannot do that.
 */
describe('a malformed source value is a no-match, never a thrown request', () => {
  it.each([
    ['policies returning a bare object', 'policies', { title: 'Shipping' }],
    ['policies returning a string', 'policies', 'Orders ship in 2 days'],
    ['catalog returning a bare object', 'catalog', { items: [] }],
    ['collection with no items array', 'collection', { url: STORE_ORIGIN, title: 'Services' }],
    ['collection with items as an object', 'collection', { url: STORE_ORIGIN, items: {} }],
  ])('%s', async (_name, key, value) => {
    const config: GatewayConfig = {
      storeId: 'store_test',
      sources: { [key]: () => value } as GatewaySources,
    }
    await expect(
      handleRequest(makeRequest(COLLECTION_PATH, CLAUDE_CODE_HEADERS), config),
    ).resolves.toBeNull()
  })

  it('resolution continues past a malformed value to the next source', async () => {
    const res = await handleRequest(makeRequest(COLLECTION_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: {
        policies: (() => ({ title: 'Shipping' })) as unknown as GatewaySources['policies'],
        collection: () => collection,
      },
    })
    expect(await res!.text()).toBe(COLLECTION_BODY)
  })
})

// ---------------------------------------------------------------------------
// The `match` router
// ---------------------------------------------------------------------------

describe('sources.match: at most one resolver runs', () => {
  it.each<[SourceKind, string, string]>([
    ['product', PDP_PATH, '# [Trail Runner 2]'],
    ['document', DOCUMENT_PATH, '# [Teeth whitening]'],
    ['collection', COLLECTION_PATH, '# [Services]'],
  ])('match → %s calls exactly that resolver and no other', async (kind, path, head) => {
    const calls: string[] = []
    const sources = recordingSources(calls, {
      product: true,
      policies: true,
      catalog: true,
      document: true,
      collection: true,
    })
    const res = await handleRequest(makeRequest(path, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: { ...sources, match: () => kind },
    })
    expect(calls).toEqual([kind])
    expect(await res!.text()).toContain(head)
  })

  it('a routed source that does not match passes through — the chain is not resumed', async () => {
    const calls: string[] = []
    const res = await handleRequest(makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      // `collection` would have matched had the chain run; the router said
      // document, so document is the only answer the request can get.
      sources: { ...recordingSources(calls, { collection: true }), match: () => 'document' },
    })
    expect(calls).toEqual(['document'])
    expect(res).toBeNull()
  })

  it('match returning null falls through to the full ordered chain', async () => {
    const calls: string[] = []
    const res = await handleRequest(makeRequest(COLLECTION_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: { ...recordingSources(calls, { collection: true }), match: () => null },
    })
    expect(calls).toEqual(ALL_FIVE)
    expect(await res!.text()).toBe(COLLECTION_BODY)
  })

  it('a throwing match falls through to the chain rather than breaking the request', async () => {
    const calls: string[] = []
    const res = await handleRequest(makeRequest(COLLECTION_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: {
        ...recordingSources(calls, { collection: true }),
        match: () => {
          throw new Error('router bug')
        },
      },
    })
    expect(calls).toEqual(ALL_FIVE)
    expect(await res!.text()).toBe(COLLECTION_BODY)
  })

  it('an unrecognised kind is treated as null (untyped callers)', async () => {
    const calls: string[] = []
    const res = await handleRequest(makeRequest(COLLECTION_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: {
        ...recordingSources(calls, { collection: true }),
        match: (() => 'produts') as unknown as GatewaySources['match'], // merchant typo
      },
    })
    expect(calls).toEqual(ALL_FIVE)
    expect(await res!.text()).toBe(COLLECTION_BODY)
  })

  it('the router receives the request URL', async () => {
    const seen: string[] = []
    await handleRequest(makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: {
        ...universalSources,
        match: (url) => {
          seen.push(url.pathname)
          return url.pathname.startsWith('/services/') ? 'document' : null
        },
      },
    })
    expect(seen).toEqual([DOCUMENT_PATH])
  })
})

// ---------------------------------------------------------------------------
// Resolver timeout
// ---------------------------------------------------------------------------

/** A resolver that never settles — the failure mode the timeout exists for. */
const hangs = (): Promise<never> => new Promise<never>(() => {})

/** A resolver that settles after `ms`. */
function slow<T>(value: T, ms: number): () => Promise<T> {
  return () => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms))
}

describe('sourceTimeoutMs: a hanging resolver is a no-match', () => {
  it('a hanging source does not hold the response open; the next source answers', async () => {
    const res = await handleRequest(makeRequest(COLLECTION_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: { document: hangs, collection: () => collection },
      sourceTimeoutMs: 10,
    })
    expect(await res!.text()).toBe(COLLECTION_BODY)
  })

  it('every source hanging passes through to HTML rather than never returning', async () => {
    const res = await handleRequest(makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: { product: hangs, document: hangs, collection: hangs },
      sourceTimeoutMs: 10,
    })
    expect(res).toBeNull()
  })

  it('a resolver slower than the timeout is a no-match; one faster still answers', async () => {
    const config = (ms: number): GatewayConfig => ({
      storeId: 'store_test',
      sources: { document: slow(document, 30) },
      sourceTimeoutMs: ms,
    })
    expect(
      await handleRequest(makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS), config(5)),
    ).toBeNull()
    const res = await handleRequest(makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS), config(2000))
    expect(await res!.text()).toBe(DOCUMENT_BODY)
  })

  it('a non-positive timeout disables the cutoff (the merchant waits, by choice)', async () => {
    const res = await handleRequest(makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: { document: slow(document, 30) },
      sourceTimeoutMs: 0,
    })
    expect(await res!.text()).toBe(DOCUMENT_BODY)
  })

  it('the default is 250ms when sourceTimeoutMs is not configured', async () => {
    const started = performance.now()
    const res = await handleRequest(makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS), {
      storeId: 'store_test',
      sources: { document: hangs },
    })
    const elapsed = performance.now() - started
    expect(res).toBeNull()
    // Bounded on both sides: a much shorter default would cut off legitimate
    // resolvers, and a much longer one would not bound anything worth
    // bounding at the edge.
    expect(elapsed).toBeGreaterThanOrEqual(200)
    expect(elapsed).toBeLessThan(1000)
  })
})

// ---------------------------------------------------------------------------
// Per-source byte budgets
// ---------------------------------------------------------------------------

describe('maxBytesBySource', () => {
  it('applies a document-specific budget without touching the product budget', async () => {
    const calls: string[] = []
    const config: GatewayConfig = {
      storeId: 'store_test',
      sources: {
        product: (url) => (url.pathname === PDP_PATH ? product : null),
        document: (url) => {
          calls.push('document')
          return url.pathname === DOCUMENT_PATH ? document : null
        },
      },
      maxBytesBySource: { document: 300 },
    }

    const doc = await handleRequest(makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS), config)
    const docText = await doc!.text()
    expect(docText).toContain('- **Price:** $320.00')
    expect(docText).not.toContain('## Related')
    expect(docText).not.toContain('## What to expect')
    expect(docText.endsWith('*Truncated to fit size budget; remaining content omitted.*')).toBe(
      true,
    )

    // Same request, same config: the product keeps render-md's default budget
    // and its full body, including the block a 300-byte budget would have cut.
    const pdp = await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), config)
    const pdpText = await pdp!.text()
    expect(pdpText).toContain('## Description')
    expect(byteLength(pdpText)).toBe(803)
  })

  it('a source with no entry falls back to the global maxBytes', async () => {
    const res = await handleRequest(makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS), {
      ...universalConfig(),
      maxBytes: 300,
      maxBytesBySource: { product: 8192 },
    })
    expect(await res!.text()).not.toContain('## Related')
  })

  it('the per-source entry wins over the global maxBytes', async () => {
    const res = await handleRequest(makeRequest(DOCUMENT_PATH, CLAUDE_CODE_HEADERS), {
      ...universalConfig(),
      maxBytes: 300,
      maxBytesBySource: { document: 5120 },
    })
    expect(await res!.text()).toBe(DOCUMENT_BODY)
  })
})

// ---------------------------------------------------------------------------
// llms.txt § Pages
// ---------------------------------------------------------------------------

const LLMS_OPTIONS = {
  baseUrl: STORE_ORIGIN,
  siteName: 'Bend Family Dental',
  description: 'General and cosmetic dentistry in Bend, OR.',
}

describe('generateLlmsTxt — the auto ## Pages section', () => {
  it('lists collection items, with a single-line summary as the note', async () => {
    const txt = await generateLlmsTxt(
      { storeId: 'store_clinic', sources: { collection: () => collection } },
      LLMS_OPTIONS,
    )
    expect(txt).toBe(
      [
        '# Bend Family Dental',
        '',
        '> General and cosmetic dentistry in Bend, OR.',
        '',
        '## Pages',
        '',
        `- [Teeth whitening](${STORE_ORIGIN}${DOCUMENT_PATH}): One 90-minute appointment.`,
        `- [Dental implants](${STORE_ORIGIN}/services/implants)`,
        '',
      ].join('\n'),
    )
  })

  it('sits after ## Products and before ## Policies', async () => {
    const txt = await generateLlmsTxt(
      {
        storeId: 'store_test',
        sources: { catalog: () => catalog, collection: () => collection, policies: () => policies },
      },
      LLMS_OPTIONS,
    )
    expect(txt.indexOf('## Products')).toBeLessThan(txt.indexOf('## Pages'))
    expect(txt.indexOf('## Pages')).toBeLessThan(txt.indexOf('## Policies'))
  })

  it('omits a multi-line summary rather than breaking the one-line link format', async () => {
    const txt = await generateLlmsTxt(
      {
        storeId: 'store_test',
        sources: {
          collection: () => ({
            url: `${STORE_ORIGIN}${COLLECTION_PATH}`,
            items: [{ url: `${STORE_ORIGIN}/a`, title: 'A', summary: 'First line\nsecond line' }],
          }),
        },
      },
      LLMS_OPTIONS,
    )
    expect(txt).toContain(`- [A](${STORE_ORIGIN}/a)\n`)
    expect(txt).not.toContain('second line')
  })

  it('a config with no collection source is byte-identical to one that cannot have had it', async () => {
    const commerce: GatewayConfig = {
      storeId: 'store_test',
      sources: { catalog: () => catalog, policies: () => policies },
    }
    const withUnmatchedCollection: GatewayConfig = {
      storeId: 'store_test',
      sources: { ...commerce.sources, collection: () => null },
    }
    const before = await generateLlmsTxt(commerce, LLMS_OPTIONS)
    expect(await generateLlmsTxt(withUnmatchedCollection, LLMS_OPTIONS)).toBe(before)
    expect(before).not.toContain('## Pages')
  })

  it('a collection with no items array lists nothing and never throws', async () => {
    const txt = await generateLlmsTxt(
      {
        storeId: 'store_test',
        sources: {
          collection: (() => ({ url: STORE_ORIGIN })) as unknown as GatewaySources['collection'],
          policies: () => policies,
        },
      },
      LLMS_OPTIONS,
    )
    expect(txt).not.toContain('## Pages')
    expect(txt).toContain('## Policies')
  })
})
