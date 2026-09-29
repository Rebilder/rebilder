import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createConsoleEventSink,
  createHttpEventSink,
  type RebilderEventV0,
} from '../src/index'

let counter = 0
function makeEvent(overrides: Partial<RebilderEventV0> = {}): RebilderEventV0 {
  counter += 1
  return {
    event_id: `evt_${counter}`,
    ts: '2026-08-04T12:00:00.000Z',
    store_id: 'store_1',
    requester: { kind: 'agent', platform: 'claude', verified: false },
    request: { url: 'https://shop.example/products/x', intent_signals: {} },
    response: { path: 'markdown', render_ms: 12 },
    ...overrides,
  }
}

function acceptedResponse(count: number): Response {
  return new Response(JSON.stringify({ accepted: count }), { status: 202 })
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>

function okFetch(): FetchMock {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { events: unknown[] }
    return acceptedResponse(body.events.length)
  })
}

function sentEvents(fetchMock: FetchMock, call = 0): RebilderEventV0[] {
  const init = fetchMock.mock.calls[call]?.[1]
  return (JSON.parse(String(init?.body)) as { events: RebilderEventV0[] }).events
}

/** Let queued microtasks (the flush chain) run under fake timers. */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createHttpEventSink — wire protocol', () => {
  it('POSTs {url}/v1/events with bearer auth, JSON content type, and {"events": [...]} body', async () => {
    const fetchMock = okFetch()
    const sink = createHttpEventSink({
      url: 'https://api.rebilder.example',
      apiKey: 'rbk_test_123',
      fetchImpl: fetchMock,
    })
    const event = makeEvent()
    sink.emit(event)
    await sink.flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [input, init] = fetchMock.mock.calls[0]!
    expect(input).toBe('https://api.rebilder.example/v1/events')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({
      Authorization: 'Bearer rbk_test_123',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(String(init?.body))).toEqual({ events: [event] })
  })

  it('normalizes a trailing slash on the base url', async () => {
    const fetchMock = okFetch()
    const sink = createHttpEventSink({
      url: 'https://api.rebilder.example/',
      apiKey: 'k',
      fetchImpl: fetchMock,
    })
    sink.emit(makeEvent())
    await sink.flush()
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.rebilder.example/v1/events')
  })

  it('is compatible with the gateway onEvent hook shape', () => {
    const sink = createHttpEventSink({ url: 'https://x', apiKey: 'k', fetchImpl: okFetch() })
    // GatewayConfig['onEvent'] is (event: RebilderEventV0) => void | Promise<void>
    const onEvent: (event: RebilderEventV0) => void = (event) => sink.emit(event)
    expect(() => onEvent(makeEvent())).not.toThrow()
  })
})

