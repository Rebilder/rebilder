# @rebilder/gateway

Serve a clean markdown version of your pages to AI agents that ask for one. Browsers, search crawlers and everyone else keep getting your HTML at the same URL.

You connect your own product, service and policy data; the gateway renders it as fact-first markdown and never invents a value. It is free to self-host under Apache-2.0, with no Rebilder account.

## Install

```sh
npm install @rebilder/gateway
```

It runs on Node.js 22 or later and on any runtime with web-standard `Request` and `Response`, including Cloudflare Workers, Deno and Bun.

## Configure

Point a source at data you already have. This config serves one page:

```ts
// gateway-config.ts
import type { DocumentSource, GatewayConfig } from '@rebilder/gateway'

// Your source of truth. Here it is a Map; in your app it is your CMS, database or catalog.
const pages = new Map<string, DocumentSource>([
  [
    '/services/bike-fitting',
    {
      url: 'https://example.com/services/bike-fitting',
      title: 'Bike fitting',
      summary: 'A 90-minute fit on your own bike, with a written report.',
      facts: [
        { label: 'Price', value: { type: 'money', value: { amount: 18000, currency: 'GBP' } } },
        { label: 'Booking required', value: { type: 'boolean', value: true } },
      ],
    },
  ],
])

export const gatewayConfig: GatewayConfig = {
  storeId: 'my-site',
  sources: {
    // Return the page's facts, or null to serve your normal HTML.
    document: (url) => pages.get(url.pathname) ?? null,
  },
}
```

There are five source kinds: `product`, `policies` and `catalog` for stores, and `document` and `collection` for every other page. Wire the ones you have. See [Sources](https://rebilder.com/docs/sources).

## Mount it

Next.js ([guide](https://rebilder.com/docs/adapters/nextjs)):

```ts
// proxy.ts on Next 16, middleware.ts on Next 15 and earlier
import { NextResponse } from 'next/server'
import { createGatewayProxy } from '@rebilder/gateway/next'
import { gatewayConfig } from './gateway-config'

export default createGatewayProxy(gatewayConfig, () => NextResponse.next())
```

Express ([guide, with Fastify](https://rebilder.com/docs/adapters/node)):

```ts
import express from 'express'
import { createGatewayMiddleware } from '@rebilder/gateway/node'
import { gatewayConfig } from './gateway-config'   // same GatewayConfig as every adapter

const app = express()
app.use(createGatewayMiddleware(gatewayConfig))    // before your routes
// ... your existing routes serve HTML exactly as before
```

Cloudflare Workers ([guide](https://rebilder.com/docs/adapters/cloudflare)):

```ts
// worker.ts: deploy on a route in front of your site, e.g. example.com/*
import { createGatewayFetchHandler } from '@rebilder/gateway/edge'
import { gatewayConfig } from './gateway-config'

export default { fetch: createGatewayFetchHandler(gatewayConfig) }
```

SvelteKit, Astro, Nuxt, React Router, Remix, Hono and other fetch-based frameworks ([guide](https://rebilder.com/docs/adapters/frameworks)):

```ts
// src/hooks.server.ts in SvelteKit. Astro, React Router, Hono and Netlify mount it the same way.
import type { Handle } from '@sveltejs/kit'
import { createFetchMiddleware } from '@rebilder/gateway/fetch'
import { gatewayConfig } from './gateway-config'

const gateway = createFetchMiddleware(gatewayConfig)

export const handle: Handle = ({ event, resolve }) => gateway(event.request, () => resolve(event))
```

Bun, Deno, Netlify Edge Functions and Vercel have [runtime recipes](https://rebilder.com/docs/adapters/runtimes). Shopify stores use the [app proxy adapter](https://rebilder.com/docs/adapters/shopify).

## Check it

```sh
curl -H "Accept: text/markdown" https://your-site.example/services/bike-fitting
curl -I https://your-site.example/services/bike-fitting
```

The first returns markdown with your facts at the top. The second returns your HTML with `Vary: Accept`, so shared caches keep the two apart. Then run `npx rebilder check <url>` to score the page.

## How it behaves

- An agent gets markdown when it sends `Accept: text/markdown` or is a recognized AI agent, and a source answers the URL.
- Googlebot and other search crawlers always get your HTML, even when they ask for markdown.
- A source that throws, times out or returns `null` falls through to your HTML. The gateway never takes a page down.
- For agents that do not ask for markdown, turn on `markdownUrls` (each page at its URL plus `.md`), `frontmatter` (title, description, canonical URL and date) and `notFound` (a markdown 404). `markdownAlternate` gives your page head its markdown link, and `generateSitemapMd` builds `/sitemap.md`. All are off by default. See [Help agents find your markdown](https://rebilder.com/docs/discovery).
- The only runtime dependencies are `@rebilder/agent-detect`, `@rebilder/render-md` and `@rebilder/events`.

## Learn more

The full documentation covers the [quickstart](https://rebilder.com/docs/quickstart), [events and reporting](https://rebilder.com/docs/events), [access control](https://rebilder.com/docs/access-control), [llms.txt](https://rebilder.com/docs/llms-txt), the [API reference](https://rebilder.com/docs/reference) and [troubleshooting](https://rebilder.com/docs/troubleshooting).

Protocol endpoints for UCP, ACP and MCP plug in through `config.protocols` ([docs](https://rebilder.com/docs/protocols)). Their adapter package, `@rebilder/protocols`, is not yet published to npm.

Release notes are in `CHANGELOG.md` in this package. Licensed under Apache-2.0. Source, issues and pull requests: [GitHub](https://github.com/rebilder/rebilder/tree/main/packages/gateway).
