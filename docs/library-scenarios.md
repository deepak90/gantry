# Library and realtime scenarios

Every way a library piece reaches the plan, and what happens when two people edit the same plan at the same moment. Each scenario runs in real browsers against the local backend, through the real UI. The ids below are the ones in the test titles.

- [`tests/e2e/library.spec.ts`](../tests/e2e/library.spec.ts): dragging, the drop card, what a piece lands next to, what happens after the drop, the library itself, and the assistant.
- [`tests/e2e/realtime.spec.ts`](../tests/e2e/realtime.spec.ts): two browsers on one plan, both writing. Every check ends the same way: both hold the same plan, row order, links and crews included, nothing reports out of sync, and a reload rebuilt from the server matches.

## Running them

```sh
pnpm exec playwright test tests/e2e/library.spec.ts --grep-invert @live
pnpm exec playwright test tests/e2e/realtime.spec.ts
```

Each scenario resets its project first, so no suite needs a clean database. Run them one at a time, because they share the local backend. Do not edit `apps/web/src` during a run: the dev server reloads both browsers and the results mean nothing.

`tests/e2e/bryntum-plain.spec.ts` is a third suite: what plain Bryntum does with none of our code in the path. [`docs/bryntum-workarounds.md`](bryntum-workarounds.md) says what each of those behaviors means for us.

The `@live` scenarios call the real model. They need `pnpm agent:dev` and `pnpm functions:serve`, and they cost money each run. Every other scenario answers the assistant's question from the spec, so it is repeatable and free.

The long sessions (`L11`, `L23`, `L37`) have both people work at random for 30 rounds from a fixed seed. The turns are attached to a failed run. Timing still varies between runs, so a failure can take a few repeats to come back: use `--repeat-each`.

## Library scenarios

### Dragging

| Id | Scenario | Result |
| --- | --- | --- |
| A1 | The hint and the line say where it lands, row by row | Pass |
| A2 | Letting go off the plan does nothing and leaves nothing behind | Pass |
| A3 | Esc during a drag calls it off | Pass |
| A4 | The chart side takes a drop like the grid side | Pass |
| A5 | A card let go on a folder is filed there, and the plan is left alone | Pass |
| A6 | The plan scrolls when a card is held near its edge | Pass |
| A7 | A plan that cannot be changed says so and takes no drop | Pass |
| A8 | A drop on a closed group goes at its end, and the group opens to show it | Pass |
| A9 | Grouped by crew: a generated row takes no drop, a real one does | Pass |
| A10 | With a search on: a piece with groups lands whole, for everyone, and Undo takes it all out | Pass |
| A11 | With a search on: the search comes back after the drop, Undo works, and the assistant is told about the whole group | Pass |
| A13 | With a search on: toolbar undo and redo keep the plan whole, for the server too | Pass |
| A12 | With a Show filter on: a drop lands whole too | Pass |

### The drop card

| Id | Scenario | Result |
| --- | --- | --- |
| B1 | It says where the assistant would put it, and nothing lands until that is pressed | Pass |
| B2 | Enter takes the assistant’s place: spliced between the two tasks, placed by links, and it says why | Pass |
| B3 | Push where it was let go: what waited for that task waits for the piece | Pass |
| B4 | Fit in: it follows the task, and nothing already in the plan moves | Pass |
| B5 | Run alongside: it starts when the task starts | Pass |
| B6 | Place it with no links: only its first task is pinned, and the note says so | Pass |
| B7 | A piece with groups, push: one heading over its tasks, tied in, and only what nothing leads to is pinned | Pass |
| B7 | A piece with groups, fit: one heading over its tasks, tied in, and only what nothing leads to is pinned | Pass |
| B7 | A piece with groups, alongside: one heading over its tasks, tied in, and only what nothing leads to is pinned | Pass |
| B7 | A piece with groups, unlinked: one heading over its tasks, tied in, and only what nothing leads to is pinned | Pass |
| B8 | Its tweaks reach the plan: name, how many, how long | Pass |
| B9 | Esc, the close button and a click elsewhere all cancel, cleanly | Pass |
| B10 | The assistant is down, or names a task elsewhere: the rules answer, and say it is them | Pass |
| B11 | The assistant is slow: the rules answer after 15 s, and an answer after a choice changes nothing | Pass |
| B12 | At the very top of the plan there is no group to ask about: just the ways, with numbers | Pass |
| B13 | Who does the work: an unknown crew is asked about, and the answer holds for the assistant’s place too | Pass |
| B14 | A second drag while the card is up replaces it, with no marks left behind | Pass |
| B15 | On a small window the card stays on screen and every way can be reached | Pass |
| B16 | The keyboard way: Add after the selected task opens the same card | Pass |
| B17 | Scrolling the plan under the card keeps the mark on the right task | Pass |
| B18 | The assistant’s place is brought into view when it is off screen | Pass |
| B19 | A drop while the last one is still saving is not swallowed | Pass |

