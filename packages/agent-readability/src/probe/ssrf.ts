/**
 * probe/ssrf.ts — the network-side host policy for `@rebilder/agent-readability`.
 *
 * WHAT CHANGED, AND WHY IT HAD TO. The ancestor of this file (the Console
 * preview's URL guard) described itself as *"Pure parse +
 * reject (no DNS resolution in v1)"*. That sentence is deliberately not repeated
 * here, because it is a description of a hole. A parse-only guard rejects IP
 * literals; it does not reject `https://attacker.example/` whose A record is
 * `169.254.169.254`, `10.0.0.5` or `127.0.0.1`, and DNS rebinding beats it by
 * construction — resolve public, pass the guard, resolve private, connect.
 * Behind a Console login that was defensible. On a public endpoint it is not,
 * and this module is the one the public scanner, the CLI and the MCP server all
 * go through. So (design §5.2):
 *
 *   1. WE RESOLVE THE HOSTNAME OURSELVES and reject if **any** returned A/AAAA
 *      is private or reserved. Not "the first one" — a hostname with one public
 *      and one private answer is an attack, not a multi-homed service.
 *   2. WE CONNECT PINNED TO THE VALIDATED IP, with `Host` and SNI still carrying
 *      the hostname. This closes the rebinding window: the address the guard
 *      approved is the address the socket uses, because the resolver the socket
 *      would have called is replaced by a function that returns the approved set
 *      and nothing else.
 *   3. EVERY REDIRECT HOP RE-RESOLVES AND RE-PINS. Re-parsing the `Location`
 *      URL is not enough; hop 2 is a fresh connection to a fresh name.
 *   4. THE RESERVED SET IS THE FULL ONE — CGNAT (`100.64/10`, which is also
 *      where Alibaba keeps its metadata service at `100.100.100.200`), IETF
 *      protocol assignments, benchmarking, multicast, the whole of `240/4`,
 *      the broadcast address, and the IPv6 equivalents including IPv4-mapped
 *      and NAT64/6to4 forms, where a reserved v4 address hides inside a v6 one.
 *
 * WHAT THIS MODULE STILL CANNOT DO. It cannot stop a target whose *public* IP
 * fronts an internal service (a cloud load balancer with a private backend), and
 * it cannot stop a captive network from answering for someone else. Design §5.2
 * requires the belt to the braces: scanner egress runs on a network with no route
 * to cloud metadata or any internal subnet. This file assumes that and does not
 * replace it.
 *
 * NOT AN ENTRY POINT. `package.json#exports` publishes `.`, `./probe` and
 * `./probe/local` only, so `ALLOW_PRIVATE_HOSTS` below is unreachable from
 * outside the package at runtime, and the package-graph check fails any deep
 * import that tries. That is what makes the symbol an unforgeable capability
 * rather than a naming convention.
 */

import { promises as dnsPromises } from 'node:dns'
import * as http from 'node:http'
import * as https from 'node:https'
import type { LookupFunction } from 'node:net'

/* ── the host policy capability ───────────────────────────────────────────── */

/**
 * The capability that unlocks private/loopback targets. Held by `./probe/local`
 * and by nothing else.
 *
 * WHY A SYMBOL AND NOT A BOOLEAN. `ProbePolicy` (see `./index`) has no
 * `allowPrivateHosts` field on purpose. A boolean on a shared config object will
 * eventually be passed as `true` by a hosted endpoint — not maliciously, just by
 * someone wiring a new route who copies a working config. The concrete failure:
 * an MCP server on a developer's machine, driven by a model whose context
 * contains untrusted web text, asked to "check http://169.254.169.254/". A symbol
 * that only a separate, import-time-gated entry point can obtain cannot be turned
 * on by a config file, an env var, or a copied object literal.
 */
export const ALLOW_PRIVATE_HOSTS: unique symbol = Symbol('rebilder.ars.probe.allow-private-hosts')

