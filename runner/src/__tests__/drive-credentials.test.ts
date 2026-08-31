import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalDriveCredential, SHIPPED_DRIVE_CLIENT } from '../drive-credentials.js';

/**
 * NOTEBOOK_SEAM_V2.md §4.1 and §10.3 — the credential, beside the board.
 *
 * These are `model-credentials.test.ts`'s assertions arriving on a second
 * credential, on purpose. §4.1 says the Gemini key's handling is followed *point
 * for point*, and the only way that stays true a lane later is for the same
 * points to be checked. A store that quietly wrote `0644` would look identical
 * from every screen in the product.
 *
 * Nothing in this file is a credential. `test-client` and `test-secret` are the
 * strings a fake would use.
 */

const root = async (): Promise<string> => mkdtemp(join(tmpdir(), 'virgil-drive-credential-'));

test('the client persists outside the board, 0700 over 0600, and can be cleared', async () => {
  const dir = await root();
  const dbPath = join(dir, 'board.json');
  await writeFile(dbPath, '{}', 'utf8');

  const credential = await LocalDriveCredential.open({ dbPath, editable: true });
  assert.equal(credential.clientConfigured(), false);
  assert.equal(credential.clientSource(), 'none');

  await credential.setClient('test-client', 'test-secret');
  assert.equal(credential.clientConfigured(), true);
  assert.equal(credential.clientSource(), 'saved');
  assert.equal((await stat(credential.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(credential.clientPath)).mode & 0o777, 0o600);

  // The board is the learner's data and may be shared, synced or handed to
  // somebody helping them. A credential in it travels with it.
  assert.equal((await readFile(dbPath, 'utf8')).includes('test-secret'), false);

  const reopened = await LocalDriveCredential.open({ dbPath, editable: true });
  assert.equal(reopened.client()?.clientId, 'test-client');

  await credential.clearClient();
  assert.equal(credential.clientConfigured(), false);
});

test('the token is a separate file, 0600, and is never in the board', async () => {
  const dir = await root();
  const dbPath = join(dir, 'board.json');
  await writeFile(dbPath, '{}', 'utf8');

  const credential = await LocalDriveCredential.open({ dbPath, editable: true });
  assert.equal(credential.connected(), false);
  await credential.setToken('test-refresh-token', 'scope', '2026-08-24T03:00:00.000Z');

  assert.equal(credential.connected(), true);
  assert.equal((await stat(credential.tokenPath)).mode & 0o777, 0o600);
  assert.equal((await readFile(dbPath, 'utf8')).includes('test-refresh-token'), false);
  assert.equal(credential.connection().connectedAt, '2026-08-24T03:00:00.000Z');
});

test('what a surface may be told is whether one exists and when, and never the value', async () => {
  const dir = await root();
  const credential = await LocalDriveCredential.open({ dbPath: join(dir, 'board.json'), editable: true });
  await credential.setClient('test-client', 'test-secret');
  await credential.setToken('test-refresh-token', 'a-scope', '2026-08-24T03:00:00.000Z');

  // §4.1's law, checked against the whole of what the state object can carry.
  const said = JSON.stringify(credential.connection());
  assert.equal(said.includes('test-refresh-token'), false);
  assert.equal(said.includes('test-secret'), false);
  assert.match(said, /"connected":true/);
});

test('a symlink where the credential should be is refused rather than followed', async () => {
  const dir = await root();
  const dbPath = join(dir, 'board.json');
  const elsewhere = join(dir, 'somebody-elses-file');
  await writeFile(elsewhere, JSON.stringify({ clientId: 'x', clientSecret: 'y' }), 'utf8');

  const opened = await LocalDriveCredential.open({ dbPath, editable: true });
  await symlink(elsewhere, opened.clientPath);

  await assert.rejects(
    () => LocalDriveCredential.open({ dbPath, editable: true }),
    /not a regular file/,
  );
});

test('an interrupted save cannot leave half a credential behind', async () => {
  const dir = await root();
  const credential = await LocalDriveCredential.open({ dbPath: join(dir, 'board.json'), editable: true });
  await credential.setClient('test-client', 'test-secret');
  await credential.setToken('test-refresh-token', 'scope', '2026-08-24T03:00:00.000Z');
  await credential.writeIds({ folderId: 'folder-1', files: { sources: 'file-1' } });

  // Temp files are `.drive-<pid>-<uuid>` and are renamed into place, so a
  // directory listing after a settled write has only the three real files.
  const files = (await readdir(credential.directory)).sort();
  assert.deepEqual(files, ['google-drive-client', 'google-drive-files', 'google-drive-token']);
});

test('a value with a newline in it is refused, because it would be a second header', async () => {
  const dir = await root();
  const credential = await LocalDriveCredential.open({ dbPath: join(dir, 'board.json'), editable: true });
  await assert.rejects(() => credential.setClient('test-client\nx: y', 'test-secret'), /single-line/);
  await assert.rejects(() => credential.setClient('', 'test-secret'), /single-line/);
  await assert.rejects(() => credential.setClient('test-client', ''), /single-line/);
});

// ---------------------------------------------------------------- §4.3 routes

test('the shipped slot exists and this build ships it empty', () => {
  // Empty is a state
  // the product reports honestly, not a fault: §4.3's rule is that the feature
  // is off and says so, and does not degrade to anything.
  assert.equal(SHIPPED_DRIVE_CLIENT.clientId, '');
  assert.equal(SHIPPED_DRIVE_CLIENT.clientSecret, '');
});

test('a filled shipped slot is what makes the one-button experience real', async () => {
  // When this pair is filled, every install has a sign in and the learner has
  // one control and nothing to type.
  const dir = await root();
  const shipped = await LocalDriveCredential.open({
    dbPath: join(dir, 'board.json'),
    editable: true,
    shippedClient: { clientId: 'test-shipped-client', clientSecret: 'test-shipped-secret' },
  });
  assert.equal(shipped.clientConfigured(), true);
  assert.equal(shipped.clientSource(), 'shipped');
  assert.equal(shipped.client()?.clientId, 'test-shipped-client');
});

// ------------------------------------------------- the precedence, all of it

test('precedence is environment, then stored, then shipped', async () => {
  const dir = await root();
  const dbPath = join(dir, 'board.json');
  const shipped = { clientId: 'test-shipped-client', clientSecret: 'test-shipped-secret' };

  // Shipped alone is the floor.
  const floor = await LocalDriveCredential.open({ dbPath, editable: true, shippedClient: shipped });
  assert.equal(floor.clientSource(), 'shipped');

  // A stored client beats it, or route (a) stops being first-class: somebody
  // who made their own project did it precisely so the consent screen names
  // THEIR project, and silently keeping Virgil's would take that away.
  await floor.setClient('test-own-client', 'test-own-secret');
  assert.equal(floor.clientSource(), 'saved');
  assert.equal(floor.client()?.clientId, 'test-own-client');

  // And this install's environment beats both, because whoever set it owns the
  // install. It is also the only source that locks the browser out.
  const operator = await LocalDriveCredential.open({
    dbPath,
    editable: true,
    shippedClient: shipped,
    managedClient: { clientId: 'test-operator-client', clientSecret: 'test-operator-secret' },
  });
  assert.equal(operator.clientSource(), 'operator');
  assert.equal(operator.client()?.clientId, 'test-operator-client');
  assert.equal(operator.editable, false);
});

test('clearing a stored client falls back to the shipped one rather than to nothing', async () => {
  const dir = await root();
  const dbPath = join(dir, 'board.json');
  const shipped = { clientId: 'test-shipped-client', clientSecret: 'test-shipped-secret' };
  const credential = await LocalDriveCredential.open({ dbPath, editable: true, shippedClient: shipped });
  await credential.setClient('test-own-client', 'test-own-secret');

  await credential.clearClient();
  assert.equal(credential.clientConfigured(), true, 'a build with a sign in lost it');
  assert.equal(credential.clientSource(), 'shipped');
});

test('with nothing anywhere there is no client, which is the second of the two states', async () => {
  const dir = await root();
  const none = await LocalDriveCredential.open({
    dbPath: join(dir, 'board.json'),
    editable: true,
    shippedClient: { clientId: '', clientSecret: '' },
  });
  assert.equal(none.clientConfigured(), false);
  assert.equal(none.clientSource(), 'none');
  assert.equal(none.client(), null);
});

test('an operator client in the environment is authoritative and no browser may edit it', async () => {
  const dir = await root();
  const credential = await LocalDriveCredential.open({
    dbPath: join(dir, 'board.json'),
    editable: true,
    managedClient: { clientId: 'test-operator-client', clientSecret: 'test-operator-secret' },
  });
  assert.equal(credential.managed, true);
  assert.equal(credential.editable, false);
  assert.equal(credential.clientSource(), 'operator');
  await assert.rejects(() => credential.setClient('x', 'y'), /managed by the service operator/);
  await assert.rejects(() => credential.clearClient(), /managed by the service operator/);
});

// ----------------------------------------------------------------- the id map

test('the id map round trips and survives a reopen', async () => {
  const dir = await root();
  const dbPath = join(dir, 'board.json');
  const credential = await LocalDriveCredential.open({ dbPath, editable: true });

  assert.deepEqual(await credential.readIds(), { folderId: null, files: {} });
  await credential.writeIds({ folderId: 'folder-1', files: { sources: 'file-1', results: 'file-2' } });

  const reopened = await LocalDriveCredential.open({ dbPath, editable: true });
  assert.deepEqual(await reopened.readIds(), {
    folderId: 'folder-1', files: { sources: 'file-1', results: 'file-2' },
  });
});

test('disconnecting forgets the token and keeps the ids, so reconnecting resumes', async () => {
  const dir = await root();
  const credential = await LocalDriveCredential.open({ dbPath: join(dir, 'board.json'), editable: true });
  await credential.setClient('test-client', 'test-secret');
  await credential.setToken('test-refresh-token', 'scope', '2026-08-24T03:00:00.000Z');
  await credential.writeIds({ folderId: 'folder-1', files: { sources: 'file-1' } });

  await credential.disconnect();

  assert.equal(credential.connected(), false);
  assert.equal(credential.connection().connectedAt, null);
  // §13: nothing in Drive is touched, and the documents are the learner's. The
  // ids stay so that reconnecting the same account rewrites the same five
  // documents rather than making a duplicate set beside them.
  assert.equal((await credential.readIds()).folderId, 'folder-1');
  assert.equal(credential.clientConfigured(), true, 'disconnecting is not the same as forgetting the client');
});

test('clearing the client disconnects too, because a token it cannot refresh is only a stored secret', async () => {
  const dir = await root();
  const credential = await LocalDriveCredential.open({ dbPath: join(dir, 'board.json'), editable: true });
  await credential.setClient('test-client', 'test-secret');
  await credential.setToken('test-refresh-token', 'scope', '2026-08-24T03:00:00.000Z');

  await credential.clearClient();
  assert.equal(credential.connected(), false);
  assert.equal(credential.clientConfigured(), false);
});
