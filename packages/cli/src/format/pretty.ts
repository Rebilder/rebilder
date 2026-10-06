/**
 * format/pretty.ts — the terminal rendering.
 *
 * WHAT IT LEADS WITH, AND WHY IN THAT ORDER. The band, then the integer, then
 * the dimension table, then the cost, then the fixes. §3.6 says ARS is ordinal:
 * "D — Partial" is the finding and "54" is the detail, so the letter is bold and
 * the number is not, and there are no decimals anywhere. Under that, every check
 * prints its own basis word — a heuristic value never renders without its label
 * (scorer determinism) — and the measured/heuristic split prints under the total so
 * nobody has to go and look up how much of their score was inferred.
 *
 * WHAT IT REFUSES TO PRINT. No excerpt of the target page. Structure and
 * numbers: byte counts, offsets, statuses, check evidence values. The visceral
 * impact is in the numbers (§5.3), and a tool that dumps somebody's page into a
 * build log has a copyright problem the numbers do not.
 *
 * The renderer is pure text in, pure text out. It takes its terminal
 * capabilities as an argument and reads no environment, so the ASCII branch and
 * the no-colour branch are both one call away in a test rather than something
 * you have to arrange a TTY to see.
 */

import type { ArsCheck, ArsDimension, ArsResult } from '@rebilder/agent-readability'
import { ARS_NOTICE_LINES } from '../disclosure'
import { LINKED_PARITY_NOTE, markdownCopyOf } from '../markdown-copy'
import { nextSteps } from '../next-steps'
import type { BadgeSnippet, DiffPayload, Payload, Scaffold } from '../payload'
import { outcomeSummary, statusOf, type UrlReport } from '../report'
import {
  createPainter,
  glyphsFor,
  padEnd,
  padStart,
  truncate,
  visibleWidth,
  type Painter,
  type TermCapabilities,
} from '../term'
import {
  absent,
  approxTokens,
  basisLabel,
  bytesText,
  checkMark,
  percent,
  shortHash,
  type FormatContext,
} from './shared'

interface Pretty {
  caps: TermCapabilities
  paint: Painter
}

const BASIS_COLUMN = 9 // 'heuristic'
const POINTS_COLUMN = 7 // '100/100'

/**
 * `_ctx` is unused and stays in the signature anyway: all four renderers are
 * dispatched through one call in `./index`, and a uniform signature is what
 * keeps that dispatch a switch rather than four special cases. The terminal
 * rendering has no use for a generation timestamp — the identity footer already
 * carries the three hashes, which is what actually identifies a score.
 */
export function renderPretty(
  payload: Payload,
  caps: TermCapabilities,
  _ctx: FormatContext,
): string {
  const pretty: Pretty = { caps, paint: createPainter(caps.color) }
  switch (payload.command) {
    case 'check':
      return joinBlocks(payload.reports.map((report) => checkBlock(report, pretty)))
    case 'diff':
      return joinBlocks([diffBlock(payload.diff, pretty)])
    case 'init':
      return joinBlocks([initBlock(payload.scaffold, pretty)])
    case 'badge':
      return joinBlocks([badgeBlock(payload.badge, pretty)])
  }
}

/**
 * Trailing whitespace is trimmed per line. The last column is padded so the
 * table aligns, and that padding then has nothing to its right — it is invisible
 * on screen and pure noise in a `--out` file, a git diff, or a README block that
 * a test compares byte for byte.
 */
function joinBlocks(blocks: string[][]): string {
  return (
    blocks
      .map((lines) => lines.map((line) => line.replace(/[ \t]+$/, '')).join('\n'))
      .join('\n\n') + '\n'
  )
}

/* ── check ────────────────────────────────────────────────────────────────── */

function gradeStyle(grade: string): 'green' | 'cyan' | 'yellow' | 'red' {
  if (grade === 'A') return 'green'
  if (grade === 'B') return 'cyan'
  if (grade === 'C') return 'yellow'
  return 'red'
}

