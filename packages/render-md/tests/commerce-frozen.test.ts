/**
 * The commerce backward-compatibility freeze.
 *
 * Every byte the three commerce renderers emit today is pinned here as an
 * inline string literal, and every later change to this package is checked
 * against this file. Merchants' agent-facing pages are already served from
 * these renderers; a silent diff here is a silent diff in production output.
 *
 * WHY INLINE LITERALS AND NOT `toMatchSnapshot()`:
 * `vitest -u` can silently regenerate a snapshot — a refactor that changes
 * output "passes" the moment someone runs the update flag, and the diff lands
 * in `__snapshots__/*.snap` where it reads as test noise rather than a
 * behaviour change. It cannot regenerate a string literal. Changing anything
 * asserted here requires editing the expectation by hand, in the same diff as
 * the code change, where a reviewer sees the before and after side by side.
 * This file is a tripwire, not a convenience. `tests/snapshot.test.ts` keeps
 * its snapshots for readable full-document review; this file is the contract.
 *
 * DO NOT relax an assertion here to make a change pass. If output must change,
 * change the literal deliberately and say so in the PR.
 *
 * Coverage beyond `tests/snapshot.test.ts` and `tests/budget.test.ts`:
 * `byteLength` of every frozen output, and truncation boundaries for
 * `renderPolicyMarkdown` AND `renderCatalogMarkdown` — today's budget test
 * only exercises `renderProductMarkdown`, so the two other truncation
 * algorithms (whole-policy-then-degrade-to-title, whole-row-drop) had no
 * boundary coverage at all.
 *
 * Boundary values are exact byte counts, not round numbers: each pair asserts
 * the largest budget at which a block still fits and the budget one byte below
 * it, which is where an off-by-one in the budget arithmetic shows up.
 */

import { describe, expect, it } from 'vitest'
import type { ProductSource } from '../src/index'
import { renderCatalogMarkdown, renderPolicyMarkdown, renderProductMarkdown } from '../src/index'
import { catalog, minimalProduct, pdp, policies } from './fixtures/pdp'

const byteLength = (s: string): number => new TextEncoder().encode(s).length

/** The fixed note appended on truncation. Frozen verbatim: agents parse it. */
const TRUNCATION_NOTE = '*Truncated to fit size budget; remaining content omitted.*'

/**
 * Heading-clamp fixture. Defined here rather than added to
 * `tests/fixtures/pdp.ts` because that file is shared with the other test
 * suites. The single variant deliberately omits `options` so the empty
 * options cell (`|  |`, two spaces) is frozen too.
 */
const headingFixture: ProductSource = {
  url: 'https://store.example.com/products/clamp',
  title: 'Clamp Test',
  price: { amount: 1000, currency: 'USD' },
  availability: 'in_stock',
  variants: [
    { id: 'v-1', title: 'One', price: { amount: 1000, currency: 'USD' }, availability: 'backorder' },
  ],
}

// ---------------------------------------------------------------------------
// Frozen full outputs
// ---------------------------------------------------------------------------

const PDP_MARKDOWN = [
  '# [Trail Runner 2](https://store.example.com/products/trail-runner-2)',
  '',
  '- **Brand:** Acme Outdoors',
  '- **Price:** ~~$120.00~~ $89.00',
  '- **Availability:** In stock',
  '- **Shipping:** Free standard shipping on orders over $50. Standard shipping is $5.95.',
  '  - Free shipping threshold: $50.00',
  '  - Ships to: US, CA',
  '  - Delivery estimate: 3-5 days',
  '- **Returns:** 30-day returns on unworn shoes in original packaging.',
  '  - Return window: 30 days',
  '  - Policy: https://store.example.com/policies/returns',
  '',
  '## Variants',
  '',
  '| ID | Title | Options | Price | Availability |',
  '| --- | --- | --- | --- | --- |',
  '| v-8 | Size 8 | size: 8 | $89.00 | In stock |',
  '| v-9 | Size 9 | size: 9 | $89.00 | In stock |',
  '| v-10 | Size 10 | size: 10 | $94.00 | Out of stock |',
  '',
  '## Description',
  '',
  'The Trail Runner 2 is built for long days on technical terrain.',
  '',
  'A recycled mesh upper keeps weight down while the 6 mm drop keeps your',
  'stride natural. Lugs are re-profiled from the original Trail Runner for',
  'better grip in mud without collecting debris on hardpack.',
  '',
  '## Details',
  '',
  '- **Material:** Recycled mesh upper',
  '- **Drop:** 6 mm',
  '- **Weight:** 280 g (size 9)',
  '',
  '## Images',
  '',
  '- [Trail Runner 2, side view](https://cdn.example.com/tr2-hero.jpg)',
  '- [https://cdn.example.com/tr2-sole.jpg](https://cdn.example.com/tr2-sole.jpg)',
].join('\n')

