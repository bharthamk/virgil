import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixedClock } from '@sb/core';

import {
  CONSENT_WINDOW_MS, DRIVE_SCOPE, DriveTokens, GOOGLE_AUTH_ENDPOINT, GOOGLE_TOKEN_ENDPOINT,
  LoopbackConsent, consentUrl, pkce,
} from '../drive-oauth.js';
import { FakeGoogleOAuth } from './fake-google-oauth.js';

/**
 * NOTEBOOK_SEAM_V2.md §4 — the pillar, as things a machine can check.
 *
 * §4 is the part of this design that is not a feature: *"[the learner] isn't
 * connecting their Google Drive to a service I own. It's literally their
 * service, in their setup, connecting to their Drive."* That claim has technical
 * teeth, and teeth are testable. Four of them are asserted here: the redirect is
 * loopback and binds nothing else, the scope is exactly one, the flow is PKCE
 * against a challenge Google checks, and nothing anywhere returns a token.
 *
 * No credential exists in this file. Every string beginning `test-` is the fake
 * Google's own idea of one.
 */

const NOW = '2026-08-24T03:00:00.000Z';
const clock = fixedClock(NOW);
const client = { clientId: 'test-client', clientSecret: 'test-secret' };

// --------------------------------------------------------------- the scope

test('the scope is exactly one, and it is drive.file', () => {
  // §4.2 is a line rather than a default. `auth/drive`, `auth/drive.readonly`
  // and `auth/drive.metadata` are all RESTRICTED, and a restricted scope drags
  // in app verification, a third-party security assessment and a consent screen
  // that reads like a warning. This one needs none of it.
  assert.equal(DRIVE_SCOPE, 'https://www.googleapis.com/auth/drive.file');

  const url = new URL(consentUrl({
    clientId: 'test-client', redirectUri: 'http://127.0.0.1:1/oauth2/drive',
    challenge: 'c', state: 's',
  }));
  assert.deepEqual((url.searchParams.get('scope') ?? '').split(' '), [DRIVE_SCOPE],
    'a second scope is a decision that has to be argued on its own merits');
});

test('the consent URL is Google\'s, asks for a code, and asks for one that lasts', () => {
  const url = new URL(consentUrl({
    clientId: 'test-client', redirectUri: 'http://127.0.0.1:1/oauth2/drive',
    challenge: 'test-challenge', state: 'test-state',
  }));
  assert.equal(`${url.origin}${url.pathname}`, GOOGLE_AUTH_ENDPOINT);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'test-challenge');
  // Without both of these Google returns an access token alone, and the seam
  // would work for an hour and then silently stop writing — which is the exact
  // failure §11 exists to prevent, arriving through the front door.
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
});

