import { describe, expect, it } from 'vitest'
import type { Availability, ProductSource } from '../src/index'
import { renderProductJsonLd, renderProductMarkdown } from '../src/index'
import { UPDATED_LABEL } from '../src/documents/facts'
import { minimalProduct, pdp } from './fixtures/pdp'

describe('renderProductJsonLd', () => {
  it('maps every availability value to its schema.org URL', () => {
    const cases: [Availability, string][] = [
      ['in_stock', 'https://schema.org/InStock'],
      ['out_of_stock', 'https://schema.org/OutOfStock'],
      ['preorder', 'https://schema.org/PreOrder'],
      ['backorder', 'https://schema.org/BackOrder'],
    ]
    for (const [availability, url] of cases) {
      const ld = renderProductJsonLd({ ...minimalProduct, availability })
      const offers = ld.offers as Record<string, unknown>
      expect(offers.availability).toBe(url)
    }
  })

  it('renders price as a decimal string with the source currency', () => {
    const ld = renderProductJsonLd(minimalProduct)
    const offers = ld.offers as Record<string, unknown>
    expect(offers.price).toBe('19.00')
    expect(offers.priceCurrency).toBe('USD')
  })

  it('handles zero-decimal currencies in the offer price', () => {
    const jpy: ProductSource = {
      ...minimalProduct,
      price: { amount: 4900, currency: 'JPY' },
    }
    const offers = renderProductJsonLd(jpy).offers as Record<string, unknown>
    expect(offers.price).toBe('4900')
    expect(offers.priceCurrency).toBe('JPY')
  })

  it('emits one offer per variant when variants exist', () => {
    const ld = renderProductJsonLd(pdp)
    const offers = ld.offers as Record<string, unknown>[]
    expect(Array.isArray(offers)).toBe(true)
    expect(offers).toHaveLength(3)
    expect(offers[0]).toEqual({
      '@type': 'Offer',
      price: '89.00',
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      sku: 'TR2-8',
      name: 'Size 8',
    })
    expect(offers[2]!.price).toBe('94.00')
    expect(offers[2]!.availability).toBe('https://schema.org/OutOfStock')
  })

  it('includes brand and image list only when present in source', () => {
    const full = renderProductJsonLd(pdp)
    expect(full.brand).toEqual({ '@type': 'Brand', name: 'Acme Outdoors' })
    expect(full.image).toEqual([
      'https://cdn.example.com/tr2-hero.jpg',
      'https://cdn.example.com/tr2-sole.jpg',
    ])

    const minimal = renderProductJsonLd(minimalProduct)
    expect('brand' in minimal).toBe(false)
    expect('image' in minimal).toBe(false)
    expect('description' in minimal).toBe(false)
  })

  it('has stable key order (snapshot-friendly)', () => {
    expect(Object.keys(renderProductJsonLd(minimalProduct))).toEqual([
      '@context',
      '@type',
      'name',
      'url',
      'offers',
    ])
    expect(Object.keys(renderProductJsonLd(pdp))).toEqual([
      '@context',
      '@type',
      'name',
      'url',
      'brand',
      'description',
      'image',
      'offers',
    ])
  })

  it('serializes without any undefined values', () => {
    expect(JSON.stringify(renderProductJsonLd(pdp))).not.toContain('undefined')
    expect(JSON.stringify(renderProductJsonLd(minimalProduct))).not.toContain('undefined')
  })

  it('is deterministic: same input, same serialized output', () => {
    expect(JSON.stringify(renderProductJsonLd(pdp))).toBe(JSON.stringify(renderProductJsonLd(pdp)))
  })
})

/* ------------------------------------------------------------------ *
 * Freshness and language.
 *
 * Both are gates, never transforms: a value that passes is emitted exactly as
 * supplied, and a value that fails is dropped. The rejection cases matter more
 * than the acceptance ones — this renderer feeds /acp/v0/feed, so a malformed
 * value that slipped through would be published as an authoritative fact about
 * the merchant's catalog.
 * ------------------------------------------------------------------ */

