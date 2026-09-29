import { applyCompatibilityProfile, type CompatibilityProfile } from '@rebilder/render-md'

export interface CompatibilityEvaluationCase {
  id: string
  split: 'development' | 'holdout'
  canonicalUrl: string
  markdown: string
  /** Trusted fixture answers; never sent to the tested model. */
  questions: { id: string; question: string; facts: string[]; qualifications: string[] }[]
}
export interface CompatibilityModelAnswer {
  facts: string[]
  qualifications: string[]
}
export const COMPATIBILITY_EVALUATOR_VERSION = 'exact-quoted-facts-v1' as const

export interface CompatibilityModelAdapter {
  provider: string
  id: string
  answer(input: {
    markdown: string
    questions: { id: string; question: string }[]
    signal: AbortSignal
  }): Promise<{
    answers: Record<string, CompatibilityModelAnswer | null>
    inputTokens?: number
    outputTokens?: number
  }>
}
export interface CompatibilityEvaluationResult {
  caseId: string
  split: 'development' | 'holdout'
  profileId: CompatibilityProfile['id']
  actualProfileId: CompatibilityProfile['id']
  model: string | null
  repetition: number
  fidelityPassed: boolean
  correctAnswers: number
  totalAnswers: number
  qualificationsPassed: number
  totalQualifications: number
  latencyMs: number
  inputTokens: number | null
  outputTokens: number | null
  answers?: Record<string, CompatibilityModelAnswer | null>
  error?: string
}
export interface CompatibilityEvaluationReport {
  schema: 1
  id: string
  datasetVersion: string
  evaluatorVersion: typeof COMPATIBILITY_EVALUATOR_VERSION
  cases: CompatibilityEvaluationCase[]
  kind: 'deterministic-fidelity' | 'model-comprehension'
  createdAt: string
  models: { provider: string; id: string }[]
  repetitions: number
  results: CompatibilityEvaluationResult[]
  summary: {
    profileId: CompatibilityProfile['id']
    split: 'development' | 'holdout'
    runs: number
    correctAnswers: number
    totalAnswers: number
    qualificationsPassed: number
    totalQualifications: number
    fidelityPassed: number
    errors: number
  }[]
  promotionEligible: boolean
  promotableProfiles: CompatibilityProfile[]
}
const profiles: CompatibilityProfile[] = [
  { id: 'baseline', version: 1 },
  { id: 'source-envelope', version: 1 },
  { id: 'section-index', version: 1 },
]
const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
const contains = (answer: string, atom: string): boolean =>
  ` ${normalize(answer)} `.includes(` ${normalize(atom)} `)

