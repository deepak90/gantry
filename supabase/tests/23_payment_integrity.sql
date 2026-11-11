-- Payment integrity (20261111050000_payment_integrity.sql). On a copy of the demo a progress payout pays only what the
-- seed plan owes: Harbor's footings, Granite Ridge Concrete $31,320 and Pinecrest Sitework $6,480, once per visit. The
-- exact payout goes out with Chris's approval, and sent again in the same batch it counts once; a second one is refused;
-- more than owed, a firm the gate doesn't pay and a gate a visitor added are refused; after PayPal pays one firm and
-- turns the other down, the rest is paid, then nothing more; a batch PayPal turned down whole is paid again; two halves
-- add up to the seed's amount; free_copy forgets it all. Harbor itself pays as before. Members can no longer store a
-- plan with save_snapshot or read payment_locked_tasks, and the payment lock still holds; a change over 256 KB is
-- refused; the documents bucket takes PDF, PNG, JPEG and plain text up to 5 MB, and a copy's folder 20 files.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create temporary table t (k text primary key, v uuid);
grant all on t to authenticated, service_role;

-- Who is asking, as PostgREST tells the database from their token.
create function pg_temp.be(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;
-- The footings payout as the page sends it: each firm with a share, in the order sent, its item `<batch>-<n>`.
create function pg_temp.lines(p_batch text, p_granite bigint, p_pinecrest bigint) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(x.line order by x.n), '[]'::jsonb)
    from (select 1 as n, jsonb_build_object('firm', 'Granite Ridge Concrete', 'amount_minor', p_granite, 'item_id', p_batch || '-1') as line
           where p_granite is not null
          union all
          select 2, jsonb_build_object('firm', 'Pinecrest Sitework', 'amount_minor', p_pinecrest,
                                       'item_id', p_batch || '-' || case when p_granite is null then 1 else 2 end)
           where p_pinecrest is not null) x;
$$;
-- Claims that payout from copy 12, as the payout function does with the sender's token.
create function pg_temp.pay(p_batch text, p_granite bigint, p_pinecrest bigint, p_gate bigint default 25, p_approval uuid default null)
returns jsonb language sql as $$
  select public.claim_pay_gate_payout('00000000-0000-4000-8000-000000010012', p_gate, coalesce(p_granite, 0) + coalesce(p_pinecrest, 0), 'USD',
                                      pg_temp.lines(p_batch, p_granite, p_pinecrest), p_approval, p_batch);
$$;
-- What counts against the footings in copy 12 (read past RLS, whoever asks).
create function pg_temp.counted() returns bigint language sql stable security definer as $$
  select coalesce(sum(amount_minor), 0)::bigint from public.pay_gate_payouts
   where project_id = '00000000-0000-4000-8000-000000010012' and refused_at is null;
$$;
-- A change of exactly p_bytes bytes, as Postgres prints it: one task's note.
create function pg_temp.change_of(p_bytes int) returns jsonb language sql immutable as $$
  with shell as (select '{"tasks": {"updated": [{"id": 1, "note": ""}]}}'::jsonb as j)
  select jsonb_set(j, '{tasks,updated,0,note}', to_jsonb(repeat('x', p_bytes - octet_length(j::text)))) from shell;
$$;
-- Uploads p_n files into a project's folder, one at a time, as Storage does.
create function pg_temp.upload(p_project uuid, p_n int) returns void language plpgsql as $$
begin
  for i in 1..p_n loop
    insert into storage.objects (bucket_id, name, owner_id)
    values ('documents', p_project || '/' || gen_random_uuid() || '/photo-' || i || '.jpg', (select auth.uid())::text);
  end loop;
end;
$$;
grant execute on function pg_temp.be(uuid), pg_temp.lines(text, bigint, bigint), pg_temp.pay(text, bigint, bigint, bigint, uuid),
  pg_temp.counted(), pg_temp.change_of(int), pg_temp.upload(uuid, int) to authenticated, service_role;

