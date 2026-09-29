/**
 * KNOWN_AGENT_DIRECTORY — the built-in Web Bot Auth key registry.
 *
 * THIS IS A DATA MODULE, AND IT SHIPS EMPTY — DELIBERATELY. We do not embed
 * "known" production public keys for OpenAI, Anthropic, Perplexity, etc.,
 * because we have not fetched and pinned them from the platforms' published
 * key directories, and inventing key material would make verification
 * silently meaningless (a fabricated key either verifies nothing or, worse,
 * verifies the wrong thing). Honesty over completeness.
 *
 * How this gets populated (operator responsibility, README § Verification):
 * agent platforms publish their signing keys at well-known HTTP message
 * signature directories (e.g. `https://<platform>/.well-known/
 * http-message-signatures-directory`). Operators fetch those OFFLINE — never
 * on the request hot path — pin the Ed25519 public keys here (or in their own
 * registry object; any `AgentKeyRegistry` works), and refresh on key
 * rotation. A refresh script that snapshots the published directories into
 * this module is future work (ROADMAP parking-lot material).
 *
 * Shape of a populated entry (this example is NOT a real key):
 *
 *   'https://chatgpt.com': {
 *     platform: 'chatgpt',
 *     keys: [
 *       {
 *         keyid: 'poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U', // JWK thumbprint the agent sends
 *         alg: 'ed25519',
 *         publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: '<base64url public key bytes>' },
 *       },
 *     ],
 *   },
 *
 * With the directory empty, verifyWebBotAuth() resolves every signed request
 * to `{ verified: false, reason: 'unknown-agent' }` — the honest answer when
 * no trusted key is on file.
 */

import type { AgentKeyRegistry } from './verify'

export const KNOWN_AGENT_DIRECTORY: AgentKeyRegistry = {
  // Intentionally empty — see the module header. Operators populate this (or
  // pass their own registry) from the platforms' published key directories.
}
