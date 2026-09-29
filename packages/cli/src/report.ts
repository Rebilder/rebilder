/**
 * report.ts — one URL's outcome, and the mapping from that outcome to an exit
 * code.
 *
 * THIS FILE IS WHERE THE 1-vs-3 SPLIT IS ACTUALLY ENFORCED, so it is small on
 * purpose and there is a test asserting the property directly: for every
 * `ArsUnscoredReason`, every `ProbeRejection`, and the opt-out outcome, the code
 * is never `EXIT.THRESHOLD`. Only a real integer score, compared against a
 * threshold the operator asked for, produces 1.
 *
 * THE THREE-WAY SPLIT OF "WE DID NOT GET A SCORE" mirrors `ArsOutcome`:
 *  - `opt-out` — the site said no, deliberately and in well-formed robots. That
 *    is a choice, not a failure, and §3.6 gives it no letter grade. Exit 4.
 *  - `unscored` — a missing observation. Mostly transient (timeout, 5xx, edge
 *    challenge) so exit 3, EXCEPT `robots-disallow-scanner`, which is a
 *    deterministic refusal aimed at us and re-running will never change it.
 *  - a probe `rejection` — we never sent the request: unparseable URL (2, the
 *    operator's typo), guard refusal (4), exhausted budget (4).
 */

import type { ArsResult } from '@rebilder/agent-readability'
import type { ProbeRejection } from '@rebilder/agent-readability/probe'
import { EXIT, type ExitCode } from './exit'
import { GRADES, type Grade } from './args'

/**
 * `'probed'` means the probe returned an evidence bundle and `score()` judged it.
 * It does NOT mean the judgment was a grade: an unscored or opted-out result is a
 * `'probed'` report carrying an `ArsResult` whose `outcome.kind` says so. The
 * discriminant answers "did we get evidence", and `outcome.kind` answers "what
 * did the evidence say" — collapsing the two is how a 403 ends up rendered as an
 * F.
 */
export type UrlReport =
  | { kind: 'probed'; url: string; result: ArsResult }
  | { kind: 'rejected'; url: string; rejection: ProbeRejection; detail: string }

/** A .. F, best first. `indexOf` on this is the whole comparison. */
const ORDER: readonly Grade[] = GRADES

/**
 * `--fail-on C` means "C or better passes". A grade strictly worse than the
 * threshold fails; the threshold grade itself passes. Stated in the README with
 * the same sentence, because the off-by-one reading ("fail on C" = "C fails") is
 * the one people assume half the time.
 */
export function meetsThreshold(grade: Grade, failOn: Grade): boolean {
  return ORDER.indexOf(grade) <= ORDER.indexOf(failOn)
}

export function exitCodeFor(report: UrlReport, failOn: Grade | null): ExitCode {
  if (report.kind === 'rejected') {
    switch (report.rejection) {
      case 'invalid-url':
        return EXIT.USAGE
      case 'policy-rejected':
      case 'budget-exceeded':
        return EXIT.POLICY
    }
  }

  const { outcome } = report.result
  switch (outcome.kind) {
    case 'opt-out':
      return EXIT.POLICY
    case 'unscored':
      return outcome.reason === 'robots-disallow-scanner' ? EXIT.POLICY : EXIT.PROBE
    case 'scored':
      if (failOn === null) return EXIT.OK
      return meetsThreshold(outcome.grade, failOn) ? EXIT.OK : EXIT.THRESHOLD
  }
}

/* ── human-readable one-liners, shared by every formatter ─────────────────── */

const UNSCORED_TEXT: Record<string, string> = {
  'blocked-at-edge': 'blocked at the edge (403 or challenge) — the block is itself the finding',
  unreachable: 'unreachable',
  'non-2xx': 'the agent path did not return 2xx',
  'too-many-redirects': 'too many redirects',
  'robots-disallow-scanner': 'robots.txt disallows rebilder-ars — we obeyed it and did not score',
  'robots-unavailable':
    'robots.txt returned a persistent error; a policy we cannot read is not a policy we may assume',
  'truncated-evidence': 'the response exceeded the 2 MiB body cap and the evidence is incomplete',
  'evidence-incomplete': 'the evidence bundle is incomplete',
}

const REJECTION_TEXT: Record<ProbeRejection, string> = {
  'invalid-url': 'not a URL',
  'policy-rejected': 'refused by the URL guard',
  'budget-exceeded': 'the probe budget for this run is spent',
}

/** One line describing the outcome. No grade, no score — those render separately. */
export function outcomeSummary(report: UrlReport): string {
  if (report.kind === 'rejected') {
    return `${REJECTION_TEXT[report.rejection]}: ${report.detail}`
  }
  const { outcome } = report.result
  switch (outcome.kind) {
    case 'scored':
      return `${outcome.score}/100 ${outcome.grade}`
    case 'opt-out':
      return `OPT-OUT — a deliberate, well-formed robots disallow for the ${outcome.audience} audience. Not a failure and not a grade.`
    case 'unscored':
      return `UNSCORED — ${UNSCORED_TEXT[outcome.reason] ?? outcome.reason}${
        outcome.detail === undefined ? '' : ` (${outcome.detail})`
      }`
  }
}

/** `'scored' | 'opt-out' | 'unscored' | 'rejected'` — the coarse status. */
export function statusOf(report: UrlReport): 'scored' | 'opt-out' | 'unscored' | 'rejected' {
  return report.kind === 'rejected' ? 'rejected' : report.result.outcome.kind
}
