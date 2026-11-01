# MCP Server

Quantum Lab exposes its teaching-grade quantum tools over the
[Model Context Protocol](https://modelcontextprotocol.io), so any MCP-capable
agent platform — Claude Desktop, Claude Code, Cursor, ChatGPT, or a custom
LangChain/Vegaduta agent — can run circuits, inspect statevectors mid-circuit,
generate and grade challenges, build study plans, export runnable notebooks,
read the free course, and (with a bearer token) submit to real hardware, using
exactly the same engines and gates the web app uses. The workbench adds two
result-producing families on top: `generate_verified_circuit` (a
generate → verify → repair loop against a spec you write) and the experiment
record tools (`create_experiment` … `get_experiment`), which an agent uses to
run and write up an experiment that `/workbench/experiments` then displays.

Seventeen tools in total: eleven core, one for verified generation, five for
experiment records.

**Endpoint:** `POST https://<your-deployment>/api/mcp/mcp`
(locally: `http://localhost:3000/api/mcp/mcp`)

**Transport:** Streamable HTTP, stateless JSON mode. Every JSON-RPC request is
answered with a single `application/json` response; the server opens no SSE
stream (`GET` returns 405, which the spec defines as "no server-initiated
stream offered") and issues no session id. Supported handshake protocol
revisions: `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`.

**Code:**

| File | Role |
| --- | --- |
| `apps/web/lib/mcp/server.ts` | Tool registry — thin wrappers over `lib/quantum.ts`, `lib/challenges`, `lib/lessons` |
| `apps/web/app/api/mcp/[transport]/route.ts` | JSON-RPC / Streamable HTTP endpoint, rate limiting, origin guard |
| `apps/web/lib/mcp/tools.test.ts` | Tests for every tool and for the protocol layer |
| `apps/web/lib/workbench/mcpTool.ts`, `lib/workbench/generate.ts`, `lib/workbench/verify.ts` | `generate_verified_circuit`: input schema and parsing, the generate → verify → repair loop, the exact verifier |
| `apps/web/lib/workbench/experimentTools.ts` | The experiment-record tools (targets, steps, conclusions); tests in `lib/workbench/*.test.ts` |

No SDK dependency: the stateless subset of the transport is ~150 lines, and the
repo's rule is that route handlers keep building in an empty environment (see
`lib/rateLimit.ts`). The registry is shaped as `(name, inputSchema, handler)`
so it can be re-registered on `@modelcontextprotocol/server`'s `McpServer` via
Vercel's `mcp-handler` the day this server needs OAuth, sampling, or resumable
streams — the route's header comment records that upgrade path.

---

## Connecting

### Claude Code

```bash
claude mcp add --transport http quantum-lab https://<your-deployment>/api/mcp/mcp
```

or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "quantum-lab": {
      "type": "http",
      "url": "https://<your-deployment>/api/mcp/mcp"
    }
  }
}
```

### Claude Desktop

Settings → Connectors → **Add custom connector**, with the endpoint URL. No
authentication is required for anything except `submit_hardware_job` (see
[Security posture](#security-posture) and
[Hardware authentication](#hardware-authentication)).

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "quantum-lab": { "url": "https://<your-deployment>/api/mcp/mcp" }
  }
}
```

### ChatGPT

Settings → Connectors (developer mode) → add the endpoint URL as a custom
connector.

### Smoke test with curl

