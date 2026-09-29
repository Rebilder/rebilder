/**
 * `@rebilder/profiles` — the vocabulary of what a kind of page should tell an agent.
 *
 * This package is deliberately DATA, not logic. The eight profiles live as JSON
 * under `profiles/`; this module does nothing but import them, order them, and
 * hand them back. There is no resolution, no validation, no merging, and no
 * network — anything that computes over a profile belongs in the consumer.
 *
 * WHY it is a separate package: vocabulary churns and public API cannot. The
 * gateway's source types (`DocumentSource`, `CollectionSource`) are two shapes
 * that must stay stable for years; the question of *which facts a dentist's
 * location page ought to carry* is one we will get wrong and revise repeatedly.
 * Splitting them means we can be wrong about the second without ever breaking
 * the first.
 *
 * WHY it is JSON on disk rather than TypeScript literals: the profiles are
 * published as an open spec and we want them adopted by implementations that
 * are not ours and not JavaScript. A Go or Python consumer reads
 * `profiles/place.json` with its standard library. A TypeScript consumer gets
 * the same bytes through this module. Neither is the privileged reading.
 */
import articleProfile from '../profiles/article.json'
import collectionProfile from '../profiles/collection.json'
import documentProfile from '../profiles/document.json'
import faqProfile from '../profiles/faq.json'
import placeProfile from '../profiles/place.json'
import productProfile from '../profiles/product.json'
import serviceProfile from '../profiles/service.json'
import unknownProfile from '../profiles/unknown.json'

import type { SiteProfile } from './types'

export type { FactName, FactSpec, FactValueType, SiteProfile } from './types'

/**
 * Every profile this package ships, in the order the ARS page-kind table lists
 * them (design § 3.5) rather than alphabetically, so a reader comparing the two
 * documents side by side is comparing rows in the same order.
 *
 * The cast is the one unchecked step in the package: TypeScript infers
 * `types: string[]` from a JSON import and cannot know the strings are members
 * of `FactValueType`. Rather than pay a runtime validator on import for a
 * static data file, `tests/profiles.test.ts` proves the assertion — every
 * value type, every fact name, and every action is checked against its
 * vocabulary there. If those tests are deleted, this cast becomes a lie.
 */
export const ALL_PROFILES: readonly SiteProfile[] = [
  productProfile,
  collectionProfile,
  articleProfile,
  placeProfile,
  serviceProfile,
  faqProfile,
  documentProfile,
  unknownProfile,
] as readonly SiteProfile[]

/**
 * Look up a profile by id. Returns `undefined` for an unrecognised id — an
 * unknown page kind is a normal outcome, not an error, and the caller decides
 * whether to fall back to the `unknown` profile or to skip fact checking
 * entirely. (Note that `getProfile('unknown')` is a real profile, not a
 * failure: `unknown` is one of the eight.)
 */
export function getProfile(id: string): SiteProfile | undefined {
  return ALL_PROFILES.find((profile) => profile.id === id)
}