-- Copy 12, claimed by a visitor (b1) who invited someone (b2), as claim_copy and join_copy leave it; b3 is in no copy.
insert into auth.users (instance_id, id, aud, role, created_at, updated_at, is_sso_user, is_anonymous)
select '00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated', now(), now(), false, true
  from unnest(array['00000000-0000-4000-8000-0000000b0001', '00000000-0000-4000-8000-0000000b0002',
                    '00000000-0000-4000-8000-0000000b0003']::uuid[]) u;
select public.free_copy('00000000-0000-4000-8000-000000010012');
update public.copy_pool
   set holder = '00000000-0000-4000-8000-0000000b0001', join_token = encode(extensions.gen_random_bytes(16), 'hex'),
       claimed_at = now() - interval '5 minutes', lease_until = now() + interval '25 minutes', updated_at = now()
 where project_id = '00000000-0000-4000-8000-000000010012';
insert into public.project_members (project_id, user_id, role, can_view_costs, approval_limit_minor) values
  ('00000000-0000-4000-8000-000000010012', '00000000-0000-4000-8000-0000000b0001', 'cm', true, 25000000),
  ('00000000-0000-4000-8000-000000010012', '00000000-0000-4000-8000-0000000b0002', 'pm', true, 25000000);

-- What the seed owes -----------------------------------------------------------------------------------------------
select results_eq($$select template, gate_id, firm, amount_minor from public.pay_gate_amounts order by 1, 2, 3$$,
  $$values ('harbor', 25::bigint, 'Granite Ridge Concrete', 3132000::bigint), ('harbor', 25::bigint, 'Pinecrest Sitework', 648000::bigint)$$,
  'Harbor''s footings pay Granite Ridge Concrete $31,320 and Pinecrest Sitework $6,480');
-- Worked out from Harbor's seed plan as the page does (packages/shared/src/progress-payments.ts): each task under the
-- rows the gate pays, valued at its budget, earned by its percent complete, less what is kept back, less what was paid.
select results_eq($$
  with recursive
    tree(node) as (
      select x from public.demo_seeds d, jsonb_array_elements(d.snapshot -> 'tasksData') x
       where d.project_id = '00000000-0000-4000-8000-000000000002'
      union all
      select c from tree, jsonb_array_elements(coalesce(tree.node -> 'children', '[]'::jsonb)) c),
    gate as (select node -> 'payGate' as pay_gate from tree where node ->> 'id' = '25'),
    under(node) as (
      select node from tree where node ->> 'id' in (select jsonb_array_elements_text(pay_gate -> 'pays') from gate)
      union all
      select c from under, jsonb_array_elements(coalesce(under.node -> 'children', '[]'::jsonb)) c),
    work as (
      select u.node ->> 'id' as task_id,
             round(round((u.node ->> 'budgetMinor')::numeric * coalesce((u.node ->> 'percentDone')::numeric, 0) / 100)
                   * (1 - (select (pay_gate ->> 'retainage')::numeric from gate)))
               - coalesce((u.node ->> 'paidMinor')::numeric, 0) as due
        from under u
       where coalesce(jsonb_array_length(u.node -> 'children'), 0) = 0 and coalesce((u.node ->> 'duration')::numeric, 0) > 0),
    firm_of as (
      select a ->> 'event' as task_id, coalesce(r ->> 'company', r ->> 'name') as firm
        from public.demo_seeds d, jsonb_array_elements(d.snapshot -> 'assignmentsData') a, jsonb_array_elements(d.snapshot -> 'resourcesData') r
       where d.project_id = '00000000-0000-4000-8000-000000000002' and r ->> 'id' = a ->> 'resource' and coalesce(r ->> 'kind', '') <> 'equipment')
  select 'harbor'::text, 25::bigint, f.firm, sum(greatest(w.due, 0))::bigint
    from work w join firm_of f on f.task_id = w.task_id
   group by f.firm order by f.firm$$,
  $$select template, gate_id, firm, amount_minor from public.pay_gate_amounts where template = 'harbor' and gate_id = 25 order by firm$$,
  'which is what Harbor''s seed plan owes at the footings, all reported done, less 10% kept back');

