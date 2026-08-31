/**
 * The panel's decisions, without the DOM.
 *
 * The panel is mostly template strings, and template strings are not where the
 * risk is. The risk is in the handful of judgements underneath them: what a
 * screen claims when half a session is done, what a split is allowed to do,
 * and above all the sentences the confirm step shows before a merge or a split
 * happens. Those sentences are a trust control, not copy — they promise the
 * learner that nothing they have done is lost — so they are asserted here
 * verbatim rather than eyeballed in a screenshot.
 */
import type { PagesOutcome, UploadFormat, UploadOutcome } from './upload.js';
export { budgetStatusLine } from './model-budget-status.js';

/**
 * Keep an ordered collection inside a real serialized-payload ceiling.
 *
 * The caller supplies the complete wire payload, not merely the item text, so
 * envelope fields, JSON escaping, and multibyte characters all count. The
 * byte reader is injectable only to keep the boundary independently testable;
 * production uses the browser's UTF-8 encoder.
 */
export function chunkByPayloadBytes<T, P>(
  items: readonly T[],
  payloadFor: (items: T[]) => P,
  maxBytes: number,
  tooLarge: (item: T) => Error = () => new Error('one item exceeds the request limit'),
  byteLength: (payload: P) => number = (payload) =>
    new TextEncoder().encode(JSON.stringify(payload)).byteLength,
): T[][] {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new RangeError('maxBytes must be positive');
  const chunks: T[][] = [];
  let chunk: T[] = [];
  for (const item of items) {
    const next = [...chunk, item];
    if (byteLength(payloadFor(next)) <= maxBytes) {
      chunk = next;
      continue;
    }
    if (!chunk.length) throw tooLarge(item);
    chunks.push(chunk);
    chunk = [item];
    if (byteLength(payloadFor(chunk)) > maxBytes) throw tooLarge(item);
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

export interface PayloadChunk<T> {
  readonly items: readonly T[];
  readonly part: number;
  readonly from: number;
  readonly to: number;
  readonly total: number;
}

/**
 * Read at most one item beyond the next wire chunk, then yield control to the
 * sender. The generator does not continue mapping while that send is pending;
 * abandoning the loop after a refusal therefore leaves every later file
 * untouched and lets the completed payload become collectible.
 */
export async function* mapPayloadChunks<I, T, P>(
  inputs: readonly I[],
  map: (input: I, index: number) => Promise<T>,
  payloadFor: (items: T[]) => P,
  maxBytes: number,
  tooLarge: (item: T) => Error = () => new Error('one item exceeds the request limit'),
): AsyncGenerator<PayloadChunk<T>, void, void> {
  let pending: T[] = [];
  let sent = 0;
  let part = 0;
  for (let index = 0; index < inputs.length; index += 1) {
    const item = await map(inputs[index]!, index);
    const chunks = chunkByPayloadBytes(
      [...pending, item], payloadFor, maxBytes, tooLarge,
    );
    if (chunks.length === 1) {
      pending = chunks[0]!;
      continue;
    }
    const ready = chunks[0]!;
    part += 1;
    yield { items: ready, part, from: sent + 1, to: sent + ready.length, total: inputs.length };
    sent += ready.length;
    pending = chunks[1]!;
  }
  if (pending.length) {
    part += 1;
    yield { items: pending, part, from: sent + 1, to: sent + pending.length, total: inputs.length };
  }
}

/**
 * The name a folder item keeps after the folder root has already become the
 * course-drop title. A basename alone makes `week-01/notes.md` and
 * `week-09/notes.md` indistinguishable on the board; repeating the root on all
 * three hundred rows adds noise without restoring information.
 */
export function folderItemPath(fileName: string, webkitRelativePath?: string): string {
  const parts = (webkitRelativePath ?? '').split('/').map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join('/') : fileName;
}

/**
 * The receipt for a folder whose next request did not answer.
 *
 * A successful course-drop chunk has already changed the board. Saying only
 * that the folder "could not be added" hides that fact and invites either
 * abandonment or fear of a duplicate. The browser retains no extracted text
 * here—only the highest sequential item number the service confirmed.
 */
export function interruptedCourseDropLine(checkedThrough: number, total: number): string {
  const checked = Math.max(0, Math.min(Math.trunc(checkedThrough), Math.max(0, Math.trunc(total))));
  const count = Math.max(0, Math.trunc(total));
  if (checked === 0) {
    return `I could not confirm the first part. All ${count} files are still ready here; try again. Retry is safe and will not duplicate any files that did land.`;
  }
  return `${checked} of ${count} files were checked before the next part could be confirmed. Readable files from that part are already on your board. All ${count} files are still ready here; try again to finish. Retry will not duplicate them.`;
}

export interface SectionView {
  depth: string;
  estimatedMinutes: number;
  sourceIds: string[];
  completed: boolean;
  completionEvidence?: 'answer' | 'known';
  /** Optional here and not on the wire: a session composed before the card read
   *  headings has none, and the clause that would name it is simply not written. */
  heading?: string;
  /** Which topic this section teaches. Every control on the lineup addresses
   *  the service by it, so a row without one is a row with no working buttons
   *  and `lineupItems` drops it rather than drawing dead controls. */
  topicId?: string;
  /** The ranker's own sentence about why this is in tonight's lineup. Null on
   *  a session composed before the reason was carried, which the disclosure
   *  says out loud rather than papering over. */
  why?: string | null;
  /** One line naming what the section covers, written by the Composer in the
   *  call that wrote the section, or the topic's own summary for a session
   *  composed before that existed. Never derived from the body. */
  summary?: string | null;
  /** Which course this section's topic belongs to, where the board honestly
   *  knows. Derived by the service (`subjectForTopic`), null where nothing
   *  links the topic to a course — and null renders nothing, never a guess. */
  subject?: { courseId: string; title: string } | null;
  /** The dated work this lesson moves forward, derived by the service
   *  (`commitmentForTopic`). Shown as a chip on the row, not as a sentence over
   *  the list: The affordance-first interface contract. */
  serves?: { commitmentId: string; title: string } | null;
}
export interface SessionView {
  builtAt: string;
  fromPinCount: number;
  sections: SectionView[];
  /** SB-31's resume pointer, as the store keeps it: the first section still
   *  owed. Optional because most readers here do not need it and a fixture
   *  written without it is still a session; zero and absent both mean nothing
   *  in this session has been done. */
  currentSectionIndex?: number;
}
export interface TopicView {
  id: string;
  label: string;
  state: string;
  /**
   * Which of the board's five areas this topic is on, as `GET /board` says.
   *
   * Not derived here from `state`, and that is deliberate: two of the areas are
   * not in `state` at all. **Paused** is `retiredByUser`, which the Registrar
   * maps to `settled`; **Recharging** is the spaced-review rule, which needs
   * the signal history this payload does not carry. Absent means an older
   * service, and the grouping falls back to `state`.
   */
  area?: string;
  pinIds: string[];
  /** The Clusterer writes one and `GET /board` has always returned it. Nothing
   *  rendered it, which is most of why a board of seven subjects read as a
   *  list: a label and a count is an index entry, not a thing you recognise. */
  summary?: string;
}


export const MODEL_NOTICE =
  'Model-written lessons and marking can be wrong. Lesson sections show their sources in one tap, so check anything that matters.';

export const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const things = (n: number): string => `${n} thing${n === 1 ? '' : 's'}`;

/**
 * How long ago, in words — or nothing, when the timestamp cannot be read.
 *
 * The build time is evidence that work happened while the user was away, so it
 * is stated rather than hidden (SB-18). But `Date.parse` answers NaN for
 * anything it does not recognise, and every arithmetic path below it inherits
 * the NaN silently: the ready card read "built NaN min ago from 6 things you
 * pinned". A number on screen that means nothing is worse than a missing
 * clause, because the learner cannot tell it from a number that does.
 *
 * So this returns null and the callers drop what they cannot say. Null rather
 * than a placeholder string because the caller is the only thing that knows
 * what the surrounding sentence needs — here, the clause simply goes.
 */
export function when(iso: string, now: number): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const mins = Math.round((now - at) / 60000);
  // Browser and service clocks can differ by a few minutes. A small lead is
  // still recent work; a timestamp materially in the future is not a recency
  // claim the client can make honestly.
  if (mins < -5) return null;
  if (mins <= 0) return 'just now';
  if (mins < 90) return `${mins} min ago`;
  const t = new Date(at);
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  if (mins < 60 * 20) return `at ${hhmm}`;
  const days = Math.round(mins / 1440);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * A heading, cut to one clause of a narrow single-column panel.
 *
 * SB-18's ready card set this at 48 and SB-31 cut section headings to it for
 * the *"you stopped at IAM conditions"* clause. Both are gone — the card was
 * uncalled by the time anybody looked, and one lesson on screen at a time made
 * a resume point something the lineup already answers — but the number outlived
 * them, because the column it was measured against is the same column.
 */
const CLAUSE_HEADING = 48;

/**
 * SB-23: an honest empty state. Never manufacture a lesson to look busy.
 *
 * `sections` is checked for shape and not just for length because this is the
 * gate the whole home screen hangs on, and it is asked about a body that came
 * off the wire. A session-shaped answer with no sections in it used to throw
 * here, which took `renderHome` down mid-render and left the panel showing its
 * own title and nothing else — the one failure this screen must never have,
 * since a learner cannot tell a blank panel from a broken extension.
 */
export function hasSomethingReady(session: SessionView | null): boolean {
  return !!session && Array.isArray(session.sections) && session.sections.length > 0;
}

export function sourcesLabel(n: number): string {
  return `${n} source${n === 1 ? '' : 's'} · why am I seeing this?`;
}

/**
 * The session's closing receipt, derived only from actions that actually
 * landed. Composer-written closing copy is necessarily a prediction made
 * before the learner starts; it cannot truthfully say what moved afterwards.
 */
export function sessionClosingLine(
  sections: readonly {
    readonly completed?: boolean;
    readonly completionEvidence?: 'answer' | 'known';
    readonly contested?: boolean;
    readonly corrections?: readonly {
      readonly conceded?: boolean;
      readonly withdrawn?: number;
    }[];
  }[],
): string {
  const total = sections.length;
  const recorded = sections.filter((section) => section.completed === true).length;
  const open = total - recorded;
  const withdrawn = sections.filter((section) => section.completed === true
    && lessonEvidenceWasWithdrawn(section)).length;
  if (total === 0) return 'Nothing was added to this session.';
  if (withdrawn > 0) {
    if (total === 1) {
      return 'That learning mark no longer counts. You do not have to repeat the lesson; it remains here to revisit.';
    }
    if (recorded === total) {
      if (withdrawn === total) {
        return 'Those learning marks no longer count. You do not have to repeat the lessons; they remain here to revisit.';
      }
      return 'Virgil kept the learning evidence whose marks still stand. Withdrawn marks no longer count, and every finished lesson remains here to revisit.';
    }
    return 'Virgil kept the learning evidence whose marks still stand. Withdrawn marks no longer count, and unfinished lessons remain open.';
  }
  if (recorded === total) {
    if (total === 1) {
      if (sections[0]?.completionEvidence === 'answer') {
        return 'Virgil saved how your answer went. It can use that learning evidence when choosing what comes next.';
      }
      if (sections[0]?.completionEvidence === 'known') {
        return 'You marked that lesson as known. Virgil can use that when choosing what comes next.';
      }
      return 'Virgil saved the learning evidence from that lesson. It can use it when choosing what comes next.';
    }
    return 'Virgil saved new learning evidence from each lesson. It can use that when choosing what comes next.';
  }
  if (recorded === 0) {
    return `No learning evidence was recorded. ${open === 1 ? 'The lesson remains' : 'The lessons remain'} open because reading alone does not change what Virgil believes you know.`;
  }
  return `Virgil saved new learning evidence from the lessons you acted on. ${open === 1 ? 'The other lesson remains' : 'The others remain'} open because reading alone does not change what Virgil believes you know.`;
}

/**
 * Completion is a workflow fact; evidence is a separate trust fact.
 *
 * A correction does not make somebody repeat a lesson Virgil got wrong, so the
 * section stays completed. Its withdrawn answer/depth/resurface marks must not
 * then be described as standing learning evidence. `contested` is the older,
 * model-free answer-mark withdrawal; a conceded correction carries the exact
 * count it invalidated.
 */
function lessonEvidenceWasWithdrawn(section: {
  readonly contested?: boolean;
  readonly corrections?: readonly {
    readonly conceded?: boolean;
    readonly withdrawn?: number;
  }[];
}): boolean {
  return section.contested === true || (section.corrections ?? [])
    .some((entry) => entry.conceded === true && (entry.withdrawn ?? 0) > 0);
}

/** The compact status above a lesson, without turning completion into evidence. */
export function lessonCompletionLine(section: {
  readonly completed?: boolean;
  readonly contested?: boolean;
  readonly corrections?: readonly {
    readonly conceded?: boolean;
    readonly withdrawn?: number;
  }[];
}): string | null {
  if (section.completed !== true) return null;
  return lessonEvidenceWasWithdrawn(section)
    ? 'Lesson finished · learning evidence withdrawn'
    : 'Lesson finished';
}

// ------------------------------------------------------- SB-44: the provenance

/** One resolved source, as the service answers it. */
export interface SourceView {
  id: string;
  origin: string;
  title: string | null;
  url: string | null;
  /** Pinned-at for a user pin, retrieved-at for a reference. */
  at: string | null;
  /** SB-10: seconds into a video, when the pin was made on one. */
  moment?: number | null;
  /** SB-11: which page of a PDF, when the viewer said. */
  page?: number | null;
  /**
   * Did Virgil's own fetch of this page come back usable?
   *
   * The Forager's `confidence` at the surface: `true` for `full`, `false` for
   * `reduced`, absent for a reference or a pin nothing was tried on. Read by
   * the §5d hand-off, which uses it to warn that a page Virgil met a wall on is
   * a page Gemini Notebook's own fetcher may meet the same wall on. Nothing
   * else reads it, and it decides nothing on its own.
   */
  readByVirgil?: boolean | null;
  /** The selected passage behind a user pin, when capture supplied it. */
  excerpt?: string | null;
  /** Learner-confirmed after an attempted open; never a background probe. */
  availability?: SourceAvailabilityView | null;
}

export interface SourceAvailabilityView {
  status: 'available' | 'unavailable';
  checkedAt: string;
  checkedBy: 'learner';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14 Aug", or nothing. Fixed month names rather than `toLocaleDateString` for
 *  the same reason `flaggedWhen` fixes its day names: the panel's copy is
 *  English, and a locale-dependent string is untestable without pinning an
 *  environment. */
function onDay(iso: string | null): string | null {
  const at = iso === null ? NaN : Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()] ?? ''}`.trim();
}

/**
 * SB-44, in one line per source: whose page this was.
 *
 * The demand is that a user pin and something the agent went and found are
 * VISIBLY distinct, and that is the whole of this function. The agent-sourced
 * line is the one a sceptical learner most needs, because it is the reference
 * they never chose to trust — so it says what it is before it says anything
 * else, and it does not borrow the word "pinned".
 *
 * A source whose origin is neither returns null and is not described. Same rule
 * as a flagged row with no provenance: the one thing the provenance surface may
 * never do is account for something it cannot account for.
 */
export function sourceLine(source: SourceView): string | null {
  if (source.origin === 'agent-sourced') return 'Background reading I found, not from your pins';
  if (source.origin !== 'user-pin') return null;
  const day = onDay(source.at);
  // SB-10 and SB-11. The noun changes with the clause: "the page you pinned, at
  // 12:34" would be describing something the learner did not do. A moment or a
  // page number it cannot read drops the clause and the noun together, exactly
  // as an unreadable date drops its own — the pin is real either way and still
  // says so.
  const at = momentLabel(source.moment);
  const page = pageLabel(source.page);
  const what = at ? 'video' : page ? 'PDF' : 'page';
  const where = at ? `, at ${at}` : page ? `, ${page}` : '';
  return day ? `From the ${what} you pinned on ${day}${where}` : `From a ${what} you pinned${where}`;
}

/** Honest source-link state: an opening report, never content verification. */
export function sourceAvailabilityLine(value: SourceAvailabilityView | null | undefined): string {
  if (!value) return 'No link check saved.';
  const day = onDay(value.checkedAt);
  const when = day ? ` on ${day}` : '';
  return value.status === 'available'
    ? `You confirmed this link opened${when}. The saved quote has not been rechecked.`
    : `You could not open this link${when}. Your saved quote is still here.`;
}

/**
 * Seconds as a person would say them: `0:09`, `1:10`, `1:02:05`.
 *
 * Null for anything that is not a moment — zero is where an unplayed video
 * sits, and a fraction, a NaN or an absent field are not times. The panel's
 * standing rule: drop what it cannot say rather than print a shape with a hole.
 */
/** SB-11: "page 3", or nothing. Same rule as the moment above — a page number
 *  that is not a page number is a clause the line does not write. */
export function pageLabel(page: number | null | undefined): string | null {
  if (typeof page !== 'number' || !Number.isInteger(page) || page <= 0) return null;
  return `page ${page}`;
}

export function momentLabel(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds <= 0) return null;
  const pad = (n: number): string => String(n).padStart(2, '0');
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/**
 * The href a source may be opened at, or null.
 *
 * The url came off a page the learner visited or a page the agent fetched, and
 * it is about to become an `href` inside the panel — which is the extension's
 * own origin, with the session, the board and the learner model behind it. So
 * the scheme is checked against an allow-list rather than a deny-list: `http`
 * and `https` are links, and everything else — `javascript:`, `data:`, another
 * extension's pages, a scheme nobody has thought of — is text.
 */
export function safeHref(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { return null; }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    && parsed.username === '' && parsed.password === '' ? parsed.href : null;
}

/** SB-44: a reference that resolved to nothing is said out loud. Dropping it in
 *  silence would leave a count that quietly disagrees with the list under it,
 *  on the one surface whose whole job is being checkable. */
export function unresolvedSourcesLine(n: number): string | null {
  if (!(n > 0)) return null;
  return n === 1
    ? '1 reference could not be shown. I could not trace it back.'
    : `${n} references could not be shown. I could not trace them back.`;
}

/**
 * SB-283: the register, as the learner reads it.
 *
 * `from-nothing` is a machine key and it always looked like one on screen.
 * Walked through as a learner, "from nothing" is a sentence about the product's
 * own starting point rather than about the reader, and it lands on a row that
 * is asking them to begin something. It reads as *new to you*, which is what
 * the register actually means.
 *
 * The KEY is untouched. It is load-bearing in prompts, in the Composer's word
 * budgets and in the stored ledger, and renaming it would move a display word
 * into three places that have to keep agreeing with each other. This function
 * is the one seam between the two, which is why it is the only thing that
 * changed.
 */
export function registerLabel(depth: string): string {
  return depth === 'from-nothing' ? 'new to you' : depth.replace('-', ' ');
}

export interface BoardGroup { key: string; heading: string; topics: TopicView[] }

/** SB-33: topics are the display unit; pins are the evidence unit. Confusing
 *  the two is exactly how this becomes a backlog. Empty groups do not show. */
export function boardGroups(topics: readonly TopicView[]): BoardGroup[] {
  const headings: Record<string, string> = {
    working: 'Working on', waiting: 'Waiting', settled: 'Settled',
  };
  return ['working', 'waiting', 'settled']
    .map((key) => ({ key, heading: headings[key]!, topics: topics.filter((t) => t.state === key) }))
    .filter((g) => g.topics.length > 0);
}

// ------------------------------------------------------- the board as a board

/**
 * What a topic looks like when it is a thing on a board rather than a row.
 *
 * The board screen drew a label and a count and nothing else, so seven subjects
 * a learner had chosen read as seven index entries — and `summary`, the one
 * field that says what a topic is *about*, sat in the payload unrendered.
 *
 * There is no comfort here, and there is no percentage. SB-33 is that comfort
 * is never shown as a number; a bar is a number drawn sideways, and a board you
 * can score is a board you can fall behind on.
 */
export interface BoardCard {
  label: string;
  gist: string;
  count: string;
  /** The area's key, which is what the card is coloured by. */
  state: string;
}

/** Long enough to recognise a subject, short enough that a card stays a card. */
export const GIST_MAX = 160;

export function boardCard(topic: TopicView): BoardCard {
  return {
    label: topic.label,
    gist: gistOf(topic.summary),
    count: `${things(topic.pinIds.length)} you pinned`,
    state: areaOf(topic),
  };
}


export const BOARD_IN_LESSON = 'In today’s lesson';

/**
 * The two doors on a topic card, each saying what its own press does.
 *
 * The affordance-first interface contract: no instruction copy, and the affordances ARE the instruction.
 * These are not sentences on the screen; they are the accessible name and the
 * tooltip of the two controls, which is where a promise about a press belongs.
 * They are two strings rather than one because the title press is genuinely two
 * different doors: a topic the prepared lesson carries opens that lesson, and a
 * topic it does not carry opens the pins inside it. One label covering both
 * would be true half the time.
 */
export const boardTitleDoorLine = (label: string, inLesson: boolean): string => (inLesson
  // *Today* rather than *tonight*, for the same reason the chip above it
  // changed on 2026-08-29: a board opened at midday should not be told what the
  // evening holds. The two strings are about the same lesson and now agree.
  ? `Open today’s lesson on ${label}`
  : `Open ${label} and see what you pinned to it`);

export const BOARD_PINS_TOGGLE = 'Show what you pinned to this';

/** Cut at a word. A summary sheared mid-word reads as a rendering fault, and
 *  this one is model output, so it is the model that gets blamed for it. */
function gistOf(summary: string | undefined): string {
  const text = (summary ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= GIST_MAX) return text;
  const cut = text.slice(0, GIST_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/**
 * The board's areas, which exist whether or not anything is in them.
 *
 * `boardGroups` drops an empty group, which is right for a list — a heading
 * over nothing is debris. It is wrong for a board: the areas are the board's
 * furniture, and a learner who has settled nothing yet should be able to see
 * where settled things will go. That is the difference between a place and a
 * rendering of whatever happens to exist.
 *
 * And a topic whose state this build does not recognise is still the learner's,
 * so it lands in the first area rather than falling off the board. It used to
 * vanish from every group and from their own screen with it.
 */
export interface BoardColumn {
  key: string;
  heading: string;
  /** Said when the area is empty. Never a failure and never a count of zero. */
  empty: string;
  topics: TopicView[];
}

/**
 * The learner-owned areas, plus one honest work boundary.
 *
 * They were three — *Working on / Waiting / Settled* — which were the
 * Registrar's three `TopicState` values with nicer words on them, and that is
 * why two of these are new rather than renamed. **Paused** and **Recharging**
 * are facts `state` could not carry (see `TopicView.area`), and *Waiting*
 * became **Get Started** because "waiting" described the product's position and
 * this describes the learner's.
 *
 * `Pending` is deliberately not another learner-state synonym. It is the
 * exact set of topics for which the service has enough source to offer a
 * lesson, but has not written and checked that lesson yet. Keeping those cards
 * here is what lets Learn's 1 / 3 / 5 minute promise mean ready reading rather
 * than generation time hidden behind a spinner.
 *
 * `Get Started` also holds the pins nothing has filed yet — they are the same
 * answer to the same question, and two areas at the top of a board both meaning
 * *"you have not begun this"* is a distinction only the machine cares about.
 */
const COLUMNS: readonly { key: string; heading: string; empty: string }[] = [
  { key: 'pending', heading: 'Pending', empty: 'No lessons waiting to be run.' },
  { key: 'get-started', heading: 'Get Started', empty: 'Nothing waiting to be started.' },
  { key: 'learning', heading: 'Currently Learning', empty: 'Nothing on the go.' },
  { key: 'recharging', heading: 'Recharging', empty: 'Nothing is due back yet.' },
  { key: 'paused', heading: 'Paused', empty: 'Nothing put down.' },
  { key: 'learnt', heading: 'Learnt', empty: 'Nothing has landed yet.' },
];

/**
 * The old three-state grouping, kept as the fallback and nothing more.
 *
 * A panel is updated by reloading an extension and a service by restarting a
 * process, and those are two acts. Between them the payload has no `area`, and
 * a board that answered that by dropping every topic into "Get Started" would
 * report a learner's whole history as unstarted.
 */
const AREA_FROM_STATE: Readonly<Record<string, string>> = {
  working: 'learning',
  waiting: 'get-started',
  settled: 'learnt',
};

const areaOf = (t: TopicView): string => t.area ?? AREA_FROM_STATE[t.state] ?? 'get-started';

export function boardColumns(
  topics: readonly TopicView[], pendingTopicIds: ReadonlySet<string> = new Set(),
): BoardColumn[] {
  const known = new Set(COLUMNS.map((c) => c.key));
  return COLUMNS.map((c) => ({
    ...c,
    // A topic whose area this build does not recognise is still the learner's,
    // so it lands in Get Started rather than falling off the board. This is a
    // meaning boundary, not a dependency on whichever column happens to lead.
    topics: topics.filter((t) => {
      if (pendingTopicIds.has(t.id)) return c.key === 'pending';
      return areaOf(t) === c.key || (c.key === 'get-started' && !known.has(areaOf(t)));
    }),
  }));
}


export interface UnfiledPin { id: string; title: string; gist: string }

export interface UnfiledArea {
  heading: string;
  note: string;
  pins: UnfiledPin[];
  /** "and N more", or null when everything is shown. */
  more: string | null;
}

export function unfiledArea(pins: readonly UnfiledPin[], cap: number): UnfiledArea | null {
  // Different from the three topic areas deliberately: those are the board's
  // furniture and stay when empty, because a learner should see where settled
  // things will go. This is a transient, and a heading over a thing that is
  // not happening is debris.
  if (!pins.length) return null;
  const shown = pins.slice(0, cap);
  const rest = pins.length - shown.length;
  return {
    // Not a heading any more: these sit inside "Get Started", which is where
    // the topics nothing has begun sit too. The field stays because the panel
    // still asks for the note, and a caller drawing this area on its own — the
    // side panel — still has something to head it with.
    heading: 'Get Started',
    // States what these ARE, rather than repeating an instruction. The process
    // bar sits directly above this on the same screen and already says "press
    // Process"; saying it twice in two hundred pixels reads as a product that
    // does not trust you to have read the first one.
    note: 'Just pinned, and not filed into subjects yet.',
    pins: shown.map((p) => ({ ...p, title: p.title || 'Untitled page' })),
    more: rest > 0 ? andNMore(rest) : null,
  };
}

// ----------------------------------------------------------------- the rooms


export type DoorKind = 'room' | 'tool';

export interface Door {
  /** Matches the room key a screen frames itself with. */
  readonly key: DoorKey;
  readonly label: string;
  /**
   * **Rooms** are places the learner works and keeps things. **Tools** are a
   * thing you use and leave, and a setting. Seven identically-weighted words in
   * a row is a footer of links, which is what three of them already were once.
   */
  readonly kind: DoorKind;
}

/**
 * Every screen that can be framed, including the ones with no door.
 *
 * `burst`, `session` and `awards` are rooms you are *sent* to rather than
 * rooms you pick, so they are not in `DOORS` — but they are still rooms, they
 * still take the shell, and the nav still draws with none of its doors marked
 * while you are in one. That is honest: you are inside Virgil and not inside
 * any of the seven.
 */

export const DOOR_KEYS = ['today', 'plan', 'courses', 'check', 'model', 'privacy'] as const;
export type DoorKey = (typeof DOOR_KEYS)[number];


export const DOORLESS_KEYS = [
  'burst', 'material-check-in', 'account', 'signin', 'take', 'guide',
] as const;


export const FACES = [
  { key: 'learn', label: 'Up next' },
  { key: 'pins', label: 'Pins' },
  { key: 'board', label: 'Board' },
  { key: 'external', label: 'External' },
] as const;
export type FaceKey = (typeof FACES)[number]['key'];

/**
 * What the toggle is, said once for anybody who cannot see it is a toggle.
 *
 * A visible label would be the interface explaining itself, which The affordance-first interface contract
 * bans; a group of two buttons with no accessible name is a pair of unrelated
 * controls to a screen reader, which is a different failure and a real one.
 */
export const FACE_TOGGLE_LABEL = 'What to show';

export const ROOM_KEYS = [...DOOR_KEYS, ...DOORLESS_KEYS] as const;
export type RoomKey = (typeof ROOM_KEYS)[number];

export const DOORS: readonly Door[] = [
  // The arrival page is a door like every other room. It was reachable only
  // through the wordmark, which is a logo before it is a control, so the one
  // room the product opens on was the one room the nav did not name. The key
  // stays `today` — a label is not an identifier — and the door says what the
  // room is for rather than when it is for.
  { key: 'today', label: 'Learn', kind: 'room' },
  { key: 'plan', label: 'Plan', kind: 'room' },
  { key: 'courses', label: 'My studies', kind: 'room' },
  { key: 'check', label: 'Check', kind: 'tool' },
  { key: 'model', label: 'Insights', kind: 'tool' },
  { key: 'privacy', label: 'Settings', kind: 'tool' },
];

/**
 * How wide the room is.
 *
 * Three measures, and the difference between them is what the room is for
 * rather than which screen happened to be built last. A `board` is a wall and
 * takes the window. A `read` room is prose and a form, and 1,180px of it is a
 * line your eye loses its place on. A `wall` is a room you scan in columns —
 * the front door, and the Plan once it grew lanes and a calendar.
 *
 * This exists because "no shell" also meant no measure: every screen that was
 * not the front door or the board inherited the page's 1,180px default, so the
 * privacy controls and the plan's four-field form were laid out at board width
 * for no reason anybody had chosen.
 */
export type Measure = 'board' | 'wall' | 'read';

export function roomMeasure(room: RoomKey): Measure {
  // `board` was the first branch here until 2026-08-25, when the board stopped
  // being a room. The measure survives as a name because the page-wide default
  // still uses it; no room asks for it any more.
  // The Plan joined the front door here on 2026-08-24. It was `read`, which was
  // right while the room was a score, a four-field form and a list — and wrong
  // the moment it became lanes beside a three-week calendar. Twenty-one day
  // cells inside a 56rem reading column are cells nothing legible fits in.
  if (room === 'today' || room === 'plan') return 'wall';
  return 'read';
}

// ----------------------------------------------------------------- the theme


export const THEME_CHOICES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEME_CHOICES)[number];

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEME_CHOICES as readonly string[]).includes(value);
}

/** Cycles. Anything unrecognised — an older build's value, a hand-edited
 *  storage entry — is treated as `system`, so the next press goes to light. */
export function nextTheme(current: unknown): Theme {
  const at = isTheme(current) ? THEME_CHOICES.indexOf(current) : 0;
  return THEME_CHOICES[(at + 1) % THEME_CHOICES.length]!;
}

/** Named for what is on screen now. A control labelled with where it is going
 *  makes the learner hold two states in their head to read one word. */
export function themeLabel(theme: unknown): string {
  if (theme === 'light') return 'Whiteboard';
  if (theme === 'dark') return 'Blackboard';
  return 'Match my system';
}

// ------------------------------------------ pause and off limits (SB-40/41)

/**
 * The half of pause and exclusions that had no surface at all.
 *
 * The service has shipped the list, the defaults and the endpoint since they
 * were written, and there was no way for a learner to see any of it, let alone
 * turn collection off — so the story's promise was enforceable and unreachable
 * at the same time. These are the judgements behind that screen; the screen
 * itself is template strings, as usual.
 */
export interface PrefsView {
  /** Process automatically once this many things are waiting, or null/absent
   *  for never — which is the default. The event-driven processing contract. */
  autoAfter?: number | null;
  /** Service-owned capability; absent on an older/local service. */
  automaticProcessing?: { available: boolean; mode: 'in-process' | 'cloud-run-job' | 'unavailable' };
  /** Whether the night may look for material they have not collected. Absent
   *  reads as on, which is what every board written before it carries. */
  prospect?: boolean;
  pausedUntil: string | null;
  excludedDomains: readonly string[];
  /** When their sessions get built. Absent on a board that predates the
   *  control, which reads as "only when I ask". */
  schedule?: { kind: string; hour?: number; timeZone?: string } | null;
  /** Current browser zone, persisted separately because on-demand learners
   * still need local calendar days. */
  timeZone?: string;
}

export const MODEL_MODES = ['cloud', 'local', 'cli'] as const;
export type ModelModeView = (typeof MODEL_MODES)[number];

/**
 * What each connection is called, wherever it is named to a learner.
 *
 * One table. The Settings cards, the budget's receipt rows and the refusals on
 * the Check room all name the same three connections, and two rooms calling one
 * of them by two names is two products. The labels also never leak the internal
 * key: `cli` is "Agent CLI" on every surface and `cli` on none of them.
 */
export const MODEL_CONNECTION_LABEL: Readonly<Record<ModelModeView, string>> = {
  cloud: 'Cloud/API', local: 'Local', cli: 'Agent CLI',
};

/** The label for whatever the service named, or nothing when it named something
 *  this build does not know. A connection key printed raw would be the one
 *  place the product speaks its own schema out loud. */
export const modelConnectionLabel = (mode: string | null | undefined): string | null =>
  (mode && (MODEL_CONNECTION_LABEL as Record<string, string>)[mode]) || null;
export const MODEL_ROUTES = ['quick', 'deep', 'images'] as const;
export type ModelRouteView = (typeof MODEL_ROUTES)[number];
export type ModelReadinessView = 'ready' | 'needs-setup' | 'unreachable' | 'not-checked';

export interface ModelProviderSetupView {
  readonly editable: boolean;
  readonly managed: boolean;
  readonly credential: 'configured' | 'missing' | 'not-required';
  readonly check: 'available'; readonly connector?: 'supported'; readonly paired?: boolean;
}

/**
 * What a call on a connection would actually go to, and how much it can read.
 *
 * `maxInputTokens` is `null` for a local or CLI connection on purpose: that is
 * whatever the operator pulled or started, and the service will not invent a
 * window for it. The Check screen reads the `null` as "say nothing" rather than
 * as a small number, which is the difference between a quiet meter and one that
 * warns about every paste.
 */
export interface ModelInputWindowView {
  readonly modelId?: string | null;
  readonly maxInputTokens?: number | null;
}

export interface ModelProviderView {
  readonly enabled: boolean;
  readonly readiness: ModelReadinessView;
  readonly detail: string;
  readonly endpoint?: string;
  readonly setup?: ModelProviderSetupView;
  /** Keyed by workload route. Only `deep` today, which is the route Check uses. */
  readonly models?: { readonly deep?: ModelInputWindowView };
}

export type ModelProviderMapView = Readonly<Record<ModelModeView, ModelProviderView>>;
export type ModelRouteMapView = Readonly<Record<ModelRouteView, ModelModeView>>;

/** Enabling a connection does not assign work to it. Keep deliberate standby
 * valid, but say when a successful save has no workload effect. */
export function unusedModelProvidersLine(
  providers: Readonly<Record<ModelModeView, { readonly enabled: boolean }>>,
  routes: ModelRouteMapView,
): string | null {
  const assigned = new Set(MODEL_ROUTES.map((route) => routes[route]));
  const unused = MODEL_MODES.filter((mode) => providers[mode].enabled && !assigned.has(mode));
  if (!unused.length) return null;
  const labels = unused.map((mode) => MODEL_CONNECTION_LABEL[mode]);
  const named = labels.length === 1
    ? labels[0]!
    : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
  return unused.length === 1
    ? `${named} is on, but no work is assigned to it.`
    : `${named} are on, but no work is assigned to them.`;
}

/**
 * The model-routing receipt is service-owned. The optional legacy fields keep
 * one extension build honest while an older local service is being upgraded:
 * one active provider becomes the owner of all three routes, rather than a
 * blank screen or a made-up mixed configuration.
 */
export interface ModelConfigView {
  /** Version of this service-owned receipt. Kept optional so an older service
   * can be diagnosed rather than crashing the screen that diagnoses it. */
  readonly schemaVersion?: number;
  readonly providers?: Partial<Record<ModelModeView, Partial<ModelProviderView>>>;
  readonly routes?: Partial<Record<ModelRouteView, ModelModeView>>;
  readonly activeMode?: ModelModeView;
  readonly choices?: readonly {
    readonly mode: ModelModeView;
    readonly readiness?: ModelReadinessView;
    readonly detail?: string;
    readonly endpoint?: string;
  }[];
  /**
   * What a paste is allowed to be, in characters, on every connection. Service
   * owned so that the panel is not a second copy of "12,000" that drifts.
   * Optional because an older local service does not send it, and
   * `checkLimitsFrom` falls back to the shipped numbers rather than to nothing.
   */
  readonly limits?: Partial<CheckLimitsView>;
}

/** The deliberately small compatibility receipt returned by `/health`. */
export interface CompatibilityReceiptView {
  readonly protocol?: string;
  readonly serviceSchema?: number;
  readonly minClientSchema?: number;
  readonly maxClientSchema?: number;
  readonly modelConfigSchema?: number;
}

export interface HealthView {
  readonly ok?: boolean;
  readonly compatibility?: CompatibilityReceiptView;
}

export type CompatibilityStatus =
  | 'compatible'
  | 'unreachable'
  | 'update-service'
  | 'update-extension'
  | 'service-mismatch';

export interface CompatibilityReading {
  readonly status: CompatibilityStatus;
  readonly label: string;
  readonly detail: string;
  readonly blocking: boolean;
}

/** Translate two service receipts into one learner-facing compatibility state. */
export function compatibilityReading(
  health: HealthView | null | undefined,
  models: ModelConfigView | null | undefined,
  clientSchema = 1,
): CompatibilityReading {
  if (!health?.ok) return {
    status: 'unreachable', label: 'Cannot check', blocking: false,
    detail: 'I could not check compatibility just now.',
  };
  const receipt = health.compatibility;
  if (!receipt || receipt.protocol !== 'virgil-browser-service'
    || !Number.isInteger(receipt.serviceSchema)
    || !Number.isInteger(receipt.minClientSchema)
    || !Number.isInteger(receipt.maxClientSchema)
    || !Number.isInteger(receipt.modelConfigSchema)) return {
    status: 'update-service', label: 'Update Virgil', blocking: false,
    detail: 'This Virgil installation is older than the extension. Update and restart Virgil.',
  };
  if (clientSchema < receipt.minClientSchema!) return {
    status: 'update-extension', label: 'Update the extension', blocking: true,
    detail: 'This extension is older than the Virgil installation. Update the extension.',
  };
  if (clientSchema > receipt.maxClientSchema!) return {
    status: 'update-service', label: 'Update Virgil', blocking: true,
    detail: 'This Virgil installation is older than the extension. Update and restart Virgil.',
  };
  if (!models || !Number.isInteger(models.schemaVersion)
    || models.schemaVersion !== receipt.modelConfigSchema) return {
    status: 'service-mismatch', label: 'Virgil files do not match', blocking: true,
    detail: 'Parts of this Virgil installation are from different versions. Update all Virgil files together, then restart it.',
  };
  if (receipt.modelConfigSchema! > 1) return {
    status: 'update-extension', label: 'Update the extension', blocking: true,
    detail: 'This extension is older than the Virgil installation. Update the extension.',
  };
  if (receipt.modelConfigSchema! < 1) return {
    status: 'update-service', label: 'Update Virgil', blocking: true,
    detail: 'This Virgil installation is older than the extension. Update and restart Virgil.',
  };
  return {
    status: 'compatible', label: 'Compatible', blocking: false,
    detail: 'The extension and this Virgil installation are built to work together.',
  };
}

export interface NormalisedModelConfig {
  readonly providers: ModelProviderMapView;
  readonly routes: ModelRouteMapView;
}

const modelMode = (value: unknown): value is ModelModeView =>
  typeof value === 'string' && (MODEL_MODES as readonly string[]).includes(value);

const readiness = (value: unknown): ModelReadinessView =>
  value === 'ready' || value === 'needs-setup' || value === 'unreachable' || value === 'not-checked'
    ? value : 'needs-setup';

/** A defensive, provider-offline default: Cloud is the recommended map. */
export function modelConfigFrom(raw: ModelConfigView | null | undefined): NormalisedModelConfig {
  const legacyMode = modelMode(raw?.activeMode) ? raw.activeMode : 'cloud';
  const legacyChoices = new Map((raw?.choices ?? []).map((choice) => [choice.mode, choice]));
  const providers = Object.fromEntries(MODEL_MODES.map((mode) => {
    const modern = raw?.providers?.[mode];
    const legacy = legacyChoices.get(mode);
    const supplied = modern !== undefined;
    return [mode, {
      enabled: supplied ? modern.enabled === true : mode === legacyMode,
      readiness: readiness(modern?.readiness ?? legacy?.readiness),
      detail: typeof modern?.detail === 'string' ? modern.detail
        : typeof legacy?.detail === 'string' ? legacy.detail
          : 'The service did not return a readiness receipt.',
      ...(typeof (modern?.endpoint ?? legacy?.endpoint) === 'string'
        ? { endpoint: modern?.endpoint ?? legacy?.endpoint } : {}),
      ...(modern?.setup && typeof modern.setup === 'object'
        ? { setup: modern.setup } : {}),
    }];
  })) as Record<ModelModeView, ModelProviderView>;
  const routes = Object.fromEntries(MODEL_ROUTES.map((route) => {
    const owner = raw?.routes?.[route];
    return [route, modelMode(owner) ? owner : legacyMode];
  })) as Record<ModelRouteView, ModelModeView>;
  return { providers, routes };
}

/**
 * A schedule, read defensively, in the panel's own copy of the rule.
 *
 * Spelled out here rather than imported from `@sb/core`: the panel is an
 * extension bundle and does not depend on the runner's package.
 * `schedule.test.ts` in core owns the rule; this reads the same shapes and
 * falls the same way, and `panel-view.test.ts` holds the two together.
 */
export function scheduleFrom(
  raw: { kind?: string; hour?: number; timeZone?: string } | null | undefined,
): { kind: 'on-demand' } | { kind: 'daily'; hour: number; timeZone: string } {
  if (raw?.kind === 'daily'
    && typeof raw.hour === 'number' && Number.isInteger(raw.hour)
    && raw.hour >= 0 && raw.hour <= 23
    && typeof raw.timeZone === 'string' && raw.timeZone) {
    return { kind: 'daily', hour: raw.hour, timeZone: raw.timeZone };
  }
  return { kind: 'on-demand' };
}

/** The zone the browser is in, asked where the learner actually is. Empty
 *  where the runtime will not say, which the screen reads as "cannot offer a
 *  daily time" rather than guessing one. */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

/**
 * A pause with no deadline on it, carried as a timestamp nobody will outlive.
 *
 * The obvious shape was a new field — `pausedIndefinitely: true` — and it is the
 * wrong one, for the reason every other decision in this file turns on: which
 * way it fails. `pausedUntil` is the only thing the service's validator, the
 * worker's cached copy and this screen all already understand. A new flag is a
 * field an older cached copy does not carry, `cacheFrom` drops what it does not
 * recognise, and an absent flag would read as NOT PAUSED — the detector
 * carrying on while the panel says it stopped, which is the single failure this
 * whole surface exists to prevent. A far-future timestamp fails the other way in
 * every one of those places without a line of new plumbing anywhere.
 */
export const PAUSE_INDEFINITELY = '9999-12-31T23:59:59.999Z';

/**
 * Three timed pauses and one that is simply off.
 *
 * The timed ones used to be all of it, on the argument that an indefinite pause
 * is one people forget they set. The collection-pause contract (2026-08-20) overturned that: with
 * paid compute a forgotten pause costs nothing, while a withheld off-switch
 * spends the learner's money against their intent, and "we did not give you the
 * control in case you forgot you used it" is not a defensible trade. The
 * mitigation for forgetting is the paused banner on the main screen —
 * visibility, not withheld control.
 *
 * `minutes: null` is the untimed one. It is a distinct value rather than a huge
 * number so that nothing downstream can round it into a countdown.
 */
export const PAUSE_CHOICES: readonly { label: string; minutes: number | null }[] = [
  { label: 'For an hour', minutes: 60 },
  { label: 'For four hours', minutes: 4 * 60 },
  { label: 'Until tomorrow', minutes: 24 * 60 },
  { label: 'Until I turn it back on', minutes: null },
];

export function pauseUntil(minutes: number | null, now: number): string {
  if (minutes === null) return PAUSE_INDEFINITELY;
  return new Date(now + minutes * 60_000).toISOString();
}

/** Whether the panel should offer "Resume now" — the same reading of the field
 *  the worker uses, so the screen cannot claim a pause the detector has ended. */
export function isPausedNow(prefs: PrefsView | null, now: number): boolean {
  const until = prefs?.pausedUntil ? Date.parse(prefs.pausedUntil) : NaN;
  return Number.isFinite(until) && until > now;
}

/** State first, in one sentence, because "is it off?" is the only question this
 *  screen exists to answer. */
export function pauseStateLine(prefs: PrefsView | null, now: number): string {
  if (!isPausedNow(prefs, now)) return 'Watching for what you keep coming back to.';
  // The untimed pause is stated, never counted. Rendering it through the branch
  // below would say "Paused for another 69,548,000 hours", which is a number
  // that reads as a bug rather than as an answer to "is it off?".
  if (prefs!.pausedUntil === PAUSE_INDEFINITELY) return 'Paused until you turn it back on.';
  const mins = Math.ceil((Date.parse(prefs!.pausedUntil!) - now) / 60_000);
  if (mins >= 120) return `Paused for another ${Math.round(mins / 60)} hours.`;
  return `Paused for another ${mins} min.`;
}

/**
 * The second line of the paused banner: what stopped, and what did not.
 *
 * The collection-pause contract put a persistent paused state on the main screen; the manual-capture pause exemption keeps
 * manual pinning working while it is on. Both halves belong in front of the
 * learner at the same time — a banner saying only "paused" invites them to
 * discover the exemption by accident, and the off-limits screen has said the
 * same thing in the same voice since it shipped.
 */
export function pausedBannerNote(): string {
  return "I've stopped watching what you read and processing what you pinned. Pinning something yourself still works.";
}

/** Scope before and after a pause, so Process cannot be a surprise casualty. */
export const PAUSE_SCOPE_LINE =
  'Pausing also stops Process. Pinning something yourself still works.';

/** General settings when its ordinary Process action cannot truthfully run. */
export const PROCESSING_PAUSED_LINE =
  "Processing is paused with page activity. Start again before you process what you've pinned.";

/**
 * What a pause and the off-limits list actually do, said plainly.
 *
 * The second line is the one that would otherwise be a nasty surprise. Neither
 * control stops a pin the learner makes by hand — that is the deliberate-capture precedence, manual
 * capture is the trusted spine — and a privacy screen that let someone believe
 * otherwise would be worse than no screen.
 */
export function offLimitsLines(): string[] {
  return [
    'Virgil never observes activity on these domains or suggests anything from them.',
    'Pinning something yourself still works everywhere, paused or not. That one is your call, not mine.',
    'One domain per line. A domain covers its subdomains.',
  ];
}

/**
 * What the learner typed, as domains.
 *
 * Forgiving on the way in — a pasted url, a trailing slash, a `www.`, stray case
 * — because the alternative is a list that silently does not match the site they
 * meant. `www.bank.com` is stored as `bank.com` deliberately: the narrower form
 * would fail to cover the very site they were looking at when they typed it.
 */
export function parseDomainList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const d = domainOf(raw);
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

function domainOf(raw: string): string {
  const host = raw.trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')  // they pasted a url
    .split(/[/?#]/)[0]!
    .replace(/:\d+$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : '';
}

/** Said when something they typed did not survive, because a list that quietly
 *  drops a line is a list they think is protecting them and is not. */
export function domainListNote(text: string): string | null {
  // Counted per line that yielded nothing, not by comparing lengths — two lines
  // that normalise to the same domain is a duplicate, not a rejection, and
  // reporting it as one would send them hunting for a mistake they did not make.
  const dropped = text.split(/[\n,]/).filter((l) => l.trim() && !domainOf(l)).length;
  if (dropped <= 0) return null;
  return dropped === 1
    ? "1 line didn't look like a domain and was not saved."
    : `${dropped} lines didn't look like domains and were not saved.`;
}

// ------------------------------------------------- what it thinks of you (SB-42)

export interface StatementView {
  id: string;
  text: string;
  userEdited: boolean;
  /**
   * The learner has said this sentence, as Virgil wrote it, is right.
   *
   * Absent from an older service and from every read nobody has answered, and
   * absent reads as no. It is not `userEdited`: the words are still Virgil's,
   * which is why the badge below has three states rather than two.
   */
  confirmed?: boolean;
  evidence?: readonly StatementEvidenceView[];
  evidenceReceipt?: 'complete' | 'unitemised' | 'incomplete';
}

export interface StatementEvidenceView {
  type: string;
  topic: string;
  active: boolean;
}

/**
 * The learner model screen is a trust surface, and its whole job is to be dull.
 *
 * The API behind it has been fully tested since it was written — GET, PUT and
 * DELETE, plus the nightly honouring an edit — and there was no screen for it at
 * all, so the one beat that turns a creepy profile into a collaborative one had
 * nowhere to happen. Nothing here calls a model, sorts by a score or explains
 * itself. Sentences, in the learner's own words where they have changed them.
 */
export function modelEmptyLine(): string {
  return 'Tell me what helps, what gets in the way, or what you want handled differently next time.';
}

/** The ownership rule stated before either Virgil or the learner writes. */
export const MODEL_INTRO_LINE =
  'These are the things I can carry into future lessons. Your words come first, and you can challenge any read.';

/** A collaborative learner model can begin with the learner, not only the model. */
export const MODEL_ADD_ACTION = 'Tell Virgil something';
export const MODEL_ADD_LABEL = 'What should Virgil remember for future lessons?';
export const MODEL_ADD_PLACEHOLDER = 'For example: Begin with a concrete example before explaining the general rule.';
export const MODEL_ADD_MATERIAL_ACTION = 'Add something to learn';
export const LEARNER_STATEMENT_MAX_CHARS = 1_000;
export const MODEL_INSIGHT_LIMIT_LINE =
  'Up to 1,000 characters. I use the whole note when I shape future lessons.';

const insightOverflow = (text: string): boolean =>
  Array.from(text.trim()).length > LEARNER_STATEMENT_MAX_CHARS;

export function statementAddRefusal(text: string): string | null {
  if (!text.trim()) return 'Say what Virgil should know first.';
  return insightOverflow(text)
    ? 'Keep this insight to 1,000 characters. It is still here and nothing was sent.'
    : null;
}

/** Refused before the request, so the learner is told by the panel and not by a
 *  400 they never see. Same rule as the endpoint: an empty line is not an edit. */
export function statementEditRefusal(text: string): string | null {
  if (!text.trim()) return 'Say what it should be instead, or delete it.';
  return insightOverflow(text)
    ? 'Keep this insight to 1,000 characters. It is still here and nothing was sent.'
    : null;
}

/** Prefill is context, not learner authorship. It becomes a correction only
 * after the learner changes the admitted sentence. Trim here because the write
 * boundary trims too: adding outside whitespace cannot launder the same model
 * read into `your words`. */
export const statementEditChanged = (draft: string, admitted: string): boolean =>
  draft.trim() !== admitted.trim();

/** Local explanation beside a deliberately unavailable Save. */
export const statementEditNoChangeLine = (userEdited: boolean): string => userEdited
  ? 'Change your words before saving.'
  : "Change Virgil's read before saving it as your words.";

/** The hand-off after an Insights correction, with the next causal action. */
export const MODEL_CORRECTION_SAVED_LINE =
  'Saved as your words. It will govern the next lesson Virgil writes.';

/**
 * The three states this product's insights speak in.
 *
 * Both origins were named because absence is not provenance, and there were two
 * of them: the learner's words and Virgil's read. The third is a read the
 * learner has agreed with, and it had nowhere to be said: the badge kept
 * calling it a guess after somebody had told the product it was right, which is
 * the one thing on this screen a person cannot argue with by pressing anything.
 */
export function statementBadge(s: StatementView): string {
  if (s.userEdited) return 'your words';
  return s.confirmed ? STATEMENT_CONFIRMED_BADGE : 'my read';
}

/**
 * THE THIRD ANSWER TO A READ, AND WHAT IT LEAVES BEHIND.
 *
 * "Correct it" rewrites the sentence and takes the authorship; "Reject it"
 * removes it. Neither is what somebody wants when the read is simply right, so
 * the only way to agree with Virgil was to retype what it had already said.
 * The badge is not "you agreed" or "verified": what changed is the sentence's
 * standing, not the learner's obedience or the product's certainty. The receipt
 * claims exactly that much, because that is all confirming does.
 */
export const STATEMENT_CONFIRMED_BADGE = 'confirmed';
export const STATEMENT_CONFIRM_ACTION = "That's right";
export const STATEMENT_CONFIRMED_LINE =
  'Taken. It stands as agreed rather than as my read, and anything I suggest from it says so.';
export const STATEMENT_CONFIRM_FAILED = "That didn't go through. Nothing changed.";

/** A learner-authored correction is edited; only Virgil's read is corrected. */
export const statementEditAction = (userEdited: boolean): string =>
  userEdited ? 'Edit my words' : 'Correct it';

/** Accessible name for the in-place field whose surrounding sentence is visual. */
export const statementEditLabel = (userEdited: boolean): string =>
  userEdited ? 'Edit your words' : 'Correct this insight';

/**
 * Learner words are deleted; a machine read is rejected. The latter leaves an
 * invisible evidence receipt, so the same ledger cannot simply paraphrase the
 * claim tomorrow while materially new evidence remains allowed to change it.
 */
export const statementDeleteAction = (userEdited: boolean): string =>
  userEdited ? 'Delete' : 'Reject it';

/** The second, irreversible step must not sound identical to its launcher. */
export const statementConfirmAction = (userEdited: boolean): string =>
  userEdited ? 'Delete insight' : 'Reject this read';

/** A repeated row action keeps its short visible text but names the row aloud. */
export const statementActionLabel = (action: string, statement: string): string => {
  const named = shortLabel(statement);
  return named ? `${action}: ${named}` : action;
};

const EVIDENCE_KIND_WORDS: Readonly<Record<string, string>> = {
  'answer-correct': 'answers I marked correct',
  'answer-wrong': 'answers I marked wrong',
  'recall-check': 'recall checks you completed',
  'assessed-strong': 'strong results you recorded from real marking',
  'assessed-gap': 'gaps you recorded from real marking',
  'qc-finding': 'a check on your own writing',
  'depth-simpler': 'times you asked me to go simpler',
  'depth-deeper': 'times you asked me to go deeper',
  'pin-struggle': 'things you pinned because they were hard',
  'pin-interest': 'things you pinned because they interested you',
  'self-skip': 'things you said you already knew',
  'section-completed': 'lessons you completed',
  'section-abandoned': 'lessons you left',
  'reread-confirmed': 'pages you went back to',
  'interview-seed': 'what you told me when you started',
  'user-model-edit': 'a correction you made to my read',
  'resurface-refresher': 'times you asked for a refresher',
  'resurface-deeper': 'times you asked to go deeper',
  'quick-take-got-it': 'quick checks you answered confidently',
  'quick-take-still-shaky': 'quick checks you said were still shaky',
  'guide-stuck': 'a guide step you said you were stuck on',
};

/** A machine read exposes learner-safe evidence kinds, never ledger ids or
 * transport events. Repeated signals collapse to kinds rather than becoming a
 * score the learner can fall behind on. */
export function statementEvidenceLines(s: StatementView): string[] {
  if (s.userEdited) return [];
  if (!s.evidence) return ['Evidence details are unavailable from this Virgil service.'];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const item of s.evidence) {
    const topic = item.topic.replace(/\s+/g, ' ').trim() || 'A topic no longer on your board';
    const kind = EVIDENCE_KIND_WORDS[item.type] ?? 'learning activity connected to this topic';
    const line = `${topic}: ${kind}${item.active ? '' : ' (no longer counts)'}`;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }
  if (!lines.length) lines.push('No itemised evidence was saved with this read.');
  if (s.evidenceReceipt === 'incomplete') {
    lines.push('Some evidence in this receipt is no longer available.');
  }
  return lines;
}

