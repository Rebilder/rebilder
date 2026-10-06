/**
 * probe/index.ts — `"./probe"`. The server-only, deliberately impure half.
 *
 * The pure half (`.`) consumes exactly one thing: an `ArsEvidence` bundle. This
 * file is the only sanctioned way to produce one from a live origin. Everything
 * non-deterministic in ARS is here — sockets, DNS, the clock, sleeping — and
 * nothing here influences a score except through the bundle it returns. The
 * ESLint purity rule in `eslint.config.mjs` exempts `src/probe/**`, and only
 * `src/probe/**`; nothing that needs a clock or a socket may move up a directory.
 *
 * THE REQUEST SET IS CLOSED (§3.3). Per URL: an **agent probe** and a **browser
 * control** that differ in the `Accept` header AND IN NOTHING ELSE — same User
 * Agent, same everything. That is what makes the D2.4 parity check meaningful and
 * what stops a correctly installed gateway, which negotiates on `Accept` and not
 * on UA, from being scored as a cloaker. ARS 0.3 adds one conditional request:
 * when the agent probe got HTML and the page declares a Markdown copy at another
 * same-origin address, that one address is fetched with the agent's headers
 * (`markdownAlternateTarget` in `../score` decides which, for the probe and the
 * scorer alike). Per origin: `/robots.txt` (first), `/llms.txt`,
 * `/.well-known/ucp`. Nothing else. No guessing `/sitemap.xml`,
 * `/mcp`, `/acp` — credit for an endpoint comes from *declaring* it, because an
 * endpoint an agent cannot find is an endpoint that does not exist. The three
 * probed paths are the disclosed exception: published conventions at published
 * locations.
 *
 * WE IMITATE AGENT INTENT, NEVER AGENT IDENTITY. `assertIdentities` refuses a
 * User-Agent that names somebody else's crawler and refuses an agent/browser
 * pair whose UAs differ. The printed consequence, which belongs next to the
 * parity check and not in a footnote: ARS cannot detect UA-targeted cloaking,
 * including cloaking aimed at `rebilder-ars` itself.
 *
 * THE TWO DEFECTS THIS FILE EXISTS TO CLOSE (design §5.2):
 *  - **DNS.** The ancestor guard rejected IP literals and resolved nothing. See
 *    `./ssrf`: we resolve, we reject if any answer is reserved, we connect
 *    pinned to the validated address, and we re-resolve and re-pin on every hop.
 *  - **Byte cap.** The ancestor called `await response.text()` with no limit.
 *    Bodies are streamed through `getReader()`, decoded bytes are counted, the
 *    read is aborted at the ruleset's 2 MiB and `truncated: true` is recorded.
 *    Silently scoring a truncated body would make the heaviest pages score best
 *    on D3.2 — the one number the product is built on.
 *
 * WHAT THIS FILE DOES NOT DO. It does not take the §3.8 parity-confirm probe
 * (`probes.parityConfirm` is always `null` here): that one is taken ≥30s after a
 * divergence is detected, which is a scan-orchestration decision, not something
 * to hide inside a call with a 5s budget. It does not cache; caching is the
 * caller's, because the cache key is the caller's. And it does not decide what a
 * result means — `score()` does, from the bundle alone.
 */

import type {
  ArsEvidence,
  ArsHttpCapture,
  ArsProbeError,
  ArsProbeRecord,
  ArsRuleset,
  ArsVantage,
} from '../types'
import { DEFAULT_RULESET } from '../ruleset'
import { utf8Length } from '../extract'
import { ARS_ROBOTS_TOKEN, robotsDisallowsScanner } from '../robots-policy'
import { AGENT_ACCEPT, ASSET_ACCEPT, BROWSER_ACCEPT } from './headers'
import { markdownAlternateTarget, sha256Hex } from '../score'
import {
  createDnsResolver,
  createPinnedTransport,
  guardUrl,
  resolveAndValidate,
  type HostPolicy,
  type HostResolver,
  type ProbeHttpResponse,
  type ProbeTransport,
} from './ssrf'
import { createLimiter, ProbeBudgetExceededError, type Limiter, type LimiterLease } from './limiter'

