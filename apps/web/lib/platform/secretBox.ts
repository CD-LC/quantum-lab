/**
 * platform/secretBox.ts — AES-256-GCM for secrets stored in platform_settings.
 *
 * SERVER ONLY. Provider API keys an admin types into /admin/platform are
 * encrypted here before they reach Supabase, so a database dump (or an
 * over-broad Supabase dashboard login) yields ciphertext, and the key that
 * opens it lives only in the web app's environment.
 *
 * Key material, in order of preference:
 *   1. SETTINGS_ENCRYPTION_KEY — 64 hex chars (32 bytes) or any string, which
 *      is hashed to 32 bytes. Set this: rotating it re-encrypts nothing, so
 *      stored keys become unreadable until re-entered (the console says so).
 *   2. Derived from SUPABASE_SERVICE_ROLE_KEY. FALLBACK ONLY, and deliberately
 *      kept: removing it would make every credential already sealed under it
 *      unreadable and lock existing users out of BYOK. It is a weaker protection
 *      than (1): anyone who can read the service-role key (the Supabase
 *      dashboard, a CI log) can derive it, and rotating the service-role key
 *      silently bricks every sealed value. So using it is loud: one
 *      `console.warn` and one `reportMessage` per process, and
 *      `byokKeyIsFallback()` is exposed for `/api/health` to report to a
 *      trusted caller. Migration path: docs/BYOK.md, "Moving off the fallback
 *      key".
 *
 * Once (1) is set, `open()` STILL tries the derived key for values it cannot
 * open with (1), so credentials sealed before the explicit key existed keep
 * working instead of locking their owners out. Every NEW `seal()` uses (1)
 * only. Those legacy values stay readable by a service-role-key holder until
 * their owner re-saves them.
 *
 * Wire format: `v1.<iv>.<ciphertext>.<tag>`, each base64url.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { reportMessage } from '@/lib/observability/report'

const PREFIX = 'v1'

const FALLBACK_WARNING =
  'SETTINGS_ENCRYPTION_KEY is not set: stored BYOK credentials and platform provider keys are ' +
  'sealed under a key DERIVED FROM SUPABASE_SERVICE_ROLE_KEY. Anyone who can read the service-role ' +
  'key can decrypt them, and rotating that key makes every stored credential unreadable. Set ' +
  'SETTINGS_ENCRYPTION_KEY (see docs/BYOK.md, "Moving off the fallback key").'

let fallbackWarned = false

/** Once per process: say loudly that the weaker key is in use. Never throws. */
function warnFallbackOnce(): void {
  if (fallbackWarned) return
  fallbackWarned = true
  try {
    console.warn(`[secretBox] ${FALLBACK_WARNING}`)
  } catch {
    /* a logger that throws must not break sealing */
  }
  reportMessage(`secretBox: ${FALLBACK_WARNING}`, 'warning')
}

/** Test hook: forget that the fallback warning has been emitted. */
export function resetFallbackWarningForTests(): void {
  fallbackWarned = false
}

function explicitKey(): string {
  return (process.env.SETTINGS_ENCRYPTION_KEY ?? '').trim()
}

function derivedKey(): Buffer | null {
  const derived = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  return derived ? createHash('sha256').update(`qubit16-settings:${derived}`, 'utf8').digest() : null
}

function keyBytes(): Buffer | null {
  const explicit = explicitKey()
  if (explicit) {
    if (/^[0-9a-f]{64}$/i.test(explicit)) return Buffer.from(explicit, 'hex')
    return createHash('sha256').update(explicit, 'utf8').digest()
  }
  const derived = derivedKey()
  if (derived) warnFallbackOnce()
  return derived
}

/**
 * True when sealing is running on the key derived from SUPABASE_SERVICE_ROLE_KEY
 * because SETTINGS_ENCRYPTION_KEY is not set. For `/api/health` to report to a
 * trusted caller (HEALTH_DEEP_TOKEN holder) only; never expose it anonymously.
 * Does not warn: asking the question is not using the key.
 */
export function byokKeyIsFallback(): boolean {
  return explicitKey() === '' && (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim() !== ''
}

/** True when secrets can be stored. False → the console refuses to save keys. */
export function secretBoxAvailable(): boolean {
  return keyBytes() !== null
}

export function seal(plaintext: string): string {
  const key = keyBytes()
  if (!key) throw new Error('No SETTINGS_ENCRYPTION_KEY (or SUPABASE_SERVICE_ROLE_KEY) to encrypt with.')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [PREFIX, b64(iv), b64(ct), b64(tag)].join('.')
}

function openWith(key: Buffer, parts: string[]): string | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, unb64(parts[1]))
    decipher.setAuthTag(unb64(parts[3]))
    const pt = Buffer.concat([decipher.update(unb64(parts[2])), decipher.final()])
    return pt.toString('utf8')
  } catch {
    return null
  }
}

/**
 * Returns null when the box cannot be opened (wrong key, tampered, malformed).
 *
 * When an explicit key is set and cannot open the value, the key derived from
 * SUPABASE_SERVICE_ROLE_KEY is tried too: it is how values sealed before the
 * explicit key was introduced stay readable. See the header.
 */
export function open(sealed: string): string | null {
  const key = keyBytes()
  if (!key) return null
  const parts = sealed.split('.')
  if (parts.length !== 4 || parts[0] !== PREFIX) return null
  const primary = openWith(key, parts)
  if (primary !== null || explicitKey() === '') return primary
  const legacy = derivedKey()
  return legacy ? openWith(legacy, parts) : null
}

export function isSealed(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${PREFIX}.`) && value.split('.').length === 4
}

const b64 = (b: Buffer) => b.toString('base64url')
const unb64 = (s: string) => Buffer.from(s, 'base64url')
