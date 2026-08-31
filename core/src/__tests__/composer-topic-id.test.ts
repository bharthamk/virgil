import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compose, COMPOSER_SYSTEM, SUMMARY_LINE_CHARS } from '../agents/composer.js';
import type { PureDeps } from '../agents/deps.js';
import type { Llm, LlmRequest, LlmResult } from '../ports/llm.js';
import type { Pin, Topic } from '../domain/types.js';
import type { ComfortResult } from '../agents/registrar.js';
import type { GardenDecision } from '../agents/gardener.js';

/**
 * The topic id on the way back from the model.
 *
 * `compose` drops a section whose `topicId` was never offered, and it is right
 * to: that id decides which pins the Verifier reads the section against and
 * which topic returns to the pool, so a section citing an invented topic
 * is checked against no material at all. What the filter did NOT account for is
 * that it is matching a model's formatting against an exact string, and every
 * other place in the fleet that compares model output to a known value
 * normalises first — `resolveSourceIds` repairs case and brackets, the Verifier
 * lowercases a defect kind before filtering on it.
 *
 * Found live rather than reasoned about. Re-running the adversarial suite
 * against the local model returned a session with ZERO sections from a probe
 * that had produced one every previous run, with `sourceIdDrops` at 0 — meaning
 * nothing reached the source resolver, meaning every section had been dropped
 * before it. See `artifacts-local/ADVERSARIAL_RUN_2026-08-20.md`.
 */

const clock = { now: () => new Date('2026-08-20T03:00:00Z') };

