"""Liveness, capability reporting and real dependency probes.

A HEALTH CHECK THAT CANNOT FAIL IS DECORATION. The previous version of this
module returned ``{"status": "ok"}`` unconditionally: it proved that uvicorn was
listening and Python could build a dict, which the TCP connect had already
proven. It stayed green through a broken Aer install, a dead Redis, and a
qiskit import that only fails on the first real circuit.

So this module now executes one one-qubit circuit end to end and pings the job
store. What it deliberately does NOT do is talk to IBM, AWS or Azure: those
calls are rate-limited, some are billed, and the container ``HEALTHCHECK`` runs
every 30 seconds forever. Provider readiness is reported from credential and
SDK presence, and the response says so via ``checked: false`` so nobody mistakes
"configured" for "reachable".

STATUS CODE IS THE CONTRACT. 503 when something configured is not working, 200
otherwise, because Docker, Kubernetes and every uptime monitor read the code and
none of them parses the body. ``/api/health`` is also exempt from the shared-
secret gate (app/core/security.py) — a liveness probe cannot be handed a secret.
"""

from __future__ import annotations

import hmac
import os
import threading
import time
from typing import Any, Literal

from fastapi import APIRouter, Request, Response

from app import __version__
from app.core.security import SHARED_SECRET_HEADER, accepted_secrets
from app.jobs import queue
from app.quantum.backends import list_backends

router = APIRouter(tags=["health"])

#: ``ok`` reachable and working; ``degraded`` working with a caveat; ``failing``
#: configured and broken; ``skipped`` not configured on this deployment.
#: ``skipped`` NEVER makes the service unhealthy — running with an empty
#: environment is a supported configuration here, and a check that is always red
#: is a check nobody reads.
ProbeStatus = Literal["ok", "degraded", "failing", "skipped"]

#: The smallest circuit that exercises the whole path: parse OpenQASM, build a
#: Qiskit circuit, transpile, run, collect counts. One shot.
#:
#: MEASURED COST IN THIS CONTAINER: ~1350ms on the first call (cold import of
#: the PennyLane/Aer stack), ~3ms on every call after. The first number is why
#: docker-compose gives this service a 40-second `start_period` — a shorter
#: grace window restarts a service that is merely still importing, forever. The
#: second is why running a real circuit on every probe is affordable at a
#: 30-second interval. Re-measure before quoting either.
#:
#: NOTE the ``3.0``. The native OpenQASM 3 parser rejects a bare ``OPENQASM 3;``
#: with "expected FLOAT_NUMBER", and this container has no
#: ``qiskit_qasm3_import`` to fall back to — so a probe written the obvious way
#: reports the whole service as failing when nothing is wrong with it. Match
#: app/quantum/presets.py, which is what real requests look like.
_PROBE_QASM = """OPENQASM 3.0;
include "stdgates.inc";
qubit[1] q;
bit[1] c;
h q[0];
c = measure q;
"""


def _probe(status: ProbeStatus, detail: str, *, checked: bool, ms: float | None = None) -> dict[str, Any]:
    """Build one probe result in the shape the web app's /api/health also uses."""
    result: dict[str, Any] = {"status": status, "detail": detail, "checked": checked}
    if ms is not None:
        result["ms"] = round(ms, 1)
    return result


def _qiskit_version() -> str:
    """Read the installed Qiskit version without letting a failure break health.

    Returns:
        The version string, or ``"unknown"`` when it cannot be determined.
    """
    try:
        import qiskit

        return str(getattr(qiskit, "__version__", "unknown"))
    except Exception:  # noqa: BLE001 - health must never raise
        return "unknown"


