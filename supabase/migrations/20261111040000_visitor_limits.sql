-- Limits per person and per network on the hosted demo. A copy that is reset brings its quotas back
-- (20261110120200_copy_pool.sql), so one visitor must not be able to start session after session, hold every copy,
-- guess codes for the whole site, or keep the assistant busy. A "person" is a sign-in (auth.uid()), anonymous ones
-- included; a "network" is the address the visitor's requests come from.
--
--   visitor_address(text)  an address to count a visitor by: none for anything that is not a public address (a
--                          private network or this machine: the local stack and tests, where everyone shares one);
--                          IPv6 counted by its /64, the block one subscriber gets
--   request_ip()           the visitor's address as the API saw it (see below); none for the service role, whose
--                          address is its own server's
--   visitor_events         one row per costly step a visitor took (claim, join, message, ...): which person, from
--                          which network, in which copy, when; kept 2 days
--   visitor_limits         how many of each step a person and a network may take, and in what time: one row per kind,
--                          so a limit can be changed in place (null: no limit of that kind)
--   rate_gate()            checks one step against its limits and records it, or refuses with PT429 in plain words
--                          saying when it can be taken again (DETAIL: {"retry_after": seconds}); the services call it
--                          too, with the service role and the visitor's address
--   copy_claims            who has had their session: one claim per sign-in, ever. Re-opening the session one holds is
--                          not a claim. A new session is a new anonymous sign-in, so a fresh Cloudflare check (Supabase
--                          Auth checks the token on each anonymous sign-in).
--   claim_copy             also, per network: 2 minutes between claims, 5 an hour, 15 a day, 2 sessions held at once
--   join_copy, join_copy_by_code   3 joins an hour per person, 10 per network (opening a session one is already in
--                          is not a join)
--   join_copy_by_code      wrong codes: 8 per person in 10 minutes as before, and 20 an hour per network instead of
--                          100 for the whole site, which anyone could use to pause codes for everyone
--   post_agent_message     10 a minute per person, 60 an hour per network
--   quota_limits           lower: Remy's turns, calls, payouts and invoices; and call_join, for every call token
--   delete_idle_visitors() anonymous sign-ins older than a day that hold no copy and sit in no open one
--   pg_cron                visitor events after 2 days, wrong codes after an hour, idle visitors every hour
--
-- Which address to trust. PostgREST passes the request's headers to the database (request.headers). Locally, Kong
-- appends the caller's address to X-Forwarded-For and passes through anything the client sent, so its first entry
-- is whatever the client wrote. On the hosted project the API sits behind Cloudflare, which sets CF-Connecting-IP to
-- the address that connected to it and appends that address to X-Forwarded-For, after whatever the client sent. So:
-- CF-Connecting-IP first, as a client cannot choose it there; else the last X-Forwarded-For entry, the one the
-- nearest proxy wrote; never the first. A client can still send its own CF-Connecting-IP to the local stack, which
-- is how tests and local checks pretend to be a visitor.
--
-- Safe to apply again: tables, columns and rows are added only where missing, functions are replaced, the quotas
-- are set to the numbers below, and the schedules are replaced.

-- Addresses -----------------------------------------------------------------------------------------------------

create or replace function public.visitor_address(p_text text)
returns inet
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ip inet;
begin
  begin
    v_ip := nullif(btrim(coalesce(p_text, '')), '')::inet;
  exception when others then
    return null;
  end;
  if v_ip is null then
    return null;
  end if;
  if family(v_ip) = 6 then
    -- An IPv4 address written the IPv6 way counts as itself.
    if v_ip <<= '::ffff:0.0.0.0/96'::inet then
      return public.visitor_address(substring(host(v_ip) from '[0-9.]+$'));
    end if;
    if v_ip <<= any (array['::/127', 'fc00::/7', 'fe80::/10']::inet[]) then
      return null;
    end if;
    return network(set_masklen(v_ip, 64))::inet;
  end if;
  v_ip := host(v_ip)::inet;
  if v_ip <<= any (array['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
                         '192.168.0.0/16']::inet[]) then
    return null;
  end if;
  return v_ip;