const llmReturning = (sections: unknown): PureDeps => {
  const llm: Llm = {
    complete: async () => { throw new Error('the composer does not use complete()'); },
    structured: async <T>(_req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => ({
      value: { sections, closingNote: 'one clause, another, a third' } as T,
      modelId: 'stub', inputTokens: 0, outputTokens: 0,
    }),
  };
  return { llm, clock };
};

const pin = (id: string, topicId: string): Pin => ({
  id,
  type: 'interest',
  envelope: {
    selection: `the passage behind ${id}`,
    parts: [],
    surroundingText: 'ordinary prose around it',
    headingPath: ['Docs'],
    pageTitle: `page for ${id}`,
    url: 'https://example.test/doc',
    canonicalUrl: null,
    siteName: null,
    contentLanguage: 'en',
    media: null,
  },
  note: null,
  capturedAt: '2026-08-01T00:00:00Z',
  fromSuggestion: false,
  enrichment: null,
  topicId,
});

const topic = (id: string): Topic => ({
  id, label: `label of ${id}`, summary: `summary of ${id}`, pinIds: [],
  state: 'working', comfort: 0.5, lastExposedAt: null,
  retiredByUser: false, createdAt: '2026-08-01T00:00:00Z',
});

const comfort = (topicId: string): ComfortResult =>
  ({
    topicId, comfort: 0.5, regressed: false, evidenceCount: 4, demonstrationCount: 2,
    certainty: 0.8, evidenceSignalIds: [],
  });

const decision = (topicId: string): GardenDecision =>
  ({ topicId, disposition: 'teach', reason: 'never taught', priority: 80 });

const input = (pins: readonly Pin[], topics: readonly Topic[]) => ({
  topics,
  pins,
  comforts: topics.map((t) => comfort(t.id)),
  decisions: topics.map((t) => decision(t.id)),
  observations: [],
  knownAboutLearner: [],
  targetMinutes: 15,
  interfaceLanguage: 'en',
});

const body = 'w '.repeat(120);
const section = (topicId: unknown) => ({
  topicId, heading: 'One', body, estimatedMinutes: 4, question: null,
  sourceIds: ['p-1:origin'], mediumWarning: null,
  summary: 'How the moon and sun combine to size the tides',
});

test('a section naming a topic that was offered is kept', async () => {
  const out = await compose(llmReturning([section('T1')]), input([pin('p-1', 'T1')], [topic('T1')]));
  assert.equal(out.sections.length, 1);
  assert.equal(out.sections[0]?.topicId, 'T1');
});

test('a section naming a topic that was never offered is dropped', async () => {
  // The intended behaviour, and the reason the filter exists at all.
  const out = await compose(llmReturning([section('T1'), section('T-invented')]),
    input([pin('p-1', 'T1')], [topic('T1')]));
  assert.deepEqual(out.sections.map((s) => s.topicId), ['T1']);
});

test('a section that answers with the topic LABEL instead of its id is dropped', async () => {
  // Also intended: a label is not an id, and guessing which topic was meant is
  // the fabrication the filter is there to prevent.
  const out = await compose(llmReturning([section('label of T1')]),
    input([pin('p-1', 'T1')], [topic('T1')]));
  assert.equal(out.sections.length, 0);
});

test('whitespace around a topic id is a formatting variation, not a different topic', async () => {
  // The fix. Every other comparison against model output in this fleet
  // normalises before it matches; this one did not, so `"T1 "` was treated as a
  // topic nobody offered and a perfectly good section was thrown away.
  for (const id of ['T1 ', ' T1', ' T1 ', '\nT1\t']) {
    // eslint-disable-next-line no-await-in-loop
    const out = await compose(llmReturning([section(id)]), input([pin('p-1', 'T1')], [topic('T1')]));
    assert.equal(out.sections.length, 1, `${JSON.stringify(id)} should resolve to T1`);
    assert.equal(out.sections[0]?.topicId, 'T1', 'and it is stored trimmed, not as the model wrote it');
  }
});

test('a non-string topic id does not throw on the way through the filter', async () => {
  for (const id of [42, {}, [], true]) {
    // eslint-disable-next-line no-await-in-loop
    const out = await compose(llmReturning([section(id)]), input([pin('p-1', 'T1')], [topic('T1')]));
    assert.equal(out.sections.length, 0, `${JSON.stringify(id)} names no offered topic`);
  }
});

test('a session whose every section was dropped is a model failure, not an empty board', async () => {
  const out = await compose(llmReturning([section('T-invented'), section('T-also-invented')]),
    input([pin('p-1', 'T1')], [topic('T1')]));
  assert.equal(out.sections.length, 0);
  assert.equal(out.estimatedMinutes, 0);
  assert.equal(out.outcome, 'model-failed');
  assert.equal(out.insufficient, false,
    'there was material to teach — saying otherwise would blame the board for the model');
  // Nothing reached the source resolver, which is the signature that identified
  // this live: drops at zero with zero sections means they went earlier.
  assert.equal(out.sourceIdDrops, 0);
  assert.equal(out.sourceIdRepairs, 0);
});

test('a reply with no sections at all is the same failure by a different route', async () => {
  // Every way the model can return nothing while topics were chosen. The route
  // differs; what the learner is owed does not.
  for (const sections of [[], null, undefined, 'sections', 42]) {
    // eslint-disable-next-line no-await-in-loop
    const out = await compose(llmReturning(sections), input([pin('p-1', 'T1')], [topic('T1')]));
    assert.equal(out.outcome, 'model-failed', `${JSON.stringify(sections ?? null)} is not a session`);
    assert.equal(out.insufficient, false);
  }
});

test('a night that teaches something says so, and a board with nothing to teach says that', async () => {
  // The other two states, asserted beside the new one so the union is closed by
  // a test rather than by reading the type.
  const composed = await compose(llmReturning([section('T1')]), input([pin('p-1', 'T1')], [topic('T1')]));
  assert.equal(composed.outcome, 'composed');
  assert.equal(composed.insufficient, false);

  const empty = await compose(llmReturning([]), { ...input([], []), decisions: [] });
  assert.equal(empty.outcome, 'nothing-to-teach');
  assert.equal(empty.insufficient, true, ' keeps its name for the state it was written about');
});

test('insufficient is the  name for exactly one outcome, and never for the other two', async () => {
  // The field is kept for  contract and readers that predate `outcome`.
  // It has to stay in step with the state it names or it becomes a second,
  // disagreeing answer to the same question.
  const cases: [unknown[], string, boolean][] = [
    [[section('T1')], 'composed', false],
    [[section('T-invented')], 'model-failed', false],
  ];
  for (const [sections, outcome, insufficient] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const out = await compose(llmReturning(sections), input([pin('p-1', 'T1')], [topic('T1')]));
    assert.equal(out.outcome, outcome);
    assert.equal(out.insufficient, insufficient);
    assert.equal(out.insufficient, out.outcome === 'nothing-to-teach');
  }
});

/**
 * The learner-lineup contract — THE `why now:` LINE, KEPT.
 *
 * The Gardener's reason has been written into every brief since the Composer
 * was built (`  why now: ${decision.reason}`) and discarded the moment the
 * prose came back. So the one sentence that explains why a topic is in tonight
 * reached the model and never the person it was about, and the only surface
 * that could say anything was the card's single line about the whole night.
 *
 * Carried on the section, out of the same map the briefs were written from, so
 * the reason stored against a section is the reason the section was
 * commissioned with. Nothing is asked of the model and nothing is rephrased.
 */
test('a section keeps the reason the ranker commissioned it with', async () => {
  const out = await compose(llmReturning([section('T1')]), {
    ...input([pin('p-1', 'T1')], [topic('T1')]),
    decisions: [{
      topicId: 'T1', disposition: 'teach',
      reason: 'nothing has been asked about this yet', priority: 80,
    }],
  });
  assert.equal(out.sections[0]?.why, 'nothing has been asked about this yet');
});

test('the reason is the ranker’s, not the model’s, even when the model sends one', async () => {
  // The model is never asked for this field and is never allowed to write it.
  // A why-line the model invented would be a plausible sentence with nothing
  // behind it, on the one control whose whole job is being checkable.
  const out = await compose(
    llmReturning([{ ...section('T1'), why: 'because I felt like it' }]),
    {
      ...input([pin('p-1', 'T1')], [topic('T1')]),
      decisions: [{ topicId: 'T1', disposition: 'teach', reason: 'due for a check', priority: 60 }],
    });
  assert.equal(out.sections[0]?.why, 'due for a check');
});


/**
 * WHAT A LESSON COVERS, WRITTEN IN THE CALL THAT WROTE THE LESSON.
 *
 * The lineup must not use a section's opening sentence as its label because a
 * well-written lesson may open with an analogy rather than its subject.
 *
 * One more field on a commission that already asks for a heading, a recap and a
 * closing note. **No extra model call** — that is the constraint this is built
 * under, and `composer-budget.test.ts` is what keeps it.
 */
test('a section carries the one-line description the model was asked for', async () => {
  const out = await compose(llmReturning([section('T1')]), input([pin('p-1', 'T1')], [topic('T1')]));
  assert.equal(out.sections[0]?.summary, 'How the moon and sun combine to size the tides');
});

test('the summary is a label, so it is cleaned like one', async () => {
  const said = async (summary: unknown): Promise<string | null | undefined> => {
    const out = await compose(
      llmReturning([{ ...section('T1'), summary }]),
      input([pin('p-1', 'T1')], [topic('T1')]));
    return out.sections[0]?.summary;
  };
  // A trailing stop goes: a column of one-line labels reads better without one,
  // and the prompt asks for none.
  assert.equal(await said('How the moon and sun size the tides.'),
    'How the moon and sun size the tides');
  assert.equal(await said('  How the moon\n  and sun size the tides  '),
    'How the moon and sun size the tides');
  // Nothing usable is null, and the read side shows nothing rather than
  // reaching for the body.
  for (const raw of [undefined, null, 42, '', '   ']) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await said(raw), null, JSON.stringify(raw));
  }
});

test('a summary long enough to be prose is cut at a word', async () => {
  const out = await compose(
    llmReturning([{ ...section('T1'), summary: `${'alpha '.repeat(40)}omega` }]),
    input([pin('p-1', 'T1')], [topic('T1')]));
  const said = out.sections[0]?.summary as string;
  assert.ok(said.length <= SUMMARY_LINE_CHARS + 1, `line was ${said.length}`);
  assert.ok(said.endsWith('…') && said.slice(0, -1).endsWith('alpha'));
});

test('the commission asks for the summary and the recap as different lines', () => {
  // The failure this guards is a model writing one sentence twice. A recap is
  // for somebody coming back who has read it; a summary is for somebody who has
  // not opened it and is choosing.
  assert.match(COMPOSER_SYSTEM, /summary: for EACH section/);
  assert.match(COMPOSER_SYSTEM, /are NOT the same line/);
  assert.match(COMPOSER_SYSTEM, /Never open with an analogy/);
});
