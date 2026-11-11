-- Phantom id handling: replace_phantom_ids on nested fixtures, then end to end through
-- submit_revision (allocation, deep replacement in fields and $input, reuse across revisions).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- replace_phantom_ids unit tests -------------------------------------------------------------
select is(public.replace_phantom_ids(null, '{"p1": 7}'), null, 'null document -> null');
select is(public.replace_phantom_ids('{"a":"p1"}', '{}'), '{"a":"p1"}', 'empty mapping -> unchanged');
select is(public.replace_phantom_ids('{"a":"p1"}', null), '{"a":"p1"}', 'null mapping -> unchanged');
select is(public.replace_phantom_ids('"p1"', '{"p1": 7}'), '7', 'a top-level string is replaced');
select is(public.replace_phantom_ids('["p1","x",3,null,true,"p2"]', '{"p1": 7, "p2": 8}'),
  '[7,"x",3,null,true,8]', 'array elements are replaced in place, others untouched');
select is(public.replace_phantom_ids('{"a":{"b":[{"c":"p1","d":["p1",{"e":"p1"}]}]}}', '{"p1": 7}'),
  '{"a":{"b":[{"c":7,"d":[7,{"e":7}]}]}}', 'strings are replaced at any depth');
select is(public.replace_phantom_ids('{"$PhantomId":"p1","name":"p1"}', '{"p1": 7}'),
  '{"$PhantomId":"p1","id":7,"name":7}', '$PhantomId value is kept, id is set, any other field equal to the phantom is replaced');
select is(public.replace_phantom_ids('{"$PhantomId":"p9","name":"n"}', '{"p1": 7}'),
  '{"$PhantomId":"p9","name":"n"}', 'an unmapped $PhantomId gets no id');
select is(public.replace_phantom_ids('{"a":"p1x","b":"xp1","c":"P1","d":" p1"}', '{"p1": 7}'),
  '{"a":"p1x","b":"xp1","c":"P1","d":" p1"}', 'only exact string matches are replaced');
select is(public.replace_phantom_ids('{"$PhantomId":"p1","id":"p1"}', '{"p1": 7}'),
  '{"$PhantomId":"p1","id":7}', 'an existing id field is overwritten with the real id');
select is(public.replace_phantom_ids('{"removed":[{"id":"p1"}],"$input":{"removed":[{"id":"p1"}]}}', '{"p1": 7}'),
  '{"removed":[{"id":7}],"$input":{"removed":[{"id":7}]}}', 'removed entries and $input are processed');
select is(
  public.replace_phantom_ids(
    '{"tasks":{"$input":{"added":[{"$PhantomId":"phantom-1","name":"Task 1","orderedParentIndex":0}]},
               "added":[{"$PhantomId":"phantom-1","name":"Task 1","orderedParentIndex":0}],
               "updated":[{"id":1,"orderedParentIndex":1},{"id":2,"orderedParentIndex":2}]},
      "dependencies":{"$input":{"updated":[{"id":1,"toTask":"phantom-1"}]},"updated":[{"id":1,"toTask":"phantom-1"}]}}',
    '{"phantom-1": 3}'),
  '{"tasks":{"$input":{"added":[{"$PhantomId":"phantom-1","id":3,"name":"Task 1","orderedParentIndex":0}]},
             "added":[{"$PhantomId":"phantom-1","id":3,"name":"Task 1","orderedParentIndex":0}],
             "updated":[{"id":1,"orderedParentIndex":1},{"id":2,"orderedParentIndex":2}]},
    "dependencies":{"$input":{"updated":[{"id":1,"toTask":3}]},"updated":[{"id":1,"toTask":3}]}}',
  'Bryntum protocol guide fixture: ids added, references replaced in fields and $input');

-- End to end -----------------------------------------------------------------------------------
create temp table fx as
select gen_random_uuid() as client_a,
       (select current_revision from public.projects where id = '00000000-0000-4000-8000-000000000001') as base,
       (select count(*) from public.record_ids where project_id = '00000000-0000-4000-8000-000000000001') as ids0;
grant select on fx to authenticated;
insert into public.sessions (id, user_id, project_id)
select client_a, '00000000-0000-4000-8000-000000000011'::uuid, '00000000-0000-4000-8000-000000000001'::uuid from fx;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select lives_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), 'ph-1', null,
    '{"tasks":{"$input":{"added":[{"$PhantomId":"_generatedTaskModel_a1","name":"Crane pad","orderedParentIndex":3}]},
               "added":[{"$PhantomId":"_generatedTaskModel_a1","name":"Crane pad","orderedParentIndex":3}]},
      "dependencies":{"$input":{"added":[{"$PhantomId":"_generatedDependencyModel_d1","fromTask":12,"toTask":"_generatedTaskModel_a1"}],
                                "updated":[{"id":5,"toTask":"_generatedTaskModel_a1"}]},
                      "added":[{"$PhantomId":"_generatedDependencyModel_d1","fromTask":12,"toTask":"_generatedTaskModel_a1"}],
                      "updated":[{"id":5,"toTask":"_generatedTaskModel_a1"}]}}')$$,
  'a revision adding a task and a dependency that references it is accepted');
