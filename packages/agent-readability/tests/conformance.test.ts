/**
 * conformance.test.ts — the corpus runner. Runs as part of this package's `test`
 * script; the root `ars:conform` alias design §3.10 names is not wired yet.
 *
 * THE CORPUS IS THE STANDARD, not a test suite. The spec (rebilder.com/spec/ars) describes
 * the score in prose; `conformance/` says what the prose means, in JSON, in a
 * form a Go or Python implementation can consume without reading TypeScript. This
 * file is the only thing that connects the two, so its contract is fixed and
 * other people's fixtures depend on it:
 *
 *   conformance/NNN-name/
 *     evidence.json   — the INPUT. An `ArsEvidence` bundle, bodies included.
 *     expected.json   — SPEC-DERIVABLE fields only (see `project()` below).
 *                       A second implementation must reproduce this exactly.
 *     identity.json   — rulesetHash / corpusHash / evidenceHash. Properties of
 *                       OUR artifact; a second implementation is explicitly NOT
 *                       required to match them, and that split is what makes
 *                       independent certification possible at all.
 *     README.md       — one paragraph on what the fixture proves.
 *
 * THE RUNNER GLOBS. Every directory under `conformance/` is picked up with no
 * edit here — add a directory, it runs. That is deliberate: fixtures land from
 * several people at once, and a runner with a hand-maintained list is a runner
 * that silently skips the fixture someone forgot to register.
 *
 * IT FAILS LOUDLY ON A MALFORMED DIRECTORY. A directory with no `evidence.json`,
 * unparseable JSON, or a missing `expected.json` is an ERROR, never a skip. A
 * corpus that quietly ignores half of itself is worse than no corpus: it reports
 * green while proving nothing.
 *
 * REGENERATING: `ARS_CONFORM_UPDATE=1 pnpm --filter @rebilder/agent-readability test`
 * writes `expected.json` and `identity.json` from the current implementation and
 * fails the run afterwards, so an update can never be mistaken for a pass. Read
 * the diff before committing it — blessing output you have not checked is how a
 * corpus stops encoding the spec and starts encoding the bug.
 *
 * WHY `corpusHash` IS NOT ASSERTED. It is a digest over the whole corpus, so it
 * changes every time anyone adds a fixture; pinning it per fixture while the
 * corpus is open would make every new fixture break every old one. It is recorded
 * in `identity.json` and checked at corpus freeze, not here. `rulesetHash` and
 * `evidenceHash` ARE asserted: they are properties of inputs that do not move.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_RULESET } from '../src/ruleset'
import { ARS_CORPUS_HASH, evidenceHash, rulesetHash, score } from '../src/score'
import type { ArsEvidence, ArsResult } from '../src/types'

const HERE = dirname(fileURLToPath(import.meta.url))
export const CORPUS_DIR = resolve(HERE, '..', 'conformance')

const UPDATE = process.env['ARS_CONFORM_UPDATE'] === '1'

/**
 * The spec-derivable projection of a result: everything a second implementation
 * must reproduce, and nothing that is a property of ours.
 *
 * Excluded on purpose: the three hashes (they live in `identity.json`),
 * `specVersion` (pinned by the ruleset, not derived), and every human-facing
 * string — check `label`s, `evidence` lines, flag `message`s, recommendation
 * `title`/`detail`. Those are ours to reword in a PATCH; a corpus that pinned
 * them would make copy edits into spec changes. What IS pinned is every number
 * and every identifier: earned points per check and per dimension, the grade,
 * the flags raised, the page kind, the fact set, the policy decisions, the cost
 * figures, and the recommendation arithmetic.
 */
export function project(result: ArsResult): unknown {
  return {
    outcome: result.outcome,
    score: result.score,
    grade: result.grade,
    bandLabel: result.bandLabel,
    pageKind: result.pageKind,
    pageKindBasis: result.pageKindBasis,
    pageKindConfidence: result.pageKindConfidence,
    factProfile: result.factProfile,
    facts: result.facts,
    dimensions: result.dimensions.map((dimension) => ({
      id: dimension.id,
      weight: dimension.weight,
      earned: dimension.earned,
      basis: dimension.basis,
      checks: dimension.checks.map((check) => ({
        id: check.id,
        basis: check.basis,
        weight: check.weight,
        earned: check.earned,
      })),
    })),
    flags: result.flags.map((flag) => ({
      id: flag.id,
      severity: flag.severity,
      basis: flag.basis,
    })),
    policy: result.policy,
    cost: result.cost,
    recommendations: result.recommendations.map((recommendation) => ({
      id: recommendation.id,
      pointsAvailable: recommendation.pointsAvailable,
      effort: recommendation.effort,
      checks: recommendation.checks,
      unlocks: recommendation.unlocks,
    })),
    measuredWeight: result.measuredWeight,
    heuristicWeight: result.heuristicWeight,
  }
}

