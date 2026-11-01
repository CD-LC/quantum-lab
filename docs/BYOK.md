# BYOK — run on your own quantum hardware account

Bring your own key. Add your own **IBM Quantum**, **Amazon Braket** or **Azure
Quantum** credentials and hardware jobs you submit here run on **your** account
instead of this platform's: they stop counting against your monthly allowance,
they queue under your own plan, and they appear in your own vendor console
beside everything else you run.

The panel is on **`/account`**, under *"Run on your own hardware account"*.

---

## 1. Which provider should you bring?

The three errands are nothing alike. Start with IBM unless you have a specific
reason not to.

| | IBM Quantum | Amazon Braket | Azure Quantum |
|---|---|---|---|
| Time to set up | **~2 minutes** | ~10 minutes | ~30 minutes, first time |
| Cost | **Free** (Open plan, no card) | Paid per shot + task fee, no free tier | Paid; Quantinuum bills in H-System Credits |
| Fields to paste | 1 (+1 optional) | 4 (+2 optional) | 5 |
| Extra setup | none | an S3 bucket you own | an app registration + a role assignment |
| Devices | 127-qubit superconducting | IonQ, Rigetti | Quantinuum, IonQ |

---

## 2. IBM Quantum — the two-minute one

1. Go to **<https://quantum.ibm.com>** and sign in, or create an account.
   The **Open plan is free** — no card, no trial clock. It gives you a monthly
   allowance of QPU time on IBM's real 127-qubit machines.
2. On the dashboard, find **API token** and copy it.
3. Paste it into the token field on `/account` and save.

**The CRN — and when you actually need it.** Only if your IBM account has more
than one service instance. An Open-plan account has one, so most people leave
this empty. If you do have several, copy the **CRN** of the one you want from
the instances list. Leaving it empty means the SDK picks an instance for you,
which is how a job lands on the wrong plan, with the wrong allowance, and then
reports itself as **"not found"** when this site polls it. Same failure mode
`IBM_QUANTUM_INSTANCE` exists to prevent for the operator (`the internal handoff notes` §3).

---

## 3. Amazon Braket — bring an S3 bucket too

Braket is **paid from the first shot**. There is no free tier, and a large
sweep on IonQ is real money. Price it with `/api/hardware/estimate` first.

1. In **AWS IAM**, create a user (or role) and attach **`AmazonBraketFullAccess`**.
2. Create an **access key** for it. You get an *access key ID* and a *secret
   access key*; the secret is shown once.
3. Create an **S3 bucket** in the same account. **This is required, not
   optional** — Braket writes every result to S3 and refuses a task without a
   destination, and with your keys it has to be a bucket *you* own, because our
   bucket is not writable by your credentials.
4. Pick the **region** your device lives in: IonQ is `us-east-1`, Rigetti is
   `us-west-1`. A device is not visible from the wrong region.
5. Paste the four fields on `/account`.

**Prefer temporary credentials.** If you can issue **STS** credentials, do —
paste the session token into the optional field. They expire on their own,
which no permanent access key does, and that is the single biggest reduction in
what a leak would cost you.

---

## 4. Azure Quantum — a service principal

The longest of the three, and the reason is structural: the Azure SDK's normal
path (`DefaultAzureCredential`) discovers an identity from the *machine* — the
environment, a managed identity, a developer's signed-in CLI. None of those can
express "this user, on this request", so BYOK on Azure means a service
principal you create in your own tenant.

1. In the **Azure portal**, open your **Quantum Workspace** and copy its
   **resource ID** (Properties) and its **region**.
2. **Microsoft Entra ID → App registrations → New registration.** Copy the
   **Directory (tenant) ID** and the **Application (client) ID**.
3. Under **Certificates & secrets**, create a **client secret** and copy its
   value. It is shown once.
4. **Give that app access to the workspace:** Workspace → **Access control
   (IAM)** → Add role assignment → **Contributor** → your app.
5. Paste the five fields on `/account`.

**Step 4 is the one people miss.** Without it the credential authenticates
perfectly and then cannot see the workspace, which surfaces as a confusing
"could not connect" rather than "permission denied".

---

## 5. What we do with the credentials, exactly

### The secret half

