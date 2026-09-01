import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreSession, type Scorecard } from '@sb/core';

import { REFERENCE_V1, REFERENCE_V2, type ReferenceFixture } from './fixtures/reference-sessions.js';

/**
 * THE BAR — the two reference sessions, scored.
 *
 * `artifacts/REFERENCE_SESSION.md` and `_V2.md` are two real sessions the local
 * pipeline produced unattended, kept precisely so a port to another model
 * family has something to be measured against. Until now they were measured by
 * a human rereading them, which is why "does the port still do this" has been a
 * question nobody could answer in an afternoon.
 *
 * Two things happen here, and they are different in kind.
 *
 * **The hard checks are asserted.** v2 is all-green, and that is the standing
 * claim: the frontier artefact satisfies every contract the scorecard knows how
 * to state. If a change to the Composer, the budget arithmetic or the scorer
 * makes v2 go red, one of the three is wrong.
 *
 * **The proxy values are RECORDED, as named constants, and are not law.** They
 * are what the frontier run measured. A re-eval compares a new run against
 * them; it does not have to match them. A session with a different
 * `type/token` ratio is a session with a different vocabulary spread, which is
 * a thing to go and read — not a thing to fail a build on. The assertions on
 * them below are loose on purpose: they are here so the constants cannot drift
 * out of agreement with the fixture, not to gate quality.
 *
 * ------------------------------------------------------------------------
 * WHAT v1 FAILING PROVES, and it is the reason both are kept
 *
 * v1 is the PRE-FIX baseline. Its own successor's header says it "shipped four
 * fatal defects", and AGENT_EVAL_LOG Run 2/3 name two of them. The scorecard,
 * written without reference to either document, independently finds two:
 *
 *  - `duration-computed` — v1's minutes were CLAIMED by the model and hit the
 *    budget exactly (15 of 15). The words it actually wrote read in 3min and
 *    7.2min where it claimed 5 and 7. v2 computes minutes from the words
 *    written and lands at 14.4 of 15.
 *  - `no-learner-fabrication` — v1 says "in the format you already use" about a
 *    list nothing in the learner model establishes. That is the exact class the
 *    Composer's FABRICATION rule and the Verifier's check 3 exist for, and v2's
 *    header records that the Composer "was given an explicit boundary on what
 *    it may assert about the learner".
 *
 * So the instrument catches, from the artefacts alone, two of the defects a
 * human found by rereading — which is the whole claim being made for it.
 * ------------------------------------------------------------------------
 *
 * WHAT IS NOT CHECKED HERE, and a re-eval owner must not read the green as
 * covering it: the rendered artefacts do not carry the comfort ledger, the
 * pinned source text, or the real source ids, so `register-matches-ledger` and
 * `no-verbatim-overquote` report `skipped` rather than passing. Whether the
 * from-nothing section READS as from-nothing is not scored by anything here and
 * is exactly the half of the job that stays human.
 */

const card = (f: ReferenceFixture): Scorecard => scoreSession(f.session, f.board);

const status = (c: Scorecard, id: string): string => {
  const found = c.hard.find((x) => x.id === id);
  assert.ok(found, `no hard check named ${id}`);
  return found.status;
};

const proxy = (c: Scorecard, id: string): number => {
  const found = c.proxies.find((x) => x.id === id);
  assert.ok(found, `no proxy metric named ${id}`);
  return found.value;
};

const failures = (c: Scorecard): string[] =>
  c.hard.filter((x) => x.status === 'fail').map((x) => x.id);

// ------------------------------------------------------ the frontier baseline

/**
 * What the frontier run measured, on the artefact the demo opens on.
 *
 * A re-eval — a prompt change, or the Gemini port — scores its own session and
 * compares against these. Divergence is a question, not a verdict: a lower
 * `budget-fill` means the port writes shorter sections, which may be better or
 * worse and is a thing to go and read. Recorded to three decimals because that
 * is what the scorer emits, not because the third decimal means anything.
 */
