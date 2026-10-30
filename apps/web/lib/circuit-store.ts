/**
 * circuit-store.ts — one storage interface, two implementations.
 *
 * If Supabase is configured AND the visitor has a session, saved circuits live
 * in the `public.circuits` table. Otherwise everything is kept in browser
 * localStorage under 'quantum-lab.circuits'. Callers never need to know which
 * one is active — apart from storageMode(), which exists purely so the UI can
 * be honest about where the data went.
 *
 * Circuits are serialised as OpenQASM so a saved circuit stays a portable
 * artifact rather than a private JSON shape.
 */

import { fromQasm, toQasm, type Circuit } from '@/lib/quantum'
import { getSupabase, isSupabaseConfigured, type SavedCircuitRow } from '@/lib/supabase'
import { authFetch } from '@/lib/authFetch'

export interface SavedCircuit {
  id: string
  name: string
  description?: string
  qasm: string
  numQubits: number
  createdAt: string
  updatedAt: string
  isPublic?: boolean
}

export interface SaveCircuitInput {
  name: string
  description?: string
  circuit: Circuit
}

export interface UpdateCircuitPatch {
  name?: string
  description?: string
  circuit?: Circuit
}

const STORAGE_KEY = 'quantum-lab.circuits'

// ── ids ───────────────────────────────────────────────────────

function newId(): string {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID()
    } catch {
      // fall through to the timestamp id
    }
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// ── local storage implementation ──────────────────────────────

function readLocal(): SavedCircuit[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isSavedCircuit)
  } catch {
    // Corrupt JSON, disabled storage, or a privacy mode that throws on read.
    return []
  }
}

function isSavedCircuit(value: unknown): value is SavedCircuit {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.qasm === 'string' &&
    typeof v.numQubits === 'number' &&
    typeof v.createdAt === 'string' &&
    typeof v.updatedAt === 'string'
  )
}

function writeLocal(items: SavedCircuit[]): boolean {
  if (typeof window === 'undefined') return false
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
    return true
  } catch {
    // Quota exceeded or storage blocked — the in-memory result is still returned.
    return false
  }
}

function sortByUpdated(items: SavedCircuit[]): SavedCircuit[] {
  return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

// ── supabase implementation ───────────────────────────────────

function rowToSaved(row: SavedCircuitRow): SavedCircuit {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    qasm: row.qasm,
    numQubits: row.num_qubits,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isPublic: row.is_public,
  }
}

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

let remoteModeCache = false

/** The account is at its plan's saved-circuit limit; the message says so. */
export class CircuitLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CircuitLimitError'
  }
}

/** Longest single wait when the server asks the migration to slow down. */
const MIGRATE_MAX_WAIT_MS = 65_000
/** How many consecutive 429 waits one circuit gets before the migration gives up. */
const MIGRATE_MAX_RATE_LIMIT_WAITS = 6

/**
 * Insert one circuit into the signed-in account, through POST /api/circuits.
 *
 * Inserts go through the server, not straight to the table, because that is
 * where the plan's saved-circuit limit is enforced (the database refuses a
 * direct client insert). Returns the new row, throws CircuitLimitError at the
 * limit, and returns null on any other failure so callers can keep the
 * circuit locally instead of losing it.
 */