test('the verifier is not the challenge, and the challenge is its SHA-256', () => {
  const pair = pkce();
  assert.notEqual(pair.verifier, pair.challenge, 'plain PKCE proves nothing about who spends the code');
  const expected = createHash('sha256').update(pair.verifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(pair.challenge, expected);
  assert.equal(/[+/=]/.test(pair.challenge), false, 'base64url, or the query string mangles it');
});

test('two attempts do not share a verifier', () => {
  assert.notEqual(pkce().verifier, pkce().verifier);
});

// ------------------------------------------------------------- the loopback

test('the listener binds 127.0.0.1 and a port the operating system picked', async () => {
  const consent = new LoopbackConsent({ client, clock });
  const started = await consent.start();
  try {
    const redirect = new URL(started.redirectUri);
    // A consent listener on 0.0.0.0 would be an authorization code arriving
    // over somebody's wifi.
    assert.equal(redirect.hostname, '127.0.0.1');
    assert.equal(redirect.protocol, 'http:');
    assert.equal(redirect.pathname, '/oauth2/drive');
    assert.notEqual(redirect.port, '');
    assert.notEqual(redirect.port, '0');
    assert.equal(new URL(started.url).searchParams.get('redirect_uri'), started.redirectUri);
  } finally { consent.cancel(); }
});

test('the URL says when it stops working, and it is the consent window', async () => {
  const consent = new LoopbackConsent({ client, clock });
  const started = await consent.start();
  try {
    assert.equal(
      Date.parse(started.expiresAt) - Date.parse(NOW),
      CONSENT_WINDOW_MS,
    );
  } finally { consent.cancel(); }
});

test('the redirect completes the grant, and the tab is told to close', async (t) => {
  const google = new FakeGoogleOAuth();
  await google.start();
  t.after(() => google.stop());

  const consent = new LoopbackConsent({ client, clock, tokenEndpoint: google.url });
  const started = await consent.start();
  const url = new URL(started.url);
  const code = google.issueCode(url.searchParams.get('code_challenge')!);

  const landed = await fetch(
    `${started.redirectUri}?code=${code}&state=${encodeURIComponent(url.searchParams.get('state')!)}`,
  );
  const page = await landed.text();
  assert.equal(landed.status, 200);
  assert.match(page, /You can close this tab/);
  // The learner is not told to wait for a folder that fills up later: §7 step 2
  // writes the documents before the screen changes.
  assert.match(page, /writing your documents/);

  const grant = await consent.granted;
  assert.equal(grant.refreshToken, 'test-refresh-token');
  assert.equal(grant.scope, DRIVE_SCOPE);
});

test('a redirect with the wrong state is refused and changes nothing', async (t) => {
  const google = new FakeGoogleOAuth();
  await google.start();
  t.after(() => google.stop());

  const consent = new LoopbackConsent({ client, clock, tokenEndpoint: google.url });
  const started = await consent.start();
  const url = new URL(started.url);
  const code = google.issueCode(url.searchParams.get('code_challenge')!);

  await fetch(`${started.redirectUri}?code=${code}&state=not-the-state`);
  await assert.rejects(consent.granted, /did not come back the way it went out/);
  assert.equal(google.codes.get(code)?.used, false, 'a refused redirect still spent the code');
});

test('any path but the callback is nothing, so a wandering tab finds nothing', async () => {
  const consent = new LoopbackConsent({ client, clock });
  const started = await consent.start();
  try {
    const base = new URL(started.redirectUri).origin;
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/board`)).status, 404);
  } finally { consent.cancel(); }
});

test('a learner who says no is told nothing changed, and the reason names them', async () => {
  const consent = new LoopbackConsent({ client, clock });
  const started = await consent.start();
  const landed = await fetch(`${started.redirectUri}?error=access_denied`
    + `&state=${encodeURIComponent(new URL(started.url).searchParams.get('state')!)}`);
  assert.match(await landed.text(), /Nothing was changed/);
  await assert.rejects(consent.granted, /You did not give Virgil permission/);
});

test('the listener closes once the attempt settles, so a code cannot be replayed at it', async (t) => {
  const google = new FakeGoogleOAuth();
  await google.start();
  t.after(() => google.stop());

  const consent = new LoopbackConsent({ client, clock, tokenEndpoint: google.url });
  const started = await consent.start();
  const url = new URL(started.url);
  const code = google.issueCode(url.searchParams.get('code_challenge')!);
  await fetch(`${started.redirectUri}?code=${code}&state=${encodeURIComponent(url.searchParams.get('state')!)}`);
  await consent.granted;

  await assert.rejects(fetch(started.redirectUri), /fetch failed|ECONNREFUSED/);
});

test('an attempt nobody came back to lapses rather than holding a port all day', async () => {
  const consent = new LoopbackConsent({ client, clock, windowMs: 20 });
  const started = await consent.start();
  await assert.rejects(consent.granted, /took too long/);
  await assert.rejects(fetch(started.redirectUri), /fetch failed|ECONNREFUSED/);
});

test('an access token without a lasting one is a failure, not a partial success', async (t) => {
  const google = new FakeGoogleOAuth();
  await google.start();
  t.after(() => google.stop());
  google.withholdRefreshToken = true;

  const consent = new LoopbackConsent({ client, clock, tokenEndpoint: google.url });
  const started = await consent.start();
  const url = new URL(started.url);
  const code = google.issueCode(url.searchParams.get('code_challenge')!);
  await fetch(`${started.redirectUri}?code=${code}&state=${encodeURIComponent(url.searchParams.get('state')!)}`);

  // An access token alone works for an hour and then leaves a notebook that
  // silently stops being written to.
  await assert.rejects(consent.granted, /did not give me a lasting permission/);
});

test('a wrong verifier does not get a token, which is what PKCE is for', async (t) => {
  const google = new FakeGoogleOAuth();
  await google.start();
  t.after(() => google.stop());

  const consent = new LoopbackConsent({ client, clock, tokenEndpoint: google.url });
  const started = await consent.start();
  const url = new URL(started.url);
  // A code issued against SOMEBODY ELSE's challenge, which is the intercepted
  // -code case the whole mechanism exists for.
  const code = google.issueCode('a-challenge-from-another-attempt');
  await fetch(`${started.redirectUri}?code=${code}&state=${encodeURIComponent(url.searchParams.get('state')!)}`);
  await assert.rejects(consent.granted, /not letting me into your Drive any more|would not complete/);
});

// ---------------------------------------------------------- the access token

test('an access token is fetched once and reused until it is nearly out', async (t) => {
  const google = new FakeGoogleOAuth();
  await google.start();
  t.after(() => google.stop());

  const tokens = new DriveTokens({
    client: () => client,
    refreshToken: () => 'test-refresh-token',
    clock,
    tokenEndpoint: google.url,
  });

  assert.equal(await tokens.accessToken(), 'test-access-1');
  assert.equal(await tokens.accessToken(), 'test-access-1');
  assert.equal(google.accessTokensIssued, 1, 'a token per call is five refreshes a night');

  // After a 401 the adapter asks for a new one regardless of what the cache
  // thinks, because the cache is what was wrong.
  assert.equal(await tokens.accessToken({ refresh: true }), 'test-access-2');
});

test('a token good for no time at all is not cached', async (t) => {
  const google = new FakeGoogleOAuth();
  await google.start();
  t.after(() => google.stop());
  google.expiresIn = 1;

  const tokens = new DriveTokens({
    client: () => client, refreshToken: () => 'test-refresh-token', clock, tokenEndpoint: google.url,
  });
  await tokens.accessToken();
  await tokens.accessToken();
  assert.equal(google.accessTokensIssued, 2);
});

test('a revoked grant says what happened and what fixes it', async (t) => {
  const google = new FakeGoogleOAuth();
  await google.start();
  t.after(() => google.stop());
  google.refreshTokens.clear();

  const tokens = new DriveTokens({
    client: () => client, refreshToken: () => 'test-refresh-token', clock, tokenEndpoint: google.url,
  });
  await assert.rejects(tokens.accessToken(), /access was removed in your Google account/);
});

test('no client and no connection are two different sentences', async () => {
  const noClient = new DriveTokens({
    client: () => null, refreshToken: () => 'test-refresh-token', clock,
  });
  await assert.rejects(noClient.accessToken(), /no Google sign in details/);

  const noToken = new DriveTokens({ client: () => client, refreshToken: () => '', clock });
  await assert.rejects(noToken.accessToken(), /not connected yet/);
});

test('forgetting the cache is what stops a reconnect using the old account\'s token', async (t) => {
  const google = new FakeGoogleOAuth();
  await google.start();
  t.after(() => google.stop());

  const tokens = new DriveTokens({
    client: () => client, refreshToken: () => 'test-refresh-token', clock, tokenEndpoint: google.url,
  });
  assert.equal(await tokens.accessToken(), 'test-access-1');
  tokens.forget();
  assert.equal(await tokens.accessToken(), 'test-access-2');
});

// ------------------------------------------------------------ what is public

test('the endpoints are Google\'s own and are written down once', () => {
  assert.equal(new URL(GOOGLE_AUTH_ENDPOINT).host, 'accounts.google.com');
  assert.equal(new URL(GOOGLE_TOKEN_ENDPOINT).host, 'oauth2.googleapis.com');
  assert.equal(new URL(GOOGLE_AUTH_ENDPOINT).protocol, 'https:');
  assert.equal(new URL(GOOGLE_TOKEN_ENDPOINT).protocol, 'https:');
});

test('the consent URL carries a client id and a challenge, and never a secret', () => {
  const url = consentUrl({
    clientId: 'test-client', redirectUri: 'http://127.0.0.1:1/oauth2/drive',
    challenge: 'test-challenge', state: 'test-state',
  });
  assert.equal(url.includes('test-secret'), false);
  assert.equal(url.includes('client_secret'), false);
});
