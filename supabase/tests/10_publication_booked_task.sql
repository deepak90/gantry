-- task_in_plan: whether a task is in a project as of its latest revision (the snapshot's task tree,
-- overridden by the latest revision after it that adds or removes the task), and its use by
-- publication_revision_check, which refuses a publication whose booked activity was deleted. The
-- workflow suite covers the rest of the publication revision.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- A project of its own: the snapshot nests task 15 two levels deep, as Bryntum inline data does.
insert into public.projects (id, name, snapshot, snapshot_revision, current_revision)
values ('00000000-0000-4000-8000-0000000000f1', 'Plan check', '{
  "project": {"startDate": "2026-11-02"},
  "tasksData": [
    {"id": 1, "name": "Structure", "children": [
      {"id": 11, "name": "Frame", "children": [{"id": 15, "name": "Crane erection"}]},
      {"id": 12, "name": "Roof deck", "baselines": [{"startDate": "2026-11-02", "endDate": "2026-11-04"}]}
    ]},
    {"id": 42, "name": "Handover"}
  ],
  "dependenciesData": [{"id": 77, "fromEvent": 12, "toEvent": 42}]
}'::jsonb, 3, 3);

select ok(public.task_in_plan('00000000-0000-4000-8000-0000000000f1', 15), 'a task nested in the snapshot is in the plan');
select ok(public.task_in_plan('00000000-0000-4000-8000-0000000000f1', 42), 'a top-level task is in the plan');
select ok(not public.task_in_plan('00000000-0000-4000-8000-0000000000f1', 77), 'a dependency id is not a task');
select ok(not public.task_in_plan('00000000-0000-4000-8000-0000000000f1', 99), 'an unknown task is not in the plan');
select ok(not public.task_in_plan('00000000-0000-4000-8000-0000000000f2', 15), 'an unknown project has no tasks');

-- Revisions at or before the snapshot are already in it.
insert into public.project_revisions (project_id, revision_no, client_id, local_revision_id, changes)
values ('00000000-0000-4000-8000-0000000000f1', 2, gen_random_uuid(), 'old', '{"tasks":{"removed":[{"id":15}]}}');
select ok(public.task_in_plan('00000000-0000-4000-8000-0000000000f1', 15), 'a revision the snapshot includes does not count');

-- Removing the parent lists the whole subtree, the crane task included.
insert into public.project_revisions (project_id, revision_no, client_id, local_revision_id, changes)
values ('00000000-0000-4000-8000-0000000000f1', 4, gen_random_uuid(), 'delete-frame',
        '{"tasks":{"removed":[{"id":11},{"id":15}],"$input":{"removed":[{"id":11},{"id":15}]}},"project":{"endDate":"2026-12-01T00:00:00"}}');
select ok(not public.task_in_plan('00000000-0000-4000-8000-0000000000f1', 15), 'a task removed after the snapshot is not in the plan');
select ok(public.task_in_plan('00000000-0000-4000-8000-0000000000f1', 42), 'other tasks stay in the plan');

-- A revision that touches other tasks only does not decide.
insert into public.project_revisions (project_id, revision_no, client_id, local_revision_id, changes)
values ('00000000-0000-4000-8000-0000000000f1', 5, gen_random_uuid(), 'rename', '{"tasks":{"updated":[{"id":42,"name":"Handover (client)"}]}}');
select ok(not public.task_in_plan('00000000-0000-4000-8000-0000000000f1', 15), 'later unrelated revisions keep it removed');

-- Undo puts the record back with its id.
insert into public.project_revisions (project_id, revision_no, client_id, local_revision_id, changes)
values ('00000000-0000-4000-8000-0000000000f1', 6, gen_random_uuid(), 'undo',
        '{"tasks":{"added":[{"$PhantomId":15,"id":15,"name":"Crane erection"}],"$input":{"added":[{"$PhantomId":15,"id":15}]}}}');
select ok(public.task_in_plan('00000000-0000-4000-8000-0000000000f1', 15), 'a task added back by a later revision is in the plan');

-- A task added after the snapshot.
insert into public.project_revisions (project_id, revision_no, client_id, local_revision_id, changes)
values ('00000000-0000-4000-8000-0000000000f1', 7, gen_random_uuid(), 'add',
        '{"tasks":{"added":[{"$PhantomId":"_generatedCollabTask_x","id":100500,"name":"Construction fence"}]}}');
select ok(public.task_in_plan('00000000-0000-4000-8000-0000000000f1', 100500), 'a task added after the snapshot is in the plan');

-- Wiring and privileges.
select matches(
  pg_get_functiondef('public.publication_revision_check(uuid,uuid,uuid,jsonb)'::regprocedure),
  'task_in_plan\(p_project, v_booking\.task_id',
  'publication_revision_check refuses a publication whose booked task is not in the plan');
select matches(
  pg_get_functiondef('public.publication_revision_check(uuid,uuid,uuid,jsonb)'::regprocedure),
  E'v_input = \'\\{\\}\'::jsonb',
  'an empty $input counts as no input in a publication revision');
select ok(not has_function_privilege('authenticated', 'public.task_in_plan(uuid,bigint)', 'execute'),
  'task_in_plan is not callable by clients');
select ok(not has_function_privilege('anon', 'public.task_in_plan(uuid,bigint)', 'execute'),
  'task_in_plan is not callable by anon');

select * from finish();
rollback;
