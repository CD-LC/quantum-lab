"""Circuit parsing, simulation and statevector analysis.

This module is the single execution path shared by every API route. It depends
only on qiskit and qiskit-aer; every vendor SDK is imported lazily so that a
missing package degrades into a clear error rather than an import crash.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from qiskit import QuantumCircuit, transpile

from app.core.config import settings
from app.quantum.backends import BackendInfo, get_backend
from app.quantum.limits import (
    MAX_EXPANDED_OPERATIONS,
    MAX_NOISY_QUBITS,
    MAX_PARSED_QUBITS,
    MAX_STATEVECTOR_QUBITS,
)

logger = logging.getLogger(__name__)

# Gates that receive the 1-qubit error terms in the noise model.
_ONE_QUBIT_GATES = ["h", "x", "y", "z", "s", "sdg", "t", "tdg", "rx", "ry", "rz", "p", "u", "sx"]
# Gates that receive the 2-qubit error terms in the noise model.
_TWO_QUBIT_GATES = ["cx", "cy", "cz", "swap", "ecr"]

# ── DEVICE NOISE PARAMETERS ─────────────────────────────────────────────────
#
# WHERE THESE CAME FROM, and what they are not.
#
# They are IBM's published median calibration figures for the Eagle r3 family
# (ibm_brisbane / ibm_kyiv / ibm_sherbrooke — the three devices this service
# lists in app/quantum/hardware.py KNOWN_DEVICES), rounded to the precision the
# medians are quoted at. They are a SPECIFICATION SHEET, not a measurement:
# nothing here has been read from a live backend, per-qubit variation on a real
# device spans roughly a factor of five around each median, and calibration
# moves daily.
#
# So this model is right to about an order of magnitude, and that is the claim
# it makes. It is enough for the thing a learner actually needs to see — that a
# deep circuit decoheres, that two-qubit gates dominate the error budget by an
# order of magnitude, and that readout is not free — and it is not enough to
# predict what a specific device will return on a specific day.
#
# TO MAKE IT REAL, rather than representative: with qiskit-ibm-runtime installed
# and IBM_QUANTUM_TOKEN set, `NoiseModel.from_backend(service.backend(name))`
# builds this same object from that device's current calibration, per qubit and
# per gate. That is a network call on the request path, so it is not the default
# and is not wired up; see docs/PENNYLANE.md for the trade-off.
#
# The previous model was a flat depolarising probability of 0.02 for 1-qubit
# gates and 0.04 for 2-qubit ones, with no decoherence at all and no readout
# error. 0.02 has no source; it is roughly 80x IBM's median 1-qubit error and
# 3x its median 2-qubit error, so it got the ABSOLUTE size wrong in one
# direction and the RATIO between one- and two-qubit gates wrong in the other —
# on real hardware a CX is ~30x worse than an X, not 2x. A learner tuning a
# circuit against it would draw the wrong conclusion about where to spend depth.

#: Median energy-relaxation time, seconds. IBM Eagle r3 median ~230 us.
DEVICE_T1_SECONDS = 230e-6
#: Median dephasing time, seconds. Eagle r3 median ~130 us. Physically T2 <= 2*T1;
#: 130 us against 230 us satisfies that, and _thermal_error() asserts it.
DEVICE_T2_SECONDS = 130e-6
#: Median 1-qubit (sx) gate duration, seconds.
DEVICE_ONE_QUBIT_GATE_SECONDS = 60e-9
#: Median 2-qubit (ECR) gate duration, seconds. An order of magnitude longer
#: than a 1-qubit gate, which is most of why 2-qubit gates dominate the error.
DEVICE_TWO_QUBIT_GATE_SECONDS = 660e-9
#: Median 1-qubit gate error, as a depolarising probability.
DEVICE_ONE_QUBIT_ERROR = 2.5e-4
#: Median 2-qubit (ECR) gate error. ~30x the 1-qubit figure, which is the single
#: most important ratio in this table for anyone designing a circuit.
DEVICE_TWO_QUBIT_ERROR = 7.5e-3
#: Median readout assignment error, applied symmetrically to both outcomes.
DEVICE_READOUT_ERROR = 1.5e-2


def effective_max_qubits(backend_id: str, noise: float = 0.0) -> int:
    """Return the widest circuit this backend will accept at this noise level.

    The answer depends on the noise level, not only the backend: passing
    ``noise > 0`` to ``aer_simulator`` switches on the same noise model
    ``aer_noisy`` uses, and therefore the same cost curve.

    Args:
        backend_id: A backend id from the registry, or None/unknown, in which
            case the service-wide ``settings.max_qubits`` is returned.
        noise: The requested depolarising strength.

    Returns:
        A qubit count, always <= ``settings.max_qubits``.
    """
    ceiling = settings.max_qubits
    if backend_id == "aer_noisy" or noise > 0:
        return min(ceiling, MAX_NOISY_QUBITS)
    return ceiling


def assert_width_is_affordable(num_qubits: int, backend_id: str, noise: float = 0.0) -> None:
    """Refuse a circuit whose simulation would monopolise or exhaust the process.

    Args:
        num_qubits: The parsed circuit's width.
        backend_id: The resolved backend id.
        noise: The requested depolarising strength.

    Raises:
        ValueError: When the circuit is wider than this backend's measured
            bound. The message names the bound and why it exists, because the
            learner's next move is to shrink the circuit and they need to know
            by how much.
    """
    limit = effective_max_qubits(backend_id, noise)
    if num_qubits <= limit:
        return
    noisy = backend_id == "aer_noisy" or noise > 0
    detail = (
        "Noisy simulation costs shots x 2^n, not 2^n, so it is capped lower than "
        f"the ideal simulator's {settings.max_qubits}: a {num_qubits}-qubit noisy "
        "run would occupy a worker for minutes. Run it without noise, or on fewer "
        "qubits."
        if noisy
        else "Wider circuits do not fit in memory on this deployment."
    )
    raise ValueError(
        f"Circuit uses {num_qubits} qubits but backend '{backend_id}' accepts at "
        f"most {limit} here. {detail}"
    )


def parse_qasm(qasm: str) -> QuantumCircuit:
    """Parse OpenQASM 3 source, falling back to OpenQASM 2.

    Three parsers are tried in order: ``qiskit.qasm3.loads``, which delegates to
    ``qiskit-qasm3-import``; Qiskit's built-in native OpenQASM 3 importer; and
    the OpenQASM 2 reader.

    The first one is the only one that can read an angle expression. Qiskit's
    native importer folds no arithmetic at all — not ``pi``, not ``3.14/3`` —
    and the web app exports every rotation as an exact fraction of pi, so
    ``qiskit-qasm3-import`` is a REQUIRED dependency, not an optional extra.
    Removing it from requirements.txt makes the teleportation preset (and any
    circuit with a rotation gate) unparseable and therefore unrunnable and
    unpriceable. The two fallbacks stay because they still handle plain QASM 2
    and because a parser that aborts on one dialect should not sink a request.

    Args:
        qasm: The circuit source text.

    Returns:
        The parsed :class:`~qiskit.QuantumCircuit`.

    Raises:
        ValueError: When no parser accepts the source.
    """
    if not qasm or not qasm.strip():
        raise ValueError("Could not parse the circuit: the QASM source is empty.")

    from qiskit import qasm3

    parsers: list[tuple[str, Any]] = [
        ("OpenQASM 3", qasm3.loads),
        ("OpenQASM 3 (native)", _loads_qasm3_native),
        ("OpenQASM 2", QuantumCircuit.from_qasm_str),
    ]
    # An explicit `OPENQASM 2.x;` header means the QASM 3 parsers cannot help,
    # and the native one aborts the process rather than raising cleanly, so
    # skip straight to the QASM 2 reader.
    if _declares_qasm2(qasm):
        parsers = [parsers[2], parsers[0]]

    errors: list[str] = []
    for label, parser in parsers:
        try:
            circuit = parser(qasm)
        # Qiskit's native importer surfaces Rust panics as PanicException, which
        # derives from BaseException, so a bare `except Exception` would let it
        # escape and take down the request.
        except BaseException as exc:  # noqa: BLE001
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
            errors.append(f"{label}: {exc}")
            continue
        # Outside the try: a refusal here is final, not a reason to try the next
        # parser.
        assert_parsed_circuit_is_affordable(circuit)
        return circuit

    raise ValueError(f"Could not parse the circuit: {'; '.join(errors)}")


def expanded_operation_count(circuit: QuantumCircuit, cap: int = MAX_EXPANDED_OPERATIONS) -> int:
    """Count the primitive operations a circuit expands to, stopping past ``cap``.

    OpenQASM 3 ``gate`` definitions may call other definitions, and Qiskit keeps
    them lazy, so ``circuit.size()`` is 1 for a circuit that transpiles to
    131,074 gates. Only generic ``Gate``/``Instruction`` objects carry such a
    user definition (library gates are subclasses), so only those are recursed
    into; each distinct definition is counted once and memoised by name.

    Args:
        circuit: The parsed circuit.
        cap: Counts above this are clamped to ``cap + 1`` so the work stays bounded.

    Returns:
        The expanded count, or ``cap + 1`` when it exceeds ``cap``.
    """
    from qiskit.circuit import Gate, Instruction

    memo: dict[str, int] = {}

    def count(body: QuantumCircuit) -> int:
        total = 0
        for item in body.data:
            op = item.operation
            definition = None
            if type(op) in (Gate, Instruction):
                name = op.name
                if name in memo:
                    total += memo[name]
                    if total > cap:
                        return cap + 1
                    continue
                definition = op.definition
                if definition is not None:
                    memo[name] = size = min(count(definition), cap + 1)
                    total += size
                    if total > cap:
                        return cap + 1
                    continue
            total += 1
            if total > cap:
                return cap + 1
        return total

    try:
        return count(circuit)
    except RecursionError:
        return cap + 1


def assert_parsed_circuit_is_affordable(circuit: QuantumCircuit) -> None:
    """Refuse a parsed circuit whose width or expanded size is unbounded work.

    This is the post-parse backstop behind ``guard_qasm``: that guard reads
    source text and cannot see through a gate-definition tower, or evaluate every
    register-size spelling OpenQASM 3 accepts.

    Args:
        circuit: The parsed circuit.

    Raises:
        ValueError: When the circuit is wider than ``MAX_PARSED_QUBITS`` or
            expands to more than ``MAX_EXPANDED_OPERATIONS`` operations.
    """
    if circuit.num_qubits > MAX_PARSED_QUBITS:
        raise ValueError(
            f"Circuit has {circuit.num_qubits} qubits; this service accepts at most "
            f"{MAX_PARSED_QUBITS}."
        )
    if expanded_operation_count(circuit) > MAX_EXPANDED_OPERATIONS:
        raise ValueError(
            "Circuit expands to more than "
            f"{MAX_EXPANDED_OPERATIONS} operations once its gate definitions are "
            "unrolled; simplify the nested gate definitions."
        )


def _declares_qasm2(qasm: str) -> bool:
    """Detect an explicit OpenQASM 2 version header.

    Args:
        qasm: The circuit source text.

    Returns:
        True when the first meaningful statement declares OpenQASM 2.
    """
    for line in qasm.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("//"):
            continue
        return stripped.replace(" ", "").upper().startswith("OPENQASM2")
    return False


def _loads_qasm3_native(qasm: str) -> QuantumCircuit:
    """Parse OpenQASM 3 with Qiskit's built-in importer, silencing its warning.

    Args:
        qasm: The circuit source text.

    Returns:
        The parsed circuit.
    """
    import warnings

    from qiskit import qasm3

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return qasm3.loads_experimental(qasm)


def _ensure_measured(circuit: QuantumCircuit) -> QuantumCircuit:
    """Guarantee the circuit writes results into classical bits.

    Args:
        circuit: The parsed circuit.

    Returns:
        The circuit itself when it already has classical bits, otherwise a copy
        with ``measure_all`` applied.
    """
    if circuit.num_clbits > 0:
        return circuit
    return circuit.measure_all(inplace=False)


def _noise_module() -> Any:
    """Import ``qiskit_aer.noise``, turning its absence into a clear ValueError.

    Returns:
        The ``qiskit_aer.noise`` module.

    Raises:
        ValueError: When qiskit-aer's noise module cannot be imported.
    """
    try:
        from qiskit_aer import noise
    except ImportError as exc:  # pragma: no cover - qiskit-aer is a hard dep
        raise ValueError(f"Noise simulation requires qiskit-aer: {exc}") from exc
    return noise


def _build_noise_model(noise: float) -> Any:
    """Construct a flat depolarising noise model at a caller-chosen strength.

    This is the teaching dial, not the hardware proxy. ``noise`` means exactly
    what the API schema says it means — the depolarising probability applied to
    a 1-qubit gate — so a learner who asks for 0.1 sees a tenth of the state
    scrambled per gate and can watch a Bell peak collapse. Nothing here claims
    to resemble a device; :func:`build_device_noise_model` is the one that does.

    The 2-qubit probability is 2x the 1-qubit one. That ratio is wrong for real
    hardware (where it is closer to 30x, see DEVICE_TWO_QUBIT_ERROR) and it is
    kept only because it is the documented behaviour of an existing API knob.

    Args:
        noise: Depolarising probability for 1-qubit gates, in [0, 0.5].

    Returns:
        A ``qiskit_aer.noise.NoiseModel``.

    Raises:
        ValueError: When qiskit-aer's noise module cannot be imported.
    """
    noise_mod = _noise_module()
    model = noise_mod.NoiseModel()
    model.add_all_qubit_quantum_error(
        noise_mod.depolarizing_error(noise, 1), _ONE_QUBIT_GATES
    )
    model.add_all_qubit_quantum_error(
        noise_mod.depolarizing_error(min(noise * 2, 0.75), 2), _TWO_QUBIT_GATES
    )
    return model


def build_device_noise_model() -> Any:
    """Construct the superconducting-device proxy used by ``aer_noisy``.

    Three error sources, composed per gate, from the DEVICE_* constants above
    (read their block comment for provenance and for what this is not):

    * **Thermal relaxation** — T1 energy decay and T2 dephasing over the gate's
      real duration. This is the decoherence term, and it is why a deep circuit
      degrades even when every individual gate is nearly perfect: a 660 ns
      two-qubit gate spends 0.5% of a 130 us T2 on every application.
    * **Gate depolarising** — the residual coherent/control error left after
      relaxation is accounted for, at the device's median gate error.
    * **Readout error** — a symmetric bit-flip on measurement. It is the single
      largest term for a shallow circuit, and omitting it (as the old model did)
      makes a two-gate Bell circuit look far cleaner than any real device.

    Returns:
        A ``qiskit_aer.noise.NoiseModel``.

    Raises:
        ValueError: When qiskit-aer's noise module cannot be imported.
    """
    noise_mod = _noise_module()
    model = noise_mod.NoiseModel()

    one_qubit = _thermal_error(noise_mod, DEVICE_ONE_QUBIT_GATE_SECONDS, 1).compose(
        noise_mod.depolarizing_error(DEVICE_ONE_QUBIT_ERROR, 1)
    )
    two_qubit = _thermal_error(noise_mod, DEVICE_TWO_QUBIT_GATE_SECONDS, 2).compose(
        noise_mod.depolarizing_error(DEVICE_TWO_QUBIT_ERROR, 2)
    )
    model.add_all_qubit_quantum_error(one_qubit, _ONE_QUBIT_GATES)
    model.add_all_qubit_quantum_error(two_qubit, _TWO_QUBIT_GATES)
    model.add_all_qubit_readout_error(
        [
            [1 - DEVICE_READOUT_ERROR, DEVICE_READOUT_ERROR],
            [DEVICE_READOUT_ERROR, 1 - DEVICE_READOUT_ERROR],
        ]
    )
    return model


def _thermal_error(noise_mod: Any, duration: float, num_qubits: int) -> Any:
    """Build a thermal-relaxation error for a gate of the given duration.

    Args:
        noise_mod: The ``qiskit_aer.noise`` module.
        duration: Gate duration in seconds.
        num_qubits: 1 or 2; a 2-qubit error is the tensor product of two
            1-qubit ones, which is what Aer's own ``from_backend`` does.

    Returns:
        A ``QuantumError``.
    """
    # Aer rejects T2 > 2*T1 as unphysical, and so should we: it would mean the
    # qubit keeps phase coherence longer than it keeps its excitation, which no
    # amplitude-damping channel can produce.
    assert DEVICE_T2_SECONDS <= 2 * DEVICE_T1_SECONDS, (
        "T2 must not exceed 2*T1; check the DEVICE_T1_SECONDS / DEVICE_T2_SECONDS pair."
    )
    single = noise_mod.thermal_relaxation_error(
        DEVICE_T1_SECONDS, DEVICE_T2_SECONDS, duration
    )
    if num_qubits == 1:
        return single
    return single.tensor(single)


def _clean_counts(counts: dict[str, int]) -> dict[str, int]:
    """Strip register separators out of Qiskit count keys.

    ``measure_all`` produces keys such as ``"01 10"``; the API contract is plain
    bitstrings, so spaces are removed and colliding keys are summed.

    Args:
        counts: Raw counts as returned by Aer.

    Returns:
        Counts keyed by contiguous bitstrings.
    """
    cleaned: dict[str, int] = {}
    for key, value in counts.items():
        label = key.replace(" ", "")
        cleaned[label] = cleaned.get(label, 0) + int(value)
    return cleaned


def _run_on_aer(
    circuit: QuantumCircuit,
    shots: int,
    noise: float,
    apply_noise: bool,
    device_model: bool = False,
) -> dict[str, int]:
    """Execute a measured circuit on the Aer simulator.

    Args:
        circuit: A circuit that already contains measurements.
        shots: Number of repetitions.
        noise: Depolarising strength used when ``apply_noise`` is true and
            ``device_model`` is false.
        apply_noise: Whether to attach a noise model at all.
        device_model: Use the hardware proxy (:func:`build_device_noise_model`)
            instead of the flat depolarising dial. This is what ``aer_noisy``
            does when the caller supplies no explicit noise level.

    Returns:
        Raw counts from the simulator.
    """
    from qiskit_aer import AerSimulator

    if apply_noise and device_model:
        simulator = AerSimulator(noise_model=build_device_noise_model())
    elif apply_noise and noise > 0:
        simulator = AerSimulator(noise_model=_build_noise_model(noise))
    else:
        simulator = AerSimulator()

    transpiled = transpile(circuit, simulator)
    result = simulator.run(transpiled, shots=shots).result()
    return dict(result.get_counts())


def _run_on_cirq(circuit: QuantumCircuit, shots: int) -> tuple[dict[str, int], str | None]:
    """Execute via Google Cirq, falling back to Aer when conversion is impossible.

    Args:
        circuit: A measured circuit.
        shots: Number of repetitions.

    Returns:
        A ``(counts, notes)`` tuple; ``notes`` is set when Aer was used instead.

    Raises:
        ValueError: When cirq is not installed.
    """
    try:
        import cirq  # noqa: F401
        from cirq.contrib.qasm_import import circuit_from_qasm
    except ImportError as exc:
        raise ValueError(
            "The cirq_simulator backend requires Cirq. Install it with 'pip install cirq'. "
            f"(import error: {exc})"
        ) from exc

    try:
        cirq_circuit = circuit_from_qasm(_to_qasm2(circuit))
        simulator = cirq.Simulator()
        result = simulator.run(cirq_circuit, repetitions=shots)
        counts: dict[str, int] = {}
        for key, value in result.multi_measurement_histogram(
            keys=sorted(result.measurements)
        ).items():
            label = "".join(
                format(int(item), "b") if isinstance(item, int) else "".join(str(b) for b in item)
                for item in key
            )
            counts[label] = counts.get(label, 0) + int(value)
        if counts:
            return counts, None
        raise RuntimeError("Cirq returned no measurement results.")
    except Exception as exc:  # noqa: BLE001 - conversion is best-effort
        counts = _run_on_aer(circuit, shots, 0.0, apply_noise=False)
        return counts, (
            "Cirq could not execute this circuit directly "
            f"({exc}); the run fell back to the Qiskit Aer simulator."
        )


def _to_qasm2(circuit: QuantumCircuit) -> str:
    """Serialise a circuit to OpenQASM 2 text for vendor SDK import.

    Args:
        circuit: The circuit to serialise.

    Returns:
        OpenQASM 2 source.
    """
    from qiskit.qasm2 import dumps

    return dumps(circuit)


def _run_on_braket(circuit: QuantumCircuit, shots: int) -> tuple[dict[str, int], str | None]:
    """Execute via the Amazon Braket local simulator, falling back to Aer.

    Args:
        circuit: A measured circuit.
        shots: Number of repetitions.

    Returns:
        A ``(counts, notes)`` tuple; ``notes`` is set when Aer was used instead.

    Raises:
        ValueError: When the Braket SDK is not installed.
    """
    try:
        from braket.devices import LocalSimulator
    except ImportError as exc:  # pragma: no cover
        raise ValueError(
            "The braket_local backend requires the Amazon Braket SDK. Install it with "
            f"'pip install amazon-braket-sdk'. (import error: {exc})"
        ) from exc

    try:
        from braket.ir.openqasm import Program

        program = Program(source=_to_qasm3_for_braket(circuit))
        device = LocalSimulator()
        result = device.run(program, shots=shots).result()
        counts = {str(k): int(v) for k, v in result.measurement_counts.items()}
        if counts:
            return counts, None
        raise RuntimeError("Braket returned no measurement results.")
    except Exception as exc:  # noqa: BLE001
        counts = _run_on_aer(circuit, shots, 0.0, apply_noise=False)
        return counts, (
            "The Braket local simulator could not execute this circuit directly "
            f"({exc}); the run fell back to the Qiskit Aer simulator."
        )


def _to_qasm3_for_braket(circuit: QuantumCircuit) -> str:
    """Serialise a circuit to OpenQASM 3 text for the Braket SDK.

    Args:
        circuit: The circuit to serialise.

    Returns:
        OpenQASM 3 source.
    """
    from qiskit import qasm3

    return qasm3.dumps(circuit)


def _try_pennylane(
    qasm: str, backend_id: str, shots: int, noise: float
) -> dict[str, Any] | None:
    """Attempt the PennyLane path, returning None when Qiskit should run instead.

    PennyLane is the default engine for simulator backends, but it must never
    turn a runnable circuit into a user-visible error: any translation gap,
    missing plugin or execution failure is logged and reported as None so the
    caller falls through to the Qiskit path unchanged.

    Args:
        qasm: OpenQASM 3 (or 2) source.
        backend_id: The resolved backend id.
        shots: Number of repetitions.
        noise: Depolarising strength in [0, 0.5].

    Returns:
        A complete result dictionary when PennyLane ran the circuit, otherwise
        None.
    """
    from app.quantum.pennylane_runner import device_available, run_with_pennylane

    usable, reason = device_available(backend_id)
    if not usable:
        logger.debug("PennyLane cannot serve backend '%s': %s", backend_id, reason)
        return None

    try:
        return run_with_pennylane(qasm, backend_id, shots, noise)
    except Exception as exc:  # noqa: BLE001 - any failure falls back to Qiskit
        logger.info(
            "PennyLane could not run this circuit on '%s' (%s); falling back to Qiskit.",
            backend_id,
            exc,
        )
        return None


def run_circuit(
    qasm: str,
    backend_id: str | None = None,
    shots: int = 1024,
    noise: float = 0.0,
) -> dict[str, Any]:
    """Parse, validate and execute a circuit, returning measurement statistics.

    Args:
        qasm: OpenQASM 3 (or 2) source.
        backend_id: Target backend id; defaults to ``settings.default_backend``.
        shots: Number of repetitions, 1..``settings.max_shots``.
        noise: Depolarising strength in [0, 0.5]; 0 means an ideal run.

    Returns:
        A dictionary with counts, probabilities, labels, shots, backend,
        duration_ms, num_qubits, depth, notes and engine (``'pennylane'`` or
        ``'qiskit'``, naming which execution engine actually ran the circuit).

    Raises:
        ValueError: On invalid shots/noise, unknown or unavailable backends,
            unparseable QASM, or a circuit that is too wide for the backend.
    """
    if not isinstance(shots, int) or shots < 1 or shots > settings.max_shots:
        raise ValueError(f"shots must be between 1 and {settings.max_shots}, got {shots}.")
    if noise < 0.0 or noise > 0.5:
        raise ValueError(f"noise must be between 0.0 and 0.5, got {noise}.")

    resolved_id = backend_id or settings.default_backend
    backend: BackendInfo = get_backend(resolved_id)

    circuit = parse_qasm(qasm)
    if circuit.num_qubits > backend.max_qubits:
        raise ValueError(
            f"Circuit uses {circuit.num_qubits} qubits but backend "
            f"'{backend.id}' supports at most {backend.max_qubits}."
        )
    # The registry's max_qubits is what the backend can represent; this is what
    # this process can afford to run at the requested noise level. Both apply,
    # and the tighter one wins. See the measurement table above MAX_NOISY_QUBITS.
    assert_width_is_affordable(circuit.num_qubits, backend.id, noise)

    measured = _ensure_measured(circuit)
    notes: str | None = None

    # PennyLane is the default engine for simulators: one middleware integration
    # instead of one hand-written adapter per vendor. It returns None (never an
    # error) when it cannot handle the circuit, and the Qiskit path below runs.
    if backend.kind == "simulator":
        pennylane_result = _try_pennylane(qasm, backend.id, shots, noise)
        if pennylane_result is not None:
            pennylane_result["engine"] = "pennylane"
            return pennylane_result

    start = time.perf_counter()
    if backend.id in ("aer_simulator", "aer_noisy"):
        apply_noise = backend.id == "aer_noisy" or noise > 0
        # Two different models, deliberately. An explicit `noise` is the teaching
        # dial and means exactly what the schema says (flat depolarising). No
        # explicit noise on `aer_noisy` means "act like hardware", so the
        # device-derived model runs instead of the old unexplained 0.02 flat
        # depolarising — see the DEVICE_* block for where its numbers come from.
        device_model = backend.id == "aer_noisy" and noise == 0
        raw_counts = _run_on_aer(measured, shots, noise, apply_noise, device_model=device_model)
        if device_model:
            notes = (
                "No noise level supplied, so a superconducting-device proxy was used: "
                f"T1 {DEVICE_T1_SECONDS * 1e6:.0f} us, T2 {DEVICE_T2_SECONDS * 1e6:.0f} us, "
                f"1-qubit error {DEVICE_ONE_QUBIT_ERROR:.1e}, 2-qubit error "
                f"{DEVICE_TWO_QUBIT_ERROR:.1e}, readout error {DEVICE_READOUT_ERROR:.1e}. "
                "These are published median calibration figures for IBM Eagle r3 "
                "devices, not a reading from a live backend."
            )
    elif backend.id == "cirq_simulator":
        raw_counts, notes = _run_on_cirq(measured, shots)
    elif backend.id == "braket_local":
        raw_counts, notes = _run_on_braket(measured, shots)
    elif backend.id == "ibm_quantum":
        raise ValueError(
            "Running on real IBM Quantum hardware requires IBM_QUANTUM_TOKEN and is "
            "asynchronous: jobs are queued and can take minutes to hours. Use "
            "submit_hardware_job to enqueue the circuit and poll for its result "
            "instead of the synchronous /run endpoint."
        )
    else:  # pragma: no cover - registry and dispatch are kept in sync
        raise ValueError(f"Backend '{backend.id}' has no execution path implemented.")
    duration_ms = round((time.perf_counter() - start) * 1000, 2)

    counts = _clean_counts(raw_counts)
    labels = sorted(counts)
    total = sum(counts.values()) or 1
    probabilities = [counts[label] / total for label in labels]

    return {
        "counts": counts,
        "probabilities": probabilities,
        "labels": labels,
        "shots": shots,
        "backend": backend.id,
        "duration_ms": duration_ms,
        "num_qubits": circuit.num_qubits,
        "depth": measured.depth(),
        "notes": notes,
        "engine": "qiskit",
    }


def statevector(qasm: str) -> dict[str, Any]:
    """Compute the exact statevector of a circuit with measurements removed.

    Args:
        qasm: OpenQASM 3 (or 2) source.

    Returns:
        A dictionary with amplitudes (``{re, im}`` pairs), probabilities,
        labels and num_qubits.

    Raises:
        ValueError: When the circuit cannot be parsed or exceeds 12 qubits.
    """
    from qiskit.quantum_info import Statevector

    circuit = parse_qasm(qasm)
    if circuit.num_qubits > MAX_STATEVECTOR_QUBITS:
        raise ValueError(
            f"Statevector analysis is limited to {MAX_STATEVECTOR_QUBITS} qubits; "
            f"this circuit uses {circuit.num_qubits}."
        )

    unitary = QuantumCircuit(circuit.num_qubits)
    for instruction in circuit.data:
        if instruction.operation.name in ("measure", "barrier", "reset"):
            continue
        qubit_indices = [circuit.find_bit(qubit).index for qubit in instruction.qubits]
        unitary.append(instruction.operation, qubit_indices)

    state = Statevector.from_instruction(unitary)
    amplitudes = [{"re": float(amp.real), "im": float(amp.imag)} for amp in state.data]
    probabilities = [float(abs(amp) ** 2) for amp in state.data]
    width = circuit.num_qubits
    labels = [format(index, f"0{width}b") for index in range(len(probabilities))]

    return {
        "amplitudes": amplitudes,
        "probabilities": probabilities,
        "labels": labels,
        "num_qubits": width,
    }
