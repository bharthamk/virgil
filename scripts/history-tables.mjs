/**
 * Signal ledgers a seeded board can be given, as data.
 *
 * `shipped` is the demo learner the evaluation record is written against, taken
 * from the seeder itself rather than transcribed — a copy here would drift from
 * the board every measurement was taken on, and the whole point of probing a
 * ledger is that the probe and the seed agree about what is in it.
 *
 * `three-register` is the controlled comparison: the same 21 pins, the same six
 * weeks, a different study history — one whose comfort spread the Composer's
 * own thresholds turn into three registers rather than two.
 *
 * WHY THE SHIPPED LEDGER PRODUCES TWO. Register is a pure function of the
 * ledger (`core/src/domain/registers.ts`), and `fluent` needs comfort >= 0.75
 * with certainty >= 0.3. The shipped board has exactly two topics that clear
 * that bar and neither reaches a section:
 *
 *   - `cloudrun-coldstart` — comfort 1.00, certainty 0.60. It clears the bar so
 *     well that the Gardener calls it `settled` (>= 0.8 / >= 0.6) and the
 *     Composer excludes settled topics by design. Absorbed material is not owed
 *     a lesson.
 *   - `pubsub-ordering` — comfort 1.00 on two weak positives, certainty 0.23.
 *     Below the certainty gate, so the register falls back to `from-nothing`.
 *
 * So the fluent band on the shipped board is a gap, not a plateau: below it the
 * topic is `building`, above it the topic is `settled` and never taught. What
 * produces a live fluent section is a topic sitting inside that gap — high
 * comfort, real certainty, and a reason to be taught anyway. There is exactly
 * one such reason in the product, and it is not a tuning knob: SB-36
 * regression. A regressed topic is exempted from `settled` (the Gardener checks
 * regression first) and is given priority 100, and if the recent negative that
 * triggered it is a *soft* one, comfort stays above 0.75 and the register is
 * `fluent`.
 *
 * That is the whole construction. It is not a comfort number chosen to hit a
 * threshold; it is the one shape in the product where "they know this well" and
 * "teach it tonight" are both true at once.
 */
import { HISTORY as SHIPPED } from '../runner/dist/seed/history.js';

/**
 * Controlled comparison. Same corpus, same nine pin clusters, same six weeks.
 * Four of the nine ledgers are byte-identical to `shipped`; the differences are
 * marked, and each one is ordinary learner behaviour rather than a number.
 */
