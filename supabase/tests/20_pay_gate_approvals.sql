-- Two people for a large progress payment (20261108010000_pay_gate_approvals.sql): on Harbor, Deepak asks for
-- approval of the footings payout, he can't approve it himself, Chris approves it, only Deepak can then claim it for
-- PayPal, once, for exactly those firms and amounts, and not after 30 minutes. Up to the threshold nobody else is
-- needed; members who don't see costs can neither ask nor read; a different payout replaces the open request; a
-- demo reset forgets them.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create temporary table t_ids (k text primary key, v uuid);
grant all on t_ids to authenticated;

create function pg_temp.lines(p_granite bigint default 3132000) returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('firm', 'Granite Ridge Concrete', 'amount_minor', p_granite, 'for', 'Form footings, Rebar, footings, Pour footings'),
    jsonb_build_object('firm', 'Pinecrest Sitework', 'amount_minor', 648000, 'for', 'Strip forms and backfill'));
$$;
grant execute on function pg_temp.lines(bigint) to authenticated;

select is((select second_approval_over_minor from public.projects where id = '00000000-0000-4000-8000-000000000002'), 2500000::bigint,
  'a project''s payouts need a second person over $25,000 unless it sets its own threshold');

-- Deepak asks ---------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';

select lives_ok($$insert into t_ids select 'a', (public.request_pay_gate_approval('00000000-0000-4000-8000-000000000002', 25, 'Footings paid', 3780000, 'USD', pg_temp.lines())).id$$,
  'Deepak asks for a second person''s approval of the $37,800 footings payout');
select is((select status || '/' || over_minor || '/' || requested_by from public.pay_gate_approvals where id = (select v from t_ids where k = 'a')),
  'requested/2500000/00000000-0000-4000-8000-000000000012', 'the request is open, with the threshold that made it needed');
select is((public.request_pay_gate_approval('00000000-0000-4000-8000-000000000002', 25, 'Footings paid', 3780000, 'USD', pg_temp.lines())).id,
  (select v from t_ids where k = 'a'), 'asking again for the same payout is the same request');
select throws_ok($$select public.request_pay_gate_approval('00000000-0000-4000-8000-000000000002', 25, 'Footings paid', 3780001, 'USD', pg_temp.lines())$$,
  '22023', null, 'lines that don''t add up to the payout are refused');
select throws_ok(format($$select public.decide_pay_gate_approval(%L, true)$$, (select v from t_ids where k = 'a')),
  '42501', null, 'Deepak cannot approve his own request');
select throws_ok(format($$select public.claim_pay_gate_payout('00000000-0000-4000-8000-000000000002', 25, 3780000, 'USD', pg_temp.lines(), %L, 'PG-25-a')$$, (select v from t_ids where k = 'a')),
  '42501', null, 'nor send it before it is approved');
select throws_ok($$select public.claim_pay_gate_payout('00000000-0000-4000-8000-000000000002', 25, 3780000, 'USD', pg_temp.lines(), null, 'PG-25-a')$$,
  '42501', null, 'nor send it with no approval at all');
select is((public.claim_pay_gate_payout('00000000-0000-4000-8000-000000000002', 25, 1000000, 'USD', '[{"firm":"Pinecrest Sitework","amount_minor":1000000}]', null, 'PG-25-s')) ->> 'needed',
  'false', 'a payout up to the threshold needs nobody else');

-- Chris approves ------------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is((select count(*)::int from public.pay_gate_approvals where id = (select v from t_ids where k = 'a')), 1, 'Chris sees the request');
select is((public.decide_pay_gate_approval((select v from t_ids where k = 'a'), true)).status, 'approved', 'Chris approves it');
select throws_ok(format($$select public.decide_pay_gate_approval(%L, false)$$, (select v from t_ids where k = 'a')),
  '55000', null, 'a decided request is not decided again');
select throws_ok(format($$select public.claim_pay_gate_payout('00000000-0000-4000-8000-000000000002', 25, 3780000, 'USD', pg_temp.lines(), %L, 'PG-25-a')$$, (select v from t_ids where k = 'a')),
  '42501', null, 'Chris approved it, so he cannot be the one who sends it');

