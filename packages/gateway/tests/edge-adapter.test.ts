import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatewayConfig } from '../src/index'
import { createGatewayFetchHandler } from '../src/adapters/edge/index'
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

const ORIGIN_HTML = new Response('<html>origin</html>', {
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createGatewayFetchHandler — markdown path', () => {
  it('serves the core markdown Response for an agent request to a wired source', async () => {
    const handler = createGatewayFetchHandler(config())
    const res = await handler(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('vary')).toBe('Accept')
    expect(res.headers.get('x-rebilder-path')).toBe('markdown')
    const body = await res.text()
    expect(body).toContain('Trail Runner 2')
    expect(body).toContain('$89.00')
  })

  it('never touches the network on the markdown path (no origin fetch)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ORIGIN_HTML.clone())
    vi.stubGlobal('fetch', fetchMock)
    const handler = createGatewayFetchHandler(config())
    const res = await handler(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS))
    expect(res.headers.get('x-rebilder-path')).toBe('markdown')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('createGatewayFetchHandler — fallback', () => {
  it('uses options.fallback for a human browser request', async () => {
    const fallback = vi.fn(async (req: Request) => {
      expect(req.url).toContain(PDP_PATH)
      return ORIGIN_HTML.clone()
    })
    const handler = createGatewayFetchHandler(config(), { fallback })
    const res = await handler(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS))
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(await res.text()).toBe('<html>origin</html>')
  })

  it('uses options.fallback for crawlers asking for markdown (consistent source content)', async () => {
    const fallback = vi.fn(async () => ORIGIN_HTML.clone())
    const handler = createGatewayFetchHandler(config(), { fallback })
    const res = await handler(makeRequest(PDP_PATH, GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS))
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })

  it('uses options.fallback for an agent URL no source matches', async () => {
    const fallback = vi.fn(async () => ORIGIN_HTML.clone())
    const handler = createGatewayFetchHandler(config(), { fallback })
    await handler(makeRequest('/no-such-page', CLAUDE_CODE_HEADERS))
    expect(fallback).toHaveBeenCalledTimes(1)
  })
})

describe('createGatewayFetchHandler — origin pass-through (no fallback)', () => {
  it('forwards the SAME request to the origin via global fetch (CF reverse-proxy pattern)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ORIGIN_HTML.clone())
    vi.stubGlobal('fetch', fetchMock)
    const req = makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS)
    const handler = createGatewayFetchHandler(config())
    const res = await handler(req)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(req) // the unmodified Request object
    expect(await res.text()).toBe('<html>origin</html>')
  })

  it('passes a throwing source through to the origin, never a 500', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ORIGIN_HTML.clone())
    vi.stubGlobal('fetch', fetchMock)
    const handler = createGatewayFetchHandler(
      config({
        sources: {
          product: () => {
            throw new Error('merchant bug')
          },
        },
      }),
    )
    const res = await handler(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS))
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