-- The exact payout, with the second person's approval -----------------------------------------------------------
set local role authenticated;
select pg_temp.be('00000000-0000-4000-8000-0000000b0001');
insert into t select 'first', (public.request_pay_gate_approval('00000000-0000-4000-8000-000000010012', 25, 'Footings paid', 3780000, 'USD',
  pg_temp.lines('PG-25-first', 3132000, 648000))).id;
select pg_temp.be('00000000-0000-4000-8000-0000000b0002');
select is((public.decide_pay_gate_approval((select v from t where k = 'first'), true)).status, 'approved', 'the person invited approves the $37,800 footings payout');
select pg_temp.be('00000000-0000-4000-8000-0000000b0001');
select is(pg_temp.pay('PG-25-first', 3132000, 648000, 25, (select v from t where k = 'first')) ->> 'needed', 'true',
  'the footings payout, exactly as the seed owes it, goes out');
select is(pg_temp.counted(), 3780000::bigint, 'and counts $37,800 against the footings');
select is(pg_temp.pay('PG-25-first', 3132000, 648000, 25, (select v from t where k = 'first')) ->> 'resumed', 'true',
  'sent again in the same batch, after its answer was lost, it goes through');
select is(pg_temp.counted(), 3780000::bigint, 'and counts once');
insert into t select 'second', (public.request_pay_gate_approval('00000000-0000-4000-8000-000000010012', 25, 'Footings paid', 3780000, 'USD',
  pg_temp.lines('PG-25-second', 3132000, 648000))).id;
select pg_temp.be('00000000-0000-4000-8000-0000000b0002');
select is((public.decide_pay_gate_approval((select v from t where k = 'second'), true)).status, 'approved', 'a second footings payout is approved too');
select pg_temp.be('00000000-0000-4000-8000-0000000b0001');
select throws_ok($$select pg_temp.pay('PG-25-second', 3132000, 648000, 25, (select v from t where k = 'second'))$$,
  '42501', 'This payment has already been paid.', 'but it is refused: the footings are paid');
reset role;
select is((select status from public.pay_gate_approvals where id = (select v from t where k = 'second')), 'approved', 'and the approval is not used up');

-- Only what the seed owes, only for its gate ----------------------------------------------------------------------
-- From here on the copy pays up to $100,000 without a second person, and starts each case with nothing paid.
update public.projects set second_approval_over_minor = 10000000 where id = '00000000-0000-4000-8000-000000010012';
delete from public.pay_gate_payouts where project_id = '00000000-0000-4000-8000-000000010012';
set local role authenticated;
select pg_temp.be('00000000-0000-4000-8000-0000000b0001');
select throws_ok($$select pg_temp.pay('PG-25-over', 3132001, 648000)$$,
  '42501', 'That is more than Granite Ridge Concrete is owed for this payment, which is $31,320 in all.', 'a cent more than a firm is owed is refused');
select throws_ok($$select pg_temp.pay('PG-25-over', null, 700000)$$,
  '42501', 'That is more than Pinecrest Sitework is owed for this payment, which is $6,480 in all.', 'for either firm');
select throws_ok($$select public.claim_pay_gate_payout('00000000-0000-4000-8000-000000010012', 25, 3880000, 'USD',
    pg_temp.lines('PG-25-more', 3132000, 648000) || '[{"firm":"Northgate Equipment Rental","amount_minor":100000,"item_id":"PG-25-more-3"}]', null, 'PG-25-more')$$,
  '42501', 'Only Granite Ridge Concrete and Pinecrest Sitework are paid from this payment in the online demo.', 'a firm the footings don''t pay is refused');
select throws_ok($$select public.claim_pay_gate_payout('00000000-0000-4000-8000-000000010012', 25, 648000, 'USD',
    '[{"firm":"Pinecrest Sitework","amount_minor":324000,"item_id":"PG-25-two-1"},{"firm":"Pinecrest Sitework","amount_minor":324000,"item_id":"PG-25-two-2"}]', null, 'PG-25-two')$$,
  '22023', 'A payout pays each firm once.', 'so is a firm named twice');
