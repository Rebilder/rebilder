import type { AgentPlatform, DetectInput, DetectionResult } from './types'

// ---------------------------------------------------------------------------
// Header utilities
// ---------------------------------------------------------------------------

/** Case-insensitive header lookup. Array values are comma-joined (RFC 9110). */
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target || value === undefined) continue
    return Array.isArray(value) ? value.join(', ') : value
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Accept parsing (media ranges with q-values)
// ---------------------------------------------------------------------------

interface MediaRange {
  type: string
  q: number
}

function parseAccept(accept: string): MediaRange[] {
  const ranges: MediaRange[] = []
  for (const part of accept.split(',')) {
    const segments = part.trim().split(';')
    const type = (segments[0] ?? '').trim().toLowerCase()
    if (type.length === 0) continue
    let q = 1
    for (const segment of segments.slice(1)) {
      const eq = segment.indexOf('=')
      if (eq === -1) continue
      const key = segment.slice(0, eq).trim().toLowerCase()
      const value = segment.slice(eq + 1).trim()
      if (key === 'q') {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) q = parsed
      }
    }
    ranges.push({ type, q })
  }
  return ranges
}

/** Explicit (non-wildcard) media type present with q > 0. */
function acceptsMediaType(ranges: MediaRange[], mediaType: string): boolean {
  return ranges.some((range) => range.type === mediaType && range.q > 0)
}

/**
 * Does this raw `Accept` header EXPLICITLY ask for `text/markdown`?
 *
 * Exported because the answer is a fact about the serving decision, and a
 * second implementation of it would be free to disagree with the first. The
 * Console's Accept panel reports how many agent requests asked for markdown;
 * if that number were computed by a SQL `LIKE` it would quietly drift from
 * what `detect()` actually did, and the panel would be describing a gateway
 * that does not exist.
 *
 * A WILDCARD RANGE DOES NOT COUNT, and that is the whole point of the panel.
 * Under ordinary HTTP content negotiation a wildcard accepts everything, but
 * this standard reads only an EXPLICIT range: an agent sending the catch-all
 * range has expressed no preference, and counting it as "asked for markdown"
 * would turn the honest headline ("almost nobody asks; we serve it anyway")
 * into a meaningless one where almost everybody asks.
 *
 * `text/markdown;q=0` is a refusal and returns false, same as `detect()`.
 */
export function acceptsMarkdownHeader(accept: string | null | undefined): boolean {
  if (accept === null || accept === undefined || accept.trim().length === 0) return false
  return acceptsMediaType(parseAccept(accept), 'text/markdown')
}

// ---------------------------------------------------------------------------
// Web Bot Auth (Signature-Agent / Signature / Signature-Input)
// ---------------------------------------------------------------------------

/**
 * Extract the host from a Signature-Agent structured-field value, e.g.
 * `"https://chatgpt.com"` -> `chatgpt.com`. No verification — parse only.
 */
function parseSignatureAgentHost(value: string): string | null {
  const first = value.split(',')[0] ?? ''
  const unquoted = first.trim().replace(/^"/, '').replace(/"$/, '').trim()
  if (unquoted.length === 0) return null
  try {
    return new URL(unquoted).hostname.toLowerCase()
  } catch {
    return unquoted.toLowerCase()
  }
}

const SIGNATURE_AGENT_PLATFORMS: ReadonlyArray<readonly [string, AgentPlatform]> = [
  ['chatgpt.com', 'chatgpt'],
  ['openai.com', 'chatgpt'],
  ['claude.ai', 'claude'],
  ['anthropic.com', 'claude'],
  ['perplexity.ai', 'perplexity'],
  ['gemini.google.com', 'gemini'],
]

function platformForSignatureAgentHost(host: string): AgentPlatform {
  for (const [domain, platform] of SIGNATURE_AGENT_PLATFORMS) {
    if (host === domain || host.endsWith(`.${domain}`)) return platform
  }
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Protocol routes
// ---------------------------------------------------------------------------

const PROTOCOL_ROUTES = ['/.well-known/ucp', '/.well-known/acp', '/mcp', '/acp'] as const

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    const stripped = url.split('#')[0]?.split('?')[0] ?? ''
    return stripped
  }
}

function matchProtocolRoute(pathname: string): string | null {
  const path = pathname.toLowerCase().replace(/\/+$/, '') || '/'
  for (const route of PROTOCOL_ROUTES) {
    if (path === route || path.startsWith(`${route}/`)) return route
  }
  return null
}

