/**
 * extract.ts — pass 2 of the ARS pipeline: turn one fetched representation into
 * a set of normalised fact observations, scored against the resolved page-kind
 * profile (design §3.5, §3.6).
 *
 * WHAT A "REPRESENTATION" IS. The probe returns two captures that differ only in
 * their `Accept` header (§3.3). Each one is turned into an `ArsRepresentation`:
 * a decoded body, its byte length as the probe measured it, the tokenized
 * document when the bytes are HTML, the JSON-LD blocks, and the counted text.
 * Everything downstream reads a representation, never a raw capture, so the
 * markdown path and the HTML path go through the same scoring code.
 *
 * WHICH REPRESENTATION SCORES WHAT — the decision that makes the golden pair
 * (`001-pdp-gateway-md` vs `002-pdp-raw-html`) mean anything:
 *
 *   D3 (coverage) and D4 (position) score the AGENT representation, because ARS
 *   measures what a caller actually receives. A merchant whose markdown omits
 *   `availability` loses coverage even though the HTML declares it — the agent
 *   never saw it.
 *
 *   D1.3 (render independence) and D5 (structured data) score the HTML
 *   representation, because those checks are about the document a caller that
 *   only reads HTML gets. JSON-LD does not live in markdown, and "would this
 *   page work without JavaScript" is a question about HTML.
 *
 * CORROBORATION CROSSES THE TWO. §3.6 defines corroborated as "observed in ≥2
 * sources (e.g. JSON-LD and visible text)". A price stated in the negotiated
 * markdown *and* in the HTML's JSON-LD is observed in two sources and is
 * corroborated; that is the only reason a correctly installed gateway can reach
 * an A. But a fact observed ONLY in the HTML does not enter the scored fact set
 * at all — corroboration strengthens a fact the agent received, it never
 * conjures one it did not. See `mergeFacts`.
 *
 * VALUE FACTS vs PRESENCE FACTS. Some facts are compared by value (a price, a
 * title, a phone number); others are only ever "declared or not" (shipping,
 * returns, opening hours, question/answer shape). Presence facts normalise to
 * the literal string `declared` from EVERY source, deliberately: two sources
 * that describe the same shipping policy in different words must still
 * corroborate each other, and a free-text comparison would make that
 * non-deterministic. The split is pinned in `PRESENCE_FACTS` below and printed
 * in the spec, because it is the difference between "we compared the values" and
 * "we compared whether you said anything".
 *
 * EVERYTHING HERE IS PINNED DATA, NOT INFERENCE. The label lexicon, the
 * availability vocabulary, the no-published-price phrases, the schema.org
 * property aliases: all tables, all versioned. An extractor that guessed would
 * make `score()` non-reproducible in a second implementation, which is the one
 * property the whole package exists to provide.
 */

import { attr, countedText, elementText, tokenizeHtml } from './html'
import type { HtmlDocument } from './html'
import { parseMoneyText } from './parse-money'
import type {
  ArsAudience,
  ArsAudienceDecision,
  ArsFactKind,
  ArsFactObservation,
  ArsFactProfile,
  ArsHttpCapture,
  ArsPolicyReport,
  ArsRuleset,
} from './types'

// ---------------------------------------------------------------------------
// UTF-8 offsets
// ---------------------------------------------------------------------------

/**
 * UTF-8 byte length of a JavaScript string, counting a lone surrogate as 3
 * bytes — the width WHATWG encoding gives U+FFFD, which is what a lone
 * surrogate actually costs on the wire. Matches `Utf8Cursor` in `./html`, which
 * is why offsets from the two files are in the same address space.
 */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

/** A flattened JSON-LD node: one object with an `@type`, wherever it was nested. */
export interface JsonLdNode {
  /** `@type` values with any `http(s)://schema.org/` prefix stripped. Always ≥1 entry. */
  readonly types: readonly string[]
  readonly value: Readonly<Record<string, unknown>>
  /** UTF-8 byte offset of the block the node came from. */
  readonly offset: number
}

/** What `parseJsonLd` observed, including the blocks that failed — D5.1 scores both. */
export interface JsonLdReport {
  readonly nodes: readonly JsonLdNode[]
  readonly blocks: number
  readonly parsed: number
}

const SCHEMA_PREFIX = /^https?:\/\/schema\.org\//

function stripSchemaPrefix(type: string): string {
  return type.replace(SCHEMA_PREFIX, '')
}

/** Types from a node's `@type`, which may be a string or an array of strings. */
function typesOf(value: Record<string, unknown>): string[] {
  const raw = value['@type']
  if (typeof raw === 'string') return [stripSchemaPrefix(raw)]
  if (Array.isArray(raw)) {
    const out: string[] = []
    for (const entry of raw) if (typeof entry === 'string') out.push(stripSchemaPrefix(entry))
    return out
  }
  return []
}

/** Depth cap on JSON-LD traversal. Deeper than any real graph; stops a hostile nesting bomb. */
const JSON_LD_MAX_DEPTH = 12

function collectNodes(
  value: unknown,
  offset: number,
  depth: number,
  out: JsonLdNode[],
  seen: Set<object>,
): void {
  if (depth > JSON_LD_MAX_DEPTH || value === null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)

  if (Array.isArray(value)) {
    for (const entry of value) collectNodes(entry, offset, depth + 1, out, seen)
    return
  }

  const record = value as Record<string, unknown>
  const types = typesOf(record)
  if (types.length > 0) out.push({ types, value: record, offset })

  for (const [key, child] of Object.entries(record)) {
    if (key === '@context') continue
    collectNodes(child, offset, depth + 1, out, seen)
  }
}

/**
 * Parses every JSON-LD block. A block that does not parse is counted and
 * dropped: D5.1 scores "present **and parses**", so fixture `033-invalid-jsonld`
 * needs the block count and the parsed count to differ.
 */
export function parseJsonLd(blocks: readonly { text: string; offset: number }[]): JsonLdReport {
  const nodes: JsonLdNode[] = []
  let parsed = 0
  for (const block of blocks) {
    let value: unknown
    try {
      value = JSON.parse(block.text) as unknown
    } catch {
      continue
    }
    parsed++
    collectNodes(value, block.offset, 0, nodes, new Set<object>())
  }
  return { nodes, blocks: blocks.length, parsed }
}

/**
 * Reads a dotted property path off a node, entering array members: `offers.price`
 * matches `offers[0].price`. Returns the first non-empty scalar found, or null.
 * The notation is the one `DEFAULT_RULESET.requiredProperties` is written in.
 */
export function readPath(node: JsonLdNode, path: string): string | null {
  const segments = path.split('.')
  let frontier: unknown[] = [node.value]
  for (const segment of segments) {
    const next: unknown[] = []
    for (const current of frontier) {
      if (current === null || typeof current !== 'object') continue
      if (Array.isArray(current)) {
        for (const entry of current) {
          if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
            const child = (entry as Record<string, unknown>)[segment]
            if (child !== undefined) next.push(child)
          }
        }
        continue
      }
      const child = (current as Record<string, unknown>)[segment]
      if (child !== undefined) next.push(child)
    }
    frontier = next
    if (frontier.length === 0) return null
  }
  for (const found of frontier) {
    const scalar = scalarOf(found)
    if (scalar !== null) return scalar
  }
  return null
}

/**
 * A scalar reading of a JSON-LD value. Objects yield their `name`, `@id` or
 * `value` — `brand: {"@type":"Brand","name":"X"}` is the common real shape and
 * refusing to read it would cost merchants points for correct markup.
 */
function scalarOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim().length > 0 ? value.trim() : null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    for (const entry of value) {
      const scalar = scalarOf(entry)
      if (scalar !== null) return scalar
    }
    return null
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['name', 'value', '@id', 'url', 'headline']) {
      const scalar = scalarOf(record[key])
      if (scalar !== null) return scalar
    }
  }
  return null
}

/** True when the path resolves to anything at all — what D5.2 counts. */
export function hasPath(node: JsonLdNode, path: string): boolean {
  return readPath(node, path) !== null
}

// ---------------------------------------------------------------------------
// Representations
// ---------------------------------------------------------------------------

export type ArsRepresentationKind = 'html' | 'markdown' | 'text' | 'json' | 'other'

