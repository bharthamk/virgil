import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LlmRefused, type Llm } from '../ports/llm.js';
import { fixedClock } from '../ports/clock.js';
import type { Deps, PureDeps } from '../agents/deps.js';
import type { CaptureEnvelope, Pin, Topic } from '../domain/types.js';
import { scout } from '../agents/scout.js';
import { forage, forageBatch } from '../agents/forager.js';
import { cluster } from '../agents/clusterer.js';
import { analyse, type Observation } from '../agents/analyst.js';
import { survey } from '../agents/surveyor.js';
import { classifyDemandKinds, renderStatements, type ComfortResult } from '../agents/registrar.js';
import { compose } from '../agents/composer.js';
import { verify } from '../agents/verifier.js';
import {
  markAnswer, rewriteAtDepth, answerTangent, handleCorrection,
  quickTake, guideSteps, explainStep, askAboutPin, markRecallAnswer,
} from '../agents/tutor.js';
import { review } from '../agents/reviewer.js';
import { markAssignment } from '../agents/marker.js';
import { transcribePages } from '../agents/transcriber.js';
import { enrichCourseIntake } from '../agents/intake-planner.js';
import { prospect } from '../agents/prospector.js';
import type { ProspectEvidence } from '../domain/prospect.js';
import { buildDeterministicIntake } from '../domain/intake.js';
import type { GardenDecision } from '../agents/gardener.js';

/**
 * A REFUSAL IS NOT A FAILURE — the rule, over the whole fleet at once.
 *
 * ## The defect this file exists about
 *
 * Half the agents here catch a model error on purpose and degrade, and every
 * one of those catches is right on its own terms: a mark that says the check
 * did not run beats a 500, and an unenriched pin beats a lost night. What none
 * of them could tell was the difference between a call that FAILED and a call
 * that was never issued.
 *
 * Found live, on a build with a spend limit already shipped and already
 * working. The budget was exhausted, deep was routed to cloud, `POST /review`
 * was pressed, and the service answered **200** with `outcome: 'model-failed'`
 * — the sentence the panel renders as "the check did not run", over a stop the
 * learner had configured themselves. The 402 branch the service already had,
 * and the dedicated sentence the extension already rendered on it, were
 * unreachable on every path that ran through an agent, because the agent had
 * already turned the refusal into a degraded result before the handler could
 * see it. Only the header on the reply said what had actually happened.
 *
 * ## Why it is one table rather than fourteen tests
 *
 * The rule is a fleet rule, in the same sense `prompt-lint.test.ts`'s rules are
 * fleet rules, and a per-agent test would be fourteen chances to write the
 * fifteenth agent without it. Each entry declares the ONE thing that varies:
 * what the agent does with an ordinary model failure. Whether a refusal travels
 * is not a per-agent decision and is not in the table.
 *
 * The deliberate exception is not here because it is not in `core/`: `POST
 * /pins` degrades a refusal to a fallback label on purpose, because the pin is
 * written after the label and a 402 would throw the learner's capture away. Its
 * reasoning is at the catch, and its proof is in the runner's budget tests.
 */

// ------------------------------------------------------------ the two models

/** Refuses everything, the way the runner's kill switch refuses. */
const refusing = (): Llm => ({
  complete: async () => { throw new LlmRefused('nothing was sent'); },
  structured: async () => { throw new LlmRefused('nothing was sent'); },
});

/** Fails everything, the way a provider outage fails. */
const failing = (): Llm => ({
  complete: async () => { throw new Error('the provider is down'); },
  structured: async () => { throw new Error('the provider is down'); },
});

/**
 * A subclass, because that is how the refusal actually arrives.
 *
 * `ModelBudgetStop` is not `LlmRefused`; it extends it, and an agent that
 * tested `err.name === 'LlmRefused'` or compared constructors would pass every
 * assertion below against the base class and swallow the only instance the
 * product ever throws.
 */
class StubBudgetStop extends LlmRefused {
  constructor() {
    super('your budget stopped this before anything was sent');
    this.name = 'StubBudgetStop';
  }
}

const subclassRefusing = (): Llm => ({
  complete: async () => { throw new StubBudgetStop(); },
  structured: async () => { throw new StubBudgetStop(); },
});

// ------------------------------------------------------------- the fixtures

const clock = fixedClock('2026-08-24T09:00:00Z');

const pureDeps = (llm: Llm): PureDeps => ({ llm, clock });

const embedder = {
  modelId: 'refusal-embedder',
  embed: async (texts: readonly string[]) =>
    texts.map((_, i) => Array.from({ length: 8 }, (_, d) => ((i + d) % 5) / 5)),
};

