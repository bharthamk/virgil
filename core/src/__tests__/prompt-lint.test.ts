import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Llm, LlmRequest, LlmResult } from '../ports/llm.js';
import { fixedClock } from '../ports/clock.js';
import type { Deps, PureDeps } from '../agents/deps.js';
import type { CaptureEnvelope, Pin, Topic } from '../domain/types.js';
import { PINNED_TAG, UNTRUSTED_PAGES_RULE, UNTRUSTED_RULE } from '../agents/untrusted.js';
import { DASH_RULE, hasBannedDash, PROSE_STYLE, SHORT_REPLY_STYLE } from '../agents/house-style.js';
import { scout } from '../agents/scout.js';
import { forage } from '../agents/forager.js';
import { cluster } from '../agents/clusterer.js';
import { analyse } from '../agents/analyst.js';
import { survey } from '../agents/surveyor.js';
import { classifyDemandKinds, renderStatements, type ComfortResult } from '../agents/registrar.js';
import { MODALITY_KINDS, type ModalityTopicTally } from '../domain/modality.js';
import { compose } from '../agents/composer.js';
import { verify } from '../agents/verifier.js';
import {
  markAnswer, rewriteAtDepth, answerTangent, handleCorrection, quickTake,
  guideSteps, explainStep, askAboutPin, markRecallAnswer,
} from '../agents/tutor.js';
import { review } from '../agents/reviewer.js';
import { markAssignment } from '../agents/marker.js';
import { transcribePages } from '../agents/transcriber.js';
import { enrichCourseIntake } from '../agents/intake-planner.js';
import { prospect } from '../agents/prospector.js';
import { PROSPECT_MAX_PROPOSALS, type ProspectEvidence } from '../domain/prospect.js';
import { buildDeterministicIntake } from '../domain/intake.js';
import type { GardenDecision } from '../agents/gardener.js';
import type { Observation } from '../agents/analyst.js';

/**
 * PROMPT LINT — deterministic assertions over every prompt the fleet ships.
 *
 * The prompts are the product. They are also the only part of it that no
 * compiler reads: a system prompt is a string, a schema is an object literal,
 * and both can drift away from the code that consumes them without anything
 * going red. Three of the defects already in `AGENT_EVAL_LOG.md` are that
 * shape — an exact-match filter that discarded every defect the Verifier
 * found, source ids the panel could not resolve, a statement cap the model
 * ignored — and each was found by a human reading output, once, late.
 *
 * So this file renders every prompt the fleet builds, from a board deliberately
 * larger than any real one, and asserts the things a reader would otherwise
 * have to check by eye:
 *
 *   1. every place pinned or re-fetched text is interpolated sits inside the
 *      data fence, and any prompt that carries a fence also carries the rule
 *      saying what the fence means;
 *   2. nothing reaches the model uninterpolated — no `${`, no `[object
 *      Object]`, no bare `undefined` where a value was meant to be;
 *   3. every prompt fits the budget it is supposed to fit, measured under a
 *      maximum-size board rather than assumed from a typical one;
 *   4. every structured-output schema is one the parser in `adapters/` can
 *      actually enforce, and the vocabulary the prompt asks for is the
 *      vocabulary the code accepts;
 *   5. a length or count stated in a prompt is the length or count the code
 *      enforces downstream;
 *   6. no prompt names an agent, a vendor, or a capability that does not exist.
 *
 * **Table-driven on purpose.** `AGENTS` below is the registry, and the last
 * test in the file walks `core/src/agents/` and fails if a module that calls
 * the model is missing from it. A tenth agent is linted the day it is written,
 * without anyone remembering to come back here.
 *
 * This file asserts the SHAPE of the prompts. It deliberately does not judge
 * their wording — several behaviours here are frontier-proven and fragile (the
 * Surveyor's refuse-to-guess framing, the Composer's register discipline, the
 * Verifier's withhold-don't-patch rule) and a test is the wrong instrument for
 * a question only an evaluation run can answer.
 */

// ------------------------------------------------------------ the recorder

interface Recorded {
  readonly req: LlmRequest;
  readonly rendered: string;
  /** `structured()` rather than `complete()`. Every agent in the fleet asked
   *  for JSON until the Transcriber, whose one field is a document and would
   *  gain an escaping problem and a truncation risk by being wrapped in one. */
  readonly structured: boolean;
}

/**
 * A model that answers every call with a value synthesised from the schema it
 * was handed, and keeps the request.
 *
 * Schema-shaped rather than hand-written per agent: an agent added tomorrow
 * gets a usable reply without anyone writing one, and a reply built from the
 * schema is by construction the reply the schema promises. What the agent then
 * does with it is not this file's question — the request was already recorded
 * before the reply was read.
 */
function recorder(): { llm: Llm; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const take = (req: LlmRequest, structured: boolean): void => {
    calls.push({ req, rendered: req.prompt, structured });
  };
  return {
    calls,
    llm: {
      complete: async (req) => {
        take(req, false);
        return { value: '', modelId: 'lint', inputTokens: 0, outputTokens: 0 };
      },
      structured: async <T,>(req: LlmRequest): Promise<LlmResult<T>> => {
        take(req, true);
        return { value: fromSchema(req.schema) as T, modelId: 'lint', inputTokens: 0, outputTokens: 0 };
      },
    },
  };
}

interface SchemaNode {
  type?: string | readonly string[];
  properties?: Record<string, SchemaNode>;
  required?: readonly string[];
  items?: SchemaNode;
  enum?: readonly unknown[];
  additionalProperties?: boolean | SchemaNode;
}

/** A minimal value conforming to `schema`. Unions take their first non-null arm. */
function fromSchema(schema: unknown): unknown {
  const node = schema as SchemaNode | undefined;
  if (!node || typeof node !== 'object') return null;
  if (node.enum?.length) return node.enum[0];
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  const type = types.find((t) => t !== 'null') ?? 'null';
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, sub] of Object.entries(node.properties ?? {})) out[key] = fromSchema(sub);
      return out;
    }
    case 'array':
      return node.items ? [fromSchema(node.items)] : [];
    case 'string':
      return 'lint';
    case 'number':
    case 'integer':
      return 0.9;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

// ------------------------------------------------------------ the fixtures

/**
 * Markers planted in every field that carries text the product did not write.
 *
 * Each one is looked for by POSITION in the rendered prompt: a marker outside
 * the fence is a place where a page's own words reach the model as though the
 * product had said them. Deliberately alphanumeric — `fencePinned` bends any
 * attempt to write the delimiter, and a marker containing `<` would be testing
 * the escape rather than the placement.
 */
const MARK = {
  selection: 'ZLINTSELECTION',
  surrounding: 'ZLINTSURROUNDING',
  heading: 'ZLINTHEADING',
  title: 'ZLINTPAGETITLE',
  note: 'ZLINTLEARNERNOTE',
  part: 'ZLINTCAPTUREPART',
  label: 'ZLINTTOPICLABEL',
  summary: 'ZLINTTOPICSUMMARY',
  refetch: 'ZLINTREFETCHED',
  draft: 'ZLINTDRAFT',
  answer: 'ZLINTANSWER',
  challenge: 'ZLINTCHALLENGE',
  sourceText: 'ZLINTSOURCETEXT',
  sectionBody: 'ZLINTSECTIONBODY',
  observation: 'ZLINTOBSERVATION',
  rubric: 'ZLINTRUBRIC',
  context: 'ZLINTLEARNERCONTEXT',
} as const;

