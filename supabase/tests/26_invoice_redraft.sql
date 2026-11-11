-- An invoice PayPal never took is drafted again when it is prepared again (20261111160000_invoice_redraft.sql): one
-- refused before PayPal made it takes the corrected lines, title and total, and is a draft again; one PayPal has,
-- sent or only made, stays as it stands, so a change is never billed twice.
-- Personas: 12 sees costs on Harbor Street Offices.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create temp table t (name text primary key, doc jsonb);
grant all on t to authenticated, service_role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
insert into t select 'first', to_jsonb(public.prepare_invoice('00000000-0000-4000-8000-000000000002', 9101, null, 'Change order: Light fixtures, levels 1 to 3',
  jsonb_build_array(jsonb_build_object('label', repeat('Review fixture schedule and submittals, ', 5), 'amount_minor', 1620000))));
reset role;

-- PayPal refused it before it made an invoice, as on the hosted site.
set local role service_role;
update public.invoices set status = 'failed', message = 'INVALID_ITEM_NAME_LENGTH: Item Name should be less than 200 characters.'
 where id = (select (doc ->> 'id')::uuid from t where name = 'first');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
insert into t select 'redrafted', to_jsonb(public.prepare_invoice('00000000-0000-4000-8000-000000000002', 9101, null, 'Change order: Light fixtures, levels 1 to 3',
  '[{"label":"Light fixtures, level 1 (14 tasks)","amount_minor":1620000,"detail":"Review fixture schedule and submittals $600"},{"label":"Order light fixtures, level 1","amount_minor":325000}]'::jsonb));
reset role;

select is((select doc ->> 'id' from t where name = 'redrafted'), (select doc ->> 'id' from t where name = 'first'), 'still the change''s one invoice');
select is((select doc -> 'lines' -> 0 ->> 'label' from t where name = 'redrafted'), 'Light fixtures, level 1 (14 tasks)', 'with the corrected lines');
select is((select (doc ->> 'amount_minor')::bigint from t where name = 'redrafted'), 1945000::bigint, 'and their total');
select is((select doc ->> 'status' from t where name = 'redrafted'), 'draft', 'a draft again');
select is((select doc ->> 'message' from t where name = 'redrafted'), null, 'without the refusal');

-- Once PayPal has it, it stays as it stands.
set local role service_role;
update public.invoices set status = 'sent', paypal_invoice_id = 'INV2-REDRAFT-TEST', sent_at = now()
 where id = (select (doc ->> 'id')::uuid from t where name = 'first');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
insert into t select 'sent', to_jsonb(public.prepare_invoice('00000000-0000-4000-8000-000000000002', 9101, null, 'Something else',
  '[{"label":"Other","amount_minor":5}]'::jsonb));
reset role;
select is((select doc -> 'lines' -> 0 ->> 'label' from t where name = 'sent'), 'Light fixtures, level 1 (14 tasks)', 'a sent invoice keeps its lines');
select is((select doc ->> 'status' from t where name = 'sent'), 'sent', 'and stays sent');

-- Made on PayPal but its sending refused: PayPal has those lines, so they stay too.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
insert into t select 'made', to_jsonb(public.prepare_invoice('00000000-0000-4000-8000-000000000002', 9102, null, 'Level 2',
  '[{"label":"Install light fixtures, level 2","amount_minor":620000}]'::jsonb));
reset role;
set local role service_role;
update public.invoices set status = 'failed', paypal_invoice_id = 'INV2-MADE-TEST'
 where id = (select (doc ->> 'id')::uuid from t where name = 'made');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
insert into t select 'made again', to_jsonb(public.prepare_invoice('00000000-0000-4000-8000-000000000002', 9102, null, 'Level 2, again',
  '[{"label":"Other","amount_minor":5}]'::jsonb));
reset role;
select is((select doc -> 'lines' -> 0 ->> 'label' from t where name = 'made again'), 'Install light fixtures, level 2', 'one PayPal made keeps the lines it has');
select is((select doc ->> 'status' from t where name = 'made again'), 'failed', 'and its state');

select * from finish();
rollback;
