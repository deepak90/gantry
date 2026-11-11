-- Private threads (20261025050000_private_threads.sql, 20261025070000_shared_costs.sql): a private
-- thread and its messages are read only by its starter and the people they invite; its live topic
-- only they may join; anyone in it invites another member, its starter shares it with the project;
-- bringing in someone who cannot see costs where someone can needs the costs shared, by someone who
-- sees them (kept on the thread); the assistant names a thread only while its title is still its
-- first words, and never after a person named it.
-- Personas: the demo seed makes every member a full member (20261026040000_one_role.sql); this file
-- puts 11 back as the project manager who cannot see costs and 12 as the cost manager of project 01
-- first, so the cost-sharing rules are proven against someone who cannot see costs.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

update public.project_members set role = 'pm', can_view_costs = false, approval_limit_minor = 0
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000011';
update public.project_members set role = 'cm', can_view_costs = true, approval_limit_minor = 500000
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000012';

create temp table t (name text primary key, doc jsonb);
grant all on t to authenticated, service_role;

-- 11 is the project manager (no cost access), 12 the cost manager of project 01.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
insert into t select 'p', to_jsonb(public.create_agent_thread('00000000-0000-4000-8000-000000000001', 'What is wrong with the crane?', true, true));
select is((select doc ->> 'visibility' from t where name = 'p'), 'private', 'a new conversation is private');
select is((select doc ->> 'title_source' from t where name = 'p'), 'auto', 'and named by its first words');
insert into t select 'pm1', to_jsonb(public.post_agent_message('00000000-0000-4000-8000-000000000001', 'What is wrong with the crane?', 'text', null, (select (doc ->> 'id')::uuid from t where name = 'p'), null));
select ok(public.can_join_project_topic('project:00000000-0000-4000-8000-000000000001:thread:' || (select doc ->> 'id' from t where name = 'p')),
  'its starter may join its live topic');

-- The project manager sees nothing of it.
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is((select count(*)::int from public.agent_threads where id = (select (doc ->> 'id')::uuid from t where name = 'p')), 0, 'another member cannot read a private thread');
select is((select count(*)::int from public.agent_messages where id = (select (doc ->> 'id')::uuid from t where name = 'pm1')), 0, 'nor its messages');
select ok(not public.can_join_project_topic('project:00000000-0000-4000-8000-000000000001:thread:' || (select doc ->> 'id' from t where name = 'p')),
  'nor join its live topic');
select throws_ok(format($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'hi', 'text', null, %L::uuid, null)$$, (select doc ->> 'id' from t where name = 'p')),
  'P0002', null, 'nor write in it');
select throws_ok(format($$select public.invite_to_agent_thread(%L::uuid, '00000000-0000-4000-8000-000000000011')$$, (select doc ->> 'id' from t where name = 'p')),
  'P0002', null, 'nor invite herself in');

-- The cost manager invites her: she cannot see costs, so he has to share them in the conversation.
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok(format($$select public.invite_to_agent_thread(%L::uuid, '00000000-0000-4000-8000-000000000011')$$, (select doc ->> 'id' from t where name = 'p')),
  '22023', null, 'inviting someone who cannot see costs needs the costs shared');
select is((select costs_shared_by from public.agent_threads where id = (select (doc ->> 'id')::uuid from t where name = 'p')), null, 'nothing is shared until he says so');
select lives_ok(format($$select public.invite_to_agent_thread(%L::uuid, '00000000-0000-4000-8000-000000000011', true)$$, (select doc ->> 'id' from t where name = 'p')),
  'anyone in a private thread invites a member, sharing the costs when needed');
select is((select costs_shared_by from public.agent_threads where id = (select (doc ->> 'id')::uuid from t where name = 'p')),
  '00000000-0000-4000-8000-000000000012'::uuid, 'the thread keeps who shared its costs');
select ok((select costs_shared_at is not null from public.agent_threads where id = (select (doc ->> 'id')::uuid from t where name = 'p')), 'and when');
select throws_ok(format($$select public.invite_to_agent_thread(%L::uuid, '00000000-0000-4000-8000-0000000000ff')$$, (select doc ->> 'id' from t where name = 'p')),
  'P0002', null, 'only a member of the project can be invited');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is((select count(*)::int from public.agent_messages where id = (select (doc ->> 'id')::uuid from t where name = 'pm1')), 1, 'once invited she reads the thread');
