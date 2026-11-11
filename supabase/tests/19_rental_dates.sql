-- A machine's dates on a task, in the plan (20261102030000 and 20261102040000): a revision that changes
-- them on a rental's own task updates the booking in the same transaction, a revision that changes them
-- on another task touches no booking, a fix still open must be checked again, nothing changes while money
-- depends on the dates as they stand, a fix's own publication goes through, and plans carry the dates.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.revision(p_no int, p_assignments jsonb) returns void language sql as $$
  insert into public.project_revisions (project_id, revision_no, client_id, local_revision_id, changes)
  values ('00000000-0000-4000-8000-000000000001', 2000 + p_no, '00000000-0000-4000-8000-0000000009dd', 'rental-' || p_no,
          jsonb_build_object('assignments', p_assignments));
$$;
create function pg_temp.crane_dates() returns table (s date, e date) language sql as $$
  select billable_start, billable_end from public.equipment_bookings where id = '00000000-0000-4000-8000-000000000101';
$$;
-- The crane on its task on the seed project: the assignment the rental belongs to.
create temp table t_crane as
  select a.value ->> 'id' as id, b.resource_id, b.task_id
    from public.equipment_bookings b
    join public.projects p on p.id = b.project_id
   cross join lateral jsonb_array_elements(p.snapshot -> 'assignmentsData') a
   where b.id = '00000000-0000-4000-8000-000000000101'
     and a.value ->> 'event' = b.task_id::text and a.value ->> 'resource' = b.resource_id::text;
-- The same project's concrete pump on one of its tasks: no rental there.
create temp table t_pump as
  select a.value ->> 'id' as id
    from public.projects p
   cross join lateral jsonb_array_elements(p.snapshot -> 'assignmentsData') a
   cross join lateral jsonb_array_elements(p.snapshot -> 'resourcesData') r
   where p.id = '00000000-0000-4000-8000-000000000001' and r.value ->> 'name' = 'Concrete pump' and r.value ->> 'id' = a.value ->> 'resource'
   limit 1;

-- The plan carries the dates -------------------------------------------------------------------------
select is(
  (select count(*)::int from public.equipment_bookings b join public.projects p on p.id = b.project_id
     cross join lateral jsonb_array_elements(p.snapshot -> 'assignmentsData') a
    where a.value ->> 'event' = b.task_id::text and a.value ->> 'resource' = b.resource_id::text
      and a.value ->> 'rentalStart' = b.billable_start::text and a.value ->> 'rentalEnd' = b.billable_end::text),
  (select count(*)::int from public.equipment_bookings),
  'every rental''s machine on its task carries its dates');
select is(
  (select count(*)::int from public.demo_seeds d cross join lateral jsonb_array_elements(d.snapshot -> 'assignmentsData') a where a.value ? 'rentalStart'),
  (select count(*)::int from public.equipment_bookings),
  'and so does the plan a reset goes back to');
select is(
  (select count(*)::int from public.projects p cross join lateral jsonb_array_elements(p.snapshot -> 'resourcesData') r where r.value ? 'rentalStart'),
  0, 'machines themselves carry none');
select is(
  (select e.task_id || '/' || e.resource_id from t_crane c, public.plan_assignment_ends('00000000-0000-4000-8000-000000000001', c.id) e),
  (select task_id::text || '/' || resource_id::text from t_crane), 'an assignment''s ends come from the plan');

-- A revision moves the booking -----------------------------------------------------------------------
select lives_ok(
  format($$select pg_temp.revision(1, '{"updated":[{"id":%s,"rentalStart":"2026-12-09","rentalEnd":"2026-12-16"}]}')$$, (select id from t_crane)),
  'a revision changes both dates');
select results_eq('select * from pg_temp.crane_dates()', $$values ('2026-12-09'::date, '2026-12-16'::date)$$, 'and the booking has them');

select lives_ok(
  format($$select pg_temp.revision(2, '{"updated":[{"id":%s,"rentalEnd":"2026-12-17"}]}')$$, (select id from t_crane)),
  'one date can change alone');
select results_eq('select * from pg_temp.crane_dates()', $$values ('2026-12-09'::date, '2026-12-17'::date)$$, 'and the other stays as it was');

select lives_ok(
  format($$select pg_temp.revision(3, '{"$input":{"updated":[{"id":%s,"rentalStart":"2026-12-08"}]}}')$$, (select id from t_crane)),
  'it counts as the user''s input too');
select results_eq('select * from pg_temp.crane_dates()', $$values ('2026-12-08'::date, '2026-12-17'::date)$$, 'where Bryntum also lists it');

select lives_ok(
  format($$select pg_temp.revision(4, '{"updated":[{"id":%s,"rentalStart":"2026-11-01","rentalEnd":"2026-11-02"}]}')$$, (select id from t_pump)),
  'the same project''s other machine has its own dates, with no rental to move');
select lives_ok(
  $$select pg_temp.revision(14, '{"updated":[{"id":99999,"rentalStart":"2026-12-01","rentalEnd":"2026-12-02"}]}')$$,
  'nor does an assignment the plan does not know');
select lives_ok(
  format($$select pg_temp.revision(5, '{"updated":[{"id":%s,"units":50}]}')$$, (select id from t_crane)),
  'nor does any other edit of the assignment');
select results_eq('select * from pg_temp.crane_dates()', $$values ('2026-12-08'::date, '2026-12-17'::date)$$, 'the booking stays');

select throws_ok(
  format($$select pg_temp.revision(6, '{"updated":[{"id":%s,"rentalStart":"2026-12-17"}]}')$$, (select id from t_crane)),
  '22023', null, 'the rental lasts at least a day');
