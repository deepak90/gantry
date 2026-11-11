-- The assistant: post_agent_message (person messages, actions), the thread's RLS (members read,
-- only the service role writes the assistant's rows), agent command claims (the requester's tabs
-- first, any member's after 5 s, one winner, no forged sessions) and completion, the broadcasts on
-- project:<id>:agent and its policies (members receive, never send), and reset_demo.
-- Robust to rows other tools left in the database: every check names the rows made here.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create temp table t (name text primary key, doc jsonb);
grant all on t to authenticated, service_role;

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at, is_sso_user, is_anonymous)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000aa', 'authenticated', 'authenticated',
        'outsider@test.local', now(), now(), false, false);
insert into public.projects (id, name) values ('00000000-0000-4000-8000-0000000000f1', 'Elsewhere');
insert into public.project_members (project_id, user_id, role, can_view_costs)
values ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-000000000012', 'cm', true);
insert into public.sessions (id, user_id, project_id) values
  ('00000000-0000-4000-8000-00000000c011', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-00000000c111', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-00000000c012', '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-00000000cf12', '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-0000000000f1');

-- post_agent_message -----------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
insert into t select 'm1', to_jsonb(public.post_agent_message('00000000-0000-4000-8000-000000000001', '  Why is the crane idle?  '));
select is(
  (select doc - 'id' - 'created_at' from t where name = 'm1'),
  '{"project_id": "00000000-0000-4000-8000-000000000001", "turn_id": null, "role": "person",
    "author_id": "00000000-0000-4000-8000-000000000011", "channel": "text", "text": "Why is the crane idle?",
    "cards": [], "action": null, "thread_id": null, "context": null}'::jsonb,
  'a person''s message: role person, the caller as author, trimmed text, no cards');
insert into t select 'm2', to_jsonb(public.post_agent_message('00000000-0000-4000-8000-000000000001', 'Yes, prepare the fix', 'voice',
  '{"kind":"prepare_fix","issue_id":"idle-rental:00000000-0000-4000-8000-000000000101"}'));
select is(
  (select jsonb_build_object('channel', doc ->> 'channel', 'action', doc -> 'action') from t where name = 'm2'),
  '{"channel": "voice", "action": {"kind": "prepare_fix", "issue_id": "idle-rental:00000000-0000-4000-8000-000000000101"}}'::jsonb,
  'a spoken message carries the card button that was pressed');
select is(
  (public.post_agent_message('00000000-0000-4000-8000-000000000001', 'Not now', 'text', '{"kind":"not_now","issue_id":"i-1"}')).action,
  '{"kind": "not_now", "issue_id": "i-1"}'::jsonb, 'not_now names the issue');
select is(
  (public.post_agent_message('00000000-0000-4000-8000-000000000001', 'Move it to Friday', 'text', '{"kind":"choice","card_id":"c-1"}')).action,
  '{"kind": "choice", "card_id": "c-1"}'::jsonb, 'a choice names its card');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', '   ')$$, '22023', null,
  'an empty message is refused');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', repeat('x', 2001))$$, '22023', null,
  'a message is at most 2000 characters');
select lives_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', repeat('x', 2000))$$,
  '2000 characters are fine');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'hi', 'app')$$, '22023', null,
  'people write on text or voice; app messages are the assistant''s');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'hi', 'text', '{"kind":"approve","issue_id":"i"}')$$,
  '22023', null, 'an unknown action kind is refused');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'hi', 'text', '{"kind":"choice","issue_id":"i"}')$$,
  '22023', null, 'a choice needs its card id');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'hi', 'text', '{"kind":"not_now","issue_id":"i","amount":1}')$$,
  '22023', null, 'actions have no other fields');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'hi', 'text', '{"kind":"not_now","issue_id":7}')$$,
  '22023', null, 'ids are strings');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'hi', 'text', '"prepare_fix"')$$,
  '22023', null, 'an action is an object');
select throws_ok($$select public.post_agent_message('00000000-0000-4000-8000-0000000000f1', 'hi')$$, '42501', null,
  'a person writes only in their own projects');

