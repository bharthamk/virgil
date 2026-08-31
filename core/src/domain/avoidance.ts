import type { Commitment } from './commitments.js';
import { commitmentState } from './commitments.js';
import type { Course, Material } from './courses.js';
import type { Pin, PrereqEdge, Signal, SignalType, Statement, Topic, TopicId } from './types.js';
import { daysSince, reviewDue } from './board-areas.js';
import { PROSPECT_SHAKY_COMFORT } from './prospect.js';

/**
 * WHAT KEEPS SLIPPING — the first thing this product notices about behaviour.
 *
 * Every other read in `domain/` is about what somebody knows. This one is about
 * what they keep walking past, and it is the only place where the absence of an
 * event is the evidence. That makes it the easiest module in the repository to
 * turn into an accusation, so three rules hold it down and all three are code
 * rather than intention:
 *
 *  1. **Silence alone is never enough.** A thing nobody touched is a thing
 *     nobody had time for. What makes it worth saying is silence on one item
 *     beside real activity on others, in the same window, on an item that has
 *     standing and could actually be started. Four legs, and every one of them
 *     can drop a candidate on its own.
 *  2. **The learner can end it in one press.** `Setting this aside on purpose`
 *     is a decision, not a snooze the product invented, and it is honoured by
 *     the surface AND by the ranker. Nothing here argues with it.
 *  3. **No claim is made about history the product did not record.** The
 *     passed-over ledger below is forward-only and says when it started. A
 *     count from it is rendered beside that date or not at all.
 *
 * The learner-facing noun is *slipping*. The word this file is named for is an
 * engineering word and never reaches a screen: it describes a pattern in a
 * ledger, and telling somebody they are avoiding something is a diagnosis this
 * product is not entitled to make.
 *
 * ## Why the constants are what they are
 *
 * Reasoned, not measured, exactly as the re-read detector's thresholds are. No
 * corpus of learner behaviour exists to fit them against, and inventing one by
 * intuition and calling it evidence would be worse than saying so. Each is
 * argued below and each is one number in one place, so a later measurement
 * moves the product rather than requiring it to be rebuilt.
 *
 * Pure, like the rest of `domain/`. Takes the board as data, returns data.
 */

// ------------------------------------------------------------- the numbers

/**
 * How long something has to go untouched before its silence is a fact.
 *
 * A week. Short enough that the thing is still live in somebody's mind and long
 * enough to have survived a normal weekend, an illness, and one busy week of
 * term. Three days would fire on every ordinary Monday.
 */
export const AVOID_IDLE_DAYS = 7;

/**
 * How much work has to have happened ELSEWHERE in that same window before the
 * silence means anything.
 *
 * Five. The whole claim of this module is the contrast: a learner who did
 * nothing at all is a learner who was busy, and saying "this keeps slipping" to
 * them would be the product mistaking its own absence from their week for their
 * absence from the work. Five finished actions is a fortnight of light use or
 * two decent sessions, which is enough to say they were here and this was not
 * what they did.
 */
export const AVOID_ELSEWHERE_MIN = 5;

/**
 * How long `Setting this aside on purpose` holds.
 *
 * Fourteen days, and deliberately twice the idle window: a deferral that
 * expired before the thing could even qualify again would be a control that
 * did nothing. Twice `NOT_NOW_DAYS` for the same reason it is longer than that
 * mark is short — the lineup's X is about tonight, and this is somebody saying
 * a whole piece of work is not theirs to do this fortnight.
 */
export const AVOID_SNOOZE_DAYS = 14;

/** At most this many rows ever reach a screen. Three is a list; ten is a pile. */
export const AVOID_MAX_SURFACED = 3;

/** Last this many passed-over marks are kept. See `recordPassedOver`. */
export const AVOID_LEDGER_MAX = 200;

const DAY_MS = 86_400_000;

// --------------------------------------------------------------- the shapes

/**
 * The three kinds of thing that can slip.
 *
 * `recall` rather than `topic`, because what slips is the retrieval practice a
 * topic is owed and not the topic itself, and because a learner reading the row
 * is being offered a minute of remembering rather than a subject.
 */
export type AvoidanceItemKind = 'material' | 'recall' | 'commitment';