end;
$$;

create or replace function public.request_ip()
returns inet
language plpgsql
stable
set search_path = ''
as $$
declare
  v_claims  jsonb;
  v_headers jsonb;
begin
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    return null;
  end;
  if v_claims ->> 'role' = 'service_role' then
    return null;
  end if;
  return coalesce(
    public.visitor_address(v_headers ->> 'cf-connecting-ip'),
    public.visitor_address(regexp_replace(coalesce(v_headers ->> 'x-forwarded-for', ''), '^.*,', '')));
end;
$$;

-- What a visitor did, and the limits ----------------------------------------------------------------------------

create table if not exists public.visitor_events (
  id         bigint generated always as identity primary key,
  kind       text not null check (kind ~ '^[a-z][a-z0-9_]{0,62}$'),
  user_id    uuid,
  ip         inet,
  project_id uuid,
  at         timestamptz not null default now(),
  constraint visitor_events_someone check (user_id is not null or ip is not null)
);
create index if not exists visitor_events_by_user on public.visitor_events (kind, user_id, at desc) where user_id is not null;
create index if not exists visitor_events_by_ip on public.visitor_events (kind, ip, at desc) where ip is not null;
create index if not exists visitor_events_at on public.visitor_events (at);

create table if not exists public.visitor_limits (
  kind        text primary key check (kind ~ '^[a-z][a-z0-9_]{0,62}$'),
  user_max    int check (user_max >= 0),
  user_window interval check (user_window > interval '0'),
  ip_max      int check (ip_max >= 0),
  ip_window   interval check (ip_window > interval '0'),
  note        text check (length(note) <= 500)
);

alter table public.visitor_events enable row level security;
alter table public.visitor_limits enable row level security;
revoke all on table public.visitor_events, public.visitor_limits from anon, authenticated;

-- A limit needs its number and its window; claim_held needs the number alone.
insert into public.visitor_limits (kind, user_max, user_window, ip_max, ip_window, note) values
  ('claim_gap', null, null, 1, interval '2 minutes', 'Sessions started from one network: one every 2 minutes.'),
  ('claim_hour', null, null, 5, interval '1 hour', 'Sessions started from one network in an hour.'),
  ('claim_day', null, null, 15, interval '24 hours', 'Sessions started from one network in a day.'),
  ('claim_held', null, null, 2, null, 'Sessions held at once by people on one network.'),
  ('join', 3, interval '1 hour', 10, interval '1 hour', 'Sessions joined, by link or code, per person and per network.'),
  ('code_miss', 8, interval '10 minutes', 20, interval '1 hour', 'Wrong session codes, per person and per network.'),
  ('message', 10, interval '1 minute', 60, interval '1 hour', 'Messages to Remy, per person and per network.')
on conflict (kind) do nothing;

-- One kind's limits; all null when it has no row.
create or replace function public.visitor_limit(p_kind text)
returns public.visitor_limits
language sql
stable
security definer
set search_path = ''
as $$
  select l.* from public.visitor_limits l where l.kind = p_kind
$$;

