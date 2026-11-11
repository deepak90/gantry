-- Broadcast triggers (revisions, workflow, commercial) and the realtime.messages authorization policies.
-- Personas: the demo seed makes every member a full member in both demo projects
-- (20261026030000_demo_projects.sql, 20261026040000_one_role.sql); this file puts 11 back as the
-- project manager (no cost access) and 12 as the cost manager of project 01 first, and uses a project
-- made here (f1, 12 alone) as "another project".
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

update public.project_members set role = 'pm', can_view_costs = false, approval_limit_minor = 0
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000011';
update public.project_members set role = 'cm', can_view_costs = true, approval_limit_minor = 500000
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000012';
insert into public.projects (id, name) values ('00000000-0000-4000-8000-0000000000f1', 'Elsewhere');
insert into public.project_members (project_id, user_id, role, can_view_costs)
values ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-000000000012', 'cm', true);

create temp table fx as
select gen_random_uuid() as client_a,
       (select current_revision from public.projects where id = '00000000-0000-4000-8000-000000000001') as base;
grant select on fx to authenticated;
insert into public.sessions (id, user_id, project_id)
select client_a, '00000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-000000000001'::uuid from fx;
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at, is_sso_user, is_anonymous)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000aa', 'authenticated', 'authenticated',
        'outsider@test.local', now(), now(), false, false);
insert into public.equipment_bookings
  (id, project_id, task_id, resource_id, supplier_name, supplier_payout_email, rental_rate_minor, currency, billable_start, billable_end, idle_days)
values
  ('00000000-0000-4000-8000-0000000001aa', '00000000-0000-4000-8000-000000000001', 1, 1,
   'Northgate Equipment Rental', 'supplier@test.local', 60000, 'USD', '2026-11-02', '2026-11-14', 4);

-- realtime.send is provided by the Realtime service. The triggers guard on it; this suite expects
-- it to be present on a running local stack so the broadcasts can be verified.
select isnt(to_regprocedure('realtime.send(jsonb,text,text,boolean)'), null::regprocedure,
  'realtime.send(jsonb,text,text,boolean) is installed');

-- Revision broadcast ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select lives_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), 'rt-1', null,
      '{"tasks":{"updated":[{"id":1,"name":"broadcast me"}]}}')$$,
  'submit_revision succeeds with the broadcast trigger attached');
reset role;

select is(
  (select count(*) from realtime.messages
    where topic = 'project:00000000-0000-4000-8000-000000000001:revisions'
      and event = 'revision' and extension = 'broadcast' and private
      and payload ->> 'local_revision_id' = 'rt-1'
      and (payload ->> 'client_id')::uuid = (select client_a from fx)),
  1::bigint, 'the accepted revision was broadcast privately on project:<id>:revisions');
select is(
  (select array_agg(k order by k)
     from realtime.messages m, jsonb_object_keys(m.payload) k
    where m.topic = 'project:00000000-0000-4000-8000-000000000001:revisions' and m.payload ->> 'local_revision_id' = 'rt-1'),
  array['actor_user_id', 'changes', 'client_id', 'conflict_resolution_for', 'created_at', 'id',
        'local_revision_id', 'origin', 'project_id', 'revision_no'],
  'the broadcast payload is the full project_revisions row');
select is(
  (select (payload ->> 'revision_no')::int from realtime.messages
    where topic = 'project:00000000-0000-4000-8000-000000000001:revisions' and payload ->> 'local_revision_id' = 'rt-1'),
  (select base + 1 from fx), 'the broadcast carries the assigned revision_no');

