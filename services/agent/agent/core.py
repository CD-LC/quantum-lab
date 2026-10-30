"""The QuantumMind agent itself: LangChain wiring and the ``ask`` entry point.

This is the only module (besides :mod:`agent.server`, which delegates to it)
that needs an LLM provider key (Gemini, Groq, or Anthropic — see
``docs/LLM-GATEWAY.md``), and it only complains when it is actually called —
importing it is always safe. All LangChain imports happen inside the
functions for the same reason.
"""

from __future__ import annotations

from typing import Any, TypedDict

from agent.config import settings
from agent.paper import PAPER_TOOLS
from agent.prompts import build_system_prompt
from agent.tools import ALL_TOOLS

__all__ = [
    "build_agent",
    "ask",
    "is_configured",
    "bounded_history",
    "clamp_text",
    "debug_loop_guidance",
    "run_paper_guidance",
    "SETUP_MESSAGE",
    "AgentStoppedError",
    "is_force_stop_output",
]

SETUP_MESSAGE: str = (
    "QuantumMind is not configured: no LLM provider key was found.\n\n"
    "Cheapest way to enable the tutor (recommended while there are no "
    "paying users — Gemini Flash has a genuinely free tier):\n"
    "  1. Get a free key at https://aistudio.google.com/apikey\n"
    "  2. Create services/agent/.env containing:\n"
    "       GEMINI_API_KEY=...\n"
    "     (or export GEMINI_API_KEY in your shell)\n"
    "  3. Install the LLM dependencies:\n"
    "       pip install -r requirements.txt\n"
    "  4. Restart the agent service.\n\n"
    "Other providers work the same way — set GROQ_API_KEY and MODEL="
    "groq/llama-3.3-70b-versatile, or ANTHROPIC_API_KEY and MODEL="
    "anthropic/claude-sonnet-4-6. See docs/LLM-GATEWAY.md.\n\n"
    "The circuit tools (generate, run, check, explain, concept search) do not "
    "need a key and keep working without one."
)


def clamp_text(value: Any) -> str:
    """Coerce to a string and cut it to ``settings.max_message_chars``.

    SECURITY (audit finding INJ-1). Truncating rather than rejecting is
    deliberate: a learner who pastes a wall of text should still get an answer,
    and a rejection would only teach an attacker to send a slightly shorter
    payload. What this buys is a bound on tokens billed per turn.

    Args:
        value: Anything; non-strings are coerced.

    Returns:
        The stripped, length-bounded text.
    """
    text = str(value or "").strip()
    limit = max(1, int(settings.max_message_chars))
    return text[:limit]


def bounded_history(history: list[dict[str, str]] | None) -> list[dict[str, str]]:
    """Keep only the most recent ``settings.max_history_turns`` turns.

    SECURITY (audit finding INJ-1). The entire history is re-sent and re-billed
    on every request, so an unbounded array is an unbounded bill; it is also
    where a patient injector piles up instructions over many turns. The newest
    turns are kept because they are the ones that carry the conversation.

    Args:
        history: Prior turns, oldest first, or ``None``.

    Returns:
        At most ``settings.max_history_turns`` turns, oldest first.
    """
    turns = list(history or [])
    limit = max(0, int(settings.max_history_turns))
    return turns[-limit:] if limit else []


def debug_loop_guidance() -> str:
    """Build the agent-debugging-loop instructions (roadmap stage A2).

    This lives here rather than in :mod:`agent.prompts` deliberately: the loop
    is a tool-sequencing policy whose whole point is fitting inside the round
    and wall-clock clamps this module configures, so the budget number quoted
    to the model and the budget enforced on it come from the same place —
    ``settings.max_tool_rounds`` — and cannot drift apart.

    The text contains no ``{`` or ``}``: it is interpolated into a LangChain
    ``ChatPromptTemplate``, where a stray brace becomes a template variable.

    Returns:
        The guidance paragraph appended to the system prompt.
    """
    rounds = max(1, int(settings.max_tool_rounds))
    return (
        "Debugging a misbehaving circuit: when a circuit gives a result the "
        "learner did not expect, never guess at the cause — run this loop.\n"
        "1. EXECUTE: run_quantum_circuit on their exact circuit and read the real "
        "counts.\n"
        "2. INSPECT: inspect_statevector on the same circuit and scan its per-step "
        "states for the FIRST step where the state stops matching what the learner "
        "intended. The gate applied at that step is where the bug lives.\n"
        "3. LOCALIZE: name that specific gate and its qubit(s). If you are comparing "
        "their circuit against a reference or corrected version, use diff_circuits "
        "to list exactly which operations differ and where — do not eyeball two "
        "QASM listings.\n"
        "4. FIX: propose the MINIMAL change — usually one gate added, removed, "
        "retargeted or reordered — and say why that gate produces the divergence "
        "you observed at that step.\n"
        "5. CONFIRM: re-run the fixed circuit with run_quantum_circuit; only present "
        "a fix whose new counts you have actually seen.\n"
        "Answer by citing the observed state, not theory alone — for example: "
        "'qubit 2 is |1> after step 3 because the CX fired there', quoting the step "
        "summaries and counts the tools returned.\n"
        f"Budget: you have a hard ceiling of {rounds} tool calls per reply, and the "
        "full loop above fits in five (run, inspect, diff, re-run, explain). Do not "
        "repeat a call whose result you already have, and if the ceiling is near, "
        "skip the diff and confirm the fix with the single re-run."
    )


