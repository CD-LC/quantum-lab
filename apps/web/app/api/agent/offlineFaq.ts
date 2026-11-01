/**
 * Tier 3 of the tutor: the answers that ship with the app and need no API key.
 *
 * This lived inline in route.ts. It was moved out for one reason: nobody had
 * ever checked whether these answers are CORRECT, and the eval harness in
 * services/agent/eval/ needs to call the real matcher rather than a Python
 * re-implementation of it. A re-implementation would be a test that still
 * passes when the feature is deleted. `services/agent/eval/offline_probe.mjs`
 * imports this module directly under `node --experimental-strip-types`, which
 * is why this file must stay free of `next/*` imports, `@/` path aliases and
 * anything else Node cannot resolve on its own.
 *
 * See docs/TUTOR.md for the graded question set and the measured scores.
 */

/**
 * Appended to every offline answer so the learner knows which tier replied.
 * Duplicated deliberately: this module must not import route.ts (that would
 * drag `next/server` into the eval probe), and route.ts re-exports it.
 */
export const OFFLINE_NOTE =
  '\n\n_(The live tutor is busy or unavailable right now; here is an offline answer.)_'

/**
 * Developer-only hint for the "no key configured" case. Production learners
 * must never be told to edit a .env.local file or restart a dev server, so it
 * is emitted only when the app runs under `next dev`. NODE_ENV is read at call
 * time (the eval probe runs this module under bare Node, where it is unset and
 * the user-facing wording applies).
 */
export function devOnlyKeyHint(): string {
  if (process.env.NODE_ENV !== 'development') return ''
  return (
    '\n\n_(Developer note: set ANTHROPIC_API_KEY in apps/web/.env.local and restart the dev server ' +
    'to enable the live tutor.)_'
  )
}

export interface FaqEntry {
  keys: string[]
  answer: string
}

