import { describe, expect, it } from 'vitest'
import { score } from '@rebilder/agent-readability'
import { nextSteps } from '../src/next-steps'
import { FIXTURES, loadEvidence } from './support'

describe('business next steps', () => {
  it('derives missing details from core facts without changing the result', () => {
    const result = score(loadEvidence(FIXTURES.rawHtml))
    const before = JSON.stringify(result)
    const missing = result.factProfile.core.filter((kind) => !result.facts.some((fact) => fact.kind === kind))
    const text = nextSteps(result).join('\n')
    for (const kind of missing) expect(text).toContain(kind)
    expect(text).toContain('(heuristic)')
    expect(text).toContain('run rebilder check <url> again')
    expect(text).toContain('--format markdown --out review.md')
    expect(JSON.stringify(result)).toBe(before)
  })

  it('does not interpret an unreachable page as missing business information', () => {
    expect(nextSteps(score(loadEvidence(FIXTURES.timeout)))).toEqual([])
  })

  it('routes an existing representation to comparison instead of a new installation', () => {
    const result = score(loadEvidence(FIXTURES.gatewayMd))
    expect(nextSteps(result).join('\n')).toContain('rebilder diff <url>')
    expect(nextSteps(result).join('\n')).not.toContain('run rebilder init')
  })
})
