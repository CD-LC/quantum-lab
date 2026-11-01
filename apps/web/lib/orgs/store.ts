/**
 * orgs/store.ts — one storage interface, two implementations.
 *
 * Exactly the pattern used by lib/circuit-store.ts: if Supabase is configured
 * AND the visitor has a session, organisations live in the `public.orgs`,
 * `public.org_members` and `public.org_invites` tables (see
 * supabase/schema-orgs.sql). Otherwise everything is kept in browser
 * localStorage under 'quantum-lab.orgs'. Callers never need to know which one
 * is active — apart from storageMode(), which exists purely so the admin
 * console can be honest about where the data went.
 *
 * Nothing here throws at import time, every localStorage read is wrapped in a
 * try/catch that returns a safe default, and every Supabase failure falls
 * through to the local copy rather than surfacing an error.
 *
 * ── WHO THE CALLER IS (audit finding ORG-2) ──────────────────
 * Every function below takes an optional trailing `ctx: OrgContext`.
 *
 * Without it, the store behaves exactly as it always has: it resolves the
 * caller from `getSupabase().auth.getSession()`, the BROWSER client. That is
 * right in the admin console and wrong everywhere else — in a route handler
 * there is no browser session, `getSession()` is always null, and every call
 * fell through to `readLocal()`, which on the server is an empty database. The
 * org API was therefore inert server-side: the authorisation checks in
 * lib/orgs/access.ts passed, and then the handler operated on nothing.
 *
 * With it, the store uses the caller and the client it is HANDED and never asks
 * a browser anything. The context is built in lib/orgs/access.ts — the same
 * module, and the same client-resolution code, that already answers "is this
 * caller an owner of this org?" server-side. There is deliberately only one
 * mechanism: the store does not resolve identity on the server, it is told.
 *
 * The store still does not authorise anything. It is storage. A context is
 * proof of who is calling, never permission to do what they asked; the gate is
 * `requireOrgRole` and it runs in the handler before any call lands here.
 */

import { getSupabase, isSupabaseConfigured } from '@/lib/supabase'
import { hashInviteToken } from '@/lib/orgs/invites'
import { PLAN_BY_ID, type PlanId } from '@/lib/plans'
import type { Org, OrgInvite, OrgMember, OrgMemberStatus, OrgRole } from '@/lib/orgs/types'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * An already-verified caller plus a client that can act for them.
 *
 * `userId` comes from `supabase.auth.getUser(token)` and from nothing else — a
 * user id in a request body or query string is a claim, never a credential.
 * `client` is either the service-role client or an anon client carrying that
 * caller's own token, so RLS evaluates as them. Both are produced by
 * `orgContext()` in lib/orgs/access.ts.
 *
 * A type-only import of SupabaseClient keeps this module free of server-only
 * code: the admin console imports the store into the browser bundle, and
 * access.ts (which reads the service-role key) must never follow it there.
 */
export interface OrgContext {
  /**
   * The verified caller, or null for the one case with no user: resolving and
   * claiming an INVITE, where the token itself is the credential and the
   * recipient may not have an account yet. A null here means "this context may
   * only be used for token-keyed lookups" — `listOrgs` returns nothing for it
   * and `createOrg` refuses it outright, so it cannot be smuggled into a call
   * that needs to know who is asking.
   */
  userId: string | null
  client: SupabaseClient
}

const STORAGE_KEY = 'quantum-lab.orgs'

// ────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────

/**
 * Thrown by addMember when the org has no free seat.
 *
 * This is the CLIENT-SIDE COURTESY only — it exists so the admin console can
 * show a helpful message instead of silently over-filling a licence. The real
 * control is server-side: app/api/orgs/members/route.ts re-checks capacity and
 * answers 409, and the database is the final arbiter. Never rely on this class
 * alone to enforce a licence.
 */
export class SeatLimitError extends Error {
  readonly seatsUsed: number
  readonly seatsTotal: number
  constructor(seatsUsed: number, seatsTotal: number) {
    super(
      `All ${Number.isFinite(seatsTotal) ? seatsTotal : 'available'} seats are in use. ` +
        'Remove or suspend a member, or add seats to your plan.'
    )
    this.name = 'SeatLimitError'
    this.seatsUsed = seatsUsed
    this.seatsTotal = seatsTotal
  }
}

export function isSeatLimitError(err: unknown): err is SeatLimitError {
  return err instanceof SeatLimitError
}

// ────────────────────────────────────────────────────────────
// Row shapes — mirror supabase/schema-orgs.sql
// ────────────────────────────────────────────────────────────

interface OrgRow {
  id: string
  name: string
  slug: string
  plan_id: PlanId
  /** null means unlimited (the University plan) — Postgres has no Infinity. */
  seats_total: number | null
  seats_used: number | null
  domain: string | null
  created_at: string
  owner_id: string
}

interface OrgMemberRow {
  id: string
  org_id: string
  user_id: string | null
  email: string
  role: OrgRole
  status: OrgMemberStatus
  /** Denormalised from the org so entitlements.ts can read it in one query. */
  plan_id: PlanId
  joined_at: string
  last_active_at: string | null
}

