-- Sessions as visitors see them (20261111010000_session_codes_and_names.sql): a claimed copy has a 6-digit code,
-- unique, gone with the session; joining with it works with spaces or a dash, and a wrong one is counted: 8 per person
-- in 10 minutes, then every code is refused for a while, the right one too (and 20 an hour per network, which
-- 23_visitor_limits.sql tests, in place of a limit for everyone). People take names from a list of 30, never the same
-- as someone else's in the session: the name asked for when it is free, else the one they had, else a free one; the
-- profile says the same as the seat, and a client cannot rename itself.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create temporary table t (k text primary key, v jsonb);
grant all on t to anon, authenticated, service_role;

-- Visitors 1 to 31: anonymous accounts, as Supabase Auth makes them.
create function pg_temp.visitor(n int) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-0000000c00' || lpad(n::text, 2, '0'))::uuid;
$$;
insert into auth.users (instance_id, id, aud, role, created_at, updated_at, is_sso_user, is_anonymous)
select '00000000-0000-0000-0000-000000000000', pg_temp.visitor(n), 'authenticated', 'authenticated', now(), now(), false, true
  from generate_series(1, 31) n;

create function pg_temp.be(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.got(k text) returns jsonb language sql stable as $$ select v from t where t.k = got.k $$;
create function pg_temp.project_of(k text) returns uuid language sql stable as $$ select (v ->> 'project_id')::uuid from t where t.k = project_of.k $$;
create function pg_temp.code_of(k text) returns text language sql stable as $$ select v ->> 'join_code' from t where t.k = code_of.k $$;
create function pg_temp.token_of(k text) returns text language sql stable as $$ select v ->> 'join_token' from t where t.k = token_of.k $$;
create function pg_temp.name_of(k text) returns text language sql stable as $$ select v ->> 'display_name' from t where t.k = name_of.k $$;
-- The first name on the list nobody in that session has (read as the test's own role, which may read the seats).
create function pg_temp.free_name(p uuid) returns text language sql stable security definer as $$
  select n from unnest(public.copy_seat_names()) with ordinality as l(n, i)
   where not exists (select 1 from public.copy_seats s where s.project_id = p and s.display_name = l.n) order by i limit 1;
$$;
-- Whether a name is on the list (which clients cannot read).
create function pg_temp.on_list(n text) returns boolean language sql stable security definer as $$ select n = any (public.copy_seat_names()) $$;
grant execute on function pg_temp.visitor(int), pg_temp.be(uuid), pg_temp.got(text), pg_temp.project_of(text), pg_temp.code_of(text),
  pg_temp.token_of(text), pg_temp.name_of(text), pg_temp.free_name(uuid), pg_temp.on_list(text) to anon, authenticated, service_role;

-- The local database is shared: start from a free pool and no misses, whatever ran before (rolled back after).
select public.free_copy(c.project_id) from public.copy_pool c where c.claimed_at is not null;
delete from public.copy_code_misses;

-- The list ---------------------------------------------------------------------------------------------------------
select is(cardinality(public.copy_seat_names()), 30, 'thirty names on the list');
select is((select count(distinct split_part(n, ' ', 1))::int from unnest(public.copy_seat_names()) n), 30, 'thirty first names, as Remy says them');
select is((select count(distinct split_part(n, ' ', 2))::int from unnest(public.copy_seat_names()) n), 30, 'and thirty last names');
select ok(not ('Deepak Jayaram' = any (public.copy_seat_names()) or 'Chris Hale' = any (public.copy_seat_names())), 'the seed personas are not on it');

-- Starting a session -----------------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.be(pg_temp.visitor(1));
insert into t select 'v1', public.claim_copy('Riley Brooks');
select is(pg_temp.name_of('v1'), 'Riley Brooks', 'a visitor starts a session under the name they picked');
select ok(pg_temp.code_of('v1') ~ '^[1-9][0-9]{5}$', 'with a 6-digit code, no leading zero');
select ok(pg_temp.token_of('v1') ~ '^[0-9a-f]{32}$' and (pg_temp.got('v1') ->> 'lease_until')::timestamptz = now() + interval '30 minutes',
  'beside the invite token and the 30-minute lease');
select is(public.claim_copy('Jordan Ellis'), pg_temp.got('v1'), 'claiming again gives back the same session, code and name');
select is((select display_name || ' ' || color from public.profiles where user_id = pg_temp.visitor(1)), 'Riley Brooks #695086',
  'the profile says the name, in the first seat''s color');
select is(public.touch_copy(pg_temp.project_of('v1')) ->> 'join_code', pg_temp.code_of('v1'), 'keeping the session tells the code too');

select pg_temp.be(pg_temp.visitor(2));
insert into t select 'v2', public.claim_copy('Somebody Else');
select ok(pg_temp.on_list(pg_temp.name_of('v2')), 'a name that is not on the list gets one that is');
select pg_temp.be(pg_temp.visitor(3));
insert into t select 'v3', public.claim_copy();
select ok(pg_temp.on_list(pg_temp.name_of('v3')), 'so does no name at all');
select isnt(pg_temp.code_of('v2'), pg_temp.code_of('v1'), 'each session has a code of its own');

-- Names in an invite's session, before signing in -------------------------------------------------------------------
set local role anon;
select is(public.copy_names_taken(pg_temp.token_of('v1')), array['Riley Brooks'], 'the welcome screen of an invite learns the names in use');
select is(public.copy_names_taken('0123456789abcdef0123456789abcdef'), '{}'::text[], 'nothing for a token no session has');
select is(public.copy_names_taken('nonsense'), '{}'::text[], 'or for one that is not a token');
select throws_ok(format($$select public.join_copy_by_code(%L)$$, pg_temp.code_of('v1')), '42501', null, 'the anon key alone cannot join with a code');

-- Joining with the link --------------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.be(pg_temp.visitor(4));
insert into t select 'v4', public.join_copy(pg_temp.token_of('v1'), 'Riley Brooks');
select is(pg_temp.project_of('v4'), pg_temp.project_of('v1'), 'someone invited joins with the link');
select ok(pg_temp.name_of('v4') <> 'Riley Brooks' and pg_temp.on_list(pg_temp.name_of('v4')),
  'asking for a name someone in the session has gets a free one from the list');
select is(pg_temp.code_of('v4'), pg_temp.code_of('v1'), 'and the code, to invite others with');
select is((select display_name || ' ' || color from public.profiles where user_id = pg_temp.visitor(4)), pg_temp.name_of('v4') || ' #2563eb',
  'in the second seat''s color');
select pg_temp.be(pg_temp.visitor(5));
insert into t select 'v5name', jsonb_build_object('name', pg_temp.free_name(pg_temp.project_of('v1')));
insert into t select 'v5', public.join_copy(pg_temp.token_of('v1'), pg_temp.got('v5name') ->> 'name');
select is(pg_temp.name_of('v5'), pg_temp.got('v5name') ->> 'name', 'a free name asked for is given');

-- Joining with the code ----------------------------------------------------------------------------------------------
select pg_temp.be(pg_temp.visitor(6));
insert into t select 'v6', public.join_copy_by_code(substr(pg_temp.code_of('v1'), 1, 3) || ' ' || substr(pg_temp.code_of('v1'), 4), pg_temp.name_of('v5'));
select is(pg_temp.project_of('v6'), pg_temp.project_of('v1'), 'the code joins the session, typed with a space');
select ok(pg_temp.name_of('v6') not in (pg_temp.name_of('v5'), 'Riley Brooks', pg_temp.name_of('v4')), 'under a name nobody there has');
select is(pg_temp.token_of('v6'), pg_temp.token_of('v1'), 'and hands over the invite link''s token, so they can invite too');
select pg_temp.be(pg_temp.visitor(1));
select is(public.join_copy_by_code(substr(pg_temp.code_of('v1'), 1, 3) || '-' || substr(pg_temp.code_of('v1'), 4)) ->> 'display_name', 'Riley Brooks',
  'the holder using their own code, with a dash, is let in as they are');
select pg_temp.be(pg_temp.visitor(7));
insert into t select 'v7', public.join_copy_by_code(pg_temp.code_of('v1'));
reset role;
select results_eq(
  format($$select s.seat, m.role, p.display_name = s.display_name from public.copy_seats s
            join public.project_members m on m.project_id = s.project_id and m.user_id = s.user_id
            join public.profiles p on p.user_id = s.user_id where s.project_id = %L order by s.seat$$, pg_temp.project_of('v1')),
  $$values (1, 'cm', true), (2, 'pm', true), (3, 'pm', true), (4, 'pm', true), (5, 'pm', true)$$,
  'five seats: the holder, then four invited, each profile saying its seat''s name');
select is((select count(distinct display_name)::int from public.copy_seats where project_id = pg_temp.project_of('v1')), 5, 'five different names');
select throws_ok(format($$update public.copy_seats set display_name = 'Riley Brooks' where project_id = %L and user_id = %L$$,
  pg_temp.project_of('v1'), pg_temp.visitor(4)), '23505', null, 'the database itself keeps two people in a session from sharing a name');
set local role authenticated;
select pg_temp.be(pg_temp.visitor(8));
select throws_ok(format($$select public.join_copy_by_code(%L)$$, pg_temp.code_of('v1')), '53300', 'This session already has 5 people in it.',
  'a sixth is turned away');

-- One person, one name ------------------------------------------------------------------------------------------------
select pg_temp.be(pg_temp.visitor(4));
insert into t select 'v4own', public.claim_copy();
select is(pg_temp.name_of('v4own'), pg_temp.name_of('v4'), 'someone invited who starts a session of their own keeps the name they had');
select pg_temp.be(pg_temp.visitor(5));
insert into t select 'v5newname', jsonb_build_object('name', pg_temp.free_name(pg_temp.project_of('v1')));
insert into t select 'v5own', public.claim_copy(pg_temp.got('v5newname') ->> 'name');
reset role;
select is((select display_name from public.profiles where user_id = pg_temp.visitor(5)), pg_temp.got('v5newname') ->> 'name',
  'someone who picks another name for a session of their own has it');
select is((select display_name from public.copy_seats where project_id = pg_temp.project_of('v1') and user_id = pg_temp.visitor(5)),
  pg_temp.got('v5newname') ->> 'name', 'in the session they were invited to as well, so everyone there sees what the seat says');

-- Wrong codes ----------------------------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.be(pg_temp.visitor(10));
select is(public.join_copy_by_code('000000'), '{"error": "no_match", "message": "That code doesn’t match a session that’s open now.", "tries_left": 7}'::jsonb,
  'a code no session has is answered in plain words, with the tries left');
select is(public.join_copy_by_code('12345') ->> 'tries_left', '6', 'so is one that is not a code at all, and it counts too');
select is(public.join_copy_by_code(null) ->> 'error', 'no_match', 'and nothing');
select is(public.join_copy_by_code(substr(pg_temp.code_of('v2'), 1, 3) || 'x' || substr(pg_temp.code_of('v2'), 4)) ->> 'error', 'no_match',
  'letters in a code are not skipped over');
reset role;
select is((select count(*)::int from public.copy_code_misses where user_id = pg_temp.visitor(10)), 4, 'each kept, though the answer was no');
set local role authenticated;
select is(public.join_copy_by_code('000001') ->> 'tries_left', '3', 'a fifth');
select is(public.join_copy_by_code('000002') ->> 'tries_left', '2', 'a sixth');
select is(public.join_copy_by_code('000003') ->> 'tries_left', '1', 'a seventh');
select is(public.join_copy_by_code('000004') ->> 'tries_left', '0', 'an eighth');
select throws_ok($$select public.join_copy_by_code('000005')$$, 'PT429', 'Too many wrong codes. Try again in 10 minutes, or ask for the invite link.',
  'the ninth try in 10 minutes is refused');
select throws_ok(format($$select public.join_copy_by_code(%L)$$, pg_temp.code_of('v2')), 'PT429', null, 'the right code too, while the limit holds');
reset role;
select is((select count(*)::int from public.copy_code_misses where user_id = pg_temp.visitor(10)), 8, 'a refused try is not counted');
select ok(not exists (select 1 from public.project_members where project_id = pg_temp.project_of('v2') and user_id = pg_temp.visitor(10)), 'and let nobody in');
update public.copy_code_misses set missed_at = missed_at - interval '7 minutes'
 where id = (select min(id) from public.copy_code_misses where user_id = pg_temp.visitor(10));
set local role authenticated;
select throws_ok($$select public.join_copy_by_code('000005')$$, 'PT429', 'Too many wrong codes. Try again in 3 minutes, or ask for the invite link.',
  'the refusal says when a try comes back');
reset role;
update public.copy_code_misses set missed_at = missed_at - interval '11 minutes' where user_id = pg_temp.visitor(10);
set local role authenticated;
select is(public.join_copy_by_code(pg_temp.code_of('v2')) ->> 'project_id', pg_temp.project_of('v2')::text, 'misses older than 10 minutes no longer count');
reset role;
select is((select count(*)::int from public.copy_code_misses where user_id = pg_temp.visitor(10)), 8,
  'they are kept for the hour a network''s wrong codes count (pg_cron clears them after it)');

-- Wrong codes from everyone -------------------------------------------------------------------------------------------
-- No limit for the whole site, which anyone could use to pause codes for everyone: a network has its own.
insert into public.copy_code_misses (user_id) select pg_temp.visitor(11 + n % 12) from generate_series(1, 120) n;
set local role authenticated;
select pg_temp.be(pg_temp.visitor(24));
select is(public.join_copy_by_code('000006') ->> 'error', 'no_match', 'after 120 wrong codes from other people, a wrong code is just wrong');
select pg_temp.be(pg_temp.visitor(25));
select is(public.join_copy_by_code(pg_temp.code_of('v2')) ->> 'project_id', pg_temp.project_of('v2')::text, 'and the right one joins');
select lives_ok(format($$select public.join_copy(%L)$$, pg_temp.token_of('v2')), 'as the invite link does');
reset role;
delete from public.copy_code_misses;

-- A code dies with its session ---------------------------------------------------------------------------------------
update public.copy_pool set claimed_at = now() - interval '40 minutes', lease_until = now() - interval '1 minute' where project_id = pg_temp.project_of('v3');
set local role authenticated;
select pg_temp.be(pg_temp.visitor(26));
select is(public.join_copy_by_code(pg_temp.code_of('v3')) ->> 'error', 'no_match', 'a session whose lease ran out takes no one by its code');
set local role anon;
select is(public.copy_names_taken(pg_temp.token_of('v3')), '{}'::text[], 'nor names its people');
set local role service_role;
select is(public.sweep_copies(), 1, 'the sweep frees it');
reset role;
select ok((select join_code is null and join_token is null from public.copy_pool where project_id = pg_temp.project_of('v3')), 'and its code goes with its token');
set local role authenticated;
select pg_temp.be(pg_temp.visitor(2));
select lives_ok(format($$select public.release_copy(%L)$$, pg_temp.project_of('v2')), 'a holder gives their session back');
select pg_temp.be(pg_temp.visitor(26));
select is(public.join_copy_by_code(pg_temp.code_of('v2')) ->> 'error', 'no_match', 'and its code no longer opens anything');
reset role;
select is((select count(*)::int from public.copy_pool where claimed_at is null and join_code is not null), 0, 'no free copy keeps a code');
update public.copy_pool set join_code = '123456' where claimed_at is null;
select is((select count(*)::int from public.copy_pool where claimed_at is null and join_code is not null), 0, 'or can be given one');
update public.copy_pool set join_code = null where project_id = pg_temp.project_of('v1');
select ok((select join_code ~ '^[1-9][0-9]{5}$' from public.copy_pool where project_id = pg_temp.project_of('v1')), 'a held copy whose code is cleared gets a new one');

-- Starting over keeps the name -----------------------------------------------------------------------------------------
-- Start over is a new anonymous sign-in (one session per sign-in), which asks for the name the person had.
set local role authenticated;
select pg_temp.be(pg_temp.visitor(1));
select lives_ok(format($$select public.release_copy(%L)$$, pg_temp.project_of('v1')), 'the holder starts over');
select throws_ok($$select public.claim_copy('Riley Brooks')$$, 'PT403', null, 'not with the sign-in that had the session');
select pg_temp.be(pg_temp.visitor(27));
insert into t select 'v1b', public.claim_copy('Riley Brooks');
select is(pg_temp.name_of('v1b'), 'Riley Brooks', 'but signed in again, and is still Riley Brooks');

-- Every copy, every code ---------------------------------------------------------------------------------------------------
reset role;
do $$
declare
  n int := 28;
begin
  while exists (select 1 from public.copy_pool where claimed_at is null) and n <= 31 loop
    perform pg_temp.be(pg_temp.visitor(n));
    insert into t select 'full' || n, public.claim_copy();
    n := n + 1;
  end loop;
end;
$$;
select is((select count(distinct join_code)::int from public.copy_pool where claimed_at is not null),
  (select count(*)::int from public.copy_pool where claimed_at is not null), 'every session holds a code no other has');

-- Clients ----------------------------------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.be(pg_temp.visitor(1));
select throws_ok($$select * from public.copy_code_misses$$, '42501', null, 'the misses are not for clients to read');
select throws_ok($$delete from public.copy_code_misses$$, '42501', null, 'nor to clear');
select throws_ok($$select public.new_join_code()$$, '42501', null, 'nor is making a code');
select throws_ok(format($$select public.seat_in_copy(%L, %L, 2, 'Riley Brooks')$$, pg_temp.project_of('v1b'), pg_temp.visitor(9)), '42501', null,
  'or seating someone');
select throws_ok(format($$select public.copy_seat_name(%L, %L, 'Riley Brooks')$$, pg_temp.project_of('v1b'), pg_temp.visitor(9)), '42501', null,
  'or choosing a name');
select throws_ok($$update public.profiles set display_name = 'Anything At All' where user_id = '00000000-0000-4000-8000-0000000c0001'$$, '42501', null,
  'a client cannot rename itself');
select isnt_empty($$update public.profiles set color = '#123456' where user_id = '00000000-0000-4000-8000-0000000c0001' returning 1$$,
  'but can change its color');
select throws_ok($$update public.profiles set color = 'url(https://example.com/x)' where user_id = '00000000-0000-4000-8000-0000000c0001'$$, '23514', null,
  'to a hex color only');

select * from finish();
rollback;