export const V2_BASELINE = {
  /** Claimed minutes over budgeted. v1 was exactly 1.0 — the model targeting
   *  the number. v2 is derived from the words and lands just under. */
  durationFill: 0.96,
  /** Words written over words budgeted. Near 1: it writes to the brief. */
  budgetFill: 0.98,
  /** Two of three registers in one session. Three would be 1.0. */
  registerSpread: 0.667,
  topicDiversity: 1,
  /** Resolving source ids per section. */
  evidenceDensity: 3,
  /** Two questions across three sections, at the stated maximum of two. */
  questionDensity: 0.667,
  /** One of three sections carried a medium warning. */
  mediumWarningRate: 0.333,
  /** Spread of section lengths. v1 measured 0.330 — Run 2's "section length is
   *  uneven" finding. The register-weighted budget landed it at 0.032. */
  sectionLengthCv: 0.032,
  sessionWords: 1843,
} as const;

/** Per-register shape of the frontier session. Signal for "one voice, three
 *  pitches" — never a verdict on whether it reads as one. */
export const V2_PER_REGISTER = {
  'from-nothing': { sections: 1, words: 626, meanSentenceWords: 19, typeTokenRatio: 0.417, meanWordChars: 5.31 },
  'building': { sections: 2, words: 1217, meanSentenceWords: 15.4, typeTokenRatio: 0.328, meanWordChars: 4.76 },
} as const;

// ------------------------------------------------------------- hard: the bar

test('the frontier reference session passes every hard check', () => {
  assert.deepEqual(failures(card(REFERENCE_V2)), [],
    'v2 is the bar; a red here means the Composer, the budget arithmetic or the scorer moved');
  assert.equal(card(REFERENCE_V2).passed, true);
});

test('the reference sessions are checked on everything their rendering carries', () => {
  const skipped = card(REFERENCE_V2).hard.filter((c) => c.status === 'skipped').map((c) => c.id);
  // Named rather than counted, so that a check quietly becoming unskippable —
  // or a new check arriving that skips here — is visible.
  assert.deepEqual(skipped.sort(), [
    // The rendering carries the register, not the ledger it was derived from.
    'register-matches-ledger',
    // Not a revision offer.
    'revision-shape',
    // The verifier-withholding contract: these are transcriptions of rendered sessions. There was no
    // verify stage behind them, so they carry no withhold list and the claim
    // the note makes cannot be checked against one. An empty list would be a
    // different and stronger answer, and neither fixture is entitled to it.
    'closing-note-withheld',
    // The rendering carries the lesson, not the pinned pages it was built from.
    'no-verbatim-overquote',
  ].sort());
});

test('the pre-fix reference fails exactly the two defects the fix log records', () => {
  assert.deepEqual(failures(REFERENCE_V1 && card(REFERENCE_V1)).sort(),
    ['duration-computed', 'no-learner-fabrication'],
    'the scorecard independently finds the model-claimed durations and the invented habit');
});

test('v1 claimed its budget exactly; v2 derives its minutes and lands under', () => {
  assert.equal(proxy(card(REFERENCE_V1), 'duration-fill'), 1,
    'the model was targeting the number — Run 2 flagged this as the thing that would stop being safe');
  assert.ok(proxy(card(REFERENCE_V2), 'duration-fill') < 1,
    'v2 computes minutes from the words actually written');
  assert.equal(status(card(REFERENCE_V2), 'duration-computed'), 'pass');
});

test('the register-weighted budget flattened the section-length spread', () => {
  // Run 2: "the from-nothing section ran nearly twice the words of any other …
  // the per-section budget is currently a flat targetMinutes / sections".
  const before = proxy(card(REFERENCE_V1), 'section-length-cv');
  const after = proxy(card(REFERENCE_V2), 'section-length-cv');
  assert.ok(before > 0.3, `v1 measured ${before}`);
  assert.ok(after < 0.1, `v2 measured ${after}`);
});

