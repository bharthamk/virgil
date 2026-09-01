import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fallbackLabel, scout } from '../agents/scout.js';
import { PINNED_TAG } from '../agents/untrusted.js';
import type { PureDeps } from '../agents/deps.js';
import type { CaptureEnvelope } from '../domain/types.js';
import type { Llm, LlmRequest, LlmResult } from '../ports/llm.js';

/**
 * The label that renders inside the toast.
 *
 * Scout had no test of its own, which mattered more than it looks: it is the
 * only agent a learner ever waits for, and the only one whose output they see
 * before anything else the product does. Three things are checked here and all
 * three were unasserted — that the learner's own note reaches it (SB-12), that a
 * whole-page pin is a normal case rather than an error (SB-07), and that a model
 * answering with nothing still produces a label rather than a blank toast
 * (SB-03).
 */

const clock = { now: () => new Date('2026-08-20T09:00:00Z') };

/** Records what Scout asked for, and answers however the test says. */
const spyLlm = (payload: unknown): { llm: Llm; calls: LlmRequest[] } => {
  const calls: LlmRequest[] = [];
  return {
    calls,
    llm: {
      complete: async () => { throw new Error('scout does not use complete()'); },
      structured: async <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
        calls.push(req);
        if (payload instanceof Error) throw payload;
        return { value: payload as T, modelId: 'stub', inputTokens: 0, outputTokens: 0 };
      },
    },
  };
};

const deps = (llm: Llm): PureDeps => ({ llm, clock });

const envelope = (over: Partial<CaptureEnvelope> = {}): CaptureEnvelope => ({
  selection: 'Pull subscriptions use a subscriber client that opens a stream.',
  parts: [{ role: 'passage', text: 'Pull subscriptions use a subscriber client.' }],
  surroundingText: 'A long run of page text about delivery semantics and acknowledgement deadlines.',
  headingPath: ['Docs', 'Pub/Sub', 'Subscription types'],
  pageTitle: 'Choose a subscription type',
  url: 'https://cloud.example.test/pubsub/subscriber',
  canonicalUrl: null,
  siteName: 'cloud.example.test',
  contentLanguage: 'en',
  media: null,
  ...over,
});

const answer = { label: 'Subscription types', matchedExistingLabel: null, confidence: 0.8 };

// ------------------------------------------------------------- what it is told

