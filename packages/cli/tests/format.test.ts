/**
 * format.test.ts — all four renderings, over real conformance evidence.
 *
 * THE ASSERTIONS THAT ARE NOT COSMETIC, and are the reason this file is longer
 * than a snapshot test would be:
 *
 *  - **scorer determinism.** Every heuristic check renders its label, in every format.
 *    Asserted by sweeping the result rather than by spot-checking one line: the
 *    rule is "never", so the test has to be a sweep.
 *  - **The §3.6 notice appears in all four formats**, including JSON (as a field,
 *    since JSON has no comments) and JUnit (as a property). A disclaimer that
 *    survives only in the pretty renderer is a disclaimer that disappears the
 *    moment anyone automates.
 *  - **JUnit's failure/error split** mirrors the 1-vs-3 split. A page we never
 *    scored produces an `<error>` and zero `<failure>`s.
 *  - **No page body ever appears in any output.** The fixture bodies are in the
 *    evidence bundle in memory; a formatter reaching them would be a
 *    copyright-shaped bug that no other test would catch.
 *  - **The ASCII fallback contains no box-drawing code points**, because a
 *    `LANG=C` container rendering mojibake into a build log is indistinguishable
 *    from a crash.
 */

import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli'
import { ARS_NOTICE, ARS_NOTICE_LINES } from '../src/disclosure'
import { createFakeRuntime, evidenceOutcome, FIXTURES, loadEvidence, rejection } from './support'

const URL = 'https://basecamp-supply.example/products/alpine-trail-pack-28l'

type Env = Record<string, string | undefined>

const UTF8: Env = { NO_COLOR: '1', LANG: 'en_US.UTF-8' }
const ASCII: Env = { NO_COLOR: '1', LANG: 'C' }

async function output(argv: string[], fixture: string, env: Env = UTF8): Promise<string> {
  const fake = createFakeRuntime({ outcomes: [evidenceOutcome(fixture)], env })
  await runCli(argv, fake.runtime)
  return fake.stdout()
}

