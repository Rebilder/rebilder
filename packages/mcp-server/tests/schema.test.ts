/**
 * schema.test.ts — the declared `outputSchema` checked against the package it
 * claims to describe, not against our memory of it.
 *
 * Every tool is called for real and its `structuredContent` is validated
 * against the schema `tools/list` publishes for it, in both directions: nothing
 * the schema requires is missing, and nothing the result carries is undeclared.
 * The second direction is the one that catches drift — a MINOR bump in
 * `@rebilder/agent-readability` that adds a field to `ArsResult` fails here
 * instead of shipping a schema that quietly lies to every client.
 */

import { describe, expect, it } from 'vitest'

import { isJsonObject, type JsonObject } from '../src/json'
import { ARS_RESULT_SCHEMA } from '../src/schema'
import { findTool, TOOLS } from '../src/tools/index'
import { callFrame, readyHarness, type Harness } from './harness'
import { undeclaredKeys, validate } from './validate'

const TARGET = 'https://example.com/products/kettle'

async function structuredOf(
  harness: Harness,
  name: string,
  args: Record<string, unknown>,
): Promise<JsonObject> {
  const response = await harness.server.handleLine(callFrame(name, args))
  if (response === null || 'error' in response) throw new Error('expected a tool result')
  const structured = response.result['structuredContent']
  if (!isJsonObject(structured)) throw new Error('expected structuredContent')
  return structured
}

function schemaOf(name: string): JsonObject {
  const tool = findTool(name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return tool.outputSchema
}

describe('ARS_RESULT_SCHEMA', () => {
  it('validates a real scored result', async () => {
    const harness = await readyHarness({ negotiates: true })
    const result = await structuredOf(harness, 'scan_url', { url: TARGET })
    expect(validate(result, ARS_RESULT_SCHEMA)).toEqual([])
  })

  it('declares every key a real result carries — drift fails here', async () => {
    const harness = await readyHarness({ negotiates: true })
    const result = await structuredOf(harness, 'scan_url', { url: TARGET })
    expect(undeclaredKeys(result, ARS_RESULT_SCHEMA)).toEqual([])
  })

  it('validates an unscored result too, where score and grade are null', async () => {
    const harness = await readyHarness({ unreachable: true })
    const result = await structuredOf(harness, 'scan_url', { url: TARGET })
    expect(result['score']).toBeNull()
    expect(result['grade']).toBeNull()
    expect(validate(result, ARS_RESULT_SCHEMA)).toEqual([])
  })

  it('is the schema scan_url actually advertises', () => {
    expect(schemaOf('scan_url')).toBe(ARS_RESULT_SCHEMA)
  })
})

describe('every tool validates against its own declared output schema', () => {
  it('compare_agent_view', async () => {
    const harness = await readyHarness({ negotiates: true })
    const structured = await structuredOf(harness, 'compare_agent_view', { url: TARGET })
    expect(validate(structured, schemaOf('compare_agent_view'))).toEqual([])
  })

  it('explain_check', async () => {
    const harness = await readyHarness()
    const structured = await structuredOf(harness, 'explain_check', {
      check_id: 'contract-discovery.llms-txt',
    })
    expect(validate(structured, schemaOf('explain_check'))).toEqual([])
    expect(undeclaredKeys(structured, schemaOf('explain_check'))).toEqual([])
  })

  it('get_index_entry', async () => {
    const harness = await readyHarness()
    const structured = await structuredOf(harness, 'get_index_entry', { domain: 'example.com' })
    expect(validate(structured, schemaOf('get_index_entry'))).toEqual([])
  })

  it('install_snippet', async () => {
    const harness = await readyHarness()
    const structured = await structuredOf(harness, 'install_snippet', { framework: 'next' })
    expect(validate(structured, schemaOf('install_snippet'))).toEqual([])
    expect(undeclaredKeys(structured, schemaOf('install_snippet'))).toEqual([])
  })
})

describe('input schemas', () => {
  it('are closed, so an unknown argument is a rejection rather than a silent drop', () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema['additionalProperties']).toBe(false)
      expect(tool.inputSchema['type']).toBe('object')
    }
  })

  it('expose no property that could relax the probe', () => {
    // The design's whole argument for a separate `./probe/local` entry point is
    // that a boolean on a config object eventually gets set to true by something
    // reading attacker-controlled text. A tool argument IS that config object.
    const forbidden =
      /allow_private|allowPrivate|allow_http|allowHttp|robots|limiter|concurrency|max_body|maxBody|timeout|redirect/i
    for (const tool of TOOLS) {
      const properties = tool.inputSchema['properties']
      if (!isJsonObject(properties)) throw new Error('expected properties')
      for (const key of Object.keys(properties)) {
        expect(key).not.toMatch(forbidden)
      }
    }
  })
})
