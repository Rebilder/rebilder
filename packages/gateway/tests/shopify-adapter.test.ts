import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { RebilderEventV0 } from '@rebilder/events'
import type { GatewayConfig } from '../src/index'
import {
  createShopifyAppProxyHandler,
  verifyAppProxySignature,
} from '../src/adapters/shopify/index'
import {
  BROWSER_CHROME_HEADERS,
  CLAUDE_CODE_HEADERS,
  GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS,
  PDP_PATH,
  makeRequest,
  pathMatchedSources,
} from './fixtures'

// ---------------------------------------------------------------------------
// Signed-request builder. The signature is DERIVED in-test with node:crypto's
// HMAC-SHA256 over the documented canonicalization (sorted key=value strings,
// no separator, repeated values comma-joined) — an implementation independent
// of the adapter's Web Crypto path, so a valid fixture is computed, never
// hardcoded, and the two implementations cross-check each other.
// ---------------------------------------------------------------------------

const SECRET = 'shpss_test_shared_secret'
const APP_ORIGIN = 'https://gateway.rebilder.app'
const SHOP = 'acme-outdoors.myshopify.com'
const PATH_PREFIX = '/apps/rebilder'

function signMessage(message: string, secret: string = SECRET): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex')
}

/** Canonicalize decoded params per Shopify's app-proxy spec and sign them. */
function signParams(params: URLSearchParams, secret: string = SECRET): string {
  const byKey = new Map<string, string[]>()
  for (const [key, value] of params) {
    const values = byKey.get(key) ?? []
    values.push(value)
    byKey.set(key, values)
  }
  const message = [...byKey.entries()]
    .map(([key, values]) => `${key}=${values.join(',')}`)
    .sort()
    .join('')
  return signMessage(message, secret)
}

interface ProxyRequestOptions {
  /** Canonical storefront path (after the proxy prefix). */
  path?: string
  /** Proxy prefix as received in the request path. */
  prefix?: string
  headers?: Record<string, string>
  /** Unix seconds; defaults to "now". */
  timestamp?: number
  /** Extra (merchant/agent) query params, appended in order. */
  extraParams?: [string, string][]
  /** Mutate params AFTER signing (to build tampered requests). */
  tamper?: (params: URLSearchParams) => void
}

function proxyRequest(options: ProxyRequestOptions = {}): Request {
  const {
    path = PDP_PATH,
    prefix = PATH_PREFIX,
    headers = CLAUDE_CODE_HEADERS,
    timestamp = Math.floor(Date.now() / 1000),
    extraParams = [],
    tamper,
  } = options
  const params = new URLSearchParams()
  params.set('shop', SHOP)
  params.set('path_prefix', PATH_PREFIX)
  params.set('timestamp', String(timestamp))
  params.set('logged_in_customer_id', '')
  for (const [key, value] of extraParams) params.append(key, value)
  params.set('signature', signParams(params))
  if (tamper !== undefined) tamper(params)
  return makeRequest(`${prefix}${path}?${params.toString()}`, headers)
}

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return { storeId: 'store_test', sources: pathMatchedSources(), ...overrides }
}

function handler(overrides: Partial<GatewayConfig> = {}, pathPrefix?: string) {
  return createShopifyAppProxyHandler(config(overrides), {
    sharedSecret: SECRET,
    ...(pathPrefix !== undefined ? { pathPrefix } : {}),
  })
}

// makeRequest builds against STORE_ORIGIN; the proxy handler must not care
// which host Shopify forwards to, so run some requests on the app origin too.
function proxyRequestOnAppOrigin(options: ProxyRequestOptions = {}): Request {
  const req = proxyRequest(options)
  const url = new URL(req.url)
  const target = new URL(url.pathname + url.search, APP_ORIGIN)
  return new Request(target, { method: req.method, headers: req.headers })
}

