import { describe, expect, it } from 'vitest'

import {
  INTENT_QUERY_MAX_LENGTH,
  SEARCH_QUERY_PARAMS,
  buildProtocolIntentSignals,
  classifyReferrerPlatform,
  extractUrlIntentSignals,
  scrubQueryText,
} from '../src/intent'

describe('scrubQueryText', () => {
  it('passes ordinary commerce search text through, normalized', () => {
    expect(scrubQueryText('waterproof trail boots')).toBe('waterproof trail boots')
    expect(scrubQueryText('  wide   fit\tsneakers ')).toBe('wide fit sneakers')
    expect(scrubQueryText('size 11')).toBe('size 11')
    expect(scrubQueryText('gift card $50')).toBe('gift card $50')
  })

  it('drops empty and whitespace-only strings', () => {
    expect(scrubQueryText('')).toBeNull()
    expect(scrubQueryText('   ')).toBeNull()
  })

  it(`drops strings longer than ${INTENT_QUERY_MAX_LENGTH} chars (fail closed)`, () => {
    expect(scrubQueryText('a '.repeat(101).trim())).toBeNull()
    expect(scrubQueryText('x'.repeat(INTENT_QUERY_MAX_LENGTH + 1))).toBeNull()
  })

  it('drops anything containing @ (emails, handles)', () => {
    expect(scrubQueryText('order for jane.doe@example.com')).toBeNull()
    expect(scrubQueryText('@somehandle')).toBeNull()
  })

  it('drops long digit runs even with phone-style separators', () => {
    expect(scrubQueryText('call 07700 900123')).toBeNull()
    expect(scrubQueryText('(770) 090-0123')).toBeNull()
    expect(scrubQueryText('order 123456789')).toBeNull()
    expect(scrubQueryText('4111 1111 1111 1111')).toBeNull()
  })

  it('keeps short digit content (sizes, quantities, model numbers)', () => {
    expect(scrubQueryText('iphone 15 case')).toBe('iphone 15 case')
    expect(scrubQueryText('2 pack AA 1500mah')).toBe('2 pack AA 1500mah')
  })

  it('drops token-like fragments and pasted URLs', () => {
    expect(scrubQueryText('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBeNull()
    expect(scrubQueryText('reset abcdef0123456789abcdef01')).toBeNull()
    expect(scrubQueryText('see https://example.com/x')).toBeNull()
  })
})

describe('classifyReferrerPlatform', () => {
  it('classifies known AI platforms from full URLs', () => {
    expect(classifyReferrerPlatform('https://chatgpt.com/')).toBe('chatgpt')
    expect(classifyReferrerPlatform('https://chat.openai.com/c/abc')).toBe('chatgpt')
    expect(classifyReferrerPlatform('https://www.perplexity.ai/search?q=x')).toBe('perplexity')
    expect(classifyReferrerPlatform('https://claude.ai/chat/123')).toBe('claude')
    expect(classifyReferrerPlatform('https://gemini.google.com/app')).toBe('gemini')
    expect(classifyReferrerPlatform('https://copilot.microsoft.com/')).toBe('copilot')
  })

  it('classifies bare hostnames', () => {
    expect(classifyReferrerPlatform('chatgpt.com')).toBe('chatgpt')
    expect(classifyReferrerPlatform('perplexity.ai')).toBe('perplexity')
  })

  it('matches subdomains but never lookalike suffixes', () => {
    expect(classifyReferrerPlatform('https://www.chatgpt.com/')).toBe('chatgpt')
    expect(classifyReferrerPlatform('https://notchatgpt.com/')).toBeNull()
    expect(classifyReferrerPlatform('https://chatgpt.com.evil.example/')).toBeNull()
  })

  it('returns null for search engines, social, and garbage', () => {
    expect(classifyReferrerPlatform('https://www.google.com/search?q=x')).toBeNull()
    expect(classifyReferrerPlatform('https://t.co/abc')).toBeNull()
    expect(classifyReferrerPlatform('not a url at all !!')).toBeNull()
    expect(classifyReferrerPlatform('')).toBeNull()
  })
})

describe('extractUrlIntentSignals', () => {
  it('returns {} when there is nothing to record', () => {
    expect(extractUrlIntentSignals('https://shop.example/products/boots')).toEqual({})
  })

  it('extracts a search query with its param name', () => {
    expect(extractUrlIntentSignals('https://shop.example/search?q=trail+boots')).toEqual({
      query: 'trail boots',
      query_param: 'q',
    })
  })

  it('covers the WordPress search param (s)', () => {
    expect(SEARCH_QUERY_PARAMS).toContain('s')
    expect(extractUrlIntentSignals('https://blog.example/?s=pricing+guide')).toEqual({
      query: 'pricing guide',
      query_param: 's',
    })
  })

  it('first present search param decides; a scrubbed drop stays dropped', () => {
    // q is present but trips the scrubber — the query is dropped, not
    // rescued from a later param. Fail closed, no second guesses.
    const signals = extractUrlIntentSignals(
      'https://shop.example/search?q=jane@example.com&search=boots',
    )
    expect(signals['query']).toBeUndefined()
  })

  it('records sanitized utm params and ignores misshapen ones', () => {
    expect(
      extractUrlIntentSignals(
        'https://shop.example/p/x?utm_source=ChatGPT.com&utm_medium=referral',
      ),
    ).toEqual({ utm_source: 'chatgpt.com', utm_medium: 'referral' })
    expect(
      extractUrlIntentSignals('https://shop.example/p/x?utm_source=<script>alert(1)</script>'),
    ).toEqual({})
  })

  it('classifies the referrer independently of the URL', () => {
    expect(
      extractUrlIntentSignals('https://shop.example/products/boots', 'https://chatgpt.com/'),
    ).toEqual({ referrer_platform: 'chatgpt' })
  })

  it('survives an unparseable URL and still classifies the referrer', () => {
    expect(extractUrlIntentSignals('::not a url::', 'https://claude.ai/chat/1')).toEqual({
      referrer_platform: 'claude',
    })
  })
})

describe('buildProtocolIntentSignals', () => {
  it('always records the tool', () => {
    expect(buildProtocolIntentSignals({ tool: 'mcp.get_policies' })).toEqual({
      tool: 'mcp.get_policies',
      capability_version: 1,
      requested_capability: 'policy.read',
    })
  })

  it('records a scrubbed query attributed to the tool, and the result count', () => {
    expect(
      buildProtocolIntentSignals({
        tool: 'mcp.search_catalog',
        query: 'trail boots',
        resultCount: 4,
      }),
    ).toEqual({
      tool: 'mcp.search_catalog',
      capability_version: 1,
      requested_capability: 'catalog.search',
      query: 'trail boots',
      query_param: 'mcp.search_catalog',
      result_count: 4,
    })
  })

  it('records result_count 0 — the zero-result demand signal', () => {
    expect(
      buildProtocolIntentSignals({ tool: 'mcp.search_catalog', query: 'wide fit', resultCount: 0 }),
    ).toMatchObject({ result_count: 0 })
  })

  it('drops a PII-tripping query but keeps the tool and count', () => {
    expect(
      buildProtocolIntentSignals({
        tool: 'mcp.search_catalog',
        query: 'jane@example.com order',
        resultCount: 0,
      }),
    ).toEqual({
      tool: 'mcp.search_catalog',
      result_count: 0,
      capability_version: 1,
      requested_capability: 'catalog.search',
    })
  })

  it('ignores negative or non-integer result counts', () => {
    expect(buildProtocolIntentSignals({ tool: 't', resultCount: -1 })).toEqual({ tool: 't' })
    expect(buildProtocolIntentSignals({ tool: 't', resultCount: 1.5 })).toEqual({ tool: 't' })
  })
})
