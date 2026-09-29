/**
 * `CollectionSource` → schema.org `ItemList` JSON-LD.
 *
 * The listing counterpart to `src/jsonld.ts`'s `Product`. Before this existed,
 * a collection served through the universal gateway carried a markdown table
 * and no structured data at all, so a caller that reads JSON-LD first — and a
 * scorer looking for a recognised type — found nothing on a page whose entire
 * purpose is enumerating things.
 *
 * Injection-only, on the same terms as every other renderer here:
 *
 * - `name` is emitted ONLY when the source supplies a title. The markdown
 *   renderer falls back to the fixed `Contents` heading because a document
 *   needs a heading for structure; JSON-LD does not, and emitting the fallback
 *   would make this package assert a name the merchant never wrote.
 * - URLs pass the same scheme allowlist the markdown path uses. A `ListItem`
 *   whose URL is rejected still renders with its name — the item exists, we
 *   just decline to publish a link to it. Skipping this check would make the
 *   JSON-LD a `javascript:` sink that the markdown renderer already blocks.
 * - `numberOfItems` counts the elements ACTUALLY EMITTED, not `items.length`.
 *   A 900-item listing truncates to `MAX_COLLECTION_ROWS`, and a document that
 *   announced 900 while listing 500 would be internally inconsistent — an
 *   agent trusting the count would page for items that are not there.
 * - Item facts are not projected into the list. `ListItem` has no honest slot
 *   for an arbitrary labelled fact, and inventing property names for merchant
 *   labels is exactly the inference this package does not do. The facts are in
 *   the markdown table, which is where the renderer's contract puts them.
 */

import type { CollectionItemSource, CollectionSource } from './types'
import { isAllowedUrl } from './facts'
import { MAX_COLLECTION_ROWS } from './markdown'
import { isIsoDate, isLanguageTag } from '../internal/validate'

function listItem(item: CollectionItemSource, position: number): Record<string, unknown> {
  const out: Record<string, unknown> = { '@type': 'ListItem', position }
  if (isAllowedUrl(item.url)) out.url = item.url
  out.name = item.title
  return out
}

/**
 * Render a schema.org ItemList from a collection source. Pure, deterministic,
 * and fixed in key order for snapshot stability — same contract as
 * `renderProductJsonLd`.
 */
export function renderCollectionJsonLd(collection: CollectionSource): Record<string, unknown> {
  const out: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
  }
  if (isAllowedUrl(collection.url)) out.url = collection.url
  if (collection.title !== undefined) out.name = collection.title
  if (collection.language !== undefined && isLanguageTag(collection.language)) {
    out.inLanguage = collection.language
  }

  const elements = collection.items
    .slice(0, MAX_COLLECTION_ROWS)
    .map((item, index) => listItem(item, index + 1))

  out.numberOfItems = elements.length
  out.itemListElement = elements
  if (collection.updated !== undefined && isIsoDate(collection.updated)) {
    out.dateModified = collection.updated
  }
  return out
}
