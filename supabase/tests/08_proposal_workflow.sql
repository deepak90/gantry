-- Proposal workflow: create, evaluate (with the server re-deriving the cost lines), answer an open
-- assumption, approve in order (the dates before the payment; any member approves the dates, the
-- payment needs cost access and stays within the approver's limit), correct (new version,
-- invalidated approvals), approval limits, booking drift, payment authorization, publication claims
-- and the publication revision, supplier confirmation, and approve_fix (both approvals in one call,
-- 20261026040000_one_role.sql). Mirrors the demo: the crane rental (booked for 10 billable days at
-- $600, not paid yet) moved to start when the work can use it, 6 days = $3,600; then a correction
-- that keeps it one more day, 7 days = $4,200; then a longer rental (negative saving).
-- Personas: the demo seed makes every member a full member (20261026040000_one_role.sql); this file
-- puts 11 (Chris) back as the project manager who cannot see costs (limit 0) and 12 (Deepak) as the
-- cost manager with a $5,000 limit on project 01 first, so the permission rules are proven against
-- members who lack them.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

update public.project_members set role = 'pm', can_view_costs = false, approval_limit_minor = 0
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000011';
update public.project_members set role = 'cm', can_view_costs = true, approval_limit_minor = 500000
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000012';

create temp table t (name text primary key, doc jsonb);
grant all on t to authenticated;
grant select on t to anon;

-- The revised rental dates (start inclusive, end exclusive): on rent Fri, Dec 11, off rent p_end.
create function pg_temp.inputs(p_end text default '2026-12-18') returns jsonb language sql as $$
  select jsonb_build_object('new_start', '2026-12-11', 'new_end', p_end);
$$;

-- An evaluation in the shape the browser records: the rental at the booking's $600 a billable day,
-- p_published days as booked and p_revised days as revised (10 -> 6 by default).
create function pg_temp.evaluation(p_inputs jsonb, p_source int, p_assumptions jsonb, p_unresolved jsonb,
                                   p_published int default 10, p_revised int default 6)
returns jsonb language sql as $$
  select jsonb_build_object(
    'source_revision', p_source,
    'inputs', p_inputs,
    'assumptions', p_assumptions,
    'schedule_impact', jsonb_build_object(
      'handover', jsonb_build_object('published_end', '2027-04-28', 'proposed_end', '2027-04-28', 'delta_days', 0),
      'affected_tasks', '[]'::jsonb,
      'over_allocations', '[]'::jsonb),
    'cost_comparison', jsonb_build_object(
      'currency', 'USD',
      'booked_rental_minor', 60000 * p_published,
      'supplier_payment_minor', 60000 * p_revised,
      'saving_minor', 60000 * (p_published - p_revised)),
    'booking_days', jsonb_build_object(
      'published_billable_days', p_published, 'revised_billable_days', p_revised,
      'avoided_billable_days', greatest(p_published - p_revised, 0), 'revised_idle_days', 0),
    'unresolved_assumptions', p_unresolved,
    'evaluated_at', '2026-11-10T14:00:00Z');
$$;
grant execute on all functions in schema pg_temp to authenticated;

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at, is_sso_user, is_anonymous)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000aa', 'authenticated', 'authenticated',
        'outsider@test.local', now(), now(), false, false);
