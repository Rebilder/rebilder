import {
  BASELINE_PROFILE,
  COMPATIBILITY_RUNTIME_VERSION,
  validateCompatibilityProfile,
  type CompatibilityProfile,
} from '@rebilder/render-md'

/** Update payloads select compiled-in renderers; they cannot carry executable code. */
export interface CompatibilityManifest {
  schema: 1
  audience: string
  sequence: number
  issuedAt: string
  expiresAt: string
  runtime: { min: number; max: number }
  profile: CompatibilityProfile
  evaluationId?: string
}
export interface SignedCompatibilityManifest {
  keyId: string
  manifest: CompatibilityManifest
  /** ECDSA P-256/SHA-256 signature, IEEE P1363 bytes encoded as base64url. */
  signature: string
}
export interface CompatibilityUpdateStatus {
  profile: CompatibilityProfile
  sequence: number
  state: 'baseline' | 'active' | 'expired' | 'rejected' | 'unavailable'
  reason?: string
}
export interface CompatibilityUpdateOptions {
  /** Explicit HTTPS endpoint. No hosted dependency until the owner configures it. */
  url: string
  audience: string
  /** Store-scoped API key, used only for the configured HTTPS update endpoint. */
  apiKey?: string
  publicKeys: Record<string, JsonWebKey>
  fetch?: typeof fetch
  now?: () => number
  /** Optional durable storage, scoped by the caller to this audience/endpoint. */
  cache?: { load(): Promise<unknown>; save(envelope: SignedCompatibilityManifest): Promise<void> }
  /** Default 5000; clamped to 100..30000 milliseconds. */
  timeoutMs?: number
}

/** Stable serialization shared by signers and verifiers. No JSON key order dependency. */
export function canonicalCompatibilityManifest(manifest: CompatibilityManifest): string {
  return JSON.stringify({
    schema: manifest.schema,
    audience: manifest.audience,
    sequence: manifest.sequence,
    issuedAt: manifest.issuedAt,
    expiresAt: manifest.expiresAt,
    runtime: { min: manifest.runtime.min, max: manifest.runtime.max },
    profile: { id: manifest.profile.id, version: manifest.profile.version },
    ...(manifest.evaluationId === undefined ? {} : { evaluationId: manifest.evaluationId }),
  })
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const onlyKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key))

export function validateCompatibilityManifest(value: unknown): CompatibilityManifest | null {
  if (
    !object(value) ||
    !onlyKeys(value, [
      'schema',
      'audience',
      'sequence',
      'issuedAt',
      'expiresAt',
      'runtime',
      'profile',
      'evaluationId',
    ])
  )
    return null
  if (
    value.schema !== 1 ||
    typeof value.audience !== 'string' ||
    value.audience.length < 1 ||
    value.audience.length > 512
  )
    return null
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) return null
  if (typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string') return null
  const issued = Date.parse(value.issuedAt),
    expires = Date.parse(value.expiresAt)
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    expires <= issued ||
    expires - issued > 31 * 86400000
  )
    return null
  if (!object(value.runtime) || !onlyKeys(value.runtime, ['min', 'max'])) return null
  if (
    !Number.isSafeInteger(value.runtime.min) ||
    !Number.isSafeInteger(value.runtime.max) ||
    (value.runtime.min as number) < 1 ||
    (value.runtime.min as number) > (value.runtime.max as number)
  )
    return null
  const profile = validateCompatibilityProfile(value.profile)
  if (profile === null) return null
  if (
    value.evaluationId !== undefined &&
    (typeof value.evaluationId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(value.evaluationId))
  )
    return null
  return { ...value, profile } as unknown as CompatibilityManifest
}

