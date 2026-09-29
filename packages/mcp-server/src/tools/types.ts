/**
 * tools/types.ts — what a tool is, and the argument helpers every tool shares.
 *
 * `defineTool` exists so that the registry can hold five tools with five
 * different argument types without an `any` anywhere: the generic is erased at
 * the boundary by the closure, not by a cast. `parse` returns either the typed
 * arguments or an `InvalidParams`, and the server turns the latter into a
 * JSON-RPC `-32602` — the spec's answer for a malformed call, as distinct from a
 * tool that ran and failed, which is an `isError` RESULT (design §5.6: "probe
 * failures return isError: true, never a throw").
 */

import type { JsonObject, JsonValue } from '../json'
import type { JsonSchema } from '../schema'
import type { ToolReturn } from '../result'
import type { Scanner } from '../scanner'
import type { IndexClient } from '../index-client'

export interface ToolDeps {
  readonly scanner: Scanner
  readonly indexClient: IndexClient
}

/**
 * MCP tool behaviour hints. All five tools are read-only; only the three that
 * touch a socket are open-world. `install_snippet` and `explain_check` are
 * closed-world, which is the machine-readable form of "generated locally with no
 * network".
 */
export interface ToolAnnotations extends JsonObject {
  readonly title: string
  readonly readOnlyHint: boolean
  readonly destructiveHint: boolean
  readonly idempotentHint: boolean
  readonly openWorldHint: boolean
}

export interface InvalidParams {
  readonly kind: 'invalid-params'
  readonly message: string
}

export function invalidParams(message: string): InvalidParams {
  return { kind: 'invalid-params', message }
}

export function isInvalidParams(value: unknown): value is InvalidParams {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'invalid-params'
  )
}

export interface Tool {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: JsonSchema
  readonly outputSchema: JsonSchema
  readonly annotations: ToolAnnotations
  invoke(args: JsonObject, deps: ToolDeps): Promise<ToolReturn | InvalidParams>
}

export interface ToolDefinition<Args> {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: JsonSchema
  readonly outputSchema: JsonSchema
  readonly annotations: ToolAnnotations
  readonly parse: (args: JsonObject) => Args | InvalidParams
  readonly run: (args: Args, deps: ToolDeps) => Promise<ToolReturn>
}

export function defineTool<Args>(definition: ToolDefinition<Args>): Tool {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    annotations: definition.annotations,
    invoke(args: JsonObject, deps: ToolDeps): Promise<ToolReturn | InvalidParams> {
      const parsed = definition.parse(args)
      if (isInvalidParams(parsed)) return Promise.resolve(parsed)
      return definition.run(parsed, deps)
    },
  }
}

/* ── argument helpers ─────────────────────────────────────────────────────── */

export function requireString(args: JsonObject, key: string): string | InvalidParams {
  const value: JsonValue | undefined = args[key]
  if (value === undefined || value === null) return invalidParams(`"${key}" is required.`)
  if (typeof value !== 'string') return invalidParams(`"${key}" must be a string.`)
  if (value.trim() === '') return invalidParams(`"${key}" must not be empty.`)
  return value.trim()
}

export function optionalEnum<T extends string>(
  args: JsonObject,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T | InvalidParams {
  const value: JsonValue | undefined = args[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return invalidParams(`"${key}" must be one of: ${allowed.join(', ')}.`)
  }
  return value as T
}

export function optionalInteger(
  args: JsonObject,
  key: string,
  bounds: { min: number; max: number; fallback: number },
): number | InvalidParams {
  const value: JsonValue | undefined = args[key]
  if (value === undefined || value === null) return bounds.fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return invalidParams(`"${key}" must be an integer.`)
  }
  if (value < bounds.min || value > bounds.max) {
    return invalidParams(`"${key}" must be between ${bounds.min} and ${bounds.max}.`)
  }
  return value
}

/** Closed input schemas are enforced here, not only declared in the schema. */
export function rejectUnknownKeys(
  args: JsonObject,
  allowed: readonly string[],
): InvalidParams | null {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unknown.length === 0) return null
  return invalidParams(
    `unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}.`,
  )
}
