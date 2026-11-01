'use client'

/**
 * Account — plan, usage, and billing, all of which work with no backend.
 *
 * Signed out and unconfigured is the default state of this deployment, so the
 * page renders the Free plan as a real answer rather than an empty shell.
 */

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import AuthPanel from '@/components/auth/AuthPanel'
import PlatformConsoleLink from '@/components/admin/PlatformConsoleLink'
import { useSession } from '@/components/auth/useSession'
import { PlanBadge } from '@/components/billing/PlanBadge'
import { useEntitlement } from '@/components/billing/useEntitlement'
import { formatLimit, type Entitlement, type Plan, type SubscriptionStatus } from '@/lib/plans'
import { authFetch } from '@/lib/authFetch'
import { startConfirmingCheckout } from '@/lib/billing/confirmCheckout'
import { ApiKeys } from '@/components/account/ApiKeys'
import { ProviderCredentials } from '@/components/account/ProviderCredentials'

/**
 * A11Y (WCAG 1.4.3): these carried the literal dark-theme hexes. Over the LIGHT
 * card surface the composites measured 1.44:1 (amber) and 1.34:1 (teal) — the
 * "your subscription is ending" warning and the "checkout complete" confirmation
 * were both unreadable in the light theme. The tokens keep the dark values
 * exactly (10.46:1 / 11.11:1) and darken in light to 7.41:1 / 7.72:1.
 */
const AMBER_BOX = { color: 'var(--q-amber-text)', background: 'rgb(var(--q-amber-rgb) / 0.10)' }
const TEAL_BOX = { color: 'var(--q-teal-text)', background: 'rgb(var(--q-teal-rgb) / 0.10)' }

const STATUS_COPY: Record<SubscriptionStatus, string> = {
  none: 'No subscription',
  trialing: 'Trial',
  active: 'Active',
  past_due: 'Payment past due',
  canceled: 'Canceled',
  incomplete: 'Setup incomplete',
}

const PORTAL_NOT_CONFIGURED =
  'Billing is not configured in this environment, so there is no customer portal to open. In a deployment with Stripe keys set, this button takes you straight to your invoices and payment method.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function formatDate(iso: string | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

