/**
 * exit-codes.test.ts — the published contract, asserted end to end.
 *
 * Every case here goes through `runCli` with a fake runtime, so what is being
 * tested is the integer the binary would actually return, not a helper's opinion
 * about it.
 *
 * THE PROPERTY THAT MATTERS MOST is the last describe block: exit 1 is
 * unreachable for every outcome that is not a real score. It is written as an
 * exhaustive sweep over every `ArsUnscoredReason`-producing fixture and every
 * `ProbeRejection` rather than as a handful of examples, because the failure this
 * prevents — a flaky network exiting 1 — is one nobody notices until a CI check
 * has already been deleted for being unreliable.
 */

import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli'
import { EXIT, worstExit } from '../src/exit'
import { exitCodeFor, meetsThreshold } from '../src/report'
import { createFakeRuntime, evidenceOutcome, FIXTURES, rejection } from './support'

const URL_A = 'https://basecamp-supply.example/products/alpine-trail-pack-28l'

describe('0 — completed, threshold met or none set', () => {
  it('no threshold: a D still exits 0', async () => {
    const fake = createFakeRuntime({ outcomes: [evidenceOutcome(FIXTURES.rawHtml)] })
    expect(await runCli(['check', URL_A], fake.runtime)).toBe(EXIT.OK)
  })

  it('threshold met: A against --fail-on B', async () => {
    const fake = createFakeRuntime({ outcomes: [evidenceOutcome(FIXTURES.gatewayMd)] })
    expect(await runCli(['check', URL_A, '--fail-on', 'B'], fake.runtime)).toBe(EXIT.OK)
  })

  it('the threshold grade itself passes: D against --fail-on D', async () => {
    const fake = createFakeRuntime({ outcomes: [evidenceOutcome(FIXTURES.rawHtml)] })
    expect(await runCli(['check', URL_A, '--fail-on', 'D'], fake.runtime)).toBe(EXIT.OK)
  })

  it('help, version, init and badge all exit 0 and probe nothing', async () => {
    for (const argv of [['--help'], ['--version'], ['init'], ['badge', 'example.com']]) {
      const fake = createFakeRuntime()
      expect(await runCli(argv, fake.runtime)).toBe(EXIT.OK)
      expect(fake.probedUrls).toEqual([])
    }
  })
})

describe('1 — completed, threshold NOT met', () => {
  it('D against --fail-on B', async () => {
    const fake = createFakeRuntime({ outcomes: [evidenceOutcome(FIXTURES.rawHtml)] })
    expect(await runCli(['check', URL_A, '--fail-on', 'B'], fake.runtime)).toBe(EXIT.THRESHOLD)
  })

  it('one URL below the threshold fails the whole run', async () => {
    const fake = createFakeRuntime({
      outcomes: [evidenceOutcome(FIXTURES.gatewayMd), evidenceOutcome(FIXTURES.rawHtml)],
    })
    expect(await runCli(['check', URL_A, URL_A, '--fail-on', 'A'], fake.runtime)).toBe(
      EXIT.THRESHOLD,
    )
  })

  it('"--fail-on C" means C or better passes', () => {
    expect(meetsThreshold('A', 'C')).toBe(true)
    expect(meetsThreshold('C', 'C')).toBe(true)
    expect(meetsThreshold('D', 'C')).toBe(false)
    expect(meetsThreshold('F', 'C')).toBe(false)
  })
})

describe('2 — usage error', () => {
  it.each([
    ['unknown command', ['scan', URL_A]],
    ['unknown option', ['check', URL_A, '--upload']],
    ['bad format', ['check', URL_A, '--format', 'html']],
    ['bad grade', ['check', URL_A, '--fail-on', 'Z']],
    ['bad concurrency', ['check', URL_A, '--concurrency', '0']],
    ['no URL', ['check']],
    ['diff with --fail-on', ['diff', URL_A, '--fail-on', 'A']],
    ['junit for badge', ['badge', 'example.com', '--format', 'junit']],
    ['bad --framework', ['init', '--framework', 'rails']],
  ])('%s', async (_label, argv) => {
    const fake = createFakeRuntime()
    expect(await runCli(argv, fake.runtime)).toBe(EXIT.USAGE)
    expect(fake.stderr()).toContain('rebilder:')
    expect(fake.probedUrls).toEqual([])
  })

  it('an unparseable URL is the operator’s typo, not the site’s failure', async () => {
    const fake = createFakeRuntime({ outcomes: [rejection('invalid-url', 'not a URL')] })
    expect(await runCli(['check', 'ht!tp://nope'], fake.runtime)).toBe(EXIT.USAGE)
  })
})

describe('3 — probe failed / unreachable (INFRASTRUCTURE)', () => {
  it.each([
    ['timeout', FIXTURES.timeout],
    ['blocked at the edge (403)', FIXTURES.blocked403],
  ])('%s', async (_label, fixture) => {
    const fake = createFakeRuntime({ outcomes: [evidenceOutcome(fixture)] })
    expect(await runCli(['check', URL_A], fake.runtime)).toBe(EXIT.PROBE)
  })

  it('still exits 3 with --fail-on set — a flaky network is never a score failure', async () => {
    const fake = createFakeRuntime({ outcomes: [evidenceOutcome(FIXTURES.timeout)] })
    expect(await runCli(['check', URL_A, '--fail-on', 'A'], fake.runtime)).toBe(EXIT.PROBE)
  })

  it('an unexpected internal throw is 3, never 1', async () => {
    const fake = createFakeRuntime({
      probe: () => Promise.reject(new Error('kaboom')),
    })
    expect(await runCli(['check', URL_A, '--fail-on', 'A'], fake.runtime)).toBe(EXIT.PROBE)
    expect(fake.stderr()).toContain('kaboom')
  })
})

