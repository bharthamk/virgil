import type { Commitment } from './commitments.js';
import {
  commitmentState, deadlineDay, deadlineTimeLabel, hasTimedDeadline,
} from './commitments.js';
import type { Course } from './courses.js';
import { nextMaterial } from './courses.js';
import type { CourseIntakeDraft } from './intake.js';
import { unresolvedBlockingQuestions } from './intake.js';
import type { LearningOutcome } from './outcomes.js';
import { outcomeSignalSeeds } from './outcomes.js';
import { BURST_MINUTES, planBurst } from './burst.js';
import { nudgeSlipping } from './avoidance-nudge.js';
import type { Pin, Session, Signal, Topic, TopicId } from './types.js';
import type { ComfortRead } from './registers.js';
import { registerFor, registerRank } from './registers.js';
import { isEvidence } from './signals.js';
import { dayKeyFor } from './schedule.js';
import { quickTakeOfferMinutes } from './quick-take.js';

/**
 * The time-window contract: Learn is a flash-time product. Longer chips centred the wrong
 * behaviour and made the surface feel like an expensive chatbot, so the only
 * learner-facing windows are one, three and five minutes.
 */
export const AVAILABLE_MINUTES = [1, 3, 5] as const;
export type AvailableMinutes = typeof AVAILABLE_MINUTES[number];
/** Actual work may finish between the learner's three availability choices. */
export type ActionMinutes = 1 | 2 | 3 | 4 | 5;

export type NextActionKind =
  | 'clarify-intake'
  | 'commitment'
  | 'session'
  | 'quick-take'
  | 'burst'
  | 'course-material'
  | 'capture-material'
  | 'caught-up';

/**
 * Where pressing the action's button actually goes.
 *
 * `build` is the newest and exists because a commitment that names topics has
 * somewhere real to send somebody on a night with no session yet: the board can
 * be worked through into one. Without it the only honest destination for a
 * dated piece of work was the room that lists it, which is how the product's
 * biggest button came to repaint a list the learner was already reading.
 */
export type ActionDestination =
  | 'intake' | 'plan' | 'session' | 'take' | 'burst' | 'courses' | 'capture' | 'build' | 'board';

/**
 * The four things an action can promise, as words.
 *
 * They live here rather than in the panel because the destination decides them
 * and the destination is decided here. A cta that promised work the destination
 * could not deliver is a contract failure: the hero said
 * "Work on it" and opened a list.
 */
/** The destination teaches the thing: a prepared session covering its topics. */
export const CTA_WORK_ON_IT = 'Work on it';
/** The window is smaller than the job, so only the first move is promised. */
export const CTA_MAKE_A_START = 'Make a start';
/** There are topics to teach from and no session yet. Pressing it starts one. */
export const CTA_BUILD_A_SESSION = 'Build a session now';
/**
 * Nothing on the board is linked to this, so the plan is all there is to offer.
 *
 * Named for what it does rather than for what a learner would rather it did.
 * The dogfood walk's own wording (`DOGFOOD_2026-08-24.md`, A1): *"If the button
 * cannot open the material, name it for what it does."*
 */
export const CTA_SHOW_WHERE_IT_SITS = 'Show me where this sits';
/** The deadline has no learning link yet, but the board has honest choices. */
export const CTA_CHOOSE_WHAT_IT_NEEDS = 'Choose what it needs';

const COMMITMENT_KIND_LABEL: Readonly<Record<Commitment['kind'], string>> = {
  assignment: 'Assignment', lesson: 'Lesson', study: 'Study', task: 'Task',
};

export interface ActionReason {
  readonly code: 'ambiguity' | 'deadline' | 'assessed-gap' | 'ready' | 'review-due'
    | 'next-material' | 'planned-day' | 'empty' | 'caught-up'
    /** Written only by `avoidance-nudge.ts`. Never produced by `candidates`. */
    | 'slipping';
  readonly text: string;
}

