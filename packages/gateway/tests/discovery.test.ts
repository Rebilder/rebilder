/**
 * Discovery for agents that do not negotiate: `.md` URLs, frontmatter, the
 * markdown 404, the `<link rel="alternate">` helper and sitemap.md.
 *
 * Every one of these is off until configured, so the first test in each block
 * pins the default: the response a merchant got before is the response they
 * get now. The rest pin the promises in the config docs: a `.md` URL serves
 * the same bytes as negotiation and names its canonical page, a real `.md`
 * file is never answered for, frontmatter only prepends, the 404 never reaches
 * a person or a crawler, and the alternate is never claimed for a page with no
 * source.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RebilderEventV0 } from '@rebilder/events'
import type { CollectionSource, DocumentSource, GatewayConfig, GatewaySources } from '../src/index'
import {
  generateLlmsTxt,
  generateSitemapMd,
  handleRequest,
  markdownAlternate,
  markdownNotFoundResponse,
} from '../src/index'
import { createFetchMiddleware } from '../src/adapters/fetch/index'
import { createGatewayFetchHandler } from '../src/adapters/edge/index'
import {
  createGatewayProxy,
  createSitemapMdRouteHandler,
  markdownAlternateTypes,
  withNegotiationHeaders,
} from '../src/adapters/next/index'
import {
  BROWSER_CHROME_HEADERS,
  CATALOG_PATH,
  CLAUDE_CODE_HEADERS,
  GOOGLEBOT_HEADERS,
  GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS,
  PDP_PATH,
  POLICY_PATH,
  STORE_ORIGIN,
  makeRequest,
  pathMatchedSources,
  policies,
  product,
} from './fixtures'

const DOC_PATH = '/services/bike-fitting'
const doc: DocumentSource = {
  url: `${STORE_ORIGIN}${DOC_PATH}`,
  title: 'Bike fitting',
  summary: 'A 90-minute fit on your own bike, with a written report.',
  updated: '2026-09-28',
  facts: [{ label: 'Booking required', value: { type: 'boolean', value: true } }],
}
const HOME: DocumentSource = { url: STORE_ORIGIN, title: 'Acme Outdoors', summary: 'Trail gear.' }
const LIST_PATH = '/services'
const list: CollectionSource = {
  url: `${STORE_ORIGIN}${LIST_PATH}`,
  title: 'Services',
  updated: '2026-09-01',
  items: [{ url: doc.url, title: doc.title }],
}

function sources(): GatewaySources {
  return {
    ...pathMatchedSources(),
    document: (url) => (url.pathname === DOC_PATH ? doc : url.pathname === '/' ? HOME : null),
    collection: (url) => (url.pathname === LIST_PATH ? list : null),
  }
}

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { storeId: 'store_test', sources: sources(), ...overrides }
}

const agent = (path: string) => makeRequest(path, CLAUDE_CODE_HEADERS)
const browser = (path: string) => makeRequest(path, BROWSER_CHROME_HEADERS)
const htmlPage =
  (status = 200) =>
  () =>
    new Response('<!doctype html><title>page</title>', {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })

async function body(res: Response | null): Promise<string> {
  expect(res).not.toBeNull()
  return res!.text()
}

// ---------------------------------------------------------------------------
// .md URL variants
// ---------------------------------------------------------------------------

describe('markdownUrls', () => {
  it('is off by default: a .md URL is an ordinary URL', async () => {
    expect(await handleRequest(agent(`${PDP_PATH}.md`), config())).toBeNull()
    expect(await handleRequest(browser(`${PDP_PATH}.md`), config())).toBeNull()
  })

  it('serves the same bytes as negotiation, with the page as canonical', async () => {
    const cfg = config({ markdownUrls: true })
    const negotiated = await handleRequest(agent(PDP_PATH), cfg)
    const variant = await handleRequest(agent(`${PDP_PATH}.md`), cfg)
    expect(variant?.status).toBe(200)
    expect(variant?.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(variant?.headers.get('vary')).toBe('Accept')
    expect(variant?.headers.get('x-rebilder-path')).toBe('markdown')
    expect(variant?.headers.get('link')).toBe(`<${STORE_ORIGIN}${PDP_PATH}>; rel="canonical"`)
    expect(variant?.headers.get('etag')).toBe(negotiated?.headers.get('etag'))
    expect(await body(variant)).toBe(await body(negotiated))
  })

  it('answers everyone at the .md URL, because it has one representation', async () => {
    const cfg = config({ markdownUrls: true })
    for (const headers of [
      BROWSER_CHROME_HEADERS,
      GOOGLEBOT_HEADERS,
      { 'user-agent': 'curl/8.7.1' },
    ]) {
      const res = await handleRequest(makeRequest(`${DOC_PATH}.md`, headers), cfg)
      expect(res?.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
      expect(res?.headers.get('link')).toBe(`<${STORE_ORIGIN}${DOC_PATH}>; rel="canonical"`)
    }
  })

  it('leaves the page URL alone: crawlers and browsers still get HTML there', async () => {
    const cfg = config({ markdownUrls: true })
    expect(await handleRequest(makeRequest(DOC_PATH, GOOGLEBOT_HEADERS), cfg)).toBeNull()
    expect(
      await handleRequest(makeRequest(DOC_PATH, GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS), cfg),
    ).toBeNull()
    expect(await handleRequest(browser(DOC_PATH), cfg)).toBeNull()
  })

  it('never answers for a .md path whose page has no source, so real files serve', async () => {
    const cfg = config({ markdownUrls: true })
    for (const path of ['/README.md', '/docs/guide.md', '/products/unknown.md']) {
      expect(await handleRequest(browser(path), cfg), path).toBeNull()
      expect(await handleRequest(agent(path), cfg), path).toBeNull()
    }
  })

  it('maps /index.md to the root page and keeps the query', async () => {
    const cfg = config({ markdownUrls: true })
    const home = await handleRequest(browser('/index.md'), cfg)
    expect(home?.headers.get('link')).toBe(`<${STORE_ORIGIN}/>; rel="canonical"`)
    expect(await body(home)).toContain('Acme Outdoors')
    const withQuery = await handleRequest(browser(`${DOC_PATH}.md?lang=en`), cfg)
    expect(withQuery?.headers.get('link')).toBe(
      `<${STORE_ORIGIN}${DOC_PATH}?lang=en>; rel="canonical"`,
    )
  })

  it('is GET and HEAD only, lower-case .md only, and needs a page name', async () => {
    const cfg = config({ markdownUrls: true })
    const post = new Request(`${STORE_ORIGIN}${DOC_PATH}.md`, {
      method: 'POST',
      headers: BROWSER_CHROME_HEADERS,
    })
    expect(await handleRequest(post, cfg)).toBeNull()
    const head = new Request(`${STORE_ORIGIN}${DOC_PATH}.md`, {
      method: 'HEAD',
      headers: BROWSER_CHROME_HEADERS,
    })
    expect((await handleRequest(head, cfg))?.status).toBe(200)
    for (const path of [`${DOC_PATH}.MD`, '/.md', '/services/.md', `${DOC_PATH}%2Emd`]) {
      expect(await handleRequest(browser(path), cfg), path).toBeNull()
    }
  })

  it('records a sourced markdown event for the .md URL', async () => {
    const events: RebilderEventV0[] = []
    const cfg = config({ markdownUrls: true, onEvent: (event) => void events.push(event) })
    await handleRequest(browser(`${DOC_PATH}.md`), cfg)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.response).toMatchObject({
      path: 'markdown',
      coverage: 'sourced',
      source: 'document',
    })
    expect(events[0]!.request.url).toBe(`${STORE_ORIGIN}${DOC_PATH}.md`)
  })

  it('still applies the access policy to agents', async () => {
    const cfg = config({
      markdownUrls: true,
      access: { rules: [{ subject: '*', action: 'deny' }] },
    })
    expect((await handleRequest(agent(`${DOC_PATH}.md`), cfg))?.status).toBe(403)
    // People are never subject to the agent policy.
    expect((await handleRequest(browser(`${DOC_PATH}.md`), cfg))?.status).toBe(200)
  })

  it('works through the Next.js proxy', async () => {
    const proxy = createGatewayProxy(config({ markdownUrls: true }), htmlPage())
    const res = await proxy(browser(`${DOC_PATH}.md`))
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
  })
})

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

describe('frontmatter', () => {
  it('is off by default: the body starts with the title heading', async () => {
    const text = await body(await handleRequest(agent(DOC_PATH), config()))
    expect(text.startsWith('# [Bike fitting]')).toBe(true)
  })

  it('prepends the source fields and leaves the body byte-for-byte unchanged', async () => {
    const plain = await body(await handleRequest(agent(DOC_PATH), config()))
    const res = await handleRequest(agent(DOC_PATH), config({ frontmatter: true }))
    const text = await body(res)
    const block = [
      '---',
      'title: Bike fitting',
      'description: A 90-minute fit on your own bike, with a written report.',
      `canonical_url: ${STORE_ORIGIN}${DOC_PATH}`,
      'last_updated: "2026-09-28"',
      '---',
      '',
      '',
    ].join('\n')
    expect(text).toBe(`${block}${plain}`)
    // The header and the block name the same canonical page.
    expect(res?.headers.get('link')).toBe(`<${STORE_ORIGIN}${DOC_PATH}>; rel="canonical"`)
  })

  it('uses only fields each source kind has; nothing is generated', async () => {
    const cfg = config({ frontmatter: true })
    const pdp = await body(await handleRequest(agent(PDP_PATH), cfg))
    expect(pdp).toMatch(/^---\ntitle: Trail Runner 2\ndescription: The Trail Runner 2 is built/)
    expect(pdp).not.toContain('last_updated')

    const listing = await body(await handleRequest(agent(LIST_PATH), cfg))
    expect(listing.split('\n---\n')[0]).toBe(
      `---\ntitle: Services\ncanonical_url: ${STORE_ORIGIN}${LIST_PATH}\nlast_updated: "2026-09-01"`,
    )

    // Two policies on one URL have no single title.
    const policyPage = await body(await handleRequest(agent(POLICY_PATH), cfg))
    expect(policyPage.split('\n---\n')[0]).toBe(`---\ncanonical_url: ${STORE_ORIGIN}${POLICY_PATH}`)
    const single = config({ frontmatter: true, sources: { policies: () => [policies[0]!] } })
    expect(await body(await handleRequest(agent(POLICY_PATH), single))).toMatch(
      /^---\ntitle: Shipping policy\n/,
    )

    const collection = await body(await handleRequest(agent(CATALOG_PATH), cfg))
    expect(collection.split('\n---\n')[0]).toBe(
      `---\ncanonical_url: ${STORE_ORIGIN}${CATALOG_PATH}`,
    )
  })

  it('takes a document description from its Description fact, then summary, then Summary fact', async () => {
    const withFact = (facts: DocumentSource['facts'], summary?: string) =>
      config({
        frontmatter: true,
        sources: {
          document: () => ({ url: doc.url, title: 'T', ...(summary ? { summary } : {}), facts }),
        },
      })
    const described = await body(
      await handleRequest(
        agent(DOC_PATH),
        withFact([
          { label: 'Price', value: { type: 'text', value: '$10' } },
          { label: 'description', value: { type: 'text', value: 'From the fact.' } },
        ]),
      ),
    )
    expect(described).toContain('description: From the fact.\n')
    const summarised = await body(
      await handleRequest(
        agent(DOC_PATH),
        withFact([{ label: 'Summary', value: { type: 'text', value: 'The lede.' } }]),
      ),
    )
    expect(summarised).toContain('description: The lede.\n')
    // The labelled Description wins over summary, and summary over a Summary
    // fact; a non-text value is never used.
    const both = await body(
      await handleRequest(
        agent(DOC_PATH),
        withFact([{ label: 'Description', value: { type: 'text', value: 'Fact.' } }], 'Summary.'),
      ),
    )
    expect(both).toContain('description: Fact.\n')
    const lede = await body(
      await handleRequest(
        agent(DOC_PATH),
        withFact([{ label: 'Summary', value: { type: 'text', value: 'Fact.' } }], 'Summary.'),
      ),
    )
    expect(lede).toContain('description: Summary.\n')
    const numeric = await body(
      await handleRequest(
        agent(DOC_PATH),
        withFact([{ label: 'Description', value: { type: 'number', value: 3 } }]),
      ),
    )
    expect(numeric).not.toContain('description:')
  })

  it('drops an invalid date instead of repairing it', async () => {
    const cfg = config({
      frontmatter: true,
      sources: { product: () => ({ ...product, updated: '2026-02-31' }) },
    })
    expect(await body(await handleRequest(agent(PDP_PATH), cfg))).not.toContain('last_updated')
  })

  it('names the page, not the .md URL, as canonical on a variant', async () => {
    const cfg = config({ frontmatter: true, markdownUrls: true })
    const text = await body(await handleRequest(browser(`${DOC_PATH}.md`), cfg))
    expect(text).toContain(`canonical_url: ${STORE_ORIGIN}${DOC_PATH}\n`)
  })

  it('comes before a compatibility profile prefix', async () => {
    const cfg = config({
      frontmatter: true,
      maxBytes: 20_000,
      compatibilityProfile: { id: 'source-envelope', version: 1 },
    })
    const res = await handleRequest(agent(DOC_PATH), cfg)
    expect(res?.headers.get('x-rebilder-profile')).toBe('source-envelope@1')
    const text = await body(res)
    expect(text.startsWith('---\ntitle: Bike fitting')).toBe(true)
    expect(text).toContain(`---\n\nSource: "${STORE_ORIGIN}${DOC_PATH}"\n\n# [Bike fitting]`)
  })
})

// ---------------------------------------------------------------------------
// Markdown 404
// ---------------------------------------------------------------------------

const LINKS = [
  { title: 'Sitemap', url: '/sitemap.md', note: 'Every page' },
  { title: 'llms.txt', url: 'https://store.example.com/llms.txt' },
]

describe('notFound', () => {
  it('is off by default: a miss passes through', async () => {
    expect(await handleRequest(agent('/nope'), config())).toBeNull()
  })

  it('answers a confirmed missing page with a markdown 404 and discovery links', async () => {
    const cfg = config({ notFound: { links: LINKS, isMissing: () => true } })
    const res = await handleRequest(agent('/nope'), cfg)
    expect(res?.status).toBe(404)
    expect(res?.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res?.headers.get('vary')).toBe('Accept')
    expect(res?.headers.get('x-robots-tag')).toBe('noindex')
    expect(res?.headers.get('link')).toBeNull()
    expect(await body(res)).toBe(
      [
        '# Page not found',
        '',
        'There is no page at this address.',
        '',
        `- [Sitemap](${STORE_ORIGIN}/sitemap.md): Every page`,
        `- [llms.txt](${STORE_ORIGIN}/llms.txt)`,
        '',
      ].join('\n'),
    )
  })

  it('records the same Agent Miss event as before', async () => {
    const events: RebilderEventV0[] = []
    const cfg = config({
      notFound: { isMissing: () => true },
      onEvent: (event) => void events.push(event),
    })
    await handleRequest(agent('/nope'), cfg)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]!.response).toMatchObject({
      path: 'html-variant',
      coverage: 'unsourced',
      source: 'none',
    })
  })

  it('passes through when the predicate says no, throws or is absent', async () => {
    for (const notFound of [
      { isMissing: () => false },
      {
        isMissing: () => {
          throw new Error('bad predicate')
        },
      },
      { links: LINKS },
    ]) {
      expect(await handleRequest(agent('/nope'), config({ notFound }))).toBeNull()
    }
  })

  it('never reaches a person or a crawler, and never overrides a source', async () => {
    const isMissing = vi.fn(() => true)
    const cfg = config({ notFound: { isMissing } })
    expect(await handleRequest(browser('/nope'), cfg)).toBeNull()
    expect(
      await handleRequest(makeRequest('/nope', GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS), cfg),
    ).toBeNull()
    expect((await handleRequest(agent(DOC_PATH), cfg))?.status).toBe(200)
    expect(isMissing).not.toHaveBeenCalled()
  })

  it('drops links it cannot resolve or that are not http(s), and escapes titles', () => {
    const res = markdownNotFoundResponse(
      {
        links: [
          { title: 'Bad', url: 'javascript:alert(1)' },
          { title: 'Also bad', url: 'http://[::1' },
          { title: 'Docs] [x](https://evil.example)', url: '/docs' },
        ],
      },
      new URL(`${STORE_ORIGIN}/missing`),
      410,
    )
    expect(res.status).toBe(410)
    return res.text().then((text) => {
      expect(text).not.toContain('javascript:')
      expect(text).not.toContain('Also bad')
      expect(text).toContain(`- [Docs\\] \\[x\\]\\(https://evil.example\\)](${STORE_ORIGIN}/docs)`)
    })
  })

  describe('adapters that see your own status', () => {
    it('fetch middleware re-bodies your 404 and 410 for a markdown request only', async () => {
      const gateway = createFetchMiddleware(config({ notFound: { links: LINKS } }))
      const missing = await gateway(agent('/nope'), htmlPage(404))
      expect(missing.status).toBe(404)
      expect(missing.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
      expect(await missing.text()).toContain('# Page not found')
      expect((await gateway(agent('/gone'), htmlPage(410))).status).toBe(410)

      const human = await gateway(browser('/nope'), htmlPage(404))
      expect(human.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(human.headers.get('vary')).toBe('Accept')
      const ok = await gateway(agent('/unsourced-but-real'), htmlPage(200))
      expect(ok.headers.get('content-type')).toBe('text/html; charset=utf-8')
    })

    it('fetch middleware leaves your 404 alone when notFound is unset', async () => {
      const gateway = createFetchMiddleware(config())
      const res = await gateway(agent('/nope'), htmlPage(404))
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    })

    it('edge handler re-bodies the origin 404 for a markdown request', async () => {
      const handler = createGatewayFetchHandler(config({ notFound: {} }), {
        fallback: htmlPage(404),
      })
      const res = await handler(agent('/nope'))
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('# Page not found\n\nThere is no page at this address.\n')
      const human = await handler(browser('/nope'))
      expect(human.headers.get('content-type')).toBe('text/html; charset=utf-8')
    })
  })
})

// ---------------------------------------------------------------------------
// <link rel="alternate" type="text/markdown">
// ---------------------------------------------------------------------------

describe('markdownAlternate', () => {
  const routed = (): GatewayConfig =>
    config({
      sources: {
        ...sources(),
        match: (url) => (url.pathname === DOC_PATH ? 'document' : null),
      },
    })

  it('returns the page URL when the match router confirms a source', () => {
    expect(markdownAlternate(routed(), `${STORE_ORIGIN}${DOC_PATH}`)).toEqual({
      rel: 'alternate',
      type: 'text/markdown',
      href: `${STORE_ORIGIN}${DOC_PATH}`,
    })
    expect(markdownAlternateTypes(routed(), new URL(`${STORE_ORIGIN}${DOC_PATH}`))).toEqual({
      'text/markdown': `${STORE_ORIGIN}${DOC_PATH}`,
    })
  })

  it('never claims a page it cannot confirm', () => {
    expect(markdownAlternate(routed(), `${STORE_ORIGIN}/about`)).toBeNull()
    expect(markdownAlternateTypes(routed(), `${STORE_ORIGIN}/about`)).toBeUndefined()
    // No router: running resolvers to find out is not allowed at render time.
    expect(markdownAlternate(config(), `${STORE_ORIGIN}${DOC_PATH}`)).toBeNull()
    expect(markdownAlternate(routed(), '/relative')).toBeNull()
    const throwing = config({
      sources: {
        match: () => {
          throw new Error('bad router')
        },
      },
    })
    expect(markdownAlternate(throwing, `${STORE_ORIGIN}${DOC_PATH}`)).toBeNull()
  })

  it('makes the same claim as the Link header on the HTML response', () => {
    const url = new URL(`${STORE_ORIGIN}${DOC_PATH}`)
    const res = withNegotiationHeaders(new Response('<html></html>'), routed(), url)
    const alternate = markdownAlternate(routed(), url)
    expect(res.headers.get('link')).toBe(
      `<${alternate!.href}>; rel="alternate"; type="text/markdown"`,
    )
  })
})

// ---------------------------------------------------------------------------
// sitemap.md
// ---------------------------------------------------------------------------

describe('generateSitemapMd', () => {
  const enumerating = (): GatewayConfig =>
    config({
      sources: {
        catalog: (url) => (url.pathname === '/' ? [{ ...product, url: product.url }] : null),
        collection: (url) => (url.pathname === '/' ? list : null),
        policies: (url) => (url.pathname === '/' ? policies : null),
      },
    })

  it('lists what the sources enumerate, then your sections', async () => {
    const markdown = await generateSitemapMd(enumerating(), {
      baseUrl: `${STORE_ORIGIN}/`,
      description: 'Every page on Acme Outdoors.',
      sections: [
        { title: 'Company', links: [{ title: 'About', url: `${STORE_ORIGIN}/about` }] },
        { title: 'Empty', links: [] },
      ],
    })
    expect(markdown).toBe(
      [
        '# Sitemap',
        '',
        '> Every page on Acme Outdoors.',
        '',
        '## Products',
        '',
        `- [Trail Runner 2](${product.url}): $89.00`,
        '',
        '## Pages',
        '',
        `- [Bike fitting](${doc.url})`,
        '',
        '## Policies',
        '',
        `- [Shipping policy](${policies[0]!.url})`,
        `- [Returns policy](${policies[1]!.url})`,
        '',
        '## Company',
        '',
        `- [About](${STORE_ORIGIN}/about)`,
        '',
      ].join('\n'),
    )
  })

  it('takes your title, and needs no sources', async () => {
    const markdown = await generateSitemapMd(
      { storeId: 's', sources: {} },
      { baseUrl: STORE_ORIGIN, title: 'Acme sitemap' },
    )
    expect(markdown).toBe('# Acme sitemap\n')
  })

  it('leaves llms.txt byte-for-byte as it was', async () => {
    const txt = await generateLlmsTxt(enumerating(), {
      baseUrl: `${STORE_ORIGIN}/`,
      siteName: 'Acme',
      description: 'Trail gear.',
    })
    expect(txt.startsWith('# Acme\n\n> Trail gear.\n\n## Products\n')).toBe(true)
    expect(txt.endsWith(`- [Returns policy](${policies[1]!.url})\n`)).toBe(true)
  })

  it('serves as text/markdown from the Next.js route handler', async () => {
    const GET = createSitemapMdRouteHandler(enumerating(), { baseUrl: `${STORE_ORIGIN}/` })
    const res = await GET(new Request(`${STORE_ORIGIN}/sitemap.md`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('cache-control')).toContain('s-maxage=3600')
    expect(await res.text()).toMatch(/^# Sitemap\n\n## Products\n/)
  })
})