export interface ArsRepresentation {
  /** Classified from the `Content-Type` header alone. See `looksLikeHtml` for the body's opinion. */
  readonly kind: ArsRepresentationKind
  /** Lowercased media type without parameters, or null when the header is absent. */
  readonly contentType: string | null
  /** The decoded body. */
  readonly body: string
  /** Byte length AS THE PROBE MEASURED IT (`ArsHttpCapture.bytes`), not recomputed. */
  readonly bytes: number
  /** Tokenized document, present whenever the bytes are HTML however they are labelled. */
  readonly doc: HtmlDocument | null
  readonly jsonLd: JsonLdReport
  /** Counted text (§3.6) for HTML; the body itself for every other kind. */
  readonly text: string
  /** The body's own opinion, independent of the header. D2.1 scores the disagreement. */
  readonly looksLikeHtml: boolean
  readonly truncated: boolean
  readonly finalUrl: string
  readonly headers: Readonly<Record<string, readonly string[]>>
}

/** First value of a header, or null. Header names are lowercased by the probe. */
export function header(
  headers: Readonly<Record<string, readonly string[]>>,
  name: string,
): string | null {
  const values = headers[name]
  return values !== undefined && values.length > 0 ? (values[0] ?? null) : null
}

/** All values of a header, in order. `Link` is routinely repeated and is scored twice over. */
export function headerAll(
  headers: Readonly<Record<string, readonly string[]>>,
  name: string,
): readonly string[] {
  return headers[name] ?? []
}

/** Media type without parameters, lowercased. */
export function mediaType(contentType: string | null): string | null {
  if (contentType === null) return null
  const semi = contentType.indexOf(';')
  const value = (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase()
  return value.length > 0 ? value : null
}

function classifyMediaType(type: string | null): ArsRepresentationKind {
  if (type === null) return 'other'
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  if (type === 'text/markdown' || type === 'text/x-markdown') return 'markdown'
  if (type === 'text/plain') return 'text'
  if (type === 'application/json' || type === 'application/ld+json' || type.endsWith('+json')) {
    return 'json'
  }
  return 'other'
}

/**
 * Does the body look like HTML regardless of what the header claims? Bounded to
 * the first 1 KiB so the test is O(1) on a 2 MiB body. Fixture
 * `036-negotiation-wrong-content-type` is exactly the case where the header and
 * this function disagree, and D2.1 pays for it.
 */
function bodyLooksLikeHtml(body: string): boolean {
  const head = body.slice(0, 1024).trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml')
    ? true
    : head.includes('<html') || head.includes('<head>') || head.includes('<body')
}

/**
 * Builds a representation from a capture. Returns null when the body is absent:
 * `ArsHttpCapture.body` is optional because a PUBLISHED evidence bundle carries
 * the hash and not the bytes (§3.9), and a bundle without bytes cannot be
 * re-scored — `score()` reports `unscored / evidence-incomplete` rather than
 * inventing a zero.
 */
export function buildRepresentation(capture: ArsHttpCapture): ArsRepresentation | null {
  if (typeof capture.body !== 'string') return null
  const contentType = mediaType(header(capture.headers, 'content-type'))
  const declared = classifyMediaType(contentType)
  const looksLikeHtml = bodyLooksLikeHtml(capture.body)

  // Tokenize whenever the BYTES are HTML, whatever the header says. A merchant
  // with a mislabelled content type already loses 10 points on D2.1; taking
  // their fact coverage as well would charge them twice for one mistake.
  const doc = declared === 'html' || looksLikeHtml ? tokenizeHtml(capture.body) : null

  const jsonLd =
    doc !== null
      ? parseJsonLd(doc.jsonLd.map((block) => ({ text: block.text, offset: block.offset })))
      : declared === 'json'
        ? parseJsonLd([{ text: capture.body, offset: 0 }])
        : { nodes: [], blocks: 0, parsed: 0 }

  return {
    kind: declared,
    contentType,
    body: capture.body,
    bytes: capture.bytes,
    doc,
    jsonLd,
    text: doc !== null ? countedText(doc) : capture.body,
    looksLikeHtml,
    truncated: capture.truncated,
    finalUrl: capture.finalUrl,
    headers: capture.headers,
  }
}

// ---------------------------------------------------------------------------
// Facts — the internal shape
// ---------------------------------------------------------------------------

export type ArsFactSource = ArsFactObservation['source']

/**
 * One observation before merging. `qualified` and `element` are internal:
 * `ArsFactObservation` (§3.9) carries neither, and this file exists to keep the
 * published shape exactly as the design wrote it.
 */
export interface ExtractedFact {
  readonly kind: ArsFactKind
  readonly normalized: string
  readonly source: ArsFactSource
  readonly offset: number
  /** True for ranges and qualifiers. Excluded from the D2.4 parity comparison (§3.11). */
  readonly qualified: boolean
}

/** A merged fact: the published observation plus what merging learned. */
export interface MergedFact extends ArsFactObservation {
  readonly qualified: boolean
  /** Distinct sources that reported THIS value. `corroborated` is `length >= 2`. */
  readonly sources: readonly ArsFactSource[]
}

/**
 * Source precedence, used only to break an offset tie. Declaration order is the
 * order of the union in §3.9, so a second implementation reads it off the
 * published type rather than out of this file.
 */
const SOURCE_ORDER: readonly ArsFactSource[] = [
  'json-ld',
  'microdata',
  'meta',
  'html-text',
  'negotiated',
]

/**
 * Facts that are only ever "declared or not". Every source normalises them to
 * the literal `declared`, so two sources that word the same shipping policy
 * differently still corroborate one another. See the file header.
 */
const PRESENCE_FACTS: ReadonlySet<ArsFactKind> = new Set<ArsFactKind>([
  'shipping',
  'returns',
  'hours',
  'service-area',
  'eligibility',
  'question-answer',
  'item-link',
])

const DECLARED = 'declared'

/**
 * Merges observations into the published fact set.
 *
 * `primary` is the representation the agent received; `corroborating` is the
 * other one. A fact appears in the output only if the AGENT saw it. The
 * representative observation is the one with the lowest byte offset (ties broken
 * by `SOURCE_ORDER`, then lexicographically by value) — lowest offset, because
 * D4.1 scores the byte offset at which a fact first becomes available.
 * `corroborated` counts the distinct sources, across BOTH representations, that
 * reported the representative's exact normalised value; a source reporting a
 * different value corroborates nothing, which is what makes fixture
 * `034-jsonld-price-mismatch` fail to corroborate rather than agree.
 */
export function mergeFacts(
  primary: readonly ExtractedFact[],
  corroborating: readonly ExtractedFact[],
): MergedFact[] {
  const byKind = new Map<ArsFactKind, ExtractedFact[]>()
  for (const fact of primary) {
    const list = byKind.get(fact.kind)
    if (list === undefined) byKind.set(fact.kind, [fact])
    else list.push(fact)
  }

  const merged: MergedFact[] = []
  for (const [kind, observations] of byKind) {
    const representative = observations.reduce((best, candidate) =>
      betterObservation(best, candidate),
    )
    const sources: ArsFactSource[] = []
    for (const fact of [...observations, ...corroborating]) {
      if (fact.kind !== kind) continue
      if (fact.normalized !== representative.normalized) continue
      if (!sources.includes(fact.source)) sources.push(fact.source)
    }
    merged.push({
      kind,
      normalized: representative.normalized,
      source: representative.source,
      offset: representative.offset,
      corroborated: sources.length >= 2,
      qualified: representative.qualified,
      sources,
    })
  }

  merged.sort((a, b) => (a.offset === b.offset ? cmp(a.kind, b.kind) : a.offset - b.offset))
  return merged
}

function betterObservation(a: ExtractedFact, b: ExtractedFact): ExtractedFact {
  if (a.offset !== b.offset) return a.offset < b.offset ? a : b
  const rank = SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source)
  if (rank !== 0) return rank < 0 ? a : b
  return cmp(a.normalized, b.normalized) <= 0 ? a : b
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const TITLE_SEPARATORS = [' | ', ' — ', ' – ', ' · ', ' :: ', ' » ']

/**
 * Collapse whitespace, cut at the first pinned separator, lowercase.
 *
 * The cut is what lets `<title>Alpine Trail Pack 28L — 420D Ripstop | Basecamp
 * Supply Co</title>` corroborate a JSON-LD `name` of `Alpine Trail Pack 28L`.
 * Without it, essentially no real page would ever have a corroborated title,
 * and `title` is a core fact for seven of the eight page kinds.
 */
export function normalizeTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  let cut = collapsed
  for (const separator of TITLE_SEPARATORS) {
    const at = cut.indexOf(separator)
    if (at > 0) cut = cut.slice(0, at)
  }
  return cut.trim().toLowerCase()
}

