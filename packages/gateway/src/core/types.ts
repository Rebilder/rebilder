/**
 * Public configuration types for @rebilder/gateway.
 *
 * The gateway is the front door of the Rebilder compiler (ARCHITECTURE.md
 * § The Compiler): it classifies every request and, for agent traffic, turns
 * the merchant's source of truth into clean markdown via @rebilder/render-md.
 * Merchants wire their catalog into it through `GatewaySources`; everything
 * substantive in a response is injected from those sources (source validation).
 */

import type { AgentKeyRegistry, DetectionResult } from '@rebilder/agent-detect'
import type { AccessPolicySource } from './access'
import type {
  CompatibilityProfile,
  CatalogItemSource,
  CollectionSource,
  DocumentSource,
  PolicySource,
  ProductSource,
} from '@rebilder/render-md'
import type { RebilderEventV0 } from '@rebilder/events'

/**
 * A merchant-provided lookup from request URL to source-of-truth data.
 * Return `null` (or `undefined`) when the URL doesn't match this source.
 * May be sync or async — but must not do slow I/O: the gateway sits on the
 * edge hot path (p95 < 50ms compute budget). Back it with your in-memory
 * catalog, a KV cache, or a fast local store.
 */
export type SourceResolver<T> = (url: URL) => T | null | undefined | Promise<T | null | undefined>

/**
 * Which of the five sources answered (or would answer) a URL. Also the key
 * space of `GatewayConfig.maxBytesBySource` and the return type of the
 * optional `GatewaySources.match` router.
 */
export type SourceKind = 'product' | 'policies' | 'catalog' | 'document' | 'collection'

/**
 * Merchant wiring to the source of truth. All sources are optional; a URL
 * that no configured source matches simply passes through to normal HTML.
 *
 * Resolution order on the markdown path is fixed: product → policies →
 * catalog → document → collection. The first source that returns data wins
 * (product wins if several would match). A source that throws, hangs past
 * `sourceTimeoutMs`, or returns a malformed value is treated as "no match" —
 * it never breaks the merchant's site — and resolution continues with the
 * next source. An empty policies/catalog array, and a collection with no
 * `items` array, are all treated as no match.
 *
 * The two universal sources are appended *below* the three commerce ones, so
 * precedence is unchanged for every config that existed before them: a
 * commerce merchant who adds site-wide documents keeps their PDPs rendering
 * as PDPs. Overlap is narrowed by narrowing the higher-precedence resolver —
 * the same rule as product-over-policies. There is no new knob for it.
 */
export interface GatewaySources {
  /** URL → product data for a PDP (rendered with renderProductMarkdown). */
  product?: SourceResolver<ProductSource>
  /** URL → policy documents (shipping, returns, …) rendered verbatim. */
  policies?: SourceResolver<PolicySource[]>
  /** URL → catalog/collection listing rendered as a markdown table. */
  catalog?: SourceResolver<CatalogItemSource[]>
  /**
   * URL → any page that is not a product, policy set, or catalog: a service,
   * a location, a plan, an article, a job posting (renderDocumentMarkdown).
   */
  document?: SourceResolver<DocumentSource>
  /** URL → a listing of documents, rendered as a link list or table. */
  collection?: SourceResolver<CollectionSource>
  /**
   * Optional router. When present, **at most one resolver is called per
   * request** — the one it names. Return `null` to fall through to the
   * ordered chain above (which is also what a throw, or an unrecognised
   * kind, is treated as).
   *
   * Pure and synchronous, because it runs on the edge hot path: it exists to
   * turn the worst case of five sequential awaits into one, so anything it
   * does must be cheaper than the awaits it saves. Match on `url.pathname`,
   * not on I/O.
   */
  match?: (url: URL) => SourceKind | null
}

/**
 * Web Bot Auth verification wiring (ROADMAP Phase 3 P0: agent verification
 * before accepting protocol transactions).
 */
export interface GatewayVerification {
  /**
   * The injected key registry (@rebilder/agent-detect `AgentKeyRegistry`),
   * keyed by Signature-Agent origin. Verification is PURE CRYPTO over these
   * keys — the gateway never fetches a key directory on the hot path; the
   * operator populates/refreshes the registry offline from the platforms'
   * published directories (KNOWN_AGENT_DIRECTORY ships empty on purpose —
   * see @rebilder/agent-detect's README § Verification).
   */
  keys: AgentKeyRegistry
  /**
   * Which serving paths verification runs on. v0 supports exactly
   * `'protocol'` (the default): verify before invoking the `protocols` hook.
   * Markdown/HTML paths never verify — format transformation needs no
   * cryptographic identity (consistent source content keeps substance identical anyway).
   */
  require?: 'protocol'
}

