"""Configuration for the Qubit16 agent service.

Settings come from environment variables (or a local ``.env`` file) and are
exposed through the module-level :data:`settings` singleton. Importing this
module never requires an API key: ``anthropic_api_key`` defaults to ``None``
and only the LLM-backed entry points complain about a missing key.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings for the agent service.

    Attributes:
        gemini_api_key: Google AI Studio (Gemini) key. Checked first — Gemini
            Flash has a genuinely free tier, so this is the cheapest way to
            run a live tutor with zero paying users.
        groq_api_key: Groq key (open-weight models, extremely cheap/fast,
            second choice).
        anthropic_api_key: Anthropic API key — kept as the premium/fallback
            option, no longer the only one.
        azure_api_key: Azure OpenAI resource key. Paired with
            ``azure_api_base``/``azure_api_version`` and a deployment name in
            ``model`` (LiteLLM's ``azure/<deployment-name>`` form) — set only
            when ``ENABLE_MILESTONE_WORKLOADS`` provisioned an Azure OpenAI
            resource (see the internal Azure-credits notes). Not part of the
            cheapest-first default order: it isn't a free tier, so it's a
            selectable option here, not a default.
        azure_api_base: The Azure OpenAI resource's endpoint URL, e.g.
            ``https://<resource>.openai.azure.com/``.
        azure_api_version: The Azure OpenAI REST API version, e.g.
            ``"2024-10-21"``. LiteLLM requires this explicitly for Azure —
            unlike the other three providers, it isn't inferable from the key.
            ``None`` for any of the four means "that provider not
            configured"; the tools and knowledge base work with zero keys set.
        quantum_api_url: Base URL of the Qubit16 circuit-execution API.
        model: LiteLLM-style model id used by the tutor, e.g.
            ``"gemini/gemini-2.5-flash"``, ``"groq/llama-3.3-70b-versatile"``,
            or ``"anthropic/claude-sonnet-4-6"``. The provider prefix picks
            which of the three keys above LiteLLM reads — see
            ``docs/LLM-GATEWAY.md``.
        max_tokens: Maximum tokens the tutor may generate per reply.
        temperature: Sampling temperature for the tutor.
        max_tool_rounds: Hard ceiling on tool-invocation rounds per request.
        max_agent_seconds: Wall-clock ceiling on one agent run.
        max_history_turns: Prior turns of conversation accepted per request.
        max_message_chars: Characters accepted in any single turn.
        max_shots: Ceiling on the ``shots`` argument of ``run_quantum_circuit``.
        llm_request_timeout: Seconds before a single LLM call is abandoned.
        max_qubits: Qubit ceiling for the local simulation fallback.
        max_circuit_gates: Expanded-gate ceiling for the local simulation.
        max_qasm_chars: Characters of QASM ``run_quantum_circuit`` accepts.
        max_sim_work: Estimated-work ceiling for the local simulation.
        sim_max_memory_mb: Memory ceiling handed to Aer.
    """

    gemini_api_key: str | None = None
    groq_api_key: str | None = None
    anthropic_api_key: str | None = None
    #: LiteLLM reads these three under their own conventional names
    #: (AZURE_API_KEY / AZURE_API_BASE / AZURE_API_VERSION) — matching that
    #: naming here means pydantic-settings' case-insensitive env lookup wires
    #: them through with no translation layer.
    azure_api_key: str | None = None
    azure_api_base: str | None = None
    azure_api_version: str | None = None
    quantum_api_url: str = "http://localhost:8000"

    #: Comma-separated CORS origins. Same variable name and same default as
    #: services/api, so one setting covers both Python services.
    allowed_origins: str = "http://localhost:3000"

    #: Default: Gemini's free-tier-eligible Flash model — no real customers
    #: yet, so the cheapest capable option is the right default. Set MODEL to
    #: "groq/llama-3.3-70b-versatile", "anthropic/claude-sonnet-4-6", or
    #: "azure/<deployment-name>" (the deployment name chosen when the Azure
    #: OpenAI resource was created — see infra/azure/deploy.sh and
    #: the internal Azure-credits notes) to switch providers; only the env var changes,
    #: no code or redeploy of logic. LiteLLM (via langchain-litellm) is the
    #: open-source gateway that makes this a config change instead of four
    #: integrations — see docs/LLM-GATEWAY.md.
    model: str = "gemini/gemini-2.5-flash"
    max_tokens: int = 1024
    temperature: float = 0.3

    # ── Prompt-injection clamps (audit finding INJ-1) ────────────────────
    #
    # Everything the tutor reads is attacker-reachable: the learner's question,
    # the QASM in their editor, the lesson text retrieved from the course index
    # and the abstract of any arXiv paper they name. None of that can be made
    # trustworthy, so the defence is to bound what an instruction hidden in it
    # can *spend*: how many times the model may go round the tool loop, how long
    # a run may take, how much conversation it may carry, and how much work any
    # single tool call may do.
    #
    # These are settings rather than literals so an operator can tighten them
    # without a deploy. Raising them is a cost decision — read the note above.

    #: Tool-invocation rounds per request. Every round is another LLM call
    #: billed to the operator, and another chance for a tool result to carry
    #: injected text back into the context. Six is comfortably more than a real
    #: tutoring answer needs (generate, check, run, explain is four).
    max_tool_rounds: int = 6

    #: Wall-clock ceiling on one agent run. max_tool_rounds bounds the number of
    #: steps but not their duration: a local Aer simulation is one step and can
    #: run for minutes. This bounds the process time an anonymous request can
    #: hold, which max_tool_rounds alone does not.
    #: Kept below the web route's 25 s AGENT_TIMEOUT_MS (apps/web/app/api/agent/
    #: route.ts): a run the web has already abandoned is billed and discarded.
    #: The check is made between tool rounds, so one round may overshoot it by
    #: up to ``llm_request_timeout``; each tool call is bounded separately.
    max_agent_seconds: float = 20.0

    #: Per-call timeout handed to the LLM client. LiteLLM's own default is 600 s,
    #: and a stalled provider endpoint would pin a worker thread for that long.
    llm_request_timeout: float = 20.0

    #: Prior turns carried into the prompt. The whole history is re-sent on
    #: every request and billed every time, and a long history is where a
    #: patient injector accumulates instructions.
    max_history_turns: int = 20

    #: Characters accepted in any one turn, including the current question.
    max_message_chars: int = 8000

    #: Ceiling on ``run_quantum_circuit(shots=...)``. The execution API already
    #: caps at 20 000 and answers 400 — but the tool SWALLOWS that error and
    #: falls back to a LOCAL Aer simulation at the requested count, so without
    #: this an injected "run it with 500000000 shots" burns CPU in this process
    #: with nothing in its way. Matches services/api's max_shots.
    max_shots: int = 20000

    #: Local-simulation bounds for ``run_quantum_circuit`` (reached when the
    #: execution API is unreachable). Without them one anonymous message can ask
    #: this process to allocate a 2^n statevector or expand a nested-gate bomb
    #: inside a 0.5 GiB / 0.25 vCPU container. ``max_qubits`` matches
    #: ``paper.MAX_RUNNABLE_QUBITS``.
    max_qubits: int = 16
    #: Ceiling on the gate count AFTER custom gate definitions are expanded.
    max_circuit_gates: int = 5000
    #: Characters of QASM accepted by ``run_quantum_circuit``. Rejected (not
    #: truncated, which would silently run a different circuit) above this.
    #: Matches the 20 000 the HTTP schema accepts.
    max_qasm_chars: int = 20000
    #: Ceiling on estimated simulation work: expanded gates * 2^qubits, times
    #: shots when the circuit measures mid-circuit or resets (Aer then
    #: re-simulates every shot).
    max_sim_work: int = 1_000_000_000
    #: Passed to ``AerSimulator(max_memory_mb=...)`` so Aer refuses rather than
    #: allocates beyond this. Aer's own default is host RAM, not the cgroup.
    sim_max_memory_mb: int = 256

    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
        case_sensitive=False,
    )

    @property
    def origins_list(self) -> list[str]:
        """Return ``allowed_origins`` split on commas, stripped and de-blanked.

        SECURITY FIX (audit finding CORS-1). A wildcard is refused outright.

        ``agent/server.py`` sets ``allow_credentials=True``; a wildcard origin
        paired with that is credentialed any-origin access, letting any page a
        user visits call this tutor from their browser and read the reply — on
        an endpoint that spends the operator's Anthropic budget. Mirrors
        ``services/api/app/core/config.py`` deliberately: two services, one rule.

        Returns:
            The list of CORS origins configured for this deployment.

        Raises:
            ValueError: If any entry is ``*``. The service refuses to start.
        """
        origins = [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]
        if any(origin == "*" for origin in origins):
            raise ValueError(
                "ALLOWED_ORIGINS may not contain '*'. The agent service sends "
                "CORS responses with allow_credentials=True, and a wildcard "
                "origin combined with credentials lets any site on the internet "
                "call this metered tutor from a visitor's browser. Set "
                "ALLOWED_ORIGINS to your app origin, e.g. "
                "ALLOWED_ORIGINS=https://your-domain.example."
            )
        return origins

    @property
    def has_llm_key(self) -> bool:
        """Whether any provider key is set — Gemini, Groq, Anthropic, or Azure OpenAI.

        The tutor is "configured" the moment one of the four is present,
        regardless of which ``model`` currently points at. This is what lets
        an operator set only ``GEMINI_API_KEY`` and get a live tutor for
        free, with no Anthropic key at all. Azure counts only when both the
        key and the endpoint base are present — one without the other is not
        a usable provider.
        """
        return bool(
            (self.gemini_api_key or "").strip()
            or (self.groq_api_key or "").strip()
            or (self.anthropic_api_key or "").strip()
            or ((self.azure_api_key or "").strip() and (self.azure_api_base or "").strip())
        )


settings = Settings()
