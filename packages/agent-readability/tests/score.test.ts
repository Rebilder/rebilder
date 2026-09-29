/**
 * score.test.ts — the ARS property tests, plus the scoring behaviour that the
 * conformance corpus cannot express as a single fixture.
 *
 * WHERE THE §3.10 PROPERTY IDS LIVE. Numbers `050`–`059` are named in the design
 * as "property tests over the whole corpus". Two of them need an evidence bundle
 * to be about anything and are therefore corpus DIRECTORIES —
 * `050-byte-identical-replay` and `051-multi-value-headers`. The other eight are
 * properties of the ruleset, the profiles, the parsers or the build, so they live
 * here as `describe('05N …')` blocks. Every id appears in exactly one of the two
 * places, and `conformance.test.ts` runs the directories.
 *
 * The behavioural half of this file exists because a fixture pins ONE outcome,
 * and several ARS rules are about the DIFFERENCE between two outcomes: the third
 * confirming probe changing whether a divergence is flagged, `vantage: 'self'`
 * changing whether the scanner token is honoured, a heuristic check failing
 * WITHOUT taking its dimension's measured points with it. Those are written as
 * pairs and triples here, where the shared setup makes the one varying input
 * obvious.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { classify } from '../src/classify'
import { tokenizeHtml } from '../src/html'
import { parseMoneyText } from '../src/parse-money'
import { PROFILE_BY_KIND, PROFILES, profileFor } from '../src/profiles'
import { recommend } from '../src/recommend'
import {
  ARS_HEURISTIC_WEIGHT,
  ARS_HEURISTIC_WEIGHT_CEILING,
  ARS_MEASURED_WEIGHT,
  CHECK_META,
  DEFAULT_RULESET,
  DIMENSION_META,
} from '../src/ruleset'
import {
  SUBPOINTS,
  bandFor,
  subpointTotals,
  canonicalJson,
  evidenceHash,
  parseLinkHeaders,
  rulesetHash,
  score,
  sha256Hex,
} from '../src/score'
import { ARS_SPEC_VERSION } from '../src/types'
import type {
  ArsCheckId,
  ArsDimensionId,
  ArsEvidence,
  ArsFactKind,
  ArsHttpCapture,
  ArsPageKind,
  ArsProbeRecord,
  ArsResult,
} from '../src/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '..', 'src')
const CORPUS = resolve(HERE, '..', 'conformance')

const CHECK_IDS = Object.keys(CHECK_META) as ArsCheckId[]
const DIMENSION_IDS = Object.keys(DIMENSION_META) as ArsDimensionId[]

// ---------------------------------------------------------------------------
// Synthetic evidence
// ---------------------------------------------------------------------------

const UA = 'rebilder-ars/0.1 (+https://rebilder.com/bots)'
const AGENT_ACCEPT = 'text/markdown;q=1.0, text/html;q=0.8, text/plain;q=0.5, */*;q=0.1'
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
const ORIGIN = 'https://synthetic.example'
const URL_UNDER_TEST = `${ORIGIN}/products/thing`

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length
}

function capture(
  url: string,
  body: string,
  headers: Record<string, string[]>,
  status = 200,
): ArsHttpCapture {
  return {
    requestedUrl: url,
    finalUrl: url,
    redirects: [],
    status,
    headers,
    bytes: bytesOf(body),
    bodySha256: sha256Hex(body),
    body,
    truncated: false,
  }
}

function ok(accept: string, value: ArsHttpCapture): ArsProbeRecord {
  return { requestHeaders: { accept, 'user-agent': UA }, result: { ok: true, capture: value } }
}

const MARKDOWN_HEADERS = {
  'content-type': ['text/markdown; charset=utf-8'],
  vary: ['Accept'],
  link: [`<${URL_UNDER_TEST}.md>; rel="alternate"; type="text/markdown"`],
  'cache-control': ['public, max-age=300'],
  etag: ['"abc"'],
}
const HTML_HEADERS = {
  'content-type': ['text/html; charset=utf-8'],
  'cache-control': ['public, max-age=300'],
}

const OPEN_ROBOTS = `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`

function html(price: string, visible: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Thing — Synthetic Store</title>
<link rel="canonical" href="${URL_UNDER_TEST}">
<meta name="description" content="A thing, for testing.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Thing","sku":"SYN-1","brand":{"@type":"Brand","name":"Synthetic"},"description":"A thing, for testing.","offers":{"@type":"Offer","price":"${price}","priceCurrency":"USD","availability":"https://schema.org/InStock"}}</script>
</head><body><main>
<h1>Thing</h1>
<p class="price">${visible}</p>
<p>In stock. Free shipping over $50. 30-day returns.</p>
<a href="/cart/add">Add to cart</a>
</main></body></html>
`
}

function markdown(price: string): string {
  return `# [Thing](${URL_UNDER_TEST})

- **Brand:** Synthetic
- **Price:** ${price}
- **Availability:** In stock
- **Shipping:** Free shipping over $50
- **Returns:** 30-day returns

## Description

