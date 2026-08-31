import type { TopicId } from './types.js';
import type { SourceRef } from './courses.js';
import { dayKeyFor, isZone } from './schedule.js';

/**
 * COMMITMENTS — what the learner is on the hook for, and the points for doing it.
 *
 * Commitments record learner-chosen work and due dates across platforms.
 *
 * ## Why this is a second ledger and not a field on Topic
 *
 * Virgil knew what the learner had **read** and nothing about what they were
 * **on the hook for**, which is the whole of why it read as a snapshot manager.
 * This is the missing half, and it is deliberately its own ledger because the
 * two answer different questions and are trusted differently:
 *
 *  - the **signal ledger** is evidence about what somebody knows, inferred from
 *    what they did with material. It decides what gets taught and at what
 *    register, so anything that can be typed in at will must not reach it.
 *  - the **commitment ledger** is what the learner told the product they would
 *    do, and when. It is self-reported by construction — a date is typed, a box
 *    is ticked — and that is fine, because nothing here decides what a session
 *    teaches.
 *
 * Points read this ledger. **Points never write a signal**, and that is an
 * engineering constraint rather than a rule about fun: if "ticked a box on
 * time" fed comfort, register selection would drift on evidence about diligence
 * rather than about understanding, and the Composer would start teaching the
 * wrong level to somebody with a tidy calendar.
 *
 * What a due date IS allowed to do is change **what gets taught first**
 * (`dueWeight` below) — an assignment on Friday makes the topics it leans on
 * the ones worth spending tonight on. That is scheduling, not evidence: it
 * reorders the queue and changes no comfort, no register, and no claim about
 * what anybody knows.
 *
 * ## Points
 *
 * Points are earned for completion and stars accumulate on the board.
 * **no punishments.** Late still scores; it just does not score the on-time
 * bonus. Nothing expires, nothing is deducted, nothing resets to zero, and
 * there is no total anybody can lose.
 */

export type CommitmentKind =
  /** Assessed work with a deadline someone else set. */
  | 'assignment'
  /** A class, lecture or lesson to sit through. */
  | 'lesson'
  /** Time the learner has set aside to study, on any platform. */
  | 'study'
  /** Anything else they want to be reminded they said they would do. */
  | 'task';

export const WEEKLY_RECURRENCE_MIN = 2;
export const WEEKLY_RECURRENCE_MAX = 20;
/** The same whole-value boundary governs an assignment whether it came from
 * reviewed intake, one direct Plan write, a weekly series, or a later repair. */
export const COMMITMENT_TITLE_MAX_CHARS = 180;

/** Identity shared by the materialized occurrences of one bounded weekly
 * series. Repeated on each row so deleting one occurrence never deletes the
 * definition needed to edit the others. */
export interface CommitmentRecurrence {
  readonly seriesId: string;
  readonly index: number;
  readonly total: number;
  readonly cadence: 'weekly';
  readonly timeZone: string;
  readonly requestHash: string;
}

export interface Commitment {
  readonly id: string;
  readonly title: string;
  readonly kind: CommitmentKind;
  /** The course it belongs to, when the study controller knows of one. */
  readonly courseId: string | null;
  /**
   * Topics on the board this leans on.
   *
   * The link that makes teaching deadline-aware, and the reason a task manager
   * is worth building inside a learning product rather than beside one.
   */
  readonly topicIds: readonly TopicId[];
  /**
   * Compatibility value for every deadline. Date-only rows keep the historic
   * end-of-day ISO placeholder; timed rows store the resolved UTC instant.
   * `dueTime` is what distinguishes those meanings.
   */
  readonly dueAt: string;
  /** Original wall time when the source or learner stated one. Absent on every
   * legacy row and null/absent for an intentionally date-only obligation. */
  readonly dueTime?: string | null;
  /** IANA zone owning `dueTime`. Present iff a valid timed deadline exists. */
  readonly dueTimeZone?: string | null;
  /** Present only on a materialized occurrence from a bounded series. */
  readonly recurrence?: CommitmentRecurrence | null;
  /**
   * When the learner said they would do it, which is not when it is due.
   *
   * A promise to themselves, and the only thing here that can earn the
   * kept-promise award. Null when they never made one — most commitments.
   */
  readonly plannedFor: string | null;
  readonly estimateMinutes: number | null;
  readonly notes: string;
  /** ISO when closed, null while open. Closing is the only scoring event. */
  readonly doneAt: string | null;
  readonly createdAt: string;
  /** Present when this obligation was confirmed from a source draft. */
  readonly source?: SourceRef | null;
  readonly rubricCriteria?: readonly {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly topicIds: readonly TopicId[];
    readonly source: SourceRef;
  }[];
}

