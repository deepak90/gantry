-- Remy's minutes: one pool of call time with Remy for each visit to a copy, kept by the server.
--
-- A visit (a copy's lease: copy_pool.claimed_at, as its call's room is named) has five minutes with Remy on calls,
-- shared by everyone on it: whoever starts a call and whoever joins it later draw on the same minutes, and a new call
-- gets what the earlier ones left. The call routes (apps/web/call-hosted.ts) keep it, with the service role:
--
--   remy_minutes        one row a copy and visit: the time used, and the call Remy is on, if one is going
--   remy_minutes_now    the visit's minutes, a call that is over counted first
--   remy_minutes_start  a call with Remy starts: the rest of the minutes is set aside for it, and Remy's worker ends the
--                       call when that runs out; nothing when too little is left
--   quota_left          how much of a quota is left for a copy, the day's limit included (for the routes' checks)
--
-- A call counts from when Remy is sent until she is seen gone: by a route that asks the call server and finds her off
-- the call, or at the end of the time set aside for it, when her worker ends it for everyone. A call is never counted
-- for less than she was on it; at worst, for the few seconds until a route next looks.

insert into public.quota_limits (kind, per_copy, per_day) values ('remy_second', 300, null)
on conflict (kind) do nothing;

create table public.remy_minutes (
  project_id uuid not null references public.projects (id) on delete cascade,
  -- The visit: when its lease began, in ms (copy_pool.claimed_at); 0 for a project that isn't a copy.
  lease      bigint not null check (lease >= 0),
  used_ms    bigint not null default 0 check (used_ms >= 0),
  -- The call Remy is on: its room, when she was sent, and when the time set aside for it runs out.
  call_room  text check (length(call_room) between 1 and 200),
  call_from  timestamptz,
  call_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (project_id, lease),
  constraint remy_minutes_call check (
    (call_room is null and call_from is null and call_until is null)
    or (call_room is not null and call_from is not null and call_until is not null and call_until >= call_from))
);

alter table public.remy_minutes enable row level security;
revoke all on table public.remy_minutes from anon, authenticated;

-- How long Remy may still be on her way after she was sent: a route that doesn't see her yet doesn't count the call
-- as over (the call routes' STARTING_GRACE_MS is 15 seconds).
create or replace function public.remy_minutes_join_grace()
returns interval language sql immutable set search_path = '' as $$ select interval '20 seconds' $$;

-- The visit's row, locked; made when there is none. Counts a call that is over: one whose time ran out, in full (her
-- worker ended it then); one Remy was seen gone from (p_gone), until now, unless she was sent too recently to be there.
create or replace function public.remy_minutes_settled(p_project uuid, p_lease bigint, p_gone boolean)
returns public.remy_minutes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.remy_minutes;
  v_end timestamptz;
begin
  if p_lease is null or p_lease < 0 then
    raise exception 'remy_minutes: the lease is 0 or more' using errcode = '22023';
  end if;
  insert into public.remy_minutes (project_id, lease) values (p_project, p_lease)
  on conflict (project_id, lease) do nothing;
  select m.* into v from public.remy_minutes m where m.project_id = p_project and m.lease = p_lease for update;

  if v.call_room is not null then
    if v.call_until <= now() then
      v_end := v.call_until;
    elsif p_gone and v.call_from <= now() - public.remy_minutes_join_grace() then
      v_end := now();
    end if;
    if v_end is not null then
      update public.remy_minutes m
         set used_ms = m.used_ms + greatest(0, floor(extract(epoch from (v_end - m.call_from)) * 1000))::bigint,
             call_room = null, call_from = null, call_until = null, updated_at = now()
       where m.project_id = p_project and m.lease = p_lease
      returning m.* into v;
    end if;
  end if;
  return v;
end;
$$;
revoke execute on function public.remy_minutes_settled(uuid, bigint, boolean) from public, anon, authenticated;

-- The pool's size in ms: quota_limits' remy_second per copy.
create or replace function public.remy_minutes_total()
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce((select l.per_copy from public.quota_limits l where l.kind = 'remy_second'), 300)::bigint * 1000
$$;
revoke execute on function public.remy_minutes_total() from public, anon, authenticated;

