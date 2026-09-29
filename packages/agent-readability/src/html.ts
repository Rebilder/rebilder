/**
 * html.ts — a tolerant, NON-EXECUTING HTML tokenizer, hand-rolled.
 *
 * WHY NOT parse5, cheerio, jsdom, or htmlparser2 (design §3.2, stated as a
 * normative reason rather than a preference): **a third-party parser version is
 * an unversioned input to a deterministic score.** ARS publishes the guarantee
 * that for a given `evidenceHash`, `rulesetHash` and `corpusHash`, `score()`
 * returns a byte-identical result in any conformant implementation, in any
 * language. A dependency that changes how a malformed `<div` is recovered
 * changes scores on a `pnpm update`, with no ARS version bump, no conformance
 * diff, and nothing in the release notes. It would also put a transitive
 * dependency tree into a package whose whole claim is that it has none.
 *
 * The second reason is the same one that rules out a cascade engine: this
 * tokenizer's recovery rules ARE the spec. They are written here, in ~600 lines,
 * where a second implementation in Go can read them.
 *
 * NON-EXECUTING is literal and load-bearing. `<script>` and `<style>` contents
 * are captured as opaque raw text and never evaluated, never fed to a JS engine,
 * never resolved. The probe fetches attacker-controlled bytes from arbitrary
 * origins; the only safe posture is that those bytes are data all the way down.
 *
 * WHAT IT EXTRACTS
 * - every start/end tag, with attributes (lowercased names, entity-decoded values)
 * - every text node, with its **UTF-8 byte offset** into the source
 * - `<script type="application/ld+json">` contents, verbatim
 * - `<meta>` tags (name / property / http-equiv / itemprop / charset / content)
 * - `<link>` tags, including the multi-value `rel` token list
 *
 * BYTE OFFSETS ARE LOAD-BEARING. D4 scores the byte offset of the first core
 * fact (`≤512B → 5 · ≤2KiB → 4 · ≤8KiB → 2 · ≤32KiB → 1`) and the fraction of
 * core facts inside a `max(2048, bytes / 5)` front window. `ArsHttpCapture.bytes`
 * is defined as the *decoded UTF-8 byte length*, so offsets here are UTF-8 byte
 * offsets, NOT JavaScript string indices. On a page with any multibyte character
 * before the price — a `€`, a `—`, a CJK product name — those two numbers differ,
 * and a Go implementation counting real bytes would disagree with us. See
 * `Utf8Cursor`.
 *
 * TEXT EXTRACTION (normative, §3.6). Counted text is every text node except:
 *   `<script>`, `<style>`, `<template>`, elements carrying the `hidden`
 *   attribute, and elements carrying inline `style="display:none"`.
 * **No CSS resolution** — a cascade engine would not be deterministic across
 * implementations, so a class that hides an element in a stylesheet does not
 * hide it here, and the spec says so rather than pretending otherwise.
 *
 * ONE READING DECISION, FLAGGED. §3.6 writes the rule as "except `<script>`
 * (excluding `application/ld+json`)", which can be read either way. We implement:
 * **JSON-LD script contents are NOT counted text**; they are surfaced separately
 * as `HtmlDocument.jsonLd`. The other reading breaks two mechanisms that the rest
 * of the spec depends on — D5.3 checks that structured data agrees with *visible*
 * text, and "corroborated" means observed in ≥2 sources (e.g. JSON-LD *and*
 * visible text). If JSON-LD were visible text, both would be satisfied by a
 * single JSON-LD block, trivially and always. Every text node reports
 * `excludedBy`, so the distinction is visible to callers rather than baked in.
 *
 * TOLERANCE CONTRACT: `tokenizeHtml` never throws, for any input string —
 * unterminated tags, unterminated comments, stray `<`, lone surrogates, 100k
 * nested `<div>`s, binary noise. Conformance fixture `057-tokenizer-fuzz` and
 * `tests/html.test.ts` both assert it. A scanner that can be crashed by the page
 * it is scanning is a denial-of-service endpoint.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Why a text node is not counted text. `null` means it is counted. */
export type HtmlExclusionReason =
  | 'script'
  | 'script-ld-json'
  | 'style'
  | 'template'
  | 'hidden-attribute'
  | 'inline-display-none'

