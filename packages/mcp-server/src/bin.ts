#!/usr/bin/env node
/**
 * bin.ts — the executable. `npx -y @rebilder/mcp-server`.
 *
 * The only file in this package that reads `process`, and it does nothing else:
 * build the dependencies from the environment, build the server, hand it stdin
 * and stdout, exit when the pipe closes.
 *
 * `--help` and `--version` write to STDERR, not stdout. stdout belongs to the
 * protocol from the first byte, and a client that launched this expecting frames
 * must not receive a help screen — even when a human typed the flag.
 *
 * NOTE FOR THE PUBLISHING PIPELINE (design §5.7 item 1, which does not exist
 * yet): this file needs to become `dist/bin.js` with the shebang preserved, and
 * `package.json` needs `bin`, `files` and `publishConfig`. Until then the server
 * runs from source with a TypeScript loader.
 */

import { createDependencies } from './deps'
import { createServer } from './server'
import { serveStdio } from './stdio'
import { PROBE_BUDGET_ENV } from './scanner'
import { INDEX_BASE_URL_ENV } from './index-client'
import { SERVER_NAME, SERVER_VERSION } from './version'
import { TOOLS } from './tools/index'

const HELP = `${SERVER_NAME} ${SERVER_VERSION}

Rebilder's Agent Readability scanner, as an MCP server over stdio.

  npx -y ${SERVER_NAME}

Add it to your MCP client's server list; the client launches this process and
speaks JSON-RPC 2.0 over stdin/stdout. There is no HTTP transport: it would
inherit the abuse surface that running on your own machine removes.

Tools: ${TOOLS.map((tool) => tool.name).join(', ')}

Environment:
  ${PROBE_BUDGET_ENV}   requests per session before the politeness limiter
                                 refuses (default 20, min 5, max 500)
  ${INDEX_BASE_URL_ENV}            public index base URL (https only; ours by default)

Zero telemetry. Scans run on this machine and are never uploaded. The only
network call this binary makes to Rebilder is the get_index_entry lookup, which
sends nothing but the domain you name.
`

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(HELP)
    return
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stderr.write(`${SERVER_VERSION}\n`)
    return
  }

  const server = createServer(createDependencies(process.env))
  process.stderr.write(
    `${SERVER_NAME} ${SERVER_VERSION} ready on stdio. Scans run locally; nothing is uploaded.\n`,
  )

  await serveStdio(server, {
    input: process.stdin,
    write: (text) => void process.stdout.write(text),
    writeError: (text) => void process.stderr.write(text),
  })
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${SERVER_NAME}: fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exitCode = 1
})