/* ── re-exports: everything a consumer of "./probe" legitimately needs ─────── */

export {
  classifyIp,
  createDnsResolver,
  createPinnedTransport,
  fromWebResponse,
  guardPreviewUrl,
  guardUrl,
  parseIpv4,
  parseIpv6,
  resolveAndValidate,
} from './ssrf'
export type {
  HostResolver,
  IpClassification,
  PinnedAddress,
  ProbeHttpResponse,
  ProbeRequestInit,
  ProbeTransport,
  ResolveOutcome,
  UrlGuardPolicy,
  UrlGuardResult,
} from './ssrf'
export { createLimiter, ProbeBudgetExceededError } from './limiter'
export type { Limiter, LimiterLease, LimiterOptions } from './limiter'

/* ── identities (§3.3) ────────────────────────────────────────────────────── */

export type ProbeRole = 'agent' | 'browser' | 'asset'

export interface ProbeIdentity {
  readonly role: ProbeRole
  readonly userAgent: string
  readonly accept: string
}

/**
 * Honest, contactable, and never anybody else's. The number tracks the spec
 * version, so a server log tells its operator which ruleset scored them.
 *
 * IT IS NOT THE REFUSAL TOKEN. A site that disallowed us under 0.1 is still
 * refusing us under 0.2, because robots.txt is matched on `ARS_ROBOTS_TOKEN`
 * below and that string never moves. Versioning the refusal token would let a
 * spec bump quietly re-open sites that already said no.
 */
export const ARS_USER_AGENT = 'rebilder-ars/0.3 (+https://rebilder.com/bots)'

/**
 * Re-exported, not defined here: the token and the refusal decision moved to
 * `../robots-policy` when a second probe (the browser extension) needed to
 * honour the same refusals without importing this module. See the note there.
 */
export { ARS_ROBOTS_TOKEN }

export { AGENT_ACCEPT, ASSET_ACCEPT, BROWSER_ACCEPT } from './headers'

const AGENT_IDENTITY: ProbeIdentity = {
  role: 'agent',
  userAgent: ARS_USER_AGENT,
  accept: AGENT_ACCEPT,
}
const BROWSER_IDENTITY: ProbeIdentity = {
  role: 'browser',
  userAgent: ARS_USER_AGENT,
  accept: BROWSER_ACCEPT,
}
const ASSET_IDENTITY: ProbeIdentity = {
  role: 'asset',
  userAgent: ARS_USER_AGENT,
  accept: ASSET_ACCEPT,
}

export const DEFAULT_IDENTITIES: readonly ProbeIdentity[] = Object.freeze([
  AGENT_IDENTITY,
  BROWSER_IDENTITY,
  ASSET_IDENTITY,
])

/**
 * Crawler names we refuse to wear. Not a completeness claim — it is a tripwire
 * for the specific mistake of "just set the UA to Googlebot and see what they
 * serve", which is the one request this package must never make on anyone's
 * behalf.
 */
const IMPERSONATION_TOKENS = [
  'googlebot',
  'bingbot',
  'applebot',
  'baiduspider',
  'yandexbot',
  'duckduckbot',
  'slurp',
  'gptbot',
  'chatgpt',
  'oai-searchbot',
  'claudebot',
  'claude-user',
  'claude-searchbot',
  'anthropic-ai',
  'perplexitybot',
  'perplexity-user',
  'facebookexternalhit',
  'meta-external',
] as const

function assertIdentities(identities: readonly ProbeIdentity[]): string | null {
  const byRole = new Map<ProbeRole, ProbeIdentity>()
  for (const identity of identities) byRole.set(identity.role, identity)
  const agent = byRole.get('agent')
  const browser = byRole.get('browser')
  if (agent === undefined || browser === undefined) {
    return 'the identity set must contain an "agent" and a "browser" entry (§3.3)'
  }
  if (agent.userAgent !== browser.userAgent) {
    return 'the agent and browser probes must send the SAME User-Agent and differ only in Accept (§3.3) — a UA difference makes the parity check measure our own request instead of the page'
  }
  for (const identity of identities) {
    const ua = identity.userAgent.toLowerCase()
    for (const token of IMPERSONATION_TOKENS) {
      if (ua.includes(token)) {
        return `the User-Agent names another operator's crawler ("${token}"). ARS imitates agent intent, never agent identity (§3.3)`
      }
    }
  }
  return null
}

