# @rebilder/events changelog

Notable changes to `@rebilder/events`. Schema changes are versioned and additive: a removed field needs a new schema version and a migration note here. Dates are the day each version reached npm.

Versions 0.3.0 and 0.4.0 were never published. Their changes first reached npm in 0.5.0 and are listed there.

## Unreleased

- The source code is public at https://github.com/rebilder/rebilder/tree/main/packages/events. `repository` and `bugs` point there, and issues and pull requests are welcome.

## 0.7.0 (2026-09-28)

- **Requires Node.js 22 or later.** `engines.node` moves from `>=20.11.0` to `>=22`; Node.js 20 reached end of life in April 2026. Edge runtimes are unaffected.
- The README now says plainly that `@rebilder/gateway` calls this package at runtime, not only for its types. Better package description and keywords. This changelog now ships in the package and has been corrected to match what npm actually published.

## 0.6.0 (2026-09-13)

- Additive, optional `response.profile_id`, `response.profile_version` and `response.compatibility_runtime` record the markdown presentation the gateway actually served. Existing events stay valid. They identify the presentation, not a downstream model.

## 0.5.0 (2026-08-26)

Additive. No field removed, made required or narrowed; every earlier event stays valid.

- **`'denied'` on `ResponsePathV0`.** The site's own agent access policy refused the request with `403`, or `429` for a rate limit. It is its own path so a policy's effect is visible rather than folded into `html-variant`. An exhaustive `switch` over `ResponsePathV0` stops compiling until it handles `'denied'`, which is the intended way to find out.
- **Intent signals.** Well-known keys for `request.intent_signals` (`query`, `query_param`, `referrer_platform`, `utm_source`, `utm_medium`, `tool`, `result_count`) and the helpers that produce them: `scrubQueryText` (drops any query that could carry personal data, never partially redacts), `classifyReferrerPlatform`, `extractUrlIntentSignals`, `buildProtocolIntentSignals`, and the intent header helpers. `request.url` stays filtered to a short parameter allowlist.
- **`ClientEventV0`**, the wire type of the Rebilder Tag page-view beacon: `{ store, path, ref?, wd? }`. It is a separate type from `RebilderEventV0`, because a page view in a browser is a different observation from a request the gateway served.

## 0.2.1 (2026-08-11)

- Package metadata points at rebilder.com for help instead of a private repository. No code change.

## 0.2.0 (2026-08-10)

First release.

- `RebilderEventV0`: who asked (`requester`), what they asked for (`request`), how the gateway answered (`response`), and an optional later `outcome`.
- `response.source` names the source that answered, and `response.coverage` (`sourced`, `unsourced`, `not-applicable`) separates "an agent asked and no source had the page" from a person getting HTML.
- `validateEventV0` and `assertEventV0`: hand-written structural validation that accepts unknown extra keys.
- `createHttpEventSink`: batches (20 events or 2 seconds), a 1,000-event queue, one retry on network errors and 5xx, and it never throws. `createConsoleEventSink` writes one line per event.
- No runtime dependencies; runs on edge runtimes.
