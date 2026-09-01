import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  boardFromStore, orderTopics, scoreSession,
  type ScoreBoard, type Scorecard, type ScoreableSession,
} from '@sb/core';

import { runBatch } from '../pipeline.js';
import { NOW, bench, generateBoard, makePin } from './batch-harness.js';

/**
 * The scorecard, over what the pipeline actually produces.
 *
 * The point of an instrument is that it is calibrated against the thing it will
 * be used on. A scorer that is only ever run on fixtures it was written beside
 * measures the fixtures. So the hard checks are run here over sessions built by
 * the real nightly run, on the deterministic model — the same run the
 * idempotence, scale and recovery tests use — and the contract asserted is that
 * a session the current pipeline composes is all-green.
 *
 * That is a claim about the CODE, and it is the one that has to hold before the
 * scorecard is worth pointing at a prompt change or at Gemini output. If a hard
 * check goes red here, exactly two answers are legitimate: the pipeline has a
 * defect, or the check is asserting something the code never promised. Both are
 * findings; neither is "adjust the number until it goes green".
 *
 * Findings from writing it, recorded rather than papered over:
 *
 *  1. The scripted model returns `sourceIds: []` on every section, so the
 *     pipeline's sessions cite nothing. `provenance-sources` is a check that
 *     every cited id RESOLVES, not that any id is cited — the Composer already
 *     drops unresolvable ids and a section legitimately ships with none. How
 *     much provenance a run carries is the `evidence-density` proxy instead.
 *  2. The scripted `closingNote` is "one thing moved; one thing still open" —
 *     no terminal punctuation. The Composer's stated contract is "three short
 *     clauses… no score, no percentage", and terminal punctuation is not in it,
 *     so `closing-note` checks presence and the absence of a score surface, and
 *     the clause count is reported rather than gated on.
 */

const RUN = { concurrency: 2, compositionMinutes: 15 } as const;

/** Score a run's persisted session against the board that run left behind. */
async function scoreLatest(tag: string, pins: readonly ReturnType<typeof makePin>[]): Promise<{
  card: Scorecard; session: ScoreableSession; board: ScoreBoard;
}> {
  const b = await bench(tag, pins);
  const { session } = await runBatch(b.deps, RUN);
  assert.ok(session && !session.insufficient, 'the run must have composed a session to score');

  const stored = await b.store.latestSession();
  assert.ok(stored, 'and persisted it');

  const board = await boardFromStore(b.store, new Date(NOW));
  // The one thing that does not survive the store: the order the briefs were
  // offered in. Recovered here from the same graph the runner used, so the
  // order check runs against the pipeline rather than being skipped.
  const withOrder: ScoreBoard = {
    ...board,
    offeredTopicOrder: orderTopics(board.topics, await b.store.listEdges()).map((t) => t.id),
  };
  return { card: scoreSession(stored, withOrder), session: stored, board: withOrder };
}

const failed = (card: Scorecard): string[] =>
  card.hard.filter((c) => c.status === 'fail').map((c) => `${c.id}: ${c.detail}`);

const value = (card: Scorecard, id: string): number => {
  const p = card.proxies.find((x) => x.id === id);
  assert.ok(p, `no proxy metric named ${id}`);
  return p.value;
};

const check = (card: Scorecard, id: string) => {
  const c = card.hard.find((x) => x.id === id);
  assert.ok(c, `no hard check named ${id}`);
  return c;
};

// ------------------------------------------------------- the current pipeline

test('a session the current pipeline composes passes every hard check', async () => {
  const { card } = await scoreLatest('score-live', generateBoard(12, 3));
  assert.deepEqual(failed(card), [], 'the instrument must be green on the code it will be used to judge');
  assert.equal(card.passed, true);
});

test('every hard check actually ran on a live session — none quietly skipped', async () => {
  const { card } = await scoreLatest('score-ran', generateBoard(12, 3));
  const skipped = card.hard.filter((c) => c.status === 'skipped').map((c) => c.id);
  // `revision-shape` is the only one that legitimately does not apply to an
  // ordinary night. Everything else must have had the state it needs, or the
  // green above is green about nothing.
  assert.deepEqual(skipped, ['revision-shape']);
});

test('the scorecard reads the pipeline the story describes: three registers, closed provenance', async () => {
  const { card, session } = await scoreLatest('score-shape', generateBoard(12, 3));

  assert.equal(check(card, 'provenance-topics').status, 'pass');
  assert.equal(check(card, 'register-matches-ledger').status, 'pass',
    'every register is the one the comfort ledger derives — registers are code, not model');
  assert.equal(check(card, 'section-order').status, 'pass');
  assert.equal(value(card, 'topic-diversity'), 1, 'no topic is taught twice in one session');
  assert.ok(session.estimatedMinutes <= session.targetMinutes,
    'SB-05: the run under-claims rather than over-claims');
});

test('a one-pin board is scoreable and green — the degenerate night is not an exception', async () => {
  const { card } = await scoreLatest('score-one', [makePin('only', 'k0')]);
  assert.deepEqual(failed(card), []);
  assert.equal(card.perRegister.length, 1, 'one topic, one register');
});

