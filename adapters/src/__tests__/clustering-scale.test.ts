import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cluster, type ClustererDeps } from '@sb/core';
import type { Llm, LlmRequest, LlmResult, Pin, Topic } from '@sb/core';
import { TfIdfEmbedder } from '../tfidf-embedder.js';

/**
 * SB-57 — two hundred pins.
 *
 * "Untested above ~21 pins" was the story's own statement of the risk, and the
 * scale run that answered it (AGENT_EVAL_LOG Run 6) measured 80 pins against a
 * live stack and could not finish the nightly. Neither of those is repeatable in
 * a test suite, and neither of them is what would break first.
 *
 * What would break first is the guarantee, not the quality: at 200 pins the
 * partition must still be total, still be deterministic, and still refuse to
 * move a pin that already belongs to a topic. Those are properties of the
 * arithmetic, they are the ones the whole board's stability rests on, and they
 * can be checked at real scale in milliseconds with no model involved. The
 * partition's *accuracy* at scale is a measurement and stays in the eval log;
 * this is the part that should fail a build.
 */

const DOMAINS: readonly { topic: string; heading: string; words: readonly string[] }[] = [
  { topic: 'Pub/Sub delivery', heading: 'Pub/Sub > Subscriptions', words: ['subscription', 'acknowledge', 'redelivered', 'subscriber', 'topic', 'message', 'deadline', 'pull', 'push', 'ordering'] },
  { topic: 'IAM conditions', heading: 'IAM > Conditions', words: ['condition', 'expression', 'principal', 'binding', 'policy', 'attribute', 'resource', 'grant', 'role', 'allow'] },
  { topic: 'Ear training', heading: 'Music > Intervals', words: ['interval', 'semitone', 'tritone', 'chord', 'seventh', 'dominant', 'voicing', 'fifth', 'listen', 'substitution'] },
  { topic: 'Terraform state', heading: 'Terraform > State', words: ['state', 'backend', 'lock', 'plan', 'apply', 'drift', 'module', 'variable', 'remote', 'workspace'] },
];

/** A pin whose text sits squarely inside one domain's vocabulary. */
const pinAt = (n: number): Pin => {
  const d = DOMAINS[n % DOMAINS.length]!;
  // Rotate the vocabulary so two pins in a domain are related but not identical.
  const words = d.words.map((w, i) => d.words[(i + n) % d.words.length] ?? w);
  return {
    id: `p-${String(n).padStart(3, '0')}`,
    type: n % 5 === 0 ? 'struggle' : 'interest',
    envelope: {
      selection: `${words.slice(0, 6).join(' ')} — ${words.slice(6).join(' ')}`,
      parts: [{ role: 'passage', text: words.join(' ') }],
      surroundingText: words.join(' '),
      headingPath: d.heading.split(' > '),
      pageTitle: `${d.topic} note ${n}`,
      url: `https://docs.example.test/${n}`,
      canonicalUrl: null,
      siteName: 'docs.example.test',
      contentLanguage: 'en',
      media: null,
    },
    note: null,
    capturedAt: `2026-0${(n % 4) + 4}-1${n % 10}T09:00:00Z`,
    fromSuggestion: false,
    enrichment: null,
    topicId: null,
  };
};

const board = (count: number): Pin[] => Array.from({ length: count }, (_, i) => pinAt(i));

/** Names every group it is asked about. Naming is not what this test is about. */
const namer = (): { llm: Llm; calls: number } => {
  const state = { calls: 0 };
  const llm: Llm = {
    complete: async () => { throw new Error('the clusterer does not use complete()'); },
    structured: async <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
      state.calls++;
      const keys = [...req.prompt.matchAll(/^(g\d+)/gm)].map((m) => m[1]!);
      return {
        value: { groups: keys.map((key) => ({ key, label: `Topic ${key}`, summary: `about ${key}` })) } as T,
        modelId: 'stub', inputTokens: 0, outputTokens: 0,
      };
    },
  };
  return { get calls() { return state.calls; }, llm };
};

const deps = (llm: Llm): ClustererDeps => ({ llm, embedder: new TfIdfEmbedder() });

const topicsFrom = (
  out: Awaited<ReturnType<typeof cluster>>,
): Topic[] => out.clusters.map((c, i) => ({
  id: c.existingTopicId ?? `t-${i}`,
  label: c.label,
  summary: c.summary,
  pinIds: c.pinIds,
  state: 'working',
  comfort: 0.5,
  lastExposedAt: null,
  retiredByUser: false,
  createdAt: '2026-08-01T00:00:00Z',
}));