export interface ActionOption {
  readonly id: string;
  readonly kind: NextActionKind;
  readonly targetId: string | null;
  readonly title: string;
  readonly detail: string;
  readonly minutes: ActionMinutes;
  readonly destination: ActionDestination;
  /** A destination-local action rather than a generic room open. */
  readonly planIntent?: 'links';
  /** Present only when the action can open a real course item immediately. */
  readonly url?: string | null;
  /** Course-material check-in identity and its full declared length. */
  readonly materialId?: string | null;
  readonly materialTotalMinutes?: number | null;
  /** Counter the offered block starts from, making its exact retry convergent. */
  readonly materialProgressMinutes?: number | null;
  /** The exact prepared sections this bounded action exposes. A stored session
   *  may be longer than the learner's present 1/3/5-minute window. */
  readonly sessionTopicIds?: readonly string[];
  readonly cta: string;
  readonly reasons: readonly ActionReason[];
  /**
   * how many other topics stand behind a quick take's pick, ready to be
   * offered in its place. Present on a quick take and on nothing else.
   *
   * A COUNT rather than the candidates themselves, because the screen has
   * exactly one decision to make with it: whether the control that swaps the
   * pick can do anything, and therefore whether it is drawn at all. Handing the
   * panel a list would put a second ranking in the browser, which would be a
   * second thing that could disagree with this one the moment the board moved
   * underneath it, and the swap re-asks this file instead.
   */
  readonly othersReady?: number;
  /** Exposed for audit/tests, not as a learner-facing score. */
  readonly rank: number;
}

export interface NextAction {
  readonly availableMinutes: AvailableMinutes;
  readonly primary: ActionOption;
  readonly alternatives: readonly ActionOption[];
}

export interface NextActionInput {
  readonly now: Date;
  /** Learner-owned IANA zone. Optional keeps pre-timezone callers on UTC. */
  readonly timeZone?: string;
  readonly availableMinutes: AvailableMinutes;
  readonly drafts: readonly CourseIntakeDraft[];
  readonly commitments: readonly Commitment[];
  readonly courses: readonly Course[];
  readonly outcomes: readonly LearningOutcome[];
  readonly topics: readonly Topic[];
  readonly pins: readonly Pin[];
  readonly signals: readonly Signal[];
  /** The Gardener's current, deterministic read. Today consumes the decision;
   *  it does not reconstruct teaching priority from topic fields. */
  readonly topicDecisions: readonly {
    readonly topicId: string;
    readonly disposition: string;
    readonly reason: string;
    readonly priority: number;
  }[];
  readonly session: Session | null;
  /**
   * What the board says keeps slipping, as item keys.
   *
   * Optional, and absent means the ordinary ranking. It is handed in rather
   * than computed here for the same reason `topicDecisions` is: this file
   * consumes decisions, and a second place that worked out what was slipping
   * would be a second place that could disagree with the screen showing it.
   */
  readonly slippingKeys?: readonly string[];
  /**
   * the Registrar's current comfort reads, by topic.
   *
   * Handed in for the same reason `topicDecisions` is, and it is the same
   * array the Gardener was already given on this call path: a second place
   * that recomputed comfort would be a second place that could disagree with
   * the screen showing it.
   *
   * Structural rather than `ComfortResult`, because `domain/` sits underneath
   * the agents and a domain file importing one would invert the layering the
   * seam test enforces. Optional, and absent means the board's stored comfort
   * is the only standing available, which is what every pre- caller had.
   */
  readonly comforts?: readonly TopicComfortRead[];
  /**
   * the quick-take pins the learner has refused on this visit to Learn.
   *
   * Held out of the pick and out of nothing else. It is not a mark, it is not
   * stored, and no consumer reads it: refusing a pick before opening it says
   * *not this one, now*, which is a fact about the next second rather than
   * about the topic. What the ledger hears is the passed-over record the panel
   * writes, and what the comfort model hears is nothing.
   *
   * The alternative was for the panel to hold the candidate list and walk it,
   * which would put a second ranking in the browser and let the screen and the
   * ranker disagree the moment the board moved underneath them.
   */
  readonly passedOverPinIds?: readonly string[];
}

/** One topic's comfort reading, in the shape `registerFor` already takes. */
export type TopicComfortRead = ComfortRead & { readonly topicId: TopicId };

const dayStart = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);
const daysUntil = (c: Commitment, now: Date, timeZone = 'UTC'): number => {
  const zone = hasTimedDeadline(c) ? c.dueTimeZone : timeZone;
  return Math.round((dayStart(deadlineDay(c)) - dayStart(dayKeyFor(now, zone))) / 86_400_000);
};

/**
 * A planned day belongs to the learner, not to the deadline's declared zone.
 * It is stored as a date-shaped instant for compatibility, but the literal
 * YYYY-MM-DD is the promise. Reading it through Date would move that promise
 * across zones at exactly the boundary where Today has to be trustworthy.
 */