/**
 * Why this item had standing to be done at all.
 *
 * Ordered by weight below. `overdue` and `due` are dates somebody else set or
 * the spacing arithmetic set; `prerequisite` is the graph saying other work
 * leans on it; `shaky` is the ledger's own read. An item with none of these is
 * not slipping, it is simply not urgent, and this list must never become a list
 * of everything on the board that is quiet.
 */
export type AvoidanceStanding = 'overdue' | 'due' | 'prerequisite' | 'shaky';

const STANDING_WEIGHT: Readonly<Record<AvoidanceStanding, number>> = {
  overdue: 4, due: 3, prerequisite: 2, shaky: 1,
};

export interface AvoidanceCandidate {
  /** `kind:id`. Stable, ours, and the key every other surface joins on. */
  readonly key: string;
  readonly kind: AvoidanceItemKind;
  readonly id: string;
  /** What the learner calls it. Never a heading or an internal label. */
  readonly title: string;
  readonly standing: AvoidanceStanding;
  /** Whole days since the ledger last recorded any contact with it. */
  readonly idleDays: number;
  /** Finished actions on other things inside that same idle window. */
  readonly elsewhere: number;
  /** `idleDays x standing weight`. Exposed for audit, never shown. */
  readonly score: number;
  readonly topicIds: readonly TopicId[];
}

/** The learner's own deferrals: key to the ISO instant they said it. */
export type AvoidanceSetAside = Readonly<Record<string, string>>;

export interface AvoidanceInput {
  readonly now: Date;
  readonly timeZone?: string;
  readonly courses: readonly Course[];
  readonly commitments: readonly Commitment[];
  readonly topics: readonly Topic[];
  readonly pins: readonly Pin[];
  readonly signals: readonly Signal[];
  /** Optional: a board with no machine reads of the learner has none. */
  readonly statements?: readonly Statement[];
  /** Optional: a board whose prerequisite graph has not been built has none. */
  readonly edges?: readonly PrereqEdge[];
  readonly setAside?: AvoidanceSetAside;
}

// ------------------------------------------------------- what counts as work

/**
 * The marks that mean the learner DID something, as opposed to being shown
 * something.
 *
 * Deliberately not `SIGNAL_WEIGHT`'s key set. `pin-interest` is a save, and a
 * week of saving pages is not a week of study; `self-skip` and
 * `section-abandoned` are the opposite of finishing. What is counted here is
 * what the contrast needs to be honest: things that were carried through.
 */
const FINISHED_TYPES: readonly SignalType[] = [
  'section-completed', 'answer-correct', 'answer-wrong', 'recall-check',
  'quick-take-got-it', 'quick-take-still-shaky',
  'assessed-strong', 'assessed-gap', 'qc-finding', 'reread-confirmed', 'guide-stuck',
];

/**
 * Every mark that counts as CONTACT with an item, which is a wider set than
 * the one above.
 *
 * Abandoning a section is not finishing it and is very much touching it, and an
 * item somebody opened and walked away from three days ago is not slipping. It
 * is the reason hysteresis needs no separate machinery: any contact at all
 * resets the idle clock and the candidate leaves on the next read.
 */
const isContact = (signal: Signal): boolean => !signal.invalidated;

const newest = (...values: readonly (string | null | undefined)[]): string | null => {
  let best: string | null = null;
  for (const value of values) {
    if (!value || !Number.isFinite(Date.parse(value))) continue;
    if (!best || value > best) best = value;
  }
  return best;
};

const wholeDaysIdle = (touchedAt: string | null, now: Date): number => {
  const days = daysSince(touchedAt, now);
  return Number.isFinite(days) ? Math.max(0, Math.floor(days)) : Infinity;
};

// ---------------------------------------------------------------- standing

/**
 * The topics this board cannot call settled, from the two sources the product contract
 * names: the arithmetic, and what the machine has written about the learner.
 *
 * `PROSPECT_SHAKY_COMFORT` is reused rather than redeclared. Two surfaces that
 * say "you are shaky here" must agree about where shaky begins, and the night
 * scout already fixed that line.
 */
function shakyTopicIds(
  topics: readonly Topic[], statements: readonly Statement[],
): ReadonlySet<TopicId> {
  const out = new Set<TopicId>();
  for (const topic of topics) {
    if (topic.comfort < PROSPECT_SHAKY_COMFORT) out.add(topic.id);
  }
  for (const statement of statements) {
    if (statement.rejected || statement.userEdited || statement.topicId === null) continue;
    const topic = topics.find((candidate) => candidate.id === statement.topicId);
    if (topic && topic.state !== 'settled') out.add(topic.id);
  }
  return out;
}

