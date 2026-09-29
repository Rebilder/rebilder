/**
 * stdio.test.ts — the transport, with no process involved.
 *
 * Two properties, and both of them are the kind that only fail in production:
 * a message split across chunk boundaries (including mid-character) still
 * parses, and stdout carries protocol frames and nothing else.
 */

import { describe, expect, it } from 'vitest'

import { createLineReader, encodeFrame, serveStdio } from '../src/stdio'
import { success } from '../src/jsonrpc'
import { callFrame, createHarness, initializeFrame } from './harness'

describe('createLineReader', () => {
  it('emits complete lines only, and holds a partial one', () => {
    const reader = createLineReader()
    expect(reader.push('{"a":1}\n{"b"')).toEqual(['{"a":1}'])
    expect(reader.push(':2}\n')).toEqual(['{"b":2}'])
  })

  it('survives a multi-byte character split across chunks', () => {
    const reader = createLineReader()
    const bytes = new TextEncoder().encode('{"t":"café"}\n')
    const split = 10 // lands inside the two-byte é
    expect(reader.push(bytes.slice(0, split))).toEqual([])
    expect(reader.push(bytes.slice(split))).toEqual(['{"t":"café"}'])
  })

  it('ignores blank lines and strips CR', () => {
    const reader = createLineReader()
    expect(reader.push('\n\r\n{"a":1}\r\n')).toEqual(['{"a":1}'])
  })

  it('flushes a trailing line with no newline', () => {
    const reader = createLineReader()
    expect(reader.push('{"a":1}')).toEqual([])
    expect(reader.flush()).toEqual(['{"a":1}'])
    expect(reader.flush()).toEqual([])
  })
})

describe('encodeFrame', () => {
  it('writes exactly one line per frame', () => {
    const encoded = encodeFrame(success(1, { ok: true }))
    expect(encoded.endsWith('\n')).toBe(true)
    expect(encoded.trimEnd().includes('\n')).toBe(false)
  })
})

interface Captured {
  readonly out: string[]
  readonly err: string[]
}

async function run(lines: string[]): Promise<Captured> {
  const { server } = createHarness()
  const out: string[] = []
  const err: string[] = []
  async function* input(): AsyncGenerator<string> {
    for (const line of lines) yield `${line}\n`
  }
  await serveStdio(server, {
    input: input(),
    write: (text) => out.push(text),
    writeError: (text) => err.push(text),
  })
  return { out, err }
}

describe('serveStdio', () => {
  it('answers requests in order, one frame per line', async () => {
    const { out } = await run([
      initializeFrame(1),
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
      callFrame('explain_check', { check_id: 'retrievability.reachable' }, 3),
    ])
    // Three requests, one notification, three frames.
    expect(out).toHaveLength(3)
    for (const frame of out) {
      expect(frame.endsWith('\n')).toBe(true)
      const parsed: unknown = JSON.parse(frame)
      expect((parsed as { jsonrpc: string }).jsonrpc).toBe('2.0')
    }
    expect(out.map((frame) => (JSON.parse(frame) as { id: number }).id)).toEqual([1, 2, 3])
  })

  it('writes nothing but frames to stdout, even for garbage input', async () => {
    const { out, err } = await run(['not json at all'])
    expect(err).toHaveLength(0)
    expect(out).toHaveLength(1)
    const parsed = JSON.parse(out[0] ?? '{}') as { error?: { code: number }; id: unknown }
    expect(parsed.error?.code).toBe(-32700)
    expect(parsed.id).toBeNull()
  })

  it('returns when the input stream ends, so the process can exit cleanly', async () => {
    const { out } = await run([])
    expect(out).toHaveLength(0)
  })
})