const plannedDaysUntil = (c: Commitment, now: Date, timeZone = 'UTC'): number | null => {
  if (!c.plannedFor) return null;
  return Math.round((dayStart(c.plannedFor.slice(0, 10)) - dayStart(dayKeyFor(now, timeZone))) / 86_400_000);
};

const plannedDayReason = (c: Commitment, now: Date, timeZone = 'UTC'): ActionReason | null => {
  const days = plannedDaysUntil(c, now, timeZone);
  if (days === null || days > 0) return null;
  return {
    code: 'planned-day',
    text: days === 0
      ? 'You planned this for today.'
      : days === -1
        ? 'You planned to do this yesterday, and it is still open.'
        : `You planned to do this ${Math.abs(days)} days ago, and it is still open.`,
  };
};

const fit = (minutes: number, available: AvailableMinutes): ActionMinutes | null => {
  const whole = Math.max(1, Math.round(Number(minutes) || 0));
  if (whole > available) return null;
  // Availability is a ceiling. The action itself names the exact whole work.
  return whole as ActionMinutes;
};

/**
 * Where a deadline stands, as the fragment both the plan and the session use.
 *
 * One sentence-part, two callers: the commitment says "This is due today." and
 * the lesson that serves it says it prepares something that is due today. Two
 * spellings of the same fact is how two screens come to disagree about a date.
 */
const dueSays = (c: Commitment, now: Date, timeZone = 'UTC'): string => {
  const state = commitmentState(c, now, timeZone);
  const days = daysUntil(c, now, timeZone);
  const at = hasTimedDeadline(c) ? ` at ${deadlineTimeLabel(c)} ${c.dueTimeZone}` : '';
  return state === 'late'
    ? hasTimedDeadline(c) ? `was due${at} and is still open` : 'is still open past its date'
    : state === 'today' ? `is due today${at}`
      : `is due in ${Math.max(1, days)} day${days === 1 ? '' : 's'}${at}`;
};

/**
 * One urgency calculation for both a commitment and useful course material
 * sitting beside it. Sharing it matters: when the only action a commitment can
 * offer is a trip to Plan, a same-course item may carry that urgency into a
 * real learning move without inventing a topic-level teaching link.
 */
const commitmentRank = (
  c: Commitment, now: Date, available: AvailableMinutes, timeZone = 'UTC',
): { readonly rank: number; readonly whole: ActionMinutes | null } => {
  const state = commitmentState(c, now, timeZone);
  const days = daysUntil(c, now, timeZone);
  const known = c.estimateMinutes ?? available;
  const whole = fit(known, available);
  const deadlineUrgent = state === 'late' ? 900 : state === 'today' ? 860
    : state === 'soon' ? 720 - Math.max(0, days) * 18 : 360 - Math.min(200, Math.max(0, days));
  const planned = plannedDaysUntil(c, now, timeZone);
  // A learner's due plan should beat generic recall/material, but it cannot
  // outrank a prepared non-revision lesson (950) or a blocking intake question
  // (1,000). Deadline urgency remains authoritative whenever it is stronger.
  const planUrgent = planned === null || planned > 0 ? 0 : planned === 0 ? 840 : 880;
  const urgent = Math.max(deadlineUrgent, planUrgent);
  return { rank: urgent + (whole ? 25 : 0), whole };
};

/**
 * WHERE A TOPIC STANDS, FOR THE ONE PICK THAT HAS TO EXPLAIN ITSELF.
 *
 * , from the walkthrough. At a one-minute window with nothing due, the
 * quick take leads, and its reason was the Gardener's *"Nothing has been asked
 * about this yet."* — true of every topic on a new board, which made the
 * product's smallest recommendation read as a shuffle. It was not random; it
 * was id order, which is worse, because id order is arbitrary AND invisible.
 *
 * So the pick is made on the ground it is about to teach, from data the board
 * already holds: the register the Composer would write it at, and the comfort
 * behind that register. Weakest ground first, because the quick take is the
 * cheapest way to start something, and starting is what an unmet topic needs.
 *
 * Deterministic and pure, like everything else here. Topic id is the last
 * tie-break so an unchanged board proposes an unchanged thing, and the reason
 * below says out loud when that is all the choice amounted to.
 */