export function deleteStatementConfirmLines(userEdited = false): string[] {
  return userEdited
    ? ['This line goes now.', 'It is your words, so Virgil will not recreate it.']
    : [
      'This read goes now.',
      'It will not come back from the same evidence.',
      'Materially new evidence can support a new read later.',
    ];
}

// ------------------------------------------------------- answer-mark withdrawal

/**
 * The learner is offered this exactly when they have been marked wrong.
 *
 * Not on a correct answer, because there is nothing to take back; not on a
 * section they skipped or shifted the depth of, because the learner's own
 * actions are not something the agent can be wrong about. One event class,
 * offered where it happened.
 */
export function offersContest(signal: string | null | undefined): boolean {
  return signal === 'answer-wrong';
}

/**
 * What is about to happen, before it happens.
 *
 * The third line is the one that matters and is the one a learner would not
 * assume: the mark stops counting towards the model of them. Without it this
 * reads as a complaint button, and a complaint button that quietly does nothing
 * is worse than no button. It is also literally true — `invalidateSignals`
 * flips the row, and `computeComfort` does not count invalidated rows.
 */
export function contestConfirmLines(heading: string): string[] {
  return [
    `I marked your answer on “${heading}” wrong.`,
    `Tell me I got that wrong and I take the mark back. It stops counting towards what I think you find hard.`,
    `Your answer stays as you wrote it. I do not re-mark it, and I do not argue.`,
  ];
}

