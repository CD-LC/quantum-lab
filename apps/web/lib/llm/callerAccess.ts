/**
 * lib/llm/callerAccess.ts — "does THIS caller get a live model, and have they
 * any daily allowance left?", for surfaces that receive identity as a bare
 * `Authorization` header plus a transport-trusted client address rather than
 * as a Request: the MCP tool registry (lib/mcp/server.ts).
 *
 * It is the same decision app/api/workbench/generate/route.ts and
 * app/api/agent/route.ts make inline — verified identity → entitlement → tier
 * → admin policy → per-day quota — written once so the MCP surface cannot
 * drift from the web routes. Before this module existed, an anonymous MCP
 * caller could spend the operator's model budget with no per-day cap at all
 * while the tutor capped the same caller at `messagesPerDay`.
 *
 * Charging: a `live` result has ALREADY consumed one unit of the caller's
 * daily quota under `quotaPrefix`. Callers therefore ask only when a model is
 * genuinely about to be called (a candidate-only verification never asks).
 *
 * Server-only: it reaches Supabase (identity, entitlement, stored settings)
 * and the rate-limit store. Every dependency degrades to a safe default in an
 * empty environment: no Supabase → anonymous; no provider keys → no model.
 */

import { getEntitlement } from '@/lib/billing/entitlements'
import { resolveForTier, tierOf, type Resolution } from '@/lib/llm/resolve'
import type { TierId } from '@/lib/platform/llmConfig'
import { effectiveLlmSettings } from '@/lib/platform/settings'
import { callerKey, rateLimit } from '@/lib/rateLimit'
import { verifiedCaller } from '@/lib/security/auth'

/** One day, the quota window every tier policy is expressed in. */
export const DAY_MS = 86_400_000

/**
 * What the transport trusted about the caller. `clientIp` MUST be the address
 * the transport itself resolved (Cloudflare's `cf-connecting-ip`, or the hop
 * the transport's own rate limiter keyed on) — never a header copied verbatim
 * from the request, or the caller picks their own quota bucket.
 */
export interface CallerIdentity {
  authorization?: string | null
  clientIp?: string | null
}

export type CallerModelAccess =
  | {
      kind: 'live'
      tier: TierId
      userId: string | null
      resolution: Extract<Resolution, { kind: 'live' }>
    }
  | {
      kind: 'none'
      tier: TierId
      userId: string | null
      reason: 'off' | 'offline' | 'quota_zero' | 'quota_spent'
      /** One sentence a tool can return verbatim; names no provider, host or key. */
      note: string
      /** When the quota window resets (quota_spent only). */
      resetAt?: number
    }

/**
 * Headers for lib/rateLimit's `callerKey` built from the ONE address the
 * transport trusted. `cf-connecting-ip` is the header callerKey trusts first,
 * so this cannot be out-voted by anything else; with no address at all the
 * key collapses to callerKey's shared "unknown" bucket — the safe direction.
 */
export function trustedHeaders(clientIp: string | null | undefined): Headers {
  const headers = new Headers()
  const address = (clientIp ?? '').trim()
  if (address) headers.set('cf-connecting-ip', address.slice(0, 64))
  return headers
}

function tierNoun(tier: TierId): string {
  return tier === 'anonymous' ? 'anonymous callers' : `the ${tier} tier`
}

export async function liveModelForCaller(
  identity: CallerIdentity,
  quotaPrefix: string,
): Promise<CallerModelAccess> {
  // Identity from the transport header only. verifiedCaller() never throws
  // and answers null for a missing, malformed or unverifiable token.
  let userId: string | null = null
  if (identity.authorization) {
    const caller = await verifiedCaller(
      new Request('http://localhost/mcp', { headers: { authorization: identity.authorization } }),
    )
    userId = caller?.id ?? null
  }
  const entitlement = userId ? await getEntitlement(userId) : null
  const tier = tierOf(userId, entitlement)
  const { settings } = await effectiveLlmSettings()
  const resolution = resolveForTier(settings, tier)

  if (resolution.kind === 'off') {
    return {
      kind: 'none',
      tier,
      userId,
      reason: 'off',
      note: `No model: live models are switched off for ${tierNoun(tier)}.`,
    }
  }
  if (resolution.kind === 'offline') {
    return {
      kind: 'none',
      tier,
      userId,
      reason: 'offline',
      note: `No model is configured for ${tierNoun(tier)}; only the candidate (if any) was verified.`,
    }
  }

  const { policy } = resolution
  if (policy.messagesPerDay !== null) {
    if (policy.messagesPerDay <= 0) {
      return {
        kind: 'none',
        tier,
        userId,
        reason: 'quota_zero',
        note: `No model: the daily model allowance for ${tierNoun(tier)} is zero.`,
      }
    }
    const day = await rateLimit(callerKey(trustedHeaders(identity.clientIp), quotaPrefix, userId), {
      limit: policy.messagesPerDay,
      windowMs: DAY_MS,
    })
    if (!day.allowed) {
      const hours = Math.max(1, Math.ceil((day.resetAt - Date.now()) / 3_600_000))
      return {
        kind: 'none',
        tier,
        userId,
        reason: 'quota_spent',
        resetAt: day.resetAt,
        note:
          `No model: today's ${policy.messagesPerDay} model calls for ${tierNoun(tier)} are used ` +
          `(resets in ${hours} h); only the candidate (if any) was verified. ` +
          (tier === 'anonymous' ? 'Sign in for a bigger daily allowance.' : ''),
      }
    }
  }

  return { kind: 'live', tier, userId, resolution }
}
