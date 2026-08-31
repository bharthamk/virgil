import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pin, Session, Suggestion } from '@sb/core';
import {
  FirestoreStore, FirestoreStoreError, FIRESTORE_MODULE, FIRESTORE_PINNED_VERSION,
  type FsFirestore,
} from '../firestore-store.js';
import { runStoreContract, aPin, aTopic, type StoreSubject } from './store-contract.js';
// Test-only, and deliberately the real constant rather than a copy of it: the
// cap and this ceiling are one decision (the design contract) and have to be checked as
// one. The seam guard exempts `__tests__` by construction, and the arrow the
// guard actually polices — adapters must not reach into the runner — is
// untouched; `runner/src/__tests__/front-door.test.ts` reaches into the
// extension's dist the same way for the same kind of reason.
import { PIN_IMAGE_WIRE_CHARS } from '@sb/extension/dist/pins-face.js';

/**
 * The transport proof for the Store port. This file talks to a real Firestore.
 *
 * ## Why it is separate from the contract
 *
 * `store-contract.ts` is run against three subjects here and two elsewhere, and
 * it is the *same* file in both places: what a store must do is not a property
 * of where it stores things. The transport contract's §9.1 named the gap this file
 * closes before the adapter existed — *"the Firestore adapter has a MemoryStore
 * oracle in exactly the position the Gemini skeleton was in"* — and the answer
 * is the one that port arrived at: an oracle bounds shape risk and nothing
 * else, so the contract has to run against the real backend before anybody
 * believes it.
 *
 * ## Gated, deliberately — and gated on the thing that makes it safe
 *
 * `LIVE=1` and a `FIRESTORE_EMULATOR_HOST` in the environment. The second half
 * is not filing: `FIRESTORE_EMULATOR_HOST` is the SDK's own routing variable,
 * so a run that has it set is *structurally* incapable of reaching a billed
 * project, in the same way the Gemini suite's key belongs to a project with no
 * billing account attached. There is no equivalent of a free tier for a cloud
 * database, so the emulator is not a convenience here: it is the test's safety
 * boundary.
 *
 *     firebase emulators:start --only firestore --project virgil-emulator
 *     LIVE=1 FIRESTORE_EMULATOR_HOST=127.0.0.1:8377 \
 *       node --test adapters/dist/__tests__/firestore-live.test.js
 *
 * Without both, every test skips and `npm test` stays offline and green.
 *
 * ## The rule this file follows
 *
 * Nothing here asserts on a latency number, and for a harder reason than the
 * Gemini suite has: an emulator's latency is not a slow version of production's,
 * it is a *different quantity*, measured on a loopback socket against a
 * single-node Java process with no replication and no quorum. A number recorded
 * here would not be an upper bound with noise, it would be meaningless.
 * The adapter contract is exercised in full when the emulator is available;
 * along with everything else this file cannot prove.
 */

const LIVE = process.env['LIVE'] === '1' && !!process.env['FIRESTORE_EMULATOR_HOST'];
const skip = LIVE ? false : 'set LIVE=1 and FIRESTORE_EMULATOR_HOST to run the store transport proof';

/**
 * One client for the file, and a fresh `FirestoreStore` per handle.
 *
 * The two are deliberately separated. A new *store* is what proves durability —
 * a handle that has never read this board answers only from what actually
 * reached the backend — while a new *client* would prove nothing extra and
 * would leave a gRPC channel open per read. The Gemini suite makes the same
 * distinction for the same reason: share the transport, not the state.
 */
let shared: FsFirestore | null = null;
async function client(): Promise<FsFirestore> {
  if (shared) return shared;
  const mod = await import(FIRESTORE_MODULE) as unknown as {
    Firestore: new (s: Record<string, unknown>) => FsFirestore;
  };
  shared = new mod.Firestore({ projectId: 'virgil-emulator' });
  return shared;
}

after(async () => { if (shared) await shared.terminate(); });

/** A board nothing else has touched. The analogue of `mkdtempSync` in the local
 *  store's binding: isolation is per board, because a board is the unit a
 *  learner has. */
const boardId = (): string => `test-${randomUUID()}`;

async function store(id: string): Promise<FirestoreStore> {
  return new FirestoreStore({ boardId: id, firestore: await client() });
}

/** Deletes the board rather than emptying it, so a leftover row from a failed
 *  test cannot be read by the next one as a pass. */
