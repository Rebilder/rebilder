/**
 * format/junit.ts — one XML file every CI system already knows how to read.
 *
 * THE MAPPING, AND WHY IT IS NOT THE OBVIOUS ONE.
 *
 * A `<testcase>` per ARS check, a `<testsuite>` per URL. The obvious mapping —
 * one test case per URL, pass/fail on the threshold — throws away the entire
 * report and gives a reviewer a red X with no location, which is precisely the
 * experience that gets a check deleted.
 *
 * The critical distinction is `<failure>` vs `<error>`, which is the JUnit
 * schema's own version of our 1-vs-3 split and the reason this format is worth
 * writing by hand:
 *   - `<failure>` — the page was scored and a check did not earn full marks.
 *     A fact about the site.
 *   - `<error>` — we never got a score: unreachable, blocked, refused, opt-out.
 *     Infrastructure. Every CI dashboard renders errors differently from
 *     failures, and getting this backwards is what teaches a team to ignore the
 *     job.
 * A run whose target was unreachable therefore produces zero failures and one
 * error, and the process exits 3 — the two signals agree.
 *
 * `--fail-on` adds ONE extra test case per URL, named for the threshold, so the
 * gate is visible in the report as its own line rather than implied by the exit
 * code. When no threshold is set that case is absent, not passing: a green
 * "threshold met" for a threshold nobody asked for is a lie of omission.
 */

import { ARS_NOTICE } from '../disclosure'
import type { Payload } from '../payload'
import { exitCodeFor, meetsThreshold, outcomeSummary, statusOf, type UrlReport } from '../report'
import type { Grade } from '../args'
import { EXIT } from '../exit'
import { basisLabel, escapeXml, type FormatContext } from './shared'

const SUITE_NAME = 'rebilder.ars'

export function renderJunit(payload: Payload, ctx: FormatContext): string {
  const suites: string[] = []
  let tests = 0
  let failures = 0
  let errors = 0

  if (payload.command === 'check') {
    for (const report of payload.reports) {
      const suite = checkSuite(report, payload.failOn, ctx)
      suites.push(suite.xml)
      tests += suite.tests
      failures += suite.failures
      errors += suite.errors
    }
  } else if (payload.command === 'diff') {
    const suite = checkSuite(payload.diff.report, null, ctx)
    suites.push(suite.xml)
    tests += suite.tests
    failures += suite.failures
    errors += suite.errors
  } else {
    // `init` and `badge` produce no observations, so they produce no test cases.
    // An empty testsuites element is valid and honest; inventing a passing case
    // for "we printed a snippet" would put a green tick in a report for work no
    // check performed.
    suites.push(
      `  <testsuite name="${SUITE_NAME}.${payload.command}" tests="0" failures="0" errors="0"/>`,
    )
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${SUITE_NAME}" tests="${tests}" failures="${failures}" errors="${errors}">`,
    ...suites,
    '</testsuites>',
    '',
  ].join('\n')
}

interface Suite {
  xml: string
  tests: number
  failures: number
  errors: number
}

function checkSuite(report: UrlReport, failOn: Grade | null, ctx: FormatContext): Suite {
  const cases: string[] = []
  let tests = 0
  let failures = 0
  let errors = 0

  const properties = [
    `      <property name="notice" value="${escapeXml(ARS_NOTICE)}"/>`,
    `      <property name="url" value="${escapeXml(report.url)}"/>`,
    `      <property name="generatedAt" value="${escapeXml(ctx.generatedAt)}"/>`,
    `      <property name="tool" value="rebilder ${escapeXml(ctx.cliVersion)}"/>`,
  ]

  if (report.kind === 'probed') {
    const { result } = report
    properties.push(
      `      <property name="specVersion" value="${escapeXml(result.specVersion)}"/>`,
      `      <property name="rulesetHash" value="${escapeXml(result.rulesetHash)}"/>`,
      `      <property name="corpusHash" value="${escapeXml(result.corpusHash)}"/>`,
      `      <property name="evidenceHash" value="${escapeXml(result.evidenceHash)}"/>`,
      `      <property name="measuredWeight" value="${result.measuredWeight}"/>`,
      `      <property name="heuristicWeight" value="${result.heuristicWeight}"/>`,
    )
  }

  const status = statusOf(report)
  // Narrowed on `report.kind` rather than on `status`, because the compiler can
  // follow the discriminant and cannot follow a helper's return value — and a
  // cast here would be a cast around the one branch that must not be wrong.
  if (report.kind === 'rejected' || report.result.outcome.kind !== 'scored') {
    // Never scored -> exactly one ERROR case. Not a failure: see the header.
    tests += 1
    errors += 1
    cases.push(
      [
        `    <testcase classname="${escapeXml(report.url)}" name="probe">`,
        `      <error type="${escapeXml(status)}" message="${escapeXml(outcomeSummary(report))}"/>`,
        '    </testcase>',
      ].join('\n'),
    )
  } else {
    const { result } = report
    for (const dimension of result.dimensions) {
      for (const check of dimension.checks) {
        tests += 1
        const passed = check.earned >= check.weight
        const name = `${check.id} [${basisLabel(check.basis)}] ${check.earned}/${check.weight}`
        if (passed) {
          cases.push(
            `    <testcase classname="${escapeXml(report.url)}" name="${escapeXml(name)}"/>`,
          )
          continue
        }
        failures += 1
        const detail = [
          check.remedy ?? '',
          ...check.evidence.map(
            (item) => `${item.label}: ${item.value} [${basisLabel(item.basis)}]`,
          ),
        ]
          .filter((line) => line.length > 0)
          .join('\n')
        cases.push(
          [
            `    <testcase classname="${escapeXml(report.url)}" name="${escapeXml(name)}">`,
            `      <failure type="${escapeXml(check.basis)}" message="${escapeXml(`${check.label} earned ${check.earned} of ${check.weight}`)}">${escapeXml(detail)}</failure>`,
            '    </testcase>',
          ].join('\n'),
        )
      }
    }

    if (failOn !== null && result.grade !== null) {
      tests += 1
      const met = meetsThreshold(result.grade, failOn)
      const name = `threshold --fail-on ${failOn}`
      if (met) {
        cases.push(`    <testcase classname="${escapeXml(report.url)}" name="${escapeXml(name)}"/>`)
      } else {
        failures += 1
        cases.push(
          [
            `    <testcase classname="${escapeXml(report.url)}" name="${escapeXml(name)}">`,
            `      <failure type="threshold" message="${escapeXml(`graded ${result.grade} (${result.score}/100); the threshold is ${failOn} or better`)}"/>`,
            '    </testcase>',
          ].join('\n'),
        )
      }
    }
  }

  const exitCode = exitCodeFor(report, failOn)
  properties.push(`      <property name="exitCode" value="${exitCode}"/>`)
  if (exitCode === EXIT.PROBE || exitCode === EXIT.POLICY) {
    properties.push(
      `      <property name="notAScoreFailure" value="${exitCode === EXIT.PROBE ? 'probe failure — infrastructure' : 'blocked by policy'}"/>`,
    )
  }

  const xml = [
    `  <testsuite name="${escapeXml(report.url)}" tests="${tests}" failures="${failures}" errors="${errors}">`,
    '    <properties>',
    ...properties,
    '    </properties>',
    ...cases,
    '  </testsuite>',
  ].join('\n')

  return { xml, tests, failures, errors }
}
