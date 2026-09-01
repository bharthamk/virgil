import {
  avoidanceCandidates, chooseNextAction, computeComfort, projectSafeSession, tend,
  type AvailableMinutes, type AvoidanceCandidate, type AvoidanceInput, type Deps,
  type LearnerPrefs, type NextAction,
} from '@sb/core';

/**
 * WHAT TODAY READS, IN ONE PLACE.
 *
 * The closed-loop projection behind Today and the outcome-adaptation receipts.
 * It was a closure inside `service.ts`, which is a capped file with no room to
 * grow, and the reason it moved is the reason every other lane has its own
 * module: the ownership boundary is visible, and the file that answers every
 * request does not gain a paragraph each time the ranker learns to read
 * something new.
 *
 * It reads and it never writes. Everything below is arithmetic over records the
 * board already holds, with no model call anywhere on the path.
 *
 * ## The slipping list, and why it is assembled here
 *
 * `chooseNextAction` consumes decisions rather than making them, the same way
 * it consumes the Gardener's. So the read of what keeps slipping happens once,
 * through `slippingFrom` below, and is handed to the ranker as keys. The
 * Insights screen calls the same function on the same records; two surfaces
 * that assembled that input separately would be two surfaces that could
 * disagree about what the learner is being told about themselves.
 */
export interface TodaySourceContext {
  readonly deps: Deps;
  readonly zoneOf: (prefs: LearnerPrefs, requestedZone?: string) => string;
}

/** The board records the slipping read needs, and nothing beyond them. */
type SlippingRecords = Omit<AvoidanceInput, 'now' | 'timeZone' | 'setAside'>;

/** One assembly of the input, used by the ranker and by Insights alike. */
export const slippingFrom = (
  now: Date, timeZone: string, prefs: LearnerPrefs, records: SlippingRecords,
): readonly AvoidanceCandidate[] =>
  avoidanceCandidates({ ...records, now, timeZone, setAside: prefs.setAside ?? {} });

/** The seven reads behind it, for callers that do not already hold them. */
export async function readSlippingRecords(deps: Deps): Promise<SlippingRecords> {
  const [courses, commitments, topics, pins, signals, statements, edges] = await Promise.all([
    deps.store.listCourses(), deps.store.listCommitments(), deps.store.listTopics(),
    deps.store.listPins(), deps.store.listSignals(), deps.store.listStatements(),
    deps.store.listEdges(),
  ]);
  return { courses, commitments, topics, pins, signals, statements, edges };
}

/**
 * SB-286: the quick-take picks refused on this visit to Learn.
 *
 * Carried on the request rather than stored, because it is not a decision about
 * a topic and nothing is entitled to remember it. A learner who comes back
 * tomorrow is offered the board's best pick again, which is the honest reading
 * of *show me another* said once on one night.
 */
export async function readNextActionFor(
  ctx: TodaySourceContext,
  availableMinutes: AvailableMinutes,
  knownPrefs?: LearnerPrefs,
  requestedZone?: string,
  passedOverPinIds: readonly string[] = [],
): Promise<NextAction> {
  const { deps } = ctx;
  const [drafts, commitments, courses, outcomes, topics, pins, signals, session, prefs,
    statements, edges] = await Promise.all([
    deps.store.listIntakeDrafts(), deps.store.listCommitments(), deps.store.listCourses(),
    deps.store.listOutcomes(), deps.store.listTopics(), deps.store.listPins(),
    deps.store.listSignals(), deps.store.latestSession(),
    knownPrefs ?? deps.store.getPrefs(),
    deps.store.listStatements(), deps.store.listEdges(),
  ]);
  const now = deps.clock.now();
  const timeZone = ctx.zoneOf(prefs, requestedZone);
  const comforts = topics.map((topic) => computeComfort(topic.id, signals, now));
  /**
   * The learner's own set-asides are inside this read, which is what makes the
   * third bound in `avoidance-nudge.ts` true rather than merely intended: a
   * deferred item never reaches the list, so there is no key for the nudge to
   * match and nothing left to suppress downstream.
   */
  const slipping = slippingFrom(now, timeZone, prefs, {
    courses, commitments, topics, pins, signals, statements, edges,
  });
  return chooseNextAction({
    now, timeZone, availableMinutes, drafts, commitments, courses,
    outcomes, topics, pins, signals,
    session: session ? projectSafeSession(session, topics) : session,
    slippingKeys: slipping.map((candidate) => candidate.key),
    // SB-283: the same reads the Gardener is given, so the quick take's stated
    // ground and the ranking that produced it come from one arithmetic.
    comforts,
    passedOverPinIds,
    topicDecisions: tend({ topics, comforts, signals, now, commitments, timeZone }),
  });
}