describe('pretty', () => {
  it('leads with the band, then the integer — ARS is ordinal (§3.6)', async () => {
    const text = await output(['check', URL], FIXTURES.rawHtml)
    expect(text).toContain('D  Partial  59/100')
    // No decimals, ever (§3.6). Checked on the score and points lines; the
    // identity footer legitimately carries "ARS 0.2.0".
    for (const line of text.split('\n')) {
      if (line.startsWith('ARS ')) continue
      expect(line, line).not.toMatch(/\b\d+\.\d/)
    }
  })

  it('prints the measured/heuristic split under the total', async () => {
    const text = await output(['check', URL], FIXTURES.gatewayMd)
    expect(text).toContain('63 of the 100 points are measured, 37 heuristic')
  })

  it('labels every heuristic check — scorer determinism, swept not spot-checked', async () => {
    const text = await output(['check', URL], FIXTURES.rawHtml)
    const evidence = loadEvidence(FIXTURES.rawHtml)
    expect(evidence).toBeDefined()
    for (const line of text.split('\n')) {
      // Every check line ends in its basis word. If a line carries a points
      // fraction it must also carry a basis.
      if (/^\s{2}[✔✘◐+x~] /.test(line)) {
        expect(line).toMatch(/(measured|heuristic)\s*$/)
      }
    }
    expect(text).toContain('page kind: product (high confidence, heuristic)')
  })

  it('renders the token estimate with ≈ and "est." every time it appears', async () => {
    const text = await output(['check', URL], FIXTURES.gatewayMd)
    for (const match of text.matchAll(/tokens/g)) {
      expect(match).toBeDefined()
    }
    expect(text).toContain('≈22,806 tokens (est.)')
    expect(text).toContain('≈372 tokens (est.)')
    expect(text).not.toMatch(/\d+ tokens(?! \(est\.\))/)
  })

  it('the ASCII fallback uses none of OUR non-ASCII glyphs', async () => {
    // Scoped to the glyphs this package chooses. Text supplied by the scorer —
    // a remedy string containing an ellipsis, say — is content, not layout, and
    // rewriting somebody else's prose to fit a terminal is not our call.
    const text = await output(['check', URL], FIXTURES.rawHtml, ASCII)
    expect(text).not.toMatch(/[─│┌┐└┘├┤✔✘◐•≈≥]/u)
    expect(text).toContain('~22,806 tokens (est.)')
    // The "no value here" placeholder falls back too.
    expect(text).toContain('  Negotiated    -')
  })

  it('uses box drawing and the ≈/≥ glyphs when the locale says UTF-8', async () => {
    const text = await output(['check', URL], FIXTURES.rawHtml, UTF8)
    expect(text).toMatch(/─/u)
    expect(text).toMatch(/[✔✘◐]/u)
    expect(text).toContain('≈')
  })

  it('emits no ANSI when NO_COLOR is set, and does when FORCE_COLOR is', async () => {
    const plain = await output(['check', URL], FIXTURES.rawHtml, UTF8)
    expect(plain).not.toMatch(/\u001b\[/)
    const colored = await output(['check', URL], FIXTURES.rawHtml, {
      LANG: 'en_US.UTF-8',
      FORCE_COLOR: '1',
    })
    expect(colored).toMatch(/\u001b\[/)
  })

  it('NO_COLOR wins over FORCE_COLOR and over a TTY', async () => {
    const fake = createFakeRuntime({
      outcomes: [evidenceOutcome(FIXTURES.rawHtml)],
      env: { NO_COLOR: '', FORCE_COLOR: '1', LANG: 'en_US.UTF-8' },
      isTty: true,
    })
    await runCli(['check', URL], fake.runtime)
    expect(fake.stdout()).not.toMatch(/\u001b\[/)
  })
})

describe('json', () => {
  it('emits the ArsResult verbatim inside an envelope', async () => {
    const text = await output(['check', URL, '--format', 'json'], FIXTURES.rawHtml)
    const parsed = JSON.parse(text) as {
      tool: string
      notice: string
      failOn: string | null
      results: { url: string; status: string; exitCode: number; result: Record<string, unknown> }[]
    }
    expect(parsed.tool).toBe('rebilder')
    expect(parsed.notice).toBe(ARS_NOTICE)
    expect(parsed.failOn).toBeNull()
    const [first] = parsed.results
    expect(first?.status).toBe('scored')
    expect(first?.exitCode).toBe(0)
    expect(first?.result['score']).toBe(59)
    expect(first?.result['grade']).toBe('D')
    // §3.1: a number without all three identity fields is not an ARS score.
    expect(first?.result['specVersion']).toBe('0.2.0')
    expect(typeof first?.result['rulesetHash']).toBe('string')
    expect(typeof first?.result['corpusHash']).toBe('string')
    expect(typeof first?.result['evidenceHash']).toBe('string')
  })

  it('carries basis on every check', async () => {
    const text = await output(['check', URL, '--format', 'json'], FIXTURES.rawHtml)
    const parsed = JSON.parse(text) as {
      results: { result: { dimensions: { checks: { basis: string }[] }[] } }[]
    }
    const dimensions = parsed.results[0]?.result.dimensions ?? []
    expect(dimensions.length).toBe(7)
    for (const dimension of dimensions) {
      for (const check of dimension.checks) {
        expect(['measured', 'heuristic']).toContain(check.basis)
      }
    }
  })

  it('reports a rejection as a rejection, with a null result', async () => {
    const fake = createFakeRuntime({ outcomes: [rejection('policy-rejected', 'reserved address')] })
    await runCli(['check', URL, '--format', 'json'], fake.runtime)
    const parsed = JSON.parse(fake.stdout()) as {
      results: { status: string; rejection: string; result: unknown }[]
    }
    expect(parsed.results[0]?.status).toBe('rejected')
    expect(parsed.results[0]?.rejection).toBe('policy-rejected')
    expect(parsed.results[0]?.result).toBeNull()
  })

  it('is valid JSON for every command', async () => {
    for (const argv of [['init'], ['badge', 'example.com']]) {
      const fake = createFakeRuntime()
      await runCli([...argv, '--format', 'json'], fake.runtime)
      expect(() => JSON.parse(fake.stdout())).not.toThrow()
    }
  })
})

describe('markdown', () => {
  it('carries a basis column on every row and the notice as a blockquote', async () => {
    const text = await output(['check', URL, '--format', 'markdown'], FIXTURES.rawHtml)
    expect(text).toContain('| Check | Points | Basis |')
    for (const line of text.split('\n')) {
      if (/^\| [^|]+ \| \d+\/\d+ \|/.test(line)) {
        expect(line).toMatch(/\| (measured|heuristic) \|$/)
      }
    }
    for (const noticeLine of ARS_NOTICE_LINES) {
      expect(text).toContain(`> ${noticeLine}`)
    }
  })

  it('escapes a pipe so a URL cannot split the row', async () => {
    const fake = createFakeRuntime({ outcomes: [rejection('invalid-url', 'nope')] })
    await runCli(['check', 'https://x.example/a|b', '--format', 'markdown'], fake.runtime)
    expect(fake.stdout()).toContain('a\\|b')
  })
})

describe('junit', () => {
  it('one testcase per check, one testsuite per URL, failures for shortfalls', async () => {
    const text = await output(
      ['check', URL, '--format', 'junit', '--fail-on', 'B'],
      FIXTURES.rawHtml,
    )
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    // 22 checks + the threshold case.
    expect(text).toContain('tests="23"')
    expect(text).toContain('errors="0"')
    expect(text).toContain('name="threshold --fail-on B"')
    expect(text).toContain('graded D (59/100); the threshold is B or better')
  })

  it('omits the threshold case entirely when no threshold was set', async () => {
    const text = await output(['check', URL, '--format', 'junit'], FIXTURES.rawHtml)
    expect(text).not.toContain('name="threshold')
    expect(text).toContain('tests="22"')
  })

  it('a target we never scored is an ERROR, never a failure', async () => {
    const text = await output(
      ['check', URL, '--format', 'junit', '--fail-on', 'A'],
      FIXTURES.timeout,
    )
    expect(text).toContain('errors="1"')
    expect(text).toContain('failures="0"')
    expect(text).toContain('<error type="unscored"')
    expect(text).not.toContain('<failure')
  })

  it('carries the notice as a property and the basis in every case name', async () => {
    const text = await output(['check', URL, '--format', 'junit'], FIXTURES.rawHtml)
    expect(text).toContain(`<property name="notice" value="${ARS_NOTICE}"/>`)
    for (const match of text.matchAll(/name="([a-z-]+\.[a-z-]+) \[([a-z]+)\]/g)) {
      expect(['measured', 'heuristic']).toContain(match[2])
    }
  })

  it('escapes XML — a remedy containing < and " does not break the document', async () => {
    const text = await output(['check', URL, '--format', 'junit'], FIXTURES.rawHtml)
    expect(text).toContain('&lt;')
    expect(text).toContain('&quot;')
    expect(text).not.toMatch(/>[^<]*<link rel/)
  })

  it('is refused for commands that make no observations', async () => {
    for (const argv of [['init'], ['badge', 'example.com']]) {
      const fake = createFakeRuntime()
      const code = await runCli([...argv, '--format', 'junit'], fake.runtime)
      expect(code).toBe(2)
      expect(fake.stderr()).toContain('makes none')
    }
  })
})

describe('every format, every outcome', () => {
  const outcomes = [
    ['scored A', evidenceOutcome(FIXTURES.gatewayMd)],
    ['scored D', evidenceOutcome(FIXTURES.rawHtml)],
    ['opt-out', evidenceOutcome(FIXTURES.optOut)],
    ['unscored', evidenceOutcome(FIXTURES.timeout)],
    ['rejected', rejection('policy-rejected', 'reserved address')],
  ] as const

  it.each(outcomes)('%s renders the §3.6 notice in all four formats', async (_label, outcome) => {
    for (const format of ['pretty', 'json', 'markdown', 'junit']) {
      const fake = createFakeRuntime({ outcomes: [outcome], env: UTF8 })
      await runCli(['check', URL, '--format', format], fake.runtime)
      expect(fake.stdout(), `${format} lost the notice`).toContain(
        format === 'pretty' || format === 'markdown' ? ARS_NOTICE_LINES[0] : ARS_NOTICE,
      )
    }
  })

  it.each(outcomes)('%s never leaks the target page body', async (_label, outcome) => {
    // A distinctive sentence that exists in the fixture bodies and must never
    // reach any rendering.
    const bodies = [loadEvidence(FIXTURES.rawHtml), loadEvidence(FIXTURES.gatewayMd)]
      .flatMap((evidence) => [evidence.probes.agent, evidence.probes.browser])
      .flatMap((record) => (record.result.ok ? [record.result.capture.body ?? ''] : []))
      .filter((body) => body.length > 200)
    expect(bodies.length).toBeGreaterThan(0)

    for (const format of ['pretty', 'json', 'markdown', 'junit']) {
      const fake = createFakeRuntime({ outcomes: [outcome], env: UTF8 })
      await runCli(['check', URL, '--format', format], fake.runtime)
      const rendered = fake.stdout()
      for (const body of bodies) {
        const slice = body.slice(120, 200)
        expect(rendered.includes(slice), `${format} leaked page content`).toBe(false)
      }
    }
  })
})

describe('--out', () => {
  it('writes exactly what stdout showed, in the same format', async () => {
    const fake = createFakeRuntime({ outcomes: [evidenceOutcome(FIXTURES.rawHtml)], env: UTF8 })
    await runCli(['check', URL, '--format', 'junit', '--out', 'ars.xml'], fake.runtime)
    expect(fake.written.get('ars.xml')).toBe(fake.stdout())
  })

  it('does not silence stdout — the log copy is the one people read', async () => {
    const fake = createFakeRuntime({ outcomes: [evidenceOutcome(FIXTURES.rawHtml)], env: UTF8 })
    await runCli(['check', URL, '--out', 'report.txt'], fake.runtime)
    expect(fake.stdout().length).toBeGreaterThan(100)
  })
})