```bash
curl -s https://<your-deployment>/api/mcp/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## Tools

All tool results carry the payload twice: as `structuredContent` (for clients
on protocol `2025-06-18`+) and as the same JSON pretty-printed into a `text`
content block (for older clients). Bitstring labels are MSB-first — qubit 0 is
the rightmost character — matching Qiskit's display convention.

### `run_circuit`

Simulate OpenQASM 3 on an ideal statevector simulator and sample measurement
outcomes. The differentiator: it returns the **final statevector amplitudes**
alongside the counts, so an agent can reason about phases — most MCP quantum
sims stop at counts.

Input:

```json
{
  "qasm": "OPENQASM 3.0;\ninclude \"stdgates.inc\";\nqubit[2] q;\nh q[0];\ncx q[0], q[1];",
  "shots": 4096,
  "seed": 42
}
```

`shots` is clamped to 1–4096 (default 1024); `seed` is optional and makes the
sampling reproducible. Registers are capped at 16 qubits, and a circuit is
capped at **1,000 gates** (see [Circuit size limits](#circuit-size-limits)).
Supported gates:
`h x y z s sdg t tdg sx sxdg rx ry rz p cx cy cz swap ccx cswap` (controls
listed first), plus `ctrl(n) @ x …` for a multi-controlled X, `barrier`, a
custom unitary declared as a `gate` definition, and the register blocks the
app exports (`qb16_add_<k>_mod_<N>_w<width>`, `qb16_mul_<k>_mod_<N>_w<width>`,
`qb16_qft_w<width>`, `qb16_iqft_w<width>`). `get_gate_reference` lists the
QASM spelling of every one of them.

Output (`structuredContent`):

```json
{
  "numQubits": 2,
  "gateCount": 2,
  "shots": 4096,
  "counts": { "00": 2049, "11": 2047 },
  "statevector": [
    { "state": "00", "re": 0.7071067811865476, "im": 0, "probability": 0.5 },
    { "state": "11", "re": 0.7071067811865476, "im": 0, "probability": 0.5 }
  ],
  "omittedNearZeroAmplitudes": 2,
  "conventions": "Bitstring labels are MSB-first (qubit 0 is the rightmost character), matching Qiskit."
}
```

Amplitudes with magnitude below 1e-10 are omitted and counted in
`omittedNearZeroAmplitudes`, so a 16-qubit reply stays kilobytes, not
megabytes, and "sparse" is distinguishable from "missing".

**Measurement.** `counts` come from the exact output distribution. Measuring
qubits at the end of the circuit (the usual "measure every qubit") is always
exact at every size up to 16 qubits, and so is a circuit with a moderate amount
of mid-circuit measurement, reset or classically controlled gates. Only when
that branching is too large to enumerate does the tool fall back to an
estimate averaged over sampled trajectories; the reply then carries
`"approximate": true`, `trajectories` (how many were averaged) and an
`approximationNote`. The fields are absent from an exact result. The
`statevector` of a circuit with mid-circuit measurement is one measurement
trajectory (not the mixture), the same one `get_statevector_at_step` follows.

### `get_statevector_at_step`

The step-through inspector's engine: the state **after step N**, where step 0
is the initial |0…0⟩ and step k is the state after the k-th gate. Also returns
each qubit's Bloch vector and entanglement entropy at that step — watch
entanglement appear gate by gate.

Input: `{ "qasm": "…", "step": 1 }` · Output adds `step`, `totalSteps`,
`appliedGate` (`null` at step 0), `statevector` (same sparse shape as above),
and `blochVectors: [{ qubit, x, y, z, entanglementEntropy }]`. An out-of-range
step is an error naming the valid range. The circuit is capped at 1,000 gates
(see [Circuit size limits](#circuit-size-limits)). For a circuit with
measurement or classical control, step N is a prefix of the same measurement
trajectory `run_circuit` reports in its `statevector`, so the last step equals
that statevector.

### Circuit size limits

Every tool that takes a `qasm` argument and simulates, exports or submits it —
`run_circuit`, `get_statevector_at_step`, `export_notebook`,
`submit_hardware_job` and the experiment tool `run_step` — rejects a circuit
that parses to more than **1,000 gates** before doing any work. The tool error
reads:

> This circuit has 1200 gates; the ceiling is 1000. Split it into shorter
> circuits or drop the repeated section.

(with the actual gate count). `submit_hardware_job` applies this ceiling in
addition to the hardware route's own limits, which are checked afterwards.
The 16-qubit register cap has its own message, and a QASM text over the size
cap is rejected as too long.

### `list_challenges`

The full challenge catalogue: `id`, `title`, `brief`, `kind`
(`target-state` / `target-distribution` / `gate-golf` / `fix-the-bug` /
`oracle`), `level`, `numQubits`, `lessonSlug`, `maxGates`, `hintCount`, and —
where the challenge hands the learner fixed apparatus — `startingCircuitQasm`.
Hints themselves are withheld here so a solver earns them.

### `grade_challenge`

Grade an OpenQASM 3 attempt against a challenge id with the **same
deterministic grader the UI uses** — phase-aware for oracle challenges, blind
to global phase everywhere (see `lib/challenges/grade.ts`). Accepts both
catalogue ids from `list_challenges` and **generated ids** from
`generate_challenge` (`gen-<kind>-d<difficulty>-s<seed>`): a generated id
encodes everything needed to deterministically rebuild the challenge, so the
regrade sees bit-for-bit the puzzle the generator returned. This is why no
server-side state exists for generated challenges — the id *is* the challenge
params.

Input: `{ "challenge_id": "flip-it", "qasm": "OPENQASM 3.0;\nqubit[1] q;\nx q[0];" }`

Output:

```json
{
  "challengeId": "flip-it",
  "passed": true,
  "score": 1,
  "summary": "Solved in 1 gate.",
  "checks": [
    { "label": "Register size", "passed": true, "detail": "1 qubit, as the challenge asks." },
    { "label": "Output distribution", "passed": true, "detail": "Every basis state is on target. …" }
  ],
  "gateCount": 1,
  "parCount": 1,
  "successNote": "X is the quantum NOT: …",
  "hint": null
}
```

A failed attempt gets `passed: false`, the per-check feedback, and the
challenge's **first** hint; further hints stay in the app.

### `generate_challenge`

Generate a fresh practice challenge — "more like this, please" — from
`lib/challenges/generate.ts`. Deterministic: the same
`(kind, difficulty, seed)` always yields the same challenge, and **every
challenge is verified solvable by execution before it is returned**: the
generator runs its own reference solution through the real simulator and
grader and asserts a full pass, that the empty circuit fails (no degenerate
targets), and that every solution gate matters (par is tight). For
`fix-the-bug`, the broken starting circuit is also confirmed to fail.

Input:

```json
{ "kind": "target-distribution", "difficulty": 2, "seed": 7 }
```

`kind` is `target-state` | `target-distribution` | `fix-the-bug`; `difficulty`
1–3 maps to 1–3 qubits and 2–3 gates; `seed` (default 0) is the reproducibility
handle.

Output: `id` (e.g. `gen-target-distribution-d2-s7`), `title`, `brief`, `kind`,
`level`, `difficulty`, `seed`, `numQubits`, `lessonSlug`, `maxGates` (the
verified par), `tolerance`, `targetProbabilities` (basis states 0…2ⁿ−1,
MSB-first labels), `startingCircuitQasm` (fix-the-bug only), and `hintCount`.
Hints and the reference solution are **withheld** — they would hand over the
answer with the puzzle. Grade attempts with `grade_challenge` using the
returned `id`; a failed grade earns the first hint.

### `get_session_plan`

Turn a learner progress snapshot into a structured study plan, using the same
recommender as the `/coach` page (`lib/coach/sessionPlan.ts`). **Stateless by
design**: the caller supplies the snapshot, the plan is computed from the
arguments alone, nothing is stored, and the same snapshot always yields the
same plan.

Input:

```json
{
  "progress": {
    "completed": ["what-is-a-qubit"],
    "quizScores": { "what-is-a-qubit": 0.5 }
  },
  "exam_attempts": [{ "examId": "foundations", "score": 0.8 }],
  "goal": "grover"
}
```

Only `progress` is required (pass `{}` for a brand-new learner and get the
start-here plan). Junk fields are dropped, not rejected.

Output: `weakSkills` (started concepts below the 70% mastery bar, with rounded
mastery), `nextConcepts` (unlocked lesson slugs in recommendation order), and
`suggestedSession` — up to four steps, `diagnose → teach → practice → check`,
each with a concrete ref (`lessonSlug`, `challengeId`, or `vizRoute`) and a
one-sentence note.

### `export_notebook`

Build a runnable Jupyter notebook from an OpenQASM 3 circuit — the same
export the app's editor offers (`lib/export/notebook.ts`).

Input: `{ "qasm": "…", "variant": "qiskit" | "pennylane", "name": "Bell pair" }`

Output: `{ variant, filename, numQubits, gateCount, notebook }` where
`notebook` is the complete `.ipynb` JSON (nbformat 4.5, Colab-compatible cell
ids) as a string — save it to the suggested `filename`. The `qiskit` variant
loads the QASM via `qiskit.qasm3` and runs on Aer or the reference Sampler;
the `pennylane` variant rebuilds the circuit gate by gate, since PennyLane has
no QASM 3 importer. Exports are deterministic: the same circuit produces a
byte-identical notebook.

### `submit_hardware_job`

Submit a circuit to a real quantum device (IBM or AWS Braket). **This spends
real money and is the one authenticated tool** — see
[Hardware authentication](#hardware-authentication).

Input:

```json
{ "qasm": "…", "backend": "ibm_brisbane", "shots": 1024, "provider": "ibm" }
```

(`provider` is optional; it is derived from the backend id.) A successful
submission returns `{ submitted: true, status, job: { job_id, provider, … } }`;
poll the job from the app's `/hardware` page. Refusals come back as tool
errors carrying the gate's own message — 401 (no/invalid token), 402 (plan
without `hardware.real`, or the monthly job allowance is spent), 429 (rate
limited), 503 (quota store unavailable — fail closed).

### `list_lessons`

Metadata for all 14 course lessons plus the two tracks: `slug`, `title`,
`subtitle`, `level`, `minutes`, `prerequisites`, `objectives`, `track`, and
`free` (true for the eight foundations lessons, false for the six advanced
ones).

### `get_lesson`

One lesson by slug. A **free** lesson includes its full `body` — prose blocks,
code, quizzes, key points. A **paid** (advanced-track) lesson returns metadata
only: `body: null`, `bodyWithheld: true`, and a note pointing at the app. The
body module is never even queried for a paid slug — the paywall is control
flow, not filtering.

### `get_gate_reference`

The full gate library the circuit-builder palette shows: `name`, `label`,
`qasmName`, `arity`, `variadic` (true for the multi-controlled X and the
register blocks, whose width is chosen when they are placed), `takesAngle`, and
a teaching description per gate, plus a usage note for angles, controls,
`ctrl(n) @ x`, and the `qb16_*` register-block definitions.

### `generate_verified_circuit`

The workbench's verified generation (`/workbench/generate`) as a tool. Give it
a **spec** — a target measurement distribution, a target statevector, or a
target unitary, with optional gate-set / depth / gate-count constraints — and
it runs a generate → verify → repair loop: a model proposes an OpenQASM 3
circuit, the exact statevector simulator checks it against the spec, and on
failure the diagnostics (which basis states are off and by how much, the
fidelity, which gates violate a constraint) are fed back for another round.
Every attempt comes back with its circuit, verdict and diff.

Input:

```json
{
  "spec": {
    "numQubits": 2,
    "target": { "kind": "distribution", "probabilities": { "00": 0.5, "11": 0.5 }, "tolerance": 0.02 },
    "constraints": { "allowedGates": ["H", "CX"], "maxDepth": 4 }
  },
  "max_attempts": 3,
  "candidate_qasm": "OPENQASM 3.0;\ninclude \"stdgates.inc\";\nqubit[2] q;\nh q[0];\ncx q[0], q[1];"
}
```

`spec.target` is one of:

| `kind` | Fields | Passes when |
| --- | --- | --- |
| `distribution` | `probabilities` (MSB-first labels → p; unlisted labels are 0; must sum to 1), `tolerance?` | every label is within tolerance |
| `statevector` | `amplitudes` (2ⁿ numbers or `{re, im}`), `minFidelity?` | \|⟨t\|ψ⟩\|² ≥ minFidelity, up to global phase |
| `unitary` | `matrix` (row-major 2ⁿ×2ⁿ), `minFidelity?` | \|Tr(V†U)\|²/d² ≥ minFidelity, up to global phase |

`constraints` is `{ maxQubits?, allowedGates?, maxDepth?, maxGates? }`.
`max_attempts` is 1–6 (default 3); a supplied `candidate_qasm` counts as a
round and is verified **first** — if it passes, no model is called at all, so
`candidate_qasm` with `max_attempts: 1` makes the tool a pure verifier that
needs no model.

Output (`structuredContent`): `ok`, `stopped` (why the loop ended), `error`,
`provider` and `modelCalls` (which model was used, how many times), `circuit`
and `qasm` (the passing circuit, or null), `attempts[]` (each with its QASM,
verdict and diagnostics), the `spec` echoed back, and a `caveat`. A
`providerNote` is added when no model is configured for the caller's tier —
then only the candidate, if any, was verified.

What a pass means: the circuit matches **your** spec on an ideal simulator.
It says nothing about whether the spec is what you meant, and nothing about
hardware.

### Experiment records — `create_experiment`, `run_step`, `conclude_experiment`, `list_experiments`, `get_experiment`

The workbench's lab notebook (`apps/web/lib/workbench/experimentTools.ts`,
read at `/workbench/experiments`). An agent opens a record with a hypothesis,
appends one step per circuit it runs — the exact QASM, the **target** it ran
on, the result and a note — and closes it with a conclusion. Steps are
append-only; a concluded record refuses new ones.

Targets (`apps/web/lib/workbench/targets.ts`):

| `target` | What runs | Result |
| --- | --- | --- |
| `"simulator"` or `{ "kind": "simulator" }` | `run()` from `lib/quantum.ts`, ≤ 16 qubits | counts + sparse amplitudes |
| `{ "kind": "noisy-simulator", "depolarizing1": 0.001, "depolarizing2": 0.01, "readoutError": 0.02 }` | a Pauli-error model on the same engine: depolarising after every 1-qubit gate (p₁) and 2-qubit gate (p₂), independent readout flips (r); ≤ 10 qubits; every parameter optional with those defaults | counts + `erroredShots` |
| `{ "kind": "hardware", "backend": "ibm_brisbane", "provider": "ibm" }` | the **same pass-through as `submit_hardware_job`** — an internal request to `/api/hardware/submit` with the caller's bearer token, every gate intact | the job handle; a refusal records nothing |

The noise model is tested against its closed forms (`targets.test.ts`):
|0⟩→X under p₁ reads 0 with probability p₁/2; a Bell pair under p₂ shows odd
parity with probability p₂/2; readout error r on |0⟩ reads 1 with probability r.
It is a model, not a device — no T1/T2, crosstalk, leakage or correlated readout.

```json
{ "title": "Bell pair under two-qubit noise",
  "hypothesis": "Odd-parity counts appear at about p2/2 when CX is depolarised with probability p2." }
