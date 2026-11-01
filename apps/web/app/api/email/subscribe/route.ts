/**
 * /api/email/subscribe — signup and confirmation for the 7-day email course.
 *
 *   POST { email }   → store an UNCONFIRMED consent row, mail a confirm link.
 *   GET  ?token=…    → the click on that link; stamps confirmed_at.
 *
 * This route exists because docs/ONBOARDING.md refuses lifecycle email until
 * a consent record exists. It is prerequisite 1. It is NOT a sender of course
 * content — prerequisite 3 (a scheduler) still does not exist, and the only
 * message this route ever causes is the one confirm mail, to the address that
 * was just submitted, carrying only URLs built from this app's own origin.
 *
 * Read app/api/email/route.ts's header before touching this file: that route
 * was holed twice (MAIL-1, then the recipient hole) by values from the request
 * reaching an inbox. The rules inherited from those fixes:
 *
 *   • No caller-supplied URL ever enters a template. The confirm and
 *     unsubscribe links are built HERE from APP_URL. There is no parameter to
 *     validate because there is no parameter.
 *   • The recipient is the submitted address itself, and the only thing it can
 *     ever be sent is "did you ask for this?". Anyone can submit anyone's
 *     address — that is inherent to a signup form — so the mail must be
 *     harmless-to-strangers by construction, and the rate limit (tighter than
 *     /api/email's) bounds how annoying a griefer can be per IP.
 *   • The response NEVER reveals whether an address was already subscribed:
 *     an already-confirmed signup sends nothing but answers identically, so
 *     this endpoint is not an address-probing oracle and not a primitive for
 *     re-mailing confirmed subscribers.
 */

import { NextResponse } from 'next/server'
import { sendEmail } from '@/lib/email/client'
import { confirmSubscription } from '@/lib/email/templates'
import {
  SubscriptionStoreUnavailableError,
  beginSubscription,
  confirmSubscriptionByToken,
} from '@/lib/email/subscriptions'
import { APP_URL } from '@/lib/billing/stripe'
import { email as validEmail, readJsonBody, isRecord } from '@/lib/security/validate'
import { callerKey, rateLimit, retryAfterHeaders } from '@/lib/rateLimit'
import type { ApiErrorBody } from '@/lib/apiError'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Tighter than /api/email's 5/minute: a signup form is submitted once per
// human, and every accepted POST is an outbound mail wearing the app's
// sending reputation, addressed to someone who may not have asked.
const MAX_PER_MINUTE = 3
const MAX_PER_DAY = 10
/** Confirm mails any one mailbox may be sent per day, from any number of callers. */
const MAX_PER_ADDRESS_PER_DAY = 2

/** The identical body for every accepted POST — see the header for why. */
const ACCEPTED = {
  ok: true as const,
  message:
    'If that address can receive mail from us, a confirmation link is on its way. ' +
    'Nothing is sent until you click it.',
}

function bad(error: string): NextResponse {
  const body: ApiErrorBody = { error, code: 'bad_request' }
  return NextResponse.json(body, { status: 400 })
}

function unavailable(): NextResponse {
  const body: ApiErrorBody = {
    error: 'The subscription store is unreachable. Nothing was recorded; try again later.',
    code: 'upstream_unavailable',
  }
  return NextResponse.json(body, { status: 503 })
}

