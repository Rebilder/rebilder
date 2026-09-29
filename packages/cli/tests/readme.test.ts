/**
 * readme.test.ts — the README's terminal output is real, and stays real.
 *
 * DESIGN §5.6, VERBATIM: *"Terminal output must not be faked in docs. Any
 * example block in a README or screenshot is generated from a real conformance
 * fixture and labelled with its fixture id."* The design records why the rule
 * exists: an earlier mock shipped `47/100` with `+20 pts, D → B`, which is
 * arithmetically impossible against its own bands (47 + 20 = 67 = C), and reused
 * a byte offset from a fictional fixture attached to a different domain. Nobody
 * caught it, because nothing could.
 *
 * So every example block in `README.md` is annotated with the command and the
 * fixture that produced it, and this test regenerates each one and compares. A
 * hand-edited README fails. A change to the renderer that nobody reflected in
 * the docs fails. A fixture whose score moves in a MINOR release fails, which is
 * exactly when the docs are most likely to go quietly stale.
 *
 * Regenerate with:
 *   REBILDER_README_UPDATE=1 pnpm --filter rebilder test
 * It rewrites the blocks and then FAILS the run, so an update can never be
 * mistaken for a pass — the same discipline the conformance corpus runner uses.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli'
import { createFakeRuntime, evidenceOutcome, FIXTURES } from './support'

const HERE = dirname(fileURLToPath(import.meta.url))
const README = resolve(HERE, '..', 'README.md')
const UPDATE = process.env['REBILDER_README_UPDATE'] === '1'

const URL = 'https://basecamp-supply.example/products/alpine-trail-pack-28l'

/**
 * Every example block, keyed by the id that appears in the README marker.
 * `fixture: null` means the command probes nothing (help, badge, init).
 */
const EXAMPLES: Record<
  string,
  { argv: string[]; fixture: string | null; files?: Record<string, string> }
> = {
  'check-raw-html': { argv: ['check', URL], fixture: FIXTURES.rawHtml },
  'check-gateway-md': { argv: ['check', URL], fixture: FIXTURES.gatewayMd },
  diff: { argv: ['diff', URL], fixture: FIXTURES.gatewayMd },
  'junit-unreachable': {
    argv: ['check', URL, '--format', 'junit', '--fail-on', 'B'],
    fixture: FIXTURES.timeout,
  },
  badge: { argv: ['badge', 'example.com'], fixture: null },
  help: { argv: ['--help'], fixture: null },
}

async function generate(id: string): Promise<string> {
  const example = EXAMPLES[id]
  if (example === undefined) throw new Error(`unknown README example: ${id}`)
  const fake = createFakeRuntime({
    outcomes: example.fixture === null ? [] : [evidenceOutcome(example.fixture)],
    env: { NO_COLOR: '1', LANG: 'en_US.UTF-8' },
    columns: 80,
    files: example.files ?? {},
  })
  await runCli(example.argv, fake.runtime)
  return fake.stdout().replace(/\n+$/, '\n')
}

/**
 * `<!-- rebilder-example: <id> | <fixture or "no probe"> | <command> -->`
 *
 * The optional blank line between the marker and the fence is Prettier's doing —
 * it separates an HTML comment from the block below it, and a matcher that
 * insisted on the tight form would fail the moment anyone ran `pnpm format`.
 */
const MARKER =
  /<!-- rebilder-example: ([a-z0-9-]+) \| ([^|\n]+) \| ([^\n]+?) -->\n\n?```console\n([\s\S]*?)```/g

interface Block {
  id: string
  provenance: string
  command: string
  body: string
  full: string
}

function parseBlocks(markdown: string): Block[] {
  return [...markdown.matchAll(MARKER)].map((match) => ({
    id: match[1] ?? '',
    provenance: (match[2] ?? '').trim(),
    command: (match[3] ?? '').trim(),
    body: match[4] ?? '',
    full: match[0],
  }))
}

describe('README example blocks', () => {
  const markdown = readFileSync(README, 'utf8')
  const blocks = parseBlocks(markdown)

  it('exist, and cover every example this test knows how to generate', () => {
    expect(blocks.length).toBeGreaterThan(0)
    expect(new Set(blocks.map((block) => block.id))).toEqual(new Set(Object.keys(EXAMPLES)))
  })

  it('each names its fixture id, as §5.6 requires', () => {
    for (const block of blocks) {
      const example = EXAMPLES[block.id]
      const expected = example?.fixture ?? 'no probe'
      expect(block.provenance, block.id).toContain(expected)
    }
  })

  it('reproduce byte for byte from the live renderer', async () => {
    let updated = markdown
    const mismatches: string[] = []

    for (const block of blocks) {
      const generated = await generate(block.id)
      if (generated === block.body) continue
      mismatches.push(block.id)
      const example = EXAMPLES[block.id]
      const provenance = example?.fixture ?? 'no probe'
      updated = updated.replace(
        block.full,
        `<!-- rebilder-example: ${block.id} | ${provenance} | ${block.command} -->\n\n\`\`\`console\n${generated}\`\`\``,
      )
    }

    if (UPDATE) {
      writeFileSync(README, updated, 'utf8')
      // Fail even on a clean update: blessing output nobody has read is how a
      // doc stops describing the tool and starts describing the bug.
      throw new Error(
        `README.md rewritten (${mismatches.length} block(s) changed). Read the diff, then run without REBILDER_README_UPDATE.`,
      )
    }

    expect(mismatches, 'stale README blocks — REBILDER_README_UPDATE=1 to regenerate').toEqual([])
  })

  it('contains no example block outside the generated markers', () => {
    // A `console` fence with no marker is a hand-written terminal transcript,
    // which is the exact thing the rule forbids.
    const fenced = [...markdown.matchAll(/```console\n/g)].length
    expect(fenced).toBe(blocks.length)
  })

  it('documents every exit code, with the numbers', () => {
    // Whitespace-tolerant: Prettier right-aligns the numeric column, so the
    // literal `| 0 |` is not what ends up in the file.
    const documented = [...markdown.matchAll(/^\|\s*(\d)\s*\|\s+\S/gm)].map((match) =>
      Number(match[1]),
    )
    expect(documented).toEqual([0, 1, 2, 3, 4])
    expect(markdown).toContain('never renumbered')
  })

  it('states the zero-telemetry guarantee as a contract', () => {
    expect(markdown).toContain('Zero telemetry')
    expect(markdown).toMatch(/never uploads? a scan, a URL, a hostname, or a result/)
  })

  it('carries no conflict-of-interest disclosure', () => {
    // Removed everywhere Aug 2026, with the spec clause that required it. The
    // README embeds a verified `--help` transcript, so this also catches the
    // paragraph coming back through the CLI without the doc being regenerated.
    expect(markdown).not.toContain('authored by Rebilder')
  })
})
