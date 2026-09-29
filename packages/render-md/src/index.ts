/**
 * @rebilder/render-md — source-of-truth → markdown/JSON-LD renderer for
 * commerce pages (PDP, policies, catalog).
 *
 * Framework-agnostic, zero runtime dependencies, pure and deterministic.
 * Every substantive value in the output is injected from the source object;
 * this package never invents, estimates, or rewords prices, availability,
 * claims, or policy text. See README.md for the full contract.
 */

export type {
  Availability,
  CatalogItemSource,
  Money,
  PolicySource,
  ProductSource,
  ProductVariantSource,
  RenderOptions,
  ReturnsSource,
  ShippingSource,
} from './types'

export { formatMoney } from './money'
export { renderProductJsonLd } from './jsonld'
export { renderCatalogMarkdown, renderPolicyMarkdown, renderProductMarkdown } from './markdown'

/* -------------------------------------------------------------------- *
 * Universal surface: any page that is not a product, policy set, or
 * catalog. Additive — nothing above this line changed when it landed.
 * -------------------------------------------------------------------- */

export type {
  ActionKind,
  ActionSource,
  BillingPeriod,
  CollectionItemSource,
  CollectionSource,
  ContactSource,
  DocumentAccess,
  DocumentKind,
  DocumentSectionSource,
  DocumentSource,
  Fact,
  FactValue,
  HoursException,
  HoursInterval,
  HoursRule,
  HoursSpec,
  LinkSource,
  Weekday,
} from './documents/types'

export { renderCollectionMarkdown, renderDocumentMarkdown } from './documents/markdown'
export { renderCollectionJsonLd } from './documents/jsonld'

/**
 * The fixed label maps are part of the contract, not an implementation
 * detail: a consumer building its own surface over the same source objects
 * must be able to reproduce our rendering exactly, and a scorer checking a
 * page against the spec needs the same vocabulary we emit.
 */
export {
  ACCESS_LABELS,
  ALLOWED_URL_SCHEMES,
  BOOLEAN_LABELS,
  CLOSED_LABEL,
  NOT_STATED_LABEL,
  PERIOD_SUFFIX,
  SEE_PAGE_LABEL,
  WEEKDAY_LABELS,
  WEEKDAY_ORDER,
} from './documents/facts'

export {
  applyCompatibilityProfile,
  BASELINE_PROFILE,
  COMPATIBILITY_RUNTIME_VERSION,
  validateCompatibilityProfile,
} from './compatibility'
export type { CompatibilityProfile, CompatibilityRendering } from './compatibility'

/**
 * Opt-in YAML frontmatter (title, description, canonical URL, last updated).
 * Additive: no renderer above calls it, so their output is unchanged.
 */
export { FRONTMATTER_MAX_BYTES, renderFrontmatter } from './frontmatter'
export type { FrontmatterFields } from './frontmatter'