describe('createHttpEventSink — batching', () => {
  it('does not send before maxBatch or the flush timer', async () => {
    const fetchMock = okFetch()
    const sink = createHttpEventSink({ url: 'https://x', apiKey: 'k', fetchImpl: fetchMock })
    sink.emit(makeEvent())
    await tick()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('flushes automatically when the queue reaches maxBatch', async () => {
    const fetchMock = okFetch()
    const sink = createHttpEventSink({
      url: 'https://x',
      apiKey: 'k',
      maxBatch: 3,
      fetchImpl: fetchMock,
    })
    sink.emit(makeEvent())
    sink.emit(makeEvent())
    await tick()
    expect(fetchMock).not.toHaveBeenCalled()
    sink.emit(makeEvent())
    await tick()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sentEvents(fetchMock)).toHaveLength(3)
  })

  it('flushes on the interval timer while the queue is non-empty', async () => {
    const fetchMock = okFetch()
    const sink = createHttpEventSink({
      url: 'https://x',
      apiKey: 'k',
      flushIntervalMs: 2000,
      fetchImpl: fetchMock,
    })
    sink.emit(makeEvent())
    await vi.advanceTimersByTimeAsync(1999)
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sentEvents(fetchMock)).toHaveLength(1)
  })

  it('sends the whole queue on manual flush', async () => {
    const fetchMock = okFetch()
    const sink = createHttpEventSink({ url: 'https://x', apiKey: 'k', fetchImpl: fetchMock })
    sink.emit(makeEvent())
    sink.emit(makeEvent())
    await sink.flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sentEvents(fetchMock)).toHaveLength(2)
  })

  it('flush on an empty queue is a no-op', async () => {
    const fetchMock = okFetch()
    const sink = createHttpEventSink({ url: 'https://x', apiKey: 'k', fetchImpl: fetchMock })
    await sink.flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('createHttpEventSink — failure handling', () => {
  it('retries once after 500ms on 5xx, then succeeds with the same batch', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockImplementation(async () => acceptedResponse(1))
    const onError = vi.fn()
    const sink = createHttpEventSink({
      url: 'https://x',
      apiKey: 'k',
      fetchImpl: fetchMock,
      onError,
    })
    const event = makeEvent()
    sink.emit(event)
    const flushed = sink.flush()
    await tick()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    await flushed
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Same body resent on retry.
    expect(fetchMock.mock.calls[0]![1]?.body).toBe(fetchMock.mock.calls[1]![1]?.body)
    expect(onError).not.toHaveBeenCalled()
  })

  it('drops the batch via onError after a second 5xx (no unbounded retries)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('down', { status: 503 }))
    const onError = vi.fn()
    const sink = createHttpEventSink({
      url: 'https://x',
      apiKey: 'k',
      fetchImpl: fetchMock,
      onError,
    })
    sink.emit(makeEvent())
    const flushed = sink.flush()
    await vi.advanceTimersByTimeAsync(500)
    await flushed
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]![0])).toMatch(/503 after retry/)
    // The batch is gone: a later flush does not resend it.
    await sink.flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries once on network error, then drops via onError', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'))
    const onError = vi.fn()
    const sink = createHttpEventSink({
      url: 'https://x',
      apiKey: 'k',
      fetchImpl: fetchMock,
      onError,
    })
    sink.emit(makeEvent())
    const flushed = sink.flush()
    await vi.advanceTimersByTimeAsync(500)
    await flushed
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]![0])).toMatch(/network error after retry/)
  })

  it('drops immediately on 4xx without retrying (bad key / bad payload)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('unauthorized', { status: 401 }))
    const onError = vi.fn()
    const sink = createHttpEventSink({
      url: 'https://x',
      apiKey: 'bad',
      fetchImpl: fetchMock,
      onError,
    })
    sink.emit(makeEvent())
    await sink.flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]![0])).toMatch(/401/)
    expect(String(onError.mock.calls[0]![0])).not.toMatch(/after retry/)
  })

  it('emit never throws even when fetchImpl throws synchronously', async () => {
    const fetchMock = (() => {
      throw new Error('boom')
    }) as unknown as typeof fetch
    const onError = vi.fn()
    const sink = createHttpEventSink({
      url: 'https://x',
      apiKey: 'k',
      maxBatch: 1,
      fetchImpl: fetchMock,
      onError,
    })
    expect(() => sink.emit(makeEvent())).not.toThrow()
    await vi.advanceTimersByTimeAsync(500)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]![0])).toMatch(/network error after retry/)
  })

  it('drops invalid events via onError without throwing and without queueing', async () => {
    const fetchMock = okFetch()
    const onError = vi.fn()
    const sink = createHttpEventSink({
      url: 'https://x',
      apiKey: 'k',
      fetchImpl: fetchMock,
      onError,
    })
    const invalid = { event_id: 'evt_x' } as unknown as RebilderEventV0
    expect(() => sink.emit(invalid)).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]![0])).toMatch(/invalid RebilderEventV0/)
    await sink.flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('swallows throws from the onError callback itself', () => {
    const sink = createHttpEventSink({
      url: 'https://x',
      apiKey: 'k',
      fetchImpl: okFetch(),
      onError: () => {
        throw new Error('observer misbehaves')
      },
    })
    const invalid = {} as unknown as RebilderEventV0
    expect(() => sink.emit(invalid)).not.toThrow()
  })

  it('caps the queue at 1000, dropping the oldest via onError', async () => {
    const fetchMock = okFetch()
    const onError = vi.fn()
    const sink = createHttpEventSink({
      url: 'https://x',
      apiKey: 'k',
      maxBatch: 5000, // never auto-flush in this test
      fetchImpl: fetchMock,
      onError,
    })
    const first = makeEvent()
    sink.emit(first)
    for (let i = 0; i < 1000; i += 1) {
      sink.emit(makeEvent())
    }
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]![0])).toMatch(/queue full \(cap 1000\)/)
    await sink.flush()
    const events = sentEvents(fetchMock)
    expect(events).toHaveLength(1000)
    expect(events[0]!.event_id).not.toBe(first.event_id)
  })
})

describe('createHttpEventSink — close semantics', () => {
  it('close flushes the queue and stops the timer', async () => {
    const fetchMock = okFetch()
    const sink = createHttpEventSink({ url: 'https://x', apiKey: 'k', fetchImpl: fetchMock })
    sink.emit(makeEvent())
    await sink.close()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('emit after close drops via onError and never sends', async () => {
    const fetchMock = okFetch()
    const onError = vi.fn()
    const sink = createHttpEventSink({
      url: 'https://x',
      apiKey: 'k',
      fetchImpl: fetchMock,
      onError,
    })
    await sink.close()
    expect(() => sink.emit(makeEvent())).not.toThrow()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]![0])).toMatch(/emit\(\) after close\(\)/)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('close is idempotent', async () => {
    const fetchMock = okFetch()
    const sink = createHttpEventSink({ url: 'https://x', apiKey: 'k', fetchImpl: fetchMock })
    sink.emit(makeEvent())
    await sink.close()
    await sink.close()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('createConsoleEventSink', () => {
  it('logs one [rebilder-event] {json} line per event via console.info', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const sink = createConsoleEventSink()
    const event = makeEvent()
    sink.emit(event)
    expect(info).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledWith(`[rebilder-event] ${JSON.stringify(event)}`)
  })

  it('flush and close resolve immediately', async () => {
    const sink = createConsoleEventSink()
    await expect(sink.flush()).resolves.toBeUndefined()
    await expect(sink.close()).resolves.toBeUndefined()
  })

  it('emit never throws even on unserializable events', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const sink = createConsoleEventSink()
    const circular = makeEvent()
    ;(circular.request.intent_signals as Record<string, unknown>)['self'] = circular
    expect(() => sink.emit(circular)).not.toThrow()
  })
})
