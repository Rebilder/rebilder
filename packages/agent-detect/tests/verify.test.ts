/**
 * verifyWebBotAuth — Web Bot Auth verification against an injected registry.
 *
 * Test vectors are SELF-GENERATED Ed25519 keypairs (WebCrypto, at test time):
 * we do not ship or pin anyone's production keys (see src/directory.ts).
 * A local signer builds RFC 9421 signature bases the same way a conforming
 * agent would; assertions are deterministic over a fixed clock.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import {
  CLOCK_SKEW_SECONDS,
  KNOWN_AGENT_DIRECTORY,
  detect,
  verifyWebBotAuth,
  type AgentKeyRegistry,
  type DetectInput,
  type Ed25519PublicJwk,
} from '../src/index'

// ---------------------------------------------------------------------------
// Fixed clock + registry fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-05T12:00:00Z')
const NOW_SEC = Math.floor(NOW.getTime() / 1000)

const AGENT_ORIGIN = 'https://agent.example'
const KEYID = 'test-key-1'
const TARGET_URL = 'https://store.example.com/.well-known/ucp/v0/checkout'

interface TestAgentKey {
  privateKey: CryptoKey
  publicKeyJwk: Ed25519PublicJwk
}

async function generateAgentKey(): Promise<TestAgentKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as { x?: string }
  if (typeof jwk.x !== 'string') throw new Error('exported JWK missing x')
  return {
    privateKey: pair.privateKey,
    publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
  }
}

let agentKey: TestAgentKey
let strangerKey: TestAgentKey
let registry: AgentKeyRegistry

beforeAll(async () => {
  agentKey = await generateAgentKey()
  strangerKey = await generateAgentKey() // valid keypair, NOT in the registry
  registry = {
    [AGENT_ORIGIN]: {
      platform: 'chatgpt',
      keys: [{ keyid: KEYID, alg: 'ed25519', publicKeyJwk: agentKey.publicKeyJwk }],
    },
  }
})

// ---------------------------------------------------------------------------
// Signer — builds the RFC 9421 base exactly as a conforming agent would
// ---------------------------------------------------------------------------

interface SignOptions {
  url?: string
  method?: string
  /** Overrides the @authority VALUE SIGNED (not the request URL) — tamper knob. */
  signedAuthority?: string
  components?: string[]
  created?: number
  expires?: number
  keyid?: string
  /** `null` omits the alg parameter entirely. */
  alg?: string | null
  signatureAgent?: string
  label?: string
  signatureLabel?: string
  extraHeaders?: Record<string, string>
  signWith?: CryptoKey
  mangleSignatureB64?: (b64: string) => string
}

async function signedInput(options: SignOptions = {}): Promise<DetectInput> {
  const url = options.url ?? TARGET_URL
  const method = options.method ?? 'POST'
  const parsed = new URL(url)
  const components = options.components ?? ['@authority', 'signature-agent']
  const created = options.created ?? NOW_SEC - 30
  const expires = options.expires ?? NOW_SEC + 270
  const keyid = options.keyid ?? KEYID
  const signatureAgent = options.signatureAgent ?? `"${AGENT_ORIGIN}"`
  const label = options.label ?? 'sig1'

  let params = `(${components.map((component) => `"${component}"`).join(' ')})`
  params += `;created=${created};expires=${expires};keyid="${keyid}"`
  if (options.alg !== null) params += `;alg="${options.alg ?? 'ed25519'}"`
  params += ';tag="web-bot-auth"'

  const headers: Record<string, string> = {
    'signature-agent': signatureAgent,
    ...options.extraHeaders,
  }

  const lines = components.map((component) => {
    switch (component) {
      case '@authority':
        return `"@authority": ${options.signedAuthority ?? parsed.host}`
      case '@method':
        return `"@method": ${method.toUpperCase()}`
      case '@path':
        return `"@path": ${parsed.pathname}`
      case '@target-uri':
        return `"@target-uri": ${parsed.href}`
      default:
        return `"${component}": ${(headers[component] ?? '').trim()}`
    }
  })
  lines.push(`"@signature-params": ${params}`)
  const base = lines.join('\n')

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'Ed25519',
      options.signWith ?? agentKey.privateKey,
      new TextEncoder().encode(base),
    ),
  )
  let b64 = btoa(String.fromCharCode(...signature))
  if (options.mangleSignatureB64 !== undefined) b64 = options.mangleSignatureB64(b64)

  return {
    headers: {
      ...headers,
      'signature-input': `${label}=${params}`,
      signature: `${options.signatureLabel ?? label}=:${b64}:`,
    },
    url,
    method,
  }
}

