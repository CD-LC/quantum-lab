"""Per-request vendor credentials — BYOK, for every hardware provider.

Every hardware call in this service used to read its credentials from one
place: ``settings``, populated from the process environment at start-up. That
makes exactly one account's allowance spendable — the operator's — and it is
why a monthly job quota exists on the web side at all.

This module carries the other case. When a user has stored their own vendor
credential, ``apps/web`` opens it, attaches it to **one** outbound request as a
header, and the value arrives here. It is parsed into an immutable record,
handed to the call that needs it, and dropped.

THE INVARIANT THIS MODULE EXISTS TO PROTECT
-------------------------------------------

A presented credential is **never written into** ``settings``, and never into
``os.environ``. Not as a convenience, not "just for this request", not behind a
lock.

Both are process-global and this service handles concurrent requests. A
credential written to either is visible to every other request in flight, which
means one user's submission could be enqueued against another user's account —
the worst failure this feature can have, silent, and discoverable only from a
stranger's billing console.

``os.environ`` deserves its own sentence because it is the tempting shortcut
for AWS: boto3 reads ``AWS_ACCESS_KEY_ID`` from the environment, so "just set it
for the call" looks like it works and does, right up until two users submit at
once. Every provider below is therefore threaded as an EXPLICIT session or
client object, never through ambient configuration.

WHAT EACH PROVIDER NEEDS, AND WHICH PARTS ARE SECRET
----------------------------------------------------

=========  ================================  ==========================================
Provider   Secret (sealed, never displayed)   Public (shown back to its owner in full)
=========  ================================  ==========================================
ibm        token                              instance (CRN)
braket     secret_access_key, session_token   access_key_id, region, s3_bucket, s3_prefix
azure      client_secret                      resource_id, location, tenant_id, client_id
=========  ================================  ==========================================

The split is not cosmetic: the public half is stored in the clear and rendered
back so somebody can see *which* account is attached, and the secret half is
sealed and never leaves the server. An AWS access key id is an identifier, like
a username — it is the secret access key that authorises. Treating the id as
secret would mean nobody could tell which of their AWS accounts is wired up.

WHY A HEADER AND NOT A BODY FIELD
---------------------------------

Polling is a GET, so a body was never available there, and a query parameter is
the worst option: URLs end up in access logs, error reports and proxy traces. A
header keeps the credential out of all of them and lets submit and poll share
one mechanism rather than two.

The value is base64 for TRANSPORT SAFETY, not secrecy — it is trivially
reversible and nothing here pretends otherwise. It exists so a credential
containing a byte that is illegal in an HTTP header value cannot corrupt or
split the request.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from dataclasses import dataclass
from typing import Any, Union

#: Must match ``CREDENTIALS_HEADER`` in apps/web/lib/hardware/proxy.ts byte for
#: byte. A mismatch does not fail loudly — it makes this service fall back to
#: the operator's credentials, which is a wrong bill rather than an error.
CREDENTIALS_HEADER = "X-Quantum-Lab-Credentials"

#: Longest header value accepted before any decoding work happens.
#:
#: The largest real envelope is Azure's (a resource id is ~200 characters, plus
#: three GUIDs and a client secret), which is still well under a kilobyte. The
#: bound is here so a caller cannot make this service base64-decode and
#: JSON-parse a megabyte per request.
MAX_HEADER_CHARS = 8192

#: Bounds on any single secret field, mirrored from
#: apps/web/lib/security/providerCredentials.ts, which is authoritative and
#: checks them at the point of storage. Re-checked here because this service is
#: independently reachable and must not trust its caller's validation.
MIN_SECRET_CHARS = 8
MAX_SECRET_CHARS = 4096

#: Bound on any single public field (a CRN, a resource id, a bucket name).
MAX_FIELD_CHARS = 512

_GUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

#: The SHAPE each public field must have, mirrored from
#: ``PUBLIC_FIELD_SHAPES`` in apps/web/lib/security/providerCredentials.ts.
#:
#: These values are not only displayed: ``location`` and ``resource_id`` are fed
#: to the Azure SDK, which builds an endpoint URL from them, and ``region``,
#: ``s3_bucket`` and ``instance`` go to the IBM and AWS SDKs. A free account can
#: store any of them, so a value such as ``host.example/x?`` in ``location``
#: would make this service issue requests to a host of the caller's choosing.
#: Re-checked here because this service is independently reachable and must not
#: trust its caller's validation. Keyed ``provider.field``.
_PUBLIC_SHAPES: dict[str, re.Pattern[str]] = {
    "ibm.instance": re.compile(r"[A-Za-z0-9:._/\-]{1,512}"),
    "braket.access_key_id": re.compile(r"[A-Z0-9]{16,128}"),
    "braket.region": re.compile(r"[a-z]{2}(?:-[a-z]+)+-[0-9]"),
    "braket.s3_bucket": re.compile(r"(?!.*\.\.)[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]"),
    "braket.s3_prefix": re.compile(r"(?!.*\.\.)[A-Za-z0-9._/\-]{1,256}"),
    "azure.resource_id": re.compile(
        rf"/subscriptions/{_GUID}/resourceGroups/[A-Za-z0-9._()\-]{{1,90}}"
        r"/providers/Microsoft\.Quantum/Workspaces/[A-Za-z0-9_\-]{1,64}",
        re.IGNORECASE,
    ),
    "azure.location": re.compile(r"[a-z0-9]{3,32}"),
    "azure.tenant_id": re.compile(_GUID),
    "azure.client_id": re.compile(_GUID),
}

PROVIDER_IBM = "ibm"
PROVIDER_BRAKET = "braket"
PROVIDER_AZURE = "azure"

#: The providers a credential may be presented for. Mirrors ``BYOK_PROVIDERS``
#: in apps/web/lib/security/providerCredentials.ts.
PRESENTABLE_PROVIDERS = (PROVIDER_IBM, PROVIDER_BRAKET, PROVIDER_AZURE)


class InvalidCredentials(ValueError):
    """The presented credential header could not be understood.

    A ValueError subclass so the hardware router's ``_guard`` maps it onto a
    400, which is the honest status: the request carried something malformed,
    and silently ignoring it would run the job on the operator's account while
    the user believed otherwise.
    """


@dataclass(frozen=True)
class IbmCredentials:
    """One user's IBM Quantum credential, for one request.

    Attributes:
        token: The IBM Quantum API token. A live secret.
        instance: The service instance CRN, when the user supplied one. Only an
            address — useless without the token — but it decides which plan a
            job lands on for an account that has more than one instance.
    """

    token: str
    instance: str | None = None

    #: Which provider this credential is for. Used to refuse a credential
    #: presented for the wrong device, rather than ignore it.
    provider: str = PROVIDER_IBM

    def __repr__(self) -> str:
        """Render without the token. See :func:`_redacted_repr`."""
        return _redacted_repr("IbmCredentials", {"token": self.token}, {"instance": self.instance})


@dataclass(frozen=True)
class BraketCredentials:
    """One user's AWS credential for Amazon Braket, for one request.

    Braket is billed per shot plus a task fee, and — unlike IBM's free Open
    plan — there is no free tier to fall back on. A user attaching these is
    attaching a live spending capability against their own AWS account.

    Attributes:
        access_key_id: The AWS access key id. An IDENTIFIER, not a secret: it
            is shown back to its owner so they can tell which AWS account is
            attached.
        secret_access_key: The AWS secret access key. A live secret.
        session_token: For temporary (STS) credentials. Optional, and secret
            when present. Worth supporting because a short-lived credential is
            strictly the safer thing for a user to hand over — it expires on
            its own, which no permanent key does.
        region: The AWS region, e.g. ``"us-east-1"``. Braket devices are
            region-bound (see ``BRAKET_DEVICE_ARNS``), so the wrong region
            reads as "no such device".
        s3_bucket: The bucket Braket writes every task result to. REQUIRED —
            not a convenience — because Braket refuses a task with no result
            destination, and for a BYOK task the destination has to be a bucket
            in the USER's account: ours is not writable by their credentials.
        s3_prefix: Key prefix within that bucket.
    """

    access_key_id: str
    secret_access_key: str
    region: str
    s3_bucket: str
    s3_prefix: str = "quantum-lab"
    session_token: str | None = None

    provider: str = PROVIDER_BRAKET

    def __repr__(self) -> str:
        """Render without the secret key or session token."""
        return _redacted_repr(
            "BraketCredentials",
            {"secret_access_key": self.secret_access_key, "session_token": self.session_token},
            {
                "access_key_id": self.access_key_id,
                "region": self.region,
                "s3_bucket": self.s3_bucket,
                "s3_prefix": self.s3_prefix,
            },
        )


@dataclass(frozen=True)
class AzureCredentials:
    """One user's Azure Quantum workspace credential, for one request.

    Azure is the awkward one, and the shape reflects it. The SDK's usual path
    is ``DefaultAzureCredential``, which discovers an identity from the
    environment, a managed identity or a developer's ``az login`` — none of
    which can represent "this particular user, on this particular request". So
    BYOK on Azure means a **service principal**: the user registers an app in
    their own tenant, grants it access to their workspace, and hands over the
    three ids plus a client secret.

    That is more work than IBM's two-minute token, and the account panel says
    so plainly rather than presenting the four fields as if they were
    equivalent.

    Attributes:
        resource_id: The workspace resource id from the Azure portal.
        location: The workspace region, e.g. ``"eastus"``.
        tenant_id: The directory (tenant) id. An identifier.
        client_id: The application (client) id. An identifier.
        client_secret: The service principal's secret. A live secret.
    """

    resource_id: str
    location: str
    tenant_id: str
    client_id: str
    client_secret: str

    provider: str = PROVIDER_AZURE

    def __repr__(self) -> str:
        """Render without the client secret."""
        return _redacted_repr(
            "AzureCredentials",
            {"client_secret": self.client_secret},
            {
                "resource_id": self.resource_id,
                "location": self.location,
                "tenant_id": self.tenant_id,
                "client_id": self.client_id,
            },
        )


#: Any presented credential.
ProviderCredentials = Union[IbmCredentials, BraketCredentials, AzureCredentials]


def _redacted_repr(
    name: str, secrets: dict[str, str | None], public: dict[str, Any]
) -> str:
    """Build a repr that carries lengths for secrets and values for the rest.

    A dataclass's default repr prints every field, which puts live vendor
    credentials into any traceback, ``print`` or log line that touches the
    object — and FastAPI renders repr'd arguments on some error paths. Each
    credential class therefore defines ``__repr__`` explicitly rather than
    relying on the default, and every one of them routes through here so a new
    provider cannot quietly get the leaky default.

    Args:
        name: The class name to render.
        secrets: Field name to secret value. Rendered as a length only.
        public: Field name to value. Rendered normally.

    Returns:
        A repr safe to log.
    """
    parts = [
        f"{key}=<{len(value)} chars>" if value else f"{key}=None"
        for key, value in secrets.items()
    ]
    parts.extend(f"{key}={value!r}" for key, value in public.items())
    return f"{name}({', '.join(parts)})"


def parse_credentials_header(raw: str | None) -> ProviderCredentials | None:
    """Decode the BYOK header into a credential, or None when absent.

    Absent means "use the operator's credentials", which is what every caller
    did before this existed and what the overwhelming majority of requests
    still do. MALFORMED is a different answer and raises, for the reason on
    :class:`InvalidCredentials`.

    Args:
        raw: The raw header value, or None when the header was not sent.

    Returns:
        The parsed credential, or None when no header was present.

    Raises:
        InvalidCredentials: When the header is present but unusable.
    """
    if raw is None:
        return None
    value = raw.strip()
    if not value:
        return None

    if len(value) > MAX_HEADER_CHARS:
        raise InvalidCredentials(
            f"{CREDENTIALS_HEADER} is longer than {MAX_HEADER_CHARS} characters."
        )

    try:
        decoded = base64.b64decode(value, validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
        raise InvalidCredentials(f"{CREDENTIALS_HEADER} is not valid base64 UTF-8.") from exc

    try:
        payload = json.loads(decoded)
    except json.JSONDecodeError as exc:
        raise InvalidCredentials(f"{CREDENTIALS_HEADER} does not carry a JSON object.") from exc

    if not isinstance(payload, dict):
        raise InvalidCredentials(f"{CREDENTIALS_HEADER} does not carry a JSON object.")

    provider = payload.get("provider")
    if provider not in PRESENTABLE_PROVIDERS:
        # Not an error to be lenient about. A credential for a provider this
        # service cannot present would be accepted and then quietly unused, and
        # the job would run on the operator's account — which is exactly the
        # outcome the user was trying to avoid by supplying one.
        raise InvalidCredentials(
            f"Unknown credential provider {provider!r}. "
            f"Expected one of: {', '.join(PRESENTABLE_PROVIDERS)}."
        )

    if provider == PROVIDER_IBM:
        return IbmCredentials(
            token=_secret(payload, "token"),
            instance=_optional_field(payload, "instance", PROVIDER_IBM),
        )

    if provider == PROVIDER_BRAKET:
        return BraketCredentials(
            access_key_id=_field(payload, "access_key_id", PROVIDER_BRAKET),
            secret_access_key=_secret(payload, "secret_access_key"),
            session_token=_optional_secret(payload, "session_token"),
            region=_field(payload, "region", PROVIDER_BRAKET),
            s3_bucket=_field(payload, "s3_bucket", PROVIDER_BRAKET),
            s3_prefix=_optional_field(payload, "s3_prefix", PROVIDER_BRAKET) or "quantum-lab",
        )

    return AzureCredentials(
        resource_id=_field(payload, "resource_id", PROVIDER_AZURE),
        location=_field(payload, "location", PROVIDER_AZURE),
        tenant_id=_field(payload, "tenant_id", PROVIDER_AZURE),
        client_id=_field(payload, "client_id", PROVIDER_AZURE),
        client_secret=_secret(payload, "client_secret"),
    )


def _secret(payload: dict[str, Any], key: str) -> str:
    """Read and bound a REQUIRED secret field.

    Args:
        payload: The decoded credential object.
        key: The field to read.

    Returns:
        The trimmed value.

    Raises:
        InvalidCredentials: When absent, not a string, or out of range. The
            message names the FIELD and its LENGTH, never its value, because
            this message can reach a log.
    """
    value = payload.get(key)
    if not isinstance(value, str):
        raise InvalidCredentials(f"The presented credential has no {key}.")
    value = value.strip()
    if not MIN_SECRET_CHARS <= len(value) <= MAX_SECRET_CHARS:
        raise InvalidCredentials(
            f"The presented {key} must be between {MIN_SECRET_CHARS} and "
            f"{MAX_SECRET_CHARS} characters, got {len(value)}."
        )
    return value


def _optional_secret(payload: dict[str, Any], key: str) -> str | None:
    """Read a secret field that may be absent (an STS session token).

    Args:
        payload: The decoded credential object.
        key: The field to read.

    Returns:
        The trimmed value, or None.

    Raises:
        InvalidCredentials: When present but not a usable string.
    """
    if payload.get(key) in (None, ""):
        return None
    return _secret(payload, key)


def _check_shape(provider: str, key: str, value: str) -> str:
    """Pin a public field to its vendor-documented format.

    Azure and AWS region names are case-insensitive upstream, so they are folded
    to lower case before the check, exactly as the web layer does at storage.

    Args:
        provider: The provider the field belongs to.
        key: The field name.
        value: The trimmed value.

    Returns:
        The (possibly case-folded) value.

    Raises:
        InvalidCredentials: When the value does not match. The message names the
            FIELD, never the value.
    """
    full_key = f"{provider}.{key}"
    if full_key in ("azure.location", "braket.region"):
        value = value.lower()
    pattern = _PUBLIC_SHAPES.get(full_key)
    if pattern is not None and pattern.fullmatch(value) is None:
        raise InvalidCredentials(f"The presented {key} is not in the expected format.")
    return value


def _field(payload: dict[str, Any], key: str, provider: str | None = None) -> str:
    """Read and bound a REQUIRED public field.

    Args:
        payload: The decoded credential object.
        key: The field to read.
        provider: When given, the field is also checked against its shape.

    Returns:
        The trimmed value.

    Raises:
        InvalidCredentials: When absent, empty, not a string, or too long.
    """
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise InvalidCredentials(f"The presented credential has no {key}.")
    value = value.strip()
    if len(value) > MAX_FIELD_CHARS:
        raise InvalidCredentials(
            f"The presented {key} must be at most {MAX_FIELD_CHARS} characters."
        )
    return _check_shape(provider, key, value) if provider else value


def _optional_field(payload: dict[str, Any], key: str, provider: str | None = None) -> str | None:
    """Read a public field that may be absent (an IBM CRN, an S3 prefix).

    Args:
        payload: The decoded credential object.
        key: The field to read.
        provider: When given, a present value is also checked against its shape.

    Returns:
        The trimmed value, or None.

    Raises:
        InvalidCredentials: When present but not a usable string.
    """
    value = payload.get(key)
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise InvalidCredentials(f"The presented {key} must be a string or null.")
    value = value.strip()
    if not value:
        return None
    if len(value) > MAX_FIELD_CHARS:
        raise InvalidCredentials(
            f"The presented {key} must be at most {MAX_FIELD_CHARS} characters."
        )
    return _check_shape(provider, key, value) if provider else value
