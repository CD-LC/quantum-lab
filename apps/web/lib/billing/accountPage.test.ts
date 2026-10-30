/**
 * accountPage.test.ts — a source-level guard for the account page's billing
 * controls (the page itself is a client component outside the vitest include
 * list, so this reads the file rather than rendering it).
 *
 * Why it exists: Google Play and the App Store refuse apps that reach an
 * outside purchase path. The portal allows plan changes, so "Manage billing"
 * must be hidden in the store apps (data-store-hide) and must not be offered at
 * all where billing is off.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, '../../app/account/page.tsx'), 'utf8')

describe('app/account/page.tsx — billing controls', () => {
  it('renders Manage billing only when billing is enabled', () => {
    const at = source.indexOf("'Manage billing'")
    expect(at).toBeGreaterThan(-1)
    const before = source.slice(Math.max(0, at - 700), at)
    expect(before).toMatch(/billingEnabled\s*\?\s*\(/)
  })

  it('tags the Manage billing button and its status lines data-store-hide', () => {
    const button = source.slice(source.lastIndexOf('<button', source.indexOf("'Manage billing'")))
    expect(button.slice(0, button.indexOf('>'))).toContain('data-store-hide')
    expect(source).toMatch(/role="status"\s+data-store-hide/)
    expect(source).toMatch(/role="alert" data-store-hide/)
  })

  it('confirms a checkout by reconciling, not just by polling', () => {
    expect(source).toContain('startConfirmingCheckout')
    expect(source).toContain('/api/billing/reconcile')
  })
})

describe('app/globals.css — the hide rule the page relies on', () => {
  it('hides [data-store-hide] inside the store apps', () => {
    const css = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8')
    expect(css).toMatch(/html\[data-store-app\] \[data-store-hide\]/)
  })
})
