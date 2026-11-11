/**
 * The progress payouts paypal-progress-payout sent, by the copy of the demo they were sent from
 * (public.progress_payout_batches, service role only). The function asks PayPal about a batch only for a member of
 * that copy, so nobody follows another copy's payouts, or any other batch on the business account.
 */

export interface ProgressBatch {
  projectId: string;
  gateId: number;
  /** Ours: the page's sender_batch_id. */
  senderBatchId: string;
  /** PayPal's payout_batch_id, which the page asks about. */
  paypalBatchId: string;
  sentBy: string;
}

export interface ProgressBatchLog {
  /** Records a batch PayPal took for this project; recording it twice is the same as once. */
  record(batch: ProgressBatch): Promise<void>;
  /** Whether PayPal's batch id was recorded for this project. */
  has(projectId: string, paypalBatchId: string): Promise<boolean>;
}

type Failure = { message: string; code?: string | null } | null;

/** The table as the service-role client reaches it (supabase.ts). */
export interface BatchTable {
  /** Inserts the row, or leaves the one already there. */
  insert(row: { project_id: string; paypal_batch_id: string; sender_batch_id: string; gate_id: number; sent_by: string }): PromiseLike<{ error: Failure }>;
  /** The row for this project and PayPal batch id, or null. */
  find(projectId: string, paypalBatchId: string): PromiseLike<{ data: unknown; error: Failure }>;
}

export function createBatchLog(table: BatchTable): ProgressBatchLog {
  return {
    async record(batch) {
      const { error } = await table.insert({
        project_id: batch.projectId,
        paypal_batch_id: batch.paypalBatchId,
        sender_batch_id: batch.senderBatchId,
        gate_id: batch.gateId,
        sent_by: batch.sentBy,
      });
      if (error) throw new Error(`progress_payout_batches: ${error.message}`);
    },
    async has(projectId, paypalBatchId) {
      const { data, error } = await table.find(projectId, paypalBatchId);
      if (error) throw new Error(`progress_payout_batches: ${error.message}`);
      return data !== null && data !== undefined;
    },
  };
}
