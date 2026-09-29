import { describe, expect, it } from 'vitest'
import type { CollectionSource, DocumentSource } from '../src/index'
import { renderCollectionMarkdown, renderDocumentMarkdown } from '../src/index'
import {
  dentistLocation,
  governmentService,
  guideIndex,
  lawPracticeArea,
  saasPlans,
} from './fixtures/documents'

/**
 * Behavioural tests for the universal renderers: block order, the hours
 * table, the URL scheme allowlist, escaping, dedup, the two collection modes,
 * and the hard ceilings. Truncation, injected-field integrity, and the access
 * gate have their own files.
 */

const byteLength = (s: string): number => new TextEncoder().encode(s).length

/** Index of a line in the output; -1 when absent. */
function lineIndex(out: string, predicate: (line: string) => boolean): number {
  return out.split('\n').findIndex(predicate)
}

describe('renderDocumentMarkdown — block order', () => {
  const out = renderDocumentMarkdown(dentistLocation)

  it('opens with the title linked to the canonical URL', () => {
    expect(out.split('\n')[0]).toBe(
      '# [Riverside Dental — Eastside](https://riverside-dental.example.com/locations/eastside)',
    )
  })

  it('renders the summary as a blockquote directly under the title', () => {
    expect(out.split('\n')[2]).toBe('> General and cosmetic dentistry, accepting new patients.')
  })

  it('front-loads Updated and every scalar fact before any other block', () => {
    const firstHeading = lineIndex(out, (l) => l.startsWith('## '))
    const lastFact = out
      .split('\n')
      .reduce((acc, line, i) => (line.startsWith('- **') ? i : acc), -1)
    expect(lineIndex(out, (l) => l === '- **Updated:** 2026-07-14')).toBeLessThan(firstHeading)
    expect(lastFact).toBeGreaterThan(firstHeading) // the hours-note bullet is later
    expect(out).toContain('- **Accepting new patients:** Yes')
    expect(out).toContain(
      '- **Services:** Cleanings, Fillings, Crowns, Whitening, Emergency care',
    )
    expect(out).toContain('- **New patient exam:** $125.00')
    expect(out).toContain('- **Parking spaces:** 24')
  })

  it('renders a fact note as an indented bullet under its fact line', () => {
    expect(out).toContain('- **New patient exam:** $125.00\n  - Includes x-rays.')
  })

  it('orders the blocks facts → hours → Contact → Actions → sections → Related', () => {
    const order = [
      '## Office hours',
      '## Contact',
      '## Actions',
      '## Insurance',
      '## Related',
    ].map((h) => lineIndex(out, (l) => l === h))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('never renders the advisory kind', () => {
    // `kind` is a routing/telemetry label. Use a token that appears nowhere
    // else in the fixture so the assertion cannot pass by accident.
    const tagged = renderDocumentMarkdown({ ...dentistLocation, kind: 'zzqq-kind' })
    expect(tagged).not.toContain('zzqq-kind')
  })
})

describe('renderDocumentMarkdown — hours', () => {
  const out = renderDocumentMarkdown(dentistLocation)

  it("heads the table with the fact's own label, not a fixed 'Hours'", () => {
    expect(out).toContain('## Office hours')
    expect(out).not.toContain('## Hours')
  })

  it('renders all seven weekdays', () => {
    for (const day of [
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ]) {
      expect(out).toContain(`| ${day} |`)
    }
  })

  it('distinguishes an absent day (Not stated) from an empty one (Closed)', () => {
    expect(out).toContain('| Saturday | Not stated |')
    expect(out).toContain('| Sunday | Closed |')
  })

  it('renders a split day as two intervals in one cell', () => {
    expect(out).toContain('| Tuesday | 08:00-12:00, 13:00-17:00 |')
  })

  it('states the timezone once, above the table', () => {
    expect(out).toContain('All times are local to America/Los_Angeles.')
  })

  it('renders exceptions in their own sub-block', () => {
    expect(out).toContain('### Exceptions')
    expect(out).toContain('| 2026-11-26 | Closed | Thanksgiving |')
    expect(out).toContain('| 2026-12-24 | 08:00-12:00 |  |')
  })

  it('never computes whether the place is open now', () => {
    expect(out).not.toMatch(/open now/i)
    expect(out).not.toMatch(/currently (open|closed)/i)
  })

  it('drops the whole hours fact when any interval is malformed', () => {
    const broken: DocumentSource = {
      url: 'https://example.com/a',
      title: 'A',
      facts: [
        {
          label: 'Office hours',
          value: {
            type: 'hours',
            value: {
              timeZone: 'UTC',
              weekly: [
                { day: 'monday', intervals: [{ opens: '09:00', closes: '17:00' }] },
                // Wraps past midnight: rejected, and it takes the block with it.
                { day: 'tuesday', intervals: [{ opens: '22:00', closes: '02:00' }] },
              ],
            },
          },
        },
      ],
    }
    const brokenOut = renderDocumentMarkdown(broken)
    expect(brokenOut).not.toContain('## Office hours')
    expect(brokenOut).not.toContain('09:00-17:00')
  })

  it('drops an hours fact with a blank timezone', () => {
    const noZone: DocumentSource = {
      url: 'https://example.com/a',
      title: 'A',
      facts: [
        {
          label: 'Office hours',
          value: {
            type: 'hours',
            value: {
              timeZone: '   ',
              weekly: [{ day: 'monday', intervals: [{ opens: '09:00', closes: '17:00' }] }],
            },
          },
        },
      ],
    }
    expect(renderDocumentMarkdown(noZone)).not.toContain('## Office hours')
  })

  it('emits one block per hours fact, each under its own label', () => {
    const twoTables: DocumentSource = {
      url: 'https://example.com/clinic',
      title: 'Clinic',
      facts: [
        {
          label: 'Office hours',
          value: {
            type: 'hours',
            value: {
              timeZone: 'UTC',
              weekly: [{ day: 'monday', intervals: [{ opens: '09:00', closes: '17:00' }] }],
            },
          },
        },
        {
          label: 'Lab hours',
          value: {
            type: 'hours',
            value: {
              timeZone: 'UTC',
              weekly: [{ day: 'monday', intervals: [{ opens: '07:00', closes: '11:00' }] }],
            },
          },
        },
      ],
    }
    const twoOut = renderDocumentMarkdown(twoTables)
    expect(twoOut).toContain('## Office hours')
    expect(twoOut).toContain('## Lab hours')
    expect(lineIndex(twoOut, (l) => l === '## Office hours')).toBeLessThan(
      lineIndex(twoOut, (l) => l === '## Lab hours'),
    )
  })
})

describe('renderDocumentMarkdown — URL scheme allowlist', () => {
  const out = renderDocumentMarkdown(governmentService)

  it('drops a url fact whose scheme is not allowlisted', () => {
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('Open the legacy tool')
  })

  it('drops an action whose scheme is not allowlisted', () => {
    expect(out).not.toContain('app://')
    expect(out).not.toContain('Open the desktop app')
  })

  it('drops a related link whose scheme is not allowlisted', () => {
    expect(out).not.toContain('file://')
    expect(out).not.toContain('Internal notes')
  })

  it('keeps https, and keeps tel/mailto elsewhere', () => {
    expect(out).toContain('[Apply online](https://city.example.gov/apply/rpp)')
    expect(renderDocumentMarkdown(dentistLocation)).toContain('[Call the office](tel:+15550100)')
  })

  it('renders the title unlinked when the document URL is not allowlisted', () => {
    const bad: DocumentSource = { url: 'javascript:alert(1)', title: 'Trust me' }
    expect(renderDocumentMarkdown(bad)).toBe('# Trust me')
  })

  it('rejects relative URLs — there is no base URL to resolve them against', () => {
    const rel: DocumentSource = {
      url: 'https://example.com/a',
      title: 'A',
      related: [{ title: 'Elsewhere', url: '/elsewhere' }],
    }
    expect(renderDocumentMarkdown(rel)).not.toContain('Elsewhere')
  })
})

describe('renderDocumentMarkdown — escaping', () => {
  it('escapes ], ( and ) in link labels', () => {
    expect(renderDocumentMarkdown(governmentService)).toContain(
      '- **Application form:** [Form RPP-1 \\(PDF\\)](https://city.example.gov/forms/rpp-1)',
    )
  })

  it('escapes a bracket that would otherwise forge a link target', () => {
    const hostile: DocumentSource = {
      url: 'https://example.com/a',
      title: 'A',
      actions: [{ label: 'Safe](https://evil.example.com) Real', url: 'https://example.com/go' }],
    }
    const out = renderDocumentMarkdown(hostile)
    expect(out).toContain(
      '- [Safe\\]\\(https://evil.example.com\\) Real](https://example.com/go)',
    )
    expect(out).not.toContain('](https://evil.example.com)')
  })

  it('leaves a pipe alone in a fact line (it only breaks table cells)', () => {
    expect(renderDocumentMarkdown(governmentService)).toContain('- **Zones A|B:** Eligible')
  })

  it('collapses newlines inside a fact value onto one line', () => {
    const multiline: DocumentSource = {
      url: 'https://example.com/a',
      title: 'A',
      facts: [{ label: 'Note', value: { type: 'text', value: 'one\ntwo' } }],
    }
    expect(renderDocumentMarkdown(multiline)).toContain('- **Note:** one two')
  })
})

describe('renderDocumentMarkdown — dedup and validation', () => {
  it('drops a fact labelled Updated when the top-level updated is set', () => {
    const out = renderDocumentMarkdown(governmentService)
    expect(out).toContain('- **Updated:** 2026-06-01')
    expect(out).not.toContain('1999-01-01')
  })

  it('keeps a fact labelled Updated when the top-level updated is malformed', () => {
    const doc: DocumentSource = {
      url: 'https://example.com/a',
      title: 'A',
      updated: 'last Tuesday',
      facts: [{ label: 'Updated', value: { type: 'date', value: '2026-01-02' } }],
    }
    const out = renderDocumentMarkdown(doc)
    expect(out).not.toContain('last Tuesday')
    expect(out).toContain('- **Updated:** 2026-01-02')
  })

  it('drops a malformed date rather than repairing it', () => {
    const doc: DocumentSource = {
      url: 'https://example.com/a',
      title: 'A',
      facts: [
        { label: 'Filed', value: { type: 'date', value: '2026-13-45' } },
        { label: 'Heard', value: { type: 'date', value: '2026-02-03' } },
      ],
    }
    const out = renderDocumentMarkdown(doc)
    expect(out).not.toContain('Filed')
    expect(out).toContain('- **Heard:** 2026-02-03')
  })

  it('drops non-finite and exponential-form numbers', () => {
    const doc: DocumentSource = {
      url: 'https://example.com/a',
      title: 'A',
      facts: [
        { label: 'Broken', value: { type: 'number', value: Number.POSITIVE_INFINITY } },
        { label: 'Huge', value: { type: 'number', value: 1e21 } },
        { label: 'Fine', value: { type: 'number', value: 42 } },
      ],
    }
    const out = renderDocumentMarkdown(doc)
    expect(out).not.toContain('Broken')
    expect(out).not.toContain('Huge')
    expect(out).toContain('- **Fine:** 42')
  })

  it('throws on a money range whose currencies disagree', () => {
    const doc: DocumentSource = {
      url: 'https://example.com/a',
      title: 'A',
      facts: [
        {
          label: 'Fee',
          value: {
            type: 'money',
            value: { amount: 100, currency: 'USD' },
            maxValue: { amount: 200, currency: 'EUR' },
          },
        },
      ],
    }
    expect(() => renderDocumentMarkdown(doc)).toThrow(TypeError)
  })

  it('throws on a money range that runs backwards', () => {
    const doc: DocumentSource = {
      url: 'https://example.com/a',
      title: 'A',
      facts: [
        {
          label: 'Fee',
          value: {
            type: 'money',
            value: { amount: 500, currency: 'USD' },
            maxValue: { amount: 100, currency: 'USD' },
          },
        },
      ],
    }
    expect(() => renderDocumentMarkdown(doc)).toThrow(TypeError)
  })

  it('renders money with a period suffix and verbatim per-text', () => {
    expect(renderDocumentMarkdown(governmentService)).toContain('- **Annual fee:** $45.00 per year')
    expect(renderCollectionMarkdown(saasPlans)).toContain('$29.00 per month per seat')
  })
})

describe('renderDocumentMarkdown — determinism and caps', () => {
  it('is deterministic: same input, same output', () => {
    expect(renderDocumentMarkdown(dentistLocation)).toBe(renderDocumentMarkdown(dentistLocation))
  })

  it('renders at most 60 facts', () => {
    const doc: DocumentSource = {
      url: 'https://example.com/a',
      title: 'A',
      facts: Array.from({ length: 90 }, (_, i) => ({
        label: `F${String(i)}`,
        value: { type: 'number' as const, value: i },
      })),
    }
    const out = renderDocumentMarkdown(doc, { maxBytes: 1_000_000 })
    expect(out).toContain('- **F59:** 59')
    expect(out).not.toContain('- **F60:**')
  })

  it('renders at most 20 actions', () => {
    const doc: DocumentSource = {
      url: 'https://example.com/a',
      title: 'A',
      actions: Array.from({ length: 30 }, (_, i) => ({
        label: `A${String(i)}`,
        url: `https://example.com/${String(i)}`,
      })),
    }
    const out = renderDocumentMarkdown(doc, { maxBytes: 1_000_000 })
    expect(out).toContain('[A19](https://example.com/19)')
    expect(out).not.toContain('[A20](https://example.com/20)')
  })

  it('honours headingLevel, clamped to 6', () => {
    const out = renderDocumentMarkdown(lawPracticeArea, { headingLevel: 3 })
    expect(out.split('\n')[0]?.startsWith('### ')).toBe(true)
    expect(out).toContain('#### What we handle')

    const clamped = renderDocumentMarkdown(dentistLocation, { headingLevel: 9 })
    expect(clamped.split('\n')[0]?.startsWith('###### ')).toBe(true)
    expect(clamped).toContain('###### Office hours')
    expect(clamped).toContain('###### Exceptions') // sub-heading clamps at 6, not 7
  })
})

describe('renderCollectionMarkdown — link-list mode', () => {
  const out = renderCollectionMarkdown(guideIndex)

  it('uses the fixed Contents label when no title is given', () => {
    expect(out.split('\n')[0]).toBe('# [Contents](https://ledgerly.example.com/guides)')
  })

  it('renders one linked bullet per item with the summary indented', () => {
    expect(out).toContain('- [Filing VAT](https://ledgerly.example.com/guides/vat)')
    expect(out).toContain('  - What to file and when.')
  })

  it('renders no table when no item carries facts', () => {
    expect(out).not.toContain('| --- |')
  })

  it('renders only the heading for an empty collection', () => {
    expect(renderCollectionMarkdown({ url: 'https://example.com/x', items: [] })).toBe(
      '# [Contents](https://example.com/x)',
    )
  })
})

describe('renderCollectionMarkdown — table mode', () => {
  const out = renderCollectionMarkdown(saasPlans)
  const rows = out.split('\n').filter((l) => l.startsWith('| '))

  it('switches to a table as soon as any item carries facts', () => {
    expect(rows[0]).toBe('| Title | Note | Price | Seats | SSO | Support |')
    expect(rows[1]).toBe('| --- | --- | --- | --- | --- | --- |')
  })

  it('orders columns by first appearance, with the summary in a Note column', () => {
    expect(rows[0]).toBe('| Title | Note | Price | Seats | SSO | Support |')
  })

  it('renders an empty cell where an item lacks a column, never a shifted row', () => {
    const cellCounts = new Set(rows.map((r) => r.split(' | ').length))
    expect(cellCounts.size).toBe(1)
    expect(rows[2]).toContain('| For solo bookkeeping. |')
    expect(rows[3]).toContain('| [Team](https://ledgerly.example.com/pricing/team) |  |')
    expect(rows[4]).toContain('| $900.00-$2,500.00 per year |  | Yes |')
  })

  it('escapes a pipe in a column header derived from a fact label', () => {
    const collection: CollectionSource = {
      url: 'https://example.com/list',
      items: [
        {
          url: 'https://example.com/a',
          title: 'A',
          facts: [{ label: 'Zones A|B', value: { type: 'text', value: 'x|y' } }],
        },
      ],
    }
    const piped = renderCollectionMarkdown(collection)
    expect(piped).toContain('| Title | Zones A\\|B |')
    expect(piped).toContain('| x\\|y |')
  })

  it('renders an hours fact as a link to the item page, never as a nested table', () => {
    const collection: CollectionSource = {
      url: 'https://example.com/branches',
      items: [
        {
          url: 'https://example.com/branches/north',
          title: 'North',
          facts: [
            {
              label: 'Open',
              value: {
                type: 'hours',
                value: {
                  timeZone: 'UTC',
                  weekly: [{ day: 'monday', intervals: [{ opens: '09:00', closes: '17:00' }] }],
                },
              },
            },
          ],
        },
      ],
    }
    const hours = renderCollectionMarkdown(collection)
    expect(hours).toContain('| [See page](https://example.com/branches/north) |')
    expect(hours).not.toContain('Monday')
  })

  it('caps the column union at 12 fact columns', () => {
    const collection: CollectionSource = {
      url: 'https://example.com/list',
      items: [
        {
          url: 'https://example.com/a',
          title: 'A',
          facts: Array.from({ length: 20 }, (_, i) => ({
            label: `C${String(i)}`,
            value: { type: 'number' as const, value: i },
          })),
        },
      ],
    }
    const wide = renderCollectionMarkdown(collection, { maxBytes: 1_000_000 })
    const header = wide.split('\n').find((l) => l.startsWith('| Title'))
    expect(header?.split(' | ')).toHaveLength(13) // Title + 12
    expect(header).toContain('C11')
    expect(header).not.toContain('C12')
  })

  it('caps rendered rows at 500', () => {
    const collection: CollectionSource = {
      url: 'https://example.com/list',
      items: Array.from({ length: 620 }, (_, i) => ({
        url: `https://example.com/i/${String(i)}`,
        title: `Item ${String(i)}`,
        facts: [{ label: 'N', value: { type: 'number' as const, value: i } }],
      })),
    }
    const big = renderCollectionMarkdown(collection, { maxBytes: 1_000_000 })
    expect(big.split('\n').filter((l) => l.startsWith('| [Item'))).toHaveLength(500)
    expect(big).toContain('| [Item 499]')
    expect(big).not.toContain('| [Item 500]')
    expect(big).toMatch(/truncated/i)
  })

  it('stays inside the byte budget at every budget it is given', () => {
    // 120 is the smallest budget that can hold the heading plus the note; a
    // collection that cannot even say which page it is is not worth serving,
    // so below that the heading is emitted anyway (asserted separately).
    for (const maxBytes of [120, 200, 300, 400, 486, 487, 1024]) {
      const sized = renderCollectionMarkdown(saasPlans, { maxBytes })
      expect(byteLength(sized)).toBeLessThanOrEqual(maxBytes)
    }
  })

  it('emits no header at all when not one row fits', () => {
    const tiny = renderCollectionMarkdown(saasPlans, { maxBytes: 200 })
    expect(tiny).not.toContain('| Title |')
    expect(tiny).toMatch(/truncated/i)
  })

  it('keeps the heading even at a budget it cannot fit', () => {
    // The listing URL is the one thing an agent cannot recover from a
    // truncated body, so it outranks the budget — as the product title does
    // on the commerce path.
    const impossible = renderCollectionMarkdown(saasPlans, { maxBytes: 40 })
    expect(impossible.split('\n')[0]).toBe('# [Plans](https://ledgerly.example.com/pricing)')
    expect(impossible).toMatch(/truncated/i)
  })
})
