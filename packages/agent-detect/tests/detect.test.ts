import { describe, expect, it } from 'vitest'
import { detect } from '../src/index'

const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

describe('header handling', () => {
  it('looks up headers case-insensitively', () => {
    const result = detect({ headers: { ACCEPT: 'text/markdown', 'User-Agent': 'claude-code/1.0.58' } })
    expect(result.acceptsMarkdown).toBe(true)
    expect(result.kind).toBe('agent')
    expect(result.platform).toBe('claude-code')
  })

  it('handles array header values as a joined list', () => {
    const result = detect({ headers: { accept: ['text/html;q=0.9', 'text/markdown'] } })
    expect(result.acceptsMarkdown).toBe(true)
    expect(result.kind).toBe('agent')
  })

  it('ignores undefined header values', () => {
    const result = detect({ headers: { accept: undefined, 'user-agent': undefined } })
    expect(result.kind).toBe('human')
    expect(result.confidence).toBe('low')
  })
})

describe('Accept parsing (q-values)', () => {
  it('detects text/markdown with an explicit q-value', () => {
    const result = detect({ headers: { accept: 'text/html;q=0.9, text/markdown;q=0.8, */*;q=0.1' } })
    expect(result.acceptsMarkdown).toBe(true)
    expect(result.signals[0]).toBe('accept:text/markdown')
  })

  it('treats q=0 as not acceptable', () => {
    const result = detect({ headers: { accept: 'text/markdown;q=0, text/html' } })
    expect(result.acceptsMarkdown).toBe(false)
    expect(result.kind).toBe('human')
  })

  it('does not count wildcard */* as explicit markdown', () => {
    const result = detect({ headers: { accept: '*/*' } })
    expect(result.acceptsMarkdown).toBe(false)
    expect(result.kind).toBe('human')
  })

  it('is case-insensitive on the media type', () => {
    const result = detect({ headers: { accept: 'Text/Markdown' } })
    expect(result.acceptsMarkdown).toBe(true)
  })
})

describe('precedence order', () => {
  it('accept beats UA: markdown Accept classifies before UA heuristics', () => {
    const result = detect({
      headers: { accept: 'text/markdown', 'user-agent': 'opencode/0.5.29' },
    })
    expect(result.kind).toBe('agent')
    expect(result.confidence).toBe('high')
    expect(result.signals).toEqual(['accept:text/markdown', 'ua:opencode'])
    expect(result.platform).toBe('opencode')
  })

  it('accept beats protocol route', () => {
    const result = detect({ headers: { accept: 'text/markdown' }, url: '/mcp' })
    expect(result.kind).toBe('agent')
    expect(result.signals).toEqual(['accept:text/markdown', 'protocol:/mcp'])
  })

  it('signature-agent beats protocol route and UA', () => {
    const result = detect({
      headers: {
        'signature-agent': '"https://chatgpt.com"',
        'user-agent': 'Mozilla/5.0; compatible; ChatGPT-User/1.0',
      },
      url: '/mcp',
    })
    expect(result.kind).toBe('agent')
    expect(result.platform).toBe('chatgpt')
    expect(result.signals[0]).toBe('signature-agent:chatgpt.com')
  })
})

describe('Web Bot Auth signals (parse only, never verified in Phase 0)', () => {
  it('identifies the platform from Signature-Agent', () => {
    const result = detect({ headers: { 'Signature-Agent': '"https://chatgpt.com"' } })
    expect(result.kind).toBe('agent')
    expect(result.platform).toBe('chatgpt')
    expect(result.verified).toBe(false)
    expect(result.confidence).toBe('high')
  })

  it('maps subdomains of known signature-agent hosts', () => {
    const result = detect({ headers: { 'signature-agent': '"https://operator.chatgpt.com"' } })
    expect(result.platform).toBe('chatgpt')
  })

  it('classifies unknown signature-agent hosts as agent/unknown', () => {
    const result = detect({ headers: { 'signature-agent': '"https://agent.example.dev"' } })
    expect(result.kind).toBe('agent')
    expect(result.platform).toBe('unknown')
    expect(result.signals).toEqual(['signature-agent:agent.example.dev'])
  })

  it('treats a bare Signature + Signature-Input pair as an agent signal (medium confidence)', () => {
    const result = detect({
      headers: {
        signature: 'sig1=:dGVzdA==:',
        'signature-input': 'sig1=("@authority");created=1754265600;tag="web-bot-auth"',
      },
    })
    expect(result.kind).toBe('agent')
    expect(result.platform).toBe('unknown')
    expect(result.confidence).toBe('medium')
    expect(result.signals).toEqual(['web-bot-auth:signature'])
  })
})