insert into public.sessions (id, user_id, project_id) values
  ('00000000-0000-4000-8000-00000000a011', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-00000000a012', '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001');
update public.equipment_bookings set supplier_payout_email = 'northgate@test.local'
 where id = '00000000-0000-4000-8000-000000000101';

-- Create ---------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
insert into t select 'p', public.create_proposal('00000000-0000-4000-8000-000000000101', pg_temp.inputs(),
  '[{"key":"delivery_date","question":"Can Northgate deliver the crane on Fri, Dec 11?","answer":null,"resolved_by":null}]');
insert into t select 'v1', jsonb_build_object('id', (select doc ->> 'version_id' from t where name = 'p'));
select is((select doc ->> 'state' from t where name = 'p'), 'draft', 'a new proposal starts as draft');
select is((select version_no from public.proposal_versions where id = (select (doc ->> 'id')::uuid from t where name = 'v1')), 1,
  'with version 1');
select is((select status from public.supplier_confirmations where proposal_id = (select (doc ->> 'proposal_id')::uuid from t where name = 'p')),
  'pending', 'supplier confirmation starts pending');
select is(
  (select inputs from public.proposal_versions where id = (select (doc ->> 'id')::uuid from t where name = 'v1')),
  '{"new_start": "2026-12-11", "new_end": "2026-12-18"}'::jsonb, 'the inputs are the two rental dates');
select throws_ok(
  $$select public.create_proposal('00000000-0000-4000-8000-000000000101', pg_temp.inputs())$$,
  '55000', null, 'one open proposal per booking');
select throws_ok(
  $$select public.create_proposal('00000000-0000-4000-8000-000000000101', pg_temp.inputs() || '{"new_end":"2026-12-10"}')$$,
  '22023', null, 'new_end must follow new_start');
select throws_ok(
  $$select public.create_proposal('00000000-0000-4000-8000-000000000101', pg_temp.inputs('2026-12-11'))$$,
  '22023', null, 'a rental of no days is refused (the end is exclusive)');
select throws_ok(
  $$select public.create_proposal('00000000-0000-4000-8000-000000000101', pg_temp.inputs() - 'new_end')$$,
  '22023', null, 'both rental dates are required');
select throws_ok(
  $$select public.create_proposal('00000000-0000-4000-8000-000000000101', pg_temp.inputs() || '{"discount":1}')$$,
  '22023', null, 'unknown input fields are refused');
select throws_ok(
  $$select public.create_proposal('00000000-0000-4000-8000-000000000101', pg_temp.inputs() || '{"rebooking_minor":90000}')$$,
  '22023', null, 'a supplier change fee is not an input');
select throws_ok(
  $$select public.create_proposal('00000000-0000-4000-8000-000000000101', pg_temp.inputs() || '{"transport_minor":30000}')$$,
  '22023', null, 'a delivery charge is not an input');
select throws_ok(
  $$select public.create_proposal('00000000-0000-4000-8000-000000000101', pg_temp.inputs() || '{"charge_basis":"one_time"}')$$,
  '22023', null, 'a charge basis is not an input');
select throws_ok(
  $$select public.create_proposal('00000000-0000-4000-8000-000000000101', pg_temp.inputs() || '{"new_start":"2026-02-30"}')$$,
  '22023', null, 'impossible dates are refused');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
select throws_ok(
  $$select public.create_proposal('00000000-0000-4000-8000-000000000101', pg_temp.inputs())$$,
  'P0002', null, 'a non-member cannot see the booking');

-- Evaluate version 1 (assumption still open) ---------------------------------------------------
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
insert into t select 'assumptions_open', assumptions from public.proposal_versions
 where id = (select (doc ->> 'id')::uuid from t where name = 'v1');
select throws_ok(
  $$select public.record_evaluation((select (doc ->> 'id')::uuid from t where name = 'v1'),
      jsonb_set(pg_temp.evaluation(pg_temp.inputs(), 0, (select doc from t where name = 'assumptions_open'), '["delivery_date"]'),
                '{cost_comparison,supplier_payment_minor}', '1'))$$,
  '22023', null, 'a supplier payment that is not the rental rate times the revised billable days is refused');
select throws_ok(
  $$select public.record_evaluation((select (doc ->> 'id')::uuid from t where name = 'v1'),
      jsonb_set(pg_temp.evaluation(pg_temp.inputs(), 0, (select doc from t where name = 'assumptions_open'), '["delivery_date"]'),
                '{cost_comparison}',
                '{"currency":"USD","booked_rental_minor":500000,"supplier_payment_minor":300000,"saving_minor":200000}'))$$,
  '22023', null, 'a cost comparison priced at another day rate is refused');
select throws_ok(
  $$select public.record_evaluation((select (doc ->> 'id')::uuid from t where name = 'v1'),
      jsonb_set(pg_temp.evaluation(pg_temp.inputs(), 0, (select doc from t where name = 'assumptions_open'), '["delivery_date"]'),
                '{cost_comparison,saving_minor}', '0'))$$,
  '22023', null, 'a saving that is not the booked minus the revised rental is refused');
select throws_ok(
  $$select public.record_evaluation((select (doc ->> 'id')::uuid from t where name = 'v1'),
      jsonb_set(pg_temp.evaluation(pg_temp.inputs(), 0, (select doc from t where name = 'assumptions_open'), '["delivery_date"]'),
                '{cost_comparison,payout_fee_minor}', 'null'))$$,
  '22023', null, 'a cost comparison with any other line (the PayPal fee stays on the payment) is refused');
select throws_ok(
  $$select public.record_evaluation((select (doc ->> 'id')::uuid from t where name = 'v1'),
      pg_temp.evaluation(pg_temp.inputs(), 0, (select doc from t where name = 'assumptions_open'), '["delivery_date"]', 10, 8))$$,
  '22023', null, 'revised billable days beyond the calendar days of the new dates are refused');
select throws_ok(
  $$select public.record_evaluation((select (doc ->> 'id')::uuid from t where name = 'v1'),
      pg_temp.evaluation(pg_temp.inputs('2026-12-19'), 0, (select doc from t where name = 'assumptions_open'), '["delivery_date"]'))$$,
  '22023', null, 'an evaluation of other inputs is refused');
select throws_ok(
  $$select public.record_evaluation((select (doc ->> 'id')::uuid from t where name = 'v1'),
      pg_temp.evaluation(pg_temp.inputs(), 0, (select doc from t where name = 'assumptions_open'), '[]'))$$,
  '22023', null, 'unresolved_assumptions must list the open assumption');
select throws_ok(
  $$select public.record_evaluation((select (doc ->> 'id')::uuid from t where name = 'v1'),
      pg_temp.evaluation(pg_temp.inputs(), 5, (select doc from t where name = 'assumptions_open'), '["delivery_date"]'))$$,
  '22023', null, 'a source revision ahead of the log is refused');
select is(
  (public.record_evaluation((select (doc ->> 'id')::uuid from t where name = 'v1'),
     pg_temp.evaluation(pg_temp.inputs(), 0, (select doc from t where name = 'assumptions_open'), '["delivery_date"]'))) ->> 'state',
  'evaluated', 'a valid evaluation moves the proposal to evaluated');
select is(
  (select evaluation -> 'cost_comparison' from public.proposal_versions where id = (select (doc ->> 'id')::uuid from t where name = 'v1')),
  '{"currency": "USD", "booked_rental_minor": 600000, "supplier_payment_minor": 360000, "saving_minor": 240000}'::jsonb,
  'the booked rental is 10 days at $600, the revised rental 6 days: $2,400 saved');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select throws_ok(
  $$select public.approve_proposal((select (doc ->> 'id')::uuid from t where name = 'v1'), 'schedule')$$,
  '55000', null, 'nothing is approved while an assumption is open');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok(
  $$select public.approve_fix((select (doc ->> 'id')::uuid from t where name = 'v1'))$$,
  '55000', 'approve_proposal: answer the open assumptions first: ["delivery_date"]',
  'approve_fix does not approve while an assumption is open either, even for the cost manager');
select is(
  (select count(*) from public.approvals where proposal_version_id = (select (doc ->> 'id')::uuid from t where name = 'v1')),
  0::bigint, 'and leaves nothing behind');

-- Answer the assumption: version 2 -------------------------------------------------------------
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
insert into t select 'r1', public.review_proposal((select (doc ->> 'id')::uuid from t where name = 'v1'), 'correction',
  '{"answers":[{"key":"delivery_date","answer":"Yes, confirmed with Northgate"}],"reason":"Deepak confirmed the delivery date"}');
insert into t select 'v2', jsonb_build_object('id', (select doc ->> 'version_id' from t where name = 'r1'));
select is((select doc ->> 'version_no' from t where name = 'r1'), '2', 'answering an assumption creates version 2');
select is((select doc ->> 'state' from t where name = 'r1'), 'in_review', 'a correction puts the proposal in review');
select is(
  (select stale from public.proposal_versions where id = (select (doc ->> 'id')::uuid from t where name = 'v2')),
  true, 'the new version is stale until evaluated');
select is(
  (select assumptions -> 0 ->> 'resolved_by' from public.proposal_versions where id = (select (doc ->> 'id')::uuid from t where name = 'v2')),
  'human', 'the answer is recorded as human-resolved');
select throws_ok(
  $$select public.review_proposal((select (doc ->> 'id')::uuid from t where name = 'v2'), 'correction', '{"changes":{"new_end":"2026-12-18"},"reason":"no-op"}')$$,
  '22023', null, 'a correction that changes nothing is refused');
select throws_ok(
  $$select public.review_proposal((select (doc ->> 'id')::uuid from t where name = 'v2'), 'correction', '{"changes":{"transport_minor":30000},"reason":"delivery"}')$$,
  '22023', null, 'a correction cannot add a charge to the inputs');
insert into t select 'assumptions_answered', assumptions from public.proposal_versions
 where id = (select (doc ->> 'id')::uuid from t where name = 'v2');
select is(
  (public.record_evaluation((select (doc ->> 'id')::uuid from t where name = 'v2'),
     pg_temp.evaluation(pg_temp.inputs(), 0, (select doc from t where name = 'assumptions_answered'), '[]'))) ->> 'state',
  'in_review', 'evaluating version 2 keeps the reviewed proposal in review');

-- Approvals on version 2: the dates first (any member), then the payment (cost access) -----------
-- The cost manager, who sees costs and is within the limit, still cannot approve the payment first.
select throws_ok(
  $$select public.approve_proposal((select (doc ->> 'id')::uuid from t where name = 'v2'), 'payment')$$,
  '55000', null, 'the payment cannot be approved before the dates are approved');
select throws_like(
  $$select public.approve_proposal((select (doc ->> 'id')::uuid from t where name = 'v2'), 'payment')$$,
  '%the dates are approved first%', 'and the refusal says so');
select is(
  (select count(*) from public.approvals where proposal_version_id = (select (doc ->> 'id')::uuid from t where name = 'v2')),
  0::bigint, 'the refused payment approval left nothing behind');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select throws_ok(
  $$select public.approve_proposal((select (doc ->> 'id')::uuid from t where name = 'v2'), 'payment')$$,
  '42501', null, 'a member who cannot see costs does not approve the payment');
insert into t select 'sched2', to_jsonb(public.approve_proposal((select (doc ->> 'id')::uuid from t where name = 'v2'), 'schedule'));
select is(
  (select array[doc ->> 'scope', doc ->> 'approver_id'] from t where name = 'sched2'),
  array['schedule', '00000000-0000-4000-8000-000000000011'],
  'any member approves the dates: here the project manager, who cannot see costs');
select is((select state from public.proposals where id = (select (doc ->> 'proposal_id')::uuid from t where name = 'p')),
  'in_review', 'the dates alone do not approve the proposal');
select throws_ok(
  $$select public.approve_proposal((select (doc ->> 'id')::uuid from t where name = 'v2'), 'payment')$$,
  '42501', null, 'with the dates approved, a member who cannot see costs still does not approve the payment');
select throws_like(
  $$select public.approve_proposal((select (doc ->> 'id')::uuid from t where name = 'v2'), 'payment')$$,
  '%only a member who can see costs approves the payment%', 'and the refusal says why');
select is(
  (select count(*) from public.approvals where proposal_version_id = (select (doc ->> 'id')::uuid from t where name = 'v2')
     and scope = 'payment'),
  0::bigint, 'the refused payment approvals left nothing behind');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
insert into t select 'pay2', to_jsonb(public.approve_proposal((select (doc ->> 'id')::uuid from t where name = 'v2'), 'payment'));
select is((select (doc ->> 'amount_minor')::bigint from t where name = 'pay2'), 360000::bigint,
  'the payment approval binds the revised rental: 6 days at $600 = $3,600.00');
select is((select doc ->> 'recipient' from t where name = 'pay2'), 'northgate@test.local', 'and the supplier payout email');
select is((select doc ->> 'currency' from t where name = 'pay2'), 'USD', 'and the currency');
select is(
  (select to_jsonb(public.approve_proposal((select (doc ->> 'id')::uuid from t where name = 'v2'), 'payment')) ->> 'id'),
  (select doc ->> 'id' from t where name = 'pay2'), 'approving the same content again returns the same approval');
select is((select state from public.proposals where id = (select (doc ->> 'proposal_id')::uuid from t where name = 'p')),
  'approved', 'the payment approval is the final say: the proposal is approved');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select throws_ok(
  $$select public.authorize_payment((select (doc ->> 'id')::uuid from t where name = 'v2'))$$,
  '42501', null, 'the project manager cannot authorize the payment');

-- Off-rent correction: version 3 (one more day), approvals of version 2 invalidated ---------------
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
insert into t select 'r2', public.review_proposal((select (doc ->> 'id')::uuid from t where name = 'v2'), 'correction',
  '{"changes":{"new_end":"2026-12-19"},"reason":"The erection needs the crane on Friday, December 18 too"}');
insert into t select 'v3', jsonb_build_object('id', (select doc ->> 'version_id' from t where name = 'r2'));
select is((select (doc ->> 'invalidated_approvals')::int from t where name = 'r2'), 2, 'both approvals of version 2 are invalidated');
select is((select doc ->> 'state' from t where name = 'r2'), 'in_review', 'the proposal is back in review');
select ok(
  (select bool_and(status = 'invalidated' and invalidated_reason = 'Superseded by version 3 (off-rent date changed): The erection needs the crane on Friday, December 18 too')
     from public.approvals where proposal_version_id = (select (doc ->> 'id')::uuid from t where name = 'v2')),
  'the invalidation names the new version, what changed (not the amounts) and why');
select is(
  (select payload -> 'changes' from public.reviews where id = (select (doc ->> 'review_id')::uuid from t where name = 'r2')),
  '{"new_end": {"from": "2026-12-18", "to": "2026-12-19"}}'::jsonb, 'the correction review records what changed');
select throws_ok(
  $$select public.approve_proposal((select (doc ->> 'id')::uuid from t where name = 'v2'), 'payment')$$,
  '55000', null, 'a superseded version cannot be approved');
select throws_ok(
  $$select public.approve_proposal((select (doc ->> 'id')::uuid from t where name = 'v3'), 'payment')$$,
  '55000', null, 'an unevaluated version cannot be approved');
select throws_ok(
  $$select public.approve_fix((select (doc ->> 'id')::uuid from t where name = 'v2'))$$,
  '55000', 'approve_proposal: version 2 is no longer current; the proposal is at version 3', 'approve_fix refuses a superseded version');
select throws_ok(
  $$select public.approve_fix((select (doc ->> 'id')::uuid from t where name = 'v3'))$$,
  '55000', 'approve_proposal: version 3 has not been evaluated with its current inputs', 'and a version that has not been checked');
select is(
  (select count(*) from public.approvals
    where proposal_version_id in ((select (doc ->> 'id')::uuid from t where name = 'v2'), (select (doc ->> 'id')::uuid from t where name = 'v3'))
      and status = 'active'),
  0::bigint, 'neither refusal leaves an approval behind');
select lives_ok(
  $$select public.record_evaluation((select (doc ->> 'id')::uuid from t where name = 'v3'),
      pg_temp.evaluation(pg_temp.inputs('2026-12-19'), 0, (select doc from t where name = 'assumptions_answered'), '[]', 10, 7))$$,
  'version 3 evaluates to a $4,200 supplier payment (7 days at $600)');
select is(
  (select evaluation -> 'cost_comparison' ->> 'saving_minor' from public.proposal_versions
    where id = (select (doc ->> 'id')::uuid from t where name = 'v3')),
  '180000', 'the reviewed saving is $1,800');

-- Approval limit (the dates are approved first, this time by the cost manager) --------------------
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
insert into t select 'sched3', to_jsonb(public.approve_proposal((select (doc ->> 'id')::uuid from t where name = 'v3'), 'schedule'));
select is(
  (select array[doc ->> 'scope', doc ->> 'approver_id'] from t where name = 'sched3'),
  array['schedule', '00000000-0000-4000-8000-000000000012'],
  'the cost manager approves the dates too: the dates are not tied to a role');
reset role;
update public.project_members set approval_limit_minor = 100000
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000012';
set local role authenticated;
select throws_ok(
  $$select public.approve_proposal((select (doc ->> 'id')::uuid from t where name = 'v3'), 'payment')$$,
  '42501', null, 'a payment above the approver''s limit is refused');
reset role;
update public.project_members set approval_limit_minor = 500000
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000012';
set local role authenticated;

insert into t select 'pay3', to_jsonb(public.approve_proposal((select (doc ->> 'id')::uuid from t where name = 'v3'), 'payment'));
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select isnt((select doc ->> 'content_hash' from t where name = 'pay3'), (select doc ->> 'content_hash' from t where name = 'sched3'),
  'each scope has its own content hash');
select is((select state from public.proposals where id = (select (doc ->> 'proposal_id')::uuid from t where name = 'p')),
  'approved', 'version 3 is approved');

-- A changed recipient invalidates the approvals ------------------------------------------------
reset role;
update public.equipment_bookings set supplier_payout_email = 'someone-else@test.local' where id = '00000000-0000-4000-8000-000000000101';
select is(
  (select count(*) from public.approvals where proposal_version_id = (select (doc ->> 'id')::uuid from t where name = 'v3') and status = 'active'),
  0::bigint, 'changing the payout recipient invalidates the approvals');
select is((select state from public.proposals where id = (select (doc ->> 'proposal_id')::uuid from t where name = 'p')),
  'in_review', 'and returns the proposal to review');
update public.equipment_bookings set supplier_payout_email = 'northgate@test.local' where id = '00000000-0000-4000-8000-000000000101';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok(
  $$select public.authorize_payment((select (doc ->> 'id')::uuid from t where name = 'v3'))$$,
  '55000', null, 'no payment without active approvals');
select throws_ok(
  $$select public.approve_proposal((select (doc ->> 'id')::uuid from t where name = 'v3'), 'payment')$$,
  '55000', null, 'an invalidated schedule approval does not count: the dates are approved again first');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select lives_ok($$select public.approve_proposal((select (doc ->> 'id')::uuid from t where name = 'v3'), 'schedule')$$, 'pm re-approves');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select lives_ok($$select public.approve_proposal((select (doc ->> 'id')::uuid from t where name = 'v3'), 'payment')$$, 'cm re-approves');

-- Payment authorization ------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
insert into t select 'auth', to_jsonb(public.authorize_payment((select (doc ->> 'id')::uuid from t where name = 'v3')));
select is((select doc ->> 'status' from t where name = 'auth'), 'authorized', 'the payment is authorized');
select is((select (doc ->> 'amount_minor')::bigint from t where name = 'auth'), 420000::bigint, 'for exactly the revised rental, $4,200.00');
select is((select doc ->> 'recipient_email' from t where name = 'auth'), 'northgate@test.local', 'to the approved recipient');
select is(
  (select to_jsonb(public.authorize_payment((select (doc ->> 'id')::uuid from t where name = 'v3'))) ->> 'id'),
  (select doc ->> 'id' from t where name = 'auth'), 'authorizing again returns the same operation (double click)');
select throws_ok(
  $$select public.review_proposal((select (doc ->> 'id')::uuid from t where name = 'v3'), 'correction', '{"changes":{"new_end":"2026-12-18"},"reason":"undo"}')$$,
  '55000', null, 'an authorized payment freezes the proposal');
select throws_ok(
  $$select public.cancel_proposal((select (doc ->> 'proposal_id')::uuid from t where name = 'p'), 'changed our mind')$$,
  '55000', null, 'and it can no longer be cancelled');

-- Publication claims ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select throws_ok(
  $$select public.claim_publication((select (doc ->> 'id')::uuid from t where name = 'v3'), '00000000-0000-4000-8000-00000000a012')$$,
  '42501', null, 'a session of another user cannot be claimed');
insert into t select 'claim_pm', public.claim_publication((select (doc ->> 'id')::uuid from t where name = 'v3'), '00000000-0000-4000-8000-00000000a011');
select is((select doc -> 'publication' ->> 'status' from t where name = 'claim_pm'), 'pending', 'the pm session claims the publication');
select is((select doc ->> 'task_id' from t where name = 'claim_pm'), '15', 'for the booked task');
select is((select doc ->> 'new_start' from t where name = 'claim_pm'), '2026-12-11', 'with the approved start');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok(
  $$select public.claim_publication((select (doc ->> 'id')::uuid from t where name = 'v3'), '00000000-0000-4000-8000-00000000a012')$$,
  '55000', null, 'a live claim cannot be taken over');

reset role;
alter table public.sessions disable trigger sessions_server_clock;
update public.sessions set last_seen = now() - interval '10 minutes' where id = '00000000-0000-4000-8000-00000000a011';
alter table public.sessions enable trigger sessions_server_clock;
set local role authenticated;
insert into t select 'claim_cm', public.claim_publication((select (doc ->> 'id')::uuid from t where name = 'v3'), '00000000-0000-4000-8000-00000000a012');
select is((select doc -> 'publication' ->> 'id' from t where name = 'claim_cm'), (select doc -> 'publication' ->> 'id' from t where name = 'claim_pm'),
  'a claim whose session stopped heartbeating is taken over');
select is((select doc -> 'publication' ->> 'executor_session' from t where name = 'claim_cm'), '00000000-0000-4000-8000-00000000a012',
  'by the claiming session');
select lives_ok(
  $$select public.fail_publication((select (doc -> 'publication' ->> 'id')::uuid from t where name = 'claim_cm'),
      '00000000-0000-4000-8000-00000000a012', 'browser closed')$$,
  'the executor can give up');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
insert into t select 'claim', public.claim_publication((select (doc ->> 'id')::uuid from t where name = 'v3'), '00000000-0000-4000-8000-00000000a011');
select isnt((select doc -> 'publication' ->> 'id' from t where name = 'claim'), (select doc -> 'publication' ->> 'id' from t where name = 'claim_cm'),
  'a failed publication can be claimed again as a new publication');

-- The publication revision ---------------------------------------------------------------------
insert into t select 'pub_input', jsonb_build_object(
  'id', 15, 'constraintType', 'startnoearlierthan', 'constraintDate', '2026-12-11T00:00:00',
  'decisionRef', (select doc -> 'publication' ->> 'id' from t where name = 'claim'));
insert into t select 'changes_ok', jsonb_build_object('tasks', jsonb_build_object(
  'updated', jsonb_build_array((select doc from t where name = 'pub_input')),
  '$input', jsonb_build_object('updated', jsonb_build_array((select doc from t where name = 'pub_input')))));

select throws_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a011', 'pub-x', null,
      jsonb_set((select doc from t where name = 'changes_ok'), '{tasks,$input,updated,0,id}', '16'), 'human',
      (select (doc -> 'publication' ->> 'id')::uuid from t where name = 'claim'))$$,
  '22023', null, 'a publication may only change the booked task');