def _probe_simulator() -> dict[str, Any]:
    """Actually run a circuit.

    This is the only probe in the file that proves the service can do its job.
    Import errors in qiskit-aer, a broken OpenQASM 3 parser and a missing
    transpiler pass all surface here and nowhere else — none of them is visible
    from ``import qiskit`` succeeding.

    Returns:
        A probe result. The exception text is NOT included: it can name file
        paths inside the container. It goes to the response only as a fixed
        sentence, and the full detail is left for the caller's own logs.
    """
    started = time.perf_counter()
    try:
        from app.quantum.runner import run_circuit

        result = run_circuit(_PROBE_QASM, shots=1)
        ms = (time.perf_counter() - started) * 1000
        counts = result.get("counts") or {}
        if not counts:
            return _probe(
                "failing",
                "A one-qubit probe circuit ran but returned no counts.",
                checked=True,
                ms=ms,
            )
        engine = str(result.get("engine", "unknown"))
        return _probe(
            "ok",
            f"Executed a one-qubit probe circuit on the {engine} engine.",
            checked=True,
            ms=ms,
        )
    except Exception as exc:  # noqa: BLE001 - health must never raise
        # Logged, not published: a traceback here names container paths and the
        # installed package layout.
        print(f"[api/health] simulator probe failed: {exc!r}", flush=True)
        return _probe(
            "failing",
            "A one-qubit probe circuit could not be executed.",
            checked=True,
            ms=(time.perf_counter() - started) * 1000,
        )


def _probe_job_store() -> dict[str, Any]:
    """Report which job store is live, and whether that is the one asked for.

    ``REDIS_URL`` set but the store still in memory is the failure mode that
    matters: the service keeps working, jobs are silently lost on restart and
    invisible to other replicas, and nothing anywhere says so. That is
    ``degraded``, not ``ok`` — the operator asked for Redis and did not get it.
    """
    started = time.perf_counter()
    try:
        stats = queue.stats()
        ms = (time.perf_counter() - started) * 1000
        store = str(stats.get("store", "unknown"))
        wanted_redis = bool(os.getenv("REDIS_URL"))
        if wanted_redis and "Redis" not in store:
            return _probe(
                "degraded",
                "REDIS_URL is set but the in-memory job store is live: the redis "
                "package is missing or the server did not answer. Jobs are lost "
                "on restart and invisible to other replicas.",
                checked=True,
                ms=ms,
            )
        if not wanted_redis:
            return _probe(
                "ok",
                "In-memory job store (no REDIS_URL). Jobs do not survive a restart.",
                checked=True,
                ms=ms,
            )
        return _probe("ok", f"{store} answered.", checked=True, ms=ms)
    except Exception as exc:  # noqa: BLE001 - health must never raise
        print(f"[api/health] job store probe failed: {exc!r}", flush=True)
        return _probe(
            "failing",
            "The job store did not answer.",
            checked=True,
            ms=(time.perf_counter() - started) * 1000,
        )


def _probe_hardware() -> dict[str, Any]:
    """Report hardware readiness from SDK and credential presence only.

    NO NETWORK CALL. Reaching IBM or Braket to check reachability would be a
    request to a rate-limited provider every 30 seconds, per replica, forever;
    against Braket it is also billable. ``checked: false`` says plainly that
    this is a configuration report, not a reachability one. If you need real
    reachability, poll it on a schedule measured in minutes and cache it — do
    not put it on the liveness path.
    """
    try:
        hardware = [b for b in list_backends() if b.kind == "hardware"]
        ready = [b.id for b in hardware if b.available]
        if not hardware:
            return _probe("skipped", "No hardware backends are registered.", checked=False)
        if not ready:
            return _probe(
                "skipped",
                "No hardware backend has both its SDK and its credentials; "
                "simulators are unaffected.",
                checked=False,
            )
        return _probe(
            "ok",
            f"{len(ready)} hardware backend(s) configured: {', '.join(sorted(ready))}. "
            "Reachability is NOT probed — see app/routers/health.py.",
            checked=False,
        )
    except Exception as exc:  # noqa: BLE001 - health must never raise
        print(f"[api/health] hardware probe failed: {exc!r}", flush=True)
        return _probe("failing", "The backend registry could not be read.", checked=False)


def _overall(checks: dict[str, dict[str, Any]]) -> str:
    """Roll probe results into one status. ``skipped`` is ignored entirely."""
    statuses = {c["status"] for c in checks.values()}
    if "failing" in statuses:
        return "failing"
    if "degraded" in statuses:
        return "degraded"
    return "ok"