/** Collapse whitespace + lowercase, capped so one long description cannot bloat a result. */
const MAX_NORMALIZED_TEXT = 200

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, MAX_NORMALIZED_TEXT)
}

/**
 * Money → `<ISO> <minor units>`, e.g. `USD 14800`. Currency travels with the
 * amount so the D2.4 parity comparison cannot match 14800 JPY against 14800 USD,
 * and `currency` is still reported separately because it is its own core fact.
 */
function normalizeMoney(amount: number, currency: string): string {
  return `${currency} ${amount}`
}

/** ISO 8601 date, day precision. Anything that is not a recognisable date is not a fact. */
export function normalizeDate(text: string): string | null {
  const trimmed = text.trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed)
  if (iso !== null) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const slashes = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(trimmed)
  if (slashes !== null) return `${slashes[1]}-${slashes[2]}-${slashes[3]}`
  const named = /^(\d{1,2}) ([A-Za-z]{3,9}) (\d{4})$/.exec(trimmed)
  if (named !== null) {
    const month = MONTHS.indexOf((named[2] ?? '').slice(0, 3).toLowerCase())
    if (month >= 0) return `${named[3]}-${pad2(month + 1)}-${pad2(Number(named[1]))}`
  }
  const american = /^([A-Za-z]{3,9}) (\d{1,2}), (\d{4})$/.exec(trimmed)
  if (american !== null) {
    const month = MONTHS.indexOf((american[1] ?? '').slice(0, 3).toLowerCase())
    if (month >= 0) return `${american[3]}-${pad2(month + 1)}-${pad2(Number(american[2]))}`
  }
  return null
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * The availability vocabulary, pinned. schema.org URLs, the bare enum names and
 * the visible-text phrases all collapse to one of six tokens, because "In stock"
 * on the page and `https://schema.org/InStock` in the JSON-LD are the same fact
 * and must corroborate.
 */
const AVAILABILITY_TOKENS: readonly (readonly [string, string])[] = [
  ['limitedavailability', 'limited'],
  ['onlineonly', 'instock'],
  ['instoreonly', 'instock'],
  ['presale', 'preorder'],
  ['preorder', 'preorder'],
  ['backorder', 'backorder'],
  ['discontinued', 'discontinued'],
  ['soldout', 'outofstock'],
  ['outofstock', 'outofstock'],
  ['instock', 'instock'],
]

/** Visible-text phrases, matched against normalised text. Longest first. */
const AVAILABILITY_PHRASES: readonly (readonly [string, string])[] = [
  ['limited availability', 'limited'],
  ['limited stock', 'limited'],
  ['currently unavailable', 'outofstock'],
  ['temporarily unavailable', 'outofstock'],
  ['out of stock', 'outofstock'],
  ['discontinued', 'discontinued'],
  ['back order', 'backorder'],
  ['backorder', 'backorder'],
  ['pre-order', 'preorder'],
  ['preorder', 'preorder'],
  ['sold out', 'outofstock'],
  ['in stock', 'instock'],
  ['available now', 'instock'],
]

export function normalizeAvailability(value: string): string | null {
  const squashed = value.toLowerCase().replace(/[^a-z]/g, '')
  for (const [needle, token] of AVAILABILITY_TOKENS) {
    if (squashed.endsWith(needle) || squashed === needle) return token
  }
  return null
}

/**
 * "We score honesty, not disclosure" (§3.5): an explicit statement that there is
 * no published price satisfies the `price` core fact. The list is pinned and
 * deliberately short — it contains only phrases that state the absence of a
 * price, never phrases that merely fail to state one.
 */
const NO_PUBLISHED_PRICE: readonly string[] = [
  'price on request',
  'pricing on request',
  'price on application',
  'contact us for pricing',
  'contact for pricing',
  'contact us for a quote',
  'no published price',
  'pricing available on request',
]

const UNPRICED = 'unpriced'

/** Phone → `+` and digits. `(415) 555-0142` and `+1 415 555 0142` are one fact. */
export function normalizePhone(value: string): string | null {
  const trimmed = value.trim()
  const plus = trimmed.startsWith('+') || trimmed.startsWith('tel:+')
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) return null
  return plus ? `+${digits}` : digits
}

// ---------------------------------------------------------------------------
// Money tokens in free text
// ---------------------------------------------------------------------------

/**
 * Single-character currency symbols that may START a money span. Multi-character
 * markers (`R$`, `kr`, `CHF`) are reached through the ISO-code branch instead: a
 * scanner that treated `R` or `k` as a currency start would open a span on every
 * capital R on the page and hand `parseMoneyText` garbage to reject.
 */
const CURRENCY_SYMBOLS = '$€£¥₹₩₪₫₴₦₱฿₺'
const DIGITS = '0123456789'
/** Comma, period, both apostrophes, plain space, NBSP, NARROW NBSP. */
const MONEY_SEPARATORS = ".,'’   "
const MONEY_PREFIX_QUALIFIERS = [
  'starting from',
  'starting at',
  'prices from',
  'priced from',
  'as little as',
  'as low as',
  'starts at',
  'from',
]
const RANGE_JOINERS = ['—', '–', '-', ' to ']

/**
 * Finds money-shaped substrings and hands each to `parseMoneyText`.
 *
 * Written as a scanner rather than a regex on purpose: the pattern that would
 * express this correctly needs nested quantifiers over overlapping character
 * classes, which is both a backtracking hazard on attacker-supplied bytes and
 * much harder to reimplement in another language than twenty lines of loop.
 *
 * The window handed to the parser includes an immediately preceding qualifier
 * (`From $9`) and a following range operand (`$148 – $198`), because
 * `parseMoneyText` resolves both to the lower bound with `qualified: true`, and a
 * qualified price is excluded from D2.4 parity (§3.11). Slicing the bare token
 * would silently turn a range into an exact price.
 */
export function findMoneyPhrases(text: string): { phrase: string; index: number }[] {
  const found: { phrase: string; index: number }[] = []
  const limit = Math.min(text.length, MAX_SCAN_CHARS)
  let i = 0
  while (i < limit) {
    const spanEnd = readMoneySpan(text, i, limit)
    if (spanEnd === null) {
      i++
      continue
    }
    let start = i
    let end = spanEnd

    // Leading qualifier.
    const before = text.slice(Math.max(0, start - 20), start).toLowerCase()
    for (const qualifier of MONEY_PREFIX_QUALIFIERS) {
      if (before.trimEnd().endsWith(qualifier)) {
        start = Math.max(0, start - (before.length - before.trimEnd().length) - qualifier.length)
        break
      }
    }

    // Trailing range operand.
    for (const joiner of RANGE_JOINERS) {
      const after = text.slice(end, end + joiner.length + 2)
      const at = after.indexOf(joiner)
      if (at === -1 || at > 1) continue
      const secondStart = end + at + joiner.length
      const secondEnd = readMoneySpan(text, skipSpaces(text, secondStart, limit), limit)
      if (secondEnd !== null) end = secondEnd
      break
    }

    found.push({ phrase: text.slice(start, end), index: start })
    i = end
  }
  return found
}

/** Bounded scan window. A 2 MiB body is data, not a budget. */
const MAX_SCAN_CHARS = 400_000

function skipSpaces(text: string, from: number, limit: number): number {
  let i = from
  while (i < limit && text.charAt(i) === ' ') i++
  return i
}

/**
 * Reads one money-shaped span starting at `from`, or null. A span is a currency
 * marker adjacent to a digit run, in either order; the marker is a symbol from
 * the pinned set or an uppercase three-letter token.
 */