/**
 * What the learner has earned, as an append-only list.
 *
 * A ledger rather than a counter for the same reason the signal ledger is one:
 * a number in a field is a number nobody can check, and *"why do I have 240
 * points"* has to have an answer. Every award names what it was for and when.
 */
export type AwardReason =
  /** Closed it at all. The base award; late work still earns this. */
  | 'closed'
  /** Closed on or before it was due. */
  | 'on-time'
  /** Closed on or before the day they said they would do it. */
  | 'kept-promise'
  /** Finished a quick burst. */
  | 'burst';

export interface Award {
  readonly id: string;
  readonly at: string;
  readonly points: number;
  readonly reason: AwardReason;
  /** What earned it. Exactly one of these is set. */
  readonly commitmentId: string | null;
  readonly topicId: TopicId | null;
}

/** Base for closing anything. Late work earns this and only this. */
export const POINTS_CLOSED = 10;
/** For closing it by the deadline. */
export const POINTS_ON_TIME = 5;
/** For closing it by the day they told themselves they would. */
export const POINTS_KEPT_PROMISE = 3;
/**
 * A star every this many points.
 *
 * Chosen so that a first star is reachable in a day of ordinary use — roughly
 * three closed commitments — and so the board fills over weeks rather than in
 * an afternoon.
 */
export const POINTS_PER_STAR = 50;

/** Stars are a projection of the total, so they can never disagree with it. */
export const starsFrom = (points: number): number =>
  points <= 0 ? 0 : Math.floor(points / POINTS_PER_STAR);

/** Points toward the next star, for the board's faint progress. 0..1. */
export function towardNextStar(points: number): number {
  if (points <= 0) return 0;
  return (points % POINTS_PER_STAR) / POINTS_PER_STAR;
}

export const totalPoints = (awards: readonly Award[]): number =>
  awards.reduce((sum, a) => sum + a.points, 0);

/** Complete recurrence metadata, or an ordinary legacy row. Corrupt/partial
 * metadata never grants a bulk-edit scope. */
export const hasRecurrence = (
  c: Pick<Commitment, 'recurrence'>,
): c is { readonly recurrence: CommitmentRecurrence } => {
  const r = c.recurrence;
  return !!r && typeof r.seriesId === 'string' && r.seriesId.length > 0 && r.seriesId.length <= 120
    && Number.isInteger(r.index) && Number.isInteger(r.total)
    && r.index >= 0 && r.total >= WEEKLY_RECURRENCE_MIN
    && r.total <= WEEKLY_RECURRENCE_MAX && r.index < r.total
    && r.cadence === 'weekly' && isZone(r.timeZone)
    && /^sha256:[a-f0-9]{64}$/.test(r.requestHash);
};

/** Calendar dates at a weekly cadence. UTC is used only as a calendar
 * arithmetic container; no instant or machine timezone enters the result. */
export function weeklyDates(start: string, count: number): readonly string[] | null {
  if (!Number.isInteger(count)
      || count < WEEKLY_RECURRENCE_MIN || count > WEEKLY_RECURRENCE_MAX) return null;
  const dates = Array.from({ length: count }, (_, index) => calendarDateAfterWeeks(start, index));
  return dates.every((date): date is string => date !== null) ? dates : null;
}

export function calendarDateAfterWeeks(start: string, weeks: number): string | null {
  const match = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(start);
  if (!match || !Number.isInteger(weeks) || weeks < 0 || weeks >= WEEKLY_RECURRENCE_MAX) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const anchor = Date.UTC(year, month - 1, day);
  const check = new Date(anchor);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1
      || check.getUTCDate() !== day) return null;
  return new Date(anchor + weeks * 7 * 86_400_000).toISOString().slice(0, 10);
}

/** Whether this row carries the complete timed-deadline extension. Partial
 * legacy data fails safely to date-only rather than inventing an instant. */
export const hasTimedDeadline = (
  c: Pick<Commitment, 'dueAt' | 'dueTime' | 'dueTimeZone'>,
): c is Pick<Commitment, 'dueAt'> & { readonly dueTime: string; readonly dueTimeZone: string } => {
  if (typeof c.dueTime !== 'string' || !/^\d{2}:\d{2}$/.test(c.dueTime)
      || typeof c.dueTimeZone !== 'string' || !isZone(c.dueTimeZone)
      || !Number.isFinite(Date.parse(c.dueAt))) return false;
  const [hour, minute] = c.dueTime.split(':').map(Number);
  return hour! >= 0 && hour! <= 23 && minute! >= 0 && minute! <= 59;
};