### What the piece lands next to

| Id | Scenario | Result |
| --- | --- | --- |
| C1 | A task below with Start no earlier than still moves, and keeps its constraint | Pass |
| C2 | A task below with Must start on: the card says the push cannot work, before anyone presses it | Pass |
| C6 | A blind drop into a fixed date: cancelling the conflict leaves nothing behind | Pass |
| C7 | A blind drop into a fixed date: taking the constraint off lets the drop finish | Pass |
| C3 | A manually scheduled task below stays put, and the card and the note say what moved | Pass |
| C4 | Next to a split task, a milestone, a finished task | Pass |
| C5 | A push that would move a task PayPal is paying for is refused, plainly, and fitting in still works | Pass |
| C8 | The next floor would move a task PayPal is paying for: nothing lands, and it says why | Pass |

### After the drop

| Id | Scenario | Result |
| --- | --- | --- |
| D1 | The note’s Undo brings the plan back exactly, for everyone and after a reload | Pass |
| D2 | Toolbar undo takes the whole drop out in one step, and redo puts it back the same | Pass |
| D3 | The note does not offer to take out a piece the toolbar already took out | Pass |
| D4 | The toolbar can undo the note’s Undo, and nothing doubles | Pass |
| D5 | Undo after more work: a task of the piece deleted, a later task edited | Pass |
| D6 | It survives a reload: same rows, same links, no pins | Pass |
| D7 | A second person sees the drop and the undo live, and both plans agree | Pass |
| D12 | The second person has a search on: the drop reaches them whole, with no corrections | Pass |
| D8 | The same piece twice in one place: two runs, in order, each with its own Undo | Pass |
| D9 | The next floor follows the first without asking; once the first is undone it asks again | Pass |
| D10 | Show in the plan finds the piece from anywhere | Pass |
| D11 | The piece behaves as part of the plan: the work before it shrinks and it all comes back | Pass |

### The library itself

| Id | Scenario | Result |
| --- | --- | --- |
| E1 | Search by name, task and crew; nothing found says so | Pass |
| E2 | Folders: new, rename, nest, close (remembered), delete moves its cards up | Pass |
| E3 | A card’s menu: duplicate, rename, Esc keeps the name, delete asks and leaves the plan alone | Pass |
| E4 | Undo my changes puts a card’s tweaks back | Pass |
| E5 | Save from the plan: tasks picked in the plan become a card that drops back in | Pass |
| E6 | Save from the plan: the task menu, a whole group, a blank name, Esc | Pass |
| E11 | With a search on: saving a whole group keeps the tasks the search is hiding | Pass |
| E7 | The builder: a new piece from nothing, saved and dropped | Pass |
| E8 | The builder: edit an existing piece, unsaved changes ask, save as a copy; the plan is untouched | Pass |
| E9 | Two people: a saved card shows up for the other, a deleted one goes, even with it open | Pass |
| E10 | A piece with time ranges: its bands land with it and follow it | Pass |

### With the assistant (uses the live model)

| Id | Scenario | Result |
| --- | --- | --- |
| F1 | After a drop it asks to add it to the other floors, and one Apply does: one change, no pins, one undo, and the history says so | Live only |
| F2 | A piece that buys materials: the other floors leave the order out (it buys for the whole building) and keep their own delivery and work, with no link that only repeats the waterfall; said in plain words before Apply | Pass (live) |
| F3 | Find reusable work comes back with something that can be saved | Pass |

## Realtime scenarios

### Across a session

