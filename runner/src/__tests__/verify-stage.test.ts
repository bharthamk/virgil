import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ComposedSection, Llm, LlmRequest, LlmResult, Pin, PureDeps,
} from '@sb/core';
import {
  MEDIUM_ACTION_PROMPT, THIN_MEDIUM_WARNING, thinMediumBody,
} from '@sb/core';
import { verifySections, VERIFIER_CHARS_PER_PIN } from '../pipeline.js';

/**
 * The verify stage of the nightly run.
 *
 * Two things are asserted here that a live run measured and no test held:
 *
 *  1. A section whose verification CALL failed used to be kept, with a
 *     `degraded` flag set on it that nothing downstream ever read. One of three
 *     calls failed on a real run, its section shipped, and the summary said
 *     "all sections clear" — a safety check failing open, which is worse than
 *     no safety check because it manufactures the confidence.
 *  2. The material handed to the Verifier used to be every pin's whole
 *     selection, unsliced, in a stage whose material window is 6,000
 *     characters. One long pin evicts the rest of the topic from it.
 */

const clock = { now: () => new Date('2026-08-19T03:00:00Z') };

/** Records every prompt it is given, and answers however the test says. */
function llmSpy(answer: (req: LlmRequest) => unknown): { llm: Llm; prompts: string[] } {
  const prompts: string[] = [];
  const llm: Llm = {
    complete: async () => { throw new Error('the verifier does not use complete()'); },
    structured: async <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
      prompts.push(req.prompt);
      return {
        value: answer(req) as T, modelId: 'stub', inputTokens: 0, outputTokens: 0,
      };
    },
  };
  return { llm, prompts };
}

const deps = (llm: Llm): PureDeps => ({ llm, clock });

const section = (topicId: string, heading: string, body = 'Plain prose with nothing checkable in it.'): ComposedSection => ({
  topicId, heading, body, depth: 'building', estimatedMinutes: 4,
  question: null, sourceIds: [`${topicId}:origin`], mediumWarning: null,
});

const pin = (id: string, topicId: string, selection: string): Pin => ({
  id, type: 'interest',
  envelope: {
    selection, parts: [], surroundingText: 'fallback', headingPath: [],
    pageTitle: 't', url: 'https://e.test', canonicalUrl: null, siteName: null,
    contentLanguage: 'en', media: null,
  },
  note: null, capturedAt: '2026-08-01T00:00:00Z',
  fromSuggestion: false, enrichment: null, topicId,
});

const CLEAN = { defects: [] };
const FATAL = {
  defects: [{
    kind: 'inconsistent', quote: 'six semitones', problem: 'C to F# is six, not one',
    severity: 'fatal',
  }],
};

// ------------------------------------------------- a check that ran and passed

test('a section the verifier cleared ships, and nothing is withheld', async () => {
  const { llm } = llmSpy(() => CLEAN);
  const out = await verifySections(deps(llm), {
    sections: [section('T1', 'One')], pins: [pin('p1', 'T1', 'material')],
    knownAboutLearner: [],
  });

  assert.deepEqual(out.kept.map((s) => s.heading), ['One']);
  assert.deepEqual(out.withheld, []);
  assert.match(out.detail, /all sections clear/);
});

test('the exact governed thin handoff needs no model call and still reports its check', async () => {
  let calls = 0;
  const { llm } = llmSpy(() => { calls++; return CLEAN; });
  const instruction = 'Keep your palms facing down and your elbows relaxed.';
  const governed: ComposedSection = {
    ...section('T1', 'Source-backed setup', thinMediumBody(instruction)),
    mediumWarning: THIN_MEDIUM_WARNING,
    actionMinutes: 1,
    question: { prompt: MEDIUM_ACTION_PROMPT, kind: 'free-text', expectedPoints: [] },
  };
  const out = await verifySections(deps(llm), {
    sections: [governed], pins: [pin('p1', 'T1', instruction)],
    knownAboutLearner: [],
  });

  assert.equal(calls, 0, 'fixed product copy and a verbatim source quote are checked in code');
  assert.deepEqual(out.kept.map((s) => s.heading), ['Source-backed setup']);
  assert.deepEqual(out.withheld, []);
  assert.match(out.detail, /1 governed \/ 0 deep \/ 0 fast/);
});

