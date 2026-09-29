/**
 * Hand-written structural validation for the v0 event contract.
 *
 * No schema library on purpose: this package ships with zero runtime
 * dependencies and runs on the edge. Unknown extra keys are ALLOWED at every
 * level — schema changes are additive (project convention), so a v0
 * consumer must accept events produced by a later additive revision.
 */
import type { RebilderEventV0 } from './types'

/** The schema version this package validates and emits. */
export const EVENTS_SCHEMA_VERSION = 'v0'

const REQUESTER_KINDS = ['agent', 'human', 'protocol', 'crawler'] as const
const RESPONSE_PATHS = ['markdown', 'html-variant', 'protocol', 'denied'] as const
/**
 * ResponseCoverageV0 — a CLOSED set (unlike `response.source`, which is open
 * like `requester.platform`). Validated because the Miss Report and the
 * hosted ingest service both depend on exactly these three values; a fourth
 * is a schema revision, not a payload.
 */
const RESPONSE_COVERAGES = ['sourced', 'unsourced', 'not-applicable'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

/** First problem found, or null when the value is a valid RebilderEventV0. */
function firstProblem(value: unknown): string | null {
  if (!isRecord(value)) return `event must be an object, got ${describe(value)}`

  // Required string scalars.
  for (const key of ['event_id', 'ts', 'store_id'] as const) {
    if (value[key] === undefined) return `missing required field '${key}'`
    if (typeof value[key] !== 'string') return `'${key}' must be a string, got ${describe(value[key])}`
  }

  // requester
  const requester = value['requester']
  if (requester === undefined) return `missing required field 'requester'`
  if (!isRecord(requester)) return `'requester' must be an object, got ${describe(requester)}`
  if (requester['kind'] === undefined) return `missing required field 'requester.kind'`
  if (!(REQUESTER_KINDS as readonly unknown[]).includes(requester['kind'])) {
    return `'requester.kind' must be one of ${REQUESTER_KINDS.map((k) => `'${k}'`).join(' | ')}, got ${JSON.stringify(requester['kind'])}`
  }
  if (requester['platform'] !== undefined && typeof requester['platform'] !== 'string') {
    return `'requester.platform' must be a string when present, got ${describe(requester['platform'])}`
  }
  if (requester['verified'] === undefined) return `missing required field 'requester.verified'`
  if (typeof requester['verified'] !== 'boolean') {
    return `'requester.verified' must be a boolean, got ${describe(requester['verified'])}`
  }

  // request
  const request = value['request']
  if (request === undefined) return `missing required field 'request'`
  if (!isRecord(request)) return `'request' must be an object, got ${describe(request)}`
  if (request['url'] === undefined) return `missing required field 'request.url'`
  if (typeof request['url'] !== 'string') {
    return `'request.url' must be a string, got ${describe(request['url'])}`
  }
  if (request['intent_signals'] === undefined) return `missing required field 'request.intent_signals'`
  if (!isRecord(request['intent_signals'])) {
    return `'request.intent_signals' must be an object, got ${describe(request['intent_signals'])}`
  }
  for (const key of ['accept', 'referrer'] as const) {
    if (request[key] !== undefined && typeof request[key] !== 'string') {
      return `'request.${key}' must be a string when present, got ${describe(request[key])}`
    }
  }

  // response
  const response = value['response']
  if (response === undefined) return `missing required field 'response'`
  if (!isRecord(response)) return `'response' must be an object, got ${describe(response)}`
  if (response['path'] === undefined) return `missing required field 'response.path'`
  if (!(RESPONSE_PATHS as readonly unknown[]).includes(response['path'])) {
    return `'response.path' must be one of ${RESPONSE_PATHS.map((p) => `'${p}'`).join(' | ')}, got ${JSON.stringify(response['path'])}`
  }
  if (response['variant_id'] !== undefined && typeof response['variant_id'] !== 'string') {
    return `'response.variant_id' must be a string when present, got ${describe(response['variant_id'])}`
  }
  if (response['render_ms'] === undefined) return `missing required field 'response.render_ms'`
  if (typeof response['render_ms'] !== 'number' || !Number.isFinite(response['render_ms'])) {
    return `'response.render_ms' must be a finite number, got ${describe(response['render_ms'])}`
  }
  if (response['profile_id'] !== undefined && (typeof response['profile_id'] !== 'string' || !/^[a-z0-9-]{1,64}$/.test(response['profile_id']))) return "'response.profile_id' must be a bounded profile identifier"
  for (const key of ['profile_version', 'compatibility_runtime'] as const) {
    if (response[key] !== undefined && (!Number.isSafeInteger(response[key]) || (response[key] as number) < 1)) return `'response.${key}' must be a positive integer`
  }
  // ADDITIVE v0.2 — both optional, so every v0.1 event still validates.
  if (response['source'] !== undefined && typeof response['source'] !== 'string') {
    return `'response.source' must be a string when present, got ${describe(response['source'])}`
  }
  if (
    response['coverage'] !== undefined &&
    !(RESPONSE_COVERAGES as readonly unknown[]).includes(response['coverage'])
  ) {
    return `'response.coverage' must be one of ${RESPONSE_COVERAGES.map((c) => `'${c}'`).join(' | ')} when present, got ${JSON.stringify(response['coverage'])}`
  }

  // outcome (optional; all fields optional — joined async in the warehouse)
  const outcome = value['outcome']
  if (outcome !== undefined) {
    if (!isRecord(outcome)) return `'outcome' must be an object when present, got ${describe(outcome)}`
    for (const key of ['cited', 'referred', 'add_to_cart', 'purchase'] as const) {
      if (outcome[key] !== undefined && typeof outcome[key] !== 'boolean') {
        return `'outcome.${key}' must be a boolean when present, got ${describe(outcome[key])}`
      }
    }
    if (
      outcome['order_value'] !== undefined &&
      (typeof outcome['order_value'] !== 'number' || !Number.isFinite(outcome['order_value']))
    ) {
      return `'outcome.order_value' must be a finite number when present, got ${describe(outcome['order_value'])}`
    }
  }

  return null
}

/**
 * Structural runtime check that `value` conforms to the v0 event contract.
 * Unknown extra keys pass (additive forward-compat). Never throws.
 */
export function validateEventV0(value: unknown): value is RebilderEventV0 {
  return firstProblem(value) === null
}

/**
 * Like {@link validateEventV0} but throws a descriptive Error naming the
 * first offending field. Use at trust boundaries (e.g. ingest).
 */
export function assertEventV0(value: unknown): asserts value is RebilderEventV0 {
  const problem = firstProblem(value)
  if (problem !== null) {
    throw new Error(`invalid RebilderEventV0: ${problem}`)
  }
}

/** Internal — used by sinks to report why an event was dropped. Not public API. */
export { firstProblem as explainEventV0 }
