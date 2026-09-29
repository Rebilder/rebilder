/**
 * runtime.ts — every impure thing the CLI can do, behind one injectable object.
 *
 * WHY THIS SHAPE. The test suite for a network tool is worthless if it can reach
 * the network, and "we mocked `fetch`" is not a guarantee — it is a hope about
 * every code path nobody thought to mock. Here the CLI holds no socket, no file
 * handle, no clock and no `process` reference at all: it holds a `CliRuntime`.
 * The tests pass one whose `probe` returns a fixture and whose `writeFile`
 * appends to an array, so a test that hits the network cannot be written by
 * accident — it has to construct the real runtime on purpose.
 *
 * THE PROBE FACTORY IS ASYNC FOR ONE REASON. `@rebilder/agent-readability/probe/local`
 * THROWS AT IMPORT TIME unless the process was started with `--allow-private`
 * (and refuses outright in a hosted runtime). That is exactly the behaviour we
 * want and it means the module cannot be imported statically — a top-level
 * `import` of it would make `rebilder check https://example.com` crash on
 * startup for everyone. So local mode is a dynamic import, reached only when the
 * flag is present, which is also what makes the permission per-invocation rather
 * than per-installation.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import {
  createLimiter,
  probeStrict,
  strictPolicy,
  type ProbeOutcome,
  type ProbePolicy,
} from '@rebilder/agent-readability/probe'

/** One probe of one URL. The only outbound request the CLI ever makes. */
export type ProbeRunner = (target: string) => Promise<ProbeOutcome>

export interface ProbeSetup {
  /** Routes through `./probe/local`. Per invocation, never a default. */
  allowPrivate: boolean
  allowHttp: boolean
  /** How many URLs this run will probe — sizes the run budget, nothing else. */
  urlCount: number
}

export type ProbeFactory = (setup: ProbeSetup) => Promise<ProbeRunner>

export interface CliRuntime {
  env: Readonly<Record<string, string | undefined>>
  cwd: string
  isTty: boolean
  columns: number | undefined
  write(text: string): void
  writeError(text: string): void
  writeFile(path: string, contents: string): Promise<void>
  readFile(path: string): Promise<string | null>
  probe: ProbeFactory
  now(): Date
}

/**
 * The §3.3 request set is 5 requests for a cold URL (robots.txt, agent, browser,
 * /llms.txt, /.well-known/ucp) and the probe does not cache across calls, so a
 * multi-URL run needs a budget proportional to the URL count. `createLimiter`'s
 * default of 20 is a floor chosen for a single-shot caller; raising it is
 * supposed to be a decision someone made on purpose, and this is that decision,
 * written down: six per URL (five plus the robots retry) and four of slack.
 */
export function budgetFor(urlCount: number): number {
  return Math.max(20, urlCount * 6 + 4)
}

function policyFor(setup: ProbeSetup, base: ProbePolicy): ProbePolicy {
  return { ...base, allowHttp: setup.allowHttp || base.allowHttp }
}

/**
 * The real probe factory. `probeStrict` for everything public; a dynamic import
 * of `./probe/local` when — and only when — `--allow-private` was typed.
 *
 * If that import throws, the message from the package is the one the user should
 * see (it explains the argv gate and the hosted-runtime refusal in its own
 * words), so it is re-thrown unchanged rather than summarised.
 */
export const nodeProbeFactory: ProbeFactory = async (setup) => {
  const limiter = createLimiter({ maxProbesPerRun: budgetFor(setup.urlCount) })

  if (!setup.allowPrivate) {
    const policy = policyFor(setup, strictPolicy(limiter))
    return (target) => probeStrict(target, policy)
  }

  const local = await import('@rebilder/agent-readability/probe/local')
  const policy = policyFor(setup, local.localPolicy(limiter))
  return (target) => local.probeLocal(target, policy)
}

export function createNodeRuntime(): CliRuntime {
  return {
    env: process.env,
    cwd: process.cwd(),
    isTty: process.stdout.isTTY === true,
    columns: process.stdout.columns,
    write: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
    writeFile: async (path, contents) => {
      await writeFile(resolvePath(process.cwd(), path), contents, 'utf8')
    },
    readFile: async (path) => {
      try {
        return await readFile(resolvePath(process.cwd(), path), 'utf8')
      } catch {
        return null
      }
    },
    probe: nodeProbeFactory,
    now: () => new Date(),
  }
}
