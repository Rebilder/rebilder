# `rebilder`

Help AI assistants understand the business information on your website.

`rebilder check <url>` fetches a page the way an agent would, fetches it again
the way a browser would, and scores the result against
[the Rebilder Agent Readability Spec (ARS 0.2)](https://rebilder.com/spec/ars). It tells
you what a machine caller actually receives from your site, what that costs in
bytes, and which of the 22 checks you are losing points on.

> ARS measures format and retrievability. It does not measure whether the
> facts are true, or whether any assistant cites this page.

```
npx rebilder check https://example.com/products/thing
```

**Zero telemetry.** This CLI never uploads a scan, a URL, a hostname, or a
result. See [the contract below](#zero-telemetry).

---

## From a website question to a verified improvement

1. Choose an important product, service or location page and run `npx rebilder check <url>`.
2. Read **Your next steps** before the technical detail. Missing core facts are heuristic observations from this capture, so check your page and business records before changing them.
3. Share the report with `npx rebilder check <url> --format markdown --out review.md`. The report includes recommended work and the evidence behind the score.
4. If you need a website connection, run `npx rebilder init` in your project. It prepares a configuration scaffold; your developer still needs to connect real data, review the integration and deploy it.
5. After the website changes, rerun the check and use `npx rebilder diff <url>` to compare customer and assistant responses.

The report helps you improve the captured page. Connect current business records when adding prices, service areas and policies, then verify the updated response.

JSON and JUnit remain suitable for automation; the owner-oriented next steps appear in terminal and Markdown reports.

## Commands

```
rebilder check <url...>   --format pretty|json|markdown|junit  --fail-on <grade>
                          --out <file>  --allow-private --allow-http  --concurrency <n>
rebilder diff <url>       # agent view vs browser view
rebilder init             # gateway config scaffold for the detected framework
rebilder badge <domain>   # embed snippet
```

---

## Exit codes

**A stable contract. Documented here, and never renumbered.**

| Code | Meaning                                                                     |
| ---: | --------------------------------------------------------------------------- |
|    0 | Completed; threshold met, or no threshold set                               |
|    1 | Completed; threshold **not** met                                            |
|    2 | Usage error                                                                 |
|    3 | Probe failed / target unreachable: **infrastructure, not a score failure** |
|    4 | Blocked by policy (SSRF guard, robots opt-out, probe budget spent)          |

**The 1-vs-3 split is load-bearing.** `1` is a fact about your site. `3` is DNS,
a timeout, a 502, or a captive portal in your CI runner. If a flaky network
exited `1`, the first red build nobody could explain would get the check deleted,
and a deleted check protects nothing. So an outcome that never produced a
score can never produce `1`, and there is a test that sweeps every unscored
reason and every probe rejection to prove it.

`4` is the other thing that is not a score failure: we chose not to fetch, or
were told not to. It is separate from `3` because `4` is deterministic and `3` is
not: re-running fixes a `3` and never fixes a `4`.

**`--fail-on` defaults to nothing.** Plain `rebilder check <url>` reports and
exits `0`. A tool that fails a build by default is a tool that gets `|| true`
appended on day one.

`--fail-on C` means **C or better passes**; a worse grade exits `1`.

When one invocation covers several URLs, the codes collapse **2 > 4 > 3 > 1 > 0**:
a mistake in the command beats everything, a deterministic refusal beats a
transient failure, and anything that stopped us getting a score beats a score we
got and disliked.

### In CI

```yaml
- run: npx rebilder check https://example.com/products/thing --fail-on B --format junit --out ars.xml
```

`3` and `4` will still fail the step. If you want infrastructure trouble to be
non-blocking while a grade regression is not, branch on the code:

```bash
npx rebilder check "$URL" --fail-on B; code=$?
case $code in
  0) ;;                                    # fine
  1) echo "ARS grade regressed"; exit 1 ;;  # your site
  3|4) echo "probe did not complete ($code) — not failing the build" ;;
  *) exit $code ;;
esac
```

---

## `rebilder check`

Per URL it makes **two requests**, an agent probe and a browser control that
differ in the `Accept` header **and in nothing else**, plus `/robots.txt`,
`/llms.txt` and `/.well-known/ucp` per origin. Nothing else is requested; there
is no guessing at `/sitemap.xml` or `/mcp`. `robots.txt` is fetched first and
obeyed.

Same User-Agent on both probes, because that is what makes the parity check
meaningful and what stops a correctly installed gateway (which negotiates on
`Accept`, not on User-Agent) from being scored as a cloaker.

### Before: the page as raw HTML

<!-- rebilder-example: check-raw-html | 002-pdp-raw-html | rebilder check <url> -->

```console
https://basecamp-supply.example/products/alpine-trail-pack-28l
────────────────────────────────────────────────────────────────
D  Partial  59/100
63 of the 100 points are measured, 37 heuristic
page kind: product (high confidence, heuristic)

Your next steps
  • The expected core business details were detected (heuristic). Review their accuracy against your current products, services and policies.
  • Start with: Serve a machine representation on Accept negotiation. Return Markdown, plain text or JSON with a matching Content-Type when the request asks for one, and keep the same URL. This is the single largest recoverable block in ARS, and it is also what makes Vary: Accept and the substance-parity check scoreable at all.
  • To connect your existing information, run rebilder init in your project. Review the generated configuration and connect your real data before deployment.
  • After updating your site, run rebilder check <url> again. Export --format markdown --out review.md to share the findings with your team.
  • This scan measures page readability; it does not measure customer demand, AI recommendations or sales.

Retrievability                                                 28/28 heuristic
  ✔ Reachable on the agent path                                11/11 measured
  ✔ Robots policy for assistants                               10/10 measured
  ✔ Core facts present without JavaScript                        7/7 heuristic
Machine representation                                          0/18 heuristic
  ✘ Machine representation on Accept negotiation                 0/9 measured
  ✘ Declared alternate representations                           0/3 measured
  ✘ Vary: Accept declared correctly                              0/3 measured
  ✘ Same substance across representations                        0/3 heuristic
Fact coverage                                                   5/20 heuristic
  ◐ Core facts for this page kind                               4/14 heuristic
  ◐ Context cost relative to this page kind                      1/6 measured
Fact position                                                   9/10 heuristic
  ◐ Byte offset of the first core fact                           4/5 heuristic
  ✔ Core facts inside the front window                           5/5 heuristic
Structured data                                                  6/6 heuristic
  ✔ Structured data present and parsing                          2/2 measured
  ✔ Recognised type with its required properties                 3/3 measured
  ✔ Structured data agrees with visible text                     1/1 heuristic
Contract & discovery                                            5/10 measured
  ✔ Canonical URL present and self-consistent                    4/4 measured
  ✘ Cache validators                                             0/2 measured
  ✘ llms.txt present and spec-shaped                             0/1 measured
  ✔ Sitemap declared in robots.txt                               1/1 measured
  ✘ Declared machine endpoint                                    0/2 measured
Evidence density                                                 6/8 heuristic
  ✔ Quantities an answer can quote                               4/4 measured
  ✔ Labelled term and value pairs                                2/2 heuristic
  ✘ Comparable rows                                              0/2 measured

What an agent pays
  HTML          91,226 B   ≈22,806 tokens (est.)
  Negotiated    —          —
  First core fact at byte 632
  Core facts found 4/4 (100%) for a product page — heuristic

Fixes, most points first
   +15  Serve a machine representation on Accept negotiation (config)
        Return Markdown, plain text or JSON with a matching Content-Type when t…
   +10  State the missing core facts for this page kind (template)
        Coverage is scored against the fact set this kind of page is expected t…
    +5  Cut the bytes an agent has to read (engineering)
        Context cost is scored against what a page of this kind reasonably cost…
    +3  Declare the alternate representation (config)
        Add `Link: <…>; rel="alternate"; type="text/markdown"` or a typed `<lin…
    +2  Add cache headers an agent can act on (config)
        Send a Cache-Control a cache can use plus an ETag or Last-Modified. Rep…
    +2  Put the options side by side (template)
        Sizes, tiers, models, plans — one row each, in a table with at least tw…
    +2  Declare a machine endpoint (engineering)
        A feed, an OpenAPI document, /.well-known/ucp — anything an agent can c…
    +1  Publish /llms.txt (config)
        An H1 title, a short summary, and links to the pages that matter. It is…
    +1  Move the core facts to the front (template)
        A caller that reads the first few kilobytes should already have the fac…

Policy: robots.txt ok · assistant allow · training allow (neutral) · sitemap declared
ARS 0.2.0 · ruleset 18f8b6ce4a0d · corpus 15ec5c9c0966 · evidence b774a1e59433 · vantage public

ARS measures format and retrievability. It does not measure whether the
facts are true, or whether any assistant cites this page.
```

### After: the same page with content negotiation

<!-- rebilder-example: check-gateway-md | 001-pdp-gateway-md | rebilder check <url> -->

```console
https://basecamp-supply.example/products/alpine-trail-pack-28l
────────────────────────────────────────────────────────────────
A  Agent-native  93/100
63 of the 100 points are measured, 37 heuristic
page kind: product (high confidence, heuristic)

Your next steps
  • The expected core business details were detected (heuristic). Review their accuracy against your current products, services and policies.
  • Start with: Declare the alternate representation. Add `Link: <…>; rel="alternate"; type="text/markdown"` or a typed `<link rel="alternate">`. An endpoint an agent cannot find is an endpoint that does not exist.
  • Compare the two responses with rebilder diff <url> and confirm the same business facts reach customers and assistants.
  • After updating your site, run rebilder check <url> again. Export --format markdown --out review.md to share the findings with your team.
  • This scan measures page readability; it does not measure customer demand, AI recommendations or sales.

Retrievability                                                 28/28 heuristic
  ✔ Reachable on the agent path                                11/11 measured
  ✔ Robots policy for assistants                               10/10 measured
  ✔ Core facts present without JavaScript                        7/7 heuristic
Machine representation                                         15/18 heuristic
  ✔ Machine representation on Accept negotiation                 9/9 measured
  ✘ Declared alternate representations                           0/3 measured
  ✔ Vary: Accept declared correctly                              3/3 measured
  ✔ Same substance across representations                        3/3 heuristic
Fact coverage                                                  20/20 heuristic
  ✔ Core facts for this page kind                              14/14 heuristic
  ✔ Context cost relative to this page kind                      6/6 measured
Fact position                                                  10/10 heuristic
  ✔ Byte offset of the first core fact                           5/5 heuristic
  ✔ Core facts inside the front window                           5/5 heuristic
Structured data                                                  6/6 heuristic
  ✔ Structured data present and parsing                          2/2 measured
  ✔ Recognised type with its required properties                 3/3 measured
  ✔ Structured data agrees with visible text                     1/1 heuristic
Contract & discovery                                            7/10 measured
  ◐ Canonical URL present and self-consistent                    3/4 measured
  ✔ Cache validators                                             2/2 measured
  ✔ llms.txt present and spec-shaped                             1/1 measured
  ✔ Sitemap declared in robots.txt                               1/1 measured
  ✘ Declared machine endpoint                                    0/2 measured
Evidence density                                                 7/8 heuristic
  ◐ Quantities an answer can quote                               3/4 measured
  ✔ Labelled term and value pairs                                2/2 heuristic
  ✔ Comparable rows                                              2/2 measured

What an agent pays
  HTML          91,226 B   ≈22,806 tokens (est.)
  Negotiated    1,490 B    ≈372 tokens (est.)
  Reduction     99%
  First core fact at byte 0
  Core facts found 4/4 (100%) for a product page — heuristic

Fixes, most points first
    +3  Declare the alternate representation (config)
        Add `Link: <…>; rel="alternate"; type="text/markdown"` or a typed `<lin…
    +2  Declare a machine endpoint (engineering)
        A feed, an OpenAPI document, /.well-known/ucp — anything an agent can c…
    +1  Declare one canonical URL, in both representations (config)
        Add an absolute `<link rel="canonical">` to the HTML and a `Link: <…>; …
    +1  State the numbers in text (template)
        Price, sizes, weights, hours, fees, lead times, dates — written out whe…

Policy: robots.txt ok · assistant allow · training allow (neutral) · sitemap declared
ARS 0.2.0 · ruleset 18f8b6ce4a0d · corpus 15ec5c9c0966 · evidence 1fe68289a133 · vantage public

ARS measures format and retrievability. It does not measure whether the
facts are true, or whether any assistant cites this page.
```

In the captured example, the same product moves from 59 → 93, D → A, and the agent reads 1,490 bytes
instead of 91,226.

### Options

| Option                                   |                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `--format pretty\|json\|markdown\|junit` | default `pretty`                                                        |
| `--fail-on A\|B\|C\|D\|F`                | default none; `C` means C or better passes                              |
| `--out <file>`                           | write the same rendering to a file (stdout still prints)                |
| `--concurrency <n>`                      | URLs in flight; default 1, max 8                                        |
| `--allow-http`                           | permit plain `http` targets                                             |
| `--allow-private`                        | permit private, loopback and link-local targets; implies `--allow-http` |

`--concurrency` is capped at 8 because the probe's politeness limiter allows at
most 1 in-flight request per host and 2 globally regardless. A larger number
would be a promise we do not keep.

---

## `rebilder diff`

What the agent request received, next to what the browser request received.

<!-- rebilder-example: diff | 001-pdp-gateway-md | rebilder diff <url> -->

```console
https://basecamp-supply.example/products/alpine-trail-pack-28l
────────────────────────────────────────────────────────────────
The two requests differ in the Accept header and in nothing else — same User-Agent, same everything (§3.3).

              agent                             browser
Accept        text/markdown;q=1.0, text/html;…  text/html,application/xhtml+xml…
Status        200                               200
Content-Type  text/markdown; charset=utf-8      text/html; charset=utf-8
Bytes         1,490 B                           91,226 B
Tokens        ≈373 tokens (est.)                ≈22,789 tokens (est.)
Redirects     0                                 0
Error         —                                 —

Substance parity [heuristic] 3/3
  Compared on price, currency, availability and title only — never description or free text (§3.8).
  • Compared facts: price, currency, availability, title [heuristic]
  • Values: agree [heuristic]

Score: 93/100 A
ARS 0.2.0 · ruleset 18f8b6ce4a0d · corpus 15ec5c9c0966 · evidence 1fe68289a133 · vantage public

ARS measures format and retrievability. It does not measure whether the
facts are true, or whether any assistant cites this page.
```

The current diff report shows response structure and measured values.

`--fail-on` is refused here rather than ignored: `diff` reports, it does not
grade, and silently dropping a flag someone put in a CI file is how a check that
appears to gate stops gating.

---

## `--format junit`

One `<testcase>` per ARS check, one `<testsuite>` per URL, and the failure/error
split mirrors the exit-code contract: a check that fell short is a `<failure>`; a
page we never scored is an `<error>`.

<!-- rebilder-example: junit-unreachable | 041-timeout | rebilder check <url> --format junit --fail-on B -->

```console
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="rebilder.ars" tests="1" failures="0" errors="1">
  <testsuite name="https://basecamp-supply.example/products/alpine-trail-pack-28l" tests="1" failures="0" errors="1">
    <properties>
      <property name="notice" value="ARS measures format and retrievability. It does not measure whether the facts are true, or whether any assistant cites this page."/>
      <property name="url" value="https://basecamp-supply.example/products/alpine-trail-pack-28l"/>
      <property name="generatedAt" value="2026-08-05T00:00:00.000Z"/>
      <property name="tool" value="rebilder 0.3.0"/>
      <property name="specVersion" value="0.2.0"/>
      <property name="rulesetHash" value="18f8b6ce4a0df9a44e86bdb77f1098af4e6a9a8d9fd10e0df894649bb3eddf86"/>
      <property name="corpusHash" value="15ec5c9c09665bc24174e86dbf037f8ea0433cf48c97eb5b2a720b8cfbc8684b"/>
      <property name="evidenceHash" value="e1cc1ad1476117e7335e4b608e80b4a6e1e0072ce532dd6c9b5f4cce0b2f8b19"/>
      <property name="measuredWeight" value="63"/>
      <property name="heuristicWeight" value="37"/>
      <property name="exitCode" value="3"/>
      <property name="notAScoreFailure" value="probe failure — infrastructure"/>
    </properties>
    <testcase classname="https://basecamp-supply.example/products/alpine-trail-pack-28l" name="probe">
      <error type="unscored" message="UNSCORED — unreachable (timeout)"/>
    </testcase>
  </testsuite>
</testsuites>
```

Zero failures, one error, exit `3`. The two signals agree.

With `--fail-on`, one extra test case per URL carries the threshold, so the gate
is a visible line in the report rather than something implied by the exit code.
Without it that case is **absent**, not passing.

---

## `rebilder init`

Writes a `@rebilder/gateway` config scaffold for the framework it detects, and
prints how it decided. It recognizes Next.js, Express and Fastify (`node`),
Cloudflare Workers (`edge`), Shopify, SvelteKit, Nuxt, Astro, React Router,
Remix, Hono, Bun, Deno, Netlify and Vercel, and otherwise scaffolds the
framework-neutral `fetch` middleware. `--framework <name>` overrides detection.
It makes no network request and reads nothing outside the working directory.

Each scaffold links its full guide on
[rebilder.com/docs/adapters](https://rebilder.com/docs/adapters/frameworks).

The scaffold is a skeleton with `TODO`s, not a working config: the resolvers
return **your** source of truth, and every substantive value on a rendered page
comes from those fields. The gateway never invents one.

---

## `rebilder badge`

<!-- rebilder-example: badge | no probe | rebilder badge example.com -->

```console
Badge for example.com

Markdown
[![Agent Readability Score for example.com](https://rebilder.com/badge/example.com.svg)](https://rebilder.com/readable/example.com)

HTML
<a href="https://rebilder.com/readable/example.com"><img src="https://rebilder.com/badge/example.com.svg" alt="Agent Readability Score for example.com" height="20"></a>

  A grade renders only for a verified opted-in domain. Every other domain gets a neutral “not rated” badge, served at 200 so it never shows as a broken image.
  Verify by publishing a DNS TXT record `rebilder-verify=<token>`, or by serving `X-Rebilder-Path` from your origin where we can observe it.
  The badge is served live from our data: you capture nothing and freeze nothing. It degrades to “unverified” after 30 days without a successful re-scan.
  It always names its subject (`example.com · A · 94 · Mar 2026`) and it shows the ruleset hash alongside the spec version — two scores from different rulesets must not render identically.
  No score ever comes from the query string. Removal from the index is free, self-serve, permanent, and never purchasable.
  This command makes no network request. It builds the snippet locally, so we never learn which domain you asked about.
```

Built locally, with no network request, so we never learn which domain you
asked about.

---

## Zero telemetry

**This is a contract, not a setting. There is no opt-out because there is
nothing to opt out of.**

The CLI **never uploads a scan, a URL, a hostname, or a result.** It has no
analytics, no error reporting, no version check, no "anonymous usage
statistics". There is no path by which a CLI run could reach our database.

The only outbound requests this binary makes are to the target URL you named, in
the request set described above. `badge` and `init` make none at all.

This matters most in exactly the case the tool is best at. A developer running

```
rebilder check --allow-private http://staging.internal.corp/checkout
```

inside their own CI must not thereby ship internal hostnames and paths to a
third party. `--allow-private` and the no-telemetry guarantee are only safe as a
pair, and that published privacy contract remains in force.

It is enforced three ways: the package declares exactly one runtime dependency
(`@rebilder/agent-readability`, which is the probe and the scorer); ESLint denies
`node:http`, `node:https`, `node:net` and `fetch` across `src/`; and a test reads
every source file to assert the same thing, because a lint rule can be disabled
inline and that inline disable is precisely the diff worth failing a test over.

### `--allow-private`

Private, loopback and link-local targets are unlocked by a **separate entry
point** in `@rebilder/agent-readability` that throws at import time unless the
process was started with `--allow-private`, and refuses outright inside a hosted
runtime. It is not a boolean on a config object, because a boolean on a config
object is a boolean somebody eventually sets to `true` in production.

The permission is per invocation. It is never a default, never an environment
variable, and never inherited.

---

## Runtime dependencies

Hand-rolled ANSI (off when stdout is not a TTY, off whenever `NO_COLOR` is set,
on with `FORCE_COLOR`), Unicode box drawing with an ASCII fallback chosen by the
locale, and `node:util`'s `parseArgs`. Node ≥ 20.11.

Colour and Unicode are decided separately because they fail in different places:
a pipe into a file is perfectly capable of holding `│`, and a `LANG=C` container
is not.

The one runtime dependency is `@rebilder/agent-readability`: the scorer and the
probe. There is no bundled second implementation of the standard.

---

## Reading a score

Bands headline; the integer is secondary; there are no decimals.

| Grade | Range  | Label                |
| ----- | ------ | -------------------- |
| A     | 90–100 | Agent-native         |
| B     | 75–89  | Agent-friendly       |
| C     | 60–74  | Readable with effort |
| D     | 40–59  | Partial              |
| F     | 0–39   | Not extractable      |

Three outcomes carry **no letter grade at all**:

- **OPT-OUT**: a deliberate, well-formed robots disallow for the assistant
  audience. A choice, not a failure. Never ranked, never listed. Exit `4`.
- **UNSCORED — blocked**: a 403 or a challenge at the edge. The block is itself
  the finding. Exit `3`.
- **UNSCORED — unreachable / non-2xx / robots-unavailable /
  robots-disallow-scanner / truncated-evidence.** Exit `3`, except
  `robots-disallow-scanner`, which is `4`.

Blocking model-training crawlers while allowing assistants **scores identically
to a fully open site**. Two conformance fixtures exist solely to prove it.

**63 of the 100 points are measured; 37 are heuristic.** Every check reports
which it is, in every format, always. A heuristic value never renders without
its label. Token counts are `chars/4` and always carry `≈` and `est.`.

---

## `--help`

<!-- rebilder-example: help | no probe | rebilder --help -->

```console
rebilder — help AI assistants understand your business website.

USAGE
  rebilder check <url...>   [--format pretty|json|markdown|junit] [--fail-on A|B|C|D|F]
                            [--out <file>] [--allow-private] [--allow-http]
                            [--concurrency <n>]
  rebilder diff <url>       agent view vs browser view
  rebilder init             gateway config scaffold for the detected framework
  rebilder badge <domain>   embed snippet

  rebilder help <command>   detail for one command
  rebilder --version

START HERE
  1. Check an important product, service or location page.
  2. Review the business details and suggested next steps in the report.
  3. Run rebilder init in your project to prepare a website connection.
  4. Update your site and rerun the check to verify the result.

  Share a report: rebilder check <url> --format markdown --out review.md
  A scan measures readability, not AI recommendations, customer demand or sales.

EXIT CODES (a stable contract; never renumbered)
  0  completed; threshold met, or no threshold set
  1  completed; threshold NOT met
  2  usage error
  3  probe failed / target unreachable — infrastructure, not a score failure
  4  blocked by policy (SSRF guard, robots opt-out, probe budget spent)

  The 1-vs-3 split is load-bearing. A flaky network exits 3, never 1: if an
  unreachable host failed your build as a score failure, the check would be
  deleted from CI within a week. --fail-on defaults to nothing, so plain
  `rebilder check <url>` reports and exits 0.

ZERO TELEMETRY
  This CLI ships zero telemetry. It never uploads a scan, a URL, a hostname,
  or a result. The only requests it makes are to the target you name.

  Spec: https://rebilder.com/spec/ars   Crawler policy: https://rebilder.com/bots
```

ARS also **cannot detect User-Agent-targeted cloaking**, including cloaking
aimed at `rebilder-ars` itself, because both of our probes identify honestly and
we will not impersonate another operator's crawler. A site serving identical
fabricated substance to both requests scores as if it were truthful. That is a
limit of the method, stated next to the method.

---

## The examples above are real

Every `console` block in this file is generated by running the CLI against a
real conformance fixture, labelled with its fixture id, and regenerated and
compared on every build. A hand-edited block fails the build.

---

## Published

[`rebilder`](https://www.npmjs.com/package/rebilder), Apache-2.0. Every
`npx rebilder` line in this README runs as written: the published tarball ships
a bundled `dist/` and the `rebilder` bin, so there is no checkout and no build
step on your side. It needs Node.js 22 or later.

The name is unscoped on purpose. `npx rebilder check <url>` is the thing people
are told to run, and `npx @rebilder/cli` would put a scope in the middle of the
one command that has to be memorable.

## See also

- [`@rebilder/agent-readability`](https://www.npmjs.com/package/@rebilder/agent-readability):
  the scorer (`.`, pure) and the probe (`./probe`, server-only)
- [`@rebilder/gateway`](https://www.npmjs.com/package/@rebilder/gateway): the
  middleware `rebilder init` scaffolds
- [The Rebilder Agent Readability Spec (ARS)](https://rebilder.com/spec/ars)
- [Our crawler policy and opt-out](https://rebilder.com/bots)
- [Source, issues and pull requests](https://github.com/rebilder/rebilder/tree/main/packages/cli) on GitHub
