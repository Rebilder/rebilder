/**
 * GatewayConfig.protocols hook — the additive wiring point for
 * @rebilder/protocols (which the gateway deliberately does NOT depend on;
 * the merchant constructs the handler and passes it in).
 *
 * Contract under test: invoked only when the request classifies onto the
 * 'protocol' path; a returned Response is served with the event recording
 * response.path 'protocol' + measured render_ms; null (or no hook, or a
 * throw) preserves the existing pass-through behavior exactly.
 */

import { describe, expect, it } from 'vitest'
import type { RebilderEventV0 } from '@rebilder/events'
import { handleRequest, type GatewayConfig } from '../src/index'
import {
  BROWSER_CHROME_HEADERS,
  CLAUDE_CODE_HEADERS,
  PDP_PATH,
  PROTOCOL_CLIENT_HEADERS,
  STORE_ORIGIN,
  makeRequest,
  pathMatchedSources,
} from './fixtures'

function protocolResponse(): Response {
  return new Response(JSON.stringify({ spec_version: 'v0', protocol: 'ucp' }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-rebilder-protocol': 'ucp/v0',
    },
  })
}

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { storeId: 'store_test', sources: pathMatchedSources(), ...overrides }
}

describe('protocols hook — wired response', () => {
  it('serves the hook response verbatim on a protocol route', async () => {
    const served = protocolResponse()
    const res = await handleRequest(
      makeRequest('/.well-known/ucp', PROTOCOL_CLIENT_HEADERS),
      config({ protocols: async () => served }),
    )
    expect(res).toBe(served) // the exact Response instance — no re-wrapping
    expect(res!.headers.get('x-rebilder-protocol')).toBe('ucp/v0')
  })

  it('passes the request through to the hook untouched', async () => {
    let seen: Request | undefined
    const req = makeRequest('/mcp', PROTOCOL_CLIENT_HEADERS)
    await handleRequest(
      req,
      config({
        protocols: async (r) => {
          seen = r
          return protocolResponse()
        },
      }),
    )
    expect(seen).toBe(req)
  })

  it('never invokes the hook off the protocol path (markdown and html unaffected)', async () => {
    let calls = 0
    const cfg = config({
      protocols: async () => {
        calls++
        return protocolResponse()
      },
    })
    const markdown = await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), cfg)
    expect(markdown!.headers.get('x-rebilder-path')).toBe('markdown')
    expect(await handleRequest(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS), cfg)).toBeNull()
    expect(calls).toBe(0)
  })
})

describe('protocols hook — null / unset fallback (existing behavior unchanged)', () => {
  it('hook answers null → pass-through (null), same as before the hook existed', async () => {
    let calls = 0
    const res = await handleRequest(
      makeRequest('/mcp', PROTOCOL_CLIENT_HEADERS),
      config({
        protocols: async () => {
          calls++
          return null
        },
      }),
    )
    expect(res).toBeNull()
    expect(calls).toBe(1)
  })

  it('no hook configured → pass-through (null), byte-for-byte the Phase 0 behavior', async () => {
    expect(
      await handleRequest(makeRequest('/.well-known/ucp', PROTOCOL_CLIENT_HEADERS), config()),
    ).toBeNull()
  })

  it('a throwing hook is contained to a pass-through — never a 500 on the merchant site', async () => {
    const res = await handleRequest(
      makeRequest('/mcp', PROTOCOL_CLIENT_HEADERS),
      config({
        protocols: async () => {
          throw new Error('protocol adapter bug')
        },
      }),
    )
    expect(res).toBeNull()
  })

  it('a rejecting hook leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', listener)
    try {
      const res = await handleRequest(
        makeRequest('/mcp', PROTOCOL_CLIENT_HEADERS),
        config({ protocols: () => Promise.reject(new Error('async adapter bug')) }),
      )
      expect(res).toBeNull()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', listener)
    }
  })
})

describe('protocols hook — event shape', () => {
  function collecting(protocols?: GatewayConfig['protocols']): {
    cfg: GatewayConfig
    events: RebilderEventV0[]
  } {
    const events: RebilderEventV0[] = []
    const cfg = config({ protocols, onEvent: (event) => void events.push(event) })
    return { cfg, events }
  }

  it('a served protocol response emits exactly one event: path protocol, measured render_ms', async () => {
    const { cfg, events } = collecting(async () => protocolResponse())
    await handleRequest(makeRequest('/.well-known/ucp', PROTOCOL_CLIENT_HEADERS), cfg)
    expect(events).toHaveLength(1)
    const event = events[0]!
    expect(event.store_id).toBe('store_test')
    expect(event.requester.kind).toBe('protocol')
    expect(event.request.url).toBe(`${STORE_ORIGIN}/.well-known/ucp`)
    expect(event.response.path).toBe('protocol')
    expect(typeof event.response.render_ms).toBe('number')
    expect(Number.isFinite(event.response.render_ms)).toBe(true)
    expect(event.response.render_ms).toBeGreaterThanOrEqual(0)
    expect(event.outcome).toBeUndefined()
  })

  it('render_ms covers the hook itself (a slow adapter shows up in the event)', async () => {
    const { cfg, events } = collecting(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      return protocolResponse()
    })
    await handleRequest(makeRequest('/mcp', PROTOCOL_CLIENT_HEADERS), cfg)
    expect(events[0]!.response.render_ms).toBeGreaterThanOrEqual(20)
  })

  it('null fallback still emits the protocol-path event (demand stays visible)', async () => {
    const { cfg, events } = collecting(async () => null)
    await handleRequest(makeRequest('/mcp', PROTOCOL_CLIENT_HEADERS), cfg)
    expect(events).toHaveLength(1)
    expect(events[0]!.response.path).toBe('protocol')
  })

  it('a throwing hook still emits the protocol-path event', async () => {
    const { cfg, events } = collecting(async () => {
      throw new Error('adapter bug')
    })
    await handleRequest(makeRequest('/mcp', PROTOCOL_CLIENT_HEADERS), cfg)
    expect(events).toHaveLength(1)
    expect(events[0]!.response.path).toBe('protocol')
  })
})
