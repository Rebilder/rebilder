/**
 * Fact rendering: the deterministic `FactValue` → markdown mapping, the fixed
 * label maps, the URL scheme allowlist, and the escaping rules.
 *
 * This file is where the injection-only guarantee is actually enforced for the
 * universal path. Every rule below is mechanical rather than advisory, because
 * an advisory rule in a renderer is a rule that holds until the first hurried
 * patch:
 *
 * - Every renderer-authored string in this package is a named constant here.
 *   The whitelist in README.md is the list of these constants, and
 *   `tests/documents-integrity.test.ts` re-states that list as literals (not
 *   by importing these constants) so that adding scaffolding cannot silently
 *   whitelist itself.
 * - A malformed value is DROPPED, never repaired. Repairing a fact invents a
 *   value the merchant never stated (source validation); dropping it only loses
 *   information, which the agent can still get from the canonical page.
 * - URLs are checked against a scheme allowlist. The commerce path only ever
 *   emitted merchant-controlled product/policy URLs; the universal path emits
 *   arbitrary merchant-supplied link targets, and `[Click here](javascript:…)`
 *   handed to an agent under our formatting authority is a phishing primitive.
 * - Money throws rather than rounds or guesses, matching `formatMoney`. A
 *   thrown render is caught by the gateway and falls through to HTML; a
 *   silently wrong price is served forever.
 */

import { formatMoney } from '../money'
import { cell, heading, inline } from '../internal/budget'
import { isIsoDate } from '../internal/validate'
import type {
  BillingPeriod,
  DocumentAccess,
  Fact,
  FactValue,
  HoursException,
  HoursInterval,
  HoursSpec,
  Weekday,
} from './types'

/* ------------------------------------------------------------------ *
 * Fixed label maps — the only renderer-authored vocabulary.
 * ------------------------------------------------------------------ */

/** Fixed suffix per billing period. Format mapping of a closed enum, not content. */
export const PERIOD_SUFFIX: Record<BillingPeriod, string> = {
  one_time: 'one-time',
  hour: 'per hour',
  day: 'per day',
  week: 'per week',
  month: 'per month',
  quarter: 'per quarter',
  year: 'per year',
}

/** Fixed label map for booleans. */
export const BOOLEAN_LABELS: Record<'true' | 'false', string> = {
  true: 'Yes',
  false: 'No',
}

/** Fixed weekday labels. English only and deliberately not localised: the
 *  output is a machine-readable format transformation, and a locale would make
 *  the same source render differently for different requesters (consistent source content). */
export const WEEKDAY_LABELS: Record<Weekday, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
}

/** Fixed weekday order. Every one of the seven renders, always. */
export const WEEKDAY_ORDER: readonly Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]

/** `intervals: []` — the merchant stated the day and stated it is closed. */
export const CLOSED_LABEL = 'Closed'

/** Weekday absent from `weekly` — a different fact from `Closed`. */
export const NOT_STATED_LABEL = 'Not stated'

/** An `hours` fact is not a valid table cell; the row links out instead. */
export const SEE_PAGE_LABEL = 'See page'

/** Fixed labels used for structural bullets and table headers. */
export const UPDATED_LABEL = 'Updated'
export const PHONE_LABEL = 'Phone'
export const EMAIL_LABEL = 'Email'
export const ADDRESS_LABEL = 'Address'
export const DAY_LABEL = 'Day'
export const DATE_LABEL = 'Date'
export const HOURS_LABEL = 'Hours'
export const NOTE_LABEL = 'Note'
export const TITLE_LABEL = 'Title'

/** Fixed headings. */
export const EXCEPTIONS_HEADING = 'Exceptions'
export const CONTACT_HEADING = 'Contact'
export const ACTIONS_HEADING = 'Actions'
export const RELATED_HEADING = 'Related'
export const CONTENTS_HEADING = 'Contents'

/** Fixed access-level words used inside the single access notice sentence. */
export const ACCESS_LABELS: Record<DocumentAccess, string> = {
  free: 'free',
  registered: 'registration required',
  metered: 'metered',
  subscriber: 'subscription required',
}

/**
 * The fixed access notice. Emitted in place of `sections` whenever access is
 * not 'free'. It states only that the prose was not served and at what access
 * level — it never paraphrases the withheld text.
 */
export function accessNotice(access: DocumentAccess): string {
  return `*Full text is not served to agents at this URL (access: ${ACCESS_LABELS[access]}).*`
}

/** The fixed timezone sentence rendered above every hours table. */
export function timeZoneSentence(timeZone: string): string {
  return `All times are local to ${inline(timeZone)}.`
}

