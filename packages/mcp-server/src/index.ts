/**
 * index.ts — the `"."` entry point of `@rebilder/mcp-server`.
 *
 * The product of this package is a BINARY (`src/bin.ts`), not a library: what
 * ships is `npx -y @rebilder/mcp-server` and what consumes it is an MCP client.
 * This surface exists so the server can be embedded — in our own tests, in the
 * CLI if it ever grows an `mcp` subcommand, in an integration that wants the
 * tool set without the process — and it is deliberately small.
 *
 * WHAT IS NOT EXPORTED, AND WHY: nothing that would let a consumer construct a
 * scanner with the politeness limiter turned off, and nothing that reaches
 * `@rebilder/agent-readability/probe/local`. `createDefaultScanner` builds its
 * own limiter and `probeStrict` is the only probe this package can call. A
 * consumer wanting private-host scanning uses the CLI, where a human types
 * `--allow-private`, which is the entire point of that entry point existing
 * separately (design §5.2).
 */

export { createServer, listToolsResult, SERVER_INSTRUCTIONS } from './server'
export type { McpServer, McpServerOptions } from './server'

export { createDependencies } from './deps'
export type { Environment, ServerDependencies } from './deps'

export { createDefaultScanner, probeBudgetFromEnv, PROBE_BUDGET_ENV } from './scanner'
export type { Scanner } from './scanner'

export {
  createIndexClient,
  indexEntryUrl,
  isValidDomain,
  normalizeDomain,
  resolveIndexBaseUrl,
  DEFAULT_INDEX_BASE_URL,
  INDEX_BASE_URL_ENV,
} from './index-client'
export type { FetchLike, IndexClient, IndexLookup } from './index-client'

export { createLineReader, encodeFrame, serveStdio } from './stdio'
export type { StdioStreams } from './stdio'

export { decodeFrame, decodeLine, ERROR_CODES, failure, success } from './jsonrpc'
export type { JsonRpcFailure, JsonRpcResponse, JsonRpcSuccess } from './jsonrpc'

export { toCallToolResult, localFailure, targetFailure } from './result'
export type { CallToolResult, ToolReturn } from './result'

export { sanitizeUntrustedText, untrustedNonce, wrapUntrusted, UNTRUSTED_NOTICE } from './untrusted'
export type { UntrustedBlock } from './untrusted'

export { findTool, TOOLS } from './tools/index'
export type { Tool, ToolDeps } from './tools/types'

export { formatScanSummary } from './render'

export { ARS_RESULT_SCHEMA } from './schema'
export type { JsonSchema } from './schema'

export {
  LATEST_PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_TITLE,
  SERVER_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from './version'
