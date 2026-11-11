-- The task library: each project's folders and snippets (pieces of plan, see
-- packages/shared/src/library.ts), shared by the project's members, who all may add, change, file
-- and delete them. Changes are announced as `changed` {table, id, op} on the private Realtime topic
-- `project:{id}:library`; clients re-read through RLS. A new project's library is written by
-- seed_library() from packages/shared/src/library-starter.ts (the seed and reset_demo).
--
-- Also here, because the library brings it in: the assistant hears new card buttons and library drops
-- (agent_action_canonical). A snippet's time ranges travel on its top task (the `bands` field), not
-- in Bryntum's time range store, which revisions do not carry.

-- -------------------------------------------------------------------------------------------
-- library_folders
-- -------------------------------------------------------------------------------------------
create table public.library_folders (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  -- Null for a top-level folder. Deleting a folder deletes the folders in it; their snippets move
  -- to the top level (library_snippets.folder_id is set null), so nothing is lost by accident.
  parent_id  uuid references public.library_folders (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 80),
  -- Order among siblings (fractional, so a move writes one row).
  position   double precision not null default 0,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index library_folders_project_id_idx on public.library_folders (project_id, parent_id, position);

-- A folder's parent is in the same project, never inside the folder itself, at most 6 levels deep.
create or replace function public.library_folders_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parent uuid := new.parent_id;
  v_depth  int := 1;
begin
  while v_parent is not null loop
    if v_parent = new.id then
      raise exception 'library: a folder cannot go inside itself' using errcode = '23514';
    end if;
    v_depth := v_depth + 1;
    if v_depth > 6 then
      raise exception 'library: folders nest at most 6 levels deep' using errcode = '23514';
    end if;
    select f.parent_id into v_parent
      from public.library_folders f
     where f.id = v_parent and f.project_id = new.project_id;
    if not found then
      raise exception 'library: the parent folder is not in this project' using errcode = '23514';
    end if;
  end loop;
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.library_folders_check() from public, anon, authenticated;

create trigger library_folders_check
  before insert or update on public.library_folders
  for each row execute function public.library_folders_check();

-- -------------------------------------------------------------------------------------------
-- library_snippets
-- -------------------------------------------------------------------------------------------
create table public.library_snippets (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  folder_id  uuid references public.library_folders (id) on delete set null,
  name       text not null check (length(btrim(name)) between 1 and 120),
  summary    text not null default '' check (length(summary) <= 400),
  icon       text not null default 'cubes' check (icon ~ '^[a-z0-9-]{1,40}$'),
  unit_one   text not null default 'copy' check (length(btrim(unit_one)) between 1 and 30),
  unit_many  text not null default 'copies' check (length(btrim(unit_many)) between 1 and 30),
  -- SnippetBody {children, links, timeRanges?}; the apps check the rest with zod.
  -- coalesce: a missing key makes the expression null, which a check would let through.
  body       jsonb not null check (coalesce(
               jsonb_typeof(body) = 'object'
               and jsonb_typeof(body -> 'children') = 'array'
               and jsonb_array_length(body -> 'children') between 1 and 60
               and jsonb_typeof(body -> 'links') = 'array'
               and length(body::text) <= 200000, false)),
  position   double precision not null default 0,
  -- Mirrors LibraryOrigin: the starter library, a person, the assistant's draft, saved from the plan.
  origin     text not null default 'person' check (origin in ('starter', 'person', 'assistant', 'plan')),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index library_snippets_project_id_idx on public.library_snippets (project_id, folder_id, position);

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
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;

revoke execute on function public.library_snippets_check() from public, anon, authenticated;

create trigger library_snippets_check
  before insert or update on public.library_snippets
  for each row execute function public.library_snippets_check();

-- -------------------------------------------------------------------------------------------
-- Access: the project's members read and change their library; nobody else sees it.
-- -------------------------------------------------------------------------------------------
alter table public.library_folders enable row level security;
alter table public.library_snippets enable row level security;
revoke all on table public.library_folders, public.library_snippets from anon;
grant select, insert, update, delete on table public.library_folders, public.library_snippets to authenticated;

create policy "library_folders: members read" on public.library_folders
  for select to authenticated using (public.is_project_member(project_id));
create policy "library_folders: members add" on public.library_folders
  for insert to authenticated with check (public.is_project_member(project_id));
create policy "library_folders: members change" on public.library_folders
  for update to authenticated using (public.is_project_member(project_id)) with check (public.is_project_member(project_id));
create policy "library_folders: members delete" on public.library_folders
  for delete to authenticated using (public.is_project_member(project_id));

create policy "library_snippets: members read" on public.library_snippets
  for select to authenticated using (public.is_project_member(project_id));
create policy "library_snippets: members add" on public.library_snippets
  for insert to authenticated with check (public.is_project_member(project_id));
create policy "library_snippets: members change" on public.library_snippets
  for update to authenticated using (public.is_project_member(project_id)) with check (public.is_project_member(project_id));
create policy "library_snippets: members delete" on public.library_snippets
  for delete to authenticated using (public.is_project_member(project_id));

-- -------------------------------------------------------------------------------------------
-- Realtime: `changed` {table, id, op} on project:{id}:library (members receive; nobody sends).
-- -------------------------------------------------------------------------------------------
create or replace function public.broadcast_library_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_id      uuid;
begin
  if tg_op = 'DELETE' then
    v_project := old.project_id;
    v_id := old.id;
  else
    v_project := new.project_id;
    v_id := new.id;
  end if;
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    perform realtime.send(jsonb_build_object('table', tg_table_name, 'id', v_id, 'op', lower(tg_op)), 'changed',
                          'project:' || v_project::text || ':library', true);
  end if;
  return null;
end;
$$;

revoke execute on function public.broadcast_library_change() from public, anon, authenticated;

create trigger library_folders_broadcast
  after insert or update or delete on public.library_folders
  for each row execute function public.broadcast_library_change();

create trigger library_snippets_broadcast
  after insert or update or delete on public.library_snippets
  for each row execute function public.broadcast_library_change();

create or replace function public.project_topic_channel(p_topic text)
returns text
language sql
immutable
set search_path = ''
as $$
  select (regexp_match(
    p_topic,
    '^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(revisions|presence|view|cursor|commercial|workflow|agent|library)$'))[1];
$$;

-- -------------------------------------------------------------------------------------------
-- seed_library: replace a project's library with a folder tree (service role: the seed and
-- reset_demo). p_library: [{name, snippets: [{name, summary, icon, unit: {one, many}, body}],
-- folders: [...]}]. Returns the number of snippets written.
-- -------------------------------------------------------------------------------------------
create or replace function public.seed_library_folders(p_project uuid, p_parent uuid, p_folders jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_folder  jsonb;
  v_snippet jsonb;
  v_index   bigint;
  v_order   bigint;
  v_id      uuid;
  v_count   int := 0;
begin
  for v_folder, v_index in select value, ordinality from jsonb_array_elements(coalesce(p_folders, '[]'::jsonb)) with ordinality loop
    insert into public.library_folders (project_id, parent_id, name, position, created_by)
    values (p_project, p_parent, v_folder ->> 'name', v_index, null)
    returning id into v_id;
    for v_snippet, v_order in select value, ordinality from jsonb_array_elements(coalesce(v_folder -> 'snippets', '[]'::jsonb)) with ordinality loop
      insert into public.library_snippets (project_id, folder_id, name, summary, icon, unit_one, unit_many, body, position, origin, created_by)
      values (p_project, v_id, v_snippet ->> 'name', coalesce(v_snippet ->> 'summary', ''), coalesce(v_snippet ->> 'icon', 'cubes'),
              coalesce(v_snippet #>> '{unit,one}', 'copy'), coalesce(v_snippet #>> '{unit,many}', 'copies'), v_snippet -> 'body', v_order,
              'starter', null);
      v_count := v_count + 1;
    end loop;
    v_count := v_count + public.seed_library_folders(p_project, v_id, v_folder -> 'folders');
  end loop;
  return v_count;
end;
$$;

create or replace function public.seed_library(p_project uuid, p_library jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_library is null or jsonb_typeof(p_library) <> 'array' then
    raise exception 'seed_library: p_library must be a JSON array of folders' using errcode = '22023';
  end if;
  delete from public.library_snippets where project_id = p_project;
  delete from public.library_folders where project_id = p_project;
  return public.seed_library_folders(p_project, null, p_library);
end;
$$;

revoke execute on function public.seed_library_folders(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.seed_library(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.seed_library(uuid, jsonb) to service_role;

-- What reset_demo() writes back (the seed fills it from library-starter.ts).
alter table public.demo_seeds add column library jsonb;

-- -------------------------------------------------------------------------------------------
-- reset_demo, as in 20261022040000_assistant.sql, now also restoring the starter library.
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
  delete from public.agent_messages where project_id = p_project;
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

  if v_seed.library is not null then
    perform public.seed_library(p_project, v_seed.library);
  end if;

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

-- -------------------------------------------------------------------------------------------
-- The assistant hears more of what people do (mirrors AgentAction in packages/shared/src/agent.ts):
--   {"kind":"prepare_fix"|"not_now","issue_id":"..."}
--   {"kind":"choice"|"apply_edit"|"dismiss_edit"|"save_snippet","card_id":"..."}
--   {"kind":"library_drop","detail":{...}}  where a library piece landed (at most 2000 characters)
-- -------------------------------------------------------------------------------------------
create or replace function public.agent_action_canonical(p_action jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_kind  text;
  v_field text;
  v_value text;
  v_max   int;
  v_key   text;
begin
  if p_action is null or jsonb_typeof(p_action) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_action) <> 'object' then
    raise exception 'the action must be a JSON object' using errcode = '22023';
  end if;
  v_kind := p_action ->> 'kind';
  if v_kind = 'library_drop' then
    for v_key in select jsonb_object_keys(p_action) loop
      if v_key not in ('kind', 'detail') then
        raise exception 'action library_drop: unknown field "%"', v_key using errcode = '22023';
      end if;
    end loop;
    if jsonb_typeof(p_action -> 'detail') is distinct from 'object' or length((p_action -> 'detail')::text) > 2000 then
      raise exception 'action library_drop: detail must be an object of at most 2000 characters' using errcode = '22023';
    end if;
    return jsonb_build_object('kind', v_kind, 'detail', p_action -> 'detail');
  end if;
  if v_kind in ('prepare_fix', 'not_now') then
    v_field := 'issue_id';
    v_max := 200;
  elsif v_kind in ('choice', 'apply_edit', 'dismiss_edit', 'save_snippet') then
    v_field := 'card_id';
    v_max := 64;
  else
    raise exception 'the action kind must be prepare_fix, not_now, choice, apply_edit, dismiss_edit, save_snippet or library_drop' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_action) loop
    if v_key not in ('kind', v_field) then
      raise exception 'action %: unknown field "%"', v_kind, v_key using errcode = '22023';
    end if;
  end loop;
  v_value := p_action ->> v_field;
  if jsonb_typeof(p_action -> v_field) is distinct from 'string' or length(v_value) not between 1 and v_max then
    raise exception 'action %: % must be a string of 1-% characters', v_kind, v_field, v_max using errcode = '22023';
  end if;
  return jsonb_build_object('kind', v_kind, v_field, v_value);
end;
$$;

revoke execute on function public.agent_action_canonical(jsonb) from public, anon, authenticated;
