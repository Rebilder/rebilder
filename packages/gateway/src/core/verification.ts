/**
 * Web Bot Auth verification glue for the protocol path.
 *
 * The gateway runs @rebilder/agent-detect's verifyWebBotAuth() — PURE CRYPTO
 * over the operator-injected key registry, no network, no key-directory
 * fetches (project convention: no network calls on the hot path) — and communicates
 * the verdict to the protocol handler via request headers. The protocols
 * hook signature stays `(req) => Promise<Response | null>`, so the verdict
 * rides on a cloned request:
 *
 *   x-rebilder-agent-verified:        'true' | 'false'
 *   x-rebilder-agent-verified-reason: VerificationFailureReason (unverified only)
 *
 * The gateway ALWAYS OVERWRITES these headers when verification is
 * configured — a client-sent value can never survive into the handler.
 * When verification is NOT configured the request passes through untouched
 * (no clone, no stripping): a protocol handler that gates on this header
 * must only be exposed behind a gateway with `verification` configured, or
 * behind an edge that strips the header (README § Verification).
 */

import {
  verifyWebBotAuth,
  type DetectionResult,
  type VerificationResult,
} from '@rebilder/agent-detect'
import { headersToRecord } from './classify'
import type { GatewayVerification } from './types'

/** Verdict header the gateway stamps for the protocols hook. */
export const AGENT_VERIFIED_HEADER = 'x-rebilder-agent-verified'
/** Failure-reason header, present exactly when the verdict is 'false'. */
export const AGENT_VERIFIED_REASON_HEADER = 'x-rebilder-agent-verified-reason'

/**
 * Run verification for a protocol-path request. Contained: any unexpected
 * throw resolves to an unverified result (verifyWebBotAuth itself never
 * throws; this is belt and braces so verification can never break serving).
 */
export async function verifyProtocolRequest(
  req: Request,
  verification: GatewayVerification,
): Promise<VerificationResult> {
  try {
    return await verifyWebBotAuth(
      { headers: headersToRecord(req.headers), url: req.url, method: req.method },
      { keys: verification.keys },
    )
  } catch {
    return { verified: false, reason: 'malformed' }
  }
}

/**
 * Clone the request with the verdict headers stamped (overwriting any
 * client-sent value — spoof containment). Method, URL, and body are
 * preserved by the standard Request-from-Request construction.
 */
export function stampVerification(req: Request, result: VerificationResult): Request {
  const headers = new Headers(req.headers)
  headers.set(AGENT_VERIFIED_HEADER, result.verified ? 'true' : 'false')
  if (result.verified) {
    headers.delete(AGENT_VERIFIED_REASON_HEADER)
  } else {
    headers.set(AGENT_VERIFIED_REASON_HEADER, result.reason ?? 'malformed')
  }
  return new Request(req, { headers })
}

/**
 * Clone the request with BOTH verdict headers removed. Used on the protocol
 * path when verification is NOT configured: without this, a client could send
 * `x-rebilder-agent-verified: true` itself and a merchant protocol handler
 * that trusts the header — but forgot to wire `config.verification` — would
 * read the spoofed verdict. The verdict header is ours to set or to strip; it
 * is never something a client may assert. When verification IS configured,
 * `stampVerification` overwrites it instead, so either way the client value
 * cannot survive to the handler.
 */
export function stripVerificationHeaders(req: Request): Request {
  if (
    !req.headers.has(AGENT_VERIFIED_HEADER) &&
    !req.headers.has(AGENT_VERIFIED_REASON_HEADER)
  ) {
    return req
  }
  const headers = new Headers(req.headers)
  headers.delete(AGENT_VERIFIED_HEADER)
  headers.delete(AGENT_VERIFIED_REASON_HEADER)
  return new Request(req, { headers })
}

/**
 * Fold the verification verdict into the detection result the event is built
 * from: `verified` reflects the cryptographic outcome, and a verified
 * platform identity fills in `platform` when detection had nothing better
 * than null/'unknown' (the signature is stronger evidence than a UA string).
 */
export function applyVerification(
  detection: DetectionResult,
  result: VerificationResult,
): DetectionResult {
  const platform =
    result.verified &&
    result.platform !== undefined &&
    (detection.platform === null || detection.platform === 'unknown')
      ? result.platform
      : detection.platform
  return { ...detection, verified: result.verified, platform }
}