select throws_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a011', 'pub-x', null,
      jsonb_set((select doc from t where name = 'changes_ok'), '{tasks,$input,updated,0,constraintDate}', '"2026-12-14T00:00:00"'), 'human',
      (select (doc -> 'publication' ->> 'id')::uuid from t where name = 'claim'))$$,
  '22023', null, 'the constraint date must be the approved start');
select throws_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a011', 'pub-x', null,
      (select doc from t where name = 'changes_ok') #- '{tasks,$input,updated,0,decisionRef}', 'human',
      (select (doc -> 'publication' ->> 'id')::uuid from t where name = 'claim'))$$,
  '22023', null, 'the published task must carry the decision reference');
select throws_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a011', 'pub-x', null,
      jsonb_set((select doc from t where name = 'changes_ok'), '{tasks,$input,updated,0,duration}', '3'), 'human',
      (select (doc -> 'publication' ->> 'id')::uuid from t where name = 'claim'))$$,
  '22023', null, 'a publication may not change other task fields');
select throws_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a011', 'pub-x', null,
      (select doc from t where name = 'changes_ok') || '{"dependencies":{"$input":{"removed":[{"id":1}]}}}', 'human',
      (select (doc -> 'publication' ->> 'id')::uuid from t where name = 'claim'))$$,
  '22023', null, 'a publication may not touch other stores');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a012', 'pub-x', null,
      (select doc from t where name = 'changes_ok'), 'human',
      (select (doc -> 'publication' ->> 'id')::uuid from t where name = 'claim'))$$,
  '55000', null, 'only the claiming session publishes');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
