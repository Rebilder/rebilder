import { describe, expect, it } from 'vitest'
import type { CollectionSource } from '../src/index'
import { renderCollectionJsonLd, renderCollectionMarkdown } from '../src/index'
import { guideIndex, saasPlans } from './fixtures/documents'

/**
 * `CollectionSource` → schema.org ItemList.
 *
 * The interesting assertions here are the refusals: a name the merchant never
 * wrote, a link scheme the markdown path blocks, and a count that disagrees
 * with the list it labels are each a way for structured data to say something
 * the page does not.
 */

const listElements = (c: CollectionSource): Record<string, unknown>[] =>
  renderCollectionJsonLd(c).itemListElement as Record<string, unknown>[]

describe('renderCollectionJsonLd — shape', () => {
  it('renders an ItemList with one positioned ListItem per source item', () => {
    const ld = renderCollectionJsonLd(saasPlans)
    expect(ld['@context']).toBe('https://schema.org')
    expect(ld['@type']).toBe('ItemList')
    expect(ld.url).toBe('https://ledgerly.example.com/pricing')
    expect(ld.name).toBe('Plans')
    expect(ld.numberOfItems).toBe(3)
    expect(listElements(saasPlans)).toEqual([
      {
        '@type': 'ListItem',
        position: 1,
        url: 'https://ledgerly.example.com/pricing/free',
        name: 'Free',
      },
      {
        '@type': 'ListItem',
        position: 2,
        url: 'https://ledgerly.example.com/pricing/team',
        name: 'Team',
      },
      {
        '@type': 'ListItem',
        position: 3,
        url: 'https://ledgerly.example.com/pricing/enterprise',
        name: 'Enterprise',
      },
    ])
  })

  it('numbers positions from 1, as schema.org specifies', () => {
    expect(listElements(saasPlans).map((e) => e.position)).toEqual([1, 2, 3])
  })

  it('has stable key order', () => {
    expect(Object.keys(renderCollectionJsonLd(saasPlans))).toEqual([
      '@context',
      '@type',
      'url',
      'name',
      'numberOfItems',
      'itemListElement',
    ])
  })

  it('serializes without undefined and is deterministic', () => {
    const json = JSON.stringify(renderCollectionJsonLd(saasPlans))
    expect(json).not.toContain('undefined')
    expect(json).toBe(JSON.stringify(renderCollectionJsonLd(saasPlans)))
  })

  it('renders an empty listing as an ItemList with nothing in it', () => {
    // Not an error and not an omission: the page exists and lists nothing,
    // which is a different fact from "we could not read this page".
    const empty: CollectionSource = { url: 'https://ledgerly.example.com/guides', items: [] }
    const ld = renderCollectionJsonLd(empty)
    expect(ld.numberOfItems).toBe(0)
    expect(ld.itemListElement).toEqual([])
  })
})

describe('renderCollectionJsonLd — name is never invented', () => {
  it('omits name when the source has no title', () => {
    // renderCollectionMarkdown falls back to the fixed 'Contents' heading
    // because a markdown document needs a heading. JSON-LD does not, so the
    // fallback must not leak into it as an asserted name.
    expect('name' in renderCollectionJsonLd(guideIndex)).toBe(false)
    expect(renderCollectionMarkdown(guideIndex)).toContain(
      '# [Contents](https://ledgerly.example.com/guides)',
    )
  })

  it('emits the merchant’s title verbatim when there is one', () => {
    expect(renderCollectionJsonLd({ ...guideIndex, title: 'Guides' }).name).toBe('Guides')
  })
})

