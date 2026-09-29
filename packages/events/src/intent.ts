/**
 * Intent-signal extraction — the shared, zero-dependency implementation every
 * emitter uses to populate `request.intent_signals` (schema v0.4).
 *
 * `intent_signals` stays `Record<string, unknown>` in the type contract (open
 * shape, additive forever). This module defines the WELL-KNOWN KEYS and the
 * only sanctioned way to produce them, so the gateway, the protocol adapters,
 * and any platform app emit identical shapes:
 *
 *   - `query`             — free-text search the requester sent to THIS store
 *                           (a `?q=` style param, or a protocol search tool's
 *                           argument), after `scrubQueryText`.
 *   - `query_param`       — where the query came from (`'q'`, `'s'`, … or a
 *                           protocol tool name like `'mcp.search_catalog'`).
 *   - `referrer_platform` — AI platform classified from the Referer header
 *                           (`'chatgpt'`, `'perplexity'`, …). On a HUMAN
 *                           request this is the "AI sent this visitor" signal.
 *   - `utm_source` / `utm_medium` — sanitized campaign params (agents and AI
 *                           platforms increasingly stamp `utm_source=chatgpt.com`).
 *   - `tool`              — protocol tool/operation name (protocol path only).
 *   - `result_count`      — result count for a search-shaped request; `0` is
 *                           the "demand you could not answer" signal.
 *
 * PII stance (ARCHITECTURE.md § Security & Trust): events carry no consumer
 * PII beyond what the merchant already lawfully processes. A search string a
 * buyer's agent sends to the merchant's own store is merchant site-search
 * analytics — but free text CAN carry a person, so `scrubQueryText` FAILS
 * CLOSED: a string that trips any PII pattern is dropped entirely, never
 * partially redacted (a redacted string invites guessing at what was removed).
 * `request.url` remains allowlist-filtered at emission — queries live HERE,
 * never in the recorded URL, so Miss-Report grouping and the no-secrets URL
 * guarantee are unchanged.
 */

/** Longest query recorded. Longer strings smell like pasted content or tokens — dropped. */
export const INTENT_QUERY_MAX_LENGTH = 200

/**
 * Query params treated as site search, in priority order (first match wins).
 * `s` is WordPress's canonical search param; `q` covers most everything else.
 */
export const SEARCH_QUERY_PARAMS: readonly string[] = [
  'q',
  'query',
  'search',
  's',
  'keyword',
  'term',
]

/**
 * Referer hostname → AI platform. Suffix-matched per registrable domain.
 * Open set downstream (the value is a plain string in the event) — additions
 * here are additive, exactly like `RequesterPlatformV0`.
 */
const REFERRER_PLATFORMS: readonly (readonly [string, string])[] = [
  ['chatgpt.com', 'chatgpt'],
  ['chat.openai.com', 'chatgpt'],
  ['perplexity.ai', 'perplexity'],
  ['claude.ai', 'claude'],
  ['gemini.google.com', 'gemini'],
  ['bard.google.com', 'gemini'],
  ['copilot.microsoft.com', 'copilot'],
  ['meta.ai', 'meta'],
  ['grok.com', 'grok'],
  ['x.ai', 'grok'],
  ['chat.mistral.ai', 'mistral'],
  ['you.com', 'you'],
]

/** UTM values: lowercase, short, and shaped like a label — anything else is dropped. */
const UTM_VALUE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

// PII patterns — any hit drops the whole query (fail closed).
const EMAIL_OR_HANDLE = /@/ // emails, and @handles add nothing to commerce search
const LONG_DIGIT_RUN = /\d{7,}/ // phone numbers, order numbers, card fragments
const TOKEN_LIKE = /[A-Za-z0-9_-]{24,}/ // JWT/base64/hex fragments, magic-link codes
const URL_IN_QUERY = /:\/\// // pasted links can carry anything

/**
 * Normalize then screen a free-text search string. Returns the recordable
 * query, or `null` when the string must not be recorded. Deterministic and
 * pure — same discipline as every other emission-path function.
 */
export function scrubQueryText(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return null
  if (collapsed.length > INTENT_QUERY_MAX_LENGTH) return null
  if (EMAIL_OR_HANDLE.test(collapsed)) return null
  if (URL_IN_QUERY.test(collapsed)) return null
  // Strip common phone separators before the digit-run check so
  // "07 700 900 123" and "(770) 090-0123" are caught, not just "0770090012".
  const digitsJoined = collapsed.replace(/[\s().+-]/g, '')
  if (LONG_DIGIT_RUN.test(digitsJoined)) return null
  if (TOKEN_LIKE.test(collapsed)) return null
  return collapsed
}

/**
 * Classify a Referer header (full URL or bare hostname) to an AI platform.
 * Returns `null` for anything unrecognized — including search engines and
 * social, which are someone else's analytics category, not ours.
 */
export function classifyReferrerPlatform(referrer: string): string | null {
  let hostname: string
  try {
    hostname = new URL(referrer).hostname.toLowerCase()
  } catch {
    // Bare hostnames ("chatgpt.com") appear in the wild; a string with no
    // scheme that still isn't host-shaped classifies as nothing.
    const bare = referrer.trim().toLowerCase()
    if (!/^[a-z0-9.-]+$/.test(bare)) return null
    hostname = bare
  }
  for (const [domain, platform] of REFERRER_PLATFORMS) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return platform
  }
  return null
}

/**
 * Extract every intent signal observable from a request URL + Referer header.
 * Returns `{}` when there is nothing to record — the emission-path contract is
 * that `intent_signals` is always an object, never null/undefined.
 */
