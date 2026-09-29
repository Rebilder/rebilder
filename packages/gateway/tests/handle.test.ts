import { describe, expect, it } from 'vitest'
import { handleRequest, type GatewayConfig } from '../src/index'
import {
  BROWSER_CHROME_HEADERS,
  CATALOG_PATH,
  CHATGPT_USER_HEADERS,
  CLAUDE_CODE_HEADERS,
  GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS,
  PDP_PATH,
  POLICY_PATH,
  PROTOCOL_CLIENT_HEADERS,
  catalog,
  makeRequest,
  pathMatchedSources,
  policies,
  product,
} from './fixtures'

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { storeId: 'store_test', sources: pathMatchedSources(), ...overrides }
}

describe('handleRequest — markdown path', () => {
  it('serves a product markdown response to a markdown-accepting agent', async () => {
    const res = await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), config())
    expect(res).toBeInstanceOf(Response)
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res?.headers.get('vary')).toBe('Accept')
    expect(res?.headers.get('x-rebilder-path')).toBe('markdown')

    const body = await res!.text()
    expect(body).toContain('Trail Runner 2')
    expect(body).toContain('$89.00') // injected price, verbatim from source
    expect(body).toContain('In stock')
    expect(new TextEncoder().encode(body).length).toBeLessThan(5 * 1024)
  })

  it('serves markdown to an identified agent platform without a markdown Accept', async () => {
    const res = await handleRequest(makeRequest(PDP_PATH, CHATGPT_USER_HEADERS), config())
    expect(res).toBeInstanceOf(Response)
    expect(await res!.text()).toContain('$89.00')
  })

  it('resolves product first when multiple sources would match (product wins)', async () => {
    const greedy: GatewayConfig = config({
      sources: {
        product: () => product,
        policies: () => policies,
        catalog: () => catalog,
      },
    })
    const res = await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), greedy)
    const body = await res!.text()
    expect(body).toContain('Trail Runner 2')
    expect(body).not.toContain('Shipping policy') // policies did not render
  })

  it('falls back to policies when product does not match', async () => {
    const res = await handleRequest(makeRequest(POLICY_PATH, CLAUDE_CODE_HEADERS), config())
    const body = await res!.text()
    expect(body).toContain('Shipping policy')
    expect(body).toContain('Orders ship within 2 business days.')
  })

  it('falls back to catalog when product and policies do not match', async () => {
    const res = await handleRequest(makeRequest(CATALOG_PATH, CLAUDE_CODE_HEADERS), config())
    const body = await res!.text()
    expect(body).toContain('Ridge Hiker')
    expect(body).toContain('$149.00')
  })

  it('supports async sources', async () => {
    const asyncConfig = config({
      sources: { product: async (url) => (url.pathname === PDP_PATH ? product : null) },
    })
    const res = await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), asyncConfig)
    expect(await res!.text()).toContain('$89.00')
  })

  it('honors the maxBytes budget', async () => {
    const res = await handleRequest(
      makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS),
      config({ maxBytes: 700 }),
    )
    const body = await res!.text()
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(700)
    expect(body).toContain('$89.00') // front-loaded facts survive truncation
  })
})

describe('handleRequest — pass-throughs (null)', () => {
  it('returns null for a human browser', async () => {
    expect(await handleRequest(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS), config())).toBeNull()
  })

  it('returns null for a crawler even with Accept: text/markdown (consistent source content)', async () => {
    expect(
      await handleRequest(makeRequest(PDP_PATH, GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS), config()),
    ).toBeNull()
  })

  it('returns null on protocol routes in Phase 0', async () => {
    expect(await handleRequest(makeRequest('/mcp', PROTOCOL_CLIENT_HEADERS), config())).toBeNull()
    expect(
      await handleRequest(makeRequest('/.well-known/ucp', PROTOCOL_CLIENT_HEADERS), config()),
    ).toBeNull()
  })

  it('returns null when no source matches the URL', async () => {
    expect(await handleRequest(makeRequest('/about-us', CLAUDE_CODE_HEADERS), config())).toBeNull()
  })

  it('returns null when no sources are configured at all', async () => {
    expect(
      await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), config({ sources: {} })),
    ).toBeNull()
  })

  it('returns null when the matching source returns null', async () => {
    expect(
      await handleRequest(
        makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS),
        config({ sources: { product: () => null } }),
      ),
    ).toBeNull()
  })

  it('treats an empty policies/catalog array as no match', async () => {
    expect(
      await handleRequest(
        makeRequest(POLICY_PATH, CLAUDE_CODE_HEADERS),
        config({ sources: { policies: () => [], catalog: () => [] } }),
      ),
    ).toBeNull()
  })
})

describe('handleRequest — failure containment', () => {
  it('a source that throws synchronously never breaks the site (returns null)', async () => {
    const throwing = config({
      sources: {
        product: () => {
          throw new Error('merchant bug')
        },
      },
    })
    await expect(
      handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), throwing),
    ).resolves.toBeNull()
  })

  it('a source that rejects never breaks the site and leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', listener)
    try {
      const rejecting = config({
        sources: { product: () => Promise.reject(new Error('async merchant bug')) },
      })
      await expect(
        handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), rejecting),
      ).resolves.toBeNull()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', listener)
    }
  })

  it('continues to the next source when a higher-precedence source throws', async () => {
    const mixed = config({
      sources: {
        product: () => {
          throw new Error('product resolver down')
        },
        policies: (url) => (url.pathname === POLICY_PATH ? policies : null),
      },
    })
    const res = await handleRequest(makeRequest(POLICY_PATH, CLAUDE_CODE_HEADERS), mixed)
    expect(await res!.text()).toContain('Shipping policy')
  })

  it('passes through (null) when the renderer itself rejects the source data', async () => {
    // render-md throws on non-integer minor units rather than rounding a
    // price; the gateway must contain that too.
    const badMoney = config({
      sources: { product: () => ({ ...product, price: { amount: 89.5, currency: 'USD' } }) },
    })
    await expect(
      handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), badMoney),
    ).resolves.toBeNull()
  })
})
