import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minutesFor, registerFor } from '../agents/composer.js';
import { dedupe, type ComfortResult } from '../agents/registrar.js';

test('duration follows the text, not a target', () => {
  const short = 'word '.repeat(140);
  const long = 'word '.repeat(280);
  assert.equal(minutesFor(short, 'building'), 1);
  assert.equal(minutesFor(long, 'building'), 2);
});

test('the same text costs longer at a shallower register', () => {
  const body = 'word '.repeat(340);
  assert.ok(minutesFor(body, 'from-nothing') > minutesFor(body, 'fluent'),
    'introducing terms and analogies genuinely reads slower than a dense paragraph');
});

test('a section is never reported as zero minutes', () => {
  assert.ok(minutesFor('one word', 'fluent') >= 1);
});

test('registerFor refuses a confident register on thin evidence', () => {
  // comfort and certainty are different questions. High comfort on two
  // weak signals must not pitch a learner at expert level.
  // Typed as the whole `ComfortResult` the Registrar produces rather than as
  // the narrow read `registerFor` now takes, so this stays a test about the
  // real thing the Composer is handed.
  const reading = (over: Partial<ComfortResult>): ComfortResult =>
    ({
      topicId: 't', comfort: 1, certainty: 0.9, regressed: false, evidenceCount: 6,
      demonstrationCount: 2, evidenceSignalIds: [], ...over,
    });
  const confident = registerFor(reading({}));
  const thin = registerFor(reading({ certainty: 0.2, evidenceCount: 1 }));
  assert.equal(confident, 'fluent');
  assert.equal(thin, 'from-nothing');
});

/**
 * One run produced thirteen statements of which at least five were the same
 * point reworded. A learner reading five versions of one insight concludes the
 * system does not know what it thinks.
 */
test('near-duplicate statements are dropped', () => {
  const out = dedupe([
    'You build a clean general model of a system and then get stopped by the exception case.',
    'You build a clean general model of a system and then get stopped by the boundary case.',
    'Your music study is text and video only, which cannot train an ear.',
  ]);
  assert.equal(out.length, 2);
});

test('genuinely distinct statements all survive', () => {
  const out = dedupe([
    'You treat a summary as complete knowledge.',
    'Your music study is text and video only.',
    'You conflate the label of a concept with its behaviour.',
  ]);
  assert.equal(out.length, 3);
});

test('dedupe keeps the first phrasing rather than the last', () => {
  const out = dedupe([
    'You stop at the mechanical description without the design reason.',
    'You stop at the mechanical description and skip the design reason.',
  ]);
  assert.deepEqual(out, ['You stop at the mechanical description without the design reason.']);
});