/** Topics something else on the graph is declared to lean on, and which are
 *  not settled themselves. The graph's own words for "this is owed first". */
function prerequisiteTopicIds(
  topics: readonly Topic[], edges: readonly PrereqEdge[],
): ReadonlySet<TopicId> {
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const out = new Set<TopicId>();
  for (const edge of edges) {
    const from = byId.get(edge.from);
    if (from && !from.retiredByUser && from.state !== 'settled') out.add(from.id);
  }
  return out;
}

const deadlineStanding = (
  commitment: Commitment, now: Date, timeZone: string,
): AvoidanceStanding | null => {
  const state = commitmentState(commitment, now, timeZone);
  if (state === 'late') return 'overdue';
  return state === 'today' || state === 'soon' ? 'due' : null;
};

const strongest = (
  candidates: readonly (AvoidanceStanding | null)[],
): AvoidanceStanding | null => {
  let best: AvoidanceStanding | null = null;
  for (const standing of candidates) {
    if (!standing) continue;
    if (!best || STANDING_WEIGHT[standing] > STANDING_WEIGHT[best]) best = standing;
  }
  return best;
};

// -------------------------------------------------------------- the reading

interface Considered {
  readonly kind: AvoidanceItemKind;
  readonly id: string;
  readonly title: string;
  readonly topicIds: readonly TopicId[];
  readonly standing: AvoidanceStanding | null;
  readonly touchedAt: string | null;
  /** Whether there is honestly something to open in a one-minute block. */
  readonly offerable: boolean;
}

/** The key every surface, ledger and ranker joins on. One spelling, here. */
export const avoidanceKey = (kind: AvoidanceItemKind, id: string): string => `${kind}:${id}`;

/**
 * An action id from the ranker, as an item key, or nothing.
 *
 * The mapping is deliberately partial and the gaps are the honest answer rather
 * than an omission. A recall burst is offered as several topics at once, so a
 * burst that was passed over cannot be attributed to any one of them; a quick
 * take is addressed by pin rather than by topic; a lesson is not an item. Only
 * the two ids that name exactly one item resolve.
 */
export function avoidanceKeyForActionId(actionId: string): string | null {
  const commitment = /^commitment:(.+)$/.exec(actionId);
  if (commitment) return avoidanceKey('commitment', commitment[1] as string);
  const material = /^material:[^:]*:(.+)$/.exec(actionId);
  if (material) return avoidanceKey('material', material[1] as string);
  return null;
}

/**
 * Whether the learner has said, in as many words, that this one is theirs to
 * leave alone for now.
 *
 * A malformed or future-dated stamp reads as no deferral rather than as an
 * eternal one: the failure that costs somebody a row they wanted to see is
 * better than the failure that hides one for ever.
 */
export function isSetAside(
  setAside: AvoidanceSetAside | undefined, key: string, now: Date,
): boolean {
  const at = Date.parse(setAside?.[key] ?? '');
  if (!Number.isFinite(at)) return false;
  return at <= now.getTime() && now.getTime() - at < AVOID_SNOOZE_DAYS * DAY_MS;
}

/** The learner's deferral, recorded. Expired marks are dropped on the way past,
 *  so the record stays the size of what is still true. */
export function recordSetAside(
  setAside: AvoidanceSetAside | undefined, key: string, now: Date,
): AvoidanceSetAside {
  const out: Record<string, string> = {};
  for (const [existing, at] of Object.entries(setAside ?? {})) {
    if (isSetAside(setAside, existing, now)) out[existing] = at;
  }
  out[key] = new Date(now.getTime()).toISOString();
  return out;
}

