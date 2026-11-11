-- RLS: anonymous and non-member callers see nothing; members read their projects, member rows,
-- co-member profiles and co-sessions; clients never write memberships, projects or revisions.
-- Personas: the demo seed makes every member a full member in both demo projects
-- (20261026030000_demo_projects.sql, 20261026040000_one_role.sql); this file puts 11 back as the
-- project manager and 12 as the cost manager of project 01 first, and checks visibility against the
-- memberships rather than a fixed project count (other tools may add members to the demo projects).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

update public.project_members set role = 'pm', can_view_costs = false, approval_limit_minor = 0
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000011';
update public.project_members set role = 'cm', can_view_costs = true, approval_limit_minor = 500000
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000012';

-- Fixtures (postgres bypasses RLS) ----------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000aa', 'authenticated', 'authenticated',
   'outsider@test.local', '{"display_name":"Olive Outsider","color":"#10b981"}'::jsonb, now(), now(), false, false),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000ab', 'authenticated', 'authenticated',
   'plain@test.local', '{"color":"not-a-color"}'::jsonb, now(), now(), false, false);

-- A session opened in the past: the server-clock trigger is bypassed for this fixture only, so the
-- tests below can tell a preserved created_at from a freshly stamped one.
alter table public.sessions disable trigger sessions_server_clock;
insert into public.sessions (id, user_id, project_id, created_at, last_seen)
values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001',
        '2020-01-01', '2020-01-01');
alter table public.sessions enable trigger sessions_server_clock;

-- A project the pm is not in (its only member is the second test user), and what the pm should see,
-- read as postgres before the role switch: her projects, their member rows and their members.
insert into public.projects (id, name) values ('00000000-0000-4000-8000-0000000000f1', 'Elsewhere');
insert into public.project_members (project_id, user_id, role)
values ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000ab', 'pm');
create temp table pm_view as
select m.project_id, m.user_id
  from public.project_members m
 where m.project_id in (select project_id from public.project_members where user_id = '00000000-0000-4000-8000-000000000011');
grant select on pm_view to authenticated;

insert into public.equipment_bookings
  (id, project_id, task_id, resource_id, supplier_name, supplier_payout_email, rental_rate_minor, currency, billable_start, billable_end, idle_days)
values
  ('00000000-0000-4000-8000-0000000001aa', '00000000-0000-4000-8000-000000000001', 1, 1,
   'Northgate Equipment Rental', 'supplier@test.local', 60000, 'USD', '2026-11-02', '2026-11-14', 4);

-- Profile trigger ---------------------------------------------------------------------------
select is((select display_name from public.profiles where user_id = '00000000-0000-4000-8000-0000000000aa'),
  'Olive Outsider', 'auth.users insert creates a profile with display_name from raw_user_meta_data');
select is((select color from public.profiles where user_id = '00000000-0000-4000-8000-0000000000aa'),
  '#10b981', 'profile color comes from raw_user_meta_data');
select is((select display_name from public.profiles where user_id = '00000000-0000-4000-8000-0000000000ab'),
  'plain', 'display_name defaults to the email local part');
select is((select color from public.profiles where user_id = '00000000-0000-4000-8000-0000000000ab'),
  '#64748b', 'an invalid metadata color falls back to the default');
select results_eq(
  $$select display_name, color from public.profiles
     where user_id in ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012')
     order by display_name$$,
  $$values ('Chris Hale', '#2563eb'), ('Deepak Jayaram', '#695086')$$,
  'seeded demo profiles carry the seed names and colors');

-- anon ---------------------------------------------------------------------------------------
set local role anon;
select throws_ok('select count(*) from public.projects', '42501', null, 'anon cannot read projects');
select throws_ok('select count(*) from public.project_members', '42501', null, 'anon cannot read project_members');
select throws_ok('select count(*) from public.profiles', '42501', null, 'anon cannot read profiles');
select throws_ok('select count(*) from public.sessions', '42501', null, 'anon cannot read sessions');
select throws_ok('select count(*) from public.project_revisions', '42501', null, 'anon cannot read project_revisions');
select throws_ok('select count(*) from public.equipment_bookings', '42501', null, 'anon cannot read equipment_bookings');
select throws_ok($$select public.load_project('00000000-0000-4000-8000-000000000001')$$, '42501', null, 'anon cannot call load_project');
reset role;

-- Authenticated non-member -------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
select is((select count(*) from public.projects), 0::bigint, 'non-member sees no projects');
select is((select count(*) from public.project_members), 0::bigint, 'non-member sees no member rows');
select is((select count(*) from public.sessions), 0::bigint, 'non-member sees no sessions');
select is((select count(*) from public.project_revisions), 0::bigint, 'non-member sees no revisions');
select is((select count(*) from public.equipment_bookings), 0::bigint, 'non-member sees no bookings');
select results_eq('select user_id from public.profiles',
  $$values ('00000000-0000-4000-8000-0000000000aa'::uuid)$$, 'non-member sees only their own profile');
select throws_ok($$select public.load_project('00000000-0000-4000-8000-000000000001')$$, '42501', null,
  'non-member cannot load the project');
select throws_ok(
  $$insert into public.sessions (user_id, project_id)
    values ('00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-000000000001')$$,
  '42501', null, 'non-member cannot open a session on the project');

-- pm -----------------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select results_eq('select id from public.projects order by id',
  'select distinct project_id from pm_view order by project_id', 'pm sees exactly the projects she is a member of');
select is((select count(*) from public.projects where id = '00000000-0000-4000-8000-000000000001'), 1::bigint,
  'pm sees the demo project');
select is((select count(*) from public.projects where id = '00000000-0000-4000-8000-0000000000f1'), 0::bigint,
  'pm does not see a project she is not in');
