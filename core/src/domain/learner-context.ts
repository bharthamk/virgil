import type { InjectionScan, QuarantinedLine } from './rubric.js';

/**
 * LEARNER CONTEXT — the third box on the Check screen, screened like the first.
 *
 * The Marker reads a piece of work against a pasted rubric and the Reviewer
 * reads a draft against what the learner is shaky on. Neither of them knows
 * what the learner was actually asked to do, which is the one thing their
 * lecturer wrote down and they can paste: the brief around the criteria, the
 * seminar instruction, the note to themselves about what this piece is for.
 *
 * It is the least trusted of the three boxes, and for the reason that is easy
 * to get backwards. The work is the learner's own writing and the rubric is
 * their provider's; this box is where a person pastes whatever they were sent,
 * from wherever it came, precisely because it is the box with no shape to it.
 * So it gets the treatment `parseRubric` gets and for the same reason — the
 * fidelity rule the whole QC gate is built on: scanned line by line before it
 * can reach a prompt, with anything hostile held back and REPORTED rather than
 * deleted.
 *
 * Three properties this file exists to hold:
 *
 *  1. **A flagged line never reaches the prompt.** It is reported instead, so a
 *     learner whose brief carries an instruction aimed at the AI layer is told
 *     that, rather than having their paste quietly edited.
 *  2. **An over-long context is cut and says so.** `truncated` is the same
 *     honesty `QcResult` already applies to the work: reading two thirds of
 *     something and reporting on all of it is the failure both agents are
 *     arranged to prevent.
 *  3. **Nothing at all is nothing at all.** An absent or empty context produces
 *     an empty `text`, and the callers render no section for it — the prompt a
 *     learner who pasted no context gets is byte for byte the prompt they got
 *     before this field existed.
 *
 * The scanner is injected rather than imported, exactly as `parseRubric` takes
 * it: `suspectedInjection` lives in `agents/untrusted.ts`, and a domain module
 * reaching up into `agents/` is the drift the seam guard exists to catch.
 */

/**
 * How much background a learner is allowed to spend.
 *
 * Sized against what it is for rather than against what a box can hold. A brief
 * is a page; four thousand characters is roughly two of them, which is more
 * than any assignment instruction in front of this product has needed and small
 * enough that the context cannot become the thing being marked. The work
 * (12,000) and the draft (6,000) are the material; this is the frame around it.
 */
export const MAX_CONTEXT_CHARS = 4_000;

export interface ScreenedContext {
  /**
   * What survived, ready to fence. Empty when there was none, and empty when
   * every line of it was held back — both of which mean no section is rendered.
   */
  readonly text: string;
  /** True when there was more of it than the cap above allows. */
  readonly truncated: boolean;
  readonly quarantined: readonly QuarantinedLine[];
}

const NOTHING: ScreenedContext = { text: '', truncated: false, quarantined: [] };

/**
 * Cap it, scan it line by line, and say what happened to it.
 *
 * The cap is applied BEFORE the scan on purpose: a scan of a megabyte of pasted
 * page is work nobody asked for, and the lines past the cap are not going to
 * the model either way. What the learner is told is that the context was cut,
 * which is true of the whole of the part they cannot see.
 */
export function screenContext(
  text: string | null | undefined,
  scan: InjectionScan,
): ScreenedContext {
  const raw = String(text ?? '');
  if (!raw.trim()) return NOTHING;

  const kept: string[] = [];
  const quarantined: QuarantinedLine[] = [];
  for (const line of raw.slice(0, MAX_CONTEXT_CHARS).split(/\r?\n/)) {
    const patterns = scan(line);
    if (patterns.length) { quarantined.push({ text: line, patterns, source: 'context' }); continue; }
    kept.push(line);
  }

  return { text: kept.join('\n').trim(), truncated: raw.length > MAX_CONTEXT_CHARS, quarantined };
}
