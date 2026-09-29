/**
 * llms.txt generation (ROADMAP Phase 1 P0 — "cheap, low-risk; not the
 * strategy").
 *
 * Honest scope note (VISION § Market Context): content negotiation
 * (`Accept: text/markdown`) measured ~4.2x more effective than llms.txt for
 * accurate retrieval, and llms.txt alone shows no citation lift. We ship it
 * because it costs nothing to serve, some agents fetch it, and merchants ask
 * for it — the gateway's markdown path is the strategy, this file is not.
 *
 * Contract (source validation applies exactly as everywhere else): the output is a
 * deterministic, injected-values-only format transformation. No LLM, no
 * generated copy — every title, URL, price, and note comes verbatim from the
 * merchant's sources or the caller's options. Same input → same output.
 *
 * Output follows the llms.txt spec shape: H1 site name, blockquote
 * description, H2 sections of markdown link lists (`- [title](url): note`).
 */

import { formatMoney } from '@rebilder/render-md'
import { callSource } from './render'
import type { GatewayConfig } from './types'

/** One link line in an llms.txt section: `- [title](url)` or `- [title](url): note`. */
export interface LlmsTxtLink {
  title: string
  url: string
  /** Optional short annotation after the link. Injected verbatim. */
  note?: string
}

/** One H2 section of an llms.txt file. Sections with no links are omitted. */
export interface LlmsTxtSection {
  title: string
  links: LlmsTxtLink[]
}

export interface LlmsTxtOptions {
  /**
   * The store's canonical base URL (e.g. `https://store.example.com`). The
   * configured `catalog`/`collection`/`policies` sources are called with
   * `new URL(baseUrl)` to enumerate site-wide entries — wire them to return
   * the full catalog / page list / policy list for the base URL if you want
   * auto-generated sections.
   */
  baseUrl: string
  /** Site name — the H1. Injected verbatim. */
  siteName: string
  /** One-line site description — the blockquote. Injected verbatim. */
  description: string
  /** Manual sections, appended after the auto-generated ones, in order. */
  sections?: LlmsTxtSection[]
}

function renderLink(link: LlmsTxtLink): string {
  const base = `- [${link.title}](${link.url})`
  return link.note === undefined ? base : `${base}: ${link.note}`
}

/**
 * Render one `## title` section; a section with no links renders nothing.
 * Package-internal; sitemap.md renders its sections the same way.
 */
export function renderSection(section: LlmsTxtSection): string[] {
  if (section.links.length === 0) return []
  return ['', `## ${section.title}`, '', ...section.links.map(renderLink)]
}

/**
 * Price note for an auto catalog entry. formatMoney fails closed on malformed
 * amounts (it never rounds a price — source validation); a bad price simply omits
 * the note rather than breaking the whole file or emitting a wrong value.
 */
function priceNote(price: Parameters<typeof formatMoney>[0]): string | undefined {
  try {
    return formatMoney(price)
  } catch {
    return undefined
  }
}

/**
 * A collection item's summary as a link note. Omitted when it spans lines: an
 * llms.txt link is one line, and a note carrying a newline would break the
 * file's structure for every reader after it. Same fail-closed shape as
 * `priceNote` — omit rather than emit something wrong, and never reflow the
 * merchant's prose to make it fit.
 */
function summaryNote(summary: string | undefined): string | undefined {
  if (summary === undefined || summary.includes('\n')) return undefined
  return summary
}

/**
 * Generate the llms.txt document for a store.
 *
 * - Always: `# siteName` + `> description`.
 * - If `config.sources.catalog` enumerates for `new URL(baseUrl)` (it may
 *   return `null` or throw — both are handled as "nothing to list"), a
 *   `## Products` section is generated from the returned items (title, URL,
 *   price note). Likewise `config.sources.collection` → `## Pages` (title,
 *   URL, single-line summary) and `config.sources.policies` → `## Policies`.
 * - `options.sections` are appended after the auto sections, in given order.
 *
 * Section order is Products → Pages → Policies. `## Pages` was appended to
 * this function after the other two shipped, and it is placed between them
 * rather than at the end for one reason: a config with no `collection` source
 * — which is every config that predates it — must produce byte-identical
 * output, and it does, because an unconfigured source resolves to null
 * without emitting a line.
 *
 * Deterministic: no clock, no randomness, no LLM — safe to cache hard.
 */
export async function generateLlmsTxt(
  config: GatewayConfig,
  options: LlmsTxtOptions,
): Promise<string> {
  const lines: string[] = [`# ${options.siteName}`, '', `> ${options.description}`]
  const auto = await sourceSections(config, new URL(options.baseUrl))
  for (const section of [...auto, ...(options.sections ?? [])]) {
    lines.push(...renderSection(section))
  }
  return `${lines.join('\n')}\n`
}

/**
 * The sections the configured sources enumerate for `base`: Products, then
 * Pages, then Policies, each only when its source returns entries. Shared by
 * llms.txt and sitemap.md so the two list a store's pages the same way.
 * Package-internal.
 */
export async function sourceSections(config: GatewayConfig, base: URL): Promise<LlmsTxtSection[]> {
  const sections: LlmsTxtSection[] = []

  const catalog = await callSource(config.sources.catalog, base)
  if (catalog !== null && catalog.length > 0) {
    sections.push({
      title: 'Products',
      links: catalog.map((item) => {
        const note = priceNote(item.price)
        return { title: item.title, url: item.url, ...(note !== undefined ? { note } : {}) }
      }),
    })
  }

  const collection = await callSource(config.sources.collection, base)
  if (collection !== null && Array.isArray(collection.items) && collection.items.length > 0) {
    sections.push({
      title: 'Pages',
      links: collection.items.map((item) => {
        const note = summaryNote(item.summary)
        return { title: item.title, url: item.url, ...(note !== undefined ? { note } : {}) }
      }),
    })
  }

  const policies = await callSource(config.sources.policies, base)
  if (policies !== null && policies.length > 0) {
    sections.push({
      title: 'Policies',
      links: policies.map((policy) => ({ title: policy.title, url: policy.url })),
    })
  }

  return sections
}
