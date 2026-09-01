import type {
  DepthRegister, Session, Signal, SignalType, Topic, TopicId, WithheldNote,
} from './types.js';
import { REGISTER_ORDER } from './registers.js';

/**
 * UX_SPEC §5 — what the four zones of the main page are allowed to claim.
 *
 * The templates live in the panel; the judgements live here, for the same
 * reason `panel-core.ts` exists: the risk on this screen is not the markup, it
 * is a card that says "nothing ready yet" on a night when three sections were
 * withheld for failing verification. That is the D14 shape and §3a's last row —
 * every stage green, the learner told something untrue — and it is the failure
 * this file is written to make impossible rather than unlikely.
 *
 * Deterministic, no I/O, no model. The service reads the store, runs the
 * Gardener it already runs, and hands the answers in.
 */

/**
 * A note on the word this file used to use.
 *
 * Every line here said "this run", and the product does not own that clock. The
 * run is a single cron at 03:00 UTC with no timezone anywhere in the system,
 * so "this run" is early afternoon for a learner in Sydney and the middle of a
 * working morning further east. Copy therefore names the work, not a fixed run.
 *
 * So the copy names the thing rather than the hour: the next session, the next
 * run, your session. When the schedule becomes the learner's, none of these
 * sentences has to change, which is the test of whether they were honest.
 */
// ------------------------------------------------- zone 1: the ready session

/**
 * The Gardener's decision, structurally.
 *
 * `GardenDecision` satisfies this exactly. It is restated rather than imported
 * because the Gardener is an agent and this is the domain underneath the
 * agents; importing upwards is the inversion `seam-purity.test.ts` exists to
 * catch. The point is the `reason` field: §5 asks for *the Gardener's actual
 * reason, stated*, so the why-line is carried from the scheduler rather than
 * written again here in words that would drift from it.
 */
export interface TopicReason {
  readonly topicId: TopicId;
  readonly disposition: string;
  readonly reason: string;
  readonly priority: number;
}

/**
 * The four honest variants, and nothing else.
 *
 *  - `ready`        — a session is built and has something left in it.
 *  - `building`     — material has arrived since the last session was built.
 *  - `withheld`     — the run produced sections and the Verifier refused them.
 *  - `nothing-ready`— genuinely nothing, with the reason said out loud.
 *
 * `withheld` outranks `building` deliberately. A night that composed sections
 * and then withheld all of them is not a night that is still working: it is the
 * safety check doing its job, and §5 is explicit that the UI is not to be
 * embarrassed by it.
 */
export type SessionCardState = 'ready' | 'building' | 'withheld' | 'nothing-ready';

export interface SessionCard {
  readonly state: SessionCardState;
  readonly sessionId: string | null;
  /**
   * The session's name.
   *
   * The leading section's heading, because a `Session` has no title of its own
   * — the Composer names sections, not sessions. §5 asks for a
   * "misconception-named session title" and the headings are the nearest thing
   * the domain actually holds; naming sessions would mean changing the
   * Composer's prompt, which this work does not touch.
   */
  readonly title: string;
  /** Minutes left, counting only what is not done. Computed, never claimed. */
  readonly minutes: number;
  /** The registers present, in ladder order, for the three colours the site carries. */
  readonly registers: readonly DepthRegister[];
  /** One line of why-these-topics, in the scheduler's own words. Null when
   *  there are no topics for it to be about. */
  readonly why: string | null;
  /** The withheld sections, named. Empty in every other state. */
  readonly withheld: readonly WithheldNote[];
  /** The honest reason, for the states that owe one. Null for `ready`. */
  readonly reason: string | null;
}

export interface SessionCardInput {
  readonly session: Session | null;
  readonly topics: readonly Topic[];
  readonly decisions: readonly TopicReason[];
  /** Pins captured since the session was built — or every pin, if none was. */
  readonly pinsWaiting: number;
}

