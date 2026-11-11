-- Project documents: a file repository per project (supplier quotes and invoices, payment receipts,
-- site photos, drawings, reports), each file optionally linked to a Bryntum task. The files live in
-- the private Storage bucket `documents` under `{project_id}/{uuid}/{file name}`; a
-- project_documents row describes each one, with its plain text for the AI agent to read.
--
-- Who sees what: every member sees the project's documents, except that quotes, invoices and
-- receipts (cost_sensitive) are shown only to members who can view costs. The same rule guards the
-- files themselves through RLS on storage.objects.
--
-- Writes: members upload a file into their project's folder, then register it with
-- register_document; delete_document removes a registration (its uploader or the cost manager), after
-- which the file can be removed through the Storage API. Payment receipts are filed by the PayPal
-- Edge Functions alone (service role: receipt_facts, file_receipt) when a payout succeeds, and can
-- never be deleted by a member. Nothing else writes the table.

-- -------------------------------------------------------------------------------------------
-- Table
-- -------------------------------------------------------------------------------------------
create table public.project_documents (
  id                       uuid primary key default gen_random_uuid(),
  project_id               uuid not null references public.projects (id) on delete cascade,
  -- Bryntum task id. Tasks live in the snapshot and the revision log, so there is no foreign key;
  -- register_document checks the task is in the plan when the document is registered.
  task_id                  bigint check (task_id > 0),
  -- Mirrors DocumentKind in packages/shared/src/documents.ts (packages/shared/test keeps them equal).
  kind                     text not null check (kind in ('quote', 'invoice', 'receipt', 'photo', 'drawing', 'report', 'other')),
  -- The original file name as the uploader had it; the storage path carries a sanitized copy.
  name                     text not null check (length(name) between 1 and 200),
  mime_type                text not null check (length(mime_type) between 3 and 255),
  size_bytes               bigint not null check (size_bytes >= 0),
  storage_path             text not null unique,
  cost_sensitive           boolean not null default false,
  -- Plain text for the AI agent: generated documents and text-like uploads (at most 200 KiB).
  text_content             text check (text_content is null or length(text_content) <= 204800),
  summary                  text check (summary is null or length(summary) <= 300),
  payment_authorization_id uuid references public.payment_authorizations (id),
  created_by               uuid references auth.users (id) on delete set null,
  -- Mirrors DocumentCreatedVia in packages/shared/src/documents.ts.
  created_via              text not null default 'upload' check (created_via in ('upload', 'system', 'agent')),
  created_at               timestamptz not null default now(),
  constraint project_documents_cost_sensitive_by_kind check (cost_sensitive = (kind in ('quote', 'invoice', 'receipt'))),
  constraint project_documents_receipt_has_payment check (kind <> 'receipt' or payment_authorization_id is not null)
);
create index project_documents_project_id_created_at_idx on public.project_documents (project_id, created_at desc);
create index project_documents_project_id_task_id_idx on public.project_documents (project_id, task_id);
-- One receipt per payment operation; the receipt filer relies on it to stay idempotent.
create unique index project_documents_one_receipt_per_payment
  on public.project_documents (payment_authorization_id) where kind = 'receipt';

-- -------------------------------------------------------------------------------------------
-- Visibility helpers (security definer so policies can consult project_members and
-- project_documents without recursing into their policies). All answer about the calling user.
-- -------------------------------------------------------------------------------------------
create or replace function public.member_can_view_costs(p uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select m.can_view_costs from public.project_members m where m.project_id = p and m.user_id = (select auth.uid())),
    false);
$$;

-- The project of a `{project_id}/{uuid}/{file name}` object name, or null for any other name.
create or replace function public.document_object_project(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]{1,200}$'
    then split_part(p_name, '/', 1)::uuid
  end;
$$;