```
→ `{ id, title, hypothesis, steps: [], conclusion: null, createdAt, owner, url }`

```json
{ "experiment_id": "<id>", "qasm": "…", "target": { "kind": "noisy-simulator", "depolarizing2": 0.05 },
  "shots": 4096, "seed": 1, "note": "Prediction: ~2.5% odd parity." }
```
→ `{ experimentId, stepIndex, stepCount, target, targetLabel, result, note, url }`

`conclude_experiment` takes `{ experiment_id, conclusion }` and returns the
full record; `list_experiments` (`{ limit? }`) returns summaries newest first
plus `storage` (`memory` or `supabase`); `get_experiment` returns one record
with every step. Shots clamp to 1–4096 (default 1024); `seed` makes simulator
counts reproducible.

**Storage and visibility.** With `SUPABASE_SERVICE_ROLE_KEY` set, records live
in `public.experiments` / `public.experiment_steps`
(`supabase/schema-experiments.sql`, service-role only, RLS on with no policy).
Without it they live in the server process's memory — at most 200 records of
200 steps, gone on restart, not shared between serverless instances — and the
page says which. Writing a record spends no money, so these tools need no
token; `owner` is set to the verified caller when a bearer token was present
and is attribution only. **Every record on a deployment is readable by anyone
who can open the page**, and the tool descriptions tell agents so.

---

## Rate limits

Enforced by `lib/rateLimit.ts` — the same shared-store limiter as `/api/agent`
(Redis-backed when `UPSTASH_REDIS_REST_URL`/`KV_REST_API_URL` are configured,
per-instance in-memory otherwise; read that module's header before quoting
these as a hard control):

| Window | Limit |
| --- | --- |
| Per minute, per caller | 60 requests |
| Per hour, per caller | 1 000 requests |
| Request body | 128 KB |
| QASM per call | 20 000 characters |
| Qubits | 16 |
| Shots | 4 096 (clamped, not rejected) |

429 responses carry `retry-after` and `x-ratelimit-reset` headers.

---

## Hardware authentication

`submit_hardware_job` is the only tool that needs an identity, because it is
the only tool that spends money. The auth story:

- **Send a Supabase access token as a Bearer header on the MCP request.** The
  same token the web app holds after sign-in (`supabase.auth.getSession()`
  → `session.access_token`). For Claude Code:

  ```bash
  claude mcp add --transport http quantum-lab \
    https://<your-deployment>/api/mcp/mcp \
    --header "Authorization: Bearer <supabase access token>"
  ```

  or in `.mcp.json`, add
  `"headers": { "Authorization": "Bearer <token>" }` to the server entry.
- **Without a token the tool refuses immediately**, naming exactly what is
  needed, and touches nothing — the billing stack is not even loaded
  (`lib/mcp/tools.test.ts` pins this).
- **With a token, the tool dispatches an internal request to the real
  `/api/hardware/submit` route handler**, `Authorization` header attached.
  Every gate that route enforces runs unchanged, because it is literally the
  same code: IP and per-account rate limits, `requireCaller` (Supabase-verified
  identity — the token is validated by `supabase.auth.getUser`, never parsed
  locally), body shape validation, `requireFeature('hardware.real')` (402 for
  Free), and the atomic monthly-quota reservation (fail-closed 503 when the
  meter cannot answer). The MCP layer re-implements **none** of these and adds
  no bypass: if the gate chain changes, the tool inherits the change.
- **The token is never stored.** The MCP endpoint remains stateless; the header
  is read per-request, handed to the tool context, forwarded once, and dropped.
- Tokens expire (Supabase defaults to 1 hour). Refresh and re-add the header
  when submissions start answering 401. Full OAuth (dynamic client
  registration per the MCP authorization spec) remains the documented upgrade
  path, at which point adopt `@modelcontextprotocol/server` via `mcp-handler`.

---

## Security posture

**Unauthenticated by design, and safe to be — for every tool except
`submit_hardware_job`:** the rest are read/compute-only over content that is
already public or free.

- Simulation (`run_circuit`, `get_statevector_at_step`) is deterministic,
  local CPU work — no money is spent, no state is written, and the cost per
  request is bounded by the 16-qubit / 4 096-shot / 1 000-gate clamps plus the
  rate limits.
- An unexpected failure inside a tool is reported to observability and **not**
  echoed to the caller: the reply is the generic `Tool "<name>" failed; try
  again later.` with `isError: true`, because a raw exception message on an
  anonymous surface can carry provider, host or table detail. Tools that have
  something actionable to say (an out-of-range step, an impossible
  postselection, a circuit over a limit) return their own specific error
  instead.
- The challenge catalogue, generator, and grader are the same code that runs,
  ungated, in every visitor's browser tab. Generated challenges are pure
  functions of `(kind, difficulty, seed)` — no server state, nothing to leak.
- `get_session_plan` computes over the snapshot the caller supplies and stores
  nothing; `export_notebook` is a pure string builder over the caller's own
  circuit.
- Lesson **metadata** is public (it is in every page's search index). Lesson
  **bodies** are served only for slugs `isLessonFree` approves — the paid
  advanced track is metadata-only over MCP, the same boundary the web app's
  server-side paywall enforces (`lib/lessons/access.ts`). MCP callers get
  strictly *less* than an anonymous browser, which also receives a three-block
  preview of paid lessons.

**Deliberately not exposed:** billing, organizations, user accounts, progress,
certificates, email — no read/compute tool in `lib/mcp/` imports any of those
modules. **Real-hardware submission** is exposed only through
`submit_hardware_job`, which is a token-gated pass-through to the real
`/api/hardware/submit` route with its entire gate chain intact (see
[Hardware authentication](#hardware-authentication)); the billing stack is
loaded only after a Bearer token is present, and identity comes exclusively
from the transport's `Authorization` header — never from a tool argument an
agent could fabricate.

Additional transport-level guards, per the Streamable HTTP spec: `Origin`
headers, when a browser sends one, must match the deployment host (DNS
rebinding defence — headless MCP clients send no Origin and are unaffected);
bodies are size-capped before parsing; an unsupported `MCP-Protocol-Version`
header gets a 400.