async function insertRemote(
  fields: {
    name: string
    description: string | null
    qasm: string
    numQubits: number
  },
  /** Filled in with the server's retry-after (ms) when the save was rate limited (429). */
  outcome?: { retryAfterMs?: number }
): Promise<SavedCircuitRow | null> {
  let response: Response
  try {
    response = await authFetch('/api/circuits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    })
  } catch {
    return null
  }
  if (response.status === 429 && outcome) {
    const seconds = Number(response.headers.get('retry-after'))
    outcome.retryAfterMs = Math.min(
      MIGRATE_MAX_WAIT_MS,
      Math.max(1_000, (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1_000)
    )
  }
  const body: unknown = await response.json().catch(() => null)
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  if (response.status === 403 && record.code === 'limit_reached') {
    throw new CircuitLimitError(
      typeof record.error === 'string' ? record.error : 'Saved-circuit limit reached.'
    )
  }
  if (!response.ok || typeof record.circuit !== 'object' || record.circuit === null) return null
  return record.circuit as SavedCircuitRow
}

/**
 * Where the last completed operation stored its data. Synchronous so it can be
 * rendered directly; it reflects the most recent listCircuits()/save call.
 */
export function storageMode(): 'supabase' | 'local' {
  return isSupabaseConfigured && remoteModeCache ? 'supabase' : 'local'
}

// ── public API ────────────────────────────────────────────────

export async function listCircuits(): Promise<SavedCircuit[]> {
  const userId = await remoteUserId()
  remoteModeCache = userId !== null
  if (userId) {
    const supabase = getSupabase()
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('circuits')
          .select('*')
          .eq('user_id', userId)
          .order('updated_at', { ascending: false })
        if (!error && Array.isArray(data)) {
          // Anything still only in this browser (saved offline, or not yet
          // migrated — see migrateLocalCircuits) is shown too. Signing in
          // used to make those circuits vanish from the list.
          const remote = (data as SavedCircuitRow[]).map(rowToSaved)
          return sortByUpdated([...remote, ...readLocal()])
        }
      } catch {
        // Network failure — fall through to the local copy.
      }
    }
    remoteModeCache = false
  }
  return sortByUpdated(readLocal())
}

export async function saveCircuit(input: SaveCircuitInput): Promise<SavedCircuit> {
  const now = new Date().toISOString()
  const qasm = toQasm(input.circuit)
  const description = input.description?.trim() ? input.description.trim() : undefined

  const userId = await remoteUserId()
  if (userId) {
    // CircuitLimitError propagates: at the limit the save must be refused,
    // not quietly diverted into this browser. Any other failure falls through
    // to localStorage so a save is never lost.
    const row = await insertRemote({
      name: input.name,
      description: description ?? null,
      qasm,
      numQubits: input.circuit.numQubits,
    })
    if (row) {
      remoteModeCache = true
      return rowToSaved(row)
    }
  }

  remoteModeCache = false
  const saved: SavedCircuit = {
    id: newId(),
    name: input.name,
    description,
    qasm,
    numQubits: input.circuit.numQubits,
    createdAt: now,
    updatedAt: now,
  }
  writeLocal([saved, ...readLocal()])
  return saved
}

export async function updateCircuit(
  id: string,
  patch: UpdateCircuitPatch
): Promise<SavedCircuit | null> {
  const userId = await remoteUserId()
  if (userId) {
    const supabase = getSupabase()
    if (supabase) {
      try {
        const fields: Record<string, string | number | null> = {}
        if (patch.name !== undefined) fields.name = patch.name
        if (patch.description !== undefined) fields.description = patch.description || null
        if (patch.circuit !== undefined) {
          fields.qasm = toQasm(patch.circuit)
          fields.num_qubits = patch.circuit.numQubits
        }
        const { data, error } = await supabase
          .from('circuits')
          .update(fields)
          .eq('id', id)
          .eq('user_id', userId)
          .select('*')
          .single()
        if (!error && data) {
          remoteModeCache = true
          return rowToSaved(data as SavedCircuitRow)
        }
      } catch {
        // Fall through to the local copy.
      }
    }
  }

  const items = readLocal()
  const index = items.findIndex((item) => item.id === id)
  if (index === -1) return null
  const current = items[index]
  const next: SavedCircuit = {
    ...current,
    name: patch.name ?? current.name,
    description: patch.description !== undefined ? patch.description || undefined : current.description,
    qasm: patch.circuit ? toQasm(patch.circuit) : current.qasm,
    numQubits: patch.circuit ? patch.circuit.numQubits : current.numQubits,
    updatedAt: new Date().toISOString(),
  }
  items[index] = next
  writeLocal(items)
  return next
}

