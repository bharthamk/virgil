import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HOSTED_NOTEBOOK_DRIVE_KEY, HOSTED_NOTEBOOK_DRIVE_SCOPE,
  writeHostedNotebookDocuments,
} from '../notebook-drive.js';

test('hosted Drive creates three native Docs with one account choice, then rewrites them', async () => {
  const oldChrome = globalThis.chrome;
  const oldFetch = globalThis.fetch;
  const storage: Record<string, unknown> = {};
  const requests: { url: string; method: string; authorization: string; body: string }[] = [];
  const removedTokens: string[] = [];
  let tokenRequests = 0;
  let docCreates = 0;
  const scope = {
    learnerId: 'learner-one', serviceOrigin: 'https://virgil.example',
    expectedAccount: 'notebook-owner@example.com',
  };
  const scopedKey = `${HOSTED_NOTEBOOK_DRIVE_KEY}:${encodeURIComponent(scope.serviceOrigin)}:${scope.learnerId}`;

  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      identity: {
        async getAuthToken(options: { scopes: string[] }) {
          tokenRequests += 1;
          assert.deepEqual(options.scopes, [HOSTED_NOTEBOOK_DRIVE_SCOPE]);
          return { token: tokenRequests === 1 ? 'expired-access-token' : 'short-lived-access-token' };
        },
        async removeCachedAuthToken({ token }: { token: string }) { removedTokens.push(token); },
      },
      storage: {
        local: {
          async get(key: string) { return key in storage ? { [key]: storage[key] } : {}; },
          async set(values: Record<string, unknown>) { Object.assign(storage, structuredClone(values)); },
        },
      },
    },
  });

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const headers = init.headers as Record<string, string> | undefined;
    requests.push({
      url, method, authorization: headers?.authorization ?? '',
      body: typeof init.body === 'string' ? init.body : '',
    });
    if (headers?.authorization === 'Bearer expired-access-token') {
      return new Response('', { status: 401 });
    }
    if (url.includes('/drive/v3/about')) {
      return Response.json({ user: { emailAddress: 'notebook-owner@example.com' } });
    }
    if (url.includes('/drive/v3/files?') && method === 'GET') return Response.json({ files: [] });
    if (url.endsWith('/drive/v3/files?fields=id') && method === 'POST') {
      return Response.json({ id: 'folder-1' });
    }
    if (url.includes('/upload/drive/v3/files?') && method === 'POST') {
      docCreates += 1;
      return Response.json({ id: `doc-${docCreates}` });
    }
    if (url.includes('/drive/v3/files/folder-1')) {
      return Response.json({ id: 'folder-1', trashed: false });
    }
    if (url.includes('/upload/drive/v3/files/doc-') && method === 'PATCH') {
      return Response.json({ id: 'doc-1' });
    }
    return new Response('', { status: 404 });
  };

  try {
    const first = await writeHostedNotebookDocuments([
      { key: 'learn-now', title: 'Virgil: learn now', html: '<html>first lesson</html>' },
      { key: 'on-the-board', title: 'Virgil: on the board', html: '<html>first board</html>' },
      { key: 'archive', title: 'Virgil: archive', html: '<html>first archive</html>' },
    ], scope);
    assert.equal(first.account, 'notebook-owner@example.com');
    assert.equal(first.folderId, 'folder-1');
    assert.deepEqual(first.documents.map(({ key, fileId, created }) => ({ key, fileId, created })), [
      { key: 'learn-now', fileId: 'doc-1', created: true },
      { key: 'on-the-board', fileId: 'doc-2', created: true },
      { key: 'archive', fileId: 'doc-3', created: true },
    ]);
    assert.deepEqual(storage[scopedKey], {
      account: 'notebook-owner@example.com', folderId: 'folder-1',
      files: { 'learn-now': 'doc-1', 'on-the-board': 'doc-2', archive: 'doc-3' },
    });
    assert.doesNotMatch(JSON.stringify(storage), /short-lived-access-token/,
      'the access token escaped browser memory into durable storage');

    const second = await writeHostedNotebookDocuments([
      { key: 'learn-now', title: 'Virgil: learn now', html: '<html>second lesson</html>' },
      { key: 'on-the-board', title: 'Virgil: on the board', html: '<html>second board</html>' },
      { key: 'archive', title: 'Virgil: archive', html: '<html>second archive</html>' },
    ], scope);
    assert.ok(second.documents.every((document) => !document.created));
    assert.equal(tokenRequests, 2,
      'the rejected token was refreshed once, then reused for the second foreground write');
    assert.deepEqual(removedTokens, ['expired-access-token'],
      'Chrome Identity was allowed to hand the rejected cached token straight back');
    assert.deepEqual(requests.filter((request) => request.method === 'PATCH').map((request) => request.body),
      ['<html>second lesson</html>', '<html>second board</html>', '<html>second archive</html>']);
    assert.equal(requests[0]?.authorization, 'Bearer expired-access-token');
    assert.ok(requests.slice(1)
      .every((request) => request.authorization === 'Bearer short-lived-access-token'));

    const beforeMismatch = requests.length;
    await assert.rejects(() => writeHostedNotebookDocuments([
      { key: 'learn-now', title: 'Virgil: learn now', html: '<html>wrong account</html>' },
    ], { ...scope, expectedAccount: 'different-owner@example.com' }), /Nothing was written/);
    assert.deepEqual(requests.slice(beforeMismatch).map(({ url, method }) => ({ url, method })), [{
      url: 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', method: 'GET',
    }], 'the account mismatch was detected only after Drive had already been mutated');

    const otherScope = { ...scope, learnerId: 'learner-two' };
    const other = await writeHostedNotebookDocuments([
      { key: 'learn-now', title: 'Virgil: learn now', html: '<html>other learner</html>' },
    ], otherScope);
    assert.equal(other.documents[0]?.created, true,
      'a second learner reused the first learner\'s remembered document id');
    const otherKey = `${HOSTED_NOTEBOOK_DRIVE_KEY}:${encodeURIComponent(scope.serviceOrigin)}:learner-two`;
    assert.ok(storage[otherKey], 'the second learner did not receive a separate local id map');
    assert.notEqual(otherKey, scopedKey);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldChrome) Object.defineProperty(globalThis, 'chrome', { configurable: true, value: oldChrome });
    else delete (globalThis as Record<string, unknown>).chrome;
  }
});

