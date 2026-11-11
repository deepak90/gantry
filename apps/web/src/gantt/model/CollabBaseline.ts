import { Baseline } from '@bryntum/gantt';
import type { ModelFieldConfig } from '@bryntum/gantt';
import { TZ_LESS_DATE_FIELDS } from './date-format';

/** Baselines are serialized inside each task row (`baselines[]`), so their dates follow the same rule. */
export class CollabBaseline extends Baseline {
  static override $name = 'CollabBaseline';

  static override fields: ModelFieldConfig[] = [...TZ_LESS_DATE_FIELDS];
}
