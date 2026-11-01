/**
 * app/api/mcp/[transport]/route.ts — the Qubit16 MCP endpoint.
 *
 * Speaks MCP over the Streamable HTTP transport in its simplest legal shape:
 * STATELESS, JSON-response-only. Per the transport spec (2025-06-18 §Streamable
 * HTTP) a server answering a POSTed JSON-RPC request may return a single
 * `application/json` object instead of opening an SSE stream, may decline the
 * GET stream with 405, and may issue no session id at all. Every tool here is
 * a pure function over public data, so there is nothing to stream, nothing to
 * push server-initiated, and no session worth holding — statelessness is not a
 * shortcut, it is the accurate description of this server.
 *
 * WHY NO SDK. The current stack for this shape is Vercel's `mcp-handler@2`,
 * which peer-depends on `@modelcontextprotocol/server@2` (the 2026-07-28-spec
 * SDK) and zod 4. What it would do for us — parse one JSON-RPC message,
 * dispatch five methods, serialise one result — is the ~150 lines below, while
 * costing three dependencies and this repo's rule that route handlers keep
 * building in an empty environment (see lib/rateLimit.ts's header for the same
 * argument). The moment this server needs sampling, elicitation, resumable
 * streams or OAuth — the hardware-submission step will need that last one —
 * adopt the SDK; the tool registry in lib/mcp/server.ts is already shaped as
 * (name, schema, handler) precisely so it can be re-registered on an
 * `McpServer` without rewriting a tool.
 *
 * PROTOCOL VERSIONS. This endpoint implements the initialize-handshake
 * lifecycle used by every deployed client today (Claude Desktop/Code, Cursor,
 * ChatGPT) and negotiates any of SUPPORTED_PROTOCOL_VERSIONS. The 2026-07-28
 * revision moved to per-request versioning; its clients fall back to the
 * handshake for servers like this one, per that spec's own compatibility note.
 *
 * SECURITY. Unauthenticated BY DESIGN for every tool except
 * submit_hardware_job: everything else reachable here is public or free
 * content and deterministic computation — see lib/mcp/server.ts's header for
 * the full posture. submit_hardware_job requires the MCP request to carry an
 * `Authorization: Bearer <supabase access token>` header, which this route
 * passes VERBATIM into the tool context (never parsed, never stored, no
 * session created) so the tool can present it to the real
 * /api/hardware/submit route with its entire gate chain intact. The controls
 * that apply to every request:
 *   · Rate limiting via lib/rateLimit.ts, two windows, same shape as
 *     /api/agent. Simulation is CPU, not money, so the limits are looser.
 *   · Body size capped WHILE READING (readJsonBody), like every other route.
 *   · Origin, when a browser sends one, must match this host — the DNS
 *     rebinding guard the transport spec requires. Non-browser MCP clients
 *     send no Origin and are unaffected.
 */

import { NextResponse } from 'next/server'
import { callerKey, rateLimit, retryAfterHeaders } from '@/lib/rateLimit'
import { isRecord, readJsonBody } from '@/lib/security/validate'
import { reportError } from '@/lib/observability/report'
import { callToolAsync, clientAddressFrom, getTool, listToolsResult } from '@/lib/mcp/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── Limits ──────────────────────────────────────────────────

/** Requests per minute per caller. An agent stepping through a circuit makes a
 *  few dozen; a scraper makes thousands. CPU-bound work only, so this can be
 *  five times the tutor's LLM-backed limit. */
const MCP_PER_MINUTE = 60
/** Requests per hour per caller — the backstop that bounds a patient loop. */
const MCP_PER_HOUR = 1_000
/** Body ceiling: the largest legal payload is one tools/call carrying
 *  MCP_MAX_QASM_CHARS of QASM, which is ~20 KB before JSON escaping. */
const MAX_BODY_BYTES = 128_000

