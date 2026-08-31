import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  boardFromStore, notebookDoc, scoreSession, type Scorecard, type Session,
} from '@sb/core';
import { JsonStore } from '@sb/adapters';
import { readNotebookInput } from '../notebook-export.js';

import { startService } from './service-harness.js';

/**
 * The board the demo opens on, checked like code.
 *
 * `.data/store.json` is committed evidence — 21 pins, 7 topics, four sessions —
 * and it is what a fresh clone runs the service over, what the panel renders,
 * and what `eval-session.mjs` scores with no arguments. Nothing in the suite
 * read it. Every test that touches provenance builds its own fixture, and a
 * fixture is by definition written against today's conventions, so the one
 * artefact that can fall behind a convention was the one artefact nobody
 * watched.
 *
 * It fell behind exactly that way. Source ids were bare pin ids when this board
 * was last written; `offeredSourceIdsFor` has minted `<pinId>:origin` since, and
 * `resolveSources` indexes the pin under that form. Both surfaces that exist to
 * be checkable — SB-44's provenance tap and §5d's Notebook hand-off — therefore
 * rendered their cannot-trace paths on the demo board itself, behaving exactly
 * as designed over data that could not be traced. Found in a real Chrome
 * (F-1, CHROME_LOAD_2026-08-21), where it is visible, and invisible to node
 * because no node test opened the file.
 *
 * So the assertion here is not about the ids' SHAPE. A test that matched
 * `:origin` with a regular expression would pass on a board whose ids were
 * suffixed and wrong, and would go red the day a third kind of id is minted.
 * Each of the three readers is asked its own question through its own code
 * path — the endpoint the panel calls, the notebook document the hand-off
 * writes, the scorer's offered set — and the question is always "does it
 * resolve". The hand-off's reader changed when the clipboard went: the press
 * no longer collects urls, it rewrites the learn now document, and that
 * document resolves the same ids through `core/`.
 *
 * The store is copied to a throwaway directory first. A test that opens the
 * committed board in place is a test that can rewrite the evidence it was
 * written to protect.
 */

const root = new URL('../../../', import.meta.url);
const COMMITTED_BOARD = fileURLToPath(new URL('.data/store.json', root));

/** The committed board, opened where writing it back cannot matter. */
const boardCopy = (tag: string): JsonStore => {
  const path = join(mkdtempSync(join(tmpdir(), `sb-${tag}-`)), 'store.json');
  copyFileSync(COMMITTED_BOARD, path);
  return new JsonStore(path);
};

interface SourcesBody {
  readonly sources: readonly { readonly id: string; readonly url: string | null }[];
  readonly unresolved: number;
}

test('every source id on the committed board resolves through the provenance endpoint', async () => {
  const store = boardCopy('board-prov');
  const h = await startService('board-prov', { store });
  try {
    const sessions = await store.listSessions();
    assert.ok(sessions.length, 'the committed board carries the sessions the demo opens on');

    let cited = 0;
    const dead: string[] = [];
    for (const s of sessions) {
      for (const sec of s.sections) {
        cited += sec.sourceIds.length;
        const r = await h.call<SourcesBody>(
          'GET', `/sessions/${s.id}/sections/${sec.topicId}/sources`);
        assert.equal(r.status, 200, `${s.id} · ${sec.topicId} is a section the service can find`);
        if (r.body.unresolved > 0) {
          dead.push(`${s.id} · ${sec.heading} → ${r.body.unresolved} of ${sec.sourceIds.length}`);
        }
        // Not just counted as resolved: a source with no address is a line the
        // learner cannot follow, which is the failure this surface exists against.
        for (const src of r.body.sources) {
          assert.ok(src.url, `${src.id} resolved to a source with no address`);
        }
      }
    }

    assert.ok(cited > 0, 'the committed sessions cite sources at all');
    assert.deepEqual(dead, [],
      'every id the demo board cites resolves to a page the learner can go and check');
  } finally {
    await h.close();
  }
});

test('the Notebook hand-off writes a lesson with real sources on the committed board', async () => {
  const store = boardCopy('board-handoff');
  const h = await startService('board-handoff', { store });
  try {
    const session = await store.latestSession() as Session;
    assert.ok(session, 'the committed board carries a latest session');

    // The press's own reader, without the browser: the same store read the
    // export door makes, and the same pure builder behind it.
    const learn = notebookDoc('learn-now', await readNotebookInput(store, h.deps.clock));

    assert.match(learn.body, /## The lesson in front of you/,
      'the demo board has a lesson waiting, so the press has something to send');
    assert.equal(learn.body.includes('could not trace this one back to a page you saved'), false,
      'the hand-off on the demo board renders its cannot-trace path');
    assert.match(learn.body, /## Where this lesson came from[\s\S]*\]\(https?:\/\//,
      'a source with no address is a line the learner cannot follow');
  } finally {
    await h.close();
  }
});

test('the committed board cites only ids the brief would have offered', async () => {
  const store = boardCopy('board-score');
  const session = await store.latestSession() as Session;
  assert.ok(session, 'the committed board carries a latest session');

  const board = await boardFromStore(store, new Date(session.builtAt));
  const card: Scorecard = scoreSession(session, board);
  const check = card.hard.find((c) => c.id === 'provenance-sources');
  assert.ok(check, 'the scorer still carries a provenance-sources check');

  // The third reader of this file, and the one a port-day operator runs first.
  // `npm run eval:session` with no arguments scores exactly this session.
  assert.equal(check.status, 'pass',
    `eval-session reports dead provenance on the demo board:\n  ${check.offenders.join('\n  ')}`);
});
