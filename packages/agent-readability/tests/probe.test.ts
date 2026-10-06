/**
 * probe.test.ts — the impure half, held to the same standard as the pure one.
 *
 * These tests are written against the two properties that make the probe safe to
 * point at a stranger's origin, and the one property that makes its output worth
 * scoring:
 *
 *  - IT CANNOT BE TALKED INTO A PRIVATE ADDRESS. Not by an IP literal, not by a
 *    DNS answer, not by a redirect, not on hop three.
 *  - IT CANNOT BE MADE TO SWALLOW AN UNBOUNDED BODY. The cap is enforced on the
 *    stream, not on what gets stored, and the read is actually cancelled.
 *  - IT SENDS EXACTLY THE §3.3 REQUEST SET, with the agent and browser probes
 *    differing in `Accept` and in nothing else.
 *
 * Every test injects both the transport and the resolver. Nothing here touches
 * real DNS or a real socket — that is `ssrf.test.ts`'s job, against a local
 * server, where the assertion is about pinning rather than about policy.
 */

import { describe, expect, it, vi } from 'vitest'

import { score } from '../src/index'
import { createLimiter, ProbeBudgetExceededError, type Limiter } from '../src/probe/limiter'
import {
  ARS_USER_AGENT,
  DEFAULT_IDENTITIES,
  fromWebResponse,
  probeStrict,
  strictPolicy,
  type ProbeHttpResponse,
  type ProbeIdentity,
  type ProbePolicy,
  type ProbeTransport,
} from '../src/probe/index'
import type { HostResolver, PinnedAddress } from '../src/probe/ssrf'
import type { ArsEvidence, ArsProbeRecord } from '../src/types'

/* ── harness ──────────────────────────────────────────────────────────────── */

const PUBLIC_V4: PinnedAddress[] = [{ address: '93.184.216.34', family: 4 }]

function resolverFor(map: Record<string, PinnedAddress[]> = {}): HostResolver & { seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    resolve(hostname: string) {
      seen.push(hostname)
      return Promise.resolve(map[hostname] ?? PUBLIC_V4)
    },
  }
}

interface Seen {
  url: string
  headers: Record<string, string>
}

type Route = (url: string) => Response | ProbeHttpResponse

function transportFor(routes: Record<string, Route>, fallback?: Route) {
  const seen: Seen[] = []
  const transport: ProbeTransport = (url, init) => {
    seen.push({ url, headers: { ...init.headers } })
    const route = routes[url] ?? fallback
    if (route === undefined) {
      return Promise.resolve(fromWebResponse(new Response('not found', { status: 404 })))
    }
    const produced = route(url)
    return Promise.resolve(produced instanceof Response ? fromWebResponse(produced) : produced)
  }
  return { transport, seen }
}

function html(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } })
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } })
}

/** A limiter that does not make the suite wait a real second between requests. */
function testLimiter(overrides: Parameters<typeof createLimiter>[0] = {}): Limiter {
  return createLimiter({ minIntervalPerHostMs: 0, maxProbesPerRun: 100, ...overrides })
}

function policyFor(overrides: Partial<ProbePolicy> = {}): ProbePolicy {
  return { ...strictPolicy(testLimiter()), ...overrides }
}

function capture(record: ArsProbeRecord | null) {
  if (record === null || !record.result.ok) return null
  return record.result.capture
}

const PAGE = 'https://shop.example.com/products/kettle'
const ORIGIN = 'https://shop.example.com'

function siteRoutes(overrides: Record<string, Route> = {}): Record<string, Route> {
  return {
    [`${ORIGIN}/robots.txt`]: () =>
      text('User-agent: *\nAllow: /\nSitemap: https://shop.example.com/sitemap.xml\n'),
    [PAGE]: () => html('<html><head><title>Kettle</title></head><body><p>£29.00</p></body></html>'),
    [`${ORIGIN}/llms.txt`]: () => text('# Shop\n'),
    [`${ORIGIN}/.well-known/ucp`]: () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ...overrides,
  }
}

/* ── the linked Markdown copy (ARS 0.3) ───────────────────────────────────── */