describe('protocol routes', () => {
  it.each([
    ['/.well-known/ucp', '/.well-known/ucp'],
    ['/.well-known/ucp/catalog', '/.well-known/ucp'],
    ['/.well-known/acp', '/.well-known/acp'],
    ['/mcp', '/mcp'],
    ['/mcp/', '/mcp'],
    ['/mcp/tools/list', '/mcp'],
    ['/acp/checkout', '/acp'],
    ['https://store.example.com/mcp', '/mcp'],
    ['https://store.example.com/mcp?session=abc', '/mcp'],
  ])('classifies %s as protocol (%s)', (url, route) => {
    const result = detect({ headers: {}, url, method: 'POST' })
    expect(result.kind).toBe('protocol')
    expect(result.signals).toEqual([`protocol:${route}`])
    expect(result.confidence).toBe('high')
  })

  it.each(['/mcpx', '/acpeek', '/products/mcp-widget', '/'])('does not match %s', (url) => {
    const result = detect({ headers: {}, url })
    expect(result.kind).toBe('human')
  })
})

describe('crawlers (cloaking guardrail)', () => {
  it('classifies Googlebot as crawler, never agent', () => {
    const result = detect({ headers: { 'user-agent': GOOGLEBOT_UA, accept: 'text/html,*/*;q=0.8' } })
    expect(result.kind).toBe('crawler')
    expect(result.platform).toBe('googlebot')
  })

  it('keeps Googlebot a crawler even with Accept: text/markdown', () => {
    const result = detect({ headers: { 'user-agent': GOOGLEBOT_UA, accept: 'text/markdown' } })
    expect(result.kind).toBe('crawler')
    expect(result.platform).toBe('googlebot')
    // acceptsMarkdown reports the header fact, but kind pins the serving path.
    expect(result.acceptsMarkdown).toBe(true)
  })

  it('keeps Googlebot a crawler on a protocol route', () => {
    const result = detect({ headers: { 'user-agent': GOOGLEBOT_UA }, url: '/mcp' })
    expect(result.kind).toBe('crawler')
  })

  it('classifies bingbot as crawler', () => {
    const result = detect({
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      },
    })
    expect(result.kind).toBe('crawler')
    expect(result.platform).toBe('bingbot')
  })
})

describe('UA heuristics (fallback only)', () => {
  it('identifies known agent UAs at medium confidence', () => {
    const result = detect({
      headers: { 'user-agent': 'Mozilla/5.0; compatible; ChatGPT-User/1.0; +https://openai.com/bot' },
    })
    expect(result.kind).toBe('agent')
    expect(result.platform).toBe('chatgpt')
    expect(result.confidence).toBe('medium')
    expect(result.signals).toEqual(['ua:chatgpt-user'])
  })

  it('identifies Google-Extended as gemini', () => {
    const result = detect({ headers: { 'user-agent': 'Mozilla/5.0 (compatible; Google-Extended)' } })
    expect(result.kind).toBe('agent')
    expect(result.platform).toBe('gemini')
  })

  it('identifies anthropic claude-web as claude', () => {
    const result = detect({ headers: { 'user-agent': 'Mozilla/5.0 (compatible; anthropic-ai/claude-web)' } })
    expect(result.kind).toBe('agent')
    expect(result.platform).toBe('claude')
  })
})

describe('default: human', () => {
  it('classifies a browserish request as human with high confidence', () => {
    const result = detect({
      headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'user-agent': CHROME_UA },
    })
    expect(result.kind).toBe('human')
    expect(result.platform).toBe(null)
    expect(result.confidence).toBe('high')
    expect(result.signals).toEqual(['accept:text/html'])
  })

  it('classifies empty headers as human with low confidence and no signals', () => {
    const result = detect({ headers: {} })
    expect(result).toEqual({
      kind: 'human',
      platform: null,
      verified: false,
      acceptsMarkdown: false,
      signals: [],
      confidence: 'low',
    })
  })

  it('classifies garbage headers as human with low confidence', () => {
    const result = detect({
      headers: { 'x-total-nonsense': '???', accept: ';;;,,,', 'user-agent': 'curl/8.5.0' },
    })
    expect(result.kind).toBe('human')
    expect(result.confidence).toBe('low')
    expect(result.acceptsMarkdown).toBe(false)
  })
})
