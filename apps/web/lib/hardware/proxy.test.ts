/**
 * Tests for the hardware proxy route handlers.
 *
 * These drive the real route modules under app/api/hardware/** with a stubbed
 * global `fetch`, so what is proved is: the upstream URL, the method, the body
 * that leaves the Next server, whether the shared secret is attached, and what
 * the browser gets back. `services/api` itself is not running here — its own
 * half of the gate is covered by services/api/tests/test_security.py.
 *
 * What is NOT proved: behaviour behind a real reverse proxy. docs/SECURITY.md
 * already records that a platform which strips unknown headers will break the
 * shared secret, and nothing here can detect that.
 *
 * NOT PROVED HERE EITHER, and much more important: the entitlement, quota and
 * ownership gates on `/api/hardware/submit` and `/api/hardware/job/*`. This file
 * drives those two routes ANONYMOUSLY, so after the gates landed it can only
 * observe them refusing — which is itself worth asserting and is asserted below.
 * The gates' own behaviour, including the signed-in paths, lives in
 * lib/hardware/submitGate.test.ts. Keep the split: this file is about the
 * transport (URL, method, body, secret, limiter), that one is about who may use
 * it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rateLimit'
import { GET as devicesGET } from '@/app/api/hardware/devices/route'
import { POST as estimatePOST } from '@/app/api/hardware/estimate/route'
import { POST as transpilePOST } from '@/app/api/hardware/transpile/route'
import { POST as submitPOST } from '@/app/api/hardware/submit/route'
import { GET as jobGET } from '@/app/api/hardware/job/[provider]/[...jobId]/route'

const SECRET_HEADER = 'X-Quantum-Lab-Secret'
const UPSTREAM = 'http://localhost:8000'

/** A minimal circuit that passes every shape check. */
const QASM = 'OPENQASM 3.0;\nqubit[2] q;\nh q[0];\ncx q[0], q[1];\n'

function jsonRequest(url: string, body: unknown, ip = '203.0.113.1'): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  })
}

function getRequest(url: string, ip = '203.0.113.1'): Request {
  return new Request(url, { headers: { 'x-forwarded-for': ip } })
}

/** Stub upstream: always 200 with the given payload. Returns the spy. */
function stubUpstream(payload: unknown = { ok: true }): ReturnType<typeof vi.fn> {
  const mock = vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

function upstreamCall(mock: ReturnType<typeof vi.fn>, index = 0): [string, RequestInit] {
  return mock.mock.calls[index] as [string, RequestInit]
}

beforeEach(() => {
  delete process.env.QUANTUM_API_SECRET
  delete process.env.API_SHARED_SECRET
  __resetRateLimitForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete process.env.QUANTUM_API_SECRET
  delete process.env.API_SHARED_SECRET
  __resetRateLimitForTests()
})

describe('forwarding', () => {
  it('sends GET /api/hardware/devices upstream and returns the body unchanged', async () => {
    const upstream = stubUpstream([{ id: 'ibm_brisbane' }])

    const response = await devicesGET(getRequest('http://app.test/api/hardware/devices'))

    expect(upstreamCall(upstream)[0]).toBe(`${UPSTREAM}/api/hardware/devices`)
    expect(upstreamCall(upstream)[1].method).toBe('GET')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual([{ id: 'ibm_brisbane' }])
  })

  it('forwards estimate with the validated fields', async () => {
    const upstream = stubUpstream({ total_usd: 1.5 })

    await estimatePOST(
      jsonRequest('http://app.test/api/hardware/estimate', {
        backend: 'ibm_brisbane',
        shots: 1024,
        qasm: QASM,
      })
    )

    const [url, init] = upstreamCall(upstream)
    expect(url).toBe(`${UPSTREAM}/api/hardware/estimate`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      backend: 'ibm_brisbane',
      shots: 1024,
      qasm: QASM,
    })
  })

  it('forwards the circuit source byte for byte, whitespace included', async () => {
    const upstream = stubUpstream()
    const padded = `\n${QASM}\n\n`

    await transpilePOST(
      jsonRequest('http://app.test/api/hardware/transpile', {
        qasm: padded,
        backend: 'ibm_brisbane',
        optimization_level: 2,
      })
    )

    expect(JSON.parse(String(upstreamCall(upstream)[1].body)).qasm).toBe(padded)
  })

  it('passes an upstream error status and detail straight through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: 'shots must be between 1 and 20000.' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
      )
    )

    const response = await estimatePOST(
      jsonRequest('http://app.test/api/hardware/estimate', {
        backend: 'ibm_brisbane',
        shots: 10,
        qasm: QASM,
      })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      detail: 'shots must be between 1 and 20000.',
    })
  })

  it('reports an unreachable upstream as offline, not as a server error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
    )

    const response = await devicesGET(getRequest('http://app.test/api/hardware/devices'))
    const body = (await response.json()) as { offline?: boolean; detail?: string }

    // The hardware page keys off `offline` to show "start the API with …"
    // instead of an error toast. Losing that flag is a UX regression, not a
    // cosmetic one.
    expect(response.status).toBe(504)
    expect(body.offline).toBe(true)
    expect(body.detail).toBe(`Could not reach ${UPSTREAM}.`)
  })

  // The Braket ARN re-encoding across the catch-all segment needs a signed-in,
  // job-owning caller to reach `forward` at all, so it is asserted in
  // lib/hardware/submitGate.test.ts alongside the ownership check.
})

