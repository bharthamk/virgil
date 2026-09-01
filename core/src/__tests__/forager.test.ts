import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FORAGE_BATCH, forage, forageBatch, languageMatches, owedEnrichment, primaryLanguage } from '../agents/forager.js';
import type { Deps } from '../agents/deps.js';
import type { Enrichment, Pin } from '../domain/types.js';
import type { Llm, LlmRequest, LlmResult } from '../ports/llm.js';
import type { Research } from '../ports/research.js';

/**
 * What the Forager says happened, as opposed to what it produced.
 *
 * Measured on two live runs: 19 of 21 model calls failed on one, and 69 of 71
 * enriched pins carried an empty assumed-concepts list on the other. Both left
 * the same record — `assumedConcepts: []` — and the stage's failure counter saw
 * neither, because Forager catches its own error and degrades to the capture
 * envelope on purpose. The degrade is right; being unable to tell afterwards
 * which of the two happened is not.
 */

const clock = { now: () => new Date('2026-08-19T03:00:00Z') };

const research = (over: Partial<Research> = {}): Research => ({
  fetchPage: async () => null,
  findReferences: async () => [],
  hasGrounding: false,
  ...over,
});

/** Answers the Forager's one structured call however the test says. */
const llmThat = (answer: (req: LlmRequest) => unknown): Llm => ({
  complete: async () => { throw new Error('the forager does not use complete()'); },
  structured: async <T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> => ({
    value: answer(req) as T, modelId: 'stub', inputTokens: 0, outputTokens: 0,
  }),
});

const deps = (llm: Llm, r: Research = research()): Deps => ({
  llm,
  clock,
  research: r,
  // Neither is reachable from `forage`, and a call to one would be the defect.
  store: new Proxy({}, { get: () => () => { throw new Error('forage must not touch the store'); } }) as Deps['store'],
  embedder: { modelId: 'unused', embed: async () => { throw new Error('forage must not embed'); } },
});

const pin = (over: Partial<Pin> = {}): Pin => ({
  id: 'p-429-1',
  type: 'interest',
  envelope: {
    selection: 'Pull subscriptions use a subscriber client',
    parts: [],
    surroundingText: 'the paragraph around the selection, in ordinary English prose',
    headingPath: ['Docs', 'Pub/Sub'],
    pageTitle: 'Pull subscriptions',
    url: 'https://example.test/doc',
    canonicalUrl: null,
    siteName: null,
    contentLanguage: null,
    media: null,
    ...over.envelope,
  },
  note: null,
  capturedAt: '2026-08-01T00:00:00Z',
  fromSuggestion: false,
  enrichment: null,
  topicId: null,
  ...over,
});

const enrichment = (over: Partial<Enrichment> = {}): Enrichment => ({
  refetchedText: null,
  assumedConcepts: [],
  mediaDescription: null,
  references: [],
  outcome: 'enriched',
  confidence: 'reduced',
  enrichedAt: '2026-08-19T03:00:00.000Z',
  ...over,
});

// ---------------------------------------------------------------- the three outcomes

test('a model that answers with concepts is recorded as enriched', async () => {
  const out = await forage(
    deps(llmThat(() => ({ assumedConcepts: ['ack deadline', 'at-least-once delivery'], mediaDescription: null }))),
    { pin: pin() });

  assert.equal(out.outcome, 'enriched');
  assert.deepEqual([...out.assumedConcepts], ['ack deadline', 'at-least-once delivery']);
});

test('a model that answers with nothing is recorded as nothing-found, not as a failure', async () => {
  // The prompt asks for an empty list when the passage is self-contained, so
  // this is a real answer and must not be reported as the model being down.
  const out = await forage(
    deps(llmThat(() => ({ assumedConcepts: [], mediaDescription: null }))),
    { pin: pin() });

  assert.equal(out.outcome, 'nothing-found');
  assert.deepEqual([...out.assumedConcepts], []);
});

test('a model call that throws is recorded as model-failed, and the pin still comes back teachable', async () => {
  const out = await forage(
    deps(llmThat(() => { throw new Error('ollama is not running'); })),
    { pin: pin() });

  assert.equal(out.outcome, 'model-failed');
  assert.deepEqual([...out.assumedConcepts], [],
    'the degrade is unchanged — enrichment is an improvement, never a gate');
  assert.equal(out.references.length, 1, 'the pin\'s own page is still a source');
  assert.equal(out.enrichedAt, '2026-08-19T03:00:00.000Z');
});