def run_paper_guidance() -> str:
    """Build the "run this paper" instructions (roadmap "Run this paper" MVP).

    Lives beside :func:`debug_loop_guidance` for the same reason it does: this
    is a tool-sequencing policy that must fit the round budget this module
    enforces, so the number quoted to the model comes from the same
    ``settings.max_tool_rounds`` the executor is clamped to.

    Like that function, the text contains no ``{`` or ``}`` — it is
    interpolated into a LangChain ``ChatPromptTemplate`` where a stray brace
    becomes a template variable.

    Returns:
        The guidance paragraph appended to the system prompt.
    """
    rounds = max(1, int(settings.max_tool_rounds))
    return (
        "Reproducing an arXiv paper: when the learner shares an arXiv link or "
        "id and wants to see the paper's protocol in action, run this sequence.\n"
        "1. FETCH: call fetch_arxiv with the link or id to get the real title, "
        "abstract and categories. Only the abstract is available — full text is "
        "out of scope — so say when a claim would need the paper's body.\n"
        "2. IDENTIFY: pass the returned abstract to protocol_hints. It detects "
        "only the named protocols this product can actually simulate and hands "
        "you a ready-to-run OpenQASM 3 template for each.\n"
        "3. RUN: execute the template with run_quantum_circuit and read the "
        "real counts. Do not modify the template unless the learner asks.\n"
        "4. COMPARE: relate the observed counts QUALITATIVELY to what the "
        "abstract claims — correlated bits for a Bell test, a dominant marked "
        "state for Grover, and so on. Never claim to have reproduced the "
        "paper's quantitative results: the template is the protocol's small "
        "canonical instance, not their experiment.\n"
        "5. BE HONEST ABOUT SCOPE: if protocol_hints detects nothing, or warns "
        "that the paper needs more than 16 qubits, say plainly that the paper "
        "cannot be reproduced here and offer the nearest course lesson instead. "
        "Never bluff a circuit for a paper you cannot actually run.\n"
        f"Budget: the ceiling of {rounds} tool calls per reply still applies, "
        "and the full sequence is three calls (fetch, hints, run) — leaving "
        "room for one explain_measurement if the counts need interpreting."
    )


def is_configured() -> bool:
    """Report whether the tutor has everything it needs to answer questions.

    Returns:
        ``True`` when a Gemini, Groq, or Anthropic API key is present,
        ``False`` otherwise.
    """
    return settings.has_llm_key


class LlmOverride(TypedDict, total=False):
    """A per-request provider choice made by the web app (apps/web/lib/llm/resolve.ts).

    ``model`` is a LiteLLM model string (``"gemini/gemini-2.5-flash"``,
    ``"azure/<deployment>"``); ``api_key`` / ``api_base`` / ``api_version`` are
    passed straight to LiteLLM. The web app resolves the platform admin's
    runtime settings (keys, order, per-tier policy) and forwards the winner
    here so both runtimes follow ONE decision — without this the Python
    service would keep using its own env vars and a change in /admin/platform
    would only reach the direct fallback.
    """

    model: str
    api_key: str
    api_base: str | None
    api_version: str | None


def _clean_override(llm: LlmOverride | None) -> LlmOverride | None:
    """Accept an override only when it names a model AND carries a key."""
    if not llm or not isinstance(llm, dict):
        return None
    model = str(llm.get("model") or "").strip()[:200]
    api_key = str(llm.get("api_key") or "").strip()[:512]
    if not model or not api_key:
        return None
    out: LlmOverride = {"model": model, "api_key": api_key}
    base = llm.get("api_base")
    if isinstance(base, str) and base.strip():
        out["api_base"] = base.strip()[:400]
    version = llm.get("api_version")
    if isinstance(version, str) and version.strip():
        out["api_version"] = version.strip()[:64]
    return out


