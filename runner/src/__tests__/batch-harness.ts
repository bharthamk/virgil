import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fixedClock,
  type Deps, type Embedder, type Llm, type LlmRequest, type LlmResult,
  type Pin, type Research, type Signal, type Topic,
} from '@sb/core';
import { JsonStore } from '@sb/adapters';

/**
 * A whole nightly RUN, on a board this file builds and a model this file
 * answers for.
 *
 * The stage tests each hold one stage still and let every other stage degrade —
 * which is the right shape for asking what a stage line says, and the wrong
 * shape for asking what the run leaves behind. A run that recovers, or repeats,
 * or survives a pin arriving while it is mid-flight, is only observable when
 * every stage actually completes and the store is read afterwards.
 *
 * So the model here answers all seven schemas rather than one, and answers them
 * as a pure function of the prompt: two runs over the same board must produce
 * byte-identical model output, or nothing downstream of it can be compared.
 * There is no network, no randomness inside the stub, and no wall clock.
 */

export const NOW = '2026-08-19T03:00:00.000Z';

// -------------------------------------------------------------------- board

/**
 * Pins carry their group in the page title, which is the first line of
 * `pinClusterText` — so the embedder below can read the partition the test
 * asked for straight out of the text the clusterer actually embeds, with no
 * side table to keep in step.
 */
export function makePin(id: string, group: string, over: Partial<Pin> = {}): Pin {
  return {
    id,
    type: 'interest',
    envelope: {
      selection: `the passage ${id} saved from set ${group}`,
      parts: [],
      surroundingText: `ordinary prose around ${id}`,
      headingPath: ['Docs', group],
      pageTitle: `page ${id} set ${group}`,
      url: `https://example.test/${group}/${id}`,
      canonicalUrl: null,
      siteName: null,
      contentLanguage: 'en',
      media: null,
      ...(over.envelope ?? {}),
    },
    note: null,
    capturedAt: '2026-08-01T00:00:00Z',
    fromSuggestion: false,
    enrichment: null,
    topicId: null,
    ...over,
  };
}

/**
 * A board of `count` pins spread over `groups` groups, round-robin.
 *
 * Round-robin rather than contiguous on purpose: it interleaves the ids so a
 * partition that accidentally depends on insertion order shows up as a
 * different answer rather than the same one.
 */
export function generateBoard(count: number, groups: number): Pin[] {
  const width = String(count).length;
  return Array.from({ length: count }, (_, i) =>
    makePin(`p${String(i).padStart(width, '0')}`, `k${i % Math.max(1, groups)}`));
}

export function storeAt(tag: string): JsonStore {
  return new JsonStore(join(mkdtempSync(join(tmpdir(), `sb-nightly-${tag}-`)), 'db.json'));
}

// ----------------------------------------------------------------- embedder

const GROUP_RE = /set (k\d+)/;

/**
 * One orthogonal axis per group, read out of the embedded text.
 *
 * Pins in a group are identical vectors, so average-linkage cosine inside a
 * group is 1 and between groups is 0 — comfortably either side of every cut
 * point in the repo. The dimension count is fixed so the vectors stay
 * comparable however many groups a given board happens to use.
 */
export function groupEmbedder(modelId = 'stub-space', dims = 64): Embedder {
  return {
    modelId,
    embed: async (texts) => texts.map((t) => {
      const g = GROUP_RE.exec(String(t))?.[1];
      const v = new Array(dims).fill(0) as number[];
      // No group marker at all still has to embed to something: an unmarked pin
      // is the "everything looks alike" board, not a crash.
      const axis = g ? Number(g.slice(1)) % dims : 0;
      v[axis] = 1;
      return v;
    }),
  };
}

/** Every pin its own axis — the all-singletons board. */
export function identityEmbedder(dims = 512): Embedder {
  return {
    modelId: 'stub-space',
    embed: async (texts) => texts.map((t) => {
      const v = new Array(dims).fill(0) as number[];
      let h = 0;
      for (const ch of String(t)) h = (h * 31 + ch.charCodeAt(0)) % dims;
      v[h] = 1;
      return v;
    }),
  };
}

