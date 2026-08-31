/**
 * The verifier, attacked.
 *
 * This is the only thing standing between a bearer token and somebody else's
 * board, so most of these tests are attempts to get in rather than
 * demonstrations that the front door works.
 *
 * The one that matters most is `alg: none`. A Firebase token under the Auth
 * emulator is genuinely unsigned — the emulator has no private key — so this
 * adapter has a mode that accepts unsigned tokens, and the whole risk is that a
 * token could talk it into that mode. It cannot: the mode is a constructor
 * argument, and a production verifier handed an unsigned token refuses it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { fixedClock } from '@sb/core';
import { FirebaseAuth } from '../firebase-auth.js';

const PROJECT = 'virgil-506009';
const NOW = '2026-08-22T12:00:00.000Z';
const clock = fixedClock(NOW);
const seconds = Math.floor(Date.parse(NOW) / 1000);

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

const claims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sub: 'kZ9xQw2vTbN4pL7yR1sD3fG5hJ8m',
  aud: PROJECT,
  iss: `https://securetoken.google.com/${PROJECT}`,
  iat: seconds - 60,
  exp: seconds + 3600,
  email: 'learner@example.com',
  email_verified: true,
  ...over,
});

/** What the Auth emulator actually issues: header, payload, empty signature. */
const emulatorToken = (over: Record<string, unknown> = {}): string =>
  `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims(over))}.`;

// A real key pair, so the signed path is exercised rather than mocked.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const certs = async (): Promise<Record<string, string>> => ({ 'kid-1': PEM });

function signedToken(over: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const head = b64({ alg: 'RS256', kid: 'kid-1', typ: 'JWT', ...header });
  const body = b64(claims(over));
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  signer.end();
  return `${head}.${body}.${signer.sign(privateKey).toString('base64url')}`;
}

const emulator = (): FirebaseAuth =>
  new FirebaseAuth({ projectId: PROJECT, clock, emulatorHost: '127.0.0.1:9099' });
const production = (over: Partial<{ certs: () => Promise<Record<string, string>> }> = {}): FirebaseAuth =>
  new FirebaseAuth({ projectId: PROJECT, clock, certs: over.certs ?? certs });

// ============================================================ the one that matters

test('a production verifier refuses an unsigned token, whatever it claims to be', async () => {
  // The oldest JWT vulnerability there is. A token does not get to tell the
  // verifier that it needs no verifying.
  assert.equal(await production().verify(emulatorToken()), null);
});

test('an unsigned token carrying a REAL kid is still refused', async () => {
  // Written after mutation-checking the test above and finding it did not bite.
  // `emulatorToken()` has no `kid`, so a verifier that skipped the algorithm
  // check entirely still rejected it at the missing-kid line — the test passed
  // for a reason that has nothing to do with what it is named for.
  //
  // This one names a kid the verifier can actually resolve, so the ONLY thing
  // that can reject it is refusing `alg: none`. An attacker crafts this, not
  // the shape above.
  const head = b64({ alg: 'none', kid: 'kid-1', typ: 'JWT' });
  const token = `${head}.${b64(claims())}.`;
  assert.equal(await production().verify(token), null);
});

