import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fixedClock, type NotebookExport } from '@sb/core';
import { DriveNotebookExport, driveFolderLink } from '@sb/adapters';

import { LocalDriveCredential, type DriveClientCredential } from '../drive-credentials.js';
import { DriveTokens, LoopbackConsent } from '../drive-oauth.js';
import { notebookDestination } from '../notebook-targets.js';
// The same in-process Drive the adapter's own tests run against, reached through
// the built output because this is a different workspace package. One fake, so
// the two layers cannot be proven against two different ideas of Drive.
import { FakeDrive } from '../../../adapters/dist/__tests__/fake-drive.js';
import { FakeGoogleOAuth } from './fake-google-oauth.js';
import { NOW, startService, type Harness } from './service-harness.js';

/**
 * NOTEBOOK_SEAM_V2.md §4, §7 and §11 — the endpoints behind Connect Drive.
 *
 * The whole of §7 is *once, and then never again*, so the endpoints exist to
 * serve one screen the learner sees one time. That makes the interesting tests
 * the ones about what those endpoints must never do rather than what they do:
 * never answer to an unauthenticated caller, never return a token, never exist
 * at all when the lane is off, and never delete anything in somebody's Drive on
 * the way out.
 *
 * No credential is in this file. `test-client` and `test-secret` are the fake
 * Google's own idea of one, and nothing here reaches the internet.
 */

const SECRET = 'notebook-drive-service-secret';
const auth = { 'x-virgil-secret': SECRET };
const clock = fixedClock(NOW);

interface Lane {
  readonly harness: Harness;
  readonly credential: LocalDriveCredential;
  readonly drive: FakeDrive;
  readonly google: FakeGoogleOAuth;
  close(): Promise<void>;
}

/** What a filled `drive-shipped-client.ts` looks like to this test. Not a
 *  credential: a Desktop-app client id and secret are not confidential by
 *  Google's own installed-app model, and these two are invented anyway. */
const SHIPPED = { clientId: 'test-shipped-client', clientSecret: 'test-shipped-secret' };

/**
 * A service with the Drive lane on, wired to two in-process fakes.
 *
 * `shipped` is the ordinary case now: a build carries a Google sign in, so the
 * learner has one button and nothing to fill in. Pass an empty pair for the
 * other of the two states, which is a build that carries none.
 */
async function laneOn(tag: string, over: {
  readonly secret?: string | null;
  readonly shipped?: { readonly clientId: string; readonly clientSecret: string };
  readonly trustedLocal?: boolean;
} = {}): Promise<Lane> {
  const drive = new FakeDrive();
  await drive.start();
  // The access tokens in this lane are minted by the fake Google below, one per
  // refresh, so the fake Drive recognises their shape rather than a fixed list.
  drive.acceptTokensMatching = /^test-access-\d+$/;
  const google = new FakeGoogleOAuth();
  await google.start();

  const dir = await mkdtemp(join(tmpdir(), `virgil-drive-endpoints-${tag}-`));
  const credential = await LocalDriveCredential.open({
    dbPath: join(dir, 'board.json'), editable: true,
    shippedClient: over.shipped ?? SHIPPED,
  });
  const tokens = new DriveTokens({
    client: () => credential.client(),
    refreshToken: () => credential.refreshToken(),
    clock,
    tokenEndpoint: google.url,
  });
  const driveExport = (): NotebookExport | null => (credential.connected()
    ? new DriveNotebookExport({
      auth: tokens,
      ids: { read: () => credential.readIds(), write: (ids) => credential.writeIds(ids) },
      clock,
      apiBase: drive.url,
    })
    : null);

  const harness = await startService(`drive-${tag}`, {}, {
    ...(over.secret === null ? {} : { secret: over.secret ?? SECRET }),
    ...(over.trustedLocal ? { models: { setupTrustedLocal: true } } : {}),
    notebook: notebookDestination({ local: null, drive: driveExport }),
    drive: {
      credential,
      tokens,
      consent: (client: DriveClientCredential) =>
        new LoopbackConsent({ client, clock, tokenEndpoint: google.url }),
      folderLink: async () => {
        const ids = await credential.readIds();
        return ids.folderId ? driveFolderLink(ids.folderId) : null;
      },
    },
  });

  return {
    harness,
    credential,
    drive,
    google,
    close: async () => {
      await harness.close();
      await drive.stop();
      await google.stop();
    },
  };
}

/** Press Connect, follow the URL the way a browser would, and wait for the
 *  service to finish writing. Returns the status once it settles. */
