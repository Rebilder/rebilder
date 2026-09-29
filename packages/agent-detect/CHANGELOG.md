# @rebilder/agent-detect changelog

Notable changes to `@rebilder/agent-detect`. Dates are the day each version reached npm.

## Unreleased

- The source code is public at https://github.com/rebilder/rebilder/tree/main/packages/agent-detect. `repository` and `bugs` point there, and issues and pull requests are welcome.

## 0.3.0 (2026-09-28)

- **Requires Node.js 22 or later.** `engines.node` moves from `>=20.11.0` to `>=22`; Node.js 20 reached end of life in April 2026. Edge runtimes are unaffected.
- Detects more AI agents and crawlers, each pattern taken from the vendor's own documentation:
  - `Applebot` is a crawler (platform `applebot`), so the gateway serves it your HTML like Googlebot. `Applebot-Extended` is a robots.txt token that never crawls, so it has no pattern.
  - `meta-externalagent` and `meta-externalfetcher` are agents (platform `meta`).
  - `Amazonbot` is an agent (platform `amazon`).
  - `DuckAssistBot` is an agent (platform `duckduckgo`).
  - `MistralAI-User` is an agent (platform `mistral`).
- `AgentPlatform` gains `applebot`, `meta`, `amazon`, `duckduckgo` and `mistral`. An exhaustive `switch` over `AgentPlatform` needs the new cases. Identified agents on these platforms now take the gateway's markdown path when a source answers, the same as GPTBot or ClaudeBot.
- README lists every recognized User-Agent. Better package description and keywords. This changelog now ships in the package.

## 0.2.0 (2026-08-26)

- Detects Microsoft's `adidxbot` (Bing Ads landing-page checks) as `bingbot` and `MicrosoftPreview` (link previews in Microsoft products) as the new `microsoft-preview` platform, both as crawlers.
- Exports `acceptsMarkdownHeader`, the `Accept` predicate `detect()` itself uses. A wildcard is not a request for markdown.

## 0.1.1 (2026-08-11)

- Package metadata points at rebilder.com for help instead of a private repository. No code change.

## 0.1.0 (2026-08-10)

First release.

- `detect()`: synchronous classification into agent, person, crawler or protocol client from `Accept: text/markdown`, Web Bot Auth headers, protocol routes and User-Agent, with the signals that fired and a confidence. Known search crawlers always classify as crawlers.
- `verifyWebBotAuth()`: RFC 9421 Ed25519 signature verification against a key registry you supply. No network calls; hostile input returns a reason and never throws.
