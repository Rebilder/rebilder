import { describe, expect, it } from 'vitest'
import { handleRequest, type GatewayConfig } from '../src/index'
import {
  createGatewayMiddleware,
  toWebRequest,
  type NodeRequestLike,
  type NodeResponseLike,
} from '../src/adapters/node/index'
import {
  BROWSER_CHROME_HEADERS,
  CLAUDE_CODE_HEADERS,
  GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS,
  PDP_PATH,
  STORE_ORIGIN,
  makeRequest,
  pathMatchedSources,
} from './fixtures'

// ---------------------------------------------------------------------------
// Node-shaped request/response doubles. The adapter's contract is structural
// (no express/fastify/node:http imports), so plain objects ARE the real
// interface — what any Node framework hands its middleware.
// ---------------------------------------------------------------------------

const STORE_HOST = new URL(STORE_ORIGIN).host

function nodeRequest(
  path: string,
  headers: Record<string, string | string[] | undefined>,
  overrides: Partial<NodeRequestLike> = {},
): NodeRequestLike {
  return {
    url: path,
    method: 'GET',
    headers: { host: STORE_HOST, 'x-forwarded-proto': 'https', ...headers },
    ...overrides,
  }
}

interface MockResponse extends NodeResponseLike {
  headers: Record<string, string>
  body: string | undefined
  ended: boolean
}

function mockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 200, // Node's default before anyone writes
    headers: {},
    body: undefined,
    ended: false,
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value
      return res
    },
    end(body?: string) {
      res.body = body
      res.ended = true
      return res
    },
  }
  return res
}

/** Run the middleware and resolve once it either responded or called next(). */
function run(
  config: GatewayConfig,
  req: NodeRequestLike,
): Promise<{ res: MockResponse; nextCalls: number }> {
  const middleware = createGatewayMiddleware(config)
  const res = mockResponse()
  return new Promise((resolve) => {
    let nextCalls = 0
    const originalEnd = res.end.bind(res)
    res.end = (body?: string) => {
      const out = originalEnd(body)
      resolve({ res, nextCalls })
      return out
    }
    middleware(req, res, () => {
      nextCalls += 1
      resolve({ res, nextCalls })
    })
  })
}

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { storeId: 'store_test', sources: pathMatchedSources(), ...overrides }
}

describe('toWebRequest', () => {
  it('builds the URL from headers.host + x-forwarded-proto + url', () => {
    const req = toWebRequest(nodeRequest(`${PDP_PATH}?variant=v-10`, CLAUDE_CODE_HEADERS))
    expect(req.url).toBe(`${STORE_ORIGIN}${PDP_PATH}?variant=v-10`)
    expect(req.method).toBe('GET')
    expect(req.headers.get('user-agent')).toBe(CLAUDE_CODE_HEADERS['user-agent']!)
  })

  it('prefers originalUrl over url (Express router rewrites url)', () => {
    const req = toWebRequest(
      nodeRequest('/rewritten-by-router', CLAUDE_CODE_HEADERS, {
        originalUrl: PDP_PATH,
      }),
    )
    expect(new URL(req.url).pathname).toBe(PDP_PATH)
  })

  it('falls back to req.protocol, then socket.encrypted, when x-forwarded-proto is absent', () => {
    const viaProtocol = toWebRequest({
      url: '/',
      headers: { host: STORE_HOST },
      protocol: 'https',
    })
    expect(new URL(viaProtocol.url).protocol).toBe('https:')

    const viaTls = toWebRequest({
      url: '/',
      headers: { host: STORE_HOST },
      socket: { encrypted: true },
    })
    expect(new URL(viaTls.url).protocol).toBe('https:')

    const plain = toWebRequest({ url: '/', headers: { host: STORE_HOST } })
    expect(new URL(plain.url).protocol).toBe('http:')
  })

  it('takes the FIRST x-forwarded-proto value from a proxy chain (list or array)', () => {
    const listed = toWebRequest({
      url: '/',
      headers: { host: STORE_HOST, 'x-forwarded-proto': 'https, http' },
    })
    expect(new URL(listed.url).protocol).toBe('https:')

    const arrayed = toWebRequest({
      url: '/',
      headers: { host: STORE_HOST, 'x-forwarded-proto': ['https', 'http'] },
    })
    expect(new URL(arrayed.url).protocol).toBe('https:')
  })

  it('appends array (repeated) headers per value and skips undefined entries', () => {
    const req = toWebRequest({
      url: '/',
      headers: {
        host: STORE_HOST,
        accept: ['text/markdown', 'text/plain;q=0.8'],
        'x-empty': undefined,
      },
    })
    // Headers combines repeated values per the HTTP spec — same header text
    // classification would see from a single comma-joined line.
    expect(req.headers.get('accept')).toBe('text/markdown, text/plain;q=0.8')
    expect(req.headers.has('x-empty')).toBe(false)
  })

  it('defaults method to GET and host to the fallback when absent', () => {
    const req = toWebRequest({ headers: {} }, { fallbackHost: 'store.internal' })
    expect(req.method).toBe('GET')
    expect(new URL(req.url).host).toBe('store.internal')
    expect(new URL(toWebRequest({ headers: {} }).url).host).toBe('localhost')
  })
})

