/**
 * parse-money.ts — text → `Money`, or `null` when ambiguous. Design §3.11.
 *
 * WHY THIS IS ITS OWN FILE, AND WHY IT IS BIG. `packages/render-md/src/money.ts`
 * only *formats* an already-structured `Money`. It cannot parse text, and the
 * claim that it could hid the largest single piece of extraction work in the
 * program. Price is a core fact for `product` and `service`, it is one of the
 * four values compared by the D2.4 substance-parity check, and it is the value a
 * buying agent acts on. Everything downstream of a wrong price is wrong.
 *
 * FAILS CLOSED, like `formatMoney`. Ambiguous input returns `null`, and a `null`
 * price is simply not a fact — it costs coverage points and nothing else. A
 * *wrong* price would be reported as truth on a public scanner page, and would
 * make a parity check accuse a merchant of divergence they did not commit.
 * Every rule below resolves in favour of `null`.
 *
 * WHY `Money` IS DECLARED HERE RATHER THAN IMPORTED. It is structurally
 * identical to `@rebilder/render-md`'s `Money`, and duplicating it is
 * deliberate: the package-graph check forbids
 * `agent-readability → render-md` (and the reverse) in the `ars-boundary` rule.
 * The two packages point in opposite directions — gateway/render-md turn a
 * source of truth into output; the scorer turns a response into a judgment — so
 * a dependency either way is a design error before it is a size one. Four bytes
 * of duplicated interface is the cheap side of that trade.
 *
 * NO `String.prototype.normalize()`. Unicode normalisation is deterministic only
 * for a fixed Unicode version, and the Unicode version is a property of the
 * host's ICU build. That is the same class of unversioned input as a
 * third-party HTML parser, and the same answer applies: every character this
 * parser special-cases is listed here, in a pinned table.
 *
 * SUPPORTED FORMATS (§3.11 enumerates these; each has a test):
 *   leading symbol           `$1,499.00`   `€49`      `¥4,900`
 *   trailing symbol          `1.499,00 €`  `49 zł`
 *   ISO code prefix/suffix   `USD 1499`    `1499 USD`
 *   comma and period as BOTH group and decimal separator, disambiguated by
 *     position and by the minor-unit digits of the resolved currency
 *   space / NBSP / narrow-NBSP / apostrophe group separators  `1 499,00`  `1'499.00`
 *   zero-decimal currencies  `¥4,900` → 4900, not 490000
 *   ranges                   `$148.00 – $198.00` → the LOWER bound, `qualified: true`
 *   qualifiers               `From $9`, `$9+`      → the stated bound, `qualified: true`
 *
 * `qualified: true` EXISTS FOR ONE REASON: qualified values are excluded from
 * the D2.4 parity comparison. "From $9" in markdown against "$9 – $40" in HTML is
 * the same page saying the same thing in two shapes, and flagging it as a
 * substance divergence would be a false accusation.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Structural duplicate of `@rebilder/render-md`'s `Money` — same field names,
 * same semantics, deliberately not imported (see the file header).
 * `amount` is an INTEGER NUMBER OF MINOR UNITS: 4900 is $49.00 in USD and ¥4,900
 * in JPY, because JPY has no minor unit.
 */
export interface Money {
  amount: number
  currency: string
}

/**
 * What `parseMoneyText` returns: a `Money`, plus whether the source text stated
 * a bound rather than a price.
 */
export interface ParsedMoney extends Money {
  /** True for ranges (`$148 – $198`) and qualifiers (`From $9`, `$9+`). */
  qualified: boolean
}

export interface MoneyHints {
  /**
   * ISO 4217 code the page is known to price in — from JSON-LD `priceCurrency`,
   * a `<meta itemprop="priceCurrency">`, or the negotiated representation.
   * Does two jobs: it resolves symbols shared by several currencies (`$`, `¥`,
   * `kr`), and its minor-unit digit count disambiguates a lone separator
   * followed by three digits.
   */
  currency?: string
}

// ---------------------------------------------------------------------------
// Currency tables
// ---------------------------------------------------------------------------

