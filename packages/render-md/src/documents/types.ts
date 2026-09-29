/**
 * Universal source-of-truth input types: any page that is not a product,
 * a policy set, or a catalog.
 *
 * `src/types.ts` is deliberately not edited. Commerce types stay byte-
 * identical and the commerce renderers keep their exact output; this file is
 * additive and re-exported through `src/index.ts`.
 *
 * The same guarantee as the commerce types applies to every field here: it is
 * authoritative merchant data, and the renderers only transform format. They
 * never invent, estimate, or reword a value found on these types (project
 * convention: source validation).
 *
 * Why two types (document + collection) and not one per vertical: see the
 * promotion bar in README.md. Every vertical evaluated so far reduces to
 * document-with-facts, and a vertical that ships as vocabulary rather than as
 * a type is a vertical we can add without a release.
 */

import type { Money } from '../types' // reused verbatim

export type BillingPeriod = 'one_time' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year'
export type Weekday =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday'

/** 24-hour local times, 'HH:MM'. Validated; malformed → the fact is dropped. */
export interface HoursInterval {
  opens: string
  closes: string
}

/**
 * One weekday. `intervals: []` means CLOSED that day. A weekday absent from
 * `weekly` renders as "Not stated" — a different fact from "Closed".
 * Overnight spans are expressed as two intervals on two days; a single
 * interval where closes <= opens is rejected as malformed.
 */
export interface HoursRule {
  day: Weekday
  intervals: HoursInterval[]
}

export interface HoursException {
  /** 'YYYY-MM-DD', validated. */
  date: string
  closed?: boolean
  intervals?: HoursInterval[]
  /** Verbatim. */
  note?: string
}

export interface HoursSpec {
  weekly: HoursRule[]
  exceptions?: HoursException[]
  /** IANA zone. REQUIRED — hours without a zone are an ambiguous fact. */
  timeZone: string
  /** Verbatim. */
  note?: string
}

/**
 * The value of one fact. Closed union; every member has a deterministic,
 * locale-free rendering.
 */
export type FactValue =
  | { type: 'text'; value: string }
  | { type: 'list'; value: string[] }
  /** String(value). Rejects non-finite and exponential-form values. */
  | { type: 'number'; value: number; unit?: string }
  /** Fixed label map { true: 'Yes', false: 'No' }. */
  | { type: 'boolean'; value: boolean }
  /**
   * Through formatMoney (throws rather than rounds). maxValue renders a range;
   * period appends a fixed suffix; per appends verbatim text.
   * Throws if maxValue.currency !== value.currency or maxValue < value.
   */
  | { type: 'money'; value: Money; maxValue?: Money; period?: BillingPeriod; per?: string }
  /** ISO 8601 date or datetime, validated. Emitted verbatim. */
  | { type: 'date'; value: string }
  /** [label](value) or the bare URL. Scheme allowlist enforced. */
  | { type: 'url'; value: string; label?: string }
  /** Markdown table. Never computes "open now" — that is the agent's job. */
  | { type: 'hours'; value: HoursSpec }

export interface Fact {
  label: string
  value: FactValue
  note?: string
}

/** Advisory routing/telemetry label. NEVER rendered into markdown. */
export type DocumentKind =
  | 'page'
  | 'service'
  | 'location'
  | 'plan'
  | 'article'
  | 'faq'
  | 'profile'
  | 'event'
  | 'listing'
  | 'job'
  | 'course'
  // `string & {}` keeps editor completion for the known kinds while still
  // accepting any merchant-supplied string. TypeScript has no other spelling
  // for that today.
  | (string & {})

/**
 * Contact details as published on the canonical page. See the PII note in
 * README.md: this type plus kind 'profile'/'job' makes it trivial to serve
 * named individuals' contact details in bulk, and the merchant is the
 * controller for that data.
 */
export interface ContactSource {
  phone?: string
  email?: string
  url?: string
  /** Display order, verbatim. */
  address?: string[]
}

/** Advisory only, exactly like `DocumentKind` — never rendered into markdown. */
export type ActionKind =
  | 'book'
  | 'apply'
  | 'contact'
  | 'purchase'
  | 'subscribe'
  | 'download'
  | 'quote'
  | 'other'
  | (string & {}) // open union, as DocumentKind above

export interface ActionSource {
  /** Verbatim. */
  label: string
  url: string
  /** Advisory only; not rendered. */
  kind?: ActionKind
  note?: string
}

export interface DocumentSectionSource {
  heading?: string
  body: string
}

export interface LinkSource {
  title: string
  url: string
  note?: string
}

/**
 * Access level of this document's prose, as the merchant's own access control
 * sees it. The renderer emits `sections` ONLY when access === 'free'.
 * Anything else emits summary + facts + actions + an access notice.
 * This is mechanical, not a prose rule: no renderer bug can leak a paywalled
 * body, and the merchant cannot accidentally over-serve one.
 */
export type DocumentAccess = 'free' | 'registered' | 'metered' | 'subscriber'

export interface DocumentSource {
  url: string
  title: string
  /** Advisory only; not rendered. */
  kind?: DocumentKind
  /** Verbatim, rendered as a blockquote. */
  summary?: string
  /** ISO 8601, verbatim. */
  updated?: string
  /** Default 'free'. */
  access?: DocumentAccess
  /** THE front-loaded block. Order is authoritative. Capped at 60 facts. */
  facts?: Fact[]
  /** Capped at 20. Never truncated. */
  actions?: ActionSource[]
  contact?: ContactSource
  /** Prose. Emitted only when access === 'free'. Truncatable. */
  sections?: DocumentSectionSource[]
  /** Cross-links. Last in the tail; FIRST to be dropped. */
  related?: LinkSource[]
  /**
   * Set by hosted extraction only. When present the gateway refuses to serve
   * the document past `ttlSeconds` and falls through to HTML. A snapshot is
   * not a source of truth: without this, a merchant changes their hours and
   * agents keep receiving the approved bundle — different substance to agents
   * and humans at the same URL, which is a consistent source content breach manufactured by
   * our own pipeline. Enforced by the gateway, not by this package.
   */
  provenance?: { capturedAt: string; contentSha256: string; ttlSeconds: number }
}

export interface CollectionItemSource {
  url: string
  title: string
  summary?: string
  /** Become table columns. */
  facts?: Fact[]
}

export interface CollectionSource {
  /**
   * Canonical URL of the listing itself. Required — an agent must be able to
   * resolve which page it is reading, and llms.txt needs a target.
   */
  url: string
  /** Defaults to the fixed 'Contents' label. */
  title?: string
  /** Capped at 500 rendered rows; column union capped at 12. */
  items: CollectionItemSource[]
  /**
   * When this listing last changed, ISO 8601, verbatim. Same field name and
   * validation as `DocumentSource.updated` and `ProductSource.updated`.
   * Emitted as `dateModified` by `renderCollectionJsonLd`; the markdown
   * renderer does not render it, and did not before this field existed.
   */
  updated?: string
  /** BCP 47 language tag, verbatim. Emitted as `inLanguage`. Malformed → dropped. */
  language?: string
}
