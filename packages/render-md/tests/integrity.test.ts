import { describe, expect, it } from 'vitest'
import type { ProductSource } from '../src/index'
import { formatMoney, renderProductMarkdown } from '../src/index'
import { pdp } from './fixtures/pdp'

/**
 * Injected-field integrity — the validator-style test required by the
 * Definition of Done. Scans the rendered output for anything price-like and
 * asserts every such token traces back to the source object, either as a
 * formatted structured price or as verbatim merchant text. The renderer must
 * never introduce a price the source does not contain (source validation).
 */

// Price-like token: a known currency symbol, or an all-caps ISO-style code,
// directly prefixing digits (with optional grouping/decimals).
const CURRENCY_TOKEN = /(?:[$€£¥]\s?|\b[A-Z]{3} )\d[\d,]*(?:\.\d+)?/g

function currencyTokens(text: string): string[] {
  return text.match(CURRENCY_TOKEN) ?? []
}

/** Every price-like token that legitimately derives from the source. */
function allowedTokensFor(p: ProductSource): Set<string> {
  const allowed = new Set<string>()
  // Structured money fields → their deterministic formatted form.
  const monies = [
    p.price,
    p.compareAtPrice,
    p.shipping?.freeThreshold,
    ...(p.variants ?? []).map((v) => v.price),
  ]
  for (const m of monies) {
    if (m !== undefined) allowed.add(formatMoney(m))
  }
  // Verbatim source text may itself contain price tokens; those are allowed.
  const verbatim = [
    p.title,
    p.brand,
    p.description,
    p.shipping?.summary,
    p.returns?.summary,
    ...Object.entries(p.attributes ?? {}).flat(),
    ...(p.variants ?? []).flatMap((v) => [v.title, ...Object.entries(v.options ?? {}).flat()]),
    ...(p.images ?? []).flatMap((img) => [img.url, img.alt]),
  ]
    .filter((t): t is string => typeof t === 'string')
    .join('\n')
  for (const token of currencyTokens(verbatim)) allowed.add(token)
  return allowed
}

describe('injected-field integrity (validator)', () => {
  const out = renderProductMarkdown(pdp)
  const allowed = allowedTokensFor(pdp)

  it('renders the exact source price string', () => {
    expect(out).toContain('$89.00')
    expect(out).toContain('**Price:** ~~$120.00~~ $89.00')
  })

  it('renders the exact availability from source', () => {
    expect(out).toContain('**Availability:** In stock')
  })

  it('renders shipping and returns summaries verbatim', () => {
    expect(out).toContain('Free standard shipping on orders over $50. Standard shipping is $5.95.')
    expect(out).toContain('30-day returns on unworn shoes in original packaging.')
  })

  it('contains no price-like token that does not derive from the source', () => {
    const found = currencyTokens(out)
    expect(found.length).toBeGreaterThan(0)
    const foreign = found.filter((token) => !allowed.has(token))
    expect(foreign).toEqual([])
  })

  it('the validator itself catches a foreign price token', () => {
    // Sanity check that the scan has teeth: a price not present in the source
    // must be flagged.
    const tampered = `${out}\n\n- **Price:** $9.99`
    const foreign = currencyTokens(tampered).filter((token) => !allowed.has(token))
    expect(foreign).toEqual(['$9.99'])
  })

  it('is deterministic: same input, same output', () => {
    expect(renderProductMarkdown(pdp)).toBe(out)
  })
})
