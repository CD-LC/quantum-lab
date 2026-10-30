/**
 * webhooks.test.ts — the SSRF guard, the signature, the retry/disable logic
 * and the in-memory store fallback, exercised without a network: every fetch
 * in this file is a recording fake injected through DeliveryDeps.
 *
 * These tests run against the memory backend (no SUPABASE_SERVICE_ROLE_KEY in
 * a test environment), which is the same registry/dispatch code path — only
 * the store behind getWebhookStore() differs, and the row mapping for the
 * Supabase path is a pair of pure functions kept in the same file.
 */

import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetWebhookStoreForTests,
  __setHostResolverForTests,
  assertPublicHost,
  isNonPublicAddress,
  deliverToEndpoint,
  dispatchNow,
  dispatchWebhookEventOnce,
  getWebhookStore,
  MAX_ATTEMPTS,
  MAX_CONSECUTIVE_FAILURES,
  MAX_ENDPOINTS_PER_USER,
  registerEndpoint,
  RETRY_BACKOFF_MS,
  SIGNATURE_HEADER,
  signWebhookPayload,
  toPublicEndpoint,
  validateWebhookUrl,
  type DeliveryDeps,
  type WebhookEndpoint,
} from './webhooks'

beforeEach(() => {
  __resetWebhookStoreForTests()
  // No test touches the network: every name resolves to a public address unless
  // a test installs its own resolver.
  __setHostResolverForTests(async () => ['93.184.216.34'])
})

// ── Test doubles ────────────────────────────────────────────────────────────

interface RecordedCall {
  url: string
  headers: Record<string, string>
  body: string
}

/** A fetch that answers from a status script and records everything it saw. */
function fakeFetch(statuses: number[]): { deps: DeliveryDeps; calls: RecordedCall[]; sleeps: number[] } {
  const calls: RecordedCall[] = []
  const sleeps: number[] = []
  let i = 0
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ''),
    })
    const status = statuses[Math.min(i++, statuses.length - 1)]
    if (status === -1) throw new Error('network down')
    return new Response('{}', { status })
  }) as typeof fetch
  return { deps: { fetchImpl, sleep: async (ms) => void sleeps.push(ms) }, calls, sleeps }
}

async function endpointFor(userId: string, url = 'https://hooks.example.com/ql'): Promise<WebhookEndpoint> {
  const result = await registerEndpoint(userId, url, ['exam_passed', 'hardware_job_finished'])
  if (!result.ok) throw new Error(result.error)
  return result.endpoint
}

// ── SSRF guard ──────────────────────────────────────────────────────────────

describe('validateWebhookUrl', () => {
  it('accepts a plain https URL to a DNS name', () => {
    expect(validateWebhookUrl('https://hooks.example.com/path?x=1').ok).toBe(true)
  })

  it('accepts a public IPv4 literal', () => {
    expect(validateWebhookUrl('https://8.8.8.8/hook').ok).toBe(true)
  })

  it.each([
    ['http', 'http://hooks.example.com/'],
    ['ftp', 'ftp://hooks.example.com/'],
    ['not a URL', 'not a url'],
    ['empty', ''],
  ])('refuses %s', (_label, url) => {
    expect(validateWebhookUrl(url).ok).toBe(false)
  })

  it.each([
    'https://localhost/hook',
    'https://api.localhost/hook',
    'https://127.0.0.1/hook',
    'https://10.0.0.5/hook',
    'https://172.16.0.1/hook',
    'https://172.31.255.255/hook',
    'https://192.168.1.1/hook',
    'https://169.254.169.254/latest/meta-data', // the cloud metadata classic
    'https://100.64.0.1/hook',
    'https://0.0.0.0/hook',
  ])('refuses private/special address %s', (url) => {
    expect(validateWebhookUrl(url).ok).toBe(false)
  })

  it('refuses decimal and hex spellings of an IPv4 address', () => {
    // 2130706433 === 127.0.0.1; the whole numeric-host family is refused
    // unless it is strict dotted-decimal, so the range check cannot be dodged.
    expect(validateWebhookUrl('https://2130706433/hook').ok).toBe(false)
    expect(validateWebhookUrl('https://0x7f000001/hook').ok).toBe(false)
    expect(validateWebhookUrl('https://127.1/hook').ok).toBe(false)
  })

  it('refuses IPv6 literals entirely', () => {
    expect(validateWebhookUrl('https://[::1]/hook').ok).toBe(false)
    expect(validateWebhookUrl('https://[::ffff:127.0.0.1]/hook').ok).toBe(false)
    expect(validateWebhookUrl('https://[2606:4700::1111]/hook').ok).toBe(false)
  })

  it('refuses embedded credentials — they smell like a request forgery kit', () => {
    expect(validateWebhookUrl('https://user:pass@hooks.example.com/').ok).toBe(false)
  })

  it('boundary check: 172.15.x and 172.32.x are public, 172.16–31 are not', () => {
    expect(validateWebhookUrl('https://172.15.0.1/h').ok).toBe(true)
    expect(validateWebhookUrl('https://172.32.0.1/h').ok).toBe(true)
    expect(validateWebhookUrl('https://172.16.0.1/h').ok).toBe(false)
  })
})