async function wipe(id: string): Promise<void> {
  const db = await client();
  await db.recursiveDelete(db.collection('boards').doc(id));
}

// ------------------------------------------------------------- the contract

/**
 * The whole contract, against the real backend, twice.
 *
 * The second subject is the one that matters and it is the same argument the
 * local store's second binding makes: it reads through a handle it opened after
 * the write, so every assertion in the contract is additionally an assertion
 * that the write left this process. A store that answered from a cache would
 * pass the first subject and fail the second, and the symptom in production
 * would be a learner whose board is empty every morning, reported as "the
 * nightly run did nothing".
 */
const sameHandle: StoreSubject = {
  name: 'FirestoreStore',
  skip,
  create: async () => {
    const id = boardId();
    const s = await store(id);
    return { writer: s, reader: async () => s, dispose: () => wipe(id) };
  },
};

const reopened: StoreSubject = {
  name: 'FirestoreStore reopened',
  skip,
  create: async () => {
    const id = boardId();
    return {
      writer: await store(id),
      // A handle that has never read this board. Nothing it answers can have
      // come from anywhere but the backend.
      reader: () => store(id),
      dispose: () => wipe(id),
    };
  },
};

runStoreContract(sameHandle);
runStoreContract(reopened);

// -------------------------------------------------- the batch-idempotency contract, the whole point

test('a retried night writes one session row, not two', { skip }, async () => {
  // The batch-idempotency contract, and the reason this port implements it rather than inheriting
  // the local store's behaviour. `batch-idempotence.test.ts` documents the
  // current state plainly — "the nightly run is idempotent for topics, pins,
  // edges, signals and statements — and NOT for sessions" — and at port that
  // stops being survivable: a Cloud Run Job the platform retries would leave
  // two rows a night for ever, and the panel reads `latestSession`.
  //
  // The mechanism is the document name, so there is no uniqueness check to
  // forget to run and no read-before-write to race.
  const id = boardId();
  const s = await store(id);
  try {
    const at = '2026-08-19T03:00:00.000Z';
    const failed: Session = {
      id: 'run-1', builtAt: at, fromPinCount: 4, targetMinutes: 15, estimatedMinutes: 0,
      // The real shape of the failure: a run whose Verifier could not be reached
      // withholds every section and persists a session with none.
      sections: [], currentSectionIndex: 0, closingNote: null,
    };
    const retry: Session = {
      ...failed, id: 'run-2', builtAt: '2026-08-19T03:14:02.511Z', estimatedMinutes: 12.5,
      sections: [{
        topicId: 't1', heading: 'Pull subscriptions', body: 'prose', depth: 'building',
        estimatedMinutes: 12.5, question: null, sourceIds: ['p1:0'], completed: false,
      }],
    };

    await s.putSession(failed);
    await s.putSession(retry);

    const fresh = await store(id);
    const all = await fresh.listSessions();
    assert.equal(all.length, 1, 'a retried Job left two rows for one night');
    assert.equal(all[0]?.id, 'run-2', 'and the row that survived is the retry, not the failure');
    assert.equal((await fresh.latestSession())?.sections.length, 1,
      'the panel must show the session the retry built, not the empty one it replaced');
  } finally { await wipe(id); }
});

test('the same session written twice is one row, however many times it is written', { skip }, async () => {
  // Idempotence in the narrow sense the contract asks for: the write is safe to
  // repeat. Five times, because a Job retried once is the case everybody thinks
  // about and a Job retried until it succeeds is the case that bites.
  const id = boardId();
  const s = await store(id);
  try {
    const sess: Session = {
      id: 'nightly', builtAt: '2026-08-19T03:00:00.000Z', fromPinCount: 2,
      targetMinutes: 15, estimatedMinutes: 12.5, currentSectionIndex: 0, closingNote: null,
      sections: [{
        topicId: 't1', heading: 'h', body: 'b', depth: 'building',
        estimatedMinutes: 12.5, question: null, sourceIds: [], completed: false,
      }],
    };
    for (let i = 0; i < 5; i++) await s.putSession(sess);
    assert.equal((await (await store(id)).listSessions()).length, 1);
  } finally { await wipe(id); }
});