select throws_ok($$select pg_temp.pay('PG-26-added', 100000, null, 26)$$,
  '42501', 'Only the footings payment can be paid in the online demo.', 'a gate a visitor added can''t be paid in the online demo');
select throws_ok($$select pg_temp.pay('PG-412-handover', 100000, null, 412)$$,
  '42501', 'Only the footings payment can be paid in the online demo.', 'nor can any other milestone of the plan');
reset role;
select is((select count(*)::int from public.pay_gate_payouts where project_id = '00000000-0000-4000-8000-000000010012'), 0, 'none of the refused payouts counts');
set local role authenticated;
select pg_temp.be('00000000-0000-4000-8000-000000000012');
select is((public.claim_pay_gate_payout('00000000-0000-4000-8000-000000000002', 26, 1000000, 'USD', '[{"firm":"Anyone at all","amount_minor":1000000}]', null, 'PG-26-harbor')) ->> 'needed',
  'false', 'Harbor itself, in no pool, pays any gate as before');
reset role;
select is((select count(*)::int from public.pay_gate_payouts where project_id = '00000000-0000-4000-8000-000000000002'), 0, 'and keeps no count');

-- PayPal pays one firm and turns the other down ---------------------------------------------------------------------
set local role authenticated;
select pg_temp.be('00000000-0000-4000-8000-0000000b0001');
select is(pg_temp.pay('PG-25-p1', 3132000, 648000) ->> 'needed', 'false', 'the footings payout goes out');
select throws_ok($$select public.settle_pay_gate_payout('00000000-0000-4000-8000-000000010012', 'PG-25-p1', array['PG-25-p1-1'])$$,
  '42501', null, 'a visitor cannot take a payment off');
set local role service_role;
select is(public.settle_pay_gate_payout('00000000-0000-4000-8000-000000010012', 'PG-25-p1', array['PG-25-p1-2']), 1,
  'PayPal pays Granite Ridge Concrete and turns Pinecrest Sitework''s payment down: that one no longer counts');
select is(public.settle_pay_gate_payout('00000000-0000-4000-8000-000000010012', 'PG-25-p1', array['PG-25-p1-2']), 0, 'once');
select is(pg_temp.counted(), 3132000::bigint, 'what counts is what PayPal paid');
set local role authenticated;
select throws_ok($$select pg_temp.pay('PG-25-p2', 3132000, 648000)$$,
  '42501', 'Granite Ridge Concrete has already been sent $31,320 of the $31,320 it is owed for this payment.', 'paying both firms again is refused');
select is(pg_temp.pay('PG-25-p3', null, 648000) ->> 'needed', 'false', 'the rest, Pinecrest Sitework''s $6,480, goes out');
select throws_ok($$select pg_temp.pay('PG-25-p4', 3132000, 648000)$$, '42501', 'This payment has already been paid.', 'then a second full payment is refused');
select throws_ok($$select pg_temp.pay('PG-25-p5', null, 1)$$, '42501', 'This payment has already been paid.', 'as is a cent more');
select is(pg_temp.counted(), 3780000::bigint, 'and $37,800 went out in all');

-- A batch PayPal turned down whole, a batch sent again otherwise paired, a payment in two halves --------------------
reset role;
delete from public.pay_gate_payouts where project_id = '00000000-0000-4000-8000-000000010012';
set local role authenticated;
select is(pg_temp.pay('PG-25-w1', 3132000, 648000) ->> 'needed', 'false', 'a footings payout goes out');
set local role service_role;
select is(public.settle_pay_gate_payout('00000000-0000-4000-8000-000000010012', 'PG-25-w1', '{}', true), 2, 'PayPal turns the whole batch down');
set local role authenticated;
select is(pg_temp.pay('PG-25-w2', 3132000, 648000) ->> 'needed', 'false', 'so it is paid in a new one');

