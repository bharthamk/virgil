import type { TopicId } from './types.js';
import { rendersEmpty, stripInvisible } from './text.js';

/**
 * The verifier-withholding contract — the closing note may not name a section the learner never saw.
 *
 * The 2026-08-20 benchmark run measured the defect end to end. The Composer
 * writes one closing note over every section it composed; the Verifier then
 * withholds whichever of those sections failed their check; nothing recomposes
 * the note. The stored session said *"Firestore index constraints and IAM
 * condition evaluation rules moved into practice; instrument-based chord
 * execution remains open"* on a night when two of those three sections had
 * been removed — the learner told they had practised two things that were
 * never in front of them.
 *
 * Each half of that is correct on its own. The Composer's note is true about
 * what it composed and the Verifier's withhold is true about what it checked;
 * it is the seam between them that lies. So the repair belongs here, at the
 * seam, and not in either agent.
 *
 * **The strip is mechanical and there is no model call on this path, ever.**
 * That is the ruling, and the reasoning behind it is worth keeping next to the
 * code: a withhold night is a night on which something already went wrong, and
 * spending a second model call to rewrite one sentence would mean the failure
 * path costs more than the success path. Regeneration and voiding every note
 * were both considered and declined — a slightly stilted note beats a false
 * claim, and a withhold night must not buy extra compute.
 *
 * Mechanical means it fails closed rather than cleverly:
 *
 *  - **Clause granularity.** The note is prose, not a per-topic structure —
 *    `closingNote` is one string in the Composer's schema, contracted as
 *    "three short clauses". So the unit removed is the clause, split on the
 *    same `[.;!?]` boundary `session-score.ts` counts clauses on. A clause
 *    naming a withheld topic *and* a kept one goes whole: "Firestore and IAM
 *    both moved" is one claim about two things and half of it is false, and
 *    there is no mechanical way to keep the true half without writing prose.
 *  - **The paraphrase backstop.** Prose can be about a topic without using any
 *    of its words. "The database work landed" is a claim about a withheld
 *    Firestore section that no substring match will ever find. So when a
 *    withheld topic's labels appear NOWHERE in the note, the strip cannot show
 *    it did not miss something, and the whole note is dropped. Full voiding is
 *    the backstop, not the rule.
 *  - **The empty residue.** A note stripped down to "Open." names nothing and
 *    is not a closing note. It goes too.
 *
 * What still cannot fail closed, said out loud: a note that paraphrases a
 * withheld topic *and also names it somewhere else* passes the backstop, gets
 * the naming clause stripped, and keeps the paraphrase. Nothing short of
 * reading the prose catches that, and reading the prose is a model call.
 */

/**
 * A withheld section, with everything the session carries that could name it.
 *
 * Two label fields because the product has two names for the same thing and
 * the note may use either: the Composer names sections (`heading`) and the
 * Clusterer names topics (`label`). `label` is optional because a session read
 * back off disk knows its withheld headings and may not have its topics to
 * hand — and a topic matched on one field is still matched.
 */
export interface WithheldTopicLabels {
  readonly topicId: TopicId;
  readonly heading: string;
  readonly label?: string | null;
}

export type ClosingNoteOutcome =
  /** There was no note to strip. */
  | 'no-note'
  /** Nothing was withheld. The note is the composed one, byte for byte. */
  | 'untouched'
  /** Every withheld topic was named, and every clause naming one is gone. */
  | 'stripped'
  /** A withheld topic is named nowhere — a paraphrase cannot be ruled out. */
  | 'dropped-unnamed'
  /** Nothing that names anything survived the strip. */
  | 'dropped-empty';

export interface ClosingNoteResult {
  /** What the session should close on. `null` means it closes on nothing. */
  readonly note: string | null;
  readonly outcome: ClosingNoteOutcome;
  /** The clauses removed, verbatim, for the run log. */
  readonly removed: readonly string[];
  /** Withheld topics whose labels appear nowhere in the note. */
  readonly unnamed: readonly TopicId[];
  /** One line, readable by someone who has not read this file. */
  readonly detail: string;
}

/**
 * Below this many letters and digits, a residue is not a closing note.
 *
 * The note's whole contract is "what moved and what is still open", and
 * naming one of those takes more than a word. "Cloud Run — one gap left"
 * clears it at 20; "Open." does not clear it at 4. Deliberately a floor on
 * *characters that carry meaning* rather than on length: a residue of dashes,
 * ellipses and spaces can be arbitrarily long and say nothing.
 */
export const CLOSING_NOTE_MIN_CHARS = 12;

/**
 * The clause form of a heading, matching `panel-core.ts`'s `CLAUSE_HEADING`.
 *
 * Section headings are model output and can run long; the panel cuts them at
 * 48 characters when a heading has to sit inside one clause of card copy. A
 * note that carries the short form is naming the same section, and a strip
 * that missed it would drop an entire note for a defect that is not there.
 */
export const CLOSING_NOTE_LABEL_CLAUSE = 48;

/**
 * Comparable form: invisibles gone, whitespace collapsed, case folded.
 *
 * `toLowerCase` rather than `toLocaleLowerCase` on purpose — the same note
 * must strip identically on every machine that runs the nightly, and a
 * locale-sensitive fold makes that untrue for Turkish dotted i.
 */
const norm = (text: unknown): string =>
  stripInvisible(String(text ?? '')).toLowerCase().replace(/\s+/g, ' ').trim();

