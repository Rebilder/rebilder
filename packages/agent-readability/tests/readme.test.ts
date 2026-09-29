/**
 * The README is the page npm shows. Its code block is examples/score-a-page.ts,
 * which the package typecheck compiles (tsconfig.json maps the public import
 * names to the source), so the documented `probeStrict()` → `score()` flow
 * cannot drift from the API. The claims beside it are checked against the
 * scorer here.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { score } from '../src/index'
import type { ArsEvidence } from '../src/types'

const ROOT = path.resolve(__dirname, '..')
const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
const EXAMPLE = readFileSync(path.join(ROOT, 'examples/score-a-page.ts'), 'utf8').trimEnd()

describe('README', () => {
  it('shows examples/score-a-page.ts verbatim', () => {
    expect(README).toContain('```ts\n' + EXAMPLE + '\n```')
  })

  it('states the measured/heuristic split the scorer reports', () => {
    const evidence = JSON.parse(
      readFileSync(path.join(ROOT, 'conformance/001-pdp-gateway-md/evidence.json'), 'utf8'),
    ) as ArsEvidence
    const result = score(evidence)
    expect(README).toContain(
      `**${result.measuredWeight} points are measured and ${result.heuristicWeight} are heuristic**`,
    )
    expect(result.dimensions).toHaveLength(7)
    expect(README).toContain('seven dimensions')
  })

  it('uses absolute links only, and no contributor steps', () => {
    for (const [, target] of README.matchAll(/\]\(([^)]+)\)/g)) {
      expect(target).toMatch(/^https:\/\//)
    }
    for (const forbidden of ['pnpm --filter', 'tooling/', 'apps/', 'design §']) {
      expect(README, forbidden).not.toContain(forbidden)
    }
  })
})
