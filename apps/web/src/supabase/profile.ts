import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

/** The slice of `SupabaseClient` used to read a profile; small enough to fake in tests. */
export interface ProfilesClient {
  /** The real method type: a structural copy of the PostgREST builder chain is too deep for the compiler to compare. */
  from: SupabaseClient['from'];
}

export interface Profile {
  displayName: string;
  color: string;
}

const profileRowSchema = z.object({ display_name: z.string(), color: z.string() }).nullable();

/** The viewer's own `profiles` row, for display only: roles and permissions come from the membership. */
export async function loadProfile(client: ProfilesClient, userId: string): Promise<Profile | null> {
  const { data, error } = await client.from('profiles').select('display_name, color').eq('user_id', userId).maybeSingle();
  if (error) {
    throw new Error(`Cannot read the profile: ${error.message}`);
  }
  const parsed = profileRowSchema.safeParse(data ?? null);
  if (!parsed.success) {
    throw new Error(`profiles returned an unexpected shape:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data ? { displayName: parsed.data.display_name, color: parsed.data.color } : null;
}
