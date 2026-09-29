/**
 * json.ts — the JSON value type everything on the wire is expressed in, and the
 * one conversion into it.
 *
 * Why a nominal `JsonValue` rather than `unknown` plus casts: every value this
 * package produces crosses a JSON-RPC boundary, and a value that cannot be
 * serialised (a `Date`, an `undefined` in an array, a cycle) becomes a broken
 * frame on stdout rather than a type error. `toJsonObject` does the round-trip
 * once, at the boundary, so the failure is a caught exception in one place
 * instead of a malformed line the client cannot parse.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Converts any serialisable value into a `JsonObject` by round-tripping it
 * through `JSON`. Used on `ArsResult` (an interface, so not structurally a
 * `JsonObject`) and on parsed API responses.
 *
 * Throws on anything that is not a JSON object after the round trip. That is
 * deliberate: the caller is always inside a tool handler whose thrown errors
 * become an `isError` result, and a tool that cannot describe its own output is
 * a bug we want to see rather than an empty payload we do not.
 */
export function toJsonObject(value: unknown): JsonObject {
  const parsed: unknown = JSON.parse(JSON.stringify(value ?? null))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('expected a JSON object')
  }
  return parsed as JsonObject
}

/** Parses text into a `JsonValue`, or returns `null` on malformed input. */
export function parseJson(text: string): { ok: true; value: JsonValue } | { ok: false } {
  try {
    const parsed: unknown = JSON.parse(text)
    return { ok: true, value: parsed as JsonValue }
  } catch {
    return { ok: false }
  }
}
