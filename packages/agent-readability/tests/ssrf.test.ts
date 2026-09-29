/**
 * ssrf.test.ts — the guard, from both sides.
 *
 * The accept/reject table below is a superset of the Console preview's own
 * table, deliberately: the Console preview shipped that table, this package now
 * owns the policy, and a case the Console covered must not quietly stop being
 * covered.
 *
 * The DNS half is the part that matters. `guardUrl` alone is the guard we
 * REPLACED — it rejects IP literals and would happily approve
 * `https://attacker.example/` whose A record is `169.254.169.254`. The tests
 * that prove the fix are the `resolveAndValidate` ones and the pinned-transport
 * one, which shows a connection reaching an address that was never resolved from
 * the hostname it sends in `Host`.
 */

import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'

import {
  ALLOW_PRIVATE_HOSTS,
  classifyIp,
  createPinnedTransport,
  guardPreviewUrl,
  guardUrl,
  parseIpv6,
  resolveAndValidate,
  type HostResolver,
  type PinnedAddress,
} from '../src/probe/ssrf'

const PUBLIC_ONLY = { allowHttp: false, hostPolicy: 'public-only' } as const

function resolverFor(addresses: readonly PinnedAddress[]): HostResolver {
  return { resolve: () => Promise.resolve(addresses) }
}

describe('guardPreviewUrl — accept table', () => {
  it.each([
    'https://shop.example.com/products/x',
    'https://shop.example.com',
    'https://shop.example.com:443/checkout',
    'https://sub.deep.shop.example.co.uk/a?b=c',
    'https://8.8.8.8/',
  ])('accepts %s', (url) => {
    expect(guardPreviewUrl(url).ok).toBe(true)
  })

  it('normalises the accepted URL', () => {
    const result = guardPreviewUrl('  https://Shop.Example.com/Products ')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.url.hostname).toBe('shop.example.com')
  })
})

describe('guardPreviewUrl — reject table (the shipped Console cases)', () => {
  it.each([
    ['not-a-url', /valid URL/],
    ['http://shop.example.com/', /https/],
    ['ftp://shop.example.com/', /https/],
    ['file:///etc/passwd', /https/],
    ['https://shop.example.com:8443/', /port/i],
    ['https://shop.example.com:80/', /port/i],
    ['https://user:pass@shop.example.com/', /credentials/],
    ['https://localhost/', /localhost/],
    ['https://LOCALHOST/', /localhost/],
    ['https://foo.localhost/', /localhost/],
    ['https://127.0.0.1/', /Private or reserved/],
    ['https://10.0.0.1/', /Private or reserved/],
    ['https://172.16.0.1/', /Private or reserved/],
    ['https://192.168.1.1/', /Private or reserved/],
    ['https://169.254.169.254/', /Private or reserved/],
    ['https://0.0.0.0/', /Private or reserved/],
    ['https://[::1]/', /IPv6/],
    ['https://[fe80::1]/', /IPv6/],
    ['https://[fd00::2]/', /IPv6/],
  ])('rejects %s', (url, reason) => {
    const result = guardPreviewUrl(url)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(reason)
  })

  it('rejects decimal-encoded loopback (WHATWG URL normalises it to 127.0.0.1)', () => {
    expect(guardPreviewUrl('https://2130706433/').ok).toBe(false)
  })

  it('still accepts the boundary neighbours of 172.16/12', () => {
    expect(guardPreviewUrl('https://172.15.0.1/').ok).toBe(true)
    expect(guardPreviewUrl('https://172.32.0.1/').ok).toBe(true)
  })
})

