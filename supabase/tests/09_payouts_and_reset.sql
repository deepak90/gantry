-- Payout bookkeeping used by the PayPal Edge Functions (service role only) and reset_demo.
-- Personas: the demo seed makes every member a full member (20261026040000_one_role.sql); this file
-- puts 11 back as the project manager (no cost access) and 12 as the cost manager of project 01
-- first, so "only the cost manager sends the payout" is proven against a real project manager.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

update public.project_members set role = 'pm', can_view_costs = false, approval_limit_minor = 0
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000011';
update public.project_members set role = 'cm', can_view_costs = true, approval_limit_minor = 500000
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000012';

-- An approved, authorized $3,600.00 operation (the crane rental as revised: 6 billable days at $600),
-- written directly (the workflow suite covers the RPCs).
insert into public.proposals (id, project_id, booking_id, state, current_version_no)
values ('00000000-0000-4000-8000-0000000002bb', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', 'approved', 1);
insert into public.proposal_versions (id, project_id, proposal_id, version_no, source_revision, inputs)
values ('00000000-0000-4000-8000-0000000003bb', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000002bb', 1, 0,
        '{"new_start":"2026-12-11","new_end":"2026-12-18"}');
insert into public.approvals (id, project_id, proposal_version_id, approver_id, scope, content_hash, amount_minor, currency, recipient, source_revision)
values ('00000000-0000-4000-8000-0000000004bb', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000003bb',
        '00000000-0000-4000-8000-000000000012', 'payment', 'h', 360000, 'USD', 'supplier@test.local', 0);
insert into public.payment_authorizations (id, project_id, approval_id, proposal_version_id, amount_minor, currency, recipient_email, authorized_by)
values ('00000000-0000-4000-8000-0000000005bb', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000004bb',
        '00000000-0000-4000-8000-0000000003bb', 360000, 'USD', 'supplier@test.local', '00000000-0000-4000-8000-000000000012');

-- Grants ---------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok(
  $$select public.payout_begin('00000000-0000-4000-8000-0000000005bb', '00000000-0000-4000-8000-000000000012')$$,
  '42501', null, 'browsers cannot drive payouts directly');
select throws_ok(
  $$select public.payout_record('00000000-0000-4000-8000-0000000005bb', 'succeeded')$$,
  '42501', null, 'browsers cannot record payout outcomes');
select throws_ok($$select public.reset_demo('00000000-0000-4000-8000-000000000001')$$, '42501', null, 'browsers cannot reset the demo');
reset role;

set local role service_role;
-- Starting --------------------------------------------------------------------------------------
select throws_ok(
  $$select public.payout_begin('00000000-0000-4000-8000-0000000005bb', '00000000-0000-4000-8000-000000000011')$$,
  '42501', null, 'only the cost manager sends the payout');
select is(
  public.payout_resume('00000000-0000-4000-8000-0000000005bb', '00000000-0000-4000-8000-000000000011') ->> 'action',
  'none', 'a status refresh never starts an operation that was not sent');
select is(
  public.payout_begin('00000000-0000-4000-8000-0000000005bb', '00000000-0000-4000-8000-000000000012') -> 'authorization' ->> 'status',
  'submitted', 'sending marks the operation submitted');
select is(
  (select row(attempts, submitted_at is not null) from public.payment_authorizations where id = '00000000-0000-4000-8000-0000000005bb'),
  row(1, true), 'and counts the attempt');
select is(
  public.payout_begin('00000000-0000-4000-8000-0000000005bb', '00000000-0000-4000-8000-000000000012') ->> 'action',
  'wait', 'a second click while the first attempt is in flight waits');
update public.payment_authorizations set submitted_at = now() - interval '1 minute' where id = '00000000-0000-4000-8000-0000000005bb';
select is(
  public.payout_resume('00000000-0000-4000-8000-0000000005bb', '00000000-0000-4000-8000-000000000011') ->> 'action',
  'submit', 'an attempt whose outcome never arrived is re-sent (with the same ids)');
select is((select attempts from public.payment_authorizations where id = '00000000-0000-4000-8000-0000000005bb'), 2,
  'as a second attempt');

-- Recording ------------------------------------------------------------------------------------
select is(
  (public.payout_record('00000000-0000-4000-8000-0000000005bb', 'pending', 'BATCH-1', null, null, null, '{"batch_status":"PENDING"}')).status,
  'pending', 'PayPal accepted the batch: pending');
select is(
  public.payout_begin('00000000-0000-4000-8000-0000000005bb', '00000000-0000-4000-8000-000000000012') ->> 'action',
  'check', 'a known batch is checked, never re-sent');
select is(
  (public.payout_record('00000000-0000-4000-8000-0000000005bb', 'succeeded', 'BATCH-OTHER', 'ITEM-1', 25, null, null)).paypal_batch_id,
  'BATCH-1', 'identifiers are filled in once, never replaced');
select is(
  (select row(status, paypal_item_id, fee_minor) from public.payment_authorizations where id = '00000000-0000-4000-8000-0000000005bb'),
  row('succeeded'::text, 'ITEM-1'::text, 25::bigint), 'success records the item id and the fee');
select is(
  (public.payout_record('00000000-0000-4000-8000-0000000005bb', 'pending', null, null, null, 'late event', null)).status,
  'succeeded', 'an out-of-order older status is ignored');
select is(
  (select message from public.payment_authorizations where id = '00000000-0000-4000-8000-0000000005bb'), null,
  'and leaves no message behind');
select is(
  public.payout_resume('00000000-0000-4000-8000-0000000005bb', '00000000-0000-4000-8000-000000000011') ->> 'action',
  'none', 'a settled operation needs nothing');
select is(
  (public.payout_record('00000000-0000-4000-8000-0000000005bb', 'failed', null, null, null, 'RETURNED: the item was returned', '{"n":1}')).status,
  'failed', 'a succeeded item can still fail when PayPal returns it');
select is(
  (public.payout_record('00000000-0000-4000-8000-0000000005bb', 'pending', null, null, null, 'stale', '{"n":2}')).raw,
  '{"n":1}'::jsonb, 'an ignored older status leaves the raw answer of the recorded one');
select is((select message from public.payment_authorizations where id = '00000000-0000-4000-8000-0000000005bb'),
  'RETURNED: the item was returned', 'and its message');
select throws_ok(
  $$select public.payout_record('00000000-0000-4000-8000-0000000005bb', 'paid')$$,
  '22023', null, 'statuses are the PaymentStatus vocabulary');

-- A pending item that was unclaimed and is plain pending again loses the unclaimed note.
reset role;
insert into public.payment_authorizations (id, project_id, approval_id, proposal_version_id, amount_minor, currency, recipient_email, status, attempts)
values ('00000000-0000-4000-8000-0000000005cc', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000004bb',
        '00000000-0000-4000-8000-0000000003bb', 360000, 'USD', 'supplier@test.local', 'unknown', 5);
set local role service_role;
select is(
  public.payout_resume('00000000-0000-4000-8000-0000000005cc', '00000000-0000-4000-8000-000000000011') ->> 'action',
  'none', 'after five sends without a batch id the operation is no longer re-sent');
select is(
  (public.payout_record('00000000-0000-4000-8000-0000000005cc', 'pending', 'BATCH-2', null, null, 'Unclaimed: no PayPal account', null)).message,
  'Unclaimed: no PayPal account', 'an unclaimed item carries the note');
select is(
  (public.payout_record('00000000-0000-4000-8000-0000000005cc', 'pending', null, null, null, null, null)).message,
  null, 'and loses it once PayPal reports it plainly pending');
select lives_ok(
  $$select public.payout_record('00000000-0000-4000-8000-0000000005cc', 'failed', null, null, null, 'RETURNED', null)$$,
  'settle it so the approval below has no live operation');

-- Webhook events ---------------------------------------------------------------------------------
select is(
  public.payout_record_event('00000000-0000-4000-8000-0000000005bb', 'WH-1', 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', true, '{}'),
  true, 'a new webhook event is recorded');
select is(
  public.payout_record_event('00000000-0000-4000-8000-0000000005bb', 'WH-1', 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', true, '{}'),
  false, 'a replayed webhook event is recognized and ignored');
select is((select count(*) from public.payment_events where paypal_event_id = 'WH-1'), 1::bigint, 'once');

-- A failed operation can be authorized again -----------------------------------------------------------
reset role;
select lives_ok(
  $$insert into public.payment_authorizations (project_id, approval_id, proposal_version_id, amount_minor, currency, recipient_email)
    values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000004bb', '00000000-0000-4000-8000-0000000003bb',
            360000, 'USD', 'supplier@test.local')$$,
  'after a failure the same approval may get a new operation');
select throws_ok(
  $$insert into public.payment_authorizations (project_id, approval_id, proposal_version_id, amount_minor, currency, recipient_email)
    values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000004bb', '00000000-0000-4000-8000-0000000003bb',
            360000, 'USD', 'supplier@test.local')$$,
  '23505', null, 'but only one live operation per approval');

-- reset_demo ---------------------------------------------------------------------------------------
insert into public.sessions (id, user_id, project_id)
values ('00000000-0000-4000-8000-00000000b011', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select lives_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000b011', 'r-1', null,
      '{"tasks":{"updated":[{"id":2,"name":"Renamed"}]}}')$$,
  'a revision before the reset');
