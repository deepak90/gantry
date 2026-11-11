-- Core schema: identities, projects, memberships and browser sessions.
-- Clients only read these tables through RLS. project_members is written by the service role
-- alone, sessions by their owner (id, user_id, project_id and the last_seen heartbeat only; the
-- clock is the server's), projects by the RPCs of later migrations.

create extension if not exists pgcrypto with schema extensions;

-- -------------------------------------------------------------------------------------------
-- Tables
-- -------------------------------------------------------------------------------------------
create table public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  color        text not null default '#64748b' check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at   timestamptz not null default now()
);

create table public.projects (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  currency          text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  current_revision  int not null default 0 check (current_revision >= 0),
  -- Bryntum ProjectModel inline data as it was at snapshot_revision
  snapshot          jsonb not null default '{}'::jsonb,
  snapshot_revision int not null default 0 check (snapshot_revision >= 0),
  handover_task_id  bigint,
  created_at        timestamptz not null default now(),
  constraint projects_snapshot_not_ahead check (snapshot_revision <= current_revision)
);

create table public.project_members (
  project_id           uuid not null references public.projects (id) on delete cascade,
  user_id              uuid not null references auth.users (id) on delete cascade,
  role                 text not null check (role in ('pm', 'cm')),
  approval_limit_minor bigint not null default 0 check (approval_limit_minor >= 0),
  can_view_costs       boolean not null default false,
  created_at           timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index project_members_user_id_idx on public.project_members (user_id);

-- One row per browser tab. The id doubles as the Bryntum clientId and the LiveKit identity.
-- created_at orders the executor election (lowest created_at wins), so both timestamps are set from
-- the server clock by the trigger below and are never taken from the client.
create table public.sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);
create index sessions_project_id_created_at_idx on public.sessions (project_id, created_at);

create or replace function public.sessions_server_clock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := case when tg_op = 'INSERT' then now() else old.created_at end;
  new.last_seen  := now();
  return new;
end;
$$;

revoke execute on function public.sessions_server_clock() from public, anon, authenticated;

create trigger sessions_server_clock
  before insert or update on public.sessions
  for each row execute function public.sessions_server_clock();

-- -------------------------------------------------------------------------------------------
-- Membership helpers (security definer so RLS policies can consult project_members without
-- recursing into its own policies). All of them answer only about the calling user.
-- -------------------------------------------------------------------------------------------
create or replace function public.is_project_member(p uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.project_members m
    where m.project_id = p
      and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.member_role(p uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.project_members m
  where m.project_id = p
    and m.user_id = (select auth.uid());
$$;

-- True for the caller themselves and for every user who shares at least one project with them.
create or replace function public.shares_project_with(u uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select u = (select auth.uid())
      or exists (
        select 1
        from public.project_members mine
        join public.project_members theirs on theirs.project_id = mine.project_id
        where mine.user_id = (select auth.uid())
          and theirs.user_id = u
      );
$$;

-- -------------------------------------------------------------------------------------------
-- Profile bootstrap: every auth user gets a profile; display name and color come from the
-- sign-up metadata when present (display only, never used for authorization).
-- -------------------------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_color text := new.raw_user_meta_data ->> 'color';
begin
  insert into public.profiles (user_id, display_name, color)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'New user'
    ),
    case when v_color ~ '^#[0-9a-fA-F]{6}$' then v_color else '#64748b' end
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -------------------------------------------------------------------------------------------
-- Privileges and RLS. Supabase grants anon/authenticated everything on new public tables by
-- default, so the write paths clients must never use are revoked explicitly as well.
-- -------------------------------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.projects        enable row level security;
alter table public.project_members enable row level security;
alter table public.sessions        enable row level security;

revoke all on table public.profiles, public.projects, public.project_members, public.sessions from anon;
revoke insert, update, delete on table public.projects, public.project_members from authenticated;
revoke insert, update, delete on table public.profiles from authenticated;
grant update (display_name, color) on table public.profiles to authenticated;
-- A client opens a session and heartbeats it; created_at (and the stored last_seen) come from the
-- trigger, so neither timestamp can be forged to win the executor election.
revoke insert, update, delete on table public.sessions from authenticated;
grant insert (id, user_id, project_id, last_seen) on table public.sessions to authenticated;
grant update (last_seen) on table public.sessions to authenticated;

create policy "profiles: co-members can read"
  on public.profiles for select to authenticated
  using (public.shares_project_with(user_id));

create policy "profiles: owner can update"
  on public.profiles for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "projects: members can read"
  on public.projects for select to authenticated
  using (public.is_project_member(id));

create policy "project_members: members can read"
  on public.project_members for select to authenticated
  using (public.is_project_member(project_id));

create policy "sessions: owner and co-members can read"
  on public.sessions for select to authenticated
  using (user_id = (select auth.uid()) or public.is_project_member(project_id));

create policy "sessions: owner can insert"
  on public.sessions for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_project_member(project_id));

create policy "sessions: owner can update"
  on public.sessions for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.is_project_member(project_id));
