/**
 * format/index.ts — the one place `--format` is turned into a string.
 *
 * `--out` writes exactly what stdout would have shown, in the same format. There
 * is no separate "file format": a report you can read on screen and a report you
 * archive should not be two artifacts that can disagree, and the first time they
 * do, the one in the artifact store is the one nobody can reproduce.
 */

import { UsageError } from '../exit'
import type { Format } from '../args'
import type { Payload } from '../payload'
import type { TermCapabilities } from '../term'
import { renderJson } from './json'
import { renderJunit } from './junit'
import { renderMarkdown } from './markdown'
import { renderPretty } from './pretty'
import type { FormatContext } from './shared'

export type { FormatContext } from './shared'

export function render(
  payload: Payload,
  format: Format,
  caps: TermCapabilities,
  ctx: FormatContext,
): string {
  if (format === 'junit' && (payload.command === 'init' || payload.command === 'badge')) {
    // Refused rather than emitted empty: `rebilder init --format junit` is
    // someone's mistake, and returning a valid file with nothing in it lets a
    // pipeline go green on a command that measured nothing.
    throw new UsageError(
      `--format junit reports observations about a page; \`${payload.command}\` makes none. Use pretty, json or markdown.`,
    )
  }

  switch (format) {
    case 'pretty':
      return renderPretty(payload, caps, ctx)
    case 'json':
      return renderJson(payload, ctx)
    case 'markdown':
      return renderMarkdown(payload, ctx)
    case 'junit':
      return renderJunit(payload, ctx)
  }
}