const MARKERS = Object.values(MARK);

/**
 * A board larger than any this product expects to see.
 *
 * Run 6 measured the fleet at 80 pins and asked where each agent runs out of
 * room. The budgets below are checked against a board of that size whose every
 * text field is an order of magnitude longer than a real one, because the
 * question a ceiling answers is not "is the typical prompt small" — it is
 * "what happens when one pin is a 40,000-character specification". Every cap in
 * the fleet is a `.slice()` somewhere, and a `.slice()` that goes missing is
 * invisible on a normal board.
 */
const BOARD_PINS = 80;
const HUGE = 20_000;

/**
 * Pages, as the panel sends them: `data:image/jpeg;base64,...`.
 *
 * Two of them rather than one, so the plural branch of every "the N attached
 * images" sentence is the branch that gets measured. The payload is a single
 * byte because nothing here decodes it: what is being linted is the prompt, and
 * a real page would put a hundred kilobytes of base64 into a fixture for no
 * assertion's benefit.
 */
const LINT_PAGES: readonly string[] = [
  'data:image/jpeg;base64,AA==',
  'data:image/jpeg;base64,AQ==',
];

const filler = (marker: string, length: number): string =>
  `${marker} ${'lorem ipsum dolor sit amet '.repeat(Math.ceil(length / 26)).slice(0, length)}`;

function envelope(i: number): CaptureEnvelope {
  return {
    selection: filler(MARK.selection, HUGE),
    parts: [
      { role: 'my-answer', text: filler(MARK.part, 4_000) },
      { role: 'correct-answer', text: filler(MARK.part, 4_000) },
    ],
    surroundingText: filler(MARK.surrounding, HUGE),
    headingPath: [filler(MARK.heading, 400), filler(MARK.heading, 400)],
    pageTitle: filler(MARK.title, 800),
    url: `https://example.invalid/page-${i}`,
    canonicalUrl: null,
    siteName: 'Example',
    contentLanguage: 'en',
    media: null,
  };
}

function pin(i: number, topicId: string | null): Pin {
  return {
    id: `p-${i}`,
    type: i % 3 === 0 ? 'struggle' : 'interest',
    envelope: envelope(i),
    note: filler(MARK.note, 1_200),
    capturedAt: '2026-07-01T00:00:00.000Z',
    fromSuggestion: false,
    enrichment: null,
    topicId,
  };
}

/** Three topics, so the Composer's brief exercises all three registers. */
const TOPIC_COUNT = 40;

