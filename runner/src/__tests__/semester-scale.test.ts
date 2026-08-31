import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_WORK_CAP, LlmRefused, fixedClock,
  type Deps, type Embedder, type Llm, type LlmRequest, type LlmResult, type Pin,
} from '@sb/core';
import { JsonStore } from '@sb/adapters';

import { runBatch, type StageReport } from '../pipeline.js';
import { courseCorpus } from '../seed/course-corpus.js';
import { createApp } from '../service.js';
import { ScriptedLlm, NOW, shapeOf, type Stage } from './batch-harness.js';

/**
 * THE SEMESTER, WORKED THROUGH OVER THREE NIGHTS.
 *
 * `batch-scale.test.ts` proved the run's growth law at 150 and 300 pins with the
 * cap deliberately switched off: what a night costs, and that a settled board is
 * a no-op. This is the other half, and it is the half the product actually
 * ships: **a hundred and twenty real course documents arrive in one gesture, and
 * the batch is allowed to work through only so much of them a night.**
 *
 * Four claims, and each one is a way the lane could be dishonest:
 *
 *  1. **it paces** — one night never takes more than the cap, whatever landed;
 *  2. **it resumes, idempotently** — night two starts where night one stopped
 *     and re-enriches nothing, so three nights cost exactly one pass;
 *  3. **topics are stable** — a document arriving on night three joins the topic
 *     its course already has rather than forking a near-duplicate;
 *  4. **an interrupted night leaves honest state** — a budget stop mid-run does
 *     not half-write anything, and the next run picks the remainder up.
 *
 * No model and no network. `ScriptedLlm` answers every schema deterministically,
 * which is what makes "night two and night three produced the same store"
 * a comparison rather than an impression.
 */

// ---------------------------------------------------------------- the bench

type SemesterStage = Stage | 'intake';

class SemesterLlm extends ScriptedLlm {
  readonly seen: { stage: SemesterStage | null; prompt: string }[] = [];
  /** Set to make every later call refuse, the way a spend limit does. */
  stopAfter: number | null = null;
  private inFlight = 0;

  /**
   * Wait until nothing is still being asked.
   *
   * The forage stage fans out, so a refusal rejects the run while three other
   * calls are still in the air — `mapLimit` has no way to recall them and does
   * not need one, because the gate that refused the first refuses every later
   * one before it is issued. That is correct in the product and a hazard in a
   * test: `assert.rejects` resolves the moment the run rejects, and lifting the
   * limit at that instant would let the calls that were still in flight through,
   * which is a state no learner can reach.
   */
  async quiet(): Promise<void> {
    while (this.inFlight > 0) await new Promise((resolve) => { setTimeout(resolve, 0); });
  }

  override async structured<T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> {
    this.inFlight += 1;
    try { return await this.answer<T>(req); } finally { this.inFlight -= 1; }
  }

  private async answer<T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> {
    const required = (req.schema as { required?: readonly string[] } | undefined)?.required ?? [];
    const intake = required.includes('objectives') && required.includes('commitments');
    this.seen.push({ stage: intake ? 'intake' : null, prompt: req.prompt });
    if (this.stopAfter !== null && this.seen.length > this.stopAfter) {
      // The exact shape `budgetedLlm` raises. A refusal is not a failure, and
      // `runBatch` ends the run on it rather than degrading ten stages in a row.
      throw new LlmRefused('the spend limit for this window is used up');
    }
    if (intake) {
      /**
       * One extra proposal per source, and it has to quote the source exactly.
       *
       * `enrichCourseIntake` refuses any proposal whose quote is not a literal
       * span of the source text, and recomputes the date from that span rather
       * than trusting the model. A stub that returned a plausible quote would be
       * silently discarded and this whole stage would read as "nothing-added" on
       * every document — a pass that proves nothing. So the quote is lifted out
       * of the prompt the agent actually built.
       */
      const line = /^- (Seminar presentation[^\n]*)$/m.exec(req.prompt)?.[1];
      const extra = /^- (Research essay[^\n]*)$/m.exec(req.prompt)?.[1];
      return {
        value: {
          objectives: [],
          commitments: extra
            ? [{ title: 'Research essay', kind: 'assignment', dueAt: null, quote: extra }]
            : [],
          questions: line
            ? [{ prompt: 'Which term does the seminar presentation belong to?', quote: line }]
            : [],
        } as T,
        modelId: 'stub', inputTokens: 0, outputTokens: 0,
      };
    }
    return super.structured<T>(req);
  }

