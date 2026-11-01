"""BYOK hardening: public-field shapes and no raw SDK text in caller errors.

Audit finding hardware-byok #49. ``location`` and ``resource_id`` reach the
Azure SDK, which builds an endpoint from them, so a free account storing
``host.example/x?`` there could make this service call a host of its choosing.
The SDK's own exception text was then returned to that caller as a 400.
"""

from __future__ import annotations

import base64
import json
import logging
import sys
import types
from typing import Any

import pytest

from app.quantum import azure
from app.quantum.credentials import (
    AzureCredentials,
    BraketCredentials,
    IbmCredentials,
    InvalidCredentials,
    parse_credentials_header,
)

GUID_A = "11111111-1111-1111-1111-111111111111"
GUID_B = "22222222-2222-2222-2222-222222222222"
RESOURCE_ID = (
    "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg"
    "/providers/Microsoft.Quantum/Workspaces/ws"
)

AZURE = {
    "provider": "azure",
    "resource_id": RESOURCE_ID,
    "location": "eastus",
    "tenant_id": GUID_A,
    "client_id": GUID_B,
    "client_secret": "client-secret-aaaaaaaaaaaaaaaa",
}
BRAKET = {
    "provider": "braket",
    "access_key_id": "AKIAEXAMPLEEXAMPLE00",
    "secret_access_key": "secret-access-key-aaaaaaaaaaaaaaaaaaaa",
    "region": "us-east-1",
    "s3_bucket": "my-braket-results",
}


def _encode(payload: dict[str, Any]) -> str:
    return base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")


def _refused(payload: dict[str, Any], field: str) -> None:
    with pytest.raises(InvalidCredentials) as excinfo:
        parse_credentials_header(_encode(payload))
    assert field in str(excinfo.value)
    # Never echo the offending value back.
    for value in payload.values():
        if isinstance(value, str) and ("?" in value or "@" in value):
            assert value not in str(excinfo.value)


@pytest.mark.parametrize(
    "location", ["internal.host.example/x?", "a@evil.example", "east:443", "x#y", "ea", "eastus.evil"]
)
def test_an_azure_location_that_could_redirect_the_sdk_is_refused(location: str) -> None:
    _refused({**AZURE, "location": location}, "location")


def test_an_azure_location_is_folded_to_lower_case() -> None:
    parsed = parse_credentials_header(_encode({**AZURE, "location": "EastUS"}))
    assert isinstance(parsed, AzureCredentials)
    assert parsed.location == "eastus"


@pytest.mark.parametrize(
    "resource_id",
    [
        "/subscriptions/x",
        "https://evil.example" + RESOURCE_ID,
        RESOURCE_ID + "?x=1",
        RESOURCE_ID + "/../other",
        RESOURCE_ID.replace("Microsoft.Quantum", "Microsoft.Compute"),
    ],
)
def test_a_malformed_azure_resource_id_is_refused(resource_id: str) -> None:
    _refused({**AZURE, "resource_id": resource_id}, "resource_id")


@pytest.mark.parametrize("field", ["tenant_id", "client_id"])
def test_azure_tenant_and_client_ids_must_be_guids(field: str) -> None:
    _refused({**AZURE, field: "contoso/../x"}, field)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("region", "us-east-1/evil"),
        ("region", "nowhere"),
        ("s3_bucket", "Bad_Bucket"),
        ("s3_bucket", "a..b"),
        ("s3_bucket", "bucket/../x"),
        ("s3_prefix", "../../x"),
        ("access_key_id", "akia-lowercase"),
    ],
)
def test_malformed_aws_fields_are_refused(field: str, value: str) -> None:
    _refused({**BRAKET, field: value}, field)


def test_a_well_formed_braket_credential_with_prefix_is_accepted() -> None:
    parsed = parse_credentials_header(
        _encode({**BRAKET, "s3_prefix": "team/run-1.d", "region": "ap-southeast-2"})
    )
    assert isinstance(parsed, BraketCredentials)
    assert parsed.s3_prefix == "team/run-1.d"


def test_an_ibm_instance_with_url_metacharacters_is_refused() -> None:
    payload = {"provider": "ibm", "token": "user-token-aaaaaaaaaaaaaaaa", "instance": "crn:x@evil/?q"}
    _refused(payload, "instance")
    ok = parse_credentials_header(
        _encode({**payload, "instance": "crn:v1:bluemix:public:quantum-computing:us-east:a/0123:abcd::"})
    )
    assert isinstance(ok, IbmCredentials)


# -- Azure errors never carry SDK text ---------------------------------------

SDK_TEXT = "AADSTS7000215 https://login.internal.example/secret-tenant request-id deadbeef"


@pytest.fixture
def failing_sdk(monkeypatch: pytest.MonkeyPatch) -> None:
    """Install a fake Azure SDK whose every call fails with revealing text."""

    class _Workspace:
        def __init__(self, **_: Any) -> None:
            raise RuntimeError(SDK_TEXT)

    class _Cred:
        def __init__(self, **_: Any) -> None:
            pass

    quantum = types.ModuleType("azure.quantum")
    quantum.Workspace = _Workspace  # type: ignore[attr-defined]
    identity = types.ModuleType("azure.identity")
    identity.ClientSecretCredential = _Cred  # type: ignore[attr-defined]
    root = types.ModuleType("azure")
    root.quantum = quantum  # type: ignore[attr-defined]
    root.identity = identity  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "azure", root)
    monkeypatch.setitem(sys.modules, "azure.quantum", quantum)
    monkeypatch.setitem(sys.modules, "azure.identity", identity)


def test_a_failed_byok_connection_returns_a_fixed_message_and_logs_the_cause(
    failing_sdk: None, caplog: pytest.LogCaptureFixture
) -> None:
    creds = parse_credentials_header(_encode(AZURE))
    assert isinstance(creds, AzureCredentials)

    with caplog.at_level(logging.WARNING, logger="app.quantum.azure"):
        with pytest.raises(ValueError) as excinfo:
            azure._workspace(creds)

    message = str(excinfo.value)
    assert "AADSTS" not in message
    assert "internal.example" not in message
    assert "Could not connect to your Azure Quantum workspace" in message
    # The operator still gets the real cause.
    assert any("AADSTS7000215" in r.getMessage() for r in caplog.records)


def test_a_failed_operator_connection_returns_a_fixed_message(
    failing_sdk: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(azure, "azure_resource_id", lambda: RESOURCE_ID)
    monkeypatch.setattr(azure, "azure_location", lambda: "eastus")

    with pytest.raises(ValueError) as excinfo:
        azure._workspace(None)

    assert "AADSTS" not in str(excinfo.value)
    assert "internal.example" not in str(excinfo.value)


def test_poll_and_submit_failures_do_not_echo_sdk_text(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Workspace:
        def get_job(self, _: str) -> Any:
            raise RuntimeError(SDK_TEXT)

        def get_targets(self, **_: Any) -> Any:
            raise RuntimeError(SDK_TEXT)

    monkeypatch.setattr(azure, "_workspace", lambda credentials=None: _Workspace())

    with pytest.raises(ValueError) as polled:
        azure.poll_azure_job("job-1")
    assert "AADSTS" not in str(polled.value)

    with pytest.raises(ValueError) as submitted:
        azure.submit_azure_job(
            "OPENQASM 2.0;\ninclude \"qelib1.inc\";\nqreg q[1];\ncreg c[1];\nh q[0];\nmeasure q[0] -> c[0];\n",
            target="ionq.simulator",
            shots=10,
        )
    assert "AADSTS" not in str(submitted.value)
    assert "rejected the job" in str(submitted.value)
