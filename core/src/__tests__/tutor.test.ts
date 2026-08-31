import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  answerTangent, askAboutPin, ASK_TURN_CHARS, handleCorrection,
  markAnswer, markRecallAnswer, projectSafeSession, retireConcededLessonShell, shiftRegister,
} from '../agents/tutor.js';
import type { PureDeps } from '../agents/deps.js';
import type { Llm, LlmRequest, LlmResult } from '../ports/llm.js';
import type { Session, Topic } from '../domain/types.js';

/**
 * The foreground agent, including both learner-facing trust exchanges.
 *
 * `markAnswer`, `answerTangent` , and `handleCorrection`  are all
 * exercised through the service. These unit checks still own the model's
 * odd-answer boundary rather than asking HTTP wiring tests to prove the prompt.
 *
 * The bound is the point of. The tangent takes one lesson and at most two
 * completed prior turns. The learner may keep asking, but the prompt cannot
 * quietly grow with the lifetime of the session.
 */

const clock = { now: () => new Date('2026-08-20T10:00:00Z') };

const spyLlm = (payload: unknown): { llm: Llm; calls: LlmRequest[] } => {
  const calls: LlmRequest[] = [];
  return {
    calls,
    llm: {
      complete: async () => { throw new Error('the tutor does not use complete()'); },
      structured: async <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
        calls.push(req);
        return { value: payload as T, modelId: 'stub', inputTokens: 0, outputTokens: 0 };
      },
    },
  };
};

const deps = (llm: Llm): PureDeps => ({ llm, clock });

// -------------------------------------------------------------- depth

test('depth moves one step and stops at the ends', () => {
  assert.equal(shiftRegister('fluent', 'simpler'), 'building');
  assert.equal(shiftRegister('building', 'simpler'), 'from-nothing');
  assert.equal(shiftRegister('from-nothing', 'simpler'), 'from-nothing', 'there is no floor below the floor');
  assert.equal(shiftRegister('from-nothing', 'deeper'), 'building');
  assert.equal(shiftRegister('building', 'deeper'), 'fluent');
  assert.equal(shiftRegister('fluent', 'deeper'), 'fluent');
});

// ------------------------------------------------------------- marking

test('the mark is a signal, and it is derived from one field', async () => {
  const right = spyLlm({ response: 'You had the ordering guarantee.', gotRight: ['ordering'], missed: [], substantiallyCorrect: true });
  const a = await markAnswer(deps(right.llm), { heading: 'h', body: 'b', question: null }, 'my answer');
  assert.equal(a.signal, 'answer-correct');
  assert.equal(right.calls[0]?.tier, 'deep', 'an answer with no explicit open question keeps the stronger judge');

  const wrong = spyLlm({ response: 'The key is per-key, not global.', gotRight: [], missed: ['scope'], substantiallyCorrect: false });
  const b = await markAnswer(deps(wrong.llm), { heading: 'h', body: 'b', question: null }, 'my answer');
  assert.equal(b.signal, 'answer-wrong');
  assert.deepEqual([...b.missed], ['scope']);
});

test('a required point the marker says is missing cannot receive full credit', async () => {
  const partial = spyLlm({
    response: 'You explained delivery, but not the acknowledgement deadline.',
    gotRight: ['Delivery is at least once.'],
    missed: ['The acknowledgement deadline bounds redelivery.'],
    substantiallyCorrect: true,
  });
  const out = await markAnswer(deps(partial.llm), {
    heading: 'Retries', body: 'Delivery is at least once.',
    question: {
      prompt: 'Explain delivery and the acknowledgement deadline.', kind: 'free-text',
      expectedPoints: ['Delivery is at least once.', 'The acknowledgement deadline bounds redelivery.'],
    },
  }, 'Delivery can repeat.');
  assert.equal(out.signal, 'answer-wrong');
  assert.deepEqual(out.missed, ['The acknowledgement deadline bounds redelivery.']);
});

test('an invented missing requirement cannot keep a complete keyed answer open', async () => {
  const drifted = spyLlm({
    response: 'You covered the required point.', gotRight: ['Delivery is at least once.'],
    missed: ['Name the exact default timeout.'], substantiallyCorrect: true,
  });
  const out = await markAnswer(deps(drifted.llm), {
    heading: 'Retries', body: 'Delivery is at least once.',
    question: {
      prompt: 'What delivery guarantee applies?', kind: 'recall',
      expectedPoints: ['Delivery is at least once.'],
    },
  }, 'Delivery is at least once.');
  assert.equal(out.signal, 'answer-correct');
  assert.deepEqual(out.missed, []);
});

