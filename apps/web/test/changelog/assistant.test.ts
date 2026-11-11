/**
 * The assistant's drafted changes in the changelog: applied by hand, applied by itself, declined
 * (the only trace a declined change leaves), each named after the card and its first lines.
 */
import { describe, expect, it } from 'vitest';
import type { AgentEditDecisionRow } from '@collab/shared';
import { decisionEntries } from '../../src/changelog/assistant';
import { REMY_SPARK_GLYPH } from '../../src/assistant/identity';

const row = (decision: AgentEditDecisionRow['decision'], lines: string[] = ['Link A to B']): AgentEditDecisionRow => ({
  id: `00000000-0000-4000-8000-00000000d00${decision.length}`,
  project_id: '00000000-0000-4000-8000-000000000001',
  thread_id: null,
  card_id: `card-${decision}`,
  message_id: null,
  decision,
  decided_by: '00000000-0000-4000-8000-000000000011',
  title: 'Link the pours',
  lines,
  created_at: '2026-11-10T14:00:00+00:00',
});

describe('decisionEntries', () => {
  it('says who decided what about which change', () => {
    const [applied, auto, declined] = decisionEntries([row('applied'), row('auto_applied'), row('declined', ['a', 'b', 'c', 'd', 'e'])]);
    expect(applied).toMatchObject({ kind: 'plan', tone: 'assistant', actor: { type: 'member', userId: '00000000-0000-4000-8000-000000000011' }, parts: ['applied Remy’s change ', { name: 'Link the pours' }] });
    expect(auto!.parts[0]).toBe('let Remy apply ');
    expect(auto!.icon).toBe(REMY_SPARK_GLYPH);
    expect(declined).toMatchObject({ tone: 'warn', icon: 'fa fa-circle-minus', note: 'Not made: a; b; c; d (+1 more)' });
    expect(new Set([applied!.id, auto!.id, declined!.id]).size).toBe(3);
  });
});