| Id | Scenario | Result |
| --- | --- | --- |
| Z | The sync badge never reported an error across a busy session of mixed edits | Pass |

### Add, change, delete

| Id | Scenario | Result |
| --- | --- | --- |
| R1 | A new task shows live, gets its name, and is one revision each | Pass |
| R2 | A subtask turns a task into a group on both sides | Pass |
| R3 | Deleting a task takes its links and crew with it; undo brings all of it back | Pass |
| R4 | Deleting a group takes its tasks; undo brings the whole group back | Pass |

### Bulk actions

| Id | Scenario | Result |
| --- | --- | --- |
| R5 | Deleting several tasks at once is one change for the other browser | Pass |
| R6 | Link in order and Remove links, several tasks at once | Pass |
| R7 | Clearing a block of Schedule cells is one change | Pass |
| R8 | Indenting several tasks at once | Pass |

### Indent, outdent, reorder

| Id | Scenario | Result |
| --- | --- | --- |
| R9 | Indent, then outdent, then undo twice: row order the same on both sides each time | Pass |
| R21 | Moving a task inside the task it waits for asks first; meanwhile the other person’s work is safe | Pass |
| R22 | The same question, answered by taking the link off: the move and the link reach the other browser | Pass |
| R10 | A row dragged within its group: same order on both sides | Pass |
| R11 | A row dragged into another group | Pass |
| R12 | Both reorder the same group at the same moment: one order, everywhere | Pass |

### Copy, cut, paste

| Id | Scenario | Result |
| --- | --- | --- |
| R13 | A copied group pastes with its tasks, links and crews on both sides | Pass |
| R14 | Cut and paste moves a task, keeping its id, links and crew | Pass |
| R15 | Cut in one browser while the other edits that task | Pass |
| R16 | Paste of several selected tasks | Pass |

### At the same moment

| Id | Scenario | Result |
| --- | --- | --- |
| R17 | One deletes a group while the other adds a task under it | Pass |
| R18 | Both rename one task | Pass |
| R19 | One indents a task while the other deletes the task above it | Pass |
| R20 | Both undo their own change, with the other’s still there | Pass |

### With a filter on

| Id | Scenario | Result |
| --- | --- | --- |
| F1 | Searching browser adds and renames: the other gets it, and the search stays | Pass |
| F2 | Deleting a group with hidden tasks removes them everywhere | Pass |
| F3 | Copying a group with hidden tasks pastes all of it | Pass |
| F4 | Cutting a group with hidden tasks moves all of it | Pass |
| F5 | Indenting and outdenting next to hidden tasks | Pass |
| F6 | Reordering while hidden tasks sit between the rows | Pass |
| F7 | Bulk delete with some of the group hidden | Pass |
| F12 | A task deleted under a search and undone after it: back in its own row, on both sides | Pass |
| F8 | The other browser is searching: every kind of change reaches it whole and it sends nothing | Pass |
| F9 | Both are searching for different things, and both edit | Pass |
| F10 | The other browser is grouped by crew: changes arrive, and the view stays | Pass |
| F11 | Editing from a grouped view: rename and delete reach the other browser | Pass |

### With an editor open

| Id | Scenario | Result |
| --- | --- | --- |
| E1 | The other person renames the task you are typing in: your Enter still lands, once | Pass |
| E2 | The other person deletes the task you are typing in: nothing breaks, and you can carry on | Pass |
| E3 | The other person moves the row you are typing in | Pass |
| E4 | The other person works on while your editor is open, then Esc: all their changes arrive | Pass |
| E5 | An open editor on the far side does not hold up your own saves | Pass |
| E6 | The dates editor is open when the other person deletes the task | Pass |
| E7 | The task panel is open when the other person deletes the task: it says so, and the panel recovers | Pass |
| E8 | Typing in the task panel while the other person changes the same task | Pass |
| E9 | The notes are open while the other person edits them: nobody’s words corrupt the task | Pass |
| E10 | Changes under an open crew tab show live | Pass |

### Snippets

