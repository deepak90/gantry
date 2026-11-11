-- Project documents: the documents bucket, register_document and delete_document rules, RLS on the
-- table and on storage.objects (the project manager never sees quotes, invoices or receipts),
-- payment receipts filed by the service role (one per payment), the workflow broadcast and
-- reset_demo. Stored files are simulated with storage.objects rows, as the Storage API writes them.
-- Personas: the demo seed makes every member a full member (20261026040000_one_role.sql); this file
-- puts 11 back as the project manager (no cost access) and 12 as the cost manager of project 01
-- first, so the cost-document rules are proven against someone who cannot see costs.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

update public.project_members set role = 'pm', can_view_costs = false, approval_limit_minor = 0
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000011';
update public.project_members set role = 'cm', can_view_costs = true, approval_limit_minor = 500000
 where project_id = '00000000-0000-4000-8000-000000000001' and user_id = '00000000-0000-4000-8000-000000000012';

create temp table t (name text primary key, doc jsonb);
grant all on t to authenticated, service_role;

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at, is_sso_user, is_anonymous)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000aa', 'authenticated', 'authenticated',
        'outsider@test.local', now(), now(), false, false);

-- Start from a project without documents (the seed quote included; everything is rolled back).
delete from public.project_documents where project_id = '00000000-0000-4000-8000-000000000001';
set local storage.allow_delete_query = 'true';
delete from storage.objects where bucket_id = 'documents';
reset storage.allow_delete_query;

-- Uploaded files (project 1): {project}/{uuid}/{name}, owner_id = the uploader, metadata from Storage.
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('documents', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d001/site-photo.jpg',
   '00000000-0000-4000-8000-000000000011', '{"size": 2048, "mimetype": "image/jpeg"}'),
  ('documents', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d002/northgate-invoice.pdf',
   '00000000-0000-4000-8000-000000000012', '{"size": 4096, "mimetype": "application/pdf"}'),
  ('documents', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d003/quote-from-site.pdf',
   '00000000-0000-4000-8000-000000000011', '{"size": 1000, "mimetype": "application/pdf"}'),
  ('documents', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d004/frame-drawing.pdf',
   '00000000-0000-4000-8000-000000000012', '{"size": 3000, "mimetype": "application/pdf"}'),
  ('documents', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d005/half-finished.txt',
   '00000000-0000-4000-8000-000000000011', '{"size": 10, "mimetype": "text/plain"}'),
  ('documents', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d006/cm-scratch.txt',
   '00000000-0000-4000-8000-000000000012', '{"size": 10, "mimetype": "text/plain"}');

-- The bucket ----------------------------------------------------------------------------------
select is(
  (select row(public, file_size_limit, allowed_mime_types) from storage.buckets where id = 'documents'),
  row(false, 5242880::bigint, array['application/pdf', 'image/png', 'image/jpeg', 'text/plain']),
  'the documents bucket is private, takes PDF, PNG, JPEG and plain text, and 5 MiB a file (20261111050000_payment_integrity.sql)');

-- register_document ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select throws_ok(
  $$insert into public.project_documents (project_id, kind, name, mime_type, size_bytes, storage_path)
    values ('00000000-0000-4000-8000-000000000001', 'photo', 'x.jpg', 'image/jpeg', 1, 'x')$$,
  '42501', null, 'clients cannot insert documents directly');

insert into t select 'photo', to_jsonb(public.register_document('00000000-0000-4000-8000-000000000001', 15, 'photo',
  'Site photo, crane pad.jpg', 'image/jpeg', 1,
  '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d001/site-photo.jpg', 'Crane pad ready'));
select is(
  (select jsonb_build_object('kind', doc ->> 'kind', 'task', doc -> 'task_id', 'cost', doc -> 'cost_sensitive',
     'by', doc ->> 'created_by', 'via', doc ->> 'created_via', 'size', doc -> 'size_bytes', 'text', doc ->> 'text_content')
     from t where name = 'photo'),
  '{"kind": "photo", "task": 15, "cost": false, "by": "00000000-0000-4000-8000-000000000011", "via": "upload",
    "size": 2048, "text": "Crane pad ready"}'::jsonb,
  'a member registers a photo of task 15; the stored file''s size wins over the declared one');
