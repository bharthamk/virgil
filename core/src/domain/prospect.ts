import type { Pin, Signal, Statement, Topic, TopicId } from './types.js';
import { isOpenableUrl } from './courses.js';
import { isUnansweredModality } from './modality.js';
// Type-only, and it has to stay that way: `avoidance.ts` reads this file's own
// shaky cut, so a value import here would close a runtime cycle.
import type { AvoidanceCandidate } from './avoidance.js';

/**
 * THE ONE STAGE THAT LOOKS OUTWARD.
 *
 * Every other stage in the night is introverted by construction. Forage reads
 * around what was pinned, Cluster files it, Survey orders it, Analyse and the
 * Registrar describe the person doing it, and Compose teaches back out of the
 * same pile. Nothing in that sequence can ever put a *new thing* in front of a
 * learner, because nothing in it is allowed to want one. The board is exactly
 * as wide as whatever somebody happened to save.
 *
 * This module is the other half. It reads the gaps the night has already
 * computed and proposes a small number of things the learner never thought to
 * collect. Three rules make that safe rather than merely novel:
 *
 *  1. **The evidence is built here, in code.** Every proposal names one item
 *     from the list this file produces. A model may draft the wording of the
 *     reason; it may not decide what the reason is about, and a proposal citing
 *     a key that was never offered is dropped rather than repaired. Same rule,
 *     same reason, as the source ids in `agents/composer.ts` and the criterion
 *     ids in `agents/marker.ts`: an answer attached to the wrong thing is worse
 *     than no answer.
 *
 *  2. **Nothing here is a write.** A proposal is a proposal. It creates no
 *     course, no commitment, no deadline, no topic and no signal, and it never
 *     becomes board material until a person accepts it. The course-drop lane
 *     settled that shape first and this reuses it.
 *
 *  3. **A named address has not been read.** A lead may carry a search phrase
 *     and a URL the model named from what it knows. Nothing fetches it here.
 *     `unread: true` is stated in the record rather than left to be inferred,
 *     because the alternative is a surface that shows an address beside a
 *     reason and lets somebody assume both were checked. If the learner accepts
 *     it, the Forager reads it on a later run, and that is where verification
 *     starts.
 *
 * Pure, like the rest of `domain/`. It takes the board as data and returns
 * data. The model call lives in `agents/prospector.ts` and the sequencing in
 * `runner/src/prospect-stage.ts`.
 */

// --------------------------------------------------------------- the gaps

/**
 * The kinds of hole the night can already see.
 *
 * Each one is somewhere the pipeline has *already spent a model call* and got
 * back something that says the board is short of material. That is the whole
 * economy of this stage: it invents no new analysis, it reads the analysis the
 * night has finished paying for.
 */
