import type { Deps } from './deps.js';
import type { Enrichment, EnrichmentOutcome, Pin, SourceRecord } from '../domain/types.js';
import { MAX_HEADING_PATH, UNTRUSTED_RULE, capped, fencePinned, suspectedInjection } from './untrusted.js';
import { positionalKey, resolveKey } from './keys.js';
import { FORAGE_BATCH } from '../domain/batch.js';
import { LlmRefused } from '../ports/llm.js';

/**
 * FORAGER — enrichment, background, per-pin.
 *
 * the learner pinned a scrap. Forager goes and gets what the scrap was
 * missing — the surrounding argument, the concept the passage assumed you
 * already had, a canonical reference for it. This is the expensive work that
 * justifies having a background fleet at all, and it runs per-pin so it
 * parallelises.
 *
 * Deliberately isolated: Forager sees one pin and never the board. That is what
 * makes the fan-out safe and keeps its context small.
 *
 * Every enrichment states its own `outcome`. Forager swallows its model failure
 * on purpose — a pin that cannot be enriched is still teachable — but swallowing
 * it silently made a failed call and a self-contained passage the same record in
 * the store, so a run where nearly every call failed was indistinguishable from
 * a run where nearly every passage needed nothing. The degrade is unchanged; the
 * record is now honest about which one happened.
 */

export interface ForagerInput {
  readonly pin: Pin;
}

/**
 * Which pins the nightly forage stage is owed an attempt at — the rule behind
 * `listPins({ unenrichedOnly: true })`, kept here rather than in the adapter so
 * every store implementation answers the same question.
 *
 * Re-eligibility is decided by the outcome and by nothing else:
 *
 *  - never enriched      -> owed. Obvious.
 *  - `model-failed`      -> owed. The question was never answered.
 *  - `nothing-found`     -> NOT owed. The model read the passage and said it is
 *                           self-contained; re-asking nightly buys a fresh copy
 *                           of the same answer at full price for ever.
 *  - `enriched`          -> NOT owed.
 *
 * An enrichment written before this field existed has no `outcome` and is not
 * re-eligible, which is exactly how those pins behaved yesterday.
 */
export function owedEnrichment(pin: Pin): boolean {
  return pin.enrichment === null || pin.enrichment.outcome === 'model-failed';
}

const SCHEMA = {
  type: 'object',
  properties: {
    assumedConcepts: { type: 'array', items: { type: 'string' } },
    mediaDescription: { type: ['string', 'null'] },
  },
  required: ['assumedConcepts', 'mediaDescription'],
};

const SYSTEM = `You prepare pinned material for teaching later.
Identify the concepts this passage LEANS ON but does not itself explain. These are the things a reader would already need to know for this passage to make sense.
Be strict: list only genuine prerequisites, at most four, named as a learner would name them. If the passage is self-contained, return an empty list.
Do not summarise the passage. Do not invent facts. JSON only.

${UNTRUSTED_RULE}`;

/**
 * Everything the Forager does before it asks anything, and after it is told.
 *
 * Split out because the batch path needs exactly the same preparation and
 * exactly the same finishing, and a second copy of "which text do we trust"
 * would be the most dangerous duplication in this file — the re-fetch guards
 * here are the ones that stop a page rewriting itself between the pin and the
 * run.
 */
interface Prepared {
  readonly pin: Pin;
  readonly references: SourceRecord[];
  readonly usable: string | null;
  readonly material: string;
  readonly confidence: Enrichment['confidence'];
  readonly media?: readonly { kind: 'image'; ref: string }[];
}