select is(
  (select to_jsonb(public.register_document('00000000-0000-4000-8000-000000000001', 15, 'photo',
     'Site photo, crane pad.jpg', 'image/jpeg', 2048,
     '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d001/site-photo.jpg')) ->> 'id'),
  (select doc ->> 'id' from t where name = 'photo'), 'registering the same upload again returns the same document');

select throws_ok(
  $$select public.register_document('00000000-0000-4000-8000-000000000001', 15, 'receipt', 'r.pdf', 'application/pdf', 1,
      '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d005/half-finished.txt')$$,
  '42501', null, 'members cannot file payment receipts');
select throws_ok(
  $$select public.register_document('00000000-0000-4000-8000-000000000001', 15, 'spreadsheet', 'a.txt', 'text/plain', 1,
      '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d005/half-finished.txt')$$,
  '22023', null, 'the kind is one of the document kinds');
select throws_ok(
  $$select public.register_document('00000000-0000-4000-8000-000000000001', 15, 'other', '  ', 'text/plain', 1,
      '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d005/half-finished.txt')$$,
  '22023', null, 'a document needs a file name');
select throws_ok(
  $$select public.register_document('00000000-0000-4000-8000-000000000001', 15, 'other', 'notes/a.txt', 'text/plain', 1,
      '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d005/half-finished.txt')$$,
  '22023', null, 'file names have no slashes');
select throws_ok(
  $$select public.register_document('00000000-0000-4000-8000-000000000001', 15, 'other', 'a.txt', 'plain text', 1,
      '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d005/half-finished.txt')$$,
  '22023', null, 'the media type looks like type/subtype');
select throws_ok(
  $$select public.register_document('00000000-0000-4000-8000-000000000001', 999999, 'other', 'a.txt', 'text/plain', 1,
      '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d005/half-finished.txt')$$,
  '22023', null, 'a document links to a task in the plan');
select throws_ok(
  $$select public.register_document('00000000-0000-4000-8000-000000000001', null, 'other', 'a.txt', 'text/plain', 1,
      '00000000-0000-4000-8000-0000000000f1/00000000-0000-4000-8000-00000000d005/half-finished.txt')$$,
  '22023', null, 'the file must sit in the project''s own folder');
select throws_ok(
  $$select public.register_document('00000000-0000-4000-8000-000000000001', null, 'other', 'a.txt', 'text/plain', 1,
      '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d0ff/never-uploaded.txt')$$,
  'P0002', null, 'a file that was never uploaded cannot be registered');
select throws_ok(
  $$select public.register_document('00000000-0000-4000-8000-000000000001', null, 'drawing', 'a.pdf', 'application/pdf', 1,
      '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d004/frame-drawing.pdf')$$,
  '42501', null, 'nobody registers a file someone else uploaded');
select throws_ok(
  $$select public.register_document('00000000-0000-4000-8000-000000000001', null, 'other', 'a.txt', 'text/plain', 1,
      '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d005/half-finished.txt', repeat('x', 204801))$$,
  '22023', null, 'the text content is capped at 200 KiB');

-- The project manager uploads the supplier's quote: it is a cost document from then on.
insert into t select 'pm_quote', to_jsonb(public.register_document('00000000-0000-4000-8000-000000000001', 15, 'quote',
  'Quote from site.pdf', 'application/pdf', 1000,
  '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d003/quote-from-site.pdf'));
select is((select (doc ->> 'cost_sensitive')::boolean from t where name = 'pm_quote'), true, 'a quote is cost-sensitive');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
select throws_ok(
  $$select public.register_document('00000000-0000-4000-8000-000000000001', null, 'other', 'a.txt', 'text/plain', 1,
      '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d005/half-finished.txt')$$,
  '42501', null, 'a non-member cannot register documents');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
