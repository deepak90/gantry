-- submit_revision: ordering across two sessions, dedupe, store whitelist, origin, actor, and the
-- binding of p_client_id to a session owned by the caller.
-- Personas: the demo seed makes every member a full member (20261026040000_one_role.sql); this file
-- puts 11 back as the project manager and 12 as the cost manager of project 01 first, so "every
-- member may change crews, the project manager included" is proven with a real project manager.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

update public.project_members set role = 'pm', can_view_costs = false, approval_limit_minor = 0
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000011';
update public.project_members set role = 'cm', can_view_costs = true, approval_limit_minor = 500000
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000012';

create temp table fx as
select gen_random_uuid() as client_a,
       gen_random_uuid() as client_b,
       (select current_revision from public.projects where id = '00000000-0000-4000-8000-000000000001') as base;
grant select on fx to authenticated;
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at, is_sso_user, is_anonymous)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000aa', 'authenticated', 'authenticated',
        'outsider@test.local', now(), now(), false, false);
-- client_a is a tab of the pm, client_b a tab of the cm. The pm's session was last seen in the
-- past (trigger bypassed for the fixture) so the touch by submit_revision is observable.
alter table public.sessions disable trigger sessions_server_clock;
insert into public.sessions (id, user_id, project_id, created_at, last_seen)
select client_a, '00000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-000000000001'::uuid,
       '2020-01-01'::timestamptz, '2020-01-01'::timestamptz from fx
union all
select client_b, '00000000-0000-4000-8000-000000000012'::uuid, '00000000-0000-4000-8000-000000000001'::uuid,
       '2020-01-01'::timestamptz, '2020-01-01'::timestamptz from fx;
alter table public.sessions enable trigger sessions_server_clock;

-- Ordering across two sessions ---------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is(
  (select revision_no from public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), 'a-1', null,
     '{"tasks":{"updated":[{"id":1,"name":"A1"}]}}')),
  (select base + 1 from fx), 'client A (pm) gets base+1');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select is(
  (select revision_no from public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_b from fx), 'b-1', null,
     '{"tasks":{"updated":[{"id":2,"name":"B1"}]}}')),
  (select base + 2 from fx), 'client B (cm) gets base+2');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is(
  (select revision_no from public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), 'a-2', 'a-1',
     '{"tasks":{"updated":[{"id":1,"name":"A2"}]}}')),
  (select base + 3 from fx), 'client A gets base+3');
select is((select current_revision from public.projects where id = '00000000-0000-4000-8000-000000000001'),
  (select base + 3 from fx), 'projects.current_revision follows the head');
select is(
  (select conflict_resolution_for from public.project_revisions
    where client_id = (select client_a from fx) and local_revision_id = 'a-2'),
  'a-1', 'conflict_resolution_for is stored');
select is(
  (select actor_user_id from public.project_revisions where client_id = (select client_a from fx) and local_revision_id = 'a-1'),
  '00000000-0000-4000-8000-000000000011'::uuid, 'actor_user_id is the caller');
select is(
  (select origin from public.project_revisions where client_id = (select client_a from fx) and local_revision_id = 'a-1'),
  'human', 'origin defaults to human');
select is((select last_seen from public.sessions where id = (select client_a from fx)), now(),
  'an accepted submission refreshes the session heartbeat');

-- Client id must be a session of the caller -------------------------------------------------
-- Co-members can read each other's session ids, so the cm must not be able to file revisions under
-- the pm's tab (nor pre-fill the pm's (client_id, local_revision_id) dedupe keys).
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select is((select count(*) from public.sessions where id = (select client_a from fx)), 1::bigint,
  'the cm can see the pm session it is about to try');
select throws_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), 'a-99', null,
      '{"tasks":{"updated":[{"id":1,"name":"filed under the pm"}]}}')$$,
  '42501', null, 'a co-member session id is rejected');
select throws_matching(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), 'a-99', null,
      '{"tasks":{"updated":[{"id":1,"name":"filed under the pm"}]}}')$$,
  'is not a session of the caller', 'the rejection names the session binding');
select throws_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', gen_random_uuid(), 'b-99', null,
      '{"tasks":{"updated":[{"id":1,"name":"no such session"}]}}')$$,
  '42501', null, 'an unregistered client id is rejected');
select is((select count(*) from public.project_revisions where local_revision_id in ('a-99', 'b-99')), 0::bigint,
  'rejected client ids leave no row behind');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is(
  (select actor_user_id from public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), 'a-99', null,
     '{"tasks":{"updated":[{"id":1,"name":"filed by the pm"}]}}')),
  '00000000-0000-4000-8000-000000000011'::uuid, 'the owner of the session can still use that local id');
select is((select current_revision from public.projects where id = '00000000-0000-4000-8000-000000000001'),
  (select base + 4 from fx), 'the head moved once for the owner submission only');