/** Cryptography and eligibility checks run during refresh/restore, never serving. */
export async function verifyCompatibilityManifest(
  value: unknown,
  options: Pick<CompatibilityUpdateOptions, 'audience' | 'publicKeys'> & {
    now?: number
    minimumSequence?: number
    allowExpired?: boolean
  },
): Promise<{ ok: true; envelope: SignedCompatibilityManifest } | { ok: false; reason: string }> {
  try {
    if (
      !object(value) ||
      !onlyKeys(value, ['keyId', 'manifest', 'signature']) ||
      typeof value.keyId !== 'string' ||
      typeof value.signature !== 'string'
    )
      return { ok: false, reason: 'invalid-envelope' }
    const manifest = validateCompatibilityManifest(value.manifest)
    if (manifest === null) return { ok: false, reason: 'invalid-manifest' }
    if (manifest.audience !== options.audience) return { ok: false, reason: 'wrong-audience' }
    const now = options.now ?? Date.now()
    if (Date.parse(manifest.issuedAt) > now + 60000) return { ok: false, reason: 'future-manifest' }
    if (!options.allowExpired && Date.parse(manifest.expiresAt) <= now)
      return { ok: false, reason: 'expired-manifest' }
    if (manifest.sequence < (options.minimumSequence ?? 0))
      return { ok: false, reason: 'replayed-manifest' }
    if (
      manifest.runtime.min > COMPATIBILITY_RUNTIME_VERSION ||
      manifest.runtime.max < COMPATIBILITY_RUNTIME_VERSION
    )
      return { ok: false, reason: 'unsupported-runtime' }
    if (!Object.prototype.hasOwnProperty.call(options.publicKeys, value.keyId))
      return { ok: false, reason: 'unknown-key' }
    const jwk = options.publicKeys[value.keyId]
    if (jwk?.kty !== 'EC' || jwk.crv !== 'P-256' || jwk.d !== undefined)
      return { ok: false, reason: 'invalid-key' }
    if (!/^[A-Za-z0-9_-]{86}$/.test(value.signature))
      return { ok: false, reason: 'invalid-signature' }
    const signature = Uint8Array.from(
      atob(value.signature.replace(/-/g, '+').replace(/_/g, '/') + '=='),
      (c) => c.charCodeAt(0),
    )
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature,
      new TextEncoder().encode(canonicalCompatibilityManifest(manifest)),
    )
    return valid
      ? { ok: true, envelope: { keyId: value.keyId, manifest, signature: value.signature } }
      : { ok: false, reason: 'invalid-signature' }
  } catch {
    return { ok: false, reason: 'verification-failed' }
  }
}

