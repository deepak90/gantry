-- Plain-English rules, several rentals on a project, and invoices
-- (20261102010000_rules_rentals_invoices.sql): a rule can be any or all of a few conditions, can
-- remember the conversation it was drafted in, and can prepare an invoice; the seed test project and Cedar Park
-- stay out of the project menu; a reset restores every rental of a project and clears its invoices; an
-- invoice is prepared once per floor by someone who sees costs, adds up, goes to the project's client,
-- and only the service role marks it sent or paid.
-- Personas: 12 sees costs on Harbor Street Offices; 11 is made someone who cannot, first.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

update public.project_members set can_view_costs = false
 where project_id = '00000000-0000-4000-8000-000000000002' and user_id = '00000000-0000-4000-8000-000000000011';

create temp table t (name text primary key, doc jsonb);
grant all on t to authenticated, service_role;

select is((select listed from public.projects where id = '00000000-0000-4000-8000-000000000001'), false, 'the tests'' project is not in the project menu');
select is((select listed from public.projects where id = '00000000-0000-4000-8000-000000000004'), false, 'nor is Cedar Park Clinic: only Harbor Street Offices is');
select is((select count(*)::int from public.equipment_bookings where project_id = '00000000-0000-4000-8000-000000000004'), 4, 'Cedar Park Clinic has four rentals');
select is((select jsonb_array_length(bookings) from public.demo_seeds where project_id = '00000000-0000-4000-8000-000000000004'), 4, 'and its seed keeps all four');

-- Rules ------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';

insert into t select 'thread', to_jsonb(public.create_agent_thread('00000000-0000-4000-8000-000000000004', 'Rentals'));
insert into t select 'any', to_jsonb(public.save_watch_rule(
  '00000000-0000-4000-8000-000000000004', null, 'Idle or booked twice', '{"kind":"plan"}'::jsonb,
  '{"kind":"any","of":[{"kind":"idle_rental"},{"kind":"crew_overbooked","equipment_only":true}]}'::jsonb,
  true, '{"kind":"change"}'::jsonb, '{"kind":"ask_assistant"}'::jsonb, (select (doc ->> 'id')::uuid from t where name = 'thread')));
select is((select doc -> 'condition' ->> 'kind' from t where name = 'any'), 'any', 'a rule can be any of a few conditions');
select is((select doc ->> 'thread_id' from t where name = 'any'), (select doc ->> 'id' from t where name = 'thread'), 'and remembers the conversation it was drafted in');

insert into t select 'bill', to_jsonb(public.save_watch_rule(
  '00000000-0000-4000-8000-000000000002', null, 'Bill the tenant', '{"kind":"tasks","task_ids":[211]}'::jsonb,
  '{"kind":"all_done"}'::jsonb, true, '{"kind":"change"}'::jsonb, '{"kind":"prepare_invoice"}'::jsonb));
select is((select doc -> 'action' ->> 'kind' from t where name = 'bill'), 'prepare_invoice', 'a rule can prepare an invoice');

select throws_ok(
  $$ select public.save_watch_rule('00000000-0000-4000-8000-000000000002', null, 'Elsewhere', '{"kind":"plan"}'::jsonb, '{"kind":"all_done"}'::jsonb, true, '{"kind":"change"}'::jsonb, '{"kind":"alert"}'::jsonb, (select (doc ->> 'id')::uuid from t where name = 'thread')) $$,
  'P0002', null, 'a rule cannot point at another project''s conversation');
select throws_ok(
  $$ select public.save_watch_rule('00000000-0000-4000-8000-000000000002', null, 'Bad', '{"kind":"plan"}'::jsonb, '{"kind":"made_up"}'::jsonb) $$,
  '23514', null, 'a condition must be one the app knows');

-- Invoices ---------------------------------------------------------------------------------------
select throws_ok(
  $$ select public.prepare_invoice('00000000-0000-4000-8000-000000000004', 200, null, 'No client here', '[{"label":"Work","amount_minor":100}]'::jsonb) $$,
  '22023', null, 'a project without a client bills nobody');
select throws_ok(
  $$ select public.prepare_invoice('00000000-0000-4000-8000-000000000002', 200, null, 'Empty', '[]'::jsonb) $$,
  '22023', null, 'an invoice has lines');
select throws_ok(
  $$ select public.prepare_invoice('00000000-0000-4000-8000-000000000002', 200, null, 'Free', '[{"label":"Work","amount_minor":0}]'::jsonb) $$,
  '22023', null, 'each line has an amount above zero');

insert into t select 'inv', to_jsonb(public.prepare_invoice('00000000-0000-4000-8000-000000000002', 200, null, 'Level 2: finished work',
  '[{"label":"Install light fixtures","amount_minor":620000},{"label":"Test light fixtures","amount_minor":140000}]'::jsonb));
select is((select (doc ->> 'amount_minor')::bigint from t where name = 'inv'), 760000::bigint, 'the total is the sum of its lines');
select is((select doc ->> 'client_name' from t where name = 'inv'), 'Larkspur Analytics', 'it goes to the project''s client');
select is((select doc ->> 'status' from t where name = 'inv'), 'draft', 'and waits for a person to send it');

insert into t select 'again', to_jsonb(public.prepare_invoice('00000000-0000-4000-8000-000000000002', 200, null, 'Again', '[{"label":"Other","amount_minor":5}]'::jsonb));
select is((select doc ->> 'id' from t where name = 'again'), (select doc ->> 'id' from t where name = 'inv'), 'a floor has one invoice: preparing it again returns it');

select is((select count(*)::int from public.invoices where project_id = '00000000-0000-4000-8000-000000000002'), 1, 'someone who sees costs reads it');
select throws_ok(
  $$ update public.invoices set status = 'paid' $$,
  '42501', null, 'only the service marks an invoice sent or paid');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is((select count(*)::int from public.invoices where project_id = '00000000-0000-4000-8000-000000000002'), 0, 'someone who cannot see costs does not read it');
select throws_ok(
  $$ select public.prepare_invoice('00000000-0000-4000-8000-000000000002', 300, null, 'Level 3', '[{"label":"Work","amount_minor":100}]'::jsonb) $$,
  '42501', null, 'and cannot bill the client');
select is((public.project_client('00000000-0000-4000-8000-000000000002') ->> 'email'), null, 'and does not get the client''s address');

reset role;
select ok(not has_function_privilege('anon', 'public.prepare_invoice(uuid,bigint,uuid,text,jsonb)', 'execute'), 'anon cannot prepare invoices');

-- Reset ------------------------------------------------------------------------------------------
update public.equipment_bookings set billable_start = '2027-02-08', billable_end = '2027-02-16'
 where id = '00000000-0000-4000-8000-000000000401';
update public.equipment_bookings set billable_start = '2027-01-25', billable_end = '2027-01-28'
 where id = '00000000-0000-4000-8000-000000000402';
select public.reset_demo('00000000-0000-4000-8000-000000000004');
select is((select billable_start::text from public.equipment_bookings where id = '00000000-0000-4000-8000-000000000401'), '2027-02-01', 'a reset restores the first rental');
select is((select billable_start::text from public.equipment_bookings where id = '00000000-0000-4000-8000-000000000402'), '2027-01-21', 'and the others');

select public.reset_demo('00000000-0000-4000-8000-000000000002');
select is((select count(*)::int from public.invoices where project_id = '00000000-0000-4000-8000-000000000002'), 0, 'a reset clears the invoices');

select * from finish();
rollback;
