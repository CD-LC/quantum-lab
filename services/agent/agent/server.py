"""FastAPI surface for the QuantumMind tutor.

Exposes two endpoints under ``/api/agent``: a chat endpoint that proxies to
:func:`agent.core.ask`, and a health endpoint that reports whether the service
is configured. Importing this module never requires an API key; an unconfigured
service answers chat requests with setup instructions and ``configured: false``
rather than an error.

Run it with::

    uvicorn agent.server:app --host 0.0.0.0 --port 8001
"""

from __future__ import annotations

import logging
import time
import warnings
from typing import Any, Literal

import httpx
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from agent import core
from agent.config import settings
from agent.env_check import check_env
from agent.rag import retrieve
from agent.tools import TOOL_NAMES

# Fail before the first request rather than during it. An empty environment is
# a valid configuration here (the service answers configured: false); this
# raises only on a misconfiguration that would otherwise be silent — a '*' in
# ALLOWED_ORIGINS, or a clamp set non-positive. See agent/env_check.py.
check_env()

logger = logging.getLogger(__name__)

__all__ = ["app", "ChatRequest", "ChatResponse", "HealthResponse"]

app = FastAPI(
    title="Qubit16 — QuantumMind Agent",
    description="AI tutor that teaches quantum computing by actually running circuits.",
    version="0.1.0",
)

# ── CORS ────────────────────────────────────────────────────────────────────
#
# SECURITY FIX (audit finding CORS-1). The origin was HARD-CODED to
# http://localhost:3000, which meant a deployed operator had no way to set it
# correctly and every method and header was accepted from it. It now comes from
# ALLOWED_ORIGINS (the same variable services/api reads), a wildcard is refused
# in Settings.origins_list, and the method/header wildcards are replaced with
# the exact sets this service uses.
#
# `allow_credentials=True` is what makes all of that matter: with credentials
# allowed, whoever is in `allow_origins` may call this endpoint as the visitor
# and read the reply — on a service that spends the operator's Anthropic budget.
if settings.origins_list == ["http://localhost:3000"]:
    warnings.warn(
        "ALLOWED_ORIGINS is unset, so CORS allows only http://localhost:3000. "
        "A deployed web app on any other origin will be refused by the browser "
        "until ALLOWED_ORIGINS names it.",
        RuntimeWarning,
        stacklevel=1,
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Accept"],
)


# SECURITY (audit finding INJ-1 / AGENT-1): the request is bounded in the schema,
# so an oversized body is a 422 from FastAPI before a single token is billed.
# core.ask() clamps the same values again — these bounds reject, those truncate,
# and the clamps there are what keeps a legitimate long paste working. Both are
# wanted: this one stops the pathological case cheaply, that one is the ceiling
# that actually reaches the model.

#: Characters accepted per turn. Matches settings.max_message_chars.
_MAX_CHARS = 8_000
#: Prior turns accepted. Matches settings.max_history_turns.
_MAX_HISTORY = 20
#: Characters of attached circuit source. The editor never produces this much.
_MAX_QASM_CHARS = 20_000
#: Characters of the opted-in study plan.
_MAX_PLAN_CHARS = 2_048


class HistoryTurn(BaseModel):
    """One prior turn of the conversation."""

    role: Literal["user", "assistant", "human", "ai"] = "user"
    content: str = Field("", max_length=_MAX_CHARS)


class LlmOverrideBody(BaseModel):
    """Provider choice forwarded by the web app — see ``core.LlmOverride``."""

    model: str = Field(..., max_length=200)
    api_key: str = Field(..., max_length=512)
    api_base: str | None = Field(None, max_length=400)
    api_version: str | None = Field(None, max_length=64)


