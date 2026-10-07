import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES,
  capabilitySignals,
  parseCapabilitySnapshot,
  normalizeCapabilityEndpoint,
  buildProtocolIntentSignals,
  stampIntentSignalHeaders,
  readIntentSignalHeaders,
  stripIntentSignalHeaders,
  classifyDemand,
  validateEventV0,
} from '../src/index'

const snapshot = () => ({
  schema_version: 1,
  domain: 'merchant.com',
  generated_at: '2026-10-07T12:00:00.000Z',
  capabilities: [
    {
      id: 'pricing.read',
      endpoint: 'https://merchant.com/prices',
      status: 'verified',
      evidence_source: 'probe',
      checked_at: '2026-10-07T11:00:00.000Z',
    },
  ],
})
describe('public capability snapshot boundary', () => {
  it('accepts the bounded versioned public vocabulary', () => {
    expect(parseCapabilitySnapshot(snapshot())).toEqual(snapshot())
    expect(CAPABILITIES).toHaveLength(10)
  })
  it.each([
    (s: ReturnType<typeof snapshot>) => ({ ...s, private_policy: { margin: 20 } }),
    (s: ReturnType<typeof snapshot>) => ({
      ...s,
      capabilities: [{ ...s.capabilities[0], private_policy: 'secret' }],
    }),
    (s: ReturnType<typeof snapshot>) => ({ ...s, schema_version: 2 }),
    (s: ReturnType<typeof snapshot>) => ({
      ...s,
      capabilities: [...s.capabilities, ...s.capabilities],
    }),
    (s: ReturnType<typeof snapshot>) => ({
      ...s,
      capabilities: [{ ...s.capabilities[0], id: 'payment.execute' }],
    }),
    (s: ReturnType<typeof snapshot>) => ({
      ...s,
      capabilities: [{ ...s.capabilities[0], evidence_source: 'merchant' }],
    }),
    (s: ReturnType<typeof snapshot>) => ({
      ...s,
      capabilities: [{ ...s.capabilities[0], id: 'booking.create' }],
    }),
    (s: ReturnType<typeof snapshot>) => ({
      ...s,
      capabilities: [{ ...s.capabilities[0], endpoint: undefined }],
    }),
    (s: ReturnType<typeof snapshot>) => ({
      ...s,
      capabilities: [{ ...s.capabilities[0], checked_at: '2026-10-08T11:00:00.000Z' }],
    }),
    (s: ReturnType<typeof snapshot>) => ({ ...s, generated_at: '2026-02-30T12:00:00.000Z' }),
  ])('rejects unknown data, unsupported versions and invented evidence', (mutate) => {
    expect(parseCapabilitySnapshot(mutate(snapshot()))).toBeNull()
  })
  it.each([
    'http://merchant.com/prices',
    'https://user:password@example.com/',
    'https://merchant.com/?token=secret',
    'https://merchant.com/#secret',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://2130706433/',
    'https://internal.local/',
    'https://merchant.com:444/',
  ])('rejects unsafe or credential-bearing endpoints: %s', (endpoint) => {
    expect(normalizeCapabilityEndpoint(endpoint)).toBeNull()
  })
  it('normalizes public endpoints but requires canonical exports', () => {
    expect(normalizeCapabilityEndpoint('https://Merchant.com:443')).toBe('https://merchant.com/')
    const value = snapshot()
    value.capabilities[0]!.endpoint = 'https://Merchant.com:443'
    expect(parseCapabilitySnapshot(value)).toBeNull()
  })
})

describe('explicit action signals', () => {
  it('round-trips finite signals and strips the internal response channel', () => {
    const signals = buildProtocolIntentSignals({
      tool: 'booking.create',
      requestedCapability: 'booking.create',
      missingCapability: 'booking.create',
      actionStatus: 'unsupported',
    })
    const headers = new Headers({ 'content-type': 'application/json' })
    stampIntentSignalHeaders(headers, signals)
    expect(readIntentSignalHeaders(headers)).toEqual(signals)
    stripIntentSignalHeaders(headers)
    expect([...headers.keys()]).toEqual(['content-type'])
  })
  it('does not infer completed actions from tool calls', () => {
    expect(buildProtocolIntentSignals({ tool: 'ucp.checkout' })).toEqual({
      tool: 'ucp.checkout',
      capability_version: 1,
      requested_capability: 'checkout.create',
    })
    expect(
      capabilitySignals({
        capability_version: 1,
        requested_capability: 'pricing.read',
        action_status: 'succeeded',
      }),
    ).not.toHaveProperty('action_status')
    expect(
      capabilitySignals({
        capability_version: 1,
        requested_capability: 'booking.create',
        missing_capability: 'booking.create',
        action_status: 'succeeded',
      }),
    ).toEqual({})
  })
  it('distinguishes explicit missing actions from denied access and diagnostic probes', () => {
    const observation = {
      requesterKind: 'protocol',
      url: 'https://merchant.com/tools',
      responsePath: 'protocol',
      intentSignals: {
        capability_version: 1,
        requested_capability: 'booking.create',
        missing_capability: 'booking.create',
        action_status: 'unsupported',
      },
    }
    expect(classifyDemand(observation)).toMatchObject({
      category: 'booking',
      gap: 'missing-capability',
      commercial: true,
    })
    expect(classifyDemand({ ...observation, responsePath: 'denied' })).toMatchObject({
      gap: null,
      denied: true,
    })
    expect(
      classifyDemand({
        ...observation,
        intentSignals: { ...observation.intentSignals, diagnostic: 'install-check' },
      }),
    ).toMatchObject({ commercial: false, gap: null })
    expect(
      classifyDemand({
        ...observation,
        intentSignals: {
          capability_version: 1,
          requested_capability: 'booking.create',
          action_status: 'failed',
        },
      }),
    ).toMatchObject({ gap: 'action-failed' })
  })
  it('preserves a specific commercial question on a general catalog operation', () => {
    expect(
      classifyDemand({
        requesterKind: 'protocol',
        url: 'https://merchant.com/tools',
        responsePath: 'protocol',
        intentSignals: buildProtocolIntentSignals({
          tool: 'mcp.search_catalog',
          query: 'available appointments',
        }),
      }),
    ).toMatchObject({ category: 'availability', basis: 'query' })
  })
  it('requires typed outcomes and explicit currency for minor-unit amounts', () => {
    const event = {
      event_id: 'e',
      store_id: 's',
      ts: '2026-10-07T12:00:00.000Z',
      requester: { kind: 'protocol', verified: false },
      request: { url: 'https://merchant.com/', intent_signals: {} },
      response: { path: 'protocol', render_ms: 1 },
    }
    expect(
      validateEventV0({
        ...event,
        outcome: {
          booking: true,
          quote: true,
          action_completed: true,
          order_value_minor: 199,
          currency: 'USD',
        },
      }),
    ).toBe(true)
    for (const outcome of [
      { booking: 'true' },
      { quote: 1 },
      { order_value_minor: 199 },
      { order_value_minor: 1.5, currency: 'USD' },
      { order_value_minor: -1, currency: 'USD' },
      { currency: 'usd' },
    ])
      expect(validateEventV0({ ...event, outcome })).toBe(false)
  })
})
