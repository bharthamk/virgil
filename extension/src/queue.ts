/**
 * The offline queue.
 *
 * Capture must never depend on the network. A pin that cannot reach the service
 * is kept locally, in order, and posted later — and the learner is told exactly
 * that in the toast rather than shown a failure.
 *
 * Storage is injected because the interesting cases are all about *interleaving*
 * — a pin arriving while a drain is halfway through it, a drain that never gets
 * to finish because MV3 suspended the service worker. Those cannot be tested
 * against `chrome.storage` and they are exactly where pins get lost or sent
 * twice, so they are tested here.
 */
export const QUEUE_KEY = 'sb_pending_pins';
export const QUEUE_RETRY = 'sb-queue-retry';
export const QUEUE_REMOVE = 'sb-queue-remove';

/** The queue owns delivery metadata; the service still receives only `body`. */
export interface QueuedPinRecord {
  readonly version: 1;
  /** Null is a single-board installation. Account-backed captures name their learner. */
  readonly ownerUid: string | null;
  readonly body: unknown;
  readonly lastAttemptAt: string;
}

export interface PendingPinView {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly kind: string;
  readonly capturedAt: string | null;
  readonly lastAttemptAt: string | null;
}

export type RetryPendingResult = 'sent' | 'waiting' | 'missing';

export interface QueueStorage {
  read(): Promise<unknown[]>;
  write(items: readonly unknown[]): Promise<void>;
}

/** True when the service took it. Anything else — offline, timeout, 5xx — is false. */
/** `skip` means this entry belongs to another learner and was not attempted. */
export type PostPin = (item: unknown) => Promise<boolean | 'skip'>;

export interface DrainResult {
  /** How many the service accepted this pass. */
  sent: number;
  /** How many are still waiting after it. */
  left: number;
}

/**
 * `chrome.storage.local` offers reads and writes, not an atomic append. Keep the
 * read-modify-write sections ordered while this worker is alive so two capture
 * gestures cannot both read the same queue and let the later write erase the
 * earlier one.
 *
 * Drains have their own lane. A drain deliberately releases the mutation lane
 * while it waits on the network, which lets a capture append immediately; the
 * drain then reconciles that append under the mutation lane before it writes.
 */
const mutationLanes = new WeakMap<QueueStorage, Promise<void>>();
const drainLanes = new WeakMap<QueueStorage, Promise<void>>();

const recordOf = (item: unknown): QueuedPinRecord | null => {
  if (!item || typeof item !== 'object') return null;
  const r = item as Record<string, unknown>;
  if (r['version'] !== 1 || !('body' in r)) return null;
  if (!(r['ownerUid'] === null || typeof r['ownerUid'] === 'string')) return null;
  if (typeof r['lastAttemptAt'] !== 'string') return null;
  return item as QueuedPinRecord;
};

const bodyOf = (item: unknown): unknown => recordOf(item)?.body ?? item;

const clientRefOf = (item: unknown): string | null => {
  const body = bodyOf(item);
  if (!body || typeof body !== 'object') return null;
  const ref = (body as Record<string, unknown>)['clientRef'];
  return typeof ref === 'string' && ref.trim() ? ref : null;
};

const compact = (value: unknown): string => typeof value === 'string'
  ? value.replace(/\s+/g, ' ').trim()
  : '';

const shorten = (value: string, max = 96): string => value.length <= max
  ? value
  : `${value.slice(0, max - 1).trimEnd()}…`;

const hostOf = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; }
};

/** Put delivery metadata beside a service body without leaking it into `/pins`. */
export function queuedPin(
  body: unknown, ownerUid: string | null, lastAttemptAt: string,
): QueuedPinRecord {
  return { version: 1, ownerUid, body, lastAttemptAt };
}

/** The only value the service should receive from a queue entry. */
export function queuedPinBody(item: unknown): unknown { return bodyOf(item); }

/** Undefined is a legacy raw entry; null is an intentional single-board owner. */
export function queuedPinOwner(item: unknown): string | null | undefined {
  const record = recordOf(item);
  return record ? record.ownerUid : undefined;
}

/** Account queues are private to their learner; legacy entries remain local-install only. */
export function queueItemBelongsTo(
  item: unknown, authConfigured: boolean, learnerUid: string | null,
): boolean {
  const owner = queuedPinOwner(item);
  if (!authConfigured) return owner === null || owner === undefined;
  return typeof owner === 'string' && owner !== '' && owner === learnerUid;
}

/** Captured material and source, reduced to what the popup can honestly name. */
export function pendingPinView(item: unknown): PendingPinView | null {
  const body = bodyOf(item);
  if (!body || typeof body !== 'object') return null;
  const pin = body as Record<string, unknown>;
  const id = clientRefOf(item);
  if (!id) return null;
  const envelope = pin['envelope'] && typeof pin['envelope'] === 'object'
    ? pin['envelope'] as Record<string, unknown>
    : {};
  const selection = compact(envelope['selection']);
  const pageTitle = compact(envelope['pageTitle']);
  const host = hostOf(envelope['url']);
  const title = shorten(selection || pageTitle || host || 'Untitled pin');
  const source = shorten((selection ? pageTitle : host) || host || 'Source not named', 64);
  const captured = compact(pin['capturedAt']);
  const attempted = compact(recordOf(item)?.lastAttemptAt);
  return {
    id,
    title,
    source,
    kind: pin['type'] === 'struggle' ? 'Marked difficult' : 'Saved to learn',
    capturedAt: Number.isNaN(Date.parse(captured)) ? null : captured,
    lastAttemptAt: Number.isNaN(Date.parse(attempted || captured)) ? null : (attempted || captured),
  };
}

