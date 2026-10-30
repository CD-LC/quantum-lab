"""/api/health is exempt from the shared secret, so it must be cheap to hammer."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import health as health_module


@pytest.fixture(autouse=True)
def _fresh_cache() -> None:
    health_module._reset_cache()
    yield
    health_module._reset_cache()


def test_repeated_calls_run_the_simulator_probe_once(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"n": 0}
    real = health_module._probe_simulator

    def counted() -> dict:
        calls["n"] += 1
        return real()

    monkeypatch.setattr(health_module, "_probe_simulator", counted)
    client = TestClient(app)
    first = client.get("/api/health")
    for _ in range(25):
        assert client.get("/api/health").json() == first.json()
    assert first.status_code == 200
    assert calls["n"] == 1
    assert "no-store" in first.headers["cache-control"]


def test_cache_expires(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"n": 0}
    real = health_module._probe_simulator

    def counted() -> dict:
        calls["n"] += 1
        return real()

    monkeypatch.setattr(health_module, "_probe_simulator", counted)
    clock = {"t": 1000.0}
    monkeypatch.setattr(health_module.time, "monotonic", lambda: clock["t"])
    client = TestClient(app)
    client.get("/api/health")
    clock["t"] += health_module.HEALTH_CACHE_SECONDS + 1
    client.get("/api/health")
    assert calls["n"] == 2


def test_a_failing_report_keeps_its_503_and_is_cached_only_briefly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        health_module,
        "_probe_simulator",
        lambda: health_module._probe("failing", "down", checked=True),
    )
    clock = {"t": 50.0}
    monkeypatch.setattr(health_module.time, "monotonic", lambda: clock["t"])
    client = TestClient(app)
    assert client.get("/api/health").status_code == 503
    assert client.get("/api/health").status_code == 503

    # Recovery is visible within the short failing window.
    monkeypatch.setattr(
        health_module, "_probe_simulator", lambda: health_module._probe("ok", "up", checked=True)
    )
    clock["t"] += health_module.HEALTH_FAILING_CACHE_SECONDS + 0.1
    assert client.get("/api/health").status_code == 200


def test_anonymous_callers_get_a_trimmed_report(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.core.config import settings

    monkeypatch.setattr(settings, "api_shared_secret", "s3cret")
    client = TestClient(app)

    anon = client.get("/api/health")
    assert anon.status_code == 200  # the liveness contract is unchanged
    body = anon.json()
    assert body["status"] in {"ok", "degraded"}
    assert "version" in body
    assert "qiskit_version" not in body
    assert "backends_available" not in body
    for check in body["checks"].values():
        assert "detail" not in check
        assert "status" in check

    wrong = client.get("/api/health", headers={"X-Quantum-Lab-Secret": "nope"}).json()
    assert "qiskit_version" not in wrong

    full = client.get("/api/health", headers={"X-Quantum-Lab-Secret": "s3cret"}).json()
    assert "qiskit_version" in full
    assert "backends_available" in full
    assert all("detail" in c for c in full["checks"].values())


def test_trimmed_report_keeps_the_503_when_failing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        health_module,
        "_probe_simulator",
        lambda: health_module._probe("failing", "down", checked=True),
    )
    res = TestClient(app).get("/api/health")
    assert res.status_code == 503
    assert res.json()["status"] == "failing"