test('an unsigned token with a real kid AND a plausible signature is refused', async () => {
  // The nastiest shape: everything a signed token has, except honesty about
  // how it was signed. If the algorithm is read off the token and believed,
  // this is somebody else's board.
  const head = b64({ alg: 'none', kid: 'kid-1', typ: 'JWT' });
  const body = b64(claims({ sub: 'someoneElsesBoardXXXXXXXXXXXX' }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  signer.end();
  assert.equal(await production().verify(`${head}.${body}.${signer.sign(privateKey).toString('base64url')}`), null);
});

test('a production verifier refuses every algorithm it did not ask for', async () => {
  for (const alg of ['none', 'HS256', 'RS512', 'ES256', '', 'rs256']) {
    const token = `${b64({ alg, kid: 'kid-1' })}.${b64(claims())}.AAAA`;
    assert.equal(await production().verify(token), null, alg);
  }
});

test('an emulator verifier is a mode it is PUT in, and refuses a signed token', async () => {
  // The symmetric half: an emulator verifier is not a looser production one,
  // it is a different one, and a token that looks production-shaped is not an
  // emulator token.
  assert.equal(await emulator().verify(signedToken()), null);
  assert.equal(emulator().acceptsUnsigned, true);
  assert.equal(production().acceptsUnsigned, false);
});

test('a token signed by the wrong key does not hold', async () => {
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const head = b64({ alg: 'RS256', kid: 'kid-1', typ: 'JWT' });
  const body = b64(claims());
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  signer.end();
  const forged = `${head}.${body}.${signer.sign(other.privateKey).toString('base64url')}`;
  assert.equal(await production().verify(forged), null);
});

test('a payload edited after signing does not hold', async () => {
  const token = signedToken();
  const [head, , sig] = token.split('.');
  const tampered = `${head}.${b64(claims({ sub: 'someoneElsesBoard' }))}.${sig}`;
  assert.equal(await production().verify(tampered), null);
});

test('a verifier that cannot reach its certificates fails closed', async () => {
  // A network fault must not become an authentication bypass.
  const down = production({ certs: () => Promise.reject(new Error('offline')) });
  assert.equal(await down.verify(signedToken()), null);
});

// ==================================================================== the claims

test('a properly signed token names the learner', async () => {
  const who = await production().verify(signedToken());
  assert.deepEqual(who, { id: 'kZ9xQw2vTbN4pL7yR1sD3fG5hJ8m', email: 'learner@example.com' });
});

test('an emulator token names the learner too, because the claims are checked the same', async () => {
  const who = await emulator().verify(emulatorToken());
  assert.equal(who?.id, 'kZ9xQw2vTbN4pL7yR1sD3fG5hJ8m');
});

test('an unverified email is never returned as an authorization fact', async () => {
  for (const email_verified of [false, undefined, 'true', 1]) {
    const signed = await production().verify(signedToken({ email_verified }));
    const unsigned = await emulator().verify(emulatorToken({ email_verified }));
    assert.equal(signed?.email, null, String(email_verified));
    assert.equal(unsigned?.email, null, String(email_verified));
    assert.ok(signed?.id);
    assert.ok(unsigned?.id);
  }
});

test('a token for another project is refused, signed or not', async () => {
  assert.equal(await production().verify(signedToken({ aud: 'someone-elses-project' })), null);
  assert.equal(await emulator().verify(emulatorToken({ aud: 'someone-elses-project' })), null);
  // The emulator not signing is not a reason for it to mint tokens for other
  // people's projects.
});

test('a token from an issuer that is not the token service is refused', async () => {
  assert.equal(await emulator().verify(emulatorToken({ iss: 'https://evil.example/virgil-506009' })), null);
  assert.equal(await emulator().verify(emulatorToken({ iss: undefined })), null);
});

test('an expired token is refused, and clock skew is tolerated rather than ignored', async () => {
  assert.equal(await emulator().verify(emulatorToken({ exp: seconds - 3600 })), null);
  // Thirty seconds past expiry is inside the default leeway and still good.
  assert.ok(await emulator().verify(emulatorToken({ exp: seconds - 30 })));
  // Ninety is not.
  assert.equal(await emulator().verify(emulatorToken({ exp: seconds - 90 })), null);
});

test('a token with no expiry at all is refused, not treated as forever', async () => {
  assert.equal(await emulator().verify(emulatorToken({ exp: undefined })), null);
  assert.equal(await emulator().verify(emulatorToken({ exp: 'later' })), null);
});

test('a token issued in the future is refused', async () => {
  assert.equal(await emulator().verify(emulatorToken({ iat: seconds + 3600 })), null);
});

test('a subject that could not be a board id is refused at the door', async () => {
  // Held to the board rule HERE rather than trusted and validated further in,
  // because further in it is a filename on one adapter and a document path on
  // another.
  for (const sub of ['../../etc/passwd', 'a/b', '', undefined, '..', 'a'.repeat(129)]) {
    assert.equal(await emulator().verify(emulatorToken({ sub })), null, String(sub));
  }
});

test('a token with no email is still a learner', async () => {
  // An anonymous sign-in has no address and is a person using the product.
  const who = await emulator().verify(emulatorToken({ email: undefined }));
  assert.equal(who?.email, null);
  assert.ok(who?.id);
});

// =================================================================== the shape

test('rubbish is refused without throwing, because rubbish is ordinary', async () => {
  for (const junk of ['', 'x', 'a.b', 'a.b.c.d', '....', 'not a jwt at all', '%%%.%%%.%%%']) {
    assert.equal(await emulator().verify(junk), null, JSON.stringify(junk));
  }
});

test('a segment that decodes to something other than an object is refused', async () => {
  for (const body of [b64('a string'), b64([1, 2]), b64(null), 'bm90IGpzb24']) {
    assert.equal(await emulator().verify(`${b64({ alg: 'none' })}.${body}.`), null, body);
  }
});

test('every rejection is the same answer, and the reason goes to a log instead', async () => {
  // A verifier that explains why a token failed is one that helps somebody find
  // a token that works.
  const reasons: string[] = [];
  const v = new FirebaseAuth({ projectId: PROJECT, clock, emulatorHost: '1', log: (r) => reasons.push(r) });
  assert.equal(await v.verify(emulatorToken({ aud: 'other' })), null);
  assert.equal(await v.verify('junk'), null);
  assert.equal(reasons.length, 2);
  assert.match(reasons[0]!, /aud/);
});

test('a project id is required, because a verifier without one checks nothing', async () => {
  assert.throws(() => new FirebaseAuth({ projectId: '', clock }), /projectId/);
});

test('building a verifier reaches nothing — certificates are fetched on first use', async () => {
  // The boot warm-up fails the suite if any googleapis host is reached while
  // the process starts, and a verifier that dialled out to be built would trip
  // it, correctly.
  let asked = 0;
  const v = new FirebaseAuth({
    projectId: PROJECT, clock,
    certs: async () => { asked += 1; return { 'kid-1': PEM }; },
  });
  assert.equal(asked, 0, 'construction asked for certificates');
  await v.verify(signedToken());
  assert.equal(asked, 1);
  // And cached, so a board's worth of requests is one fetch.
  await v.verify(signedToken());
  assert.equal(asked, 1);
});
