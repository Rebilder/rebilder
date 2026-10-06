/**
 * commands/init.ts — a gateway config scaffold for the framework it found.
 *
 * ZERO NETWORK, and that is not incidental. `init` reads `package.json` and a
 * handful of well-known filenames in the working directory and writes a file.
 * Nothing about the user's dependency list, framework choice, or repository
 * leaves the machine — a scaffolding command that phoned home with "which
 * framework did they pick" would be exactly the telemetry the README says we do
 * not collect, wearing a helpful hat.
 *
 * THE DETECTION IS PRINTED. Every scaffold says how it decided (`"next found in
 * package.json dependencies"`), because a wrong guess with a visible reason is a
 * thirty-second fix and a wrong guess with no reason is a bug report. `--framework`
 * overrides it.
 *
 * DETECTION ORDER: framework before runtime. A Hono app deployed with wrangler
 * wants Hono middleware, not a Worker that replaces the app, and a SvelteKit site
 * on Netlify wants the SvelteKit hook. So framework marker files come first, then
 * framework dependencies, then runtime markers (wrangler, Netlify, Vercel, Deno,
 * Bun). With no marker at all, the scaffold is the framework-neutral fetch
 * middleware, which any `(request, next)` host can mount.
 *
 * THE SCAFFOLD IS A SKELETON WITH A `TODO`, NOT A WORKING CONFIG, and it says so
 * in a comment inside the generated file. `GatewaySources` resolvers read the
 * merchant's source of truth; we cannot know what that is, and a scaffold that
 * looked complete would be a scaffold someone shipped. This is the same rule the
 * variant architecture runs on: substantive values come from source-of-truth
 * fields, never from something we generated (source validation).
 *
 * The mounting snippets mirror the recipes at rebilder.com/docs/adapters/*.
 */

import { DEFAULT_RULESET } from '@rebilder/agent-readability'
import { UsageError } from '../exit'
import type { InitCommand } from '../args'
import type { Scaffold } from '../payload'
import type { CliRuntime } from '../runtime'

export const FRAMEWORKS = [
  'next',
  'node',
  'edge',
  'shopify',
  'fetch',
  'sveltekit',
  'nuxt',
  'astro',
  'react-router',
  'remix',
  'hono',
  'bun',
  'deno',
  'netlify',
  'vercel',
] as const
export type Framework = (typeof FRAMEWORKS)[number]

interface Detection {
  framework: Framework
  reason: string
}

interface FileMarker {
  file: string
  framework: Framework
}

interface DependencyMarker {
  dependency: string
  framework: Framework
}

/** Step 1: config files a framework puts at the project root. */
const FRAMEWORK_FILES: readonly FileMarker[] = [
  { file: 'shopify.app.toml', framework: 'shopify' },
  { file: 'next.config.ts', framework: 'next' },
  { file: 'next.config.mjs', framework: 'next' },
  { file: 'next.config.js', framework: 'next' },
  { file: 'svelte.config.js', framework: 'sveltekit' },
  { file: 'svelte.config.ts', framework: 'sveltekit' },
  { file: 'nuxt.config.ts', framework: 'nuxt' },
  { file: 'nuxt.config.js', framework: 'nuxt' },
  { file: 'nuxt.config.mjs', framework: 'nuxt' },
  { file: 'astro.config.mjs', framework: 'astro' },
  { file: 'astro.config.ts', framework: 'astro' },
  { file: 'astro.config.js', framework: 'astro' },
  { file: 'react-router.config.ts', framework: 'react-router' },
  { file: 'react-router.config.js', framework: 'react-router' },
  { file: 'remix.config.js', framework: 'remix' },
]

/** Step 2: framework dependencies in package.json. Order matters: Shopify's Remix app is Shopify. */
const FRAMEWORK_DEPENDENCIES: readonly DependencyMarker[] = [
  { dependency: '@shopify/shopify-app-remix', framework: 'shopify' },
  { dependency: '@shopify/shopify-app-react-router', framework: 'shopify' },
  { dependency: '@shopify/shopify-api', framework: 'shopify' },
  { dependency: 'next', framework: 'next' },
  { dependency: '@sveltejs/kit', framework: 'sveltekit' },
  { dependency: 'nuxt', framework: 'nuxt' },
  { dependency: 'astro', framework: 'astro' },
  { dependency: '@react-router/dev', framework: 'react-router' },
  { dependency: '@react-router/node', framework: 'react-router' },
  { dependency: '@remix-run/node', framework: 'remix' },
  { dependency: '@remix-run/express', framework: 'remix' },
  { dependency: 'hono', framework: 'hono' },
  { dependency: 'express', framework: 'node' },
  { dependency: 'fastify', framework: 'node' },
]