// ---------------------------------------------------------------------- llm

/** The stages a schema can belong to, named the way the pipeline names them. */
export type Stage = 'forage' | 'cluster' | 'survey' | 'analyse' | 'statements'
  | 'modality' | 'prospect' | 'compose' | 'verify';

export function stageOf(req: LlmRequest & { schema?: unknown }): Stage | null {
  const required = (req.schema as { required?: readonly string[] } | undefined)?.required ?? [];
  // Both shapes the Forager asks in: one pin, or a chunk of them. The batch
  // schema names `enrichments` and the single one names `assumedConcepts`, and
  // a harness that knew only the second answered the first with a later
  // stage's stub — which is a whole-suite failure that looks like a pipeline
  // bug and is not.
  if (required.includes('assumedConcepts') || required.includes('enrichments')) return 'forage';
  if (required.includes('names')) return 'cluster';
  if (required.includes('edges')) return 'survey';
  if (required.includes('observations')) return 'analyse';
  if (required.includes('statements')) return 'statements';
  //  classification. Inside the statements stage in the pipeline, but
  // its own key here: it is a separate call with a separate schema, and a
  // harness that folded it into `statements` could not count either of them.
  if (required.includes('topics')) return 'modality';
  // Both of the night scout's calls. They are one stage and are answered as
  // one: a harness that knew only the first would answer the second with a
  // later stage's stub, which is the failure the Forager's two shapes caused.
  if (required.includes('proposals') || required.includes('leads')) return 'prospect';
  if (required.includes('sections')) return 'compose';
  if (required.includes('defects')) return 'verify';
  return null;
}

export interface ScriptOpts {
  /** Stages whose every model call throws. The pipeline must degrade, not die. */
  readonly fail?: readonly Stage[];
  /** Per-stage answer override; return undefined to fall through to the default. */
  readonly answer?: (stage: Stage | null, req: LlmRequest) => unknown;
  /**
   * Awaited before the stage is answered. This is the seam a test uses to land
   * a real store mutation INSIDE a run — the model call is the only point at
   * which a stage reliably yields, so it is the only place an interleaving can
   * be scheduled without a wall clock.
   */
  readonly before?: (stage: Stage | null, req: LlmRequest) => Promise<void> | void;
}

/** Which topic ids the compose brief put in front of the model, in order. */
const topicIdsIn = (prompt: string): string[] =>
  [...prompt.matchAll(/^TOPIC (\S+): /gm)].map((m) => m[1] as string);

/** The group keys the naming brief asked about — one `group gN:` line each. */
const groupIdsIn = (prompt: string): string[] =>
  [...prompt.matchAll(/^group (g\d+):$/gm)].map((m) => m[1] as string);

/**
 * A model that answers every stage, deterministically, from the prompt alone.
 *
 * Deterministic is the load-bearing word. Idempotence, recovery and scale are
 * all claims about two runs producing the same store, and a stub that varied —
 * even in section order — would make every one of them unfalsifiable.
 */
export class ScriptedLlm implements Llm {
  readonly calls: { stage: Stage | null; prompt: string }[] = [];
  constructor(private readonly opts: ScriptOpts = {}) {}

  countOf(stage: Stage): number { return this.calls.filter((c) => c.stage === stage).length; }

  /**
   * How many PINS the forage stage asked about, across however many calls it
   * took to ask. Counting calls stopped meaning "pins" the day the Forager
   * started batching, and the claim worth holding — a settled pin is never
   * re-asked — is about pins.
   */
  foragedPins(): number {
    return this.calls
      .filter((c) => c.stage === 'forage')
      .reduce((n, c) => n + Math.max(1, (c.prompt.match(/^pin p\d+:/gm) ?? []).length), 0);
  }

  async complete(): Promise<LlmResult<string>> {
    throw new Error('no free-text completion is used by the nightly run');
  }

