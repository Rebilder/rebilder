/**
 * recommend.ts — what to fix, in what order, and what each fix is worth.
 *
 * WHY THIS FILE HAS A SPEC AT ALL. Recommendation arithmetic was undefined in
 * every source design, and it is the surface merchants actually act on: nobody
 * ships a change because a dimension moved, they ship it because a list said
 * "this is worth 13 points". A list that double-counts is a list that promises 30
 * points and delivers 16, and the second scan is where the product loses its
 * credibility. So §3.9's final paragraph pins the arithmetic and this file
 * implements exactly that:
 *
 *   Recommendations are computed over a DEPENDENCY DAG. A recommendation's
 *   `pointsAvailable` counts only the checks not already claimed by a
 *   higher-ranked recommendation, plus the checks it uniquely UNLOCKS. Sums per
 *   dimension are capped at the dimension weight. A property test asserts
 *   `Σ pointsAvailable ≤ 100 − score`.
 *
 * WHAT "UNLOCKS" MEANS, PRECISELY. Two checks are gated on D2.1: D2.3
 * (`Vary: Accept` is meaningless on a response that does not vary) and D2.4
 * (substance parity has nothing to compare against). While D2.1 is at zero,
 * their points are not reachable by any other action, so they belong to the
 * recommendation that closes D2.1 — and to no other, which is what stops
 * "declare Vary: Accept" from also claiming them. Once D2.1 is earned, the gate
 * is open and D2.3 stands on its own. `unlocks` is therefore CONDITIONAL, not a
 * fixed edge list, and each template says when its edge exists.
 *
 * ORDER IS THE RANKING. The output array is in priority order: biggest raw
 * recovery first, ties broken by effort (a config change before an engineering
 * project) and then by id, so two runs over the same result produce the same
 * list. The dedup walks that same order, which is what "higher-ranked" means.
 *
 * NO POINTS ARE INVENTED. Every number is the gap between a check's `earned` and
 * its `weight` in the result being explained. A recommendation whose checks are
 * all already full does not appear at all — an empty list is the correct output
 * for a page at 100, and a list of platitudes would be worse than nothing.
 */

import type { ArsCheck, ArsCheckId, ArsDimension, ArsRecommendation, ArsResult } from './types'

/** What `recommend()` needs from a result. Callers holding an `ArsResult` can pass it directly. */
export type ArsRecommendationInput = Pick<ArsResult, 'dimensions' | 'score'>

interface Template {
  readonly id: string
  readonly title: string
  readonly effort: ArsRecommendation['effort']
  readonly detail: string
  readonly checks: readonly ArsCheckId[]
  /**
   * Checks this recommendation makes reachable that nothing else can, given the
   * current state. Returns the empty list when the gate is already open.
   */
  readonly unlocks: (state: CheckState) => readonly ArsCheckId[]
}

/** Earned/weight for every check in the result, by id. */
type CheckState = ReadonlyMap<ArsCheckId, ArsCheck>

const NO_UNLOCKS = (): readonly ArsCheckId[] => []

/**
 * The catalogue. One entry per action a site owner can actually take; the
 * `detail` is the instruction, not a restatement of the check name.
 *
 * Declaration order is the tie-break of last resort, so it is written in the
 * order the spec presents the dimensions rather than in any order of preference.
 */
