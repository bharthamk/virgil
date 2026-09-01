import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUEUE_KEY, chromeQueueStorage, drainPending, enqueuePin, pendingPinView,
  queueItemBelongsTo, queuedPin, queuedPinBody, queuedPinOwner, removePending, retryPending,
  type QueueStorage,
} from '../queue.js';

/**
 * SB-47: capture must never depend on the network. Everything the offline queue
 * has to get right is a property of *when* things happen — a pin arriving while
 * a drain is halfway through, a drain that never gets to finish because MV3
 * suspended the worker. Those are the cases where a captured pin gets lost or
 * sent twice, and neither is visible to the learner until the board is wrong.
 */

function memoryStorage(initial: unknown[] = []): QueueStorage & { items: unknown[] } {
  let items: unknown[] = [...initial];
  return {
    get items() { return items; },
    async read() { return [...items]; },
    async write(next) { items = [...next]; },
  };
}

const pin = (id: string): { id: string } => ({ id });

test('the queue is arrival order, and stays that way', async () => {
  const storage = memoryStorage();
  await enqueuePin(storage, pin('a'));
  await enqueuePin(storage, pin('b'));
  await enqueuePin(storage, pin('c'));
  assert.deepEqual(storage.items, [pin('a'), pin('b'), pin('c')]);
});

test('two captures that arrive together cannot erase one another', async () => {
  let items: unknown[] = [];
  const storage: QueueStorage & { readonly items: unknown[] } = {
    get items() { return items; },
    async read() {
      const snapshot = [...items];
      // Without the queue's mutation lane both callers take the empty snapshot
      // before either writes, and the second write leaves only `b` behind.
      await Promise.resolve();
      return snapshot;
    },
    async write(next) { items = [...next]; },
  };

  await Promise.all([
    enqueuePin(storage, pin('a')),
    enqueuePin(storage, pin('b')),
  ]);

  assert.deepEqual(storage.items, [pin('a'), pin('b')]);
});

test('a drain sends everything waiting, oldest first, and empties the queue', async () => {
  const storage = memoryStorage([pin('a'), pin('b'), pin('c')]);
  const posted: unknown[] = [];
  const result = await drainPending(storage, async (item) => { posted.push(item); return true; });

  assert.deepEqual(posted, [pin('a'), pin('b'), pin('c')], 'a queue is a queue');
  assert.deepEqual(storage.items, []);
  assert.deepEqual(result, { sent: 3, left: 0 });
});

test('an empty queue costs nothing', async () => {
  const storage = memoryStorage();
  let calls = 0;
  const result = await drainPending(storage, async () => { calls += 1; return true; });
  assert.equal(calls, 0);
  assert.deepEqual(result, { sent: 0, left: 0 });
});

test('one item the service refuses stays; the ones it took do not', async () => {
  const storage = memoryStorage([pin('a'), pin('b'), pin('c')]);
  const result = await drainPending(storage, async (item) => (item as { id: string }).id !== 'b');

  assert.deepEqual(storage.items, [pin('b')]);
  assert.deepEqual(result, { sent: 2, left: 1 });
});

test('a failure part way through does not abandon the rest of the queue', async () => {
  const storage = memoryStorage([pin('a'), pin('b'), pin('c')]);
  const posted: string[] = [];
  await drainPending(storage, async (item) => {
    const id = (item as { id: string }).id;
    posted.push(id);
    return id !== 'a';
  });
  assert.deepEqual(posted, ['a', 'b', 'c'], 'the first one failing must not strand the two behind it');
  assert.deepEqual(storage.items, [pin('a')]);
});

test('a pin the service already took is never posted a second time', async () => {
  const storage = memoryStorage([pin('a'), pin('b')]);
  const posted: string[] = [];
  let online = false;
  const post = async (item: unknown): Promise<boolean> => {
    const id = (item as { id: string }).id;
    posted.push(id);
    return online || id === 'a';
  };
  await drainPending(storage, post);   // the connection drops after a
  online = true;
  await drainPending(storage, post);   // back online a minute later

  assert.deepEqual(posted, ['a', 'b', 'b'], 'a is sent once and only once');
  assert.deepEqual(storage.items, []);
});