describe('probeStrict — a linked Markdown copy is fetched once, and only when it matters', () => {
  const MD = `${ORIGIN}/products/kettle.md`
  const linkedPage = () =>
    html(
      '<html><head><title>Kettle</title><link rel="alternate" type="text/markdown" href="/products/kettle.md"></head><body><p>£29.00</p></body></html>',
    )
  const markdown = () =>
    new Response('# Kettle\n\n- **Price:** £29.00\n', {
      status: 200,
      headers: { 'content-type': 'text/markdown' },
    })

  it('fetches the declared copy with the agent headers, after the two page probes', async () => {
    const { transport, seen } = transportFor(siteRoutes({ [PAGE]: linkedPage, [MD]: markdown }))
    const outcome = await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor() })
    expect(outcome.ok).toBe(true)
    expect(seen.map((entry) => entry.url)).toEqual([
      `${ORIGIN}/robots.txt`,
      PAGE,
      PAGE,
      MD,
      `${ORIGIN}/llms.txt`,
      `${ORIGIN}/.well-known/ucp`,
    ])
    expect(seen[3]?.headers.accept).toBe(seen[1]?.headers.accept)
    if (!outcome.ok) return
    expect(capture(outcome.evidence.probes.markdownAlternate ?? null)?.requestedUrl).toBe(MD)
    const d2 = score(outcome.evidence).dimensions.find((d) => d.id === 'machine-representation')
    expect(
      d2?.checks.find((c) => c.id === 'machine-representation.negotiated-response')?.earned,
    ).toBe(6)
  })

  it('does not fetch it when the page already sends a Markdown copy itself', async () => {
    const negotiating: Route = () => markdown()
    const { transport, seen } = transportFor(siteRoutes({ [PAGE]: negotiating, [MD]: markdown }))
    const outcome = await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor() })
    expect(seen.map((entry) => entry.url)).not.toContain(MD)
    if (outcome.ok) expect('markdownAlternate' in outcome.evidence.probes).toBe(false)
  })

  it('never follows a link to another origin', async () => {
    const offsite = () =>
      html(
        '<html><head><link rel="alternate" type="text/markdown" href="https://elsewhere.example/k.md"></head><body></body></html>',
      )
    const { transport, seen } = transportFor(siteRoutes({ [PAGE]: offsite }))
    await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor() })
    expect(seen.map((entry) => entry.url)).not.toContain('https://elsewhere.example/k.md')
  })

  it('obeys robots.txt for the linked path', async () => {
    const { transport, seen } = transportFor(
      siteRoutes({
        [`${ORIGIN}/robots.txt`]: () =>
          text('User-agent: rebilder-ars\nDisallow: /products/kettle.md\n'),
        [PAGE]: linkedPage,
        [MD]: markdown,
      }),
    )
    const outcome = await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor() })
    expect(seen.map((entry) => entry.url)).not.toContain(MD)
    if (outcome.ok) expect(outcome.evidence.probes.markdownAlternate?.result.ok).toBe(false)
  })
})

/* ── the request set ──────────────────────────────────────────────────────── */

