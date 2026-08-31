import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLOSING_NOTE_MIN_CHARS, stripWithheldTopics, withheldTopicsNamedIn,
} from '../domain/closing-note.js';

/**
 * The withheld-content contract — the closing note may not name a section the learner never saw.
 *
 * The defect the 2026-08-20 benchmark run found, in one sentence: the Composer
 * writes the closing note over every section it composed, the Verifier then
 * withholds some of those sections, and nothing recomposes the note. The
 * learner is told they practised two things that were removed from their
 * session — the "manufactures confidence" shape, arriving through the one
 * artefact whose whole job is to say what moved.
 *
 * The contract is a MECHANICAL strip. No model call on this path, ever: a
 * withhold night is a night something already went wrong on, and buying extra
 * compute to rewrite a sentence is the wrong direction. Fail closed instead.
 */

const withheld = (topicId: string, heading: string, label?: string | null) =>
  ({ topicId, heading, ...(label === undefined ? {} : { label }) });

// ------------------------------------------------------ nothing was withheld

test('a night that withheld nothing leaves the note byte for byte as composed', () => {
  const note = 'IAM conditions — from nothing to workable. Pub/Sub ordering — confirmed. Cloud Run — one gap left.';
  const out = stripWithheldTopics(note, []);
  assert.equal(out.note, note, 'not re-joined, not re-spaced, not normalised — the same string');
  assert.equal(out.outcome, 'untouched');
  assert.deepEqual(out.removed, []);
});

test('a session with no note at all is not given one', () => {
  assert.equal(stripWithheldTopics(null, []).note, null);
  assert.equal(stripWithheldTopics(null, [withheld('T1', 'Firestore composite indexes')]).note, null);
  assert.equal(stripWithheldTopics('   ', [withheld('T1', 'Firestore composite indexes')]).note, null);
});

// ------------------------------------------------------ the mechanical strip

test('the benchmark shape: the clause naming a withheld section goes', () => {
  // GEMINI_BENCHMARK_2026-08-20.md §6 anomaly 1, in the note's own shape.
  const note = 'Firestore composite indexes moved into practice.'
    + ' IAM condition evaluation is workable.'
    + ' Instrument-based chord execution remains open.';
  const out = stripWithheldTopics(note, [withheld('T1', 'Firestore composite indexes')]);

  assert.equal(out.outcome, 'stripped');
  assert.doesNotMatch(out.note ?? '', /Firestore/i, 'the learner never saw that section');
  assert.match(out.note ?? '', /IAM condition evaluation is workable\./);
  assert.match(out.note ?? '', /Instrument-based chord execution remains open\./);
  assert.deepEqual(out.removed, ['Firestore composite indexes moved into practice. ']);
});

test('a clause is the unit, so a kept topic named in the same clause goes with it', () => {
  // The stilted note the contract accepted. "Firestore and IAM both moved" is one
  // claim about two things, and half of it is false — there is no mechanical
  // way to keep the true half, and inventing one would mean writing prose.
  const note = 'Firestore composite indexes and IAM condition evaluation moved into practice;'
    + ' instrument-based chord execution remains open.';
  const out = stripWithheldTopics(note, [withheld('T1', 'Firestore composite indexes')]);

  assert.equal(out.outcome, 'stripped');
  assert.equal(out.note, 'instrument-based chord execution remains open.');
});

test('matching is case- and whitespace-insensitive, the way headings are read elsewhere', () => {
  const note = 'FIRESTORE   COMPOSITE\nINDEXES moved. IAM conditions are workable enough to use.';
  const out = stripWithheldTopics(note, [withheld('T1', ' Firestore composite indexes ')]);
  assert.equal(out.outcome, 'stripped');
  assert.equal(out.note, 'IAM conditions are workable enough to use.');
});

test('a topic is matched on its label as well as its section heading', () => {
  // The Composer names sections; the Clusterer names topics; the note may use
  // either. Both are carried, so both are checked.
  const note = 'The ack deadline is now workable. IAM conditions are still open for now.';
  const out = stripWithheldTopics(note, [withheld('T1', 'Section for T1', 'the ack deadline')]);
  assert.equal(out.outcome, 'stripped');
  assert.equal(out.note, 'IAM conditions are still open for now.');
});

test('a label found inside a longer word does not count as naming the topic', () => {
  // The one direction over-matching is unsafe in. Removing a clause that could
  // have stayed costs the learner a sentence; marking the topic NAMED skips the
  // paraphrase backstop, and the note ships with a claim nothing checked.
  const note = 'The Miami trip is still open, and nothing else moved this week.';
  const out = stripWithheldTopics(note, [withheld('T1', 'IAM')]);
  assert.equal(out.note, null, '"IAM" inside "Miami" is not the IAM section');
  assert.equal(out.outcome, 'dropped-unnamed');

  // And the same three letters where a word begins are the topic.
  const named = stripWithheldTopics('IAM conditions moved. Pub/Sub ordering is confirmed.',
    [withheld('T1', 'IAM')]);
  assert.equal(named.outcome, 'stripped');
  assert.equal(named.note, 'Pub/Sub ordering is confirmed.');
});

