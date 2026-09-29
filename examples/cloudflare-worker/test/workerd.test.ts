/**
 * The template, running in workerd: Cloudflare's own runtime, started locally
 * by wrangler (already a devDependency, so this adds nothing to install).
 *
 * `worker.test.ts` runs the same handler under Node with `fetch` stubbed. That
 * proves the logic; it cannot prove the bundle. Here wrangler bundles
 * `src/index.ts` exactly as `wrangler deploy` would, and workerd executes it
 * with the Workers runtime's own `Request`, `Response`, `Headers` and `fetch`.
 * A Node-only API anywhere on the gateway's edge path, or a module the bundler
 * cannot resolve, fails here.
 *
 * Two builds run the same assertions:
 *
 *  - PUBLISHED: `wrangler.jsonc` as shipped, bundling the `@rebilder/gateway`
 *    release from npm that this template pins. This is what a merchant deploys.
 *  - WORKSPACE: `test/workspace-gateway/wrangler.jsonc`, which aliases the
 *    gateway's `./edge` adapter and its three runtime dependencies to their
 *    source in this monorepo, so an unreleased change to the edge adapter runs
 *    in workerd before it ships. Skipped when the template has been copied out
 *    of the monorepo, because then there is no workspace source to test.
 *
 * The pass-through runs against a real HTTP origin on localhost: the
 * route-mounted handler forwards `fetch(req)` to the request's own URL, so a
 * request addressed to the local origin reaches it through workerd's network
 * stack.
 */
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unstable_startWorker } from 'wrangler'

const ORIGIN_HTML = '<!doctype html><title>Origin</title>'

const PUBLISHED_CONFIG = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url))
const WORKSPACE_CONFIG = fileURLToPath(
  new URL('./workspace-gateway/wrangler.jsonc', import.meta.url),
)
const WORKSPACE_GATEWAY = fileURLToPath(
  new URL('../../../packages/gateway/src/adapters/edge/index.ts', import.meta.url),
)

let origin: Server
let originUrl: string

beforeAll(async () => {
  origin = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(ORIGIN_HTML)
  })
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
  originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => origin?.close(() => resolve()))
})

function suite(label: string, config: string): void {
  describe(label, () => {
    let worker: Awaited<ReturnType<typeof unstable_startWorker>>

    beforeAll(async () => {
      worker = await unstable_startWorker({
        config,
        dev: { server: { port: 0 }, inspector: false, logLevel: 'error' },
      })
    }, 60_000)

    afterAll(async () => {
      await worker?.dispose()
    })

    it('serves markdown to an agent from the edge', async () => {
      const res = await worker.fetch(`${originUrl}/services/bike-fitting`, {
        headers: { accept: 'text/markdown' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/markdown')
      expect(res.headers.get('vary')).toBe('Accept')
      const body = await res.text()
      expect(body).toContain('Bike fitting')
      expect(body).toContain('£180.00')
    })

    it('forwards a browser to the origin and marks the response as negotiated', async () => {
      const res = await worker.fetch(`${originUrl}/services/bike-fitting`, {
        headers: { accept: 'text/html,application/xhtml+xml' },
      })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe(ORIGIN_HTML)
      expect(res.headers.get('vary')?.toLowerCase()).toContain('accept')
      expect(res.headers.get('link') ?? '').toContain('rel="alternate"')
    })

    it('forwards Googlebot to the origin even when it asks for markdown', async () => {
      const res = await worker.fetch(`${originUrl}/services/bike-fitting`, {
        headers: {
          accept: 'text/markdown',
          'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        },
      })
      expect(await res.text()).toBe(ORIGIN_HTML)
    })
  })
}

suite('the template in workerd, with the published gateway', PUBLISHED_CONFIG)

if (existsSync(WORKSPACE_GATEWAY)) {
  suite('the template in workerd, with the workspace gateway', WORKSPACE_CONFIG)
} else {
  describe.skip('the template in workerd, with the workspace gateway (outside the monorepo)', () => {
    it('needs the Rebilder monorepo', () => {})
  })
}
