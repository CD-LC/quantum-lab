"""Measured resource bounds on local simulation.

WHY THIS IS A MODULE AND NOT TWO CONSTANTS IN ``runner.py``
-----------------------------------------------------------
Three places need these numbers and they cannot all import each other:
``runner`` enforces them, ``backends`` advertises them to the device picker,
and ``pennylane_runner`` uses them to decide when to hand a circuit back to
Qiskit. ``backends`` importing ``runner`` is a cycle. So the numbers live at
the bottom of the dependency graph, importing nothing from this package.

WHAT THE NUMBERS ARE, AND WHERE THEY CAME FROM
----------------------------------------------
The audit finding PY-1 was a qubit cap that ran after parsing, so
``qreg q[3000000]`` allocated 669 MB before anyone checked. That was fixed. It
left a second hole: the cap was ONE number, 24, applied to every backend, and
simulation cost is not one curve.

Measured on the development container (8 cores, 1024 shots, a circuit of one H
and one T per qubit followed by a CX ladder, wall clock for the whole call):

    method                                    n=10    n=12    n=16    n=20    n=22    n=24    n=26
    ---------------------------------------------------------------------------------------------
    ideal, Aer statevector                       -       -       -   0.58s   1.14s   4.49s  18.9s
    ideal, PennyLane lightning.qubit             -       -       -   0.25s   1.74s   7.43s  33.7s
    NOISY, Aer trajectories                  0.63s   0.83s  13.7s       -       -       -      -
    NOISY, PennyLane default.mixed           4.67s  87.4s        -       -       -       -      -

    peak RSS, ideal path: 275 MB at n=20, 1.0 GB at n=24, 3.3 GB at n=26.

Two facts fall out of that table:

1. The ideal path costs 2^n and is affordable to 24 on this hardware. The noisy
   path costs shots x 2^n, because every shot is an independently sampled
   trajectory, so 24 is not a bound there at all. A ~50-byte request naming
   ``aer_noisy`` and 16 qubits occupies a worker for a quarter of a minute; at
   20 it is minutes. ``/api/circuits/run`` is synchronous, and on its own port
   unauthenticated (app/core/security.py), so that is a denial of service of
   exactly the shape PY-1 closed, reached by a different axis.
2. PennyLane's ``default.mixed`` stores a full density matrix — 16 * 4^n bytes,
   4 GB at n=14 — and is ~100x slower than Aer at the same width. That row is
   kept in the table as the reason the density-matrix device is no longer used
   at all: noisy circuits now go to Aer unconditionally (see the noise block in
   ``pennylane_runner.run_with_pennylane``), so the 4^n curve is gone rather
   than merely capped.

RE-MEASURE BEFORE CHANGING EITHER NUMBER. They are not round numbers picked for
comfort; a bigger box justifies bigger values and this table is how you show it.
"""

from __future__ import annotations

#: Widest circuit the noisy simulator will accept, on any engine. 12 qubits is
#: 0.83 s at 1024 shots; 16 is 13.7 s. Enforced by
#: :func:`app.quantum.runner.assert_width_is_affordable` and advertised by
#: :func:`app.quantum.backends.list_backends`.
MAX_NOISY_QUBITS = 12

#: Widest circuit exact statevector analysis will accept. 2^12 amplitudes is
#: 4096 complex numbers, which is already more than any UI in this product
#: renders; the response is JSON, so the wire cost is the binding constraint
#: long before the simulation is.
MAX_STATEVECTOR_QUBITS = 12


#: Hard ceiling on a PARSED circuit's width, independent of any per-backend cap.
#: ``guard_qasm`` bounds the declared width before parsing; this is the second
#: line of defence for a register size the source-text guard could not evaluate.
#: Real devices top out near 160 qubits, so 1024 never refuses a real circuit.
MAX_PARSED_QUBITS = 1024

#: Hard ceiling on the number of primitive operations a parsed circuit expands
#: to once nested ``gate`` definitions are unrolled. OpenQASM 3 gate definitions
#: may call one another, so 15 doubling definitions in ~660 bytes expand to
#: 2^17 operations (measured: 133 s in ``transpile``). A flat 128 KiB source
#: holds at most ~26k of the shortest statements, and the noise suite's
#: 11,499-gate chain with a barrier after each gate is ~23k operations, so
#: 40,000 never refuses honest input while still sitting well below the tower.
MAX_EXPANDED_OPERATIONS = 40_000
