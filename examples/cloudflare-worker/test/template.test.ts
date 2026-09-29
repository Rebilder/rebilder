/**
 * Guards on the template as a *template*, separate from the tests of what it
 * does at runtime.
 *
 * The thing being protected here is subtle enough to be worth naming: this
 * directory is meant to survive `cp -r` out of the monorepo. That means its
 * package.json cannot use `workspace:*`, its wrangler config has to be
 * deployable, and the code it ships cannot import anything a merchant will not
 * have. None of those are visible to the type checker, and all of them are one
 * careless edit away from a template that only works inside this repo.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const DIR = path.resolve(__dirname, '..')

const read = (relative: string): string => readFileSync(path.join(DIR, relative), 'utf8')

const parseVersion = (version: string): [number, number, number] => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (match === null) throw new Error(`not a plain version: ${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)]
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/** npm caret semantics for `^X.Y.Z` (on 0.x, a caret admits a single minor). */
function caretAdmits(range: string, version: string): boolean {
  if (!range.startsWith('^')) return false
  const base = parseVersion(range.slice(1))
  const v = parseVersion(version)
  if (compareVersions(version, range.slice(1)) < 0) return false
  if (base[0] > 0) return v[0] === base[0]
  if (base[1] > 0) return v[0] === 0 && v[1] === base[1]
  return v[0] === 0 && v[1] === 0 && v[2] === base[2]
}

const pkg = JSON.parse(read('package.json')) as {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  scripts: Record<string, string>
}

describe('the template survives being copied out of the monorepo', () => {
  it('depends on the published gateway, not on a workspace link', () => {
    // `workspace:*` resolves to nothing outside this repo, and the failure a
    // merchant sees is an npm 404 on a package that plainly exists.
    const range = pkg.dependencies['@rebilder/gateway']
    expect(range).toBeDefined()
    expect(range).not.toContain('workspace:')
    expect(range).toMatch(/^[\^~]?\d+\.\d+\.\d+/)
  })

  it('pins a gateway range that admits the current gateway release', () => {
    // THE RELEASE STEP THAT WAS MISSED. A caret on a 0.x version admits one
    // minor, so `^0.2.0` kept merchants on 0.2.x after 0.3.0 and 0.4.0
    // shipped. The range cannot move before a release is on npm (pnpm resolves
    // it from the registry), so two checks share the job:
    //
    //  - here, offline: the range admits what the lockfile resolved, and it
    //    admits the workspace gateway unless that version is newer than
    //    anything the lockfile has seen (a release in progress);
    //  - in CI and after every publish: `.github/scripts/check-template-range.mjs`
    //    compares the range with npm's latest release and fails until it is
    //    widened.
    const range = pkg.dependencies['@rebilder/gateway'] ?? ''
    const workspace = (
      JSON.parse(readFileSync(path.join(DIR, '../../packages/gateway/package.json'), 'utf8')) as {
        version: string
      }
    ).version
    const lockfile = readFileSync(path.join(DIR, '../../pnpm-lock.yaml'), 'utf8')
    const locked =
      /\n {2}examples\/cloudflare-worker:\n[\s\S]*?'@rebilder\/gateway':\n\s+specifier: [^\n]+\n\s+version: ([^\s(]+)/.exec(
        lockfile,
      )?.[1]

    expect(range).toMatch(/^\^\d+\.\d+\.\d+$/)
    expect(locked, 'examples/cloudflare-worker is missing from pnpm-lock.yaml').toBeDefined()
    expect(caretAdmits(range, locked!), `${range} does not admit the locked ${locked}`).toBe(true)
    if (compareVersions(workspace, locked!) <= 0) {
      expect(
        caretAdmits(range, workspace),
        `${range} does not admit the workspace gateway ${workspace}. Set it to "^${workspace}" and run pnpm install.`,
      ).toBe(true)
    }
  })

  it('declares no workspace protocol anywhere in its manifest', () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies }
    for (const [name, range] of Object.entries(all)) {
      expect(range, `${name} uses the workspace protocol`).not.toContain('workspace:')
    }
  })

  it('imports nothing from the monorepo by relative path', () => {
    // A `../../packages/...` import compiles here and is a 404 anywhere else.
    for (const file of ['src/index.ts', 'src/gateway-config.ts', 'src/content.ts']) {
      expect(read(file), file).not.toMatch(/from '\.\.\/\.\.\//)
    }
  })

  it('ships the scripts the README tells people to run', () => {
    for (const script of ['dev', 'deploy', 'tail']) {
      expect(pkg.scripts[script], script).toBeDefined()
    }
  })
})

describe('the wrangler config is deployable as written', () => {
  const wrangler = read('wrangler.jsonc')

  it('names an entry point that exists', () => {
    expect(wrangler).toContain('"main": "src/index.ts"')
    expect(() => read('src/index.ts')).not.toThrow()
  })

  it('pins a compatibility date', () => {
    // Without one, a Worker's behaviour drifts with the runtime.
    expect(wrangler).toMatch(/"compatibility_date":\s*"\d{4}-\d{2}-\d{2}"/)
  })

  it('leaves routes commented out rather than shipping a placeholder zone', () => {
    // A template that deploys itself onto a placeholder domain is a template
    // that fails confusingly. Routes are the one required edit, and the README
    // says so.
    expect(wrangler).not.toMatch(/^\s*"routes"\s*:/m)
    expect(wrangler).toContain('ROUTES')
  })

  it('declares the ORIGIN var the entry point reads', () => {
    expect(wrangler).toContain('"ORIGIN"')
    expect(read('src/index.ts')).toContain('env.ORIGIN')
  })
})

describe('the example content is obviously an example', () => {
  const content = read('src/content.ts')

  it('uses reserved documentation names, not a real business', () => {
    // example.com and +44 20 7946 xxxx are reserved for documentation. A
    // template carrying a real phone number sends strangers real phone calls.
    expect(content).toContain('example.com')
    expect(content).not.toMatch(/https:\/\/(?!example\.com)[a-z0-9-]+\.(com|co\.uk|org)\//)
  })

  it('says in the file that it is the file to edit', () => {
    expect(content).toContain('THIS IS THE FILE YOU EDIT')
  })
})