/** `'public-only'` everywhere except the `./probe/local` entry point. */
export type HostPolicy = 'public-only' | typeof ALLOW_PRIVATE_HOSTS

export const allowsPrivateHosts = (policy: HostPolicy): boolean => policy === ALLOW_PRIVATE_HOSTS

/* ── IP classification ────────────────────────────────────────────────────── */

export interface IpClassification {
  /** `null` when the text is not an IP literal at all (i.e. it is a hostname). */
  readonly family: 4 | 6 | null
  /** True for anything that is not a globally routable unicast address. */
  readonly reserved: boolean
  /** Human-readable reason, printed in guard messages and probe details. */
  readonly label: string
}

const NOT_AN_IP: IpClassification = { family: null, reserved: false, label: 'hostname' }

const IPV4_OCTET = /^(?:0|[1-9]\d{0,2})$/

/** Strict dotted-quad. Leading zeros are rejected: `010.0.0.1` is ambiguous octal. */
export function parseIpv4(text: string): [number, number, number, number] | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!IPV4_OCTET.test(part)) return null
    const value = Number(part)
    if (!Number.isInteger(value) || value > 255) return null
    octets.push(value)
  }
  const [a, b, c, d] = octets
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null
  return [a, b, c, d]
}

/**
 * IPv4 reserved ranges. The first six shipped in the Console guard; the rest are
 * the §5.2 expansion. `255.255.255.255` is inside `240/4` and is listed anyway
 * because the design lists it and a reader should not have to do the arithmetic.
 */
function classifyIpv4Octets(octets: readonly [number, number, number, number]): IpClassification {
  const [a, b] = octets
  const v4 = (label: string, reserved: boolean): IpClassification => ({
    family: 4,
    reserved,
    label,
  })

  if (a === 0) return v4('this-network (0.0.0.0/8)', true)
  if (a === 10) return v4('private (10.0.0.0/8)', true)
  if (a === 100 && b >= 64 && b <= 127) return v4('carrier-grade NAT (100.64.0.0/10)', true)
  if (a === 127) return v4('loopback (127.0.0.0/8)', true)
  if (a === 169 && b === 254) return v4('link-local / cloud metadata (169.254.0.0/16)', true)
  if (a === 172 && b >= 16 && b <= 31) return v4('private (172.16.0.0/12)', true)
  if (a === 192 && b === 0 && octets[2] === 0)
    return v4('IETF protocol assignments (192.0.0.0/24)', true)
  if (a === 192 && b === 168) return v4('private (192.168.0.0/16)', true)
  if (a === 198 && (b === 18 || b === 19)) return v4('benchmarking (198.18.0.0/15)', true)
  if (a >= 224 && a <= 239) return v4('multicast (224.0.0.0/4)', true)
  if (a >= 240) return v4('reserved / broadcast (240.0.0.0/4)', true)
  return v4('public', false)
}

/**
 * IPv6 to eight 16-bit groups. Handles `::` compression, a zone id, and the
 * trailing-IPv4 forms (`::ffff:169.254.169.254`, `64:ff9b::10.0.0.5`) that are
 * the whole reason IPv6 belongs in an SSRF guard at all.
 */
