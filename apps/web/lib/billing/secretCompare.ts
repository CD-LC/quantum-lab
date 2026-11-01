/**
 * secretCompare.ts — compare an offered operator secret to the configured one.
 *
 * SERVER ONLY (node:crypto).
 *
 * `timingSafeEqual` requires buffers of EQUAL BYTE LENGTH and throws a
 * RangeError otherwise. The routes used to guard with `string.length`, which
 * counts UTF-16 code units: a header such as `é` has the same character count
 * as one ASCII letter but two UTF-8 bytes, passed the guard, and made the
 * compare throw — an unauthenticated, unthrottled 500.
 *
 * Both sides are therefore reduced to a SHA-256 digest first. The digests are
 * always 32 bytes, so the compare cannot throw whatever the header contains,
 * and it does not leak the secret's length through an early return either.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/**
 * True only when `expected` is non-empty and `offered` equals it. An empty
 * expected secret never matches anything, the empty string included: "the
 * variable is unset" must not authorise a caller who sends no secret.
 */
export function secretMatches(offered: string, expected: string): boolean {
  if (expected.length === 0) return false
  return timingSafeEqual(digest(offered), digest(expected))
}