// ---------------------------------------------------------------------------
// User-Agent heuristics (fallback only — see README: UA alone never justifies
// substantive content differences; confidence is capped at 'medium')
// ---------------------------------------------------------------------------

interface UaEntry {
  pattern: string
  platform: AgentPlatform
}

/**
 * Crawler UAs are checked before everything else: a known crawler is always
 * classified 'crawler' regardless of other signals (cloaking guardrail —
 * Googlebot must receive canonical HTML, never markdown).
 *
 * Every Microsoft fetcher below belongs in THIS table rather than `AGENT_UA`,
 * and the asymmetry is deliberate. Misclassifying a crawler as an agent serves
 * it markdown, which is the cloaking fact pattern; misclassifying an agent as
 * a crawler only costs that caller a markdown response it can still get by
 * asking for one with `Accept`. When a Microsoft token is ambiguous, crawler
 * is the side to be wrong on — and `adidxbot` in particular audits ad landing
 * pages for policy compliance, so serving it anything but the canonical page
 * is the single worst outcome available here.
 */
const CRAWLER_UA: readonly UaEntry[] = [
  { pattern: 'googlebot', platform: 'googlebot' },
  { pattern: 'bingbot', platform: 'bingbot' },
  // Bing Ads landing-page quality crawler. Its own UA points at
  // bing.com/bingbot.htm, so it is attributed to the bingbot platform.
  { pattern: 'adidxbot', platform: 'bingbot' },
  // Microsoft product previews (link unfurling in Teams, Outlook, and the
  // like). A separate platform because it is not Bing and not an assistant:
  // attributing it to `bingbot` would inflate a merchant's Bing figure with
  // traffic that never touched the index.
  { pattern: 'microsoftpreview', platform: 'microsoft-preview' },
  // Apple's search crawler for Spotlight, Siri and Safari suggestions, so it
  // sits with Googlebot on the canonical-HTML side. Source:
  // https://support.apple.com/en-us/119829 (UA "contains Applebot", e.g.
  // `... Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)`).
  // `Applebot-Extended` is deliberately NOT a pattern: Apple documents it as a
  // robots.txt token that "does not crawl webpages"; it only controls whether
  // Applebot's crawl may train Apple's models, and it never arrives as a
  // User-Agent of its own.
  { pattern: 'applebot', platform: 'applebot' },
]

/** Order matters: more specific tokens before broader ones. */
const AGENT_UA: readonly UaEntry[] = [
  { pattern: 'claude-code', platform: 'claude-code' },
  { pattern: 'opencode', platform: 'opencode' },
  { pattern: 'chatgpt-user', platform: 'chatgpt' },
  { pattern: 'oai-searchbot', platform: 'chatgpt' },
  { pattern: 'gptbot', platform: 'chatgpt' },
  { pattern: 'perplexitybot', platform: 'perplexity' },
  { pattern: 'perplexity-user', platform: 'perplexity' },
  { pattern: 'google-extended', platform: 'gemini' },
  { pattern: 'gemini', platform: 'gemini' },
  { pattern: 'claude-web', platform: 'claude' },
  { pattern: 'claudebot', platform: 'claude' },
  { pattern: 'claude-user', platform: 'claude' },
  { pattern: 'anthropic-ai', platform: 'claude' },
  // Meta's AI crawler (model training and Meta product indexing) and its
  // user-initiated fetcher. Source, both tokens:
  // https://developers.facebook.com/documentation/sharing/webmasters/web-crawlers
  // (`meta-externalagent/1.1 (+...)`, `meta-externalfetcher/1.1 (+...)`).
  { pattern: 'meta-externalagent', platform: 'meta' },
  { pattern: 'meta-externalfetcher', platform: 'meta' },
  // Source: https://developer.amazon.com/amazonbot
  // (`Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1) Chrome/W.X.Y.Z Safari/537.36`).
  { pattern: 'amazonbot', platform: 'amazon' },
  // DuckDuckGo's real-time fetcher for DuckAssist answers. Source:
  // https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot
  // (`DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)`).
  { pattern: 'duckassistbot', platform: 'duckduckgo' },
  // Mistral's user-initiated fetcher: it visits a page when a user's question
  // needs it, and is not an automatic crawler. Source: https://docs.mistral.ai/robots
  // (`Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)`).
  { pattern: 'mistralai-user', platform: 'mistral' },
]

function findUaEntry(ua: string, table: readonly UaEntry[]): UaEntry | undefined {
  return table.find((entry) => ua.includes(entry.pattern))
}

