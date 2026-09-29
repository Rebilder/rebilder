/**
 * Shared measurement context for CLI reports. The current formatters include
 * these lines; other interfaces can explain the scope through concise labels
 * and linked methodology (ARS 0.2 §0). Wording can evolve with the product.
 */
export const ARS_NOTICE_LINES: readonly string[] = [
  'ARS measures format and retrievability. It does not measure whether the',
  'facts are true, or whether any assistant cites this page.',
]

export const ARS_NOTICE = ARS_NOTICE_LINES.join(' ')

/**
 * The no-telemetry contract, printed in `--help` next to the disclosure.
 *
 * It is here rather than only in the README because the person who needs to read
 * it is the one deciding whether to run `--allow-private` against an internal
 * hostname inside their own CI, and they are looking at a terminal.
 */
export const TELEMETRY_LINES: readonly string[] = [
  'This CLI ships zero telemetry. It never uploads a scan, a URL, a hostname,',
  'or a result. The only requests it makes are to the target you name.',
]
