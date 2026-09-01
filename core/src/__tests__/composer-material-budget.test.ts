import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MATERIAL_EXPANSION, MIN_SECTION_WORDS,
  budgetForMaterial, compose, materialWordsFor, pinMaterialWords, uniqueAssumedConcepts, wordBudgets,
} from '../agents/composer.js';
import type { PureDeps } from '../agents/deps.js';
import type { Llm, LlmRequest, LlmResult } from '../ports/llm.js';
import type { Enrichment, Pin, Topic } from '../domain/types.js';
import type { ComfortResult } from '../agents/registrar.js';
import type { GardenDecision } from '../agents/gardener.js';

/**
 * The Composer material-budget contract — the budget shrinks to the material.
 *
 * The three-register evidence run (`THREE_REGISTER_SESSION_2026-08-20.md`)
 * found this and called it structural rather than a bad roll. Clustering split
 * a single-pin `Voice Leading` topic; a topic with almost no evidence behind it
 * reads `from-nothing`; and `from-nothing` carries the heaviest weight in the
 * word budget (1.5 against 1.0 and 0.7). So the run handed **the largest
 * section on the board — about 900 words — to the topic with the least material
 * behind it**, and the model filled the gap the only way it could: it padded,
 * invented quoted annotations, and asserted a "three weeks" that was nowhere in
 * the material. The Verifier caught it and withheld the section, which is the
 * safety net doing its job and is not the same as the session being right.
 *
 * The run's own words: *"the Gardener ranks by comfort and the budget weights
 * by register, and neither asks how much material exists."* Now one of them
 * does. SB-23 already says refuse to pad; there was no mechanism that let it.
 *
 * What this is NOT: a refusal, a threshold, or a new piece of state. A thin
 * topic still gets taught — it gets a short section, which is what a learner
 * with one pin on a subject has actually earned. It degrades in one direction
 * only: the material budget is a CEILING under the register budget and can
 * never raise it, so no session gets longer than the register arithmetic said.
 */

// ------------------------------------------------------------- the fixtures

const clock = { now: () => new Date('2026-08-20T03:00:00Z') };

const llmSpy = (): { deps: PureDeps; prompts: string[] } => {
  const prompts: string[] = [];
  const llm: Llm = {
    complete: async () => { throw new Error('the composer does not use complete()'); },
    structured: async <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => {
      prompts.push(req.prompt);
      return {
        value: { sections: [], closingNote: 'one clause, another, a third' } as T,
        modelId: 'stub', inputTokens: 0, outputTokens: 0,
      };
    },
  };
  return { deps: { llm, clock }, prompts };
};

/** Enrichment carrying assumed concepts — the third thing the brief hands over. */
const assuming = (concepts: readonly string[]): Enrichment => ({
  refetchedText: null,
  assumedConcepts: [...concepts],
  mediaDescription: null,
  references: [],
  outcome: 'nothing-found',
  confidence: 'full',
  enrichedAt: '2026-08-19T03:00:00.000Z',
});