function verify(input: DetectInput, keys: AgentKeyRegistry = registry) {
  return verifyWebBotAuth(input, { keys, now: NOW })
}

// ---------------------------------------------------------------------------
// Verification passes
// ---------------------------------------------------------------------------

describe('verifyWebBotAuth — pass paths', () => {
  it('verifies a correctly signed request: platform + keyid, no reason', async () => {
    const result = await verify(await signedInput())
    expect(result).toEqual({ verified: true, platform: 'chatgpt', keyid: KEYID })
  })

  it('verifies with extra covered components (@method, @path, a plain header)', async () => {
    const input = await signedInput({
      components: ['@authority', '@method', '@path', 'signature-agent', 'user-agent'],
      extraHeaders: { 'user-agent': 'agent-browser/1.0' },
    })
    expect((await verify(input)).verified).toBe(true)
  })

  it('verifies without an alg parameter (algorithm pinned by the registry key)', async () => {
    const result = await verify(await signedInput({ alg: null }))
    expect(result.verified).toBe(true)
  })

  it('accepts a bare-host registry key ("agent.example" ≡ "https://agent.example")', async () => {
    const bareHostRegistry: AgentKeyRegistry = {
      'agent.example': registry[AGENT_ORIGIN]!,
    }
    expect((await verify(await signedInput(), bareHostRegistry)).verified).toBe(true)
  })

  it('accepts expires just inside the ±300s clock skew', async () => {
    const input = await signedInput({
      created: NOW_SEC - 600,
      expires: NOW_SEC - CLOCK_SKEW_SECONDS + 5,
    })
    expect((await verify(input)).verified).toBe(true)
  })

  it('accepts created just inside the ±300s clock skew', async () => {
    const input = await signedInput({
      created: NOW_SEC + CLOCK_SKEW_SECONDS - 5,
      expires: NOW_SEC + 600,
    })
    expect((await verify(input)).verified).toBe(true)
  })

  it('picks the member whose label has a matching Signature entry', async () => {
    const input = await signedInput()
    // Prepend an unrelated Signature-Input member with no Signature entry.
    input.headers['signature-input'] =
      `sigx=("@authority" "signature-agent");created=1;expires=2;keyid="other", ` +
      String(input.headers['signature-input'])
    expect((await verify(input)).verified).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Failure reasons — each one deterministic
// ---------------------------------------------------------------------------

describe('verifyWebBotAuth — failure reasons', () => {
  it('no-signature: no Web Bot Auth headers at all', async () => {
    const result = await verify({ headers: { accept: 'text/html' }, url: TARGET_URL })
    expect(result).toEqual({ verified: false, reason: 'no-signature' })
  })

  it('no-signature: Signature without Signature-Input (and vice versa)', async () => {
    const input = await signedInput()
    const withoutSignature = { ...input.headers, signature: undefined }
    expect((await verify({ ...input, headers: withoutSignature })).reason).toBe('no-signature')
    const withoutInput = { ...input.headers, 'signature-input': undefined }
    expect((await verify({ ...input, headers: withoutInput })).reason).toBe('no-signature')
  })

  it('unknown-agent: Signature-Agent origin not in the registry', async () => {
    const input = await signedInput({
      signatureAgent: '"https://impostor.example"',
      signWith: strangerKey.privateKey,
    })
    expect((await verify(input)).reason).toBe('unknown-agent')
  })

  it('unknown-agent: Signature-Agent header missing entirely', async () => {
    const input = await signedInput()
    const headers = { ...input.headers, 'signature-agent': undefined }
    expect((await verify({ ...input, headers })).reason).toBe('unknown-agent')
  })

  it('unknown-agent: the shipped KNOWN_AGENT_DIRECTORY is empty, so nothing verifies', async () => {
    const result = await verify(await signedInput(), KNOWN_AGENT_DIRECTORY)
    expect(result).toEqual({ verified: false, keyid: KEYID, reason: 'unknown-agent' })
  })

  it('unknown-key: keyid not registered for that agent', async () => {
    const result = await verify(await signedInput({ keyid: 'rotated-away' }))
    expect(result).toEqual({ verified: false, keyid: 'rotated-away', reason: 'unknown-key' })
  })

  it('unknown-key: registry key material is unusable (garbage JWK)', async () => {
    const badRegistry: AgentKeyRegistry = {
      [AGENT_ORIGIN]: {
        platform: 'chatgpt',
        keys: [
          {
            keyid: KEYID,
            alg: 'ed25519',
            publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: '!!!not-base64url!!!' },
          },
        ],
      },
    }
    expect((await verify(await signedInput(), badRegistry)).reason).toBe('unknown-key')
  })

  it('expired: expires beyond the 300s skew', async () => {
    const input = await signedInput({
      created: NOW_SEC - 900,
      expires: NOW_SEC - CLOCK_SKEW_SECONDS - 5,
    })
    expect((await verify(input)).reason).toBe('expired')
  })

  it('created-in-future: created beyond the 300s skew', async () => {
    const input = await signedInput({
      created: NOW_SEC + CLOCK_SKEW_SECONDS + 5,
      expires: NOW_SEC + 900,
    })
    expect((await verify(input)).reason).toBe('created-in-future')
  })

  it('bad-signature: signed by a keypair other than the registered one', async () => {
    const input = await signedInput({ signWith: strangerKey.privateKey })
    expect((await verify(input)).reason).toBe('bad-signature')
  })

  it('bad-signature: payload tampered after signing (@authority differs)', async () => {
    // Signature pins evil.example's authority; the request is for store.example.com.
    const input = await signedInput({ signedAuthority: 'evil.example' })
    expect((await verify(input)).reason).toBe('bad-signature')
  })

  it('bad-signature: a covered header changed after signing', async () => {
    const input = await signedInput({
      components: ['@authority', 'signature-agent', 'user-agent'],
      extraHeaders: { 'user-agent': 'agent-browser/1.0' },
    })
    input.headers['user-agent'] = 'agent-browser/2.0'
    expect((await verify(input)).reason).toBe('bad-signature')
  })

  it('bad-signature: one flipped character in otherwise valid base64', async () => {
    const input = await signedInput({
      mangleSignatureB64: (b64) => `${b64.slice(0, 4)}${b64[4] === 'A' ? 'B' : 'A'}${b64.slice(5)}`,
    })
    expect((await verify(input)).reason).toBe('bad-signature')
  })

  it('unsupported-alg: any algorithm other than ed25519', async () => {
    const input = await signedInput({ alg: 'rsa-pss-sha512' })
    expect((await verify(input)).reason).toBe('unsupported-alg')
  })

  it('malformed: covered components missing @authority', async () => {
    const input = await signedInput({ components: ['signature-agent'] })
    expect((await verify(input)).reason).toBe('malformed')
  })

  it('malformed: covered components missing signature-agent', async () => {
    const input = await signedInput({ components: ['@authority'] })
    expect((await verify(input)).reason).toBe('malformed')
  })

  it('malformed: Signature label does not match any Signature-Input member', async () => {
    const input = await signedInput({ signatureLabel: 'sig2' })
    expect((await verify(input)).reason).toBe('malformed')
  })

  it('malformed: created/expires missing or inverted', async () => {
    const noWindow = await signedInput()
    noWindow.headers['signature-input'] = `sig1=("@authority" "signature-agent");keyid="${KEYID}"`
    expect((await verify(noWindow)).reason).toBe('malformed')

    const inverted = await signedInput({ created: NOW_SEC + 100, expires: NOW_SEC - 100 })
    expect((await verify(inverted)).reason).toBe('malformed')
  })

  it('malformed: keyid parameter absent', async () => {
    const input = await signedInput()
    input.headers['signature-input'] =
      `sig1=("@authority" "signature-agent");created=${NOW_SEC - 30};expires=${NOW_SEC + 270}`
    expect((await verify(input)).reason).toBe('malformed')
  })

  it('malformed: signature base64 is not valid base64', async () => {
    const input = await signedInput({ mangleSignatureB64: () => '!!!!' })
    expect((await verify(input)).reason).toBe('malformed')
  })
})

// ---------------------------------------------------------------------------
// Constant behavior on hostile input — never throws
// ---------------------------------------------------------------------------

describe('verifyWebBotAuth — never throws on malformed input', () => {
  const hostileHeaderSets: Record<string, string | string[] | undefined>[] = [
    { signature: 'sig1=:abc:', 'signature-input': 'sig1=' },
    { signature: 'sig1=:abc:', 'signature-input': 'sig1=(unquoted)' },
    { signature: 'sig1=:abc:', 'signature-input': 'sig1=("@authority" "signature-agent"' },
    { signature: 'sig1=:abc:', 'signature-input': '=;;;' },
    { signature: 'sig1=:::', 'signature-input': 'sig1=("@authority" "signature-agent");keyid="k"' },
    { signature: 'sig1=:abc', 'signature-input': 'sig1=("@authority" "signature-agent");keyid="k"' },
    {
      signature: 'sig1=:YQ==:',
      'signature-input': 'sig1=("@authority";name="q" "signature-agent");keyid="k"',
    },
    { signature: ' ￿', 'signature-input': ' ￿', 'signature-agent': ' ' },
    { signature: ['sig1=:abc:', 'sig2=:def:'], 'signature-input': ['sig1=("x")', 'oops'] },
  ]

  it.each(hostileHeaderSets.map((headers, index) => [index, headers] as const))(
    'hostile header set #%d resolves (never throws), verified: false',
    async (_index, headers) => {
      const result = await verify({ headers, url: TARGET_URL, method: 'POST' })
      expect(result.verified).toBe(false)
      expect(result.reason).toBeDefined()
    },
  )

  it('resolves malformed when the request URL is garbage (cannot rebuild @authority)', async () => {
    const input = await signedInput()
    expect((await verify({ ...input, url: '::not a url::' })).reason).toBe('malformed')
  })

  it('resolves when headers are absent entirely', async () => {
    const result = await verifyWebBotAuth(
      { headers: undefined as unknown as DetectInput['headers'] },
      { keys: registry, now: NOW },
    )
    expect(result).toEqual({ verified: false, reason: 'no-signature' })
  })
})

// ---------------------------------------------------------------------------
// detect() stays synchronous and unverified — the contract split
// ---------------------------------------------------------------------------

describe('detect() is unchanged by verification', () => {
  it('a signed request still detects with verified: false — verification is the separate step', async () => {
    const input = await signedInput()
    const detection = detect(input)
    expect(detection.verified).toBe(false) // detect() never verifies
    expect(detection.kind).toBe('agent') // Signature-Agent outranks the protocol route
    const verification = await verify(input)
    expect(verification.verified).toBe(true) // the async step does
  })
})