const TEMPLATES: readonly Template[] = [
  {
    id: 'fix-robots-policy',
    title: 'Let assistant crawlers fetch this page',
    effort: 'config',
    detail:
      "robots.txt currently blocks or ambiguously blocks the crawlers that fetch pages on a user's behalf. Name them in their own group and allow them. Blocking model-training crawlers is a separate decision and costs nothing in ARS.",
    checks: ['retrievability.robots-policy'],
    unlocks: NO_UNLOCKS,
  },
  {
    id: 'render-without-javascript',
    title: 'Put the core facts in the HTML the server sends',
    effort: 'engineering',
    detail:
      'The facts for this page kind were not all present in the served HTML. Agents do not execute JavaScript: server-render the core facts, or ship them in a <noscript> block or structured data.',
    checks: ['retrievability.render-independence'],
    unlocks: NO_UNLOCKS,
  },
  {
    id: 'serve-machine-representation',
    title: 'Serve a machine representation on Accept negotiation',
    effort: 'config',
    detail:
      'Return Markdown, plain text or JSON with a matching Content-Type when the request asks for one, and keep the same URL. This is the single largest recoverable block in ARS, and it is also what makes Vary: Accept and the substance-parity check scoreable at all.',
    checks: ['machine-representation.negotiated-response'],
    // Vary is gated on negotiation itself, so it stays locked while D2.1 is
    // short of full, including the ARS 0.3 partial credit for a linked copy.
    // Parity also opens on a linked copy, so it is unlocked only from zero.
    unlocks: (state) => {
      const earned = earnedOf(state, 'machine-representation.negotiated-response')
      const full = state.get('machine-representation.negotiated-response')?.weight ?? 0
      if (earned >= full) return []
      return earned === 0
        ? ['machine-representation.vary-accept', 'machine-representation.substance-parity']
        : ['machine-representation.vary-accept']
    },
  },
  {
    id: 'declare-alternates',
    title: 'Declare the alternate representation',
    effort: 'config',
    detail:
      'Add `Link: <…>; rel="alternate"; type="text/markdown"` or a typed `<link rel="alternate">`. An endpoint an agent cannot find is an endpoint that does not exist.',
    checks: ['machine-representation.declared-alternates'],
    unlocks: NO_UNLOCKS,
  },
  {
    id: 'declare-vary-accept',
    title: 'Send Vary: Accept',
    effort: 'config',
    detail:
      'A URL that returns different representations by Accept must say so, or a shared cache will hand the Markdown to a browser and the HTML to an agent.',
    checks: ['machine-representation.vary-accept'],
    unlocks: NO_UNLOCKS,
  },
  {
    id: 'resolve-substance-divergence',
    title: 'Make both representations state the same values',
    effort: 'engineering',
    detail:
      'The two representations reported different values for a core fact. Render both from one source of truth. ARS reports what each one said and does not assert which is correct.',
    checks: ['machine-representation.substance-parity'],
    unlocks: NO_UNLOCKS,
  },
  {
    id: 'add-core-facts',
    title: 'State the missing core facts for this page kind',
    effort: 'template',
    detail:
      'Coverage is scored against the fact set this kind of page is expected to carry, and only against that set — adding facts outside it earns nothing. A fact stated in two places (structured data and visible text) counts double.',
    checks: ['fact-coverage.core-facts'],
    unlocks: (state) =>
      // Position can only be scored once something is there to position. While
      // no core fact exists, D4's points are reachable through this and nothing
      // else; once one exists, "front-load the core facts" owns them.
      earnedOf(state, 'fact-position.first-core-fact-offset') === 0 &&
      earnedOf(state, 'fact-position.front-window') === 0
        ? ['fact-position.first-core-fact-offset', 'fact-position.front-window']
        : [],
  },
  {
    id: 'reduce-page-weight',
    title: 'Cut the bytes an agent has to read',
    effort: 'engineering',
    detail:
      'Context cost is scored against what a page of this kind reasonably costs, not an absolute budget. The cheapest fix is usually to serve a machine representation rather than to shrink the HTML.',
    checks: ['fact-coverage.context-cost'],
    unlocks: NO_UNLOCKS,
  },
  {
    id: 'front-load-core-facts',
    title: 'Move the core facts to the front',
    effort: 'template',
    detail:
      'A caller that reads the first few kilobytes should already have the facts. Everything after the front window costs a full read of the document.',
    checks: ['fact-position.first-core-fact-offset', 'fact-position.front-window'],
    unlocks: NO_UNLOCKS,
  },
  {
    id: 'add-structured-data',
    title: 'Add JSON-LD for this page',
    effort: 'template',
    detail:
      'Declare a schema.org type in a JSON-LD block. Choosing no type does not avoid the check: an unrecognised page is still scored against "any recognised type present".',
    checks: ['structured-data.present'],
    unlocks: (state) =>
      earnedOf(state, 'structured-data.present') === 0
        ? ['structured-data.required-properties', 'structured-data.text-agreement']
        : [],
  },
  {
    id: 'complete-required-properties',
    title: 'Complete the required properties for this page kind',
    effort: 'template',
    detail:
      'The required-property table is published per page kind in the spec. It is not "schema.org validity" — schema.org defines no required properties — and it does not change without an ARS release.',
    checks: ['structured-data.required-properties'],
    unlocks: NO_UNLOCKS,
  },
  {
    id: 'align-structured-data-with-text',
    title: 'Make the structured data agree with the page',
    effort: 'template',
    detail:
      'The JSON-LD and the visible page reported different values for a core fact. Generate both from the same source so they cannot drift.',
    checks: ['structured-data.text-agreement'],
    unlocks: NO_UNLOCKS,
  },
  {
    id: 'declare-canonical',
    title: 'Declare one canonical URL, in both representations',
    effort: 'config',
    detail:
      'Add an absolute `<link rel="canonical">` to the HTML and a `Link: <…>; rel="canonical"` header to the machine representation, pointing at the same URL. A representation with no canonical cannot be attributed to a page.',
    checks: ['contract-discovery.canonical'],
    unlocks: NO_UNLOCKS,
  },
  {
    id: 'add-cache-validators',
    title: 'Add cache headers an agent can act on',
    effort: 'config',
    detail:
      'Send a Cache-Control a cache can use plus an ETag or Last-Modified. Repeat fetches are most of agent traffic, and a response with no validator has to be re-read in full every time.',
    checks: ['contract-discovery.cache-validators'],
    unlocks: NO_UNLOCKS,
  },
  {
    id: 'publish-llms-txt',
    title: 'Publish /llms.txt',
    effort: 'config',
    detail:
      'An H1 title, a short summary, and links to the pages that matter. It is worth 1 point of 100, deliberately: content negotiation is the mechanism that measurably improves retrieval, and we have observed no citation lift from llms.txt alone.',
    checks: ['contract-discovery.llms-txt'],
    unlocks: NO_UNLOCKS,
  },
  {
    id: 'declare-sitemap',
    title: 'Declare a sitemap in robots.txt',
    effort: 'config',
    detail:
      'Add a `Sitemap:` line. It is the one place an agent looks to find the rest of the site.',
    checks: ['contract-discovery.sitemap'],
    unlocks: NO_UNLOCKS,
  },
  {
    id: 'declare-machine-endpoint',
    title: 'Declare a machine endpoint',
    effort: 'engineering',
    detail:
      'A feed, an OpenAPI document, /.well-known/ucp — anything an agent can call — declared with a `Link` header or a `<link>`. ARS probes /robots.txt, /llms.txt and /.well-known/ucp and guesses at no other path.',
    checks: ['contract-discovery.machine-endpoint'],
    unlocks: NO_UNLOCKS,
  },
  {
    id: 'state-quantities',
    title: 'State the numbers in text',
    effort: 'template',
    detail:
      'Price, sizes, weights, hours, fees, lead times, dates — written out where an agent reads them, not left in an image or implied by a paragraph. An assistant builds a cited answer out of quantities it can lift; distinct ones count, so saying the same price three times is one number.',
    checks: ['evidence-density.quantities'],
    unlocks: NO_UNLOCKS,
  },
  {
    id: 'label-facts',
    title: 'Label each fact with its term',
    effort: 'template',
    detail:
      'A line that reads "Returns: 60 days" travels whole into an answer. The same fact inside a sentence has to be inferred, and an assistant that has to infer it usually leaves it out. Specification lists, definition lists and labelled bullets all count.',
    checks: ['evidence-density.definitions'],
    unlocks: NO_UNLOCKS,
  },
  {
    id: 'add-comparison-rows',
    title: 'Put the options side by side',
    effort: 'template',
    detail:
      'Sizes, tiers, models, plans — one row each, in a table with at least two columns. One row states a fact; two or more let an assistant contrast them, which is the question people actually ask it.',
    checks: ['evidence-density.comparisons'],
    unlocks: NO_UNLOCKS,
  },
]