  async structured<T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> {
    const stage = stageOf(req);
    this.calls.push({ stage, prompt: req.prompt });
    await this.opts.before?.(stage, req);
    if (stage && this.opts.fail?.includes(stage)) {
      throw new Error(`injected failure in ${stage}`);
    }
    const override = this.opts.answer?.(stage, req);
    const value = (override ?? ScriptedLlm.byStage(stage, req.prompt)) as T;
    return { value, modelId: 'stub', inputTokens: 0, outputTokens: 0 };
  }

  private static byStage(stage: Stage | null, prompt: string): unknown {
    switch (stage) {
      case 'forage': {
        // Answered per key when asked as a chunk, so the read-back in
        // `forageBatch` is exercised rather than bypassed. The keys come out of
        // the prompt the agent actually built.
        const keys = [...prompt.matchAll(/^pin (p\d+):/gm)].map((m) => String(m[1]));
        if (keys.length) {
          return { enrichments: keys.map((k) => ({ pin: k, assumedConcepts: ['the ack deadline'], mediaDescription: null })) };
        }
        return { assumedConcepts: ['the ack deadline'], mediaDescription: null };
      }
      case 'cluster':
        return {
          names: groupIdsIn(prompt).map((g) => ({
            group: g, label: `Topic ${g}`, summary: `What ${g} is about.`,
          })),
        };
      // No edges: the prerequisite graph is not what any of these tests are
      // about, and an empty graph is a real answer the Surveyor gives.
      case 'survey': return { edges: [] };
      case 'analyse': {
        // One observation, citing the first pin the brief listed. The Registrar
        // will not write a statement without either evidence or an observation,
        // so a run that produced neither would leave the statement stage with
        // nothing to be idempotent about.
        const first = /^(\S+) \| \d{4}-/m.exec(prompt)?.[1];
        return first
          ? {
            observations: [{
              claim: 'You reach for the mechanism before the definition.',
              evidencePinIds: [first],
              implication: 'Lead with the mechanism.',
              mediumMismatch: false,
              confidence: 0.8,
            }],
          }
          : { observations: [] };
      }
      case 'statements': return { statements: ['You reach for the mechanism before the definition.'] };
      /**
       * Every topic sorted into the same kind, which is the honest default.
       *
       * One kind can never produce a contrast, so the stub drives the whole
       * call, the read-back and the vocabulary gate while leaving no modality
       * question on any board in the suite. `modality-stage.test.ts` scripts
       * the two-kind answers it needs.
       */
      case 'modality': return {
        topics: [...prompt.matchAll(/^(k\d+): /gm)]
          .map((m) => ({ topic: String(m[1]), kind: 'logic-structure' })),
      };
      /**
       * Nothing proposed, which is a real answer and the right default here.
       *
       * These tests are about what a night leaves behind, and a stub that
       * proposed something would put a record on every board in the suite that
       * only one test is about. `prospect-stage.test.ts` scripts the answers it
       * needs; everything else gets the honest empty list, which still drives
       * the whole stage, the admission and the store read.
       */
      case 'prospect': return prompt.includes('Proposals:') ? { leads: [] } : { proposals: [] };
      case 'compose': {
        const ids = topicIdsIn(prompt);
        return {
          sections: ids.map((id) => ({
            topicId: id,
            heading: `Section for ${id}`,
            body: `A paragraph teaching ${id}, long enough to estimate a duration from. `.repeat(6),
            estimatedMinutes: 5,
            question: null,
            sourceIds: [],
            mediumWarning: null,
            // The register-consistency contract’s two registers, required by the composer schema
            // since the show-don't-tell wave. Only the real adapter validates
            // (structured-ladder), so their absence passed every in-process
            // test and killed the containerised night in deploy/smoke.sh.
            recap: `Covered ${id}.`,
            summary: `Teaches ${id}.`,
          })),
          closingNote: 'one thing moved; one thing still open',
        };
      }
      case 'verify': return { defects: [] };
      default: return {};
    }
  }
}

// --------------------------------------------------------------------- deps

const noResearch: Research = {
  fetchPage: async () => null,
  findReferences: async () => [],
  hasGrounding: false,
};