async function prepare(deps: Deps, pin: Pin): Promise<Prepared> {
  const e = pin.envelope;
  const references: SourceRecord[] = [];

  // The pin's own page is always a source, whether or not re-fetch succeeds.
  references.push({
    id: `${pin.id}:origin`,
    origin: 'user-pin',
    url: e.url,
    title: e.pageTitle,
    retrievedAt: pin.capturedAt,
    pinId: pin.id,
  });

  // read around the selection with fresh eyes.
  const raw = await deps.research.fetchPage(e.canonicalUrl ?? e.url);

  // A JS-rendered page answers 200 with a shell — measured at 11 words on a
  // live SPA. That is a *worse* source than the capture envelope, which holds
  // what the learner actually saw, so treat it as a failed fetch rather than
  // letting a successful status code overwrite good material with nothing.
  const MIN_USABLE_WORDS = 300;
  const bigEnough = raw && raw.text.split(/\s+/).length >= MIN_USABLE_WORDS;

  // Vendor docs localise. A re-fetch from a different region can return the
  // page in another language, and the learner would be taught from a version
  // they never read (capture-envelope constraint). Trust the capture envelope over a
  // re-fetch whose language does not match what was pinned.
  const sameLanguage = !raw || languageMatches(raw.text, e.contentLanguage);
  const fetched = bigEnough && sameLanguage ? raw : null;

  // gated, dead or JS-only pages are normal, not exceptional. Fall back
  // to the capture-time envelope and mark the confidence down so the Composer
  // narrows its claims instead of compensating.

  const captured = `${e.selection ?? ''}\n${e.surroundingText}`.trim();
  const anchored = fetched?.text ? nearSelection(fetched.text, e.selection) : null;

  // A re-fetched page that turns out to be addressing an assistant is the same
  // shape of problem as a page that came back in the wrong language: what we
  // fetched is not what the learner read. Prefer the capture envelope, which is
  // the text they actually saw, and mark the confidence down. This cannot save
  // the selection itself — if the hostile text is what they highlighted, it is
  // their material and it gets taught — but it stops a page rewriting itself
  // between the pin and the nightly run.
  const injected = anchored ? suspectedInjection(anchored) : [];
  const usable = injected.length ? null : anchored;

  // If the page fetched but we could not locate the selection in it, the
  // capture envelope is the better source. An arbitrary slice of a 72,000-word
  // spec is not "reading around the selection", it is reading the contents page.
  const material = usable ?? captured;

  return {
    pin,
    references,
    usable,
    material,
    confidence: usable ? 'full' : 'reduced',
    ...(e.media ? { media: [{ kind: 'image' as const, ref: e.media.ref }] } : {}),
  };
}

/** The fenced block one pin contributes to a prompt, batched or not. */
function passageBlock(prepared: Prepared): string {
  const e = prepared.pin.envelope;
  return fencePinned([
    e.headingPath.length ? `Section: ${capped(e.headingPath.join(' > '), MAX_HEADING_PATH)}` : null,
    `Passage:\n${prepared.material.slice(0, MAX_PASSAGE_CHARS)}`,
  ].filter(Boolean).join('\n\n'));
}

/** What the model said about one pin, once it has been read out of the reply. */
interface Answer {
  readonly assumedConcepts: readonly string[];
  readonly mediaDescription: string | null;
}

function readAnswer(value: unknown): Answer {
  const v = value as { assumedConcepts?: unknown; mediaDescription?: unknown } | null;
  if (!v || typeof v !== 'object' || !Array.isArray(v.assumedConcepts)) {
    throw new Error('the enrichment reply carried no assumed-concepts list');
  }
  return {
    assumedConcepts: v.assumedConcepts.slice(0, MAX_CONCEPTS).filter((s): s is string => typeof s === 'string'),
    mediaDescription: typeof v.mediaDescription === 'string' ? v.mediaDescription : null,
  };
}

/**
 * A description of an image that was never pinned is not an enrichment.
 *
 * The schema asks for `mediaDescription` on every call because one schema is
 * simpler than two, and models fill fields that are offered. Found in the
 * batching bake-off: two synthetic text-only pins — a podcast title and a tutor's name,
 * neither carrying an image — came back with **zero** assumed concepts and a
 * description anyway, which `finish` read as `enriched`. That retires a pin
 * from enrichment for ever on the strength of a field it should never have
 * had. A pin with no media has no media description.
 */
const forPin = (prepared: Prepared, answer: Answer): Answer =>
  (prepared.media ? answer : { ...answer, mediaDescription: null });

