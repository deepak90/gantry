import { ResourceModel } from '@bryntum/gantt';
import type { ModelFieldConfig } from '@bryntum/gantt';
import { safeColor, safeImageUrl } from './safe-fields';

export const RESOURCE_KINDS = ['labor', 'equipment'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === 'string' && (RESOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * A crew (or a piece of equipment). Bryntum's ResourceModel already owns an engine field named
 * `type` ('work' | 'material' | 'cost'), so the labor/equipment split lives in `kind`. People and
 * equipment are both 'work' resources to the scheduling engine. The crew color and icon use
 * Bryntum's own `eventColor` and `iconCls` fields, which its avatars and histogram already read.
 * The color and the logo (`imageUrl`) are checked as they load (safe-fields.ts): a color that isn't one,
 * or a logo from anywhere but this site, reads as not set.
 */
export class CollabResource extends ResourceModel {
  static override $name = 'CollabResource';

  static override fields: ModelFieldConfig[] = [
    { name: 'eventColor', convert: safeColor },
    { name: 'imageUrl', convert: safeImageUrl },
    { name: 'kind', type: 'string', defaultValue: 'labor' },
    // The firm that supplies the crew or rents out the equipment.
    { name: 'company', type: 'string', defaultValue: '' },
    // What the crew does (Electrical, HVAC …) or what kind of equipment it is: a label, since a big site
    // has several crews of one trade. Snippets from the library find their crews by it.
    { name: 'trade', type: 'string', defaultValue: '' },
  ];

  declare kind: ResourceKind;
  declare company: string;
  declare trade: string;
}