function topic(i: number): Topic {
  return {
    id: `t-${i}`,
    label: `${MARK.label} ${i} ${'long label text '.repeat(30)}`,
    summary: filler(MARK.summary, 6_000),
    pinIds: [`p-${i}`, `p-${i + TOPIC_COUNT}`],
    state: 'working',
    comfort: (i % 10) / 10,
    lastExposedAt: '2026-07-20T00:00:00.000Z',
    retiredByUser: false,
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}

const PINS: readonly Pin[] = Array.from({ length: BOARD_PINS }, (_, i) =>
  pin(i, `t-${i % TOPIC_COUNT}`));
const TOPICS: readonly Topic[] = Array.from({ length: TOPIC_COUNT }, (_, i) => topic(i));

/** Comforts chosen so `registerFor` produces from-nothing, building and fluent. */
const COMFORTS: readonly ComfortResult[] = TOPICS.map((t, i) => ({
  topicId: t.id,
  comfort: [0.2, 0.6, 0.9][i % 3] as number,
  regressed: i % 7 === 0,
  evidenceCount: 4,
  demonstrationCount: 2,
  certainty: 0.8,
  evidenceSignalIds: [`s-${i}`],
}));

const DECISIONS: readonly GardenDecision[] = TOPICS.map((t, i) => ({
  topicId: t.id,
  disposition: 'teach',
  reason: `due this run, position ${i}`,
  priority: TOPIC_COUNT - i,
}));

const OBSERVATIONS: readonly Observation[] = Array.from({ length: 8 }, (_, i) => ({
  claim: filler(MARK.observation, 1_500),
  evidencePinIds: [`p-${i}`],
  implication: filler(MARK.observation, 1_500),
  mediumMismatch: i === 0,
  confidence: 0.9,
}));

const KNOWN_ABOUT_LEARNER = Array.from({ length: 20 }, (_, i) => `Known fact ${i} about the learner.`);

const SECTION = {
  topicId: 't-0',
  heading: 'A section heading',
  body: filler(MARK.sectionBody, 30_000),
  depth: 'building' as const,
  estimatedMinutes: 6,
  question: {
    prompt: 'What follows from that?',
    kind: 'free-text' as const,
    expectedPoints: ['one point', 'another point'],
  },
  sourceIds: ['p-0:origin'],
  mediumWarning: null,
};

const pureDeps = (llm: Llm): PureDeps => ({ llm, clock: fixedClock('2026-08-20T00:00:00Z') });

/**
 * Six gaps, each one oversized, because the Prospector's prompt is built out of
 * exactly this list and nothing else. The detail on a real gap is a topic label
 * and a statement, both of which are model prose over pinned pages, so the
 * whole block belongs inside the fence and the cap on it is the only thing
 * standing between one enormous topic summary and the prompt budget.
 */
const LINT_GAPS: readonly ProspectEvidence[] = Array.from({ length: 6 }, (_, i) => ({
  key: `statement:lint-${i}`,
  kind: 'shaky-statement',
  detail: `${filler(MARK.summary, 6_000)} ${filler(MARK.label, 600)}`,
  topicId: `t-${i}`,
  unconfirmed: i % 2 === 0,
}));

const fullDeps = (llm: Llm): Deps => ({
  llm,
  clock: fixedClock('2026-08-20T00:00:00Z'),
  store: {} as Deps['store'],
  research: {
    hasGrounding: false,
    fetchPage: async () => ({
      text: filler(MARK.refetch, 200_000),
      title: filler(MARK.title, 200),
    }),
    findReferences: async () => [],
  },
  embedder: {
    modelId: 'lint-embedder',
    embed: async (texts: readonly string[]) =>
      texts.map((_, i) => Array.from({ length: 8 }, (_, d) => ((i + d) % 5) / 5)),
  },
});

// ------------------------------------------------------------ the registry

/**
 * Every agent that talks to a model, with what it spends and what it has
 * promised the code downstream.
 *
 * `ceilingChars` is the LARGEST call it makes — system, prompt, and the schema
 * the adapter appends to the user turn — under the oversized board above.
 *
 * These are watermarks, not endorsements. Each is the figure measured at the
 * commit that added this file, rounded up for headroom, and several of them are
 * large because the agent caps the material it quotes and does not cap the
 * labels, notes, titles or summaries beside it. That is written up rather than
 * fixed here: changing what an agent is given is a prompt change, and prompt
 * changes in this product are settled by an evaluation run, not by a test. What
 * the number does buy is a tripwire — a field that stops being sliced shows up
 * as a failure here on the same day, instead of as a truncated prompt on
 * somebody's board six weeks later.
 *
 * `unfenced` is the same idea for the fence: the fields that reach the model at
 * instruction level, named one by one. Some are correct and deliberate (the
 * Verifier reads the section under test as the thing under test), some are the
 * audit's findings. Either way the set is fixed, so a NEW field escaping the
 * fence fails the build.
 */
interface AgentLint {
  readonly name: string;
  /** The module in `core/src/agents/`, without extension. */
  readonly module: string;
  readonly run: (llm: Llm) => Promise<unknown>;
  readonly ceilingChars: number;
  /** Markers known to render outside the fence, with the reason. */
  readonly unfenced?: readonly string[];
  /**
   * Set where the agent reads text the product did not write and its system
   * prompt carries no `UNTRUSTED_RULE` at all. See the audit's T1 and R1.
   */
  readonly fenceGap?: string;
  /**
   * Set where the agent carries the standing rule and has nothing to wrap in a
   * fence, with the reason.
   *
   * A third posture, added for the Transcriber, and the distinction is real
   * rather than a convenience. `fenceGap` means "reads untrusted text at
   * instruction level", which is a defect and is why that list must stay empty.
   * This means "the untrusted material is not text at all": the Transcriber is
   * handed images and nothing else, so `fencePinned` has no string to escape
   * and a fence around no text would be decoration of exactly the kind
   * `untrusted.ts` warns about. The rule still ships in its system prompt,
   * which the test above checks for every agent regardless of posture.
   */
  readonly fencesNothing?: string;
  /** Counts the prompt states, and the code that has to honour them. */
  readonly statedCaps?: readonly { readonly stated: RegExp; readonly enforced: number }[];
}

const AGENTS: readonly AgentLint[] = [
  {
    name: 'scout',
    module: 'scout',
    ceilingChars: 26_000,
    run: (llm) => scout(pureDeps(llm), {
      envelope: envelope(0),
      type: 'struggle',
      note: filler(MARK.note, 1_200),
      existingTopicLabels: TOPICS.map((t) => t.label),
    }),
  },
  {
    name: 'forager',
    module: 'forager',
    ceilingChars: 7_000,
    statedCaps: [{ stated: /at most (\w+)/i, enforced: 4 }],
    run: (llm) => forage(fullDeps(llm), { pin: pin(0, 't-0') }),
  },
  {
    name: 'clusterer',
    module: 'clusterer',
    ceilingChars: 260_000,
    run: (llm) => cluster(
      { llm, embedder: fullDeps(llm).embedder },
      { pins: PINS, existingTopics: [] },
    ),
  },
  {
    name: 'analyst',
    module: 'analyst',
    ceilingChars: 190_000,
    // Gist capped at 300, parts at 70, note uncapped. Same shape as C1.
    run: (llm) => analyse(pureDeps(llm), { pins: PINS, topics: TOPICS }),
  },
  {
    name: 'surveyor',
    module: 'surveyor',
    ceilingChars: 270_000,
    run: (llm) => survey(pureDeps(llm), { topics: TOPICS }),
  },
  {
    name: 'registrar',
    module: 'registrar',
    ceilingChars: 36_000,
    statedCaps: [{ stated: /At most (\w+) sentences/i, enforced: 8 }],
    run: async (llm) => {
      await renderStatements(
        pureDeps(llm), TOPICS, COMFORTS, OBSERVATIONS.map((o) => o.claim),
      );
      //  classification, on the same oversized board. Labels only: it
      // is the one call in the fleet that must not see a number about anybody.
      await classifyDemandKinds(pureDeps(llm), TOPICS.map((topic, index): ModalityTopicTally => ({
        topicId: topic.id, label: topic.label,
        checked: 3 + index, wentWell: index % 3, signalIds: [`sig-${index}`],
      })));
    },
  },
  {
    name: 'composer',
    module: 'composer',
    ceilingChars: 64_000,
    run: (llm) => compose(pureDeps(llm), {
      topics: TOPICS,
      pins: PINS,
      comforts: COMFORTS,
      decisions: DECISIONS,
      observations: OBSERVATIONS,
      knownAboutLearner: KNOWN_ABOUT_LEARNER,
      targetMinutes: 45,
      interfaceLanguage: 'en',
    }),
  },
  {
    name: 'verifier',
    module: 'verifier',
    ceilingChars: 42_000,
    // The section under test and the sources it was built from are both
    // untrusted model/page prose. The learner ledger remains outside because it
    // is product-owned context rather than an instruction-bearing document.
    run: (llm) => verify(pureDeps(llm), {
      section: SECTION,
      sourceMaterial: filler(MARK.sourceText, 200_000),
      knownAboutLearner: KNOWN_ABOUT_LEARNER,
    }),
  },
  {
    name: 'tutor',
    module: 'tutor',
    ceilingChars: 32_000,
    run: async (llm) => {
      const deps = pureDeps(llm);
      await markAnswer(deps, SECTION, filler(MARK.answer, 4_000));
      await rewriteAtDepth(deps, SECTION, 'fluent', 'Assume fluency.');
      await answerTangent(deps, filler(MARK.answer, 4_000), {
        heading: SECTION.heading, register: 'building',
      });
      await handleCorrection(
        deps,
        'a claim we made',
        filler(MARK.sourceText, 20_000),
        filler(MARK.challenge, 4_000),
      );
      await quickTake(deps, {
        material: filler(MARK.selection, HUGE),
        headingPath: [filler(MARK.heading, 400), filler(MARK.heading, 400)],
        pageTitle: filler(MARK.title, 800),
        note: filler(MARK.note, 1_200),
        register: 'building',
        guide: 'Assume the basics.',
        knownAboutLearner: [],
        learnerCorrections: [],
      });
      // `mode-guide-me`, both calls. Same material, same fence, and the second
      // one is given one step and never the list, which is the property that
      // keeps a guide from becoming a conversation.
      const guideInput = {
        material: filler(MARK.selection, HUGE),
        headingPath: [filler(MARK.heading, 400)],
        pageTitle: filler(MARK.title, 800),
        note: filler(MARK.note, 1_200),
        register: 'building' as const,
        guide: 'Assume the basics.',
        knownAboutLearner: [],
        learnerCorrections: [],
      };
      await guideSteps(deps, guideInput);
      await explainStep(deps, guideInput, {
        action: filler(MARK.note, 400),
        why: filler(MARK.note, 400),
      });
      await askAboutPin(deps, guideInput, filler(MARK.answer, 4_000));
      await markRecallAnswer(deps, {
        heading: filler(MARK.heading, 400),
        evidence: filler(MARK.sourceText, HUGE),
        prompt: filler(MARK.challenge, 4_000),
      }, filler(MARK.answer, 4_000));
    },
  },
  {
    name: 'intake-planner',
    module: 'intake-planner',
    ceilingChars: 55_000,
    run: (llm) => {
      let n = 0;
      const draft = buildDeterministicIntake({
        draftId: 'lint-draft', sourceId: 'lint-source', sourceKind: 'syllabus',
        sourceTitle: 'Oversized course source',
        text: `Course: Prompt lint\nReading notes: ${filler(MARK.sourceText, HUGE)}`,
        now: '2026-08-23T00:00:00.000Z', id: () => `intake-${++n}`, digest: 'sha256:lint',
      });
      return enrichCourseIntake(pureDeps(llm), draft, () => `proposed-${++n}`);
    },
  },
  {
    name: 'prospector',
    module: 'prospector',
    /*
     * Measured at 4,272 on the oversized board and rounded up for a sentence.
     * The whole prompt is six gaps at 300 characters each, so this number moves
     * only when `PROSPECT_MAX_GAPS` or the slice beside it moves, which is the
     * property worth a tripwire: the gap detail is a topic summary and those run
     * to six thousand characters on the board this file builds.
     */
    ceilingChars: 5_000,
    statedCaps: [{ stated: /At most (\w+) proposals/i, enforced: PROSPECT_MAX_PROPOSALS }],
    /**
     * Both calls, and the second one only renders if the first is answered with
     * an id that resolves. A recorder that synthesises `"lint"` for every string
     * would have the agent refuse its own reply and never ask the second
     * question, so the lead prompt would ship unlinted.
     */
    run: async (llm) => {
      const answering: Llm = {
        complete: llm.complete,
        structured: async <T,>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
          const recorded = await llm.structured<T>(req);
          const required = (req.schema as { required?: readonly string[] }).required ?? [];
          if (!required.includes('proposals')) return recorded;
          return {
            ...recorded,
            value: {
              proposals: [{
                evidenceId: 'e1',
                subject: 'A worked example of the thing they are shaky at',
                reason: 'Their own read of themselves on this topic is not settled.',
              }],
            } as T,
          };
        },
      };
      await prospect(pureDeps(answering), {
        gaps: LINT_GAPS, now: '2026-08-20T00:00:00.000Z', batchKey: '2026-08-20',
        id: () => 'lint-proposal',
      });
    },
  },
  {
    name: 'reviewer',
    module: 'reviewer',
    ceilingChars: 17_000,
    // Nothing. The draft is the learner's own writing, the weak-topic list is
    // model prose over pinned pages, and the background is whatever they were
    // sent — all three inside the fence, which is why this agent is no longer in
    // the `fenceGap` list below.
    statedCaps: [{ stated: /At most (\w+) findings/i, enforced: 5 }],
    run: (llm) => review(
      pureDeps(llm), filler(MARK.draft, 30_000), TOPICS, COMFORTS, filler(MARK.context, HUGE),
      LINT_PAGES,
    ),
  },
  {
    name: 'marker',
    module: 'marker',
    /*
     * The assignment QC. Its ceiling is set by the WORK, which is the thing
     * being marked and is capped at 12,000 — a piece of coursework is longer
     * than a draft email, and marking half of it while reporting on all of it
     * is the failure this cap has to be honest about. The criteria list is
     * capped at 24 rows of 400, and the weak-topic list carries labels only
     * (no summaries), which is the Reviewer's R2 finding applied before it
     * could happen again.
     *
     * Derived, not chosen: 12,000 of work + 24x400 of criteria + 4,000 of the
     * learner's own background + the system prompt and the fences = 29,218
     * measured, and 31,000 is that with room for a sentence. The work cap is the
     * one that can bite a real learner, so the agent reports `truncated` and the
     * screen says so rather than reporting a verdict on a piece it only read two
     * thirds of; the background cap reports separately, because "I read half
     * your brief" and "I marked half your work" are not the same sentence.
     *
     * The as-is route of 2026-08-24 adds one sentence outside the fence saying
     * what the attached pages are, at 130 characters, and the pages themselves
     * ride in `req.media` where they are not prompt text at all. The run below
     * carries pages AND a full-length work, which is the worse of the two
     * shapes, and the number does not move.
     */
    ceilingChars: 31_000,
    // Nothing unfenced. All four inputs — the criteria, the work, the weak list
    // and the background — are inside the fence, and the two most likely to
    // carry an instruction are the criteria and the background, which is why
    // both are scanned before they get here.
    statedCaps: [],
    run: (llm) => markAssignment(
      pureDeps(llm),
      filler(MARK.draft, 30_000),
      Array.from({ length: 24 }, (_, i) => `${i + 1}. ${filler(MARK.rubric, 380)}`).join('\n'),
      TOPICS,
      COMFORTS,
      filler(MARK.context, HUGE),
      LINT_PAGES,
    ),
  },
  {
    name: 'transcriber',
    module: 'transcriber',
    /*
     * Pages in, text out. Its prompt is one sentence and a page count, so the
     * ceiling is the SYSTEM prompt plus that sentence and nothing else: there
     * is no learner field in it to grow, which is unusual enough in this fleet
     * to be worth saying. The twenty pages it may be handed are images in
     * `req.media` and are not prompt text.
     */
    ceilingChars: 2_000,
    // The material is pictures, so there is no string to fence. The standing
    // rule still ships in the system prompt, which is checked separately: a
    // scanned handbook is somebody else's document and can carry an instruction
    // aimed at whatever reads it, in a photograph exactly as well as in a paste.
    fencesNothing: 'the untrusted material is images, and a fence around no text is decoration',
    run: (llm) => transcribePages(pureDeps(llm), LINT_PAGES),
  },
];

