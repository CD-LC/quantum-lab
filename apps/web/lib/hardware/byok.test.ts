/**
 * Tests for the "whose credential pays?" decision.
 *
 * The submit route and the poll route reach this decision from different
 * information — submit has a backend id and an optional provider, poll has a
 * provider and nothing else — and if they disagree the failure is silent: a job
 * submitted on a user's own account and polled with the operator's reports
 * "not found" forever, because no vendor shows one account another's jobs.
 */

import { describe, expect, it, vi } from 'vitest'

// The mapping is pure, but the module imports the credential store, which
// reaches for the service-role client at import time. Stub it out — none of
// these tests touch storage.
vi.mock('@/lib/billing/entitlements', () => ({
  isServiceRoleConfigured: false,
  getServiceSupabase: () => null,
}))

import { byokProviderFor } from '@/lib/hardware/byok'

describe('byokProviderFor', () => {
  it('maps every backend the upstream dispatcher knows', () => {
    // Mirrored from BACKEND_PROVIDER in services/api/app/quantum/hardware.py.
    // The hardware page omits `provider` and lets the upstream derive it, so
    // this layer has to make the same derivation to find the right credential.
    const expected: Record<string, string> = {
      ibm_quantum: 'ibm',
      ibm_brisbane: 'ibm',
      ibm_kyiv: 'ibm',
      ibm_sherbrooke: 'ibm',
      ionq_aria: 'braket',
      ionq_forte: 'braket',
      rigetti_ankaa: 'braket',
      azure_quantinuum_h1: 'azure',
      azure_ionq_aria: 'azure',
    }
    for (const [backend, provider] of Object.entries(expected)) {
      expect(byokProviderFor(null, backend)).toBe(provider)
    }
  })

  it('routes azure_ionq_aria to AZURE, not to Braket', () => {
    // THE trap in this mapping. Azure resells IonQ hardware, so this id
    // contains "ionq" and is nonetheless an Azure job on an Azure bill. A rule
    // that matched "ionq" anywhere would attach the wrong vendor's credential
    // and the job would be refused — or worse, run on the operator's Braket
    // account while the user believed they were paying.
    expect(byokProviderFor(null, 'azure_ionq_aria')).toBe('azure')
  })

  it('catches devices the mirror has not heard of, by naming convention', () => {
    // A new machine added upstream before this list is updated still resolves.
    expect(byokProviderFor(null, 'ibm_fez')).toBe('ibm')
    expect(byokProviderFor(null, 'ionq_tempo')).toBe('braket')
    expect(byokProviderFor(null, 'azure_quantinuum_h2')).toBe('azure')
  })

  it('lets an explicit provider win over the backend id', () => {
    // A caller naming the provider knows something this mirror does not.
    expect(byokProviderFor('ibm', 'something_unrecognised')).toBe('ibm')
    expect(byokProviderFor('braket', 'ibm_brisbane')).toBe('braket')
  })

  it('answers null for an unknown provider string rather than guessing', () => {
    expect(byokProviderFor('ionq', 'ionq_aria')).toBeNull()
  })

  it('answers null for a missing or unusable backend', () => {
    expect(byokProviderFor(null, null)).toBeNull()
    expect(byokProviderFor(null, '')).toBeNull()
    expect(byokProviderFor(undefined, undefined)).toBeNull()
  })

  it('does not match a backend that merely contains a vendor name', () => {
    // The prefix rules are anchored. `my_ibm_clone` is not an IBM device and a
    // credential presented for it would be refused upstream.
    expect(byokProviderFor(null, 'my_ibm_clone')).toBeNull()
    expect(byokProviderFor(null, 'simulator_ionq')).toBeNull()
  })
})

describe('withByokAvailability', () => {
  const device = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    provider: id.startsWith('ibm') ? 'ibm' : 'ionq',
    available: false,
    reason: 'IBM hardware needs an IBM Quantum API token',
    ...over,
  })

  it('marks a device available when the caller holds a credential for its vendor', async () => {
    const { withByokAvailability } = await import('@/lib/hardware/byok')
    const out = withByokAvailability(
      [device('ibm_brisbane'), device('ionq_aria'), device('azure_ionq_aria', { provider: 'azure' })],
      new Set(['ibm'] as const)
    ) as Array<Record<string, unknown>>
    expect(out[0]).toMatchObject({ available: true, reason: null, byok: true })
    expect(out[1]).toMatchObject({ available: false })
    expect(out[1]).not.toHaveProperty('byok')
    expect(out[2]).toMatchObject({ available: false })
  })

  it('maps Braket hardware by device id, not by hardware vendor', async () => {
    const { withByokAvailability } = await import('@/lib/hardware/byok')
    const out = withByokAvailability([device('ionq_aria'), device('rigetti_ankaa')], new Set(['braket'] as const)) as Array<
      Record<string, unknown>
    >
    expect(out.every((d) => d.available === true && d.byok === true)).toBe(true)
  })

  it('leaves operator-available devices and an empty credential set untouched', async () => {
    const { withByokAvailability } = await import('@/lib/hardware/byok')
    const ok = device('ibm_brisbane', { available: true, reason: null })
    expect(withByokAvailability([ok], new Set(['ibm'] as const))[0]).toBe(ok)
    const list = [device('ibm_brisbane')]
    expect(withByokAvailability(list, new Set())).toBe(list)
  })
})