interface QuickTakeStanding {
  /** Rung on the register ladder. Lower is weaker ground. */
  readonly rung: number;
  /** The Registrar's read where there is one, the board's stored one where not. */
  readonly comfort: number;
  /** Whether anything has ever been asked about this topic. */
  readonly asked: boolean;
}

const quickTakeStanding = (
  topic: Topic, read: TopicComfortRead | undefined, signals: readonly Signal[],
): QuickTakeStanding => ({
  rung: registerRank(registerFor(read)),
  comfort: read ? read.comfort : topic.comfort,
  // The Gardener's own test where the reads are present, so the two surfaces
  // cannot disagree about whether a topic has been asked about. Without them,
  // the ledger answers the same question directly.
  asked: read
    ? read.evidenceCount > 0
    : signals.some((signal) => signal.topicId === topic.id
      && !signal.invalidated && isEvidence(signal)),
});

/**
 * The reason, naming the ground rather than describing the board.
 *
 * Four sentences for four honest cases. The tied pair matter most: when every
 * topic stands in the same place there is no ground to name, and the truthful
 * thing to say is that Virgil is starting somewhere. Saying which alphabetical
 * position it landed on would be accurate and useless; pretending the pick was
 * earned would be neither.
 */
const quickTakeGroundLine = (asked: boolean, tied: boolean): string => {
  if (tied) {
    return asked
      ? 'Nothing here is less settled than this one, so this is where I am starting.'
      : 'Nothing here has been asked about yet, so this is where I am starting.';
  }
  return asked
    ? 'Of everything ready to teach, this is the one you are least settled on.'
    : 'You are new to this one, and nothing has been asked about it yet.';
};

const recentGapTopics = (outcomes: readonly LearningOutcome[]): Set<string> => {
  const newest = [...outcomes]
    .filter((o) => !o.deletedAt)
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
    .slice(0, 8);
  return new Set(newest.flatMap((o) =>
    outcomeSignalSeeds(o).filter((x) => x.direction === 'negative').map((x) => x.topicId)));
};

/**
 * The session leads when there is one.
 *
 * "Work on it" must open real work, not a list. `UX_SPEC.md` §6f defines the
 * order — the session when there is one, then what is due, then five minutes —
 * and this number is that contract made true. It sits above every commitment
 * (900 for late work, 925 with a whole estimate) and below the one thing that
 * still outranks a plan: a blocking question about a date Virgil had to guess.
 *
 * A revision session is deliberately not ranked here. See the rank below.
 */
const SESSION_LEADS = 950;

/** A session exists and every section of it is done. Two questions turn on it:
 *  whether a quick take is still worth offering, and which caught-up sentence
 *  is true. */
const completedSession = (input: NextActionInput): boolean =>
  !!input.session?.sections.length
  && input.session.sections.every((section) => section.completed);

/**
 * THE SMALLEST SOURCE-BACKED MOVE ON THE BOARD.
 *
 * A populated board is not an empty state merely because a prepared section is
 * longer than the learner's present window. The foreground Tutor already writes
 * a quick take to a requested duration, so that real capability is Today's
 * smallest move, offered only for a topic the Gardener currently says is
 * active. A recent closing verdict keeps the same take from being proposed
 * again until a later lesson exposure.
 *
 * Lifted out of `candidates` when  gave it a second output. It was always
 * the one candidate here that makes a judgement rather than reading one off a
 * record, and the whole of that judgement now has a name.
 */