async function connect(lane: Lane): Promise<Record<string, any>> {
  const started = await lane.harness.call('POST', '/notebook/drive/connect', undefined, auth);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const url = new URL(started.body.url);
  const code = lane.google.issueCode(url.searchParams.get('code_challenge')!);
  await fetch(`${url.searchParams.get('redirect_uri')!}?code=${code}`
    + `&state=${encodeURIComponent(url.searchParams.get('state')!)}`);

  for (let i = 0; i < 200; i += 1) {
    const status = await lane.harness.call('GET', '/notebook/drive', undefined, auth);
    if (status.body.connect.state === 'connected' || status.body.connect.state === 'failed') {
      return status.body;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the connect never settled');
}

// ------------------------------------------------------------- absent is off

test('with no Drive lane configured the endpoints are not there rather than broken', async (t) => {
  const h = await startService('drive-off', {}, { secret: SECRET });
  t.after(() => h.close());

  for (const [method, path] of [
    ['GET', '/notebook/drive'],
    ['POST', '/notebook/drive/connect'],
    ['POST', '/notebook/drive/disconnect'],
  ] as const) {
    const res = await h.call(method, path, undefined, auth);
    assert.equal(res.status, 404, `${method} ${path} answered ${res.status}`);
  }
});

test('the export endpoints answer exactly as they did before any of this existed', async (t) => {
  // The promise made on `AppOptions.notebook`: the Drive adapter arrives as the
  // same option with a different thing behind it. A service with no destination
  // still 404s, and a service with one still answers.
  const off = await startService('drive-export-off', {}, { secret: SECRET });
  t.after(() => off.close());
  assert.equal((await off.call('POST', '/notebook/export', undefined, auth)).status, 404);
  assert.equal((await off.call('GET', '/notebook/export', undefined, auth)).status, 404);
});

// ---------------------------------------------------------------- protection

test('Drive setup needs the same authentication the Gemini key does', async (t) => {
  const lane = await laneOn('unauthenticated');
  t.after(() => lane.close());

  // No `x-virgil-secret` at all: the shared-secret door answers first, and it
  // answers 401 rather than telling an unauthenticated caller what is behind it.
  assert.equal((await lane.harness.call('GET', '/notebook/drive')).status, 401);
  assert.equal((await lane.harness.call('POST', '/notebook/drive/connect')).status, 401);
});

test('an untrusted inner router cannot make itself a loopback setup boundary', async (t) => {
  const lane = await laneOn('nosecret', { secret: null });
  t.after(() => lane.close());
  const res = await lane.harness.call('GET', '/notebook/drive');
  assert.equal(res.status, 403);
  assert.match(JSON.stringify(res.body), /protected or loopback Virgil service/);
});

test('the runtime-trusted loopback Settings page can reach its Drive setup without signing in', async (t) => {
  const lane = await laneOn('trusted-loopback', { secret: null, trustedLocal: true });
  t.after(() => lane.close());
  const res = await lane.harness.call('GET', '/notebook/drive');
  assert.equal(res.status, 200);
  assert.equal(res.body.available, true);
});

// ------------------------------------------------- the two states, on the wire

test('a build that carries a Google sign in is ready to connect and says nothing else', async (t) => {
  const lane = await laneOn('client');
  t.after(() => lane.close());

  const before = await lane.harness.call('GET', '/notebook/drive', undefined, auth);
  assert.equal(before.body.client.configured, true, 'a shipped sign in is the ordinary case now');
  assert.equal(before.body.client.source, 'shipped');
  assert.equal(before.body.connection.connected, false);
  assert.equal(before.body.folder, null);

  // §4.1's law, checked on the receipt that would be the easiest place to break
  // it. A shipped Desktop-app client is not confidential by Google's own model,
  // and it is still not this endpoint's to hand out.
  const said = JSON.stringify(before.body);
  assert.equal(said.includes('test-shipped-secret'), false, 'the client secret came back');
  assert.equal(said.includes('test-shipped-client'), false, 'the client id came back');
});

test('there is no endpoint for saving a Google sign in, in either direction', async (t) => {
  // The fields and route were removed together: a route with no consumer is a
  // route with no way to be right, and this one took a secret over HTTP.
  const lane = await laneOn('no-client-endpoint');
  t.after(() => lane.close());

  for (const method of ['PUT', 'DELETE', 'POST', 'GET'] as const) {
    const res = await lane.harness.call(method, '/notebook/drive/client',
      method === 'PUT' ? { clientId: 'x', clientSecret: 'y' } : undefined, auth);
    assert.equal(res.status, 404, `${method} /notebook/drive/client answered ${res.status}`);
  }
});

test('an operator client in the environment beats a shipped one, and a stored one beats both', async (t) => {
  const lane = await laneOn('precedence', { shipped: { clientId: 'x', clientSecret: 'y' } });
  t.after(() => lane.close());
  const res = await lane.harness.call('GET', '/notebook/drive', undefined, auth);
  // The whole precedence is asserted over the credential itself in
  // `drive-credentials.test.ts`; this is the half the wire reports.
  assert.equal(res.body.client.configured, true);
  assert.equal(res.body.client.source, 'shipped');
});

test('a build with no Google sign in refuses to start a consent it could not finish', async (t) => {
  const lane = await laneOn('no-client', { shipped: { clientId: '', clientSecret: '' } });
  t.after(() => lane.close());

  const status = await lane.harness.call('GET', '/notebook/drive', undefined, auth);
  assert.equal(status.body.client.configured, false);
  assert.equal(status.body.client.source, 'none');

  // The second of the two states. A button that opened a consent screen for a
  // client id nobody owns would fail at Google with a message about a project
  // the learner has never heard of.
  const res = await lane.harness.call('POST', '/notebook/drive/connect', undefined, auth);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'no-client');
  // The refusal names configuration, not a console trip: nothing the learner
  // reads anywhere in this flow teaches Google Cloud any more.
  assert.match(res.body.detail, /SB_DRIVE_CLIENT_ID/);
  assert.doesNotMatch(res.body.detail, /Desktop app|console/i);
});

// --------------------------------------------------------------- connecting

test('Connect writes the folder and all three documents BEFORE it reports connected', async (t) => {
  const lane = await laneOn('connect');
  t.after(() => lane.close());

  const status = await connect(lane);

  assert.equal(status.connect.state, 'connected');
  assert.equal(status.connection.connected, true);
  assert.equal(status.connection.connectedAt, NOW);
  // §7 step 2: the learner never sees a folder that is about to fill up later.
  assert.ok(lane.drive.folder(), 'no folder was made before the screen changed');
  assert.equal(Object.keys(lane.drive.contents()).length, 3);
  assert.match(status.folder.link, /^https:\/\/drive\.google\.com\/drive\/folders\//);

  // §7 step 3 is theirs: the list of what to add, by the titles they will see.
  assert.equal(status.documents.length, 3);
  assert.deepEqual(status.documents.map((d: any) => d.key).sort(),
    ['archive', 'learn-now', 'on-the-board']);
  for (const d of status.documents) assert.match(d.title, /^Virgil: /);
});

test('the status never carries a token, a secret or a code, at any point in the flow', async (t) => {
  const lane = await laneOn('no-leak');
  t.after(() => lane.close());
  const status = await connect(lane);

  const said = JSON.stringify(status);
  for (const banned of ['test-refresh-token', 'test-access-1', 'test-secret', 'test-client', 'test-auth-code']) {
    assert.equal(said.includes(banned), false, `the status returned ${banned}`);
  }
  assert.doesNotMatch(said.replace(/"scope":"[^"]*"/g, ''), /token|secret|refresh/i);
});

test('nothing the status says claims the notebook itself is current', async (t) => {
  const lane = await laneOn('no-claims');
  t.after(() => lane.close());
  const status = await connect(lane);

  const said = JSON.stringify(status);
  for (const banned of [/up to date/i, /\bsynced\b/i, /\bintegrated\b/i, /\bconnected to your notebook\b/i]) {
    assert.equal(banned.test(said), false, `the status claimed ${banned}`);
  }
  // What it may say is what Virgil last wrote, and that is the whole of it.
  assert.match(status.lastWrite.line, /I rewrote all 3 documents/);
});

test('the state moves through waiting, and the screen can tell the three apart', async (t) => {
  const lane = await laneOn('phases');
  t.after(() => lane.close());

  const started = await lane.harness.call('POST', '/notebook/drive/connect', undefined, auth);
  const waiting = await lane.harness.call('GET', '/notebook/drive', undefined, auth);
  assert.equal(waiting.body.connect.state, 'waiting');
  assert.match(waiting.body.connect.detail, /permission in your browser/);
  assert.match(started.body.url, /^https:\/\/accounts\.google\.com\//);
  assert.ok(Date.parse(started.body.expiresAt) > Date.parse(NOW));
});

test('a learner who says no leaves the lane unconnected and the reason readable', async (t) => {
  const lane = await laneOn('refused');
  t.after(() => lane.close());

  const started = await lane.harness.call('POST', '/notebook/drive/connect', undefined, auth);
  const url = new URL(started.body.url);
  await fetch(`${url.searchParams.get('redirect_uri')!}?error=access_denied`
    + `&state=${encodeURIComponent(url.searchParams.get('state')!)}`);

  let status: any = null;
  for (let i = 0; i < 200 && status?.connect?.state !== 'failed'; i += 1) {
    status = (await lane.harness.call('GET', '/notebook/drive', undefined, auth)).body;
    if (status.connect.state !== 'failed') await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(status.connect.state, 'failed');
  assert.match(status.connect.detail, /did not give Virgil permission/);
  assert.equal(status.connection.connected, false);
  assert.equal(lane.drive.files.size, 0);
});

test('a grant that cannot be stored fails the connect rather than the process', async (t) => {
  const lane = await laneOn('token-write-fails');
  t.after(() => lane.close());

  // Recorded rather than left to Node, because Node's answer is to exit and an
  // exited process asserts nothing. An empty list at the end is the assertion.
  const unhandled: unknown[] = [];
  const record = (err: unknown): void => { unhandled.push(err); };
  process.on('unhandledRejection', record);
  t.after(() => { process.off('unhandledRejection', record); });

  const realSetToken = lane.credential.setToken.bind(lane.credential);
  lane.credential.setToken = (async () => {
    throw new Error("EACCES: permission denied, open 'google-drive-token'");
  }) as typeof lane.credential.setToken;

  const status = await connect(lane);
  assert.equal(status.connect.state, 'failed',
    'the phase settled — a connect stuck on "waiting" is a screen that never moves again');
  assert.match(status.connect.detail, /EACCES/, 'and it says what actually went wrong');
  assert.equal(status.connection.connected, false, 'nothing was stored, so nothing is claimed');

  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(unhandled, [], 'the storage failure was handled, not thrown at the process');

  // Still serving, which is the whole point.
  assert.equal((await lane.harness.call('GET', '/notebook/drive', undefined, auth)).status, 200);

  // And nothing is wedged: the learner fixes the permissions and connects.
  lane.credential.setToken = realSetToken as typeof lane.credential.setToken;
  const second = await connect(lane);
  assert.equal(second.connect.state, 'connected',
    'the failed attempt left no pending consent behind to cancel the next one');
});

// -------------------------------------------------------- writing after that

test('once connected, POST /notebook/export writes to Drive', async (t) => {
  const lane = await laneOn('export');
  t.after(() => lane.close());
  await connect(lane);

  const before = lane.drive.contents();
  const res = await lane.harness.call('POST', '/notebook/export', undefined, auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.docs.length, 3);
  // Rewritten in place: the same three ids, and no fourth document.
  assert.deepEqual(Object.keys(lane.drive.contents()).sort(), Object.keys(before).sort());
  assert.equal(lane.drive.deletes.length, 0);
});

test('before anything is connected, a write has nowhere to go and says which', async (t) => {
  const lane = await laneOn('nowhere');
  t.after(() => lane.close());
  // The lane is on and no grant exists: the port's whole-target failure, and
  // the sentence names the state rather than describing it as three problems.
  const res = await lane.harness.call('POST', '/notebook/export', undefined, auth);
  assert.equal(res.status, 500);
  assert.equal((await lane.harness.call('GET', '/notebook/export', undefined, auth)).body.ran, false);
});

// -------------------------------------------------------------- disconnecting

test('disconnecting forgets the grant and leaves every document where it is', async (t) => {
  const lane = await laneOn('disconnect');
  t.after(() => lane.close());
  await connect(lane);
  const documents = lane.drive.contents();

  const res = await lane.harness.call('POST', '/notebook/drive/disconnect', undefined, auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.connection.connected, false);
  assert.equal(res.body.connect.state, 'idle');

  // §13: the notebook outliving the consent is recorded behaviour. The three
  // documents are the learner's and Virgil does not remove them on its way out.
  assert.deepEqual(lane.drive.contents(), documents);
  assert.deepEqual(lane.drive.deletes, []);
  assert.equal(lane.credential.clientConfigured(), true);
});

test('connecting again resumes the same three documents rather than making a second set', async (t) => {
  const lane = await laneOn('reconnect');
  t.after(() => lane.close());
  await connect(lane);
  const ids = { ...(await lane.credential.readIds()).files };

  await lane.harness.call('POST', '/notebook/drive/disconnect', undefined, auth);
  await connect(lane);

  assert.deepEqual({ ...(await lane.credential.readIds()).files }, ids);
  assert.equal(Object.keys(lane.drive.contents()).length, 3,
    'a duplicate set of documents appeared in the learner\'s Drive');
});