export type ProspectGapKind =
  /** A machine read of the learner on a topic the ledger says is not solid. */
  | 'shaky-statement'
  /** A check on the learner's own writing that went the wrong way. */
  | 'check-finding'
  /** Something the material takes for granted and the board has nothing on. */
  | 'prerequisite-hole'
  /** A topic that keeps being stepped around rather than done. */
  | 'avoided-topic'
  /**
   * An item with standing that has gone untouched while other work carried on.
   *
   * **Beside `avoided-topic`, not instead of it, and the two are not the same
   * claim.** `avoided-topic` is built from marks the learner MADE: they were
   * offered a topic and skipped it, abandoned its section, or took it off the
   * lineup, twice, and never demonstrated it. This one is built from marks that
   * are ABSENT: nothing happened against this item for a week while five other
   * things were finished. One is a record of refusals and the other is a
   * contrast in a ledger, they fail in different directions, and folding the
   * second into the first would let "never offered, never touched" be reported
   * with the authority of "explicitly skipped twice".
   *
   * So they carry distinct keys — `avoided:<topicId>` and
   * `slipping:<kind>:<id>` — and a topic that produces both yields only the
   * stronger of the two, because two proposals about one topic on one night is
   * the product asking twice.
   */
  | 'slipping-item'
  /**
   * A sentence the statements stage wrote that names a shortfall, read as
   * evidence in its own right.
   *
   * **Why this is a sixth kind rather than a loosening of the first.** The two
   * are both built off a statement and they are not the same claim, in the
   * exact way `avoided-topic` and `slipping-item` are not the same claim.
   * `shaky-statement` stands on ARITHMETIC: the comfort the Registrar computed
   * from the learner's own marks says this topic is not solid, and the sentence
   * is what that number reads like in prose. This one stands on the SENTENCE:
   * the ledger has said nothing either way, and the only thing saying the
   * learner is short of something is a line the product wrote about them.
   * Folding the second into the first would let "a machine sentence says so"
   * be reported with the authority of "their own marks say so", and the whole
   * reason this stage is allowed to exist is that it never does that.
   *
   * They therefore carry distinct keys — `statement:<id>` and `read:<id>` —
   * and a topic that would produce both yields only the comfort-gated one,
   * because the arithmetic is the stronger ground and two proposals about one
   * topic on one night is the product asking twice.
   *
   * **What makes it fire, and what makes that honest.** The record has no
   * valence field: a statement is prose, and `Statement` stores text, a
   * confirmation state and the signals it summarised, nothing else. So the read
   * below is a read of the product's own wording, in code, against a closed
   * list of shortfall marks. It will sometimes be wrong. That is survivable for
   * exactly one reason, and the reason is a rule rather than a hope: a gap
   * built off a statement the learner has never agreed to carries
   * `unconfirmed`, and the proposal the learner sees says on its face that the
   * ground is Virgil's own read rather than something established. A guess that
   * announces itself is a different object from a guess that does not.
   */
  | 'shortfall-read';

/**
 * One thing the code found, in the form a proposal has to cite.
 *
 * `key` is ours, opaque and positional in nothing: it names the record the gap
 * was read off, so a proposal can be traced back to a statement id or a signal
 * id six weeks later. It is never shown to a learner and never invented by a
 * model.
 */
export interface ProspectEvidence {
  readonly key: string;
  readonly kind: ProspectGapKind;
  /** What the gap is, in the board's own words. Untrusted: always fenced. */
  readonly detail: string;
  /** The topic it sits on, where there is one. Prerequisite holes have none. */
  readonly topicId: TopicId | null;
  /**
   * True when the record underneath this gap is a read of the learner that the
   * learner has never agreed to.
   *
   * Stated on every gap rather than inferred from the kind, for the same reason
   * `ProspectLead.unread` is stated: a surface that had to work it out would
   * one day work it out wrongly, and what it would get wrong is whether a
   * sentence in front of somebody is a fact about them or a guess about them.
   *
   * Only the two statement-shaped kinds can ever set it. A check finding, a
   * concept two sources assume, a topic set aside twice and an item that has
   * gone quiet are all RECORDS of things that happened, so there is nothing
   * about them for a person to confirm and no caveat to carry.
   */
  readonly unconfirmed: boolean;
}

export interface ProspectGapInput {
  readonly statements: readonly Statement[];
  readonly topics: readonly Topic[];
  readonly signals: readonly Signal[];
  readonly pins: readonly Pin[];
  /**
   * What the board says keeps slipping, already computed.
   *
   * Optional and handed in rather than derived here, because it needs the
   * courses, the plan and the clock, and this function is a read of the four
   * records the night has already produced. A stage with none of that to hand
   * passes nothing and the gap list is exactly what it was.
   */
  readonly slipping?: readonly AvoidanceCandidate[];
}

/**
 * Below this a topic is not solid enough for a statement about it to be a
 * settled read. Chosen to match the Reviewer's own weak-topic cut, so the two
 * surfaces that say "you are shaky here" agree about where shaky begins.
 */
export const PROSPECT_SHAKY_COMFORT = 0.6;

/**
 * How many separate sources have to take a concept for granted before its
 * absence is a hole rather than one page's aside.
 *
 * Two, and the number is the whole claim. One page assuming something is what
 * every page does; two unrelated pieces of material assuming the same thing,
 * on a board with nothing about it, is a gap the learner is walking past
 * repeatedly.
 */
export const PROSPECT_MIN_ASSUMED = 2;

/** How many marks of stepping around a topic make it avoided rather than late. */
export const PROSPECT_MIN_AVOIDANCE = 2;

