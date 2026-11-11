-- The task library: members read and change their project's folders and snippets, nobody else sees
-- them; folders stay in one project, never inside themselves, at most six deep; a snippet's body has
-- tasks and links; deleting a folder keeps its snippets; changes are announced on
-- project:<id>:library (members receive, never send); seed_library writes a folder tree and
-- reset_demo restores the starter library; the assistant hears the new card buttons and drops.
-- Robust to rows other tools left in the database: every check names the rows made here.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create temp table t (name text primary key, id uuid);
grant all on t to authenticated, service_role;

insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at, is_sso_user, is_anonymous)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000ab', 'authenticated', 'authenticated',
        'library-outsider@test.local', now(), now(), false, false);
insert into public.projects (id, name) values ('00000000-0000-4000-8000-0000000000f2', 'Other library');
insert into public.project_members (project_id, user_id, role, can_view_costs)
values ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-0000000000ab', 'pm', false);

-- A member files a folder and a snippet --------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
with made as (
  insert into public.library_folders (project_id, name) values ('00000000-0000-4000-8000-000000000001', 'Test rooms') returning id
) insert into t select 'folder', id from made;
with made as (
  insert into public.library_folders (project_id, parent_id, name)
  values ('00000000-0000-4000-8000-000000000001', (select id from t where name = 'folder'), 'Test washrooms') returning id
) insert into t select 'subfolder', id from made;
with made as (
  insert into public.library_snippets (project_id, folder_id, name, summary, icon, unit_one, unit_many, body)
  values ('00000000-0000-4000-8000-000000000001', (select id from t where name = 'subfolder'), 'Test restroom', 'One room', 'restroom', 'room', 'rooms',
          '{"children":[{"key":"a","name":"Build out","duration":2}],"links":[]}')
  returning id
) insert into t select 'snippet', id from made;
select is(
  (select array[created_by::text, updated_by::text, origin] from public.library_snippets where id = (select id from t where name = 'snippet')),
  array['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000011', 'person'],
  'a snippet records who made it and comes from a person by default');
select lives_ok(
  $$update public.library_snippets set name = 'Test accessible restroom' where id = (select id from t where name = 'snippet')$$,
  'a member renames a snippet');

select throws_ok(
  $$update public.library_folders set parent_id = id where id = (select id from t where name = 'folder')$$,
  '23514', null, 'a folder cannot go inside itself');
select throws_ok(
  $$update public.library_folders set parent_id = (select id from t where name = 'subfolder') where id = (select id from t where name = 'folder')$$,
  '23514', null, 'nor inside a folder of its own');
select throws_ok(
  $$insert into public.library_snippets (project_id, name, body) values ('00000000-0000-4000-8000-000000000001', 'Empty', '{"children":[],"links":[]}')$$,
  '23514', null, 'a snippet has at least one task');
select throws_ok(
  $$insert into public.library_snippets (project_id, name, body) values ('00000000-0000-4000-8000-000000000001', 'No links', '{"children":[{"key":"a","name":"A","duration":1}]}')$$,
  '23514', null, 'a snippet body lists its links');
select throws_ok(
  $$insert into public.library_folders (project_id, name) values ('00000000-0000-4000-8000-0000000000f2', 'Not mine')$$,
  '42501', null, 'a member cannot file into another project''s library');
reset role;

-- The outsider sees nothing of it, and cannot file into this project ------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000ab","role":"authenticated"}';
select is((select count(*) from public.library_snippets where project_id = '00000000-0000-4000-8000-000000000001'), 0::bigint,
  'a non-member reads no snippet of the project');
select is((select count(*) from public.library_folders where project_id = '00000000-0000-4000-8000-000000000001'), 0::bigint,
  'nor any folder');
select throws_ok(
  $$insert into public.library_snippets (project_id, name, body) values ('00000000-0000-4000-8000-000000000001', 'Sneaky', '{"children":[{"key":"a","name":"A","duration":1}],"links":[]}')$$,
  '42501', null, 'nor add one');
select throws_ok(
  $$insert into public.library_folders (project_id, parent_id, name) values ('00000000-0000-4000-8000-0000000000f2', (select id from t where name = 'folder'), 'Borrowed')$$,
  '23514', null, 'a folder''s parent is in the same project');
reset role;

-- Changes are announced on the library topic ------------------------------------------------------------
select ok(
  (select count(*) from realtime.messages
    where topic = 'project:00000000-0000-4000-8000-000000000001:library' and event = 'changed'
      and payload ->> 'id' = (select id::text from t where name = 'snippet')) >= 2,
  'adding and renaming the snippet were announced');
select is(
  (select payload - 'id' from realtime.messages
    where topic = 'project:00000000-0000-4000-8000-000000000001:library' and payload ->> 'id' = (select id::text from t where name = 'folder')
    order by inserted_at limit 1),
  '{"op": "insert", "table": "library_folders"}'::jsonb, 'a folder change names its table and what happened');
