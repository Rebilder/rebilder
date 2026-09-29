# Rebilder gateway on Cloudflare Workers

Put `@rebilder/gateway` in front of a site you already have. AI agents that ask
for `text/markdown` get clean, fact-first markdown rendered from data you
declare; browsers, Googlebot and everything else reach your origin untouched.

No origin changes. No plugin. No rebuild of your site.

```
                     ┌──────────────────────────────────────┐
  Agent ────────────►│  Worker                              │
  Accept:            │   agent + a page you described       │──► markdown
  text/markdown      │                                      │    (no origin hit)
                     │   everything else                    │──► your origin
  Browser ──────────►│                                      │    (unchanged)
  Googlebot          └──────────────────────────────────────┘
```

---

## Deploy it

**Prerequisites:** a Cloudflare account, and your domain on Cloudflare (any
plan, including Free). Workers routes need the zone to be on Cloudflare — if
your DNS is elsewhere, this template can still run on a `workers.dev` URL, but
it will not be in front of your site.

### 1. Get the project

Copy this directory anywhere and `npm install`. There is nothing
monorepo-specific in it — it depends on the published `@rebilder/gateway`, and
`test/template.test.ts` exists to keep it that way.

If you are starting from nothing, the four files that matter are `package.json`,
`wrangler.jsonc`, `src/index.ts` and `src/gateway-config.ts`; `src/content.ts`
is yours to write. From a bare Worker:

```
npm create cloudflare@latest my-rebilder-gateway -- --type=hello-world --ts
cd my-rebilder-gateway
npm install @rebilder/gateway
```

then copy the four files across.

### 2. Describe your pages

Open `src/content.ts`. It ships with a fictional bike workshop so that step 3
shows you something real. Replace it with your own pages: a title, a canonical
URL, and the facts that matter — prices, hours, whether booking is required,
what is included.

Facts are typed (`money`, `hours`, `boolean`, `list`, `date`, `url`, `number`,
`text`) and they render first, so an agent reading top-down has your whole
machine-readable payload before any prose.

Start with five pages. The ones worth doing first are the ones where a wrong
answer costs you: prices, opening hours, service inclusions, eligibility.

### 3. See it work, locally

```
npm run dev
```

Then, in another terminal:

```
curl -H 'Accept: text/markdown' http://localhost:8787/services/bike-fitting
```

You should get markdown. Ask for HTML instead and the request goes to your
origin — which, locally, means whatever `ORIGIN` points at.

### 4. Point it at your domain

Edit `wrangler.jsonc` and uncomment `routes`:

```jsonc
"routes": [
  { "pattern": "example.com/*", "zone_name": "example.com" },
  { "pattern": "www.example.com/*", "zone_name": "example.com" }
],
```

This is the only edit the template requires.

### 5. Ship

```
npx wrangler login
npm run deploy
```

Verify against the live site:

```
curl -sI https://example.com/services/bike-fitting \
  -H 'Accept: text/markdown' | grep -i 'content-type\|x-rebilder-path'
```

`content-type: text/markdown` and `x-rebilder-path: markdown` mean you are
live. Watch traffic with `npm run tail`.

---

## Rolling back

`npx wrangler delete` removes the Worker and every route with it; your site
serves exactly as it did before, immediately. There is no residue — the gateway
never modified your origin.

To disable it without deleting, comment out `routes` and redeploy.

---

## What this costs you

| | |
|---|---|
| Requests to your origin | **Unchanged.** The gateway adds no origin requests. Markdown responses are served from the edge and never reach your origin at all, so wiring it up moves some traffic off your servers rather than onto them. |
| Latency for humans | One edge hop that was already happening if you are on Cloudflare. Classification is a handful of header string scans — pure compute, no I/O. |
| Latency for agents | Lower. A described page is rendered at the edge from data in the Worker bundle. |
| Cloudflare cost | Workers Free covers 100,000 requests/day. |

The gateway's own budget is p95 < 50ms compute with **no network calls on the
hot path**. This template holds to it by keeping content in the bundle — a
`Map.get`, not a lookup over the network. If you outgrow that, the next step is
Workers KV with a bundled fallback, not an origin fetch per request.

---

## Serving behavior

The template renders the business facts declared in `src/content.ts`. Keep equivalent representations of the same offer consistent and source private or personalized offers through their own authorized flow.

Known search crawlers pass through to canonical HTML. Unmatched routes and handled resolver failures fall back to the origin. Test the deployed request path and your rollback before relying on the connection.

---

## Where to go next

- **Check your score first.** [rebilder.com/scan](https://rebilder.com/scan)
  measures how a page reads to an agent today, before you change anything.
- **The gateway's full API** —
  [`@rebilder/gateway`](https://www.npmjs.com/package/@rebilder/gateway), or
  [rebilder.com/docs/reference](https://rebilder.com/docs/reference). Products,
  policies and catalogs are wired the same way as documents.
- **Not on Cloudflare?** The same config runs on Next.js, Express, Fastify,
  Shopify, SvelteKit, Astro, Hono, Bun, Deno, Netlify and Vercel. See
  [the framework guides](https://rebilder.com/docs/adapters/frameworks).
- **Crawler and publication policy** —
  [rebilder.com/bots](https://rebilder.com/bots).

---

## Development

```
npm test          # the template's own tests, including a run in workerd
npm run typecheck
```

`npm test` also starts the Worker in workerd, Cloudflare's runtime, through
wrangler, and checks that agents get markdown and browsers reach your origin.

Inside the Rebilder repository this directory is a workspace member, so the
root `pnpm lint`, `pnpm typecheck` and `pnpm test` cover it. It depends on the **published**
`@rebilder/gateway`, so these tests assert that the template works against the
artifact a merchant actually installs; the workerd test also runs it against
the workspace gateway source.
