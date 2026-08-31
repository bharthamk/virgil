import type {
  CourseObjective, CourseSource, CourseSourceKind, MaterialKind, SourceRef,
} from './courses.js';
import {
  COURSE_PROVIDER_MAX_CHARS, COURSE_SOURCE_TITLE_MAX_CHARS,
  COURSE_TITLE_MAX_CHARS, MATERIAL_TITLE_MAX_CHARS,
} from './courses.js';
import {
  COMMITMENT_TITLE_MAX_CHARS, deadlineDay, resolveLocalDeadline, type CommitmentKind,
} from './commitments.js';
import { isOpenableUrl } from './courses.js';

/** A proposed material row. It is not authoritative until the draft is applied. */
export interface IntakeMaterial {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly kind: MaterialKind;
  readonly minutes: number | null;
  readonly source: SourceRef;
}

export interface IntakeRubricCriterion {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly topicIds: readonly string[];
  readonly source: SourceRef;
}

export interface IntakeCommitment {
  readonly id: string;
  readonly title: string;
  readonly kind: CommitmentKind;
  /** Null means the source named work but did not provide one unambiguous date. */
  readonly dueAt: string | null;
  /** Original stated wall time and its IANA owner; absent/null means date-only. */
  readonly dueTime?: string | null;
  readonly dueTimeZone?: string | null;
  readonly plannedFor: string | null;
  readonly estimateMinutes: number | null;
  readonly notes: string;
  readonly topicIds: readonly string[];
  readonly rubricCriteria: readonly IntakeRubricCriterion[];
  readonly source: SourceRef;
}

export interface IntakeQuestion {
  readonly id: string;
  readonly field: string;
  readonly prompt: string;
  readonly source: SourceRef | null;
  /** Blocks apply until the learner fixes the field or explicitly dismisses it. */
  readonly blocking: boolean;
  readonly resolvedAt: string | null;
}

export type IntakeProposalKind = 'objective' | 'material' | 'commitment';

/** A learner-owned exclusion. The proposal stays beside its source evidence so
 * it can be restored and an enrichment pass cannot quietly propose it again. */
export interface RejectedIntakeProposal {
  readonly kind: IntakeProposalKind;
  readonly id: string;
  readonly rejectedAt: string;
}

export interface CourseIntakeDraft {
  readonly id: string;
  readonly status: 'draft' | 'applied';
  readonly source: CourseSource;
  readonly title: string;
  readonly provider: string;
  readonly url: string;
  readonly objectives: readonly CourseObjective[];
  readonly material: readonly IntakeMaterial[];
  readonly commitments: readonly IntakeCommitment[];
  readonly questions: readonly IntakeQuestion[];
  /** Optional for drafts written before learner rejection existed. */
  readonly rejected?: readonly RejectedIntakeProposal[];
  readonly warnings: readonly string[];
  readonly createdAt: string;
  readonly appliedAt: string | null;
  readonly enrichment?: {
    readonly outcome: 'enriched' | 'nothing-added' | 'model-failed';
    readonly attemptedAt: string;
    readonly added: { readonly objectives: number; readonly commitments: number; readonly questions: number };
  };
}

export interface IntakeBuildInput {
  readonly draftId: string;
  readonly sourceId: string;
  readonly sourceKind: CourseSourceKind;
  readonly sourceTitle: string;
  readonly text: string;
  readonly url?: string | null;
  readonly now: string;
  /** Supplied by the composition root so the domain stays deterministic. */
  readonly id: () => string;
  readonly digest: string;
  /** Explicit learner/deployment zone used only when a source states a time. */
  readonly timeZone?: string;
}

export const INTAKE_SOURCE_MAX_CHARS = 60_000;
const MAX_QUOTE_CHARS = 280;
export const INTAKE_TEXT_LIMITS = {
  title: COURSE_TITLE_MAX_CHARS,
  provider: COURSE_PROVIDER_MAX_CHARS,
  objective: 300,
  materialTitle: MATERIAL_TITLE_MAX_CHARS,
  commitmentTitle: COMMITMENT_TITLE_MAX_CHARS,
} as const;
const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();
const quote = (line: string): string => clean(line).slice(0, MAX_QUOTE_CHARS);

const stripBullet = (line: string): string =>
  clean(line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ''));

const fieldValue = (lines: readonly string[], names: readonly string[]): string | null => {
  for (const line of lines) {
    for (const name of names) {
      const match = new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'i').exec(line);
      if (match?.[1]) return clean(match[1]);
    }
  }
  return null;
};