describe('probeStrict — the §3.3 request set, and nothing else', () => {
  it('fetches robots.txt first, then agent, browser, llms.txt, /.well-known/ucp — five requests', async () => {
    const { transport, seen } = transportFor(siteRoutes())
    const outcome = await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor() })

    expect(outcome.ok).toBe(true)
    expect(seen.map((entry) => entry.url)).toEqual([
      `${ORIGIN}/robots.txt`,
      PAGE,
      PAGE,
      `${ORIGIN}/llms.txt`,
      `${ORIGIN}/.well-known/ucp`,
    ])
  })

  it('guesses no other path — no sitemap.xml, no /mcp, no /acp', async () => {
    const { transport, seen } = transportFor(siteRoutes())
    await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor() })
    const paths = seen.map((entry) => new URL(entry.url).pathname)
    expect(paths).not.toContain('/sitemap.xml')
    expect(paths).not.toContain('/mcp')
    expect(paths).not.toContain('/acp')
  })

  it('sends the SAME User-Agent to both probes and differs only in Accept', async () => {
    const { transport, seen } = transportFor(siteRoutes())
    await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor() })

    const [, agent, browser] = seen
    expect(agent?.headers['user-agent']).toBe(ARS_USER_AGENT)
    expect(browser?.headers['user-agent']).toBe(agent?.headers['user-agent'])
    expect(agent?.headers.accept).toContain('text/markdown')
    expect(browser?.headers.accept).toContain('text/html')
    expect(agent?.headers.accept).not.toBe(browser?.headers.accept)

    // The full header sets differ in exactly one key.
    const differing = Object.keys({ ...agent?.headers, ...browser?.headers }).filter(
      (key) => agent?.headers[key] !== browser?.headers[key],
    )
    expect(differing).toEqual(['accept'])
  })

  it('produces a bundle score() accepts', async () => {
    const { transport } = transportFor(siteRoutes())
    const outcome = await probeStrict(PAGE, policyFor(), {
      transport,
      resolver: resolverFor(),
      now: () => new Date('2026-08-05T00:00:00.000Z'),
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const evidence: ArsEvidence = outcome.evidence
    expect(evidence.evidenceVersion).toBe('0.1.0')
    expect(evidence.target).toEqual({ url: PAGE, origin: ORIGIN })
    expect(evidence.capturedAt).toBe('2026-08-05T00:00:00.000Z')
    expect(evidence.probes.parityConfirm).toBeNull()

    const result = score(evidence)
    expect(result.spec).toBe('ars')
    expect(result.outcome.kind).toBe('scored')
    expect(result.target.finalUrl).toBe(PAGE)
  })

  it('records the decoded byte length and a body hash on every capture', async () => {
    const body = '<html><body>café</body></html>'
    const { transport } = transportFor(siteRoutes({ [PAGE]: () => html(body) }))
    const outcome = await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor() })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const agent = capture(outcome.evidence.probes.agent)
    expect(agent?.body).toBe(body)
    expect(agent?.bytes).toBe(new TextEncoder().encode(body).length)
    expect(agent?.bytes).toBe(body.length + 1) // é is two UTF-8 bytes
    expect(agent?.bodySha256).toMatch(/^[0-9a-f]{64}$/)
    expect(agent?.truncated).toBe(false)
  })
})

/* ── the byte cap ─────────────────────────────────────────────────────────── */

describe('probeStrict — the 2 MiB streamed body cap', () => {
  function bigStream(
    totalChunks: number,
    chunkSize: number,
    onCancel: () => void,
  ): ProbeHttpResponse {
    const encoder = new TextEncoder()
    const chunk = encoder.encode('a'.repeat(chunkSize))
    let sent = 0
    return {
      status: 200,
      headers: { 'content-type': ['text/html; charset=utf-8'] },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= totalChunks) {
            controller.close()
            return
          }
          sent += 1
          controller.enqueue(chunk)
        },
        cancel() {
          onCancel()
        },
      }),
    }
  }

  it('stops at the cap, records truncated:true, and CANCELS the stream', async () => {
    let cancelled = false
    const { transport } = transportFor(
      siteRoutes({ [PAGE]: () => bigStream(1_000, 4_096, () => (cancelled = true)) }),
    )
    const outcome = await probeStrict(PAGE, policyFor({ maxBodyBytes: 10_000 }), {
      transport,
      resolver: resolverFor(),
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const agent = capture(outcome.evidence.probes.agent)
    expect(agent?.truncated).toBe(true)
    expect(agent?.bytes).toBe(10_000)
    expect(agent?.body?.length).toBe(10_000)
    // Without the cancel the origin keeps sending and the cap only limits what
    // we keep — which is exactly the shipped defect this replaces.
    expect(cancelled).toBe(true)
  })

  it('never splits a multi-byte character across the cap', async () => {
    // 5 000 × 'é' = 10 000 UTF-8 bytes; a cap of 9 999 must land on 9 998.
    const body = 'é'.repeat(5_000)
    const { transport } = transportFor(siteRoutes({ [PAGE]: () => html(body) }))
    const outcome = await probeStrict(PAGE, policyFor({ maxBodyBytes: 9_999 }), {
      transport,
      resolver: resolverFor(),
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const agent = capture(outcome.evidence.probes.agent)
    expect(agent?.truncated).toBe(true)
    expect(agent?.bytes).toBe(9_998)
    expect(agent?.body).toBe('é'.repeat(4_999))
    expect(new TextEncoder().encode(agent?.body ?? '').length).toBe(agent?.bytes)
  })

  it('does not cry truncation over a charset that SHRINKS on decode', async () => {
    // UTF-16LE: 6 000 wire bytes decode to 3 000 UTF-8 bytes. A raw ceiling set
    // at the decoded cap would flag this complete body as truncated, which is a
    // lie about the evidence — the cap is normative on DECODED bytes (§3.3).
    const ascii = 'x'.repeat(3_000)
    const wire = new Uint8Array(ascii.length * 2)
    for (let i = 0; i < ascii.length; i++) wire[i * 2] = 0x78
    const response: ProbeHttpResponse = {
      status: 200,
      headers: { 'content-type': ['text/html; charset=utf-16le'] },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(wire)
          controller.close()
        },
      }),
    }
    const { transport } = transportFor(siteRoutes({ [PAGE]: () => response }))
    const outcome = await probeStrict(PAGE, policyFor({ maxBodyBytes: 5_000 }), {
      transport,
      resolver: resolverFor(),
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const agent = capture(outcome.evidence.probes.agent)
    expect(agent?.truncated).toBe(false)
    expect(agent?.bytes).toBe(3_000)
  })

  it('leaves a body that fits well inside the cap untouched', async () => {
    const { transport } = transportFor(siteRoutes())
    const outcome = await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor() })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(capture(outcome.evidence.probes.agent)?.truncated).toBe(false)
  })

  it('defaults the cap to the ruleset value rather than inventing one', () => {
    expect(strictPolicy(testLimiter()).maxBodyBytes).toBe(2 * 1024 * 1024)
    expect(strictPolicy(testLimiter()).maxRedirects).toBe(3)
    expect(strictPolicy(testLimiter()).timeoutMs).toBe(5_000)
    expect(strictPolicy(testLimiter()).allowHttp).toBe(false)
  })
})