export function parseIpv6(input: string): number[] | null {
  let text = input.trim()
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  if (text.length === 0 || !text.includes(':')) return null

  // A trailing dotted quad is the last two groups. Rewriting it as hex up front
  // means the rest of the parser only ever sees hex groups and `::` — the
  // alternative (splicing groups back on afterwards) is where the separator
  // colon gets miscounted and `64:ff9b::10.0.0.5` silently fails to parse.
  const lastColon = text.lastIndexOf(':')
  const maybeV4 = text.slice(lastColon + 1)
  if (maybeV4.includes('.')) {
    const quad = parseIpv4(maybeV4)
    if (quad === null) return null
    const hi = ((quad[0] << 8) | quad[1]).toString(16)
    const lo = ((quad[2] << 8) | quad[3]).toString(16)
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`
  }

  const doubleColon = text.indexOf('::')
  if (doubleColon !== text.lastIndexOf('::')) return null

  const toGroups = (segment: string): number[] | null => {
    if (segment.length === 0) return []
    const out: number[] = []
    for (const piece of segment.split(':')) {
      if (piece.length === 0 || piece.length > 4 || !/^[0-9a-fA-F]+$/.test(piece)) return null
      out.push(Number.parseInt(piece, 16))
    }
    return out
  }

  if (doubleColon === -1) {
    const only = toGroups(text)
    return only !== null && only.length === 8 ? only : null
  }
  const head = toGroups(text.slice(0, doubleColon))
  const rest = toGroups(text.slice(doubleColon + 2))
  if (head === null || rest === null) return null
  const explicit = head.length + rest.length
  if (explicit > 7) return null
  const zeros = new Array<number>(8 - explicit).fill(0)
  return [...head, ...zeros, ...rest]
}

function classifyIpv6Groups(groups: readonly number[]): IpClassification {
  const v6 = (label: string, reserved: boolean): IpClassification => ({
    family: 6,
    reserved,
    label,
  })
  const g = (index: number): number => groups[index] ?? 0
  const embeddedV4 = (hi: number, lo: number): [number, number, number, number] => [
    (hi >> 8) & 0xff,
    hi & 0xff,
    (lo >> 8) & 0xff,
    lo & 0xff,
  ]

  const allZeroThrough = (upTo: number): boolean => groups.slice(0, upTo).every((x) => x === 0)

  if (groups.every((x) => x === 0)) return v6('unspecified (::)', true)
  if (allZeroThrough(7) && g(7) === 1) return v6('loopback (::1)', true)

  // IPv4-mapped ::ffff:a.b.c.d and the deprecated IPv4-compatible ::a.b.c.d.
  if (allZeroThrough(5) && g(5) === 0xffff) {
    const inner = classifyIpv4Octets(embeddedV4(g(6), g(7)))
    return v6(`IPv4-mapped → ${inner.label}`, inner.reserved)
  }
  if (allZeroThrough(6)) {
    // IPv4-compatible ::a.b.c.d is deprecated (RFC 4291 §2.5.5.1) and reserved
    // regardless of what the embedded address would be on its own.
    const inner = classifyIpv4Octets(embeddedV4(g(6), g(7)))
    return v6(`IPv4-compatible → ${inner.label}`, true)
  }
  // NAT64 well-known prefix 64:ff9b::/96 — the v4 address rides in the last 32 bits.
  if (g(0) === 0x0064 && g(1) === 0xff9b && g(2) === 0 && g(3) === 0 && g(4) === 0 && g(5) === 0) {
    const inner = classifyIpv4Octets(embeddedV4(g(6), g(7)))
    return v6(`NAT64 64:ff9b::/96 → ${inner.label}`, inner.reserved)
  }
  // 6to4 2002::/16 — the v4 address rides in groups 1 and 2.
  if (g(0) === 0x2002) {
    const inner = classifyIpv4Octets(embeddedV4(g(1), g(2)))
    return v6(`6to4 2002::/16 → ${inner.label}`, inner.reserved)
  }
  if (g(0) === 0x0100 && g(1) === 0 && g(2) === 0 && g(3) === 0)
    return v6('discard-only (100::/64)', true)
  if (g(0) === 0x2001 && g(1) === 0x0db8) return v6('documentation (2001:db8::/32)', true)
  if ((g(0) & 0xfe00) === 0xfc00) return v6('unique local (fc00::/7)', true)
  if ((g(0) & 0xffc0) === 0xfe80) return v6('link-local (fe80::/10)', true)
  if ((g(0) & 0xff00) === 0xff00) return v6('multicast (ff00::/8)', true)
  return v6('public', false)
}

/**
 * Classifies an IP literal. `family: null` means the text is not an IP at all.
 * Fails closed: anything that looks like an IP but does not parse is reserved.
 */
export function classifyIp(text: string): IpClassification {
  const trimmed = text.trim()
  const bare = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed

  const quad = parseIpv4(bare)
  if (quad !== null) return classifyIpv4Octets(quad)

  if (bare.includes(':')) {
    const groups = parseIpv6(bare)
    if (groups === null) return { family: 6, reserved: true, label: 'unparseable IPv6 literal' }
    return classifyIpv6Groups(groups)
  }
  // Looks numeric but is not a valid dotted quad — treat as unusable, not as a name.
  if (/^[0-9.]+$/.test(bare))
    return { family: 4, reserved: true, label: 'unparseable IPv4 literal' }
  return NOT_AN_IP
}

/* ── URL syntax guard ─────────────────────────────────────────────────────── */

export type UrlGuardResult = { ok: true; url: URL } | { ok: false; reason: string }

export interface UrlGuardPolicy {
  /** `false` in every hosted path. `true` only under `./probe/local`. */
  readonly allowHttp: boolean
  readonly hostPolicy: HostPolicy
}

/** Hostname suffixes that never name a public host. */
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal'] as const

/**
 * Parse + reject, with no I/O. This is the FIRST of two gates, not the only one:
 * `resolveAndValidate` is the second and is the one that closes the DNS hole.
 * Splitting them keeps the syntactic policy testable without a resolver and keeps
 * the resolver from being the place a reviewer has to look for "is http allowed".
 */
export function guardUrl(input: string, policy: UrlGuardPolicy): UrlGuardResult {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return { ok: false, reason: 'That does not look like a valid URL.' }
  }

  const httpsOnly = !policy.allowHttp
  if (httpsOnly && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only https:// URLs can be fetched.' }
  }
  if (!httpsOnly && url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'Only https:// and http:// URLs can be fetched.' }
  }
  const defaultPort = url.protocol === 'https:' ? '443' : '80'
  if (url.port !== '' && url.port !== defaultPort && !allowsPrivateHosts(policy.hostPolicy)) {
    return {
      ok: false,
      reason: `Non-standard ports cannot be fetched (${url.protocol}// on ${defaultPort} only).`,
    }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'URLs with embedded credentials cannot be fetched.' }
  }

  let hostname = url.hostname.toLowerCase()
  // A trailing dot is the DNS root and resolves identically; strip it so that
  // `169.254.169.254.` and `internal.` cannot walk past the suffix checks.
  if (hostname.endsWith('.') && hostname.length > 1) hostname = hostname.slice(0, -1)

  const permissive = allowsPrivateHosts(policy.hostPolicy)

  if (!permissive && (hostname === 'localhost' || hostname.endsWith('.localhost'))) {
    return { ok: false, reason: 'localhost cannot be fetched.' }
  }

  const classification = classifyIp(hostname)
  if (classification.family === 6) {
    // IPv6 literals in a submitted URL stay rejected even when they are public:
    // a store lives on a name, and the useful IPv6 case (an AAAA record) is
    // handled — and classified in full — by `resolveAndValidate`.
    if (!permissive) {
      return { ok: false, reason: 'IPv6 literal addresses cannot be fetched — use a hostname.' }
    }
  }
  if (classification.family !== null && classification.reserved && !permissive) {
    return {
      ok: false,
      reason: `Private or reserved IP addresses cannot be fetched (${classification.label}).`,
    }
  }
  if (classification.family === null && !permissive) {
    if (PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
      return {
        ok: false,
        reason: 'Internal hostnames (.local, .internal, .localhost) cannot be fetched.',
      }
    }
    if (!hostname.includes('.')) {
      return {
        ok: false,
        reason: 'Single-label hostnames cannot be fetched — they resolve on the local network.',
      }
    }
  }

  return { ok: true, url }
}

