/**
 * billing.spec.ts — the DEGRADED paths, which are the only ones CI can run.
 *
 * With no STRIPE_SECRET_KEY and no Supabase, the product is supposed to be a
 * complete Free-plan experience rather than a broken one: pricing still renders,
 * checkout says so plainly instead of erroring, the account page answers "Free",
 * and the free-tier ceilings are visible in the simulator. All four of those are
 * assertions worth having in their own right.
 */

import { test, expect, type Page } from '@playwright/test'

import { PLANS, PLAN_BY_ID } from '../../lib/plans'
import { expectNoConsoleErrors, gotoClean } from './helpers'

const FREE = PLAN_BY_ID.free
const PRO = PLAN_BY_ID.pro

const usd = (cents: number): string => `$${(cents / 100).toLocaleString('en-US')}`

/**
 * Is the launch promotion running on the build under test?
 *
 * The three tests below assert the PLAN TABLE, and app/pricing/page.tsx hides
 * that table while the promotion is on — nothing is for sale until the date in
 * the headline, so a table of monthly prices contradicts the sentence above it.
 *
 * Detected from the PAGE, not from process.env: the flag is a NEXT_PUBLIC_
 * variable inlined at BUILD time, and the Playwright runner's environment is
 * not the environment the app was built with. Reading process.env here would be
 * asking the wrong process. The promotion headline is the honest signal, and it
 * is what a reader sees too.
 *
 * Without this guard these tests are silently coupled to an unset env var: they
 * pass in CI (which sets no flag) and fail on any build made the way PRODUCTION
 * is built, for a reason that has nothing to do with a regression.
 */
async function promotionRunning(page: Page): Promise<boolean> {
  return page.getByRole('heading', { name: /everything is free (until|for)/i }).isVisible()
}

const SKIP_REASON =
  'the launch promotion is running on this build, so app/pricing/page.tsx hides the plan table by design'

test.describe('pricing', () => {
  test('renders all four plans', async ({ page }) => {
    const console_ = expectNoConsoleErrors(page)
    await gotoClean(page, '/pricing')
    test.skip(await promotionRunning(page), SKIP_REASON)

    expect(PLANS).toHaveLength(4)
    for (const plan of PLANS) {
      await expect(
        page.getByRole('heading', { name: plan.name, exact: true }).first(),
        `${plan.name} plan is missing from /pricing`,
      ).toBeVisible()
    }

    console_.assertClean('/pricing')
  })

  test('the monthly / yearly toggle changes the prices', async ({ page }) => {
    await gotoClean(page, '/pricing')
    test.skip(await promotionRunning(page), SKIP_REASON)

    const period = page.getByRole('group', { name: /billing period/i })
    const monthly = period.getByRole('button', { name: 'Monthly' })
    const yearly = period.getByRole('button', { name: 'Yearly' })

    await expect(monthly).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText(usd(PRO.price.monthly), { exact: false }).first()).toBeVisible()
    await expect(page.getByText('/month').first()).toBeVisible()

    await yearly.click()

    await expect(yearly).toHaveAttribute('aria-pressed', 'true')
    await expect(monthly).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByText(usd(PRO.price.yearly), { exact: false }).first()).toBeVisible()
    await expect(page.getByText('/year').first()).toBeVisible()
    await expect(page.getByText(/two months free/i)).toBeVisible()

    // And back again — the toggle is not one-way.
    await monthly.click()
    await expect(page.getByText('/month').first()).toBeVisible()
  })

  test('Upgrade with no Stripe configured explains itself and does not navigate', async ({
    page,
  }) => {
    await gotoClean(page, '/pricing')
    test.skip(await promotionRunning(page), SKIP_REASON)
    const before = page.url()

    // A build WITH accounts (Supabase configured) never offers a signed-out
    // checkout — a payment with no account to attach it to was charged and
    // lost — so the CTA is "Sign in to upgrade", returning here afterwards.
    const signInFirst = page.getByRole('link', { name: 'Sign in to upgrade' }).first()
    if (await signInFirst.isVisible()) {
      await expect(signInFirst).toHaveAttribute('href', '/account?next=%2Fpricing')
      return
    }

    const upgrade = page.getByRole('button', { name: `Upgrade to ${PRO.name}` })
    await expect(upgrade).toBeVisible()
    await upgrade.click()

    // Customer-facing wording: the operator instructions (which env vars to
    // set) travel in the API's `hint` field and are never rendered.
    const notice = page.getByText(/paid plans are not open|not available for purchase/i).first()
    await expect(notice).toBeVisible()
    await expect(notice).not.toContainText(/STRIPE_|environment|docs\/BILLING/i)

    // Still on /pricing — no half-built checkout redirect.
    await expect(page).toHaveURL(before)
    await expect(page.getByRole('heading', { name: PRO.name, exact: true }).first()).toBeVisible()
  })
})

test.describe('account', () => {
  test('renders the free-plan state when signed out', async ({ page }) => {
    const console_ = expectNoConsoleErrors(page)
    await gotoClean(page, '/account')

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByText(/you are not signed in/i)).toBeVisible()
    await expect(page.getByText(FREE.name, { exact: true }).first()).toBeVisible()
    await expect(page.getByText(FREE.tagline)).toBeVisible()

    // The free-tier numbers, straight from the plan definition.
    await expect(page.getByText(String(FREE.limits.maxQubits), { exact: true }).first()).toBeVisible()
    await expect(
      page.getByText(String(FREE.limits.maxSavedCircuits), { exact: true }).first(),
    ).toBeVisible()

    console_.assertClean('/account')
  })
})

test.describe('free-tier gating in the simulator', () => {
  test('all 16 qubits are selectable with no account', async ({ page }) => {
    await gotoClean(page, '/simulator')

    // The simulator runs in the browser, so every plan — including a signed-out
    // visitor — gets the full register. Nothing in the picker may be locked.
    expect(FREE.limits.maxQubits).toBe(16)
    await expect(page.getByRole('button', { name: /locked on your plan/ })).toHaveCount(0)

    const sixteen = page.getByRole('button', { name: '16 qubits', exact: true })
    await sixteen.click()
    await expect(sixteen).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('group', { name: /quantum circuit/i }).first()).toHaveAttribute(
      'aria-label',
      /with 16 qubits/,
    )
    await expect(page.getByText(/needs .* plan/)).toHaveCount(0)
  })

  test('the saved-circuit cap is shown', async ({ page }) => {
    await gotoClean(page, '/simulator')

    const cap = FREE.limits.maxSavedCircuits
    await expect(page.getByText(`0 / ${cap} saved`)).toBeVisible()
    await expect(page.getByText(/local storage/i).first()).toBeVisible()

    // With no gates on the canvas there is nothing to save, and the UI says so
    // rather than failing silently.
    await expect(page.getByRole('button', { name: /save circuit/i })).toBeVisible()
  })
})