test('each waiting pin is posted exactly once per drain', async () => {
  const storage = memoryStorage([pin('a'), pin('b'), pin('c')]);
  const counts = new Map<string, number>();
  await drainPending(storage, async (item) => {
    const id = (item as { id: string }).id;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    return false;
  });
  assert.deepEqual([...counts.values()], [1, 1, 1]);
});

test('a pin captured while a drain is in flight is not thrown away', async () => {
  // The bug this replaced: the drain read the queue, worked through it, and then
  // wrote back only what it had failed to send — clobbering anything the capture
  // path had appended in the meantime. A drain awaits a 2500ms timeout per item,
  // so the window is seconds wide and every pin captured inside it disappeared
  // silently. SB-47 says the network must never be able to cost a capture.
  const storage = memoryStorage([pin('old-1'), pin('old-2')]);
  let first = true;
  await drainPending(storage, async () => {
    if (first) {
      first = false;
      await enqueuePin(storage, pin('captured-mid-drain'));   // the learner pins something
    }
    return true;
  });

  assert.deepEqual(storage.items, [pin('captured-mid-drain')],
    'the pin made during the drain survives it, and the drained ones are gone');
});

test('a pin captured mid-drain queues behind whatever failed to send', async () => {
  const storage = memoryStorage([pin('old')]);
  await drainPending(storage, async () => {
    await enqueuePin(storage, pin('new'));
    return false;
  });
  assert.deepEqual(storage.items, [pin('old'), pin('new')], 'still oldest first');
});

// --------------------------------------------------- storage round-trip

test('an envelope survives the queue with every field intact', async () => {
  // The queue is the only copy of a pin made offline, and the fields that get
  // dropped quietly are exactly the ones nothing looks at until much later —
  // contentLanguage above all (D9).
  const body = {
    type: 'struggle',
    envelope: {
      selection: 'Session state is held per user.',
      surroundingText: 'Session state is held per user. It persists between turns.',
      headingPath: ['ADK', 'Sessions'],
      pageTitle: 'ADK — Sessions',
      url: 'https://example.test/adk/sessions',
      canonicalUrl: 'https://example.test/adk/sessions',
      siteName: 'Example Docs',
      contentLanguage: 'en',
      media: { kind: 'image', ref: 'https://example.test/diagram.png' },
    },
    capturedAt: '2026-08-19T21:00:00.000Z',
  };

  const written: Record<string, unknown> = {};
  const storage = chromeQueueStorage({
    // chrome.storage.local is structured-clone backed; JSON here is the harsher
    // of the two and catches anything unserialisable.
    async get(key) { return { [key]: JSON.parse(JSON.stringify(written[key] ?? [])) as unknown }; },
    async set(items) { Object.assign(written, JSON.parse(JSON.stringify(items)) as object); },
  });

  await enqueuePin(storage, body);
  const back = await storage.read();
  assert.deepEqual(back, [body]);
  assert.ok(Array.isArray(written[QUEUE_KEY]), 'it is stored under the key the service worker reads');
});

test('storage that has never been written reads as an empty queue', async () => {
  const storage = chromeQueueStorage({
    async get() { return {}; },
    async set() { /* not reached */ },
  });
  assert.deepEqual(await storage.read(), []);
});

test('storage holding junk under the key reads as empty rather than throwing', async () => {
  const storage = chromeQueueStorage({
    async get(key) { return { [key]: 'not an array' }; },
    async set() { /* not reached */ },
  });
  assert.deepEqual(await storage.read(), [], 'a corrupt queue must not take the capture path down with it');
});

// ------------------------------------------------ learner-owned recovery

test('a waiting pin has a compact learner-facing identity without exposing queue internals', () => {
  assert.deepEqual(pendingPinView({
    clientRef: 'capture-a', type: 'interest', capturedAt: '2026-08-26T08:30:00.000Z',
    envelope: {
      selection: 'How do you hold drumsticks?', pageTitle: 'Beginner drum technique',
      url: 'https://example.test/drums',
    },
  }), {
    id: 'capture-a', title: 'How do you hold drumsticks?', source: 'Beginner drum technique',
    kind: 'Saved to learn', capturedAt: '2026-08-26T08:30:00.000Z',
    lastAttemptAt: '2026-08-26T08:30:00.000Z',
  });
  assert.deepEqual(pendingPinView({
    clientRef: 'capture-b', type: 'struggle', capturedAt: 'not-a-date',
    envelope: { selection: '   ', pageTitle: 'Back story and exposition', url: 'https://example.test/x' },
  }), {
    id: 'capture-b', title: 'Back story and exposition', source: 'example.test',
    kind: 'Marked difficult', capturedAt: null, lastAttemptAt: null,
  });
  assert.equal(pendingPinView({ type: 'interest', envelope: {} }), null,
    'an older unaddressable entry may still auto-sync but cannot be offered as the wrong item');
});