interface OrgInviteRow {
  id: string
  org_id: string
  email: string
  role: OrgRole
  /** SHA-256 of the token, hex. The token itself is never stored — see INV-1. */
  token_hash: string
  expires_at: string
  accepted_at: string | null
  created_at: string
}

function rowToOrg(row: OrgRow): Org {
  const org: Org = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    planId: row.plan_id,
    seatsTotal: row.seats_total === null ? Number.POSITIVE_INFINITY : row.seats_total,
    seatsUsed: row.seats_used ?? 0,
    createdAt: row.created_at,
    ownerId: row.owner_id,
  }
  if (row.domain) org.domain = row.domain
  return org
}

function rowToMember(row: OrgMemberRow): OrgMember {
  const member: OrgMember = {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id ?? '',
    email: row.email,
    role: row.role,
    status: row.status,
    joinedAt: row.joined_at,
  }
  if (row.last_active_at) member.lastActiveAt = row.last_active_at
  return member
}

function rowToInvite(row: OrgInviteRow): OrgInvite {
  const invite: OrgInvite = {
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    role: row.role,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
  if (row.accepted_at) invite.acceptedAt = row.accepted_at
  return invite
}

// ────────────────────────────────────────────────────────────
// ids
// ────────────────────────────────────────────────────────────

function newId(prefix: string): string {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID()
    } catch {
      // fall through to the timestamp id
    }
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return base || `org-${Date.now().toString(36)}`
}

// ────────────────────────────────────────────────────────────
// local storage implementation
// ────────────────────────────────────────────────────────────

interface LocalDb {
  orgs: Org[]
  members: OrgMember[]
  invites: OrgInvite[]
}

function emptyDb(): LocalDb {
  return { orgs: [], members: [], invites: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeDb(raw: unknown): LocalDb {
  if (!isRecord(raw)) return emptyDb()
  const orgs = Array.isArray(raw.orgs) ? raw.orgs.filter(isOrgShape) : []
  const members = Array.isArray(raw.members) ? raw.members.filter(isMemberShape) : []
  const invites = Array.isArray(raw.invites) ? raw.invites.filter(isInviteShape) : []
  return { orgs, members, invites }
}

function isOrgShape(value: unknown): value is Org {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.slug === 'string' &&
    typeof value.planId === 'string' &&
    typeof value.seatsTotal === 'number' &&
    typeof value.ownerId === 'string'
  )
}

function isMemberShape(value: unknown): value is OrgMember {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.orgId === 'string' &&
    typeof value.email === 'string' &&
    typeof value.role === 'string' &&
    typeof value.status === 'string'
  )
}

function isInviteShape(value: unknown): value is OrgInvite {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.orgId === 'string' &&
    typeof value.email === 'string' &&
    // SECURITY (audit finding INV-1): a locally stored record from BEFORE this
    // change carries `token` and no `tokenHash`, and its token is forgeable.
    // Requiring `tokenHash` makes every one of those records fail this shape
    // check and be dropped on read, which invalidates them — exactly what
    // should happen to a batch of guessable invites.
    typeof value.tokenHash === 'string' &&
    typeof value.expiresAt === 'string'
  )
}

function readLocal(): LocalDb {
  if (typeof window === 'undefined') return emptyDb()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return seedLocal()
    const db = normalizeDb(JSON.parse(raw) as unknown)
    // A wiped-but-present record still deserves the demo org back.
    if (db.orgs.length === 0) return seedLocal()
    return db
  } catch {
    // Corrupt JSON, disabled storage, or a privacy mode that throws on read.
    return emptyDb()
  }
}

function writeLocal(db: LocalDb): boolean {
  if (typeof window === 'undefined') return false
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
    return true
  } catch {
    // Quota exceeded or storage blocked — the in-memory result is still returned.
    return false
  }
}

// ── demo seeding ──────────────────────────────────────────────
//
// DEMO DATA, LOCAL MODE ONLY. This runs exclusively when Supabase is NOT
// configured and a `window` exists, so it can never reach a production
// database or a server render. It exists so `/admin` is explorable in local
// development instead of showing an empty console. Every id is prefixed
// `demo-` so seeded rows are obvious in the devtools storage inspector.

const DEMO_ORG_ID = 'demo-org-quantum-lab-university'

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

function seedLocal(): LocalDb {
  // Guard twice: seeding must never happen against a configured backend.
  if (typeof window === 'undefined' || isSupabaseConfigured) return emptyDb()

  const org: Org = {
    id: DEMO_ORG_ID,
    name: 'Qubit16 Demo University',
    slug: 'quantum-lab-demo-university',
    planId: 'edu',
    seatsTotal: 25,
    seatsUsed: 6,
    domain: 'demo.university.edu',
    createdAt: daysAgo(180),
    ownerId: 'demo-user-owner',
  }

  const seeded: Array<[string, string, OrgRole, OrgMemberStatus, number, number | null]> = [
    ['demo-member-1', 'a.okonkwo@demo.university.edu', 'owner', 'active', 180, 0],
    ['demo-member-2', 'r.mehta@demo.university.edu', 'admin', 'active', 174, 1],
    ['demo-member-3', 'l.fournier@demo.university.edu', 'member', 'active', 120, 3],
    ['demo-member-4', 'j.tanaka@demo.university.edu', 'member', 'active', 96, 21],
    ['demo-member-5', 's.novak@demo.university.edu', 'member', 'invited', 4, null],
    ['demo-member-6', 'p.almeida@demo.university.edu', 'member', 'suspended', 150, 45],
  ]

  const members: OrgMember[] = seeded.map(([id, email, role, status, joined, active]) => {
    const member: OrgMember = {
      id,
      orgId: org.id,
      userId: `demo-user-${id.slice(-1)}`,
      email,
      role,
      status,
      joinedAt: daysAgo(joined),
    }
    if (active !== null) member.lastActiveAt = daysAgo(active)
    return member
  })

  const db: LocalDb = { orgs: [org], members, invites: [] }
  writeLocal(db)
  return db
}