test('SB-206: the real source-boundary marking contradiction is withheld before a model call', async () => {
  let calls = 0;
  const { llm } = llmSpy(() => { calls++; return CLEAN; });
  const firestore: ComposedSection = {
    ...section('T1', 'Ordering constraints',
      'The passage carries reduced confidence, so I will not spell out the full field-position algorithm beyond what it states.'),
    summary: 'The exact field-position rule',
    recap: 'The exact field-position rule',
    question: {
      prompt: 'What does the field-position constraint force you to do?',
      kind: 'free-text',
      expectedPoints: ['The third field cannot be a simple append.'],
    },
  };
  const out = await verifySections(deps(llm), {
    sections: [firestore],
    pins: [pin('p1', 'T1', 'Multiple-range queries are subject to ordering constraints.')],
    knownAboutLearner: [],
  });

  assert.equal(calls, 0);
  assert.deepEqual(out.kept, []);
  assert.equal(out.withheld[0]?.reason, 'defective');
  assert.equal(out.withheld[0]?.defects[0]?.kind, 'unsupported');
  assert.match(out.detail, /1 governed \/ 0 deep \/ 0 fast/);
});

// ------------------------------------------------ a check that ran and failed

test('a fatal defect withholds the section as defective, with the finding kept', async () => {
  const { llm } = llmSpy(() => FATAL);
  const out = await verifySections(deps(llm), {
    sections: [section('T1', 'One')], pins: [pin('p1', 'T1', 'material')],
    knownAboutLearner: [],
  });

  assert.deepEqual(out.kept, []);
  assert.equal(out.withheld.length, 1);
  assert.equal(out.withheld[0]?.reason, 'defective');
  assert.equal(out.withheld[0]?.error, null, 'nothing failed — the check worked');
  assert.equal(out.withheld[0]?.defects.length, 1, 'and the reason it was withheld survives');
  assert.match(out.detail, /1 withheld/);
});

// ------------------------------------------------------- a check that DID NOT run

test('a section whose verifier call failed is not shipped', async () => {
  // The defect this file exists for. Neither verified nor failed is not a
  // licence to ship: the section goes, and the learner sees one section fewer
  // rather than one unchecked section.
  const { llm } = llmSpy(() => { throw new Error('fetch failed'); });
  const out = await verifySections(deps(llm), {
    sections: [section('T1', 'One')], pins: [pin('p1', 'T1', 'material')],
    knownAboutLearner: [],
  });

  assert.deepEqual(out.kept, [], 'an unchecked section must never reach a learner');
  assert.equal(out.withheld.length, 1);
  assert.equal(out.withheld[0]?.reason, 'unverified');
  assert.equal(out.withheld[0]?.defects.length, 0, 'no finding — that is the point');
  assert.match(String(out.withheld[0]?.error), /fetch failed/,
    'and why it could not run is recorded, because that is the only evidence there is');
});

test('an unverified section names its topic, so the topic returns to the pool', async () => {
  // Withholding is the mechanism: an unshipped section never advances
  // lastExposedAt, so the Gardener still sees the topic as owed tomorrow.
  const { llm } = llmSpy(() => { throw new Error('fetch failed'); });
  const out = await verifySections(deps(llm), {
    sections: [section('T7', 'One')], pins: [pin('p1', 'T7', 'material')],
    knownAboutLearner: [],
  });

  assert.equal(out.withheld[0]?.topicId, 'T7');
  assert.equal(out.kept.some((s) => s.topicId === 'T7'), false);
});

