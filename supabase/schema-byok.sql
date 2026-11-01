-- ============================================================
-- Quantum Lab — BYOK: a user's own vendor credentials
--
-- Run this in the Supabase SQL editor AFTER schema-billing.sql
-- and schema-budgets.sql. It depends on both: it adds a column
-- to public.hardware_usage (billing) and it REPLACES two
-- functions those files define (see the warning below).
--
-- the internal handoff notes §4 is the specification this implements.
-- docs/BYOK.md is what a user reads.
--
-- ############################################################
-- #  WHY THIS TABLE IS DIFFERENT FROM public.api_keys         #
-- #                                                           #
-- #  api_keys stores a SHA-256 HASH. A key is presented to us #
-- #  and we only ever need to recognise it, so the plaintext  #
-- #  is thrown away and a lost key is replaced, not           #
-- #  recovered.                                               #
-- #                                                           #
-- #  A vendor token is the opposite: we have to PRESENT it to #
-- #  IBM on the user's behalf, so it must be RECOVERABLE. A   #
-- #  hash is useless here. It is therefore ENCRYPTED at rest  #
-- #  with AES-256-GCM by apps/web/lib/platform/secretBox.ts — #
-- #  the same sealed-envelope format the platform console     #
-- #  already uses for admin-set provider keys, deliberately   #
-- #  reused rather than reimplemented. The key that opens it  #
-- #  lives in the web app's environment                       #
-- #  (SETTINGS_ENCRYPTION_KEY), so a database dump on its own #
-- #  yields ciphertext.                                       #
-- #                                                           #
-- #  CONSEQUENCE AN OPERATOR MUST KNOW: rotating              #
-- #  SETTINGS_ENCRYPTION_KEY re-encrypts nothing. Every       #
-- #  stored token becomes unreadable and every user has to    #
-- #  re-enter theirs. The account panel says so; so does      #
-- #  docs/BYOK.md.                                            #
-- ############################################################
--
-- ############################################################
-- #  THIS TABLE IS READ AND WRITTEN ONLY BY THE SERVICE ROLE. #
-- #                                                           #
-- #  RLS is enabled and NO POLICY IS CREATED, so anon and     #
-- #  authenticated can do nothing and the service role (which #
-- #  bypasses RLS) is the only path in. Same construction as  #
-- #  public.runtime_sessions and public.webhook_endpoints.    #
-- #                                                           #
-- #  Do NOT add a policy "so users can read their own row".   #
-- #  A row contains a decryptable vendor credential. The one  #
-- #  thing standing between an over-broad anon key and every  #
-- #  user's IBM token is that no role except service_role can #
-- #  SELECT here at all. The listing users actually see is    #
-- #  built server-side from the masked hint, never from this  #
-- #  table directly — see apps/web/lib/security/              #
-- #  providerCredentials.ts.                                  #
-- ############################################################
--
-- HONESTY NOTE, same as every other file here: this has never
-- been run against a live Supabase project. The column names
-- match what providerCredentials.ts reads and writes and that
-- mapping is covered by tests against an in-memory double, but
-- the SQL itself is unverified. Check it before trusting it.
-- ============================================================