test('a marking that comes back half-formed is still an answer, not a crash', async () => {
  const { llm } = spyLlm({ substantiallyCorrect: true });
  const out = await markAnswer(deps(llm), { heading: 'h', body: 'b', question: null }, 'my answer');
  assert.equal(out.response, '');
  assert.deepEqual([...out.gotRight], []);
  assert.deepEqual([...out.missed], []);
  assert.equal(out.signal, 'answer-correct');
});

test('a missing verdict is read as not yet demonstrated, not as a pass', async () => {
  const { llm } = spyLlm({ response: 'Something.', gotRight: [], missed: [] });
  const out = await markAnswer(deps(llm), { heading: 'h', body: 'b', question: null }, 'my answer');
  assert.equal(out.signal, 'answer-wrong', 'the absent field must not read as a correct answer');
});

test('what the learner wrote and what they were taught are both bounded', async () => {
  const { llm, calls } = spyLlm({ response: 'r', gotRight: [], missed: [], substantiallyCorrect: true });
  await markAnswer(
    deps(llm),
    { heading: 'h', body: 'b'.repeat(4000), question: { kind: 'free-text', prompt: 'Why?', expectedPoints: ['a point'] } },
    'w'.repeat(3000),
  );
  const prompt = calls[0]!.prompt;
  assert.equal((/b{100,}/.exec(prompt) ?? [''])[0].length, 2000);
  assert.equal((/w{100,}/.exec(prompt) ?? [''])[0].length, 1500);
  assert.match(prompt, /Points a good answer covers:\n- a point/);
});

test('exact Unicode answer boundaries reach both markers whole', async () => {
  const answer = '🙂'.repeat(1_500);
  const lesson = spyLlm({ response: 'r', gotRight: [], missed: [], substantiallyCorrect: true });
  await markAnswer(
    deps(lesson.llm),
    { heading: 'h', body: 'body', question: { kind: 'free-text', prompt: 'Why?', expectedPoints: [] } },
    answer,
  );
  const lessonRun = lesson.calls[0]!.prompt.match(/🙂+/u)?.[0] ?? '';
  assert.equal(Array.from(lessonRun).length, 1_500,
    'the lesson marker saw only part of an accepted Unicode answer');

  const burst = spyLlm({ response: 'r', gotRight: [], missed: [], substantiallyCorrect: true });
  await markRecallAnswer(deps(burst.llm), {
    heading: 'h', evidence: 'evidence', prompt: 'What do you remember?',
  }, answer);
  const burstRun = burst.calls[0]!.prompt.match(/🙂+/u)?.[0] ?? '';
  assert.equal(Array.from(burstRun).length, 1_500,
    'the recall marker saw only part of an accepted Unicode answer');
});

test('a section with no question still marks against what was taught', async () => {
  const { llm, calls } = spyLlm({ response: 'r', gotRight: [], missed: [], substantiallyCorrect: false });
  await markAnswer(deps(llm), { heading: 'h', body: 'the body', question: null }, 'an answer');
  assert.match(calls[0]!.prompt, /Question: \(none\)/);
  assert.doesNotMatch(calls[0]!.prompt, /Points a good answer covers/);
});

test('an open practice answer is not marked against an invented hidden checklist', async () => {
  const { llm, calls } = spyLlm({
    response: 'Looser fingers allowed rebound. You did not test moving the fulcrum.',
    gotRight: ['looser fingers allowed rebound'],
    missed: ['moving the fulcrum'],
    substantiallyCorrect: true,
  });
  const out = await markAnswer(deps(llm), {
    heading: 'American grip', body: 'Rebound depends on grip tension.',
    question: { kind: 'free-text', prompt: 'Try it and say what you noticed.', expectedPoints: [] },
  }, 'The stick bounced when I loosened my fingers.');

  assert.deepEqual(out.missed, [], 'an absent rubric cannot acquire a missing requirement from the model');
  assert.equal(out.signal, 'answer-correct');
  assert.match(String(calls[0]?.system), /no hidden checklist/i);
  assert.match(String(calls[0]?.system), /Never say the answer proves/i);
  assert.match(String(calls[0]?.system), /Next, you could/i);
  assert.equal(calls[0]?.tier, 'fast', 'an open reflection has no rubric worth a deep-model wait');
  assert.equal(calls[0]?.reasoning, 'off', 'the learner is waiting in the foreground');
});

