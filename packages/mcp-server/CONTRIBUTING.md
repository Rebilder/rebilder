# Contributing to @rebilder/mcp-server

This file and `server.json` are not in the npm tarball.

## Scripts

```sh
pnpm --filter @rebilder/mcp-server lint
pnpm --filter @rebilder/mcp-server typecheck
pnpm --filter @rebilder/mcp-server test
pnpm --filter @rebilder/mcp-server build
```

## Package layout

```
src/
  bin.ts            the executable; the only file that reads `process`
  server.ts         initialize / tools/list / tools/call / ping, transport-free
  stdio.ts          newline-delimited JSON-RPC framing
  jsonrpc.ts        the envelope, by hand
  result.ts         THE FUNNEL: every tool result is built here
  untrusted.ts      the quarantine: notice, content-derived nonce, sanitiser
  scanner.ts        probeStrict + the mandatory politeness limiter
  index-client.ts   the only file allowed to call fetch
  schema.ts         declared input/output schemas
  render.ts         the plain-text report
  tools/            the five tools
```

`@rebilder/protocols`, which is not yet published, is the merchant's own MCP
endpoint and is unrelated to this server.

## Protocol revisions

`src/version.ts` lists the revisions `initialize` accepts. Before adding one,
read its changelog on modelcontextprotocol.io and decide what the server must
send differently; `reportsArgumentErrorsAsResults` is the example for
2025-11-25. Revision 2026-07-28 removes `initialize` and needs `server/discover`,
per-request version metadata and new result fields, so it is a lifecycle
change, not a string to add.

## MCP Registry

`server.json` is the registry entry, named `com.rebilder/mcp-server`.
`tests/registry.test.ts` keeps its name, npm identifier, version and
repository equal to `package.json`. Maintainers publish it to the registry
after each npm release; the registry reads `mcpName` from the published npm
version, so the npm release must come first.

## Releasing

Record changes under `## Unreleased` in `CHANGELOG.md`. Bump `package.json`,
`src/version.ts` and `server.json` together; tests fail if they disagree.
Maintainers cut releases from tags.