/**
 * The marks in the board's own prose that name a shortfall.
 *
 * Word-start matches over the statement, and the anchoring is deliberate: a
 * bare substring cut finds `miss` inside `dismissed` and reports a learner as
 * missing something because a sentence used the word for the opposite thing.
 *
 * The list is closed and it is short on purpose. These are the shapes the
 * Registrar's own system prompt produces when the band it was handed was
 * *struggling* or *getting there*, plus the two hedges that prompt asks for by
 * name. It is not a sentiment model and must not grow into one: every entry
 * added here is a new way for the product to decide somebody is short of
 * something on the strength of a word, and the honest ceiling on that is a
 * vocabulary a person can read in one sitting and argue with.
 *
 * Chosen against false positives rather than coverage. `hard` was tried and
 * dropped (`hardware`, and *worked hard* is praise); so was `trip` (`triple
 * integral`). A statement this list misses costs one proposal nobody was owed.
 * A statement it catches wrongly costs a sentence about a person, which is why
 * the provenance label below is not optional.
 */
export const PROSPECT_SHORTFALL_MARKS: readonly string[] = [
  'not yet', 'has not', 'have not', 'had not', 'do not', 'does not', 'did not',
  'is not', 'are not', 'cannot', 'never', 'rarely',
  'struggl', 'shaky', 'unsure', 'uncertain', 'confus', 'missing', 'stuck', 'slip',
  'difficult',
];

/** The marks that mean somebody moved past a topic rather than through it. */
const AVOIDANCE_TYPES: readonly Signal['type'][] = [
  'self-skip', 'section-abandoned', 'lineup-not-now',
];

/** The marks that mean they did it. One is enough to say a topic is not avoided. */
const DEMONSTRATED_TYPES: readonly Signal['type'][] = [
  'answer-correct', 'recall-check', 'assessed-strong',
];

/**
 * How many gaps reach the model.
 *
 * A cap rather than the lot, because the prompt is the cost and because a list
 * of forty holes is a list nothing can choose three from meaningfully. Ordered
 * before it is cut, so the six that arrive are the same six on every machine.
 */
export const PROSPECT_MAX_GAPS = 6;

/**
 * Kind order, and it is a priority: what a check found beats what a page
 * assumed.
 *
 * `slipping-item` sits below the topic somebody explicitly stepped around, for
 * the reason its own doc comment gives: a refusal the learner made is stronger
 * evidence than a silence the ledger noticed.
 *
 * `shortfall-read` sits last of all, and being last is most of what makes it
 * safe to have at all. Every other kind is a record of something that happened;
 * this one is a read of a sentence. So it speaks only on a board where nothing
 * that happened is competing for the six places, which on a real board means a
 * first night. The cap does the rest: the moment the learner's own marks have
 * anything to say, the weakest evidence in the file stops being asked.
 */
const KIND_ORDER: readonly ProspectGapKind[] = [
  'check-finding', 'shaky-statement', 'prerequisite-hole', 'avoided-topic', 'slipping-item',
  'shortfall-read',
];