/** Said once it is done. The number is the evidence that something happened. */
export function contestedLine(withdrawn: number): string {
  return withdrawn === 0
    ? 'Taken back. There was nothing counting against you here.'
    : `Taken back. ${withdrawn} mark${withdrawn === 1 ? '' : 's'} against you on this no longer count${withdrawn === 1 ? 's' : ''}.`;
}

export type LessonCorrectionFailure =
  | 'source' | 'unreachable' | 'budget' | 'credential' | 'refused'
  | 'update-service' | 'update-extension';

/** A failed recheck never consumes or clears the learner's challenge. */
export function lessonCorrectionFailedLine(cause: LessonCorrectionFailure): string {
  if (cause === 'source') return 'I could not reread the cited source. Nothing changed, and your challenge is still here.';
  if (cause === 'budget') return 'Your model limit stopped the source recheck. Nothing changed, and your challenge is still here.';
  if (cause === 'credential') return 'This connection needs attention before I can recheck the source. Nothing changed, and your challenge is still here.';
  if (cause === 'unreachable') return 'I cannot recheck this right now. Nothing changed, and your challenge is still here.';
  if (cause === 'update-service') return 'This Virgil installation is older than the extension. Update and restart Virgil. Nothing changed, and your challenge is still here.';
  if (cause === 'update-extension') return 'This extension is older than the Virgil installation. Update the extension. Nothing changed, and your challenge is still here.';
  return 'I could not complete the source recheck. Nothing changed, and your challenge is still here.';
}

/** The durable consequence shown beside the logged exchange. */
export function lessonCorrectionReceiptLine(conceded: boolean, withdrawn: number): string {
  if (!conceded) return 'I checked the cited source and did not change the lesson.';
  return withdrawn > 0
    ? `I got this wrong. ${withdrawn} learning mark${withdrawn === 1 ? '' : 's'} from this lesson no longer count${withdrawn === 1 ? 's' : ''}. You do not have to repeat it; the corrected lesson stays here.`
    : 'I got this wrong. There was no learning mark from this lesson to take back. The corrected lesson stays here.';
}

// ------------------------------------------------------------ repair controls

export function mergeConfirmLines(topic: TopicView, into: TopicView): string[] {
  return [
    `${things(topic.pinIds.length)} you pinned ${topic.pinIds.length === 1 ? 'moves' : 'move'} to “${into.label}”.`,
    // The one thing a learner would actually worry about, said first and
    // plainly. It is also true: signals are never rewritten, they are read
    // through the alias map, so the two histories are counted as one.
    `The history of “${topic.label}” will be kept under “${into.label}”. Nothing you have done is lost.`,
    `“${topic.label}” disappears from your board. “${into.label}” keeps its name.`,
  ];
}

/**
 * Refused here as well as in the store, so the learner finds out before the
 * confirm step rather than after it. Taking everything is a rename.
 */
export const TOPIC_LABEL_MAX_CHARS = 60;
export const TOPIC_LABEL_LIMIT_LINE =
  'Up to 60 characters. The whole name will appear on the new topic.';

export function splitRefusal(chosenCount: number, pinCount: number, label: string): string | null {
  if (!chosenCount) return 'Pick at least one thing to move.';
  if (chosenCount >= pinCount) return 'A split has to leave something behind. That would move everything.';
  if (!label) return 'The new topic needs a name. You name it, not me.';
  if (Array.from(label).length > TOPIC_LABEL_MAX_CHARS) {
    return 'Keep the new topic name to 60 characters. It is still here and nothing was sent.';
  }
  return null;
}

/** A topic with one thing in it has nothing to split. */
export function splittable(pinCount: number): boolean {
  return pinCount >= 2;
}

export function splitConfirmLines(
  topic: TopicView, chosenCount: number, pinCount: number, label: string,
): string[] {
  const left = pinCount - chosenCount;
  return [
    `${things(chosenCount)} ${chosenCount === 1 ? 'moves' : 'move'} to a new topic called “${label}”.`,
    `“${topic.label}” keeps all of its history, and ${things(left)} ${left === 1 ? 'stays' : 'stay'} there.`,
    // Said out loud because it is the surprising half. Comfort cannot be
    // divided between the two — no answer you ever gave says which half of the
    // topic it was about — so the new one honestly starts with nothing.
    `The new topic starts fresh: nothing is known about it yet.`,
  ];
}

// ------------------------------------------------------ SB-38: check my work

/** One finding, as the service answers it. */
export interface FindingView {
  quote: string;
  problem: string;
  relatedTopicId: string | null;
  /** Resolved by the service, so the panel does not have to hold the board. */
  relatedTopicLabel: string | null;
  pinSuggestion: string | null;
}

/**
 * The learner-work review boundary, on the screen rather than in a comment.
 *
 * The agent holds the rule in its schema, its prompt and a tripwire. The screen
 * holds it by saying so before it is asked, and by there being no control
 * anywhere on it that offers to do the writing. A learner who expects a rewrite
 * and gets a diagnosis has been let down by the copy, not by the agent.
 */
export function reviewFramingLine(): string {
  return 'I say what looks weak and why. I don’t rewrite it. That part stays yours.';
}

/**
 * Refused before the request, so the learner is told by the panel rather than
 * by a 400 they never see. Same shape as `statementEditRefusal`.
 *
 * `hasAttachment` is the whole of the 2026-08-24 change on this line. A PDF
 * dropped on the draft box no longer lands as text in the textarea; it rides
 * the request as its pages. An empty box with four pages clipped to it is a
 * complete submission, and refusing it here would be the panel turning down
 * what it had just accepted.
 */
export function checkRefusal(draft: string, hasAttachment = false): string | null {
  if (hasAttachment) return null;
  return draft.trim() ? null : 'Paste in what you are about to send.';
}

const COUNT_WORDS = ['no', 'One', 'Two', 'Three', 'Four', 'Five'];

/**
 * What happened, in one sentence.
 *
 * The two that matter are the last two, and they arrive on the wire as the same
 * empty list. "Nothing jumped out" said about a review that never ran tells the
 * learner their draft is sound when nothing read it — so an outcome this build
 * does not recognise is answered as the failure, never as the success. That is
 * the only fail-closed direction available on a screen whose whole job is to
 * find fault.
 */
export function reviewSummary(outcome: string, count: number): string {
  if (outcome === 'reviewed') {
    const n = COUNT_WORDS[count] ?? String(count);
    return `${n} thing${count === 1 ? '' : 's'} I would look at again.`;
  }
  if (outcome === 'nothing-found') {
    return 'Nothing jumped out at me. That is not the same as right. It is only that I could not fault it.';
  }
  if (outcome === 'too-short') return 'That is not enough writing for me to have an opinion about.';
  return 'I couldn’t run the check just now. Nothing about your draft has changed.';
}

/**
 * The line that makes this more than a proofreader: it reviewed the draft
 * against what this learner is known to be shaky on, and here is which one.
 *
 * Null where there is no label to say. A finding whose topic id resolved to
 * nothing is still a finding — the observation may be sound — and the
 * attribution is what goes, on the same rule SB-44 applies to a source it
 * cannot trace.
 */
export function findingTopicLine(finding: FindingView): string | null {
  const label = (finding.relatedTopicLabel ?? '').trim();
  return label ? `This is one you have been finding hard: ${label}` : null;
}

// ------------------------------------------------ the main page (UX_SPEC §5)

/**
 * The four zones, top to bottom, and the words each one is allowed to use.
 *
 * The service computes what is true — the card's state, the flagged rows, the
 * momentum facts — and this file decides how it reads. The split is the same
 * one the rest of this module keeps: the service must never be in the business
 * of copy, and the panel must never be in the business of deciding whether a
 * night was withheld or merely empty.
 */

export interface SessionCardView {
  state: string;
  sessionId: string | null;
  title: string;
  minutes: number;
  registers: string[];
  why: string | null;
  withheld: { topicId: string; heading: string; reason: string }[];
  reason: string | null;
}

/**
 * The heading, per state.
 *
 * An unrecognised state falls back to the honest empty rather than to the
 * ready card. A panel from an older build reading a state it does not know
 * must not offer to start a session that may not be there — the fail-closed
 * direction, and the only one that cannot lie to a learner.
 */
export function cardHeading(card: SessionCardView | null): string {
  switch (card?.state) {
    case 'ready': return card.title || 'Ready';
    /**
     * Not "Being built", which is what this said and which contradicted the
     * code that produces it. `main-page.ts`, on the same card: *"this is NOT a
     * claim that a run is in flight — nothing in the store records that, and a
     * card that said 'working on it now' would be inventing a fact about a
     * process it cannot see."* The reason line underneath said "the next run
     * picks them up" while the heading above it said the run was happening.
     *
     * This names the state without claiming activity, and the screen now
     * carries the control that makes the claim true if the learner wants it.
     */
    // The event-driven processing contract: there is no run coming on its own, so telling somebody to
    // wait for one is telling them to wait for nothing. It names the thing
    // they can do instead.
    case 'building': return 'Ready to process';
    // Named as what it is. §5: the withhold is a feature and the UI is not to
    // be embarrassed by it, so this says checking rather than apologising.
    case 'withheld': return 'Held back for checking';
    default: return 'Nothing ready yet';
  }
}

/** Only a `ready` card is startable. Everything else is a statement, not a door. */
export const cardIsStartable = (card: SessionCardView | null): boolean =>
  card?.state === 'ready' && !!card.sessionId;

/**
 * The registers present, as the three words the site already carries.
 *
 * A value the panel does not recognise is dropped rather than printed raw: the
 * register strip is a colour key, and a fourth chip with a machine name on it
 * would be the screen showing its own internals to a learner.
 */
export interface RegisterChip {
  /** The register itself, so the surface can colour it. */
  readonly value: string;
  readonly label: string;
}

/**
 * The registers present in a session, as chips.
 *
 * They used to come back as bare labels, so every one of them rendered in the
 * same muted grey — and §5 asks for *"the registers present (using the three
 * register colours the site already carries)"*. Two shouting grey words with
 * no colour and no referent is what a learner actually saw, which is worse
 * than not showing them: an unexplained uppercase word reads as a warning.
 */
/**
 * The three registers, in the order they climb.
 *
 * Duplicated from `core/src/domain/registers.ts` rather than imported: the
 * extension imports neither `core/` nor `runner/`, and this is three strings.
 * It is the ladder the depth controls walk, so the panel can say which
 * direction is available without asking the service and being told no.
 */
export const REGISTER_LADDER = ['from-nothing', 'building', 'fluent'] as const;

export function registerChips(registers: readonly string[] | undefined): RegisterChip[] {
  const known: readonly string[] = REGISTER_LADDER;
  return (registers ?? [])
    .filter((r) => known.includes(r))
    .map((value) => ({ value, label: registerLabel(value) }));
}

// ---------------------------------------------- The learner-controlled lineup contract: tonight's lineup


/** The controls, in learner voice. Every one of them is quiet: the accent
 *  belongs to Start, and a row of eight shouting buttons under a hero would be
 *  the screen arguing with itself about what to press. */

export const EXPECTED_TIME = 'Expected time';

/**
 * What is LEFT of a session, in minutes.
 *
 * The kicker's figure in the learning state. Every lesson not done, including
 * the one on screen, because the learner has not finished it yet and a number
 * that dropped the moment they opened something would be counting intent.
 *
 * The same arithmetic as the lineup's total by construction: on a session where
 * nothing is done they agree, and they diverge exactly as lessons are finished,
 * which is the divergence the figure exists to show.
 */
export function remainingMinutes(session: SessionView | null | undefined): number {
  const sections = Array.isArray(session?.sections) ? session.sections : [];
  return sections
    .filter((s) => s && !s.completed)
    .reduce((a, s) => a + Math.max(1, Math.round(Number(s.estimatedMinutes) || 0)), 0);
}

export function expectedTimeLine(minutes: number): string {
  const n = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
  return `${EXPECTED_TIME} · ${n} min`;
}


export const LINEUP_MORNING = 'This morning’s lineup';
export const LINEUP_AFTERNOON = 'This afternoon’s lineup';
export const LINEUP_EVENING = 'Tonight’s lineup';

/** What the service sends for this screen. The swap is a rewording of one known
 *  sentence rather than a rule about headings: another kind of next move
 *  carries its own title and must not be touched. Held here so the two files
 *  cannot drift apart in silence. */
export const LINEUP_HEADING_SENT = LINEUP_EVENING;

/**
 * Morning from 05:00, afternoon from 12:00, evening from 18:00 through to
 * 04:59. An hour that is not an hour is the evening, which is what the service
 * already said and therefore the safest thing to degrade to.
 */
export function lineupHeading(hour: number): string {
  const h = Number.isFinite(hour) ? Math.floor(hour) : -1;
  if (h >= 5 && h < 12) return LINEUP_MORNING;
  if (h >= 12 && h < 18) return LINEUP_AFTERNOON;
  return LINEUP_EVENING;
}

export const LINEUP_WHY_LABEL = 'Why this?';
export const LINEUP_GOOD_LABEL = 'Good call';
export const LINEUP_BAD_LABEL = 'Not what I need';
export const LINEUP_UP_LABEL = 'Move up';
export const LINEUP_DOWN_LABEL = 'Move down';
export const LINEUP_REMOVE_LABEL = 'Not tonight';

/** The two doors on a row, named for where they go. Both are `title` text on
 *  a control that already carries its own words, so they say what pressing it
 *  does rather than repeating what it says. */
export const lineupOpenTitle = (subject: string): string => `Start at ${subject}`;
export const lineupCourseTitle = (course: string): string => `Open ${course} in My studies`;
/**
 * The dated work this lesson moves forward, as a chip on the row it is about.
 *
 * The affordance-first interface contract. The hero used to say it in a sentence over the whole list, which
 * is a fact about one lesson announced over all of them. Shown on the row, in
 * the same quiet register the subject chip already uses, it needs no sentence.
 */
export const lineupServesTitle = (work: string): string => `Open ${work} in your plan`;

/** A write that did not land. The panel's standing sentence for it, so a
 *  learner never believes they made a mark they did not make. */
export const LINEUP_NOT_SAVED = 'That did not go through. Nothing changed.';
export const LINEUP_ORDER_SAVING = 'Saving this order…';
export const LINEUP_ORDER_SAVED = 'Order saved.';
export const LINEUP_VERDICT_SAVING = 'Saving your choice…';
export const LINEUP_REMOVE_SAVING = 'Removing this from tonight…';
export const MODEL_WORDS_SAVING = 'Saving your words…';

export interface LineupItem {
  readonly topicId: string;
  /** What this section is about, in the words the session itself uses. */
  readonly subject: string;
  /** One sentence of what is in it, taken from the section's own prose. */
  readonly summary: string | null;
  /** The course it belongs to, or null where nothing honestly links it. */
  readonly course: { readonly id: string; readonly title: string } | null;
  /** The dated work it moves forward, or null. Shown as a chip, not a
   *  sentence: see The affordance-first interface contract. */
  readonly serves: { readonly id: string; readonly title: string } | null;
  /** The register, for the colour, or an empty string for one this build does
   *  not know. Same rule as `registerChips`: a machine name is never printed. */
  readonly register: string;
  readonly registerLabel: string;
  readonly minutes: number;
  readonly minutesLabel: string;
  readonly why: string | null;
  /** How many pinned things this lesson was written from. Shown inside the
   *  why-disclosure, which is where provenance lives. */
  readonly sources: number;
}

const MINUTES = (n: number): string => `${n} min`;

/** How much of a first sentence fits under a heading without becoming the
 *  section. Long enough to be a description, short enough that the row is
 *  still a row. */
export const LINEUP_SUMMARY_CHARS = 90;


export function lineupSummary(summary: string | null | undefined): string | null {
  if (typeof summary !== 'string') return null;
  const said = summary
    .replace(/\u0060([^\u0060]*)\u0060/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|\*|_/g, '')
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.:;,]+$/, '');
  if (!said) return null;
  if (said.length <= LINEUP_SUMMARY_CHARS) return said;
  const cut = said.slice(0, LINEUP_SUMMARY_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[,;:]$/, '')}…`;
}

/** The dated work a section moves forward, shaped rather than trusted. Same
 *  rule as the subject: a chip with no id is a label with no door. */
function servesOf(
  serves: { commitmentId?: unknown; title?: unknown } | null | undefined,
): { id: string; title: string } | null {
  const id = serves?.commitmentId;
  const title = serves?.title;
  if (typeof id !== 'string' || !id) return null;
  if (typeof title !== 'string' || !title.trim()) return null;
  return { id, title: title.replace(/\s+/g, ' ').trim() };
}

/** The course a section belongs to, or null. Shaped rather than trusted: this
 *  comes off the wire, and a subject with no id is a label with no door. */
function courseOf(
  subject: { courseId?: unknown; title?: unknown } | null | undefined,
): { id: string; title: string } | null {
  const id = subject?.courseId;
  const title = subject?.title;
  if (typeof id !== 'string' || !id) return null;
  if (typeof title !== 'string' || !title.trim()) return null;
  return { id, title: title.replace(/\s+/g, ' ').trim() };
}

/**
 * Tonight's sections, in the order they are stored, as rows.
 *
 * Deliberately the SAME data the session room draws from, read the same way:
 * the heading is the section's heading, the level is the section's `depth`, and
 * the minutes are the section's `estimatedMinutes`. A lineup assembled from a
 * summary would be a second account of the evening that could disagree with the
 * first, which is the whole failure mode the session card had.
 *
 * Completed sections are not lined up. They are not what the learner is about
 * to do, and every control on a row is about a choice that is still open.
 */
export function lineupItems(session: SessionView | null): LineupItem[] {
  const sections = Array.isArray(session?.sections) ? session.sections : [];
  const ladder: readonly string[] = REGISTER_LADDER;
  return sections
    .filter((s) => s && !s.completed && typeof s.topicId === 'string' && s.topicId)
    .map((s) => {
      const rung = ladder.indexOf(s.depth);
      const minutes = Math.max(1, Math.round(Number(s.estimatedMinutes) || 0));
      return {
        topicId: s.topicId as string,
        subject: (s.heading ?? '').replace(/\s+/g, ' ').trim() || 'Untitled',
        register: rung < 0 ? '' : s.depth,
        registerLabel: rung < 0 ? '' : registerLabel(s.depth),
        minutes,
        minutesLabel: MINUTES(minutes),
        why: typeof s.why === 'string' && s.why.trim() ? s.why.trim() : null,
        summary: lineupSummary(s.summary),
        sources: Array.isArray(s.sourceIds) ? s.sourceIds.length : 0,
        course: courseOf(s.subject),
        serves: servesOf(s.serves),
      };
    });
}


// ------------------------------------------------- The single-session learning flow: the session room


/** "Coming up", not "Up next": the face toggle owns "Up next" as of the
 *  2026-08-29 rename, and one screen must not say the same words about two
 *  different things. The choosing state's rail already says "Coming up" for
 *  future topics, so the session's remaining sections take the same word for
 *  the same learner concept: what follows. */
export const SESSION_UP_NEXT = 'Coming up';
/** Not "completed", not a count. SB-18: nothing on any screen is a tally the
 *  learner can fall behind on, and a done lesson is a thing they did rather
 *  than a number they scored. */
export const SESSION_DONE_HEADING = 'Already done';
export const SESSION_NEXT = 'Next lesson';
export const SESSION_FINISH = 'Finish';
export const SESSION_LEAVE = 'Leave for now';

/** The sources panel's own state, said where it is true. It used to say
 *  "Sources shown below." from underneath the sources it was pointing at. */
export const SOURCES_OPEN = 'Sources are open.';
export const SOURCES_HIDDEN = 'Sources are hidden.';
/**
 * The mark it landed, the screen it could not repaint.
 *
 * Distinct from `LINEUP_NOT_SAVED` on purpose, because it is a different fact:
 * the write went through and was answered, and the re-read that follows it did
 * not. Telling the learner nothing changed would be false, and telling them it
 * worked while leaving them on a lesson they just finished would be confusing.
 */
export const SESSION_NOT_REFRESHED =
  'That was saved. The screen could not catch up just now, so it is still showing this one.';

/** A lesson in the session's rail: its level and how long it runs. */
export function sessionRailLine(minutes: number): string {
  const n = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
  return `${n} min`;
}


export const RAIL_EMPTY_HEADING = 'Nothing else to start yet';
export const RAIL_EMPTY_LINE =
  'Other things you can start right now appear here, with how long each one takes. Pin something and the next run builds them.';
/** A non-session move has no “tonight” to be after. Its empty rail explains
 *  the causal hand-off instead of borrowing the nightly lineup's vocabulary. */
export const RAIL_ONE_MOVE_HEADING = 'One move for now';
export const RAIL_ONE_MOVE_LINE =
  'When you record what happened, Virgil checks your studies, your plan and what you have learned before choosing again.';
/** SB-279: the rail on a genuinely new board no longer says one sentence about
 * the loop. It names the three ways in, and it is drawn in `arrival.ts`. */
export const RAIL_CAUGHT_UP_HEADING = 'What happens next';
export const RAIL_CAUGHT_UP_LINE =
  'I will bring this back when recall is due. New things you pin join the next run.';
export const RAIL_STUDIES_CAUGHT_UP_LINE =
  'What you completed stays in My studies. Add the next item when you have one.';
export const RAIL_PLAN_CAUGHT_UP_LINE =
  'What you completed stays on your plan. Add the next obligation when you have one.';

export const INSTEAD_HEADING = 'Something else instead';

/** The relationship a bare topic link used to hide after a session was held. */
export const HELD_BACK_TAKE_LINE =
  'Try a shorter lesson from one of your pins. It is checked separately.';

/** A row in the rail's alternatives: what it is, and what it costs. A length
 *  nobody sent is dropped rather than guessed at, because the one thing worse
 *  than a row with no minutes is a row with somebody else's. */
export function railRowLabel(label: string, minutes: unknown): string {
  const n = Number(minutes);
  return Number.isFinite(n) && n > 0 ? `${label} · ${MINUTES(Math.round(n))}` : label;
}

/** A lesson the last run already wrote, waiting behind tonight's pick. It is a
 *  built fact with a real figure, which is why it outlived the block of future
 *  topics it used to sit in. */
export const preparedReadyLine = (minutesLabel: string): string =>
  `Ready in your prepared session · ${minutesLabel}.`;

/** A lesson that is owed but is not in tonight's lineup. */
export interface UpcomingView {
  topicId: string;
  label: string;
  register?: string;
  why?: string;
  heldBack?: boolean;
  pinId?: string | null;
  /** Largest source-sufficient window for the pin the service selected. */
  quickTakeMinutes?: number | null;
}

export interface UpcomingItem {
  readonly topicId: string;
  readonly label: string;
  readonly pinId: string | null;
  readonly quickTakeMinutes: 1 | 3 | 5 | null;
  /** This topic's previous full lesson was withheld by its check. */
  readonly heldBack: boolean;
}

/**
 * What the rail keeps of a lesson that is not tonight's.
 *
 * The name and the pin behind it, and nothing else. The Gardener's `why` and
 * the register it would be pitched at were read out here until 2026-08-29, on a
 * row with nothing to press: *"whats the point of this?"*. Both are still shown
 * where they are worth something — the reason inside the `(i)` disclosure on
 * the lineup, the level on the board — and neither is a caption a learner reads
 * beside a link.
 */
export function upcomingItems(rows: readonly UpcomingView[] | undefined): UpcomingItem[] {
  return (rows ?? [])
    .filter((r) => r && typeof r.topicId === 'string' && r.topicId && typeof r.label === 'string')
    .map((r) => ({
      topicId: r.topicId,
      label: r.label.replace(/\s+/g, ' ').trim() || 'Untitled',
      pinId: typeof r.pinId === 'string' && r.pinId ? r.pinId : null,
      quickTakeMinutes: [1, 3, 5].includes(Number(r.quickTakeMinutes))
        ? Number(r.quickTakeMinutes) as 1 | 3 | 5 : null,
      heldBack: r.heldBack === true,
    }));
}

/** The actual window an upcoming source can honestly support, never larger
 * than the learner's current chip. Null means the row is not an action. */
export function boundedQuickTakeWindow(
  requested: unknown, supported: unknown,
): 1 | 3 | 5 | null {
  const request = Number(requested);
  const support = Number(supported);
  const choices = ([1, 3, 5] as const).filter((minutes) =>
    minutes <= request && minutes <= support);
  return choices.at(-1) ?? null;
}

/**
 * Which of `/today`'s ranked alternatives belong beside a lesson.
 *
 * A commitment repeated here was the defect: the hero's own line already names
 * what tonight moves forward, and the Plan is a room. What can stay is a move
 * that is itself learning — a recall burst, the next piece of course material,
 * another session — because those are things to DO now rather than places to
 * go and look.
 */
export function learningAlternatives<T extends { kind?: string; url?: string | null }>(
  alternatives: readonly T[] | undefined,
): T[] {
  const learning = ['burst', 'course-material', 'session'];
  return (alternatives ?? []).filter((a) => learning.includes(a.kind ?? '')
    && (a.kind !== 'course-material' || Boolean(a.url)));
}

export function lineupBuiltLine(sources: number): string | null {
  if (!Number.isFinite(sources) || sources <= 0) return null;
  return sources === 1
    ? 'Built from one thing you pinned.'
    : `Built from ${sources} things you pinned.`;
}

/**
 * The `(i)` disclosure, in the ranker's own words.
 *
 * The sentence comes off the section and is shown as written, except for the
 * old empty-history diagnostic, which is translated into learner language.
 */
export function lineupWhyLine(why: string | null): string {
  if (!why) return 'This one was picked before Virgil started recording why. The next lineup will say.';
  const said = why.trim();
  if (said.toLowerCase() === 'nothing has been asked about this yet')
    return 'Starting with the foundations until you show what you already know.';
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}${/[.!?]$/.test(said) ? '' : '.'}`;
}