function considerMaterials(input: AvoidanceInput, shaky: ReadonlySet<TopicId>,
  prerequisite: ReadonlySet<TopicId>, timeZone: string): Considered[] {
  const out: Considered[] = [];
  const pinAt = new Map(input.pins.map((pin) => [pin.id, pin.capturedAt]));
  const topicOfPin = new Map(input.pins.map((pin) => [pin.id, pin.topicId]));
  for (const course of input.courses) {
    if (course.archivedAt) continue;
    const dated = input.commitments
      .filter((commitment) => !commitment.doneAt && commitment.courseId === course.id)
      .map((commitment) => deadlineStanding(commitment, input.now, timeZone));
    for (const material of course.material) {
      if (material.doneAt) continue;
      const topicIds = material.pinIds
        .map((pinId) => topicOfPin.get(pinId) ?? null)
        .filter((topicId): topicId is TopicId => topicId !== null);
      const signalTouch = input.signals
        .filter((signal) => isContact(signal) && topicIds.includes(signal.topicId))
        .map((signal) => signal.at);
      out.push({
        kind: 'material',
        id: material.id,
        title: material.title,
        topicIds,
        standing: strongest([
          ...dated,
          topicIds.some((topicId) => prerequisite.has(topicId)) ? 'prerequisite' : null,
          topicIds.some((topicId) => shaky.has(topicId)) ? 'shaky' : null,
        ]),
        // `addedAt` is the floor rather than a touch: a row nobody has opened
        // since it arrived has been idle since it arrived, which is true.
        touchedAt: newest(material.addedAt,
          ...material.pinIds.map((pinId) => pinAt.get(pinId)), ...signalTouch),
        offerable: canOpen(material),
      });
    }
  }
  return out;
}

/**
 * A material a one-minute block can honestly start.
 *
 * An address, or pins it already produced, which means there is something on
 * the board to work from. A row that is neither is a title somebody typed and
 * offering a minute of it would be offering a minute of nothing. A declared
 * zero-length item has no minute to give either.
 */
const canOpen = (material: Material): boolean =>
  (material.minutes === null || material.minutes > 0)
  && (Boolean(material.url) || material.pinIds.length > 0);

function considerRecall(input: AvoidanceInput, shaky: ReadonlySet<TopicId>,
  prerequisite: ReadonlySet<TopicId>): Considered[] {
  const out: Considered[] = [];
  const pinAt = new Map(input.pins.map((pin) => [pin.id, pin.capturedAt]));
  for (const topic of input.topics) {
    if (topic.retiredByUser) continue;
    const marks = input.signals.filter((signal) =>
      isContact(signal) && signal.topicId === topic.id);
    out.push({
      kind: 'recall',
      id: topic.id,
      title: topic.label,
      topicIds: [topic.id],
      standing: strongest([
        reviewDue(topic.id, input.signals, topic.lastExposedAt, input.now) ? 'due' : null,
        prerequisite.has(topic.id) ? 'prerequisite' : null,
        shaky.has(topic.id) ? 'shaky' : null,
      ]),
      touchedAt: newest(topic.createdAt, topic.lastExposedAt,
        ...marks.map((signal) => signal.at),
        ...topic.pinIds.map((pinId) => pinAt.get(pinId))),
      // A topic with no pin has nothing to teach from, which is the same
      // refusal the ranker already makes before it offers a quick take.
      offerable: topic.pinIds.length > 0,
    });
  }
  return out;
}

function considerCommitments(input: AvoidanceInput, shaky: ReadonlySet<TopicId>,
  prerequisite: ReadonlySet<TopicId>, timeZone: string): Considered[] {
  const out: Considered[] = [];
  for (const commitment of input.commitments) {
    if (commitment.doneAt) continue;
    const marks = input.signals.filter((signal) =>
      isContact(signal) && commitment.topicIds.includes(signal.topicId));
    out.push({
      kind: 'commitment',
      id: commitment.id,
      title: commitment.title,
      topicIds: commitment.topicIds,
      standing: strongest([
        deadlineStanding(commitment, input.now, timeZone),
        commitment.topicIds.some((topicId) => prerequisite.has(topicId)) ? 'prerequisite' : null,
        commitment.topicIds.some((topicId) => shaky.has(topicId)) ? 'shaky' : null,
      ]),
      touchedAt: newest(commitment.createdAt, ...marks.map((signal) => signal.at)),
      // Somewhere real to go: topics the board can teach from, or the course
      // room that lists it. A bare title with neither is a note, not work.
      offerable: commitment.topicIds.length > 0 || Boolean(commitment.courseId),
    });
  }
  return out;
}

