import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserTabs, ReusableTabSet, type ReusableTab } from '../browser-tabs.js';

test('the same material reuses the tab Virgil already created', async () => {
  const tabs = new ReusableTabSet();
  const reused: string[] = [];
  let created = 0;
  const create = async (): Promise<ReusableTab> => {
    created += 1;
    return { reuse: async (url) => { reused.push(url); return true; } };
  };

  assert.equal(await tabs.open('course:k1:material:m1', 'https://example.test/one', create), 'opened');
  assert.equal(await tabs.open('course:k1:material:m1', 'https://example.test/one', create), 'reused');

  assert.equal(created, 1);
  assert.deepEqual(reused, ['https://example.test/one']);
});

test('a closed material tab is replaced and the replacement becomes authoritative', async () => {
  const tabs = new ReusableTabSet();
  let created = 0;
  const create = async (): Promise<ReusableTab> => {
    created += 1;
    const generation = created;
    return { reuse: async () => generation > 1 };
  };

  await tabs.open('material:m1', 'https://example.test/one', create);
  await tabs.open('material:m1', 'https://example.test/one', create);
  await tabs.open('material:m1', 'https://example.test/one', create);

  assert.equal(created, 2);
});

test('unrelated external doors and different materials remain separate', async () => {
  const tabs = new ReusableTabSet();
  let created = 0;
  const create = async (): Promise<ReusableTab> => {
    created += 1;
    return { reuse: async () => true };
  };

  await tabs.open(null, 'https://notebook.google.com/', create);
  await tabs.open(null, 'https://notebook.google.com/', create);
  await tabs.open('material:m1', 'https://example.test/one', create);
  await tabs.open('material:m2', 'https://example.test/two', create);

  assert.equal(created, 4);
});

test('the extension restores only the tab id returned by its own create call', async (t) => {
  const previous = (globalThis as Record<string, unknown>)['chrome'];
  const created: string[] = [];
  const updated: { id: number; url: string; active: boolean }[] = [];
  (globalThis as Record<string, unknown>)['chrome'] = {
    tabs: {
      create: async ({ url }: { url: string }) => { created.push(url); return { id: 41 }; },
      update: async (id: number, next: { url: string; active: boolean }) => {
        updated.push({ id, ...next });
      },
    },
  };
  t.after(() => {
    if (previous === undefined) delete (globalThis as Record<string, unknown>)['chrome'];
    else (globalThis as Record<string, unknown>)['chrome'] = previous;
  });

  const tabs = new BrowserTabs('panel');
  assert.equal(await tabs.open('https://example.test/one', 'material:m1'), 'opened');
  assert.equal(await tabs.open('https://example.test/one', 'material:m1'), 'reused');
  assert.deepEqual(created, ['https://example.test/one']);
  assert.deepEqual(updated, [{ id: 41, url: 'https://example.test/one', active: true }]);
});