/* ── policy ───────────────────────────────────────────────────────────────── */

/**
 * Policy as a type rather than a pile of booleans — and note what is NOT here:
 * there is no `allowPrivateHosts`. Private/loopback targets are unlocked by
 * importing a different entry point (`./probe/local`), which throws at import
 * time without a per-invocation opt-in, not by flipping a field on a config
 * object that somebody will one day copy into a hosted route.
 */
export interface ProbePolicy {
  /** Default false. True only under `./probe/local`. */
  allowHttp: boolean
  /** 2 MiB, from the ruleset. Normative: two caps produce two different scores. */
  maxBodyBytes: number
  /** 3, from the ruleset. */
  maxRedirects: number
  /** 5 000ms, from the ruleset. */
  timeoutMs: number
  /** Injected, never module-global. See `./limiter` for why that matters. */
  limiter: Limiter
  identities: readonly ProbeIdentity[]
}

/**
 * The hosted policy: https only, ruleset caps, default identities. The limiter
 * is a required argument because "who owns this run's budget" is a question the
 * caller has to answer, and a default would answer it wrongly in a warm
 * serverless instance.
 */
export function strictPolicy(limiter: Limiter, ruleset: ArsRuleset = DEFAULT_RULESET): ProbePolicy {
  return {
    allowHttp: false,
    maxBodyBytes: ruleset.maxBodyBytes,
    maxRedirects: ruleset.maxRedirects,
    timeoutMs: ruleset.timeoutMs,
    limiter,
    identities: DEFAULT_IDENTITIES,
  }
}

/* ── options and outcome ──────────────────────────────────────────────────── */

export interface ProbeOptions {
  /** Default `'public'`. Only `'public'` is gated on the `rebilder-ars` token. */
  vantage?: ArsVantage
  /** Default: DNS-pinned `node:https`. Injected in tests; never bypasses the guard. */
  transport?: ProbeTransport
  /** Default: real DNS. Validation runs whatever transport is in use. */
  resolver?: HostResolver
  /** Default: wall clock. Feeds `ArsEvidence.capturedAt`, which is excluded from the hash. */
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  /** §3.3: one retry after 5s before a 5xx robots.txt becomes `robots-unavailable`. */
  robotsRetryDelayMs?: number
}

/**
 * Why `rejection` is not an `ArsUnscoredReason`: these are the cases where no
 * evidence bundle exists at all, so there is nothing for `score()` to judge.
 * Everything the origin actually said — a 404, a 500, a timeout, a redirect loop
 * — comes back as `{ ok: true }` with the failure recorded inside the bundle,
 * because that IS the observation.
 */
export type ProbeRejection = 'invalid-url' | 'policy-rejected' | 'budget-exceeded'

export type ProbeOutcome =
  | { ok: true; evidence: ArsEvidence }
  | { ok: false; rejection: ProbeRejection; detail: string }

/* ── body reading: streamed, counted, capped ──────────────────────────────── */

interface DecodedBody {
  text: string
  /** UTF-8 byte length of `text` — the normative measurement (§3.3). */
  bytes: number
  truncated: boolean
}

/** `charset` from Content-Type, defaulting to UTF-8 (§3.3). */
function charsetOf(headers: Record<string, string[]>): string {
  const value = headers['content-type']?.[0]
  if (value === undefined) return 'utf-8'
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(value)
  return match?.[1]?.toLowerCase() ?? 'utf-8'
}

function createDecoder(charset: string): TextDecoder {
  try {
    return new TextDecoder(charset, { fatal: false })
  } catch {
    return new TextDecoder('utf-8', { fatal: false })
  }
}

