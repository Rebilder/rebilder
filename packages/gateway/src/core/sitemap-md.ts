/**
 * `/sitemap.md`: the site's pages as a markdown list an agent can read without
 * parsing XML.
 *
 * Same contract as llms.txt (core/llms-txt.ts): deterministic, and every
 * title, URL and note comes verbatim from the merchant's sources or options.
 * The only text this adds is the `# Sitemap` heading when no title is given,
 * and the three auto section names llms.txt already uses.
 *
 * The difference from llms.txt is scope. llms.txt is a short, curated summary
 * of a site; sitemap.md is the full list of pages. List canonical page URLs
 * here, not `.md` aliases: an agent that wants markdown asks the page for it,
 * and one index should not name every page twice.
 */
import { renderSection, sourceSections, type LlmsTxtSection } from './llms-txt'
import type { GatewayConfig } from './types'

export interface SitemapMdOptions {
  /**
   * Your site's base URL. The configured `catalog`, `collection` and
   * `policies` sources are asked for it exactly as llms.txt asks them, and
   * what they return becomes the Products, Pages and Policies sections.
   */
  baseUrl: string
  /** The H1. Default `Sitemap`. Injected verbatim. */
  title?: string
  /** An optional one-line description, rendered as a blockquote. */
  description?: string
  /** Your own sections, after the automatic ones, in order. Empty sections are left out. */
  sections?: LlmsTxtSection[]
}

/** Generate the sitemap.md document. Deterministic; safe to cache hard. */
export async function generateSitemapMd(
  config: GatewayConfig,
  options: SitemapMdOptions,
): Promise<string> {
  const lines: string[] = [`# ${options.title ?? 'Sitemap'}`]
  if (options.description !== undefined && options.description !== '') {
    lines.push('', `> ${options.description}`)
  }
  const auto = await sourceSections(config, new URL(options.baseUrl))
  for (const section of [...auto, ...(options.sections ?? [])]) {
    lines.push(...renderSection(section))
  }
  return `${lines.join('\n')}\n`
}