/**
 * ISO 4217 active alphabetic codes. Pinned: a bare three-letter token is
 * accepted as a currency ONLY if it is on this list, which is what stops
 * `50 OFF` parsing as 50 of some currency "OFF".
 *
 * Codes that are also English words do exist — `ALL` (Albanian lek), `TOP`
 * (Tongan paʻanga), `MAD`, `PEN`, `CUP`, `BOB`, `TRY`. They are handled by the
 * two structural rules rather than by a blocklist: a code must be immediately
 * adjacent to the number, and the text must contain exactly ONE number. `TRY 2
 * FOR 1` has two numbers and returns `null`.
 */
const ISO_4217 = new Set(
  (
    'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD ' +
    'BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUP CVE CZK DJF DKK DOP DZD ' +
    'EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD ' +
    'IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL ' +
    'MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN ' +
    'PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN ' +
    'SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES ' +
    'VND VUV WST XAF XAG XAU XCD XCG XDR XOF XPD XPF XPT YER ZAR ZMW ZWG'
  ).split(' '),
)

/**
 * Currencies with no minor unit — `amount` is already whole currency units.
 * Mirrors `render-md`'s table exactly (see the file header on why it is copied).
 */
const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
])

/** Currencies with three-digit minor units. Mirrors `render-md`'s table. */
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'])

/** Minor-unit digit count for an ISO 4217 code. Unknown codes are treated as 2. */
export function minorUnitDigits(code: string): number {
  const upper = code.toUpperCase()
  if (ZERO_DECIMAL.has(upper)) return 0
  if (THREE_DECIMAL.has(upper)) return 3
  return 2
}

interface SymbolEntry {
  /** Resolution when `hints.currency` says nothing useful. `null` = unresolvable alone. */
  fallback: string | null
  /** Codes this symbol may legitimately denote; `hints.currency` selects among them. */
  alternatives: readonly string[]
}

/**
 * Currency symbols, longest-first at match time so `CA$` beats `$`.
 *
 * `$`, `¥` and `kr` are shared. `$` and `¥` carry a pinned fallback (USD, JPY)
 * because a bare `$` on an unhinted page is overwhelmingly USD and `¥4,900` is
 * §3.11's own worked example of zero-decimal handling; `hints.currency`
 * overrides both. `kr` has NO fallback — SEK, NOK, DKK and ISK are genuinely
 * indistinguishable, and ISK is zero-decimal while the others are not, so
 * guessing would corrupt the amount and not merely the label.
 */
const SYMBOLS: Readonly<Record<string, SymbolEntry>> = {
  US$: { fallback: 'USD', alternatives: [] },
  CA$: { fallback: 'CAD', alternatives: [] },
  C$: { fallback: 'CAD', alternatives: [] },
  AU$: { fallback: 'AUD', alternatives: [] },
  A$: { fallback: 'AUD', alternatives: [] },
  NZ$: { fallback: 'NZD', alternatives: [] },
  HK$: { fallback: 'HKD', alternatives: [] },
  NT$: { fallback: 'TWD', alternatives: [] },
  S$: { fallback: 'SGD', alternatives: [] },
  R$: { fallback: 'BRL', alternatives: [] },
  MX$: { fallback: 'MXN', alternatives: [] },
  $: {
    fallback: 'USD',
    alternatives: [
      'USD',
      'CAD',
      'AUD',
      'NZD',
      'SGD',
      'HKD',
      'MXN',
      'TWD',
      'BRL',
      'ARS',
      'CLP',
      'COP',
      'UYU',
    ],
  },
  '¥': { fallback: 'JPY', alternatives: ['JPY', 'CNY'] },
  kr: { fallback: null, alternatives: ['SEK', 'NOK', 'DKK', 'ISK'] },
  '€': { fallback: 'EUR', alternatives: [] },
  '£': { fallback: 'GBP', alternatives: [] },
  '₹': { fallback: 'INR', alternatives: [] },
  '₩': { fallback: 'KRW', alternatives: [] },
  '₽': { fallback: 'RUB', alternatives: [] },
  '₺': { fallback: 'TRY', alternatives: [] },
  '₪': { fallback: 'ILS', alternatives: [] },
  '₫': { fallback: 'VND', alternatives: [] },
  '₱': { fallback: 'PHP', alternatives: [] },
  '₴': { fallback: 'UAH', alternatives: [] },
  '₦': { fallback: 'NGN', alternatives: [] },
  '₡': { fallback: 'CRC', alternatives: [] },
  '₸': { fallback: 'KZT', alternatives: [] },
  '₾': { fallback: 'GEL', alternatives: [] },
  '฿': { fallback: 'THB', alternatives: [] },
  zł: { fallback: 'PLN', alternatives: [] },
  Kč: { fallback: 'CZK', alternatives: [] },
}

