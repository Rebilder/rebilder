import { describe, expect, it } from 'vitest'
import {
  EVENTS_SCHEMA_VERSION,
  assertEventV0,
  validateEventV0,
  type RebilderEventV0,
} from '../src/index'

/** A minimal valid v0 event (only required fields). */
function minimalEvent(): RebilderEventV0 {
  return {
    event_id: 'evt_1',
    ts: '2026-08-04T12:00:00.000Z',
    store_id: 'store_1',
    requester: { kind: 'agent', verified: false },
    request: { url: 'https://shop.example/products/x', intent_signals: {} },
    response: { path: 'markdown', render_ms: 12 },
  }
}

/** A fully populated valid v0 event (every optional field set). */
function fullEvent(): RebilderEventV0 {
  return {
    event_id: 'evt_2',
    ts: '2026-08-04T12:00:01.000Z',
    store_id: 'store_1',
    requester: { kind: 'crawler', platform: 'chatgpt', verified: true },
    request: {
      url: 'https://shop.example/products/x?ref=agent',
      intent_signals: { query: 'waterproof boots' },
      accept: 'text/markdown',
      referrer: 'https://chat.example/',
    },
    response: {
      path: 'html-variant',
      variant_id: 'var_9',
      render_ms: 3.5,
      source: 'product',
      coverage: 'sourced',
    },
    outcome: { cited: true, referred: false, add_to_cart: true, purchase: true, order_value: 12900 },
  }
}

/** Clone-and-mutate helper for the reject tables. */
function mutate(mutator: (event: Record<string, unknown>) => void): unknown {
  const event = structuredClone(fullEvent()) as unknown as Record<string, unknown>
  mutator(event)
  return event
}

describe('EVENTS_SCHEMA_VERSION', () => {
  it("is 'v0'", () => {
    expect(EVENTS_SCHEMA_VERSION).toBe('v0')
  })
})

describe('validateEventV0 — accepts', () => {
  it('accepts a minimal event (required fields only)', () => {
    expect(validateEventV0(minimalEvent())).toBe(true)
  })

  it('accepts a fully populated event (every optional field)', () => {
    expect(validateEventV0(fullEvent())).toBe(true)
  })

  it('accepts any requester.kind in the v0 enum', () => {
    for (const kind of ['agent', 'human', 'protocol', 'crawler'] as const) {
      const event = minimalEvent()
      event.requester.kind = kind
      expect(validateEventV0(event)).toBe(true)
    }
  })

  it('accepts any response.path in the v0 enum', () => {
    for (const path of ['markdown', 'html-variant', 'protocol'] as const) {
      const event = minimalEvent()
      event.response.path = path
      expect(validateEventV0(event)).toBe(true)
    }
  })

  it('accepts a newly observed platform string (open set)', () => {
    const event = minimalEvent()
    event.requester.platform = 'some-brand-new-agent'
    expect(validateEventV0(event)).toBe(true)
  })

  it('accepts unknown extra keys at every level (additive forward-compat)', () => {
    const event = mutate((e) => {
      e['future_root_field'] = { anything: true }
      ;(e['requester'] as Record<string, unknown>)['future_field'] = 1
      ;(e['request'] as Record<string, unknown>)['future_field'] = ['x']
      ;(e['response'] as Record<string, unknown>)['future_field'] = null
      ;(e['outcome'] as Record<string, unknown>)['future_field'] = 'later'
    })
    expect(validateEventV0(event)).toBe(true)
  })

  it('accepts a partially populated outcome', () => {
    const event = minimalEvent()
    event.outcome = { cited: true }
    expect(validateEventV0(event)).toBe(true)
  })

  it('narrows the type: a validated unknown is usable as RebilderEventV0', () => {
    const value: unknown = minimalEvent()
    expect(validateEventV0(value)).toBe(true)
    if (validateEventV0(value)) {
      expect(value.store_id).toBe('store_1')
    }
  })
})

describe('validateEventV0 — rejects non-objects', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'evt'],
    ['a number', 42],
    ['an array', []],
  ])('rejects %s', (_name, value) => {
    expect(validateEventV0(value)).toBe(false)
  })
})