insert into t select 'rev', to_jsonb(public.submit_revision('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a011',
  'pub-1', null, (select doc from t where name = 'changes_ok'), 'agent', (select (doc -> 'publication' ->> 'id')::uuid from t where name = 'claim')));
select is((select (doc ->> 'revision_no')::int from t where name = 'rev'), 1, 'the publication is accepted as revision 1');
select is((select doc ->> 'origin' from t where name = 'rev'), 'human',
  'its origin follows the proposal (prepared by a human), not the client''s claim');
select is(
  (select row(status, published_revision) from public.publications where id = (select (doc -> 'publication' ->> 'id')::uuid from t where name = 'claim')),
  row('published'::text, 1), 'the publication is completed in the same transaction');
select is((select state from public.proposals where id = (select (doc ->> 'proposal_id')::uuid from t where name = 'p')),
  'published', 'the proposal is published');
select is(
  (select row(billable_start, billable_end, idle_days) from public.equipment_bookings where id = '00000000-0000-4000-8000-000000000101'),
  row('2026-12-11'::date, '2026-12-19'::date, 0), 'the booking now covers the revised interval with no idle days');
select is(
  (select to_jsonb(public.submit_revision('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a011',
     'pub-1', null, (select doc from t where name = 'changes_ok'), 'human',
     (select (doc -> 'publication' ->> 'id')::uuid from t where name = 'claim'))) ->> 'revision_no'),
  '1', 'a retried submission of the publication returns the accepted revision');