const quickTakeCandidate = (
  input: NextActionInput, available: AvailableMinutes,
): ActionOption | null => {
  const topics = new Map(input.topics.map((topic) => [topic.id, topic]));
  const pins = new Map(input.pins.map((pin) => [pin.id, pin]));
  const reads = new Map((input.comforts ?? []).map((read) => [read.topicId, read] as const));
  const refused = new Set(input.passedOverPinIds ?? []);
  const offered: {
    topic: Topic; pin: Pin; standing: QuickTakeStanding; minutes: ActionMinutes;
  }[] = [];
  for (const decision of input.topicDecisions) {
    if (!['teach', 'review', 'resurface'].includes(decision.disposition)) continue;
    const topic = topics.get(decision.topicId);
    if (!topic || topic.retiredByUser) continue;
    const closedSinceLesson = input.signals.some((signal) =>
      signal.topicId === topic.id && !signal.invalidated
      && (signal.type === 'quick-take-got-it' || signal.type === 'quick-take-still-shaky')
      && (!topic.lastExposedAt || signal.at >= topic.lastExposedAt));
    if (closedSinceLesson) continue;
    const register = registerFor(reads.get(topic.id));
    const viable = topic.pinIds
      .map((id) => pins.get(id))
      .filter((pin): pin is Pin => Boolean(pin))
      .map((pin) => ({ pin, minutes: quickTakeOfferMinutes(pin, available, register) }))
      .find((candidate) => candidate.minutes !== null);
    if (!viable?.minutes) continue;
    const { pin, minutes } = viable;
    // Refused on this visit, and dropped before the sort rather than after it,
    // so `othersReady` counts what the learner could still be shown rather than
    // what the board holds.
    if (refused.has(pin.id)) continue;
    offered.push({
      topic, pin, minutes,
      standing: quickTakeStanding(topic, reads.get(topic.id), input.signals),
    });
  }
  offered.sort((a, b) => a.standing.rung - b.standing.rung
    || a.standing.comfort - b.standing.comfort
    || a.topic.id.localeCompare(b.topic.id));
  const chosen = offered[0];
  if (!chosen) return null;
  const runnerUp = offered[1];
  const tied = !!runnerUp && runnerUp.standing.rung === chosen.standing.rung
    && runnerUp.standing.comfort === chosen.standing.comfort;
  return {
    id: `take:${chosen.pin.id}:${available}`, kind: 'quick-take', targetId: chosen.pin.id,
    title: `A lesson on ${chosen.topic.label} is pending`,
    detail: 'Run it from your board when you are ready.',
    // The requested window still decides how much lesson is built. It no
    // longer claims the model work fits inside that window: the action opens
    // Pending, where generation and verification are named before they run.
    minutes: chosen.minutes, destination: 'board', cta: 'See Pending', rank: 300,
    othersReady: offered.length - 1,
    reasons: [{ code: 'ready', text: quickTakeGroundLine(chosen.standing.asked, tied) }],
  };
};