/**
 * The strict public policy, and the name the Console preview has always used.
 * Kept as a named export because the Console preview and its shipped tests are
 * written against it.
 */
export function guardPreviewUrl(input: string): UrlGuardResult {
  return guardUrl(input, { allowHttp: false, hostPolicy: 'public-only' })
}

/* ── DNS resolution + validation ──────────────────────────────────────────── */

export interface PinnedAddress {
  readonly address: string
  readonly family: 4 | 6
}

export interface HostResolver {
  resolve(hostname: string): Promise<readonly PinnedAddress[]>
}

export type ResolveOutcome =
  | { ok: true; addresses: readonly PinnedAddress[] }
  | { ok: false; kind: 'unreachable' | 'policy-rejected'; reason: string }

/** Real DNS. The only resolver a hosted path ever uses. */
export function createDnsResolver(): HostResolver {
  return {
    async resolve(hostname: string): Promise<readonly PinnedAddress[]> {
      const records = await dnsPromises.lookup(hostname, { all: true, verbatim: true })
      return records.map((record) => ({
        address: record.address,
        family: record.family === 6 ? 6 : 4,
      }))
    },
  }
}

/**
 * Resolves and validates. Rejects if ANY answer is reserved — not "if the first
 * one is". A name that answers with one public and one private address is the
 * shape of the attack, and picking the public one and connecting anyway is how
 * a guard that looks correct fails.
 */
