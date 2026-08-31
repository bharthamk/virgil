/**
 * Can two people use one Virgil while remaining isolated from each other's board?
 *
 * Everything under `adapters/__tests__/firebase-auth.test.ts` mints its own
 * tokens, which means it tests the verifier against a local model of what Firebase
 * issues. This runs the real Auth emulator, signs two people up through the
 * real REST API, and drives the real service with the tokens it hands back —
 * so the shape of a token is observed rather than assumed. That distinction is
 * why this probe uses the emulator rather than only a stub.
 *
 * Needs the emulator:
 *   npx firebase emulators:start --only auth --project virgil-506009
 * Then:
 *   node scripts/probe-auth.mjs
 * It starts and stops its own service on a scratch board.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT = 'virgil-506009';
const EMULATOR = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const IDENTITY = `http://${EMULATOR}/identitytoolkit.googleapis.com/v1`;
const PORT = 8795;
const SERVICE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
};

/** A real sign-up through the real endpoint. The emulator accepts any key. */
async function signUp(email, password) {
  const res = await fetch(`${IDENTITY}/accounts:signUp?key=fake-api-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`signUp ${email}: ${res.status} ${await res.text()}`);
  return await res.json();
}

const call = (token, method, path, body) => fetch(`${SERVICE}${path}`, {
  method,
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const capture = (selection) => ({
  type: 'interest',
  envelope: {
    selection,
    parts: [],
    surroundingText: selection,
    headingPath: ['Example'],
    pageTitle: 'A page',
    url: 'https://example.test/page',
    canonicalUrl: null,
    siteName: 'example.test',
    contentLanguage: 'en',
    media: null,
  },
  note: null,
});

async function main() {
  const health = await fetch(`http://${EMULATOR}/`).then((r) => r.json()).catch(() => null);
  if (!health?.authEmulator?.ready) {
    throw new Error(`no Auth emulator on ${EMULATOR} — npx firebase emulators:start --only auth`);
  }
  console.log(`emulator: ready on ${EMULATOR}`);

  const alice = await signUp(`alice-${Date.now()}@example.test`, 'boardpass');
  const bob = await signUp(`bob-${Date.now()}@example.test`, 'boardpass');
  console.log(`signed up: ${alice.localId} and ${bob.localId}`);

  const dir = mkdtempSync(join(tmpdir(), 'virgil-auth-'));
  const service = spawn(process.execPath, ['runner/dist/service.js'], {
    env: {
      ...process.env,
      SB_PORT: String(PORT),
      SB_DB: join(dir, 'store.json'),
      SB_AUTH: `firebase:${PROJECT}@${EMULATOR}`,
      SB_EMBEDDER: 'tfidf',
      SB_WARMUP: 'no',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  service.stdout.on('data', (d) => { log += d; });
  service.stderr.on('data', (d) => { log += d; });

  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      await sleep(250);
      up = await fetch(`${SERVICE}/health`).then((r) => r.ok).catch(() => false);
    }
    if (!up) throw new Error(`service never came up:\n${log}`);
    console.log(`service: ${log.trim().split('\n').pop()}`);

    console.log('\n--- the door ---');
    check('no token is refused', (await call(null, 'GET', '/board')).status === 401);
    check('a token that is not a token is refused',
      (await call('nonsense', 'GET', '/board')).status === 401);
    // The shape an attacker crafts: the emulator's own token, re-signed as if
    // it were production. The verifier is in emulator mode, so this is the
    // symmetric refusal.
    const [h, p] = alice.idToken.split('.');
    check('a token claiming RS256 at an emulator verifier is refused',
      (await call(`${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'x' })).toString('base64url')}.${p}.AAAA`, 'GET', '/board')).status === 401,
      `(header was ${h.slice(0, 12)}…)`);
    check('health needs nothing, and says nothing about anybody', await (async () => {
      const res = await fetch(`${SERVICE}/health`);
      const body = await res.json();
      return res.ok && body.ok === true && !('pins' in body);
    })());

    console.log('\n--- two people ---');
    const a1 = await call(alice.idToken, 'POST', '/pins', capture('alice pinned this passage'));
    const b1 = await call(bob.idToken, 'POST', '/pins', capture('bob pinned a different one'));
    check('alice can pin', a1.status === 201, String(a1.status));
    check('bob can pin', b1.status === 201, String(b1.status));

    const aBoard = await (await call(alice.idToken, 'GET', '/board')).json();
    const bBoard = await (await call(bob.idToken, 'GET', '/board')).json();
    check('alice sees a board', Array.isArray(aBoard.topics));
    check('bob sees a board', Array.isArray(bBoard.topics));

    /**
     * The one that matters, read off the disk rather than off a route.
     *
     * The first draft asked `GET /pins`, which is not a route this service has
     * — so it 404'd, the assertion "alice does not see bob's pin" searched the
     * string `{"error":"not found"}`, and the check passed because it COULD NOT
     * FAIL. A check that cannot fail is worse than a missing one: it reports
     * the property as proven.
     *
     * The boards are two files. That is the evidence.
     */
    const boardFile = (uid) => join(dir, `learner-${uid}.json`);
    const aFile = readFileSync(boardFile(alice.localId), 'utf8');
    const bFile = readFileSync(boardFile(bob.localId), 'utf8');
    check('two learners produced two board files',
      existsSync(boardFile(alice.localId)) && existsSync(boardFile(bob.localId)));
    check('alice\'s board holds alice\'s pin', aFile.includes('alice pinned'));
    check('bob\'s board holds bob\'s pin', bFile.includes('bob pinned'));
    check('alice\'s board does not hold bob\'s pin', !aFile.includes('bob pinned'));
    check('bob\'s board does not hold alice\'s pin', !bFile.includes('alice pinned'));
    check('the single-board file was never written', !existsSync(join(dir, 'store.json')),
      'a learner\'s work must not land in the board nobody signed in to');

    console.log('\n--- the rest of having an account ---');

    // Password reset. The emulator holds the out-of-band codes it would have
    // emailed, which is the only way to check the link is real rather than
    // that the call returned 200.
    const resetKnown = await fetch(`${IDENTITY}/accounts:sendOobCode?key=fake-api-key`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: alice.email }),
    });
    check('a reset for a real address is accepted', resetKnown.ok, String(resetKnown.status));

    const codes = await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT}/oobCodes`)
      .then((r) => r.json()).catch(() => null);
    const reset = (codes?.oobCodes ?? []).find((c) => c.requestType === 'PASSWORD_RESET');
    check('the emulator really issued a reset link', Boolean(reset?.oobLink),
      reset ? String(reset.oobLink).slice(0, 48) + '…' : 'none');

    // The privacy property: an address with no account must not be
    // distinguishable from one that has.
    const resetUnknown = await fetch(`${IDENTITY}/accounts:sendOobCode?key=fake-api-key`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: 'nobody-here@example.test' }),
    });
    const unknownBody = await resetUnknown.json().catch(() => ({}));
    // Firebase DOES tell them apart, which is exactly why the extension refuses
    // to pass this through. Recorded here so the reason is evidence.
    check('the provider distinguishes them, which is why the UI does not',
      resetUnknown.status === 400 && String(unknownBody?.error?.message).startsWith('EMAIL_NOT_FOUND'),
      String(unknownBody?.error?.message));

    // Email verification needs a live token.
    const verify = await fetch(`${IDENTITY}/accounts:sendOobCode?key=fake-api-key`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestType: 'VERIFY_EMAIL', idToken: alice.idToken }),
    });
    check('a verification link is issued for a signed-in learner', verify.ok, String(verify.status));

    console.log('\n--- deleting an account, board first ---');
    // The order that matters: the board goes while the token still works.
    const boardGone = await call(bob.idToken, 'DELETE', '/everything');
    check('the board deletes while the token is alive', boardGone.status === 200);

    const accountGone = await fetch(`${IDENTITY}/accounts:delete?key=fake-api-key`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: bob.idToken }),
    });
    check('the account then deletes', accountGone.ok, String(accountGone.status));

    // And the token is dead afterwards, which is why the board had to go first.
    const afterDelete = await fetch(`${IDENTITY}/accounts:lookup?key=fake-api-key`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: bob.idToken }),
    });
    check('the deleted account can no longer be looked up — so board-first is the only order',
      !afterDelete.ok, String(afterDelete.status));

    console.log('\n--- naming somebody else ---');
    for (const q of [`?learner=${bob.localId}`, `?boardId=learner-${bob.localId}`, `?uid=${bob.localId}`]) {
      const res = await call(alice.idToken, 'GET', `/board${q}`);
      const body = await res.json();
      check(`alice cannot reach bob with ${q}`,
        res.status === 200 && JSON.stringify(body).indexOf('bob pinned') < 0);
    }
  } finally {
    service.kill();
    await sleep(300);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${failures ? `${failures} check(s) FAILED` : 'all checks passed'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