/* ── redirects ────────────────────────────────────────────────────────────── */

describe('probeStrict — redirects', () => {
  const redirect = (to: string, status = 302): Response =>
    new Response(null, { status, headers: { location: to } })

  it('follows a redirect and reports the final URL', async () => {
    const moved = 'https://www.shop.example.com/products/kettle'
    const { transport } = transportFor(
      siteRoutes({
        [PAGE]: () => redirect(moved, 301),
        [moved]: () => html('<html><title>Kettle</title></html>'),
      }),
    )
    const outcome = await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor() })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const agent = capture(outcome.evidence.probes.agent)
    expect(agent?.finalUrl).toBe(moved)
    expect(agent?.requestedUrl).toBe(PAGE)
    expect(agent?.redirects).toEqual([{ status: 301, location: moved }])
  })

  it('permits THREE requests, not four — the shipped `hop <= MAX_REDIRECTS` off-by-one', async () => {
    let n = 0
    const hop: Route = () => {
      n += 1
      return redirect(`${ORIGIN}/hop-${n}`)
    }
    const { transport, seen } = transportFor(siteRoutes({ [PAGE]: hop }), hop)

    const outcome = await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor() })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const agentProbe = outcome.evidence.probes.agent
    expect(agentProbe.result.ok).toBe(false)
    if (!agentProbe.result.ok) expect(agentProbe.result.error).toBe('too-many-redirects')

    // robots.txt + exactly three page requests before the agent probe gives up.
    const pageRequests = seen.filter(
      (entry) => entry.url.includes('/products') || entry.url.includes('/hop-'),
    )
    // three for the agent probe, three for the browser control
    expect(pageRequests).toHaveLength(6)
  })

  it('BLOCKS a redirect into a private IP literal', async () => {
    const { transport } = transportFor(
      siteRoutes({ [PAGE]: () => redirect('https://169.254.169.254/latest/meta-data') }),
    )
    const outcome = await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor() })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const agentProbe = outcome.evidence.probes.agent
    expect(agentProbe.result.ok).toBe(false)
    if (!agentProbe.result.ok) {
      expect(agentProbe.result.error).toBe('blocked-redirect')
      expect(agentProbe.result.detail).toContain('Private or reserved')
    }
  })

  it('BLOCKS a redirect to a public hostname that RESOLVES private — the rebinding hop', async () => {
    const { transport } = transportFor(
      siteRoutes({ [PAGE]: () => redirect('https://second-hop.example/') }),
    )
    const resolver = resolverFor({ 'second-hop.example': [{ address: '10.0.0.5', family: 4 }] })

    const outcome = await probeStrict(PAGE, policyFor(), { transport, resolver })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const agentProbe = outcome.evidence.probes.agent
    expect(agentProbe.result.ok).toBe(false)
    if (!agentProbe.result.ok) {
      expect(agentProbe.result.error).toBe('blocked-redirect')
      expect(agentProbe.result.detail).toContain('10.0.0.5')
    }
    // The hostname on hop 2 was resolved rather than merely re-parsed.
    expect(resolver.seen).toContain('second-hop.example')
  })

  it('re-resolves on EVERY hop rather than trusting hop 1', async () => {
    const hop1 = 'https://a.example/'
    const hop2 = 'https://b.example/'
    const { transport } = transportFor({
      [`${ORIGIN}/robots.txt`]: () => text('User-agent: *\nAllow: /\n'),
      [PAGE]: () => redirect(hop1),
      [hop1]: () => redirect(hop2),
      [hop2]: () => html('<html></html>'),
      [`${ORIGIN}/llms.txt`]: () => text('', 404),
      [`${ORIGIN}/.well-known/ucp`]: () => text('', 404),
    })
    const resolver = resolverFor()
    await probeStrict(PAGE, policyFor(), { transport, resolver })

    expect(resolver.seen).toContain('shop.example.com')
    expect(resolver.seen).toContain('a.example')
    expect(resolver.seen).toContain('b.example')
  })

  it('blocks a downgrade redirect to http', async () => {
    const { transport } = transportFor(
      siteRoutes({ [PAGE]: () => redirect('http://shop.example.com/products/kettle') }),
    )
    const outcome = await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor() })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const agentProbe = outcome.evidence.probes.agent
    if (!agentProbe.result.ok) expect(agentProbe.result.error).toBe('blocked-redirect')
    else expect.unreachable('the http downgrade should have been blocked')
  })

  it('reports a redirect with no Location as non-2xx rather than looping', async () => {
    const { transport } = transportFor(
      siteRoutes({ [PAGE]: () => new Response(null, { status: 302 }) }),
    )
    const outcome = await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor() })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const agentProbe = outcome.evidence.probes.agent
    if (!agentProbe.result.ok) expect(agentProbe.result.error).toBe('non-2xx')
    else expect.unreachable('a Location-less redirect is not a capture')
  })
})