-- Workflow and commercial broadcasts --------------------------------------------------------
insert into public.proposals (id, project_id, booking_id)
values ('00000000-0000-4000-8000-0000000002aa', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000001aa');
update public.proposals set state = 'evaluated' where id = '00000000-0000-4000-8000-0000000002aa';
insert into public.decision_notes (project_id, proposal_id, text)
values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000002aa', 'note');
delete from public.proposals where id = '00000000-0000-4000-8000-0000000002aa';

select results_eq(
  $$select payload from realtime.messages
     where topic = 'project:00000000-0000-4000-8000-000000000001:workflow' and event = 'change' and private
       and payload ->> 'table' = 'proposals'
     order by inserted_at, (payload ->> 'op')$$,
  $$values ('{"table":"proposals","id":"00000000-0000-4000-8000-0000000002aa","op":"INSERT","proposal_id":"00000000-0000-4000-8000-0000000002aa"}'::jsonb),
           ('{"table":"proposals","id":"00000000-0000-4000-8000-0000000002aa","op":"UPDATE","proposal_id":"00000000-0000-4000-8000-0000000002aa"}'::jsonb),
           ('{"table":"proposals","id":"00000000-0000-4000-8000-0000000002aa","op":"DELETE","proposal_id":"00000000-0000-4000-8000-0000000002aa"}'::jsonb)$$,
  'proposals insert/update/delete each broadcast { table, id, op, proposal_id } on project:<id>:workflow');
select is(
  (select count(*) from realtime.messages
    where topic = 'project:00000000-0000-4000-8000-000000000001:commercial' and payload ->> 'table' = 'proposals'),
  0::bigint, 'proposals no longer broadcast on the cost-gated commercial topic');
select is(
  (select count(*) from realtime.messages
    where topic = 'project:00000000-0000-4000-8000-000000000001:commercial' and payload ->> 'table' = 'decision_notes'),
  2::bigint, 'decision_notes broadcast on commercial (insert + cascade delete)');
update public.equipment_bookings set idle_days = 5 where id = '00000000-0000-4000-8000-0000000001aa';
select is(
  (select payload from realtime.messages
    where topic = 'project:00000000-0000-4000-8000-000000000001:workflow' and payload ->> 'table' = 'equipment_bookings'
      and payload ->> 'op' = 'UPDATE' and payload ->> 'id' = '00000000-0000-4000-8000-0000000001aa'),
  '{"table":"equipment_bookings","id":"00000000-0000-4000-8000-0000000001aa","op":"UPDATE","proposal_id":null}'::jsonb,
  'booking changes broadcast on workflow without a proposal id');

-- Topic helper -------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is(public.can_join_project_topic('project:00000000-0000-4000-8000-000000000001:revisions'), true, 'pm: revisions');
select is(public.can_join_project_topic('project:00000000-0000-4000-8000-000000000001:presence'), true, 'pm: presence');
select is(public.can_join_project_topic('project:00000000-0000-4000-8000-000000000001:view'), true, 'pm: view');
select is(public.can_join_project_topic('project:00000000-0000-4000-8000-000000000001:cursor'), true, 'pm: cursor');
select is(public.can_join_project_topic('project:00000000-0000-4000-8000-000000000001:commercial'), false, 'pm: commercial needs can_view_costs');
select is(public.can_join_project_topic('project:00000000-0000-4000-8000-000000000001:workflow'), true, 'pm: workflow (no figures in its payloads)');
select is(public.can_join_project_topic('project:00000000-0000-4000-8000-000000000001:other'), false, 'unknown channel is refused');
select is(public.can_join_project_topic('project:00000000-0000-4000-8000-0000000000f1:revisions'), false, 'another project is refused');
select is(public.can_join_project_topic('room-1'), false, 'foreign topic shapes are refused');
select is(public.can_join_project_topic(null), false, 'null topic is refused');
-- Sending is allowed on the ephemeral channels only; revisions and commercial are database-originated.
select is(public.can_send_on_project_topic('project:00000000-0000-4000-8000-000000000001:presence'), true, 'pm may send: presence');
select is(public.can_send_on_project_topic('project:00000000-0000-4000-8000-000000000001:view'), true, 'pm may send: view');
select is(public.can_send_on_project_topic('project:00000000-0000-4000-8000-000000000001:cursor'), true, 'pm may send: cursor');
select is(public.can_send_on_project_topic('project:00000000-0000-4000-8000-000000000001:revisions'), false, 'pm may not send: revisions');
select is(public.can_send_on_project_topic('project:00000000-0000-4000-8000-000000000001:commercial'), false, 'pm may not send: commercial');
select is(public.can_send_on_project_topic('project:00000000-0000-4000-8000-000000000001:workflow'), false, 'pm may not send: workflow');
select is(public.can_send_on_project_topic('project:00000000-0000-4000-8000-0000000000f1:presence'), false, 'another project is refused for sending');
select is(public.can_send_on_project_topic('room-1'), false, 'foreign topic shapes are refused for sending');
select is(public.can_send_on_project_topic(null), false, 'null topic is refused for sending');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select is(public.can_join_project_topic('project:00000000-0000-4000-8000-000000000001:commercial'), true, 'cm: commercial');
select is(public.can_send_on_project_topic('project:00000000-0000-4000-8000-000000000001:commercial'), false,
  'cm may not send on commercial either: its payloads come from triggers');
select is(public.can_send_on_project_topic('project:00000000-0000-4000-8000-000000000001:revisions'), false, 'cm may not send: revisions');
select is(public.can_join_project_topic('project:00000000-0000-4000-8000-0000000000f1:revisions'), true,
  'the other project''s topics are refused to the pm for membership, not because the project is unknown');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
select is(public.can_join_project_topic('project:00000000-0000-4000-8000-000000000001:revisions'), false, 'non-member: refused');
select is(public.can_send_on_project_topic('project:00000000-0000-4000-8000-000000000001:presence'), false, 'non-member may not send');

-- realtime.messages policies (the Realtime service evaluates these with realtime.topic set) --
-- A forged revision broadcast would be applied by every other browser without ever passing
-- submit_revision, so a member's own insert on project:<id>:revisions must be refused while the
-- trigger's row (inserted by the function owner above) is delivered.
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
set local realtime.topic = 'project:00000000-0000-4000-8000-000000000001:revisions';
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('project:00000000-0000-4000-8000-000000000001:revisions', 'broadcast',
            '{"project_id":"00000000-0000-4000-8000-000000000001","revision_no":999,"changes":{"calendars":{}}}', 'revision', true)$$,
  '42501', null, 'member cannot send a broadcast on the revisions topic');
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('project:00000000-0000-4000-8000-000000000001:revisions', 'presence', '{"x":1}', 'test', true)$$,
  '42501', null, 'member cannot send presence on the revisions topic');
