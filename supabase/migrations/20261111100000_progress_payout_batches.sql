-- The progress payouts the paypal-progress-payout function sent, by the copy of the demo they were sent from, so the
-- function asks PayPal where a batch stands only for a member of that copy: nobody follows another copy's payouts, or
-- any other batch on the business account. The function writes and reads it with the service role; nobody else can.
-- A new visit to a copy (claimed anew or freed), or a reset of its plan, forgets them.
--
-- Safe to apply again.

create table if not exists public.progress_payout_batches (
  project_id      uuid not null references public.projects (id) on delete cascade,
  -- PayPal's id for the batch (payout_batch_id): what the page asks about.
  paypal_batch_id text not null check (char_length(paypal_batch_id) between 1 and 200),
  -- Ours (sender_batch_id), and the payment gate it paid.
  sender_batch_id text not null check (char_length(sender_batch_id) between 1 and 80),
  gate_id         bigint not null check (gate_id > 0),
  sent_by         uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  primary key (project_id, paypal_batch_id)
);

comment on table public.progress_payout_batches is
  'Progress payout batches sent from each project, so their status is read from PayPal only for that project''s members.';

alter table public.progress_payout_batches enable row level security;
revoke all on public.progress_payout_batches from public, anon, authenticated;
grant select, insert on public.progress_payout_batches to service_role;

-- A copy claimed anew or freed starts a new visit (as copy_pool_forgets_payouts does for pay_gate_payouts).
create or replace function public.copy_pool_forgets_progress_payout_batches()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.progress_payout_batches where project_id = new.project_id;
  return null;
end;
$$;
revoke execute on function public.copy_pool_forgets_progress_payout_batches() from public, anon, authenticated;

drop trigger if exists copy_pool_forgets_progress_payout_batches on public.copy_pool;
create trigger copy_pool_forgets_progress_payout_batches
  after update of claimed_at, freed_at on public.copy_pool
  for each row when (old.claimed_at is distinct from new.claimed_at or old.freed_at is distinct from new.freed_at)
  execute function public.copy_pool_forgets_progress_payout_batches();

-- A demo reset (reset_demo) puts the plan back to revision 0: its batches go with it.
create or replace function public.forget_progress_payout_batches_on_reset()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.progress_payout_batches where project_id = new.id;
  return null;
end;
$$;
revoke execute on function public.forget_progress_payout_batches_on_reset() from public, anon, authenticated;

drop trigger if exists projects_reset_forgets_progress_payout_batches on public.projects;
create trigger projects_reset_forgets_progress_payout_batches
  after update of current_revision on public.projects
  for each row when (new.current_revision = 0 and old.current_revision <> 0)
  execute function public.forget_progress_payout_batches_on_reset();
