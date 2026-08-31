import type {
  HostedProcessingReceipt, HostedProcessingSummary, HostedProcessingVersion, Store,
} from '@sb/core';

export type HostedReceiptWrite = 'updated' | 'already' | 'stale';
export type HostedFailureWrite = HostedReceiptWrite | 'retrying';

/** Longer than one 30-minute task attempt, with room for shutdown and retry hand-off. */
export const HOSTED_ATTEMPT_LEASE_MS = 35 * 60 * 1_000;

export const hostedProcessingVersion = (receipt: HostedProcessingReceipt): HostedProcessingVersion => ({
  receiptId: receipt.receiptId, state: receipt.state, checkedAt: receipt.checkedAt,
});

const nonNegativeInteger = (value: string | undefined): number | null =>
  value !== undefined && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : null;

/** Cloud Run counts the initial task as attempt 0 and increments each retry. */
export function isFinalHostedAttempt(
  attemptValue: string | undefined,
  maxRetriesValue: string | undefined,
): boolean {
  const attempt = nonNegativeInteger(attemptValue);
  const maxRetries = nonNegativeInteger(maxRetriesValue);
  return attempt !== null && maxRetries !== null && attempt >= maxRetries;
}

/**
 * Let the worker report the work it actually owns, without another Cloud Run
 * read permission. The dispatch nonce matters: two manual runs can share a
 * learner-day, and a late retry from the first must never finish the second.
 */
export async function markHostedProcessing(
  store: Store,
  receiptId: string,
  state: 'running' | 'finished' | 'failed',
  now = new Date(),
  result?: HostedProcessingSummary | null,
): Promise<HostedReceiptWrite> {
  // One retry is enough for a transaction/CAS loser to observe the winner.
  // More would turn a real competing state transition into a spin loop.
  for (let tries = 0; tries < 2; tries += 1) {
    const receipt = (await store.getPrefs()).hostedProcessing;
    if (!receipt || receipt.receiptId !== receiptId) return 'stale';
    if (receipt.state === 'failed' || receipt.state === 'finished') {
      return receipt.state === state ? 'already' : 'stale';
    }
    const at = now.toISOString();
    // A platform retry carries the same nonce. Refreshing `running` is not a
    // duplicate write: it gives that real attempt its own task-timeout lease.
    const next: HostedProcessingReceipt = {
      ...receipt, state, checkedAt: at,
      ...(state === 'running'
        ? { expiresAt: new Date(now.getTime() + HOSTED_ATTEMPT_LEASE_MS).toISOString() }
        : {}),
      ...(result === undefined ? {} : { result }),
    };
    if (await store.compareAndSetHostedProcessing(hostedProcessingVersion(receipt), next)) return 'updated';
  }
  return 'stale';
}

/** Keep the receipt active while Cloud Run still owes a retry; close only the last catchable failure. */
export async function markHostedFailureOnFinalAttempt(
  store: Store,
  receiptId: string,
  env: Readonly<Record<string, string | undefined>>,
  now = new Date(),
): Promise<HostedFailureWrite> {
  if (!isFinalHostedAttempt(env.CLOUD_RUN_TASK_ATTEMPT, env.SB_RUN_MAX_RETRIES)) {
    return 'retrying';
  }
  return markHostedProcessing(store, receiptId, 'failed', now);
}