/** Step 3: where the code runs, when no framework said so. */
const RUNTIME_FILES: readonly FileMarker[] = [
  { file: 'wrangler.toml', framework: 'edge' },
  { file: 'wrangler.jsonc', framework: 'edge' },
  { file: 'wrangler.json', framework: 'edge' },
  { file: 'netlify.toml', framework: 'netlify' },
  { file: 'vercel.json', framework: 'vercel' },
  { file: 'deno.json', framework: 'deno' },
  { file: 'deno.jsonc', framework: 'deno' },
  { file: 'bunfig.toml', framework: 'bun' },
  { file: 'bun.lock', framework: 'bun' },
  { file: 'bun.lockb', framework: 'bun' },
]

const RUNTIME_DEPENDENCIES: readonly DependencyMarker[] = [
  { dependency: 'wrangler', framework: 'edge' },
  { dependency: '@cloudflare/workers-types', framework: 'edge' },
  { dependency: '@netlify/edge-functions', framework: 'netlify' },
  { dependency: '@vercel/functions', framework: 'vercel' },
]

async function firstFile(
  runtime: CliRuntime,
  markers: readonly FileMarker[],
): Promise<Detection | null> {
  for (const marker of markers) {
    if ((await runtime.readFile(marker.file)) !== null) {
      return {
        framework: marker.framework,
        reason: `detected from ${marker.file} in the working directory`,
      }
    }
  }
  return null
}

function firstDependency(
  dependencies: Record<string, unknown>,
  markers: readonly DependencyMarker[],
): Detection | null {
  for (const marker of markers) {
    if (marker.dependency in dependencies) {
      return {
        framework: marker.framework,
        reason: `detected from "${marker.dependency}" in package.json`,
      }
    }
  }
  return null
}

async function readDependencies(runtime: CliRuntime): Promise<Record<string, unknown>> {
  const manifest = await runtime.readFile('package.json')
  if (manifest === null) return {}
  try {
    const parsed: unknown = JSON.parse(manifest)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const record = parsed as Record<string, unknown>
    return { ...asRecord(record['dependencies']), ...asRecord(record['devDependencies']) }
  } catch {
    // A package.json we cannot parse is not an error worth stopping for — it
    // is one signal of several, and the fallback below is honest about it.
    return {}
  }
}

