import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { detect, type AgentPlatform, type RequesterKind } from '../src/index'

interface FixtureSample {
  headers: Record<string, string | string[] | undefined>
  url?: string
  expected: {
    kind: RequesterKind
    platform: AgentPlatform | null
    acceptsMarkdown: boolean
  }
}

interface FixtureFile {
  name: string
  description: string
  samples: FixtureSample[]
}

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
const fixtureFiles = readdirSync(fixturesDir)
  .filter((file) => file.endsWith('.json'))
  .sort()

describe('fixture library', () => {
  it('contains at least the core observed agents', () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(8)
  })

  for (const file of fixtureFiles) {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) as FixtureFile

    describe(`${fixture.name} (${file})`, () => {
      it('has a name, description, and at least one sample', () => {
        expect(fixture.name.length).toBeGreaterThan(0)
        expect(fixture.description.length).toBeGreaterThan(0)
        expect(fixture.samples.length).toBeGreaterThan(0)
      })

      fixture.samples.forEach((sample, index) => {
        it(`sample ${index + 1} classifies as ${sample.expected.kind}/${String(sample.expected.platform)}`, () => {
          const result = detect({ headers: sample.headers, url: sample.url })
          expect(result.kind).toBe(sample.expected.kind)
          expect(result.platform).toBe(sample.expected.platform)
          expect(result.acceptsMarkdown).toBe(sample.expected.acceptsMarkdown)
          // Phase 0: no signature verification exists, so verified is always false.
          expect(result.verified).toBe(false)
          // Every non-default classification must be explainable via signals.
          if (sample.expected.kind !== 'human') {
            expect(result.signals.length).toBeGreaterThan(0)
          }
        })
      })
    })
  }
})
