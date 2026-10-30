/**
 * validate.ts — dependency-free request validators shared by the API routes.
 *
 * Every validator returns a DISCRIMINATED RESULT rather than throwing, so a
 * handler can turn a failure straight into a 400 with a specific message:
 *
 *     const name = str(body.name, 120)
 *     if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 })
 *     // name.value is a string here
 *
 * Design rules:
 *   • No dependencies. This app ships no schema library and adding one for six
 *     functions is not a trade worth making.
 *   • Nothing here reads the environment, so all of it is safe in the edge
 *     runtime and in a completely empty environment.
 *   • Every bound is EXPLICIT at the call site. There is no implicit maximum,
 *     because an unbounded string reaching an LLM, a database or a mail
 *     template is exactly the class of bug this module exists to stop.
 */

/** Success carries the narrowed value; failure carries a message for the 400. */
export type Valid<T> = { ok: true; value: T }
export type Invalid = { ok: false; error: string }
export type Result<T> = Valid<T> | Invalid

function fail(error: string): Invalid {
  return { ok: false, error }
}

function pass<T>(value: T): Valid<T> {
  return { ok: true, value }
}

/**
 * A non-empty string of at most `maxLen` characters, trimmed.
 *
 * Length is measured in UTF-16 code units (`String.length`) — the same unit the
 * runtime uses, which is what matters for a memory bound. It is not a grapheme
 * count, and it is not a byte count; use `safeJson` when bytes are the concern.
 */
export function str(v: unknown, maxLen: number, label = 'value'): Result<string> {
  if (typeof v !== 'string') return fail(`${label} must be a string.`)
  const trimmed = v.trim()
  if (trimmed.length === 0) return fail(`${label} must not be empty.`)
  if (trimmed.length > maxLen) {
    return fail(`${label} must be at most ${maxLen} characters (got ${trimmed.length}).`)
  }
  return pass(trimmed)
}

/** Like `str`, but an absent/empty value is allowed and yields undefined. */
export function optionalStr(
  v: unknown,
  maxLen: number,
  label = 'value'
): Result<string | undefined> {
  if (v === undefined || v === null) return pass(undefined)
  if (typeof v === 'string' && v.trim().length === 0) return pass(undefined)
  const result = str(v, maxLen, label)
  return result.ok ? pass(result.value) : result
}

/**
 * An integer within [min, max].
 *
 * Rejects NaN and ±Infinity explicitly: `Number.isInteger` already excludes
 * both, but the rejection is spelled out here because "an integer field that
 * accepts Infinity" is a real bug class (it flows into `slice`, into `Array(n)`
 * and into arithmetic that silently produces NaN downstream) and a reader of
 * this module should see that it is handled rather than infer it.
 */
export function int(v: unknown, min: number, max: number, label = 'value'): Result<number> {
  if (typeof v !== 'number') return fail(`${label} must be a number.`)
  if (Number.isNaN(v)) return fail(`${label} must not be NaN.`)
  if (!Number.isFinite(v)) return fail(`${label} must be finite.`)
  if (!Number.isInteger(v)) return fail(`${label} must be a whole number.`)
  if (v < min || v > max) return fail(`${label} must be between ${min} and ${max}.`)
  return pass(v)
}

/** An array of at most `maxLen` items. Contents are NOT inspected — do that per item. */
export function arr(v: unknown, maxLen: number, label = 'value'): Result<unknown[]> {
  if (!Array.isArray(v)) return fail(`${label} must be an array.`)
  if (v.length > maxLen) {
    return fail(`${label} must contain at most ${maxLen} items (got ${v.length}).`)
  }
  return pass(v)
}

/** One of a fixed set of literals. The allowed set doubles as the error message. */
export function oneOf<const T extends readonly string[]>(
  v: unknown,
  allowed: T,
  label = 'value'
): Result<T[number]> {
  if (typeof v !== 'string' || !allowed.includes(v)) {
    return fail(`${label} must be one of: ${allowed.join(', ')}.`)
  }
  return pass(v as T[number])
}

/**
 * A canonical RFC 4122 UUID (any version), lowercased.
 *
 * Supabase user ids are UUIDs, so this is the right shape check for a `userId`
 * that will be used in a database filter. It is a SHAPE check and nothing more:
 * a well-formed UUID from an unauthenticated caller is still an unauthenticated
 * caller. Authorisation is a separate decision, made per route.
 */
export function uuid(v: unknown, label = 'value'): Result<string> {
  if (typeof v !== 'string') return fail(`${label} must be a string.`)
  const trimmed = v.trim().toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(trimmed)) {
    return fail(`${label} must be a UUID.`)
  }
  return pass(trimmed)
}

/**
 * A plausible email address, lowercased, at most 254 characters (RFC 5321).
 *
 * Deliberately the same loose pattern used elsewhere in the app: the only
 * authority on whether an address exists is the mail provider, and a stricter
 * regex rejects valid addresses far more often than it catches invalid ones.
 */
