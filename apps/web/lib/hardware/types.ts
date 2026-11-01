/**
 * types.ts — TypeScript mirrors of the Python API's hardware payloads.
 *
 * Every field name here is copied verbatim from the pydantic models in
 * services/api/app/routers/hardware.py and services/api/app/jobs/models.py.
 * They stay snake_case ON PURPOSE: these objects are the JSON the API sends, and
 * renaming them to camelCase would compile perfectly and then read `undefined`
 * at runtime, which is the one class of bug the compiler cannot catch for us.
 */

/** One row of GET /api/hardware/devices (routers/hardware.py::DeviceInfo). */
export interface HardwareDevice {
  id: string
  name: string
  provider: string
  qubits: number
  technology: string
  note: string
  available: boolean
  /** 'live' when queried from the provider, otherwise 'catalogue'. */
  source: string
  /** Why the device is unavailable; null when it is usable. */
  reason: string | null
  /** Queue depth, when the provider reports one. */
  pending_jobs: number | null
  /**
   * True when this device is available ONLY because the signed-in caller has
   * stored their own credential for its vendor (BYOK). The operator has no
   * credential for it, so the job will run, and be billed, on the caller's own
   * account. Absent otherwise.
   */
  byok?: boolean
}

/** Response of POST /api/hardware/estimate (transpile.py::estimate_cost). */
export interface CostEstimate {
  currency: string
  backend: string
  vendor: string
  shots: number
  num_qubits: number
  per_shot: number
  task_fee: number
  estimated_total: number
  is_free: boolean
  note: string
}

/** Response of POST /api/hardware/analyse (transpile.py::analyse_circuit). */
export interface CircuitAnalysis {
  num_qubits: number
  num_clbits: number
  depth: number
  size: number
  gate_counts: Record<string, number>
  has_measurements: boolean
  two_qubit_gates: number
}

/** Response of POST /api/hardware/transpile (transpile.py::transpile_for). */
export interface TranspileResult {
  backend: string
  vendor: string
  basis_gates: string[]
  requested_basis_gates: string[]
  optimization_level: number
  qasm: string
  num_qubits: number
  depth_before: number
  depth_after: number
  gate_counts_before: Record<string, number>
  gate_counts_after: Record<string, number>
  two_qubit_gates_before: number
  two_qubit_gates_after: number
  notes: string | null
}

/** Response of POST /api/hardware/submit (routers/hardware.py::SubmitResponse). */
export interface SubmittedJob {
  job_id: string
  backend: string
  status: string
  submitted_at: string
  provider: string
  shots: number
  queue_position: number | null
  /**
   * Everything below is reported by some providers and not others, so each is
   * optional AND nullable. A provider that cannot answer omits the field
   * rather than sending 0 — a depth of zero and an unknown depth are different
   * claims, and the UI must be able to tell them apart.
   */
  /** Depth of the circuit as it was actually sent to the device. */
  transpiled_depth?: number | null
  /** Two-qubit gate count in the circuit as sent — the best noise predictor. */
  transpiled_two_qubit_gates?: number | null
  /** The pass-manager level the submission was transpiled at. */
  optimization_level?: number | null
  /** Tags attached at the vendor, for finding the job in their console. */
  tags?: string[] | null
  /** The vendor's own pre-run estimate of QPU seconds, when it gives one. */
  estimated_qpu_seconds?: number | null
  /** Whether idle-time decoupling was applied to this run. */
  dynamical_decoupling?: boolean | null
  /** Whether readout twirling was applied to this run. */
  measurement_twirling?: boolean | null
  /** 'sampler' (a histogram) or 'estimator' (expectation values). */
  primitive?: string | null
  /**
   * The observable labels, echoed back.
   *
   * KEEP THESE. IBM stores the observables but not our names for them, so this
   * array is the only thing that can turn the poll's array of floats back into
   * ⟨Z0⟩, ⟨Z1⟩, ⟨Z0Z1⟩.
   */
  observable_labels?: string[] | null
  /** Estimator mitigation level applied: 0, 1 or 2. */
  resilience_level?: number | null
  /** The runtime session this ran inside, when one was used. */
  session_id?: string | null
  /**
   * How many points this job swept. KEEP IT — polling without it merges every
   * point's shots into one histogram, which looks like a result and is the
   * average of the sweep.
   */
  sweep_points?: number | null
  /** Parameter names in binding order (alphabetical), for labelling a series. */
  sweep_parameters?: string[] | null
  /** Each point's values, in binding order. Estimator submissions only. */
  sweep_point_values?: number[][] | null
  /** shots x points — what the device actually runs. */
  total_shots?: number | null
}