export const FAQ: FaqEntry[] = [
  {
    keys: ['superposition', 'superposed', 'both at once', 'both states'],
    answer:
      "Superposition means a qubit's state is a weighted combination of |0⟩ and |1⟩ at the same time: |ψ⟩ = α|0⟩ + β|1⟩, where α and β are complex numbers with |α|² + |β|² = 1. It is tempting to say the qubit \"is both 0 and 1\", but the sharper statement is that it is in a definite state that simply is not either basis state — much like a compass needle pointing northeast is in a definite direction that is neither north nor east. The complex numbers α and β are amplitudes, not probabilities; you square their magnitudes to get the odds of each measurement result. What makes amplitudes powerful is that they can be negative or complex and therefore cancel, which is the source of quantum interference. A Hadamard gate applied to |0⟩ produces the canonical superposition (|0⟩ + |1⟩)/√2.",
  },
  {
    keys: [
      'entangle',
      'entanglement',
      'entangled',
      'epr',
      'spooky',
      'nonlocal',
      'non-local',
      'faster than light',
      'no-communication',
    ],
    answer:
      'Two qubits are entangled when their joint state cannot be written as a product of two separate single-qubit states. The Bell state (|00⟩ + |11⟩)/√2 is the standard example: neither qubit has a state of its own — each one alone is maximally mixed and looks uniformly random — yet the pair is in a perfectly definite state together. Measure one and you instantly know what to expect of the other, no matter how far apart they are, but nothing observable happens at the far end: the other party\'s own statistics are exactly the same whatever you do, which is the no-communication theorem, so no signal can be sent this way. The correlation only becomes visible once the two sets of results are compared over an ordinary classical channel, which travels no faster than light. What entanglement really gives you is correlations stronger than any classical shared-randomness model can reproduce, which is exactly what Bell inequality experiments have confirmed. In computing terms, entanglement is what lets an n-qubit register hold correlations that would take exponentially many classical numbers to describe.',
  },
  {
    keys: ['qubit', 'qbit', 'quantum bit'],
    answer:
      'A qubit is the quantum analogue of a classical bit: a two-level quantum system whose state is a unit vector in a two-dimensional complex space spanned by |0⟩ and |1⟩. Unlike a bit, which is only ever 0 or 1, a qubit can occupy any normalised combination α|0⟩ + β|1⟩. Physically a qubit can be a superconducting circuit, a trapped ion, a photon polarisation, or a nuclear spin — the mathematics is identical in every case. Because a global phase is unobservable, the state of a single qubit needs only two real parameters and can be drawn as a point on the Bloch sphere. The catch is that you cannot read all of that information out: one measurement gives you a single classical bit and destroys the rest.',
  },
  {
    keys: ['measure', 'measurement', 'collapse', 'observe', 'observation', 'wave function collapse'],
    answer:
      'Measuring a qubit in the computational basis returns 0 with probability |α|² and 1 with probability |β|², and immediately afterwards the qubit is in whichever basis state you found — this is the Born rule plus state update, often called collapse. Measurement is the one step in quantum mechanics that is not unitary and not reversible; everything else is a smooth rotation of the state vector. Crucially, collapse is basis-dependent: measuring along X rather than Z projects onto (|0⟩ ± |1⟩)/√2 instead, so what counts as a "definite" outcome depends on what you chose to measure. Because measurement destroys the superposition, quantum algorithms are designed to concentrate amplitude on the answer before you look. Whether collapse is a physical process or just an update of your description is what the interpretations of quantum mechanics argue about — the predictions are the same either way.',
  },
  {
    keys: ['bell state', 'bell pair', 'bell', 'phi plus', 'bell inequality'],
    answer:
      'A Bell state is one of the four maximally entangled two-qubit states; the most common is |Φ+⟩ = (|00⟩ + |11⟩)/√2. You build it with a Hadamard on the first qubit followed by a CNOT onto the second. Measure both qubits in the computational basis and you see about 50% "00" and 50% "11", and essentially never "01" or "10" — on real hardware those off-pattern counts are your noise floor. It is special for three reasons: each qubit on its own is completely random (its reduced state is the maximally mixed state), the two outcomes are perfectly determined by each other whenever both parties measure along the same axis, and those correlations violate the CHSH inequality, ruling out any local hidden-variable explanation. Be careful with the sign, because it is the detail this state is most often described wrongly: |Φ+⟩ gives ⟨ZZ⟩ = ⟨XX⟩ = +1 but ⟨YY⟩ = −1, so matched Y measurements always DISAGREE. Perfect correlation in every basis at once is not a property any Bell state has — |Φ+⟩ is the +1 eigenstate of XX and ZZ, and those two already force YY = −XX·ZZ. The four Bell states form an orthonormal basis for two qubits, which is what makes them the workhorse of teleportation, superdense coding, and entanglement-based key distribution. Measuring in the Bell basis is how you convert entanglement into usable classical information.',
  },
  {
    keys: ['grover', 'search algorithm', 'unstructured search', 'amplitude amplification'],
    answer:
      "Grover's algorithm searches an unstructured space of N items in about √N steps, versus N/2 on average classically — a quadratic, not exponential, speedup. You start in a uniform superposition over all N candidates, then repeat two operations. First an oracle flips the sign of the amplitude of the marked item; second a \"diffusion\" step reflects every amplitude about the mean. Each round rotates the state a little further towards the marked item in a two-dimensional plane, so the marked amplitude grows steadily. After roughly (π/4)√N iterations the marked state has almost all the probability, and measuring returns the answer with high confidence. Running too many iterations actually overshoots and makes the answer less likely, which is a good reminder that quantum algorithms are rotations, not searches that monotonically improve.",
  },
  {
    keys: ['hadamard', 'h gate'],
    answer:
      'The Hadamard gate is the standard way to create and destroy superposition. It maps |0⟩ to (|0⟩ + |1⟩)/√2 and |1⟩ to (|0⟩ − |1⟩)/√2, so it turns basis states into equal superpositions that differ only in the sign of the |1⟩ term. Its matrix is (1/√2)[[1, 1], [1, −1]], it is both unitary and its own inverse, so applying it twice returns you exactly where you started. Geometrically it is a 180° rotation of the Bloch sphere about the axis halfway between X and Z, which swaps the X and Z axes. That self-inverse property is what makes the H–Z–H sandwich interesting: the phase flip in the middle turns into a bit flip, and the interference between the two paths is visible in the final measurement statistics.',
  },
  {
    keys: ['tunnel', 'tunneling', 'tunnelling', 'barrier penetration'],
    answer:
      "Quantum tunnelling is a particle passing through a potential barrier that classical mechanics says it does not have the energy to cross. It happens because the wavefunction does not stop dead at the barrier — inside it the solution is an exponentially decaying function rather than an oscillating one, so a small but nonzero amplitude survives to the far side. The transmission probability falls off roughly as exp(−2κL), where L is the barrier width and κ grows with the square root of the energy shortfall, which is why tunnelling is dramatic at atomic scales and utterly negligible for anything macroscopic. It is not a loophole in energy conservation and nothing is borrowed: the transmitted particle emerges with exactly the energy it arrived with, never that energy plus something, and the whole calculation runs at one fixed E — that is what \"time-independent\" means. The popular story that the particle briefly borrows ΔE via ΔEΔt ≳ ħ/2, hops the wall and pays it back is the most common misconception about tunnelling, and it is not what the theory says: the particle never goes over the top, so there is nothing to borrow for. The notion of a definite kinetic energy \"inside\" the barrier is not well defined either, because there ψ is a real decaying exponential with no oscillation, hence no local wavelength and no local momentum. Tunnelling powers alpha decay, the scanning tunnelling microscope, flash memory, and proton transfer in enzymes; it also sets a floor on how small transistors can shrink.",
  },
  {
    keys: ['decoher', 'decoherence', 'noise', 'error', 't1', 't2', 'why is it hard'],
    answer:
      'Decoherence is what happens when a quantum system becomes entangled with its environment. No information has to be lost in principle — the total system stays pure — but once the environment holds a record of which branch the qubit is in, the qubit alone is described by a mixed state and its interference terms vanish. Practically, the off-diagonal elements of the density matrix decay, usually on a characteristic timescale T2, while energy relaxation towards the ground state happens on T1. Decoherence is the main reason quantum computers are hard: gates must be fast and accurate compared to these timescales, hence dilution refrigerators, careful shielding, and error correction. It is also the reason the everyday world looks classical — macroscopic objects couple to their surroundings so strongly that superpositions are destroyed almost instantly.',
  },
  {
    keys: ['interference', 'interfere', 'double slit', 'double-slit', 'two slit', 'which path', 'which-path'],
    answer:
      'Interference is the heart of quantum mechanics: when a process can reach the same outcome by more than one indistinguishable path, you add the complex amplitudes for those paths and only then square the magnitude. Because amplitudes carry a phase, they can cancel as well as reinforce, producing outcomes that are less likely than either path alone would suggest — this is what has no classical analogue in probability. In the double-slit experiment, sending particles one at a time still builds up a fringe pattern, because each particle interferes with itself. The moment anything records which slit the particle went through, the paths become distinguishable, you add probabilities instead of amplitudes, and the fringes disappear — with no need to invoke a "disturbance" from the detector. Quantum algorithms are essentially engineered interference: arrange the phases so that wrong answers cancel and right answers add.',
  },
  {
    keys: ['phase', 'relative phase', 'global phase', 'phase kickback'],
    answer:
      'Phase is the angle of a complex amplitude, and it is where a great deal of quantum behaviour hides. A global phase multiplying the whole state — e^{iθ}|ψ⟩ — is physically unobservable and can always be discarded. A relative phase between components, as in (|0⟩ + e^{iφ}|1⟩)/√2, is very observable: it does not change the probabilities in the Z basis at all, but it rotates the state around the equator of the Bloch sphere and completely changes the outcome once you interfere the components with a Hadamard. Gates like S, T, and RZ do nothing but adjust relative phase, which is why a phase flip is invisible until you interfere afterwards. Phase kickback — where a controlled operation pushes an eigenvalue phase onto the control qubit — is the mechanism behind phase estimation, and hence behind Shor and much of quantum simulation.',
  },
  {
    keys: ['bloch sphere', 'bloch', 'sphere representation'],
    answer:
      'The Bloch sphere is a picture of every possible single-qubit state as a point on the surface of a unit ball. Writing the state as cos(θ/2)|0⟩ + e^{iφ} sin(θ/2)|1⟩ gives you the polar angle θ and the azimuthal angle φ directly; |0⟩ sits at the north pole, |1⟩ at the south, and the equator holds the equal superpositions with varying relative phase. Note the factor of two: states that are orthogonal in Hilbert space, like |0⟩ and |1⟩, sit at opposite poles rather than at right angles. Every unitary single-qubit gate is a rigid rotation of this sphere, so X, Y, and Z are half-turns about their respective axes. Mixed states live strictly inside the ball, with the completely mixed state at the centre — and the sphere only works for one qubit, since two entangled qubits have no such individual picture.',
  },
  {
    keys: [
      'quantum computer',
      'vs classical',
      'versus classical',
      'faster than a classical',
      'faster than classical',
      'speedup',
      'why quantum',
      'advantage',
      'supremacy',
    ],
    answer:
      'A quantum computer is not simply a fast classical computer, and it does not "try all answers in parallel" — that framing is the most common misconception. It manipulates amplitudes across 2ⁿ basis states, but every measurement returns just n classical bits, so the whole art is arranging interference so that wrong answers cancel and the right one survives. That works only for problems with the right structure: factoring and discrete logarithms (exponential speedup via Shor), unstructured search (quadratic via Grover), and simulating quantum systems themselves, which is arguably the most important application. For most everyday computing — spreadsheets, databases, rendering — a quantum computer offers no advantage at all. Today\'s machines have hundreds to thousands of noisy physical qubits; useful fault-tolerant computation needs error correction that costs many physical qubits per logical one.',
  },
  {
    keys: ['shor', 'factoring', 'factorization', 'rsa', 'cryptography', 'break encryption'],
    answer:
      "Shor's algorithm factors an n-bit integer in polynomial time, versus the best known classical algorithms which take super-polynomial time — a superpolynomial speedup over the best known classical algorithm. The clever part is that it reduces factoring to a period-finding problem: pick a random a coprime to N, and find the period r of the function f(x) = aˣ mod N, from which the factors follow by classical arithmetic. Only the period finding is quantum, and it works by preparing a superposition over x, then applying the quantum Fourier transform so that amplitudes constructively interfere at multiples of 1/r. Because RSA and elliptic-curve cryptography rest on factoring and discrete logarithms, a large fault-tolerant quantum computer would break them — which is why post-quantum cryptography standards are being deployed now. But that machine is not close, and the resource estimates are worth quoting rather than hand-waving at: 2048-bit RSA needs on the order of a thousand error-corrected LOGICAL qubits and on the order of 10¹⁰ logical gate operations, and at today's roughly 10⁻³ gate error rates the surface code costs hundreds to a thousand PHYSICAL qubits per logical one, plus magic-state factories. The older standard estimate (Gidney and Ekerå, 2019/2021) was around twenty million physical qubits running for about eight hours; the current one (Gidney, 2025, arXiv 2505.15917) is under one million physical qubits — about 1,400 logical — running for under a week at 0.1% gate error. The largest devices announced have around a thousand physical qubits with no full error correction — roughly three orders of magnitude short, not one more hardware generation. The thing that is urgent today is harvest-now-decrypt-later: traffic captured now can be stored until such a machine exists, which is why migration to post-quantum algorithms is happening already.",
  },
  {
    keys: [
      'quantum key distribution',
      'key distribution',
      'qkd',
      'bb84',
      'e91',
      'post-quantum',
      'post quantum',
      'quantum cryptography',
      'eavesdrop',
    ],
    answer:
      'Quantum key distribution and post-quantum cryptography are two different answers to the same threat, and conflating them is the most common mistake in this area. QKD (BB84, or E91 using entangled pairs) sends quantum states down a physical quantum channel: because an unknown non-orthogonal state cannot be copied, any eavesdropper must measure, and measuring disturbs — intercept-and-resend shows up as a ~25% error rate, and below roughly an 11% quantum bit error rate privacy amplification removes whatever Eve learned. Its security rests on physical law rather than on a computational assumption, but it needs special hardware, is distance-limited without quantum repeaters that remain experimental, provides no authentication of the parties (you still need a classical signature scheme for that), protects only the key rather than your endpoints, and has repeatedly been broken through implementation side channels. Post-quantum cryptography is something else entirely: ordinary classical algorithms whose hard problems have no known efficient quantum attack — NIST standardised ML-KEM (from CRYSTALS-Kyber, lattice-based) for key encapsulation and ML-DSA and SLH-DSA for signatures in August 2024. It is software, it runs on the hardware and networks you already have, it covers signatures as well as key exchange, and it is what browsers and CDNs have actually been deploying in TLS since 2023. So: QKD is not post-quantum cryptography, and PQC — not QKD — is the migration happening at internet scale.',
  },
  {
    keys: [
      'logical qubit',
      'physical qubit',
      'error correction',
      'error-correction',
      'surface code',
      'fault tolerance',
      'fault-tolerant',
      'stabilizer',
      'syndrome',
      'qec',
      'threshold theorem',
    ],
    answer:
      'A physical qubit is one noisy device — a transmon, a trapped ion, a spin. A logical qubit is an error-corrected abstraction spread across many physical ones, and treating a headline physical qubit count as a count of usable qubits is how "1,000 qubits" gets misread as "1,000 qubits you can compute with". Error correction cannot work by copying, because no-cloning forbids it; instead the information is encoded in an entangled state where no single qubit holds it, and stabilizer (syndrome) measurements read out parity operators that reveal which error occurred without revealing the encoded amplitudes and therefore without collapsing them. That also digitises errors: an arbitrary small rotation is projected onto "no error" or a specific Pauli, so correcting X, Z and Y covers everything. The surface code needs only nearest-neighbour stabilizers and suppresses the logical error rate exponentially in the code distance d, using about 2d² physical qubits (d² data plus d²−1 measurement qubits) per logical qubit. The threshold theorem says that below a physical error rate of roughly 1% arbitrarily long computation becomes possible — but the budget is brutal: reaching a 10⁻¹⁵ logical error rate from physical qubits at 10⁻³ needs distance 25–30, so roughly 1,000 to 2,000 physical qubits per logical qubit, before the magic-state factories that supply non-Clifford (T) gates.',
  },
  {
    keys: ['no-cloning', 'no cloning', 'cloning', 'clone', 'copy an unknown', 'copy a quantum state', 'copy a qubit'],
    answer:
      'The no-cloning theorem says no quantum operation can copy an arbitrary unknown quantum state, and the proof is two lines of linearity. Suppose a unitary cloner maps |ψ⟩|0⟩ to |ψ⟩|ψ⟩ for two non-orthogonal states |ψ⟩ and |φ⟩. Then linearity fixes what it does to their superposition a|ψ⟩ + b|φ⟩: it must output a|ψ⟩|ψ⟩ + b|φ⟩|φ⟩, but a true copy would be the product (a|ψ⟩ + b|φ⟩)(a|ψ⟩ + b|φ⟩), which expands to include cross terms like ab|ψ⟩|φ⟩ that the linear result does not have. The two answers disagree, so the cloner cannot exist. Orthogonal states are exempt — a CNOT copies |0⟩ and |1⟩ perfectly, which is why classical bits photocopy freely; only unknown superpositions are protected. This is a statement about the structure of the theory, not merely that measurement disturbs. One theorem then shapes the whole field: it rules out protecting qubits by naive repetition, forcing error correction to use entangled encodings read out through syndrome measurements; it is why entanglement cannot be amplified into a faster-than-light signal; and it is the security foundation of quantum key distribution, where an eavesdropper who cannot copy the qubits in flight must measure them, and measuring leaves detectable disturbance.',
  },
  {
    keys: ['vqe', 'variational quantum eigensolver', 'variational', 'nisq', 'noisy hardware', 'ansatz', 'barren plateau'],
    answer:
      "VQE — the variational quantum eigensolver — is a hybrid quantum-classical algorithm for estimating ground-state energies, and it is the workhorse of today's NISQ (noisy intermediate-scale quantum) era. The loop has three parts. A shallow parameterised circuit, the ansatz, prepares a trial state |ψ(θ)⟩ on the quantum device. The device then estimates the expectation value of the problem Hamiltonian by writing H as a sum of Pauli terms, ⟨H⟩ = Σᵢ cᵢ⟨Pᵢ⟩, and sampling each term over many shots. Finally a classical optimiser adjusts θ to push the energy down, and the loop repeats. The physics licence for all this is the variational principle: for any trial state, ⟨ψ(θ)|H|ψ(θ)⟩ is an upper bound on the true ground-state energy, so lower is always better — and hardware noise cannot push the true expectation value below the ground-state energy, though a finite-shot estimate carries statistical error and can dip below it. VQE fits noisy hardware precisely because the quantum circuits are shallow enough to finish inside coherence times, with the heavy iteration pushed to a classical computer. The costs are real, though: the number of Pauli terms to measure grows quickly with system size, so measurement cost can dominate, and barren plateaus — regions where gradients vanish exponentially in the qubit count — can flatten the optimisation landscape. VQE carries no proof of quantum advantage; it is a heuristic, valuable because it runs on the machines that exist now.",
  },
  {
    keys: ['qft', 'quantum fourier', 'fourier transform', 'fourier', 'phase estimation'],
    answer:
      'The quantum Fourier transform is the discrete Fourier transform applied to amplitudes: it maps the basis state |x⟩ to a uniform superposition whose phases wind as e^{2πixy/2ⁿ}. On n qubits it takes only about n²/2 gates — Hadamards and controlled-phase rotations of angle π/2ᵏ, followed by a qubit-order reversal — versus the roughly 2ⁿ·n operations a classical FFT needs on a vector of the same length. But that comparison is a trap, and the honest statement is that the QFT does not by itself give any speedup: the Fourier coefficients end up encoded in amplitudes, and you cannot read amplitudes out — a measurement returns one basis state, not the transformed vector. What the QFT actually buys you is a change of what is measurable. If a state carries a hidden periodicity — as the modular-exponentiation register in Shor\'s algorithm does, with period r — the QFT makes those amplitudes interfere so that the measurement distribution develops sharp peaks at multiples of 2ⁿ/r, converting a global property no single measurement could see into a frequency you can sample directly. Phase estimation is the same trick aimed at an eigenphase, and it is the engine inside Shor\'s factoring and many quantum-chemistry algorithms. One practical note: the controlled rotations get exponentially small with k, and on noisy hardware the tiniest ones are routinely truncated with little loss of accuracy.',
  },
  {
    keys: [
      'qaoa',
      'quantum approximate optimization',
      'quantum approximate optimisation',
      'approximate optimization algorithm',
      'maxcut',
      'max-cut',
      'combinatorial optimization',
      'cost hamiltonian',
      'mixer',
    ],
    answer:
      "QAOA — the quantum approximate optimization algorithm — is the combinatorial-optimization sibling of VQE. You encode the problem (MaxCut is the standard example) as a cost Hamiltonian C whose ground state is the best solution, then apply p alternating layers: a cost layer e^{−iγC} that writes each candidate's cost into its phase, and a mixer layer e^{−iβΣXᵢ} that lets amplitude flow between candidates so those phases can interfere. The 2p angles (γ₁…γₚ, β₁…βₚ) are tuned by a classical optimiser in an outer variational loop, exactly as in VQE, and as p → ∞ the schedule can reproduce an adiabatic sweep, which is the theoretical reason the ansatz is not arbitrary. The honest status report matters more than the mechanism: QAOA does not solve NP-hard problems efficiently — nothing known does, quantum or classical — and at the shallow depths NISQ hardware can run there is no demonstrated quantum advantage on any practical problem. At p = 1 its MaxCut approximation ratio is provably beaten by the classical Goemans–Williamson algorithm's 0.878 guarantee, and low-depth QAOA is fundamentally local: each layer only sees a ball of the graph around each edge, which caps what it can achieve on large instances. It remains genuinely interesting as a NISQ-runnable heuristic whose performance at larger p is an open experimental question — that is the claim, and it is the whole claim.",
  },
  {
    keys: [
      'quantum supremacy',
      'quantum advantage',
      'random circuit sampling',
      'sycamore',
      'boson sampling',
      'cross-entropy',
      'google',
      'willow',
    ],
    answer:
      'The quantum supremacy / quantum advantage experiments are narrower — and more interesting — than the headlines made them. In 2019 Google\'s 53-qubit Sycamore chip performed random circuit sampling: run a random shallow circuit, sample bitstrings from its output distribution, and verify statistically via cross-entropy benchmarking. Google estimated the classical equivalent at 10,000 years; IBM immediately argued days with smarter use of disk, and by 2022 tensor-network methods had reproduced the sampling on classical clusters in hours. That goalpost movement is not scandal, it is the point: "advantage" is a claim about the best known classical algorithm, so it is provisional by construction, and classical algorithms improved precisely because the experiments gave them a target. Two things should be kept separate. First, the task was chosen to be hard classically, not to be useful — random circuit sampling (and the boson-sampling experiments such as USTC\'s Jiuzhang) has no known application; these are benchmarks of hardware control, not useful computation. Second, none of this means quantum computers now beat classical computers at practical problems — no experiment to date has shown a quantum speedup on a problem anyone independently wanted solved. What the experiments really established is that a programmable device with ~50+ qubits can maintain enough coherence to occupy a corner of Hilbert space that classical simulation genuinely struggles to follow. That is a milestone about engineering, and stating it that way is what lets you notice how much is still left to do.',
  },
  {
    keys: [
      'quantum annealing',
      'annealing',
      'annealer',
      'adiabatic',
      'd-wave',
      'dwave',
      'ising',
      'gate-model',
      'gate model',
      'transverse field',
    ],
    answer:
      "Quantum annealing and gate-model quantum computing are different machines for different jobs, and the qubit counts of one cannot be compared to the other. An annealer (D-Wave's machines are the canonical example, with thousands of flux qubits) does one thing: you encode an optimization problem as an Ising cost Hamiltonian whose ground state is the best solution, start the hardware in the easy ground state of a strong transverse field, and ramp slowly from one Hamiltonian to the other. The adiabatic theorem says a slow enough ramp keeps the system in its instantaneous ground state, and quantum tunnelling through barriers in the energy landscape is the hoped-for edge over classical thermal hopping. A gate-model machine instead applies a programmable sequence of unitary gates and is universal. The differences follow directly: an annealer is not universal — it only takes problems in optimization format, and it cannot run Shor's algorithm, Grover, or error-corrected circuits, so an annealer with 5,000 qubits is not '5,000 qubits' in the gate-model sense. Two honest caveats complete the picture. Idealised adiabatic computation with arbitrary Hamiltonians is polynomially equivalent to the gate model in theory, but hardware annealers implement a restricted (stoquastic) class that is not believed to reach that power. And despite two decades of trying, there is no demonstrated scaling advantage of quantum annealing over the best classical heuristics — simulated annealing and parallel tempering remain brutally strong competition — so annealing is a heuristic with interesting physics, not an established speedup.",
  },
  {
    keys: [
      'coherence time',
      't1 vs t2',
      't1',
      't2',
      'relaxation time',
      'dephasing time',
      'energy relaxation',
      'ramsey',
      'hahn echo',
      'amplitude damping',
      't2 star',
    ],
    answer:
      "T1 and T2 are the two clocks that tell you how long a qubit stays quantum, and they time two different kinds of dying. T1 is the energy relaxation time: prepare |1⟩ and wait, and the excited-state population decays toward |0⟩ as e^{−t/T1} because the qubit leaks its quantum of energy into the environment. T2 is the dephasing time: prepare a superposition (|0⟩ + |1⟩)/√2 and the relative phase between the branches randomises on the timescale T2, which shows up as the decay of the off-diagonal elements of the density matrix — the populations can be perfectly intact while the phase, and with it all interference, is gone. The bound T2 ≤ 2·T1 is not a convention but a consequence: losing energy also scrambles the phase, so amplitude damping alone already imposes 1/T2 = 1/(2T1), and any pure dephasing on top (1/T2 = 1/(2T1) + 1/Tφ) can only shorten T2 further — T2 can never be longer than twice T1. The two are measured differently: T1 by exciting and waiting, T2 by a Ramsey experiment (giving T2*, which also absorbs slow drift) or a Hahn echo that refocuses the slow noise to reveal the intrinsic T2. On today's transmons both sit at tens to a few hundred microseconds, which against ~20–100 ns gate times is the entire depth budget of a NISQ circuit — and it is why 'make T1 and T2 longer' is most of what qubit fabrication research is.",
  },
  {
    keys: [
      'parallel universes',
      'many worlds',
      'many-worlds',
      'multiverse',
      '2^n',
      'exponential state space',
      'exponentially many',
    ],
    answer:
      'It takes 2ⁿ complex amplitudes to write down the state of n qubits, and the tempting inference is that 2ⁿ parallel universes are each doing part of your computation. They are not — that is a claim about the cost of DESCRIBING the state classically, not about a workforce. The amplitudes are bookkeeping a classical simulator must carry; nothing in the physics says each term of the superposition is a separate computer running your subroutine. Two hard facts break the picture. First, a measurement returns n classical bits — one sample, not 2ⁿ answers — so whatever the register "held", you cannot collect it. Second, if exponentially many universes really did the work in parallel, unstructured search would be essentially instant; in reality Grover\'s algorithm gives √N, quadratic and provably optimal, which is exactly what you would NOT expect from a multiverse of free labour. The actual mechanism is interference: an algorithm choreographs the phases so amplitudes on wrong answers cancel and amplitude on the right answer adds, and that only works for problems with exploitable structure. Many-worlds, for what it is worth, is a respectable interpretation of quantum mechanics — but it is an interpretation, making the same predictions as every other, and quantum speedups neither require it nor evidence it. David Deutsch famously asked where else the computation could happen; the sober answer is that "where" is doing no work in that question — the state is not a warehouse of parallel results, and the algorithms that succeed do so by cancellation, not by harvest.',
  },
  {
    keys: [
      'superconducting',
      'transmon',
      'trapped ion',
      'ion trap',
      'photonic',
      'neutral atom',
      'hardware platform',
      'made of',
      'physical implementation',
    ],
    answer:
      "A qubit is any well-controlled two-level quantum system, and the leading hardware platforms realise that in physically very different ways while obeying the same mathematics — the identical formalism is what makes the field portable. Superconducting transmons (Google, IBM, Rigetti) are microwave circuits on a chip whose nonlinearity comes from a Josephson junction: gates are fast (tens of nanoseconds) and fabrication leans on semiconductor industry tooling, but coherence times are tens to hundreds of microseconds, the chips live at ~15 millikelvin in a dilution refrigerator, and qubits mostly talk only to nearest neighbours on a 2D grid. Trapped ions (IonQ, Quantinuum) store qubits in electronic or hyperfine levels of individual atoms held by electromagnetic fields: coherence runs to seconds or better, gate fidelities are the best measured, and any ion can interact with any other in a trap — but gates take microseconds to milliseconds, and scaling beyond one trap needs shuttling or photonic interconnects that are still being engineered. Neutral atoms in optical tweezers scale to thousands of sites with reconfigurable geometry; photonic qubits fly at room temperature and are natural for networking but make two-qubit gates probabilistic; silicon spin qubits are tiny and foundry-compatible but young. There is no clear winner, and anyone who tells you the race is settled is selling something: each platform trades gate speed, coherence, connectivity and manufacturability against the others, error correction changes what matters (a slower, higher-fidelity qubit can beat a faster, noisier one), and serious roadmaps exist on at least four platforms. The safe statement is the mathematical one — every platform implements the same qubit — and the open question is engineering, not physics.",
  },
  {
    keys: ['teleport', 'teleportation', 'superdense'],
    answer:
      'Quantum teleportation moves an unknown qubit state from one place to another without moving the qubit itself. Alice and Bob first share a Bell pair; Alice then performs a joint Bell-basis measurement on her half and the unknown qubit, which yields two random classical bits. She sends those two bits to Bob over an ordinary channel, and depending on which of the four results she got, Bob applies I, X, Z, or ZX to his half — recovering the original state exactly. Nothing travels faster than light, because Bob\'s qubit is useless until the classical bits arrive. It also does not violate the no-cloning theorem: Alice\'s copy is destroyed by her measurement, so there is only ever one copy of the state. Teleportation is the routing primitive of quantum networks and of measurement-based quantum computing.',
  },
]