export function extractUrlIntentSignals(
  rawUrl: string,
  referrer?: string,
): Record<string, unknown> {
  const signals: Record<string, unknown> = {}

  let parsed: URL | null = null
  try {
    parsed = new URL(rawUrl)
  } catch {
    parsed = null // unparseable URL → no URL-derived signals; referrer still runs
  }

  if (parsed !== null) {
    const params = parsed.searchParams
    for (const name of SEARCH_QUERY_PARAMS) {
      const value = params.get(name)
      if (value === null || value === '') continue
      const query = scrubQueryText(value)
      if (query !== null) {
        signals['query'] = query
        signals['query_param'] = name
      }
      break // first present search param decides; a scrubbed drop stays dropped
    }
    for (const key of ['utm_source', 'utm_medium'] as const) {
      const value = params.get(key)
      if (value === null) continue
      const cleaned = value.trim().toLowerCase()
      if (UTM_VALUE_PATTERN.test(cleaned)) signals[key] = cleaned
    }
  }

  if (referrer !== undefined && referrer !== '') {
    const platform = classifyReferrerPlatform(referrer)
    if (platform !== null) signals['referrer_platform'] = platform
  }

  return signals
}

/**
 * The protocol-path variant: tool name plus optional query/result count.
 * Query text goes through the same scrubber as URL params — a search string
 * is a search string regardless of which door it arrived through.
 */
export function buildProtocolIntentSignals(args: {
  tool: string
  query?: string
  resultCount?: number
}): Record<string, unknown> {
  const signals: Record<string, unknown> = { tool: args.tool }
  if (args.query !== undefined) {
    const query = scrubQueryText(args.query)
    if (query !== null) {
      signals['query'] = query
      signals['query_param'] = args.tool
    }
  }
  if (args.resultCount !== undefined && Number.isInteger(args.resultCount) && args.resultCount >= 0) {
    signals['result_count'] = args.resultCount
  }
  return signals
}

// ---------------------------------------------------------------------------
// The intent header channel (protocol path).
//
// A protocol adapter knows the tool, the query, and the result count; the
// emitter that owns the event (the gateway when mounted through it, the
// standalone handler otherwise) does not. The channel between them is a set
// of response headers. They live in THIS package because the gateway and the
// protocol adapters both already depend on it, and `@rebilder/gateway` must
// never depend on `@rebilder/protocols` (a project convention).
//
// The gateway reads and STRIPS them before the response leaves; a standalone
// protocol mount leaves them on the wire, where they are a documented,
// harmless observability surface (they only ever echo what the client sent
// plus a count that is visible in the body anyway).
// ---------------------------------------------------------------------------

export const INTENT_HEADER_TOOL = 'x-rebilder-intent-tool'
export const INTENT_HEADER_QUERY = 'x-rebilder-intent-query'
export const INTENT_HEADER_RESULTS = 'x-rebilder-intent-results'

const INTENT_HEADER_NAMES = [
  INTENT_HEADER_TOOL,
  INTENT_HEADER_QUERY,
  INTENT_HEADER_RESULTS,
] as const

/** Header-value safety for the tool name: our own identifiers only. */
const TOOL_NAME_PATTERN = /^[a-z0-9._-]{1,64}$/i

/**
 * Stamp intent signals onto a response's headers. The query is stamped
 * URI-encoded (header values must stay ASCII) and only if it passed
 * `scrubQueryText` inside `buildProtocolIntentSignals` — pass this function
 * that builder's output, never raw input.
 */
export function stampIntentSignalHeaders(
  headers: Headers,
  signals: Record<string, unknown>,
): void {
  const tool = signals['tool']
  if (typeof tool === 'string' && TOOL_NAME_PATTERN.test(tool)) {
    headers.set(INTENT_HEADER_TOOL, tool)
  }
  const query = signals['query']
  if (typeof query === 'string') {
    headers.set(INTENT_HEADER_QUERY, encodeURIComponent(query))
  }
  const resultCount = signals['result_count']
  if (typeof resultCount === 'number' && Number.isInteger(resultCount) && resultCount >= 0) {
    headers.set(INTENT_HEADER_RESULTS, String(resultCount))
  }
}

/**
 * Read intent signals back off a response's headers. The query is re-screened
 * through `scrubQueryText` after decoding — the reader never trusts that the
 * writer was this package.
 */
export function readIntentSignalHeaders(headers: Headers): Record<string, unknown> {
  const signals: Record<string, unknown> = {}
  const tool = headers.get(INTENT_HEADER_TOOL)
  if (tool !== null && TOOL_NAME_PATTERN.test(tool)) signals['tool'] = tool

  const rawQuery = headers.get(INTENT_HEADER_QUERY)
  if (rawQuery !== null) {
    let decoded: string | null = null
    try {
      decoded = decodeURIComponent(rawQuery)
    } catch {
      decoded = null // malformed encoding → fail closed
    }
    if (decoded !== null) {
      const query = scrubQueryText(decoded)
      if (query !== null && typeof signals['tool'] === 'string') {
        signals['query'] = query
        signals['query_param'] = signals['tool']
      }
    }
  }

  const rawCount = headers.get(INTENT_HEADER_RESULTS)
  if (rawCount !== null && /^\d{1,9}$/.test(rawCount)) {
    signals['result_count'] = Number(rawCount)
  }
  return signals
}

/** Remove the channel headers — the gateway calls this before a response leaves. */
export function stripIntentSignalHeaders(headers: Headers): void {
  for (const name of INTENT_HEADER_NAMES) headers.delete(name)
}
