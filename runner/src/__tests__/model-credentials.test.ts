import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalCloudCredential } from '../model-credentials.js';

test('a local Cloud credential persists outside the board with private permissions and can be cleared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'virgil-model-credential-'));
  const dbPath = join(root, 'board.json');
  const first = await LocalCloudCredential.open({ dbPath, editable: true });
  assert.equal(first.configured(), false);
  assert.equal(first.editable, true);
  assert.equal(first.managed, false);

  await first.set('test-google-key');
  assert.equal(first.value(), 'test-google-key');
  assert.equal((await stat(first.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(first.path)).mode & 0o777, 0o600);
  assert.equal((await readFile(dbPath, 'utf8').catch(() => 'board-absent')).includes('test-google-key'), false);

  const reopened = await LocalCloudCredential.open({ dbPath, readStored: true });
  assert.equal(reopened.value(), 'test-google-key');
  await first.clear();
  assert.equal(first.configured(), false);
  await assert.rejects(stat(first.path), /ENOENT/);
});

test('an environment-managed Cloud credential overrides local state and refuses mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'virgil-managed-credential-'));
  const managed = await LocalCloudCredential.open({
    dbPath: join(root, 'board.json'), managedKey: 'operator-key', editable: true,
  });
  assert.equal(managed.configured(), true);
  assert.equal(managed.value(), 'operator-key');
  assert.equal(managed.managed, true);
  assert.equal(managed.editable, false);
  await assert.rejects(managed.set('learner-key'), /managed by the service operator/);
  await assert.rejects(managed.clear(), /managed by the service operator/);
});