select is((select current_revision from public.projects where id = '00000000-0000-4000-8000-000000000001'), 1,
  'and adds nothing to the log');
select is(
  (public.claim_publication((select (doc ->> 'id')::uuid from t where name = 'v3'), '00000000-0000-4000-8000-00000000a011')) -> 'publication' ->> 'status',
  'published', 'claiming again reports the finished publication');
select is(
  (select status from public.payment_authorizations where id = (select (doc ->> 'id')::uuid from t where name = 'auth')),
  'authorized', 'publication leaves the payment operation untouched');

-- Supplier confirmation and the next proposal ---------------------------------------------------
select throws_ok(
  $$select public.set_supplier_confirmation((select (doc ->> 'proposal_id')::uuid from t where name = 'p'), 'confirmed')$$,
  '42501', null, 'the project manager does not record supplier confirmation');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select is(
  (select to_jsonb(public.set_supplier_confirmation((select (doc ->> 'proposal_id')::uuid from t where name = 'p'), 'confirmed', 'Email from Northgate'))
     ->> 'status'),
  'confirmed', 'the cost manager records the supplier confirmation');
insert into t select 'p_long', public.create_proposal('00000000-0000-4000-8000-000000000101', pg_temp.inputs('2026-12-22'));
select is((select doc ->> 'state' from t where name = 'p_long'), 'draft',
  'a published proposal no longer blocks a new one for the booking');

