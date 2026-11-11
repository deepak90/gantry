-- Assistant threads and context: post_agent_message with a thread and a context (shape checked,
-- canonical), threads started by any member and renamed or deleted only by their starter or a
-- project manager (messages go with the thread), the decision record written from the stored card
-- (applied, applied automatically, declined; the first one counts; it outlives its thread), RLS on
-- both tables, and reset_demo clearing them.
-- Robust to rows other tools left in the database: every check names the rows made here.
-- Personas: the demo seed makes every member a full member (20261026040000_one_role.sql); this file
-- puts 11 back as the project manager and 12 as the cost manager of project 01 first, so "a project
-- manager deletes any thread" is proven with a real project manager.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

update public.project_members set role = 'pm', can_view_costs = false, approval_limit_minor = 0
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000011';
update public.project_members set role = 'cm', can_view_costs = true, approval_limit_minor = 500000
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000012';

create temp table t (name text primary key, doc jsonb);
grant all on t to authenticated, service_role;

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at, is_sso_user, is_anonymous)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000ab', 'authenticated', 'authenticated',
        'stranger@test.local', now(), now(), false, false);

-- Threads -------------------------------------------------------------------------------------------
-- 11 is the project manager, 12 the cost manager of project 01.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
insert into t select 'th1', to_jsonb(public.create_agent_thread('00000000-0000-4000-8000-000000000001', '  Crane rental  '));
select is((select doc ->> 'title' from t where name = 'th1'), 'Crane rental', 'a member starts a thread; the title is trimmed');
select is((select doc ->> 'created_by' from t where name = 'th1'), '00000000-0000-4000-8000-000000000012', 'the starter is the caller');
select throws_ok($$select public.create_agent_thread('00000000-0000-4000-8000-000000000001', '  ')$$, '22023', null, 'a thread needs a title');
select throws_ok($$select public.create_agent_thread('00000000-0000-4000-8000-000000000001', repeat('x', 81))$$, '22023', null,
  'a title is at most 80 characters');
select throws_ok($$insert into public.agent_threads (project_id, title) values ('00000000-0000-4000-8000-000000000001', 'x')$$, '42501', null,
  'nobody writes the threads table directly');

-- A message with a thread and a context ---------------------------------------------------------
insert into t select 'm1', to_jsonb(public.post_agent_message(
  '00000000-0000-4000-8000-000000000001', 'What is wrong with this task?', 'text', null,
  (select (doc ->> 'id')::uuid from t where name = 'th1'),
  '{"selected_tasks":[{"id":42,"name":"Crane erection","wbs":"3.4"}],"approval_mode":"risky"}'));
select is((select doc ->> 'thread_id' from t where name = 'm1'), (select doc ->> 'id' from t where name = 'th1'), 'the message is in the thread');
select is((select doc -> 'context' from t where name = 'm1'),
  '{"selected_tasks": [{"id": 42, "name": "Crane erection", "wbs": "3.4"}], "approval_mode": "risky"}'::jsonb,
  'the context is stored as sent');
select is((public.post_agent_message('00000000-0000-4000-8000-000000000001', 'hi', 'text', null, null, '{"selected_tasks":[{"id":7,"name":"Pour"}]}')).context,
  '{"selected_tasks": [{"id": 7, "name": "Pour", "wbs": null}]}'::jsonb, 'a missing wbs becomes null; no thread means the main thread');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'hi', 'text', null, null, '{"mode":"auto"}')$$,
  '22023', null, 'unknown context fields are refused');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'hi', 'text', null, null, '{"approval_mode":"yolo"}')$$,
  '22023', null, 'the approval mode is ask, risky or auto');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'hi', 'text', null, null, '{"selected_tasks":[{"id":"7","name":"Pour"}]}')$$,
  '22023', null, 'task ids are numbers');
