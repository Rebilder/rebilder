/**
 * Next.js adapter for @rebilder/gateway. Import from '@rebilder/gateway/next'.
 *
 * Deliberately imports NOTHING from `next`: Next middleware/proxy handlers
 * and app-router route handlers accept and return web-standard
 * Request/Response, so standard types are the whole contract and the adapter
 * adds zero dependency weight (this repo's apps use the Next 16 `proxy.ts`
 * convention; the same code works in a Next 15 `middleware.ts`).
 *
 * Middleware / proxy.ts. The wiring is four lines and never changes; the work
 * is the `sources` block in your config, which maps your URLs onto your own
 * source of truth.
 *
 * ```ts
 * // proxy.ts (Next 16) or middleware.ts (Next ≤15)
 * import { NextResponse } from 'next/server'
 * import { createGatewayProxy } from '@rebilder/gateway/next'
 * import { gatewayConfig } from './lib/gateway-config'
 *
 * export default createGatewayProxy(gatewayConfig, () => NextResponse.next())
 * ```
 *
 * Then check it, before you call it done:
 * `npx rebilder diff https://your-store.example/products/x`
 *
 * Optional dedicated markdown route (always-markdown preview/permalink):
 *
 * ```ts
 * // app/md/[[...path]]/route.ts
 * import { createGatewayRouteHandler } from '@rebilder/gateway/next'
 * import { gatewayConfig } from '../../../lib/gateway-config'
 *
 * export const GET = createGatewayRouteHandler(gatewayConfig, { stripPrefix: '/md' })
 * ```
 */

import { classifyRequest } from '../../core/classify'
import { buildEvent, emitEvent } from '../../core/events'
import { handleRequest, accessRuntimeFor } from '../../core/handle'
import { evaluateAccess, accessDeniedResponse } from '../../core/access'
import { jsonErrorResponse, stripPathPrefix } from '../../core/http'
import { generateLlmsTxt, type LlmsTxtOptions } from '../../core/llms-txt'
import { markdownAlternate, withNegotiationHeaders } from '../../core/negotiation'
import { markdownResponse, resolveMarkdownWithSource } from '../../core/render'
import { generateSitemapMd, type SitemapMdOptions } from '../../core/sitemap-md'
import type { GatewayConfig } from '../../core/types'

/**
 * Build the middleware/proxy entry point.
 *
 * **Pass `fallthrough` if you can.** Given it, the proxy always returns a
 * `Response` and the HTML half of every negotiated URL gets `Vary: Accept`
 * (and, when your config has a `match` router, a `Link: rel="alternate"`
 * pointing at the markdown). Without it the proxy returns `null` for
 * non-markdown traffic and those headers are yours to add — see
 * `withNegotiationHeaders`.
 *
 * ```ts
 * // preferred: one call, correct caching headers on both representations
 * const gateway = createGatewayProxy(config, (req) => updateSession(req))
 * export const proxy = gateway
 *
 * // still supported: you own the fallthrough, and the headers with it
 * const gateway = createGatewayProxy(config)
 * export async function proxy(req: NextRequest) {
 *   return (await gateway(req)) ?? withNegotiationHeaders(NextResponse.next(), config, new URL(req.url))
 * }
 * ```
 *
 * The overload exists because the one-argument form is published API and
 * merchants are running it; this adds the correct path without breaking them.
 * Classification, source resolution, event emission and failure containment
 * are all `handleRequest` semantics — the merchant's site keeps serving HTML
 * no matter what a source does.
 */
