/**
 * version.ts — identity constants. `SERVER_VERSION` is asserted equal to
 * `package.json`'s version by a test, because a server that misreports its own
 * version in the `initialize` handshake is worse than one that has no version
 * at all: clients log it and users quote it in bug reports.
 */

import { ARS_SPEC_VERSION } from '@rebilder/agent-readability'

/**
 * The spec this server scores against, as prose names it: "ARS 0.3". Derived
 * from the scorer it ships with, so a spec release cannot leave a tool
 * description or the server instructions naming the previous version.
 */
export const ARS_LABEL = `ARS ${ARS_SPEC_VERSION.split('.').slice(0, 2).join('.')}`

export const SERVER_NAME = '@rebilder/mcp-server'
export const SERVER_TITLE = 'Rebilder — Agent Readability'
export const SERVER_VERSION = '0.4.0'

/**
 * The newest MCP revision this server implements. `2025-06-18` introduced tool
 * `outputSchema` and `structuredContent`, which the design requires (§5.6), and
 * removed JSON-RPC batching — see `server.ts`. `2025-11-25` changed nothing a
 * tools-only server must send; the one behavioural difference it asks for is
 * that a tool's argument-validation failure comes back as an `isError` result
 * the model can read and correct, rather than a protocol error (see
 * `reportsArgumentErrorsAsResults`).
 *
 * NOT `2026-07-28`. That revision removes the `initialize` handshake in favour
 * of a mandatory `server/discover` and per-request version metadata, so it is a
 * different lifecycle rather than a field to echo. A client that only speaks it
 * probes `server/discover`, gets `-32601` from this server, and can fall back
 * to `initialize` at once.
 */
export const LATEST_PROTOCOL_VERSION = '2025-11-25'

/**
 * Revisions we will speak if the client asks for one of them. Ordered newest
 * first. A client asking for anything else gets `LATEST_PROTOCOL_VERSION` back
 * and decides for itself whether to continue, which is what the spec prescribes.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
]

/**
 * From `2025-11-25`, a tool whose arguments fail validation answers with an
 * `isError: true` result, so the model sees the reason and can retry with
 * corrected arguments. Earlier revisions keep the JSON-RPC `-32602` they were
 * promised. Revision strings are ISO dates, so they compare as strings.
 */
export function reportsArgumentErrorsAsResults(version: string): boolean {
  return version >= '2025-11-25'
}

/** Sent on the one network call this binary makes by default. Honest and contactable. */
export const CLIENT_USER_AGENT = `rebilder-mcp/${SERVER_VERSION} (+https://rebilder.com/bots)`

export function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested
  }
  return LATEST_PROTOCOL_VERSION
}
