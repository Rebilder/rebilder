/**
 * What this template promises, asserted.
 *
 * These are not tests of the gateway — that has its own suite. They test the
 * three claims the README makes to somebody about to put this in front of a
 * live site:
 *
 *  1. An agent asking for markdown on a described page gets markdown.
 *  2. Everybody else reaches the origin, byte for byte.
 *  3. Nothing this Worker can do takes the site down.
 *
 * The third is the one worth having. A merchant installing edge middleware is
 * betting their front door on it, so "a broken resolver serves HTML rather
 * than a 500" needs to be a fact rather than a design intention.
 */
import { describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { COLLECTIONS, DOCUMENTS } from '../src/content'

/** The origin's reply, when the Worker forwards to it. */
const ORIGIN_HTML = '<!doctype html><title>Origin</title>'

function originResponse(): Response {
  return new Response(ORIGIN_HTML, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

/**
 * Runs the Worker with `fetch` stubbed, so no test touches the network.
 * `env.ORIGIN` unset exercises the route-mounted path (`fetch(req)`); set,
 * the explicit-origin path.
 */
async function run(
  request: Request,
  env: { ORIGIN?: string } = {},
): Promise<{ response: Response; fetched: Request[] }> {
  const fetched: Request[] = []
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    fetched.push(input instanceof Request ? input : new Request(input, init))
    return originResponse()
  })
  const original = globalThis.fetch
  globalThis.fetch = stub as unknown as typeof fetch
  try {
    return { response: await worker.fetch(request, env), fetched }
  } finally {
    globalThis.fetch = original
  }
}

const agent = (path: string) =>
  new Request(`https://example.com${path}`, { headers: { accept: 'text/markdown' } })

const human = (path: string) =>
  new Request(`https://example.com${path}`, {
    headers: { accept: 'text/html,application/xhtml+xml' },
  })

// ---------------------------------------------------------------------------

describe('an agent asking for markdown', () => {
  it('gets markdown for a described document, with no network call', async () => {
    const { response, fetched } = await run(agent('/services/bike-fitting'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/markdown')
    expect(fetched).toHaveLength(0)

    const body = await response.text()
    expect(body).toContain('Bike fitting')
    // The facts are the payload. A price that renders as prose is a price an
    // agent has to parse out of a sentence.
    //
    // The exact string matters more than it looks: `Money.amount` is in MINOR
    // units, so the first draft of the example content declared 180 and this
    // assertion passed against a rendered "£1.80". Asserting the formatted
    // price is what caught it.
    expect(body).toContain('£180.00')
  })

  it('gets markdown for a described collection', async () => {
    const { response } = await run(agent('/services'))
    expect(response.headers.get('content-type')).toContain('text/markdown')
    const body = await response.text()
    expect(body).toContain('Bike fitting')
    expect(body).toContain('Bike servicing')
  })

  it('is served the same page whether or not the URL has a trailing slash', async () => {
    const { response } = await run(agent('/services/bike-fitting/'))
    expect(response.headers.get('content-type')).toContain('text/markdown')
  })

  it('falls through to the origin for a page nobody described', async () => {
    const { response, fetched } = await run(agent('/blog/some-post'))
    expect(await response.text()).toBe(ORIGIN_HTML)
    expect(fetched).toHaveLength(1)
  })
})

describe('everybody else', () => {
  it('reaches the origin unchanged', async () => {
    const { response, fetched } = await run(human('/services/bike-fitting'))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(ORIGIN_HTML)
    expect(fetched).toHaveLength(1)
  })

  it('gets a Vary that names Accept, so a shared cache cannot cross the streams', async () => {
    // Without this, a CDN can hand an agent the HTML it cached for a browser
    // at the same URL — or worse, hand a browser the markdown.
    const { response } = await run(human('/services/bike-fitting'))
    expect(response.headers.get('vary')?.toLowerCase()).toContain('accept')
  })

  it('is advertised the markdown alternate on a page that has one', async () => {
    const { response } = await run(human('/services/bike-fitting'))
    expect(response.headers.get('link') ?? '').toContain('alternate')
  })
})

describe('the explicit-origin path', () => {
  it('rewrites the host and keeps the path and query', async () => {
    const { fetched } = await run(human('/services?page=2'), { ORIGIN: 'origin.example.com' })
    expect(fetched).toHaveLength(1)
    const url = new URL(fetched[0]!.url)
    expect(url.hostname).toBe('origin.example.com')
    expect(url.pathname).toBe('/services')
    expect(url.search).toBe('?page=2')
  })

  it('still serves markdown from the edge without touching the origin', async () => {
    const { response, fetched } = await run(agent('/visit'), { ORIGIN: 'origin.example.com' })
    expect(response.headers.get('content-type')).toContain('text/markdown')
    expect(fetched).toHaveLength(0)
  })
})

describe('nothing here can take the site down', () => {
  it('serves the origin when a resolver throws', async () => {
    // Simulated by pointing the content map at a getter that explodes — the
    // realistic version is a merchant's own lookup code raising on an edge
    // case they did not anticipate, six months after they deployed this.
    const spy = vi.spyOn(DOCUMENTS, 'get').mockImplementation(() => {
      throw new Error('resolver blew up')
    })
    try {
      const { response } = await run(agent('/services/bike-fitting'))
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(ORIGIN_HTML)
    } finally {
      spy.mockRestore()
    }
  })

  it('serves the origin when the origin itself errors, without rewriting the error', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response('upstream is down', { status: 502 })) as never
    try {
      const response = await worker.fetch(human('/anything'), {})
      expect(response.status).toBe(502)
      expect(await response.text()).toBe('upstream is down')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('the example content is coherent', () => {
  it('every collection item points at a document this Worker can serve', () => {
    // A listing that links to pages the gateway does not know about sends an
    // agent to HTML it cannot read, which is worse than not listing them.
    for (const collection of COLLECTIONS.values()) {
      for (const item of collection.items) {
        const path = new URL(item.url).pathname
        expect(DOCUMENTS.has(path), `${item.url} is listed but not described`).toBe(true)
      }
    }
  })

  it('every document key matches the pathname of its own canonical URL', () => {
    for (const [path, document] of DOCUMENTS) {
      expect(new URL(document.url).pathname).toBe(path)
    }
  })
})