const month: Readonly<Record<string, number>> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9,
  october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const utcDate = (year: number, monthIndex: number, day: number, hour = 23, minute = 59): string | null => {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, monthIndex, day, hour, minute));
  // `Date.UTC(2026, 1, 31)` silently becomes March 3. Intake cannot turn an
  // impossible source date into a confident but different deadline.
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== monthIndex || dt.getUTCDate() !== day
      || dt.getUTCHours() !== hour || dt.getUTCMinutes() !== minute) return null;
  return dt.toISOString();
};

export interface ParsedDeadline {
  readonly dueAt: string | null;
  readonly dueTime?: string;
  readonly dueTimeZone?: string;
}

const clockAfter = (line: string, end: number): string | null => {
  const tail = line.slice(end);
  const match = /^\s*(?:,|at\b|by\b|-|–|—)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(tail);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (minute > 59 || hour > (meridiem ? 12 : 23) || hour < (meridiem ? 1 : 0)) return null;
  if (meridiem === 'am') hour %= 12;
  if (meridiem === 'pm') hour = (hour % 12) + 12;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

const parsedDeadline = (
  year: number, monthIndex: number, day: number, time: string | null, timeZone: string,
): ParsedDeadline => {
  if (!time) return { dueAt: utcDate(year, monthIndex, day) };
  const date = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return {
    dueAt: resolveLocalDeadline(date, time, timeZone),
    dueTime: time,
    dueTimeZone: timeZone,
  };
};

/** Parse only date shapes whose day/month order is explicit, retaining a real
 * wall time when one follows the date. */
export function unambiguousDeadline(line: string, timeZone = 'UTC'): ParsedDeadline {
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?\b/.exec(line);
  if (iso) {
    const [, y, m, d, hh, mm] = iso;
    const monthIndex = Number(m) - 1;
    if (monthIndex < 0 || monthIndex > 11) return { dueAt: null };
    const time = hh === undefined ? null : `${hh}:${mm}`;
    return parsedDeadline(Number(y), monthIndex, Number(d), time, timeZone);
  }
  const dmy = /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(20\d{2})\b/i.exec(line);
  if (dmy) {
    const m = month[dmy[2]!.toLowerCase()];
    if (m === undefined) return { dueAt: null };
    return parsedDeadline(Number(dmy[3]), m, Number(dmy[1]),
      clockAfter(line, dmy.index + dmy[0].length), timeZone);
  }
  const mdy = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i.exec(line);
  if (mdy) {
    const m = month[mdy[1]!.toLowerCase()];
    if (m === undefined) return { dueAt: null };
    return parsedDeadline(Number(mdy[3]), m, Number(mdy[2]),
      clockAfter(line, mdy.index + mdy[0].length), timeZone);
  }
  return { dueAt: null };
}

/** Date-only compatibility API retained for existing callers and tests. */
export function unambiguousDate(line: string): string | null {
  return unambiguousDeadline(line, 'UTC').dueAt;
}

const ambiguousNumericDate = (line: string): boolean =>
  /\b\d{1,2}[/-]\d{1,2}[/-](?:20)?\d{2}\b/.test(line);

const kindFor = (line: string): CommitmentKind => {
  if (/\b(assignment|essay|project|exam|quiz|assessment|presentation|report)\b/i.test(line)) return 'assignment';
  if (/\b(class|lecture|lesson|workshop|tutorial)\b/i.test(line)) return 'lesson';
  if (/\b(study|revision|revise|practice)\b/i.test(line)) return 'study';
  return 'task';
};

const materialKind = (line: string, url: string): MaterialKind => {
  if (/youtube|youtu\.be|vimeo|\bvideo\b/i.test(`${line} ${url}`)) return 'video';
  if (/\b(class|lecture|workshop|tutorial)\b/i.test(line)) return 'class';
  if (/\b(exercise|practice|lab)\b/i.test(line)) return 'exercise';
  if (/\b(read|reading|chapter|article|paper)\b/i.test(line)) return 'reading';
  return 'other';
};

const minutesFrom = (line: string): number | null => {
  const m = /\b(\d{1,3})\s*(?:minutes?|mins?|min)\b/i.exec(line);
  if (m) return Math.min(600, Number(m[1]));
  const h = /\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|hr)\b/i.exec(line);
  return h ? Math.min(600, Math.round(Number(h[1]) * 60)) : null;
};

