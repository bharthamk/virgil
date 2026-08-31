import type { SignalType, TopicId } from './types.js';
import { QUICK_TAKE_MARKS, type QuickTakeMark } from './signals.js';
import type { ModalityKind } from './types.js';


// ------------------------------------------------------------- what was sent

/**
 * What kind of thing left.
 *
 * `lesson` and `material` are the two payloads the product can hand over: a
 * prepared lesson, or the pages the learner saved on a subject. `manual` is the
 * learner writing down something that left without Virgil, which is most of
 * what leaves anybody's day.
 */
export const EXTERNAL_KINDS = ['lesson', 'material', 'manual'] as const;
export type ExternalKind = typeof EXTERNAL_KINDS[number];

/**
 * Where it went.
 *
 * The first four are the destinations the rail offers, named by what they are
 * rather than by the mechanism behind them, so a record written today still
 * reads correctly if the side panel ever becomes something a page can open.
 * `manual` is the learner's own entry, where the destination is whatever they
 * typed or nothing at all.
 */
export const EXTERNAL_DESTINATIONS = [
  'new-tab', 'window', 'side-panel', 'notebook', 'manual',
] as const;
export type ExternalDestination = typeof EXTERNAL_DESTINATIONS[number];

/** A label is a heading, a subject, or the learner's own words. Bounded like
 *  every other title this product stores, and for the same reason: an unbounded
 *  field is an unbounded document. */
export const EXTERNAL_LABEL_MAX_CHARS = 180;

/**
 * How long a note on an entry may be.
 *
 * The same bound as `LEARNER_STATEMENT_MAX_CHARS`, deliberately. The note can be
 * offered to the insight door as the learner's own sentence, and a note that
 * fitted here and was refused there would be a control that lies about what it
 * will accept.
 */
export const EXTERNAL_NOTE_MAX_CHARS = 1_000;

// ------------------------------------------------------------- the marks

/**
 * The five things a learner can say about an entry, and only four of them are
 * marks.
 *
 * `Remove` is on the same row in front of the learner because it answers the
 * same question — what do I want to happen to this row — and it is not in this
 * list because it writes nothing. Keeping it out by type is what stops a later
 * change quietly giving deletion a signal.
 */
export const EXTERNAL_MARKS = ['done', 'easy', 'hard', 'skipped'] as const;
export type ExternalMark = typeof EXTERNAL_MARKS[number];

/**
 * WHAT EACH MARK WRITES, AND THE ONE PLACE `done` IS DELIBERATELY SMALLER THAN
 * IT LOOKS.
 *
 * `easy` and `hard` are  two readings, unchanged: the learner read
 * something and said how it landed. That is exactly what the quick take's close
 * means by *got it* and *still shaky*, so they are those marks and not copies
 * of them.
 *
 * `skipped` borrows `lineup-not-now` for the same reason the quick take does.
 * It is a decision about timing, made about a topic, and it holds the topic out
 * of selection for `NOT_NOW_DAYS` through `notNowMark`, which already exists and
 * already tells the learner when it comes back.
 *
 * **`done` is a comfort mark and not a completion.** A section in a session is
 * completed by `markCompleted`, and the service reaches that in exactly two
 * places: a correct answer to the section's own question, and the learner
 * pressing *I know this* on the section in front of them. Both of those are
 * things that happened INSIDE the lesson. An entry saying a lesson was finished
 * somewhere else cannot claim either: nobody marked an answer, no question was
 * put, and the section the learner was looking at when they pressed a send
 * button may not even be the section they finished out there. Completing it
 * from here would put `completionEvidence: 'answer'` or `'known'` on a section
 * that saw neither, and every read downstream would believe it.
 *
 * So `done` writes the honest lesser fact: the same comfort mark `easy` writes,
 * plus the entry's own `mark` state, which is where "I finished this" actually
 * lives. The receipt says as much on the screen.
 */
export const EXTERNAL_MARK_WRITES: Readonly<Record<ExternalMark, QuickTakeMark>> = {
  done: QUICK_TAKE_MARKS['got-it'],
  easy: QUICK_TAKE_MARKS['got-it'],
  hard: QUICK_TAKE_MARKS['still-shaky'],
  skipped: QUICK_TAKE_MARKS['not-now'],
};

/**
 * The `sourceEvent` every mark on one entry is written under.
 *
 * The same shape as `quick-take:<pin>` and `lineup-verdict:<session>:<topic>`,
 * and the same discipline: one active source event per entry, so changing a
 * mark withdraws the old one rather than leaving two marks to argue. The entry
 * id is minted by the service, so nothing a client sends can widen this.
 */
export const externalSourceEvent = (id: string): string => `external:${id}`;

// ------------------------------------------------------------- the methods

/**
 * How the learner says they worked on it. Four, closed, and declared.
 *
 * Closed for the same reason `MODALITY_KINDS` is closed: an open field about
 * how somebody learns fills up with categories nobody can check. Declared, and
 * that word is doing the work below.
 */
export const EXTERNAL_METHODS = ['read', 'watched', 'listened', 'hands-on'] as const;
export type ExternalMethod = typeof EXTERNAL_METHODS[number];