/** The record, from a prepared pin and whatever the model managed to say. */
async function finish(deps: Deps, prepared: Prepared, answer: Answer | null): Promise<Enrichment> {
  // Enrichment is an improvement, never a gate. A pin that cannot be enriched
  // is still teachable from its capture envelope — the degrade is unchanged.
  // What is new is that the pin says so, instead of looking identical to one
  // the model read and found nothing in.
  const real = answer ? forPin(prepared, answer) : null;
  const assumedConcepts = real ? [...real.assumedConcepts] : [];
  const mediaDescription = real?.mediaDescription ?? null;
  const outcome: EnrichmentOutcome = answer === null
    ? 'model-failed'
    // An empty list is a real answer — "this passage is self-contained" is what
    // the prompt asks for and it is often right. It is recorded as such so that
    // it stops being the same record a failure leaves behind.
    : (assumedConcepts.length || mediaDescription ? 'enriched' : 'nothing-found');

  const references = [...prepared.references];
  // agent-sourced references are fetched only where the product can
  // actually attribute them, and are marked distinctly from the user's own pin.
  if (deps.research.hasGrounding && assumedConcepts.length) {
    for (const concept of assumedConcepts.slice(0, 2)) {
      references.push(...await deps.research.findReferences(concept, 1));
    }
  }

  return {
    refetchedText: prepared.usable ? prepared.usable.slice(0, 6000) : null,
    assumedConcepts,
    mediaDescription,
    references,
    outcome,
    confidence: prepared.confidence,
    enrichedAt: deps.clock.now().toISOString(),
  };
}

export async function forage(deps: Deps, input: ForagerInput): Promise<Enrichment> {
  const prepared = await prepare(deps, input.pin);
  let answer: Answer | null = null;
  try {
    const res = await deps.llm.structured<unknown>({
      tier: 'deep',
      // Background work: reasoning stays on, latency is free at 3am.
      reasoning: 'on',
      system: SYSTEM,
      prompt: [
        passageBlock(prepared),
        prepared.media ? 'An image was pinned with this. Describe what it shows, in teaching terms.' : null,
      ].filter(Boolean).join('\n\n'),
      schema: SCHEMA,
      ...(prepared.media ? { media: [...prepared.media] } : {}),
      maxOutputTokens: 900,
    });
    answer = readAnswer(res.value);
  } catch (err) {
    // A refusal is not a failure. A pin owed another attempt tomorrow is the
    // honest outcome of a call that failed; a call that was never sent will not
    // be sent tomorrow either, until the thing that stopped it changes, and the
    // run that discovers it should say so once rather than per pin.
    if (err instanceof LlmRefused) throw err;
    answer = null;
  }
  return finish(deps, prepared, answer);
}

/**
 * The same work, asked about several pins at once.
 *
 * **Why this exists.** A cost audit found that nine of sixteen calls belonged
 * to this agent, one per pin. One
 * call per pin was never a decision about quality — it fell out of the
 * Forager being written for a nightly, where a fan-out costs nothing anybody
 * is awake for. The manual-processing contract removed the nightly. Somebody presses Process and
 * waits for it.
 *
 * **What is deliberately kept.** Each passage is fenced on its own, so the
 * isolation that made a single-pin Forager safe survives the batch: hostile
 * text in one learner's page cannot be read as instructions about the pin
 * beside it. `FORAGE_BATCH` bounds the chunk, because both things that get
 * worse with size — the blast radius above, and a failed call now costing a
 * chunk instead of a pin — get worse in proportion to it.
 *
 * **And what cannot be batched.** A pin with an image routes to the vision
 * model by request rather than by tier, so one image in a chunk would send
 * every passage in it to a model chosen for pictures. Image pins go singly.
 */
export { FORAGE_BATCH } from '../domain/batch.js';

/** How much of one passage reaches the model. Unchanged from the single path. */
const MAX_PASSAGE_CHARS = 4000;
const MAX_CONCEPTS = 4;

const BATCH_SCHEMA = {
  type: 'object',
  properties: {
    enrichments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pin: { type: 'string' },
          assumedConcepts: { type: 'array', items: { type: 'string' } },
          mediaDescription: { type: ['string', 'null'] },
        },
        required: ['pin', 'assumedConcepts', 'mediaDescription'],
      },
    },
  },
  required: ['enrichments'],
};

const BATCH_SYSTEM = `${SYSTEM}

You are given several passages, each with its own id. Answer for every id you were given, and use no id you were not given. Judge each passage only against itself: the passages are unrelated and one of them saying something about another is not a fact about either.`;