reset role;
delete from public.pay_gate_payouts where project_id = '00000000-0000-4000-8000-000000010012';
set local role authenticated;
select lives_ok($$select pg_temp.pay('PG-25-r', 3132000, 648000)$$, 'a footings payout goes out');
select lives_ok($$select public.claim_pay_gate_payout('00000000-0000-4000-8000-000000010012', 25, 3780000, 'USD',
    '[{"firm":"Granite Ridge Concrete","amount_minor":3132000,"item_id":"PG-25-r-2"},{"firm":"Pinecrest Sitework","amount_minor":648000,"item_id":"PG-25-r-1"}]', null, 'PG-25-r')$$,
  'and is sent again in the same batch with its items the other way round');
reset role;
select is((select count(*)::int || '/' || sum(amount_minor) || '/' || count(item_id) from public.pay_gate_payouts where project_id = '00000000-0000-4000-8000-000000010012'),
  '2/3780000/0', 'it counts once, and its items no longer say which firm they were');
set local role service_role;
select is(public.settle_pay_gate_payout('00000000-0000-4000-8000-000000010012', 'PG-25-r', array['PG-25-r-1', 'PG-25-r-2']), 0,
  'so PayPal''s word on an item takes nothing of it back');

reset role;
delete from public.pay_gate_payouts where project_id = '00000000-0000-4000-8000-000000010012';
set local role authenticated;
select is(pg_temp.pay('PG-25-h1', 1566000, 324000) ->> 'needed', 'false', 'half the footings done: half of what is owed goes out');
select throws_ok($$select pg_temp.pay('PG-25-hx', 1566001, null)$$,
  '42501', 'Granite Ridge Concrete has already been sent $15,660 of the $31,320 it is owed for this payment.', 'the rest and a cent more is refused');
select is(pg_temp.pay('PG-25-h2', 1566000, 324000) ->> 'needed', 'false', 'the rest goes out once the work is done');
select throws_ok($$select pg_temp.pay('PG-25-h3', 1, null)$$, '42501', 'This payment has already been paid.', 'and then nothing more');

-- A new visit -------------------------------------------------------------------------------------------------------
select throws_ok($$select * from public.pay_gate_payouts$$, '42501', null, 'visitors read no payouts');
select throws_ok($$select * from public.pay_gate_amounts$$, '42501', null, 'nor the seed''s amounts');
reset role;
select public.free_copy('00000000-0000-4000-8000-000000010012');
select is((select count(*)::int from public.pay_gate_payouts where project_id = '00000000-0000-4000-8000-000000010012'), 0,
  'free_copy forgets the visit''s payouts with it');
insert into public.pay_gate_payouts (project_id, sender_batch_id, firm, gate_id, amount_minor)
values ('00000000-0000-4000-8000-000000010012', 'PG-25-left', 'Pinecrest Sitework', 25, 648000);
update public.copy_pool
   set holder = '00000000-0000-4000-8000-0000000b0002', join_token = encode(extensions.gen_random_bytes(16), 'hex'),
       claimed_at = now(), lease_until = now() + interval '30 minutes', updated_at = now()
 where project_id = '00000000-0000-4000-8000-000000010012';
select is((select count(*)::int from public.pay_gate_payouts where project_id = '00000000-0000-4000-8000-000000010012'), 0,
  'and a copy claimed anew starts with none, whatever was left');

