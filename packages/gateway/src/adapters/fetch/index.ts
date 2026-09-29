/**
 * Framework-neutral fetch middleware for @rebilder/gateway. Import from
 * '@rebilder/gateway/fetch'.
 *
 * Most modern server frameworks hand their middleware a web-standard `Request`
 * and a `next()` that produces the downstream `Response`: SvelteKit's `handle`,
 * Astro's `onRequest`, React Router's route middleware, Netlify Edge Functions,
 * Hono (via `c.req.raw`). One function of that shape covers all of them, so
 * this adapter imports nothing from any framework and adds no dependency.
 *
 * ```ts
 * import { createFetchMiddleware } from '@rebilder/gateway/fetch'
 * import { gatewayConfig } from './gateway-config'
 *
 * const gateway = createFetchMiddleware(gatewayConfig)
 *
 * // SvelteKit: src/hooks.server.ts
 * export const handle = ({ event, resolve }) => gateway(event.request, () => resolve(event))
 * ```
 *
 * The recipes for each framework live at https://rebilder.com/docs/adapters/fetch.
 *
 * SEMANTICS, which are `handleRequest`'s:
 *  - An agent asking for markdown on a URL a source answers gets the markdown
 *    `Response`, and `next` is never called.
 *  - Everything else calls `next()` exactly once and returns its response with
 *    the negotiation headers added: `Vary: Accept` always, and a
 *    `Link: rel="alternate"` when the config's `match` router knows the URL has
 *    a markdown representation (see core/negotiation.ts for why those two
 *    headers have different conditions).
 *  - A gateway failure falls through to `next()`. An error thrown by `next()`
 *    itself is the application's and propagates unchanged; swallowing it would
 *    hide the merchant's own bug behind ours.
 *
 * For frameworks that cannot hand back the downstream response (a Nitro
 * middleware, Vercel Routing Middleware), `negotiationHeaders` returns the
 * header pairs to append instead.
 */

import { handleRequest } from '../../core/handle'
import { applyNegotiationHeaders, withNegotiationHeaders } from '../../core/negotiation'
import { withMarkdownNotFound } from '../../core/not-found'
import type { GatewayConfig } from '../../core/types'

/** Produces the downstream response: the framework's own `next`/`resolve`. */
export type FetchNext = () => Response | Promise<Response>

/** `(request, next) => Promise<Response>`, the shape every adapter recipe mounts. */
export type FetchMiddleware = (request: Request, next: FetchNext) => Promise<Response>

/** Build the middleware. Build it once, at module scope, and mount the result. */
export function createFetchMiddleware(config: GatewayConfig): FetchMiddleware {
  return async (request: Request, next: FetchNext): Promise<Response> => {
    let served: Response | null = null
    try {
      served = await handleRequest(request, config)
    } catch {
      served = null // contained: a gateway failure serves the site, never a 500
    }
    if (served !== null) return served
    const downstream = await next()
    // With `config.notFound`, your own 404 or 410 to a markdown request comes
    // back as the markdown 404 with the same status (core/not-found.ts).
    const answered = withMarkdownNotFound(config, request, downstream)
    if (answered !== downstream) return answered
    return withNegotiationHeaders(downstream, config, new URL(request.url))
  }
}

/**
 * The negotiation headers a pass-through response at `url` should carry, as
 * `[name, value]` pairs to APPEND (never set: a framework's own `Vary` tokens
 * matter to its router).
 *
 * For hosts whose middleware cannot touch the downstream response and instead
 * sets headers up front: `appendResponseHeader` in a Nitro middleware, or
 * `next({ headers })` in Vercel Routing Middleware. `Vary` is a set, so
 * appending `Accept` to a response that already names it is harmless.
 */
export function negotiationHeaders(config: GatewayConfig, url: URL): Array<[string, string]> {
  const headers = new Headers()
  applyNegotiationHeaders(headers, config, url)
  return [...headers.entries()].map(([name, value]) => [
    name === 'vary' ? 'Vary' : name === 'link' ? 'Link' : name,
    value,
  ])
}

export { withNegotiationHeaders } from '../../core/negotiation'
export { handleRequest } from '../../core/handle'
export type { GatewayConfig } from '../../core/types'