#: How long a computed report is reused. /api/health is exempt from the shared
#: secret (a liveness probe cannot hold one) and is reachable by anyone who has
#: the hostname, so each call used to run a simulator circuit and ping the job
#: store: an unthrottled CPU amplifier on a 0.25 vCPU single replica. Within the
#: window every caller gets the stored report, so anonymous load costs O(1). The
#: container HEALTHCHECK polls every 30 s, so a healthy report is never stale to
#: it; a ``failing`` report is kept far shorter so recovery is seen quickly.
HEALTH_CACHE_SECONDS = 15.0
HEALTH_FAILING_CACHE_SECONDS = 2.0

_cache_lock = threading.Lock()
_cache: tuple[float, float, int, dict[str, Any]] | None = None  # (stamp, ttl, code, body)


def _reset_cache() -> None:
    """Drop the stored report (tests, and anything that wants a fresh probe)."""
    global _cache
    with _cache_lock:
        _cache = None


def _build_report() -> tuple[int, dict[str, Any]]:
    """Run every probe once and return ``(http_status, body)``."""
    checks = {
        "simulator": _probe_simulator(),
        "jobStore": _probe_job_store(),
        "hardware": _probe_hardware(),
    }
    status = _overall(checks)
    return (
        503 if status == "failing" else 200,
        {
            "status": status,
            "version": __version__,
            "backends_available": [b.id for b in list_backends() if b.available],
            "qiskit_version": _qiskit_version(),
            "checks": checks,
        },
    )


def _has_shared_secret(request: Request) -> bool:
    """True when the caller presented a currently-accepted shared secret.

    ``/api/health`` is exempt from the gate (a liveness probe holds no secret),
    so this decides only how much DETAIL the caller gets, never whether it gets
    an answer. With no secret configured nobody can present one, so everyone
    gets the trimmed report.
    """
    presented = request.headers.get(SHARED_SECRET_HEADER, "")
    matched = False
    for candidate in accepted_secrets():
        # Every candidate compared, no early exit: see the gate in security.py.
        if hmac.compare_digest(presented, candidate):
            matched = True
    return matched


def _public_view(body: dict[str, Any]) -> dict[str, Any]:
    """Strip what an anonymous caller could use to fingerprint this deployment.

    Kept: ``status`` (the liveness contract), ``version`` and, per probe,
    ``status`` / ``checked`` / ``ms``. Dropped: the Qiskit version, the list of
    configured backends (it reveals which hardware providers have credentials)
    and each probe's free-text ``detail`` (it names the job-store backend and
    hardware providers).
    """
    checks = {
        name: {k: v for k, v in check.items() if k != "detail"}
        for name, check in body["checks"].items()
    }
    return {"status": body["status"], "version": body["version"], "checks": checks}


@router.get("/api/health")
def health(request: Request, response: Response) -> dict[str, Any]:
    """Report status, version and what this service can actually reach.

    The report is computed at most once per :data:`HEALTH_CACHE_SECONDS` (see
    there); concurrent callers wait for the one computation rather than each
    running a circuit.

    Returns:
        With a valid shared secret: ``status``, ``version``, ``qiskit_version``,
        ``backends_available`` and a ``checks`` map with probe details. Without
        one: ``status``, ``version`` and per-probe ``status``/``checked``/``ms``
        only. Sets HTTP 503 when ``status`` is ``failing``; ``degraded`` stays
        200 deliberately, because paging on a caveat teaches people to ignore
        the page.
    """
    global _cache
    with _cache_lock:
        now = time.monotonic()
        if _cache is not None and now - _cache[0] < _cache[1]:
            code, body = _cache[2], _cache[3]
        else:
            code, body = _build_report()
            ttl = HEALTH_FAILING_CACHE_SECONDS if code != 200 else HEALTH_CACHE_SECONDS
            _cache = (time.monotonic(), ttl, code, body)
    if code != 200:
        response.status_code = code
    # Client and proxy caches stay off: the server-side window above is the only
    # reuse, and it is short enough that a downstream cache would only add lag.
    response.headers["cache-control"] = "no-store, no-cache, must-revalidate"
    return body if _has_shared_secret(request) else _public_view(body)
