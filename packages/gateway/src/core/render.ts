/**
 * Markdown resolution: request URL → merchant sources → @rebilder/render-md.
 *
 * Everything substantive in the output is injected from the source objects
 * the merchant's resolvers return (source validation — render-md's contract), and
 * the markdown is a format transformation of the same substance as the
 * canonical HTML page (consistent source content).
 *
 * Failure containment: nothing in here throws. A source that throws (sync or
 * async) is treated as "no match" and resolution continues; a source that
 * hangs is cut off at `sourceTimeoutMs` and treated the same way; a source
 * that returns a shape we cannot use (a `policies` value that is not an
 * array, a `collection` with no `items`) is a no-match rather than a
 * TypeError; and a render failure (e.g. render-md rejecting a malformed
 * money amount) resolves to null. `handleRequest` does not wrap this function
 * in a try/catch, so a throw escaping it would be a 500 on the merchant's
 * live site — the containment here is the only thing standing between a
 * merchant's resolver bug and their homepage.
 */

import {
  applyCompatibilityProfile,
  BASELINE_PROFILE,
  type CompatibilityProfile,
  renderCatalogMarkdown,
  renderCollectionMarkdown,
  renderDocumentMarkdown,
  renderFrontmatter,
  renderPolicyMarkdown,
  renderProductMarkdown,
  type DocumentSource,
  type FrontmatterFields,
  type RenderOptions,
} from '@rebilder/render-md'
import type { GatewayConfig, GatewaySources, SourceKind, SourceResolver } from './types'

/**
 * Default resolver timeout. 250ms is well outside the p95 < 50ms compute
 * budget an in-memory or cache-backed resolver needs (project convention),
 * so it never fires for a correctly wired source; it exists to bound the
 * incorrectly wired one.
 */
export const DEFAULT_SOURCE_TIMEOUT_MS = 250

/** Sentinel for "the timer won the race". A symbol cannot collide with data. */
const TIMED_OUT = Symbol('rebilder.source-timeout')

/**
 * Race a pending resolver against a timer. The timer is always cleared, so a
 * resolver that settles normally leaves nothing behind holding the event loop
 * open. A resolver that rejects *after* losing the race is still handled —
 * `Promise.race` subscribes to both promises — so a slow rejection cannot
 * surface as an unhandled rejection in the merchant's process.
 */
async function raceTimeout<T>(
  pending: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Call a merchant source; a throw, a rejection, or a hang past `timeoutMs` is
 * treated as "no match".
 *
 * `timeoutMs` is optional and there is deliberately no default here: the
 * markdown hot path passes `config.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS`,
 * while llms.txt generation passes nothing and waits. llms.txt is generated
 * off the hot path into a hard-cached file, and its resolvers are wired to
 * enumerate an entire catalog; silently dropping a whole `## Products`
 * section because that enumeration took 300ms would be a worse failure than
 * the slow response it prevents. A non-positive or non-finite `timeoutMs`
 * also means "wait".
 *
 * Exported for intra-package reuse (llms.txt generation enumerates the same
 * sources with the same containment); not part of the public API.
 */
export async function callSource<T>(
  resolver: SourceResolver<T> | undefined,
  url: URL,
  timeoutMs?: number,
): Promise<T | null> {
  if (resolver === undefined) return null
  try {
    // Called synchronously inside the try, so a resolver that throws before
    // returning a promise is contained exactly like one that rejects.
    const pending = Promise.resolve(resolver(url))
    if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return (await pending) ?? null
    }
    const settled = await raceTimeout(pending, timeoutMs)
    return settled === TIMED_OUT ? null : (settled ?? null)
  } catch {
    return null
  }
}

/** Run a renderer; a throw resolves to null (pass through, never break). */
function renderSafely(render: () => string): string | null {
  try {
    return render()
  } catch {
    return null
  }
}

const SOURCE_KINDS: ReadonlySet<SourceKind> = new Set<SourceKind>([
  'product',
  'policies',
  'catalog',
  'document',
  'collection',
])

/**
 * Ask the optional router which single source to consult, or null for the
 * ordered chain.
 *
 * A router that throws, or returns something outside `SourceKind` (possible
 * from untyped JavaScript), falls through to the chain rather than matching
 * nothing: `null` is the documented "I don't know, use the normal order"
 * answer, and an unusable answer is the same amount of knowledge.
 */
function routeKind(sources: GatewaySources, url: URL): SourceKind | null {
  if (sources.match === undefined) return null
  try {
    const kind = sources.match(url)
    return kind !== null && SOURCE_KINDS.has(kind) ? kind : null
  } catch {
    return null
  }
}

/** Per-source byte budget, falling back to the global one, then render-md's. */
function optionsFor(kind: SourceKind, config: GatewayConfig): RenderOptions | undefined {
  const maxBytes = config.maxBytesBySource?.[kind] ?? config.maxBytes
  return maxBytes === undefined ? undefined : { maxBytes }
}

