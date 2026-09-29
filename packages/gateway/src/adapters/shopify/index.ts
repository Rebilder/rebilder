/**
 * Shopify App Proxy adapter for @rebilder/gateway. Import from
 * '@rebilder/gateway/shopify'. (ROADMAP Phase 1 P0 — "largest reachable
 * merchant pool".)
 *
 * A Shopify App Proxy exposes a subpath on the merchant's own storefront
 * domain (default `/apps/rebilder/...`) whose requests Shopify forwards
 * server-side to a URL we host. Shopify appends query params (`shop`,
 * `path_prefix`, `timestamp`, `logged_in_customer_id`) plus `signature`: a
 * hex HMAC-SHA256, keyed with the app's shared secret, over the OTHER params
 * canonicalized as sorted `key=value` strings concatenated with no separator
 * (values of a repeated key joined with ',').
 *
 * Security model — never serve content on an unverified proxy request:
 * 1. Signature verified with Web Crypto (`crypto.subtle` — edge-safe, no
 *    node:crypto) and a constant-time comparison; failure → 401 JSON.
 * 2. Timestamp freshness: older than 90s (with ±5s clock-skew tolerance)
 *    → 401 JSON, bounding the replay window of a captured signed URL.
 *
 * Only then is the canonical storefront URL reconstructed (strip the proxy
 * `pathPrefix`, drop Shopify's injected params, host from the signed `shop`
 * param) and handed to the core `handleRequest`. The app proxy IS the
 * endpoint — there is no downstream HTML to fall through to — so a null
 * pass-through becomes 404 JSON `{ "error": "no_source" }` here.
 *
 * Zero new dependencies: Web Crypto is ambient in every supported runtime.
 */

import { handleRequest } from '../../core/handle'
import { jsonErrorResponse, stripPathPrefix } from '../../core/http'
import type { GatewayConfig } from '../../core/types'

/** Default storefront subpath prefix (Partners config: subpath prefix `apps`, subpath `rebilder`). */
const DEFAULT_PATH_PREFIX = '/apps/rebilder'

/** Query params Shopify injects on proxied requests; stripped before source resolution. */
const SHOPIFY_INJECTED_PARAMS = [
  'shop',
  'path_prefix',
  'timestamp',
  'signature',
  'logged_in_customer_id',
] as const

/** Reject proxied requests whose signed timestamp is older than this. */
const MAX_TIMESTAMP_AGE_SECONDS = 90
/** Tolerated clock skew between Shopify and us, in either direction. */
const CLOCK_SKEW_SECONDS = 5

/**
 * A config chosen per request, from the URL the signature already covered.
 *
 * A merchant self-hosting this adapter has one store and passes a plain
 * `GatewayConfig`. A host serving many merchants behind one app — the app
 * proxy's `shop` param is the tenant — cannot, because the config depends on
 * which store asked. This is the whole reason the parameter is a union.
 *
 * IT RUNS ONLY AFTER VERIFICATION, WHICH IS THE POINT. The resolver is where a
 * multi-tenant host does its database lookup, so calling it before the
 * signature and timestamp checks would let an unauthenticated stranger drive a
 * query per request. The URL it receives has already been verified and
 * canonicalised, so `url.hostname` is the signed `shop` value and can be
 * trusted as the tenant key.
 */
export type GatewayConfigResolver = (
  url: URL,
  req: Request,
) => GatewayConfig | null | Promise<GatewayConfig | null>

export interface ShopifyAppProxyOptions {
  /**
   * The Shopify app's shared secret (Partners dashboard → app → "Client
   * secret") — the HMAC key for `signature`. Provide it via env; never
   * hardcode it.
   */
  sharedSecret: string
  /**
   * The storefront subpath prefix as it appears in the request path this
   * handler receives. Stripped (whole segments only) before consulting
   * sources, so `/apps/rebilder/products/x` resolves as `/products/x`. If the
   * proxied path already arrives canonical, the strip is a no-op.
   * Default: '/apps/rebilder'.
   */
  pathPrefix?: string
}

const encoder = new TextEncoder()

/**
 * Shopify's app-proxy canonical message: all query params except `signature`,
 * as `key=value` with values of a repeated key joined by ',', sorted, then
 * concatenated with no separator. Values are the decoded forms.
 */
