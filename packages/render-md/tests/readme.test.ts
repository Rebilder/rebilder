/**
 * The README's install example shows real output. If the renderer changes what
 * that document renders, this fails and the README gets updated with it.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderDocumentMarkdown } from '../src/index'

const README = readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8')

describe('README example', () => {
  it('prints what renderDocumentMarkdown actually returns', () => {
    const markdown = renderDocumentMarkdown({
      url: 'https://example.com/services/bike-fitting',
      title: 'Bike fitting',
      facts: [
        { label: 'Price', value: { type: 'money', value: { amount: 18000, currency: 'GBP' } } },
        { label: 'Booking required', value: { type: 'boolean', value: true } },
      ],
    })
    const shown = markdown
      .split('\n')
      .map((line) => (line === '' ? '//' : `// ${line}`))
      .join('\n')
    expect(README).toContain(shown)
  })

  it('uses absolute links only', () => {
    // Code spans and blocks describe rendered markdown (`[label](url)`); only
    // prose links are links on the npm page.
    const prose = README.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
    for (const [, target] of prose.matchAll(/\]\(([^)]+)\)/g)) {
      expect(target).toMatch(/^https:\/\//)
    }
  })
})