async function serialised<T>(
  lanes: WeakMap<QueueStorage, Promise<void>>,
  storage: QueueStorage,
  task: () => Promise<T>,
): Promise<T> {
  const previous = lanes.get(storage) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const settled = run.then(() => undefined, () => undefined);
  lanes.set(storage, settled);
  try {
    return await run;
  } finally {
    if (lanes.get(storage) === settled) lanes.delete(storage);
  }
}

/** Append. Order is arrival order, and it is the order they will be sent in. */
export async function enqueuePin(storage: QueueStorage, item: unknown): Promise<void> {
  await serialised(mutationLanes, storage, async () => {
    const queue = await storage.read();
    await storage.write([...queue, item]);
  });
}

/**
 * Post everything that is waiting, keep what would not go.
 *
 * Two things here are load-bearing and both were bugs:
 *
 *  - `post` must not be the capture path's sender. That one re-queues on
 *    failure, so draining with it wrote every failed item back into the queue
 *    *while the drain was still reading it* — harmless only because the final
 *    write happened to clobber it. If the worker died first (MV3 kills them
 *    freely), the next drain sent every one of them a second time.
 *  - the final write must not clobber. A pin captured while a drain is in
 *    flight lands at the end of the queue; writing back only the prefix we took
 *    threw it away. The queue is append-only, so anything past the prefix we
 *    read is new and is kept.
 */
export async function drainPending(storage: QueueStorage, post: PostPin): Promise<DrainResult> {
  return serialised(drainLanes, storage, async () => {
    const pending = await serialised(mutationLanes, storage, () => storage.read());
    if (!pending.length) return { sent: 0, left: 0 };

    const failed: unknown[] = [];
    for (const item of pending) {
      const result = await post(item);
      if (result === true) continue;
      const record = recordOf(item);
      failed.push(result === 'skip'
        ? item
        : record ? { ...record, lastAttemptAt: new Date().toISOString() } : item);
    }

    return serialised(mutationLanes, storage, async () => {
      const after = await storage.read();
      const arrivedDuringDrain = after.slice(pending.length);
      const left = [...failed, ...arrivedDuringDrain];
      await storage.write(left);
      return { sent: pending.length - failed.length, left: left.length };
    });
  });
}

/** Retry one stable client identity without touching its neighbours. */
export async function retryPending(
  storage: QueueStorage, clientRef: string, post: PostPin,
): Promise<RetryPendingResult> {
  if (!clientRef.trim()) return 'missing';
  return serialised(drainLanes, storage, async () => {
    const current = await serialised(mutationLanes, storage, () => storage.read());
    const item = current.find((candidate) => clientRefOf(candidate) === clientRef);
    if (item === undefined) return 'missing';
    const result = await post(item);
    if (result === 'skip') return 'missing';
    if (!result) {
      const attempted = recordOf(item);
      if (attempted) {
        await serialised(mutationLanes, storage, async () => {
          const after = await storage.read();
          await storage.write(after.map((candidate) => clientRefOf(candidate) === clientRef
            ? { ...attempted, lastAttemptAt: new Date().toISOString() }
            : candidate));
        });
      }
      return 'waiting';
    }
    await serialised(mutationLanes, storage, async () => {
      const after = await storage.read();
      await storage.write(after.filter((candidate) => clientRefOf(candidate) !== clientRef));
    });
    return 'sent';
  });
}

/** Confirmed undo for an unsent pin. It never addresses a neighbour by index. */
export async function removePending(
  storage: QueueStorage, clientRef: string, mayRemove: (item: unknown) => boolean = () => true,
): Promise<boolean> {
  if (!clientRef.trim()) return false;
  return serialised(drainLanes, storage, async () => serialised(mutationLanes, storage, async () => {
    const current = await storage.read();
    const match = current.find((candidate) => clientRefOf(candidate) === clientRef);
    if (match === undefined || !mayRemove(match)) return false;
    await storage.write(current.filter((candidate) => clientRefOf(candidate) !== clientRef));
    return true;
  }));
}

/** `chrome.storage.local` as a QueueStorage. The only chrome-shaped thing here. */
export function chromeQueueStorage(
  local: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> },
  key: string = QUEUE_KEY,
): QueueStorage {
  return {
    async read(): Promise<unknown[]> {
      const got = await local.get(key);
      const q = got[key];
      return Array.isArray(q) ? q : [];
    },
    async write(items: readonly unknown[]): Promise<void> {
      await local.set({ [key]: [...items] });
    },
  };
}
