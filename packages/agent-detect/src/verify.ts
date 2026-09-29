/**
 * Web Bot Auth verification — the Phase 3 async counterpart to detect().
 *
 * PURE CRYPTO WITH INJECTED KEYS. This module verifies RFC 9421-style HTTP
 * message signatures (Signature-Input / Signature / Signature-Agent) against
 * a caller-provided key registry. It NEVER fetches a key directory, never
 * touches the network, never reads the environment — the registry is
 * dependency-injected, so the hot path stays within the edge budget
 * (project convention: no network calls on the hot path). Key directory
 * refresh is an offline/operator concern (see README § Verification).
 *
 * detect() stays synchronous and unchanged: it parses these headers as
 * identity *signals* only and always reports `verified: false`. Paths that
 * need cryptographic identity (preference payloads, protocol transactions —
 * ROADMAP Phase 3 P0) call verifyWebBotAuth() as a separate async step.
 *
 * Failure behavior is constant: malformed, hostile, or garbage input NEVER
 * throws — every path resolves to `{ verified: false, reason }`.
 */

import type { AgentPlatform, DetectInput } from './types'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Why verification did not succeed. */
export type VerificationFailureReason =
  | 'no-signature' // no Signature + Signature-Input header pair on the request
  | 'unknown-agent' // no Signature-Agent header, or its origin is not in the registry
  | 'unknown-key' // keyid not found for that agent, or the registry key material is unusable
  | 'expired' // `expires` is more than the allowed clock skew in the past
  | 'created-in-future' // `created` is more than the allowed clock skew in the future
  | 'bad-signature' // signature bytes do not verify over the reconstructed base
  | 'malformed' // unparseable/unsupported headers, or a covered component we cannot reconstruct
  | 'unsupported-alg' // signature declares an algorithm other than ed25519

export interface VerificationResult {
  verified: boolean
  /** The registry entry's platform, set only when verified. */
  platform?: AgentPlatform
  /** The keyid parsed from Signature-Input, set once parsing got that far. */
  keyid?: string
  /** Set exactly when `verified` is false. */
  reason?: VerificationFailureReason
}

/** An Ed25519 public key in JWK form (RFC 8037: OKP / Ed25519 / x). */
export interface Ed25519PublicJwk {
  kty: 'OKP'
  crv: 'Ed25519'
  /** base64url-encoded public key bytes. */
  x: string
}

export interface AgentPublicKey {
  /** Matches the `keyid` parameter the agent sends in Signature-Input. */
  keyid: string
  /** ed25519 is the only algorithm supported in v0. */
  alg: 'ed25519'
  publicKeyJwk: Ed25519PublicJwk
}

export interface AgentKeyRegistryEntry {
  /** The platform this origin's keys attest to. */
  platform: AgentPlatform
  keys: AgentPublicKey[]
}

/**
 * Key registry keyed by the agent's Signature-Agent origin, e.g.
 * `"https://chatgpt.com"`. Bare hosts (`"chatgpt.com"`) are accepted and
 * normalized to the https origin. See KNOWN_AGENT_DIRECTORY (src/directory.ts)
 * for the shape — it ships EMPTY; operators populate it from the platforms'
 * published key directories.
 */
export type AgentKeyRegistry = Record<string, AgentKeyRegistryEntry>

export interface VerifyWebBotAuthOptions {
  /** The injected key registry. Verification is pure crypto over these keys. */
  keys: AgentKeyRegistry
  /** Clock override for tests/replays. Defaults to `new Date()`. */
  now?: Date
  /**
   * Deliberately impossible to set: this function performs NO network I/O.
   * Key directory fetch/refresh happens offline, outside this module.
   */
  fetchImpl?: never
}

/** Allowed clock skew for `created` / `expires`, in seconds (±). */
export const CLOCK_SKEW_SECONDS = 300

// ---------------------------------------------------------------------------
// Header + structured-field parsing (RFC 8941 subset, RFC 9421 shapes)
// ---------------------------------------------------------------------------

/** Case-insensitive header lookup; array values comma-joined (RFC 9110). */
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target || value === undefined) continue
    return Array.isArray(value) ? value.join(', ') : value
  }
  return undefined
}

const KEY_CHAR = /[a-zA-Z0-9_.*-]/
const PARAM_VALUE_END = /[;,\s]/

