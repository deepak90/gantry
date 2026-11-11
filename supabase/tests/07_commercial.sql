-- Commercial tables: constraints, the payment_authorizations immutability trigger and RLS.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at, is_sso_user, is_anonymous)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000aa', 'authenticated', 'authenticated',
        'outsider@test.local', now(), now(), false, false);
insert into public.equipment_bookings
  (id, project_id, task_id, resource_id, supplier_name, supplier_payout_email, rental_rate_minor, currency, billable_start, billable_end, idle_days)
values
  ('00000000-0000-4000-8000-0000000001aa', '00000000-0000-4000-8000-000000000001', 1, 1,
   'Northgate Equipment Rental', 'supplier@test.local', 60000, 'USD', '2026-11-02', '2026-11-14', 4);
insert into public.proposals (id, project_id, booking_id, state, current_version_no)
values ('00000000-0000-4000-8000-0000000002aa', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000001aa', 'in_review', 1);
insert into public.proposal_versions (id, project_id, proposal_id, version_no, source_revision, inputs)
values ('00000000-0000-4000-8000-0000000003aa', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000002aa', 1, 0,
        '{"new_start":"2026-12-11","new_end":"2026-12-18"}');
insert into public.approvals (id, project_id, proposal_version_id, approver_id, scope, content_hash, amount_minor, currency, recipient, source_revision)
values ('00000000-0000-4000-8000-0000000004aa', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000003aa',
        '00000000-0000-4000-8000-000000000012', 'payment', 'hash-1', 360000, 'USD', 'supplier@test.local', 0);
insert into public.payment_authorizations (id, project_id, approval_id, proposal_version_id, amount_minor, currency, recipient_email, authorized_by, updated_at)
values ('00000000-0000-4000-8000-0000000005aa', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000004aa',
        '00000000-0000-4000-8000-0000000003aa', 360000, 'USD', 'supplier@test.local', '00000000-0000-4000-8000-000000000012', '2026-01-01');

-- Immutability -------------------------------------------------------------------------------
select throws_ok(
  $$update public.payment_authorizations set amount_minor = 1 where id = '00000000-0000-4000-8000-0000000005aa'$$,
  'P0001', null, 'amount_minor cannot change');
select throws_ok(
  $$update public.payment_authorizations set currency = 'EUR' where id = '00000000-0000-4000-8000-0000000005aa'$$,
  'P0001', null, 'currency cannot change');
select throws_ok(
  $$update public.payment_authorizations set recipient_email = 'evil@test.local' where id = '00000000-0000-4000-8000-0000000005aa'$$,
  'P0001', null, 'recipient_email cannot change');
select throws_ok(
  $$update public.payment_authorizations set proposal_version_id = gen_random_uuid() where id = '00000000-0000-4000-8000-0000000005aa'$$,
  'P0001', null, 'proposal_version_id cannot be repointed');
select lives_ok(
  $$update public.payment_authorizations set status = 'submitted', paypal_batch_id = 'BATCH-1', last_checked_at = now()
     where id = '00000000-0000-4000-8000-0000000005aa'$$,
  'status and PayPal identifiers can change');
select is(
  (select updated_at from public.payment_authorizations where id = '00000000-0000-4000-8000-0000000005aa'),
  now(), 'updated_at is touched on update');
select is(
  (select amount_minor from public.payment_authorizations where id = '00000000-0000-4000-8000-0000000005aa'),
  360000::bigint, 'the amount survived the rejected updates');

-- proposal_versions JSON shapes match the shared zod contract -------------------------------
select is((select assumptions from public.proposal_versions where id = '00000000-0000-4000-8000-0000000003aa'), '[]'::jsonb,
  'assumptions default to an empty array (ProposalAssumption[])');
select throws_ok(
  $$insert into public.proposal_versions (project_id, proposal_id, version_no, source_revision, inputs, assumptions)
    values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000002aa', 2, 0,
            '{"new_start":"2026-12-11","new_end":"2026-12-18"}', '{}')$$,
  '23514', null, 'assumptions must be a JSON array');
select throws_ok(
  $$insert into public.proposal_versions (project_id, proposal_id, version_no, source_revision)
    values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000002aa', 2, 0)$$,
  '23502', null, 'a version cannot exist without inputs');
select throws_ok(
  $$insert into public.proposal_versions (project_id, proposal_id, version_no, source_revision, inputs)
    values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000002aa', 2, 0, '[]')$$,
  '23514', null, 'inputs must be a JSON object');
select throws_ok(
  $$insert into public.proposal_versions (project_id, proposal_id, version_no, source_revision, inputs, evaluation)
    values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000002aa', 2, 0,
            '{"new_start":"2026-12-11","new_end":"2026-12-18"}', '"done"')$$,
  '23514', null, 'evaluation must be a JSON object when present');
