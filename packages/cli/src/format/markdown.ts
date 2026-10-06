import { nextSteps } from '../next-steps'
/**
 * format/markdown.ts — for a PR comment or a job summary.
 *
 * This is the format that gets pasted into a place other people read, which
 * changes two things about it. First, the basis column is not optional and not
 * abbreviated: someone is going to screenshot the table, and a heuristic point
 * total with no label next to it is exactly the misuse scorer determinism exists to
 * prevent. Second, the §3.6 notice renders as a blockquote at the end of every
 * report, where it survives being copied — a footnote in small text does not.
 *
 * No page excerpts here either, for the same reason as everywhere else: numbers
 * and structure only.
 */

import type { ArsResult } from '@rebilder/agent-readability'
import { ARS_NOTICE_LINES } from '../disclosure'
import { LINKED_PARITY_NOTE, markdownCopyOf } from '../markdown-copy'
import type { DiffPayload, Payload } from '../payload'
import { outcomeSummary, statusOf, type UrlReport } from '../report'
import {
  approxTokens,
  basisLabel,
  bytesText,
  escapeCell,
  shortHash,
  type FormatContext,
} from './shared'

export function renderMarkdown(payload: Payload, ctx: FormatContext): string {
  switch (payload.command) {
    case 'check':
      return payload.reports.map((report) => checkSection(report)).join('\n---\n\n') + notice()
    case 'diff':
      return diffSection(payload.diff) + notice()
    case 'init':
      return initSection(payload, ctx)
    case 'badge':
      return badgeSection(payload)
  }
}

function notice(): string {
  return `\n${ARS_NOTICE_LINES.map((line) => `> ${line}`).join('\n')}\n`
}

function checkSection(report: UrlReport): string {
  const out: string[] = [`## ${escapeCell(report.url)}`, '']

  if (report.kind === 'rejected') {
    out.push(`**REJECTED** — ${outcomeSummary(report)}`, '')
    return out.join('\n')
  }

  const { result } = report
  if (statusOf(report) !== 'scored') {
    out.push(outcomeSummary(report), '')
    out.push(policyLine(result), '')
    out.push(identityLine(result), '')
    return out.join('\n')
  }

  out.push(
    `**${result.grade} — ${result.bandLabel}** · ${result.score}/100 · page kind \`${result.pageKind}\` (${result.pageKindConfidence} confidence, ${basisLabel(result.pageKindBasis)})`,
    '',
    `${result.measuredWeight} of the 100 points are measured; ${result.heuristicWeight} are heuristic.`,
    '',
    '### Your next steps',
    '',
    ...nextSteps(result).map((step) => `- ${escapeCell(step)}`),
    '',
    '| Check | Points | Basis |',
    '| --- | ---: | --- |',
  )

  for (const dimension of result.dimensions) {
    out.push(
      `| **${escapeCell(dimension.label)}** | **${dimension.earned}/${dimension.weight}** | ${basisLabel(dimension.basis)} |`,
    )
    for (const check of dimension.checks) {
      out.push(
        `| ${escapeCell(check.label)} | ${check.earned}/${check.weight} | ${basisLabel(check.basis)} |`,
      )
    }
  }

  out.push('', '### What an agent pays', '')
  out.push('| | Bytes | Tokens |', '| --- | --- | --- |')
  out.push(
    `| HTML | ${bytesText(result.cost.htmlBytes, result.cost.truncated, true)} | ${approxTokens(result.cost.approxHtmlTokens, true)} |`,
  )
  out.push(
    `| Negotiated | ${bytesText(result.cost.negotiatedBytes, result.cost.truncated, true)} | ${approxTokens(result.cost.approxNegotiatedTokens, true)} |`,
  )
  if (result.cost.reductionRatio !== null) {
    out.push(`| Reduction | ${result.cost.reductionRatio}% | |`)
  }

  if (result.flags.length > 0) {
    out.push('', '### Flags', '')
    for (const flag of result.flags) {
      out.push(`- \`${flag.id}\` (${flag.severity}, ${basisLabel(flag.basis)}) — ${flag.message}`)
    }
  }

  if (result.recommendations.length > 0) {
    out.push('', '### Fixes, most points first', '')
    out.push('| Points | Fix | Effort |', '| ---: | --- | --- |')
    for (const recommendation of result.recommendations) {
      out.push(
        `| +${recommendation.pointsAvailable} | ${escapeCell(recommendation.title)} | ${recommendation.effort} |`,
      )
    }
  }

  out.push('', policyLine(result), '', identityLine(result), '')
  return out.join('\n')
}

