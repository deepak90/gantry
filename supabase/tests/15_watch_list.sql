-- The watch list: no starter rules (a fresh plan raises nothing), rules any member adds with a trigger
-- and an action and only their author or a project manager changes or removes, shape checks on scope,
-- condition, trigger and action, runs the assistant service writes and members read (one open run per
-- situation; changing a rule closes them), dismissals shared and given once, RLS, and reset_demo
-- clearing the rules.
-- Personas: the demo seed makes every member a full member (20261026040000_one_role.sql); this file
-- puts 11 back as the project manager and 12 as the cost manager of project 01 first, so "a project
-- manager pauses and removes anyone's rule" is proven with a real project manager.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

update public.project_members set role = 'pm', can_view_costs = false, approval_limit_minor = 0
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000011';
update public.project_members set role = 'cm', can_view_costs = true, approval_limit_minor = 500000
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000012';

create temp table t (name text primary key, doc jsonb);
grant all on t to authenticated, service_role;

select is((select count(*)::int from public.watch_rules where project_id = '00000000-0000-4000-8000-000000000001' and created_by is null), 0,
  'no starter rules: only people add rules');

-- 12 (cost manager) adds a rule; 11 (project manager) may change it.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
insert into t select 'r1', to_jsonb(public.save_watch_rule('00000000-0000-4000-8000-000000000001', null, '  Pad pours late  ',
  '{"kind":"tasks","task_ids":[15]}', '{"kind":"finish_slip","days":2}'));
select is((select doc ->> 'name' from t where name = 'r1'), 'Pad pours late', 'a member adds a rule; the name is trimmed');
select is((select doc ->> 'created_by' from t where name = 'r1'), '00000000-0000-4000-8000-000000000012', 'its author is the caller');
select is((select doc -> 'trigger' from t where name = 'r1'), '{"kind":"change"}'::jsonb, 'it is checked on every change by default');
select is((select doc -> 'action' from t where name = 'r1'), '{"kind":"alert"}'::jsonb, 'and shows an alert by default');
insert into t select 'r2', to_jsonb(public.save_watch_rule('00000000-0000-4000-8000-000000000001', null, 'Idle crane',
  '{"kind":"plan"}', '{"kind":"idle_rental"}', true, '{"kind":"daily","at":"07:30"}', '{"kind":"ask_assistant","note":"Suggest alternatives"}'));
select is((select doc -> 'action' ->> 'kind' from t where name = 'r2'), 'ask_assistant', 'a rule can ask the assistant');
select throws_ok($$select public.save_watch_rule('00000000-0000-4000-8000-000000000001', null, 'x', '{"kind":"room"}', '{"kind":"idle_rental"}')$$,
  '23514', null, 'an unknown scope is refused');
select throws_ok($$select public.save_watch_rule('00000000-0000-4000-8000-000000000001', null, 'x', '{"kind":"plan"}', '{"kind":"weather"}')$$,
  '23514', null, 'an unknown condition is refused');
select lives_ok($$select public.save_watch_rule('00000000-0000-4000-8000-000000000001', null, 'Soon', '{"kind":"plan"}', '{"kind":"starts_soon","days":5}')$$,
  'work starting soon is a condition');
select throws_ok($$select public.save_watch_rule('00000000-0000-4000-8000-000000000001', null, 'x', '{"kind":"plan"}', '{"kind":"idle_rental"}', true, '{"kind":"daily","at":"25:00"}')$$,
  '23514', null, 'a daily time is a real time');
select throws_ok($$select public.save_watch_rule('00000000-0000-4000-8000-000000000001', null, 'x', '{"kind":"plan"}', '{"kind":"idle_rental"}', true, '{"kind":"change"}', '{"kind":"email"}')$$,
  '23514', null, 'an unknown action is refused');
select throws_ok($$select public.save_watch_rule('00000000-0000-4000-8000-000000000001', null, '  ', '{"kind":"plan"}', '{"kind":"idle_rental"}')$$,
  '22023', null, 'a rule needs a name');
select throws_ok($$insert into public.watch_rules (project_id, name, scope, condition) values ('00000000-0000-4000-8000-000000000001', 'x', '{"kind":"plan"}', '{"kind":"idle_rental"}')$$,
  '42501', null, 'nobody writes the rules directly');

-- Runs: the assistant service writes them; members read them; one open run per situation.
reset role;
set local role service_role;
insert into public.watch_runs (project_id, rule_id, situation, fingerprint, severity, title, task_ids, revision)
select '00000000-0000-4000-8000-000000000001', (doc ->> 'id')::uuid, 'r1:15', 'r1:15:3', 'medium', 'Pour spread footings finishes 3 days later than planned', '{15}', 4
  from t where name = 'r1';
select throws_ok(
  format($$insert into public.watch_runs (project_id, rule_id, situation, fingerprint, severity, title) values ('00000000-0000-4000-8000-000000000001', %L, 'r1:15', 'r1:15:4', 'medium', 'again')$$,
    (select doc ->> 'id' from t where name = 'r1')),
  '23505', null, 'a situation has one open run');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is((select count(*)::int from public.watch_runs where situation = 'r1:15'), 1, 'members read the runs');
select throws_ok($$insert into public.watch_runs (project_id, rule_id, situation, fingerprint, severity, title) select project_id, rule_id, 'x', 'x', 'low', 'x' from public.watch_runs limit 1$$,
  '42501', null, 'but do not write them');

-- Dismissals: any member, once.
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
insert into t select 'd1', to_jsonb(public.dismiss_watch_alert((select (doc ->> 'id')::uuid from t where name = 'r1'), 'r1:15:3'));
select is((select doc ->> 'dismissed_by' from t where name = 'd1'), '00000000-0000-4000-8000-000000000012', 'a member dismisses an alert');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is((public.dismiss_watch_alert((select (doc ->> 'id')::uuid from t where name = 'r1'), 'r1:15:3')).dismissed_by,
  '00000000-0000-4000-8000-000000000012'::uuid, 'dismissing it again keeps the first dismissal');
select is((public.save_watch_rule('00000000-0000-4000-8000-000000000001', (select (doc ->> 'id')::uuid from t where name = 'r1'), 'Pad pours late', '{"kind":"tasks","task_ids":[15]}', '{"kind":"finish_slip","days":2}', false)).enabled,
  false, 'a project manager pauses anyone''s rule');
select is((select count(*)::int from public.watch_runs where situation = 'r1:15' and resolved_at is null), 0, 'a changed rule closes its open runs');
select is(public.delete_watch_rule((select (doc ->> 'id')::uuid from t where name = 'r1')), (select (doc ->> 'id')::uuid from t where name = 'r1'),
  'and removes it');
select is((select count(*)::int from public.watch_dismissals where fingerprint = 'r1:15:3'), 0, 'its dismissals go with it');
select is((select count(*)::int from public.watch_runs where situation = 'r1:15'), 0, 'and so do its runs');
reset role;

set local role service_role;
select lives_ok($$select public.reset_demo('00000000-0000-4000-8000-000000000001')$$, 'reset_demo runs');
select is((select count(*)::int from public.watch_rules where project_id = '00000000-0000-4000-8000-000000000001'), 0,
  'after a reset the project watches nothing again');
reset role;

select ok(not has_function_privilege('anon', 'public.save_watch_rule(uuid,uuid,text,jsonb,jsonb,boolean,jsonb,jsonb,uuid)', 'execute'), 'anon cannot add rules');
select ok(not has_function_privilege('authenticated', 'public.seed_watch_rules(uuid)', 'execute'), 'clearing the rules is internal');

select * from finish();
rollback;
