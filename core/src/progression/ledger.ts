import type { DepthRegister, Signal, TopicId } from '../domain/types.js';
import { registerFor } from '../domain/registers.js';
import {
  DEMONSTRATED_TYPES, isDemonstration,
} from '../domain/signals.js';
import { computeComfort, type ComfortResult } from '../agents/registrar.js';

export { DEMONSTRATED_TYPES, isDemonstration } from '../domain/signals.js';

/**
 * The ledger, read back as a history rather than as a number.
 *
 * `computeComfort` answers "what is comfort *now*". Every mechanic in §5a is
 * about a *change* — a register advance, a slip re-earned, a flag closed — and
 * none of them can be stated from one reading. So this replays the ledger: for
 * each signal in turn, comfort as of that signal, using only the signals up to
 * it. The arithmetic is the Registrar's own, called rather than copied, so the
 * projection can never claim a transition the learner model did not make.
 *
 * ## The mapping this file had to choose, and why
 *
 * The spec asks for *demonstrated recall*. No such event exists in the domain:
 * `SignalType` has `answer-correct`, `answer-wrong` and `recall-check`, and
 * nothing that says "the learner recalled this unaided". The closest honest
 * reading is the one below — a **positive** `answer-correct` or `recall-check`
 * — and the exclusions are the load-bearing half:
 *
 *  - `self-skip` is the learner declaring competence, and SB-29 exists to stop
 *    declared comfort counting as demonstrated comfort. A chain that "I know
 *    this" could extend is a chain the skip button farms.
 *  - `section-completed` is attendance. SB-66 is explicit that attendance is
 *    not learning, and a mechanic counting consecutive days of it is the
 *    attendance counter this product bans by name, wearing a hat.
 *  - `reread-confirmed`, `pin-struggle`, `depth-*` are all evidence about
 *    engagement or level, not about recall.
 *
 * Documented here rather than in the report, because this is where the
 * constraint lives and this is where the next person will look.
 */

/** A miss: the same two event classes, answered wrongly. Nothing else counts —
 *  in particular, not turning up is not a miss. */
export const isMiss = (s: Signal): boolean =>
  !s.invalidated && s.direction === 'negative'
  && (s.type === 'answer-wrong' || DEMONSTRATED_TYPES.includes(s.type));

/**
 * How much history one topic's replay will read.
 *
 * The replay is quadratic in the signals on a topic, and the ledger is
 * append-only and grows for ever. This is not untrusted input — every signal
 * here was written by this product — but an unbounded loop over a growing
 * ledger is the same failure with a politer cause, and §3a's third class is
 * exactly the field with no named limit. The most recent window is what every
 * mechanic here is about anyway: a register advance from four years ago is not
 * momentum.
 */
export const MAX_REPLAY_SIGNALS = 240;

export interface LedgerStep {
  readonly at: string;
  readonly signal: Signal;
  readonly comfort: ComfortResult;
  readonly register: DepthRegister;
  /** Demonstrations at or before this step, on this topic. The milestone's
   *  evidence sentence is built from this, not from a count of anything else. */
  readonly demonstrations: number;
  /** The first demonstration on this topic, for the span the evidence states. */
  readonly firstDemonstrationAt: string | null;
}

/** A timestamp the ledger can actually be ordered by. A row with an unparseable
 *  `at` is dropped rather than sorted to the beginning of time. */
const usable = (s: Signal): boolean => Number.isFinite(Date.parse(s.at));

/**
 * The topic's history, one step per live signal, oldest first.
 *
 * Empty for a topic with nothing live on it — which is a real answer and is
 * what every caller checks, rather than a reason to invent a starting state.
 */
export function ledgerHistory(
  topicId: TopicId, signals: readonly Signal[],
): readonly LedgerStep[] {
  const live = signals
    .filter((s) => s.topicId === topicId && !s.invalidated && usable(s))
    .slice()
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-MAX_REPLAY_SIGNALS);

  const steps: LedgerStep[] = [];
  let demonstrations = 0;
  let firstDemonstrationAt: string | null = null;

  for (let i = 0; i < live.length; i += 1) {
    const signal = live[i] as Signal;
    if (isDemonstration(signal)) {
      demonstrations += 1;
      firstDemonstrationAt ??= signal.at;
    }
    // As of this signal, from the signals up to it. Passing `now` would read
    // every historical step through today's recency decay and report
    // transitions that never happened on the night they are dated.
    const comfort = computeComfort(topicId, live.slice(0, i + 1), new Date(signal.at));
    steps.push({
      at: signal.at,
      signal,
      comfort,
      register: registerFor(comfort),
      demonstrations,
      firstDemonstrationAt,
    });
  }
  return steps;
}

const DAY_MS = 86_400_000;

export const daysBetween = (from: string, to: string): number =>
  Math.max(0, (Date.parse(to) - Date.parse(from)) / DAY_MS);

/**
 * "Demonstrated three times across two weeks" — the span half, in the unit that
 * does not overstate it.
 *
 * Weeks once there are weeks, days before that. A run of three answers inside
 * one afternoon reported as "across 1 weeks" would be the milestone claiming a
 * shape of practice that did not happen.
 */
export function spanPhrase(days: number): string {
  const whole = Math.floor(days);
  if (whole >= 14) return `${Math.round(days / 7)} weeks`;
  if (whole >= 7) return 'a week';
  if (whole >= 2) return `${whole} days`;
  return whole === 1 ? 'a day' : 'one sitting';
}

export const timesPhrase = (n: number): string => `${n} time${n === 1 ? '' : 's'}`;
