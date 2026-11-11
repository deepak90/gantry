-- Sessions on the hosted demo, as visitors see them: each copy of Harbor a visitor holds (20261110120200_copy_pool.sql)
-- has a 6-digit code to join it by, beside the invite link, and the people in it take names from a list instead of
-- the two seed personas and "Guest N".
--
--   copy_seat_names()   the list: 30 easy-to-say first and last names; Remy
--                       says them aloud. apps/web/src/copy/names.ts holds the same list (a test keeps them the same).
--   copy_pool.join_code a claimed copy's code, 6 digits, unique among the copies: made when the copy gets its invite
--                       token, gone when the token is (free_copy), so a code dies with its session
--   copy_code_misses    each code someone tried that matched no open session, kept 10 minutes; only
--                       join_copy_by_code writes it
--   claim_copy          takes an optional name; answers with the code and the name too
--   join_copy           the same, for the invite token
--   join_copy_by_code   joins with the code: 8 wrong codes per person in 10 minutes, and 100 for everyone, then it
--                       says to wait (the anonymous sign-in before it needs Cloudflare's human check)
--   copy_names_taken    the names in use in the session an invite token is for, so the welcome screen suggests a
--                       free one before the visitor has signed in
--   touch_copy          also answers with the code, for a tab that remembered the session before codes existed
--
-- A name a person asks for is theirs when it is on the list and nobody in the session has it; otherwise they keep the
-- name they had, when that is on the list and free there, or get a free one. No one types a name: clients can no
-- longer change their profile's name, and a profile's color must be a hex color.

-- The names --------------------------------------------------------------------------------------------------

create or replace function public.copy_seat_names()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'Riley Brooks', 'Jordan Ellis', 'Avery Patel', 'Morgan Reyes', 'Casey Nguyen', 'Taylor Brennan',
    'Quinn Delgado', 'Rowan Hughes', 'Parker Dunn', 'Emerson Cole', 'Jamie Holt', 'Cameron Shaw',
    'Drew Okafor', 'Sage Whitaker', 'Kendall Price', 'Reese Carter', 'Alex Whitfield', 'Jesse Navarro',
    'Elliot Kim', 'Finley Ward', 'Peyton Garcia', 'Skyler Hart', 'Dakota Lin', 'Blake Mensah',
    'Charlie Lane', 'Kai Larsen', 'Harper Nolan', 'Rory Castillo', 'Devon Park', 'Sasha Moreau'
  ]::text[]
$$;

-- Tables -------------------------------------------------------------------------------------------------------

alter table public.copy_pool add column if not exists join_code text check (join_code ~ '^[0-9]{6}$');
create unique index if not exists copy_pool_join_code_key on public.copy_pool (join_code);

-- Nobody in a session shares a name.
create unique index if not exists copy_seats_name_key on public.copy_seats (project_id, display_name);

create table if not exists public.copy_code_misses (
  id        bigint generated always as identity primary key,
  user_id   uuid not null references auth.users (id) on delete cascade,
  missed_at timestamptz not null default now()
);
create index if not exists copy_code_misses_user_idx on public.copy_code_misses (user_id, missed_at);
create index if not exists copy_code_misses_missed_at_idx on public.copy_code_misses (missed_at);
alter table public.copy_code_misses enable row level security;
revoke all on table public.copy_code_misses from anon, authenticated;

-- The code follows the invite token ----------------------------------------------------------------------------

