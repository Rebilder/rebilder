import type {
  Availability,
  CatalogItemSource,
  PolicySource,
  ProductSource,
  ProductVariantSource,
  RenderOptions,
} from './types'
import { formatMoney } from './money'
import type { TailSection } from './internal/budget'
import {
  assembleWithBudget,
  byteLength,
  cell,
  cellLinkText,
  clampHeadingLevel,
  DEFAULT_MAX_BYTES,
  heading,
  inline,
  isSafeUrl,
  safeLink,
  TRUNCATION_NOTE,
} from './internal/budget'
import { isIsoDate } from './internal/validate'

/** Deterministic human labels for the availability enum (format mapping, not content). */
const AVAILABILITY_LABELS: Record<Availability, string> = {
  in_stock: 'In stock',
  out_of_stock: 'Out of stock',
  preorder: 'Preorder',
  backorder: 'Backorder',
}

function etaText(eta: [number, number]): string {
  const [min, max] = eta
  return min === max ? `${min} days` : `${min}-${max} days`
}

function variantsTable(variants: ProductVariantSource[], level: number): string {
  const lines = [
    heading(level, 'Variants'),
    '',
    '| ID | Title | Options | Price | Availability |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const v of variants) {
    const options =
      v.options !== undefined
        ? Object.entries(v.options)
            .map(([key, value]) => `${cell(key)}: ${cell(value)}`)
            .join('; ')
        : ''
    lines.push(
      `| ${cell(v.id)} | ${cell(v.title)} | ${options} | ${formatMoney(v.price)} | ${AVAILABILITY_LABELS[v.availability]} |`,
    )
  }
  return lines.join('\n')
}

/**
 * Render a product detail page as clean markdown. Buying facts come first:
 * title, price, availability, shipping, and returns all land in the opening
 * lines so an agent reading top-down never misses them. Every substantive
 * value is injected from `p` — nothing is invented or reworded.
 */
export function renderProductMarkdown(p: ProductSource, opts?: RenderOptions): string {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES
  const level = clampHeadingLevel(opts?.headingLevel ?? 1)
  const sub = clampHeadingLevel(level + 1)

  const facts: string[] = [heading(level, safeLink(p.title, p.url)), '']
  if (p.brand !== undefined) facts.push(`- **Brand:** ${inline(p.brand)}`)
  const price = formatMoney(p.price)
  facts.push(
    p.compareAtPrice !== undefined
      ? `- **Price:** ~~${formatMoney(p.compareAtPrice)}~~ ${price}`
      : `- **Price:** ${price}`,
  )
  facts.push(`- **Availability:** ${AVAILABILITY_LABELS[p.availability]}`)
  if (p.shipping !== undefined) {
    facts.push(`- **Shipping:** ${inline(p.shipping.summary)}`)
    if (p.shipping.freeThreshold !== undefined) {
      facts.push(`  - Free shipping threshold: ${formatMoney(p.shipping.freeThreshold)}`)
    }
    if (p.shipping.regions !== undefined && p.shipping.regions.length > 0) {
      facts.push(`  - Ships to: ${p.shipping.regions.map(inline).join(', ')}`)
    }
    if (p.shipping.etaDays !== undefined) {
      facts.push(`  - Delivery estimate: ${etaText(p.shipping.etaDays)}`)
    }
  }
  if (p.returns !== undefined) {
    facts.push(`- **Returns:** ${inline(p.returns.summary)}`)
    if (p.returns.windowDays !== undefined) {
      facts.push(`  - Return window: ${p.returns.windowDays} days`)
    }
    if (p.returns.url !== undefined && isSafeUrl(p.returns.url)) {
      facts.push(`  - Policy: ${p.returns.url}`)
    }
  }
  // Last in the fact block, not first: `updated` is metadata about the facts
  // rather than one of the buying facts, and every line inserted above
  // `- **Availability:**` pushes a core fact further from the top of the
  // document (ARS D4 scores that byte offset). The label matches the document
  // renderer's `UPDATED_LABEL`; `tests/jsonld.test.ts` pins the two together.
  if (p.updated !== undefined && isIsoDate(p.updated)) {
    facts.push(`- **Updated:** ${inline(p.updated)}`)
  }

  const requiredBlocks: string[] = [facts.join('\n')]
  if (p.variants !== undefined && p.variants.length > 0) {
    requiredBlocks.push(variantsTable(p.variants, sub))
  }

  const tail: TailSection[] = []
  if (p.description !== undefined && p.description.length > 0) {
    tail.push({ headingLine: heading(sub, 'Description'), items: p.description.split('\n') })
  }
  if (p.attributes !== undefined) {
    const items = Object.entries(p.attributes).map(
      ([key, value]) => `- **${inline(key)}:** ${inline(value)}`,
    )
    if (items.length > 0) tail.push({ headingLine: heading(sub, 'Details'), items })
  }
  if (p.images !== undefined && p.images.length > 0) {
    const items = p.images.map((img) => {
      const label = img.alt !== undefined && img.alt.length > 0 ? img.alt : img.url
      return `- ${safeLink(label, img.url)}`
    })
    tail.push({ headingLine: heading(sub, 'Images'), items })
  }

  return assembleWithBudget(requiredBlocks, tail, maxBytes)
}