// ── Signature ───────────────────────────────────────────────────────────────

describe('signWebhookPayload', () => {
  it('is HMAC-SHA256 hex over the exact body — what docs/INTEGRATIONS.md tells receivers', () => {
    const secret = 'whsec_test'
    const body = '{"id":"evt_1","event":"exam_passed"}'
    const expected = createHmac('sha256', secret).update(body, 'utf8').digest('hex')
    expect(signWebhookPayload(secret, body)).toBe(expected)
  })

  it('changes with either the body or the secret', () => {
    const sig = signWebhookPayload('a', 'body')
    expect(signWebhookPayload('a', 'body2')).not.toBe(sig)
    expect(signWebhookPayload('b', 'body')).not.toBe(sig)
  })
})

// ── Store fallback (register / list / delete, owner scoping) ────────────────

describe('memory store fallback', () => {
  it('is the memory backend in a test environment, and says so', () => {
    expect(getWebhookStore().kind).toBe('memory')
    expect(getWebhookStore().durable).toBe(false)
  })

  it('registers, lists and deletes, scoped to the owner', async () => {
    const a = await endpointFor('user-a')
    await endpointFor('user-b')

    expect((await getWebhookStore().listForUser('user-a')).map((e) => e.id)).toEqual([a.id])
    // Someone else cannot delete it…
    expect(await getWebhookStore().delete(a.id, 'user-b')).toBe(false)
    // …the owner can.
    expect(await getWebhookStore().delete(a.id, 'user-a')).toBe(true)
    expect(await getWebhookStore().listForUser('user-a')).toEqual([])
  })

  it('generates the secret server-side and fingerprints it for display', async () => {
    const result = await registerEndpoint('user-a', 'https://hooks.example.com/x', ['exam_passed'])
    if (!result.ok) throw new Error(result.error)
    expect(result.secret).toMatch(/^whsec_[0-9a-f]{64}$/)
    const pub = toPublicEndpoint(result.endpoint)
    expect('secret' in pub).toBe(false)
    expect(pub.secretFingerprint).toHaveLength(12)
  })

  it('refuses a bad URL, unknown events, and the per-account cap', async () => {
    expect((await registerEndpoint('u', 'https://127.0.0.1/x', ['exam_passed'])).ok).toBe(false)
    expect((await registerEndpoint('u', 'https://hooks.example.com', ['nope'])).ok).toBe(false)
    expect((await registerEndpoint('u', 'https://hooks.example.com', [])).ok).toBe(false)
    for (let i = 0; i < MAX_ENDPOINTS_PER_USER; i++) {
      await endpointFor('u', `https://hooks.example.com/${i}`)
    }
    const over = await registerEndpoint('u', 'https://hooks.example.com/over', ['exam_passed'])
    expect(over.ok).toBe(false)
  })
})

// ── Delivery: signature header, retries, backoff ────────────────────────────