/** What the current level means, said next to the chip that shows it. */
export function lineupLevelLine(register: string): string {
  if (register === 'from-nothing') return 'Starting from scratch on this one.';
  if (register === 'building') return 'Building on what you already have.';
  if (register === 'fluent') return 'Pitched at someone who mostly has this.';
  return 'The level for this one is not set.';
}

/** The quiet acknowledgement after a verdict on the choice. */
export function lineupVerdictLine(call: string): string {
  return call === 'good'
    ? 'Noted. More like this one.'
    : 'Noted. Less like this one.';
}

/**
 * What removing something actually did, including when it comes back.
 *
 * The window is the service's number, passed in, because the Gardener is what
 * honours it. A panel that carried its own copy of "a week" would be a promise
 * that goes stale the day somebody changes the constant.
 */
export function lineupRemovedLine(subject: string, days: number): string {
  const n = Number.isFinite(days) && days > 0 ? Math.round(days) : null;
  const back = n === null ? 'later'
    : n === 1 ? 'tomorrow'
      : `in about ${n} days`;
  return `Took ${subject} out of tonight. It comes back ${back}.`;
}

/**
 * One step up or down the list, for the keyboard and for anyone who is not
 * dragging anything.
 *
 * The accessible controls and the drop compute the same thing — the whole new
 * order — and send it to the same endpoint, so the two gestures cannot persist
 * different shapes. Returns the order unchanged when the move is off the end,
 * which is what a button at the top of the list should do.
 */
export function moveInOrder(
  order: readonly string[], topicId: string, direction: 'up' | 'down',
): string[] {
  const at = order.indexOf(topicId);
  const to = direction === 'up' ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= order.length) return [...order];
  const out = [...order];
  out[at] = out[to] as string;
  out[to] = topicId;
  return out;
}

/**
 * The dropped row, put where the row it landed on is.
 *
 * Removing first and then inserting at the target's new index is what makes a
 * drag downwards land AFTER the row it was dropped on and a drag upwards land
 * before it, which is what the pointer looks like it is doing in both
 * directions.
 */
export function dropInOrder(
  order: readonly string[], moved: string, onto: string,
): string[] {
  if (moved === onto) return [...order];
  const rest = order.filter((id) => id !== moved);
  const at = rest.indexOf(onto);
  if (at < 0 || !order.includes(moved)) return [...order];
  const from = order.indexOf(moved);
  const target = order.indexOf(onto);
  rest.splice(from < target ? at + 1 : at, 0, moved);
  return rest;
}

/**
 * What happens to the material that was held back.
 *
 * The withheld screen named the thing and stopped, which left a learner at a
 * dead end: something was written about their subject, it did not pass, and the
 * page said nothing about whether it was gone.
 *
 * It is not gone, and this is the sentence for it. `pipeline.ts`: *"Withholding
 * is also what returns the topic to the pool: an unshipped section never
 * advances `lastExposedAt`, so the Gardener still sees the topic as owed."* The
 * topic stays due by construction, so saying the next run tries again is a fact
 * about the code rather than a reassurance.
 *
 * §5 says the withhold is a feature and the UI should not be embarrassed by it.
 * Being unembarrassed means finishing the sentence.
 */
export function withheldNextLine(): string {
  return 'Nothing is lost. The topic stays due, so the next time you process, it is written and checked again.';
}

/** What was held back, one line each, naming which of the two things happened. */
export function withheldLines(card: SessionCardView | null): string[] {
  return (card?.withheld ?? []).map((w) =>
    `${w.heading}: ${w.reason === 'unverified' ? 'the check could not run' : 'the check found a problem'}`);
}

// --------------------------------------------------------- zone 2: momentum

/**
 * What the strip is, said once, at the top of it.
 *
 * It had no heading at all. Three sentences behind a thin rule, with no label,
 * read as log output rather than as the learner's own progress — and §5a's
 * whole argument is that these are facts the ledger can defend, which is worth
 * nothing if nobody can tell what they are claims about.
 */
export const MOMENTUM_HEADING = 'Recent progress';

export interface ProgressionEventView {
  kind: string;
  evidence: string;
  topicLabel: string;
  from?: string;
  to?: string;
  badge?: string;
  length?: number;
}

/** SB-67's four, in the milestone voice. A badge this build does not know is
 *  not rendered — an unnamed award is a claim with nothing behind it. */
const BADGE_TITLE: Record<string, string> = {
  'closure': 'Closed out',
  'regression-conquered': 'Won it back',
  'comeback': 'The comeback',
  'medium-follow-through': 'You went and did it',
};

/**
 * One momentum item, as one line.
 *
 * Null for anything this build cannot state — an unknown event kind, a missing
 * evidence sentence. §5 says the strip never invents content to fill itself,
 * and the corollary is that it drops what it cannot say rather than printing a
 * shape with a hole in it.
 */
export function momentumLine(event: ProgressionEventView | null | undefined): string | null {
  if (!event || typeof event.evidence !== 'string' || !event.evidence.trim()) return null;
  const label = typeof event.topicLabel === 'string' ? event.topicLabel : '';
  if (!label) return null;

  if (event.kind === 'milestone') {
    if (!event.from || !event.to) return null;
    return `${label}: ${registerLabel(event.from)} → ${registerLabel(event.to)}. ${event.evidence}`;
  }
  if (event.kind === 'chain') return `${label}: ${event.evidence}`;
  if (event.kind === 'badge') {
    const title = BADGE_TITLE[event.badge ?? ''];
    if (!title) return null;
    /**
     * The evidence sentence sometimes opens with the same words as the title.
     * `badges.ts` writes *"Closed out: recalled 1 time, and it held."* and this
     * prefixed *"Closed out: "* again, so the arrival page read:
     *
     *   Closed out: Cloud Run Instance Lifecycle. Closed out: recalled 1 time…
     *
     * Stripped rather than the badge text being rewritten, because the evidence
     * sentence is also shown at session end where it stands alone and needs its
     * own subject.
     */
    const evidence = event.evidence.trim();
    const lead = `${title}:`;
    const rest = evidence.toLowerCase().startsWith(lead.toLowerCase())
      ? evidence.slice(lead.length).trim()
      : evidence;
    const sentence = rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : '';
    return sentence ? `${title}: ${label}. ${sentence}` : `${title}: ${label}.`;
  }
  return null;
}

// ---------------------------------------------------------- zone 3: flagged

export interface FlaggedRowView {
  topicId: string;
  topicLabel: string;
  source: string;
  at: string;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * When, in the words a person would use.
 *
 * §5's own example is "you flagged this Tuesday", so inside a week it is the
 * weekday and after that it falls back to `when()`. The day names are a fixed
 * list rather than `toLocaleDateString`, because the panel's copy is English
 * and a locale-dependent string would make this untestable without pinning an
 * environment.
 */
export function flaggedWhen(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'a while back';
  const days = (now - at) / 86_400_000;
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 7) return DAYS[new Date(at).getDay()] ?? 'a while back';
  // `at` parsed, so `when` cannot answer null here — the fallback is for the
  // type, and for the day the guard above is moved or loosened.
  return when(iso, now) ?? 'a while back';
}

/**
 * The row, saying who put it there.
 *
 * §5: *"Each row names its source"*. A row that just said "flagged" would read
 * as the product's verdict on the learner; naming the source makes it their own
 * note back to them — except the regression line, which IS the product's read
 * and says so rather than pretending the learner asked for it.
 */
export function flaggedLine(row: FlaggedRowView, now: number): string | null {
  const at = flaggedWhen(row.at, now);
  // SB-61, and §5 lists it first. Said in the learner's own voice like the two
  // marks below it, because that is what it is: they read a quick take at the
  // moment they pinned something and told the product they were not there yet.
  if (row.source === 'quick-take-still-shaky') return `you said this was still shaky when you read it, ${at}`;
  if (row.source === 'resurface-refresher') return `you asked for a refresher on this, ${at}`;
  if (row.source === 'resurface-deeper') return `you asked to go deeper on this, ${at}`;
  if (row.source === 'regression') return `you had this and it has slipped, last seen ${at}`;
  // An unknown source is dropped. A row with no provenance is exactly the thing
  // this zone exists to avoid.
  return null;
}

/** §5: "a count of things the learner asked for, which is the one count that is
 *  not guilt". Nothing below one, because "and 0 more" is not a sentence. */
export const andNMore = (n: number): string | null => (n > 0 ? `and ${n} more` : null);

// ------------------------------------------------------------- zone 4: door

/** A door, not a view. The count is of topics — the display unit (SB-33) —
 *  and it is a fact about the pantry, never a tally of things left undone. */
export function boardDoorLabel(topics: readonly TopicView[]): string {
  const n = topics.length;
  return `${n} topic${n === 1 ? '' : 's'} on the board`;
}

/** Matching is on the label, case-insensitively, and an empty query matches
 *  everything — searching for nothing is not a filter. */
export function matchesSearch(topic: TopicView, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || (topic.label ?? '').toLowerCase().includes(q);
}

// ------------------------------------------------- searching what is studied
//
// The box has always said *"Search what you're learning"* and has always
// searched one thing: the board's topics. So a learner could type the exact
// words printed on the two cards underneath it — an unfiled pin, a course, a
// video they added by hand — and be told nothing matched. A search that cannot
// find what is on the screen beneath it teaches somebody that the search is
// broken, and they stop using it before they ever reach the part that works.
//
// What is searched now is everything the product already holds a title for:
// topics and unfiled pins on the board, and the courses and material in My
// studies. Two groups, because they are two different kinds of thing and live
// in two different rooms, and a flat list would send somebody to the wrong one.
//
// SB-18 holds: the headings are the names of the two places, never a tally of
// what was found in them, and the result IS the thing rather than a row about
// it.

/** One place a search looks, named for the room it would take you to. */
export const SEARCH_BOARD_HEADING = 'On your board';
export const SEARCH_COURSES_HEADING = 'In your courses';

/**
 * A group that found nothing, said about that group alone.
 *
 * Per group rather than once for the whole search, because "nothing on your
 * board" and "nothing in your courses" are two different facts, and one
 * sentence standing for both is how a learner concludes the material is gone
 * when it was only the board that was quiet.
 */
export function searchMissLine(where: 'board' | 'courses' | 'plan', query: string): string {
  const q = query.trim();
  if (where === 'board') return `Nothing on your board matches “${q}”.`;
  if (where === 'plan') return `Nothing in your plan matches “${q}”.`;
  return `Nothing in your courses matches “${q}”.`;
}

export function searchEmptyLine(query: string): string {
  const q = query.trim();
  return `I couldn’t find “${q}” on your board, in your courses or in your plan. Try a different word.`;
}

/** While the courses are still being read. Said rather than guessed: a group
 *  that reported "nothing" before it had looked would be lying about the half
 *  of the answer that had not arrived. */
export const SEARCH_COURSES_WAITING = 'Still reading your courses.';
/** A failed read is not an empty library. Keep the learner's material honest. */
export const SEARCH_COURSES_UNREADABLE = 'I could not read your courses.';

/** Ordinary product reads fail in Virgil's voice. Architecture nouns belong
 *  only on the self-hosting and model-connection screens. */
export const VIRGIL_UNAVAILABLE = "I can't open this right now.";

/** Case-insensitive, on a title, and never on an empty query. */
const hits = (title: string | null | undefined, q: string): boolean =>
  !!q && (title ?? '').toLowerCase().includes(q);

export interface CourseHitView { readonly id: string; readonly title: string }
export interface MaterialHitView {
  readonly id: string; readonly title: string;
  readonly courseId: string; readonly courseTitle: string;
}
export interface CommitmentHitView {
  readonly id: string; readonly title: string;
  readonly courseTitle: string;
}
export const SEARCH_PLAN_HEADING = 'In your plan';

/**
 * What My studies holds that answers this query.
 *
 * A course matches on its own title; a piece of material matches on its title
 * and carries the course it came out of, because "Week 3 video" on its own
 * answers half the question somebody asked. A course whose title matched does
 * not drag its whole reading list in with it: the course is the hit, and the
 * material rows underneath it are hits only on their own words.
 */
export function searchCourses<
  C extends {
    id: string; title: string;
    material?: readonly { id: string; title: string }[];
  },
>(courses: readonly C[], query: string): {
  courses: CourseHitView[]; material: MaterialHitView[];
} {
  const q = query.trim().toLowerCase();
  if (!q) return { courses: [], material: [] };
  const found: CourseHitView[] = [];
  const material: MaterialHitView[] = [];
  for (const c of courses) {
    if (hits(c.title, q)) found.push({ id: c.id, title: c.title });
    for (const m of c.material ?? []) {
      if (hits(m.title, q)) {
        material.push({ id: m.id, title: m.title, courseId: c.id, courseTitle: c.title });
      }
    }
  }
  return { courses: found, material };
}

/** Open work already projected by `/courses`, searched under its owning room. */
export function searchCommitments(
  commitments: readonly CommitmentHitView[], query: string,
): CommitmentHitView[] {
  const q = query.trim().toLowerCase();
  return q ? commitments.filter((commitment) => hits(commitment.title, q)) : [];
}

/** An unfiled pin, matched the same way its title is drawn. */
export function matchesPinSearch(
  pin: { title: string; gist?: string }, query: string,
): boolean {
  const q = query.trim().toLowerCase();
  return !q || hits(pin.title, q) || hits(pin.gist, q);
}

// --------------------------------------------- the resurface mark (SB-62)


export type ResurfaceNuance = 'refresher' | 'deeper';
export const RESURFACE_FROM_LESSON: ResurfaceNuance = 'refresher';

/** Said once the mark has landed, so the learner knows the tap did something.
 *  It names the promise the Gardener is now holding. */
export function resurfacedLine(nuance: string): string {
  return nuance === 'deeper'
    ? "Noted. I'll bring this back and go further with it."
    : "Noted. I'll bring this back and take it slower.";
}

/** SB-65/67: the award moment is session end. An empty list is empty — there is
 *  no participation line, because there is no award for turning up. */
export function awardsHeading(count: number): string | null {
  return count > 0 ? 'What that session moved' : null;
}

// --------------------------------------------- the quick take (SB-59/60/61)

/**
 * A topic label, cut to fit a clause in a narrow column.
 *
 * The untrusted-label rendering contract: the label is model output over pinned text and is uncapped end to
 * end, so it is capped **at render as well as at the untrusted boundary**, with
 * the ellipsis here and the full label kept in the data for provenance. This is
 * the render half, for the one surface that heads a screen with a label.
 *
 * The same 48 characters `CLAUSE_HEADING` has always named, because it is the
 * same column and the same question.
 */
export function shortLabel(label: string | null | undefined): string {
  return cutToWord(String(label ?? '').replace(/\s+/g, ' ').trim(), CLAUSE_HEADING);
}

/**
 * Cut to a length without cutting through a word.
 *
 * The old cut was `slice(n - 1)`, which produced *"Deep Learning with PyTorch,
 * Network Arc…"* on the first real pin anybody made. A heading that ends
 * mid-word does not read as an abbreviation, it reads as a bug, and on a
 * screen whose whole job is to look trustworthy about somebody's own material
 * that is an expensive impression for one character of laziness.
 *
 * Back off to the last space in the last quarter of the budget: far enough to
 * find a boundary in ordinary prose, near enough that a long unbroken token
 * (a URL, a chemical name) still cuts rather than collapsing the heading to
 * nothing.
 */
export function cutToWord(raw: string, limit: number): string {
  if (!raw || raw.length <= limit) return raw;
  const hard = raw.slice(0, limit - 1);
  const space = hard.lastIndexOf(' ');
  const kept = space > Math.floor(limit * 0.75) ? hard.slice(0, space) : hard;
  // A cut landing after "Training a" is a word boundary and still reads as
  // damage, so a trailing function word goes with the cut.
  const tidy = kept
    .replace(/\s+(?:a|an|the|of|for|to|and|with|in|on|at|by|from|is|as|or)$/i, '')
    .replace(/[\s,;:.\-–—]+$/, '');
  return `${tidy}…`;
}


export function quickTakeStandingLine(): string {
  return '';
}

/**
 * §3: *"Closes with one tap: Got it / Still shaky. No essay, no rating scale."*
 *
 * The vocabulary, the three labels and the row that carries them moved to
 * `quick-take-close.ts` in SB-283, when the close grew its third answer.
 * Questions and shortcuts are engagement, not a verdict, so they stay here and
 * do not close the screen or write anything.
 */

/**
 * The way out of a take, named for where it goes.
 *
 * A take on the page was opened from a pin on the board, and the board is
 * where the rest of that learner's evidence still is. Named as a place rather
 * than as a direction, like every other exit in this product: there is no
 * "back" here, because a surface with no history cannot honestly offer one.
 */
export const BOARD_EXIT = 'Your board';


export const ASK_PLACEHOLDER = 'Ask about this';
export const ASK_SEND = 'Ask';

/**
 * The three things people ask most, as buttons.
 *
 * One press, and it asks. They are shortcuts into the same exchange rather
 * than a mode of their own, and what was sent appears immediately as the
 * learner's own turn, so nothing is hidden by sending it directly. An earlier
 * build filled the box and waited for a second press so that the question
 * could be inspected first; that is a shortcut costing two presses, which is
 * not a shortcut.
 */
export const ASK_SHORTCUTS: readonly { key: string; label: string; question: string }[] = [
  { key: 'simpler', label: 'Simpler', question: 'Explain that more simply, assuming less.' },
  { key: 'deeper', label: 'Go deeper', question: 'Go deeper on that.' },
  { key: 'example', label: 'Example', question: 'Give me a worked example.' },
];

/** Who said what, on screen. */
export const ASK_YOU = 'You';

/** The answer could not be written. There is no Verifier on this path either,
 *  so the failure is reported rather than smoothed over. */
export function askFailedLine(): string {
  return 'I could not answer that one just now. Ask again, or put it on the board and I will build it properly.';
}

/**
 * SB-30's route back to the pin mechanic, kept because it is the half of that
 * story worth keeping: an answer is one screen, and a subject is something the
 * fleet should build properly. An offer, never a refusal to answer.
 */
export function offerAsPinLine(label: string): string {
  return `That has grown into its own subject: ${label}.`;
}
export const OFFER_AS_PIN_ACTION = 'Put it on the board';
export const OFFER_AS_PIN_DONE = 'On the board.';

export type LessonQuestionFailure =
  | 'unreachable' | 'budget' | 'credential' | 'refused' | 'empty'
  | 'update-service' | 'update-extension';

/** A failed foreground question is a retry state, never a vanished thought. */
export function lessonQuestionFailedLine(cause: LessonQuestionFailure): string {
  switch (cause) {
    case 'unreachable':
      return "I can't answer right now. Your question is still here.";
    case 'budget':
      return 'Your model budget stopped this before anything was sent. Your question is still here.';
    case 'credential':
      return 'The model connection needs attention before I can answer. Your question is still here.';
    case 'update-service':
      return 'This Virgil installation is older than the extension. Update and restart Virgil. Your question is still here.';
    case 'update-extension':
      return 'This extension is older than the Virgil installation. Update the extension. Your question is still here.';
    case 'empty':
      return 'No answer came back. Your question is still here.';
    case 'refused':
    default:
      return 'I could not answer that just now. Your question is still here.';
  }
}

/* The receipts a closing tap produces live in `quick-take-close.ts` beside the
 * controls that produce them (SB-283). */


/**
 * The take that could not be written.
 *
 * Generation can fail, and the separate source check can withhold a take that
 * was written but did not earn the right to be shown. Neither path may display
 * an empty body as teaching. SB-59 is explicit that the escalation coming to
 * nothing costs the learner nothing — the pin was saved before any of this —
 * so every sentence says that rather than blaming the page.
 */
export function quickTakeFailedLine(cause: GuideFailure = 'model'): string {
  switch (cause) {
    case 'not-saved':
      return 'This one did not reach me, so there was nothing to write about yet. Nothing about the page was lost; pin it again and I will pick it up.';
    case 'unreachable':
      return 'Nothing answered, so I could not make this lesson. Start Virgil, then try again.';
    case 'refused':
      return 'I could not write a take from that. This is mine to fix, not yours.';
    case 'budget':
      return `${BUDGET_STOPPED_LINE} No take was written.`;
    case 'credential':
      return `${CREDENTIAL_MISSING_SHORT} No take was written.`;
    case 'update-service':
      return 'This Virgil installation is older than the extension. Update and restart Virgil. No take was written.';
    case 'update-extension':
      return 'This extension is older than the Virgil installation. Update the extension. No take was written.';
    case 'no-answer':
      return 'Nothing came back in time, so I do not know whether this was saved. Pin it again if it is not on your board.';
    case 'unverified':
      return 'I wrote a draft, but its source check did not clear it, so I held it back. Your credit limit did not stop this.';
    case 'model':
    default:
      return 'I couldn’t write that one just now. That is me, not the page.';
  }
}

// ------------------------------------------- SB-59: what the take was written from

/**
 * How much of the pinned passage the screen shows before it folds.
 *
 * The agent reads up to 1,500 characters. Showing all of them above the take
 * would answer "wall of text" with a second wall, and the point of this block
 * is orientation rather than re-reading: enough to recognise what this is,
 * with the rest one tap away when it is not enough.
 */
export const PINNED_PREVIEW = 320;

/**
 * What to call the block, which depends on what the learner actually did.
 *
 * A selection is theirs and is called theirs. A whole-page pin is not: the
 * material is whatever text the page happened to carry, so the honest heading
 * says what was read rather than implying they chose it.
 */
export function pinnedHeading(kind: string): string {
  return kind === 'selection' ? 'What you pinned' : 'What I read';
}

/**
 * The sentence that turns a thin take into a legible one.
 *
 * On a whole-page pin the material is the page's own text, which on a busy
 * page is navigation, notices and boilerplate. A take written from that is
 * exactly as thin as its input, and without this line the learner has no way
 * to tell that from a model that simply did badly. It names the cause and the
 * fix in one sentence, and it appears only in the case that has one.
 */