const pin = (id: string, topicId: string, over: Partial<Pin> = {}): Pin => ({
  id,
  type: 'interest',
  envelope: {
    selection: null,
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
  ...over,
});

/** A pin whose pinned text is exactly `words` words long. */
const pinOf = (id: string, topicId: string, words: number, over: Partial<Pin> = {}): Pin =>
  pin(id, topicId, {
    ...over,
    envelope: {
      ...pin(id, topicId).envelope,
      ...over.envelope,
      selection: over.envelope?.selection
        ?? Array.from({ length: words }, (_, i) => `${id}word${i}`).join(' '),
    },
  });

const topic = (id: string): Topic => ({
  id, label: `label of ${id}`, summary: `summary of ${id}`, pinIds: [],
  state: 'working', comfort: 0.5, lastExposedAt: null,
  retiredByUser: false, createdAt: '2026-08-01T00:00:00Z',
});

/** The three readings the evidence run's three registers came from. */
const READING: Record<'from-nothing' | 'building' | 'fluent', Omit<ComfortResult, 'topicId'>> = {
  // A topic with one pin and nothing to check it against: the certainty gate
  // does its job and the register is the shallowest one.
  'from-nothing': {
    comfort: 0.2, certainty: 0.2, regressed: false, evidenceCount: 1,
    demonstrationCount: 0, evidenceSignalIds: [],
  },
  'building': {
    comfort: 0.5, certainty: 0.8, regressed: false, evidenceCount: 4,
    demonstrationCount: 1, evidenceSignalIds: [],
  },
  'fluent': {
    comfort: 0.9, certainty: 0.8, regressed: false, evidenceCount: 4,
    demonstrationCount: 2, evidenceSignalIds: [],
  },
};

const decision = (topicId: string, priority: number): GardenDecision =>
  ({ topicId, disposition: 'teach', reason: 'never taught', priority });

/** The `length: about N words` line the brief writes, per section, in order. */
const briefedBudgets = (prompt: string): number[] =>
  [...prompt.matchAll(/^ {2}length: about (\d+) words$/gm)].map((m) => Number(m[1]));

// ------------------------------------------------------ the measure itself

test('SB-205: a five-minute slot takes the learner-requested topic before an inferred regression', async () => {
  const { deps, prompts } = llmSpy();
  const asked = topic('asked');
  const inferred = topic('inferred');
  await compose(deps, {
    topics: [asked, inferred],
    pins: [pinOf('p-asked', 'asked', 40), pinOf('p-inferred', 'inferred', 40)],
    comforts: [
      { topicId: 'asked', ...READING.building },
      { topicId: 'inferred', ...READING.building },
    ],
    decisions: [
      { topicId: 'inferred', disposition: 'resurface', reason: 'the product inferred a slip', priority: 100 },
      { topicId: 'asked', disposition: 'resurface', reason: 'you asked for this', priority: 110 },
    ],
    observations: [], knownAboutLearner: [], targetMinutes: 5, interfaceLanguage: 'en',
  });

  assert.match(prompts[0] ?? '', /TOPIC asked/);
  assert.doesNotMatch(prompts[0] ?? '', /TOPIC inferred/,
    'the one-section capacity was spent on the machine inference instead of the learner request');
});

test('a pin brings the words the brief actually hands over, and no others', () => {
  // Three things reach the model per pin: the pinned text, the learner's note,
  // and the concepts the pin assumes they already know. The third counts
  // because a from-nothing section has to TEACH those concepts — they are
  // surface to cover, not decoration — and because a topic whose pins never
  // enriched has genuinely less in front of the model than one whose did.
  const bare = pinOf('p1', 'T1', 20);
  assert.equal(pinMaterialWords(bare), 20);

  const noted = pinOf('p2', 'T1', 20, { note: 'why does this need an index at all' });
  assert.equal(pinMaterialWords(noted), 28);

  const enriched = pinOf('p3', 'T1', 20, { enrichment: assuming(['composite index', 'query planner']) });
  assert.equal(pinMaterialWords(enriched), 24);

  assert.equal(materialWordsFor([bare, noted, enriched]), 68,
    'only distinct source text and learner notes buy lesson length');
  assert.equal(materialWordsFor([]), 0);
});

test('repeated captures do not buy repeated lesson length', () => {
  const first = pinOf('p1', 'T1', 3, { enrichment: assuming(['fulcrum', 'stick rebound']) });
  const repeat = pinOf('p2', 'T1', 3, {
    enrichment: assuming(['Fulcrum (a pivot point)', 'stick rebound']),
    envelope: { ...pin('p2', 'T1').envelope, selection: first.envelope.selection },
  });
  const distinct = pinOf('p3', 'T1', 2, { enrichment: assuming(['power and control']) });

  assert.equal(materialWordsFor([first, repeat, distinct]), 5);
  assert.deepEqual(uniqueAssumedConcepts([first, repeat, distinct]),
    ['fulcrum', 'stick rebound', 'power and control']);
});

test('the Composer states shared prerequisites once, outside each pin row', async () => {
  const { deps, prompts } = llmSpy();
  await compose(deps, {
    topics: [topic('T1')],
    pins: [
      pinOf('p1', 'T1', 20, { enrichment: assuming(['fulcrum']) }),
      pinOf('p2', 'T1', 20, { enrichment: assuming(['Fulcrum (a pivot point)']) }),
    ],
    comforts: [{ topicId: 'T1', ...READING['from-nothing'] }],
    decisions: [decision('T1', 90)], observations: [], knownAboutLearner: [],
    targetMinutes: 5, interfaceLanguage: 'en',
  });
  const prompt = prompts[0] ?? '';
  assert.equal((prompt.match(/possible prerequisites inferred by enrichment/g) ?? []).length, 1);
  assert.equal((prompt.match(/fulcrum/gi) ?? []).length, 1,
    'the same prerequisite was repeated once per capture');
});

test('one thin physical topic builds its grounded handoff without a model call', async () => {
  const { deps, prompts } = llmSpy();
  const base = pin('p1', 'T1');
  const physical = {
    ...base,
    envelope: {
      ...base.envelope,
      selection: 'American grip',
      surroundingText: 'For an American grip, keep your palms facing down, your elbows relaxed, and the sticks at a 45-degree angle.',
    },
  };
  const out = await compose(deps, {
    topics: [{ ...topic('T1'), label: 'Drumming Techniques' }],
    pins: [physical],
    comforts: [{ topicId: 'T1', ...READING['from-nothing'] }],
    decisions: [decision('T1', 90)], observations: [], knownAboutLearner: [],
    targetMinutes: 5, interfaceLanguage: 'en',
  });

  assert.deepEqual(prompts, [], 'a deterministic lesson must not wait for a discarded generation');
  assert.equal(out.sections.length, 1);
  assert.equal(out.sections[0]?.heading, 'Drumming Techniques',
    'the heading is the thing being learned: the qualifier left on 2026-08-29');
  assert.match(out.sections[0]?.body ?? '', /keep your palms facing down/i);
  assert.equal(out.sections[0]?.actionMinutes, 1);
  assert.deepEqual(out.sections[0]?.question?.expectedPoints, []);
  assert.equal(out.estimatedMinutes, 2);
});

/**
 * NO LESSON IS HEADED BY A CLAUSE ABOUT ITSELF.
 *
 * Both suffixes the Composer could emit are gone — the deterministic
 * thin-medium one above, and
 * the repair that fired when a model heading promised a timing the practice
 * cannot keep. The topic label IS the heading; the panel supplies orientation
 * as the subject family over the area of the subject, which is true of every
 * lesson rather than bolted onto the name of one.
 */
test('a repaired medium heading is the topic label, not a clause about the lesson', async () => {
  const written = {
    topicId: 'T1', heading: 'Try this for thirty seconds', body: 'Hold the sticks and listen.',
    estimatedMinutes: 3, question: null, sourceIds: ['p1'],
    mediumWarning: 'This is a skill your hands have to learn.',
    recap: 'Try it for thirty seconds.', summary: 'Ten minutes of practice.',
  };
  const deps: PureDeps = {
    clock,
    llm: {
      complete: async () => { throw new Error('the composer does not use complete()'); },
      structured: async <T>(): Promise<LlmResult<T>> => ({
        value: { sections: [written], closingNote: 'one clause, another, a third' } as T,
        modelId: 'stub', inputTokens: 0, outputTokens: 0,
      }),
    },
  };
  // Enough material that the deterministic thin-medium path is not taken, so
  // this exercises the repair branch rather than the fixed copy above.
  const base = pin('p1', 'T1');
  const wordy = {
    ...base,
    envelope: {
      ...base.envelope,
      selection: 'American grip',
      surroundingText: `${'Hold the stick loosely and let it rebound off the head. '.repeat(20)}`,
    },
  };
  const out = await compose(deps, {
    topics: [{ ...topic('T1'), label: 'Drumming Techniques' }],
    pins: [wordy],
    comforts: [{ topicId: 'T1', ...READING['from-nothing'] }],
    decisions: [decision('T1', 90)], observations: [], knownAboutLearner: [],
    targetMinutes: 5, interfaceLanguage: 'en',
  });
  assert.equal(out.sections[0]?.heading, 'Drumming Techniques');
  for (const built of out.sections) {
    assert.doesNotMatch(built.heading, /: (?:getting set up|what to try|source-backed)/i,
      'a lesson is headed by what it teaches, never by a clause about itself');
  }
});

test('the material measure is capped exactly where the brief caps it', () => {
  // The brief slices the pinned text at 700 characters and the note at 300. A
  // measure that counted the uncapped text would budget for material the model
  // is never shown, which is the same fault in a new place.
  const long = pinOf('p1', 'T1', 400, { note: 'x '.repeat(400) });
  const shown = pinMaterialWords(long);
  assert.ok(shown < 400, `the measure counted ${shown} words of a text the brief truncates`);
});

// ------------------------------------------------------------- the scaling

test('the budget is the register budget or what the material earns, whichever is smaller', () => {
  // One-directional by construction. The register weighting decided how long a
  // section MAY be; material can only take room away, never add it, so no
  // session composed under this rule reads longer than it did before.
  assert.equal(budgetForMaterial(904, 10_000), 904, 'material can never buy more than the register allows');
  assert.equal(budgetForMaterial(904, 66), 231, '66 words of material earns 231, not 904');
  assert.equal(budgetForMaterial(422, 63), 221);
});

test('a thin topic is floored at a length a short honest section can use', () => {
  // Not a refusal and not a stub. 150 words at the from-nothing reading rate is
  // about eighty seconds: an analogy, one term defined, one claim made. Below
  // that a section is a sentence, and a sentence should have been a suggestion.
  assert.equal(MIN_SECTION_WORDS, 150);
  assert.equal(budgetForMaterial(904, 0), MIN_SECTION_WORDS);
  assert.equal(budgetForMaterial(904, 12), MIN_SECTION_WORDS);
  // Except where the register budget is itself smaller — the floor may not
  // raise a budget above the ceiling it sits under.
  assert.equal(budgetForMaterial(40, 0), 40);
  assert.ok(budgetForMaterial(0.4, 0) >= 1, 'a budget of zero words is not an instruction');
});

test('the expansion is the one the reference board calibrated', () => {
  // 3.5 is not a taste. The best-evidenced topic on the three-register board —
  // IAM Conditions, four pins, 277 words of material — needs 3.27 to keep the
  // full 904-word from-nothing budget it had before this change. 3.5 is the
  // legible number above that, so the rule is invisible on a well-fed topic and
  // only bites where the run found it biting.
  assert.equal(MATERIAL_EXPANSION, 3.5);
  assert.equal(budgetForMaterial(904, 277), 904, 'the best-fed topic on the board keeps its budget exactly');
  assert.ok(904 / 277 < MATERIAL_EXPANSION);
});

// -------------------------------------------- the evidence run's exact shape

test("the evidence run's one-pin from-nothing topic is no longer handed 900 words", async () => {
  // Attempt 1, reproduced: a single-pin `Voice Leading` topic beside a four-pin
  // `Music Theory Fundamentals` and a two-pin `Firestore Querying`, fifteen
  // minutes, three sections. The from-nothing slot went to the topic with one
  // pin behind it and was budgeted about 900 words.
  const { deps, prompts } = llmSpy();
  const voiceLeading = pinOf('p-voice-1', 'T-voice', 24, {
    enrichment: assuming(['voice leading', 'chord tone', 'inversion', 'register', 'the tritone', 'guide tones',
      'dominant function', 'resolution', 'a seventh chord', 'close voicing', 'open voicing', 'the third',
      'the seventh', 'the root', 'chromatic descent', 'a low interval limit', 'muddiness', 'a piano voicing',
      'stepwise motion', 'common tone', 'leading tone']),
  });
  const music = [1, 2, 3, 4].map((n) => pinOf(`p-music-${n}`, 'T-music', 40, {
    enrichment: assuming(['a major third', 'a minor third', 'semitones', 'tertian construction',
      'a seventh chord', 'the augmented triad', 'an interval', 'the chromatic scale',
      'a tritone', 'substitution', 'guide tones', 'a dominant chord']),
  }));
  const firestore = [1, 2].map((n) => pinOf(`p-fire-${n}`, 'T-fire', 16, {
    enrichment: assuming(['a composite index', 'an inequality filter', 'orderBy', 'the index build']),
  }));

  const topics = [topic('T-voice'), topic('T-music'), topic('T-fire')];
  await compose(deps, {
    topics,
    pins: [voiceLeading, ...music, ...firestore],
    comforts: [
      { topicId: 'T-voice', ...READING['from-nothing'] },
      { topicId: 'T-music', ...READING['building'] },
      { topicId: 'T-fire', ...READING['fluent'] },
    ],
    // Priorities put them in the order the run composed them.
    decisions: [decision('T-voice', 90), decision('T-music', 80), decision('T-fire', 70)],
    observations: [],
    knownAboutLearner: [],
    targetMinutes: 15,
    interfaceLanguage: 'en',
  });

  const brief = prompts[0] ?? '';
  const budgeted = briefedBudgets(brief);
  const registerOnly = wordBudgets(13, ['from-nothing', 'building', 'fluent']);
  assert.deepEqual(registerOnly, [783, 522, 366],
    'two minutes are reserved for the two learner actions');

  const [thin, wellFed, fluent] = budgeted as [number, number, number];
  assert.equal(thin, MIN_SECTION_WORDS,
    `the one-pin topic was budgeted ${thin} words; inferred prerequisites cannot buy prose`);
  assert.ok(thin < registerOnly[0]! / 3, 'a topic with one pin does not get a third of a nine-hundred-word section');

  // And the well-fed topic beside it is untouched relative to the reading
  // budget. The two learner actions have their own time rather than silently
  // extending the session.
  assert.equal(wellFed, registerOnly[1], 'a four-pin topic keeps its register budget exactly');
  assert.ok(brief.includes(`  length: about ${registerOnly[1]} words`));

  // The two-pin fluent topic sits between them, which is the whole point of a
  // scale rather than a threshold.
  assert.ok(fluent < registerOnly[2]! && fluent >= MIN_SECTION_WORDS);
});

test('a well-fed session spends its reading budget exactly after reserving action time', async () => {
  // Material does not shrink any section on this path. The only difference
  // from the old register budget is the explicit two-minute action reserve.
  const { deps, prompts } = llmSpy();
  const fat = (t: string) => [1, 2, 3, 4, 5].map((n) => pinOf(`${t}-${n}`, t, 60));
  const topics = [topic('T1'), topic('T2'), topic('T3')];
  await compose(deps, {
    topics,
    pins: [...fat('T1'), ...fat('T2'), ...fat('T3')],
    comforts: [
      { topicId: 'T1', ...READING['from-nothing'] },
      { topicId: 'T2', ...READING['building'] },
      { topicId: 'T3', ...READING['fluent'] },
    ],
    decisions: [decision('T1', 90), decision('T2', 80), decision('T3', 70)],
    observations: [],
    knownAboutLearner: [],
    targetMinutes: 15,
    interfaceLanguage: 'en',
  });
  assert.deepEqual(briefedBudgets(prompts[0] ?? ''), wordBudgets(13, ['from-nothing', 'building', 'fluent']));
});

test('a topic with no pins at all is still taught, at the floor', async () => {
  // Degrades gracefully, which the Composer material-budget contract asks for in as many words. A topic the
  // Gardener chose and the Clusterer left empty is a state the pipeline can
  // reach, and the answer is a short section rather than a crash or a refusal.
  const { deps, prompts } = llmSpy();
  await compose(deps, {
    topics: [topic('T1')],
    pins: [],
    comforts: [{ topicId: 'T1', ...READING['from-nothing'] }],
    decisions: [decision('T1', 90)],
    observations: [],
    knownAboutLearner: [],
    targetMinutes: 15,
    interfaceLanguage: 'en',
  });
  assert.deepEqual(briefedBudgets(prompts[0] ?? ''), [MIN_SECTION_WORDS]);
});
