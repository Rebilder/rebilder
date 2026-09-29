/**
 * Byte-budget, heading, and markdown-escaping primitives shared by every
 * renderer in this package.
 *
 * These helpers were extracted from `src/markdown.ts` verbatim when the
 * universal document renderers were added. The extraction is not cosmetic:
 * the commerce renderers and the document renderers must truncate by exactly
 * the same rule, and two copies of a truncation loop is two truncation
 * behaviours that will drift the first time one of them is "improved". The
 * code below is byte-for-byte the code that shipped inside `src/markdown.ts`;
 * `tests/commerce-frozen.test.ts` pins the commerce renderers' output with
 * inline string literals and is the proof that the move changed nothing.
 *
 * Package-internal. Nothing here is re-exported from `src/index.ts` — these
 * are implementation primitives, not part of the public contract.
 */

/** Default output size budget in UTF-8 bytes, shared by every renderer. */
export const DEFAULT_MAX_BYTES = 5120

/**
 * Fixed meta note appended when output is truncated to fit the size budget.
 * Pure rendering metadata — contains no prices, claims, or policy text.
 */
export const TRUNCATION_NOTE = '*Truncated to fit size budget; remaining content omitted.*'

const encoder = new TextEncoder()

export function byteLength(s: string): number {
  return encoder.encode(s).length
}

export function clampHeadingLevel(level: number): number {
  return Math.min(Math.max(Math.trunc(level), 1), 6)
}

export function heading(level: number, text: string): string {
  return `${'#'.repeat(clampHeadingLevel(level))} ${text}`
}

/**
 * Keep verbatim source text on a single markdown line (inline contexts only:
 * fact lines, table cells). Collapses newlines to spaces; block contexts
 * (description, policy bodies) stay byte-for-byte verbatim.
 */
export function inline(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ')
}

/** Escape characters that would break a markdown table cell. Otherwise verbatim. */
export function cell(text: string): string {
  return inline(text).replace(/\|/g, '\\|')
}

/**
 * The URL schemes a rendered link may carry. A `javascript:`/`data:`/`vbscript:`
 * link handed to an agent (or a downstream HTML renderer) is a
 * scheme-smuggling / phishing primitive, so any other scheme is dropped. This
 * matches the document renderer's `isAllowedUrl` (documents/facts.ts) — the
 * commerce renderers must not be the weaker path.
 */
const ALLOWED_LINK_SCHEMES: readonly string[] = ['https:', 'http:', 'mailto:', 'tel:']

/** True when `url` parses and carries an allowed scheme. */
export function isSafeUrl(url: string): boolean {
  try {
    return ALLOWED_LINK_SCHEMES.includes(new URL(url).protocol)
  } catch {
    return false
  }
}

/**
 * Escape the characters that let link TEXT break out of `[label](url)` and
 * forge a different target: `]` (which closes the label early) and `[`. `inline`
 * first, so a newline cannot smuggle structure either.
 *
 * Parentheses are deliberately NOT escaped here. They are harmless inside a
 * label — the label is delimited by brackets — and product titles legitimately
 * contain them ("Wool Socks (3-pack)"). Escaping them would put backslashes in
 * front of a large fraction of real catalogs, which is visible damage to every
 * honest row to defend against nothing. The URL side is handled by `safeUrl`.
 */
export function linkText(text: string): string {
  return inline(text).replace(/[[\]]/g, (c) => `\\${c}`)
}

/**
 * The URL as it may appear inside `](...)`. A URL carrying `)` would close the
 * link early and leave the remainder as live markdown — `https://x.example/)
 * [click](https://evil.example` renders as TWO links, the second one the
 * attacker's. Percent-encoding the delimiters keeps the URL working and the
 * structure ours. (Angle-bracket link syntax would be the alternative; encoding
 * keeps the output diff-stable for every URL that does not contain them.)
 */
function safeUrl(url: string): string {
  // NOT `encodeURIComponent`: it leaves `(` and `)` untouched (they are in its
  // unreserved set), which is exactly the pair that closes a markdown link —
  // so using it here would look like a fix and do nothing. Percent-encode the
  // delimiters explicitly.
  return url.replace(
    /[()<>\s]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  )
}

/**
 * Link text inside a table cell: both escapes, not either. `cell` alone leaves
 * `](` free to forge a link; `linkText` alone leaves `|` free to forge a
 * column. A catalog row is the one place both matter.
 */
export function cellLinkText(text: string): string {
  return linkText(text).replace(/\|/g, '\\|')
}

/**
 * A markdown link with the label escaped and the URL scheme-checked. When the
 * URL is not a safe scheme the label renders as plain (escaped) text rather
 * than a clickable link — the substance is kept, the smuggled scheme is not.
 * `labelEscaper` lets a table cell escape `|` as well.
 */
export function safeLink(
  label: string,
  url: string,
  labelEscaper: (text: string) => string = linkText,
): string {
  const text = labelEscaper(label)
  return isSafeUrl(url) ? `[${text}](${safeUrl(url)})` : text
}

/** A bottom-of-page section that may be truncated (whole lines only). */
export interface TailSection {
  headingLine: string
  items: string[]
}

function tailText(t: TailSection): string {
  return `${t.headingLine}\n\n${t.items.join('\n')}`
}

/**
 * Join required blocks + tail sections, enforcing the byte budget.
 *
 * Truncation is strictly from the bottom: required blocks (the front-loaded
 * buying facts and the variants table) are never dropped, tail sections are
 * re-added top-down until the budget (minus the truncation note) is exhausted,
 * and a cut always ends the document — nothing renders after it. Items are
 * whole lines; nothing is ever cut mid-fact.
 *
 * If the required blocks alone exceed the budget, they are emitted anyway
 * (facts are never sacrificed to the byte budget) followed by the note.
 */
export function assembleWithBudget(
  requiredBlocks: string[],
  tail: TailSection[],
  maxBytes: number,
): string {
  const full = [...requiredBlocks, ...tail.map(tailText)].join('\n\n')
  if (byteLength(full) <= maxBytes) return full

  const noteSuffix = `\n\n${TRUNCATION_NOTE}`
  const budget = maxBytes - byteLength(noteSuffix)
  let out = requiredBlocks.join('\n\n')
  for (const section of tail) {
    const whole = `${out}\n\n${tailText(section)}`
    if (byteLength(whole) <= budget) {
      out = whole
      continue
    }
    // Section does not fit whole: add as many complete lines as fit.
    let partial = `${out}\n\n${section.headingLine}`
    let added = 0
    for (const item of section.items) {
      const next = `${partial}${added === 0 ? '\n\n' : '\n'}${item}`
      if (byteLength(next) > budget) break
      partial = next
      added += 1
    }
    if (added > 0) out = partial
    break // truncate strictly from the bottom — nothing may appear after the cut
  }
  return `${out}${noteSuffix}`
}
