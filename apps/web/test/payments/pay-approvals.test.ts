import { describe, expect, it, vi } from 'vitest';
import { PayApprovalError, requestPayGateApproval, type ApprovalAsk } from '../../src/payments/pay-approvals';

const ask: ApprovalAsk = {
  projectId: 'p1',
  gateId: 25,
  gateName: 'Footings paid',
  amountMinor: 3_780_000,
  currency: 'USD',
  lines: [
    { firm: 'Granite Ridge Concrete', amount_minor: 3_132_000 },
    { firm: 'Pinecrest Sitework', amount_minor: 648_000 },
  ],
};

const row = {
  id: 'a1',
  project_id: 'p1',
  gate_id: 25,
  gate_name: 'Footings paid',
  amount_minor: 3_780_000,
  currency: 'USD',
  lines: ask.lines,
  over_minor: 2_500_000,
  requested_by: 'deepak',
  status: 'requested',
  decided_by: null,
  decided_at: null,
  used_at: null,
  sender_batch_id: null,
  created_at: '2026-11-08T20:42:26.707Z',
  updated_at: '2026-11-08T20:42:26.707Z',
};

const conflict = { code: '23505', message: 'duplicate key value violates unique constraint "pay_gate_approvals_one_open"' };

describe('requestPayGateApproval', () => {
  it('asks once more when two asks at once lost the race, and returns the open request', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: null, error: conflict }).mockResolvedValueOnce({ data: row, error: null });
    await expect(requestPayGateApproval({ rpc } as never, ask)).resolves.toMatchObject({ id: 'a1', status: 'requested' });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
  });

  it('gives up after asking once more', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: conflict });
    await expect(requestPayGateApproval({ rpc } as never, ask)).rejects.toBeInstanceOf(PayApprovalError);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('does not ask again for other refusals', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'request_pay_gate_approval: only members who see costs pay the firms' } });
    await expect(requestPayGateApproval({ rpc } as never, ask)).rejects.toThrow(/only members who see costs/);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
