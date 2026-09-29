/**
 * help.test.ts — what `--help` must not lose, and the version constant.
 *
 * `--help` is the surface most likely to lose a paragraph in a tidy-up, and two
 * of the ones it carries are not ours to tidy: the zero-telemetry contract
 * (a promise the READMEs state as a contract and which may not be softened into
 * an opt-out) and the exit-code table (which is what makes the 1-vs-3 split
 * discoverable before the first flaky build rather than after it).
 *
 * The conflict-of-interest paragraph was removed everywhere in Aug 2026 with
 * the spec clause that required it; `does not carry` below is what keeps it
 * from drifting back in on one surface only.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CLI_VERSION, runCli } from '../src/cli'
import {
  ARS_NOTICE,
  TELEMETRY_LINES,
} from '../src/disclosure'
import { helpText } from '../src/help'
import { createFakeRuntime } from './support'

const HERE = dirname(fileURLToPath(import.meta.url))

describe('--help', () => {
  it('prints the zero-telemetry contract', async () => {
    const fake = createFakeRuntime()
    await runCli(['--help'], fake.runtime)
    for (const line of TELEMETRY_LINES) {
      expect(fake.stdout()).toContain(line)
    }
  })

  it('carries no conflict-of-interest paragraph on any help surface', () => {
    for (const text of [helpText(null), helpText('check'), helpText('diff')]) {
      expect(text).not.toContain('authored by Rebilder')
    }
  })

  it('prints the exit-code table with the numbers and the 1-vs-3 reasoning', async () => {
    const fake = createFakeRuntime()
    await runCli(['--help'], fake.runtime)
    const text = fake.stdout()
    for (const row of [
      '0  completed; threshold met',
      '1  completed; threshold NOT met',
      '2  usage error',
      '3  probe failed / target unreachable',
      '4  blocked by policy',
    ]) {
      expect(text).toContain(row)
    }
    expect(text).toContain('never renumbered')
    expect(text).toContain('deleted from CI within a week')
    expect(text).toContain('--fail-on defaults to nothing')
  })

  it('states the zero-telemetry guarantee', async () => {
    const fake = createFakeRuntime()
    await runCli(['--help'], fake.runtime)
    for (const line of TELEMETRY_LINES) {
      expect(fake.stdout()).toContain(line)
    }
  })

  it('has a topic for every command, and each documents --format', () => {
    for (const topic of ['check', 'diff', 'init', 'badge'] as const) {
      const text = helpText(topic)
      expect(text.startsWith(`rebilder ${topic}`)).toBe(true)
      expect(text).toContain('--format')
    }
  })

  it('`check --help` explains that --allow-private is per invocation', () => {
    const text = helpText('check')
    expect(text).toContain('opt-in')
    expect(text).toContain('never a config default')
    expect(text).toContain('refuses to load in a hosted runtime')
  })

  it('goes to stdout and exits 0 — help is not an error', async () => {
    const fake = createFakeRuntime()
    expect(await runCli(['--help'], fake.runtime)).toBe(0)
    expect(fake.stderr()).toBe('')
  })
})

describe('the disclosure texts themselves', () => {
  it('the §3.6 notice is exactly the sentence the spec pins', () => {
    expect(ARS_NOTICE).toBe(
      'ARS measures format and retrievability. It does not measure whether the facts are true, or whether any assistant cites this page.',
    )
  })

  it('exports no conflict-of-interest text to print', async () => {
    // Removed everywhere Aug 2026. Asserted on the module rather than on the
    // rendered help, so a future surface cannot reintroduce it by importing a
    // constant that quietly survived the removal.
    const disclosure = (await import('../src/disclosure')) as Record<string, unknown>
    expect(Object.keys(disclosure).filter((key) => /CONFLICT/i.test(key))).toEqual([])
  })
})

describe('--version', () => {
  it('matches package.json — a hand-maintained constant drifts', async () => {
    const manifest = JSON.parse(readFileSync(resolve(HERE, '..', 'package.json'), 'utf8')) as {
      version: string
      name: string
      bin: Record<string, string>
    }
    expect(CLI_VERSION).toBe(manifest.version)
    expect(manifest.name).toBe('rebilder')
    expect(manifest.bin['rebilder']).toBeDefined()

    const fake = createFakeRuntime()
    await runCli(['--version'], fake.runtime)
    expect(fake.stdout().trim()).toBe(manifest.version)
  })
})
