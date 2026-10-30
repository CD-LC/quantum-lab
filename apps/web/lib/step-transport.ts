/**
 * step-transport.ts — where the step-through transport may go.
 *
 * simulateStepsChecked() keeps every frame for an ordinary circuit, but only a
 * PREFIX of them for a long circuit on a wide register (the frames are 16 * 2^n
 * bytes each). The step inspector's position counts gates applied, so a step
 * past the kept prefix has no frame: reading the last one anyway shows an
 * earlier state under a later gate's name. These two functions are the whole
 * rule, pure so the component and its test cannot disagree.
 *
 *   - Steps 0..maxStep each have a frame and can be scrubbed to.
 *   - `total` (the end of the circuit) is always reachable, and is shown from
 *     the exact final state rather than from a frame.
 *   - Everything in between is not offered.
 */

/** The furthest step that has a kept frame (frames[0] is the initial state). */
export function maxFrameStep(total: number, frameCount: number): number {
  return Math.min(total, Math.max(frameCount - 1, 0))
}

/** Clamp a requested step to one the transport may show. */
export function clampTransportStep(step: number, total: number, frameCount: number): number {
  if (step >= total) return total
  return Math.min(Math.max(step, 0), maxFrameStep(total, frameCount))
}
