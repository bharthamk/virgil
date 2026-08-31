import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '@sb/core';
import {
  FirestoreStore, FirestoreStoreError, FIRESTORE_MODULE, FIRESTORE_PINNED_VERSION,
  classifyFirestoreError, docId, batchKeyOf, sessionBatchKey,
} from '../firestore-store.js';

/**
 * The Firestore adapter's offline half.
 *
 * Everything here runs with no emulator, no network, and no load of the SDK —
 * the pure functions the mapping is built out of, the error taxonomy, and the
 * two refusals that keep this adapter from touching a billed project by
 * accident. The half that needs a running backend is in
 * `firestore-live.test.ts`, gated, and the split is the same one the transport
 * proof drew for the LLM port: *"the contract's assertions run offline against
 * every adapter, and they are the wrong instrument for the question is the
 * transport real."*
 *
 * The error strings asserted below are recorded rather than invented. Every
 * one was produced by a real emulator. A fixture you make up tests your
 * beliefs, not the transport.
 */

// ------------------------------------------------------------ document names

test('a document name escapes what Firestore refuses, and only what it refuses', () => {
  // Measured: `/` is not a document name at all, `.` and `..` are rejected by
  // name, and `__x__` is reserved. Dots, percents and astral characters are
  // fine and are left alone — an encoding that escaped more than it had to
  // would make every id in the database unreadable to a human debugging it.
  assert.equal(docId('p1'), 'p1');
  assert.equal(docId('has.dot'), 'has.dot');
  assert.equal(docId('ünïcode 🧪'), 'ünïcode 🧪');

  assert.equal(docId('a/b'), 'a%2Fb');
  assert.equal(docId('.'), '%.');
  assert.equal(docId('..'), '%..');
  assert.equal(docId('__proto__'), '%__proto__');
  assert.equal(docId(''), '%');
});

test('two different ids never share a document name', () => {
  // The only property the encoding has to have. `%` is escaped first, so a
  // legitimate id cannot forge the escape prefix — `%2F` as an id and `/` as an
  // id must not collide, and neither must `.` and `%.`.
  const ids = ['a/b', 'a%2Fb', '.', '%.', '..', '%..', '__x__', '%__x__', '', '%', 'p1'];
  const names = ids.map(docId);
  assert.equal(new Set(names).size, ids.length, `collision among ${JSON.stringify(names)}`);
});

test('an id too long to be a document name is addressed by digest, and still uniquely', () => {
  // Firestore's name ceiling is 1,500 bytes. Nothing in this product mints an
  // id that long, and "nothing does" is why it would arrive unnoticed.
  const long = 'x'.repeat(2_000);
  assert.match(docId(long), /^%h[0-9a-f]{64}$/);
  assert.notEqual(docId(long), docId(`${long}y`));
});

// ----------------------------------------------------- the per-night idempotency contract's night key

test('the night key is the UTC date of builtAt', () => {
  assert.equal(batchKeyOf('2026-08-19T03:00:00.000Z'), '2026-08-19');
  assert.equal(batchKeyOf('2026-08-19T23:59:59.999Z'), '2026-08-19');
});

test('a retried run and the run it retried land on the same night key', () => {
  // The per-night idempotency contract, stated as the one property that makes the write idempotent: two
  // runs of one night agree on the document path, so the second replaces the
  // first instead of doubling it. The live suite proves the row count; this
  // proves the key does not depend on anything that varies between the two.
  const first = '2026-08-19T03:00:00.000Z';
  const retry = '2026-08-19T03:14:02.511Z';
  assert.equal(batchKeyOf(first), batchKeyOf(retry));
  assert.notEqual(batchKeyOf(first), batchKeyOf('2026-08-20T03:00:00.000Z'));
});

test('a builtAt that is not an instant still keys something rather than throwing', () => {
  // A session with an unparseable timestamp is a bug somewhere else. Refusing
  // to store it would turn that bug into lost work, which is the trade
  // `json-store.ts` already makes when it separates "not there" from "will not
  // parse".
  assert.equal(batchKeyOf('not-a-date'), 'not-a-date');
});

// ------------------------------------------- the persisted batch-identity contract's night, as a field

/** A `Session` with nothing on it but the two fields the night is decided from. */
const row = (over: Partial<Session>): Session => ({
  id: 'a1b2c3d4-0000-4000-8000-000000000000',
  builtAt: '2026-08-21T03:08:41.123Z',
  fromPinCount: 0,
  targetMinutes: 15,
  estimatedMinutes: 0,
  sections: [],
  currentSectionIndex: 0,
  closingNote: null,
  ...over,
});