/** Keep duration as structured metadata instead of repeating it in the title. */
const materialTitle = (line: string, rawUrl: string): string => {
  const withoutUrl = rawUrl ? line.replace(rawUrl, '') : line;
  const withoutDuration = withoutUrl
    .replace(/\(\s*\d+(?:\.\d+)?\s*(?:minutes?|mins?|min|hours?|hrs?|hr)\s*\)/gi, '')
    .replace(/\b\d+(?:\.\d+)?\s*(?:minutes?|mins?|min|hours?|hrs?|hr)\b/gi, '');
  // A syllabus label describes the row; it is not part of the resource's
  // name. Keeping `Reading:` in every title made a clean import look as if the
  // learner had typed the category twice, and `Reading` was not recognised by
  // the singular `read` token above. Strip only an explicit leading label —
  // prose such as "Reading strategies for law" remains untouched.
  return trimDangling(stripBullet(withoutDuration)
    .replace(/^(?:reading|read|video|lecture|class|workshop|tutorial|exercise|practice|lab)\s*:\s*/i, ''));
};

/** Table headings name columns, not work the learner owes. */
const isCommitmentTableHeader = (line: string): boolean => {
  // A numbered “Assignment 1 due …” is learner work even when its remaining
  // words happen to be common column labels.
  if (/\d/.test(line)) return false;
  const words = line.toLowerCase().match(/[a-z]+/g) ?? [];
  if (/^(?:due(?: date)?|deadline|submission date)$/i.test(line.trim())) return true;
  if (!words.length || words.length > 8) return false;
  const allowed = new Set([
    'assessment', 'assessments', 'assignment', 'assignments', 'item', 'items',
    'task', 'tasks', 'work', 'title', 'name', 'due', 'deadline', 'date',
    'submission', 'weight', 'weighting', 'value', 'mark', 'marks', 'percentage',
    'percent', 'points', 'week', 'type',
  ]);
  const namesWork = words.some((word) => [
    'assessment', 'assessments', 'assignment', 'assignments', 'item', 'items',
    'task', 'tasks', 'work', 'title', 'name',
  ].includes(word));
  const namesDate = words.some((word) => ['due', 'deadline', 'date', 'submission'].includes(word));
  return namesWork && namesDate && words.every((word) => allowed.has(word));
};

/** A document/course heading can contain a work keyword without naming work. */
const isCommitmentDocumentHeading = (line: string, index: number): boolean => {
  const visible = stripBullet(line);
  // Identity metadata is never an obligation, even for a course whose actual
  // title contains words such as "Assessment" or "Project".
  if (/^(?:course(?: title)?|module|unit)\s*:/i.test(visible)) return true;
  // The unlabelled fallback title is the first source line. Reject it only when
  // it has the language of a document heading and none of the evidence that
  // makes an undated assignment row useful to review. A genuine "Final
  // presentation" remains a proposal and still asks for its date.
  if (index !== 0 || visible !== line || /\b(?:due|deadline)\b|%/i.test(line)
      || unambiguousDate(line) || ambiguousNumericDate(line)) return false;
  return /\b(?:assessment|assignment|exam|project)\s+(?:overview|outline|schedule|calendar|information|details|guide)\b/i
    .test(visible);
};

/**
 * The punctuation a title is left holding once the date clause is cut off it.
 *
 * `- Lab report, 1500 words (25%) — due Wednesday 9 September 2026, 17:00`
 * becomes `Lab report, 1500 words (25%) —`, and the notebook then renders it as
 * *"Lab report, 1500 words (25%) —."* Maya could not tell whether the text was
 * cut off or the app was broken, and both readings are reasonable.
 *
 * Only the connectors are trimmed — commas, colons, semicolons, dashes, pipes,
 * slashes, bullets. A closing bracket or a percent sign is part of the title
 * and stays, because `(25%)` is information and `—` is a seam.
 */
const DANGLING_TAIL = /[\s,;:|/·•–—―-]+$/;

const trimDangling = (title: string): string => title.replace(DANGLING_TAIL, '');

/**
 * Remove only a date that the parser already accepted and that occupies the
 * tail of a row. Course tables commonly put a bare date in the Due column; the
 * immutable quote keeps it, while repeating it inside the title and beside the
 * title makes the proposal look broken. Mid-sentence and ambiguous dates stay.
 */
const stripAcceptedDateTail = (line: string, accepted: boolean): string => {
  if (!accepted) return line;
  const date = /\b(20\d{2}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2})?|\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+20\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+20\d{2})\b/i.exec(line);
  if (!date) return line;
  const after = line.slice(date.index + date[0].length);
  const onlyClock = /^\s*(?:(?:,|at\b|by\b|-|–|—)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b)?\s*$/i;
  if (!onlyClock.test(after)) return line;
  return line.slice(0, date.index)
    .replace(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*$/i, '');
};