-- Deepak sends ----------------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok(format($$select public.claim_pay_gate_payout('00000000-0000-4000-8000-000000000002', 25, 3780000, 'USD', pg_temp.lines(3132001) - 1 || '[{"firm":"Pinecrest Sitework","amount_minor":647999}]', %L, 'PG-25-a')$$, (select v from t_ids where k = 'a')),
  '42501', null, 'a payout split differently from the one approved is refused');
select throws_ok(format($$select public.claim_pay_gate_payout('00000000-0000-4000-8000-000000000002', 26, 3780000, 'USD', pg_temp.lines(), %L, 'PG-26-a')$$, (select v from t_ids where k = 'a')),
  '42501', null, 'and so is the approval used for another gate');
select is((public.claim_pay_gate_payout('00000000-0000-4000-8000-000000000002', 25, 3780000, 'USD',
            '[{"firm":"Pinecrest Sitework","amount_minor":648000},{"firm":"Granite Ridge Concrete","amount_minor":3132000}]',
            (select v from t_ids where k = 'a'), 'PG-25-a')) ->> 'approved_by',
  '00000000-0000-4000-8000-000000000011', 'Deepak sends the payout Chris approved (the firms in any order)');
select is((select status || '/' || sender_batch_id from public.pay_gate_approvals where id = (select v from t_ids where k = 'a')), 'used/PG-25-a',
  'the approval is used up, with the batch it went out in');
select throws_ok(format($$select public.claim_pay_gate_payout('00000000-0000-4000-8000-000000000002', 25, 3780000, 'USD', pg_temp.lines(), %L, 'PG-25-b')$$, (select v from t_ids where k = 'a')),
  '42501', null, 'it cannot pay a second time');
select is((public.claim_pay_gate_payout('00000000-0000-4000-8000-000000000002', 25, 3780000, 'USD', pg_temp.lines(), (select v from t_ids where k = 'a'), 'PG-25-a')) ->> 'resumed',
  'true', 'but the same payout sent again in the same batch, after its answer was lost, goes through: PayPal never pays a batch id twice');
select throws_ok(format($$select public.claim_pay_gate_payout('00000000-0000-4000-8000-000000000002', 25, 3780000, 'USD', pg_temp.lines(3132001) - 1 || '[{"firm":"Pinecrest Sitework","amount_minor":647999}]', %L, 'PG-25-a')$$, (select v from t_ids where k = 'a')),
  '42501', null, 'never with other amounts');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select throws_ok(format($$select public.claim_pay_gate_payout('00000000-0000-4000-8000-000000000002', 25, 3780000, 'USD', pg_temp.lines(), %L, 'PG-25-a')$$, (select v from t_ids where k = 'a')),
  '42501', null, 'nor by anyone but its sender');
reset role;
update public.pay_gate_approvals set used_at = now() - interval '25 hours' where id = (select v from t_ids where k = 'a');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok(format($$select public.claim_pay_gate_payout('00000000-0000-4000-8000-000000000002', 25, 3780000, 'USD', pg_temp.lines(), %L, 'PG-25-a')$$, (select v from t_ids where k = 'a')),
  '42501', null, 'nor a day after it was used');

-- An approval goes stale; a different payout replaces the open request; a withdrawn one can't be decided --
select lives_ok($$insert into t_ids select 'b', (public.request_pay_gate_approval('00000000-0000-4000-8000-000000000002', 25, 'Footings paid', 3780000, 'USD', pg_temp.lines())).id$$,
  'Deepak asks again');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is((public.decide_pay_gate_approval((select v from t_ids where k = 'b'), true)).status, 'approved', 'Chris approves again');
reset role;
update public.pay_gate_approvals set decided_at = now() - interval '31 minutes' where id = (select v from t_ids where k = 'b');
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok(format($$select public.claim_pay_gate_payout('00000000-0000-4000-8000-000000000002', 25, 3780000, 'USD', pg_temp.lines(), %L, 'PG-25-c')$$, (select v from t_ids where k = 'b')),
  '42501', null, 'an approval more than 30 minutes old is refused');