const MINIMAL_PRODUCT_MARKDOWN = [
  '# [Basic Tee](https://store.example.com/products/basic)',
  '',
  '- **Price:** $19.00',
  '- **Availability:** Preorder',
].join('\n')

const POLICIES_MARKDOWN = [
  '# [Shipping Policy](https://store.example.com/policies/shipping)',
  '',
  'Orders placed before 2pm ET ship the same business day. Free standard shipping on orders over $50; otherwise standard shipping is $5.95 flat.',
  '',
  '# [Returns Policy](https://store.example.com/policies/returns)',
  '',
  'Returns are accepted within 30 days of delivery for unworn items in original packaging. Refunds are issued to the original payment method within 5 business days of receipt.',
  '',
  '# [Privacy Policy](https://store.example.com/policies/privacy)',
  '',
  'We collect only the information required to fulfil your order. We never sell customer data.',
].join('\n')

const CATALOG_MARKDOWN = [
  '# Catalog',
  '',
  '| Title | Price | Availability |',
  '| --- | --- | --- |',
  '| [Trail Runner 2](https://store.example.com/products/trail-runner-2) | $89.00 | In stock |',
  '| [Basic Tee](https://store.example.com/products/basic) | $19.00 | Preorder |',
  '| [Wool Socks (3-pack)](https://store.example.com/products/wool-socks) | $24.00 | Backorder |',
].join('\n')

describe('frozen commerce output — renderProductMarkdown', () => {
  it('full PDP, default options', () => {
    const out = renderProductMarkdown(pdp)
    expect(out).toBe(PDP_MARKDOWN)
    expect(byteLength(out)).toBe(1264)
  })

  it('minimal product (every optional field absent)', () => {
    const out = renderProductMarkdown(minimalProduct)
    expect(out).toBe(MINIMAL_PRODUCT_MARKDOWN)
    expect(byteLength(out)).toBe(105)
  })

  it('headingLevel 6 clamps the sub-heading to 6, not 7', () => {
    const out = renderProductMarkdown(headingFixture, { headingLevel: 6 })
    expect(out).toBe(
      [
        '###### [Clamp Test](https://store.example.com/products/clamp)',
        '',
        '- **Price:** $10.00',
        '- **Availability:** In stock',
        '',
        '###### Variants',
        '',
        '| ID | Title | Options | Price | Availability |',
        '| --- | --- | --- | --- | --- |',
        '| v-1 | One |  | $10.00 | Backorder |',
      ].join('\n'),
    )
    expect(byteLength(out)).toBe(247)
  })

  it('an absent `updated` changes nothing (the field is additive)', () => {
    // The two fixtures above carry no `updated`, so their frozen bytes are the
    // proof that adding the field did not move a single byte of existing
    // output. Stated as its own assertion so a future change that starts
    // emitting a default date fails here rather than in production.
    expect(renderProductMarkdown(pdp)).toBe(PDP_MARKDOWN)
    expect(renderProductMarkdown(minimalProduct)).toBe(MINIMAL_PRODUCT_MARKDOWN)
  })

  it('`updated` renders last in the fact block, after Availability', () => {
    // Position is frozen, not incidental: every line inserted above
    // `- **Availability:**` pushes a core buying fact further from the top of
    // the document, and ARS D4 scores that byte offset.
    const out = renderProductMarkdown({ ...minimalProduct, updated: '2026-08-19' })
    expect(out).toBe(
      [
        '# [Basic Tee](https://store.example.com/products/basic)',
        '',
        '- **Price:** $19.00',
        '- **Availability:** Preorder',
        '- **Updated:** 2026-08-19',
      ].join('\n'),
    )
    expect(byteLength(out)).toBe(131)
  })

  it('a malformed `updated` emits nothing at all', () => {
    expect(renderProductMarkdown({ ...minimalProduct, updated: '2026-02-31' })).toBe(
      MINIMAL_PRODUCT_MARKDOWN,
    )
  })

  it('headingLevel 0 clamps up to 1 (identical to the default)', () => {
    const expected = [
      '# [Clamp Test](https://store.example.com/products/clamp)',
      '',
      '- **Price:** $10.00',
      '- **Availability:** In stock',
      '',
      '## Variants',
      '',
      '| ID | Title | Options | Price | Availability |',
      '| --- | --- | --- | --- | --- |',
      '| v-1 | One |  | $10.00 | Backorder |',
    ].join('\n')
    expect(renderProductMarkdown(headingFixture, { headingLevel: 0 })).toBe(expected)
    expect(renderProductMarkdown(headingFixture)).toBe(expected)
    expect(byteLength(expected)).toBe(238)
  })
})