/**
 * Render store policies as markdown. Each policy is a linked heading followed
 * by its body byte-for-byte verbatim. Under the byte budget, whole policies
 * are kept in order; a policy whose body does not fit degrades to its linked
 * title (policy text is never partially rendered), and the document ends with
 * the truncation note.
 */
export function renderPolicyMarkdown(policies: PolicySource[], opts?: RenderOptions): string {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES
  const level = clampHeadingLevel(opts?.headingLevel ?? 1)

  const titleLineFor = (pol: PolicySource): string => heading(level, safeLink(pol.title, pol.url))
  const blocks = policies.map((pol) => `${titleLineFor(pol)}\n\n${pol.body}`)
  const full = blocks.join('\n\n')
  if (byteLength(full) <= maxBytes) return full

  const noteSuffix = `\n\n${TRUNCATION_NOTE}`
  const budget = maxBytes - byteLength(noteSuffix)
  let out = ''
  for (const pol of policies) {
    const titleLine = titleLineFor(pol)
    const block = `${titleLine}\n\n${pol.body}`
    const withBlock = out === '' ? block : `${out}\n\n${block}`
    if (byteLength(withBlock) <= budget) {
      out = withBlock
      continue
    }
    const withTitle = out === '' ? titleLine : `${out}\n\n${titleLine}`
    if (byteLength(withTitle) <= budget) out = withTitle
    break // truncate strictly from the bottom
  }
  return out === '' ? TRUNCATION_NOTE : `${out}${noteSuffix}`
}

/**
 * Render a catalog listing as a markdown table (title → link, price,
 * availability). Under the byte budget, whole rows are dropped from the
 * bottom and the truncation note is appended.
 */
export function renderCatalogMarkdown(items: CatalogItemSource[], opts?: RenderOptions): string {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES
  const level = clampHeadingLevel(opts?.headingLevel ?? 1)

  const head = [
    heading(level, 'Catalog'),
    '',
    '| Title | Price | Availability |',
    '| --- | --- | --- |',
  ].join('\n')
  const rows = items.map(
    (item) =>
      `| ${safeLink(item.title, item.url, cellLinkText)} | ${formatMoney(item.price)} | ${AVAILABILITY_LABELS[item.availability]} |`,
  )
  const full = [head, ...rows].join('\n')
  if (byteLength(full) <= maxBytes) return full

  const noteSuffix = `\n\n${TRUNCATION_NOTE}`
  const budget = maxBytes - byteLength(noteSuffix)
  let out = head
  for (const row of rows) {
    const next = `${out}\n${row}`
    if (byteLength(next) > budget) break
    out = next
  }
  return `${out}${noteSuffix}`
}
