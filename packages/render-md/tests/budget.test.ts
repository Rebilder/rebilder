import { describe, expect, it } from 'vitest'
import type { ProductSource } from '../src/index'
import { renderProductMarkdown } from '../src/index'
import { pdp } from './fixtures/pdp'

const byteLength = (s: string): number => new TextEncoder().encode(s).length

const longDescription = Array.from(
  { length: 400 },
  (_, i) => `Description line ${i} lorem ipsum dolor sit amet consectetur adipiscing elit.`,
).join('\n')

const oversized: ProductSource = { ...pdp, description: longDescription }

describe('size budget', () => {
  it('stays within the default 5120-byte budget', () => {
    const out = renderProductMarkdown(oversized)
    expect(byteLength(out)).toBeLessThanOrEqual(5120)
  })

  it('keeps price, availability, shipping, and returns when truncating', () => {
    const out = renderProductMarkdown(oversized)
    expect(out).toContain('**Price:** ~~$120.00~~ $89.00')
    expect(out).toContain('**Availability:** In stock')
    expect(out).toContain(
      'Free standard shipping on orders over $50. Standard shipping is $5.95.',
    )
    expect(out).toContain('30-day returns on unworn shoes in original packaging.')
  })

  it('appends a truncation note when content is dropped', () => {
    const out = renderProductMarkdown(oversized)
    expect(out).toMatch(/truncated/i)
    // The note is the final line.
    expect(out.trimEnd().split('\n').at(-1)).toMatch(/truncated/i)
  })

  it('respects a custom maxBytes', () => {
    const out = renderProductMarkdown(oversized, { maxBytes: 2048 })
    expect(byteLength(out)).toBeLessThanOrEqual(2048)
    expect(out).toContain('$89.00')
  })

  it('never truncates mid-line: every kept description line is complete', () => {
    const out = renderProductMarkdown(oversized, { maxBytes: 2048 })
    for (const line of out.split('\n')) {
      if (line.startsWith('Description line ')) {
        expect(line).toMatch(
          /^Description line \d+ lorem ipsum dolor sit amet consectetur adipiscing elit\.$/,
        )
      }
    }
  })

  it('never sacrifices front-loaded facts, even when the budget is impossibly small', () => {
    const out = renderProductMarkdown(oversized, { maxBytes: 64 })
    expect(out).toContain('**Price:** ~~$120.00~~ $89.00')
    expect(out).toContain('**Availability:** In stock')
    expect(out).toMatch(/truncated/i)
  })

  it('does not truncate at all when the content fits', () => {
    const out = renderProductMarkdown(pdp)
    expect(byteLength(out)).toBeLessThanOrEqual(5120)
    expect(out).not.toMatch(/truncated/i)
    // Bottom sections intact.
    expect(out).toContain('## Images')
    expect(out).toContain('**Material:** Recycled mesh upper')
  })
})
