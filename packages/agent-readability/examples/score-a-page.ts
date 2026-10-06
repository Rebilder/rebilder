import { score } from '@rebilder/agent-readability'
import { probeStrict, strictPolicyForRun } from '@rebilder/agent-readability/probe'

// 1. Fetch the evidence: the page as an agent and as a browser, plus robots.txt,
//    llms.txt, /.well-known/ucp and any Markdown copy the page links to.
//    Public https hosts only.
const outcome = await probeStrict('https://example.com/products/trail-pack', strictPolicyForRun())
if (!outcome.ok) throw new Error(`${outcome.rejection}: ${outcome.detail}`)

// 2. Score it. Pure and deterministic: the same evidence always gives the same result.
const result = score(outcome.evidence)

console.log(result.grade, result.score) // e.g. 'B' 81; null for a page that could not be graded
for (const fix of result.recommendations) {
  console.log(`+${fix.pointsAvailable}  ${fix.title}`)
}
