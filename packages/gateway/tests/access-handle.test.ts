/**
 * Access control as it behaves through `handleRequest` — the properties that
 * only exist once enforcement is wired into the request path.
 *
 * The important one is that a denial costs the merchant NOTHING: no source
 * resolver runs, no protocol handler is invoked, no markdown is rendered. A
 * denial that still paid for the work it refused to serve would make an abusive
 * client cheaper to serve, not more expensive, which is backwards.
 *
 * The second is that the event still fires. A merchant who cannot see what
 * their policy turned away cannot tell a working policy from one quietly
 * blocking their best traffic — and "agents that reached your site" would
 * silently keep counting the ones that did not.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RebilderEventV0 } from '@rebilder/events'
import { handleRequest } from '../src/core/handle'
import type { GatewayConfig } from '../src/core/types'

function markdownRequest(url = 'https://shop.example.com/products/x'): Request {
  return new Request(url, { headers: { accept: 'text/markdown' } })
}

function browserRequest(url = 'https://shop.example.com/products/x'): Request {
  return new Request(url, { headers: { accept: 'text/html' } })
}

function googlebotRequest(url = 'https://shop.example.com/products/x'): Request {
  return new Request(url, {
    headers: {
      accept: 'text/html',
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    },
  })
}

const DOCUMENT = {
  url: 'https://shop.example.com/products/x',
  title: 'A product page',
  facts: [{ label: 'Price', value: { type: 'text' as const, value: 'ten pounds' } }],
}

function config(overrides: Partial<GatewayConfig> = {}): {
  config: GatewayConfig
  events: RebilderEventV0[]
  documentResolver: ReturnType<typeof vi.fn>
} {
  const events: RebilderEventV0[] = []
  const documentResolver = vi.fn(() => DOCUMENT)
  return {
    events,
    documentResolver,
    config: {
      storeId: 'store_test',
      sources: { document: documentResolver as never },
      onEvent: (event) => {
        events.push(event)
      },
      ...overrides,
    },
  }
}

// ---------------------------------------------------------------------------

describe('a denial costs the merchant nothing', () => {
  it('never calls a source resolver', async () => {
    const { config: cfg, documentResolver } = config({
      access: { rules: [{ subject: '*', action: 'deny' }] },
    })
    const response = await handleRequest(markdownRequest(), cfg)

    expect(response?.status).toBe(403)
    expect(documentResolver).not.toHaveBeenCalled()
  })

  it('never invokes the protocol handler', async () => {
    const protocols = vi.fn(async () => new Response('protocol'))
    const { config: cfg } = config({
      access: { rules: [{ subject: '*', action: 'deny' }] },
      protocols,
    })
    const response = await handleRequest(
      new Request('https://shop.example.com/.well-known/ucp', {
        headers: { accept: 'application/json', 'user-agent': 'ChatGPT-User/1.0' },
      }),
      cfg,
    )

    expect(response?.status).toBe(403)
    expect(protocols).not.toHaveBeenCalled()
  })
})

describe('a denial is still observed', () => {
  it('emits exactly one event, on the denied path', async () => {
    const { config: cfg, events } = config({
      access: { rules: [{ subject: '*', action: 'deny' }] },
    })
    await handleRequest(markdownRequest(), cfg)

    expect(events).toHaveLength(1)
    expect(events[0]?.response.path).toBe('denied')
    // No source was consulted, so this is not an Agent Miss — the site did not
    // fail to answer, it declined to.
    expect(events[0]?.response.coverage).toBe('not-applicable')
  })

  it('records the requester, so a merchant can see who they turned away', async () => {
    const { config: cfg, events } = config({
      access: { rules: [{ subject: '*', action: 'deny' }] },
    })
    await handleRequest(markdownRequest(), cfg)
    expect(events[0]?.requester.kind).toBe('agent')
  })

  it('emits a rate-limited denial too', async () => {
    const { config: cfg, events } = config({
      access: {
        rules: [{ subject: '*', action: 'limit', limit: { requests: 1, windowSeconds: 60 } }],
      },
    })
    await handleRequest(markdownRequest(), cfg)
    const second = await handleRequest(markdownRequest(), cfg)

    expect(second?.status).toBe(429)
    expect(second?.headers.get('retry-after')).not.toBeNull()
    expect(events).toHaveLength(2)
    expect(events[1]?.response.path).toBe('denied')
  })
})

describe('what a policy cannot reach', () => {
  it('serves a browser under a deny-all policy', async () => {
    const { config: cfg } = config({
      access: { default: 'deny', rules: [{ subject: '*', action: 'deny' }] },
    })
    // null = "serve your normal HTML", which is what a human must always get.
    await expect(handleRequest(browserRequest(), cfg)).resolves.toBeNull()
  })

  it('serves Googlebot under a deny-all policy', async () => {
    // consistent source content. An access policy that can deindex the merchant's site is one
    // that eventually will, and no merchant means that when they tick a box.
    const { config: cfg } = config({
      access: { default: 'deny', rules: [{ subject: '*', action: 'deny' }] },
    })
    await expect(handleRequest(googlebotRequest(), cfg)).resolves.toBeNull()
  })
})

describe('when no policy is configured', () => {
  it('behaves exactly as it did before the field existed', async () => {
    const { config: cfg, events, documentResolver } = config()
    const response = await handleRequest(markdownRequest(), cfg)

    expect(response?.headers.get('content-type')).toContain('text/markdown')
    expect(documentResolver).toHaveBeenCalled()
    expect(events[0]?.response.path).toBe('markdown')
  })

  it('serves an agent under an allow policy, unchanged', async () => {
    const { config: cfg, events } = config({
      access: { rules: [{ subject: '*', action: 'allow' }] },
    })
    const response = await handleRequest(markdownRequest(), cfg)
    expect(response?.headers.get('content-type')).toContain('text/markdown')
    expect(events[0]?.response.path).toBe('markdown')
  })
})

describe('the rate-limit budget is per gateway, not per process', () => {
  it('does not let one config throttle another', async () => {
    // A process can host more than one gateway — a monorepo dev server, a
    // multi-tenant host — and one tenant's traffic must not spend another's
    // budget. That is why the runtime is keyed on the config object.
    const limit = { requests: 1, windowSeconds: 60 }
    const a = config({ access: { rules: [{ subject: '*', action: 'limit', limit }] } })
    const b = config({ access: { rules: [{ subject: '*', action: 'limit', limit }] } })

    expect((await handleRequest(markdownRequest(), a.config))?.status).not.toBe(429)
    expect((await handleRequest(markdownRequest(), a.config))?.status).toBe(429)
    // b's budget is untouched.
    expect((await handleRequest(markdownRequest(), b.config))?.status).not.toBe(429)
  })

  it('follows the policy OBJECT: one policy shared across configs is one budget', async () => {
    // The runtime is keyed on `config.access`, not the config wrapper — a
    // multi-tenant host builds a fresh config per request and must still get
    // one limiter per tenant, or a `limit` rule never fires. Reusing the same
    // policy object is the opt-in; the distinct-literals test above still
    // holds because distinct objects stay distinct budgets.
    const shared = {
      rules: [
        {
          subject: '*' as const,
          action: 'limit' as const,
          limit: { requests: 1, windowSeconds: 60 },
        },
      ],
    }
    const a = config({ access: shared })
    const b = config({ access: shared })
    expect((await handleRequest(markdownRequest(), a.config))?.status).not.toBe(429)
    expect((await handleRequest(markdownRequest(), b.config))?.status).toBe(429)
  })

  it('keeps counting across requests to the same config', async () => {
    const { config: cfg } = config({
      access: {
        rules: [{ subject: '*', action: 'limit', limit: { requests: 2, windowSeconds: 60 } }],
      },
    })
    expect((await handleRequest(markdownRequest(), cfg))?.status).not.toBe(429)
    expect((await handleRequest(markdownRequest(), cfg))?.status).not.toBe(429)
    expect((await handleRequest(markdownRequest(), cfg))?.status).toBe(429)
  })
})

describe('a policy naming a platform, without verification wired', () => {
  it('is not enforced — and the request is served', async () => {
    // The rule was rejected at compile time because `verification` is unset, so
    // the default (allow) applies. A deny anyone can walk past by editing a
    // header would read as a control in the Console and not be one.
    const { config: cfg } = config({
      access: { rules: [{ subject: 'chatgpt', action: 'deny' }] },
    })
    const response = await handleRequest(
      new Request('https://shop.example.com/products/x', {
        headers: { accept: 'text/markdown', 'user-agent': 'ChatGPT-User/1.0' },
      }),
      cfg,
    )
    expect(response?.status).not.toBe(403)
  })
})