-- A longer rental: the work needs the crane until Mon, Dec 21 (9 billable days instead of the 7 now
-- booked), so the supplier is paid more and the saving is negative.
select throws_ok(
  $$select public.record_evaluation((select (doc ->> 'version_id')::uuid from t where name = 'p_long'),
      jsonb_set(pg_temp.evaluation(pg_temp.inputs('2026-12-22'), 1, '[]', '[]', 7, 9), '{cost_comparison,saving_minor}', '120000'))$$,
  '22023', null, 'the saving is the booked minus the revised rental, not the other way round');
select is(
  (public.record_evaluation((select (doc ->> 'version_id')::uuid from t where name = 'p_long'),
     pg_temp.evaluation(pg_temp.inputs('2026-12-22'), 1, '[]', '[]', 7, 9))) ->> 'state',
  'evaluated', 'a longer rental with a negative saving is accepted');
select is(
  (select evaluation -> 'cost_comparison' from public.proposal_versions
    where id = (select (doc ->> 'version_id')::uuid from t where name = 'p_long')),
  '{"currency": "USD", "booked_rental_minor": 420000, "supplier_payment_minor": 540000, "saving_minor": -120000}'::jsonb,
  'the supplier is paid the longer rental, 9 days at $600 = $5,400, $1,200 more than booked');