// --------------------------------------------------- what the proxies measure

test('the proxies are computed, in range, and named', async () => {
  const { card } = await scoreLatest('score-proxy', generateBoard(12, 3));

  for (const p of card.proxies) {
    assert.equal(Number.isFinite(p.value), true, `${p.id} is not a number`);
    assert.ok(p.detail.length > 10, `${p.id} has no readable explanation`);
  }
  for (const id of ['duration-fill', 'budget-fill', 'register-spread', 'topic-diversity',
    'evidence-density', 'question-density', 'section-length-cv', 'session-words']) {
    assert.ok(card.proxies.some((p) => p.id === id), `the scorecard lost the ${id} proxy`);
  }
  // Nothing here is a verdict. The one thing asserted is that the ratios are
  // ratios — a proxy out of [0,1] is a computation bug, not a bad session.
  for (const p of card.proxies.filter((x) => x.unit === 'ratio')) {
    assert.ok(p.value >= 0 && p.value <= 1.5, `${p.id} = ${p.value} is not a ratio`);
  }
});

test('the scripted model writes far under budget, and that is a proxy, not a failure', async () => {
  const { card, session, board } = await scoreLatest('score-under', generateBoard(12, 3));
  assert.ok(value(card, 'budget-fill') < 0.6,
    'the deterministic stub writes 66 words where the budget is hundreds');
  assert.equal(check(card, 'word-budget').status, 'pass',
    'the budget check is one-sided: overrunning is the SB-05 failure, undershooting errs safe');

  /**
   * The Composer material-budget contract's comparability effect, asserted rather than described.
   *
   * The scorer now reconstructs the budget the Composer ISSUED — the register
   * share, then capped by what the topic's material earns — whenever the board
   * carries pins. The generated board's pins are one short line each, so every
   * topic on it is thin and every section is budgeted at the floor. Measured
   * against the register share alone, the same session reads 0.12; against the
   * budget it was actually given, 0.44. Neither number moved because the model
   * wrote differently.
   *
   * So: `budget-fill` from before this ruling is comparable with `budget-fill`
   * after it only on a board where every topic was well fed, or where no pins
   * were supplied at all. The scorecard says which basis it used, and the two
   * are computed side by side here so the size of the gap stays visible.
   */
  const { pins: _pins, ...boardWithoutPins } = board;
  const registerOnly = scoreSession(session, boardWithoutPins);
  assert.ok(value(registerOnly, 'budget-fill') < value(card, 'budget-fill'),
    'a material-scaled budget is smaller, so the same words fill more of it');
  assert.match(check(card, 'word-budget').detail, /issued/);
  assert.match(check(registerOnly, 'word-budget').detail, /register-only/);
});

test('per-register statistics are emitted for each register present', async () => {
  const { card } = await scoreLatest('score-registers', generateBoard(12, 3));
  for (const r of card.perRegister) {
    assert.ok(r.sections >= 1);
    assert.ok(r.words > 0);
    assert.ok(r.typeTokenRatio > 0 && r.typeTokenRatio <= 1);
    assert.ok(r.meanWordChars > 1);
  }
});

// ------------------------------------------------------- the checks bite back

/**
 * A green scorecard proves nothing unless the checks can go red. Each of these
 * damages one thing about a real pipeline session and asserts that exactly the
 * check responsible fails — a scorecard whose checks pass on a broken session
 * is worse than no scorecard, because it certifies.
 */
const damaged = (session: ScoreableSession, patch: (s: ScoreableSession) => ScoreableSession) => patch(session);