test('a heading too long to render as a clause is matched on the clause form too', () => {
  // `panel-core.ts` cuts a heading at 48 characters for one clause of card
  // copy. A note that carries the short form must still be matched, or the
  // strip misses and the whole note is dropped for a defect that is not there.
  const heading = 'Firestore composite indexes and the query planner, in practice';
  const note = `${heading.slice(0, 47)} moved into practice. IAM conditions are still open.`;
  const out = stripWithheldTopics(note, [withheld('T1', heading)]);
  assert.equal(out.outcome, 'stripped');
  assert.equal(out.note, 'IAM conditions are still open.');
});

// -------------------------------------------------- the fail-closed backstop

test('a withheld topic the note never names drops the note entirely', () => {
  // The one thing mechanics cannot do: prose can paraphrase a topic without
  // naming it. "The database work landed" is a claim about a withheld section
  // and contains none of its words. A note that may be lying about a section
  // is worth less than no note, so it goes.
  const note = 'The database work landed. IAM conditions are still open for now.';
  const out = stripWithheldTopics(note, [withheld('T1', 'Firestore composite indexes')]);

  assert.equal(out.note, null, 'a missing note is honest; a wrong one is not');
  assert.equal(out.outcome, 'dropped-unnamed');
  assert.deepEqual(out.unnamed, ['T1']);
});

test('a withheld topic with no usable label is never matchable, so the note goes', () => {
  const note = 'Firestore composite indexes moved. IAM conditions are still open.';
  const out = stripWithheldTopics(note, [withheld('T1', '   ', null)]);
  assert.equal(out.note, null);
  assert.equal(out.outcome, 'dropped-unnamed');
});

test('one named and one paraphrased still drops the note — the backstop is per topic', () => {
  const note = 'Firestore composite indexes moved. The ear training landed too.';
  const out = stripWithheldTopics(note, [
    withheld('T1', 'Firestore composite indexes'),
    withheld('T2', 'Instrument-based chord execution'),
  ]);
  assert.equal(out.note, null);
  assert.deepEqual(out.unnamed, ['T2']);
});

// -------------------------------------------------- nothing meaningful left

test('a night that withheld everything the note named closes on nothing', () => {
  const note = 'Firestore composite indexes moved into practice;'
    + ' instrument-based chord execution remains open.';
  const out = stripWithheldTopics(note, [
    withheld('T1', 'Firestore composite indexes'),
    withheld('T2', 'Instrument-based chord execution'),
  ]);
  assert.equal(out.note, null);
  assert.equal(out.outcome, 'dropped-empty');
  assert.equal(out.removed.length, 2);
});

test('a residue too short to name anything is not a closing note', () => {
  const note = 'Firestore composite indexes moved into practice. Open.';
  const out = stripWithheldTopics(note, [withheld('T1', 'Firestore composite indexes')]);
  assert.equal(out.note, null, `"Open." is under ${CLOSING_NOTE_MIN_CHARS} characters of anything`);
  assert.equal(out.outcome, 'dropped-empty');
});

test('a residue of punctuation and invisibles is empty, whatever its length', () => {
  const note = 'Firestore composite indexes moved into practice. ​ — … — ​ — …';
  const out = stripWithheldTopics(note, [withheld('T1', 'Firestore composite indexes')]);
  assert.equal(out.note, null);
  assert.equal(out.outcome, 'dropped-empty');
});

// ---------------------------------------------------------- what came out

test('every outcome carries a line a run log can print', () => {
  const cases = [
    stripWithheldTopics('a note that is long enough.', []),
    stripWithheldTopics(null, []),
    stripWithheldTopics('Firestore composite indexes moved. IAM conditions are open still.',
      [withheld('T1', 'Firestore composite indexes')]),
    stripWithheldTopics('The database work landed and nothing else did.',
      [withheld('T1', 'Firestore composite indexes')]),
    stripWithheldTopics('Firestore composite indexes moved.',
      [withheld('T1', 'Firestore composite indexes')]),
  ];
  for (const c of cases) {
    assert.ok(c.detail.length > 8, `${c.outcome} has no readable line`);
  }
  assert.match(cases[3]!.detail, /DROPPED/, 'a dropped note is said loudly, like UNVERIFIED');
  assert.match(cases[4]!.detail, /DROPPED/);
});

// --------------------------------------------------------- the read-only ask

test('the naming check answers the same question without changing anything', () => {
  const note = 'Firestore composite indexes moved. IAM conditions are still open.';
  assert.deepEqual(
    withheldTopicsNamedIn(note, [
      withheld('T1', 'Firestore composite indexes'),
      withheld('T2', 'Instrument-based chord execution'),
    ]),
    ['T1'],
    'T1 is named in a note the learner should not be reading; T2 is not named at all',
  );
  assert.deepEqual(withheldTopicsNamedIn(null, [withheld('T1', 'Firestore composite indexes')]), []);
  assert.deepEqual(withheldTopicsNamedIn(note, []), []);
});

// ------------------------------------------------------------- no model call

test('the strip is pure: same input, same answer, no dependencies to hand it', () => {
  const note = 'Firestore composite indexes moved. IAM conditions are still open.';
  const w = [withheld('T1', 'Firestore composite indexes')];
  const a = stripWithheldTopics(note, w);
  const b = stripWithheldTopics(note, w);
  assert.deepEqual(a, b);
  // The signature is the proof: two arguments, neither of them `deps`. A model
  // call on a withhold night is what the withheld-content contract declined.
  assert.equal(stripWithheldTopics.length, 2);
});
