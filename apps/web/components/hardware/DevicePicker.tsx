'use client'

/**
 * DevicePicker — the catalogue of real quantum computers.
 *
 * Unavailable devices are shown, not hidden. "IonQ Aria-1 exists, has 25
 * trapped-ion qubits, and needs AWS credentials" is far more useful than an
 * empty list, and it tells the reader exactly what to configure next.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { announce } from '@/lib/a11y/announce'
import {
  FIT_DISCLAIMER,
  FIT_FORMULA,
  estimateFit,
  type CalibrationSummary,
  type FitEstimate,
} from '@/lib/hardware/fitEstimate'
import type { HardwareDevice } from '@/lib/hardware/types'

/**
 * The API now attaches a calibration summary to each device row. The shared
 * HardwareDevice mirror in lib/hardware/types.ts has not grown the field yet
 * (it is owned elsewhere), so it is widened locally: absent means an older
 * API, and every fit display simply disappears.
 */
type DeviceRow = HardwareDevice & { calibration?: CalibrationSummary | null }

export interface DevicePickerProps {
  devices: HardwareDevice[]
  value: string
  onChange: (id: string) => void
  /**
   * Depth of the circuit currently staged for submission (as drawn, from
   * lib/hardware/fitEstimate.ts::circuitStats). When omitted or null the
   * per-device fit summary and the sort-by-fit control are not rendered —
   * a fit estimate without a circuit would be an invented number.
   */
  circuitDepth?: number | null
}

/** Technology hue: superconducting reads sky, trapped-ion reads teal. */
function technologyStyle(technology: string): { color: string; border: string } {
  if (technology === 'trapped-ion')
    return { color: 'var(--q-teal-text)', border: 'rgb(var(--q-teal-rgb) / 0.45)' }
  if (technology === 'superconducting')
    return { color: 'var(--q-sky-text)', border: 'rgb(var(--q-sky-rgb) / 0.45)' }
  return { color: 'var(--ink-secondary)', border: 'color-mix(in srgb, var(--ink-muted) 60%, transparent)' }
}

/**
 * Present one fit estimate as short UI copy. The words "rough estimate" and
 * the formula are part of the contract with the reader (docs/HARDWARE.md §7):
 * a percentage next to a device name reads as a measurement unless it says,
 * right there, that it is not one.
 */
function fitPresentation(fit: FitEstimate): {
  text: string
  tooltip: string
  color: string
} {
  if (fit.kind === 'unknown') {
    return {
      text: 'fit unknown',
      tooltip: `${fit.why} No estimate is shown rather than an invented one.`,
      color: 'var(--ink-muted)',
    }
  }
  const pct = Math.round(fit.success * 100)
  const provenance =
    fit.source === 'static'
      ? 'Computed from vendor-published TYPICAL error rates, not a live calibration.'
      : "Computed from the device's calibration as reported at listing time."
  return {
    text: `~${pct}% est. success · ${fit.label}`,
    tooltip: `Rough estimate: ${FIT_FORMULA}. ${provenance} ${FIT_DISCLAIMER}`,
    color:
      fit.label === 'good'
        ? 'var(--q-teal-text)'
        : fit.label === 'marginal'
          ? 'var(--q-amber-text)'
          : 'var(--q-rose-text)',
  }
}

