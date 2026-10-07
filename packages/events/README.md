# @rebilder/events

Typed request events for `@rebilder/gateway`, with validation and sinks that send them to Rebilder or to your own logs. Record which AI agents read your site, what they asked for and what they received.

It has no runtime dependencies and runs anywhere with web-standard `fetch` and timers, including edge runtimes.

## Install

```sh
npm install @rebilder/events
```

`@rebilder/gateway` already depends on this package and calls it at runtime to build events. Add it to your own dependencies when you import a sink.

## Send events from the gateway

```ts
import type { GatewayConfig } from '@rebilder/gateway'
import { createHttpEventSink } from '@rebilder/events'

const sink = createHttpEventSink({ url: 'https://api.rebilder.com', apiKey: '...' })

export const gatewayConfig: GatewayConfig = {
  storeId: 'my-store',
  sources: {
    /* ... */
  },
  onEvent: (event) => sink.emit(event),
}
```

Create the sink once, at module scope. It batches, so a sink created inside a request handler is discarded before it sends anything. Read the API key from an environment variable rather than writing it in the file.

## HTTP sink

```ts
import { createHttpEventSink } from '@rebilder/events'

const sink = createHttpEventSink({
  url: 'https://api.rebilder.com', // ingest base; the sink POSTs to `${url}/v1/events`
  apiKey: process.env.REBILDER_API_KEY!, // sent as `Authorization: Bearer <apiKey>`
  // maxBatch: 20,           flush as soon as the queue reaches this many events
  // flushIntervalMs: 2000,  flush timer while the queue is non-empty
  // fetchImpl: fetch,       injectable for tests; defaults to globalThis.fetch
  // onError: console.warn,  called for every dropped event or batch; never rethrown
})

sink.emit(event) // sync enqueue; invalid events dropped via onError, never thrown
await sink.flush() // send the queue now; resolves even on failure
await sink.close() // flush remaining events + stop the timer; later emits are dropped
```

Sending events never breaks serving:

- `emit()` never throws, and `flush()` and `close()` never reject. Failures go to `onError` and the batch is dropped.
- Network errors and 5xx responses get one retry after 500 ms. A 4xx drops the batch at once.
- The queue holds at most 1,000 events. Beyond that the oldest is dropped.

## Console sink

```ts
import { createConsoleEventSink } from '@rebilder/events'

const sink = createConsoleEventSink()
sink.emit(event) // console.info('[rebilder-event] {"event_id":...}')
```

One `[rebilder-event] {json}` line per event, for platforms where you read logs rather than send events. The event is the same object, so switching sinks changes nothing else.

## Wire protocol

Any endpoint that implements this contract can receive events from the HTTP sink:

```
POST {url}/v1/events
Authorization: Bearer <apiKey>
Content-Type: application/json

{ "events": RebilderEventV0[] }
```

- Any `2xx` is success. Rebilder's endpoint answers `202` with `{ "accepted": <n> }`.
- `event_id` is the idempotency key. The client retries a batch at most once, so deduplicate on it.

## The event

`RebilderEventV0` records who asked, what they asked for and how the gateway answered:

- `requester`: `kind` (`agent`, `human`, `crawler` or `protocol`), `platform` when known, and `verified`.
- `request`: `url` (query string limited to a short allowlist), `accept`, `referrer` and `intent_signals`.
- `response`: `path` (`markdown`, `html-variant`, `protocol` or `denied`), `render_ms`, and the `source` and `coverage` that applied.
- `outcome`: optional, joined later: citation, referral, add to cart, purchase, booking, quote and completed action. For money, report paired `order_value_minor` (a non-negative safe integer) and `currency` (three uppercase letters). The legacy `order_value` field remains accepted but its units are not normalized.

`validateEventV0(value)` is a type guard that never throws. `assertEventV0(value)` throws an error naming the first bad field. Both accept unknown extra keys, because schema changes are additive.

## Intent signals

`request.intent_signals` uses these keys, produced by the helpers in this package so every source writes the same shape:

| Key                         | Meaning                                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `query`                     | Search text sent to your site, after `scrubQueryText`                                                                       |
| `query_param`               | Where the query came from: `q`, `s` and so on, or a tool name such as `mcp.search_catalog`                                  |
| `referrer_platform`         | The AI platform named by the Referer (`chatgpt`, `perplexity`, …). On a `human` event, an AI conversation sent this visitor |
| `utm_source` / `utm_medium` | Campaign parameters, sanitized                                                                                              |
| `tool`                      | Protocol tool or operation name                                                                                             |
| `result_count`              | Number of search results; `0` is demand your catalog could not answer                                                       |
| `capability_version`        | `1` for explicit capability signals below |
| `requested_capability`      | A supported capability ID such as `pricing.read` or `quote.request` |
| `missing_capability`        | The requested capability when the adapter explicitly reports it unavailable |
| `action_status`             | An explicit action result: `requested`, `offered`, `succeeded`, `failed` or `unsupported` |

`scrubQueryText` drops the whole query when it contains an `@`, a run of seven or more digits, a token-like fragment, a URL, or more than 200 characters. It never partially redacts.

## Commercial demand

`classifyDemand(observation)` groups agent and protocol requests using their observed tool, screened query, source or route. Its result includes a category, classification basis, commercial-interest flag and an observed gap. The classifier is deterministic and carries `DEMAND_CLASSIFICATION_VERSION`; it does not infer purchase attribution. A missing capability or failed action is counted only when explicitly reported.

`unfulfilled` requires commercial interest plus an explicit unsourced response, a protocol response with numeric `result_count: 0`, an explicitly missing capability, or an explicitly failed/unsupported action. Diagnostic installation checks are excluded. Access-policy denials, unknown coverage and ordinary HTML pass-through are not fulfillment gaps. Human and crawler requests never count as commercial agent demand.

`demandSignals(observation)` returns additive keys for `intent_signals`: `demand_version`, `intent_category`, `intent_basis`, `commercial_intent`, `unfulfilled_demand` and `demand_gap`. Hosted ingest derives these fields from the event, overriding supplied labels. Earlier events remain valid and can be classified from their original observations.

## Public capability snapshots

`CapabilitySnapshotV1` is a versioned declaration of public information and action capabilities for a domain. `CAPABILITIES` lists the ten supported identifiers. Each entry has an evidence source and a status: `declared`, `verified`, `unavailable` or `unknown`.

`parseCapabilitySnapshot(value)` returns a validated snapshot or `null`. It rejects unknown fields, duplicate identifiers, private or credential-bearing endpoint addresses, and action capabilities marked verified by a serving probe. A declaration never grants negotiation, payment or account authority. Private seller limits, analytics, credentials and customer records do not belong in this shape.

`capabilitySignals(value)` keeps only the finite capability identifiers and action statuses for event reporting. `stampIntentSignalHeaders` and `readIntentSignalHeaders` transport these signals through protocol responses; the gateway removes the headers before serving the response.

## Page-view events

`ClientEventV0` is the wire type of the Rebilder Tag page-view beacon: `{ store, path, ref?, wd? }`. `path` never includes a query string, and `ref` is present only for a cross-origin referrer. The stored page view excludes cookies, visitor or session IDs, IP addresses and User-Agent strings.

## Versioning

Schema changes are versioned and additive. Removing a field needs a new schema version and a migration note in `CHANGELOG.md`, which ships with this package.

Full docs: [rebilder.com/docs/events](https://rebilder.com/docs/events). Licensed under Apache-2.0. Source, issues and pull requests: [GitHub](https://github.com/rebilder/rebilder/tree/main/packages/events).
