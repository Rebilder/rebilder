/**
 * The Worker entry point. Deploy this unchanged.
 *
 * HOW THE PASS-THROUGH REACHES YOUR ORIGIN. Mounted on a Workers *route*
 * (`example.com/*`), the default `fetch(req)` inside the handler is a
 * subrequest to a URL this Worker itself serves — Cloudflare does not
 * re-invoke a Worker for its own subrequest to the same route, so the request
 * continues to your origin. That is the standard reverse-proxy pattern and it
 * needs no configuration.
 *
 * If you would rather not depend on that behaviour — or you are running this
 * Worker on a `workers.dev` subdomain in front of a origin somewhere else —
 * set the `ORIGIN` var in `wrangler.jsonc` and the handler rewrites the host
 * explicitly instead. Both paths are exercised by `test/worker.test.ts`.
 *
 * WHAT A FAILURE DOES. Nothing, from your visitors' point of view. A gateway
 * error, a malformed source, a resolver that throws — every one of them falls
 * through to the origin, because the site staying up outranks any markdown we
 * might have served.
 */
import { createGatewayFetchHandler } from '@rebilder/gateway/edge'
import { gatewayConfig } from './gateway-config'

export interface Env {
  /**
   * Optional. Hostname of your origin, e.g. `origin.example.com`. Leave unset
   * on a route-mounted Worker; set it when the Worker is not sitting directly
   * in front of the origin it should forward to.
   */
  ORIGIN?: string
}

/**
 * Forward to `env.ORIGIN`, preserving path, query, method, headers and body.
 * `redirect: 'manual'` so a 301 from the origin reaches the visitor as a 301
 * rather than being resolved inside the Worker.
 */
function forwardToOrigin(req: Request, origin: string): Promise<Response> {
  const url = new URL(req.url)
  url.hostname = origin
  url.port = ''
  return fetch(new Request(url, req), { redirect: 'manual' })
}

const routeMountedHandler = createGatewayFetchHandler(gatewayConfig)

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (env.ORIGIN === undefined || env.ORIGIN === '') {
      return routeMountedHandler(req)
    }
    // Built per-request only in the explicit-origin case, which is the
    // uncommon one; the default path uses the handler built at module scope.
    const handler = createGatewayFetchHandler(gatewayConfig, {
      fallback: (request) => forwardToOrigin(request, env.ORIGIN as string),
    })
    return handler(req)
  },
}
