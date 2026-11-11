-- Calls with Remy, after a code review and a day of testing (2026-11-11):
--
--   * The spend caps fit 30 calls a day exactly. record_spend refuses the booking that reaches a cap, and each cap was
--     30 bookings to the cent, so the 30th call was refused: each is now a millionth of a dollar above.
--   * A session's joins: 40, not 20. Three people coming back after a quiet hang-up spend three a call; pressing "Call
--     Remy" while already on the call no longer spends one (apps/web/call-hosted.ts checks).
--   * Remy has 45 seconds to come before a route counts her call over (was 20): a slow start isn't a call that ended.
--   * remy_minutes_ended: LiveKit's word that Remy left the visit's call, or that its room closed (the site's
--     api/call/hook), counts the call then, whether or not anyone's tab is there to ask. A word about a Remy who joined
--     before this call was set aside is about an earlier call, and changes nothing.

update public.spend_limits set daily_usd_micro = 7500001 where vendor = 'openai';
update public.spend_limits set daily_usd_micro = 3000001 where vendor in ('elevenlabs', 'livekit');
update public.spend_limits set daily_usd_micro = 28500003 where vendor = 'total';
update public.quota_limits set per_copy = 40 where kind = 'call_join';

create or replace function public.remy_minutes_join_grace()
returns interval language sql immutable set search_path = '' as $$ select interval '45 seconds' $$;

-- remy_minutes_ended(project, lease, room, since) -> the visit's minutes, the call in `room` counted until now. `since`:
-- when the Remy who left joined; one who joined more than a few seconds before the call was set aside was on an
-- earlier call. Null for a room that closed.
create or replace function public.remy_minutes_ended(p_project uuid, p_lease bigint, p_room text, p_since timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.remy_minutes;
begin
  v := public.remy_minutes_settled(p_project, p_lease, false);
  if v.call_room is not null and v.call_room = p_room and (p_since is null or p_since >= v.call_from - interval '10 seconds') then
    update public.remy_minutes m
       set used_ms = m.used_ms + greatest(0, floor(extract(epoch from (least(now(), m.call_until) - m.call_from)) * 1000))::bigint,
           call_room = null, call_from = null, call_until = null, updated_at = now()
     where m.project_id = p_project and m.lease = p_lease
    returning m.* into v;
  end if;
  return public.remy_minutes_json(v);
end;
$$;
revoke execute on function public.remy_minutes_ended(uuid, bigint, text, timestamptz) from public, anon, authenticated;
grant execute on function public.remy_minutes_ended(uuid, bigint, text, timestamptz) to service_role;