def _escape_template_braces(text: str) -> str:
    """Escape ``{`` and ``}`` so a prompt template treats them as literal text.

    ``ChatPromptTemplate`` parses every ``(role, string)`` message as an
    f-string template. The system prompt embeds the learner's circuit, and QASM
    is full of braces (``gate g a { h a; }``), each of which would be read as a
    template variable and fail with a ``KeyError`` at invoke time.
    """
    return text.replace("{", "{{").replace("}", "}}")


def build_agent(
    level: str = "beginner",
    circuit_qasm: str | None = None,
    llm_override: LlmOverride | None = None,
    learner_plan: str | None = None,
) -> Any:
    """Construct a tool-calling ``AgentExecutor`` for a tutoring session.

    Goes through LiteLLM (via ``langchain-litellm``, an open-source gateway)
    rather than a provider-specific SDK, so ``settings.model`` — a string
    like ``"gemini/gemini-2.5-flash"``, ``"groq/llama-3.3-70b-versatile"`` or
    ``"anthropic/claude-sonnet-4-6"`` — is the entire choice of provider.
    LiteLLM reads the matching ``GEMINI_API_KEY`` / ``GROQ_API_KEY`` /
    ``ANTHROPIC_API_KEY`` from the process environment itself (see
    ``docs/LLM-GATEWAY.md``); nothing here hand-rolls per-provider request
    logic or fallback behavior.

    Args:
        level: Learner level (``"beginner"``, ``"intermediate"``, ``"advanced"``).
        circuit_qasm: OpenQASM the learner currently has open, if any.

    Returns:
        A configured ``langchain.agents.AgentExecutor``.

    Raises:
        RuntimeError: If no provider key is configured, or if the LangChain /
            LiteLLM packages are not installed.
    """
    override = _clean_override(llm_override)
    if override is None and not settings.has_llm_key:
        raise RuntimeError(SETUP_MESSAGE)

    try:
        # NOTE: langchain 1.x moved AgentExecutor/create_tool_calling_agent
        # (the legacy tool-loop API this module's security clamps —
        # max_iterations, max_execution_time, return_intermediate_steps — are
        # written against) out to the separate langchain-classic package.
        # `from langchain.agents import ...` silently breaks the moment
        # langchain resolves to >=1.0, since requirements.txt pins it open
        # (">=0.3") — caught 2026-08 while wiring the multi-provider gateway.
        from langchain_classic.agents import AgentExecutor, create_tool_calling_agent
        from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
        from langchain_litellm import ChatLiteLLM
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise RuntimeError(
            "QuantumMind needs the LLM dependencies. Install them with:\n"
            "    pip install -r requirements.txt\n"
            f"(missing: {exc.name})"
        ) from exc

    llm_kwargs: dict[str, Any] = {
        "model": settings.model,
        "max_tokens": settings.max_tokens,
        "temperature": settings.temperature,
        # LiteLLM's own default is 600 s per call; a stalled provider would pin
        # a worker thread that long. Never longer than the run budget.
        "request_timeout": min(
            float(settings.llm_request_timeout), float(settings.max_agent_seconds)
        ),
    }
    if override is not None:
        llm_kwargs["model"] = override["model"]
        llm_kwargs["api_key"] = override["api_key"]
        if override.get("api_base"):
            llm_kwargs["api_base"] = override["api_base"]
        if override.get("api_version"):
            llm_kwargs["api_version"] = override["api_version"]
    llm = ChatLiteLLM(**llm_kwargs)

    prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                _escape_template_braces(
                    build_system_prompt(
                        level=level, circuit_qasm=circuit_qasm, learner_plan=learner_plan
                    )
                    + "\n\n"
                    + debug_loop_guidance()
                    + "\n\n"
                    + run_paper_guidance()
                ),
            ),
            MessagesPlaceholder("chat_history", optional=True),
            ("human", "{input}"),
            MessagesPlaceholder("agent_scratchpad"),
        ]
    )

    # Roadmap "Run this paper": the paper tools live in agent.paper and are
    # registered here rather than in agent.tools so the module that owns the
    # arXiv/protocol logic also owns its tool surface.
    tools = ALL_TOOLS + PAPER_TOOLS
    agent = create_tool_calling_agent(llm, tools, prompt)
    return AgentExecutor(
        agent=agent,
        tools=tools,
        verbose=False,
        handle_parsing_errors=True,
        # SECURITY (audit finding INJ-1): the two clamps on the tool loop.
        #
        # max_iterations bounds the ROUNDS: each one is another billed LLM call,
        # and each tool result is another chance for retrieved text to inject
        # instructions. Without a bound, "keep calling run_quantum_circuit until
        # I tell you to stop" is a request the model will honour.
        #
        # max_execution_time bounds the WALL CLOCK, which the round count does
        # not: a single local Aer simulation is one round and can run for
        # minutes. `early_stopping_method="force"` means hitting either limit
        # ends the run with whatever the model has, rather than raising — the
        # learner gets a partial answer, not a 500.
        #
        # Stage A2 note: the debugging loop (run, inspect, diff, fix + re-run,
        # explain) is at most five tool calls, so it fits inside the existing
        # ceiling of six with a round to spare — config.py's reasoning ("six is
        # comfortably more than a real tutoring answer needs") still holds and
        # the ceiling is deliberately NOT raised. debug_loop_guidance() tells
        # the model this budget explicitly so it plans the loop instead of
        # burning rounds on repeats.
        max_iterations=max(1, int(settings.max_tool_rounds)),
        max_execution_time=float(settings.max_agent_seconds),
        early_stopping_method="force",
        return_intermediate_steps=True,
    )