test('model-failed and nothing-found differ ONLY in the outcome, which is why it had to exist', async () => {
  // The defect this field was added for: without `outcome` these two records are
  // byte-identical, so a store full of swallowed failures reads as a store full
  // of self-contained passages.
  const failed = await forage(deps(llmThat(() => { throw new Error('down'); })), { pin: pin() });
  const empty = await forage(
    deps(llmThat(() => ({ assumedConcepts: [], mediaDescription: null }))), { pin: pin() });

  assert.notEqual(failed.outcome, empty.outcome);
  assert.deepEqual({ ...failed, outcome: null }, { ...empty, outcome: null },
    'every other field really is the same — the outcome is the whole difference');
});

test('a media description alone counts as enriched', async () => {
  // An image pin whose only useful answer is what the picture shows has been
  // enriched, even with no prerequisites named.
  const withMedia = pin({ envelope: { ...pin().envelope, media: { kind: 'image', ref: 'data:,x' } } });
  const out = await forage(
    deps(llmThat(() => ({ assumedConcepts: [], mediaDescription: 'a fan-out diagram' }))),
    { pin: withMedia });

  assert.equal(out.outcome, 'enriched');
  assert.equal(out.mediaDescription, 'a fan-out diagram');
});

test('the pinned image reaches the model as an image, in the form the adapters unwrap', async () => {
  // SB-09's other half, and the one that was never true. The capture path now
  // stores the bytes as a data URI (`extension/src/image.ts`), and this is where
  // they have to arrive: on `LlmRequest.media`, wrapped the way both adapters
  // parse — `stripDataUri` in the Ollama adapter, `splitDataUri` in the Gemini
  // one. While the extension stored `info.srcUrl`, what got here was the
  // literal text of a url and both adapters passed it through as though it were
  // base64. The pin looked complete and the vision call described nothing.
  const ref = 'data:image/png;base64,iVBORw0KGgo=';
  const seen: LlmRequest[] = [];
  const out = await forage(
    deps(llmThat((req) => {
      seen.push(req);
      return { assumedConcepts: [], mediaDescription: 'a fan-out diagram' };
    })),
    { pin: pin({ envelope: { ...pin().envelope, media: { kind: 'image', ref } } }) },
  );

  assert.deepEqual(seen[0]?.media, [{ kind: 'image', ref }]);
  assert.match(ref, /^data:[^;]+;base64,.+$/, 'the adapters cannot unwrap anything else');
  assert.ok(seen[0]?.prompt.includes('An image was pinned with this'),
    'a vision model sent a picture and not asked about it answers about the text');
  assert.equal(out.mediaDescription, 'a fan-out diagram');
});

test('a pin whose image could not be taken sends no image and pays for no vision call', async () => {
  // The fail-closed path from capture, read from this end. `mediaOmitted` says
  // why there is no picture; what matters here is that there is no `media` on
  // the request at all, so the adapter routes to the text model.
  const seen: LlmRequest[] = [];
  await forage(
    deps(llmThat((req) => {
      seen.push(req);
      return { assumedConcepts: ['fan-out'], mediaDescription: null };
    })),
    { pin: pin({ envelope: { ...pin().envelope, media: null, mediaOmitted: 'fetch-failed' } }) },
  );

  assert.equal(seen[0]?.media, undefined);
  assert.ok(!seen[0]?.prompt.includes('An image was pinned with this'));
});

test('a failed call reports nothing about the media either', async () => {
  const withMedia = pin({ envelope: { ...pin().envelope, media: { kind: 'image', ref: 'data:,x' } } });
  const out = await forage(deps(llmThat(() => { throw new Error('down'); })), { pin: withMedia });

  assert.equal(out.outcome, 'model-failed');
  assert.equal(out.mediaDescription, null);
});

// ------------------------------------------------ the outcome is not the re-fetch axis

