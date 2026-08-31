/**
 * WHEN A SESSION GETS BUILT — the learner's answer, not the product's.
 *
 * Until now there was no answer, only a cron: one Cloud Scheduler job at
 * `03:00 Etc/UTC`, and no timezone anywhere in the system. `batchKey` was the
 * UTC date, so "a night" was a slice of somebody else's clock. For a learner
 * in Sydney the "nightly" session was built at one in the afternoon, and
 * fifteen strings in the product told them it would be there this run.
 *
 * The learner chooses when scheduled work should be ready.
 *
 * ## The shape
 *
 * Two kinds, because there are two honest answers to "when".
 *
 *  - **`daily`** — a time in the learner's own zone. The session is waiting
 *    when they get there, which is the whole premise of the product: the work
 *    happens while they are not here.
 *  - **`on-demand`** — never on a clock. They ask, it builds. For somebody
 *    whose week has no shape, a scheduled build is a session they did not want
 *    yet, and a board full of those is the backlog The backlog threshold exists to refuse.
 *
 * ## What replaced the cron, and what did not
 *
 * The cron does not go away and does not need to know anything. It becomes a
 * **tick**: fire often, ask this module whether this learner's moment has
 * arrived, and do nothing when it has not. An hourly sweep expresses every
 * timezone on earth without a scheduler per learner, which is the thing that
 * looked expensive and is not.
 *
 * ## Why the day key is local
 *
 * "Once a day" has to mean once in the learner's day or it means nothing: a
 * key cut at UTC midnight rolls over mid-afternoon in Sydney and mid-morning
 * in Auckland, so a learner there gets two sessions on one of their days and
 * none on another. The key is the date in their own zone, which is also what
 * makes "has today's session been built" a question with one answer.
 */

/** The default, for a learner who has never said. Evening, because the premise
 *  is that the work happened while they were away. */
export const DEFAULT_BUILD_HOUR = 20;

export type LearningSchedule =
  | { readonly kind: 'on-demand' }
  | {
    readonly kind: 'daily';
    /** 0 to 23, in `timeZone`. */
    readonly hour: number;
    /** An IANA zone name. The learner's, never the server's. */
    readonly timeZone: string;
  };

export const DEFAULT_SCHEDULE: LearningSchedule = { kind: 'on-demand' };

/**
 * Read a schedule off whatever was stored, or fall back.
 *
 * Defensive because this comes out of a store and off a wire: a zone this
 * runtime cannot resolve, an hour that is a string, a kind from a later build.
 * Every one of them is "no schedule", which means nothing is built on a clock,
 * which is the safe direction: a session nobody asked for is worse than no
 * session, and the learner can still ask.
 */
export function scheduleFrom(raw: unknown): LearningSchedule {
  if (!raw || typeof raw !== 'object') return DEFAULT_SCHEDULE;
  const s = raw as Record<string, unknown>;
  if (s['kind'] === 'on-demand') return { kind: 'on-demand' };
  if (s['kind'] !== 'daily') return DEFAULT_SCHEDULE;

  const hour = s['hour'];
  if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    return DEFAULT_SCHEDULE;
  }
  const timeZone = typeof s['timeZone'] === 'string' ? s['timeZone'] : '';
  if (!isZone(timeZone)) return DEFAULT_SCHEDULE;
  return { kind: 'daily', hour, timeZone };
}

/** Does this runtime know the zone? An unknown one would otherwise throw
 *  somewhere much less convenient, in the middle of a run. */
export function isZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The learner's own date, as `YYYY-MM-DD`.
 *
 * `en-CA` because it formats as ISO and needs no reassembly. An unresolvable
 * zone falls back to UTC rather than throwing: a key that is merely in the
 * wrong zone still counts days, and a run that dies counts nothing.
 */
export function dayKeyFor(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** The hour of `now`, 0 to 23, in the learner's zone. */
export function hourIn(now: Date, timeZone: string): number {
  try {
    const at = new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: '2-digit', hour12: false,
    }).format(now);
    const hour = Number(at.slice(0, 2));
    return Number.isInteger(hour) ? hour % 24 : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

export interface BuildDecision {
  readonly build: boolean;
  /** The learner's day this would be built for. Also the `batchKey`. */
  readonly dayKey: string;
  /** Why not, when not. For the run's own log rather than for a learner. */
  readonly because: 'asked' | 'due' | 'on-demand-only' | 'too-early' | 'already-built';
}

/**
 * Is now the moment, for this learner?
 *
 * Called by whatever is ticking. The answer is a decision plus the day it
 * would be for, because the caller needs both and computing the key twice in
 * two places is how they come to disagree.
 *
 * `asked` outranks everything: a learner pressing the button has said more
 * than any schedule can, and it is the one path that works on `on-demand`.
 * Otherwise the moment has to have arrived in their zone and their day must
 * not already have one. "Arrived" is at-or-past rather than exactly-equal,
 * because a tick that fires late, or not at all for an hour, must not skip a
 * day silently.
 */
export function shouldBuild(input: {
  readonly schedule: LearningSchedule;
  readonly now: Date;
  /** The day key of the last session built, or null on a fresh board. */
  readonly lastBuiltDayKey: string | null;
  /** The learner asked for it, right now. */
  readonly asked?: boolean;
}): BuildDecision {
  const { schedule, now, lastBuiltDayKey } = input;
  const zone = schedule.kind === 'daily' ? schedule.timeZone : 'UTC';
  const dayKey = dayKeyFor(now, zone);

  if (input.asked) return { build: true, dayKey, because: 'asked' };
  if (schedule.kind === 'on-demand') return { build: false, dayKey, because: 'on-demand-only' };
  if (hourIn(now, zone) < schedule.hour) return { build: false, dayKey, because: 'too-early' };
  if (lastBuiltDayKey === dayKey) return { build: false, dayKey, because: 'already-built' };
  return { build: true, dayKey, because: 'due' };
}

/**
 * The zone the browser is in, for seeding the control.
 *
 * Asked once, where the learner is, rather than inferred on a server that is
 * somewhere else entirely. Empty when the runtime will not say, which the
 * caller reads as "ask them".
 */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}