/** Human clock label for a complete timed deadline. */
export const deadlineTimeLabel = (
  c: Pick<Commitment, 'dueAt' | 'dueTime' | 'dueTimeZone'>,
): string => {
  if (!hasTimedDeadline(c)) return '';
  try {
    return new Intl.DateTimeFormat('en', {
      timeZone: c.dueTimeZone, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(c.dueAt)).replace(/\b(AM|PM)\b/, (x) => x.toLowerCase());
  } catch { return c.dueTime; }
};

/** The calendar date on which the deadline was declared. Timed work owns the
 * date in its stored zone; date-only work owns the literal date entered. */
export const deadlineDay = (
  c: Pick<Commitment, 'dueAt' | 'dueTime' | 'dueTimeZone'>,
): string => hasTimedDeadline(c) ? dayKeyFor(new Date(c.dueAt), c.dueTimeZone) : c.dueAt.slice(0, 10);

/** Resolve a local wall clock through the runtime IANA database.
 *
 * Probing offsets around the target catches both sides of a DST transition
 * without assuming every zone moves by one hour. A repeated time deliberately
 * chooses the later instant: a deadline must not expire at the first of two
 * equally valid occurrences. A spring-forward gap has no candidate and is
 * refused by returning null. */
export function resolveLocalDeadline(
  date: string, time: string, timeZone: string,
): string | null {
  const dm = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dm || !tm || !isZone(timeZone)) return null;
  const year = Number(dm[1]);
  const month = Number(dm[2]);
  const day = Number(dm[3]);
  const hour = Number(tm[1]);
  const minute = Number(tm[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wallUtc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1
      || check.getUTCDate() !== day || check.getUTCHours() !== hour
      || check.getUTCMinutes() !== minute) return null;

  const localParts = (at: number): readonly number[] => {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(at));
    const part = (type: string): number => Number(parts.find((x) => x.type === type)?.value ?? NaN);
    return [part('year'), part('month'), part('day'), part('hour'), part('minute')];
  };
  const offsets = new Set<number>();
  for (let delta = -36; delta <= 36; delta += 6) {
    const probe = wallUtc + delta * 3_600_000;
    const [py, pm, pd, ph, pmin] = localParts(probe);
    if ([py, pm, pd, ph, pmin].every(Number.isFinite)) {
      offsets.add(Date.UTC(py!, pm! - 1, pd!, ph!, pmin!) - probe);
    }
  }
  const candidates = [...offsets]
    .map((offset) => wallUtc - offset)
    .filter((at) => {
      const [cy, cm, cd, ch, cmin] = localParts(at);
      return cy === year && cm === month && cd === day && ch === hour && cmin === minute;
    });
  if (!candidates.length) return null;
  return new Date(Math.max(...candidates)).toISOString();
}

/** A date-only stored deadline belongs to the learner's calendar. Keeping the
 * declared and observed operations distinct prevents a Sydney Friday morning
 * from being scored as Thursday simply because the service clock is UTC. */
const observedDay = (iso: string, timeZone: string): string =>
  dayKeyFor(new Date(iso), timeZone);

/**
 * What closing this commitment earns, decided from the commitment alone.
 *
 * `closedAt` is passed rather than read from a clock so the same close scores
 * the same way when it is replayed, and so a test can put a close on either
 * side of a deadline without waiting for one.
 *
 * **On time is measured by day, not by instant.** A deadline of "Friday" that
 * the learner met at 23:58 on Friday was met, and a product that says otherwise
 * because the stored time was midnight is arguing with them about something
 * they are right about.
 */
export function awardsForClosing(
  c: Commitment, closedAt: string, timeZone = 'UTC',
): readonly Omit<Award, 'id'>[] {
  const out: Omit<Award, 'id'>[] = [
    { at: closedAt, points: POINTS_CLOSED, reason: 'closed', commitmentId: c.id, topicId: null },
  ];
  const onTime = hasTimedDeadline(c)
    ? Date.parse(closedAt) <= Date.parse(c.dueAt)
    : observedDay(closedAt, timeZone) <= deadlineDay(c);
  if (onTime) {
    out.push({ at: closedAt, points: POINTS_ON_TIME, reason: 'on-time', commitmentId: c.id, topicId: null });
  }
  if (c.plannedFor && observedDay(closedAt, timeZone) <= c.plannedFor.slice(0, 10)) {
    out.push({ at: closedAt, points: POINTS_KEPT_PROMISE, reason: 'kept-promise', commitmentId: c.id, topicId: null });
  }
  return out;
}

/**
 * The awards a close should actually pay, read against what this commitment
 * has already been paid.
 *
 * Ana ticked a reading, reopened it because she had only skimmed it, and ticked
 * it again — and was paid the full set twice, for one piece of work. The tick
 * counter is the one number in the product that claims to be arithmetic, so it
 * has to be.
 *
 * Two rules meet here and both survive. **Reopening takes nothing away** — the
 * awards are a record of a moment that did happen, and a ledger that can be
 * rewound is one somebody can farm by ticking and unticking. And **a second
 * close pays nothing**, because the work was already paid for. What is
 * de-duplicated is the reason, not the close: if the first close was late and
 * earned only `closed`, a later close still cannot earn `on-time`, because
 * on-time is a fact about a deadline that has passed and not a prize for
 * trying again.
 *
 * Keyed on `commitmentId` + `reason` rather than on a "paid" flag on the
 * commitment, so the ledger stays the single answer to *why do I have this
 * many points* and no second place can disagree with it.
 */
