import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSER_SYSTEM, LEARNER_ACTION_MINUTES, ensureLearnerAction,
  MEDIUM_ACTION_PROMPT, THIN_MEDIUM_CLOSING_NOTE, THIN_MEDIUM_INTRO,
  THIN_MEDIUM_MATERIAL_WORDS, THIN_MEDIUM_WARNING,
  groundMediumPractice, plannedLearnerActions,
  sectionMinutes, sourcePracticeInstruction, thinMediumBody, thinMediumCopy,
} from '../agents/composer.js';
import type { Pin, SessionSection } from '../domain/types.js';

const section = (over: Partial<SessionSection> = {}): SessionSection => ({
  topicId: 't1', heading: 'Why the stick rebounds', body: 'The lesson body.',
  depth: 'from-nothing', estimatedMinutes: 5, question: null, sourceIds: [],
  completed: false, ...over,
});

const physicalPin = (surroundingText: string): Pin => ({
  id: 'p1', type: 'interest',
  envelope: {
    selection: 'American grip', parts: [], surroundingText, headingPath: [],
    pageTitle: 'Grip', url: 'https://example.test/grip', canonicalUrl: null,
    siteName: null, contentLanguage: 'en', media: null,
  },
  note: null, capturedAt: '2026-08-01T00:00:00Z', fromSuggestion: false,
  enrichment: null, topicId: 't1',
});

test('a reading-only session receives one bounded retrieval-and-application action', () => {
  const out = ensureLearnerAction([section(), section({ topicId: 't2' })]);
  assert.equal(out.filter((item) => item.question).length, 1,
    'the fallback must open one learning loop without breaking the two-question ceiling');
  assert.equal(out[1]?.question?.kind, 'recall');
  assert.match(out[1]?.question?.prompt ?? '', /own words/i);
  assert.deepEqual(out[1]?.question?.expectedPoints, []);
});

test('a skill that cannot be learned by reading gets the action, not a generic recall check', () => {
  const out = ensureLearnerAction([
    section(),
    section({ topicId: 'motor', mediumWarning: 'This has to be tried with a pair of sticks.' }),
  ]);
  assert.equal(out[0]?.question, null);
  assert.equal(out[1]?.question?.kind, 'free-text');
  assert.match(out[1]?.question?.prompt ?? '', /try the skill/i);
  assert.match(out[1]?.question?.prompt ?? '', /noticed|got in the way/i);
});

test('model-written questions are retained exactly and never padded with another one', () => {
  const written = section({
    question: { prompt: 'What changes when the fulcrum moves?', kind: 'free-text', expectedPoints: ['leverage'] },
  });
  const out = ensureLearnerAction([written, section({ topicId: 't2' })]);
  assert.deepEqual(out, [written, section({ topicId: 't2' })]);
});

test('a legacy mixed session puts the fallback on an unfinished section', () => {
  const out = ensureLearnerAction([
    section({ topicId: 'open' }),
    section({ topicId: 'done', completed: true, mediumWarning: 'Already practised.' }),
  ]);
  assert.ok(out[0]?.question, 'the open section must remain answerable');
  assert.equal(out[1]?.question, null, 'a completed section must not absorb the only action');
});

test('a fully completed legacy session is not reopened by the fallback', () => {
  const out = ensureLearnerAction([section({ completed: true })]);
  assert.equal(out[0]?.question, null);
});

test('a generic question does not leave a medium-limited section without practice evidence', () => {
  const written = section({
    question: { prompt: 'Explain the main idea.', kind: 'recall', expectedPoints: ['idea'] },
  });
  const out = ensureLearnerAction([
    written,
    section({ topicId: 'motor', mediumWarning: 'This needs to be tried.' }),
  ]);
  assert.deepEqual(out[0], written, 'the written question must remain exact');
  assert.equal(out[1]?.question?.kind, 'free-text');
  assert.equal(out.filter((item) => item.question).length, 2, 'the two-question ceiling still holds');
});

test('two written questions are never overwritten to manufacture a third', () => {
  const first = section({ question: { prompt: 'One?', kind: 'recall', expectedPoints: [] } });
  const second = section({
    topicId: 'motor', mediumWarning: 'This needs to be tried.',
    question: { prompt: 'Two?', kind: 'recall', expectedPoints: [] },
  });
  const out = ensureLearnerAction([first, second]);
  assert.deepEqual(out[0], first);
  assert.equal(out[1]?.question?.kind, 'free-text');
  assert.deepEqual(out[1]?.question?.expectedPoints, []);
  assert.match(out[1]?.question?.prompt ?? '', /only the setup your saved page states/i);
});

test('a model cannot invent a correct physiological result for a practice observation', () => {
  const out = ensureLearnerAction([section({
    mediumWarning: 'This must be tried.',
    question: {
      prompt: 'Which shoulder rises?', kind: 'free-text',
      expectedPoints: ['The opposite shoulder rises', 'One wrist strains'],
    },
  })]);
  assert.match(out[0]?.question?.prompt ?? '', /what did you notice/i);
  assert.deepEqual(out[0]?.question?.expectedPoints, []);
});