export interface HtmlElement {
  /** Index into `HtmlDocument.elements`; ascending in source order. */
  index: number
  /** Lowercased tag name. */
  tag: string
  /** Lowercased attribute names → entity-decoded values. First occurrence wins (HTML5). */
  attrs: Readonly<Record<string, string>>
  /** UTF-8 byte offset of the `<` that opens this tag. */
  offset: number
  /** Index of the enclosing open element, or -1 at document level. */
  parent: number
  /** Nesting depth; 0 at document level. */
  depth: number
  /**
   * Effective exclusion for text inside this element — its own reason, or the
   * nearest ancestor's. `null` when text inside it counts.
   */
  excludedBy: HtmlExclusionReason | null
}

export interface HtmlText {
  /** Entity-decoded text (raw, undecoded inside `<script>`/`<style>`). */
  text: string
  /** UTF-8 byte offset of the first character of the RAW source text. */
  offset: number
  /** UTF-8 byte length of the RAW source text. */
  bytes: number
  /** Index of the innermost enclosing element, or -1 at document level. */
  parent: number
  /** `null` when this node is counted text; otherwise why it is not. */
  excludedBy: HtmlExclusionReason | null
}

export interface HtmlJsonLd {
  /** Script contents, verbatim. Not entity-decoded: `<script>` is a raw-text element. */
  text: string
  /** UTF-8 byte offset of the first character of the contents. */
  offset: number
  /** Index of the `<script>` element in `HtmlDocument.elements`. */
  element: number
}

export interface HtmlMeta {
  /** Lowercased `name`, or null. */
  name: string | null
  /** Lowercased `property` (Open Graph), or null. */
  property: string | null
  /** Lowercased `http-equiv`, or null. */
  httpEquiv: string | null
  /** Lowercased `itemprop`, or null. */
  itemprop: string | null
  /** Lowercased `charset`, or null. */
  charset: string | null
  /** `content`, decoded, case preserved. */
  content: string | null
  element: number
  offset: number
}

export interface HtmlLink {
  /**
   * `rel` as a token list, lowercased, source order, duplicates removed.
   * `rel="alternate canonical"` is one link declaring two relations, and D2.2
   * (declared alternates) and D6.1 (canonical) both read it — collapsing it to a
   * string would lose one of them.
   */
  rel: readonly string[]
  href: string | null
  /** Lowercased `type`, or null. */
  type: string | null
  /** Lowercased `hreflang`, or null. */
  hreflang: string | null
  title: string | null
  element: number
  offset: number
}

export interface HtmlDocument {
  readonly elements: readonly HtmlElement[]
  readonly texts: readonly HtmlText[]
  readonly jsonLd: readonly HtmlJsonLd[]
  readonly metas: readonly HtmlMeta[]
  readonly links: readonly HtmlLink[]
  /** Total UTF-8 byte length of the source. */
  readonly bytes: number
}

// ---------------------------------------------------------------------------
// UTF-8 offsets
// ---------------------------------------------------------------------------

/**
 * Maps JavaScript string indices to UTF-8 byte offsets in one forward pass.
 *
 * The tokenizer advances monotonically, so `at()` is amortised O(1); a
 * non-monotonic call restarts from zero rather than returning a wrong number,
 * because a silently wrong offset is a silently wrong D4 score.
 *
 * Surrogate handling matches `TextEncoder`: a well-formed pair costs 4 bytes,
 * and a LONE surrogate costs 3 — WHATWG encoding replaces it with U+FFFD, so
 * that is what its byte cost actually is on the wire.
 */
class Utf8Cursor {
  private charIndex = 0
  private byteIndex = 0

  constructor(private readonly source: string) {}

  at(target: number): number {
    if (target < this.charIndex) {
      this.charIndex = 0
      this.byteIndex = 0
    }
    const limit = Math.min(target, this.source.length)
    while (this.charIndex < limit) {
      const code = this.source.charCodeAt(this.charIndex)
      if (code < 0x80) {
        this.byteIndex += 1
        this.charIndex += 1
      } else if (code < 0x800) {
        this.byteIndex += 2
        this.charIndex += 1
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next =
          this.charIndex + 1 < this.source.length ? this.source.charCodeAt(this.charIndex + 1) : 0
        if (next >= 0xdc00 && next <= 0xdfff && this.charIndex + 1 < limit) {
          this.byteIndex += 4
          this.charIndex += 2
        } else {
          // Lone high surrogate, or a pair straddling `limit`: 3 bytes for U+FFFD.
          this.byteIndex += 3
          this.charIndex += 1
        }
      } else {
        this.byteIndex += 3
        this.charIndex += 1
      }
    }
    return this.byteIndex
  }
}

