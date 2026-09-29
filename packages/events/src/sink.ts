/**
 * Event sinks — the Phase 1 edge emission client (ROADMAP.md § Phase 1:
 * "packages/events schema + edge emission").
 *
 * Design rules:
 * - Observation must never break serving: emit() never throws, flush()/close()
 *   never reject, failed batches are DROPPED (reported via onError), and the
 *   queue is capped so memory is bounded.
 * - Edge-safe: web-standard fetch/setTimeout only, zero dependencies, no
 *   Node-only APIs.
 */
import type { RebilderEventV0 } from './types'
import { explainEventV0 } from './validate'

export interface HttpEventSinkOptions {
  /** Ingest base URL, e.g. `https://api.rebilder.com` — the sink POSTs to `${url}/v1/events`. */
  url: string
  /** Sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string
  /** Flush as soon as the queue reaches this many events. Default 20. */
  maxBatch?: number
  /** Flush timer interval while the queue is non-empty. Default 2000. */
  flushIntervalMs?: number
  /** Fetch implementation, injectable for tests. Default `globalThis.fetch`. */
  fetchImpl?: typeof fetch
  /**
   * Called whenever an event or batch is dropped (invalid event, transport
   * failure after retry, 4xx rejection, queue overflow, emit after close).
   * Default logs via `console.warn`. Errors thrown by the callback itself are
   * swallowed — the sink never rethrows into the caller.
   */
  onError?: (err: unknown) => void
}

export interface EventSink {
  /** Synchronous enqueue. Invalid events are dropped via onError, never thrown. */
  emit(event: RebilderEventV0): void
  /** Send the queue now. Resolves even on failure (failed batches are dropped). */
  flush(): Promise<void>
  /** Flush remaining events and stop the timer. Later emit() calls are dropped. */
  close(): Promise<void>
}

/** Hard queue bound — beyond this, the oldest event is dropped (via onError). */
const QUEUE_CAP = 1000
/** One retry after this delay for network errors / 5xx; then the batch is dropped. */
const RETRY_DELAY_MS = 500

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The edge emission client. Batches events and POSTs them to
 * `${url}/v1/events` (wire protocol: see README.md § Wire protocol).
 *
 * Compatible with the gateway's fire-and-forget `onEvent` hook:
 * `onEvent: (event) => sink.emit(event)`.
 */
export function createHttpEventSink(options: HttpEventSinkOptions): EventSink {
  const maxBatch = options.maxBatch ?? 20
  const flushIntervalMs = options.flushIntervalMs ?? 2000
  const doFetch: typeof fetch =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  const onError = options.onError ?? ((err: unknown) => console.warn('[rebilder-events]', err))
  const endpoint = `${options.url.replace(/\/+$/, '')}/v1/events`

  let queue: RebilderEventV0[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  /** Serializes sends: each flush chains behind the previous one. Never rejects. */
  let chain: Promise<void> = Promise.resolve()

  function report(err: unknown): void {
    try {
      onError(err)
    } catch {
      /* the sink never rethrows into the caller */
    }
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function scheduleTimer(): void {
    if (timer !== null || closed || queue.length === 0) return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, flushIntervalMs)
  }

  /** Sends one batch. Never throws: every failure ends in report() + drop. */
  async function sendBatch(batch: RebilderEventV0[]): Promise<void> {
    let body: string
    try {
      body = JSON.stringify({ events: batch })
    } catch (err) {
      report(new Error(`event batch dropped (${batch.length} events): unserializable: ${String(err)}`))
      return
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await delay(RETRY_DELAY_MS)
      let response: Response
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
        })
      } catch (err) {
        // Network error: one retry, then drop.
        if (attempt === 0) continue
        report(
          new Error(
            `event batch dropped (${batch.length} events): network error after retry: ${String(err)}`,
          ),
        )
        return
      }
      // Success contract: 202 { "accepted": n }. Any 2xx is treated as accepted.
      if (response.ok) return
      // 5xx: one retry, then drop.
      if (response.status >= 500 && attempt === 0) continue
      // 4xx (bad key / bad payload): drop immediately, no retry.
      report(
        new Error(
          `event batch dropped (${batch.length} events): ingest responded ${response.status}${
            response.status >= 500 ? ' after retry' : ''
          }`,
        ),
      )
      return
    }
  }

  function flush(): Promise<void> {
    const run = chain.then(async () => {
      if (queue.length === 0) return
      clearTimer()
      const batch = queue
      queue = []
      try {
        await sendBatch(batch)
      } catch (err) {
        // sendBatch never throws; belt-and-braces so flush() always resolves.
        report(err)
      }
    })
    chain = run
    return run
  }

  return {
    emit(event: RebilderEventV0): void {
      if (closed) {
        report(new Error('event dropped: emit() after close()'))
        return
      }
      const problem = explainEventV0(event)
      if (problem !== null) {
        report(new Error(`event dropped: invalid RebilderEventV0: ${problem}`))
        return
      }
      if (queue.length >= QUEUE_CAP) {
        queue.shift()
        report(new Error(`event queue full (cap ${QUEUE_CAP}): oldest event dropped`))
      }
      queue.push(event)
      if (queue.length >= maxBatch) {
        void flush()
      } else {
        scheduleTimer()
      }
    },
    flush,
    async close(): Promise<void> {
      closed = true
      clearTimer()
      await flush()
    },
  }
}

/**
 * Console sink: logs each event as one structured line via `console.info`
 * (`[rebilder-event] {json}`), for a host whose log drain already collects
 * structured lines. Upgrade path: swap for createHttpEventSink when you want
 * events delivered to an ingest endpoint; the event shape is identical.
 */
export function createConsoleEventSink(): EventSink {
  return {
    emit(event: RebilderEventV0): void {
      try {
        console.info(`[rebilder-event] ${JSON.stringify(event)}`)
      } catch {
        /* observation must never break the caller */
      }
    },
    flush(): Promise<void> {
      return Promise.resolve()
    },
    close(): Promise<void> {
      return Promise.resolve()
    },
  }
}
