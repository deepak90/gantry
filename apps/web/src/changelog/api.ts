/**
 * Reads the revision log for the changelog: `project_revisions` rows after a revision_no, oldest
 * first, in pages (members may read them under RLS). Rows are validated like the sync layer's.
 */
import type { ProjectRevisionRow } from '@collab/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { asProjectRevisionRow, projectRevisionRowSchema } from '../supabase/schemas';

export const REVISION_PAGE_SIZE = 500;

export type RevisionReader = (afterRevisionNo: number) => Promise<ProjectRevisionRow[]>;

export function revisionReader(client: Pick<SupabaseClient, 'from'>, projectId: string, pageSize = REVISION_PAGE_SIZE): RevisionReader {
  return async (afterRevisionNo) => {
    const rows: ProjectRevisionRow[] = [];
    let after = afterRevisionNo;
    for (;;) {
      const { data, error } = await client
        .from('project_revisions')
        .select('*')
        .eq('project_id', projectId)
        .gt('revision_no', after)
        .order('revision_no', { ascending: true })
        .limit(pageSize);
      if (error) {
        throw new Error(`Cannot read the change history: ${error.message}`);
      }
      const parsed = projectRevisionRowSchema.array().safeParse(data ?? []);
      if (!parsed.success) {
        throw new Error(`The change history came back in an unexpected shape: ${parsed.error.message}`);
      }
      const page = parsed.data.map(asProjectRevisionRow);
      rows.push(...page);
      if (page.length < pageSize) return rows;
      after = page[page.length - 1]!.revision_no;
    }
  };
}