select ok(public.can_join_project_topic('project:00000000-0000-4000-8000-000000000001:thread:' || (select doc ->> 'id' from t where name = 'p')),
  'and may join its live topic');
select is((select count(*)::int from public.agent_thread_members where thread_id = (select (doc ->> 'id')::uuid from t where name = 'p')), 1, 'and sees who is in it');
select throws_ok(format($$select public.set_agent_thread_visibility(%L::uuid, 'project')$$, (select doc ->> 'id' from t where name = 'p')),
  '42501', null, 'only its starter shares a thread with the project');
select lives_ok(format($$select public.remove_from_agent_thread(%L::uuid, '00000000-0000-4000-8000-000000000011')$$, (select doc ->> 'id' from t where name = 'p')),
  'anyone may leave');
select is((select count(*)::int from public.agent_threads where id = (select (doc ->> 'id')::uuid from t where name = 'p')), 0, 'and then reads it no more');

-- The project manager's own conversation: inviting the cost manager needs nothing (he sees costs).
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
insert into t select 'm', to_jsonb(public.create_agent_thread('00000000-0000-4000-8000-000000000001', 'Dates for the crane', true, true));
select lives_ok(format($$select public.invite_to_agent_thread(%L::uuid, '00000000-0000-4000-8000-000000000012')$$, (select doc ->> 'id' from t where name = 'm')),
  'someone who sees costs is invited without sharing anything');
select is((select costs_shared_by from public.agent_threads where id = (select (doc ->> 'id')::uuid from t where name = 'm')), null, 'so nothing is shared');

-- Sharing a cost manager's conversation with the project shares its costs too, and only he may.
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
insert into t select 'c', to_jsonb(public.create_agent_thread('00000000-0000-4000-8000-000000000001', 'Crane costs', true, true));
select throws_ok(format($$select public.set_agent_thread_visibility(%L::uuid, 'project')$$, (select doc ->> 'id' from t where name = 'c')),
  '22023', null, 'sharing it with the project needs the costs shared');
select is((public.set_agent_thread_visibility((select (doc ->> 'id')::uuid from t where name = 'c'), 'project', true)).costs_shared_by,
  '00000000-0000-4000-8000-000000000012'::uuid, 'he shares it, costs and all');
-- The project manager's conversation now holds the cost manager: sharing it with the project would
-- share costs, which she cannot do (she does not see them).
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select throws_ok(format($$select public.set_agent_thread_visibility(%L::uuid, 'project', true)$$, (select doc ->> 'id' from t where name = 'm')),
  '42501', null, 'someone who cannot see costs cannot share them');

-- Shared with the project: everyone reads it.
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select is((public.set_agent_thread_visibility((select (doc ->> 'id')::uuid from t where name = 'p'), 'project')).visibility, 'project', 'its starter shares it');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is((select count(*)::int from public.agent_messages where id = (select (doc ->> 'id')::uuid from t where name = 'pm1')), 1, 'a shared thread is read by every member');
select throws_ok(format($$select public.name_agent_thread(%L::uuid, 'Crane idle days')$$, (select doc ->> 'id' from t where name = 'p')),
  '42501', null, 'browsers cannot use the assistant''s naming');

-- Naming: once by the assistant, never after a person named it.
reset role;
set local role service_role;
select is((public.name_agent_thread((select (doc ->> 'id')::uuid from t where name = 'p'), '"Crane idle days."')).title, 'Crane idle days', 'the assistant names a thread still called by its first words');
select is((public.name_agent_thread((select (doc ->> 'id')::uuid from t where name = 'p'), 'Another name')).id, null, 'only once');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
insert into t select 'q', to_jsonb(public.create_agent_thread('00000000-0000-4000-8000-000000000001', 'First words here', true, true));
select is((public.rename_agent_thread((select (doc ->> 'id')::uuid from t where name = 'q'), 'My name')).title_source, 'person', 'a person''s name');
reset role;
set local role service_role;
select is((public.name_agent_thread((select (doc ->> 'id')::uuid from t where name = 'q'), 'Assistant name')).id, null, 'is never replaced by the assistant');

select * from finish();
rollback;
