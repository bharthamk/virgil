import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Clock, Session } from '@sb/core';

import { runBatch } from '../pipeline.js';
import { bench, generateBoard, NOW } from './batch-harness.js';

/**
 * **The batch-key alignment contract at the write side: which night a run was for, said by the run.**
 *
 * Until this file the pipeline never knew. It read one clock at the top, wrote
 * `builtAt` from another at the bottom, and every reader downstream — the guard
 * asking whether this run was built, the Firestore adapter naming the document —
 * inferred the night from that timestamp. The inference is exact whenever a
 * run's clock and its night agree, and a retry across midnight UTC is precisely
 * the case where they do not: the joint lane produced the whole chain, ending
 * in a night that silently consumed the following one.
 *
 * The fix is not a guard on the boundary. It is that the night stops being
 * inferred at all: the trigger computes it from the message, hands it to
 * `runBatch`, and it rides on the `Session` to the document name. A clock
 * that moves during the run then decides nothing.
 *
 * The clock below is what makes that assertable. `runBatch` reads
 * `deps.clock.now()` once at the top and the Composer reads it again at the
 * end, so a clock that steps between the two produces exactly the production
 * shape: a run that began on one date and finished on the next.
 */

/** First reading is the run's start; every reading after it is later. */
function crossing(start: string, finish: string): Clock {
  let first = true;
  return {
    now: () => {
      if (first) { first = false; return new Date(start); }
      return new Date(finish);
    },
  };
}

const RUN = { concurrency: 2 } as const;

/**
 * The night `builtAt` would have been read as — `batchKeyOf` from the Firestore
 * adapter, restated rather than imported.
 *
 * The adapter is deliberately absent from its own package index, and a runner
 * test reaching around that to borrow four characters of string arithmetic
 * would be a dependency this workspace does not have. The two are held together
 * by `firestore-store.test.ts`, where the function lives.
 */
const clockBatchKey = (builtAt: string): string => builtAt.slice(0, 10);

/** The one session a board of this shape builds. */
async function builtSession(store: { listSessions(): Promise<readonly Session[]> }): Promise<Session> {
  const rows = await store.listSessions();
  assert.equal(rows.length, 1, 'the board built exactly one session');
  return rows[0] as Session;
}

test('a run is told which night it is building, and the session says so', async () => {
  // The plain case. The key is the trigger's, derived from a message and not
  // from anything this process can observe, and it survives to the store
  // unchanged — which is the only reason the trigger bothered to compute it.
  const b = await bench('batch-key-carried', generateBoard(6, 3));
  await runBatch(b.deps, { ...RUN, batchKey: '2026-08-14' });

  const session = await builtSession(b.store);
  assert.equal(session.batchKey, '2026-08-14');
  assert.notEqual(session.batchKey, clockBatchKey(session.builtAt),
    'and it is not the date the run happened to finish on, or the field would prove nothing');
});

test('a run that crosses midnight is still the night it began', async () => {
  /**
   * The defect, run end to end with no trigger in front of it.
   *
   * The task starts at 23:55 and finishes at 00:03. `builtAt` says the 22nd,
   * honestly — that is when the session was composed. The night is the 21st,
   * because that is the night the run was for, and nothing about a slow
   * pipeline changes which night a learner is owed.
   */
  const b = await bench('batch-key-midnight', generateBoard(6, 3));
  const deps = { ...b.deps, clock: crossing('2026-08-21T23:55:00.000Z', '2026-08-22T00:03:00.000Z') };
  await runBatch(deps, RUN);

  const session = await builtSession(b.store);
  assert.equal(session.batchKey, '2026-08-21', 'the night the run began');
  assert.equal(clockBatchKey(session.builtAt), '2026-08-22', 'and the clock it finished on, still honest');
  assert.notEqual(session.batchKey, clockBatchKey(session.builtAt),
    'the two disagree, which is the whole case — and the night is the one that names the row');
});

test('an untriggered run takes the night from its own start, and takes it once', async () => {
  // The laptop path, and the CLI's. There is no message to key from, so the
  // run's own start is the honest answer — read at the top with everything
  // else, never re-read at the bottom where a retry's clock would have moved.
  const b = await bench('batch-key-default', generateBoard(6, 3));
  await runBatch(b.deps, RUN);

  const session = await builtSession(b.store);
  assert.equal(session.batchKey, NOW.slice(0, 10));
});

test('the night the caller named is the night that is written, never a repair of it', async () => {
  /**
   * The mutation check. A pipeline that took the key and then "corrected" it
   * against its own clock would pass every assertion above on a board whose
   * fixed clock agrees with the key, and would reintroduce the defect on the
   * only night it matters.
   */
  const b = await bench('batch-key-verbatim', generateBoard(6, 3));
  await runBatch(b.deps, { ...RUN, batchKey: '1999-12-31' });

  assert.equal((await builtSession(b.store)).batchKey, '1999-12-31');
});
