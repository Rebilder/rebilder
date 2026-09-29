/**
 * Source-of-truth input types for @rebilder/render-md.
 *
 * Every field on these types is treated as authoritative merchant data. The
 * renderers in this package only transform format — they never invent,
 * estimate, or reword any value found here (source validation).
 */

/** Monetary value. `amount` is in minor units (e.g. cents for USD). */
export interface Money {
  amount: number
  currency: string
}

/** Stock state, as reported by the merchant source of truth. */
export type Availability = 'in_stock' | 'out_of_stock' | 'preorder' | 'backorder'

export interface ProductVariantSource {
  id: string
  title: string
  price: Money
  availability: Availability
  sku?: string
  options?: Record<string, string>
}

export interface ShippingSource {
  /** Merchant-authored shipping summary. Rendered verbatim. */
  summary: string
  freeThreshold?: Money
  regions?: string[]
  /** [min, max] delivery estimate in days, from the merchant. */
  etaDays?: [number, number]
}

export interface ReturnsSource {
  /** Merchant-authored returns summary. Rendered verbatim. */
  summary: string
  windowDays?: number
  url?: string
}

export interface ProductSource {
  url: string
  title: string
  brand?: string
  description?: string
  price: Money
  compareAtPrice?: Money
  availability: Availability
  variants?: ProductVariantSource[]
  shipping?: ShippingSource
  returns?: ReturnsSource
  images?: { url: string; alt?: string }[]
  /** Material, size chart facts, etc. — rendered verbatim. */
  attributes?: Record<string, string>
  /**
   * When this product's facts last changed, ISO 8601, verbatim. Same field
   * name and same validation as `DocumentSource.updated`.
   *
   * This is the freshness contract an agent needs in order to decide whether a
   * cached copy is still usable. Without it a caller has only the transport's
   * `Last-Modified`, which describes the response and not the product. Renders
   * as `dateModified` in the JSON-LD and as an `Updated` fact line in the
   * markdown; a malformed value is dropped from both.
   */
  updated?: string
  /**
   * BCP 47 language tag of this page's prose, verbatim (`en`, `pt-BR`,
   * `zh-Hant-TW`). Emitted as `inLanguage`.
   *
   * Localized storefronts serve the same SKU at several URLs, and a caller
   * comparing them has no way to tell a translation from a distinct product
   * unless the page says so. Paired with `price.currency`, which the offer
   * already carries as `priceCurrency`. A malformed tag is dropped.
   */
  language?: string
}

export interface PolicySource {
  title: string
  url: string
  /** Policy text. Rendered verbatim — never summarized or reworded. */
  body: string
}

export interface CatalogItemSource {
  url: string
  title: string
  price: Money
  availability: ProductSource['availability']
}

export interface RenderOptions {
  /** Output size budget in UTF-8 bytes. Default 5120. */
  maxBytes?: number
  /** Markdown heading level for the top-level heading (1–6). Default 1. */
  headingLevel?: number
}
