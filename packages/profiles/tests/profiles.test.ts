/**
 * Property tests over the whole profile corpus.
 *
 * The load-bearing one is `ARS_FACT_TABLE`: a verbatim transcription of the
 * page-kind table in design § 3.5, the same table the Agent Readability Score
 * uses to decide which facts count as core and which count for a quarter. If
 * the vocabulary and the score disagree about what a `place` page needs, the
 * score silently measures something the merchant was never told to do. This
 * file is the only thing standing between those two documents, so it compares
 * them on names AND on order, and it does not derive either side from the
 * other.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { ALL_PROFILES, getProfile } from '../src/index'
import type { FactName, FactSpec, FactValueType, SiteProfile } from '../src/types'

/**
 * Design § 3.5, "Page kinds — a closed set of 8". Transcribed by hand from the
 * table's `Core facts` and `Extended (¼ credit)` columns, in the table's own
 * row order and column order. Do not regenerate this from `ALL_PROFILES`; a
 * test that reads its expectation off the thing under test proves nothing.
 */
const ARS_FACT_TABLE: ReadonlyArray<{
  id: string
  core: readonly string[]
  extended: readonly string[]
}> = [
  {
    id: 'product',
    core: ['title', 'price', 'currency', 'availability'],
    extended: ['brand', 'sku', 'shipping', 'returns', 'description'],
  },
  {
    id: 'collection',
    core: ['title', 'item-count', 'item-link'],
    extended: ['price', 'availability', 'description'],
  },
  {
    id: 'article',
    core: ['title', 'author', 'published'],
    extended: ['updated', 'section', 'description'],
  },
  {
    id: 'place',
    core: ['org-name', 'address', 'hours', 'phone'],
    extended: ['email', 'service-area', 'primary-action-url', 'description'],
  },
  {
    id: 'service',
    core: ['title', 'price', 'primary-action-url'],
    extended: ['duration', 'eligibility', 'service-area', 'description', 'updated'],
  },
  {
    id: 'faq',
    core: ['title', 'question-answer'],
    extended: ['updated', 'description'],
  },
  {
    id: 'document',
    core: ['title', 'updated', 'authority'],
    extended: ['description', 'primary-action-url', 'section'],
  },
  {
    id: 'unknown',
    core: ['title', 'description', 'primary-action-url'],
    extended: ['updated', 'org-name'],
  },
]

/**
 * Runtime mirror of the `FactName` union. `assertUnionCovered` below makes the
 * compiler reject this list if it ever falls behind the union — a runtime Set
 * built from a stale literal would happily wave through a name the type system
 * had already removed.
 */
const FACT_NAMES = [
  'title',
  'description',
  'updated',
  'published',
  'price',
  'currency',
  'availability',
  'brand',
  'sku',
  'shipping',
  'returns',
  'org-name',
  'address',
  'hours',
  'phone',
  'email',
  'service-area',
  'author',
  'section',
  'authority',
  'primary-action-url',
  'eligibility',
  'duration',
  'question-answer',
  'item-count',
  'item-link',
] as const satisfies readonly FactName[]

/** Runtime mirror of `FactValueType`, covered the same way. */
const FACT_VALUE_TYPES = [
  'text',
  'list',
  'number',
  'boolean',
  'money',
  'date',
  'url',
  'hours',
] as const satisfies readonly FactValueType[]

/**
 * The `ActionSource.kind` vocabulary from `@rebilder/render-md`
 * (design § 4.1). `SiteProfile.actions` is typed `readonly string[]` so that
 * third-party profiles can carry action kinds we have not thought of; the eight
 * profiles we publish are held to the known set here instead.
 */
const KNOWN_ACTION_KINDS: readonly string[] = [
  'book',
  'apply',
  'contact',
  'purchase',
  'subscribe',
  'download',
  'quote',
  'other',
]

/**
 * Compile-time exhaustiveness check. Instantiating it with a non-empty union
 * is a type error, which is what turns the `satisfies` clauses above from
 * "every listed member is valid" into "every union member is listed".
 */
function assertUnionCovered<Uncovered extends never>(_uncovered?: Uncovered): void {}
assertUnionCovered<Exclude<FactName, (typeof FACT_NAMES)[number]>>()
assertUnionCovered<Exclude<FactValueType, (typeof FACT_VALUE_TYPES)[number]>>()

const PROFILES_DIR = fileURLToPath(new URL('../profiles', import.meta.url))
const SEMVER = /^\d+\.\d+\.\d+$/

function factNames(specs: readonly FactSpec[]): string[] {
  return specs.map((spec) => spec.name)
}

function allSpecs(profile: SiteProfile): readonly FactSpec[] {
  return [...profile.required, ...profile.recommended]
}

describe('the eight launch profiles', () => {
  it('are exactly the eight ARS page kinds, in table order', () => {
    expect(ALL_PROFILES.map((profile) => profile.id)).toEqual(
      ARS_FACT_TABLE.map((row) => row.id),
    )
  })

  it('is the complete set of JSON files on disk — nothing added but unexported', () => {
    const onDisk = readdirSync(PROFILES_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.replace(/\.json$/, ''))
      .sort()

    expect(onDisk).toEqual([...ALL_PROFILES].map((profile) => profile.id).sort())
  })

  it('has one file per profile whose filename matches its id', () => {
    for (const profile of ALL_PROFILES) {
      const raw: unknown = JSON.parse(
        readFileSync(`${PROFILES_DIR}/${profile.id}.json`, 'utf8'),
      )
      expect(raw).toEqual(profile)
    }
  })

  it('declares a semver version on every profile', () => {
    for (const profile of ALL_PROFILES) {
      expect(profile.version, profile.id).toMatch(SEMVER)
    }
  })

  it('gives every profile a human-facing label', () => {
    for (const profile of ALL_PROFILES) {
      expect(profile.label.length, profile.id).toBeGreaterThan(0)
      expect(profile.label, profile.id).not.toBe(profile.id)
    }
  })
})