/** Handshake protocol revisions this server accepts, newest first. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const PREFERRED_PROTOCOL_VERSION = '2025-06-18'

const SERVER_INFO = {
  name: 'quantum-lab',
  title: 'Qubit16',
  version: '1.0.0',
} as const

const SERVER_INSTRUCTIONS =
  'Qubit16: a teaching-grade quantum toolkit. run_circuit simulates OpenQASM 3 and returns ' +
  'counts plus the full final statevector; get_statevector_at_step inspects the state after any ' +
  'gate; list_challenges/grade_challenge pose and grade circuit puzzles with the same feedback ' +
  'the app gives; generate_challenge creates fresh verified-solvable practice puzzles gradeable ' +
  'by id; get_session_plan turns a caller-supplied progress snapshot into a study plan ' +
  '(stateless, nothing stored); export_notebook renders a circuit as a runnable Qiskit or ' +
  'PennyLane .ipynb; list_lessons/get_lesson serve the free course; get_gate_reference ' +
  'documents the gate set. All of those are read/compute-only and unauthenticated. The one ' +
  'exception is submit_hardware_job, which spends money on real devices and therefore requires ' +
  'an "Authorization: Bearer <supabase access token>" header on the MCP request; it runs the ' +
  'same entitlement and quota gates as the web app and refuses without a token.'

// ── JSON-RPC plumbing ───────────────────────────────────────

type JsonRpcId = string | number | null

interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

function rpcResult(id: JsonRpcId, result: unknown): NextResponse {
  return NextResponse.json({ jsonrpc: '2.0', id, result }, { status: 200 })
}

function rpcError(id: JsonRpcId, error: JsonRpcError, status = 200): NextResponse {
  // Transport-level rejections (400s) still carry a JSON-RPC error body so an
  // MCP client can show something better than "HTTP 400".
  return NextResponse.json({ jsonrpc: '2.0', id, error }, { status })
}

/** 202 with no body — the spec's required answer to accepted notifications. */
function accepted(): Response {
  return new Response(null, { status: 202 })
}

// ── Origin validation (DNS rebinding guard) ─────────────────

/**
 * MCP clients are not browsers and send no Origin; those pass untouched. A
 * request that DOES carry one is a browser context, and the only browser this
 * endpoint serves is our own origin (or localhost in development) — anything
 * else is a web page trying to drive a rebound local server.
 */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return true
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  const host = req.headers.get('host') ?? ''
  if (parsed.host === host) return true
  return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
}

// ── Method handlers ─────────────────────────────────────────

function handleInitialize(id: JsonRpcId, params: unknown): NextResponse {
  const requested =
    isRecord(params) && typeof params.protocolVersion === 'string'
      ? params.protocolVersion
      : undefined
  // Version negotiation per the lifecycle spec: echo the client's version when
  // supported, otherwise answer with ours and let the client decide.
  const protocolVersion =
    requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : PREFERRED_PROTOCOL_VERSION
  return rpcResult(id, {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: SERVER_INSTRUCTIONS,
  })
}

async function handleToolsCall(id: JsonRpcId, params: unknown, req: Request): Promise<NextResponse> {
  if (!isRecord(params) || typeof params.name !== 'string') {
    return rpcError(id, { code: INVALID_PARAMS, message: 'tools/call requires a tool name.' })
  }
  // Unknown tool is a PROTOCOL error (-32602 per the spec's tools docs);
  // failures inside a known tool come back as isError results instead.
  if (!getTool(params.name)) {
    return rpcError(id, { code: INVALID_PARAMS, message: `Unknown tool: ${params.name}` })
  }
  // The context carries the caller's `authorization` header verbatim (how
  // submit_hardware_job and generate_verified_circuit identify the caller:
  // identity from the transport, never from tool arguments) and ONE client
  // address, resolved with the same precedence this route's own rate limiter
  // keys on. The raw `x-forwarded-for` is NOT passed on: Cloudflare only
  // appends to it, so its first hop is client-chosen and forwarding it let a
  // caller pick their own bucket in the hardware route and the daily model
  // quota. Neither value is stored anywhere — the server stays stateless.
  const clientIp = clientAddressFrom(req.headers)
  const ctx = {
    authorization: req.headers.get('authorization'),
    clientIp,
    forwardedFor: clientIp,
  }
  return rpcResult(id, await callToolAsync(params.name, params.arguments, ctx))
}

// ── Route handlers ──────────────────────────────────────────

