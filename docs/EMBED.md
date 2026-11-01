# Embedding Quantum Lab

`/embed/circuit` is a chrome-free version of the circuit simulator built to be
iframed into another site (the driving use case: vegaduta.ai lesson pages
hosting a live circuit in place). It renders a circuit from the URL, lets the
viewer run it (and edit it, unless locked), and reports measurement results to
the host page over `postMessage`.

Roadmap item: A5 (embed half). Code map:

| Piece | File |
| --- | --- |
| Embed page (wiring only) | `apps/web/app/embed/circuit/page.tsx` |
| Chrome suppression + noindex | `apps/web/app/embed/circuit/layout.tsx` |
| Parsing/validation seam (unit-tested) | `apps/web/lib/embed/protocol.ts` |
| Loader script served to hosts | `apps/web/public/embed.js` |
| Per-route frame-ancestors exception | `apps/web/lib/security/headers.ts`, `apps/web/proxy.ts` |

## Quick start (host page)

The loader is the recommended path — it builds the iframe, scopes the message
bridge to the widget's origin, and queues loads until the widget is ready:

```html
<div data-quantum-lab data-circuit="TOKEN" data-readonly="1"></div>
<script src="https://YOUR-QUANTUM-LAB-HOST/embed.js" defer></script>
```

`TOKEN` is exactly the `c=` value from a simulator share link
(`/simulator?c=...`) — build a circuit, copy the share URL, paste the token.

Programmatic form:

```html
<div id="slot"></div>
<script src="https://YOUR-QUANTUM-LAB-HOST/embed.js" defer></script>
<script>
  window.addEventListener('DOMContentLoaded', () => {
    const widget = QuantumLab.mount(document.getElementById('slot'), {
      circuit: 'TOKEN',
      readonly: false,
      height: 520,
      onResult: (msg) => console.log(msg.counts, msg.shots),
    })
    // Later — swap in a different circuit as OpenQASM 3 text:
    // widget.load('OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\nh q[0];\ncx q[0], q[1];')
    // widget.destroy() removes the iframe and its listener.
  })
</script>
```

A raw iframe also works, if you would rather own the bridge yourself:

```html
<iframe src="https://YOUR-QUANTUM-LAB-HOST/embed/circuit?c=TOKEN" ...></iframe>
```

### URL parameters

| Param | Meaning |
| --- | --- |
| `c` | Circuit token — base64url OpenQASM 3, identical to the share-link format (`lib/share-link.ts`). Invalid or oversized tokens degrade to an empty editor, never an error page. |
| `readonly` | `1` locks the grid (viewers can look and Run, not edit). Any other value means editable. |

## Message protocol

All messages are plain objects with a `type` tag. Names are defined once, in
`lib/embed/protocol.ts` — page, loader and this table cannot drift without a
test failing.

| Message | Direction | Payload | When |
| --- | --- | --- | --- |
| `ql:ready` | widget → host | `{type}` | Once, after the widget has applied its URL circuit and is listening. The loader queues `load()` calls behind this. |
| `ql:load` | host → widget | `{type, qasm}` | Any time. `qasm` is OpenQASM 3 text (≤ 16 KB). Replaces the circuit and clears any shown result. Invalid payloads are silently ignored. |
| `ql:result` | widget → host | `{type, counts, shots}` | After every Run. `counts` maps basis-state labels (e.g. `"01"`) to sample counts; `shots` is the total (fixed at 1024). |

The widget simulates entirely in the viewer's browser and is clamped to the
anonymous (free) tier's qubit limit — a wider circuit is truncated to the ops
that fit, and one with nothing in range is treated as invalid.

## Security posture

**Who may embed: an explicit allowlist, default nobody (beyond same origin).**
The global CSP sets `frame-ancestors 'self'` on every route. The `/embed/*`
routes — and only those — append the origins listed in
`NEXT_PUBLIC_EMBED_ANCESTORS` (space- or comma-separated, e.g.
`https://vegaduta.ai https://www.vegaduta.ai`). Unset means the embed works
same-origin only, so a deployment that never heard of this feature is exactly
as strict as before it existed. Entries are normalised to origins via `new
URL()`; malformed entries (including `*`) are dropped, which fails stricter.
The variable is `NEXT_PUBLIC_` because middleware inlines it at build time —
changing the allowlist requires a redeploy, which is the right friction for a
framing policy.

**Deployment status: partners cannot frame the widget until the variable is
set.** `NEXT_PUBLIC_EMBED_ANCESTORS` is unset in production unless the
production build environment sets it, and with it unset `/embed/circuit` is
served with `frame-ancestors 'self'` (and `X-Frame-Options: SAMEORIGIN`), so
any cross-origin iframe, including a partner's lesson page, renders blank. That
is the intended safe default and it is not loosened to make a demo work. To go
live for a named partner: add their origins to the production build
environment, rebuild and redeploy (it is inlined at build time), then confirm
with `curl -sI https://<host>/embed/circuit | grep -i content-security-policy`
that `frame-ancestors` lists them. Only `http:` and `https:` origins are
accepted; anything else is dropped. Until then, do not give partners the
`embed.js` snippet: it will not load.

**X-Frame-Options stays `SAMEORIGIN` everywhere — deliberately.** vercel.json
applies `X-Frame-Options: SAMEORIGIN` at the edge, *after* middleware, and
`lib/security/headers.ts`'s contract is that the two never diverge. So the
embed exception is carried by `frame-ancestors` alone, which is safe and
sufficient: per spec, a browser that supports `frame-ancestors` (everything
since ~2016) applies it and **ignores** XFO. The consequence to state plainly:
on legacy browsers without `frame-ancestors` support, cross-origin embeds are
blocked. That failure is strict (a blank frame, no data exposure) and was
chosen over editing vercel.json's global header, which would loosen a
repo-wide invariant for a widget's benefit.

**The widget is unauthenticated by design.** `/embed/circuit` never reads a
session, calls no APIs, and simulates locally at the free-tier qubit limit. A
hostile host page therefore has nothing to steal, which is also why
`ql:result` is posted with `targetOrigin: '*'`: it contains only measurement
counts of a circuit the host itself supplied. If the embed ever grows an
authenticated feature, that decision must be revisited first — see the trust
model note at the top of `app/embed/circuit/page.tsx`.

**Inbound messages are hostile until proven otherwise.** `postMessage` is not
gated by CSP — any window with a reference can send. Every payload goes
through `parseLoadMessage`: exact type tag, string QASM, 16 KB cap, the same
strict `fromQasm` parser the simulator uses, then the qubit clamp. Anything
else is ignored without side effects. The loader script, on its side of the
fence, accepts messages only from the widget's own `contentWindow` *and*
origin.

**No SEO surface.** The embed layout sets `robots: noindex` — the host page is
the destination; the iframe body should never outrank it.

## Limitations

- One widget per `QuantumLab.mount` target; multiple widgets per page work
  (each bridge is scoped to its own iframe's `contentWindow`).
- Shots are fixed at 1024 and qubits at the free-tier limit. This is a demo
  surface; the "open in the full simulator" link in the widget is the upgrade
  path.
- Cross-origin embedding requires setting `NEXT_PUBLIC_EMBED_ANCESTORS` at
  build time on the Quantum Lab deployment; there is no runtime toggle.