  countIntake(): number { return this.seen.filter((c) => c.stage === 'intake').length; }
}

interface Bench {
  readonly store: JsonStore;
  /** The board's file. `JsonStore` keeps its own path private, and one test
   *  needs to re-read the board off disk and hand back a shuffled copy. */
  readonly path: string;
  readonly llm: SemesterLlm;
  readonly deps: Deps;
  readonly app: ReturnType<typeof createApp>;
}

function bench(tag: string, embedder?: Embedder): Bench {
  const path = join(mkdtempSync(join(tmpdir(), `sb-sem-${tag}-`)), 'db.json');
  const store = new JsonStore(path);
  const llm = new SemesterLlm();
  const deps: Deps = {
    llm: llm as Llm,
    embedder: embedder ?? courseEmbedder(),
    store,
    research: { fetchPage: async () => null, findReferences: async () => [], hasGrounding: false },
    clock: fixedClock(NOW),
  };
  return { store, path, llm, deps, app: createApp(deps, { workCap: null }) };
}

/**
 * One axis per course code, read out of the text being embedded.
 *
 * The drop puts the course title in the pin's heading path and the corpus puts
 * the course code in the first line of every document, so the code is genuinely
 * present in what the clusterer embeds — this is not a side table. Documents
 * from one course are identical vectors and documents from two are orthogonal,
 * which is either side of every cut point in the repo, so what the partition
 * does with a semester is decided by the partition rather than by noise.
 */
function courseEmbedder(): Embedder {
  const CODES = ['PSY201', 'MEC340', 'HIS118'];
  return {
    modelId: 'stub-space',
    embed: async (texts) => texts.map((t) => {
      const v = new Array(16).fill(0) as number[];
      const at = CODES.findIndex((code) => String(t).includes(code));
      v[at < 0 ? CODES.length : at] = 1;
      return v;
    }),
  };
}

/** Drop a corpus through the real endpoint, over the real app. */
async function drop(
  b: Bench, items: readonly unknown[], opts: { dropId?: string; title?: string } = {},
): Promise<any> {
  const res = await callApp(b.app, 'POST', '/course-drops', {
    title: opts.title ?? 'Autumn semester',
    ...(opts.dropId ? { dropId: opts.dropId } : {}),
    items,
  });
  assert.equal(res.status, 201, `the drop was refused: ${JSON.stringify(res.body).slice(0, 200)}`);
  return res.body;
}