// ---------------------------------------------------------------------------
// detect()
// ---------------------------------------------------------------------------

/**
 * Classify a request from its headers (and optionally URL). Pure compute:
 * no network, no crypto. Checks run cheapest-first; every check that fires
 * is recorded in `signals`, and the highest-precedence one classifies.
 *
 * Precedence: crawler UA (guardrail) > Accept: text/markdown >
 * Signature-Agent / Web Bot Auth headers > protocol route > agent UA > human.
 */
export function detect(input: DetectInput): DetectionResult {
  const headers = input.headers ?? {}
  const signals: string[] = []

  // Gather raw evidence once.
  const acceptRaw = headerValue(headers, 'accept')
  const ranges = acceptRaw === undefined ? [] : parseAccept(acceptRaw)
  const acceptsMarkdown = acceptsMediaType(ranges, 'text/markdown')
  const acceptsHtml = acceptsMediaType(ranges, 'text/html')

  const ua = (headerValue(headers, 'user-agent') ?? '').toLowerCase()
  const crawlerMatch = findUaEntry(ua, CRAWLER_UA)
  const agentUaMatch = crawlerMatch === undefined ? findUaEntry(ua, AGENT_UA) : undefined

  const signatureAgentRaw = headerValue(headers, 'signature-agent')
  const signatureAgentHost =
    signatureAgentRaw === undefined ? null : parseSignatureAgentHost(signatureAgentRaw)
  const hasSignaturePair =
    headerValue(headers, 'signature') !== undefined &&
    headerValue(headers, 'signature-input') !== undefined

  const protocolRoute = input.url === undefined ? null : matchProtocolRoute(pathnameOf(input.url))

  // Record fired checks in detection order.
  if (acceptsMarkdown) signals.push('accept:text/markdown')
  if (signatureAgentHost !== null) signals.push(`signature-agent:${signatureAgentHost}`)
  if (hasSignaturePair) signals.push('web-bot-auth:signature')
  if (protocolRoute !== null) signals.push(`protocol:${protocolRoute}`)
  if (crawlerMatch !== undefined) signals.push(`ua:${crawlerMatch.pattern}`)
  if (agentUaMatch !== undefined) signals.push(`ua:${agentUaMatch.pattern}`)

  const base = { verified: false as const, acceptsMarkdown, signals }

  // 0. Cloaking guardrail: a known crawler UA always classifies as crawler,
  //    even if other signals fired. Googlebot never takes the agent path.
  if (crawlerMatch !== undefined) {
    return { ...base, kind: 'crawler', platform: crawlerMatch.platform, confidence: 'medium' }
  }

  // 1. Accept: text/markdown — the cheapest, most explicit agent signal.
  //    Platform attribution prefers Signature-Agent (a stated identity) over UA.
  if (acceptsMarkdown) {
    const signaturePlatform =
      signatureAgentHost !== null ? platformForSignatureAgentHost(signatureAgentHost) : null
    const platform = signaturePlatform ?? agentUaMatch?.platform ?? 'unknown'
    return { ...base, kind: 'agent', platform, confidence: 'high' }
  }

  // 2. Web Bot Auth headers — parse only here; cryptographic verification is
  //    the separate async verifyWebBotAuth() step (src/verify.ts).
  if (signatureAgentHost !== null) {
    return {
      ...base,
      kind: 'agent',
      platform: platformForSignatureAgentHost(signatureAgentHost),
      confidence: 'high',
    }
  }
  if (hasSignaturePair) {
    return {
      ...base,
      kind: 'agent',
      platform: agentUaMatch?.platform ?? 'unknown',
      confidence: 'medium',
    }
  }

  // 3. Protocol route hit.
  if (protocolRoute !== null) {
    return {
      ...base,
      kind: 'protocol',
      platform: agentUaMatch?.platform ?? null,
      confidence: 'high',
    }
  }

  // 4. UA heuristics — fallback only, capped at medium confidence.
  if (agentUaMatch !== undefined) {
    return { ...base, kind: 'agent', platform: agentUaMatch.platform, confidence: 'medium' }
  }

  // 5. Default: human. High confidence only with a browserish Accept/UA.
  if (acceptsHtml) signals.push('accept:text/html')
  else if (ua.includes('mozilla/')) signals.push('ua:browser')
  const browserish = acceptsHtml || ua.includes('mozilla/')
  return { ...base, kind: 'human', platform: null, confidence: browserish ? 'high' : 'low' }
}
