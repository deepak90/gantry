-- The hosted demo's pool of private copies of Harbor Street Offices (20261110120200_copy_pool.sql), its switches and
-- its quotas (20261110120100_flags_and_quotas.sql). Twelve copies wait, free and exactly like Harbor. A visitor claims
-- one and holds it in the first seat; the people they invite join with its token, in the seats after, five people at
-- most, each under a name from a list (22_session_codes_and_names.sql tests the names and the codes); anyone in it
-- keeps it 30 more minutes, never past 2 hours after the claim; the holder gives it back,
-- or the sweep frees it once the lease has run out: reset as seeded, its people gone. A sign-in claims once; the next
-- session is a new sign-in (23_visitor_limits.sql tests the limits per person and network). Two claims at the same moment
-- never take the same copy: a second session (dblink, with the local stack's database password) holds a claim open
-- while this one claims. A full pool says so. Switches are read by anyone and changed by the service role alone; a
-- quota is checked and counted in one step, per copy and per day.
begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();

create temporary table t (k text primary key, v jsonb);
grant all on t to anon, authenticated, service_role;

-- Visitors 1 to 40: anonymous accounts, as Supabase Auth makes them for a visitor who has not signed up.
create function pg_temp.visitor(n int) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-0000000a00' || lpad(n::text, 2, '0'))::uuid;
$$;
insert into auth.users (instance_id, id, aud, role, created_at, updated_at, is_sso_user, is_anonymous)
select '00000000-0000-0000-0000-000000000000', pg_temp.visitor(n), 'authenticated', 'authenticated', now(), now(), false, true
  from generate_series(1, 40) n;

-- Who is asking, as PostgREST tells the database from their token.
create function pg_temp.be(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.project_of(k text) returns uuid language sql stable as $$ select (v ->> 'project_id')::uuid from t where t.k = project_of.k $$;
create function pg_temp.token_of(k text) returns text language sql stable as $$ select v ->> 'join_token' from t where t.k = token_of.k $$;
create function pg_temp.expire(p uuid) returns void language sql as $$
  update public.copy_pool set claimed_at = now() - interval '1 hour', lease_until = now() - interval '1 minute' where project_id = p;
$$;
grant execute on function pg_temp.visitor(int), pg_temp.be(uuid), pg_temp.project_of(text), pg_temp.token_of(text) to anon, authenticated, service_role;

-- The local database is shared: start from a free pool and no quota counts, whatever ran before (rolled back after).
select public.free_copy(c.project_id) from public.copy_pool c where c.claimed_at is not null;
delete from public.quota_usage;

-- The pool as seeded ---------------------------------------------------------------------------------------------
select results_eq(
  $$select project_id::text from public.copy_pool order by 1$$,
  $$select '00000000-0000-4000-8000-0000000100' || lpad(n::text, 2, '0') from generate_series(1, 12) n$$,
  'twelve copies wait in the pool, copy 1 to copy 12');
select is((select count(*)::int from public.copy_pool where holder is null and join_token is null and claimed_at is null and lease_until is null and seats = 5),
  12, 'all of them free, for five people each');
select is((select count(*)::int from public.copy_pool c join public.projects p on p.id = c.project_id
            where p.name = 'Harbor Street Offices' and not p.listed and p.template = 'harbor' and p.handover_task_id = 412
              and p.client_name = 'Larkspur Analytics' and p.current_revision = 0
              and p.snapshot = (select d.snapshot from public.demo_seeds d where d.project_id = '00000000-0000-4000-8000-000000000002')),
  12, 'each is Harbor Street Offices on Harbor''s seed plan, unlisted, playing Harbor');
select is((select count(*)::int from public.copy_pool c join public.demo_seeds d on d.project_id = c.project_id, public.demo_seeds h
            where h.project_id = '00000000-0000-4000-8000-000000000002'
              and d.snapshot = h.snapshot and d.library = h.library
              and (select jsonb_agg(b - 'id' - 'project_id' order by b ->> 'billable_start') from jsonb_array_elements(d.bookings) b)
                = (select jsonb_agg(b - 'id' - 'project_id' order by b ->> 'billable_start') from jsonb_array_elements(h.bookings) b)),
  12, 'and resets to what Harbor resets to: its plan, its library, its two rentals');
select is((select count(distinct b.id)::int from public.equipment_bookings b join public.copy_pool c on c.project_id = b.project_id), 24,
  'with rentals of its own');
select is((select count(*)::int from public.project_members m join public.copy_pool c on c.project_id = m.project_id), 0, 'nobody is in a copy yet');
select is((select template from public.projects where id = '00000000-0000-4000-8000-000000000002'), 'harbor', 'Harbor plays itself');
select ok(not exists (select 1 from public.copy_pool where project_id = '00000000-0000-4000-8000-000000000002'), 'and is in no pool');

-- Two claims at the same moment --------------------------------------------------------------------------------
-- A second session (dblink) holds a claim open, not yet committed, while this one claims. It sees nothing this test
-- has not committed, so it claims as Chris Hale's seed account (11). dblink needs a connection that asks for a
-- password: `supabase test db` connects over the stack's own network, where the local database password is asked
-- for; connected some other way (a socket, the loopback), the race checks are skipped.
create function pg_temp.race_open() returns boolean language plpgsql as $$
begin
  perform extensions.dblink_connect('race',
    format('hostaddr=%s port=%s dbname=%s user=postgres password=postgres', host(inet_server_addr()), inet_server_port(), current_database()));
  perform extensions.dblink_exec('race', 'begin');
  perform extensions.dblink_exec('race', 'set local lock_timeout = ''5s''');
  perform extensions.dblink_exec('race', 'set local role authenticated');
  perform extensions.dblink_exec('race', 'set local request.jwt.claims = ''{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}''');
  insert into t select 'race', r.j::jsonb from extensions.dblink('race', 'select public.claim_copy()::text') as r(j text);
  return true;
exception when others then
  raise notice 'no second session, so the race checks are skipped: %', sqlerrm;
  begin
    perform extensions.dblink_disconnect('race');
  exception when others then
    null;
  end;
  return false;
end;
$$;
create function pg_temp.raced() returns boolean language sql stable as $$ select exists (select 1 from t where k = 'race') $$;
grant execute on function pg_temp.raced() to authenticated;
select pg_temp.race_open();
select case when pg_temp.raced()
  then ok(exists (select 1 from public.copy_pool where project_id = pg_temp.project_of('race')), 'the other session is claiming a copy, not yet committed')
  else skip('no second session', 1) end;

-- Were a claim to wait for the other session instead of passing its copy by, it would give up here, not hang.
set local lock_timeout = '2s';
set local role authenticated;
select pg_temp.be(pg_temp.visitor(1));
insert into t select 'v1', public.claim_copy();
select case when pg_temp.raced()
  then isnt(pg_temp.project_of('v1'), pg_temp.project_of('race'), 'a claim at that moment passes the copy being taken by, and gets another')
  else skip('no second session', 1) end;
select pg_temp.be('00000000-0000-4000-8000-000000000011');
set local lock_timeout = '300ms';
select case when pg_temp.raced()
  then throws_ok($$select public.claim_copy()$$, '55P03', null, 'the same person''s second claim at that moment waits for the first (here until it gives up)')
  else skip('no second session', 1) end;
set local lock_timeout = 0;
reset role;
select extensions.dblink_exec('race', 'rollback') from (select 1) once where pg_temp.raced();
select extensions.dblink_disconnect('race') from (select 1) once where pg_temp.raced();
set local role authenticated;
select pg_temp.be('00000000-0000-4000-8000-000000000011');
insert into t select 'c11', public.claim_copy();
select case when pg_temp.raced()
  then is(pg_temp.project_of('c11'), pg_temp.project_of('race'), 'once the other claim is called off, its copy is free again')
  else skip('no second session', 1) end;

-- Claiming -----------------------------------------------------------------------------------------------------
select pg_temp.be(pg_temp.visitor(1));
select ok(pg_temp.token_of('v1') ~ '^[0-9a-f]{32}$', 'a claim comes with an invite token');
select is((select (v ->> 'lease_until')::timestamptz from t where k = 'v1'), now() + interval '30 minutes', 'and holds the copy for 30 minutes');
select is((select role || '/' || can_view_costs || '/' || approval_limit_minor from public.project_members
            where project_id = pg_temp.project_of('v1') and user_id = pg_temp.visitor(1)),
  'cm/true/25000000', 'the visitor holds it as a full member, as on Harbor');
select is((select color from public.profiles where user_id = pg_temp.visitor(1)), '#695086', 'in the first seat''s color');
select is(public.claim_copy(), (select v from t where k = 'v1'), 'claiming again gives back the same copy, token and lease');
select is(public.load_project(pg_temp.project_of('v1')) -> 'project' ->> 'name', 'Harbor Street Offices', 'the app loads it');
select results_eq($$select id from public.projects$$, $$select pg_temp.project_of('v1')$$, 'and it is the one project the visitor sees');
select throws_ok($$select * from public.copy_pool$$, '42501', null, 'the pool itself is not for clients');
select throws_ok($$select * from public.copy_seats$$, '42501', null, 'nor are its seats');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$select public.claim_copy()$$, '42501', 'claim_copy: sign in first', 'nobody claims a copy without signing in');
set local role anon;
select throws_ok($$select public.claim_copy()$$, '42501', null, 'and the anon key alone cannot call it');

-- Joining --------------------------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.be(pg_temp.visitor(2));
select is(public.join_copy(pg_temp.token_of('v1')) ->> 'project_id', pg_temp.project_of('v1')::text, 'the first person invited joins with the token');
select is((select role || '/' || can_view_costs || '/' || approval_limit_minor from public.project_members
            where project_id = pg_temp.project_of('v1') and user_id = pg_temp.visitor(2)),
  'pm/true/25000000', 'as a member who sees costs and can approve a payout, as on Harbor');
select is((select color from public.profiles where user_id = pg_temp.visitor(2)), '#2563eb', 'in the second seat''s color');
select is(public.join_copy(pg_temp.token_of('v1')) ->> 'project_id', pg_temp.project_of('v1')::text, 'joining twice is joining once');
select is((select count(*)::int from public.project_members where project_id = pg_temp.project_of('v1')), 2, 'two people in it');
select is((select count(*)::int from public.profiles where user_id = pg_temp.visitor(1)), 1, 'who see each other');
select pg_temp.be(pg_temp.visitor(1));
select is(public.join_copy(pg_temp.token_of('v1')) ->> 'project_id', pg_temp.project_of('v1')::text, 'the holder opening their own link is let in');
select is((select role from public.project_members where project_id = pg_temp.project_of('v1') and user_id = pg_temp.visitor(1)), 'cm', 'and stays the holder');
select pg_temp.be(pg_temp.visitor(3));
select lives_ok(format($$select public.join_copy(%L)$$, pg_temp.token_of('v1')), 'a third person joins');
select pg_temp.be(pg_temp.visitor(4));
select lives_ok(format($$select public.join_copy(%L)$$, pg_temp.token_of('v1')), 'a fourth');
select pg_temp.be(pg_temp.visitor(5));
select lives_ok(format($$select public.join_copy(%L)$$, pg_temp.token_of('v1')), 'a fifth');
select results_eq(
  format($$select m.role, count(distinct p.display_name)::int from public.project_members m join public.profiles p on p.user_id = m.user_id
            where m.project_id = %L group by m.role order by m.role$$, pg_temp.project_of('v1')),
  $$values ('cm', 1), ('pm', 4)$$,
  'the holder, then four people invited, each under a name of their own');
select pg_temp.be(pg_temp.visitor(6));
select throws_ok(format($$select public.join_copy(%L)$$, pg_temp.token_of('v1')), '53300', 'This session already has 5 people in it.', 'a sixth person is turned away');
select throws_ok($$select public.join_copy('nonsense')$$, '22023', 'This invite link isn’t valid, or the session it was for has ended.', 'a token that is not one');
select throws_ok($$select public.join_copy('0123456789abcdef0123456789abcdef')$$, '22023', null, 'a token no copy has');
select throws_ok($$select public.join_copy(null)$$, '22023', null, 'no token at all');
select throws_ok(format($$select public.load_project(%L)$$, pg_temp.project_of('v1')), '42501', null, 'and nobody turned away gets in');

-- Keeping it -----------------------------------------------------------------------------------------------------
reset role;
update public.copy_pool set claimed_at = now() - interval '20 minutes', lease_until = now() + interval '10 minutes' where project_id = pg_temp.project_of('v1');
set local role authenticated;
select pg_temp.be(pg_temp.visitor(4));
select is((public.touch_copy(pg_temp.project_of('v1')) ->> 'lease_until')::timestamptz, now() + interval '30 minutes', 'anyone in it keeps it 30 more minutes from now');
reset role;
update public.copy_pool set claimed_at = now() - interval '1 hour 45 minutes', lease_until = now() + interval '5 minutes' where project_id = pg_temp.project_of('v1');
set local role authenticated;
select pg_temp.be(pg_temp.visitor(1));
select is((public.touch_copy(pg_temp.project_of('v1')) ->> 'lease_until')::timestamptz, now() + interval '15 minutes', 'but never past 2 hours after the claim');
select pg_temp.be(pg_temp.visitor(7));
select throws_ok(format($$select public.touch_copy(%L)$$, pg_temp.project_of('v1')), '42501', 'touch_copy: only the people in this copy can keep it', 'someone not in it cannot keep it');
select pg_temp.be('00000000-0000-4000-8000-000000000012');
select throws_ok($$select public.touch_copy('00000000-0000-4000-8000-000000000002')$$, '22023', null, 'Harbor itself is no copy to keep');
reset role;
update public.copy_pool set claimed_at = now() - interval '40 minutes', lease_until = now() - interval '10 minutes' where project_id = pg_temp.project_of('v1');
set local role authenticated;
select pg_temp.be(pg_temp.visitor(7));
select throws_ok(format($$select public.join_copy(%L)$$, pg_temp.token_of('v1')), '22023', null, 'an invite is good only while the lease holds');
select pg_temp.be(pg_temp.visitor(2));
select is((public.touch_copy(pg_temp.project_of('v1')) ->> 'lease_until')::timestamptz, now() + interval '30 minutes',
  'a lease that ran out comes back if the copy has not been reset yet');

-- The sweep --------------------------------------------------------------------------------------------------------
-- What the visit leaves behind: a conversation, a payout waiting for approval, an uploaded file, a changed plan and
-- rental, quota counts, and someone the service role added with an account of their own.
select pg_temp.be(pg_temp.visitor(1));
select lives_ok(format($$select public.create_agent_thread(%L, 'Our visit')$$, pg_temp.project_of('v1')), 'the visitor starts a conversation');
select lives_ok(format($$select public.request_pay_gate_approval(%L, 25, 'Footings paid', 3780000, 'USD',
    '[{"firm":"Granite Ridge Concrete","amount_minor":3132000},{"firm":"Pinecrest Sitework","amount_minor":648000}]')$$, pg_temp.project_of('v1')),
  'and asks for a second person''s approval of the footings payout');
reset role;
insert into storage.objects (bucket_id, name, owner_id, metadata)
values ('documents', pg_temp.project_of('v1') || '/00000000-0000-4000-8000-00000000d0a1/site-photo.jpg', pg_temp.visitor(1)::text, '{"size": 2048, "mimetype": "image/jpeg"}');
update public.projects set snapshot = snapshot || '{"visited": true}' where id = pg_temp.project_of('v1');
update public.equipment_bookings set billable_end = '2026-12-31' where project_id = pg_temp.project_of('v1') and task_id = 41;
insert into public.project_members (project_id, user_id, role, can_view_costs, approval_limit_minor)
values (pg_temp.project_of('v1'), '00000000-0000-4000-8000-000000000012', 'cm', true, 25000000);
set local role service_role;
select is(public.use_quota('ai_turn', pg_temp.project_of('v1'), 3), true, 'Remy answers three times');
reset role;
select pg_temp.expire(pg_temp.project_of('v1'));
select pg_temp.expire(pg_temp.project_of('c11'));

set local role authenticated;
select pg_temp.be(pg_temp.visitor(1));
select throws_ok($$select public.sweep_copies()$$, '42501', null, 'a visitor cannot run the sweep');
set local role service_role;
select is(public.sweep_copies(), 2, 'the sweep frees the two copies whose lease ran out');
select is(public.sweep_copies(), 0, 'and finds nothing more the second time');
reset role;
select ok((select holder is null and join_token is null and claimed_at is null and lease_until is null and freed_at = now()
             from public.copy_pool where project_id = pg_temp.project_of('v1')), 'the copy is free again');
select is((select snapshot from public.projects where id = pg_temp.project_of('v1')),
  (select snapshot from public.demo_seeds where project_id = '00000000-0000-4000-8000-000000000002'), 'with Harbor''s seed plan');
select is((select billable_end from public.equipment_bookings where project_id = pg_temp.project_of('v1') and task_id = 41), '2026-12-24'::date, 'and the crane booked as seeded');
select is((select count(*)::int from public.agent_threads where project_id = pg_temp.project_of('v1')), 0, 'no conversation is left');
select is((select count(*)::int from public.pay_gate_approvals where project_id = pg_temp.project_of('v1')), 0, 'nor the payout approval, though the plan never moved');
select is((select count(*)::int from storage.objects where name like pg_temp.project_of('v1') || '/%' and name like '%site-photo%'), 0, 'nor the visit''s file');
select is((select count(*)::int from public.quota_usage where project_id = pg_temp.project_of('v1')), 0, 'its quota counts start over');
select is((select used from public.quota_usage where kind = 'ai_turn' and day = (now() at time zone 'utc')::date), 3, 'while the day''s still count');
select is((select count(*)::int from public.copy_seats where project_id = pg_temp.project_of('v1')), 0, 'every seat is free');
select results_eq(format($$select user_id from public.project_members where project_id = %L$$, pg_temp.project_of('v1')),
  $$values ('00000000-0000-4000-8000-000000000012'::uuid)$$,
  'the visitors are gone; someone the service role added, with an account and no seat, stays');
select ok(not exists (select 1 from public.project_members where project_id = pg_temp.project_of('c11')),
  'a person with an email account who took a seat goes too');
set local role authenticated;
select pg_temp.be(pg_temp.visitor(2));
select throws_ok(format($$select public.load_project(%L)$$, pg_temp.project_of('v1')), '42501', null, 'the people of the visit are out');
select throws_ok(format($$select public.touch_copy(%L)$$, pg_temp.project_of('v1')), '42501', null, 'and cannot keep it');
select pg_temp.be(pg_temp.visitor(7));
select throws_ok(format($$select public.join_copy(%L)$$, pg_temp.token_of('v1')), '22023', null, 'its old invite no longer works');

-- A holder whose time ran out ------------------------------------------------------------------------------------
-- A sign-in has one session, ever (20261111040000_visitor_limits.sql; 23_visitor_limits.sql tests the limits around
-- it): a new session is a new anonymous sign-in, with a fresh human check.
select pg_temp.be(pg_temp.visitor(10));
insert into t select 'v1b', public.claim_copy();
select pg_temp.be(pg_temp.visitor(8));
select lives_ok(format($$select public.join_copy(%L)$$, pg_temp.token_of('v1b')), 'someone joins the next visit');
reset role;
select pg_temp.expire(pg_temp.project_of('v1b'));
set local role authenticated;
select pg_temp.be(pg_temp.visitor(10));
select throws_ok($$select public.claim_copy()$$, 'PT403', 'You’ve already started a session from this page. Reload the page to start a new one.',
  'a holder whose lease ran out gets no other copy with the same sign-in');
select pg_temp.be(pg_temp.visitor(1));
select throws_ok($$select public.claim_copy()$$, 'PT403', null, 'nor does the first visitor, whose copy the sweep reset');
select pg_temp.be(pg_temp.visitor(12));
insert into t select 'v1c', public.claim_copy();
select isnt(pg_temp.token_of('v1c'), pg_temp.token_of('v1b'), 'a new sign-in starts a fresh visit, not the old one again');
select is((select (v ->> 'lease_until')::timestamptz from t where k = 'v1c'), now() + interval '30 minutes', 'for 30 minutes');
set local role service_role;
select is(public.sweep_copies(), 1, 'the sweep resets the copy whose lease ran out');
reset role;
select ok(not exists (select 1 from public.project_members where project_id = pg_temp.project_of('v1b') and user_id = pg_temp.visitor(8)),
  'and the old visit''s people are gone');

-- Giving it back -----------------------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.be(pg_temp.visitor(9));
select lives_ok(format($$select public.join_copy(%L)$$, pg_temp.token_of('v1c')), 'someone joins');
select throws_ok(format($$select public.release_copy(%L)$$, pg_temp.project_of('v1c')), '42501', null, 'but only the holder gives it back');
select pg_temp.be(pg_temp.visitor(12));
select lives_ok(format($$select public.release_copy(%L)$$, pg_temp.project_of('v1c')), 'the holder gives it back');
select throws_ok(format($$select public.release_copy(%L)$$, pg_temp.project_of('v1c')), '42501', null, 'once, as it is theirs no longer');
select throws_ok($$select public.release_copy('00000000-0000-4000-8000-000000000002')$$, '22023', null, 'Harbor itself is no copy to give back');
reset role;
select ok((select holder is null and claimed_at is null from public.copy_pool where project_id = pg_temp.project_of('v1c')), 'it is free');
select is((select count(*)::int from public.project_members where project_id = pg_temp.project_of('v1c')), 0, 'with nobody in it');

-- A full pool ------------------------------------------------------------------------------------------------------
do $$
declare
  n int := 20;
begin
  while exists (select 1 from public.copy_pool where claimed_at is null) loop
    perform pg_temp.be(pg_temp.visitor(n));
    insert into t select 'full' || n, public.claim_copy();
    n := n + 1;
  end loop;
end;
$$;
select is((select count(*)::int from public.copy_pool where claimed_at is not null), 12, 'every copy is taken');
select is((select count(distinct holder)::int from public.copy_pool), 12, 'each by someone else');
set local role authenticated;
select pg_temp.be(pg_temp.visitor(35));
select throws_ok($$select public.claim_copy()$$, '53000', 'Every session is in use right now. Please try again in a few minutes.', 'a full pool says so');
reset role;
select pg_temp.expire(pg_temp.project_of('full20'));
set local role authenticated;
select pg_temp.be(pg_temp.visitor(35));
select is(public.claim_copy() ->> 'project_id', pg_temp.project_of('full20')::text, 'a copy whose lease ran out goes to the next visitor before the sweep comes by');
reset role;
select ok(not exists (select 1 from public.project_members where project_id = pg_temp.project_of('full20') and user_id = pg_temp.visitor(20)),
  'reset first, without the visitor whose time was up');

-- Switches -------------------------------------------------------------------------------------------------------
set local role anon;
select results_eq($$select key, enabled from public.app_flags order by key$$, $$values ('live_ai', true), ('live_calls', true), ('live_payments', true)$$,
  'anyone reads the switches, all on to start with');
select throws_ok($$update public.app_flags set enabled = false where key = 'live_ai'$$, '42501', null, 'the anon key cannot turn one off');
set local role authenticated;
select pg_temp.be(pg_temp.visitor(1));
select is((select count(*)::int from public.app_flags where enabled), 3, 'a visitor reads them too');
select throws_ok($$update public.app_flags set enabled = false where key = 'live_ai'$$, '42501', null, 'but cannot turn one off');
select throws_ok($$insert into public.app_flags (key, enabled) values ('free_money', true)$$, '42501', null, 'nor add one');
set local role service_role;
select lives_ok($$update public.app_flags set enabled = false where key = 'live_payments'$$, 'the service role turns payments off');
select is((select enabled from public.app_flags where key = 'live_payments'), false, 'and everyone reads it off');

-- Quotas ---------------------------------------------------------------------------------------------------------
select results_eq($$select kind, per_copy, per_day from public.quota_limits where kind in ('ai_turn', 'call_join', 'call_start') order by kind$$,
  $$values ('ai_turn', 40, 500), ('call_join', 40, 300), ('call_start', null, 30)$$,
  'forty turns with Remy and forty call tokens per copy, and no count of calls per copy; 500 turns, thirty calls and 300 tokens a day (20261111040000_visitor_limits.sql to 20261111180000_calls_hardening.sql)');
-- The counting below is the same at any limit: run it at fifteen a copy.
update public.quota_limits set per_copy = 15 where kind = 'ai_turn';
select is(public.use_quota('ai_turn', pg_temp.project_of('full21')), true, 'a use within the limits is allowed');
select is(public.use_quota('ai_turn', pg_temp.project_of('full21'), 14), true, 'up to the copy''s limit');
select is(public.use_quota('ai_turn', pg_temp.project_of('full21')), false, 'not one more');
select is((select used from public.quota_usage where kind = 'ai_turn' and project_id = pg_temp.project_of('full21')), 15, 'and a refusal counts nothing');
-- Calls have no limit per copy since 20261111170000_calls_for_judging.sql; a count per copy still holds where one is set.
update public.quota_limits set per_copy = 2 where kind = 'call_start';
select is(public.use_quota('call_start', pg_temp.project_of('full21'), 2), true, 'two calls');
select is(public.use_quota('call_start', pg_temp.project_of('full21')), false, 'but not a third');
update public.quota_limits set per_copy = null where kind = 'call_start';
select is(public.use_quota('ai_turn', pg_temp.project_of('full22'), 16), false, 'more than a copy may use at once is refused whole');
select is((select coalesce(sum(used), 0)::int from public.quota_usage where kind = 'ai_turn' and project_id = pg_temp.project_of('full22')), 0, 'counting nothing');
update public.quota_limits set per_day = 20 where kind = 'ai_turn';
select is((select used from public.quota_usage where kind = 'ai_turn' and day = (now() at time zone 'utc')::date), 18, 'the day has used 18');
select is(public.use_quota('ai_turn', pg_temp.project_of('full22'), 2), true, 'another copy may use what is left of the day');
select is(public.use_quota('ai_turn', pg_temp.project_of('full22')), false, 'and no more than that');
select is(public.use_quota('ai_turn', null), false, 'the day''s limit holds for a use outside any copy too');
update public.quota_limits set per_day = 250 where kind = 'ai_turn';
select is(public.use_quota('ai_turn', null), true, 'which counts toward the day alone');
select throws_ok($$select public.use_quota('free_money', null)$$, '22023', null, 'a quota that does not exist');
select throws_ok($$select public.use_quota('ai_turn', null, 0)$$, '22023', null, 'a use of nothing');
select throws_ok($$select public.use_quota('ai_turn', '00000000-0000-4000-8000-00000000ffff')$$, '22023', null, 'a project that does not exist');
set local role authenticated;
select pg_temp.be(pg_temp.visitor(21));
select throws_ok(format($$select public.use_quota('ai_turn', %L)$$, pg_temp.project_of('full21')), '42501', null, 'a visitor cannot count their own uses');
select throws_ok($$select * from public.quota_usage$$, '42501', null, 'nor read them');
select throws_ok($$select * from public.quota_limits$$, '42501', null, 'nor the limits');
select lives_ok(format($$select public.release_copy(%L)$$, pg_temp.project_of('full21')), 'the visitor leaves');
set local role service_role;
select is(public.use_quota('ai_turn', pg_temp.project_of('full21')), true, 'and the next visit of that copy starts with its fifteen turns');

-- The sweep's schedule -----------------------------------------------------------------------------------------------
reset role;
create function pg_temp.sweep_job() returns text language plpgsql as $$
begin
  if to_regclass('cron.job') is null then
    return 'no pg_cron here';
  end if;
  return (select schedule || ' ' || command from cron.job where jobname = 'sweep-copies');
end;
$$;
select ok(pg_temp.sweep_job() in ('*/10 * * * * select public.sweep_copies()', 'no pg_cron here'), 'pg_cron runs the sweep every 10 minutes, where it is');

select is((select count(*)::int from public.project_members where project_id = '00000000-0000-4000-8000-000000000002'), 2, 'Harbor itself keeps its two people');

select * from finish();
rollback;