describe('createGatewayMiddleware — markdown path', () => {
  it('serves markdown with core status/headers/body; next() is not called', async () => {
    const { res, nextCalls } = await run(config(), nodeRequest(PDP_PATH, CLAUDE_CODE_HEADERS))
    expect(nextCalls).toBe(0)
    expect(res.ended).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8')
    expect(res.headers['vary']).toBe('Accept')
    expect(res.headers['x-rebilder-path']).toBe('markdown')
    expect(res.body).toContain('Trail Runner 2')
    expect(res.body).toContain('$89.00')
  })

  it('classifies a repeated (array) Accept header carrying text/markdown as agent traffic', async () => {
    const { res, nextCalls } = await run(
      config(),
      nodeRequest(PDP_PATH, {
        accept: ['text/markdown', 'text/html;q=0.8'],
        'user-agent': CLAUDE_CODE_HEADERS['user-agent'],
      }),
    )
    expect(nextCalls).toBe(0)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('$89.00')
  })

  it('resolves sources against the https URL derived from x-forwarded-proto', async () => {
    const seen: URL[] = []
    const { res } = await run(
      config({
        sources: {
          product: (url) => {
            seen.push(url)
            return pathMatchedSources().product(url)
          },
        },
      }),
      nodeRequest(PDP_PATH, CLAUDE_CODE_HEADERS),
    )
    expect(res.statusCode).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.protocol).toBe('https:')
    expect(seen[0]!.host).toBe(STORE_HOST)
  })

  it('serves the identical body the web-standard core serves for the same request', async () => {
    const { res } = await run(config(), nodeRequest(PDP_PATH, CLAUDE_CODE_HEADERS))
    const webRes = await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), config())
    expect(res.body).toBe(await webRes!.text())
  })
})

describe('createGatewayMiddleware — pass-through and containment', () => {
  it('calls next() exactly once for a human browser; the response is left to the app', async () => {
    const { res, nextCalls } = await run(config(), nodeRequest(PDP_PATH, BROWSER_CHROME_HEADERS))
    expect(nextCalls).toBe(1)
    expect(res.ended).toBe(false)
    expect(res.body).toBeUndefined()
  })

  it('declares Vary: Accept on the pass-through, so a cache cannot mix the two', async () => {
    // This assertion used to read `expect(Object.keys(res.headers)).toHaveLength(0)`
    // — "res is untouched" — and untouched was the bug. The markdown path sets
    // `Vary: Accept`; the HTML path did not, so exactly one of the two
    // representations at a negotiated URL announced that it was negotiated, and
    // a shared cache could hand either one to the wrong requester.
    const { res } = await run(config(), nodeRequest(PDP_PATH, BROWSER_CHROME_HEADERS))
    // Lowercase: `Headers.forEach` normalises names, and HTTP header
    // names are case-insensitive anyway.
    expect(res.headers['vary']).toBe('Accept')
  })

  it('does not advertise an alternate the config cannot confirm', async () => {
    // `Vary` is a correctness header and is never under-declared. `Link:
    // rel="alternate"` is an advertisement and is never over-declared — a
    // config with no `match` router cannot say a URL has markdown without
    // running resolvers on every human request, so it says nothing.
    const { res } = await run(config(), nodeRequest(PDP_PATH, BROWSER_CHROME_HEADERS))
    expect(res.headers['link']).toBeUndefined()
  })

  it('calls next() for Googlebot even when it asks for markdown (consistent source content)', async () => {
    const { nextCalls, res } = await run(
      config(),
      nodeRequest(PDP_PATH, GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS),
    )
    expect(nextCalls).toBe(1)
    expect(res.ended).toBe(false)
  })

  it('calls next() for an agent URL no source matches', async () => {
    const { nextCalls } = await run(config(), nodeRequest('/no-such-page', CLAUDE_CODE_HEADERS))
    expect(nextCalls).toBe(1)
  })

  it('calls next() (never throws) when the matching source throws', async () => {
    const { nextCalls, res } = await run(
      config({
        sources: {
          product: () => {
            throw new Error('merchant bug')
          },
        },
      }),
      nodeRequest(PDP_PATH, CLAUDE_CODE_HEADERS),
    )
    expect(nextCalls).toBe(1)
    expect(res.ended).toBe(false)
  })

  it('calls next() when the request itself is unbuildable (malformed Host header)', async () => {
    // 'exa mple.com' makes `new URL()` throw inside toWebRequest — the
    // containment path, not handleRequest's. Never crash the merchant server.
    const { nextCalls, res } = await run(
      config(),
      nodeRequest(PDP_PATH, { ...CLAUDE_CODE_HEADERS, host: 'exa mple.com' }),
    )
    expect(nextCalls).toBe(1)
    expect(res.ended).toBe(false)
  })
})
