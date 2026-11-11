-- The receipt step for everyone. A payment receipt is cost-sensitive (it states the amount), so
-- members without cost access cannot see the document; until now their approval chain waited for it
-- forever ("Filing the PayPal receipt…"). The payment now carries when its receipt was filed, which
-- every member may read (payment_authorizations is readable by all members), while the PDF itself
-- stays with those who may see costs.

alter table public.payment_authorizations
  add column receipt_filed_at timestamptz;

-- Set by the database when the payment service files the receipt (file_receipt inserts the row).
create or replace function public.project_documents_mark_receipt_filed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'receipt' and new.payment_authorization_id is not null then
    update public.payment_authorizations pa
       set receipt_filed_at = coalesce(pa.receipt_filed_at, new.created_at)
     where pa.id = new.payment_authorization_id;
  end if;
  return null;
end;
$$;

revoke execute on function public.project_documents_mark_receipt_filed() from public, anon, authenticated;

create trigger project_documents_mark_receipt_filed
  after insert on public.project_documents
  for each row execute function public.project_documents_mark_receipt_filed();

-- Receipts filed before this migration.
update public.payment_authorizations pa
   set receipt_filed_at = d.created_at
  from public.project_documents d
 where d.kind = 'receipt' and d.payment_authorization_id = pa.id and pa.receipt_filed_at is null;