interface Scanner {
  s: string
  i: number
}

function skipOws(sc: Scanner): void {
  while (sc.i < sc.s.length && (sc.s[sc.i] === ' ' || sc.s[sc.i] === '\t')) sc.i++
}

/** Reads an sf-key at the cursor; null when none is present. */
function readKey(sc: Scanner): string | null {
  const start = sc.i
  while (sc.i < sc.s.length && KEY_CHAR.test(sc.s[sc.i] as string)) sc.i++
  return sc.i > start ? sc.s.slice(start, sc.i) : null
}

/** Reads a quoted sf-string at the cursor (cursor on the opening quote). */
function readQuoted(sc: Scanner): string | null {
  if (sc.s[sc.i] !== '"') return null
  sc.i++
  let out = ''
  while (sc.i < sc.s.length) {
    const ch = sc.s[sc.i] as string
    if (ch === '\\') {
      if (sc.i + 1 >= sc.s.length) return null
      out += sc.s[sc.i + 1] as string
      sc.i += 2
      continue
    }
    if (ch === '"') {
      sc.i++
      return out
    }
    out += ch
    sc.i++
  }
  return null // unterminated
}

/** Reads `;name[=value]` parameters into a map. Null on malformed input. */
function readParams(sc: Scanner): Map<string, string | number | true> | null {
  const params = new Map<string, string | number | true>()
  while (sc.i < sc.s.length && sc.s[sc.i] === ';') {
    sc.i++
    skipOws(sc)
    const name = readKey(sc)
    if (name === null) return null
    let value: string | number | true = true
    if (sc.s[sc.i] === '=') {
      sc.i++
      if (sc.s[sc.i] === '"') {
        const quoted = readQuoted(sc)
        if (quoted === null) return null
        value = quoted
      } else {
        const start = sc.i
        while (sc.i < sc.s.length && !PARAM_VALUE_END.test(sc.s[sc.i] as string)) sc.i++
        const token = sc.s.slice(start, sc.i)
        if (token.length === 0) return null
        value = /^-?\d+$/.test(token) ? Number(token) : token
      }
    }
    params.set(name, value)
  }
  return params
}

interface SignatureInputMember {
  label: string
  /** Covered component names, as sent (lowercased at use time). */
  components: string[]
  params: Map<string, string | number | true>
  /**
   * The EXACT serialization after `label=` — reused verbatim as the
   * `"@signature-params"` line of the signature base, so no re-serialization
   * ambiguity can break verification.
   */
  raw: string
}

/**
 * Parses a Signature-Input dictionary:
 * `sig1=("@authority" "signature-agent");created=...;keyid="...", sig2=...`
 * Returns null on any malformed member. Components carrying their own
 * parameters (e.g. `"@query-param";name="q"`) are unsupported in v0 →
 * treated as malformed.
 */
function parseSignatureInput(value: string): SignatureInputMember[] | null {
  const sc: Scanner = { s: value, i: 0 }
  const members: SignatureInputMember[] = []
  skipOws(sc)
  while (sc.i < sc.s.length) {
    const label = readKey(sc)
    if (label === null || sc.s[sc.i] !== '=') return null
    sc.i++
    if (sc.s[sc.i] !== '(') return null
    const rawStart = sc.i
    sc.i++
    const components: string[] = []
    for (;;) {
      skipOws(sc)
      if (sc.i >= sc.s.length) return null
      if (sc.s[sc.i] === ')') {
        sc.i++
        break
      }
      const component = readQuoted(sc)
      if (component === null) return null
      if (sc.s[sc.i] === ';') return null // per-component parameters: unsupported in v0
      components.push(component)
    }
    const params = readParams(sc)
    if (params === null) return null
    members.push({ label, components, params, raw: sc.s.slice(rawStart, sc.i) })
    skipOws(sc)
    if (sc.i >= sc.s.length) break
    if (sc.s[sc.i] !== ',') return null
    sc.i++
    skipOws(sc)
  }
  return members
}

/**
 * Parses a Signature dictionary of byte sequences:
 * `sig1=:BASE64==:, sig2=:...:` → label → base64 payload.
 */
