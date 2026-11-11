import { describe, expect, it } from 'vitest';
import { createBatchLog, type BatchTable } from '../_shared/batch-log.ts';

const HARBOR = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-0000000000ff';
const batch = { projectId: HARBOR, gateId: 25, senderBatchId: 'PG-25-abc', paypalBatchId: 'BATCH-1', sentBy: '00000000-0000-4000-8000-000000000012' };

function table(failure: { code: string; message: string } | null = null) {
  const rows: Parameters<BatchTable['insert']>[0][] = [];
  const fake: BatchTable = {
    insert: async (row) => {
      if (failure) return { error: failure };
      if (!rows.some((each) => each.project_id === row.project_id && each.paypal_batch_id === row.paypal_batch_id)) rows.push(row);
      return { error: null };
    },
    find: async (projectId, paypalBatchId) => {
      if (failure) return { data: null, error: failure };
      return { data: rows.find((row) => row.project_id === projectId && row.paypal_batch_id === paypalBatchId) ?? null, error: null };
    },
  };
  return { rows, fake };
}

describe('the batches each copy sent', () => {
  it('knows a batch only for the project that sent it', async () => {
    const { rows, fake } = table();
    const log = createBatchLog(fake);
    await log.record(batch);
    await log.record(batch);
    expect(rows).toEqual([{ project_id: HARBOR, paypal_batch_id: 'BATCH-1', sender_batch_id: 'PG-25-abc', gate_id: 25, sent_by: batch.sentBy }]);
    expect(await log.has(HARBOR, 'BATCH-1')).toBe(true);
    expect(await log.has(OTHER, 'BATCH-1')).toBe(false);
    expect(await log.has(HARBOR, 'BATCH-2')).toBe(false);
  });

  it('refuses rather than letting a batch through when the table is missing', async () => {
    const { fake } = table({ code: 'PGRST205', message: "Could not find the table 'public.progress_payout_batches' in the schema cache" });
    const log = createBatchLog(fake);
    await expect(log.has(OTHER, 'ANY')).rejects.toThrow('progress_payout_batches');
    await expect(log.record(batch)).rejects.toThrow('progress_payout_batches');
  });

  it('fails on any other database failure rather than guessing', async () => {
    const { fake } = table({ code: '57014', message: 'canceling statement due to statement timeout' });
    const log = createBatchLog(fake);
    await expect(log.has(HARBOR, 'BATCH-1')).rejects.toThrow('progress_payout_batches');
    await expect(log.record(batch)).rejects.toThrow('progress_payout_batches');
  });
});