select is(public.project_topic_channel('project:00000000-0000-4000-8000-000000000001:library'), 'library', 'the library topic is a project topic');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select ok(public.can_join_project_topic('project:00000000-0000-4000-8000-000000000001:library'), 'members receive on it');
select ok(not public.can_send_on_project_topic('project:00000000-0000-4000-8000-000000000001:library'), 'and never send on it');

-- Deleting a folder keeps its snippets (they move to the top level) ----------------------------------------
select lives_ok($$delete from public.library_folders where id = (select id from t where name = 'folder')$$, 'a member deletes a folder');
select is((select count(*) from public.library_folders where id in (select id from t where name in ('folder', 'subfolder'))), 0::bigint,
  'the folder and the folder in it are gone');
select is((select folder_id from public.library_snippets where id = (select id from t where name = 'snippet')), null,
  'the snippet in it stays, at the top level');
select lives_ok($$delete from public.library_snippets where id = (select id from t where name = 'snippet')$$, 'a member deletes a snippet');
reset role;

-- seed_library writes a folder tree (service role only) ---------------------------------------------------
set local role authenticated;
select throws_ok($$select public.seed_library('00000000-0000-4000-8000-0000000000f2', '[]')$$, '42501', null, 'members cannot seed a library');
reset role;
set local role service_role;
select is(
  public.seed_library('00000000-0000-4000-8000-0000000000f2',
    '[{"name":"Build-out","snippets":[],"folders":[{"name":"Rooms","snippets":[{"name":"Room","summary":"","icon":"door-open","unit":{"one":"room","many":"rooms"},"body":{"children":[{"key":"a","name":"A","duration":1}],"links":[]}}],"folders":[]}]},{"name":"Services","snippets":[],"folders":[]}]'),
  1, 'seed_library writes the snippets and says how many');
reset role;
select is(
  (select array_agg(f.name || ':' || coalesce(p.name, '-') order by f.name) from public.library_folders f
     left join public.library_folders p on p.id = f.parent_id where f.project_id = '00000000-0000-4000-8000-0000000000f2'),
  array['Build-out:-', 'Rooms:Build-out', 'Services:-'], 'folders nest as given');
select is(
  (select origin || ':' || unit_many from public.library_snippets where project_id = '00000000-0000-4000-8000-0000000000f2'),
  'starter:rooms', 'seeded snippets are starters');

-- The assistant hears the new buttons and drops ----------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select is(
  (public.post_agent_message('00000000-0000-4000-8000-000000000001', 'Applied it.', 'text', '{"kind":"apply_edit","card_id":"toolu_1"}')).action,
  '{"kind": "apply_edit", "card_id": "toolu_1"}'::jsonb, 'applying a drafted change names its card');
select lives_ok(
  $$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'Not this one.', 'text', '{"kind":"dismiss_edit","card_id":"toolu_1"}')$$,
  'dismissing one too');
select lives_ok(
  $$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'Saved.', 'text', '{"kind":"save_snippet","card_id":"toolu_2"}')$$,
  'and saving a draft');
select is(
  (public.post_agent_message('00000000-0000-4000-8000-000000000001', 'I added it.', 'text',
    '{"kind":"library_drop","detail":{"snippet_id":"s","name":"Room","top_ids":[5],"anchor_id":4,"parent_id":3,"mode":"push"}}')).action -> 'detail' ->> 'mode',
  'push', 'a library drop carries where it landed');
select throws_ok(
  $$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'x', 'text', '{"kind":"library_drop","detail":{},"extra":1}')$$,
  '22023', null, 'a drop has no other fields');
select throws_ok(
  $$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'x', 'text', jsonb_build_object('kind', 'library_drop', 'detail', jsonb_build_object('name', repeat('x', 2001))))$$,
  '22023', null, 'a drop''s detail is small');
select throws_ok(
  $$select public.post_agent_message('00000000-0000-4000-8000-000000000001', 'x', 'text', '{"kind":"apply_edit"}')$$,
  '22023', null, 'applying names its card');
reset role;

-- reset_demo restores the starter library ----------------------------------------------------------------
insert into public.library_snippets (project_id, name, body, origin)
values ('00000000-0000-4000-8000-000000000001', 'Made during the demo', '{"children":[{"key":"a","name":"A","duration":1}],"links":[]}', 'person');
set local role service_role;
select lives_ok($$select public.reset_demo('00000000-0000-4000-8000-000000000001')$$, 'reset_demo runs');
reset role;
select is((select count(*) from public.library_snippets where project_id = '00000000-0000-4000-8000-000000000001' and name = 'Made during the demo'), 0::bigint,
  'snippets made since the seed are gone');
select ok(
  (select count(*) from public.library_snippets where project_id = '00000000-0000-4000-8000-000000000001' and origin = 'starter')
    = (select count(*) from jsonb_path_query((select library from public.demo_seeds where project_id = '00000000-0000-4000-8000-000000000001'), 'strict $.**.snippets[*]')),
  'the starter library is back');

select * from finish();
rollback;
