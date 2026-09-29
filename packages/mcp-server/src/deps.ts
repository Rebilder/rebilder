/**
 * deps.ts — the wiring, in one place, reading the environment exactly once.
 *
 * The rest of `src/` never touches `process`: dependencies arrive as arguments,
 * which is what lets the whole protocol surface be tested with a fake scanner
 * and a fake index client and no globals. This file is the seam, and `bin.ts`
 * is its only caller in production.
 *
 * TWO ENVIRONMENT VARIABLES, BOTH READ ONCE AT STARTUP:
 *  - `REBILDER_MCP_PROBE_BUDGET` — the politeness soft cap. An env var and not a
 *    tool argument on purpose: the person who launched the process gets to raise
 *    it, a model reading a web page does not (design §5.2).
 *  - `REBILDER_API_URL` — the public index base, for our own staging. Validated
 *    to https with no credentials, and ignored otherwise.
 *
 * There is no environment variable that allows private hosts, plaintext http,
 * a bigger body cap, or skipping robots.txt. That is not an oversight.
 */

import { createIndexClient, INDEX_BASE_URL_ENV, type IndexClient } from './index-client'
import { createDefaultScanner, probeBudgetFromEnv, PROBE_BUDGET_ENV, type Scanner } from './scanner'

export interface Environment {
  readonly [key: string]: string | undefined
}

export interface ServerDependencies {
  readonly scanner: Scanner
  readonly indexClient: IndexClient
}

export function createDependencies(env: Environment = {}): ServerDependencies {
  return {
    scanner: createDefaultScanner({ maxProbesPerRun: probeBudgetFromEnv(env[PROBE_BUDGET_ENV]) }),
    indexClient: createIndexClient({ baseUrl: env[INDEX_BASE_URL_ENV] }),
  }
}