test('a session that names its night is stored under that name, and no clock is asked', () => {
  /**
   * The persisted batch-identity contract, and the whole of it in two lines.
   *
   * `builtAt` is when the run finished. `batchKey` is which night it was for.
   * They are the same date on almost every night, and the exception is the one
   * that costs a learner a session: a Job task that dies before composing and
   * whose retry finishes after midnight UTC. `batchKeyOf(builtAt)` names that row
   * for the following night; the field names it for its own.
   */
  const retry = row({ builtAt: '2026-08-22T00:03:00.000Z', batchKey: '2026-08-21' });
  assert.equal(sessionBatchKey(retry), '2026-08-21',
    'the document is named for the night the trigger asked for, not for the clock the retry ran on');
  assert.notEqual(sessionBatchKey(retry), batchKeyOf(retry.builtAt),
    'and the two genuinely differ here, or this test is asserting nothing');
});

test('the night a session names is the night it keeps, whatever its clock says', () => {
  // The mutation check. A `sessionBatchKey` that quietly preferred `builtAt`
  // whenever the two disagreed would pass the test above only by accident of
  // which side of midnight the fixture sits on.
  for (const builtAt of [
    '2026-08-20T23:59:59.999Z', '2026-08-21T03:08:00.000Z', '2026-08-22T00:03:00.000Z',
  ]) {
    assert.equal(sessionBatchKey(row({ builtAt, batchKey: '2026-08-21' })), '2026-08-21');
  }
});

test('a session written before the field existed still names a night', () => {
  // Absent is the honest answer for every row persisted before the persisted batch-identity contract, and
  // for those `builtAt` is the only evidence there is. The fallback is the
  // migration path, not a second opinion: a row that carries the field never
  // reaches it.
  assert.equal(sessionBatchKey(row({})), batchKeyOf('2026-08-21T03:08:41.123Z'));
  assert.equal(sessionBatchKey(row({ builtAt: 'not-a-date' })), 'not-a-date');
});

// ---------------------------------------------------------- error taxonomy

test('the three refusals that are facts about the data are told apart', () => {
  // All three arrive as INVALID_ARGUMENT with the distinguishing information
  // only in the message — the transport proof's third defect in a new costume.
  // A caller that reads the status alone cannot tell "that image is too big to
  // sync" from "there is a bug in the adapter", and those need different
  // answers.
  const cases: readonly [string, string][] = [
    ['maximum entity size is 1048576 bytes', 'too-large'],
    ['The value of property "big" is longer than 1048487 bytes.', 'too-large'],
    ['Property media contains an invalid nested entity.', 'too-large'],
    ['Nested arrays are not allowed', 'invalid-value'],
    ['Cannot use "undefined" as a Firestore value (found in field "b").', 'invalid-value'],
    ['Resource id "__reserved__" is invalid because it is reserved.', 'invalid-id'],
  ];
  for (const [message, kind] of cases) {
    const err = classifyFirestoreError(Object.assign(new Error(message), { code: 3 }));
    assert.equal(err.kind, kind, message);
    assert.equal(err.retryable, false, 'a refusal about the data is never worth retrying');
  }
});

test('a transport failure is marked retryable and a refusal is not', () => {
  // The field the runner's degradation policy actually reads. A stage that retries a permission
  // error spins; a stage that gives up on a blip loses a night.
  const of = (code: number): FirestoreStoreError =>
    classifyFirestoreError(Object.assign(new Error('x'), { code }));
  assert.equal(of(14).kind, 'unavailable');
  assert.equal(of(14).retryable, true);
  assert.equal(of(4).retryable, true, 'deadline-exceeded');
  assert.equal(of(10).retryable, true, 'aborted');
  assert.equal(of(8).retryable, true, 'resource-exhausted');
  assert.equal(of(7).kind, 'permission-denied');
  assert.equal(of(7).retryable, false, 'rules do not change because you asked twice');
});

test('an unrecognised failure degrades to unknown rather than to a guess', () => {
  // The safe direction, and the reason the matching is on substrings at all: if
  // a future version rewords a message, an unknown failure is not retried and
  // is not explained away as something it might be.
  const err = classifyFirestoreError(new Error('something nobody has seen yet'));
  assert.equal(err.kind, 'unknown');
  assert.equal(err.retryable, false);
});

