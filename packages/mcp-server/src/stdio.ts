/**
 * stdio.ts — the transport. Newline-delimited JSON-RPC over stdin/stdout, which
 * is what `npx -y @rebilder/mcp-server` speaks when a client launches it.
 *
 * THE ONE RULE THAT BREAKS EVERYTHING WHEN BROKEN: stdout carries protocol
 * frames and nothing else. A stray `console.log`, a banner, a progress dot — any
 * of them lands mid-stream and the client's parser dies on a frame it did not
 * ask for. All human-facing output goes to stderr, which the client shows in its
 * logs. `createLineReader` is separated out so a test can prove the framing
 * (split lines, blank lines, a message arriving in three chunks, a UTF-8
 * character split across a chunk boundary) without any process at all.
 *
 * ORDERING. Frames are handled one at a time, in arrival order, by chaining onto
 * a promise: two `tools/call`s in flight at once would race the politeness
 * limiter against itself and interleave two scans' worth of requests at one
 * origin. Sequential is also what makes the limiter's per-host spacing mean what
 * it says.
 */

import type { JsonRpcResponse } from './jsonrpc'
import type { McpServer } from './server'

export interface StdioStreams {
  /** Async iterable of chunks — `process.stdin` satisfies this. */
  readonly input: AsyncIterable<Uint8Array | string>
  readonly write: (text: string) => void
  readonly writeError: (text: string) => void
}

/**
 * Splits a chunk stream into complete lines. A chunk boundary can fall anywhere,
 * including inside a multi-byte character, which is why decoding is streaming
 * rather than per-chunk.
 */
export function createLineReader(): {
  push(chunk: Uint8Array | string): string[]
  flush(): string[]
} {
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  return {
    push(chunk: Uint8Array | string): string[] {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      const lines: string[] = []
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline === -1) break
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line.trim() !== '') lines.push(line)
      }
      return lines
    },
    flush(): string[] {
      const rest = buffer.trim()
      buffer = ''
      return rest === '' ? [] : [rest]
    },
  }
}

/** One frame out, one line, no trailing prose. */
export function encodeFrame(response: JsonRpcResponse): string {
  return `${JSON.stringify(response)}\n`
}

/**
 * Runs until stdin closes. Resolves when the stream ends, so `bin.ts` can exit
 * cleanly rather than being killed — a client that closes the pipe is asking the
 * server to stop, not crashing it.
 */
export async function serveStdio(server: McpServer, streams: StdioStreams): Promise<void> {
  const reader = createLineReader()
  let chain: Promise<void> = Promise.resolve()

  const handle = (line: string): void => {
    chain = chain.then(async () => {
      try {
        const response = await server.handleLine(line)
        if (response !== null) streams.write(encodeFrame(response))
      } catch (error) {
        // Nothing above should throw; if it does, say so on stderr and keep the
        // stream alive. A dead server is worse than a dropped frame.
        streams.writeError(
          `rebilder-mcp: dropped a frame: ${error instanceof Error ? error.message : String(error)}\n`,
        )
      }
    })
  }

  for await (const chunk of streams.input) {
    for (const line of reader.push(chunk)) handle(line)
  }
  for (const line of reader.flush()) handle(line)

  await chain
}
