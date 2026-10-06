/**
 * tools/explain-check.ts — "what is this check, and what do I do about it?"
 *
 * FULLY LOCAL. No network, no scan, no state: the answer is assembled from
 * `CHECK_META`, `DIMENSION_META` and `DEFAULT_RULESET`, all of which are frozen
 * published data in `@rebilder/agent-readability`.
 *
 * THE REMEDY IS NOT WRITTEN HERE. It would be easy to hard-code twenty
 * paragraphs of advice in this file and easy to let them drift a MINOR behind
 * the spec they are describing. Instead the package's own recommendation
 * catalogue answers: we synthesise the result of a page that scores full marks
 * on everything EXCEPT this check and ask `recommend()` what it would tell that
 * site to do. The prose is therefore the same prose the scanner, the CLI and the
 * Console print, by construction rather than by copy-paste, and a change to the
 * catalogue shows up here on the next release with no edit to this file.
 */

import {
  ARS_HEURISTIC_WEIGHT,
  ARS_SPEC_VERSION,
  CHECK_META,
  DEFAULT_RULESET,
  DIMENSION_META,
  SUBPOINTS,
  recommend,
  rulesetHash,
  type ArsCheck,
  type ArsCheckId,
  type ArsDimension,
  type ArsDimensionId,
  type ArsRecommendation,
} from '@rebilder/agent-readability'
import { toJsonObject, type JsonObject } from '../json'
import { localFailure, type ToolReturn } from '../result'
import { EXPLAIN_CHECK_INPUT, EXPLAIN_CHECK_OUTPUT } from '../schema'
import { ARS_LABEL } from '../version'
import { defineTool, isInvalidParams, rejectUnknownKeys, requireString, type Tool } from './types'

const ALLOWED_KEYS = ['check_id'] as const
const CHECK_IDS = Object.keys(CHECK_META) as ArsCheckId[]
export const SPEC_URL = 'https://rebilder.com/spec/ars'

function isCheckId(value: string): value is ArsCheckId {
  return (CHECK_IDS as string[]).includes(value)
}

function weightOf(id: ArsCheckId): number {
  return DEFAULT_RULESET.weights[id] ?? 0
}

/** A page at full marks everywhere except `target`. Input to `recommend()`. */
function syntheticGapAt(target: ArsCheckId): { dimensions: ArsDimension[]; score: number } {
  const byDimension = new Map<ArsDimensionId, ArsCheck[]>()
  for (const id of CHECK_IDS) {
    const meta = CHECK_META[id]
    const weight = weightOf(id)
    const check: ArsCheck = {
      id,
      label: meta.label,
      basis: meta.basis,
      weight,
      earned: id === target ? 0 : weight,
      evidence: [],
    }
    const bucket = byDimension.get(meta.dimension)
    if (bucket === undefined) byDimension.set(meta.dimension, [check])
    else bucket.push(check)
  }

  const dimensions: ArsDimension[] = []
  for (const [id, checks] of byDimension) {
    const meta = DIMENSION_META[id]
    dimensions.push({
      id,
      label: meta.label,
      weight: meta.weight,
      earned: checks.reduce((sum, check) => sum + check.earned, 0),
      basis: checks.some((check) => check.basis === 'heuristic') ? 'heuristic' : 'measured',
      checks,
    })
  }
  return { dimensions, score: 100 - weightOf(target) }
}

/**
 * Partial credit a check pays that its weight and remedy do not show. ARS 0.3
 * pays part of D2.1 for a linked Markdown copy, so "0 or 9" is no longer the
 * whole story. The numbers come from `SUBPOINTS`, the scorer's own split.
 */
export function partialCreditNote(target: ArsCheckId): string | null {
  if (target !== 'machine-representation.negotiated-response') return null
  const { full, linkedCopy } = SUBPOINTS.negotiatedResponse
  return `A Markdown copy the page links to at another address earns ${linkedCopy} of the ${full} points when it loads. Sending the copy from the page address itself earns all ${full}.`
}