-- Reading a file: a registered document follows its row's visibility (members; cost documents only
-- for members who can view costs). A file nobody registered (an upload in progress, a registration
-- that failed, or a document already deleted) is visible to its uploader and the cost manager only.
create or replace function public.can_read_document_object(p_name text, p_owner text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_project uuid := public.document_object_project(p_name);
  v_member  public.project_members;
  v_doc     public.project_documents;
begin
  if v_project is null then
    return false;
  end if;
  select m.* into v_member from public.project_members m where m.project_id = v_project and m.user_id = (select auth.uid());
  if not found then
    return false;
  end if;
  select d.* into v_doc from public.project_documents d where d.storage_path = p_name;
  if found then
    return v_doc.project_id = v_project and (not v_doc.cost_sensitive or v_member.can_view_costs);
  end if;
  return p_owner = (select auth.uid())::text or v_member.role = 'cm';
end;
$$;

-- Uploading: any member, into a fresh path of their project's folder.
create or replace function public.can_upload_document_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.document_object_project(p_name) is not null
     and public.is_project_member(public.document_object_project(p_name))
     and not exists (select 1 from public.project_documents d where d.storage_path = p_name);
$$;

-- Removing a file: only once no document references it (delete_document first), by its uploader or
-- the cost manager. Registered files, receipts included, cannot be removed by a member at all.
create or replace function public.can_remove_document_object(p_name text, p_owner text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.document_object_project(p_name) is not null
     and not exists (select 1 from public.project_documents d where d.storage_path = p_name)
     and exists (
       select 1 from public.project_members m
        where m.project_id = public.document_object_project(p_name)
          and m.user_id = (select auth.uid())
          and (p_owner = (select auth.uid())::text or m.role = 'cm'));
$$;

-- The name a task has in the plan as of its latest revision: the latest revision after the snapshot
-- that adds the task or sets its name, otherwise the snapshot's task tree. Null when unknown.
create or replace function public.task_name_in_plan(p_project uuid, p_task bigint)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_project public.projects;
  v_name    text;
begin
  select p.* into v_project from public.projects p where p.id = p_project;
  if not found or p_task is null then
    return null;
  end if;

  select e.value ->> 'name' into v_name
    from public.project_revisions r
    cross join lateral jsonb_array_elements(
           (case when jsonb_typeof(r.changes -> 'tasks' -> 'updated') = 'array' then r.changes -> 'tasks' -> 'updated' else '[]'::jsonb end)
        || (case when jsonb_typeof(r.changes -> 'tasks' -> 'added') = 'array' then r.changes -> 'tasks' -> 'added' else '[]'::jsonb end)) e
   where r.project_id = p_project
     and r.revision_no > v_project.snapshot_revision
     and e.value ->> 'id' = p_task::text
     and jsonb_typeof(e.value -> 'name') = 'string'
   order by r.revision_no desc
   limit 1;
  if v_name is not null then
    return v_name;
  end if;

  with recursive node(task) as (
    select t.value
      from jsonb_array_elements(
             case when jsonb_typeof(coalesce(v_project.snapshot -> 'tasksData', v_project.snapshot -> 'tasks')) = 'array'
                  then coalesce(v_project.snapshot -> 'tasksData', v_project.snapshot -> 'tasks') else '[]'::jsonb end) t
    union all
    select c.value
      from node
      cross join lateral jsonb_array_elements(
             case when jsonb_typeof(node.task -> 'children') = 'array' then node.task -> 'children' else '[]'::jsonb end) c
  )
  select node.task ->> 'name' into v_name from node where node.task ->> 'id' = p_task::text limit 1;
  return v_name;
end;
$$;

revoke execute on function public.task_name_in_plan(uuid, bigint) from public, anon, authenticated;

-- -------------------------------------------------------------------------------------------
-- Privileges and RLS on the table: members read (cost documents need cost access); every write
-- goes through the functions below or the service role.
-- -------------------------------------------------------------------------------------------
alter table public.project_documents enable row level security;
revoke all on table public.project_documents from anon;
revoke insert, update, delete on table public.project_documents from authenticated;

create policy "project_documents: members read, cost documents need cost access"
  on public.project_documents for select to authenticated
  using (public.is_project_member(project_id) and (not cost_sensitive or public.member_can_view_costs(project_id)));

-- -------------------------------------------------------------------------------------------
-- Storage: the private `documents` bucket (20 MiB per file) and its object policies. There is no
-- update policy, so a stored file never changes; members delete only unregistered files.
-- -------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 20971520)
on conflict (id) do nothing;

create policy "documents: members read the files they may see"
  on storage.objects for select to authenticated
  using (bucket_id = 'documents' and public.can_read_document_object(name, owner_id));

create policy "documents: members upload into their project folder"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and public.can_upload_document_object(name));

create policy "documents: unregistered files are removed by their uploader or the cost manager"
  on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and public.can_remove_document_object(name, owner_id));

-- -------------------------------------------------------------------------------------------
-- register_document: records a file the caller has just uploaded to
-- `{p_project}/{uuid}/{file name}`. The kind decides cost_sensitive (quote, invoice); receipts are
-- refused (the payment service files them). The stored object's size wins over p_size. A repeated
-- call for the same path by the same uploader returns the existing row.
-- -------------------------------------------------------------------------------------------
create or replace function public.register_document(
  p_project      uuid,
  p_task         bigint,
  p_kind         text,
  p_name         text,
  p_mime         text,
  p_size         bigint,
  p_storage_path text,
  p_text_content text default null
)
returns public.project_documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := public.workflow_actor('register_document');
  v_member public.project_members := public.workflow_member(p_project, 'register_document');
  v_name   text := btrim(coalesce(p_name, ''));
  v_mime   text := lower(btrim(coalesce(p_mime, '')));
  v_owner  text;
  v_size   text;
  v_row    public.project_documents;
