-- PayPal's caps on the hosted demo (20261111020000_payment_quotas.sql, lowered by 20261111040000_visitor_limits.sql):
-- a payout counts once and by its amount, both or neither; an invoice counts once; per copy and per day; the service
-- role alone counts them.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- The local database is shared: start from no counts, whatever ran before (rolled back after).
delete from public.quota_usage;

select results_eq($$select kind, per_copy, per_day from public.quota_limits where kind in ('payout', 'payout_minor', 'invoice') order by kind$$,
  $$values ('invoice', 3, 60), ('payout', 3, 30), ('payout_minor', 6000000, 15000000)$$,
  'three payouts and three invoices per copy, thirty payouts and sixty invoices a day; $60,000 of payouts per copy, $150,000 a day');

set local role service_role;
select is(public.use_payment_quota('payout', '00000000-0000-4000-8000-000000000002', 3780000), true, 'the footings payout fits');
select is((select used from public.quota_usage where kind = 'payout' and project_id = '00000000-0000-4000-8000-000000000002'), 1, 'it counts once');
select is((select used from public.quota_usage where kind = 'payout_minor' and project_id = '00000000-0000-4000-8000-000000000002'), 3780000, 'and by its amount');
select is(public.use_payment_quota('payout', '00000000-0000-4000-8000-000000000002', 2220001), false, 'a payout past the copy''s amount is refused');
select is((select used from public.quota_usage where kind = 'payout' and project_id = '00000000-0000-4000-8000-000000000002'), 1,
  'and its count is taken back with it');
select is((select used from public.quota_usage where kind = 'payout_minor' and project_id = '00000000-0000-4000-8000-000000000002'), 3780000, 'counting nothing');
select is(public.use_payment_quota('payout', '00000000-0000-4000-8000-000000000002', 2220000), true, 'what is left of the copy''s amount fits');
reset role;
update public.quota_limits set per_copy = 2 where kind = 'payout';
set local role service_role;
select is(public.use_payment_quota('payout', '00000000-0000-4000-8000-000000000002', 1), false, 'past the copy''s number of payouts, even for a cent');
reset role;
update public.quota_limits set per_copy = 3 where kind = 'payout';
set local role service_role;
select is(public.use_payment_quota('invoice', '00000000-0000-4000-8000-000000000002'), true, 'an invoice counts by itself');
select is((select used from public.quota_usage where kind = 'invoice' and project_id = '00000000-0000-4000-8000-000000000002'), 1, 'once');
select throws_ok($$select public.use_payment_quota('payout', '00000000-0000-4000-8000-000000000002')$$, '22023', null, 'a payout needs its amount');
select throws_ok($$select public.use_payment_quota('payout', '00000000-0000-4000-8000-000000000002', 0)$$, '22023', null, 'a positive one');
select throws_ok($$select public.use_payment_quota('refund', '00000000-0000-4000-8000-000000000002', 1)$$, '22023', null, 'a quota that does not exist');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok($$select public.use_payment_quota('payout', '00000000-0000-4000-8000-000000000002', 1)$$, '42501', null, 'a member cannot count their own payments');
set local role anon;
select throws_ok($$select public.use_payment_quota('invoice', '00000000-0000-4000-8000-000000000002')$$, '42501', null, 'nor can anyone else');

select * from finish();
rollback;