/** Comparable form of a statement, for the shortfall marks above. */
const forShortfall = (text: string): string =>
  ` ${String(text ?? '').toLowerCase().replace(/n['’]t\b/g, ' not')
    .replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Does the board's own prose say, in this sentence, that somebody is short? */
export const namesShortfall = (text: string): boolean => {
  const hay = forShortfall(text);
  return PROSPECT_SHORTFALL_MARKS.some((mark) => hay.includes(` ${mark}`));
};

/**
 * Has the learner agreed with this sentence about them?
 *
 * Three ways, and no fourth. `userEdited` is the panel's own `your words` cut:
 * the learner rewrote it, so the wording is theirs. A confirmed modality mark is
 *  cut: they were asked a question and answered yes. `confirmedAt` is
 * the same answer given to an ordinary read through the Insights room's own
 * gesture, which is why it is read here rather than treated as a new kind of
 * agreement: a person saying a sentence is right is one fact, whichever
 * sentence it was. Everything else is a machine read standing unanswered,
 * whatever it happens to say.
 */
export const statementConfirmed = (statement: Statement): boolean =>
  statement.userEdited || statementEndorsed(statement);

/** The learner has agreed with this exact sentence, as Virgil wrote it. Their
 *  own words are not endorsement: they are authorship, which is the stronger
 *  claim and a different one. */
export const statementEndorsed = (statement: Statement): boolean =>
  statement.confirmedAt != null || statement.modality?.confirmedAt != null;

const tidy = (text: string): string => String(text ?? '').replace(/\s+/g, ' ').trim();

/** Comparable form of a concept or a label. Not shown to anybody. */
const flatten = (text: string): string =>
  tidy(text).toLowerCase().replace(/[^a-z0-9 ]+/g, '').trim();

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every gap the board can show, in one deterministic order.
 *
 * Determinism is load-bearing twice over. It is what makes the stage testable
 * at all, and it is what stops two runs over an unchanged board proposing two
 * different things and charging for both.
 */
export function prospectGaps(input: ProspectGapInput): readonly ProspectEvidence[] {
  const topics = input.topics.filter((topic) => !topic.retiredByUser);
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const live = input.signals.filter((signal) => !signal.invalidated);
  const found: ProspectEvidence[] = [];

  /**
   * The sentences on the board this stage is allowed to read at all.
   *
   * A rejected statement is one the learner has already argued with, and
   * building a proposal on it would be the product asking twice. An unanswered
   * modality question is not a read of anybody : until a person has
   * said yes it is a question, nothing in the product may act on it, and
   * proposing material off it would be acting on it through a side door.
   */
  const readable = input.statements
    .filter((statement) => !statement.rejected && !isUnansweredModality(statement));

  // 1. Machine reads of the learner, on topics the arithmetic says are shaky.
  for (const statement of readable) {
    if (statement.topicId === null) continue;
    const topic = byId.get(statement.topicId);
    if (!topic || topic.comfort >= PROSPECT_SHAKY_COMFORT) continue;
    found.push({
      key: `statement:${statement.id}`,
      kind: 'shaky-statement',
      detail: `On "${tidy(topic.label)}": ${tidy(statement.text)}`,
      topicId: topic.id,
      unconfirmed: !statementConfirmed(statement),
    });
  }

  // 2. Checks on the learner's own writing. The strongest kind here, because it
  //    is the only one produced while they were trying to do something.
  for (const signal of live) {
    if (signal.type !== 'qc-finding' || signal.direction !== 'negative') continue;
    const topic = byId.get(signal.topicId);
    if (!topic) continue;
    found.push({
      key: `finding:${signal.id}`,
      kind: 'check-finding',
      detail: `A check on your own writing raised something about "${tidy(topic.label)}".`,
      topicId: topic.id,
      unconfirmed: false,
    });
  }

  // 3. What the material assumes and the board does not carry. The Forager
  //    already wrote these down, one list per pin, and nothing has ever read
  //    them across the board.
  const covered = new Set(topics.map((topic) => flatten(topic.label)).filter(Boolean));
  const assumed = new Map<string, { readonly text: string; pins: Set<string> }>();
  for (const pin of input.pins) {
    for (const concept of pin.enrichment?.assumedConcepts ?? []) {
      const flat = flatten(concept);
      if (!flat || covered.has(flat)) continue;
      const seen = assumed.get(flat);
      if (seen) seen.pins.add(pin.id);
      else assumed.set(flat, { text: tidy(concept), pins: new Set([pin.id]) });
    }
  }
  for (const [flat, entry] of [...assumed].sort((a, b) => byString(a[0], b[0]))) {
    if (entry.pins.size < PROSPECT_MIN_ASSUMED) continue;
    found.push({
      key: `prerequisite:${flat}`,
      kind: 'prerequisite-hole',
      detail: `${entry.pins.size} of your sources assume you already know: ${entry.text}`,
      topicId: null,
      unconfirmed: false,
    });
  }

  // 4. Topics that get stepped around. A topic somebody has demonstrated once
  //    is late rather than avoided, which is a different fact and a different
  //    fix, so one demonstration takes it off this list entirely.
  for (const topic of topics) {
    const marks = live.filter((signal) => signal.topicId === topic.id);
    const stepped = marks.filter((signal) => AVOIDANCE_TYPES.includes(signal.type)).length;
    const done = marks.some((signal) => DEMONSTRATED_TYPES.includes(signal.type));
    if (done || stepped < PROSPECT_MIN_AVOIDANCE) continue;
    found.push({
      key: `avoided:${topic.id}`,
      kind: 'avoided-topic',
      detail: `"${tidy(topic.label)}" has been set aside ${stepped} times and never worked through.`,
      topicId: topic.id,
      unconfirmed: false,
    });
  }

  // 5. What has gone untouched while other work carried on. Read elsewhere and
  //    handed in; the only judgement made here is the one this file already
  //    makes about every other kind, which is where it sits in the order.
  //
  //    A topic that produced an `avoided-topic` gap above is skipped rather
  //    than added twice: the refusal is the stronger claim and it is already on
  //    the list, and two proposals about one topic is the product asking twice.
  const spoken = new Set(found.filter((gap) => gap.kind === 'avoided-topic').map((gap) => gap.topicId));
  for (const item of input.slipping ?? []) {
    if (item.topicIds.some((topicId) => spoken.has(topicId))) continue;
    found.push({
      key: `slipping:${item.key}`,
      kind: 'slipping-item',
      detail: `"${tidy(item.title)}" has stood untouched for ${item.idleDays} days `
        + `while you finished ${item.elsewhere} other things.`,
      topicId: item.topicIds[0] ?? null,
      unconfirmed: false,
    });
  }

  /**
   * 6. What the board has WRITTEN about the learner, where the sentence itself
   *    names a shortfall.
   *
   *    The weakest evidence in the file and the only kind that reads prose, so
   *    it is fenced three ways. It never speaks about a topic the arithmetic has
   *    already spoken about above, because the comfort-gated claim is the
   *    stronger of the two and one topic gets one proposal. It carries
   *    `unconfirmed` unless the learner has agreed to the sentence, and the
   *    review surface turns that into a line saying so. And it sits last in the
   *    order, so it is the first thing the cap drops.
   *
   *    The topic comes off `evidenceSignalIds` rather than off a fresh match
   *    against today's labels: those ids ARE the join the Registrar made when it
   *    wrote the sentence, recorded at the time, and re-deriving it here would
   *    be a second opinion about what a sentence was about. A statement about a
   *    pattern across the whole board names no topic and keeps none, which is
   *    the same honest empty answer `evidenceFor` gives.
   */
  const shaky = new Set(found.filter((gap) => gap.kind === 'shaky-statement')
    .map((gap) => gap.topicId));
  const topicOfSignal = new Map(input.signals.map((signal) => [signal.id, signal.topicId]));
  for (const statement of readable) {
    if (!namesShortfall(statement.text)) continue;
    const named = [...new Set(statement.evidenceSignalIds
      .map((id) => topicOfSignal.get(id))
      .filter((topicId): topicId is TopicId => topicId !== undefined && byId.has(topicId)))]
      .sort(byString);
    if (named.some((topicId) => shaky.has(topicId))) continue;
    // Statement-level too, for the statement that carries a topic id of its own
    // and produced the comfort-gated gap above.
    if (found.some((gap) => gap.key === `statement:${statement.id}`)) continue;
    const topic = named[0] === undefined ? null : byId.get(named[0]) ?? null;
    found.push({
      key: `read:${statement.id}`,
      kind: 'shortfall-read',
      detail: topic
        ? `Written on your board about "${tidy(topic.label)}": ${tidy(statement.text)}`
        : `Written on your board: ${tidy(statement.text)}`,
      topicId: topic?.id ?? null,
      unconfirmed: !statementConfirmed(statement),
    });
  }

  return found
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || byString(a.key, b.key))
    .slice(0, PROSPECT_MAX_GAPS);
}

// ---------------------------------------------------------- the proposals

/** At most this many proposals leave one night, whatever the board. */
export const PROSPECT_MAX_PROPOSALS = 3;

/**
 * At most this many model calls, whatever the board.
 *
 * Two: one to choose and write, one to name the leads. The number is here
 * rather than in the agent so that the pipeline, the agent and the cost model
 * are reading one constant instead of agreeing three times.
 */
export const PROSPECT_MAX_MODEL_CALLS = 2;

export const PROSPECT_SUBJECT_MAX_CHARS = 120;
export const PROSPECT_REASON_MAX_CHARS = 320;
export const PROSPECT_PHRASE_MAX_CHARS = 120;

/**
 * Where a learner could go looking, if they decide the proposal is worth it.
 *
 * The phrase is the useful half. A model knows what this kind of material is
 * usually called far better than it knows which address currently serves it,
 * and a search phrase cannot rot, 404, or turn out to be somewhere nobody
 * should be sent.
 */
export interface ProspectLead {
  readonly phrase: string;
  /** An address the model named. Never fetched, never checked, may not exist. */
  readonly url: string | null;
  /**
   * Always true, and stated rather than implied.
   *
   * Nothing in this stage reads a page. A record that merely omitted a
   * `retrievedAt` would leave a surface free to render the address as though
   * somebody had looked at it, which is the one claim this stage must never
   * make.
   */
  readonly unread: true;
}

export type ProspectState = 'pending' | 'accepted' | 'dismissed';

export interface ProspectProposal {
  readonly id: string;
  /** What to go and get, in a few words. */
  readonly subject: string;
  /** Why, naming the evidence. Drafted by the model, bounded here. */
  readonly reason: string;
  /** The evidence this stands on. Always a key the code produced. */
  readonly evidenceKey: string;
  readonly evidenceKind: ProspectGapKind;
  /**
   * The evidence in the code's own words, copied at the time.
   *
   * Kept beside the proposal rather than looked up on read, because the
   * statement or signal it came from can be edited, rejected or deleted, and a
   * reason whose evidence has silently changed underneath it is worse than one
   * that says what it was built on.
   */
  readonly evidenceDetail: string;
  /**
   * Whether the ground under this proposal is a read the learner never agreed
   * to, copied off the evidence at the time exactly as `evidenceDetail` is.
   *
   * The law of this record. A proposal is the one thing in this product that
   * puts a sentence about somebody's learning in front of them on the strength
   * of something they did not write and have not answered, so the review
   * surface renders a line saying so, and the flag it renders from travels with
   * the proposal rather than being looked up later. A statement can be edited,
   * confirmed or deleted after the fact, and a caveat that quietly disappeared
   * because the underlying row changed would be worse than never having one.
   */
  readonly evidenceUnconfirmed: boolean;
  readonly lead: ProspectLead | null;
  readonly state: ProspectState;
  readonly raisedAt: string;
  /** Which night raised it, so a board can show one night at a time. */
  readonly batchKey: string;
  readonly decidedAt: string | null;
}

/** A proposal as the model offers it, before anything has been checked. */
export interface ProspectCandidate {
  readonly evidenceKey: string;
  readonly subject: string;
  readonly reason: string;
  readonly lead?: { readonly phrase?: string; readonly url?: string | null } | null;
}

export interface ProspectAdmission {
  readonly kept: readonly ProspectProposal[];
  /** Cited a key that was never offered. The rule this stage exists under. */
  readonly inventedEvidence: number;
  /** Nothing to show a learner: no subject, or no reason. */
  readonly empty: number;
  /** A second proposal on evidence already spoken for. */
  readonly duplicate: number;
  /** Over the nightly cap. Not a fault, and counted separately from one. */
  readonly overCap: number;
}

export interface ProspectAdmissionContext {
  readonly now: string;
  readonly batchKey: string;
  readonly id: () => string;
}

/**
 * A URL the product is willing to put in front of somebody, or nothing.
 *
 * `isOpenableUrl` is the course shelf's rule and it is the right one here for
 * the same reason: this string reaches the DOM as an href, and it was written
 * by a model rather than typed by the learner.
 */
export function prospectLeadUrl(raw: unknown): string | null {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (!url || url.length > 300) return null;
  return isOpenableUrl(url) ? url : null;
}

/**
 * The refusal, and the reason this function is not in the agent.
 *
 * Admission is a domain rule: a proposal stands on evidence the code found, or
 * it does not stand. Keeping it here means it is tested without a model, reused
 * by anything that later wants to admit proposals from somewhere else, and
 * impossible to soften by rewording a prompt.
 */
export function admitProspectProposals(
  candidates: readonly ProspectCandidate[],
  evidence: readonly ProspectEvidence[],
  context: ProspectAdmissionContext,
): ProspectAdmission {
  const offered = new Map(evidence.map((item) => [item.key, item]));
  const spokenFor = new Set<string>();
  const kept: ProspectProposal[] = [];
  let inventedEvidence = 0;
  let empty = 0;
  let duplicate = 0;
  let overCap = 0;

  for (const candidate of candidates) {
    const cited = offered.get(tidy(String(candidate?.evidenceKey ?? '')));
    if (!cited) { inventedEvidence += 1; continue; }
    const subject = tidy(candidate.subject).slice(0, PROSPECT_SUBJECT_MAX_CHARS);
    const reason = tidy(candidate.reason).slice(0, PROSPECT_REASON_MAX_CHARS);
    if (!subject || !reason) { empty += 1; continue; }
    if (spokenFor.has(cited.key)) { duplicate += 1; continue; }
    if (kept.length >= PROSPECT_MAX_PROPOSALS) { overCap += 1; continue; }
    spokenFor.add(cited.key);
    const phrase = tidy(candidate.lead?.phrase ?? '').slice(0, PROSPECT_PHRASE_MAX_CHARS);
    kept.push({
      id: context.id(),
      subject,
      reason,
      evidenceKey: cited.key,
      evidenceKind: cited.kind,
      evidenceDetail: cited.detail,
      evidenceUnconfirmed: cited.unconfirmed,
      lead: phrase ? { phrase, url: prospectLeadUrl(candidate.lead?.url), unread: true } : null,
      state: 'pending',
      raisedAt: context.now,
      batchKey: context.batchKey,
      decidedAt: null,
    });
  }

  return { kept, inventedEvidence, empty, duplicate, overCap };
}

/**
 * A lead attached after the fact, under the same refusal.
 *
 * The second model call answers about proposals that have already been
 * admitted, so its only opportunity to invent something is the address. A
 * phrase that arrives empty leaves the proposal exactly as it was: a proposal
 * with no lead is a proposal a person can still act on, and a fabricated one is
 * not.
 */
export function withProspectLead(
  proposal: ProspectProposal,
  lead: { readonly phrase?: string; readonly url?: string | null } | null,
): ProspectProposal {
  const phrase = tidy(lead?.phrase ?? '').slice(0, PROSPECT_PHRASE_MAX_CHARS);
  if (!phrase) return proposal;
  return { ...proposal, lead: { phrase, url: prospectLeadUrl(lead?.url), unread: true } };
}

export class ProspectStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProspectStateError';
  }
}

/**
 * The learner's decision, and the only mutation this record has.
 *
 * Deciding twice is refused rather than absorbed. A proposal that has been
 * accepted has already become something else on the board, and quietly moving
 * it back to dismissed would leave that behind with nothing pointing at it.
 */
export function decideProspectProposal(
  proposal: ProspectProposal,
  state: ProspectState,
  now: string,
): ProspectProposal {
  if (state === 'pending') {
    throw new ProspectStateError('a proposal cannot be moved back to undecided');
  }
  if (proposal.state !== 'pending') {
    throw new ProspectStateError('this proposal has already been decided');
  }
  return { ...proposal, state, decidedAt: now };
}

/** Newest night first, then by subject, so a screen reads the same twice. */
export function orderProspectProposals(
  proposals: readonly ProspectProposal[],
): readonly ProspectProposal[] {
  return [...proposals].sort((a, b) =>
    byString(b.raisedAt, a.raisedAt) || byString(a.subject, b.subject) || byString(a.id, b.id));
}

/** What is still waiting on a person. The only list a review surface draws. */
export const pendingProspectProposals = (
  proposals: readonly ProspectProposal[],
): readonly ProspectProposal[] =>
  orderProspectProposals(proposals.filter((proposal) => proposal.state === 'pending'));
