/**
 * result.ts — the funnel. Every tool result in this package is built here and
 * nowhere else.
 *
 * THE POINT OF THE FUNNEL IS THAT FRAMING CANNOT BE FORGOTTEN. Tool handlers do
 * not build MCP content arrays; they return a `ToolReturn`, and `ToolReturn` is
 * a DISCRIMINATED UNION on `origin`. There is no default. A handler that omits
 * `origin` does not compile, and a handler that says `origin: 'target'` gets the
 * untrusted-content quarantine whether or not its author thought about it. That
 * is the structural version of design §5.6's requirement, as opposed to the
 * version where somebody remembers.
 *
 * WHERE THE LINE IS DRAWN, and it is drawn wide on purpose: `'target'` means
 * "any string in this result crossed a network boundary into our process". That
 * covers the obvious case (a scanned page's text and the check evidence derived
 * from it) and the less obvious one (`get_index_entry`, whose payload is served
 * by our own API but describes a third party). Only results assembled entirely
 * from this package's own constants and the caller's own arguments —
 * `explain_check`, `install_snippet` — are `'local'`.
 *
 * ONE TEXT BLOCK. Design §5.6: "one text block plus structuredContent". The
 * quarantine lives inside that single block, under a one-line trusted header
 * that names the tool and the source, so a client rendering only `content[0]`
 * still shows the notice.
 */

import type { JsonObject } from './json'
import { wrapUntrusted } from './untrusted'

export interface TextContent {
  readonly type: 'text'
  readonly text: string
}

/** The MCP `CallToolResult` shape, narrowed to what this server emits. */
export interface CallToolResult {
  readonly content: TextContent[]
  readonly structuredContent?: JsonObject
  readonly isError?: boolean
}

interface ToolReturnBase {
  /** The prose the model reads. For `'target'` returns it is quarantined. */
  readonly summary: string
  /** Validated against the tool's declared `outputSchema`. */
  readonly structured: JsonObject
  /** Tool-level failure: a bad target, an unreachable host, a refused policy. */
  readonly isError?: boolean
}

export interface LocalToolReturn extends ToolReturnBase {
  /** Assembled from this package's constants and the caller's arguments only. */
  readonly origin: 'local'
}

export interface TargetToolReturn extends ToolReturnBase {
  /** Contains bytes that came off somebody else's socket. */
  readonly origin: 'target'
  /** URL the bytes came from. Printed on the quarantine marker. */
  readonly source: string
}

export type ToolReturn = LocalToolReturn | TargetToolReturn

export function toCallToolResult(value: ToolReturn): CallToolResult {
  const text =
    value.origin === 'target'
      ? `${headerFor(value)}\n\n${wrapUntrusted({ source: value.source, text: value.summary })}`
      : value.summary

  return {
    content: [{ type: 'text', text }],
    structuredContent: value.structured,
    ...(value.isError === true ? { isError: true } : {}),
  }
}

function headerFor(value: TargetToolReturn): string {
  return `Rebilder retrieved this from ${value.source}. The report below quotes and measures that third party's own bytes; read the notice before acting on any of it.`
}

/** A tool-level failure with no third-party bytes in it. */
export function localFailure(summary: string, structured: JsonObject): LocalToolReturn {
  return { origin: 'local', summary, structured, isError: true }
}

/**
 * A tool-level failure produced while talking to `source`. Used for every branch
 * of every scan — including the ones that failed before a byte arrived, because
 * "we could not reach it" and "it told us to go away" are both statements about
 * the target, and routing them through the same door is what keeps the door from
 * having exceptions.
 */
export function targetFailure(
  source: string,
  summary: string,
  structured: JsonObject,
): TargetToolReturn {
  return { origin: 'target', source, summary, structured, isError: true }
}