/**
 * A successful markdown resolution: the rendered body plus the source kind
 * that produced it.
 *
 * The `source` is what `handleRequest` stamps onto
 * `RebilderEventV0.response.source` (packages/events v0.2). It costs nothing
 * on the hot path — resolution already knows which branch it took, so this is
 * a field on a return value that was being discarded, not extra work: no
 * clock read, no network call, no second pass over the sources.
 */
export interface MarkdownResolution {
  markdown: string
  source: SourceKind
  profile: CompatibilityProfile
}

/**
 * Resolve a URL to rendered markdown via the configured sources, or null when
 * nothing matches.
 *
 * Fixed resolution order — product → policies → catalog → document →
 * collection — so product wins when several sources would match a URL. The
 * first source returning data is rendered; if that render fails the result is
 * null (pass through), not a fall-through to a lower-precedence source —
 * serving the returns policy on a product URL would be worse than serving
 * HTML.
 *
 * When `sources.match` names a kind, exactly one resolver is called and the
 * others are not consulted at all — including when the named one does not
 * match, which is a pass-through. That is the whole point: five optional
 * sources would otherwise mean up to five sequential awaits on the hot path.
 *
 * A render failure resolves to null and is therefore reported as a miss
 * (`coverage: 'unsourced'`) rather than as a `sourced` response with no body.
 * That is the honest reading: the agent got HTML, not markdown.
 */
export async function resolveMarkdownWithSource(
  url: URL,
  config: GatewayConfig,
): Promise<MarkdownResolution | null> {
  const { sources } = config
  const timeoutMs = config.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS
  const routed = routeKind(sources, url)
  const runs = (kind: SourceKind): boolean => routed === null || routed === kind
  // Select once per resolution. A failing merchant getter falls back locally.
  let profile: unknown = BASELINE_PROFILE
  try { profile = typeof config.compatibilityProfile === 'function' ? config.compatibilityProfile() : config.compatibilityProfile } catch { /* baseline */ }
  const resolved = (
    source: SourceKind,
    markdown: string | null,
    fields: () => FrontmatterFields,
  ): MarkdownResolution | null => {
    if (markdown === null) return null
    const rendering = applyCompatibilityProfile(markdown, profile, {
      canonicalUrl: url.href,
      maxBytes: config.maxBytesBySource?.[source] ?? config.maxBytes,
    })
    return { ...rendering, markdown: withFrontmatter(rendering.markdown, url, config, fields), source }
  }

  if (runs('product')) {
    const product = await callSource(sources.product, url, timeoutMs)
    if (product !== null) {
      return resolved(
        'product',
        renderSafely(() => renderProductMarkdown(product, optionsFor('product', config))),
        () => ({ title: product.title, description: product.description, lastUpdated: product.updated }),
      )
    }
  }

  if (runs('policies')) {
    const policies = await callSource(sources.policies, url, timeoutMs)
    if (Array.isArray(policies) && policies.length > 0) {
      return resolved(
        'policies',
        renderSafely(() => renderPolicyMarkdown(policies, optionsFor('policies', config))),
        // One policy is a page with that title; several on one URL have no
        // single title, and inventing one would put our words in the block.
        () => (policies.length === 1 ? { title: policies[0]?.title } : {}),
      )
    }
  }

  if (runs('catalog')) {
    const catalog = await callSource(sources.catalog, url, timeoutMs)
    if (Array.isArray(catalog) && catalog.length > 0) {
      return resolved(
        'catalog',
        renderSafely(() => renderCatalogMarkdown(catalog, optionsFor('catalog', config))),
        () => ({}),
      )
    }
  }

  if (runs('document')) {
    const document = await callSource(sources.document, url, timeoutMs)
    if (document !== null) {
      return resolved(
        'document',
        renderSafely(() => renderDocumentMarkdown(document, optionsFor('document', config))),
        () => ({
          title: document.title,
          description: documentDescription(document),
          lastUpdated: document.updated,
        }),
      )
    }
  }

  if (runs('collection')) {
    const collection = await callSource(sources.collection, url, timeoutMs)
    if (collection !== null && Array.isArray(collection.items) && collection.items.length > 0) {
      return resolved(
        'collection',
        renderSafely(() => renderCollectionMarkdown(collection, optionsFor('collection', config))),
        () => ({ title: collection.title, lastUpdated: collection.updated }),
      )
    }
  }

  return null
}

/** render-md renders at most this many facts; a fact past it is not in the body. */
const RENDERED_FACTS = 60

/**
 * A document's description for frontmatter, in this order: the text fact the
 * merchant labelled `Description`, then `summary`, then a text fact labelled
 * `Summary` (labels in any case).
 *
 * The labelled fact comes first because it is the one the merchant named as
 * the description, and it is usually the same sentence as the page's meta
 * description. `summary` is often a longer lede. Either way the value is the
 * merchant's own sentence, already in the body, and nothing is composed here.
 */