export function createGatewayProxy(
  config: GatewayConfig,
): (req: Request) => Promise<Response | null>
export function createGatewayProxy(
  config: GatewayConfig,
  fallthrough: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response>
export function createGatewayProxy(
  config: GatewayConfig,
  fallthrough?: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response | null> {
  return async (req: Request) => {
    const served = await handleRequest(req, config)
    if (served !== null) return served
    if (fallthrough === undefined) return null
    return withNegotiationHeaders(await fallthrough(req), config, new URL(req.url))
  }
}

export { withNegotiationHeaders } from '../../core/negotiation'

export interface GatewayRouteHandlerOptions {
  /**
   * Route prefix to strip from the pathname before consulting sources, so a
   * dedicated route like `app/md/[[...path]]/route.ts` can resolve
   * `/md/products/x` with sources keyed by canonical paths (`/products/x`).
   * Matched on whole path segments only. Default: strip nothing.
   */
  stripPrefix?: string
}

/**
 * Build a GET route handler that ALWAYS renders markdown for the requested
 * path, regardless of who is asking — a stable markdown permalink agents can
 * be pointed at, and the "what agents see" preview URL. (The cloaking
 * guardrail is about serving different substance on the SAME URL; a dedicated
 * markdown route is its own URL, so crawlers indexing it just see markdown.)
 *
 * - Source match → 200 markdown response (same headers as the middleware
 *   path) + a 'markdown' RebilderEventV0 when `onEvent` is configured.
 * - No source match (including a source that returned null or threw) →
 *   404 `application/json` body `{ "error": "not_found" }`; one unsourced event.
 */
export function createGatewayRouteHandler(
  config: GatewayConfig,
  options: GatewayRouteHandlerOptions = {},
): (req: Request) => Promise<Response> {
  const { stripPrefix } = options
  return async (req: Request): Promise<Response> => {
    const start = performance.now()
    const url = new URL(req.url)
    if (stripPrefix !== undefined) {
      url.pathname = stripPathPrefix(url.pathname, stripPrefix)
    }

    const detection = classifyRequest(req).detection
    if (config.access !== undefined) {
      const runtime = accessRuntimeFor(config)
      const verdict = evaluateAccess(runtime.policy(), detection, runtime.limiter, Date.now())
      if (!verdict.allowed) {
        emitEvent(
          config,
          buildEvent({
            storeId: config.storeId,
            detection,
            url: url.href,
            accept: req.headers.get('accept') ?? undefined,
            path: 'denied',
            coverage: 'not-applicable',
            renderMs: performance.now() - start,
          }),
        )
        return accessDeniedResponse(verdict)
      }
    }
    const resolution = await resolveMarkdownWithSource(url, config)
    emitEvent(
      config,
      buildEvent({
        storeId: config.storeId,
        detection,
        url: url.href,
        accept: req.headers.get('accept') ?? undefined,
        referrer: req.headers.get('referer') ?? undefined,
        diagnostic: req.headers.get('user-agent')?.startsWith('rebilder-install-check/') === true,
        path: 'markdown',
        profile: resolution?.profile,
        source: resolution?.source ?? 'none',
        coverage: resolution === null ? 'unsourced' : 'sourced',
        renderMs: performance.now() - start,
      }),
    )
    if (resolution === null) {
      return jsonErrorResponse(404, 'not_found', 'No gateway source matched this path.')
    }
    return markdownResponse(resolution.markdown, undefined, resolution.profile)
  }
}

/**
 * Build a GET route handler serving the store's llms.txt (see
 * core/llms-txt.ts for the generation contract and the honest scope note —
 * llms.txt is shipped because it is cheap, it is NOT the strategy).
 *
 * ```ts
 * // app/llms.txt/route.ts
 * import { createLlmsTxtRouteHandler } from '@rebilder/gateway/next'
 * import { gatewayConfig } from '../../lib/gateway-config'
 *
 * export const GET = createLlmsTxtRouteHandler(gatewayConfig, {
 *   baseUrl: 'https://store.example.com',
 *   siteName: 'Acme Outdoors',
 *   description: 'Trail footwear and gear, shipped from Bend, OR.',
 * })
 * ```
 *
 * Responses are `text/plain; charset=utf-8` with long shared-cache headers
 * (`s-maxage=3600`) — the output is deterministic, so caching hard is safe.
 */
export function createLlmsTxtRouteHandler(
  config: GatewayConfig,
  options: LlmsTxtOptions,
): (req: Request) => Promise<Response> {
  return async (): Promise<Response> => {
    const body = await generateLlmsTxt(config, options)
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
      },
    })
  }
}

/**
 * Build a GET route handler serving `/sitemap.md` (see core/sitemap-md.ts):
 * the site's pages as markdown links, `text/markdown; charset=utf-8`, with the
 * same cache headers as llms.txt.
 *
 * ```ts
 * // app/sitemap.md/route.ts
 * import { createSitemapMdRouteHandler } from '@rebilder/gateway/next'
 * import { gatewayConfig } from '../../lib/gateway-config'
 *
 * export const GET = createSitemapMdRouteHandler(gatewayConfig, {
 *   baseUrl: 'https://store.example.com',
 * })
 * ```
 */
export function createSitemapMdRouteHandler(
  config: GatewayConfig,
  options: SitemapMdOptions,
): (req: Request) => Promise<Response> {
  return async (): Promise<Response> => {
    const body = await generateSitemapMd(config, options)
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'cache-control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
      },
    })
  }
}

/**
 * The page's markdown alternate in the shape Next.js metadata takes, for
 * `alternates.types`. Next renders it as
 * `<link rel="alternate" type="text/markdown" href="…">`. `undefined` when the
 * config's `match` router does not confirm a source for the URL, so a page
 * never advertises markdown it cannot serve.
 *
 * ```ts
 * export const metadata: Metadata = {
 *   alternates: {
 *     canonical: 'https://example.com/services/bike-fitting',
 *     types: markdownAlternateTypes(gatewayConfig, 'https://example.com/services/bike-fitting'),
 *   },
 * }
 * ```
 */
export function markdownAlternateTypes(
  config: GatewayConfig,
  url: string | URL,
): { 'text/markdown': string } | undefined {
  const alternate = markdownAlternate(config, url)
  return alternate === null ? undefined : { 'text/markdown': alternate.href }
}
