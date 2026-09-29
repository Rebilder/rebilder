/**
 * Node HTTP adapter for @rebilder/gateway — Express/Fastify-compatible
 * middleware. Import from '@rebilder/gateway/node'. (ROADMAP Phase 1 P1 —
 * "Express/Fastify + Cloudflare Worker adapters".)
 *
 * Deliberately imports NOTHING from express, fastify, or even node:http: the
 * types below are structural descriptions of what every Node HTTP framework
 * hands its middleware (`IncomingMessage`/`ServerResponse` and their framework
 * subclasses satisfy them), so the adapter adds zero dependency weight — the
 * gateway's zero-external-deps invariant holds (README § Dependency policy).
 *
 * Express — the 1-line integration:
 *
 * ```ts
 * import express from 'express'
 * import { createGatewayMiddleware } from '@rebilder/gateway/node'
 * import { gatewayConfig } from './gateway-config'
 *
 * const app = express()
 * app.use(createGatewayMiddleware(gatewayConfig)) // before your routes
 * ```
 *
 * Fastify — via its middleware compat layer, or a 3-line hook wrapper (no
 * fastify import here; see README § Node adapter for both in full):
 *
 * ```ts
 * const gateway = createGatewayMiddleware(gatewayConfig)
 * fastify.addHook('onRequest', (req, reply, done) => {
 *   gateway(req.raw, reply.raw, done)
 * })
 * ```
 *
 * Failure containment: any error — a malformed Host header, a broken res —
 * calls `next()` so the merchant's own pipeline serves the request. The
 * gateway must never crash or blank a merchant's server (core `handleRequest`
 * already contains source/render errors as pass-throughs).
 *
 * The markdown body is buffered (`await response.text()`) before writing —
 * fine by construction: rendered markdown is capped at `maxBytes`
 * (default 5KB, ROADMAP exit criterion "< 5KB"), so there is nothing to
 * stream.
 */

import { handleRequest } from '../../core/handle'
import { applyNegotiationHeaders } from '../../core/negotiation'
import type { GatewayConfig } from '../../core/types'

/**
 * Structural subset of `http.IncomingMessage` as extended by Express/Fastify.
 * Only what the adapter reads — any real Node request object satisfies it.
 */
export interface NodeRequestLike {
  /** Path + query as Node received it (Express may rewrite this on mounted routers). */
  url?: string
  /** Express: the original, unrewritten URL. Preferred over `url` when present. */
  originalUrl?: string
  method?: string
  /** Node header shape: lowercased names; repeated headers arrive as arrays. */
  headers: Record<string, string | string[] | undefined>
  /** Express: 'http' | 'https' (respects app trust-proxy settings). */
  protocol?: string
  /** TLS sockets expose `encrypted: true`; plain sockets omit it. */
  socket?: { encrypted?: boolean }
}

/** Structural subset of `http.ServerResponse` the adapter writes to. */
export interface NodeResponseLike {
  statusCode: number
  setHeader(name: string, value: string): unknown
  end(body?: string): unknown
}

/** Connect/Express-style continuation. Called exactly once on pass-through or error. */
export type NodeNextFunction = () => void

export type NodeGatewayMiddleware = (
  req: NodeRequestLike,
  res: NodeResponseLike,
  next: NodeNextFunction,
) => void

export interface ToWebRequestOptions {
  /**
   * Host used when the request carries no Host header (an HTTP/1.0 client or
   * a synthetic request). Default: 'localhost'. Real traffic always has one.
   */
  fallbackHost?: string
}

/**
 * First value of a possibly-repeated Node header, e.g. for `x-forwarded-proto`
 * where proxy chains produce `'https, http'` or `['https', 'http']` — the
 * FIRST entry is the client-facing protocol.
 */
function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined) return undefined
  const first = raw.split(',')[0]?.trim()
  return first !== undefined && first !== '' ? first : undefined
}

/**
 * Build a web-standard `Request` from a Node request object.
 *
 * - URL: `originalUrl` preferred over `url` (Express rewrites `url` under
 *   mounted routers; sources must see the real path), host from the Host
 *   header, protocol from `x-forwarded-proto` (first value) →
 *   `req.protocol` → `socket.encrypted`.
 * - Headers: every defined Node header is appended; repeated (array) headers
 *   are appended per value, which the Headers class combines per the HTTP
 *   spec — classification sees the same header text either way.
 * - No body: the gateway negotiates GET-shaped page requests; classification
 *   and source resolution read only URL + headers.
 *
 * Exported for reuse — anything that wants core `handleRequest` semantics
 * against a Node request (custom servers, other frameworks' raw req) can
 * build the Request the same way the middleware does.
 */
export function toWebRequest(nodeReq: NodeRequestLike, options: ToWebRequestOptions = {}): Request {
  const host = firstHeaderValue(nodeReq.headers['host']) ?? options.fallbackHost ?? 'localhost'
  const protocol =
    firstHeaderValue(nodeReq.headers['x-forwarded-proto']) ??
    nodeReq.protocol ??
    (nodeReq.socket?.encrypted === true ? 'https' : 'http')
  const path = nodeReq.originalUrl ?? nodeReq.url ?? '/'

  const headers = new Headers()
  for (const [name, value] of Object.entries(nodeReq.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry)
    } else {
      headers.append(name, value)
    }
  }

  return new Request(new URL(path, `${protocol}://${host}`), {
    method: nodeReq.method ?? 'GET',
    headers,
  })
}

/**
 * Build Connect-style middleware: `(req, res, next) => void`.
 *
 * - Markdown path (agent + matching source): status/headers copied from the
 *   core response (`text/markdown; charset=utf-8`, `Vary: Accept`,
 *   `X-Rebilder-Path: markdown`), body buffered and written via `res.end()`.
 *   `next()` is NOT called — the gateway answered.
 * - Pass-through (`handleRequest` → null): `next()` — humans, crawlers,
 *   unmatched URLs, throwing sources; the merchant's pipeline runs untouched.
 * - Any error in the adapter itself: `next()` — never crash the merchant's
 *   server, never leave the request hanging. (If the error strikes after the
 *   response started being written, `next()` is NOT called — a double
 *   response would be its own bug; the write path below is plain assignment
 *   + `end`, so that window is effectively empty.)
 */
export function createGatewayMiddleware(config: GatewayConfig): NodeGatewayMiddleware {
  return (req, res, next) => {
    let writing = false
    void (async () => {
      const webRequest = toWebRequest(req)
      const response = await handleRequest(webRequest, config)
      if (response === null) {
        // The HTML half of a negotiated URL has to declare the negotiation too
        // (core/negotiation.ts). Express hands us `res` before the route
        // writes to it, so the headers can be set here and the merchant's
        // handler never has to know — which is the point, because the version
        // of this that lived in the README as a rule got ignored.
        const passthrough = new Headers()
        applyNegotiationHeaders(passthrough, config, new URL(webRequest.url))
        passthrough.forEach((value, name) => {
          res.setHeader(name, value)
        })
        next()
        return
      }
      const body = await response.text()
      writing = true
      res.statusCode = response.status
      response.headers.forEach((value, name) => {
        res.setHeader(name, value)
      })
      res.end(body)
    })().catch(() => {
      if (!writing) next()
    })
  }
}
