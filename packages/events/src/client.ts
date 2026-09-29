/**
 * ClientEventV0 — the Rebilder Tag's wire contract (additive module, 0.5.0).
 *
 * A DIFFERENT OBSERVATION from `RebilderEventV0`, deliberately in a different
 * type: `RebilderEventV0` describes an HTTP request the gateway served, and
 * its schema is frozen; this describes a browser pageview reported by the
 * merchant's own page. Joins between the two happen at read time, labelled
 * as inference — never by pretending one is the other.
 *
 * THE WIRE. The tag (`tag.js`, served from rebilder.com — hand-written,
 * dependency-free, <2KB) sends this object as text/plain JSON via
 * `navigator.sendBeacon` to the hardcoded endpoint
 * `POST https://api.rebilder.com/v1/client-events`, at most once per initial
 * pageview. It sends nothing at all under `doNotTrack === '1'` or
 * `globalPrivacyControl`, on rebilder.com or its subdomains, or in a browser
 * without `sendBeacon`. The endpoint answers 204 in every outcome — a beacon
 * has no reader, so there is nothing to succeed or fail toward.
 *
 * SERVER-ADDED FIELDS — never on the wire; derived and stored by the
 * endpoint (`rebilder.client_events`, 0034):
 *   - `occurred_at`        — server clock; the beacon carries no timestamp.
 *   - `referrer_host`      — hostname of `ref`, cross-origin only
 *                            (same-origin referrers are dropped, twice: by
 *                            the tag and again by the endpoint).
 *   - `referrer_platform`  — `classifyReferrerPlatform(ref)`, the SAME
 *                            classifier the gateway events path uses, so
 *                            "AI-referred" means one thing everywhere.
 *   - `webdriver`          — `wd` verbatim; NULL when absent.
 *
 * WHAT NEVER EXISTS anywhere in this pipeline (each absence is a contract
 * the 0034 header states and tests pin): no querystring (`path` is
 * `location.pathname`, stripped again server-side, CHECK-refused by the
 * database), no raw IP and no IP hash on the event, no raw User-Agent, no
 * cookie, no visitor/session id, no fingerprint. Rows are pageviews, not
 * people — a "visitors" figure derived from them is an estimate and every
 * surface must label it as one.
 *
 * The tag cannot see fetch-based agent traffic — an agent that never runs
 * JS never sends a beacon. That remains the gateway's territory
 * (`RebilderEventV0`), and every surface reading both keeps the two counts
 * separate.
 */

/** The beacon payload, exactly as the tag serializes it. */
export interface ClientEventV0 {
  /** Console store id (uuid) — the tag's `data-rebilder-store` attribute. */
  store: string
  /** `location.pathname` only — never the search string, never the hash. */
  path: string
  /**
   * `document.referrer`, present only when its host differs from the
   * page's own host. Omitted otherwise — never sent empty.
   */
  ref?: string
  /** `navigator.webdriver === true` — an automated browser admitting it. */
  wd?: boolean
}