export function sessionCard(input: SessionCardInput): SessionCard {
  const { session, topics, decisions, pinsWaiting } = input;
  const labels = new Map(topics.map((t) => [t.id, t.label]));

  const sections = Array.isArray(session?.sections) ? session.sections : [];
  const left = sections.filter((s) => !s.completed);
  const withheld = (session?.withheld ?? []).filter((w) => w && typeof w.heading === 'string');

  if (sections.length) {
    return {
      state: 'ready',
      sessionId: session?.id ?? null,
      title: sections[0]?.heading ?? 'Your session',
      minutes: Math.round(left.reduce((a, s) => a + (Number(s.estimatedMinutes) || 0), 0)),
      registers: registersIn(sections.map((s) => s.depth)),
      why: whyLine(sections.map((s) => s.topicId), decisions, labels),
      withheld: [],
      reason: null,
    };
  }

  /**
   * A session was built and nothing survived the check.
   *
   * This is the state the panel used to render as "Nothing ready yet" — a true
   * sentence about the screen and a false one about the night. Naming it is the
   * whole point: the withhold is the product working, and a learner who is told
   * "nothing ready" learns nothing about why, while a learner told a section
   * failed its check learns that something is checking.
   */
  if (withheld.length) {
    return {
      state: 'withheld',
      sessionId: session?.id ?? null,
      title: withheld[0]?.heading ?? 'Held back',
      minutes: 0,
      registers: [],
      why: null,
      withheld,
      reason: withheldReason(withheld),
    };
  }

  if (pinsWaiting > 0) {
    return {
      state: 'building',
      sessionId: null,
      title: 'Being built',
      minutes: 0,
      registers: [],
      why: whyLine(decisions.map((d) => d.topicId), decisions, labels),
      withheld: [],
      // Said as what it is: material is waiting for the next run. This is NOT a
      // claim that a run is in flight — nothing in the store records that, and
      // a card that said "working on it now" would be inventing a fact about a
      // process it cannot see.
      // The event-driven processing contract: nothing picks them up on its own. Telling somebody a run is
      // coming for their pins is telling them to wait for a thing that does not
      // exist, and it is the sentence the front door was still printing under a
      // heading that had already been corrected.
      reason: `${pinsWaiting} thing${pinsWaiting === 1 ? '' : 's'} on your board, waiting for you to process ${pinsWaiting === 1 ? 'it' : 'them'}.`,
    };
  }

  return {
    state: 'nothing-ready',
    sessionId: null,
    title: 'Nothing ready',
    minutes: 0,
    registers: [],
    // The same line the building state carries, for the same reason: a board
    // can hold decisions — a still-shaky flag, a due review — without holding
    // a session, and the card is where the night says whose idea the next one
    // is. This used to ride on the building state alone, which only showed it
    // while the waiting-pins count was wrong (SB-61 caught the coupling when
    // the count was fixed).
    why: whyLine(decisions.map((d) => d.topicId), decisions, labels),
    withheld: [],
    reason: nothingReason(topics, decisions),
  };
}

/** In ladder order and deduped, so the card reads from-nothing → fluent however
 *  the sections happen to be ordered. An unrecognised register is dropped
 *  rather than shown as a fourth colour nothing has a name for. */
function registersIn(depths: readonly string[]): readonly DepthRegister[] {
  return REGISTER_ORDER.filter((r) => depths.includes(r));
}

/**
 * Why these topics this run, in the Gardener's words.
 *
 * The highest-priority decision among this run's topics, which is the same
 * ordering the session itself was built from — so the line names the thing that
 * actually drove the night rather than whichever section happens to be first.
 */
function whyLine(
  topicIds: readonly TopicId[], decisions: readonly TopicReason[], labels: Map<TopicId, string>,
): string | null {
  const relevant = decisions
    .filter((d) => topicIds.includes(d.topicId) && d.reason)
    .slice()
    .sort((a, b) => b.priority - a.priority);
  const top = relevant[0];
  if (!top) return null;
  const label = labels.get(top.topicId);
  // A colon rather than the dash this line used to carry. The learner-controlled lineup contract's copy
  // law bans the em-dash and the en-dash from everything a learner reads, and
  // this sentence is the one that put one on the front door: *"Operating System
  // Execution — nothing has been asked about this yet"*, which was the first
  // first thing a learner sees.
  return label ? `${label}: ${top.reason}` : top.reason;
}

/** Named plainly, and counted apart, because "the check found a problem" and
 *  "the check could not run" are different facts about the night. */
function withheldReason(withheld: readonly WithheldNote[]): string {
  const defective = withheld.filter((w) => w.reason === 'defective').length;
  const unverified = withheld.length - defective;
  const parts: string[] = [];
  if (defective) parts.push(`${defective} section${defective === 1 ? '' : 's'} failed the check`);
  if (unverified) parts.push(`${unverified} could not be checked`);
  return `${parts.join(' and ')}, so ${withheld.length === 1 ? 'it was' : 'they were'} held back rather than taught.`;
}

/**
 * The honest empty state, with the reason (SB-23).
 *
 * Three different nothings, told apart, because "you have not pinned anything"
 * and "everything you have is settled" ask completely different things of the
 * learner and a single sentence for both would be useless to either.
 */