/** The catalogue entry that closes this check, if the catalogue has one. */
export function remedyFor(target: ArsCheckId): ArsRecommendation | null {
  const recommendations = recommend(syntheticGapAt(target))
  return recommendations.find((entry) => entry.checks.includes(target)) ?? null
}

export const explainCheckTool: Tool = defineTool<ArsCheckId>({
  name: 'explain_check',
  title: 'Explain an ARS check',
  description: [
    'Explain one check from the Rebilder Agent Readability Spec (ARS): what it measures, which dimension it belongs to, how many of the 100 points it carries, whether it is measured or heuristic, and what a site owner does to close it.',
    `Answered entirely from the frozen ${ARS_LABEL} ruleset shipped with this server, with no network call and no scan.`,
  ].join(' '),
  inputSchema: EXPLAIN_CHECK_INPUT,
  outputSchema: EXPLAIN_CHECK_OUTPUT,
  annotations: {
    title: 'Explain an ARS check',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  parse(args) {
    const unknown = rejectUnknownKeys(args, ALLOWED_KEYS)
    if (unknown !== null) return unknown
    const raw = requireString(args, 'check_id')
    if (isInvalidParams(raw)) return raw
    // A well-typed but unrecognised id is a tool-level answer ("no such check,
    // here are the ones there are"), not a protocol error: the model can fix it
    // from the message, which is exactly what an isError result is for.
    return raw as ArsCheckId
  },
  run(rawId): Promise<ToolReturn> {
    if (!isCheckId(rawId)) {
      return Promise.resolve(
        localFailure(
          `"${rawId}" is not an ${ARS_LABEL} check id. The twenty-two checks are:\n${CHECK_IDS.map((id) => `  ${id}`).join('\n')}`,
          { ok: false, error: 'unknown-check-id', requested: rawId, checkIds: [...CHECK_IDS] },
        ),
      )
    }

    const meta = CHECK_META[rawId]
    const dimension = DIMENSION_META[meta.dimension]
    const weight = weightOf(rawId)
    const remedy = remedyFor(rawId)
    const partial = partialCreditNote(rawId)

    const basisNote =
      meta.basis === 'measured'
        ? 'MEASURED: the points come from something observed in the response.'
        : `HEURISTIC: the points come from an inference. ${ARS_LABEL} puts ${ARS_HEURISTIC_WEIGHT} of its 100 points on heuristics and prints the split next to every score; a heuristic value must never be rendered without this label.`

    const summary = [
      `${rawId} — ${meta.label}`,
      `Dimension: ${dimension.label} (${meta.dimension}), worth ${dimension.weight} of 100 points.`,
      partial === null
        ? `This check is worth ${weight} of those ${dimension.weight}.`
        : `This check is worth ${weight} of those ${dimension.weight}. ${partial}`,
      basisNote,
      remedy === null
        ? 'The recommendation catalogue has no single action for this check; it is closed by the dimension as a whole.'
        : `How to close it — ${remedy.title} (effort: ${remedy.effort}):\n${remedy.detail}`,
      `Spec: ${SPEC_URL} · ruleset ${rulesetHash(DEFAULT_RULESET).slice(0, 12)} · ars ${ARS_SPEC_VERSION}`,
    ].join('\n\n')

    const structured: JsonObject = {
      id: rawId,
      label: meta.label,
      basis: meta.basis,
      weight,
      dimension: meta.dimension,
      dimensionLabel: dimension.label,
      dimensionWeight: dimension.weight,
      specVersion: ARS_SPEC_VERSION,
      rulesetHash: rulesetHash(DEFAULT_RULESET),
      remedy: remedy === null ? null : toJsonObject(remedy),
      specUrl: SPEC_URL,
    }

    return Promise.resolve({ origin: 'local', summary, structured })
  },
})