describe('guardUrl — the §5.2 expansion', () => {
  it.each([
    ['https://100.64.0.1/', 'carrier-grade NAT'],
    ['https://100.100.100.200/', 'carrier-grade NAT'], // Alibaba cloud metadata
    ['https://100.127.255.255/', 'carrier-grade NAT'],
    ['https://192.0.0.1/', 'IETF protocol'],
    ['https://198.18.0.1/', 'benchmarking'],
    ['https://198.19.255.255/', 'benchmarking'],
    ['https://224.0.0.1/', 'multicast'],
    ['https://239.255.255.250/', 'multicast'],
    ['https://240.0.0.1/', 'reserved'],
    ['https://255.255.255.255/', 'reserved'],
  ])('rejects %s', (url, label) => {
    const result = guardUrl(url, PUBLIC_ONLY)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(label)
  })

  it('does not over-reach into the public neighbours of the new ranges', () => {
    expect(guardUrl('https://100.63.255.255/', PUBLIC_ONLY).ok).toBe(true)
    expect(guardUrl('https://100.128.0.1/', PUBLIC_ONLY).ok).toBe(true)
    expect(guardUrl('https://192.0.1.1/', PUBLIC_ONLY).ok).toBe(true)
    expect(guardUrl('https://198.17.255.255/', PUBLIC_ONLY).ok).toBe(true)
    expect(guardUrl('https://223.255.255.255/', PUBLIC_ONLY).ok).toBe(true)
  })

  it.each([
    ['https://printer.local/', /Internal hostnames/],
    ['https://db.internal/', /Internal hostnames/],
    ['https://metadata.google.internal/', /Internal hostnames/],
    ['https://intranet/', /Single-label/],
    ['https://wiki./', /Single-label/],
  ])('rejects the internal name %s', (url, reason) => {
    const result = guardUrl(url, PUBLIC_ONLY)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(reason)
  })

  it('strips the DNS root dot before the suffix checks', () => {
    // `169.254.169.254.` and `db.internal.` resolve identically to the undotted
    // forms; without normalisation they walk straight past both checks.
    expect(guardUrl('https://169.254.169.254./', PUBLIC_ONLY).ok).toBe(false)
    expect(guardUrl('https://db.internal./', PUBLIC_ONLY).ok).toBe(false)
  })

  it('allows http, private hosts and odd ports ONLY under the local capability', () => {
    const local = { allowHttp: true, hostPolicy: ALLOW_PRIVATE_HOSTS } as const
    expect(guardUrl('http://localhost:3000/', local).ok).toBe(true)
    expect(guardUrl('http://127.0.0.1:8080/', local).ok).toBe(true)
    expect(guardUrl('http://staging.internal.corp/', local).ok).toBe(true)
    // …and the same URLs stay rejected under the policy every hosted path uses.
    expect(guardUrl('http://localhost:3000/', PUBLIC_ONLY).ok).toBe(false)
    expect(guardUrl('http://127.0.0.1:8080/', PUBLIC_ONLY).ok).toBe(false)
  })

  it('rejects a protocol that is neither http nor https even in local mode', () => {
    const local = { allowHttp: true, hostPolicy: ALLOW_PRIVATE_HOSTS } as const
    expect(guardUrl('file:///etc/passwd', local).ok).toBe(false)
    expect(guardUrl('gopher://localhost/', local).ok).toBe(false)
  })
})

describe('classifyIp — IPv6, including the v4-inside-v6 forms', () => {
  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fd00::2', 'unique local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['100::1', 'discard-only'],
    ['::ffff:169.254.169.254', 'IPv4-mapped'], // the AWS metadata address in v6 clothing
    ['::ffff:10.0.0.5', 'IPv4-mapped'],
    ['::127.0.0.1', 'IPv4-compatible'],
    ['64:ff9b::10.0.0.5', 'NAT64'],
    ['2002:0a00:0001::', '6to4'],
  ])('treats %s as reserved', (address, label) => {
    const classification = classifyIp(address)
    expect(classification.family).toBe(6)
    expect(classification.reserved).toBe(true)
    expect(classification.label).toContain(label)
  })

  it('does not treat every IPv6 address as reserved', () => {
    expect(classifyIp('2606:4700:4700::1111').reserved).toBe(false)
    expect(classifyIp('::ffff:8.8.8.8').reserved).toBe(false)
    expect(classifyIp('64:ff9b::8.8.8.8').reserved).toBe(false)
  })

  it('fails closed on an IP-shaped string it cannot parse', () => {
    expect(classifyIp('fe80::1::2').reserved).toBe(true)
    expect(classifyIp('1.2.3').reserved).toBe(true)
    expect(classifyIp('999.1.1.1').reserved).toBe(true)
  })

  it('reports a hostname as not-an-IP rather than guessing', () => {
    expect(classifyIp('shop.example.com').family).toBeNull()
    expect(classifyIp('shop.example.com').reserved).toBe(false)
  })

  it('expands :: in every position', () => {
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(parseIpv6('2001:db8::1')).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1])
    expect(parseIpv6('2001:db8:0:0:0:0:0:1')).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1])
    expect(parseIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304])
    expect(parseIpv6('1:2:3:4:5:6:7')).toBeNull()
  })
})

