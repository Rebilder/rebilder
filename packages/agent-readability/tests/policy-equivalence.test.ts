/**
 * policy-equivalence.test.ts — the three §3.7 claims that a hostile reviewer
 * tests first, asserted directly rather than left to be inferred from a diff of
 * two `expected.json` files.
 *
 * The conformance runner already pins every one of these fixtures to its own
 * `expected.json`, so why a second file? Because a matching pair of expected
 * files proves the pair *currently agrees*, not that agreement is the property
 * being promised. If someone later regenerates the corpus with
 * `ARS_CONFORM_UPDATE=1` and both files move together, the runner stays green
 * and the promise is gone with nothing to show for it. These assertions name the
 * promise:
 *
 *  1. **Blocking training crawlers never lowers the score** (§3.7). `021` and
 *     `022` are the same page and the same probes; their robots.txt differ only
 *     in a group disallowing GPTBot/CCBot/Google-Extended/anthropic-ai. Every
 *     scored field must be identical, and the difference must be confined to the
 *     three places that only *report* the policy.
 *  2. **A deliberate opt-out is not an F** (§3.6). `020` must carry no letter at
 *     all — not `F`, not a zero score. An opt-out is a choice; an F is a verdict.
 *  3. **`vantage: 'self'` bypasses the `rebilder-ars` token check** (§3.7).
 *     `025` and `026` are byte-identical bundles apart from one field, and that
 *     one field is the difference between `unscored` and a real grade.
 *
 * Each assertion re-derives its inputs from the corpus on disk, so it fails if
 * someone edits a fixture to make a claim true rather than making the claim true.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_RULESET } from '../src/ruleset'
import { score } from '../src/score'
import type { ArsEvidence, ArsResult } from '../src/types'

const CORPUS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'conformance')

function evidenceOf(fixture: string): ArsEvidence {
  return JSON.parse(readFileSync(join(CORPUS, fixture, 'evidence.json'), 'utf8')) as ArsEvidence
}

/** Everything that is a score: the number, the letter, and the arithmetic under them. */
function scoredShape(result: ArsResult): unknown {
  return {
    outcome: result.outcome,
    score: result.score,
    grade: result.grade,
    bandLabel: result.bandLabel,
    pageKind: result.pageKind,
    facts: result.facts,
    cost: result.cost,
    recommendations: result.recommendations,
    dimensions: result.dimensions.map((dimension) => ({
      id: dimension.id,
      weight: dimension.weight,
      earned: dimension.earned,
      checks: dimension.checks.map((check) => ({ id: check.id, earned: check.earned })),
    })),
  }
}

describe('§3.7 — a training-crawler opt-out is strictly neutral (021 vs 022)', () => {
  const trainingBlocked = evidenceOf('021-robots-training-optout-only')
  const open = evidenceOf('022-robots-open')

  it('differs only in robots.txt, so the comparison means something', () => {
    // If the two bundles differed anywhere else, an identical score would prove
    // nothing about robots.txt. Null the robots probe out of both and the
    // remainder — target, vantage, both page probes, llms.txt, /.well-known/ucp —
    // must be identical.
    const withoutRobots = (evidence: ArsEvidence): unknown => ({
      ...evidence,
      probes: { ...evidence.probes, robotsTxt: null },
    })
    expect(withoutRobots(trainingBlocked)).toEqual(withoutRobots(open))
  })

  it('scores identically — same number, same letter, same points in every check', () => {
    const blocked = score(trainingBlocked, DEFAULT_RULESET)
    const allowed = score(open, DEFAULT_RULESET)
    expect(blocked.score).toBe(allowed.score)
    expect(blocked.grade).toBe(allowed.grade)
    expect(scoredShape(blocked)).toEqual(scoredShape(allowed))
    // Stated positively too: this is a real score being compared, not two nulls.
    expect(blocked.score).toBeGreaterThan(0)
  })

  it('confines the difference to fields that report the policy and never price it', () => {
    const blocked = score(trainingBlocked, DEFAULT_RULESET)
    const allowed = score(open, DEFAULT_RULESET)

    // The three permitted differences, each a report rather than a judgement.
    expect(blocked.policy.trainingOptOut).toBe(true)
    expect(allowed.policy.trainingOptOut).toBe(false)
    expect(blocked.policy.audiences.training.decision).toBe('disallow')
    expect(allowed.policy.audiences.training.decision).toBe('allow')
    expect(blocked.flags.map((flag) => flag.id)).toEqual(['training-opt-out'])
    expect(allowed.flags).toEqual([])

    // And the flag is `info`. A `warn` here would be the score's disapproval
    // wearing a different hat, which is the thing §3.7 forbids.
    expect(blocked.flags[0]?.severity).toBe('info')

    // The assistant audience — the one ARS actually scores — is allowed in both.
    expect(blocked.policy.audiences.assistant.decision).toBe('allow')
    expect(allowed.policy.audiences.assistant.decision).toBe('allow')
  })
})

describe('§3.6 — a deliberate opt-out is a non-grade, not an F (020)', () => {
  const result = score(evidenceOf('020-robots-deliberate-optout'), DEFAULT_RULESET)

  it('carries no letter and no number', () => {
    expect(result.outcome).toEqual({ kind: 'opt-out', audience: 'assistant', wellFormed: true })
    expect(result.score).toBeNull()
    expect(result.grade).toBeNull()
    expect(result.bandLabel).toBeNull()
  })

  it('is explicitly not an F, and not a zero dressed as one', () => {
    expect(result.grade).not.toBe('F')
    expect(result.score).not.toBe(0)
    expect(result.outcome.kind).not.toBe('scored')
  })

  it('records the choice as information and recommends nothing', () => {
    expect(result.flags.map((flag) => flag.id)).toEqual(['assistant-opt-out'])
    expect(result.flags[0]?.severity).toBe('info')
    // Nothing to fix. A remediation list attached to an opt-out would be a sales
    // pitch aimed at a site that just said no.
    expect(result.recommendations).toEqual([])
  })
})

describe('§3.7 — vantage self bypasses the rebilder-ars token check (025 vs 026)', () => {
  const publicScan = evidenceOf('025-robots-blocks-our-scanner')
  const ownerScan = evidenceOf('026-self-vantage-bypasses-scanner-token')

  it('differs only in `vantage`', () => {
    expect({ ...publicScan, vantage: 'self' as const }).toEqual(ownerScan)
  })

  it('is unscored from the public vantage and scored from the owner’s', () => {
    const blocked = score(publicScan, DEFAULT_RULESET)
    const owner = score(ownerScan, DEFAULT_RULESET)

    expect(blocked.outcome).toEqual({ kind: 'unscored', reason: 'robots-disallow-scanner' })
    expect(blocked.score).toBeNull()
    expect(blocked.flags.map((flag) => flag.id)).toEqual(['scanner-blocked'])

    expect(owner.outcome.kind).toBe('scored')
    expect(owner.grade).not.toBeNull()
    expect(owner.score).toBeGreaterThan(0)
  })
})
