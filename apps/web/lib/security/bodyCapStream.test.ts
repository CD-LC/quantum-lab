/**
 * An oversized STREAMED body (no Content-Length, chunked) is refused with 413 by
 * the tools, hardware and exams routes, and the read is cancelled early rather
 * than buffered whole.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rateLimit'
import { resetAll } from '@/lib/security/ratelimit'
import { POST as toolsPOST } from '@/app/api/tools/route'
import { POST as transpilePOST } from '@/app/api/hardware/transpile/route'
import { PUT as answersPUT } from '@/app/api/exams/[examId]/answers/route'

beforeEach(() => {
  __resetRateLimitForTests()
  resetAll()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  __resetRateLimitForTests()
  resetAll()
})

/** A request whose body is a stream of `chunks` x 64 KiB with no length header. */
function streamedRequest(url: string, method: string, ip: string, chunks = 40) {
  let pulled = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) return controller.close()
      pulled += 1
      controller.enqueue(new Uint8Array(64 * 1024).fill(120))
    },
    cancel() {
      cancelled = true
    },
  })
  const req = new Request(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body,
    duplex: 'half',
  } as RequestInit)
  return { req, pulled: () => pulled, cancelled: () => cancelled, chunks }
}

describe('streamed oversize bodies are refused with 413', () => {
  it('POST /api/tools', async () => {
    const s = streamedRequest('http://test.local/api/tools', 'POST', '203.0.113.21')
    const res = await toolsPOST(s.req)
    expect(res.status).toBe(413)
    expect(((await res.json()) as { code: string }).code).toBe('payload_too_large')
    expect(s.cancelled()).toBe(true)
    expect(s.pulled()).toBeLessThan(s.chunks)
  })

  it('POST /api/hardware/transpile', async () => {
    const s = streamedRequest('http://test.local/api/hardware/transpile', 'POST', '203.0.113.22')
    const res = await transpilePOST(s.req)
    expect(res.status).toBe(413)
    expect(s.cancelled()).toBe(true)
    expect(s.pulled()).toBeLessThan(s.chunks)
  })

  it('PUT /api/exams/[examId]/answers', async () => {
    const s = streamedRequest('http://test.local/api/exams/foundations-cert/answers', 'PUT', '203.0.113.23')
    const res = await answersPUT(s.req, { params: Promise.resolve({ examId: 'foundations-cert' }) })
    expect(res.status).toBe(413)
    expect(s.cancelled()).toBe(true)
    expect(s.pulled()).toBeLessThan(s.chunks)
  })

  it('a small valid body to /api/tools is still parsed (400 for a bad tool, not 413)', async () => {
    const res = await toolsPOST(
      new Request('http://test.local/api/tools', {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.24' },
        body: JSON.stringify({ tool: 'nope', args: {} }),
      })
    )
    expect(res.status).toBe(400)
  })
})