function parseSignatureDict(value: string): Map<string, string> | null {
  const sc: Scanner = { s: value, i: 0 }
  const out = new Map<string, string>()
  skipOws(sc)
  while (sc.i < sc.s.length) {
    const label = readKey(sc)
    if (label === null || sc.s[sc.i] !== '=') return null
    sc.i++
    if (sc.s[sc.i] !== ':') return null
    sc.i++
    const start = sc.i
    while (sc.i < sc.s.length && sc.s[sc.i] !== ':') sc.i++
    if (sc.i >= sc.s.length) return null // unterminated byte sequence
    out.set(label, sc.s.slice(start, sc.i))
    sc.i++
    if (readParams(sc) === null) return null // tolerate (and ignore) member params
    skipOws(sc)
    if (sc.i >= sc.s.length) break
    if (sc.s[sc.i] !== ',') return null
    sc.i++
    skipOws(sc)
  }
  return out
}

// ---------------------------------------------------------------------------
// Origins, base64, component values
// ---------------------------------------------------------------------------

/** Normalizes an origin-ish string ("https://x.com", "x.com") to a URL origin. */
function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(candidate).origin.toLowerCase()
  } catch {
    return null
  }
}

/** First item of the Signature-Agent list, unquoted → normalized origin. */
function signatureAgentOrigin(raw: string): string | null {
  const first = raw.split(',')[0] ?? ''
  const sc: Scanner = { s: first.trim(), i: 0 }
  const unquoted = sc.s[0] === '"' ? readQuoted(sc) : sc.s
  if (unquoted === null || unquoted.length === 0) return null
  return normalizeOrigin(unquoted)
}