export default function AccountPage() {
  const { user } = useSession()
  const { entitlement, plan, loading, billingEnabled, refresh } = useEntitlement()
  const [checkoutSuccess, setCheckoutSuccess] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('checkout') === 'success') setCheckoutSuccess(true)
  }, [])

  // Arriving back from Stripe checkout is not the same as the subscription
  // being active yet — the webhook that updates the entitlement can lag a few
  // seconds behind the redirect, or never arrive. So rather than only polling
  // the entitlement, ask the server to reconcile with Stripe and then re-read
  // it, with backoff, until the entitlement itself reports a paid plan (or the
  // schedule runs out). Never asserts "Pro" from the URL alone.
  const planIdRef = useRef(plan.id)
  useEffect(() => {
    planIdRef.current = plan.id
  }, [plan.id])
  const userId = user?.id
  useEffect(() => {
    if (!checkoutSuccess || !userId) return
    return startConfirmingCheckout({
      reconcile: async () => {
        await authFetch('/api/billing/reconcile', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId }),
        })
      },
      refresh,
      isPaid: () => planIdRef.current !== 'free',
    })
  }, [checkoutSuccess, userId, refresh])

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <header className="max-w-2xl">
        <p className="section-label">Account</p>
        <h1 className="section-title mt-2 text-3xl">Your plan and usage</h1>
        <p className="section-desc mt-3">
          Everything on this page works whether or not you have an account — signing in just
          moves it off this browser.
        </p>
      </header>

      {checkoutSuccess ? (
        <div
          className="mt-6 flex items-start justify-between gap-4 rounded-card border border-q-teal/30 px-4 py-3"
          style={TEAL_BOX}
          role="status"
        >
          <p className="text-[13px]">
            {loading || plan.id === 'free' ? (
              <>
                Checkout complete — confirming your subscription now. This can take a few
                seconds; the plan below will update automatically once it&rsquo;s active.
              </>
            ) : (
              <>
                You&rsquo;re on {plan.name} — welcome in. Real hardware backends are unlocked
                in the simulator.
              </>
            )}
          </p>
          <button
            type="button"
            className="focus-ring shrink-0 text-[13px] font-semibold underline underline-offset-2"
            onClick={() => setCheckoutSuccess(false)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="mt-6">
        <AuthPanel />
      </div>

      <PlatformConsoleLink className="mt-6" />

      <PlanCard
        entitlement={entitlement}
        plan={plan}
        loading={loading}
        userId={user?.id}
        signedIn={!!user}
        billingEnabled={billingEnabled}
      />

      <UsageCard entitlement={entitlement} plan={plan} signedIn={!!user} />

      {/*
        Renders nothing at all when signed out — a key is an account-scoped
        credential and there is nothing useful to say about one to a visitor
        who has no account to attach it to.
      */}
      <ApiKeys />

      {/*
        Below the keys, deliberately. An API key is how you reach this
        platform; a vendor credential is how this platform reaches IBM on your
        behalf — the bigger decision, and the one that reads better after the
        smaller one has established what a credential panel looks like here.
        Renders nothing when signed out, same rule as the keys.
      */}
      <ProviderCredentials />
    </div>
  )
}

function PlanCard({
  entitlement,
  plan,
  loading,
  userId,
  signedIn,
  billingEnabled,
}: {
  entitlement: Entitlement
  plan: Plan
  loading: boolean
  userId?: string
  signedIn: boolean
  billingEnabled: boolean
}) {
  const [portalState, setPortalState] = useState<
    { kind: 'idle' | 'pending' } | { kind: 'notice' | 'error'; message: string }
  >({ kind: 'idle' })

  const openPortal = useCallback(async () => {
    setPortalState({ kind: 'pending' })
    try {
      // SECURITY (docs/SECURITY.md checklist item 2): /api/billing/portal
      // answers 401 without a token and 403 when the body's userId is not the
      // token's owner — the body is a claim, the header is the credential.
      const response = await authFetch('/api/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId }),
      })
      const body: unknown = await response.json().catch(() => null)
      const record = isRecord(body) ? body : {}

      if (record.configured === false) {
        setPortalState({
          kind: 'notice',
          message: typeof record.message === 'string' ? record.message : PORTAL_NOT_CONFIGURED,
        })
        return
      }
      if (typeof record.error === 'string') {
        setPortalState({ kind: 'error', message: record.error })
        return
      }
      if (typeof record.url === 'string') {
        window.location.assign(record.url)
        return
      }
      setPortalState({ kind: 'notice', message: PORTAL_NOT_CONFIGURED })
    } catch {
      setPortalState({ kind: 'notice', message: PORTAL_NOT_CONFIGURED })
    }
  }, [userId])

  const periodEnd = formatDate(entitlement.currentPeriodEnd)
  const lapsing = entitlement.cancelAtPeriodEnd === true

  return (
    <section className="card mt-4 p-5" aria-busy={loading}>
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="text-[13px] font-semibold text-ink-secondary">Your plan</h2>
        <PlanBadge planId={plan.id} />
        <span className="pill bg-surface-3 text-ink-secondary">
          {STATUS_COPY[entitlement.status]}
        </span>
      </div>

      <p className="mt-3 text-base font-bold text-ink">{plan.name}</p>
      <p className="mt-1 text-[13px] text-ink-secondary">{plan.tagline}</p>

      {entitlement.launchTrial ? (
        <p className="mt-3 text-[13px] text-ink-muted">
          {periodEnd
            ? `Launch trial: every Pro feature is included free until ${periodEnd}. Nothing to cancel — after that you keep the Free plan, which does not expire.`
            : 'Launch trial: every Pro feature is included free. Nothing to cancel.'}
        </p>
      ) : periodEnd ? (
        <p className="mt-3 text-[13px] text-ink-muted">
          {lapsing ? 'Access ends' : 'Renews'} on {periodEnd}.
        </p>
      ) : (
        <p className="mt-3 text-[13px] text-ink-muted">
          No renewal date — the Free plan does not expire.
        </p>
      )}

      {lapsing ? (
        <p className="mt-3 rounded-lg border border-q-amber/30 px-3 py-2 text-[12px]" style={AMBER_BOX}>
          This subscription is set to end at the close of the current period. You keep every
          feature until then, and nothing you have saved is deleted afterwards.
        </p>
      ) : null}

      {!signedIn ? (
        <p className="mt-3 text-[12px] text-ink-muted">
          You are not signed in, so this shows the Free plan. Signing in syncs a subscription
          across every device you use.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {/* Only where there is a portal to open (billing is on and the caller is
            signed in), and never inside the store apps: the portal allows plan
            changes, an outside purchase path Google Play and the App Store
            refuse (docs/BILLING.md, "Store apps"). */}
        {billingEnabled ? (
          <button
            type="button"
            data-store-hide
            className="btn-ghost focus-ring"
            disabled={portalState.kind === 'pending'}
            onClick={() => void openPortal()}
          >
            {portalState.kind === 'pending' ? 'Opening…' : 'Manage billing'}
          </button>
        ) : null}
        <Link href="/pricing" className="btn-ghost focus-ring">
          Compare plans
        </Link>
      </div>

      {/* A11Y (WCAG 4.1.3): "Manage billing" resolves asynchronously and either
          navigates away or renders one of these. Focus never leaves the button,
          so without a live role the outcome was silent. */}
      {portalState.kind === 'notice' ? (
        <p
          role="status"
          data-store-hide
          className="mt-3 rounded-lg border border-q-amber/30 px-3 py-2 text-[12px] leading-relaxed"
          style={AMBER_BOX}
        >
          {portalState.message}
        </p>
      ) : null}
      {portalState.kind === 'error' ? (
        <p role="alert" data-store-hide className="mt-3 text-[12px] text-q-rose-text">
          {portalState.message}
        </p>
      ) : null}
    </section>
  )
}

/**
 * The active engagement bonus, read from /api/billing/hardware-bonus.
 *
 * DISPLAY ONLY — the enforcing, bonus-aware limit check lives inside
 * `public.reserve_hardware_job` (docs/BILLING.md §11). This hook exists so the
 * meter a bonus-holder sees agrees with the limit the server enforces; every
 * failure resolves to null, which renders as "no bonus line", the same as not
 * having one.
 */
function useHardwareBonus(signedIn: boolean): { jobs: number; grantedAt: string } | null {
  const [bonus, setBonus] = useState<{ jobs: number; grantedAt: string } | null>(null)
  useEffect(() => {
    if (!signedIn) {
      setBonus(null)
      return
    }
    let cancelled = false
    void authFetch('/api/billing/hardware-bonus')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: unknown) => {
        if (cancelled || !isRecord(body) || !isRecord(body.bonus)) return
        const jobs = body.bonus.jobs
        if (typeof jobs === 'number' && Number.isFinite(jobs) && jobs > 0) {
          setBonus({ jobs: Math.floor(jobs), grantedAt: String(body.bonus.grantedAt ?? '') })
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [signedIn])
  return bonus
}

function UsageCard({
  entitlement,
  plan,
  signedIn,
}: {
  entitlement: Entitlement
  plan: Plan
  signedIn: boolean
}) {
  const bonus = useHardwareBonus(signedIn)
  // A bonus widens THIS window's allowance — the same arithmetic
  // reserve_hardware_job applies, so the meter and the gate agree.
  const allowance = plan.limits.hardwareJobsPerMonth + (bonus?.jobs ?? 0)
  const used = entitlement.hardwareJobsUsed
  const ratio = allowance > 0 && Number.isFinite(allowance) ? Math.min(1, used / allowance) : 0
  const percent = Math.round(ratio * 100)
  // A11Y (WCAG 1.4.11): the bar fill is the only graphical carrier of "how much
  // is left", so it needs 3:1 against its own track (--surface-3). The literal
  // hexes here measured 1.65:1 (amber) and 2.86:1 (rose) on the light track.
  // The tokens are the same values in dark (3.93 / 7.71 / 4.45:1) and clear the
  // floor in light (6.82 / 4.98 / 4.33:1).
  const barColor = ratio >= 1 ? 'var(--q-rose)' : ratio > 0.8 ? 'var(--q-amber)' : 'var(--q-violet)'
  // 1.4.1: the same three states are also spelled out, because "amber" and
  // "rose" are the same bar to a colour-blind or screen-reader user.
  const usageState =
    ratio >= 1 ? 'allowance used up' : ratio > 0.8 ? 'nearly used up' : 'within allowance'

  return (
    <section className="card mt-4 p-5">
      <h2 className="text-[13px] font-semibold text-ink-secondary">Usage this month</h2>

      <div className="mt-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] text-ink-secondary">Hardware jobs</span>
          <span className="font-mono text-[13px] text-ink">
            {used.toLocaleString('en-US')} / {formatLimit(allowance)}
            {bonus ? (
              <span className="ml-1.5 text-q-teal-text" title="One-time engagement bonus">
                (+{bonus.jobs} bonus)
              </span>
            ) : null}
          </span>
        </div>
        <div
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`${used.toLocaleString('en-US')} of ${formatLimit(allowance)} hardware jobs used — ${usageState}`}
          aria-label="Hardware jobs used this month"
        >
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{ width: `${percent}%`, backgroundColor: barColor }}
          />
        </div>
        <p className="mt-2 text-[12px] text-ink-muted">
          {allowance === 0
            ? 'The Free plan runs on the local and noisy simulators, which are unlimited. Real-hardware jobs start on Pro.'
            : ratio >= 1
              ? 'You have used every hardware job included this month. The allowance resets on the first of next month.'
              : 'Simulator runs are unlimited on every plan and never count against this.'}
        </p>
        {bonus ? (
          <p className="mt-2 rounded-lg border border-q-teal/30 px-3 py-2 text-[12px] leading-relaxed" style={TEAL_BOX}>
            Bonus unlocked: running your 50th hardware job this subscription year earned a
            one-time +{bonus.jobs} jobs for this usage window. It applies automatically — the
            meter above already includes it.
          </p>
        ) : null}
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <ReadOnlyStat label="Saved circuits" value={formatLimit(plan.limits.maxSavedCircuits)} />
        <ReadOnlyStat label="Max qubits" value={formatLimit(plan.limits.maxQubits)} />
        <ReadOnlyStat label="Tutor msgs / day" value={formatLimit(plan.limits.tutorMessagesPerDay)} />
      </dl>
    </section>
  )
}

function ReadOnlyStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
      <dt className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">{label}</dt>
      <dd className="font-mono text-sm font-bold text-q-violet-text">{value}</dd>
    </div>
  )
}