reset role;
update public.equipment_bookings set billable_start = '2026-12-11', idle_days = 0, supplier_payout_email = 'payee@test.local'
 where id = '00000000-0000-4000-8000-000000000101';
update public.projects set snapshot = '{"tasksData":[]}', snapshot_revision = 1 where id = '00000000-0000-4000-8000-000000000001';

set local role service_role;
-- The operation authorized above is still live (PayPal has not settled it): the reset waits.
select throws_ok($$select public.reset_demo('00000000-0000-4000-8000-000000000001')$$, '55006', null, 'the reset waits for a payment PayPal has not settled');
select lives_ok($$select public.reset_demo_abandoning_payments('00000000-0000-4000-8000-000000000001')$$, 'the service role resets the demo, abandoning it');
reset role;
select is(
  (select row(current_revision, snapshot_revision) from public.projects where id = '00000000-0000-4000-8000-000000000001'),
  row(0, 0), 'the project is back at revision 0');
select is(
  (select snapshot from public.projects where id = '00000000-0000-4000-8000-000000000001'),
  (select snapshot from public.demo_seeds where project_id = '00000000-0000-4000-8000-000000000001'),
  'with the seed snapshot');
select ok(
  (select jsonb_array_length(snapshot -> 'tasksData') > 0 from public.projects where id = '00000000-0000-4000-8000-000000000001'),
  'which holds the seed tasks');
select is(
  (select row(billable_start, idle_days) from public.equipment_bookings where id = '00000000-0000-4000-8000-000000000101'),
  row('2026-12-07'::date, 4), 'the booking is back to the seed interval with four idle days');
select is(
  (select supplier_payout_email from public.equipment_bookings where id = '00000000-0000-4000-8000-000000000101'),
  'payee@test.local', 'the machine-specific payout email is kept');
select is(
  (select array[
     (select count(*) from public.project_revisions where project_id = '00000000-0000-4000-8000-000000000001'),
     (select count(*) from public.proposals where project_id = '00000000-0000-4000-8000-000000000001'),
     (select count(*) from public.payment_authorizations where project_id = '00000000-0000-4000-8000-000000000001'),
     (select count(*) from public.payment_events where project_id = '00000000-0000-4000-8000-000000000001'),
     (select count(*) from public.sessions where project_id = '00000000-0000-4000-8000-000000000001')]),
  array[0, 0, 0, 0, 0]::bigint[], 'revisions, proposals, payments, events and sessions are gone');

select * from finish();
rollback;
