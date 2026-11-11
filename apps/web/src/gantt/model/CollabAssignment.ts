import { AssignmentModel } from '@bryntum/gantt';
import type { ModelFieldConfig } from '@bryntum/gantt';
import type { DateOnly } from '@collab/shared';

/**
 * A crew or machine on a task. A machine has its own dates on each task, `YYYY-MM-DD`, the end exclusive;
 * with none it goes by the task's days. They live in the plan so a change is a revision, undone and
 * redone like any other; the database copies them to the rental booked on that task, if there is one.
 */
export class CollabAssignment extends AssignmentModel {
  static override $name = 'CollabAssignment';

  // Null, not undefined: undoing the first dates must reach everyone, and a revision is JSON.
  static override fields: ModelFieldConfig[] = [
    { name: 'rentalStart', defaultValue: null },
    { name: 'rentalEnd', defaultValue: null },
    // How many people the crew has on this task. A plan that has not said counts the usual crew (crewSizeOf).
    { name: 'headcount', defaultValue: null },
  ];

  declare rentalStart: DateOnly | null;
  declare rentalEnd: DateOnly | null;
  declare headcount: number | null;
}
