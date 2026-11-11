# Bar language: what a Gantt bar can say besides "from here to there"

A Gantt bar has one job it does well: start, finish and length. Everything else people need to
know about a task usually ends up as text crowded beside the bar. This note covers which
conditions can be carried by the bar itself (its fill, shape, size, depth, edges, texture and
motion), which should not, and what the app draws.

The rule we kept to: **one channel per question, one meaning per channel, and never color
alone.** Color is already spent on "which phase" (or "which crew", from the View menu), so
status, kind of work and risk had to use other channels.

## Conditions → channel → why

| Condition | Channel | What it looks like | Why this channel |
| --- | --- | --- | --- |
| Not started | Fill (none) | Ghost: pale tint, thin outline in the phase color, dark text | An outline reads as "planned, not real yet". Most of a plan is future work; drawing it light keeps the chart calm. |
| In progress | Fill + depth | Solid and raised (shadow), the part already done darker, a bright line where the work has reached | The present is what people act on, so it gets the most visual weight. Depth (3D) is only used for "happening now". |
| Done | Fill + depth + icon | Flat, grayed, quiet, a check mark instead of the crew icon | History recedes; it is still there for context but does not compete. The check mark makes "done" readable without color. |
| Late against the plan | Texture + edge | The days after the planned finish are hatched red, the bar ends in a red cap; a "3d late" pill beside it | Hatching means "lost" everywhere in the app (the idle crane band uses it too). The hatched length is the slip itself, so the size of the problem is visible at a glance. |
| On the critical path | Edge | A heavy keel along the bottom; ghosts get a full-strength outline | "Load-bearing": a day lost here moves the handover. An edge is quiet enough to sit on a third of the bars without shouting. The toolbar's critical path mode still fades everything else. |
| Inspection / hold point / test | Shape | Hexagon ends (beveled corners) | A check is a gate the next work waits behind. Shape is the strongest channel after color and is free here. |
| Rented equipment | Shape + icon | Capsule (fully rounded) led by the machine's icon in a white disc | Rented equipment is paid by the day, which is the whole story of the crane. A different silhouette makes every rental easy to spot. |
| Split task | Shape | Separate parts joined by a dashed thread | The gap is not work; a thread says "same task, paused". |
| Money moving at PayPal | Motion + edge | A PayPal-blue ring that breathes until PayPal answers | Motion is reserved for things that change on their own, outside the plan. Only one task at a time is ever in this state, so it cannot become noise. |
| A rental's payment | Label, and the hover card | One pill beside the bar: "Pending payment · $4,200", "Processing", "Paid $4,200", or what failed. Nothing before the payment | One pill says where the money is; earlier steps would add marks without adding information. |
| Phase / work package | Shape + size | Brackets over their tasks; a phase is thicker than a work package | Summary bars contain work rather than being work; the bracket says "these belong together". |
| Idle rental days | Texture (range) | Hatched red band before the task, with "4d idle · $2,400" | Same "lost" texture as a slip, so the two read alike. |

## What we deliberately did not encode

- **Crew as shape or position.** There are a dozen crews; shapes cannot carry that many values,
  and crews already have color (when coloring by crew), the Crew column badges and the hover
  card. The crew names that used to sit beside every bar are gone for the same reason.
- **Cost as bar height or thickness.** Height reads as importance or duration, rows have a fixed
  height, and money is visible to the cost manager only. Over-budget tasks get a "+$5.5K over"
  pill beside the bar instead (cost viewers only).
- **Percent done as opacity.** Faded bars look disabled; the darker done part is clearer.
- **3D for everything.** Depth on every bar is just decoration; only work in progress is raised.
- **Animation for static states.** Late or critical work does not move; a moving chart is tiring
  and hides what actually changes. Motion is for money in flight and the tracker's current step.
- **More than two edge treatments on one bar.** A bar can be critical and late, but status,
  shape and edge never fight for the same channel.

## Accessibility

- Never color alone: every encoding has words somewhere. Status is in the hover card and the
  Schedule column; late and over budget are pills with text; checks, rented equipment and
  critical work are named in the hover card; the tracker's step names are in the DOM for screen
  readers and in its tooltip.
- Text contrast is 4.5:1 or better: white text only on the solid phase colors (700 shades),
  dark text on ghosts and done bars, a crew color too light for white text switches the bar to
  dark ink, and pills use a darker ink of their tone.
- `prefers-reduced-motion` stops the shimmer, the pulse and the breathing ring; the PayPal ring
  stays as a static edge.

## Where it lives

- `apps/web/src/gantt/look.ts`: `barLook` decides the classes for a bar, `renderTracker` draws
  the pill, `renderTaskTooltip` the hover card.
- `apps/web/src/styles/gantt.css`: "Timeline: the bar language" and "A fix's payment".
- `apps/web/src/workflow/decorations.ts`: `buildTracker` maps the workflow tables to the six steps.
