/**
 * /api/tools — the plain-REST fallback for agent platforms that cannot speak
 * MCP (roadmap stage A5; Vegaduta's HTTP-tool integration is the motivating
 * caller). docs/INTEGRATIONS.md is the contract.
 *
 * This route OWNS NOTHING. It is a thin dispatcher over the same registry
 * `app/api/mcp/[transport]` serves — imported READ-ONLY from lib/mcp/server.ts
 * — so a clamp, a limit or a paywall decision made there is automatically true
 * here, and the two surfaces cannot drift. If a tool's behaviour looks wrong,
 * fix the registry (or the module it wraps), never this file.
 *
 * Only run_circuit and grade_challenge are exposed. That is the minimal
 * surface an external agent needs to DO something (simulate, get graded); the
 * registry's read-the-course tools stay MCP-only because a REST caller that
 * wants catalogue data can use the MCP endpoint like everyone else, and every
 * name added here is another anonymous compute surface to defend. Widening the
 * list is a one-line change made deliberately, not a default.
 *
 * Anonymous by design, exactly like /api/mcp: both tools are compute-only over
 * public content (see lib/mcp/server.ts's security posture), so the only gate
 * needed is the rate limit — IP-keyed, with the honest ceiling described in
 * lib/rateLimit.ts.
 */

import { NextResponse } from 'next/server'
import { apiError, badRequest } from '@/lib/apiError'
import { callerKey, rateLimit, retryAfterHeaders, type RateLimitRule } from '@/lib/rateLimit'
import { isRecord, readJsonBody, str } from '@/lib/security/validate'
import { callTool, getTool } from '@/lib/mcp/server'

export const runtime = 'nodejs'

/** Same shape of bound the MCP transport applies: simulation costs CPU. */
const TOOLS_LIMIT: RateLimitRule = { limit: 30, windowMs: 60_000 }

/** QASM tops out at 20k chars (MCP_MAX_QASM_CHARS); 64 KiB leaves headroom
 *  for JSON escaping without accepting megabyte bodies. */
const MAX_BODY_BYTES = 65_536

/** The REST subset. Names must exist in lib/mcp/server.ts's registry. */
const REST_TOOLS = ['run_circuit', 'grade_challenge'] as const

export async function GET(req: Request): Promise<Response> {
  const limited = await rateLimit(callerKey(req.headers, 'tools'), TOOLS_LIMIT)
  if (!limited.allowed) return apiError('rate_limited', { headers: retryAfterHeaders(limited) })

  // The discovery payload: the registry's own schemas, filtered to the REST
  // subset, so what this route documents is definitionally what it runs.
  return NextResponse.json({
    tools: REST_TOOLS.map((name) => {
      const def = getTool(name)
      return def
        ? { name: def.name, title: def.title, description: def.description, inputSchema: def.inputSchema }
        : { name }
    }),
    usage: 'POST {"tool": "<name>", "args": {…}} to this same URL.',
    mcp: 'Prefer the MCP endpoint at /api/mcp/mcp when your platform supports it — it has more tools.',
  })
}

export async function POST(req: Request): Promise<Response> {
  const limited = await rateLimit(callerKey(req.headers, 'tools'), TOOLS_LIMIT)
  if (!limited.allowed) return apiError('rate_limited', { headers: retryAfterHeaders(limited) })

  const parsed = await readJsonBody(req, MAX_BODY_BYTES)
  if (!parsed.ok && parsed.tooLarge) return apiError('payload_too_large')
  if (!parsed.ok) return badRequest(parsed.error)
  if (!isRecord(parsed.value)) return badRequest('Expected a JSON object: {"tool": string, "args": object}.')

  const tool = str(parsed.value.tool, 64, 'tool')
  if (!tool.ok) return badRequest(tool.error)
  if (!(REST_TOOLS as readonly string[]).includes(tool.value)) {
    // Unknown-name is a 400 here (the JSON-RPC transport makes it a protocol
    // error for the same reason): it is a caller bug, not a tool result.
    return badRequest(`Unknown tool "${tool.value}". Available: ${REST_TOOLS.join(', ')}.`)
  }

  const args = isRecord(parsed.value.args) ? parsed.value.args : {}
  // callTool never throws and applies every clamp the registry defines
  // (qubit ceiling, shot clamp, QASM size) — see lib/mcp/server.ts.
  const result = callTool(tool.value, args)

  if (result.isError) {
    // Tool-level failure (bad QASM, unknown challenge id): 200 would hide it
    // from naive HTTP clients, 500 would blame the server. 422 says "your
    // input, specifically" and carries the same actionable message MCP
    // clients get.
    return NextResponse.json(
      { tool: tool.value, ok: false, error: result.content[0]?.text ?? 'Tool failed.' },
      { status: 422 }
    )
  }
  return NextResponse.json({ tool: tool.value, ok: true, result: result.structuredContent ?? null })
}
