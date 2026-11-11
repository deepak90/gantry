/**
 * What people decided about the assistant's drafted changes, as changelog entries: applied by hand,
 * applied by itself under the person's approval mode, or declined. A declined change made no revision,
 * so this is the only trace of it; an applied one also shows as its revision. The rows come from
 * `agent_edit_decisions` (written by the database from the stored card), so every member reads the
 * same entries and deleting the thread they were made in does not remove them.
 */
import type { AgentEditDecisionRow } from '@collab/shared';
import type { ActionData, ChangelogEntry } from './model';
import { ASSISTANT_NAME, REMY_SPARK_GLYPH } from '../assistant/identity';

const WORDS: Readonly<Record<AgentEditDecisionRow['decision'], { verb: string; icon: string; tone: ChangelogEntry['tone'] }>> = {
  applied: { verb: `applied ${ASSISTANT_NAME}’s change`, icon: 'fa fa-circle-check', tone: 'assistant' },
  auto_applied: { verb: `let ${ASSISTANT_NAME} apply`, icon: REMY_SPARK_GLYPH, tone: 'assistant' },
  declined: { verb: `declined ${ASSISTANT_NAME}’s change`, icon: 'fa fa-circle-minus', tone: 'warn' },
};

const MAX_LINES = 4;

export function decisionEntries(rows: readonly AgentEditDecisionRow[]): ChangelogEntry[] {
  return rows.map((row) => {
    const words = WORDS[row.decision];
    const lines = row.lines.slice(0, MAX_LINES);
    const more = row.lines.length > MAX_LINES ? ` (+${row.lines.length - MAX_LINES} more)` : '';
    const actions: ActionData[] = [];
    return {
      id: `ag-${row.id}`,
      occurredAt: row.created_at,
      kind: 'plan',
      tone: words.tone,
      icon: words.icon,
      actor: { type: 'member', userId: row.decided_by },
      parts: [`${words.verb} `, { name: row.title }],
      ...(lines.length ? { note: `${row.decision === 'declined' ? 'Not made: ' : ''}${lines.join('; ')}${more}` } : {}),
      actions,
    };
  });
}
