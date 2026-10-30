-- Audit 2026-10-22 (supabase-rls). For projects that already ran migrations 1-15.
-- Same SQL as Part E of schema-hardening.sql; every statement is idempotent.

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
