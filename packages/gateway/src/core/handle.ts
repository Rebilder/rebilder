/**
 * Request orchestration: classify → (maybe) render → emit → respond.
 *
 * Hot-path budget (project convention: p95 < 50ms compute at the edge):
 * no network calls, no dynamic imports, no clock reads beyond the timestamps
 * below. Classification is a few header string scans; rendering is pure
 * string assembly from data the merchant's resolver returns; verification is
 * pure crypto over an injected key registry. `render_ms` is measured with
 * performance.now() and stamped on every emitted event.
 */

import {
  readIntentSignalHeaders,
  stripIntentSignalHeaders,
  type ResponseCoverageV0,
  type ResponsePathV0,
  type ResponseSourceV0,
} from '@rebilder/events'
import {
  accessDeniedResponse,
  createAccessRuntime,
  evaluateAccess,
  type AccessRuntime,
} from './access'
import { classifyRequest } from './classify'
import { buildEvent, emitEvent } from './events'
import { markdownVariantPage } from './markdown-urls'
import { isMissingPage, markdownNotFoundResponse } from './not-found'
import { markdownResponse, resolveMarkdownWithSource } from './render'
import {
  applyVerification,
  stampVerification,
  stripVerificationHeaders,
  verifyProtocolRequest,
} from './verification'
import type { CompatibilityProfile } from '@rebilder/render-md'
import type { GatewayConfig } from './types'

/**
 * Handle one request end to end.
 *
 * Returns:
 * - a markdown `Response` (`text/markdown; charset=utf-8`, `Vary: Accept`,
 *   `X-Rebilder-Path: markdown`) when the request classified as agent traffic
 *   and a configured source matched the URL, or
 * - a protocol `Response` when the request classified onto the protocol path
 *   and the merchant's `config.protocols` handler (see GatewayConfig) served
 *   it, or
 * - with `config.markdownUrls`, the same markdown response for a GET or HEAD
 *   of `<page>.md` when a source answers `<page>`, whoever asks, or
 * - with `config.notFound`, a markdown 404 for a markdown request that no
 *   source answered and `notFound.isMissing` confirms, or
 * - `null` — serve your normal HTML. This covers humans, crawlers (Googlebot
 *   always gets canonical HTML — consistent source content), protocol routes without a
 *   wired `protocols` handler (or where it answered null/threw), URLs no
 *   source matched, sources that returned null, and sources that threw.
 *   A throwing source NEVER breaks the site.
 *
 * Every handled request — including every pass-through — emits one
 * RebilderEventV0 via `config.onEvent` when configured. Emission is
 * fire-and-forget and can neither block nor break the response.
 */
