import type { LoadProjectResult } from '@collab/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { asLoadProjectResult, loadProjectResultSchema } from './schemas';

export interface RpcErrorLike {
  message: string;
  code?: string;
}

/** The slice of `SupabaseClient` used to load a project; small enough to fake in tests. */
export interface ProjectClient {
  rpc(fn: string, args?: object): PromiseLike<{ data: unknown; error: RpcErrorLike | null }>;
}

/** `load_project(p_project)`, validated against the shared contract. */
export async function loadProject(client: ProjectClient, projectId: string): Promise<LoadProjectResult> {
  const { data, error } = await client.rpc('load_project', { p_project: projectId });
  if (error) {
    throw new Error(`load_project failed${error.code ? ` (${error.code})` : ''}: ${error.message}`);
  }
  const parsed = loadProjectResultSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`load_project returned an unexpected shape:\n${z.prettifyError(parsed.error)}`);
  }
  return asLoadProjectResult(parsed.data);
}

/** The slice of `SupabaseClient` used to list projects; small enough to fake in tests. */
export interface ProjectsTableClient {
  /** The real method type: a structural copy of the PostgREST builder chain is too deep for the compiler to compare. */
  from: SupabaseClient['from'];
}

export interface ProjectListEntry {
  id: string;
  name: string;
  /** False: not offered in the project menu or opened by default; a link still opens it. */
  listed: boolean;
  /** The demo the project plays: 'harbor' (Harbor Street Offices and a visitor's private copy of it), 'cedar'; null for any other. */
  template: string | null;
}

const projectListSchema = z.array(
  z.object({ id: z.string(), name: z.string(), listed: z.boolean().default(true), template: z.string().nullable().default(null) }),
);

/**
 * Whether a project opens as a demo, on the plan alone with its steps: one the menu offers, or one that plays a demo
 * without being offered (Cedar Park by its link, a visitor's copy of Harbor on the hosted demo).
 */
export function opensAsDemo(entry: Pick<ProjectListEntry, 'listed' | 'template'>): boolean {
  return entry.listed || entry.template !== null;
}

/** The projects the signed-in user is a member of (RLS filters the table), oldest first. */
export async function listProjects(client: ProjectsTableClient): Promise<ProjectListEntry[]> {
  const { data, error } = await client.from('projects').select('id, name, listed, template').order('created_at', { ascending: true });
  if (error) {
    throw new Error(`Cannot list projects: ${error.message}`);
  }
  const parsed = projectListSchema.safeParse(data ?? []);
  if (!parsed.success) {
    throw new Error(`projects returned an unexpected shape:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