-- What the routes answer: {total_ms, used_ms, left_ms, ends_at_ms (null when no call is going), now_ms}.
create or replace function public.remy_minutes_json(v public.remy_minutes)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'total_ms', public.remy_minutes_total(),
    'used_ms', v.used_ms,
    'left_ms', case
      when v.call_until is null then greatest(0, public.remy_minutes_total() - v.used_ms)
      else greatest(0, floor(extract(epoch from (v.call_until - now())) * 1000))::bigint end,
    'ends_at_ms', case when v.call_until is null then null else floor(extract(epoch from v.call_until) * 1000)::bigint end,
    'now_ms', floor(extract(epoch from now()) * 1000)::bigint)
$$;
revoke execute on function public.remy_minutes_json(public.remy_minutes) from public, anon, authenticated;

-- remy_minutes_now(project, lease, gone) -> the visit's minutes, a call that is over counted first. `gone`: the call
-- server says Remy isn't on the visit's call (the route asked it).
create or replace function public.remy_minutes_now(p_project uuid, p_lease bigint, p_gone boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.remy_minutes_json(public.remy_minutes_settled(p_project, p_lease, coalesce(p_gone, false)));
end;
$$;
revoke execute on function public.remy_minutes_now(uuid, bigint, boolean) from public, anon, authenticated;
grant execute on function public.remy_minutes_now(uuid, bigint, boolean) to service_role;

-- remy_minutes_start(project, lease, room, min_ms) -> {ok, ...minutes}. The route is sending Remy to the visit's call,
-- so she isn't on it: a call still marked as going is over, and counted. Then the rest of the minutes is set aside for
-- the new call (ok, with ends_at_ms), unless less than p_min_ms is left (ok false). Sent again while the last one may
-- still be on her way (within the join grace), she gets the same call, not a second share. The visit's earlier rows
-- (older leases of the copy) are dropped.
create or replace function public.remy_minutes_start(p_project uuid, p_lease bigint, p_room text, p_min_ms int default 15000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.remy_minutes;
  v_left bigint;
begin
  if p_room is null or length(p_room) not between 1 and 200 then
    raise exception 'remy_minutes_start: a room name of 1 to 200 characters' using errcode = '22023';
  end if;
  delete from public.remy_minutes m where m.project_id = p_project and m.lease <> p_lease;

  v := public.remy_minutes_settled(p_project, p_lease, false);
  if v.call_room is not null then
    if v.call_from > now() - public.remy_minutes_join_grace() then
      return public.remy_minutes_json(v) || jsonb_build_object('ok', true);
    end if;
    -- Older than the grace, and the route found her off the call: it's over.
    v := public.remy_minutes_settled(p_project, p_lease, true);
  end if;

  v_left := public.remy_minutes_total() - v.used_ms;
  if v_left < greatest(coalesce(p_min_ms, 0), 1) then
    return public.remy_minutes_json(v) || jsonb_build_object('ok', false);
  end if;

  update public.remy_minutes m
     set call_room = p_room, call_from = now(), call_until = now() + make_interval(secs => v_left / 1000.0), updated_at = now()
   where m.project_id = p_project and m.lease = p_lease
  returning m.* into v;
  return public.remy_minutes_json(v) || jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.remy_minutes_start(uuid, bigint, text, int) from public, anon, authenticated;
grant execute on function public.remy_minutes_start(uuid, bigint, text, int) to service_role;

-- quota_left(kind, project) -> how many more uses fit under both the copy's limit and the day's; null when neither
-- limits it. Nothing is counted.
create or replace function public.quota_left(p_kind text, p_project uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select least(
    case when l.per_copy is null or p_project is null then null
         else greatest(0, l.per_copy - coalesce((select u.used from public.quota_usage u where u.kind = l.kind and u.project_id = p_project), 0)) end,
    case when l.per_day is null then null
         else greatest(0, l.per_day - coalesce((select u.used from public.quota_usage u where u.kind = l.kind and u.day = (now() at time zone 'utc')::date), 0)) end)
  from public.quota_limits l
  where l.kind = p_kind
$$;
revoke execute on function public.quota_left(text, uuid) from public, anon, authenticated;
grant execute on function public.quota_left(text, uuid) to service_role;