test('the commission itself requires a learner action and a concrete motor-skill practice', () => {
  assert.match(COMPOSER_SYSTEM, /may not be reading-only/i);
  assert.match(COMPOSER_SYSTEM, /one question for a five-minute session, two for a longer session/i);
  assert.match(COMPOSER_SYSTEM, /about one minute/i);
  assert.match(COMPOSER_SYSTEM, /safe, concrete practice action/i);
  assert.match(COMPOSER_SYSTEM, /must be stated directly in the pinned material/i);
  assert.match(COMPOSER_SYSTEM, /Never fill a missing procedure from general knowledge/i);
  assert.match(COMPOSER_SYSTEM, /Do not resolve an ambiguous angle/i);
  assert.match(COMPOSER_SYSTEM, /Do not predict strain, compensation, ease/i);
});

test('the visible duration includes the bounded learner action', () => {
  assert.equal(LEARNER_ACTION_MINUTES, 1);
  assert.equal(plannedLearnerActions(5), 1);
  assert.equal(plannedLearnerActions(15), 2);
  assert.equal(sectionMinutes('word '.repeat(110), 'from-nothing'), 1);
  assert.equal(sectionMinutes('word '.repeat(110), 'from-nothing', 1), 2);
});

test('medium practice discards model directives and keeps the source instruction verbatim', () => {
  const source = `American grip background ${'context '.repeat(110)}. Keep your palms facing down, your elbows relaxed, and the sticks at a 45-degree angle.`;
  const pin = physicalPin(source);
  const supporting = {
    ...physicalPin(`American grip detail ${'evidence '.repeat(110)}.`), id: 'p2',
  };
  assert.equal(sourcePracticeInstruction([pin]),
    'Keep your palms facing down, your elbows relaxed, and the sticks at a 45-degree angle.');
  const grounded = groundMediumPractice(
    'The page names three constraints. Set your hands at 45 degrees from the ground. Notice whether your opposite shoulder rises.',
    [pin, supporting], 'This must be tried.',
  );
  assert.match(grounded, /The page names three constraints/);
  assert.doesNotMatch(grounded, /from the ground|opposite shoulder/);
  assert.match(grounded, /Keep your palms facing down, your elbows relaxed, and the sticks at a 45-degree angle\./);
});

test('grounded practice removes model-authored timings before adding Virgil\'s one minute', () => {
  const pin = physicalPin('Keep your palms down and your elbows relaxed.');
  const grounded = groundMediumPractice(
    'Try the shape for ten seconds. The source gives two constraints.', [pin], 'Try it.',
  );
  assert.doesNotMatch(grounded, /ten seconds/i);
  assert.match(grounded, /For one minute/);
});

test('thin physical evidence gets a deterministic handoff, not model-authored technique', () => {
  assert.equal(THIN_MEDIUM_MATERIAL_WORDS, 100);
  const pin = physicalPin('Keep your palms down and your elbows relaxed.');
  const grounded = groundMediumPractice(
    'Pick up two pens. Discover which shoulder compensates. This is invented technique.',
    [pin], 'Try it.',
  );
  assert.doesNotMatch(grounded, /pens|shoulder|invented technique/i);
  assert.match(grounded, /I cannot add technique to it/i);
  assert.match(grounded, /Keep your palms down and your elbows relaxed\./);
});

test('thin physical evidence cannot overclaim in its surrounding card copy', () => {
  assert.deepEqual(thinMediumCopy('Drumming Techniques'), {
    heading: 'Drumming Techniques',
    mediumWarning: 'This is a skill your hands and ears have to learn. What you saved covers the setup, so the setup is what I can take you through.',
    summary: 'Getting set up for Drumming Techniques, as far as your saved pages go',
    recap: 'Getting set up, and the part only practice can teach.',
  });
});

/**
 * THE VOCABULARY THE LEARNER NEVER ASKED FOR.
 *
 * Strings such as "source-backed setup", "source-shaped", and "the pinned
 * material" expose implementation vocabulary rather than teaching the subject.
 *
 * The honesty behind them survives whole: the material covers a setup, reading
 * cannot teach a motor skill, and neither of those facts is softened anywhere
 * below. Only the words a learner reads changed. Held by test because this is
 * exactly the register that grows back one string at a time.
 */
test('no learner-facing string on the thin physical path speaks in build vocabulary', () => {
  const banned = /source[- ]backed|source[- ]shaped|pinned material/i;
  const copy = thinMediumCopy('Drumming Techniques');
  const learnerFacing = [
    ...Object.values(copy),
    THIN_MEDIUM_INTRO, THIN_MEDIUM_WARNING, MEDIUM_ACTION_PROMPT,
    thinMediumBody('Keep your palms down.'),
    THIN_MEDIUM_CLOSING_NOTE,
  ];
  assert.deepEqual(learnerFacing.filter((line) => banned.test(line)), [],
    'say "what you saved" or "your saved pages": a learner has never seen the word source-backed');
  // The refusal itself is the thing that must not soften with the wording.
  assert.match(THIN_MEDIUM_INTRO, /not as proof/i);
  assert.match(THIN_MEDIUM_WARNING, /setup/i);
});
