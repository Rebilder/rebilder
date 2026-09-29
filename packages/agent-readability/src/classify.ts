/**
 * classify.ts — the two-pass page-kind classifier (design §3.5).
 *
 * THE CIRCULARITY THIS RESOLVES. Fact extraction needs a profile; the profile
 * comes from the page kind; the page kind looks like something you would infer
 * from the facts. Every source design had that loop and none of them cut it. The
 * decided answer is two passes with a hard wall between them:
 *
 *   PASS 1 extracts a FIXED, KIND-INDEPENDENT probe set — JSON-LD `@type`,
 *   microdata `itemtype`, RDFa `typeof`, `og:type`, URL path grammar,
 *   currency-token presence, day-name/`HH:MM` adjacency, and `tel:` presence.
 *   **Only pass-1 output may inform classification.** Nothing in this file reads
 *   a profile, and `pass1Signals()` takes no page kind.
 *
 *   PASS 2 (`./extract`) extracts against the resolved profile.
 *
 * Because pass 1 is fixed, two implementations classify the same bytes the same
 * way, and because it is small, a reader can check that it is fixed.
 *
 * PRECEDENCE, from §3.5: JSON-LD `@type` (through a pinned table) → microdata /
 * RDFa → `og:type` → URL path patterns → pass-1 structural signals. Ties are
 * broken by declared precedence, then lexicographically by `@type`.
 *
 * CONFIDENCE, AND WHY `unknown` IS NOT A PENALTY BOX. Below `medium` confidence
 * the kind is `unknown` — **we never guess into a vertical**, because guessing
 * `product` on an article scores that article against a fact set it has no
 * reason to carry, and the merchant cannot argue with a number. `unknown` is
 * also not an easy exit: it carries its own profile (title, description,
 * primary-action-url) and still scores D5.2 against "any recognised schema.org
 * type present", so hiding your page kind costs up to 7 points and gains nothing.
 *
 * THE TABLES BELOW ARE VERSIONED DATA. Adding a schema.org type or a URL pattern
 * changes the kind of some real page, which changes its profile, which changes
 * its score — so additions land as a MINOR, exactly like a ruleset edit. They
 * live here rather than in `DEFAULT_RULESET` because §3.9's `ArsRuleset` has no
 * field for them; that means they are NOT covered by `rulesetHash`, and the gap
 * is recorded in the package README as a known limitation of 0.1.
 */

import type { ArsRepresentation, JsonLdNode } from './extract'
import { absoluteUrl, findMoneyPhrases, hasOpeningHoursShape } from './extract'
import { attr } from './html'
import { parseMoneyText } from './parse-money'
import type { ArsPageKind } from './types'

// ---------------------------------------------------------------------------
// Pass 1 — the fixed, kind-independent probe set
// ---------------------------------------------------------------------------

export interface ArsPass1Signals {
  /** `@type` values from every JSON-LD node, prefix-stripped, document order. */
  readonly jsonLdTypes: readonly string[]
  /** `itemtype` values, reduced to their final path segment. */
  readonly microdataTypes: readonly string[]
  /** RDFa `typeof` values, whitespace-split. */
  readonly rdfaTypes: readonly string[]
  /** `<meta property="og:type">`, lowercased. */
  readonly ogType: string | null
  /** Lowercased, non-empty path segments of the target URL. */
  readonly pathSegments: readonly string[]
  /** At least one substring that `parseMoneyText` accepts. */
  readonly hasCurrencyToken: boolean
  /** A day name within 40 characters of a clock time. */
  readonly hasOpeningHours: boolean
  /** A `tel:` link, or a `telephone` property in structured data. */
  readonly hasTelephone: boolean
}

/**
 * Runs pass 1 over a representation. Takes the target URL rather than the
 * capture's final URL: the URL an operator typed is the one whose path grammar
 * describes their intent, and a redirect to a tracking URL should not reclassify
 * the page.
 */
