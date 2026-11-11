-- Commercial records: bookings, proposals, reviews, approvals, payments,
-- publications, transcripts, decision notes, agent commands and supplier confirmations.
-- DDL and RLS only: members read; writes arrive through later RPCs or the service role.

create table public.equipment_bookings (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.projects (id) on delete cascade,
  task_id               bigint not null,
  resource_id           bigint not null,
  supplier_name         text not null,
  supplier_payout_email text not null,
  rental_rate_minor       bigint not null check (rental_rate_minor >= 0),
  currency              text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  billable_start        date not null,
  billable_end          date not null,
  idle_days             int not null default 0 check (idle_days >= 0),
  evidence_path         text,
  constraint equipment_bookings_billable_interval check (billable_end >= billable_start)
);
create index equipment_bookings_project_id_idx on public.equipment_bookings (project_id);

create table public.proposals (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects (id) on delete cascade,
  booking_id         uuid not null references public.equipment_bookings (id) on delete cascade,
  state              text not null default 'draft'
                     check (state in ('draft', 'evaluated', 'in_review', 'approved', 'published', 'cancelled')),
  current_version_no int not null default 0 check (current_version_no >= 0),
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index proposals_project_id_idx on public.proposals (project_id);

create table public.proposal_versions (
  id                     uuid primary key default gen_random_uuid(),
  project_id             uuid not null references public.projects (id) on delete cascade,
  proposal_id            uuid not null references public.proposals (id) on delete cascade,
  version_no             int not null check (version_no > 0),
  source_revision        int not null check (source_revision >= 0),
  -- ProposalInputs object (charge_basis, rebooking_minor, transport_minor, new_start, new_end),
  -- ProposalAssumption array and Evaluation object: the zod schemas in packages/shared/src/schemas.ts.
  -- No default for inputs: a version without real inputs is not a version.
  inputs                 jsonb not null check (jsonb_typeof(inputs) = 'object'),
  assumptions            jsonb not null default '[]'::jsonb check (jsonb_typeof(assumptions) = 'array'),
  evaluation             jsonb check (evaluation is null or jsonb_typeof(evaluation) = 'object'),
  stale                  boolean not null default false,
  created_by             uuid references auth.users (id) on delete set null,
  created_via            text not null default 'human' check (created_via in ('human', 'agent')),
  transcript_segment_ids uuid[] not null default '{}',
  created_at             timestamptz not null default now(),
  unique (proposal_id, version_no)
);
create index proposal_versions_project_id_idx on public.proposal_versions (project_id);

create table public.reviews (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects (id) on delete cascade,
  proposal_version_id uuid not null references public.proposal_versions (id) on delete cascade,
  reviewer_id         uuid references auth.users (id) on delete set null,
  kind                text not null check (kind in ('correction', 'comment')),
  payload             jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);
create index reviews_project_id_idx on public.reviews (project_id);

create table public.approvals (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects (id) on delete cascade,
  proposal_version_id uuid not null references public.proposal_versions (id) on delete cascade,
  approver_id         uuid references auth.users (id) on delete set null,
  scope               text not null check (scope in ('schedule', 'payment')),
  content_hash        text not null,
  amount_minor        bigint check (amount_minor >= 0),
  currency            text check (currency ~ '^[A-Z]{3}$'),
  recipient           text,
  source_revision     int not null check (source_revision >= 0),
  status              text not null default 'active' check (status in ('active', 'invalidated')),
  invalidated_reason  text,
  created_at          timestamptz not null default now(),
  invalidated_at      timestamptz,
  constraint approvals_payment_scope_has_money
    check (scope <> 'payment' or (amount_minor is not null and currency is not null and recipient is not null)),
  constraint approvals_invalidated_has_reason
    check (status <> 'invalidated' or invalidated_reason is not null)
);
create unique index approvals_one_active_per_scope
  on public.approvals (proposal_version_id, scope) where status = 'active';
create index approvals_project_id_idx on public.approvals (project_id);

create table public.payment_authorizations (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects (id) on delete cascade,
  approval_id         uuid not null references public.approvals (id),
  proposal_version_id uuid not null references public.proposal_versions (id),
  amount_minor        bigint not null check (amount_minor > 0),
  currency            text not null check (currency ~ '^[A-Z]{3}$'),
  recipient_email     text not null,
  status              text not null default 'authorized'
                      check (status in ('authorized', 'submitted', 'pending', 'succeeded', 'failed', 'unknown')),
  -- PayPal sender_batch_id = PayPal-Request-Id = sender_item_id = this row's id
  paypal_batch_id     text,
  paypal_item_id      text,
  fee_minor           bigint check (fee_minor >= 0),
  raw                 jsonb,
  last_checked_at     timestamptz,
  authorized_by       uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index payment_authorizations_project_id_idx on public.payment_authorizations (project_id);
create index payment_authorizations_status_idx on public.payment_authorizations (status, last_checked_at);

create table public.payment_events (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  authorization_id uuid not null references public.payment_authorizations (id) on delete cascade,
  paypal_event_id  text not null unique,
  event_type       text not null,
  verified         boolean not null default false,
  payload          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index payment_events_authorization_id_idx on public.payment_events (authorization_id);

create table public.publications (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects (id) on delete cascade,
  proposal_version_id uuid not null references public.proposal_versions (id) on delete cascade,
  published_revision  int check (published_revision > 0),
  executor_session    uuid references public.sessions (id) on delete set null,
  status              text not null default 'pending' check (status in ('pending', 'published', 'failed')),
  created_at          timestamptz not null default now(),
  published_at        timestamptz,
  constraint publications_published_has_revision check (status <> 'published' or published_revision is not null)
);
create index publications_project_id_idx on public.publications (project_id);

create table public.transcript_segments (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  session_id    uuid references public.sessions (id) on delete set null,
  user_id       uuid references auth.users (id) on delete set null,
  text          text not null,
  started_at_ms bigint not null check (started_at_ms >= 0),
  ended_at_ms   bigint not null,
  is_final      boolean not null default true,
  created_at    timestamptz not null default now(),
  constraint transcript_segments_interval check (ended_at_ms >= started_at_ms)
);
create index transcript_segments_project_id_started_idx on public.transcript_segments (project_id, started_at_ms);

create table public.decision_notes (
  id                     uuid primary key default gen_random_uuid(),
  project_id             uuid not null references public.projects (id) on delete cascade,
  proposal_id            uuid references public.proposals (id) on delete cascade,
  text                   text not null,
  kind                   text not null default 'note' check (kind in ('note', 'open_question', 'decision')),
  transcript_segment_ids uuid[] not null default '{}',
  created_by             uuid references auth.users (id) on delete set null,
  created_at             timestamptz not null default now()
);
create index decision_notes_project_id_idx on public.decision_notes (project_id);

create table public.agent_commands (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects (id) on delete cascade,
  type              text not null,
  args              jsonb not null default '{}'::jsonb,
  required_revision int check (required_revision >= 0),
  executor_session  uuid references public.sessions (id) on delete set null,
  -- Mirrors CommandStatus in packages/shared/src/schemas.ts (packages/shared/test keeps them equal).
  status            text not null default 'pending'
                    check (status in ('pending', 'running', 'succeeded', 'failed', 'rejected', 'cancelled')),
  result            jsonb,
  requested_by      uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz
);
create index agent_commands_project_id_created_at_idx on public.agent_commands (project_id, created_at);

create table public.supplier_confirmations (
  proposal_id  uuid primary key references public.proposals (id) on delete cascade,
  project_id   uuid not null references public.projects (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'confirmed')),
  confirmed_by uuid references auth.users (id) on delete set null,
  confirmed_at timestamptz,
  note         text,
  updated_at   timestamptz not null default now()
);

-- -------------------------------------------------------------------------------------------
-- Triggers
-- -------------------------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger proposals_touch_updated_at
  before update on public.proposals
  for each row execute function public.touch_updated_at();
create trigger payment_authorizations_touch_updated_at
  before update on public.payment_authorizations
  for each row execute function public.touch_updated_at();
create trigger supplier_confirmations_touch_updated_at
  before update on public.supplier_confirmations
  for each row execute function public.touch_updated_at();

-- A payment authorization is the exact financial operation that was approved; the money
-- fields and the approval it binds to can never change once the row exists.
create or replace function public.payment_authorizations_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.amount_minor        is distinct from old.amount_minor
  or new.currency            is distinct from old.currency
  or new.recipient_email     is distinct from old.recipient_email
  or new.approval_id         is distinct from old.approval_id
  or new.proposal_version_id is distinct from old.proposal_version_id then
    raise exception 'payment_authorizations % is immutable: amount_minor, currency, recipient_email, approval_id and proposal_version_id cannot change', old.id;
  end if;
  return new;
end;
$$;

create trigger payment_authorizations_immutable
  before update on public.payment_authorizations
  for each row execute function public.payment_authorizations_immutable();

-- Commercial change notifications: { table, id, op } with event 'change' on the private topic
-- project:<id>:commercial. Clients re-read the affected row through RLS.
create or replace function public.broadcast_commercial_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    perform realtime.send(
      jsonb_build_object('table', tg_table_name, 'id', v_row ->> 'id', 'op', tg_op),
      'change',
      'project:' || (v_row ->> 'project_id') || ':commercial',
      true);
  end if;
  return null;
end;
$$;

revoke execute on function public.broadcast_commercial_change() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array[
    'proposals', 'approvals', 'payment_authorizations', 'payment_events', 'agent_commands', 'decision_notes'
  ] loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function public.broadcast_commercial_change()',
      t || '_broadcast', t);
  end loop;
end;
$$;

-- -------------------------------------------------------------------------------------------
-- RLS: members read, nobody writes from the client (service role bypasses RLS).
-- -------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'equipment_bookings', 'proposals', 'proposal_versions', 'reviews', 'approvals',
    'payment_authorizations', 'payment_events', 'publications', 'transcript_segments',
    'decision_notes', 'agent_commands', 'supplier_confirmations'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke insert, update, delete on table public.%I from authenticated', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_project_member(project_id))',
      t || ': members can read', t);
  end loop;
end;
$$;