export async function detectFramework(runtime: CliRuntime): Promise<Detection> {
  const dependencies = await readDependencies(runtime)
  return (
    (await firstFile(runtime, FRAMEWORK_FILES)) ??
    firstDependency(dependencies, FRAMEWORK_DEPENDENCIES) ??
    (await firstFile(runtime, RUNTIME_FILES)) ??
    firstDependency(dependencies, RUNTIME_DEPENDENCIES) ?? {
      framework: 'fetch',
      reason:
        'no framework marker found — scaffolding the framework-neutral fetch middleware. ' +
        `Pass --framework ${FRAMEWORKS.join('|')} to choose.`,
    }
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export async function runInit(command: InitCommand, runtime: CliRuntime): Promise<Scaffold> {
  let framework: Framework
  let detection: string

  if (command.framework !== null) {
    const match = FRAMEWORKS.find((name) => name === command.framework)
    if (match === undefined) {
      throw new UsageError(
        `--framework must be one of ${FRAMEWORKS.join(', ')} (received "${command.framework}")`,
      )
    }
    framework = match
    detection = 'chosen with --framework'
  } else {
    const detected = await detectFramework(runtime)
    framework = detected.framework
    detection = detected.reason
  }

  return { ...SCAFFOLDS[framework], framework, detection }
}

const SHARED_NOTES: readonly string[] = [
  'The resolvers return your source of truth. Every substantive value — price, stock, hours, policy text — comes from these fields; the gateway never invents one.',
  'The Apache-2.0 SDK serves without a Rebilder account or subscription. Configure reporting separately.',
  `Run \`rebilder check <url>\` before and after to see what changed. Sending a Markdown copy from the page address is D2.1 (${DEFAULT_RULESET.weights['machine-representation.negotiated-response'] ?? 0} points) and unlocks D2.3 and D2.4.`,
]

const CONFIG_BODY = `import type { GatewayConfig } from '@rebilder/gateway'

/**
 * Wiring to YOUR source of truth. Each resolver takes a URL and returns the
 * fields for that page, or null to fall through to your normal HTML.
 *
 * Resolvers run on the request hot path: p95 < 50ms of compute, and no network
 * call except a cache. Anything slower belongs in a build step.
 */
export const gatewayConfig: GatewayConfig = {
  storeId: 'TODO-your-store-id',
  sources: {
    // TODO: return your product fields, or null when the URL is not a PDP.
    product: async (url) => {
      void url
      return null
    },
    // TODO: policies, catalog, document, collection — add the ones you have.
  },
  // Optional: emit @rebilder/events RebilderEventV0 into your observation layer.
  // onEvent: (event) => { void event },
}
`

/**
 * A config file plus one mounting snippet, commented out below it: the
 * snippet belongs in a different file, and a scaffold that compiled it here
 * would import the framework into the config module.
 */
function scaffold(
  suggestedPath: string,
  mount: string,
  notes: readonly string[],
): Omit<Scaffold, 'framework' | 'detection'> {
  const [header = '', ...body] = mount.trim().split('\n')
  const commented = body.map((line) => (line === '' ? '//' : `// ${line}`))
  return {
    suggestedPath,
    language: 'ts',
    notes: [...notes, ...SHARED_NOTES],
    contents: `${CONFIG_BODY}\n${header}\n//\n${commented.join('\n')}\n`,
  }
}

const DOCS = 'https://rebilder.com/docs/adapters'

const SCAFFOLDS: Record<Framework, Omit<Scaffold, 'framework' | 'detection'>> = {
  next: scaffold(
    'lib/gateway-config.ts',
    `
/* ── proxy.ts (Next 16) or middleware.ts (Next ≤15) ───────────────────────── */
import { NextResponse } from 'next/server'
import { createGatewayProxy } from '@rebilder/gateway/next'
import { gatewayConfig } from './lib/gateway-config'

// Passing the fallthrough adds Vary: Accept to your HTML responses too.
export default createGatewayProxy(gatewayConfig, () => NextResponse.next())
`,
    [
      'Then add the proxy: `createGatewayProxy(gatewayConfig, () => NextResponse.next())` in proxy.ts (Next 16) or middleware.ts (Next 15 and earlier).',
      `Full guide: ${DOCS}/nextjs`,
    ],
  ),
  node: scaffold(
    'gateway-config.ts',
    `
/* ── Express ──────────────────────────────────────────────────────────────── */
import express from 'express'
import { createGatewayMiddleware } from '@rebilder/gateway/node'
import { gatewayConfig } from './gateway-config'

const app = express()
app.use(createGatewayMiddleware(gatewayConfig)) // before your routes
`,
    [
      'Then mount it before your routes: `app.use(createGatewayMiddleware(gatewayConfig))`.',
      `Fastify and the full guide: ${DOCS}/node`,
    ],
  ),
  edge: scaffold(
    'gateway-config.ts',
    `
/* ── worker.ts (Cloudflare Workers) ───────────────────────────────────────── */
import { createGatewayFetchHandler } from '@rebilder/gateway/edge'
import { gatewayConfig } from './gateway-config'

export default { fetch: createGatewayFetchHandler(gatewayConfig) }
`,
    [
      'Then export the fetch handler: `export default { fetch: createGatewayFetchHandler(gatewayConfig) }`.',
      'On a route-mounted Worker, non-markdown requests pass through to your origin unchanged, so browsers and crawlers keep receiving the canonical HTML.',
      `Full guide: ${DOCS}/cloudflare`,
    ],
  ),
  shopify: scaffold(
    'app/gateway-config.ts',
    `
/* ── Shopify app proxy ────────────────────────────────────────────────────── */
import { createShopifyAppProxyHandler } from '@rebilder/gateway/shopify'
import { gatewayConfig } from './gateway-config'

export const loader = createShopifyAppProxyHandler(gatewayConfig, {
  sharedSecret: process.env.SHOPIFY_API_SECRET ?? '',
})
`,
    [
      'Then mount the app-proxy handler and give it your app’s shared secret; requests are signature-verified before anything is rendered.',
      `Full guide: ${DOCS}/shopify`,
    ],
  ),
  fetch: scaffold(
    'gateway-config.ts',
    `
/* ── Any host whose middleware receives a Request and a next() ────────────── */
import { createFetchMiddleware } from '@rebilder/gateway/fetch'
import { gatewayConfig } from './gateway-config'

const gateway = createFetchMiddleware(gatewayConfig)

// In your middleware: return gateway(request, () => next())
`,
    [
      'Mount `createFetchMiddleware(gatewayConfig)` wherever your framework hands middleware a Request and a next().',
      `Recipes for SvelteKit, Nuxt, Astro, React Router, Remix and Hono: ${DOCS}/frameworks`,
    ],
  ),
  sveltekit: scaffold(
    'src/lib/gateway-config.ts',
    `
/* ── src/hooks.server.ts ──────────────────────────────────────────────────── */
import type { Handle } from '@sveltejs/kit'
import { createFetchMiddleware } from '@rebilder/gateway/fetch'
import { gatewayConfig } from '$lib/gateway-config'

const gateway = createFetchMiddleware(gatewayConfig)

export const handle: Handle = ({ event, resolve }) => gateway(event.request, () => resolve(event))
`,
    [
      'Then add the `handle` hook in src/hooks.server.ts. If you already have one, combine them with `sequence` from @sveltejs/kit/hooks.',
      `Full guide: ${DOCS}/frameworks#sveltekit`,
    ],
  ),
  nuxt: scaffold(
    'server/utils/gateway-config.ts',
    `
/* ── server/middleware/rebilder.ts (Nuxt and Nitro; h3 helpers are auto-imported) ── */
import { handleRequest, negotiationHeaders } from '@rebilder/gateway/fetch'
import { gatewayConfig } from '../utils/gateway-config'

export default defineEventHandler(async (event) => {
  if (event.method !== 'GET' && event.method !== 'HEAD') return
  const served = await handleRequest(toWebRequest(event), gatewayConfig)
  if (served) return served
  for (const [name, value] of negotiationHeaders(gatewayConfig, getRequestURL(event))) {
    appendResponseHeader(event, name, value)
  }
})
`,
    [
      'Then add the server middleware. It returns markdown to agents and otherwise returns nothing, so Nuxt renders the page as usual.',
      `Full guide: ${DOCS}/frameworks#nuxt`,
    ],
  ),
  astro: scaffold(
    'src/gateway-config.ts',
    `
/* ── src/middleware.ts ────────────────────────────────────────────────────── */
import { defineMiddleware } from 'astro:middleware'
import { createFetchMiddleware } from '@rebilder/gateway/fetch'
import { gatewayConfig } from './gateway-config'

const gateway = createFetchMiddleware(gatewayConfig)

export const onRequest = defineMiddleware((context, next) => gateway(context.request, () => next()))
`,
    [
      'Then add src/middleware.ts. Astro runs middleware per request only on on-demand rendered pages (an adapter plus `output: "server"` or `export const prerender = false`).',
      `Full guide: ${DOCS}/frameworks#astro`,
    ],
  ),
  'react-router': scaffold(
    'app/gateway-config.server.ts',
    `
/* ── app/root.tsx (React Router 8, or 7.9+ with future.v8_middleware) ─────── */
import type { Route } from './+types/root'
import { createFetchMiddleware } from '@rebilder/gateway/fetch'
import { gatewayConfig } from './gateway-config.server'

const gateway = createFetchMiddleware(gatewayConfig)

export const middleware: Route.MiddlewareFunction[] = [({ request }, next) => gateway(request, next)]
`,
    [
      'Then export `middleware` from app/root.tsx. On React Router 7, enable `future: { v8_middleware: true }` in react-router.config.ts first.',
      `Full guide: ${DOCS}/frameworks#react-router`,
    ],
  ),
  remix: scaffold(
    'app/gateway-config.server.ts',
    `
/* ── server.ts (Remix v2 with a custom Express server) ────────────────────── */
import express from 'express'
import { createRequestHandler } from '@remix-run/express'
import { createGatewayMiddleware } from '@rebilder/gateway/node'
import { gatewayConfig } from './app/gateway-config.server'

const app = express()
app.use(createGatewayMiddleware(gatewayConfig)) // before Remix
app.all('*', createRequestHandler({ build: await import('./build/server/index.js') }))
`,
    [
      'Remix v2 has no middleware, so the gateway runs as Express middleware in front of `createRequestHandler`.',
      `Full guide: ${DOCS}/frameworks#remix`,
    ],
  ),
  hono: scaffold(
    'src/gateway-config.ts',
    `
/* ── src/index.ts (Hono) ──────────────────────────────────────────────────── */
import { Hono } from 'hono'
import { createFetchMiddleware } from '@rebilder/gateway/fetch'
import { gatewayConfig } from './gateway-config'

const gateway = createFetchMiddleware(gatewayConfig)
const app = new Hono()

app.use(async (c, next) => {
  let passed = false
  const res = await gateway(c.req.raw, async () => {
    passed = true
    await next()
    return c.res
  })
  if (!passed) return res // markdown, answered before any route ran
  c.res = undefined // clear first, so Hono does not copy the old headers over ours
  c.res = res
})
`,
    [
      'Register the middleware before your routes. It works the same on Workers, Bun, Deno and Node.',
      `Full guide: ${DOCS}/frameworks#hono`,
    ],
  ),
  bun: scaffold(
    'gateway-config.ts',
    `
/* ── server.ts (Bun) ──────────────────────────────────────────────────────── */
import { createFetchMiddleware } from '@rebilder/gateway/fetch'
import { gatewayConfig } from './gateway-config'
import { app } from './app' // TODO: your existing (request) => Response handler

const gateway = createFetchMiddleware(gatewayConfig)

Bun.serve({ fetch: (request) => gateway(request, () => app(request)) })
`,
    [
      'Wrap your existing fetch handler. Requests served by Bun.serve `routes` skip `fetch`, so wrap those handlers too.',
      `Full guide: ${DOCS}/runtimes#bun`,
    ],
  ),
  deno: scaffold(
    'gateway-config.ts',
    `
/* ── main.ts (Deno) ───────────────────────────────────────────────────────── */
import { createFetchMiddleware } from '@rebilder/gateway/fetch'
import { gatewayConfig } from './gateway-config.ts'
import { app } from './app.ts' // TODO: your existing (request) => Response handler

const gateway = createFetchMiddleware(gatewayConfig)

Deno.serve((request) => gateway(request, () => app(request)))
`,
    ['Wrap your existing handler in Deno.serve.', `Full guide: ${DOCS}/runtimes#deno`],
  ),
  netlify: scaffold(
    'gateway-config.ts',
    `
/* ── netlify/edge-functions/rebilder.ts ───────────────────────────────────── */
import type { Config, Context } from '@netlify/edge-functions'
import { createFetchMiddleware } from '@rebilder/gateway/fetch'
import { gatewayConfig } from '../../gateway-config.ts'

const gateway = createFetchMiddleware(gatewayConfig)

export default (request: Request, context: Context) => gateway(request, () => context.next())

export const config: Config = { path: '/*', excludedPath: ['/*.css', '/*.js'] }
`,
    [
      'Then add the edge function. It answers agents at the edge and passes everything else to your site with `context.next()`.',
      `Full guide: ${DOCS}/runtimes#netlify`,
    ],
  ),
  vercel: scaffold(
    'gateway-config.ts',
    `
/* ── middleware.ts (Vercel Routing Middleware, outside Next.js) ───────────── */
import { next } from '@vercel/functions'
import { handleRequest, negotiationHeaders } from '@rebilder/gateway/fetch'
import { gatewayConfig } from './gateway-config'

export default async function middleware(request: Request) {
  const served = await handleRequest(request, gatewayConfig)
  return served ?? next({ headers: Object.fromEntries(negotiationHeaders(gatewayConfig, new URL(request.url))) })
}
`,
    [
      'Then add middleware.ts at the project root. In a Next.js project, run `rebilder init --framework next` instead.',
      `Full guide: ${DOCS}/runtimes#vercel`,
    ],
  ),
}