select ok(
  (select count(*) from realtime.messages where topic = 'project:00000000-0000-4000-8000-000000000001:revisions'
     and payload ->> 'local_revision_id' = 'rt-1') >= 1,
  'member can receive the trigger broadcast on the revisions topic');
set local realtime.topic = 'project:00000000-0000-4000-8000-000000000001:presence';
select lives_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('project:00000000-0000-4000-8000-000000000001:presence', 'presence', '{"x":1}', 'test', true)$$,
  'member can send presence on the presence topic');
select lives_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('project:00000000-0000-4000-8000-000000000001:presence', 'broadcast', '{"x":1}', 'test', true)$$,
  'member can send broadcast on the presence topic');
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('project:00000000-0000-4000-8000-000000000001:presence', 'postgres_changes', '{"x":1}', 'test', true)$$,
  '42501', null, 'other extensions are not authorized');
select ok(
  (select count(*) from realtime.messages where topic = 'project:00000000-0000-4000-8000-000000000001:presence') >= 2,
  'member can receive on the presence topic');
set local realtime.topic = 'project:00000000-0000-4000-8000-000000000001:view';
select lives_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('project:00000000-0000-4000-8000-000000000001:view', 'broadcast', '{"seq":1}', 'frame', true)$$,
  'member can send broadcast on the view topic');
set local realtime.topic = 'project:00000000-0000-4000-8000-000000000001:cursor';
select lives_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('project:00000000-0000-4000-8000-000000000001:cursor', 'broadcast', '{"taskId":1}', 'cursor', true)$$,
  'member can send broadcast on the cursor topic');
set local realtime.topic = 'project:00000000-0000-4000-8000-000000000001:commercial';
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('project:00000000-0000-4000-8000-000000000001:commercial', 'broadcast', '{}', 'test', true)$$,
  '42501', null, 'pm cannot send on the commercial topic');
select is(
  (select count(*) from realtime.messages where topic = 'project:00000000-0000-4000-8000-000000000001:commercial'),
  0::bigint, 'pm cannot receive on the commercial topic');

set local realtime.topic = 'project:00000000-0000-4000-8000-000000000001:workflow';
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('project:00000000-0000-4000-8000-000000000001:workflow', 'broadcast', '{}', 'change', true)$$,
  '42501', null, 'pm cannot send on the workflow topic');
select ok(
  (select count(*) from realtime.messages where topic = 'project:00000000-0000-4000-8000-000000000001:workflow') >= 4,
  'pm can receive the workflow broadcasts');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('project:00000000-0000-4000-8000-000000000001:commercial', 'broadcast', '{}', 'test', true)$$,
  '42501', null, 'cm cannot send on the commercial topic: its payloads are database-originated');
select ok(
  (select count(*) from realtime.messages where topic = 'project:00000000-0000-4000-8000-000000000001:commercial'
     and payload ->> 'table' = 'decision_notes') >= 1,
  'cm can receive the trigger broadcasts on the commercial topic');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
set local realtime.topic = 'project:00000000-0000-4000-8000-000000000001:revisions';
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('project:00000000-0000-4000-8000-000000000001:revisions', 'broadcast', '{}', 'test', true)$$,
  '42501', null, 'non-member cannot send on a project topic');
select is(
  (select count(*) from realtime.messages where topic = 'project:00000000-0000-4000-8000-000000000001:revisions'),
  0::bigint, 'non-member cannot receive on a project topic');
set local realtime.topic = 'project:00000000-0000-4000-8000-000000000001:presence';
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('project:00000000-0000-4000-8000-000000000001:presence', 'presence', '{}', 'test', true)$$,
  '42501', null, 'non-member cannot send presence either');
reset role;

select * from finish();
rollback;
