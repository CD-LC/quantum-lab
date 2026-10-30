import { describe, expect, it, vi } from 'vitest'
import { CONFIRM_DELAYS_MS, startConfirmingCheckout } from './confirmCheckout'

/** A manual timer queue, so the schedule is observable without real time. */
function fakeTimers() {
  const queue: Array<{ fn: () => void; ms: number; id: number }> = []
  let next = 1
  return {
    queue,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++
      queue.push({ fn, ms, id })
      return id
    },
    clearTimer: (h: unknown) => {
      const i = queue.findIndex((t) => t.id === h)
      if (i >= 0) queue.splice(i, 1)
    },
    /** Fire the next timer and let its async body settle. */
    async fire() {
      const t = queue.shift()
      t?.fn()
      await new Promise((r) => setTimeout(r, 0))
      return t?.ms
    },
  }
}

describe('startConfirmingCheckout', () => {
  it('reconciles then refreshes, repeatedly, with growing gaps while still free', async () => {
    const timers = fakeTimers()
    const reconcile = vi.fn(async () => undefined)
    const refresh = vi.fn()
    startConfirmingCheckout({ reconcile, refresh, isPaid: () => false, ...timers })

    const gaps: Array<number | undefined> = []
    while (timers.queue.length > 0) gaps.push(await timers.fire())

    expect(gaps).toEqual([...CONFIRM_DELAYS_MS])
    expect(reconcile).toHaveBeenCalledTimes(CONFIRM_DELAYS_MS.length)
    expect(refresh).toHaveBeenCalledTimes(CONFIRM_DELAYS_MS.length)
  })

  it('orders reconcile before refresh within an attempt', async () => {
    const timers = fakeTimers()
    const order: string[] = []
    startConfirmingCheckout({
      reconcile: async () => void order.push('reconcile'),
      refresh: () => void order.push('refresh'),
      isPaid: () => false,
      ...timers,
    })
    await timers.fire()
    expect(order).toEqual(['reconcile', 'refresh'])
  })

  it('stops as soon as the plan is paid', async () => {
    const timers = fakeTimers()
    let paid = false
    const reconcile = vi.fn(async () => undefined)
    startConfirmingCheckout({
      reconcile,
      refresh: () => {
        paid = true
      },
      isPaid: () => paid,
      ...timers,
    })

    await timers.fire() // attempt 1: refresh flips to paid
    await timers.fire() // attempt 2: sees paid and does nothing

    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(timers.queue).toHaveLength(0)
  })

  it('keeps going when reconcile fails (network, 429)', async () => {
    const timers = fakeTimers()
    const refresh = vi.fn()
    startConfirmingCheckout({
      reconcile: async () => {
        throw new Error('offline')
      },
      refresh,
      isPaid: () => false,
      ...timers,
    })
    await timers.fire()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(timers.queue).toHaveLength(1)
  })

  it('cancel clears the pending timer and silences a late attempt', async () => {
    const timers = fakeTimers()
    const reconcile = vi.fn(async () => undefined)
    const cancel = startConfirmingCheckout({
      reconcile,
      refresh: vi.fn(),
      isPaid: () => false,
      ...timers,
    })
    cancel()
    expect(timers.queue).toHaveLength(0)
    expect(reconcile).not.toHaveBeenCalled()
  })
})