test('a good re-fetch and a failed model call are recorded on separate axes', async () => {
  // `confidence` says whether the page came back; `outcome` says whether the
  // model answered. Collapsing them would make one of the two unreportable.
  const page = { text: `${'filler word '.repeat(400)}Pull subscriptions use a subscriber client and more prose.`, title: 't' };
  const out = await forage(
    deps(llmThat(() => { throw new Error('down'); }), research({ fetchPage: async () => page })),
    { pin: pin() });

  assert.equal(out.confidence, 'full', 'the page was fetched and the selection found in it');
  assert.equal(out.outcome, 'model-failed', 'and the model still did not answer');
});

test('a failed re-fetch with a good model call is enriched at reduced confidence', async () => {
  const out = await forage(
    deps(llmThat(() => ({ assumedConcepts: ['ack deadline'], mediaDescription: null })),
      research({ fetchPage: async () => null })),
    { pin: pin() });

  assert.equal(out.confidence, 'reduced');
  assert.equal(out.outcome, 'enriched');
});

// ------------------------------------------------------------- re-eligibility

test('a model-failed pin is owed another attempt and a nothing-found pin is not', () => {
  assert.equal(owedEnrichment(pin({ enrichment: null })), true, 'never enriched');
  assert.equal(owedEnrichment(pin({ enrichment: enrichment({ outcome: 'model-failed' }) })), true,
    'the question was never answered, so it is asked again');
  assert.equal(owedEnrichment(pin({ enrichment: enrichment({ outcome: 'nothing-found' }) })), false,
    'the model answered — re-asking nightly buys the same answer at full price for ever');
  assert.equal(owedEnrichment(pin({ enrichment: enrichment({ outcome: 'enriched' }) })), false);
});

test('an enrichment written before the outcome field existed is left alone', () => {
  // Reading a store from yesterday must not put every old pin back through the
  // model on the first run after this change.
  const legacy = { ...enrichment() } as Record<string, unknown>;
  delete legacy['outcome'];
  assert.equal(owedEnrichment(pin({ enrichment: legacy as unknown as Enrichment })), false);
});

// ------------------------------------------------- SB-48: the language guard

/**
 * The guard this replaces opened with `if (!expected.startsWith('en')) return
 * true`, so a Spanish pin re-fetched in English passed without a murmur. SB-48's
 * whole demand is that nothing in the pipeline assumes English, and D9 is the
 * defect it protects against — a vendor serving the nightly re-fetch a different
 * localisation from the one the learner read.
 *
 * Every pin below is a whole-page pin, so the selection is always locatable and
 * the LANGUAGE CHECK is the only thing that can reduce the confidence.
 */

const answers = () => llmThat(() => ({ assumedConcepts: [], mediaDescription: null }));

const EN_TEXT = 'Pull subscriptions use a subscriber client that is responsible for the connection to the service, and the client asks for the messages that are held on the topic until they are acknowledged by it. ';
const ES_TEXT = 'Las suscripciones de extracción usan un cliente suscriptor que se encarga de la conexión con el servicio, y el cliente pide los mensajes que se guardan en el tema hasta que se confirman por él. ';
const PT_TEXT = 'As subscrições de extração usam um cliente assinante que é responsável pela ligação ao serviço, e o cliente pede as mensagens que são guardadas no tópico até que sejam confirmadas por ele. ';
const CODE_TEXT = 'const client = new SubscriberClient(); function pull(a, b) { return client.pull(a, b); } export default pull; ';

const page = (text: string) => ({ text: text.repeat(20), title: 'a page' });

/** A whole-page pin (SB-07) captured in `lang`, re-fetched as `text`. */
const refetched = async (lang: string | null, text: string): Promise<Enrichment> => forage(
  deps(answers(), research({ fetchPage: async () => page(text) })),
  { pin: pin({ envelope: { ...pin().envelope, selection: null, contentLanguage: lang } }) },
);

test('SB-48: a re-fetch in the language the pin was captured in is used', async () => {
  const out = await refetched('en', EN_TEXT);
  assert.equal(out.confidence, 'full');
  assert.ok(out.refetchedText, 'the re-fetched page is what the Composer teaches from');
});