A thing, for testing.
`
}

interface BundleParts {
  agent?: ArsProbeRecord | null
  browser?: ArsProbeRecord | null
  parityConfirm?: ArsProbeRecord | null
  robots?: string | null
  robotsStatus?: number
  vantage?: ArsEvidence['vantage']
  url?: string
}

function bundle(parts: BundleParts = {}): ArsEvidence {
  const url = parts.url ?? URL_UNDER_TEST
  const robotsBody = parts.robots === undefined ? OPEN_ROBOTS : parts.robots
  return {
    evidenceVersion: '0.1.0',
    target: { url, origin: ORIGIN },
    probes: {
      agent:
        parts.agent === undefined
          ? ok(AGENT_ACCEPT, capture(url, html('148.00', '$148.00'), HTML_HEADERS))
          : (parts.agent ?? { requestHeaders: {}, result: { ok: false, error: 'unreachable' } }),
      browser:
        parts.browser === undefined
          ? ok(BROWSER_ACCEPT, capture(url, html('148.00', '$148.00'), HTML_HEADERS))
          : (parts.browser ?? { requestHeaders: {}, result: { ok: false, error: 'unreachable' } }),
      parityConfirm: parts.parityConfirm ?? null,
      robotsTxt:
        robotsBody === null
          ? null
          : ok(
              'text/plain',
              capture(
                `${ORIGIN}/robots.txt`,
                robotsBody,
                { 'content-type': ['text/plain'] },
                parts.robotsStatus ?? 200,
              ),
            ),
      llmsTxt: null,
      wellKnownUcp: null,
    },
    vantage: parts.vantage ?? 'public',
    capturedAt: '2026-08-05T09:15:00.000Z',
  }
}

const gatewayBundle = (
  agentPrice = '$148.00',
  htmlPrice = '148.00',
  htmlVisible = '$148.00',
): ArsEvidence =>
  bundle({
    agent: ok(AGENT_ACCEPT, capture(URL_UNDER_TEST, markdown(agentPrice), MARKDOWN_HEADERS)),
    browser: ok(
      BROWSER_ACCEPT,
      capture(URL_UNDER_TEST, html(htmlPrice, htmlVisible), HTML_HEADERS),
    ),
  })

function checkOf(result: ArsResult, id: ArsCheckId): number {
  for (const dimension of result.dimensions) {
    for (const check of dimension.checks) if (check.id === id) return check.earned
  }
  throw new Error(`no check ${id} in result`)
}

function flagIds(result: ArsResult): string[] {
  return result.flags.map((flag) => flag.id)
}

/** Every fixture in the corpus, scored once. Several properties are asserted over all of them. */
function corpusResults(): { name: string; result: ArsResult }[] {
  return readdirSync(CORPUS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      result: score(
        JSON.parse(readFileSync(join(CORPUS, name, 'evidence.json'), 'utf8')) as ArsEvidence,
      ),
    }))
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

describe('hashes', () => {
  it('computes SHA-256 to the published vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
    // Non-ASCII: the digest is over UTF-8 BYTES, not UTF-16 code units. `€` is
    // three bytes, and a implementation that hashed code units would not match
    // `sha256sum` on the same file.
    expect(sha256Hex('€')).toBe('c4cc90ed3d26f12d4b08a75140970a7904035c31cbb4515a83f19b9003c00d1d')
    // Multi-block, and a length that crosses the 55/56-byte padding boundary.
    expect(sha256Hex('a'.repeat(55))).toHaveLength(64)
    expect(sha256Hex('a'.repeat(56))).toHaveLength(64)
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    )
  })

  it('canonicalises JSON by RFC 8785 key order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ 'a-b': 1, aa: 2, A: 3 })).toBe('{"A":3,"a-b":1,"aa":2}')
    expect(canonicalJson([1, 'two', true, null])).toBe('[1,"two",true,null]')
    expect(canonicalJson({ n: 1.5, big: 1e21 })).toBe('{"big":1e+21,"n":1.5}')
    expect(canonicalJson({ dropped: undefined, kept: 1 })).toBe('{"kept":1}')
  })

  it('gives the frozen ruleset a stable hash', () => {
    expect(rulesetHash(DEFAULT_RULESET)).toBe(rulesetHash(DEFAULT_RULESET))
    expect(rulesetHash(DEFAULT_RULESET)).toHaveLength(64)
    expect(rulesetHash({ ...DEFAULT_RULESET, version: '0.1.1' })).not.toBe(
      rulesetHash(DEFAULT_RULESET),
    )
  })

  it('excludes the volatile headers from evidenceHash, and nothing else (fixture 050)', () => {
    const evidence = JSON.parse(
      readFileSync(join(CORPUS, '050-byte-identical-replay', 'evidence.json'), 'utf8'),
    ) as ArsEvidence
    const base = evidenceHash(evidence)
    const agent = evidence.probes.agent
    if (!agent.result.ok) throw new Error('fixture 050 must carry a successful agent probe')
    const headers = agent.result.capture.headers

    for (const name of ['date', 'age', 'set-cookie', 'x-request-id', 'cf-ray', 'report-to']) {
      const original = headers[name]
      expect(original, `fixture 050 must carry a ${name} header`).toBeDefined()
      headers[name] = ['a value that changes on every single scan']
      expect(evidenceHash(evidence), `${name} must not reach the hash`).toBe(base)
      if (original !== undefined) headers[name] = original
    }

    // capturedAt is wall-clock time and is excluded for the same reason.
    const capturedAt = evidence.capturedAt
    evidence.capturedAt = '1999-12-31T23:59:59.000Z'
    expect(evidenceHash(evidence)).toBe(base)
    evidence.capturedAt = capturedAt

    // A header that IS scored moves the hash. Otherwise the exclusion list would
    // be indistinguishable from ignoring headers altogether.
    headers['cache-control'] = ['no-store']
    expect(evidenceHash(evidence)).not.toBe(base)
  })
})

// ---------------------------------------------------------------------------
// Link headers
// ---------------------------------------------------------------------------

describe('Link header parsing', () => {
  it('splits on commas outside <> and quotes', () => {
    const links = parseLinkHeaders([
      '<https://x.example/a.md>; rel="alternate"; type="text/markdown"; title="Markdown, machine-readable", <https://x.example/>; rel="canonical"',
    ])
    expect(links).toHaveLength(2)
    expect(links[0]?.url).toBe('https://x.example/a.md')
    expect(links[0]?.rel).toEqual(['alternate'])
    expect(links[0]?.type).toBe('text/markdown')
    expect(links[1]?.rel).toEqual(['canonical'])
  })

  it('keeps a comma inside the target IRI', () => {
    const links = parseLinkHeaders([
      '<https://x.example/a,b>; rel="alternate"; type="text/markdown"',
    ])
    expect(links).toHaveLength(1)
    expect(links[0]?.url).toBe('https://x.example/a,b')
  })

  it('reads rel as a token list', () => {
    expect(parseLinkHeaders(['<https://x.example/>; rel="alternate canonical"'])[0]?.rel).toEqual([
      'alternate',
      'canonical',
    ])
  })
})

// ---------------------------------------------------------------------------
// Designed ceilings (§3.4)
// ---------------------------------------------------------------------------

describe('the designed ceilings are provable from the ruleset', () => {
  const weight = (id: ArsCheckId): number => DEFAULT_RULESET.weights[id] ?? 0

  it('no content negotiation cannot reach an A', () => {
    // The ceiling that has to survive every rebalance: a page that hands an
    // agent nothing but HTML is not agent-native, whatever else it does right.
    const lost =
      weight('machine-representation.negotiated-response') +
      weight('machine-representation.vary-accept') +
      weight('machine-representation.substance-parity')
    expect(bandFor(100 - lost)?.grade).not.toBe('A')
  })

  it('no structured data CAN still reach an A (ARS 0.2)', () => {
    // A deliberate change, and the clearest single consequence of the 0.2
    // rebalance. Under 0.1 missing JSON-LD cost 15 points and capped a page at
    // B. The best available evidence is a matched difference-in-differences
    // over 1,885 pages where adding JSON-LD moved AI Overview citations DOWN
    // 4.6%, alongside a live test in which none of five assistants parsed it.
    // Barring a page from the top band over markup no assistant reads was the
    // score asserting something it could not support.
    //
    // It still costs points: structured data earns its keep for rich results
    // and for the merchant feeds Google does name as feeding AI answers. It
    // just no longer decides the grade.
    const lost =
      weight('structured-data.present') +
      weight('structured-data.required-properties') +
      weight('structured-data.text-agreement')
    expect(lost).toBeLessThan(10)
    expect(bandFor(100 - lost)?.grade).toBe('A')
  })

  it('an unreadable page still cannot reach an A on evidence density alone', () => {
    // The inverse guard for the new dimension: D7 is 8 points and must never be
    // large enough to rescue a page that fails retrieval.
    const d7 = DIMENSION_META['evidence-density'].weight
    const retrieval = DIMENSION_META.retrievability.weight
    expect(d7).toBeLessThan(retrieval)
    expect(bandFor(100 - retrieval)?.grade).not.toBe('A')
  })

  it('so an A requires both', () => {
    // 100 minus either block is below the A floor, which is the whole claim.
    expect(84).toBeLessThan(DEFAULT_RULESET.bands[0]?.min ?? 90)
    expect(85).toBeLessThan(DEFAULT_RULESET.bands[0]?.min ?? 90)
  })

  it('and a page with neither loses both blocks, measured on real evidence', () => {
    const result = score(
      bundle({
        agent: ok(
          AGENT_ACCEPT,
          capture(
            URL_UNDER_TEST,
            '<!doctype html><html><head><title>Bare</title></head><body><h1>Bare</h1></body></html>',
            HTML_HEADERS,
          ),
        ),
        browser: null,
      }),
    )
    expect(checkOf(result, 'machine-representation.negotiated-response')).toBe(0)
    expect(checkOf(result, 'machine-representation.vary-accept')).toBe(0)
    expect(checkOf(result, 'machine-representation.substance-parity')).toBe(0)
    expect(result.score).toBeLessThanOrEqual(84)
  })
})

// ---------------------------------------------------------------------------
// D2.4 and D5.3 are scored checks, not gates
// ---------------------------------------------------------------------------

describe('D2.4 substance parity is a scored check, not a gate', () => {
  const diverging = (parityConfirm: ArsProbeRecord | null): ArsEvidence => ({
    ...gatewayBundle('$99.00'),
    probes: { ...gatewayBundle('$99.00').probes, parityConfirm },
  })

  it('a divergence costs only its own points and leaves D2 measured points alone', () => {
    const result = score(
      diverging(ok(AGENT_ACCEPT, capture(URL_UNDER_TEST, markdown('$99.00'), MARKDOWN_HEADERS))),
    )
    expect(checkOf(result, 'machine-representation.substance-parity')).toBe(0)
    expect(checkOf(result, 'machine-representation.negotiated-response')).toBe(DEFAULT_RULESET.weights['machine-representation.negotiated-response'])
    expect(checkOf(result, 'machine-representation.declared-alternates')).toBe(DEFAULT_RULESET.weights['machine-representation.declared-alternates'])
    expect(checkOf(result, 'machine-representation.vary-accept')).toBe(DEFAULT_RULESET.weights['machine-representation.vary-accept'])
    const d2 = result.dimensions.find((dimension) => dimension.id === 'machine-representation')
    // Everything in D2 except parity's own points: a scored check, not a gate.
    expect(d2?.earned).toBe(
      DIMENSION_META['machine-representation'].weight -
        DEFAULT_RULESET.weights['machine-representation.substance-parity'],
    )
    expect(flagIds(result)).toContain('substance-divergence')
  })

  it('is not flagged without a third confirming probe, and still costs the points', () => {
    const result = score(diverging(null))
    expect(checkOf(result, 'machine-representation.substance-parity')).toBe(0)
    expect(flagIds(result)).not.toContain('substance-divergence')
  })

  it('is restored when the confirming probe agrees — a value that changed, not a divergence', () => {
    const result = score(
      diverging(ok(AGENT_ACCEPT, capture(URL_UNDER_TEST, markdown('$148.00'), MARKDOWN_HEADERS))),
    )
    expect(checkOf(result, 'machine-representation.substance-parity')).toBe(3)
    expect(flagIds(result)).not.toContain('substance-divergence')
  })

  it('agrees when both representations state the same price', () => {
    const result = score(gatewayBundle())
    expect(checkOf(result, 'machine-representation.substance-parity')).toBe(3)
    expect(flagIds(result)).not.toContain('substance-divergence')
  })
})

describe('D5.3 structured-data agreement is a scored check, not a gate', () => {
  it('a mismatch costs only its own points and leaves D5.1 and D5.2 alone', () => {
    const result = score(gatewayBundle('$148.00', '99.00', '$148.00'))
    expect(checkOf(result, 'structured-data.text-agreement')).toBe(0)
    expect(checkOf(result, 'structured-data.present')).toBe(DEFAULT_RULESET.weights['structured-data.present'])
    expect(checkOf(result, 'structured-data.required-properties')).toBe(DEFAULT_RULESET.weights['structured-data.required-properties'])
    expect(flagIds(result)).toContain('structured-data-divergence')
  })
})

// ---------------------------------------------------------------------------
// The remaining flags
// ---------------------------------------------------------------------------

describe('flags report an observation, and each one costs only its own check', () => {
  it('negotiation without Vary: Accept is a cache hazard, and says so', () => {
    const headers = { ...MARKDOWN_HEADERS }
    delete (headers as Record<string, string[] | undefined>)['vary']
    const result = score(
      bundle({
        agent: ok(AGENT_ACCEPT, capture(URL_UNDER_TEST, markdown('$148.00'), headers)),
        browser: ok(
          BROWSER_ACCEPT,
          capture(URL_UNDER_TEST, html('148.00', '$148.00'), HTML_HEADERS),
        ),
      }),
    )
    expect(checkOf(result, 'machine-representation.vary-accept')).toBe(0)
    expect(checkOf(result, 'machine-representation.negotiated-response')).toBe(DEFAULT_RULESET.weights['machine-representation.negotiated-response'])
    expect(flagIds(result)).toContain('vary-missing')
  })

  it('two representations declaring different canonicals is a mismatch', () => {
    const headers = { ...MARKDOWN_HEADERS, link: [`<${ORIGIN}/products/other>; rel="canonical"`] }
    const result = score(
      bundle({
        agent: ok(AGENT_ACCEPT, capture(URL_UNDER_TEST, markdown('$148.00'), headers)),
        browser: ok(
          BROWSER_ACCEPT,
          capture(URL_UNDER_TEST, html('148.00', '$148.00'), HTML_HEADERS),
        ),
      }),
    )
    expect(flagIds(result)).toContain('canonical-mismatch')
    expect(checkOf(result, 'contract-discovery.canonical')).toBe(3)
  })

  it('an empty SPA root is render-dependent, and a <noscript> fallback earns credit', () => {
    const both = (body: string): ArsEvidence =>
      bundle({
        agent: ok(AGENT_ACCEPT, capture(URL_UNDER_TEST, body, HTML_HEADERS)),
        browser: ok(BROWSER_ACCEPT, capture(URL_UNDER_TEST, body, HTML_HEADERS)),
      })
    const empty =
      '<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>'
    const titleOnly =
      '<!doctype html><html><head><title>Shop</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>'
    const prose = titleOnly.replace(
      '<div id="root"></div>',
      '<div id="root"></div><noscript>This store needs JavaScript.</noscript>',
    )
    const facts = titleOnly.replace(
      '<div id="root"></div>',
      '<noscript><h1>Thing</h1><p>$148.00. In stock.</p></noscript>',
    )

    // Nothing at all: no title, no fallback.
    expect(checkOf(score(both(empty)), 'retrievability.render-independence')).toBe(0)
    // A <title> is one of four core facts for a product, so 25% earns 1.
    expect(checkOf(score(both(titleOnly)), 'retrievability.render-independence')).toBe(1)
    expect(flagIds(score(both(titleOnly)))).toContain('render-dependent')
    // A <noscript> carrying no core fact still earns the pinned floor of 1.
    expect(checkOf(score(both(prose)), 'retrievability.render-independence')).toBe(
      SUBPOINTS.renderIndependence.noscriptFloor,
    )
    // A <noscript> carrying the facts earns them outright: §3.6's counted-text
    // rule excludes script, style, template and hidden elements — not noscript —
    // so its contents are ordinary visible text and score like any other.
    expect(checkOf(score(both(facts)), 'retrievability.render-independence')).toBe(DEFAULT_RULESET.weights['retrievability.render-independence'])
  })

  it('a declared paywall is reported, not penalised as a missing page', () => {
    const paywalled = html('148.00', '$148.00').replace(
      '"@type":"Product"',
      '"@type":"Product","isAccessibleForFree":false',
    )
    const result = score(
      bundle({
        agent: ok(AGENT_ACCEPT, capture(URL_UNDER_TEST, paywalled, HTML_HEADERS)),
        browser: ok(BROWSER_ACCEPT, capture(URL_UNDER_TEST, paywalled, HTML_HEADERS)),
      }),
    )
    expect(flagIds(result)).toContain('paywalled')
    expect(result.flags.find((flag) => flag.id === 'paywalled')?.severity).toBe('info')
    expect(result.outcome.kind).toBe('scored')
  })

  it('never emits vantage-variance in 0.1 — the field exists, enforcement is 0.2', () => {
    for (const { result } of corpusResults())
      expect(flagIds(result)).not.toContain('vantage-variance')
  })
})

// ---------------------------------------------------------------------------
// Non-grades (§3.6, §3.7)
// ---------------------------------------------------------------------------

describe('non-grades carry no letter', () => {
  const assertNonGrade = (result: ArsResult): void => {
    expect(result.score).toBeNull()
    expect(result.grade).toBeNull()
    expect(result.bandLabel).toBeNull()
    expect(result.recommendations).toEqual([])
    // The shape is invariant even when nothing was scored: 6 dimensions, 100 points.
    expect(result.dimensions).toHaveLength(Object.keys(DIMENSION_META).length)
    expect(result.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0)).toBe(100)
    expect(result.dimensions.reduce((sum, dimension) => sum + dimension.earned, 0)).toBe(0)
  }

  it('a deliberate, well-formed assistant opt-out is not an F', () => {
    const result = score(
      bundle({ robots: 'User-agent: ChatGPT-User\nDisallow: /\n\nUser-agent: *\nAllow: /\n' }),
    )
    expect(result.outcome).toEqual({ kind: 'opt-out', audience: 'assistant', wellFormed: true })
    assertNonGrade(result)
    expect(flagIds(result)).toContain('assistant-opt-out')
  })

  it('a blanket disallow is scored with a contradiction warning, not treated as consent', () => {
    const result = score(bundle({ robots: 'User-agent: *\nDisallow: /\n' }))
    expect(result.outcome.kind).toBe('scored')
    expect(checkOf(result, 'retrievability.robots-policy')).toBe(0)
    expect(flagIds(result)).toContain('robots-contradiction')
  })

  it('a robots.txt that disallows our own scanner is obeyed, not scored', () => {
    const robots = 'User-agent: rebilder-ars\nDisallow: /\n\nUser-agent: *\nAllow: /\n'
    const result = score(bundle({ robots }))
    expect(result.outcome).toEqual({ kind: 'unscored', reason: 'robots-disallow-scanner' })
    assertNonGrade(result)
  })

  it('but vantage: self bypasses the scanner token — the owner consents for their own origin', () => {
    const robots = 'User-agent: rebilder-ars\nDisallow: /\n\nUser-agent: *\nAllow: /\n'
    const result = score(bundle({ robots, vantage: 'self' }))
    expect(result.outcome.kind).toBe('scored')
    expect(result.score).toBeGreaterThan(0)
  })

  it('a persistent robots.txt 5xx is unscored, not scored as open', () => {
    const result = score(bundle({ robots: 'nope', robotsStatus: 503 }))
    expect(result.outcome).toEqual({ kind: 'unscored', reason: 'robots-unavailable' })
    assertNonGrade(result)
  })

  it('a 403 at the edge is UNSCORED — blocked, never a low grade', () => {
    const result = score(
      bundle({ agent: ok(AGENT_ACCEPT, capture(URL_UNDER_TEST, 'Forbidden', HTML_HEADERS, 403)) }),
    )
    expect(result.outcome).toEqual({
      kind: 'unscored',
      reason: 'blocked-at-edge',
      detail: 'HTTP 403',
    })
    assertNonGrade(result)
    expect(flagIds(result)).toContain('scanner-blocked')
  })

  it('a timeout is unreachable', () => {
    const result = score(
      bundle({
        agent: {
          requestHeaders: { accept: AGENT_ACCEPT },
          result: { ok: false, error: 'timeout' },
        },
      }),
    )
    expect(result.outcome).toEqual({ kind: 'unscored', reason: 'unreachable', detail: 'timeout' })
    assertNonGrade(result)
  })

  it('a 404 is non-2xx', () => {
    const result = score(
      bundle({ agent: ok(AGENT_ACCEPT, capture(URL_UNDER_TEST, 'Not found', HTML_HEADERS, 404)) }),
    )
    expect(result.outcome.kind).toBe('unscored')
    expect(result.outcome).toMatchObject({ reason: 'non-2xx' })
  })

  it('a truncated body is unscored, because both the facts and the byte count would be wrong', () => {
    const truncated = capture(URL_UNDER_TEST, html('148.00', '$148.00'), HTML_HEADERS)
    const result = score(bundle({ agent: ok(AGENT_ACCEPT, { ...truncated, truncated: true }) }))
    expect(result.outcome).toEqual({ kind: 'unscored', reason: 'truncated-evidence' })
    assertNonGrade(result)
    expect(flagIds(result)).toContain('body-truncated')
    expect(result.cost.truncated).toBe(true)
  })

  it('a published bundle with hashes but no body is evidence-incomplete, not a zero', () => {
    const withoutBody = capture(URL_UNDER_TEST, html('148.00', '$148.00'), HTML_HEADERS)
    delete withoutBody.body
    const result = score(bundle({ agent: ok(AGENT_ACCEPT, withoutBody), browser: null }))
    expect(result.outcome.kind).toBe('unscored')
    expect(result.outcome).toMatchObject({ reason: 'evidence-incomplete' })
  })
})

describe('the training audience is strictly neutral', () => {
  it('blocking training crawlers scores identically to a fully open site', () => {
    const open = score(bundle({ robots: OPEN_ROBOTS }))
    const trainingBlocked = score(
      bundle({
        robots: `User-agent: GPTBot\nDisallow: /\n\nUser-agent: Google-Extended\nDisallow: /\n\nUser-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`,
      }),
    )
    expect(trainingBlocked.score).toBe(open.score)
    expect(trainingBlocked.policy.trainingOptOut).toBe(true)
    expect(flagIds(trainingBlocked)).toContain('training-opt-out')
  })
})

// ---------------------------------------------------------------------------
// Recommendation arithmetic (§3.9)
// ---------------------------------------------------------------------------

describe('recommendation arithmetic', () => {
  it('Σ pointsAvailable ≤ 100 − score, on every corpus fixture', () => {
    for (const { name, result } of corpusResults()) {
      if (result.score === null) continue
      const total = result.recommendations.reduce((sum, entry) => sum + entry.pointsAvailable, 0)
      expect(
        total,
        `${name}: recommendations promise more than the page can gain`,
      ).toBeLessThanOrEqual(100 - result.score)
    }
  })

  it('never counts a check twice', () => {
    for (const { name, result } of corpusResults()) {
      const seen = new Set<string>()
      for (const entry of result.recommendations) {
        for (const id of [...entry.checks, ...entry.unlocks]) {
          expect(seen.has(id), `${name}: ${id} claimed twice`).toBe(false)
          seen.add(id)
        }
      }
    }
  })

  it('never promises a dimension more than it has left', () => {
    // Attribution is per CHECK, not per recommendation: a recommendation can span
    // dimensions, so crediting its whole `pointsAvailable` to each dimension it
    // touches would make the assertion vacuous. The gap of every claimed check is
    // summed into its own dimension and compared against what that dimension has
    // left to earn.
    for (const { name, result } of corpusResults()) {
      const gaps = new Map<string, { dimension: string; gap: number }>()
      for (const dimension of result.dimensions) {
        for (const check of dimension.checks) {
          gaps.set(check.id, { dimension: dimension.id, gap: check.weight - check.earned })
        }
      }
      const promised = new Map<string, number>()
      for (const entry of result.recommendations) {
        for (const id of [...entry.checks, ...entry.unlocks]) {
          const gap = gaps.get(id)
          if (gap === undefined) continue
          promised.set(gap.dimension, (promised.get(gap.dimension) ?? 0) + gap.gap)
        }
      }
      for (const dimension of result.dimensions) {
        expect(promised.get(dimension.id) ?? 0, `${name}/${dimension.id}`).toBeLessThanOrEqual(
          dimension.weight - dimension.earned,
        )
      }
    }
  })

  it('returns nothing for a non-grade', () => {
    expect(recommend({ dimensions: [], score: null })).toEqual([])
  })

  it('attributes the gated checks to the recommendation that opens the gate', () => {
    const result = score(bundle())
    const opener = result.recommendations.find(
      (entry) => entry.id === 'serve-machine-representation',
    )
    expect(opener?.unlocks).toEqual([
      'machine-representation.vary-accept',
      'machine-representation.substance-parity',
    ])
    expect(opener?.pointsAvailable).toBe(
      DEFAULT_RULESET.weights['machine-representation.negotiated-response'] +
        DEFAULT_RULESET.weights['machine-representation.vary-accept'] +
        DEFAULT_RULESET.weights['machine-representation.substance-parity'],
    )
    expect(result.recommendations.some((entry) => entry.id === 'declare-vary-accept')).toBe(false)
  })

  it('a page at 100 has nothing to recommend', () => {
    const dimensions = DIMENSION_IDS.map((id) => ({
      id,
      label: DIMENSION_META[id].label,
      weight: DIMENSION_META[id].weight,
      earned: DIMENSION_META[id].weight,
      basis: 'measured' as const,
      checks: CHECK_IDS.filter((checkId) => CHECK_META[checkId].dimension === id).map(
        (checkId) => ({
          id: checkId,
          label: CHECK_META[checkId].label,
          basis: CHECK_META[checkId].basis,
          weight: DEFAULT_RULESET.weights[checkId] ?? 0,
          earned: DEFAULT_RULESET.weights[checkId] ?? 0,
          evidence: [],
        }),
      ),
    }))
    expect(recommend({ dimensions, score: 100 })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 052 — weights sum to 100, and earned never exceeds weight
// ---------------------------------------------------------------------------

describe('052 weights sum to 100 and earned ≤ weight', () => {
  it('the 19 check weights sum to exactly 100', () => {
    const total = CHECK_IDS.reduce((sum, id) => sum + (DEFAULT_RULESET.weights[id] ?? 0), 0)
    expect(CHECK_IDS).toHaveLength(Object.keys(DEFAULT_RULESET.weights).length)
    expect(total).toBe(100)
  })

  it('every dimension weight is the sum of its own checks, and the six sum to 100', () => {
    let total = 0
    for (const id of DIMENSION_IDS) {
      const own = CHECK_IDS.filter((checkId) => CHECK_META[checkId].dimension === id).reduce(
        (sum, checkId) => sum + (DEFAULT_RULESET.weights[checkId] ?? 0),
        0,
      )
      expect(own, `${id} weight disagrees with its checks`).toBe(DIMENSION_META[id].weight)
      total += DIMENSION_META[id].weight
    }
    expect(total).toBe(100)
  })

  it('every sub-point split sums to its check weight', () => {
    const splits: [ArsCheckId, number][] = [
      ['retrievability.reachable', Object.values(SUBPOINTS.reachable).reduce((a, b) => a + b, 0)],
      [
        'retrievability.robots-policy',
        Object.values(SUBPOINTS.robotsPolicy).reduce((a, b) => a + b, 0),
      ],
      [
        'contract-discovery.canonical',
        Object.values(SUBPOINTS.canonical).reduce((a, b) => a + b, 0),
      ],
      [
        'contract-discovery.cache-validators',
        Object.values(SUBPOINTS.cacheValidators).reduce((a, b) => a + b, 0),
      ],
      [
        'structured-data.required-properties',
        SUBPOINTS.requiredProperties.recognisedType + SUBPOINTS.requiredProperties.completeness,
      ],
    ]
    for (const [id, sum] of splits) expect(sum, id).toBe(DEFAULT_RULESET.weights[id] ?? 0)
    // The all-or-nothing checks: the "full" value IS the weight.
    expect(SUBPOINTS.negotiatedResponse.full).toBe(
      DEFAULT_RULESET.weights['machine-representation.negotiated-response'],
    )
    expect(SUBPOINTS.declaredAlternates.full).toBe(
      DEFAULT_RULESET.weights['machine-representation.declared-alternates'],
    )
    expect(SUBPOINTS.varyAccept.full).toBe(
      DEFAULT_RULESET.weights['machine-representation.vary-accept'],
    )
    expect(SUBPOINTS.substanceParity.full).toBe(
      DEFAULT_RULESET.weights['machine-representation.substance-parity'],
    )
    expect(SUBPOINTS.textAgreement.full).toBe(
      DEFAULT_RULESET.weights['structured-data.text-agreement'],
    )
    expect(SUBPOINTS.sitemap.full).toBe(DEFAULT_RULESET.weights['contract-discovery.sitemap'])
    expect(SUBPOINTS.machineEndpoint.full).toBe(
      DEFAULT_RULESET.weights['contract-discovery.machine-endpoint'],
    )
    expect(SUBPOINTS.llmsTxt.specShaped).toBe(
      DEFAULT_RULESET.weights['contract-discovery.llms-txt'],
    )
    expect(SUBPOINTS.structuredDataPresent.clean).toBe(
      DEFAULT_RULESET.weights['structured-data.present'],
    )
    expect(SUBPOINTS.renderIndependence.band[1]).toBe(
      DEFAULT_RULESET.weights['retrievability.render-independence'],
    )
  })

  it('every scored result keeps earned within weight, at every level', () => {
    for (const { name, result } of corpusResults()) {
      let total = 0
      for (const dimension of result.dimensions) {
        let own = 0
        for (const check of dimension.checks) {
          expect(Number.isInteger(check.earned), `${name}/${check.id} is not an integer`).toBe(true)
          expect(check.earned).toBeGreaterThanOrEqual(0)
          expect(check.earned, `${name}/${check.id}`).toBeLessThanOrEqual(check.weight)
          own += check.earned
        }
        expect(dimension.earned, `${name}/${dimension.id}`).toBe(own)
        expect(dimension.earned).toBeLessThanOrEqual(dimension.weight)
        total += dimension.earned
      }
      if (result.score !== null) expect(result.score, name).toBe(total)
    }
  })
})

// ---------------------------------------------------------------------------
// 053 — heuristic-controlled weight
// ---------------------------------------------------------------------------

describe('053 heuristic-controlled weight equals the published heuristic weight', () => {
  /**
   * The gate graph, written out. A gate is a check whose earned value can be
   * zeroed by ANOTHER check's outcome. ARS 0.1 has exactly two, both controlled
   * by D2.1, which is measured. The forbidden direction — a heuristic controlling
   * a measured check — would show up here as a controller with basis 'heuristic'.
   */
  const GATES: readonly [ArsCheckId, ArsCheckId][] = [
    ['machine-representation.vary-accept', 'machine-representation.negotiated-response'],
    ['machine-representation.substance-parity', 'machine-representation.negotiated-response'],
  ]

  it('no heuristic check gates any other check', () => {
    for (const [, controller] of GATES) expect(CHECK_META[controller].basis).toBe('measured')
  })

  it('the sum of every check a heuristic can zero or scale is exactly the heuristic weight', () => {
    const controlled = new Set<ArsCheckId>()
    for (const id of CHECK_IDS) if (CHECK_META[id].basis === 'heuristic') controlled.add(id)
    for (const [gated, controller] of GATES) {
      if (CHECK_META[controller].basis === 'heuristic') controlled.add(gated)
    }
    const weight = [...controlled].reduce((sum, id) => sum + (DEFAULT_RULESET.weights[id] ?? 0), 0)

    expect(weight).toBe(ARS_HEURISTIC_WEIGHT)
    expect(weight).toBeLessThanOrEqual(ARS_HEURISTIC_WEIGHT_CEILING)
    expect(ARS_MEASURED_WEIGHT + ARS_HEURISTIC_WEIGHT).toBe(100)
  })

  it('and the published totals match the check catalogue', () => {
    const measured = CHECK_IDS.filter((id) => CHECK_META[id].basis === 'measured').reduce(
      (sum, id) => sum + (DEFAULT_RULESET.weights[id] ?? 0),
      0,
    )
    expect(measured).toBe(ARS_MEASURED_WEIGHT)
    const result = score(bundle())
    expect(result.measuredWeight).toBe(ARS_MEASURED_WEIGHT)
    expect(result.heuristicWeight).toBe(ARS_HEURISTIC_WEIGHT)
  })

  it('every check publishes its basis, and every evidence line does too', () => {
    const result = score(gatewayBundle())
    for (const dimension of result.dimensions) {
      for (const check of dimension.checks) {
        expect(['measured', 'heuristic']).toContain(check.basis)
        expect(check.evidence.length, `${check.id} publishes no evidence`).toBeGreaterThan(0)
        for (const line of check.evidence) expect(['measured', 'heuristic']).toContain(line.basis)
      }
      // A dimension is heuristic if ANY of its checks is.
      const anyHeuristic = dimension.checks.some((check) => check.basis === 'heuristic')
      expect(dimension.basis).toBe(anyHeuristic ? 'heuristic' : 'measured')
    }
  })
})

// ---------------------------------------------------------------------------
// 054 — band boundaries
// ---------------------------------------------------------------------------

describe('054 band boundaries are pinned at 39/40, 59/60, 74/75, 89/90', () => {
  it('pins each boundary on both sides', () => {
    expect(bandFor(39)?.grade).toBe('F')
    expect(bandFor(40)?.grade).toBe('D')
    expect(bandFor(59)?.grade).toBe('D')
    expect(bandFor(60)?.grade).toBe('C')
    expect(bandFor(74)?.grade).toBe('C')
    expect(bandFor(75)?.grade).toBe('B')
    expect(bandFor(89)?.grade).toBe('B')
    expect(bandFor(90)?.grade).toBe('A')
    expect(bandFor(0)?.grade).toBe('F')
    expect(bandFor(100)?.grade).toBe('A')
  })

  it('covers 0..100 with no gap and no overlap', () => {
    const seen = new Map<number, string>()
    for (let value = 0; value <= 100; value++) {
      const band = bandFor(value)
      expect(band, `no band for ${value}`).not.toBeNull()
      seen.set(value, band?.grade ?? '')
    }
    expect(new Set(seen.values())).toEqual(new Set(['A', 'B', 'C', 'D', 'F']))
    for (const band of DEFAULT_RULESET.bands) {
      for (const other of DEFAULT_RULESET.bands) {
        if (band === other) continue
        expect(
          band.min > other.max || band.max < other.min,
          `${band.grade} overlaps ${other.grade}`,
        ).toBe(true)
      }
    }
  })

  it('scores are integers with no decimals, ever', () => {
    for (const { name, result } of corpusResults()) {
      if (result.score === null) continue
      expect(Number.isInteger(result.score), name).toBe(true)
      expect(String(result.score)).not.toContain('.')
    }
  })
})

// ---------------------------------------------------------------------------
// 055 / 056 — the purity gate
// ---------------------------------------------------------------------------

/** Source files of the pure half: everything under src/ except src/probe/. */
function pureSources(): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'probe') continue
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      out.push({ path, code: stripComments(readFileSync(path, 'utf8')) })
    }
  }
  walk(SRC)
  return out
}

/**
 * Removes block comments and whole-line `//` comments. An approximation, and
 * deliberately a conservative one: it never removes code, so a banned global in
 * code is always still visible to the scan. Its only job is to stop the words in
 * this package's (long) comments from tripping it.
 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
}