begin
  if p_kind = 'receipt' then
    raise exception 'register_document: payment receipts are filed by the payment service when PayPal confirms a payout'
      using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('quote', 'invoice', 'photo', 'drawing', 'report', 'other') then
    raise exception 'register_document: p_kind must be one of quote, invoice, photo, drawing, report, other' using errcode = '22023';
  end if;
  if length(v_name) = 0 or length(v_name) > 200 or v_name ~ '[[:cntrl:]/\\]' then
    raise exception 'register_document: the file name must be 1-200 characters, without slashes or control characters'
      using errcode = '22023';
  end if;
  if v_mime !~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$' then
    raise exception 'register_document: "%" is not a media type such as application/pdf', p_mime using errcode = '22023';
  end if;
  if p_size is null or p_size < 0 then
    raise exception 'register_document: p_size must be the file size in bytes' using errcode = '22023';
  end if;
  if p_text_content is not null and length(p_text_content) > 204800 then
    raise exception 'register_document: the text content is limited to 204800 characters' using errcode = '22023';
  end if;
  if p_task is not null and (p_task <= 0 or not public.task_in_plan(p_project, p_task)) then
    raise exception 'register_document: task % is not in the project', p_task using errcode = '22023';
  end if;
  if public.document_object_project(p_storage_path) is distinct from p_project then
    raise exception 'register_document: the file must be stored at {project}/{uuid}/{file name} in the folder of project %', p_project
      using errcode = '22023';
  end if;

  select d.* into v_row from public.project_documents d where d.storage_path = p_storage_path;
  if found then
    if v_row.project_id = p_project and v_row.created_by = v_uid then
      return v_row;
    end if;
    raise exception 'register_document: the file at % is already registered', p_storage_path using errcode = '42501';
  end if;

  select o.owner_id, o.metadata ->> 'size' into v_owner, v_size
    from storage.objects o
   where o.bucket_id = 'documents' and o.name = p_storage_path
   order by o.created_at desc
   limit 1;
  if not found then
    raise exception 'register_document: no uploaded file at % (upload it to the documents bucket first)', p_storage_path
      using errcode = 'P0002';
  end if;
  if v_owner is distinct from v_uid::text then
    raise exception 'register_document: the file at % was uploaded by someone else', p_storage_path using errcode = '42501';
  end if;

  insert into public.project_documents
    (project_id, task_id, kind, name, mime_type, size_bytes, storage_path, cost_sensitive, text_content, created_by, created_via)
  values
    (p_project, p_task, p_kind, v_name, v_mime,
     case when v_size ~ '^\d{1,18}$' then v_size::bigint else p_size end,
     p_storage_path, p_kind in ('quote', 'invoice'), p_text_content, v_uid, 'upload')
  returning * into v_row;
  return v_row;
end;
$$;

-- -------------------------------------------------------------------------------------------
-- delete_document: removes a registration (its uploader or the cost manager; never a receipt) and
-- returns the deleted row, whose storage_path the caller then removes through the Storage API.
-- -------------------------------------------------------------------------------------------
create or replace function public.delete_document(p_id uuid)
returns public.project_documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := public.workflow_actor('delete_document');
  v_member  public.project_members;
  v_row     public.project_documents;
  v_visible boolean;
begin
  select d.* into v_row
    from public.project_documents d
   where d.id = p_id and public.is_project_member(d.project_id)
     for update;
  v_visible := found;
  if v_visible then
    v_member := public.workflow_member(v_row.project_id, 'delete_document');
    -- A cost document the caller cannot see does not exist for them, unless they uploaded it.
    v_visible := not v_row.cost_sensitive or v_member.can_view_costs or v_row.created_by is not distinct from v_uid;
  end if;
  if not v_visible then
    raise exception 'delete_document: document % not found', p_id using errcode = 'P0002';
  end if;
  if v_row.kind = 'receipt' then
    raise exception 'delete_document: a payment receipt is part of the payment record and cannot be deleted' using errcode = '42501';
  end if;
  if v_row.created_by is distinct from v_uid and v_member.role <> 'cm' then
    raise exception 'delete_document: only the person who uploaded the document or the cost manager can delete it'
      using errcode = '42501';
  end if;
  delete from public.project_documents where id = p_id;
  return v_row;
