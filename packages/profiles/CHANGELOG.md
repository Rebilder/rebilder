# @rebilder/profiles changelog

Notable changes to `@rebilder/profiles`. Each profile document also carries its own `version`; this file covers the package. Dates are the day each version reached npm.

## Unreleased

## 0.2.1 (2026-10-06)

- The source code is public at https://github.com/rebilder/rebilder/tree/main/packages/profiles. `repository` and `bugs` point there, and issues and pull requests are welcome.

## 0.2.0 (2026-09-28)

- **Requires Node.js 22 or later** for the JavaScript entry point. `engines.node` moves from `>=20.11.0` to `>=22`; Node.js 20 reached end of life in April 2026. The JSON files are unaffected.
- README: install line, absolute links, proposals by email. Better package description and keywords. This changelog now ships in the package.
- No profile changes.

## 0.1.1 (2026-08-11)

- Package metadata points at rebilder.com for help instead of a private repository. No profile changes.

## 0.1.0 (2026-08-10)

First release: eight page-kind profiles (`product`, `collection`, `article`, `place`, `service`, `faq`, `document`, `unknown`), each at profile version 0.1.0, published as JSON and through `getProfile` and `ALL_PROFILES`.
