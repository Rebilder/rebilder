/**
 * Event construction + fire-and-forget emission.
 *
 * Every handled request — including pass-throughs — emits exactly one
 * RebilderEventV0 (packages/events, THE observation-layer contract) when
 * `onEvent` is configured. Emission can never block or break a response:
 * it is never awaited, sync throws are caught, async rejections are handled.
 */

import type { DetectionResult } from '@rebilder/agent-detect'
import {
  extractUrlIntentSignals,
  type RebilderEventV0,
  type RequesterKindV0,
  type RequesterPlatformV0,
  type ResponseCoverageV0,
  type ResponsePathV0,
  type ResponseSourceV0,
} from '@rebilder/events'
import { COMPATIBILITY_RUNTIME_VERSION, type CompatibilityProfile } from '@rebilder/render-md'
import type { GatewayConfig } from './types'

/**
 * Query parameters preserved on `request.url`. **Everything else is dropped.**
 *
 * An allowlist, not a denylist of known trackers, because the risk is not
 * `utm_*` — it is the params nobody enumerated: `?token=`, `?reset=`,
 * `?email=`, a magic-link `?code=`, and agent-supplied free text like
 * `?q=<whatever the buyer typed>`. Those land verbatim in the Console and in
 * a Pro Agent Miss Report, and ARCHITECTURE.md § Security promises events
 * carry no consumer PII. A denylist is a promise you have to keep updating; an
 * allowlist is one you keep by default.
 *
 * The six kept params are the ones that change *which document* the URL
 * identifies, so the Miss Report does not merge two genuinely different pages:
 * pagination, variant selection, and localisation. Nothing here can carry a
 * secret or a person.
 */
const ALLOWED_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'page',
  'variant',
  'sku',
  'lang',
  'locale',
  'currency',
])

/**
 * Filter a request URL down to what an event may record: scheme, host, path,
 * and allowlisted query params (lower-cased and sorted, so the same page
 * groups to one row in the Miss Report however the agent ordered them).
 *
 * Also dropped: the fragment (never sent to a server, but some auth providers'
 * magic links put access tokens there, so a constructed URL must not smuggle one
 * through) and any userinfo (`https://user:pass@host/`).
 *
 * Hot-path cost: one `indexOf`-style scan for the common no-query case, which
 * returns the original string with zero allocation; one `URL` parse otherwise.
 * A URL that will not parse is truncated at the first `?` or `#` rather than
 * recorded raw — failing closed on a string we could not inspect.
 */
export function sanitizeEventUrl(rawUrl: string): string {
  if (!rawUrl.includes('?') && !rawUrl.includes('#')) return rawUrl

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    const cut = Math.min(...[rawUrl.indexOf('?'), rawUrl.indexOf('#')].filter((i) => i >= 0))
    return rawUrl.slice(0, cut)
  }

  const kept = new URLSearchParams()
  for (const [key, value] of parsed.searchParams) {
    const name = key.toLowerCase()
    if (ALLOWED_QUERY_PARAMS.has(name)) kept.append(name, value)
  }
  kept.sort()
  const query = kept.toString()
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${query === '' ? '' : `?${query}`}`
}

/**
 * Detection kinds map 1:1 onto events-v0 requester kinds — 'crawler' is a
 * first-class kind (matching the closed set the hosted ingest service
 * enforces), so Googlebot traffic is distinguishable from humans in the
 * warehouse even though both ride the canonical-HTML serving path.
 */
function toRequesterKind(detection: DetectionResult): RequesterKindV0 {
  return detection.kind
}

/** Platform is recorded only when identifiable ('unknown' is not). */
function toRequesterPlatform(detection: DetectionResult): RequesterPlatformV0 | undefined {
  return detection.platform !== null && detection.platform !== 'unknown'
    ? detection.platform
    : undefined
}

export interface BuildEventArgs {
  profile?: CompatibilityProfile

  storeId: string
  detection: DetectionResult
  url: string
  accept?: string
  referrer?: string
  /** A declared installation probe is recorded for wiring health, not customer demand. */
  diagnostic?: boolean
  path: ResponsePathV0
  /** Measured with performance.now() around classify + render. */
  renderMs: number
  /**
   * Which configured source answered (events v0.2). Optional so callers that
   * never consult sources — and the always-markdown route handler, which
   * emits only on a match — compile and behave unchanged.
   */
  source?: ResponseSourceV0
  /** Did a configured source resolve for this URL (events v0.2)? */
  coverage?: ResponseCoverageV0
  /**
   * Protocol-path intent read off the adapter's response headers (events
   * v0.4 intent channel): tool, scrubbed query, result count. Merged OVER the
   * URL-derived signals — the adapter knows what actually ran.
   */
  protocolIntent?: Record<string, unknown>
}

export function buildEvent(args: BuildEventArgs): RebilderEventV0 {
  const platform = toRequesterPlatform(args.detection)
  return {
    event_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    store_id: args.storeId,
    requester: {
      kind: toRequesterKind(args.detection),
      ...(platform !== undefined ? { platform } : {}),
      verified: args.detection.verified,
    },
    request: {
      // Query string filtered at emission (see sanitizeEventUrl): the event
      // records which page an agent asked for. Free text never rides the URL —
      // search queries are recorded ONLY via the fail-closed scrubber inside
      // extractUrlIntentSignals (events v0.4), which reads the RAW url before
      // filtering, then drops anything that might carry a person.
      url: sanitizeEventUrl(args.url),
      intent_signals: {
        ...extractUrlIntentSignals(args.url, args.referrer),
        ...args.protocolIntent,
        ...(args.diagnostic ? { diagnostic: 'install-check' } : {}),
      },
      ...(args.accept !== undefined ? { accept: args.accept } : {}),
      ...(args.referrer !== undefined ? { referrer: args.referrer } : {}),
    },
    response: {
      path: args.path,
      ...(args.profile === undefined
        ? {}
        : {
            profile_id: args.profile.id,
            profile_version: args.profile.version,
            compatibility_runtime: COMPATIBILITY_RUNTIME_VERSION,
          }),
      render_ms: args.renderMs,
      ...(args.source !== undefined ? { source: args.source } : {}),
      ...(args.coverage !== undefined ? { coverage: args.coverage } : {}),
    },
  }
}

/**
 * Fire-and-forget emission. Never awaited; a sync throw or an async rejection
 * in the merchant's `onEvent` is swallowed and can never affect the response.
 */
export function emitEvent(config: GatewayConfig, event: RebilderEventV0): void {
  const onEvent = config.onEvent
  if (onEvent === undefined) return
  try {
    const result = onEvent(event)
    if (
      result !== undefined &&
      result !== null &&
      typeof (result as PromiseLike<void>).then === 'function'
    ) {
      void (result as PromiseLike<void>).then(undefined, () => {
        /* swallowed — observation must never break serving */
      })
    }
  } catch {
    /* swallowed — observation must never break serving */
  }
}