export async function deleteCircuit(id: string): Promise<boolean> {
  const userId = await remoteUserId()
  if (userId) {
    const supabase = getSupabase()
    if (supabase) {
      try {
        const { error } = await supabase
          .from('circuits')
          .delete()
          .eq('id', id)
          .eq('user_id', userId)
        if (!error) {
          remoteModeCache = true
          return true
        }
      } catch {
        // Fall through to the local copy.
      }
    }
  }

  const items = readLocal()
  const next = items.filter((item) => item.id !== id)
  if (next.length === items.length) return false
  writeLocal(next)
  return true
}

export async function getCircuit(id: string): Promise<SavedCircuit | null> {
  const userId = await remoteUserId()
  if (userId) {
    const supabase = getSupabase()
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('circuits')
          .select('*')
          .eq('id', id)
          .maybeSingle()
        if (!error && data) {
          remoteModeCache = true
          return rowToSaved(data as SavedCircuitRow)
        }
      } catch {
        // Fall through to the local copy.
      }
    }
  }
  return readLocal().find((item) => item.id === id) ?? null
}

/**
 * Move circuits saved in this browser into the signed-in user's account.
 *
 * Called by the session store whenever a user becomes known. Idempotent: each
 * circuit that reaches the database is removed from localStorage, so a second
 * run finds nothing to do; one that already exists remotely (same name and
 * QASM) is dropped locally without a duplicate insert. A circuit that fails to
 * upload stays local and is still listed — nothing is ever lost.
 *
 * @returns How many circuits were moved.
 */
let migrating: Promise<number> | null = null
export function migrateLocalCircuits(userId: string): Promise<number> {
  if (!migrating) {
    migrating = doMigrate(userId).finally(() => {
      migrating = null
    })
  }
  return migrating
}

async function doMigrate(userId: string): Promise<number> {
  const local = readLocal()
  if (local.length === 0) return 0
  const supabase = getSupabase()
  if (!supabase) return 0
  if ((await remoteUserId()) !== userId) return 0

  let existing: Set<string>
  try {
    const { data, error } = await supabase
      .from('circuits')
      .select('name, qasm')
      .eq('user_id', userId)
    if (error || !Array.isArray(data)) return 0
    existing = new Set(
      (data as { name: string; qasm: string }[]).map((r) => `${r.name}\u0000${r.qasm}`)
    )
  } catch {
    return 0
  }

  const moved = new Set<string>()
  // Oldest first, so the account keeps the original save order.
  for (const item of [...local].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (existing.has(`${item.name}\u0000${item.qasm}`)) {
      moved.add(item.id)
      continue
    }
    try {
      let row: SavedCircuitRow | null = null
      // A 429 is not a failure: wait for the window the server named and try
      // this same circuit again, so a long local list still migrates in full.
      for (let waits = 0; ; waits += 1) {
        const outcome: { retryAfterMs?: number } = {}
        row = await insertRemote(
          {
            name: item.name,
            description: item.description ?? null,
            qasm: item.qasm,
            numQubits: item.numQubits,
          },
          outcome
        )
        if (row || outcome.retryAfterMs === undefined || waits >= MIGRATE_MAX_RATE_LIMIT_WAITS) break
        await new Promise<void>((resolve) => setTimeout(resolve, outcome.retryAfterMs))
      }
      if (!row) break
      moved.add(item.id)
    } catch {
      // At the plan limit (or unreachable): the rest stay in this browser.
      break
    }
  }

  if (moved.size > 0) {
    // Re-read: the user may have saved something locally while this ran.
    writeLocal(readLocal().filter((item) => !moved.has(item.id)))
  }
  return moved.size
}

/** Rehydrate a saved circuit back into a runnable Circuit. */
export function toCircuit(saved: SavedCircuit): Circuit {
  return fromQasm(saved.qasm)
}

/** "3 minutes ago" style formatting used by the save/load UI. */
export function relativeTime(iso: string): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return 'just now'
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (seconds < 45) return 'just now'
  const units: [number, string][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [2592000, 'month'],
    [31536000, 'year'],
  ]
  let value = seconds
  let label = 'second'
  for (const [size, name] of units) {
    if (seconds < size) break
    value = Math.floor(seconds / size)
    label = name
  }
  return `${value} ${label}${value === 1 ? '' : 's'} ago`
}