/**
 * How much the learner finished on OTHER things inside this item's own idle
 * window.
 *
 * The window is the item's, not a fixed week, so the sentence the surface
 * writes — *"in that time you finished nine other things"* — is exactly true of
 * the time it just named. Closing a commitment and ticking a material both
 * count beside the signal ledger, because both are the learner reporting work
 * this module would otherwise be blind to.
 */
function finishedElsewhere(input: AvoidanceInput, item: Considered, since: number): number {
  const mine = new Set(item.topicIds);
  let count = 0;
  for (const signal of input.signals) {
    if (!isContact(signal) || !FINISHED_TYPES.includes(signal.type)) continue;
    if (mine.has(signal.topicId)) continue;
    const at = Date.parse(signal.at);
    if (Number.isFinite(at) && at >= since) count += 1;
  }
  for (const commitment of input.commitments) {
    if (!commitment.doneAt || (item.kind === 'commitment' && commitment.id === item.id)) continue;
    const at = Date.parse(commitment.doneAt);
    if (Number.isFinite(at) && at >= since) count += 1;
  }
  for (const course of input.courses) {
    for (const material of course.material) {
      if (!material.doneAt || (item.kind === 'material' && material.id === item.id)) continue;
      const at = Date.parse(material.doneAt);
      if (Number.isFinite(at) && at >= since) count += 1;
    }
  }
  return count;
}

export function avoidanceCandidates(input: AvoidanceInput): readonly AvoidanceCandidate[] {
  const timeZone = input.timeZone ?? 'UTC';
  const shaky = shakyTopicIds(input.topics, input.statements ?? []);
  const prerequisite = prerequisiteTopicIds(input.topics, input.edges ?? []);
  const considered = [
    ...considerMaterials(input, shaky, prerequisite, timeZone),
    ...considerRecall(input, shaky, prerequisite),
    ...considerCommitments(input, shaky, prerequisite, timeZone),
  ];

  const found: AvoidanceCandidate[] = [];
  for (const item of considered) {
    const key = avoidanceKey(item.kind, item.id);
    if (!item.standing) continue;
    const idleDays = wholeDaysIdle(item.touchedAt, input.now);
    if (!Number.isFinite(idleDays) || idleDays < AVOID_IDLE_DAYS) continue;
    if (!item.offerable) continue;
    if (isSetAside(input.setAside, key, input.now)) continue;
    const elsewhere = finishedElsewhere(input, item, input.now.getTime() - idleDays * DAY_MS);
    if (elsewhere < AVOID_ELSEWHERE_MIN) continue;
    found.push({
      key,
      kind: item.kind,
      id: item.id,
      title: item.title,
      standing: item.standing,
      idleDays,
      elsewhere,
      score: idleDays * STANDING_WEIGHT[item.standing],
      topicIds: item.topicIds,
    });
  }

  return found
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, AVOID_MAX_SURFACED);
}

// ------------------------------------------------------ the passed-over ledger

/**
 * One mark: something was on offer as the next move, and the learner started
 * something else.
 *
 * Written on a real press and never on a render, because a record that grew
 * while somebody read a screen would count reading as choosing. It is
 * forward-only in the strongest sense: nothing reconstructs it from history,
 * and no line built from it may be shown without the date it started.
 */
export interface PassedOverMark {
  /** The ranker's id for what was offered. Resolved through `avoidanceKeyForActionId`. */
  readonly offeredId: string;
  /** The reason code the offer carried, so the record says what was declined. */
  readonly offeredReason: string;
  readonly chosenId: string;
  readonly at: string;
}

export interface PassedOverLedger {
  /**
   * When this ledger began, or null while it is empty.
   *
   * Kept even after the ring has evicted the marks it describes. Eviction can
   * only make a count smaller, so a claim built on it understates and never
   * overstates, which is the only direction this record is allowed to be wrong.
   */
  readonly startedAt: string | null;
  readonly marks: readonly PassedOverMark[];
}

export const EMPTY_PASSED_OVER_LEDGER: PassedOverLedger = { startedAt: null, marks: [] };

/** A stored ledger, made safe to read. Anything malformed reads as empty. */
export function readPassedOverLedger(value: unknown): PassedOverLedger {
  const row = (value ?? {}) as Partial<PassedOverLedger>;
  const marks = Array.isArray(row.marks) ? row.marks.filter((mark) =>
    typeof mark?.offeredId === 'string' && typeof mark?.chosenId === 'string'
    && typeof mark?.at === 'string') : [];
  return {
    startedAt: typeof row.startedAt === 'string' ? row.startedAt : marks[0]?.at ?? null,
    marks: marks.slice(-AVOID_LEDGER_MAX),
  };
}

