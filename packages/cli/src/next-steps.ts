import type { ArsResult } from '@rebilder/agent-readability'
import { LINKED_COPY_NOTE, markdownCopyOf } from './markdown-copy'

/** Guidance uses observations only; it never changes the score or machine output. */
export function nextSteps(result: ArsResult): string[] {
  if (result.outcome.kind !== 'scored') return []
  const found = new Set(result.facts.map((fact) => fact.kind))
  const missing = result.factProfile.core.filter((kind) => !found.has(kind))
  const steps: string[] = []
  if (missing.length > 0) {
    steps.push(
      `Check these business details: ${missing.join(', ')}. They were not detected in this capture (heuristic); verify the page before adding or changing content.`,
    )
  } else {
    steps.push(
      'The expected core business details were detected (heuristic). Review their accuracy against your current products, services and policies.',
    )
  }
  const first = result.recommendations[0]
  if (first !== undefined) steps.push(`Start with: ${first.title}. ${first.detail}`)
  const copy = markdownCopyOf(result)
  steps.push(
    copy === 'page-address'
      ? 'Compare the two responses with rebilder diff <url> and confirm the same business facts reach customers and assistants.'
      : copy === 'linked'
        ? `${LINKED_COPY_NOTE} Run rebilder init in your project to set that up, then connect your real data before deployment.`
        : 'To connect your existing information, run rebilder init in your project. Review the generated configuration and connect your real data before deployment.',
  )
  steps.push(
    'After updating your site, run rebilder check <url> again. Export --format markdown --out review.md to share the findings with your team.',
  )
  steps.push(
    'This scan measures page readability; it does not measure customer demand, AI recommendations or sales.',
  )
  return steps
}