export function unpaidAwardsForClosing(
  c: Commitment,
  closedAt: string,
  ledger: readonly Award[],
  timeZone = 'UTC',
): readonly Omit<Award, 'id'>[] {
  const alreadyPaid = new Set(
    ledger.filter((a) => a.commitmentId === c.id).map((a) => a.reason),
  );
  return awardsForClosing(c, closedAt, timeZone).filter((a) => !alreadyPaid.has(a.reason));
}

/**
 * Where a commitment stands.
 *
 * `late` rather than `overdue`, and it is a fact rather than an accusation:
 * nothing in the product deducts for it, no count of it is shown in a warning
 * colour, and closing it still scores. The state exists so the ordering can put
 * it where the learner will see it, which is the only help a product can
 * honestly give somebody who has missed a date.
 */
export type CommitmentState = 'done' | 'late' | 'today' | 'soon' | 'later';

/** Inside this many days is "soon" — near enough to plan around. */
export const SOON_DAYS = 7;

export function commitmentState(c: Commitment, now: Date, timeZone = 'UTC'): CommitmentState {
  if (c.doneAt) return 'done';
  if (hasTimedDeadline(c) && now.getTime() > Date.parse(c.dueAt)) return 'late';
  const zone = hasTimedDeadline(c) ? c.dueTimeZone : timeZone;
  const today = dayKeyFor(now, zone);
  const due = deadlineDay(c);
  if (due < today) return 'late';
  if (due === today) return 'today';
  const days = (Date.parse(`${due}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / 86_400_000;
  return days <= SOON_DAYS ? 'soon' : 'later';
}

const STATE_ORDER: Record<CommitmentState, number> = {
  late: 0, today: 1, soon: 2, later: 3, done: 4,
};

/**
 * The order the learner reads them in: what is late, then today, then the rest
 * by date. Stable on title so the list does not shuffle between renders.
 */
export function orderCommitments(
  cs: readonly Commitment[], now: Date, timeZone = 'UTC',
): readonly Commitment[] {
  return [...cs].sort((a, b) => {
    const byState = STATE_ORDER[commitmentState(a, now, timeZone)]
      - STATE_ORDER[commitmentState(b, now, timeZone)];
    if (byState !== 0) return byState;
    if (a.dueAt !== b.dueAt) return a.dueAt < b.dueAt ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

/**
 * How much a due date should pull a topic forward in tonight's session.
 *
 * **This is the capability the whole commitment layer exists to unlock.** The
 * Gardener schedules by decay, which is right when nothing is at stake and
 * wrong the week before an assignment: a topic the learner is comfortable with
 * and is examined on in three days outranks a topic that has merely gone quiet.
 *
 * Returns a multiplier, never an override. A weight that could reorder the
 * board on its own would let a typed-in date decide what somebody is taught,
 * and a date is not evidence — so the strongest thing it can do is win a close
 * call between two candidates the Gardener already considered.
 *
 *  - nothing due: 1 (unchanged)
 *  - due inside a week: rises smoothly to 1.6 on the day
 *  - late and still open: 1.6, because the deadline has not stopped mattering
 *
 * Done commitments weigh nothing. The point is what is coming, not what was.
 */
export const DUE_WEIGHT_MAX = 1.6;

export function dueWeight(
  topicId: TopicId,
  commitments: readonly Commitment[],
  now: Date,
  timeZone = 'UTC',
): number {
  // Measured in whole days, like every other deadline judgement here. By the
  // instant, a thing due at 23:59 tonight would weigh fractionally less than
  // the same thing due at 09:00 — a distinction no learner is making, and one
  // that would make the weight jitter through the day.
  let strongest = 1;
  for (const c of commitments) {
    if (c.doneAt || !c.topicIds.includes(topicId)) continue;
    const zone = hasTimedDeadline(c) ? c.dueTimeZone : timeZone;
    const today = Date.parse(`${dayKeyFor(now, zone)}T00:00:00.000Z`);
    const days = (Date.parse(`${deadlineDay(c)}T00:00:00.000Z`) - today) / 86_400_000;
    if (days > SOON_DAYS) continue;
    // Late counts as due today rather than as maximally overdue: an assignment
    // three weeks late must not outrank one due tomorrow for ever.
    const nearness = days <= 0 ? 1 : 1 - days / SOON_DAYS;
    strongest = Math.max(strongest, 1 + nearness * (DUE_WEIGHT_MAX - 1));
  }
  return strongest;
}