test('a mid-batch Drive failure says which sources were already changed', async () => {
  const oldChrome = globalThis.chrome;
  const oldFetch = globalThis.fetch;
  const storage: Record<string, unknown> = {};
  let created = 0;
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      identity: { async getAuthToken() { return { token: 'batch-token' }; } },
      storage: { local: {
        async get(key: string) { return key in storage ? { [key]: storage[key] } : {}; },
        async set(values: Record<string, unknown>) { Object.assign(storage, structuredClone(values)); },
      } },
    },
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    if (url.includes('/drive/v3/about')) {
      return Response.json({ user: { emailAddress: 'owner@example.com' } });
    }
    if (url.includes('/drive/v3/files?') && method === 'GET') return Response.json({ files: [] });
    if (url.endsWith('/drive/v3/files?fields=id') && method === 'POST') {
      return Response.json({ id: 'folder-1' });
    }
    if (url.includes('/upload/drive/v3/files?') && method === 'POST') {
      created += 1;
      return created === 1 ? Response.json({ id: 'doc-1' }) : new Response('', { status: 500 });
    }
    return new Response('', { status: 404 });
  };

  try {
    await assert.rejects(() => writeHostedNotebookDocuments([
      { key: 'learn-now', title: 'Virgil: learn now', html: '<html>lesson</html>' },
      { key: 'on-the-board', title: 'Virgil: on the board', html: '<html>board</html>' },
      { key: 'archive', title: 'Virgil: archive', html: '<html>archive</html>' },
    ], {
      learnerId: 'learner-one', serviceOrigin: 'https://virgil.example',
      expectedAccount: 'owner@example.com',
    }), /wrote 1 of 3 Notebook sources.*already changed in Drive.*remaining 2 sources were not written/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldChrome) Object.defineProperty(globalThis, 'chrome', { configurable: true, value: oldChrome });
    else delete (globalThis as Record<string, unknown>).chrome;
  }
});

test('a lost browser mapping recovers the oldest exact source Notebook already reads', async () => {
  const oldChrome = globalThis.chrome;
  const oldFetch = globalThis.fetch;
  const scope = {
    learnerId: 'learner-one', serviceOrigin: 'https://virgil.example',
    expectedAccount: 'owner@example.com',
  };
  const key = `${HOSTED_NOTEBOOK_DRIVE_KEY}:${encodeURIComponent(scope.serviceOrigin)}:${scope.learnerId}`;
  const storage: Record<string, unknown> = {
    [key]: {
      account: 'owner@example.com', folderId: 'folder-1',
      files: {},
    },
  };
  const patched: { id: string; body: string }[] = [];
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      identity: { async getAuthToken() { return { token: 'token' }; } },
      storage: { local: {
        async get(name: string) { return name in storage ? { [name]: storage[name] } : {}; },
        async set(values: Record<string, unknown>) { Object.assign(storage, structuredClone(values)); },
      } },
    },
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    if (url.includes('/drive/v3/about')) {
      return Response.json({ user: { emailAddress: 'owner@example.com' } });
    }
    if (url.includes('/drive/v3/files/folder-1')) {
      return Response.json({ id: 'folder-1', trashed: false });
    }
    if (url.includes('/drive/v3/files?') && method === 'GET') {
      return Response.json({ files: [
        { id: 'new-duplicate', createdTime: '2026-09-01T00:00:00.000Z' },
        { id: 'notebook-source', createdTime: '2026-08-30T00:00:00.000Z' },
      ] });
    }
    if (url.includes('/upload/drive/v3/files/') && method === 'PATCH') {
      const id = decodeURIComponent(url.match(/files\/([^?]+)/)?.[1] ?? '');
      patched.push({ id, body: String(init.body ?? '') });
      return Response.json({ id });
    }
    return new Response('', { status: 404 });
  };

  try {
    const result = await writeHostedNotebookDocuments([
      { key: 'learn-now', title: 'Virgil: learn now', html: '<html>current lesson</html>' },
    ], scope);
    assert.deepEqual(patched, [{ id: 'notebook-source', body: '<html>current lesson</html>' }]);
    assert.deepEqual(result.documents, [{
      account: 'owner@example.com', key: 'learn-now', fileId: 'notebook-source', created: false,
    }]);
    assert.equal((storage[key] as { files: Record<string, string> }).files['learn-now'],
      'notebook-source', 'the recovered stable id did not replace the duplicate cache entry');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldChrome) Object.defineProperty(globalThis, 'chrome', { configurable: true, value: oldChrome });
    else delete (globalThis as Record<string, unknown>).chrome;
  }
});
