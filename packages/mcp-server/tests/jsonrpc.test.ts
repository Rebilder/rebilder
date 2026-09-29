/**
 * jsonrpc.test.ts — the envelope, which is the part a hand-rolled server gets
 * wrong. Every case here is a real client behaviour, not a hypothetical: half
 * of them come from the two rules that wedge a session — answering a
 * notification, and answering a batch.
 */

import { describe, expect, it } from 'vitest'

import {
  decodeFrame,
  decodeLine,
  ERROR_CODES,
  failure,
  isFailure,
  paramsObject,
  success,
} from '../src/jsonrpc'
import type { JsonValue } from '../src/json'

describe('decodeLine', () => {
  it('answers unparseable JSON with -32700 and a null id', () => {
    const frame = decodeLine('{not json')
    expect(frame.kind).toBe('invalid')
    if (frame.kind !== 'invalid') throw new Error('unreachable')
    expect(frame.response.error.code).toBe(ERROR_CODES.parseError)
    expect(frame.response.id).toBeNull()
  })

  it('decodes a request', () => {
    const frame = decodeLine('{"jsonrpc":"2.0","id":7,"method":"ping"}')
    expect(frame.kind).toBe('request')
    if (frame.kind !== 'request') throw new Error('unreachable')
    expect(frame.request.id).toBe(7)
    expect(frame.request.method).toBe('ping')
  })

  it('treats a missing id as a notification', () => {
    const frame = decodeLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')
    expect(frame.kind).toBe('notification')
  })
})

describe('decodeFrame', () => {
  it('rejects a batch outright — MCP 2025-06-18 removed batching', () => {
    const frame = decodeFrame([{ jsonrpc: '2.0', id: 1, method: 'ping' }] as unknown as JsonValue)
    expect(frame.kind).toBe('invalid')
    if (frame.kind !== 'invalid') throw new Error('unreachable')
    expect(frame.response.error.code).toBe(ERROR_CODES.invalidRequest)
    expect(frame.response.error.message).toMatch(/[Bb]atch/)
  })

  it('rejects a frame that is not an object', () => {
    expect(decodeFrame('ping').kind).toBe('invalid')
    expect(decodeFrame(42).kind).toBe('invalid')
    expect(decodeFrame(null).kind).toBe('invalid')
  })

  it('rejects the wrong jsonrpc version, echoing the id so the client can match it', () => {
    const frame = decodeFrame({ jsonrpc: '1.0', id: 3, method: 'ping' })
    expect(frame.kind).toBe('invalid')
    if (frame.kind !== 'invalid') throw new Error('unreachable')
    expect(frame.response.id).toBe(3)
    expect(frame.response.error.code).toBe(ERROR_CODES.invalidRequest)
  })

  it('rejects a missing or empty method', () => {
    expect(decodeFrame({ jsonrpc: '2.0', id: 1 }).kind).toBe('invalid')
    expect(decodeFrame({ jsonrpc: '2.0', id: 1, method: '' }).kind).toBe('invalid')
  })

  it('rejects id: null rather than treating it as a notification', () => {
    // A notification is the ABSENCE of an id. `null` is reserved for the id of
    // an error response to a frame we could not parse; accepting it as a
    // notification would silently swallow a malformed request.
    const frame = decodeFrame({ jsonrpc: '2.0', id: null, method: 'ping' })
    expect(frame.kind).toBe('invalid')
  })

  it('rejects a non-string, non-number id', () => {
    const frame = decodeFrame({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' })
    expect(frame.kind).toBe('invalid')
    if (frame.kind !== 'invalid') throw new Error('unreachable')
    expect(frame.response.id).toBeNull()
  })

  it('accepts a string id, which some clients use', () => {
    const frame = decodeFrame({ jsonrpc: '2.0', id: 'abc', method: 'tools/list' })
    expect(frame.kind).toBe('request')
    if (frame.kind !== 'request') throw new Error('unreachable')
    expect(frame.request.id).toBe('abc')
  })
})

describe('response builders', () => {
  it('stamps jsonrpc 2.0 on both shapes', () => {
    expect(success(1, { ok: true }).jsonrpc).toBe('2.0')
    expect(failure(1, -32601, 'nope').jsonrpc).toBe('2.0')
  })

  it('omits data when there is none, rather than sending null', () => {
    const withoutData = failure(1, -32601, 'nope')
    expect('data' in withoutData.error).toBe(false)
    const withData = failure(1, -32601, 'nope', { tool: 'scan_url' })
    expect(withData.error.data).toEqual({ tool: 'scan_url' })
  })

  it('discriminates success from failure', () => {
    expect(isFailure(success(1, {}))).toBe(false)
    expect(isFailure(failure(1, -1, 'x'))).toBe(true)
  })
})

describe('paramsObject', () => {
  it('defaults to an empty object for absent or non-object params', () => {
    expect(paramsObject({ id: 1, method: 'x' })).toEqual({})
    expect(paramsObject({ id: 1, method: 'x', params: [1, 2] })).toEqual({})
    expect(paramsObject({ id: 1, method: 'x', params: { a: 1 } })).toEqual({ a: 1 })
  })
})