-- The stored plan ---------------------------------------------------------------------------------------------------
insert into public.sessions (id, user_id, project_id)
values ('00000000-0000-4000-8000-0000000b5001', '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.be('00000000-0000-4000-8000-000000000012');
select throws_ok($$select public.save_snapshot('00000000-0000-4000-8000-000000000001', 0, '{"tasksData":[]}', '00000000-0000-4000-8000-0000000b5001')$$,
  '42501', null, 'a member can no longer store a plan with save_snapshot');
select is(octet_length(pg_temp.change_of(262144)::text), 262144, 'a change of 256 KB, as Postgres prints it');
select lives_ok($$select public.submit_revision('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000b5001', 'size-256k', null, pg_temp.change_of(262144))$$,
  'is saved');
select throws_ok($$select public.submit_revision('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000b5001', 'size-over', null, pg_temp.change_of(262145))$$,
  '54000', 'This change is too big to save at once: 257 KB, and the most is 256 KB. Make it in smaller steps.', 'a byte more is refused, in plain words');
select throws_ok($$select public.submit_revision('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000b5001', 'size-1m', null, pg_temp.change_of(1048576))$$,
  '54000', null, 'as is a change of 1 MB');

-- The payment lock ------------------------------------------------------------------------------------------------
select pg_temp.be('00000000-0000-4000-8000-0000000b0003');
select throws_ok($$select * from public.payment_locked_tasks('00000000-0000-4000-8000-000000000001')$$, '42501', null,
  'payment_locked_tasks refuses someone outside the project');
select pg_temp.be('00000000-0000-4000-8000-000000000012');
select throws_ok($$select * from public.payment_locked_tasks('00000000-0000-4000-8000-000000000001')$$, '42501', null,
  'and the project''s own members: no app reads it');
-- An approved fix of Riverside's crane booking whose payment PayPal has not settled yet (as in 16_payment_lock.sql).
reset role;
insert into public.proposals (id, project_id, booking_id, state, current_version_no)
values ('00000000-0000-4000-8000-0000000b02cc', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', 'approved', 1);
insert into public.proposal_versions (id, project_id, proposal_id, version_no, source_revision, inputs)
values ('00000000-0000-4000-8000-0000000b03cc', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000b02cc', 1, 0,
        '{"new_start":"2026-12-11","new_end":"2026-12-18"}');
insert into public.approvals (id, project_id, proposal_version_id, approver_id, scope, content_hash, amount_minor, currency, recipient, source_revision)
values ('00000000-0000-4000-8000-0000000b04cc', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000b03cc',
        '00000000-0000-4000-8000-000000000012', 'payment', 'h', 360000, 'USD', 'supplier@test.local', 0);
insert into public.payment_authorizations (id, project_id, approval_id, proposal_version_id, amount_minor, currency, recipient_email, authorized_by, status)
values ('00000000-0000-4000-8000-0000000b05cc', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000b04cc',
        '00000000-0000-4000-8000-0000000b03cc', 360000, 'USD', 'supplier@test.local', '00000000-0000-4000-8000-000000000012', 'pending');
set local role authenticated;
select throws_ok(format($$select public.submit_revision('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000b5001', 'lock-1', null,
    '{"tasks":{"updated":[{"id":%s,"startDate":"2026-12-14T00:00:00"}]}}')$$,
    (select task_id from public.equipment_bookings where id = '00000000-0000-4000-8000-000000000101')),
  '55006', null, 'the lock still keeps a member from moving the task PayPal is paying for');

-- Stored files ----------------------------------------------------------------------------------------------------
reset role;
select results_eq($$select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'documents'$$,
  $$values (false, 5242880::bigint, array['application/pdf', 'image/png', 'image/jpeg', 'text/plain'])$$,
  'the documents bucket takes PDF, PNG, JPEG and plain text, up to 5 MB each');
insert into public.project_members (project_id, user_id, role, can_view_costs, approval_limit_minor)
values ('00000000-0000-4000-8000-000000010012', '00000000-0000-4000-8000-0000000b0002', 'cm', true, 25000000);
create temporary table t_files as
  select (select count(*)::int from storage.objects where bucket_id = 'documents' and name like '00000000-0000-4000-8000-000000010012/%') as copy_files;
grant select on t_files to authenticated;
set local role authenticated;
select pg_temp.be('00000000-0000-4000-8000-0000000b0002');
select lives_ok(format($$select pg_temp.upload('00000000-0000-4000-8000-000000010012', %s)$$, 20 - (select copy_files from t_files)),
  'a visitor fills the copy''s folder up to 20 files, the seed''s quote among them');
select throws_ok($$select pg_temp.upload('00000000-0000-4000-8000-000000010012', 1)$$, '42501', null, 'and the 21st is refused');
select pg_temp.be('00000000-0000-4000-8000-000000000012');
select lives_ok($$select pg_temp.upload('00000000-0000-4000-8000-000000000001', 21)$$, 'a project in no pool keeps any number, as before');

select * from finish();
rollback;