* Stored **encrypted at rest** with AES-256-GCM
  (`apps/web/lib/platform/secretBox.ts`) in `public.user_provider_credentials`.
  A database dump on its own yields ciphertext; the key that opens it lives
  only in the web app's environment.
* **Never returned to your browser.** The panel shows a masked hint
  (`····8f2c`) and nothing more. There is no endpoint that reads it back out —
  the same rule API keys follow.
* Decrypted server-side **for exactly one outbound call per request**, then
  dropped. Never logged, never in an error message, never written into the
  service's global configuration.

### The public half — read this before you paste

Not every field is a secret, and the panel says which is which:

| Provider | Secret (sealed, never shown again) | Identifier (stored **in the clear**, shown back in full) |
|---|---|---|
| IBM | API token | instance CRN |
| Braket | secret access key, session token | **access key ID**, region, S3 bucket, prefix |
| Azure | client secret | resource ID, region, **tenant ID**, **client ID** |

An AWS access key ID is an identifier, like a username — the *secret* access
key is what authorises. An Azure tenant and client ID name an app registration
that the *client secret* authenticates. They are stored in the clear on purpose:
"which of my accounts is attached?" is the question a credential listing exists
to answer, and sealing the identifiers would make it unanswerable.

### What this is not

Encryption at rest protects the secret from someone who reads the database. It
does not, and cannot, protect it from anything able to run code in the web
app's process — that process has to open the envelope to present the credential
to the vendor at all. Anyone offering you a stronger claim is describing a
system that cannot do the thing this one does.

---

## 6. What changes about billing and quotas

| | Platform credentials (default) | Your own |
|---|---|---|
| Whose vendor account is billed | Ours | **Yours** |
| Counts against the monthly job allowance | Yes | **No** |
| Counts against a spend budget set here | Yes | **No** (see below) |
| Requires a paid plan for `hardware.real` | Yes | **No** |
| Job history, permalinks, comparison, API | Yes | Yes — unchanged |

Spend budgets are denominated in *our* published-price estimate of what a job
costs *us*. Your own plan bills you on its own terms and we never see that
invoice, so enforcing our estimate against your money would be a projection
presented as a measurement. Budgets therefore ignore BYOK jobs entirely. If you
need a ceiling on your own spend, set it at the vendor, where the real numbers
are — AWS Budgets, or an Azure cost alert.

Everything else works exactly as before. The usage row is still written — it is
what makes the job pollable, listable, citable and reproducible — it is just
marked `credential_owner = 'user'` and skipped by the two counts that meter the
operator's spend.

---

## 7. Removing it — and what actually revokes it

**Removing the credential here is not revocation.** It stops this platform from
presenting it. It stays completely valid at the vendor, along with anything else
holding a copy.

To genuinely revoke it:

| Provider | Where |
|---|---|
| IBM | quantum.ibm.com → your dashboard → delete the API token |
| Braket | AWS IAM → your user → Security credentials → deactivate/delete the key |
| Azure | Portal → App registrations → your app → Certificates & secrets |

Do that **first** if you think it has leaked; removing it here afterwards is
housekeeping.

### Jobs you already submitted

A job can only be polled with the credential it was submitted under — no vendor
shows one account another account's jobs. This site keys the poll on the
credential the job was **submitted** with, recorded on the job's row, so adding
or removing a credential does not orphan your existing jobs.

But if you remove the credential (or it can no longer be decrypted), a
still-running BYOK job becomes unpollable *here*. The job is unaffected: it is
running on your account and its results are in your vendor console.

### If the platform rotates its encryption key

Rotating `SETTINGS_ENCRYPTION_KEY` re-encrypts nothing. Every stored credential
becomes unreadable and has to be entered again. The panel says so on the
affected row — *"This credential can no longer be decrypted"* — rather than
leaving you to discover it when jobs quietly start drawing on your allowance
here again.

---

## 8. Verifying it end to end — the runbook

Nothing below is covered by the test suite, and it cannot be: every hardware
test is offline and injects fakes, which is right (a suite that spends money is
a suite nobody runs) but means a green suite proves the code is internally
consistent, not that IBM will accept a job from it.

Do this in order. Each step isolates a different failure, so when something
breaks you know which half is wrong.

### Step 0 — prerequisites

