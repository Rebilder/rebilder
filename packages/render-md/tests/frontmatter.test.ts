/**
 * `renderFrontmatter`: opt-in YAML frontmatter.
 *
 * What is pinned here: the exact block for complete input, that every value is
 * the caller's own string (bare when YAML reads it back unchanged, quoted
 * otherwise, never rewritten), that invalid URLs and dates are dropped rather
 * than repaired, that source text cannot close the block or add a key, and
 * that the size cap drops the description before it drops everything.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FRONTMATTER_MAX_BYTES, renderDocumentMarkdown, renderFrontmatter } from '../src/index'

describe('renderFrontmatter', () => {
  it('renders the four keys in a fixed order, fenced by ---', () => {
    expect(
      renderFrontmatter({
        title: 'Bike fitting',
        description: 'A 90-minute fit on your own bike, with a written report.',
        canonicalUrl: 'https://example.com/services/bike-fitting',
        lastUpdated: '2026-09-28',
      }),
    ).toBe(
      [
        '---',
        'title: Bike fitting',
        'description: A 90-minute fit on your own bike, with a written report.',
        'canonical_url: https://example.com/services/bike-fitting',
        'last_updated: "2026-09-28"',
        '---',
        '',
      ].join('\n'),
    )
  })

  it('omits a field the caller does not have, and returns nothing for no fields', () => {
    expect(renderFrontmatter({ canonicalUrl: 'https://example.com/a' })).toBe(
      '---\ncanonical_url: https://example.com/a\n---\n',
    )
    expect(renderFrontmatter({})).toBe('')
    expect(renderFrontmatter({ title: '   ', description: '' })).toBe('')
  })

  it('drops a canonical URL that is not absolute http(s), never repairs it', () => {
    for (const bad of [
      '/relative/path',
      'javascript:alert(1)',
      'mailto:a@example.com',
      'not a url',
    ]) {
      expect(renderFrontmatter({ title: 'T', canonicalUrl: bad })).toBe('---\ntitle: T\n---\n')
    }
    // Verbatim when valid: no normalisation to a trailing slash.
    expect(renderFrontmatter({ canonicalUrl: 'https://example.com' })).toContain(
      'canonical_url: https://example.com\n',
    )
  })

  it('drops a date that does not exist or is not ISO 8601, and quotes the rest', () => {
    for (const bad of ['2026-02-31', '28/09/2026', 'yesterday', '2026-13-01']) {
      expect(renderFrontmatter({ title: 'T', lastUpdated: bad })).toBe('---\ntitle: T\n---\n')
    }
    // Quoted so YAML keeps it a string rather than a timestamp.
    expect(renderFrontmatter({ lastUpdated: '2026-09-28T10:00:00Z' })).toContain(
      'last_updated: "2026-09-28T10:00:00Z"',
    )
  })

  it('writes a value bare only when YAML reads it back as the same string', () => {
    const line = (title: string) => renderFrontmatter({ title }).split('\n')[1]
    // Bare: plain prose, a leading digit that is not a number, quotes inside.
    for (const bare of [
      'Bike fitting',
      '3 ways to fit a bike',
      'N/A',
      'Yes, we do',
      'The "best" fit',
      'Pricing — plans',
    ]) {
      expect(line(bare)).toBe(`title: ${bare}`)
    }
    // Quoted: key-like colons, comments, YAML indicators, typed words and
    // numbers, dates, surrounding space and control characters.
    for (const quoted of [
      'Rebilder: pricing',
      'Ends with:',
      'Tag #1 is fine but this # is not',
      '- a list?',
      '*alias',
      '[flow]',
      "'single'",
      '"double"',
      '@handle',
      '`code`',
      'yes',
      'Null',
      '~',
      '2026',
      '1.5',
      '0x1F',
      '12:30',
      '2026-09-28',
      ' padded',
      'tab\there',
    ]) {
      expect(line(quoted), quoted).toBe(`title: ${JSON.stringify(quoted)}`)
    }
  })

  it('keeps source text inside its quotes: no early fence, no injected key', () => {
    const block = renderFrontmatter({
      title: 'Title\n---\ncanonical_url: https://evil.example\n"quoted"',
      description: ['Line one', 'line two'].join(String.fromCharCode(0x2028)),
    })
    const lines = block.split('\n')
    expect(lines.filter((line) => line === '---')).toHaveLength(2)
    expect(lines.filter((line) => line.startsWith('canonical_url:'))).toHaveLength(0)
    expect(block).toContain('\\n---\\ncanonical_url: https://evil.example\\n\\"quoted\\"')
    expect(block).toContain('\\u2028')
    // The escapes decode back to the exact source string.
    const title = JSON.parse(lines[1]!.slice('title: '.length)) as string
    expect(title).toBe('Title\n---\ncanonical_url: https://evil.example\n"quoted"')
  })

  it('ignores values that are not strings (untyped callers)', () => {
    expect(
      renderFrontmatter({
        title: 42 as unknown as string,
        canonicalUrl: { href: 'https://example.com' } as unknown as string,
      }),
    ).toBe('')
  })

  it('drops the description first when the block is over the cap, then everything', () => {
    const long = 'x'.repeat(FRONTMATTER_MAX_BYTES)
    const block = renderFrontmatter({
      title: 'T',
      description: long,
      canonicalUrl: 'https://example.com/a',
    })
    expect(block).toBe('---\ntitle: T\ncanonical_url: https://example.com/a\n---\n')
    expect(renderFrontmatter({ title: long })).toBe('')
  })

  it('matches the README example', () => {
    const readme = readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8')
    const shown = renderFrontmatter({
      title: 'Bike fitting',
      description: 'A 90-minute fit on your own bike, with a written report.',
      canonicalUrl: 'https://example.com/services/bike-fitting',
      lastUpdated: '2026-09-28',
    })
      .trimEnd()
      .split('\n')
      .map((line) => `// ${line}`)
      .join('\n')
    expect(readme).toContain(shown)
  })

  it('does not change what any renderer returns', () => {
    // Frontmatter is a separate block the caller chooses to prepend.
    const markdown = renderDocumentMarkdown({ url: 'https://example.com/a', title: 'A' })
    expect(markdown.startsWith('# [A](https://example.com/a)')).toBe(true)
  })
})