select results_eq('select project_id, user_id from public.project_members order by project_id, user_id',
  'select project_id, user_id from pm_view order by project_id, user_id', 'pm sees exactly the member rows of her projects');
select results_eq(
  $$select user_id from public.project_members where project_id = '00000000-0000-4000-8000-000000000001'
     and user_id in ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012') order by user_id$$,
  $$values ('00000000-0000-4000-8000-000000000011'::uuid), ('00000000-0000-4000-8000-000000000012'::uuid)$$,
  'pm sees both persona member rows of the demo project');
select results_eq('select user_id from public.profiles order by user_id',
  'select distinct user_id from pm_view order by user_id', 'pm sees exactly the profiles of her co-members');
select is(
  (select count(*) from public.profiles
    where user_id in ('00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000ab')),
  0::bigint, 'pm sees neither the outsider nor the member of a project she is not in');
select is((select count(*) from public.equipment_bookings where id = '00000000-0000-4000-8000-0000000001aa'), 1::bigint,
  'pm sees the test booking');
select is(public.is_project_member('00000000-0000-4000-8000-000000000001'), true, 'is_project_member is true for pm');
select is(public.member_role('00000000-0000-4000-8000-000000000001'), 'pm', 'member_role returns pm');
select lives_ok(
  $$insert into public.sessions (user_id, project_id)
    values ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001')$$,
  'pm can open an own session');
select throws_ok(
  $$insert into public.sessions (user_id, project_id)
    values ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001')$$,
  '42501', null, 'pm cannot open a session for another user');
select isnt_empty($$update public.sessions set last_seen = now() where id = '00000000-0000-4000-8000-0000000000e1' returning 1$$,
  'pm can update an own session');
-- Timestamps come from the server clock: the client cannot choose created_at (which orders the
-- executor election) and whatever it sends as last_seen is replaced by now().
select throws_ok(
  $$insert into public.sessions (user_id, project_id, created_at)
    values ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', '2000-01-01')$$,
  '42501', null, 'clients cannot choose created_at when opening a session');
select throws_ok(
  $$update public.sessions set created_at = '2000-01-01' where id = '00000000-0000-4000-8000-0000000000e1'$$,
  '42501', null, 'clients cannot change created_at');
select throws_ok(
  $$update public.sessions set user_id = '00000000-0000-4000-8000-000000000012' where id = '00000000-0000-4000-8000-0000000000e1'$$,
  '42501', null, 'clients cannot re-own a session');
select isnt_empty(
  $$insert into public.sessions (id, user_id, project_id, last_seen)
    values ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', '2099-01-01')
    returning 1$$,
  'pm can open a session with the columns the client sends');
select is((select created_at from public.sessions where id = '00000000-0000-4000-8000-0000000000e2'), now(),
  'created_at is stamped by the server');
select is((select last_seen from public.sessions where id = '00000000-0000-4000-8000-0000000000e2'), now(),
  'a client-supplied last_seen is replaced by the server clock');
select isnt_empty(
  $$update public.sessions set last_seen = '2099-01-01' where id = '00000000-0000-4000-8000-0000000000e1' returning 1$$,
  'the heartbeat update is accepted');
select is((select last_seen from public.sessions where id = '00000000-0000-4000-8000-0000000000e1'), now(),
  'the heartbeat stores the server clock, not the client value');
select is((select created_at from public.sessions where id = '00000000-0000-4000-8000-0000000000e1'), '2020-01-01'::timestamptz,
  'a heartbeat leaves created_at alone');
select throws_ok($$delete from public.sessions where id = '00000000-0000-4000-8000-0000000000e1'$$,
  '42501', null, 'clients cannot delete sessions');
select throws_ok(
  $$insert into public.project_members (project_id, user_id, role)
    values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'pm')$$,
  '42501', null, 'clients cannot insert project_members');
select throws_ok($$delete from public.project_members where user_id = '00000000-0000-4000-8000-000000000012'$$,
  '42501', null, 'clients cannot delete project_members');
select throws_ok($$update public.projects set name = 'x' where id = '00000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'clients cannot update projects');
select throws_ok(
  $$insert into public.project_revisions (project_id, revision_no, client_id, local_revision_id, changes)
    values ('00000000-0000-4000-8000-000000000001', 99, gen_random_uuid(), 'x', '{}')$$,
  '42501', null, 'clients cannot write project_revisions directly');
select throws_ok(
  $$insert into public.proposals (project_id, booking_id)
    values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000001aa')$$,
  '42501', null, 'clients cannot write commercial tables directly');
select isnt_empty($$update public.profiles set color = '#111111' where user_id = '00000000-0000-4000-8000-000000000011' returning 1$$,
  'owner can update own profile');
select is_empty(
  $$update public.profiles set color = '#000000' where user_id = '00000000-0000-4000-8000-000000000012' returning 1$$,
  'owner cannot update a co-member profile');
select throws_ok(
  $$update public.profiles set user_id = '00000000-0000-4000-8000-000000000012' where user_id = '00000000-0000-4000-8000-000000000011'$$,
  '42501', null, 'profiles.user_id is not updatable by clients');

-- cm -----------------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select is((select count(*) from public.sessions where id = '00000000-0000-4000-8000-0000000000e1'), 1::bigint,
  'cm sees a co-member session of the same project');
select is_empty(
  $$update public.sessions set last_seen = now() where id = '00000000-0000-4000-8000-0000000000e1' returning 1$$,
  'cm cannot update a co-member session');
select is(public.member_role('00000000-0000-4000-8000-000000000001'), 'cm', 'member_role returns cm');
reset role;

select * from finish();
rollback;