function documentDescription(document: DocumentSource): string | undefined {
  const labelled = (wanted: string): string | undefined => {
    for (const fact of (document.facts ?? []).slice(0, RENDERED_FACTS)) {
      const label = typeof fact?.label === 'string' ? fact.label.trim().toLowerCase() : ''
      if (label !== wanted) continue
      if (fact.value?.type === 'text' && typeof fact.value.value === 'string') return fact.value.value
    }
    return undefined
  }
  const summary =
    typeof document.summary === 'string' && document.summary.trim() !== ''
      ? document.summary
      : undefined
  return labelled('description') ?? summary ?? labelled('summary')
}

/**
 * Prepend the source's frontmatter when `config.frontmatter` is on.
 *
 * After the compatibility profile, because the block has to be the first thing
 * in the document for a reader to recognise it, and outside the byte budget,
 * because the budget governs the body and the block is capped on its own.
 * `canonical_url` is the URL this markdown was resolved for, which is the same
 * value the response's `Link: rel="canonical"` header states. A block that
 * cannot be built (a throwing getter on an odd source object) is left out; the
 * body is served either way.
 */
function withFrontmatter(
  markdown: string,
  url: URL,
  config: GatewayConfig,
  fields: () => FrontmatterFields,
): string {
  if (config.frontmatter !== true) return markdown
  let block = ''
  try {
    block = renderFrontmatter({ ...fields(), canonicalUrl: url.href })
  } catch {
    block = ''
  }
  return block === '' ? markdown : `${block}\n${markdown}`
}

/**
 * {@link resolveMarkdownWithSource} for callers that only need the body.
 *
 * Kept as the package-internal shape it has always had so the adapters that
 * do not emit a source-bearing event (the dedicated always-markdown route
 * handler) compile and behave unchanged.
 */
export async function resolveMarkdown(url: URL, config: GatewayConfig): Promise<string | null> {
  const resolution = await resolveMarkdownWithSource(url, config)
  return resolution === null ? null : resolution.markdown
}

/**
 * Wrap rendered markdown in the standard gateway response:
 * `text/markdown; charset=utf-8`, `Vary: Accept` (the same URL serves HTML to
 * browsers — caches must key on Accept), and `X-Rebilder-Path: markdown`.
 */
/**
 * FNV-1a over the rendered body, as an ETag.
 *
 * Hand-rolled because this package has zero runtime dependencies and
 * `crypto.subtle` is async, while this function is not — and an ETag has no
 * business being async. A cache validator is not a security token: it has to
 * change when the body changes, and that is the whole requirement. The byte
 * length is appended so two bodies must collide on both a 64-bit hash and
 * their length to be mistaken for each other.
 *
 * Weak (`W/`) rather than strong: the renderer is deterministic, but a strong
 * ETag promises byte-identity in a way that a future change to line wrapping
 * or ordering would quietly break, and a wrong strong validator is worse than
 * an honest weak one.
 */
function etagFor(body: string): string {
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < body.length; i += 1) {
    hash ^= BigInt(body.charCodeAt(i))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `W/"${hash.toString(16)}-${body.length.toString(16)}"`
}

/**
 * The markdown response.
 *
 * `canonicalUrl` is optional only because the route-handler path may render a
 * document whose canonical URL differs from the request URL. When present it is
 * emitted as `Link: rel="canonical"` — an agent that fetched markdown otherwise
 * has no machine-readable statement of which URL this represents, which matters
 * more here than on an HTML page, since markdown has no `<link>` to carry it.
 *
 * `ETag` makes the response revalidatable. Nothing in the gateway sets
 * `Cache-Control`, and that is deliberate: how long a merchant's facts stay
 * fresh is theirs to declare, and a guess by us would be wrong in whichever
 * direction it erred. A validator with no freshness lifetime is exactly right —
 * caches revalidate every time and get a cheap 304 from the merchant's own CDN
 * when nothing changed.
 */
export function markdownResponse(markdown: string, canonicalUrl?: string, profile?: CompatibilityProfile): Response {
  const headers: Record<string, string> = {
    'content-type': 'text/markdown; charset=utf-8',
    vary: 'Accept',
    'x-rebilder-path': 'markdown',
    etag: etagFor(markdown),
  }
  if (profile) {
    headers['x-rebilder-profile'] = `${profile.id}@${profile.version}`
    headers['x-rebilder-profile-id'] = profile.id
    headers['x-rebilder-profile-version'] = String(profile.version)
  }
  if (canonicalUrl !== undefined) headers.link = `<${canonicalUrl}>; rel="canonical"`
  return new Response(markdown, { status: 200, headers })
}