describe('frozen commerce output — renderPolicyMarkdown', () => {
  it('all three policies, bodies byte-for-byte verbatim', () => {
    const out = renderPolicyMarkdown(policies)
    expect(out).toBe(POLICIES_MARKDOWN)
    expect(byteLength(out)).toBe(602)
  })

  it('headingLevel 2 moves every policy heading, nothing else', () => {
    const out = renderPolicyMarkdown(policies, { headingLevel: 2 })
    expect(out).toBe(POLICIES_MARKDOWN.replace(/^# \[/gm, '## ['))
    expect(byteLength(out)).toBe(605)
  })

  it('an empty policy list renders an empty document', () => {
    const out = renderPolicyMarkdown([])
    expect(out).toBe('')
    expect(byteLength(out)).toBe(0)
  })
})

describe('frozen commerce output — renderCatalogMarkdown', () => {
  it('three-item catalog table', () => {
    const out = renderCatalogMarkdown(catalog)
    expect(out).toBe(CATALOG_MARKDOWN)
    expect(byteLength(out)).toBe(327)
  })

  it('headingLevel 3 moves the Catalog heading, nothing else', () => {
    const out = renderCatalogMarkdown(catalog, { headingLevel: 3 })
    expect(out).toBe(CATALOG_MARKDOWN.replace('# Catalog', '### Catalog'))
    expect(byteLength(out)).toBe(329)
  })

  it('an empty catalog still renders the table header', () => {
    const out = renderCatalogMarkdown([])
    expect(out).toBe(
      ['# Catalog', '', '| Title | Price | Availability |', '| --- | --- | --- |'].join('\n'),
    )
    expect(byteLength(out)).toBe(63)
  })
})

// ---------------------------------------------------------------------------
// Truncation boundaries
//
// Policies truncate whole-block-first: a policy whose body does not fit
// degrades to its linked title (policy text is never partially rendered), and
// a policy whose title does not fit is dropped entirely. Catalog drops whole
// rows from the bottom and always keeps the table header. Both append the
// truncation note as the final line.
// ---------------------------------------------------------------------------

describe('frozen truncation boundary — renderPolicyMarkdown', () => {
  it('602 bytes is an exact fit: no note, byte-identical to the default render', () => {
    const out = renderPolicyMarkdown(policies, { maxBytes: 602 })
    expect(out).toBe(POLICIES_MARKDOWN)
    expect(byteLength(out)).toBe(602)
  })

  it('601 bytes: policy 3 degrades to its linked title', () => {
    const out = renderPolicyMarkdown(policies, { maxBytes: 601 })
    expect(out).toBe(
      [
        '# [Shipping Policy](https://store.example.com/policies/shipping)',
        '',
        'Orders placed before 2pm ET ship the same business day. Free standard shipping on orders over $50; otherwise standard shipping is $5.95 flat.',
        '',
        '# [Returns Policy](https://store.example.com/policies/returns)',
        '',
        'Returns are accepted within 30 days of delivery for unworn items in original packaging. Refunds are issued to the original payment method within 5 business days of receipt.',
        '',
        '# [Privacy Policy](https://store.example.com/policies/privacy)',
        '',
        TRUNCATION_NOTE,
      ].join('\n'),
    )
    expect(byteLength(out)).toBe(569)
  })

  it('505 bytes is the largest budget holding policies 1-2 whole; policy 3 is dropped entirely', () => {
    const out = renderPolicyMarkdown(policies, { maxBytes: 505 })
    expect(out).toBe(
      [
        '# [Shipping Policy](https://store.example.com/policies/shipping)',
        '',
        'Orders placed before 2pm ET ship the same business day. Free standard shipping on orders over $50; otherwise standard shipping is $5.95 flat.',
        '',
        '# [Returns Policy](https://store.example.com/policies/returns)',
        '',
        'Returns are accepted within 30 days of delivery for unworn items in original packaging. Refunds are issued to the original payment method within 5 business days of receipt.',
        '',
        TRUNCATION_NOTE,
      ].join('\n'),
    )
    expect(byteLength(out)).toBe(505)
  })

  it('504 bytes: policy 2 degrades to its title and truncation stops there', () => {
    const out = renderPolicyMarkdown(policies, { maxBytes: 504 })
    expect(out).toBe(
      [
        '# [Shipping Policy](https://store.example.com/policies/shipping)',
        '',
        'Orders placed before 2pm ET ship the same business day. Free standard shipping on orders over $50; otherwise standard shipping is $5.95 flat.',
        '',
        '# [Returns Policy](https://store.example.com/policies/returns)',
        '',
        TRUNCATION_NOTE,
      ].join('\n'),
    )
    expect(byteLength(out)).toBe(331)
  })

  it('267 bytes is the largest budget holding policy 1 whole', () => {
    const out = renderPolicyMarkdown(policies, { maxBytes: 267 })
    expect(out).toBe(
      [
        '# [Shipping Policy](https://store.example.com/policies/shipping)',
        '',
        'Orders placed before 2pm ET ship the same business day. Free standard shipping on orders over $50; otherwise standard shipping is $5.95 flat.',
        '',
        TRUNCATION_NOTE,
      ].join('\n'),
    )
    expect(byteLength(out)).toBe(267)
  })

  it('266 bytes: policy 1 degrades to its title (its body is never partially rendered)', () => {
    const out = renderPolicyMarkdown(policies, { maxBytes: 266 })
    expect(out).toBe(
      [
        '# [Shipping Policy](https://store.example.com/policies/shipping)',
        '',
        TRUNCATION_NOTE,
      ].join('\n'),
    )
    expect(byteLength(out)).toBe(124)
  })

  it('124 bytes is the smallest budget that still emits policy 1 as a title', () => {
    const out = renderPolicyMarkdown(policies, { maxBytes: 124 })
    expect(out).toBe(
      [
        '# [Shipping Policy](https://store.example.com/policies/shipping)',
        '',
        TRUNCATION_NOTE,
      ].join('\n'),
    )
    expect(byteLength(out)).toBe(124)
  })

  it('123 bytes: not even one title fits — the note alone, and it fits the budget', () => {
    const out = renderPolicyMarkdown(policies, { maxBytes: 123 })
    expect(out).toBe(TRUNCATION_NOTE)
    expect(byteLength(out)).toBe(58)
  })

  it('an impossibly small budget still returns the bare note, never a partial policy', () => {
    expect(renderPolicyMarkdown(policies, { maxBytes: 1 })).toBe(TRUNCATION_NOTE)
    expect(renderPolicyMarkdown(policies, { maxBytes: 0 })).toBe(TRUNCATION_NOTE)
  })
})

describe('frozen truncation boundary — renderCatalogMarkdown', () => {
  it('327 bytes is an exact fit: no note, byte-identical to the default render', () => {
    const out = renderCatalogMarkdown(catalog, { maxBytes: 327 })
    expect(out).toBe(CATALOG_MARKDOWN)
    expect(byteLength(out)).toBe(327)
  })

  it('326 bytes: the last row is dropped whole', () => {
    const out = renderCatalogMarkdown(catalog, { maxBytes: 326 })
    expect(out).toBe(
      [
        '# Catalog',
        '',
        '| Title | Price | Availability |',
        '| --- | --- | --- |',
        '| [Trail Runner 2](https://store.example.com/products/trail-runner-2) | $89.00 | In stock |',
        '| [Basic Tee](https://store.example.com/products/basic) | $19.00 | Preorder |',
        '',
        TRUNCATION_NOTE,
      ].join('\n'),
    )
    expect(byteLength(out)).toBe(293)
  })

  it('215 bytes is the largest budget holding exactly one row', () => {
    const out = renderCatalogMarkdown(catalog, { maxBytes: 215 })
    expect(out).toBe(
      [
        '# Catalog',
        '',
        '| Title | Price | Availability |',
        '| --- | --- | --- |',
        '| [Trail Runner 2](https://store.example.com/products/trail-runner-2) | $89.00 | In stock |',
        '',
        TRUNCATION_NOTE,
      ].join('\n'),
    )
    expect(byteLength(out)).toBe(215)
  })

  it('214 bytes: no row fits — header plus note', () => {
    const out = renderCatalogMarkdown(catalog, { maxBytes: 214 })
    expect(out).toBe(
      [
        '# Catalog',
        '',
        '| Title | Price | Availability |',
        '| --- | --- | --- |',
        '',
        TRUNCATION_NOTE,
      ].join('\n'),
    )
    expect(byteLength(out)).toBe(123)
  })

  it('the table header is structural and survives a budget it does not fit (123 > 40)', () => {
    // Rows are the content and are droppable; the header is scaffolding the
    // remaining rows would be unparseable without. Documented behaviour, not a
    // budget bug: the same 123-byte document is emitted for any budget below
    // the one-row boundary.
    const out = renderCatalogMarkdown(catalog, { maxBytes: 40 })
    expect(out).toBe(
      [
        '# Catalog',
        '',
        '| Title | Price | Availability |',
        '| --- | --- | --- |',
        '',
        TRUNCATION_NOTE,
      ].join('\n'),
    )
    expect(byteLength(out)).toBe(123)
    expect(out).toBe(renderCatalogMarkdown(catalog, { maxBytes: 123 }))
    expect(out).toBe(renderCatalogMarkdown(catalog, { maxBytes: 0 }))
  })
})

describe('frozen truncation boundary — renderProductMarkdown', () => {
  it('1264 bytes is an exact fit: no note, byte-identical to the default render', () => {
    const out = renderProductMarkdown(pdp, { maxBytes: 1264 })
    expect(out).toBe(PDP_MARKDOWN)
    expect(byteLength(out)).toBe(1264)
  })

  it('1263 bytes: the Images tail section truncates to its first whole line', () => {
    const out = renderProductMarkdown(pdp, { maxBytes: 1263 })
    expect(out).toBe(
      [
        '# [Trail Runner 2](https://store.example.com/products/trail-runner-2)',
        '',
        '- **Brand:** Acme Outdoors',
        '- **Price:** ~~$120.00~~ $89.00',
        '- **Availability:** In stock',
        '- **Shipping:** Free standard shipping on orders over $50. Standard shipping is $5.95.',
        '  - Free shipping threshold: $50.00',
        '  - Ships to: US, CA',
        '  - Delivery estimate: 3-5 days',
        '- **Returns:** 30-day returns on unworn shoes in original packaging.',
        '  - Return window: 30 days',
        '  - Policy: https://store.example.com/policies/returns',
        '',
        '## Variants',
        '',
        '| ID | Title | Options | Price | Availability |',
        '| --- | --- | --- | --- | --- |',
        '| v-8 | Size 8 | size: 8 | $89.00 | In stock |',
        '| v-9 | Size 9 | size: 9 | $89.00 | In stock |',
        '| v-10 | Size 10 | size: 10 | $94.00 | Out of stock |',
        '',
        '## Description',
        '',
        'The Trail Runner 2 is built for long days on technical terrain.',
        '',
        'A recycled mesh upper keeps weight down while the 6 mm drop keeps your',
        'stride natural. Lugs are re-profiled from the original Trail Runner for',
        'better grip in mud without collecting debris on hardpack.',
        '',
        '## Details',
        '',
        '- **Material:** Recycled mesh upper',
        '- **Drop:** 6 mm',
        '- **Weight:** 280 g (size 9)',
        '',
        '## Images',
        '',
        '- [Trail Runner 2, side view](https://cdn.example.com/tr2-hero.jpg)',
        '',
        TRUNCATION_NOTE,
      ].join('\n'),
    )
    expect(byteLength(out)).toBe(1245)
  })

  it('1024 bytes: Details and Images drop, Description keeps whole lines only', () => {
    const out = renderProductMarkdown(pdp, { maxBytes: 1024 })
    expect(out).toBe(
      [
        '# [Trail Runner 2](https://store.example.com/products/trail-runner-2)',
        '',
        '- **Brand:** Acme Outdoors',
        '- **Price:** ~~$120.00~~ $89.00',
        '- **Availability:** In stock',
        '- **Shipping:** Free standard shipping on orders over $50. Standard shipping is $5.95.',
        '  - Free shipping threshold: $50.00',
        '  - Ships to: US, CA',
        '  - Delivery estimate: 3-5 days',
        '- **Returns:** 30-day returns on unworn shoes in original packaging.',
        '  - Return window: 30 days',
        '  - Policy: https://store.example.com/policies/returns',
        '',
        '## Variants',
        '',
        '| ID | Title | Options | Price | Availability |',
        '| --- | --- | --- | --- | --- |',
        '| v-8 | Size 8 | size: 8 | $89.00 | In stock |',
        '| v-9 | Size 9 | size: 9 | $89.00 | In stock |',
        '| v-10 | Size 10 | size: 10 | $94.00 | Out of stock |',
        '',
        '## Description',
        '',
        'The Trail Runner 2 is built for long days on technical terrain.',
        '',
        'A recycled mesh upper keeps weight down while the 6 mm drop keeps your',
        'stride natural. Lugs are re-profiled from the original Trail Runner for',
        '',
        TRUNCATION_NOTE,
      ].join('\n'),
    )
    expect(byteLength(out)).toBe(1012)
  })

  it('700 bytes: every tail section drops; required blocks are kept whole', () => {
    const out = renderProductMarkdown(pdp, { maxBytes: 700 })
    expect(out).toBe(
      [
        '# [Trail Runner 2](https://store.example.com/products/trail-runner-2)',
        '',
        '- **Brand:** Acme Outdoors',
        '- **Price:** ~~$120.00~~ $89.00',
        '- **Availability:** In stock',
        '- **Shipping:** Free standard shipping on orders over $50. Standard shipping is $5.95.',
        '  - Free shipping threshold: $50.00',
        '  - Ships to: US, CA',
        '  - Delivery estimate: 3-5 days',
        '- **Returns:** 30-day returns on unworn shoes in original packaging.',
        '  - Return window: 30 days',
        '  - Policy: https://store.example.com/policies/returns',
        '',
        '## Variants',
        '',
        '| ID | Title | Options | Price | Availability |',
        '| --- | --- | --- | --- | --- |',
        '| v-8 | Size 8 | size: 8 | $89.00 | In stock |',
        '| v-9 | Size 9 | size: 9 | $89.00 | In stock |',
        '| v-10 | Size 10 | size: 10 | $94.00 | Out of stock |',
        '',
        TRUNCATION_NOTE,
      ].join('\n'),
    )
    // 787 > 700: buying facts and the variants table are never sacrificed to
    // the byte budget (markdown.ts's stated contract). Frozen deliberately —
    // a future change that starts honouring the budget here would be a
    // behaviour change on the live path, not a bug fix.
    expect(byteLength(out)).toBe(787)
  })

  it('an impossibly small budget emits the required blocks anyway, identical to 700', () => {
    expect(renderProductMarkdown(pdp, { maxBytes: 64 })).toBe(
      renderProductMarkdown(pdp, { maxBytes: 700 }),
    )
  })
})
