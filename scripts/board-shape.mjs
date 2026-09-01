/**
 * What a six-week-old board looks like, as opposed to one clustered five
 * minutes ago.
 *
 * The shipped seeder loads pins, lets the Clusterer earn the topics, and layers
 * a signal history on. What it cannot do is age the *topics*: a topic the
 * Clusterer made tonight carries `createdAt = now` and `lastExposedAt = null`,
 * whatever its pins say. Two of the Gardener's rules read exactly those two
 * fields, so on a freshly seeded board neither can fire:
 *
 *   - SB-22 abandonment (`idle >= 28 days` with no evidence) — the case the
 *     `sourdough-hydration` pin exists to exercise. `idle` is measured from
 *     `lastExposedAt ?? createdAt`, both of which say "today", so the pin the
 *     corpus comment calls "the Gardener's abandonment case" has never once
 *     reached it. It reads instead as a brand-new topic with no evidence, which
 *     the Composer renders `from-nothing` and the Gardener ranks at priority 73
 *     — near the top of the board.
 *   - Spaced review (`reviewDue`) returns false the moment `lastExposedAt` is
 *     null, by an explicit guard. So `review` is unreachable too.
 *
 * Neither is a defect in the product. Both are artefacts of seeding, and both
 * distort exactly the ranking that decides which topics become sections.
 *
 * This module ages the board from what the board already contains. It invents
 * no dates: `createdAt` is when the topic's earliest pin was captured, and
 * `lastExposedAt` is when the topic's most recent teaching signal was recorded.
 * Both are read off the store.
 */

/**
 * Signals that only exist because the topic was in front of the learner in a
 * session. Answering, being checked, completing, abandoning, or asking for the
 * depth to move are all things that can only happen to a topic being taught.
 *
 * Deliberately excludes `pin-*` (a capture happens on a web page, not in a
 * session), `interview-seed` (before any session), `user-model-edit` and the
 * `resurface-*` marks (made *about* a past section, from the board).
 */
export const EXPOSURE_SIGNALS = new Set([
  'answer-correct', 'answer-wrong', 'recall-check',
  'section-completed', 'section-abandoned',
  'depth-simpler', 'depth-deeper',
  'self-skip',
]);

const earliest = (dates) => dates.reduce((a, b) => (a === null || b < a ? b : a), null);
const latest = (dates) => dates.reduce((a, b) => (a === null || b > a ? b : a), null);

/**
 * The two dates a lived-in board would carry, per topic.
 *
 * `createdAt` falls back to whatever the topic already has when the topic holds
 * no pins we can date, and `lastExposedAt` stays null when nothing has ever
 * taught the topic — a null there is a real answer, and filling it in would
 * make an untaught topic look reviewed.
 */
export function ageTopic(topic, pinsOfTopic, signalsOfTopic) {
  const captured = pinsOfTopic.map((p) => p.capturedAt).filter(Boolean);
  const exposed = signalsOfTopic
    .filter((s) => !s.invalidated && EXPOSURE_SIGNALS.has(s.type))
    .map((s) => s.at);
  return {
    createdAt: earliest(captured) ?? topic.createdAt,
    lastExposedAt: latest(exposed),
  };
}