// ────────────────────────────────────────────────────────────
// supabase plumbing
// ────────────────────────────────────────────────────────────

/** Resolve the signed-in user id, or null when we should use localStorage. */
async function remoteUserId(): Promise<string | null> {
  if (!isSupabaseConfigured) return null
  const supabase = getSupabase()
  if (!supabase) return null
  try {
    const { data, error } = await supabase.auth.getSession()
    if (error) return null
    return data.session?.user.id ?? null
  } catch {
    return null
  }
}

/** A resolved backend: who is asking, and the client that will ask for them. */
interface Remote {
  userId: string | null
  supabase: SupabaseClient
}

/**
 * Resolve the backend for one call, or null to mean "use localStorage".
 *
 * SECURITY FIX (audit finding ORG-2). This is the single place the two identity
 * paths meet:
 *
 *   ctx supplied → SERVER. The caller has already been verified from a bearer
 *                  token by lib/security/auth.ts and gated by
 *                  lib/orgs/access.ts. Use it as given; ask no browser
 *                  anything. This is the path that used to not exist.
 *   ctx absent   → BROWSER. Unchanged: the signed-in session, or null, in which
 *                  case the caller falls through to readLocal().
 *
 * `remoteModeCache` is only touched on the browser path. It backs
 * `storageMode()`, which the admin console renders — a per-process boolean set
 * by whichever request happened to run last is meaningless on a server and
 * would leak one request's state into another's render.
 */
async function remote(ctx?: OrgContext): Promise<Remote | null> {
  if (ctx) return { userId: ctx.userId, supabase: ctx.client }
  const userId = await remoteUserId()
  if (!userId) {
    remoteModeCache = false
    return null
  }
  const supabase = getSupabase()
  if (!supabase) {
    remoteModeCache = false
    return null
  }
  remoteModeCache = true
  return { userId, supabase }
}

/** Note a browser-path fallback to localStorage. No-op on the server path. */
function fellBackToLocal(ctx?: OrgContext): void {
  if (!ctx) remoteModeCache = false
}

let remoteModeCache = false

/**
 * Where the last completed operation stored its data. Synchronous so it can be
 * rendered (and gated on) directly; it reflects the most recent list call.
 */
export function storageMode(): 'supabase' | 'local' {
  return isSupabaseConfigured && remoteModeCache ? 'supabase' : 'local'
}

// ────────────────────────────────────────────────────────────
// Seat accounting
// ────────────────────────────────────────────────────────────

/** A suspended seat is released; invited seats are held. */
export function consumesSeat(status: OrgMemberStatus): boolean {
  return status === 'active' || status === 'invited'
}

function countSeats(members: OrgMember[]): number {
  return members.filter((m) => consumesSeat(m.status)).length
}

export interface SeatUsage {
  used: number
  total: number
  available: number
}

// ────────────────────────────────────────────────────────────
// Public API — organisations
// ────────────────────────────────────────────────────────────

export async function listOrgs(userId: string | null, ctx?: OrgContext): Promise<Org[]> {
  const backend = await remote(ctx)
  if (backend) {
    const supabase = backend.supabase
    try {
      // SECURITY FIX (audit finding ORG-2): on the server path the id is the
      // VERIFIED caller's, never the `userId` argument. `?userId=` on the route
      // is a claim; honouring it here would hand back another user's org list
      // to anyone who could name them. The argument still selects on the
      // browser path, where it is only ever the session's own id anyway.
      // A user-less context (invite lookup) cannot list anyone's orgs.
      if (ctx && !backend.userId) return []
      const subject = ctx ? backend.userId : (userId ?? backend.userId)
      const memberships = await supabase
        .from('org_members')
        .select('org_id')
        .eq('user_id', subject)
      if (!memberships.error && Array.isArray(memberships.data)) {
        const ids = (memberships.data as { org_id: string }[]).map((r) => r.org_id)
        if (ids.length === 0) return []
        const { data, error } = await supabase.from('orgs').select('*').in('id', ids)
        if (!error && Array.isArray(data)) {
          return (data as OrgRow[]).map(rowToOrg)
        }
      }
    } catch {
      // Network failure — fall through to the local copy.
    }
    // A server-side caller has no local copy; an empty list is the honest answer.
    if (ctx) return []
    fellBackToLocal(ctx)
  }
  // Local mode has no real auth, so every locally stored org is visible. That
  // is deliberate: it keeps the demo org reachable however you are "signed in".
  return readLocal().orgs
}

