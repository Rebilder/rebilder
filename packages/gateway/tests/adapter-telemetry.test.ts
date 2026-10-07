import { describe, expect, it } from 'vitest'
import { createHttpEventSink, type RebilderEventV0 } from '@rebilder/events'
import { createGatewayProxy, createGatewayRouteHandler } from '../src/adapters/next/index'
import { createFetchMiddleware } from '../src/adapters/fetch/index'
import { createGatewayFetchHandler } from '../src/adapters/edge/index'
import { createGatewayMiddleware } from '../src/adapters/node/index'
import type { GatewayConfig } from '../src/index'
import { CLAUDE_CODE_HEADERS, PDP_PATH, makeRequest, pathMatchedSources } from './fixtures'

describe('adapter request lifetime and HTTP event sink', () => {
  it.each(['next-proxy', 'next-route', 'fetch', 'edge', 'node'])(
    '%s enqueues once and delivers when the host flushes its request lifetime',
    async (adapter) => {
      const delivered: RebilderEventV0[] = []
      const sink = createHttpEventSink({
        url: 'https://api.rebilder.com',
        apiKey: 'test-key',
        flushIntervalMs: 60_000,
        fetchImpl: (async (_url, init) => {
          delivered.push(...JSON.parse(String(init?.body)).events)
          return new Response('{}', { status: 202 })
        }) as typeof fetch,
      })
      const config: GatewayConfig = {
        storeId: 'store_test',
        sources: pathMatchedSources(),
        onEvent: sink.emit,
      }
      const request = makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS)
      const html = () => new Response('<html>')
      try {
        let status = 0
        if (adapter === 'next-proxy') status = (await createGatewayProxy(config)(request))!.status
        if (adapter === 'next-route')
          status = (await createGatewayRouteHandler(config)(request)).status
        if (adapter === 'fetch')
          status = (await createFetchMiddleware(config)(request, html)).status
        if (adapter === 'edge')
          status = (await createGatewayFetchHandler(config, { fallback: html })(request)).status
        if (adapter === 'node') {
          status = await new Promise<number>((resolve, reject) => {
            const res = { statusCode: 200, setHeader: () => {}, end: () => resolve(res.statusCode) }
            createGatewayMiddleware(config)(
              {
                url: PDP_PATH,
                method: 'GET',
                headers: {
                  host: 'store.example.com',
                  'x-forwarded-proto': 'https',
                  ...CLAUDE_CODE_HEADERS,
                },
              },
              res,
              () => reject(new Error('Unexpected pass-through')),
            )
          })
        }
        expect(status).toBe(200)
        expect(delivered).toHaveLength(0)
        // Next after()/waitUntil(), Worker waitUntil(), or process shutdown owns this promise.
        await sink.flush()
        expect(delivered).toHaveLength(1)
        expect(delivered[0]!.response).toMatchObject({ path: 'markdown', coverage: 'sourced' })
        await sink.flush()
        expect(delivered).toHaveLength(1)
      } finally {
        await sink.close()
      }
    },
  )
})