function readMoneySpan(text: string, from: number, limit: number): number | null {
  const char = text.charAt(from)
  if (CURRENCY_SYMBOLS.includes(char) && char !== '') {
    let i = from + 1
    if (text.charAt(i) === ' ') i++
    if (!DIGITS.includes(text.charAt(i))) return null
    return readNumberRun(text, i, limit)
  }
  if (DIGITS.includes(char)) {
    // Only start a span at the beginning of a number run.
    const previous = from > 0 ? text.charAt(from - 1) : ''
    if (DIGITS.includes(previous) || MONEY_SEPARATORS.includes(previous)) return null
    const end = readNumberRun(text, from, limit)
    let i = end
    if (text.charAt(i) === ' ') i++
    const symbol = text.charAt(i)
    if (CURRENCY_SYMBOLS.includes(symbol) && symbol !== '') return i + 1
    const code = text.slice(i, i + 3)
    if (/^[A-Z]{3}$/.test(code) && !/[A-Za-z]/.test(text.charAt(i + 3))) return i + 3
    return null
  }
  if (/[A-Z]/.test(char) && from + 3 <= limit) {
    const code = text.slice(from, from + 3)
    if (!/^[A-Z]{3}$/.test(code)) return null
    if (from > 0 && /[A-Za-z]/.test(text.charAt(from - 1))) return null
    let i = from + 3
    if (text.charAt(i) === ' ') i++
    if (!DIGITS.includes(text.charAt(i))) return null
    return readNumberRun(text, i, limit)
  }
  return null
}

function readNumberRun(text: string, from: number, limit: number): number {
  let i = from
  let end = from
  while (i < limit) {
    const char = text.charAt(i)
    if (DIGITS.includes(char)) {
      i++
      end = i
      continue
    }
    if (MONEY_SEPARATORS.includes(char) && char !== '') {
      i++
      continue
    }
    break
  }
  return end
}

// ---------------------------------------------------------------------------
// Label lexicon — the key/value shape of markdown and of `<dt>`-style HTML
// ---------------------------------------------------------------------------

/**
 * Pinned label → fact mapping. This is how facts are read out of the negotiated
 * markdown representation, whose shape is `- **Price:** $148.00` (see
 * `@rebilder/render-md`), and out of definition-list HTML.
 *
 * Pinned rather than fuzzy-matched for the usual reason: a lexicon that grew per
 * page would make the same bytes score differently in two implementations.
 * Additions land as a MINOR.
 */
const LABEL_LEXICON: readonly (readonly [string, ArsFactKind])[] = [
  ['price', 'price'],
  ['cost', 'price'],
  ['currency', 'currency'],
  ['availability', 'availability'],
  ['stock', 'availability'],
  ['brand', 'brand'],
  ['manufacturer', 'brand'],
  ['sku', 'sku'],
  ['item number', 'sku'],
  ['product code', 'sku'],
  ['mpn', 'sku'],
  ['shipping', 'shipping'],
  ['delivery', 'shipping'],
  ['returns', 'returns'],
  ['return policy', 'returns'],
  ['refunds', 'returns'],
  ['description', 'description'],
  ['summary', 'description'],
  ['updated', 'updated'],
  ['last updated', 'updated'],
  ['modified', 'updated'],
  ['published', 'published'],
  ['date published', 'published'],
  ['author', 'author'],
  ['written by', 'author'],
  ['publisher', 'authority'],
  ['organization', 'org-name'],
  ['organisation', 'org-name'],
  ['company', 'org-name'],
  ['business', 'org-name'],
  ['address', 'address'],
  ['location', 'address'],
  ['phone', 'phone'],
  ['telephone', 'phone'],
  ['tel', 'phone'],
  ['email', 'email'],
  ['e-mail', 'email'],
  ['hours', 'hours'],
  ['opening hours', 'hours'],
  ['duration', 'duration'],
  ['length', 'duration'],
  ['eligibility', 'eligibility'],
  ['requirements', 'eligibility'],
  ['section', 'section'],
  ['category', 'section'],
  ['topic', 'section'],
  ['service area', 'service-area'],
  ['areas served', 'service-area'],
  ['items', 'item-count'],
  ['item count', 'item-count'],
]

