"""Offline tests for BYOK: presenting a USER'S OWN vendor credential.

Nothing here reaches a network. The assertions are on the things that are
invisible until a real job has been billed to the wrong account:

* that a presented token is the one the SDK is built with,
* that it is NEVER written into the process-global ``settings``,
* that the service cache cannot hand one user's authenticated service to
  another user's request,
* and that a request which cannot honour the credential is REFUSED rather than
  quietly run on the operator's account.

That last one is the whole point. Every failure mode this feature has looks
like success: the job runs, the histogram comes back, and the only trace that
it was billed to the wrong IBM account is in somebody else's console.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.core.config import settings
from app.quantum import hardware
from app.quantum.credentials import (
    CREDENTIALS_HEADER,
    AzureCredentials,
    BraketCredentials,
    IbmCredentials,
    InvalidCredentials,
    parse_credentials_header,
)

BELL_QASM = """OPENQASM 3.0;
include "stdgates.inc";
qubit[2] q;
bit[2] c;
h q[0];
cx q[0], q[1];
c = measure q;
"""

#: A token-shaped string. Long enough to clear the minimum, obviously fake.
USER_TOKEN = "user-token-aaaaaaaaaaaaaaaa"
OTHER_TOKEN = "user-token-bbbbbbbbbbbbbbbb"

#: A complete Braket credential payload, as apps/web would send it.
BRAKET_PAYLOAD = {
    "provider": "braket",
    "access_key_id": "AKIAEXAMPLEEXAMPLE00",
    "secret_access_key": "secret-access-key-aaaaaaaaaaaaaaaaaaaa",
    "region": "us-east-1",
    "s3_bucket": "my-braket-results",
}

#: A complete Azure service-principal payload.
AZURE_PAYLOAD = {
    "provider": "azure",
    "resource_id": (
        "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg"
        "/providers/Microsoft.Quantum/Workspaces/ws"
    ),
    "location": "eastus",
    "tenant_id": "11111111-1111-1111-1111-111111111111",
    "client_id": "22222222-2222-2222-2222-222222222222",
    "client_secret": "client-secret-aaaaaaaaaaaaaaaa",
}


def _encode(payload: dict[str, Any]) -> str:
    """Encode a credential payload the way apps/web's proxy does.

    Deliberately re-implemented here from the wire format rather than imported
    from the parser, so this test would fail if the two halves of the contract
    drifted apart.

    Args:
        payload: The JSON object to carry.

    Returns:
        The base64 header value.
    """
    import base64
    import json

    return base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")


class _FakeService:
    """Stands in for ``QiskitRuntimeService`` and records how it was built."""

    constructions: list[dict[str, Any]] = []

    def __init__(self, **kwargs: Any) -> None:
        """Record the construction kwargs.

        Args:
            **kwargs: Whatever the module passed.
        """
        _FakeService.constructions.append(kwargs)


@pytest.fixture(autouse=True)
def _fake_ibm(monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the module at a fake service and give it an operator token.

    Args:
        monkeypatch: pytest's attribute patcher.
    """
    _FakeService.constructions = []
    hardware._IBM_SERVICE_CACHE.clear()
    monkeypatch.setattr(settings, "ibm_quantum_token", "operator-token", raising=False)
    monkeypatch.setattr(settings, "ibm_quantum_instance", None, raising=False)
    monkeypatch.setattr(settings, "ibm_quantum_region", None, raising=False)
    monkeypatch.setattr(settings, "ibm_quantum_channel", "ibm_quantum_platform", raising=False)
    monkeypatch.setattr(hardware, "_require_ibm", lambda credentials=None: (_FakeService, None))


# ── The header contract ─────────────────────────────────────────────────────


def test_an_absent_header_means_the_operators_credentials() -> None:
    """No header is not an error: it is the path every request took before."""
    assert parse_credentials_header(None) is None
    assert parse_credentials_header("") is None
    assert parse_credentials_header("   ") is None


def test_a_valid_header_round_trips() -> None:
    """The fields apps/web sends are the fields that come out."""
    parsed = parse_credentials_header(
        _encode({"provider": "ibm", "token": USER_TOKEN, "instance": "crn:v1:bluemix:x"})
    )

    assert parsed == IbmCredentials(token=USER_TOKEN, instance="crn:v1:bluemix:x")


def test_a_null_instance_is_carried_as_none() -> None:
    """Most accounts have one instance and send null. It must not become "None"."""
    parsed = parse_credentials_header(
        _encode({"provider": "ibm", "token": USER_TOKEN, "instance": None})
    )
    assert parsed is not None
    assert parsed.instance is None