export function pinnedNote(kind: string): string | null {
  if (kind === 'selection') return null;
  return 'You pinned the page without selecting anything, so this is the page\u2019s own text. '
    + 'Select the part you care about first and the next one is written from that.';
}

export interface PinnedPreview {
  /** Shown immediately. Cut at a word, never mid-token. */
  readonly shown: string;
  /** The remainder, or empty when it all fits. */
  readonly rest: string;
}

/**
 * Split the pinned material into what is shown and what is folded away.
 *
 * Whitespace is collapsed first. Pinned page text arrives with the newlines
 * and runs of spaces the page's own markup put there, and reproducing those
 * faithfully makes a quotation look like broken output rather than like a
 * passage.
 */
export function pinnedPreview(text: string, limit: number = PINNED_PREVIEW): PinnedPreview {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (raw.length <= limit) return { shown: raw, rest: '' };
  const cut = cutToWord(raw, limit + 1).replace(/…$/, '').trimEnd();
  return { shown: cut, rest: raw.slice(cut.length).trim() };
}

/** The control that unfolds the rest, and the one that folds it back. */
export const PINNED_MORE = 'Show all of it';
export const PINNED_LESS = 'Show less';

/**
 * The panel when nothing was pressed.
 *
 * Says what the panel is for and stops there. No zones, no session card, no
 * counts: a surface that shows the main page badly is why five screens needed
 * a way back to it.
 */
/**
 * What the main page says when it could not read the board, and why the
 * difference is worth carrying.
 *
 * There was one sentence for every failure — *"Can't reach the service"* — and
 * a test named *"a service that answers 500 is the same as one that is not
 * there"* holding it in place. Found in the 2026-08-22 audit; it is the same
 * flattening that cost an hour on the guide screen, and it is aimed at the
 * worst possible moment.
 *
 * On an account-backed copy, 401/403 means Virgil could not establish whose
 * board was requested. That is an identity recovery, never a service-key task
 * for the learner.
 *
 * The queue clause survives on every branch, because it is true on every
 * branch: the worker queues a pin whenever the post fails, for any reason.
 */
export function boardUnreadableLine(cause: 'unreachable' | 'refused', status: number | null): string {
  if (cause === 'unreachable') {
    return "I can't open your board right now. Pins you make will wait safely in this browser and sync when I can.";
  }
  if (status === 401 || status === 403) {
    return 'I could not confirm which board is yours. Sign in again. '
      + 'Pins you make will wait safely in this browser and sync when I can.';
  }
  return 'I could not open your board. This is mine to fix, not yours. '
    + 'Pins you make will wait safely in this browser and sync when I can.';
}

/**
 * How to pin, said on the one screen where nobody knows yet.
 *
 * The empty arrival page told a first-time learner *"Pin something and I will
 * build a session from it"* and stopped there. Nothing on that screen says how
 * — the gesture lives in a context menu on some other page, which is exactly
 * where somebody who has never used this product is not looking. A first run
 * that names the thing to do and not the way to do it is a locked door with a
 * sign on it.
 *
 * The shortcut is the one `manifest.json` declares for `pin-interest`. It is
 * named second because the menu is discoverable and a chord is not.
 */
/**
 * A section body, split into the blocks it was written as.
 *
 * `PROSE_STYLE` tells the Composer to break its prose into short paragraphs
 * separated by a blank line, and forbids markdown — so an **indented run of
 * lines is the only way it has to show code**, and it uses it. On the first
 * real session screen that came out as:
 *
 *   Start from the failure. Your query was, in effect:
 *
 *     where('status', '==', 'active').orderBy('createdAt', 'desc')
 *
 *   Firestore rejected it because…
 *
 * The whole body was one `white-space: pre-wrap` text node, so that middle line
 * rendered in the same 17px proportional face as the sentences around it. The
 * indent survived and everything that makes code readable — a fixed pitch,
 * where the quotes and parentheses line up — did not. On a product whose
 * material is largely technical that is a real cost, and it is invisible in a
 * screenshot until somebody tries to read the line.
 *
 * ## What counts as code, and why it is this and not a parser
 *
 * A block whose every non-empty line is indented by two spaces or more. That is
 * exactly the shape the style produces and nothing else in the prose has it:
 * paragraphs start at column zero because the model is writing sentences.
 *
 * Deliberately not markdown fences, and not a language guess. The Composer is
 * told not to write markdown, so treating ``` as meaningful would be building a
 * second door into the thing the style closes.
 *
 * The common indent is removed, because it is how the block was marked rather
 * than part of what it says — and a code block that keeps it starts every line
 * two spaces further right than the author wrote it.
 */
export interface BodyBlock {
  readonly kind: 'prose' | 'code';
  readonly text: string;
}

const INDENTED = /^[ \t]{2,}\S/;

export function bodyBlocks(body: string): BodyBlock[] {
  const raw = String(body ?? '');
  if (!raw.trim()) return [];

  return raw
    .split(/\n[ \t]*\n/)
    .map((block) => block.replace(/\s+$/, ''))
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split('\n');
      const meaningful = lines.filter((l) => l.trim().length > 0);
      const isCode = meaningful.length > 0 && meaningful.every((l) => INDENTED.test(l));
      if (!isCode) return { kind: 'prose', text: block } as const;

      // The shallowest line decides the common indent, so relative structure
      // inside the block survives being un-indented.
      const indent = Math.min(...meaningful.map((l) => (/^[ \t]*/.exec(l)?.[0].length ?? 0)));
      return { kind: 'code', text: lines.map((l) => l.slice(indent)).join('\n').trim() } as const;
    });
}

/** Waiting for a topic's pins. Short, because this is one small read. */
export const LOADING_PINS = 'Opening…';

/**
 * The same read, waited on from the split picker.
 *
 * Named apart from `LOADING_PINS` because the two waits are read in different
 * places: "Opening…" belongs under a topic that is opening, and the picker is
 * not opening anything — it is looking at what is inside before it can offer
 * any of it to be moved out. The picker drew a bare `…` and sat on it, which is
 * the exact nothing the take screen used to show before these lines were
 * written, on the one screen where a learner is repairing their own history.
 */
export const LOADING_SPLIT_PINS = 'Reading what is in this topic…';

/** The board could not read what is inside a topic. Told apart from an empty
 *  topic, because "you saved nothing here" and "I could not look" are different
 *  claims about somebody's own work. */
export function boardPinsUnreadableLine(): string {
  return 'I could not read what is in this one just now. Nothing has been lost; try opening it again.';
}

export const HOW_TO_PIN =
  'Highlight anything on any page, right-click, and choose how much you want to say about it. '
  + 'Or press Alt+P to pin without stopping.';

export const PANEL_PICK_UNAVAILABLE =
  "Virgil can't read this browser page directly. Paste the words or choose the file instead.";

// ---------------------------------------------- mode-guide-me: walking a task

/**
 * The guide, in the panel's words rather than the model's.
 *
 * Every sentence a learner reads on that screen that is not a step is here,
 * for the same reason the quick take's standing line is: a sentence generated
 * by the thing whose authority it qualifies is a sentence that can go missing.
 *
 * The standing line itself — *"Guide. Written from what you pinned, and not
 * checked."* — was written for a header the guide never grew, and no screen
 * ever drew it. It is gone rather than kept warm; the disclosure a learner
 * does read is the one on the quick take.
 */

/** Where they are, said plainly. A guide with no position is a list, and a
 *  list is the thing this product does not put in front of people. */
export function guideProgressLine(resolved: number, total: number, stuck = 0): string {
  if (total <= 0) return '';
  if (resolved >= total) return stuck > 0 ? 'All steps covered.' : 'All of it, done.';
  return `Step ${resolved + 1} of ${total}.`;
}

/** There was no subject in the material. Stated, never performed: inventing a
 *  task would send a learner off doing something nobody asked for.
 *
 *  Narrow by ruling. This used to fire on any passage that did not issue
 *  instructions, and it refused the whole feature — a learner who highlights a
 *  description and asks to be walked through it is asking to be walked through
 *  doing it. See `tutor.ts`. */
export function guideNoSubjectLine(): string {
  return 'There is nothing in what you pinned to walk you through. It is a menu or a notice rather than a subject. Pin the part you actually want to do and I will take you through it.';
}


export type GuideFailure =
  /** The service answered and could not write a usable guide. The only one of
   *  these that is genuinely about the model. */
  | 'model'
  /** A take was written, but its independent source check found a fatal
   *  problem or did not return a usable verdict. Guides do not use this cause. */
  | 'unverified'
  /** The pin never reached the service, so nothing was ever asked. */
  | 'not-saved'
  /** Nothing answered at this address. */
  | 'unreachable'
  /** Something answered and refused. A learner cannot act on a status code,
   *  but they can act on knowing it was not their page and not their pin. */
  | 'refused'
  /** The learner's own spend limit stopped the call before it was sent. The
   *  one cause on this list that is not a fault, and the only one with a
   *  control behind it — so it is the only one that names a screen. */
  | 'budget'
  /** The connection this was routed to has no key saved. The second cause that
   *  is not a fault and has a control behind it, and it must not be said in the
   *  budget's words: a limit somebody chose and a setup step nobody finished
   *  are different problems with different fixes. */
  | 'credential'
  /** The two installed halves can name which one is behind. */
  | 'update-service'
  | 'update-extension'
  /** The worker never came back and the wait ran out. MV3 is entitled to kill
   *  it mid-flight, so this is a real state rather than a defensive one. */
  | 'no-answer';

export function guideFailedLine(cause: GuideFailure = 'model'): string {
  switch (cause) {
    case 'not-saved':
      return 'This one did not reach me, so there was nothing to walk you through yet. Nothing about the page was lost; pin it again and I will pick it up.';
    case 'unreachable':
      return 'Nothing answered, so I could not make this guide. Start Virgil, then try again.';
    case 'refused':
      return 'I could not write a guide from that. This is mine to fix, not yours.';
    case 'budget':
      return `${BUDGET_STOPPED_LINE} No guide was written.`;
    case 'credential':
      return `${CREDENTIAL_MISSING_SHORT} No guide was written.`;
    case 'update-service':
      return 'This Virgil installation is older than the extension. Update and restart Virgil. No guide was written.';
    case 'update-extension':
      return 'This extension is older than the Virgil installation. Update the extension. No guide was written.';
    case 'no-answer':
      return 'Nothing came back in time, so I do not know whether this was saved. Pin it again if it is not on your board.';
    case 'model':
    default:
      return 'I could not turn that into steps. That is me, not the page.';
  }
}


export function savedPinLine(label: string | null, where: 'board' | 'pins' = 'board'): string {
  if (where === 'pins') return label ? `It is still waiting in Pins as “${label}”.` : 'It is still waiting in Pins.';
  return label
    ? `It is saved as "${label}" and it is on your board.`
    : 'It is saved and it is on your board.';
}
/** The one durable fact a withheld draft needs beside its reason. */
export function withheldSourceLine(label: string | null, where: 'board' | 'pins' = 'board'): string {
  if (where === 'pins') return label ? `Your source is still waiting in Pins as “${label}”.` : 'Your source is still waiting in Pins.';
  return label
    ? `Your source is still on your board as “${label}”.`
    : 'Your source is still on your board.';
}
/** What the two controls on a step say. `stuck` is the one that writes. */
export const GUIDE_CHOICES = [
  { verdict: 'done', label: 'Done' },
  { verdict: 'stuck', label: 'I am stuck on this' },
] as const;

/** After the last step. No score, no streak, no congratulation: §5a's law is
 *  that the product never gamifies its own prose. */
export function guideFinishedLine(stuckCount: number): string {
  if (stuckCount <= 0) return 'That is the task. Next time I will build on it rather than start it over.';
  return stuckCount === 1
    ? 'That is the task. One step gave you trouble, and your next session starts there.'
    : `That is the task. ${stuckCount} steps gave you trouble, and your next session starts with them.`;
}

/** Said when the explanation itself failed, on the one surface with no
 *  withhold path to fall back to. */
export function guideStuckFailedLine(): string {
  return 'I could not explain that one. It is on the board either way, and your next session takes it seriously.';
}

// ------------------------------------------- when a session gets built (§5e)


/** The two answers, and neither is a default the product chose for them. */

/** The hours, as somebody reads a clock rather than as the code stores one. */


/** What the screen says the current setting is. Names the zone, because a time
 *  without one is the thing this replaced. */

/**
 * The button that asks for one now.
 *
 * Called **Process**, the same as the one on the board, because it is the same
 * action. It was "Build one now" here and "Process" there — two names for one
 * thing on two screens, which is a learner having to work out that they are the
 * same before they will press either.
 */
export const BUILD_NOW_LABEL = 'Process';
export const BUILD_NOW_WORKING = 'Working through it…';
export const BUILD_NOW_FAILED = "That didn't go through. Nothing changed.";

/**
 * The one honest caveat, and it belongs on this screen rather than in a
 * release note: a session is not instant. The Forager re-fetches every pinned
 * page before anything is composed, which was measured at 8.5 minutes of
 * silence on a full board. A learner who asks for one and watches a spinner
 * for nine minutes without being told has been misled by omission.
 */
export const BUILD_NOW_NOTE = 'It reads every page you pinned first, so it takes a while. You do not have to wait here.';

/**
 * What Today says after its own build button has been pressed.
 *
 * The next move can now BE a build: a dated piece of work that names topics on
 * the board has somewhere real to send somebody on a night with no session yet.
 * The run takes minutes, so the page states what is happening in one quiet line
 * under the card and leaves. **No spinner and no promise of a time** — a
 * progress indicator over a job whose length nobody can predict is a lie with
 * an animation on it, and this screen is not the place to wait.
 */
export const BUILD_STARTED_LINE =
  `I am working through your board now. ${BUILD_NOW_NOTE}`;
/**
 * A run that is already going, on the screen that offers to start one.
 *
 * Said without a duration for the same reason the line above is: the run reads
 * every pinned page and then writes a lesson, and how long that takes is a
 * property of somebody's own machine. What a learner needs from this line is
 * that it is happening and that they are not waiting for it.
 */
export const BUILDING_NOW_LINE =
  'I am working through your board right now. It will be here when it is done, and you do not have to wait on this screen.';

/** A real pipeline stage, translated into the work the learner is waiting for. */
export function buildingStageLine(stage: string | null | undefined, waiting: number): string {
  const leave = ' You do not have to wait on this screen.';
  if (stage === 'queued') return `Your board is safely queued for background processing.${leave}`;
  if (stage === 'intake') return `Reviewing course sources before anything reaches your plan.${leave}`;
  if (stage === 'forage') {
    const noun = waiting === 1 ? 'saved item' : 'saved items';
    return `Reading ${waiting} ${noun} and extracting the useful parts.${leave}`;
  }
  if (stage === 'cluster') return `Grouping what I found into subjects on your board.${leave}`;
  if (stage === 'survey' || stage === 'analyse' || stage === 'comfort'
      || stage === 'statements' || stage === 'garden') {
    return `Working out what you have met, what needs work, and what should come next.${leave}`;
  }
  if (stage === 'compose') return `Writing the lesson from what the board supports.${leave}`;
  if (stage === 'verify') return `Checking the lesson before showing it to you.${leave}`;
  return BUILDING_NOW_LINE;
}

export interface BatchStageReceiptView {
  stage: string;
  ms: number;
  failed: boolean;
  degradeReason?: 'exhausted' | 'blocked' | 'transport' | 'invalid' | 'unknown' | null;
}

export interface BatchActivityView {
  state: 'queued' | 'running' | 'finished' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  currentStage: string | null;
  reports: BatchStageReceiptView[];
  outcome: string | null;
  /** Why a run produced no lesson. Optional while older services are still in
   * the wild; without it, failed stage reports remain the compatibility read. */
  outcomeReason?: 'nothing-to-teach' | 'model-failed' | 'learner-context-changed' | null;
  remaining: number;
  withheld: number;
  /** Corrections present when the run began; absent on older services. */
  learnerCorrections?: number;
  /** The run made no observation, wrote no statement and raised no proposal.
   *  Absent on older services, and absent reads as not known rather than lean. */
  lean?: boolean;
  failure: string | null;
  /** Closed recovery class only; never provider text, a key or an exception. */
  failureReason?: 'model-credential' | 'model-budget' | null;
}

const batchStageNames: Readonly<Record<string, string>> = {
  intake: 'Course sources reviewed',
  forage: 'Saved material read',
  cluster: 'Board subjects grouped',
  survey: 'Dependencies checked',
  analyse: 'Learning patterns checked',
  comfort: 'Evidence weighed',
  statements: 'Learner model updated',
  garden: 'Next material selected',
  compose: 'Lesson written',
  verify: 'Lesson checked',
};

