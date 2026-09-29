/**
 * The gateway wiring. You usually do not need to change this file — edit
 * `content.ts` instead.
 *
 * WHAT THE ROUTER BUYS. Without `sources.match`, a URL that nothing matches
 * costs one call to every configured resolver before the gateway gives up and
 * passes through to your origin. With it, at most one resolver runs per
 * request. It must be pure and synchronous, because it is on the hot path —
 * it exists to turn several awaits into one, so it has to be cheaper than the
 * awaits it saves. Match on `url.pathname`; never do I/O here.
 */
import type { CollectionSource, DocumentSource, GatewayConfig, SourceKind } from '@rebilder/gateway'
import { COLLECTIONS, DOCUMENTS } from './content'

/**
 * Your store identifier. Stamped on every event the gateway emits. Any stable
 * string works; if you have a Rebilder account, use the ID from the Console so
 * the events line up with your dashboard.
 */
const STORE_ID = 'example-workshop'

/** Trailing slashes are a routing detail, not a different page. */
function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1)
  return pathname
}

export const gatewayConfig: GatewayConfig = {
  storeId: STORE_ID,

  sources: {
    match: (url: URL): SourceKind | null => {
      const path = normalize(url.pathname)
      if (DOCUMENTS.has(path)) return 'document'
      if (COLLECTIONS.has(path)) return 'collection'
      // `null` means "none of mine" — the gateway passes the request through
      // to your origin untouched, which is what you want for every page you
      // have not described yet.
      return null
    },

    document: (url: URL): DocumentSource | null => DOCUMENTS.get(normalize(url.pathname)) ?? null,

    collection: (url: URL): CollectionSource | null =>
      COLLECTIONS.get(normalize(url.pathname)) ?? null,
  },

  /**
   * Fire-and-forget. The gateway never awaits this and swallows anything it
   * throws, so it can neither slow a response nor break one.
   *
   * `console.log` lands in `wrangler tail` and in the Workers dashboard when
   * observability is on (see wrangler.jsonc). Point it at your own analytics,
   * or at Rebilder's ingest endpoint, when you want the traffic picture — but
   * do it with `ctx.waitUntil`, never inline: an await here is a network call
   * on the hot path, which is the one thing the latency budget forbids.
   */
  onEvent: (event) => {
    console.log(JSON.stringify(event))
  },
}
