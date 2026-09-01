import type { DepthRegister, Pin } from './types.js';
import { type ComfortRead, registerFor } from './registers.js';

/**
 * WHY THIS LESSON, IN WORDS THE LEARNER CAN RECOGNISE.
 *
 * The lesson explains its source in learner-recognisable terms, not pipeline
 * vocabulary.
 *
 * The machinery reason already exists and is already shown: the ranker writes
 * one, and the sources disclosure carries it. It answers a different question.
 * *"Nothing here has been asked about yet"* is a defensible account of a sort
 * and it is not what somebody opening a lesson wants; what they want is the
 * thing they did themselves, given back to them. They saved two pages in July.
 * That is why this exists, and it is a fact rather than a ranking.
 *
 * ## Two rules, and the second one is the one that matters
 *
 *  - **Nothing here is invented.** Every clause is read off pins the learner
 *    made and the register the ledger already computed. There is no sentiment,
 *    no encouragement, and no claim about them that a signal did not produce.
 *  - **Thin facts produce a shorter line, or none.** A topic with nothing the
 *    learner saved returns `null` and the lesson opens on its heading, which is
 *    the honest answer. A scaffolding sentence written to fill the slot would
 *    be worse than the silence it replaced, and the whole complaint upstream is
 *    about copy that existed for the machine's benefit.
 *
 * It also does not repeat the register chip sitting above it. The chip is a
 * label; the second sentence is what that label DID, which is the half a
 * learner cannot see anywhere else.
 */
export interface SavedForLesson {
  /** The page identity, so two selections from one page are one page. */
  readonly page: string | null;
  /** When the learner saved it, ISO. An unreadable stamp drops the date and
   *  keeps the page: the pin is real either way. */
  readonly at: string;
}

export interface LessonGroundingFacts {
  /** What the learner saved on this topic. Their own pins, never references
   *  the Forager found: "you saved" has to be true of every one of them. */
  readonly saved: readonly SavedForLesson[];
  readonly register: DepthRegister;
  readonly now: Date;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Counted the way somebody says it out loud. Past ten, a numeral is how it is
 *  said, so the numeral is what it becomes. */
const COUNTS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** What the register means for where this lesson starts, never what it is
 *  called. The chip above already says what it is called. */
const CONSEQUENCE: Record<DepthRegister, string> = {
  'from-nothing': 'This is the groundwork, so this is where we start.',
  'building': 'You have met some of this already, so we pick it up from there.',
  'fluent': 'You have covered this before, so we go straight to what is still open.',
};

/**
 * The one month every saved page falls in, or nothing.
 *
 * A single month is a memory somebody can check against their own week. Pages
 * saved across two months are a range, and a range is either a longer sentence
 * or a rounded-off claim; both are worse than saying only what is certain, so
 * the clause is dropped and the count carries the line alone.
 */
function sharedMonth(dates: readonly number[], now: Date): string | null {
  if (!dates.length) return null;
  const first = new Date(dates[0]!);
  const month = first.getMonth();
  const year = first.getFullYear();
  for (const value of dates) {
    const at = new Date(value);
    if (at.getMonth() !== month || at.getFullYear() !== year) return null;
  }
  const named = MONTHS[month];
  if (!named) return null;
  // The year only where it is not this one. "in July" is how somebody refers to
  // a month they have lived through; "in July 2026" in August 2026 is a receipt.
  return year === now.getFullYear() ? `in ${named}` : `in ${named} ${year}`;
}

export function lessonGroundingLine(facts: LessonGroundingFacts): string | null {
  const pages = new Map<string, number[]>();
  for (const [index, item] of facts.saved.entries()) {
    // A pin with no page identity is its own page rather than everyone else's:
    // merging them would undercount what the learner actually did.
    const key = item.page?.trim() || `pin:${index}`;
    const at = Date.parse(item.at);
    const dates = pages.get(key) ?? [];
    if (Number.isFinite(at)) dates.push(at);
    pages.set(key, dates);
  }
  if (!pages.size) return null;
  const count = COUNTS[pages.size] ?? String(pages.size);
  const noun = pages.size === 1 ? 'page' : 'pages';
  // Every page, or no month at all. One unreadable stamp among them makes "in
  // July" a claim about a page nothing dates, which is the one kind of mistake
  // this line exists to avoid.
  const dated = [...pages.values()];
  const when = dated.every((dates) => dates.length)
    ? sharedMonth(dated.flat(), facts.now) : null;
  const saved = when
    ? `You saved ${count} ${noun} about this ${when}.`
    : `You saved ${count} ${noun} about this.`;
  return `${saved} ${CONSEQUENCE[facts.register]}`;
}

/**
 * The same line, from the two lists a reader of the board already holds.
 *
 * Here rather than at the caller so the join is testable: which pins count as
 * this lesson's, what stands in for a page when a capture has no url, and
 * which comfort reading decides the register are all decisions, and a decision
 * made inside a request handler is a decision nothing checks. The register is
 * read exactly as the Composer reads it, so the sentence cannot disagree with
 * the chip above it.
 */
export function lessonGroundingFor(
  topicId: string,
  pins: readonly Pin[],
  comforts: readonly (ComfortRead & { readonly topicId: string })[],
  now: Date,
): string | null {
  return lessonGroundingLine({
    saved: pins.filter((pin) => pin.topicId === topicId).map((pin) => ({
      page: pin.envelope.canonicalUrl ?? pin.envelope.url ?? null, at: pin.capturedAt,
    })),
    register: registerFor(comforts.find((read) => read.topicId === topicId)),
    now,
  });
}