/**
 * A title reduced to the words in it, for comparing two proposals.
 *
 * Punctuation and case are dropped because the same obligation is written twice
 * in one syllabus in two registers — once in the assessment table with its
 * weighting, once in the teaching week without — and the difference between
 * `Lab report, 1500 words (25%)` and `Lab report` is entirely the parts this
 * removes.
 */
const titleKey = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The shortest stem that may swallow a longer row.
 *
 * A guard against a two- or three-character key — `q5`, `lab` — matching inside
 * an unrelated title that happens to fall on the same day. Long enough that a
 * collapse is about a repeated obligation and not about a coincidence.
 */
const MIN_DUPLICATE_STEM = 6;

/**
 * Collapse the same obligation proposed twice for the same day.
 *
 * Maya's imported semester contained two lab reports due 2026-09-09 and two
 * research essays due 2026-09-21, with different names and no way to tell which
 * one was real. The syllabus mentions each once in the assessment table and
 * once in its teaching week; both mentions became separate commitments.
 *
 * Three conditions, all required, because a wrong merge silently deletes work
 * somebody is on the hook for:
 *
 *  1. **the same explicit date.** Two undated proposals are never merged — a
 *     null due date is the extractor saying it does not know, and merging two
 *     unknowns would be guessing twice;
 *  2. **one title contained in the other**, on words alone;
 *  3. **the contained one is long enough to mean something.**
 *
 * The LONGER title survives, because it is the one carrying the weighting, the
 * word count and the thing that makes it recognisable — and because the shorter
 * is recoverable from it by reading, while the reverse is not. Any rubric
 * criteria attached to the row being dropped move to the survivor, so a merge
 * cannot quietly take a marking scheme with it.
 */
function collapseSameDayDuplicates(
  rows: readonly IntakeCommitment[],
): readonly IntakeCommitment[] {
  const keys = rows.map((r) => titleKey(r.title));
  const kept = rows.slice();
  const dropped = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    if (dropped.has(i)) continue;
    for (let j = 0; j < rows.length; j++) {
      if (i === j || dropped.has(j)) continue;
      const survivor = rows[i] as IntakeCommitment;
      const candidate = rows[j] as IntakeCommitment;
      if (!survivor.dueAt || survivor.dueAt !== candidate.dueAt) continue;
      const keep = keys[i] as string;
      const go = keys[j] as string;
      const identical = keep === go;
      // Identical rows: the first one wins, so the result does not depend on
      // which direction the scan happened to reach the pair from.
      if (identical ? j < i : (go.length < MIN_DUPLICATE_STEM || go.length >= keep.length
          || !keep.includes(go))) continue;
      dropped.add(j);
      const held = kept[i] as IntakeCommitment;
      if (!held.rubricCriteria.length && candidate.rubricCriteria.length) {
        kept[i] = { ...held, rubricCriteria: candidate.rubricCriteria };
      }
    }
  }
  return kept.filter((_, i) => !dropped.has(i));
}

const sectionLines = (lines: readonly string[], heading: RegExp): readonly string[] => {
  const at = lines.findIndex((line) => heading.test(line));
  if (at < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim()) {
      if (out.length) break;
      continue;
    }
    if (/^[A-Z][A-Za-z /&-]{2,40}:?\s*$/.test(line) && !/^\s*[-*•\d]/.test(line)) break;
    out.push(line);
  }
  return out;
};

/** A due/deadline row is metadata for adjacent work, never work by itself. */
const isStandaloneDeadlineMetadata = (line: string): boolean =>
  /^(?:due(?:\s+date)?|deadline|submission\s+date)\s*[:–—-]\s*\S/i.test(stripBullet(line));

/**
 * Keep a date written on the next physical line with the work it qualifies.
 *
 * Course outlines often use:
 *
 *   Assignment: Audit one page
 *   Due: 2026-09-05
 *
 * Joining only physically adjacent rows is conservative: a blank line means
 * the extractor does not assume that a later date belongs to earlier work.
 * Standalone date-label rows are omitted in every case because "Due" is not a
 * learner obligation.
 */
const commitmentSourceLines = (rawLines: readonly string[]): readonly string[] => {
  const rows: string[] = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index] ?? '';
    if (!line || isStandaloneDeadlineMetadata(line)) continue;
    const next = rawLines[index + 1] ?? '';
    rows.push(next && isStandaloneDeadlineMetadata(next) ? `${line} ${next}` : line);
  }
  return rows;
};

/**
 * Conservative local extraction for the no-credit path.
 *
 * This deliberately misses clever prose before it guesses. A model-backed
 * intake agent can propose more, but both paths converge on this same draft
 * validator and explicit confirmation boundary.
 */