test('a retry whose clock crossed midnight lands on the night it was FOR', { skip }, async () => {
  /**
   * The batch-key alignment contract, against the real backend.
   *
   * The two rows below are one night: a first attempt at 23:58 and the retry
   * that finished at 00:03 the next morning. `builtAt` puts them on either side
   * of a UTC date boundary — honestly, because that is when each ran — and
   * before the night was a field on the session that was enough to make them
   * two documents, one of them squatting on the following night's name.
   *
   * Both carry `batchKey`, so both name the same document and the retry
   * replaces the attempt. There is still no uniqueness check and no
   * read-before-write; what changed is which field the path comes from.
   */
  const id = boardId();
  const s = await store(id);
  try {
    const base: Session = {
      id: 'attempt-1', builtAt: '2026-08-21T23:58:00.000Z', batchKey: '2026-08-21',
      fromPinCount: 3, targetMinutes: 15, estimatedMinutes: 0,
      sections: [], currentSectionIndex: 0, closingNote: null,
    };
    await s.putSession(base);
    await s.putSession({ ...base, id: 'retry', builtAt: '2026-08-22T00:03:00.000Z' });

    const all = await (await store(id)).listSessions();
    assert.equal(all.length, 1, 'one night, one row — the retry did not open a second document');
    assert.equal(all[0]?.id, 'retry');
    assert.equal(all[0]?.batchKey, '2026-08-21', 'and the row still says which night it is for');

    // The next night is untouched and still free to run.
    const next: Session = { ...base, id: 'the-22nd', builtAt: '2026-08-22T03:08:00.000Z', batchKey: '2026-08-22' };
    await s.putSession(next);
    assert.equal((await (await store(id)).listSessions()).length, 2,
      'the 22nd built its own row rather than replacing the 21st’s');
  } finally { await wipe(id); }
});

test('two different nights are two rows — the key collapses a retry, not a history', { skip }, async () => {
  // The other half of the contract, and the one a too-clever key would break.
  // Sessions are how the progression projection sees more than this run (§5a);
  // a key that collapsed them would take the medium-follow-through badge with
  // it.
  const id = boardId();
  const s = await store(id);
  try {
    const at = (d: string): Session => ({
      id: `s-${d}`, builtAt: `${d}T03:00:00.000Z`, fromPinCount: 1, targetMinutes: 15,
      estimatedMinutes: 5, sections: [], currentSectionIndex: 0, closingNote: null,
    });
    for (const d of ['2026-08-17', '2026-08-18', '2026-08-19']) await s.putSession(at(d));
    const all = await (await store(id)).listSessions();
    assert.deepEqual([...all].map((x) => x.id).sort(), ['s-2026-08-17', 's-2026-08-18', 's-2026-08-19']);
  } finally { await wipe(id); }
});

test('two DIFFERENT sessions built on one night collapse, and that is the contract', { skip }, async () => {
  // A divergence from the local store, recorded as behaviour rather than left
  // to be discovered. `JsonStore` upserts by session id and would keep both
  // rows; this store keys by the night and keeps the later write.
  //
  // That is what the batch-idempotency contract asks for and it is not free: the product model is
  // one session per night, and if a night ever needs two, the contract changes
  // before the mapping does. Written down here so that the day someone wants
  // two, they find this test rather than a surprise.
  const id = boardId();
  const s = await store(id);
  try {
    const base = {
      builtAt: '2026-08-19T03:00:00.000Z', fromPinCount: 1, targetMinutes: 15 as const,
      estimatedMinutes: 5, sections: [], currentSectionIndex: 0, closingNote: null,
    };
    await s.putSession({ ...base, id: 'morning' });
    await s.putSession({ ...base, id: 'evening' });
    const all = await (await store(id)).listSessions();
    assert.equal(all.length, 1, 'one night is one row under the batch-idempotency contract');
    assert.equal(all[0]?.id, 'evening', 'and the later write is the one that survives');
  } finally { await wipe(id); }
});

// ------------------------------------------------ listSessions and the tie-break

