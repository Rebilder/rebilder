/**
 * The v0 event type contract — THE observation-layer schema. FROZEN: changes
 * are versioned and additive only (project convention); removing a field
 * requires a migration note in this package's CHANGELOG.
 */

/** Who made the request. */
export type RequesterKindV0 = 'agent' | 'human' | 'protocol' | 'crawler'

/**
 * Agent platform, when identifiable. Open set: the known platforms get
 * literal types (autocomplete), but any newly observed platform string is
 * valid — additions here are additive schema changes, not breaking ones.
 */
export type RequesterPlatformV0 = 'chatgpt' | 'gemini' | 'claude' | 'perplexity' | (string & {})

/**
 * Which serving path answered the request (ARCHITECTURE.md § The Compiler).
 *
 * ADDITIVE v0.3 — `'denied'`: the merchant's own agent access policy refused
 * this request, so the gateway answered 403 (or 429 for a rate limit) and the
 * merchant's pipeline never ran.
 *
 * A denial is a serving path rather than a flag on another one, because it is
 * the only path where the merchant's site did NOT serve the request. Folding it
 * into `'html-variant'` would make every "agents that reached your site" figure
 * silently include the ones that were turned away — a merchant tightening a
 * policy would watch their agent traffic hold steady while nobody was getting
 * through.
 *
 * Consumers with an exhaustive switch over this union get a compile error when
 * they upgrade, which is the intended way to find out.
 */
export type ResponsePathV0 = 'markdown' | 'html-variant' | 'protocol' | 'denied'

/**
 * ADDITIVE v0.2 — which configured source answered the request.
 *
 * The five literals mirror `SourceKind` in `@rebilder/gateway` (product,
 * policies, catalog, document, collection) and `'none'` means the markdown
 * path ran and no configured resolver returned data. The literals are
 * duplicated rather than imported on purpose: `@rebilder/events` has zero
 * dependencies (it is the observation contract every side implements, not a
 * gateway satellite), and a new gateway source kind is an additive change
 * here, not a breaking one — hence the open `(string & {})` tail.
 */
export type ResponseSourceV0 =
  | 'product'
  | 'policies'
  | 'catalog'
  | 'document'
  | 'collection'
  | 'none'
  | (string & {})

/**
 * ADDITIVE v0.2 — did a configured source resolve for this URL?
 *
 * - `'sourced'`         — an agent asked for markdown and a source answered.
 * - `'unsourced'`       — an agent asked for markdown and EVERY configured
 *   resolver returned null. This single bit is the entire Agent Miss Report:
 *   the request that a site could not answer for an agent.
 * - `'not-applicable'`  — the markdown path was never attempted (humans,
 *   crawlers, protocol routes). Distinct from `'unsourced'`: a human getting
 *   HTML is not a miss.
 *
 * `coverage` is deliberately independent of {@link ResponsePathV0}: a miss is
 * emitted with `path: 'html-variant'` (the gateway passed through to the
 * merchant's HTML), so `path` alone cannot distinguish "human got HTML" from
 * "agent asked for markdown and got nothing".
 */
export type ResponseCoverageV0 = 'sourced' | 'unsourced' | 'not-applicable'

export interface RebilderEventRequesterV0 {
  kind: RequesterKindV0
  /** Present when the platform is identifiable (headers/signature/UA). */
  platform?: RequesterPlatformV0
  /** True only for cryptographically verified agents (Web Bot Auth / Signature-Agent). */
  verified: boolean
}

export interface RebilderEventRequestV0 {
  url: string
  /** Intent signals extracted from query/referrer/agent payload. Shape intentionally open in v0. */
  intent_signals: Record<string, unknown>
  /** Raw Accept header, when present (e.g. 'text/markdown'). */
  accept?: string
  referrer?: string
}

/**
 * What was served.
 *
 * **`status` (the upstream HTTP status) is deliberately absent and must not be
 * re-proposed as a field.** The gateway's `handleRequest` emits and returns
 * `Promise<Response | null>` *before* the merchant's own handler runs, so it
 * never observes the upstream status. Capturing it would mean wrapping and
 * buffering the downstream response — a breaking change to the public SDK
 * contract, on the HTML path, which is 100% of human traffic. If we ever want
 * it, it is its own design, not a field. (CHANGELOG 0.2.0.)
 */
export interface RebilderEventResponseV0 {
  /** Actual compiled-in presentation served; not a downstream AI model identity. */
  profile_id?: string
  profile_version?: number
  compatibility_runtime?: number

  path: ResponsePathV0
  /** Set when path is 'html-variant': the served variant. */
  variant_id?: string
  /** Server-side render/serve time in milliseconds (edge budget: p95 < 50ms). */
  render_ms: number
  /**
   * ADDITIVE v0.2. Which source answered — 'none' when the markdown path ran
   * and nothing matched. Absent when the markdown path was never attempted.
   */
  source?: ResponseSourceV0
  /** ADDITIVE v0.2. Did a configured source resolve for this URL? */
  coverage?: ResponseCoverageV0
}

/**
 * Outcome facts joined asynchronously (citation checks, referral attribution,
 * order webhooks) — absent at emission time, attached later in the warehouse.
 */
export interface RebilderEventOutcomeV0 {
  cited?: boolean
  referred?: boolean
  add_to_cart?: boolean
  purchase?: boolean
  /** Explicit merchant/platform reports, never inferred from a request or a handoff link. */
  booking?: boolean
  quote?: boolean
  action_completed?: boolean
  /** Use these paired fields for unambiguous monetary reporting. Legacy order_value is not normalized. */
  order_value_minor?: number
  currency?: string
  /** Order value in the store's currency minor units or as reported by the merchant platform. */
  order_value?: number
}

/**
 * The v0 core event — transcribed from ARCHITECTURE.md § Events.
 * This is the contract the ingest SQL and gateway emission implement.
 */
export interface RebilderEventV0 {
  /** Globally unique event id (idempotency key through the queue). */
  event_id: string
  /** Event timestamp, ISO 8601 UTC. */
  ts: string
  store_id: string
  requester: RebilderEventRequesterV0
  request: RebilderEventRequestV0
  response: RebilderEventResponseV0
  /** Joined async; never present at edge emission time. */
  outcome?: RebilderEventOutcomeV0
}