/* ── DNS ──────────────────────────────────────────────────────────────────── */

describe('probeStrict — DNS is resolved and validated before anything is fetched', () => {
  it('refuses a syntactically perfect hostname whose A record is cloud metadata', async () => {
    const { transport, seen } = transportFor(siteRoutes())
    const resolver = resolverFor({
      'shop.example.com': [{ address: '169.254.169.254', family: 4 }],
    })

    const outcome = await probeStrict(PAGE, policyFor(), { transport, resolver })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    // Not one request left the process.
    expect(seen).toHaveLength(0)
    const robots = outcome.evidence.probes.robotsTxt
    expect(robots?.result.ok).toBe(false)
    if (robots && !robots.result.ok) expect(robots.result.detail).toContain('169.254.169.254')
  })

  it('reports a DNS failure as unreachable, which score() turns into unscored', async () => {
    const { transport } = transportFor(siteRoutes())
    const resolver: HostResolver = { resolve: () => Promise.reject(new Error('ENOTFOUND')) }

    const outcome = await probeStrict(PAGE, policyFor(), {
      transport,
      resolver,
      sleep: () => Promise.resolve(),
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const result = score(outcome.evidence)
    expect(result.outcome.kind).toBe('unscored')
  })
})

/* ── robots ───────────────────────────────────────────────────────────────── */

describe('probeStrict — robots.txt', () => {
  it('does not fetch the page when robots.txt disallows rebilder-ars', async () => {
    const { transport, seen } = transportFor(
      siteRoutes({
        [`${ORIGIN}/robots.txt`]: () => text('User-agent: rebilder-ars\nDisallow: /\n'),
      }),
    )
    const outcome = await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor() })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(seen.map((entry) => entry.url)).toEqual([`${ORIGIN}/robots.txt`])
    const result = score(outcome.evidence)
    expect(result.outcome).toMatchObject({ kind: 'unscored', reason: 'robots-disallow-scanner' })
  })

  it('obeys a path-scoped disallow only on the paths it names', async () => {
    const { transport, seen } = transportFor(
      siteRoutes({
        [`${ORIGIN}/robots.txt`]: () => text('User-agent: rebilder-ars\nDisallow: /llms.txt\n'),
      }),
    )
    const outcome = await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor() })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(seen.map((entry) => entry.url)).not.toContain(`${ORIGIN}/llms.txt`)
    expect(seen.map((entry) => entry.url)).toContain(PAGE)
    const llms = outcome.evidence.probes.llmsTxt
    expect(llms?.result.ok).toBe(false)
  })

  it('ignores a blanket User-agent: * disallow — that is not a decision about us', async () => {
    const { transport, seen } = transportFor(
      siteRoutes({ [`${ORIGIN}/robots.txt`]: () => text('User-agent: *\nDisallow: /\n') }),
    )
    const outcome = await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor() })
    expect(outcome.ok).toBe(true)
    expect(seen.map((entry) => entry.url)).toContain(PAGE)
  })

  it('retries a 5xx robots.txt once and proceeds when the retry succeeds', async () => {
    let attempts = 0
    const slept: number[] = []
    const { transport, seen } = transportFor(
      siteRoutes({
        [`${ORIGIN}/robots.txt`]: () => {
          attempts += 1
          return attempts === 1 ? text('boom', 503) : text('User-agent: *\nAllow: /\n')
        },
      }),
    )
    const outcome = await probeStrict(PAGE, policyFor(), {
      transport,
      resolver: resolverFor(),
      sleep: (ms) => {
        slept.push(ms)
        return Promise.resolve()
      },
    })

    expect(attempts).toBe(2)
    expect(slept).toEqual([5_000])
    expect(seen.map((entry) => entry.url)).toContain(PAGE)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(score(outcome.evidence).outcome.kind).toBe('scored')
  })

  it('a PERSISTENT 5xx un-scores the target and stops the scan', async () => {
    const { transport, seen } = transportFor(
      siteRoutes({ [`${ORIGIN}/robots.txt`]: () => text('boom', 503) }),
    )
    const outcome = await probeStrict(PAGE, policyFor(), {
      transport,
      resolver: resolverFor(),
      sleep: () => Promise.resolve(),
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(seen.map((entry) => entry.url)).toEqual([`${ORIGIN}/robots.txt`, `${ORIGIN}/robots.txt`])
    expect(score(outcome.evidence).outcome).toMatchObject({
      kind: 'unscored',
      reason: 'robots-unavailable',
    })
  })

  it('a missing robots.txt (404) is not an error — the scan proceeds', async () => {
    const { transport } = transportFor(
      siteRoutes({ [`${ORIGIN}/robots.txt`]: () => text('nope', 404) }),
    )
    const outcome = await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor() })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(score(outcome.evidence).outcome.kind).toBe('scored')
  })

  it('does not apply the scanner gate to a self vantage — you need no permission to read your own site', async () => {
    const { transport, seen } = transportFor(
      siteRoutes({
        [`${ORIGIN}/robots.txt`]: () => text('User-agent: rebilder-ars\nDisallow: /\n'),
      }),
    )
    await probeStrict(PAGE, policyFor(), { transport, resolver: resolverFor(), vantage: 'self' })
    expect(seen.map((entry) => entry.url)).toContain(PAGE)
  })
})