// ---------------------------------------------------------------------------
// Entity decoding
// ---------------------------------------------------------------------------

/**
 * Pinned named character references.
 *
 * The full HTML5 named-reference table is ~2 200 entries. This is the subset
 * that appears in the parts of a page ARS reads — money symbols, typography,
 * and the five XML entities — and it is PINNED per spec version for the same
 * reason the tokenizer is hand-rolled: growing the table changes extracted text,
 * which changes facts, which changes scores. Additions land as a MINOR.
 *
 * A named reference outside this table is left verbatim, which is also the only
 * safe failure: `&hearts;` surviving as literal text costs nothing, whereas
 * guessing would be non-deterministic.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  shy: '\u00ad',
  zwnj: '\u200c',
  zwj: '\u200d',
  // Currency
  cent: '¢',
  pound: '£',
  curren: '¤',
  yen: '¥',
  euro: '€',
  dollar: '$',
  // Typography
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  lsaquo: '‹',
  rsaquo: '›',
  bull: '•',
  middot: '·',
  dagger: '†',
  Dagger: '‡',
  prime: '′',
  Prime: '″',
  // Marks and math
  copy: '©',
  reg: '®',
  trade: '™',
  sect: '§',
  para: '¶',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  minus: '−',
  permil: '‰',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup2: '²',
  sup3: '³',
  le: '≤',
  ge: '≥',
  ne: '≠',
  // Directionality (invisible, but they do occupy bytes)
  lrm: '\u200e',
  rlm: '\u200f',
}

/**
 * The HTML spec's windows-1252 override for numeric references in 0x80–0x9F.
 * `&#146;` is a right single quote on real pages, not a C1 control, and
 * decoding it as one would corrupt product titles.
 */
const C1_REPLACEMENTS: Readonly<Record<number, number>> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
}

/**
 * A trailing `;` is REQUIRED. HTML's legacy semicolon-less forms
 * (`&copy` inside `?a=1&copy=2`) are exactly the cases where decoding mangles a
 * URL, and every reference that matters on a page ARS reads is written properly.
 * Bounded name length keeps the match linear.
 */
const ENTITY_RE = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{0,31});/g

function codePointToString(raw: number): string {
  const mapped = C1_REPLACEMENTS[raw]
  const code = mapped ?? raw
  // Null, surrogates and out-of-range all become U+FFFD, per the HTML spec.
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd'
  return String.fromCodePoint(code)
}

/** Decodes the pinned named references plus numeric references. Never throws. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(ENTITY_RE, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const digits = isHex ? body.slice(2) : body.slice(1)
      const value = Number.parseInt(digits, isHex ? 16 : 10)
      return Number.isNaN(value) ? match : codePointToString(value)
    }
    return NAMED_ENTITIES[body] ?? match
  })
}

// ---------------------------------------------------------------------------
// Element tables
// ---------------------------------------------------------------------------

/** Void elements: no contents, never pushed onto the open-element stack. */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** Raw-text elements: contents are opaque, entities are NOT decoded. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style'])

/** RCDATA elements: contents are text, entities ARE decoded, tags are not. */
const RCDATA_ELEMENTS = new Set(['textarea', 'title'])

/**
 * Optional-end-tag recovery, in the small form that matters here. A start tag
 * listed as a key implicitly closes any open element in its value set. Without
 * this, `<li>a<li>b` nests forever and `<dt>q<dd>a` puts the answer inside the
 * question — and `<dt>/<dd>` pairs are one of the recognised `question-answer`
 * shapes for the `faq` page kind, so getting it wrong costs real points.
 */
const IMPLIED_END_TAGS: Readonly<Record<string, readonly string[]>> = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  option: ['option'],
  optgroup: ['option', 'optgroup'],
  tr: ['td', 'th', 'tr'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  tbody: ['td', 'th', 'tr', 'thead', 'tbody'],
  tfoot: ['td', 'th', 'tr', 'thead', 'tbody'],
}

/** Block-level start tags that implicitly close an open `<p>`. */
const CLOSES_OPEN_P = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
])

/**
 * Cap on open-element depth. Beyond it, elements are still recorded but not
 * pushed, so a page with 200 000 nested `<div>`s costs memory proportional to
 * its bytes and nothing more. Real documents do not approach this.
 */
const MAX_DEPTH = 256

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isAsciiAlpha(ch: string | undefined): boolean {
  if (ch === undefined) return false
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
}

function isHtmlSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
}