test('SB-48: the mismatch is caught in BOTH directions, not only for English pins', async () => {
  // The drift, stated as a test. The first assertion passed before this change;
  // the second is the one SB-48 exists for and it did not.
  const englishPinServedSpanish = await refetched('en', ES_TEXT);
  const spanishPinServedEnglish = await refetched('es', EN_TEXT);

  assert.equal(englishPinServedSpanish.confidence, 'reduced');
  assert.equal(englishPinServedSpanish.refetchedText, null,
    'D9: the capture envelope is the version the learner actually read');
  assert.equal(spanishPinServedEnglish.confidence, 'reduced',
    'a Spanish pin is owed the same guard, which is the whole of SB-48');
  assert.equal(spanishPinServedEnglish.refetchedText, null);
});

test('SB-48: a regional tag is the same language as its primary subtag', async () => {
  // pt-BR and pt are the same language for this purpose. The guard is against
  // being served a different LANGUAGE, not a different regional edition.
  assert.equal((await refetched('pt-BR', PT_TEXT)).confidence, 'full');
  assert.equal((await refetched('en-US', EN_TEXT)).confidence, 'full');
  assert.equal((await refetched('pt-BR', ES_TEXT)).confidence, 'reduced',
    'Portuguese and Spanish share function words; they are still not the same page');
});

test('SB-48: a pin with no captured language cannot be checked, and is not penalised for it', async () => {
  // Absent on the pin's side. Marking this down would degrade every pin from a
  // page that declares nothing, which is most of them.
  assert.equal((await refetched(null, ES_TEXT)).confidence, 'full');
});

test('SB-48: a page whose language cannot be read is not treated as a mismatch', async () => {
  // Absent on the page's side. A code listing scores on nothing in particular,
  // and "I cannot tell" is not evidence of a localisation swap.
  assert.equal((await refetched('en', CODE_TEXT)).confidence, 'full');
});

test('SB-48: und and zxx are ways of saying "unknown", and are read as absent', async () => {
  // BCP-47's undetermined and no-linguistic-content tags. Treating either as a
  // language would make a page that declares nothing mismatch with everything.
  assert.equal((await refetched('und', ES_TEXT)).confidence, 'full');
  assert.equal((await refetched('zxx', ES_TEXT)).confidence, 'full');
});

test('SB-48: a language the check does not model is never reported as a mismatch', async () => {
  // The honest limit of a function-word heuristic, and the direction the
  // mistake must fall in: a Japanese pin is not degraded for being Japanese.
  assert.equal((await refetched('ja', EN_TEXT)).confidence, 'full');
});

test('a tag and a page that both say nothing leave the confidence alone', () => {
  assert.equal(primaryLanguage(null), null);
  assert.equal(primaryLanguage('  '), null);
  assert.equal(primaryLanguage('en-GB'), 'en');
  assert.equal(primaryLanguage('PT_br'), 'pt');
  assert.equal(primaryLanguage('und'), null);
  assert.equal(languageMatches('', 'en'), true, 'no text to read is not a mismatch');
});

// ------------------------------------------ SB-51: the page changed under me

/**
 * The bug this exists for was real and is named in the story: the first
 * implementation, when it could not find the pinned selection in the re-fetched
 * page, returned the first 3000 characters — which on a 72,000-word spec is the
 * table of contents. The learner was then taught a heading list as though it
 * were what they had pinned.
 *
 * So the assertion that matters is not "confidence went down". It is that the
 * text handed to the model is what the learner actually captured, and that the
 * top of the changed page is nowhere in it.
 */

/** Answers as usual, and keeps the prompt so a test can read what was taught from. */
const capturing = (): { llm: Llm; prompts: string[] } => {
  const prompts: string[] = [];
  return {
    prompts,
    llm: llmThat((req) => {
      prompts.push(req.prompt);
      return { assumedConcepts: [], mediaDescription: null };
    }),
  };
};

const CONTENTS = 'Contents Introduction Overview Getting started Reference Appendix A Appendix B Glossary Index. ';
const REWRITTEN = 'The vendor has rewritten this page and the paragraph the learner read is no longer anywhere on it, though the page is long and healthy and returns two hundred. ';