insert into t select 'invoice', to_jsonb(public.register_document('00000000-0000-4000-8000-000000000001', 15, 'invoice',
  'Northgate invoice 2041.pdf', 'Application/PDF', 4096,
  '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d002/northgate-invoice.pdf'));
insert into t select 'drawing', to_jsonb(public.register_document('00000000-0000-4000-8000-000000000001', null, 'drawing',
  'Frame GA drawing.pdf', 'application/pdf', 3000,
  '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d004/frame-drawing.pdf'));
select is(
  (select jsonb_build_object('cost', doc -> 'cost_sensitive', 'mime', doc ->> 'mime_type') from t where name = 'invoice'),
  '{"cost": true, "mime": "application/pdf"}'::jsonb, 'an invoice is cost-sensitive; media types are stored in lower case');
select is((select (doc ->> 'cost_sensitive')::boolean from t where name = 'drawing'), false, 'a drawing is not');

-- RLS on project_documents ----------------------------------------------------------------------
select is(
  (select array_agg(kind order by kind) from public.project_documents where project_id = '00000000-0000-4000-8000-000000000001'),
  array['drawing', 'invoice', 'photo', 'quote'], 'the cost manager sees every document');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is(
  (select array_agg(kind order by kind) from public.project_documents where project_id = '00000000-0000-4000-8000-000000000001'),
  array['drawing', 'photo'], 'the project manager does not see quotes and invoices, not even one they uploaded');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
select is((select count(*) from public.project_documents), 0::bigint, 'a non-member sees no documents');

-- RLS on storage.objects ------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is(
  (select array_agg(split_part(name, '/', 3) order by name) from storage.objects where bucket_id = 'documents'),
  array['site-photo.jpg', 'frame-drawing.pdf', 'half-finished.txt'],
  'the project manager reads registered non-cost files and their own unregistered upload');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select is(
  (select count(*) from storage.objects where bucket_id = 'documents'), 6::bigint,
  'the cost manager reads every file of the project, unregistered ones included');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';
select is((select count(*) from storage.objects where bucket_id = 'documents'), 0::bigint, 'a non-member reads no files');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select lives_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('documents', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d007/pour-record.pdf',
            '00000000-0000-4000-8000-000000000011')$$,
  'a member uploads into a fresh path of the project folder');
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('documents', '00000000-0000-4000-8000-0000000000f1/00000000-0000-4000-8000-00000000d008/elsewhere.pdf',
            '00000000-0000-4000-8000-000000000011')$$,
  '42501', null, 'but not into another project''s folder');
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner_id)
    values ('documents', '00000000-0000-4000-8000-000000000001/loose-file.pdf', '00000000-0000-4000-8000-000000000011')$$,
  '42501', null, 'and only at {project}/{uuid}/{file name}');
update storage.objects set metadata = '{}'
 where name = '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d005/half-finished.txt';
reset role;
select is(
  (select metadata ->> 'size' from storage.objects
    where name = '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d005/half-finished.txt'),
  '10', 'stored files are never updated (there is no update policy)');
set local role authenticated;

-- Storage deletes are allowed only for unregistered files (the Storage API sets this flag itself).
set local storage.allow_delete_query = 'true';
delete from storage.objects where name = '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d001/site-photo.jpg';
delete from storage.objects where name = '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d006/cm-scratch.txt';
delete from storage.objects where name = '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d005/half-finished.txt';
reset role;
select is(
  (select array_agg(split_part(name, '/', 3) order by name) from storage.objects
    where bucket_id = 'documents' and split_part(name, '/', 3) in ('site-photo.jpg', 'cm-scratch.txt', 'half-finished.txt')),
  array['site-photo.jpg', 'cm-scratch.txt'],
  'a member removes their own unregistered upload, but neither a registered file nor someone else''s upload');
set local role authenticated;

-- delete_document --------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select throws_ok(
  $$select public.delete_document((select (doc ->> 'id')::uuid from t where name = 'invoice'))$$,
  'P0002', null, 'the project manager cannot delete a cost document they cannot see');
