/**
 * tools/install-snippet.ts — the tool that makes this a distribution channel
 * rather than a toy.
 *
 * A scan that ends in a grade is a diagnosis. The conversion moment is the next
 * message, inside the user's own assistant, where they say "so how do I fix it"
 * and get working code for the framework they are actually using (design §5.6).
 *
 * GENERATED LOCALLY, WITH NO NETWORK. Every byte below is a template in this
 * file plus the caller's own arguments. That matters twice over: it works
 * offline and inside a firewall, and it means the snippet cannot be
 * server-controlled — nobody can make this tool emit different code for a
 * particular user, which is a property worth having in something that writes
 * code into other people's repositories.
 *
 * `store_id` is VALIDATED, not escaped. It is interpolated into source code we
 * hand to a person who is likely to paste it without reading every line; a
 * charset gate is the honest control there, and a rejected id is a better
 * outcome than a cleverly quoted one.
 */

import type { JsonObject, JsonValue } from '../json'
import { localFailure, type ToolReturn } from '../result'
import { INSTALL_SNIPPET_INPUT, INSTALL_SNIPPET_OUTPUT } from '../schema'
import {
  defineTool,
  invalidParams,
  isInvalidParams,
  optionalEnum,
  rejectUnknownKeys,
  requireString,
  type Tool,
} from './types'

export const GATEWAY_PACKAGE = '@rebilder/gateway'
const ALLOWED_KEYS = ['framework', 'store_id', 'package_manager'] as const
const FRAMEWORKS = ['next', 'node', 'edge', 'shopify'] as const
const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const
const DEFAULT_STORE_ID = 'store_replace_me'
const STORE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

type Framework = (typeof FRAMEWORKS)[number]
type PackageManager = (typeof PACKAGE_MANAGERS)[number]

interface InstallArgs {
  readonly framework: Framework
  readonly packageManager: PackageManager
  readonly storeId: string
}

interface SnippetFile {
  readonly path: string
  readonly language: string
  readonly contents: string
}

const INSTALL_VERB: Record<PackageManager, string> = {
  npm: 'npm install',
  pnpm: 'pnpm add',
  yarn: 'yarn add',
  bun: 'bun add',
}

/** Wiring to the merchant's source of truth. Identical for every framework. */
function configFile(storeId: string): SnippetFile {
  return {
    path: 'lib/gateway-config.ts',
    language: 'typescript',
    contents: `import type { GatewayConfig } from '${GATEWAY_PACKAGE}'
import { getProduct, getPolicies, getDocument } from './your-catalog' // your code

// Every value an agent sees is INJECTED from your source of truth. Nothing here
// generates a price, a stock level, or a policy sentence — that is the whole
// contract, and it is why the markdown an agent gets and the HTML a human gets
// can never disagree about substance.
export const gatewayConfig: GatewayConfig = {
  storeId: '${storeId}',
  sources: {
    product: (url) => getProduct(url.pathname), // null when the URL is not a PDP
    policies: (url) => getPolicies(url.pathname),
    document: (url) => getDocument(url.pathname), // any non-commerce page
  },
}
`,
  }
}

const ENTRY_FILES: Record<Framework, SnippetFile> = {
  next: {
    path: 'proxy.ts',
    language: 'typescript',
    contents: `// Next 16: proxy.ts. Next <= 15: rename this file to middleware.ts — the code
// is identical, and the adapter imports nothing from \`next\`.
import { NextResponse } from 'next/server'
import { createGatewayProxy } from '${GATEWAY_PACKAGE}/next'
import { gatewayConfig } from './lib/gateway-config'

const gateway = createGatewayProxy(gatewayConfig)

export default async function proxy(req: Request) {
  // Returns a Response for agent traffic, null for everything else. Humans and
  // crawlers fall through to your normal pipeline untouched.
  return (await gateway(req)) ?? NextResponse.next()
}
`,
  },
  node: {
    path: 'server.ts',
    language: 'typescript',
    contents: `import express from 'express'
import { createGatewayMiddleware } from '${GATEWAY_PACKAGE}/node'
import { gatewayConfig } from './lib/gateway-config'

const app = express()

// Mount it before your routes. Any failure inside the gateway calls next(),
// so a broken source can never blank a page.
app.use(createGatewayMiddleware(gatewayConfig))

// Fastify: wrap the same middleware in an onRequest hook —
//   const gateway = createGatewayMiddleware(gatewayConfig)
//   fastify.addHook('onRequest', (req, reply, done) => gateway(req.raw, reply.raw, done))
`,
  },
  edge: {
    path: 'worker.ts',
    language: 'typescript',
    contents: `import { createGatewayFetchHandler } from '${GATEWAY_PACKAGE}/edge'
import { gatewayConfig } from './lib/gateway-config'

// Route the worker at your origin (e.g. store.example.com/*). Non-agent
// requests pass straight through to the origin, so browsers and crawlers get
// the canonical HTML exactly as if the worker were not there.
export default { fetch: createGatewayFetchHandler(gatewayConfig) }
`,
  },
  shopify: {
    path: 'app/proxy/route.ts',
    language: 'typescript',
    contents: `import { createShopifyAppProxyHandler } from '${GATEWAY_PACKAGE}/shopify'
import { gatewayConfig } from '../../lib/gateway-config'

// Shopify App Proxy: configure the subpath prefix "apps" and subpath
// "rebilder" in your Partners app, pointing at this route.
//
// The handler verifies Shopify's HMAC signature with a constant-time compare
// and rejects anything older than 90 seconds before it looks at a source, so an
// unsigned or replayed request never reaches your catalog.
export const GET = createShopifyAppProxyHandler(gatewayConfig, {
  sharedSecret: process.env.SHOPIFY_API_SECRET ?? '',
})
`,
  },
}

