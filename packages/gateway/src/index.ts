/**
 * @rebilder/gateway — content-negotiation middleware SDK; the front door of
 * the Rebilder compiler (ARCHITECTURE.md § The Compiler).
 *
 * Framework-agnostic core over web-standard Request/Response. Runtime
 * dependencies are exactly the workspace packages @rebilder/agent-detect,
 * @rebilder/render-md, and @rebilder/events (event types plus the intent
 * signal helpers the event builder calls at runtime) — zero external deps;
 * merchants install this in production stacks.
 *
 * Framework adapters ship as subpath exports ('@rebilder/gateway/next',
 * '/node', '/edge', '/shopify', '/fetch'); the root export stays
 * adapter-free. Full docs: https://rebilder.com/docs/quickstart.
 */

export type {
  GatewayConfig,
  GatewayDecision,
  GatewayNotFound,
  GatewayPath,
  GatewaySources,
  GatewayVerification,
  SourceKind,
  SourceResolver,
} from './core/types'
export { classifyRequest } from './core/classify'
export { handleRequest } from './core/handle'
// Agent access control (Phase 3). `compileAccessPolicy` is exported so a host
// can validate a policy where it is AUTHORED — a Console that shows "3 rules
// rejected, here is why" beats one that saves a policy and silently enforces
// two thirds of it.
export {
  accessDeniedResponse,
  compileAccessPolicy,
  createAccessLimiter,
  createAccessRuntime,
  evaluateAccess,
} from './core/access'
export type {
  AccessAction,
  AccessDecision,
  AccessLimit,
  AccessLimiter,
  AccessPolicy,
  AccessPolicySource,
  AccessRule,
  AccessSubject,
  CompiledAccessPolicy,
} from './core/access'
export { AGENT_VERIFIED_HEADER, AGENT_VERIFIED_REASON_HEADER } from './core/verification'
export {
  generateLlmsTxt,
  type LlmsTxtLink,
  type LlmsTxtOptions,
  type LlmsTxtSection,
} from './core/llms-txt'
// Discovery for agents that do not negotiate: the `<link rel="alternate">` for
// your page head, a markdown sitemap, and the markdown 404 body. The `.md` URLs
// and frontmatter are config options (`markdownUrls`, `frontmatter`).
export { markdownAlternate } from './core/negotiation'
export { generateSitemapMd, type SitemapMdOptions } from './core/sitemap-md'
export { markdownNotFoundResponse } from './core/not-found'

// Re-exported dependency types, so merchants can type their source resolvers
// and event sinks with only @rebilder/gateway installed. (agent-detect,
// render-md, and events are internal workspace packages; the gateway is the
// one public npm artifact.)
export type {
  AgentKeyRegistry,
  AgentKeyRegistryEntry,
  AgentPlatform,
  AgentPublicKey,
  DetectionResult,
  Ed25519PublicJwk,
  RequesterKind,
  VerificationFailureReason,
  VerificationResult,
} from '@rebilder/agent-detect'
// Re-exported so an operator can wire `verification.keys` (and verify
// standalone protocol mounts) with only @rebilder/gateway installed. The
// directory ships EMPTY — see @rebilder/agent-detect README § Verification.
export { KNOWN_AGENT_DIRECTORY, verifyWebBotAuth } from '@rebilder/agent-detect'
// The classifier's own Accept predicate, re-exported for the same reason as the
// types above: a consumer that reports on content negotiation must be able to
// ask the question exactly the way the gateway answered it, with only
// @rebilder/gateway installed.
export { acceptsMarkdownHeader } from '@rebilder/agent-detect'
export type {
  Availability,
  CatalogItemSource,
  Money,
  PolicySource,
  ProductSource,
  ProductVariantSource,
  ReturnsSource,
  ShippingSource,
} from '@rebilder/render-md'

// The universal source types, re-exported for the same reason as the commerce
// ones: a merchant wiring `document` and `collection` resolvers must be able
// to type them with only @rebilder/gateway installed. The whole `Fact` union
// and the hours types come along, because a `DocumentSource` cannot be
// written without them.
export type {
  ActionKind,
  ActionSource,
  BillingPeriod,
  CollectionItemSource,
  CollectionSource,
  ContactSource,
  DocumentAccess,
  DocumentKind,
  DocumentSectionSource,
  DocumentSource,
  Fact,
  FactValue,
  HoursException,
  HoursInterval,
  HoursRule,
  HoursSpec,
  LinkSource,
  Weekday,
} from '@rebilder/render-md'

export type { RebilderEventV0 } from '@rebilder/events'

// Local installation checks: no network, callback invocation or source-data exposure.
export { inspectGatewayConfig, inspectGatewayResponse } from './core/diagnostics'
export type { GatewayConfigReport, GatewayDiagnostic } from './core/diagnostics'

export { BASELINE_PROFILE, COMPATIBILITY_RUNTIME_VERSION, validateCompatibilityProfile, applyCompatibilityProfile } from '@rebilder/render-md'
export type { CompatibilityProfile, CompatibilityRendering } from '@rebilder/render-md'
export { createCompatibilityUpdater, canonicalCompatibilityManifest, validateCompatibilityManifest, verifyCompatibilityManifest } from './core/compatibility'
export type { CompatibilityManifest, SignedCompatibilityManifest, CompatibilityUpdateOptions, CompatibilityUpdateStatus } from './core/compatibility'
export { runCompatibilityEvaluation, promotableProfilesFromReport, COMPATIBILITY_EVALUATOR_VERSION } from './core/compatibility-evaluation'
export type { CompatibilityEvaluationCase, CompatibilityModelAnswer, CompatibilityModelAdapter, CompatibilityEvaluationResult, CompatibilityEvaluationReport } from './core/compatibility-evaluation'
