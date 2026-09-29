import { describe, expect, it, vi } from 'vitest'
import { applyCompatibilityProfile, BASELINE_PROFILE } from '@rebilder/render-md'
import {
  canonicalCompatibilityManifest,
  createCompatibilityUpdater,
  verifyCompatibilityManifest,
  type CompatibilityManifest,
} from '../src/core/compatibility'
import { handleRequest } from '../src/core/handle'

const now = Date.parse('2026-09-13T12:00:00Z')
const manifest: CompatibilityManifest = {
  schema: 1,
  audience: 'store-1',
  sequence: 1,
  issuedAt: new Date(now - 1000).toISOString(),
  expiresAt: new Date(now + 86400000).toISOString(),
  runtime: { min: 1, max: 1 },
  profile: { id: 'source-envelope', version: 1 },
}
async function signer() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const publicKeys = { primary: await crypto.subtle.exportKey('jwk', keys.publicKey) }
  const sign = async (m: CompatibilityManifest = manifest) => {
    const bytes = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keys.privateKey,
        new TextEncoder().encode(canonicalCompatibilityManifest(m)),
      ),
    )
    return {
      keyId: 'primary',
      manifest: m,
      signature: btoa(String.fromCharCode(...bytes))
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_'),
    }
  }
  return { publicKeys, sign }
}
const body =
  '# Product\n\n## Conditions\nCommercial use excluded. $99. Returns require unused packaging.'
describe('conservative profiles', () => {
  it.each(['source-envelope', 'section-index'] as const)('preserves every byte with %s', (id) => {
    const result = applyCompatibilityProfile(
      body,
      { id, version: 1 },
      { canonicalUrl: 'https://shop.example/p' },
    )
    expect(result.markdown.endsWith(body)).toBe(true)
    expect(result.profile.id).toBe(id)
  })
  it('falls back without truncating qualifications when an addition exceeds the budget', () => {
    expect(
      applyCompatibilityProfile(
        body,
        { id: 'source-envelope', version: 1 },
        { canonicalUrl: 'https://shop.example/p', maxBytes: body.length },
      ),
    ).toEqual({ markdown: body, profile: BASELINE_PROFILE })
    expect(
      applyCompatibilityProfile(
        body,
        { id: 'source-envelope', version: 2 },
        { canonicalUrl: 'https://shop.example/p' },
      ).profile,
    ).toEqual(BASELINE_PROFILE)
  })
  it('records the actually served profile and changes cache validators on activation and rollback', async () => {
    const events: unknown[] = []
    let profile = { id: 'baseline', version: 1 } as CompatibilityManifest['profile']
    const config = {
      storeId: 'store',
      sources: { policies: () => [{ title: 'Warranty', url: 'https://shop.example/p', body }] },
      compatibilityProfile: () => profile,
      onEvent: (e: unknown) => {
        events.push(e)
      },
    }
    const req = () =>
      new Request('https://shop.example/p', { headers: { accept: 'text/markdown' } })
    const baseline = await handleRequest(req(), config)
    profile = { id: 'source-envelope', version: 1 }
    const candidate = await handleRequest(req(), config)
    profile = BASELINE_PROFILE
    const rollback = await handleRequest(req(), config)
    expect(candidate?.headers.get('x-rebilder-profile')).toBe('source-envelope@1')
    expect(candidate?.headers.get('etag')).not.toBe(baseline?.headers.get('etag'))
    expect(rollback?.headers.get('etag')).toBe(baseline?.headers.get('etag'))
    expect(events[1]).toMatchObject({
      response: { profile_id: 'source-envelope', profile_version: 1, compatibility_runtime: 1 },
    })
  })
})
describe('signed background updates', () => {
  it('rejects tampering, foreign audiences, expired/future payloads, unknown runtime and replay', async () => {
    const { publicKeys, sign } = await signer()
    const options = { publicKeys, audience: 'store-1', now }
    expect(await verifyCompatibilityManifest(await sign(), options)).toMatchObject({ ok: true })
    const signed = await sign()
    signed.manifest = { ...manifest, profile: { id: 'section-index', version: 1 } }
    expect(await verifyCompatibilityManifest(signed, options)).toMatchObject({
      ok: false,
      reason: 'invalid-signature',
    })
    for (const [patch, reason] of [
      [{ audience: 'other' }, 'wrong-audience'],
      [
        {
          issuedAt: new Date(now - 5000).toISOString(),
          expiresAt: new Date(now - 1).toISOString(),
        },
        'expired-manifest',
      ],
      [{ issuedAt: new Date(now + 120000).toISOString() }, 'future-manifest'],
      [{ runtime: { min: 2, max: 3 } }, 'unsupported-runtime'],
    ] as const)
      expect(
        await verifyCompatibilityManifest(await sign({ ...manifest, ...patch }), options),
      ).toMatchObject({ ok: false, reason })
    expect(
      await verifyCompatibilityManifest(await sign(), { ...options, minimumSequence: 2 }),
    ).toMatchObject({ ok: false, reason: 'replayed-manifest' })
  })
  it('keeps the last good profile during failed refresh and restores a validated durable cache', async () => {
    const { publicKeys, sign } = await signer()
    let cached: unknown = null
    let response = await sign()
    const fetcher = vi.fn(async () => Response.json(response))
    const options = {
      url: 'https://updates.example/profile',
      audience: 'store-1',
      publicKeys,
      now: () => now,
      fetch: fetcher as typeof fetch,
      cache: {
        load: async () => cached,
        save: async (v: unknown) => {
          cached = v
        },
      },
    }
    const updater = createCompatibilityUpdater(options)
    expect(updater.current()).toEqual(BASELINE_PROFILE)
    expect(fetcher).not.toHaveBeenCalled()
    expect((await updater.refresh()).state).toBe('active')
    response = {
      ...response,
      signature: response.signature.replace(/^./, response.signature[0] === 'A' ? 'B' : 'A'),
    }
    expect((await updater.refresh()).state).toBe('rejected')
    expect(updater.current()).toEqual(manifest.profile)
    const restored = createCompatibilityUpdater(options)
    expect((await restored.restore()).state).toBe('active')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(updater.rollback().profile).toEqual(BASELINE_PROFILE)
  })
  it('expires to the local baseline, rejects oversized streams and prevents equal-sequence replacement', async () => {
    const { publicKeys, sign } = await signer()
    let clock = now
    let response: Response = Response.json(await sign())
    const updater = createCompatibilityUpdater({
      url: 'https://updates.example/profile',
      audience: 'store-1',
      publicKeys,
      now: () => clock,
      fetch: async () => response,
    })
    await updater.refresh()
    response = Response.json(await sign({ ...manifest, profile: BASELINE_PROFILE }))
    expect((await updater.refresh()).reason).toBe('sequence-conflict')
    response = new Response('x'.repeat(16385))
    expect((await updater.refresh()).state).toBe('unavailable')
    expect(updater.current()).toEqual(manifest.profile)
    clock = now + 86400001
    expect(updater.status()).toMatchObject({ state: 'expired', profile: BASELINE_PROFILE })
  })
})