/** One completed autonomous step, translated out of the agent/runtime register. */
export function batchStageReceiptLine(report: BatchStageReceiptView): string {
  const name = batchStageNames[report.stage] ?? 'Processing step';
  const seconds = Math.max(0, report.ms) / 1000;
  const time = seconds < 1 ? 'under a second'
    : seconds < 60 ? `${Math.round(seconds)}s`
      : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${name} · ${time}${report.failed ? ' · needs attention' : ''}`;
}

/**
 * A night that read the board and had nothing to say about it, said out loud.
 *
 * The run this exists for printed nine lawful stage lines and left the learner
 * quieter than the night before, with no surface anywhere saying so. One
 * sentence: the fact, and what happens next. No praise, no alarm, no apology.
 * "The next run" is a fact rather than a promise about hours, because a run
 * here is pressed or is triggered by what the learner pins.
 */
export const LEAN_NIGHT_LINE =
  'A lean night: your material was read, but the deeper pass came back empty. The next run tries again.';

/**
 * The outcome line shown after the learner has left and returned.
 *
 * The lean sentence is appended rather than substituted, because what a run
 * produced and whether it produced anything worth reading are two facts: a
 * night can be lean and still have a checked lesson waiting. It is withheld
 * from a run with a degraded stage, which already carries its own honest line;
 * two competing explanations of one night read worse than one.
 */
export function batchActivityLine(activity: BatchActivityView): string {
  const line = batchOutcomeLine(activity);
  return activity.lean && activity.state === 'finished'
    && !activity.reports.some((report) => report.failed)
    ? `${line} ${LEAN_NIGHT_LINE}` : line;
}

function batchOutcomeLine(activity: BatchActivityView): string {
  if (activity.state === 'queued') {
    return 'Your board is safely queued for background processing. You can leave this screen.';
  }
  if (activity.state === 'running') return 'Virgil is still working through this board.';
  if (activity.state === 'failed') {
    if (activity.failureReason === 'model-credential') {
      return 'Processing stopped because the assigned model connection needs setup. Your saved material is still on the board.';
    }
    if (activity.failureReason === 'model-budget') {
      return 'Processing stopped at the model limit. Your saved material is still on the board.';
    }
    return 'Processing stopped before it finished. Your saved material is still on the board.';
  }
  if (activity.outcome === 'session') {
    const correction = activity.learnerCorrections
      ? ` ${activity.learnerCorrections === 1 ? 'Your Insights correction was' : 'Your Insights corrections were'} carried into its teaching brief.`
      : '';
    return (activity.withheld > 0
      ? 'Processing finished. A checked lesson is ready, and some material was held back.'
      : 'Processing finished. Your checked lesson is ready.') + correction;
  }
  if (activity.outcome === 'quota-degraded') {
    return 'Processing stopped at the model limit. Your saved material is still waiting.';
  }
  if (activity.outcome === 'no-session') {
    if (activity.outcomeReason === 'learner-context-changed') {
      return 'Your Insights changed while this lesson was being written, so that draft was not saved. Process again to build from your current words.';
    }
    const failed = activity.outcomeReason === 'model-failed'
      || activity.reports.some((report) => report.failed);
    return failed
      ? 'Processing finished, but model work failed before a lesson could be checked.'
      : 'Processing finished. There was not enough supported material for a lesson yet.';
  }
  return 'Processing finished. Your saved material is still on the board.';
}

export type BatchRecoveryAction = 'lesson' | 'models' | 'process' | null;

/** The one useful follow-up, if the receipt needs one. */
export function batchRecoveryAction(activity: BatchActivityView): BatchRecoveryAction {
  if (activity.state === 'queued' || activity.state === 'running') return null;
  if (activity.state === 'failed') {
    return activity.failureReason === 'model-credential' || activity.failureReason === 'model-budget'
      ? 'models' : 'process';
  }
  if (activity.outcome === 'session') return 'lesson';
  if (activity.outcome === 'quota-degraded') return 'models';
  if (activity.outcomeReason === 'learner-context-changed') return 'process';
  if (activity.outcomeReason === 'model-failed'
      || activity.reports.some((report) => report.failed)) return 'models';
  return null;
}

/** Pressed twice, or pressed while the nightly was already going. */
export const BUILD_ALREADY_RUNNING_LINE =
  'I am already working through your board. It will be here when it is done.';
export const BUILD_NOT_STARTED_LINE =
  "That didn't go through. Nothing has changed and nothing is being built.";

/**
 * A build the service refused, named rather than swallowed.
 *
 * A pause is a pause and a button is not a way round it (the collection-pause contract), so the
 * 409 gets the sentence that says where to undo it. Anything else says what
 * happened and stops, because a panel that invents a cause for a status it
 * does not recognise is guessing on the learner's behalf.
 */
export function buildRefusedLine(status: number | null): string {
  if (status === 409) {
    return 'Collection is paused, so nothing is being built. Turn it back on in Settings.';
  }
  return 'I could not start the build. Nothing has changed.';
}


// -------------------------------------------------- the wait, made visible


export const LOADING_HOME = 'Getting your board…';
export const LOADING_TAKE = 'Reading what you pinned…';
export const LOADING_GUIDE = 'Working out the steps…';
export const LOADING_STUCK = 'Working through that step…';
export const LOADING_ASK = 'Thinking about that…';
export const LOADING_CHECK = 'Reading your draft…';

/** The one honest caveat on the two that are slow: they are model calls, and
 *  a model call is not instant however much anybody would like it to be. */
export const LOADING_SLOW_NOTE = 'This can take a minute or two.';

// ------------------------------------------------- when the batch runs itself

/**
 * The control that replaced the hour of the day — the event-driven processing contract.
 *
 * An hour fires whether or not anything happened. A count cannot: it is a fact
 * about the learner's own material, so a board nobody added to never triggers
 * one. Off is the default and it means exactly that — nothing runs unless
 * somebody presses Process.
 */
export const AUTO_HEADING = 'Processing what you pin';

export const AUTO_CHOICES: readonly { value: number | null; label: string }[] = [
  { value: null, label: 'Only when I press Process' },
  { value: 3, label: 'Once 3 things are waiting' },
  { value: 5, label: 'Once 5 things are waiting' },
  { value: 10, label: 'Once 10 things are waiting' },
  { value: 25, label: 'Once 25 things are waiting' },
];

export function autoStateLine(value: number | null): string {
  return value === null
    ? 'Nothing is processed until you press Process. Nothing is spent either.'
    : `Everything waiting is worked through in one pass once ${value} things have piled up.`;
}

/** Never automatic below this, whatever is stored. One pin is not a batch, and
 *  processing it alone is the per-pin model call batching exists to avoid.
 *  Mirrors `core/domain/batch.ts` so a panel and a service cannot disagree
 *  about what a number in this field means. */
export const AUTO_FLOOR = 3;

export function autoThreshold(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.max(AUTO_FLOOR, Math.floor(value));
}

// =========================================================== the study buddy
//
// Copy and judgements for the four capabilities added on 2026-08-23. Here
// rather than in the panel for the reason this file exists: the risk on these
// screens is not the markup, it is a sentence that says something the ledger
// cannot defend.

export interface CommitmentView {
  id: string;
  title: string;
  kind: string;
  /**
   * The course this belongs to.
   *
   * `GET /plan` has always carried it — the endpoint spreads the stored
   * commitment — and this view never declared it, so the Plan drew every card
   * without saying which course the work was for. Optional because the front
   * door's due strip is handed the same shape and does not use it.
   */
  courseId?: string | null;
  dueAt: string;
  dueTime?: string | null;
  dueTimeZone?: string | null;
  recurrence?: {
    seriesId: string;
    index: number;
    total: number;
    cadence: 'weekly';
    timeZone: string;
    requestHash: string;
  } | null;
  plannedFor: string | null;
  estimateMinutes: number | null;
  doneAt: string | null;
  topicIds?: string[];
  notes?: string;
  /** As the service computed it: done / late / today / soon / later. */
  state: string;
}

export interface AwardView { points: number; reason: string }

export interface PlanView {
  commitments: CommitmentView[];
  points: number;
  stars: number;
  towardNextStar: number;
  recentAwards: AwardView[];
}

export interface BurstItemView {
  topicId: string; label: string; reason: string; prompt: string;
}

/** How many of the plan reach the front door. A prompt, not the room. */
export const DUE_SHOWN = 3;

const DAY = 86_400_000;
const dayStart = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);

/** The learner's calendar date at one instant. `formatToParts` avoids relying
 * on a locale's punctuation while still allowing DST and date-line changes to
 * be owned by the browser's timezone database. */
export function localDayKey(now: number, timeZone = localZone() || 'UTC'): string {
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(now));
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
    const year = get('year');
    const month = get('month');
    const day = get('day');
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch { /* fall back to UTC below */ }
  return new Date(now).toISOString().slice(0, 10);
}

export const hasTimedDeadline = (
  c: Pick<CommitmentView, 'dueAt' | 'dueTime' | 'dueTimeZone'>,
): c is Pick<CommitmentView, 'dueAt'> & { dueTime: string; dueTimeZone: string } => {
  if (typeof c.dueTime !== 'string' || !/^\d{2}:\d{2}$/.test(c.dueTime)
      || typeof c.dueTimeZone !== 'string' || c.dueTimeZone.length === 0
      || !Number.isFinite(Date.parse(c.dueAt))) return false;
  const [hour, minute] = c.dueTime.split(':').map(Number);
  return hour! >= 0 && hour! <= 23 && minute! >= 0 && minute! <= 59;
};

/** The source/learner-declared day, not the UTC date of a timed instant. */
export const commitmentDueDay = (
  c: Pick<CommitmentView, 'dueAt' | 'dueTime' | 'dueTimeZone'>,
): string => hasTimedDeadline(c)
  ? localDayKey(Date.parse(c.dueAt), c.dueTimeZone)
  : dayKey(c.dueAt);

const deadlineClock = (
  c: Pick<CommitmentView, 'dueAt' | 'dueTime' | 'dueTimeZone'>,
): string => {
  if (!hasTimedDeadline(c)) return '';
  try {
    return new Intl.DateTimeFormat('en', {
      timeZone: c.dueTimeZone, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(c.dueAt)).replace(/\b(AM|PM)\b/, (x) => x.toLowerCase());
  } catch { return c.dueTime; }
};

/**
 * When a thing is due, in the words a person uses.
 *
 * Days, never hours, and never a countdown. "In 4 days" is a fact; "3 days,
 * 14 hours remaining" is a pressure device, and this product does not have
 * those. Late is stated plainly and without a number of days attached — how
 * far behind somebody is is not information they can act on, and saying it is
 * just a way of saying it twice.
 */
export function dueLine(c: CommitmentView, now: number, timeZone?: string): string {
  if (c.doneAt) return 'done';
  const timed = hasTimedDeadline(c);
  const zone = timed ? c.dueTimeZone : timeZone;
  const clock = timed ? ` at ${deadlineClock(c)} ${c.dueTimeZone}` : '';
  if (timed && now > Date.parse(c.dueAt)) return `was due${clock}`;
  const days = Math.round((dayStart(commitmentDueDay(c)) - dayStart(localDayKey(now, zone))) / DAY);
  if (days < 0) return `was due${clock}`;
  if (days === 0) return `due today${clock}`;
  if (days === 1) return `due tomorrow${clock}`;
  if (days <= 14) return `due in ${days} days${clock}`;
  return `due ${commitmentDueDay(c)}${clock}`;
}

/** What a close just earned, said where it happened. */
export function awardLine(awarded: readonly AwardView[]): string {
  if (!awarded.length) return '';
  const points = awarded.reduce((n, a) => n + a.points, 0);
  const extras = awarded.filter((a) => a.reason !== 'closed').map((a) =>
    a.reason === 'on-time' ? 'on time' : a.reason === 'kept-promise' ? 'when you said you would' : a.reason);
  return extras.length ? `+${points}, ${extras.join(' and ')}` : `+${points}`;
}

/**
 * An empty plan, said as a state rather than as an achievement.
 *
 * Not "you're all caught up!" — a product that congratulates somebody for an
 * empty list is a product that wants the list to fill up again.
 */
export const nothingDueLine = (): string => 'Nothing with a date on it.';
/** Finished work is a record, so its empty state must not claim the whole plan
 * has no dated work while open cards are visible directly above it. */
export const nothingDoneLine = (): string => 'Nothing finished yet.';

export function burstOfferLine(count: number, minutes: number): string {
  const things = count === 1 ? 'one thing' : `${count} things`;
  return `${minutes} minutes on ${things} you have met before. No session, no reading.`;
}

/** Why this topic is in the burst. Named, because an unexplained prompt is a quiz. */
export function burstReasonLine(reason: string): string {
  if (reason === 'due') return 'spaced review says today';
  if (reason === 'flagged') return 'you asked to come back to this';
  return 'this is one of your least recently revisited topics';
}

/**
 * The stars, in a sentence.
 *
 * Stars are the only number this product shows about the learner's own effort,
 * and they are deliberately not a score: there is no total to protect, nothing
 * expires, and there is no comparison to anybody. The points behind them are
 * shown too — a star nobody can explain is a badge, and this product does not
 * ship badges nobody can check.
 */
export function starLine(stars: number, points: number): string {
  if (stars === 0) return `${points} points`;
  return `${stars} star${stars === 1 ? '' : 's'} · ${points} points`;
}


/** Now / This week / Ahead. Read-only projections of the service's state. */
export type PlanLaneKey = 'now' | 'week' | 'ahead';


export const PLAN_LANES: readonly { readonly key: PlanLaneKey; readonly heading: string }[] = [
  { key: 'now', heading: 'Now' },
  { key: 'week', heading: 'This week' },
  { key: 'ahead', heading: 'Ahead' },
];

/** What an empty lane says. A state, never an achievement, and never a zero. */
export const PLAN_LANE_EMPTY: Readonly<Record<PlanLaneKey, string>> = {
  now: 'Nothing is due today.',
  week: 'Nothing lands in the next week.',
  ahead: 'Nothing further out.',
};

/** The service's state, mapped onto the lane the learner reads it in. */
export function laneOf(state: string): PlanLaneKey {
  if (state === 'late' || state === 'today') return 'now';
  if (state === 'soon') return 'week';
  return 'ahead';
}

/**
 * The lanes, as projections. **Nothing drags between them.**
 *
 * A lane is where a date puts something, not a bucket somebody chose, so the
 * card cannot be moved from one to another — the only way into "This week" is
 * for the week to arrive. That is what makes this a plan rather than a kanban
 * board with dates written on it, and it is why the drop gesture on the
 * calendar sets `plannedFor` and never `dueAt`.
 *
 * The service owns the ordering (`orderCommitments`), and this preserves it.
 * The one decision taken here is inside **Now**, which merges two of the
 * service's states: `late` leads `today`. That is the lane's own question,
 * because the lane is the panel's invention.
 */
export function planLanes(
  commitments: readonly CommitmentView[],
): Record<PlanLaneKey, CommitmentView[]> {
  const lanes: Record<PlanLaneKey, CommitmentView[]> = { now: [], week: [], ahead: [] };
  for (const c of commitments) {
    if (c.doneAt) continue;
    lanes[laneOf(c.state)].push(c);
  }
  lanes.now = [
    ...lanes.now.filter((c) => c.state === 'late'),
    ...lanes.now.filter((c) => c.state !== 'late'),
  ];
  return lanes;
}

// ------------------------------------------------------------- the calendar

/** Three weeks: the one behind, this one, the one ahead. */
export const CALENDAR_WEEKS = 3;

/** Monday first, because a study week is not a Sunday week. */
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/**
 * Which day a stored instant belongs to.
 *
 * A deadline is stored as the calendar date the learner entered, so its own
 * key remains the ISO date prefix. What counts as today is different: the
 * browser supplies its IANA zone and `localDayKey` resolves the current instant
 * there. The service uses the same request context for lanes, ranking and
 * awards, so Sydney Friday cannot be rendered or scored as UTC Thursday.
 */
export const dayKey = (iso: string): string => iso.slice(0, 10);

/**
 * The Monday the three-week strip opens on: last week's, in learner-local days.
 *
 * A week that started on whatever day the learner opened the room would move
 * every deadline into a different column overnight, which is the one thing a
 * calendar may not do.
 */
export function calendarStart(now: number, timeZone?: string): string {
  const midnight = dayStart(localDayKey(now, timeZone));
  // `getUTCDay` is Sunday-first; the strip is Monday-first.
  const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  return new Date(midnight - (sinceMonday + 7) * DAY).toISOString().slice(0, 10);
}

export interface CalendarDay {
  readonly iso: string;
  /** The date, bare: "24". The month is on the week, not in every cell. */
  readonly date: string;
  readonly weekday: string;
  readonly today: boolean;
  /** 0 = last week (faint), 1 = this week, 2 = next week. */
  readonly week: number;
  /** Deadlines landing on this day. Somebody else's fact; drawn solid. */
  readonly due: readonly CommitmentView[];
  /** What the learner said they would do today. Their own; drawn lighter. */
  readonly planned: readonly CommitmentView[];
}

/**
 * Twenty-one days, each carrying the things on it.
 *
 * Open commitments only. A calendar of finished work is a record rather than a
 * plan, and the Done strip under the lanes is where the record lives.
 *
 * **No cell ever carries a number.** A day with four deadlines on it draws four
 * titles; the moment it draws "4" instead, the calendar has become the tally
 * SB-18 has kept out of every other room (Open Question 7's proposed bound,
 * ruled and accepted).
 */
export function calendarWeeks(
  commitments: readonly CommitmentView[], now: number, timeZone?: string,
): CalendarDay[][] {
  const start = Date.parse(`${calendarStart(now, timeZone)}T00:00:00.000Z`);
  const today = localDayKey(now, timeZone);
  const open = commitments.filter((c) => !c.doneAt);
  const weeks: CalendarDay[][] = [];
  for (let w = 0; w < CALENDAR_WEEKS; w += 1) {
    const days: CalendarDay[] = [];
    for (let d = 0; d < 7; d += 1) {
      const iso = new Date(start + (w * 7 + d) * DAY).toISOString().slice(0, 10);
      days.push({
        iso,
        date: iso.slice(8),
        weekday: WEEKDAYS[d]!,
        today: iso === today,
        week: w,
        due: open.filter((c) => commitmentDueDay(c) === iso),
        planned: open.filter((c) => c.plannedFor && dayKey(c.plannedFor) === iso),
      });
    }
    weeks.push(days);
  }
  return weeks;
}

/** Every day the strip is showing, which is also every day the keyboard
 *  day-picker offers. One list, so the two gestures cannot disagree. */
export const calendarDays = (now: number, timeZone?: string): string[] =>
  calendarWeeks([], now, timeZone).flat().map((d) => d.iso);

/**
 * What a card dropped on a day is allowed to change.
 *
 * **`plannedFor`, and nothing else, ever.** A due date is somebody else's fact
 * — a lecturer's deadline, a submission window — and a gesture that could drag
 * one is a gesture that lets a learner reschedule an exam by mistake. What the
 * drop moves is the promise they made themselves, which is the only date on a
 * commitment they own, and is the one `awardsForClosing` pays the kept-promise
 * award against. That is the whole point of the gesture.
 *
 * Returns null rather than throwing for a drop that carried no id or landed on
 * something that is not a day: the panel sends nothing and the card stays where
 * it was, which is what an unrecognised gesture should cost.
 */
export interface PlannedForWrite {
  readonly id: string;
  readonly body: { readonly plannedFor: string };
}

export function plannedForFromDrop(
  commitmentId: string | null | undefined, isoDay: string | null | undefined,
): PlannedForWrite | null {
  const id = (commitmentId ?? '').trim();
  const day = (isoDay ?? '').trim();
  if (!id) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  if (Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))) return null;
  return { id, body: { plannedFor: day } };
}

// ------------------------------------------------------------ the tutor line

/**
 * One line, and it is not a second hero.
 *
 * `GET /today` already decides the next move for the front door, and the Plan
 * asks the same question so the room reads as somebody tracking you rather than
 * as a list you maintain. It is a LINE — the title and the service's own first
 * reason — because a card here would be Today's card drawn twice, and two heroes
 * on two screens is how a product stops having a next move at all.
 *
 * The reason is rendered verbatim. When a recent assessed result reweighted the
 * thing `/today` chose, the reason already says so; inventing a second sentence
 * about it here would be the panel making a claim the service did not make.
 *
 * The separator is the house middot rather than the em-dash the ruling wrote
 * it with. `copy-style.test.ts` bans both dashes in every sentence this product
 * says, on the grounds that they are how a generator punctuates, and the middot
 * is what `starLine` and every other joined pair already use.
 */
export function tutorLine(title: string, reasons: readonly { text: string }[]): string {
  const what = (title ?? '').trim();
  if (!what) return '';
  const why = (reasons[0]?.text ?? '').trim();
  return why ? `${what} · ${why}` : what;
}


export const PLAN_SESSION_NOTE =
  'Lessons appear in Learn when they are ready.';

// ------------------------------------------------------- the card's own menu

export type PlanAddRouteKey = 'dated' | 'result';

/**
 * The two ways into the Plan, behind Add.
 *
 * The same inversion My studies took (SB-80): a room whose first screen is a
 * form is a data-entry surface, and this one is meant to help somebody manage
 * what they already agreed to. `dated` is the SAME `commitmentForm` My studies
 * mounts, course picker included — one form, two sheets, because "something
 * with a date" is one question.
 */
export const PLAN_ADD_ROUTES: readonly { readonly key: PlanAddRouteKey; readonly label: string }[] = [
  { key: 'dated', label: 'Something with a date' },
  { key: 'result', label: 'Record a result' },
];

export const PLAN_MENU = 'More';
export const MOVE_TO_A_DAY = 'Move to a day';
export const MOVE_TO_DAY_FIELD = 'When will you do it?';
export const MOVE_TO_DAY_SAVE = 'Move it';
export const REMOVE_PLANNED_DAY = 'Remove planned day';
export const CHANGE_THE_DATE = 'Change the date';
/**
 * The one sentence this menu was missing.
 *
 * The promise and the deadline are the product's whole idea, and this menu is
 * the only place a learner meets both of them at once: one control writes
 * `plannedFor`, which is a note to herself and what the kept-promise award is
 * paid against, and the other writes `dueAt`, which is usually a fact somebody
 * else set. The `<p class="note">` that would say so was rendered empty on
 * every card, so the two controls read as two words for the same thing and the
 * safer-looking one silently rewrote a deadline.
 */
export const PLAN_MENU_NOTE =
  'Moving it says when you plan to do it; removing that plan keeps the work and its deadline; changing the date moves the deadline itself, which is usually somebody else’s.';
export const SAVE_THE_DATE = 'Save the date';
export const ONLY_THIS_DATE = 'Only this date';
export const THIS_AND_LATER = 'This and later';
export const SKIP_THIS_DATE = 'Skip this date';
export const STOP_THIS_AND_LATER = 'Stop this and later';

export function recurrenceLine(c: Pick<CommitmentView, 'recurrence'>): string {
  const r = c.recurrence;
  if (!r || r.cadence !== 'weekly' || !Number.isInteger(r.index)
      || !Number.isInteger(r.total) || r.index < 0 || r.total < 2 || r.total > 20
      || r.index >= r.total) return '';
  return `Weekly · ${r.index + 1} of ${r.total}.`;
}

/** Dates for the Add preview. This is calendar arithmetic only; the service
 * remains authoritative for resolving an optional wall time through IANA. */
export function weeklyPreviewDates(start: string, count: number): readonly string[] {
  const match = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(start);
  if (!match || !Number.isInteger(count) || count < 2 || count > 20) return [];
  const anchor = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const check = new Date(anchor);
  if (check.getUTCFullYear() !== Number(match[1])
      || check.getUTCMonth() !== Number(match[2]) - 1
      || check.getUTCDate() !== Number(match[3])) return [];
  return Array.from({ length: count }, (_, index) =>
    new Date(anchor + index * 7 * 86_400_000).toISOString().slice(0, 10));
}

/**
 * LINKING WORK TO WHAT IT LEANS ON.
 *
 * `Commitment.topicIds` is described in its own file as *"the link that makes
 * teaching deadline-aware, and the reason a task manager is worth building
 * inside a learning product rather than beside one"*, and until 2026-08-24
 * nothing anywhere wrote it. The form posted four fields, the card menu offered
 * four actions and none of them was this, and every commitment on a live board
 * carried an empty array. So a deadline could not pull its own subjects
 * forward, and the button on the biggest piece of work in somebody's week had
 * nowhere to send them but a list.
 *
 * The words avoid "topic" as a label on its own, because the learner does not
 * call it that: they call it what they are studying, and the board is where
 * they have seen it.
 */
export const LINK_TO_TOPICS = 'Link it to what you are studying';
/** A linked card is editing an existing relationship, not making one anew. */
export const CHANGE_STUDY_LINK = 'Change what it is linked to';
export const LINK_TO_TOPICS_NOTE =
  'Pick what this leans on and Virgil teaches those things first as the date gets closer.';
export const LINK_TO_TOPICS_SAVE = 'Save the links';
export const LINK_TO_TOPICS_FAILED = 'That did not go through. The links are as they were.';
/** On the add form, where it is one optional question among four. */
export const LINK_TO_TOPICS_FIELD = 'What it leans on <em>(optional)</em>';
/**
 * The other half of the same question, on the card's own menu.
 *
 * Named for the relationship rather than for the field: a learner does not
 * think of an essay as having a `courseId`, they think of it as being part of
 * something they are studying. It is what puts the subject beside a lesson on
 * tonight's lineup, which is the whole reason this became settable.
 */
export const LINK_TO_COURSE_FIELD = 'Part of <em>(optional)</em>';

/**
 * What a card says about what it is linked to, or says nothing at all.
 *
 * Written back on the card because a field somebody can set is a field they
 * have to be able to see: a link that is stored and never shown is one nobody
 * can tell they made, or correct. Ids the board no longer has are dropped
 * rather than printed raw.
 */
export function linkedTopicsLine(
  topicIds: readonly string[] | undefined,
  label: (id: string) => string | undefined,
): string {
  const named = (topicIds ?? []).map((id) => label(id)).filter((x): x is string => !!x);
  if (!named.length) return '';
  const last = named[named.length - 1] as string;
  const joined = named.length === 1 ? last : `${named.slice(0, -1).join(', ')} and ${last}`;
  return `Leans on ${joined}.`;
}
export const REOPEN_ACTION = 'Reopen';
export const DELETE_ACTION = 'Delete';
/** Two steps, and the sentence says what survives. Nothing in the award ledger
 *  is rewound by a delete — an award is a record of a moment. */
export const DELETE_CONFIRM = 'This goes for good. What it earned stays where it is.';
export const DELETE_CONFIRM_ACTION = 'Delete it';
export const KEEP_IT = 'Keep it';
export const PLAN_DONE_HEADING = 'Done';

/** What a card says about itself, in the order it is read: what it is, whose
 *  course it belongs to, when it is due, how long it was going to take. */
export function estimateLine(minutes: number | null | undefined): string {
  return typeof minutes === 'number' && minutes > 0 ? `${minutes} min` : '';
}

/** When the learner said they would do it, said on the card rather than only
 *  drawn on the calendar — the card is where they are looking when they tick. */
export function plannedLine(
  plannedFor: string | null | undefined, now: number, timeZone?: string,
): string {
  if (!plannedFor) return '';
  const day = dayKey(plannedFor);
  const today = localDayKey(now, timeZone);
  if (day === today) return 'you said today';
  const days = Math.round(
    (Date.parse(`${day}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / DAY);
  if (days === 1) return 'you said tomorrow';
  if (days < 0) return 'you said earlier';
  if (days <= 14) return `you said in ${days} days`;
  return `you said ${day}`;
}

/**
 * The contradiction the card used to print without noticing.
 *
 * "due today" and "you said tomorrow" sat side by side in silence, which is the
 * one moment in the loop where the product knows something about the learner
 * that she has not admitted to herself. So it says it, once, quietly, beside
 * the two facts it is about.
 *
 * What it deliberately is not: a block, a refusal, or a telling-off. The move
 * is accepted, the card does not change lane, and there is no colour on it. A
 * learner is allowed to plan work after its deadline — she may already know
 * something about an extension that this product does not — and the only thing
 * missing was that anybody said the two dates disagree.
 *
 * Empty on a closed commitment: the promise is spent, and pointing at a
 * deadline somebody has already met is the punishment register by the back
 * door.
 */
export function plannedAfterDueLine(
  c: Pick<CommitmentView, 'dueAt' | 'plannedFor' | 'doneAt'>,
): string {
  if (c.doneAt || !c.plannedFor) return '';
  const promised = dayKey(c.plannedFor);
  const due = commitmentDueDay(c);
  if (!promised || !due || promised <= due) return '';
  return 'That is after it is due.';
}


/**
 * The named kinds of material, in the order a course lists them.
 *
 * Videos first because that is what a self-taught course is mostly made of,
 * classes second because a class is the thing with a time attached, and
 * "Other" last and only when something is in it. A group with nothing in it is
 * not drawn: an empty heading is a promise the course did not keep.
 */
export const MATERIAL_GROUPS: readonly { readonly kind: string; readonly label: string }[] = [
  { kind: 'video', label: 'Videos' },
  { kind: 'class', label: 'Classes' },
  { kind: 'reading', label: 'Readings' },
  { kind: 'exercise', label: 'Exercises' },
  { kind: 'other', label: 'Other' },
];

/**
 * Material, grouped the way it is read rather than the way it was added.
 *
 * A flat list of fourteen rows is a bookmark file. The kind is already on every
 * row (`data-kind`) and was already carried by the service — it was simply
 * never used to lay anything out. Anything with a kind this product does not
 * name falls into "Other" rather than into a group of its own, so a store
 * written by a newer version cannot invent a heading here.
 */
export function groupMaterial<T extends { kind: string }>(
  material: readonly T[],
): { kind: string; label: string; items: T[] }[] {
  const known = new Set(MATERIAL_GROUPS.map((g) => g.kind));
  return MATERIAL_GROUPS
    .map((g) => ({
      ...g,
      items: material.filter((m) => (known.has(m.kind) ? m.kind : 'other') === g.kind),
    }))
    .filter((g) => g.items.length > 0);
}

/** What a course is about to get through next, said as a fact and not a nudge. */
export function nextUpLine(title: string): string {
  return `Next up · ${title}`;
}

/**
 * The five ways into this room, behind one control.
 *
 * The room used to open with three forms stacked above the first course, so the
 * first thing a learner saw was data entry for things they had already entered.
 * Results later moved here from Plan, where the learner can read and correct
 * them, so their shared capture form belongs behind this Add door too. Plan
 * retains the useful post-tick shortcut; this is the later grade/feedback door.
 * The order is how often somebody reaches for each route.
 */
export type AddRouteKey = 'syllabus' | 'course' | 'material' | 'dated' | 'result';

export const ADD_ROUTES: readonly { readonly key: AddRouteKey; readonly label: string }[] = [
  { key: 'syllabus', label: 'Syllabus or brief' },
  { key: 'course', label: 'Course' },
  { key: 'material', label: 'Material' },
  { key: 'dated', label: 'Something with a date' },
  { key: 'result', label: 'Record a result' },
];

/**
 * The room's other two reads, and what it says when one of them does not answer.
 *
 * `/courses` failing takes the whole room down with one honest line, which is
 * right: there is nothing left to draw. `/outcomes` and `/course-intakes`
 * failing used to take nothing down at all. Both were read through `?? []`, and
 * an empty list of results is drawn by drawing no Results section — so a
 * learner whose grades could not be read was shown a course card with no
 * results on it, which is this product telling them they have recorded none.
 * The one thing the room exists to show, reported as absence because a read
 * failed. Ana's 2026-08-24 blocker was a grade that appeared nowhere; this is
 * the same blocker with a network fault standing in for a missing section.
 *
 * Same law as `boardPinsUnreadableLine`, in the two other places it was being
 * broken: "you have recorded nothing" and "I could not look" are different
 * claims about somebody's own work, and only the second one is true here. Both
 * end in the clause that matters — nothing has been lost — because a failed
 * read has not touched a single thing the learner recorded.
 */
export function resultsUnreadableLine(): string {
  return 'I could not read your results just now. Nothing has been lost; open this again in a moment.';
}

export function draftsUnreadableLine(): string {
  return 'I could not read what is waiting for your eye just now. '
    + 'Nothing has been lost; open this again in a moment.';
}

// -------------------------------------------------------- the assignment QC

export interface CriterionRowView {
  criterionId: string;
  criterion: string;
  verdict: string;
  evidence: string;
  /** Optional for service compatibility; absence means the legacy quote view. */
  evidenceKind?: 'quote' | 'absence' | 'none';
  fix: string | null;
  relatedTopicId: string | null;
  relatedTopicLabel: string | null;
}

/**
 * A line the service held back, and which box it came out of.
 *
 * `source` arrived with the third box. Before it there was one place a brief
 * could carry an instruction aimed at the model, so "the criteria you pasted"
 * was a safe thing for the copy to say; there are two now, and a screen that
 * told somebody to look at their criteria for a line that was in their context
 * would be sending them to the wrong paste. Optional, and read as `'rubric'`
 * when absent, because an older service does not send it.
 */
export interface QuarantinedLineView {
  text: string;
  patterns: string[];
  source?: 'rubric' | 'context';
}

export interface MarkView {
  outcome: string;
  verdict: string;
  summary: string;
  rows: CriterionRowView[];
  quarantined: QuarantinedLineView[];
  truncated: boolean;
  contextTruncated?: boolean;
}

/** The reviewer's half of the same answer. `truncated` and `contextTruncated`
 *  are new on this endpoint: a draft over the cap used to be cut in silence. */
export interface ReviewView {
  outcome: string;
  findings: FindingView[];
  /** Optional for compatibility with services predating the basis receipt. */
  weakTopicCount?: number;
  truncated?: boolean;
  contextTruncated?: boolean;
  quarantined?: QuarantinedLineView[];
}

/**
 * The three labels on the Check screen, and the room's own title.
 *
 * Short noun phrases, all four of them. The title is the door's words exactly:
 * a room reached by pressing "Check" and headed "Check something before you
 * send it" is two names for one place, and the learner has to work out that
 * they are the same place. SB-279 shortened the door to the one word the top
 * bar has room for; the title went with it rather than staying behind as a
 * second name for the same room.
 */
export const CHECK_TITLE = 'Check';
export const DRAFT_LABEL = 'Your work';
export const RUBRIC_LABEL = 'Marking criteria';

/** The sentence the draft label used to be. It says what may go in the box,
 *  which is more than the old question did: the question asked, and this
 *  answers. */
export const draftWhyLine = (): string =>
  'Whatever you are about to hand in or send. Paste it, or drop the file on the box.';

/** Why the second box is worth filling in, said once and without pressure. */
export const rubricWhyLine = (): string =>
  'With these, I mark it one criterion at a time and tell you which ones it misses. Without them, I review clarity and reasoning, using any evidence-backed weak areas from your board.';

/** What actually personalised a completed criteria-free review. An older
 * service omits the count, and omission stays omission rather than becoming a
 * made-up general or personalised claim. */
export function reviewBasisLine(weakTopicCount: number | undefined): string | null {
  if (!Number.isInteger(weakTopicCount) || (weakTopicCount ?? -1) < 0) return null;
  if (weakTopicCount === 0) {
    return 'Your board has no evidence-backed weak areas yet, so this check focused on clarity and reasoning.';
  }
  const weak = weakTopicCount === 1
    ? 'one evidence-backed weak area'
    : `${n(weakTopicCount!)} evidence-backed weak areas`;
  return `This check covered clarity and reasoning, including ${weak} from your board.`;
}

export const rubricLimitLine = (limits: CheckLimitsView): string =>
  `Up to ${n(limits.rubricCriteria)} criteria, ${n(limits.rubricCriterionChars)} Unicode characters each. Every accepted criterion is marked whole.`;

