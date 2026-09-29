import { describe, expect, it } from 'vitest'
import { renderCatalogMarkdown, renderPolicyMarkdown, renderProductMarkdown } from '../src/index'
import { catalog, minimalProduct, pdp, policies } from './fixtures/pdp'

const byteLength = (s: string): number => new TextEncoder().encode(s).length

describe('front-loading', () => {
  const lines = renderProductMarkdown(pdp).split('\n')

  it('price appears in the first 10 lines', () => {
    expect(lines.slice(0, 10).join('\n')).toContain('$89.00')
  })

  it('availability appears in the first 10 lines', () => {
    expect(lines.slice(0, 10).join('\n')).toContain('**Availability:** In stock')
  })

  it('shipping and returns appear in the first 15 lines', () => {
    const head = lines.slice(0, 15).join('\n')
    expect(head).toContain('**Shipping:**')
    expect(head).toContain('**Returns:**')
  })

  it('facts precede the variants table, which precedes the description', () => {
    const out = renderProductMarkdown(pdp)
    const price = out.indexOf('**Price:**')
    const variants = out.indexOf('## Variants')
    const description = out.indexOf('## Description')
    expect(price).toBeGreaterThan(-1)
    expect(variants).toBeGreaterThan(price)
    expect(description).toBeGreaterThan(variants)
  })
})

describe('product markdown structure', () => {
  const out = renderProductMarkdown(pdp)

  it('links the title to the canonical product URL', () => {
    expect(out.split('\n')[0]).toBe(
      '# [Trail Runner 2](https://store.example.com/products/trail-runner-2)',
    )
  })

  it('renders a variants table with id/title/options/price/availability', () => {
    expect(out).toContain('| ID | Title | Options | Price | Availability |')
    expect(out).toContain('| v-8 | Size 8 | size: 8 | $89.00 | In stock |')
    expect(out).toContain('| v-10 | Size 10 | size: 10 | $94.00 | Out of stock |')
  })

  it('renders attributes verbatim', () => {
    expect(out).toContain('- **Material:** Recycled mesh upper')
    expect(out).toContain('- **Weight:** 280 g (size 9)')
  })

  it('renders images as markdown links (alt text when present, URL otherwise)', () => {
    expect(out).toContain('- [Trail Runner 2, side view](https://cdn.example.com/tr2-hero.jpg)')
    expect(out).toContain('- [https://cdn.example.com/tr2-sole.jpg](https://cdn.example.com/tr2-sole.jpg)')
  })

  it('contains no HTML tags of its own making', () => {
    expect(out).not.toMatch(/<[a-z][a-z0-9-]*[\s>]/i)
  })

  it('respects headingLevel', () => {
    const nested = renderProductMarkdown(pdp, { headingLevel: 2 })
    expect(nested.startsWith('## [Trail Runner 2]')).toBe(true)
    expect(nested).toContain('### Variants')
  })
})

describe('empty optional fields', () => {
  const out = renderProductMarkdown(minimalProduct)

  it('renders nothing for absent optionals — no "undefined", no empty sections', () => {
    expect(out).not.toContain('undefined')
    expect(out).not.toContain('Brand')
    expect(out).not.toContain('Shipping')
    expect(out).not.toContain('Returns')
    expect(out).not.toContain('Variants')
    expect(out).not.toContain('Description')
    expect(out).not.toContain('Details')
    expect(out).not.toContain('Images')
  })

  it('still front-loads the facts that do exist', () => {
    const lines = out.split('\n')
    expect(lines[0]).toBe('# [Basic Tee](https://store.example.com/products/basic)')
    expect(out).toContain('- **Price:** $19.00')
    expect(out).toContain('- **Availability:** Preorder')
  })
})

describe('renderPolicyMarkdown', () => {
  it('renders each policy as a linked heading with the body verbatim, in order', () => {
    const out = renderPolicyMarkdown(policies)
    for (const pol of policies) {
      expect(out).toContain(`# [${pol.title}](${pol.url})`)
      expect(out).toContain(pol.body)
    }
    expect(out.indexOf('Shipping Policy')).toBeLessThan(out.indexOf('Returns Policy'))
    expect(out.indexOf('Returns Policy')).toBeLessThan(out.indexOf('Privacy Policy'))
  })

  it('truncates whole policies from the bottom under a byte budget', () => {
    const first = policies[0]!
    const out = renderPolicyMarkdown(policies, { maxBytes: 300 })
    expect(byteLength(out)).toBeLessThanOrEqual(300)
    expect(out).toContain(first.body) // first policy intact, byte-for-byte
    expect(out).not.toContain(policies[2]!.body)
    expect(out).toMatch(/truncated/i)
  })

  it('never renders a partial policy body', () => {
    const out = renderPolicyMarkdown(policies, { maxBytes: 400 })
    for (const pol of policies) {
      const headingPresent = out.includes(`[${pol.title}](${pol.url})`)
      const bodyPresent = out.includes(pol.body)
      const bodyPrefixPresent = out.includes(pol.body.slice(0, 40))
      // Either the whole body is there, or none of it is (title-only is fine).
      expect(bodyPresent || !bodyPrefixPresent || !headingPresent).toBe(true)
      if (!bodyPresent) expect(bodyPrefixPresent).toBe(false)
    }
  })
})

describe('renderCatalogMarkdown', () => {
  it('renders a table with linked titles, prices, and availability', () => {
    const out = renderCatalogMarkdown(catalog)
    expect(out).toContain('| Title | Price | Availability |')
    expect(out).toContain(
      '| [Trail Runner 2](https://store.example.com/products/trail-runner-2) | $89.00 | In stock |',
    )
    expect(out).toContain(
      '| [Wool Socks (3-pack)](https://store.example.com/products/wool-socks) | $24.00 | Backorder |',
    )
  })

  it('drops whole rows from the bottom under a byte budget', () => {
    const out = renderCatalogMarkdown(catalog, { maxBytes: 220 })
    expect(byteLength(out)).toBeLessThanOrEqual(220)
    expect(out).toContain('| Title | Price | Availability |')
    expect(out).toContain('Trail Runner 2') // first row survives
    expect(out).not.toContain('Wool Socks') // last row dropped
    expect(out).toMatch(/truncated/i)
  })
})