```sql
-- Has the migration run? This must return a row.
select column_name from information_schema.columns
 where table_name = 'hardware_usage' and column_name = 'credential_owner';
```

Nothing returned means `supabase/schema-byok.sql` has not been applied. BYOK
will still run jobs on your own credential, but it will ALSO count them against
your monthly allowance, and the whole point of step 6 disappears.

Also confirm `SETTINGS_ENCRYPTION_KEY` is set on the web app. Without it the
panel still stores credentials, but under a key derived from the Supabase
service-role key (see "Moving off the fallback key" in section 9). The panel
answers 503 only when NEITHER `SETTINGS_ENCRYPTION_KEY` nor
`SUPABASE_SERVICE_ROLE_KEY` is set, because then there is nothing to encrypt
with.

### Step 1 — get an IBM token (free, ~2 minutes)

1. <https://quantum.ibm.com> → sign in or create an account. Open plan, no card.
2. Copy the **API token** from the dashboard.

Start with IBM even if your real target is Braket or Azure. It is free, it is
the best-understood call shape in this codebase, and if it fails you know the
problem is the platform rather than your AWS bucket policy.

### Step 2 — prove the token works, WITHOUT this platform

```bash
cd services/api
IBM_QUANTUM_TOKEN=<your token> python scripts/hardware_smoke.py
```

This lists what your account can actually see. It touches none of the BYOK
code — it reads the token from the environment the old way — so it separates
"my token is wrong" from "BYOK is wrong". If this fails, fix that first.

Then price a circuit without submitting:

```bash
IBM_QUANTUM_TOKEN=<your token> python scripts/hardware_smoke.py --backend ibm_brisbane
```

### Step 3 — store it, and check nothing comes back

1. Sign in at <https://qubit16.ai/account>.
2. Under **Run on your own hardware account**, pick **IBM Quantum**, paste the
   token, leave the CRN empty (unless your account has several instances), save.
3. Open devtools → Network → the `POST /api/credentials` response.

**What you should see:** a `credential` object with `hint: "····abcd"` and
nothing resembling your token. **If the token appears anywhere in that
response, stop and report it** — that is the one failure mode this design
exists to prevent.

Reload the page. The panel should show the masked hint, the date, and
`last used —`.

### Step 4 — submit a job on it

Easiest scriptable route, because an API key can submit but cannot touch
credentials:

1. On `/account`, create an API key with the **`hardware:submit`** scope.
2. Submit:

```bash
curl -i -X POST https://qubit16.ai/api/hardware/submit \
  -H "Authorization: Bearer qb16_sk_…" \
  -H "Content-Type: application/json" \
  -d '{"qasm":"OPENQASM 3.0;\ninclude \"stdgates.inc\";\nqubit[2] q;\nbit[2] c;\nh q[0];\ncx q[0], q[1];\nc = measure q;\n","backend":"ibm_brisbane","shots":1024}'
```

Or just use the hardware panel in the simulator, which sends the same request.

### Step 5 — THE assertion: whose credential paid?

In the response headers from step 4:

```
X-Qubit16-Credential-Owner: user
```

`user` means the job went out on your token. `operator` means it did not, and
the credential was not picked up — check that the backend id really maps to the
provider you stored (`ibm_*` → ibm), and that the panel shows the credential as
readable rather than "can no longer be decrypted".

### Step 6 — confirm it did NOT spend your allowance

```sql
select created_at, backend, provider, job_id, credential_owner
  from public.hardware_usage
 where user_id = '<your auth.users id>'
 order by created_at desc
 limit 5;
```

The new row must read `credential_owner = 'user'`. The row exists on purpose —
it is what makes the job pollable, listable and citable — it is simply not
counted.

Cross-check the human-visible number: the usage card on `/account` should show
the same "hardware jobs used this month" before and after this submission.

### Step 7 — confirm it is really in YOUR IBM account

Open <https://quantum.ibm.com> → Jobs. The job should be there, tagged
`qubit16` and `owner:<16 hex characters>`. That hash is a truncated SHA-256 of
your account id — opaque on purpose, since it crosses into a third party's
console.

**This is the step that actually proves BYOK.** Everything before it could be
true of a job that ran on the platform's account.

### Step 8 — confirm polling still works

Poll the job id from step 4:

