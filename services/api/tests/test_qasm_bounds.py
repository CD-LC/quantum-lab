"""Pre- and post-parse bounds on hostile OpenQASM (audit findings on PY-1).

``guard_qasm`` used to recognise only plain-decimal register sizes, so
``qubit[4_000_000]`` walked past it; and nothing bounded how far nested gate
definitions expand, so a 660-byte circuit transpiled to 131k gates.
"""

from __future__ import annotations

import time

import pytest
from fastapi import HTTPException

from app.quantum.limits import MAX_EXPANDED_OPERATIONS
from app.quantum.runner import parse_qasm
from app.quantum.transpile import analyse_circuit, transpile_for
from app.routers.circuits import guard_qasm

HEADER = 'OPENQASM 3.0;\ninclude "stdgates.inc";\n'


@pytest.mark.parametrize(
    "size",
    ["100_000", "0x186A0", "50000*2", "4_000_000", "0b1000000000", "0o777777", "N", "1e9"],
)
def test_guard_rejects_non_decimal_register_sizes(size: str) -> None:
    with pytest.raises(HTTPException) as info:
        guard_qasm(f"{HEADER}qubit[{size}] q;\n")
    assert info.value.status_code == 400


def test_guard_rejects_non_decimal_qasm2_and_bit_registers() -> None:
    with pytest.raises(HTTPException):
        guard_qasm("OPENQASM 2.0;\nqreg q[0x186A0];\n")
    with pytest.raises(HTTPException):
        guard_qasm(f"{HEADER}qubit[2] q;\nbit[1_000_000] c;\n")


def test_guard_still_accepts_ordinary_registers() -> None:
    guard_qasm(f"{HEADER}qubit[ 3 ] q;\nbit[3] c;\nh q[0];\n")
    guard_qasm("OPENQASM 2.0;\nqreg q[24];\ncreg c[24];\n")
    guard_qasm(f"{HEADER}qubit q;\n")


def _doubling(levels: int) -> str:
    lines = [HEADER, "qubit[2] q;\n", "gate g0 a,b {h a; cx a,b;}\n"]
    for i in range(1, levels + 1):
        lines.append(f"gate g{i} a,b {{g{i - 1} a,b; g{i - 1} a,b;}}\n")
    lines.append(f"g{levels} q[0],q[1];\n")
    return "".join(lines)


def test_nested_gate_tower_is_refused_quickly() -> None:
    qasm = _doubling(15)
    guard_qasm(qasm)  # the source-text guard cannot see it
    start = time.perf_counter()
    for call in (parse_qasm, analyse_circuit, lambda q: transpile_for(q, "ibm_brisbane")):
        with pytest.raises(ValueError, match="expands to more than"):
            call(qasm)
    # Qiskit's own parser needs ~3 s to build the tower before we can count it;
    # the point is that three refusals take seconds, not the 133 s each of the
    # unguarded transpile.
    assert time.perf_counter() - start < 60


def test_modest_nested_gates_still_parse() -> None:
    circuit = parse_qasm(_doubling(4))
    assert circuit.num_qubits == 2
    assert analyse_circuit(_doubling(4))["num_qubits"] == 2
    assert MAX_EXPANDED_OPERATIONS > 2**5