test('both reference sessions hold the restraint rules the Composer states', () => {
  for (const f of [REFERENCE_V1, REFERENCE_V2]) {
    const c = card(f);
    assert.equal(status(c, 'question-restraint'), 'pass', `${f.name}: at most two questions`);
    assert.equal(status(c, 'question-well-formed'), 'pass', `${f.name}: the Tutor can read them`);
    assert.equal(status(c, 'learner-action'), 'pass', `${f.name}: the session is not reading-only`);
    assert.equal(status(c, 'closing-note'), 'pass', `${f.name}: three clauses, no score surface`);
    assert.equal(status(c, 'provenance-sources'), 'pass', `${f.name}: the count the panel shows resolves`);
    assert.equal(status(c, 'word-budget'), 'pass', `${f.name}: no section overran its budget`);
    assert.equal(status(c, 'body-ends-on-sentence'), 'pass', `${f.name}: composed to a duration, not cut to one`);
  }
});

// ------------------------------------------------- proxy: recorded, not law

test('the recorded frontier proxy values still describe the fixture', () => {
  const c = card(REFERENCE_V2);
  const near = (id: string, want: number, why: string): void => {
    // Loose on purpose. This asserts the constants above have not drifted out
    // of agreement with the fixture — it is NOT a quality gate, and a re-eval
    // comparing a new run against these should expect movement.
    assert.ok(Math.abs(proxy(c, id) - want) <= Math.max(0.02, want * 0.02),
      `${id} measured ${proxy(c, id)}, recorded as ${want} — ${why}`);
  };
  near('duration-fill', V2_BASELINE.durationFill, 'the session under-claims its minutes');
  near('budget-fill', V2_BASELINE.budgetFill, 'it writes to the brief');
  near('register-spread', V2_BASELINE.registerSpread, 'two registers of three');
  near('topic-diversity', V2_BASELINE.topicDiversity, 'no topic taught twice');
  near('evidence-density', V2_BASELINE.evidenceDensity, 'sources per section');
  near('question-density', V2_BASELINE.questionDensity, 'two questions over three sections');
  near('medium-warning-rate', V2_BASELINE.mediumWarningRate, 'one section is a practice instruction');
  near('section-length-cv', V2_BASELINE.sectionLengthCv, 'even sections');
  assert.equal(proxy(c, 'session-words'), V2_BASELINE.sessionWords);
});

test('the recorded per-register shape still describes the fixture', () => {
  for (const r of card(REFERENCE_V2).perRegister) {
    const want = V2_PER_REGISTER[r.register as keyof typeof V2_PER_REGISTER];
    assert.ok(want, `an unrecorded register ${r.register} appeared in the reference session`);
    assert.equal(r.sections, want.sections);
    assert.equal(r.words, want.words);
    assert.equal(r.meanSentenceWords, want.meanSentenceWords);
    assert.equal(r.typeTokenRatio, want.typeTokenRatio);
    assert.equal(r.meanWordChars, want.meanWordChars);
  }
});

test('the fixture is the artefact — its header numbers are carried, not recomputed', () => {
  assert.equal(REFERENCE_V1.session.targetMinutes, 15);
  assert.equal(REFERENCE_V1.session.estimatedMinutes, 15);
  assert.equal(REFERENCE_V1.fromPinCount, 9);
  assert.equal(REFERENCE_V2.session.targetMinutes, 15);
  assert.equal(REFERENCE_V2.session.estimatedMinutes, 14.4);
  assert.equal(REFERENCE_V2.fromPinCount, 9);
  for (const f of [REFERENCE_V1, REFERENCE_V2]) {
    assert.equal(f.session.sections.length, 3);
    assert.ok(f.board.knownAboutLearner?.length, 'the learner model came across with it');
  }
});
