/**
 * orgs/invites.ts — invite tokens for seat handover.
 *
 * ############################################################
 * #  THE SCHEME, AND WHY THIS ONE                            #
 * #                                                          #
 * #  SECURITY FIX (audit finding INV-1). What was here       #
 * #  before was a DETERMINISTIC, REVERSIBLE encoding of the  #
 * #  org id and the invitee's email with a djb2 checksum:    #
 * #  anyone could mint a valid token for any (org, email)    #
 * #  pair in two lines of JavaScript and claim a seat on a   #
 * #  stranger's licence. Its own header said so.             #
 * #                                                          #
 * #  Replaced with: a 32-byte CRYPTOGRAPHICALLY RANDOM       #
 * #  token, STORED ONLY AS A SHA-256 HASH, with an EXPIRY    #
 * #  and SINGLE USE.                                         #
 * #                                                          #
 * #  The alternative the audit offered was an HMAC over      #
 * #  (org, email, expiry) with a server secret. It was not   #
 * #  chosen, for three reasons:                              #
 * #                                                          #
 * #   1. SINGLE USE is the property that matters most here.  #
 * #      An invite link travels by email and gets forwarded, #
 * #      logged by mail scanners and pasted into chat. A     #
 * #      stateless HMAC is replayable by everyone who ever   #
 * #      sees it, until it expires. Making it single-use     #
 * #      needs a row to burn — at which point the row exists #
 * #      and the HMAC has bought nothing.                    #
 * #   2. An HMAC needs a server secret. Qubit16 runs     #
 * #      with an entirely empty environment by design, so an #
 * #      unset secret would have to either disable invites   #
 * #      or fall back to something weaker — and a scheme     #
 * #      that is secure only when an optional variable is    #
 * #      set is the failure mode this audit keeps finding.   #
 * #   3. `public.org_invites` already exists, already has an #
 * #      `accepted_at` column, and is already read on the    #
 * #      acceptance path. The row is not a new cost.         #
 * #                                                          #
 * #  Consequences to know about:                             #
 * #   · The token says NOTHING. It is an opaque lookup key,  #
 * #     so the org and email must be read from the stored    #
 * #     row. There is no offline "decode the link" path any  #
 * #     more, and there must not be — that path WAS the      #
 * #     vulnerability.                                       #
 * #   · The raw token exists exactly once, in the response   #
 * #     that mints it. It is never stored, never logged and  #
 * #     cannot be recovered. Losing it means sending a new   #
 * #     invite, which is the correct behaviour.              #
 * ############################################################
 *
 * Not a pure module any more: it uses Web Crypto (`crypto.getRandomValues` and
 * `crypto.subtle.digest`), which is present in browsers and in Node 18+, so it
 * still runs on both sides. There is deliberately NO fallback when Web Crypto
 * is missing — a weak random number here is the whole bug, so this throws
 * rather than quietly issuing a guessable token.
 */

import type { OrgInvite, OrgRole } from '@/lib/orgs/types'

/** How long an invite stays valid. */
export const INVITE_TTL_DAYS = 14

/**
 * Bytes of entropy in a token. 32 bytes = 256 bits, rendered as 64 hex
 * characters. Guessing one is not a thing that happens; the whole token space
 * is not searchable at any request rate, so no per-token rate limit is needed
 * to make this safe.
 */
export const INVITE_TOKEN_BYTES = 32

/** A minted token, exactly as long as it takes to hand it to the caller. */
export interface MintedInvite {
  /** The secret. Goes in the URL, is never stored, never logged. */
  token: string
  /** What IS stored: SHA-256 of the token, hex. */
  tokenHash: string
}

function webCrypto(): Crypto {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (!c || typeof c.getRandomValues !== 'function' || !c.subtle) {
    // Fail loudly. The one thing this module must never do is issue a token
    // that is cheaper to guess than to steal.
    throw new Error(
      'Web Crypto is unavailable, so a secure invite token cannot be minted. ' +
        'This needs a browser or Node 18 or newer.'
    )
  }
  return c
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

/** SHA-256 of a token, hex. This is the value that goes in the database. */
export async function hashInviteToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token)
  const digest = await webCrypto().subtle.digest('SHA-256', data)
  return toHex(new Uint8Array(digest))
}