test('delivery metadata stays local and account queues belong only to their learner', () => {
  const body = { clientRef: 'capture-a', type: 'interest', envelope: { selection: 'Exact passage' } };
  const account = queuedPin(body, 'uid-a', '2026-08-26T08:30:00.000Z');
  const local = queuedPin(body, null, '2026-08-26T08:30:00.000Z');
  assert.equal(queuedPinBody(account), body, 'the service receives the pin, not queue metadata');
  assert.equal(queuedPinOwner(account), 'uid-a');
  assert.equal(queueItemBelongsTo(account, true, 'uid-a'), true);
  assert.equal(queueItemBelongsTo(account, true, 'uid-b'), false,
    'switching learner cannot display or send the previous learner’s waiting pin');
  assert.equal(queueItemBelongsTo(account, true, null), false);
  assert.equal(queueItemBelongsTo(local, false, null), true);
  assert.equal(queueItemBelongsTo(local, true, 'uid-a'), false,
    'a local single-board pin is not silently adopted by a later account setup');
  assert.equal(queueItemBelongsTo(body, false, null), true, 'legacy raw pins remain available locally');
  assert.equal(queueItemBelongsTo(body, true, 'uid-a'), false, 'legacy raw pins never cross an account boundary');
});

test('manual retry sends only the named capture and removes only a success', async () => {
  const storage = memoryStorage([
    { clientRef: 'a', value: 1 }, { clientRef: 'b', value: 2 }, { clientRef: 'c', value: 3 },
  ]);
  const posted: string[] = [];
  assert.equal(await retryPending(storage, 'b', async (item) => {
    posted.push((item as { clientRef: string }).clientRef);
    return true;
  }), 'sent');
  assert.deepEqual(posted, ['b']);
  assert.deepEqual(storage.items, [{ clientRef: 'a', value: 1 }, { clientRef: 'c', value: 3 }]);

  assert.equal(await retryPending(storage, 'c', async () => false), 'waiting');
  assert.deepEqual(storage.items, [{ clientRef: 'a', value: 1 }, { clientRef: 'c', value: 3 }]);
  assert.equal(await retryPending(storage, 'missing', async () => true), 'missing');
});

test('Remove deletes the exact unsent capture and nothing beside it', async () => {
  const storage = memoryStorage([
    { clientRef: 'a', value: 1 }, { clientRef: 'b', value: 2 }, { clientRef: 'c', value: 3 },
  ]);
  assert.equal(await removePending(storage, 'b'), true);
  assert.deepEqual(storage.items, [{ clientRef: 'a', value: 1 }, { clientRef: 'c', value: 3 }]);
  assert.equal(await removePending(storage, 'b'), false, 'a repeated confirmation cannot remove its neighbour');
});

test('manual removal waits for an active automatic drain and cannot resurrect a failed item', async () => {
  const storage = memoryStorage([{ clientRef: 'a' }, { clientRef: 'b' }]);
  let release!: (accepted: boolean) => void;
  const gate = new Promise<boolean>((resolve) => { release = resolve; });
  const draining = drainPending(storage, async (item) => (
    (item as { clientRef: string }).clientRef === 'a' ? gate : false
  ));
  await Promise.resolve();
  const removing = removePending(storage, 'b');
  release(true);
  await draining;
  assert.equal(await removing, true);
  assert.deepEqual(storage.items, []);
});

test('a capture arriving during manual retry stays behind the untouched queue', async () => {
  const storage = memoryStorage([{ clientRef: 'old' }]);
  const result = await retryPending(storage, 'old', async () => {
    await enqueuePin(storage, { clientRef: 'new' });
    return true;
  });
  assert.equal(result, 'sent');
  assert.deepEqual(storage.items, [{ clientRef: 'new' }]);
});