export async function resolveAndValidate(
  hostname: string,
  resolver: HostResolver,
  hostPolicy: HostPolicy,
): Promise<ResolveOutcome> {
  // An IP literal needs no resolution; it was already classified by `guardUrl`.
  const literal = classifyIp(hostname)
  if (literal.family !== null) {
    if (literal.reserved && !allowsPrivateHosts(hostPolicy)) {
      return {
        ok: false,
        kind: 'policy-rejected',
        reason: `target is a reserved address (${literal.label})`,
      }
    }
    return {
      ok: true,
      addresses: [{ address: hostname.replace(/^\[|\]$/g, ''), family: literal.family }],
    }
  }

  let addresses: readonly PinnedAddress[]
  try {
    addresses = await resolver.resolve(hostname)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      kind: 'unreachable',
      reason: `DNS lookup failed for ${hostname}: ${detail}`,
    }
  }
  if (addresses.length === 0) {
    return { ok: false, kind: 'unreachable', reason: `DNS returned no addresses for ${hostname}` }
  }
  if (allowsPrivateHosts(hostPolicy)) return { ok: true, addresses }

  for (const record of addresses) {
    const classification = classifyIp(record.address)
    if (classification.family === null) {
      return {
        ok: false,
        kind: 'policy-rejected',
        reason: `DNS returned an unparseable address (${record.address})`,
      }
    }
    if (classification.reserved) {
      return {
        ok: false,
        kind: 'policy-rejected',
        reason: `${hostname} resolves to a private or reserved address (${record.address}: ${classification.label})`,
      }
    }
  }
  return { ok: true, addresses }
}

/* ── the transport ────────────────────────────────────────────────────────── */

export interface ProbeRequestInit {
  readonly headers: Readonly<Record<string, string>>
  /** Always `'manual'`: hops are our decision, because each one must re-resolve. */
  readonly redirect: 'manual'
  readonly signal: AbortSignal
  /**
   * The addresses `resolveAndValidate` approved for this exact URL's hostname.
   * The transport MUST connect to one of these and MUST NOT consult a resolver
   * of its own; that is the whole anti-rebinding mechanism.
   */
  readonly pinnedAddresses: readonly PinnedAddress[]
}

/**
 * A response, reduced to the three things ARS evidence needs.
 *
 * `headers` is `name → all values`, not `name → value`. `Link` is routinely sent
 * more than once and is scored twice over (D2.2 declared alternates, D6.5
 * machine endpoints); a transport that joins them is losing scored evidence.
 */
export interface ProbeHttpResponse {
  readonly status: number
  readonly headers: Record<string, string[]>
  readonly body: ReadableStream<Uint8Array> | null
}

export type ProbeTransport = (url: string, init: ProbeRequestInit) => Promise<ProbeHttpResponse>

