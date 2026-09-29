/**
 * commands/check.ts — probe, score, report. The command everything else exists
 * to support.
 *
 * IT DOES TWO THINGS AND NEITHER OF THEM IS INTERPRETATION. `probe()` produces
 * an `ArsEvidence` bundle; `score()` turns that bundle into an `ArsResult`. This
 * file adds a concurrency pool and a URL loop and nothing else — no adjustment,
 * no rounding, no "close enough to a B". A CLI that post-processes the score is a
 * second implementation of the standard with no conformance corpus behind it.
 *
 * ONE PROBE FAILURE NEVER STOPS THE RUN. `rebilder check a b c` with `b`
 * unreachable still reports `a` and `c`; the exit code collapses per
 * `worstExit`. The alternative — abort on the first failure — makes a multi-URL
 * check useless in exactly the situation you want it, which is one flaky origin
 * in a set of ten.
 *
 * A `ProbeBudgetExceededError` is the exception, and deliberately so: it comes
 * back as a `budget-exceeded` rejection per URL rather than a thrown error, so
 * the URLs already probed still report.
 */

import { score } from '@rebilder/agent-readability'
import type { CheckCommand } from '../args'
import type { UrlReport } from '../report'
import type { ProbeRunner } from '../runtime'

export async function runCheck(command: CheckCommand, probe: ProbeRunner): Promise<UrlReport[]> {
  return mapWithConcurrency(command.urls, command.concurrency, (url) => probeOne(url, probe))
}

export async function probeOne(url: string, probe: ProbeRunner): Promise<UrlReport> {
  const outcome = await probe(url)
  if (!outcome.ok) {
    return { kind: 'rejected', url, rejection: outcome.rejection, detail: outcome.detail }
  }
  return { kind: 'probed', url, result: score(outcome.evidence) }
}

/**
 * A fixed-size worker pool that preserves input order in the output.
 *
 * Order matters more than it looks: `rebilder check a b c --format junit` writes
 * a file a human reads next to the command that produced it, and a report whose
 * suites come back in completion order changes shape between runs for no reason,
 * which makes every diff of two runs noise.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  const lanes = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      for (;;) {
        const index = next++
        if (index >= items.length) return
        const item = items[index]
        if (item === undefined) return
        results[index] = await worker(item, index)
      }
    },
  )

  await Promise.all(lanes)
  return results
}