test('SB-51: a page that no longer says what the learner read is not taught from', async () => {
  const { llm, prompts } = capturing();
  const out = await forage(
    deps(llm, research({ fetchPage: async () => ({ text: CONTENTS.repeat(10) + REWRITTEN.repeat(20), title: 't' }) })),
    { pin: pin() },
  );

  assert.equal(out.refetchedText, null, 'nothing from the changed page is kept as the source');
  assert.equal(out.confidence, 'reduced', 'and the Composer is told to narrow its claims');
  assert.match(prompts[0]!, /the paragraph around the selection, in ordinary English prose/,
    'what it teaches from is the envelope captured at pin time');
  assert.doesNotMatch(prompts[0]!, /Contents Introduction Overview/,
    'the measured defect: an arbitrary slice of a long document is its table of contents');
});

test('SB-51: an anchored re-fetch is still the better source, and is read around the selection', async () => {
  const selection = pin().envelope.selection!;
  const { llm, prompts } = capturing();
  const out = await forage(
    // The selection sits well past the opening, so a window centred on it and a
    // window taken from the top are distinguishable.
    deps(llm, research({
      fetchPage: async () => ({
        text: `${CONTENTS.repeat(40)}${selection} and the argument that follows it. ${REWRITTEN.repeat(10)}`,
        title: 't',
      }),
    })),
    { pin: pin() },
  );

  assert.equal(out.confidence, 'full');
  assert.ok(out.refetchedText?.includes(selection), 'the re-fetched text is kept as the source');
  assert.match(prompts[0]!, /and the argument that follows it/,
    'read around the selection, which is the whole point of the re-fetch');
});

test('SB-51: a whole-page pin has no anchor to lose, so the top of the page is the right answer', async () => {
  // Anchor failure is a property of a selection pin. A page pin (SB-07) never
  // had a selection to locate, and must not be degraded as though it had.
  const { llm } = capturing();
  const out = await forage(
    deps(llm, research({ fetchPage: async () => ({ text: REWRITTEN.repeat(30), title: 't' }) })),
    { pin: pin({ envelope: { ...pin().envelope, selection: null } }) },
  );
  assert.equal(out.confidence, 'full');
  assert.ok(out.refetchedText?.startsWith('The vendor has rewritten'));
});

test('SB-51: the pin\'s own page is cited either way, "as it read when you pinned it"', async () => {
  // The source record is written before the re-fetch is attempted, so a page
  // that changed, a page behind a login and a page that fetched cleanly all
  // still cite where the material came from and when it was captured.
  const { llm } = capturing();
  const out = await forage(
    deps(llm, research({ fetchPage: async () => ({ text: REWRITTEN.repeat(20), title: 't' }) })),
    { pin: pin() },
  );
  assert.equal(out.confidence, 'reduced');
  assert.deepEqual(out.references.map((r) => [r.origin, r.url, r.retrievedAt]),
    [['user-pin', 'https://example.test/doc', '2026-08-01T00:00:00Z']]);
});

// ------------------------------------------------------- one call, many pins

/**
 * **The term that grows with the learner.**
 *
 * Forager calls scale with the number of pins, so batching must reduce model
 * calls without allowing content from one passage to influence another.
 *
 * So the pins are asked about together. Not all of them: `FORAGE_BATCH` bounds
 * a chunk, because two things get worse as a prompt grows and neither is
 * cosmetic. **One is blast radius** — the Forager's isolation was a security
 * property, not tidiness, and every extra passage in a prompt is another piece
 * of untrusted text that could speak about its neighbours. **The other is a
 * failed call**, which now costs a chunk rather than a pin. Bounded, both stay
 * small, and the reduction is still most of what one call per pin was costing.
 */
test('a batch asks about several pins in one call and answers each of them', async () => {
  const seen: LlmRequest[] = [];
  const llm = llmThat((req) => {
    seen.push(req);
    return {
      enrichments: [
        { pin: 'p1', assumedConcepts: ['queues'], mediaDescription: null },
        { pin: 'p2', assumedConcepts: ['indexes', 'query planning'], mediaDescription: null },
        { pin: 'p3', assumedConcepts: [], mediaDescription: null },
      ],
    };
  });
  const pins = [pin({ id: 'a' }), pin({ id: 'b' }), pin({ id: 'c' })];
  const out = await forageBatch(deps(llm), { pins });

  assert.equal(seen.length, 1, 'three pins, one call — that is the whole point');
  assert.deepEqual([...out.keys()], ['a', 'b', 'c']);
  assert.deepEqual([...out.get('a')!.assumedConcepts], ['queues']);
  assert.deepEqual([...out.get('b')!.assumedConcepts], ['indexes', 'query planning']);
  assert.equal(out.get('a')?.outcome, 'enriched');
  assert.equal(out.get('c')?.outcome, 'nothing-found',
    'an empty list is still a real answer, and still retires the pin from enrichment');
});

