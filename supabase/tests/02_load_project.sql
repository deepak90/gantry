-- load_project returns the LoadProjectResult shape and only the revisions after the snapshot.
-- Personas: the demo seed makes every member a full member (20261026040000_one_role.sql); this file
-- puts 11 back as the project manager and 12 as the cost manager of project 01 first, so the
-- membership checks do not depend on the seed.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

update public.project_members set role = 'pm', can_view_costs = false, approval_limit_minor = 0
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000011';
update public.project_members set role = 'cm', can_view_costs = true, approval_limit_minor = 500000
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000012';

create temp table fx as
select gen_random_uuid() as session_pm,
       (select current_revision from public.projects where id = '00000000-0000-4000-8000-000000000001') as base;
grant select on fx to authenticated, service_role;
insert into public.sessions (id, user_id, project_id)
select session_pm, '00000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-000000000001'::uuid from fx;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';

select is(
  (select array_agg(k order by k) from jsonb_object_keys(public.load_project('00000000-0000-4000-8000-000000000001')) k),
  array['current_revision', 'membership', 'project', 'revisions', 'snapshot', 'snapshot_revision'],
  'result has exactly the LoadProjectResult keys');
select is(
  (select array_agg(k order by k)
     from jsonb_object_keys(public.load_project('00000000-0000-4000-8000-000000000001') -> 'project') k),
  array['currency', 'handover_task_id', 'id', 'name'],
  'project has exactly id, name, currency, handover_task_id');
select is(
  public.load_project('00000000-0000-4000-8000-000000000001') -> 'project',
  jsonb_build_object(
    'id', '00000000-0000-4000-8000-000000000001',
    'name', 'Riverside Clinic',
    'currency', 'USD',
    'handover_task_id', (select handover_task_id::text from public.projects where id = '00000000-0000-4000-8000-000000000001')),
  'project values match the seeded row (handover_task_id as text or null)');
select is(
  public.load_project('00000000-0000-4000-8000-000000000001') -> 'membership',
  '{"role":"pm","can_view_costs":false,"approval_limit_minor":0}'::jsonb,
  'pm membership');
select is(jsonb_typeof(public.load_project('00000000-0000-4000-8000-000000000001') -> 'snapshot'), 'object',
  'snapshot is an object');
select is(jsonb_typeof(public.load_project('00000000-0000-4000-8000-000000000001') -> 'revisions'), 'array',
  'revisions is an array');
select is((public.load_project('00000000-0000-4000-8000-000000000001') ->> 'current_revision')::int,
  (select base from fx), 'current_revision matches the project row');
select is((public.load_project('00000000-0000-4000-8000-000000000001') ->> 'snapshot_revision')::int,
  (select snapshot_revision from public.projects where id = '00000000-0000-4000-8000-000000000001'),
  'snapshot_revision matches the project row');

-- two revisions, a snapshot at the head, one more revision -----------------------------------
select lives_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select session_pm from fx), 'lp-1', null,
      '{"tasks":{"updated":[{"id":1,"name":"A"}]}}')$$, 'revision base+1 accepted');
select lives_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select session_pm from fx), 'lp-2', null,
      '{"tasks":{"updated":[{"id":1,"name":"B"}]}}')$$, 'revision base+2 accepted');
select is(
  (select array_agg((r ->> 'revision_no')::int order by ord)
     from jsonb_array_elements(public.load_project('00000000-0000-4000-8000-000000000001') -> 'revisions') with ordinality as t(r, ord)
    where (r ->> 'revision_no')::int > (select base from fx)),
  (select array[base + 1, base + 2] from fx),
  'new revisions are returned ascending by revision_no');
select is(
  (select array_agg(k order by k)
     from jsonb_object_keys(
       (select r from jsonb_array_elements(public.load_project('00000000-0000-4000-8000-000000000001') -> 'revisions') r
         where r ->> 'local_revision_id' = 'lp-1')) k),
  array['actor_user_id', 'changes', 'client_id', 'conflict_resolution_for', 'created_at', 'id',
        'local_revision_id', 'origin', 'project_id', 'revision_no'],
  'each revision is a full ProjectRevisionRow');
-- Only the service role stores a snapshot (20261111050000_payment_integrity.sql), here on the member's behalf.
set local role service_role;
select is(
  public.save_snapshot('00000000-0000-4000-8000-000000000001', (select base + 2 from fx),
    '{"tasksData":[{"id":1,"name":"B"}]}', (select session_pm from fx)),
  true, 'snapshot saved at the head');
set local role authenticated;
select is(public.load_project('00000000-0000-4000-8000-000000000001') -> 'revisions', '[]'::jsonb,
  'after a snapshot at the head no catch-up revisions are returned');
select is(public.load_project('00000000-0000-4000-8000-000000000001') -> 'snapshot', '{"tasksData":[{"id":1,"name":"B"}]}'::jsonb,
  'the saved snapshot is returned');
select lives_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select session_pm from fx), 'lp-3', null,
      '{"tasks":{"updated":[{"id":1,"name":"C"}]}}')$$, 'revision base+3 accepted');
select is(
  (select array_agg((r ->> 'revision_no')::int)
     from jsonb_array_elements(public.load_project('00000000-0000-4000-8000-000000000001') -> 'revisions') r),
  (select array[base + 3] from fx),
  'only revisions after snapshot_revision are returned');

-- cm membership ----------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select is(
  public.load_project('00000000-0000-4000-8000-000000000001') -> 'membership',
  '{"role":"cm","can_view_costs":true,"approval_limit_minor":500000}'::jsonb,
  'cm membership');
reset role;

select * from finish();
rollback;