/** Effort order for the tie-break: the cheapest fix first. */
const EFFORT_ORDER: readonly ArsRecommendation['effort'][] = ['config', 'template', 'engineering']

function earnedOf(state: CheckState, id: ArsCheckId): number {
  return state.get(id)?.earned ?? 0
}

function gapOf(state: CheckState, id: ArsCheckId): number {
  const check = state.get(id)
  return check === undefined ? 0 : Math.max(0, check.weight - check.earned)
}

/**
 * Ranked, deduplicated remedies for a scored result.
 *
 * Returns an empty array for a non-grade (`score: null`): an unscored or
 * opted-out target has no sub-scores, so there is nothing to recover and no
 * honest number to attach to advice.
 */
export function recommend(input: ArsRecommendationInput): ArsRecommendation[] {
  if (input.score === null) return []

  const state = new Map<ArsCheckId, ArsCheck>()
  const dimensionOf = new Map<ArsCheckId, ArsDimension>()
  for (const dimension of input.dimensions) {
    for (const check of dimension.checks) {
      state.set(check.id, check)
      dimensionOf.set(check.id, dimension)
    }
  }

  // Rank by RAW recovery — what the recommendation would be worth if it were the
  // only one — because the deduped value cannot be known until the order is
  // fixed. Ties: cheaper effort first, then declaration order for stability.
  //
  // A recommendation may only claim the checks it UNLOCKS if it also closes
  // something itself. Without that rule, a template whose own check is already
  // full could still claim a gated check's points and print advice that has
  // nothing to do with the gap it is being credited for.
  const ranked = TEMPLATES.map((template, index) => {
    const own = template.checks.reduce((sum, id) => sum + gapOf(state, id), 0)
    const unlocked = own > 0 ? template.unlocks(state) : []
    const ids = [...template.checks, ...unlocked]
    const raw = own + unlocked.reduce((sum, id) => sum + gapOf(state, id), 0)
    return { template, ids, raw, index }
  })
    .filter((entry) => entry.raw > 0)
    .sort((a, b) => {
      if (a.raw !== b.raw) return b.raw - a.raw
      const effort =
        EFFORT_ORDER.indexOf(a.template.effort) - EFFORT_ORDER.indexOf(b.template.effort)
      return effort !== 0 ? effort : a.index - b.index
    })

  const claimed = new Set<ArsCheckId>()
  /** Points already promised per dimension, so the total can never exceed its weight. */
  const spent = new Map<string, number>()
  const out: ArsRecommendation[] = []

  for (const entry of ranked) {
    let points = 0
    const closes: ArsCheckId[] = []
    const opens: ArsCheckId[] = []

    for (const id of entry.ids) {
      if (claimed.has(id)) continue
      const dimension = dimensionOf.get(id)
      if (dimension === undefined) continue
      const remaining = Math.max(
        0,
        dimension.weight - dimension.earned - (spent.get(dimension.id) ?? 0),
      )
      const value = Math.min(gapOf(state, id), remaining)
      if (value <= 0) continue
      points += value
      spent.set(dimension.id, (spent.get(dimension.id) ?? 0) + value)
      claimed.add(id)
      if (entry.template.checks.includes(id)) closes.push(id)
      else opens.push(id)
    }

    if (points <= 0) continue
    out.push({
      id: entry.template.id,
      title: entry.template.title,
      pointsAvailable: points,
      effort: entry.template.effort,
      detail: entry.template.detail,
      checks: closes,
      unlocks: opens,
    })
  }

  return out
}
