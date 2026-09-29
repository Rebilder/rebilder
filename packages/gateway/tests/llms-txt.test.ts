import { describe, expect, it } from 'vitest'
import { generateLlmsTxt, type GatewayConfig, type LlmsTxtOptions } from '../src/index'
import { createLlmsTxtRouteHandler } from '../src/adapters/next/index'
import {
  BROWSER_CHROME_HEADERS,
  STORE_ORIGIN,
  catalog,
  makeRequest,
  pathMatchedSources,
  policies,
  product,
} from './fixtures'

const BASE_OPTIONS: LlmsTxtOptions = {
  baseUrl: STORE_ORIGIN,
  siteName: 'Acme Outdoors',
  description: 'Trail footwear and gear, shipped from Bend, OR.',
}

/**
 * Site-wide enumerating sources, the wiring llms.txt generation expects: for
 * the base URL they return the whole catalog / policy list (the path-matched
 * sources used elsewhere return null for '/', which is ALSO a valid — empty —
 * wiring; see the tolerance tests).
 */
function enumeratingSources() {
  return {
    ...pathMatchedSources(),
    policies: () => policies,
    catalog: () => catalog,
  }
}

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { storeId: 'store_test', sources: enumeratingSources(), ...overrides }
}

describe('generateLlmsTxt — shape', () => {
  it('renders H1 site name, blockquote description, and auto sections', async () => {
    const txt = await generateLlmsTxt(config(), BASE_OPTIONS)
    const lines = txt.split('\n')
    expect(lines[0]).toBe('# Acme Outdoors')
    expect(lines[1]).toBe('')
    expect(lines[2]).toBe('> Trail footwear and gear, shipped from Bend, OR.')
    expect(txt).toContain('\n## Products\n')
    expect(txt).toContain('\n## Policies\n')
    expect(txt.endsWith('\n')).toBe(true)
  })

  it('lists catalog entries as links with injected price notes', async () => {
    const txt = await generateLlmsTxt(config(), BASE_OPTIONS)
    expect(txt).toContain(`- [Trail Runner 2](${product.url}): $89.00`)
    expect(txt).toContain(`- [Ridge Hiker](${STORE_ORIGIN}/products/ridge-hiker): $149.00`)
  })

  it('lists policy entries as plain links (no note)', async () => {
    const txt = await generateLlmsTxt(config(), BASE_OPTIONS)
    expect(txt).toContain(`- [Shipping policy](${STORE_ORIGIN}/policies/shipping)`)
    expect(txt).not.toContain(`- [Shipping policy](${STORE_ORIGIN}/policies/shipping):`)
  })

  it('calls enumerating sources with new URL(baseUrl)', async () => {
    const seen: URL[] = []
    await generateLlmsTxt(
      config({
        sources: {
          catalog: (url) => {
            seen.push(url)
            return catalog
          },
          policies: (url) => {
            seen.push(url)
            return policies
          },
        },
      }),
      BASE_OPTIONS,
    )
    expect(seen).toHaveLength(2)
    expect(seen.map((u) => u.href)).toEqual([`${STORE_ORIGIN}/`, `${STORE_ORIGIN}/`])
  })
})

describe('generateLlmsTxt — determinism and ordering', () => {
  it('is deterministic: same config + options → byte-identical output', async () => {
    const a = await generateLlmsTxt(config(), BASE_OPTIONS)
    const b = await generateLlmsTxt(config(), BASE_OPTIONS)
    expect(b).toBe(a)
  })

  it('orders sections: Products, Policies, then manual sections in given order', async () => {
    const txt = await generateLlmsTxt(config(), {
      ...BASE_OPTIONS,
      sections: [
        { title: 'Guides', links: [{ title: 'Sizing guide', url: `${STORE_ORIGIN}/pages/sizing` }] },
        {
          title: 'About',
          links: [{ title: 'Our story', url: `${STORE_ORIGIN}/pages/about`, note: 'Since 2019' }],
        },
      ],
    })
    const order = ['## Products', '## Policies', '## Guides', '## About'].map((h) =>
      txt.indexOf(h),
    )
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((x, y) => x - y)).toEqual(order)
    expect(txt).toContain(`- [Our story](${STORE_ORIGIN}/pages/about): Since 2019`)
  })

  it('omits a manual section with no links', async () => {
    const txt = await generateLlmsTxt(config(), {
      ...BASE_OPTIONS,
      sections: [{ title: 'Empty', links: [] }],
    })
    expect(txt).not.toContain('## Empty')
  })
})

describe('generateLlmsTxt — source tolerance', () => {
  it('handles unconfigured sources: header + manual sections only', async () => {
    const txt = await generateLlmsTxt(config({ sources: {} }), {
      ...BASE_OPTIONS,
      sections: [{ title: 'Docs', links: [{ title: 'FAQ', url: `${STORE_ORIGIN}/pages/faq` }] }],
    })
    expect(txt).toContain('# Acme Outdoors')
    expect(txt).not.toContain('## Products')
    expect(txt).not.toContain('## Policies')
    expect(txt).toContain('## Docs')
  })

  it('handles sources returning null for the base URL (no auto sections)', async () => {
    // The plain path-matched wiring returns null for '/'.
    const txt = await generateLlmsTxt(config({ sources: pathMatchedSources() }), BASE_OPTIONS)
    expect(txt).toBe('# Acme Outdoors\n\n> Trail footwear and gear, shipped from Bend, OR.\n')
  })

  it('handles a throwing source gracefully (never rejects)', async () => {
    const txt = await generateLlmsTxt(
      config({
        sources: {
          catalog: () => {
            throw new Error('merchant bug')
          },
          policies: () => Promise.reject(new Error('async merchant bug')),
        },
      }),
      BASE_OPTIONS,
    )
    expect(txt).toContain('# Acme Outdoors')
    expect(txt).not.toContain('## Products')
    expect(txt).not.toContain('## Policies')
  })

  it('treats empty catalog/policies arrays as nothing to list', async () => {
    const txt = await generateLlmsTxt(
      config({ sources: { catalog: () => [], policies: () => [] } }),
      BASE_OPTIONS,
    )
    expect(txt).not.toContain('## Products')
    expect(txt).not.toContain('## Policies')
  })

  it('omits the price note (never a wrong value) for a malformed price', async () => {
    const txt = await generateLlmsTxt(
      config({
        sources: {
          catalog: () => [
            { ...catalog[0]!, price: { amount: 89.5, currency: 'USD' } },
            catalog[1]!,
          ],
        },
      }),
      BASE_OPTIONS,
    )
    expect(txt).toContain(`- [Trail Runner 2](${product.url})\n`)
    expect(txt).not.toContain('89.5')
    expect(txt).toContain(': $149.00') // well-formed sibling keeps its note
  })
})

describe('createLlmsTxtRouteHandler', () => {
  it('serves text/plain with long shared-cache headers', async () => {
    const handler = createLlmsTxtRouteHandler(config(), BASE_OPTIONS)
    const res = await handler(makeRequest('/llms.txt', BROWSER_CHROME_HEADERS))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('cache-control')).toContain('s-maxage=3600')
  })

  it('body is exactly the generateLlmsTxt output', async () => {
    const handler = createLlmsTxtRouteHandler(config(), BASE_OPTIONS)
    const res = await handler(makeRequest('/llms.txt', BROWSER_CHROME_HEADERS))
    expect(await res.text()).toBe(await generateLlmsTxt(config(), BASE_OPTIONS))
  })
})