test('a missed real observation gets a retry boundary, not invented page controls', async () => {
  const { llm, calls } = spyLlm({
    response: 'Check the navigation, search icon, or footer social links, because one is likely there.',
    gotRight: ['checked a page'],
    missed: ['an icon-only control'],
    substantiallyCorrect: false,
  });
  const out = await markAnswer(deps(llm), {
    heading: 'Audit one page', body: 'Check the name and keyboard behaviour.',
    question: {
      kind: 'free-text',
      prompt: 'Open the page and inspect the first icon-only control. What did you find?',
      expectedPoints: ['the name source', 'Tab reach', 'Enter or Space activation'],
    },
  }, 'I found no icon-only control on this page.');

  assert.equal(out.signal, 'answer-wrong');
  assert.match(out.response, /does not yet give the real-world observation/i);
  assert.match(out.response, /revise your answer and try again/i);
  assert.doesNotMatch(out.response, /navigation|search|footer|social/i,
    'model speculation about an unseen page crossed into learner feedback');
  assert.match(String(calls[0]?.system), /Never invent or assume a page, control, result/i);
});

test('a correct real observation cannot acquire a body-only hidden requirement', async () => {
  const { llm, calls } = spyLlm({
    response: 'You identified the labelled microphone and both activation keys. To fully answer, you need to report whether its focus ring is visible.',
    gotRight: ['aria-label, Tab reach, Enter and Space activation'],
    missed: ['visible focus ring'],
    substantiallyCorrect: true,
  });
  const out = await markAnswer(deps(llm), {
    heading: 'Audit one page',
    body: 'A wider audit can also inspect visible focus and logical tab order.',
    question: {
      kind: 'free-text',
      prompt: 'Open the page and inspect the first icon-only control. What did you find?',
      expectedPoints: ['the name source', 'Tab reach', 'Enter or Space activation'],
    },
  }, 'The microphone has an aria-label, Tab reaches it, and Enter and Space both open it.');

  assert.equal(out.signal, 'answer-correct');
  assert.deepEqual(out.missed, [], 'a body-only extension cannot become a missing mark');
  assert.equal(out.response, 'You identified the labelled microphone and both activation keys.');
  assert.doesNotMatch(out.response, /focus ring|fully answer|need to/i);
  assert.match(String(calls[0]?.system), /lesson-body detail is not a hidden requirement/i);
});

test('a source-limited open answer cannot reintroduce physical coaching through feedback', async () => {
  const { llm, calls } = spyLlm({
    response: 'Your answer shows the source never defines the angle. Next, you could try different angles to see which feels natural.',
    gotRight: ['the reference point is unclear'],
    missed: [],
    substantiallyCorrect: true,
  });
  const out = await markAnswer(deps(llm), {
    heading: 'American grip',
    body: 'For one minute, follow only the setup in the pinned material.',
    mediumWarning: 'The pinned material supports only the setup quoted below.',
    question: { kind: 'free-text', prompt: 'What did you notice, and what remained unclear?', expectedPoints: [] },
  }, 'The source never says what the angle is measured from.');

  assert.equal(out.response,
    'Your answer shows the source never defines the angle. Pin a better source before changing or extending this practice.');
  assert.doesNotMatch(out.response, /try different angles|feels natural/i);
  assert.match(String(calls[0]?.system), /Do not propose a next experiment/i);
  assert.equal(calls[0]?.tier, 'fast');
  assert.equal(calls[0]?.reasoning, 'off');
});

test('source-limited feedback fails closed when the model leads with coaching', async () => {
  const { llm } = spyLlm({
    response: 'Try moving your hands until the angle feels natural.',
    gotRight: ['an observation'],
    missed: [],
    substantiallyCorrect: true,
  });
  const out = await markAnswer(deps(llm), {
    heading: 'American grip', body: 'A source-shaped setup.',
    mediumWarning: 'This physical source is limited.',
    question: { kind: 'free-text', prompt: 'What did you notice?', expectedPoints: [] },
  }, 'The angle was unclear.');

  assert.equal(out.response,
    'Your answer records something you noticed, and a limit in what you saved. Pin a better source before changing or extending this practice.');
});

