-- ─────────────────────────────────────────────────────────────────────────────
-- schema-hardening.sql — audit 2026-09-29: sign-in and signed-in usability.
--
-- Three parts, all idempotent, all run AFTER every other schema file:
--   A. An org seat must be paid for (finding ORG-3).
--   B. Saved circuits are inserted by the server, where the plan limit is
--      enforced (Free: 10). The browser may still read/rename/delete its own.
--   C. public.user_progress — course progress that follows the account.
--
-- APPLY ORDER: deploy the web app first, then run this. The new app works
-- before it is applied (it saves circuits via the service role, and progress
-- sync fails soft without the table); the old app would lose cloud saves
-- after part B.
--
-- ═════════════════════════════ A. ORG INTEGRITY ═════════════════════════════
--
-- THE HOLE (audit 2026-09-29, finding ORG-3):
--   · `orgs_insert_owner` checked only `owner_id = auth.uid()`, so ANY signed-in
--     user could insert an org with `plan_id = 'edu'` and `seats_total = null`
--     straight from the browser with the anon key;
--   · `org_members_insert_manager` then let that owner insert their own seat
--     with any `plan_id` / `status`;
--   · lib/billing/entitlements.ts honours an active `org_members` row as the
--     user's plan. Result: a Free account on University, for nothing. The
--     /admin "Preview with demo data" button reached the real write path, so it
--     did not even need devtools.
--   · `orgs_update_manager` also let an owner rewrite `plan_id` / `seats_total`
--     on an org they legitimately held (Team → unlimited University seats).
--
-- THE RULE, enforced here because the browser writes these tables directly:
--   1. Creating an org requires the caller's OWN active subscription to the
--      same plan (team or edu). A seat in someone else's org does not count.
--   2. A Team org gets exactly the Team seat count (10); only University is
--      unlimited. Matches lib/plans.ts `limits.seats`.
--   3. `plan_id`, `seats_total` and `owner_id` on an org are fixed for user
--      roles — changing a licence is a billing/support action (service role).
--   4. A seat's `plan_id` is always copied from its org; it cannot be forged.
--
-- The service role and the SQL editor (no JWT role) are unaffected, so support
-- and the webhook keep working. Idempotent; safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1 + 2: creation needs a matching paid subscription and the plan's seat count.
drop policy if exists orgs_insert_owner on public.orgs;
create policy orgs_insert_owner
  on public.orgs for insert
  with check (
    owner_id = auth.uid()
    and exists (
      select 1
        from public.subscriptions s
       where s.user_id = auth.uid()
         and s.plan_id = orgs.plan_id
         and s.status in ('active', 'trialing', 'past_due')
    )
    and (
      (orgs.plan_id = 'team' and orgs.seats_total = 10)
      or (orgs.plan_id = 'edu')
    )
  );

-- 3: licence columns are immutable for signed-in users.
create or replace function public.orgs_lock_licence_columns()
returns trigger
language plpgsql
as $$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    if new.plan_id     is distinct from old.plan_id
    or new.seats_total is distinct from old.seats_total
    or new.owner_id    is distinct from old.owner_id then
      raise exception 'plan_id, seats_total and owner_id can only be changed by support'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists orgs_lock_licence_columns on public.orgs;
create trigger orgs_lock_licence_columns
  before update on public.orgs
  for each row execute function public.orgs_lock_licence_columns();

-- 4: a seat inherits its org's plan, whatever the client sent.
-- SECURITY DEFINER so it can read the org even when the writer's RLS view of
-- `orgs` would not show it; it only ever reads, and only the one row.
create or replace function public.org_members_inherit_plan()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  org_plan text;
begin
  select o.plan_id into org_plan from public.orgs o where o.id = new.org_id;
  if org_plan is null then
    raise exception 'organisation % does not exist', new.org_id using errcode = '23503';
  end if;
  new.plan_id := org_plan;
  return new;
end;
$$;

revoke all on function public.org_members_inherit_plan() from public, anon, authenticated;

drop trigger if exists org_members_inherit_plan on public.org_members;
create trigger org_members_inherit_plan
  before insert or update of plan_id, org_id on public.org_members
  for each row execute function public.org_members_inherit_plan();