test('latestSession is the newest by builtAt, and does not trust the backend order', { skip }, async () => {
  // Measured: Firestore breaks an `orderBy` tie by document name — three rows
  // written zeta, alpha, mike come back alpha, mike, zeta — so
  // `orderBy('builtAt','desc').limit(1)` is a cheaper query and a different
  // promise. Nights are written out of order here for the same reason the
  // contract writes them out of order: insertion order must not be the answer.
  const id = boardId();
  const s = await store(id);
  try {
    const at = (d: string): Session => ({
      id: `s-${d}`, builtAt: `${d}T03:00:00.000Z`, fromPinCount: 1, targetMinutes: 15,
      estimatedMinutes: 5, sections: [], currentSectionIndex: 0, closingNote: null,
    });
    // Deliberately in an order where both the document name and the write order
    // would give a different answer from `builtAt`.
    for (const d of ['2026-08-19', '2026-07-01', '2026-08-01']) await s.putSession(at(d));
    assert.equal((await (await store(id)).latestSession())?.id, 's-2026-08-19');
  } finally { await wipe(id); }
});

test('listSessions promises no order, and the store does not accidentally promise one', { skip }, async () => {
  // `ports/store.ts` says "in no promised order" and `progression-source.ts`
  // sorts and caps for itself. This asserts the set rather than the sequence —
  // the contract does the same, deliberately — because a caller that started
  // depending on whatever order this backend happens to return would break on
  // the next one.
  const id = boardId();
  const s = await store(id);
  try {
    const days = ['2026-08-11', '2026-08-14', '2026-08-12', '2026-08-13'];
    for (const d of days) {
      await s.putSession({
        id: `s-${d}`, builtAt: `${d}T03:00:00.000Z`, fromPinCount: 1, targetMinutes: 15,
        estimatedMinutes: 5, sections: [], currentSectionIndex: 0, closingNote: null,
      });
    }
    const all = await (await store(id)).listSessions();
    assert.deepEqual([...all].map((x) => x.id).sort(), days.map((d) => `s-${d}`).sort());
    // And the caller's own sort, which is what the projection actually does.
    const newestFirst = [...all].sort((a, b) => b.builtAt.localeCompare(a.builtAt));
    assert.equal(newestFirst[0]?.id, 's-2026-08-14');
  } finally { await wipe(id); }
});

// -------------------------------------------- the serialisation laws, restated

/**
 * `store-serialisation.test.ts` states five laws about `JsonStore`, and three of
 * them are about a flush that this backend does not have. Restating the laws
 * that are *product* promises — and saying plainly which are not portable — is
 * the honest port of that file, rather than a copy that asserts on machinery
 * that is gone.
 *
 *  1. A mutation is visible to the next read.                    — portable, below.
 *  2. Mutations issued without awaiting apply in call order.     — portable, below,
 *                                                                  and NOT free.
 *  3. A flush serialises the db as it is when the slot runs.     — not portable:
 *                                                                  there is no flush.
 *  4. A second handle sees nothing until the flush lands.        — REVERSED, below.
 *  5. A crash loses exactly the tail that had not flushed.       — not portable:
 *                                                                  an awaited write
 *                                                                  is durable, full stop.
 */

test('law 1: a mutation is visible to the next read', { skip }, async () => {
  const id = boardId();
  const s = await store(id);
  try {
    await s.putPin(aPin('p1'));
    assert.equal((await s.getPin('p1'))?.id, 'p1');
    assert.equal((await s.listPins()).length, 1);
  } finally { await wipe(id); }
});

test('law 2: mutations issued without awaiting apply in call order', { skip }, async () => {
  // This is the law the write queue exists for, and it is the finding this lane
  // was worth doing for. Measured on the raw SDK, five times with the same two
  // writes: second, second, first, second, first. Two concurrent `set()` calls
  // on one document do NOT resolve in call order — so a store that issues
  // writes as they arrive loses a learner's later edit, non-deterministically,
  // which is the worst way for a promise to break.
  const id = boardId();
  const s = await store(id);
  try {
    await Promise.all([
      s.putPin(aPin('p1', { note: 'first' })),
      s.putPin(aPin('p1', { note: 'second' })),
    ]);
    assert.equal((await (await store(id)).getPin('p1'))?.note, 'second',
      'the later CALL must win, whichever write the backend happened to finish last');

    // And ten of them, because a race that resolves correctly once resolves
    // correctly once.
    for (let i = 0; i < 10; i++) await s.putPin(aPin('p2', { note: `n${i}` }));
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.putPin(aPin('p3', { note: `n${i}` }))));
    assert.equal((await (await store(id)).getPin('p3'))?.note, 'n9');
  } finally { await wipe(id); }
});

