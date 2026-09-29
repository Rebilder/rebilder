# Rebilder

Open-source packages that help AI agents read your website. Serve agents clean
markdown rendered from your own data while people and search crawlers keep your
HTML. Check how well any page reads to an agent with the Agent Readability
Score.

Everything here is Apache-2.0 and runs on your own infrastructure. You do not
need a Rebilder account.

## Packages

| Package | What it does | |
| --- | --- | --- |
| [`@rebilder/agent-detect`](packages/agent-detect) | Tell AI agents, search crawlers and people apart from request headers, and verify Web Bot Auth signatures. No dependencies; runs at the edge. | [npm](https://www.npmjs.com/package/@rebilder/agent-detect) |
| [`@rebilder/agent-readability`](packages/agent-readability) | Score how well AI agents can read a web page. The reference implementation of the Rebilder Agent Readability Spec (ARS): deterministic, no dependencies, with a safe fetcher for live pages. | [npm](https://www.npmjs.com/package/@rebilder/agent-readability) |
| [`rebilder`](packages/cli) | Check what AI agents can read on any web page: a readability score, the missing facts and a ranked fix list. Runs locally with no telemetry. | [npm](https://www.npmjs.com/package/rebilder) |
| [`@rebilder/events`](packages/events) | Typed request events and a batching HTTP sink for @rebilder/gateway: record which AI agents read your site and what they asked for. | [npm](https://www.npmjs.com/package/@rebilder/events) |
| [`@rebilder/gateway`](packages/gateway) | Serve clean markdown of your pages to AI agents that ask for it, while browsers keep your HTML. Middleware for Next.js, Express, Fastify, Cloudflare Workers, Shopify and any fetch-based framework. | [npm](https://www.npmjs.com/package/@rebilder/gateway) |
| [`@rebilder/mcp-server`](packages/mcp-server) | MCP server that lets your AI assistant check how well AI agents can read a web page. Runs locally over stdio with no telemetry. | [npm](https://www.npmjs.com/package/@rebilder/mcp-server) |
| [`@rebilder/profiles`](packages/profiles) | Open JSON lists of the facts each kind of web page should give AI agents: products, places, services, articles and more. | [npm](https://www.npmjs.com/package/@rebilder/profiles) |
| [`@rebilder/render-md`](packages/render-md) | Render product, policy and page data as clean markdown and schema.org JSON-LD for AI agents. Deterministic output, no dependencies. | [npm](https://www.npmjs.com/package/@rebilder/render-md) |

## Get started

Check a page from your terminal:

```sh
npx rebilder check https://example.com
```

Let your AI assistant run the same check:

```sh
claude mcp add rebilder -- npx -y @rebilder/mcp-server
```

Serve markdown to agents from your site:

```sh
npm install @rebilder/gateway
```

Then follow the [quickstart](https://rebilder.com/docs/quickstart). The
[framework](https://rebilder.com/docs/adapters/frameworks) and
[runtime](https://rebilder.com/docs/adapters/runtimes) guides cover SvelteKit,
Nuxt, Astro, Hono, Bun, Deno, Netlify and Vercel.
[`examples/cloudflare-worker`](examples/cloudflare-worker) is a Worker you can
deploy in front of an existing site.

## Documentation

- [Documentation](https://rebilder.com/docs)
- [The Rebilder Agent Readability Spec (ARS)](https://rebilder.com/spec/ars). The conformance
  corpus in [`packages/agent-readability/conformance`](packages/agent-readability/conformance)
  is its normative test.
- [Crawler policy and opt-out](https://rebilder.com/bots)

## Develop

You need Node.js 22 or later and pnpm 9.

```sh
pnpm install
pnpm build
pnpm test
```

`pnpm lint` and `pnpm typecheck` run the other checks CI runs. Each package has
its own `CONTRIBUTING.md` with the contracts its tests guard.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md)
explains how this repository is synced and how accepted changes land.

Report security issues privately. See [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). Copyright 2026 Rebilder LLC. The license does not grant
use of the Rebilder or ARS names.