const THREE_REGISTER = {
  // UNCHANGED. Worked through: wrong, then simpler, then correct twice.
  'pubsub-delivery': [
    { w: 4, type: 'answer-wrong', dir: 'negative' },
    { w: 3, type: 'depth-simpler', dir: 'negative' },
    { w: 2, type: 'answer-correct', dir: 'positive' },
    { w: 1, type: 'recall-check', dir: 'positive' },
    { w: 0, type: 'answer-correct', dir: 'positive' },
  ],

  // UNCHANGED. Read about, never really tested — the certainty gate's case.
  'pubsub-ordering': [
    { w: 3, type: 'section-completed', dir: 'positive' },
    { w: 1, type: 'depth-deeper', dir: 'positive' },
  ],

  // UNCHANGED. Three weeks of not getting it. Comfort 0.00 — `from-nothing`,
  // and the highest-priority ordinary teach on the board.
  'iam-conditions': [
    { w: 4, type: 'answer-wrong', dir: 'negative' },
    { w: 3, type: 'depth-simpler', dir: 'negative' },
    { w: 3, type: 'answer-wrong', dir: 'negative' },
    { w: 2, type: 'answer-wrong', dir: 'negative' },
    { w: 1, type: 'section-abandoned', dir: 'negative' },
  ],

  // UNCHANGED. Absorbed. Settles, and is not taught — correctly.
  'cloudrun-coldstart': [
    { w: 2, type: 'section-completed', dir: 'positive' },
    { w: 1, type: 'answer-correct', dir: 'positive' },
    { w: 0, type: 'depth-deeper', dir: 'positive' },
  ],

  // THE ONE CHANGE ON THE BOARD, and it is one field of one signal.
  //
  // The shipped ledger closes this topic with `answer-wrong` at week 0. The
  // week-0 event in the corpus is not a wrong answer: it is a pin, of type
  // `struggle`, carrying an error string, the fix she looked up, and the note
  // "thought I had this". No question was asked and none was graded.
  // `pin-struggle` is the type the product has for exactly that capture.
  //
  // Both typings are legal and the shipped one was freely chosen for the demo
  // board. What the second one costs is the whole difference between two
  // registers and three: `answer-wrong` weighs 1.0 and drags comfort to 0.65
  // (`building`); `pin-struggle` weighs 0.5 and leaves it at 0.79 — still above
  // the fluent threshold, still regressed, and therefore still taught.
  //
  // Nothing else about this learner moved. Not one signal was added, removed or
  // re-dated anywhere on the board.
  'firestore-queries': [
    { w: 4, type: 'answer-correct', dir: 'positive' },
    { w: 4, type: 'recall-check', dir: 'positive' },
    { w: 3, type: 'answer-correct', dir: 'positive' },
    { w: 0, type: 'pin-struggle', dir: 'negative' },
  ],

  // UNCHANGED.
  'intervals': [
    { w: 5, type: 'answer-wrong', dir: 'negative' },
    { w: 4, type: 'answer-correct', dir: 'positive' },
    { w: 3, type: 'answer-correct', dir: 'positive' },
    { w: 1, type: 'recall-check', dir: 'positive' },
  ],

  // UNCHANGED.
  'seventh-chords': [
    { w: 3, type: 'section-completed', dir: 'positive' },
    { w: 2, type: 'answer-correct', dir: 'positive' },
    { w: 1, type: 'answer-wrong', dir: 'negative' },
  ],

  // UNCHANGED. Understands the theory, cannot hear it — the medium-mismatch
  // case, and a `building` topic.
  'tritone-sub': [
    { w: 1, type: 'answer-correct', dir: 'positive' },
    { w: 0, type: 'depth-simpler', dir: 'negative' },
    { w: 0, type: 'section-abandoned', dir: 'negative' },
  ],

  // UNCHANGED (empty). Pinned once, never touched.
  'sourdough-hydration': [],
};

export const HISTORY_TABLES = {
  shipped: SHIPPED,
  'three-register': THREE_REGISTER,
};

/**
 * THE CAPTURE SIGNAL, applied uniformly to every topic on the board.
 *
 * A pin is an attention signal and the product says so: `pin-interest` weighs
 * 0.05, the lowest weight in the table, annotated "signals attention, not
 * ability". Seeding one per pin is therefore the *weakest* honest statement the
 * ledger can make about a board, and it is a statement the board earns simply
 * by existing.
 *
 * It is here for a reason that is not cosmetic. Clustering is emergent: a run
 * can produce a topic no authored key maps onto — a rescued pin, or a cluster
 * that split — and such a topic has zero evidence, which the Composer reads as
 * `from-nothing` and the Gardener ranks at priority ~73, near the top of the
 * board. A single clustering wobble could therefore fill two of three section
 * slots with `from-nothing` and cost the session a register, for reasons that
 * have nothing to do with the learner.
 *
 * A uniform rule fixes that without touching any individual topic: with the
 * capture signal present, an evidence-only-from-pins topic reads comfort 1.00
 * at certainty ~0.01 — still `from-nothing`, because the certainty gate is
 * doing exactly its job, but ranked last rather than near the top. Measured
 * effect on every topic that has real evidence: under 0.01 of comfort.
 *
 * Set `false` to seed the ledger without it.
 */
export const CAPTURE_SIGNAL = { type: 'pin-interest', dir: 'positive' };