describe('verifyAppProxySignature', () => {
  it('accepts a signature derived with the same canonicalization + HMAC', async () => {
    const url = new URL(proxyRequest().url)
    await expect(verifyAppProxySignature(url, SECRET)).resolves.toBe(true)
  })

  it('rejects when any signed param is tampered with', async () => {
    const url = new URL(proxyRequest({ tamper: (p) => p.set('shop', 'evil.example.com') }).url)
    await expect(verifyAppProxySignature(url, SECRET)).resolves.toBe(false)
  })

  it('rejects a missing or empty signature param', async () => {
    const missing = new URL(proxyRequest({ tamper: (p) => p.delete('signature') }).url)
    await expect(verifyAppProxySignature(missing, SECRET)).resolves.toBe(false)
    const empty = new URL(proxyRequest({ tamper: (p) => p.set('signature', '') }).url)
    await expect(verifyAppProxySignature(empty, SECRET)).resolves.toBe(false)
  })

  it('rejects a signature made with the wrong secret', async () => {
    const params = new URLSearchParams({ shop: SHOP, timestamp: '1754265600' })
    params.set('signature', signParams(params, 'some-other-secret'))
    const url = new URL(`${APP_ORIGIN}${PATH_PREFIX}${PDP_PATH}?${params.toString()}`)
    await expect(verifyAppProxySignature(url, SECRET)).resolves.toBe(false)
  })

  it('joins repeated params with "," (explicit hand-built message)', async () => {
    // Canonical message built BY HAND, sorted manually — no shared code with
    // the adapter's canonicalization at all.
    const message = `extra=1,2path_prefix=${PATH_PREFIX}shop=${SHOP}timestamp=1754265600`
    const signature = signMessage(message)
    const url = new URL(
      `${APP_ORIGIN}${PATH_PREFIX}${PDP_PATH}` +
        `?extra=1&extra=2&shop=${SHOP}&path_prefix=${encodeURIComponent(PATH_PREFIX)}` +
        `&timestamp=1754265600&signature=${signature}`,
    )
    await expect(verifyAppProxySignature(url, SECRET)).resolves.toBe(true)
  })

  it('rejects repeated params joined any other way (e.g. two key=value entries)', async () => {
    const wrongJoin = `extra=1extra=2path_prefix=${PATH_PREFIX}shop=${SHOP}timestamp=1754265600`
    const signature = signMessage(wrongJoin)
    const url = new URL(
      `${APP_ORIGIN}${PATH_PREFIX}${PDP_PATH}` +
        `?extra=1&extra=2&shop=${SHOP}&path_prefix=${encodeURIComponent(PATH_PREFIX)}` +
        `&timestamp=1754265600&signature=${signature}`,
    )
    await expect(verifyAppProxySignature(url, SECRET)).resolves.toBe(false)
  })
})

describe('createShopifyAppProxyHandler — verification gate', () => {
  it('serves markdown for an agent Accept on a wired source (valid signature)', async () => {
    const res = await handler()(proxyRequest())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('x-rebilder-path')).toBe('markdown')
    const body = await res.text()
    expect(body).toContain('Trail Runner 2')
    expect(body).toContain('$89.00')
  })

  it('returns 401 JSON on an invalid signature — content is never served', async () => {
    const res = await handler()(proxyRequest({ tamper: (p) => p.set('shop', 'evil.example.com') }))
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toMatchObject({ error: 'invalid_signature' })
  })

  it('returns 401 on a missing signature param', async () => {
    const res = await handler()(proxyRequest({ tamper: (p) => p.delete('signature') }))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'invalid_signature' })
  })

  it('returns 401 JSON on a stale timestamp (validly signed)', async () => {
    const res = await handler()(proxyRequest({ timestamp: Math.floor(Date.now() / 1000) - 200 }))
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toMatchObject({ error: 'stale_timestamp' })
  })

  it('accepts a timestamp within the 90s window', async () => {
    const res = await handler()(proxyRequest({ timestamp: Math.floor(Date.now() / 1000) - 80 }))
    expect(res.status).toBe(200)
  })

  it('tolerates small clock skew (timestamp slightly in the future)', async () => {
    const res = await handler()(proxyRequest({ timestamp: Math.floor(Date.now() / 1000) + 3 }))
    expect(res.status).toBe(200)
  })

  it('rejects a timestamp too far in the future (401)', async () => {
    const res = await handler()(proxyRequest({ timestamp: Math.floor(Date.now() / 1000) + 60 }))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'stale_timestamp' })
  })

  it('rejects a request with the timestamp param removed after signing... which also breaks the signature', async () => {
    // Removing timestamp invalidates the signature first — the gate holds
    // either way; a validly-signed URL simply cannot lack the timestamp.
    const res = await handler()(proxyRequest({ tamper: (p) => p.delete('timestamp') }))
    expect(res.status).toBe(401)
  })
})

