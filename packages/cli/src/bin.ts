#!/usr/bin/env node
/**
 * bin.ts — the executable. Four lines of glue, on purpose.
 *
 * This is the only file in the package that touches `process`, and it does
 * exactly two things with it: hand `process.argv.slice(2)` to `runCli`, and turn
 * the integer it returns into `process.exitCode`. Everything else — parsing,
 * probing, rendering, writing — is in modules that take a `CliRuntime` and can be
 * tested without a shell.
 *
 * `process.exitCode = n` RATHER THAN `process.exit(n)`. `process.exit` tears the
 * process down immediately, which truncates a pipe that has not drained — a
 * `--format json` report piped into `jq` loses its tail on a slow reader, and the
 * bug is intermittent and platform-dependent. Setting `exitCode` lets Node exit
 * naturally once stdout has flushed.
 *
 * `--allow-private` reaches `@rebilder/agent-readability/probe/local`, which
 * gates on `process.argv` containing the flag. That check reads the REAL argv,
 * not the slice passed here, which is exactly right: the permission belongs to
 * whoever started the process, not to whatever a caller chose to pass along.
 */

import { runCli } from './cli'
import { createNodeRuntime } from './runtime'

const runtime = createNodeRuntime()

runCli(process.argv.slice(2), runtime)
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    runtime.writeError(`rebilder: ${error instanceof Error ? error.message : String(error)}\n`)
    // 3, not 1: an unexpected throw is our infrastructure failing, and a score
    // failure is the one thing it definitely is not.
    process.exitCode = 3
  })
