/**
 * The headers the HTML half of a negotiated URL has to carry.
 *
 * THE BUG THIS EXISTS FOR. The gateway sets `Vary: Accept` on the markdown it
 * serves, and the README tells merchants in as many words that "the same URL
 * serves HTML to browsers — caches must key on Accept". But the HTML response
 * does not come from the gateway. It comes from the merchant's app, carrying
 * whatever `Vary` their framework set — for Next, `rsc, next-router-state-tree,
 * …` and no `Accept` at all. So exactly one of the two representations at a
 * negotiated URL announced that it was negotiated, and it was the half we
 * happened to write.
 *
 * That is a cache-poisoning shape, not a cosmetic gap. A shared cache that
 * stores the HTML under a key without `Accept` can hand that HTML to an agent
 * that asked for markdown — or, with the entries the other way round, hand raw
 * markdown to a customer's browser. It surfaces weeks later, through a CDN, as
 * "a shopper saw a wall of asterisks on our product page".
 *
 * Documenting the rule and shipping adapters that break it is the worst of the
 * available combinations, so the adapters do it now and the merchant does not
 * have to know the rule exists.
 *
 * WHY THE TWO HEADERS HAVE DIFFERENT CONDITIONS. They are different kinds of
 * claim, and conflating them is how you end up lying in one direction to avoid
 * lying in the other:
 *
 *   `Vary: Accept` is a CORRECTNESS header, and it must never be
 *   under-declared. It is applied to every response the gateway middleware saw
 *   and passed on, whether or not a source matched today. That is not
 *   over-declaring: the middleware is mounted on this path, so this URL's
 *   representation genuinely does depend on Accept — a source added tomorrow
 *   must not be served out of a cache entry stored today. The cost of being
 *   generous is cache granularity on paths the merchant's own matcher already
 *   chose to route through us.
 *
 *   `Link: rel="alternate"` is an ADVERTISEMENT, and it must never be
 *   over-declared. Pointing an agent at a representation that does not exist is
 *   worse than staying silent — it converts "I didn't know" into "you lied". So
 *   it is emitted only when `sources.match` says this URL has a source. A
 *   config without a `match` router gets `Vary` and no `Link`, which is the
 *   honest answer when the only way to find out is to run the resolvers, and
 *   running them on every human request is exactly the edge-budget cost the
 *   router exists to avoid.
 */
import type { GatewayConfig } from './types'

/** The `Vary` token the markdown path already sets on its own responses. */
const VARY_TOKEN = 'Accept'

/**
 * True when this URL is known to have a markdown representation, WITHOUT
 * running any resolver. Pure and synchronous by construction: `sources.match`
 * is documented as pure and synchronous, and it is the only thing consulted.
 */
function hasKnownAlternate(config: GatewayConfig, url: URL): boolean {
  try {
    // Read inside the try: a sources object that throws on access (a proxy, a
    // getter over a missing module) must not break the HTML response either.
    const match = config.sources.match
    if (match === undefined) return false
    return match(url) !== null
  } catch {
    // A throwing router is a no-match everywhere else in this package; a
    // merchant's bad predicate must never break the HTML response.
    return false
  }
}

/**
 * The markdown alternate an HTML page should declare in its `<head>`, as
 * `<link rel="alternate" type="text/markdown" href="…">`, or null.
 *
 * Same condition and same target as the `Link` header on the pass-through
 * response: the `match` router must confirm a source, and `href` is the page's
 * own URL, where an agent that sends `Accept: text/markdown` gets the markdown.
 * One page therefore makes one claim, in the header and in the markup, and it
 * never claims a representation it cannot serve.
 *
 * Pure and synchronous: it is safe to call while rendering the page. A string
 * that does not parse as an absolute URL is null.
 */
export function markdownAlternate(
  config: GatewayConfig,
  url: string | URL,
): { rel: 'alternate'; type: 'text/markdown'; href: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!hasKnownAlternate(config, parsed)) return null
  return { rel: 'alternate', type: 'text/markdown', href: parsed.href }
}

/**
 * Merge the negotiation headers into a mutable `Headers`.
 *
 * `append`, never `set`: a framework's own `Vary` carries hints its routing
 * depends on (Next's RSC tokens are the live example), and replacing them to
 * add ours would trade one cache bug for another.
 *
 * Idempotent — calling it twice does not duplicate a token — because a
 * merchant who mounts the middleware twice, or wraps an already-decorated
 * response, should get a correct header rather than `Vary: Accept, Accept`.
 */
export function applyNegotiationHeaders(
  headers: Headers,
  config: GatewayConfig,
  url: URL,
): void {
  const vary = headers.get('vary')
  const declared = (vary ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== '')
  if (!declared.includes('*') && !declared.includes(VARY_TOKEN.toLowerCase())) {
    headers.append('Vary', VARY_TOKEN)
  }

  if (!hasKnownAlternate(config, url)) return
  const link = `<${url.href}>; rel="alternate"; type="text/markdown"`
  const existing = headers.get('link')
  if (existing === null || !existing.includes('rel="alternate"; type="text/markdown"')) {
    headers.append('Link', link)
  }
}

/**
 * Return a copy of `response` carrying the negotiation headers.
 *
 * A copy, because a `Response` from `fetch()` has immutable headers in
 * Workers and other web-standard runtimes; mutating in place works right up
 * until a merchant deploys to one of them. `new Response(body, response)`
 * preserves status, statusText and every existing header.
 *
 * A response with no body slot (204, 304) is returned untouched rather than
 * reconstructed — those cannot legally carry one, and the copy would throw.
 */
export function withNegotiationHeaders(
  response: Response,
  config: GatewayConfig,
  url: URL,
): Response {
  if (response.status === 204 || response.status === 304) {
    // Headers on these are still worth setting when they happen to be mutable,
    // and skipping is the safe answer when they are not.
    try {
      applyNegotiationHeaders(response.headers, config, url)
    } catch {
      /* immutable — a 304 without Vary is the pre-existing behaviour */
    }
    return response
  }
  const copy = new Response(response.body, response)
  applyNegotiationHeaders(copy.headers, config, url)
  return copy
}