test('SB-12: the one word the learner left with the pin reaches the model', async () => {
  // The note is the highest-signal, cheapest input the product has, and the
  // agent side of SB-12 is the half that is real. If it stops arriving here,
  // nothing fails and nobody notices.
  const { llm, calls } = spyLlm(answer);
  await scout(deps(llm), {
    envelope: envelope(), type: 'interest', note: 'why?', existingTopicLabels: [],
  });
  assert.match(calls[0]!.prompt, /Learner's own note: "why\?"/);
});

test('SB-12: no note means no line about a note, rather than an empty one', async () => {
  const { llm, calls } = spyLlm(answer);
  await scout(deps(llm), {
    envelope: envelope(), type: 'interest', note: null, existingTopicLabels: [],
  });
  assert.doesNotMatch(calls[0]!.prompt, /Learner's own note/);
});

test('SB-13: a struggle pin says so, and an interest pin does not', async () => {
  const { llm, calls } = spyLlm(answer);
  await scout(deps(llm), {
    envelope: envelope(), type: 'struggle', note: null, existingTopicLabels: [],
  });
  assert.match(calls[0]!.prompt, /struggling with/);

  const plain = spyLlm(answer);
  await scout(deps(plain.llm), {
    envelope: envelope(), type: 'interest', note: null, existingTopicLabels: [],
  });
  assert.doesNotMatch(plain.calls[0]!.prompt, /struggling with/);
});

test('SB-07: a whole-page pin is labelled from the page text, not refused', async () => {
  const { llm, calls } = spyLlm(answer);
  const out = await scout(deps(llm), {
    envelope: envelope({ selection: null }),
    type: 'interest', note: null, existingTopicLabels: [],
  });
  assert.equal(out.label, 'Subscription types');
  assert.match(calls[0]!.prompt, /A long run of page text about delivery semantics/);
});

test('the passage handed to the model is capped, whatever the page did', async () => {
  const { llm, calls } = spyLlm(answer);
  await scout(deps(llm), {
    envelope: envelope({ selection: 'x'.repeat(5000) }),
    type: 'interest', note: null, existingTopicLabels: [],
  });
  const passage = /Passage: "(x+)"/.exec(calls[0]!.prompt);
  assert.ok(passage, 'the passage is still recognisably a passage');
  assert.equal(passage![1]!.length, 900);
});

test('the pinned text and model-written board labels are fenced', async () => {
  // Scout is the first thing in the product to touch arbitrary web text. The
  // topic list was written by another model from that text, so it can carry a
  // page instruction at one remove even though the board now owns the label.
  const { llm, calls } = spyLlm(answer);
  await scout(deps(llm), {
    envelope: envelope(), type: 'interest', note: null,
    existingTopicLabels: ['IAM conditions'],
  });
  const prompt = calls[0]!.prompt;
  const close = prompt.indexOf(`</${PINNED_TAG}>`);
  assert.ok(close > 0, 'the material is fenced');
  assert.ok(prompt.indexOf('Existing topics') < close,
    'a topic label written by the naming model was left at instruction level');
  assert.equal(prompt.indexOf('Existing topics', close), -1,
    'the model-written board label also appears outside the fence');
});

// --------------------------------------------------------------- what it answers

test('SB-03: a model that answers with an empty label still fills the toast', async () => {
  const { llm } = spyLlm({ label: '   ', matchedExistingLabel: null, confidence: 0.9 });
  const out = await scout(deps(llm), {
    envelope: envelope(), type: 'interest', note: null, existingTopicLabels: [],
  });
  assert.equal(out.label, 'Subscription types', 'the deepest heading, not a blank toast');
});

test('a confidence that is not a number is not carried through as one', async () => {
  const { llm } = spyLlm({ label: 'A label', matchedExistingLabel: null, confidence: 'high' });
  const out = await scout(deps(llm), {
    envelope: envelope(), type: 'interest', note: null, existingTopicLabels: [],
  });
  assert.equal(out.confidence, 0.5);
  assert.equal(out.matchedExistingLabel, null);
});

test('SB-03: the fallback prefers the deepest heading, then the title, then anything', () => {
  assert.equal(fallbackLabel(envelope()), 'Subscription types');
  assert.equal(fallbackLabel(envelope({ headingPath: [] })), 'Choose a subscription type');
  assert.equal(fallbackLabel(envelope({ headingPath: [], pageTitle: '' })), 'Saved');
  assert.equal(fallbackLabel(envelope({ headingPath: ['H'.repeat(80)] })).length, 40,
    'a label long enough to break the toast is cut');
});

test('a fallback label is the subject, not the subject plus a truncated masthead', () => {
  /**
   * `cutToWord` was doing its job: that IS a word boundary. The defect is one
   * step earlier. Almost every page on the open web titles itself
   * `<subject> | <masthead>`, so a fallback taken from the raw title is the
   * subject plus however much of the publication fits — and the longer the
   * masthead, the less of the actual subject survives.
   *
   * The envelope already carries `siteName`: the exact string to remove. So this
   * is evidence rather than a guess about separators, and it is deliberately
   * only done when the evidence is there. A title with no `siteName` to match
   * is left alone, because splitting on the last `|` would damage every title
   * that legitimately contains one.
   */
  const at = (pageTitle: string, siteName: string | null): string =>
    fallbackLabel(envelope({ headingPath: [], pageTitle, siteName }));

  // The real one, verbatim off the board.
  assert.equal(
    at('How to write a short story | National Centre for Writing | NCW', 'National Centre for Writing | NCW'),
    'How to write a short story');

  // The other separators mastheads use.
  assert.equal(at('Composite indexes - Firestore', 'Firestore'), 'Composite indexes');
  assert.equal(at('Composite indexes — Firestore', 'Firestore'), 'Composite indexes');
  assert.equal(at('Composite indexes · Firestore', 'Firestore'), 'Composite indexes');

  // A title that IS the masthead — a homepage — keeps it. An empty heading is
  // a broken screen, and this is the one case where stripping leaves nothing.
  assert.equal(at('National Centre for Writing', 'National Centre for Writing'),
    'National Centre for Writing');

  // The site name occurring in the middle, or at the end without a separator
  // in front of it, is the subject talking about itself. Left alone.
  assert.equal(at('Firestore indexes explained', 'Firestore'), 'Firestore indexes explained');
  assert.equal(at('Everything about Firestore', 'Firestore'), 'Everything about Firestore');

  // No evidence, no strip.
  assert.equal(at('Composite indexes - Firestore', null), 'Composite indexes - Firestore');

  // And the point of doing it BEFORE the cut: the subject survives whole where
  // it used to be crowded out by the masthead's first few words.
  assert.equal(
    at('Understanding acknowledgement deadlines | The Cloud Documentation Project', 'The Cloud Documentation Project'),
    'Understanding acknowledgement deadlines');
});

test('a fallback label is cut at a word, never through one', () => {
  // The first real pin anybody made produced "Deep Learning with PyTorch -
  // Network Arc", which reads as a bug rather than as an abbreviation. Found
  // by using the product, 2026-08-22.
  const at = (pageTitle: string): string =>
    fallbackLabel(envelope({ headingPath: [], pageTitle }));

  assert.equal(at('Deep Learning with PyTorch - Network Architectures Solution'),
    'Deep Learning with PyTorch - Network');

  // A boundary that lands after a function word takes it with it: "Training a"
  // is a legal cut and still reads as damage.
  assert.equal(at('Deep Learning with PyTorch - Training a Network Solution'),
    'Deep Learning with PyTorch - Training');
  assert.ok(!at('Deep Learning with PyTorch - Network Architectures Solution').endsWith('Arc'));

  // A title that fits is untouched, including its own punctuation.
  assert.equal(at('Firestore composite indexes'), 'Firestore composite indexes');

  // One unbroken token has no boundary to find, so it is cut rather than
  // collapsed: a hard cut is ugly, an empty heading is a broken screen.
  const long = 'a'.repeat(90);
  assert.equal(at(long).length, 40);

  // The heading path outranks the title and is cut by the same rule.
  assert.equal(
    fallbackLabel(envelope({ headingPath: ['Deep Learning with PyTorch - Network Architectures'] })),
    'Deep Learning with PyTorch - Network');

  // Nothing at all is still the old answer.
  assert.equal(at(''), 'Saved');
});
