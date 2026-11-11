-- An invoice PayPal never took is drafted again when it is prepared again.
--
-- prepare_invoice used to hand back whatever invoice a change already had. One that PayPal refused before it made
-- an invoice (a line name over its limit, on the hosted site: "INVALID_ITEM_NAME_LENGTH") then kept its refused lines,
-- so even a corrected draft from Remy sent them again. Now a draft, or a refused one PayPal never made, takes the
-- lines, title and total it is prepared with, and goes back to being a draft. One PayPal has (sent, paid, or made but
-- not sent) is kept as it stands, so a change is never billed twice.

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
   where i.project_id = p_project and i.group_task_id = p_group_task and i.status <> 'cancelled'
     for update;
  if found then
    -- One PayPal never took (a draft, or refused before PayPal made one) is drafted again from these lines, so the
    -- corrected draft is what goes; one PayPal has stays as it stands, so nothing is billed twice.
    if v_row.status in ('draft', 'failed') and v_row.paypal_invoice_id is null then
      update public.invoices i
         set title = left(btrim(p_title), 200), lines = p_lines, amount_minor = v_total, status = 'draft', message = null, updated_at = now()
       where i.id = v_row.id
      returning i.* into v_row;
    end if;
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
revoke execute on function public.prepare_invoice(uuid, bigint, uuid, text, jsonb) from public, anon;
grant execute on function public.prepare_invoice(uuid, bigint, uuid, text, jsonb) to authenticated, service_role;