export async function getOrg(orgId: string, ctx?: OrgContext): Promise<Org | null> {
  const backend = await remote(ctx)
  if (backend) {
    try {
      const { data, error } = await backend.supabase
        .from('orgs')
        .select('*')
        .eq('id', orgId)
        .maybeSingle()
      if (!error && data) return rowToOrg(data as OrgRow)
    } catch {
      // Fall through to the local copy.
    }
    // Server-side: no local copy exists, so "not found" is the truth.
    if (ctx) return null
    fellBackToLocal(ctx)
  }
  return readLocal().orgs.find((o) => o.id === orgId) ?? null
}

export interface CreateOrgInput {
  name: string
  planId: PlanId
  ownerId: string
  ownerEmail: string
}

/** Plans that may hold seats. 'free' and 'pro' are single-person plans. */
export function planCanOwnSeats(planId: PlanId): planId is 'team' | 'edu' {
  return planId === 'team' || planId === 'edu'
}

/** The creator's owner seat, in the shape every create path writes it. */
function insertOwnerSeat(supabase: SupabaseClient, org: Org, ownerId: string, email: string) {
  return supabase.from('org_members').insert({
    org_id: org.id,
    user_id: ownerId,
    email,
    role: 'owner',
    status: 'active',
    plan_id: org.planId,
  })
}

/**
 * An org the caller owns on `planId` that has no owner seat: the leftover of a
 * create whose second statement failed. Null when there is none, and also when
 * the lookup itself fails (the normal insert then proceeds as before).
 */
async function findOwnerlessOrg(
  supabase: SupabaseClient,
  ownerId: string,
  planId: PlanId
): Promise<Org | null> {
  try {
    const { data: owned, error } = await supabase
      .from('orgs')
      .select('*')
      .eq('owner_id', ownerId)
      .eq('plan_id', planId)
    if (error || !Array.isArray(owned) || owned.length === 0) return null
    const { data: seats, error: seatError } = await supabase
      .from('org_members')
      .select('org_id')
      .eq('user_id', ownerId)
      .eq('role', 'owner')
    if (seatError || !Array.isArray(seats)) return null
    const seated = new Set((seats as { org_id?: unknown }[]).map((row) => row.org_id))
    const orphan = (owned as OrgRow[]).find((row) => !seated.has(row.id))
    return orphan ? rowToOrg(orphan) : null
  } catch {
    return null
  }
}

export async function createOrg(input: CreateOrgInput, ctx?: OrgContext): Promise<Org> {
  const now = new Date().toISOString()
  const seatsTotal = PLAN_BY_ID[input.planId]?.limits.seats ?? 1
  const slug = slugify(input.name)

  const backend = await remote(ctx)
  if (backend) {
    const supabase = backend.supabase
    // SECURITY FIX (audit finding ORG-2): the owner of a new org is the
    // VERIFIED caller on the server path. `ownerId` is already required to
    // equal the caller by app/api/orgs/route.ts; this makes the store
    // incapable of writing anything else even if that check is ever moved.
    if (ctx && !backend.userId) {
      // A user-less context has no owner to name. Refuse rather than fall back
      // to the caller-supplied `ownerId`, which is a claim, not a credential.
      throw new Error('Creating an organisation requires a signed-in caller.')
    }
    const ownerId = ctx ? (backend.userId as string) : input.ownerId
    try {
      // A previous create may have inserted the org and then failed to seat its
      // owner. RLS gives non-service callers no delete on `orgs`, so that row
      // cannot be rolled back; it would otherwise block a retry (one org per
      // plan) and leave the payer locked out of their own organisation. Repair
      // it by adding the missing owner seat instead of creating a second org.
      const orphan = await findOwnerlessOrg(supabase, ownerId, input.planId)
      if (orphan) {
        const repaired = await insertOwnerSeat(supabase, orphan, ownerId, input.ownerEmail)
        if (repaired?.error) {
          throw new Error(repaired.error.message ?? 'Could not create the owner seat.')
        }
        return orphan
      }

      const { data, error } = await supabase
        .from('orgs')
        .insert({
          name: input.name,
          slug,
          plan_id: input.planId,
          seats_total: Number.isFinite(seatsTotal) ? seatsTotal : null,
          seats_used: 1,
          owner_id: ownerId,
        })
        .select('*')
        .single()
      if (!error && data) {
        const org = rowToOrg(data as OrgRow)
        // The creator always takes the first seat as owner.
        const seat = await insertOwnerSeat(supabase, org, ownerId, input.ownerEmail)
        if (seat?.error) {
          // Fail so the caller is not told it worked. The org row is NOT
          // deleted: RLS gives non-service callers no delete on `orgs`, so a
          // rollback would silently do nothing. The retry finds this ownerless
          // org (findOwnerlessOrg) and seats the owner instead.
          throw new Error(seat.error.message ?? 'Could not create the owner seat.')
        }
        return org
      }
      if (ctx) throw new Error(error?.message ?? 'Could not create the organisation.')
    } catch (err) {
      // On the server there is no local fallback: writing to localStorage would
      // silently discard the org and report success. Report the failure.
      if (ctx) throw err
      // Browser: fall through so a creation is never silently lost.
    }
    fellBackToLocal(ctx)
  }

  const org: Org = {
    id: newId('org'),
    name: input.name,
    slug,
    planId: input.planId,
    seatsTotal,
    seatsUsed: 1,
    createdAt: now,
    ownerId: input.ownerId,
  }
  const owner: OrgMember = {
    id: newId('member'),
    orgId: org.id,
    userId: input.ownerId,
    email: input.ownerEmail,
    role: 'owner',
    status: 'active',
    joinedAt: now,
    lastActiveAt: now,
  }
  const db = readLocal()
  writeLocal({ ...db, orgs: [...db.orgs, org], members: [...db.members, owner] })
  return org
}