class AgentStoppedError(Exception):
    """The executor hit its round or wall-clock limit and produced no answer.

    Deliberately not a ``RuntimeError``: the server reads that as "not
    configured" and answers 200 with setup text. This is a failed run, so it
    surfaces as the 502 ``provider_error`` the web app already falls back on.
    """


#: LangChain's ``early_stopping_method="force"`` output when a run is cut off
#: by ``max_iterations`` or ``max_execution_time``. It arrives as an ordinary
#: ``output`` string, indistinguishable from an answer unless matched here.
_FORCE_STOP_MARKER = "agent stopped due to iteration limit or time limit"


def is_force_stop_output(output: str) -> bool:
    """Whether an executor output is its force-stop sentinel, not an answer.

    Args:
        output: The executor's final output text.

    Returns:
        True when the text is the "stopped due to iteration or time limit" message.
    """
    return output.strip().lower().startswith(_FORCE_STOP_MARKER)


def ask(
    question: str,
    level: str = "beginner",
    history: list[dict[str, str]] | None = None,
    circuit_qasm: str | None = None,
    llm_override: LlmOverride | None = None,
    learner_plan: str | None = None,
) -> dict[str, Any]:
    """Ask QuantumMind a question and get its reply plus the tools it used.

    Args:
        question: The learner's question.
        level: Learner level (``"beginner"``, ``"intermediate"``, ``"advanced"``).
        history: Prior turns as ``{"role": "user"|"assistant", "content": str}``
            dicts, oldest first.
        circuit_qasm: OpenQASM the learner currently has open, if any.
        llm_override: Provider/key choice forwarded by the web app, if any.
        learner_plan: Study plan the learner opted in to sharing, if any.

    Returns:
        ``{"reply": str, "tools_used": list[str]}``.

    Raises:
        RuntimeError: If the service is not configured (no API key or missing
            LangChain dependencies).
        AgentStoppedError: If the run hit its round or time limit and so has no
            real answer to return.
    """
    executor = build_agent(
        level=level,
        circuit_qasm=circuit_qasm,
        llm_override=llm_override,
        learner_plan=clamp_text(learner_plan) if learner_plan else None,
    )

    from langchain_core.messages import AIMessage, HumanMessage

    # SECURITY (audit finding INJ-1): bound the conversation before it is sent.
    # apps/web/app/api/agent/route.ts applies the same caps, but this service
    # listens on its own port and must not depend on its only current caller
    # having done the work.
    chat_history: list[Any] = []
    for turn in bounded_history(history):
        role = str(turn.get("role", "")).lower()
        content = clamp_text(turn.get("content", ""))
        if not content:
            continue
        if role in {"user", "human"}:
            chat_history.append(HumanMessage(content=content))
        elif role in {"assistant", "ai"}:
            chat_history.append(AIMessage(content=content))

    result = executor.invoke(
        {"input": clamp_text(question), "chat_history": chat_history}
    )

    tools_used: list[str] = []
    for step in result.get("intermediate_steps", []) or []:
        action = step[0] if isinstance(step, (list, tuple)) and step else None
        name = getattr(action, "tool", None)
        if name and name not in tools_used:
            tools_used.append(str(name))

    output = result.get("output", "")
    if isinstance(output, list):
        output = "".join(
            block.get("text", "") if isinstance(block, dict) else str(block) for block in output
        )

    reply = str(output).strip()
    if is_force_stop_output(reply):
        raise AgentStoppedError("agent run stopped at its iteration or time limit")

    return {"reply": reply, "tools_used": tools_used}
