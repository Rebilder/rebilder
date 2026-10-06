/**
 * render.ts — the prose a model reads. Plain text, no ANSI (this output goes
 * into a transcript, not a terminal), no box drawing.
 *
 * TWO ARS REPORTING RULES ARE ENFORCED HERE RATHER THAN REMEMBERED:
 *  - every ARS number declares measured vs. heuristic, and a heuristic value
 *    never renders without its label;
 *  - a score is never printed without the hashes that make it reproducible.
 *
 * A third comes from §3.3: when a capture was truncated, byte figures are floors
 * and print as ">= N", because rendering a truncated body's size as a total
 * makes the heaviest pages look the cheapest on the one number this product is
 * built on.
 */

import type { ArsCheck, ArsResult } from '@rebilder/agent-readability'

/**
 * How the page gives an agent a Markdown copy, read off the result.
 *
 * ARS 0.3 pays part of D2.1 for a Markdown copy the page links to at another
 * address, when that copy loads. So D2.1 above zero no longer means "the page
 * address negotiates". `cost.negotiatedBytes` is still set only when the page
 * address itself answered with a machine copy, and that is the test for it.
 */
export type MarkdownCopy = 'page-address' | 'linked' | 'none'

export function markdownCopyOf(result: ArsResult): MarkdownCopy {
  if (result.cost.negotiatedBytes !== null) return 'page-address'
  const check = result.dimensions
    .flatMap((dimension) => dimension.checks)
    .find((entry) => entry.id === 'machine-representation.negotiated-response')
  return check !== undefined && check.earned > 0 ? 'linked' : 'none'
}

/** Said wherever a result explains D2.1 for a page whose linked copy works. */
export const LINKED_COPY_NOTE =
  'The page links a Markdown copy that works. Sending it from the page address too earns full credit on D2.1.'

export function formatInteger(value: number): string {
  return value.toLocaleString('en-US')
}

export function formatBytes(value: number, truncated: boolean): string {
  return `${truncated ? '>= ' : ''}${formatInteger(value)} bytes`
}

/** Every approximate-token figure is chars/4 and must carry the marker. */
export function formatApproxTokens(value: number, truncated: boolean): string {
  return `~${truncated ? '>= ' : ''}${formatInteger(value)} tokens (est., heuristic)`
}

function basisTag(check: ArsCheck): string {
  return check.basis === 'measured' ? '[measured] ' : '[heuristic] '
}

function shortHash(hash: string): string {
  return hash.slice(0, 12)
}

export function formatHeadline(result: ArsResult): string {
  if (result.outcome.kind === 'scored') {
    return `${result.target.finalUrl} — grade ${result.outcome.grade}, ${result.outcome.score}/100${
      result.bandLabel === null ? '' : ` (${result.bandLabel})`
    }`
  }
  if (result.outcome.kind === 'opt-out') {
    return `${result.target.finalUrl} — not scored: this site opted out of the ${result.outcome.audience} audience. That is its decision, not a failure and not a low score.`
  }
  return `${result.target.finalUrl} — not scored (${result.outcome.reason})${
    result.outcome.detail === undefined ? '' : `: ${result.outcome.detail}`
  }`
}

export function formatProvenance(result: ArsResult): string {
  return [
    `spec ${result.spec} ${result.specVersion}`,
    `ruleset ${shortHash(result.rulesetHash)}`,
    `corpus ${shortHash(result.corpusHash)}`,
    `evidence ${shortHash(result.evidenceHash)}`,
    `vantage ${result.vantage}`,
  ].join(' · ')
}

function formatDimensions(result: ArsResult): string[] {
  const lines = ['Dimensions']
  for (const dimension of result.dimensions) {
    lines.push(
      `  ${dimension.label.padEnd(24)} ${String(dimension.earned).padStart(3)}/${dimension.weight}  [${dimension.basis}]`,
    )
  }
  return lines
}

function formatGaps(result: ArsResult): string[] {
  const gaps = result.dimensions
    .flatMap((dimension) => dimension.checks)
    .filter((check) => check.earned < check.weight)
  if (gaps.length === 0) return ['Every check is at full marks.']

  const lines = ['Checks below full marks']
  for (const check of gaps) {
    lines.push(`  ${basisTag(check)}${check.id} — ${check.earned}/${check.weight} ${check.label}`)
    for (const evidence of check.evidence) {
      lines.push(`      ${evidence.label}: ${evidence.value} [${evidence.basis}]`)
    }
    if (check.remedy !== undefined) lines.push(`      fix: ${check.remedy}`)
  }
  return lines
}

