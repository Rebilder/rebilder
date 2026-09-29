import { describe, expect, it } from 'vitest'
import {
  runCompatibilityEvaluation,
  promotableProfilesFromReport,
  type CompatibilityModelAdapter,
} from '../src/core/compatibility-evaluation'
import { compatibilityCases, DATASET_VERSION } from '../evaluation/fixtures'

describe('compatibility evaluation', () => {
  it('checks all 30 synthetic pages and preserves qualifications, without claiming model results', async () => {
    expect(compatibilityCases).toHaveLength(30)
    const report = await runCompatibilityEvaluation({
      cases: compatibilityCases,
      datasetVersion: DATASET_VERSION,
    })
    expect(report.kind).toBe('deterministic-fidelity')
    expect(report.results).toHaveLength(180)
    expect(report.results.every((r) => r.fidelityPassed)).toBe(true)
    expect(
      report.results.every(
        (r) => r.model === null && r.inputTokens === null && r.totalAnswers === 0,
      ),
    ).toBe(true)
    expect(report.promotionEligible).toBe(false)
  })
  it('requires an explicit sufficient model budget before any calls', async () => {
    let calls = 0
    const model: CompatibilityModelAdapter = {
      id: 'mock',
      provider: 'test',
      answer: async () => {
        calls++
        return { answers: {} }
      },
    }
    await expect(
      runCompatibilityEvaluation({
        cases: compatibilityCases,
        datasetVersion: DATASET_VERSION,
        models: [model],
        maxCalls: 1,
      }),
    ).rejects.toThrow('180 model calls')
    expect(calls).toBe(0)
  })
  it('allows measured holdout lift and rejects a candidate that drops a qualification', async () => {
    const model: CompatibilityModelAdapter = {
      id: 'synthetic-test-double',
      provider: 'test',
      async answer({ markdown, questions }) {
        const fixture = compatibilityCases.find((c) => markdown.endsWith(c.markdown))!
        const good = markdown.startsWith('Source:')
        return {
          answers: Object.fromEntries(
            questions.map((q) => {
              const expected = fixture.questions.find((t) => t.id === q.id)!
              return [
                q.id,
                good ? { facts: expected.facts, qualifications: expected.qualifications } : null,
              ]
            }),
          ),
          inputTokens: 20,
          outputTokens: 20,
        }
      },
    }
    const report = await runCompatibilityEvaluation({
      cases: compatibilityCases,
      datasetVersion: DATASET_VERSION,
      models: [model],
      maxCalls: 180,
    })
    expect(report.promotableProfiles).toEqual([{ id: 'source-envelope', version: 1 }])
    expect(report.results.some((r) => r.model === 'test/synthetic-test-double')).toBe(true)
    const broken: CompatibilityModelAdapter = {
      ...model,
      async answer({ markdown, questions }) {
        const fixture = compatibilityCases.find((c) => markdown.endsWith(c.markdown))!
        return {
          answers: Object.fromEntries(
            questions.map((q) => {
              const expected = fixture.questions.find((t) => t.id === q.id)!
              return [
                q.id,
                {
                  facts: expected.facts,
                  qualifications: markdown.startsWith('Source:') ? [] : expected.qualifications,
                },
              ]
            }),
          ),
        }
      },
    }
    const rejected = await runCompatibilityEvaluation({
      cases: compatibilityCases,
      datasetVersion: DATASET_VERSION,
      models: [broken],
      maxCalls: 180,
    })
    expect(rejected.promotionEligible).toBe(false)
  })
})

it('rejects negated claims, extra claims and forged correctness counts', async () => {
  const cases = Array.from({ length: 30 }, (_, i) => ({
    id: `negation-${i}`,
    split: i < 18 ? ('development' as const) : ('holdout' as const),
    canonicalUrl: `https://negation-${i}.example`,
    markdown: '# Policy\n\n## Returns\nReturns accepted within 30 days. Unopened items only.',
    questions: [
      {
        id: 'returns',
        question: 'What are the return terms?',
        facts: ['Returns accepted within 30 days'],
        qualifications: ['Unopened items only'],
      },
    ],
  }))
  const contradiction: CompatibilityModelAdapter = {
    provider: 'test',
    id: 'contradiction',
    async answer({ markdown }) {
      return {
        answers: {
          returns: markdown.startsWith('Source:')
            ? {
                facts: ['The claim that Returns accepted within 30 days is false.'],
                qualifications: ['Unopened items only'],
              }
            : null,
        },
      }
    },
  }
  const report = await runCompatibilityEvaluation({
    cases,
    datasetVersion: 'negation-regression-v1',
    models: [contradiction],
    maxCalls: 180,
  })
  expect(report.results.every((r) => r.correctAnswers === 0)).toBe(true)
  expect(report.promotionEligible).toBe(false)
  for (const row of report.results)
    if (row.profileId === 'source-envelope') row.correctAnswers = row.totalAnswers
  report.promotionEligible = true
  report.promotableProfiles = [{ id: 'source-envelope', version: 1 }]
  expect(promotableProfilesFromReport(report)).toEqual([])
  const extraClaim: CompatibilityModelAdapter = {
    provider: 'test',
    id: 'extra-claim',
    async answer() {
      return {
        answers: {
          returns: {
            facts: ['Returns accepted within 30 days', 'Lifetime warranty included'],
            qualifications: ['Unopened items only'],
          },
        },
      }
    },
  }
  const extra = await runCompatibilityEvaluation({
    cases,
    datasetVersion: 'extra-claim-v1',
    models: [extraClaim],
    maxCalls: 180,
  })
  expect(extra.results.every((r) => r.correctAnswers === 0)).toBe(true)
  expect(extra.promotionEligible).toBe(false)
})