const RUBRIC_BULLET = /^\s*(?:[-*•‣]|\(?\d{1,2}[.)]|[a-z][.)]|criterion\s+\d{1,2}\s*[:.]?)\s+/i;

export function rubricRefusal(rubric: string, limits: CheckLimitsView): string | null {
  const rows = rubric.split(/\r?\n/)
    .map((raw) => raw.replace(RUBRIC_BULLET, '').trim())
    .filter((line) => line.length >= 12 && !/^[^.?!]{0,60}:$/.test(line));
  const oversized = rows.find((line) => Array.from(line).length > limits.rubricCriterionChars);
  if (oversized) {
    return `Keep each criterion to ${n(limits.rubricCriterionChars)} characters. Your rubric is still here and nothing was sent.`;
  }
  if (rows.length > limits.rubricCriteria) {
    return `Keep this check to ${n(limits.rubricCriteria)} criteria. Your rubric is still here and nothing was sent.`;
  }
  return null;
}

/**
 * The verdict, in the words a marker would use.
 *
 * "Send it back" rather than "fail", because it is the learner's own work and
 * they have not handed it in yet — the whole point of doing this before rather
 * than after. And no number: a score on work that misses a criterion is the
 * comfortable lie this product exists not to tell.
 */
export const markVerdictLine = (verdict: string): string =>
  verdict === 'clear' ? 'Nothing here misses a criterion.' : 'I would not send this yet.';

/**
 * The service summary may begin with the same complete sentence as the local
 * clear verdict. Keep the service's caution, but do not make the interface say
 * the outcome twice. A summary that contains only the sentence remains whole.
 */
export function markSummaryDetail(verdict: string, summary: string): string {
  if (verdict !== 'clear') return summary;
  const verdictLine = markVerdictLine(verdict);
  if (!summary.startsWith(verdictLine)) return summary;
  return summary.slice(verdictLine.length).trim() || summary;
}

export function criterionVerdictLine(verdict: string): string {
  if (verdict === 'meets') return 'met';
  if (verdict === 'partial') return 'partly met';
  if (verdict === 'does-not-meet') return 'not met';
  // Never "met by default". A criterion nobody read is a gap in the mark, and
  // saying so is the difference between a QC and a compliment.
  return 'I could not read a verdict on this one';
}

export const markRelatedLine = (label: string): string =>
  `This is the same ground as "${label}", which your board says is still shaky.`;

export const markFailedLine = (): string =>
  'That check did not run, so I have not read your work. Nothing about it is known either way.';

export const markTruncatedLine = (): string =>
  'This is longer than I can read in one go, so I marked the start of it. What is below that has not been looked at.';

export const markTooShortLine = (): string =>
  'Add more of the draft (at least 200 characters), or attach its pages, then check again.';

/** The return route at the foot of a long check result. */
export const BACK_TO_DRAFT = 'Back to my draft';
/** A visible result stops being current as soon as any part of its input moves. */
export const CHECK_RESULT_STALE = 'This result is from before your changes. Check it again when you’re ready.';

export function quarantineLine(n: number, source: 'rubric' | 'context' = 'rubric'): string {
  const lines = n === 1 ? 'One line' : `${n} lines`;
  const them = n === 1 ? 'it' : 'them';
  const where = source === 'context' ? 'the context you gave me' : 'the criteria you pasted';
  return `${lines} in ${where} told me what to conclude rather than what to check, so I have not used ${them}:`;
}

/**
 * Which box a held-back line came out of, grouped so the screen can say it.
 *
 * Two small blocks that each name their paste beat one block that names
 * neither. Ordered rubric first because that is the box further up the screen,
 * and a learner reading downward should meet the notes in the order of the
 * things they are about.
 */
export function quarantineGroups(
  lines: readonly QuarantinedLineView[] | null | undefined,
): { source: 'rubric' | 'context'; lines: QuarantinedLineView[] }[] {
  const out: { source: 'rubric' | 'context'; lines: QuarantinedLineView[] }[] = [];
  for (const source of ['rubric', 'context'] as const) {
    const mine = (lines ?? []).filter((l) => (l.source ?? 'rubric') === source);
    if (mine.length) out.push({ source, lines: mine });
  }
  return out;
}

// ---------------------------------------------------- the third box: context


export const CONTEXT_LABEL = 'Extra context';

export const contextWhyLine = (): string =>
  'Add anything else you would like me to know. The brief, what your marker said last time, anything you were told to do. I read it as background, never as part of the work.';

export const CONTEXT_PLACEHOLDER = 'Optional.';

// ------------------------------------------------------ dropping a file in


export const UPLOAD_ACTION = 'Upload a file';

export const uploadHowLine = (includeImages = false): string => includeImages
  ? 'Drop a document or screenshot here, or pick one. A PDF, PNG or JPEG goes as pictures. Text and Word files land in the box for you to read before anything is sent.'
  : 'Drop a .txt, .md, .docx or .pdf here, or pick one. A PDF goes as its pages, exactly as they are. Anything else lands in the box for you to read before anything is sent.';

/** A PDF of any size takes a moment, and a control that looks like it did
 *  nothing gets pressed again. */
export const READING_FILE = 'Reading it…';

/** The same, for the slower of the two routes: rasterising twenty pages is
 *  seconds rather than milliseconds, and a silent control gets pressed twice. */
export const RENDERING_PAGES = 'Getting the pages ready…';

/** The name, cut so a pathological filename cannot become the sentence. */
const shortName = (name: string): string => {
  const clean = name.replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean;
};

const FORMAT_WORD: Record<UploadFormat, string> = {
  text: 'text file', docx: 'Word document', pdf: 'PDF',
};

/** Megabytes, the way a person says them. */
const mb = (bytes: number): string => `${Math.round(bytes / 100_000) / 10}MB`;

/**
 * What reading a file came to, in one sentence.
 *
 * Every branch says what happened AND that the box is untouched, because the
 * failure this is written against is the silent one: a learner drops a scanned
 * PDF, nothing appears, and they press the button on an empty box believing
 * their essay went with it. There is no branch here that says nothing.
 */
export function uploadOutcomeLine(outcome: UploadOutcome, fileName: string): string | null {
  const name = shortName(fileName);
  switch (outcome.kind) {
    case 'text':
      return `Read ${name} into the box. Check it before you send it, and change anything that came through wrong.`;
    case 'unsupported':
      return `I can read .txt, .md, .docx and .pdf. ${name} is none of those, so I have not touched the box.`;
    case 'too-big':
      return `${name} is bigger than ${mb(outcome.capBytes)}, which is more than I will open. Nothing has gone into the box.`;
    case 'no-text':
      // The PDF branch used to end here, and it ended nowhere: "there is
      // nothing in it for me to lift out" is true and leaves the learner
      // holding a scan and no next move. There is a next move now, and it is
      // the better one anyway.
      return outcome.format === 'pdf'
        ? `There is no text in ${name} for me to lift out. It looks like scanned pages, so send it as its pages instead.`
        : `There is no text in ${name} that I can find. Nothing has gone into the box.`;
    default:
      return `I couldn't open ${name} as a ${FORMAT_WORD[outcome.format]}. Nothing has gone into the box.`;
  }
}

// ------------------------------------------ the file that goes as it stands


/** The chip's own sentence: what is attached, and how much of it. */
export const attachedPagesLine = (
  fileName: string, pages: number, kind: 'pdf' | 'image' = 'pdf',
): string => kind === 'image'
  ? `${shortName(fileName)}, 1 image. I send it as a picture.`
  : `${shortName(fileName)}, ${pages === 1 ? '1 page' : `${pages} pages`}. I send the pages as they are.`;

/** The second route, offered on the chip rather than asked for up front. */
export const READ_TEXT_INSTEAD = 'Read the text in instead';

/** Taking it off again. Not "remove": the learner attached a thing, and this
 *  is the plain word for undoing that. */
export const REMOVE_ATTACHMENT = 'Take it off';

/**
 * Why the pages are not on the character meter.
 *
 * The meter counts what goes in the boxes and pages are not characters. Saying
 * nothing would be the safer-looking choice and the wrong one: a learner who
 * has attached twelve pages and sees a meter reading zero should be told which
 * of the two facts the meter is about.
 */
export const attachedMeterNote = (
  pages: number, kind: 'pdf' | 'image' = 'pdf',
): string => kind === 'image'
  ? 'The image goes as a picture, so it does not count towards the characters below.'
  : pages === 1
    ? 'The page goes as a picture, so it does not count towards the characters below.'
    : `The ${pages} pages go as pictures, so they do not count towards the characters below.`;

/**
 * What rendering the pages came to, when it did not.
 *
 * Same rule as `uploadOutcomeLine`: every branch says what happened AND that
 * nothing is attached, because the failure worth writing against is the silent
 * one where somebody presses Check believing their essay went with it.
 */
export function pagesOutcomeLine(outcome: PagesOutcome, fileName: string): string | null {
  const name = shortName(fileName);
  switch (outcome.kind) {
    case 'pages':
      return null;
    case 'unsupported':
      return `Only a PDF, PNG or JPEG can go as pictures. ${name} is not one, so nothing is attached.`;
    case 'too-big':
      return `${name} is bigger than ${mb(outcome.capBytes)}, which is more than I will open. Nothing is attached.`;
    case 'too-many-pages':
      return `${name} is ${outcome.pageCount} pages, and I send at most ${outcome.capPages} at a time. Nothing is attached. Send the part you want looked at as its own file.`;
    case 'page-failed':
      // Not nineteen pages of a twenty page essay. A partial submission marked
      // as a whole one is the failure this screen exists to prevent.
      return `Page ${outcome.page} of ${name} would not draw, so I have attached none of it. A piece of work with a page missing is not the piece of work.`;
    default:
      return outcome.format === 'image'
        ? `I couldn't open ${name} as an image. Nothing is attached.`
        : `I couldn't open ${name} as a PDF. Nothing is attached.`;
  }
}

/** The learner asked for the text and there was none. The pages stay clipped
 *  on, because throwing them away would leave them with nothing at all. */
export const noTextKeptPagesLine = (fileName: string): string =>
  `There is no text in ${shortName(fileName)} for me to lift out, so I have left the pages attached. That is what works for a scan.`;

// ------------------------------------- the criteria box, which needs the rows

/**
 * Why a rubric never rides as pictures, said where the learner meets it.
 *
 * The structured-criteria contract: the criteria are split out of the pasted text in code, verbatim,
 * one row per line, and every one of them gets a row in the mark whether the
 * model noticed it or not. That is the property that makes this a QC rather
 * than an opinion, and it needs text. So a scanned rubric is offered the one
 * honest route: the pages are read, the words are typed into the box, and the
 * learner checks them before anything is marked against them.
 */
export const scannedRubricLine = (fileName: string): string =>
  `There is no text in ${shortName(fileName)} for me to lift out. I mark one criterion at a time, so I need these as words rather than as a picture.`;

/**
 * Repair document layout before imported criteria reach the editable box.
 *
 * PDF text layers report physical baselines, not semantic paragraphs. In the
 * real B3 dogfood path that made a four-item marking sheet into six criteria:
 * the document title became one row and a wrapped criterion became two. The
 * service parser cannot fix that safely because a learner is also allowed to
 * type one plain criterion per line, with no list furniture at all.
 *
 * This repair is deliberately narrower: the panel calls it only for file or
 * transcription intake, and it activates only when one explicit list family
 * repeats at least twice. Without that evidence the extraction is returned
 * unchanged. The output still goes into the visible textarea for the learner
 * to correct before anything is sent.
 */
export function repairImportedRubric(text: string): string {
  const lines = String(text ?? '').split(/\r?\n/);
  type Family = 'number' | 'criterion' | 'alpha' | 'bullet';
  const patterns: Readonly<Record<Family, RegExp>> = {
    number: /^\s*\(?\d{1,2}[.)]\s*/,
    criterion: /^\s*criterion\s+\d{1,2}\s*[:.]?\s*/i,
    alpha: /^\s*[a-z][.)]\s+/i,
    bullet: /^\s*[-*•‣]\s+/,
  };
  // Numeric/labelled lists outrank bullets: bullets beneath a numbered item
  // are supporting detail, not a reason to split the provider's criterion.
  const family = (['number', 'criterion', 'alpha', 'bullet'] as const)
    .find((kind) => lines.filter((line) => patterns[kind].test(line)).length >= 2);
  if (!family) return text;

  const rows: string[] = [];
  let current = '';
  let started = false;
  const flush = (): void => {
    const row = current.replace(/\s+/g, ' ').trim();
    if (row) rows.push(row);
    current = '';
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (patterns[family].test(raw)) {
      if (started) flush();
      started = true;
      current = raw.replace(patterns[family], '').trim();
      continue;
    }
    if (!started || !line) continue;
    // A clear following section is not the tail of the final criterion. This
    // is intentionally cheap and conservative; ordinary prose stays attached.
    if (/^[^.?!]{1,80}:$/.test(line) || (/^[A-Z\d &/()-]{4,80}$/.test(line) && !/[.?!]$/.test(line))) {
      flush();
      break;
    }
    current += `${current ? ' ' : ''}${line}`;
  }
  flush();
  return rows.length >= 2 ? rows.join('\n') : text;
}

/** `POST /transcribe-pages`, as the service answers it. `outcome` exists for
 *  the same reason it exists on `/review`: an empty string from a failed call
 *  and an empty string from a blank page are the same value on the wire. */
export interface TranscribeView {
  outcome?: string;
  text?: string;
  pageCount?: number;
}

export const TRANSCRIBE_ACTION = 'Read the pages and type them out';

export const TRANSCRIBING_PAGES = 'Reading the pages and typing them out…';

export const TRANSCRIBING_SOURCE_IMAGE = 'Reading the image and typing it into the source box…';

/** A picture used as course evidence becomes visible, editable text before it
 * can become an import proposal. This copy deliberately does not mention Check
 * or criteria: the same bounded Transcriber is serving a different human act. */
export function sourceImageTranscriptionLine(outcome: string): string {
  if (outcome === 'transcribed') {
    return 'I read the image and typed it into the source box. Check the words against the picture before you review the import.';
  }
  if (outcome === 'nothing-found') {
    return 'I could not find any words in that image. Nothing has gone into the source box.';
  }
  if (outcome === 'budget-stopped') {
    return `${BUDGET_STOPPED_LINE} Nothing has gone into the source box.`;
  }
  if (outcome === 'credential-missing') {
    return 'The Images connection has no key saved. Nothing has gone into the source box. Open Models to finish that connection.';
  }
  return 'I could not read that image just now. Nothing has gone into the source box.';
}

/** Local decode happens before the Transcriber. Its failures name the selected
 * source box rather than borrowing Check's attachment language. */
export function sourceImageReadLine(outcome: PagesOutcome, fileName: string): string | null {
  const name = shortName(fileName);
  switch (outcome.kind) {
    case 'pages': return null;
    case 'too-big':
      return `${name} is bigger than ${mb(outcome.capBytes)}, which is more than I will open. Nothing has gone into the source box.`;
    default:
      return `I could not open ${name} as an image. Nothing has gone into the source box.`;
  }
}

/**
 * What came back from that, in one sentence.
 *
 * The success case is the one that has to carry a warning, and it is the same
 * warning the whole upload path carries: this is proposed, never imposed. A
 * transcription is a model's reading of a photograph, and it is about to become
 * the bar the learner's own work is marked against. They are the last check.
 */
export function transcribeOutcomeLine(outcome: string, pages: number): string {
  if (outcome === 'transcribed') {
    return `I read ${pages === 1 ? 'the page' : `all ${pages} pages`} and typed them into the box. Read them against the paper before you press Check, because I mark against exactly what is in there.`;
  }
  if (outcome === 'nothing-found') {
    return 'I read the pages and could not find any words on them. Nothing has gone into the box.';
  }
  // A budget stop is not a transcription that failed, and the difference is
  // where it sends somebody: one is a limit they set, the other is an API key.
  if (outcome === 'budget-stopped') {
    return `${BUDGET_STOPPED_LINE} Nothing has gone into the box, and your criteria are where you left them.`;
  }
  // The API key the comment above was already pointing at. It has a status of
  // its own now, so it gets the sentence it was owed rather than the generic
  // "that did not run".
  if (outcome === 'credential-missing') {
    return `${CREDENTIAL_MISSING_SHORT} Nothing has gone into the box, and your criteria are where you left them.`;
  }
  return 'That did not run, so nothing has gone into the box. Your criteria are where you left them.';
}

// ----------------------------------------------------------- the size meter

/**
 * What a paste may be, as the service says it.
 *
 * These are characters and they are the product's own caps, so they apply on
 * every connection. The fallback numbers are the ones the service ships today;
 * they exist so that a `/model-config` that did not answer produces a meter
 * that is slightly stale rather than a meter that crashes or, worse, one that
 * silently stops warning.
 */
export interface CheckLimitsView {
  readonly markWorkChars: number;
  readonly reviewDraftChars: number;
  readonly markWorkMinChars: number;
  readonly reviewDraftMinChars: number;
  readonly contextChars: number;
  readonly rubricCriteria: number;
  readonly rubricCriterionChars: number;
}

export const CHECK_LIMITS_FALLBACK: CheckLimitsView = {
  markWorkChars: 12_000,
  reviewDraftChars: 6_000,
  markWorkMinChars: 200,
  reviewDraftMinChars: 80,
  contextChars: 4_000,
  rubricCriteria: 24,
  rubricCriterionChars: 400,
};

const positive = (value: unknown, fallback: number): number =>
  (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);

/** Defensive in the same way `modelConfigFrom` is: a null, a string or a zero
 *  in any field falls back to the shipped number rather than to a meter that
 *  warns about everything or about nothing. */
export function checkLimitsFrom(raw: Partial<CheckLimitsView> | null | undefined): CheckLimitsView {
  return {
    markWorkChars: positive(raw?.markWorkChars, CHECK_LIMITS_FALLBACK.markWorkChars),
    reviewDraftChars: positive(raw?.reviewDraftChars, CHECK_LIMITS_FALLBACK.reviewDraftChars),
    markWorkMinChars: positive(raw?.markWorkMinChars, CHECK_LIMITS_FALLBACK.markWorkMinChars),
    reviewDraftMinChars: positive(raw?.reviewDraftMinChars, CHECK_LIMITS_FALLBACK.reviewDraftMinChars),
    contextChars: positive(raw?.contextChars, CHECK_LIMITS_FALLBACK.contextChars),
    rubricCriteria: positive(raw?.rubricCriteria, CHECK_LIMITS_FALLBACK.rubricCriteria),
    rubricCriterionChars: positive(raw?.rubricCriterionChars, CHECK_LIMITS_FALLBACK.rubricCriterionChars),
  };
}

/** The point at which a length is worth a word. Below it the screen says
 *  nothing, because a counter under an empty box is a form telling somebody
 *  off in advance. */
export const SIZE_WARN_AT = 0.8;

const n = (value: number): string => Math.round(value).toLocaleString('en-US');

/**
 * The one number the learner needs, and what happens past it.
 *
 * Nothing until 80% of a cap, because this product counts nothing it does not
 * have to. Past the cap the sentence gets firmer and the button stays live:
 * the work is theirs and a check of the first 12,000 characters is still worth
 * having, as long as nobody is told it was a check of all of it.
 *
 * The draft's cap depends on the OTHER box: with criteria it is marked
 * (12,000), without them it is reviewed (6,000). That is why this takes a cap
 * rather than reading one.
 */
export function sizeWarningLine(
  box: 'draft' | 'rubric' | 'context', chars: number, cap: number,
): string | null {
  if (cap <= 0 || chars < cap * SIZE_WARN_AT) return null;
  const over = chars > cap;
  if (box === 'draft') {
    return over
      ? `That is ${n(chars)} characters. I read the first ${n(cap)} and tell you where I stopped. What is below that is not looked at.`
      : `That is ${n(chars)} characters of ${n(cap)}. Past ${n(cap)} I read the first ${n(cap)} and tell you I stopped.`;
  }
  if (box === 'context') {
    return over
      ? `That is ${n(chars)} characters of context. I read the first ${n(cap)} and never see the rest.`
      : `That is ${n(chars)} characters of ${n(cap)}. Past ${n(cap)} I never see the rest.`;
  }
  return over
    ? `That is more criteria than I take. I read up to ${n(cap)} characters of them, so the ones at the bottom may not be marked against.`
    : `That is ${n(chars)} characters of criteria. I read up to ${n(cap)}, and each criterion has a length of its own, so keep them one per line and short.`;
}

/**
 * The cap the rubric box is measured against, and why it is a soft one.
 *
 * The service's rubric limits are per criterion — up to 24 of them, up to 400
 * characters each — and the box holds one string. There is no honest way to
 * turn that into a hard number for a paste, so the product of the two is used
 * as a *signal* and the sentence says what the real shape of the rule is
 * instead of pretending the box has a character limit.
 */
export const rubricSoftCap = (limits: CheckLimitsView): number =>
  limits.rubricCriteria * limits.rubricCriterionChars;

/** Which cap the draft is under, which is decided by whether the other box has
 *  anything in it. Recomputed on every keystroke in either. */
export const draftCap = (limits: CheckLimitsView, hasRubric: boolean): number =>
  (hasRubric ? limits.markWorkChars : limits.reviewDraftChars);

// -------------------------------------------------- the exact Check hand-off

/** The state that becomes one `/review` or `/mark` request. Kept scalar here
 *  so the copy helper cannot accidentally retain a page data URI. */
export interface CheckHandoffView {
  readonly draftChars: number;
  /** Trimmed count, because the agents do not treat outside whitespace as work. */
  readonly draftReadyChars?: number;
  readonly rubric: string;
  readonly contextChars: number;
  readonly attachment: {
    readonly name: string; readonly pages: number; readonly kind?: 'pdf' | 'image';
  } | null;
}

const characters = (value: number): string =>
  `${n(value)} character${value === 1 ? '' : 's'}`;

const enteredCriteriaLines = (rubric: string): number =>
  rubric.split(/\r?\n/).filter((line) => line.trim().length > 0).length;

/** The exact shortfall before the selected Check agent can form an opinion. */
export function checkMinimumShortfall(
  input: CheckHandoffView, limits: CheckLimitsView,
): number {
  if (input.attachment) return 0;
  const minimum = input.rubric.trim()
    ? limits.markWorkMinChars : limits.reviewDraftMinChars;
  const ready = input.draftReadyChars ?? input.draftChars;
  return Math.max(0, minimum - ready);
}

/**
 * The mounted receipt immediately before Check.
 *
 * These lines describe exactly what the panel puts on the wire and name the
 * service-owned rules that can narrow it before the model. Criteria are the
 * deliberate exception to a fake exact count: the service rejects headings,
 * fragments and instruction-like lines, so this says how many lines were
 * entered and the exact admission rules instead of promising that every line
 * becomes a row.
 */
export function checkHandoffLines(
  input: CheckHandoffView, limits: CheckLimitsView,
): readonly string[] {
  const marked = input.rubric.trim().length > 0;
  const lines: string[] = [];
  if (!input.draftChars && !input.attachment && !marked && !input.contextChars) {
    return ['Nothing is ready yet.', 'Nothing is sent until you press Check it.'];
  }

  lines.push(marked
    ? 'Criteria-led mark.'
    : 'Draft review for clarity and reasoning, using any evidence-backed weak areas from your board.');

  if (input.draftChars > 0) {
    const cap = draftCap(limits, marked);
    const included = Math.min(input.draftChars, cap);
    lines.push(input.draftChars <= cap
      ? `Draft text: all ${characters(input.draftChars)}.`
      : `Draft text: first ${characters(included)} of ${n(input.draftChars)}. `
        + `The final ${characters(input.draftChars - included)} will not be checked.`);
  }

  const shortfall = checkMinimumShortfall(input, limits);
  if (shortfall > 0) {
    const minimum = marked ? limits.markWorkMinChars : limits.reviewDraftMinChars;
    const ready = input.draftReadyChars ?? input.draftChars;
    lines.push(`Your draft is ${n(ready)} of ${n(minimum)} characters needed for ${marked
      ? 'a criteria-led mark' : 'a board-informed review'}. Add ${characters(shortfall)} more, or attach its pages.`);
  }

  if (input.attachment) {
    const pages = Math.max(0, Math.floor(input.attachment.pages));
    if (input.attachment.kind === 'image') {
      lines.push(`${shortName(input.attachment.name)}: 1 image, sent as a picture.`);
    } else {
      const range = pages === 1 ? 'page 1' : `pages 1 to ${n(pages)}`;
      lines.push(`${shortName(input.attachment.name)}: all ${n(pages)} `
        + `page${pages === 1 ? '' : 's'} (${range}), sent as pictures.`);
    }
  }

  if (marked) {
    const entered = enteredCriteriaLines(input.rubric);
    lines.push(`Criteria: ${n(entered)} entered line${entered === 1 ? '' : 's'}; `
      + `up to ${n(limits.rubricCriteria)} eligible lines, first `
      + `${characters(limits.rubricCriterionChars)} each. `
      + 'Held-back lines are named in the result.');
  }

  if (input.contextChars > 0) {
    const included = Math.min(input.contextChars, limits.contextChars);
    lines.push(input.contextChars <= limits.contextChars
      ? `Context: all ${characters(input.contextChars)}. Instruction-like lines may be held back and named in the result.`
      : `Context: first ${characters(included)} of ${n(input.contextChars)}. `
        + `The final ${characters(input.contextChars - included)} will not be checked; `
        + 'instruction-like lines may also be held back and named in the result.');
  }

  lines.push('Nothing is sent until you press Check it.');
  return lines;
}

export const LEAVE_FILE_OUT = 'Leave this file out';

export const filePendingLine = (fileName: string): string =>
  `${shortName(fileName)} is still being prepared. Check waits so it cannot be left out by accident.`;

export const fileBlockingLine = (fileName: string): string =>
  `${shortName(fileName)} is not included. Retry it, or leave this file out to check the rest.`;

export function fileLeftOutLine(fileName: string, box: 'draft' | 'rubric'): string {
  return `${shortName(fileName)} will be left out. Your existing ${box === 'draft' ? 'draft and attachment are' : 'criteria are'} unchanged.`;
}

/**
 * The other ceiling, which is the model's rather than the product's.
 *
 * Roughly four characters to a token, across all three boxes together, against
 * whatever the deep route is pointed at. With Gemini's million-token window
 * this effectively never fires, and that is the correct outcome: a warning that
 * fires on ordinary work is a warning people learn to ignore.
 *
 * `null` is a local or CLI connection, which is whatever the operator pulled.
 * Inventing a window for it would be worse than saying nothing, so this layer
 * goes quiet rather than guessing.
 */
