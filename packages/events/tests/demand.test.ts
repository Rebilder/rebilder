import { describe, expect, it } from 'vitest'
import { classifyDemand, demandSignals, type DemandObservation } from '../src/demand'

const product: DemandObservation = {
  requesterKind: 'agent',
  url: 'https://shop.example/products/chair',
  intentSignals: {},
  responsePath: 'markdown',
  responseSource: 'product',
  responseCoverage: 'sourced',
}

describe('observed commercial demand', () => {
  it('classifies product information without inventing unfulfilled demand', () => {
    expect(classifyDemand(product)).toMatchObject({
      category: 'product-information',
      commercial: true,
      unfulfilled: false,
    })
    expect(
      classifyDemand({ ...product, responsePath: 'html-variant', responseCoverage: undefined }),
    ).toMatchObject({ commercial: true, gap: null })
  })
  it('does not mistake a universal documentation collection for a commerce catalog', () => {
    expect(
      classifyDemand({
        ...product,
        url: 'https://shop.example/docs',
        responseSource: 'collection',
      }),
    ).toMatchObject({ category: 'unknown', commercial: false })
    expect(
      classifyDemand({
        ...product,
        url: 'https://shop.example/collections/chairs',
        responseSource: 'collection',
      }),
    ).toMatchObject({ category: 'product-information', commercial: true, basis: 'path' })
  })

  it('requires an observed unsourced response or numeric zero-result protocol call', () => {
    expect(classifyDemand({ ...product, responseCoverage: 'unsourced' }).gap).toBe('no-source')
    expect(
      classifyDemand({
        ...product,
        requesterKind: 'protocol',
        responsePath: 'protocol',
        intentSignals: { tool: 'mcp.search_catalog', result_count: 0 },
      }).gap,
    ).toBe('no-results')
    expect(
      classifyDemand({ ...product, responsePath: 'protocol', intentSignals: { result_count: '0' } })
        .gap,
    ).toBeNull()
    expect(classifyDemand({ ...product, intentSignals: { result_count: 0 } }).gap).toBeNull()
  })
  it('does not turn humans, crawlers, policy denials or unknown requests into unfulfilled commercial demand', () => {
    for (const requesterKind of ['human', 'crawler']) {
      expect(
        classifyDemand({ ...product, requesterKind, responseCoverage: 'unsourced' }),
      ).toMatchObject({ commercial: false, unfulfilled: false })
    }
    expect(
      classifyDemand({ ...product, responsePath: 'denied', responseCoverage: 'unsourced' }),
    ).toMatchObject({ denied: true, unfulfilled: false })
    expect(
      classifyDemand({
        ...product,
        url: 'https://shop.example/about',
        responseSource: 'none',
        responseCoverage: 'unsourced',
      }),
    ).toMatchObject({ category: 'unknown', commercial: false })
  })
  it('refines catalog queries and separates post-sale/support language', () => {
    expect(
      classifyDemand({
        ...product,
        intentSignals: { tool: 'mcp.search_catalog', query: 'Can I get a bundle discount?' },
      }),
    ).toMatchObject({ category: 'custom-terms', basis: 'query', commercial: true })
    expect(
      classifyDemand({ ...product, intentSignals: { query: 'refund my broken chair' } }),
    ).toMatchObject({ category: 'cancellation', commercial: false })
    expect(
      classifyDemand({ ...product, intentSignals: { query: 'troubleshoot my chair' } }).commercial,
    ).toBe(false)
  })
  it('screens free text and handles malformed or prototype-shaped tool names', () => {
    expect(
      classifyDemand({
        ...product,
        responseSource: undefined,
        url: 'bad',
        intentSignals: { query: 'price for alice@example.com', tool: '__proto__' },
      }),
    ).toMatchObject({ category: 'unknown', basis: 'none' })
    expect(
      classifyDemand({
        ...product,
        responseSource: undefined,
        url: 'bad',
        intentSignals: { tool: 'constructor' },
      }).category,
    ).toBe('unknown')
  })
  it('versions derived fields independently of the additive wire contract', () => {
    expect(demandSignals(product)).toMatchObject({
      demand_version: 2,
      commercial_intent: true,
      unfulfilled_demand: false,
      demand_gap: null,
    })
  })
})
