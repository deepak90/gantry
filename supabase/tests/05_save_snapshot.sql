-- save_snapshot: compare-and-set on current_revision; caller must own the session and be a member. Members can no
-- longer call it themselves (20261111050000_payment_integrity.sql): only the service role, on a member's behalf.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create temp table fx as
select gen_random_uuid() as session_pm,
       gen_random_uuid() as session_cm,
       gen_random_uuid() as session_outsider,
       (select current_revision  from public.projects where id = '00000000-0000-4000-8000-000000000001') as base,
       (select snapshot_revision from public.projects where id = '00000000-0000-4000-8000-000000000001') as snap0,
       (select snapshot          from public.projects where id = '00000000-0000-4000-8000-000000000001') as snapshot0;
grant select on fx to authenticated, service_role;
insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at, is_sso_user, is_anonymous)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000aa', 'authenticated', 'authenticated',
        'outsider@test.local', now(), now(), false, false);
insert into public.sessions (id, user_id, project_id)
select session_pm, '00000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-000000000001'::uuid from fx
union all
select session_cm, '00000000-0000-4000-8000-000000000012'::uuid, '00000000-0000-4000-8000-000000000001'::uuid from fx;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select lives_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select session_pm from fx), 'snap-1', null,
      '{"tasks":{"updated":[{"id":1,"name":"x"}]}}')$$, 'one revision accepted (head = base+1)');
select throws_ok(
  $$select public.save_snapshot('00000000-0000-4000-8000-000000000001', (select base + 1 from fx), '{"tasksData":[]}', (select session_pm from fx))$$,
  '42501', 'permission denied for function save_snapshot', 'a member cannot store a plan themselves');

-- The service role, on the member's behalf ------------------------------------------------------
set local role service_role;
select is(
  public.save_snapshot('00000000-0000-4000-8000-000000000001', (select base from fx), '{"tasksData":[]}', (select session_pm from fx)),
  false, 'a stale revision is rejected');
select is((select snapshot_revision from public.projects where id = '00000000-0000-4000-8000-000000000001'),
  (select snap0 from fx), 'a rejected snapshot leaves snapshot_revision alone');
select is((select snapshot from public.projects where id = '00000000-0000-4000-8000-000000000001'),
  (select snapshot0 from fx), 'a rejected snapshot leaves the snapshot alone');
select is(
  public.save_snapshot('00000000-0000-4000-8000-000000000001', (select base + 5 from fx), '{"tasksData":[]}', (select session_pm from fx)),
  false, 'a revision ahead of the head is rejected');

select throws_ok(
  $$select public.save_snapshot('00000000-0000-4000-8000-000000000001', (select base + 1 from fx), '{"tasksData":[]}', (select session_cm from fx))$$,
  '42501', null, 'a session owned by another user is rejected');
select throws_ok(
  $$select public.save_snapshot('00000000-0000-4000-8000-000000000001', (select base + 1 from fx), '{"tasksData":[]}', gen_random_uuid())$$,
  '42501', null, 'an unknown session is rejected');
select throws_ok(
  $$select public.save_snapshot('00000000-0000-4000-8000-000000000001', (select base + 1 from fx), '[]'::jsonb, (select session_pm from fx))$$,
  '22023', null, 'the snapshot must be a JSON object');
select throws_ok(
  $$select public.save_snapshot('00000000-0000-4000-8000-000000000001', -1, '{"tasksData":[]}', (select session_pm from fx))$$,
  '22023', null, 'a negative revision is rejected');

select is(
  public.save_snapshot('00000000-0000-4000-8000-000000000001', (select base + 1 from fx),
    '{"tasksData":[{"id":1,"name":"x"}],"dependenciesData":[]}', (select session_pm from fx)),
  true, 'the head revision is accepted');
select is((select snapshot_revision from public.projects where id = '00000000-0000-4000-8000-000000000001'),
  (select base + 1 from fx), 'snapshot_revision is updated');
select is((select snapshot from public.projects where id = '00000000-0000-4000-8000-000000000001'),
  '{"tasksData":[{"id":1,"name":"x"}],"dependenciesData":[]}'::jsonb, 'snapshot is stored');

-- non-member ---------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
select throws_ok(
  $$select public.save_snapshot('00000000-0000-4000-8000-000000000001', (select base + 1 from fx), '{"tasksData":[]}', (select session_pm from fx))$$,
  '42501', null, 'a non-member is rejected');
reset role;
set local role anon;
select throws_ok(
  $$select public.save_snapshot('00000000-0000-4000-8000-000000000001', 0, '{"tasksData":[]}', gen_random_uuid())$$,
  '42501', null, 'anon is rejected');
reset role;

select * from finish();
rollback;
