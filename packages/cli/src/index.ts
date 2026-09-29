/**
 * index.ts — the `"."` entry point of `rebilder`.
 *
 * The package is a BINARY first: almost everyone reaches it through
 * `npx rebilder check <url>` and never imports it. This surface exists for the
 * two callers who legitimately do — our own tests, and a consumer embedding the
 * same report in their own tool — and it is deliberately small: the parser, the
 * runner, the formatters, and the exit-code contract.
 *
 * WHAT IS NOT HERE: nothing that produces a score. `score()`, the ruleset, the
 * bands and the types live in `@rebilder/agent-readability` and are re-exported
 * from nowhere. A consumer who wants an ARS number should depend on the scorer,
 * not on a CLI that happens to contain one — otherwise the standard's surface
 * area is whatever a command-line tool's version number says it is.
 */

export { CLI_VERSION, runCli } from './cli'
export { EXIT, UsageError, worstExit, type ExitCode } from './exit'
export {
  parseCommandLine,
  normalizeDomain,
  COMMANDS,
  FORMATS,
  GRADES,
  type BadgeCommand,
  type CheckCommand,
  type Command,
  type CommandName,
  type DiffCommand,
  type Format,
  type Grade,
  type InitCommand,
  type ParseResult,
} from './args'
export { exitCodeFor, meetsThreshold, outcomeSummary, statusOf, type UrlReport } from './report'
export { render, type FormatContext } from './format'
export { helpText } from './help'
export {
  budgetFor,
  createNodeRuntime,
  nodeProbeFactory,
  type CliRuntime,
  type ProbeFactory,
  type ProbeRunner,
  type ProbeSetup,
} from './runtime'
export { detectCapabilities, type TermCapabilities } from './term'
export type { BadgeSnippet, DiffPayload, DiffSide, Payload, Scaffold } from './payload'
export {
  ARS_NOTICE,
  ARS_NOTICE_LINES,
  TELEMETRY_LINES,
} from './disclosure'
export { FRAMEWORKS, detectFramework, type Framework } from './commands/init'
export { BADGE_ORIGIN } from './commands/badge'