@pytest.mark.parametrize(
    "value",
    [
        "not base64 at all !!",
        _encode({"provider": "ibm"}),  # no token
        _encode({"provider": "nope", "token": USER_TOKEN}),  # unknown provider
        _encode({"provider": "braket", "access_key_id": "AKIA"}),  # incomplete braket
        _encode({"provider": "ibm", "token": "short"}),  # under the minimum
        _encode({"provider": "ibm", "token": 42}),  # not a string
        _encode(["ibm", USER_TOKEN]),  # not an object
    ],
)
def test_a_malformed_header_is_refused_not_ignored(value: str) -> None:
    """A credential we cannot read must never degrade to "use the operator's".

    Ignoring it would run the job on the platform's account while the submitter
    believed they were paying for it themselves. That is a silent, billable
    wrong answer, so every unusable header raises.

    Args:
        value: A header value that should be rejected.
    """
    with pytest.raises(InvalidCredentials):
        parse_credentials_header(value)


def test_an_oversized_header_is_refused_before_it_is_decoded() -> None:
    """The bound exists so a caller cannot make this service decode a megabyte."""
    with pytest.raises(InvalidCredentials) as excinfo:
        parse_credentials_header("A" * 100_000)

    assert CREDENTIALS_HEADER in str(excinfo.value)


def test_the_repr_does_not_carry_the_token() -> None:
    """A dataclass's default repr would put a live credential in every traceback."""
    text = repr(IbmCredentials(token=USER_TOKEN, instance="crn:x"))

    assert USER_TOKEN not in text
    assert "crn:x" in text


# ── The service, and whose account it authenticates ─────────────────────────


def test_a_presented_token_is_the_one_the_sdk_is_built_with() -> None:
    """The point of the whole feature, asserted at the only place it is visible."""
    hardware._ibm_service(IbmCredentials(token=USER_TOKEN))

    assert len(_FakeService.constructions) == 1
    assert _FakeService.constructions[0]["token"] == USER_TOKEN


def test_presenting_a_token_does_not_touch_the_global_settings() -> None:
    """THE invariant. A token written into `settings` is visible to every other
    request in flight, which is how one user's job ends up enqueued on another
    user's IBM account."""
    hardware._ibm_service(IbmCredentials(token=USER_TOKEN, instance="crn:user"))

    assert settings.ibm_quantum_token == "operator-token"
    assert settings.ibm_quantum_instance is None


def test_two_users_do_not_share_one_authenticated_service() -> None:
    """The cache key includes the token, so a cached service cannot leak across
    accounts — by construction, not by anyone remembering to check."""
    hardware._ibm_service(IbmCredentials(token=USER_TOKEN))
    hardware._ibm_service(IbmCredentials(token=OTHER_TOKEN))

    assert [c["token"] for c in _FakeService.constructions] == [USER_TOKEN, OTHER_TOKEN]


def test_the_same_user_reuses_one_authenticated_service() -> None:
    """The caching this cache was built for still works: a JobMonitor polling
    for hours must not re-authenticate on every poll."""
    hardware._ibm_service(IbmCredentials(token=USER_TOKEN))
    hardware._ibm_service(IbmCredentials(token=USER_TOKEN))

    assert len(_FakeService.constructions) == 1


def test_an_operator_request_is_unaffected_by_byok() -> None:
    """No credential means exactly the behaviour that predates this feature."""
    hardware._ibm_service()

    assert _FakeService.constructions == [
        {"channel": "ibm_quantum_platform", "token": "operator-token"}
    ]


def test_a_users_instance_is_addressed_and_the_operators_region_is_not() -> None:
    """The CRN comes from the user; the region does not.

    `settings.ibm_quantum_region` is the region of the OPERATOR's instance.
    Applying it to somebody else's account addresses a region their instance
    may not live in.
    """
    settings.ibm_quantum_region = "us-east"

    hardware._ibm_service(IbmCredentials(token=USER_TOKEN, instance="crn:user"))

    built = _FakeService.constructions[0]
    assert built["instance"] == "crn:user"
    assert "region" not in built


def test_the_service_cache_is_bounded() -> None:
    """BYOK made the key space one-per-user. Without a ceiling that is a memory
    leak and a pile of live credentials retained for the life of the process."""
    for index in range(hardware._IBM_SERVICE_CACHE_MAX + 10):
        hardware._ibm_service(IbmCredentials(token=f"token-{index:04d}-padding"))

    assert len(hardware._IBM_SERVICE_CACHE) <= hardware._IBM_SERVICE_CACHE_MAX


# ── Requests that cannot honour the credential are refused ──────────────────


def test_a_byok_job_may_not_join_a_platform_session() -> None:
    """A session is reserved on the operator's account. A job on a different
    account cannot run inside it, and running it OUTSIDE the reserved window
    while the caller believes otherwise is the silent-wrong-answer case."""
    with pytest.raises(ValueError) as excinfo:
        hardware.submit_job(
            BELL_QASM,
            "ibm_brisbane",
            100,
            hardware.PROVIDER_IBM,
            session_id="session-1",
            credentials=IbmCredentials(token=USER_TOKEN),
        )

    assert "session" in str(excinfo.value).lower()


