import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { RevisionSupabaseClient } from '../../src/sync/supabase-transport';
import type { AuthClient } from '../../src/supabase/auth';
import type { ProjectClient } from '../../src/supabase/project';
import type { SessionsClient } from '../../src/supabase/session';

describe('the real SupabaseClient satisfies the structural client interfaces', () => {
  it('type-checks against every slice the app uses', () => {
    const real = createClient('http://127.0.0.1:54321', 'anon-key');
    const transportClient: RevisionSupabaseClient = real;
    const authClient: AuthClient = real;
    const sessionsClient: SessionsClient = real;
    const projectClient: ProjectClient = real;
    expect(transportClient).toBe(real);
    expect(authClient).toBe(real);
    expect(sessionsClient).toBe(real);
    expect(projectClient).toBe(real);
  });
});