export type OrgPatch = Partial<Pick<Org, 'name' | 'domain' | 'planId' | 'seatsTotal'>>

export async function updateOrg(
  orgId: string,
  patch: OrgPatch,
  ctx?: OrgContext
): Promise<Org | null> {
  const backend = await remote(ctx)
  if (backend) {
    try {
      const fields: Record<string, string | number | null> = {}
      if (patch.name !== undefined) fields.name = patch.name
      if (patch.domain !== undefined) fields.domain = patch.domain || null
      if (patch.planId !== undefined) fields.plan_id = patch.planId
      if (patch.seatsTotal !== undefined) {
        fields.seats_total = Number.isFinite(patch.seatsTotal) ? patch.seatsTotal : null
      }
      const { data, error } = await backend.supabase
        .from('orgs')
        .update(fields)
        .eq('id', orgId)
        .select('*')
        .single()
      if (!error && data) return rowToOrg(data as OrgRow)
    } catch {
      // Fall through to the local copy.
    }
    if (ctx) return null
    fellBackToLocal(ctx)
  }

  const db = readLocal()
  const index = db.orgs.findIndex((o) => o.id === orgId)
  if (index === -1) return null
  const current = db.orgs[index]
  const next: Org = {
    ...current,
    name: patch.name ?? current.name,
    planId: patch.planId ?? current.planId,
    seatsTotal: patch.seatsTotal ?? current.seatsTotal,
  }
  if (patch.domain !== undefined) {
    if (patch.domain) next.domain = patch.domain
    else delete next.domain
  }
  const orgs = [...db.orgs]
  orgs[index] = next
  writeLocal({ ...db, orgs })
  return next
}

// ────────────────────────────────────────────────────────────
// Public API — members
// ────────────────────────────────────────────────────────────

export async function listMembers(orgId: string, ctx?: OrgContext): Promise<OrgMember[]> {
  const backend = await remote(ctx)
  if (backend) {
    try {
      const { data, error } = await backend.supabase
        .from('org_members')
        .select('*')
        .eq('org_id', orgId)
        .order('joined_at', { ascending: true })
      if (!error && Array.isArray(data)) {
        return (data as OrgMemberRow[]).map(rowToMember)
      }
    } catch {
      // Fall through to the local copy.
    }
    if (ctx) return []
    fellBackToLocal(ctx)
  }
  return readLocal()
    .members.filter((m) => m.orgId === orgId)
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
}

export async function seatUsage(orgId: string, ctx?: OrgContext): Promise<SeatUsage> {
  const [org, members] = await Promise.all([getOrg(orgId, ctx), listMembers(orgId, ctx)])
  const total = org?.seatsTotal ?? 0
  const used = countSeats(members)
  return {
    used,
    total,
    available: Number.isFinite(total) ? Math.max(0, total - used) : Number.POSITIVE_INFINITY,
  }
}

/**
 * Add a seat. Throws SeatLimitError when the licence is full — see the note on
 * that class: this is the courtesy check, the API route enforces it again.
 */
export interface AddMemberOptions {
  /**
   * The auth.users id to bind the seat to at insert time. Set ONLY by the
   * invite-acceptance route, from the Supabase-verified caller — every
   * authorisation check (lib/orgs/access.ts, entitlements.ts, the RLS helpers)
   * keys on `org_members.user_id`, so a seat written without it is a seat
   * nobody can use. An admin minting an invite leaves it unset: the row is
   * held by email until the invitee claims it.
   */
  userId?: string
}

