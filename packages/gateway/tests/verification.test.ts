/**
 * GatewayConfig.verification — Web Bot Auth verification on the protocol path.
 *
 * Contract under test:
 * - unset → byte-for-byte pre-verification behavior (no clone, no headers);
 * - set → verifyWebBotAuth runs BEFORE the protocols hook (pure crypto over
 *   the injected registry, no network), the hook receives a cloned request
 *   with 'x-rebilder-agent-verified' ('true'/'false' + reason) overwriting
 *   any client-sent value, and the emitted event records requester.verified;
 * - unverified requests still reach the hook (read endpoints stay open —
 *   transactional gating belongs to the protocol handler);
 * - verification only ever runs on the protocol path.
 *
 * Signing uses SELF-GENERATED Ed25519 test vectors (no production keys —
 * the shipped KNOWN_AGENT_DIRECTORY is empty on purpose).
 */

import { beforeAll, describe, expect, it } from 'vitest'
import type { RebilderEventV0 } from '@rebilder/events'
import {
  AGENT_VERIFIED_HEADER,
  AGENT_VERIFIED_REASON_HEADER,
  KNOWN_AGENT_DIRECTORY,
  handleRequest,
  type AgentKeyRegistry,
  type GatewayConfig,
} from '../src/index'
import {
  CLAUDE_CODE_HEADERS,
  PDP_PATH,
  PROTOCOL_CLIENT_HEADERS,
  STORE_ORIGIN,
  makeRequest,
  pathMatchedSources,
} from './fixtures'

// ---------------------------------------------------------------------------
// Self-generated Ed25519 agent + request signer
// ---------------------------------------------------------------------------

const AGENT_ORIGIN = 'https://agent.example'
const KEYID = 'gw-test-key'

let privateKey: CryptoKey
let registry: AgentKeyRegistry

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  privateKey = pair.privateKey
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as { x?: string }
  registry = {
    [AGENT_ORIGIN]: {
      platform: 'chatgpt',
      keys: [
        {
          keyid: KEYID,
          alg: 'ed25519',
          publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x as string },
        },
      ],
    },
  }
})

/** A Web Bot Auth-signed protocol request (valid unless `tamper` is set). */
async function signedProtocolRequest(
  path: string,
  options: { tamperAuthority?: string; extraHeaders?: Record<string, string> } = {},
): Promise<Request> {
  const url = new URL(path, STORE_ORIGIN)
  const nowSec = Math.floor(Date.now() / 1000)
  const params =
    `("@authority" "signature-agent")` +
    `;created=${nowSec - 30};expires=${nowSec + 270};keyid="${KEYID}";alg="ed25519";tag="web-bot-auth"`
  const signatureAgent = `"${AGENT_ORIGIN}"`
  const base = [
    `"@authority": ${options.tamperAuthority ?? url.host}`,
    `"signature-agent": ${signatureAgent}`,
    `"@signature-params": ${params}`,
  ].join('\n')
  const signature = new Uint8Array(
    await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(base)),
  )
  return makeRequest(path, {
    ...PROTOCOL_CLIENT_HEADERS,
    'signature-agent': signatureAgent,
    'signature-input': `sig1=${params}`,
    signature: `sig1=:${btoa(String.fromCharCode(...signature))}:`,
    ...options.extraHeaders,
  })
}

