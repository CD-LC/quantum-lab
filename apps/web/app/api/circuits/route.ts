/**
 * POST /api/circuits — save a circuit to the signed-in caller's account.
 *
 * The saved-circuit limit (Free: 10) used to be enforced only in the browser:
 * the client inserted into `public.circuits` directly, so anyone with a session
 * could insert without bound. The limit cannot live in the database either —
 * whether an account is on Pro can depend on the launch trial, which only this
 * server knows (lib/billing/launchTrial.ts). So inserts come through here:
 * the plan is resolved with `getEntitlement`, the account's rows are counted,
 * and the row is written with the service role. Direct client inserts are
 * refused by RLS (supabase/schema-hardening.sql).
 *
 * Reads, renames and deletes stay direct from the browser under the own-row
 * RLS policies — none of them can grow the count.
 */

import { NextResponse } from 'next/server'
import { rateLimit, callerKey, retryAfterHeaders } from '@/lib/rateLimit'
import { signInRequiredResponse, verifiedCallerId } from '@/lib/security/auth'
import { isRecord, readJsonBody, str } from '@/lib/security/validate'
import { getEntitlement, getServiceSupabase } from '@/lib/billing/entitlements'
import { formatLimit, limitsFor, PLAN_BY_ID } from '@/lib/plans'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 30 saves a minute. A person saving by hand never gets near it, but the
 * sign-in migration of locally saved circuits (lib/circuit-store.ts) posts them
 * back to back, and a lower ceiling stalls it. The count-then-insert race is
 * closed by the per-account serialisation below, not by this limit.
 */
const SAVE_LIMIT = { limit: 30, windowMs: 60_000 }

/**
 * Per-account serialisation of the count-then-insert section, within this
 * process. Without it ~N concurrent POSTs from one Free account all read the
 * same count and all insert. This does not span instances: the cross-instance
 * guarantee needs a database-side atomic insert (see the deferred migration
 * note in the audit), so SAVE_LIMIT remains the backstop there.
 */
const saveChains = new Map<string, Promise<unknown>>()

function serialisePerCaller<T>(caller: string, task: () => Promise<T>): Promise<T> {
  const previous = saveChains.get(caller) ?? Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.catch(() => undefined)
  saveChains.set(caller, tail)
  void tail.then(() => {
    if (saveChains.get(caller) === tail) saveChains.delete(caller)
  })
  return run
}

/** A 32-qubit circuit with thousands of gates is well under this. */
const MAX_QASM_CHARS = 200_000

export async function POST(req: Request): Promise<Response> {
  const caller = await verifiedCallerId(req)
  if (!caller) return signInRequiredResponse()

  const decision = await rateLimit(callerKey(req.headers, 'circuits-save', caller), SAVE_LIMIT)
  if (!decision.allowed) {
    return NextResponse.json(
      { error: 'Too many saves. Wait a moment and try again.' },
      { status: 429, headers: retryAfterHeaders(decision) }
    )
  }

  const supabase = getServiceSupabase()
  if (!supabase) {
    return NextResponse.json(
      { error: 'Cloud saving is unavailable: SUPABASE_SERVICE_ROLE_KEY is not configured.' },
      { status: 503 }
    )
  }

  const parsed = await readJsonBody(req, MAX_QASM_CHARS + 8_192)
  if (!parsed.ok && parsed.tooLarge) return NextResponse.json({ error: parsed.error }, { status: 413 })
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  if (!isRecord(parsed.value)) {
    return NextResponse.json({ error: 'Expected a JSON object body.' }, { status: 400 })
  }
  const body = parsed.value

  const name = str(body.name, 120, 'name')
  if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 })
  if (!name.value.trim()) return NextResponse.json({ error: 'Give the circuit a name.' }, { status: 400 })

  let description: string | null = null
  if (body.description !== undefined && body.description !== null && body.description !== '') {
    const d = str(body.description, 2_000, 'description')
    if (!d.ok) return NextResponse.json({ error: d.error }, { status: 400 })
    description = d.value.trim() || null
  }

  const qasm = str(body.qasm, MAX_QASM_CHARS, 'qasm')
  if (!qasm.ok) return NextResponse.json({ error: qasm.error }, { status: 400 })
  if (!/OPENQASM/i.test(qasm.value)) {
    return NextResponse.json({ error: 'qasm must be an OpenQASM program.' }, { status: 400 })
  }

  const numQubits = body.numQubits
  if (typeof numQubits !== 'number' || !Number.isInteger(numQubits) || numQubits < 1 || numQubits > 64) {
    return NextResponse.json({ error: 'numQubits must be an integer from 1 to 64.' }, { status: 400 })
  }

  return serialisePerCaller(caller, async () => {
    const entitlement = await getEntitlement(caller)
    const max = limitsFor(entitlement).maxSavedCircuits
    if (Number.isFinite(max)) {
      const { count, error } = await supabase
        .from('circuits')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', caller)
      if (error) {
        console.error('[api/circuits] count failed', error.message)
        return NextResponse.json({ error: 'Could not save right now. Try again in a moment.' }, { status: 503 })
      }
      if ((count ?? 0) >= max) {
        return NextResponse.json(
          {
            error: `You have saved ${formatLimit(max)} circuits, the ${PLAN_BY_ID[entitlement.planId].name} plan limit. Delete one or upgrade to save more.`,
            code: 'limit_reached',
          },
          { status: 403 }
        )
      }
    }

    const { data, error } = await supabase
      .from('circuits')
      .insert({ user_id: caller, name: name.value.trim(), description, qasm: qasm.value, num_qubits: numQubits })
      .select('*')
      .single()
    if (error || !data) {
      console.error('[api/circuits] insert failed', error?.message)
      return NextResponse.json({ error: 'Could not save right now. Try again in a moment.' }, { status: 503 })
    }
    return NextResponse.json({ circuit: data }, { status: 201, headers: { 'cache-control': 'no-store' } })
  })
}
