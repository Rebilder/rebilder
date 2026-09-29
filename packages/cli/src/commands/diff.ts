/**
 * commands/diff.ts — what an agent got, next to what a browser got.
 *
 * ONE PROBE, TWO VIEWS. The evidence bundle already contains both requests
 * (§3.3: an agent probe and a browser control that differ in `Accept` and in
 * nothing else), so `diff` re-uses the bundle a `check` would have produced
 * rather than issuing its own pair. That is not only cheaper — it is the only
 * way the two commands can agree, and a diff that disagreed with the score would
 * be worse than no diff.
 *
 * IT SHOWS SHAPE, NOT CONTENT. Status, content type, decoded bytes, an estimated
 * token count, redirect count, and the D2.4 substance-parity check verbatim. No
 * body excerpt on either side. The temptation is obvious — "here is your HTML,
 * here is your markdown" is a great demo — but dumping a third party's page into
 * a terminal, a CI log, or a `--out` file is a copyright problem the numbers do
 * not have, and §5.3 is explicit that structure and numbers are what we show.
 *
 * The parity check is rendered from `ArsResult`, not recomputed here. §3.8's
 * comparison is normative and narrow (price, currency, availability and title
 * only, post-normalisation, never free text); reimplementing it in a CLI would
 * produce a second opinion with no fixture behind it.
 */

import { score } from '@rebilder/agent-readability'
import type {
  ArsCheck,
  ArsEvidence,
  ArsHttpCapture,
  ArsProbeRecord,
  ArsResult,
} from '@rebilder/agent-readability'
import type { DiffCommand } from '../args'
import type { DiffPayload, DiffSide } from '../payload'
import type { UrlReport } from '../report'
import type { ProbeRunner } from '../runtime'

const PARITY_CHECK_ID = 'machine-representation.substance-parity'

export async function runDiff(command: DiffCommand, probe: ProbeRunner): Promise<DiffPayload> {
  const outcome = await probe(command.url)

  if (!outcome.ok) {
    const report: UrlReport = {
      kind: 'rejected',
      url: command.url,
      rejection: outcome.rejection,
      detail: outcome.detail,
    }
    return { url: command.url, agent: null, browser: null, parity: null, result: null, report }
  }

  const result = score(outcome.evidence)
  const report: UrlReport = { kind: 'probed', url: command.url, result }

  return {
    url: command.url,
    agent: sideOf(outcome.evidence, 'agent'),
    browser: sideOf(outcome.evidence, 'browser'),
    parity: parityCheck(result),
    result,
    report,
  }
}

function parityCheck(result: ArsResult): ArsCheck | null {
  for (const dimension of result.dimensions) {
    for (const check of dimension.checks) {
      if (check.id === PARITY_CHECK_ID) return check
    }
  }
  return null
}

function sideOf(evidence: ArsEvidence, role: 'agent' | 'browser'): DiffSide {
  const record: ArsProbeRecord = evidence.probes[role]
  const accept = record.requestHeaders['accept'] ?? '(none)'

  if (!record.result.ok) {
    return {
      role,
      accept,
      status: null,
      contentType: null,
      bytes: null,
      approxTokens: null,
      truncated: false,
      redirects: 0,
      error: `${record.result.error}${record.result.detail === undefined ? '' : `: ${record.result.detail}`}`,
    }
  }

  const capture: ArsHttpCapture = record.result.capture
  return {
    role,
    accept,
    status: capture.status,
    contentType: capture.headers['content-type']?.[0] ?? null,
    bytes: capture.bytes,
    approxTokens: approxTokensOf(capture),
    truncated: capture.truncated,
    redirects: capture.redirects.length,
    error: null,
  }
}

/**
 * chars/4, the same heuristic `ArsCostReport` uses, computed from the decoded
 * body when it is in hand and from the byte count otherwise. It is labelled
 * `est.` everywhere it renders — "chars/4 isn't a token count" is a fair
 * objection and the answer is the label, not an argument (§3.8).
 */
function approxTokensOf(capture: ArsHttpCapture): number {
  const characters = capture.body?.length ?? capture.bytes
  return Math.round(characters / 4)
}