function canonicalMessage(params: URLSearchParams): string {
  const byKey = new Map<string, string[]>()
  for (const [key, value] of params) {
    if (key === 'signature') continue
    const values = byKey.get(key)
    if (values === undefined) byKey.set(key, [value])
    else values.push(value)
  }
  return [...byKey.entries()]
    .map(([key, values]) => `${key}=${values.join(',')}`)
    .sort()
    .join('')
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Constant-time string comparison — no early exit on the first differing char. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Verify a Shopify app-proxy `signature` query param against the app's shared
 * secret. Web Crypto only (edge-safe); the comparison is constant-time.
 * Exported for reuse (e.g. verifying proxied webhook-style pings on other
 * routes before this adapter's handler shape fits).
 */
export async function verifyAppProxySignature(url: URL, sharedSecret: string): Promise<boolean> {
  const provided = url.searchParams.get('signature')
  if (provided === null || provided.length === 0) return false
  const expected = await hmacSha256Hex(sharedSecret, canonicalMessage(url.searchParams))
  return timingSafeEqual(expected, provided.toLowerCase())
}

/** Freshness of the signed `timestamp` param (unix seconds), replay-bounding. */
function timestampIsFresh(raw: string | null, nowSeconds: number): boolean {
  if (raw === null || !/^\d+$/.test(raw)) return false
  const age = nowSeconds - Number(raw)
  return age <= MAX_TIMESTAMP_AGE_SECONDS + CLOCK_SKEW_SECONDS && age >= -CLOCK_SKEW_SECONDS
}

/**
 * Reconstruct the canonical storefront URL the buyer-side agent asked for:
 * strip the proxy path prefix, drop Shopify's injected params (merchant query
 * params are preserved), and put the URL on the shop's own domain — `shop` is
 * covered by the verified signature, so it is trustworthy here. Sources and
 * emitted events therefore see the same canonical URLs as every other adapter.
 */
function canonicalStorefrontUrl(url: URL, pathPrefix: string): URL {
  const canonical = new URL(url.href)
  const shop = url.searchParams.get('shop')
  canonical.pathname = stripPathPrefix(canonical.pathname, pathPrefix)
  for (const param of SHOPIFY_INJECTED_PARAMS) {
    canonical.searchParams.delete(param)
  }
  if (shop !== null && shop.length > 0) {
    canonical.protocol = 'https:'
    canonical.host = shop
    canonical.port = ''
  }
  return canonical
}

/**
 * Build the app-proxy endpoint handler: `(req) => Promise<Response>`.
 *
 * `config` is either a `GatewayConfig` (one store — the self-hosting merchant)
 * or a `GatewayConfigResolver` called with the verified canonical URL (many
 * stores behind one app). See that type for why the resolver runs where it
 * does.
 *
 * - Invalid or missing signature → 401 `{ "error": "invalid_signature" }`.
 *   Never serves content on an unverified proxy request.
 * - Stale/missing signed timestamp → 401 `{ "error": "stale_timestamp" }`.
 * - Verified request → core `handleRequest` against the reconstructed
 *   canonical storefront URL: agent traffic with a matching source gets the
 *   standard markdown response (and emits the standard event); every null
 *   pass-through — no source matched, source returned null/threw, a resolver
 *   that recognised no tenant, or a non-agent requester — becomes 404
 *   `{ "error": "no_source" }`, because the proxy is the endpoint and there is
 *   no downstream HTML to fall through to.
 */
export function createShopifyAppProxyHandler(
  config: GatewayConfig | GatewayConfigResolver,
  options: ShopifyAppProxyOptions,
): (req: Request) => Promise<Response> {
  const { sharedSecret, pathPrefix = DEFAULT_PATH_PREFIX } = options
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)

    if (!(await verifyAppProxySignature(url, sharedSecret))) {
      return jsonErrorResponse(
        401,
        'invalid_signature',
        'Shopify app proxy signature verification failed.',
      )
    }

    if (!timestampIsFresh(url.searchParams.get('timestamp'), Date.now() / 1000)) {
      return jsonErrorResponse(
        401,
        'stale_timestamp',
        'Shopify app proxy timestamp is missing, malformed, or outside the freshness window.',
      )
    }

    const canonical = canonicalStorefrontUrl(url, pathPrefix)
    const proxied = new Request(canonical, { method: req.method, headers: req.headers })

    // Resolution happens here and not a line earlier: everything above is the
    // authentication, and a multi-tenant resolver is a database read.
    const resolved = typeof config === 'function' ? await config(canonical, proxied) : config
    const response = resolved === null ? null : await handleRequest(proxied, resolved)
    return (
      response ?? jsonErrorResponse(404, 'no_source', 'No gateway source matched this path.')
    )
  }
}
