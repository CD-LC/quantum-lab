"""Circuit execution, statevector analysis, backend listing and preset routes."""

from __future__ import annotations

from typing import Any, Callable, TypeVar

import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core.config import settings
from app.quantum import resources, runner
from app.quantum.backends import BackendInfo, list_backends
from app.quantum.presets import get_preset, list_presets

router = APIRouter(prefix="/api/circuits", tags=["circuits"])

T = TypeVar("T")

# ── SECURITY FIX: pre-parse resource guard (audit finding PY-1) ──────────────
#
# The qubit cap was enforced AFTER parse_qasm() had already built the circuit:
#
#     circuit = parse_qasm(qasm)                       # <- unbounded work here
#     if circuit.num_qubits > backend.max_qubits: ...  # <- cap checked too late
#
# Measured on this machine: the 50-byte body `qreg q[3000000];` makes Qiskit
# allocate ~600 MB and burn 5.6 s of CPU before the check is reached, and the
# cost is linear in the declared width, so a slightly larger literal OOM-kills
# the process. The QASM source itself was unbounded too.
#
# These two checks are cheap string work and run BEFORE any parser is invoked.
# They are a floor, not a replacement for the real cap: the post-parse check
# still runs and still owns the exact per-backend limit.

#: Largest QASM body accepted, in characters. Course circuits are a few hundred
#: bytes; 128 KiB is generous for a machine-generated one.
MAX_QASM_CHARS = 131_072

#: `qreg q[12];` (QASM 2) and `qubit[12] q;` / `bit[12] c;` (QASM 3).
#:
#: The size is captured as ANY text up to the closing bracket, not just digits:
#: OpenQASM 3 also accepts ``100_000``, ``0x186A0`` and ``50000*2``, and a guard
#: that only recognised plain digits skipped those entirely (a ~90-byte
#: ``qubit[4_000_000] q;`` then OOM-killed the replica). Anything that is not a
#: plain decimal literal is treated as over the limit rather than evaluated.
_QASM2_REGISTER = re.compile(r"\b[qc]reg\s+\w+\s*\[([^\]]*)\]", re.IGNORECASE)
_QASM3_REGISTER = re.compile(r"\b(?:qubit|bit)\s*\[([^\]]*)\]", re.IGNORECASE)
_PLAIN_DECIMAL = re.compile(r"\d{1,12}")
_QASM_COMMENT = re.compile(r"//[^\n]*|/\*.*?(?:\*/|\Z)", re.DOTALL)


def _is_numeric_size(size: str) -> bool:
    """Whether a register-size bracket body is a plain numeric expression.

    Args:
        size: The text between the brackets, already stripped.

    Returns:
        True for literals and arithmetic on them (``12``, ``4_000_000``,
        ``0x186A0``, ``50000*2``); False for empty text or anything naming an
        identifier.
    """
    if not size:
        return False
    # Hex digits look like identifiers once the 0x prefix is split off, so test
    # each whitespace/operator-separated token whole.
    for token in re.split(r"[\s()+\-*/%]+", size):
        if token and not re.fullmatch(r"\d[\w.]*", token):
            return False
    return True


def guard_qasm(qasm: str, max_qubits: int | None = None) -> None:
    """Reject a circuit that is too large before any parser touches it.

    Args:
        qasm: The raw OpenQASM source from the request.
        max_qubits: Width ceiling to apply; ``settings.max_qubits`` when None.
            Callers that know the target backend pass its effective limit (see
            :func:`app.quantum.runner.effective_max_qubits`) so a noisy run is
            refused at its own, much lower, bound before the parse rather than
            after it.

    Raises:
        HTTPException: 413 when the source is too long, 400 when it declares a
            register wider than the applicable limit.
    """
    if len(qasm) > MAX_QASM_CHARS:
        raise HTTPException(
            status_code=413,
            detail=(
                f"QASM source must be at most {MAX_QASM_CHARS} characters "
                f"(got {len(qasm)})."
            ),
        )

    limit = settings.max_qubits if max_qubits is None else min(max_qubits, settings.max_qubits)
    # Comments are not code: "// the qubit[ register" must not be read as one.
    code = _QASM_COMMENT.sub(" ", qasm)
    for pattern in (_QASM2_REGISTER, _QASM3_REGISTER):
        for match in pattern.finditer(code):
            size = match.group(1).strip()
            if not _is_numeric_size(size):
                # A named constant, an empty bracket or anything else that is
                # not a literal expression: the parser resolves it and
                # MAX_PARSED_QUBITS refuses it afterwards if it is too wide.
                continue
            # A plain decimal is compared exactly. Anything else (a very long
            # digit run, underscores, hex/octal/binary, an expression, a
            # constant name) cannot be evaluated cheaply here, so it is over
            # the limit by definition. int() on >4300 digits would also raise
            # ValueError in Python 3.11+ and surface as a 500 rather than a 400.
            declared = int(size) if _PLAIN_DECIMAL.fullmatch(size) else limit + 1
            if declared > limit:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Circuit declares a {declared}-register but this service "
                        f"accepts at most {limit} qubits."
                    ),
                )