const fullDeps = (llm: Llm): Deps => ({
  llm,
  clock,
  store: {} as Deps['store'],
  research: {
    hasGrounding: false,
    fetchPage: async () => ({ text: 'the re-fetched page', title: 'A page' }),
    findReferences: async () => [],
  },
  embedder,
});

const envelope = (i: number): CaptureEnvelope => ({
  selection: `a passage worth explaining, number ${i}`,
  parts: [],
  surroundingText: `the argument around passage ${i}`,
  headingPath: ['A chapter', 'A section'],
  pageTitle: `Page ${i}`,
  url: `https://example.invalid/page-${i}`,
  canonicalUrl: null,
  siteName: 'Example',
  contentLanguage: 'en',
  media: null,
});

const pin = (i: number, topicId: string | null): Pin => ({
  id: `p-${i}`,
  type: 'interest',
  envelope: envelope(i),
  note: 'the learner wrote this beside it',
  capturedAt: '2026-08-01T00:00:00.000Z',
  fromSuggestion: false,
  enrichment: null,
  topicId,
});

const topic = (i: number): Topic => ({
  id: `t-${i}`,
  label: `Topic ${i}`,
  summary: `What topic ${i} is about.`,
  pinIds: [`p-${i}`],
  state: 'working',
  comfort: 0.4,
  lastExposedAt: '2026-08-10T00:00:00.000Z',
  retiredByUser: false,
  createdAt: '2026-07-01T00:00:00.000Z',
});

// Four, not three: the Analyst refuses to say anything about fewer , and
// a fixture under its floor would make an agent that never called a model look
// like an agent that let a refusal through.
const PINS: readonly Pin[] = [pin(0, 't-0'), pin(1, 't-1'), pin(2, 't-2'), pin(3, 't-0')];
const LOOSE_PINS: readonly Pin[] = [pin(0, null), pin(1, null), pin(2, null)];
const TOPICS: readonly Topic[] = [topic(0), topic(1), topic(2)];

const COMFORTS: readonly ComfortResult[] = TOPICS.map((t, i) => ({
  topicId: t.id,
  comfort: [0.2, 0.6, 0.9][i % 3] as number,
  regressed: false,
  evidenceCount: 4,
  demonstrationCount: 2,
  certainty: 0.8,
  evidenceSignalIds: [`s-${i}`],
}));

const DECISIONS: readonly GardenDecision[] = TOPICS.map((t, i) => ({
  topicId: t.id,
  disposition: 'teach',
  reason: 'due this run',
  priority: 3 - i,
}));

const OBSERVATIONS: readonly Observation[] = [{
  claim: 'They pin the worked examples and not the definitions.',
  evidencePinIds: ['p-0'],
  implication: 'Lead with a worked example.',
  mediumMismatch: false,
  confidence: 0.9,
}];

const KNOWN_ABOUT_LEARNER = ['They are building on this topic.'];