end;
$$;

-- -------------------------------------------------------------------------------------------
-- Payment receipts (service role, for the PayPal Edge Functions).
--
-- receipt_facts(p_authorization): everything a receipt states, read in one call, plus the id of the
-- receipt already filed for the operation (null when there is none yet).
-- -------------------------------------------------------------------------------------------
create or replace function public.receipt_facts(p_authorization uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pa       public.payment_authorizations;
  v_version  public.proposal_versions;
  v_proposal public.proposals;
  v_booking  public.equipment_bookings;
  v_project  public.projects;
  v_schedule public.approvals;
  v_payment  public.approvals;
  v_receipt  uuid;
begin
  select pa.* into v_pa from public.payment_authorizations pa where pa.id = p_authorization;
  if not found then
    raise exception 'receipt_facts: payment authorization % not found', p_authorization using errcode = 'P0002';
  end if;
  select d.id into v_receipt
    from public.project_documents d
   where d.payment_authorization_id = p_authorization and d.kind = 'receipt';
  select v.* into v_version from public.proposal_versions v where v.id = v_pa.proposal_version_id;
  select p.* into v_proposal from public.proposals p where p.id = v_version.proposal_id;
  select b.* into v_booking from public.equipment_bookings b where b.id = v_proposal.booking_id;
  select p.* into v_project from public.projects p where p.id = v_pa.project_id;
  select a.* into v_payment from public.approvals a where a.id = v_pa.approval_id;
  -- The dates approval this payment followed: the active one, else the latest of the version.
  select a.* into v_schedule
    from public.approvals a
   where a.proposal_version_id = v_version.id and a.scope = 'schedule'
   order by (a.status = 'active') desc, a.created_at desc
   limit 1;

  return jsonb_build_object(
    'existing_receipt_id', v_receipt,
    'authorization',       to_jsonb(v_pa),
    'authorized_by_name',  (select pr.display_name from public.profiles pr where pr.user_id = v_pa.authorized_by),
    'project',             jsonb_build_object('id', v_project.id, 'name', v_project.name),
    'task',                jsonb_build_object('id', v_booking.task_id,
                                              'name', public.task_name_in_plan(v_project.id, v_booking.task_id)),
    'supplier_name',       v_booking.supplier_name,
    'proposal',            jsonb_build_object(
                             'id', v_proposal.id,
                             'version_no', v_version.version_no,
                             'inputs', v_version.inputs,
                             'cost_comparison', v_version.evaluation -> 'cost_comparison'),
    'schedule_approval',   case when v_schedule.id is null then null else jsonb_build_object(
                             'approver_name', (select pr.display_name from public.profiles pr where pr.user_id = v_schedule.approver_id),
                             'approved_at', v_schedule.created_at,
                             'status', v_schedule.status) end,
    'payment_approval',    case when v_payment.id is null then null else jsonb_build_object(
                             'approver_name', (select pr.display_name from public.profiles pr where pr.user_id = v_payment.approver_id),
                             'approved_at', v_payment.created_at,
                             'status', v_payment.status) end);
end;
$$;

-- file_receipt: files the generated receipt (already uploaded to p_storage_path) for a succeeded
-- payment. Locks the payment row, so concurrent filers (a webhook and a status refresh) serialize:
-- the first files the receipt, the others get it back with created = false and remove their upload.
-- Returns { created, document }.
create or replace function public.file_receipt(
  p_authorization uuid,
  p_storage_path  text,
  p_name          text,
  p_size          bigint,
  p_text_content  text,
  p_summary       text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pa   public.payment_authorizations;
  v_task bigint;
  v_size text;
  v_row  public.project_documents;
begin
  select pa.* into v_pa from public.payment_authorizations pa where pa.id = p_authorization for update;
  if not found then
    raise exception 'file_receipt: payment authorization % not found', p_authorization using errcode = 'P0002';
  end if;
  select d.* into v_row
    from public.project_documents d
   where d.payment_authorization_id = p_authorization and d.kind = 'receipt';
  if found then
    return jsonb_build_object('created', false, 'document', to_jsonb(v_row));
  end if;
  if v_pa.status <> 'succeeded' then
    raise exception 'file_receipt: payment % is %, not succeeded; there is nothing to give a receipt for', p_authorization, v_pa.status
      using errcode = '55000';
  end if;
  if public.document_object_project(p_storage_path) is distinct from v_pa.project_id then
    raise exception 'file_receipt: the receipt must be stored in the folder of project %', v_pa.project_id using errcode = '22023';
  end if;
  select o.metadata ->> 'size' into v_size
    from storage.objects o
   where o.bucket_id = 'documents' and o.name = p_storage_path
   order by o.created_at desc
   limit 1;
  if not found then
    raise exception 'file_receipt: no uploaded file at %', p_storage_path using errcode = 'P0002';
  end if;

  select b.task_id into v_task
    from public.proposal_versions v
    join public.proposals p on p.id = v.proposal_id
    join public.equipment_bookings b on b.id = p.booking_id
   where v.id = v_pa.proposal_version_id;

  insert into public.project_documents
    (project_id, task_id, kind, name, mime_type, size_bytes, storage_path, cost_sensitive, text_content, summary,
     payment_authorization_id, created_by, created_via)
  values
    (v_pa.project_id, v_task, 'receipt', left(btrim(p_name), 200), 'application/pdf',
     case when v_size ~ '^\d{1,18}$' then v_size::bigint else greatest(coalesce(p_size, 0), 0) end,
     p_storage_path, true, left(p_text_content, 204800), left(p_summary, 300), p_authorization, null, 'system')
  returning * into v_row;
  return jsonb_build_object('created', true, 'document', to_jsonb(v_row));
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'register_document(uuid,bigint,text,text,text,bigint,text,text)', 'delete_document(uuid)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'receipt_facts(uuid)', 'file_receipt(uuid,text,text,bigint,text,text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

-- -------------------------------------------------------------------------------------------
-- Realtime: document changes reach project:<id>:workflow like the other workflow rows
-- ({ table, id, op, proposal_id: null }; no names or figures), and clients re-read through RLS.
-- -------------------------------------------------------------------------------------------
create trigger project_documents_workflow_broadcast
  after insert or update or delete on public.project_documents
  for each row execute function public.broadcast_workflow_change();

-- -------------------------------------------------------------------------------------------
-- reset_demo, as in 20261022010100_payouts_and_demo_reset.sql, now also removing the documents
-- that are not part of the seed (the seed's are system documents other than payment receipts,
-- filed by scripts/seed-documents.ts). SQL cannot delete a stored file (Storage keeps the bytes
-- outside the database), so the result lists, under document_objects, every object in the
-- project's folder that no remaining document references; scripts/demo-reset.ts removes them
-- through the Storage API.
-- -------------------------------------------------------------------------------------------
create or replace function public.reset_demo(p_project uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seed    public.demo_seeds;
  v_objects jsonb;
begin
  select d.* into v_seed from public.demo_seeds d where d.project_id = p_project;
  if not found then
    raise exception 'reset_demo: no seed stored for project % (run `pnpm db:reset` once)', p_project using errcode = 'P0002';
  end if;

  delete from public.project_documents d
   where d.project_id = p_project and not (d.created_via = 'system' and d.kind <> 'receipt');
  delete from public.payment_events where project_id = p_project;
  delete from public.payment_authorizations where project_id = p_project;
  delete from public.publications where project_id = p_project;
  delete from public.decision_notes where project_id = p_project;
  delete from public.agent_commands where project_id = p_project;
  delete from public.transcript_segments where project_id = p_project;
  delete from public.proposals where project_id = p_project;
  delete from public.project_revisions where project_id = p_project;
  delete from public.record_ids where project_id = p_project;
  delete from public.sessions where project_id = p_project;

  update public.projects
     set snapshot = v_seed.snapshot, snapshot_revision = 0, current_revision = 0
   where id = p_project;

  update public.equipment_bookings b
     set task_id         = (v_seed.booking ->> 'task_id')::bigint,
         resource_id     = (v_seed.booking ->> 'resource_id')::bigint,
         supplier_name   = v_seed.booking ->> 'supplier_name',
         rental_rate_minor = (v_seed.booking ->> 'rental_rate_minor')::bigint,
         currency        = v_seed.booking ->> 'currency',
         billable_start  = (v_seed.booking ->> 'billable_start')::date,
         billable_end    = (v_seed.booking ->> 'billable_end')::date,
         idle_days       = (v_seed.booking ->> 'idle_days')::int,
         evidence_path   = v_seed.booking ->> 'evidence_path'
   where b.id = (v_seed.booking ->> 'id')::uuid;

  select coalesce(jsonb_agg(o.name order by o.name), '[]'::jsonb) into v_objects
    from storage.objects o
   where o.bucket_id = 'documents'
     and o.name like p_project::text || '/%'
     and not exists (select 1 from public.project_documents d where d.storage_path = o.name);

  return jsonb_build_object('project_id', p_project, 'reset_at', now(), 'document_objects', v_objects);
end;
$$;

revoke execute on function public.reset_demo(uuid) from public, anon, authenticated;
grant execute on function public.reset_demo(uuid) to service_role;
