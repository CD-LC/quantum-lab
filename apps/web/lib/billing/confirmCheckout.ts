/**
 * confirmCheckout.ts — what the account page does after `?checkout=success`.
 *
 * Browser-safe. The redirect from Stripe usually lands BEFORE the webhook has
 * written the subscription row, so the entitlement read on arrival says Free
 * even though the customer has just paid. Waiting for the webhook is not a
 * plan: if it is delayed or lost, nothing else repairs a brand-new
 * subscription (the entitlement route only self-heals a row whose period ended
 * more than a day ago).
 *
 * So the page asks the server to pull the truth from Stripe
 * (POST /api/billing/reconcile, which a signed-in user may call for
 * themselves), then re-reads the entitlement, and repeats with growing gaps
 * while the plan is still Free. Bounded: the reconcile route allows 5 calls a
 * minute per IP, and the schedule makes 5 attempts in 45 seconds.
 */

/** Gaps BEFORE each attempt, in ms. The first runs at once. */
export const CONFIRM_DELAYS_MS: readonly number[] = [0, 3_000, 6_000, 12_000, 24_000]

export interface ConfirmCheckoutDeps {
  /** POST /api/billing/reconcile. Failures are ignored: the next attempt retries. */
  reconcile: () => Promise<void>
  /** Re-read the entitlement. */
  refresh: () => void
  /** True once the entitlement reports a paid plan; ends the loop. */
  isPaid: () => boolean
  /** Injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  delays?: readonly number[]
}

/** Start confirming; returns a cancel function for the effect cleanup. */
export function startConfirmingCheckout(deps: ConfirmCheckoutDeps): () => void {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const delays = deps.delays ?? CONFIRM_DELAYS_MS
  let cancelled = false
  let handle: unknown
  let index = 0

  const attempt = async (): Promise<void> => {
    if (cancelled || deps.isPaid()) return
    try {
      await deps.reconcile()
    } catch {
      // Network or 429: the entitlement read below and the next attempt still run.
    }
    if (cancelled) return
    deps.refresh()
    index += 1
    if (index < delays.length) handle = setTimer(() => void attempt(), delays[index])
  }

  handle = setTimer(() => void attempt(), delays[0] ?? 0)
  return () => {
    cancelled = true
    if (handle !== undefined) clearTimer(handle)
  }
}