describe('055 no network', () => {
  it('the ESLint purity rule — the real gate — still bans fetch over src/', () => {
    const config = readFileSync(resolve(HERE, '..', 'eslint.config.mjs'), 'utf8')
    expect(config).toContain("name: 'fetch'")
    expect(config).toContain("'no-restricted-globals'")
    expect(config).toContain("files: ['src/**/*.ts']")
    expect(config).toContain("ignores: ['src/probe/**']")
  })

  it('and no file in the pure half calls it', () => {
    for (const { path, code } of pureSources()) {
      expect(/\bfetch\s*\(/.test(code), `${path} calls fetch`).toBe(false)
      expect(
        /\bXMLHttpRequest\b|\bWebSocket\b|\bnavigator\b/.test(code),
        `${path} reaches the network`,
      ).toBe(false)
      expect(/from ['"]node:/.test(code), `${path} imports a node builtin`).toBe(false)
    }
  })
})

describe('056 no clock, no randomness', () => {
  it('the ESLint purity rule still bans Date, performance and Math.random', () => {
    const config = readFileSync(resolve(HERE, '..', 'eslint.config.mjs'), 'utf8')
    expect(config).toContain("name: 'Date'")
    expect(config).toContain("name: 'performance'")
    expect(config).toContain("property: 'random'")
  })

  it('and no file in the pure half reads one', () => {
    for (const { path, code } of pureSources()) {
      expect(/\bnew Date\b|\bDate\.(now|parse|UTC)\b/.test(code), `${path} reads a clock`).toBe(
        false,
      )
      expect(/\bMath\.random\b/.test(code), `${path} uses randomness`).toBe(false)
      expect(/\bperformance\s*\./.test(code), `${path} reads a timer`).toBe(false)
    }
  })

  it('capturedAt never reaches the result', () => {
    const early = bundle()
    const late = { ...bundle(), capturedAt: '2031-01-01T00:00:00.000Z' }
    expect(JSON.stringify(score(late))).toBe(JSON.stringify(score(early)))
  })
})

// ---------------------------------------------------------------------------
// 057 — tokenizer fuzz
// ---------------------------------------------------------------------------

describe('057 tokenizer fuzz', () => {
  /**
   * A seeded linear congruential generator (Numerical Recipes constants). The
   * fuzz corpus has to be identical on every run and on every machine: a test
   * that fails one time in fifty on someone else's laptop teaches nobody
   * anything, and `Math.random` is banned in this package for the same reason it
   * is banned in the scorer.
   */
  function lcg(seed: number): () => number {
    let state = seed >>> 0
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 0x100000000
    }
  }

  const PIECES = [
    '<div',
    '<div>',
    '</div',
    '<!--',
    '-->',
    '<script>',
    '</script>',
    '<script type="application/ld+json">{"@type":',
    '<style>',
    '<a href=',
    '"',
    "'",
    '=',
    '<',
    '>',
    '&amp;',
    '&#x1F600;',
    '&notarealentity;',
    ' ',
    '\ud800',
    '\udfff',
    '€',
    'text',
    '<template>',
    '<meta charset=',
    '<title>',
    ' hidden ',
    ' style="display:none" ',
    '\n',
    '\t',
  ]

  it('never throws, for 500 hostile inputs', () => {
    const random = lcg(20260805)
    for (let i = 0; i < 500; i++) {
      let input = ''
      const length = 1 + Math.floor(random() * 40)
      for (let piece = 0; piece < length; piece++) {
        input += PIECES[Math.floor(random() * PIECES.length)] ?? ''
      }
      expect(() => tokenizeHtml(input)).not.toThrow()
    }
  })

  it('never throws on pathological nesting', () => {
    expect(() => tokenizeHtml('<div>'.repeat(50_000))).not.toThrow()
    expect(() => tokenizeHtml('</div>'.repeat(50_000))).not.toThrow()
    expect(() => tokenizeHtml(`<!--${'<div>'.repeat(1000)}`)).not.toThrow()
  })

  it('and score() survives the same inputs — a scanner must not be crashable by the page it scans', () => {
    const random = lcg(20260806)
    for (let i = 0; i < 60; i++) {
      let input = ''
      for (let piece = 0; piece < 30; piece++)
        input += PIECES[Math.floor(random() * PIECES.length)] ?? ''
      const evidence = bundle({
        agent: ok(AGENT_ACCEPT, capture(URL_UNDER_TEST, input, HTML_HEADERS)),
        browser: ok(BROWSER_ACCEPT, capture(URL_UNDER_TEST, input, HTML_HEADERS)),
      })
      expect(() => score(evidence)).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// 058 — profiles are total and typed
// ---------------------------------------------------------------------------

describe('058 profiles are total over ArsPageKind and typed over ArsFactKind', () => {
  /**
   * The `ArsFactKind` union, written out. TypeScript erases the union at
   * runtime, and this test exists precisely to catch a profile naming a fact
   * that is not in the vocabulary — so the vocabulary has to exist as data. It is
   * transcribed from `./types` and fixture `058` is what keeps the two in step.
   */
  const FACT_KINDS: readonly ArsFactKind[] = [
    'title',
    'description',
    'updated',
    'published',
    'price',
    'currency',
    'availability',
    'brand',
    'sku',
    'shipping',
    'returns',
    'org-name',
    'address',
    'hours',
    'phone',
    'email',
    'service-area',
    'author',
    'section',
    'authority',
    'primary-action-url',
    'eligibility',
    'duration',
    'question-answer',
    'item-count',
    'item-link',
  ]

  const PAGE_KINDS: readonly ArsPageKind[] = [
    'product',
    'collection',
    'article',
    'place',
    'service',
    'faq',
    'document',
    'unknown',
  ]

  it('every page kind has exactly one profile', () => {
    expect(PROFILES).toHaveLength(PAGE_KINDS.length)
    for (const kind of PAGE_KINDS) {
      const matches = PROFILES.filter((profile) => profile.pageKind === kind)
      expect(matches, `${kind} has ${matches.length} profiles`).toHaveLength(1)
      expect(profileFor(kind).pageKind).toBe(kind)
    }
    expect(Object.keys(PROFILE_BY_KIND).sort()).toEqual([...PAGE_KINDS].sort())
  })

  it('every fact name in every profile is a member of ArsFactKind', () => {
    for (const profile of PROFILES) {
      for (const kind of [...profile.core, ...profile.extended]) {
        expect(FACT_KINDS, `${profile.pageKind} names ${kind}`).toContain(kind)
      }
    }
  })

  it('no fact is both core and extended in the same profile, and no profile is empty', () => {
    for (const profile of PROFILES) {
      expect(profile.core.length, profile.pageKind).toBeGreaterThan(0)
      for (const kind of profile.core)
        expect(profile.extended, profile.pageKind).not.toContain(kind)
      expect(profile.byteReference, profile.pageKind).toBeGreaterThan(0)
    }
  })

  it('the ruleset carries a required-property list for every page kind', () => {
    for (const kind of PAGE_KINDS) {
      expect(DEFAULT_RULESET.requiredProperties[kind]?.length, kind).toBeGreaterThan(0)
    }
  })

  it('unknown is not an easy exit: it still needs a recognised type for D5.2', () => {
    expect(DEFAULT_RULESET.requiredProperties.unknown).toEqual(['name'])
    const untyped = score(
      bundle({
        agent: ok(
          AGENT_ACCEPT,
          capture(
            `${ORIGIN}/x/y`,
            '<!doctype html><html><head><title>Something</title></head><body><h1>Something</h1><p>Words.</p></body></html>',
            HTML_HEADERS,
          ),
        ),
        browser: null,
        url: `${ORIGIN}/x/y`,
      }),
    )
    expect(untyped.pageKind).toBe('unknown')
    expect(untyped.pageKindConfidence).toBe('low')
    expect(checkOf(untyped, 'structured-data.required-properties')).toBe(0)
  })

  it('classification never guesses into a vertical below medium confidence', () => {
    const classification = classify({
      jsonLdTypes: [],
      microdataTypes: [],
      rdfaTypes: [],
      ogType: null,
      pathSegments: ['some', 'page'],
      hasCurrencyToken: true,
      hasOpeningHours: false,
      hasTelephone: false,
    })
    expect(classification.pageKind).toBe('unknown')
    expect(classification.confidence).toBe('low')
  })
})

// ---------------------------------------------------------------------------
// 059 — the money parser
// ---------------------------------------------------------------------------

describe('059 money parser: the §3.11 format list, and ambiguous → null', () => {
  it('parses every enumerated format', () => {
    expect(parseMoneyText('$1,499.00')).toEqual({
      amount: 149900,
      currency: 'USD',
      qualified: false,
    })
    expect(parseMoneyText('1.499,00 €')).toEqual({
      amount: 149900,
      currency: 'EUR',
      qualified: false,
    })
    expect(parseMoneyText('¥4,900')).toEqual({ amount: 4900, currency: 'JPY', qualified: false })
    expect(parseMoneyText('USD 1499')).toEqual({
      amount: 149900,
      currency: 'USD',
      qualified: false,
    })
    expect(parseMoneyText('1499 USD')).toEqual({
      amount: 149900,
      currency: 'USD',
      qualified: false,
    })
  })

  it('disambiguates the separator by position and by the currency minor-unit width', () => {
    // Two minor digits: `1.500` cannot be a decimal, so the dot is a group mark.
    expect(parseMoneyText('1.500', { currency: 'EUR' })).toEqual({
      amount: 150000,
      currency: 'EUR',
      qualified: false,
    })
    // Three minor digits: `1.500` is one thousand five hundred fils OR 1.500
    // dinar, and both readings are valid — so it fails closed. A wrong price is
    // published as truth on a scanner page; a null price is simply not a fact.
    expect(parseMoneyText('1.500', { currency: 'KWD' })).toBeNull()
    expect(parseMoneyText('KWD 1.5')).toEqual({ amount: 1500, currency: 'KWD', qualified: false })
    expect(parseMoneyText('1,500', { currency: 'JPY' })).toEqual({
      amount: 1500,
      currency: 'JPY',
      qualified: false,
    })
  })

  it('returns the lower bound of a range, qualified', () => {
    expect(parseMoneyText('$148.00 – $198.00')).toEqual({
      amount: 14800,
      currency: 'USD',
      qualified: true,
    })
    expect(parseMoneyText('From $9')).toEqual({ amount: 900, currency: 'USD', qualified: true })
  })

  it('fails closed on anything ambiguous', () => {
    expect(parseMoneyText('1,500')).toBeNull()
    expect(parseMoneyText('50 OFF')).toBeNull()
    expect(parseMoneyText('4.5 stars')).toBeNull()
    expect(parseMoneyText('')).toBeNull()
    expect(parseMoneyText('TRY 2 FOR 1')).toBeNull()
  })

  it('a qualified value is excluded from the parity comparison', () => {
    // "From $9" in one representation against "$9 – $40" in the other is the same
    // page saying the same thing in two shapes; flagging it would be a false
    // accusation, so qualified values never enter D2.4.
    const ranged = score(
      bundle({
        agent: ok(
          AGENT_ACCEPT,
          capture(URL_UNDER_TEST, markdown('From $148.00'), MARKDOWN_HEADERS),
        ),
        browser: ok(
          BROWSER_ACCEPT,
          capture(URL_UNDER_TEST, html('148.00', '$148.00 – $198.00'), HTML_HEADERS),
        ),
      }),
    )
    expect(flagIds(ranged)).not.toContain('substance-divergence')
  })
})

// ---------------------------------------------------------------------------
// Integer arithmetic
// ---------------------------------------------------------------------------

describe('integer arithmetic', () => {
  it('produces integers everywhere a number is published', () => {
    for (const { name, result } of corpusResults()) {
      const numbers: number[] = []
      const walk = (value: unknown): void => {
        if (typeof value === 'number') numbers.push(value)
        else if (Array.isArray(value)) value.forEach(walk)
        else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk)
      }
      walk({
        score: result.score,
        dimensions: result.dimensions.map((d) => ({ earned: d.earned, weight: d.weight })),
        cost: result.cost,
        recommendations: result.recommendations.map((r) => r.pointsAvailable),
        facts: result.facts.map((f) => f.offset),
      })
      for (const value of numbers)
        expect(Number.isInteger(value), `${name}: ${value} is not an integer`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// The two tables that carry the same numbers (ARS 0.2)
// ---------------------------------------------------------------------------

describe('the ruleset cannot carry two disagreeing copies of a point value', () => {
  /**
   * ARS 0.2 rebalanced `WEIGHTS` and left `SUBPOINTS` on 0.1's numbers. Nothing
   * caught it: fixture `052` compares DIMENSION_META against WEIGHTS, and the
   * checks pay from SUBPOINTS, so the corpus re-scored with retrievability
   * claiming 28 while its checks could only pay 20. Every fixture lost points
   * for a reason that had nothing to do with the page.
   */
  it('every SUBPOINTS entry pays exactly its check weight', () => {
    for (const [checkId, total] of Object.entries(subpointTotals())) {
      expect(total, `${checkId}: SUBPOINTS pays ${total}`).toBe(
        DEFAULT_RULESET.weights[checkId as keyof typeof DEFAULT_RULESET.weights],
      )
    }
  })

  /**
   * A dimension missing from the publication order is dropped from the result
   * and its points vanish from the total, silently. D7 shipped that way for one
   * commit and the corpus re-scored against a maximum of 92.
   */
  it('the published dimensions cover every dimension in the ruleset', () => {
    // Score a fixture and read the dimensions the RESULT publishes: that is
    // the array DIMENSION_ORDER produces, and the one a missing entry silently
    // truncates.
    const anyEvidence = JSON.parse(
      readFileSync(join(CORPUS, '022-robots-open', 'evidence.json'), 'utf8'),
    ) as Parameters<typeof score>[0]
    const result = score(anyEvidence)
    const published = (result.dimensions ?? []).map((dimension) => dimension.id).sort()
    expect(published).toEqual(Object.keys(DIMENSION_META).sort())
  })

  it('the weights still total 100, and heuristic stays under its ceiling', () => {
    const total = Object.values(DEFAULT_RULESET.weights).reduce((a, b) => a + b, 0)
    expect(total).toBe(100)
    expect(ARS_MEASURED_WEIGHT + ARS_HEURISTIC_WEIGHT).toBe(100)
    expect(ARS_HEURISTIC_WEIGHT).toBeLessThanOrEqual(ARS_HEURISTIC_WEIGHT_CEILING)
  })

  /**
   * The third copy of the same fact. `types.ts` sits at the bottom of the import
   * graph so it cannot re-export the ruleset's version, which means the number
   * is written twice — and during the 0.2 rebalance the two disagreed, so every
   * result printed `specVersion: '0.1.0'` beside a 0.2 `rulesetHash`. A score
   * whose own identity fields name two different versions is worse than one
   * that names neither, because it looks comparable to 0.1 scores and is not.
   */
  it('the published specVersion is the ruleset version', () => {
    expect(ARS_SPEC_VERSION).toBe(DEFAULT_RULESET.version)
  })
})