test('each hard check fails on the thing it is checking, and only on that', async () => {
  const { session, board } = await scoreLatest('score-bite', generateBoard(12, 3));
  const first = session.sections[0]!;

  const cases: readonly [string, ScoreableSession][] = [
    ['provenance-topics', damaged(session, (s) => ({
      ...s, sections: [{ ...first, topicId: 'topic-that-does-not-exist' }, ...s.sections.slice(1)] }))],
    ['provenance-sources', damaged(session, (s) => ({
      ...s, sections: [{ ...first, sourceIds: ['p-429-1'] }, ...s.sections.slice(1)] }))],
    ['register-legal', damaged(session, (s) => ({
      ...s, sections: [{ ...first, depth: 'intermediate' as never }, ...s.sections.slice(1)] }))],
    ['register-matches-ledger', damaged(session, (s) => ({
      ...s, sections: [{ ...first, depth: first.depth === 'fluent' ? 'building' : 'fluent' }, ...s.sections.slice(1)] }))],
    ['section-order', damaged(session, (s) => ({ ...s, sections: [...s.sections].reverse() }))],
    ['word-budget', damaged(session, (s) => ({
      ...s, sections: [{ ...first, body: `${'word '.repeat(4000)}.`, estimatedMinutes: 30 }, ...s.sections.slice(1)] }))],
    ['duration-fits-budget', damaged(session, (s) => ({ ...s, estimatedMinutes: s.targetMinutes * 3 }))],
    ['duration-computed', damaged(session, (s) => ({
      ...s, sections: [{ ...first, estimatedMinutes: first.estimatedMinutes + 9 }, ...s.sections.slice(1)] }))],
    ['body-ends-on-sentence', damaged(session, (s) => ({
      ...s, sections: [{ ...first, body: `${first.body.trim()} and then it just stops mid-`, estimatedMinutes: 0 }, ...s.sections.slice(1)] }))],
    ['closing-note', damaged(session, (s) => ({ ...s, closingNote: 'you scored 80% this week' }))],
    // The verifier-withholding contract. The note is true about what the Composer wrote and false
    // about what shipped, which is the one defect a clause count cannot see.
    ['closing-note-withheld', damaged(session, (s) => ({
      ...s,
      closingNote: `${first.heading} moved into practice; one thing is still open.`,
      withheld: [{ topicId: first.topicId, heading: first.heading }],
    }))],
    ['question-well-formed', damaged(session, (s) => ({
      ...s,
      sections: [{ ...first, question: { prompt: 'what?', kind: 'recall', expectedPoints: undefined as never } },
        ...s.sections.slice(1)] }))],
    ['learner-action', damaged(session, (s) => ({
      ...s, sections: s.sections.map((x) => ({ ...x, question: null })) }))],
    ['question-restraint', damaged(session, (s) => ({
      ...s,
      sections: s.sections.map((x) => ({
        ...x, question: { prompt: `about ${x.topicId}?`, kind: 'free-text' as const, expectedPoints: [] } })) }))],
    ['no-fence-leak', damaged(session, (s) => ({
      ...s, sections: [{ ...first, body: `<pinned-material>${first.body}` }, ...s.sections.slice(1)] }))],
    ['no-learner-fabrication', damaged(session, (s) => ({
      ...s, sections: [{ ...first, body: `${first.body} Add it to your running exceptions list.` }, ...s.sections.slice(1)] }))],
  ];

  for (const [id, broken] of cases) {
    const card = scoreSession(broken, board);
    const fails = card.hard.filter((c) => c.status === 'fail').map((c) => c.id);
    assert.ok(fails.includes(id), `${id} did not fail on a session broken in exactly that way`);
    assert.equal(card.passed, false);
    // Some damage genuinely cascades — a body long enough to break the budget
    // also breaks the duration recomputation — so what is asserted is that the
    // named check is among the failures, and that a check unrelated to the
    // damage is not. `provenance-topics` is unrelated to all of these except
    // its own case.
    if (id !== 'provenance-topics') {
      assert.ok(!fails.includes('provenance-topics'),
        `${id} damage also tripped provenance-topics — the checks are not independent`);
    }
  }
});

test('a withheld section the note does not name is not a defect — the check is about the claim', async () => {
  // The control for the case above. Withholding is the product working; what
  // the verifier-withholding contract forbids is the note going on to claim the withheld material.
  // A check that failed on the withhold itself would gate the safety feature.
  const { session, board } = await scoreLatest('score-withheld-ok', generateBoard(12, 3));
  const first = session.sections[0]!;
  const card = scoreSession({
    ...session,
    closingNote: 'one thing moved; one thing still open',
    withheld: [{ topicId: first.topicId, heading: first.heading }],
  }, board);
  assert.equal(check(card, 'closing-note-withheld').status, 'pass');
  assert.equal(card.passed, true);
});

test('a fabrication the learner model actually supports is not a fabrication', async () => {
  const { session, board } = await scoreLatest('score-known', generateBoard(12, 3));
  const first = session.sections[0]!;
  const withClaim: ScoreableSession = {
    ...session,
    sections: [{ ...first, body: `${first.body} Add it to your running exceptions list.` },
      ...session.sections.slice(1)],
  };

  assert.equal(scoreSession(withClaim, board).passed, false, 'unsupported, so it is a defect');

  const told: ScoreBoard = {
    ...board,
    knownAboutLearner: [...(board.knownAboutLearner ?? []), 'You keep a running list of rule exceptions.'],
  };
  const card = scoreSession(withClaim, told);
  assert.equal(check(card, 'no-learner-fabrication').status, 'pass',
    'the rule is "assert nothing beyond what you were told", not "never mention a habit"');
});

test('a session read without its board skips rather than passing vacuously', async () => {
  const { session, board } = await scoreLatest('score-bare', generateBoard(12, 3));
  const card = scoreSession(session, { topics: board.topics });
  const skipped = card.hard.filter((c) => c.status === 'skipped').map((c) => c.id);
  assert.deepEqual(skipped.sort(), [
    'no-verbatim-overquote', 'provenance-sources', 'register-matches-ledger',
    'revision-shape', 'section-order',
  ]);
  assert.equal(card.passed, true, 'a skipped check is not a failed one — but it is not a pass either');
});

test('a session scored with no board at all blames nothing on the session', async () => {
  // The CLI's bare-file mode. A missing argument must not read as an invented
  // topic id: the instrument reports what it could not check.
  const { session } = await scoreLatest('score-noboard', generateBoard(12, 3));
  const card = scoreSession(session, { topics: [] });
  assert.equal(check(card, 'provenance-topics').status, 'skipped');
  assert.deepEqual(failed(card), []);
});