| Id | Scenario | Result |
| --- | --- | --- |
| S1 | A drop reaches the other browser whole, in one revision | Pass |
| S2 | Both drop into the same group at the same moment: both land, in one order everywhere | Pass |
| S3 | The other person deletes the task the card is about: it says so, and nothing half lands | Pass |
| S4 | The other person deletes the task the assistant named: the card does not get stuck | Pass |
| S5 | Undo by the note, after the other person edited the piece and what follows it | Pass |
| S6 | The other person is typing in a row below when the drop pushes it | Pass |
| S7 | The other person deletes the card you are holding, or have just let go | Pass |
| S8 | The builder is open on a piece the other person deletes: Save does not lose the work silently | Pass |
| S9 | A drop with a search on in one browser and a group-by in the other | Pass |

### Crews

| Id | Scenario | Result |
| --- | --- | --- |
| C1 | A new crew shows in the other browser’s panel, and its name follows as it is typed in | Pass |
| C2 | A crew dragged onto a task shows live; undo takes it back | Pass |
| C3 | A crew dragged onto a task with a search on | Pass |
| C4 | One deletes a task while the other puts a crew on it | Pass |
| C5 | One removes a crew while the other puts it on a task | Pass |
| C6 | Removing a crew under an open crew tab and its bars | Pass |
| C7 | Renaming a crew reaches the bars and the panel of the other browser | Pass |
| C8 | A snippet asks who does the work; the firm picked is removed before pressing | Pass |

### Contention

| Id | Scenario | Result |
| --- | --- | --- |
| K1 | Both drag the same bar at the same moment | Pass |
| K2 | One drags a bar while the other deletes the task | Pass |
| K3 | One drags a bar while the other moves the row into the task above | Pass |
| K4 | Both set the same task’s start in the same cell | Pass |
| K5 | Two links that close a loop only together: no client is left with a loop or out of sync | Pass |
| K6 | A long loop through the existing chain, closed from both ends | Pass |
| K7 | A loop one person could make alone is refused, in plain words, and nothing is sent | Pass |
| K23 | One links two tasks while the other moves one inside the other | Pass |
| K24 | Moving a split task keeps its gap, on both sides | Pass |
| K26 | Pending changes that move split tasks are replayed under someone else's | Pass |
| K27 | Delete, undo, redo, undo while the server is slow: the task comes back whole, everywhere | Pass |
| K28 | Both link the same two tasks, one finish-to-start and one start-to-start: one link, everywhere | Pass |
| K29 | A task with a crew deleted, undone, redone and undone again: the crew comes back, everywhere | Pass |
| K30 | One moves a task out a level while the other adds a subtask under it, the mover reaching the server last | Pass |
| K30 | One moves a task out a level while the other adds a subtask under it, the adder reaching the server last | Pass |
| K31 | Both undo at the same moment, one undoing a delete, the first person's reaching the server last | Pass |
| K32 | One undoes a delete while the other pastes a copy of that group, the first person's reaching the server last | Pass |
| K31 | Both undo at the same moment, one undoing a delete, the second person's reaching the server last | Pass |
| K32 | One undoes a delete while the other pastes a copy of that group, the second person's reaching the server last | Pass |
| K33 | A menu action clicked in the turn the engine leaves for the screen, while someone else's change lands, reaches everyone | Pass |
| K33 | A menu action clicked in the turn the engine leaves for the screen, during its own recalculation, reaches everyone | Pass |
| K25 | Two people move two groups into each other: one move stands, nobody is out of sync | Pass |
| K8 | Both make the same link at once: one link, everywhere | Pass |
| K9 | Both put the same crew on one task: on it once, everywhere | Pass |
| K10 | One indents the task the other outdents | Pass |
| K11 | Both delete the same task, and overlapping selections | Known gap |
| K12 | One cuts a task the other deletes, then pastes | Pass |
| K13 | One pastes into a group the other has just deleted | Pass |
| K14 | One drags a row into a group the other is deleting | Pass |
| K15 | A snippet lands next to a row the other is moving | Pass |
| K16 | A snippet pushes a task the other is deleting | Pass |
| K17 | A snippet lands while the other renames, reschedules and links around it | Pass |
| K18 | Both drop onto each other’s freshly dropped work | Pass |
| K19 | Undo in one browser after the other has built on the change | Pass |
| K20 | Rapid fire on the same rows from both sides | Pass |
| K21 | One edits a cell while the other deletes the group holding it, and keeps typing elsewhere | Pass |
| K22 | A filtered browser and an unfiltered one fight over the same group | Pass |

