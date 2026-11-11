-- The hosted demo's pool of private copies of Harbor Street Offices. Each visitor gets a copy of their own for the
-- visit, with the people they invite, and it is reset and freed when they leave.
--
--   projects.template  the demo a project plays: 'harbor' (Harbor and its copies), 'cedar'; null for any other
--                      project. The app opens a demo on the plan alone, with its steps, whether or not the menu
--                      offers it.
--   copy_pool          one row per copy (the seed adds them): who holds it, the invite token, when it was claimed,
--                      until when it is held (the lease), how many people it takes (seats), when it was last freed
--   copy_seats         who took which seat: the holder (seat 1, as Deepak Jayaram), the first person invited
--                      (seat 2, as Chris Hale), then guests (seat 3 is Guest 2, up to seat 5)
--   claim_copy         a visitor takes a free copy for 30 minutes, or gets back the one they hold
--   join_copy          someone the holder invited joins with the invite token, while the lease holds
--   touch_copy         someone in the copy keeps it: 30 more minutes from now, at most 2 hours after the claim
--   release_copy       the holder gives it back: reset, the people removed, free for the next visitor
--   sweep_copies       every 10 minutes (pg_cron): the copies whose lease ran out are reset and freed
--
-- Clients never read or write the two tables; the functions return what they need.

alter table public.projects
  add column template text check (template ~ '^[a-z][a-z0-9_-]{0,31}$');

-- Tables -------------------------------------------------------------------------------------------------------

create table public.copy_pool (
  project_id  uuid primary key references public.projects (id) on delete cascade,
  holder      uuid references auth.users (id) on delete set null,
  join_token  text unique check (join_token ~ '^[0-9a-f]{32}$'),
  claimed_at  timestamptz,
  lease_until timestamptz,
  seats       int not null default 5 check (seats between 1 and 5),
  freed_at    timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Free (nothing set) or claimed (token, claim and lease set). A claimed copy keeps its claim when the holder's
  -- account is deleted; the sweep frees it when the lease runs out.
  constraint copy_pool_free_or_claimed check (
    (holder is null and join_token is null and claimed_at is null and lease_until is null)
    or (join_token is not null and claimed_at is not null and lease_until is not null)),
  constraint copy_pool_lease_cap check (lease_until <= claimed_at + interval '2 hours')
);
-- One copy per person at a time.
create unique index copy_pool_one_per_holder on public.copy_pool (holder) where holder is not null;