const candidates = (input: NextActionInput): ActionOption[] => {
  const out: ActionOption[] = [];
  const available = input.availableMinutes;
  const timeZone = input.timeZone ?? 'UTC';

  // Asking one useful question is work. A blocking uncertainty outranks a plan
  // built on a date or course identity Virgil does not actually know.
  for (const draft of input.drafts.filter((d) => d.status === 'draft')) {
    const question = unresolvedBlockingQuestions(draft)[0];
    if (!question) continue;
    out.push({
      id: `clarify:${draft.id}:${question.id}`, kind: 'clarify-intake', targetId: draft.id,
      title: 'Resolve one course question', detail: question.prompt,
      minutes: available, destination: 'intake', cta: 'Answer it', rank: 1_000,
      reasons: [{ code: 'ambiguity', text: 'Virgil will not plan around a deadline it had to guess.' }],
    });
  }

  const remaining = input.session?.sections.filter((s) => !s.completed) ?? [];
  /** What tonight's prepared lesson still has a section for. */
  const sessionTopics = new Set(remaining.map((s) => s.topicId));

  const open = input.commitments.filter((c) => !c.doneAt);
  for (const c of open) {
    const known = c.estimateMinutes ?? available;
    const { rank, whole } = commitmentRank(c, input.now, available, timeZone);
    const minutes = whole ?? available;
    const chunk = whole === null;
    const courseTitle = c.courseId
      ? input.courses.find((course) => course.id === c.courseId)?.title.trim() ?? ''
      : '';
    // The deadline reason immediately below this detail already owns urgency
    // in learner time. Repeating its ISO storage day here made the hero say the
    // same fact twice and exposed an implementation value. Use the work's
    // identity and owner instead; the relative deadline remains authoritative.
    const workContext = `${COMMITMENT_KIND_LABEL[c.kind]}${courseTitle ? ` · ${courseTitle}` : ''}.`;
    /**
     * A dated piece of work is only worth a button that opens real work.
     *
     * Three honest answers, in the order they are worth having. The lesson
     * already prepared for one of its topics; the board it could be prepared
     * FROM; and, when nothing on the board is linked to it at all, the room
     * that lists it — which is a place to look, and the cta says so rather
     * than promising work the destination cannot deliver.
     */
    const taught = c.topicIds.some((t) => sessionTopics.has(t));
    const destination: ActionDestination = taught ? 'session'
      : c.topicIds.length ? 'build' : 'plan';
    const canChooseTopics = destination === 'plan'
      && input.topics.some((topic) => !topic.retiredByUser);
    const planReason = plannedDayReason(c, input.now, timeZone);
    out.push({
      id: `commitment:${c.id}`, kind: 'commitment', targetId: c.id,
      title: chunk ? `Start: ${c.title}` : c.title,
      detail: chunk
        ? `Use this ${minutes}-minute window to make the next concrete move; the full estimate is ${known} minutes.`
        : workContext,
      minutes,
      destination,
      ...(canChooseTopics ? { planIntent: 'links' as const } : {}),
      cta: destination === 'plan'
        ? (canChooseTopics ? CTA_CHOOSE_WHAT_IT_NEEDS : CTA_SHOW_WHERE_IT_SITS)
        : destination === 'build' ? CTA_BUILD_A_SESSION
          : chunk ? CTA_MAKE_A_START : CTA_WORK_ON_IT,
      rank,
      reasons: [
        ...(planReason ? [planReason] : []),
        { code: 'deadline', text: `This ${dueSays(c, input.now, timeZone)}.` },
      ],
    });
  }

  if (input.session && remaining.length) {
    /**
     * The lesson surface reports whole minutes, section by section. Candidate
     * fitting has to use the same arithmetic: a verified 5.2-minute lesson is
     * displayed as five minutes and was composed for the learner's five-minute
     * choice, yet the old exact-float comparison excluded it from Learn and let
     * an unrelated recall burst lead. That buried the lesson immediately after
     * a six-minute Process run. A 5.6-minute section still rounds to six and is
     * correctly excluded from a five-minute window.
     */
    const minutesOf = (n: number): number => Math.max(1, Math.round(Number(n) || 0));
    const total = remaining.reduce((n, s) => n + minutesOf(s.estimatedMinutes), 0);
    const first = remaining[0]!;
    const whole = fit(total, available);
    const firstFit = fit(minutesOf(first.estimatedMinutes), available);
    if (whole || firstFit) {
      const served = open
        .filter((c) => daysUntil(c, input.now, timeZone) <= 7)
        .filter((c) => c.topicIds.some((t) => sessionTopics.has(t)))
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0] ?? null;
      const gapTopics = recentGapTopics(input.outcomes);
      const touchesGap = remaining.some((s) => gapTopics.has(s.topicId));
      const mins = whole ?? firstFit!;
      /**
       * THE HERO'S SENTENCE IS GONE. THE FACTS IT CARRIED ARE SHOWN INSTEAD.
       *
       * It read *"About 3 minutes, which is everything lined up for now. It
       * moves 'Stats problem set 3' forward, and that is still open past its
       * date."* The destination should show that fact on the affected item
       * rather than narrating it above the list.
       *
       * Both halves of it were true and neither needed a sentence. The time is
       * the kicker over the lineup now, computed from the sections themselves.
       * The deadline is a chip on the ROW it is about, beside the subject chip,
       * clicking through to the plan item — a fact about one lesson, announced
       * over all of them, is the shape of narration this law is against.
       *
       * `reasons` survives as the structured record, because that is what a
       * ranked ALTERNATIVE in the rail renders as its caption, where a line of
       * text is the only thing a link can carry. It can be empty: a session
       * with nothing dated behind it and no assessed gap has nothing to caption
       * itself with, and the rail falls back to `detail`.
       */
      const reasons: ActionReason[] = [];
      if (served) {
        reasons.push({
          code: 'deadline',
          text: `It moves “${served.title}” forward, and that ${dueSays(served, input.now, timeZone)}.`,
        });
      }
      if (touchesGap) {
        reasons.unshift({
          code: 'assessed-gap',
          text: 'Something you were recently marked down on is in here.',
        });
      }
      out.push({
        id: `session:${input.session.id}`, kind: 'session', targetId: input.session.id,
        // Named for what the screen under it now shows. The hero stopped being
        // a summary card on 2026-08-24 and became the list itself, so the
        // heading introduces the list rather than describing a lesson object.
        title: whole ? (input.session.revision ? 'A refresh on what you have already met' : 'Tonight’s lineup') : first.heading,
        // A caption for a link, and nothing above the lineup renders it. The
        // hero shows the lineup; a sentence introducing a list that is already
        // on screen is the narration The interface-affordance contract bans.
        detail: whole
          ? `${remaining.length} lesson${remaining.length === 1 ? '' : 's'}.`
          : `The first of ${remaining.length} lessons.`,
        minutes: mins, destination: 'session', cta: input.session.currentSectionIndex ? 'Continue' : 'Start',
        sessionTopicIds: (whole ? remaining : [first]).map((section) => section.topicId),
        /**
         * A refresh is not tonight's lesson, and does not lead like one.
         *
         * `SESSION_LEADS` is for a session with something to teach. A revision
         * session is what the Gardener offers on a night with nothing new —
         * *"a five-minute refresh on two things from last week"* — and putting
         * that above an assignment due tomorrow would break acceptance clause
         * 8, which is that a nearer assessed obligation CAN beat generic
         * revision. So the refresh keeps the ranking it always had, where a
         * deadline it actually prepares for is what lifts it.
         */
        rank: input.session.revision
          ? 650 + (served ? 220 : 0) + (touchesGap ? 170 : 0)
          : SESSION_LEADS + (served ? 20 : 0) + (touchesGap ? 15 : 0),
        reasons,
      });
    }
  }

  const finished = completedSession(input);
  const take = finished ? null : quickTakeCandidate(input, available);
  if (take) out.push(take);

  const burst = planBurst(input.topics, input.signals, input.now);
  if (available >= BURST_MINUTES && burst.length) {
    out.push({
      id: `burst:${burst.map((x) => x.topicId).join(',')}`, kind: 'burst', targetId: null,
      title: 'Take a five-minute recall burst',
      detail: `${burst.length} quick check${burst.length === 1 ? '' : 's'} from things you have already met.`,
      minutes: 5, destination: 'burst', cta: 'Start burst', rank: 500,
      reasons: [{
        code: 'review-due',
        text: burst.some((x) => x.reason === 'due')
          ? 'At least one topic is due for recall.' : 'This is the smallest useful action available.',
      }],
    });
  }

  for (const course of input.courses.filter((c) => !c.archivedAt)) {
    const material = nextMaterial(course);
    if (!material) continue;
    const progressed = Math.max(0, material.progressMinutes ?? 0);
    const known = material.minutes === null
      ? available
      : Math.max(1, material.minutes - progressed);
    const whole = fit(known, available);
    const minutes = whole ?? available;
    const related = open
      .filter((c) => c.courseId === course.id)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0] ?? null;
    // A course relationship is weaker than a topic relationship, so it never
    // beats genuinely urgent assessed work. It is still enough to prefer a
    // useful next item over merely opening the plan for a deadline weeks away.
    const deadlineLift = related
      ? Math.max(0, Math.min(160, 120 - daysUntil(related, input.now, timeZone) * 5))
      : 0;
    /**
     * Learn must lead to learning when it has an honest move available.
     *
     * A newly imported deadline has a course id but usually no topic ids yet.
     * For a due-today or late item that missing link is material: Virgil should
     * not guess that a lecture is the right emergency move. For a merely-soon
     * item, however, ranking a button whose whole effect is to locate the date
     * above that course's next real item turns Learn into a Plan detour. Lift
     * the material one point above that locate-only candidate. The deadline is
     * still stated as context, while no claim is made that the material teaches
     * the assignment.
     */
    const relatedState = related ? commitmentState(related, input.now, timeZone) : null;
    const relatedPlan = related ? plannedDaysUntil(related, input.now, timeZone) : null;
    const locateOnlySoonRank = related && !related.topicIds.length && relatedState === 'soon'
      && (relatedPlan === null || relatedPlan > 0)
      ? commitmentRank(related, input.now, available, timeZone).rank + 1
      : 0;
    const reasons: ActionReason[] = [{
      code: 'next-material', text: `It is the next unfinished item in ${course.title}.`,
    }];
    if (related) reasons.push({
      code: 'deadline', text: `${related.title} ${dueSays(related, input.now, timeZone)}.`,
    });
    out.push({
      id: `material:${course.id}:${material.id}`, kind: 'course-material', targetId: course.id,
      title: material.title,
      detail: !material.url
        ? 'Virgil does not have a link for this item yet.'
        : progressed > 0
          ? (whole
            ? `Finish it in about ${known} minute${known === 1 ? '' : 's'}; ${progressed} already recorded.`
            : `Continue for ${minutes} minute${minutes === 1 ? '' : 's'}; ${known} of ${material.minutes} remain.`)
          : (whole
            ? `Next in ${course.title}.`
            : `${minutes === 1 ? 'Use this minute' : `Use these ${minutes} minutes`} to begin it; the full item is ${known} minutes.`),
      minutes, destination: 'courses', url: material.url || null,
      materialId: material.id, materialTotalMinutes: material.minutes,
      materialProgressMinutes: progressed,
      cta: material.url ? 'Open material' : 'Add its link',
      // A missing-link repair may be the only useful move, but it is not
      // learning and cannot take the one-point learn-now lift above real work.
      rank: material.url ? Math.max(340 + deadlineLift, locateOnlySoonRank) : 250,
      reasons,
    });
  }

  if (!out.length) {
    const hasBoardHistory = finished
      || input.topics.some((topic) => topic.pinIds.length)
      || input.pins.length > 0;
    const hasStudiesHistory = input.courses.some((course) => !course.archivedAt)
      || input.outcomes.some((outcome) => !outcome.deletedAt)
      || input.commitments.some((commitment) => !!commitment.doneAt && !!commitment.courseId);
    const hasPlanHistory = input.commitments.some((commitment) => !!commitment.doneAt);
    out.push(hasBoardHistory ? {
      id: `caught-up:${input.session?.id ?? 'board'}`, kind: 'caught-up', targetId: null,
      title: 'You’re done for now',
      detail: finished ? 'This session is complete.' : 'Nothing on your board needs another pass just now.',
      minutes: available, destination: 'board', cta: 'See my board', rank: 0,
      reasons: [{
        code: 'caught-up',
        text: 'Nothing is due for another pass yet.',
      }],
    } : hasStudiesHistory ? {
      id: 'caught-up:studies', kind: 'caught-up', targetId: null,
      title: 'You’re caught up',
      detail: 'You finished what you set out to do.',
      minutes: available, destination: 'courses', cta: 'See my studies', rank: 0,
      reasons: [{
        code: 'caught-up',
        text: 'Nothing in My studies needs attention just now.',
      }],
    } : hasPlanHistory ? {
      id: 'caught-up:plan', kind: 'caught-up', targetId: null,
      title: 'You’re caught up',
      detail: 'You finished what you set out to do.',
      minutes: available, destination: 'plan', cta: 'See my plan', rank: 0,
      reasons: [{
        code: 'caught-up',
        text: 'Nothing on your plan needs attention just now.',
      }],
    } : {
      id: 'capture:empty', kind: 'capture-material', targetId: null,
      // the arrival screen is the front door, and a single verb sold
      // one intake out of three. The hero names what the product IS — you
      // collect anything, it comes back as the next move in the minutes you
      // have — and the panel's ways-to-add block names the three ways in.
      title: 'Collect anything. Virgil finds your next move.',
      detail: 'Start with whatever you already have: a course, an assignment, a page that taught you something.',
      minutes: available, destination: 'capture', cta: 'Add course material', rank: 0,
      reasons: [{ code: 'empty', text: 'There is no reviewed obligation, lesson, recall item, or course material yet.' }],
    });
  }
  return out;
};

/**
 * One stable decision, with supporting alternatives but no competing hero.
 *
 * THE ONE SEAM THE SLIPPING NUDGE IS WIRED IN AT. `nudgeSlipping` is a pure
 * pass over the candidates before they are ordered, and it is called here and
 * nowhere else: removing this line and its module removes the adaptation and
 * leaves every other read of the board untouched.
 */
export function chooseNextAction(input: NextActionInput): NextAction {
  const ranked = [...nudgeSlipping(
    candidates(input), new Set(input.slippingKeys ?? []), input.availableMinutes,
  )].sort((a, b) =>
    b.rank - a.rank || a.minutes - b.minutes || a.id.localeCompare(b.id));
  return {
    availableMinutes: input.availableMinutes,
    primary: ranked[0]!,
    alternatives: ranked.slice(1, 3),
  };
}

export function validAvailableMinutes(value: unknown, fallback: AvailableMinutes = 3): AvailableMinutes {
  const n = Number(value);
  return (AVAILABLE_MINUTES as readonly number[]).includes(n) ? n as AvailableMinutes : fallback;
}
