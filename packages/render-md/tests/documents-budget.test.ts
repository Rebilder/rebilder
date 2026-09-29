import { describe, expect, it } from 'vitest'
import type { DocumentSource } from '../src/index'
import { renderDocumentMarkdown } from '../src/index'
import { dentistLocation, governmentService, lawPracticeArea } from './fixtures/documents'

/**
 * Truncation behaviour for the universal path.
 *
 * The three properties asserted here are the ones a merchant and an agent both
 * depend on, and they are asserted as properties over a sweep of budgets
 * rather than at hand-picked byte counts. A boundary pinned at one budget
 * proves the renderer behaves at that budget; a sweep proves the ordering
 * itself, which is the actual contract:
 *
 *   1. Facts survive. They are the machine-readable payload; prose is not.
 *   2. `related` drops before `sections`. Cross-links are the cheapest thing
 *      to lose — the agent can follow the canonical URL for them.
 *   3. Cuts land on line boundaries. Half a fact is worse than no fact,
 *      because an agent cannot tell it is half.
 */

const byteLength = (s: string): number => new TextEncoder().encode(s).length

const TRUNCATION_NOTE = '*Truncated to fit size budget; remaining content omitted.*'

/** Every budget from `from` to `to` inclusive, stepping by `step`. */
function sweep(from: number, to: number, step: number): number[] {
  const out: number[] = []
  for (let n = from; n <= to; n += step) out.push(n)
  return out
}

describe('document size budget', () => {
  const full = renderDocumentMarkdown(lawPracticeArea)

  it('keeps every fact at maxBytes 64', () => {
    const out = renderDocumentMarkdown(lawPracticeArea, { maxBytes: 64 })
    expect(out).toContain('# [Employment law](https://harbor-law.example.com/practice/employment)')
    expect(out).toContain('- **Free consultation:** Yes')
    expect(out).toContain('- **Consultation fee:** $0.00')
    expect(out).toMatch(/truncated/i)
  })

  it('drops related before sections at every budget', () => {
    for (const maxBytes of sweep(64, byteLength(full) + 32, 8)) {
      const out = renderDocumentMarkdown(lawPracticeArea, { maxBytes })
      if (out.includes('## Related')) {
        // Related survived, so no prose may have been cut to make room.
        expect(out, `maxBytes=${String(maxBytes)}`).toContain('## What we handle')
        expect(out, `maxBytes=${String(maxBytes)}`).toContain('## How matters start')
      }
    }
  })

  it('drops the last related link before the first', () => {
    const budgets = sweep(64, byteLength(full) + 32, 4)
    for (const maxBytes of budgets) {
      const out = renderDocumentMarkdown(lawPracticeArea, { maxBytes })
      if (out.includes('[Fees]')) {
        expect(out, `maxBytes=${String(maxBytes)}`).toContain('[Our attorneys]')
      }
    }
  })

  it('never cuts mid-line: every emitted line is a whole line of the full render', () => {
    const fullLines = new Set(full.split('\n'))
    for (const maxBytes of sweep(64, byteLength(full) + 32, 1)) {
      const out = renderDocumentMarkdown(lawPracticeArea, { maxBytes })
      for (const line of out.split('\n')) {
        if (line === TRUNCATION_NOTE || line === '') continue
        expect(fullLines.has(line), `maxBytes=${String(maxBytes)}, line=${line}`).toBe(true)
      }
    }
  })

  it('ends the document at the cut — nothing renders after the note', () => {
    for (const maxBytes of sweep(64, byteLength(full), 8)) {
      const out = renderDocumentMarkdown(lawPracticeArea, { maxBytes })
      if (!out.includes(TRUNCATION_NOTE)) continue
      expect(out.trimEnd().split('\n').at(-1)).toBe(TRUNCATION_NOTE)
    }
  })

  it('emits no note when everything fits', () => {
    expect(renderDocumentMarkdown(lawPracticeArea, { maxBytes: 4096 })).not.toMatch(/truncated/i)
    expect(full).not.toMatch(/truncated/i)
  })

  it('stays inside the budget once the tail is truncatable', () => {
    for (const maxBytes of sweep(240, byteLength(full) + 32, 4)) {
      const out = renderDocumentMarkdown(lawPracticeArea, { maxBytes })
      expect(byteLength(out), `maxBytes=${String(maxBytes)}`).toBeLessThanOrEqual(maxBytes)
    }
  })
})

describe('hard ceiling on required blocks', () => {
  /**
   * `assembleWithBudget` emits required blocks even when they alone exceed the
   * budget — "facts are never sacrificed". That promise is safe for a PDP with
   * a dozen fields and unbounded for a page with sixty. The absolute ceiling
   * at 4 × maxBytes is what stops a merchant's data shape from deciding our
   * response size.
   */
  const hugeFacts: DocumentSource = {
    url: 'https://city.example.gov/services/everything',
    title: 'Everything',
    facts: Array.from({ length: 60 }, (_, i) => ({
      label: `Requirement ${String(i)}`,
      value: {
        type: 'text' as const,
        value: 'A long verbatim statement of one requirement, as published on the page.',
      },
    })),
  }

  it('truncates required blocks past 4 × maxBytes', () => {
    const maxBytes = 512
    const out = renderDocumentMarkdown(hugeFacts, { maxBytes })
    expect(byteLength(renderDocumentMarkdown(hugeFacts, { maxBytes: 1_000_000 }))).toBeGreaterThan(
      maxBytes * 4,
    )
    expect(byteLength(out)).toBeLessThanOrEqual(maxBytes * 4)
    expect(out).toMatch(/truncated/i)
  })

  it('still cuts on line boundaries at the hard ceiling', () => {
    const fullLines = new Set(renderDocumentMarkdown(hugeFacts, { maxBytes: 1_000_000 }).split('\n'))
    const out = renderDocumentMarkdown(hugeFacts, { maxBytes: 256 })
    for (const line of out.split('\n')) {
      if (line === TRUNCATION_NOTE || line === '') continue
      expect(fullLines.has(line), line).toBe(true)
    }
  })

  it('keeps the front-loaded facts it does emit, in source order', () => {
    const out = renderDocumentMarkdown(hugeFacts, { maxBytes: 512 })
    expect(out).toContain('- **Requirement 0:**')
    expect(out).not.toContain('- **Requirement 59:**')
  })

  it('leaves documents comfortably inside the ceiling untouched', () => {
    for (const doc of [dentistLocation, governmentService, lawPracticeArea]) {
      const out = renderDocumentMarkdown(doc)
      expect(byteLength(out)).toBeLessThanOrEqual(5120 * 4)
      expect(out).not.toMatch(/truncated/i)
    }
  })
})