export function pass1Signals(
  representation: ArsRepresentation,
  targetUrl: string,
): ArsPass1Signals {
  const jsonLdTypes: string[] = []
  let hasTelephone = false
  for (const node of representation.jsonLd.nodes) {
    for (const type of node.types) jsonLdTypes.push(type)
    if (typeof node.value['telephone'] === 'string') hasTelephone = true
  }

  const microdataTypes: string[] = []
  const rdfaTypes: string[] = []
  if (representation.doc !== null) {
    for (const element of representation.doc.elements) {
      const itemtype = attr(element, 'itemtype')
      if (itemtype !== null) {
        for (const token of itemtype.split(/\s+/)) {
          const segment = token.split('/').pop()
          if (segment !== undefined && segment.length > 0) microdataTypes.push(segment)
        }
      }
      const typeOf = attr(element, 'typeof')
      if (typeOf !== null) {
        for (const token of typeOf.split(/\s+/)) {
          const segment = token.split(/[/:]/).pop()
          if (segment !== undefined && segment.length > 0) rdfaTypes.push(segment)
        }
      }
      if (element.tag === 'a') {
        const href = attr(element, 'href')
        if (href !== null && href.toLowerCase().startsWith('tel:')) hasTelephone = true
      }
    }
  }

  let ogType: string | null = null
  if (representation.doc !== null) {
    for (const meta of representation.doc.metas) {
      if (meta.property === 'og:type' && meta.content !== null) {
        ogType = meta.content.trim().toLowerCase()
        break
      }
    }
  }

  const text = representation.text
  let hasCurrencyToken = false
  for (const money of findMoneyPhrases(text)) {
    if (parseMoneyText(money.phrase) !== null) {
      hasCurrencyToken = true
      break
    }
  }
  if (!hasTelephone) hasTelephone = /\btel:\+?[0-9()\-. ]{7,}/.test(text)

  return {
    jsonLdTypes,
    microdataTypes,
    rdfaTypes,
    ogType,
    pathSegments: pathSegmentsOf(targetUrl),
    hasCurrencyToken,
    hasOpeningHours: hasOpeningHoursShape(text),
    hasTelephone,
  }
}