/** Strips markdown list bullets, emphasis and heading marks from a label. */
function normalizeLabel(raw: string): string {
  return raw
    .replace(/^[\s>*\-+#]+/, '')
    .replace(/[*_`]/g, '')
    .trim()
    .toLowerCase()
}

interface LabelledValue {
  kind: ArsFactKind
  value: string
  index: number
}

/**
 * Reads `Label: value` lines. Handles the markdown emphasis form
 * (`- **Price:** $148.00`), the plain form (`Price: $148.00`) and nothing else —
 * a colon inside prose is not a label, which is why the label must be the first
 * thing on the line and no longer than `MAX_LABEL_CHARS`.
 */
function readLabelledLines(text: string): LabelledValue[] {
  const out: LabelledValue[] = []
  let cursor = 0
  for (const line of text.split('\n')) {
    const lineStart = cursor
    cursor += line.length + 1
    const colon = line.indexOf(':')
    if (colon === -1 || colon > MAX_LABEL_CHARS) continue
    const label = normalizeLabel(line.slice(0, colon))
    if (label.length === 0) continue
    const value = line
      .slice(colon + 1)
      .replace(/^[\s*_`]+/, '')
      .trim()
    if (value.length === 0) continue
    for (const [needle, kind] of LABEL_LEXICON) {
      if (label !== needle) continue
      out.push({ kind, value, index: lineStart + colon + 1 })
      break
    }
  }
  return out
}

const MAX_LABEL_CHARS = 32

// ---------------------------------------------------------------------------
// Extraction context
// ---------------------------------------------------------------------------

export interface ExtractContext {
  readonly profile: ArsFactProfile
  readonly ruleset: ArsRuleset
  /** Absolute URL the capture resolved to, used as the base for relative links. */
  readonly baseUrl: string
  /** Origin of the target, for the same-origin test on `item-link`. */
  readonly origin: string
  /** ISO code from structured data, if any. Disambiguates `$` and a bare `1.500`. */
  readonly currencyHint: string | undefined
}

/** Facts the caller wants: the profile's core plus extended set, as one lookup. */
function wanted(profile: ArsFactProfile): ReadonlySet<ArsFactKind> {
  return new Set<ArsFactKind>([...profile.core, ...profile.extended])
}

/**
 * Pass 2 (§3.5): extract against the RESOLVED profile. Only facts the profile
 * names are extracted, which is the mechanism that caps coverage at the profile
 * size and makes fixtures `031-keyword-stuffed` and `032-density-baseline` score
 * identically — a page can invent a hundred extra facts and none of them counts.
 */
export function extractFacts(
  representation: ArsRepresentation,
  context: ExtractContext,
): ExtractedFact[] {
  const facts: ExtractedFact[] = []
  const want = wanted(context.profile)
  const push = (fact: ExtractedFact): void => {
    if (want.has(fact.kind)) facts.push(fact)
  }

  for (const node of representation.jsonLd.nodes) extractFromJsonLd(node, context, push)

  if (representation.doc !== null) {
    extractFromHtml(representation.doc, context, push)
  } else {
    extractFromPlainText(representation, context, push)
  }

  return facts
}

// ---------------------------------------------------------------------------
// JSON-LD extraction
// ---------------------------------------------------------------------------

/**
 * Property aliases per fact, in precedence order. Written as paths so
 * `offers.price` reaches into an `Offer` and `offers.lowPrice` reaches into an
 * `AggregateOffer` — the shape Shopify actually emits.
 */
const JSON_LD_PATHS: readonly (readonly [ArsFactKind, readonly string[]])[] = [
  ['title', ['name', 'headline']],
  ['description', ['description', 'abstract']],
  ['price', ['offers.price', 'offers.lowPrice', 'offers.priceSpecification.price', 'price']],
  ['currency', ['offers.priceCurrency', 'offers.priceSpecification.priceCurrency', 'priceCurrency']],
  ['availability', ['offers.availability', 'availability']],
  ['brand', ['brand']],
  ['sku', ['sku', 'mpn', 'gtin13', 'gtin']],
  ['shipping', ['offers.shippingDetails', 'shippingDetails']],
  ['returns', ['offers.hasMerchantReturnPolicy', 'hasMerchantReturnPolicy']],
  ['org-name', ['name']],
  ['address', ['address']],
  ['hours', ['openingHours', 'openingHoursSpecification']],
  ['phone', ['telephone', 'contactPoint.telephone']],
  ['email', ['email', 'contactPoint.email']],
  ['service-area', ['areaServed', 'serviceArea']],
  ['author', ['author']],
  ['authority', ['publisher', 'author']],
  ['section', ['articleSection', 'genre']],
  ['published', ['datePublished', 'dateCreated']],
  ['updated', ['dateModified']],
  ['duration', ['duration', 'timeRequired']],
  ['eligibility', ['eligibleCustomerType', 'audience']],
  ['primary-action-url', ['potentialAction.target', 'potentialAction.url']],
  ['question-answer', ['mainEntity.acceptedAnswer']],
  ['item-count', ['numberOfItems']],
  ['item-link', ['itemListElement.url', 'itemListElement.item']],
]

/** Types whose `name` is an organisation name rather than a page title. */
const ORG_TYPES = new Set([
  'Organization',
  'LocalBusiness',
  'Store',
  'Restaurant',
  'Corporation',
  'NGO',
  'GovernmentOrganization',
  'EducationalOrganization',
  'MedicalBusiness',
  'ProfessionalService',
  'FoodEstablishment',
  'LodgingBusiness',
  'AutomotiveBusiness',
  'HealthAndBeautyBusiness',
  'SportsActivityLocation',
  'Place',
])

function extractFromJsonLd(
  node: JsonLdNode,
  context: ExtractContext,
  push: (fact: ExtractedFact) => void,
): void {
  const isOrg = node.types.some((type) => ORG_TYPES.has(type))
  for (const [kind, paths] of JSON_LD_PATHS) {
    // `name` means two different things depending on the node's type; reading it
    // as both would let one string corroborate itself across two fact kinds.
    if (kind === 'title' && isOrg) continue
    if (kind === 'org-name' && !isOrg) continue

    for (const path of paths) {
      const raw = readPath(node, path)
      if (raw === null) continue
      const normalized = normalizeFactValue(kind, raw, context)
      if (normalized === null) continue
      push({ kind, normalized: normalized.value, source: 'json-ld', offset: node.offset, qualified: normalized.qualified })
      break
    }
  }
}

interface NormalizedValue {
  value: string
  qualified: boolean
}

/** One normaliser, shared by every source, so the same fact from two places matches. */
function normalizeFactValue(
  kind: ArsFactKind,
  raw: string,
  context: ExtractContext,
): NormalizedValue | null {
  if (PRESENCE_FACTS.has(kind)) return { value: DECLARED, qualified: false }

  switch (kind) {
    case 'title':
      return raw.trim().length === 0 ? null : { value: normalizeTitle(raw), qualified: false }
    case 'price': {
      const lowered = raw.trim().toLowerCase()
      if (NO_PUBLISHED_PRICE.some((phrase) => lowered.includes(phrase))) {
        return { value: UNPRICED, qualified: false }
      }
      const money = parseMoneyText(raw, { currency: context.currencyHint })
      return money === null
        ? null
        : { value: normalizeMoney(money.amount, money.currency), qualified: money.qualified }
    }
    case 'currency': {
      const code = raw.trim().toUpperCase()
      return /^[A-Z]{3}$/.test(code) ? { value: code, qualified: false } : null
    }
    case 'availability': {
      const token = normalizeAvailability(raw)
      return token === null ? null : { value: token, qualified: false }
    }
    case 'phone': {
      const phone = normalizePhone(raw)
      return phone === null ? null : { value: phone, qualified: false }
    }
    case 'email': {
      const email = raw.trim().replace(/^mailto:/i, '').toLowerCase()
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { value: email, qualified: false } : null
    }
    case 'published':
    case 'updated': {
      const date = normalizeDate(raw)
      return date === null ? null : { value: date, qualified: false }
    }
    case 'duration': {
      const minutes = normalizeDuration(raw)
      return minutes === null ? null : { value: minutes, qualified: false }
    }
    case 'item-count': {
      const count = Number.parseInt(raw.replace(/[^0-9]/g, ''), 10)
      return Number.isFinite(count) && count > 0 ? { value: String(count), qualified: false } : null
    }
    case 'primary-action-url': {
      const absolute = absoluteUrl(raw, context.baseUrl)
      return absolute === null ? null : { value: absolute, qualified: false }
    }
    default:
      return raw.trim().length === 0 ? null : { value: normalizeText(raw), qualified: false }
  }
}

/** ISO 8601 durations and the two visible forms, normalised to whole minutes. */
export function normalizeDuration(raw: string): string | null {
  // LINEAR, verified.
  // safe-regex flags `\d+` nested inside a quantified group structurally. It is
  // not ambiguous here: every `\d+` is followed by a REQUIRED distinct literal
  // (D, H, M), so each group matches exactly one way or none, and the outer
  // quantifiers are `?` (max one repetition), not `*`/`+`. Catastrophic
  // backtracking needs many ways to split the same input; there are none.
  // Measured: 200k chars in <1 ms, growth linear. Input is also capped at
  // MAX_NORMALIZED_TEXT (200) upstream.
  // eslint-disable-next-line security/detect-unsafe-regex
  const iso = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(raw.trim().toUpperCase())
  if (iso !== null && (iso[1] ?? iso[2] ?? iso[3]) !== undefined) {
    const minutes = Number(iso[1] ?? 0) * 1440 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0)
    return minutes > 0 ? String(minutes) : null
  }
  const spoken = /^(\d{1,4})\s?(min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i.exec(raw.trim())
  if (spoken !== null) {
    const amount = Number(spoken[1])
    const unit = (spoken[2] ?? '').toLowerCase()
    const minutes = unit.startsWith('h') ? amount * 60 : amount
    return minutes > 0 ? String(minutes) : null
  }
  return null
}

/** Resolves a possibly relative URL. Returns null rather than throwing on garbage. */
export function absoluteUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// HTML extraction
// ---------------------------------------------------------------------------

/** `<meta>` name/property → fact. Pinned; `og:` and the Twitter card are the whole set. */
const META_LEXICON: readonly (readonly [string, ArsFactKind])[] = [
  ['og:title', 'title'],
  ['twitter:title', 'title'],
  ['description', 'description'],
  ['og:description', 'description'],
  ['twitter:description', 'description'],
  ['og:price:amount', 'price'],
  ['product:price:amount', 'price'],
  ['og:price:currency', 'currency'],
  ['product:price:currency', 'currency'],
  ['og:availability', 'availability'],
  ['product:availability', 'availability'],
  ['product:brand', 'brand'],
  ['og:site_name', 'org-name'],
  ['author', 'author'],
  ['article:author', 'author'],
  ['article:published_time', 'published'],
  ['article:modified_time', 'updated'],
  ['article:section', 'section'],
]

/** `itemprop` → fact, for microdata. The same vocabulary as JSON-LD, one level flat. */
const ITEMPROP_LEXICON: readonly (readonly [string, ArsFactKind])[] = [
  ['name', 'title'],
  ['price', 'price'],
  ['pricecurrency', 'currency'],
  ['availability', 'availability'],
  ['brand', 'brand'],
  ['sku', 'sku'],
  ['description', 'description'],
  ['telephone', 'phone'],
  ['email', 'email'],
  ['address', 'address'],
  ['openinghours', 'hours'],
  ['author', 'author'],
  ['datepublished', 'published'],
  ['datemodified', 'updated'],
  ['articlesection', 'section'],
]

function extractFromHtml(
  doc: HtmlDocument,
  context: ExtractContext,
  push: (fact: ExtractedFact) => void,
): void {
  // <title> and the first <h1>.
  for (const element of doc.elements) {
    if (element.tag !== 'title') continue
    const text = elementText(doc, element.index)
    const normalized = normalizeFactValue('title', text, context)
    if (normalized !== null) {
      push({ kind: 'title', normalized: normalized.value, source: 'html-text', offset: element.offset, qualified: false })
    }
    break
  }
  for (const element of doc.elements) {
    if (element.tag !== 'h1' || element.excludedBy !== null) continue
    const normalized = normalizeFactValue('title', elementText(doc, element.index), context)
    if (normalized !== null) {
      push({ kind: 'title', normalized: normalized.value, source: 'html-text', offset: element.offset, qualified: false })
    }
    break
  }

  // <meta>.
  for (const meta of doc.metas) {
    if (meta.content === null) continue
    const key = meta.property ?? meta.name
    if (key === null) continue
    for (const [needle, kind] of META_LEXICON) {
      if (key !== needle) continue
      const normalized = normalizeFactValue(kind, meta.content, context)
      if (normalized !== null) {
        push({ kind, normalized: normalized.value, source: 'meta', offset: meta.offset, qualified: normalized.qualified })
      }
      break
    }
  }

  // Microdata: itemprop, with content= preferred over text (schema.org's own advice).
  for (const element of doc.elements) {
    const itemprop = attr(element, 'itemprop')
    if (itemprop === null) continue
    const key = itemprop.toLowerCase()
    for (const [needle, kind] of ITEMPROP_LEXICON) {
      if (key !== needle) continue
      const raw =
        attr(element, 'content') ??
        attr(element, 'datetime') ??
        attr(element, 'href') ??
        elementText(doc, element.index)
      const normalized = normalizeFactValue(kind, raw, context)
      if (normalized !== null) {
        push({ kind, normalized: normalized.value, source: 'microdata', offset: element.offset, qualified: normalized.qualified })
      }
      break
    }
  }

  // Visible text: money, availability phrases, the no-published-price signal.
  extractVisibleText(doc, context, push)

  // Links and forms.
  extractLinks(doc, context, push)

  // Structural shapes: question/answer, opening hours, definition lists.
  extractStructures(doc, context, push)
}

/**
 * Facts read out of counted text. Every text node is visited individually so the
 * fact's offset is the offset of the node it was found in — a measured offset of
 * a heuristic fact, which is exactly how §3.9 describes `ArsFactObservation`.
 *
 * Hidden nodes (`hidden`, inline `display:none`, `<template>`) are skipped:
 * fixture `037-hidden-text-facts` asserts that facts stuffed into a hidden
 * element do not score.
 */
function extractVisibleText(
  doc: HtmlDocument,
  context: ExtractContext,
  push: (fact: ExtractedFact) => void,
): void {
  for (const node of doc.texts) {
    if (node.excludedBy !== null) continue
    const text = node.text
    if (text.trim().length === 0) continue

    for (const money of findMoneyPhrases(text)) {
      const parsed = parseMoneyText(money.phrase, { currency: context.currencyHint })
      if (parsed === null) continue
      push({
        kind: 'price',
        normalized: normalizeMoney(parsed.amount, parsed.currency),
        source: 'html-text',
        offset: node.offset,
        qualified: parsed.qualified,
      })
      push({
        kind: 'currency',
        normalized: parsed.currency,
        source: 'html-text',
        offset: node.offset,
        qualified: false,
      })
    }

    const lowered = text.toLowerCase()
    if (NO_PUBLISHED_PRICE.some((phrase) => lowered.includes(phrase))) {
      push({ kind: 'price', normalized: UNPRICED, source: 'html-text', offset: node.offset, qualified: false })
    }
    for (const [phrase, token] of AVAILABILITY_PHRASES) {
      if (!lowered.includes(phrase)) continue
      push({ kind: 'availability', normalized: token, source: 'html-text', offset: node.offset, qualified: false })
      break
    }
    for (const [kind, marker] of TEXT_PRESENCE_MARKERS) {
      if (!marker.some((phrase) => lowered.includes(phrase))) continue
      push({ kind, normalized: DECLARED, source: 'html-text', offset: node.offset, qualified: false })
    }
    const sku = /\bsku[:\s]+([A-Za-z0-9][A-Za-z0-9._-]{2,31})\b/i.exec(text)
    if (sku !== null && sku[1] !== undefined) {
      push({ kind: 'sku', normalized: normalizeText(sku[1]), source: 'html-text', offset: node.offset, qualified: false })
    }
  }

  // Labelled lines inside HTML (`<dt>Price</dt><dd>$148</dd>` collapses to
  // "Price $148" in counted text, so this reads the whole document's text once).
  for (const labelled of readLabelledLines(countedText(doc))) {
    const normalized = normalizeFactValue(labelled.kind, labelled.value, context)
    if (normalized === null) continue
    push({
      kind: labelled.kind,
      normalized: normalized.value,
      source: 'html-text',
      offset: firstTextOffset(doc),
      qualified: normalized.qualified,
    })
  }
}

/** Presence facts detectable from prose, with their pinned phrase lists. */
const TEXT_PRESENCE_MARKERS: readonly (readonly [ArsFactKind, readonly string[]])[] = [
  ['shipping', ['free shipping', 'shipping', 'ships in', 'delivery', 'ships free']],
  ['returns', ['return policy', 'returns', 'money-back', 'money back', 'refund']],
  ['service-area', ['areas served', 'service area', 'we serve', 'serving']],
  ['eligibility', ['eligibility', 'who can apply', 'you must be', 'requirements']],
]

function firstTextOffset(doc: HtmlDocument): number {
  for (const node of doc.texts) {
    if (node.excludedBy === null && node.text.trim().length > 0) return node.offset
  }
  return 0
}

const ACTION_MAX_TEXT_CHARS = 64

function extractLinks(
  doc: HtmlDocument,
  context: ExtractContext,
  push: (fact: ExtractedFact) => void,
): void {
  const lexicon = context.ruleset.actionLexicon
  for (const element of doc.elements) {
    if (element.excludedBy !== null) continue

    if (element.tag === 'a') {
      const href = attr(element, 'href')
      if (href === null) continue
      if (href.toLowerCase().startsWith('tel:')) {
        const phone = normalizePhone(href.slice(4))
        if (phone !== null) {
          push({ kind: 'phone', normalized: phone, source: 'html-text', offset: element.offset, qualified: false })
        }
        continue
      }
      if (href.toLowerCase().startsWith('mailto:')) {
        const normalized = normalizeFactValue('email', href, context)
        if (normalized !== null) {
          push({ kind: 'email', normalized: normalized.value, source: 'html-text', offset: element.offset, qualified: false })
        }
        continue
      }
      const text = elementText(doc, element.index).slice(0, ACTION_MAX_TEXT_CHARS)
      if (!matchesLexicon(text, lexicon)) continue
      const absolute = absoluteUrl(href, context.baseUrl)
      if (absolute === null) continue
      push({ kind: 'primary-action-url', normalized: absolute, source: 'html-text', offset: element.offset, qualified: false })
      continue
    }

    if (element.tag === 'form') {
      const action = attr(element, 'action')
      if (action === null) continue
      const text = elementText(doc, element.index).slice(0, ACTION_MAX_TEXT_CHARS)
      if (!matchesLexicon(text, lexicon)) continue
      const absolute = absoluteUrl(action, context.baseUrl)
      if (absolute === null) continue
      push({ kind: 'primary-action-url', normalized: absolute, source: 'html-text', offset: element.offset, qualified: false })
    }
  }

  const items = largestRepeatedLinkBlock(doc, context.origin)
  if (items.count > 0) {
    push({ kind: 'item-count', normalized: String(items.count), source: 'html-text', offset: items.offset, qualified: false })
    if (items.sameOrigin) {
      push({ kind: 'item-link', normalized: DECLARED, source: 'html-text', offset: items.offset, qualified: false })
    }
  }
}

/** Anchor text matches the action lexicon exactly, or begins with a lexicon phrase. */
function matchesLexicon(text: string, lexicon: readonly string[]): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()
  if (normalized.length === 0) return false
  for (const phrase of lexicon) {
    if (normalized === phrase) return true
    if (normalized.startsWith(`${phrase} `)) return true
  }
  return false
}

