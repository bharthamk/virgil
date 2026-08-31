import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scout } from '../agents/scout.js';
import { forage } from '../agents/forager.js';
import { cluster, pinClusterText } from '../agents/clusterer.js';
import { analyse } from '../agents/analyst.js';
import { compose } from '../agents/composer.js';
import { verify } from '../agents/verifier.js';
import type { Deps } from '../agents/deps.js';
import type { Llm, LlmRequest, LlmResult } from '../ports/llm.js';
import type { Embedder } from '../ports/embedder.js';
import type { Research } from '../ports/research.js';
import { fixedClock } from '../ports/clock.js';
import type { Pin, Topic } from '../domain/types.js';

/**
 * How much of a hostile page can reach a prompt.
 *
 * The selection and the surrounding text have been capped since these agents
 * were written, because they are obviously the big fields. The fields beside
 * them were not, and three of those are just as much the page's to choose:
 * `document.title` is the page title, the heading path is the page's own
 * headings, and the site name comes off the page's metadata. A title is
 * normally sixty characters because pages want to be readable, not because
 * anything made it one.
 *
 * The consequence was not a safety hole — the fence still holds around any
 * amount of text — it was a budget one. A megabyte title on a pinned page put a
 * megabyte into the Scout's prompt, which is the FOREGROUND call inside a
 * 1500ms toast, and into the overnight naming, analysis and composition calls
 * after it. The caps here are the same shape and the same order of magnitude as
 * the ones already on the fields next to them, and they do not touch any title,
 * heading or note of a length a real page produces.
 */

const capture = () => {
  const seen: LlmRequest[] = [];
  const llm: Llm = {
    complete: async () => { throw new Error('not used'); },
    structured: async <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
      seen.push(req);
      return {
        value: {
          assumedConcepts: [], mediaDescription: null, names: [], observations: [],
          sections: [], closingNote: null, defects: [],
          label: 'x', matchedExistingLabel: null, confidence: 0.5,
        } as T,
        modelId: 'stub', inputTokens: 0, outputTokens: 0,
      };
    },
  };
  return { llm, seen };
};

const clock = fixedClock('2026-08-19T00:00:00Z');
const stubEmbedder: Embedder = { modelId: 'stub-space', embed: async (t) => t.map(() => [1, 0]) };
const noResearch: Research = { fetchPage: async () => null, findReferences: async () => [], hasGrounding: false };

const depsFor = (llm: Llm): Deps => ({
  llm, clock, research: noResearch, embedder: stubEmbedder,
  store: new Proxy({}, { get: () => { throw new Error('no store'); } }) as Deps['store'],
});

/** A megabyte in every field the page controls, and in the learner's note. */
const BIG = 'x'.repeat(1_000_000);

const hugeEnvelope = (): Pin['envelope'] => ({
  selection: BIG,
  parts: [{ role: 'passage', text: BIG }, { role: 'passage', text: BIG }],
  surroundingText: BIG,
  headingPath: [BIG, BIG, BIG],
  pageTitle: BIG,
  url: 'https://e.com',
  canonicalUrl: null,
  siteName: BIG,
  contentLanguage: 'en',
  media: null,
});

const hugePin = (id: string): Pin => ({
  id, type: 'interest', envelope: hugeEnvelope(), note: BIG,
  capturedAt: '2026-07-01T00:00:00Z', fromSuggestion: false, enrichment: null, topicId: 't1',
});

const topic = (id: string, pinIds: readonly string[]): Topic => ({
  id, label: `label of ${id}`, summary: `summary of ${id}`, pinIds,
  state: 'working', comfort: 0.5, lastExposedAt: null, retiredByUser: false,
  createdAt: '2026-07-01T00:00:00Z',
});

const comfort = (topicId: string) =>
  ({
    topicId, comfort: 0.5, regressed: false, evidenceCount: 2, demonstrationCount: 2,
    certainty: 0.5, evidenceSignalIds: [],
  });

/**
 * Generous on purpose. The point is not that a prompt is small, it is that the
 * size of the prompt is the product's decision and not the page's — 40k for a
 * pin whose fields hold seven megabytes is a cap doing its job, and any number
 * that scales with the input is not.
 */
const BUDGET = 40_000;

const agents: readonly [string, (llm: Llm) => Promise<unknown>][] = [
  ['scout', (llm) => scout({ llm, clock }, {
    envelope: hugeEnvelope(), type: 'interest', note: BIG, existingTopicLabels: [],
  })],
  ['forager', (llm) => forage(depsFor(llm), { pin: hugePin('p1') })],
  ['clusterer naming', (llm) => cluster({ llm, embedder: stubEmbedder },
    { pins: [hugePin('p1')], existingTopics: [], threshold: 0.9 })],
  ['analyst', (llm) => analyse({ llm, clock }, {
    pins: ['p1', 'p2', 'p3', 'p4'].map(hugePin), topics: [],
  })],
  ['composer', (llm) => compose({ llm, clock }, {
    topics: [topic('t1', ['p1'])], pins: [hugePin('p1')], comforts: [comfort('t1')],
    decisions: [{ topicId: 't1', disposition: 'teach', priority: 1, reason: 'r' }],
    observations: [], knownAboutLearner: [], targetMinutes: 15, interfaceLanguage: 'en',
  })],
];

