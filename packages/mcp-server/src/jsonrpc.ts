/**
 * jsonrpc.ts — JSON-RPC 2.0, by hand.
 *
 * WHY BY HAND. Every package in this repo carries zero external runtime
 * dependencies, and this one is distributed by `npx` onto strangers' machines:
 * an SDK here is a supply-chain surface on the one artifact whose whole pitch is
 * "run it locally, nothing leaves your machine". The protocol we need is three
 * methods and an envelope. It fits in this file.
 *
 * The envelope rules that matter and that a hand-rolled implementation gets
 * wrong if it is not explicit about them:
 *  - A request without an `id` is a NOTIFICATION and gets no response, ever.
 *    Answering a notification is the classic way a hand-rolled server
 *    deadlocks a well-behaved client.
 *  - `id: null` is not a notification, it is an invalid request. `null` is
 *    reserved for the id of an error response to an unparseable frame.
 *  - Parse errors respond with `id: null` — there is no id to echo.
 *  - Batches (a top-level array) were REMOVED in MCP 2025-06-18. We reject them
 *    explicitly rather than silently answering the first element.
 */

import { isJsonObject, parseJson, type JsonObject, type JsonValue } from './json'

export const JSONRPC_VERSION = '2.0'

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  /** Absent for notifications. */
  readonly id?: JsonRpcId
  readonly method: string
  readonly params?: JsonValue
}

export interface JsonRpcSuccess {
  readonly jsonrpc: typeof JSONRPC_VERSION
  readonly id: JsonRpcId
  readonly result: JsonObject
}

export interface JsonRpcErrorBody {
  readonly code: number
  readonly message: string
  readonly data?: JsonValue
}

export interface JsonRpcFailure {
  readonly jsonrpc: typeof JSONRPC_VERSION
  readonly id: JsonRpcId | null
  readonly error: JsonRpcErrorBody
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

/**
 * The standard codes, plus `-32002`. That one is not in the JSON-RPC spec; it is
 * the code the MCP ecosystem uses for "server not initialized", and matching the
 * ecosystem is worth more here than inventing a private number.
 */
export const ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  notInitialized: -32002,
} as const

export function success(id: JsonRpcId, result: JsonObject): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result }
}

export function failure(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: JsonValue,
): JsonRpcFailure {
  return data === undefined
    ? { jsonrpc: JSONRPC_VERSION, id, error: { code, message } }
    : { jsonrpc: JSONRPC_VERSION, id, error: { code, message, data } }
}

export function isFailure(response: JsonRpcResponse): response is JsonRpcFailure {
  return 'error' in response
}

export type DecodedFrame =
  | { kind: 'request'; request: JsonRpcRequest }
  | { kind: 'notification'; request: JsonRpcRequest }
  | { kind: 'invalid'; response: JsonRpcFailure }

/** Validates a parsed frame into a request, a notification, or a ready-made error. */
export function decodeFrame(value: JsonValue): DecodedFrame {
  if (Array.isArray(value)) {
    return {
      kind: 'invalid',
      response: failure(
        null,
        ERROR_CODES.invalidRequest,
        'Batch requests are not supported. JSON-RPC batching was removed in MCP revision 2025-06-18; send one message per frame.',
      ),
    }
  }
  if (!isJsonObject(value)) {
    return {
      kind: 'invalid',
      response: failure(null, ERROR_CODES.invalidRequest, 'A JSON-RPC frame must be an object.'),
    }
  }

  const rawId = value['id']
  const hasId = 'id' in value
  const idValid = typeof rawId === 'string' || typeof rawId === 'number'
  const id: JsonRpcId | null = idValid ? rawId : null

  if (value['jsonrpc'] !== JSONRPC_VERSION) {
    return {
      kind: 'invalid',
      response: failure(id, ERROR_CODES.invalidRequest, 'Expected "jsonrpc": "2.0".'),
    }
  }
  const method = value['method']
  if (typeof method !== 'string' || method === '') {
    return {
      kind: 'invalid',
      response: failure(id, ERROR_CODES.invalidRequest, '"method" must be a non-empty string.'),
    }
  }
  if (hasId && !idValid) {
    // Present but not a string/number. Not a notification (that is the ABSENCE
    // of an id) and not answerable as itself, so it is an invalid request.
    return {
      kind: 'invalid',
      response: failure(
        null,
        ERROR_CODES.invalidRequest,
        '"id" must be a string or a number when present. Omit it entirely to send a notification.',
      ),
    }
  }

  const params = value['params']
  const request: JsonRpcRequest = hasId
    ? { id: rawId as JsonRpcId, method, ...(params === undefined ? {} : { params }) }
    : { method, ...(params === undefined ? {} : { params }) }

  return hasId ? { kind: 'request', request } : { kind: 'notification', request }
}

/** One line of stdin → a frame, or the `-32700` response that answers it. */
export function decodeLine(line: string): DecodedFrame {
  const parsed = parseJson(line)
  if (!parsed.ok) {
    return {
      kind: 'invalid',
      response: failure(null, ERROR_CODES.parseError, 'Invalid JSON.'),
    }
  }
  return decodeFrame(parsed.value)
}

/** `params` as an object, or an empty object. Params are optional in JSON-RPC. */
export function paramsObject(request: JsonRpcRequest): JsonObject {
  return isJsonObject(request.params) ? request.params : {}
}