-- ── The credential ───────────────────────────────────────────
create table if not exists public.user_provider_credentials (
  -- One row per (user, provider). A composite primary key rather
  -- than a surrogate id: a user has at most ONE credential per
  -- vendor, and making that a constraint means "save" is an
  -- upsert with no read-modify-write and no way to end up with
  -- two rows that disagree about which token is current.
  user_id      uuid not null references auth.users (id) on delete cascade,

  -- The vendor.
  provider     text not null check (provider in ('ibm', 'braket', 'azure')),

  -- The SECRET half, sealed. Format `v1.<iv>.<ciphertext>.<tag>`,
  -- each base64url — apps/web/lib/platform/secretBox.ts.
  --
  -- The plaintext inside is a JSON OBJECT, not a bare token, because
  -- only IBM has a one-field credential:
  --
  --   ibm     {"token": "..."}
  --   braket  {"secret_access_key": "...", "session_token": "..."|null}
  --   azure   {"client_secret": "..."}
  --
  -- A JSON envelope for all three rather than a bare string for IBM
  -- and JSON for the rest: one shape means one seal path, one open
  -- path, and no branch that could get the two confused. The reader
  -- still accepts a bare string and reads it as an IBM token, so a
  -- row written by the first release of this feature keeps working.
  --
  -- NEVER a plaintext credential. The application refuses to write a
  -- value that does not carry the `v1.` marker, precisely so a future
  -- edit that forgets to seal fails loudly instead of quietly storing
  -- a vendor credential in the clear.
  secret       text not null check (char_length(secret) between 16 and 8192),

  -- What the OWNER sees in a listing: the last four characters
  -- behind a mask, e.g. `····8f2c`. Not a secret and not enough
  -- to reconstruct anything; it exists so somebody with two IBM
  -- accounts can tell which token is loaded here.
  hint         text not null default '' check (char_length(hint) <= 32),

  -- The PUBLIC half, in the clear, and shown back to its owner in
  -- full. Per provider:
  --
  --   ibm     {"instance": "crn:..."}            (optional)
  --   braket  {"access_key_id": "AKIA...",       (all required
  --            "region": "us-east-1",             except s3_prefix)
  --            "s3_bucket": "...", "s3_prefix": "..."}
  --   azure   {"resource_id": "...", "location": "eastus",
  --            "tenant_id": "...", "client_id": "..."}
  --
  -- ── WHY THESE ARE NOT SECRET, WHICH IS NOT OBVIOUS ──────────
  --
  -- An AWS access key id is an IDENTIFIER, like a username; the
  -- secret access key is what authorises. An Azure tenant id and
  -- client id likewise name an app registration that the client
  -- SECRET authenticates. Sealing them would mean nobody could see
  -- which of their own accounts is attached, which is the question
  -- a credential listing exists to answer.
  --
  -- ── WHY jsonb AND NOT COLUMNS ───────────────────────────────
  --
  -- These fields are display-only and differ per provider; nothing
  -- joins or filters on them. Modelling them as columns would mean
  -- a nullable column per provider per field and a migration every
  -- time a vendor adds one. The application validates the shape on
  -- the way in (providerCredentials.ts), which is where a shape
  -- that must match a vendor SDK belongs.
  --
  -- The IBM CRN lives here rather than in its own column for the
  -- same reason, and it matters because an account with more than
  -- one instance gets jobs placed on whichever one the SDK picks
  -- otherwise — how a job lands on the wrong plan and then polls as
  -- "not found". Same reasoning as IBM_QUANTUM_INSTANCE in
  -- the internal handoff notes §3.
  public_config jsonb not null default '{}'::jsonb,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- Stamped by the submit and poll paths when the credential is
  -- actually presented to the vendor. This is the column that
  -- answers "is this still being used, or did I leave it here
  -- three months ago" — the question that makes somebody revoke
  -- a credential they no longer need.
  last_used_at timestamptz,

  primary key (user_id, provider)
);

comment on table public.user_provider_credentials is
  'A user''s OWN vendor credential (BYOK), encrypted at rest with AES-256-GCM and recoverable because it must be presented to the vendor. Service role only; no RLS policies by design.';

comment on column public.user_provider_credentials.secret is
  'AES-256-GCM sealed JSON object holding only the SECRET fields of the credential, `v1.<iv>.<ct>.<tag>` base64url. Opened only in the web app''s process, for exactly one outbound call to the vendor.';

comment on column public.user_provider_credentials.public_config is
  'The non-secret half of the credential, in the clear and shown back to its owner: an IBM CRN, an AWS access key id / region / bucket, or an Azure workspace id / region / tenant / client id. Identifiers, not authorisers.';

alter table public.user_provider_credentials enable row level security;

create index if not exists user_provider_credentials_user_idx
  on public.user_provider_credentials (user_id);

-- `set_updated_at()` comes from schema.sql, like every other
-- table here that carries an updated_at.
drop trigger if exists user_provider_credentials_updated_at on public.user_provider_credentials;
create trigger user_provider_credentials_updated_at
  before update on public.user_provider_credentials
  for each row execute function public.set_updated_at();

-- ============================================================
-- WHOSE CREDENTIAL PAID FOR THIS JOB
--
-- The whole economic point of BYOK is that a job run on the
-- user's own IBM allowance costs this platform nothing and must
-- therefore not consume the monthly quota the platform meters to
-- protect ITS allowance. That is only expressible if a usage row
-- records whose credential was presented.
--
-- 'operator'  the platform's own IBM/AWS/Azure credentials.
--             Counts against the plan's monthly allowance and
--             against any spend budget. The default, so every
--             row that already exists is correctly labelled
--             without a backfill.
-- 'user'      the submitter's own credential. Recorded in full
--             (the history is the entire point of the row) but
--             invisible to the quota and the budget.
--
-- NOT a boolean. 'byok' is not the only thing that will ever
-- want naming here — an organisation-level shared credential is
-- the obvious next one, and a boolean would have to be widened
-- into exactly this column on the day it arrives.
-- ============================================================
alter table public.hardware_usage
  add column if not exists credential_owner text not null default 'operator';

