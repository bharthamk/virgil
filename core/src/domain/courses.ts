import type { TopicId } from './types.js';

/**
 * COURSES — the study controller.
 *
 * Courses group source material, links and derived learning progress.
 *
 * ## The rule that stops this being a bookmark manager
 *
 * A course is a list of links and a list of links is the *snapshot manager*
 * complaint at bigger scale. Two things earn this its place, and a piece of
 * material that has neither is furniture:
 *
 *  1. **It is pinnable.** A video or a reading added here is material the rest
 *     of Virgil already knows how to handle — the Forager can read it, the
 *     Clusterer can file it, and what the learner takes from it lands on the
 *     board as topics rather than as a tick.
 *  2. **Progress is mostly derived.** A course's real progress is what the
 *     board says about the topics its material produced, not how many boxes
 *     have been ticked. Ticking is allowed, because a lecture watched in a hall
 *     leaves no trace Virgil can see and refusing to record it would just make
 *     the product wrong — but a tick is never the *only* thing a course knows
 *     about itself.
 *
 * An earlier study-tracking surface is the precedent, and its one rule is worth
 * repeating here: *zero added effort — the learner never has to "do" the study
 * controller.* Anything here that becomes homework has failed.
 */

export type MaterialKind = 'video' | 'reading' | 'class' | 'exercise' | 'other';

/** Learner-owned display text is accepted whole or refused at every route
 * that can create or repair the same record. These are Unicode code-point
 * limits; callers must not apply UTF-16 `slice` semantics. */
export const COURSE_TITLE_MAX_CHARS = 160;
export const COURSE_PROVIDER_MAX_CHARS = 120;
export const MATERIAL_TITLE_MAX_CHARS = 180;
export const COURSE_SOURCE_TITLE_MAX_CHARS = 160;

/** The learner-visible receipt behind an imported fact. */
export interface SourceRef {
  readonly sourceId: string;
  /** A short, exact span from the source. Never treated as an instruction. */
  readonly quote: string;
}

export type CourseSourceKind =
  | 'syllabus'
  | 'rubric'
  | 'assignment-brief'
  | 'course-page'
  | 'learner-note'
  | 'image'
  | 'other';

/**
 * An immutable receipt for material Virgil used to understand a course.
 *
 * `digest` lets an import and its later audit prove they read the same bytes
 * without asking a model or a remote page again. The raw text is kept because
 * provenance that cannot be inspected is only a label saying provenance.
 */
export interface CourseSource {
  readonly id: string;
  readonly kind: CourseSourceKind;
  readonly title: string;
  readonly text: string;
  readonly url: string | null;
  readonly capturedAt: string;
  readonly digest: string;
}

export interface CourseObjective {
  readonly id: string;
  readonly text: string;
  readonly source: SourceRef | null;
}

export interface Material {
  readonly id: string;
  readonly title: string;
  /** Clickable, and the thing the Forager reads. Empty for an in-person class. */
  readonly url: string;
  readonly kind: MaterialKind;
  /** Minutes, when the learner or the source knows. Used by the burst planner. */
  readonly minutes: number | null;
  /**
   * Marked done by the learner. The honest floor: a lecture in a hall leaves no
   * trace, and a product that only counts what it can see would tell somebody
   * who attended everything that they have done nothing.
   */
  readonly doneAt: string | null;
  /**
   * Minutes the learner explicitly said they spent on this item through a
   * bounded Today action. Optional for every historical/imported row. Opening
   * a link does not increment it; only the return check-in does.
   */
  readonly progressMinutes?: number;
  /** Pins this material produced, if any — the evidence half of progress. */
  readonly pinIds: readonly string[];
  readonly addedAt: string;
  /** Present when this row was confirmed from an imported source. */
  readonly source?: SourceRef | null;
}

export interface Course {
  readonly id: string;
  readonly title: string;
  /** Where it is taught — "Udacity", "YouTube", "the university". Free text. */
  readonly provider: string;
  readonly url: string;
  readonly material: readonly Material[];
  /** Topics the board has grown out of this course's material. */
  readonly topicIds: readonly TopicId[];
  /** Optional for boards written before reviewed course intake existed. */
  readonly objectives?: readonly CourseObjective[];
  /** Source receipts are append-only within a course. */
  readonly sources?: readonly CourseSource[];
  readonly archivedAt: string | null;
  readonly createdAt: string;
}

/**
 * What a course can honestly say about itself.
 *
 * Two numbers rather than one, because they are two different claims and
 * collapsing them into a single percentage would let the weaker one carry the
 * stronger one's authority:
 *
 *  - `covered` is how much of the material has been got through. Self-reported,
 *    and said as a count rather than a percentage — "9 of 14" can be checked by
 *    looking, where "64%" is a number that has to be trusted.
 *  - `learnt` is how many of the topics this course produced the board calls
 *    settled. Evidence, and the only half of this the product would defend.
 *
 * There is deliberately no combined score. SB-33 is that comfort is never shown
 * as a number, and a course percentage is a comfort number with a course's name
 * on it.
 */
export interface CourseProgress {
  readonly covered: number;
  readonly materialCount: number;
  readonly learnt: number;
  readonly topicCount: number;
}

export function courseProgress(
  course: Course,
  settledTopicIds: ReadonlySet<TopicId>,
): CourseProgress {
  return {
    covered: course.material.filter((m) => m.doneAt).length,
    materialCount: course.material.length,
    learnt: course.topicIds.filter((id) => settledTopicIds.has(id)).length,
    topicCount: course.topicIds.length,
  };
}

/** The next thing to get through, or null when everything is done. */
export function nextMaterial(course: Course): Material | null {
  return course.material.find((m) => !m.doneAt) ?? null;
}

/**
 * Whether a URL is one Virgil can offer to open.
 *
 * A material row's link is rendered as an anchor, so an untrusted string
 * reaches the DOM as an href. `javascript:` and `data:` URLs are the two that
 * turn a bookmark list into a script injection, and a course can be created
 * from a pasted syllabus, which is text nobody wrote by hand.
 */
export function isOpenableUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}