export async function POST(request: Request): Promise<NextResponse> {
  const key = callerKey(request.headers, 'email-subscribe')
  const minute = await rateLimit(key, { limit: MAX_PER_MINUTE, windowMs: 60_000 })
  const day = minute.allowed
    ? await rateLimit(key, { limit: MAX_PER_DAY, windowMs: 86_400_000 })
    : minute
  if (!minute.allowed || !day.allowed) {
    // Fixed message, names no key or bucket — same rule as /api/email.
    const body: ApiErrorBody = {
      error: 'Too many signup attempts from this address. Wait a while and retry.',
      code: 'rate_limited',
    }
    return NextResponse.json(body, {
      status: 429,
      headers: retryAfterHeaders(minute.allowed ? day : minute),
    })
  }

  const parsed = await readJsonBody(request, 4_096)
  if (!parsed.ok && parsed.tooLarge) {
    const body: ApiErrorBody = { error: parsed.error, code: 'payload_too_large' }
    return NextResponse.json(body, { status: 413 })
  }
  if (!parsed.ok) return bad(parsed.error)
  if (!isRecord(parsed.value)) return bad('Expected an object of the shape { email }.')

  const address = validEmail(parsed.value.email)
  if (!address.ok) return bad(address.error)

  // Per-RECIPIENT throttle. The per-IP limits above bound one machine; they do
  // nothing about many machines aimed at one mailbox, or about someone
  // re-submitting an address that unsubscribed (a re-signup replaces the row
  // and mails a fresh confirm). The shared limiter is keyed on the address, so
  // a given mailbox gets at most MAX_PER_ADDRESS_PER_DAY confirm mails a day
  // whoever asks. Over the cap the response is the SAME ACCEPTED body and
  // nothing happens — no new token, no mail — so this is not an oracle either.
  const perAddress = await rateLimit(`email-subscribe-to:${address.value.toLowerCase()}`, {
    limit: MAX_PER_ADDRESS_PER_DAY,
    windowMs: 86_400_000,
  })
  if (!perAddress.allowed) return NextResponse.json(ACCEPTED)

  try {
    const outcome = await beginSubscription(address.value, 'course-7day')

    if (outcome.kind === 'send-confirm') {
      // Both links built from APP_URL, right here, from nothing in the
      // request. This is the MAIL-1 rule enforced by construction.
      const base = APP_URL.replace(/\/+$/, '')
      const content = confirmSubscription({
        confirmUrl: `${base}/api/email/subscribe?token=${outcome.token}`,
        unsubscribeUrl: `${base}/api/email/unsubscribe?token=${outcome.token}`,
      })
      // The send result is deliberately NOT surfaced: reporting it would make
      // the response differ between "mail attempted" and "already confirmed,
      // nothing sent", which is the oracle this route refuses to be. With no
      // provider key the message lands in the dev console (lib/email/client.ts).
      //
      // TIMING: the send is not awaited. Awaiting it made a fresh or unconfirmed
      // address answer hundreds of milliseconds slower than an already-confirmed
      // one (which sends nothing), a probe for who is subscribed. sendEmail
      // never throws, so detaching it cannot produce an unhandled rejection.
      void sendEmail({
        to: address.value,
        subject: content.subject,
        html: content.html,
        text: content.text,
      })
    }

    return NextResponse.json(ACCEPTED)
  } catch (err) {
    if (err instanceof SubscriptionStoreUnavailableError) return unavailable()
    throw err
  }
}

// ── the confirm click ───────────────────────────────────────────────────────

/**
 * A plain HTML page for a person arriving from their mail client. No JS, no
 * styles beyond a readable column, works in every client's in-app browser.
 */
function page(title: string, body: string, status = 200): NextResponse {
  const html = [
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${title} — Qubit16</title></head>`,
    '<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.6;">',
    `<h1 style="font-size:1.4rem;">${title}</h1><p>${body}</p>`,
    '</body></html>',
  ].join('')
  return new NextResponse(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

export async function GET(request: Request): Promise<NextResponse> {
  const token = new URL(request.url).searchParams.get('token')
  try {
    const outcome = await confirmSubscriptionByToken(token)
    switch (outcome) {
      case 'confirmed':
        return page(
          'You are signed up',
          'Your address is confirmed for the 7-day Qubit16 email course. ' +
            'Day 1 arrives with the next hourly send, then one lesson a day for a week. ' +
            'Every message carries a one-click unsubscribe link.'
        )
      case 'already-confirmed':
        return page('Already confirmed', 'This signup was already confirmed. Nothing changed.')
      case 'invalid':
        return page(
          'This link is not valid',
          'The confirmation link is incomplete, was already replaced by a newer signup, ' +
            'or belongs to a subscription that was unsubscribed. ' +
            'If you meant to sign up, submit the form again for a fresh link.',
          400
        )
    }
  } catch (err) {
    if (err instanceof SubscriptionStoreUnavailableError) {
      return page(
        'Temporarily unavailable',
        'We could not record your confirmation just now. Nothing was saved — ' +
          'please try the link again in a few minutes.',
        503
      )
    }
    throw err
  }
}
