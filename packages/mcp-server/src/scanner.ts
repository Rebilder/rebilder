/**
 * scanner.ts — the probe, wired for a process that lives on somebody's laptop.
 *
 * WHAT IS DIFFERENT ABOUT THIS CONSUMER. The hosted scanner fetches strangers'
 * origins from our IP space, so its risk is SSRF and amplification. This one
 * fetches from the user's own machine, which deletes both of those for this
 * component (design §5.6) — and leaves one that people forget: our User-Agent is
 * on every one of those requests. A thousand developers running an assistant
 * that hammers an origin is our reputation being spent, from addresses we do not
 * control and cannot rate-limit. Hence:
 *
 *  - THE POLITENESS LIMITER IS NOT OPTIONAL AND NOT REACHABLE FROM A TOOL CALL.
 *    `createDefaultScanner` builds it; no tool input schema has a field that
 *    touches it. The only override is `REBILDER_MCP_PROBE_BUDGET`, an
 *    environment variable — which is to say, a decision made by the human who
 *    launched the process, not by a model reading a web page mid-conversation.
 *    That distinction is the whole point (§5.2).
 *
 *  - `probeStrict` ONLY. `probeLocal` — private hosts, plaintext http — is not
 *    imported here and must never be. §5.2 names this exact scenario: "an MCP
 *    server on a developer's machine with private hosts allowed, driven by a
 *    model whose context contains untrusted web text, will fetch
 *    http://169.254.169.254/ on request." The CLI has `--allow-private` because
 *    a human types it. A conversation has no equivalent, so there is no flag.
 *
 * The budget is a SOFT cap: one MCP session is one "run", and a session that
 * scans five cold URLs is doing normal work. 20 requests is roughly four cold
 * scans (§3.3 sends five requests per URL), so the default is low enough to
 * bound an accident and the error message says exactly how to raise it.
 */

import {
  createLimiter,
  probeStrict,
  strictPolicy,
  type ProbeOutcome,
  type ProbePolicy,
} from '@rebilder/agent-readability/probe'
import type { ArsVantage } from '@rebilder/agent-readability'

export interface Scanner {
  scan(target: string, vantage: ArsVantage): Promise<ProbeOutcome>
}

/** The limiter default in `@rebilder/agent-readability` — about four cold URLs. */
export const DEFAULT_PROBE_BUDGET = 20
export const MIN_PROBE_BUDGET = 5
export const MAX_PROBE_BUDGET = 500
export const PROBE_BUDGET_ENV = 'REBILDER_MCP_PROBE_BUDGET'

/**
 * Parses the one override. Anything unparseable falls back to the default
 * rather than throwing: refusing to start because of a typo in an env var is a
 * worse failure than scanning politely.
 */
export function probeBudgetFromEnv(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PROBE_BUDGET
  const parsed = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_PROBE_BUDGET
  return Math.min(MAX_PROBE_BUDGET, Math.max(MIN_PROBE_BUDGET, parsed))
}

export interface DefaultScannerOptions {
  /** Requests per session. Clamped. Comes from the environment, never from a tool call. */
  readonly maxProbesPerRun?: number
}

/**
 * One limiter per server, because one MCP session is one run. Deliberately NOT
 * module-global: two servers in one process (tests, or a future supervisor) must
 * not share a budget, and a module-level counter in a long-lived process starts
 * refusing unrelated work on its twenty-first scan with no signal (§5.2).
 */
export function createDefaultScanner(options: DefaultScannerOptions = {}): Scanner {
  const budget = Math.min(
    MAX_PROBE_BUDGET,
    Math.max(MIN_PROBE_BUDGET, options.maxProbesPerRun ?? DEFAULT_PROBE_BUDGET),
  )
  const policy: ProbePolicy = strictPolicy(createLimiter({ maxProbesPerRun: budget }))
  return {
    scan: (target: string, vantage: ArsVantage): Promise<ProbeOutcome> =>
      probeStrict(target, policy, { vantage }),
  }
}