export async function addMember(
  orgId: string,
  email: string,
  role: OrgRole,
  status: OrgMemberStatus = 'invited',
  ctx?: OrgContext,
  options: AddMemberOptions = {}
): Promise<OrgMember> {
  const trimmed = email.trim().toLowerCase()
  const org = await getOrg(orgId, ctx)
  const members = await listMembers(orgId, ctx)

  const existing = members.find((m) => m.email.toLowerCase() === trimmed)
  if (existing) return existing

  const total = org?.seatsTotal ?? 0
  const used = countSeats(members)
  if (consumesSeat(status) && Number.isFinite(total) && used + 1 > total) {
    throw new SeatLimitError(used, total)
  }

  const now = new Date().toISOString()
  const backend = await remote(ctx)
  if (backend) {
    try {
      const { data, error } = await backend.supabase
        .from('org_members')
        .insert({
          org_id: orgId,
          email: trimmed,
          role,
          status,
          plan_id: org?.planId ?? 'team',
          ...(options.userId ? { user_id: options.userId } : {}),
        })
        .select('*')
        .single()
      if (!error && data) {
        const inserted = rowToMember(data as OrgMemberRow)
        // Seat-cap race. The check above and this insert are two statements,
        // and the service-role client bypasses the database's seat-cap
        // trigger, so two concurrent invites can both pass the check and
        // overshoot the licence. Re-count now that our row exists; if we are
        // over, take it back out and refuse.
        if (ctx && consumesSeat(status) && (await seatsExceeded(orgId, ctx))) {
          await backend.supabase
            .from('org_members')
            .delete()
            .eq('id', inserted.id)
            .eq('org_id', orgId)
          await syncSeatsUsed(orgId, ctx)
          throw new SeatLimitError(used, total)
        }
        await syncSeatsUsed(orgId, ctx)
        return inserted
      }
      if (ctx) throw new Error(error?.message ?? 'Could not add that member.')
    } catch (err) {
      // Server-side there is no localStorage to fall back to; writing there
      // would report a seat that does not exist. Surface the failure instead.
      if (ctx) throw err
      // Browser: fall through so an invite is never silently lost.
    }
    fellBackToLocal(ctx)
  }

  const member: OrgMember = {
    id: newId('member'),
    orgId,
    userId: options.userId ?? '',
    email: trimmed,
    role,
    status,
    joinedAt: now,
  }
  const db = readLocal()
  const nextMembers = [...db.members, member]
  writeLocal({ ...db, members: nextMembers, orgs: withSeatCount(db.orgs, orgId, nextMembers) })
  return member
}

export async function removeMember(
  orgId: string,
  memberId: string,
  ctx?: OrgContext
): Promise<boolean> {
  const backend = await remote(ctx)
  if (backend) {
    try {
      // Read the seat's email first: removing the seat must also kill any
      // invite link still outstanding for that address (see revokeInvites).
      const { data: seat } = await backend.supabase
        .from('org_members')
        .select('email')
        .eq('id', memberId)
        .eq('org_id', orgId)
        .maybeSingle()
      const { error } = await backend.supabase
        .from('org_members')
        .delete()
        .eq('id', memberId)
        .eq('org_id', orgId)
      if (!error) {
        const seatEmail = (seat as { email?: unknown } | null)?.email
        if (typeof seatEmail === 'string') await revokeInvites(orgId, seatEmail, ctx)
        await syncSeatsUsed(orgId, ctx)
        return true
      }
    } catch {
      // Fall through to the local copy.
    }
    if (ctx) return false
    fellBackToLocal(ctx)
  }

  const db = readLocal()
  const removed = db.members.find((m) => m.id === memberId && m.orgId === orgId)
  const members = db.members.filter((m) => !(m.id === memberId && m.orgId === orgId))
  if (members.length === db.members.length) return false
  const burnedAt = new Date().toISOString()
  const invites = removed
    ? db.invites.map((i) =>
        i.orgId === orgId && i.email === removed.email.toLowerCase() && !i.acceptedAt
          ? { ...i, acceptedAt: burnedAt }
          : i
      )
    : db.invites
  writeLocal({ ...db, members, invites, orgs: withSeatCount(db.orgs, orgId, members) })
  return true
}

export async function setMemberRole(
  orgId: string,
  memberId: string,
  role: OrgRole,
  ctx?: OrgContext
): Promise<OrgMember | null> {
  return patchMember(orgId, memberId, { role }, ctx)
}

export async function setMemberStatus(
  orgId: string,
  memberId: string,
  status: OrgMemberStatus,
  ctx?: OrgContext
): Promise<OrgMember | null> {
  // Any status that holds a seat ('active' AND 'invited') re-takes one when the
  // member was suspended, so re-check capacity. Checking only 'active' let a
  // suspended seat be flipped to 'invited' past the cap.
  if (consumesSeat(status)) await assertSeatForActivation(orgId, memberId, ctx)
  const before = ctx ? (await listMembers(orgId, ctx)).find((m) => m.id === memberId) : undefined
  const updated = await patchMember(orgId, memberId, { status }, ctx)
  if (!updated) return updated
  if (status === 'suspended') await revokeInvites(orgId, updated.email, ctx)
  return rollBackIfOverCap(orgId, memberId, before, updated, ctx)
}

/**
 * Seat-cap race guard for a status change made through the service-role client
 * (which skips the database's cap trigger). The pre-check and the write are two
 * statements, so re-count once the write has landed; if the licence is now
 * over, put the seat back to its previous status and refuse. Only meaningful
 * server-side (`ctx` set) and only when the change took a seat.
 */
async function rollBackIfOverCap(
  orgId: string,
  memberId: string,
  before: OrgMember | undefined,
  updated: OrgMember,
  ctx?: OrgContext
): Promise<OrgMember> {
  if (!ctx || !before) return updated
  if (consumesSeat(before.status) || !consumesSeat(updated.status)) return updated
  if (!(await seatsExceeded(orgId, ctx))) return updated
  await patchMember(orgId, memberId, { status: before.status }, ctx)
  const [org, members] = await Promise.all([getOrg(orgId, ctx), listMembers(orgId, ctx)])
  throw new SeatLimitError(countSeats(members), org?.seatsTotal ?? 0)
}