export function createCompatibilityUpdater(options: CompatibilityUpdateOptions) {
  const endpoint = new URL(options.url)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash)
    throw new Error(
      'Compatibility updates require an HTTPS endpoint without credentials or a fragment',
    )
  const now = options.now ?? Date.now
  let active: SignedCompatibilityManifest | null = null
  let highWater = 0
  let disabled = false
  let generation = 0
  let state: CompatibilityUpdateStatus['state'] = 'baseline'
  let reason: string | undefined
  let pending: Promise<CompatibilityUpdateStatus> | null = null
  let timer: ReturnType<typeof setInterval> | undefined

  const current = (): CompatibilityProfile => {
    if (disabled || active === null || Date.parse(active.manifest.expiresAt) <= now())
      return { ...BASELINE_PROFILE }
    return { ...active.manifest.profile }
  }
  const status = (): CompatibilityUpdateStatus => ({
    profile: current(),
    sequence: highWater,
    state:
      !disabled && active !== null && Date.parse(active.manifest.expiresAt) <= now()
        ? 'expired'
        : state,
    ...(reason === undefined ? {} : { reason }),
  })
  let acceptance: Promise<void> = Promise.resolve()
  async function acceptOnce(
    value: unknown,
    persist: boolean,
    expectedGeneration = generation,
  ): Promise<CompatibilityUpdateStatus> {
    if (generation !== expectedGeneration) return status()
    const result = await verifyCompatibilityManifest(value, {
      ...options,
      now: now(),
      minimumSequence: highWater,
      allowExpired: !persist,
    })
    if (generation !== expectedGeneration) return status()
    if (!result.ok) {
      state = 'rejected'
      reason = result.reason
      return status()
    }
    if (result.envelope.manifest.sequence < highWater) {
      state = 'rejected'
      reason = 'replayed-manifest'
      return status()
    }
    if (
      active !== null &&
      result.envelope.manifest.sequence === highWater &&
      canonicalCompatibilityManifest(result.envelope.manifest) !==
        canonicalCompatibilityManifest(active.manifest)
    ) {
      state = 'rejected'
      reason = 'sequence-conflict'
      return status()
    }
    // Retain the in-memory last good state if durable storage is unavailable.
    if (persist && options.cache !== undefined) {
      try {
        await options.cache.save(result.envelope)
      } catch {
        state = 'unavailable'
        reason = 'cache-write-failed'
        return status()
      }
    }
    if (generation !== expectedGeneration) return status()
    if (result.envelope.manifest.sequence < highWater) return status()
    active = result.envelope
    highWater = active.manifest.sequence
    disabled = false
    state = active.manifest.profile.id === 'baseline' ? 'baseline' : 'active'
    reason = undefined
    return status()
  }
  function accept(
    value: unknown,
    persist: boolean,
    expectedGeneration = generation,
  ): Promise<CompatibilityUpdateStatus> {
    const result = acceptance.then(() => acceptOnce(value, persist, expectedGeneration))
    acceptance = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  async function refreshOnce(): Promise<CompatibilityUpdateStatus> {
    const expectedGeneration = generation
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const work = async (): Promise<CompatibilityUpdateStatus> => {
      const response = await (options.fetch ?? fetch)(endpoint.href, {
        signal: controller.signal,
        redirect: 'error',
        headers: {
          accept: 'application/json',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('update-unavailable')
      const length = Number(response.headers.get('content-length'))
      if (length > 16384) throw new Error('manifest-too-large')
      // Bound streamed bytes as well: Content-Length is optional and untrusted.
      const reader = response.body?.getReader()
      if (!reader) throw new Error('empty-update')
      const chunks: Uint8Array[] = []
      let total = 0
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        total += chunk.value.byteLength
        if (total > 16384) {
          await reader.cancel()
          throw new Error('manifest-too-large')
        }
        chunks.push(chunk.value)
      }
      const body = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
      }
      return await accept(JSON.parse(new TextDecoder().decode(body)), true, expectedGeneration)
    }
    try {
      return await Promise.race([
        work(),
        new Promise<CompatibilityUpdateStatus>((resolve) => {
          timeout = setTimeout(
            () => {
              controller.abort()
              if (expectedGeneration === generation) {
                generation++
                state = 'unavailable'
                reason = 'update-timeout'
              }
              resolve(status())
            },
            Math.min(
              30000,
              Math.max(100, Number.isFinite(options.timeoutMs) ? options.timeoutMs! : 5000),
            ),
          )
        }),
      ])
    } catch {
      if (expectedGeneration === generation) {
        state = 'unavailable'
        reason = 'update-unavailable'
      }
      return status()
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
  const refresh = (): Promise<CompatibilityUpdateStatus> => {
    if (pending !== null) return pending
    pending = refreshOnce().finally(() => {
      pending = null
    })
    return pending
  }
  return {
    current,
    status,
    refresh,
    async restore(): Promise<CompatibilityUpdateStatus> {
      if (!options.cache) return status()
      const expectedGeneration = generation
      try {
        return await accept(await options.cache.load(), false, expectedGeneration)
      } catch {
        if (expectedGeneration === generation) {
          state = 'unavailable'
          reason = 'cache-read-failed'
        }
        return status()
      }
    },
    /** Local emergency rollback; persists until explicit resume or next restart. */
    rollback(): CompatibilityUpdateStatus {
      generation++
      disabled = true
      state = 'baseline'
      reason = 'local-rollback'
      if (timer) clearInterval(timer)
      timer = undefined
      return status()
    },
    /** Explicit refresh can resume after rollback; no request starts this timer. */
    start(intervalMs = 3600000): () => void {
      if (timer) clearInterval(timer)
      const started = setInterval(
        () => {
          void refresh()
        },
        Math.min(86400000, Math.max(60000, Number.isFinite(intervalMs) ? intervalMs : 3600000)),
      )
      timer = started
      return () => {
        clearInterval(started)
        if (timer === started) timer = undefined
      }
    },
  }
}