function checkBlock(report: UrlReport, pretty: Pretty): string[] {
  const { paint, caps } = pretty
  const glyphs = glyphsFor(caps.unicode)
  const lines: string[] = []
  const width = caps.width

  lines.push(paint(truncate(report.url, width, caps.unicode), 'bold'))
  lines.push(paint(glyphs.horizontal.repeat(Math.min(width, 64)), 'gray'))

  if (report.kind === 'rejected') {
    lines.push(`${paint('REJECTED', 'red', 'bold')}  ${outcomeSummary(report)}`)
    lines.push(...noticeLines(pretty))
    return lines
  }

  const { result } = report
  const status = statusOf(report)

  if (status !== 'scored') {
    lines.push(paint(outcomeSummary(report), 'yellow'))
    lines.push('')
    lines.push(...policyLines(result, pretty))
    lines.push(...identityLines(result, pretty))
    lines.push(...noticeLines(pretty))
    return lines
  }

  const grade = result.grade ?? '?'
  const scoreText = `${result.score ?? 0}/100`
  lines.push(
    `${paint(grade, gradeStyle(grade), 'bold')}  ${paint(result.bandLabel ?? '', 'bold')}  ${paint(scoreText, 'gray')}`,
  )
  lines.push(
    paint(
      `${result.measuredWeight} of the 100 points are measured, ${result.heuristicWeight} heuristic`,
      'gray',
    ),
  )
  lines.push(
    paint(
      `page kind: ${result.pageKind} (${result.pageKindConfidence} confidence, ${basisLabel(result.pageKindBasis)})`,
      'gray',
    ),
  )
  lines.push('')

  lines.push(paint('Your next steps', 'bold'))
  for (const step of nextSteps(result)) lines.push(`  ${glyphs.bullet} ${step}`)
  lines.push('')

  for (const dimension of result.dimensions) {
    lines.push(...dimensionLines(dimension, pretty))
  }

  lines.push('')
  lines.push(...costLines(result, pretty))

  if (result.flags.length > 0) {
    lines.push('')
    lines.push(paint('Flags', 'bold'))
    for (const flag of result.flags) {
      const tone = flag.severity === 'warn' ? 'yellow' : 'gray'
      lines.push(
        `  ${glyphs.bullet} ${paint(flag.id, tone)} [${basisLabel(flag.basis)}] ${flag.message}`,
      )
    }
  }

  if (result.recommendations.length > 0) {
    lines.push('')
    lines.push(paint('Fixes, most points first', 'bold'))
    for (const recommendation of result.recommendations) {
      lines.push(
        `  ${padStart(`+${recommendation.pointsAvailable}`, 4)}  ${paint(recommendation.title, 'bold')} ${paint(`(${recommendation.effort})`, 'gray')}`,
      )
      lines.push(
        paint(`        ${truncate(recommendation.detail, caps.width - 8, caps.unicode)}`, 'gray'),
      )
    }
  }

  lines.push('')
  lines.push(...policyLines(result, pretty))
  lines.push(...identityLines(result, pretty))
  lines.push(...noticeLines(pretty))
  return lines
}

function dimensionLines(dimension: ArsDimension, pretty: Pretty): string[] {
  const { paint, caps } = pretty
  const lines: string[] = []
  const head = `${dimension.label}`
  const points = `${dimension.earned}/${dimension.weight}`
  const labelWidth = Math.max(10, caps.width - POINTS_COLUMN - BASIS_COLUMN - 4)
  lines.push(
    `${paint(padEnd(truncate(head, labelWidth, caps.unicode), labelWidth), 'bold')} ${padStart(points, POINTS_COLUMN)} ${padEnd(basisLabel(dimension.basis), BASIS_COLUMN)}`,
  )
  for (const check of dimension.checks) {
    lines.push(checkLine(check, pretty, labelWidth))
  }
  return lines
}