/** The app as a function, without binding a port. */
async function callApp(
  app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown,
): Promise<{ status: number; body: any }> {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const stageOf = (reports: readonly StageReport[], name: string): StageReport =>
  reports.find((r) => r.stage === name) as StageReport;

const CAP = 40;
const RUN = { concurrency: 4, workCap: CAP } as const;

// ------------------------------------------------------------- the pacing

test('120 documents, three nights, and the cap holds on every one of them', async () => {
  const b = bench('pace');
  const corpus = courseCorpus({ documents: 120, courses: 3, unreadable: 6 });
  const receipt = await drop(b, corpus, { dropId: 'drop-autumn' });

  assert.equal(receipt.read, 114);
  assert.equal(receipt.failed, 6);
  assert.equal(receipt.queue.pins, 114, 'every readable document is owed enrichment');

  const nights: StageReport[][] = [];
  for (let night = 1; night <= 3; night += 1) {
    const { reports, remaining } = await runBatch(b.deps, RUN);
    nights.push([...reports]);
    const forage = stageOf(reports, 'forage');
    assert.ok(forage.work, `night ${night}: the forage stage reported no counts`);
    assert.ok(forage.work.worked <= CAP,
      `night ${night} took ${forage.work.worked}, and the cap is ${CAP}`);
    // The claim the receipts have to be able to make: what is left is stated,
    // and it is stated as a number a morning report can print.
    assert.equal(remaining, reports.reduce((n, r) => n + (r.work?.remaining ?? 0), 0));
  }

  const worked = nights.map((r) => stageOf(r, 'forage').work?.worked ?? 0);
  assert.deepEqual(worked, [40, 40, 34],
    'three nights at a cap of forty is forty, forty and the remainder');
  const left = nights.map((r) => stageOf(r, 'forage').work?.remaining ?? 0);
  assert.deepEqual(left, [74, 34, 0], 'and the remainder was true on each of them');

  // Nothing is owed at the end, which is the promise the arithmetic was making.
  assert.equal((await b.store.listPins({ unenrichedOnly: true })).length, 0);
});

test('the stage line says what it took and what it left, in words as well as numbers', async () => {
  const b = bench('pace-line');
  await drop(b, courseCorpus({ documents: 60, courses: 3 }));
  const { reports } = await runBatch(b.deps, RUN);

  const forage = stageOf(reports, 'forage');
  assert.match(forage.detail, /^40 pins/, 'the prose and the counts agree about what was taken');
  assert.match(forage.detail, /20 left for the next run \(capped at 40\)/);

  const intake = stageOf(reports, 'intake');
  assert.match(intake.detail, /course sources planned/);
  assert.match(intake.detail, /all still drafts/,
    'the one stage that reads deadlines says on every line that it wrote none of them');
});

test('a night that finishes the pile says nothing about pacing, because there is nothing to say', async () => {
  const b = bench('pace-quiet');
  await drop(b, courseCorpus({ documents: 12, courses: 3 }));
  const { reports, remaining } = await runBatch(b.deps, RUN);

  assert.equal(remaining, 0);
  const forage = stageOf(reports, 'forage');
  assert.equal(forage.work?.paced, false);
  assert.ok(!forage.detail.includes('left for the next run'),
    'a board nobody dropped a course on must never see the pacing at all');
});

// ------------------------------------------------------------ the resuming

test('three nights over one drop cost exactly one pass, and not one document twice', async () => {
  const b = bench('resume');
  await drop(b, courseCorpus({ documents: 120, courses: 3, unreadable: 6 }));

  // Every syllabus and every assignment brief is a plan, so the intake queue is
  // read from the store rather than counted by hand: what matters is that it is
  // worked through **once**, not what its size happens to be.
  const plans = (await b.store.listIntakeDrafts()).length;
  assert.ok(plans > 3, `${plans} planning drafts is not a queue`);

  for (let night = 1; night <= 3; night += 1) await runBatch(b.deps, RUN);

  assert.equal(b.llm.foragedPins(), 114,
    'a fourth of a document enriched twice would show up here as 115');
  assert.equal(b.llm.countIntake(), plans,
    'one intake call per planning draft, however many nights it took to make them');

  // And a fourth night, over a settled board, asks for nothing at all.
  const before = b.llm.calls.length + b.llm.seen.filter((c) => c.stage === 'intake').length;
  const { reports, remaining } = await runBatch(b.deps, RUN);
  assert.equal(remaining, 0);
  assert.equal(stageOf(reports, 'forage').detail, 'nothing new to enrich');
  assert.equal(stageOf(reports, 'intake').detail, 'nothing new to plan');
  const after = b.llm.calls.length + b.llm.seen.filter((c) => c.stage === 'intake').length;
  assert.ok(after > before, 'the run still happened');
  assert.equal(b.llm.foragedPins(), 114, 'and it re-enriched nothing');
  assert.equal(b.llm.countIntake(), plans, 'and re-planned nothing');
});

test('which forty a night takes is not decided by the order the store hands them back', async () => {
  /**
   * The property that makes "resume where you left off" mean something.
   *
   * The pacing slice has to be a function of the board, not of the store's
   * iteration order — the local store is a JSON array and returns insertion
   * order, Firestore promises no order at all, and a cap that took a different
   * forty depending on which one it was reading would make the remainder
   * unpredictable and a resumed night unfalsifiable.
   *
   * So: one board, and a second copy of the identical board with its pins
   * shuffled on disk. Same pins, same ids, same everything a stage can read;
   * only the order differs. Both are given one night, and the forty they take
   * have to be the same forty.
   */
  const a = bench('slice-a');
  await drop(a, courseCorpus({ documents: 90, courses: 3 }), { dropId: 'drop-x' });

  // The same board, shuffled. Deterministically shuffled, because a random one
  // would make a failure impossible to reproduce.
  const raw = JSON.parse(readFileSync(a.path, 'utf8')) as { pins: unknown[] };
  const pins = [...raw.pins];
  for (let i = pins.length - 1; i > 0; i -= 1) {
    const j = (i * 7 + 3) % (i + 1);
    [pins[i], pins[j]] = [pins[j] as unknown, pins[i] as unknown];
  }
  const shuffledPath = join(mkdtempSync(join(tmpdir(), 'sb-sem-slice-b-')), 'db.json');
  writeFileSync(shuffledPath, JSON.stringify({ ...raw, pins }));
  const shuffled = new JsonStore(shuffledPath);
  assert.notDeepEqual(
    (await shuffled.listPins()).map((p) => p.id),
    (await a.store.listPins()).map((p) => p.id),
    'the shuffle did nothing, so this test would pass for the wrong reason');

  const b = bench('slice-b');
  const withShuffled: Deps = { ...b.deps, store: shuffled };
  await runBatch(a.deps, RUN);
  await runBatch(withShuffled, RUN);

  const enriched = async (store: JsonStore): Promise<string[]> =>
    (await store.listPins())
      .filter((p) => p.enrichment !== null)
      .map((p) => p.clientRef as string)
      .sort();

  const first = await enriched(a.store);
  assert.equal(first.length, CAP);
  assert.deepEqual(await enriched(shuffled), first,
    'the same board in a different order paced to a different forty');
});

// ---------------------------------------------------------- topic stability

test('a document arriving on night three joins its course, it does not fork a new topic', async () => {
  /**
   * The property the whole partition design exists for, at semester scale.
   *
   * Comfort and signal history attach to topic ids, so a course that forks a
   * near-duplicate topic every time a lecture is added is a course whose history
   * is scattered across nine topics by December. `batch-scale.test.ts` asserts
   * this for round-robin synthetic pins; this asserts it for documents that
   * arrive as three separate drops over three nights, through the real endpoint.
   */
  const b = bench('stability');
  const all = courseCorpus({ documents: 90, courses: 3 });
  const thirds = [all.slice(0, 30), all.slice(30, 60), all.slice(60)];

  await drop(b, thirds[0] as unknown[], { dropId: 'drop-1' });
  await runBatch(b.deps, { ...RUN, workCap: null });
  const first = new Map((await b.store.listTopics()).map((t) => [t.label, t.id]));
  assert.equal(first.size, 3, 'three courses, three topics');
  const membership = new Map((await b.store.listPins()).map((p) => [p.id, p.topicId]));

  for (const [index, part] of [thirds[1], thirds[2]].entries()) {
    await drop(b, part as unknown[], { dropId: `drop-${index + 2}` });
    await runBatch(b.deps, { ...RUN, workCap: null });
    assert.equal((await b.store.listTopics()).length, 3,
      `after drop ${index + 2} the semester had forked into more topics than it has courses`);
  }

  // And not one of the pins that already had a topic moved.
  for (const pin of await b.store.listPins()) {
    const was = membership.get(pin.id);
    if (was === undefined) continue;
    assert.equal(pin.topicId, was, `${pin.id} changed topic on a later night`);
  }

  const shape = await shapeOf(b.store);
  assert.deepEqual(shape.orphanPins, []);
  assert.deepEqual(shape.danglingTopicPins, []);
  assert.equal(shape.topics.reduce((n, t) => n + t.pins, 0), 90,
    'the three topics partition the semester exactly');
});

test('the naming pass is chunked, so a semester of new topics is never one enormous call', async () => {
  const singletons: Embedder = {
    modelId: 'stub-space',
    embed: async (texts) => texts.map((t) => {
      const v = new Array(256).fill(0) as number[];
      let h = 0;
      for (const ch of String(t)) h = (h * 31 + ch.charCodeAt(0)) % 256;
      v[h] = 1;
      return v;
    }),
  };
  const b = bench('naming', singletons);
  await drop(b, courseCorpus({ documents: 40, courses: 3 }));
  const { topics } = await runBatch(b.deps, { ...RUN, workCap: null });

  assert.ok(topics.length >= 30, `${topics.length} topics is not the fan-out this is about`);
  const calls = b.llm.calls.filter((c) => c.stage === 'cluster');
  assert.ok(calls.length > 1, 'the naming pass was not chunked at all');
  for (const call of calls) {
    const groups = (call.prompt.match(/^group g\d+:$/gm) ?? []).length;
    assert.ok(groups <= 12, `one call asked about ${groups} groups`);
  }
  // Every group key is offered exactly once across the whole run, which is the
  // thing chunking most easily breaks: a chunk that renumbered from zero would
  // offer `g0` three times and write three topics' names into one slot.
  const offered = calls.flatMap((c) => (c.prompt.match(/^group (g\d+):$/gm) ?? []));
  assert.equal(new Set(offered).size, offered.length, 'a group key was offered by two calls');
  assert.equal(topics.filter((t) => t.provisionalName).length, 0,
    'every new topic was named, across however many calls it took');
});

// ------------------------------------------------------------- the stopping

test('a spend limit reached mid-semester leaves state the next night can read', async () => {
  /**
   * The interruption that actually happens, and the one a paced queue has to
   * survive: the learner's limit is met partway through the first night of a
   * semester. `runBatch` ends the run on a refusal rather than degrading every
   * remaining stage, so what has to be true afterwards is not that the night
   * finished — it did not — but that **nothing was left half-written and nothing
   * was lost**.
   */
  const b = bench('stop');
  await drop(b, courseCorpus({ documents: 60, courses: 3 }));
  const owedBefore = (await b.store.listPins({ unenrichedOnly: true })).length;
  assert.equal(owedBefore, 60);

  // The planning queue is worked first, then the forage stage begins. Stopping
  // eight calls into the per-pin block is the case with the most half-written
  // state available to it — counted off the queue rather than guessed, because a
  // stop that landed inside `intake` would prove a different thing quietly.
  const plans = (await b.store.listIntakeDrafts()).length;
  b.llm.stopAfter = plans + 8;
  /**
   * One at a time, and that is the assertion rather than a convenience.
   *
   * The forage stage fans out, so at ordinary concurrency a refusal rejects the
   * run while three more calls are still in the air. In the product that is
   * harmless — the gate that refused the first refuses every later one before it
   * is issued, so nothing is spent — but it makes *"what had been written when
   * it stopped"* a race rather than a fact, and this test is about exactly that
   * state. Serial forage makes the boundary exact.
   */
  await assert.rejects(
    () => runBatch(b.deps, { ...RUN, concurrency: 1 }),
    (err: unknown) => err instanceof LlmRefused);
  await b.llm.quiet();

  const enriched = (await b.store.listPins()).filter((p) => p.enrichment !== null);
  assert.ok(enriched.length > 0, 'the work done before the stop was thrown away');
  assert.ok(enriched.length < 60, 'the stop did not stop anything');
  const stillOwed = (await b.store.listPins({ unenrichedOnly: true })).length;
  assert.equal(stillOwed, 60 - enriched.length,
    'every pin is either enriched or owed an attempt, and none is both or neither');

  // No topic was written from a partial partition, and no session was persisted
  // from a run that never reached the Composer.
  assert.deepEqual(await b.store.listTopics(), []);
  assert.equal(await b.store.latestSession(), null);

  // The next night, with the limit lifted, picks up exactly the remainder.
  b.llm.stopAfter = null;
  const { reports } = await runBatch(b.deps, { ...RUN, concurrency: 1 });
  const forage = stageOf(reports, 'forage');
  assert.equal(forage.work?.waiting, stillOwed, 'the second night saw the remainder and nothing else');
  assert.equal(b.llm.foragedPins(), enriched.length + (forage.work?.worked ?? 0),
    'not one pin the first night finished was asked about again');
});

test('a drop of three hundred is accepted, and the run still costs one night’s worth', async () => {
  // The top of the stated range, end to end, through the endpoint and the run.
  const b = bench('three-hundred');
  const corpus = courseCorpus({ documents: 300, courses: 3, unreadable: 12 });
  const receipt = await drop(b, corpus, { dropId: 'drop-big' });
  assert.equal(receipt.items.length, 300);
  assert.equal(receipt.read, 288);

  const { reports } = await runBatch(b.deps, { ...RUN, workCap: DEFAULT_WORK_CAP });
  const forage = stageOf(reports, 'forage');
  assert.equal(forage.work?.worked, DEFAULT_WORK_CAP);
  assert.equal(forage.work?.remaining, 288 - DEFAULT_WORK_CAP);

  // Clustering is deliberately NOT paced: a partition is a statement about the
  // whole board, and a capped one would fork topics permanently rather than
  // defer work. So every document is filed on the first night even though only
  // fifty of them have been enriched.
  const cluster = stageOf(reports, 'cluster');
  assert.equal(cluster.work?.waiting, 288);
  assert.equal(cluster.work?.remaining, 0);
  assert.equal(cluster.work?.paced, false);
  assert.equal((await b.store.listPins()).filter((p: Pin) => p.topicId === null).length, 0,
    'a document nobody has enriched yet still belongs to a topic');
});

// ------------------------------------------------------- the plans it makes

test('the deadlines a semester contains arrive as drafts, with the source’s own words', async () => {
  const b = bench('plans');
  await drop(b, courseCorpus({ documents: 60, courses: 3 }));

  // Before the run: the deterministic pass has already read the assessment
  // tables, because parsing costs nothing and a person can act on it at once.
  const early = await b.store.listIntakeDrafts();
  const briefs = courseCorpus({ documents: 60, courses: 3 })
    .filter((d) => d.kind === 'syllabus' || d.kind === 'assignment-brief').length;
  assert.equal(early.length, briefs, 'one draft per syllabus and per assignment brief, and no others');
  assert.ok(early.length > 3, 'a corpus with only three plans in it would not exercise the queue');
  assert.ok(early.every((d) => d.enrichment === undefined), 'and none of them has been to a model');

  const { reports } = await runBatch(b.deps, RUN);
  const intake = stageOf(reports, 'intake');
  assert.equal(intake.work?.waiting, early.length);
  assert.equal(intake.work?.worked, early.length, 'twenty-two is under the cap, so one night did them all');

  const psy = (await b.store.listIntakeDrafts())
    .find((d) => d.title.includes('Cognitive Psychology'));
  assert.ok(psy);
  assert.equal(psy.status, 'draft', 'the stage that reads deadlines applies none of them');
  assert.ok(psy.enrichment, 'and it recorded that it had looked');
  assert.equal(psy.enrichment.outcome, 'enriched');

  for (const c of psy.commitments) {
    assert.ok(c.source.quote.length > 0, `${c.title} was proposed with nothing quoted for it`);
    assert.ok(psy.source.text.includes(c.source.quote),
      `${c.title} quoted something the source does not say`);
  }
  // Ambiguity is a question, not a guess. Both halves are asserted: the question
  // exists, and it blocks.
  const open = psy.questions.filter((q) => q.blocking && q.resolvedAt === null);
  assert.ok(open.length > 0);
  assert.deepEqual(await b.store.listCommitments(), [],
    'nothing the batch proposed reached the plan without somebody applying it');
});

test('an intake draft edited while the night is running is left exactly as the learner left it', async () => {
  /**
   * The window a model call opens, and the one this stage refuses to write
   * through. The call is the longest await in the run and the thing on the other
   * side of it is a document somebody may be sitting in front of, correcting a
   * date. `putIntakeDraft` is an upsert, so writing the enriched copy over an
   * edited one silently undoes the correction.
   */
  const b = bench('race');
  await drop(b, courseCorpus({ documents: 9, courses: 3 }));
  const draft = (await b.store.listIntakeDrafts())[0];
  assert.ok(draft);

  // Land the edit inside the stage, at the only point it reliably yields.
  let edited = false;
  const inner = b.llm.structured.bind(b.llm);
  (b.llm as any).structured = async (req: LlmRequest & { schema: unknown }) => {
    const result = await inner(req);
    if (!edited && req.prompt.includes(draft.source.text.slice(0, 40))) {
      edited = true;
      const now = await b.store.getIntakeDraft(draft.id);
      if (now) await b.store.putIntakeDraft({ ...now, title: 'A name the learner typed' });
    }
    return result;
  };

  const { reports } = await runBatch(b.deps, RUN);
  assert.ok(edited, 'the edit never landed, so this proved nothing');

  const after = await b.store.getIntakeDraft(draft.id);
  assert.equal(after?.title, 'A name the learner typed', 'the correction was overwritten');
  assert.equal(after?.enrichment, undefined,
    'and the document is still owed a look, rather than marked done against a copy nobody has');
  assert.match(stageOf(reports, 'intake').detail, /edited mid-stage and left alone/);
});