/**
 * Inline `display:none`, with whitespace stripped first so the test itself is a
 * plain substring match rather than a regex with a backtracking profile. Only
 * the element's own `style` attribute is consulted: NO CSS RESOLUTION (§3.6).
 */
const DISPLAY_NONE_RE = /(^|;)display:none(!important)?(;|$)/

function hasInlineDisplayNone(style: string | undefined): boolean {
  if (style === undefined) return false
  return DISPLAY_NONE_RE.test(style.toLowerCase().replace(/\s+/g, ''))
}

/** Reads an attribute, or null. Attribute names are lowercased by the tokenizer. */
export function attr(element: HtmlElement, name: string): string | null {
  return element.attrs[name] ?? null
}

// ---------------------------------------------------------------------------
// Tag parsing
// ---------------------------------------------------------------------------

interface ParsedTag {
  tag: string
  attrs: Record<string, string>
  selfClosing: boolean
  /** Index just past the closing `>` (or past the end of input if unterminated). */
  end: number
}

/**
 * Parses a start tag beginning at `start` (the `<`). Tolerant: an unterminated
 * tag consumes to end of input and returns what it read.
 */
function parseStartTag(html: string, start: number): ParsedTag {
  let i = start + 1
  const nameStart = i
  while (i < html.length) {
    const ch = html[i] ?? ''
    if (isHtmlSpace(ch) || ch === '/' || ch === '>') break
    i++
  }
  const tag = html.slice(nameStart, i).toLowerCase()
  const attrs: Record<string, string> = {}
  let selfClosing = false

  while (i < html.length) {
    while (i < html.length && isHtmlSpace(html[i] ?? '')) i++
    if (i >= html.length) break
    const ch = html[i] ?? ''
    if (ch === '>') {
      i++
      return { tag, attrs, selfClosing, end: i }
    }
    if (ch === '/') {
      selfClosing = true
      i++
      continue
    }
    // Attribute name.
    const attrNameStart = i
    while (i < html.length) {
      const c = html[i] ?? ''
      if (isHtmlSpace(c) || c === '=' || c === '>' || c === '/') break
      i++
    }
    if (i === attrNameStart) {
      // Nothing consumed (e.g. a stray '='): skip a character so we always advance.
      i++
      continue
    }
    const attrName = html.slice(attrNameStart, i).toLowerCase()
    let value = ''
    while (i < html.length && isHtmlSpace(html[i] ?? '')) i++
    if (html[i] === '=') {
      i++
      while (i < html.length && isHtmlSpace(html[i] ?? '')) i++
      const quote = html[i]
      if (quote === '"' || quote === "'") {
        i++
        const valueStart = i
        const close = html.indexOf(quote, i)
        if (close === -1) {
          value = html.slice(valueStart)
          i = html.length
        } else {
          value = html.slice(valueStart, close)
          i = close + 1
        }
      } else {
        const valueStart = i
        while (i < html.length) {
          const c = html[i] ?? ''
          if (isHtmlSpace(c) || c === '>') break
          i++
        }
        value = html.slice(valueStart, i)
      }
    }
    // First occurrence wins, per the HTML parsing spec.
    if (!(attrName in attrs)) attrs[attrName] = decodeEntities(value)
  }
  return { tag, attrs, selfClosing, end: i }
}

/** Locates the matching `</tag` for a raw-text or RCDATA element, case-insensitively. */
function findRawTextEnd(html: string, from: number, tag: string): number {
  const needle = `</${tag}`
  const lower = html.toLowerCase()
  const at = lower.indexOf(needle, from)
  return at === -1 ? -1 : at
}

// ---------------------------------------------------------------------------
// tokenizeHtml
// ---------------------------------------------------------------------------

/** The element's own exclusion reason, ignoring ancestors. */
function ownExclusion(
  tag: string,
  attrs: Readonly<Record<string, string>>,
): HtmlExclusionReason | null {
  if (tag === 'script') {
    const type = (attrs['type'] ?? '').toLowerCase().split(';')[0]?.trim() ?? ''
    return type === 'application/ld+json' ? 'script-ld-json' : 'script'
  }
  if (tag === 'style') return 'style'
  if (tag === 'template') return 'template'
  // `hidden` is a boolean attribute: its presence hides, whatever the value
  // (including `hidden="until-found"`, which is still hidden until found).
  if ('hidden' in attrs) return 'hidden-attribute'
  if (hasInlineDisplayNone(attrs['style'])) return 'inline-display-none'
  return null
}