/** Adapts a WHATWG `Response` — the shape tests and fixtures find easiest to build. */
export function fromWebResponse(response: Response): ProbeHttpResponse {
  const headers: Record<string, string[]> = {}
  response.headers.forEach((value, name) => {
    const key = name.toLowerCase()
    if (key === 'set-cookie') return
    const existing = headers[key]
    if (existing) existing.push(value)
    else headers[key] = [value]
  })
  const setCookie =
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  if (setCookie.length > 0) headers['set-cookie'] = [...setCookie]
  return { status: response.status, headers, body: response.body }
}

/** Returns the pinned addresses and refuses to look anything up. */
function pinnedLookup(addresses: readonly PinnedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (addresses.length === 0) {
      callback(new Error('rebilder-ars: no pinned address for this connection'), '', 4)
      return
    }
    // Node ≥20 enables `autoSelectFamily`, which calls `lookup` with `all: true`.
    if (typeof options === 'object' && options !== null && options.all === true) {
      callback(
        null,
        addresses.map((record) => ({ address: record.address, family: record.family })),
      )
      return
    }
    const first = addresses[0]
    if (first === undefined) {
      callback(new Error('rebilder-ars: no pinned address for this connection'), '', 4)
      return
    }
    callback(null, first.address, first.family)
  }
}

/**
 * The production transport: `node:https`/`node:http` with a `lookup` that can
 * only return the validated addresses.
 *
 * WHY NOT `fetch` + an undici `Agent`. Design §5.2 names undici's `Agent` with a
 * custom `lookup`, which is the same mechanism; `undici` is not reachable as a
 * built-in module and this package's contract is zero runtime dependencies, so
 * the identical property is obtained from `node:https`, whose options flow
 * through to `net.connect`. `servername` keeps SNI on the hostname and Node's
 * default `setHost` keeps the `Host` header on the hostname, so the origin sees
 * a normal request and only the socket's destination is fixed.
 *
 * No `Accept-Encoding` is sent, so nothing arrives compressed and the decoded
 * byte count is the transferred byte count. §3.3 drops `transferBytes` for
 * exactly this reason: a hashed field that is platform-dependent is worse than
 * no field.
 */
export function createPinnedTransport(): ProbeTransport {
  return (url, init) =>
    new Promise<ProbeHttpResponse>((resolve, reject) => {
      let target: URL
      try {
        target = new URL(url)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      const secure = target.protocol === 'https:'
      const client = secure ? https : http
      const headers: Record<string, string> = { ...init.headers, host: target.host }

      const request = client.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port === '' ? (secure ? 443 : 80) : Number(target.port),
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers,
          servername: secure ? target.hostname : undefined,
          lookup: pinnedLookup(init.pinnedAddresses),
          agent: false,
          signal: init.signal,
        },
        (response) => {
          const collected: Record<string, string[]> = {}
          const raw = response.rawHeaders
          for (let i = 0; i + 1 < raw.length; i += 2) {
            const name = (raw[i] ?? '').toLowerCase()
            const value = raw[i + 1] ?? ''
            const existing = collected[name]
            if (existing) existing.push(value)
            else collected[name] = [value]
          }

          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              response.on('data', (chunk: Buffer) => {
                // Copy: `chunk` may be a view onto Node's shared read pool.
                controller.enqueue(new Uint8Array(chunk))
                if ((controller.desiredSize ?? 1) <= 0) response.pause()
              })
              response.on('end', () => {
                try {
                  controller.close()
                } catch {
                  /* already closed by a cancel() */
                }
              })
              response.on('error', (error) => {
                try {
                  controller.error(error)
                } catch {
                  /* already errored */
                }
              })
            },
            pull() {
              response.resume()
            },
            cancel() {
              // The byte cap fires here: stop reading and drop the socket.
              response.destroy()
              request.destroy()
            },
          })

          resolve({ status: response.statusCode ?? 0, headers: collected, body })
        },
      )

      request.on('error', (error) => reject(error))
      request.end()
    })
}