alter table public.hardware_usage
  drop constraint if exists hardware_usage_credential_owner_check;
alter table public.hardware_usage
  add constraint hardware_usage_credential_owner_check
  check (credential_owner in ('operator', 'user'));

comment on column public.hardware_usage.credential_owner is
  'Whose vendor credential paid for this job: ''operator'' (counts against the plan allowance and any spend budget) or ''user'' (BYOK — recorded, but metered by nobody but the vendor).';

-- A partial index on exactly the rows the two functions below
-- still count. The quota path reads (user_id, created_at) for
-- operator rows on every submission, and once a BYOK-heavy
-- account has thousands of exempt rows the filter is no longer
-- free.
create index if not exists hardware_usage_operator_window_idx
  on public.hardware_usage (user_id, created_at)
  where credential_owner = 'operator';

-- ============================================================
-- ############################################################
-- #  THE TWO REPLACEMENTS BELOW ARE COPIES. KEEP THEM IN SYNC.#
-- #                                                           #
-- #  public.reserve_hardware_job and public.spend_in_window   #
-- #  are DEFINED in schema-billing.sql and schema-budgets.sql #
-- #  respectively. The versions below are those definitions   #
-- #  verbatim with ONE clause added to each count:            #
-- #                                                           #
-- #      and credential_owner = 'operator'                    #
-- #                                                           #
-- #  If you change the original, change this copy too.        #
-- #                                                           #
-- #  WHY A COPY AND NOT AN EDIT IN PLACE. Editing the         #
-- #  originals would change migration files that an already-  #
-- #  migrated project has recorded as applied — the CLI keys  #
-- #  on the migration NAME, so the edit would silently never  #
-- #  run there, and the column reference in the body would    #
-- #  then fail at call time against a table that has no such  #
-- #  column. Replacing here, in a file that is applied AFTER  #
-- #  both, is correct in both directions: on a fresh project  #
-- #  billing creates it and this replaces it; on a migrated   #
-- #  one this adds the column and replaces it in the same     #
-- #  file, in that order.                                     #
-- #                                                           #
-- #  The signatures are unchanged, so apps/web needs no new   #
-- #  RPC. The GRANTS are a different matter and the two       #
-- #  functions differ: reserve_hardware_job is `create or     #
-- #  replace`, which keeps the grants schema-billing.sql      #
-- #  applied; spend_in_window is DROP + CREATE (its result    #
-- #  set changed), and DROP FUNCTION discards every revoke    #
-- #  schema-budgets.sql applied while CREATE FUNCTION hands   #
-- #  EXECUTE back to PUBLIC — and Supabase's default           #
-- #  privileges to anon and authenticated. The revokes are    #
-- #  therefore RE-APPLIED right after the new body below.     #
-- #  (Audit 2026-10-22: this file shipped without them, and   #
-- #  the anon key could call spend_in_window for any uuid.)   #
-- ############################################################
-- ============================================================

