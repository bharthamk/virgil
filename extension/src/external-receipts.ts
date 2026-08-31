import { newClientRef } from './pin-body.js';
import { serviceFetch } from './service.js';

const STORAGE_KEY = 'virgil-external-pending-v1';
const MAX_PENDING = 50;

export interface ExternalReceipt {
  readonly kind: 'lesson' | 'material';
  readonly label: string;
  readonly destination: 'new-tab' | 'window' | 'side-panel' | 'notebook';
  readonly topicId?: string | null;
  readonly sessionId?: string | null;
}

interface PendingExternal extends ExternalReceipt {
  readonly clientRef: string;
}

async function pending(): Promise<PendingExternal[]> {
  try {
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    return Array.isArray(stored) ? stored.filter((row): row is PendingExternal =>
      Boolean(row && typeof row === 'object'
        && typeof (row as PendingExternal).clientRef === 'string')) : [];
  } catch {
    return [];
  }
}

async function write(rows: readonly PendingExternal[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: rows.slice(-MAX_PENDING) });
  } catch {
    // A later panel open is another chance; receipt failure never blocks a send.
  }
}

async function send(row: PendingExternal): Promise<boolean> {
  try {
    const response = await serviceFetch('/external', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(row),
    });
    return response.ok;
  } catch {
    return false;
  }
}

let flushing: Promise<void> | null = null;

export async function flushExternalPending(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    const left: PendingExternal[] = [];
    for (const row of await pending()) if (!(await send(row))) left.push(row);
    await write(left);
  })().finally(() => { flushing = null; });
  return flushing;
}

export async function recordExternal(entry: ExternalReceipt): Promise<void> {
  const row = { ...entry, clientRef: newClientRef() };
  if (!(await send(row))) await write([...(await pending()), row]);
}