/* ── policy and identity ──────────────────────────────────────────────────── */

describe('probeStrict — policy rejections happen before any socket', () => {
  it('rejects an unparseable target as invalid-url', async () => {
    const { transport, seen } = transportFor(siteRoutes())
    const outcome = await probeStrict('not a url', policyFor(), {
      transport,
      resolver: resolverFor(),
    })
    expect(outcome).toMatchObject({ ok: false, rejection: 'invalid-url' })
    expect(seen).toHaveLength(0)
  })

  it.each([
    'http://shop.example.com/',
    'https://127.0.0.1/',
    'https://169.254.169.254/',
    'https://[::1]/',
    'https://db.internal/',
    'https://intranet/',
  ])('rejects %s as policy-rejected without fetching', async (target) => {
    const { transport, seen } = transportFor(siteRoutes())
    const outcome = await probeStrict(target, policyFor(), { transport, resolver: resolverFor() })
    expect(outcome).toMatchObject({ ok: false, rejection: 'policy-rejected' })
    expect(seen).toHaveLength(0)
  })

  it('refuses an identity set whose agent and browser UAs differ (§3.3 parity)', async () => {
    const identities: ProbeIdentity[] = [
      { role: 'agent', userAgent: 'rebilder-ars/0.1', accept: 'text/markdown' },
      { role: 'browser', userAgent: 'Mozilla/5.0 (pretend)', accept: 'text/html' },
    ]
    const { transport, seen } = transportFor(siteRoutes())
    const outcome = await probeStrict(PAGE, policyFor({ identities }), {
      transport,
      resolver: resolverFor(),
    })
    expect(outcome).toMatchObject({ ok: false, rejection: 'policy-rejected' })
    if (!outcome.ok) expect(outcome.detail).toContain('SAME User-Agent')
    expect(seen).toHaveLength(0)
  })

  it("refuses to wear another operator's crawler name", async () => {
    const identities: ProbeIdentity[] = [
      {
        role: 'agent',
        userAgent: 'Googlebot/2.1 (+http://www.google.com/bot.html)',
        accept: 'text/markdown',
      },
      {
        role: 'browser',
        userAgent: 'Googlebot/2.1 (+http://www.google.com/bot.html)',
        accept: 'text/html',
      },
    ]
    const { transport, seen } = transportFor(siteRoutes())
    const outcome = await probeStrict(PAGE, policyFor({ identities }), {
      transport,
      resolver: resolverFor(),
    })
    expect(outcome).toMatchObject({ ok: false, rejection: 'policy-rejected' })
    if (!outcome.ok) expect(outcome.detail).toContain('never agent identity')
    expect(seen).toHaveLength(0)
  })

  it('ships an identity set that already satisfies its own rules', async () => {
    const { transport } = transportFor(siteRoutes())
    const outcome = await probeStrict(PAGE, policyFor({ identities: DEFAULT_IDENTITIES }), {
      transport,
      resolver: resolverFor(),
    })
    expect(outcome.ok).toBe(true)
  })

  it('maps an aborted request to a timeout, not to a mystery', async () => {
    const transport: ProbeTransport = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason))
      })
    const outcome = await probeStrict(PAGE, policyFor({ timeoutMs: 15 }), {
      transport,
      resolver: resolverFor(),
      sleep: () => Promise.resolve(),
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const robots = outcome.evidence.probes.robotsTxt
    expect(robots?.result.ok).toBe(false)
    if (robots && !robots.result.ok) expect(robots.result.error).toBe('timeout')
  })
})

