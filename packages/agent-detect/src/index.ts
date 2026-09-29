export type { RequesterKind, AgentPlatform, DetectInput, DetectionResult } from './types'
export { detect } from './detect'

// The Accept predicate the classifier itself uses. Exported so a consumer
// reporting on negotiation (the Console's Accept panel) decides "asked for
// markdown" with the same code that decided how to serve the request, rather
// than a lookalike that is free to drift.
export { acceptsMarkdownHeader } from './detect'

// Web Bot Auth verification (Phase 3): a separate async step — detect() stays
// synchronous, parse-only, and always reports verified: false.
export {
  CLOCK_SKEW_SECONDS,
  verifyWebBotAuth,
  type AgentKeyRegistry,
  type AgentKeyRegistryEntry,
  type AgentPublicKey,
  type Ed25519PublicJwk,
  type VerificationFailureReason,
  type VerificationResult,
  type VerifyWebBotAuthOptions,
} from './verify'
export { KNOWN_AGENT_DIRECTORY } from './directory'