select throws_ok(
  $$select public.delete_document((select (doc ->> 'id')::uuid from t where name = 'drawing'))$$,
  '42501', null, 'nor a document someone else uploaded');
select is(
  (public.delete_document((select (doc ->> 'id')::uuid from t where name = 'pm_quote'))).storage_path,
  '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d003/quote-from-site.pdf',
  'the uploader deletes their own document and gets its storage path back');
select ok(
  public.can_remove_document_object(
    '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000d003/quote-from-site.pdf', '00000000-0000-4000-8000-000000000011'),
  'after which the file may be removed by its uploader');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select lives_ok(
  $$select public.delete_document((select (doc ->> 'id')::uuid from t where name = 'photo'))$$,
  'the cost manager deletes any document');
select throws_ok(
  $$select public.delete_document('00000000-0000-4000-8000-00000000dfff')$$,
  'P0002', null, 'an unknown document is not found');

-- Payment receipts -------------------------------------------------------------------------------
reset role;
insert into public.proposals (id, project_id, booking_id, state, current_version_no)
values ('00000000-0000-4000-8000-0000000002dd', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', 'published', 2);
insert into public.proposal_versions (id, project_id, proposal_id, version_no, source_revision, inputs, evaluation)
values ('00000000-0000-4000-8000-0000000003dd', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000002dd', 2, 0,
        '{"new_start":"2026-12-11","new_end":"2026-12-18"}',
        '{"cost_comparison":{"currency":"USD","booked_rental_minor":600000,"supplier_payment_minor":360000,"saving_minor":240000},
          "booking_days":{"published_billable_days":10,"revised_billable_days":6,"avoided_billable_days":4,"revised_idle_days":0}}');
insert into public.approvals (id, project_id, proposal_version_id, approver_id, scope, content_hash, amount_minor, currency, recipient, source_revision)
values
  ('00000000-0000-4000-8000-0000000004d1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000003dd',
   '00000000-0000-4000-8000-000000000011', 'schedule', 'h1', null, null, null, 0),
  ('00000000-0000-4000-8000-0000000004d2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000003dd',
   '00000000-0000-4000-8000-000000000012', 'payment', 'h2', 360000, 'USD', 'supplier@test.local', 0);
insert into public.payment_authorizations
  (id, project_id, approval_id, proposal_version_id, amount_minor, currency, recipient_email, status, paypal_batch_id, paypal_item_id,
   fee_minor, authorized_by)
values
  ('00000000-0000-4000-8000-0000000005d1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000004d2',
   '00000000-0000-4000-8000-0000000003dd', 360000, 'USD', 'supplier@test.local', 'succeeded', 'BATCH-1', 'ITEM-1', 25,
   '00000000-0000-4000-8000-000000000012');
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('documents', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000e001/payment-receipt.pdf', null, '{"size": 5120}'),
  ('documents', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000e002/payment-receipt.pdf', null, '{"size": 5121}');
-- A rename after the snapshot: the receipt names the task as the plan has it now.
insert into public.project_revisions (project_id, revision_no, client_id, local_revision_id, changes)
values ('00000000-0000-4000-8000-000000000001',
        (select coalesce(max(revision_no), 0) + 1 from public.project_revisions where project_id = '00000000-0000-4000-8000-000000000001'),
        gen_random_uuid(), 'rename',
        '{"tasks":{"updated":[{"id":15,"name":"Erect the steel frame"}]}}');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok($$select public.receipt_facts('00000000-0000-4000-8000-0000000005d1')$$, '42501', null,
  'browsers cannot read receipt facts');
select throws_ok(
  $$select public.file_receipt('00000000-0000-4000-8000-0000000005d1',
      '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000e001/payment-receipt.pdf', 'r.pdf', 1, 'x', 'x')$$,
  '42501', null, 'browsers cannot file receipts');
reset role;

set local role service_role;
insert into t select 'facts', public.receipt_facts('00000000-0000-4000-8000-0000000005d1');
select is(
  (select jsonb_build_object(
     'receipt', doc -> 'existing_receipt_id', 'project', doc -> 'project' ->> 'name', 'task', doc -> 'task',
     'supplier', doc ->> 'supplier_name', 'version', doc -> 'proposal' -> 'version_no',
     'dates_by', doc -> 'schedule_approval' ->> 'approver_name', 'payment_by', doc -> 'payment_approval' ->> 'approver_name',
     'sent_by', doc ->> 'authorized_by_name', 'fee', doc -> 'authorization' -> 'fee_minor')
     from t where name = 'facts'),
  '{"receipt": null, "project": "Riverside Clinic", "task": {"id": 15, "name": "Erect the steel frame"},
    "supplier": "Northgate Equipment Rental", "version": 2, "dates_by": "Chris Hale", "payment_by": "Deepak Jayaram",
    "sent_by": "Deepak Jayaram", "fee": 25}'::jsonb,
  'receipt_facts gathers the project, task (as renamed), supplier, version, approvers and the PayPal fee');
select is(
  (select doc -> 'proposal' -> 'cost_comparison' from t where name = 'facts'),
  '{"currency": "USD", "booked_rental_minor": 600000, "supplier_payment_minor": 360000, "saving_minor": 240000}'::jsonb,
  'and the cost comparison the payment followed: the rental as revised');

insert into t select 'receipt', public.file_receipt('00000000-0000-4000-8000-0000000005d1',
  '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000e001/payment-receipt.pdf',
  'Payment receipt - Northgate Equipment Rental.pdf', 1, 'PAYMENT RECEIPT ...', 'PayPal payment of $3,600.00 to Northgate Equipment Rental');
select is(
  (select jsonb_build_object('created', doc -> 'created', 'kind', doc -> 'document' ->> 'kind', 'task', doc -> 'document' -> 'task_id',
     'cost', doc -> 'document' -> 'cost_sensitive', 'via', doc -> 'document' ->> 'created_via', 'by', doc -> 'document' -> 'created_by',
     'payment', doc -> 'document' ->> 'payment_authorization_id', 'size', doc -> 'document' -> 'size_bytes',
     'mime', doc -> 'document' ->> 'mime_type')
     from t where name = 'receipt'),
  '{"created": true, "kind": "receipt", "task": 15, "cost": true, "via": "system", "by": null,
    "payment": "00000000-0000-4000-8000-0000000005d1", "size": 5120, "mime": "application/pdf"}'::jsonb,
  'the receipt is filed as a system cost document of the booked task, linked to the payment');
insert into t select 'receipt2', public.file_receipt('00000000-0000-4000-8000-0000000005d1',
  '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000e002/payment-receipt.pdf', 'again.pdf', 1, 'x', 'x');
select is(
  (select row(doc ->> 'created', doc -> 'document' ->> 'id') from t where name = 'receipt2'),
  row('false'::text, (select doc -> 'document' ->> 'id' from t where name = 'receipt')),
  'filing again returns the receipt already filed (the second upload is the caller''s to remove)');
select is(
  public.receipt_facts('00000000-0000-4000-8000-0000000005d1') ->> 'existing_receipt_id',
  (select doc -> 'document' ->> 'id' from t where name = 'receipt'), 'and receipt_facts reports it');
reset role;
select throws_ok(
  $$insert into public.project_documents (project_id, task_id, kind, name, mime_type, size_bytes, storage_path, cost_sensitive,
      payment_authorization_id, created_via)
    values ('00000000-0000-4000-8000-000000000001', 15, 'receipt', 'dup.pdf', 'application/pdf', 1,
            '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000e002/payment-receipt.pdf', true,
            '00000000-0000-4000-8000-0000000005d1', 'system')$$,
  '23505', null, 'one receipt per payment, even for the service role');
select throws_ok(
  $$insert into public.project_documents (project_id, kind, name, mime_type, size_bytes, storage_path, cost_sensitive, created_via)
    values ('00000000-0000-4000-8000-000000000001', 'photo', 'p.jpg', 'image/jpeg', 1, 'p', true, 'system')$$,
  '23514', null, 'cost_sensitive always follows the kind');

insert into public.approvals
  (id, project_id, proposal_version_id, approver_id, scope, content_hash, amount_minor, currency, recipient, source_revision,
   status, invalidated_reason)
values ('00000000-0000-4000-8000-0000000004d3', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000003dd',
        '00000000-0000-4000-8000-000000000012', 'payment', 'h3', 360000, 'USD', 'supplier@test.local', 0, 'invalidated', 'test');
insert into public.payment_authorizations (id, project_id, approval_id, proposal_version_id, amount_minor, currency, recipient_email, status)
values ('00000000-0000-4000-8000-0000000005d2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000004d3',
        '00000000-0000-4000-8000-0000000003dd', 360000, 'USD', 'supplier@test.local', 'pending');
set local role service_role;
select throws_ok(
  $$select public.file_receipt('00000000-0000-4000-8000-0000000005d2',
      '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000e002/payment-receipt.pdf', 'r.pdf', 1, 'x', 'x')$$,
  '55000', null, 'a payment that has not succeeded gets no receipt');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is((select count(*) from public.project_documents where kind = 'receipt'), 0::bigint, 'the project manager does not see the receipt');
select is(
  (select count(*) from storage.objects
    where name = '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000e001/payment-receipt.pdf'),
  0::bigint, 'nor its file');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select is((select count(*) from public.project_documents where kind = 'receipt'), 1::bigint, 'the cost manager does');
select throws_ok(
  $$select public.delete_document((select (doc -> 'document' ->> 'id')::uuid from t where name = 'receipt'))$$,
  '42501', null, 'a receipt cannot be deleted');
select ok(
  not public.can_remove_document_object(
    '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-00000000e001/payment-receipt.pdf', null),
  'and its file cannot be removed');
reset role;

-- Realtime --------------------------------------------------------------------------------------------
select ok(
  (select count(*) from realtime.messages
    where topic = 'project:00000000-0000-4000-8000-000000000001:workflow' and payload ->> 'table' = 'project_documents') >= 6,
  'document inserts and deletes broadcast on the workflow topic');
select is(
  (select array_agg(distinct k order by k)
     from realtime.messages m, jsonb_object_keys(m.payload) k
    where m.topic = 'project:00000000-0000-4000-8000-000000000001:workflow' and m.payload ->> 'table' = 'project_documents'),
  array['id', 'op', 'proposal_id', 'table'], 'with ids only: no file names or text');

-- reset_demo ------------------------------------------------------------------------------------------
-- A seed document (what scripts/seed-documents.ts files) survives the reset; everything else goes.
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('documents', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000201/northgate-quote.pdf', null, '{"size": 9000}');
insert into public.project_documents (id, project_id, task_id, kind, name, mime_type, size_bytes, storage_path, cost_sensitive, created_via)
values ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000001', 15, 'quote', 'northgate-quote.pdf',
        'application/pdf', 9000, '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000201/northgate-quote.pdf',
        true, 'system');
set local role service_role;
-- The payment above is still pending at PayPal: the forced reset abandons it.
insert into t select 'reset', public.reset_demo_abandoning_payments('00000000-0000-4000-8000-000000000001');
reset role;
select is(
  (select array_agg(id::text) from public.project_documents where project_id = '00000000-0000-4000-8000-000000000001'),
  array['00000000-0000-4000-8000-000000000201'], 'reset_demo keeps the seed document and removes every other one');
select is(
  (select doc -> 'document_objects' from t where name = 'reset'),
  (select jsonb_agg(name order by name) from storage.objects
    where bucket_id = 'documents' and name like '00000000-0000-4000-8000-000000000001/%'
      and name <> '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000201/northgate-quote.pdf'),
  'and lists every other file of the project folder for the reset script to remove');
select ok(
  (select jsonb_array_length(doc -> 'document_objects') from t where name = 'reset') >= 6,
  'registered, deleted and never-registered files alike');

select * from finish();
rollback;