```bash
curl https://qubit16.ai/api/hardware/job/ibm/<job_id> \
  -H "Authorization: Bearer qb16_sk_…"
```

A status rather than `{"detail":"No such job."}` means the poll resolved your
credential from the job's stored row. If it 404s while the job is plainly
visible in IBM's console, the poll is presenting the wrong credential — that is
the bug this whole `credential_owner` mechanism exists to prevent, and it is
worth reporting in detail.

### Step 9 — the negative test, which is the one people skip

1. Remove the credential on `/account`.
2. Submit the same job again.
3. The response header should now read `X-Qubit16-Credential-Owner: operator`,
   the new `hardware_usage` row should read `credential_owner = 'operator'`,
   and the usage count on `/account` should go **up by one**.

Without this step you have proved that jobs run, not that the switch works.

### Step 10 — only then, the paid providers

Braket and Azure carry an extra unknown: their explicit-session call shapes
have never run against a live account. Test them with the **smallest possible
shot count** — Braket bills per shot plus a task fee from the first one.

For Braket, the two failures worth expecting are a bucket in the wrong region
and an IAM policy without `AmazonBraketFullAccess`. For Azure, it is almost
always the role assignment in §4 step 4.

---

## 9. For operators

### Turning it on

Two prerequisites, and the panel reports which one is missing:

