import type { SupabaseClient } from '@supabase/supabase-js';
import { createProjectModel, toInlineDataPackage } from '../gantt/project';
import { withLocalPeers } from '../presence/local-peers';
import { fallbackColor } from '../presence/peers';
import { PresenceSession } from '../presence/session';
import { SupabasePresenceTransport, asPresenceClient } from '../presence/supabase-presence';
import { SupabaseTransport } from '../sync/supabase-transport';
import { loadProfile } from '../supabase/profile';
import { listProjects, loadProject } from '../supabase/project';
import { registerSession } from '../supabase/session';
import type { ProjectSessionDeps, ViewerProfile } from './project-session';

export interface SignedInUser {
  id: string;
  email?: string;
}

export const NO_PROJECT_MESSAGE =
  'No project is visible to this account. Ask someone on a project to add you.';

/** The real boot steps: sessions row, load_project, shared ProjectModel, Realtime transport. */
export function supabaseProjectSessionDeps(client: SupabaseClient, user: SignedInUser, projectId?: string): ProjectSessionDeps {
  return {
    async resolveProjectId() {
      const projects = await listProjects(client);
      // A link (or a remembered project) this person is not in opens their first project instead.
      if (projectId && projects.some((entry) => entry.id === projectId)) {
        return projectId;
      }
      const first = projects.find((entry) => entry.listed) ?? projects[0];
      if (!first) {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      return first.id;
    },
    registerSession: (id) => registerSession(client, id),
    loadProject: (id) => loadProject(client, id),
    async loadProfile(): Promise<ViewerProfile> {
      const profile = await loadProfile(client, user.id);
      return profile ?? { displayName: user.email ?? 'Signed-in user', color: null };
    },
    createProject: () => createProjectModel(),
    createTransport: (id) => new SupabaseTransport(client, id),
    prepareSnapshot: toInlineDataPackage,
    createPresence: ({ projectId: id, sessionId, userId, role, profile }) =>
      new PresenceSession({
        self: { session: sessionId, user: userId, name: profile.displayName, color: profile.color ?? fallbackColor(userId), role },
        // With this page's own people beside the real channel (simulated teammates, crowd/in-page-team.ts).
        transport: withLocalPeers(new SupabasePresenceTransport(asPresenceClient(client), id, sessionId), sessionId),
      }),
  };
}