/* ------------------------------------------------------------------ *
 * URL scheme allowlist and escaping.
 * ------------------------------------------------------------------ */

/** The only schemes this package will put behind a markdown link. */
export const ALLOWED_URL_SCHEMES: readonly string[] = ['https:', 'http:', 'mailto:', 'tel:']

/**
 * True when `raw` is an absolute URL with an allowlisted scheme. Relative URLs
 * are rejected: this package has no base URL to resolve them against, and
 * guessing one would emit a link the merchant never wrote.
 */
export function isAllowedUrl(raw: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  return ALLOWED_URL_SCHEMES.includes(parsed.protocol)
}

/**
 * Escape a markdown link label. `]`, `(`, and `)` would otherwise let source
 * text break out of the label and forge a link target.
 */
export function linkLabel(text: string): string {
  return inline(text).replace(/[\]()]/g, (c) => `\\${c}`)
}

/** `[label](url)` with the label escaped. Callers must allowlist `url` first. */
export function markdownLink(label: string, url: string): string {
  return `[${linkLabel(label)}](${url})`
}

/**
 * A markdown link safe to drop into a table cell. `cell()` cannot be used on a
 * finished link — it would escape nothing useful and `linkLabel` has already
 * run — so the `|` guard is applied on top instead.
 */
export function cellLink(label: string, url: string): string {
  return markdownLink(label, url).replace(/\|/g, '\\|')
}

/* ------------------------------------------------------------------ *
 * Value validation.
 * ------------------------------------------------------------------ */

/**
 * ISO 8601 date or datetime. Lives in `internal/validate.ts` since the
 * commerce renderers began accepting `updated` on the same terms; re-exported
 * here so this file stays the one place the document path imports value
 * validation from. (`export { … } from` would not bind the name locally, and
 * `factText` below calls it — hence the import plus re-export.)
 */
export { isIsoDate }

/** 'YYYY-MM-DD' only — the form `HoursException.date` is specified in. */
export function isIsoDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
}

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * A single interval is valid only if both ends are 'HH:MM' and it does not
 * wrap. Overnight spans are expressed as two intervals on two days; accepting
 * `22:00`–`02:00` here would make the same string mean two different things.
 */
function isValidInterval(i: HoursInterval): boolean {
  return HH_MM.test(i.opens) && HH_MM.test(i.closes) && i.closes > i.opens
}

function intervalsText(intervals: HoursInterval[]): string {
  return intervals.map((i) => `${i.opens}-${i.closes}`).join(', ')
}

/* ------------------------------------------------------------------ *
 * FactValue → text.
 * ------------------------------------------------------------------ */

function numberText(value: number, unit?: string): string | null {
  if (!Number.isFinite(value)) return null
  const text = String(value)
  // Exponential form ("1e+21") is a number an agent will misparse and a human
  // never wrote. Drop rather than reformat: reformatting invents digits.
  if (text.includes('e') || text.includes('E')) return null
  return unit !== undefined ? `${text} ${inline(unit)}` : text
}

function moneyText(v: Extract<FactValue, { type: 'money' }>): string {
  let text = formatMoney(v.value)
  if (v.maxValue !== undefined) {
    if (v.maxValue.currency.toUpperCase() !== v.value.currency.toUpperCase()) {
      throw new TypeError(
        `Money range currencies must match, got: ${v.value.currency} and ${v.maxValue.currency}`,
      )
    }
    if (v.maxValue.amount < v.value.amount) {
      throw new TypeError(
        `Money range maxValue must not be below value, got: ${String(v.value.amount)} and ${String(v.maxValue.amount)}`,
      )
    }
    text = `${text}-${formatMoney(v.maxValue)}`
  }
  if (v.period !== undefined) text = `${text} ${PERIOD_SUFFIX[v.period]}`
  if (v.per !== undefined) text = `${text} ${inline(v.per)}`
  return text
}

/**
 * Render a scalar fact value to its single-line inline form, or `null` when
 * the value is malformed (dropped) or is an `hours` value (rendered as its own
 * block, not as a fact line).
 *
 * Throws only for money ranges that are internally contradictory — see the
 * file header.
 */
export function factValueText(value: FactValue): string | null {
  switch (value.type) {
    case 'text':
      return inline(value.value)
    case 'list':
      return value.value.length > 0 ? value.value.map(inline).join(', ') : null
    case 'number':
      return numberText(value.value, value.unit)
    case 'boolean':
      return BOOLEAN_LABELS[value.value ? 'true' : 'false']
    case 'money':
      return moneyText(value)
    case 'date':
      return isIsoDate(value.value) ? value.value : null
    case 'url':
      if (!isAllowedUrl(value.value)) return null
      return value.label !== undefined ? markdownLink(value.label, value.value) : value.value
    case 'hours':
      return null
  }
}

