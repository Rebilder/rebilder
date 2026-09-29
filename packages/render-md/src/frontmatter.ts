/**
 * YAML frontmatter for a markdown document: the page's title, description,
 * canonical URL and last-updated date, as a block a caller can put in front of
 * any rendered markdown.
 *
 * OPT-IN. No renderer in this package calls it, so every existing output stays
 * byte-for-byte what it was. `@rebilder/gateway` prepends it only when a
 * merchant sets `frontmatter: true`.
 *
 * Same contract as the renderers:
 *
 * - Every value is injected verbatim from the caller's fields. Nothing is
 *   generated: no default title, no summary written from the body, no date
 *   from a clock. A field the caller does not have is absent from the block.
 * - Values are gated, never repaired. `canonicalUrl` must be an absolute
 *   `http:` or `https:` URL and `lastUpdated` a real ISO 8601 date or datetime;
 *   anything else is dropped.
 * - The four keys and the `---` fences are the only text this function adds.
 *
 * Scalars: a value is written bare when YAML reads it back as exactly that
 * string: one line, starting with a letter or digit, with no `: ` or ` #`, and
 * not a word or number YAML would turn into a boolean, null, number or date.
 * Everything else is double-quoted with JSON string escapes, which YAML
 * accepts. Bare where possible, because a bare value is byte-for-byte the
 * source text, so anything reading `description: …` as a labelled line sees
 * the same sentence the page states elsewhere rather than a quoted copy of it.
 * A newline, quote or `---` inside a value always lands inside quotes on one
 * line, so source text can never close the block early or add a key of its own.
 *
 * Bounded: a block over {@link FRONTMATTER_MAX_BYTES} drops `description`, the
 * one long free-text field; if it is still over, no frontmatter is returned.
 * The markdown body is never cut to make room.
 */

import { byteLength } from './internal/budget'
import { isIsoDate } from './internal/validate'

export interface FrontmatterFields {
  /** Page title, verbatim. Emitted as `title`. */
  title?: string
  /** Short description of the page, verbatim. Emitted as `description`. */
  description?: string
  /**
   * Absolute `http:` or `https:` URL of the canonical HTML page this markdown
   * represents. Emitted as `canonical_url`.
   */
  canonicalUrl?: string
  /** ISO 8601 date or datetime. Emitted as `last_updated`. */
  lastUpdated?: string
}

/** Largest frontmatter block, fences included, in UTF-8 bytes. */
export const FRONTMATTER_MAX_BYTES = 2048

/** A string with visible content, or null. Untyped input that is not a string is dropped. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function httpUrl(value: unknown): string | null {
  const raw = text(value)
  if (raw === null) return null
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? raw : null
  } catch {
    return null
  }
}

function isoDate(value: unknown): string | null {
  const raw = text(value)
  return raw !== null && isIsoDate(raw) ? raw : null
}

/**
 * A double-quoted YAML scalar, for any value that cannot be bare. JSON escapes
 * are a subset of YAML's, and
 * U+2028/U+2029 are escaped as well because some YAML 1.1 parsers read them
 * as line breaks. The two characters are built from code points so no
 * editor or tool can turn the pattern into a literal line break.
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)

function quoted(value: string): string {
  return JSON.stringify(value)
    .split(LINE_SEPARATOR)
    .join('\\u2028')
    .split(PARAGRAPH_SEPARATOR)
    .join('\\u2029')
}

/** Words YAML 1.1 or 1.2 would read as a boolean or null. */
const TYPED_WORD = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i
/** Anything YAML could read as a number (including hex, octal, sexagesimal) or a date. */
const NUMBER_LIKE = /^[0-9][0-9a-fA-FxXoO_.:+-]*$/
const DATE_LIKE = /^\d{4}-\d{1,2}-\d{1,2}/

/** Control characters, C1 controls, line/paragraph separators and the BOM. */
function hasUnprintable(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true
    if (code === 0x2028 || code === 0x2029 || code === 0xfeff) return true
  }
  return false
}

/** True when YAML reads the bare value back as exactly this string. */
function isPlainSafe(value: string): boolean {
  if (value !== value.trim() || hasUnprintable(value)) return false
  if (!/^[\p{L}\p{N}]/u.test(value)) return false
  if (value.includes(': ') || value.includes(' #') || value.endsWith(':')) return false
  return !TYPED_WORD.test(value) && !NUMBER_LIKE.test(value) && !DATE_LIKE.test(value)
}

function scalar(value: string): string {
  return isPlainSafe(value) ? value : quoted(value)
}

function block(entries: [string, string | null][]): string {
  const lines = entries
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([key, value]) => `${key}: ${scalar(value)}`)
  return lines.length === 0 ? '' : `---\n${lines.join('\n')}\n---\n`
}

/**
 * Render the frontmatter block, ending in a newline, or `''` when no field
 * survives validation. Put it first in the document: `block + '\n' + markdown`.
 */
export function renderFrontmatter(fields: FrontmatterFields): string {
  const title = text(fields.title)
  const canonical = httpUrl(fields.canonicalUrl)
  const updated = isoDate(fields.lastUpdated)
  const full = block([
    ['title', title],
    ['description', text(fields.description)],
    ['canonical_url', canonical],
    ['last_updated', updated],
  ])
  if (byteLength(full) <= FRONTMATTER_MAX_BYTES) return full
  const short = block([
    ['title', title],
    ['canonical_url', canonical],
    ['last_updated', updated],
  ])
  return byteLength(short) <= FRONTMATTER_MAX_BYTES ? short : ''
}