/**
 * `item-count` / `item-link` for `collection` (§3.5): "the number of distinct
 * item links inside the largest repeated-structure block, and whether those
 * links resolve to same-origin URLs."
 *
 * Made deterministic as: group every anchor by its GRANDPARENT element (the
 * container of the repeated item, e.g. `<ul>` for `<li><a>`), drop groups whose
 * container is inside `<nav>`, `<header>` or `<footer>`, and take the group with
 * the most distinct hrefs. The nav exclusion is the whole reason for the
 * "largest repeated block" phrasing — a site-wide menu is a repeated block of
 * links and is not a product grid.
 */
function largestRepeatedLinkBlock(
  doc: HtmlDocument,
  origin: string,
): { count: number; offset: number; sameOrigin: boolean } {
  const groups = new Map<number, { hrefs: Set<string>; sameOrigin: number; offset: number }>()
  for (const element of doc.elements) {
    if (element.tag !== 'a' || element.excludedBy !== null) continue
    const href = attr(element, 'href')
    if (href === null || href.startsWith('#')) continue
    const parent = element.parent >= 0 ? doc.elements[element.parent] : undefined
    const container = parent !== undefined && parent.parent >= 0 ? parent.parent : element.parent
    if (container < 0) continue
    if (isInsideChrome(doc, container)) continue

    const absolute = absoluteUrl(href, origin)
    if (absolute === null) continue
    const group = groups.get(container) ?? {
      hrefs: new Set<string>(),
      sameOrigin: 0,
      offset: doc.elements[container]?.offset ?? 0,
    }
    if (!group.hrefs.has(absolute)) {
      group.hrefs.add(absolute)
      if (absolute.startsWith(origin)) group.sameOrigin++
    }
    groups.set(container, group)
  }

  let best = { count: 0, offset: 0, sameOrigin: false }
  for (const [, group] of groups) {
    if (group.hrefs.size <= best.count) continue
    best = {
      count: group.hrefs.size,
      offset: group.offset,
      sameOrigin: group.sameOrigin * 2 >= group.hrefs.size,
    }
  }
  return best.count >= MIN_REPEATED_ITEMS ? best : { count: 0, offset: 0, sameOrigin: false }
}