// ------------------------------------------------------------------ the guarantee

test('SB-57: every one of two hundred pins lands in exactly one topic', async () => {
  const pins = board(200);
  const out = await cluster(deps(namer().llm), { pins, existingTopics: [] });

  const seen = out.clusters.flatMap((c) => c.pinIds);
  assert.equal(seen.length, 200, 'no pin is dropped and none is counted twice');
  assert.deepEqual([...new Set(seen)].sort(), pins.map((p) => p.id).sort());
  assert.deepEqual([...out.unassigned], [], 'nothing falls out of the board');
  assert.ok(out.clusters.length > 1, 'and it is a partition, not one bucket with everything in it');
  // Not a claim about accuracy on real prose — the vocabularies here are
  // separated on purpose. It is a claim that the rule still separates what it
  // can separate at 200, rather than collapsing to one topic or to 200 of them.
  assert.equal(out.clusters.length, DOMAINS.length);
  assert.deepEqual(out.clusters.map((c) => c.pinIds.length), [50, 50, 50, 50]);
});

test('SB-57: the same two hundred pins partition the same way twice', async () => {
  // The board must not reshuffle overnight. This is the property the whole
  // attach-only design exists to protect, and the one that would decay quietly.
  const pins = board(200);
  const first = await cluster(deps(namer().llm), { pins, existingTopics: [] });
  const second = await cluster(deps(namer().llm), { pins, existingTopics: [] });
  assert.deepEqual(
    first.clusters.map((c) => [...c.pinIds]),
    second.clusters.map((c) => [...c.pinIds]),
  );
});

test('SB-57: the order two hundred pins arrive in does not change where they land', async () => {
  const pins = board(200);
  const reversed = [...pins].reverse();
  const a = await cluster(deps(namer().llm), { pins, existingTopics: [] });
  const b = await cluster(deps(namer().llm), { pins: reversed, existingTopics: [] });
  assert.deepEqual(a.clusters.map((c) => [...c.pinIds]), b.clusters.map((c) => [...c.pinIds]));
});

test('SB-57: a settled board of two hundred is a no-op on the next night', async () => {
  const pins = board(200);
  const first = await cluster(deps(namer().llm), { pins, existingTopics: [] });
  const existingTopics = topicsFrom(first);
  const naming = namer();
  const again = await cluster(deps(naming.llm), { pins, existingTopics });

  assert.deepEqual(
    again.clusters.map((c) => [...c.pinIds]).sort(),
    first.clusters.map((c) => [...c.pinIds]).sort(),
  );
  assert.equal(naming.calls, 0, 'nothing was created, so the model is not asked to name anything');
  assert.ok(again.clusters.every((c) => c.existingTopicId !== null));
});

test('SB-57: twenty new pins on a board of two hundred move nothing that was already placed', async () => {
  // The scale risk the story names is the nightly; the risk a learner would
  // feel is their board rearranging itself the night they pin twenty more.
  const settled = board(200);
  const first = await cluster(deps(namer().llm), { pins: settled, existingTopics: [] });
  const existingTopics = topicsFrom(first);
  const placed = new Map(
    first.clusters.flatMap((c, i) => c.pinIds.map((id) => [id, c.existingTopicId ?? `t-${i}`] as const)),
  );

  const arrivals = Array.from({ length: 20 }, (_, i) => pinAt(200 + i));
  const after = await cluster(deps(namer().llm), { pins: [...settled, ...arrivals], existingTopics });

  for (const c of after.clusters) {
    const id = c.existingTopicId;
    for (const pinId of c.pinIds) {
      const was = placed.get(pinId);
      if (was) assert.equal(id, was, `${pinId} stayed where the learner last saw it`);
    }
  }
  const seen = after.clusters.flatMap((c) => c.pinIds);
  assert.equal(seen.length, 220);
});

test('SB-57: two hundred pins is one embedding call and one naming call', async () => {
  // The measured ceiling in the story is a per-call one — the Clusterer sends
  // every pin summary in a single prompt. This says out loud that the shape has
  // not changed: growth is inside one call, which is where the ceiling is, and
  // is not a call per pin, which would be a different and worse problem.
  let batches = 0;
  const embedder = new TfIdfEmbedder();
  const counting = {
    modelId: embedder.modelId,
    embed: async (texts: readonly string[]) => { batches++; return embedder.embed(texts); },
  };
  const naming = namer();
  await cluster({ llm: naming.llm, embedder: counting }, { pins: board(200), existingTopics: [] });
  assert.equal(batches, 1);
  assert.equal(naming.calls, 1);
});
