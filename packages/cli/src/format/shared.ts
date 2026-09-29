/**
 * format/shared.ts — the small vocabulary every formatter needs, in one place so
 * the four of them cannot drift.
 *
 * THE RULE THIS FILE EXISTS TO MAKE MECHANICAL (scorer determinism): a
 * heuristic value never renders without its label. Not "usually", not "in the
 * detailed view" — never. So `basisLabel()` is the only way any formatter gets
 * the word, `approxTokens()` is the only way any formatter prints a token count
 * and it always carries `≈` and `est.`, and `bytesText()` is the only way any
 * formatter prints a byte figure and it renders `≥ N` whenever the capture was
 * truncated. A formatter that wants to print one of these without its label has
 * to write the code to do it, which is a diff a reviewer can see.
 */

import type { ArsBasis, ArsCheck } from '@rebilder/agent-readability'

export interface FormatContext {
  unicode: boolean
  generatedAt: string
  /** The CLI's own version, printed so a report can be traced to a build. */
  cliVersion: string
}

/**
 * The "there is no value here" placeholder. It respects the Unicode capability
 * for the same reason the box glyphs do: an em dash in a `LANG=C` container is
 * mojibake, and mojibake in a build log reads as a crash.
 */
export function absent(unicode: boolean): string {
  return unicode ? '\u2014' : '-'
}

/** Never abbreviated to "H"/"M". The whole point is that it is readable. */
export function basisLabel(basis: ArsBasis): string {
  return basis === 'heuristic' ? 'heuristic' : 'measured'
}

/**
 * Decoded UTF-8 bytes. `truncated` turns the number into a lower bound, because
 * silently reporting a truncated body as a total makes the heaviest pages look
 * cheapest on D3.2 — the one number the product is built on (§3.3).
 */
export function bytesText(bytes: number | null, truncated: boolean, unicode: boolean): string {
  if (bytes === null) return absent(unicode)
  const formatted = `${bytes.toLocaleString('en-US')} B`
  if (!truncated) return formatted
  return `${unicode ? '≥' : '>='} ${formatted} (truncated at the 2 MiB cap)`
}

/**
 * chars/4. A heuristic, and labelled as one every single time it appears —
 * "chars/4 isn't a token count" is a fair objection and the answer is to stop
 * pretending otherwise, not to argue (§3.8).
 */
export function approxTokens(tokens: number | null, unicode: boolean): string {
  if (tokens === null) return absent(unicode)
  return `${unicode ? '≈' : '~'}${tokens.toLocaleString('en-US')} tokens (est.)`
}

export function percent(numerator: number, denominator: number): string {
  if (denominator === 0) return '0%'
  return `${Math.round((numerator * 100) / denominator)}%`
}

/** ✔ full marks · ◐ partial · ✘ nothing earned. */
export function checkMark(check: ArsCheck, unicode: boolean): string {
  if (check.earned >= check.weight) return unicode ? '✔' : '+'
  if (check.earned > 0) return unicode ? '◐' : '~'
  return unicode ? '✘' : 'x'
}

export function shortHash(hash: string): string {
  return hash.slice(0, 12)
}

/** XML text-node / attribute escaping. Used by the JUnit writer. */
export function escapeXml(text: string): string {
  return (
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // Control characters are illegal in XML 1.0 even escaped; a page title with
      // a stray 0x08 in it would otherwise produce a file no CI parser will read.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  )
}

/** Markdown table-cell escaping: a `|` in a URL otherwise splits the row. */
export function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}