def test_a_credential_for_the_wrong_provider_is_refused() -> None:
    """A mismatch means the web layer's provider derivation and this one
    disagree. Ignoring the credential would run the job on the operator's
    account with the submitter believing they had paid for it."""
    with pytest.raises(ValueError) as excinfo:
        hardware.submit_job(
            BELL_QASM,
            "ionq_aria",
            100,
            hardware.PROVIDER_BRAKET,
            credentials=IbmCredentials(token=USER_TOKEN),
        )

    message = str(excinfo.value)
    assert "ibm" in message
    assert "braket" in message
    assert "Nothing was submitted" in message


def test_the_same_guard_protects_polling() -> None:
    """A poll with a mismatched credential must refuse for the same reason."""
    with pytest.raises(ValueError) as excinfo:
        hardware.poll_job(
            hardware.PROVIDER_IBM,
            "job-1",
            credentials=BraketCredentials(
                access_key_id="AKIAEXAMPLEEXAMPLE00",
                secret_access_key="secret-access-key-aaaaaaaaaaaaaaaaaaaa",
                region="us-east-1",
                s3_bucket="b",
            ),
        )

    assert "braket" in str(excinfo.value)


# -- Braket ------------------------------------------------------------------


def test_a_braket_credential_round_trips() -> None:
    """Every field apps/web sends survives the wire format."""
    parsed = parse_credentials_header(_encode(BRAKET_PAYLOAD))

    assert isinstance(parsed, BraketCredentials)
    assert parsed.access_key_id == "AKIAEXAMPLEEXAMPLE00"
    assert parsed.region == "us-east-1"
    assert parsed.s3_bucket == "my-braket-results"
    # Defaulted rather than required: a prefix is a convenience, a bucket is not.
    assert parsed.s3_prefix == "quantum-lab"
    # Optional STS token, absent here.
    assert parsed.session_token is None


def test_a_braket_credential_without_a_bucket_is_refused() -> None:
    """Braket refuses a task with no result destination, and for a BYOK task
    the destination has to be a bucket in the USER's account — ours is not
    writable by their keys. Catching it here beats an opaque AWS rejection."""
    payload = {k: v for k, v in BRAKET_PAYLOAD.items() if k != "s3_bucket"}

    with pytest.raises(InvalidCredentials) as excinfo:
        parse_credentials_header(_encode(payload))

    assert "s3_bucket" in str(excinfo.value)


def test_a_braket_repr_hides_the_secret_key_but_shows_the_access_key_id() -> None:
    """The id is an identifier, like a username — showing it is how somebody
    tells WHICH AWS account is attached. The secret key is the credential."""
    creds = BraketCredentials(
        access_key_id="AKIAEXAMPLEEXAMPLE00",
        secret_access_key="secret-access-key-aaaaaaaaaaaaaaaaaaaa",
        region="us-east-1",
        s3_bucket="my-braket-results",
    )

    text = repr(creds)
    assert "secret-access-key-aaaaaaaaaaaaaaaaaaaa" not in text
    assert "AKIAEXAMPLEEXAMPLE00" in text
    assert "my-braket-results" in text


def test_an_sts_session_token_is_carried_and_hidden() -> None:
    """A short-lived credential is strictly the safer thing to hand over, so it
    is supported — and it is a secret, so it is not rendered."""
    parsed = parse_credentials_header(
        _encode({**BRAKET_PAYLOAD, "session_token": "sts-session-token-aaaaaaaa"})
    )

    assert isinstance(parsed, BraketCredentials)
    assert parsed.session_token == "sts-session-token-aaaaaaaa"
    assert "sts-session-token-aaaaaaaa" not in repr(parsed)


# -- Azure -------------------------------------------------------------------


def test_an_azure_credential_round_trips() -> None:
    """The four service-principal fields survive the wire format."""
    parsed = parse_credentials_header(_encode(AZURE_PAYLOAD))

    assert isinstance(parsed, AzureCredentials)
    assert parsed.location == "eastus"
    assert parsed.tenant_id == "11111111-1111-1111-1111-111111111111"
    assert parsed.client_id == "22222222-2222-2222-2222-222222222222"


@pytest.mark.parametrize(
    "missing", ["resource_id", "location", "tenant_id", "client_id", "client_secret"]
)
def test_every_azure_field_is_required(missing: str) -> None:
    """Azure has no partial mode: three ids and a secret, or nothing. A missing
    one would surface as an opaque authentication failure minutes later.

    Args:
        missing: The field to omit.
    """
    payload = {k: v for k, v in AZURE_PAYLOAD.items() if k != missing}

    with pytest.raises(InvalidCredentials) as excinfo:
        parse_credentials_header(_encode(payload))

    assert missing in str(excinfo.value)


def test_an_azure_repr_hides_only_the_client_secret() -> None:
    """tenant_id and client_id are identifiers; the client secret is not."""
    text = repr(
        AzureCredentials(
            resource_id="/subscriptions/x",
            location="eastus",
            tenant_id="11111111-1111-1111-1111-111111111111",
            client_id="22222222-2222-2222-2222-222222222222",
            client_secret="client-secret-aaaaaaaaaaaaaaaa",
        )
    )

    assert "client-secret-aaaaaaaaaaaaaaaa" not in text
    assert "11111111-1111-1111-1111-111111111111" in text
    assert "eastus" in text
