import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECAP_LINES, RESUME_STALE_AFTER_MS, isStaleResume, lastTouchedAt, recapSoFar } from '../domain/resume.js';
import type { SessionSection, Signal } from '../domain/types.js';

/**
 * SB-31's second demand: "If enough time has passed that the earlier material
 * has gone cold, the resume opens with a two-line recap."
 *
 * Two questions, and the first one is the one that was never asked: *when* did
 * this learner last touch this session? The store has no such field. What it
 * has is the ledger — every interaction with a section writes a signal whose
 * `sourceEvent` names the session — so the answer is derivable and does not
 * need a new field that every existing session would be missing.
 *
 * `builtAt` is the fallback and is the wrong answer used alone: a session built
 * last night and half-done this morning is not cold, and one built this morning
 * and abandoned at 9am is not cold either. Both would read as "built recently"
 * from `builtAt` and only one of them is a resume at all.
 */

const signal = (over: Partial<Signal> = {}): Signal => ({
  id: 's1', topicId: 't1', type: 'answer-correct', direction: 'positive',
  at: '2026-08-18T09:00:00.000Z', sourceEvent: 'answer:sess-1:t1', invalidated: false,
  ...over,
});

test('a session nobody has touched was last touched when it was built', () => {
  assert.equal(lastTouchedAt('sess-1', '2026-08-18T03:00:00.000Z', []), '2026-08-18T03:00:00.000Z');
});

test('the last interaction with this session wins over the build time', () => {
  assert.equal(
    lastTouchedAt('sess-1', '2026-08-18T03:00:00.000Z', [
      signal({ id: 'a', at: '2026-08-18T09:00:00.000Z' }),
      signal({ id: 'b', at: '2026-08-18T09:12:00.000Z', sourceEvent: 'skip:sess-1:t2' }),
      signal({ id: 'c', at: '2026-08-18T09:04:00.000Z', sourceEvent: 'resurface:sess-1:t1' }),
    ]),
    '2026-08-18T09:12:00.000Z',
  );
});

test('another session\'s history is not this session\'s', () => {
  // The session id is a whole field of the source event rather than a substring
  // of it. `sess-1` and `sess-12` are different sessions, and a resume warmed
  // by work done on a different one is a recap the learner never earned.
  assert.equal(
    lastTouchedAt('sess-1', '2026-08-18T03:00:00.000Z', [
      signal({ id: 'a', at: '2026-08-20T09:00:00.000Z', sourceEvent: 'answer:sess-12:t1' }),
      signal({ id: 'b', at: '2026-08-20T09:00:00.000Z', sourceEvent: 'interview-seed' }),
    ]),
    '2026-08-18T03:00:00.000Z',
  );
});

test('a signal with an unreadable timestamp is not the last thing that happened', () => {
  assert.equal(
    lastTouchedAt('sess-1', '2026-08-18T03:00:00.000Z', [signal({ at: 'lunchtime' })]),
    '2026-08-18T03:00:00.000Z',
  );
});

// ------------------------------------------------------------ gone cold or not

const at = (iso: string): number => Date.parse(iso);

test('the story\'s own case is the threshold: two days later is cold', () => {
  assert.equal(RESUME_STALE_AFTER_MS, 48 * 60 * 60 * 1000);
  assert.equal(isStaleResume('2026-08-18T09:00:00.000Z', at('2026-08-20T09:00:00.000Z')), true);
  assert.equal(isStaleResume('2026-08-18T09:00:00.000Z', at('2026-08-20T08:59:59.000Z')), false);
});

test('the same evening is not cold, and neither is the next morning', () => {
  assert.equal(isStaleResume('2026-08-20T09:00:00.000Z', at('2026-08-20T09:06:00.000Z')), false);
  assert.equal(isStaleResume('2026-08-19T21:00:00.000Z', at('2026-08-20T08:00:00.000Z')), false);
});

