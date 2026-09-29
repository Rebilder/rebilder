/**
 * Cloudflare Worker / edge adapter for @rebilder/gateway. Import from
 * '@rebilder/gateway/edge'. (ROADMAP Phase 1 P1 — "Express/Fastify +
 * Cloudflare Worker adapters".)
 *
 * Edge runtimes speak web-standard Request/Response natively, so this adapter
 * is a thin fetch-handler factory over the core — zero new dependencies, no
 * Cloudflare imports (the handler shape `(req) => Promise<Response>` IS the
 * contract; `export default { fetch }` satisfies a CF Worker's fetch handler
 * without any workers-types coupling; the same plain handler runs on Vercel
 * Edge, Deno Deploy, or any WinterCG runtime).
 *
 * Cloudflare Worker on a route (the standard reverse-proxy pattern):
 *
 * ```ts
 * // worker.ts — route e.g. store.example.com/*
 * import { createGatewayFetchHandler } from '@rebilder/gateway/edge'
 * import { gatewayConfig } from './gateway-config'
 *
 * export default { fetch: createGatewayFetchHandler(gatewayConfig) }
 * ```
 *
 * Non-markdown requests fall through to `options.fallback` when provided,
 * otherwise to `fetch(req)` — on a route-mounted CF Worker that forwards the
 * unmodified request to the merchant's origin, so browsers and crawlers get
 * the canonical HTML exactly as if the worker weren't there.
 *
 * Latency-budget note (README § Latency budget): this is the ONE adapter
 * where a network call happens, and only on the NON-markdown path — the
 * origin pass-through that would occur without the worker anyway. The
 * markdown path stays pure compute.
 */

import { handleRequest } from '../../core/handle'
import { withNegotiationHeaders } from '../../core/negotiation'
import { withMarkdownNotFound } from '../../core/not-found'
import type { GatewayConfig } from '../../core/types'

export interface GatewayFetchHandlerOptions {
  /**
   * Serves every non-markdown request (humans, crawlers, unmatched URLs).
   * Default: `fetch(req)` — the origin pass-through. Provide this when the
   * worker is not fronting an origin (e.g. Vercel Edge middleware-style
   * usage, or tests).
   */
  fallback?: (req: Request) => Response | Promise<Response>
}

/**
 * Build a fetch handler: `(req) => Promise<Response>`.
 *
 * - Markdown path (agent + matching source): the core markdown `Response`
 *   (`text/markdown; charset=utf-8`, `Vary: Accept`, `X-Rebilder-Path:
 *   markdown`); no network touched.
 * - Everything else — including a gateway-internal error, which is contained
 *   like every other failure (the merchant's site must keep serving) —
 *   `options.fallback(req)` when provided, else `fetch(req)` to the origin.
 */
export function createGatewayFetchHandler(
  config: GatewayConfig,
  options: GatewayFetchHandlerOptions = {},
): (req: Request) => Promise<Response> {
  const { fallback } = options
  return async (req: Request): Promise<Response> => {
    let response: Response | null = null
    try {
      response = await handleRequest(req, config)
    } catch {
      response = null // contained: a gateway failure serves the origin, not a 500
    }
    if (response !== null) return response
    // The HTML half of a negotiated URL has to declare the negotiation too, or
    // a shared cache can serve it to an agent (core/negotiation.ts). A worker
    // sits in front of a CDN more often than not, so this adapter is the one
    // where getting it wrong bites hardest.
    const url = new URL(req.url)
    const passed = fallback !== undefined ? await fallback(req) : await fetch(req)
    // With `config.notFound`, the origin's 404 or 410 to a markdown request
    // comes back as the markdown 404 with the same status (core/not-found.ts).
    const answered = withMarkdownNotFound(config, req, passed)
    if (answered !== passed) return answered
    return withNegotiationHeaders(passed, config, url)
  }
}
