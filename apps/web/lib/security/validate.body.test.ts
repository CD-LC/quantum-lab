/**
 * Bounded body reads: the byte cap must be enforced WHILE the body is read, so
 * an oversized upload is refused without being buffered in full.
 */

import { describe, expect, it } from 'vitest'
import { readBodyText, readJsonBody } from './validate'

/** A request whose body is a stream we control, so we can see how much was pulled. */
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let pulled = 0
  let cancelled = false
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      const chunk = chunks[i++]!
      pulled += chunk.byteLength
      controller.enqueue(chunk)
    },
    cancel() {
      cancelled = true
    },
  })
  const req = new Request('http://test.local/x', {
    method: 'POST',
    body,
    headers,
    // Required by undici for a streaming request body.
    duplex: 'half',
  } as RequestInit)
  return { req, pulled: () => pulled, cancelled: () => cancelled }
}

describe('readBodyText', () => {
  it('returns the text of a body within the cap', async () => {
    const req = new Request('http://test.local/x', { method: 'POST', body: '{"a":1}' })
    const result = await readBodyText(req, 100)
    expect(result).toEqual({ ok: true, value: '{"a":1}' })
  })

  it('treats a missing body as empty text', async () => {
    const result = await readBodyText(new Request('http://test.local/x', { method: 'POST' }), 100)
    expect(result).toEqual({ ok: true, value: '' })
  })

  it('refuses on a declared Content-Length over the cap without reading the stream', async () => {
    const chunks = Array.from({ length: 100 }, () => new Uint8Array(1024))
    const { req, pulled } = streamed(chunks, { 'content-length': '102400' })
    const result = await readBodyText(req, 100)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.tooLarge).toBe(true)
    // The runtime may prefetch a chunk or two into its own queue; the point is
    // that we did not drain the upload.
    expect(pulled()).toBeLessThan(16 * 1024)
  })

  it('stops reading as soon as the running total passes the cap (no length header)', async () => {
    // 1000 chunks of 1 KiB = 1 MiB on offer; the cap is 4 KiB.
    const chunks = Array.from({ length: 1000 }, () => new Uint8Array(1024).fill(97))
    const { req, pulled, cancelled } = streamed(chunks)
    const result = await readBodyText(req, 4096)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.tooLarge).toBe(true)
    expect(cancelled()).toBe(true)
    // Bounded by the cap plus a little read-ahead, nowhere near the 1 MiB offered.
    expect(pulled()).toBeLessThan(64 * 1024)
  })

  it('is not fooled by a Content-Length that understates the body', async () => {
    const chunks = Array.from({ length: 50 }, () => new Uint8Array(1024).fill(97))
    const { req } = streamed(chunks, { 'content-length': '10' })
    const result = await readBodyText(req, 4096)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.tooLarge).toBe(true)
  })

  it('counts bytes, not characters', async () => {
    // 60 astral characters = 240 bytes but only 120 UTF-16 units.
    const text = '\u{1F600}'.repeat(60)
    const req = new Request('http://test.local/x', { method: 'POST', body: text })
    expect((await readBodyText(req, 200)).ok).toBe(false)
    const again = new Request('http://test.local/x', { method: 'POST', body: text })
    expect((await readBodyText(again, 240)).ok).toBe(true)
  })

  it('accepts a body exactly at the cap', async () => {
    const req = new Request('http://test.local/x', { method: 'POST', body: 'a'.repeat(64) })
    expect((await readBodyText(req, 64)).ok).toBe(true)
  })

  it('reassembles multi-chunk bodies, including a multibyte char split across chunks', async () => {
    const bytes = new TextEncoder().encode('héllo wörld')
    const { req } = streamed([bytes.slice(0, 2), bytes.slice(2, 8), bytes.slice(8)])
    const result = await readBodyText(req, 100)
    expect(result).toEqual({ ok: true, value: 'héllo wörld' })
  })

  it('reports a broken stream as a normal failure, not a throw', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('socket reset'))
      },
    })
    const req = new Request('http://test.local/x', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit)
    const result = await readBodyText(req, 100)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.tooLarge).toBe(false)
  })
})

describe('readJsonBody', () => {
  it('parses JSON within the cap', async () => {
    const req = new Request('http://test.local/x', { method: 'POST', body: '{"a":[1,2]}' })
    expect(await readJsonBody(req, 100)).toEqual({ ok: true, value: { a: [1, 2] } })
  })

  it('flags an oversized body as tooLarge so a route can answer 413', async () => {
    const req = new Request('http://test.local/x', { method: 'POST', body: JSON.stringify({ a: 'x'.repeat(500) }) })
    const result = await readJsonBody(req, 100)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.tooLarge).toBe(true)
  })

  it('flags malformed and empty JSON as a 400-class failure', async () => {
    const bad = await readJsonBody(new Request('http://test.local/x', { method: 'POST', body: '{nope' }), 100)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.tooLarge).toBe(false)
    const empty = await readJsonBody(new Request('http://test.local/x', { method: 'POST', body: '  ' }), 100)
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.tooLarge).toBe(false)
  })
})
