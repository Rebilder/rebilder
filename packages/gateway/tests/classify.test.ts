import { describe, expect, it } from 'vitest'
import { classifyRequest } from '../src/index'
import {
  BINGBOT_HEADERS,
  BROWSER_CHROME_HEADERS,
  CHATGPT_SIGNED_HEADERS,
  CHATGPT_USER_HEADERS,
  CLAUDE_CODE_HEADERS,
  GOOGLEBOT_HEADERS,
  GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS,
  OPENCODE_HEADERS,
  PDP_PATH,
  PROTOCOL_CLIENT_HEADERS,
  SIGNATURE_ONLY_HEADERS,
  makeRequest,
} from './fixtures'

describe('classifyRequest — agents', () => {
  it('routes Accept: text/markdown to the markdown path', () => {
    const decision = classifyRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS))
    expect(decision.path).toBe('markdown')
    expect(decision.detection.kind).toBe('agent')
    expect(decision.detection.platform).toBe('claude-code')
    expect(decision.detection.acceptsMarkdown).toBe(true)
  })

  it('routes an identified agent platform (UA, no markdown Accept) to markdown', () => {
    const decision = classifyRequest(makeRequest(PDP_PATH, CHATGPT_USER_HEADERS))
    expect(decision.path).toBe('markdown')
    expect(decision.detection.kind).toBe('agent')
    expect(decision.detection.platform).toBe('chatgpt')
    expect(decision.detection.acceptsMarkdown).toBe(false)
  })

  it('routes a Signature-Agent-identified agent to markdown', () => {
    const decision = classifyRequest(makeRequest(PDP_PATH, CHATGPT_SIGNED_HEADERS))
    expect(decision.path).toBe('markdown')
    expect(decision.detection.platform).toBe('chatgpt')
    // Phase 0: parsed, never verified.
    expect(decision.detection.verified).toBe(false)
  })

  it('routes opencode (markdown Accept) to markdown', () => {
    const decision = classifyRequest(makeRequest(PDP_PATH, OPENCODE_HEADERS))
    expect(decision.path).toBe('markdown')
    expect(decision.detection.platform).toBe('opencode')
  })

  it('passes through an unidentified agent that did not ask for markdown', () => {
    // Bare Signature/Signature-Input pair: kind=agent, platform=unknown.
    // Neither "asked for markdown" nor "identified platform" → html.
    const decision = classifyRequest(makeRequest(PDP_PATH, SIGNATURE_ONLY_HEADERS))
    expect(decision.detection.kind).toBe('agent')
    expect(decision.detection.platform).toBe('unknown')
    expect(decision.path).toBe('html')
  })
})

describe('classifyRequest — humans and crawlers', () => {
  it('routes a browser to the html path (pass through)', () => {
    const decision = classifyRequest(makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS))
    expect(decision.path).toBe('html')
    expect(decision.detection.kind).toBe('human')
  })

  it('routes Googlebot to the html path', () => {
    const decision = classifyRequest(makeRequest(PDP_PATH, GOOGLEBOT_HEADERS))
    expect(decision.path).toBe('html')
    expect(decision.detection.kind).toBe('crawler')
    expect(decision.detection.platform).toBe('googlebot')
  })

  it('routes Googlebot to html EVEN WITH Accept: text/markdown (consistent source content)', () => {
    // Cloaking guardrail: Googlebot always receives canonical HTML. A request
    // wearing Googlebot's UA never reaches the markdown path, whatever it
    // puts in Accept.
    const decision = classifyRequest(makeRequest(PDP_PATH, GOOGLEBOT_MARKDOWN_ACCEPT_HEADERS))
    expect(decision.path).toBe('html')
    expect(decision.detection.kind).toBe('crawler')
    expect(decision.detection.acceptsMarkdown).toBe(true) // header fact still reported
  })

  it('routes bingbot to the html path', () => {
    const decision = classifyRequest(makeRequest(PDP_PATH, BINGBOT_HEADERS))
    expect(decision.path).toBe('html')
    expect(decision.detection.platform).toBe('bingbot')
  })
})

describe('classifyRequest — protocol routes', () => {
  it.each(['/.well-known/ucp', '/mcp', '/acp', '/acp/checkout'])(
    'classifies %s as the protocol path',
    (path) => {
      const decision = classifyRequest(makeRequest(path, PROTOCOL_CLIENT_HEADERS))
      expect(decision.path).toBe('protocol')
      expect(decision.detection.kind).toBe('protocol')
    },
  )

  it('routes a signed agent on a protocol route (no markdown Accept) to the protocol path', () => {
    // A Web Bot Auth-signed UCP/MCP call carries Signature-Agent, which
    // detect() ranks above the protocol route (kind 'agent'). It must still
    // reach the protocol handler — and Phase 3 verification — not the
    // markdown renderer.
    const decision = classifyRequest(makeRequest('/mcp', CHATGPT_SIGNED_HEADERS))
    expect(decision.path).toBe('protocol')
    expect(decision.detection.kind).toBe('agent') // detection stays honest; routing decides the path
  })

  it('keeps ARCHITECTURE precedence: markdown Accept beats the protocol route', () => {
    // § Request classification checks Accept: text/markdown (1) before the
    // protocol route (3): an agent explicitly asking for markdown gets the
    // markdown path even on /mcp. Real protocol clients send JSON/SSE Accepts.
    const decision = classifyRequest(makeRequest('/mcp', CLAUDE_CODE_HEADERS))
    expect(decision.path).toBe('markdown')
    expect(decision.detection.kind).toBe('agent')
  })
})

describe('classifyRequest — purity and speed', () => {
  it('is pure: identical requests give identical decisions, body untouched', () => {
    const req = makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS)
    const a = classifyRequest(req)
    const b = classifyRequest(req)
    expect(b).toEqual(a)
    expect(req.bodyUsed).toBe(false)
    expect(classifyRequest(makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS))).toEqual(a)
  })

  it('classifies 1000 requests well under the hot-path budget', () => {
    const requests = [
      makeRequest(PDP_PATH, CLAUDE_CODE_HEADERS),
      makeRequest(PDP_PATH, BROWSER_CHROME_HEADERS),
      makeRequest(PDP_PATH, GOOGLEBOT_HEADERS),
      makeRequest('/mcp', CHATGPT_SIGNED_HEADERS),
    ]
    const start = performance.now()
    for (let i = 0; i < 1000; i++) {
      classifyRequest(requests[i % requests.length] as Request)
    }
    const elapsed = performance.now() - start
    // Generous bound: <1ms each on average would be 1000ms; require far less.
    expect(elapsed).toBeLessThan(500)
  })
})
