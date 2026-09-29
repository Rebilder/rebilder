# rebilder changelog

Notable changes to the `rebilder` command-line tool. Exit codes are a stable contract and are never renumbered. Dates are the day each version reached npm.

## Unreleased

- The source code is public at https://github.com/rebilder/rebilder/tree/main/packages/cli. `repository` and `bugs` point there, and issues and pull requests are welcome.

## 0.3.0 (2026-09-28)

- **Requires Node.js 22 or later.** `engines.node` moves from `>=20.11.0` to `>=22`; Node.js 20 reached end of life in April 2026.
- `rebilder init` detects SvelteKit, Nuxt, Astro, React Router, Remix, Hono, Bun, Deno, Netlify and Vercel as well as Next.js, Express, Fastify, Cloudflare Workers and Shopify. It checks the framework before the runtime it deploys to, and with no marker it scaffolds the framework-neutral fetch middleware instead of Express. Each scaffold links its guide on rebilder.com.
- The Next.js scaffold passes the fallthrough to `createGatewayProxy`, so your HTML responses carry `Vary: Accept`.
- The library entry ships as ESM only. The CommonJS files were unreachable through `exports`; Node.js 22.12 and later can `require()` the ESM entry. Unpacked size drops from about 750 KB to 510 KB.
- README: absolute links and no internal references. Better package description and keywords. This changelog now ships in the package.
- README: names the standard in full, the Rebilder Agent Readability Spec (ARS).

## 0.2.1 (2026-09-08)

- Terminal and Markdown reports open with **Your next steps**, written for a business owner, before the technical detail.
- `--help` and the README start from checking one important page and end with rechecking it.

## 0.2.0 (2026-08-26)

- Scores against ARS 0.2 through `@rebilder/agent-readability` 0.2.0. Scores are not comparable with ARS 0.1.
- Removes the conflict-of-interest notice from reports.

## 0.1.1 (2026-08-11)

- Package metadata points at rebilder.com for help instead of a private repository.

## 0.1.0 (2026-08-10)

First release: `rebilder check` (pretty, JSON, Markdown and JUnit output, `--fail-on` thresholds), `rebilder diff`, `rebilder init` and `rebilder badge`, with zero telemetry.