create or replace function public.reserve_hardware_job(
  p_user_id         uuid,
  p_backend         text,
  p_shots           integer,
  p_limit           integer,
  p_period_start    timestamptz,
  p_bonus_threshold integer default null,
  p_bonus_jobs      integer default 0,
  p_year_start      timestamptz default null
)
returns table (reserved boolean, used integer, reservation_id uuid, bonus_jobs integer, bonus_granted boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_used      integer;
  v_id        uuid;
  v_bonus     integer := 0;
  v_granted   boolean := false;
  v_year_used integer;
begin
  if p_user_id is null or p_limit is null or p_period_start is null then
    raise exception 'reserve_hardware_job: user, limit and period start are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  -- BYOK CHANGE: only operator-funded jobs count. A job the user
  -- paid for at their own vendor account is not a draw on the
  -- allowance this function exists to protect.
  select count(*)::integer
    into v_used
    from public.hardware_usage
   where user_id = p_user_id
     and created_at >= p_period_start
     and credential_owner = 'operator';

  if p_year_start is not null then
    select coalesce(max(b.jobs), 0)
      into v_bonus
      from public.hardware_bonus b
     where b.user_id = p_user_id
       and b.granted_at >= greatest(p_period_start, p_year_start);
  end if;

  if v_used >= p_limit + v_bonus then
    return query select false, v_used, null::uuid, v_bonus, false;
    return;
  end if;

  -- credential_owner is left to its default of 'operator'. A BYOK
  -- submission never reaches this function at all: it is inserted
  -- directly by recordByokHardwareJob() in
  -- apps/web/lib/billing/usage.ts, because there is no limit to
  -- check and therefore nothing to serialize.
  insert into public.hardware_usage (user_id, backend, shots)
  values (
    p_user_id,
    coalesce(nullif(p_backend, ''), 'unknown'),
    greatest(coalesce(p_shots, 0), 0)
  )
  returning id into v_id;

  if p_bonus_threshold is not null
     and coalesce(p_bonus_jobs, 0) > 0
     and p_year_start is not null then
    -- BYOK CHANGE: same exclusion. The engagement bonus rewards
    -- 50 jobs run on the PLATFORM's hardware allowance; jobs a
    -- user funded themselves are not what it is paying for.
    select count(*)::integer
      into v_year_used
      from public.hardware_usage
     where user_id = p_user_id
       and created_at >= p_year_start
       and credential_owner = 'operator';

    if v_year_used >= p_bonus_threshold
       and not exists (
         select 1 from public.hardware_bonus b
          where b.user_id = p_user_id
            and b.granted_at >= p_year_start
       ) then
      insert into public.hardware_bonus (user_id, jobs)
      values (p_user_id, p_bonus_jobs);
      v_bonus   := p_bonus_jobs;
      v_granted := true;
    end if;
  end if;

  return query select true, v_used + 1, v_id, v_bonus, v_granted;
end;
$$;

comment on function public.reserve_hardware_job(uuid, text, integer, integer, timestamptz, integer, integer, timestamptz) is
  'Counts the caller''s OPERATOR-FUNDED usage in [p_period_start, now) and inserts a reservation only if it is under p_limit plus any bonus granted in the window. BYOK rows (credential_owner = ''user'') are excluded from both counts. Serialized per user by an advisory lock. service_role only: p_limit is an argument.';

-- ── The budget's view of spend, same exclusion ───────────────
--
-- A BYOK job is billed by the vendor to the USER's own account.
-- This platform never sees that invoice and its published-price
-- model is not what the user's own IBM plan charges them, so
-- counting it against a spending limit denominated in OUR
-- estimate would be a projection about somebody else's bill
-- presented as a measurement — the one thing schema-budgets.sql
-- says at length it will not do.
drop function if exists public.spend_in_window(uuid, timestamptz);

create function public.spend_in_window(
  p_user_id      uuid,
  p_period_start timestamptz
)
returns table (
  estimated_usd        numeric,
  priced_jobs          integer,
  unpriced_jobs        integer,
  jobs                 integer,
  shots                bigint,
  measured_qpu_seconds numeric
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce(sum(public.estimated_job_cost_usd(u.backend, u.shots)), 0)::numeric,
    count(*) filter (
      where public.estimated_job_cost_usd(u.backend, u.shots) is not null
    )::integer,
    count(*) filter (
      where public.estimated_job_cost_usd(u.backend, u.shots) is null
    )::integer,
    count(*)::integer,
    coalesce(sum(u.shots), 0)::bigint,
    coalesce(sum(u.qpu_seconds), 0)::numeric
  from public.hardware_usage u
  where u.user_id = p_user_id
    and u.created_at >= p_period_start
    -- BYOK CHANGE: see above.
    and u.credential_owner = 'operator';
$$;

comment on function public.spend_in_window(uuid, timestamptz) is
  'ESTIMATED USD spent in [p_period_start, now) on the OPERATOR''s credentials, the job and shot counts behind it, and the number of jobs that could not be priced at all (they contribute 0 and therefore UNDERSTATE the total). BYOK jobs are excluded: this platform never sees what the vendor charged the user.';

-- ── Grants, RE-APPLIED ───────────────────────────────────────
-- SECURITY FIX (audit 2026-10-22). `drop function` above threw
-- away the revokes schema-budgets.sql applied to spend_in_window,
-- and `create function` gave EXECUTE back to PUBLIC — on Supabase
-- the default privileges add anon and authenticated on top. The
-- function is SECURITY DEFINER over hardware_usage, so until this
-- block existed anyone holding the public anon key could read any
-- user's spend, job count, shots and QPU seconds for any window
-- by passing that user's uuid. Same block as schema-budgets.sql,
-- same reasoning: service_role only. verify-migrations.sql checks
-- that no SECURITY DEFINER function is executable by a user role.
revoke all on function public.spend_in_window(uuid, timestamptz) from public;
revoke all on function public.spend_in_window(uuid, timestamptz) from anon;
revoke all on function public.spend_in_window(uuid, timestamptz) from authenticated;
grant execute on function public.spend_in_window(uuid, timestamptz) to service_role;