test('classifying an already-classified error does not re-wrap it', () => {
  const original = new FirestoreStoreError('too-large', 'the pin is too big');
  assert.equal(classifyFirestoreError(original), original);
});

// -------------------------------------------------------------- the refusals

test('the store refuses to open a client with no emulator host set', async () => {
  // GCP_SETUP_2026-08-20: "Nothing gets deployed to Cloud Run / Firestore /
  // Pub/Sub before credits arrive." There is no database to reach today, and a
  // default that reaches for one is how a local-only build starts spending
  // money — the same sentence `seam-purity.test.ts` uses about an environment
  // variable that happens to be set on somebody's laptop.
  const host = process.env['FIRESTORE_EMULATOR_HOST'];
  delete process.env['FIRESTORE_EMULATOR_HOST'];
  try {
    const store = new FirestoreStore({ boardId: 'nope' });
    await assert.rejects(
      () => store.listPins(),
      (err: unknown) => err instanceof FirestoreStoreError && err.kind === 'production-not-authorised',
      'a store with nowhere safe to write must refuse, not improvise',
    );
  } finally {
    if (host !== undefined) process.env['FIRESTORE_EMULATOR_HOST'] = host;
  }
});

test('the refusal names the way past it, so it is a decision and not an obstacle', async () => {
  const host = process.env['FIRESTORE_EMULATOR_HOST'];
  delete process.env['FIRESTORE_EMULATOR_HOST'];
  try {
    const store = new FirestoreStore({ boardId: 'nope' });
    const err = await store.listPins().then(() => null, (e: unknown) => e as FirestoreStoreError);
    assert.ok(err, 'the store must refuse rather than answer');
    assert.match(err.message, /allowProduction/, 'the flag that lifts it is named');
    assert.match(err.message, /GCP_SETUP/, 'and the ruling that put it there is cited');
  } finally {
    if (host !== undefined) process.env['FIRESTORE_EMULATOR_HOST'] = host;
  }
});

test('the vendor module is named as a string and pinned to an exact version', () => {
  // An alias instead of an exact
  // version is a dependency that moves under a proof nobody re-runs.
  //
  // The string type is now the smaller half of the reason. It kept `tsc` from
  // resolving a package that was usually absent; since the declaration commit
  // the package is present, and what the string preserves is that the adapter's
  // transcribed surface — not the SDK's own `.d.ts` — is what the workspace
  // typechecks against, which is what makes the surface drift test in
  // `firestore-live.test.ts` a check rather than a tautology.
  assert.equal(FIRESTORE_MODULE, '@google-cloud/firestore');
  assert.match(FIRESTORE_PINNED_VERSION, /^\d+\.\d+\.\d+$/, 'exact, never a tag');
});

test('the adapter is exported from the package index, and is the same class', async () => {
  /**
   * **This test used to assert the opposite, and the omission it guarded was a
   * defect wearing a guard's clothes.**
   *
   * The argument was the Gemini adapter's: which backend a learner's board lives
   * in is a composition-root decision made in the commit that makes it, not
   * something a caller acquires by importing the package. That argument is
   * right, and keeping a class out of a barrel is not how it is enforced —
   * `storeChoice` and `firestoreWiring` are, and they are pure functions with
   * their own suite. What the omission actually did was make the production
   * store **unreachable**: both composition roots ask for it by name off the
   * barrel, found nothing, and exited 2 with "this build has no Firestore
   * store". Every firestore spec answered there, so the authorisation gate the
   * store lane built was never once reached in a deployed process.
   *
   * Same class rather than merely a name, because a barrel that re-exported a
   * different symbol would satisfy the composition root and store a board
   * somewhere nobody checked.
   */
  const index = await import('../index.js') as Record<string, unknown>;
  assert.equal(index['FirestoreStore'], FirestoreStore,
    'the package index does not carry the adapter the composition roots ask it for');
});

test('a session written under the old field name still lands on one day', async () => {
  // `batchKey` was `nightKey` until the event-driven processing contract. The field is optional and was
  // never in the committed board, but a running install wrote boards under the
  // old name — and reading it wrong would file one of their sessions under a
  // second key, which is exactly the twice-built day the persisted batch-identity contract closed.
  const legacy = { ...row({}), nightKey: '2026-08-19' } as unknown as Session;
  delete (legacy as { batchKey?: string }).batchKey;
  assert.equal(sessionBatchKey(legacy), '2026-08-19');
  // And the new name wins where both somehow exist.
  assert.equal(sessionBatchKey({ ...legacy, batchKey: '2026-08-20' } as Session), '2026-08-20');
});