/** Largest prefix of `chunk` whose UTF-8 length fits in `budget`, split on code points. */
function fitPrefix(chunk: string, budget: number): string {
  let out = ''
  let used = 0
  for (const codePoint of chunk) {
    const size = utf8Length(codePoint)
    if (used + size > budget) break
    out += codePoint
    used += size
  }
  return out
}

/**
 * Streams the body, counting decoded UTF-8 bytes, and cancels the read the
 * moment the cap is reached. `await response.text()` is forbidden by §3.3 and is
 * the live defect this replaces: `BODY_PREVIEW_CHARS` in the Console preview
 * truncated only what was *stored*, so a 4 GB response was still fully buffered
 * into the server's heap before anything was trimmed.
 *
 * The NORMATIVE cap is on decoded UTF-8 bytes (§3.3), because that is the number
 * D3.2 scores and two implementations counting different things produce
 * different scores. Wire bytes carry a separate, much looser ceiling whose only
 * job is to bound the read for a charset that SHRINKS on decode — UTF-16 halves,
 * so without it a 2 MiB decoded cap would let 4 MiB off the socket. It is set
 * well above any real ratio on purpose: making it tight would mark a perfectly
 * complete UTF-16 page as `truncated`, and a false truncation flag is a lie
 * about the evidence.
 */
async function readCappedBody(
  body: ReadableStream<Uint8Array> | null,
  charset: string,
  maxBytes: number,
): Promise<DecodedBody> {
  if (body === null) return { text: '', bytes: 0, truncated: false }

  const decoder = createDecoder(charset)
  const reader = body.getReader()
  const parts: string[] = []
  /** Backstop only; see the note above. No real charset shrinks by 4×. */
  const rawCeiling = maxBytes * 4
  let bytes = 0
  let rawBytes = 0
  let truncated = false

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      rawBytes += value.byteLength

      const chunk = decoder.decode(value, { stream: true })
      const chunkBytes = utf8Length(chunk)
      if (bytes + chunkBytes > maxBytes) {
        const prefix = fitPrefix(chunk, maxBytes - bytes)
        if (prefix.length > 0) parts.push(prefix)
        bytes += utf8Length(prefix)
        truncated = true
        break
      }
      parts.push(chunk)
      bytes += chunkBytes

      if (rawBytes >= rawCeiling) {
        truncated = true
        break
      }
    }
    if (!truncated) {
      const tail = decoder.decode()
      if (tail.length > 0) {
        const tailBytes = utf8Length(tail)
        if (bytes + tailBytes > maxBytes) {
          const prefix = fitPrefix(tail, maxBytes - bytes)
          parts.push(prefix)
          bytes += utf8Length(prefix)
          truncated = true
        } else {
          parts.push(tail)
          bytes += tailBytes
        }
      }
    }
  } finally {
    // Cancelling is what actually stops the socket; without it the cap only
    // limits what we keep, not what the origin sends us.
    await reader.cancel().catch(() => undefined)
  }

  return { text: parts.join(''), bytes, truncated }
}

/* ── one request, with the full guard on every hop ────────────────────────── */

interface FetchContext {
  readonly policy: ProbePolicy
  readonly hostPolicy: HostPolicy
  readonly transport: ProbeTransport
  readonly resolver: HostResolver
}

type FetchResult = ArsProbeRecord['result']

function failed(error: ArsProbeError, detail: string): FetchResult {
  return { ok: false, error, detail }
}

function classifyTransportError(error: unknown, signal: AbortSignal): ArsProbeError {
  const reason: unknown = signal.aborted ? signal.reason : undefined
  if (reason instanceof Error && reason.name === 'TimeoutError') return 'timeout'
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout'
  if (signal.aborted) return 'timeout'
  return 'unreachable'
}

