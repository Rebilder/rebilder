/**
 * The type surface of the profile vocabulary.
 *
 * These types describe the JSON documents under `profiles/`. They are a
 * *reading aid* for TypeScript consumers, not the specification: the JSON is
 * the specification, because a Go or Python implementation has to be able to
 * consume this package with nothing but a JSON parser. Anything that cannot be
 * expressed in the JSON does not belong in these types.
 */

/**
 * The value shapes a fact can take.
 *
 * Deliberately identical to the `type` discriminants of `FactValue` in
 * `@rebilder/render-md` (`src/documents/types.ts`), which is what actually
 * renders a fact into agent-facing markdown. It is *restated* here rather than
 * imported because this package must have zero dependencies — it ships as an
 * open spec that non-JavaScript implementations read straight off disk. The
 * cost of that duplication is one test in `@rebilder/render-md`'s consumers;
 * the benefit is that `profiles/*.json` is self-contained.
 */
export type FactValueType =
  | 'text'
  | 'list'
  | 'number'
  | 'boolean'
  | 'money'
  | 'date'
  | 'url'
  | 'hours'

/**
 * The closed set of fact names the launch profiles may use.
 *
 * This union must stay character-identical to `ArsFactKind` in
 * `@rebilder/agent-readability`: the Agent Readability Score counts a page's
 * facts against the profile for its page kind, so a name that exists in one
 * and not the other is a silent scoring hole. The dependency direction is
 * one-way — `agent-readability` may read this package; this package depends on
 * nothing. `tests/profiles.test.ts` pins the eight profiles' fact names against
 * the table transcribed from the design doc so the two cannot drift unnoticed.
 *
 * Third-party profiles are not restricted to these names (see README, "How to
 * propose a profile"); the launch eight are, because ARS scores them.
 */
export type FactName =
  | 'title'
  | 'description'
  | 'updated'
  | 'published'
  | 'price'
  | 'currency'
  | 'availability'
  | 'brand'
  | 'sku'
  | 'shipping'
  | 'returns'
  | 'org-name'
  | 'address'
  | 'hours'
  | 'phone'
  | 'email'
  | 'service-area'
  | 'author'
  | 'section'
  | 'authority'
  | 'primary-action-url'
  | 'eligibility'
  | 'duration'
  | 'question-answer'
  | 'item-count'
  | 'item-link'

/**
 * One recommended fact.
 *
 * `why` is the reason this package exists in a persuadable form: a merchant
 * reading a profile should learn, in one sentence per fact, what an agent
 * actually does with it. "Add a price" is a chore; "without a price the agent
 * has to guess or leave the page" is an argument. Every `why` is one sentence,
 * present tense, about the caller — not about our product.
 */
export interface FactSpec {
  /**
   * Stable machine name, kebab-case. This is the join key: it is what ARS
   * reports as an observed fact and what a consumer diffs a page against.
   *
   * (Not in the design doc's `FactSpec` sketch, which listed only
   * `{ label, types, why }`. Without a name the arrays are unaddressable — you
   * cannot say "this page is missing `sku`" from a display label.)
   */
  name: string
  /** Human-facing display label, e.g. `Product name`. Never a machine key. */
  label: string
  /**
   * Value shapes this fact may legitimately take, most typical first. More than
   * one entry means the fact is genuinely polymorphic (an address is one string
   * or a list of lines), not that we were undecided.
   */
  types: readonly FactValueType[]
  /** One sentence: what a calling agent does with this fact. */
  why: string
}

/**
 * A profile: the facts one kind of page should expose to agents.
 *
 * A profile is a *recommendation*, never a schema. Nothing validates a page
 * against it and nothing is rejected for failing it. It exists so that "make
 * this page readable by agents" is a finite, checkable list instead of a
 * feeling.
 */
export interface SiteProfile {
  /** Stable id, kebab-case, unique across the package. Matches an ARS page kind for the launch eight. */
  id: string
  /** SemVer of this profile document alone. Profiles version independently — see README. */
  version: string
  /** Human-facing name of the page kind, e.g. `Product page`. */
  label: string
  /**
   * Id of a profile whose `required`/`recommended` this one builds on.
   *
   * Unused by the launch eight — they are the base vocabulary and must be
   * readable without resolution. It exists so a proposed vertical profile
   * (`dentist` extends `place`) can add facts without restating the base.
   * Merge rule, for consumers that implement it: parent facts first, then the
   * child's, deduplicating by `name` with the child's entry winning.
   */
  extends?: string
  /** Facts an agent needs to use the page at all. Missing one is a real failure. */
  required: readonly FactSpec[]
  /** Facts that materially improve the answer an agent can give. Missing one is a gap, not a failure. */
  recommended: readonly FactSpec[]
  /**
   * Action kinds this page kind should offer, drawn from the `ActionSource.kind`
   * vocabulary in `@rebilder/render-md`. Typed as `string` rather than a union
   * because third-party profiles will need action kinds we have not thought of;
   * the launch eight are pinned to the known vocabulary by test.
   *
   * Empty is meaningful: a collection page carries no call to action of its own,
   * the items it links to carry theirs.
   */
  actions: readonly string[]
  /**
   * The schema.org type that best fits this page kind, if one does.
   *
   * Absent on `unknown` by design — an unclassifiable page has no recommended
   * type, and inventing one would tell merchants to mislabel their pages.
   */
  jsonLdType?: string
}