class ChatRequest(BaseModel):
    """Body of a POST to ``/api/agent/chat``."""

    message: str = Field(..., max_length=_MAX_CHARS, description="The learner's question.")
    level: str = Field("beginner", max_length=32, description="beginner | intermediate | advanced")
    history: list[HistoryTurn] = Field(default_factory=list, max_length=_MAX_HISTORY)
    circuit_qasm: str | None = Field(
        None, max_length=_MAX_QASM_CHARS, description="QASM currently open in the editor."
    )
    learner_plan: str | None = Field(
        None,
        max_length=_MAX_PLAN_CHARS,
        description="Study plan the learner opted in to sharing (computed by the web app).",
    )
    llm: LlmOverrideBody | None = Field(
        None, description="Optional provider/key override resolved by the web app."
    )


class ChatResponse(BaseModel):
    """Reply from ``/api/agent/chat``."""

    reply: str
    tools_used: list[str] = Field(default_factory=list)
    configured: bool = True


class ProbeResult(BaseModel):
    """One dependency probe. Mirrors the shape services/api and the web app use."""

    status: Literal["ok", "degraded", "failing", "skipped"]
    detail: str
    #: False when the probe reports configuration only, without a network call.
    checked: bool
    ms: float | None = None


class HealthResponse(BaseModel):
    """Reply from ``/api/agent/health``.

    ``status`` is the roll-up; ``configured`` is kept because /api/agent in the
    web app already reads it to decide which tutor tier to promise the learner,
    and breaking that would silently downgrade the tutor everywhere.
    """

    status: Literal["ok", "degraded", "failing"]
    configured: bool
    tools: list[str]
    checks: dict[str, ProbeResult] = Field(default_factory=dict)