select lives_ok(
  $$insert into public.proposal_versions (project_id, proposal_id, version_no, source_revision, inputs, assumptions)
    values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000002aa', 2, 0,
            '{"new_start":"2026-12-11","new_end":"2026-12-18"}',
            '[{"key":"delivery_date","question":"Can Northgate deliver the crane on Fri, Dec 11?","answer":"Yes","resolved_by":"human"}]')$$,
  'an object for inputs and an array for assumptions are accepted');

-- agent_commands.status shares its vocabulary with CommandStatus in packages/shared --------
select lives_ok(
  $$insert into public.agent_commands (project_id, type, status) values ('00000000-0000-4000-8000-000000000001', 'evaluate_booking_scenario', 'rejected')$$,
  'a command refused by the executor is rejected');
select lives_ok(
  $$insert into public.agent_commands (project_id, type, status) values ('00000000-0000-4000-8000-000000000001', 'evaluate_booking_scenario', 'cancelled')$$,
  'an abandoned command is cancelled');
select throws_ok(
  $$insert into public.agent_commands (project_id, type, status) values ('00000000-0000-4000-8000-000000000001', 'evaluate_booking_scenario', 'done')$$,
  '23514', null, 'agent command status is constrained');

-- Constraints --------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.approvals (project_id, proposal_version_id, scope, content_hash, amount_minor, currency, recipient, source_revision)
    values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000003aa', 'payment', 'hash-2', 360000, 'USD', 'supplier@test.local', 0)$$,
  '23505', null, 'only one active approval per (version, scope)');
select lives_ok(
  $$update public.approvals set status = 'invalidated', invalidated_reason = 'inputs changed', invalidated_at = now()
     where id = '00000000-0000-4000-8000-0000000004aa'$$,
  'an approval can be invalidated with a reason');
select lives_ok(
  $$insert into public.approvals (project_id, proposal_version_id, scope, content_hash, amount_minor, currency, recipient, source_revision)
    values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000003aa', 'payment', 'hash-2', 360000, 'USD', 'supplier@test.local', 0)$$,
  'a new active approval is allowed once the old one is invalidated');
select throws_ok(
  $$insert into public.approvals (project_id, proposal_version_id, scope, content_hash, source_revision)
    values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000003aa', 'payment', 'hash-3', 0)$$,
  '23514', null, 'a payment approval needs amount, currency and recipient');
select lives_ok(
  $$insert into public.approvals (project_id, proposal_version_id, scope, content_hash, source_revision)
    values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000003aa', 'schedule', 'hash-4', 0)$$,
  'a schedule approval carries no money');
select throws_ok(
  $$update public.approvals set status = 'invalidated' where content_hash = 'hash-4'$$,
  '23514', null, 'invalidation requires a reason');
insert into public.payment_events (project_id, authorization_id, paypal_event_id, event_type, verified)
values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000005aa', 'WH-1', 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', true);
select throws_ok(
  $$insert into public.payment_events (project_id, authorization_id, paypal_event_id, event_type)
    values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000005aa', 'WH-1', 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED')$$,
  '23505', null, 'a replayed PayPal event id is rejected');
select throws_ok(
  $$insert into public.proposals (project_id, booking_id, state)
    values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000001aa', 'paid')$$,
  '23514', null, 'proposal state is constrained');
select throws_ok(
  $$insert into public.supplier_confirmations (proposal_id, project_id, status)
    values ('00000000-0000-4000-8000-0000000002aa', '00000000-0000-4000-8000-000000000001', 'maybe')$$,
  '23514', null, 'supplier confirmation status is constrained');
select throws_ok(
  $$insert into public.equipment_bookings (project_id, task_id, resource_id, supplier_name, supplier_payout_email, rental_rate_minor, billable_start, billable_end)
    values ('00000000-0000-4000-8000-000000000001', 1, 1, 'x', 'x@test.local', 1, '2026-11-14', '2026-11-02')$$,
  '23514', null, 'billable_end must not precede billable_start');

-- RLS --------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is((select count(*) from public.proposals), 1::bigint, 'pm sees the proposal');
select is((select count(*) from public.payment_authorizations), 1::bigint, 'pm sees the payment authorization row');
select throws_ok(
  $$insert into public.decision_notes (project_id, text) values ('00000000-0000-4000-8000-000000000001', 'x')$$,
  '42501', null, 'clients cannot insert decision_notes');
select throws_ok(
  $$update public.payment_authorizations set status = 'succeeded' where id = '00000000-0000-4000-8000-0000000005aa'$$,
  '42501', null, 'clients cannot update payment_authorizations');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
select is((select count(*) from public.proposals), 0::bigint, 'non-member sees no proposals');
select is((select count(*) from public.approvals), 0::bigint, 'non-member sees no approvals');
select is((select count(*) from public.payment_authorizations), 0::bigint, 'non-member sees no payment authorizations');
reset role;
set local role anon;
select throws_ok('select count(*) from public.payment_authorizations', '42501', null, 'anon cannot read payment_authorizations');
reset role;

select * from finish();
rollback;