select lives_ok($$insert into t_ids select 'c', (public.request_pay_gate_approval('00000000-0000-4000-8000-000000000002', 25, 'Footings paid', 3780000, 'USD', pg_temp.lines())).id$$,
  'asking again once it is stale opens a new request');
select isnt((select v from t_ids where k = 'c'), (select v from t_ids where k = 'b'), 'a new one');
select is((select status from public.pay_gate_approvals where id = (select v from t_ids where k = 'b')), 'withdrawn', 'and the stale one is withdrawn');
select lives_ok($$insert into t_ids select 'd', (public.request_pay_gate_approval('00000000-0000-4000-8000-000000000002', 25, 'Footings paid', 3132000, 'USD', '[{"firm":"Granite Ridge Concrete","amount_minor":3132000}]')).id$$,
  'asking for a different payout');
select is((select status from public.pay_gate_approvals where id = (select v from t_ids where k = 'c')), 'withdrawn', 'replaces the open request');
select is((public.withdraw_pay_gate_approval((select v from t_ids where k = 'd'))).status, 'withdrawn', 'Deepak takes his request back');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select throws_ok(format($$select public.decide_pay_gate_approval(%L, true)$$, (select v from t_ids where k = 'd')),
  '55000', null, 'a withdrawn request cannot be approved');
select throws_ok(format($$select public.withdraw_pay_gate_approval(%L)$$, (select v from t_ids where k = 'd')),
  '42501', null, 'only the person who asked takes a request back');

-- People who don't see costs ------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000c1","role":"authenticated"}';
select is((select count(*)::int from public.pay_gate_approvals), 0, 'a member who doesn''t see costs reads no approvals');
select throws_ok($$select public.request_pay_gate_approval('00000000-0000-4000-8000-000000000002', 25, 'Footings paid', 3780000, 'USD', pg_temp.lines())$$,
  '42501', null, 'nor asks for one');
select throws_ok($$insert into public.pay_gate_approvals (project_id, gate_id, gate_name, amount_minor, currency, lines, over_minor, requested_by)
                   values ('00000000-0000-4000-8000-000000000002', 25, 'x', 1, 'USD', '[{"firm":"x","amount_minor":1}]', 0, '00000000-0000-4000-8000-0000000000c1')$$,
  '42501', null, 'and nobody writes the table directly');

-- The table itself ----------------------------------------------------------------------------------
reset role;
select throws_ok($$insert into public.pay_gate_approvals (project_id, gate_id, gate_name, amount_minor, currency, lines, over_minor, requested_by, status, decided_by, decided_at)
                   values ('00000000-0000-4000-8000-000000000002', 25, 'x', 1, 'USD', '[{"firm":"x","amount_minor":1}]', 0,
                           '00000000-0000-4000-8000-000000000012', 'declined', '00000000-0000-4000-8000-000000000012', now())$$,
  '23514', null, 'the person who asked can never be the one who decided');
select ok(exists (select 1 from realtime.messages where topic = 'project:00000000-0000-4000-8000-000000000002:workflow' and payload ->> 'table' = 'pay_gate_approvals'),
  'every change is announced on the workflow topic');
select ok(not exists (select 1 from realtime.messages where topic = 'project:00000000-0000-4000-8000-000000000002:workflow' and payload ->> 'table' = 'pay_gate_approvals' and payload ? 'amount_minor'),
  'with no figures in it');
update public.projects set current_revision = current_revision + 1 where id = '00000000-0000-4000-8000-000000000002';
select is((select count(*)::int from public.pay_gate_approvals where project_id = '00000000-0000-4000-8000-000000000002'), 4,
  'a new revision keeps the approvals');
update public.projects set current_revision = 0 where id = '00000000-0000-4000-8000-000000000002';
select is((select count(*)::int from public.pay_gate_approvals where project_id = '00000000-0000-4000-8000-000000000002'), 0,
  'a demo reset (the plan back to revision 0) forgets them');

select * from finish();
rollback;