describe('the shared secret', () => {
  it('is omitted when none is configured — local development is unchanged', async () => {
    const upstream = stubUpstream()

    await devicesGET(getRequest('http://app.test/api/hardware/devices'))

    const headers = upstreamCall(upstream)[1].headers as Record<string, string>
    expect(Object.keys(headers)).not.toContain(SECRET_HEADER)
  })

  it('is attached from QUANTUM_API_SECRET when set', async () => {
    process.env.QUANTUM_API_SECRET = 'a-very-secret-value'
    const upstream = stubUpstream()

    await devicesGET(getRequest('http://app.test/api/hardware/devices'))

    const headers = upstreamCall(upstream)[1].headers as Record<string, string>
    expect(headers[SECRET_HEADER]).toBe('a-very-secret-value')
  })

  it('also accepts API_SHARED_SECRET, which docker compose hands to both services', async () => {
    process.env.API_SHARED_SECRET = 'compose-value'
    const upstream = stubUpstream()

    // Driven through `estimate` rather than `submit`: submit requires a
    // verified caller now, and this test is about the variable name, not the
    // gate. lib/hardware/submitGate.test.ts asserts the secret on the submit
    // path — and asserts it is NOT attached when a gate refuses.
    await estimatePOST(
      jsonRequest('http://app.test/api/hardware/estimate', {
        qasm: QASM,
        backend: 'ibm_brisbane',
        shots: 100,
      })
    )

    const headers = upstreamCall(upstream)[1].headers as Record<string, string>
    expect(headers[SECRET_HEADER]).toBe('compose-value')
  })

  it('never relays a caller-supplied secret header', async () => {
    const upstream = stubUpstream()
    const request = new Request('http://app.test/api/hardware/devices', {
      headers: { [SECRET_HEADER]: 'attacker-guess', 'x-forwarded-for': '203.0.113.9' },
    })

    await devicesGET(request)

    const headers = upstreamCall(upstream)[1].headers as Record<string, string>
    expect(headers[SECRET_HEADER]).toBeUndefined()
  })
})