/**
 * Mint a fresh invite token and its stored hash.
 *
 * The hash is what `createInviteRecord` persists; the token is what goes into
 * the link. A database dump therefore does not contain a single usable invite,
 * which is the same reason password hashes exist.
 */
export async function mintInviteToken(): Promise<MintedInvite> {
  const bytes = new Uint8Array(INVITE_TOKEN_BYTES)
  webCrypto().getRandomValues(bytes)
  const token = toHex(bytes)
  return { token, tokenHash: await hashInviteToken(token) }
}

/**
 * Cheap shape check before a token is hashed and looked up.
 *
 * Not a security control — the lookup is — but it turns obvious junk into a
 * 400 without a database round trip, and bounds the work an anonymous caller
 * can cause by sending a very long string.
 */
export function isInviteToken(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${INVITE_TOKEN_BYTES * 2}}$`).test(value)
}

/** `${origin}/admin?invite=<token>`; falls back to a relative URL server-side. */
export function buildInviteUrl(token: string, origin?: string): string {
  const base =
    origin ??
    (typeof window === 'undefined' ? '' : window.location.origin.replace(/\/+$/, ''))
  return `${base.replace(/\/+$/, '')}/admin?invite=${encodeURIComponent(token)}`
}

/**
 * Is this invite past its expiry?
 *
 * SECURITY (audit finding INV-1): the expiry is read from the STORED ROW, never
 * from the token — the token carries no data at all now. That is the point: an
 * attacker cannot extend an invite's life by editing the link.
 */
export function isInviteExpired(invite: OrgInvite): boolean {
  const at = Date.parse(invite.expiresAt)
  // An unparseable expiry is treated as expired: fail closed, not open.
  if (!Number.isFinite(at)) return true
  return at <= Date.now()
}

/** Has this invite already been used? Single use — see the header. */
export function isInviteAccepted(invite: OrgInvite): boolean {
  return typeof invite.acceptedAt === 'string' && invite.acceptedAt.length > 0
}

/** Everything that makes an invite unusable, in one call. */
export function isInviteUsable(invite: OrgInvite): boolean {
  return !isInviteAccepted(invite) && !isInviteExpired(invite)
}

/** The expiry an invite minted right now should carry. */
export function defaultExpiry(from: Date = new Date()): string {
  return new Date(from.getTime() + INVITE_TTL_DAYS * 86_400_000).toISOString()
}

/** Loose but useful — the server is not the last line of validation here. */
export function isPlausibleEmail(value: string): boolean {
  const trimmed = value.trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) && trimmed.length <= 254
}

/**
 * Build the invite record to persist. The raw token is deliberately NOT part of
 * it — only the hash is, so nothing downstream can accidentally store or log
 * the secret.
 */
export function buildInviteRecord(
  orgId: string,
  email: string,
  role: OrgRole,
  tokenHash: string,
  now: Date = new Date()
): OrgInvite {
  return {
    // The id is derived from the HASH, not the token: it appears in responses
    // and logs, and must not be a shorter way to guess the secret.
    id: `invite-${tokenHash.slice(0, 16)}`,
    orgId,
    email: email.trim().toLowerCase(),
    role,
    tokenHash,
    expiresAt: defaultExpiry(now),
    createdAt: now.toISOString(),
  }
}

/**
 * The organisation name as it may appear in an invitation's subject and body.
 *
 * An org's name is free text chosen by whoever created it, and the invite mail
 * goes out from the product's verified sender to an address the inviter picks.
 * Left raw, the name is a channel for the sender's own message (a URL, a phone
 * number, an instruction) delivered with Qubit16's reputation behind it. So:
 * URLs, bare domains, email addresses and long digit runs are removed, control
 * characters and runs of whitespace are collapsed, and the result is capped.
 * Nothing legitimate loses anything: "Acme Physics Dept" is unchanged.
 */
export function mailSafeOrgName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\S+@\S+/g, ' ')
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|co|me|ly|xyz|info|biz|app|dev|link|click|top|site|online|shop)\b\S*/gi, ' ')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim()
  return cleaned || 'an organisation'
}