/**
 * Append, oldest out at the far end.
 *
 * A ring rather than an unbounded list because this is the one record in the
 * product that grows with ordinary use and is worth nothing old: a mark from
 * March is a mark about a board that no longer exists. Two hundred is roughly a
 * term of daily use, which is longer than any claim made from it.
 */
export function recordPassedOver(
  ledger: PassedOverLedger, mark: PassedOverMark,
): PassedOverLedger {
  const marks = [...ledger.marks, mark].slice(-AVOID_LEDGER_MAX);
  return { startedAt: ledger.startedAt ?? mark.at, marks };
}

/** How many times this exact item was on offer and something else was started. */
export function passedOverCount(ledger: PassedOverLedger, key: string): number {
  return ledger.marks.filter((mark) => avoidanceKeyForActionId(mark.offeredId) === key).length;
}

// ------------------------------------------------------------------- the copy

/** The one thing this list ever offers, said the same way in both places. */
export const AVOIDANCE_SLIPPING_LINE = 'This keeps slipping.';
export const AVOIDANCE_ACTIVATION_LINE = '1 minute of it counts.';

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * A date somebody can read, in the order the rest of this product's copy is
 * written in. `en-GB` for the day-before-month order and nothing else; the
 * stored day is the day, and no zone conversion happens here.
 */
const dayLabel = (iso: string): string => {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    }).format(new Date(iso));
  } catch { return iso.slice(0, 10); }
};

/**
 * One row, as a person reads it.
 *
 * The numbers are the argument and the sentences carry nothing else: no
 * adjective about the learner, no guess at why, no encouragement. What is on
 * screen is what the ledger holds, which is the only thing that survives being
 * disagreed with.
 */
export interface SlippingRow {
  readonly key: string;
  readonly kind: AvoidanceItemKind;
  readonly title: string;
  readonly standing: AvoidanceStanding;
  readonly standingLine: string;
  readonly elsewhereLine: string;
  /**
   * The smallest honest offer, carried on the row rather than written again in
   * the panel.
   *
   * The extension takes no dependency on this package, so any sentence it
   * declares locally is a second copy that can drift from the one the ranker
   * puts under a nudged action. This is the same sentence in both places
   * because it travels from here to both.
   */
  readonly activationLine: string;
  /** Present only when the forward-only ledger has marks about this item. */
  readonly passedOverLine: string | null;
}

const standingLine = (standing: AvoidanceStanding, idleDays: number): string => {
  const gone = `you have not touched it for ${idleDays} ${plural(idleDays, 'day', 'days')}`;
  if (standing === 'overdue') return `Past its date, and ${gone}.`;
  if (standing === 'due') return `Due, and ${gone}.`;
  if (standing === 'prerequisite') return `Other work on your board leans on it, and ${gone}.`;
  return `Not settled yet, and ${gone}.`;
};

/**
 * The rows, with the ledger's claim attached where the ledger has one.
 *
 * The date is not a footnote and is not optional. A count with no start date
 * reads as a count over all time, and this product has only been counting since
 * the first mark it wrote.
 */
export function slippingRows(
  candidates: readonly AvoidanceCandidate[],
  ledger: PassedOverLedger = EMPTY_PASSED_OVER_LEDGER,
): readonly SlippingRow[] {
  return candidates.map((candidate) => {
    const passed = ledger.startedAt ? passedOverCount(ledger, candidate.key) : 0;
    return {
      key: candidate.key,
      kind: candidate.kind,
      title: candidate.title,
      standing: candidate.standing,
      standingLine: standingLine(candidate.standing, candidate.idleDays),
      elsewhereLine: `In that time you finished ${candidate.elsewhere} `
        + `${plural(candidate.elsewhere, 'other thing', 'other things')} on your board.`,
      activationLine: AVOIDANCE_ACTIVATION_LINE,
      passedOverLine: passed && ledger.startedAt
        ? `Offered and passed over ${passed === 1 ? 'once' : `${passed} times`} `
          + `since ${dayLabel(ledger.startedAt)}.`
        : null,
    };
  });
}
