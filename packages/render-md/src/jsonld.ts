import type { Availability, Money, ProductSource } from './types'
import { toDecimalString } from './money'
import { isIsoDate, isLanguageTag } from './internal/validate'

/** Availability enum → schema.org ItemAvailability URL. */
const SCHEMA_AVAILABILITY: Record<Availability, string> = {
  in_stock: 'https://schema.org/InStock',
  out_of_stock: 'https://schema.org/OutOfStock',
  preorder: 'https://schema.org/PreOrder',
  backorder: 'https://schema.org/BackOrder',
}

function offer(
  price: Money,
  availability: Availability,
  extra: { url?: string; sku?: string; name?: string },
): Record<string, unknown> {
  const o: Record<string, unknown> = {
    '@type': 'Offer',
    price: toDecimalString(price),
    priceCurrency: price.currency,
    availability: SCHEMA_AVAILABILITY[availability],
  }
  if (extra.url !== undefined) o.url = extra.url
  if (extra.sku !== undefined) o.sku = extra.sku
  if (extra.name !== undefined) o.name = extra.name
  return o
}

/**
 * Render a schema.org Product JSON-LD object from the product source.
 * Injection-only: every value comes from `p`; only fields present in the
 * source appear in the output. Key order is fixed for snapshot stability.
 *
 * `inLanguage` and `dateModified` are emitted only when the source value
 * passes its shape check. A malformed value is dropped rather than repaired or
 * reformatted: this renderer feeds `/acp/v0/feed` and the MCP product tool as
 * well as the canonical page, and a date this package invented would be a
 * substantive value it originated (source validation) — in a product feed, where it
 * would read as authoritative.
 */
export function renderProductJsonLd(p: ProductSource): Record<string, unknown> {
  const out: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.title,
    url: p.url,
  }
  if (p.brand !== undefined) out.brand = { '@type': 'Brand', name: p.brand }
  if (p.description !== undefined && p.description.length > 0) out.description = p.description
  if (p.images !== undefined && p.images.length > 0) out.image = p.images.map((img) => img.url)
  if (p.language !== undefined && isLanguageTag(p.language)) out.inLanguage = p.language
  out.offers =
    p.variants !== undefined && p.variants.length > 0
      ? p.variants.map((v) => offer(v.price, v.availability, { sku: v.sku, name: v.title }))
      : offer(p.price, p.availability, { url: p.url })
  // After `offers` deliberately: the buying facts stay in the same position
  // they have always occupied, so a diff of two feed records shows the new
  // freshness key appended rather than every offer key shifted down one line.
  if (p.updated !== undefined && isIsoDate(p.updated)) out.dateModified = p.updated
  return out
}
