/**
 * registry.test.ts — `server.json`, the MCP Registry entry, agrees with the
 * package it describes.
 *
 * The registry verifies npm ownership by reading `mcpName` from the PUBLISHED
 * manifest of the exact version named here, and refuses a publish whose
 * version it has seen before. So the three fields that must agree (the name,
 * the npm identifier and the version) are pinned against package.json on every
 * run, and the version bump that ships a release moves them together.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { INDEX_BASE_URL_ENV } from '../src/index-client'
import { PROBE_BUDGET_ENV } from '../src/scanner'
import { LATEST_PROTOCOL_VERSION } from '../src/version'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file: string): unknown => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'))

interface ServerJson {
  $schema: string
  name: string
  title?: string
  description: string
  version: string
  websiteUrl?: string
  repository?: unknown
  packages: {
    registryType: string
    registryBaseUrl?: string
    identifier: string
    version: string
    transport: { type: string }
    environmentVariables?: { name: string; description: string; isSecret?: boolean }[]
  }[]
}

const server = read('server.json') as ServerJson
const manifest = read('package.json') as {
  name: string
  version: string
  mcpName?: string
  bin?: Record<string, string>
  repository?: { type: string; url: string; directory: string }
}

describe('server.json', () => {
  it('uses the current dated registry schema', () => {
    expect(server.$schema).toMatch(
      /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/,
    )
  })

  it('names the server exactly as package.json mcpName does', () => {
    expect(manifest.mcpName).toBe(server.name)
    // Reverse-DNS under a domain we can verify; the registry's name pattern.
    expect(server.name).toMatch(/^com\.rebilder\/[a-zA-Z0-9._-]+$/)
  })

  it('describes the published npm package at the version in package.json', () => {
    expect(server.version).toBe(manifest.version)
    expect(server.packages).toHaveLength(1)
    const [pkg] = server.packages
    expect(pkg?.registryType).toBe('npm')
    expect(pkg?.registryBaseUrl).toBe('https://registry.npmjs.org')
    expect(pkg?.identifier).toBe(manifest.name)
    expect(pkg?.version).toBe(manifest.version)
    expect(pkg?.transport).toEqual({ type: 'stdio' })
  })

  it('fits the registry limits', () => {
    expect(server.description.length).toBeGreaterThan(0)
    expect(server.description.length).toBeLessThanOrEqual(100)
    expect((server.title ?? '').length).toBeLessThanOrEqual(100)
    expect(server.websiteUrl).toMatch(/^https:\/\//)
  })

  it('declares only the environment variables the binary reads, none of them secret', () => {
    const names = (server.packages[0]?.environmentVariables ?? []).map((variable) => variable.name)
    expect(names.sort()).toEqual([INDEX_BASE_URL_ENV, PROBE_BUDGET_ENV].sort())
    for (const variable of server.packages[0]?.environmentVariables ?? []) {
      expect(variable.isSecret ?? false).toBe(false)
    }
  })

  it('names the public source repository that package.json names', () => {
    const repository = manifest.repository
    expect(repository?.url).toMatch(/^git\+https:\/\/github\.com\/[^/]+\/[^/]+\.git$/)
    expect(server.repository).toEqual({
      url: repository?.url.replace(/^git\+/, '').replace(/\.git$/, ''),
      source: 'github',
      subfolder: repository?.directory,
    })
    expect(repository?.directory).toBe('packages/mcp-server')
  })
})

describe('README install one-liners', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const runs = `npx -y ${manifest.name}`

  it('covers Claude Code, VS Code and Cursor with the published package name', () => {
    expect(readme).toContain(`claude mcp add rebilder -- ${runs}`)
    expect(readme).toContain(
      `code --add-mcp '{"name":"rebilder","type":"stdio","command":"npx","args":["-y","${manifest.name}"]}'`,
    )
    expect(readme).toContain('.cursor/mcp.json')
    expect(readme).toContain(`"args": ["-y", "${manifest.name}"]`)
  })

  it('names the MCP revision the server actually defaults to', () => {
    expect(readme).toContain(`\`${LATEST_PROTOCOL_VERSION}\` (the default)`)
  })

  it('uses absolute links only', () => {
    for (const [, target] of readme.matchAll(/\]\(([^)#][^)]*)\)/g)) {
      expect(target).toMatch(/^https:\/\//)
    }
  })
})