describe('renderProductJsonLd — dateModified', () => {
  const withDate = (updated: string): Record<string, unknown> =>
    renderProductJsonLd({ ...minimalProduct, updated })

  it('emits a valid ISO date verbatim', () => {
    expect(withDate('2026-08-19').dateModified).toBe('2026-08-19')
  })

  it('emits a valid ISO datetime verbatim, offset and all', () => {
    expect(withDate('2026-08-19T14:30:00+01:00').dateModified).toBe('2026-08-19T14:30:00+01:00')
    expect(withDate('2026-08-19T14:30:00Z').dateModified).toBe('2026-08-19T14:30:00Z')
  })

  it('omits the key entirely when the source has no updated value', () => {
    expect('dateModified' in renderProductJsonLd(minimalProduct)).toBe(false)
  })

  it.each([
    ['a non-date string', 'last Tuesday'],
    ['US ordering', '08/19/2026'],
    ['a month that does not exist', '2026-13-01'],
    ['a day above 31', '2026-01-32'],
    ['an empty string', ''],
    ['a year alone', '2026'],
  ])('drops %s rather than repairing it', (_label, value) => {
    expect('dateModified' in withDate(value)).toBe(false)
  })

  // `Date.parse` rolls these three forward instead of rejecting them
  // (2026-02-31 → March 3), so a bare parse check passed dates that do not
  // exist and the renderer emitted them verbatim. See internal/validate.ts.
  it.each([
    ['a day past the end of February', '2026-02-31'],
    ['February 29 in a non-leap year', '2026-02-29'],
    ['a 31st in a 30-day month', '2026-04-31'],
  ])('drops %s, which Date.parse alone accepts', (_label, value) => {
    expect('dateModified' in withDate(value)).toBe(false)
  })

  it('still accepts February 29 in an actual leap year', () => {
    // The calendar check must reject impossible dates without rejecting hard
    // ones — a leap day is a real date and dropping it would be a new bug.
    expect(withDate('2024-02-29').dateModified).toBe('2024-02-29')
  })
})

describe('renderProductJsonLd — inLanguage', () => {
  const withLanguage = (language: string): Record<string, unknown> =>
    renderProductJsonLd({ ...minimalProduct, language })

  it.each([
    ['language only', 'en'],
    ['three-letter language', 'haw'],
    ['language and region', 'pt-BR'],
    ['language and script', 'zh-Hant'],
    ['language, script and region', 'zh-Hant-TW'],
    ['a numeric region', 'es-419'],
  ])('emits %s verbatim', (_label, value) => {
    expect(withLanguage(value).inLanguage).toBe(value)
  })

  it('preserves the merchant’s casing rather than canonicalising it', () => {
    // BCP 47 is case-insensitive, so `EN-us` is a valid tag. Re-casing it would
    // make our JSON-LD disagree with the merchant's own <html lang> for no
    // reason a reader could see.
    expect(withLanguage('EN-us').inLanguage).toBe('EN-us')
  })

  it('omits the key entirely when the source has no language', () => {
    expect('inLanguage' in renderProductJsonLd(minimalProduct)).toBe(false)
  })

  it.each([
    ['a display name', 'English'],
    ['an underscore separator', 'en_US'],
    ['a trailing separator', 'en-'],
    ['a four-letter language', 'engl'],
    ['an empty string', ''],
    ['a sentence', 'en, fr'],
  ])('drops %s rather than guessing at it', (_label, value) => {
    expect('inLanguage' in withLanguage(value)).toBe(false)
  })
})

describe('renderProductJsonLd — key order with the new fields', () => {
  it('appends dateModified after offers and keeps inLanguage before it', () => {
    const full: ProductSource = {
      ...minimalProduct,
      language: 'en-GB',
      updated: '2026-08-19',
    }
    // The buying facts keep the positions they have always had; a feed diff
    // shows two appended keys, not every offer key shifted.
    expect(Object.keys(renderProductJsonLd(full))).toEqual([
      '@context',
      '@type',
      'name',
      'url',
      'inLanguage',
      'offers',
      'dateModified',
    ])
  })

  it('still serializes without undefined and stays deterministic', () => {
    const full: ProductSource = { ...pdp, language: 'en', updated: '2026-08-19T00:00:00Z' }
    expect(JSON.stringify(renderProductJsonLd(full))).not.toContain('undefined')
    expect(JSON.stringify(renderProductJsonLd(full))).toBe(
      JSON.stringify(renderProductJsonLd(full)),
    )
  })
})

describe('markdown and JSON-LD agree about freshness', () => {
  it('renders the same date in both representations (consistent source content)', () => {
    const p: ProductSource = { ...minimalProduct, updated: '2026-08-19' }
    expect(renderProductJsonLd(p).dateModified).toBe('2026-08-19')
    expect(renderProductMarkdown(p)).toContain('- **Updated:** 2026-08-19')
  })

  it('drops the fact from BOTH representations when it is malformed', () => {
    // A value that is good enough for one representation and not the other is
    // a substance difference by format, which is the thing this package exists
    // to make impossible.
    const p: ProductSource = { ...minimalProduct, updated: 'last Tuesday' }
    expect('dateModified' in renderProductJsonLd(p)).toBe(false)
    expect(renderProductMarkdown(p)).not.toContain('Updated')
  })

  it('uses the same label the document renderer uses', () => {
    // Two spellings of "Updated" across the two renderers would make the fact
    // unextractable by a single rule, which is the whole point of a fixed label.
    const p: ProductSource = { ...minimalProduct, updated: '2026-08-19' }
    expect(renderProductMarkdown(p)).toContain(`- **${UPDATED_LABEL}:** 2026-08-19`)
  })
})
