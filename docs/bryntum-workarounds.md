# Bryntum workarounds

What we do differently from plain Bryntum Gantt in the realtime code, why, and when each piece can go.

To tell Bryntum's problems from ours, each suspect ran in the browser on plain Bryntum 7.3.8: two clients on the setup its revisions guide and realtime demo use, with none of our classes or code in the path. If a problem shows up there, it is Bryntum's. If it does not, the cause is in our code or in how the two interact. [`tests/e2e/bryntum-plain.spec.ts`](../tests/e2e/bryntum-plain.spec.ts) keeps those checks. It passes while Bryntum behaves as described here, so a failure after an upgrade means a workaround below may no longer be needed.

## Where the code lives

The layout follows Bryntum's own source: one class per file, under `model/` and `data/`.

```
apps/web/src/gantt/
  project.ts                 The factory, loading, and every export the rest of the app imports
  model/                     CollabProjectModel, CollabTask, CollabSegment, CollabBaseline,
                             CollabResource, CollabAssignment
  data/CollabTaskStore.ts    Keeps ordered positions on apply, lifts filters on delete
  revisions/
    reconcile.ts             Revisions landing on a state they were not made on
    ordered-tree.ts          Row order across clients
    split-tasks.ts           Split tasks under revisions
  filters.ts                 Running a change with the plan's filters lifted
  menu-actions.ts            The task menu's actions, through the project queue
  task-clipboard.ts          Copy, cut and paste of whole tasks
```

Our patches are subclass methods on our own model and store classes, so they touch nothing outside this app. That is why we do not use Bryntum's `Override` class, which patches its classes globally. Its `fixedIn` option would switch a patch off after an upgrade, and the plain-Bryntum spec does that job here by failing instead. We add no custom feature classes, partly because `GridFeatureManager`, which registers them, is deprecated and goes away in 8.0.

## Bryntum's behavior

Each of these reproduces on plain 7.3.8.

