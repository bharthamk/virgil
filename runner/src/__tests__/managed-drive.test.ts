import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PREFS } from '@sb/adapters';
import type { LearnerPrefs } from '@sb/core';
import { managedDriveGrant, managedDriveIds } from '../managed-drive.js';

test('managed Drive grant accepts a Secret Manager ADC value without exposing extra fields', () => {
  const grant = managedDriveGrant(JSON.stringify({
    type: 'authorized_user',
    account: 'notebook-owner@example.com',
    client_id: 'client-id',
    client_secret: 'client-secret',
    refresh_token: 'refresh-token',
    quota_project_id: 'a-project',
  }));
  assert.deepEqual(grant, {
    account: 'notebook-owner@example.com',
    client: { clientId: 'client-id', clientSecret: 'client-secret' },
    refreshToken: 'refresh-token',
  });
  assert.equal(managedDriveGrant(undefined), null);
  assert.equal(managedDriveGrant('disabled'), null,
    'a self-hoster can leave the optional managed-Drive lane off without fabricating an OAuth grant');
  assert.throws(() => managedDriveGrant('{'), /not a JSON object/);
  assert.throws(() => managedDriveGrant('{}'), /account/);
});

test('managed Drive ids are durable learner state and refuse the wrong grant account', async () => {
  let prefs: LearnerPrefs = {
    ...DEFAULT_PREFS,
    notebookDrive: {
      enabled: true,
      account: 'notebook-owner@example.com',
      folderId: 'folder-1',
      files: { 'learn-now': 'doc-1', 'on-the-board': 'doc-2', archive: 'doc-3' },
      connectedAt: '2026-08-30T00:00:00.000Z',
    },
  };
  const store = {
    async getPrefs() { return prefs; },
    async putPrefs(next: LearnerPrefs) { prefs = next; },
  };
  const ids = managedDriveIds(store, 'NOTEBOOK-OWNER@example.com',
    () => new Date('2026-08-30T04:05:06.000Z'));
  assert.deepEqual(await ids.read(), {
    folderId: 'folder-1',
    files: { 'learn-now': 'doc-1', 'on-the-board': 'doc-2', archive: 'doc-3' },
  });
  await ids.write({
    folderId: 'folder-1',
    files: { 'learn-now': 'doc-1', 'on-the-board': 'doc-20', archive: 'doc-3' },
  });
  assert.equal(prefs.notebookDrive?.files['on-the-board'], 'doc-20');
  assert.equal(prefs.notebookDrive?.lastWriteAt, '2026-08-30T04:05:06.000Z');
  await assert.rejects(managedDriveIds(store, 'someone-else@example.com').read(), /does not match/);
});