-- Dedupe --------------------------------------------------------------------------------------
select results_eq(
  $$select id, revision_no, changes from public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), 'a-1', null,
      '{"tasks":{"updated":[{"id":1,"name":"RESENT WITH DIFFERENT CONTENT"}]}}')$$,
  $$select id, revision_no, changes from public.project_revisions
     where client_id = (select client_a from fx) and local_revision_id = 'a-1'$$,
  'resubmitting (client_id, local_revision_id) returns the existing row unchanged');
select is((select current_revision from public.projects where id = '00000000-0000-4000-8000-000000000001'),
  (select base + 4 from fx), 'a duplicate does not bump current_revision');
select is(
  (select count(*) from public.project_revisions where client_id in (select client_a from fx union select client_b from fx)),
  4::bigint, 'a duplicate does not insert a row');

-- Store whitelist -----------------------------------------------------------------------------
-- Crew management: every member may change resources, the project manager included.
select is(
  (select revision_no from public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), 'a-res', null,
     '{"resources":{"added":[{"$PhantomId":"_generatedResourceModel_r1","name":"Crane","company":"Northgate Equipment Rental"}]}}')),
  (select base + 5 from fx), 'resources are accepted for pm');
select is(
  (select jsonb_typeof(changes -> 'resources' -> 'added' -> 0 -> 'id') from public.project_revisions
    where client_id = (select client_a from fx) and local_revision_id = 'a-res'),
  'number', 'a crew added by the pm gets a real id');
select throws_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), 'a-cal', null,
      '{"calendars":{"updated":[{"id":"general","name":"x"}]}}')$$,
  '22023', null, 'calendars are rejected for pm');
select throws_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), 'a-mix', null,
      '{"tasks":{"updated":[{"id":1,"name":"ok"}]},"calendars":{"updated":[{"id":"general","name":"x"}]}}')$$,
  '22023', null, 'a submission mixing an accepted and a rejected store is rejected as a whole');
select throws_matching(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), 'a-unk', null,
      '{"timeRanges":{"added":[]}}')$$,
  'unknown store "timeRanges"', 'unknown stores are rejected with their name');
select throws_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), 'a-proj-str', null,
      '{"tasks":{"updated":[{"id":1,"name":"ok"}]},"project":"nope"}')$$,
  '22023', null, 'the project entry must be an object like every store entry');
select throws_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), 'a-arr', null, '[]'::jsonb)$$,
  '22023', null, 'p_changes must be an object');
select throws_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), 'a-str', null,
      '{"tasks":"nope"}')$$,
  '22023', null, 'a store entry must be an object');
select throws_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), '', null, '{"tasks":{}}')$$,
  '22023', null, 'p_local_revision_id is required');
select throws_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), 'a-org', null, '{"tasks":{}}', 'robot')$$,
  '22023', null, 'p_origin must be human, agent or engine');
select is((select current_revision from public.projects where id = '00000000-0000-4000-8000-000000000001'),
  (select base + 5 from fx), 'rejected submissions do not bump current_revision');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select is(
  (select revision_no from public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_b from fx), 'b-res', null,
     '{"resources":{"updated":[{"id":1,"eventColor":"orange"}],"added":[{"$PhantomId":"_generatedResourceModel_r2","name":"Riggers"}]}}')),
  (select base + 6 from fx), 'resources are accepted for cm');
select throws_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_b from fx), 'b-cal', null,
      '{"calendars":{"updated":[{"id":"general","name":"x"}]}}')$$,
  '22023', null, 'calendars are rejected for cm too');
select is(
  (select origin from public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_b from fx), 'b-agent', null,
     '{"tasks":{"updated":[{"id":3,"name":"by agent"}]}}', 'agent')),
  'agent', 'p_origin is stored');
-- Bryntum sends the project model's own calculated fields with record changes (and alone when
-- only the project changed); the key carries no records and is stored as submitted.
select is(
  (select changes -> 'project' from public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_b from fx), 'b-proj', null,
     '{"tasks":{"updated":[{"id":3,"startDate":"2026-11-10T00:00:00"}]},"project":{"endDate":"2027-04-01T00:00:00-07:00","duration":101,"percentDone":14.1}}')),
  '{"endDate":"2027-04-01T00:00:00-07:00","duration":101,"percentDone":14.1}'::jsonb,
  'the project key is accepted alongside record changes and stored unchanged');
select is(
  (select revision_no from public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_b from fx), 'b-proj-only', null,
     '{"project":{"$input":{"startDate":"2026-11-03T00:00:00"},"startDate":"2026-11-03T00:00:00"}}')),
  (select base + 9 from fx), 'a project-only revision is accepted');

-- Non-members and anon ----------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
select throws_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', gen_random_uuid(), 'o-1', null, '{"tasks":{}}')$$,
  '42501', null, 'non-member cannot submit');
reset role;
set local role anon;
select throws_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', gen_random_uuid(), 'anon-1', null, '{"tasks":{}}')$$,
  '42501', null, 'anon cannot submit');
reset role;

select * from finish();
rollback;