export interface GatewayConfig {
  /** Synchronous selection from local state. Refresh signed updates outside serving. */
  compatibilityProfile?: CompatibilityProfile | (() => CompatibilityProfile)

  /** Merchant store identifier; stamped on every emitted event. */
  storeId: string
  /** Wiring to the merchant's source of truth. */
  sources: GatewaySources
  /**
   * Event sink for the observation layer (@rebilder/events RebilderEventV0).
   * Fire-and-forget: the gateway never awaits it, sync throws and async
   * rejections are swallowed, and it can never block or break a response.
   */
  onEvent?: (event: RebilderEventV0) => void | Promise<void>
  /**
   * Markdown response size budget in UTF-8 bytes, passed through to
   * @rebilder/render-md. Default 5120 (render-md's default).
   */
  maxBytes?: number
  /**
   * Per-source override of `maxBytes`, in UTF-8 bytes. A source with no entry
   * falls back to `maxBytes`, and then to render-md's default.
   *
   * One global budget is the wrong shape once documents exist: a store may
   * hold products to a tight budget on purpose (8192 bytes, say, for policy
   * reasons) without forcing the same ceiling onto a long article.
   */
  maxBytesBySource?: Partial<Record<SourceKind, number>>
  /**
   * How long, in milliseconds, to wait for one source resolver before giving
   * up on it. Default 250. A timed-out resolver is a no-match: resolution
   * continues with the next source, and the request falls through to the
   * merchant's HTML if nothing else matches.
   *
   * Without this a resolver that hangs — one bad upstream, one un-timeout-ed
   * fetch someone put in a resolver despite the advice above — holds the
   * whole response open. The timeout is what makes "a failing source cannot
   * break your page" true for hangs and not only for throws. Set a
   * non-positive value to disable it (the resolver is then awaited forever,
   * which is the merchant's decision to make).
   */
  sourceTimeoutMs?: number
  /**
   * Optional protocol-endpoint handler, invoked when a request classifies
   * onto the `'protocol'` path (/.well-known/ucp, /mcp, /acp). Pass
   * `createProtocolHandler(...)` from `@rebilder/protocols` — the gateway
   * deliberately does NOT depend on that package (the public SDK's dependency
   * count never grows; protocol adapters version independently), so the
   * merchant constructs the handler and hands it in.
   *
   * Contract: return a `Response` to serve it (the gateway emits the request's
   * event with `response.path: 'protocol'` and measured `render_ms`), or
   * `null` for "not a protocol route I serve" — the request passes through
   * exactly as when this field is unset. A throw or rejection is contained to
   * a pass-through; a protocol bug never breaks the merchant's site.
   *
   * PSP note: checkout over these endpoints is a redirect handoff onto the
   * merchant's own PSP rails — neither this SDK nor @rebilder/protocols ever
   * holds, moves, or custodies funds.
   */
  protocols?: (req: Request) => Promise<Response | null>
  /**
   * Optional Web Bot Auth verification for the protocol path. When set and a
   * request classifies onto `'protocol'` with a wired `protocols` hook, the
   * gateway runs `verifyWebBotAuth` (pure crypto over `verification.keys` —
   * no network) BEFORE invoking the hook, then invokes it with a cloned
   * request carrying the verdict:
   *
   *   `x-rebilder-agent-verified: 'true' | 'false'`
   *   `x-rebilder-agent-verified-reason: <reason>` (unverified only)
   *
   * Client-sent values of these headers are always overwritten. The hook is
   * invoked either way — read endpoints stay open to unverified agents;
   * gating transactional endpoints on the verdict belongs to the protocol
   * handler (see @rebilder/protocols checkout `requireVerified`, default
   * true). The emitted event records the outcome (`requester.verified`).
   *
   * Unset (the default): behavior is byte-for-byte the pre-verification
   * gateway — no clone, no headers stamped, no stripping of client-sent
   * verdict headers, `requester.verified` stays false. A protocol handler
   * that gates on the verdict header must then not be trusted-exposed
   * without an edge stripping that header (README § Verification).
   */
  verification?: GatewayVerification
  /**
   * The merchant's own agent access policy — allow / deny / rate-limit, by
   * agent (ROADMAP Phase 3). Unset (the default): every agent is served, which
   * is the behaviour every gateway had before this field existed.
   *
   * NOT A QUOTA, AND NOT A TIER (self-hosted serving). This is the merchant's policy
   * about third-party agents visiting the merchant's own site, handed in
   * already decided. The gateway cannot tell whether the merchant is entitled
   * to author it and never asks — entitlement is evaluated where policy is
   * saved, exactly as self-hosted serving prescribes for managed hosting.
   *
   * Compiled ONCE per config object into an indexed structure; evaluation is a
   * Map lookup and an integer comparison, with no `await` in the path. Pass a
   * synchronous getter to swap the policy at runtime (a signed poll refreshing
   * a module variable, say) — the type is deliberately not a Promise, because
   * a Promise here would be an invitation to fetch per request.
   *
   * A rule naming a platform requires `verification` to be wired; without it
   * the compiler rejects that rule and reports why. Allow/deny keyed on an
   * unverified header is not a control.
   *
   * The rate limiter is PER PROCESS INSTANCE — see README § Access control.
   */
  access?: AccessPolicySource
  /**
   * Serve each page's markdown at its own URL plus `.md`: `GET /docs/setup.md`
   * returns what `/docs/setup` returns to `Accept: text/markdown`, with a
   * `Link: rel="canonical"` header naming the HTML page. `/index.md` is the
   * root page. Default `false`.
   *
   * The `.md` address is a URL of its own with one representation, like the
   * dedicated markdown route: everyone who asks for it gets the markdown,
   * browsers and crawlers included. That is not cloaking, which is different
   * substance at the SAME URL; the page URL itself still negotiates exactly as
   * before, and crawlers still always get its HTML.
   *
   * Only GET and HEAD, and only when a source answers the page. Every other
   * `.md` request passes through untouched, so a real `.md` file (a README, a
   * changelog) keeps serving. If you also publish a file at the `.md` address
   * of a page a source answers, the source wins; narrow that source or your
   * `match` router to hand the path back.
   */
  markdownUrls?: boolean
  /**
   * Start each markdown response with YAML frontmatter: `title`,
   * `description`, `canonical_url` and `last_updated`, copied from the source
   * that answered (render-md `renderFrontmatter`). A field the source does not
   * have is left out; nothing is generated. Default `false`, so responses stay
   * byte-for-byte what they were.
   *
   * The block is added after the byte budget and the compatibility profile,
   * is capped at 2 KB (the description goes first), and changes the markdown's
   * byte offsets. Anything that measures position in the body, including the
   * Agent Readability Score, can report different numbers with it on.
   */
  frontmatter?: boolean
  /**
   * Answer a markdown request for a page your site does not have with a short
   * markdown 404, instead of your HTML error page. Unset (the default): such a
   * request passes through, as it always has. Humans and crawlers always get
   * your own error page.
   */
  notFound?: GatewayNotFound
}

