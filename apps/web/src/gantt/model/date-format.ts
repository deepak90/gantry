import type { ModelFieldConfig } from '@bryntum/gantt';

/**
 * Every date that leaves a client travels without timezone information: task, baseline and
 * project dates alike. A date serialized with the browser's UTC offset is a different instant for
 * a client in another zone, whose engine then recalculates and sends a corrective revision (Gantt
 * guide "Revisions / Timezones Support", protocol guide "Possible Message Storm"). The project's
 * own calculated endDate rides along in most revisions, so it needs the format as much as tasks.
 */
export const COLLAB_DATE_FORMAT = 'YYYY-MM-DDTHH:mm:ss';

export const TZ_LESS_DATE_FIELDS: ModelFieldConfig[] = [
  { name: 'startDate', type: 'date', format: COLLAB_DATE_FORMAT },
  { name: 'endDate', type: 'date', format: COLLAB_DATE_FORMAT },
];