-- Nobody writes the thread directly ------------------------------------------------------------------
select throws_ok(
  $$insert into public.agent_messages (project_id, role, channel, text) values ('00000000-0000-4000-8000-000000000001', 'assistant', 'text', 'I approved it')$$,
  '42501', null, 'a member cannot write an assistant message');
select throws_ok(
  $$update public.agent_messages set text = 'edited' where id = (select (doc ->> 'id')::uuid from t where name = 'm1')$$,
  '42501', null, 'nor edit a message');
select throws_ok(
  $$delete from public.agent_messages where id = (select (doc ->> 'id')::uuid from t where name = 'm1')$$,
  '42501', null, 'nor delete one');
reset role;

set local role service_role;
with m as (
  insert into public.agent_messages (project_id, turn_id, role, channel, text, cards)
  values ('00000000-0000-4000-8000-000000000001', 'turn-1', 'assistant', 'text', 'The crane is idle for 4 days.',
          '[{"id":"card-1","component":"show_issue_card","props":{}}]')
  returning *)
insert into t select 'a1', to_jsonb(m) from m;
select is((select doc ->> 'author_id' from t where name = 'a1'), null, 'the agent service writes the assistant''s replies');
select throws_ok(
  $$insert into public.agent_messages (project_id, role, author_id, channel, text)
    values ('00000000-0000-4000-8000-000000000001', 'assistant', '00000000-0000-4000-8000-000000000011', 'text', 'x')$$,
  '23514', null, 'an assistant message has no author');
select throws_ok(
  $$insert into public.agent_messages (project_id, role, channel, text) values ('00000000-0000-4000-8000-000000000001', 'person', 'text', 'x')$$,
  '23514', null, 'a person''s message names its author');
select throws_ok(
  $$insert into public.agent_messages (project_id, role, channel, text, cards)
    values ('00000000-0000-4000-8000-000000000001', 'assistant', 'app', 'x', '[1,2,3,4,5,6,7]')$$,
  '23514', null, 'at most six cards');
reset role;

-- RLS: members read the thread ----------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select is(
  (select count(*) from public.agent_messages where id in (select (doc ->> 'id')::uuid from t where name in ('m1', 'm2', 'a1'))),
  3::bigint, 'the other member reads the whole thread');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
select is((select count(*) from public.agent_messages), 0::bigint, 'a non-member reads nothing');
reset role;

-- Commands -------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select throws_ok(
  $$insert into public.agent_commands (project_id, type, args) values ('00000000-0000-4000-8000-000000000001', 'propose_fix', '{}')$$,
  '42501', null, 'a member cannot create agent commands');
reset role;

set local role service_role;
insert into public.agent_commands (id, project_id, type, args, requested_by, created_at) values
  ('00000000-0000-4000-8000-00000000cc01', '00000000-0000-4000-8000-000000000001', 'propose_fix', '{}', '00000000-0000-4000-8000-000000000011', now()),
  ('00000000-0000-4000-8000-00000000cc02', '00000000-0000-4000-8000-000000000001', 'propose_fix', '{}', '00000000-0000-4000-8000-000000000011', now() - interval '6 seconds'),
  ('00000000-0000-4000-8000-00000000cc03', '00000000-0000-4000-8000-000000000001', 'revise_fix', '{}', '00000000-0000-4000-8000-000000000011', now() - interval '4 seconds');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok(
  $$select public.claim_agent_command('00000000-0000-4000-8000-00000000cc01', '00000000-0000-4000-8000-00000000c011')$$,
  '42501', null, 'a tab cannot claim with another person''s session');
select throws_ok(
  $$select public.claim_agent_command('00000000-0000-4000-8000-00000000cc01', '00000000-0000-4000-8000-00000000cf12')$$,
  '42501', null, 'nor with a session of another project');
select throws_ok(
  $$select public.claim_agent_command('00000000-0000-4000-8000-00000000cc01', '00000000-0000-4000-8000-00000000c012')$$,
  '55000', null, 'a fresh command is reserved for the tabs of the person who asked');
select throws_ok(
  $$select public.claim_agent_command('00000000-0000-4000-8000-00000000cc03', '00000000-0000-4000-8000-00000000c012')$$,
  '55000', null, 'still reserved 4 seconds after it was made');