reset role;

create temp table r1 as
select changes,
       (changes #> '{tasks,added,0,id}') as task_id,
       (changes #> '{dependencies,added,0,id}') as dep_id
  from public.project_revisions
 where client_id = (select client_a from fx) and local_revision_id = 'ph-1';

select is((select jsonb_typeof(task_id) from r1), 'number', 'the added task got a numeric id');
select ok((select (task_id #>> '{}')::bigint >= 100000 from r1), 'task id comes from the sequence (>= 100000)');
select is((select jsonb_typeof(dep_id) from r1), 'number', 'the added dependency got a numeric id');
select isnt((select task_id from r1), (select dep_id from r1), 'task and dependency ids differ');
select is((select changes #> '{tasks,added,0,$PhantomId}' from r1), '"_generatedTaskModel_a1"', '$PhantomId is preserved on the added task');
select is((select changes #> '{tasks,$input,added,0,id}' from r1), (select task_id from r1), 'id is set inside $input.added too');
select is((select changes #> '{dependencies,added,0,toTask}' from r1), (select task_id from r1), 'dependency field references the real id');
select is((select changes #> '{dependencies,$input,added,0,toTask}' from r1), (select task_id from r1), '$input.added field references the real id');
select is((select changes #> '{dependencies,updated,0,toTask}' from r1), (select task_id from r1), 'updated field references the real id');
select is((select changes #> '{dependencies,$input,updated,0,toTask}' from r1), (select task_id from r1), '$input.updated field references the real id');
select is((select changes #> '{dependencies,added,0,fromTask}' from r1), '12', 'existing real ids are untouched');
select results_eq(
  $$select store, phantom_id, real_id from public.record_ids
     where project_id = '00000000-0000-4000-8000-000000000001' and phantom_id in ('_generatedTaskModel_a1', '_generatedDependencyModel_d1')
     order by store$$,
  $$select 'dependencies', '_generatedDependencyModel_d1', (dep_id #>> '{}')::bigint from r1
    union all
    select 'tasks', '_generatedTaskModel_a1', (task_id #>> '{}')::bigint from r1$$,
  'record_ids holds both phantom mappings');

-- Same phantom in a second revision maps to the same real id ---------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000011","role":"authenticated"}';
select lives_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), 'ph-2', null,
    '{"tasks":{"$input":{"added":[{"$PhantomId":"_generatedTaskModel_a1","name":"Crane pad (renamed)"}]},
               "added":[{"$PhantomId":"_generatedTaskModel_a1","name":"Crane pad (renamed)"}]}}')$$,
  'the same record added again is accepted');
-- A later revision that only references the phantom (no added entry) still resolves it.
select lives_ok(
  $$select public.submit_revision('00000000-0000-4000-8000-000000000001', (select client_a from fx), 'ph-3', null,
    '{"assignments":{"$input":{"added":[{"$PhantomId":"_generatedAssignmentModel_s1","event":"_generatedTaskModel_a1","resource":7}]},
                     "added":[{"$PhantomId":"_generatedAssignmentModel_s1","event":"_generatedTaskModel_a1","resource":7}]},
      "tasks":{"removed":[{"id":"_generatedTaskModel_a1"}],"$input":{"removed":[{"id":"_generatedTaskModel_a1"}]}}}')$$,
  'a revision referencing an earlier phantom without re-adding it is accepted');
reset role;

select is(
  (select changes #> '{tasks,added,0,id}' from public.project_revisions where client_id = (select client_a from fx) and local_revision_id = 'ph-2'),
  (select task_id from r1), 'the re-added record keeps its real id');
select is(
  (select changes #> '{assignments,added,0,event}' from public.project_revisions where client_id = (select client_a from fx) and local_revision_id = 'ph-3'),
  (select task_id from r1), 'a field referencing an earlier phantom is resolved from record_ids');
select is(
  (select changes #> '{tasks,removed,0,id}' from public.project_revisions where client_id = (select client_a from fx) and local_revision_id = 'ph-3'),
  (select task_id from r1), 'a removal by phantom id is resolved');
select is(
  (select changes #> '{tasks,$input,removed,0,id}' from public.project_revisions where client_id = (select client_a from fx) and local_revision_id = 'ph-3'),
  (select task_id from r1), '$input removal by phantom id is resolved');
select is(
  (select count(*) from public.record_ids where project_id = '00000000-0000-4000-8000-000000000001') - (select ids0 from fx),
  3::bigint, 'exactly three phantom ids were allocated across the three revisions');

-- Another client's phantom with the same text is a different record only if it is a different string;
-- Bryntum phantom ids embed a per-record unique suffix, so equal strings are the same record.
select is(
  (select real_id from public.record_ids where project_id = '00000000-0000-4000-8000-000000000001' and phantom_id = '_generatedTaskModel_a1'),
  (select (task_id #>> '{}')::bigint from r1), 'record_ids keeps a single mapping per phantom id');

select * from finish();
rollback;