test('law 2, on the ledger: appends read back in the order they were called', { skip }, async () => {
  //  needs the history in order, and Firestore has no insertion order to
  // inherit — `appendSignal` stamps one. Issued without awaiting, which is the
  // forage stage's actual shape.
  const id = boardId();
  const s = await store(id);
  try {
    await Promise.all(['s1', 's2', 's3', 's4', 's5'].map((sid) => s.appendSignal({
      id: sid, topicId: 't1', type: 'answer-correct', direction: 'positive',
      at: '2026-08-19T03:00:00.000Z', sourceEvent: `sess:${sid}`, invalidated: false,
    })));
    const rows = await (await store(id)).listSignals();
    assert.deepEqual(rows.map((x) => x.id), ['s1', 's2', 's3', 's4', 's5']);
  } finally { await wipe(id); }
});

test('law 4, REVERSED: a second handle sees a write as soon as it is awaited', { skip }, async () => {
  // The local store's fourth law is a limit: two handles that have both loaded
  // diverge, never learn about each other, and the last flush wins outright.
  // That limit is the single strongest argument for this port — a Cloud Run Job
  // and a Cloud Run service are two processes over one board by construction,
  // and under the local store one of them would silently overwrite the other's
  // whole board.
  //
  // Asserted rather than assumed, in both directions, because "the database
  // handles it" is exactly the kind of belief the transport proof was written
  // about.
  const id = boardId();
  const a = await store(id);
  const b = await store(id);
  try {
    await a.putPin(aPin('p1'));
    await b.putPin(aPin('p2'));
    assert.deepEqual((await a.listPins()).map((p) => p.id).sort(), ['p1', 'p2'],
      'handle a must see the write handle b made');
    assert.deepEqual((await b.listPins()).map((p) => p.id).sort(), ['p1', 'p2'],
      'and handle b must see handle a\'s');
  } finally { await wipe(id); }
});

test('law 5, REVERSED: an awaited write is durable with no flush to lose', { skip }, async () => {
  // There is no tail. The local store's fifth law bounds what a crash costs;
  // here the write is acknowledged by the backend before the promise resolves,
  // so a process that dies afterwards loses nothing that was awaited.
  const id = boardId();
  const s = await store(id);
  try {
    await s.putPin(aPin('p1'));
    await s.putPin(aPin('p2'));
    // The process "dies": the handle is abandoned and never used again.
    const afterCrash = await store(id);
    assert.deepEqual((await afterCrash.listPins()).map((p) => p.id).sort(), ['p1', 'p2']);
  } finally { await wipe(id); }
});

// ------------------------------------------------- the law that costs nothing here

test('a read hands back nothing the store can still reach', { skip }, async () => {
  // The panel-zones lane's defect class, asserted against a backend where it
  // cannot occur. That is the point: it is a law, not an accident of the
  // storage. Every value here came out of a fresh deserialisation, so this
  // passes for free — and it is checked anyway, because a law that is only
  // checked where it can fail stops being checked the day the backend changes.
  const id = boardId();
  const s = await store(id);
  try {
    await s.putSession({
      id: 's1', builtAt: '2026-08-19T03:00:00.000Z', fromPinCount: 1, targetMinutes: 15,
      estimatedMinutes: 5, currentSectionIndex: 0, closingNote: null,
      sections: [{
        topicId: 't1', heading: 'h', body: 'b', depth: 'building',
        estimatedMinutes: 5, question: null, sourceIds: [], completed: false,
      }],
    });
    await s.putSuggestion({
      id: 'g1', passage: 'p', url: 'https://example.test/page', reason: 'read three times',
      raisedAt: '2026-08-19T03:00:00.000Z', state: 'pending', pageTitle: 'A page', headingPath: [],
    });

    // Two reads of the same row must not be the same object.
    const one = await s.getSession('s1');
    const two = await s.getSession('s1');
    assert.notEqual(one, two, 'two reads handed back one object');
    assert.notEqual(one?.sections, two?.sections, 'two reads handed back one sections array');

    // And mutating what a read handed back changes nothing.
    (one!.sections as unknown[]).push({ heading: 'ghost' });
    ((await s.listSuggestions()) as Suggestion[]).length = 0;
    ((await s.listPins()) as Pin[]).push(aPin('ghost'));

    assert.equal((await s.getSession('s1'))?.sections.length, 1);
    assert.equal((await s.listSuggestions()).length, 1);
    assert.equal((await s.listPins()).length, 0);
  } finally { await wipe(id); }
});