describe('4 — blocked by policy', () => {
  it('the SSRF guard refusing a target', async () => {
    const fake = createFakeRuntime({
      outcomes: [rejection('policy-rejected', 'resolves to a reserved address')],
    })
    expect(await runCli(['check', 'https://internal.example'], fake.runtime)).toBe(EXIT.POLICY)
  })

  it('an exhausted probe budget — "we chose not to send this"', async () => {
    const fake = createFakeRuntime({ outcomes: [rejection('budget-exceeded', 'budget spent')] })
    expect(await runCli(['check', URL_A], fake.runtime)).toBe(EXIT.POLICY)
  })

  it('a deliberate, well-formed assistant opt-out is a choice, not a failure', async () => {
    const fake = createFakeRuntime({ outcomes: [evidenceOutcome(FIXTURES.optOut)] })
    expect(await runCli(['check', URL_A], fake.runtime)).toBe(EXIT.POLICY)
    expect(fake.stdout()).toContain('OPT-OUT')
  })

  it('robots.txt disallowing rebilder-ars — deterministic, so 4 rather than 3', async () => {
    const fake = createFakeRuntime({ outcomes: [evidenceOutcome(FIXTURES.scannerBlocked)] })
    expect(await runCli(['check', URL_A], fake.runtime)).toBe(EXIT.POLICY)
  })

  it('local mode refusing to load surfaces as its own message', async () => {
    const fake = createFakeRuntime({
      probeFactoryError: new Error('refusing to load without --allow-private'),
    })
    const code = await runCli(['check', 'http://staging.internal', '--allow-private'], fake.runtime)
    expect(code).toBe(EXIT.PROBE)
    expect(fake.stderr()).toContain('refusing to load')
  })
})

describe('collapsing several URLs into one integer', () => {
  it('is documented, ordered 2 > 4 > 3 > 1 > 0', () => {
    expect(worstExit([EXIT.OK, EXIT.THRESHOLD, EXIT.PROBE, EXIT.POLICY, EXIT.USAGE])).toBe(
      EXIT.USAGE,
    )
    expect(worstExit([EXIT.OK, EXIT.THRESHOLD, EXIT.PROBE, EXIT.POLICY])).toBe(EXIT.POLICY)
    expect(worstExit([EXIT.OK, EXIT.THRESHOLD, EXIT.PROBE])).toBe(EXIT.PROBE)
    expect(worstExit([EXIT.OK, EXIT.THRESHOLD])).toBe(EXIT.THRESHOLD)
    expect(worstExit([EXIT.OK])).toBe(EXIT.OK)
    expect(worstExit([])).toBe(EXIT.OK)
  })

  it('an unreachable sibling beats a failed threshold', async () => {
    const fake = createFakeRuntime({
      outcomes: [evidenceOutcome(FIXTURES.rawHtml), evidenceOutcome(FIXTURES.timeout)],
    })
    expect(await runCli(['check', URL_A, URL_A, '--fail-on', 'A'], fake.runtime)).toBe(EXIT.PROBE)
  })

  it('a probe failure does not stop the run — every other URL still reports', async () => {
    const fake = createFakeRuntime({
      outcomes: [
        evidenceOutcome(FIXTURES.timeout),
        evidenceOutcome(FIXTURES.gatewayMd),
        evidenceOutcome(FIXTURES.rawHtml),
      ],
    })
    await runCli(['check', URL_A, URL_A, URL_A, '--format', 'json'], fake.runtime)
    const parsed = JSON.parse(fake.stdout()) as { results: { status: string }[] }
    expect(parsed.results.map((entry) => entry.status)).toEqual(['unscored', 'scored', 'scored'])
  })
})

describe('exit 1 is unreachable for anything that is not a real score', () => {
  const nonScores = [
    ['rejection: invalid-url', rejection('invalid-url')],
    ['rejection: policy-rejected', rejection('policy-rejected')],
    ['rejection: budget-exceeded', rejection('budget-exceeded')],
    ['fixture: opt-out', evidenceOutcome(FIXTURES.optOut)],
    ['fixture: robots-disallow-scanner', evidenceOutcome(FIXTURES.scannerBlocked)],
    ['fixture: blocked-at-edge', evidenceOutcome(FIXTURES.blocked403)],
    ['fixture: unreachable', evidenceOutcome(FIXTURES.timeout)],
  ] as const

  it.each(nonScores)('%s never exits 1, at any threshold', async (_label, outcome) => {
    for (const grade of ['A', 'B', 'C', 'D', 'F']) {
      const fake = createFakeRuntime({ outcomes: [outcome] })
      const code = await runCli(['check', URL_A, '--fail-on', grade], fake.runtime)
      expect(code).not.toBe(EXIT.THRESHOLD)
    }
  })

  it('and neither does diff, which sets no threshold at all', async () => {
    for (const [, outcome] of nonScores) {
      const fake = createFakeRuntime({ outcomes: [outcome] })
      expect(await runCli(['diff', URL_A], fake.runtime)).not.toBe(EXIT.THRESHOLD)
    }
    const scored = createFakeRuntime({ outcomes: [evidenceOutcome(FIXTURES.rawHtml)] })
    expect(await runCli(['diff', URL_A], scored.runtime)).toBe(EXIT.OK)
  })

  it('exitCodeFor: only a scored outcome with a threshold can produce 1', () => {
    expect(
      exitCodeFor({ kind: 'rejected', url: 'x', rejection: 'policy-rejected', detail: '' }, 'A'),
    ).toBe(EXIT.POLICY)
  })
})
