/**
 * The universal renderers: any page that is not a product, a policy set, or a
 * catalog. Same signature shape and the same `RenderOptions` as the three
 * commerce renderers, and the same guarantee — pure, deterministic, no clock,
 * no locale, no network, and every substantive value injected from the source
 * object.
 *
 * Block order and truncation are stated once, here and in README.md, and
 * nowhere else:
 *
 *   1. `# [title](url)`                                    required
 *   2. `> summary`                                         required
 *   3. `- **Updated:**` + scalar fact lines                required
 *   4. `## <fact label>` hours table, one per hours fact    required
 *   5. `## Contact`                                        required
 *   6. `## Actions`                                        required
 *   7. `## <section heading>` prose (only when free)       truncatable
 *   8. `## Related`                                        truncatable, first to go
 *
 * `assembleWithBudget` truncates strictly from the bottom, so putting
 * `related` last in the tail is what makes prose survive a tight budget and
 * cross-links drop. The order of that array is load-bearing, not cosmetic.
 *
 * Two ceilings, not one. `maxBytes` governs the truncatable tail as it does
 * for commerce. A second, absolute ceiling at `4 × maxBytes` governs the
 * required blocks, because "facts are never sacrificed" is a safe promise for
 * a PDP with a dozen fields and an unbounded one for a government service page
 * with six twenty-item lists — without the hard ceiling a merchant's own data
 * shape decides our response size.
 */

import type { RenderOptions } from '../types'
import type { TailSection } from '../internal/budget'
import {
  assembleWithBudget,
  byteLength,
  cell,
  clampHeadingLevel,
  DEFAULT_MAX_BYTES,
  heading,
  inline,
  TRUNCATION_NOTE,
} from '../internal/budget'
import type {
  CollectionItemSource,
  CollectionSource,
  DocumentSectionSource,
  DocumentSource,
} from './types'
import {
  ACTIONS_HEADING,
  ADDRESS_LABEL,
  CONTACT_HEADING,
  CONTENTS_HEADING,
  EMAIL_LABEL,
  NOTE_LABEL,
  PHONE_LABEL,
  RELATED_HEADING,
  TITLE_LABEL,
  UPDATED_LABEL,
  accessNotice,
  cellLink,
  factCellText,
  isAllowedUrl,
  isIsoDate,
  linkLabel,
  markdownLink,
  renderFactLine,
  renderHoursBlock,
} from './facts'

/** Hard ceilings. Merchant data shape must not decide our response size. */
const MAX_FACTS = 60
const MAX_ACTIONS = 20
/**
 * Exported so `documents/jsonld.ts` truncates the same listing at the same
 * row. Two ceilings would let the ItemList and the markdown table disagree
 * about how long the collection is, at one URL, for the same requester.
 */
export const MAX_COLLECTION_ROWS = 500
const MAX_COLLECTION_COLUMNS = 12
const HARD_CEILING_MULTIPLE = 4

/**
 * Absolute output cap. `assembleWithBudget` deliberately emits required blocks
 * even when they alone exceed `maxBytes`; this bounds that escape hatch. Cuts
 * are on whole lines, and the truncation note always ends the document.
 */
function applyHardCeiling(out: string, maxBytes: number): string {
  const ceiling = maxBytes * HARD_CEILING_MULTIPLE
  if (byteLength(out) <= ceiling) return out

  const noteSuffix = `\n\n${TRUNCATION_NOTE}`
  const budget = ceiling - byteLength(noteSuffix)
  let kept = ''
  for (const line of out.split('\n')) {
    const next = kept === '' ? line : `${kept}\n${line}`
    if (byteLength(next) > budget) break
    kept = next
  }
  return kept === '' ? TRUNCATION_NOTE : `${kept}${noteSuffix}`
}

/** `> ` prefix on every line; blank lines stay blank inside the quote. */
function blockquote(text: string): string[] {
  return text.split('\n').map((line) => (line.length > 0 ? `> ${line}` : '>'))
}

/**
 * A prose section as a truncatable tail block.
 *
 * `assembleWithBudget` renders a tail block as `headingLine` + blank line +
 * items. A section with a heading maps onto that exactly. A section without
 * one has no heading to put there, so its first body line takes that slot and
 * the blank line the assembler inserts consumes the body's own paragraph
 * break. For prose — where paragraphs are already blank-line separated — this
 * is byte-for-byte verbatim; for a body with no blank line after its first
 * line it inserts one paragraph break. No characters are ever added, removed,
 * or reordered either way.
 */
function sectionTail(section: DocumentSectionSource, level: number): TailSection {
  const lines = section.body.split('\n')
  if (section.heading !== undefined && section.heading.length > 0) {
    return { headingLine: heading(level, inline(section.heading)), items: lines }
  }
  const rest = lines.slice(1)
  if (rest[0] === '') rest.shift()
  return { headingLine: lines[0] ?? '', items: rest }
}

/**
 * Render any non-commerce page as clean markdown. Facts come first: an agent
 * reading top-down gets the whole machine-readable payload before any prose,
 * and prose is the only thing the byte budget can take away.
 */