describe('fact sets match the ARS core/extended table (design § 3.5)', () => {
  for (const row of ARS_FACT_TABLE) {
    it(`${row.id}: required facts are exactly the core facts, in order`, () => {
      const profile = getProfile(row.id)
      expect(profile, `no profile for page kind ${row.id}`).toBeDefined()
      expect(factNames(profile!.required)).toEqual(row.core)
    })

    it(`${row.id}: recommended facts are exactly the extended facts, in order`, () => {
      const profile = getProfile(row.id)
      expect(profile, `no profile for page kind ${row.id}`).toBeDefined()
      expect(factNames(profile!.recommended)).toEqual(row.extended)
    })
  }

  it('uses no fact name outside the union the table draws from', () => {
    const known = new Set<string>(FACT_NAMES)
    for (const profile of ALL_PROFILES) {
      for (const spec of allSpecs(profile)) {
        expect(known.has(spec.name), `${profile.id}/${spec.name}`).toBe(true)
      }
    }
  })

  it('never lists the same fact twice within a profile', () => {
    for (const profile of ALL_PROFILES) {
      const names = factNames(allSpecs(profile))
      expect(new Set(names).size, profile.id).toBe(names.length)
    }
  })
})

describe('every fact carries a usable spec', () => {
  it('declares at least one value type, all of them known', () => {
    const known = new Set<string>(FACT_VALUE_TYPES)
    for (const profile of ALL_PROFILES) {
      for (const spec of allSpecs(profile)) {
        expect(spec.types.length, `${profile.id}/${spec.name}`).toBeGreaterThan(0)
        expect(new Set(spec.types).size, `${profile.id}/${spec.name}`).toBe(spec.types.length)
        for (const type of spec.types) {
          expect(known.has(type), `${profile.id}/${spec.name}: ${type}`).toBe(true)
        }
      }
    }
  })

  it('gives every fact a display label distinct from its machine name', () => {
    for (const profile of ALL_PROFILES) {
      for (const spec of allSpecs(profile)) {
        expect(spec.label.length, `${profile.id}/${spec.name}`).toBeGreaterThan(0)
        expect(spec.label, `${profile.id}/${spec.name}`).not.toBe(spec.name)
      }
    }
  })

  /**
   * `why` is the reason this package is worth publishing rather than keeping in
   * a constants file: it is the sentence that makes a merchant act. One
   * sentence, ending in a full stop, starting with a capital. A `why` that has
   * grown into a paragraph has stopped being an argument and become docs.
   */
  it('explains every fact in exactly one sentence about the caller', () => {
    for (const profile of ALL_PROFILES) {
      for (const spec of allSpecs(profile)) {
        const where = `${profile.id}/${spec.name}`
        const why = spec.why
        expect(why, where).toBe(why.trim())
        expect(why.endsWith('.'), where).toBe(true)
        expect(why.slice(0, -1).includes('. '), `${where}: more than one sentence`).toBe(false)
        expect(why[0], where).toBe(why[0]?.toUpperCase())
        expect(why.length, where).toBeGreaterThan(30)
        expect(why.length, where).toBeLessThanOrEqual(160)
      }
    }
  })
})

describe('actions and structured-data hints', () => {
  it('uses only known ActionSource kinds, without duplicates', () => {
    const known = new Set(KNOWN_ACTION_KINDS)
    for (const profile of ALL_PROFILES) {
      expect(new Set(profile.actions).size, profile.id).toBe(profile.actions.length)
      for (const action of profile.actions) {
        expect(known.has(action), `${profile.id}: ${action}`).toBe(true)
      }
    }
  })

  it('recommends a schema.org type for every kind except `unknown`', () => {
    for (const profile of ALL_PROFILES) {
      if (profile.id === 'unknown') {
        // An unclassifiable page has no right answer here, and inventing one
        // would be telling merchants to mislabel their pages (design § 3.5:
        // "`unknown` is not an easy exit" — it still has to carry *a* type,
        // just not one we can name for it).
        expect(profile.jsonLdType).toBeUndefined()
        continue
      }
      expect(profile.jsonLdType, profile.id).toMatch(/^[A-Z][A-Za-z]+$/)
    }
  })
})

describe('extends', () => {
  /**
   * The launch eight are the base vocabulary: they must be readable with a
   * single JSON parse and no resolution step, so that a consumer in another
   * language can start with zero merge logic. `extends` exists for proposed
   * vertical profiles (`dentist` extends `place`).
   */
  it('is unused by the launch profiles', () => {
    for (const profile of ALL_PROFILES) {
      expect(profile.extends, profile.id).toBeUndefined()
    }
  })

  it('resolves to a shipped profile whenever it is used', () => {
    for (const profile of ALL_PROFILES) {
      if (profile.extends === undefined) continue
      expect(getProfile(profile.extends), `${profile.id} extends ${profile.extends}`).toBeDefined()
      expect(profile.extends, profile.id).not.toBe(profile.id)
    }
  })
})

describe('getProfile', () => {
  it('returns the profile for every shipped id', () => {
    for (const profile of ALL_PROFILES) {
      expect(getProfile(profile.id)).toBe(profile)
    }
  })

  it('returns undefined for an id we do not ship, rather than throwing', () => {
    expect(getProfile('dentist')).toBeUndefined()
    expect(getProfile('')).toBeUndefined()
    expect(getProfile('Product')).toBeUndefined()
  })
})