test('a burst recall answer is checked from written retrieval and returns acknowledgement only', async () => {
  const { llm, calls } = spyLlm({
    response: 'You recalled that the ack deadline controls redelivery. Next, try drawing the flow.',
    gotRight: ['ack deadline controls redelivery'], missed: ['ordering key'], substantiallyCorrect: true,
  });
  const out = await markRecallAnswer(deps(llm), {
    heading: 'Pub/Sub delivery',
    evidence: 'If the message is not acknowledged before the deadline, it can be delivered again.',
    prompt: 'Without opening your sources, explain Pub/Sub delivery in your own words.',
  }, 'Missing the ack deadline can cause another delivery.');

  assert.equal(out.response, 'You recalled that the ack deadline controls redelivery.');
  assert.deepEqual(out.missed, [], 'a broad recall prompt cannot acquire a hidden checklist');
  assert.equal(out.signal, 'answer-correct');
  assert.equal(calls[0]?.tier, 'fast');
  assert.equal(calls[0]?.reasoning, 'off');
  assert.match(String(calls[0]?.system), /not a scored quiz/i);
  assert.match(String(calls[0]?.prompt), /Missing the ack deadline/);
});

// -------------------------------------------------------------- tangents

test('a tangent is answered and then routed back to the pin mechanic', async () => {
  const { llm } = spyLlm({
    answer: 'Dead-letter topics take the message after the delivery attempts run out.',
    offerAsPin: 'Dead-letter queues',
  });
  const out = await answerTangent(deps(llm), 'How does this interact with dead-letter queues?', {
    heading: 'Ordering keys', register: 'building',
  });
  assert.equal(out.offerAsPin, 'Dead-letter queues', 'depth is deferred to this run, not taken now');
  assert.match(out.answer, /Dead-letter topics/);
});

test('a question that needed no follow-up offers nothing, rather than pinning anyway', async () => {
  const { llm } = spyLlm({ answer: 'Two sentences.', offerAsPin: null });
  assert.equal((await answerTangent(deps(llm), 'q', { heading: 'h', register: 'fluent' })).offerAsPin, null);
});

test('the tangent is told where the learner is and nothing else about them', async () => {
  const { llm, calls } = spyLlm({ answer: 'a', offerAsPin: null });
  await answerTangent(deps(llm), 'q'.repeat(2000), { heading: 'Ordering keys', register: 'from-nothing' });
  const prompt = calls[0]!.prompt;
  assert.match(prompt, /Pitch the answer at from-nothing level/);
  assert.match(prompt, /part-way through "Ordering keys"/);
  assert.equal((/q{100,}/.exec(prompt) ?? [''])[0].length, 800, 'the question itself is bounded');
  // The bound that actually holds the line: there is nowhere for a session's
  // worth of exchanges to go. Four sentences is a prompt instruction; a context
  // that cannot grow is a property of the signature.
  assert.equal(answerTangent.length, 3);
  assert.ok((calls[0]!.maxOutputTokens ?? Infinity) <= 600);
});

test('the Unicode question boundary reaches the Tutor whole', async () => {
  const { llm, calls } = spyLlm({ answer: 'a', offerAsPin: null });
  const question = '🙂'.repeat(800);
  await answerTangent(deps(llm), question, { heading: 'Unicode', register: 'building' });
  const prompt = calls[0]!.prompt;
  const run = prompt.match(/🙂+/u)?.[0] ?? '';
  assert.equal(Array.from(run).length, 800,
    'the service accepted 800 Unicode characters but the Tutor saw fewer');
  assert.ok(!prompt.includes('\ud83d"'), 'the prompt ended with half of a surrogate pair');
});

test('follow-ups receive the lesson and only a fixed rolling window', async () => {
  const { llm, calls } = spyLlm({ answer: 'a', offerAsPin: null });
  await answerTangent(deps(llm), 'Does that change the retry?', {
    heading: 'Ordering keys', register: 'building', body: 'The current lesson body.',
    history: [
      { question: 'oldest question', answer: 'oldest answer' },
      { question: 'recent question', answer: 'recent answer' },
      { question: 'latest question', answer: 'latest answer' },
    ],
  });
  const prompt = calls[0]!.prompt;
  assert.match(prompt, /The current lesson body/);
  assert.doesNotMatch(prompt, /oldest question|oldest answer/,
    'a conversation transcript can grow without bound');
  assert.match(prompt, /recent question/);
  assert.match(prompt, /latest answer/);
  assert.match(prompt, /Does that change the retry/);
});

