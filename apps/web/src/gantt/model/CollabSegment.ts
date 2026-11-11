import { EventSegmentModel } from '@bryntum/gantt';
import type { ModelFieldConfig, TaskModel } from '@bryntum/gantt';
import { recordsSplitWrite } from '../revisions/split-tasks';
import { TZ_LESS_DATE_FIELDS } from './date-format';

/**
 * Pieces of a split task. The engine reports a split as the task's `segments` field, so segment
 * dates travel in revisions and snapshots exactly like task dates and need the same format.
 */
export class CollabSegment extends EventSegmentModel {
  static override $name = 'CollabSegment';

  static override fields: ModelFieldConfig[] = [...TZ_LESS_DATE_FIELDS];

  /** The engine's own segment moves are not recorded; see `recordsSplitWrite`. */
  shouldRecordFieldChange(fieldName: string, oldValue: unknown, newValue: unknown): boolean {
    const task = (this as unknown as { event?: TaskModel }).event;
    if (task && !recordsSplitWrite(task)) {
      return false;
    }
    return (EventSegmentModel.prototype as unknown as RecordFilter).shouldRecordFieldChange.call(this, fieldName, oldValue, newValue);
  }
}

export interface RecordFilter {
  shouldRecordFieldChange(this: unknown, fieldName: string, oldValue: unknown, newValue: unknown): boolean;
}
