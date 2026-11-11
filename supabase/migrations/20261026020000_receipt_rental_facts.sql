-- The receipt prints the rental it paid for (see 20261026010000_rental_payment.sql): N billable
-- days at the day rate. receipt_facts now also returns the booking's day rate and the evaluation's
-- booking days; everything else is as in 20261022030100_project_documents.sql.

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
    'rental_rate_minor',     v_booking.rental_rate_minor,
    'proposal',            jsonb_build_object(
                             'id', v_proposal.id,
                             'version_no', v_version.version_no,
                             'inputs', v_version.inputs,
                             'cost_comparison', v_version.evaluation -> 'cost_comparison',
                             'booking_days', v_version.evaluation -> 'booking_days'),
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