/* ── the limiter ──────────────────────────────────────────────────────────── */

describe('politeness limiter', () => {
  it('is required by the policy and consulted for every request', async () => {
    const inner = testLimiter()
    const hosts: string[] = []
    const limiter: Limiter = {
      get used() {
        return inner.used
      },
      get budget() {
        return inner.budget
      },
      async acquire(host: string) {
        hosts.push(host)
        return inner.acquire(host)
      },
    }
    const { transport } = transportFor(siteRoutes())
    await probeStrict(PAGE, policyFor({ limiter }), { transport, resolver: resolverFor() })
    expect(hosts).toEqual(new Array<string>(5).fill('shop.example.com'))
  })

  it('turns an exhausted run budget into budget-exceeded, not into partial evidence', async () => {
    const { transport } = transportFor(siteRoutes())
    const outcome = await probeStrict(
      PAGE,
      policyFor({ limiter: testLimiter({ maxProbesPerRun: 3 }) }),
      {
        transport,
        resolver: resolverFor(),
      },
    )
    expect(outcome).toMatchObject({ ok: false, rejection: 'budget-exceeded' })
    if (!outcome.ok) expect(outcome.detail).toContain('maxProbesPerRun')
  })

  it('throws a typed error so a caller can tell "we declined" from "they were down"', async () => {
    const limiter = createLimiter({ maxProbesPerRun: 1, minIntervalPerHostMs: 0 })
    ;(await limiter.acquire('a.example')).release()
    await expect(limiter.acquire('a.example')).rejects.toBeInstanceOf(ProbeBudgetExceededError)
  })

  it('serialises requests to one host and never lets two through at once', async () => {
    const limiter = createLimiter({ minIntervalPerHostMs: 0, maxProbesPerRun: 10 })
    let inFlight = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        const lease = await limiter.acquire('a.example')
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await Promise.resolve()
        inFlight -= 1
        lease.release()
      }),
    )
    expect(peak).toBe(1)
  })

  it('holds at most two concurrent probes globally, even across different hosts', async () => {
    const limiter = createLimiter({ minIntervalPerHostMs: 0, maxProbesPerRun: 20 })
    const first = await limiter.acquire('a.example')
    const second = await limiter.acquire('b.example')

    let thirdAcquired = false
    const third = limiter.acquire('c.example').then((lease) => {
      thirdAcquired = true
      return lease
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(thirdAcquired).toBe(false)

    first.release()
    const lease = await third
    expect(thirdAcquired).toBe(true)
    lease.release()
    second.release()
  })

  it('waits at least a second between probes to the same host', async () => {
    let clock = 0
    const slept: number[] = []
    const limiter = createLimiter({
      now: () => clock,
      sleep: (ms) => {
        slept.push(ms)
        clock += ms
        return Promise.resolve()
      },
    })
    ;(await limiter.acquire('a.example')).release()
    ;(await limiter.acquire('a.example')).release()
    expect(slept).toEqual([1_000])
  })

  it('does not make one host wait for another host', async () => {
    let clock = 0
    const slept: number[] = []
    const limiter = createLimiter({
      now: () => clock,
      sleep: (ms) => {
        slept.push(ms)
        clock += ms
        return Promise.resolve()
      },
    })
    ;(await limiter.acquire('a.example')).release()
    ;(await limiter.acquire('b.example')).release()
    expect(slept).toEqual([])
  })

  it('counts a run budget, not a lifetime one — a fresh limiter starts clean', async () => {
    const first = createLimiter({ maxProbesPerRun: 2, minIntervalPerHostMs: 0 })
    ;(await first.acquire('a.example')).release()
    ;(await first.acquire('a.example')).release()
    expect(first.used).toBe(2)
    await expect(first.acquire('a.example')).rejects.toBeInstanceOf(ProbeBudgetExceededError)

    const second = createLimiter({ maxProbesPerRun: 2, minIntervalPerHostMs: 0 })
    expect(second.used).toBe(0)
    await expect(second.acquire('a.example')).resolves.toBeDefined()
  })

  it('defaults to the §5.2 numbers', () => {
    expect(createLimiter().budget).toBe(20)
  })
})