describe('validateEventV0 — rejects missing required fields', () => {
  it.each([
    ['event_id', mutate((e) => delete e['event_id'])],
    ['ts', mutate((e) => delete e['ts'])],
    ['store_id', mutate((e) => delete e['store_id'])],
    ['requester', mutate((e) => delete e['requester'])],
    ['requester.kind', mutate((e) => delete (e['requester'] as Record<string, unknown>)['kind'])],
    [
      'requester.verified',
      mutate((e) => delete (e['requester'] as Record<string, unknown>)['verified']),
    ],
    ['request', mutate((e) => delete e['request'])],
    ['request.url', mutate((e) => delete (e['request'] as Record<string, unknown>)['url'])],
    [
      'request.intent_signals',
      mutate((e) => delete (e['request'] as Record<string, unknown>)['intent_signals']),
    ],
    ['response', mutate((e) => delete e['response'])],
    ['response.path', mutate((e) => delete (e['response'] as Record<string, unknown>)['path'])],
    [
      'response.render_ms',
      mutate((e) => delete (e['response'] as Record<string, unknown>)['render_ms']),
    ],
  ])('rejects when %s is missing', (_field, value) => {
    expect(validateEventV0(value)).toBe(false)
  })
})

describe('validateEventV0 — rejects bad enum members', () => {
  it.each([
    ['requester.kind = "bot"', mutate((e) => ((e['requester'] as Record<string, unknown>)['kind'] = 'bot'))],
    ['requester.kind = 1', mutate((e) => ((e['requester'] as Record<string, unknown>)['kind'] = 1))],
    ['response.path = "json"', mutate((e) => ((e['response'] as Record<string, unknown>)['path'] = 'json'))],
    ['response.path = null', mutate((e) => ((e['response'] as Record<string, unknown>)['path'] = null))],
  ])('rejects %s', (_name, value) => {
    expect(validateEventV0(value)).toBe(false)
  })
})

describe('validateEventV0 — rejects wrong field types', () => {
  it.each([
    ['event_id is a number', mutate((e) => (e['event_id'] = 42))],
    ['ts is a number', mutate((e) => (e['ts'] = 1722772800))],
    ['store_id is null', mutate((e) => (e['store_id'] = null))],
    ['requester is a string', mutate((e) => (e['requester'] = 'agent'))],
    ['requester is an array', mutate((e) => (e['requester'] = ['agent']))],
    [
      'requester.platform is a number',
      mutate((e) => ((e['requester'] as Record<string, unknown>)['platform'] = 7)),
    ],
    [
      'requester.verified is a string',
      mutate((e) => ((e['requester'] as Record<string, unknown>)['verified'] = 'yes')),
    ],
    ['request is a string', mutate((e) => (e['request'] = 'https://x'))],
    ['request.url is a number', mutate((e) => ((e['request'] as Record<string, unknown>)['url'] = 1))],
    [
      'request.intent_signals is null',
      mutate((e) => ((e['request'] as Record<string, unknown>)['intent_signals'] = null)),
    ],
    [
      'request.intent_signals is an array',
      mutate((e) => ((e['request'] as Record<string, unknown>)['intent_signals'] = [])),
    ],
    [
      'request.accept is a number',
      mutate((e) => ((e['request'] as Record<string, unknown>)['accept'] = 5)),
    ],
    [
      'request.referrer is an object',
      mutate((e) => ((e['request'] as Record<string, unknown>)['referrer'] = {})),
    ],
    ['response is an array', mutate((e) => (e['response'] = []))],
    [
      'response.variant_id is a number',
      mutate((e) => ((e['response'] as Record<string, unknown>)['variant_id'] = 9)),
    ],
    [
      'response.render_ms is a string',
      mutate((e) => ((e['response'] as Record<string, unknown>)['render_ms'] = 'fast')),
    ],
    [
      'response.render_ms is NaN',
      mutate((e) => ((e['response'] as Record<string, unknown>)['render_ms'] = Number.NaN)),
    ],
    ['outcome is a string', mutate((e) => (e['outcome'] = 'later'))],
    [
      'outcome.cited is a string',
      mutate((e) => ((e['outcome'] as Record<string, unknown>)['cited'] = 'yes')),
    ],
    [
      'outcome.purchase is a number',
      mutate((e) => ((e['outcome'] as Record<string, unknown>)['purchase'] = 1)),
    ],
    [
      'outcome.order_value is a string',
      mutate((e) => ((e['outcome'] as Record<string, unknown>)['order_value'] = 'high')),
    ],
  ])('rejects when %s', (_name, value) => {
    expect(validateEventV0(value)).toBe(false)
  })
})

/**
 * events 0.2.0 — `response.source` and `response.coverage`. The point of these
 * being additive is that nothing about 0.1.0 changed, so the first two tests
 * matter more than the rest: a producer that has never heard of these fields
 * still validates.
 */
