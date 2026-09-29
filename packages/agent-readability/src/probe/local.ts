/**
 * probe/local.ts — `"./probe/local"`. Private hosts and plain http, and NOTHING
 * that can be reached over HTTP.
 *
 * WHY THIS IS A SEPARATE ENTRY POINT THAT THROWS ON IMPORT, RATHER THAN A FLAG.
 *
 * The obvious design is `probe(url, { allowPrivateHosts: true })`. It is wrong,
 * and the reason is worth writing down because the wrong version looks fine in
 * review. `ProbePolicy` is a plain object that gets built once and reused. A
 * boolean on it is a boolean somebody will set to `true` — not maliciously, but
 * because they are wiring a new route, the local config already works, and
 * copying it is the obvious move. The moment that happens, an SSRF guard exists
 * in the codebase and is switched off in production, and nothing about the diff
 * looks like a security change.
 *
 * The concrete failure this prevents: `@rebilder/mcp-server` runs on a
 * developer's machine, inside their network, driven by a model whose context
 * contains web pages we did not write. "Check http://169.254.169.254/ for me"
 * arriving as text inside a scraped page is not a hypothetical — it is the
 * standard prompt-injection payload, and a company whose entire product is *what
 * agents read* cannot ship the tool that fetches it on request.
 *
 * So the permission is a capability, held three ways at once:
 *   1. It is a DIFFERENT MODULE. `probeStrict` cannot reach it; nothing that
 *      imports `"./probe"` gets it transitively.
 *   2. It THROWS AT IMPORT TIME unless the process was started with
 *      `--allow-private`. A process argument is not configuration: a serverless
 *      handler's argv is set by the platform, not by our env file or our JSON,
 *      so there is no way to switch this on from a dashboard or a `.env`.
 *   3. It REFUSES OUTRIGHT in a serverless/edge runtime, flag or no flag. If we
 *      are running inside a request handler, the answer is no, and there is no
 *      argument to be had about it.
 *
 * The permission is per invocation. `rebilder check --allow-private
 * http://staging.internal.corp` is a thing a developer chose to type on their own
 * machine. It is never a default, never an env var, and never inherited.
 *
 * NOTE ON THE PAIR OF GUARANTEES: the CLI and MCP server ship zero telemetry
 * (a project convention). That is not decoration next to this file — a probe
 * that reaches internal hostnames and a binary that uploads what it found are
 * only safe together as long as the second half stays false.
 */

import { ALLOW_PRIVATE_HOSTS } from './ssrf'
import {
  probeWithHostPolicy,
  strictPolicy,
  type ProbeOptions,
  type ProbeOutcome,
  type ProbePolicy,
} from './index'
import { type Limiter } from './limiter'
import type { ArsRuleset } from '../types'
import { DEFAULT_RULESET } from '../ruleset'

/** The one accepted opt-in. A CLI flag, on purpose: argv is not configuration. */
export const ALLOW_PRIVATE_FLAG = '--allow-private'

/**
 * Environment markers that mean "this process is serving HTTP requests". Any of
 * them present is a hard refusal: local mode exists for a human at a terminal.
 */
const HOSTED_RUNTIME_MARKERS = [
  'VERCEL',
  'NEXT_RUNTIME',
  'AWS_LAMBDA_FUNCTION_NAME',
  'AWS_EXECUTION_ENV',
  'FUNCTIONS_WORKER_RUNTIME',
  'K_SERVICE',
  'CF_PAGES',
] as const

function hostedRuntimeMarker(): string | null {
  for (const key of HOSTED_RUNTIME_MARKERS) {
    const value = process.env[key]
    if (typeof value === 'string' && value.length > 0) return key
  }
  return null
}

/**
 * The import-time gate. Runs on module evaluation — before anything can call
 * `probeLocal`, and before a bundler can tree-shake the check away from the
 * function it protects.
 */
function assertLocalModeUnlocked(): void {
  const hosted = hostedRuntimeMarker()
  if (hosted !== null) {
    throw new Error(
      `@rebilder/agent-readability/probe/local: refusing to load in a hosted runtime (${hosted} is set). ` +
        'Local mode allows private and loopback targets and must never be reachable from an HTTP transport. ' +
        'Use probeStrict() from "@rebilder/agent-readability/probe".',
    )
  }
  if (!process.argv.includes(ALLOW_PRIVATE_FLAG)) {
    throw new Error(
      `@rebilder/agent-readability/probe/local: refusing to load without ${ALLOW_PRIVATE_FLAG}. ` +
        'Private hosts, loopback, link-local and cloud-metadata addresses are reachable through this entry point, ' +
        'so the permission is per invocation and comes from the command line — not from a config object, ' +
        'not from an environment variable, and never by default.',
    )
  }
}

assertLocalModeUnlocked()

/**
 * The local policy: http allowed, non-standard ports allowed, private hosts
 * allowed. Everything else — the streamed byte cap, the redirect limit, the
 * timeout, the politeness limiter, the robots gate — is unchanged, because none
 * of those exist to protect us from ourselves.
 */
export function localPolicy(limiter: Limiter, ruleset: ArsRuleset = DEFAULT_RULESET): ProbePolicy {
  return { ...strictPolicy(limiter, ruleset), allowHttp: true }
}

/**
 * Probes a target that may be private, loopback, or plain http.
 *
 * `vantage` defaults to `'self'` rather than `'public'`: someone running this
 * against their own staging host is the operator of that host, and §3.7 says the
 * owner can consent for their own origin. It also means the `rebilder-ars`
 * robots gate does not apply, which is correct — you do not need your own
 * permission to read your own site.
 */
export function probeLocal(
  target: string,
  policy: ProbePolicy,
  options: ProbeOptions = {},
): Promise<ProbeOutcome> {
  return probeWithHostPolicy(target, policy, ALLOW_PRIVATE_HOSTS, {
    ...options,
    vantage: options.vantage ?? 'self',
  })
}
