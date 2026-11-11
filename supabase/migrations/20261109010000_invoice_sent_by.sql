-- Who sent an invoice, and two people confirming the same one at once.
--
--   invoices.sent_by   the person who confirmed it, from their own login (the paypal-invoice function sets it;
--                      people have no write access to invoices); invoices sent before this column read as unknown
--   prepare_invoice    returned the invoice a change already has only when it could see it: the second of two
--                      first confirms at the same moment failed on invoices_one_per_group. It now returns that
--                      one under the race too.

alter table public.invoices add column sent_by uuid references auth.users (id) on delete set null;

create or replace function public.prepare_invoice(
  p_project    uuid,
  p_group_task bigint,
  p_rule       uuid,
  p_title      text,
  p_lines      jsonb
)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := public.workflow_actor('prepare_invoice');
  v_member  public.project_members := public.workflow_member(p_project, 'prepare_invoice');
  v_project public.projects;
  v_total   bigint;
  v_row     public.invoices;
begin
  if not v_member.can_view_costs then
    raise exception 'prepare_invoice: only someone who sees costs may bill the client' using errcode = '42501';
  end if;
  select p.* into v_project from public.projects p where p.id = p_project;
  if v_project.client_email is null or v_project.client_name is null then
    raise exception 'prepare_invoice: this project has no client to bill' using errcode = '22023';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) not between 1 and 40 then
    raise exception 'prepare_invoice: an invoice has 1-40 lines' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) l
     where length(coalesce(l ->> 'label', '')) not between 1 and 200
        or jsonb_typeof(l -> 'amount_minor') is distinct from 'number'
        or (l ->> 'amount_minor')::numeric <= 0
        or (l ->> 'amount_minor')::numeric <> trunc((l ->> 'amount_minor')::numeric)
  ) then
    raise exception 'prepare_invoice: each line needs a label and an amount above zero' using errcode = '22023';
  end if;
  select sum((l ->> 'amount_minor')::bigint) into v_total from jsonb_array_elements(p_lines) l;

  select i.* into v_row from public.invoices i
   where i.project_id = p_project and i.group_task_id = p_group_task and i.status <> 'cancelled';
  if found then
    return v_row;
  end if;

  insert into public.invoices (project_id, rule_id, group_task_id, title, client_name, client_email, lines, amount_minor, currency, created_by)
  values (p_project, p_rule, p_group_task, left(btrim(p_title), 200), v_project.client_name, v_project.client_email, p_lines, v_total, v_project.currency, v_uid)
  on conflict (project_id, group_task_id) where status <> 'cancelled' do nothing
  returning * into v_row;
  if not found then
    -- Someone else's confirm recorded it between the read above and this insert.
    select i.* into strict v_row from public.invoices i
     where i.project_id = p_project and i.group_task_id = p_group_task and i.status <> 'cancelled';
  end if;
  return v_row;
end;
$$;