-- approve_fix: the dates and the payment in one call, dates first (20261026040000_one_role.sql) ------
-- The longer rental is checked and has no open assumptions; its payment, $5,400, is over Deepak's $5,000.
insert into t select 'v_long', jsonb_build_object('id', (select doc ->> 'version_id' from t where name = 'p_long'));
select throws_ok(
  $$select public.approve_fix((select (doc ->> 'id')::uuid from t where name = 'v_long'))$$,
  '42501', 'approve_proposal: the payment of 540000 minor units exceeds your approval limit of 500000',
  'approve_fix refuses a payment over the approver''s limit');
select is(
  (select count(*) from public.approvals where proposal_version_id = (select (doc ->> 'id')::uuid from t where name = 'v_long')),
  0::bigint, 'and leaves nothing behind, not even the dates');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select throws_ok(
  $$select public.approve_fix((select (doc ->> 'id')::uuid from t where name = 'v_long'))$$,
  '42501', 'approve_proposal: only a member who can see costs approves the payment', 'approve_fix refuses a member who cannot see costs');
select is(
  (select count(*) from public.approvals where proposal_version_id = (select (doc ->> 'id')::uuid from t where name = 'v_long')),
  0::bigint, 'and leaves nothing behind, not even the dates she may approve on their own');
select is((select state from public.proposals where id = (select (doc ->> 'proposal_id')::uuid from t where name = 'p_long')),
  'evaluated', 'the proposal still waits for its approvals');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
select throws_ok(
  $$select public.approve_fix((select (doc ->> 'id')::uuid from t where name = 'v_long'))$$,
  'P0002', null, 'a non-member cannot approve the fix (the version is not visible to them)');
reset role;
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
select throws_ok(
  $$select public.approve_fix((select (doc ->> 'id')::uuid from t where name = 'v_long'))$$,
  '42501', 'permission denied for function approve_fix', 'anon cannot call approve_fix');
reset role;
select ok(not has_function_privilege('anon', 'public.approve_fix(uuid)', 'execute'), 'anon has no execute privilege on approve_fix');
select ok(has_function_privilege('authenticated', 'public.approve_fix(uuid)', 'execute'), 'signed-in callers have it');

-- A check made stale by a booking change (a new rental rate, then the old one again) is refused.
update public.equipment_bookings set rental_rate_minor = 65000 where id = '00000000-0000-4000-8000-000000000101';
update public.equipment_bookings set rental_rate_minor = 60000 where id = '00000000-0000-4000-8000-000000000101';
select is(
  (select array[(select stale::text from public.proposal_versions where id = (select (doc ->> 'id')::uuid from t where name = 'v_long')),
                (select state from public.proposals where id = (select (doc ->> 'proposal_id')::uuid from t where name = 'p_long'))]),
  array['true', 'draft'], 'the booking change made the check stale and the proposal a draft again');
