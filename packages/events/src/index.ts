/**
 * @rebilder/events — THE observation-layer contract. See README.md.
 *
 * v0 event schema (frozen, additive-only) + structural runtime validation +
 * the Phase 1 edge emission client (ROADMAP.md § Phase 1: "packages/events
 * schema + edge emission"). Zero runtime dependencies, edge-safe.
 *
 * Schema rules (project conventions):
 * - All emission uses these types exclusively. Never ad-hoc analytics calls.
 * - Changes are versioned and additive; removing a field requires a
 *   migration note in this package's CHANGELOG.
 */
export const EVENTS_PACKAGE_STATUS =
  'phase 1 — v0 contract + validation + emission sinks; schema changes are versioned and additive'

// The v0 type contract (frozen; additive-only).
export type {
  RequesterKindV0,
  RequesterPlatformV0,
  ResponsePathV0,
  ResponseSourceV0,
  ResponseCoverageV0,
  RebilderEventRequesterV0,
  RebilderEventRequestV0,
  RebilderEventResponseV0,
  RebilderEventOutcomeV0,
  RebilderEventV0,
} from './types'

// Structural runtime validation.
export { EVENTS_SCHEMA_VERSION, validateEventV0, assertEventV0 } from './validate'

// Intent-signal extraction (v0.4) — the shared implementation every emitter
// uses to populate request.intent_signals with the well-known keys.
export {
  INTENT_QUERY_MAX_LENGTH,
  SEARCH_QUERY_PARAMS,
  INTENT_HEADER_TOOL,
  INTENT_HEADER_QUERY,
  INTENT_HEADER_RESULTS,
  scrubQueryText,
  classifyReferrerPlatform,
  extractUrlIntentSignals,
  buildProtocolIntentSignals,
  stampIntentSignalHeaders,
  readIntentSignalHeaders,
  stripIntentSignalHeaders,
} from './intent'

// Emission sinks (edge client + console fallback).
export type { EventSink, HttpEventSinkOptions } from './sink'
export { createHttpEventSink, createConsoleEventSink } from './sink'

// The Rebilder Tag wire contract (v0.5, additive) — a browser pageview
// beacon, a DIFFERENT observation from RebilderEventV0, which stays frozen.
export type { ClientEventV0 } from './client'
