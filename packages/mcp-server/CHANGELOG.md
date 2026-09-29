# @rebilder/mcp-server changelog

Notable changes to `@rebilder/mcp-server`. Dates are the day each version reached npm.

## Unreleased

- The source code is public at https://github.com/rebilder/rebilder/tree/main/packages/mcp-server. `repository` and `bugs` point there, and issues and pull requests are welcome.

## 0.3.0 (2026-09-28)

- **Requires Node.js 22 or later.** `engines.node` moves from `>=20.11.0` to `>=22`; Node.js 20 reached end of life in April 2026.
- Speaks MCP revision `2025-11-25` by default, and still accepts `2025-06-18` and `2025-03-26`. Under `2025-11-25`, a tool argument that fails validation comes back as an `isError` result the model can read and correct, instead of a JSON-RPC error. A `server/discover` probe from a `2026-07-28` client gets method-not-found, so the client falls back to `initialize` at once.
- `mcpName` (`com.rebilder/mcp-server`) in `package.json`, for listing in the official MCP Registry.
- README: install one-liners for Claude Code, VS Code and Cursor, and no internal references. Better package description and keywords.
- The library entry ships as ESM only. The CommonJS files were unreachable through `exports`. Unpacked size drops from about 810 KB to 540 KB. This changelog now ships in the package.
- The server instructions and the `scan_url` and `explain_check` descriptions name the standard in full, the Rebilder Agent Readability Spec (ARS), so an assistant does not confuse it with other checklists of a similar name.

## 0.2.1 (2026-09-08)

- `scan_url` results open with **Business review and next steps**, written for a business owner, before the technical detail.

## 0.2.0 (2026-08-26)

- Scores against ARS 0.2 through `@rebilder/agent-readability` 0.2.0. Scores are not comparable with ARS 0.1.

## 0.1.1 (2026-08-11)

- Package metadata points at rebilder.com for help instead of a private repository.

## 0.1.0 (2026-08-10)

First release: a local stdio MCP server with `scan_url`, `compare_agent_view`, `explain_check`, `get_index_entry` and `install_snippet`. Scans run on your machine and are never uploaded; scanned page text is returned inside an untrusted-content quarantine.
