import { describe, expect, it } from 'vitest'
import type { DocumentAccess, DocumentSource } from '../src/index'
import { renderDocumentMarkdown } from '../src/index'
import { newsArticle } from './fixtures/documents'

/**
 * The access gate.
 *
 * `sections` is emitted only when access is 'free'. This is mechanical, not a
 * prose rule, and the tests are written to hold it that way: the gated fixture
 * bodies are sentinel strings that exist for no other reason, so any path that
 * reaches them fails the suite regardless of how it reached them.
 *
 * The failure this prevents is not hypothetical. A publisher wiring a
 * `document` source over a metered archive is exactly the merchant who will
 * ship us full bodies and expect the renderer to know better — and a renderer
 * that leaks one is a renderer that made us the party that published the
 * paywalled text.
 */

const GATED: DocumentAccess[] = ['registered', 'metered', 'subscriber']

const SENTINEL = 'PAYWALLED BODY — if this string ever appears in rendered output'

describe('access gate', () => {
  it('emits sections when access is free', () => {
    const free: DocumentSource = { ...newsArticle, access: 'free' }
    const out = renderDocumentMarkdown(free)
    expect(out).toContain('## The vote')
    expect(out).toContain(SENTINEL)
    expect(out).not.toContain('*Full text is not served to agents')
  })

  it('emits sections when access is absent (default free)', () => {
    const noAccess: DocumentSource = { ...newsArticle }
    delete noAccess.access
    expect(renderDocumentMarkdown(noAccess)).toContain('## The vote')
  })

  for (const access of GATED) {
    describe(`access: ${access}`, () => {
      const doc: DocumentSource = { ...newsArticle, access }
      const out = renderDocumentMarkdown(doc)

      it('never emits any section body', () => {
        expect(out).not.toContain(SENTINEL)
        expect(out).not.toContain('PAYWALLED LEDE')
        expect(out).not.toContain('## The vote')
      })

      it('still emits the summary, facts, and actions the merchant published', () => {
        expect(out).toContain('# [Port expansion clears final review]')
        expect(out).toContain('> The council approved the third berth after a two-year review.')
        expect(out).toContain('- **Updated:** 2026-07-30T09:15:00Z')
        expect(out).toContain('- **Byline:** A. Okonkwo')
        expect(out).toContain('- **Reading time:** 6 minutes')
      })

      it('emits the fixed access notice, naming the level', () => {
        expect(out).toContain('*Full text is not served to agents at this URL (access:')
        expect(out).toMatch(/\(access: (registration required|metered|subscription required)\)/)
      })

      it('still emits related links — they are not the gated substance', () => {
        expect(out).toContain('## Related')
      })
    })
  }

  it('holds at every budget, so no truncation path can reveal a body', () => {
    for (const access of GATED) {
      const doc: DocumentSource = { ...newsArticle, access }
      for (let maxBytes = 32; maxBytes <= 2048; maxBytes += 16) {
        const out = renderDocumentMarkdown(doc, { maxBytes })
        expect(out.includes(SENTINEL), `${access} @ ${String(maxBytes)}`).toBe(false)
        expect(out.includes('PAYWALLED LEDE'), `${access} @ ${String(maxBytes)}`).toBe(false)
      }
    }
  })

  it('holds when the gated document has nothing but sections', () => {
    const bodyOnly: DocumentSource = {
      url: 'https://dispatch.example.com/x',
      title: 'X',
      access: 'subscriber',
      sections: [{ heading: 'All of it', body: SENTINEL }],
    }
    const out = renderDocumentMarkdown(bodyOnly)
    expect(out).not.toContain(SENTINEL)
    expect(out).not.toContain('All of it')
    expect(out).toContain('*Full text is not served to agents at this URL (access: subscription required).*')
  })
})
