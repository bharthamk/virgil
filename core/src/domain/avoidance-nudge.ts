import { AVOIDANCE_ACTIVATION_LINE, AVOIDANCE_SLIPPING_LINE, avoidanceKeyForActionId } from './avoidance.js';
import type { ActionOption, AvailableMinutes } from './next-action.js';

/**
 * THE ADAPTATION, KEPT WHERE IT CAN BE TAKEN BACK OUT.
 *
 * Noticing that something keeps slipping is a read. Letting that read change
 * what the product offers is a decision, and it is the half that can do harm:
 * a ranking that quietly promotes whatever somebody has been avoiding is a
 * ranking that punishes them for a bad fortnight, on the one screen they open
 * when they have a minute and no resolve.
 *
 * So it is one function in one file, wired in at one named seam in
 * `chooseNextAction`, and deleting this module and that line removes the
 * behaviour completely while leaving the surfacing intact. That separation is
 * the point of the file, not an accident of tidiness.
 *
 * Three bounds, and each one closes a specific way this could go wrong:
 *
 *  1. **The one-minute block only.** A learner who has said they have one
 *     minute has already made the hardest decision, which is to open the thing
 *     at all. Three and five minutes are windows where they mean to do real
 *     work, and steering those toward the pile of things they have been
 *     circling would cost them the session they came for.
 *  2. **It never beats what is due.** `AVOIDANCE_NUDGE_CEILING` sits below the
 *     rank a commitment due today carries, so a deadline always wins. Something
 *     that has been slipping for a fortnight can wait one more day; the
 *     assignment due tonight cannot.
 *  3. **A deliberate deferral removes it entirely.** Not softened, removed:
 *     the keys handed in have already had the learner's own set-asides taken
 *     out of them, and a product that kept nudging after being told not to
 *     would be arguing with the one control it gave them.
 */

/**
 * How much of a lift, in the ranker's own units.
 *
 * Small on purpose. It is enough to put a slipping item above the ordinary
 * next material (340) and the quick take (300) inside a one-minute window, and
 * nowhere near enough to reach a prepared lesson (950) or a deadline. A
 * larger number would stop being a nudge and start being a reordering.
 */
export const AVOIDANCE_NUDGE_STEP = 120;

/**
 * The hard ceiling, whatever the lift would otherwise reach.
 *
 * 800, which is below the 840 a commitment the learner planned for today
 * carries and well below the 860 of one that is due today. Stated as a ceiling
 * rather than trusted to arithmetic, because the inputs to the step are ranks
 * this module does not own and a future rank it has never seen must not be able
 * to push a nudged item past a date.
 */
export const AVOIDANCE_NUDGE_CEILING = 800;

/** Only this window. See rule 1 above. */
export const AVOIDANCE_NUDGE_MINUTES: AvailableMinutes = 1;

/** What the learner reads under the offer, and it is the row's own two lines. */
export const AVOIDANCE_NUDGE_REASON = `${AVOIDANCE_SLIPPING_LINE} ${AVOIDANCE_ACTIVATION_LINE}`;

/**
 * The seam. Takes the ranked candidates before they are sorted and gives back
 * the same list, with at most a lift and a sentence on the ones that are
 * slipping.
 *
 * Returns the input array's contents unchanged when the window is not one
 * minute or when nothing is slipping, so the ordinary path pays nothing for
 * this existing.
 */
export function nudgeSlipping(
  options: readonly ActionOption[],
  slippingKeys: ReadonlySet<string>,
  availableMinutes: AvailableMinutes,
): readonly ActionOption[] {
  if (availableMinutes !== AVOIDANCE_NUDGE_MINUTES || !slippingKeys.size) return options;
  return options.map((option) => {
    const key = avoidanceKeyForActionId(option.id);
    if (!key || !slippingKeys.has(key)) return option;
    return {
      ...option,
      /**
       * A ceiling, never a demotion.
       *
       * The outer `max` is the whole of the difference between a nudge and a
       * reordering, and it was a real defect before it was a line: an overdue
       * assignment ranks 925, which is above the ceiling, so the plain
       * `min(ceiling, rank + step)` pushed the one thing most worth doing DOWN
       * to 800 for the crime of also being the thing that keeps slipping.
       * Something already above the ceiling keeps its rank and gains only the
       * sentence.
       */
      rank: Math.max(
        option.rank, Math.min(AVOIDANCE_NUDGE_CEILING, option.rank + AVOIDANCE_NUDGE_STEP),
      ),
      reasons: [{ code: 'slipping' as const, text: AVOIDANCE_NUDGE_REASON }, ...option.reasons],
    };
  });
}