/** Below this, a group of links is a paragraph with citations, not a listing. */
const MIN_REPEATED_ITEMS = 3

const CHROME_TAGS = new Set(['nav', 'header', 'footer'])

function isInsideChrome(doc: HtmlDocument, from: number): boolean {
  let current = from
  for (let hops = 0; hops < 64 && current >= 0; hops++) {
    const element = doc.elements[current]
    if (element === undefined) return false
    if (CHROME_TAGS.has(element.tag)) return true
    if (element.attrs['role'] === 'navigation' || element.attrs['role'] === 'banner') return true
    current = element.parent
  }
  return false
}

const DAY_NAMES = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
]

/**
 * Day-name / `HH:MM` adjacency, the §3.5 pass-1 signal, reused here as the
 * visible-text source for `hours`. "Adjacent" is: a day name and a clock time
 * within 40 characters of each other in the same text node.
 */
export function hasOpeningHoursShape(text: string): boolean {
  const lowered = text.toLowerCase()
  for (const day of DAY_NAMES) {
    let at = lowered.indexOf(day)
    while (at !== -1) {
      const window = lowered.slice(at, at + 40)
      if (/\d{1,2}[:.]\d{2}/.test(window) || /\d{1,2}\s?(am|pm)/.test(window)) return true
      at = lowered.indexOf(day, at + day.length)
    }
  }
  return false
}

function extractStructures(
  doc: HtmlDocument,
  context: ExtractContext,
  push: (fact: ExtractedFact) => void,
): void {
  for (const node of doc.texts) {
    if (node.excludedBy !== null) continue
    if (!hasOpeningHoursShape(node.text)) continue
    push({ kind: 'hours', normalized: DECLARED, source: 'html-text', offset: node.offset, qualified: false })
    break
  }

  for (const element of doc.elements) {
    if (element.excludedBy !== null) continue
    if (element.tag === 'address') {
      const normalized = normalizeFactValue('address', elementText(doc, element.index), context)
      if (normalized !== null) {
        push({ kind: 'address', normalized: normalized.value, source: 'html-text', offset: element.offset, qualified: false })
      }
    }
  }

  const qa = firstQuestionAnswer(doc)
  if (qa !== null) {
    push({ kind: 'question-answer', normalized: DECLARED, source: 'html-text', offset: qa, qualified: false })
  }
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

/**
 * The §3.5 `question-answer` shapes: a `<dt>`/`<dd>` pair, a
 * `<details><summary>`, or a heading ending in `?` followed by a paragraph.
 * Counted ONCE as present, not per item — a page with 40 questions is not four
 * times better than a page with 10, and the offset returned is the first shape's.
 */
function firstQuestionAnswer(doc: HtmlDocument): number | null {
  let sawDt = false
  let pendingQuestionHeading = false
  for (const element of doc.elements) {
    if (element.excludedBy !== null) continue
    if (element.tag === 'dt') {
      sawDt = true
      continue
    }
    if (element.tag === 'dd' && sawDt) return element.offset
    if (element.tag === 'details') {
      for (const child of doc.elements) {
        if (child.parent === element.index && child.tag === 'summary') return element.offset
      }
      continue
    }
    if (HEADING_TAGS.has(element.tag)) {
      pendingQuestionHeading = elementText(doc, element.index).trim().endsWith('?')
      continue
    }
    if (element.tag === 'p' && pendingQuestionHeading) return element.offset
  }
  return null
}

// ---------------------------------------------------------------------------
// Plain-text / markdown extraction
// ---------------------------------------------------------------------------

const MARKDOWN_LINK_RE = /\[([^\]\n]{1,120})\]\(([^)\s]{1,500})\)/g

/**
 * Extraction from a NEGOTIATED representation — markdown or plain text. Offsets
 * are UTF-8 byte offsets into the body, computed once per hit rather than by
 * scanning the whole body, so a 2 MiB markdown file does not become quadratic.
 *
 * The source is recorded as `negotiated` for everything found here, which is
 * what lets a fact stated in markdown corroborate the same fact in the HTML's
 * JSON-LD: two distinct sources, one value.
 */
function extractFromPlainText(
  representation: ArsRepresentation,
  context: ExtractContext,
  push: (fact: ExtractedFact) => void,
): void {
  const body = representation.body
  const offsetOf = (index: number): number => utf8Length(body.slice(0, index))

  // Title: the first ATX heading, with a wrapping markdown link unwrapped —
  // `render-md` emits `# [Alpine Trail Pack 28L](https://…)`.
  const heading = /^#{1,6}[ \t]+(.+)$/m.exec(body)
  if (heading !== null && heading[1] !== undefined) {
    const linked = /^\[([^\]]+)\]\([^)]*\)\s*$/.exec(heading[1].trim())
    const raw = linked !== null && linked[1] !== undefined ? linked[1] : heading[1]
    const normalized = normalizeFactValue('title', raw, context)
    if (normalized !== null) {
      push({ kind: 'title', normalized: normalized.value, source: 'negotiated', offset: offsetOf(heading.index), qualified: false })
    }
  }

  for (const labelled of readLabelledLines(body)) {
    const normalized = normalizeFactValue(labelled.kind, labelled.value, context)
    if (normalized === null) continue
    push({ kind: labelled.kind, normalized: normalized.value, source: 'negotiated', offset: offsetOf(labelled.index), qualified: normalized.qualified })
    // A labelled price also states its currency.
    if (labelled.kind === 'price' && normalized.value !== UNPRICED) {
      const code = normalized.value.slice(0, 3)
      push({ kind: 'currency', normalized: code, source: 'negotiated', offset: offsetOf(labelled.index), qualified: false })
    }
  }

  for (const money of findMoneyPhrases(body)) {
    const parsed = parseMoneyText(money.phrase, { currency: context.currencyHint })
    if (parsed === null) continue
    push({ kind: 'price', normalized: normalizeMoney(parsed.amount, parsed.currency), source: 'negotiated', offset: offsetOf(money.index), qualified: parsed.qualified })
    push({ kind: 'currency', normalized: parsed.currency, source: 'negotiated', offset: offsetOf(money.index), qualified: false })
  }

  const lowered = body.toLowerCase()
  if (NO_PUBLISHED_PRICE.some((phrase) => lowered.includes(phrase))) {
    push({ kind: 'price', normalized: UNPRICED, source: 'negotiated', offset: 0, qualified: false })
  }
  for (const [phrase, token] of AVAILABILITY_PHRASES) {
    const at = lowered.indexOf(phrase)
    if (at === -1) continue
    push({ kind: 'availability', normalized: token, source: 'negotiated', offset: offsetOf(at), qualified: false })
    break
  }
  for (const [kind, markers] of TEXT_PRESENCE_MARKERS) {
    for (const phrase of markers) {
      const at = lowered.indexOf(phrase)
      if (at === -1) continue
      push({ kind, normalized: DECLARED, source: 'negotiated', offset: offsetOf(at), qualified: false })
      break
    }
  }
  if (hasOpeningHoursShape(body)) {
    push({ kind: 'hours', normalized: DECLARED, source: 'negotiated', offset: 0, qualified: false })
  }

  // Markdown links: the primary action, and the repeated-item block.
  const itemLinks = new Set<string>()
  let firstItemOffset = 0
  let match: RegExpExecArray | null
  MARKDOWN_LINK_RE.lastIndex = 0
  while ((match = MARKDOWN_LINK_RE.exec(body)) !== null) {
    const text = match[1] ?? ''
    const href = match[2] ?? ''
    const absolute = absoluteUrl(href, context.baseUrl)
    if (absolute === null) continue
    if (matchesLexicon(text, context.ruleset.actionLexicon)) {
      push({ kind: 'primary-action-url', normalized: absolute, source: 'negotiated', offset: offsetOf(match.index), qualified: false })
    }
    if (absolute.startsWith(context.origin) && !itemLinks.has(absolute)) {
      if (itemLinks.size === 0) firstItemOffset = offsetOf(match.index)
      itemLinks.add(absolute)
    }
  }
  if (itemLinks.size >= MIN_REPEATED_ITEMS) {
    push({ kind: 'item-count', normalized: String(itemLinks.size), source: 'negotiated', offset: firstItemOffset, qualified: false })
    push({ kind: 'item-link', normalized: DECLARED, source: 'negotiated', offset: firstItemOffset, qualified: false })
  }

  // A question/answer shape in markdown: a heading that ends in `?`.
  const question = /^#{1,6}[ \t]+.*\?[ \t]*$/m.exec(body)
  if (question !== null) {
    push({ kind: 'question-answer', normalized: DECLARED, source: 'negotiated', offset: offsetOf(question.index), qualified: false })
  }
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