def _guard(operation: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """Run a runner call, translating ValueError into a 400 response.

    Args:
        operation: The callable to invoke.
        *args: Positional arguments forwarded to ``operation``.
        **kwargs: Keyword arguments forwarded to ``operation``.

    Returns:
        Whatever ``operation`` returns.

    Raises:
        HTTPException: 400 when the operation raises ValueError.
    """
    try:
        return operation(*args, **kwargs)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class RunRequest(BaseModel):
    """Payload for a circuit execution request."""

    qasm: str = Field(description="OpenQASM 3 (or 2) circuit source.")
    backend: str | None = Field(default=None, description="Backend id; defaults to Aer.")
    shots: int = Field(1024, ge=1, le=20000, description="Number of repetitions.")
    noise: float = Field(0.0, ge=0.0, le=0.5, description="Depolarising noise strength.")


class StatevectorRequest(BaseModel):
    """Payload for a statevector analysis request."""

    qasm: str = Field(description="OpenQASM 3 (or 2) circuit source, max 12 qubits.")


class RunResponse(BaseModel):
    """Measurement statistics returned by a circuit execution."""

    counts: dict[str, int]
    probabilities: list[float]
    labels: list[str]
    shots: int
    backend: str
    duration_ms: float
    num_qubits: int
    depth: int
    notes: str | None = None


class Amplitude(BaseModel):
    """A single complex amplitude split into real and imaginary parts."""

    re: float
    im: float


class StatevectorResponse(BaseModel):
    """The exact state of a circuit with measurements stripped."""

    amplitudes: list[Amplitude]
    probabilities: list[float]
    labels: list[str]
    num_qubits: int


class PresetResponse(BaseModel):
    """A named example circuit."""

    id: str
    name: str
    description: str
    qasm: str


@router.post("/run", response_model=RunResponse)
def run(request: RunRequest) -> dict[str, Any]:
    """Execute a circuit and return its measurement distribution.

    Args:
        request: The circuit, backend, shots and noise level.

    Returns:
        The runner's result dictionary.
    """
    # SECURITY FIX (audit finding PY-1): cap before work. The limit is the one
    # for THIS backend at THIS noise level, not the global 24 — a 16-qubit noisy
    # run costs 13.7 s of CPU and must not reach the parser either.
    guard_qasm(
        request.qasm,
        runner.effective_max_qubits(request.backend or settings.default_backend, request.noise),
    )
    return _guard(
        runner.run_circuit,
        request.qasm,
        backend_id=request.backend,
        shots=request.shots,
        noise=request.noise,
    )


class ResourceEstimateRequest(BaseModel):
    """Ask what an algorithm would cost on a fault-tolerant machine.

    Either give a circuit, or give the three numbers directly. A circuit is
    read into ``algorithm_qubits`` / ``t_count`` / ``logical_depth``, and any
    field supplied explicitly overrides what was read — which is how somebody
    asks "what if my T count were ten times larger" without writing that
    circuit.
    """

    qasm: str | None = Field(default=None, description="Circuit to read the counts from.")
    algorithm_qubits: int | None = Field(default=None, ge=1, le=1_000_000)
    t_count: int | None = Field(default=None, ge=0)
    logical_depth: int | None = Field(default=None, ge=1)
    #: Physical two-qubit error rate. The surface code only suppresses errors
    #: BELOW its threshold, so a value at or above it is refused rather than
    #: answered with an enormous distance.
    physical_error_rate: float = Field(1e-3, gt=0, lt=1)
    target_total_error: float = Field(1e-2, gt=0, lt=1)
    code_cycle_seconds: float = Field(
        default=resources.DEFAULT_CODE_CYCLE_SECONDS, gt=0, description="Syndrome round duration."
    )
    factory_count: int | None = Field(default=None, ge=1)
    model_magic_states: bool = True


@router.post("/resources")
def estimate_resources(request: ResourceEstimateRequest) -> dict[str, Any]:
    """Estimate the fault-tolerant cost of an algorithm, to an order of magnitude.

    "How many physical qubits and how much runtime would this need under a
    given code and error budget?" is the most-asked question in quantum
    algorithm research and the one nobody can answer by running anything.

    THIS IS AN ORDER-OF-MAGNITUDE PROJECTION AND THE RESPONSE SAYS SO IN ITS
    OWN FIELDS — ``estimate_kind``, ``disclaimer``, ``assumptions`` and
    ``caveats`` are part of the payload, not decoration, and a client that
    renders only ``physical_qubits`` and ``runtime_human`` is presenting a
    projection as a measurement. The threshold constant is fitted rather than
    derived, the model ignores routing overhead, and the T-count for arbitrary
    rotations is a synthesis estimate. All of that is in ``caveats``.

    Args:
        request: A circuit, or the three logical counts, plus the error budget.

    Returns:
        The estimate, with ``circuit`` attached when a circuit was supplied.

    Raises:
        HTTPException: 400 when the inputs are refused — including a physical
            error rate at or above the code's threshold, where no distance
            helps and a number would be a lie.
    """
    counts: dict[str, Any] | None = None
    if request.qasm is not None:
        # SECURITY FIX (audit finding PY-1): cap before parsing, same as /run.
        guard_qasm(request.qasm)
        counts = _guard(resources.logical_counts_from_qasm, request.qasm)

    # An explicit field wins over one read from the circuit; with neither, the
    # defaults describe a single-qubit, zero-T, depth-1 circuit, which is the
    # smallest thing that can be estimated rather than an error.
    estimate = _guard(
        resources.estimate_resources,
        algorithm_qubits=(
            request.algorithm_qubits
            if request.algorithm_qubits is not None
            else (counts["algorithm_qubits"] if counts else 1)
        ),
        t_count=(
            request.t_count if request.t_count is not None else (counts["t_count"] if counts else 0)
        ),
        logical_depth=(
            request.logical_depth
            if request.logical_depth is not None
            else (counts["logical_depth"] if counts else 1)
        ),
        physical_error_rate=request.physical_error_rate,
        target_total_error=request.target_total_error,
        code_cycle_seconds=request.code_cycle_seconds,
        factory_count=request.factory_count,
        model_magic_states=request.model_magic_states,
    )
    if counts is not None:
        estimate["circuit"] = counts
    return estimate


@router.post("/statevector", response_model=StatevectorResponse)
def compute_statevector(request: StatevectorRequest) -> dict[str, Any]:
    """Compute the exact statevector of a circuit.

    Args:
        request: The circuit source.

    Returns:
        Amplitudes, probabilities, labels and the qubit count.
    """
    guard_qasm(request.qasm)  # SECURITY FIX (audit finding PY-1): cap before work.
    return _guard(runner.statevector, request.qasm)


@router.get("/backends", response_model=list[BackendInfo])
def backends() -> list[BackendInfo]:
    """List every execution target with its live availability.

    Returns:
        The full backend registry.
    """
    return _guard(list_backends)


@router.get("/presets", response_model=list[PresetResponse])
def presets() -> list[dict[str, Any]]:
    """List the built-in example circuits.

    Returns:
        Every preset with its id, name, description and QASM.
    """
    return _guard(list_presets)


@router.get("/presets/{preset_id}", response_model=PresetResponse)
def preset(preset_id: str) -> dict[str, Any]:
    """Fetch a single example circuit by id.

    Args:
        preset_id: The preset key, e.g. ``"bell"``.

    Returns:
        The preset dictionary.

    Raises:
        HTTPException: 404 when the preset does not exist.
    """
    found = _guard(get_preset, preset_id)
    if found is None:
        raise HTTPException(status_code=404, detail=f"Unknown preset '{preset_id}'.")
    return found