/**
 * The markdown 404. Where the gateway can see your site's own response (the
 * fetch middleware and the edge handler), a 404 or 410 you return to a
 * markdown request becomes this body with the same status. Where it cannot
 * (the Next.js proxy and the Node middleware run before your routes),
 * `isMissing` is how it knows.
 */
export interface GatewayNotFound {
  /**
   * Links for the body, such as your `/sitemap.md` and `/llms.txt`. A relative
   * URL resolves against the request's origin. List only files you serve.
   */
  links?: Array<{ title: string; url: string; note?: string }>
  /**
   * Return `true` for a URL your site does not serve. Called only for a
   * markdown request that no source answered. Pure and synchronous, like
   * `sources.match`: it runs on the hot path. A throw counts as `false`.
   */
  isMissing?: (url: URL) => boolean
}

/**
 * Which serving path a request classifies into (ARCHITECTURE.md § Request
 * classification):
 *
 * - `'markdown'` — agent traffic; serve a markdown format transformation of
 *    the canonical page from the merchant's source of truth.
 * - `'protocol'` — protocol route hit (/.well-known/ucp, /mcp, /acp). The
 *    endpoints themselves are served by the merchant's `protocols` hook when
 *    one is wired; without it the gateway passes through, but the decision
 *    (and the emitted event) records the demand.
 * - `'html'` — pass through untouched. Humans AND crawlers: Googlebot always
 *    gets the canonical HTML page (consistent source content, the cloaking guardrail).
 */
export type GatewayPath = 'markdown' | 'protocol' | 'html'

export interface GatewayDecision {
  path: GatewayPath
  /** The full @rebilder/agent-detect result the decision was derived from. */
  detection: DetectionResult
}