-- From here Deepak is a full member, as the demo seed makes everyone: cost access, a $250,000 limit.
update public.project_members set approval_limit_minor = 25000000
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000012';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok(
  $$select public.approve_fix((select (doc ->> 'id')::uuid from t where name = 'v_long'))$$,
  '55000', 'approve_proposal: the proposal is draft; this step needs it to be evaluated or in_review or approved',
  'approve_fix refuses a stale check');
select is(
  (select count(*) from public.approvals where proposal_version_id = (select (doc ->> 'id')::uuid from t where name = 'v_long')),
  0::bigint, 'and leaves nothing behind');
select is(
  (public.record_evaluation((select (doc ->> 'id')::uuid from t where name = 'v_long'),
     pg_temp.evaluation(pg_temp.inputs('2026-12-22'), 1, '[]', '[]', 7, 9))) ->> 'state',
  'evaluated', 'checked again');

insert into t select 'fix', public.approve_fix((select (doc ->> 'id')::uuid from t where name = 'v_long'));
select results_eq(
  $$select scope, approver_id, amount_minor from public.approvals
     where proposal_version_id = (select (doc ->> 'id')::uuid from t where name = 'v_long') and status = 'active'
     order by scope$$,
  $$values ('payment'::text, '00000000-0000-4000-8000-000000000012'::uuid, 540000::bigint),
           ('schedule'::text, '00000000-0000-4000-8000-000000000012'::uuid, null::bigint)$$,
  'a full member approves the fix in one call: the dates and the payment, both active');
select is(
  (select array[doc -> 'schedule' ->> 'id', doc -> 'payment' ->> 'id'] from t where name = 'fix'),
  array[
    (select id::text from public.approvals where proposal_version_id = (select (doc ->> 'id')::uuid from t where name = 'v_long')
        and scope = 'schedule' and status = 'active'),
    (select id::text from public.approvals where proposal_version_id = (select (doc ->> 'id')::uuid from t where name = 'v_long')
        and scope = 'payment' and status = 'active')],
  'approve_fix returns both approvals, the dates under schedule and the payment under payment');
select is(
  (select (doc -> 'payment' ->> 'amount_minor')::bigint from t where name = 'fix'),
  (select (evaluation -> 'cost_comparison' ->> 'supplier_payment_minor')::bigint from public.proposal_versions
    where id = (select (doc ->> 'id')::uuid from t where name = 'v_long')),
  'the payment approved is the checked supplier payment');
select is(
  (select array[doc -> 'payment' ->> 'amount_minor', doc -> 'payment' ->> 'currency', doc -> 'payment' ->> 'recipient'] from t where name = 'fix'),
  array['540000', 'USD', 'northgate@test.local'], 'the longer rental, 9 days at $600 = $5,400.00, to the supplier''s payout email');
select is((select state from public.proposals where id = (select (doc ->> 'proposal_id')::uuid from t where name = 'p_long')),
  'approved', 'the proposal is approved');
select is(public.approve_fix((select (doc ->> 'id')::uuid from t where name = 'v_long')), (select doc from t where name = 'fix'),
  'approving the fix again returns the same two approvals');
select is(
  (select count(*) from public.approvals where proposal_version_id = (select (doc ->> 'id')::uuid from t where name = 'v_long')),
  2::bigint, 'and adds none');

-- The payment follows cost access and the limit, not the role: a new payout recipient sends the fix
-- back to review, and a project manager who can see costs approves it again.
reset role;
update public.equipment_bookings set supplier_payout_email = 'accounts@test.local' where id = '00000000-0000-4000-8000-000000000101';
update public.project_members set can_view_costs = true, approval_limit_minor = 25000000
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000011';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is((select state from public.proposals where id = (select (doc ->> 'proposal_id')::uuid from t where name = 'p_long')),
  'in_review', 'a new payout recipient sends the approved fix back to review');
insert into t select 'fix_pm', public.approve_fix((select (doc ->> 'id')::uuid from t where name = 'v_long'));
select is(
  (select array[public.member_role('00000000-0000-4000-8000-000000000001'),
                doc -> 'schedule' ->> 'approver_id', doc -> 'payment' ->> 'approver_id', doc -> 'payment' ->> 'recipient']
     from t where name = 'fix_pm'),
  array['pm', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000011', 'accounts@test.local'],
  'a project manager who can see costs approves the fix for the new recipient: the role does not matter');
select is((select state from public.proposals where id = (select (doc ->> 'proposal_id')::uuid from t where name = 'p_long')),
  'approved', 'and the proposal is approved again');

-- Internal helpers are not callable --------------------------------------------------------------
select throws_ok(
  $$select public.refresh_proposal_state((select (doc ->> 'proposal_id')::uuid from t where name = 'p'))$$,
  '42501', null, 'clients cannot call the internal state helper');
select throws_ok(
  $$select public.invalidate_approvals((select (doc ->> 'id')::uuid from t where name = 'v3'), 'x')$$,
  '42501', null, 'clients cannot invalidate approvals directly');
reset role;

select * from finish();
rollback;