/** True when more seats are held than the licence allows. */
async function seatsExceeded(orgId: string, ctx?: OrgContext): Promise<boolean> {
  const [org, members] = await Promise.all([getOrg(orgId, ctx), listMembers(orgId, ctx)])
  const total = org?.seatsTotal ?? 0
  return Number.isFinite(total) && countSeats(members) > total
}

/**
 * Bind a held seat to the account that claimed it and make it active.
 *
 * ── Why a dedicated call (invite acceptance bug) ─────────────
 * An invited seat is minted by email alone — the person may not have an
 * auth.users row yet — so `org_members.user_id` is NULL until they accept.
 * Acceptance used to call `setMemberStatus(…, 'active')`, which writes only
 * `status`: the seat turned green in the admin console while every check that
 * matters (`requireOrgRole`, `getEntitlement`, the `is_org_member` RLS helper,
 * the progress routes) kept looking for a row with THIS user's id and found
 * none. Every invitee was locked out of the seat they had just claimed.
 *
 * `userId` must be the Supabase-VERIFIED caller whose email matched the
 * invite — app/api/orgs/invite/accept/route.ts is the only legitimate caller.
 * Returns null when the write failed; the caller must not report success.
 */
export async function claimSeat(
  orgId: string,
  memberId: string,
  userId: string,
  ctx?: OrgContext
): Promise<OrgMember | null> {
  await assertSeatForActivation(orgId, memberId, ctx)
  const before = ctx ? (await listMembers(orgId, ctx)).find((m) => m.id === memberId) : undefined
  const claimed = await patchMember(orgId, memberId, { status: 'active', userId }, ctx)
  if (!claimed) return claimed
  return rollBackIfOverCap(orgId, memberId, before, claimed, ctx)
}

/** Throws SeatLimitError if making `memberId` active would exceed the licence. */
async function assertSeatForActivation(
  orgId: string,
  memberId: string,
  ctx?: OrgContext
): Promise<void> {
  const [org, members] = await Promise.all([getOrg(orgId, ctx), listMembers(orgId, ctx)])
  const target = members.find((m) => m.id === memberId)
  const total = org?.seatsTotal ?? 0
  const used = countSeats(members)
  if (target && !consumesSeat(target.status) && Number.isFinite(total) && used + 1 > total) {
    throw new SeatLimitError(used, total)
  }
}

async function patchMember(
  orgId: string,
  memberId: string,
  patch: { role?: OrgRole; status?: OrgMemberStatus; userId?: string },
  ctx?: OrgContext
): Promise<OrgMember | null> {
  const backend = await remote(ctx)
  if (backend) {
    try {
      const fields: Record<string, string> = {}
      if (patch.role) fields.role = patch.role
      if (patch.status) fields.status = patch.status
      if (patch.userId) fields.user_id = patch.userId
      const { data, error } = await backend.supabase
        .from('org_members')
        .update(fields)
        .eq('id', memberId)
        .eq('org_id', orgId)
        .select('*')
        .single()
      if (!error && data) {
        await syncSeatsUsed(orgId, ctx)
        return rowToMember(data as OrgMemberRow)
      }
    } catch {
      // Fall through to the local copy.
    }
    if (ctx) return null
    fellBackToLocal(ctx)
  }

  const db = readLocal()
  const index = db.members.findIndex((m) => m.id === memberId && m.orgId === orgId)
  if (index === -1) return null
  const next: OrgMember = {
    ...db.members[index],
    role: patch.role ?? db.members[index].role,
    status: patch.status ?? db.members[index].status,
    userId: patch.userId ?? db.members[index].userId,
  }
  const members = [...db.members]
  members[index] = next
  writeLocal({ ...db, members, orgs: withSeatCount(db.orgs, orgId, members) })
  return next
}

/** Keep the denormalised orgs.seats_used column honest after a seat change. */
async function syncSeatsUsed(orgId: string, ctx?: OrgContext): Promise<void> {
  const supabase = ctx?.client ?? getSupabase()
  if (!supabase) return
  try {
    const { data, error } = await supabase
      .from('org_members')
      .select('status')
      .eq('org_id', orgId)
    if (error || !Array.isArray(data)) return
    const used = (data as { status: OrgMemberStatus }[]).filter((r) =>
      consumesSeat(r.status)
    ).length
    await supabase.from('orgs').update({ seats_used: used }).eq('id', orgId)
  } catch {
    // A stale counter is cosmetic — seatUsage() recomputes from the rows.
  }
}

function withSeatCount(orgs: Org[], orgId: string, members: OrgMember[]): Org[] {
  const used = countSeats(members.filter((m) => m.orgId === orgId))
  return orgs.map((o) => (o.id === orgId ? { ...o, seatsUsed: used } : o))
}

// ────────────────────────────────────────────────────────────
// Public API — invites
// ────────────────────────────────────────────────────────────