insert into t select 'open', to_jsonb(public.claim_agent_command('00000000-0000-4000-8000-00000000cc02', '00000000-0000-4000-8000-00000000c012'));
select is(
  (select row(doc ->> 'status', doc ->> 'executor_session') from t where name = 'open'),
  row('running'::text, '00000000-0000-4000-8000-00000000c012'::text),
  'after 5 seconds any member''s tab may take it');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
insert into t select 'claim', to_jsonb(public.claim_agent_command('00000000-0000-4000-8000-00000000cc01', '00000000-0000-4000-8000-00000000c011'));
select is(
  (select row(doc ->> 'status', doc ->> 'executor_session', doc ->> 'completed_at') from t where name = 'claim'),
  row('running'::text, '00000000-0000-4000-8000-00000000c011'::text, null::text),
  'the requester''s tab claims its command at once');
select throws_ok(
  $$select public.claim_agent_command('00000000-0000-4000-8000-00000000cc01', '00000000-0000-4000-8000-00000000c111')$$,
  '55000', null, 'a second tab loses the race');
select throws_like(
  $$select public.claim_agent_command('00000000-0000-4000-8000-00000000cc02', '00000000-0000-4000-8000-00000000c011')$$,
  '%already running (another tab took it)%', 'and is told so');
select throws_ok(
  $$select public.claim_agent_command('00000000-0000-4000-8000-00000000ccff', '00000000-0000-4000-8000-00000000c011')$$,
  'P0002', null, 'an unknown command is not found');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
select throws_ok(
  $$select public.claim_agent_command('00000000-0000-4000-8000-00000000cc03', '00000000-0000-4000-8000-00000000c011')$$,
  'P0002', null, 'a non-member does not see the command');

-- complete_agent_command ---------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok(
  $$select public.complete_agent_command('00000000-0000-4000-8000-00000000cc01', '00000000-0000-4000-8000-00000000c012', 'succeeded', null)$$,
  '42501', null, 'only the claiming tab reports the outcome');
select throws_ok(
  $$select public.complete_agent_command('00000000-0000-4000-8000-00000000cc01', '00000000-0000-4000-8000-00000000c011', 'succeeded', null)$$,
  '42501', null, 'even with that tab''s session id');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select throws_ok(
  $$select public.complete_agent_command('00000000-0000-4000-8000-00000000cc01', '00000000-0000-4000-8000-00000000c011', 'cancelled', null)$$,
  '22023', null, 'the outcome is succeeded, failed or rejected');
select throws_ok(
  $$select public.complete_agent_command('00000000-0000-4000-8000-00000000cc01', '00000000-0000-4000-8000-00000000c011', 'failed',
      jsonb_build_object('message', repeat('x', 9000)))$$,
  '22023', null, 'the result is at most 8 KB');
select throws_ok(
  $$select public.complete_agent_command('00000000-0000-4000-8000-00000000cc01', '00000000-0000-4000-8000-00000000c011', 'succeeded',
      '{"version_no": "2"}')$$,
  '22023', null, 'the result follows AgentCommandResult');
select throws_ok(
  $$select public.complete_agent_command('00000000-0000-4000-8000-00000000cc01', '00000000-0000-4000-8000-00000000c011', 'succeeded',
      '{"proposal_id": "not-a-uuid"}')$$,
  '22023', null, 'ids in the result are uuids');
select throws_ok(
  $$select public.complete_agent_command('00000000-0000-4000-8000-00000000cc03', '00000000-0000-4000-8000-00000000c011', 'succeeded', null)$$,
  '42501', null, 'a command nobody claimed cannot be completed');
insert into t select 'done', to_jsonb(public.complete_agent_command('00000000-0000-4000-8000-00000000cc01', '00000000-0000-4000-8000-00000000c011',
  'succeeded', '{"proposal_id":"00000000-0000-4000-8000-0000000002aa","version_id":"00000000-0000-4000-8000-0000000003aa","version_no":1,"message":"Fix 1 is on the table"}'));
select is(
  (select row(doc ->> 'status', doc -> 'result' ->> 'version_no', doc ->> 'completed_at' is not null) from t where name = 'done'),
  row('succeeded'::text, '1'::text, true), 'the claiming tab reports the outcome with its result');