test('the fixed rolling window carries each visible Unicode exchange whole', async () => {
  const { llm, calls } = spyLlm({ answer: 'a', offerAsPin: null });
  const priorQuestion = '🟠'.repeat(800);
  const priorAnswer = '🟢'.repeat(8_000);
  await answerTangent(deps(llm), 'Does that change it?', {
    heading: 'Unicode history', register: 'building',
    history: [{ question: priorQuestion, answer: priorAnswer }],
  });
  const prompt = calls[0]!.prompt;
  assert.equal(Array.from(prompt.match(/🟠+/u)?.[0] ?? '').length, 800,
    'the earlier question shown on screen became a shorter question in the follow-up prompt');
  assert.equal(Array.from(prompt.match(/🟢+/u)?.[0] ?? '').length, 8_000,
    'the earlier answer shown on screen became a shorter answer in the follow-up prompt');
});

test('a tangent the model fumbles is empty, not undefined text on the screen', async () => {
  const { llm } = spyLlm({});
  assert.deepEqual(
    await answerTangent(deps(llm), 'q', { heading: 'h', register: 'building' }),
    { answer: '', offerAsPin: null },
  );
});

test('the side-panel Unicode question boundary reaches the Tutor whole', async () => {
  const { llm, calls } = spyLlm({ body: 'answer', offerAsPin: null });
  const question = '🙂'.repeat(ASK_TURN_CHARS);
  await askAboutPin(deps(llm), {
    material: 'Pinned passage', headingPath: [], pageTitle: 'Page', note: null,
    register: 'building', guide: 'Build from the pinned passage.',
    knownAboutLearner: [], learnerCorrections: [],
  }, question);
  const run = calls[0]!.prompt.match(/🙂+/u)?.[0] ?? '';
  assert.equal(Array.from(run).length, ASK_TURN_CHARS,
    'the panel accepted the question but the Tutor saw fewer characters');
});

// ------------------------------------------------------------ concession

test('it is allowed to lose the argument, and says which way it went', async () => {
  const { llm } = spyLlm({ conceded: true, reply: 'You are right — acks are per-message, not per-batch.' });
  const out = await handleCorrection(deps(llm), 'Acks are per batch.', 'the source text', 'That is not what the docs say.');
  assert.equal(out.conceded, true);
  assert.match(out.reply, /You are right/);
});

test('holding the line means showing the source, and is still a reply', async () => {
  const { llm } = spyLlm({ conceded: false, reply: 'The page says the deadline is extended, not reset.' });
  const out = await handleCorrection(deps(llm), 'claim', 'source', 'challenge');
  assert.equal(out.conceded, false);
  assert.match(out.reply, /The page says/);
});

test('a verdict that is not a boolean is not a concession', async () => {
  // Only an actual concession may reach the ledger, because a concession is what
  // withdraws a mark against the learner.
  const { llm } = spyLlm({ conceded: 'maybe', reply: '' });
  assert.equal((await handleCorrection(deps(llm), 'c', 's', 'x')).conceded, true,
    'a non-empty string is truthy — recorded here so the coercion is deliberate rather than assumed');
  const nothing = spyLlm({ reply: 'r' });
  assert.equal((await handleCorrection(deps(nothing.llm), 'c', 's', 'x')).conceded, false);
});

test('the claim, the source it rested on and the challenge all reach the check', async () => {
  const { llm, calls } = spyLlm({ conceded: true, reply: 'r' });
  await handleCorrection(deps(llm), 'the claim', 's'.repeat(4000), 'c'.repeat(2000));
  const prompt = calls[0]!.prompt;
  assert.match(prompt, /You told them: "the claim"/);
  assert.equal((/s{100,}/.exec(prompt) ?? [''])[0].length, 2500, 'the source is bounded');
  assert.equal((/c{100,}/.exec(prompt) ?? [''])[0].length, 2000,
    'the accepted challenge was silently shortened after the service boundary');
  assert.equal(calls[0]!.reasoning, 'on', 'being wrong twice costs more than the latency');
});

test('the Unicode correction boundary reaches the source check whole', async () => {
  const { llm, calls } = spyLlm({ conceded: true, reply: 'r' });
  const challenge = '🙂'.repeat(2_000);
  await handleCorrection(deps(llm), 'claim', 'source', challenge);
  const run = calls[0]!.prompt.match(/🙂+/u)?.[0] ?? '';
  assert.equal(Array.from(run).length, 2_000,
    'the service accepted the challenge but the source check saw fewer characters');
});