/* ── the local entry point ────────────────────────────────────────────────── */

describe('"./probe/local" — opt-in per invocation, never a config default', () => {
  const MARKERS = [
    'VERCEL',
    'NEXT_RUNTIME',
    'AWS_LAMBDA_FUNCTION_NAME',
    'AWS_EXECUTION_ENV',
    'FUNCTIONS_WORKER_RUNTIME',
    'K_SERVICE',
    'CF_PAGES',
  ]

  async function withArgv<T>(extra: string[], run: () => Promise<T>): Promise<T> {
    const argv = process.argv
    const saved = new Map<string, string | undefined>()
    for (const key of MARKERS) {
      saved.set(key, process.env[key])
      delete process.env[key]
    }
    process.argv = [...argv, ...extra]
    try {
      return await run()
    } finally {
      process.argv = argv
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  it('THROWS at import time without --allow-private', async () => {
    vi.resetModules()
    await withArgv([], async () => {
      await expect(import('../src/probe/local')).rejects.toThrow(/--allow-private/)
    })
  })

  it('THROWS at import time inside a hosted runtime even WITH the flag', async () => {
    vi.resetModules()
    await withArgv(['--allow-private'], async () => {
      process.env.VERCEL = '1'
      await expect(import('../src/probe/local')).rejects.toThrow(/hosted runtime/)
    })
  })

  it('loads with the flag and reaches a loopback target the strict probe refuses', async () => {
    const local = 'http://127.0.0.1:8123/status'
    const { transport, seen } = transportFor({
      'http://127.0.0.1:8123/robots.txt': () => text('nope', 404),
      [local]: () => html('<html><title>Staging</title></html>'),
      'http://127.0.0.1:8123/llms.txt': () => text('nope', 404),
      'http://127.0.0.1:8123/.well-known/ucp': () => text('nope', 404),
    })

    // The strict probe refuses the same target outright.
    const strict = await probeStrict(local, policyFor(), { transport, resolver: resolverFor() })
    expect(strict).toMatchObject({ ok: false, rejection: 'policy-rejected' })
    expect(seen).toHaveLength(0)

    vi.resetModules()
    await withArgv(['--allow-private'], async () => {
      const module = await import('../src/probe/local')
      const outcome = await module.probeLocal(local, module.localPolicy(testLimiter()), {
        transport,
        resolver: resolverFor(),
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.evidence.vantage).toBe('self')
      expect(seen.map((entry) => entry.url)).toContain(local)
    })
  })

  it('is not reachable from "./probe": the capability symbol is not re-exported', async () => {
    const probeModule: Record<string, unknown> = await import('../src/probe/index')
    for (const key of Object.keys(probeModule)) {
      expect(key).not.toMatch(/ALLOW_PRIVATE/)
    }
    expect(probeModule['probeLocal']).toBeUndefined()
  })
})