-- "in 40 seconds", "in 2 minutes", "in 3 hours": how long until something is possible again, rounded up.
create or replace function public.wait_words(p_seconds numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when w.s < 60 then 'in ' || w.s || case when w.s = 1 then ' second' else ' seconds' end
    when w.s <= 5400 then 'in ' || ceil(w.s / 60.0)::int || case when ceil(w.s / 60.0) = 1 then ' minute' else ' minutes' end
    else 'in ' || ceil(w.s / 3600.0)::int || ' hours'
  end
  from (select greatest(1, ceil(coalesce(p_seconds, 0)))::int as s) w
$$;

-- What a refusal says, by the kind of step.
create or replace function public.rate_gate_words(p_kind text, p_seconds numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    when 'join' then 'Too many sessions joined for now. You can join one again ' || public.wait_words(p_seconds) || '.'
    when 'message' then 'Too many messages for now. You can write to Remy again ' || public.wait_words(p_seconds) || '.'
    else 'Too many tries for now. You can try again ' || public.wait_words(p_seconds) || '.'
  end
$$;

-- rate_gate: one step of p_kind by p_user from p_ip. Refused (PT429, nothing recorded) when the person has taken
-- p_user_max of them in p_user_window, or the network p_ip_max in p_ip_window; the refusal says when the next one
-- fits. Otherwise the step is recorded and counts from now. A limit left null is no limit; an address that is not
-- a public one (visitor_address) is no address, so only the person's limit holds; with neither a person nor an
-- address there is nothing to count.
create or replace function public.rate_gate(
  p_kind text, p_user uuid, p_ip inet, p_user_max int, p_user_window interval, p_ip_max int, p_ip_window interval,
  p_project uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ip    inet := public.visitor_address(host(p_ip));
  v_at    timestamptz;
  v_secs  numeric := 0;
  v_scope text;
begin
  if p_kind is null or p_kind !~ '^[a-z][a-z0-9_]{0,62}$' then
    raise exception 'rate_gate: % is not a kind of step', coalesce(p_kind, 'null') using errcode = '22023';
  end if;
  if p_user is null and v_ip is null then
    return;
  end if;
  -- One step at a time per person and per network, so a count and the step it lets through stay together: always
  -- the person's lock first, so two steps never wait on each other the opposite way round.
  if p_user is not null then
    perform pg_advisory_xact_lock(hashtextextended('rate_gate:' || p_kind || ':user:' || p_user::text, 0));
  end if;
  if v_ip is not null then
    perform pg_advisory_xact_lock(hashtextextended('rate_gate:' || p_kind || ':ip:' || v_ip::text, 0));
  end if;

  -- With max steps in the window already, the next fits once the max-th newest has left it.
  if p_user is not null and p_user_max is not null and p_user_window is not null then
    if p_user_max = 0 then
      v_secs := extract(epoch from p_user_window);
      v_scope := 'user';
    else
      select e.at into v_at from public.visitor_events e
       where e.kind = p_kind and e.user_id = p_user and e.at > now() - p_user_window
       order by e.at desc offset p_user_max - 1 limit 1;
      if found then
        v_secs := extract(epoch from (v_at + p_user_window - now()));
        v_scope := 'user';
      end if;
    end if;
  end if;
  if v_ip is not null and p_ip_max is not null and p_ip_window is not null then
    if p_ip_max = 0 then
      if extract(epoch from p_ip_window) > v_secs then
        v_secs := extract(epoch from p_ip_window);
        v_scope := 'ip';
      end if;
    else
      select e.at into v_at from public.visitor_events e
       where e.kind = p_kind and e.ip = v_ip and e.at > now() - p_ip_window
       order by e.at desc offset p_ip_max - 1 limit 1;
      if found and extract(epoch from (v_at + p_ip_window - now())) > v_secs then
        v_secs := extract(epoch from (v_at + p_ip_window - now()));
        v_scope := 'ip';
      end if;
    end if;
  end if;

  if v_scope is not null then
    raise exception '%', public.rate_gate_words(p_kind, v_secs)
      using errcode = 'PT429',
            detail = jsonb_build_object('retry_after', greatest(1, ceil(v_secs))::int, 'kind', p_kind, 'limit', v_scope)::text,
            hint = 'rate_gate: ' || p_kind || ' per ' || case v_scope when 'ip' then 'network' else 'person' end;
  end if;
  insert into public.visitor_events (kind, user_id, ip, project_id) values (p_kind, p_user, v_ip, p_project);
end;
$$;

-- One claim per sign-in ---------------------------------------------------------------------------------------

-- Kept as long as the sign-in is: a claim is for good, while visitor_events are cleared after 2 days.
create table if not exists public.copy_claims (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  ip         inet,
  claimed_at timestamptz not null default now()
);
alter table public.copy_claims enable row level security;
revoke all on table public.copy_claims from anon, authenticated;

-- Whoever holds a copy as this lands has had their claim.
insert into public.copy_claims (user_id, project_id, claimed_at)
select c.holder, c.project_id, c.claimed_at from public.copy_pool c where c.holder is not null
on conflict (user_id) do nothing;

-- claim_wait(p_ip) -> null when one more claim from that network fits now; else {reason, count, retry_after}: the
-- limit that holds it back longest (gap, hour, day or held), how many it counted, and the seconds until it fits.
-- Sessions held at once fit again when the first of them ends, which is its lease's end if nobody keeps it (and
-- sooner if it is given back). The caller holds the network's claim lock.
create or replace function public.claim_wait(p_ip inet)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind  text;
  v_limit public.visitor_limits;
  v_count int;
  v_at    timestamptz;
  v_secs  numeric;
  v_wait  jsonb;
begin
  if p_ip is null then
    return null;
  end if;
  v_limit := public.visitor_limit('claim_held');
  if v_limit.ip_max is not null then
    select count(*)::int, min(c.lease_until) into v_count, v_at
      from public.copy_pool c
      join public.copy_claims k on k.user_id = c.holder and k.project_id = c.project_id
     where c.lease_until > now() and k.ip = p_ip;
    if v_count >= v_limit.ip_max then
      v_secs := coalesce(extract(epoch from (v_at - now())), 3600);
      v_wait := jsonb_build_object('reason', 'held', 'count', v_count, 'retry_after', greatest(1, ceil(v_secs))::int);
    end if;
  end if;
  foreach v_kind in array array['claim_gap', 'claim_hour', 'claim_day'] loop
    v_limit := public.visitor_limit(v_kind);
    continue when v_limit.ip_max is null or v_limit.ip_window is null;
    select count(*)::int into v_count from public.visitor_events e
     where e.kind = 'claim' and e.ip = p_ip and e.at > now() - v_limit.ip_window;
    continue when v_count < v_limit.ip_max;
    if v_limit.ip_max = 0 then
      v_secs := extract(epoch from v_limit.ip_window);
    else
      select e.at into v_at from public.visitor_events e
       where e.kind = 'claim' and e.ip = p_ip and e.at > now() - v_limit.ip_window
       order by e.at desc offset v_limit.ip_max - 1 limit 1;
      v_secs := extract(epoch from (v_at + v_limit.ip_window - now()));
    end if;
    if v_wait is null or greatest(1, ceil(v_secs)) > (v_wait ->> 'retry_after')::int then
      v_wait := jsonb_build_object('reason', substr(v_kind, 7), 'count', v_count, 'retry_after', greatest(1, ceil(v_secs))::int);
    end if;
  end loop;
  return v_wait;
end;
$$;

-- claim_copy(p_name) -> {project_id, join_token, join_code, lease_until, display_name} ----------------------------

create or replace function public.claim_copy(p_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_ip   inet := public.request_ip();
  v_row  public.copy_pool;
  v_try  int;
  v_wait jsonb;
  v_secs numeric;
  v_n    int;
begin
  if v_uid is null then
    raise exception 'claim_copy: sign in first' using errcode = '42501';
  end if;
  -- One claim at a time per person: a second press waits for the first, then gets the same copy.
  perform pg_advisory_xact_lock(hashtextextended('claim_copy:' || v_uid::text, 0));

  -- Re-opening the session they hold is not a new claim.
  select c.* into v_row from public.copy_pool c where c.holder = v_uid and c.lease_until > now() for update;
  if found then
    return public.copy_answer(v_row, v_uid);
  end if;
  -- One claim per sign-in, ever, also once that session has ended: the next one is a new sign-in.
  if exists (select 1 from public.copy_claims k where k.user_id = v_uid) then
    raise exception 'You’ve already started a session from this page. Reload the page to start a new one.'
      using errcode = 'PT403', hint = 'claim_copy: one session per sign-in';
  end if;

  -- Per network, one claim at a time, so two at the same moment are counted one after the other.
  if v_ip is not null then
    perform pg_advisory_xact_lock(hashtextextended('claim_copy:ip:' || v_ip::text, 0));
    v_wait := public.claim_wait(v_ip);
    if v_wait is not null then
      v_secs := (v_wait ->> 'retry_after')::numeric;
      v_n := (v_wait ->> 'count')::int;
      raise exception '%', case v_wait ->> 'reason'
          when 'held' then format('Your network already has %s open. You can start a new one %s, or as soon as one of them ends.',
                                  v_n || case when v_n = 1 then ' session' else ' sessions' end, public.wait_words(v_secs))
          when 'gap' then format('A session was just started on your network. You can start a new session %s.', public.wait_words(v_secs))
          when 'hour' then format('Your network has started %s in the last hour. You can start a new session %s.',
                                  v_n || case when v_n = 1 then ' session' else ' sessions' end, public.wait_words(v_secs))
          else format('Your network has started %s in the last 24 hours. You can start a new session %s.',
                      v_n || case when v_n = 1 then ' session' else ' sessions' end, public.wait_words(v_secs))
        end
        using errcode = 'PT429', detail = v_wait::text, hint = 'claim_copy: ' || (v_wait ->> 'reason');
    end if;
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
  insert into public.copy_claims (user_id, project_id, ip) values (v_uid, v_row.project_id, v_ip);
  insert into public.visitor_events (kind, user_id, ip, project_id) values ('claim', v_uid, v_ip, v_row.project_id);
  return public.copy_answer(v_row, v_uid);
end;
$$;

-- Joining: a seat taken counts ---------------------------------------------------------------------------------

-- As in 20261111010000_session_codes_and_names.sql, and a new seat counts as a join (visitor_limits 'join'). Someone
-- already in the session is answered as they are, counting nothing; a full session counts nothing either.
create or replace function public.join_seat(p_copy public.copy_pool, p_user uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seat  int;
  v_limit public.visitor_limits := public.visitor_limit('join');
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
  perform public.rate_gate('join', p_user, public.request_ip(), v_limit.user_max, v_limit.user_window,
                           v_limit.ip_max, v_limit.ip_window, p_copy.project_id);
  perform public.seat_in_copy(p_copy.project_id, p_user, v_seat, p_name);
  return public.copy_answer(p_copy, p_user);
end;
$$;

-- Wrong codes: per person and per network ----------------------------------------------------------------------

alter table public.copy_code_misses add column if not exists ip inet;
create index if not exists copy_code_misses_ip_idx on public.copy_code_misses (ip, missed_at) where ip is not null;

-- join_copy_by_code(p_code, p_name) -> the same as join_copy, or {error, message, tries_left} ----------------------

-- As before, with the limits from visitor_limits 'code_miss': the person's (8 in 10 minutes) and the network's (20 in
-- an hour) in place of the site's. Misses are kept for the network's hour (pg_cron clears them after it).
create or replace function public.join_copy_by_code(p_code text, p_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_ip     inet := public.request_ip();
  v_code   text := regexp_replace(left(coalesce(p_code, ''), 32), '[[:space:]-]', '', 'g');
  v_limit  public.visitor_limits := public.visitor_limit('code_miss');
  v_misses int := 0;
  v_at     timestamptz;
  v_wait   int;
  v_row    public.copy_pool;
begin
  if v_uid is null then
    raise exception 'join_copy_by_code: sign in first' using errcode = '42501';
  end if;
  -- One try at a time per person and per network, so the counts below hold.
  perform pg_advisory_xact_lock(hashtextextended('join_copy_by_code:' || v_uid::text, 0));
  if v_ip is not null then
    perform pg_advisory_xact_lock(hashtextextended('join_copy_by_code:ip:' || v_ip::text, 0));
  end if;
  if v_limit.user_max is not null and v_limit.user_window is not null then
    select count(*)::int, min(m.missed_at) into v_misses, v_at
      from public.copy_code_misses m
     where m.user_id = v_uid and m.missed_at > now() - v_limit.user_window;
    if v_misses >= v_limit.user_max then
      v_wait := greatest(1, ceil(extract(epoch from (coalesce(v_at, now()) + v_limit.user_window - now())) / 60)::int);
      raise exception 'Too many wrong codes. Try again in % %, or ask for the invite link.', v_wait, case when v_wait = 1 then 'minute' else 'minutes' end
        using errcode = 'PT429', hint = 'join_copy_by_code: too many wrong codes from this person';
    end if;
  end if;
  if v_ip is not null and v_limit.ip_max is not null and v_limit.ip_window is not null then
    select m.missed_at into v_at
      from public.copy_code_misses m
     where m.ip = v_ip and m.missed_at > now() - v_limit.ip_window
     order by m.missed_at desc offset greatest(v_limit.ip_max - 1, 0) limit 1;
    if found then
      v_wait := greatest(1, ceil(extract(epoch from (v_at + v_limit.ip_window - now())) / 60)::int);
      raise exception 'Too many wrong codes from your network. Try again in % %, or ask for the invite link.', v_wait, case when v_wait = 1 then 'minute' else 'minutes' end
        using errcode = 'PT429', hint = 'join_copy_by_code: too many wrong codes from this network';
    end if;
  end if;

  if v_code ~ '^[0-9]{6}$' then
    select c.* into v_row from public.copy_pool c where c.join_code = v_code and c.lease_until > now() for update;
  end if;
  if v_row.project_id is null then
    insert into public.copy_code_misses (user_id, ip) values (v_uid, v_ip);
    return jsonb_build_object(
      'error', 'no_match',
      'message', 'That code doesn’t match a session that’s open now.',
      'tries_left', case when v_limit.user_max is null then null else greatest(0, v_limit.user_max - v_misses - 1) end);
  end if;
  return public.join_seat(v_row, v_uid, p_name);
end;
$$;

-- post_agent_message: as in 20261025050000_private_threads.sql, with the gate --------------------------------------

create or replace function public.post_agent_message(
  p_project uuid,
  p_text    text,
  p_channel text default 'text',
  p_action  jsonb default null,
  p_thread  uuid default null,
  p_context jsonb default null
)
returns public.agent_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := public.workflow_actor('post_agent_message');
  v_member public.project_members := public.workflow_member(p_project, 'post_agent_message');
  v_text   text := btrim(coalesce(p_text, ''), E' \t\r\n');
  v_row    public.agent_messages;
  v_limit  public.visitor_limits := public.visitor_limit('message');
begin
  if length(v_text) = 0 or length(v_text) > 2000 then
    raise exception 'post_agent_message: a message is 1-2000 characters' using errcode = '22023';
  end if;
  if p_channel is null or p_channel not in ('text', 'voice') then
    raise exception 'post_agent_message: p_channel must be text or voice' using errcode = '22023';
  end if;
  if p_thread is not null and not exists (
    select 1 from public.agent_threads t where t.id = p_thread and t.project_id = p_project and public.can_see_agent_thread(t.id)
  ) then
    raise exception 'post_agent_message: thread % is not in this project (it may have been deleted)', p_thread using errcode = 'P0002';
  end if;
  -- Every message wakes the assistant: 10 a minute per person, 60 an hour per network (visitor_limits 'message').
  perform public.rate_gate('message', v_uid, public.request_ip(), v_limit.user_max, v_limit.user_window,
                           v_limit.ip_max, v_limit.ip_window, p_project);
  insert into public.agent_messages (project_id, thread_id, role, author_id, channel, text, action, context)
  values (p_project, p_thread, 'person', v_uid, p_channel, v_text, public.agent_action_canonical(p_action), public.agent_context_canonical(p_context))
  returning * into v_row;
  return v_row;
end;
$$;

-- Lower quotas ---------------------------------------------------------------------------------------------------

-- Per copy and per day (UTC), as in 20261110120100_flags_and_quotas.sql and 20261111020000_payment_quotas.sql:
--   ai_turn       Remy's answers: 15 per copy, 250 a day
--   call_start    calls Remy is sent to: 2 per copy, 15 a day
--   call_join     call tokens, with or without Remy: 20 per copy, 300 a day
--   payout        payouts sent: 3 per copy, 30 a day
--   payout_minor  what they pay, in cents: $60,000 per copy, $150,000 a day
--   invoice       invoices made: 3 per copy, 60 a day
insert into public.quota_limits (kind, per_copy, per_day) values
  ('ai_turn', 15, 250),
  ('call_start', 2, 15),
  ('call_join', 20, 300),
  ('payout', 3, 30),
  ('payout_minor', 6000000, 15000000),
  ('invoice', 3, 60)
on conflict (kind) do update set per_copy = excluded.per_copy, per_day = excluded.per_day;

-- Idle visitors ----------------------------------------------------------------------------------------------------

-- delete_idle_visitors() -> how many it deleted: anonymous sign-ins made more than a day ago that hold no copy (even
-- one whose lease ran out and the sweep has not freed) and have no seat in a copy whose lease holds; p_limit at a
-- time, oldest first. As Supabase documents for anonymous users, they are deleted from auth.users; what refers to
-- them goes with them (seats, memberships, profiles, claims, wrong codes) or keeps its row without them (a
-- revision's or a message's author). One that cannot be deleted is left for the next run.
create or replace function public.delete_idle_visitors(p_limit int default 500)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid;
  v_count int := 0;
begin
  for v_user in
    select u.id
      from auth.users u
     where u.is_anonymous
       and u.created_at < now() - interval '24 hours'
       and not exists (select 1 from public.copy_pool c where c.holder = u.id)
       and not exists (select 1 from public.copy_seats s join public.copy_pool c on c.project_id = s.project_id
                        where s.user_id = u.id and c.lease_until > now())
     order by u.created_at
     limit greatest(coalesce(p_limit, 500), 0)
  loop
    begin
      delete from auth.users where id = v_user;
      v_count := v_count + 1;
    exception when others then
      raise warning 'delete_idle_visitors: % was not deleted: %', v_user, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;

-- Who may call what ----------------------------------------------------------------------------------------------

revoke execute on function public.visitor_address(text) from public, anon, authenticated;
revoke execute on function public.request_ip() from public, anon, authenticated;
revoke execute on function public.visitor_limit(text) from public, anon, authenticated;
revoke execute on function public.wait_words(numeric) from public, anon, authenticated;
revoke execute on function public.rate_gate_words(text, numeric) from public, anon, authenticated;
revoke execute on function public.rate_gate(text, uuid, inet, int, interval, int, interval, uuid) from public, anon, authenticated;
revoke execute on function public.claim_wait(inet) from public, anon, authenticated;
revoke execute on function public.join_seat(public.copy_pool, uuid, text) from public, anon, authenticated;
revoke execute on function public.delete_idle_visitors(int) from public, anon, authenticated;
revoke execute on function public.claim_copy(text) from public, anon;
revoke execute on function public.join_copy_by_code(text, text) from public, anon;
revoke execute on function public.post_agent_message(uuid, text, text, jsonb, uuid, jsonb) from public, anon;
grant execute on function public.rate_gate(text, uuid, inet, int, interval, int, interval, uuid) to service_role;
grant execute on function public.delete_idle_visitors(int) to service_role;
grant execute on function public.claim_copy(text) to authenticated, service_role;
grant execute on function public.join_copy_by_code(text, text) to authenticated, service_role;
grant execute on function public.post_agent_message(uuid, text, text, jsonb, uuid, jsonb) to authenticated, service_role;

-- The clean-up, where pg_cron is (as 20261110120200_copy_pool.sql schedules the sweep): visitor events after the 2
-- days the longest limit needs them, wrong codes after the network's hour (the job 20261111010000 scheduled, now
-- with the hour), and idle visitors every hour.
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available: visitor events, wrong codes and idle visitors are not cleared on a schedule';
    return;
  end if;
  begin
    create extension if not exists pg_cron;
    perform cron.schedule('clear-visitor-events', '17 * * * *', $job$delete from public.visitor_events where at < now() - interval '2 days'$job$);
    perform cron.schedule('clear-code-misses', '*/10 * * * *', $job$delete from public.copy_code_misses where missed_at <= now() - interval '1 hour'$job$);
    perform cron.schedule('delete-idle-visitors', '37 * * * *', 'select public.delete_idle_visitors()');
  exception when others then
    raise notice 'pg_cron could not schedule the clean-up: %', sqlerrm;
  end;
end;
$$;

notify pgrst, 'reload schema';