/** Rendered once. Every rule below reads this. */
const RENDERED = new Map<string, Recorded[]>();

for (const agent of AGENTS) {
  const { llm, calls } = recorder();
  await agent.run(llm);
  RENDERED.set(agent.name, calls);
}

const callsFor = (name: string): Recorded[] => {
  const calls = RENDERED.get(name);
  assert.ok(calls?.length, `${name} made no model call — the fixture is not exercising it`);
  return calls;
};

/** Calls issued by the named agent itself. The Tutor now invokes the separate
 * Verifier for quick takes, so its recorded run legitimately contains one
 * sibling-agent call as well as Tutor calls. Generic transport/fence/schema
 * lint still inspects all of them; ownership- and prose-specific assertions
 * use this narrower view. */
/**
 * The calls whose output a learner actually reads.
 *
 * Two exclusions, both because the reply never reaches a person as prose. The
 * Tutor's verifier-shaped call answers the code that parses it.
 * classification answers four fixed words from a closed vocabulary, chosen in
 * `domain/modality.ts` and never rendered: holding it to the paragraph and dash
 * rules would be asking a prompt to style output it does not produce.
 */
const ownedCallsFor = (name: string): Recorded[] => callsFor(name).filter((call) =>
  !(name === 'tutor'
    && call.req.system.includes('You are checking a study section BEFORE a learner reads it'))
  && !(name === 'registrar'
    && call.req.system.includes('You sort study topics by what kind of demand')));

// ---------------------------------------------------- 1. the fence holds

const OPEN = `<${PINNED_TAG}>`;
const CLOSE = `</${PINNED_TAG}>`;

