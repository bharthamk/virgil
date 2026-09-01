import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const extensionDir = new URL('../../', import.meta.url);
const source = readFileSync(
  fileURLToPath(new URL('session-bridge-content.js', extensionDir)), 'utf8');

interface Harness {
  readonly store: Record<string, unknown>;
  readonly replies: Record<string, unknown>[];
  readonly runtimeMessages: unknown[];
  removedListeners(): number;
  send(data: unknown, origin?: string): Promise<void>;
}

function bridge(
  service = 'http://127.0.0.1:8791',
  over: { contextId?: string | null; storageError?: Error } = {},
): Harness {
  let listener: ((event: Record<string, unknown>) => void) | null = null;
  let removed = 0;
  const replies: Record<string, unknown>[] = [];
  const runtimeMessages: unknown[] = [];
  const win = {
    addEventListener(type: string, next: (event: Record<string, unknown>) => void) {
      if (type === 'message') listener = next;
    },
    removeEventListener(type: string, current: (event: Record<string, unknown>) => void) {
      if (type === 'message' && listener === current) { listener = null; removed += 1; }
    },
    postMessage(data: Record<string, unknown>) { replies.push(data); },
  };
  const location = { origin: 'http://127.0.0.1:8791', pathname: '/app/' };
  const store: Record<string, unknown> = { sb_service_url: service };
  const chrome = {
    storage: { local: {
      async get(key: string) {
        if (over.storageError) throw over.storageError;
        return { [key]: store[key] };
      },
      async set(values: Record<string, unknown>) {
        if (over.storageError) throw over.storageError;
        Object.assign(store, structuredClone(values));
      },
    } },
    runtime: {
      id: over.contextId === undefined ? 'virgil-test-extension' : over.contextId,
      async sendMessage(data: unknown) { runtimeMessages.push(data); return { ok: true }; },
    },
  };
  const run = new Function('window', 'location', 'chrome', source) as
    (window: unknown, location: unknown, chrome: unknown) => void;
  run(win, location, chrome);
  assert.ok(listener, 'the declared bridge installed no message listener');
  return {
    store, replies, runtimeMessages,
    removedListeners: () => removed,
    async send(data: unknown, origin = location.origin) {
      listener?.({ source: win, origin, data });
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

const config = { apiKey: 'public-key', projectId: 'self-hosted-project' };
const session = {
  idToken: 'header.payload.', refreshToken: 'refresh', expiresAt: Date.now() + 3600_000,
  uid: 'learner-one', email: 'learner@example.com',
};
const message = (over: Record<string, unknown> = {}) => ({
  source: 'virgil-hosted-session-v1', authConfig: config, session, ...over,
});

test('hosted Settings can read and enable the extension-only experiment', async () => {
  const h = bridge();
  await h.send({
    source: 'virgil-hosted-experiment-v1', requestId: 'read-1', kind: 'read',
  });
  assert.deepEqual(h.replies.at(-1), {
    source: 'virgil-extension-experiment-v1', requestId: 'read-1', ok: true, enabled: false,
  });

  await h.send({
    source: 'virgil-hosted-experiment-v1', requestId: 'write-1', kind: 'write', enabled: true,
  });
  assert.equal(h.store.sb_experimental_whole_page, true);
  assert.deepEqual(h.runtimeMessages.at(-1), { kind: 'sb-experimental-capture-changed' });
  assert.deepEqual(h.replies.at(-1), {
    source: 'virgil-extension-experiment-v1', requestId: 'write-1', ok: true, enabled: true,
  });
});

test('another origin cannot change the extension experiment', async () => {
  const h = bridge();
  await h.send({
    source: 'virgil-hosted-experiment-v1', requestId: 'write-1', kind: 'write', enabled: true,
  }, 'https://other.example');
  assert.equal(h.store.sb_experimental_whole_page, undefined);
  assert.deepEqual(h.runtimeMessages, []);
});

test('the hosted page session becomes the extension panel session', async () => {
  const h = bridge();
  await h.send(message());
  assert.deepEqual(h.store.sb_auth_config, config);
  assert.deepEqual(h.store.sb_session, session);
});

test('signing out on the hosted page signs the extension surface out too', async () => {
  const h = bridge();
  await h.send(message());
  await h.send(message({ session: null }));
  assert.equal(h.store.sb_session, null);
});

test('a bridge Chrome invalidated on reload retires before it touches storage', async () => {
  const h = bridge('http://127.0.0.1:8791', { contextId: null });
  await h.send(message());
  assert.equal(h.removedListeners(), 1);
  assert.equal(h.store.sb_session, undefined);
  await h.send(message());
  assert.equal(h.removedListeners(), 1, 'the stale listener handled another page publication');
});

test('context loss during an awaited Chrome call is handled and retires the bridge', async () => {
  const h = bridge('http://127.0.0.1:8791', {
    storageError: new Error('Extension context invalidated.'),
  });
  await h.send(message());
  assert.equal(h.removedListeners(), 1);
  assert.equal(h.store.sb_session, undefined);
});

test('another origin cannot choose which board the extension opens', async () => {
  const h = bridge('https://another.example');
  await h.send(message());
  assert.equal(h.store.sb_session, undefined);
  assert.equal(h.store.sb_auth_config, undefined);
});

test('a copied message with malformed identity state is ignored', async () => {
  const h = bridge();
  await h.send(message({ session: { idToken: 'forged' } }));
  await h.send(message({ authConfig: { apiKey: '', projectId: 'p' } }));
  assert.equal(h.store.sb_session, undefined);
  assert.equal(h.store.sb_auth_config, undefined);
});

test('the manifest loads the bridge before the hosted page runtime can publish', () => {
  const manifest = JSON.parse(readFileSync(
    fileURLToPath(new URL('manifest.json', extensionDir)), 'utf8')) as {
      content_scripts?: { js?: string[]; run_at?: string }[];
    };
  const entry = manifest.content_scripts?.find((item) => item.js?.includes('session-bridge-content.js'));
  assert.ok(entry, 'the bridge exists on disk and Chrome never loads it');
  assert.equal(entry.run_at, 'document_start');

  const runtime = readFileSync(fileURLToPath(new URL('web-runtime.js', extensionDir)), 'utf8');
  assert.match(runtime, /virgil-hosted-session-v1/);
  assert.match(runtime, /requestAccessToken\(\{ prompt: 'select_account' \}\)/,
    'the hosted Switch user route can only switch if Google offers a real chooser');
  assert.match(runtime, /changed[\s\S]*publishSession\(\)/,
    'a later sign-in or sign-out is not published to the extension');
});