test('a timestamp it cannot read is not a session gone cold', () => {
  // The panel's standing rule, applied one layer down: a clause it cannot say
  // is a clause it does not write. A recap generated on the strength of an
  // unreadable date would be a model call bought with a NaN.
  for (const touched of ['lunchtime', '', 'NaN', '2026-13-45T99:99:99Z']) {
    assert.equal(isStaleResume(touched, at('2026-08-20T09:00:00.000Z')), false, touched);
  }
});

test('a timestamp in the future is not cold either', () => {
  // A clock we cannot trust is an age we cannot read — the same reading
  // `isFresh` takes of the extension's prefs cache.
  assert.equal(isStaleResume('2026-08-25T09:00:00.000Z', at('2026-08-20T09:00:00.000Z')), false);
});

// -------------------------------------------- the recap, which costs nothing

/**
 * SB-31's other half: what the resume says on the way in.
 *
 * Coming back to a cold session once asked a
 * model to read the sections the learner had finished and write two sentences
 * about them — sections this product had written itself, hours earlier, with
 * far more context than the recap call ever received.
 *
 * The Composer writes each section's recap line as it writes the section, so
 * this is assembly. Every test that used to live here was about a failure the
 * call could have — a model that was down, a reply of the wrong shape, an
 * unbounded prompt, an injection through section prose — and none of those
 * failures exist any more, because there is nothing to fail.
 */

// `exactOptionalPropertyTypes` is on, so an absent recap has to be genuinely
// absent rather than present-and-undefined — which is the shape every session
// composed before recap lines existed actually has.
const finished = (heading: string, recap?: string | null): Pick<SessionSection, 'heading' | 'recap'> =>
  (recap === undefined ? { heading } : { heading, recap });

test('SB-31: the recap is two lines, however many sections were finished', () => {
  const out = recapSoFar([
    finished('TLS', 'You worked out how the handshake picks a key.'),
    finished('IAM', 'Then which conditions actually bind.'),
    finished('Indexes', 'And what a composite index is for.'),
  ]);
  assert.equal(out.length, RECAP_LINES);
  assert.deepEqual(out, ['Then which conditions actually bind.', 'And what a composite index is for.']);
});

test('SB-31: it is the ground next to where they stopped, not where they started', () => {
  // The call this replaced summarised the first four sections however many had
  // been done, which is the wrong end of the session to remind somebody of.
  const out = recapSoFar([finished('First', 'The opening.'), finished('Last', 'Where they stopped.')]);
  assert.equal(out.at(-1), 'Where they stopped.');
});

test('SB-31: nothing finished is nothing to recap', () => {
  assert.deepEqual(recapSoFar([]), []);
});

test('SB-31: a section composed before recap lines existed falls back to its heading', () => {
  // Every session written before this has no recap line, and a heading is a
  // real description of a section rather than a blank where a sentence goes.
  assert.deepEqual(recapSoFar([finished('How TLS gets its keys')]), ['How TLS gets its keys']);
  assert.deepEqual(recapSoFar([finished('How TLS gets its keys', null)]), ['How TLS gets its keys']);
  assert.deepEqual(recapSoFar([finished('How TLS gets its keys', '   ')]), ['How TLS gets its keys']);
});

test('SB-31: a section with neither is dropped rather than rendered blank', () => {
  assert.deepEqual(recapSoFar([finished('  ', ''), finished('IAM', 'What binds.')]), ['What binds.']);
});

test('SB-31: the recap reaches for no model, and the guard says so in as many words', async () => {
  // The property, not the implementation: `recapSoFar` takes no deps, so there
  // is nowhere for a model call to be added without changing its signature and
  // every caller with it.
  assert.equal(recapSoFar.length, 1, 'recapSoFar grew a second argument, and deps is how a call gets in');
  const source = await import('node:fs')
    .then((fs) => fs.readFileSync(new URL('../../src/domain/resume.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /llm|structured\(/,
    'the resume reached for a model again');
});
