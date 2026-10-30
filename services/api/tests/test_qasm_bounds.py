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
    ["100_000", "0x186A0", "50000*2", "4_000_000", "0b1000000000", "0o777777", "1e9"],
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


def test_guard_leaves_named_constants_and_comments_alone() -> None:
    # A named constant is the parser's (and MAX_PARSED_QUBITS') business, not a
    # "25-register" refusal from a text scan.
    guard_qasm(f"{HEADER}const int n = 3;\nqubit[n] q;\nbit[n] c;\n")
    # Comments that merely contain the words are not register declarations.
    guard_qasm(f"{HEADER}// the qubit[ register and bit[s of data\nqubit[2] q;\n")
    guard_qasm(f"{HEADER}/* qubit[N_big]\n   bit[1_000_000] */\nqubit[2] q;\n")
    # ...but a real oversized declaration next to a comment is still refused.
    with pytest.raises(HTTPException) as info:
        guard_qasm(f"{HEADER}// small\nqubit[4_000_000] q; // big\n")
    assert info.value.status_code == 400


def test_qasm2_gate_definition_tower_is_refused() -> None:
    lines = ["OPENQASM 2.0;\n", 'include "qelib1.inc";\n', "gate g0 a { h a; h a; }\n"]
    for i in range(1, 16):
        lines.append(f"gate g{i} a {{ g{i - 1} a; g{i - 1} a; }}\n")
    lines.append("qreg q[1];\ng15 q[0];\n")
    qasm = "".join(lines)
    guard_qasm(qasm)
    with pytest.raises(ValueError, match="expands to more than"):
        parse_qasm(qasm)


def test_modest_qasm2_gate_definitions_still_parse() -> None:
    qasm = (
        'OPENQASM 2.0;\ninclude "qelib1.inc";\n'
        "gate g0 a { h a; h a; }\ngate g1 a { g0 a; g0 a; }\n"
        "qreg q[1];\ng1 q[0];\n"
    )
    assert parse_qasm(qasm).num_qubits == 1


def test_nested_for_loops_are_refused_quickly() -> None:
    qasm = (
        f"{HEADER}qubit[1] q;\n"
        "for int a in [0:99] { for int b in [0:99] { for int c in [0:99] { h q[0]; } } }\n"
    )
    assert len(qasm) < 200
    guard_qasm(qasm)
    start = time.perf_counter()
    with pytest.raises(ValueError, match="expands to more than"):
        parse_qasm(qasm)
    assert time.perf_counter() - start < 10


def test_small_for_loop_still_parses_and_counts_iterations() -> None:
    from app.quantum.runner import expanded_operation_count

    circuit = parse_qasm(f"{HEADER}qubit[1] q;\nfor int i in [0:9] {{ h q[0]; }}\n")
    assert expanded_operation_count(circuit) == 10


def test_while_loop_counts_as_unbounded() -> None:
    from app.quantum.runner import expanded_operation_count
    from qiskit import QuantumCircuit

    body = QuantumCircuit(1, 1)
    body.h(0)
    circuit = QuantumCircuit(1, 1)
    circuit.while_loop((circuit.clbits[0], True), body, [0], [0])
    assert expanded_operation_count(circuit) > MAX_EXPANDED_OPERATIONS


def test_switch_counts_the_costliest_case() -> None:
    from app.quantum.runner import expanded_operation_count
    from qiskit import QuantumCircuit

    circuit = QuantumCircuit(1, 1)
    with circuit.switch(circuit.cregs[0]) as case:
        with case(0):
            circuit.h(0)
        with case(1):
            for _ in range(7):
                circuit.h(0)
    assert expanded_operation_count(circuit) == 7