export async function handleRequest(req: Request, config: GatewayConfig): Promise<Response | null> {
  const start = performance.now()
  const decision = classifyRequest(req)
  // Not const: Web Bot Auth verification on the protocol path folds its
  // verdict (and any verified platform identity) back into the detection the
  // event is built from.
  let detection = decision.detection

  const emit = (
    path: ResponsePathV0,
    coverage: ResponseCoverageV0,
    source?: ResponseSourceV0,
    protocolIntent?: Record<string, unknown>,
    profile?: CompatibilityProfile,
  ): void => {
    emitEvent(
      config,
      buildEvent({
        storeId: config.storeId,
        detection,
        url: req.url,
        accept: req.headers.get('accept') ?? undefined,
        referrer: req.headers.get('referer') ?? undefined,
        path,
        renderMs: performance.now() - start,
        coverage,
        ...(profile === undefined ? {} : { profile }),
        ...(source !== undefined ? { source } : {}),
        ...(protocolIntent !== undefined ? { protocolIntent } : {}),
      }),
    )
  }

  // ── ACCESS CONTROL, BEFORE ANYTHING ELSE ──────────────────────────────────
  //
  // First because a refusal must cost the merchant nothing: no source resolver
  // runs, no protocol handler is invoked, no markdown is rendered. A denial
  // that still paid for the work it refused to serve is a denial that makes an
  // abusive client cheaper to serve, not more expensive.
  //
  // `evaluateAccess` returns "allowed" for humans and crawlers unconditionally,
  // so a policy can never deindex the merchant's site (consistent source content).
  //
  // The event is emitted for a denial exactly as for anything else — a
  // merchant who cannot see what their policy turned away cannot tell a working
  // policy from one that is blocking their best traffic.
  if (config.access !== undefined) {
    const runtime = accessRuntimeFor(config)
    const verdict = evaluateAccess(runtime.policy(), detection, runtime.limiter, Date.now(), {
      protocolRoute: decision.path === 'protocol',
    })
    if (!verdict.allowed) {
      emit('denied', 'not-applicable')
      return accessDeniedResponse(verdict)
    }
  }

  if (decision.path === 'protocol') {
    // Protocol route (/.well-known/ucp, /mcp, /acp). When the merchant wired
    // a protocol handler (config.protocols — typically @rebilder/protocols'
    // createProtocolHandler), serve its response; a throw is contained to a
    // pass-through (a protocol bug never breaks the site). Without a handler
    // — or when it answers null — the request passes through unchanged and
    // the event still records the demand (response.path 'protocol').
    //
    // Sources are never consulted on this path, so coverage is
    // not-applicable — a protocol probe is not an Agent Miss.
    if (config.protocols !== undefined) {
      let response: Response | null
      try {
        // The verdict header is ours, never the client's. When verification is
        // wired, stampVerification overwrites it with the real verdict; when it
        // is NOT, we still strip any client-sent value so a merchant handler
        // that trusts the header cannot be spoofed by a request that simply
        // sets it. Either path, the client's value never reaches the handler.
        let downstream = stripVerificationHeaders(req)
        if (config.verification !== undefined) {
          // Web Bot Auth verification (Phase 3): pure crypto over the
          // injected key registry — no network. The verdict rides to the
          // handler on a cloned request ('x-rebilder-agent-verified',
          // overwriting any client-sent value) and onto the event
          // (requester.verified). The hook runs either way: read endpoints
          // stay open; transactional gating is the handler's job.
          const result = await verifyProtocolRequest(req, config.verification)
          detection = applyVerification(detection, result)
          downstream = stampVerification(req, result)
        }
        response = await config.protocols(downstream)
      } catch {
        response = null
      }
      if (response !== null) {
        // The adapter's intent headers (tool, scrubbed query, result count —
        // see @rebilder/events intent channel) are read into the event and
        // STRIPPED: through the gateway they are an internal channel, not a
        // wire surface. Stripping can fail only on an immutable-header
        // Response, which then simply keeps its headers.
        const protocolIntent = readIntentSignalHeaders(response.headers)
        try {
          stripIntentSignalHeaders(response.headers)
        } catch {
          /* immutable headers — response serves unchanged */
        }
        emit('protocol', 'not-applicable', undefined, protocolIntent)
        return response
      }
    }
    emit('protocol', 'not-applicable')
    return null
  }

  // ── `.md` URL VARIANTS (config.markdownUrls) ──────────────────────────────
  //
  // `/docs/setup.md` is its own URL whose only representation is the markdown
  // of `/docs/setup`, so it is answered for every requester, not only agents:
  // a person pasting the link into a chat, a CLI with no Accept header. The
  // page URL is unaffected and still gives crawlers their HTML. After access
  // control (a denied agent stays denied) and after the protocol routes.
  //
  // No source for the page means this is not a variant we own: the request
  // continues below as the ordinary URL it is, so a real `.md` file serves.
  if (config.markdownUrls === true) {
    const page = markdownVariantPage(new URL(req.url), req.method)
    if (page !== null) {
      const variant = await resolveMarkdownWithSource(page, config)
      if (variant !== null) {
        emit('markdown', 'sourced', variant.source, undefined, variant.profile)
        return markdownResponse(variant.markdown, page.href, variant.profile)
      }
    }
  }

  if (decision.path === 'html') {
    // Humans, crawlers, and unidentified agents that didn't ask for markdown:
    // the merchant serves their canonical HTML ('html-variant' in the events
    // schema; variant selection itself is Phase 4). No source was consulted,
    // so this is not-applicable, not a miss — counting every human page view
    // as an unanswered agent question would make the Miss Report noise.
    emit('html-variant', 'not-applicable')
    return null
  }

  // Markdown path. resolveMarkdownWithSource never throws: a throwing source
  // is a no-match, a render failure is a pass-through.
  const resolution = await resolveMarkdownWithSource(new URL(req.url), config)
  if (resolution === null) {
    // THE Agent Miss: an agent asked for markdown and every configured
    // resolver returned null. The serving path is still 'html-variant' (we
    // passed through), which is exactly why coverage is a separate field.
    emit('html-variant', 'unsourced', 'none')
    // The markdown 404 (config.notFound) answers only when the merchant's own
    // predicate says the page does not exist. The event above is deliberately
    // the same one: the request is still an Agent Miss, and Console numbers
    // must not move because the 404 body changed format (core/not-found.ts).
    if (config.notFound !== undefined && isMissingPage(config, new URL(req.url))) {
      return markdownNotFoundResponse(config.notFound, new URL(req.url))
    }
    return null
  }

  emit('markdown', 'sourced', resolution.source, undefined, resolution.profile)
  // The request URL IS the canonical URL on this path — the gateway serves
  // markdown at the page's own address, which is the whole content-negotiation
  // premise. (The dedicated markdown route is the case where they differ, and
  // it renders its own response.)
  return markdownResponse(resolution.markdown, new URL(req.url).href, resolution.profile)
}

/**
 * One compiled policy and one limiter per config object, built on first use.
 *
 * A WeakMap rather than module state, because a process can host more than one
 * gateway (a monorepo dev server, a multi-tenant host) and they must not share
 * a rate-limit bucket — one tenant's traffic would throttle another's. Weak so
 * a discarded config takes its counters with it.
 *
 * This is where "compiled to a static blob at boot" actually happens: the
 * compile runs once per config, and every subsequent request is a Map lookup.
 */
const RUNTIMES = new WeakMap<object, { runtime: AccessRuntime; verificationConfigured: boolean }>()

/**
 * THE KEY IS THE POLICY SOURCE, NOT THE CONFIG WRAPPER. A host that builds a
 * fresh config per request (the hosted multi-tenant path does — sources are
 * per-request closures) must still get ONE compiled policy and ONE limiter
 * per tenant, or a `limit` rule would hand every request a fresh, empty
 * bucket and never fire. The policy source object is the identity that
 * actually means "same policy": reuse the same object (or getter) and the
 * runtime follows; hand each gateway its own literal and the budgets stay
 * separate, which is what the per-gateway tests pin. Rebuilt if the same
 * source reappears under different verification wiring, since compilation
 * depends on it.
 */
function accessRuntimeFor(config: GatewayConfig): AccessRuntime {
  const source = config.access as NonNullable<GatewayConfig['access']>
  const verificationConfigured = config.verification !== undefined
  const existing = RUNTIMES.get(source)
  if (existing !== undefined && existing.verificationConfigured === verificationConfigured) {
    return existing.runtime
  }
  const runtime = createAccessRuntime(source, { verificationConfigured })
  RUNTIMES.set(source, { runtime, verificationConfigured })
  return runtime
}