/** Bounded, sequential comparisons. Offline fidelity is never evidence of model improvement. */
export async function runCompatibilityEvaluation(options: {
  cases: CompatibilityEvaluationCase[]
  datasetVersion: string
  models?: CompatibilityModelAdapter[]
  repetitions?: number
  maxCalls?: number
  timeoutMs?: number
  id?: string
}): Promise<CompatibilityEvaluationReport> {
  const models = options.models ?? []
  const repetitions = options.repetitions ?? 2
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5)
    throw new Error('Repetitions must be 1..5')
  if (
    options.cases.length < 1 ||
    options.cases.length > 100 ||
    new Set(options.cases.map((c) => c.id)).size !== options.cases.length
  )
    throw new Error('Use 1..100 uniquely identified cases')
  if (
    models.length > 5 ||
    new Set(models.map((m) => `${m.provider}/${m.id}`)).size !== models.length
  )
    throw new Error('Use at most five distinct models')
  const expectedCalls = options.cases.length * profiles.length * repetitions * models.length
  if (
    models.length > 0 &&
    (!Number.isSafeInteger(options.maxCalls) || expectedCalls > (options.maxCalls ?? 0))
  )
    throw new Error(
      `Evaluation requires ${expectedCalls} model calls; set an explicit sufficient maxCalls budget`,
    )
  const results: CompatibilityEvaluationResult[] = []
  for (const testCase of options.cases) {
    for (let repetition = 0; repetition < repetitions; repetition++) {
      // Rotate order so a model's transient rate/latency behavior is not always
      // assigned to the same candidate. Facts and questions remain identical.
      const ordered = [...profiles.slice(repetition % 3), ...profiles.slice(0, repetition % 3)]
      for (const profile of ordered) {
        const rendered = applyCompatibilityProfile(testCase.markdown, profile, {
          canonicalUrl: testCase.canonicalUrl,
          maxBytes: 16384,
        })
        const fidelityPassed =
          rendered.markdown.includes(testCase.markdown) &&
          testCase.questions.every((q) =>
            [...q.facts, ...q.qualifications].every((atom) => contains(rendered.markdown, atom)),
          )
        for (const model of models.length > 0 ? models : [null]) {
          const result: CompatibilityEvaluationResult = {
            caseId: testCase.id,
            split: testCase.split,
            profileId: profile.id,
            actualProfileId: rendered.profile.id,
            model: model === null ? null : `${model.provider}/${model.id}`,
            repetition,
            fidelityPassed,
            correctAnswers: 0,
            totalAnswers: model ? testCase.questions.length : 0,
            qualificationsPassed: 0,
            totalQualifications: model
              ? testCase.questions.reduce((sum, q) => sum + q.qualifications.length, 0)
              : 0,
            latencyMs: 0,
            inputTokens: null,
            outputTokens: null,
          }
          if (model !== null) {
            const controller = new AbortController()
            let timer: ReturnType<typeof setTimeout> | undefined
            const started = performance.now()
            try {
              const response = await Promise.race([
                model.answer({
                  markdown: rendered.markdown,
                  questions: testCase.questions.map(({ id, question }) => ({ id, question })),
                  signal: controller.signal,
                }),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => {
                      controller.abort()
                      reject(new Error('timeout'))
                    },
                    Math.max(100, Math.min(120000, options.timeoutMs ?? 30000)),
                  )
                }),
              ])
              if (
                typeof response.answers !== 'object' ||
                response.answers === null ||
                Array.isArray(response.answers)
              )
                throw new Error('invalid-answer')
              result.answers = {}
              for (const question of testCase.questions) {
                const answer = response.answers[question.id]
                if (answer !== null && !validModelAnswer(answer)) throw new Error('invalid-answer')
                result.answers[question.id] = answer
                const score = scoreExactAnswer(answer, question)
                result.qualificationsPassed += score.qualificationsPassed
                if (score.correct) result.correctAnswers++
              }
              result.inputTokens =
                Number.isSafeInteger(response.inputTokens) && (response.inputTokens ?? -1) >= 0
                  ? response.inputTokens!
                  : null
              result.outputTokens =
                Number.isSafeInteger(response.outputTokens) && (response.outputTokens ?? -1) >= 0
                  ? response.outputTokens!
                  : null
            } catch {
              result.error = 'model-call-or-answer-failed'
            } finally {
              if (timer) clearTimeout(timer)
              result.latencyMs = Math.round(performance.now() - started)
            }
          }
          results.push(result)
        }
      }
    }
  }
  const summary = profiles.flatMap((profile) =>
    (['development', 'holdout'] as const).map((split) => {
      const rows = results.filter((r) => r.profileId === profile.id && r.split === split)
      return {
        profileId: profile.id,
        split,
        runs: rows.length,
        correctAnswers: sum(rows, 'correctAnswers'),
        totalAnswers: sum(rows, 'totalAnswers'),
        qualificationsPassed: sum(rows, 'qualificationsPassed'),
        totalQualifications: sum(rows, 'totalQualifications'),
        fidelityPassed: rows.filter((r) => r.fidelityPassed).length,
        errors: rows.filter((r) => r.error).length,
      }
    }),
  )
  const report: CompatibilityEvaluationReport = {
    schema: 1,
    id: options.id ?? crypto.randomUUID(),
    datasetVersion: options.datasetVersion,
    evaluatorVersion: COMPATIBILITY_EVALUATOR_VERSION,
    cases: options.cases,
    kind: models.length ? 'model-comprehension' : 'deterministic-fidelity',
    createdAt: new Date().toISOString(),
    models: models.map(({ provider, id }) => ({ provider, id })),
    repetitions,
    results,
    summary,
    promotionEligible: false,
    promotableProfiles: [],
  }
  report.promotableProfiles = promotableProfilesFromReport(report)
  report.promotionEligible = report.promotableProfiles.length > 0
  return report
}
function sum(
  rows: CompatibilityEvaluationResult[],
  field: 'correctAnswers' | 'totalAnswers' | 'qualificationsPassed' | 'totalQualifications',
): number {
  return rows.reduce((total, row) => total + row[field], 0)
}