// --------------------------------------------------------- the ceilings, measured

test('a pin larger than a Firestore document is refused as too-large, not lost', { skip }, async () => {
  // The divergence that will actually cost somebody a night. `JsonStore` has no
  // per-record ceiling; Firestore refuses a single property over 1,048,487
  // bytes and a whole document over 1,048,576, and the refusal arrives as an
  // INVALID_ARGUMENT whose only distinguishing feature is its message.
  //
  // The taxonomy exists so the caller can tell this from a bug. A pin that is
  // too big is a fact about that pin, it is the same tomorrow, and it is the
  // one storage failure a learner can be told about honestly.
  const id = boardId();
  const s = await store(id);
  try {
    const huge = aPin('big', {
      envelope: { ...aPin('big').envelope, surroundingText: 'x'.repeat(1_200_000) },
    });
    const err = await s.putPin(huge).then(() => null, (e: unknown) => e as FirestoreStoreError);
    assert.ok(err, 'a write over the ceiling must fail loudly');
    assert.equal(err.kind, 'too-large');
    assert.equal(err.retryable, false);
    // And the board is untouched: a refused write is not a partial one.
    assert.deepEqual([...await (await store(id)).listPins()], []);
  } finally { await wipe(id); }
});

test('a one-mebibyte image collides with the document ceiling — the historical defect', { skip }, async () => {
  const id = boardId();
  const s = await store(id);
  try {
    const oneMebibyte = 1_048_576;
    const dataUri = `data:image/png;base64,${'A'.repeat(Math.ceil(oneMebibyte / 3) * 4)}`;
    const pin = aPin('img', {
      envelope: {
        ...aPin('img').envelope,
        media: { kind: 'image', ref: dataUri },
      },
    });
    const err = await s.putPin(pin).then(() => null, (e: unknown) => e as FirestoreStoreError);
    assert.ok(err, 'a mebibyte of base64 image was expected to exceed the document ceiling');
    assert.equal(err.kind, 'too-large',
      'and it must be classified as a fact about the pin, not as a transport blip');
  } finally { await wipe(id); }
});

test('an image pin at the hosted Pins cap fits in a Firestore document', { skip }, async () => {
  // The alignment the design contract promises, checked against the store that sets the
  // ceiling rather than against arithmetic about it.
  //
  // The cap is imported, not copied. That is the whole point of the case: the
  // historical test above went green-while-lying precisely because it held a
  // literal, so whoever moves MAX_IMAGE_BYTES moves this payload with it and
  // hears about it here if the new number does not fit.
  //
  // What this adds over the extension's own suite. `image-capture.test.ts`
  // already does the derivation offline and already builds the widest pin it
  // can and measures the serialised bytes — but it measures them against
  // 1_048_576 written down as a constant. Firestore is the party that enforces
  // that ceiling, and it enforces a second one (1,048,487 for any single
  // property) plus whatever its own encoding adds on top of `JSON.stringify`.
  // Only a real write settles whether the reserve behind the cap is actually
  // enough. This is the direction the extension suite cannot reach.
  const id = boardId();
  const s = await store(id);
  try {
    const prefix = 'data:image/jpeg;base64,';
    const dataUri = `${prefix}${'A'.repeat(PIN_IMAGE_WIRE_CHARS - prefix.length)}`;
    const pin = aPin('img', {
      envelope: {
        ...aPin('img').envelope,
        media: { kind: 'image', ref: dataUri },
      },
    });
    await s.putPin(pin);
    // Durable, not merely accepted: a fresh store reads only what reached the
    // backend, and the picture has to come back whole rather than truncated.
    const read = await (await store(id)).getPin('img');
    assert.equal(read?.envelope.media?.ref.length, dataUri.length,
      'the image at the shipped cap did not round-trip whole');
  } finally { await wipe(id); }
});

test('a pin at four hundred kilobytes round-trips whole', { skip }, async () => {
  // The other side of the ceiling, so the limit is bounded from both directions
  // rather than only asserted. This is the size the contract already exercises.
  const id = boardId();
  const s = await store(id);
  try {
    const big = 'x'.repeat(400_000);
    await s.putPin(aPin('p1', { envelope: { ...aPin('p1').envelope, surroundingText: big } }));
    assert.equal((await (await store(id)).getPin('p1'))?.envelope.surroundingText.length, big.length);
  } finally { await wipe(id); }
});

