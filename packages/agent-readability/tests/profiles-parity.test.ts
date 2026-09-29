/**
 * Parity between the scorer's page-kind profiles and the published JSON.
 *
 * Two artifacts state which facts a page of each kind owes an agent:
 * `src/profiles.ts` here, which the score is computed from, and
 * `packages/profiles/profiles/*.json`, which `@rebilder/profiles` publishes so
 * that other implementations (in any language) can read the same vocabulary.
 * A merchant is told what to fix by the second and graded by the first. If they
 * disagree, the score measures something nobody was told to do.
 *
 * Each package already compares itself with the design's page-kind table by
 * hand. This test compares the two packages with each other directly: same
 * page kinds, same order, and `core` / `extended` equal to `required` /
 * `recommended` name for name, in order. It reads the JSON from disk rather
 * than importing `@rebilder/profiles`, so the scorer keeps zero dependencies.
 *
 * The ARS patch gate in release.yml already treats both paths as
 * score-defining; this is what makes them move together between releases.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROFILES } from '../src/index'

const PROFILES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../profiles/profiles',
)

interface PublishedProfile {
  id: string
  required: { name: string }[]
  recommended: { name: string }[]
}

const published = new Map<string, PublishedProfile>(
  readdirSync(PROFILES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const profile = JSON.parse(
        readFileSync(path.join(PROFILES_DIR, file), 'utf8'),
      ) as PublishedProfile
      return [profile.id, profile]
    }),
)

describe('ARS profiles agree with @rebilder/profiles', () => {
  it('cover the same page kinds', () => {
    expect([...published.keys()].sort()).toEqual(PROFILES.map((profile) => profile.pageKind).sort())
  })

  for (const profile of PROFILES) {
    describe(profile.pageKind, () => {
      const json = published.get(profile.pageKind)

      it('is published as JSON', () => {
        expect(json, `packages/profiles/profiles/${profile.pageKind}.json`).toBeDefined()
      })

      it('core facts equal the published required facts, in order', () => {
        expect(json?.required.map((fact) => fact.name)).toEqual([...profile.core])
      })

      it('extended facts equal the published recommended facts, in order', () => {
        expect(json?.recommended.map((fact) => fact.name)).toEqual([...profile.extended])
      })
    })
  }
})