/** A clause boundary, and the punctuation stays with the clause it ends. */
const CLAUSE_BREAK = /([.;!?]+["'”’)\]]*\s+)/;

/** The note in clauses, each carrying its own trailing punctuation and space,
 *  so the survivors re-join into the original text rather than a rewrite. */
function clausesOf(note: string): string[] {
  const parts = note.split(CLAUSE_BREAK);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const clause = (parts[i] ?? '') + (parts[i + 1] ?? '');
    if (!clause) continue;
    // A clause with no text of its own — a note opening on punctuation, or a
    // run of separators — belongs to the clause before it rather than standing
    // as a unit that could be kept while its sentence is removed.
    if (!(parts[i] ?? '').trim() && out.length) out[out.length - 1] += clause;
    else out.push(clause);
  }
  return out;
}

/**
 * Every string that would count as naming this topic.
 *
 * Empty when the session carries no usable label for it, which is not a
 * shrug: a topic that cannot be matched cannot be shown absent from the note
 * either, so it falls through to the backstop and the note goes.
 */
function formsFor(w: WithheldTopicLabels): string[] {
  const out = new Set<string>();
  for (const raw of [w.heading, w.label]) {
    const n = norm(raw);
    if (!n) continue;
    out.add(n);
    if (n.length > CLOSING_NOTE_LABEL_CLAUSE) out.add(n.slice(0, CLOSING_NOTE_LABEL_CLAUSE - 1).trim());
  }
  return [...out].filter(Boolean);
}

/**
 * Does this text name that label — beginning where a word begins?
 *
 * A bare `includes` is the wrong test in the one direction that matters. Over-
 * matching is safe on its own (a clause is removed that could have stayed), but
 * it ALSO marks the topic as named, and a topic marked named skips the
 * paraphrase backstop. A label of "iam" found inside "miami" would clear a
 * withheld topic that the note never mentions. So the match must start where a
 * word starts.
 *
 * The END is deliberately not fenced. A label matched against an inflected form
 * — "index" inside "indexes", a heading against its own 48-character clause cut
 * — is naming the same topic, and refusing those would drop whole notes for
 * defects that are not there.
 */
function containsLabel(text: string, label: string): boolean {
  for (let at = text.indexOf(label); at !== -1; at = text.indexOf(label, at + 1)) {
    if (at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1] as string)) return true;
  }
  return false;
}

/** The letters and digits left in a string, spaced. Punctuation is not content. */
const contentOf = (text: string): string =>
  stripInvisible(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Which withheld topics the note names, by their own labels.
 *
 * Read-only, and exported for the scorecard: `session-score.ts` asks exactly
 * this question as a hard check, and asking it with a second implementation is
 * how a check and the code it checks stop agreeing.
 */
export function withheldTopicsNamedIn(
  note: string | null | undefined,
  withheld: readonly WithheldTopicLabels[],
): readonly TopicId[] {
  const text = norm(note);
  if (!text) return [];
  return withheld
    .filter((w) => formsFor(w).some((f) => containsLabel(text, f)))
    .map((w) => w.topicId);
}

/**
 * The closing note a session withheld sections from is allowed to carry.
 *
 * Two arguments, neither of them `deps`. That is the ruling in the signature.
 */
export function stripWithheldTopics(
  note: string | null | undefined,
  withheld: readonly WithheldTopicLabels[],
): ClosingNoteResult {
  // Checked before the note is even read, so a clean night's note is returned
  // as the identical string rather than one that survived a round trip through
  // a splitter. Nothing happened to it, and nothing should have.
  if (!withheld.length) {
    return {
      note: note ?? null, outcome: 'untouched', removed: [], unnamed: [],
      detail: 'nothing withheld — the closing note is as composed',
    };
  }

  if (note === null || note === undefined || rendersEmpty(note)) {
    return {
      note: null, outcome: 'no-note', removed: [], unnamed: [],
      detail: 'no closing note to strip',
    };
  }

  const forms = withheld.map((w) => [w.topicId, formsFor(w)] as const);
  const named = new Set<TopicId>();
  const keep: string[] = [];
  const removed: string[] = [];

  for (const clause of clausesOf(note)) {
    const text = norm(clause);
    let hit = false;
    for (const [topicId, fs] of forms) {
      if (!fs.some((f) => containsLabel(text, f))) continue;
      named.add(topicId);
      hit = true;
    }
    (hit ? removed : keep).push(clause);
  }

  // The backstop. A topic named nowhere is a topic the strip cannot prove it
  // did not miss — prose paraphrases, and no substring match reaches a
  // paraphrase. A missing note is honest; a note that may be claiming a
  // section the learner never saw is not.
  const unnamed = withheld.filter((w) => !named.has(w.topicId)).map((w) => w.topicId);
  if (unnamed.length) {
    return {
      note: null, outcome: 'dropped-unnamed', removed, unnamed,
      detail: `closing note DROPPED — ${unnamed.length} withheld topic(s) named nowhere in it,`
        + ' so a paraphrase cannot be ruled out',
    };
  }

  const rest = keep.join('').trim();
  if (contentOf(rest).length < CLOSING_NOTE_MIN_CHARS) {
    return {
      note: null, outcome: 'dropped-empty', removed, unnamed: [],
      detail: `closing note DROPPED — ${removed.length} clause(s) named withheld sections`
        + ' and nothing that names anything was left',
    };
  }

  return {
    note: rest, outcome: 'stripped', removed, unnamed: [],
    detail: `closing note stripped — ${removed.length} clause(s) naming withheld sections removed`,
  };
}