it('does not let an in-flight refresh undo a local rollback', async () => {
  const { publicKeys, sign } = await signer()
  const signed = await sign()
  let release!: (response: Response) => void
  const response = new Promise<Response>((resolve) => {
    release = resolve
  })
  const updater = createCompatibilityUpdater({
    url: 'https://updates.example/profile',
    audience: 'store-1',
    publicKeys,
    now: () => now,
    fetch: async () => response,
  })
  const pending = updater.refresh()
  updater.rollback()
  release(Response.json(signed))
  await pending
  expect(updater.status()).toMatchObject({ profile: BASELINE_PROFILE, reason: 'local-rollback' })
})

it('retains the replay high-water mark when restoring an expired signed cache', async () => {
  const { publicKeys, sign } = await signer()
  const expired = await sign({
    ...manifest,
    sequence: 10,
    issuedAt: new Date(now - 10000).toISOString(),
    expiresAt: new Date(now - 1).toISOString(),
  })
  const older = await sign({ ...manifest, sequence: 9 })
  const updater = createCompatibilityUpdater({
    url: 'https://updates.example/profile',
    audience: 'store-1',
    publicKeys,
    now: () => now,
    cache: { load: async () => expired, save: async () => {} },
    fetch: async () => Response.json(older),
  })
  expect(await updater.restore()).toMatchObject({
    sequence: 10,
    state: 'expired',
    profile: BASELINE_PROFILE,
  })
  expect(await updater.refresh()).toMatchObject({
    reason: 'replayed-manifest',
    profile: BASELINE_PROFILE,
  })
})

it('bounds a transport that ignores cancellation and rejects its late activation', async () => {
  const { publicKeys, sign } = await signer()
  let release!: (response: Response) => void
  const response = new Promise<Response>((resolve) => {
    release = resolve
  })
  const updater = createCompatibilityUpdater({
    url: 'https://updates.example/profile',
    audience: 'store-1',
    publicKeys,
    now: () => now,
    timeoutMs: 100,
    fetch: async () => response,
  })
  expect(await updater.refresh()).toMatchObject({ state: 'unavailable', reason: 'update-timeout' })
  release(Response.json(await sign()))
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(updater.current()).toEqual(BASELINE_PROFILE)
})

it('a delayed cache restore cannot reactivate after local rollback', async () => {
  const { publicKeys, sign } = await signer()
  let complete!: (value: unknown) => void
  const loading = new Promise<unknown>((resolve) => {
    complete = resolve
  })
  const updater = createCompatibilityUpdater({
    url: 'https://updates.example/profile',
    audience: 'store-1',
    publicKeys,
    now: () => now,
    cache: { load: async () => loading, save: async () => {} },
  })
  const pending = updater.restore()
  updater.rollback()
  complete(await sign())
  await pending
  expect(updater.status()).toMatchObject({ profile: BASELINE_PROFILE, reason: 'local-rollback' })
})

it('a delayed old restore cannot lower the sequence accepted from a concurrent refresh', async () => {
  const { publicKeys, sign } = await signer()
  const old = await sign()
  const newer = await sign({
    ...manifest,
    sequence: 20,
    profile: { id: 'section-index', version: 1 },
  })
  let complete!: (value: unknown) => void
  const loading = new Promise<unknown>((resolve) => {
    complete = resolve
  })
  const updater = createCompatibilityUpdater({
    url: 'https://updates.example/profile',
    audience: 'store-1',
    publicKeys,
    now: () => now,
    cache: { load: async () => loading, save: async () => {} },
    fetch: async () => Response.json(newer),
  })
  const restoring = updater.restore()
  await updater.refresh()
  complete(old)
  await restoring
  expect(updater.status()).toMatchObject({
    sequence: 20,
    profile: { id: 'section-index', version: 1 },
  })
})