@app.post("/api/agent/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    """Answer a learner's question with the QuantumMind tutor.

    Args:
        request: The chat request body.

    Returns:
        The tutor's reply and the tools it called. When the service has no API
        key, returns HTTP 200 with setup instructions and ``configured=False``
        so the UI can render guidance rather than an error.
    """
    try:
        result: dict[str, Any] = core.ask(
            question=request.message,
            level=request.level,
            history=[turn.model_dump() for turn in request.history],
            circuit_qasm=request.circuit_qasm,
            llm_override=request.llm.model_dump() if request.llm else None,
            learner_plan=request.learner_plan,
        )
    except RuntimeError as exc:
        return ChatResponse(reply=str(exc), tools_used=[], configured=False)
    except Exception as exc:  # noqa: BLE001 - provider and tool failures are not 500s
        # A revoked or over-quota key, a provider outage, a context-window
        # overflow: litellm raises these as openai-style exceptions, none of
        # them a RuntimeError. Class name only; the message can echo the
        # learner's input or the provider's account details.
        logger.warning("agent chat failed: %s", type(exc).__name__)
        raise HTTPException(
            status_code=502,
            detail={"error": "provider_error", "type": type(exc).__name__},
        ) from None

    return ChatResponse(
        reply=result.get("reply", ""),
        tools_used=result.get("tools_used", []),
        configured=True,
    )


def _probe_quantum_api() -> ProbeResult:
    """Check the circuit-execution API this service's tools depend on.

    ``run_quantum_circuit`` and ``check_circuit`` POST to
    ``settings.quantum_api_url``. When that host is down the agent still answers
    — it just stops being able to verify its own claims by running the circuit,
    which is the entire argument for the agent tier existing. So an unreachable
    services/api is ``degraded``, not ``failing``: the tutor is impaired, not
    broken, and paging as if it were broken is how alerts get ignored.
    """
    url = (settings.quantum_api_url or "").rstrip("/")
    if not url:
        return ProbeResult(
            status="skipped",
            detail="QUANTUM_API_URL is unset; circuit-running tools are unavailable.",
            checked=False,
        )
    started = time.perf_counter()
    try:
        # 2.5s, against a HEALTHCHECK `--timeout=5s` in services/agent/
        # Dockerfile. A longer timeout here turns one slow dependency into a
        # failed liveness check on THIS service and a restart loop.
        with httpx.Client(timeout=2.5) as client:
            response = client.get(f"{url}/api/health")
        ms = (time.perf_counter() - started) * 1000
        if response.status_code >= 400:
            return ProbeResult(
                status="degraded",
                detail=f"services/api answered HTTP {response.status_code}; "
                "the tutor cannot run circuits to check its own answers.",
                checked=True,
                ms=round(ms, 1),
            )
        return ProbeResult(
            status="ok", detail="services/api answered.", checked=True, ms=round(ms, 1)
        )
    except Exception:  # noqa: BLE001 - health must never raise
        # The exception text names the internal host and port. Not published.
        return ProbeResult(
            status="degraded",
            detail="services/api did not answer within 2.5s; the tutor cannot run "
            "circuits to check its own answers.",
            checked=True,
            ms=round((time.perf_counter() - started) * 1000, 1),
        )


def _probe_rag() -> ProbeResult:
    """Check that the course-retrieval index actually loaded.

    A missing index is the failure this probe exists for: ``search_concepts``
    silently falls back to a keyword-free response, the tutor keeps answering,
    and the answers quietly stop being grounded in the course. Nothing else in
    the system says a word about it.
    """
    started = time.perf_counter()
    try:
        available = retrieve.is_index_available()
        ms = round((time.perf_counter() - started) * 1000, 1)
        if not available:
            return ProbeResult(
                status="degraded",
                detail="No RAG index loaded: course retrieval falls back to "
                "ungrounded answers. Rebuild it with `python -m agent.rag.index`.",
                checked=True,
                ms=ms,
            )
        return ProbeResult(status="ok", detail="Course index loaded.", checked=True, ms=ms)
    except Exception:  # noqa: BLE001 - health must never raise
        return ProbeResult(
            status="failing",
            detail="The course index could not be read.",
            checked=True,
            ms=round((time.perf_counter() - started) * 1000, 1),
        )


def _probe_model_provider() -> ProbeResult:
    """Report key presence only — NO CALL IS MADE.

    A probe request to Anthropic is billed and rate-limited, and the container
    HEALTHCHECK runs every 30 seconds per replica forever. ``checked: false``
    states plainly that this is a configuration report, not a reachability one.
    """
    if not core.is_configured():
        return ProbeResult(
            status="skipped",
            detail="No GEMINI_API_KEY / GROQ_API_KEY / ANTHROPIC_API_KEY; chat "
            "returns setup guidance and configured: false, which is a "
            "supported state.",
            checked=False,
        )
    return ProbeResult(
        status="ok",
        detail=f"Provider key present for model={settings.model}. Reachability "
        "is NOT probed — a probe call would be billed.",
        checked=False,
    )


@app.get("/api/agent/health", response_model=HealthResponse)
def health(response: Response) -> HealthResponse:
    """Report what this service can actually reach.

    A health check that cannot fail is decoration: this used to return
    ``status="ok"`` unconditionally, which proved only that uvicorn was
    listening. It now probes the circuit API, the RAG index and the model
    provider's configuration.

    Returns:
        The roll-up status, the ``configured`` flag the web app reads, the tool
        names, and the individual probe results. Sets HTTP 503 only on
        ``failing``; ``degraded`` stays 200, because every degraded state here
        is one the tutor is designed to survive.
    """
    checks = {
        "quantumApi": _probe_quantum_api(),
        "courseIndex": _probe_rag(),
        "modelProvider": _probe_model_provider(),
    }
    statuses = {c.status for c in checks.values()}
    status: Literal["ok", "degraded", "failing"] = (
        "failing" if "failing" in statuses else "degraded" if "degraded" in statuses else "ok"
    )
    if status == "failing":
        response.status_code = 503
    # A cached health report is a lie that never changes.
    response.headers["cache-control"] = "no-store, no-cache, must-revalidate"

    return HealthResponse(
        status=status,
        configured=core.is_configured(),
        tools=list(TOOL_NAMES),
        checks=checks,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, port=8001)
