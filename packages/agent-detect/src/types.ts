/** Coarse classification of who (or what) issued the request. */
export type RequesterKind = 'agent' | 'human' | 'crawler' | 'protocol'

/**
 * Known agent/crawler platforms. Grows as new agents are observed (add a
 * fixture too).
 *
 * **There is deliberately no `copilot` member.** Microsoft Copilot has no
 * distinct user agent: it is answered from Bing's index and its fetches arrive
 * as `bingbot`, which is why Microsoft's own guidance for reaching Copilot is
 * "allow bingbot". A `copilot` platform keyed on a UA token would be a rule
 * that never fires and a fixture that was never observed — and the fixture
 * corpus is only worth anything because every sample in it is real. Copilot
 * DOES exist as a referrer platform in `@rebilder/events`
 * (`copilot.microsoft.com`), because an AI-referred human genuinely does
 * arrive from it. Agent fetch attributed to `bingbot`, human arrival
 * attributed to `copilot`, and neither one invented.
 */
export type AgentPlatform =
  | 'claude-code'
  | 'opencode'
  | 'claude'
  | 'chatgpt'
  | 'gemini'
  | 'perplexity'
  | 'googlebot'
  | 'bingbot'
  /** Microsoft's product-preview fetcher (`MicrosoftPreview/2.0`) — not Bing. */
  | 'microsoft-preview'
  /** Apple's search crawler (`Applebot`). A crawler: always served canonical HTML. */
  | 'applebot'
  /** Meta's AI crawler and user-initiated fetcher (`meta-externalagent`, `meta-externalfetcher`). */
  | 'meta'
  /** Amazon's crawler (`Amazonbot`). */
  | 'amazon'
  /** DuckDuckGo's DuckAssist fetcher (`DuckAssistBot`). */
  | 'duckduckgo'
  /** Mistral's user-initiated fetcher (`MistralAI-User`). */
  | 'mistral'
  | 'unknown'

export interface DetectInput {
  /**
   * Request headers. Lookup is case-insensitive; multi-value headers may be
   * passed as arrays (they are treated as a comma-joined list, per RFC 9110).
   */
  headers: Record<string, string | string[] | undefined>
  /** Full URL or pathname; the pathname is used for protocol-route hits. */
  url?: string
  /** HTTP method. Accepted for contract stability; not yet used for classification. */
  method?: string
}

export interface DetectionResult {
  kind: RequesterKind
  platform: AgentPlatform | null
  /**
   * True only when a Web Bot Auth signature chain was cryptographically
   * verified. detect() itself NEVER verifies (it is synchronous, parse-only)
   * and always reports false here; verification is the separate async
   * verifyWebBotAuth() step (src/verify.ts) that the paths needing
   * cryptographic identity — preference payloads, protocol transactions —
   * run explicitly with an injected key registry.
   */
  verified: boolean
  /** The Accept header explicitly includes text/markdown (with q > 0). */
  acceptsMarkdown: boolean
  /**
   * Ordered list of checks that fired, in detection order, e.g.
   * ['accept:text/markdown', 'ua:claude-code'].
   */
  signals: string[]
  confidence: 'high' | 'medium' | 'low'
}
