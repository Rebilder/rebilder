/**
 * JSON reports preserve the ArsResult contract and include measurement context
 * in the notice field. Response bodies remain in the separate evidence bundle.
 * Consumers can present contextual help without repeating this exact sentence.
 */

import { ARS_NOTICE } from '../disclosure'
import type { Payload } from '../payload'
import { exitCodeFor, outcomeSummary, statusOf } from '../report'
import type { FormatContext } from './shared'

export function renderJson(payload: Payload, ctx: FormatContext): string {
  return JSON.stringify(jsonValue(payload, ctx), null, 2) + '\n'
}

function jsonValue(payload: Payload, ctx: FormatContext): unknown {
  const envelope = {
    tool: 'rebilder',
    toolVersion: ctx.cliVersion,
    generatedAt: ctx.generatedAt,
    notice: ARS_NOTICE,
  }

  switch (payload.command) {
    case 'check':
      return {
        ...envelope,
        command: 'check',
        failOn: payload.failOn,
        results: payload.reports.map((report) => ({
          url: report.url,
          status: statusOf(report),
          summary: outcomeSummary(report),
          exitCode: exitCodeFor(report, payload.failOn),
          ...(report.kind === 'rejected'
            ? { rejection: report.rejection, detail: report.detail, result: null }
            : { rejection: null, detail: null, result: report.result }),
        })),
      }
    case 'diff':
      return {
        ...envelope,
        command: 'diff',
        url: payload.diff.url,
        status: statusOf(payload.diff.report),
        agent: payload.diff.agent,
        browser: payload.diff.browser,
        substanceParity: payload.diff.parity,
        result: payload.diff.result,
      }
    case 'init':
      return { ...envelope, command: 'init', scaffold: payload.scaffold }
    case 'badge':
      return { ...envelope, command: 'badge', badge: payload.badge }
  }
}