export function email(v: unknown, label = 'email'): Result<string> {
  if (typeof v !== 'string') return fail(`${label} must be a string.`)
  const trimmed = v.trim().toLowerCase()
  if (trimmed.length > 254) return fail(`${label} must be at most 254 characters.`)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return fail(`${label} is not a valid address.`)
  return pass(trimmed)
}

/**
 * An absolute http(s) URL, optionally restricted to a set of allowed hosts.
 *
 * Two separate jobs:
 *   1. Reject non-http schemes — `javascript:`, `data:`, `file:` — before a URL
 *      is ever rendered into a link.
 *   2. When `allowedHosts` is given, reject anything off-site. That is what
 *      turns "send a templated email" from an open phishing relay into a
 *      transactional endpoint.
 *
 * Host comparison is exact and case-insensitive, so `evil.com/?x=app.example`
 * and `app.example.evil.com` both fail.
 */
export function httpUrl(
  v: unknown,
  maxLen: number,
  allowedHosts?: readonly string[],
  label = 'url'
): Result<string> {
  const asString = str(v, maxLen, label)
  if (!asString.ok) return asString

  let parsed: URL
  try {
    parsed = new URL(asString.value)
  } catch {
    return fail(`${label} must be an absolute URL.`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail(`${label} must use http or https.`)
  }
  if (allowedHosts && allowedHosts.length > 0) {
    const host = parsed.host.toLowerCase()
    if (!allowedHosts.some((h) => h.toLowerCase() === host)) {
      return fail(`${label} must point at one of: ${allowedHosts.join(', ')}.`)
    }
  }
  return pass(parsed.toString())
}

/**
 * Parse JSON with a hard byte ceiling and no throwing.
 *
 * `JSON.parse` on an unbounded body is a denial-of-service primitive: the
 * string is already in memory, and the parse allocates again. This function
 * only sees a string that is ALREADY buffered, so for a request body use
 * `readJsonBody`/`readBodyText`, which enforce the cap while reading. Use
 * `safeJson` directly only for text that came from somewhere already bounded.
 *
 * Byte length is measured with TextEncoder, not `String.length`, because a body
 * of astral-plane characters is up to four bytes per code point.
 */
export function safeJson(text: string, maxBytes: number): Result<unknown> {
  const bytes = new TextEncoder().encode(text).length
  if (bytes > maxBytes) {
    return fail(`Request body must be at most ${maxBytes} bytes (got ${bytes}).`)
  }
  if (text.trim().length === 0) return fail('Request body must not be empty.')
  try {
    return pass(JSON.parse(text) as unknown)
  } catch {
    return fail('Request body must be valid JSON.')
  }
}

/** A failed bounded read. `tooLarge` lets a route answer 413 instead of 400. */
export type BodyInvalid = Invalid & { tooLarge: boolean }

function bodyFail(error: string, tooLarge = false): BodyInvalid {
  return { ok: false, error, tooLarge }
}

function tooLargeMessage(maxBytes: number): string {
  return `Request body must be at most ${maxBytes} bytes.`
}

/**
 * Read a request body as text, enforcing `maxBytes` WHILE READING.
 *
 * `await req.text()` followed by `safeJson` measures the body only after the
 * whole thing is already in memory, so the cap protects the parser and nothing
 * else: several concurrent multi-megabyte POSTs would still be buffered in full
 * by a 0.5 GiB replica. This does it in the order that bounds memory:
 *
 *   1. A declared `Content-Length` over the cap is refused before a byte is read.
 *   2. Otherwise the stream is read chunk by chunk with a running total, and the
 *      read is cancelled the moment the total passes the cap, so an attacker who
 *      lies about (or omits) the length, or sends chunked, buffers at most
 *      `maxBytes` plus one chunk.
 *
 * Never throws: a failed or aborted stream is a normal failure result.
 */
export async function readBodyText(
  req: Request,
  maxBytes: number
): Promise<Valid<string> | BodyInvalid> {
  const declared = req.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared.trim())) {
    if (Number(declared.trim()) > maxBytes) return bodyFail(tooLargeMessage(maxBytes), true)
  }

  const stream = req.body
  if (!stream) return pass('')

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        // Stop pulling from the socket; do not wait for the rest of the upload.
        await reader.cancel().catch(() => undefined)
        return bodyFail(tooLargeMessage(maxBytes), true)
      }
      chunks.push(value)
    }
  } catch {
    return bodyFail('Request body could not be read.')
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return pass(new TextDecoder().decode(merged))
}

/**
 * Read AND parse a JSON request body with the byte cap enforced while reading.
 * The drop-in replacement for `safeJson(await req.text(), max)`.
 */
export async function readJsonBody(
  req: Request,
  maxBytes: number
): Promise<Valid<unknown> | BodyInvalid> {
  const text = await readBodyText(req, maxBytes)
  if (!text.ok) return text
  const parsed = safeJson(text.value, maxBytes)
  return parsed.ok ? parsed : bodyFail(parsed.error)
}

/** Narrow an unknown parse result to a plain object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