/** Symbols longest-first, so `CA$1.00` does not resolve through the bare `$` entry. */
const SYMBOLS_BY_LENGTH = Object.keys(SYMBOLS).sort((a, b) => b.length - a.length)

// ---------------------------------------------------------------------------
// Lexicons and limits
// ---------------------------------------------------------------------------

/**
 * Prefix qualifiers. Matched at the start of the text, case-insensitively, and
 * only when followed by a non-letter — so `fromage` is not `from`.
 */
const PREFIX_QUALIFIERS = [
  'starting from',
  'starting at',
  'prices from',
  'priced from',
  'as little as',
  'as much as',
  'as low as',
  'starts at',
  'up to',
  'from',
] as const

/** Suffix qualifiers, matched at the end of the text, case-insensitively. */
const SUFFIX_QUALIFIERS = ['and above', 'or more', 'or less', 'and up', '+'] as const

/**
 * Range separators: em dash, en dash, Unicode hyphen, ASCII hyphen-minus. The
 * ASCII hyphen is included even though it is also a minus sign, because
 * `$148-$198` is a common real form; the "exactly one separator in the whole
 * string" rule below is what keeps `1-800-555-1212` and `2024-01-15` out.
 */
const RANGE_DASHES = ['\u2014', '\u2013', '\u2010', '-'] as const

/**
 * Whitespace normalised to a plain space before parsing: the ASCII controls,
 * NBSP, OGHAM SPACE MARK, the EN QUAD..HAIR SPACE block, NARROW NBSP, MEDIUM
 * MATHEMATICAL SPACE and IDEOGRAPHIC SPACE. NBSP and NARROW NBSP are the group
 * separators in fr-FR and ru-RU prices, which is why they are here as well as
 * in `GROUP_SPACERS`.
 */