/** Registry lookup with origin normalization on the registry keys too. */
function registryEntryFor(
  keys: AgentKeyRegistry,
  origin: string,
): AgentKeyRegistryEntry | undefined {
  for (const [registryOrigin, entry] of Object.entries(keys)) {
    if (normalizeOrigin(registryOrigin) === origin) return entry
  }
  return undefined
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

function base64Decode(value: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64_RE.test(value) || value.length % 4 !== 0) return null
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/**
 * Resolves one covered component's value for the signature base. Returns
 * null when the component cannot be reconstructed from the input (missing
 * header, missing/unparseable URL, unsupported derived component) — which
 * verifyWebBotAuth reports as 'malformed'.
 */
function componentValue(name: string, input: DetectInput): string | null {
  if (name.startsWith('@')) {
    if (name === '@method') {
      return input.method === undefined ? null : input.method.toUpperCase()
    }
    if (input.url === undefined) return null
    let url: URL
    try {
      url = new URL(input.url)
    } catch {
      return null
    }
    switch (name) {
      case '@authority':
        return url.host
      case '@scheme':
        return url.protocol.replace(/:$/, '')
      case '@target-uri':
        return url.href
      case '@path':
        return url.pathname
      case '@query':
        return url.search === '' ? '?' : url.search
      case '@request-target':
        return url.pathname + url.search
      default:
        return null // unsupported derived component in v0
    }
  }
  const value = headerValue(input.headers ?? {}, name)
  return value === undefined ? null : value.trim()
}

// ---------------------------------------------------------------------------
// verifyWebBotAuth()
// ---------------------------------------------------------------------------

function failure(reason: VerificationFailureReason, keyid?: string): VerificationResult {
  return keyid === undefined ? { verified: false, reason } : { verified: false, keyid, reason }
}

/**
 * Verify a request's Web Bot Auth signature chain against an injected key
 * registry. Async (WebCrypto) but pure: no network, no environment, no
 * global state. Never throws — every failure resolves to
 * `{ verified: false, reason }`.
 *
 * Requirements enforced (Web Bot Auth profile over RFC 9421):
 * - `Signature` + `Signature-Input` present, structured-field parseable
 * - covered components include `@authority` AND `signature-agent`
 *   (anti-replay: the signature is pinned to this host and this identity)
 * - `keyid`, `created`, `expires` parameters present; `created <= expires`;
 *   both within ±CLOCK_SKEW_SECONDS of `options.now`
 * - `alg`, when present, is `ed25519`
 * - `Signature-Agent` origin resolves to a registry entry; `keyid` resolves
 *   to one of that entry's keys
 * - Ed25519 signature verifies (WebCrypto subtle) over the RFC 9421
 *   signature base, whose `"@signature-params"` line reuses the exact
 *   serialization the agent sent
 */
export async function verifyWebBotAuth(
  input: DetectInput,
  options: VerifyWebBotAuthOptions,
): Promise<VerificationResult> {
  try {
    return await verifyInner(input, options)
  } catch {
    // Constant behavior on hostile input: never throw.
    return failure('malformed')
  }
}

async function verifyInner(
  input: DetectInput,
  options: VerifyWebBotAuthOptions,
): Promise<VerificationResult> {
  const headers = input.headers ?? {}
  const signatureRaw = headerValue(headers, 'signature')
  const signatureInputRaw = headerValue(headers, 'signature-input')
  if (signatureRaw === undefined || signatureInputRaw === undefined) {
    return failure('no-signature')
  }

  const members = parseSignatureInput(signatureInputRaw)
  const signatures = parseSignatureDict(signatureRaw)
  if (members === null || signatures === null || members.length === 0) {
    return failure('malformed')
  }

  // First Signature-Input member with a matching Signature entry.
  const member = members.find((candidate) => signatures.has(candidate.label))
  if (member === undefined) return failure('malformed')
  const signatureB64 = signatures.get(member.label) as string

  // Anti-replay: the signature must pin the authority and the agent identity.
  const covered = member.components.map((component) => component.toLowerCase())
  if (!covered.includes('@authority') || !covered.includes('signature-agent')) {
    return failure('malformed')
  }

  const alg = member.params.get('alg')
  if (alg !== undefined && alg !== 'ed25519') return failure('unsupported-alg')

  const keyidParam = member.params.get('keyid')
  const keyid = typeof keyidParam === 'string' && keyidParam.length > 0 ? keyidParam : undefined

  // Agent identity → registry entry.
  const signatureAgentRaw = headerValue(headers, 'signature-agent')
  if (signatureAgentRaw === undefined) return failure('unknown-agent', keyid)
  const origin = signatureAgentOrigin(signatureAgentRaw)
  if (origin === null) return failure('unknown-agent', keyid)
  const entry = registryEntryFor(options.keys, origin)
  if (entry === undefined) return failure('unknown-agent', keyid)

  // keyid → registry key.
  if (keyid === undefined) return failure('malformed')
  const key = entry.keys.find((candidate) => candidate.keyid === keyid)
  if (key === undefined) return failure('unknown-key', keyid)
  if (key.alg !== 'ed25519') return failure('unsupported-alg', keyid)

  // Validity window (±CLOCK_SKEW_SECONDS).
  const created = member.params.get('created')
  const expires = member.params.get('expires')
  if (typeof created !== 'number' || !Number.isInteger(created)) return failure('malformed', keyid)
  if (typeof expires !== 'number' || !Number.isInteger(expires)) return failure('malformed', keyid)
  if (created > expires) return failure('malformed', keyid)
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000)
  if (created - CLOCK_SKEW_SECONDS > nowSeconds) return failure('created-in-future', keyid)
  if (expires + CLOCK_SKEW_SECONDS < nowSeconds) return failure('expired', keyid)

  // Signature base (RFC 9421 § 2.5): one line per covered component, then
  // "@signature-params" with the agent's exact Signature-Input serialization.
  const lines: string[] = []
  for (const component of covered) {
    const value = componentValue(component, input)
    if (value === null) return failure('malformed', keyid)
    lines.push(`"${component}": ${value}`)
  }
  lines.push(`"@signature-params": ${member.raw}`)
  const base = lines.join('\n')

  const signatureBytes = base64Decode(signatureB64)
  if (signatureBytes === null) return failure('malformed', keyid)
  if (signatureBytes.length !== 64) return failure('bad-signature', keyid)

  let cryptoKey: CryptoKey
  try {
    cryptoKey = await crypto.subtle.importKey(
      'jwk',
      key.publicKeyJwk,
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
  } catch {
    // Registry key material is unusable — an operator/registry problem.
    return failure('unknown-key', keyid)
  }

  let ok = false
  try {
    ok = await crypto.subtle.verify(
      'Ed25519',
      cryptoKey,
      signatureBytes,
      new TextEncoder().encode(base),
    )
  } catch {
    ok = false
  }
  if (!ok) return failure('bad-signature', keyid)

  return { verified: true, platform: entry.platform, keyid }
}