-- What was on their screen (20261111110000_screen_context.sql): known fields, each as ScreenContext has it.
select is((public.post_agent_message('00000000-0000-4000-8000-000000000001', 'close that', 'text', null, null,
  '{"screen":{"view":"site","site_day":"2026-11-25","playing":false,"panel":"assistant","modal":"payment_review","modal_about":"Progress payment · Footings","call":"host"}}')).context,
  '{"screen": {"view": "site", "site_day": "2026-11-25", "playing": false, "panel": "assistant", "modal": "payment_review", "modal_about": "Progress payment · Footings", "call": "host"}}'::jsonb,
  'the screen is stored as sent');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'hi', 'text', null, null, '{"screen":{"view":"chart","extra":"x"}}')$$,
  '22023', null, 'unknown screen fields are refused');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'hi', 'text', null, null, '{"screen":{"panel":"task"}}')$$,
  '22023', null, 'the screen says chart or site');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'hi', 'text', null, null, '{"screen":{"view":"site","site_day":"Nov 25"}}')$$,
  '22023', null, 'the day on show is a date');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'hi', 'text', null, null, '{"screen":{"view":"chart","modal":"popup"}}')$$,
  '22023', null, 'what is open over the page is one of the known windows');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'hi', 'text', null, null,
  jsonb_build_object('screen', jsonb_build_object('view', 'chart', 'search', repeat('x', 81))))$$,
  '22023', null, 'screen text stays short');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'hi', 'text', null, null,
  jsonb_build_object('selected_tasks', (select jsonb_agg(jsonb_build_object('id', g, 'name', 'x')) from generate_series(1, 31) g)))$$,
  '22023', null, 'at most 30 selected tasks');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'hi', 'text', null, gen_random_uuid())$$,
  'P0002', null, 'a thread that does not exist (or was deleted) is refused');
reset role;

-- The assistant answers in the thread; its message moves the thread up ----------------------------
set local role service_role;
insert into public.agent_messages (project_id, thread_id, turn_id, role, channel, text, cards)
values ('00000000-0000-4000-8000-000000000001', (select (doc ->> 'id')::uuid from t where name = 'th1'), 'turn-t1', 'assistant', 'text',
        'Here is a change.',
        '[{"id":"edit-1","component":"show_plan_edit","props":{"title":"Start the crane rental on the 16th","lines":["Move the rental start to Nov 16"]}},
          {"id":"edit-2","component":"show_plan_edit","props":{"title":"Drop the spare day","lines":[]}},
          {"id":"edit-3","component":"show_plan_edit","props":{"title":"Link the pours","lines":["Link A to B"]}}]');
select ok((select last_message_at >= (select (doc ->> 'created_at')::timestamptz from t where name = 'm1')
             from public.agent_threads where id = (select (doc ->> 'id')::uuid from t where name = 'th1')),
  'a message moves its thread''s last activity');
insert into public.projects (id, name) values ('00000000-0000-4000-8000-0000000000f2', 'Other site');
select throws_ok(
  $$insert into public.agent_messages (project_id, thread_id, role, channel, text)
    values ('00000000-0000-4000-8000-0000000000f2', (select (doc ->> 'id')::uuid from t where name = 'th1'), 'assistant', 'text', 'x')$$,
  '23503', null, 'a message cannot go to another project''s thread');
reset role;

-- Decisions -------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'Applied it.', 'text', '{"kind":"apply_edit","card_id":"edit-1"}',
  (select (doc ->> 'id')::uuid from t where name = 'th1'), '{"approval_mode":"ask"}');
select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'Applied automatically.', 'text', '{"kind":"apply_edit","card_id":"edit-2"}',
  (select (doc ->> 'id')::uuid from t where name = 'th1'), '{"approval_mode":"auto"}');
select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'Declined.', 'text', '{"kind":"dismiss_edit","card_id":"edit-3"}',
  (select (doc ->> 'id')::uuid from t where name = 'th1'));
