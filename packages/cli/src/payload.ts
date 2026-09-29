/**
 * payload.ts — what a command produced, before anyone decided how to print it.
 *
 * The commands compute; the formatters render. Nothing in `commands/` knows
 * whether it is being asked for a terminal table or a JUnit file, and nothing in
 * `format/` knows how to reach a network. The seam exists because `--format`
 * multiplies the number of paths through the program by four, and the only way
 * to test four formats of five outcomes without twenty end-to-end runs is to be
 * able to build a payload in one line.
 */

import type { ArsCheck, ArsResult } from '@rebilder/agent-readability'
import type { Grade } from './args'
import type { UrlReport } from './report'

/** One side of `rebilder diff`: what the agent, or the browser, actually got. */
export interface DiffSide {
  role: 'agent' | 'browser'
  /** The only header that differs between the two probes (§3.3). */
  accept: string
  status: number | null
  contentType: string | null
  /** Decoded UTF-8 bytes — the normative measurement (§3.3). */
  bytes: number | null
  /** HEURISTIC: chars/4. Always rendered with ≈ and an "est." label. */
  approxTokens: number | null
  /** True when the 2 MiB cap was hit; bytes then render as "≥ N". */
  truncated: boolean
  redirects: number
  error: string | null
}

export interface DiffPayload {
  url: string
  /** `null` when the probe never produced a bundle. */
  agent: DiffSide | null
  browser: DiffSide | null
  /** The D2.4 substance-parity check, verbatim — the authoritative comparison. */
  parity: ArsCheck | null
  /** Present whenever the probe returned a bundle, even for an unscored outcome. */
  result: ArsResult | null
  report: UrlReport
}

export interface Scaffold {
  framework: string
  /** How the framework was determined. Printed: a guess that hides is a guess. */
  detection: string
  /** Suggested path for `--out`, relative to the working directory. */
  suggestedPath: string
  language: 'ts' | 'js' | 'toml'
  contents: string
  notes: readonly string[]
}

export interface BadgeSnippet {
  domain: string
  svgUrl: string
  pageUrl: string
  markdown: string
  html: string
  notes: readonly string[]
}

export type Payload =
  | { command: 'check'; reports: UrlReport[]; failOn: Grade | null }
  | { command: 'diff'; diff: DiffPayload }
  | { command: 'init'; scaffold: Scaffold }
  | { command: 'badge'; badge: BadgeSnippet }