/**
 * Recompute the conservative pilot gate from raw matched observations. The
 * caller must authenticate the report's trusted producer: structural validation
 * cannot establish that a claimed model call actually happened. Ignore supplied
 * summary, promotionEligible and promotableProfiles values entirely.
 */
export function promotableProfilesFromReport(value: unknown): CompatibilityProfile[] {
  if (
    !record(value) ||
    value.schema !== 1 ||
    value.kind !== 'model-comprehension' ||
    value.evaluatorVersion !== COMPATIBILITY_EVALUATOR_VERSION
  )
    return []
  if (
    !text(value.id, 128) ||
    !text(value.datasetVersion, 256) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    return []
  if (
    !integer(value.repetitions, 2, 5) ||
    !Array.isArray(value.models) ||
    value.models.length < 1 ||
    value.models.length > 5
  )
    return []
  if (!Array.isArray(value.cases) || value.cases.length < 30 || value.cases.length > 100) return []
  const truths = new Map<string, CompatibilityEvaluationCase>()
  for (const candidate of value.cases) {
    if (
      !record(candidate) ||
      !text(candidate.id, 128) ||
      !['development', 'holdout'].includes(String(candidate.split)) ||
      !text(candidate.canonicalUrl, 2048) ||
      !text(candidate.markdown, 65536) ||
      !Array.isArray(candidate.questions) ||
      candidate.questions.length < 1 ||
      candidate.questions.length > 20 ||
      truths.has(candidate.id)
    )
      return []
    const ids = new Set<string>()
    for (const question of candidate.questions) {
      if (
        !record(question) ||
        !text(question.id, 128) ||
        !text(question.question, 4096) ||
        !stringList(question.facts) ||
        !stringList(question.qualifications) ||
        ids.has(question.id)
      )
        return []
      ids.add(question.id)
    }
    truths.set(candidate.id, candidate as unknown as CompatibilityEvaluationCase)
  }
  const repetitions = value.repetitions
  const models: string[] = []
  for (const model of value.models) {
    if (!record(model) || !text(model.provider, 64) || !text(model.id, 128)) return []
    models.push(`${model.provider}/${model.id}`)
  }
  if (
    new Set(models).size !== models.length ||
    !Array.isArray(value.results) ||
    value.results.length > 7500
  )
    return []
  const rows: CompatibilityEvaluationResult[] = []
  const cases = new Map<
    string,
    { split: 'development' | 'holdout'; totalAnswers: number; totalQualifications: number }
  >()
  const matched = new Map<string, CompatibilityEvaluationResult>()
  for (const raw of value.results) {
    if (
      !record(raw) ||
      !text(raw.caseId, 128) ||
      !['development', 'holdout'].includes(String(raw.split)) ||
      !profiles.some((p) => p.id === raw.profileId) ||
      !profiles.some((p) => p.id === raw.actualProfileId)
    )
      return []
    if (
      typeof raw.model !== 'string' ||
      !models.includes(raw.model) ||
      !integer(raw.repetition, 0, repetitions - 1) ||
      typeof raw.fidelityPassed !== 'boolean'
    )
      return []
    if (
      !integer(raw.totalAnswers, 1, 20) ||
      !integer(raw.correctAnswers, 0, raw.totalAnswers) ||
      !integer(raw.totalQualifications, 0, 100) ||
      !integer(raw.qualificationsPassed, 0, raw.totalQualifications)
    )
      return []
    if (
      typeof raw.latencyMs !== 'number' ||
      !Number.isFinite(raw.latencyMs) ||
      raw.latencyMs < 0 ||
      (raw.error !== undefined && !text(raw.error, 256))
    )
      return []
    for (const field of ['inputTokens', 'outputTokens'])
      if (raw[field] !== null && !integer(raw[field], 0, 10000000)) return []
    const truth = truths.get(raw.caseId)
    if (
      !truth ||
      truth.split !== raw.split ||
      raw.totalAnswers !== truth.questions.length ||
      raw.totalQualifications !==
        truth.questions.reduce((sum, q) => sum + q.qualifications.length, 0)
    )
      return []
    if (raw.error === undefined) {
      if (!record(raw.answers) || Object.keys(raw.answers).length !== truth.questions.length)
        return []
      let correctAnswers = 0,
        qualificationsPassed = 0
      for (const question of truth.questions) {
        const answer = raw.answers[question.id]
        if (answer !== null && !validModelAnswer(answer)) return []
        const score = scoreExactAnswer(answer, question)
        if (score.correct) correctAnswers++
        qualificationsPassed += score.qualificationsPassed
      }
      if (
        raw.correctAnswers !== correctAnswers ||
        raw.qualificationsPassed !== qualificationsPassed
      )
        return []
    }
    const row = raw as unknown as CompatibilityEvaluationResult
    const prior = cases.get(row.caseId)
    if (
      prior &&
      (prior.split !== row.split ||
        prior.totalAnswers !== row.totalAnswers ||
        prior.totalQualifications !== row.totalQualifications)
    )
      return []
    cases.set(row.caseId, {
      split: row.split,
      totalAnswers: row.totalAnswers,
      totalQualifications: row.totalQualifications,
    })
    const key = rowKey(row, row.profileId)
    if (matched.has(key)) return []
    matched.set(key, row)
    rows.push(row)
  }
  if (
    cases.size !== truths.size ||
    cases.size < 30 ||
    cases.size > 100 ||
    [...cases.values()].filter((c) => c.split === 'holdout').length < 10 ||
    [...cases.values()].filter((c) => c.split === 'development').length < 10
  )
    return []
  if (rows.length !== cases.size * profiles.length * models.length * repetitions) return []
  if (![...cases.values()].some((c) => c.totalQualifications > 0)) return []
  return profiles.filter((profile) => {
    if (profile.id === 'baseline') return false
    const candidates = rows.filter((row) => row.profileId === profile.id)
    if (candidates.some((r) => r.error || !r.fidelityPassed || r.actualProfileId !== profile.id))
      return false
    for (const model of models) {
      for (let repetition = 0; repetition < repetitions; repetition++) {
        let holdoutLift = false
        for (const candidate of candidates.filter(
          (r) => r.model === model && r.repetition === repetition,
        )) {
          const baseline = matched.get(rowKey(candidate, 'baseline'))
          if (
            !baseline ||
            baseline.error ||
            !baseline.fidelityPassed ||
            baseline.actualProfileId !== 'baseline' ||
            candidate.correctAnswers < baseline.correctAnswers ||
            candidate.qualificationsPassed < baseline.qualificationsPassed
          )
            return false
          if (candidate.split === 'holdout' && candidate.correctAnswers > baseline.correctAnswers)
            holdoutLift = true
        }
        if (!holdoutLift) return false
      }
    }
    return true
  })
}
function rowKey(row: CompatibilityEvaluationResult, profileId: string): string {
  return JSON.stringify([row.caseId, row.model, row.repetition, profileId])
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 20 && value.every((item) => text(item, 12000))
}
function validModelAnswer(value: unknown): value is CompatibilityModelAnswer {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    stringList(value.facts) &&
    stringList(value.qualifications)
  )
}
// Preserve case, punctuation, operators and negation. Only whitespace folding
// permits quoted text to wrap differently; no substring/semantic guess is used.
const quote = (value: string): string => value.trim().replace(/\s+/g, ' ')
function sameQuotes(actual: string[], expected: string[]): boolean {
  return JSON.stringify(actual.map(quote).sort()) === JSON.stringify(expected.map(quote).sort())
}
function scoreExactAnswer(
  answer: CompatibilityModelAnswer | null,
  expected: { facts: string[]; qualifications: string[] },
): { correct: boolean; qualificationsPassed: number } {
  if (answer === null) return { correct: false, qualificationsPassed: 0 }
  const correct =
    sameQuotes(answer.facts, expected.facts) &&
    sameQuotes(answer.qualifications, expected.qualifications)
  const qualificationsPassed = expected.qualifications.filter((item) =>
    answer.qualifications.some((actual) => quote(actual) === quote(item)),
  ).length
  return { correct, qualificationsPassed }
}