describe('validation at the edge', () => {
  async function detailOf(response: Response): Promise<string> {
    return ((await response.json()) as { detail: string }).detail
  }

  it('refuses a body that is not an object', async () => {
    stubUpstream()
    const response = await estimatePOST(jsonRequest('http://app.test/api/hardware/estimate', [1, 2]))
    expect(response.status).toBe(400)
    expect(await detailOf(response)).toContain('JSON object')
  })

  it('refuses shots outside the upstream bound before spending a round trip', async () => {
    const upstream = stubUpstream()
    const response = await estimatePOST(
      jsonRequest('http://app.test/api/hardware/estimate', {
        qasm: QASM,
        backend: 'ibm_brisbane',
        shots: 20_001,
      })
    )
    expect(response.status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('refuses an oversized circuit before spending a round trip', async () => {
    const upstream = stubUpstream()
    const response = await estimatePOST(
      jsonRequest('http://app.test/api/hardware/estimate', {
        qasm: 'x'.repeat(200_000),
        backend: 'ibm_brisbane',
        shots: 10,
      })
    )
    // The body itself is over the byte cap, so it is refused while being read.
    expect(response.status).toBe(413)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('refuses an optimization level Qiskit does not have', async () => {
    stubUpstream()
    const response = await transpilePOST(
      jsonRequest('http://app.test/api/hardware/transpile', {
        qasm: QASM,
        backend: 'ibm_brisbane',
        optimization_level: 9,
      })
    )
    expect(response.status).toBe(400)
    expect(await detailOf(response)).toContain('optimization_level')
  })

  it('refuses an unknown provider rather than letting it reach the dispatcher', async () => {
    const upstream = stubUpstream()
    const response = await jobGET(getRequest('http://app.test/api/hardware/job/rigetti/x'), {
      params: Promise.resolve({ provider: 'rigetti', jobId: ['x'] }),
    })
    expect(response.status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('accepts azure, which the upstream dispatcher has always handled', async () => {
    // This test used to use 'azure' as its EXAMPLE of an unknown provider, and
    // it passed — which was the bug, not the contract. `submit_job()` and
    // `poll_job()` in services/api dispatch on 'azure', `BACKEND_PROVIDER` maps
    // azure_quantinuum_h1 and azure_ionq_aria onto it, and the device picker
    // offers both. Only these two proxy routes disagreed, so a job submitted to
    // a Quantinuum target was stamped with provider 'azure' and could then
    // never be polled back: this route refused it with a 400 before the
    // ownership check ever ran.
    //
    // It gets past the provider check now and stops at the ownership check
    // instead, which with no usage store configured answers 503 — the point
    // being that it is no longer a 400, and no longer stops here.
    const upstream = stubUpstream()
    const response = await jobGET(getRequest('http://app.test/api/hardware/job/azure/x'), {
      params: Promise.resolve({ provider: 'azure', jobId: ['x'] }),
    })
    expect(response.status).not.toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('refuses a traversal attempt in the catch-all job id', async () => {
    const upstream = stubUpstream()
    // Decoded `..` segments are how a catch-all proxy gets aimed at
    // /api/circuits/run, which this proxy deliberately does not expose.
    const response = await jobGET(getRequest('http://app.test/api/hardware/job/ibm/x'), {
      params: Promise.resolve({ provider: 'ibm', jobId: ['..', '..', 'circuits', 'run'] }),
    })
    expect(response.status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })
})

describe('rate limiting the proxy', () => {
  it('leaves a caller under the limit alone', async () => {
    const upstream = stubUpstream()
    for (let i = 0; i < 5; i += 1) {
      const response = await devicesGET(
        getRequest('http://app.test/api/hardware/devices', '198.51.100.1')
      )
      expect(response.status).toBe(200)
    }
    expect(upstream).toHaveBeenCalledTimes(5)
  })

  it('answers 429 with Retry-After once submit is over its limit', async () => {
    const upstream = stubUpstream({ job_id: 'j' })
    const body = { qasm: QASM, backend: 'ibm_brisbane', shots: 100 }

    // The IP limiter runs FIRST, before the identity check, so that an
    // anonymous flood cannot be turned into load against our own auth service.
    // Five anonymous attempts are each refused 401; the sixth never gets that
    // far. Either way nothing reaches IBM or Braket.
    for (let i = 0; i < 5; i += 1) {
      const refusedByAuth = await submitPOST(
        jsonRequest('http://app.test/api/hardware/submit', body, '198.51.100.2')
      )
      expect(refusedByAuth.status).toBe(401)
    }
    const refused = await submitPOST(
      jsonRequest('http://app.test/api/hardware/submit', body, '198.51.100.2')
    )

    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('does not let one caller exhaust another caller', async () => {
    stubUpstream({ job_id: 'j' })
    const body = { qasm: QASM, backend: 'ibm_brisbane', shots: 100 }
    for (let i = 0; i < 6; i += 1) {
      await submitPOST(jsonRequest('http://app.test/api/hardware/submit', body, '198.51.100.3'))
    }

    // A different address still has its own allowance: it gets as far as the
    // identity check (401) rather than being refused as rate-limited (429).
    const other = await submitPOST(
      jsonRequest('http://app.test/api/hardware/submit', body, '198.51.100.4')
    )
    expect(other.status).toBe(401)
  })

  it('says nothing in the 429 body about which key or count it refused', async () => {
    stubUpstream({ job_id: 'j' })
    const body = { qasm: QASM, backend: 'ibm_brisbane', shots: 100 }
    for (let i = 0; i < 6; i += 1) {
      await submitPOST(jsonRequest('http://app.test/api/hardware/submit', body, '198.51.100.5'))
    }
    const refused = await submitPOST(
      jsonRequest('http://app.test/api/hardware/submit', body, '198.51.100.5')
    )

    const text = await refused.text()
    expect(text).toBe('{"detail":"Too many requests. Wait a moment and try again."}')
  })

  it('refuses an anonymous poll of a job status without reaching upstream', async () => {
    const upstream = stubUpstream({ status: 'COMPLETED' })

    const response = await jobGET(getRequest('http://app.test/api/hardware/job/ibm/j'), {
      params: Promise.resolve({ provider: 'ibm', jobId: ['j'] }),
    })

    expect(response.status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()
  })

})
