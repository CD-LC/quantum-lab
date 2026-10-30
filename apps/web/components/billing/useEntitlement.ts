'use client'

/**
 * useEntitlement — "what can this person do right now", with no backend required.
 *
 * The default deployment has neither Stripe nor Supabase configured. That is not
 * an error state: it simply means everyone is on the Free plan, which is a
 * complete product. So this hook never surfaces a failure — a missing route, a
 * 404, a dead network, a malformed body all resolve to FREE_ENTITLEMENT.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from '@/components/auth/useSession'
import { authFetch } from '@/lib/authFetch'
import { loadEntitlement } from '@/lib/billing/entitlementLoader'
import {
  FREE_ENTITLEMENT,
  effectivePlan,
  type Entitlement,
  type Plan,
  type PlanId,
  type SubscriptionStatus,
} from '@/lib/plans'

export interface UseEntitlementResult {
  entitlement: Entitlement
  plan: Plan
  loading: boolean
  /**
   * True when this deployment has Stripe configured, i.e. there is a checkout
   * to send someone to and a customer portal to open. False until the route
   * has answered, and false for a deployment with billing off — so a UI that
   * gates "Manage billing" on it shows nothing rather than an operator message.
   */
  billingEnabled: boolean
  refresh: () => void
}

const PLAN_IDS: PlanId[] = ['free', 'pro', 'team', 'edu']
const STATUSES: SubscriptionStatus[] = [
  'none',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Merge an untrusted JSON body onto the free entitlement, field by field.
 * Anything unrecognised is dropped rather than trusted.
 */
function mergeEntitlement(body: unknown): Entitlement {
  if (!isRecord(body)) return FREE_ENTITLEMENT

  const source = isRecord(body.entitlement) ? body.entitlement : body
  const merged: Entitlement = { ...FREE_ENTITLEMENT }

  const planId = source.planId
  if (typeof planId === 'string' && (PLAN_IDS as string[]).includes(planId)) {
    merged.planId = planId as PlanId
  }

  const status = source.status
  if (typeof status === 'string' && (STATUSES as string[]).includes(status)) {
    merged.status = status as SubscriptionStatus
  }

  if (typeof source.currentPeriodEnd === 'string') {
    merged.currentPeriodEnd = source.currentPeriodEnd
  }
  if (typeof source.cancelAtPeriodEnd === 'boolean') {
    merged.cancelAtPeriodEnd = source.cancelAtPeriodEnd
  }
  if (typeof source.viaOrgId === 'string') {
    merged.viaOrgId = source.viaOrgId
  }
  if (source.launchTrial === true) {
    merged.launchTrial = true
  }
  if (typeof source.hardwareJobsUsed === 'number' && Number.isFinite(source.hardwareJobsUsed)) {
    merged.hardwareJobsUsed = Math.max(0, Math.floor(source.hardwareJobsUsed))
  }

  return merged
}

/** The `billingEnabled` flag from the route body; false when it says nothing. */
export function readBillingEnabled(body: unknown): boolean {
  return isRecord(body) && body.billingEnabled === true
}

export function useEntitlement(): UseEntitlementResult {
  const { user, loading: sessionLoading } = useSession()
  const [entitlement, setEntitlement] = useState<Entitlement>(FREE_ENTITLEMENT)
  const [billingEnabled, setBillingEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  // True once this instance holds a real answer, so a later transient failure
  // never overwrites it.
  const hasValue = useRef(false)

  const userId = user?.id ?? null

  useEffect(() => {
    // SSR guard — there is nothing to fetch, and no window to fetch from.
    if (typeof window === 'undefined') return

    if (sessionLoading) {
      setLoading(true)
      return
    }

    if (!userId) {
      hasValue.current = false
      setEntitlement(FREE_ENTITLEMENT)
      setLoading(false)
      return
    }

    let active = true
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    setLoading(true)

    const apply = (body: unknown) => {
      hasValue.current = true
      setEntitlement(mergeEntitlement(body))
      setBillingEnabled(readBillingEnabled(body))
    }

    const run = async (force: boolean, attempt: number) => {
      // SECURITY (docs/SECURITY.md checklist item 2): the route derives the
      // caller from this token and answers the free tier to anyone who cannot
      // prove the id is theirs. Without the header a signed-in Pro user saw
      // the Free badge.
      //
      // The fetch is SHARED across every hook instance on the page (see
      // lib/billing/entitlementLoader.ts), so it carries no per-component abort
      // signal: aborting it for one unmounting component would fail it for the
      // rest. `active` makes a late answer harmless instead.
      const result = await loadEntitlement(
        userId,
        () =>
          authFetch(`/api/billing/entitlement?userId=${encodeURIComponent(userId)}`, {
            headers: { accept: 'application/json' },
          }),
        { force }
      )
      if (!active) return
      if (result.kind === 'ok') {
        apply(result.body)
        setLoading(false)
        return
      }
      if (result.kind === 'transient') {
        // 429 / 5xx / network: say nothing new. Keep whatever is on screen (a
        // paying user must not be dropped to Free because a limiter tripped),
        // adopting the last good body only if this instance has none yet, and
        // try again a few times after the server's retry-after (not forced:
        // twelve instances forcing at once would re-create the 429).
        if (result.lastGood !== undefined && !hasValue.current) apply(result.lastGood)
        setLoading(false)
        if (attempt < 3) {
          retryTimer = setTimeout(() => void run(false, attempt + 1), result.retryAfterMs)
        }
        return
      }
      // A definitive refusal (route missing, 4xx): Free is the correct answer.
      hasValue.current = false
      setEntitlement(FREE_ENTITLEMENT)
      setLoading(false)
    }

    // `nonce` > 0 is an explicit refresh(): bypass the short-lived cache.
    void run(nonce > 0, 0).catch(() => {
      if (active) setLoading(false)
    })

    return () => {
      active = false
      if (retryTimer !== undefined) clearTimeout(retryTimer)
    }
  }, [userId, sessionLoading, nonce])

  const refresh = useCallback(() => {
    setNonce((n) => n + 1)
  }, [])

  return { entitlement, plan: effectivePlan(entitlement), loading, billingEnabled, refresh }
}

export default useEntitlement