/**
 * One observable's measured value.
 *
 * `value` is nullable and that is load-bearing: an expectation value of 0.0 is
 * a real, common answer — it is what ⟨Z⟩ gives for a perfect superposition —
 * so a number that could not be read has to be distinguishable from it.
 */
export interface ExpectationValue {
  label: string
  value: number | null
  std_error: number | null
  /**
   * Set INSTEAD of `value` for a swept job: one entry per point, in
   * submission order. A null inside the list is a point that could not be
   * read, which is not the same as a zero.
   */
  values?: (number | null)[] | null
  std_errors?: (number | null)[] | null
}

/** An open IBM Runtime session. It bills for as long as it is open. */
export interface RuntimeSession {
  session_id: string
  backend: string
  max_time_seconds: number
  opened_at: string
  provider: string
}

/** The five states the hardware API normalises every vendor status onto. */
export type HardwareJobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

/** Response of GET /api/hardware/job/{provider}/{job_id}. */
export interface JobStatus {
  job_id: string
  provider: string
  /** queued | running | done | error | cancelled */
  status: string
  /** Set only when the job is done. */
  counts: Record<string, number> | null
  /** Set only on error. */
  error: string | null
  /** The device the job actually ran on; can differ from the one requested. */
  backend?: string | null
  /** Vendor-side creation timestamp, ISO 8601. */
  created_at?: string | null
  /** Set only while queued or running, and only when the vendor reports one. */
  queue_position?: number | null
  /** Metered QPU time. Settles only once the job is done. */
  qpu_seconds?: number | null
  /** 'sampler' or 'estimator'. */
  primitive?: string | null
  /** Set instead of `counts` for an estimator job. */
  expectation_values?: ExpectationValue[] | null
  /** Set instead of `counts` for a swept sampler job: one histogram per point. */
  counts_per_point?: Record<string, number>[] | null
  /** How many points the job swept. */
  sweep_points?: number | null
}

/** Lifecycle states of the LOCAL queue at /api/jobs (jobs/models.py::JobStatus). */
export type QueueJobStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'ERROR' | 'CANCELLED'

/** Request body for POST /api/jobs (jobs/models.py::JobRequest). */
export interface QueueJobRequest {
  qasm: string
  backend: string
  shots: number
  noise: number
  user_id: string | null
  label: string | null
}

/**
 * A job from the local async queue (jobs/models.py::Job).
 *
 * `result` is the runner's payload, whose shape depends on the backend, so it is
 * left as an open record of unknown rather than being guessed at here.
 */
export interface QueueJob {
  id: string
  status: QueueJobStatus
  backend: string
  shots: number
  noise: number
  label: string | null
  user_id: string | null
  qasm: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  result: Record<string, unknown> | null
  error: string | null
  progress: number
  queue_position: number | null
  duration_ms: number | null
}

/** A terminal-state check shared by the monitor and the page. */
export function isTerminalStatus(status: string): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled'
}

/**
 * One row of the server-side hardware job history
 * (`GET /api/hardware/jobs`).
 *
 * Distinct from `SubmittedJob` and `JobStatus` on purpose: those two describe
 * a live conversation with a vendor, this one describes what we wrote down.
 * Almost everything is nullable because a row can be in three states —
 * submitted and never polled, polled while still queued, or terminal — and the
 * UI has to be able to tell "this job produced no counts" from "nobody has
 * ever asked this job whether it finished".
 */
export interface HardwareJobHistoryEntry {
  id: string
  provider: string | null
  jobId: string | null
  backend: string
  shots: number
  /** When WE accepted the submission, ISO 8601. */
  submittedAt: string
  /** Null when no poll has ever observed this job. */
  status: string | null
  counts: Record<string, number> | null
  /** Only present when the caller asked for `include_qasm=1`. */
  qasm: string | null
  error: string | null
  qpuSeconds: number | null
  optimizationLevel: number | null
  transpiledDepth: number | null
  transpiledTwoQubitGates: number | null
  completedAt: string | null
}
