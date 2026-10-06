import { describe, expect, it } from 'vitest'
import { score } from '@rebilder/agent-readability'
import { LINKED_COPY_NOTE, markdownCopyOf } from '../src/markdown-copy'
import { nextSteps } from '../src/next-steps'
import { FIXTURES, loadEvidence } from './support'

describe('business next steps', () => {
  it('derives missing details from core facts without changing the result', () => {
    const result = score(loadEvidence(FIXTURES.rawHtml))
    const before = JSON.stringify(result)
    const missing = result.factProfile.core.filter(
      (kind) => !result.facts.some((fact) => fact.kind === kind),
    )
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

  it('credits a working linked copy and still points at serving it from the page address', () => {
    const result = score(loadEvidence(FIXTURES.linkedCopy))
    const text = nextSteps(result).join('\n')
    expect(text).toContain(LINKED_COPY_NOTE)
    expect(text).toContain('rebilder init')
    // The page address does not negotiate, so there is no second response to diff.
    expect(text).not.toContain('rebilder diff <url>')
  })

  it('does not credit a linked copy that failed to load', () => {
    const text = nextSteps(score(loadEvidence(FIXTURES.linkedCopyBroken))).join('\n')
    expect(text).not.toContain(LINKED_COPY_NOTE)
    expect(text).toContain('run rebilder init')
  })
})

describe('markdownCopyOf', () => {
  it('tells negotiation apart from the ARS 0.3 linked-copy partial credit', () => {
    expect(markdownCopyOf(score(loadEvidence(FIXTURES.gatewayMd)))).toBe('page-address')
    expect(markdownCopyOf(score(loadEvidence(FIXTURES.rawHtml)))).toBe('none')
    expect(markdownCopyOf(score(loadEvidence(FIXTURES.linkedCopyBroken)))).toBe('none')

    const linked = score(loadEvidence(FIXTURES.linkedCopy))
    const d21 = linked.dimensions
      .flatMap((dimension) => dimension.checks)
      .find((check) => check.id === 'machine-representation.negotiated-response')
    // D2.1 earns points, yet nothing was negotiated: earned > 0 is not "negotiates".
    expect(d21?.earned).toBeGreaterThan(0)
    expect(d21?.earned).toBeLessThan(d21?.weight ?? 0)
    expect(linked.cost.negotiatedBytes).toBeNull()
    expect(markdownCopyOf(linked)).toBe('linked')
  })

  it('reads an unscored result as having no copy', () => {
    expect(markdownCopyOf(score(loadEvidence(FIXTURES.timeout)))).toBe('none')
  })
})