function nothingReason(topics: readonly Topic[], decisions: readonly TopicReason[]): string {
  if (!topics.length) return 'Nothing pinned yet. Pin something and I will build a session from it.';
  const active = decisions.filter(
    (d) => d.disposition === 'teach' || d.disposition === 'review' || d.disposition === 'resurface');
  if (!active.length) return 'Nothing is due a check and nothing new has arrived. This is what caught-up looks like.';
  // The event-driven processing contract: there is no next run to try again. The honest sentence names
  // what is missing and what they can do about it, rather than deferring them
  // to a thing that no longer schedules itself.
  return 'Not enough new material for a session yet. Pin a few more and press Process.';
}

// -------------------------------------------------------- zone 3: flagged

/**
 * §5 zone 3 — the short list of things the learner asked for, plus what the
 * model noticed slipping. Each row names its source, because a list that says
 * "flagged" without saying who flagged it reads as the product's judgement of
 * the learner rather than as their own note to themselves.
 *
 * The still-shaky tap from the quick take (SB-61) is the first source §5 names,
 * and it is here now that the quick take can produce one. `quick-take-got-it`
 * is not a source and never will be: this list is *what the learner asked
 * for*, and putting a topic they said they had on a list headed "come back to"
 * would be the product arguing with them.
 */
export type FlagSource =
  | 'quick-take-still-shaky' | 'guide-stuck'
  | 'resurface-refresher' | 'resurface-deeper' | 'regression';

/** The signal types that put a row on this list, which is every `FlagSource`
 *  except the one the model raises by itself. Stated as a set so the filter
 *  below and the type above cannot drift apart. */
const FLAG_SIGNALS: readonly FlagSource[] = [
  'quick-take-still-shaky', 'guide-stuck', 'resurface-refresher', 'resurface-deeper',
];

/** The row's source, or null for a signal that is not a flag. Written as a
 *  narrowing so the row's `source` is the checked value rather than a cast. */
const flagSourceOf = (type: SignalType): FlagSource | null =>
  FLAG_SIGNALS.find((f) => f === (type as FlagSource)) ?? null;

export interface FlaggedRow {
  readonly topicId: TopicId;
  readonly topicLabel: string;
  readonly source: FlagSource;
  /** The ISO instant the flag was raised. The panel words the date. */
  readonly at: string;
}

export interface FlaggedInput {
  readonly topics: readonly Topic[];
  readonly signals: readonly Signal[];
  /** `ComfortResult` satisfies this. The regression flag is the model's half. */
  readonly comforts: readonly { readonly topicId: TopicId; readonly regressed: boolean }[];
  readonly now: Date;
}

/**
 * How many rows the panel shows before "and N more".
 *
 * §5: *"a count of things the learner asked for, which is the one count that is
 * not guilt"*. It is capped anyway, because a list long enough to scroll is a
 * pile, and the pile is the thing this product refuses to be.
 */
export const FLAGGED_ROWS = 4;

/** A flag older than this has stopped being a flag and become a reproach. The
 *  Gardener still holds the mark as a prior; the list stops nagging about it. */
export const FLAG_WINDOW_DAYS = 90;

export function flaggedRows(input: FlaggedInput): readonly FlaggedRow[] {
  const { topics, signals, comforts, now } = input;
  const labels = new Map(topics.map((t) => [t.id, t.label]));
  const oldest = now.getTime() - FLAG_WINDOW_DAYS * 86_400_000;

  const rows: FlaggedRow[] = [];

  for (const s of signals) {
    if (s.invalidated) continue;
    const source = flagSourceOf(s.type);
    if (!source) continue;
    const at = Date.parse(s.at);
    if (!Number.isFinite(at) || at < oldest) continue;
    const label = labels.get(s.topicId);
    // A mark on a topic that no longer exists is dropped rather than rendered
    // against a blank name — the provenance join, made rather than assumed.
    if (!label) continue;
    rows.push({ topicId: s.topicId, topicLabel: label, source, at: s.at });
  }

  for (const c of comforts) {
    if (!c.regressed) continue;
    const topic = topics.find((t) => t.id === c.topicId);
    if (!topic) continue;
    rows.push({
      topicId: topic.id, topicLabel: topic.label, source: 'regression',
      // Dated at the last exposure, which is the most recent thing the ledger
      // can honestly point at for a slip nobody announced.
      at: topic.lastExposedAt ?? topic.createdAt,
    });
  }

  // Newest first. One row per topic per source: a learner who tapped twice
  // asked once.
  const seen = new Set<string>();
  return rows
    .sort((a, b) => b.at.localeCompare(a.at) || a.topicId.localeCompare(b.topicId))
    .filter((r) => {
      const key = `${r.topicId}:${r.source}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