-- A code no copy has, 100000 to 999999 (no leading zero to lose when someone types it as a number), from
-- pgcrypto's random bytes. No lock: claims at the same moment never wait for each other (21_copy_pool.sql checks
-- it). Two of them drawing the same code, about one chance in 900,000, is caught by the unique index, and
-- claim_copy draws again.
create or replace function public.new_join_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_code text;
begin
  loop
    v_code := (100000 + (('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 900000))::text;
    exit when not exists (select 1 from public.copy_pool c where c.join_code = v_code);
  end loop;
  return v_code;
end;
$$;

-- A copy that gets a new invite token (claim_copy) gets a new code; one whose token goes (free_copy) loses it.
create or replace function public.copy_pool_join_code()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.join_token is null then
    new.join_code := null;
  elsif tg_op = 'INSERT' or new.join_token is distinct from old.join_token or new.join_code is null then
    new.join_code := public.new_join_code();
  end if;
  return new;
end;
$$;

drop trigger if exists copy_pool_join_code on public.copy_pool;
create trigger copy_pool_join_code
  before insert or update of join_token, join_code on public.copy_pool
  for each row execute function public.copy_pool_join_code();

-- The copies held right now get their code; then a claimed copy always has one, and a free copy never.
update public.copy_pool set join_code = public.new_join_code() where join_token is not null and join_code is null;
alter table public.copy_pool drop constraint if exists copy_pool_free_or_claimed;
alter table public.copy_pool add constraint copy_pool_free_or_claimed check (
  (holder is null and join_token is null and join_code is null and claimed_at is null and lease_until is null)
  or (join_token is not null and join_code is not null and claimed_at is not null and lease_until is not null));

-- Seats --------------------------------------------------------------------------------------------------------

-- The name a person takes in a copy (see the top). The caller holds the copy's row lock, so two people joining at
-- the same moment never take the same name.
create or replace function public.copy_seat_name(p_project uuid, p_user uuid, p_name text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_names text[] := public.copy_seat_names();
  v_taken text[] := array(select s.display_name from public.copy_seats s where s.project_id = p_project and s.user_id <> p_user);
  v_name  text := btrim(coalesce(p_name, ''));
begin
  if v_name = any (v_names) and not v_name = any (v_taken) then
    return v_name;
  end if;
  select p.display_name into v_name from public.profiles p where p.user_id = p_user;
  if v_name = any (v_names) and not v_name = any (v_taken) then
    return v_name;
  end if;
  -- 30 names and five seats: one is always free.
  return (select n from unnest(v_names) n where not n = any (v_taken) order by random() limit 1);
end;
$$;

-- Seats a person in a copy: a member of the project, with the seat's color and a name from the list. Everyone sees
-- costs and approves within the same limit as on Harbor (supabase/seed.sql), so a payout over the project's
-- threshold, which needs a second person, can be approved by someone the holder invited. A person has one profile:
-- it takes the seat's name and color, and their seats in other copies take the name too where nobody there has it,
-- so the profile and the seats say the same.
drop function if exists public.seat_in_copy(uuid, uuid, int);
create or replace function public.seat_in_copy(p_project uuid, p_user uuid, p_seat int, p_name text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name  text := public.copy_seat_name(p_project, p_user, p_name);
  v_color text := case p_seat when 1 then '#695086' when 2 then '#2563eb' when 3 then '#0f766e' when 4 then '#b45309' else '#be185d' end;
begin
  insert into public.copy_seats (project_id, user_id, seat, display_name) values (p_project, p_user, p_seat, v_name);
  insert into public.project_members (project_id, user_id, role, can_view_costs, approval_limit_minor)
  values (p_project, p_user, case when p_seat = 1 then 'cm' else 'pm' end, true, 25000000)
  on conflict (project_id, user_id) do update
    set role = excluded.role, can_view_costs = excluded.can_view_costs, approval_limit_minor = excluded.approval_limit_minor;
  insert into public.profiles (user_id, display_name, color) values (p_user, v_name, v_color)
  on conflict (user_id) do update set display_name = excluded.display_name, color = excluded.color;
  -- Best effort: someone joining one of those copies at this very moment under the same name keeps it.
  begin
    update public.copy_seats s
       set display_name = v_name
     where s.user_id = p_user and s.project_id <> p_project and s.display_name <> v_name
       and not exists (select 1 from public.copy_seats o where o.project_id = s.project_id and o.display_name = v_name);
  exception when unique_violation then
    null;
  end;
  return v_name;
end;
$$;

-- What claim_copy and the joins answer: the copy, its invite token and code, its lease, and the caller's name in it.
create or replace function public.copy_answer(p_copy public.copy_pool, p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'project_id', p_copy.project_id,
    'join_token', p_copy.join_token,
    'join_code', p_copy.join_code,
    'lease_until', p_copy.lease_until,
    'display_name', coalesce(
      (select s.display_name from public.copy_seats s where s.project_id = p_copy.project_id and s.user_id = p_user),
      (select p.display_name from public.profiles p where p.user_id = p_user)))
$$;

-- Someone joining a copy whose lease holds (the caller holds its row lock): the next free seat after the holder's,
-- five people at most. Someone already in it (the holder opening their own link, or someone joining twice) is
-- answered as they are.
create or replace function public.join_seat(p_copy public.copy_pool, p_user uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seat int;
begin
  if exists (select 1 from public.project_members m where m.project_id = p_copy.project_id and m.user_id = p_user) then
    return public.copy_answer(p_copy, p_user);
  end if;
  select min(s) into v_seat
    from generate_series(2, p_copy.seats) s
   where not exists (select 1 from public.copy_seats x where x.project_id = p_copy.project_id and x.seat = s);
  if v_seat is null then
    raise exception 'This session already has % people in it.', p_copy.seats
      using errcode = '53300', hint = 'join_seat: every seat is taken';
  end if;
  perform public.seat_in_copy(p_copy.project_id, p_user, v_seat, p_name);
  return public.copy_answer(p_copy, p_user);
end;
$$;

-- claim_copy(p_name) -> {project_id, join_token, join_code, lease_until, display_name} ----------------------------

drop function if exists public.claim_copy();
create or replace function public.claim_copy(p_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.copy_pool;
  v_try int;
begin
  if v_uid is null then
    raise exception 'claim_copy: sign in first' using errcode = '42501';
  end if;
  -- One claim at a time per person: a second press waits for the first, then gets the same copy.
  perform pg_advisory_xact_lock(hashtextextended('claim_copy:' || v_uid::text, 0));

  select c.* into v_row from public.copy_pool c where c.holder = v_uid for update;
  if found then
    if v_row.lease_until > now() then
      return public.copy_answer(v_row, v_uid);
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
    raise exception 'Every session is in use right now. Please try again in a few minutes.'
      using errcode = '53000', hint = 'claim_copy: all copies are in use';
  end if;
  if v_row.claimed_at is not null then
    perform public.free_copy(v_row.project_id);
  end if;

  -- The new token brings a new code with it (copy_pool_join_code). Should another claim at this very moment have
  -- drawn the same code, the unique index refuses this one, and a fresh token draws a fresh code.
  for v_try in 1..3 loop
    begin
      update public.copy_pool
         set holder = v_uid, join_token = encode(extensions.gen_random_bytes(16), 'hex'),
             claimed_at = now(), lease_until = now() + interval '30 minutes', updated_at = now()
       where project_id = v_row.project_id
      returning * into v_row;
      exit;
    exception when unique_violation then
      if v_try = 3 then
        raise;
      end if;
    end;
  end loop;
  perform public.seat_in_copy(v_row.project_id, v_uid, 1, p_name);
  return public.copy_answer(v_row, v_uid);
end;
$$;

-- join_copy(p_token, p_name) -> {project_id, join_token, join_code, lease_until, display_name} --------------------

drop function if exists public.join_copy(text);
create or replace function public.join_copy(p_token text, p_name text default null)
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
    raise exception 'join_copy: sign in first' using errcode = '42501';
  end if;
  if p_token is not null and p_token ~ '^[0-9a-f]{32}$' then
    select c.* into v_row from public.copy_pool c where c.join_token = p_token for update;
  end if;
  -- An unknown token, or one whose copy's lease has run out (a freed copy forgets its token).
  if v_row.project_id is null or v_row.lease_until <= now() then
    raise exception 'This invite link isn’t valid, or the session it was for has ended.'
      using errcode = '22023', hint = 'join_copy: the token is unknown or its lease has run out';
  end if;
  return public.join_seat(v_row, v_uid, p_name);
end;
$$;

-- join_copy_by_code(p_code, p_name) -> the same as join_copy, or {error, message, tries_left} ---------------------

-- A code that matches no open session is answered, not raised, so the miss it records is kept: an error would roll
-- the record back. Too many misses, or a full session, raise as join_copy does. While someone is over the limit,
-- every code is refused, the right one too, so the limit cannot be guessed around.
create or replace function public.join_copy_by_code(p_code text, p_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_code   text := regexp_replace(left(coalesce(p_code, ''), 32), '[[:space:]-]', '', 'g');
  v_since  timestamptz := now() - interval '10 minutes';
  v_misses int;
  v_first  timestamptz;
  v_wait   int;
  v_row    public.copy_pool;
begin
  if v_uid is null then
    raise exception 'join_copy_by_code: sign in first' using errcode = '42501';
  end if;
  -- One try at a time per person, so the count below holds.
  perform pg_advisory_xact_lock(hashtextextended('join_copy_by_code:' || v_uid::text, 0));
  delete from public.copy_code_misses m where m.user_id = v_uid and m.missed_at <= v_since;
  select count(*)::int, min(m.missed_at) into v_misses, v_first from public.copy_code_misses m where m.user_id = v_uid;
  if v_misses >= 8 then
    v_wait := greatest(1, ceil(extract(epoch from (v_first + interval '10 minutes' - now())) / 60)::int);
    raise exception 'Too many wrong codes. Try again in % %, or ask for the invite link.', v_wait, case when v_wait = 1 then 'minute' else 'minutes' end
      using errcode = 'PT429', hint = 'join_copy_by_code: 8 wrong codes in 10 minutes';
  end if;
  if (select count(*) from public.copy_code_misses m where m.missed_at > v_since) >= 100 then
    raise exception 'Joining with a code is paused for a few minutes. Ask for the invite link instead.'
      using errcode = 'PT429', hint = 'join_copy_by_code: 100 wrong codes on the site in 10 minutes';
  end if;

  if v_code ~ '^[0-9]{6}$' then
    select c.* into v_row from public.copy_pool c where c.join_code = v_code and c.lease_until > now() for update;
  end if;
  if v_row.project_id is null then
    insert into public.copy_code_misses (user_id) values (v_uid);
    return jsonb_build_object(
      'error', 'no_match',
      'message', 'That code doesn’t match a session that’s open now.',
      'tries_left', greatest(0, 8 - v_misses - 1));
  end if;
  return public.join_seat(v_row, v_uid, p_name);
end;
$$;

-- copy_names_taken(p_token) -> the names in use in that session --------------------------------------------------

-- For the welcome screen of an invite, before the visitor signs in (so the anon key may call it). The token is the
-- invite itself: whoever has it may join and see these names anyway. Any other token: no names.
create or replace function public.copy_names_taken(p_token text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(s.display_name order by s.seat), '{}'::text[])
    from public.copy_pool c
    join public.copy_seats s on s.project_id = c.project_id
   where p_token ~ '^[0-9a-f]{32}$' and c.join_token = p_token and c.lease_until > now()
$$;

-- touch_copy(p_project) -> {lease_until, join_code} -----------------------------------------------------------------

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
  return jsonb_build_object('lease_until', v_row.lease_until, 'join_code', v_row.join_code);
end;
$$;

-- Profiles: names from the list only -------------------------------------------------------------------------------

-- A person's name comes from their sign-up or their seat, never from what a client writes; colors stay a client's
-- to change, as hex colors only (checked from now on: rows already there are left as they are).
revoke update (display_name) on table public.profiles from authenticated;
alter table public.profiles drop constraint if exists profiles_color_hex;
alter table public.profiles add constraint profiles_color_hex check (color ~ '^#[0-9a-fA-F]{6}$') not valid;

-- Who may call what ------------------------------------------------------------------------------------------------

revoke execute on function public.copy_seat_names() from public, anon, authenticated;
revoke execute on function public.new_join_code() from public, anon, authenticated;
revoke execute on function public.copy_pool_join_code() from public, anon, authenticated;
revoke execute on function public.copy_seat_name(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.seat_in_copy(uuid, uuid, int, text) from public, anon, authenticated;
revoke execute on function public.copy_answer(public.copy_pool, uuid) from public, anon, authenticated;
revoke execute on function public.join_seat(public.copy_pool, uuid, text) from public, anon, authenticated;
revoke execute on function public.claim_copy(text) from public, anon;
revoke execute on function public.join_copy(text, text) from public, anon;
revoke execute on function public.join_copy_by_code(text, text) from public, anon;
revoke execute on function public.copy_names_taken(text) from public;
revoke execute on function public.touch_copy(uuid) from public, anon;
grant execute on function public.claim_copy(text) to authenticated, service_role;
grant execute on function public.join_copy(text, text) to authenticated, service_role;
grant execute on function public.join_copy_by_code(text, text) to authenticated, service_role;
grant execute on function public.copy_names_taken(text) to anon, authenticated, service_role;
grant execute on function public.touch_copy(uuid) to authenticated, service_role;

-- Misses older than the 10 minutes they count for go every 10 minutes (pg_cron, where it is; join_copy_by_code
-- removes a person's own as they try again anyway).
do $$
begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron is not here: copy_code_misses is cleared by join_copy_by_code alone';
    return;
  end if;
  perform cron.schedule('clear-code-misses', '*/10 * * * *', $job$delete from public.copy_code_misses where missed_at <= now() - interval '10 minutes'$job$);
exception when others then
  raise notice 'pg_cron could not schedule clearing copy_code_misses: %', sqlerrm;
end;
$$;

notify pgrst, 'reload schema';