function checkLine(check: ArsCheck, pretty: Pretty, labelWidth: number): string {
  const { paint, caps } = pretty
  const mark = checkMark(check, caps.unicode)
  const tone = check.earned >= check.weight ? 'green' : check.earned > 0 ? 'yellow' : 'red'
  const label = `  ${mark} ${check.label}`
  const points = `${check.earned}/${check.weight}`
  return `${padEnd(truncate(label, labelWidth, caps.unicode), labelWidth)} ${paint(padStart(points, POINTS_COLUMN), tone)} ${paint(padEnd(basisLabel(check.basis), BASIS_COLUMN), 'gray')}`
}

function costLines(result: ArsResult, pretty: Pretty): string[] {
  const { paint, caps } = pretty
  const { cost } = result
  const lines = [paint('What an agent pays', 'bold')]
  const html = bytesText(cost.htmlBytes, cost.truncated, caps.unicode)
  const negotiated = bytesText(cost.negotiatedBytes, cost.truncated, caps.unicode)
  const byteColumn = Math.max(visibleWidth(html), visibleWidth(negotiated)) + 3
  lines.push(
    `  HTML          ${padEnd(html, byteColumn)}${approxTokens(cost.approxHtmlTokens, caps.unicode)}`,
  )
  lines.push(
    `  Negotiated    ${padEnd(negotiated, byteColumn)}${approxTokens(cost.approxNegotiatedTokens, caps.unicode)}`,
  )
  if (cost.reductionRatio !== null) {
    lines.push(paint(`  Reduction     ${cost.reductionRatio}%`, 'green'))
  }
  lines.push(
    `  First core fact at byte ${cost.firstCoreFactOffset === null ? absent(caps.unicode) : cost.firstCoreFactOffset.toLocaleString('en-US')}`,
  )
  const core = result.factProfile.core
  const found = result.facts.filter((fact) => core.includes(fact.kind)).length
  lines.push(
    paint(
      `  Core facts found ${found}/${core.length} (${percent(found, core.length)}) for a ${result.pageKind} page — heuristic`,
      'gray',
    ),
  )
  return lines
}

function policyLines(result: ArsResult, pretty: Pretty): string[] {
  const { paint } = pretty
  const { policy } = result
  const parts = [
    `robots.txt ${policy.robotsTxtStatus}`,
    `assistant ${policy.audiences.assistant.decision}`,
    `training ${policy.audiences.training.decision} (neutral)`,
    `sitemap ${policy.sitemapDeclared ? 'declared' : 'not declared'}`,
  ]
  return [paint(`Policy: ${parts.join(' · ')}`, 'gray')]
}

function identityLines(result: ArsResult, pretty: Pretty): string[] {
  const { paint } = pretty
  return [
    paint(
      `ARS ${result.specVersion} · ruleset ${shortHash(result.rulesetHash)} · corpus ${shortHash(result.corpusHash)} · evidence ${shortHash(result.evidenceHash)} · vantage ${result.vantage}`,
      'gray',
    ),
  ]
}

function noticeLines(pretty: Pretty): string[] {
  return ['', ...ARS_NOTICE_LINES.map((line) => pretty.paint(line, 'gray'))]
}

/* ── diff ─────────────────────────────────────────────────────────────────── */

