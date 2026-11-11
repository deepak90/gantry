-- The payment lock (20261025040000_payment_lock.sql) and the receipt flag every member can read
-- (20261025030000_receipt_filed.sql).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- An approved fix of the crane booking with a payment PayPal has not settled yet.
insert into public.proposals (id, project_id, booking_id, state, current_version_no)
values ('00000000-0000-4000-8000-0000000002cc', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', 'approved', 1);
insert into public.proposal_versions (id, project_id, proposal_id, version_no, source_revision, inputs)
values ('00000000-0000-4000-8000-0000000003cc', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000002cc', 1, 0,
        '{"new_start":"2026-12-11","new_end":"2026-12-18"}');
insert into public.approvals (id, project_id, proposal_version_id, approver_id, scope, content_hash, amount_minor, currency, recipient, source_revision)
values ('00000000-0000-4000-8000-0000000004cc', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000003cc',
        '00000000-0000-4000-8000-000000000012', 'payment', 'h', 360000, 'USD', 'supplier@test.local', 0);
insert into public.payment_authorizations (id, project_id, approval_id, proposal_version_id, amount_minor, currency, recipient_email, authorized_by, status)
values ('00000000-0000-4000-8000-0000000005cc', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000004cc',
        '00000000-0000-4000-8000-0000000003cc', 360000, 'USD', 'supplier@test.local', '00000000-0000-4000-8000-000000000012', 'pending');

create temporary table t_lock as
  select b.task_id as locked, (select max(revision_no) from public.project_revisions) as base
    from public.equipment_bookings b where b.id = '00000000-0000-4000-8000-000000000101';

create function pg_temp.revision(p_no int, p_changes jsonb) returns void language sql as $$
  insert into public.project_revisions (project_id, revision_no, client_id, local_revision_id, changes)
  values ('00000000-0000-4000-8000-000000000001', 1000 + p_no, '00000000-0000-4000-8000-0000000009cc', 'lock-' || p_no, p_changes);
$$;

select is(
  (select array_agg(task_id) from public.payment_locked_tasks('00000000-0000-4000-8000-000000000001')),
  (select array[locked] from t_lock), 'the booked task is locked while its payment is pending');

-- Revisions --------------------------------------------------------------------------------------
select throws_ok(
  format($$select pg_temp.revision(1, '{"tasks":{"removed":[{"id":%s}]}}')$$, (select locked from t_lock)),
  '55006', null, 'deleting the task (or a group holding it, whose removal lists it) is refused');
select throws_ok(
  format($$select pg_temp.revision(2, '{"tasks":{"updated":[{"id":%s,"startDate":"2026-12-14T00:00:00"}]}}')$$, (select locked from t_lock)),
  '55006', null, 'moving it, directly or through a predecessor, is refused');
select throws_ok(
  format($$select pg_temp.revision(3, '{"tasks":{"$input":{"updated":[{"id":%s,"name":"Renamed"}]}}}')$$, (select locked from t_lock)),
  '55006', null, 'and so is a change in the user input part');
select lives_ok(
  format($$select pg_temp.revision(4, '{"tasks":{"updated":[{"id":%s,"parentIndex":3,"orderedParentIndex":3}]}}')$$, (select locked from t_lock)),
  'a task added or moved beside it may renumber it');
select lives_ok(
  $$select pg_temp.revision(5, '{"tasks":{"updated":[{"id":1,"name":"Another task"}]}}')$$,
  'other tasks change as usual');

-- Reset ------------------------------------------------------------------------------------------
set local role service_role;
select throws_ok($$select public.reset_demo('00000000-0000-4000-8000-000000000001')$$, '55006', null,
  'the demo reset waits for PayPal to settle the payment');
reset role;

-- Settled: the lock lifts; the receipt flag is set when the receipt is filed -------------------------
update public.payment_authorizations set status = 'succeeded' where id = '00000000-0000-4000-8000-0000000005cc';
select is((select count(*)::int from public.payment_locked_tasks('00000000-0000-4000-8000-000000000001')), 0, 'a settled payment locks nothing');
select lives_ok(
  format($$select pg_temp.revision(6, '{"tasks":{"updated":[{"id":%s,"startDate":"2026-12-14T00:00:00"}]}}')$$, (select locked from t_lock)),
  'and the task can change again');

insert into public.project_documents (project_id, task_id, kind, name, mime_type, size_bytes, storage_path, cost_sensitive, payment_authorization_id, created_via)
values ('00000000-0000-4000-8000-000000000001', (select locked from t_lock), 'receipt', 'payment-receipt.pdf', 'application/pdf', 1,
        '00000000-0000-4000-8000-000000000001/lock-test/payment-receipt.pdf', true, '00000000-0000-4000-8000-0000000005cc', 'system');
select isnt((select receipt_filed_at from public.payment_authorizations where id = '00000000-0000-4000-8000-0000000005cc'), null,
  'filing the receipt marks the payment, which every member may read');

-- A stuck payment can be abandoned by the forced reset ---------------------------------------------
update public.payment_authorizations set status = 'unknown' where id = '00000000-0000-4000-8000-0000000005cc';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok($$select public.reset_demo_abandoning_payments('00000000-0000-4000-8000-000000000001')$$, '42501', null,
  'browsers cannot force a reset');
reset role;
set local role service_role;
select lives_ok($$select public.reset_demo_abandoning_payments('00000000-0000-4000-8000-000000000001')$$,
  'the forced reset abandons the payment');
reset role;
select is((select count(*)::int from public.payment_authorizations where project_id = '00000000-0000-4000-8000-000000000001'), 0, 'and resets the project');

select * from finish();
rollback;
