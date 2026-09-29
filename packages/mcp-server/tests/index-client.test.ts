/**
 * index-client.test.ts — the one network call, with the network injected.
 *
 * No test here reaches rebilder.com. What is asserted is the shape of the
 * request we would make (path, headers, redirect policy) and that every failure
 * mode comes back as a value rather than an exception, because the tool above it
 * has to turn each one into a readable answer.
 */

import { describe, expect, it } from 'vitest'

import { createIndexClient, indexEntryUrl, type FetchLike } from '../src/index-client'
import { CLIENT_USER_AGENT } from '../src/version'

interface Recorded {
  url: string
  headers: Record<string, string>
  redirect: string
}

function fetcher(answer: (url: string) => { status: number; body: string } | Error): {
  fetchImpl: FetchLike
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, headers: init.headers, redirect: init.redirect })
    const result = answer(url)
    if (result instanceof Error) return Promise.reject(result)
    return Promise.resolve({
      status: result.status,
      text: () => Promise.resolve(result.body),
    })
  }
  return { fetchImpl, calls }
}

describe('indexEntryUrl', () => {
  it('builds the documented path and encodes the segment', () => {
    expect(indexEntryUrl('https://rebilder.com', 'Example.COM')).toBe(
      'https://rebilder.com/api/public/index/example.com',
    )
  })
})

describe('createIndexClient', () => {
  it('sends a plain GET with our user agent and refuses to follow redirects', async () => {
    const { fetchImpl, calls } = fetcher(() => ({ status: 200, body: '{"host":"example.com"}' }))
    const client = createIndexClient({ fetchImpl })
    await client.lookup('example.com')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://rebilder.com/api/public/index/example.com')
    expect(calls[0]?.headers['user-agent']).toBe(CLIENT_USER_AGENT)
    expect(calls[0]?.headers['accept']).toBe('application/json')
    // A redirect off our own origin would be a request we did not intend to make.
    expect(calls[0]?.redirect).toBe('error')
  })

  it('returns the entry on 200', async () => {
    const { fetchImpl } = fetcher(() => ({
      status: 200,
      body: '{"host":"example.com","grade":"A"}',
    }))
    const lookup = await createIndexClient({ fetchImpl }).lookup('example.com')
    expect(lookup.kind).toBe('found')
    if (lookup.kind !== 'found') throw new Error('unreachable')
    expect(lookup.entry['grade']).toBe('A')
  })

  it('treats 404 as "not listed", which is a legitimate answer', async () => {
    const { fetchImpl } = fetcher(() => ({ status: 404, body: 'not found' }))
    expect((await createIndexClient({ fetchImpl }).lookup('example.com')).kind).toBe('not-listed')
  })

  it('reports any other status as a failure rather than guessing', async () => {
    const { fetchImpl } = fetcher(() => ({ status: 503, body: '' }))
    const lookup = await createIndexClient({ fetchImpl }).lookup('example.com')
    expect(lookup.kind).toBe('failed')
    if (lookup.kind !== 'failed') throw new Error('unreachable')
    expect(lookup.detail).toContain('503')
  })

  it('reports invalid JSON and non-objects as failures', async () => {
    const invalid = fetcher(() => ({ status: 200, body: 'not json' }))
    expect((await createIndexClient({ fetchImpl: invalid.fetchImpl }).lookup('a.com')).kind).toBe(
      'failed',
    )
    const array = fetcher(() => ({ status: 200, body: '[]' }))
    expect((await createIndexClient({ fetchImpl: array.fetchImpl }).lookup('a.com')).kind).toBe(
      'failed',
    )
  })

  it('turns a transport error into a value, never a rejection', async () => {
    const { fetchImpl } = fetcher(() => new Error('getaddrinfo ENOTFOUND'))
    const lookup = await createIndexClient({ fetchImpl }).lookup('example.com')
    expect(lookup.kind).toBe('failed')
    if (lookup.kind !== 'failed') throw new Error('unreachable')
    expect(lookup.detail).toContain('ENOTFOUND')
  })

  it('honours a validated base URL override', async () => {
    const { fetchImpl, calls } = fetcher(() => ({ status: 404, body: '' }))
    const client = createIndexClient({ fetchImpl, baseUrl: 'https://index.example.com/' })
    expect(client.baseUrl).toBe('https://index.example.com')
    await client.lookup('example.com')
    expect(calls[0]?.url).toBe('https://index.example.com/api/public/index/example.com')
  })
})