select throws_ok(
  format($$select pg_temp.revision(7, '{"updated":[{"id":%s,"rentalStart":"Dec 1"}]}')$$, (select id from t_crane)),
  '22023', null, 'and dates are dates');

-- A fix still open -------------------------------------------------------------------------------------
insert into public.proposals (id, project_id, booking_id, state, current_version_no)
values ('00000000-0000-4000-8000-0000000002dd', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', 'in_review', 1);
insert into public.proposal_versions (id, project_id, proposal_id, version_no, source_revision, inputs)
values ('00000000-0000-4000-8000-0000000003dd', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000002dd', 1, 0,
        '{"new_start":"2026-12-11","new_end":"2026-12-18"}');
insert into public.approvals (id, project_id, proposal_version_id, approver_id, scope, content_hash, amount_minor, currency, recipient, source_revision)
values ('00000000-0000-4000-8000-0000000004dd', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000003dd',
        '00000000-0000-4000-8000-000000000012', 'payment', 'h', 360000, 'USD', 'supplier@test.local', 0);

select lives_ok(
  format($$select pg_temp.revision(8, '{"updated":[{"id":%s,"rentalStart":"2026-12-10"}]}')$$, (select id from t_crane)),
  'an open fix does not stop an edit');
select is((select stale from public.proposal_versions where id = '00000000-0000-4000-8000-0000000003dd'), true, 'but its check no longer counts');
select is((select status from public.approvals where id = '00000000-0000-4000-8000-0000000004dd'), 'invalidated', 'and neither does its approval');

-- A fix's own publication ---------------------------------------------------------------------------------
-- Its revision carries the machine's dates, but publication_complete writes the booking: the proposal is
-- still approved here, and writing it now would void the approvals being carried out.
update public.proposal_versions set stale = false where id = '00000000-0000-4000-8000-0000000003dd';
update public.approvals set status = 'active', invalidated_at = null, invalidated_reason = null where id = '00000000-0000-4000-8000-0000000004dd';
insert into public.sessions (id, project_id, user_id) values ('00000000-0000-4000-8000-0000000009dd', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011');
insert into public.publications (id, project_id, proposal_version_id, executor_session, status, claimed_by)
values ('00000000-0000-4000-8000-0000000006dd', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000003dd',
        '00000000-0000-4000-8000-0000000009dd', 'pending', '00000000-0000-4000-8000-000000000011');
select lives_ok(
  format($$insert into public.project_revisions (project_id, revision_no, client_id, local_revision_id, changes)
    values ('00000000-0000-4000-8000-000000000001', 2009, '00000000-0000-4000-8000-0000000009dd', 'rental-9',
      '{"tasks":{"updated":[{"id":15,"decisionRef":"00000000-0000-4000-8000-0000000006dd"}]},"assignments":{"updated":[{"id":%s,"rentalStart":"2026-12-11","rentalEnd":"2026-12-18"}]}}')$$, (select id from t_crane)),
  'a publication''s revision goes through');
select results_eq('select * from pg_temp.crane_dates()', $$values ('2026-12-10'::date, '2026-12-17'::date)$$, 'and leaves the booking to the publication');
select is((select status from public.approvals where id = '00000000-0000-4000-8000-0000000004dd'), 'active', 'so its approval still counts');
delete from public.publications where id = '00000000-0000-4000-8000-0000000006dd';

-- Money depends on the dates ------------------------------------------------------------------------------
update public.proposals set state = 'published' where id = '00000000-0000-4000-8000-0000000002dd';
select lives_ok(
  format($$select pg_temp.revision(10, '{"updated":[{"id":%s,"rentalStart":"2026-12-11"}]}')$$, (select id from t_crane)),
  'an approved fix nobody has paid does not hold the dates');
select lives_ok(
  format($$select pg_temp.revision(11, '{"updated":[{"id":%s,"rentalStart":"2026-12-11"}]}')$$, (select id from t_crane)),
  'unchanged dates are not a change, so they are not refused');

insert into public.payment_authorizations (id, project_id, approval_id, proposal_version_id, amount_minor, currency, recipient_email, authorized_by, status)
values ('00000000-0000-4000-8000-0000000005dd', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000004dd',
        '00000000-0000-4000-8000-0000000003dd', 360000, 'USD', 'supplier@test.local', '00000000-0000-4000-8000-000000000012', 'pending');
select throws_ok(
  format($$select pg_temp.revision(12, '{"updated":[{"id":%s,"rentalStart":"2026-12-12"}]}')$$, (select id from t_crane)),
  '55006', null, 'PayPal paying for the rental does');

update public.payment_authorizations set status = 'succeeded' where id = '00000000-0000-4000-8000-0000000005dd';
select lives_ok(
  format($$select pg_temp.revision(13, '{"updated":[{"id":%s,"rentalStart":"2026-12-11"}]}')$$, (select id from t_crane)),
  'once PayPal has paid, the dates are free again');
select results_eq('select * from pg_temp.crane_dates()', $$values ('2026-12-11'::date, '2026-12-17'::date)$$, 'and the booking follows');

-- Reset ----------------------------------------------------------------------------------------------------
set local role service_role;
select lives_ok($$select public.reset_demo('00000000-0000-4000-8000-000000000001')$$, 'the demo reset runs');
reset role;
select results_eq('select * from pg_temp.crane_dates()', $$values ('2026-12-07'::date, '2026-12-18'::date)$$, 'and puts the rental back');
select is(
  (select a.value ->> 'rentalStart' from public.projects p cross join lateral jsonb_array_elements(p.snapshot -> 'assignmentsData') a
    where p.id = '00000000-0000-4000-8000-000000000001' and a.value ->> 'id' = (select id from t_crane)),
  '2026-12-07', 'with the plan''s dates matching');

select * from finish();
rollback;