/**
 * Render one fact as `- **Label:** value`, plus an indented note line when the
 * fact carries one. Returns `null` when the value is dropped or is an `hours`
 * value.
 */
export function renderFactLine(fact: Fact): string | null {
  const text = factValueText(fact.value)
  if (text === null) return null
  const line = `- **${inline(fact.label)}:** ${text}`
  return fact.note !== undefined ? `${line}\n  - ${inline(fact.note)}` : line
}

/**
 * Render a fact value as a table cell. Two differences from a fact line: every
 * cell is `|`-escaped, and an `hours` value degrades to a link to the item's
 * own page rather than trying to flatten a table into a cell.
 */
export function factCellText(value: FactValue, itemUrl: string): string | null {
  if (value.type === 'hours') {
    return isAllowedUrl(itemUrl) ? cellLink(SEE_PAGE_LABEL, itemUrl) : SEE_PAGE_LABEL
  }
  if (value.type === 'url') {
    if (!isAllowedUrl(value.value)) return null
    // Already an escaped link; only the `|` guard still applies.
    return value.label !== undefined
      ? cellLink(value.label, value.value)
      : value.value.replace(/\|/g, '\\|')
  }
  const text = factValueText(value)
  return text === null ? null : cell(text)
}

/* ------------------------------------------------------------------ *
 * Hours block.
 * ------------------------------------------------------------------ */

function exceptionRow(e: HoursException): string | null {
  if (!isIsoDay(e.date)) return null
  let hours: string
  if (e.closed === true) {
    hours = CLOSED_LABEL
  } else if (e.intervals !== undefined && e.intervals.length > 0) {
    if (!e.intervals.every(isValidInterval)) return null
    hours = intervalsText(e.intervals)
  } else if (e.intervals !== undefined) {
    hours = CLOSED_LABEL
  } else {
    hours = NOT_STATED_LABEL
  }
  const note = e.note !== undefined ? cell(e.note) : ''
  return `| ${e.date} | ${hours} | ${note} |`
}

/**
 * Render one `hours` fact as its own block, headed by the fact's own label.
 *
 * The heading is `Fact.label`, not a fixed "Hours": a clinic with "Office
 * hours" and "Lab hours" must not emit two identically-titled tables that an
 * agent cannot tell apart.
 *
 * All seven weekdays always render. An absent weekday is `Not stated` and a
 * present-but-empty one is `Closed`; collapsing those two into one label would
 * assert a closure the merchant never stated. Nothing here computes whether
 * the place is open now — that requires a clock and a timezone database, and a
 * wrong answer to "are they open" is worse than no answer.
 *
 * Returns `null` when the spec is malformed (missing timezone, or any invalid
 * interval anywhere in `weekly`). Partial hours are dropped whole: a table
 * missing the one day that was malformed reads as authoritative and is not.
 */
export function renderHoursBlock(
  label: string,
  spec: HoursSpec,
  level: number,
  subLevel: number,
): string | null {
  if (typeof spec.timeZone !== 'string' || spec.timeZone.trim() === '') return null

  const byDay = new Map<Weekday, HoursInterval[]>()
  for (const rule of spec.weekly) {
    if (!rule.intervals.every(isValidInterval)) return null
    byDay.set(rule.day, rule.intervals)
  }

  const lines: string[] = [
    heading(level, inline(label)),
    '',
    timeZoneSentence(spec.timeZone),
    '',
    `| ${DAY_LABEL} | ${HOURS_LABEL} |`,
    '| --- | --- |',
  ]
  for (const day of WEEKDAY_ORDER) {
    const intervals = byDay.get(day)
    const text =
      intervals === undefined
        ? NOT_STATED_LABEL
        : intervals.length === 0
          ? CLOSED_LABEL
          : intervalsText(intervals)
    lines.push(`| ${WEEKDAY_LABELS[day]} | ${text} |`)
  }

  if (spec.note !== undefined) {
    lines.push('', `- **${NOTE_LABEL}:** ${inline(spec.note)}`)
  }

  const exceptionRows = (spec.exceptions ?? [])
    .map(exceptionRow)
    .filter((row): row is string => row !== null)
  if (exceptionRows.length > 0) {
    lines.push(
      '',
      heading(subLevel, EXCEPTIONS_HEADING),
      '',
      `| ${DATE_LABEL} | ${HOURS_LABEL} | ${NOTE_LABEL} |`,
      '| --- | --- | --- |',
      ...exceptionRows,
    )
  }

  return lines.join('\n')
}