async function fetchWithPolicy(
  startUrl: string,
  headers: Readonly<Record<string, string>>,
  context: FetchContext,
): Promise<FetchResult> {
  const { policy, hostPolicy, transport, resolver } = context
  const redirects: { status: number; location: string }[] = []
  let current = startUrl

  // `hop < maxRedirects`, not `<=`. The shipped Console loop used `<=` and
  // therefore allowed four requests where the ruleset says three (§3.3).
  for (let hop = 0; hop < policy.maxRedirects; hop++) {
    const blocked: ArsProbeError = hop === 0 ? 'policy-rejected' : 'blocked-redirect'

    const guard = guardUrl(current, { allowHttp: policy.allowHttp, hostPolicy })
    if (!guard.ok) return failed(blocked, guard.reason)

    // Re-resolve and re-pin on EVERY hop. Re-parsing the Location URL is not
    // enough: hop 2 is a new connection to a new name.
    const resolved = await resolveAndValidate(guard.url.hostname, resolver, hostPolicy)
    if (!resolved.ok) {
      return failed(resolved.kind === 'unreachable' ? 'unreachable' : blocked, resolved.reason)
    }

    // Politeness before the socket, not after. A `ProbeBudgetExceededError` is
    // deliberately allowed to propagate: half a bundle is not evidence, so the
    // whole probe reports `budget-exceeded` rather than a partial observation.
    const lease: LimiterLease = await policy.limiter.acquire(guard.url.hostname)

    const signal = AbortSignal.timeout(policy.timeoutMs)
    let response: ProbeHttpResponse
    try {
      response = await transport(guard.url.toString(), {
        headers,
        redirect: 'manual',
        signal,
        pinnedAddresses: resolved.addresses,
      })
    } catch (error) {
      lease.release()
      const kind = classifyTransportError(error, signal)
      return failed(
        kind,
        kind === 'timeout'
          ? `No response within ${policy.timeoutMs}ms.`
          : `The URL could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers['location']?.[0]
      // Drain and drop: a redirect body is not evidence, and leaving the stream
      // open leaves the socket open.
      if (response.body !== null) await response.body.cancel().catch(() => undefined)
      lease.release()
      if (location === undefined || location.trim() === '') {
        return failed('non-2xx', `Redirect (${response.status}) without a Location header.`)
      }
      let next: string
      try {
        next = new URL(location, guard.url).toString()
      } catch {
        return failed('blocked-redirect', `Redirect to an unparseable Location: ${location}`)
      }
      redirects.push({ status: response.status, location: next })
      current = next
      continue
    }

    let decoded: DecodedBody
    try {
      decoded = await readCappedBody(
        response.body,
        charsetOf(response.headers),
        policy.maxBodyBytes,
      )
    } catch (error) {
      const kind = classifyTransportError(error, signal)
      return failed(
        kind,
        `The response body could not be read: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      lease.release()
    }

    const capture: ArsHttpCapture = {
      requestedUrl: startUrl,
      finalUrl: guard.url.toString(),
      redirects,
      status: response.status,
      headers: response.headers,
      bytes: decoded.bytes,
      bodySha256: sha256Hex(decoded.text),
      body: decoded.text,
      truncated: decoded.truncated,
    }
    return { ok: true, capture }
  }

  return failed('too-many-redirects', `More than ${policy.maxRedirects - 1} redirects.`)
}

/* ── robots ───────────────────────────────────────────────────────────────── */

/* ── the probe ────────────────────────────────────────────────────────────── */

function headersFor(identity: ProbeIdentity): Record<string, string> {
  return { accept: identity.accept, 'user-agent': identity.userAgent }
}

function identityFor(policy: ProbePolicy, role: ProbeRole): ProbeIdentity {
  const found = policy.identities.find((identity) => identity.role === role)
  // `assertIdentities` guarantees agent/browser; `asset` falls back to agent.
  return found ?? policy.identities.find((identity) => identity.role === 'agent') ?? AGENT_IDENTITY
}

function skipped(headers: Record<string, string>, detail: string): ArsProbeRecord {
  return { requestHeaders: headers, result: { ok: false, error: 'policy-rejected', detail } }
}

/**
 * `hostPolicy` is a capability, not a flag: the only value other than
 * `'public-only'` is a symbol exported from a non-entry-point module, so a
 * consumer of `"./probe"` cannot construct one. Exported because
 * `"./probe/local"` has to call it; harmless because calling it without the
 * symbol is exactly `probeStrict`.
 */
export async function probeWithHostPolicy(
  target: string,
  policy: ProbePolicy,
  hostPolicy: HostPolicy,
  options: ProbeOptions = {},
): Promise<ProbeOutcome> {
  const identityProblem = assertIdentities(policy.identities)
  if (identityProblem !== null) {
    return { ok: false, rejection: 'policy-rejected', detail: identityProblem }
  }

  // "Unparseable" and "parseable but refused" are different answers to the
  // caller — the CLI exit-code contract splits them (2 = usage, 4 = policy) —
  // so they are distinguished by re-parsing rather than by matching on the
  // guard's message text.
  let parseable = true
  try {
    void new URL(target.trim())
  } catch {
    parseable = false
  }

  const guard = guardUrl(target, { allowHttp: policy.allowHttp, hostPolicy })
  if (!guard.ok) {
    return {
      ok: false,
      rejection: parseable ? 'policy-rejected' : 'invalid-url',
      detail: guard.reason,
    }
  }

  const context: FetchContext = {
    policy,
    hostPolicy,
    transport: options.transport ?? createPinnedTransport(),
    resolver: options.resolver ?? createDnsResolver(),
  }
  const vantage = options.vantage ?? 'public'
  const now = options.now ?? (() => new Date())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const robotsRetryDelayMs = options.robotsRetryDelayMs ?? 5_000

  const url = guard.url
  const origin = url.origin
  const assetHeaders = headersFor(identityFor(policy, 'asset'))
  const agentHeaders = headersFor(identityFor(policy, 'agent'))
  const browserHeaders = headersFor(identityFor(policy, 'browser'))

  const run = async (href: string, headers: Record<string, string>): Promise<ArsProbeRecord> => {
    try {
      return { requestHeaders: headers, result: await fetchWithPolicy(href, headers, context) }
    } catch (error) {
      if (error instanceof ProbeBudgetExceededError) throw error
      return {
        requestHeaders: headers,
        result: {
          ok: false,
          error: 'unreachable',
          detail: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  const evidenceOf = (probes: ArsEvidence['probes']): ProbeOutcome => ({
    ok: true,
    evidence: {
      evidenceVersion: '0.1.0',
      target: { url: url.toString(), origin },
      probes,
      vantage,
      capturedAt: now().toISOString(),
    },
  })

  try {
    // 1 — robots.txt, first, always. §3.3.
    let robotsTxt = await run(`${origin}/robots.txt`, assetHeaders)
    const robotsUnavailable = (record: ArsProbeRecord): boolean =>
      !record.result.ok || record.result.capture.status >= 500
    // Retry a transport hiccup or a 5xx. NEVER retry a refusal: a target we
    // declined on policy grounds will be declined identically in five seconds,
    // and sleeping first only makes the caller wait for the same answer.
    const worthRetrying = (record: ArsProbeRecord): boolean =>
      record.result.ok
        ? record.result.capture.status >= 500
        : record.result.error === 'unreachable' || record.result.error === 'timeout'
    if (worthRetrying(robotsTxt)) {
      // A single hiccup does not un-score a domain; a persistent 5xx does.
      await sleep(robotsRetryDelayMs)
      robotsTxt = await run(`${origin}/robots.txt`, assetHeaders)
    }
    if (robotsUnavailable(robotsTxt)) {
      const detail =
        'robots.txt returned a persistent error; a policy we could not read is not a policy we may assume'
      return evidenceOf({
        agent: skipped(agentHeaders, detail),
        browser: skipped(browserHeaders, detail),
        parityConfirm: null,
        robotsTxt,
        llmsTxt: null,
        wellKnownUcp: null,
      })
    }

    const robotsBody = robotsTxt.result.ok ? (robotsTxt.result.capture.body ?? '') : ''
    const robotsUsable = robotsTxt.result.ok && robotsTxt.result.capture.status < 400
    const disallowedFor = (path: string): string | null =>
      vantage === 'public' && robotsUsable ? robotsDisallowsScanner(robotsBody, path) : null

    // 2 — we obey our own token, and we do not fetch what it forbids.
    const pageRule = disallowedFor(url.pathname)
    if (pageRule !== null) {
      const detail = `robots.txt disallows the ${ARS_ROBOTS_TOKEN} token (${pageRule})`
      return evidenceOf({
        agent: skipped(agentHeaders, detail),
        browser: skipped(browserHeaders, detail),
        parityConfirm: null,
        robotsTxt,
        llmsTxt: null,
        wellKnownUcp: null,
      })
    }

    // 3 — agent, then browser control. Sequential: two quick hits are gentler on
    //     an origin than a simultaneous pair, and the limiter spaces them anyway.
    const agent = await run(url.toString(), agentHeaders)
    const browser = await run(url.toString(), browserHeaders)

    // 3b — the Markdown copy the page links to, when it did not send one (ARS 0.3).
    const linked = markdownAlternateTarget(
      agent.result.ok ? agent.result.capture : null,
      browser.result.ok ? browser.result.capture : null,
      origin,
    )
    let markdownAlternate: ArsProbeRecord | null = null
    if (linked !== null) {
      const rule = disallowedFor(new URL(linked).pathname)
      markdownAlternate =
        rule !== null
          ? skipped(agentHeaders, `robots.txt disallows ${ARS_ROBOTS_TOKEN} for ${linked}`)
          : await run(linked, agentHeaders)
    }

    // 4 — the two origin-level conventions, and nothing else.
    const fetchAsset = async (path: string): Promise<ArsProbeRecord | null> => {
      const rule = disallowedFor(path)
      if (rule !== null)
        return skipped(assetHeaders, `robots.txt disallows ${ARS_ROBOTS_TOKEN} for ${path}`)
      return run(`${origin}${path}`, assetHeaders)
    }
    const llmsTxt = await fetchAsset('/llms.txt')
    const wellKnownUcp = await fetchAsset('/.well-known/ucp')

    return evidenceOf({
      agent,
      browser,
      parityConfirm: null,
      // Omitted when not taken, so a page with no linked copy produces exactly
      // the bundle (and the evidence hash) it produced under 0.2.
      ...(markdownAlternate === null ? {} : { markdownAlternate }),
      robotsTxt,
      llmsTxt,
      wellKnownUcp,
    })
  } catch (error) {
    if (error instanceof ProbeBudgetExceededError) {
      return { ok: false, rejection: 'budget-exceeded', detail: error.message }
    }
    throw error
  }
}

/**
 * The hosted probe. https only, public hosts only, DNS-validated and pinned,
 * 2 MiB streamed cap, robots-gated, limiter-gated.
 *
 * There is deliberately no argument that relaxes any of that. `probeLocal` lives
 * at `"./probe/local"`, throws at import time without a per-invocation opt-in,
 * and is imported by the CLI and by nothing that can be reached over HTTP.
 */
export function probeStrict(
  target: string,
  policy: ProbePolicy,
  options: ProbeOptions = {},
): Promise<ProbeOutcome> {
  return probeWithHostPolicy(target, policy, 'public-only', options)
}

/** Convenience for one-off callers: a fresh run-scoped limiter and the strict policy. */
export function strictPolicyForRun(overrides: Partial<ProbePolicy> = {}): ProbePolicy {
  return { ...strictPolicy(createLimiter()), ...overrides }
}

/**
 * The type is exported so `probeWithHostPolicy`'s signature is nameable. The
 * *value* — the `ALLOW_PRIVATE_HOSTS` symbol — is deliberately NOT re-exported
 * here: it lives in `./ssrf`, which `package.json#exports` does not publish, so
 * the only way to hold it is to be inside this package. Re-exporting it from
 * `"./probe"` would turn the capability straight back into the boolean it was
 * designed to replace.
 */
export type { HostPolicy }
