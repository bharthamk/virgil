import { test } from 'node:test';
import assert from 'node:assert/strict';

import { boardFromStore, scoreSession, type LlmRequest } from '@sb/core';

import { runBatch } from '../pipeline.js';
import { NOW, bench, generateBoard, type Stage } from './batch-harness.js';

/**
 * The withheld-content contract, through a whole run.
 *
 * `core/src/__tests__/closing-note.test.ts` holds the strip itself. This file
 * holds the thing the 2026-08-20 benchmark actually measured: a nightly whose
 * Composer wrote a closing note over three sections, whose Verifier then
 * withheld one of them, and whose stored session told the learner they had
 * practised it.
 *
 * The failure was invisible to every existing test because each half is
 * correct on its own — the Composer's note is true about what it composed, and
 * the Verifier's withhold is true about what it checked. It is the seam
 * between them that lies, so the assertion has to be made about the session
 * that reaches the store.
 */

const RUN = { concurrency: 2, compositionMinutes: 15 } as const;

/** Which topic ids the compose brief put in front of the model, in order. */
const topicIdsIn = (prompt: string): string[] =>
  [...prompt.matchAll(/^TOPIC (\S+): /gm)].map((m) => m[1] as string);

/**
 * The benchmark's own three topics, in the benchmark's own words.
 *
 * Positional rather than keyed on the topic id, because the ids are generated
 * per run. Position is enough: the brief's order is deterministic.
 */
const HEADINGS = [
  'Firestore composite indexes',
  'IAM condition evaluation',
  'Instrument-based chord execution',
] as const;

const NOTE = `${HEADINGS[0]} and ${HEADINGS[1]} moved into practice;`
  + ` ${HEADINGS[2].toLowerCase()} remains open.`;

/**
 * A Composer that writes the benchmark's note, and a Verifier that withholds
 * whichever sections the test names — matched on the heading the verify prompt
 * opens with, which is the only handle a scripted model has on a section.
 */
function scripted(withhold: readonly string[]) {
  return (stage: Stage | null, req: LlmRequest): unknown => {
    if (stage === 'compose') {
      return {
        sections: topicIdsIn(req.prompt).map((id, i) => ({
          topicId: id,
          heading: HEADINGS[i % HEADINGS.length],
          body: `A paragraph teaching ${HEADINGS[i % HEADINGS.length]}, long enough to estimate from. `.repeat(6),
          estimatedMinutes: 5,
          question: null,
          sourceIds: [],
          mediumWarning: null,
        })),
        closingNote: NOTE,
      };
    }
    if (stage === 'verify') {
      const heading = /^SECTION: (.+)$/m.exec(req.prompt)?.[1] ?? '';
      return withhold.includes(heading.trim())
        ? {
          defects: [{
            kind: 'unsupported', quote: 'a claim', problem: 'nothing in the material supports it',
            severity: 'fatal',
          }],
        }
        : { defects: [] };
    }
    return undefined;
  };
}

// ------------------------------------------------------- the benchmark shape

test('a section withheld after the note was written is not named in the note', async () => {
  const b = await bench('closing-withhold', generateBoard(9, 3), {
    answer: scripted([HEADINGS[0]]),
  });
  const { session } = await runBatch(b.deps, RUN);
  const stored = await b.store.latestSession();

  assert.ok(stored, 'the night produced a session');
  assert.equal(stored.withheld?.length, 1, 'one section was withheld — the setup held');
  assert.equal(stored.withheld?.[0]?.heading, HEADINGS[0]);
  assert.equal(stored.sections.length, 2);

  // The defect, stated as the learner would meet it.
  assert.doesNotMatch(stored.closingNote ?? '', /Firestore/i,
    'the note named a section the learner never saw');
  // And the run's own copy agrees with what was persisted — the note is
  // stripped once, upstream of the store, not patched on the way out.
  assert.doesNotMatch(session?.closingNote ?? '', /Firestore/i);
});

test('the clause the withheld topic shared with a kept one goes with it, and the rest stays', async () => {
  const b = await bench('closing-clause', generateBoard(9, 3), {
    answer: scripted([HEADINGS[0]]),
  });
  await runBatch(b.deps, RUN);
  const stored = await b.store.latestSession();

  assert.equal(stored?.closingNote, 'instrument-based chord execution remains open.',
    'a stilted note that is true beats a fluent one that is not');
});

