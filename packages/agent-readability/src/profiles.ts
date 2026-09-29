/**
 * profiles.ts — the eight page-kind fact profiles. Design §3.5, table verbatim.
 *
 * THE ONE IDEA IN THIS FILE. ARS uses fixed weights for every page kind. What
 * varies is *what counts as a fact* and *what a page of that kind reasonably
 * costs*:
 *
 * > ARS does not measure how much you say. It measures whether the facts a
 * > caller needs **for this kind of page** are present, findable, and cheap
 * > **relative to what that kind of page costs**.
 *
 * Per-vertical *weights* would be the wrong design — it makes an 88 mean
 * different things on different pages and invites site-type shopping. A
 * per-vertical *fact set* and *byte reference* are not weights: an article that
 * spends 38 KB saying something is not penalised against a 40 KB reference,
 * while a product page that spends 38 KB to state four facts is. The byte
 * reference is specifically what stops long-form content being structurally
 * capped around C, which every source design that used absolute byte bands did.
 *
 * The set is CLOSED at eight, and every kind has a complete profile — there is
 * no "no profile" path. Conformance fixture `058-profiles-total-and-typed`
 * asserts both halves of that: the mapping is total over `ArsPageKind`, and
 * every fact name is a member of `ArsFactKind`. `PROFILE_BY_KIND` is typed as a
 * total `Record`, so the first half is also a compile error.
 *
 * `unknown` is deliberately not an easy exit. It carries the smallest core set,
 * but it still scores D5.2 against "any recognised schema.org type present",
 * which requires having a type at all. Hiding your page kind costs up to 7
 * points and gains nothing on coverage.
 *
 * ── Definitions of the fact terms the source designs left undefined (§3.5) ──
 *
 * `primary-action-url` — a same-origin-or-declared URL reachable from an
 *   `<a href>`, a `<form action>`, or JSON-LD `potentialAction.target`, whose
 *   anchor text or `name` matches the ruleset's action lexicon (`book`, `apply`,
 *   `contact`, `buy`, `subscribe`, `start`, `request`, `download`, `sign up`,
 *   `get a quote` and their pinned synonyms). The lexicon is pinned in
 *   `DEFAULT_RULESET.actionLexicon`, not inferred per page.
 *
 * `authority` — an organisation or person named as the publisher of the content,
 *   extracted from JSON-LD `publisher`/`author`, `<meta name="author">`, or a
 *   `rel="publisher"` link.
 *
 * `org-name` — JSON-LD `Organization.name` / `LocalBusiness.name`,
 *   `og:site_name`, or `<meta itemprop="name">` on an org-typed scope.
 *
 * `item-count` / `item-link` — for `collection`: the number of distinct item
 *   links inside the largest repeated-structure block, and whether those links
 *   resolve to same-origin URLs. Counted from the largest repeated block
 *   specifically so that a nav menu is not mistaken for a product grid.
 *
 * `question-answer` — a `FAQPage`/`Question` JSON-LD pair, or a `<dt>/<dd>`, a
 *   `<details><summary>`, or a heading-followed-by-paragraph pair. Counted ONCE
 *   as present, not per item: a page with 40 questions is not four times better
 *   than a page with 10.
 *
 * `price` is satisfied by an explicit "no published price" signal as well as by
 *   a number. We score honesty, not disclosure — a service page that says
 *   "pricing on request" has told the agent what it needs to know.
 */

import type { ArsFactProfile, ArsPageKind } from './types'

/**
 * The §3.5 table, one entry per `ArsPageKind`. Core facts score at full weight,
 * extended facts at ¼ credit (the single definition — the source designs used
 * ¼, ½ and "half credit" in three different places). Byte references are the
 * D3.2 denominator, in bytes.
 */
export const PROFILE_BY_KIND = {
  product: {
    pageKind: 'product',
    core: ['title', 'price', 'currency', 'availability'],
    extended: ['brand', 'sku', 'shipping', 'returns', 'description'],
    byteReference: 8 * 1024,
  },
  collection: {
    pageKind: 'collection',
    core: ['title', 'item-count', 'item-link'],
    extended: ['price', 'availability', 'description'],
    byteReference: 16 * 1024,
  },
  article: {
    pageKind: 'article',
    core: ['title', 'author', 'published'],
    extended: ['updated', 'section', 'description'],
    byteReference: 40 * 1024,
  },
  place: {
    pageKind: 'place',
    core: ['org-name', 'address', 'hours', 'phone'],
    extended: ['email', 'service-area', 'primary-action-url', 'description'],
    byteReference: 8 * 1024,
  },
  service: {
    pageKind: 'service',
    core: ['title', 'price', 'primary-action-url'],
    extended: ['duration', 'eligibility', 'service-area', 'description', 'updated'],
    byteReference: 8 * 1024,
  },
  faq: {
    pageKind: 'faq',
    core: ['title', 'question-answer'],
    extended: ['updated', 'description'],
    byteReference: 16 * 1024,
  },
  document: {
    pageKind: 'document',
    core: ['title', 'updated', 'authority'],
    extended: ['description', 'primary-action-url', 'section'],
    byteReference: 24 * 1024,
  },
  unknown: {
    pageKind: 'unknown',
    core: ['title', 'description', 'primary-action-url'],
    extended: ['updated', 'org-name'],
    byteReference: 16 * 1024,
  },
} as const satisfies Record<ArsPageKind, ArsFactProfile>

/**
 * The same eight profiles as the array `ArsRuleset.profiles` expects, in
 * declaration order (which is the order they appear in the §3.5 table, and is
 * therefore the order the spec renders them in).
 *
 * Runtime immutability: `as const` above makes every profile deeply readonly to
 * TypeScript, and `DEFAULT_RULESET` deep-freezes these exact objects at module
 * load, so a consumer cannot mutate a shared profile and silently change every
 * subsequent score.
 */
export const PROFILES: readonly ArsFactProfile[] = Object.freeze(Object.values(PROFILE_BY_KIND))

/** Total by construction — `PROFILE_BY_KIND` is typed as a total Record. */
export function profileFor(pageKind: ArsPageKind): ArsFactProfile {
  return PROFILE_BY_KIND[pageKind]
}
