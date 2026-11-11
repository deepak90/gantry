-- Idempotent demo seed (ids and credentials from packages/shared/src/seed/index.ts).
-- Runs on every `supabase db reset`. seed_snapshot.sql (generated) runs afterwards and upserts the
-- Bryntum snapshot and the equipment booking.

-- Demo users (local-only passwords). GoTrue verifies bcrypt hashes of cost 10 like its own; the
-- pgcrypto default cost (6) is rejected with "Invalid login credentials".
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token,
  is_sso_user, is_anonymous
)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000011', 'authenticated', 'authenticated',
   'pm@demo.local', extensions.crypt('demo-pm-2026', extensions.gen_salt('bf', 10)), now(),
   '{"provider":"email","providers":["email"]}'::jsonb,
   '{"display_name":"Chris Hale","color":"#2563eb"}'::jsonb, now(), now(),
   '', '', '', '', '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000012', 'authenticated', 'authenticated',
   'cm@demo.local', extensions.crypt('demo-cm-2026', extensions.gen_salt('bf', 10)), now(),
   '{"provider":"email","providers":["email"]}'::jsonb,
   '{"display_name":"Deepak Jayaram","color":"#695086"}'::jsonb, now(), now(),
   '', '', '', '', '', '', '', '', false, false)
on conflict (id) do update set
  email              = excluded.email,
  encrypted_password = excluded.encrypted_password,
  email_confirmed_at = coalesce(auth.users.email_confirmed_at, excluded.email_confirmed_at),
  raw_app_meta_data  = excluded.raw_app_meta_data,
  raw_user_meta_data = excluded.raw_user_meta_data,
  updated_at         = now();

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
values
  (gen_random_uuid(), '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000011', 'email',
   jsonb_build_object('sub', '00000000-0000-4000-8000-000000000011', 'email', 'pm@demo.local',
                      'email_verified', true, 'phone_verified', false),
   now(), now(), now()),
  (gen_random_uuid(), '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000012', 'email',
   jsonb_build_object('sub', '00000000-0000-4000-8000-000000000012', 'email', 'cm@demo.local',
                      'email_verified', true, 'phone_verified', false),
   now(), now(), now())
on conflict (provider_id, provider) do update set
  identity_data = excluded.identity_data,
  updated_at    = now();

-- The auth.users trigger creates profiles on first insert; this keeps them exact on re-seed.
insert into public.profiles (user_id, display_name, color)
values
  ('00000000-0000-4000-8000-000000000011', 'Chris Hale', '#2563eb'),
  ('00000000-0000-4000-8000-000000000012', 'Deepak Jayaram', '#695086')
on conflict (user_id) do update set
  display_name = excluded.display_name,
  color        = excluded.color;

-- The demo projects. snapshot stays '{}' here; seed_snapshot.sql upserts the generated inline data.
insert into public.projects (id, name, currency, current_revision, snapshot, snapshot_revision, created_at)
values
  ('00000000-0000-4000-8000-000000000004', 'Cedar Park Clinic', 'USD', 0, '{}'::jsonb, 0, '2026-09-30T09:00:00Z'),
  ('00000000-0000-4000-8000-000000000001', 'Riverside Clinic', 'USD', 0, '{}'::jsonb, 0, '2026-10-01T09:00:00Z'),
  ('00000000-0000-4000-8000-000000000002', 'Harbor Street Offices', 'USD', 0, '{}'::jsonb, 0, '2026-10-02T09:00:00Z')
on conflict (id) do update set
  name     = excluded.name,
  currency = excluded.currency;

insert into public.project_members (project_id, user_id, role, can_view_costs, approval_limit_minor)
-- One role for the demo: everyone sees costs and approves fixes (the permission model stays in the
-- schema and its tests; the demo simply gives every member full rights). Limit: $250,000.
values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', 'cm', true, 25000000),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000012', 'cm', true, 25000000),
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000011', 'cm', true, 25000000),
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000012', 'cm', true, 25000000),
  ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000011', 'cm', true, 25000000),
  ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000012', 'cm', true, 25000000)
on conflict (project_id, user_id) do update set
  role                 = excluded.role,
  can_view_costs       = excluded.can_view_costs,
  approval_limit_minor = excluded.approval_limit_minor;