describe('validateEventV0 — response.source / response.coverage (additive v0.2)', () => {
  it('accepts an event with neither field (a v0.1 producer)', () => {
    const event = minimalEvent()
    expect(event.response.source).toBeUndefined()
    expect(event.response.coverage).toBeUndefined()
    expect(validateEventV0(event)).toBe(true)
  })

  it('accepts an event with only one of the two set', () => {
    const withSource = minimalEvent()
    withSource.response.source = 'document'
    expect(validateEventV0(withSource)).toBe(true)

    const withCoverage = minimalEvent()
    withCoverage.response.coverage = 'unsourced'
    expect(validateEventV0(withCoverage)).toBe(true)
  })

  it('accepts every source kind the gateway can emit, plus none', () => {
    for (const source of [
      'product',
      'policies',
      'catalog',
      'document',
      'collection',
      'none',
    ] as const) {
      const event = minimalEvent()
      event.response.source = source
      expect(validateEventV0(event)).toBe(true)
    }
  })

  it('accepts a source kind that does not exist yet (open set, like platform)', () => {
    const event = minimalEvent()
    event.response.source = 'some-future-source-kind'
    expect(validateEventV0(event)).toBe(true)
  })

  it('accepts every coverage value in the closed set', () => {
    for (const coverage of ['sourced', 'unsourced', 'not-applicable'] as const) {
      const event = minimalEvent()
      event.response.coverage = coverage
      expect(validateEventV0(event)).toBe(true)
    }
  })

  it('records a miss as coverage=unsourced on the html-variant path', () => {
    // The shape the Agent Miss Report reads: the gateway passed through to
    // the merchant's HTML, so `path` is 'html-variant' — only `coverage`
    // distinguishes this from a human page view.
    const event = minimalEvent()
    event.response.path = 'html-variant'
    event.response.source = 'none'
    event.response.coverage = 'unsourced'
    expect(validateEventV0(event)).toBe(true)
  })

  it.each([
    ['coverage = "sourcd" (typo)', 'sourcd'],
    ['coverage = "none"', 'none'],
    ['coverage = "unknown"', 'unknown'],
    ['coverage = null', null],
    ['coverage = 1', 1],
    ['coverage = ["sourced"]', ['sourced']],
  ])('rejects %s — coverage is a CLOSED set', (_name, value) => {
    const event = mutate((e) => ((e['response'] as Record<string, unknown>)['coverage'] = value))
    expect(validateEventV0(event)).toBe(false)
  })

  it.each([
    ['source = 7', 7],
    ['source = null', null],
    ['source = {}', {}],
  ])('rejects %s — source must be a string when present', (_name, value) => {
    const event = mutate((e) => ((e['response'] as Record<string, unknown>)['source'] = value))
    expect(validateEventV0(event)).toBe(false)
  })

  it('names the offending field in the assert message', () => {
    const bad = mutate((e) => ((e['response'] as Record<string, unknown>)['coverage'] = 'nope'))
    expect(() => assertEventV0(bad)).toThrow(/response\.coverage/)
    expect(() => assertEventV0(bad)).toThrow(/'sourced' \| 'unsourced' \| 'not-applicable'/)
  })
})

describe('assertEventV0', () => {
  it('does not throw on a valid event', () => {
    expect(() => assertEventV0(fullEvent())).not.toThrow()
  })

  it('throws a descriptive error naming the offending field', () => {
    const bad = mutate((e) => ((e['requester'] as Record<string, unknown>)['kind'] = 'bot'))
    expect(() => assertEventV0(bad)).toThrow(/invalid RebilderEventV0/)
    expect(() => assertEventV0(bad)).toThrow(/requester\.kind/)
  })

  it('names missing required fields', () => {
    const bad = mutate((e) => delete e['store_id'])
    expect(() => assertEventV0(bad)).toThrow(/missing required field 'store_id'/)
  })

  it('rejects a non-object with a clear message', () => {
    expect(() => assertEventV0(null)).toThrow(/event must be an object, got null/)
  })
})

describe('compatibility metadata', () => {
  it('accepts additive actual-profile fields while retaining old events', () => {
    expect(validateEventV0(minimalEvent())).toBe(true)
    expect(validateEventV0({ ...minimalEvent(), response: { ...minimalEvent().response, profile_id: 'source-envelope', profile_version: 1, compatibility_runtime: 1 } })).toBe(true)
  })
  it.each([{ profile_id: 'a'.repeat(65) }, { profile_id: 'bad\nheader' }, { profile_version: -1 }, { profile_version: 1.5 }, { compatibility_runtime: '1' }])('rejects malformed profile metadata %j', (patch) => {
    expect(validateEventV0({ ...minimalEvent(), response: { ...minimalEvent().response, ...patch } })).toBe(false)
  })
})