### A long session

| Id | Scenario | Result |
| --- | --- | --- |
| L11 | Both people work at random for 30 rounds, and the plan holds | Pass |
| L23 | Both people work at random for 30 rounds, and the plan holds | Pass |
| L37 | Both people work at random for 30 rounds, and the plan holds | Pass |

## Problems found and fixed

### Dropping a piece

| What a person saw | Why | Fix | Scenarios |
| --- | --- | --- | --- |
| A piece with no groups landed at once, with no word from the assistant | Flat pieces took the shortcut meant for automatic placement | Only automatic placement skips the card now, and the assistant's place gets its own preview numbers | B1, B2, B16 |
| Dropped rows carried a "Start no earlier than" pin | The Gantt pins a new row where it is first drawn, and clearing the pin before the first commit does not stick | `unpin` clears it in a second step of the same change, so links place the row | B2–B7, D6 |
| After a drop, rows ignored the mouse for over 6 seconds | The Gantt waits for every finite CSS animation in the grid and blocks the pointer until they end. The "was here" mark was a 6-second animation | The mark's animation is now infinite and a timer removes it, so the Gantt does not wait for it | B19 |
| A second drop while the first was saving vanished | The drop was dropped while the library was busy | The card waits until the library is free, then opens | B19 |
| The note kept offering Undo after the toolbar had taken the piece out | The note was not watching the plan | The note follows the plan and closes when it goes stale, after a short wait so a redo does not close it | D3, D4 |
| The drop card ran off a small window | It had no height limit | It now scrolls within the window | B15 |
| The assistant's place was off screen with no sign of it | Nothing scrolled to it | The row is brought into view and marked, and the mark follows scrolling | B17, B18 |
| A push into a fixed date looked fine until it failed | The preview did not report the engine's refusal | The card names the clash and disables that option. A refused drop changes nothing and says so | C2, C6, C7 |
| With a search or filter on, a group landed without its hidden tasks, and that browser went out of sync | While a tree store is filtered, Bryntum walks only the rows the filter shows, so a revision's input lost the hidden tasks | `withoutFilters` (`gantt/filters.ts`) runs the change on the whole plan and puts the filters back afterward | A10–A13, D12, E11 |
| The same session threw "Method cannot be called at this state" | The watch list committed outside the project queue while a revision was being applied | Its commit goes through the queue, and re-filtering waits for the lift to end (`whenFiltersBack`) | A11, A12 |
| Toolbar undo under a search left a partial plan | Undo ran on the filtered tree | Undo and redo also run through `withoutFilters` | A13 |
| A drop or an assistant edit could move a task PayPal was paying for | The lock only stops what a person changes directly, and a push is what the schedule moved | The change is tried on a copy first. If it would move a locked task, the card names the task and disables that option, and nothing lands. Fitting in, which moves nothing, stays available | C5, C8 |
| A piece dropped on one floor had to be offered, then applied, on each of the others | The assistant found the matching places, but left them on a card to press | One card offers them all, and the assistant asks whether to add the piece there too: the other places are its idea, so a person says yes. One Apply adds them as one change: one revision, one undo, one entry in History. The handover isn't watched on the way: a watch rule raises it if it matters | F1 |

### Two people on one plan

