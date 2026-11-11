-- A copy added to the pool starts with the library too. The copy library (20261111120000) stocked the copies that
-- existed when it ran and restocks a copy when a visit starts or ends, but a fresh database (pnpm db:reset) adds its
-- copies after the migrations, from the seed, so they started with an empty library until their first visit. A copy
-- that is added already held keeps whatever its holder has.
create or replace function public.copy_pool_library_added()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.claimed_at is null then
    perform public.seed_copy_library(new.project_id);
  end if;
  return new;
end;
$$;
revoke execute on function public.copy_pool_library_added() from public, anon, authenticated;

drop trigger if exists copy_pool_library_added on public.copy_pool;
create trigger copy_pool_library_added
  after insert on public.copy_pool
  for each row execute function public.copy_pool_library_added();