test('the run says what it did to the note, in the verify stage line', async () => {
  const b = await bench('closing-line', generateBoard(9, 3), {
    answer: scripted([HEADINGS[0]]),
  });
  const { reports } = await runBatch(b.deps, RUN);
  const verify = reports.find((r) => r.stage === 'verify');
  assert.match(String(verify?.detail), /closing note/i,
    'a note the learner was going to read was changed — that is not a silent edit');
});

// ------------------------------------------------ the benchmark's own numbers

test('the benchmark night — two of three withheld — closes on nothing at all', async () => {
  // Both clauses of the note name a withheld section, so nothing meaningful
  // survives the strip and the note goes. This is the run the benchmark
  // actually measured.
  const b = await bench('closing-benchmark', generateBoard(9, 3), {
    answer: scripted([HEADINGS[0], HEADINGS[2]]),
  });
  await runBatch(b.deps, RUN);
  const stored = await b.store.latestSession();

  assert.equal(stored?.sections.length, 1, 'one honest section, as the benchmark reported');
  assert.equal(stored?.withheld?.length, 2);
  assert.equal(stored?.closingNote, null, 'no note beats a note about a session that did not happen');
});

test('a whole night withheld leaves a session that claims nothing', async () => {
  const b = await bench('closing-all', generateBoard(9, 3), {
    answer: scripted([...HEADINGS]),
  });
  await runBatch(b.deps, RUN);
  const stored = await b.store.latestSession();

  assert.equal(stored?.sections.length, 0);
  assert.equal(stored?.withheld?.length, 3);
  assert.equal(stored?.closingNote, null);
});

// ------------------------------------------------------------ the tripwire

test('the scorecard is green on the withhold night, and would have been red before', async () => {
  // `closing-note-withheld` is the hard check under the strip, not the strip
  // itself. Both halves are asserted on one real run: the session that shipped
  // passes it, and the session that WOULD have shipped — the same night with
  // the Composer's unstripped note put back — fails it.
  const b = await bench('closing-score', generateBoard(9, 3), { answer: scripted([HEADINGS[0]]) });
  await runBatch(b.deps, RUN);
  const stored = await b.store.latestSession();
  assert.ok(stored);
  const board = await boardFromStore(b.store, new Date(NOW));

  const card = scoreSession(stored, board);
  const check = (c: typeof card) => c.hard.find((x) => x.id === 'closing-note-withheld');
  assert.equal(check(card)?.status, 'pass');

  const before = scoreSession({ ...stored, closingNote: NOTE }, board);
  assert.equal(check(before)?.status, 'fail', 'the defect the benchmark found is now a contract break');
  assert.equal(before.passed, false, 'and the CLI exits non-zero on it');
  assert.match(String(check(before)?.offenders[0]), /Firestore composite indexes/);
});

// ----------------------------------------------------- a note that paraphrases

test('a note that paraphrases the withheld section rather than naming it is dropped', async () => {
  // The one thing the strip cannot do. The note below is about the Firestore
  // section and contains none of its words, so the mechanical pass would leave
  // a false claim standing. It fails closed instead.
  const b = await bench('closing-paraphrase', generateBoard(9, 3), {
    answer: (stage: Stage | null, req: LlmRequest): unknown => {
      const base = scripted([HEADINGS[0]])(stage, req);
      if (stage !== 'compose') return base;
      return {
        ...(base as object),
        closingNote: 'The database indexing work moved into practice;'
          + ' instrument-based chord execution remains open.',
      };
    },
  });
  await runBatch(b.deps, RUN);
  const stored = await b.store.latestSession();

  assert.equal(stored?.withheld?.length, 1);
  assert.equal(stored?.closingNote, null,
    'the strip could not prove the note was clean, so the note does not ship');
});

// ------------------------------------------------------------- the clean night

test('a night that withheld nothing keeps its note exactly as composed', async () => {
  const b = await bench('closing-clean', generateBoard(9, 3), { answer: scripted([]) });
  const { reports } = await runBatch(b.deps, RUN);
  const stored = await b.store.latestSession();

  assert.equal(stored?.withheld?.length, 0);
  assert.equal(stored?.closingNote, NOTE, 'byte for byte — the strip is not a rewrite');
  assert.doesNotMatch(String(reports.find((r) => r.stage === 'verify')?.detail), /closing note/i,
    'and nothing is said about a note nothing happened to');
});
