/**
 * The token half of "log in and out, with multiple users".
 *
 * The learning data was never in the browser. What is here is the token that
 * says which board is yours, so these are about not losing it, not sending a
 * stale one, and not saying more to a stranger than they asked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentIdentity, discoverAuthConfig, identityUrl, isAuthConfig, isFresh, isSession, learnerLabel,
  readAuthConfig, refreshedFrom, refreshUrl, sessionFrom, signInRefusal, signInWithGoogle,
  AUTH_CONFIG_KEY, REFRESH_MARGIN_MS, SESSION_KEY,
  type Session,
} from '../identity.js';

const NOW = Date.parse('2026-08-22T12:00:00.000Z');
const session = (over: Partial<Session> = {}): Session => ({
  idToken: 'header.payload.', refreshToken: 'r-1',
  expiresAt: NOW + 3600_000, uid: 'aliceUid', email: 'alice@example.com', ...over,
});

// -------------------------------------------------------------------- config

test('a config needs a project and a key, because a verifier without them checks nothing', () => {
  assert.ok(isAuthConfig({ apiKey: 'k', projectId: 'p' }));
  assert.ok(isAuthConfig({ apiKey: 'k', projectId: 'p', emulatorHost: '127.0.0.1:9099' }));
  for (const bad of [null, {}, { apiKey: 'k' }, { projectId: 'p' }, { apiKey: '', projectId: 'p' },
    { apiKey: 'k', projectId: '' }, { apiKey: 'k', projectId: 'p', emulatorHost: 5 }]) {
    assert.equal(isAuthConfig(bad), false, JSON.stringify(bad));
  }
});

test('an emulator is reached over http and Google-backed identity over https', () => {
  // An emulator over https answers nothing; Google over http is a token in
  // clear text. Neither is a preference.
  const google = { apiKey: 'k', projectId: 'p' };
  assert.match(identityUrl(google, 'signInWithIdp'), /^https:\/\/identitytoolkit\.googleapis\.com\//);
  assert.match(refreshUrl(google), /^https:\/\/securetoken\.googleapis\.com\//);

  const local = { apiKey: 'k', projectId: 'p', emulatorHost: '127.0.0.1:9099' };
  assert.match(identityUrl(local, 'signInWithIdp'), /^http:\/\/127\.0\.0\.1:9099\/identitytoolkit\.googleapis\.com\//);
  assert.match(refreshUrl(local), /^http:\/\/127\.0\.0\.1:9099\/securetoken\.googleapis\.com\//);
});

test('a key with url characters in it is encoded rather than concatenated', () => {
  assert.match(identityUrl({ apiKey: 'a&b=c', projectId: 'p' }, 'signInWithIdp'), /key=a%26b%3Dc$/);
});

test('the public extension does not silently use somebody else’s account tenant', async (t) => {
  const c = installChrome({ store: {} });
  t.after(() => c.uninstall());
  (globalThis.chrome.runtime as typeof chrome.runtime & { getManifest(): chrome.runtime.Manifest })
    .getManifest = () => ({ manifest_version: 3, name: 'Virgil', version: '0.1.0' });
  assert.equal(await readAuthConfig(), null);
});

test('a missed install write is recovered from that self-hosted service, not a central tenant', async (t) => {
  const config = { apiKey: 'public-key', projectId: 'self-hosted-project' };
  const c = installChrome({ store: {} });
  t.after(() => c.uninstall());
  c.fetchHandler = (url) => {
    assert.equal(url, 'https://virgil.example/app/config.json');
    return jsonResponse({ authConfig: config, googleWebClientId: 'public-client.apps.googleusercontent.com' });
  };

  assert.deepEqual(await discoverAuthConfig('https://virgil.example'), config);
  assert.deepEqual(c.store[AUTH_CONFIG_KEY], config);
});

test('public config that cannot identify a verifier is not installed hopefully', async (t) => {
  const c = installChrome({ store: {} });
  t.after(() => c.uninstall());
  c.fetchHandler = () => jsonResponse({ authConfig: { apiKey: '', projectId: 'p' } });

  assert.equal(await discoverAuthConfig('https://virgil.example'), null);
  assert.equal(c.store[AUTH_CONFIG_KEY], undefined);
});

test('an installed deployment config wins without reaching another address', async (t) => {
  const config = { apiKey: 'installed-key', projectId: 'installed-project' };
  const c = installChrome({ store: { [AUTH_CONFIG_KEY]: config } });
  t.after(() => c.uninstall());

  assert.deepEqual(await discoverAuthConfig('https://anything.example'), config);
  assert.equal(c.requests.length, 0);
});

test('Google identity is exchanged for the self-hosted deployment token', async (t) => {
  const config = { apiKey: 'fake-api-key', projectId: 'virgil-506009', emulatorHost: '127.0.0.1:9099' };
  const googleIdToken = 'google.header.payload.';
  const c = installChrome({ store: { [AUTH_CONFIG_KEY]: config }, googleToken: googleIdToken });
  t.after(() => c.uninstall());
  c.fetchHandler = (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.match(String(body['postBody']), /id_token=google\.header\.payload\.&providerId=google\.com/);
    assert.equal(body['requestUri'], 'https://stub-extension-id.chromiumapp.org/');
    return jsonResponse({
      idToken: 'firebase.header.payload.', refreshToken: 'firebase-refresh', expiresIn: '3600',
      localId: 'googleLearner', email: 'learner@example.com',
    });
  };
  const out = await signInWithGoogle(NOW);
  assert.equal(out.refusal, null);
  assert.equal(out.session?.uid, 'googleLearner');
  assert.equal((c.store[SESSION_KEY] as Session).idToken, 'firebase.header.payload.');
});

test('dismissing Google changes nothing and returns to the same screen', async (t) => {
  const c = installChrome({
    store: { [AUTH_CONFIG_KEY]: { apiKey: 'k', projectId: 'p' } },
    googleSignInFails: true,
  });
  t.after(() => c.uninstall());
  const out = await signInWithGoogle(NOW);
  assert.equal(out.session, null);
  assert.match(out.refusal ?? '', /did not finish.*Nothing was changed/);
  assert.equal(c.store[SESSION_KEY], undefined);
});

// ------------------------------------------------------------------- sessions

test('a sign-in reply becomes a session with an absolute expiry', () => {
  // `expiresIn` is relative seconds as a STRING, and storing it raw is how a
  // token becomes permanently fresh or permanently stale.
  const s = sessionFrom({
    idToken: 'a.b.', refreshToken: 'r', localId: 'aliceUid',
    email: 'alice@example.com', expiresIn: '3600',
  }, NOW);
  assert.deepEqual(s, {
    idToken: 'a.b.', refreshToken: 'r', uid: 'aliceUid',
    email: 'alice@example.com', expiresAt: NOW + 3600_000,
  });
});

test('a reply missing anything load-bearing is refused, not guessed at', () => {
  const full = { idToken: 'a.b.', refreshToken: 'r', localId: 'u', expiresIn: '3600' };
  for (const key of ['idToken', 'refreshToken', 'localId', 'expiresIn']) {
    const partial = { ...full, [key]: undefined };
    assert.equal(sessionFrom(partial, NOW), null, key);
  }
  // A lifetime that is not a positive number is not a lifetime.
  assert.equal(sessionFrom({ ...full, expiresIn: '0' }, NOW), null);
  assert.equal(sessionFrom({ ...full, expiresIn: 'soon' }, NOW), null);
  assert.equal(sessionFrom(null, NOW), null);
});

test('an account with no email is still somebody', () => {
  const s = sessionFrom({ idToken: 'a.b.', refreshToken: 'r', localId: 'u', expiresIn: '3600' }, NOW);
  assert.equal(s?.email, null);
});

test('a refresh keeps who you are and moves only the token', () => {
  // The refresh endpoint answers snake_case and carries no email. Refreshing a
  // token does not change which account it is.
  const next = refreshedFrom({ id_token: 'new.token.', refresh_token: 'r-2', expires_in: '3600' },
    session(), NOW + 3000_000);
  assert.equal(next?.idToken, 'new.token.');
  assert.equal(next?.refreshToken, 'r-2');
  assert.equal(next?.uid, 'aliceUid');
  assert.equal(next?.email, 'alice@example.com');
  assert.equal(next?.expiresAt, NOW + 3000_000 + 3600_000);
});

test('a refresh that does not return a new refresh token keeps the old one', () => {
  const next = refreshedFrom({ id_token: 'new.token.', expires_in: '3600' }, session(), NOW);
  assert.equal(next?.refreshToken, 'r-1');
});

test('a refusal to refresh is null, so the caller signs out rather than sending rubbish', () => {
  assert.equal(refreshedFrom({ error: 'TOKEN_EXPIRED' }, session(), NOW), null);
  assert.equal(refreshedFrom(null, session(), NOW), null);
});

test('a token is refreshed before it expires, not after', () => {
  // A token that expires mid-request is a 401 on a pin somebody just made.
  assert.equal(isFresh(session({ expiresAt: NOW + 3600_000 }), NOW), true);
  assert.equal(isFresh(session({ expiresAt: NOW + REFRESH_MARGIN_MS + 1 }), NOW), true);
  assert.equal(isFresh(session({ expiresAt: NOW + REFRESH_MARGIN_MS - 1 }), NOW), false);
  assert.equal(isFresh(session({ expiresAt: NOW - 1 }), NOW), false);
});

test('concurrent personal reads share one rotating-token refresh', async (t) => {
  const stale = session({ expiresAt: NOW + REFRESH_MARGIN_MS - 1 });
  const c = installChrome({ store: { [AUTH_CONFIG_KEY]: CONFIG, [SESSION_KEY]: stale } });
  t.after(() => c.uninstall());
  let answer!: (value: ReturnType<typeof jsonResponse>) => void;
  c.fetchHandler = () => new Promise((resolve) => { answer = resolve; });

  const first = currentIdentity(NOW);
  const second = currentIdentity(NOW);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(c.requests.length, 1, 'room reads must not each rotate the same token');

  answer(jsonResponse({ id_token: 'fresh.token.', refresh_token: 'r-2', expires_in: '3600' }));
  assert.deepEqual(await Promise.all([first, second]), [
    { uid: stale.uid, token: 'fresh.token.' },
    { uid: stale.uid, token: 'fresh.token.' },
  ]);
  assert.equal((c.store[SESSION_KEY] as Session).refreshToken, 'r-2');
});

test('an old refresh reply cannot erase an account chosen while it was in flight', async (t) => {
  const stale = session({ expiresAt: NOW + REFRESH_MARGIN_MS - 1 });
  const newer = session({
    uid: 'bobUid', email: 'bob@example.com', idToken: 'bob.token.',
    refreshToken: 'bob-refresh', expiresAt: NOW + 3600_000,
  });
  const c = installChrome({ store: { [AUTH_CONFIG_KEY]: CONFIG, [SESSION_KEY]: stale } });
  t.after(() => c.uninstall());
  let answer!: (value: ReturnType<typeof jsonResponse>) => void;
  c.fetchHandler = () => new Promise((resolve) => { answer = resolve; });

  const old = currentIdentity(NOW);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await chrome.storage.local.set({ [SESSION_KEY]: newer });
  answer(jsonResponse({ error: 'TOKEN_EXPIRED' }, 400));

  assert.equal(await old, null, 'the old request does not borrow the new account');
  assert.deepEqual(c.store[SESSION_KEY], newer, 'nor does it sign the new account out');
});

test('a stored session of the wrong shape is not a session', () => {
  assert.ok(isSession(session()));
  for (const bad of [null, {}, session({ idToken: '' }), session({ uid: '' }),
    { ...session(), expiresAt: 'later' }, { ...session(), email: 5 }]) {
    assert.equal(isSession(bad), false, JSON.stringify(bad));
  }
});

// ------------------------------------------------------------------ refusals

test('the refusals a learner can act on say what to do', () => {
  assert.match(signInRefusal('OPERATION_NOT_ALLOWED'), /Google sign-in is not ready/);
  assert.match(signInRefusal('INVALID_IDP_RESPONSE'), /Google could not confirm/);
  assert.match(signInRefusal('TOO_MANY_ATTEMPTS_TRY_LATER'), /Wait a minute/);
});

test('a code nobody wrote a sentence for does not reach the learner', () => {
  const refusal = signInRefusal('SOME_NEW_FIREBASE_CONSTANT', 400);
  assert.ok(!refusal.includes('SOME_NEW_FIREBASE_CONSTANT'), refusal);
  assert.match(refusal, /mine to fix/);
});

test('a service that was never reached is told apart from one that refused', () => {
  // The same distinction every other screen in this product now keeps.
  assert.match(signInRefusal(undefined), /isn't responding/);
  assert.match(signInRefusal(undefined, 503), /could not finish/);
  assert.doesNotMatch(signInRefusal(undefined, 503), /503|status|response/i);
});

test('provider codes carrying a trailing explanation still match', () => {
  assert.match(signInRefusal('OPERATION_NOT_ALLOWED : Provider disabled'), /Google sign-in/);
});

// --------------------------------------------------------------------- naming

test('a learner is named by their address, and never by a bare uid', () => {
  assert.equal(learnerLabel(session()), 'alice@example.com');
  assert.equal(learnerLabel(session({ email: null, uid: 'kZ9xQw2vTbN4pL7yR1sD3fG5hJ8m' })), 'Account kZ9xQw');
  assert.equal(learnerLabel(null), null);
});

// ============================================ the rest of having an account

/**
 * Google owns recovery and verification. Virgil owns deletion, whose ORDER is
 * the whole design.
 */