-- ─────────────────────────────────────────────────────────────────────────────
-- After applying, look for orgs created through the hole (read-only):
--
--   select o.id, o.name, o.plan_id, o.seats_total, o.owner_id, o.created_at
--     from public.orgs o
--    where not exists (
--            select 1 from public.subscriptions s
--             where s.user_id = o.owner_id and s.plan_id = o.plan_id
--               and s.status in ('active', 'trialing', 'past_due'))
--    order by o.created_at desc;
--
-- Review each row before acting: a University licence set up by hand by
-- support will also appear here if no subscription row was written for it.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════ B. CIRCUIT INSERTS VIA SERVER ═══════════════════════
--
-- The saved-circuit limit depends on the plan, and the plan can depend on the
-- launch trial (an environment setting only the app knows), so it is enforced
-- in POST /api/circuits, which writes with the service role. A direct client
-- insert would bypass it, so the insert policy is removed; with RLS on and no
-- insert policy, `authenticated` cannot insert. Select/update/delete own-row
-- policies are unchanged.
drop policy if exists circuits_insert_own on public.circuits;


-- ═════════════════════════ C. PROGRESS FOLLOWS THE ACCOUNT ═══════════════════
--
-- One row per user: the same JSON shape lib/lessons/progress.ts keeps in
-- localStorage ({ completed: string[], quizScores: {slug: number},
-- lastVisited?: string }). Written by the browser (lib/lessons/progressSync.ts)
-- under own-row RLS — it is the user's own learning record, nothing is gated
-- on it, so there is nothing to protect it from its owner.
create table if not exists public.user_progress (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  progress   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint user_progress_size check (octet_length(progress::text) <= 65536)
);

comment on table public.user_progress is
  'Course progress per account (completed lessons, quiz scores). Merged with the browser copy on sign-in by lib/lessons/progressSync.ts.';

alter table public.user_progress enable row level security;

drop policy if exists user_progress_select_own on public.user_progress;
create policy user_progress_select_own
  on public.user_progress for select
  using (auth.uid() = user_id);

drop policy if exists user_progress_insert_own on public.user_progress;
create policy user_progress_insert_own
  on public.user_progress for insert
  with check (auth.uid() = user_id);

drop policy if exists user_progress_update_own on public.user_progress;
create policy user_progress_update_own
  on public.user_progress for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- ═════════════════ D. LEADERBOARD VIEW: STOP READING PAST RLS ═════════════════
--
-- Supabase's security advisor flags public.competition_leaderboard as a
-- SECURITY DEFINER view (it runs with its owner's rights, bypassing the RLS on
-- competition_entries). schema-competitions.sql made that deliberate so `anon`
-- could read it — but nothing in the app does: lib/compete/store.ts reads the
-- table with the service role, and GET /api/compete serves the leaderboard.
-- So the only effect of the definer view is that anyone holding the public
-- anon key can read it directly. Run it as the CALLER instead (RLS applies; the
-- table has no policy, so the view returns nothing to anon) and withdraw the
-- public grant. The service role is unaffected. This runs after
-- schema-competitions.sql, so a full re-run ends in this state.
alter view public.competition_leaderboard set (security_invoker = true);
revoke select on public.competition_leaderboard from anon, authenticated;


