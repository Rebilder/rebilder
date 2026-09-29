/**
 * Gateway test fixtures.
 *
 * Header shapes are inlined here, modeled on the real observed samples in
 * packages/agent-detect/fixtures/ (claude-code, chatgpt-agent, googlebot,
 * browser-chrome, …). They are NOT imported from that package — deep imports
 * across packages are forbidden (project convention); agent-detect's
 * fixture corpus is its own regression suite, these are the gateway's.
 */

import type { CatalogItemSource, PolicySource, ProductSource } from '../src/index'

// ---------------------------------------------------------------------------
// Header shapes
// ---------------------------------------------------------------------------

/** Claude Code CLI: explicit Accept: text/markdown + CLI UA. */
export const CLAUDE_CODE_HEADERS: Record<string, string> = {
  accept: 'text/markdown;q=1.0, text/html;q=0.8, text/plain;q=0.5, */*;q=0.1',
  'accept-encoding': 'gzip, deflate, br',
  'user-agent': 'claude-code/2.0.13 (external, cli)',
}

/** OpenCode CLI: markdown Accept, no other identity signals. */
export const OPENCODE_HEADERS: Record<string, string> = {
  accept: 'text/markdown, text/plain;q=0.8, */*;q=0.5',
  'user-agent': 'opencode/0.3.1',
}

/** ChatGPT user-initiated browsing: identified agent UA, browserish Accept, no markdown. */
export const CHATGPT_USER_HEADERS: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-encoding': 'gzip, deflate, br',
  'user-agent':
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/2.0; +https://openai.com/bot',
}

/** ChatGPT with Web Bot Auth headers (parsed, NOT verified in Phase 0). */
export const CHATGPT_SIGNED_HEADERS: Record<string, string> = {
  ...CHATGPT_USER_HEADERS,
  'signature-agent': '"https://chatgpt.com"',
  'signature-input':
    'sig1=("@authority" "signature-agent");created=1754265600;expires=1754266200;keyid="JrQLj5C_-uusgQwmSFvHYK2PxYlbcO9zRMoDHIQdVRo";tag="web-bot-auth"',
  signature: 'sig1=:TWFrZSBhZ2VudHMgZmlyc3QtY2xhc3MgY2l0aXplbnMgb2YgdGhlIHdlYi4=:',
}

/** Bare unverified Signature pair: agent, but unidentified and not asking for markdown. */
export const SIGNATURE_ONLY_HEADERS: Record<string, string> = {
  accept: '*/*',
  'user-agent': 'python-httpx/0.27.0',
  'signature-input':
    'sig1=("@authority");created=1754265600;expires=1754266200;keyid="k0";tag="web-bot-auth"',
  signature: 'sig1=:c2lnbmF0dXJlLW9ubHktZml4dHVyZQ==:',
}

/** A protocol client (e.g. MCP over streamable HTTP): JSON/SSE Accept, no markdown. */
export const PROTOCOL_CLIENT_HEADERS: Record<string, string> = {
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
  'user-agent': 'node',
}

/** Desktop Chrome: a human in a browser. */
export const BROWSER_CHROME_HEADERS: Record<string, string> = {
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-encoding': 'gzip, deflate, br, zstd',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
}

/** Googlebot desktop: MUST always ride the HTML path (consistent source content). */
export const GOOGLEBOT_HEADERS: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-encoding': 'gzip, deflate, br',
  'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  from: 'googlebot(at)googlebot.com',
}

/** A request claiming Googlebot's UA while asking for markdown — still HTML. */
export const GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS: Record<string, string> = {
  accept: 'text/markdown, text/html;q=0.9',
  'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
}

/** Bingbot. */
export const BINGBOT_HEADERS: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'user-agent':
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36',
}

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

export const STORE_ORIGIN = 'https://store.example.com'

export function makeRequest(path: string, headers: Record<string, string>): Request {
  return new Request(new URL(path, STORE_ORIGIN), { method: 'GET', headers })
}

// ---------------------------------------------------------------------------
// Source-of-truth fixtures
// ---------------------------------------------------------------------------

export const PDP_PATH = '/products/trail-runner-2'

export const product: ProductSource = {
  url: `${STORE_ORIGIN}${PDP_PATH}`,
  title: 'Trail Runner 2',
  brand: 'Acme Outdoors',
  description:
    'The Trail Runner 2 is built for long days on technical terrain. Recycled mesh upper, 6 mm drop, re-profiled lugs for mud without debris on hardpack.',
  price: { amount: 8900, currency: 'USD' },
  compareAtPrice: { amount: 12000, currency: 'USD' },
  availability: 'in_stock',
  variants: [
    {
      id: 'v-8',
      title: 'Size 8',
      price: { amount: 8900, currency: 'USD' },
      availability: 'in_stock',
      sku: 'TR2-8',
      options: { size: '8' },
    },
    {
      id: 'v-10',
      title: 'Size 10',
      price: { amount: 9400, currency: 'USD' },
      availability: 'out_of_stock',
      sku: 'TR2-10',
      options: { size: '10' },
    },
  ],
  shipping: {
    summary: 'Free standard shipping on orders over $50. Standard shipping is $5.95.',
    freeThreshold: { amount: 5000, currency: 'USD' },
    etaDays: [3, 5],
  },
  returns: {
    summary: '30-day returns on unworn shoes.',
    windowDays: 30,
    url: `${STORE_ORIGIN}/policies/returns`,
  },
}

export const POLICY_PATH = '/policies/shipping'

export const policies: PolicySource[] = [
  {
    title: 'Shipping policy',
    url: `${STORE_ORIGIN}${POLICY_PATH}`,
    body: 'Orders ship within 2 business days. Free standard shipping on orders over $50.',
  },
  {
    title: 'Returns policy',
    url: `${STORE_ORIGIN}/policies/returns`,
    body: 'Unworn shoes may be returned within 30 days for a full refund.',
  },
]

export const CATALOG_PATH = '/collections/trail'

export const catalog: CatalogItemSource[] = [
  {
    url: `${STORE_ORIGIN}${PDP_PATH}`,
    title: 'Trail Runner 2',
    price: { amount: 8900, currency: 'USD' },
    availability: 'in_stock',
  },
  {
    url: `${STORE_ORIGIN}/products/ridge-hiker`,
    title: 'Ridge Hiker',
    price: { amount: 14900, currency: 'USD' },
    availability: 'preorder',
  },
]

/** Path-matched sources, the shape a real merchant integration takes. */
export function pathMatchedSources() {
  return {
    product: (url: URL) => (url.pathname === PDP_PATH ? product : null),
    policies: (url: URL) => (url.pathname.startsWith('/policies') ? policies : null),
    catalog: (url: URL) => (url.pathname === CATALOG_PATH ? catalog : null),
  }
}
