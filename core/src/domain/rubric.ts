/**
 * THE RUBRIC — the bar the work is marked against, parsed rather than inferred.
 *
 * Assignment QC evaluates submitted work against its rubric and context.
 *
 * The shape comes from an earlier QC-gate design that was used heavily enough
 * to earn its rules the hard way. Two of them decide this file:
 *
 *  1. **The bar is never the marker's own. A gate marks against the verbatim
 *     rubric, not a paraphrase of it.** So the criteria are split out of the
 *     learner's own pasted text, deterministically, in code. If the model were
 *     asked to *find* the criteria it would be marking against its own reading
 *     of the brief, and a criterion it never noticed would pass silently. That
 *     is the single
 *     failure mode that would make this feature worse than useless — a clean
 *     verdict on work that misses a requirement.
 *  2. **"Fidelity is proven, not trusted"** and runs FIRST. A pasted brief is
 *     text nobody in this product wrote, arriving from a provider's website,
 *     and it is about to be handed to a model along with instructions. It gets
 *     the injection scan before anything else happens to it.
 */

/**
 * The injection scan, passed in rather than imported.
 *
 * `suspectedInjection` lives in `agents/untrusted.ts`, and this file is domain:
 * it was the only module under `domain/` reaching up into `agents/`, which is
 * the wrong way round and exactly the kind of drift the seam guard exists to
 * catch one layer up. Taking the scanner as an argument keeps the dependency
 * explicit, keeps the rule testable with a stub, and leaves the parse pure.
 */
export type InjectionScan = (text: string) => readonly string[];

export interface Criterion {
  /** Stable within one mark, so a row can be matched back to what it marks. */
  readonly id: string;
  /** The criterion, as the learner pasted it. Never reworded. */
  readonly text: string;
}

/**
 * Which box on the screen a held-back line came out of.
 *
 * One line of type for the sake of the sentence the panel gets to write. "A
 * line of what you pasted was held back" is a report the learner cannot act on
 * when two boxes were pasted into; "a line of your rubric" and "a line of your
 * context" are two they can. It costs a field, and it is set where the line is
 * found rather than inferred later from which list it turned up in.
 */
export type QuarantineSource = 'rubric' | 'context';

/**
 * A line held back before the text it came from went anywhere near a model,
 * and why.
 *
 * Kept and reported rather than silently dropped: text that carries an
 * instruction aimed at the AI layer is a fact the learner should be told
 * about — it may be their provider's doing, or it may be a page they copied
 * from — and a QC that quietly edits the bar is a QC nobody can trust.
 */
export interface QuarantinedLine {
  readonly text: string;
  readonly patterns: readonly string[];
  readonly source: QuarantineSource;
}

export interface ParsedRubric {
  readonly criteria: readonly Criterion[];
  readonly quarantined: readonly QuarantinedLine[];
}

/** Longer than this and it is a paragraph of the brief, not a criterion. */
export const MAX_CRITERION = 400;
/** Shorter than this and it is a heading or a stray bullet. */
const MIN_CRITERION = 12;
/** A rubric longer than this is a document; marking it row by row is not a QC. */
export const MAX_CRITERIA = 24;

/** A rubric outside the truthful marking envelope is a learner-correctable
 * input refusal, never a partial bar that can still produce a normal verdict. */
export class RubricLimitError extends Error {
  constructor(readonly code: 'criterion-too-long' | 'too-many-criteria', message: string) {
    super(message);
    this.name = 'RubricLimitError';
  }
}

/** Leading list furniture: "1.", "1)", "- ", "* ", "• ", "a) ", "Criterion 3:". */
const BULLET = /^\s*(?:[-*•‣]|\(?\d{1,2}[.)]|[a-z][.)]|criterion\s+\d{1,2}\s*[:.]?)\s+/i;

/**
 * One criterion per line, which is how every rubric anybody pastes is written.
 *
 * Deliberately dumb, and that is the point: a clever parser is one that can be
 * wrong about what the bar is. What it does is strip list furniture, drop what
 * is obviously not a criterion, and keep the learner's words. Anything it gets
 * wrong is visible on the screen as a row with the wrong text in it, which the
 * learner can see and fix by editing what they pasted — a failure they can
 * correct, rather than a criterion silently missing from the mark.
 */
export function parseRubric(text: string, scan: InjectionScan): ParsedRubric {
  const criteria: Criterion[] = [];
  const quarantined: QuarantinedLine[] = [];

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(BULLET, '').trim();
    if (line.length < MIN_CRITERION) continue;
    // A heading is a line with no verb and a colon at the end, or one in title
    // case with nothing after it. Only the cheapest, least wrong test: a line
    // that is entirely a heading ("Assessment criteria:") tells the marker
    // nothing and would take a row it cannot fill.
    if (/^[^.?!]{0,60}:$/.test(line)) continue;

    // The fidelity gate, before this line can reach a prompt.
    const patterns = scan(line);
    if (patterns.length) { quarantined.push({ text: line, patterns, source: 'rubric' }); continue; }

    if (Array.from(line).length > MAX_CRITERION) {
      throw new RubricLimitError(
        'criterion-too-long',
        `each criterion must contain at most ${MAX_CRITERION} characters; nothing was marked`,
      );
    }
    if (criteria.length >= MAX_CRITERIA) {
      throw new RubricLimitError(
        'too-many-criteria',
        `a rubric may contain at most ${MAX_CRITERIA} criteria; nothing was marked`,
      );
    }
    criteria.push({ id: `c${criteria.length + 1}`, text: line });
  }
  return { criteria, quarantined };
}

/**
 * What the whole mark says, from the rows and nothing else.
 *
 * **A single `does-not-meet` is send-back. No averaging away a miss** — the
 * earlier gate's rule, and the one that makes a QC worth having: a piece of
 * work that fails one criterion fails, and a product that reports "18 of 20,
 * looking good" about it has told the learner the opposite of what the marker
 * will.
 *
 * `unmarked` counts the same way. A criterion the model did not answer is not
 * evidence of anything, and clearing work on a row nobody read is the failure
 * this whole file is arranged to prevent.
 */
export type CriterionVerdict = 'meets' | 'partial' | 'does-not-meet' | 'unmarked';
export type MarkVerdict = 'clear' | 'send-back';

export const markVerdict = (verdicts: readonly CriterionVerdict[]): MarkVerdict =>
  verdicts.every((v) => v === 'meets') ? 'clear' : 'send-back';

/**
 * The sentence at the top of the mark.
 *
 * Says what is wrong and how much of it, and never congratulates: "18 of 20"
 * is a score, and a score on a piece of work that fails a criterion is the
 * comfortable lie this product exists not to tell.
 */
export function markSummary(verdicts: readonly CriterionVerdict[]): string {
  if (!verdicts.length) return 'I could not find any criteria in what you pasted.';
  const missed = verdicts.filter((v) => v === 'does-not-meet').length;
  const partial = verdicts.filter((v) => v === 'partial').length;
  const unmarked = verdicts.filter((v) => v === 'unmarked').length;

  if (!missed && !partial && !unmarked) {
    // Not "well done". It reads as sound against the criteria that were pasted,
    // which is a narrower claim than it being good, and the narrower claim is
    // the true one.
    return 'Nothing here misses a criterion. That is not the same as a good mark.';
  }
  const parts: string[] = [];
  if (missed) parts.push(`${missed} ${missed === 1 ? 'criterion is' : 'criteria are'} not met`);
  if (partial) parts.push(`${partial} partly met`);
  if (unmarked) parts.push(`${unmarked} I could not read a verdict on`);
  return `${parts.join(', ')}. Fix the misses before you send it.`;
}