create table public.copy_seats (
  project_id   uuid not null references public.copy_pool (project_id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  seat         int not null check (seat between 1 and 5),
  display_name text not null check (length(display_name) between 1 and 60),
  joined_at    timestamptz not null default now(),
  primary key (project_id, user_id),
  unique (project_id, seat)
);
create index copy_seats_user_id_idx on public.copy_seats (user_id);

alter table public.copy_pool enable row level security;
alter table public.copy_seats enable row level security;
revoke all on table public.copy_pool, public.copy_seats from anon, authenticated;

-- Helpers ------------------------------------------------------------------------------------------------------

-- Seats a person in a copy as the persona of the seat: a member of the project, and the name and color the others
-- see. Everyone sees costs and approves within the same limit as on Harbor (supabase/seed.sql), so a payout over
-- the project's threshold, which needs a second person, can be approved by someone the holder invited. A person
-- has one profile, so the last seat they took names them.
create or replace function public.seat_in_copy(p_project uuid, p_user uuid, p_seat int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name  text := case p_seat when 1 then 'Deepak Jayaram' when 2 then 'Chris Hale' else 'Guest ' || (p_seat - 1) end;
  v_color text := case p_seat when 1 then '#695086' when 2 then '#2563eb' when 3 then '#0f766e' when 4 then '#b45309' else '#be185d' end;
begin
  insert into public.copy_seats (project_id, user_id, seat, display_name) values (p_project, p_user, p_seat, v_name);
  insert into public.project_members (project_id, user_id, role, can_view_costs, approval_limit_minor)
  values (p_project, p_user, case when p_seat = 1 then 'cm' else 'pm' end, true, 25000000)
  on conflict (project_id, user_id) do update
    set role = excluded.role, can_view_costs = excluded.can_view_costs, approval_limit_minor = excluded.approval_limit_minor;
  insert into public.profiles (user_id, display_name, color) values (p_user, v_name, v_color)
  on conflict (user_id) do update set display_name = excluded.display_name, color = excluded.color;
end;
$$;
revoke execute on function public.seat_in_copy(uuid, uuid, int) from public, anon, authenticated;

-- Puts a copy back as seeded and frees it. The caller holds the copy's row lock. What reset_demo restores (a
-- payment PayPal is still processing is abandoned), and also what a visit leaves behind that reset_demo does not
-- clear: the files no document refers to any more, the payout approvals (their trigger only fires when the plan
-- goes back from a later revision), the copy's quota counts, and the people (everyone who took a seat, and any
-- anonymous member).
create or replace function public.free_copy(p_project uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reset jsonb := public.reset_demo_abandoning_payments(p_project);
begin
  -- Abandoning payments was for this reset only, not for the rest of the transaction.
  perform set_config('collab.abandon_payments', '', true);
  -- The visit's files are removed here, as SQL has no Storage API, so the next visitor of the copy cannot list
  -- them. Storage refuses deleting its rows from SQL unless asked to for this transaction.
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects o
   where o.bucket_id = 'documents'
     and o.name in (select jsonb_array_elements_text(coalesce(v_reset -> 'document_objects', '[]'::jsonb)));
  perform set_config('storage.allow_delete_query', 'false', true);

  delete from public.pay_gate_approvals where project_id = p_project;
  delete from public.quota_usage where project_id = p_project;
  delete from public.project_members m
   where m.project_id = p_project
     and (exists (select 1 from public.copy_seats s where s.project_id = p_project and s.user_id = m.user_id)
          or exists (select 1 from auth.users u where u.id = m.user_id and u.is_anonymous));
  delete from public.copy_seats where project_id = p_project;
  update public.copy_pool
     set holder = null, join_token = null, claimed_at = null, lease_until = null, freed_at = now(), updated_at = now()
   where project_id = p_project;
end;
$$;
revoke execute on function public.free_copy(uuid) from public, anon, authenticated;

-- claim_copy -> {project_id, join_token, lease_until} ----------------------------------------------------------

create or replace function public.claim_copy()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.copy_pool;
begin
  if v_uid is null then
    raise exception 'claim_copy: sign in first' using errcode = '42501';
  end if;
  -- One claim at a time per person: a second press waits for the first, then gets the same copy.
  perform pg_advisory_xact_lock(hashtextextended('claim_copy:' || v_uid::text, 0));

  select c.* into v_row from public.copy_pool c where c.holder = v_uid for update;
  if found then
    if v_row.lease_until > now() then
      return jsonb_build_object('project_id', v_row.project_id, 'join_token', v_row.join_token, 'lease_until', v_row.lease_until);
    end if;
    -- Their time ran out before the sweep came by: that visit is over, and this one starts on a fresh copy.
    perform public.free_copy(v_row.project_id);
  end if;

  -- A free copy (the one free the longest first), else one whose lease ran out, reset first; never a copy another
  -- claim is taking at this moment.
  select c.* into v_row
    from public.copy_pool c
   where c.claimed_at is null or c.lease_until <= now()
   order by c.claimed_at is not null, c.lease_until, c.freed_at nulls first, c.project_id
   limit 1
   for update skip locked;
  if not found then
    raise exception 'All copies of the demo are in use right now. Please try again in a few minutes.'
      using errcode = '53000', hint = 'claim_copy: all copies are in use';
  end if;
  if v_row.claimed_at is not null then
    perform public.free_copy(v_row.project_id);
  end if;

  update public.copy_pool
     set holder = v_uid, join_token = encode(extensions.gen_random_bytes(16), 'hex'),
         claimed_at = now(), lease_until = now() + interval '30 minutes', updated_at = now()
   where project_id = v_row.project_id
  returning * into v_row;
  perform public.seat_in_copy(v_row.project_id, v_uid, 1);
  return jsonb_build_object('project_id', v_row.project_id, 'join_token', v_row.join_token, 'lease_until', v_row.lease_until);
end;
$$;

-- join_copy(p_token) -> {project_id} ----------------------------------------------------------------------------

create or replace function public.join_copy(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_row  public.copy_pool;
  v_seat int;
begin
  if v_uid is null then
    raise exception 'join_copy: sign in first' using errcode = '42501';
  end if;
  if p_token is not null and p_token ~ '^[0-9a-f]{32}$' then
    select c.* into v_row from public.copy_pool c where c.join_token = p_token for update;
  end if;
  -- An unknown token, or one whose copy's lease has run out (a freed copy forgets its token).
  if v_row.project_id is null or v_row.lease_until <= now() then
    raise exception 'This invite link has expired or is not valid.'
      using errcode = '22023', hint = 'join_copy: the token is unknown or its lease has run out';
  end if;

  -- Already in it: the holder opening their own link, or someone joining a second time.
  if exists (select 1 from public.project_members m where m.project_id = v_row.project_id and m.user_id = v_uid) then
    return jsonb_build_object('project_id', v_row.project_id);
  end if;

  select min(s) into v_seat
    from generate_series(2, v_row.seats) s
   where not exists (select 1 from public.copy_seats x where x.project_id = v_row.project_id and x.seat = s);
  if v_seat is null then
    raise exception 'This project already has % people in it.', v_row.seats
      using errcode = '53300', hint = 'join_copy: every seat is taken';
  end if;
  perform public.seat_in_copy(v_row.project_id, v_uid, v_seat);
  return jsonb_build_object('project_id', v_row.project_id);
end;
$$;

-- touch_copy(p_project) -> {lease_until} -----------------------------------------------------------------------

create or replace function public.touch_copy(p_project uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.copy_pool;
begin
  if v_uid is null then
    raise exception 'touch_copy: sign in first' using errcode = '42501';
  end if;
  select c.* into v_row from public.copy_pool c where c.project_id = p_project for update;
  if not found then
    raise exception 'touch_copy: % is not a copy of the demo', p_project using errcode = '22023';
  end if;
  if not exists (select 1 from public.project_members m where m.project_id = p_project and m.user_id = v_uid) then
    raise exception 'touch_copy: only the people in this copy can keep it' using errcode = '42501';
  end if;
  if v_row.claimed_at is null then
    raise exception 'touch_copy: nobody holds this copy' using errcode = '55000';
  end if;
  -- Never shorter than it is; a lease that ran out comes back if the sweep has not reset the copy yet.
  update public.copy_pool
     set lease_until = greatest(lease_until, least(now() + interval '30 minutes', claimed_at + interval '2 hours')),
         updated_at = now()
   where project_id = p_project
  returning * into v_row;
  return jsonb_build_object('lease_until', v_row.lease_until);
end;
$$;

-- release_copy(p_project) ---------------------------------------------------------------------------------------

create or replace function public.release_copy(p_project uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.copy_pool;
begin
  if v_uid is null then
    raise exception 'release_copy: sign in first' using errcode = '42501';
  end if;
  select c.* into v_row from public.copy_pool c where c.project_id = p_project for update;
  if not found then
    raise exception 'release_copy: % is not a copy of the demo', p_project using errcode = '22023';
  end if;
  if v_row.holder is distinct from v_uid then
    raise exception 'release_copy: only the person who holds this copy can give it back' using errcode = '42501';
  end if;
  perform public.free_copy(p_project);
end;
$$;

-- sweep_copies() -> how many copies it freed ------------------------------------------------------------------

create or replace function public.sweep_copies()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_count   int := 0;
begin
  for v_project in
    select c.project_id from public.copy_pool c
     where c.claimed_at is not null and c.lease_until <= now()
     order by c.lease_until
     for update skip locked
  loop
    begin
      perform public.free_copy(v_project);
      v_count := v_count + 1;
    exception when others then
      -- A copy that cannot be reset must not keep the others from being freed; the next sweep tries it again.
      raise warning 'sweep_copies: copy % was not reset: %', v_project, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;

revoke execute on function public.claim_copy() from public, anon;
revoke execute on function public.join_copy(text) from public, anon;
revoke execute on function public.touch_copy(uuid) from public, anon;
revoke execute on function public.release_copy(uuid) from public, anon;
revoke execute on function public.sweep_copies() from public, anon, authenticated;
grant execute on function public.claim_copy() to authenticated, service_role;
grant execute on function public.join_copy(text) to authenticated, service_role;
grant execute on function public.touch_copy(uuid) to authenticated, service_role;
grant execute on function public.release_copy(uuid) to authenticated, service_role;
grant execute on function public.sweep_copies() to service_role;

-- The sweep, every 10 minutes. A database without pg_cron (some local setups) still takes this migration; the
-- sweep then has to be run some other way, and claim_copy reuses copies whose lease ran out in the meantime.
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available: sweep_copies() is not scheduled';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    perform cron.schedule('sweep-copies', '*/10 * * * *', 'select public.sweep_copies()');
  exception when others then
    raise notice 'pg_cron could not schedule sweep_copies(): %', sqlerrm;
  end;
end;
$$;