const SECTION = {
  topicId: 't-0',
  heading: 'A section heading',
  body: 'The body of the section, as the composer wrote it.',
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

/**
 * Long enough to be reviewed and marked.
 *
 * Both agents refuse a piece under their own floor — 80 characters for a draft,
 * 200 for a piece of work — before they reach a model, and a fixture under the
 * floor would pass the refusal assertions by never making a call at all.
 */
const DRAFT = 'They wrote this themselves, at some length, and would like to know what is weak about it. '.repeat(4);

const PAGES: readonly string[] = [
  'data:image/jpeg;base64,AA==',
  'data:image/jpeg;base64,AQ==',
];

const TAKE_INPUT = {
  material: 'A passage the learner just saved and wants explaining.',
  headingPath: ['A chapter'],
  pageTitle: 'A page',
  note: 'their own note',
  register: 'building' as const,
  guide: 'Assume the basics.',
  knownAboutLearner: [],
  learnerCorrections: [],
};

/**
 * One gap, because the Prospector answers an empty list without calling
 * anything. A fixture with no gaps in it would pass every assertion below by
 * never reaching the model at all.
 */
const GAPS: readonly ProspectEvidence[] = [{
  key: 'statement:refusal',
  kind: 'shaky-statement',
  detail: 'On "Topic 0": they reach for the mechanism before the definition.',
  topicId: 't-0',
  unconfirmed: true,
}];

const intakeDraft = () => {
  let n = 0;
  return buildDeterministicIntake({
    draftId: 'refusal-draft',
    sourceId: 'refusal-source',
    sourceKind: 'syllabus',
    sourceTitle: 'A course source',
    text: 'Course: Refusals\nAssignment 1 is due on 12 March 2027.',
    now: '2026-08-24T00:00:00.000Z',
    id: () => `intake-${++n}`,
    digest: 'sha256:refusal',
  });
};

// -------------------------------------------------------------- the registry

/**
 * Every agent that talks to a model, with what it does when one FAILS.
 *
 * `onFailure` is the existing, deliberate behaviour and is asserted unchanged —
 * this rule takes one error out of the degrading bucket and must not quietly
 * take any other out with it. `degrades` means the agent answers with a
 * reduced result and the caller carries on; `propagates` means it never caught
 * the error in the first place and the stage or handler above it decides.
 */
interface RefusalCase {
  readonly name: string;
  readonly run: (llm: Llm) => Promise<unknown>;
  readonly onFailure: 'degrades' | 'propagates';
}

const CASES: readonly RefusalCase[] = [
  {
    name: 'scout',
    onFailure: 'propagates',
    run: (llm) => scout(pureDeps(llm), {
      envelope: envelope(0), type: 'interest', note: null,
      existingTopicLabels: TOPICS.map((t) => t.label),
    }),
  },
  {
    name: 'forage',
    onFailure: 'degrades',
    run: (llm) => forage(fullDeps(llm), { pin: pin(0, 't-0') }),
  },
  {
    name: 'forageBatch',
    onFailure: 'degrades',
    run: (llm) => forageBatch(fullDeps(llm), { pins: LOOSE_PINS, chunk: 2 }),
  },
  {
    name: 'cluster',
    onFailure: 'degrades',
    run: (llm) => cluster({ llm, embedder }, { pins: LOOSE_PINS, existingTopics: [] }),
  },
  {
    name: 'analyse',
    onFailure: 'propagates',
    run: (llm) => analyse(pureDeps(llm), { pins: PINS, topics: TOPICS }),
  },
  {
    name: 'survey',
    onFailure: 'propagates',
    run: (llm) => survey(pureDeps(llm), { topics: TOPICS }),
  },
  {
    name: 'renderStatements',
    onFailure: 'propagates',
    run: (llm) => renderStatements(
      pureDeps(llm), TOPICS, COMFORTS, OBSERVATIONS.map((o) => o.claim),
    ),
  },
  {
    //. The one call in the fleet whose ordinary failure is designed to
    // be invisible: the caller degrades to no question, and the statements the
    // same stage wrote a moment earlier are untouched. The refusal still has to
    // travel, because the stage is the only place that knows it may swallow it.
    name: 'classifyDemandKinds',
    onFailure: 'degrades',
    run: (llm) => classifyDemandKinds(pureDeps(llm), [
      { topicId: 't-0', label: 'Ordinary differential equations', checked: 3, wentWell: 1, signalIds: ['s-1'] },
    ]),
  },
  {
    name: 'compose',
    onFailure: 'propagates',
    run: (llm) => compose(pureDeps(llm), {
      topics: TOPICS, pins: PINS, comforts: COMFORTS, decisions: DECISIONS,
      observations: OBSERVATIONS, knownAboutLearner: KNOWN_ABOUT_LEARNER,
      targetMinutes: 45, interfaceLanguage: 'en',
    }),
  },
  {
    name: 'verify',
    onFailure: 'propagates',
    run: (llm) => verify(pureDeps(llm), {
      section: SECTION, sourceMaterial: 'the pinned material', knownAboutLearner: KNOWN_ABOUT_LEARNER,
    }),
  },
  {
    name: 'markAnswer',
    onFailure: 'propagates',
    run: (llm) => markAnswer(pureDeps(llm), SECTION, 'the learner answered this'),
  },
  {
    name: 'rewriteAtDepth',
    onFailure: 'propagates',
    run: (llm) => rewriteAtDepth(pureDeps(llm), SECTION, 'fluent', 'Assume fluency.'),
  },
  {
    name: 'answerTangent',
    onFailure: 'propagates',
    run: (llm) => answerTangent(pureDeps(llm), 'but what about this?', {
      heading: SECTION.heading, register: 'building',
    }),
  },
  {
    name: 'handleCorrection',
    onFailure: 'propagates',
    run: (llm) => handleCorrection(
      pureDeps(llm), 'a claim we made', 'the source it came from', 'that is not right',
    ),
  },
  {
    name: 'quickTake',
    onFailure: 'degrades',
    run: (llm) => quickTake(pureDeps(llm), TAKE_INPUT),
  },
  {
    name: 'guideSteps',
    onFailure: 'degrades',
    run: (llm) => guideSteps(pureDeps(llm), TAKE_INPUT),
  },
  {
    name: 'explainStep',
    onFailure: 'degrades',
    run: (llm) => explainStep(pureDeps(llm), TAKE_INPUT, {
      action: 'do the thing', why: 'because of the reason',
    }),
  },
  {
    name: 'askAboutPin',
    onFailure: 'degrades',
    run: (llm) => askAboutPin(pureDeps(llm), TAKE_INPUT, 'why does that follow?'),
  },
  {
    name: 'review',
    onFailure: 'degrades',
    run: (llm) => review(pureDeps(llm), DRAFT, TOPICS, COMFORTS, null, []),
  },
  {
    name: 'markAssignment',
    onFailure: 'degrades',
    run: (llm) => markAssignment(
      pureDeps(llm),
      DRAFT,
      '1. States a target metric\n2. Cites three sources',
      TOPICS, COMFORTS, null, [],
    ),
  },
  {
    name: 'transcribePages',
    onFailure: 'degrades',
    run: (llm) => transcribePages(pureDeps(llm), PAGES),
  },
  {
    name: 'prospect',
    onFailure: 'degrades',
    run: (llm) => prospect(pureDeps(llm), {
      gaps: GAPS, now: '2026-08-24T09:00:00.000Z', batchKey: '2026-08-24',
      id: () => 'proposal-1',
    }),
  },
  {
    name: 'enrichCourseIntake',
    onFailure: 'degrades',
    run: (llm) => {
      let n = 0;
      return enrichCourseIntake(pureDeps(llm), intakeDraft(), () => `proposed-${++n}`);
    },
  },
  {
    name: 'markRecallAnswer',
    onFailure: 'propagates',
    run: (llm) => markRecallAnswer(pureDeps(llm), {
      heading: 'A saved topic', evidence: 'The saved evidence.', prompt: 'What mattered most?',
    }, 'The learner recalls the central idea.'),
  },
];

// ------------------------------------------------------------------ the rule

for (const agent of CASES) {
  test(`${agent.name} lets a refusal through`, async () => {
    await assert.rejects(
      agent.run(refusing()),
      (err: unknown) => err instanceof LlmRefused,
      'a call that was never issued must not be reported as one that failed',
    );
  });

  test(`${agent.name} lets a refusal SUBCLASS through`, async () => {
    await assert.rejects(
      agent.run(subclassRefusing()),
      (err: unknown) => err instanceof StubBudgetStop,
      'the product only ever throws a subclass; the base class is never seen in the wild',
    );
  });

  test(`${agent.name} still ${agent.onFailure === 'degrades' ? 'degrades' : 'propagates'} on an ordinary model failure`, async () => {
    if (agent.onFailure === 'degrades') {
      // No assertion on the SHAPE of the degraded value: each agent's own test
      // file holds that, and duplicating it here would make this file the place
      // an outcome name has to be changed in two.
      await agent.run(failing());
      return;
    }
    await assert.rejects(agent.run(failing()), (err: unknown) =>
      err instanceof Error && !(err instanceof LlmRefused));
  });
}

// -------------------------------------------------------------- the coverage

/**
 * The table is the whole fleet, checked against every exported model caller.
 *
 * The rule this file holds is only worth anything if it is applied everywhere,
 * and the failure mode is a function added later inside an already-listed agent
 * module. Comparing function names, rather than module names, keeps that gap
 * visible. `prompt-lint.test.ts` remains the registry of model-calling modules.
 */
test('every agent that talks to a model is in this table', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const lint = readFileSync(`${here}../../src/__tests__/prompt-lint.test.ts`, 'utf8');
  const linted = new Set(
    [...lint.matchAll(/^\s{4}module: '([a-z-]+)',$/gm)].map((m) => m[1] as string),
  );
  assert.ok(linted.size >= 13, 'the prompt registry was not read');

  const callers = [...linted].flatMap((module) => {
    const source = readFileSync(`${here}../../src/agents/${module}.ts`, 'utf8');
    const exported = [...source.matchAll(/^export async function (\w+)/gm)];
    return exported.flatMap((entry, index) => {
      const body = source.slice(entry.index, exported[index + 1]?.index ?? source.length);
      return /(?:deps\.llm|\bllm)\.(?:structured|complete)\s*[<(]/.test(body)
        ? [entry[1] as string] : [];
    });
  });
  assert.deepEqual([...new Set(CASES.map((c) => c.name))].sort(), [...new Set(callers)].sort(),
    'an exported model-calling function is missing from the refusal audit');
});
