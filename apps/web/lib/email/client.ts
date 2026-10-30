/**
 * email/client.ts — outbound mail, optional.
 *
 * With no RESEND_API_KEY (the default), sending is a clean, expected non-event:
 * sendEmail returns { sent: false, reason } and the caller carries on. Not
 * configuring email is a valid state, not an error, so nothing here throws and
 * nothing here logs a warning in production.
 */

import type { Resend } from 'resend'

const API_KEY = (process.env.RESEND_API_KEY ?? '').trim()

/** True only when a provider key is present. */
export const isEmailConfigured: boolean = API_KEY.length > 0

/** Resend's shared sandbox sender works with no domain verification. */
export const FROM_ADDRESS: string =
  (process.env.EMAIL_FROM ?? '').trim() || 'Qubit16 <onboarding@resend.dev>'

const isDevelopment = process.env.NODE_ENV === 'development'

/**
 * `retryable` is set ONLY when the provider DEFINITIVELY did not accept the
 * message and a later attempt is expected to work (HTTP 429, or a 5xx). A
 * thrown/network error is deliberately not marked: the request may have
 * reached the provider, so retrying it could deliver the message twice.
 */
export type SendResult =
  | { sent: true; id: string }
  | { sent: false; reason: string; retryable?: boolean }

const RETRYABLE_ERROR_NAMES = new Set([
  'rate_limit_exceeded',
  'daily_quota_exceeded',
  'application_error',
  'internal_server_error',
])

function isRetryableProviderError(error: { name?: unknown; statusCode?: unknown }): boolean {
  const status = typeof error.statusCode === 'number' ? error.statusCode : null
  if (status !== null) return status === 429 || status >= 500
  return typeof error.name === 'string' && RETRYABLE_ERROR_NAMES.has(error.name)
}

export interface SendEmailInput {
  to: string
  subject: string
  html: string
  text: string
}

/**
 * The one `reason` a route may echo verbatim: it is this app's own copy, names
 * no provider state, and is what the zero-config developer flow reads. Every
 * other reason is a provider or network message for the server log only — see
 * POST /api/email.
 */
export const NOT_CONFIGURED_REASON =
  'Email is not configured; set RESEND_API_KEY to send messages. ' +
  'The message was not delivered.'

let client: Resend | null = null

/**
 * Construct the Resend client lazily, once. Importing `resend` at module scope
 * would pull the SDK into every bundle that touches this file even when email is
 * off, and constructing it eagerly would run provider code at import time.
 */
async function getClient(): Promise<Resend | null> {
  if (!isEmailConfigured) return null
  if (client) return client
  try {
    const { Resend: ResendCtor } = await import('resend')
    client = new ResendCtor(API_KEY)
  } catch {
    client = null
  }
  return client
}

/**
 * Print the message that would have been sent.
 *
 * This is the single most useful thing this module does locally. A developer
 * with no Resend account still needs to click the invite link, verify the magic
 * link, and read the copy — so in development the whole message goes to the
 * console, plain-text part included, and the flow stays end-to-end testable with
 * an empty environment. Development only: never in production, where the body
 * would land in a log aggregator.
 */
function logToConsole(input: SendEmailInput): void {
  if (!isDevelopment) return
  console.info(
    [
      '',
      '──────── email (not sent — no RESEND_API_KEY) ────────',
      `from:    ${FROM_ADDRESS}`,
      `to:      ${input.to}`,
      `subject: ${input.subject}`,
      '',
      input.text,
      '──────────────────────────────────────────────────────',
      '',
    ].join('\n')
  )
}

function isPlausibleRecipient(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) &&
    value.trim().length <= 254
  )
}

/**
 * Send one message. Never throws: a provider outage, a network failure or a
 * rejected payload all come back as { sent: false, reason } so a route handler
 * can report the outcome instead of turning it into a 500.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendResult> {
  if (!isPlausibleRecipient(input.to)) {
    return { sent: false, reason: 'That does not look like an email address.' }
  }
  if (!input.subject || !input.html || !input.text) {
    return { sent: false, reason: 'A message needs a subject and both HTML and text bodies.' }
  }

  if (!isEmailConfigured) {
    logToConsole(input)
    return { sent: false, reason: NOT_CONFIGURED_REASON }
  }

  const resend = await getClient()
  if (!resend) {
    return { sent: false, reason: 'The email provider client could not be created.' }
  }

  try {
    const result = await resend.emails.send({
      from: FROM_ADDRESS,
      to: input.to.trim(),
      subject: input.subject,
      html: input.html,
      text: input.text,
    })

    if (result.error) {
      return {
        sent: false,
        reason: result.error.message || 'The email provider rejected the message.',
        ...(isRetryableProviderError(result.error) ? { retryable: true } : {}),
      }
    }
    if (!result.data?.id) {
      return { sent: false, reason: 'The email provider returned no message id.' }
    }
    return { sent: true, id: result.data.id }
  } catch (err) {
    // A provider outage must not propagate into a route handler.
    const reason = err instanceof Error ? err.message : 'The email provider was unreachable.'
    return { sent: false, reason }
  }
}
