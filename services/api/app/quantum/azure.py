"""Submission and polling for Microsoft Azure Quantum targets.

This mirrors :mod:`app.quantum.hardware` exactly: Azure Quantum is a queued,
shared resource, so it is modelled as **submit then poll**. ``submit_azure_job``
enqueues and returns a job handle immediately; ``poll_azure_job`` looks that
handle up and attaches counts only once the job is done. The record shapes are
identical to the IBM and Braket functions so the existing routers, job store and
TypeScript client need no changes.

The ``azure-quantum`` SDK is imported lazily inside the functions that need it,
and configuration is read from ``AZURE_QUANTUM_RESOURCE_ID`` and
``AZURE_QUANTUM_LOCATION`` (already present in ``.env.example``). A missing SDK
or a missing variable raises :class:`~app.quantum.hardware.MissingDependency`,
which is a :class:`ValueError`, with the exact pip package or variable named.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

from app.core.config import settings
from app.quantum.credentials import AzureCredentials
from app.quantum.hardware import MissingDependency

logger = logging.getLogger(__name__)

# Provider id used by the routes and the job records.
PROVIDER_AZURE = "azure"

_AZURE_PIP = "pip install azure-quantum"

# Static catalogue of Azure Quantum targets, used whenever we cannot ask Azure
# itself. Qubit counts and technologies are the providers' published specs.
AZURE_TARGETS: list[dict[str, Any]] = [
    {
        "id": "quantinuum.qpu.h1-1",
        "name": "Quantinuum H1-1",
        "provider": "quantinuum",
        "qubits": 20,
        "technology": "trapped-ion",
    },
    {
        "id": "quantinuum.sim.h1-1e",
        "name": "Quantinuum H1-1E Emulator",
        "provider": "quantinuum",
        "qubits": 20,
        "technology": "trapped-ion (emulated)",
    },
    {
        "id": "ionq.qpu.aria-1",
        "name": "IonQ Aria-1",
        "provider": "ionq",
        "qubits": 25,
        "technology": "trapped-ion",
    },
    {
        "id": "ionq.simulator",
        "name": "IonQ Simulator",
        "provider": "ionq",
        "qubits": 29,
        "technology": "trapped-ion (simulated)",
    },
]


def _now() -> str:
    """Return the current UTC time as an ISO 8601 string.

    Returns:
        A timezone-aware timestamp, e.g. ``"2026-08-16T09:30:00+00:00"``.
    """
    return datetime.now(timezone.utc).isoformat()


def _log_sdk_failure(action: str, exc: BaseException) -> None:
    """Record the real SDK failure server-side; callers get a fixed message.

    The text of an ``azure-quantum`` / ``azure-identity`` exception is not ours
    to forward: it can carry the workspace endpoint it tried, a tenant id, a
    request id or a response body, and for a BYOK request the endpoint is built
    from values the *user* supplied. Echoing it would turn a bad credential
    into a probe that reflects whatever the SDK saw. The operator reads the
    real cause here; the caller reads a message that never varies.

    Args:
        action: What was being attempted, e.g. ``"connect to the workspace"``.
        exc: The exception the SDK raised.
    """
    logger.warning("Azure Quantum: could not %s (%s: %s)", action, type(exc).__name__, exc)


def _module_importable(name: str) -> bool:
    """Report whether a module can be located without importing it.

    Args:
        name: A module name, possibly dotted, e.g. ``"azure.quantum"``.

    Returns:
        True when the module is installed.
    """
    import importlib.util

    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError, ModuleNotFoundError, AttributeError):
        return False


def _setting(name: str) -> str:
    """Read an Azure configuration value from settings or the environment.

    ``Settings`` ignores unknown keys, so the canonical source for these two is
    the environment; settings is checked first in case a deployment adds them.

    Args:
        name: The lower-case field name, e.g. ``"azure_quantum_location"``.

    Returns:
        The configured value, or an empty string when unset.
    """
    value = getattr(settings, name, None)
    if not value:
        value = os.environ.get(name.upper(), "")
    return str(value or "").strip()


def azure_resource_id() -> str:
    """Return the configured Azure Quantum workspace resource id.

    Returns:
        The value of ``AZURE_QUANTUM_RESOURCE_ID``, or an empty string.
    """
    return _setting("azure_quantum_resource_id")


def azure_location() -> str:
    """Return the configured Azure Quantum workspace region.

    Returns:
        The value of ``AZURE_QUANTUM_LOCATION``, or an empty string.
    """
    return _setting("azure_quantum_location")


def azure_available() -> tuple[bool, str]:
    """Check whether Azure Quantum could accept a job right now.

    Three things are checked without any network call: the ``azure-quantum``
    SDK must be importable, and both ``AZURE_QUANTUM_RESOURCE_ID`` and
    ``AZURE_QUANTUM_LOCATION`` must be set.

    Returns:
        ``(available, reason)``. ``reason`` names exactly what is missing when
        unavailable, and is a short confirmation when available.
    """
    missing: list[str] = []
    if not _module_importable("azure.quantum"):
        missing.append(f"the azure-quantum SDK ({_AZURE_PIP})")
    if not azure_resource_id():
        missing.append("an Azure Quantum workspace id (set AZURE_QUANTUM_RESOURCE_ID)")
    if not azure_location():
        missing.append("a workspace region (set AZURE_QUANTUM_LOCATION)")

    if missing:
        return False, f"Azure Quantum needs {' and '.join(missing)}."
    return (
        True,
        "azure-quantum is installed and AZURE_QUANTUM_RESOURCE_ID / "
        "AZURE_QUANTUM_LOCATION are set.",
    )


def _require_azure(credentials: AzureCredentials | None = None) -> Any:
    """Import the Azure Quantum SDK and verify the workspace configuration.

    Args:
        credentials: A credential presented on THIS request (BYOK). When given
            it carries its own workspace id and region, so the operator's
            environment is not consulted at all — a user who supplied their own
            workspace must not silently fall through to ours.

    Returns:
        The ``azure.quantum.Workspace`` class.

    Raises:
        MissingDependency: When the SDK or either environment variable is missing.
    """
    try:
        from azure.quantum import Workspace
    except ImportError as exc:
        raise MissingDependency(
            "Submitting to Azure Quantum requires the azure-quantum SDK, which is not "
            f"installed. Install it with '{_AZURE_PIP}'. (import error: {exc})",
            remedy=_AZURE_PIP,
        ) from exc

    if credentials is not None:
        # Validated at the edge (app/quantum/credentials.py). Nothing from the
        # operator's environment is read on this path.
        return Workspace

    if not azure_resource_id():
        raise MissingDependency(
            "Submitting to Azure Quantum requires a workspace resource id. Copy it "
            "from the Azure portal and set AZURE_QUANTUM_RESOURCE_ID in the "
            "environment or in services/api/.env.",
            remedy="set AZURE_QUANTUM_RESOURCE_ID",
        )
    if not azure_location():
        raise MissingDependency(
            "Submitting to Azure Quantum requires the workspace region. Set "
            "AZURE_QUANTUM_LOCATION (for example 'eastus').",
            remedy="set AZURE_QUANTUM_LOCATION",
        )

    return Workspace


def _workspace(credentials: AzureCredentials | None = None) -> Any:
    """Build an authenticated Azure Quantum workspace client.

    WHY BYOK ON AZURE NEEDS A SERVICE PRINCIPAL
    -------------------------------------------

    The operator path passes no credential, so the SDK falls back to
    ``DefaultAzureCredential``: it discovers an identity from the process
    environment, a managed identity, or a developer's signed-in CLI session.
    Every one of those is a property of the MACHINE, not of the request — there
    is no way to say "this user, this call" through any of them.

    So a user bringing their own Azure workspace registers an app in their own
    tenant and hands over a service principal: tenant id, client id, client
    secret. That is genuinely more work than IBM's two-minute token, and the
    account panel says so rather than presenting the two as equivalent.

    The ``ClientSecretCredential`` is constructed per call and passed
    EXPLICITLY. Nothing is written to the environment — see the invariant at
    the top of app/quantum/credentials.py for why that would be the worst
    available implementation.

    Args:
        credentials: The submitter's OWN Azure credential (BYOK), when they
            supplied one.

    Returns:
        A connected ``Workspace`` instance.

    Raises:
        MissingDependency: When the SDK or configuration is missing.
        ValueError: When the workspace cannot be constructed or reached.
    """
    workspace_cls = _require_azure(credentials)

    if credentials is not None:
        try:
            from azure.identity import ClientSecretCredential
        except ImportError as exc:
            raise MissingDependency(
                "Submitting to Azure Quantum with your own workspace requires the "
                "azure-identity package, which is not installed. Install it with "
                f"'pip install azure-identity'. (import error: {exc})",
                remedy="pip install azure-identity",
            ) from exc

        try:
            token_credential = ClientSecretCredential(
                tenant_id=credentials.tenant_id,
                client_id=credentials.client_id,
                client_secret=credentials.client_secret,
            )
            return workspace_cls(
                resource_id=credentials.resource_id,
                location=credentials.location,
                credential=token_credential,
            )
        except Exception as exc:  # noqa: BLE001 - auth/network errors become 400s
            _log_sdk_failure("connect to a user-supplied workspace", exc)
            raise ValueError(
                "Could not connect to your Azure Quantum workspace. Check the "
                "workspace resource id, region, tenant id and client id, that the "
                "client secret has not expired, and that the service principal has "
                "access to the workspace."
            ) from exc

    try:
        return workspace_cls(resource_id=azure_resource_id(), location=azure_location())
    except Exception as exc:  # noqa: BLE001 - auth/network errors become 400s
        _log_sdk_failure("connect to the operator workspace", exc)
        raise ValueError("Could not connect to the Azure Quantum workspace.") from exc


def _validate_shots(shots: int) -> int:
    """Check a shot count against the configured maximum.

    Args:
        shots: Requested repetitions.

    Returns:
        The validated shot count.

    Raises:
        ValueError: When the value is out of range or not an integer.
    """
    if not isinstance(shots, int) or isinstance(shots, bool):
        raise ValueError(f"shots must be an integer, got {shots!r}.")
    if shots < 1 or shots > settings.max_shots:
        raise ValueError(f"shots must be between 1 and {settings.max_shots}, got {shots}.")
    return shots


def _normalise_azure_status(raw: str) -> str:
    """Map an Azure Quantum job status onto the API's status vocabulary.

    Args:
        raw: An Azure status such as ``"Waiting"`` or ``"Succeeded"``.

    Returns:
        One of ``queued``, ``running``, ``done``, ``error``, ``cancelled``.
    """
    value = raw.strip().upper()
    if value in ("SUCCEEDED", "COMPLETED", "DONE"):
        return "done"
    if value in ("EXECUTING", "RUNNING", "FINISHING"):
        return "running"
    if value in ("CANCELLED", "CANCELED", "CANCELLING"):
        return "cancelled"
    if value in ("FAILED", "ERROR"):
        return "error"
    return "queued"


def _safe_status(job: Any) -> str:
    """Read a job's status without letting SDK errors escape.

    Args:
        job: An Azure Quantum job handle.

    Returns:
        The raw status string, or ``"unknown"`` when it cannot be read.
    """
    try:
        details = getattr(job, "details", None)
        status = getattr(details, "status", None) if details is not None else None
        if status is None:
            status = getattr(job, "status", "unknown")
        if callable(status):
            status = status()
    except Exception:  # noqa: BLE001
        return "unknown"
    return str(getattr(status, "value", status))


def _catalogue_entry(target: dict[str, Any], reason: str) -> dict[str, Any]:
    """Build an unavailable catalogue row for a known Azure target.

    Args:
        target: An entry from :data:`AZURE_TARGETS`.
        reason: Why the target cannot be used right now.

    Returns:
        A target dictionary with ``source='catalogue'`` and ``available=False``.
    """
    entry = dict(target)
    entry.update({"available": False, "source": "catalogue", "reason": reason})
    return entry


def _live_azure_targets() -> list[dict[str, Any]]:
    """Query the configured workspace for the targets it can actually run.

    Returns:
        Live target rows with ``source='live'``.

    Raises:
        Exception: Any SDK or network error, handled by the caller.
    """
    known = {target["id"]: target for target in AZURE_TARGETS}
    workspace = _workspace()

    rows: list[dict[str, Any]] = []
    for target in workspace.get_targets():
        target_id = str(getattr(target, "name", "") or "")
        if not target_id:
            continue
        catalogued = known.get(target_id, {})
        status = str(getattr(target, "current_availability", "") or "").lower()
        available = status in ("", "available")
        rows.append(
            {
                "id": target_id,
                "name": str(catalogued.get("name", target_id)),
                "provider": str(
                    getattr(target, "provider_id", "") or catalogued.get("provider", "unknown")
                ),
                "qubits": int(catalogued.get("qubits", 0)),
                "technology": str(catalogued.get("technology", "unknown")),
                "available": available,
                "reason": None if available else f"Azure reports availability '{status}'.",
                "source": "live",
            }
        )
    return rows


def list_azure_targets() -> list[dict[str, Any]]:
    """List every Azure Quantum target, live when possible and catalogued otherwise.

    Every row carries ``id``, ``name``, ``provider``, ``qubits``,
    ``technology``, ``available``, ``reason`` and ``source`` (``'live'`` or
    ``'catalogue'``) so a caller can always tell whether it is looking at
    reality or at the shipped specification sheet.

    Returns:
        The target list; never raises, since an unreachable workspace simply
        degrades to the catalogue.
    """
    ok, reason = azure_available()
    if not ok:
        return [_catalogue_entry(target, reason) for target in AZURE_TARGETS]

    try:
        live = _live_azure_targets()
    except Exception as exc:  # noqa: BLE001
        _log_sdk_failure("list live targets", exc)
        return [
            _catalogue_entry(target, "Could not reach Azure Quantum.")
            for target in AZURE_TARGETS
        ]

    if not live:
        return [
            _catalogue_entry(target, "The workspace reported no runnable targets.")
            for target in AZURE_TARGETS
        ]
    return live


def submit_azure_job(
    qasm: str,
    target: str,
    shots: int = 1024,
    credentials: AzureCredentials | None = None,
) -> dict[str, Any]:
    """Enqueue a circuit on an Azure Quantum target and return immediately.

    Args:
        qasm: OpenQASM 3 (or 2) circuit source.
        target: An Azure target id, e.g. ``"quantinuum.qpu.h1-1"``.
        shots: Number of repetitions.
        credentials: The submitter's OWN Azure workspace credential (BYOK),
            when they supplied one. The job is then queued in THEIR workspace
            and billed to them — which for Quantinuum means their own H-System
            Credits, a currency this platform cannot price in dollars at all.

    Returns:
        ``{job_id, backend, status, submitted_at, provider, shots,
        queue_position}``; ``queue_position`` is None because Azure does not
        report one.

    Raises:
        MissingDependency: When azure-quantum, AZURE_QUANTUM_RESOURCE_ID or
            AZURE_QUANTUM_LOCATION is missing. It subclasses ValueError.
        ValueError: On bad shots, an unknown target, unparseable QASM, or a
            submission failure.
    """
    _validate_shots(shots)
    workspace = _workspace(credentials)

    if not target:
        valid = ", ".join(t["id"] for t in AZURE_TARGETS)
        raise ValueError(f"An Azure target id is required. Known targets are: {valid}.")

    # Azure's OpenQASM ingestion wants QASM 2 for the pass-through targets, so
    # the circuit is round-tripped through the shared parser and serialiser.
    from app.quantum.runner import _ensure_measured, _to_qasm2, parse_qasm

    circuit = _ensure_measured(parse_qasm(qasm))
    source = _to_qasm2(circuit)

    try:
        azure_target = workspace.get_targets(name=target)
        if azure_target is None:
            raise ValueError(f"Azure Quantum has no target named '{target}'.")
        # Fire and forget on purpose: Azure jobs are queued and can take
        # minutes to hours, so we never wait for results here — the caller
        # polls poll_azure_job() with the returned id.
        job = azure_target.submit(source, shots=shots)
    except MissingDependency:
        raise
    except ValueError:
        raise
    except Exception as exc:  # noqa: BLE001
        _log_sdk_failure(f"submit a job to '{target}'", exc)
        raise ValueError(
            f"Azure Quantum rejected the job on '{target}'. Check that the target is "
            "enabled in your workspace and that the circuit is supported by it."
        ) from exc

    return {
        "job_id": str(getattr(job, "id", "")),
        "backend": target,
        "status": _normalise_azure_status(_safe_status(job)),
        "submitted_at": _now(),
        "provider": PROVIDER_AZURE,
        "shots": shots,
        "queue_position": None,
    }


def _counts_from_azure_result(result: Any) -> dict[str, int]:
    """Extract bitstring counts from an Azure Quantum job result.

    Providers return either a histogram of counts or normalised probabilities;
    both shapes are handled and normalised to integer counts keyed by
    contiguous bitstrings.

    Args:
        result: The object returned by ``job.get_results()``.

    Returns:
        Counts keyed by bitstring; empty when the shape is unrecognised.
    """
    if not isinstance(result, dict):
        return {}

    histogram = result.get("histogram") or result.get("counts")
    if isinstance(histogram, dict):
        counts: dict[str, int] = {}
        for key, value in histogram.items():
            label = str(key).replace(" ", "").replace("[", "").replace("]", "").replace(",", "")
            counts[label] = counts.get(label, 0) + int(round(float(value)))
        return counts

    # Quantinuum-style output: a list of per-shot bitstrings under "c" or "m".
    for field in ("c", "m", "meas"):
        shots = result.get(field)
        if isinstance(shots, list) and shots:
            counts = {}
            for entry in shots:
                label = "".join(str(bit) for bit in entry) if isinstance(entry, list) else str(entry)
                counts[label] = counts.get(label, 0) + 1
            return counts

    return {}


def poll_azure_job(
    job_id: str, credentials: AzureCredentials | None = None
) -> dict[str, Any]:
    """Look up the current state of an Azure Quantum job.

    Args:
        job_id: The id returned by :func:`submit_azure_job`.
        credentials: The credential the job was SUBMITTED with, when that was
            the user's own. A job in one workspace is not visible from another,
            so polling with the wrong one reads as "could not retrieve".

    Returns:
        ``{job_id, provider, status}`` plus ``counts`` when done and ``error``
        when the job failed.

    Raises:
        MissingDependency: When azure-quantum or the workspace configuration is
            missing. It subclasses ValueError.
        ValueError: When the job cannot be retrieved.
    """
    workspace = _workspace(credentials)

    try:
        job = workspace.get_job(job_id)
    except Exception as exc:  # noqa: BLE001
        _log_sdk_failure(f"retrieve job {job_id!r}", exc)
        raise ValueError(f"Could not retrieve Azure Quantum job '{job_id}'.") from exc

    status = _normalise_azure_status(_safe_status(job))
    payload: dict[str, Any] = {"job_id": job_id, "provider": PROVIDER_AZURE, "status": status}

    if status == "done":
        try:
            payload["counts"] = _counts_from_azure_result(job.get_results())
        except Exception as exc:  # noqa: BLE001
            payload["status"] = "error"
            _log_sdk_failure(f"read the result of job {job_id!r}", exc)
            payload["error"] = "The job finished but its result could not be read."
    elif status == "error":
        details = getattr(job, "details", None)
        payload["error"] = str(
            getattr(details, "error_data", None) or "Azure Quantum reported the job as failed."
        )

    return payload