describe('createShopifyAppProxyHandler — URL reconstruction', () => {
  it('strips the path prefix and Shopify params; host comes from the signed shop param', async () => {
    const seen: URL[] = []
    const res = await handler({
      sources: {
        product: (url) => {
          seen.push(url)
          return url.pathname === PDP_PATH ? pathMatchedSources().product(url) : null
        },
      },
    })(proxyRequestOnAppOrigin({ extraParams: [['variant', 'v-10']] }))
    expect(res.status).toBe(200)
    expect(seen).toHaveLength(1)
    const url = seen[0]!
    expect(url.protocol).toBe('https:')
    expect(url.host).toBe(SHOP)
    expect(url.pathname).toBe(PDP_PATH)
    // Shopify's injected params are gone; merchant/agent params survive.
    for (const param of [
      'shop',
      'path_prefix',
      'timestamp',
      'signature',
      'logged_in_customer_id',
    ]) {
      expect(url.searchParams.has(param)).toBe(false)
    }
    expect(url.searchParams.get('variant')).toBe('v-10')
  })

  it('emits the standard event carrying the canonical storefront URL', async () => {
    const events: RebilderEventV0[] = []
    const res = await handler({
      onEvent: (event) => {
        events.push(event)
      },
    })(proxyRequestOnAppOrigin())
    expect(res.status).toBe(200)
    expect(events).toHaveLength(1)
    expect(events[0]!.requester).toEqual({
      kind: 'agent',
      platform: 'claude-code',
      verified: false,
    })
    expect(events[0]!.response.path).toBe('markdown')
    const eventUrl = new URL(events[0]!.request.url)
    expect(eventUrl.host).toBe(SHOP)
    expect(eventUrl.pathname).toBe(PDP_PATH)
  })

  it('behaves identically across pathPrefix variants (custom prefix, trailing slash)', async () => {
    const custom = await handler({}, '/apps/gateway')(proxyRequest({ prefix: '/apps/gateway' }))
    const trailing = await handler({}, '/apps/rebilder/')(proxyRequest())
    const dflt = await handler()(proxyRequest())
    expect(custom.status).toBe(200)
    expect(trailing.status).toBe(200)
    const defaultBody = await dflt.text()
    expect(await custom.text()).toBe(defaultBody)
    expect(await trailing.text()).toBe(defaultBody)
  })

  it('strips the prefix on whole segments only (/apps/rebilderx is not /apps/rebilder + x)', async () => {
    const res = await handler()(proxyRequest({ prefix: '/apps/rebilderx' }))
    // '/apps/rebilderx/products/…' is left untouched → no source match → 404.
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'no_source' })
  })
})

describe('createShopifyAppProxyHandler — pass-throughs become 404 no_source', () => {
  it('returns 404 JSON when no source matches (the proxy IS the endpoint)', async () => {
    const res = await handler()(proxyRequest({ path: '/no-such-page' }))
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toMatchObject({ error: 'no_source' })
  })

  it('returns 404 (never 500) when the matching source throws', async () => {
    const res = await handler({
      sources: {
        product: () => {
          throw new Error('merchant bug')
        },
      },
    })(proxyRequest())
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'no_source' })
  })

  it('returns 404 for a human browser (html path has no downstream here)', async () => {
    const res = await handler()(proxyRequest({ headers: BROWSER_CHROME_HEADERS }))
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'no_source' })
  })

  it('never serves markdown to a crawler, even asking for it (consistent source content)', async () => {
    const res = await handler()(proxyRequest({ headers: GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS }))
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
  })
})

// ---------------------------------------------------------------------------
// Per-request config. A merchant self-hosting this adapter has one store and
// passes a plain config; a host serving many merchants behind one app cannot,
// because the config depends on which store asked. The `shop` param is the
// tenant, and it is covered by the signature — which is exactly why the
// resolver must run downstream of verification and not a line earlier.
// ---------------------------------------------------------------------------
describe('createShopifyAppProxyHandler — a config resolved per request', () => {
  it('is called with the verified canonical URL, not the raw proxy URL', async () => {
    const seen: string[] = []
    const res = await createShopifyAppProxyHandler(
      (url) => {
        seen.push(url.toString())
        return config()
      },
      { sharedSecret: SECRET },
    )(proxyRequestOnAppOrigin())

    expect(res.status).toBe(200)
    // Prefix stripped, injected params dropped, host from the signed `shop`.
    expect(seen).toEqual([`https://${SHOP}${PDP_PATH}`])
  })

  it('accepts an async resolver — a multi-tenant host reads a database here', async () => {
    const res = await createShopifyAppProxyHandler(async () => config(), {
      sharedSecret: SECRET,
    })(proxyRequest())
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Trail Runner 2')
  })

  it('404s when the resolver recognises no tenant', async () => {
    const res = await createShopifyAppProxyHandler(() => null, { sharedSecret: SECRET })(
      proxyRequest(),
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'no_source' })
  })

  it('NEVER runs the resolver on an unverified request', async () => {
    // The security property. A resolver is a database read for a multi-tenant
    // host; running it before the signature check would let any stranger drive
    // a query per request against a public endpoint, with no credential.
    let called = 0
    const resolver = () => {
      called += 1
      return config()
    }

    const forged = await createShopifyAppProxyHandler(resolver, { sharedSecret: SECRET })(
      proxyRequest({ tamper: (p) => p.set('shop', 'evil.example.com') }),
    )
    expect(forged.status).toBe(401)
    expect(called).toBe(0)

    const stale = await createShopifyAppProxyHandler(resolver, { sharedSecret: SECRET })(
      proxyRequest({ timestamp: Math.floor(Date.now() / 1000) - 3600 }),
    )
    expect(stale.status).toBe(401)
    expect(called).toBe(0)
  })
})
