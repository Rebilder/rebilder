/**
 * `.md` URL variants (`config.markdownUrls`): `/docs/setup.md` is the markdown
 * of `/docs/setup`.
 *
 * The mapping is purely syntactic and deliberately small, so a merchant can
 * predict it without reading this file:
 *
 *   /docs/setup.md   → /docs/setup
 *   /index.md        → /            (the root page has no name of its own)
 *   /docs/setup.md?x → /docs/setup?x (the query rides along, as it would on
 *                                     the page URL)
 *
 * Anything else is not a variant: `.MD`, an encoded `%2Emd`, a bare `/.md`,
 * `/docs/.md`. Only GET and HEAD are variants; a form POST to a `.md` path is
 * the application's business.
 *
 * Whether the variant is SERVED is decided by the sources, not here: the
 * gateway answers only when a source answers the page URL, and passes every
 * other `.md` request through so a real `.md` file keeps serving.
 */

const SUFFIX = '.md'

/** The page URL a `.md` request names, or null when the request is not one. */
export function markdownVariantPage(url: URL, method: string): URL | null {
  if (method !== 'GET' && method !== 'HEAD') return null
  const { pathname } = url
  if (!pathname.endsWith(SUFFIX)) return null
  const stem = pathname.slice(0, -SUFFIX.length)
  if (stem === '' || stem.endsWith('/')) return null
  const page = new URL(url.href)
  page.pathname = stem === '/index' ? '/' : stem
  return page
}