export function renderDocumentMarkdown(doc: DocumentSource, opts?: RenderOptions): string {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES
  const level = clampHeadingLevel(opts?.headingLevel ?? 1)
  const sub = clampHeadingLevel(level + 1)
  const subSub = clampHeadingLevel(sub + 1)
  const access = doc.access ?? 'free'

  // A document whose own canonical URL is not allowlisted still renders — an
  // agent losing the self-link is better than losing the facts — but it never
  // renders as a link.
  const titleText = isAllowedUrl(doc.url)
    ? markdownLink(doc.title, doc.url)
    : linkLabel(doc.title)

  const updated = doc.updated !== undefined && isIsoDate(doc.updated) ? doc.updated : undefined
  const facts = (doc.facts ?? []).slice(0, MAX_FACTS)

  const factLines: string[] = []
  if (updated !== undefined) factLines.push(`- **${UPDATED_LABEL}:** ${updated}`)
  for (const fact of facts) {
    // Dedup: a top-level `updated` wins over a fact that repeats it. Two
    // "Updated" lines disagreeing is worse than one that might be stale.
    if (updated !== undefined && fact.label.trim().toLowerCase() === UPDATED_LABEL.toLowerCase()) {
      continue
    }
    const line = renderFactLine(fact)
    if (line !== null) factLines.push(line)
  }

  const head: string[] = [heading(level, titleText)]
  if (doc.summary !== undefined && doc.summary.length > 0) {
    head.push('', ...blockquote(doc.summary))
  }
  if (factLines.length > 0) head.push('', ...factLines)

  const requiredBlocks: string[] = [head.join('\n')]

  for (const fact of facts) {
    if (fact.value.type !== 'hours') continue
    const block = renderHoursBlock(fact.label, fact.value.value, sub, subSub)
    if (block !== null) requiredBlocks.push(block)
  }

  const contactLines: string[] = []
  const contact = doc.contact
  if (contact !== undefined) {
    if (contact.phone !== undefined) contactLines.push(`- **${PHONE_LABEL}:** ${inline(contact.phone)}`)
    if (contact.email !== undefined) contactLines.push(`- **${EMAIL_LABEL}:** ${inline(contact.email)}`)
    if (contact.address !== undefined && contact.address.length > 0) {
      contactLines.push(`- **${ADDRESS_LABEL}:** ${contact.address.map(inline).join(', ')}`)
    }
    // No label: there is no whitelisted word for "the contact URL", and
    // inventing one would put renderer prose in the output.
    if (contact.url !== undefined && isAllowedUrl(contact.url)) contactLines.push(`- ${contact.url}`)
  }
  if (contactLines.length > 0) {
    requiredBlocks.push([heading(sub, CONTACT_HEADING), '', ...contactLines].join('\n'))
  }

  const actionLines: string[] = []
  for (const action of (doc.actions ?? []).slice(0, MAX_ACTIONS)) {
    if (!isAllowedUrl(action.url)) continue
    actionLines.push(`- ${markdownLink(action.label, action.url)}`)
    if (action.note !== undefined) actionLines.push(`  - ${inline(action.note)}`)
  }
  if (actionLines.length > 0) {
    requiredBlocks.push([heading(sub, ACTIONS_HEADING), '', ...actionLines].join('\n'))
  }

  if (access !== 'free') requiredBlocks.push(accessNotice(access))

  const tail: TailSection[] = []
  // Mechanical, not a prose rule: `sections` is only ever read on this branch,
  // so no renderer bug below can leak a paywalled body.
  if (access === 'free') {
    for (const section of doc.sections ?? []) tail.push(sectionTail(section, sub))
  }

  const relatedItems: string[] = []
  for (const link of doc.related ?? []) {
    if (!isAllowedUrl(link.url)) continue
    relatedItems.push(`- ${markdownLink(link.title, link.url)}`)
    if (link.note !== undefined) relatedItems.push(`  - ${inline(link.note)}`)
  }
  if (relatedItems.length > 0) {
    tail.push({ headingLine: heading(sub, RELATED_HEADING), items: relatedItems })
  }

  return applyHardCeiling(assembleWithBudget(requiredBlocks, tail, maxBytes), maxBytes)
}

/* ------------------------------------------------------------------ *
 * Collections.
 * ------------------------------------------------------------------ */

/**
 * Exact byte length of `| a | b | c |` given the byte lengths of the cells:
 * two spaces around each cell, one pipe between each pair, one at each end.
 */
function rowBytes(cellByteSum: number, columnCount: number): number {
  return cellByteSum + 3 * columnCount + 1
}

function tableRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

/** One item's cells, in the order their columns should first appear. */
function itemCells(item: CollectionItemSource): { label: string; text: string }[] {
  const cells: { label: string; text: string }[] = []
  if (item.summary !== undefined && item.summary.length > 0) {
    cells.push({ label: NOTE_LABEL, text: cell(item.summary) })
  }
  for (const fact of item.facts ?? []) {
    const text = factCellText(fact.value, item.url)
    if (text === null) continue
    cells.push({ label: cell(fact.label), text })
  }
  return cells
}

function titleCell(item: CollectionItemSource): string {
  return isAllowedUrl(item.url) ? cellLink(item.title, item.url) : cell(item.title)
}