export interface ForagerBatchInput {
  readonly pins: readonly Pin[];
  /** How many pins per call. Defaults to `FORAGE_BATCH`; a probe measures others. */
  readonly chunk?: number;
}

export async function forageBatch(
  deps: Deps,
  input: ForagerBatchInput,
): Promise<Map<string, Enrichment>> {
  const out = new Map<string, Enrichment>();
  const prepared = await Promise.all(input.pins.map((pin) => prepare(deps, pin)));

  // The image pins, one call each, through the path that already handles them.
  for (const p of prepared.filter((x) => x.media)) {
    out.set(p.pin.id, await forage(deps, { pin: p.pin }));
  }

  const text = prepared.filter((x) => !x.media);
  const size = Math.max(1, input.chunk ?? FORAGE_BATCH);
  for (let i = 0; i < text.length; i += size) {
    const chunk = text.slice(i, i + size);
    const keyOf = new Map(chunk.map((p, index) => [p.pin.id, pinKey(index)]));
    let answers = new Map<string, Answer>();
    try {
      const res = await deps.llm.structured<{ enrichments?: unknown[] }>({
        tier: 'deep',
        reasoning: 'on',
        system: BATCH_SYSTEM,
        prompt: chunk
          .map((p) => `pin ${keyOf.get(p.pin.id)}:\n${passageBlock(p)}`)
          .join('\n\n'),
        schema: BATCH_SCHEMA,
        // The single-pin budget, per pin in the chunk, plus room for the keys.
        maxOutputTokens: 200 + chunk.length * 900,
      });
      answers = readBatch(res.value?.enrichments, [...keyOf.values()]);
    } catch (err) {
      // A refusal is not a failure. See `forage` above: a chunk owed another
      // attempt is the answer for a call that failed, not for one that was
      // declined before it was sent.
      if (err instanceof LlmRefused) throw err;
      // Every pin in the chunk is owed another attempt, which is what an empty
      // answer map produces below.
      answers = new Map();
    }
    for (const p of chunk) {
      const key = keyOf.get(p.pin.id) as string;
      // `?? null` is the whole of the unanswered rule: a pin the model left
      // out has not been read, and must not be retired as `nothing-found`.
      out.set(p.pin.id, await finish(deps, p, answers.get(key) ?? null));
    }
  }
  return out;
}

/** The key one pin answers to inside a chunk. Positional and opaque, like the
 *  Clusterer's group keys, so no pin id is ever put in front of a model. */
const pinKey = (index: number): string => positionalKey(index, 'p');

/** Read the batch reply into answers by key, discarding anything unrecognised. */
function readBatch(rows: unknown, offered: readonly string[]): Map<string, Answer> {
  const answers = new Map<string, Answer>();
  if (!Array.isArray(rows)) throw new Error('the batch reply carried no enrichments list');
  for (const row of rows) {
    const claimed = (row as { pin?: unknown })?.pin;
    const key = typeof claimed === 'string' ? resolveKey(claimed, offered) : null;
    // A second answer for one pin is as likely to be the wrong one as the
    // first, so the first is kept and the order of the reply does not decide.
    if (key === null || answers.has(key)) continue;
    try {
      answers.set(key, readAnswer(row));
    } catch {
      // One malformed row costs its own pin an attempt, not the chunk's.
    }
  }
  return answers;
}

/**
 * The primary subtag of a BCP-47-ish tag, or null when the tag says nothing.
 *
 * `en-US` and `en` are the same language for this purpose, and so are `pt-BR`
 * and `pt` — the guard is against being served a different LANGUAGE, not a
 * different regional edition of the one the learner read. `und` (undetermined)
 * and `zxx` (no linguistic content) are the standard ways of writing "we do not
 * know", and `mul` says several at once; all three are read as absent rather
 * than as a language, because treating "unknown" as a language would let a
 * page that declares nothing look like a mismatch with everything.
 */
export function primaryLanguage(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  if (!/^[a-z]{2,3}$/.test(primary)) return null;
  if (primary === 'und' || primary === 'zxx' || primary === 'mul') return null;
  return primary;
}

/**
 * Function words, per language. Deliberately the commonest closed-class words —
 * the ones a page cannot avoid using and a topic cannot skew.
 *
 * This is a profile set, not a language-detection library: it exists to answer
 * one question ("is this plausibly the language that was pinned?") on a corpus
 * of prose, and it is vendor-free by the same rule that keeps `core/` free of
 * SDKs. A language with no profile here is a language this check cannot speak
 * about, which is treated as "cannot verify" and never as a mismatch.
 */