function pathSegmentsOf(url: string): string[] {
  const absolute = absoluteUrl(url, 'https://invalid.example/')
  if (absolute === null) return []
  try {
    return new URL(absolute).pathname
      .toLowerCase()
      .split('/')
      .filter((segment) => segment.length > 0)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// The pinned type table
// ---------------------------------------------------------------------------

/**
 * schema.org type → ARS page kind. Sorted by kind for readability; lookup is
 * exact and case-sensitive, because schema.org type names are.
 *
 * A few placements are judgement calls and are stated rather than left implied:
 * - `Event` maps to `service`. A bookable event's core facts are title, price
 *   and a primary action, which is the `service` profile exactly.
 * - `SoftwareApplication` maps to `product`: it carries `offers`, and an agent
 *   asking about it wants a price and availability.
 * - `Organization` alone does NOT map to `place` — an org can be the publisher
 *   of any page. Only `LocalBusiness` and its subtypes, which imply a physical
 *   location with hours, do.
 */
const TYPE_TO_KIND: Readonly<Record<string, ArsPageKind>> = {
  // product
  Product: 'product',
  ProductGroup: 'product',
  ProductModel: 'product',
  IndividualProduct: 'product',
  SomeProducts: 'product',
  Vehicle: 'product',
  Car: 'product',
  Book: 'product',
  SoftwareApplication: 'product',
  MobileApplication: 'product',
  WebApplication: 'product',
  // collection
  CollectionPage: 'collection',
  ItemList: 'collection',
  OfferCatalog: 'collection',
  SearchResultsPage: 'collection',
  // article
  Article: 'article',
  NewsArticle: 'article',
  BlogPosting: 'article',
  TechArticle: 'article',
  ScholarlyArticle: 'article',
  ReportageNewsArticle: 'article',
  LiveBlogPosting: 'article',
  Blog: 'article',
  // place
  Place: 'place',
  LocalBusiness: 'place',
  Store: 'place',
  Restaurant: 'place',
  Hotel: 'place',
  LodgingBusiness: 'place',
  FoodEstablishment: 'place',
  CafeOrCoffeeShop: 'place',
  MedicalBusiness: 'place',
  MedicalClinic: 'place',
  Dentist: 'place',
  ProfessionalService: 'place',
  AutomotiveBusiness: 'place',
  HealthAndBeautyBusiness: 'place',
  HairSalon: 'place',
  SportsActivityLocation: 'place',
  ExerciseGym: 'place',
  // service
  Service: 'service',
  GovernmentService: 'service',
  FinancialProduct: 'service',
  LoanOrCredit: 'service',
  InsuranceAgency: 'service',
  Course: 'service',
  Event: 'service',
  BusinessEvent: 'service',
  EducationEvent: 'service',
  // faq
  FAQPage: 'faq',
  QAPage: 'faq',
  // document
  Dataset: 'document',
  DataCatalog: 'document',
  DigitalDocument: 'document',
  TextDigitalDocument: 'document',
  APIReference: 'document',
  WebAPI: 'document',
  Legislation: 'document',
  HowTo: 'document',
  Report: 'document',
  Manuscript: 'document',
}

/**
 * Types ARS recognises but which say nothing about the page kind. They matter
 * anyway: D5.2 scores `unknown` against *"any recognised schema.org type
 * present"*, so a page that declares `WebPage` has a recognised type and can
 * earn D5.2 while still classifying as `unknown`.
 */
const RECOGNISED_ONLY: ReadonlySet<string> = new Set([
  'Thing',
  'WebPage',
  'WebSite',
  'AboutPage',
  'ContactPage',
  'ProfilePage',
  'ItemPage',
  'Organization',
  'Corporation',
  'NGO',
  'GovernmentOrganization',
  'EducationalOrganization',
  'Person',
  'BreadcrumbList',
  'Offer',
  'AggregateOffer',
  'PostalAddress',
  'ImageObject',
  'VideoObject',
  'SiteNavigationElement',
  'Brand',
  'Review',
  'AggregateRating',
  'Question',
  'Answer',
  'MerchantReturnPolicy',
  'OfferShippingDetails',
  'SearchAction',
  'ReadAction',
  'OrderAction',
])

/** Is this a schema.org type ARS knows about at all? The D5.2 "recognised" test. */
export function isRecognisedType(type: string): boolean {
  return TYPE_TO_KIND[type] !== undefined || RECOGNISED_ONLY.has(type)
}

/** The kind a recognised type implies, or null when it implies none. */
export function kindForType(type: string): ArsPageKind | null {
  return TYPE_TO_KIND[type] ?? null
}

/**
 * The first node whose `@type` maps to `kind`. D5.2 scores required properties
 * against the node that decided the kind, not against whichever node came first —
 * a `BreadcrumbList` sitting above the `Product` must not be marked incomplete
 * for lacking `offers.price`.
 */
export function nodeForKind(
  nodes: readonly JsonLdNode[],
  kind: ArsPageKind,
): JsonLdNode | null {
  for (const node of nodes) {
    for (const type of node.types) {
      if (kindForType(type) === kind) return node
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// og:type and URL grammar
// ---------------------------------------------------------------------------

/** Open Graph `og:type` → kind. The vocabulary is tiny and mostly commerce/article. */
const OG_TYPE_TO_KIND: Readonly<Record<string, ArsPageKind>> = {
  product: 'product',
  'product.group': 'product',
  'product.item': 'product',
  'og:product': 'product',
  article: 'article',
  'article:published_time': 'article',
  blog: 'article',
  book: 'product',
  place: 'place',
  business: 'place',
  'business.business': 'place',
  restaurant: 'place',
  'restaurant.restaurant': 'place',
  profile: 'unknown',
  website: 'unknown',
}

/**
 * URL path grammar, in precedence order. A pattern matches when any path segment
 * equals it, or when the first segment starts with it for the short forms.
 *
 * These are the conventional shapes of the platforms merchants actually run —
 * Shopify (`/products/`, `/collections/`), WordPress (`/blog/`, `/category/`),
 * documentation sites (`/docs/`, `/reference/`). A pattern earns `medium`
 * confidence and never `high`: a URL is a claim about a page, not the page.
 */
const PATH_PATTERNS: readonly (readonly [ArsPageKind, readonly string[]])[] = [
  ['product', ['products', 'product', 'p', 'item', 'items', 'dp', 'sku', 'buy']],
  ['collection', ['collections', 'collection', 'category', 'categories', 'catalog', 'c', 'shop']],
  ['article', ['blog', 'blogs', 'news', 'article', 'articles', 'post', 'posts', 'stories']],
  ['place', ['locations', 'location', 'stores', 'store-locator', 'branches', 'find-us', 'visit']],
  ['service', ['services', 'service', 'book', 'booking', 'appointments', 'pricing', 'plans']],
  ['faq', ['faq', 'faqs', 'questions', 'help']],
  ['document', ['docs', 'documentation', 'reference', 'guide', 'guides', 'manual', 'api', 'policies', 'legal', 'terms', 'privacy']],
]

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

export interface ArsClassification {
  readonly pageKind: ArsPageKind
  readonly confidence: 'high' | 'medium' | 'low'
  /** Which pass-1 signal decided it. Published as check evidence, not just logged. */
  readonly signal: string
  /** True when SOME recognised schema.org type was present, whatever the kind. */
  readonly hasRecognisedType: boolean
}

/**
 * Resolves the page kind from pass-1 signals and nothing else.
 *
 * The `low` → `unknown` collapse at the end is the "never guess into a vertical"
 * rule made mechanical: a lone currency token on a page with no type, no og:type
 * and no path grammar is not enough to call it a product, and a wrong vertical
 * is worse than no vertical because it scores the page against facts it was
 * never trying to state.
 */
export function classify(signals: ArsPass1Signals): ArsClassification {
  const hasRecognisedType =
    signals.jsonLdTypes.some(isRecognisedType) ||
    signals.microdataTypes.some(isRecognisedType) ||
    signals.rdfaTypes.some(isRecognisedType)

  // 1 — JSON-LD @type. Ties broken lexicographically by the type name (§3.5).
  const fromJsonLd = firstMappedType(signals.jsonLdTypes)
  if (fromJsonLd !== null) {
    return {
      pageKind: fromJsonLd.kind,
      confidence: 'high',
      signal: `json-ld @type ${fromJsonLd.type}`,
      hasRecognisedType,
    }
  }

  // 2 — microdata, then RDFa.
  const fromMicrodata = firstMappedType(signals.microdataTypes)
  if (fromMicrodata !== null) {
    return {
      pageKind: fromMicrodata.kind,
      confidence: 'high',
      signal: `microdata itemtype ${fromMicrodata.type}`,
      hasRecognisedType,
    }
  }
  const fromRdfa = firstMappedType(signals.rdfaTypes)
  if (fromRdfa !== null) {
    return {
      pageKind: fromRdfa.kind,
      confidence: 'high',
      signal: `rdfa typeof ${fromRdfa.type}`,
      hasRecognisedType,
    }
  }

  // 3 — og:type.
  if (signals.ogType !== null) {
    const kind = OG_TYPE_TO_KIND[signals.ogType]
    if (kind !== undefined && kind !== 'unknown') {
      return {
        pageKind: kind,
        confidence: 'medium',
        signal: `og:type ${signals.ogType}`,
        hasRecognisedType,
      }
    }
  }

  // 4 — URL path grammar.
  for (const [kind, patterns] of PATH_PATTERNS) {
    for (const segment of signals.pathSegments) {
      if (!patterns.includes(segment)) continue
      return {
        pageKind: kind,
        confidence: 'medium',
        signal: `url path segment /${segment}/`,
        hasRecognisedType,
      }
    }
  }

  // 5 — structural signals. Only ONE combination reaches `medium`: opening hours
  // AND a telephone number are two independent signals agreeing on `place`. A
  // lone currency token is `low`, which means `unknown`.
  if (signals.hasOpeningHours && signals.hasTelephone) {
    return {
      pageKind: 'place',
      confidence: 'medium',
      signal: 'opening-hours shape and telephone present',
      hasRecognisedType,
    }
  }

  return {
    pageKind: 'unknown',
    confidence: 'low',
    signal: signals.hasCurrencyToken
      ? 'currency token only — below medium confidence, not classified'
      : 'no classifying signal',
    hasRecognisedType,
  }
}

/**
 * First type that maps to a kind, preferring document order and breaking a
 * same-position tie lexicographically. Document order is the declared
 * precedence: a page that puts its `Product` node first has said which node is
 * the page.
 */
function firstMappedType(
  types: readonly string[],
): { type: string; kind: ArsPageKind } | null {
  const mapped: { type: string; kind: ArsPageKind }[] = []
  for (const type of types) {
    const kind = kindForType(type)
    if (kind !== null) mapped.push({ type, kind })
  }
  if (mapped.length === 0) return null

  const first = mapped[0]
  if (first === undefined) return null
  // Every type at the same document position (a node with `@type: [A, B]`) is
  // indistinguishable by order, so the lexicographically smaller name wins.
  let winner = first
  for (const candidate of mapped) {
    if (candidate.kind !== first.kind) break
    if (candidate.type < winner.type) winner = candidate
  }
  return winner
}