test('unverified is counted and named apart from defective', async () => {
  // Lumping the two together would report the Verifier working when it was not.
  const { llm } = llmSpy((req) => {
    if (req.prompt.includes('SECTION: Broken')) return FATAL;
    if (req.prompt.includes('SECTION: Unreachable')) throw new Error('fetch failed');
    return CLEAN;
  });
  const out = await verifySections(deps(llm), {
    sections: [section('T1', 'Fine'), section('T2', 'Broken'), section('T3', 'Unreachable')],
    pins: [pin('p1', 'T1', 'm'), pin('p2', 'T2', 'm'), pin('p3', 'T3', 'm')],
    knownAboutLearner: [],
  });

  assert.deepEqual(out.kept.map((s) => s.heading), ['Fine']);
  assert.deepEqual(
    out.withheld.map((w) => [w.heading, w.reason]),
    [['Broken', 'defective'], ['Unreachable', 'unverified']]);
  assert.match(out.detail, /1 withheld/);
  assert.match(out.detail, /1 UNVERIFIED/);
  assert.equal(/2 withheld/.test(out.detail), false,
    'the unverified section is not folded into the withheld count');
});

test('one failed call does not stop the sections around it being checked', async () => {
  let calls = 0;
  const { llm } = llmSpy((req) => {
    calls++;
    if (req.prompt.includes('SECTION: Unreachable')) throw new Error('fetch failed');
    return CLEAN;
  });
  const out = await verifySections(deps(llm), {
    sections: [section('T1', 'Unreachable'), section('T2', 'Fine'), section('T3', 'Also fine')],
    pins: [pin('p1', 'T1', 'm'), pin('p2', 'T2', 'm'), pin('p3', 'T3', 'm')],
    knownAboutLearner: [],
  });

  assert.equal(calls, 3, 'every section is still attempted');
  assert.deepEqual(out.kept.map((s) => s.heading), ['Fine', 'Also fine']);
});

// -------------------------------------------------------- the per-pin material cap

test('the verifier sees at most the per-pin cap of any one pin', async () => {
  const { llm, prompts } = llmSpy(() => CLEAN);
  await verifySections(deps(llm), {
    sections: [section('T1', 'One')],
    pins: [pin('p1', 'T1', 'a'.repeat(50_000))],
    knownAboutLearner: [],
  });

  const longest = Math.max(...(prompts[0]?.match(/a+/g) ?? ['']).map((r) => r.length));
  assert.equal(longest, VERIFIER_CHARS_PER_PIN,
    'a 50KB selection is sliced like every other agent slices its material');
});

test('a long pin cannot evict the rest of the topic from the material window', async () => {
  // The failure mode that matters. The Verifier's material window is 6,000
  // characters; four unsliced pins of 50KB each meant the section was checked
  // against a fragment of one of them and nothing else.
  const { llm, prompts } = llmSpy(() => CLEAN);
  await verifySections(deps(llm), {
    sections: [section('T1', 'One')],
    pins: [
      pin('p1', 'T1', 'a'.repeat(50_000)),
      pin('p2', 'T1', 'b'.repeat(50_000)),
      pin('p3', 'T1', 'the third pin says SPARROW'),
    ],
    knownAboutLearner: [],
  });

  assert.match(String(prompts[0]), /SPARROW/,
    'every pin on the topic still reaches the prompt');
});

test('a pin with no selection falls back to its surrounding text, capped the same way', async () => {
  const { llm, prompts } = llmSpy(() => CLEAN);
  const p = pin('p1', 'T1', '');
  await verifySections(deps(llm), {
    sections: [section('T1', 'One')],
    pins: [{ ...p, envelope: { ...p.envelope, selection: null, surroundingText: 'c'.repeat(9_000) } }],
    knownAboutLearner: [],
  });

  const longest = Math.max(...(prompts[0]?.match(/c+/g) ?? ['']).map((r) => r.length));
  assert.equal(longest, VERIFIER_CHARS_PER_PIN);
});

test('a selected phrase keeps its real surrounding evidence for physical verification', async () => {
  const { llm, prompts } = llmSpy(() => CLEAN);
  const p = pin('p1', 'T1', 'American grip');
  await verifySections(deps(llm), {
    sections: [section('T1', 'One')],
    pins: [{
      ...p,
      envelope: {
        ...p.envelope,
        surroundingText: 'For an American grip, keep your palms facing down and your elbows relaxed.',
      },
    }],
    knownAboutLearner: [],
  });

  assert.match(String(prompts[0]), /Selected text: American grip/);
  assert.match(String(prompts[0]), /keep your palms facing down and your elbows relaxed/,
    'the safety check cannot verify an instruction against a phrase stripped of its context');
});