test('a concession retires every authored shell around the bad claim', () => {
  const topic: Topic = {
    id: 't1', label: 'Firestore indexes', summary: 'A neutral topic summary',
    pinIds: ['p1'], state: 'working', comfort: 0.5, lastExposedAt: null,
    retiredByUser: false, createdAt: '2026-08-20T00:00:00Z',
  };
  const session: Session = {
    id: 's1', builtAt: '2026-08-20T00:00:00Z', fromPinCount: 1,
    targetMinutes: 5, estimatedMinutes: 5, currentSectionIndex: 1,
    closingNote: 'Direction matching is now established.',
    sections: [{
      topicId: 't1', heading: 'Direction must match', body: 'DESC cannot serve ASC.',
      depth: 'building', actionMinutes: 1, estimatedMinutes: 5,
      question: { kind: 'free-text', prompt: 'Why must direction match?', expectedPoints: ['direction'] },
      sourceIds: ['p1:origin'], completed: true, completionEvidence: 'answer',
      summary: 'Why direction must match', recap: 'Direction has to match.',
      corrections: [{
        id: 'c1', clientRef: 'client-c1', claim: 'DESC cannot serve ASC.',
        challenge: 'The source does not say that.',
        reply: 'The cited source does not establish a direction-matching rule.',
        conceded: true, sourceIds: ['p1:origin'], withdrawn: 1,
        at: '2026-08-20T01:00:00Z',
      }],
    }],
  };
  const repaired = retireConcededLessonShell(session, [topic]);
  assert.equal(repaired.sections[0]?.heading, 'Firestore indexes');
  assert.equal(repaired.sections[0]?.body,
    'The cited source does not establish a direction-matching rule.');
  assert.equal(repaired.sections[0]?.summary, null);
  assert.equal(repaired.sections[0]?.recap, null);
  assert.equal(repaired.sections[0]?.question, null);
  assert.equal(repaired.sections[0]?.actionMinutes, 0);
  assert.equal(repaired.sections[0]?.estimatedMinutes, 1);
  assert.equal(repaired.closingNote, null);
  assert.equal(session.sections[0]?.heading, 'Direction must match',
    'the read-time repair mutated the stored object');
});

test('historical source-boundary contradictions are withheld on read without rewriting them', () => {
  const topics: Topic[] = ['A', 'B', 'C'].map((id) => ({
    id, label: `Topic ${id}`, summary: '', pinIds: [`p${id}`], state: 'working',
    comfort: 0.5, lastExposedAt: null, retiredByUser: false,
    createdAt: '2026-08-20T00:00:00Z',
  }));
  const ordinary = (topicId: string): Session['sections'][number] => ({
    topicId, heading: `Topic ${topicId}`, body: 'The supplied material establishes this explanation.',
    depth: 'building', actionMinutes: 1, estimatedMinutes: 5,
    question: null, sourceIds: [`p${topicId}:origin`], completed: false,
  });
  const unsafe = {
    ...ordinary('B'),
    heading: 'A third range field',
    body: 'The source has reduced confidence, so it does not establish the full field-position algorithm.',
    question: {
      kind: 'free-text' as const,
      prompt: 'Why can the third range field not be appended?',
      expectedPoints: ['Its position is governed by the first range field, so it cannot be a simple append.'],
    },
  };
  const stored: Session = {
    id: 's206', builtAt: '2026-08-20T00:00:00Z', fromPinCount: 3,
    targetMinutes: 15, estimatedMinutes: 15, currentSectionIndex: 1,
    closingNote: 'All three lessons landed.', sections: [ordinary('A'), unsafe, ordinary('C')],
  };

  const shown = projectSafeSession(stored, topics);
  assert.deepEqual(shown.sections.map((section) => section.topicId), ['A', 'C']);
  assert.equal(shown.currentSectionIndex, 1, 'the next kept section did not become active');
  assert.equal(shown.estimatedMinutes, 10);
  assert.equal(shown.closingNote, null, 'a conclusion over the removed lesson survived');
  assert.deepEqual(shown.withheld, [{
    topicId: 'B', heading: 'A third range field', reason: 'defective',
  }]);
  assert.equal(stored.sections.length, 3, 'the read projection rewrote the ledger row');
  assert.equal(stored.closingNote, 'All three lessons landed.');
});

// ------------------------------------------------- the stale resume