```bash
SUPABASE_SERVICE_ROLE_KEY=…      # already set on any real deployment
SETTINGS_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

Then apply the migration:

```bash
supabase db push        # or paste supabase/schema-byok.sql into the SQL editor
```

Without `SETTINGS_ENCRYPTION_KEY`, `secretBox` derives a key from the
service-role key, so BYOK technically works — but anyone who can read the
service-role key can decrypt every stored credential, and rotating the
service-role key then silently invalidates all of them. Set it explicitly.
BYOK deliberately does NOT refuse to start without it: that would lock out the
users whose credentials are already stored under the derived key.

### Moving off the fallback key

*How to tell you are on it.* Any one of:

- the web app's log has, once per process, `[secretBox] SETTINGS_ENCRYPTION_KEY
  is not set: stored BYOK credentials … are sealed under a key DERIVED FROM
  SUPABASE_SERVICE_ROLE_KEY …` (also sent to the error tracker as a warning
  when one is configured);
- `/api/health` called with `HEALTH_DEEP_TOKEN` reports `byokKeyIsFallback:
  true` (trusted callers only; anonymous callers never see it);
- `SETTINGS_ENCRYPTION_KEY` is absent from the Container App's environment.

*The migration, which locks nobody out:*

1. Generate a key and store it somewhere other than the Supabase project:
   `openssl rand -hex 32`. Losing it makes every credential sealed under it
   unreadable, so keep a copy in your secret manager.
2. Set it on the web app as `SETTINGS_ENCRYPTION_KEY` and redeploy (for
   `infra/azure/deploy.sh`, add it to the secrets it already passes).
3. Nothing breaks. From that moment every NEW or re-saved credential is sealed
   under the explicit key only. A credential sealed earlier still opens,
   because `open()` falls back to the derived key for values the explicit key
   cannot open.
4. Those earlier credentials are still protected only by the derived key until
   their owner saves them again (or removes them). Ask users with a stored
   credential to re-enter it, or — if you accept the disruption — delete the
   rows so they must: `delete from user_provider_credentials;` (their running
   jobs are unaffected; the panel shows them as not attached). There is no
   automatic re-seal.
5. Confirm: the warning in step "How to tell" no longer appears after a
   restart and `byokKeyIsFallback` reads `false`. Once every row has been
   re-saved you may rotate the service-role key without affecting BYOK.

*Do not* simply set a different value later to "rotate": a value sealed under
the old explicit key becomes unreadable (the panel flags the row, and the user
must re-enter it). See "If the platform rotates its encryption key" above.

Without the migration, BYOK still works and jobs still run on the user's own
credential; they are simply also counted against that user's monthly allowance,
because nothing in the database can tell that they should not be. One loud log
line names the file to apply.

`azure-identity` is declared in `requirements-hardware.txt` because
`app/quantum/azure.py` imports `ClientSecretCredential` directly. It also
arrives transitively through `azure-quantum` (which pins
`azure-identity>=1.25.3`), so the Azure BYOK path works in any image built from
that file — the explicit line exists so it keeps working if azure-quantum ever
drops the dependency.

### The invariant, and why it is the whole design

A presented credential is **never written into `settings` or `os.environ`**.
Both are process-global and this service handles concurrent requests, so a
credential written to either is visible to every request in flight — meaning
one user's job could be enqueued against another user's account, silently, with
the only evidence in a stranger's billing console.

`os.environ` deserves naming because it is the tempting shortcut for AWS: boto3
reads `AWS_ACCESS_KEY_ID` from it, so "just set it for the call" appears to work
and does, right up until two users submit at once. Every provider is therefore
threaded as an **explicit session object**:

| Provider | Explicit object | Where |
|---|---|---|
| IBM | `QiskitRuntimeService`, cached with the **presented token in the cache key** | `hardware.py::_ibm_service` |
| Braket | `AwsSession` over an explicit `boto3.Session` | `hardware.py::_braket_session` |
| Azure | `ClientSecretCredential` passed to `Workspace(credential=…)` | `azure.py::_workspace` |

The IBM cache is capped at 32 entries: BYOK turned its key space from a handful
of operator settings into one live credential per user, held for the life of the
process. Braket and Azure build their session per call and cache nothing, so no
process-global structure retains those credentials at all.

### What a BYOK request cannot do

* **Join a runtime session.** Sessions are opened on the operator's account and
  bill for their whole window; a job on a different account cannot run inside
  one. Refused with a message naming which half to drop, rather than run
  outside the reserved window while the caller believes otherwise.
* **Be presented for the wrong provider.** A credential whose provider does not
  match the device is refused, not ignored — ignoring it would run the job on
  the operator's account with the submitter believing they had paid.
* **Skip identity, rate limits or validation.** Only the *billing* gates are
  skipped. A credential that lets you drive our servers in a loop is still our
  CPU.

### Where the pieces are

| Piece | File |
|---|---|
| Table, quota exemption, function replacements | `supabase/schema-byok.sql` |
| Field catalogue, secret/public split, seal, resolve | `apps/web/lib/security/providerCredentials.ts` |
| Whose credential pays, one decision for both routes | `apps/web/lib/hardware/byok.ts` |
| Save / list / remove | `apps/web/app/api/credentials/route.ts` |
| Submit-time resolution and the quota branch | `apps/web/app/api/hardware/submit/route.ts` |
| Poll-time resolution | `apps/web/app/api/hardware/job/[provider]/[...jobId]/route.ts` |
| Header parsing, per-provider bounds, secret-free reprs | `services/api/app/quantum/credentials.py` |
| IBM + Braket explicit sessions | `services/api/app/quantum/hardware.py` |
| Azure explicit credential | `services/api/app/quantum/azure.py` |
| Account panel and the instructions above | `apps/web/components/account/ProviderCredentials.tsx` |

### Adding a fourth provider

In this order, because the UI must never offer a credential the submit path
cannot present:

1. A dataclass and a parser branch in `credentials.py`.
2. An **explicit** session/client in that provider's module — never ambient
   configuration.
3. An entry in `PROVIDER_FIELDS` (which fields, which are secret) and in
   `BYOK_PROVIDERS`.
4. The backend-id mapping in `apps/web/lib/hardware/byok.ts`.
5. The provider in the `check` constraint in `schema-byok.sql`.

### Still unverified

Consistent with `the internal handoff notes` §7: **no job has ever been submitted to real
hardware from this codebase**, with the operator's credentials or anyone's. The
BYOK path is covered by offline tests that assert the presented credential is
the one the SDK is built with, that it never reaches global settings, that two
users cannot share an authenticated service, and that a mismatched provider is
refused — but the end-to-end claim ("a user's own credential enqueues a job on
their own account") is unproven against every live vendor, same as everything
else on the hardware path. `services/api/scripts/hardware_smoke.py` is what
settles it.

Braket and Azure carry one extra unknown that IBM does not: their explicit-session
call shapes (`AwsDevice(arn, aws_session=…)`, `AwsQuantumTask(arn=…,
aws_session=…)`, `Workspace(credential=…)`) are written against the published
SDK signatures and have never been exercised against a live account.
