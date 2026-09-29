# @rebilder/agent-detect

Tell AI agents, search crawlers and people apart from a request's headers, and verify Web Bot Auth signatures when you need proof of identity. It has no dependencies, makes no network calls and runs at the edge.

`@rebilder/gateway` uses it to decide who gets markdown. Use it directly to classify requests in your own server or analytics.

## Install

```sh
npm install @rebilder/agent-detect
```

## Classify a request

```ts
import { detect } from '@rebilder/agent-detect'

const result = detect({
  headers: req.headers,          // case-insensitive lookup; string[] values OK
  url: req.url,                  // pathname used for protocol-route hits
  method: req.method,            // accepted for contract stability; unused today
})
// {
//   kind: 'agent' | 'human' | 'crawler' | 'protocol',
//   platform: 'chatgpt' | 'claude' | 'gemini' | 'perplexity' | 'googlebot' | … | null,
//   verified: false,            // detect() never verifies; see verifyWebBotAuth()
//   acceptsMarkdown: boolean,   // Accept explicitly lists text/markdown with q > 0
//   signals: string[],          // the checks that fired, e.g. ['accept:text/markdown', 'ua:claude-code']
//   confidence: 'high' | 'medium' | 'low',
// }
```

`detect()` is synchronous string scanning. Checks run cheapest first, and the highest-precedence one decides:

1. **`Accept: text/markdown`**, listed explicitly with `q > 0`: an agent, high confidence. Claude Code and OpenCode send it.
2. **Web Bot Auth headers**: `Signature-Agent` (for example `"https://chatgpt.com"`) names the platform, high confidence. A bare `Signature` and `Signature-Input` pair is an unidentified agent, medium confidence.
3. **Protocol routes**: `/.well-known/ucp`, `/.well-known/acp`, `/mcp` and `/acp/*` are protocol clients.
4. **User-Agent**, as a fallback capped at medium confidence.
5. **Default**: a person.

**Crawlers always classify as crawlers.** A search crawler gets `kind: 'crawler'` even when it sends `Accept: text/markdown`, so the gateway serves it your canonical HTML.

### Known User-Agents

| Kind | Tokens | Platform |
|---|---|---|
| Agent | `claude-code`, `opencode` | `claude-code`, `opencode` |
| Agent | `ChatGPT-User`, `OAI-SearchBot`, `GPTBot` | `chatgpt` |
| Agent | `PerplexityBot`, `Perplexity-User` | `perplexity` |
| Agent | `Gemini`, `Google-Extended` | `gemini` |
| Agent | `ClaudeBot`, `Claude-User`, `claude-web`, `anthropic-ai` | `claude` |
| Agent | `meta-externalagent`, `meta-externalfetcher` | `meta` |
| Agent | `Amazonbot` | `amazon` |
| Agent | `DuckAssistBot` | `duckduckgo` |
| Agent | `MistralAI-User` | `mistral` |
| Crawler | `Googlebot` | `googlebot` |
| Crawler | `bingbot`, `adidxbot` | `bingbot` |
| Crawler | `MicrosoftPreview` | `microsoft-preview` |
| Crawler | `Applebot` | `applebot` |

Copilot has no User-Agent of its own; it answers from Bing's index, so it arrives as `bingbot`. `Applebot-Extended` is a robots.txt token that never crawls, so it has no pattern.

A User-Agent is a claim, not proof. Use it to choose a format for the same content. Anything that depends on who the caller really is needs a verified signature.

## Check the Accept header

```ts
import { acceptsMarkdownHeader } from '@rebilder/agent-detect'

acceptsMarkdownHeader('text/markdown')          // true
acceptsMarkdownHeader('text/html,text/markdown') // true
acceptsMarkdownHeader('text/markdown;q=0')      // false: a refusal
acceptsMarkdownHeader('*/*')                    // false: see below
acceptsMarkdownHeader(null)                     // false
```

This is the predicate `detect()` uses. A wildcard is not a request for markdown: only an explicit `text/markdown` range counts. Use it wherever you report on negotiation, so the report and the serving decision agree.

## Verify Web Bot Auth

```ts
import { verifyWebBotAuth, type AgentKeyRegistry } from '@rebilder/agent-detect'

const result = await verifyWebBotAuth(
  { headers: req.headers, url: req.url, method: req.method },
  { keys: registry }, // your trusted keys; no network, ever
)
// { verified: true, platform: 'chatgpt', keyid: '…' }
// { verified: false, reason: 'no-signature' | 'unknown-agent' | 'unknown-key' | 'expired'
//                          | 'created-in-future' | 'bad-signature' | 'malformed' | 'unsupported-alg' }
```

It checks RFC 9421 Ed25519 message signatures as profiled by Web Bot Auth: the signature must cover `@authority` and `signature-agent`, the agent and key must be in your registry, `created` and `expires` must fall within 300 seconds of now, and the signature must verify. It never throws; bad input returns `{ verified: false, reason }`.

`KNOWN_AGENT_DIRECTORY` starts empty. Add each platform's published signing keys to your `AgentKeyRegistry`, and refresh them outside the request path when they rotate:

```ts
type AgentKeyRegistry = {
  [origin: string]: {           // Signature-Agent origin, e.g. 'https://chatgpt.com'
    platform: AgentPlatform
    keys: { keyid: string; alg: 'ed25519'; publicKeyJwk: { kty: 'OKP'; crv: 'Ed25519'; x: string } }[]
  }
}
```

Full docs: [rebilder.com/docs/classification](https://rebilder.com/docs/classification). Release notes are in `CHANGELOG.md` in this package. Licensed under Apache-2.0. Source, issues and pull requests: [GitHub](https://github.com/rebilder/rebilder/tree/main/packages/agent-detect).
