-- Each visit to a copy of Harbor starts with the same small library: a light fixtures package, ready
-- to drag onto a floor (the guide's "drag a package onto level 1", and asking Remy to drag it). A visit leaves nothing
-- behind for the next one: whatever a visitor saved or changed in the library goes when the copy is claimed again or
-- freed, the same moment its payouts and batches are forgotten (20261111050000, 20261111100000).

-- A ready-made package is nobody's: the library's own check (20261024010000_library.sql) stamped every insert with
-- whoever was signed in, so the package seeded while someone claims a copy would have read as theirs, and the cleanup
-- of idle visitors (20261111040000) could not delete them. Also, a person's id that was cleared because their account
-- went (on delete set null) stays cleared instead of being stamped back.
create or replace function public.library_snippets_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.folder_id is not null and not exists (
    select 1 from public.library_folders f where f.id = new.folder_id and f.project_id = new.project_id) then
    raise exception 'library: the folder is not in this project' using errcode = '23514';
  end if;
  new.updated_at := now();
  if new.origin = 'starter' or (tg_op = 'UPDATE' and old.updated_by is not null and new.updated_by is null) then
    new.updated_by := null;
  else
    new.updated_by := coalesce(auth.uid(), new.updated_by);
  end if;
  return new;
end;
$$;

create or replace function public.seed_copy_library(p_project uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.library_snippets where project_id = p_project;
  delete from public.library_folders where project_id = p_project;
  insert into public.library_snippets (project_id, folder_id, name, summary, icon, unit_one, unit_many, body, position, origin, created_by, updated_by)
  values (
    p_project, null, 'New light fixtures',
    'Order, deliver, install and test new light fixtures on one floor, about 50 fixtures.',
    'lightbulb', 'floor', 'floors',
    $pkg${"links":[{"to":"deliver","from":"order"},{"to":"install","from":"deliver"},{"to":"test","from":"install"}],"children":[{"key":"order","name":"Order light fixtures","note":"About 50 fixtures at one per 80 sq ft on 4,000 sq ft. Supplier price not yet given, so cost is 0. Check supplier lead time when ordering.","costs":[{"due":"on_order","label":"Light fixtures, 50","payee":"Fixture supplier","amount":35000}],"crews":[{"name":"Halden Electrical"}],"duration":1},{"key":"deliver","name":"Deliver light fixtures","note":"50 fixtures at $18 each to deliver.","costs":[{"due":"on_delivery","label":"Delivery, 50 fixtures","payee":"Carrow Freight","amount":900}],"crews":[{"name":"Carrow Freight"}],"duration":2},{"key":"install","name":"Install light fixtures","note":"50 fixtures at $108 each to install, in the lay-in ceiling grid.","costs":[{"due":"on_completion","label":"Install, 50 fixtures","payee":"Halden Electrical","amount":5400}],"crews":[{"name":"Halden Electrical"}],"duration":4},{"key":"test","name":"Test light fixtures","note":"50 fixtures at $10 each to test.","costs":[{"due":"on_completion","label":"Testing, 50 fixtures","payee":"Halden Electrical","amount":500}],"crews":[{"name":"Halden Electrical"}],"duration":1}]}$pkg$::jsonb,
    1, 'starter', null, null);
end;
$$;
revoke execute on function public.seed_copy_library(uuid) from public, anon, authenticated;

-- A new visit (claimed_at) or a freed copy (freed_at): the library goes back to the one package.
create or replace function public.copy_pool_library()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.claimed_at is distinct from old.claimed_at or new.freed_at is distinct from old.freed_at then
    perform public.seed_copy_library(new.project_id);
  end if;
  return new;
end;
$$;
revoke execute on function public.copy_pool_library() from public, anon, authenticated;

drop trigger if exists copy_pool_library on public.copy_pool;
create trigger copy_pool_library
  after update of claimed_at, freed_at on public.copy_pool
  for each row execute function public.copy_pool_library();

-- The copies as they are now: free ones get the library at once; one in use keeps its visitor's until it is freed.
select public.seed_copy_library(c.project_id) from public.copy_pool c where c.claimed_at is null;