const SPACE_RE = /[\t\n\r\f\v\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g

/**
 * Characters that may separate digit groups in place of a comma or period: a
 * plain space (every exotic space has already been normalised to one) and the
 * de-CH apostrophe forms.
 */
const GROUP_SPACERS = [' ', "'", '\u2019'] as const

/**
 * Longest input accepted. A price does not occur inside 256 characters of prose,
 * and the cap also bounds the parser's work on adversarial input — the probe
 * fetches arbitrary bytes, and this function is called per fact candidate.
 */
const MAX_INPUT_LENGTH = 256

/**
 * Digits allowed in a value before it is rejected. 15 significant digits is the
 * range in which `Number` is an exact integer; beyond it a price would round,
 * and a rounded price is a wrong price (source validation).
 */
const MAX_SIGNIFICANT_DIGITS = 15

/** A run of digits plus the characters that may appear inside a formatted number. */
const NUMBER_RUN_RE = /\d[\d.,'’ ]*/g

// ---------------------------------------------------------------------------
// Numeric parsing
// ---------------------------------------------------------------------------

/** True when every part is a plausible digit group: 1–3 leading digits, then exact 3s. */
function isGroupedInteger(parts: readonly string[]): boolean {
  if (parts.length < 2) return false
  const first = parts[0] ?? ''
  // A grouped number never starts with 0: `0,500` is not five hundred.
  if (first.length < 1 || first.length > 3 || first.startsWith('0')) return false
  for (let i = 1; i < parts.length; i++) {
    if ((parts[i] ?? '').length !== 3) return false
  }
  return true
}

/**
 * Removes space/apostrophe group separators, or returns null if they are not in
 * valid group positions. `1 499,00` → `1499,00`; `12 34` → null.
 */
function stripGroupSpacers(token: string): string | null {
  if (!GROUP_SPACERS.some((c) => token.includes(c))) return token

  // Split off a trailing decimal part first, so `1'499.00` keeps its `.00`.
  let head = token
  let tail = ''
  const lastDot = token.lastIndexOf('.')
  const lastComma = token.lastIndexOf(',')
  const lastSep = Math.max(lastDot, lastComma)
  if (lastSep > 0) {
    const after = token.slice(lastSep + 1)
    const afterIsDigits = after.length > 0 && !/\D/.test(after)
    if (afterIsDigits) {
      head = token.slice(0, lastSep)
      tail = token.slice(lastSep)
    }
  }

  const parts: string[] = []
  let current = ''
  for (const ch of head) {
    if (GROUP_SPACERS.includes(ch as (typeof GROUP_SPACERS)[number])) {
      parts.push(current)
      current = ''
    } else if (ch >= '0' && ch <= '9') {
      current += ch
    } else {
      // A comma or period inside the head alongside spacers: two separator
      // systems in one number. Ambiguous.
      return null
    }
  }
  parts.push(current)
  if (!isGroupedInteger(parts)) return null
  return parts.join('') + tail
}

/**
 * Splits a `major`/`fraction` pair out of a token containing only digits, `.`
 * and `,`, or returns null when the two readings cannot be told apart.
 *
 * THE HARD CASE is a single separator followed by exactly three digits.
 * `1,500` is one thousand five hundred in en-US and one and a half in de-DE.
 * The resolver is the currency's minor-unit count, which is why
 * `hints.currency` matters:
 *   2 minor digits (USD, EUR) → a decimal separator cannot be followed by three
 *     digits and still be minor units, so it is a GROUP separator → 1500.
 *   0 minor digits (JPY)      → same conclusion → 4900, per §3.11's `¥4,900`.
 *   3 minor digits (KWD, BHD) → both readings are valid → AMBIGUOUS → null.
 */
function splitMajorFraction(
  token: string,
  minorDigits: number,
): { major: string; fraction: string } | null {
  const dots = token.split('.').length - 1
  const commas = token.split(',').length - 1

  if (dots === 0 && commas === 0) return { major: token, fraction: '' }

  if (dots > 0 && commas > 0) {
    // The LAST separator is the decimal point; the other groups.
    const decimal = token.lastIndexOf('.') > token.lastIndexOf(',') ? '.' : ','
    const group = decimal === '.' ? ',' : '.'
    const decimalAt = token.lastIndexOf(decimal)
    const head = token.slice(0, decimalAt)
    const fraction = token.slice(decimalAt + 1)
    if (fraction.length === 0 || head.includes(decimal)) return null
    if (!isGroupedInteger(head.split(group))) return null
    return { major: head.split(group).join(''), fraction }
  }

  const separator = dots > 0 ? '.' : ','
  const count = dots > 0 ? dots : commas
  const parts = token.split(separator)

  if (count > 1) {
    // Repeated separators can only be group separators.
    return isGroupedInteger(parts) ? { major: parts.join(''), fraction: '' } : null
  }

  const left = parts[0] ?? ''
  const right = parts[1] ?? ''
  if (left.length === 0 || right.length === 0) return null

  if (right.length === 3 && isGroupedInteger(parts)) {
    if (minorDigits === 3) return null // genuinely ambiguous; fail closed
    return { major: left + right, fraction: '' }
  }
  return { major: left, fraction: right }
}

/** Converts a validated major/fraction pair to integer minor units, or null. */
function toMinorUnits(major: string, fraction: string, minorDigits: number): number | null {
  let frac = fraction
  if (frac.length > minorDigits) {
    // Extra precision is acceptable only when it is all zeros: `JPY 4900.00` is
    // 4900, but `USD 1.4990` states a sub-cent price we cannot represent.
    const extra = frac.slice(minorDigits)
    if (/[^0]/.test(extra)) return null
    frac = frac.slice(0, minorDigits)
  }
  frac = frac.padEnd(minorDigits, '0')
  const digits = (major + frac).replace(/^0+(?=\d)/, '')
  if (digits.length > MAX_SIGNIFICANT_DIGITS) return null
  const value = Number.parseInt(digits, 10)
  return Number.isSafeInteger(value) ? value : null
}

// ---------------------------------------------------------------------------
// Currency resolution
// ---------------------------------------------------------------------------

interface CurrencyContext {
  /** Text before the number run, qualifiers already stripped. */
  before: string
  /** Text after the number run. */
  after: string
}

/** The ISO code immediately adjacent to the number, or null; `false` on conflict. */
function adjacentIsoCode(ctx: CurrencyContext): string | null | false {
  const beforeMatch = /([A-Z]{3})\s?$/.exec(ctx.before)
  const afterMatch = /^\s?([A-Z]{3})(?![A-Za-z])/.exec(ctx.after)
  const codes: string[] = []
  for (const match of [beforeMatch, afterMatch]) {
    const code = match?.[1]
    if (code !== undefined && ISO_4217.has(code) && !codes.includes(code)) codes.push(code)
  }
  if (codes.length > 1) return false
  return codes[0] ?? null
}

/** Trailing minus sign, removed so `$-5.00` still sees its `$` as adjacent. */
function stripTrailingSign(text: string): string {
  const trimmed = text.trimEnd()
  return /[-−]$/.test(trimmed) ? trimmed.slice(0, -1).trimEnd() : trimmed
}

/** The currency symbol immediately adjacent to the number, or null; `false` on conflict. */
function adjacentSymbol(ctx: CurrencyContext): string | null | false {
  const before = stripTrailingSign(ctx.before)
  const after = ctx.after.trimStart()
  const found: string[] = []
  for (const symbol of SYMBOLS_BY_LENGTH) {
    if (before.endsWith(symbol) && !found.some((s) => s.endsWith(symbol))) found.push(symbol)
  }
  for (const symbol of SYMBOLS_BY_LENGTH) {
    if (after.startsWith(symbol) && !found.some((s) => s.startsWith(symbol))) found.push(symbol)
  }
  if (found.length > 1) return false
  return found[0] ?? null
}

/** Applies `hints.currency` to a symbol that denotes more than one currency. */
function resolveSymbol(symbol: string, hint: string | undefined): string | null {
  const entry = SYMBOLS[symbol]
  if (entry === undefined) return null
  if (hint !== undefined) {
    const upper = hint.toUpperCase()
    if (upper === entry.fallback || entry.alternatives.includes(upper)) return upper
  }
  return entry.fallback
}

// ---------------------------------------------------------------------------
// Text preparation
// ---------------------------------------------------------------------------

interface Prepared {
  text: string
  qualified: boolean
}

/** Collapses every whitespace variant to a single plain space and trims. */
function normalizeSpaces(text: string): string {
  return text.replace(SPACE_RE, ' ').replace(/ {2,}/g, ' ').trim()
}

/** Strips one leading and one trailing qualifier, recording that it was there. */
function stripQualifiers(text: string): Prepared {
  let out = text
  let qualified = false

  const lower = out.toLowerCase()
  for (const phrase of PREFIX_QUALIFIERS) {
    if (!lower.startsWith(phrase)) continue
    const next = out.charAt(phrase.length)
    if (next !== '' && /[a-z]/i.test(next)) continue
    out = out.slice(phrase.length).trim()
    qualified = true
    break
  }

  const lowerEnd = out.toLowerCase()
  for (const phrase of SUFFIX_QUALIFIERS) {
    if (!lowerEnd.endsWith(phrase)) continue
    const prev = out.charAt(out.length - phrase.length - 1)
    if (/[a-z]/i.test(prev)) continue
    out = out.slice(0, out.length - phrase.length).trim()
    qualified = true
    break
  }

  return { text: out, qualified }
}

/**
 * Splits a range into its two operands, or returns null when the text is not a
 * range.
 *
 * The rule is EXACTLY ONE separator in the whole string, with digits on both
 * sides. `1-800-555-1212` has three and `2024-01-15` has two, so neither is a
 * range — and neither survives the one-number rule afterwards either.
 */
function splitRange(text: string): [string, string] | null {
  let separatorIndex = -1
  let separatorLength = 0
  let count = 0

  for (const dash of RANGE_DASHES) {
    let at = text.indexOf(dash)
    while (at !== -1) {
      count++
      if (count === 1) {
        separatorIndex = at
        separatorLength = dash.length
      }
      at = text.indexOf(dash, at + dash.length)
    }
  }

  if (count === 0) {
    const word = / to /i.exec(text)
    if (word === null) return null
    separatorIndex = word.index
    separatorLength = word[0].length
  } else if (count > 1) {
    return null
  }

  const left = text.slice(0, separatorIndex).trim()
  const right = text.slice(separatorIndex + separatorLength).trim()
  if (!/\d/.test(left) || !/\d/.test(right)) return null
  return [left, right]
}

// ---------------------------------------------------------------------------
// Single-operand parsing
// ---------------------------------------------------------------------------

function parseOperand(text: string, hints: MoneyHints | undefined): Money | null {
  if (text.includes('%')) return null // `20% off` is not a price

  // Exactly one number, or we cannot tell which one is the price.
  NUMBER_RUN_RE.lastIndex = 0
  const runs: { value: string; start: number; end: number }[] = []
  let match: RegExpExecArray | null
  while ((match = NUMBER_RUN_RE.exec(text)) !== null) {
    let value = match[0]
    // The run regex is greedy over separators; a run must end on a digit.
    while (value.length > 0 && !/\d$/.test(value)) value = value.slice(0, -1)
    runs.push({ value, start: match.index, end: match.index + value.length })
    if (runs.length > 1) return null
  }
  const run = runs[0]
  if (run === undefined) return null

  const ctx: CurrencyContext = { before: text.slice(0, run.start), after: text.slice(run.end) }

  const isoCode = adjacentIsoCode(ctx)
  if (isoCode === false) return null
  const symbol = adjacentSymbol(ctx)
  if (symbol === false) return null

  let currency: string | null
  if (isoCode !== null && symbol !== null) {
    // Both present: they must agree. `$49.00 USD` is fine; `$49.00 EUR` is not.
    const fromSymbol = resolveSymbol(symbol, isoCode)
    if (fromSymbol !== isoCode) return null
    currency = isoCode
  } else if (isoCode !== null) {
    currency = isoCode
  } else if (symbol !== null) {
    currency = resolveSymbol(symbol, hints?.currency)
  } else {
    // No marker at all. `hints.currency` may supply one, but ONLY when the text
    // is a bare number: with a hint of USD, `1499` is a price and `4.5 stars`
    // is not, and the difference is the letters.
    const hint = hints?.currency?.toUpperCase()
    if (hint === undefined || !ISO_4217.has(hint)) return null
    if (/[A-Za-z]/.test(ctx.before + ctx.after)) return null
    currency = hint
  }
  if (currency === null || !ISO_4217.has(currency)) return null

  const negative = /[-−]\s?$/.test(stripTrailingSymbol(ctx.before))

  const spaced = stripGroupSpacers(run.value)
  if (spaced === null) return null
  const split = splitMajorFraction(spaced, minorUnitDigits(currency))
  if (split === null) return null
  const magnitude = toMinorUnits(split.major, split.fraction, minorUnitDigits(currency))
  if (magnitude === null) return null

  return { amount: negative ? -magnitude : magnitude, currency }
}

/** Removes a trailing currency symbol so a sign in front of it is still visible. */
function stripTrailingSymbol(before: string): string {
  const trimmed = before.trimEnd()
  for (const symbol of SYMBOLS_BY_LENGTH) {
    if (trimmed.endsWith(symbol)) return trimmed.slice(0, trimmed.length - symbol.length)
  }
  return trimmed
}

// ---------------------------------------------------------------------------
// parseMoneyText
// ---------------------------------------------------------------------------

/**
 * Text → `Money`, or `null` when ambiguous. Fails closed, like `formatMoney`.
 *
 * Ranges and qualifiers return the lower bound with `qualified: true`, which
 * excludes them from the D2.4 parity comparison.
 */
export function parseMoneyText(text: string, hints?: MoneyHints): ParsedMoney | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_INPUT_LENGTH) return null

  const normalized = normalizeSpaces(text)
  if (!/\d/.test(normalized)) return null

  const prepared = stripQualifiers(normalized)
  const range = splitRange(prepared.text)

  if (range === null) {
    const single = parseOperand(prepared.text, hints)
    return single === null ? null : { ...single, qualified: prepared.qualified }
  }

  // A range. Only one end usually carries the currency — `$148 – 198` and
  // `148 to 198 USD` are both common — so each end is retried with the other's
  // currency before giving up. The result is the numerically LOWER end, always
  // `qualified`.
  const [leftText, rightText] = range
  let left = parseOperand(leftText, hints)
  const right = parseOperand(rightText, left === null ? hints : { currency: left.currency })
  if (left === null && right !== null) left = parseOperand(leftText, { currency: right.currency })

  if (left !== null && right !== null) {
    if (left.currency !== right.currency) return null
    const lower = right.amount < left.amount ? right : left
    return { ...lower, qualified: true }
  }
  const only = left ?? right
  return only === null ? null : { ...only, qualified: true }
}
