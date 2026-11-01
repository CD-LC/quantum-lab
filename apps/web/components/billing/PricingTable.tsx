'use client'

/**
 * PricingTable — the four tiers, a period toggle, and an honest comparison grid.
 *
 * There is no Stripe SDK in this file on purpose. The browser only ever POSTs to
 * our own /api/billing/checkout and follows the URL it hands back, so the secret
 * key never has to exist client-side. When billing is not configured at all —
 * the default for a local checkout of this repo — the route says so, and we
 * render that as a matter-of-fact note rather than a failure.
 */

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PLANS,
  formatLimit,
  formatPrice,
  yearlySavingPercent,
  type BillingPeriod,
  type Plan,
  type PlanId,
} from '@/lib/plans'
import { TrackedPage } from '@/components/analytics/TrackedPage'
import { Button } from '@/components/ui/button'
import { track } from '@/lib/analytics/track'
import { authFetch } from '@/lib/authFetch'
import { isSupabaseConfigured } from '@/lib/supabase'
import { CONTACT_EMAIL } from '@/lib/legal'

const SALES_EMAIL = CONTACT_EMAIL

const VIOLET_PILL = { color: 'var(--q-violet-text)', background: 'rgb(var(--q-violet-rgb) / 0.16)' }
const TEAL_PILL = { color: 'var(--q-teal-text)', background: 'rgb(var(--q-teal-rgb) / 0.16)' }

type CtaState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'notice'; message: string }
  | { kind: 'error'; message: string }

interface CheckoutResponse {
  url?: string
  configured?: boolean
  message?: string
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readCheckoutResponse(body: unknown): CheckoutResponse {
  if (!isRecord(body)) return {}
  return {
    url: typeof body.url === 'string' ? body.url : undefined,
    configured: typeof body.configured === 'boolean' ? body.configured : undefined,
    message: typeof body.message === 'string' ? body.message : undefined,
    error: typeof body.error === 'string' ? body.error : undefined,
  }
}

const NOT_CONFIGURED_FALLBACK =
  'Billing is not configured in this environment, so there is no checkout to send you to. Everything on the Free plan works exactly as it will in production.'

export function PricingTable({
  currentPlanId,
  userId,
  email,
  launchTrialDays = 0,
}: {
  currentPlanId?: PlanId
  userId?: string
  email?: string
  /**
   * > 0 while the launch-period policy is on (lib/billing/launchTrial.ts):
   * paid cards then offer sign-in instead of checkout, because checkout would
   * charge for something every new account already has.
   */
  launchTrialDays?: number
}) {
  const [period, setPeriod] = useState<BillingPeriod>('monthly')

  return (
    <section>
      {/* Plan id only — never the userId or email this component also receives. */}
      <TrackedPage event="upgrade.viewed" props={{ currentPlan: currentPlanId ?? 'none' }} />

      <PeriodToggle period={period} onChange={setPeriod} />

      <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {PLANS.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            period={period}
            currentPlanId={currentPlanId}
            userId={userId}
            email={email}
            launchTrialDays={launchTrialDays}
          />
        ))}
      </div>

      <ComparisonTable />
    </section>
  )
}

function PeriodToggle({
  period,
  onChange,
}: {
  period: BillingPeriod
  onChange: (p: BillingPeriod) => void
}) {
  const options: { value: BillingPeriod; label: string }[] = [
    { value: 'monthly', label: 'Monthly' },
    { value: 'yearly', label: 'Yearly' },
  ]
  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
      <div
        role="group"
        aria-label="Billing period"
        className="flex gap-1 rounded-lg border border-line bg-surface-2 p-1"
      >
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            aria-pressed={period === opt.value}
            onClick={() => onChange(opt.value)}
            className={`focus-ring rounded-md px-4 py-1.5 text-xs font-semibold transition-colors ${
              period === opt.value
                ? 'text-white'
                : 'text-ink-muted hover:bg-surface-3 hover:text-ink-secondary'
            }`}
            style={period === opt.value ? { backgroundColor: 'var(--q-violet-strong)' } : undefined}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <span className="text-[13px] text-ink-muted">
        {period === 'yearly' ? 'Two months free on every paid plan.' : 'Cancel any time.'}
      </span>
    </div>
  )
}