function formatFlags(result: ArsResult): string[] {
  if (result.flags.length === 0) return []
  const lines = ['Flags']
  for (const flag of result.flags) {
    lines.push(`  (${flag.severity}) [${flag.basis}] ${flag.id}: ${flag.message}`)
    for (const evidence of flag.evidence) {
      lines.push(`      ${evidence.label}: ${evidence.value} [${evidence.basis}]`)
    }
  }
  return lines
}

function formatCost(result: ArsResult): string[] {
  const cost = result.cost
  const lines = ['Context cost']
  lines.push(
    `  HTML representation: ${formatBytes(cost.htmlBytes, cost.truncated)}, ${formatApproxTokens(cost.approxHtmlTokens, cost.truncated)}`,
  )
  if (cost.negotiatedBytes === null) {
    lines.push(
      markdownCopyOf(result) === 'linked'
        ? '  Agent representation: none at the page address. The page links a Markdown copy that works (see D2.1).'
        : '  Agent representation: none — the same HTML is served to an agent asking for text/markdown.',
    )
  } else {
    lines.push(
      `  Agent representation: ${formatBytes(cost.negotiatedBytes, cost.truncated)}, ${formatApproxTokens(cost.approxNegotiatedTokens ?? 0, cost.truncated)}`,
    )
    // Already an integer percent (94 means 94% fewer bytes), not a fraction.
    if (cost.reductionRatio !== null) {
      lines.push(`  Reduction: ${cost.reductionRatio}% fewer bytes [measured]`)
    }
  }
  if (cost.firstCoreFactOffset !== null) {
    lines.push(
      `  First core fact at byte ${formatInteger(cost.firstCoreFactOffset)} [measured offset of a heuristic fact]`,
    )
  }
  if (cost.truncated) {
    lines.push(
      '  NOTE: the body hit the 2 MiB cap, so every byte figure above is a floor, not a total.',
    )
  }
  return lines
}

function formatRecommendations(result: ArsResult): string[] {
  if (result.recommendations.length === 0) return []
  const lines = ['Recommendations, highest recoverable points first']
  result.recommendations.slice(0, 5).forEach((recommendation, position) => {
    lines.push(
      `  ${position + 1}. ${recommendation.title} (+${recommendation.pointsAvailable} pts, ${recommendation.effort})`,
    )
    lines.push(`     ${recommendation.detail}`)
  })
  return lines
}

/** Keep the business review separate from observed facts and score arithmetic. */
export function formatBusinessReview(result: ArsResult): string[] {
  if (result.outcome.kind !== 'scored') return []
  const found = new Set(result.facts.map((fact) => fact.kind))
  const missing = result.factProfile.core.filter((kind) => !found.has(kind))
  const copy = markdownCopyOf(result)
  return [
    'Business review and next steps',
    missing.length > 0
      ? `  Not detected in this capture (heuristic): ${missing.join(', ')}. Check the page and ask the owner for accurate details before proposing content.`
      : '  Expected core facts were detected (heuristic). Ask the owner to confirm their accuracy against current business information.',
    '  Use explain_check with a check id below to understand a finding before making changes.',
    copy === 'page-address'
      ? '  Use compare_agent_view to inspect whether customer and assistant responses carry equivalent business facts.'
      : copy === 'linked'
        ? `  ${LINKED_COPY_NOTE} Use install_snippet after confirming the website framework to set that up. The snippet needs review and real data wiring; it does not install or deploy itself.`
        : '  Use install_snippet after confirming the website framework to prepare a connection to existing business data. The snippet needs review and real data wiring; it does not install or deploy itself.',
    '  After the owner updates the website, run scan_url again to verify the change.',
    '  This scan measures readability, not customer demand, AI recommendations or sales. Do not fill missing details with invented prices, policies or services.',
  ]
}

/** The whole report. Callers put it through the untrusted-content funnel. */
export function formatScanSummary(result: ArsResult): string {
  const sections: string[][] = [
    [formatHeadline(result), formatProvenance(result)],
    [
      `Page kind: ${result.pageKind} [${result.pageKindBasis}, ${result.pageKindConfidence} confidence]`,
      `Weights: ${result.measuredWeight} of 100 points measured, ${result.heuristicWeight} heuristic. Every heuristic value below is labelled.`,
      `robots.txt: ${result.policy.robotsTxtStatus}; assistant audience ${result.policy.audiences.assistant.decision}; training audience ${result.policy.audiences.training.decision} (neutral — never lowers the score).`,
    ],
  ]

  if (result.outcome.kind === 'scored') {
    sections.push(formatBusinessReview(result), formatDimensions(result), formatGaps(result))
  }
  const flags = formatFlags(result)
  if (flags.length > 0) sections.push(flags)
  sections.push(formatCost(result))
  const recommendations = formatRecommendations(result)
  if (recommendations.length > 0) sections.push(recommendations)

  return sections.map((section) => section.join('\n')).join('\n\n')
}