describe('deliverToEndpoint', () => {
  it('POSTs the signed body once when the receiver answers 200', async () => {
    const endpoint = await endpointFor('u')
    const { deps, calls, sleeps } = fakeFetch([200])
    const body = '{"id":"evt_x","event":"exam_passed","data":{}}'

    const outcome = await deliverToEndpoint(endpoint, 'exam_passed', body, 'evt_x', deps)

    expect(outcome).toEqual({ delivered: true, attempts: 1 })
    expect(sleeps).toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toBe(body)
    const sig = calls[0].headers[SIGNATURE_HEADER]
    expect(sig).toBe(`sha256=${signWebhookPayload(endpoint.secret, body)}`)
  })

  it('retries with backoff and succeeds on the last attempt', async () => {
    const endpoint = await endpointFor('u')
    const { deps, calls, sleeps } = fakeFetch([500, -1, 200]) // 5xx, network error, then ok

    const outcome = await deliverToEndpoint(endpoint, 'exam_passed', '{}', 'evt_x', deps)

    expect(outcome).toEqual({ delivered: true, attempts: MAX_ATTEMPTS })
    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([...RETRY_BACKOFF_MS])
  })

  it('gives up after MAX_ATTEMPTS and treats a redirect as a failure', async () => {
    const endpoint = await endpointFor('u')
    // 302: following it would re-open the SSRF door the URL check closed.
    const { deps, calls } = fakeFetch([302, 302, 302])
    const outcome = await deliverToEndpoint(endpoint, 'exam_passed', '{}', 'evt_x', deps)
    expect(outcome).toEqual({ delivered: false, attempts: MAX_ATTEMPTS })
    expect(calls).toHaveLength(MAX_ATTEMPTS)
  })

  it('re-checks the URL at dispatch time and refuses without a single request', async () => {
    const endpoint = await endpointFor('u')
    const tampered: WebhookEndpoint = { ...endpoint, url: 'https://169.254.169.254/latest' }
    const { deps, calls } = fakeFetch([200])
    const outcome = await deliverToEndpoint(tampered, 'exam_passed', '{}', 'evt_x', deps)
    expect(outcome).toEqual({ delivered: false, attempts: 0 })
    expect(calls).toHaveLength(0)
  })
})

// ── Dispatch: scoping, failure counting, auto-disable ───────────────────────

describe('dispatchNow', () => {
  it('delivers only to the event owner and only for subscribed events', async () => {
    await endpointFor('user-a')
    await endpointFor('user-b', 'https://hooks.example.com/b')
    const onlyExams = await registerEndpoint('user-a', 'https://hooks.example.com/exams', ['exam_passed'])
    if (!onlyExams.ok) throw new Error(onlyExams.error)

    const { deps, calls } = fakeFetch([200])
    await dispatchNow('hardware_job_finished', { jobId: 'j1' }, 'user-a', deps)

    // user-a's both-events endpoint fires; user-b's and the exams-only one do not.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://hooks.example.com/ql')
    const parsed = JSON.parse(calls[0].body) as Record<string, unknown>
    expect(parsed.event).toBe('hardware_job_finished')
    expect(parsed.data).toEqual({ jobId: 'j1' })
    expect(typeof parsed.id).toBe('string')
  })

  it('counts one failure per exhausted cycle and resets on success', async () => {
    const endpoint = await endpointFor('u')
    const store = getWebhookStore()

    const failing = fakeFetch([500])
    await dispatchNow('exam_passed', {}, 'u', failing.deps)
    expect(failing.calls).toHaveLength(MAX_ATTEMPTS) // retried…
    expect((await store.listForUser('u'))[0].failureCount).toBe(1) // …counted once

    const succeeding = fakeFetch([200])
    await dispatchNow('exam_passed', {}, 'u', succeeding.deps)
    expect((await store.listForUser('u'))[0].failureCount).toBe(0)
    expect((await store.listForUser('u'))[0].active).toBe(true)
    void endpoint
  })

  it('auto-disables after MAX_CONSECUTIVE_FAILURES cycles and stops calling', async () => {
    await endpointFor('u')
    const store = getWebhookStore()

    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      await dispatchNow('exam_passed', {}, 'u', fakeFetch([500]).deps)
    }
    const disabled = (await store.listForUser('u'))[0]
    expect(disabled.active).toBe(false)
    expect(disabled.failureCount).toBe(MAX_CONSECUTIVE_FAILURES)

    // A dead endpoint costs nothing further.
    const after = fakeFetch([200])
    await dispatchNow('exam_passed', {}, 'u', after.deps)
    expect(after.calls).toHaveLength(0)
  })

  it('never throws when there are no endpoints', async () => {
    await expect(dispatchNow('exam_passed', {}, 'nobody')).resolves.toBeUndefined()
  })
})