describe('renderCollectionJsonLd — URL allowlist', () => {
  const hostile: CollectionSource = {
    url: 'https://ledgerly.example.com/guides',
    items: [
      { url: 'javascript:alert(1)', title: 'Click me' },
      { url: 'data:text/html,<script>alert(1)</script>', title: 'Also me' },
      { url: 'not a url at all', title: 'Broken' },
      { url: 'https://ledgerly.example.com/guides/vat', title: 'Filing VAT' },
    ],
  }

  it('drops a rejected item URL but keeps the item and its name', () => {
    // The item exists on the page; we decline to publish a link to it. Dropping
    // the whole ListItem would misreport how long the listing is.
    const elements = listElements(hostile)
    expect(elements).toHaveLength(4)
    expect(elements.slice(0, 3).every((e) => !('url' in e))).toBe(true)
    expect(elements.map((e) => e.name)).toEqual(['Click me', 'Also me', 'Broken', 'Filing VAT'])
    expect(elements[3]!.url).toBe('https://ledgerly.example.com/guides/vat')
  })

  it('never emits a non-allowlisted scheme anywhere in the document', () => {
    const json = JSON.stringify(renderCollectionJsonLd(hostile))
    expect(json).not.toContain('javascript:')
    expect(json).not.toContain('data:text/html')
  })

  it('omits the listing’s own url when it is not allowlisted', () => {
    const ld = renderCollectionJsonLd({ ...hostile, url: 'javascript:alert(1)' })
    expect('url' in ld).toBe(false)
    expect(ld['@type']).toBe('ItemList')
  })
})

describe('renderCollectionJsonLd — truncation', () => {
  const many: CollectionSource = {
    url: 'https://ledgerly.example.com/guides',
    items: Array.from({ length: 640 }, (_unused, index) => ({
      url: `https://ledgerly.example.com/guides/${index + 1}`,
      title: `Guide ${index + 1}`,
    })),
  }

  it('caps the list at the same 500 rows the markdown table caps at', () => {
    expect(listElements(many)).toHaveLength(500)
  })

  it('counts what it emitted, not what it was given', () => {
    // An ItemList announcing 640 while listing 500 would send a paging agent
    // looking for 140 items that are not in the document.
    const ld = renderCollectionJsonLd(many)
    expect(ld.numberOfItems).toBe(500)
    expect((ld.itemListElement as unknown[]).length).toBe(ld.numberOfItems)
  })

  it('keeps the first items rather than an arbitrary window', () => {
    const elements = listElements(many)
    expect(elements[0]!.name).toBe('Guide 1')
    expect(elements[499]!.name).toBe('Guide 500')
  })
})

describe('renderCollectionJsonLd — freshness and language', () => {
  it('emits valid values verbatim', () => {
    const ld = renderCollectionJsonLd({
      ...saasPlans,
      updated: '2026-08-19T09:00:00Z',
      language: 'en-GB',
    })
    expect(ld.dateModified).toBe('2026-08-19T09:00:00Z')
    expect(ld.inLanguage).toBe('en-GB')
  })

  it('drops malformed values on the same terms as the product renderer', () => {
    const ld = renderCollectionJsonLd({
      ...saasPlans,
      updated: 'yesterday',
      language: 'British English',
    })
    expect('dateModified' in ld).toBe(false)
    expect('inLanguage' in ld).toBe(false)
  })

  it('places the optional keys without disturbing the required ones', () => {
    expect(
      Object.keys(renderCollectionJsonLd({ ...saasPlans, updated: '2026-08-19', language: 'en' })),
    ).toEqual([
      '@context',
      '@type',
      'url',
      'name',
      'inLanguage',
      'numberOfItems',
      'itemListElement',
      'dateModified',
    ])
  })
})

describe('renderCollectionJsonLd — agrees with the markdown it accompanies', () => {
  it('lists exactly the titles the markdown table lists', () => {
    // Same substance, two formats (consistent source content). A structured list that named
    // a different set of items than the visible table is precisely the
    // divergence ARS D2.4 exists to catch.
    const markdown = renderCollectionMarkdown(saasPlans)
    for (const element of listElements(saasPlans)) {
      expect(markdown).toContain(element.name as string)
    }
  })
})
