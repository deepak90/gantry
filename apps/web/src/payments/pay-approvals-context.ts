/**
 * What the payment windows need from the session: who is signed in, everyone on the project (their names, whether
 * they see costs, their approval limits), the project's two-person threshold and its approvals as the workflow snapshot
 * last read them (live: every change is broadcast on the workflow topic), and the client for the calls. Provided by
 * the workspace (app/Workspace.tsx).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MemberRole, PayoutSigner } from '@collab/shared';
import { createContext, useContext } from 'react';
import type { PayGateApprovalRow } from './pay-approvals';

/** A member as the payment windows show them: what the two-person rule reads, and their role on the project if known. */
export type PayPerson = PayoutSigner & { role?: MemberRole };

export interface PayApprovalsValue {
  client: SupabaseClient;
  projectId: string;
  userId: string;
  people: PayPerson[];
  /** The project's threshold; null where it can't be read (the default applies). */
  overMinor: number | null;
  /** The project's approvals; null where the database has none yet (its migration is not applied). */
  approvals: PayGateApprovalRow[] | null;
  /** Re-reads the approvals now (after a call, before the broadcast arrives). */
  reload(): void;
}

const Context = createContext<PayApprovalsValue | null>(null);

export const PayApprovalsProvider = Context.Provider;

export function usePayApprovals(): PayApprovalsValue | null {
  return useContext(Context);
}

/** A person's name as the project knows it. */
export function nameOf(people: readonly PayoutSigner[], userId: string | null | undefined, fallback = 'Someone'): string {
  return people.find((person) => person.userId === userId)?.name ?? fallback;
}

/** Each role's title on an approval line (`cm` is the cost manager, the role that pays: app/Workspace.tsx). */
/**
 * A person as an approval names them: by name. A member's role is what they may see ('cm' sees costs), not a job
 * title, so it is never shown as one (Chris, the project manager, sees costs to approve: "Cost Manager" would be wrong).
 */
export function nameAndTitle(person: PayPerson): string {
  return person.name;
}

/** First names joined for a sentence: "Chris", "Chris or Ana". */
export function firstNames(people: readonly PayoutSigner[]): string {
  const names = people.map((person) => person.name.split(' ')[0] ?? person.name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : (names[0] ?? '');
}