export interface Bench {
  readonly store: JsonStore;
  readonly llm: ScriptedLlm;
  readonly deps: Deps;
}

export async function bench(
  tag: string,
  pins: readonly Pin[],
  opts: ScriptOpts & { embedder?: Embedder; store?: JsonStore } = {},
): Promise<Bench> {
  const store = opts.store ?? storeAt(tag);
  for (const p of pins) await store.putPin(p);
  const llm = new ScriptedLlm(opts);
  return {
    store,
    llm,
    deps: {
      llm,
      embedder: opts.embedder ?? groupEmbedder(),
      store,
      research: noResearch,
      clock: fixedClock(NOW),
    },
  };
}

// ------------------------------------------------------------ store faults

/**
 * The store, with a fault injected at a chosen call.
 *
 * A model that stops answering is only half of what a Cloud Run Job survives.
 * The other half is the write itself failing part-way — the container is
 * evicted between two `putTopic` calls, and what is on disk is neither the old
 * board nor the new one. That state cannot be reached by failing a model call,
 * so it is reached here instead, and the question the next run has to answer is
 * whether it repairs it or inherits it.
 *
 * Reads are never faulted by accident: only the method named is affected, and
 * the fault fires on the nth call to it and every call after, the way a dead
 * backend behaves rather than the way a flaky one does.
 */
export function faultyStore(
  inner: JsonStore,
  fault: { method: keyof JsonStore & string; after: number },
): JsonStore {
  let seen = 0;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== fault.method || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        if (seen++ >= fault.after) throw new Error(`store fault: ${String(prop)} is unavailable`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as JsonStore;
}

// ------------------------------------------------------------------ reading

/**
 * Everything a second run could duplicate, in a form two runs can be compared
 * on directly.
 *
 * Topic ids are UUIDs minted by the run, so they are replaced by a stable key
 * built from the membership — otherwise every comparison would fail on the id
 * alone and say nothing about whether the board actually moved.
 */
export interface Shape {
  readonly pins: number;
  readonly topics: readonly { key: string; label: string; state: string; comfort: number; pins: number }[];
  readonly edges: number;
  readonly signals: number;
  readonly statements: readonly string[];
  readonly sessions: number;
  readonly orphanPins: readonly string[];
  readonly danglingTopicPins: readonly string[];
}

export async function shapeOf(store: JsonStore): Promise<Shape> {
  const pins = await store.listPins();
  const topics = await store.listTopics();
  const pinIds = new Set(pins.map((p) => p.id));
  const topicIds = new Set(topics.map((t) => t.id));

  const key = (t: Topic): string => [...t.pinIds].sort().join('+');
  return {
    pins: pins.length,
    topics: topics
      .map((t) => ({ key: key(t), label: t.label, state: String(t.state), comfort: t.comfort, pins: t.pinIds.length }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    edges: (await store.listEdges()).length,
    signals: (await store.listSignals()).length,
    statements: (await store.listStatements()).map((s) => s.text).sort(),
    sessions: await sessionCount(store),
    // A pin whose topic is not on the board. This is the shape a half-written
    // cluster stage leaves behind, and it is invisible from the topic side.
    orphanPins: pins.filter((p) => p.topicId !== null && !topicIds.has(p.topicId)).map((p) => p.id).sort(),
    // A topic claiming a pin that is not in the store.
    danglingTopicPins: topics.flatMap((t) => t.pinIds.filter((p) => !pinIds.has(p))).sort(),
  };
}

/** `Store` has no list-sessions read; the file is the only place they all are. */
export async function sessionCount(store: JsonStore): Promise<number> {
  const raw = (store as unknown as { db: { sessions?: unknown[] } }).db;
  return raw.sessions?.length ?? 0;
}

export const sig = (id: string, topicId: string, direction: Signal['direction']): Signal => ({
  id,
  topicId,
  type: direction === 'positive' ? 'answer-correct' : 'answer-wrong',
  direction,
  at: '2026-08-18T00:00:00Z',
  sourceEvent: `answer:sess:${id}`,
  invalidated: false,
});