function protocolResponse(): Response {
  return new Response(JSON.stringify({ spec_version: 'v0', protocol: 'ucp' }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

interface Captured {
  cfg: GatewayConfig
  events: RebilderEventV0[]
  seen: Request[]
}

function capturing(overrides: Partial<GatewayConfig> = {}): Captured {
  const events: RebilderEventV0[] = []
  const seen: Request[] = []
  const cfg: GatewayConfig = {
    storeId: 'store_test',
    sources: pathMatchedSources(),
    protocols: async (req) => {
      seen.push(req)
      return protocolResponse()
    },
    onEvent: (event) => void events.push(event),
    verification: { keys: registry },
    ...overrides,
  }
  return { cfg, events, seen }
}

// ---------------------------------------------------------------------------
// Unset → unchanged behavior
// ---------------------------------------------------------------------------

describe('verification unset — pre-verification behavior, byte for byte', () => {
  it('the hook receives the EXACT request instance, no verdict headers added', async () => {
    const { cfg, seen, events } = capturing({ verification: undefined })
    const req = await signedProtocolRequest('/.well-known/ucp')
    await handleRequest(req, cfg)
    expect(seen[0]).toBe(req) // no clone
    expect(seen[0]!.headers.get(AGENT_VERIFIED_HEADER)).toBeNull()
    expect(events[0]!.requester.verified).toBe(false)
  })

  it('STRIPS a client-sent verdict header, even with no verifier wired', async () => {
    // Security audit, Aug 2026. This previously passed the client's own
    // `x-rebilder-agent-verified: true` straight to the protocol handler as a
    // "documented tradeoff" — which meant a merchant who wired `protocols` but
    // forgot `verification` had a handler any client could claim verification
    // to. The verdict header is ours to set or to strip; a client may never
    // assert it. With a verifier wired it is overwritten; without one it is
    // removed. Either way the client's value never reaches the handler.
    const { cfg, seen } = capturing({ verification: undefined })
    await handleRequest(
      makeRequest('/mcp', {
        ...PROTOCOL_CLIENT_HEADERS,
        [AGENT_VERIFIED_HEADER]: 'true',
        [AGENT_VERIFIED_REASON_HEADER]: 'nonsense',
      }),
      cfg,
    )
    expect(seen[0]!.headers.get(AGENT_VERIFIED_HEADER)).toBeNull()
    expect(seen[0]!.headers.get(AGENT_VERIFIED_REASON_HEADER)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Set → verdict stamped, event recorded
// ---------------------------------------------------------------------------

describe('verification set — verified requests', () => {
  it('a validly signed request reaches the hook with x-rebilder-agent-verified: true', async () => {
    const { cfg, seen } = capturing()
    const res = await handleRequest(await signedProtocolRequest('/.well-known/ucp'), cfg)
    expect(res).not.toBeNull()
    expect(seen[0]!.headers.get(AGENT_VERIFIED_HEADER)).toBe('true')
    expect(seen[0]!.headers.get(AGENT_VERIFIED_REASON_HEADER)).toBeNull()
  })

  it('the event records requester.verified true and the verified platform identity', async () => {
    const { cfg, events } = capturing()
    await handleRequest(await signedProtocolRequest('/.well-known/ucp'), cfg)
    expect(events).toHaveLength(1)
    expect(events[0]!.requester.verified).toBe(true)
    expect(events[0]!.requester.platform).toBe('chatgpt') // from the registry entry
    expect(events[0]!.response.path).toBe('protocol')
  })

  it('a POST body survives the stamped clone', async () => {
    const { cfg, seen } = capturing()
    const url = new URL('/.well-known/ucp/v0/checkout', STORE_ORIGIN)
    const signed = await signedProtocolRequest('/.well-known/ucp/v0/checkout')
    const req = new Request(url, {
      method: 'POST',
      headers: signed.headers,
      body: JSON.stringify({ product_url: `${STORE_ORIGIN}${PDP_PATH}` }),
    })
    await handleRequest(req, cfg)
    expect(seen[0]!.method).toBe('POST')
    expect(await seen[0]!.json()).toEqual({ product_url: `${STORE_ORIGIN}${PDP_PATH}` })
  })
})

describe('verification set — unverified requests', () => {
  it('an unsigned protocol client still reaches the hook (read endpoints stay open), verdict false + reason', async () => {
    const { cfg, seen, events } = capturing()
    const res = await handleRequest(makeRequest('/mcp', PROTOCOL_CLIENT_HEADERS), cfg)
    expect(res).not.toBeNull() // the hook served — verification never blocks reads
    expect(seen).toHaveLength(1)
    expect(seen[0]!.headers.get(AGENT_VERIFIED_HEADER)).toBe('false')
    expect(seen[0]!.headers.get(AGENT_VERIFIED_REASON_HEADER)).toBe('no-signature')
    expect(events[0]!.requester.verified).toBe(false)
  })

  it('a spoofed client-sent verdict header is overwritten, never trusted', async () => {
    const { cfg, seen } = capturing()
    await handleRequest(
      makeRequest('/mcp', {
        ...PROTOCOL_CLIENT_HEADERS,
        [AGENT_VERIFIED_HEADER]: 'true',
        [AGENT_VERIFIED_REASON_HEADER]: 'looks-legit',
      }),
      cfg,
    )
    expect(seen[0]!.headers.get(AGENT_VERIFIED_HEADER)).toBe('false')
    expect(seen[0]!.headers.get(AGENT_VERIFIED_REASON_HEADER)).toBe('no-signature')
  })

  it('a tampered signature (authority mismatch) is stamped false / bad-signature', async () => {
    const { cfg, seen } = capturing()
    await handleRequest(
      await signedProtocolRequest('/.well-known/ucp', { tamperAuthority: 'evil.example' }),
      cfg,
    )
    expect(seen[0]!.headers.get(AGENT_VERIFIED_HEADER)).toBe('false')
    expect(seen[0]!.headers.get(AGENT_VERIFIED_REASON_HEADER)).toBe('bad-signature')
  })

  it('the empty shipped KNOWN_AGENT_DIRECTORY verifies nothing: false / unknown-agent', async () => {
    const { cfg, seen } = capturing({ verification: { keys: KNOWN_AGENT_DIRECTORY } })
    await handleRequest(await signedProtocolRequest('/.well-known/ucp'), cfg)
    expect(seen[0]!.headers.get(AGENT_VERIFIED_HEADER)).toBe('false')
    expect(seen[0]!.headers.get(AGENT_VERIFIED_REASON_HEADER)).toBe('unknown-agent')
  })
})

// ---------------------------------------------------------------------------
// Scope + containment
// ---------------------------------------------------------------------------

describe('verification scope and containment', () => {
  it('verification never runs off the protocol path (markdown unaffected)', async () => {
    const { cfg, seen } = capturing()
    const res = await handleRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS), cfg)
    expect(res!.headers.get('x-rebilder-path')).toBe('markdown')
    expect(seen).toHaveLength(0) // hook untouched; no verification either
  })

  it('verification set but no protocols hook → pass-through, event verified stays false', async () => {
    const { cfg, events, seen } = capturing({ protocols: undefined })
    const res = await handleRequest(await signedProtocolRequest('/.well-known/ucp'), cfg)
    expect(res).toBeNull()
    expect(seen).toHaveLength(0)
    // Nothing invokes protocol serving, so verification is skipped entirely —
    // the event honestly reports unverified rather than a verdict nobody used.
    expect(events[0]!.requester.verified).toBe(false)
    expect(events[0]!.response.path).toBe('protocol')
  })

  it('a throwing hook stays contained with verification configured (no 500, event still emits)', async () => {
    const events: RebilderEventV0[] = []
    const cfg: GatewayConfig = {
      storeId: 'store_test',
      sources: pathMatchedSources(),
      protocols: async () => {
        throw new Error('adapter bug')
      },
      onEvent: (event) => void events.push(event),
      verification: { keys: registry },
    }
    const res = await handleRequest(await signedProtocolRequest('/mcp'), cfg)
    expect(res).toBeNull()
    expect(events).toHaveLength(1)
    expect(events[0]!.requester.verified).toBe(true) // verification ran; the hook bug is separate
  })
})
