"""Startup environment validation for the Qubit16 agent service.

Mirror of ``services/api/app/core/env_check.py``: two services, one rule. The
list was derived by grepping ``services/agent/agent`` for ``os.environ`` and
reading ``agent/config.py``.

WHY NOTHING IS REQUIRED. The service starts, answers ``/api/agent/health`` with
``configured: false`` and replies to chat with setup instructions when there is
no API key — that is a deliberate degradation, not an outage. So the errors here
are misconfigurations rather than absences:

* ``ALLOWED_ORIGINS`` containing ``*``, which on a service that spends the
  operator's Anthropic budget means any page a user visits can call it as them.
* Clamp values (``MAX_TOOL_ROUNDS``, ``MAX_AGENT_SECONDS``, ``MAX_SHOTS`` …) set
  to zero or below. These bound what an instruction hidden in a lesson, a paper
  abstract or a learner's QASM can spend; a non-positive value is either a
  deployment typo or an attempt to remove the bound, and both should stop the
  service rather than quietly disable a security control.

The one warning worth reading is the RAG index: retrieval degrades in complete
silence when the artifact is missing, and the tutor's answers just get worse.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from agent.config import settings

__all__ = ["check_env", "EnvReport"]

logger = logging.getLogger(__name__)

#: name -> (what setting it unlocks, what happens without it).
OPTIONAL_VARS: dict[str, tuple[str, str]] = {
    "GEMINI_API_KEY": (
        "Live tutor answers via Gemini Flash (free-tier eligible) — the "
        "cheapest way to run this with zero paying users.",
        "/api/agent/health reports configured: false and chat returns setup "
        "instructions. Tools and the knowledge base still work.",
    ),
    "GROQ_API_KEY": (
        "Live tutor answers via a Groq-hosted open-weight model.",
        "Same degradation as GEMINI_API_KEY when no provider key is set.",
    ),
    "ANTHROPIC_API_KEY": (
        "Live tutor answers via Claude (premium option).",
        "Same degradation as GEMINI_API_KEY when no provider key is set.",
    ),
    "MODEL": (
        "LiteLLM-style model id, e.g. gemini/gemini-2.5-flash, "
        "groq/llama-3.3-70b-versatile, anthropic/claude-sonnet-4-6 — its "
        "provider prefix picks which key above is used.",
        "Defaults to gemini/gemini-2.5-flash.",
    ),
    "QUANTUM_API_URL": (
        "Where run_quantum_circuit sends work.",
        "Defaults to http://localhost:8000. When that is unreachable the tool "
        "falls back to a LOCAL Aer simulation in this process — answers stay "
        "correct, but the CPU cost lands here.",
    ),
    "ALLOWED_ORIGINS": (
        "CORS origins the browser may call this service from.",
        "Only http://localhost:3000 is allowed, so a deployed web app on any "
        "other origin is refused by the browser.",
    ),
    "QUANTUM_LAB_RAG_INDEX": (
        "Overrides the path of the course TF-IDF index.",
        "Uses the committed artifact at services/agent/data/course_index.json.",
    ),
}

#: Clamp settings that must stay positive. Names are the attribute on
#: ``settings``; the environment variable is the upper-case form.
_POSITIVE_CLAMPS = (
    "max_tool_rounds",
    "max_agent_seconds",
    "max_history_turns",
    "max_message_chars",
    "max_shots",
    "max_tokens",
    "llm_request_timeout",
    "max_qubits",
    "max_circuit_gates",
    "max_qasm_chars",
    "max_sim_work",
    "sim_max_memory_mb",
)


class EnvReport:
    """Errors and warnings found in the current environment."""

    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []


def check_env(*, strict: bool = True) -> EnvReport:
    """Validate the environment, log the findings, and optionally raise.

    Args:
        strict: When True (the default) an error raises ``RuntimeError`` at
            startup. ``QUANTUM_LAB_SKIP_ENV_CHECK=1`` downgrades errors to
            warnings during an incident.

    Returns:
        The :class:`EnvReport` describing what was found.

    Raises:
        RuntimeError: If ``strict`` and any error was found.
    """
    report = EnvReport()

    try:
        origins = settings.origins_list
    except ValueError as exc:
        origins = []
        report.errors.append(str(exc))

    if origins == ["http://localhost:3000"]:
        report.warnings.append(
            "ALLOWED_ORIGINS is unset, so CORS allows only http://localhost:3000. "
            "A deployed web app on any other origin will be refused by the browser."
        )

    for attr in _POSITIVE_CLAMPS:
        value = getattr(settings, attr, None)
        if value is not None and value <= 0:
            report.errors.append(
                f"{attr.upper()}={value} is not positive. It bounds what a "
                "prompt injection in a lesson, a paper abstract or a learner's "
                "circuit can spend; a non-positive value removes the bound."
            )

    # Retrieval failing open is invisible from the outside: the tutor answers,
    # it just answers without the course. Worth a line in the log at boot.
    try:
        from agent.rag.retrieve import index_path  # noqa: PLC0415 - keeps import cheap

        path = Path(index_path())
        if not path.is_file():
            report.warnings.append(
                f"The course RAG index is missing at {path}. The tutor still "
                "answers, without retrieval over the lessons, and nothing in "
                "the API response says so. In a container this usually means "
                "the image did not COPY the data/ directory."
            )
    except Exception as exc:  # noqa: BLE001 - a check must not break startup
        report.warnings.append(f"Could not check the RAG index ({exc}).")

    if not settings.has_llm_key:
        report.warnings.append(
            "No GEMINI_API_KEY / GROQ_API_KEY / ANTHROPIC_API_KEY is set: the "
            "service will report configured: false and answer chat with "
            "setup instructions. GEMINI_API_KEY is the cheapest to add "
            "(free tier) — see docs/LLM-GATEWAY.md."
        )

    for message in report.warnings:
        logger.warning("env: %s", message)
    for message in report.errors:
        logger.error("env: %s", message)

    skip = os.environ.get("QUANTUM_LAB_SKIP_ENV_CHECK", "").strip() == "1"
    if report.errors and strict and not skip:
        raise RuntimeError(
            "Environment is misconfigured ("
            + str(len(report.errors))
            + " error(s)): "
            + " | ".join(report.errors)
            + " — see docs/DEPLOYMENT.md. To start anyway during an incident: "
            "QUANTUM_LAB_SKIP_ENV_CHECK=1"
        )
    if report.errors and skip:
        logger.error("env: QUANTUM_LAB_SKIP_ENV_CHECK=1 is set; the errors above are not fatal.")

    return report


if __name__ == "__main__":  # pragma: no cover - CLI for CI and container starts
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    check_env()
    print("env: ok")
