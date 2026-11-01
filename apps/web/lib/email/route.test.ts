/**
 * /api/email — who may send, and to whom.
 *
 * This route has been holed twice by treating "the template set is closed" as
 * if it meant "this is safe to expose". These tests exist so the third time is
 * caught here instead of in an inbox:
 *
 *   1. an anonymous caller cannot send anything at all;
 *   2. an authenticated caller cannot send to somebody else's address;
 *   3. the recipient is compared against the address SUPABASE returned for the
 *      token, never against anything in the request body.
 *
 * Every test below fails if the gate is deleted. `sendEmail` is mocked so a
 * pass/fail is decided by whether delivery was ATTEMPTED, not by whether this
 * container happens to have a provider key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetRateLimitForTests } from '@/lib/rateLimit'

interface SentMessage {
  to: string
  subject: string
  html: string
  text: string
}
type Caller = { id: string; email: string } | null

const sendEmail = vi.fn(
  async (_input: SentMessage): Promise<{ sent: true; id: string } | { sent: false; reason: string }> => ({
    sent: true,
    id: 'msg_test',
  })
)
const verifiedCaller = vi.fn(async (_req: Request): Promise<Caller> => null)

vi.mock('@/lib/email/client', () => ({
  sendEmail: (input: SentMessage) => sendEmail(input),
  isEmailConfigured: true,
  NOT_CONFIGURED_REASON: 'Email is not configured; set RESEND_API_KEY to send messages. The message was not delivered.',
  FROM_ADDRESS: 'Qubit16 <test@example.com>',
}))

vi.mock('@/lib/security/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security/auth')>(
    '@/lib/security/auth'
  )
  return { ...actual, verifiedCaller: (req: Request) => verifiedCaller(req) }
})

const { POST } = await import('@/app/api/email/route')

/** Each test gets its own IP so the shared per-minute limiter never bleeds. */
let ipCounter = 0
function post(body: unknown): Request {
  ipCounter += 1
  return new Request('http://app.test/api/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `198.51.100.${ipCounter}`,
      authorization: 'Bearer test-token',
    },
    body: JSON.stringify(body),
  })
}

const WELCOME = { type: 'welcome', to: 'learner@example.com', data: { name: 'Ada' } }

beforeEach(() => {
  __resetRateLimitForTests()
  sendEmail.mockClear()
  verifiedCaller.mockReset()
  verifiedCaller.mockResolvedValue(null)
})

afterEach(() => {
  __resetRateLimitForTests()
})

describe('POST /api/email', () => {
  it('does not echo the provider’s own error text to the caller', async () => {
    verifiedCaller.mockResolvedValue({ id: 'u1', email: 'learner@example.com' })
    sendEmail.mockResolvedValueOnce({ sent: false, reason: 'API key is invalid' })

    const response = await POST(post(WELCOME))
    const body = await response.json()

    expect(body.sent).toBe(false)
    expect(JSON.stringify(body)).not.toContain('API key')
    expect(body.reason).toBe('The message could not be sent right now.')
  })

  it('still reports the app’s own not-configured copy', async () => {
    verifiedCaller.mockResolvedValue({ id: 'u1', email: 'learner@example.com' })
    sendEmail.mockResolvedValueOnce({
      sent: false,
      reason: 'Email is not configured; set RESEND_API_KEY to send messages. The message was not delivered.',
    })

    const body = await (await POST(post(WELCOME))).json()
    expect(body.reason).toMatch(/not configured/)
  })

  it('refuses an anonymous caller and sends nothing', async () => {
    const response = await POST(post(WELCOME))

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ sent: false, code: 'unauthorized' })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('refuses to mail an address that is not the caller’s own', async () => {
    verifiedCaller.mockResolvedValue({ id: 'u1', email: 'someone.else@example.com' })

    const response = await POST(post(WELCOME))

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ sent: false, code: 'forbidden' })
    // The whole point: no message left the building for a stranger.
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('sends to the caller’s own verified address', async () => {
    verifiedCaller.mockResolvedValue({ id: 'u1', email: 'learner@example.com' })

    const response = await POST(post(WELCOME))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ sent: true })
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(sendEmail.mock.calls[0]?.[0]).toMatchObject({ to: 'learner@example.com' })
  })

  it('matches the address case-insensitively and ignoring surrounding space', async () => {
    verifiedCaller.mockResolvedValue({ id: 'u1', email: 'learner@example.com' })

    const response = await POST(post({ ...WELCOME, to: '  LEARNER@Example.COM ' }))

    expect(response.status).toBe(200)
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('refuses when the account has no email at all', async () => {
    verifiedCaller.mockResolvedValue({ id: 'u1', email: '' })

    const response = await POST(post(WELCOME))

    expect(response.status).toBe(403)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('still refuses an off-site link even for a legitimate caller (MAIL-1)', async () => {
    verifiedCaller.mockResolvedValue({ id: 'u1', email: 'learner@example.com' })

    const response = await POST(
      post({
        type: 'magic-link',
        to: 'learner@example.com',
        data: { url: 'https://phish.example.net/login' },
      })
    )

    expect(response.status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