const FUNCTION_WORDS: Readonly<Record<string, readonly string[]>> = {
  en: ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'for', 'with', 'are', 'be', 'as', 'on', 'it', 'this', 'from', 'you', 'or', 'by', 'not'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'por', 'con', 'para', 'se', 'no', 'es', 'su', 'del', 'como', 'pero'],
  pt: ['o', 'a', 'os', 'as', 'de', 'que', 'e', 'em', 'um', 'uma', 'por', 'com', 'para', 'se', 'não', 'é', 'do', 'da', 'dos', 'ao'],
  fr: ['le', 'la', 'les', 'des', 'du', 'et', 'en', 'un', 'une', 'pour', 'avec', 'dans', 'est', 'que', 'qui', 'ne', 'pas', 'ce', 'sur', 'au'],
  de: ['der', 'die', 'das', 'und', 'den', 'von', 'zu', 'mit', 'ist', 'im', 'für', 'dem', 'nicht', 'ein', 'eine', 'auch', 'auf', 'sich', 'als', 'werden'],
  it: ['il', 'la', 'le', 'di', 'che', 'e', 'in', 'un', 'una', 'per', 'con', 'non', 'si', 'sono', 'del', 'della', 'come', 'più', 'da', 'al'],
  nl: ['de', 'het', 'een', 'en', 'van', 'in', 'is', 'dat', 'op', 'te', 'voor', 'met', 'niet', 'zijn', 'ook', 'aan', 'er', 'die', 'als', 'om'],
};

/** Below this share of the words, a profile is not describing this text. */
const MIN_FIT = 0.04;
/**
 * How many DIFFERENT function words a profile must hit before it counts as
 * fitting at all.
 *
 * Without it, a page of source code scores 0.167 on Portuguese — every `a` in
 * `function f(a, b)` — and an English pin would be marked down for a mismatch
 * against a language nothing on the page is written in. Prose uses many
 * different function words; noise repeats one.
 */
const MIN_DISTINCT = 4;
/** How far below the best-fitting profile the pinned language may sit and still
 *  be a credible reading of the page. Related languages share function words,
 *  and a false mismatch costs a degraded enrichment, so this is generous. */
const CREDIBLE = 0.6;

export function languageMatches(text: string, expected: string | null | undefined): boolean {
  const want = primaryLanguage(expected);
  if (!want) return true;                       // nothing was captured to check against
  if (!FUNCTION_WORDS[want]) return true;       // a language this check cannot speak

  // Unicode-aware: splitting on \W drops every accented character, which turns
  // "não" into "n" and "o" and hands Portuguese a profile it cannot score on.
  const words = text.toLowerCase().slice(0, 4000).split(/[^\p{L}]+/u).filter(Boolean);
  if (!words.length) return true;               // nothing to read

  let best = 0;
  let mine = 0;
  for (const [lang, list] of Object.entries(FUNCTION_WORDS)) {
    const set = new Set(list);
    const hit = words.filter((w) => set.has(w));
    const fit = hit.length / words.length;
    if (lang === want) mine = fit;
    // Only a profile that genuinely describes the text may set the bar the
    // captured language has to clear.
    if (fit >= MIN_FIT && new Set(hit).size >= MIN_DISTINCT && fit > best) best = fit;
  }

  if (best === 0) return true;                  // code, tables, or a language we do not model
  return mine >= best * CREDIBLE;
}

/**
 * Re-fetched pages are mostly navigation and boilerplate. Centre the window on
 * what the learner actually highlighted, so the model reads the argument around
 * the selection rather than the site's footer.
 */
function nearSelection(pageText: string, selection: string | null, window = 3000): string | null {
  // Whole-page pins have no anchor, so the top of the page is the right answer.
  if (!selection) return pageText.slice(0, window);
  const probe = selection.slice(0, 60);
  const at = pageText.indexOf(probe);
  if (at < 0) return null; // caller falls back to the capture envelope
  const start = Math.max(0, at - Math.floor(window / 3));
  return pageText.slice(start, start + window);
}