export function DevicePicker({ devices, value, onChange, circuitDepth }: DevicePickerProps) {
  const groupRef = useRef<HTMLDivElement>(null)
  const [sortByFit, setSortByFit] = useState(false)

  const hasDepth = typeof circuitDepth === 'number' && Number.isFinite(circuitDepth)

  /**
   * Fit per device, plus the render order. Sorting is opt-in and stable:
   * best estimated fit first, devices with no estimate after all devices with
   * one, and the API's order preserved within ties — so toggling the sort off
   * always restores exactly the list the server sent.
   */
  const { fits, ordered } = useMemo(() => {
    const rows = devices as DeviceRow[]
    const fitById = new Map<string, FitEstimate>()
    if (hasDepth) {
      for (const device of rows) {
        fitById.set(device.id, estimateFit(circuitDepth as number, device.calibration))
      }
    }
    if (!hasDepth || !sortByFit) return { fits: fitById, ordered: rows }
    const key = (device: DeviceRow): number => {
      const fit = fitById.get(device.id)
      return fit && fit.kind === 'estimate' ? fit.success : -1
    }
    return { fits: fitById, ordered: [...rows].sort((a, b) => key(b) - key(a)) }
  }, [devices, hasDepth, circuitDepth, sortByFit])

  /**
   * Select, and say so.
   *
   * A11Y (WCAG 4.1.3): choosing a device silently re-prices the whole
   * submission — the cost estimate, the transpile preview and the qubit ceiling
   * all change somewhere else on the page. `aria-checked` alone only covers the
   * case where the user pressed the control themselves and focus is still on
   * it; it says nothing about the consequences, which are the reason anyone
   * touches this control. Unavailable devices explain the refusal instead of
   * doing nothing.
   */
  const select = useCallback(
    (device: HardwareDevice) => {
      if (!device.available) {
        announce(
          `${device.name} is not available. ${device.reason ?? 'No credentials are configured for this provider.'}`,
        )
        return
      }
      if (device.id === value) return
      onChange(device.id)
      announce(
        `${device.name} selected, ${device.provider}, ${device.qubits} qubits. The cost estimate has been updated.`,
      )
    },
    [onChange, value],
  )

  /**
   * Arrow-key movement inside the radiogroup (WAI-ARIA radio pattern).
   *
   * Focus is moved by hand rather than through state, because the roving
   * `tabIndex` is derived from `value` and React has not re-rendered yet at the
   * moment the key is handled. Wrapping is deliberate — the radio pattern wraps
   * where the circuit grid (a 2-D grid) clamps.
   */
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step =
        event.key === 'ArrowDown' || event.key === 'ArrowRight'
          ? 1
          : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
            ? -1
            : 0
      if (step === 0 || ordered.length === 0) return
      event.preventDefault()

      /*
       * The cursor is read from the DOM, not from `value`. Arrowing onto an
       * UNAVAILABLE device deliberately leaves the selection where it was (it
       * explains the refusal instead), so focus and selection can diverge —
       * and deriving the cursor from `value` would then bounce the user back
       * to the checked option on the next key press instead of carrying on
       * past the unavailable one.
       */
      const focusedId =
        document.activeElement instanceof HTMLElement
          ? document.activeElement.dataset.deviceId
          : undefined
      // Arrowing follows the VISIBLE order, which is the sorted one when the
      // fit sort is on — keyboard and pointer users must see the same list.
      const current = ordered.findIndex((d) => d.id === (focusedId ?? value))
      const from = current === -1 ? 0 : current
      const next = ordered[(from + step + ordered.length) % ordered.length]
      if (!next) return
      select(next)
      groupRef.current
        ?.querySelector<HTMLButtonElement>(`[data-device-id="${CSS.escape(next.id)}"]`)
        ?.focus()
    },
    [ordered, value, select],
  )

  // Keep the DOM focus on the checked option after a re-render moves the
  // roving tabIndex, so arrowing does not drop focus back to the document.
  useEffect(() => {
    const group = groupRef.current
    if (!group || !group.contains(document.activeElement)) return
    group
      .querySelector<HTMLButtonElement>(`[data-device-id="${CSS.escape(value)}"]`)
      ?.focus()
  }, [value])

  if (devices.length === 0) {
    return (
      <div className="card p-5 text-sm text-ink-secondary">
        The API returned no devices. That normally means no provider catalogue is
        configured on the service.
      </div>
    )
  }

  /*
   * Which option is the group's single tab stop.
   *
   * The checked one, or the first device when `value` names nothing in the list
   * — which happens on first paint (the page's default backend may not be in
   * the catalogue the API returned). Without this fallback every option would
   * be tabIndex={-1} and the radiogroup would be unreachable by keyboard, which
   * is a worse bug than the one the roving tabindex fixes.
   */
  const checkedIndex = ordered.findIndex((d) => d.id === value)
  const entryIndex = checkedIndex === -1 ? 0 : checkedIndex

  return (
    <div>
      {hasDepth ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={sortByFit}
            onClick={() => {
              setSortByFit((current) => {
                const next = !current
                announce(
                  next
                    ? 'Devices sorted by estimated fit for the current circuit, best first.'
                    : 'Device sort restored to the provider order.',
                )
                return next
              })
            }}
            className={sortByFit ? 'btn-primary focus-ring' : 'btn-ghost focus-ring'}
          >
            Sort by estimated fit
          </button>
          <span className="text-[11px] leading-relaxed text-ink-muted">
            Rough estimate from depth × median 2Q error — not a prediction.
          </span>
        </div>
      ) : null}

      <div
        ref={groupRef}
        role="radiogroup"
        aria-label="Hardware device"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        onKeyDown={onKeyDown}
      >
        {ordered.map((device, index) => {
        const selected = device.id === value
        const tech = technologyStyle(device.technology)
        const fit = hasDepth ? fits.get(device.id) : undefined
        const fitView = fit ? fitPresentation(fit) : null
        return (
          <button
            key={`${device.provider}:${device.id}`}
            type="button"
            role="radio"
            data-device-id={device.id}
            aria-checked={selected}
            /*
             * A11Y (WCAG 2.1.1 / 4.1.2) — the same defect the exam's review mode
             * had (audit finding 18). `disabled` removed unavailable devices
             * from the tab order entirely, so the one group of users who most
             * need the explanation ("IonQ Aria-1 needs AWS credentials", right
             * there in device.reason) could not reach it at all. The card is
             * still not selectable: onClick already checks device.available,
             * and aria-disabled tells assistive tech so.
             */
            aria-disabled={!device.available}
            /*
             * Roving tabindex: a radiogroup is ONE tab stop with arrow keys
             * between options, not N tab stops. `tabIndex` follows the checked
             * option, falling back to the first device when nothing is chosen
             * yet so the group is always enterable.
             */
            tabIndex={index === entryIndex ? 0 : -1}
            onClick={() => select(device)}
            className={`card card-hover focus-ring p-4 text-left ${
              device.available ? 'cursor-pointer' : 'cursor-not-allowed opacity-55'
            }`}
            style={
              selected
                ? { borderColor: 'var(--q-violet)', backgroundColor: 'rgb(var(--q-violet-rgb) / 0.08)' }
                : undefined
            }
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-mono text-sm font-bold text-ink">{device.name}</div>
                <div className="mt-0.5 text-[11px] uppercase tracking-wider text-ink-muted">
                  {device.provider}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-lg font-bold text-q-violet-text">{device.qubits}</div>
                <div className="text-[10px] uppercase tracking-wider text-ink-muted">qubits</div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span
                className="pill"
                style={{ color: tech.color, borderColor: tech.border }}
              >
                {device.technology}
              </span>

              {device.source === 'catalogue' ? (
                <span
                  className="pill text-ink-muted"
                  title="Static specification sheet — the provider was not queried."
                >
                  catalogue
                </span>
              ) : (
                <span className="pill" style={{ color: 'var(--q-teal-text)', borderColor: 'rgb(var(--q-teal-rgb) / 0.45)' }}>
                  live
                </span>
              )}

              {device.available ? (
                <span
                  className="pill"
                  style={{ color: 'var(--q-teal-text)', borderColor: 'rgb(var(--q-teal-rgb) / 0.45)' }}
                  title={device.byok ? 'Runs on the credential you saved for this vendor, not the platform\'s.' : undefined}
                >
                  {device.byok ? 'your account' : 'available'}
                </span>
              ) : (
                <span className="pill text-ink-muted">not configured</span>
              )}

              {device.pending_jobs !== null ? (
                <span className="pill" style={{ color: 'var(--q-amber-text)', borderColor: 'rgb(var(--q-amber-rgb) / 0.45)' }}>
                  {device.pending_jobs} queued
                </span>
              ) : null}

              {fitView ? (
                /*
                 * The tooltip carries the formula and the provenance; the pill
                 * itself must still say "est." so the number is never read as
                 * a measurement even when the tooltip goes unhovered.
                 */
                <span
                  className="pill"
                  style={{ color: fitView.color, borderColor: 'color-mix(in srgb, currentColor 45%, transparent)' }}
                  title={fitView.tooltip}
                >
                  {fitView.text}
                  {fit && fit.kind === 'estimate' && fit.source === 'static' ? ' (typical)' : ''}
                </span>
              ) : null}
            </div>

            {device.note ? (
              <p className="mt-2.5 text-[12px] leading-relaxed text-ink-secondary">{device.note}</p>
            ) : null}

            {!device.available && device.reason ? (
              <p className="mt-2 text-[12px] leading-relaxed text-q-amber-text">{device.reason}</p>
            ) : null}
          </button>
        )
        })}
      </div>
    </div>
  )
}

export default DevicePicker