export interface Fixture {
  readonly name: string
  readonly dir: string
  readonly evidence: ArsEvidence
}

function readJson(path: string, fixture: string): unknown {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`conformance fixture ${fixture}: cannot read ${path}`)
  }
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`conformance fixture ${fixture}: ${path} is not valid JSON — ${String(error)}`)
  }
}

/** Every fixture directory, in name order. Throws on a malformed one. */
export function loadFixtures(): Fixture[] {
  const entries = readdirSync(CORPUS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  return entries.map((name) => {
    const dir = join(CORPUS_DIR, name)
    const evidencePath = join(dir, 'evidence.json')
    if (!existsSync(evidencePath)) {
      throw new Error(
        `conformance fixture ${name}: no evidence.json. Every directory under conformance/ is a fixture; ` +
          'a directory without an input is a fixture someone abandoned half-written.',
      )
    }
    return { name, dir, evidence: readJson(evidencePath, name) as ArsEvidence }
  })
}

const fixtures = loadFixtures()

describe('conformance corpus', () => {
  it('has fixtures', () => {
    // A green run over an empty corpus proves nothing, so an empty corpus is a
    // failure rather than a vacuous pass.
    expect(fixtures.length).toBeGreaterThan(0)
  })

  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      const result = score(fixture.evidence, DEFAULT_RULESET)
      const actual = project(result)
      const expectedPath = join(fixture.dir, 'expected.json')
      const identityPath = join(fixture.dir, 'identity.json')

      if (UPDATE) {
        writeFileSync(expectedPath, `${JSON.stringify(actual, null, 2)}\n`, 'utf8')
        writeFileSync(
          identityPath,
          `${JSON.stringify(
            {
              rulesetHash: rulesetHash(DEFAULT_RULESET),
              corpusHash: ARS_CORPUS_HASH,
              evidenceHash: evidenceHash(fixture.evidence),
            },
            null,
            2,
          )}\n`,
          'utf8',
        )
      }

      it('matches expected.json', () => {
        if (UPDATE) {
          throw new Error(
            `ARS_CONFORM_UPDATE=1: rewrote ${fixture.name}/expected.json and identity.json. ` +
              'Review the diff, then re-run without the flag.',
          )
        }
        if (!existsSync(expectedPath)) {
          throw new Error(
            `conformance fixture ${fixture.name}: no expected.json. Generate one with ` +
              'ARS_CONFORM_UPDATE=1 and read the diff before committing it.',
          )
        }
        expect(actual).toEqual(readJson(expectedPath, fixture.name))
      })

      it('has a README paragraph saying what it proves', () => {
        expect(existsSync(join(fixture.dir, 'README.md'))).toBe(true)
      })

      it('replays byte-identically (fixture 050 as a corpus-wide property)', () => {
        // The determinism guarantee, asserted on every fixture rather than on one:
        // same evidence, same ruleset, same result, byte for byte. `score()` is
        // called a second time on the same input and the two canonical JSON
        // strings are compared.
        const again = score(fixture.evidence, DEFAULT_RULESET)
        expect(JSON.stringify(again)).toEqual(JSON.stringify(result))
      })

      it('agrees with identity.json on the hashes that do not move', () => {
        if (!existsSync(identityPath)) {
          throw new Error(`conformance fixture ${fixture.name}: no identity.json`)
        }
        const identity = readJson(identityPath, fixture.name) as Record<string, unknown>
        expect(identity['rulesetHash']).toEqual(rulesetHash(DEFAULT_RULESET))
        expect(identity['evidenceHash']).toEqual(evidenceHash(fixture.evidence))
        // corpusHash is recorded but not asserted — see the file header.
        expect(typeof identity['corpusHash']).toBe('string')
      })
    })
  }
})