export function buildDeterministicIntake(input: IntakeBuildInput): CourseIntakeDraft {
  const text = input.text;
  if (!text.trim()) throw new Error('source text is required');
  if (Array.from(text).length > INTAKE_SOURCE_MAX_CHARS) {
    throw new Error(`source text must contain at most ${INTAKE_SOURCE_MAX_CHARS.toLocaleString('en-US')} characters`);
  }
  const sourceTitle = clean(input.sourceTitle || 'Imported course source');
  if (Array.from(sourceTitle).length > COURSE_SOURCE_TITLE_MAX_CHARS) {
    throw new Error(`source title must contain at most ${COURSE_SOURCE_TITLE_MAX_CHARS.toLocaleString('en-US')} characters`);
  }
  const rawLines = text.replace(/\r/g, '').split('\n').map((x) => x.trim());
  const lines = rawLines.filter(Boolean);
  const source: CourseSource = {
    id: input.sourceId,
    kind: input.sourceKind,
    title: sourceTitle,
    text,
    url: input.url && isOpenableUrl(input.url) ? input.url : null,
    capturedAt: input.now,
    digest: input.digest,
  };
  const ref = (line: string): SourceRef => ({ sourceId: source.id, quote: quote(line) });

  const explicitTitle = fieldValue(lines, ['course', 'course title', 'module', 'unit']);
  const first = stripBullet(lines[0] ?? 'Untitled course').replace(/^(syllabus|course outline)\s*[:-]?\s*/i, '');
  const title = (explicitTitle ?? first ?? 'Untitled course').slice(0, 160);
  const provider = (fieldValue(lines, ['provider', 'school', 'university', 'platform']) ?? '').slice(0, 120);

  // Section extraction needs the blank rows. They are the most reliable local
  // evidence that a list ended; filtering them first made a normal outline's
  // schedule, reading and due-date rows look like more objectives.
  const objectiveRows = sectionLines(rawLines, /^(learning\s+)?(objectives?|outcomes?)\s*:?s*$/i);
  const objectives: CourseObjective[] = objectiveRows
    .map((line) => ({ line, text: stripBullet(line) }))
    .filter((x) => x.text.length >= 4)
    .slice(0, 20)
    .map((x) => ({ id: input.id(), text: x.text.slice(0, 300), source: ref(x.line) }));

  const material: IntakeMaterial[] = [];
  const seenUrls = new Set<string>();
  for (const line of lines) {
    const urls = line.match(/https?:\/\/[^\s<>()\]"']+/gi) ?? [];
    let addedFromUrl = false;
    for (const raw of urls) {
      const url = raw.replace(/[.,;:!?]+$/, '');
      if (!isOpenableUrl(url) || seenUrls.has(url)) continue;
      seenUrls.add(url);
      addedFromUrl = true;
      const before = materialTitle(line, raw);
      material.push({
        id: input.id(), title: (before || new URL(url).hostname).slice(0, 180), url,
        kind: materialKind(line, url), minutes: minutesFrom(line), source: ref(line),
      });
    }
    if (addedFromUrl) continue;

    // A link is optional in the material model and in My studies' own form.
    // Keep the deterministic no-credit extractor equally honest: an explicit
    // syllabus label names material even when the resource lives in a book,
    // classroom or LMS with no URL in the outline. The label is the boundary;
    // generic schedule prose still produces nothing.
    const labelled = /^(?:reading|read|video|lecture|class|workshop|tutorial|exercise|practice|lab)\s*:\s*(\S.*)$/i
      .exec(stripBullet(line));
    if (!labelled) continue;
    const named = labelled[1] ?? '';
    // A refused/unsafe URL cannot become harmless-looking linkless material.
    if (/https?:\/\//i.test(named)
        || /\b(?:javascript|data|file|chrome|chrome-extension):/i.test(named)) continue;
    const title = materialTitle(line, '');
    if (!title) continue;
    material.push({
      id: input.id(), title: title.slice(0, 180), url: '',
      kind: materialKind(line, ''), minutes: minutesFrom(line), source: ref(line),
    });
  }

  const rubricLines = sectionLines(rawLines, /^(marking\s+)?(rubric|criteria)\s*:?s*$/i);
  const criteria: IntakeRubricCriterion[] = rubricLines
    .map((line) => ({ line, text: stripBullet(line) }))
    .filter((x) => x.text.length >= 3)
    .slice(0, 20)
    .map((x) => ({
      id: input.id(), label: x.text.split(/[:–—-]/, 1)[0]!.slice(0, 100),
      description: x.text.slice(0, 400), topicIds: [], source: ref(x.line),
    }));

  const commitmentRows = commitmentSourceLines(rawLines).filter((line, index) =>
    /\b(assignment|essay|project|exam|quiz|assessment|presentation|report|deadline|due)\b/i.test(line)
    && !/^(assessments?|deadlines?|assignments?)\s*:?\s*$/i.test(line)
    && !isCommitmentTableHeader(line)
    && !isCommitmentDocumentHeading(line, index));
  const proposed: IntakeCommitment[] = commitmentRows.slice(0, 30).map((line, index) => {
    const deadline = unambiguousDeadline(line, input.timeZone ?? 'UTC');
    // The date clause is cut off the title because it is already shown beside
    // it; `trimDangling` takes the punctuation that clause was attached by, so
    // the row does not read as a sentence somebody truncated.
    const bulletless = stripBullet(line);
    const withoutNamedDeadline = bulletless.replace(/\s+(?:due|deadline)\s*[:–—-]?.*$/i, '');
    const stem = trimDangling(withoutNamedDeadline === bulletless
      ? stripAcceptedDateTail(bulletless, deadline.dueAt !== null)
      : withoutNamedDeadline);
    return {
      id: input.id(), title: (stem || `Assessment ${index + 1}`).slice(0, 180),
      kind: kindFor(line), ...deadline, plannedFor: null, estimateMinutes: minutesFrom(line),
      notes: '', topicIds: [], rubricCriteria: index === 0 ? criteria : [], source: ref(line),
    };
  });
  // Before the questions below, which index into this list.
  const commitments = collapseSameDayDuplicates(proposed);

  const questions: IntakeQuestion[] = [];
  if (!explicitTitle && !first) {
    questions.push({ id: input.id(), field: 'course.title', prompt: 'What should this course be called?', source: null, blocking: true, resolvedAt: null });
  }
  commitments.forEach((c, index) => {
    if (!c.dueAt) {
      questions.push({
        id: input.id(), field: `commitments.${index}.dueAt`,
        prompt: ambiguousNumericDate(c.source.quote)
          ? `What date does “${c.source.quote}” mean?`
          : `When is “${c.title}” due?`,
        source: c.source, blocking: true, resolvedAt: null,
      });
    }
  });

  const warnings: string[] = [];
  if (input.url && !source.url) warnings.push('The supplied source URL was not an http(s) link and was not imported.');
  if (!objectives.length) warnings.push('No explicit learning objectives were found.');
  if (!commitments.length) warnings.push('No assessed obligations or deadlines were found.');

  return {
    id: input.draftId, status: 'draft', source, title, provider,
    url: source.url ?? '', objectives, material, commitments, questions, warnings,
    createdAt: input.now, appliedAt: null,
  };
}

export function unresolvedBlockingQuestions(draft: CourseIntakeDraft): readonly IntakeQuestion[] {
  return draft.questions.filter((q) => {
    if (!q.blocking || q.resolvedAt !== null) return false;
    const commitment = /^commitments\.(\d+)\./.exec(q.field);
    if (!commitment) return true;
    const proposed = draft.commitments[Number(commitment[1])];
    return proposed ? !isIntakeProposalRejected(draft, 'commitment', proposed.id) : true;
  });
}

export function isIntakeProposalRejected(
  draft: CourseIntakeDraft, kind: IntakeProposalKind, id: string,
): boolean {
  return (draft.rejected ?? []).some((entry) => entry.kind === kind && entry.id === id);
}

/** Reject or restore one exact proposal without deleting its evidence. */
export function setIntakeProposalRejected(
  draft: CourseIntakeDraft, kind: IntakeProposalKind, id: string,
  rejected: boolean, now: string,
): CourseIntakeDraft {
  if (draft.status !== 'draft') throw new Error('an applied intake cannot be edited');
  const rows = kind === 'objective' ? draft.objectives
    : kind === 'material' ? draft.material : draft.commitments;
  if (!rows.some((row) => row.id === id)) throw new Error(`no such ${kind} proposal`);
  const without = (draft.rejected ?? []).filter((entry) => !(entry.kind === kind && entry.id === id));
  return {
    ...draft,
    rejected: rejected ? [...without, { kind, id, rejectedAt: now }] : without,
  };
}

/**
 * IS THIS DRAFT OWED A LOOK FROM THE INTAKE PLANNER?
 *
 * The same distinction `Store.listPins({ unenrichedOnly: true })` makes about a
 * pin, and made here for the same reason: *owed an attempt* is not *has no
 * enrichment record*. A draft the specialist read and found nothing to add to is
 * not owed another attempt — the model answered, and asking it the same question
 * every night for ever would be paying to be told the same thing. A draft whose
 * call failed **is** owed one, and gets it on the next run.
 *
 * This is the reason a course drop can be honest about pacing at all. A semester
 * arrives as one gesture and the deterministic pass runs on every document
 * immediately; the model pass is the expensive half — `deep`, reasoning on, one
 * call per syllabus — and it is what the nightly works through over however many
 * nights the cap takes. An applied draft is never owed anything: the learner has
 * already turned it into a course, and enriching it afterwards would be proposing
 * changes to a decision they have made.
 */
export function owesIntakeEnrichment(draft: CourseIntakeDraft): boolean {
  if (draft.status !== 'draft') return false;
  const enrichment = draft.enrichment;
  if (!enrichment) return true;
  return enrichment.outcome === 'model-failed';
}

const editDate = (value: string): string => {
  const visible = value.trim();
  const dateOnly = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(visible);
  if (dateOnly) {
    const parsed = utcDate(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    if (!parsed) throw new Error('that value is not a date');
    return parsed;
  }
  const parsed = Date.parse(visible);
  if (Number.isNaN(parsed)) throw new Error('that value is not a date');
  const dt = new Date(parsed);
  // For explicit ISO timestamps, reject calendar values JavaScript normalized.
  const iso = /^(20\d{2})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(visible);
  if (iso && (dt.getUTCFullYear() !== Number(iso[1]) || dt.getUTCMonth() !== Number(iso[2]) - 1
      || dt.getUTCDate() !== Number(iso[3]) || dt.getUTCHours() !== Number(iso[4])
      || dt.getUTCMinutes() !== Number(iso[5]))) throw new Error('that value is not a date');
  return dt.toISOString();
};

/**
 * Apply one learner correction without accepting an arbitrary object graph.
 *
 * The source text remains immutable. Only explicitly reviewable proposal
 * fields can change, and resolving a question is coupled to changing the field
 * it asked about so a bare “dismiss” cannot bless an absent deadline.
 */
export function editIntakeDraft(
  draft: CourseIntakeDraft, field: string, value: string, now: string, timeZone = 'UTC',
): CourseIntakeDraft {
  if (draft.status !== 'draft') throw new Error('an applied intake cannot be edited');
  const visible = clean(value);
  const bounded = (maxChars: number, label: string): string => {
    if (Array.from(visible).length > maxChars) {
      throw new Error(`${label} must contain at most ${maxChars.toLocaleString('en-US')} characters`);
    }
    return visible;
  };
  let next: CourseIntakeDraft;
  const rejection = /^rejected\.(objective|material|commitment)\.(.+)$/.exec(field);
  if (rejection) {
    if (value !== 'true' && value !== 'false') throw new Error('proposal rejection must be true or false');
    next = setIntakeProposalRejected(
      draft, rejection[1] as IntakeProposalKind, rejection[2]!, value === 'true', now,
    );
  } else if (field === 'title') {
    if (!visible) throw new Error('course title is required');
    next = { ...draft, title: bounded(INTAKE_TEXT_LIMITS.title, 'course title') };
  } else if (field === 'provider') {
    next = { ...draft, provider: bounded(INTAKE_TEXT_LIMITS.provider, 'provider') };
  } else if (field === 'url') {
    if (visible && !isOpenableUrl(visible)) throw new Error('course URL must be http(s)');
    next = { ...draft, url: visible };
  } else {
    const match = /^(objectives|material|commitments)\.(\d+)\.(text|title|url|dueAt|dueTime|kind|minutes)$/.exec(field);
    if (!match) throw new Error('that intake field cannot be edited');
    const index = Number(match[2]);
    const property = match[3]!;
    if (match[1] === 'objectives' && property === 'text') {
      if (!draft.objectives[index] || !visible) throw new Error('objective text is required');
      next = { ...draft, objectives: draft.objectives.map((x, i) => i === index
        ? { ...x, text: bounded(INTAKE_TEXT_LIMITS.objective, 'objective') } : x) };
    } else if (match[1] === 'material'
        && (property === 'title' || property === 'url' || property === 'kind' || property === 'minutes')) {
      if (!draft.material[index]) throw new Error('no such material row');
      if (property === 'url' && visible && !isOpenableUrl(visible)) throw new Error('material URL must be http(s)');
      if (property === 'title' && !visible) throw new Error('material title is required');
      if (property === 'kind' && !(['video', 'reading', 'class', 'exercise', 'other'] as const).includes(visible as MaterialKind)) {
        throw new Error('material kind is not recognised');
      }
      if (property === 'minutes') {
        const minutes = visible ? Number(visible) : null;
        if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 600)) {
          throw new Error('material minutes must be a whole number from 1 to 600');
        }
        next = {
          ...draft,
          material: draft.material.map((x, i) => i === index ? { ...x, minutes } : x),
        };
      } else {
        const corrected = property === 'title'
          ? bounded(INTAKE_TEXT_LIMITS.materialTitle, 'material title') : visible;
        next = {
          ...draft,
          material: draft.material.map((x, i) => i === index ? {
            ...x, [property]: property === 'kind' ? visible as MaterialKind : corrected,
          } : x),
        };
      }
    } else if (match[1] === 'commitments'
        && (property === 'title' || property === 'dueAt' || property === 'dueTime')) {
      if (!draft.commitments[index]) throw new Error('no such commitment row');
      if (property === 'title' && !visible) throw new Error('commitment title is required');
      const current = draft.commitments[index]!;
      if (property === 'title') {
        next = { ...draft, commitments: draft.commitments.map((x, i) =>
          i === index
            ? { ...x, title: bounded(INTAKE_TEXT_LIMITS.commitmentTitle, 'assignment title') }
            : x) };
      } else if (property === 'dueAt') {
        const changed = current.dueTime && current.dueTimeZone
          ? resolveLocalDeadline(visible, current.dueTime, current.dueTimeZone)
          : editDate(value);
        if (!changed) throw new Error('that date and time do not exist in this timezone');
        next = { ...draft, commitments: draft.commitments.map((x, i) =>
          i === index ? { ...x, dueAt: changed } : x) };
      } else if (!visible) {
        const currentDay = current.dueAt === null ? ''
          : current.dueTime && current.dueTimeZone
            ? deadlineDay({ dueAt: current.dueAt, dueTime: current.dueTime, dueTimeZone: current.dueTimeZone })
            : current.dueAt.slice(0, 10);
        const dateOnly = editDate(currentDay);
        next = { ...draft, commitments: draft.commitments.map((x, i) =>
          i === index ? { ...x, dueAt: dateOnly, dueTime: null, dueTimeZone: null } : x) };
      } else {
        if (!/^\d{2}:\d{2}$/.test(visible)) throw new Error('that value is not a time');
        const date = current.dueAt === null ? ''
          : current.dueTime && current.dueTimeZone
            ? deadlineDay({ dueAt: current.dueAt, dueTime: current.dueTime, dueTimeZone: current.dueTimeZone })
            : current.dueAt.slice(0, 10);
        const resolved = resolveLocalDeadline(date, visible, timeZone);
        if (!resolved) throw new Error('that date and time do not exist in this timezone');
        next = { ...draft, commitments: draft.commitments.map((x, i) =>
          i === index ? { ...x, dueAt: resolved, dueTime: visible, dueTimeZone: timeZone } : x) };
      }
    } else {
      throw new Error('that intake field cannot be edited');
    }
  }
  const questionField = field === 'title' ? 'course.title' : field;
  return {
    ...next,
    questions: next.questions.map((q) => q.field === questionField ? { ...q, resolvedAt: now } : q),
  };
}