-- ═════════ E. AUDIT 2026-10-22: INVITE TAMPERING, SEAT CAP, ONE LICENCE ═════════
--
-- E1. org_invites: the invitee could UPDATE their own invite row (the old
--     policy let `lower(email) = jwt email` through both USING and WITH CHECK,
--     with no column restriction) and rewrite org_id / role / expires_at /
--     accepted_at. POST /api/orgs/invite/accept reads that row with the service
--     role and trusts it, so an invitee could retarget their invite at ANY org
--     uuid as role 'owner'. Only managers write invites from the browser; the
--     accept route burns invites with the service role. Policy is now
--     manager-only, and a trigger freezes the identity columns for user roles
--     as a second lock.
--
-- E2. org_members: nothing in the database compared the roster to
--     orgs.seats_total — the cap lived in TypeScript only, and the browser
--     writes this table directly. A trigger now refuses a seat-consuming row
--     ('active' / 'invited') past seats_total for signed-in roles. The service
--     role and the SQL editor (no JWT role) are unaffected, so
--     app/api/orgs/* keeps working. Suspended rows consume no seat.
--
-- E3. orgs: one subscription buys one licence. A subscriber may not create a
--     second org on the same plan from the browser (that was N x 10 seats).
--
-- E4. spend_in_window: re-assert the service_role-only grants (see schema-byok.sql).
--
-- Idempotent; safe to re-run.

-- E1 ─────────────────────────────────────────────────────────
drop policy if exists org_invites_update_manager on public.org_invites;
create policy org_invites_update_manager
  on public.org_invites for update
  using (public.is_org_manager(org_id))
  with check (public.is_org_manager(org_id));

create or replace function public.org_invites_lock_identity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    if new.org_id     is distinct from old.org_id
    or new.email      is distinct from old.email
    or new.role       is distinct from old.role
    or new.token_hash is distinct from old.token_hash
    or new.expires_at is distinct from old.expires_at
    or (old.accepted_at is not null and new.accepted_at is distinct from old.accepted_at) then
      raise exception 'an invitation cannot be retargeted, extended or revived; send a new one'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.org_invites_lock_identity() from public, anon, authenticated;

drop trigger if exists org_invites_lock_identity on public.org_invites;
create trigger org_invites_lock_identity
  before update on public.org_invites
  for each row execute function public.org_invites_lock_identity();

-- E2 ─────────────────────────────────────────────────────────
create or replace function public.org_members_enforce_seat_cap()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total integer;
  v_used  integer;
begin
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.status not in ('active', 'invited') then
    return new;
  end if;
  -- An update that neither takes a new seat nor moves the row between orgs
  -- (e.g. a role change in an org that is already full) must keep working.
  if tg_op = 'UPDATE'
     and old.status in ('active', 'invited')
     and old.org_id = new.org_id then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.org_id::text, 0));

  select o.seats_total into v_total from public.orgs o where o.id = new.org_id;
  if v_total is null then
    return new; -- unlimited (University) or the org does not exist (FK reports it)
  end if;

  select count(*) into v_used
    from public.org_members m
   where m.org_id = new.org_id
     and m.status in ('active', 'invited')
     and m.id is distinct from new.id;

  if v_used >= v_total then
    raise exception 'all % seats of this organisation are in use', v_total
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.org_members_enforce_seat_cap() from public, anon, authenticated;

drop trigger if exists org_members_enforce_seat_cap on public.org_members;
create trigger org_members_enforce_seat_cap
  before insert or update of status, org_id on public.org_members
  for each row execute function public.org_members_enforce_seat_cap();

-- E3 ─────────────────────────────────────────────────────────
drop policy if exists orgs_insert_owner on public.orgs;
create policy orgs_insert_owner
  on public.orgs for insert
  with check (
    owner_id = auth.uid()
    and exists (
      select 1
        from public.subscriptions s
       where s.user_id = auth.uid()
         and s.plan_id = orgs.plan_id
         and s.status in ('active', 'trialing', 'past_due')
    )
    and (
      (orgs.plan_id = 'team' and orgs.seats_total = 10)
      or (orgs.plan_id = 'edu')
    )
    and not exists (
      select 1
        from public.orgs o2
       where o2.owner_id = auth.uid()
         and o2.plan_id = orgs.plan_id
    )
  );

-- E4 ─────────────────────────────────────────────────────────
-- A project that migrated before schema-byok.sql was fixed still has
-- spend_in_window callable by anon. Guarded so the file stays runnable on a
-- project without the function.
do $$
begin
  if to_regprocedure('public.spend_in_window(uuid, timestamptz)') is not null then
    revoke all on function public.spend_in_window(uuid, timestamptz) from public;
    revoke all on function public.spend_in_window(uuid, timestamptz) from anon;
    revoke all on function public.spend_in_window(uuid, timestamptz) from authenticated;
    grant execute on function public.spend_in_window(uuid, timestamptz) to service_role;
  end if;
end
$$;