/**
 * Tokenizes `html` into the flat, offset-annotated structure ARS scores against.
 * Never throws. `html` is the DECODED response body; offsets are UTF-8 byte
 * offsets into that decoded body, matching `ArsHttpCapture.bytes`.
 */
export function tokenizeHtml(html: string): HtmlDocument {
  const elements: HtmlElement[] = []
  const texts: HtmlText[] = []
  const jsonLd: HtmlJsonLd[] = []
  const metas: HtmlMeta[] = []
  const links: HtmlLink[] = []
  const stack: number[] = []
  const cursor = new Utf8Cursor(html)

  const topIndex = (): number => stack[stack.length - 1] ?? -1
  const exclusionAt = (elementIndex: number): HtmlExclusionReason | null =>
    elementIndex >= 0 ? (elements[elementIndex]?.excludedBy ?? null) : null

  const emitText = (
    from: number,
    to: number,
    decode: boolean,
    override?: HtmlExclusionReason,
  ): void => {
    if (to <= from) return
    const raw = html.slice(from, to)
    const parent = topIndex()
    const offset = cursor.at(from)
    texts.push({
      text: decode ? decodeEntities(raw) : raw,
      offset,
      bytes: cursor.at(to) - offset,
      parent,
      excludedBy: override ?? exclusionAt(parent),
    })
  }

  const popTo = (tag: string): void => {
    for (let depth = stack.length - 1; depth >= 0; depth--) {
      const candidate = stack[depth]
      if (candidate === undefined) continue
      if (elements[candidate]?.tag === tag) {
        stack.length = depth
        return
      }
    }
    // No matching open element: a stray end tag. Ignore it, as browsers do.
  }

  const applyImpliedEndTags = (tag: string): void => {
    const closes = IMPLIED_END_TAGS[tag]
    if (closes !== undefined) {
      while (stack.length > 0) {
        const top = stack[stack.length - 1]
        const openTag = top === undefined ? undefined : elements[top]?.tag
        if (openTag === undefined || !closes.includes(openTag)) break
        stack.pop()
      }
    }
    if (CLOSES_OPEN_P.has(tag)) {
      const top = stack[stack.length - 1]
      if (top !== undefined && elements[top]?.tag === 'p') stack.pop()
    }
  }

  // `textStart` trails `i`: a `<` that turns out NOT to open markup stays inside
  // the current text run rather than splitting it. `a < b` is one text node, not
  // three — and since `countedText` joins nodes with a space, splitting it would
  // silently rewrite the page's own text before any fact is extracted from it.
  let i = 0
  let textStart = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) break

    const next = html[lt + 1]
    // A `<` opens markup only before `!`, `/`, or an ASCII letter. Anything else
    // — `3<4`, a stray `<` at end of input — is text.
    if (next !== '!' && next !== '/' && !isAsciiAlpha(next)) {
      i = lt + 1
      continue
    }
    emitText(textStart, lt, true)

    // --- Comments, doctypes, CDATA, bogus comments ---
    if (next === '!') {
      if (html.startsWith('<!--', lt)) {
        const close = html.indexOf('-->', lt + 4)
        i = close === -1 ? html.length : close + 3
      } else {
        const close = html.indexOf('>', lt + 2)
        i = close === -1 ? html.length : close + 1
      }
      textStart = i
      continue
    }

    // --- End tags ---
    if (next === '/') {
      const close = html.indexOf('>', lt + 2)
      const end = close === -1 ? html.length : close + 1
      const rawName = html.slice(lt + 2, close === -1 ? html.length : close).trim()
      const tag = rawName.toLowerCase()
      if (tag.length > 0) popTo(tag)
      i = end
      textStart = i
      continue
    }

    // --- Start tags ---
    const parsed = parseStartTag(html, lt)
    applyImpliedEndTags(parsed.tag)

    const parent = topIndex()
    const own = ownExclusion(parsed.tag, parsed.attrs)
    const element: HtmlElement = {
      index: elements.length,
      tag: parsed.tag,
      attrs: parsed.attrs,
      offset: cursor.at(lt),
      parent,
      depth: stack.length,
      excludedBy: exclusionAt(parent) ?? own,
    }
    elements.push(element)
    collectMetaOrLink(element, metas, links)
    i = parsed.end

    const isVoid = VOID_ELEMENTS.has(parsed.tag)
    const isRawText = RAW_TEXT_ELEMENTS.has(parsed.tag)
    const isRcdata = RCDATA_ELEMENTS.has(parsed.tag)

    if (isRawText || isRcdata) {
      // Contents are opaque: no nested tags, no stack push. Entities are decoded
      // for RCDATA (`<title>`, `<textarea>`) and NOT for raw text (`<script>`,
      // `<style>`) — a JSON-LD block must survive byte-for-byte.
      const contentStart = i
      const close = findRawTextEnd(html, contentStart, parsed.tag)
      const contentEnd = close === -1 ? html.length : close
      if (contentEnd > contentStart) {
        const wasTop = stack.length
        stack.push(element.index)
        emitText(contentStart, contentEnd, isRcdata, element.excludedBy ?? own ?? undefined)
        stack.length = wasTop
        if (own === 'script-ld-json') {
          jsonLd.push({
            text: html.slice(contentStart, contentEnd),
            offset: cursor.at(contentStart),
            element: element.index,
          })
        }
      }
      if (close === -1) {
        i = html.length
      } else {
        const gt = html.indexOf('>', close)
        i = gt === -1 ? html.length : gt + 1
      }
      textStart = i
      continue
    }

    if (!isVoid && !parsed.selfClosing && stack.length < MAX_DEPTH) stack.push(element.index)
    textStart = i
  }
  emitText(textStart, html.length, true)

  return {
    elements,
    texts,
    jsonLd,
    metas,
    links,
    bytes: cursor.at(html.length),
  }
}

