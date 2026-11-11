-- Each visit to a copy starts with the starter light fixtures package, and nothing a visitor saved outlives the visit.
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

select set_config('test.copy', (select project_id::text from public.copy_pool order by project_id limit 1), true);

insert into public.library_snippets (project_id, name, body)
values (current_setting('test.copy')::uuid, 'A visitor''s package', '{"children":[{"key":"a","name":"A","duration":1}],"links":[]}');
insert into public.library_folders (project_id, name) values (current_setting('test.copy')::uuid, 'A visitor''s folder');

select public.free_copy(current_setting('test.copy')::uuid);

select is((select count(*)::int from public.library_snippets where project_id = current_setting('test.copy')::uuid), 1,
  'a freed copy has one package in its library');
select is((select name from public.library_snippets where project_id = current_setting('test.copy')::uuid), 'New light fixtures',
  'the starter light fixtures package');
select is((select origin from public.library_snippets where project_id = current_setting('test.copy')::uuid), 'starter',
  'ready-made, not anyone''s');
select is((select count(*)::int from public.library_folders where project_id = current_setting('test.copy')::uuid), 0,
  'the visitor''s folder is gone too');
select is((select count(*)::int from public.library_snippets s join public.copy_pool c on c.project_id = s.project_id
            where c.claimed_at is null and s.name = 'New light fixtures'),
          (select count(*)::int from public.copy_pool where claimed_at is null),
  'every free copy has the package');

select * from finish();
rollback;