const VERIFY: Record<Framework, string[]> = {
  next: [
    'curl -sSI -H "Accept: text/markdown" https://YOUR-DOMAIN/your-product-url | grep -i x-rebilder-path',
    'Expect: `x-rebilder-path: markdown` and `vary: accept`.',
    'Then run compare_agent_view on the same URL — the agent side should be markdown and much smaller.',
  ],
  node: [
    'curl -sSI -H "Accept: text/markdown" https://YOUR-DOMAIN/your-product-url | grep -i x-rebilder-path',
    'Expect: `x-rebilder-path: markdown` and `vary: accept`.',
    'Then run compare_agent_view on the same URL.',
  ],
  edge: [
    'Deploy the worker to the route, then: curl -sSI -H "Accept: text/markdown" https://YOUR-DOMAIN/your-product-url',
    'Expect: `x-rebilder-path: markdown`. A browser request to the same URL must still return your HTML.',
    'Then run compare_agent_view on the same URL.',
  ],
  shopify: [
    'curl -sS -H "Accept: text/markdown" "https://YOUR-SHOP.myshopify.com/apps/rebilder/products/your-handle"',
    'Expect markdown. An unsigned request straight to your app URL must return 401.',
    'Then run compare_agent_view on the storefront URL.',
  ],
}

const NOTES: string[] = [
  'Humans and search crawlers are untouched: Googlebot always receives your canonical HTML, even if it sends Accept: text/markdown.',
  'Markdown responses carry `Vary: Accept` — the same URL serves two representations and caches must key on the header.',
  'The Apache-2.0 SDK serves without a Rebilder account or subscription. Configure reporting separately.',
  'Zero external runtime dependencies. The adapters import nothing from next, express, fastify or the Cloudflare runtime.',
  'This snippet was generated locally by the MCP server from a template. No network call was made to produce it, and nothing about your project left this machine.',
]

export const installSnippetTool: Tool = defineTool<InstallArgs>({
  name: 'install_snippet',
  title: 'Generate a Rebilder gateway install snippet',
  description: [
    'Generate ready-to-paste code that puts the Rebilder gateway in front of a site, for Next.js, Express/Fastify, a Cloudflare Worker or a Shopify App Proxy.',
    "The gateway serves AI agents a clean markdown transformation of the same page a browser gets, rendered from the site's own source of truth, and leaves humans and search crawlers untouched.",
    'Generated entirely offline from templates in this server — no network call, and nothing about the project is sent anywhere.',
  ].join(' '),
  inputSchema: INSTALL_SNIPPET_INPUT,
  outputSchema: INSTALL_SNIPPET_OUTPUT,
  annotations: {
    title: 'Generate a Rebilder gateway install snippet',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  parse(args) {
    const unknown = rejectUnknownKeys(args, ALLOWED_KEYS)
    if (unknown !== null) return unknown
    const rawFramework = requireString(args, 'framework')
    if (isInvalidParams(rawFramework)) return rawFramework
    if (!(FRAMEWORKS as readonly string[]).includes(rawFramework)) {
      return invalidParams(`"framework" must be one of: ${FRAMEWORKS.join(', ')}.`)
    }
    const framework = rawFramework as Framework
    const packageManager = optionalEnum(args, 'package_manager', PACKAGE_MANAGERS, 'npm')
    if (isInvalidParams(packageManager)) return packageManager

    let storeId = DEFAULT_STORE_ID
    if (args['store_id'] !== undefined && args['store_id'] !== null) {
      const raw = requireString(args, 'store_id')
      if (isInvalidParams(raw)) return raw
      storeId = raw
    }
    return { framework, packageManager, storeId }
  },
  run(args): Promise<ToolReturn> {
    if (!STORE_ID_PATTERN.test(args.storeId)) {
      return Promise.resolve(
        localFailure(
          `"${args.storeId}" is not a usable store id. Use 1–64 characters from A–Z, a–z, 0–9, "_" and "-". The value is written verbatim into generated source code, so it is validated rather than escaped.`,
          { ok: false, error: 'invalid-store-id', requested: args.storeId },
        ),
      )
    }

    const installCommand = `${INSTALL_VERB[args.packageManager]} ${GATEWAY_PACKAGE}`
    const files: SnippetFile[] = [configFile(args.storeId), ENTRY_FILES[args.framework]]
    const verify = VERIFY[args.framework]

    const summary = [
      `Rebilder gateway install for ${args.framework}.`,
      `1. Install:\n\n    ${installCommand}`,
      ...files.map(
        (file, index) =>
          `${index + 2}. ${file.path}\n\n\`\`\`${file.language}\n${file.contents}\`\`\``,
      ),
      `${files.length + 2}. Verify:\n${verify.map((line) => `    ${line}`).join('\n')}`,
      `Notes:\n${NOTES.map((note) => `  - ${note}`).join('\n')}`,
    ].join('\n\n')

    const structured: JsonObject = {
      framework: args.framework,
      packageManager: args.packageManager,
      packageName: GATEWAY_PACKAGE,
      installCommand,
      storeId: args.storeId,
      files: files.map((file): JsonValue => ({ ...file })),
      verify: [...verify],
      notes: [...NOTES],
      generatedOffline: true,
    }

    return Promise.resolve({ origin: 'local', summary, structured })
  },
})