select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'Applied it after all.', 'text', '{"kind":"apply_edit","card_id":"edit-3"}',
  (select (doc ->> 'id')::uuid from t where name = 'th1'));
select results_eq(
  $$select card_id, decision, title, lines, decided_by::text from public.agent_edit_decisions
     where project_id = '00000000-0000-4000-8000-000000000001' and card_id like 'edit-%' order by card_id$$,
  $$values ('edit-1', 'applied', 'Start the crane rental on the 16th', '["Move the rental start to Nov 16"]'::jsonb, '00000000-0000-4000-8000-000000000011'),
           ('edit-2', 'auto_applied', 'Drop the spare day', '[]'::jsonb, '00000000-0000-4000-8000-000000000011'),
           ('edit-3', 'declined', 'Link the pours', '["Link A to B"]'::jsonb, '00000000-0000-4000-8000-000000000011')$$,
  'each decision is recorded once, from the stored card; the first one about a card counts');
select throws_ok($$delete from public.agent_edit_decisions where card_id = 'edit-1'$$, '42501', null, 'nobody edits the decisions');

-- Rename and delete: the starter or a project manager --------------------------------------------
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select is((public.rename_agent_thread((select (doc ->> 'id')::uuid from t where name = 'th1'), 'Crane rental fix')).title, 'Crane rental fix',
  'the starter renames their thread');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
insert into t select 'th2', to_jsonb(public.create_agent_thread('00000000-0000-4000-8000-000000000001', 'Level 2 pours'));
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok(format('select public.rename_agent_thread(%L, %L)', (select doc ->> 'id' from t where name = 'th2'), 'Mine now'),
  '42501', null, 'a cost manager cannot rename someone else''s thread');
select throws_ok(format('select public.delete_agent_thread(%L)', (select doc ->> 'id' from t where name = 'th2')),
  '42501', null, 'nor delete it');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000ab","role":"authenticated"}';
select is((select count(*)::int from public.agent_threads where project_id = '00000000-0000-4000-8000-000000000001'), 0,
  'someone outside the project sees no threads');
select is((select count(*)::int from public.agent_edit_decisions where project_id = '00000000-0000-4000-8000-000000000001'), 0,
  'nor decisions');
select throws_ok(format('select public.delete_agent_thread(%L)', (select doc ->> 'id' from t where name = 'th1')),
  'P0002', null, 'and cannot delete a thread they cannot see');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is(public.delete_agent_thread((select (doc ->> 'id')::uuid from t where name = 'th1')), (select (doc ->> 'id')::uuid from t where name = 'th1'),
  'a project manager deletes any thread');
select is((select count(*)::int from public.agent_messages where thread_id = (select (doc ->> 'id')::uuid from t where name = 'th1')), 0,
  'its messages go with it');
select is((select count(*)::int from public.agent_edit_decisions where card_id like 'edit-%' and thread_id is null
             and project_id = '00000000-0000-4000-8000-000000000001'), 3,
  'the decisions stay for the changelog');
reset role;

-- reset_demo clears threads and decisions -------------------------------------------------------
set local role service_role;
select lives_ok($$select public.reset_demo('00000000-0000-4000-8000-000000000001')$$, 'reset_demo runs');
select is((select count(*)::int from public.agent_threads where project_id = '00000000-0000-4000-8000-000000000001'), 0, 'no threads after a reset');
select is((select count(*)::int from public.agent_edit_decisions where project_id = '00000000-0000-4000-8000-000000000001'), 0, 'no decisions after a reset');
reset role;

-- Privileges -------------------------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.create_agent_thread(uuid,text,boolean,boolean)', 'execute'), 'anon cannot start a thread');
select ok(not has_function_privilege('authenticated', 'public.agent_context_canonical(jsonb)', 'execute'), 'the context helper is internal');
select ok(not has_function_privilege('authenticated', 'public.agent_thread_for_owner(uuid,text)', 'execute'), 'the owner check is internal');

select * from finish();
rollback;