function PlanCard({
  plan,
  period,
  currentPlanId,
  userId,
  email,
  launchTrialDays = 0,
}: {
  plan: Plan
  period: BillingPeriod
  currentPlanId?: PlanId
  userId?: string
  email?: string
  launchTrialDays?: number
}) {
  const [state, setState] = useState<CtaState>({ kind: 'idle' })

  /**
   * Hand a subscriber to Stripe's customer portal to change plan.
   *
   * Checkout makes a NEW subscription, so for an account that already has one
   * the route answers 409 and this is where that lands: the portal switches the
   * one subscription (prorated) instead of billing a second one. See
   * docs/BILLING.md §2.
   */
  const openPortal = useCallback(async () => {
    try {
      const response = await authFetch('/api/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId }),
      })
      const parsed = readCheckoutResponse(await response.json().catch(() => null))
      if (parsed.url) {
        window.location.assign(parsed.url)
        return
      }
      setState({
        kind: parsed.error ? 'error' : 'notice',
        message: parsed.error ?? parsed.message ?? NOT_CONFIGURED_FALLBACK,
      })
    } catch {
      setState({ kind: 'notice', message: NOT_CONFIGURED_FALLBACK })
    }
  }, [userId])

  const startCheckout = useCallback(async () => {
    // Before the fetch on purpose: intent is the number worth having, so an
    // abandoned, failed or unconfigured checkout still counts.
    track('upgrade.started', { planId: plan.id, period })
    setState({ kind: 'pending' })
    try {
      // SECURITY: when a userId is sent, /api/billing/checkout requires it to
      // be the caller's own — it becomes the Stripe metadata the webhook trusts.
      const response = await authFetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planId: plan.id, period, userId, email }),
      })
      const parsed = readCheckoutResponse(await response.json().catch(() => null))

      if (parsed.configured === false) {
        setState({ kind: 'notice', message: parsed.message ?? NOT_CONFIGURED_FALLBACK })
        return
      }
      if (response.status === 409) {
        // Already subscribed: change the plan on the existing subscription.
        await openPortal()
        return
      }
      if (parsed.error) {
        setState({ kind: 'error', message: parsed.error })
        return
      }
      if (parsed.url) {
        window.location.assign(parsed.url)
        return
      }
      if (!response.ok) {
        setState({ kind: 'notice', message: NOT_CONFIGURED_FALLBACK })
        return
      }
      setState({ kind: 'error', message: 'Checkout did not return a URL. Try again in a moment.' })
    } catch {
      setState({ kind: 'notice', message: NOT_CONFIGURED_FALLBACK })
    }
  }, [plan.id, period, userId, email, openPortal])

  const isCurrent = currentPlanId === plan.id
  const saving = yearlySavingPercent(plan)
  const priceCents = plan.price[period]
  const suffix = period === 'monthly' ? '/month' : '/year'
  const showSuffix = priceCents > 0

  return (
    <div
      className={`card relative flex flex-col p-5 ${
        plan.featured
          ? 'ring-1 ring-q-violet lg:scale-[1.03] lg:z-10 border-q-violet/40'
          : 'card-hover'
      }`}
    >
      {plan.featured ? (
        <span
          className="pill absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap"
          style={VIOLET_PILL}
        >
          Most popular
        </span>
      ) : null}

      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-base font-bold text-ink">{plan.name}</h3>
        {period === 'yearly' && saving > 0 ? (
          <span className="pill" style={TEAL_PILL}>
            save {saving}%
          </span>
        ) : null}
      </div>

      <p className="mt-1.5 min-h-[40px] text-[13px] text-ink-secondary">{plan.tagline}</p>

      <p className="mt-4 flex items-baseline gap-1.5">
        <span className="text-2xl font-bold text-ink">
          {plan.contactSales && priceCents === 0 ? 'Custom' : formatPrice(priceCents)}
        </span>
        {showSuffix ? <span className="text-[13px] text-ink-muted">{suffix}</span> : null}
      </p>

      <ul className="mt-4 flex-1 space-y-2">
        {plan.highlights.map((highlight) => (
          <li key={highlight} className="flex gap-2 text-[13px] text-ink-secondary">
            <span aria-hidden="true" className="mt-[1px] text-q-teal-text">
              ✓
            </span>
            <span>{highlight}</span>
          </li>
        ))}
      </ul>

      {/* Arranged-by-hand capabilities get a different marker and their own
          heading. A ✓ in the same list as the self-serve bullets would read as
          "included the moment you pay", which for SSO and a bespoke lesson
          track is not true — a person has to do the work. Do not fold these
          back into `highlights`. */}
      {plan.arrangedHighlights && plan.arrangedHighlights.length > 0 ? (
        <div className="mt-4 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
            Set up with you during onboarding — not a self-serve switch
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {plan.arrangedHighlights.map((item) => (
              <li key={item} className="flex gap-2 text-[13px] text-ink-secondary">
                <span aria-hidden="true" className="mt-[1px] text-ink-muted">
                  ·
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-5">
        <PlanCta
          plan={plan}
          isCurrent={isCurrent}
          pending={state.kind === 'pending'}
          onCheckout={() => void startCheckout()}
          launchTrialDays={launchTrialDays}
          signedIn={Boolean(userId)}
          changing={Boolean(currentPlanId) && currentPlanId !== 'free'}
        />
      </div>

      {/*
        A11Y (WCAG 4.1.3). Pressing "Upgrade to Pro" either navigates to Stripe
        or renders one of these two paragraphs, and focus stays on the button
        either way. Without a live role a screen-reader user pressed the CTA,
        the page appeared not to react, and the explanation — "billing is not
        configured in this environment" — was on screen but unread. The button's
        own label going "Redirecting…" → "Upgrade to Pro" is not a substitute:
        that reads as the action having been undone.
      */}
      {state.kind === 'notice' ? (
        <p
          role="status"
          className="mt-3 rounded-lg border border-q-amber/30 px-3 py-2 text-[12px] leading-relaxed"
          style={{ color: 'var(--q-amber-text)', background: 'rgb(var(--q-amber-rgb) / 0.10)' }}
        >
          {state.message}
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <p role="alert" className="mt-3 text-[12px] leading-relaxed text-q-rose-text">
          {state.message}
        </p>
      ) : null}
    </div>
  )
}

function PlanCta({
  plan,
  isCurrent,
  pending,
  onCheckout,
  launchTrialDays = 0,
  signedIn = false,
  changing = false,
}: {
  plan: Plan
  isCurrent: boolean
  pending: boolean
  onCheckout: () => void
  launchTrialDays?: number
  signedIn?: boolean
  /** The viewer is already on a paid plan: this is a switch, not a purchase. */
  changing?: boolean
}) {
  if (isCurrent) {
    return (
      <Button type="button" variant="secondary" className="w-full" disabled>
        Current plan
      </Button>
    )
  }

  // Launch trial: a self-serve paid plan is already included with any new
  // account, so the only honest CTA is sign-in. A signed-in visitor who still
  // sees this card is not on the plan (an older account, or the trial ended);
  // checkout stays available to them. Team/edu keep "Talk to us".
  if (launchTrialDays > 0 && plan.id === 'pro' && !signedIn) {
    return (
      <Button asChild className="w-full">
        <Link href="/account?next=%2Fpricing">Free for {launchTrialDays} days — sign in</Link>
      </Button>
    )
  }

  if (plan.contactSales) {
    return (
      <Button asChild variant="secondary" className="w-full">
        <a
          href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent(
            `Qubit16 ${plan.name} plan`
          )}`}
        >
          Talk to us
        </a>
      </Button>
    )
  }

  if (plan.id === 'free') {
    return (
      <Button asChild variant="secondary" className="w-full">
        <Link href="/simulator">Get started</Link>
      </Button>
    )
  }

  // With accounts on, a plan has to belong to an account: checkout refuses a
  // signed-out caller (a payment with no user id could never be attributed —
  // the customer was charged and stayed on Free). Sign in first, then back here.
  if (isSupabaseConfigured && !signedIn) {
    return (
      <Button asChild className="w-full">
        <Link href="/account?next=%2Fpricing">Sign in to upgrade</Link>
      </Button>
    )
  }

  return (
    <Button type="button" className="w-full" disabled={pending} onClick={onCheckout}>
      {pending ? 'Redirecting…' : changing ? `Change to ${plan.name}` : `Upgrade to ${plan.name}`}
    </Button>
  )
}

const COMPARISON_ROWS: { label: string; value: (plan: Plan) => string }[] = [
  { label: 'Max qubits', value: (p) => formatLimit(p.limits.maxQubits) },
  { label: 'Saved circuits', value: (p) => formatLimit(p.limits.maxSavedCircuits) },
  { label: 'Hardware jobs / month', value: (p) => formatLimit(p.limits.hardwareJobsPerMonth) },
  { label: 'Tutor messages / day', value: (p) => formatLimit(p.limits.tutorMessagesPerDay) },
  { label: 'Seats', value: (p) => formatLimit(p.limits.seats) },
]

function ComparisonTable() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  // RESPONSIVE: at 390px the table (min-w-[560px]) overflows its card, but
  // nothing said so — no scrollbar on touch, and a header row that just ends
  // mid-column doesn't read as "more content" the way a cut-off sentence
  // does. This measures the real overflow (rather than assuming one) and
  // drives two edge fades plus a hint that only shows while there's
  // somewhere left to scroll to.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const update = () => {
      setCanScrollLeft(el.scrollLeft > 4)
      setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4)
    }

    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener('resize', update)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  return (
    <div className="card mt-10 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-[13px] font-semibold text-ink-secondary">What the limits actually are</h3>
        {canScrollRight ? (
          <span aria-hidden="true" className="text-[11px] font-medium text-ink-muted">
            Scroll for more plans →
          </span>
        ) : null}
      </div>

      <div className="relative mt-4">
        <div ref={scrollRef} className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <caption className="sr-only">Plan limits compared</caption>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="pb-2 text-[11px] font-bold uppercase tracking-wider text-ink-muted"
                >
                  Limit
                </th>
                {PLANS.map((plan) => (
                  <th
                    key={plan.id}
                    scope="col"
                    className="pb-2 text-[11px] font-bold uppercase tracking-wider text-ink-muted"
                  >
                    {plan.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARISON_ROWS.map((row) => (
                <tr key={row.label} className="border-t border-line">
                  <th scope="row" className="py-2.5 pr-4 text-[13px] font-normal text-ink-secondary">
                    {row.label}
                  </th>
                  {PLANS.map((plan) => (
                    <td key={plan.id} className="py-2.5 pr-4 font-mono text-[13px] text-ink">
                      {row.value(plan)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Edge fades over the card's own background colour, not the page's —
            the scroller sits inside `.card` (bg-surface), so fading to
            `var(--bg)` would show a seam. Same gradient shape used by the
            histogram tooltip's edge-pinning comment elsewhere in the app;
            no prior fade/gradient scroll affordance existed to reuse, so
            this one is intentionally minimal (a plain surface→transparent
            fade) rather than inventing a new visual motif. */}
        {canScrollLeft ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-surface to-transparent"
          />
        ) : null}
        {canScrollRight ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface to-transparent"
          />
        ) : null}
      </div>
    </div>
  )
}

export default PricingTable