export interface RobotsGroup {
  /** Lowercased user-agent tokens this group applies to. */
  readonly agents: readonly string[]
  readonly allow: readonly string[]
  readonly disallow: readonly string[]
}

export interface RobotsFile {
  readonly groups: readonly RobotsGroup[]
  readonly sitemaps: readonly string[]
  /** Lines that are neither blank, a comment, nor a `field: value` pair. */
  readonly malformedLines: number
  /** Directives that appeared before any `User-agent:` line — the classic authoring bug. */
  readonly orphanRules: number
}

/**
 * RFC 9309 robots.txt, in the subset ARS reads. Deliberately small: we consume
 * `User-agent`, `Allow`, `Disallow` and `Sitemap`, count what we could not
 * parse, and ignore everything else. `Crawl-delay` is honoured by the PROBE, not
 * by the score — waiting longer is not worse markup.
 */
export function parseRobots(text: string): RobotsFile {
  /** Mutable while parsing; the exported shape is the readonly one. */
  interface MutableGroup {
    agents: string[]
    allow: string[]
    disallow: string[]
  }

  const groups: MutableGroup[] = []
  const sitemaps: string[] = []
  let malformedLines = 0
  let orphanRules = 0

  let current: MutableGroup | null = null
  /**
   * True while consecutive `User-agent:` lines are still accumulating into one
   * group. RFC 9309 §2.2.1: adjacent user-agent lines share the rules that
   * follow them; the first rule line closes the group to further agents.
   */
  let openingGroup = false

  for (const rawLine of text.split(/\r?\n/)) {
    const withoutComment = rawLine.split('#')[0] ?? ''
    const line = withoutComment.trim()
    if (line.length === 0) continue
    const colon = line.indexOf(':')
    if (colon <= 0) {
      malformedLines++
      continue
    }
    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()

    if (field === 'user-agent') {
      if (current === null || !openingGroup) {
        current = { agents: [], allow: [], disallow: [] }
        groups.push(current)
        openingGroup = true
      }
      current.agents.push(value.toLowerCase())
      continue
    }
    if (field === 'sitemap') {
      sitemaps.push(value)
      continue
    }
    if (field === 'allow' || field === 'disallow') {
      if (current === null) {
        orphanRules++
        continue
      }
      openingGroup = false
      if (field === 'allow') current.allow.push(value)
      else current.disallow.push(value)
      continue
    }
    if (field === 'crawl-delay' || field === 'host' || field === 'clean-param') continue
    malformedLines++
  }

  return { groups, sitemaps, malformedLines, orphanRules }
}

/**
 * RFC 9309 group selection: the most specific matching `User-agent` wins, `*` is
 * the fallback, and matching is case-insensitive. Returns the decision plus the
 * group and rule that produced it, because `ArsAudienceDecision` publishes both —
 * a merchant who disagrees with an `opt-out` verdict gets to see the line.
 */
export function decideRobots(
  robots: RobotsFile,
  tokens: readonly string[],
  path: string,
): ArsAudienceDecision {
  let bestGroup: RobotsGroup | null = null
  let bestAgent: string | null = null
  let bestSpecificity = -1

  for (const group of robots.groups) {
    for (const agent of group.agents) {
      const specificity = agent === '*' ? 0 : matchesToken(agent, tokens) ? agent.length : -1
      if (specificity > bestSpecificity) {
        bestSpecificity = specificity
        bestGroup = group
        bestAgent = agent
      }
    }
  }

  if (bestGroup === null || bestAgent === null) {
    return { decision: 'unspecified', matchedGroup: null, matchedRule: null }
  }

  // Longest-match wins between Allow and Disallow; a tie goes to Allow (RFC 9309 §2.2.2).
  let bestRule: { field: 'allow' | 'disallow'; value: string } | null = null
  for (const value of bestGroup.allow) {
    if (!pathMatches(value, path)) continue
    if (bestRule === null || value.length > bestRule.value.length) {
      bestRule = { field: 'allow', value }
    }
  }
  for (const value of bestGroup.disallow) {
    if (!pathMatches(value, path)) continue
    if (bestRule === null || value.length > bestRule.value.length) {
      bestRule = { field: 'disallow', value }
    }
  }

  if (bestRule === null) {
    return { decision: 'allow', matchedGroup: bestAgent, matchedRule: null }
  }
  return {
    decision: bestRule.field === 'allow' ? 'allow' : 'disallow',
    matchedGroup: bestAgent,
    matchedRule: `${bestRule.field === 'allow' ? 'Allow' : 'Disallow'}: ${bestRule.value}`,
  }
}

function matchesToken(agent: string, tokens: readonly string[]): boolean {
  const lowered = agent.toLowerCase()
  return tokens.some((token) => token.toLowerCase() === lowered)
}

/**
 * Path matching with `*` and `$`, done as a bounded scan rather than a compiled
 * regex: a robots.txt is attacker-controlled input and
 * `new RegExp(pathFromTheInternet)` is a denial-of-service primitive.
 */
export function pathMatches(pattern: string, path: string): boolean {
  if (pattern === '') return false
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  const segments = body.split('*')

  let cursor = 0
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? ''
    if (i === 0) {
      if (!path.startsWith(segment)) return false
      cursor = segment.length
      continue
    }
    if (segment === '') continue
    const at = path.indexOf(segment, cursor)
    if (at === -1) return false
    cursor = at + segment.length
  }
  if (anchored) {
    const last = segments[segments.length - 1] ?? ''
    return segments.length === 1 ? path === body : path.endsWith(last)
  }
  return true
}

/** Every audience decision plus the derived policy flags. Pure over a parsed robots file. */
export function buildPolicyReport(
  robots: RobotsFile | null,
  status: ArsPolicyReport['robotsTxtStatus'],
  ruleset: ArsRuleset,
  path: string,
): ArsPolicyReport {
  const empty: ArsAudienceDecision = { decision: 'unspecified', matchedGroup: null, matchedRule: null }
  const audiences: Record<ArsAudience, ArsAudienceDecision> = {
    assistant: empty,
    training: empty,
    search: empty,
  }
  if (robots !== null) {
    for (const audience of ['assistant', 'training', 'search'] as const) {
      audiences[audience] = decideRobots(robots, ruleset.audienceTokens[audience], path)
    }
  }

  return {
    robotsTxtStatus: status,
    audiences,
    // A deliberate opt-out requires a group that NAMES an assistant token.
    // Consent has to be specific: a blanket `User-agent: *` disallow is the
    // accidental case (§3.7) and is scored, not excused.
    deliberateOptOut:
      robots !== null &&
      audiences.assistant.decision === 'disallow' &&
      audiences.assistant.matchedGroup !== '*' &&
      robots.malformedLines === 0 &&
      robots.orphanRules === 0,
    trainingOptOut: audiences.training.decision === 'disallow',
    sitemapDeclared: robots !== null && robots.sitemaps.length > 0,
  }
}
