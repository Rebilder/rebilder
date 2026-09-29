/**
 * exit.ts — the exit-code contract.
 *
 * THESE NUMBERS ARE A PUBLISHED INTERFACE (design §5.6). They are documented in
 * the README, they are what a CI file branches on, and they are NEVER
 * renumbered. Adding a code is a MINOR; changing what an existing one means is a
 * broken promise to every pipeline that already pinned it.
 *
 * THE 1-vs-3 SPLIT IS THE WHOLE POINT. `1` means "we scored this page and it did
 * not meet your threshold" — a fact about the site, actionable by the team that
 * owns it. `3` means "we never got a score" — DNS, a timeout, a 502, a captive
 * portal in CI. If a flaky network exits 1, the first red build that nobody can
 * explain gets the check deleted, and a deleted check protects nothing. So a
 * probe that never produced a bundle can never produce `1`, and there is a test
 * that asserts exactly that.
 *
 * `4` is the third thing that is not a score failure: we *chose* not to fetch,
 * or were told not to. An SSRF rejection, a robots disallow aimed at
 * `rebilder-ars`, a deliberate assistant opt-out, an exhausted probe budget.
 * Distinguishing it from 3 matters because 4 is deterministic and 3 is not:
 * re-running fixes a 3 and never fixes a 4.
 */

export const EXIT = {
  /** Completed; threshold met, or no threshold set. */
  OK: 0,
  /** Completed; threshold NOT met. Only ever produced by a real score. */
  THRESHOLD: 1,
  /** Usage error — unknown flag, bad value, missing argument, unparseable URL. */
  USAGE: 2,
  /** Probe failed / target unreachable. INFRASTRUCTURE, not a score failure. */
  PROBE: 3,
  /** Blocked by policy — SSRF guard, robots opt-out, exhausted probe budget. */
  POLICY: 4,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/**
 * Which code wins when one invocation covers several URLs.
 *
 * Ordered most-severe first and documented in the README, because "some passed
 * and some did not" has to collapse to one integer and an undocumented collapse
 * rule is a bug report waiting to happen. The ordering says: a mistake in the
 * command beats everything (2); a deterministic refusal beats a transient
 * failure, because re-running will not change it (4 over 3); and anything that
 * stopped us from getting a score beats a score we did get and disliked (3 over
 * 1) — the same reasoning as the 1-vs-3 split itself, applied across a set.
 */
const SEVERITY: readonly ExitCode[] = [EXIT.USAGE, EXIT.POLICY, EXIT.PROBE, EXIT.THRESHOLD, EXIT.OK]

export function worstExit(codes: readonly ExitCode[]): ExitCode {
  for (const candidate of SEVERITY) {
    if (codes.includes(candidate)) return candidate
  }
  return EXIT.OK
}

/** Thrown for anything that is the operator's mistake rather than the site's. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}