import {
  deleteAccount,
} from '../identity.js';
import { installChrome, jsonResponse, type ChromeStub } from './chrome-stub.js';

const CONFIG = { apiKey: 'fake-api-key', projectId: 'virgil-506009', emulatorHost: '127.0.0.1:9099' };
const live = (over: Partial<Session> = {}): Session => ({
  idToken: 'a.b.', refreshToken: 'r', expiresAt: Date.now() + 3600_000,
  uid: 'aliceUid', email: 'alice@example.com', ...over,
});

/** A browser with a provider configured and, optionally, somebody signed in. */
function browser(t: { after(fn: () => void): void }, signedIn = true, replies: Record<string, unknown> = {}): ChromeStub {
  const c = installChrome({
    store: { [AUTH_CONFIG_KEY]: CONFIG, ...(signedIn ? { [SESSION_KEY]: live() } : {}) },
  });
  t.after(() => c.uninstall());
  c.fetchHandler = (url: string) => {
    const hit = Object.entries(replies).find(([k]) => url.includes(k));
    const value = hit?.[1] ?? { ok: true };
    const status = (value as { status?: number }).status ?? 200;
    return {
      ok: status < 400, status,
      json: async () => value,
      text: async () => JSON.stringify(value),
    } as unknown as Response;
  };
  return c;
}