describe('resolveAndValidate — the hole the parse-only guard left open', () => {
  it('REJECTS a public hostname whose A record is cloud metadata', async () => {
    // This is the exact case `guardUrl` cannot see: syntactically perfect,
    // publicly registered, and pointing at 169.254.169.254.
    expect(guardUrl('https://attacker.example/', PUBLIC_ONLY).ok).toBe(true)

    const outcome = await resolveAndValidate(
      'attacker.example',
      resolverFor([{ address: '169.254.169.254', family: 4 }]),
      'public-only',
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.kind).toBe('policy-rejected')
      expect(outcome.reason).toContain('169.254.169.254')
    }
  })

  it('rejects when ANY answer is reserved, not merely when the first one is', async () => {
    const outcome = await resolveAndValidate(
      'split.example',
      resolverFor([
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]),
      'public-only',
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('10.0.0.5')
  })

  it('rejects a reserved AAAA answer', async () => {
    const outcome = await resolveAndValidate(
      'v6.example',
      resolverFor([{ address: '::ffff:127.0.0.1', family: 6 }]),
      'public-only',
    )
    expect(outcome.ok).toBe(false)
  })

  it('accepts and returns every address when they are all public', async () => {
    const addresses: PinnedAddress[] = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]
    const outcome = await resolveAndValidate('example.com', resolverFor(addresses), 'public-only')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.addresses).toEqual(addresses)
  })

  it('reports a DNS failure as unreachable, not as a policy rejection', async () => {
    const failing: HostResolver = { resolve: () => Promise.reject(new Error('ENOTFOUND')) }
    const outcome = await resolveAndValidate('nope.example', failing, 'public-only')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.kind).toBe('unreachable')
  })

  it('treats an empty answer as unreachable', async () => {
    const outcome = await resolveAndValidate('void.example', resolverFor([]), 'public-only')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.kind).toBe('unreachable')
  })

  it('never consults the resolver for an IP literal', async () => {
    let called = 0
    const counting: HostResolver = {
      resolve: () => {
        called += 1
        return Promise.resolve([])
      },
    }
    const outcome = await resolveAndValidate('8.8.8.8', counting, 'public-only')
    expect(called).toBe(0)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.addresses).toEqual([{ address: '8.8.8.8', family: 4 }])
  })

  it('lets the local capability through — and only the local capability', async () => {
    const metadata = resolverFor([{ address: '169.254.169.254', family: 4 }])
    expect((await resolveAndValidate('x.example', metadata, ALLOW_PRIVATE_HOSTS)).ok).toBe(true)
    expect((await resolveAndValidate('x.example', metadata, 'public-only')).ok).toBe(false)
  })
})

describe('createPinnedTransport — connects to the validated address, not to DNS', () => {
  const servers: http.Server[] = []

  afterAll(async () => {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    )
  })

  async function listen(handler: http.RequestListener): Promise<number> {
    const server = http.createServer(handler)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as AddressInfo).port
  }

  it('sends the hostname in Host while the socket goes to the pinned IP', async () => {
    let seenHost: string | undefined
    let seenAccept: string | undefined
    const port = await listen((request, response) => {
      seenHost = request.headers.host
      seenAccept = request.headers.accept
      response.writeHead(200, {
        'content-type': 'text/plain',
        link: '<https://a/>; rel="alternate"',
      })
      response.end('pinned-ok')
    })

    // `pinned.example` does not exist in DNS. If the transport resolved the
    // hostname itself this call could not connect at all — which is the point.
    const response = await createPinnedTransport()(`http://pinned.example:${port}/probe`, {
      headers: { accept: 'text/markdown', 'user-agent': 'rebilder-ars/0.1' },
      redirect: 'manual',
      signal: AbortSignal.timeout(4_000),
      pinnedAddresses: [{ address: '127.0.0.1', family: 4 }],
    })

    expect(response.status).toBe(200)
    expect(seenHost).toBe(`pinned.example:${port}`)
    expect(seenAccept).toBe('text/markdown')
    expect(response.headers['link']).toEqual(['<https://a/>; rel="alternate"'])

    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const chunk = await reader?.read()
    expect(new TextDecoder().decode(chunk?.value)).toBe('pinned-ok')
    await reader?.cancel()
  })

  it('keeps repeated headers apart instead of joining them', async () => {
    const port = await listen((_request, response) => {
      response.setHeader('Link', [
        '<https://a/>; rel="alternate"',
        '<https://b/>; rel="describedby"',
      ])
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html></html>')
    })

    const response = await createPinnedTransport()(`http://multi.example:${port}/`, {
      headers: { accept: 'text/html', 'user-agent': 'rebilder-ars/0.1' },
      redirect: 'manual',
      signal: AbortSignal.timeout(4_000),
      pinnedAddresses: [{ address: '127.0.0.1', family: 4 }],
    })

    expect(response.headers['link']).toEqual([
      '<https://a/>; rel="alternate"',
      '<https://b/>; rel="describedby"',
    ])
    await response.body?.cancel()
  })

  it('does not follow redirects itself — every hop is our decision', async () => {
    const port = await listen((_request, response) => {
      response.writeHead(302, { location: 'https://elsewhere.example/' })
      response.end()
    })

    const response = await createPinnedTransport()(`http://hop.example:${port}/`, {
      headers: { accept: 'text/html', 'user-agent': 'rebilder-ars/0.1' },
      redirect: 'manual',
      signal: AbortSignal.timeout(4_000),
      pinnedAddresses: [{ address: '127.0.0.1', family: 4 }],
    })

    expect(response.status).toBe(302)
    expect(response.headers['location']).toEqual(['https://elsewhere.example/'])
    await response.body?.cancel()
  })

  it('fails rather than falling back to DNS when the pin list is empty', async () => {
    await expect(
      createPinnedTransport()('http://example.com/', {
        headers: { accept: 'text/html', 'user-agent': 'rebilder-ars/0.1' },
        redirect: 'manual',
        signal: AbortSignal.timeout(2_000),
        pinnedAddresses: [],
      }),
    ).rejects.toThrow(/no pinned address/)
  })
})
