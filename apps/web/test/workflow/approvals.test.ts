/**
 * "Approve the fix" writes two approval rows (the dates, then the payment); people gave one approval.
 * The history, the "no longer counts" notes and the notices count it once.
 */
import { describe, expect, it } from 'vitest';
import type { ApprovalRow } from '@collab/shared';
import { groupApprovals, invalidatedWords } from '../../src/workflow/model';

const row = (scope: ApprovalRow['scope'], at: string, overrides: Partial<ApprovalRow> = {}): ApprovalRow =>
  ({
    id: `${scope}-${at}`,
    project_id: 'p',
    proposal_version_id: 'v1',
    approver_id: 'priya',
    scope,
    content_hash: 'h',
    amount_minor: scope === 'payment' ? 360_000 : null,
    currency: scope === 'payment' ? 'USD' : null,
    recipient: scope === 'payment' ? 'payouts@northgate.example' : null,
    source_revision: 3,
    status: 'active',
    invalidated_reason: null,
    created_at: at,
    invalidated_at: null,
    ...overrides,
  }) as ApprovalRow;

describe('groupApprovals', () => {
  it('reads the two rows of one "Approve the fix" as one approval, with its amount', () => {
    const groups = groupApprovals([row('payment', '2026-11-10T10:00:00.400Z'), row('schedule', '2026-11-10T10:00:00.100Z')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ approver_id: 'priya', scopes: ['schedule', 'payment'], amount_minor: 360_000, status: 'active' });
  });

  it('keeps apart approvals by other people, of other versions, or given far apart', () => {
    expect(groupApprovals([row('schedule', '2026-11-10T10:00:00Z'), row('payment', '2026-11-10T10:00:01Z', { approver_id: 'chris' })])).toHaveLength(2);
    expect(groupApprovals([row('schedule', '2026-11-10T10:00:00Z'), row('payment', '2026-11-10T10:00:01Z', { proposal_version_id: 'v2' })])).toHaveLength(2);
    expect(groupApprovals([row('schedule', '2026-11-10T10:00:00Z'), row('payment', '2026-11-10T10:05:00Z')])).toHaveLength(2);
  });

  it('marks the approval as no longer counting when its rows were invalidated', () => {
    const reason = 'Superseded by version 2';
    const [group] = groupApprovals([
      row('schedule', '2026-11-10T10:00:00Z', { status: 'invalidated', invalidated_at: '2026-11-10T11:00:00Z', invalidated_reason: reason }),
      row('payment', '2026-11-10T10:00:00.2Z', { status: 'invalidated', invalidated_at: '2026-11-10T11:00:00Z', invalidated_reason: reason }),
    ]);
    expect(group).toMatchObject({ status: 'invalidated', invalidated_reason: reason });
  });
});

describe('invalidatedWords', () => {
  it('counts approved fixes, not rows', () => {
    expect(invalidatedWords(0)).toBe('');
    expect(invalidatedWords(1)).toBe('1 earlier approval no longer counts.');
    expect(invalidatedWords(2)).toBe('1 earlier approval no longer counts.');
    expect(invalidatedWords(4)).toBe('2 earlier approvals no longer count.');
  });
});
