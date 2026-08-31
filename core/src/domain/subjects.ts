import type { TopicId } from './types.js';
import type { Course } from './courses.js';
import type { Commitment } from './commitments.js';

/**
 * WHICH SUBJECT A TOPIC BELONGS TO, WHEN THE BOARD HONESTLY KNOWS.
 *
 * A lineup names the subject for each row because three rows
 * headed *How TLS gets its keys*, *Marginal cost* and *Recursion* are an
 * evening from three different courses, and a lineup that does not say so is a
 * list of disconnected sentences.
 *
 * ## What actually links a topic to a course, and what only looks like it does
 *
 * The board has two fields that appear to answer this and one that does.
 *
 *  - `Course.topicIds` — *"Topics the board has grown out of this course's
 *    material"*. Declared, read by `courseProgress`, and **written by nothing**:
 *    every course this service creates is stored with `topicIds: []`, at
 *    `service.ts` course creation and at draft application alike. It is the
 *    same shape `Commitment.topicIds` was in before The study-linking contract — a link that
 *    exists in the type and in no store.
 *  - `Material.pinIds` — *"Pins this material produced"*. Same: declared, and
 *    written `[]` everywhere a material is made.
 *  - `Commitment.courseId` **and** `Commitment.topicIds` — both real. The
 *    course id is set whenever an obligation comes from an applied intake
 *    draft, and the topic ids became writable under the study-linking contract, from the dated
 *    form and from the Plan card's menu, validated against the board.
 *
 * So the honest join runs through the commitment, and this function is that
 * join and nothing more. It invents no membership: a topic nobody has linked to
 * a dated piece of work belonging to a course has no subject, and the surface
 * shows nothing rather than a guess.
 *
 * ## Why the course's own list is still read first
 *
 * Because it is the stronger claim when it is there. A course that names a
 * topic is the course saying so; a commitment is the learner saying two things
 * that imply it. Reading the direct field first costs nothing today, and means
 * the day anything does populate it, this function is already correct rather
 * than already stale.
 *
 * ## Why it derives rather than backfilling
 *
 * Writing the implied topics into `Course.topicIds` would be the obvious fix
 * and it would break something: `courseProgress` counts `learnt` out of that
 * list, and it is careful to be *"the only half of this the product would
 * defend"* — evidence, not self-report. Widening the denominator from what a
 * course produced to what a learner happens to have linked a deadline to would
 * put a weaker claim inside the stronger one's number. A label on a row can be
 * derived from a weaker link; a progress count cannot.
 *
 * Pure, deterministic, no model, no I/O.
 */
export interface TopicSubject {
  readonly courseId: string;
  /** The course's own title, as stored. Never abbreviated here — the surface
   *  that draws it decides how much of it fits. */
  readonly title: string;
}

export function subjectForTopic(
  topicId: TopicId,
  courses: readonly Course[],
  commitments: readonly Commitment[],
): TopicSubject | null {
  const live = courses.filter((c) => !c.archivedAt);
  const named = (id: string): Course | undefined => live.find((c) => c.id === id);

  // The direct claim: the course says this topic came out of its material.
  const direct = live.find((c) => c.topicIds.includes(topicId));
  if (direct) return { courseId: direct.id, title: direct.title };

  /**
   * The implied claim, through the one link the store actually holds.
   *
   * Open commitments first, and then the closed ones. A topic that is on the
   * hook for something due this week belongs, for the purpose of a label on
   * tonight's lineup, to that thing's course; a topic whose only link is an
   * assignment handed in a month ago still belongs to the same subject, which
   * is why the closed ones are read at all rather than filtered away.
   *
   * Ordered by date within each half so that a topic linked to two courses
   * gets the same answer on every render. An arbitrary answer that changed
   * between paints would be worse than no answer.
   */
  const linked = commitments
    .filter((c) => c.courseId && c.topicIds.includes(topicId))
    .sort((a, b) =>
      Number(Boolean(a.doneAt)) - Number(Boolean(b.doneAt))
      || a.dueAt.localeCompare(b.dueAt)
      || a.id.localeCompare(b.id));

  for (const commitment of linked) {
    const course = named(commitment.courseId as string);
    if (course) return { courseId: course.id, title: course.title };
  }
  // A commitment naming a course that is gone or archived is not a subject.
  // The label is a door, and a door has to open onto something.
  return null;
}


export interface TopicCommitment {
  readonly commitmentId: string;
  readonly title: string;
}

export function commitmentForTopic(
  topicId: TopicId,
  commitments: readonly Commitment[],
  now: Date,
): TopicCommitment | null {
  const open = commitments
    .filter((c) => !c.doneAt && c.topicIds.includes(topicId))
    .filter((c) => Number.isFinite(Date.parse(c.dueAt)))
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id));
  const nearest = open[0];
  // `now` is taken rather than read so this stays pure and so a caller that
  // wants "as of the run" and one that wants "as of this request" get the same
  // function. Nothing here is time-dependent beyond that ordering today; the
  // parameter is what keeps it honest if a window is ever added.
  void now;
  return nearest ? { commitmentId: nearest.id, title: nearest.title } : null;
}