interface RouteContext {
  params: Promise<{ transport: string }>
}

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { transport } = await ctx.params
    // One MCP endpoint: /api/mcp/mcp. The segment exists so a future SSE
    // compatibility endpoint could sit beside it without moving this one.
    if (transport !== 'mcp') {
      return NextResponse.json({ error: 'Unknown transport. The MCP endpoint is /api/mcp/mcp.' }, { status: 404 })
    }

    if (!originAllowed(req)) {
      return NextResponse.json({ error: 'Origin not allowed.' }, { status: 403 })
    }

    // An unsupported MCP-Protocol-Version header MUST get a 400 (transport
    // spec, "Protocol Version Header"). A missing header is fine — the spec
    // says to assume an older revision, and this server accepts those.
    const versionHeader = req.headers.get('mcp-protocol-version')
    if (versionHeader && !SUPPORTED_PROTOCOL_VERSIONS.includes(versionHeader)) {
      return rpcError(
        null,
        {
          code: INVALID_REQUEST,
          message: `Unsupported MCP-Protocol-Version: ${versionHeader}. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`,
        },
        400,
      )
    }

    const key = callerKey(req.headers, 'mcp')
    const minute = await rateLimit(key, { limit: MCP_PER_MINUTE, windowMs: 60_000 })
    const hour = minute.allowed
      ? await rateLimit(key, { limit: MCP_PER_HOUR, windowMs: 3_600_000 })
      : minute
    if (!minute.allowed || !hour.allowed) {
      const decision = minute.allowed ? hour : minute
      return NextResponse.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: INTERNAL_ERROR, message: 'Rate limit exceeded. Slow down and retry.' },
        },
        { status: 429, headers: retryAfterHeaders(decision) },
      )
    }

    const parsed = await readJsonBody(req, MAX_BODY_BYTES)
    if (!parsed.ok && parsed.tooLarge) {
      return rpcError(null, { code: INVALID_REQUEST, message: parsed.error }, 413)
    }
    if (!parsed.ok) {
      return rpcError(null, { code: PARSE_ERROR, message: parsed.error }, 400)
    }
    const message = parsed.value
    if (Array.isArray(message)) {
      // JSON-RPC batching was removed in the 2025-06-18 revision; keeping this
      // endpoint single-message keeps every response the same shape.
      return rpcError(
        null,
        { code: INVALID_REQUEST, message: 'Batched JSON-RPC is not supported; send one message per POST.' },
        400,
      )
    }
    if (!isRecord(message) || message.jsonrpc !== '2.0') {
      return rpcError(null, { code: INVALID_REQUEST, message: 'Body must be a JSON-RPC 2.0 message.' }, 400)
    }

    const hasId = 'id' in message && (typeof message.id === 'string' || typeof message.id === 'number')
    const id: JsonRpcId = hasId ? (message.id as string | number) : null
    const method = typeof message.method === 'string' ? message.method : undefined

    // Notifications (no id) and client-sent responses (no method): accept, 202.
    if (!method) {
      if ('result' in message || 'error' in message) return accepted()
      return rpcError(null, { code: INVALID_REQUEST, message: 'Message has no method.' }, 400)
    }
    if (!hasId) return accepted()

    switch (method) {
      case 'initialize':
        return handleInitialize(id, message.params)
      case 'ping':
        return rpcResult(id, {})
      case 'tools/list':
        return rpcResult(id, listToolsResult())
      case 'tools/call':
        return await handleToolsCall(id, message.params, req)
      default:
        // Includes resources/* and prompts/*: neither capability is declared,
        // so -32601 is the honest answer, not an empty list.
        return rpcError(id, { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` })
    }
  } catch (err) {
    // Same reporting discipline as /api/agent: nothing from the request body
    // reaches the tracker, only the route name.
    reportError(err, { route: 'api/mcp', stage: 'post' })
    return rpcError(null, { code: INTERNAL_ERROR, message: 'Internal error.' }, 500)
  }
}

/**
 * No server-initiated stream is offered; 405 is the spec's way for a
 * Streamable HTTP server to say so. Clients then simply use POST.
 */
export async function GET(): Promise<Response> {
  return new Response(null, { status: 405, headers: { allow: 'POST' } })
}

/** No sessions exist, so there is nothing to DELETE. 405 per the spec. */
export async function DELETE(): Promise<Response> {
  return new Response(null, { status: 405, headers: { allow: 'POST' } })
}