function policyLine(result: ArsResult): string {
  const { policy } = result
  return `Policy: robots.txt ${policy.robotsTxtStatus} · assistant ${policy.audiences.assistant.decision} · training ${policy.audiences.training.decision} (neutral) · sitemap ${policy.sitemapDeclared ? 'declared' : 'not declared'}`
}

function identityLine(result: ArsResult): string {
  return `ARS ${result.specVersion} · ruleset \`${shortHash(result.rulesetHash)}\` · corpus \`${shortHash(result.corpusHash)}\` · evidence \`${shortHash(result.evidenceHash)}\` · vantage ${result.vantage}`
}

function diffSection(diff: DiffPayload): string {
  const out: string[] = [`## ${escapeCell(diff.url)} — agent view vs browser view`, '']
  if (diff.report.kind === 'rejected') {
    out.push(`**REJECTED** — ${outcomeSummary(diff.report)}`, '')
    return out.join('\n')
  }
  out.push(
    'The two requests differ in the `Accept` header and in nothing else — same User-Agent, same everything.',
    '',
    '| | Agent | Browser |',
    '| --- | --- | --- |',
    `| Accept | \`${escapeCell(diff.agent?.accept ?? '—')}\` | \`${escapeCell(diff.browser?.accept ?? '—')}\` |`,
    `| Status | ${diff.agent?.status ?? '—'} | ${diff.browser?.status ?? '—'} |`,
    `| Content-Type | ${escapeCell(diff.agent?.contentType ?? '—')} | ${escapeCell(diff.browser?.contentType ?? '—')} |`,
    `| Bytes | ${bytesText(diff.agent?.bytes ?? null, diff.agent?.truncated ?? false, true)} | ${bytesText(diff.browser?.bytes ?? null, diff.browser?.truncated ?? false, true)} |`,
    `| Tokens | ${approxTokens(diff.agent?.approxTokens ?? null, true)} | ${approxTokens(diff.browser?.approxTokens ?? null, true)} |`,
    `| Redirects | ${diff.agent?.redirects ?? '—'} | ${diff.browser?.redirects ?? '—'} |`,
  )
  if (diff.parity !== null) {
    out.push(
      '',
      `### Substance parity — ${diff.parity.earned}/${diff.parity.weight} (${basisLabel(diff.parity.basis)})`,
      '',
      'Compared on price, currency, availability and title only — never description or free text.',
      '',
    )
    if (diff.result !== null && markdownCopyOf(diff.result) === 'linked') {
      out.push(LINKED_PARITY_NOTE, '')
    }
    for (const evidence of diff.parity.evidence) {
      out.push(
        `- ${escapeCell(evidence.label)}: ${escapeCell(evidence.value)} (${basisLabel(evidence.basis)})`,
      )
    }
  }
  if (diff.result !== null) out.push('', identityLine(diff.result), '')
  return out.join('\n')
}

function initSection(payload: Extract<Payload, { command: 'init' }>, ctx: FormatContext): string {
  const { scaffold } = payload
  const out = [
    `## Rebilder gateway scaffold — ${scaffold.framework}`,
    '',
    scaffold.detection,
    '',
    `Suggested path: \`${scaffold.suggestedPath}\``,
    '',
    '```' + scaffold.language,
    scaffold.contents.trimEnd(),
    '```',
    '',
  ]
  for (const note of scaffold.notes) out.push(`- ${note}`)
  out.push('', `<!-- generated by rebilder ${ctx.cliVersion} -->`, '')
  return out.join('\n')
}

function badgeSection(payload: Extract<Payload, { command: 'badge' }>): string {
  const { badge } = payload
  const out = [
    `## Rebilder badge — ${badge.domain}`,
    '',
    '```markdown',
    badge.markdown,
    '```',
    '',
    '```html',
    badge.html,
    '```',
    '',
  ]
  for (const note of badge.notes) out.push(`- ${note}`)
  out.push('')
  return out.join('\n')
}