test('a pin the model left out of its reply is owed another attempt, not silently emptied', async () => {
  // The batch's one genuinely new failure mode. A reply that answers two of
  // three must not retire the third: `nothing-found` tells the store the pin
  // has been read and needs nothing, and a pin nobody answered has not been.
  const llm = llmThat(() => ({
    enrichments: [{ pin: 'p1', assumedConcepts: ['queues'], mediaDescription: null }],
  }));
  const out = await forageBatch(deps(llm), { pins: [pin({ id: 'a' }), pin({ id: 'b' })] });
  assert.equal(out.get('a')?.outcome, 'enriched');
  assert.equal(out.get('b')?.outcome, 'model-failed', 'unanswered is owed, never "nothing found"');
  assert.deepEqual([...out.get('b')!.assumedConcepts], []);
});

test('a batch call that throws costs the chunk and no more', async () => {
  const llm: Llm = {
    complete: async () => { throw new Error('unused'); },
    structured: async () => { throw new Error('the model is down'); },
  };
  const out = await forageBatch(deps(llm), { pins: [pin({ id: 'a' }), pin({ id: 'b' })] });
  assert.deepEqual([...out.values()].map((e) => e.outcome), ['model-failed', 'model-failed']);
  assert.deepEqual([...out.values()].map((e) => e.enrichedAt),
    ['2026-08-19T03:00:00.000Z', '2026-08-19T03:00:00.000Z'],
    'still a real enrichment record, so the failure is written down rather than lost');
});

test('more pins than a chunk holds is more calls, and the chunk is what bounds them', async () => {
  const seen: LlmRequest[] = [];
  const llm = llmThat((req) => {
    seen.push(req);
    return { enrichments: [] };
  });
  const pins = Array.from({ length: FORAGE_BATCH * 2 + 1 }, (_, i) => pin({ id: `p${i}` }));
  await forageBatch(deps(llm), { pins });
  assert.equal(seen.length, 3, 'two full chunks and the remainder');
});

test('every passage in a batch is fenced separately', async () => {
  /**
   * The isolation the single-pin Forager had by construction, kept explicitly.
   *
   * One learner's pinned page can contain text addressed at a model. Alone,
   * that text could only damage its own pin's enrichment. Together, the fence
   * around each passage is the only thing keeping it from being read as
   * instructions about its neighbours — so there is one fence per passage, and
   * the count is asserted rather than assumed.
   */
  let prompt = '';
  const llm = llmThat((req) => { prompt = req.prompt; return { enrichments: [] }; });
  await forageBatch(deps(llm), { pins: [pin({ id: 'a' }), pin({ id: 'b' }), pin({ id: 'c' })] });
  const fences = (prompt.match(/<pinned-material>/g) ?? []).length;
  assert.equal(fences, 3, 'one fence per passage, never one fence around the lot');
});

test('a pin with an image is asked about on its own, because the reply is a different model', async () => {
  // Vision routes by request, not by tier: a batch carrying one image would
  // send every passage in it to the vision model. The image pin goes singly.
  const seen: LlmRequest[] = [];
  const llm = llmThat((req) => {
    seen.push(req);
    return req.media
      ? { assumedConcepts: [], mediaDescription: 'a diagram of a queue' }
      : { enrichments: [{ pin: 'p1', assumedConcepts: ['queues'], mediaDescription: null }] };
  });
  const withImage = pin({ id: 'img', envelope: { ...pin().envelope, media: { ref: 'blob:1' } } as Pin['envelope'] });
  const out = await forageBatch(deps(llm), { pins: [pin({ id: 'a' }), withImage] });

  assert.equal(seen.length, 2, 'one batch call for the text, one on its own for the image');
  assert.equal(seen.filter((r) => r.media).length, 1);
  assert.equal(out.get('img')?.mediaDescription, 'a diagram of a queue');
  assert.equal(out.get('a')?.outcome, 'enriched');
});