| Problem | What plain Bryntum does | Tracker | Our answer | It can go when |
| --- | --- | --- | --- | --- |
| Someone acts in the turn the engine leaves for the screen, between marking a person's input and writing its results | The action is recorded as calculated, so its revision has no input and no other client applies it. It stays on that client alone | None found | `CollabProjectModel.suspendChangeTracking` marks it as input at the end of that turn. `menu-actions.ts` runs the task menu's actions through the project queue, since Bryntum's write to the store as soon as they are clicked. Everything else here is queued already | `K33` passes without them |
| A split task moved by a pending change is replayed under someone else's revision | The two clients disagree: 0 days against 3 for the same task | None found. [#12499](https://github.com/bryntum/support/issues/12499) made split tasks work with revisions in 7.3.1 | `recordsSplitWrite`, `rescheduleSplitTasks` and the rest of `split-tasks.ts` | Scenario `K26` passes without them |
| A client with a filter on receives a nested group | It keeps only the tasks its filter shows: 3 of 6 | None found. [#11533](https://github.com/bryntum/support/issues/11533) fixed a similar case in 7.1.2 | `withoutFilters` | `A10`, `D12`, `F8` and `S9` pass without it |
| Two people move two groups into each other | Stack overflow on both clients | None found | `CollabTask.insertChild` for a replay, `reconcileInput` for a remote move | `K25` passes without them |
| Two people add the same link | Two copies on both clients | [#13068](https://github.com/bryntum/support/issues/13068), open | `duplicatesOf` | `K8` and `K28` pass without it |
| A task is deleted under a filter and undone once the filter is off | It returns to the wrong row | [#13813](https://github.com/bryntum/support/issues/13813), open | `CollabTaskStore.remove` lifts the filters first | `F12` passes without it |
| Someone else moves a row | The other client's rows stay as they were | None found | `rowsFollowOrderedTree`, `keepOrderedPositions`, `settleOwnOrder` | See "Row order" below |
| Deletes cross and empty a group | Each client keeps the length the group had at its last step: 12 days against 3 | None found | None. Known gap, scenario `K11` | `K11` passes |
| A cycle names no link while a revision is applied | Bryntum's handler reads the first link of an empty list and throws | None found | `settleSplitCycle` answers before it runs | See the first row of the next table |

## Our own making

These do not reproduce on plain Bryntum.

| Problem | What we found | What we did |
| --- | --- | --- |
| False "Scheduling cycle" on a split task, which took a client out of sync or opened an empty pop-up | Our `recordsSplitWrite` exposes it. With that override off, the cycle goes away and the first row of the table above comes back. Not recording the end date as well does not help | `settleSplitCycle`, called from `CollabProjectModel.onCycleSchedulingIssue` |
| A piece dropped with a filter on reached the server with 4 of its 15 tasks | Plain Bryntum sends all of a nested group, so the loss is on our drop path | `withoutFilters` covers it. The drop path itself was not reworked |
| A real loop in a preview would hang forever | A `cycle` listener we had added meant the engine waited for an answer nobody gives on a project with no screen. Bryntum tracks the same trap as [#13603](https://github.com/bryntum/support/issues/13603) | The override above replaced the listener. `test/gantt/cycles.test.ts` covers it |

## What we tried replacing with Bryntum's own

| Bryntum's own | Result | Decision |
| --- | --- | --- |
| Settling two links that close a loop only together | Switches the later link off on every client, and they agree. Inactive links are already a normal concept in the app and the agent | **Adopted.** Our loop check is gone |
| Row paste (`TaskCopyPaste`) with a guard for removed tasks | The nine directed paste scenarios pass. All three long two-person sessions lose dates by round 6 | Kept `task-clipboard.ts` |
| A sorter on `wbsValue`, as in Bryntum's realtime demo | The order scenarios pass, but `children` stay unsorted and 9 unit tests fail. Clearing a column sort and mirroring sort to followers would both need rework | Not adopted: not an easy swap |
| Removing the filter lifts | `A10`, `A12`, `A13`, `D12`, `F2`, `F8` and `S9` fail | Kept `withoutFilters` |
| `outdentIgnoringSiblings`, set in Bryntum's realtime demo | By default, moving a task out a level also moves the tasks below it under it, which closes a loop whenever it leads to them and opens the "Scheduling cycle" dialog. With this on, only the task moves, as the menu's "Move out one level" says | **Adopted.** Scenario `K30` |

### Row order

On plain Bryntum a client's rows do not follow someone else's move. `rowsFollowOrderedTree` could give way to the `wbsValue` sorter if the rework above is ever worth doing. The other two pieces do not depend on it: without `keepOrderedPositions`, `R11` and `L11` fail, and without `settleOwnOrder`, `K18` fails.

## Tracker issues checked

The public tracker is [bryntum/support](https://github.com/bryntum/support/issues). These are the realtime issues closest to what this app does.

| Issue | State | Here |
| --- | --- | --- |
| [#13859](https://github.com/bryntum/support/issues/13859) Undo crossing its own revision loses a task's dates | Fixed in 7.3.8 | On 7.3.8. Scenario `K27` |
| [#13885](https://github.com/bryntum/support/issues/13885) Constraint pop-up appears again when undoing a revision | Fixed in 7.3.8 | On 7.3.8. No scenario of ours |
| [#13813](https://github.com/bryntum/support/issues/13813) Undo after a filtered removal lands in the wrong row | Open | Avoided. Scenario `F12` |
| [#13068](https://github.com/bryntum/support/issues/13068) Duplicate links | Open | Handled, any link type. Scenarios `K8`, `K28` |
| [#11451](https://github.com/bryntum/support/issues/11451) Redoing a removed event loses track of its assignments | Open | Scenario `K29` |
| [#13957](https://github.com/bryntum/support/issues/13957) Task re-added by undo lands at the root, after the task editor was opened on it | Closed, not yet in the changelog | Not reachable: Bryntum's task editor is off here |
| [#13823](https://github.com/bryntum/support/issues/13823) Task removed after cut, paste and `applyChangeset` | Open | Reported on Scheduler Pro. Our cut is a move in one transaction. Scenarios `R14`, `R15` |
| [#13981](https://github.com/bryntum/support/issues/13981) Two feature transactions can run at once | Open | Not tested directly. `task-clipboard.ts` runs no feature transaction |
| [#13603](https://github.com/bryntum/support/issues/13603) `commitAsync()` never resolves on an unanswered cycle | Open | Covered by `test/gantt/cycles.test.ts` |
| [#13956](https://github.com/bryntum/support/issues/13956) `new TimelineContext` throws on a hover, also on Bryntum's realtime demo | Open | Seen here on 7.3.8 during `C7`, with nothing visible coming of it. `collectProblems` in `tests/e2e/plan.ts` leaves it out |

The forum search turned up nothing beyond these for revisions on 7.3: its realtime threads are mostly from 6.x. Several of the problems above have no report we could find, so they may be worth filing with a minimal case from the plain-Bryntum spec.

## After a Bryntum upgrade

1. Change the versions in `apps/web/package.json` and restart the dev server, which keeps serving its cached bundle until then.
2. Run `tests/e2e/bryntum-plain.spec.ts`. A failure means Bryntum changed: find the row above and try removing that workaround.
3. Run `tests/e2e/realtime.spec.ts` and `tests/e2e/library.spec.ts`.