/** Records `<meta>` and `<link>` elements into their typed side-tables. */
function collectMetaOrLink(element: HtmlElement, metas: HtmlMeta[], links: HtmlLink[]): void {
  const lower = (value: string | undefined): string | null =>
    value === undefined ? null : value.toLowerCase()

  if (element.tag === 'meta') {
    metas.push({
      name: lower(element.attrs['name']),
      property: lower(element.attrs['property']),
      httpEquiv: lower(element.attrs['http-equiv']),
      itemprop: lower(element.attrs['itemprop']),
      charset: lower(element.attrs['charset']),
      content: element.attrs['content'] ?? null,
      element: element.index,
      offset: element.offset,
    })
    return
  }

  if (element.tag === 'link') {
    const rawRel = element.attrs['rel'] ?? ''
    const rel: string[] = []
    for (const token of rawRel.toLowerCase().split(/\s+/)) {
      if (token.length > 0 && !rel.includes(token)) rel.push(token)
    }
    links.push({
      rel,
      href: element.attrs['href'] ?? null,
      type: lower(element.attrs['type']),
      hreflang: lower(element.attrs['hreflang']),
      title: element.attrs['title'] ?? null,
      element: element.index,
      offset: element.offset,
    })
  }
}

// ---------------------------------------------------------------------------
// Text views
// ---------------------------------------------------------------------------

/**
 * Joins text nodes with a single space and collapses whitespace runs.
 *
 * A single space rather than an empty string: `<b>Blue</b><i>Shirt</i>` renders
 * as two words to a reader, and "BlueShirt" is not a title. Joining always,
 * rather than only across block boundaries, avoids needing a display-model —
 * which is the same reason there is no CSS resolution anywhere in this file.
 */
function joinText(parts: readonly string[]): string {
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** All counted text in the document, per the §3.6 normative extraction rule. */
export function countedText(doc: HtmlDocument): string {
  const parts: string[] = []
  for (const node of doc.texts) {
    if (node.excludedBy === null) parts.push(node.text)
  }
  return joinText(parts)
}

/**
 * Counted text inside one element's subtree — anchor text for
 * `primary-action-url`, a `<summary>`'s question, a heading. `includeExcluded`
 * opts into hidden subtrees, which the extractor needs for exactly one thing:
 * reporting hidden facts as evidence (fixture `037-hidden-text-facts`) without
 * letting them score.
 */
export function elementText(
  doc: HtmlDocument,
  elementIndex: number,
  includeExcluded = false,
): string {
  const parts: string[] = []
  for (const node of doc.texts) {
    if (!includeExcluded && node.excludedBy !== null) continue
    if (isSelfOrDescendant(doc, node.parent, elementIndex)) parts.push(node.text)
  }
  return joinText(parts)
}

/** Walks `parent` links upward. Bounded by MAX_DEPTH + 1 so a cycle cannot hang. */
function isSelfOrDescendant(doc: HtmlDocument, from: number, ancestor: number): boolean {
  let current = from
  for (let hops = 0; hops <= MAX_DEPTH + 1 && current >= 0; hops++) {
    if (current === ancestor) return true
    current = doc.elements[current]?.parent ?? -1
  }
  return false
}
