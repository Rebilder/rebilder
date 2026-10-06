/**
 * cli.ts — parse, run, render, exit. The whole program in one readable function.
 *
 * `runCli` RETURNS an exit code rather than calling `process.exit`, and takes a
 * `CliRuntime` rather than reaching for `process`. That is what makes the exit
 * codes testable as a contract instead of as a hope: every test in
 * `tests/exit-codes.test.ts` is a call to this function with a fake probe and an
 * assertion on the integer it returned.
 *
 * THE ORDER OF OPERATIONS IS THE SAFETY PROPERTY. Parse first, and every parse
 * failure is exit 2 with nothing having been fetched. Then build the probe —
 * which for `--allow-private` is where the import-time gate in
 * `@rebilder/agent-readability/probe/local` fires, before any URL is touched.
 * Then run. Then render. Then write. A failure at any step short-circuits with
 * its own code, and no step can produce a code belonging to an earlier one.
 *
 * `--out` WRITES AFTER STDOUT, NOT INSTEAD OF IT. A CI job that redirects a
 * report to a file still wants the report in the log; making `--out` silent
 * would mean the only copy lives in an artifact nobody downloads.
 */

import { parseCommandLine, type Command } from './args'
import { runBadge } from './commands/badge'
import { runCheck } from './commands/check'
import { runDiff } from './commands/diff'
import { runInit } from './commands/init'
import { EXIT, UsageError, worstExit, type ExitCode } from './exit'
import { render, type FormatContext } from './format'
import { helpText } from './help'
import type { Payload } from './payload'
import { exitCodeFor } from './report'
import type { CliRuntime, ProbeRunner } from './runtime'
import { detectCapabilities } from './term'

/** Kept in step with package.json by a test, so a stale constant cannot ship. */
export const CLI_VERSION = '0.4.0'

export async function runCli(argv: readonly string[], runtime: CliRuntime): Promise<ExitCode> {
  const caps = detectCapabilities({
    env: runtime.env,
    isTty: runtime.isTty,
    columns: runtime.columns,
  })

  try {
    const parsed = parseCommandLine(argv)

    if (parsed.kind === 'version') {
      runtime.write(`${CLI_VERSION}\n`)
      return EXIT.OK
    }
    if (parsed.kind === 'help') {
      runtime.write(helpText(parsed.topic))
      return EXIT.OK
    }

    const { command } = parsed
    const { payload, exitCode } = await execute(command, runtime)

    const ctx: FormatContext = {
      unicode: caps.unicode,
      generatedAt: runtime.now().toISOString(),
      cliVersion: CLI_VERSION,
    }
    const rendered = render(payload, command.format, caps, ctx)

    runtime.write(rendered)
    if (command.out !== null) {
      await runtime.writeFile(command.out, rendered)
    }
    return exitCode
  } catch (error) {
    if (error instanceof UsageError) {
      runtime.writeError(`rebilder: ${error.message}\n\nRun \`rebilder --help\`.\n`)
      return EXIT.USAGE
    }
    // Anything else is our bug or a genuinely broken environment (a failed
    // `--out` write, a probe module refusing to load). It is not the site's
    // fault, so it is never exit 1.
    runtime.writeError(`rebilder: ${error instanceof Error ? error.message : String(error)}\n`)
    return EXIT.PROBE
  }
}

interface Executed {
  payload: Payload
  exitCode: ExitCode
}

async function execute(command: Command, runtime: CliRuntime): Promise<Executed> {
  switch (command.name) {
    case 'check': {
      const probe = await buildProbe(runtime, command.urls.length, command)
      const reports = await runCheck(command, probe)
      return {
        payload: { command: 'check', reports, failOn: command.failOn },
        exitCode: worstExit(reports.map((report) => exitCodeFor(report, command.failOn))),
      }
    }
    case 'diff': {
      const probe = await buildProbe(runtime, 1, command)
      const diff = await runDiff(command, probe)
      // `diff` never sets a threshold, so `exitCodeFor(..., null)` can only
      // return 0, 2, 3 or 4 — exit 1 is structurally unreachable here.
      return { payload: { command: 'diff', diff }, exitCode: exitCodeFor(diff.report, null) }
    }
    case 'init': {
      const scaffold = await runInit(command, runtime)
      return { payload: { command: 'init', scaffold }, exitCode: EXIT.OK }
    }
    case 'badge': {
      return { payload: { command: 'badge', badge: runBadge(command) }, exitCode: EXIT.OK }
    }
  }
}

interface ProbeFlags {
  allowPrivate: boolean
  allowHttp: boolean
}

function buildProbe(
  runtime: CliRuntime,
  urlCount: number,
  flags: ProbeFlags,
): Promise<ProbeRunner> {
  return runtime.probe({
    allowPrivate: flags.allowPrivate,
    allowHttp: flags.allowHttp,
    urlCount,
  })
}