/** Character ranges the fence covers, in the order they appear. */
function fenceSpans(text: string): readonly (readonly [number, number])[] {
  const spans: [number, number][] = [];
  let at = 0;
  for (;;) {
    const open = text.indexOf(OPEN, at);
    if (open < 0) break;
    const close = text.indexOf(CLOSE, open + OPEN.length);
    assert.ok(close > 0, 'an opened fence is never closed');
    spans.push([open, close + CLOSE.length]);
    at = close + CLOSE.length;
  }
  return spans;
}

const inside = (spans: readonly (readonly [number, number])[], at: number): boolean =>
  spans.some(([from, to]) => at >= from && at < to);

function unfencedMarkers(rendered: string): string[] {
  const spans = fenceSpans(rendered);
  const loose: string[] = [];
  for (const marker of MARKERS) {
    let at = rendered.indexOf(marker);
    while (at >= 0) {
      if (!inside(spans, at)) { loose.push(marker); break; }
      at = rendered.indexOf(marker, at + marker.length);
    }
  }
  return loose;
}

for (const agent of AGENTS) {
  test(`${agent.name}: only the declared fields reach the model outside the fence`, () => {
    const loose = new Set<string>();
    for (const call of callsFor(agent.name)) {
      for (const marker of unfencedMarkers(call.rendered)) loose.add(marker);
    }
    assert.deepEqual(
      [...loose].sort(), [...(agent.unfenced ?? [])].sort(),
      `${agent.name}: the set of fields at instruction level has changed. Text the`
      + ` product did not write reaching the model as though it had is the whole`
      + ` reason untrusted.ts exists — add it to the fence, or declare it here`
      + ` with the reason it belongs outside.`,
    );
  });
}

test('a system prompt is written by the product and by nobody else', () => {
  // The fence protects the user turn. Nothing should ever be building a SYSTEM
  // prompt out of a learner's board — a fence cannot help there, because the
  // system turn is the one the fence exists to distinguish from.
  for (const agent of AGENTS) {
    for (const call of callsFor(agent.name)) {
      for (const marker of MARKERS) {
        assert.ok(
          !call.req.system.includes(marker),
          `${agent.name} interpolated pinned text into its SYSTEM prompt`,
        );
      }
    }
  }
});

test('every agent prompt carries the untrusted-content rule', () => {
  // A tripwire in both directions. A new agent that skips the rule fails here
  // rather than shipping; closing one of these gaps fails here too, which is
  // the prompt for deleting the line rather than leaving a stale exemption —
  // and is what happened to the Reviewer when  gave it a caller.
  assert.deepEqual(
    AGENTS.filter((a) => a.fenceGap).map((a) => a.name),
    [],
  );
  for (const agent of AGENTS) {
    // A fencesNothing agent carries the PAGES variant of the rule: its
    // untrusted material is images, and the fence rule names markup that a
    // model with a wordless page will parrot straight back (found live,
    // 2026-08-24, in the criteria box).
    const rule = agent.fencesNothing ? UNTRUSTED_PAGES_RULE : UNTRUSTED_RULE;
    const carries = callsFor(agent.name).every((c) => c.req.system.includes(rule));
    assert.equal(carries, !agent.fenceGap, `${agent.name} disagrees with its declared posture`);
  }
});

test('a prompt that carries a fence also carries the rule saying what it means', () => {
  // untrusted.ts: "A delimiter the model has not been told about is decoration."
  for (const agent of AGENTS) {
    for (const call of callsFor(agent.name)) {
      if (!call.req.prompt.includes(OPEN) && !call.req.system.includes(OPEN)) continue;
      assert.ok(
        call.req.system.includes(UNTRUSTED_RULE),
        `${agent.name} fenced its material without telling the model what the fence is`,
      );
    }
  }
});

test('every fence in every prompt is balanced, and none is nested', () => {
  for (const agent of AGENTS) {
    for (const call of callsFor(agent.name)) {
      const opens = call.rendered.split(OPEN).length - 1;
      const closes = call.rendered.split(CLOSE).length - 1;
      assert.equal(opens, closes, `${agent.name}: ${opens} open tags, ${closes} close tags`);
      const spans = fenceSpans(call.rendered);
      for (const [from, to] of spans) {
        const body = call.rendered.slice(from + OPEN.length, to - CLOSE.length);
        assert.ok(!body.includes(OPEN), `${agent.name}: a fence opened inside a fence`);
      }
    }
  }
});

// ------------------------------------- 2. nothing reaches the model raw

/**
 * Things that only appear when an interpolation did not happen.
 *
 * Checked outside the fence only, for the ones a page could legitimately
 * contain: a learner may genuinely pin a passage about `undefined`, and failing
 * on their material rather than on ours would make the rule unusable.
 */