/**
 * Render a listing page. Two deterministic modes and no third: if no item
 * carries facts the output is a link list, otherwise it is a table.
 *
 * The table's columns are the ordered union of fact labels by first
 * appearance, accumulated in the SAME streaming pass that spends the byte
 * budget. That is the whole point: compute the union first and the header can
 * advertise columns belonging only to rows the budget then drops, which is a
 * table of empty cells describing data we did not send. Byte accounting is
 * exact rather than estimated (see `rowBytes`), so the pass never has to
 * re-render to find out whether it overshot.
 *
 * An item `summary` occupies a `Note` column, positioned by the same
 * first-appearance rule. A merchant fact literally labelled `Note` on an item
 * that also has a summary collides; the summary wins, because it was written
 * for the listing.
 */
export function renderCollectionMarkdown(
  collection: CollectionSource,
  opts?: RenderOptions,
): string {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES
  const level = clampHeadingLevel(opts?.headingLevel ?? 1)

  const title = collection.title !== undefined ? collection.title : CONTENTS_HEADING
  const titleText = isAllowedUrl(collection.url)
    ? markdownLink(title, collection.url)
    : linkLabel(title)
  const head = heading(level, titleText)

  const items = collection.items
  if (items.length === 0) return head

  const noteSuffix = `\n\n${TRUNCATION_NOTE}`
  const budget = maxBytes - byteLength(noteSuffix)
  const anyFacts = items.some((item) => (item.facts ?? []).length > 0)

  if (!anyFacts) return linkList(head, items, budget)

  // Streaming pass: columns and rows grow together, bounded by `budget`.
  const columns: string[] = []
  const rows: Map<string, string>[] = []
  let headerCellBytes = byteLength(TITLE_LABEL)
  let bodyCellBytes = 0
  let truncated = false

  // head + '\n\n' + headerRow + '\n' + separatorRow + ('\n' + row) per row.
  // Separator cells are always '---', i.e. 3 bytes each.
  const base = byteLength(head) + 2
  const totalBytes = (columnCount: number, rowCount: number): number =>
    base +
    rowBytes(headerCellBytes, columnCount) +
    1 +
    rowBytes(3 * columnCount, columnCount) +
    bodyCellBytes +
    rowCount * (3 * columnCount + 2)

  for (const item of items) {
    if (rows.length >= MAX_COLLECTION_ROWS) {
      truncated = true
      break
    }

    const cells = itemCells(item)
    const values = new Map<string, string>()
    const newColumns: string[] = []
    for (const { label, text } of cells) {
      if (values.has(label)) continue // first write wins within a row
      if (!columns.includes(label) && !newColumns.includes(label)) {
        if (columns.length + newColumns.length >= MAX_COLLECTION_COLUMNS) continue
        newColumns.push(label)
      }
      values.set(label, text)
    }
    values.set(TITLE_LABEL, titleCell(item))

    const nextColumnCount = 1 + columns.length + newColumns.length
    const addedHeaderBytes = newColumns.reduce((sum, label) => sum + byteLength(label), 0)
    const addedBodyBytes = [...values.values()].reduce((sum, text) => sum + byteLength(text), 0)

    const savedHeader = headerCellBytes
    const savedBody = bodyCellBytes
    headerCellBytes += addedHeaderBytes
    bodyCellBytes += addedBodyBytes
    if (totalBytes(nextColumnCount, rows.length + 1) > budget) {
      headerCellBytes = savedHeader
      bodyCellBytes = savedBody
      truncated = true
      break
    }

    columns.push(...newColumns)
    rows.push(values)
  }

  // No row fit. A bare header advertises columns nothing fills — exactly what
  // the streaming pass exists to prevent — so emit no table at all.
  if (rows.length === 0) return `${head}${noteSuffix}`

  const header = [TITLE_LABEL, ...columns]
  const lines = [
    head,
    '',
    tableRow(header),
    tableRow(header.map(() => '---')),
    ...rows.map((values) => tableRow(header.map((label) => values.get(label) ?? ''))),
  ]
  const out = lines.join('\n')
  return truncated ? `${out}${noteSuffix}` : out
}

/** Link-list mode: whole entries only, dropped from the bottom. */
function linkList(head: string, items: CollectionItemSource[], budget: number): string {
  const noteSuffix = `\n\n${TRUNCATION_NOTE}`
  let out = head
  let truncated = false
  let rendered = 0

  for (const item of items) {
    if (rendered >= MAX_COLLECTION_ROWS) {
      truncated = true
      break
    }
    const link = isAllowedUrl(item.url)
      ? markdownLink(item.title, item.url)
      : inline(item.title)
    const entry: string[] = [`- ${link}`]
    if (item.summary !== undefined && item.summary.length > 0) {
      entry.push(`  - ${inline(item.summary)}`)
    }
    const next = `${out}${rendered === 0 ? '\n\n' : '\n'}${entry.join('\n')}`
    if (byteLength(next) > budget) {
      truncated = true
      break
    }
    out = next
    rendered += 1
  }

  return truncated ? `${out}${noteSuffix}` : out
}
