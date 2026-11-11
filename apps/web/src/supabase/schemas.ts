import type { LoadProjectResult, ProjectRevisionRow } from '@collab/shared';
import { z } from 'zod';

const recordSchema = z.record(z.string(), z.unknown());

const storeInputChangeSchema = z.looseObject({
  added: z.array(recordSchema).optional(),
  updated: z.array(recordSchema).optional(),
  removed: z.array(recordSchema).optional(),
});

export const storeChangesSchema = storeInputChangeSchema.extend({
  $input: storeInputChangeSchema.optional(),
});

export const changesInfoSchema = z.record(z.string(), storeChangesSchema);

export const revisionOriginSchema = z.enum(['human', 'agent', 'engine']);

/** One `project_revisions` row as returned by `submit_revision`, `load_project`, a select or a broadcast. */
export const projectRevisionRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  revision_no: z.number().int(),
  client_id: z.string(),
  local_revision_id: z.string(),
  conflict_resolution_for: z.string().nullable(),
  changes: changesInfoSchema,
  actor_user_id: z.string().nullable(),
  origin: revisionOriginSchema,
  created_at: z.string(),
});

export const projectInlineDataSchema = z.looseObject({
  project: recordSchema.optional(),
  calendarsData: z.array(z.unknown()).optional(),
  tasksData: z.array(z.unknown()),
  dependenciesData: z.array(z.unknown()).optional(),
  resourcesData: z.array(z.unknown()).optional(),
  assignmentsData: z.array(z.unknown()).optional(),
});

export const loadProjectResultSchema = z.object({
  project: z.object({
    id: z.string(),
    name: z.string(),
    currency: z.string(),
    handover_task_id: z.union([z.string(), z.number().transform(String)]).nullable(),
  }),
  membership: z.object({
    role: z.enum(['pm', 'cm']),
    can_view_costs: z.boolean(),
    approval_limit_minor: z.number().int(),
  }),
  snapshot: projectInlineDataSchema,
  snapshot_revision: z.number().int(),
  current_revision: z.number().int(),
  revisions: z.array(projectRevisionRowSchema),
});

export type ParsedProjectRevisionRow = z.infer<typeof projectRevisionRowSchema>;
export type ParsedLoadProjectResult = z.infer<typeof loadProjectResultSchema>;

/**
 * zod infers the per-store change rows as plain records while the shared contract spells `removed`
 * entries as `{ id: unknown }`. Validation has already run; these only reconcile the two spellings.
 */
export function asProjectRevisionRow(parsed: ParsedProjectRevisionRow): ProjectRevisionRow {
  return parsed as ProjectRevisionRow;
}

export function asLoadProjectResult(parsed: ParsedLoadProjectResult): LoadProjectResult {
  return parsed as LoadProjectResult;
}