/**
 * WHAT A DECLARED METHOD IS WORTH TO THE MODALITY MACHINERY, WHICH IS NOTHING,
 * AND WHY THAT IS THE FINDING RATHER THAN A GAP.
 *
 * Two separate reasons, and either one on its own would be enough.
 *
 * **They are not the same vocabulary.** `MODALITY_KINDS` describes what a piece
 * of MATERIAL demands: notation, vocabulary recall, structure, or doing the
 * thing. These four describe how the learner took it in. Only `hands-on`
 * corresponds to a kind at all, and the other three correspond to nothing —
 * a page of formulas can be read, watched or listened to and is notation heavy
 * in all three cases. A map that paired *read it* with *language recall* would
 * be inventing the correspondence it claims to record.
 *
 * **Declared statements may not feed the claim they would then be asked to
 * confirm.** `MODALITY_ASSESSED_TYPES` excludes the learner's own read of their
 * own reading on purpose, and the quick-take marks are excluded by name. A
 * method the learner typed in is further from a checked outcome than those are,
 * so it does not get in through a side door.
 *
 *  honest path for a learner-authored claim about themselves is a
 * `Statement`: written by the pipeline as a question with its numbers in it,
 * confirmed by a person, capped at one live contrast per board. A declared
 * method is not a contrast, has no numbers in it and is about one page rather
 * than about the board, so there is nothing for that path to carry.
 *
 * The methods are therefore stored on the entry and read nowhere else. This map
 * exists so the correspondence is written down and can be argued with rather
 * than rediscovered, and `null` is the honest answer for three of the four.
 */
export const EXTERNAL_METHOD_MODALITY: Readonly<Record<ExternalMethod, ModalityKind | null>> = {
  read: null,
  watched: null,
  listened: null,
  'hands-on': 'hands-on',
};

// ------------------------------------------------------------- the entry

/** One handoff, and what the learner made of it. */
export interface ExternalEntry {
  /** Minted by the service. A client never chooses one. */
  readonly id: string;
  /** Browser retry identity. Optional on historical/manual rows. */
  readonly clientRef?: string | null;
  readonly kind: ExternalKind;
  /** The lesson's heading, the topic's label, or the learner's own words. */
  readonly label: string;
  readonly destination: ExternalDestination;
  /** Where the learner said it went, for a manual entry that named somewhere.
   *  Absent on every recorded send, which names its destination properly. */
  readonly destinationSaid?: string | null;
  readonly sentAt: string;
  /** The session the lesson came out of, when it came out of one. */
  readonly sessionId?: string | null;
  /** What a mark on this entry would be about. Null on an entry with nothing on
   *  the board behind it, which is what makes a mark degrade honestly. */
  readonly topicId?: TopicId | null;
  /** The course material this went out with, where there was one. */
  readonly materialId?: string | null;
  readonly note?: string | null;
  readonly methods?: readonly ExternalMethod[];
  /** The learner's one mark, or null while they have not made one. */
  readonly mark?: ExternalMark | null;
  readonly markedAt?: string | null;
  /**
   * The mark was recorded on this row and nowhere else, because the row has no
   * topic behind it. Sent to the surface so it can say so, rather than left for
   * the panel to work out from a missing field.
   */
  readonly markLocalOnly?: boolean;
}

/**
 * Newest first, by the instant the thing was sent.
 *
 * Sent rather than marked, deliberately. The list is a record of what left, and
 * marking an old row is not a reason for it to jump to the top of a history.
 * Ties break on the id so two entries recorded in the same millisecond — which
 * a double press really can produce — have a stable order.
 */
export function externalNewestFirst(
  entries: readonly ExternalEntry[],
): readonly ExternalEntry[] {
  return [...entries].sort((a, b) =>
    (a.sentAt === b.sentAt ? a.id.localeCompare(b.id) : b.sentAt.localeCompare(a.sentAt)));
}

/** Whether a string the client sent is one of the kinds on offer. Written as a
 *  narrowing so the caller gets the type back rather than a boolean it has to
 *  remember to act on, exactly like `isModalityKind`. */
export const isExternalKind = (value: unknown): value is ExternalKind =>
  typeof value === 'string' && (EXTERNAL_KINDS as readonly string[]).includes(value);

export const isExternalDestination = (value: unknown): value is ExternalDestination =>
  typeof value === 'string' && (EXTERNAL_DESTINATIONS as readonly string[]).includes(value);

export const isExternalMark = (value: unknown): value is ExternalMark =>
  typeof value === 'string' && (EXTERNAL_MARKS as readonly string[]).includes(value);

export const isExternalMethod = (value: unknown): value is ExternalMethod =>
  typeof value === 'string' && (EXTERNAL_METHODS as readonly string[]).includes(value);

/**
 * The methods a client offered, admitted rather than repaired.
 *
 * Same refusal as `admitModalityKinds` and `admitProspectProposals`: anything
 * outside the closed set is dropped, duplicates collapse, and the order is the
 * vocabulary's rather than the request's so two identical requests store the
 * same row.
 */
export function admitExternalMethods(value: unknown): readonly ExternalMethod[] {
  if (!Array.isArray(value)) return [];
  const offered = new Set(value.filter(isExternalMethod));
  return EXTERNAL_METHODS.filter((method) => offered.has(method));
}

/** The signal kind a mark writes, for a caller that wants to check one without
 *  reaching into the table. Every one of them is a kind that already existed. */
export const externalMarkSignalType = (mark: ExternalMark): SignalType =>
  EXTERNAL_MARK_WRITES[mark].type;
