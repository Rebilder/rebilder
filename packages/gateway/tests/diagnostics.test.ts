import { describe, expect, it, vi } from 'vitest'
import {
  handleRequest,
  inspectGatewayConfig,
  inspectGatewayResponse,
  type GatewayConfig,
} from '../src/index'
import { product, PDP_PATH, STORE_ORIGIN } from './fixtures'

describe('local installation diagnostics', () => {
  it('inspects wiring without executing callbacks or disclosing business configuration', () => {
    const never = vi.fn(() => {
      throw new Error('must not run')
    })
    const report = inspectGatewayConfig({
      storeId: 'private-store-id',
      sources: { product: never, match: never },
      onEvent: never,
      access: never,
      protocols: never,
    })
    expect(never).not.toHaveBeenCalled()
    expect(report.sources).toEqual(['product'])
    expect(report.valid).toBe(true)
    expect(report.checks.map((check) => check.code)).toContain('verification-not-configured')
    expect(JSON.stringify(report)).not.toContain('private-store-id')
  })

  it('distinguishes optional self-hosted observations from malformed configuration', () => {
    const report = inspectGatewayConfig({ storeId: 'local', sources: { product: () => null } })
    expect(report.valid).toBe(true)
    expect(report.checks.find((check) => check.code === 'events-local-only')?.level).toBe('info')
    const invalid = inspectGatewayConfig({
      storeId: '',
      sources: { product: 42 },
      maxBytes: NaN,
      maxBytesBySource: { document: -1 },
      sourceTimeoutMs: Infinity,
    } as unknown as GatewayConfig)
    expect(invalid.valid).toBe(false)
    expect(
      invalid.checks.filter((check) => check.level === 'error').map((check) => check.code),
    ).toEqual([
      'store-id-missing',
      'source-product-invalid',
      'budget-document-invalid',
      'budget-invalid',
      'timeout-invalid',
    ])
  })

  it('explains deliberate protocol-only wiring and disabled timeouts without rejecting them', () => {
    const report = inspectGatewayConfig({
      storeId: 'local',
      sources: {},
      protocols: async () => null,
      sourceTimeoutMs: 0,
    })
    expect(report.valid).toBe(true)
    expect(report.checks.find((check) => check.code === 'sources-missing')?.level).toBe('info')
    expect(report.checks.find((check) => check.code === 'timeout-disabled')?.level).toBe('warning')
  })

  it('checks a real served product without consuming its response body', async () => {
    const response = await handleRequest(
      new Request(`${STORE_ORIGIN}${PDP_PATH}`, { headers: { accept: 'text/markdown' } }),
      { storeId: 'local', sources: { product: () => product } },
    )
    expect(inspectGatewayResponse(response).map((check) => check.code)).toEqual(['markdown-served'])
    expect(response?.bodyUsed).toBe(false)
    expect(await response?.text()).toContain(product.title)
  })

  it('does not confuse fallback or policy refusal with a source failure', () => {
    expect(inspectGatewayResponse(null)[0]?.code).toBe('html-fallback')
    expect(inspectGatewayResponse(new Response(null, { status: 304 }))[0]?.code).toBe(
      'not-modified',
    )
    expect(inspectGatewayResponse(new Response(null, { status: 429 }))[0]?.code).toBe(
      'access-limited',
    )
    expect(inspectGatewayResponse(new Response('origin failure', { status: 500 }))[0]?.code).toBe(
      'http-error',
    )
    expect(inspectGatewayResponse(new Response('<html/>'))[0]?.code).toBe('not-markdown')
  })

  it('detects a CDN-stripped cache header while accepting valid Vary forms', () => {
    const response = (vary?: string) =>
      new Response('sensitive source text', {
        headers: {
          'content-type': 'Text/Markdown; charset=utf-8',
          ...(vary === undefined ? {} : { vary }),
        },
      })
    expect(inspectGatewayResponse(response()).map((check) => check.code)).toContain(
      'vary-accept-missing',
    )
    for (const vary of ['Accept-Encoding, ACCEPT', '*'])
      expect(inspectGatewayResponse(response(vary)).map((check) => check.code)).toEqual([
        'markdown-served',
      ])
    expect(JSON.stringify(inspectGatewayResponse(response()))).not.toContain(
      'sensitive source text',
    )
  })
})