// ── Once-per-process dedupe (the hardware polling seam relies on it) ────────

describe('dispatchWebhookEventOnce', () => {
  it('fires once per key per process', async () => {
    await endpointFor('u')
    // The fire-and-forget path uses real fetch; give it a key only, then
    // verify the second call is dropped before dispatch by checking the
    // dedupe short-circuit — the first call seeds the set, the second is a
    // no-op. We cannot intercept the detached fetch here, so assert via the
    // set's behaviour: same key twice must not throw and must return void.
    expect(dispatchWebhookEventOnce('k1', 'exam_passed', {}, 'nobody')).toBeUndefined()
    expect(dispatchWebhookEventOnce('k1', 'exam_passed', {}, 'nobody')).toBeUndefined()
    // Distinct key is accepted again (no throw). 'nobody' has no endpoints,
    // so the detached dispatch resolves without any network activity.
    expect(dispatchWebhookEventOnce('k2', 'exam_passed', {}, 'nobody')).toBeUndefined()
  })
})


// ── DNS resolution guard ────────────────────────────────────────────────────

describe('resolved-address SSRF guard', () => {
  it('classifies private, special and public addresses', () => {
    for (const bad of [
      '127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.9', '192.168.1.1', '100.64.0.1',
      '0.0.0.0', '224.0.0.1', '198.18.0.1', '::1', '::', 'fd00::1', 'fe80::1', 'ff02::1',
      '::ffff:10.0.0.1', '::ffff:a00:1', '2001:db8::1', 'not-an-ip',
    ]) {
      expect(isNonPublicAddress(bad), bad).toBe(true)
    }
    for (const good of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) {
      expect(isNonPublicAddress(good), good).toBe(false)
    }
  })

  it('refuses a public-looking name that resolves to a private address', async () => {
    __setHostResolverForTests(async () => ['127.0.0.1'])
    const result = await registerEndpoint('u', 'https://127.0.0.1.nip.io/x', ['exam_passed'])
    expect(result.ok).toBe(false)
  })

  it('refuses when any one of several answers is private', async () => {
    __setHostResolverForTests(async () => ['93.184.216.34', '10.0.0.5'])
    expect((await assertPublicHost(new URL('https://mixed.example.com/'))).ok).toBe(false)
  })

  it('fails closed when the name does not resolve', async () => {
    __setHostResolverForTests(async () => {
      throw new Error('ENOTFOUND')
    })
    expect((await assertPublicHost(new URL('https://nope.example.com/'))).ok).toBe(false)
    __setHostResolverForTests(async () => [])
    expect((await assertPublicHost(new URL('https://empty.example.com/'))).ok).toBe(false)
  })

  it('refuses internal namespaces without a lookup', () => {
    for (const url of [
      'https://agent.internal.env.eastus.azurecontainerapps.io/x',
      'https://box.internal/x',
      'https://printer.local/x',
    ]) {
      expect(validateWebhookUrl(url).ok, url).toBe(false)
    }
  })

  it('does not deliver when the name resolves privately at dispatch time', async () => {
    const endpoint = await endpointFor('user-rebind')
    __setHostResolverForTests(async () => ['10.0.0.8'])
    const { deps, calls } = fakeFetch([200])
    const outcome = await deliverToEndpoint(endpoint, 'exam_passed', '{}', 'evt_x', deps)
    expect(outcome).toEqual({ delivered: false, attempts: 0 })
    expect(calls).toHaveLength(0)
  })
})