const ANYWHERE: readonly (readonly [string, RegExp])[] = [
  ['unrendered template literal', /\$\{/],
  ['handlebars-style placeholder', /\{\{\s*\w/],
  ['printf-style placeholder', /%[sd]\b/],
];

const OUTSIDE_FENCE: readonly (readonly [string, RegExp])[] = [
  ['stringified object', /\[object \w+\]/],
  ['bare undefined', /\bundefined\b/],
  ['bare NaN', /\bNaN\b/],
  ['an Error that reached the prompt', /\bError:\s/],
];

function outsideFence(rendered: string): string {
  const spans = fenceSpans(rendered);
  let out = '';
  let at = 0;
  for (const [from, to] of spans) {
    out += rendered.slice(at, from);
    at = to;
  }
  return out + rendered.slice(at);
}

for (const agent of AGENTS) {
  test(`${agent.name}: no template variable survives to the model`, () => {
    for (const call of callsFor(agent.name)) {
      for (const [what, re] of ANYWHERE) {
        assert.ok(!re.test(call.rendered), `${agent.name}: ${what} in the rendered call`);
      }
      const ours = outsideFence(call.rendered);
      for (const [what, re] of OUTSIDE_FENCE) {
        assert.ok(!re.test(ours), `${agent.name}: ${what} in the product's own instructions`);
      }
    }
  });
}

// ------------------------------------------------- 3. the budgets hold

const largestCall = (name: string): number => Math.max(...callsFor(name).map((c) =>
  c.req.system.length + c.req.prompt.length + (c.req.schema ? JSON.stringify(c.req.schema).length : 0)));

for (const agent of AGENTS) {
  test(`${agent.name}: its largest call fits its budget on an oversized board`, () => {
    const total = largestCall(agent.name);
    assert.ok(
      total <= agent.ceilingChars,
      `${agent.name} rendered ${total} characters against a ${agent.ceilingChars} budget`
      + ` — a cap has gone missing, or the budget needs re-deriving`,
    );
  });
}

test('the Forager reads one pin and never the board', () => {
  // AGENT_REQUIREMENTS §7. Per-pin isolation is what makes the nightly fan-out
  // parallelisable; a Forager that could see a second pin would be a Forager
  // whose cost is the board's size rather than the pin's.
  const prompt = callsFor('forager')[0]?.req.prompt ?? '';
  for (const other of PINS.slice(1)) {
    assert.ok(!prompt.includes(other.id), `the Forager was shown ${other.id}`);
  }
});

test('the Scout is given topic labels and never topic bodies', () => {
  // §7 again, and it is what keeps the toast inside 1.5 seconds. A summary is
  // an order of magnitude more text than a label.
  const prompt = callsFor('scout')[0]?.req.prompt ?? '';
  assert.ok(prompt.includes(MARK.label), 'the Scout can no longer match against existing topics');
  assert.ok(!prompt.includes(MARK.summary), 'the Scout is being shown topic bodies');
});

test('the Registrar is given the ledger and never the material', () => {
  // §7: "the signal ledger delta plus current comfort state. Not material."
  const prompt = callsFor('registrar')[0]?.req.prompt ?? '';
  assert.ok(!prompt.includes(MARK.selection), 'the Registrar is being shown pinned passages');
  assert.ok(!prompt.includes(MARK.surrounding), 'the Registrar is being shown page text');
});

test('the Registrar asks for exactly the demand kinds the code will accept', () => {
  //. The vocabulary is closed in `domain/modality.ts` and enforced by
  // `admitModalityKinds`, which drops anything outside it. A prompt that
  // offered a fifth kind would produce answers silently thrown away; a schema
  // whose enum disagreed with the prompt would do the same thing one layer
  // down. Both are asserted against the one list that owns the vocabulary.
  const call = callsFor('registrar')
    .find((c) => c.req.system.includes('You sort study topics by what kind of demand'));
  assert.ok(call, 'the Registrar no longer classifies anything');
  for (const kind of MODALITY_KINDS) {
    assert.ok(call.req.system.includes(`- ${kind}:`), `the prompt never offers "${kind}"`);
  }
  const schema = call.req.schema as { properties?: Record<string, { items?: SchemaNode }> };
  const enumerated = (schema.properties?.['topics']?.items?.properties?.['kind'] as
    { enum?: readonly string[] } | undefined)?.enum;
  assert.deepEqual([...(enumerated ?? [])], [...MODALITY_KINDS],
    'the schema enum and the vocabulary the code accepts have drifted apart');
  // And nothing about the learner reaches it. The counts that turn these words
  // into a claim are added afterwards, in arithmetic.
  assert.ok(!/\b(comfortable|struggling|getting there|went well|checks)\b/i.test(call.rendered),
    'the classification call is being shown how the learner is doing');
});

test('the Reviewer is given the weak spots and never the whole board', () => {
  // §7: "the draft plus the user's weak-topic list. Not the whole board."
  const prompt = callsFor('reviewer')[0]?.req.prompt ?? '';
  const shown = TOPICS.filter((t) => prompt.includes(`${t.id} "`));
  assert.ok(shown.length > 0, 'the Reviewer lost its weak-topic list');
  assert.ok(shown.length < TOPICS.length, 'the Reviewer is being handed the whole board');
  const byId = new Map(COMFORTS.map((c) => [c.topicId, c]));
  for (const t of shown) {
    assert.ok((byId.get(t.id)?.comfort ?? 1) < 0.6, `${t.id} is not a weak topic`);
  }
});

test('the Tutor is given this section and never the board', () => {
  // §7: the Tutor's context "must not accumulate — an ever-growing Tutor
  // context is how this product would quietly become a chatbot".
  for (const call of callsFor('tutor')) {
    assert.ok(!call.req.prompt.includes(MARK.label), 'the Tutor is being shown the topic board');
    assert.ok(!call.req.prompt.includes(MARK.summary), 'the Tutor is being shown topic bodies');
  }
});

test('a foreground agent never asks for the thinking pass, and the Verifier never skips it', () => {
  // `reasoning` is the latency axis (ports/llm.ts) and, for the Verifier, the
  // safety one: a verifier that fails open manufactures confidence.
  for (const call of callsFor('scout')) assert.equal(call.req.reasoning, 'off');
  for (const call of callsFor('tutor')) {
    assert.ok(call.req.reasoning === 'off' || call.req.reasoning === 'on');
  }
  for (const call of callsFor('verifier')) assert.equal(call.req.reasoning, 'on');
});

// ------------------------------- 4. the schema the parser can enforce

/**
 * The keywords `adapters/src/json-schema.ts` actually implements. Anything else
 * in a shipped schema is a constraint the agent believes it stated and the
 * adapter silently drops — the model may honour it, and nothing checks.
 */
const SUPPORTED = new Set(['type', 'properties', 'required', 'items', 'enum', 'additionalProperties']);

function walkSchema(node: unknown, path: string, visit: (n: SchemaNode, path: string) => void): void {
  if (!node || typeof node !== 'object') return;
  const n = node as SchemaNode;
  visit(n, path);
  for (const [key, sub] of Object.entries(n.properties ?? {})) walkSchema(sub, `${path}.${key}`, visit);
  if (n.items) walkSchema(n.items, `${path}[]`, visit);
}

for (const agent of AGENTS) {
  test(`${agent.name}: every schema it ships is one the adapter can enforce`, () => {
    for (const call of callsFor(agent.name)) {
      if (!call.req.schema) continue;
      walkSchema(call.req.schema, '$', (node, path) => {
        for (const key of Object.keys(node)) {
          assert.ok(
            SUPPORTED.has(key),
            `${agent.name} ${path}: "${key}" is not enforced by validateSchema —`
            + ` the prompt states a constraint nothing checks`,
          );
        }
        for (const key of node.required ?? []) {
          assert.ok(
            node.properties && key in node.properties,
            `${agent.name} ${path}: required "${key}" is not declared in properties`,
          );
        }
      });
    }
  });
}

test('a structured call always states a schema, and a schema is always an object', () => {
  for (const agent of AGENTS) {
    // A `complete()` call is prose out and has no schema to state. The
    // assertion that matters is the other direction, below.
    for (const call of callsFor(agent.name).filter((c) => c.structured)) {
      assert.ok(call.req.schema, `${agent.name} made a structured call with no schema`);
      const root = call.req.schema as SchemaNode;
      assert.equal(root.type, 'object', `${agent.name}: a top-level schema must be an object`);
      assert.ok(root.required?.length, `${agent.name}: a top-level schema must require its fields`);
    }
    for (const call of callsFor(agent.name).filter((c) => !c.structured)) {
      assert.equal(call.req.schema, undefined,
        `${agent.name} sent a schema on a call that asks for prose, which nothing enforces`);
    }
  }
});

test('the Verifier asks for exactly the defect kinds its parser accepts', () => {
  // The parser drops any kind not in this set, silently. A prompt that
  // enumerates a sixth kind would produce findings that are filtered out on the
  // way back — a safety check quietly narrowing itself.
  const accepted = [
    'unsupported', 'inconsistent', 'fabricated-about-learner',
    'bad-instruction', 'injected-instruction',
  ];
  const system = callsFor('verifier')[0]?.req.system ?? '';
  const flat = system.toUpperCase();
  for (const kind of accepted) {
    assert.ok(
      flat.includes(kind.toUpperCase()),
      `the Verifier's parser accepts "${kind}" and the prompt never names it`,
    );
  }
  // And the count the prompt promises is the count it lists.
  const NUMBERS: Record<string, number> = {
    three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  const claim = /Check (\w+) things/i.exec(system);
  assert.ok(claim, 'the Verifier prompt no longer states how many things it checks');
  assert.equal(
    NUMBERS[(claim[1] ?? '').toLowerCase()], accepted.length,
    'the Verifier promises a different number of checks than it has defect kinds',
  );
});

// ---------------------------- 5. a stated count is an enforced count

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const asNumber = (token: string): number =>
  WORD_NUMBERS[token.toLowerCase()] ?? Number(token);

for (const agent of AGENTS.filter((a) => a.statedCaps?.length)) {
  test(`${agent.name}: the limit the prompt states is the limit the code enforces`, () => {
    const system = callsFor(agent.name)[0]?.req.system ?? '';
    for (const { stated, enforced } of agent.statedCaps ?? []) {
      const found = stated.exec(system);
      assert.ok(found, `${agent.name}: the prompt no longer states ${stated}`);
      assert.equal(
        asNumber(found[1] ?? ''), enforced,
        `${agent.name} asks the model for a different number than the code keeps`,
      );
    }
  });
}

test('the Composer states a per-section length, and it is the computed one', () => {
  //  rests on this. The model is given words — a thing it can control —
  // and minutes are derived from what it wrote (`minutesFor`). A prompt that
  // went back to naming minutes would silently restore the behaviour Run 2
  // measured: the model targeting the number instead of estimating.
  const prompt = callsFor('composer')[0]?.req.prompt ?? '';
  const lengths = [...prompt.matchAll(/^ {2}length: about (\d+) words$/gm)];
  assert.ok(lengths.length > 0, 'the Composer brief no longer states a word budget per section');
  for (const found of lengths) {
    assert.ok(Number(found[1]) > 0, 'a section was budgeted zero words');
  }
  assert.ok(
    !/\blength: about \d+ minutes\b/.test(prompt),
    'the Composer is asking the model for minutes again',
  );
});

test('every depth register the code knows about is described to the model', () => {
  // `registerFor` can return any of three, and a register with no guide beside
  // it in the brief is a section the model pitches by guesswork.
  const prompt = callsFor('composer')[0]?.req.prompt ?? '';
  for (const register of ['from-nothing', 'building', 'fluent']) {
    // The separator was an em-dash until the house style banned it from the
    // product's own words. What is asserted is unchanged: the register is
    // named and something follows it.
    const found = new RegExp(`^ {2}register: ${register}\\. \\S`, 'm').test(prompt);
    assert.ok(found, `the Composer brief never explains the "${register}" register`);
  }
});

// -------------------------- 6. no agent, vendor or capability invented

const SOURCE_DIR = new URL('../../src/agents/', import.meta.url);
const agentSource = (module: string): string =>
  readFileSync(fileURLToPath(new URL(`${module}.ts`, SOURCE_DIR)), 'utf8');

const MODULES = readdirSync(fileURLToPath(SOURCE_DIR))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => f.replace(/\.ts$/, ''));

/** Named in `AGENT_REQUIREMENTS.md` but not shipped — the Cartographer became
 *  the Clusterer and the Analyst, and a prompt still naming it is stale. */
const RETIRED = ['cartographer'];

test('no prompt names an agent that is not in the fleet', () => {
  const roster = new Set(MODULES.filter((m) => !['deps', 'untrusted'].includes(m)));
  for (const agent of AGENTS) {
    for (const call of callsFor(agent.name)) {
      const ours = outsideFence(call.rendered).toLowerCase();
      for (const retired of RETIRED) {
        assert.ok(!ours.includes(retired), `${agent.name} still names the retired ${retired}`);
      }
      for (const name of [...roster, ...RETIRED]) {
        // A prompt may name a sibling agent; it may not name one that is gone.
        if (ours.includes(` ${name} `)) {
          assert.ok(roster.has(name), `${agent.name} names "${name}", which does not exist`);
        }
      }
    }
  }
});

test('no prompt names a vendor or a model — core does not know what a Gemini is', () => {
  // domain/types.ts states the rule for the domain; it holds harder for the
  // prompts, because a prompt naming a provider is a prompt that stops being
  // portable the day the adapter changes (ports/llm.ts).
  const VENDORS = /\b(gemini|gemma|gpt-?\d|openai|anthropic|claude|llama|mistral|ollama|qwen)\b/i;
  for (const agent of AGENTS) {
    for (const call of callsFor(agent.name)) {
      const found = VENDORS.exec(outsideFence(call.rendered));
      assert.equal(found, null, `${agent.name} names "${found?.[0]}" in its prompt`);
    }
  }
});

test('no prompt promises a capability the port does not carry', () => {
  // `LlmRequest` offers a schema, media and a token budget. It offers no tools,
  // no browsing and no memory, and a prompt that implies otherwise buys a
  // refusal or an invention rather than an answer.
  const PROMISES = [
    /\bsearch the web\b/i,
    /\bbrowse\b/i,
    /\bcall (a|the) (function|tool)\b/i,
    /\byou have access to\b/i,
    /\bin (our|the) (previous|last) (session|conversation)\b/i,
  ];
  for (const agent of AGENTS) {
    for (const call of callsFor(agent.name)) {
      const ours = outsideFence(call.rendered);
      for (const re of PROMISES) {
        assert.ok(!re.test(ours), `${agent.name} promises something the port cannot do: ${re}`);
      }
    }
  }
});

// ------------------------- 7. the measurement harness still recognises us

test('scripts/measure-prompts.mjs still recognises every agent it measures', () => {
  // The script identifies an agent by a substring of its system prompt, so that
  // measuring the fleet cannot change the fleet. The cost of that choice is
  // this test: a reworded prompt otherwise turns up in the growth table as
  // `unknown`, and the ceiling question Run 6 asked goes quietly unanswered.
  const script = readFileSync(
    fileURLToPath(new URL('../../../scripts/measure-prompts.mjs', import.meta.url)), 'utf8');
  const table = /const AGENTS = \[([\s\S]*?)\n\];/.exec(script);
  assert.ok(table, 'the probe table in measure-prompts.mjs has moved');
  const probes = [...(table[1] ?? '').matchAll(/\['([\w-]+)', '([^']+)'\]/g)]
    .map((m) => [m[1] as string, m[2] as string] as const);
  assert.ok(probes.length >= 7, 'the probe table came back short — the parse is wrong');

  for (const [name, probe] of probes) {
    const matched = AGENTS.filter((a) =>
      ownedCallsFor(a.name).some((c) => c.req.system.includes(probe)));
    assert.deepEqual(
      matched.map((a) => a.name), [name],
      `the probe for "${name}" no longer identifies exactly that agent`,
    );
  }
});

// ------------------------------------- 8. the registry cannot go stale

test('every agent module that talks to a model is linted here', () => {
  // The reason this file is table-driven. A tenth agent is caught the day it is
  // written, by the only test in the suite that reads the directory rather than
  // the registry.
  const talkers = MODULES.filter((m) => /deps\.llm\.|llm\.structured\(|llm\.complete\(/.test(agentSource(m)));
  const linted = new Set(AGENTS.map((a) => a.module));
  for (const module of talkers) {
    assert.ok(linted.has(module), `core/src/agents/${module}.ts calls the model and is not in AGENTS`);
  }
  for (const agent of AGENTS) {
    assert.ok(MODULES.includes(agent.module), `AGENTS names ${agent.module}, which is not a module`);
  }
});

test('every agent that reads pinned material imports the fence and the rule', () => {
  // Static, deliberately: the render-time check above can only see the paths a
  // fixture happens to exercise, and an agent that imports neither is one that
  // was never going to fence anything on any path.
  for (const agent of AGENTS.filter((a) => !a.fenceGap && !a.fencesNothing)) {
    const source = agentSource(agent.module);
    assert.match(source, /import \{[^}]*UNTRUSTED_RULE[^}]*\} from '\.\/untrusted\.js'/,
      `${agent.module}.ts does not import the standing rule`);
    assert.match(source, /fencePinned/, `${agent.module}.ts does not fence anything`);
  }
});

// -------------------- the gap between a schema and what the code believes

test('a section question is completed to the shape the type promises', async () => {
  const { llm } = recorder();
  const partial: Llm = {
    complete: llm.complete,
    structured: async <T,>(): Promise<LlmResult<T>> => ({
      value: {
        sections: [{
          topicId: 't-0',
          heading: 'h',
          body: 'a body with some words in it',
          estimatedMinutes: 4,
          // Schema-conformant and incomplete: no kind, no expectedPoints.
          question: { prompt: 'What follows from that?' },
          sourceIds: [],
          mediumWarning: null,
        }],
        closingNote: null,
      } as T,
      modelId: 'lint', inputTokens: 0, outputTokens: 0,
    }),
  };

  const session = await compose(pureDeps(partial), {
    topics: TOPICS, pins: PINS, comforts: COMFORTS, decisions: DECISIONS,
    observations: [], knownAboutLearner: [], targetMinutes: 15, interfaceLanguage: 'en',
  });

  const question = session.sections[0]?.question;
  assert.ok(question, 'the question was dropped rather than completed');
  assert.deepEqual(question.expectedPoints, [], 'a missing list must read as an empty one');
  assert.equal(question.kind, 'free-text', 'an unstated kind falls back to the open one');

  // The reason it matters: this runs in the foreground with the learner waiting.
  const marked = await markAnswer(pureDeps(recorder().llm), {
    heading: 'h', body: 'a body', question,
  }, 'their answer');
  assert.ok(typeof marked.response === 'string');
});

// ------------------------------------------- 7. the house style, and the example set

/**
 * The prose rules, and the prompts obeying their own instruction.
 *
 * Both of these come from the first day the product was used by a person
 * rather than by a fixture (2026-08-22). The take that came back was one
 * unbroken block containing two em-dashes, and neither was a model failure:
 * nothing had ever asked for paragraphs, and the prompt asking for the prose
 * was itself written in em-dashes throughout.
 *
 * The second half is the one worth having. A model imitates the register of
 * its instructions far more reliably than it obeys a rule inside them, so a
 * prompt that bans a mark while using it twelve times is a prompt that will
 * get the mark back. This asserts over the product's OWN words only, using
 * the same fence arithmetic the interpolation lint uses: pinned material is
 * the learner's page and may contain anything at all.
 */
/**
 * Which agents put words in front of a learner.
 *
 * Not every agent does. The Forager reads pages, the Surveyor and the Analyst
 * write for the Composer, and the Verifier writes for the code that parses it.
 * These four are read as prose by a person, which is what makes the style
 * their business.
 */
const LEARNER_FACING = ['composer', 'tutor', 'reviewer', 'registrar'] as const;

for (const name of LEARNER_FACING) {
  test(`${name}: every call a learner reads carries the dash rule`, () => {
    for (const call of ownedCallsFor(name)) {
      assert.ok(String(call.req.system ?? '').includes(DASH_RULE),
        `${name}: a prompt whose output a learner reads, with no dash rule on it`);
    }
  });
}

/**
 * And the long-form ones carry the paragraph rules as well.
 *
 * Long-form is the distinction that matters: the Tutor answers a marked
 * question in two sentences, and a two-sentence reply can only obey "break
 * this into paragraphs" by padding. So the split is by shape of output, not
 * by agent, and it is asserted where the shape is decided.
 */
test('the Composer writes long-form, so its brief carries the paragraph rules', () => {
  for (const call of callsFor('composer')) {
    assert.ok(String(call.req.system).includes(PROSE_STYLE),
      'a Composer call without PROSE_STYLE: sections are the longest prose the product ships');
  }
});

test('the long-form Tutor calls carry the paragraph rules, and the short ones do not', () => {
  const systems = ownedCallsFor('tutor').map((c) => String(c.req.system ?? ''));
  const long = systems.filter((sys) => sys.includes(PROSE_STYLE));
  const short = systems.filter((sys) => !sys.includes(PROSE_STYLE));
  assert.ok(long.length >= 3, 'the quick take, depth rewrite and learner question are long-form prose');
  for (const sys of long) {
    assert.ok(/explanation of it right now|rewrite one section|stuck on one step|reading something they saved/.test(sys),
      'a short Tutor reply was told to break itself into paragraphs, which it can only do by padding');
  }
  for (const sys of short) {
    assert.ok(sys.includes(SHORT_REPLY_STYLE), 'a short Tutor reply with no style rules at all');
  }
});

for (const agent of AGENTS) {
  test(`${agent.name}: the product's own words obey the dash rule they ship`, () => {
    for (const call of callsFor(agent.name)) {
      const ours = outsideFence(call.rendered);
      assert.ok(!hasBannedDash(ours),
        `${agent.name}: an em-dash or en-dash in the product's own prompt text. `
        + 'The model copies the register of its instructions, so a prompt that uses the mark it bans gets the mark back.');
      assert.ok(!hasBannedDash(String(call.req.system ?? '')),
        `${agent.name}: an em-dash or en-dash in the system prompt`);
    }
  });
}

test('the house style asks for the paragraphs the panel can actually render', () => {
  // `panel.css` sets `white-space: pre-wrap` on the take and on a session
  // section, which is what makes a blank line between paragraphs survive to
  // the screen. If that ever changes, asking for paragraphs becomes asking
  // for something the surface silently collapses.
  const css = readFileSync(
    fileURLToPath(new URL('../../../extension/panel.css', import.meta.url)), 'utf8');
  for (const rule of ['.quick-take .body', '.section .body']) {
    const at = css.indexOf(rule);
    assert.ok(at > 0, `${rule} is gone from panel.css`);
    assert.match(css.slice(at, at + 120), /white-space:\s*pre-wrap/,
      `${rule} no longer preserves newlines, so PROSE_STYLE asks for paragraphs nothing renders`);
  }
  assert.match(PROSE_STYLE, /blank line between them/);
  assert.ok(!hasBannedDash(PROSE_STYLE), 'the rule against the dash uses the dash');
});