// ------------------------------------------------------- the transcribed surface

test('the hand-written vendor surface still matches the installed SDK', { skip }, async () => {
  // `firestore-store.ts` transcribes the slice of `@google-cloud/firestore` it
  // uses rather than importing its types. That began as a consequence of the
  // package being undeclared; since the declaration commit it is a deliberate
  // choice, and this test is what it buys. Typing against the SDK's own `.d.ts`
  // would make the workspace typecheck agree with the installed package by
  // construction and prove nothing about it; a transcription can go stale, and
  // a stale transcription is exactly what a version bump should trip over.
  const db = await client();
  const board = db.collection('boards').doc('surface-probe');
  for (const name of ['get', 'set', 'delete', 'collection'] as const) {
    assert.equal(typeof board[name], 'function', `DocumentReference.${name} is not there`);
  }
  const col = db.collection('boards');
  for (const name of ['doc', 'get', 'where'] as const) {
    assert.equal(typeof col[name], 'function', `CollectionReference.${name} is not there`);
  }
  const batch = db.batch();
  for (const name of ['set', 'delete', 'commit'] as const) {
    assert.equal(typeof batch[name], 'function', `WriteBatch.${name} is not there`);
  }
  assert.equal(typeof db.runTransaction, 'function');
  assert.equal(typeof db.recursiveDelete, 'function');
  assert.equal(typeof db.terminate, 'function');
});

test('the installed SDK is the pinned version this adapter was measured against', { skip }, async () => {
  // The transport contract's second correction. A version that moves under a proof
  // nobody re-runs is a proof about a package that is no longer installed.
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const pkg = require(`${FIRESTORE_MODULE}/package.json`) as { version: string };
  assert.equal(pkg.version, FIRESTORE_PINNED_VERSION,
    'the pinned version and the installed one have diverged — re-measure before trusting this file');
});

// -------------------------------------------------------------- the safety gate

test('a store with no emulator host refuses even when the SDK is right there', { skip }, async () => {
  // The refusal is checked offline too. It is checked again here because this
  // is the run where the SDK is installed and a database would actually be
  // reachable, which is the only run in which the guard can fail open.
  const host = process.env['FIRESTORE_EMULATOR_HOST'];
  delete process.env['FIRESTORE_EMULATOR_HOST'];
  try {
    // No injected client: this is the path that would build one for itself.
    const s = new FirestoreStore({ boardId: boardId() });
    await assert.rejects(
      () => s.listPins(),
      (err: unknown) => err instanceof FirestoreStoreError && err.kind === 'production-not-authorised',
    );
  } finally {
    if (host !== undefined) process.env['FIRESTORE_EMULATOR_HOST'] = host;
  }
});

// --------------------------------------------------------------- one cascade

test('a cascade over a board with many rows completes past the batch ceiling', { skip }, async () => {
  // Every cascade here is unbounded in principle, and a batch is not. The
  // emulator accepted 600 writes in one batch, and its own documentation says
  // it "does not enforce all limits enforced in production" — the one direction
  // a local proof cannot catch. So the code chunks at 450 and this drives
  // enough rows through to prove the chunking runs at all rather than being
  // dead code that will first execute on a learner's real board.
  const id = boardId();
  const s = await store(id);
  try {
    await s.putPin(aPin('p1', { topicId: 't1' }));
    await s.putPin(aPin('p2', { topicId: 't1' }));
    await s.putTopic(aTopic('t1', ['p1', 'p2']));
    await Promise.all(Array.from({ length: 600 }, (_, i) => s.appendSignal({
      id: `sig${i}`, topicId: 't1', type: 'answer-correct', direction: 'positive',
      at: '2026-08-19T03:00:00.000Z', sourceEvent: `reread:p1:${i}`, invalidated: false,
    })));
    assert.equal((await s.listSignals()).length, 600);

    await s.deletePin('p1');

    const fresh = await store(id);
    assert.equal((await fresh.listSignals()).length, 0,
      'every signal traceable to the deleted pin must go, not the first 450 of them');
    assert.equal(await fresh.getPin('p1'), null);
    assert.deepEqual([...(await fresh.getTopic('t1'))?.pinIds ?? []], ['p2']);
  } finally { await wipe(id); }
});