export const CHARS_PER_TOKEN = 4;

export function windowWarningLine(chars: number, maxInputTokens: number | null | undefined): string | null {
  if (typeof maxInputTokens !== 'number' || !Number.isFinite(maxInputTokens) || maxInputTokens <= 0) return null;
  const estimate = Math.ceil(chars / CHARS_PER_TOKEN);
  if (estimate <= maxInputTokens) return null;
  return 'All three boxes together are too large for the model this goes to. Some of this would be cut before anything read it.';
}

// --------------------------------------------- what came back, said honestly

/**
 * The check that did not happen, and which kind of not-happening it was.
 *
 * Written to the same rule as `boardUnreadableLine`, and for the same reason:
 * `api()` collapses a dead service, a 401 and a 500 into one `null`, and the
 * screens a learner reached by *pressing something* have to say which. A 401
 * here is a service that is running perfectly and refusing this panel, and
 * telling somebody it could not be reached sends them to look at the wrong
 * thing entirely.
 *
 * Every branch ends in the same clause, because it is true on every branch and
 * it is the one thing the learner actually needs: their draft is untouched and
 * nothing has been concluded about it.
 */
export function checkUnreadableLine(
  cause: 'unreachable' | 'refused', status: number | null,
  /**
   * The discriminator the service sends with a refusal it has a name for.
   *
   * Both of the named refusals carry `stoppedBy`, so this screen switches on
   * one field rather than pattern-matching a status and a sentence. Anything
   * without it falls through to the status branches below, which is every
   * refusal that was already here.
   */
  refusal: {
    stoppedBy?: string | null; connection?: string | null;
    update?: 'service' | 'extension' | null;
  } = {},
): string {
  if (cause === 'unreachable') {
    return 'I could not reach your board, so nothing read your work. Start Virgil and press the button again. '
      + 'Nothing about your draft has changed.';
  }
  if (status === 426 && refusal.stoppedBy === 'version-skew') {
    if (refusal.update === 'service') {
      return 'This Virgil installation is older than the extension. Update and restart Virgil. '
        + 'Nothing about your draft has changed.';
    }
    if (refusal.update === 'extension') {
      return 'This extension is older than the Virgil installation. Update the extension. '
        + 'Nothing about your draft has changed.';
    }
  }
  // The other named refusal, and not the same fact as the budget's. "You have
  // spent your limit" and "you never saved a key" have different fixes, and the
  // second one used to arrive here as a generic model failure — which sent
  // somebody looking at their draft for a problem that was two clicks away in
  // Settings.
  if (status === 409 && refusal.stoppedBy === 'model-credential') {
    return credentialMissingLine(refusal.connection);
  }
  // The learner's own limit, which is not a failure of anything and must never
  // be read as one. 402 is the only route to this status in the service, so the
  // panel can key on it without reading the body — and "this is mine to fix,
  // not yours" would be the wrong sentence twice over: nothing is broken, and
  // the person who can move the limit is the person reading this.
  if (status === 402) {
    return `${BUDGET_STOPPED_LINE} Nothing about your draft has changed.`;
  }
  if (status === 401 || status === 403) {
    return 'I could not confirm which board is yours. Sign in again and retry. '
      + 'Nothing about your draft has changed.';
  }
  return 'I could not check your work. This is mine to fix, not yours. '
    + 'Nothing about your draft has changed.';
}

/** A lesson question is evidence-bearing, so a press with no evidence must
 * answer plainly rather than looking like a broken button. */
export const LESSON_ANSWER_REQUIRED = 'Write your answer first.';

/**
 * The lesson answer route uses the same model and therefore the same named
 * refusals as Check. Keep its recovery truth identical, while naming the one
 * extra malformed-success case: the service answered, but supplied no reading.
 */
export function lessonAnswerUnreadableLine(
  cause: 'unreachable' | 'refused' | 'no-reading', status: number | null = null,
  refusal: {
    stoppedBy?: string | null; connection?: string | null;
    update?: 'service' | 'extension' | null;
  } = {},
): string {
  if (cause === 'no-reading') {
    return 'I could not read the result. Your answer is still here. Try again.';
  }
  return checkUnreadableLine(cause, status, refusal);
}

/** The reviewer's version of the marker's truncation note. Same fact, same
 *  voice: "I read your draft" and "I read the first six thousand characters of
 *  it" are different claims and the screen makes the second one. */
export const reviewTruncatedLine = (): string =>
  'This is longer than I can read in one go, so I read the start of it. What is below that has not been looked at.';

/**
 * The context cap, said as a fact about what was seen.
 *
 * The service cuts context at 4,000 characters **before** it scans it, which
 * means everything past that was never looked at — not summarised, not skimmed,
 * never loaded. The sentence says exactly that, because "your context was
 * shortened" would let somebody believe the gist of it got through.
 */
export const contextTruncatedLine = (cap: number): string =>
  `Your context ran past ${n(cap)} characters. I read the first ${n(cap)} and never saw the rest.`;

/**
 * SB-39 — a finding, offered to the board.
 *
 * The Ask room's shape, on the other screen that produces a subject worth
 * building: the model has just named the thing this learner keeps getting
 * wrong, and the honest response to that is an offer, never a silent write.
 * The deliberate-capture precedence is the rule — a suggestion the user confirms — and a check that
 * quietly filed six pins because somebody pasted an essay would be the exact
 * violation of it.
 *
 * `struggle` rather than `interest`, because a finding is by construction the
 * thing they did not get right.
 */
export interface FindingPinOffer {
  readonly label: string;
  readonly line: string;
}

/** Every useful finding can enter the learning loop; a model-authored label is optional. */
export function findingPinOffer(finding: FindingView): FindingPinOffer {
  const suggested = (finding.pinSuggestion ?? '').trim();
  const related = (finding.relatedTopicLabel ?? '').trim();
  const problem = Array.from(finding.problem.trim()).slice(0, 180).join('');
  if (finding.relatedTopicId && related) {
    return { label: suggested || related, line: `This connects to ${related}.` };
  }
  if (suggested) return { label: suggested, line: `Worth keeping: ${suggested}.` };
  return {
    label: problem,
    line: 'Keep this finding so it can shape a later lesson.',
  };
}
export const FINDING_PIN_ACTION = 'Keep it on the board';
export const FINDING_PIN_DONE = 'On your board.';
export const FINDING_LEARN_ACTION = 'Learn this now';
export const FINDING_PIN_FAILED = "That didn't go through. Nothing is on the board.";

// ================================================= the spend limit (2026-08-24)

/** Learner-facing token limit and receipts; only billable Cloud/API is gated. */

export type ModelBudgetStatusView = 'off' | 'ok' | 'warning' | 'exhausted';

/** The ceiling the service enforces, restated so the panel can refuse the same
 *  input the endpoint would refuse, without a round trip. */
export const MAX_BUDGET_TOKENS_VIEW = 1_000_000_000;

/** One connection's row on the wire. Everything optional: this is a receipt
 *  read defensively, the way `modelConfigFrom` reads the routing one. */
export interface ConnectionSpendView {
  readonly calls?: unknown;
  readonly inputTokens?: unknown;
  readonly outputTokens?: unknown;
  readonly issuedNotReturned?: unknown;
}

export interface ModelBudgetReceiptView {
  readonly learnerBudget?: { readonly limit?: unknown } | null;
  readonly operatorLimit?: unknown;
  readonly budget?: {
    readonly limit?: unknown; readonly unit?: unknown;
    readonly window?: unknown; readonly setAt?: unknown;
  } | null;
  readonly state?: {
    readonly status?: unknown; readonly limit?: unknown; readonly used?: unknown;
    readonly remaining?: unknown; readonly fraction?: unknown;
    readonly warnAtFraction?: unknown; readonly guards?: unknown;
    readonly setAt?: unknown; readonly since?: unknown;
    readonly unit?: unknown; readonly window?: unknown;
  } | null;
  readonly spend?: {
    readonly since?: unknown;
    readonly connections?: Partial<Record<ModelModeView, ConnectionSpendView>>;
  } | null;
  readonly totalTokens?: unknown;
  readonly notes?: unknown;
}

/** What one connection did, with every number a number. */
export interface ConnectionReading {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly tokens: number;
  readonly issuedNotReturned: number;
}

export interface BudgetReading {
  readonly status: ModelBudgetStatusView;
  /** `null` when no budget is set. Never zero — zero is a cleared budget. */
  readonly limit: number | null;
  readonly learnerLimit: number | null;
  readonly operatorLimit: number | null;
  readonly limitSource: 'learner' | 'operator' | null;
  /** Tokens on the guarded connections. Honest even when the budget is off. */
  readonly used: number;
  readonly remaining: number | null;
  /** Every connection, guarded or not. Never compared to the limit. */
  readonly totalTokens: number;
  readonly since: string | null;
  readonly connections: Readonly<Record<ModelModeView, ConnectionReading>>;
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const budgetStatus = (value: unknown): ModelBudgetStatusView =>
  value === 'ok' || value === 'warning' || value === 'exhausted' ? value : 'off';

/** Normalises partial or older receipts without inventing a limit. */
export function budgetReadingFrom(raw: ModelBudgetReceiptView | null | undefined): BudgetReading {
  const connections = Object.fromEntries(MODEL_MODES.map((mode) => {
    const row = raw?.spend?.connections?.[mode];
    const inputTokens = count(row?.inputTokens);
    const outputTokens = count(row?.outputTokens);
    return [mode, {
      calls: count(row?.calls),
      inputTokens,
      outputTokens,
      tokens: inputTokens + outputTokens,
      issuedNotReturned: count(row?.issuedNotReturned),
    }];
  })) as Record<ModelModeView, ConnectionReading>;

  const limitRaw = raw?.state?.limit;
  const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw >= 1
    ? Math.floor(limitRaw) : null;
  const positiveLimit = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : null;
  // Older services only sent `budget`; a new null names an operator-owned limit.
  const namesLearnerBudget = raw != null && Object.prototype.hasOwnProperty.call(raw, 'learnerBudget');
  const learnerLimit = positiveLimit(namesLearnerBudget ? raw?.learnerBudget?.limit : raw?.budget?.limit);
  const operatorLimit = positiveLimit(raw?.operatorLimit);
  const limitSource = limit === null ? null : operatorLimit !== null
    && (learnerLimit === null || operatorLimit < learnerLimit)
      ? 'operator' : 'learner';
  const status = limit === null ? 'off' : budgetStatus(raw?.state?.status);
  const used = count(raw?.state?.used);
  // Summed here when the service did not send it, rather than shown as zero
  // beside three rows that plainly are not zero.
  const total = typeof raw?.totalTokens === 'number' && Number.isFinite(raw.totalTokens)
    ? Math.max(0, Math.floor(raw.totalTokens))
    : MODEL_MODES.reduce((sum, mode) => sum + connections[mode].tokens, 0);
  const since = typeof raw?.spend?.since === 'string' ? raw.spend.since
    : typeof raw?.state?.since === 'string' ? raw.state.since : null;

  return {
    status, limit, learnerLimit, operatorLimit, limitSource,
    used,
    remaining: limit === null ? null : Math.max(0, limit - used),
    totalTokens: total,
    since,
    connections,
  };
}

export const BUDGET_KICKER = 'Budget';
export const BUDGET_HEADING = 'Cloud usage limit';

export const BUDGET_TOKENS_NOT_MONEY =
  'This is a safety limit on model tokens, not a bill or a currency total. Google bills the service account separately.';

export const BUDGET_GUARD_LINE =
  'When counted Cloud/API tokens reach the limit, Virgil stops new cloud model calls. '
  + 'Calls that return no token size cannot enter this count, so use it as a backstop rather than exact spend accounting. '
  + 'Self-hosted routes are never stopped by this limit.';

/** When this window opened, or the honest admission that nothing has run. */
export function budgetWindowLine(since: string | null, now: number): string {
  if (!since) return 'Nothing has been counted yet.';
  const ago = when(since, now);
  return ago ? `This window opened ${ago}.` : 'This window is already open.';
}

export const BUDGET_ACTIVITY_HEADING = 'Counted activity';

/** One connection's activity. Calls and tokens, and no verdict about either. */
export function budgetConnectionLine(row: ConnectionReading): string {
  if (row.calls === 0 && row.tokens === 0) return 'Nothing has run here.';
  const calls = row.calls === 1 ? '1 call' : `${n(row.calls)} calls`;
  return `${calls} · ${n(row.tokens)} tokens (${n(row.inputTokens)} in, ${n(row.outputTokens)} out)`;
}

export function budgetIssuedLine(issuedNotReturned: number): string | null {
  if (issuedNotReturned <= 0) return null;
  return issuedNotReturned === 1
    ? '1 call returned no size; it may be billed and is not in this token count.'
    : `${n(issuedNotReturned)} calls returned no size; they may be billed `
      + 'and are not in this token count.';
}

/** Everything, and the reminder that the limit is not measured against it. */
export const budgetTotalLine = (totalTokens: number): string =>
  `${n(totalTokens)} tokens across all three connections. The limit is measured against Cloud/API alone.`;

// --------------------------------------------- where the model work came from

/** Splits model usage by learner taps, board runs, and startup work. */
export const USAGE_KICKER = 'Model work';
export const USAGE_HEADING = 'Where the work came from';

export const USAGE_SINCE_LINE =
  'This is what has run since I started up. Restarting me starts the count again; '
  + 'the budget above keeps its own longer count.';

export const USAGE_TAPS_LABEL = 'Things you pressed';
export const USAGE_RUNS_LABEL = 'Board runs';
export const USAGE_SETUP_LABEL = 'Starting Virgil';
export const USAGE_TOTAL_LABEL = 'Everything';
export const USAGE_SETUP_LINE =
  'Starting Virgil is a model warm-up when enabled. It prepares the first action; '
  + 'it is not something you pressed and it teaches nothing.';

export interface UsageCountView {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageEmbedCountView {
  calls: number;
  inputs: number;
  inputChars: number;
}

export interface UsageReportView {
  llm?: {
    totals?: UsageCountView;
    byLane?: { taps?: UsageCountView; runs?: UsageCountView; setup?: UsageCountView };
  };
  embed?: {
    totals?: UsageEmbedCountView;
    byLane?: { taps?: UsageEmbedCountView; runs?: UsageEmbedCountView; setup?: UsageEmbedCountView };
  };
}

export function usageCountLine(count: UsageCountView | undefined): string {
  const c = count ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
  if (!c.calls && !c.inputTokens && !c.outputTokens) return 'Nothing has run here.';
  const calls = c.calls === 1 ? '1 call' : `${n(c.calls)} calls`;
  const tokens = c.inputTokens + c.outputTokens;
  return `${calls} · ${n(tokens)} tokens (${n(c.inputTokens)} in, ${n(c.outputTokens)} out)`;
}

export function usageEmbedLine(count: UsageEmbedCountView | undefined): string | null {
  const c = count ?? { calls: 0, inputs: 0, inputChars: 0 };
  if (!c.calls) return null;
  const calls = c.calls === 1 ? '1 embedding call' : `${n(c.calls)} embedding calls`;
  const inputs = c.inputs === 1 ? '1 piece of text' : `${n(c.inputs)} pieces of text`;
  return `${calls} over ${inputs}. Embedding models report no token count, so this is `
    + 'counted in calls and text rather than tokens.';
}

/** Said once, under the split: which of these numbers has a bill behind it. */
export const USAGE_WHICH_BILLS =
  'Only Cloud/API work can bill you. Local and Agent CLI cost tokens and no money.';

export const BUDGET_LIMIT_LABEL = 'Cloud token limit';
export const BUDGET_SAVE_ACTION = 'Save the limit';
export const BUDGET_CLEAR_ACTION = 'Remove my limit';
export const BUDGET_RESET_ACTION = 'Reset counted usage';

export const BUDGET_SAVE_NOTE =
  'Changing the limit moves the line, not the count. What has already been spent still '
  + 'counts against the new number.';
export const BUDGET_CLEAR_NOTE =
  'This removes the limit you chose. A service-owned ceiling can still apply, and the count of '
  + 'what has been spent stays exactly as it is.';
export const BUDGET_RESET_NOTE =
  'A new window sets the Cloud/API count back to zero from now, because that is the count the limit '
  + 'is measured against. Local and Agent CLI keep theirs, and any limit you have set stays where it is.';

export const BUDGET_SAVED = 'Saved. I will stop Cloud/API work when the count reaches it.';
export const BUDGET_CLEARED =
  'Your limit was removed. Any service-owned ceiling still applies, and the count is still here.';
export const BUDGET_WINDOW_RESET =
  'New window. The Cloud/API count is back to zero, Local and Agent CLI are as they were, '
  + 'and the limit is unchanged.';

export const BUDGET_WRITE_UNREACHABLE =
  'I could not update the budget. It is unchanged.';
export const BUDGET_WRITE_REFUSED =
  'I could not make that budget change. The budget is unchanged.';
export const BUDGET_READ_UNREACHABLE =
  "I can't read the budget right now, so I can't say what has been spent or what the limit is.";
export const BUDGET_READ_REFUSED =
  "I could not read the budget, so I can't say what has been spent or what the limit is.";

export function budgetLimitRefusal(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return 'Type a limit first: a whole number of tokens.';
  const value = Number(trimmed);
  if (!Number.isFinite(value) || !Number.isInteger(value)
    || value < 1 || value > MAX_BUDGET_TOKENS_VIEW) {
    return `A limit is a whole number of tokens between 1 and ${n(MAX_BUDGET_TOKENS_VIEW)}. `
      + 'I have not sent that one.';
  }
  return null;
}

export const BUDGET_STOPPED_LINE =
  'Your budget stopped this before anything was sent.';

export interface BudgetFreeConnectionView {
  readonly connection: ModelModeView;
  readonly enabled: boolean;
  readonly readiness: ModelReadinessView;
}

const joinedConnections = (modes: readonly ModelModeView[]): string => {
  const labels = modes.map((mode) => MODEL_CONNECTION_LABEL[mode]);
  if (labels.length < 2) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
};

export function budgetFreeRouteLine(
  raw: readonly BudgetFreeConnectionView[] | null | undefined,
): string {
  if (!raw) {
    return 'I could not confirm whether Local or Agent CLI is ready. I did not move any model work. Open Models to check them.';
  }
  const rows = new Map<ModelModeView, BudgetFreeConnectionView>();
  for (const row of raw) {
    if ((row.connection === 'local' || row.connection === 'cli') && !rows.has(row.connection)) {
      rows.set(row.connection, row);
    }
  }
  const ready = [...rows.values()]
    .filter((row) => row.enabled && row.readiness === 'ready')
    .map((row) => row.connection);
  const off = [...rows.values()]
    .filter((row) => !row.enabled && row.readiness === 'ready')
    .map((row) => row.connection);
  const clauses: string[] = [];
  if (ready.length) clauses.push(`${joinedConnections(ready)} ${ready.length === 1 ? 'is' : 'are'} ready to use.`);
  if (off.length) clauses.push(`${joinedConnections(off)} ${off.length === 1 ? 'is' : 'are'} available but turned off.`);
  if (!clauses.length) clauses.push('No free connection is ready yet.');
  clauses.push('I did not move any model work.');
  clauses.push(ready.length
    ? 'Open Models to choose which work to move.'
    : 'Open Models to set up or check Local and Agent CLI.');
  return clauses.join(' ');
}

/** A missing model credential is setup work, not a model failure. */
export const CREDENTIAL_MISSING_SHORT =
  'The model connection for this work is not ready. Open Settings → Models to finish or restart it.';

export function credentialMissingLine(connection: string | null | undefined): string {
  const named = modelConnectionLabel(connection);
  if (connection === 'cloud') {
    return 'The Cloud/API connection has no key saved, so nothing read your work. '
      + 'Add one in Settings → Models. Nothing about your draft has changed.';
  }
  if (connection === 'local') {
    return 'The Local connector is not running, so nothing read your work. '
      + 'Start the connector shown in Settings → Models. Nothing about your draft has changed.';
  }
  if (connection === 'cli') {
    return 'The Agent CLI connection is not ready, so nothing read your work. '
      + 'Start its authenticated bridge from Settings → Models. Nothing about your draft has changed.';
  }
  const which = named
    ? `The ${named} connection is not ready, so nothing read your work.`
    : 'The model connection for this work is not ready, so nothing read your work.';
  return `${which} Open Settings → Models to finish it. Nothing about your draft has changed.`;
}

// -------------------------------------------- the learner's own Drive folder

/** One-click Drive setup; OAuth configuration remains an operator concern. */
export const DRIVE_KICKER = 'Google Drive';
export const DRIVE_HEADING = 'Your documents, in your own Drive';

/**
 * What the learner gets, first, because it is the answer to the only question
 * a person reading this block is actually asking.
 *
 * It names the three by what they answer rather than by their titles, which are
 * listed further down once they exist. Rewritten in place is in here because it
 * is the fact that makes the setup a one-time thing, and a one-time thing is
 * what somebody is deciding whether to start.
 */
export const DRIVE_VALUE_LINE =
  'Virgil keeps three documents in a folder in your Drive: the lesson you are on right now, '
  + 'everything on your board, and the subjects you have held before. It rewrites those same '
  + 'three in place, so the folder never grows and you only ever add them to a notebook once.';

/**
 * What Gemini Notebook does with them, said as Google's claim rather than as
 * Virgil's promise.
 *
 * §2's law in one sentence. Virgil cannot see the notebook, does not know what
 * Google read or when, and will not imply that it does — so this reports what
 * Google publishes about its own product and then says plainly what Virgil is
 * able to tell them instead.
 */
export const DRIVE_NOTEBOOK_LINE =
  'Google says Gemini Notebook re-reads its Drive sources by itself, on its own schedule. '
  + 'Virgil cannot see your notebook, so all it will ever tell you is what it wrote and when.';

/** The consent fact. §4.2's scope, in the words Google's own screen uses. The
 *  reassurance line, and deliberately not the headline any more. */
export const DRIVE_CONSENT_LINE =
  'Google will ask you to let Virgil create and open files that Virgil creates. That is the '
  + 'only permission it asks for, and it does not reach anything else in your Drive.';

/** The other half of the same fact, and the reason §4 calls this a pillar: the
 *  permission is between the learner's Google account and a process on their
 *  own machine, with no company in the path. */
export const DRIVE_LOCAL_LINE =
  'The permission is between your Google account and Virgil on this computer. '
  + 'Nothing is kept anywhere else, and no key of yours is ever shown back to you here.';

export const DRIVE_CONNECT_ACTION = 'Connect Drive';
export const DRIVE_DISCONNECT_ACTION = 'Forget my Drive';
export const DRIVE_OPEN_PERMISSION_ACTION = 'Open Google permission';
export const DRIVE_PERMISSION_TAB_FAILED =
  "Google's permission page did not open. Use this link to continue. Virgil has not created or changed any documents yet.";

/**
 * The empty state, in two sentences, and it asks the learner for nothing.
 *
 * A build carrying no Google sign in cannot ask for permission, and saying so
 * is a refusal, which the show-do-not-tell law leaves alone. What it may not do
 * is turn a missing capability into a chore. There is no form here, no
 * disclosure, and no console instruction, because the person reading this
 * cannot act on any of it: the fix belongs to whoever built or installed this
 * copy, and it is in the README where they will look for it.
 *
 * The second sentence exists so nobody reads a capability this build does not
 * have as a product that is broken.
 */
export const DRIVE_NO_CLIENT_LINE =
  'This copy of Virgil cannot offer a Drive connection, because it was built without a Google '
  + 'sign in of its own. Nothing else is affected, and there is nothing for you to do about it.';


export function driveClientLine(configured: boolean): string | null {
  return configured ? null : DRIVE_NO_CLIENT_LINE;
}

/** The three states of an attempt, and they are three different facts. */
export function driveConnectLine(state: string, detail: string): string | null {
  if (state === 'idle') return null;
  return detail || null;
}


export function driveBadge(connected: boolean, state: string, clientConfigured = true): string {
  if (state === 'waiting') return 'Waiting for Google';
  if (state === 'writing') return 'Writing your documents';
  if (connected) return 'Connected';
  return clientConfigured ? 'Not connected' : 'Not available in this build';
}

/**
 * §7 step 4, and it stays theirs.
 *
 * Virgil does not create the notebook, does not add the sources and does not
 * automate a browser (§12). This is the one instruction in the block, and it is
 * an instruction about a different product's interface.
 */
export const DRIVE_ADD_SOURCES_LINE =
  'In Gemini Notebook: make a notebook, choose Google Drive as the source, and add these '
  + 'three documents. That is the only time you have to do it.';

export const DRIVE_FOLDER_ACTION = 'Open the folder';

/**
 * One row per document, per §11, and never the word up-to-date.
 *
 * The failure this seam has that nothing else in the product has is that
 * **failure looks exactly like success from the learner's side**: a notebook
 * whose sources are three weeks old answers fluently and gives no sign at all.
 * So a document that did not get written says so, in the reason the service
 * gave, which is already a sentence rather than an exception.
 */
export function driveDocRow(doc: {
  readonly title: string; readonly written: boolean; readonly error: string | null;
}): string {
  return doc.written ? doc.title : `${doc.title}. ${doc.error ?? 'It did not go through.'}`;
}

export const DRIVE_NOT_WRITTEN_YET = 'Nothing has been written since Virgil started up.';

/** A refusal in the two shapes the rest of this panel already distinguishes. */
export const DRIVE_UNREACHABLE = 'I cannot change this connection right now, so nothing was changed.';
export const DRIVE_REFUSED =
  'I could not confirm your account. Sign in again before changing this connection.';

/**
 * What forgetting a Drive actually does, said before it is done.
 *
 * §13, and it is the fact somebody deciding this needs: the documents are
 * theirs and stay exactly where they are. Virgil stops writing to them, which
 * means their notebook goes on reading sources that stop changing. That is the
 * honest consequence of withdrawing a permission, and it is a thing they can
 * undo by connecting again.
 */
export function driveForgetConfirmLines(): string[] {
  return [
    'Virgil forgets the permission and stops writing to your Drive.',
    'The three documents stay exactly where they are. Virgil does not delete anything of yours.',
    'What they say will stop changing, and nothing on any screen will remind you.',
  ];
}
