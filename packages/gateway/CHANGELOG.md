# @rebilder/gateway changelog

Notable changes to `@rebilder/gateway`. Versions follow semantic versioning. Dates are the day each version reached npm.

## Unreleased

- The source code is public at https://github.com/rebilder/rebilder/tree/main/packages/gateway. `repository` and `bugs` point there, and issues and pull requests are welcome.

## 0.5.0 (2026-09-28)

- Discovery for agents that do not negotiate. All options are off by default, so existing responses are unchanged. Guide: [rebilder.com/docs/discovery](https://rebilder.com/docs/discovery).
  - `markdownUrls: true` serves each sourced page's markdown at its URL plus `.md` (`/index.md` for the root) to any GET or HEAD, with `Link: rel="canonical"` naming the page. A `.md` request whose page has no source passes through, so real `.md` files keep serving.
  - `frontmatter: true` starts markdown responses with YAML frontmatter (`title`, `description`, `canonical_url`, `last_updated`) copied from the source that answered. A document's description is its text fact labelled `Description`, else its `summary`, else a text fact labelled `Summary`. Values are written bare when YAML reads them back unchanged, so they match the same sentence elsewhere in the page. Missing or invalid fields are left out. The block shifts byte offsets in the body, which position-based scores such as ARS measure.
  - `notFound: { links, isMissing }` answers a markdown request for a missing page with a 404 (or your 410) and a short markdown body linking the files you list. The fetch middleware and edge handler use your own 404 and 410 responses; the Next.js proxy and Node middleware ask `isMissing`. People and crawlers are unaffected, and the event is the same Agent Miss as before.
  - `markdownAlternate(config, url)` and, in `/next`, `markdownAlternateTypes(config, url)` return the `<link rel="alternate" type="text/markdown">` for a page head when the `match` router confirms a source.
  - `generateSitemapMd(config, options)` and, in `/next`, `createSitemapMdRouteHandler(config, options)` build `/sitemap.md` from your sources and your own sections.
  - `markdownNotFoundResponse(options, url, status?)` builds the markdown 404 for a route of your own.
- **Requires Node.js 22 or later.** `engines.node` moves from `>=20.11.0` to `>=22`; Node.js 20 reached end of life in April 2026. Edge runtimes are unaffected. npm warns rather than refusing to install on an older Node.
- New `@rebilder/gateway/fetch` export for any framework whose middleware receives a `Request` and a `next()`: `createFetchMiddleware(config)` answers agents with markdown and adds `Vary: Accept` (and the markdown `Link` when your `match` router confirms a source) to everything else. `negotiationHeaders(config, url)` returns those headers for hosts that cannot wrap the response. Guides for SvelteKit, Nuxt, Astro, React Router, Remix, Hono, Bun, Deno, Netlify and Vercel are at [rebilder.com/docs/adapters/frameworks](https://rebilder.com/docs/adapters/frameworks).
- A `sources` object that throws when read no longer breaks the HTML response in any adapter; it is treated as a source that matched nothing.
- Subpath types (`/next`, `/node`, `/edge`, `/shopify`, `/fetch`) now resolve under TypeScript's older `node10` module resolution.
- Shorter README with a complete example for each framework family; the full reference moved to [rebilder.com/docs](https://rebilder.com/docs/quickstart). Better package description and keywords. This changelog now ships in the package.

## 0.4.0 (2026-09-13)

- Optional compatibility profiles for the markdown presentation, selected locally or through `createCompatibilityUpdater`, which verifies signed background updates with explicit endpoint and key setup, durable cache hooks, version bounds, replay protection, expiry and rollback to the local baseline. Request handling never fetches update configuration. No remote connection or candidate profile is enabled by default.
- Markdown responses expose the profile actually served in headers, and events carry it in additive fields. Baseline bodies are unchanged; a candidate that would exceed the size budget falls back to the baseline.
- `runCompatibilityEvaluation` for controlled evaluation of candidate profiles, with exact-quote scoring, repeated runs, held-out cases and a recomputed release gate.
- Depends on `@rebilder/events` 0.6.0 and `@rebilder/render-md` 0.3.0.

## 0.3.0 (2026-09-08)

- `inspectGatewayConfig(config)` and `inspectGatewayResponse(response)` check your wiring locally. They make no network request, call no resolver, send no event and include no source values in their reports. Every finding has a stable `code`, a severity and a next step.

## 0.2.0 (2026-08-26)

- `config.access`: allow, deny or rate-limit agents on your own site. Rules can name a verified platform, `unverified` or `*`; a platform rule is rejected unless Web Bot Auth verification is configured. Denied requests answer `403` (`429` with `Retry-After` for a limit) before any source runs, and still emit an event on the `denied` path. `compileAccessPolicy` is exported so an editor can show rejected rules before saving. Unset, behaviour is unchanged.
- Events now carry search intent: search query text (after scrubbing for personal data), campaign parameters and the AI platform named by the referrer, in `request.intent_signals`.
- Re-exports `acceptsMarkdownHeader`, the classifier's own `Accept` predicate.
- Depends on `@rebilder/agent-detect` 0.2.0, `@rebilder/events` 0.5.0 and `@rebilder/render-md` 0.2.0.

## 0.1.1 (2026-08-11)

- The HTML half of a negotiated URL now declares `Vary: Accept` too. `createGatewayProxy(config, fallthrough)` returns a `Response` for every request and decorates the pass-through; the Express middleware and the Workers handler do the same without any change to your code. `withNegotiationHeaders` is exported for the one-argument form.
- Pass-through responses advertise the markdown with `Link: rel="alternate"; type="text/markdown"` when your `match` router confirms the URL has a source.
- Package metadata points at rebilder.com for help instead of a private repository.

## 0.1.0 (2026-08-10)

First release.

- Content negotiation over web-standard `Request`/`Response`: agents that ask for `text/markdown`, or are identified AI agents, get markdown rendered from your sources; people and search crawlers get your HTML unchanged. Googlebot always gets HTML.
- Five source kinds (`product`, `policies`, `catalog`, `document`, `collection`), an optional `match` router, per-source byte budgets and a per-resolver timeout. A source that throws, hangs or returns the wrong shape falls through to your HTML.
- Adapters: Next.js (`/next`, with a dedicated markdown route and an llms.txt route), Express and Fastify (`/node`), Cloudflare Workers and other edge runtimes (`/edge`), and Shopify app proxies (`/shopify`).
- `generateLlmsTxt` for a deterministic llms.txt.
- An optional `protocols` hook for UCP, ACP and MCP handlers, with Web Bot Auth verification of protocol requests through `config.verification`.
- One `RebilderEventV0` per request through `onEvent`, fire-and-forget.