// -------------------------------------------------------------- deletion

test('the board is deleted BEFORE the account, because the token is the only way in', async (t) => {
  // The whole design of this function. Deleting the Firebase account first
  // revokes the token that is the only way to reach the board, and the
  // learner's data sits on the service for ever with nobody left who can ask
  // for it — the opposite of what they pressed the button for.
  const order: string[] = [];
  const c = browser(t, true, { 'accounts:delete': { ok: true } });
  const inner = c.fetchHandler!;
  c.fetchHandler = (url: string, init?: RequestInit) => {
    if (url.includes('accounts:delete')) order.push('account');
    return inner(url, init);
  };
  const out = await deleteAccount(async () => { order.push('board'); return true; });
  assert.equal(out.gone, true);
  assert.deepEqual(order, ['board', 'account']);
  assert.equal(c.store[SESSION_KEY], null, 'and the token is dropped');
});

test('a board that will not delete leaves the account alone entirely', async (t) => {
  // A half-deleted account is worse than one that is still there.
  const c = browser(t, true);
  let accountTouched = false;
  const inner = c.fetchHandler!;
  c.fetchHandler = (url: string, init?: RequestInit) => {
    if (url.includes('accounts:delete')) accountTouched = true;
    return inner(url, init);
  };
  const out = await deleteAccount(async () => false);
  assert.equal(out.gone, false);
  assert.equal(accountTouched, false);
  assert.match(out.note, /have not touched your account/);
  assert.ok(c.store[SESSION_KEY], 'and they are still signed in');
});

test('a board deleted and an account that would not be is said, not reported as success', async (t) => {
  // They will otherwise find they can still sign in and will not know what
  // happened to their work.
  const c = browser(t, true, { 'accounts:delete': { status: 500 } });
  const out = await deleteAccount(async () => true);
  assert.equal(out.gone, false);
  assert.match(out.note, /board is deleted/);
  assert.match(out.note, /account itself could not be removed/);
  assert.equal(c.store[SESSION_KEY], null);
});

test('deletion needs somebody signed in', async (t) => {
  browser(t, false);
  let asked = false;
  const out = await deleteAccount(async () => { asked = true; return true; });
  assert.equal(out.gone, false);
  assert.equal(asked, false, 'and it does not delete a board on nobody\'s behalf');
});