/** Validate a learner-edited draft at the write boundary. */
export function validateIntakeDraft(draft: CourseIntakeDraft): readonly string[] {
  const errors: string[] = [];
  if (!draft.title.trim()) errors.push('course title is required');
  if (draft.status !== 'draft') errors.push('only a draft can be applied');
  if (unresolvedBlockingQuestions(draft).length) errors.push('blocking questions must be resolved');
  if (draft.url && !isOpenableUrl(draft.url)) errors.push('course URL must be http(s)');
  for (const m of draft.material) {
    if (!isIntakeProposalRejected(draft, 'material', m.id) && m.url && !isOpenableUrl(m.url)) {
      errors.push(`material URL is unsafe: ${m.title}`);
    }
  }
  for (const c of draft.commitments) {
    if (isIntakeProposalRejected(draft, 'commitment', c.id)) continue;
    if (!c.title.trim()) errors.push('commitment title is required');
    if (!c.dueAt || Number.isNaN(Date.parse(c.dueAt))) errors.push(`commitment due date is required: ${c.title || 'untitled'}`);
    if ((c.dueTime && !c.dueTimeZone) || (!c.dueTime && c.dueTimeZone)) {
      errors.push(`commitment deadline time is incomplete: ${c.title || 'untitled'}`);
    }
  }
  return errors;
}