function diffBlock(diff: DiffPayload, pretty: Pretty): string[] {
  const { paint, caps } = pretty
  const glyphs = glyphsFor(caps.unicode)
  const lines: string[] = [
    paint(truncate(diff.url, caps.width, caps.unicode), 'bold'),
    paint(glyphs.horizontal.repeat(Math.min(caps.width, 64)), 'gray'),
  ]

  if (diff.report.kind === 'rejected') {
    lines.push(`${paint('REJECTED', 'red', 'bold')}  ${outcomeSummary(diff.report)}`)
    lines.push(...noticeLines(pretty))
    return lines
  }

  lines.push(
    paint(
      'The two requests differ in the Accept header and in nothing else — same User-Agent, same everything (§3.3).',
      'gray',
    ),
  )
  lines.push('')

  const rows: [string, string, string][] = [
    ['', 'agent', 'browser'],
    [
      'Accept',
      diff.agent?.accept ?? absent(caps.unicode),
      diff.browser?.accept ?? absent(caps.unicode),
    ],
    ['Status', text(diff.agent?.status, caps.unicode), text(diff.browser?.status, caps.unicode)],
    [
      'Content-Type',
      diff.agent?.contentType ?? absent(caps.unicode),
      diff.browser?.contentType ?? absent(caps.unicode),
    ],
    [
      'Bytes',
      bytesText(diff.agent?.bytes ?? null, diff.agent?.truncated ?? false, caps.unicode),
      bytesText(diff.browser?.bytes ?? null, diff.browser?.truncated ?? false, caps.unicode),
    ],
    [
      'Tokens',
      approxTokens(diff.agent?.approxTokens ?? null, caps.unicode),
      approxTokens(diff.browser?.approxTokens ?? null, caps.unicode),
    ],
    [
      'Redirects',
      text(diff.agent?.redirects, caps.unicode),
      text(diff.browser?.redirects, caps.unicode),
    ],
    [
      'Error',
      diff.agent?.error ?? absent(caps.unicode),
      diff.browser?.error ?? absent(caps.unicode),
    ],
  ]

  const labelWidth = Math.max(...rows.map((row) => row[0].length)) + 2
  const columnWidth = Math.max(12, Math.floor((caps.width - labelWidth - 2) / 2))
  for (const [label, agentCell, browserCell] of rows) {
    lines.push(
      `${paint(padEnd(label, labelWidth), 'bold')}${padEnd(truncate(agentCell, columnWidth, caps.unicode), columnWidth + 2)}${truncate(browserCell, columnWidth, caps.unicode)}`,
    )
  }

  if (diff.parity !== null) {
    lines.push('')
    lines.push(
      `${paint('Substance parity', 'bold')} ${paint(`[${basisLabel(diff.parity.basis)}]`, 'gray')} ${diff.parity.earned}/${diff.parity.weight}`,
    )
    lines.push(
      paint(
        '  Compared on price, currency, availability and title only — never description or free text (§3.8).',
        'gray',
      ),
    )
    if (diff.result !== null && markdownCopyOf(diff.result) === 'linked') {
      lines.push(paint(`  ${LINKED_PARITY_NOTE}`, 'gray'))
    }
    for (const evidence of diff.parity.evidence) {
      lines.push(
        `  ${glyphs.bullet} ${evidence.label}: ${evidence.value} [${basisLabel(evidence.basis)}]`,
      )
    }
  }

  if (diff.result !== null) {
    lines.push('')
    lines.push(paint(`Score: ${outcomeSummary(diff.report)}`, 'gray'))
    lines.push(...identityLines(diff.result, pretty))
  }
  lines.push(...noticeLines(pretty))
  return lines
}

function text(value: number | null | undefined, unicode: boolean): string {
  return value === undefined || value === null ? absent(unicode) : String(value)
}

/* ── init and badge ───────────────────────────────────────────────────────── */

function initBlock(scaffold: Scaffold, pretty: Pretty): string[] {
  const { paint } = pretty
  const lines = [
    paint(`Detected framework: ${scaffold.framework}`, 'bold'),
    paint(`  ${scaffold.detection}`, 'gray'),
    '',
    paint(`Suggested path: ${scaffold.suggestedPath}`, 'gray'),
    '',
    scaffold.contents.trimEnd(),
  ]
  if (scaffold.notes.length > 0) {
    lines.push('')
    for (const note of scaffold.notes) lines.push(paint(`  ${note}`, 'gray'))
  }
  return lines
}

function badgeBlock(badge: BadgeSnippet, pretty: Pretty): string[] {
  const { paint } = pretty
  const lines = [
    paint(`Badge for ${badge.domain}`, 'bold'),
    '',
    paint('Markdown', 'bold'),
    badge.markdown,
    '',
    paint('HTML', 'bold'),
    badge.html,
    '',
  ]
  for (const note of badge.notes) lines.push(paint(`  ${note}`, 'gray'))
  return lines
}