export async function createInviteRecord(
  invite: OrgInvite,
  ctx?: OrgContext
): Promise<OrgInvite> {
  const backend = await remote(ctx)
  if (backend) {
    try {
      const { data, error } = await backend.supabase
        .from('org_invites')
        .insert({
          org_id: invite.orgId,
          email: invite.email,
          role: invite.role,
          // SECURITY FIX (audit finding INV-1): the HASH is stored, never the
          // token. A dump of this table contains no usable invite link.
          token_hash: invite.tokenHash,
          expires_at: invite.expiresAt,
        })
        .select('*')
        .single()
      if (!error && data) return rowToInvite(data as OrgInviteRow)
      if (ctx) throw new Error(error?.message ?? 'Could not record that invite.')
    } catch (err) {
      if (ctx) throw err
      // Browser: fall through to the local copy.
    }
    fellBackToLocal(ctx)
  }

  const db = readLocal()
  writeLocal({ ...db, invites: [...db.invites, invite] })
  return invite
}

/**
 * Look an invite up by the RAW token from the link.
 *
 * SECURITY (audit finding INV-1): the token is hashed here and the hash is what
 * touches the database, so the secret never appears in a query, a query log or
 * a slow-query report. The lookup is the only way to learn which org and email
 * an invite names — the token itself encodes nothing.
 */
export async function getInviteByToken(
  token: string,
  ctx?: OrgContext
): Promise<OrgInvite | null> {
  let tokenHash: string
  try {
    tokenHash = await hashInviteToken(token)
  } catch {
    return null
  }

  const backend = await remote(ctx)
  if (backend) {
    try {
      const { data, error } = await backend.supabase
        .from('org_invites')
        .select('*')
        .eq('token_hash', tokenHash)
        .maybeSingle()
      if (!error && data) return rowToInvite(data as OrgInviteRow)
    } catch {
      // Fall through to the local copy.
    }
    if (ctx) return null
    fellBackToLocal(ctx)
  }
  return readLocal().invites.find((i) => i.tokenHash === tokenHash) ?? null
}

/**
 * Burn an invite. Returns true only if THIS call was the one that claimed it.
 *
 * SECURITY (audit finding INV-1): single use is enforced here, not by the
 * caller reading `acceptedAt` first. The `.is('accepted_at', null)` filter makes
 * the check and the write one statement, so two requests racing on the same
 * link cannot both find it unclaimed and both take a seat. A caller that reads
 * first and writes second has a window; this has none.
 */
export async function markInviteAccepted(
  inviteId: string,
  ctx?: OrgContext
): Promise<boolean> {
  const acceptedAt = new Date().toISOString()

  const backend = await remote(ctx)
  if (backend) {
    try {
      const { data, error } = await backend.supabase
        .from('org_invites')
        .update({ accepted_at: acceptedAt })
        .eq('id', inviteId)
        .is('accepted_at', null)
        .select('id')
      if (!error && Array.isArray(data)) return data.length > 0
    } catch {
      // Fall through to the local copy.
    }
    if (ctx) return false
    fellBackToLocal(ctx)
  }

  const db = readLocal()
  const index = db.invites.findIndex((i) => i.id === inviteId)
  if (index === -1) return false
  if (db.invites[index].acceptedAt) return false
  const invites = [...db.invites]
  invites[index] = { ...invites[index], acceptedAt }
  writeLocal({ ...db, invites })
  return true
}

/**
 * Burn every outstanding invite for `email` in `orgId` (best effort).
 *
 * Removing or suspending a seat used to leave its invite link live for the rest
 * of the 14-day TTL, and accepting it re-created the seat with the invite's
 * role. The row is stamped `accepted_at` rather than deleted so there is still
 * a record that a link existed. The accept route independently refuses an
 * invite whose held seat is gone or suspended; this is the belt to that braces.
 */
export async function revokeInvites(
  orgId: string,
  email: string,
  ctx?: OrgContext
): Promise<void> {
  const address = email.trim().toLowerCase()
  const burnedAt = new Date().toISOString()
  const backend = await remote(ctx)
  if (backend) {
    try {
      await backend.supabase
        .from('org_invites')
        .update({ accepted_at: burnedAt })
        .eq('org_id', orgId)
        .eq('email', address)
        .is('accepted_at', null)
    } catch {
      // Best effort: the accept route re-checks the seat itself.
    }
    return
  }
  const db = readLocal()
  writeLocal({
    ...db,
    invites: db.invites.map((i) =>
      i.orgId === orgId && i.email === address && !i.acceptedAt ? { ...i, acceptedAt: burnedAt } : i
    ),
  })
}

/**
 * Undo `markInviteAccepted` when the seat claim that followed it failed, so the
 * invitee keeps a working link instead of a burned one. Only ever called by the
 * accept route, on the invite it burned moments earlier. Returns true if the
 * invite was restored.
 */
export async function releaseInvite(inviteId: string, ctx?: OrgContext): Promise<boolean> {
  const backend = await remote(ctx)
  if (backend) {
    try {
      const { data, error } = await backend.supabase
        .from('org_invites')
        .update({ accepted_at: null })
        .eq('id', inviteId)
        .select('id')
      return !error && Array.isArray(data) && data.length > 0
    } catch {
      return false
    }
  }
  const db = readLocal()
  const index = db.invites.findIndex((i) => i.id === inviteId)
  if (index === -1) return false
  const invites = [...db.invites]
  const { acceptedAt: _acceptedAt, ...rest } = invites[index]
  invites[index] = rest
  writeLocal({ ...db, invites })
  return true
}