export function offlineReply(lastUserMessage: string): string {
  const text = lastUserMessage.toLowerCase()

  let best: FaqEntry | null = null
  let bestScore = 0
  let bestLongest = 0
  for (const entry of FAQ) {
    // Matched keys, longest first, so a shorter key contained in a longer one
    // ('measure' inside 'measurement') is dropped instead of scoring twice.
    const matched = entry.keys
      .map((key) => key.toLowerCase())
      .filter((key) => text.includes(key))
      .sort((a, b) => b.length - a.length)
    const distinct: string[] = []
    for (const key of matched) {
      if (!distinct.some((kept) => kept.includes(key))) distinct.push(key)
    }

    // A phrase is worth more than a word. Scoring every key as 1 (what this did
    // before the eval harness graded it) made the router lose to whichever
    // topical noun happened to be declared first: "what happens when you
    // MEASURE a QUBIT" tied 1–1 between the measurement entry and the qubit
    // entry and answered with the qubit entry, and "are Bell-state qubits
    // correlated in every MEASUREMENT basis" was answered by the measurement
    // entry. Both are graded by services/agent/eval/offline_probe.mjs.
    const score = distinct.reduce((sum, key) => sum + 2 * key.split(' ').length + 1, 0)
    const longest = distinct.reduce((max, key) => Math.max(max, key.length), 0)
    if (score > bestScore || (score === bestScore && longest > bestLongest)) {
      bestScore = score
      bestLongest = longest
      best = entry
    }
  }

  if (best && bestScore > 0) {
    return best.answer + OFFLINE_NOTE + devOnlyKeyHint()
  }

  return (
    "I don't have an offline answer for that one yet, but I can help with a solid set of core topics right now. Try asking me:\n\n" +
    '- "Explain superposition like I\'m new to this"\n' +
    '- "What makes a Bell state special?"\n' +
    '- "Why does measuring destroy interference?"\n' +
    "- \"Walk me through Grover's algorithm\"\n\n" +
    'I also have offline answers on qubits, measurement, the Hadamard gate, tunnelling, decoherence and the T1/T2 coherence times, phase, the Bloch sphere, Shor\'s algorithm, the quantum Fourier transform, the no-cloning theorem, VQE and NISQ hardware, QAOA, the quantum supremacy/advantage experiments, quantum annealing versus the gate model, why 2ⁿ amplitudes are not parallel universes, the hardware platforms qubits are built from, error correction and logical qubits, quantum key distribution, and teleportation. ' +
    'The live tutor — which can reason about any question and look at your current circuit — is not available at the moment; please try again in a little while.' +
    OFFLINE_NOTE +
    devOnlyKeyHint()
  )
}