| What a person saw | Why | Fix | Scenarios |
| --- | --- | --- | --- |
| After a copy and paste in a two-person session, whole groups read "Not scheduled" | Bryntum's row paste pauses the project queue in a feature transaction and races the revisions coming back. Alone it is fine. With both people writing, every long session lost dates by its sixth round, and those rolled up | `gantt/task-clipboard.ts` does the copy itself in one project transaction: one revision, all or nothing | R13–R16, F3, F4, L11, L23, L37 |
| A white screen partway through a paste | The engine reports a task as split before its pieces exist, and the percent bar reads them | `guardSplitReads` makes that read safe | R13, R16 |
| Pasting next to a task someone had just removed wiped that person's plan | The paste went ahead relative to a removed record | Target checks with plain errors, and the task menu closes when its task goes | K12, K13 |
| Moving a split task's start closed its gap, and the two browsers disagreed (6 days against 17) | The schedule editor always sent the finish date, which squeezed the pieces | `ScheduleDraft.finishSet`: the finish is sent only when the person set it | K24 |
| The same link or crew added by two people at once ended up on the plan twice | Bryntum keeps both copies | `duplicatesOf` drops the later one, in server order, on every client | K8, K9, K28 |
| Two people reordering one group ended up with different orders, or a second "correction" repeated the wrong one | A pending move redone over someone else's is ranked by when it arrived, which differs per client | `settleOwnOrder` and `byTaskId` rank both clients the same way, and only for revisions that carry input | R12, S2, K18 |
| Two people moved two groups into each other, and one browser crashed with a stack overflow | Redoing a pending move put a task under itself | `CollabTask.insertChild` refuses that during a redo, and `reconcileInput` refuses it for remote input. The first move to reach the server stands | K25 |
| A browser went out of sync for good during ordinary work, about one session in six. Elsewhere, a "Scheduling cycle" pop-up named one task as a loop with itself and offered no link to choose | Replaying a pending change that moved a split task proposes its end date again. The engine then reads each piece's duration from its offsets and its offsets from its duration, and reports a cycle with no link in it. Bryntum's revision handler throws on that, and at other times its pop-up opens. Our `recordsSplitWrite` exposes this: it stops split tasks collapsing under revisions, which plain Bryntum does | `settleSplitCycle` answers the engine's cycle hook, and proposes the same end with "keep the duration" | C4, K26, L23 |
| Moving a task out a level opened the "Scheduling cycle" dialog, which held that person's changes | By default Bryntum also moves the tasks below it under it, which closes a loop when it leads to them | `outdentIgnoringSiblings`, as in Bryntum's realtime demo: only that task moves | K30 |
| A delete made just as someone else's change landed stayed in one browser: the other kept the task for good | The engine marks what was recorded as the person's, gives the screen a turn to draw, writes its results, and marks whatever is unmarked as calculated. Other clients skip a revision with no input. Bryntum's menu items write to the store as soon as they are clicked, so a click in that turn counted as calculated, or was recorded inside the revision being applied | `suspendChangeTracking` marks it as input at the end of that turn, and `gantt/menu-actions.ts` runs the task menu's actions through the project queue, as everything else here already does | K33, Z |
| Deleting a group under a filter left its hidden tasks behind | The same filtered tree walk | `CollabTaskStore.remove` lifts the filters until the change is saved | F2, F7 |
| The task panel stayed on a task someone else had removed | The selection cleared and the panel lost track | It keeps the id and says the task is no longer in the plan | E2, E7 |
| The card stuck, or half a piece landed, after someone removed the target | Nothing rechecked the target at the moment of choosing | The card closes and says so, and nothing lands | S3, S4 |
| Save in the builder lost the work if someone had deleted that piece | The update matched no rows and reported success | Zero rows updated now falls through to an insert | S8 |

## Known gaps

| Gap | What happens | Why it is still open |
| --- | --- | --- |
| Deletes that cross and empty a group (`K11`) | The group's own dates can differ between browsers until a reload. The tasks themselves agree | Plain Bryntum does the same. Cosmetic and self-healing, and the long sessions leave this one difference out of their comparison |
| Two links that close a loop only together | Both stay in the plan and the later one is switched off, alike on every client. Nobody is told | This is Bryntum's own answer, and inactive links are a normal part of the plan. A note to the person who made it would be a small addition |
| Other changes that ripple into a task PayPal is paying for | Lengthening a task before it, or dragging a bar, still moves it. Library drops and the assistant's edits are refused (`C5`, `C8`), but these are not | The database's lock only checks what a person changed, not what the schedule moved. Refusing these too is a product decision |
| Deleting a task in the middle of a chain | What followed it goes to the project start, because nothing leads to it now | This is how the links work. Bridging the gap would be a product decision |
| The "Scheduling cycle" and conflict pop-ups | While one is open, that person's incoming changes wait. They arrive once it is answered | Bryntum holds the project queue for the answer |
| A task added under a search | It disappears as soon as it is added if its name does not match | The search is doing what it says, but it can surprise people |
| Filters lifted for a change | The rows can flicker briefly | The cost of running the change on the whole plan |