for (const [name, run] of agents) {
  test(`${name}: a pin carrying megabytes cannot decide how long the prompt is`, async () => {
    const { llm, seen } = capture();
    await run(llm);
    assert.ok(seen.length > 0, `${name} made no model call`);
    for (const req of seen) {
      assert.ok(req.prompt.length < BUDGET,
        `${name}: ${req.prompt.length} characters reached the model from one pin`);
    }
  });
}

test('the verifier caps the source material it is handed', async () => {
  const { llm, seen } = capture();
  await verify({ llm, clock }, {
    section: {
      topicId: 't1', heading: 'h', body: 'b', depth: 'building',
      estimatedMinutes: 3, question: null, sourceIds: [], mediumWarning: null,
    },
    sourceMaterial: BIG, knownAboutLearner: [],
  });
  assert.ok((seen[0]?.prompt.length ?? 0) < BUDGET);
});

test('the text a pin is embedded from is bounded too', () => {
  // Not a prompt, but the same shape of problem one step earlier: this string
  // is what goes to the embedder, and an unbounded one is an unbounded request
  // on the clustering path every single night.
  assert.ok(pinClusterText(hugePin('p1')).length < BUDGET);
});

// ------------------------------------------------- the caps do not bite early

/**
 * The other half of the change, and the reason it is safe to make: a title, a
 * heading path or a note of a length a real page or a real learner produces
 * must reach the prompt exactly as it did before. A cap that trims ordinary
 * content would change every prompt in the fleet and invalidate the eval.
 */
const REAL_TITLE = 'Firestore composite indexes — Cloud Firestore Documentation | Google Cloud';
const REAL_HEADINGS = ['Cloud Firestore', 'Query data', 'Index types and their limits'];
const REAL_NOTE = 'I keep expecting the composite index to be picked automatically and it never is. '
  + 'Come back to the bit about inequality filters needing to be on the same field.';

test('an ordinary title, heading path and note pass through untouched', async () => {
  const envelope: Pin['envelope'] = {
    selection: 'A composite index stores a sorted mapping of documents.',
    parts: [], surroundingText: 'around it',
    headingPath: REAL_HEADINGS, pageTitle: REAL_TITLE,
    url: 'https://cloud.google.com/firestore', canonicalUrl: null,
    siteName: 'cloud.google.com', contentLanguage: 'en', media: null,
  };
  const pin: Pin = {
    id: 'p1', type: 'interest', envelope, note: REAL_NOTE,
    capturedAt: '2026-07-01T00:00:00Z', fromSuggestion: false, enrichment: null, topicId: 't1',
  };

  const runs: readonly [string, (llm: Llm) => Promise<unknown>][] = [
    ['scout', (llm) => scout({ llm, clock }, {
      envelope, type: 'interest', note: REAL_NOTE, existingTopicLabels: [],
    })],
    ['forager', (llm) => forage(depsFor(llm), { pin })],
    ['clusterer naming', (llm) => cluster({ llm, embedder: stubEmbedder },
      { pins: [pin], existingTopics: [], threshold: 0.9 })],
    ['analyst', (llm) => analyse({ llm, clock }, {
      pins: ['p1', 'p2', 'p3', 'p4'].map((id) => ({ ...pin, id })), topics: [],
    })],
    ['composer', (llm) => compose({ llm, clock }, {
      topics: [topic('t1', ['p1'])], pins: [pin], comforts: [comfort('t1')],
      decisions: [{ topicId: 't1', disposition: 'teach', priority: 1, reason: 'r' }],
      observations: [], knownAboutLearner: [], targetMinutes: 15, interfaceLanguage: 'en',
    })],
  ];

  for (const [name, run] of runs) {
    const { llm, seen } = capture();
    await run(llm);
    const prompt = seen.map((r) => r.prompt).join('\n');
    // Each agent uses a different subset; assert on whichever of the three it
    // actually rendered, and that whatever it rendered is the whole thing.
    for (const [field, value] of [
      ['pageTitle', REAL_TITLE], ['headingPath', REAL_HEADINGS.join(' > ')], ['note', REAL_NOTE],
    ] as const) {
      const head = value.slice(0, 30);
      if (!prompt.includes(head)) continue;
      assert.ok(prompt.includes(value), `${name}: an ordinary ${field} was trimmed by the cap`);
    }
  }
  assert.ok(pinClusterText(pin).includes(REAL_TITLE), 'the embedded text lost an ordinary title');
  assert.ok(pinClusterText(pin).includes(REAL_NOTE), 'the embedded text lost an ordinary note');
});