select throws_ok(
  $$select public.complete_agent_command('00000000-0000-4000-8000-00000000cc01', '00000000-0000-4000-8000-00000000c011', 'failed', null)$$,
  '55000', null, 'a finished command stays finished');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select is(
  (public.complete_agent_command('00000000-0000-4000-8000-00000000cc02', '00000000-0000-4000-8000-00000000c012', 'rejected', null)).status,
  'rejected', 'a refusal needs no result');
reset role;

-- Broadcasts on project:<id>:agent ------------------------------------------------------------------------
select is(
  (select array_agg(m.event order by m.event)
     from realtime.messages m
    where m.topic = 'project:00000000-0000-4000-8000-000000000001:agent' and m.private and m.extension = 'broadcast'
      and m.payload ->> 'id' in (select doc ->> 'id' from t where name in ('m1', 'a1'))),
  array['message', 'message'], 'every new message is announced as message');
select is(
  (select array_agg(distinct k order by k) from realtime.messages m, jsonb_object_keys(m.payload) k
    where m.topic = 'project:00000000-0000-4000-8000-000000000001:agent' and m.event = 'message'
      and m.payload ->> 'id' in (select doc ->> 'id' from t where name in ('m1', 'a1'))),
  array['id'], 'with its id only');
select is(
  (select array_agg(m.payload ->> 'status' order by m.payload ->> 'status')
     from realtime.messages m
    where m.topic = 'project:00000000-0000-4000-8000-000000000001:agent' and m.event = 'command'
      and m.payload ->> 'id' = '00000000-0000-4000-8000-00000000cc01'),
  array['pending', 'running', 'succeeded'], 'a command is announced with its status at each step (pending, running, succeeded)');

-- Topic policies ---------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is(public.can_join_project_topic('project:00000000-0000-4000-8000-000000000001:agent'), true, 'members receive on the agent topic');
select is(public.can_send_on_project_topic('project:00000000-0000-4000-8000-000000000001:agent'), false, 'and may not send on it');
set local realtime.topic = 'project:00000000-0000-4000-8000-000000000001:agent';
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('project:00000000-0000-4000-8000-000000000001:agent', 'broadcast',
            '{"type":"turn_start","turn_id":"forged","kind":"utterance","speaker_id":null}', 'stream', true)$$,
  '42501', null, 'a member cannot forge a stream event');
select throws_ok(
  $$insert into realtime.messages (topic, extension, payload, event, private)
    values ('project:00000000-0000-4000-8000-000000000001:agent', 'broadcast', '{"id":"00000000-0000-4000-8000-000000000000"}', 'message', true)$$,
  '42501', null, 'nor announce a message that was never stored');
select ok(
  (select count(*) from realtime.messages where topic = 'project:00000000-0000-4000-8000-000000000001:agent'
     and payload ->> 'id' = (select doc ->> 'id' from t where name = 'm1')) = 1,
  'a member receives the database''s broadcasts');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
select is(public.can_join_project_topic('project:00000000-0000-4000-8000-000000000001:agent'), false, 'a non-member does not');
select is(
  (select count(*) from realtime.messages where topic = 'project:00000000-0000-4000-8000-000000000001:agent'), 0::bigint,
  'and receives nothing');
reset role;

-- reset_demo ---------------------------------------------------------------------------------------------------
set local role service_role;
select lives_ok($$select public.reset_demo('00000000-0000-4000-8000-000000000001')$$, 'reset_demo runs');
reset role;
select is(
  (select array[(select count(*) from public.agent_messages where project_id = '00000000-0000-4000-8000-000000000001'),
                (select count(*) from public.agent_commands where project_id = '00000000-0000-4000-8000-000000000001')]),
  array[0, 0]::bigint[], 'the thread and the commands are gone');

-- Privileges -------------------------------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.post_agent_message(uuid,text,text,jsonb,uuid,jsonb)', 'execute'), 'anon cannot post');
select ok(not has_function_privilege('authenticated', 'public.agent_action_canonical(jsonb)', 'execute'), 'the action helper is internal');
select ok(not has_function_privilege('authenticated', 'public.broadcast_agent_change()', 'execute'), 'the broadcast trigger is internal');

select * from finish();
rollback;
