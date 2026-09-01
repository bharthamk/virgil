import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReadinessLine } from '../check-surface.js';
import { MODEL_PAGE_TITLE, MODEL_EMPTY_KICKER, MODEL_EMPTY_TITLE,
  MODEL_EMPTY_EVIDENCE_LINE } from '../insights.js';
import {
  boardGroups, contestConfirmLines, contestedLine, deleteStatementConfirmLines,
  lessonCorrectionFailedLine, lessonCorrectionReceiptLine,
  domainListNote, esc, hasSomethingReady, isPausedNow,
  mergeConfirmLines, modelEmptyLine, compatibilityReading, offersContest, offLimitsLines,
  parseDomainList, PAUSE_CHOICES, PAUSE_INDEFINITELY, PAUSE_SCOPE_LINE,
  PROCESSING_PAUSED_LINE, pausedBannerNote,
  pauseStateLine, pauseUntil,
  registerLabel, safeHref, sourceAvailabilityLine, sourceLine, sourcesLabel, splitConfirmLines,
  splitRefusal, splittable, unresolvedSourcesLine,
  TOPIC_LABEL_MAX_CHARS, TOPIC_LABEL_LIMIT_LINE,
  statementBadge, statementEditAction, statementEditChanged, statementEditLabel,
  statementEditNoChangeLine, statementEditRefusal,
  statementDeleteAction, statementConfirmAction, statementActionLabel, statementEvidenceLines,
  unusedModelProvidersLine,
  statementAddRefusal, MODEL_INTRO_LINE, MODEL_ADD_ACTION, MODEL_ADD_LABEL,
  MODEL_ADD_MATERIAL_ACTION, LEARNER_STATEMENT_MAX_CHARS, MODEL_INSIGHT_LIMIT_LINE,
  MODEL_ADD_PLACEHOLDER, MODEL_CORRECTION_SAVED_LINE, things, when,
  andNMore, awardsHeading, boardDoorLabel, cardHeading, cardIsStartable, flaggedLine,
  matchesSearch, momentumLine, registerChips, RESURFACE_FROM_LESSON, resurfacedLine,
  withheldLines, checkRefusal, findingTopicLine, reviewFramingLine, reviewSummary,
  rubricLimitLine, rubricRefusal,
  CONTEXT_LABEL, contextWhyLine, contextTruncatedLine, reviewTruncatedLine,
  quarantineLine, quarantineGroups, checkUnreadableLine, credentialMissingLine,
  LESSON_ANSWER_REQUIRED, lessonAnswerUnreadableLine, lessonQuestionFailedLine,
  matchesPinSearch, searchCommitments, searchCourses, searchEmptyLine, searchMissLine,
  SEARCH_BOARD_HEADING, SEARCH_COURSES_HEADING, SEARCH_COURSES_WAITING,
  SEARCH_COURSES_UNREADABLE, SEARCH_PLAN_HEADING,
  plannedAfterDueLine, PLAN_MENU_NOTE,
  BUILD_ALREADY_RUNNING_LINE, BUILD_NOT_STARTED_LINE, BUILD_STARTED_LINE, buildRefusedLine,
  BUILDING_NOW_LINE, buildingStageLine, batchActivityLine, batchRecoveryAction,
  batchStageReceiptLine, LEAN_NIGHT_LINE, type BatchActivityView,
  USAGE_HEADING, USAGE_SINCE_LINE, USAGE_TAPS_LABEL, USAGE_RUNS_LABEL, USAGE_TOTAL_LABEL,
  USAGE_WHICH_BILLS, usageCountLine, usageEmbedLine,
  LINK_TO_TOPICS, LINK_TO_TOPICS_FAILED, LINK_TO_TOPICS_NOTE, LINK_TO_TOPICS_SAVE,
  linkedTopicsLine,
  UPLOAD_ACTION, uploadHowLine, uploadOutcomeLine, READING_FILE, RENDERING_PAGES,
  CHECK_TITLE, DRAFT_LABEL, RUBRIC_LABEL, draftWhyLine,
  attachedPagesLine, attachedMeterNote, pagesOutcomeLine, noTextKeptPagesLine,
  scannedRubricLine, sourceImageReadLine, sourceImageTranscriptionLine,
  transcribeOutcomeLine, repairImportedRubric,
  CHECK_LIMITS_FALLBACK, checkLimitsFrom, draftCap, rubricSoftCap, sizeWarningLine,
  checkHandoffLines, filePendingLine, fileBlockingLine, fileLeftOutLine, LEAVE_FILE_OUT,
  windowWarningLine, SIZE_WARN_AT, CHARS_PER_TOKEN,
  findingPinOffer, FINDING_PIN_ACTION, FINDING_PIN_DONE, FINDING_LEARN_ACTION, FINDING_PIN_FAILED,
  BOARD_EXIT,
  quickTakeFailedLine, quickTakeStandingLine,
  shortLabel,
  type SessionCardView, type SectionView, type SessionView, type TopicView,
  dropInOrder, lineupItems, lineupBuiltLine, lineupLevelLine, lineupSummary,
  learningAlternatives, upcomingItems, boundedQuickTakeWindow, INSTEAD_HEADING,
  HELD_BACK_TAKE_LINE, preparedReadyLine, railRowLabel,
  MODEL_NOTICE, CHECK_RESULT_STALE, RAIL_EMPTY_HEADING, RAIL_EMPTY_LINE,
  RAIL_ONE_MOVE_HEADING, RAIL_ONE_MOVE_LINE,
  RAIL_CAUGHT_UP_HEADING, RAIL_CAUGHT_UP_LINE,
  expectedTimeLine, remainingMinutes,
  SESSION_UP_NEXT, SESSION_DONE_HEADING, SESSION_NEXT, SESSION_FINISH,
  SESSION_NOT_REFRESHED, lessonCompletionLine, sessionClosingLine, sessionRailLine,
  LINEUP_SUMMARY_CHARS,
  lineupHeading, LINEUP_HEADING_SENT,
  lineupRemovedLine, lineupVerdictLine, lineupWhyLine, moveInOrder,
  LINEUP_BAD_LABEL, LINEUP_DOWN_LABEL, LINEUP_GOOD_LABEL,
  LINEUP_NOT_SAVED, LINEUP_REMOVE_LABEL,
  LINEUP_UP_LABEL, LINEUP_WHY_LABEL,
  PINNED_PREVIEW, pinnedHeading, pinnedNote, pinnedPreview,
  ASK_SHORTCUTS,
  ADD_ROUTES, DOORS, DOOR_KEYS, ROOM_KEYS, FACES, FACE_TOGGLE_LABEL, groupMaterial, MATERIAL_GROUPS, nextUpLine,
  budgetReadingFrom, budgetStatusLine, budgetWindowLine, budgetConnectionLine,
  budgetIssuedLine, budgetTotalLine, budgetLimitRefusal, guideFailedLine,
  BUDGET_TOKENS_NOT_MONEY, BUDGET_GUARD_LINE, BUDGET_SAVE_NOTE, BUDGET_CLEAR_NOTE,
  BUDGET_RESET_NOTE, BUDGET_STOPPED_LINE, MAX_BUDGET_TOKENS_VIEW,
  budgetFreeRouteLine,
  calendarDays, calendarStart, calendarWeeks, commitmentDueDay, dayKey, dueLine,
  estimateLine, laneOf, localDayKey,
  planLanes, plannedForFromDrop, plannedLine, recurrenceLine, tutorLine, weeklyPreviewDates,
  CALENDAR_WEEKS, PLAN_ADD_ROUTES, PLAN_LANES, PLAN_LANE_EMPTY, PLAN_SESSION_NOTE,
  WEEKDAYS, type CommitmentView,
} from '../panel-core.js';
/** The lesson's own copy and its one pure decision live with the surfaces that
 *  draw them, the way `process-bar.ts` keeps the strip's. */
import { lessonTitle } from '../lesson.js';
import {
  QUICK_TAKE_ANSWER_UNCHANGED, QUICK_TAKE_CHOICES, QUICK_TAKE_CLOSE_FAILED,
  isQuickTakeVerdict, quickTakeAnsweredLine,
} from '../quick-take-close.js';
import { ARRIVAL_WAYS, ARRIVAL_WAYS_HEADING } from '../arrival.js';

const compatibleHealth = () => ({
  ok: true,
  compatibility: {
    protocol: 'virgil-browser-service', serviceSchema: 1,
    minClientSchema: 1, maxClientSchema: 1, modelConfigSchema: 1,
  },
});

test('compatibility receipts name the installed half that needs attention', () => {
  assert.equal(compatibilityReading(compatibleHealth(), { schemaVersion: 1 }).status, 'compatible');
  assert.equal(compatibilityReading({ ok: true }, { schemaVersion: 1 }).status, 'update-service');
  assert.equal(compatibilityReading({
    ok: true, compatibility: {
      protocol: 'virgil-browser-service', serviceSchema: 1,
      minClientSchema: 2, maxClientSchema: 2, modelConfigSchema: 1,
    },
  }, { schemaVersion: 1 }).status, 'update-extension');
  assert.equal(compatibilityReading(compatibleHealth(), { schemaVersion: 2 }).status, 'service-mismatch');
  assert.equal(compatibilityReading(null, null).status, 'unreachable');
});

test('compatibility copy gives one recovery step without exposing internal schema language', () => {
  const readings = [
    compatibilityReading({ ok: true }, null),
    compatibilityReading({
      ok: true, compatibility: {
        protocol: 'virgil-browser-service', serviceSchema: 1,
        minClientSchema: 2, maxClientSchema: 2, modelConfigSchema: 1,
      },
    }, { schemaVersion: 1 }),
    compatibilityReading(compatibleHealth(), { schemaVersion: 2 }),
  ];
  assert.match(readings[0]!.detail, /Update and restart Virgil/);
  assert.match(readings[1]!.detail, /Update the extension/);
  assert.match(readings[2]!.detail, /Update all Virgil files together/);
  assert.doesNotMatch(readings.map((reading) => `${reading.label} ${reading.detail}`).join(' '),
    /schema|protocol|stack|path|version 1/i);
});

/**
 * The panel's judgements. The template strings around them are not where the
 * risk is — the risk is a screen claiming a session is shorter or emptier than
 * it is, and the confirm sentences, which are the only promise the learner gets
 * that a merge or a split will not eat their history.
 */

const NOW = Date.parse('2026-08-19T21:00:00.000Z');
const minutesAgo = (n: number): string => new Date(NOW - n * 60_000).toISOString();

test('weekly preview and position copy stay bounded calendar facts', () => {
  assert.deepEqual(weeklyPreviewDates('2026-12-27', 3), [
    '2026-12-27', '2027-01-03', '2027-01-10',
  ]);
  assert.deepEqual(weeklyPreviewDates('2026-02-30', 3), []);
  assert.deepEqual(weeklyPreviewDates('2026-12-27', 21), []);
  assert.equal(recurrenceLine({ recurrence: {
    seriesId: 'series-one', index: 2, total: 10, cadence: 'weekly',
    timeZone: 'Australia/Sydney', requestHash: `sha256:${'a'.repeat(64)}`,
  } }), 'Weekly · 3 of 10.');
  assert.equal(recurrenceLine({ recurrence: null }), '');
});

const section = (over: Partial<SessionView['sections'][number]> = {}): SessionView['sections'][number] => ({
  depth: 'building', estimatedMinutes: 5, sourceIds: ['s1'], completed: false, ...over,
});
const topic = (id: string, state: string, pins = 1): TopicView =>
  ({ id, label: id, state, pinIds: Array.from({ length: pins }, (_, i) => `p${i}`) });

// ------------------------------------------------------------------- the clock

test('a recent build is stated in minutes — it is the evidence work happened', () => {
  assert.equal(when(minutesAgo(3), NOW), '3 min ago');
  assert.equal(when(minutesAgo(89), NOW), '89 min ago');
});

test('past an hour and a half it becomes a time of day', () => {
  const iso = minutesAgo(120);
  const t = new Date(iso);
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  assert.equal(when(iso, NOW), `at ${hhmm}`);
});

test('past twenty hours it becomes days', () => {
  assert.equal(when(minutesAgo(60 * 48), NOW), '2 days ago');
  assert.equal(when(minutesAgo(60 * 21), NOW), '1 day ago');
});

test('clock skew never becomes negative time on screen', () => {
  assert.equal(when(minutesAgo(0), NOW), 'just now');
  assert.equal(when(minutesAgo(-5), NOW), 'just now');
  assert.equal(when(minutesAgo(-6), NOW), null,
    'a materially future timestamp is not presented as recency');
});

test('a timestamp that is not a date has no words, rather than nonsense words', () => {
  // `Date.parse` of anything it does not recognise is NaN, and every arithmetic
  // path below it inherits the NaN: the card read "built NaN min ago from 6
  // things you pinned". Saying nothing is the only honest answer here — the
  // panel does not know when this was built, and inventing a number is worse
  // than the missing clause, because the learner cannot tell an invented
  // timestamp from a real one.
  assert.equal(when('yesterday-ish', NOW), null);
  assert.equal(when('', NOW), null);
  assert.equal(when('2026-13-45T99:99:99Z', NOW), null);
  // Not a date at all, and not a number either — `Date.parse` of a bare number
  // string is one of the places it silently succeeds, so this is asserted from
  // both sides rather than assumed.
  assert.equal(when('NaN', NOW), null);
});

// ------------------------------------------------------- something to open at all

test('an honest empty state, rather than a session manufactured to look busy (SB-23)', () => {
  assert.equal(hasSomethingReady(null), false);
  assert.equal(hasSomethingReady({ builtAt: minutesAgo(5), fromPinCount: 0, sections: [] }), false);
  assert.equal(hasSomethingReady({ builtAt: minutesAgo(5), fromPinCount: 1, sections: [section()] }), true);
});

test('a failed lesson question keeps the question and names the actionable cause', () => {
  assert.match(lessonQuestionFailedLine('unreachable'), /question is still here/);
  assert.match(lessonQuestionFailedLine('budget'), /budget stopped this before anything was sent/);
  assert.match(lessonQuestionFailedLine('credential'), /model connection needs attention/);
  assert.match(lessonQuestionFailedLine('empty'), /No answer came back/);
  assert.match(lessonQuestionFailedLine('refused'), /could not answer/);
});

test('a session-shaped answer with no sections in it is not ready either', () => {
  // Asked about a body that came off the wire, so the shape is checked and not
  // just the length: this used to throw, and the throw took renderHome down
  // mid-render and left the panel showing its title and nothing else.
  const shapeless = { builtAt: minutesAgo(5), fromPinCount: 2 } as unknown as SessionView;
  assert.equal(hasSomethingReady(shapeless), false);
  assert.equal(hasSomethingReady({ ...shapeless, sections: null as unknown as [] }), false);
});

// ------------------------------------------------------------ SB-44 sources

test('SB-117: source availability says what the learner confirmed, not that the words were verified', () => {
  assert.equal(sourceAvailabilityLine(null), 'No link check saved.');
  assert.equal(sourceAvailabilityLine({
    status: 'available', checkedAt: '2026-08-14T09:00:00Z', checkedBy: 'learner',
  }), 'You confirmed this link opened on 14 Aug. The saved quote has not been rechecked.');
  assert.equal(sourceAvailabilityLine({
    status: 'unavailable', checkedAt: '2026-08-14T09:00:00Z', checkedBy: 'learner',
  }), 'You could not open this link on 14 Aug. Your saved quote is still here.');
});

test('SB-44: a pinned source says it was the learner\'s own page, and when they saved it', () => {
  // The story's own words: "From the page you pinned on 14 Aug".
  assert.equal(
    sourceLine({ id: 'p1:origin', origin: 'user-pin', title: 'ADK — Sessions', url: 'https://x.test/a', at: '2026-08-14T09:00:00Z' }),
    'From the page you pinned on 14 Aug',
  );
});

test('SB-10: a pinned video says which moment of it the learner kept', () => {
  // The story's step 3 — "the session later opens at that moment" — needs the
  // moment to be visible as well as followable, or the learner cannot tell a
  // link that will seek from one that will not.
  assert.equal(
    sourceLine({
      id: 'p1:origin', origin: 'user-pin', title: 'ADK, end to end',
      url: 'https://www.youtube.com/watch?v=abc&t=754s', at: '2026-08-14T09:00:00Z', moment: 754,
    }),
    'From the video you pinned on 14 Aug, at 12:34',
  );
  assert.equal(
    sourceLine({
      id: 'p1:origin', origin: 'user-pin', title: null, url: null, at: null, moment: 754,
    }),
    'From a video you pinned, at 12:34',
  );
});

test('SB-10: the moment reads as a person would say it, at any length', () => {
  const line = (moment: number): string | null =>
    sourceLine({ id: 'p:origin', origin: 'user-pin', title: null, url: null, at: null, moment });
  assert.equal(line(9), 'From a video you pinned, at 0:09');
  assert.equal(line(70), 'From a video you pinned, at 1:10');
  assert.equal(line(3725), 'From a video you pinned, at 1:02:05');
});

test('SB-10: a moment it cannot read is a clause it does not write', () => {
  // Same rule as the date above. The pin is still a real pin and still says so;
  // it is the timestamp clause that goes, and with it the word "video".
  for (const moment of [0, -1, 1.5, Number.NaN, null, undefined]) {
    assert.equal(
      sourceLine({
        id: 'p1:origin', origin: 'user-pin', title: null, url: null,
        at: '2026-08-14T09:00:00Z', moment: moment as number | null,
      }),
      'From the page you pinned on 14 Aug',
      `${String(moment)} was rendered as a moment`,
    );
  }
});

test('SB-11: a pinned PDF says which page of it, so a 90-page paper is followable', () => {
  assert.equal(
    sourceLine({
      id: 'p1:origin', origin: 'user-pin', title: 'Attention is all you need',
      url: 'https://x.test/attention.pdf#page=3', at: '2026-08-14T09:00:00Z', page: 3,
    }),
    'From the PDF you pinned on 14 Aug, page 3',
  );
  assert.equal(
    sourceLine({ id: 'p1:origin', origin: 'user-pin', title: null, url: null, at: null, page: 3 }),
    'From a PDF you pinned, page 3',
  );
});

test('SB-11: a page number it cannot read is a clause it does not write', () => {
  for (const page of [0, -2, 1.5, Number.NaN, null, undefined]) {
    assert.equal(
      sourceLine({
        id: 'p1:origin', origin: 'user-pin', title: null, url: null,
        at: '2026-08-14T09:00:00Z', page: page as number | null,
      }),
      'From the page you pinned on 14 Aug',
      `${String(page)} was rendered as a page number`,
    );
  }
});

test('SB-44: an agent-sourced reference is marked as not the learner\'s', () => {
  // The other half of the demand: the two are VISIBLY distinct. A reference the
  // agent went and found is the one a sceptical learner most needs flagged,
  // because it is the one they never chose to trust.
  assert.equal(
    sourceLine({ id: 'p1:ref-1', origin: 'agent-sourced', title: 'Ack deadlines', url: 'https://x.test/b', at: '2026-08-15T03:00:00Z' }),
    'Background reading I found, not from your pins',
  );
});

test('SB-44: a date it cannot read is a clause it does not write', () => {
  assert.equal(
    sourceLine({ id: 'p1:origin', origin: 'user-pin', title: null, url: null, at: 'whenever' }),
    'From a page you pinned',
  );
  assert.equal(
    sourceLine({ id: 'p1:origin', origin: 'user-pin', title: null, url: null, at: null }),
    'From a page you pinned',
  );
});

test('SB-44: a source whose origin is neither is not described at all', () => {
  // The same rule as a flagged row with no provenance: the one thing this
  // surface may never do is describe a source it cannot account for.
  assert.equal(
    sourceLine({ id: 'x', origin: 'somewhere-else', title: 't', url: 'https://x.test', at: null }),
    null,
  );
});

test('SB-44: only an http(s) link is offered as a link', () => {
  // The url comes off a page the learner visited or a page the agent fetched.
  // `javascript:` in an href inside the panel is script in the panel's own
  // origin, which has the session, the board and the model behind it.
  assert.equal(safeHref('https://x.test/a'), 'https://x.test/a');
  assert.equal(safeHref('http://x.test/a'), 'http://x.test/a');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('JavaScript:alert(1)'), null);
  assert.equal(safeHref(' javascript:alert(1)'), null);
  assert.equal(safeHref('data:text/html,<script>'), null);
  assert.equal(safeHref('https://alice:secret@x.test/private'), null);
  assert.equal(safeHref('chrome-extension://abc/panel.html'), null);
  assert.equal(safeHref('not a url'), null);
  assert.equal(safeHref(null), null);
});

test('SB-44: a reference that could not be resolved is said out loud, not dropped in silence', () => {
  assert.equal(unresolvedSourcesLine(0), null);
  assert.equal(unresolvedSourcesLine(1), '1 reference could not be shown. I could not trace it back.');
  assert.equal(unresolvedSourcesLine(3), '3 references could not be shown. I could not trace them back.');
});

test('section furniture reads naturally at one and at many', () => {
  assert.equal(sourcesLabel(1), '1 source · why am I seeing this?');
  assert.equal(sourcesLabel(3), '3 sources · why am I seeing this?');
  assert.equal(things(1), '1 thing');
  assert.equal(things(0), '0 things');
  assert.equal(registerLabel('from-nothing'), 'new to you');
  assert.equal(registerLabel('fluent'), 'fluent');
});

// ------------------------------------------------------------------- the board

test('the board is grouped working, waiting, settled — in that order', () => {
  const groups = boardGroups([
    topic('s', 'settled'), topic('w1', 'working'), topic('x', 'waiting'), topic('w2', 'working'),
  ]);
  assert.deepEqual(groups.map((g) => g.heading), ['Working on', 'Waiting', 'Settled']);
  assert.deepEqual(groups[0]!.topics.map((t) => t.id), ['w1', 'w2'], 'and in board order within a group');
});

test('a group with nothing in it is not a heading over empty space', () => {
  const groups = boardGroups([topic('w', 'working')]);
  assert.deepEqual(groups.map((g) => g.key), ['working']);
});

test('a topic in a state the panel does not know about is not shown twice, or at all', () => {
  assert.deepEqual(boardGroups([topic('odd', 'archived')]), []);
});

test('a hostile topic label cannot become markup', () => {
  // Labels come from the model, and the model reads pinned pages.
  assert.equal(
    esc('<img src=x onerror="alert(1)"> & "quoted"'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quoted&quot;',
  );
});

// -------------------------------------------------- what it thinks of you (SB-42)

test('each insight names its origin and the action that fits it', () => {
  assert.equal(statementBadge({ id: 's1', text: 'x', userEdited: true }), 'your words');
  assert.equal(statementBadge({ id: 's1', text: 'x', userEdited: false }), 'my read');
  assert.equal(statementEditAction(false), 'Correct it');
  assert.equal(statementEditAction(true), 'Edit my words');
  assert.equal(statementEditLabel(false), 'Correct this insight');
  assert.equal(statementEditLabel(true), 'Edit your words');
});

test('a repeated insight action names its own bounded statement to assistive technology', () => {
  assert.equal(statementActionLabel('Correct it', 'You learn best from a worked example.'),
    'Correct it: You learn best from a worked example.');
  const label = statementActionLabel('Reject it', `A very long ${'machine-written '.repeat(20)}claim`);
  assert.match(label, /^Reject it: A very long/);
  assert.ok(label.endsWith('…'));
  assert.ok(label.length < 70, label);
});

test('machine Insight evidence is plain, grouped and honest about inactive or missing items', () => {
  assert.deepEqual(statementEvidenceLines({
    id: 'read', text: 'A read.', userEdited: false, evidenceReceipt: 'incomplete',
    evidence: [
      { type: 'answer-wrong', topic: '  IAM   Conditions ', active: true },
      { type: 'answer-wrong', topic: 'IAM Conditions', active: true },
      { type: 'section-abandoned', topic: 'IAM Conditions', active: false },
      { type: 'future-kind', topic: '', active: true },
    ],
  }), [
    'IAM Conditions: answers I marked wrong',
    'IAM Conditions: lessons you left (no longer counts)',
    'A topic no longer on your board: learning activity connected to this topic',
    'Some evidence in this receipt is no longer available.',
  ]);
  assert.deepEqual(statementEvidenceLines({
    id: 'old', text: 'Old.', userEdited: false, evidence: [], evidenceReceipt: 'unitemised',
  }), ['No itemised evidence was saved with this read.']);
  assert.deepEqual(statementEvidenceLines({
    id: 'own', text: 'Mine.', userEdited: true,
  }), []);
});

test('an empty correction is refused by the panel, not by a 400 nobody sees', () => {
  assert.equal(statementEditRefusal('   '), 'Say what it should be instead, or delete it.');
  assert.equal(statementEditRefusal(''), 'Say what it should be instead, or delete it.');
  assert.equal(statementEditRefusal('You prefer an example before the rule.'), null);
});

test('a prefilled machine read is not learner authorship until its words change', () => {
  const admitted = 'You prefer an example before the rule.';
  assert.equal(statementEditChanged(admitted, admitted), false);
  assert.equal(statementEditChanged(`  ${admitted}  `, admitted), false,
    'outside whitespace is removed at the service boundary and is not a correction');
  assert.equal(statementEditChanged('I prefer the rule before an example.', admitted), true);
  assert.match(statementEditNoChangeLine(false), /Virgil's read/);
  assert.match(statementEditNoChangeLine(false), /your words/);
  assert.match(statementEditNoChangeLine(true), /Change your words/);
});

test('a saved correction names its causal effect instead of only repainting the sentence', () => {
  assert.match(MODEL_CORRECTION_SAVED_LINE, /Saved as your words/);
  assert.match(MODEL_CORRECTION_SAVED_LINE, /govern the next lesson/);
});

test('rejecting a machine read and deleting my words state their different effects', () => {
  assert.equal(statementDeleteAction(false), 'Reject it');
  assert.equal(statementDeleteAction(true), 'Delete');
  assert.equal(statementConfirmAction(false), 'Reject this read');
  assert.equal(statementConfirmAction(true), 'Delete insight');
  assert.deepEqual(deleteStatementConfirmLines(), [
    'This read goes now.',
    'It will not come back from the same evidence.',
    'Materially new evidence can support a new read later.',
  ]);
  assert.deepEqual(deleteStatementConfirmLines(true), [
    'This line goes now.', 'It is your words, so Virgil will not recreate it.',
  ]);
});

test('an empty model says why it is empty rather than looking broken', () => {
  assert.equal(modelEmptyLine(),
    'Tell me what helps, what gets in the way, or what you want handled differently next time.');
});

test('Insights lets the learner speak before Virgil has made a read', () => {
  assert.equal(MODEL_PAGE_TITLE, 'What Virgil is learning about you');
  assert.equal(MODEL_INTRO_LINE,
    'These are the things I can carry into future lessons. Your words come first, and you can challenge any read.');
  assert.equal(MODEL_EMPTY_KICKER, 'Your words lead');
  assert.equal(MODEL_EMPTY_TITLE, 'Teach Virgil how to teach you');
  assert.match(MODEL_EMPTY_EVIDENCE_LINE, /confirm, correct or reject/);
  assert.equal(MODEL_ADD_ACTION, 'Tell Virgil something');
  assert.equal(MODEL_ADD_MATERIAL_ACTION, 'Add something to learn');
  assert.equal(MODEL_ADD_LABEL, 'What should Virgil remember for future lessons?');
  assert.match(MODEL_ADD_PLACEHOLDER, /concrete example/);
  assert.equal(statementAddRefusal(''), 'Say what Virgil should know first.');
  assert.equal(statementAddRefusal('  '), 'Say what Virgil should know first.');
  assert.equal(statementAddRefusal('I need diagrams before formulas.'), null);
  assert.match(MODEL_INSIGHT_LIMIT_LINE, /1,000 characters/);
  const exact = '😀'.repeat(LEARNER_STATEMENT_MAX_CHARS);
  assert.equal(statementAddRefusal(exact), null);
  assert.equal(statementEditRefusal(exact), null);
  assert.match(statementAddRefusal(`${exact}x`) ?? '', /nothing was sent/);
  assert.match(statementEditRefusal(`${exact}x`) ?? '', /nothing was sent/);
});

// ----------------------------------------------------------------- concession

test('the concession is offered where the agent can be wrong, and nowhere else (SB-45)', () => {
  assert.equal(offersContest('answer-wrong'), true);
  assert.equal(offersContest('answer-correct'), false, 'there is nothing to take back');
  assert.equal(offersContest('self-skip'), false, 'the learner cannot be wrongly marked by their own skip');
  assert.equal(offersContest('depth-simpler'), false);
  assert.equal(offersContest(null), false);
  assert.equal(offersContest(undefined), false);
});

test('the concession says what happens to the mark before it happens', () => {
  // The middle line is the promise, and it is the whole control: without it this
  // is a complaint button, and a complaint button that changes nothing is worse
  // than no button at all. It is also true — the signal is invalidated and
  // `computeComfort` does not count invalidated rows.
  assert.deepEqual(contestConfirmLines('Acknowledgement deadlines'), [
    'I marked your answer on “Acknowledgement deadlines” wrong.',
    'Tell me I got that wrong and I take the mark back. It stops counting towards what I think you find hard.',
    'Your answer stays as you wrote it. I do not re-mark it, and I do not argue.',
  ]);
});

test('what it says afterwards is a count, not a reassurance', () => {
  assert.equal(contestedLine(1), 'Taken back. 1 mark against you on this no longer counts.');
  assert.equal(contestedLine(3), 'Taken back. 3 marks against you on this no longer count.');
  assert.equal(contestedLine(0), 'Taken back. There was nothing counting against you here.',
    'claiming a win where nothing was withdrawn is exactly the dishonesty this surface exists against');
});

test('a taught-claim correction names both the source recheck and its evidence consequence', () => {
  assert.equal(lessonCorrectionReceiptLine(false, 0),
    'I checked the cited source and did not change the lesson.');
  assert.equal(lessonCorrectionReceiptLine(true, 0),
    'I got this wrong. There was no learning mark from this lesson to take back. The corrected lesson stays here.');
  assert.equal(lessonCorrectionReceiptLine(true, 1),
    'I got this wrong. 1 learning mark from this lesson no longer counts. You do not have to repeat it; the corrected lesson stays here.');
  assert.equal(lessonCorrectionReceiptLine(true, 3),
    'I got this wrong. 3 learning marks from this lesson no longer count. You do not have to repeat it; the corrected lesson stays here.');
});

test('a finished lesson distinguishes completion from withdrawn learning evidence', () => {
  assert.equal(lessonCompletionLine({ completed: false }), null);
  assert.equal(lessonCompletionLine({ completed: true }), 'Lesson finished');
  assert.equal(lessonCompletionLine({ completed: true, contested: true }),
    'Lesson finished · learning evidence withdrawn');
  assert.equal(lessonCompletionLine({ completed: true, corrections: [{ conceded: true, withdrawn: 1 }] }),
    'Lesson finished · learning evidence withdrawn');
  assert.equal(lessonCompletionLine({ completed: true, corrections: [{ conceded: true, withdrawn: 0 }] }),
    'Lesson finished');
});


test('the lineup heading is the part of the day the hour is in, and nothing else', () => {
  for (const hour of [5, 6, 9, 11]) {
    assert.equal(lineupHeading(hour), 'This morning’s lineup', `${hour}:00 is not morning`);
  }
  for (const hour of [12, 13, 16, 17]) {
    assert.equal(lineupHeading(hour), 'This afternoon’s lineup', `${hour}:00 is not afternoon`);
  }
  for (const hour of [18, 21, 23, 0, 3, 4]) {
    assert.equal(lineupHeading(hour), 'Tonight’s lineup', `${hour}:00 is not evening or night`);
  }
  // The boundaries are the whole of the decision, so they are asserted as
  // boundaries rather than as members of a band.
  assert.notEqual(lineupHeading(4), lineupHeading(5));
  assert.notEqual(lineupHeading(11), lineupHeading(12));
  assert.notEqual(lineupHeading(17), lineupHeading(18));

  // A clock that answers something absurd is not a reason to draw nothing. The
  // evening wording is what the service already sends, so it is what an
  // unreadable hour degrades to.
  for (const hour of [-1, 24, 99, Number.NaN]) {
    assert.equal(lineupHeading(hour), 'Tonight’s lineup');
  }
  // And the string the service composes is one of the three, so the swap is a
  // rewording of a known sentence rather than a guess about an unknown one.
  assert.equal(LINEUP_HEADING_SENT, 'Tonight’s lineup');
  assert.equal(lineupHeading(20), LINEUP_HEADING_SENT);
});


test('the two lines over a lesson are clipped from stored facts, never invented', () => {
  assert.deepEqual(lessonTitle('Music Theory Intervals', 'Music Theory'),
    { family: 'Music Theory', area: 'Intervals' });
  // A label that does not begin with the course: both facts are true, neither
  // is edited, and nothing is guessed about how they relate.
  assert.deepEqual(lessonTitle('Counterpoint', 'Music Theory'),
    { family: 'Music Theory', area: 'Counterpoint' });
  // No course on the board for this topic: there is no family to name.
  assert.deepEqual(lessonTitle('How TLS gets its keys', null),
    { family: null, area: 'How TLS gets its keys' });
  // The label IS the course. One name on two lines says nothing twice.
  assert.deepEqual(lessonTitle('Music Theory', 'Music Theory'),
    { family: null, area: 'Music Theory' });
  // A session stored before the qualifier left keeps its colon, and the clip
  // takes the separator with the family rather than leaving it hanging.
  assert.deepEqual(lessonTitle('Music Theory: Intervals', 'Music Theory'),
    { family: 'Music Theory', area: 'Intervals' });
  // Older sessions and thin fixtures: a missing heading is an empty area rather
  // than a throw, and whitespace is normalised on both.
  assert.deepEqual(lessonTitle(undefined, undefined), { family: null, area: '' });
  assert.deepEqual(lessonTitle('  Music   Theory Intervals ', ' Music Theory '),
    { family: 'Music Theory', area: 'Intervals' });
});

test('every failed taught-claim recheck keeps the learner challenge', () => {
  for (const cause of ['source', 'unreachable', 'budget', 'credential', 'refused'] as const) {
    assert.match(lessonCorrectionFailedLine(cause), /challenge is still here/);
    assert.match(lessonCorrectionFailedLine(cause), /Nothing changed/);
  }
  assert.match(lessonCorrectionFailedLine('source'), /cited source/);
});

// --------------------------------------------------------------- merge & split

test('a merge says where the pins go, what happens to the history, and what disappears', () => {
  const lines = mergeConfirmLines(topic('t1', 'working', 3), topic('t2', 'working', 1));
  assert.deepEqual(lines, [
    '3 things you pinned move to “t2”.',
    'The history of “t1” will be kept under “t2”. Nothing you have done is lost.',
    '“t1” disappears from your board. “t2” keeps its name.',
  ]);
});

test('a merge of a single pin reads as a single pin', () => {
  assert.equal(mergeConfirmLines(topic('t1', 'working', 1), topic('t2', 'working'))[0],
    '1 thing you pinned moves to “t2”.');
});

test('a split has to leave something behind', () => {
  assert.equal(splitRefusal(3, 3, 'A name'),
    'A split has to leave something behind. That would move everything.');
});

test('a split needs something to move and a name for it', () => {
  assert.equal(splitRefusal(0, 4, 'A name'), 'Pick at least one thing to move.');
  assert.equal(splitRefusal(2, 4, ''), 'The new topic needs a name. You name it, not me.');
  assert.equal(splitRefusal(2, 4, 'A name'), null);
  assert.match(TOPIC_LABEL_LIMIT_LINE, /60 characters/);
  const exact = '😀'.repeat(TOPIC_LABEL_MAX_CHARS);
  assert.equal(splitRefusal(2, 4, exact), null);
  assert.match(splitRefusal(2, 4, `${exact}x`) ?? '', /nothing was sent/);
});

test('nothing to pick from is refused before the form is offered', () => {
  assert.equal(splittable(1), false);
  assert.equal(splittable(2), true);
});

test('a split says what moves, what stays, and that the new topic starts with nothing', () => {
  const lines = splitConfirmLines(topic('t1', 'working', 5), 2, 5, 'Session state');
  assert.deepEqual(lines, [
    '2 things move to a new topic called “Session state”.',
    '“t1” keeps all of its history, and 3 things stay there.',
    'The new topic starts fresh: nothing is known about it yet.',
  ]);
});

test('a split of one, leaving one, reads as singular on both sides', () => {
  const lines = splitConfirmLines(topic('t1', 'working', 2), 1, 2, 'Elsewhere');
  assert.equal(lines[0], '1 thing moves to a new topic called “Elsewhere”.');
  assert.equal(lines[1], '“t1” keeps all of its history, and 1 thing stays there.');
});

// ------------------------------------------ pause and off limits (SB-40/41)

/**
 * The controls the story assumed and the panel never had.
 *
 * Both preferences were enforceable and unreachable: the service shipped the
 * exclusion list and the endpoint, the extension had the predicate, and there
 * was no pause button and no way to see or change the list. The copy here is a
 * trust control rather than decoration — it is the only place the learner is
 * told what these settings do and, more importantly, what they do not do — so it
 * is asserted verbatim.
 */

test('the screen says whether it is watching before it offers to stop', () => {
  assert.equal(pauseStateLine(null, NOW), 'Watching for what you keep coming back to.');
  assert.equal(pauseStateLine({ pausedUntil: null, excludedDomains: [] }, NOW),
    'Watching for what you keep coming back to.');
});

test('a live pause is counted down, so it is obvious it will end by itself', () => {
  const in40 = new Date(NOW + 40 * 60_000).toISOString();
  assert.equal(pauseStateLine({ pausedUntil: in40, excludedDomains: [] }, NOW),
    'Paused for another 40 min.');
  const in4h = new Date(NOW + 4 * 60 * 60_000).toISOString();
  assert.equal(pauseStateLine({ pausedUntil: in4h, excludedDomains: [] }, NOW),
    'Paused for another 4 hours.');
});

test('an expired pause is not a pause, and the panel agrees with the detector', () => {
  const gone = { pausedUntil: new Date(NOW - 1000).toISOString(), excludedDomains: [] };
  assert.equal(isPausedNow(gone, NOW), false);
  assert.equal(pauseStateLine(gone, NOW), 'Watching for what you keep coming back to.');
  assert.equal(isPausedNow({ pausedUntil: 'sometime next week', excludedDomains: [] }, NOW), false);
});

test('the timed pauses are bounded, and one choice is not timed at all (the collection-pause contract)', () => {
  // This test used to assert that EVERY pause expires by itself, on the builder's
  // reasoning that an indefinite pause is one people forget they set. The collection-pause contract
  // overturned it: with paid compute a forgotten pause costs nothing, while a
  // withheld off-switch spends the learner's money against their intent. The
  // mitigation for forgetting is visibility — the paused banner on the main
  // screen — not a control they were never given.
  const timed = PAUSE_CHOICES.filter((c) => c.minutes !== null);
  assert.equal(timed.length, 3);
  for (const choice of timed) {
    assert.ok(choice.minutes! > 0 && choice.minutes! <= 24 * 60, `${choice.label} is bounded`);
    assert.equal(pauseUntil(choice.minutes, NOW), new Date(NOW + choice.minutes! * 60_000).toISOString());
  }
  const open = PAUSE_CHOICES.filter((c) => c.minutes === null);
  assert.deepEqual(open.map((c) => c.label), ['Until I turn it back on']);
});

test('the untimed pause is one the detector reads as a pause, by every clock it might have', () => {
  // It is carried as a timestamp rather than as a new field on purpose, and this
  // is the assertion that says why: `pausedUntil` is the ONLY thing the worker's
  // cached copy, the service's validator and the panel all already understand. A
  // new flag would be absent from an older cached copy — and absent must never
  // read as permission, which is exactly the direction it would fail in.
  const forever = pauseUntil(null, NOW);
  assert.equal(forever, PAUSE_INDEFINITELY);
  assert.ok(Date.parse(forever) > NOW + 100 * 365 * 24 * 60 * 60_000, 'outlives anyone who set it');
  assert.equal(isPausedNow({ pausedUntil: forever, excludedDomains: [] }, NOW), true);
  assert.equal(isPausedNow({ pausedUntil: forever, excludedDomains: [] }, Date.parse('2099-01-01')), true);
});

test('an untimed pause is described as what it is, not counted down in hours', () => {
  const forever = { pausedUntil: PAUSE_INDEFINITELY, excludedDomains: [] };
  assert.equal(pauseStateLine(forever, NOW), 'Paused until you turn it back on.',
    'a countdown of seventy million hours is a number nobody can read as "off"');
});

test('the paused banner says what stopped and what did not, in one line each', () => {
  // The collection-pause contract's mitigation, and the manual-capture pause exemption's exemption, on the one surface that is
  // always in front of the learner. Saying only "paused" would leave them to
  // discover on their own that a pin they make by hand still lands.
  assert.equal(pausedBannerNote(),
    "I've stopped watching what you read and processing what you pinned. Pinning something yourself still works.");
  assert.equal(PAUSE_SCOPE_LINE,
    'Pausing also stops Process. Pinning something yourself still works.');
  assert.match(PROCESSING_PAUSED_LINE, /paused.*Start again.*process what you.*pinned/i);
});

test('the off-limits screen admits that pinning by hand still works there', () => {
  // The deliberate-capture precedence: manual capture outranks the list. A privacy screen that let
  // someone believe otherwise would be worse than no screen at all.
  assert.deepEqual(offLimitsLines(), [
    'Virgil never observes activity on these domains or suggests anything from them.',
    'Pinning something yourself still works everywhere, paused or not. That one is your call, not mine.',
    'One domain per line. A domain covers its subdomains.',
  ]);
});

test('a pasted url becomes the domain it was on', () => {
  assert.deepEqual(parseDomainList('https://www.bank.test/accounts?tab=1'), ['bank.test']);
  assert.deepEqual(parseDomainList('MAIL.GOOGLE.COM\n'), ['mail.google.com']);
  assert.deepEqual(parseDomainList('bank.test:8443'), ['bank.test']);
});

test('www is dropped, because keeping it would miss the site they were on', () => {
  // Exclusion covers subdomains, so `bank.test` catches `www.bank.test` and
  // `secure.bank.test`. Storing what they typed would only catch the first.
  assert.deepEqual(parseDomainList('www.bank.test'), ['bank.test']);
});

test('the list is deduplicated and keeps the order it was written in', () => {
  assert.deepEqual(parseDomainList('b.test\na.test\nhttps://b.test/x\n\n  \n'), ['b.test', 'a.test']);
});

test('a line that is not a domain is dropped and said out loud', () => {
  // A list that quietly loses a line is a list they believe is protecting them
  // and is not.
  assert.deepEqual(parseDomainList('bank.test\nmy bank\nlocalhost'), ['bank.test']);
  assert.equal(domainListNote('bank.test\nmy bank\nlocalhost'),
    "2 lines didn't look like domains and were not saved.");
  assert.equal(domainListNote('bank.test\nmy bank'),
    "1 line didn't look like a domain and was not saved.");
});

test('a list that survived intact says nothing', () => {
  assert.equal(domainListNote('bank.test\nnhs.uk'), null);
  assert.equal(domainListNote(''), null);
  assert.equal(domainListNote('b.test\nhttps://b.test/x'), null,
    'the same domain twice is a duplicate, not a line they got wrong');
});

// ------------------------------------------------ the main page (UX_SPEC §5)

test('§5: the card heading names the session, and every other state names itself', () => {
  const card = (over: Partial<SessionCardView> = {}): SessionCardView => ({
    state: 'ready', sessionId: 's1', title: 'How IAM conditions evaluate', minutes: 12,
    registers: ['building'], why: null, withheld: [], reason: null, ...over,
  });

  assert.equal(cardHeading(card()), 'How IAM conditions evaluate');
  // Not "Being built". `main-page.ts` builds this card and says, in as many
  // words, that it is NOT a claim a run is in flight — so a heading asserting
  // one contradicted the sentence directly beneath it.
  // The event-driven processing contract: no run is coming on its own, so a heading telling somebody to
  // wait for one tells them to wait for nothing.
  assert.equal(cardHeading(card({ state: 'building' })), 'Ready to process');
  assert.equal(cardHeading(card({ state: 'withheld' })), 'Held back for checking');
  assert.equal(cardHeading(card({ state: 'nothing-ready' })), 'Nothing ready yet');
});

test('§5: a state this build does not know falls back to the empty, never to Start', () => {
  // The fail-closed direction. A panel from an older build reading a state
  // added later must not offer to start a session that may not be there.
  const future = { state: 'half-built', sessionId: 's1', title: 'x', minutes: 5,
    registers: [], why: null, withheld: [], reason: null } as unknown as SessionCardView;
  assert.equal(cardHeading(future), 'Nothing ready yet');
  assert.equal(cardIsStartable(future), false);
  assert.equal(cardIsStartable(null), false);
});

test('§5: an unrecognised register is dropped rather than shown as a fourth colour', () => {
  // The value travels with the label now, because §5 asks the card to carry the
  // three register colours and a bare label cannot be coloured by anything.
  assert.deepEqual(registerChips(['fluent', 'expert', 'from-nothing']), [
    { value: 'fluent', label: 'fluent' },
    { value: 'from-nothing', label: 'new to you' },
  ]);
  assert.deepEqual(registerChips(undefined), []);
});

test('§5: the momentum line is the fact plus the evidence, and nothing else', () => {
  assert.equal(
    momentumLine({ kind: 'milestone', topicLabel: 'IAM', from: 'building', to: 'fluent', evidence: 'Demonstrated 3 times across 2 weeks.' }),
    'IAM: building → fluent. Demonstrated 3 times across 2 weeks.');
  assert.equal(
    momentumLine({ kind: 'badge', badge: 'comeback', topicLabel: 'Firestore', evidence: 'You called this shaky, kept at it.' }),
    'The comeback: Firestore. You called this shaky, kept at it.');
  assert.equal(
    momentumLine({ kind: 'chain', topicLabel: 'Tritone', evidence: 'Recalled 3 times across widening gaps.' }),
    'Tritone: Recalled 3 times across widening gaps.');
});

test('§5: anything the strip cannot word is dropped', () => {
  // A shape with a hole in it is the strip inventing content, which is the one
  // thing §5 bans it from doing by name.
  assert.equal(momentumLine(null), null);
  assert.equal(momentumLine({ kind: 'badge', badge: 'most-pins', topicLabel: 'x', evidence: 'y' }), null);
  assert.equal(momentumLine({ kind: 'milestone', topicLabel: 'x', evidence: 'y' }), null);
  assert.equal(momentumLine({ kind: 'chain', topicLabel: '', evidence: 'y' }), null);
  assert.equal(momentumLine({ kind: 'chain', topicLabel: 'x', evidence: '   ' }), null);
});

test('§5: a flagged row says who flagged it and when, in a person\'s words', () => {
  const row = (source: string, minutesBack: number) =>
    ({ topicId: 't', topicLabel: 'TLS', source, at: minutesAgo(minutesBack) });

  assert.equal(flaggedLine(row('resurface-refresher', 30), NOW), 'you asked for a refresher on this, today');
  assert.equal(flaggedLine(row('resurface-deeper', 60 * 26), NOW), 'you asked to go deeper on this, yesterday');
  assert.match(flaggedLine(row('regression', 60 * 24 * 4), NOW) ?? '', /^you had this and it has slipped, last seen /);
  // SB-61. In the learner's own voice like the two above it, because that is
  // what it is: they read a quick take and said so. §5 lists this row first.
  assert.equal(flaggedLine(row('quick-take-still-shaky', 30), NOW),
    'you said this was still shaky when you read it, today');
  assert.equal(flaggedLine(row('mystery', 30), NOW), null, 'a row with no provenance is not a row');

  // A row whose timestamp is unreadable still has provenance, so it is still a
  // row — it just cannot say when. "a while back" is the whole vocabulary this
  // line has for that, and it is used rather than a number nobody can check.
  const unreadable = { topicId: 't', topicLabel: 'TLS', source: 'regression', at: 'some time' };
  assert.equal(flaggedLine(unreadable, NOW), 'you had this and it has slipped, last seen a while back');
});

test('§5: "and N more" is a sentence only when there is a remainder', () => {
  assert.equal(andNMore(0), null);
  assert.equal(andNMore(-1), null);
  assert.equal(andNMore(1), 'and 1 more');
  assert.equal(andNMore(12), 'and 12 more');
});

test('§5: the door counts topics and searches on the label', () => {
  const board = [topic('a', 'working'), topic('b', 'settled')];
  assert.equal(boardDoorLabel(board), '2 topics on the board');
  assert.equal(boardDoorLabel([topic('a', 'working')]), '1 topic on the board');
  assert.equal(boardDoorLabel([]), '0 topics on the board');

  assert.equal(matchesSearch(topic('Bread hydration', 'working'), 'BREAD'), true);
  assert.equal(matchesSearch(topic('Bread hydration', 'working'), 'iam'), false);
  assert.equal(matchesSearch(topic('Bread hydration', 'working'), '   '), true,
    'searching for nothing is not a filter');
});

test('the search reaches the pins and the courses the box always claimed to search', () => {
  /**
   * The box says *"Search what you're learning"* and searched the board's
   * topics. Maya typed the word printed on both cards under it and was told
   * nothing matched, because both were unfiled pins; her own week 3 video, in
   * My studies, was not reachable from the box at all.
   */
  assert.equal(matchesPinSearch({ title: 'Spring and neap tides' }, 'TIDES'), true);
  assert.equal(matchesPinSearch({ title: 'Composite Indexes', gist: 'Pre-sorts fields.' }, 'sorts'), true,
    'a pin that says what it is about is not searched on what it says');
  assert.equal(matchesPinSearch({ title: 'Composite Indexes' }, 'tides'), false);
  assert.equal(matchesPinSearch({ title: 'Anything' }, '  '), true,
    'searching for nothing is not a filter');

  const courses = [
    { id: 'k1', title: 'Tides and the moon', material: [
      { id: 'm1', title: 'Week 3 video, tides' },
      { id: 'm2', title: 'Reading: Eysenck ch. 5' },
    ] },
    { id: 'k2', title: 'Short story writing', material: [{ id: 'm3', title: 'Week 3 workshop' }] },
  ];
  const hit = searchCourses(courses, 'week 3');
  assert.deepEqual(hit.courses, []);
  assert.deepEqual(hit.material.map((m) => [m.title, m.courseTitle]), [
    ['Week 3 video, tides', 'Tides and the moon'],
    ['Week 3 workshop', 'Short story writing'],
  ], 'material carries the course it came out of, because a title alone answers half the question');

  // A course matched on its own title does not drag its reading list in with
  // it: the course is the hit, and its rows are hits only on their own words.
  const byCourse = searchCourses(courses, 'tides');
  assert.deepEqual(byCourse.courses.map((c) => c.title), ['Tides and the moon']);
  assert.deepEqual(byCourse.material.map((m) => m.title), ['Week 3 video, tides']);

  // Searching for nothing finds nothing here, rather than everything: this is
  // reached only when there IS a query.
  assert.deepEqual(searchCourses(courses, '   '), { courses: [], material: [] });
});

test('SB-263: course search includes the planned work already projected into that course', () => {
  assert.deepEqual(searchCommitments([{
    id: 'c1', title: 'Finish tree traversal practice', courseTitle: 'Data Structures',
  }], 'tree traversal'), [{
    id: 'c1', title: 'Finish tree traversal practice', courseTitle: 'Data Structures',
  }]);
});

test('an all-search miss names its complete scope without claiming an empty board', () => {
  assert.equal(searchEmptyLine(' tides '),
    'I couldn’t find “tides” on your board, in your courses or in your plan. Try a different word.');
  // Retain the narrower lines as stable vocabulary for compatibility surfaces,
  // even though the current successful-search face suppresses empty groups.
  assert.equal(searchMissLine('board', 'tides'), 'Nothing on your board matches “tides”.');
  assert.equal(searchMissLine('courses', ' tides '), 'Nothing in your courses matches “tides”.');
  assert.equal(searchMissLine('plan', ' tides '), 'Nothing in your plan matches “tides”.');
  // The headings name the two places and count nothing in them (SB-18).
  for (const heading of [SEARCH_BOARD_HEADING, SEARCH_COURSES_HEADING, SEARCH_PLAN_HEADING]) {
    assert.doesNotMatch(heading, /\d/);
  }
  assert.equal(SEARCH_BOARD_HEADING, 'On your board');
  assert.equal(SEARCH_COURSES_HEADING, 'In your courses');
  assert.equal(SEARCH_PLAN_HEADING, 'In your plan');
  // And the in-flight state is not a result. A group that reported a miss
  // before it had read the courses would be lying about the half still coming.
  assert.ok(!/nothing|no /i.test(SEARCH_COURSES_WAITING), SEARCH_COURSES_WAITING);
  assert.ok(!/nothing|no match/i.test(SEARCH_COURSES_UNREADABLE), SEARCH_COURSES_UNREADABLE);
});

test('SB-62: the lesson offers the one nuance a single button can promise', () => {
  assert.equal(RESURFACE_FROM_LESSON, 'refresher');
  assert.match(resurfacedLine('deeper'), /go further/);
  assert.match(resurfacedLine('refresher'), /take it slower/);
});

test('§5: session end has no line for a session that moved nothing', () => {
  assert.equal(awardsHeading(0), null);
  assert.equal(awardsHeading(2), 'What that session moved');
});

test('the session close speaks naturally without turning lesson count into a score', () => {
  assert.equal(sessionClosingLine([{ completed: true, completionEvidence: 'answer' }]),
    'Virgil saved how your answer went. It can use that learning evidence when choosing what comes next.');
  assert.equal(sessionClosingLine([{ completed: true, completionEvidence: 'known' }]),
    'You marked that lesson as known. Virgil can use that when choosing what comes next.');
  assert.equal(sessionClosingLine([{ completed: true }]),
    'Virgil saved the learning evidence from that lesson. It can use it when choosing what comes next.');
  assert.equal(sessionClosingLine([{ completed: true }, { completed: true }]),
    'Virgil saved new learning evidence from each lesson. It can use that when choosing what comes next.');
  assert.doesNotMatch(sessionClosingLine([{ completed: true }, { completed: false }]), /\d/);
  assert.doesNotMatch(sessionClosingLine([{ completed: false }]), /\d/);
});

test('the session close never calls withdrawn evidence saved or forces a repeat', () => {
  assert.equal(sessionClosingLine([{
    completed: true, completionEvidence: 'answer',
    corrections: [{ conceded: true, withdrawn: 1 }],
  }]), 'That learning mark no longer counts. You do not have to repeat the lesson; it remains here to revisit.');
  assert.equal(sessionClosingLine([{ completed: true, completionEvidence: 'answer', contested: true }]),
    'That learning mark no longer counts. You do not have to repeat the lesson; it remains here to revisit.');
  assert.doesNotMatch(sessionClosingLine([
    { completed: true, completionEvidence: 'answer' },
    { completed: true, completionEvidence: 'answer', corrections: [{ conceded: true, withdrawn: 1 }] },
  ]), /each lesson|answer is saved/i);
});

test('§5: the withheld lines tell the two failures apart', () => {
  const card = {
    state: 'withheld', sessionId: null, title: 'x', minutes: 0, registers: [], why: null,
    reason: null,
    withheld: [
      { topicId: 'a', heading: 'How IAM conditions evaluate', reason: 'defective' },
      { topicId: 'b', heading: 'Composite index limits', reason: 'unverified' },
    ],
  } as SessionCardView;

  assert.deepEqual(withheldLines(card), [
    'How IAM conditions evaluate: the check found a problem',
    'Composite index limits: the check could not run',
  ]);
  assert.deepEqual(withheldLines(null), []);
});

// ------------------------------------------------------- SB-38: check my work

/**
 * The QC cameo's copy, which is where its one hard rule is either kept or
 * quietly broken.
 *
 * The learner-work review boundary: this reviews the learner's own work and never
 * produces submittable content. The agent holds that in its schema, its prompt
 * and a tripwire; the screen has to hold it in what it says and what it offers.
 * A "fix it for me" button would undo all three, so the framing line is
 * asserted here rather than eyeballed.
 */

test('SB-38: the screen says what it will not do, before it is asked', () => {
  assert.equal(
    reviewFramingLine(),
    'I say what looks weak and why. I don’t rewrite it. That part stays yours.',
  );
});

test('SB-38: a draft too short to judge is refused before the request, not after', () => {
  assert.equal(checkRefusal(''), 'Paste in what you are about to send.');
  assert.equal(checkRefusal('   \n '), 'Paste in what you are about to send.');
  assert.equal(checkRefusal('a'.repeat(200)), null);
});

test('Check publishes and enforces the whole-rubric boundary', () => {
  assert.equal(rubricLimitLine(CHECK_LIMITS_FALLBACK),
    'Up to 24 criteria, 400 Unicode characters each. Every accepted criterion is marked whole.');
  assert.equal(rubricRefusal('A complete criterion with evidence.', CHECK_LIMITS_FALLBACK), null);
  assert.match(rubricRefusal('😀'.repeat(401), CHECK_LIMITS_FALLBACK) ?? '', /nothing was sent/);
  const many = Array.from({ length: 25 }, (_, i) => `Criterion ${i + 1} requires evidence.`).join('\n');
  assert.match(rubricRefusal(many, CHECK_LIMITS_FALLBACK) ?? '', /24 criteria/);
});

test('SB-38: each of the four answers is a different sentence', () => {
  // The one that matters is the difference between the last two: "nothing
  // jumped out" and "I could not run the check" are the same empty list, and
  // saying the first about the second is telling the learner their draft is
  // sound when nothing read it.
  assert.equal(reviewSummary('reviewed', 3), 'Three things I would look at again.');
  assert.equal(reviewSummary('reviewed', 1), 'One thing I would look at again.');
  assert.equal(
    reviewSummary('nothing-found', 0),
    'Nothing jumped out at me. That is not the same as right. It is only that I could not fault it.',
  );
  assert.equal(reviewSummary('too-short', 0), 'That is not enough writing for me to have an opinion about.');
  assert.equal(
    reviewSummary('model-failed', 0),
    'I couldn’t run the check just now. Nothing about your draft has changed.',
  );
});

test('SB-38: an outcome this build does not know says the failure, not the success', () => {
  // The fail-closed direction, and the only one available: a panel from an
  // older build must never render an unknown answer as a clean bill of health.
  assert.equal(
    reviewSummary('something-new', 0),
    'I couldn’t run the check just now. Nothing about your draft has changed.',
  );
});

test('SB-38: a finding that touches the board says which topic, in the learner’s own label', () => {
  // The differentiator over any generic checker: it reviewed this against what
  // *this person* is shaky on, and the line is where the learner can see that.
  assert.equal(
    findingTopicLine({ quote: 'q', problem: 'p', relatedTopicId: 't1', relatedTopicLabel: 'Pub/Sub delivery', pinSuggestion: null }),
    'This is one you have been finding hard: Pub/Sub delivery',
  );
  assert.equal(
    findingTopicLine({ quote: 'q', problem: 'p', relatedTopicId: null, relatedTopicLabel: null, pinSuggestion: 'Retries' }),
    null,
    'a finding with no topic behind it is still a finding, and does not invent one',
  );
  assert.equal(
    findingTopicLine({ quote: 'q', problem: 'p', relatedTopicId: 't9', relatedTopicLabel: null, pinSuggestion: null }),
    null,
    'an id the board could not name is not a label',
  );
});

// ------------------------------------- the third box, the meter, the files

test('the third box asks for background, and says it is not part of the work', () => {


  assert.equal(CONTEXT_LABEL, 'Extra context');
  assert.equal(
    contextWhyLine(),
    'Add anything else you would like me to know. '
    + 'The brief, what your marker said last time, anything you were told to do. '
    + 'I read it as background, never as part of the work.',
  );
  assert.ok(contextWhyLine().includes('never as part of the work'));
});

test('the labels on the Check screen are names, and the voice is in the line below', () => {

  for (const label of [CHECK_TITLE, DRAFT_LABEL, RUBRIC_LABEL, CONTEXT_LABEL]) {
    assert.ok(!/[?.]/.test(label), `"${label}" is a sentence, not a name`);
    assert.ok(label.split(' ').length <= 3, `"${label}" is too long to be a heading`);
  }
  // The title is the door's words exactly. Two names for one place is a place
  // the learner has to work out they have already arrived at. SB-279 shortened
  // both at once, which is the only way that rule survives a rename.
  assert.equal(CHECK_TITLE, 'Check');
  assert.equal(DOORS.find((door) => door.key === 'check')?.label, CHECK_TITLE);
  assert.equal(DRAFT_LABEL, 'Your work');
  assert.equal(RUBRIC_LABEL, 'Marking criteria');
  // And the sentence the draft label used to be, one line down, answering
  // rather than asking.
  assert.equal(draftWhyLine(),
    'Whatever you are about to hand in or send. Paste it, or drop the file on the box.');
});

test('the file control is called what it is, and the promise moved to the line below', () => {

  assert.equal(UPLOAD_ACTION, 'Upload a file');
  assert.equal(
    uploadHowLine(),
    'Drop a .txt, .md, .docx or .pdf here, or pick one. '
    + 'A PDF goes as its pages, exactly as they are. '
    + 'Anything else lands in the box for you to read before anything is sent.',
  );
  assert.ok(uploadHowLine().includes('before anything is sent'),
    'the promise that makes this safe is the one clause that must survive an edit');
  assert.ok(uploadHowLine().includes('as its pages'),
    'the default route for a PDF is the one thing the line has to say');
  assert.equal(READING_FILE, 'Reading it…');
  assert.equal(RENDERING_PAGES, 'Getting the pages ready…');
});

test('every way of failing to read a file has a sentence, and none of them is silence', () => {
  /**
   * The failure this is written against is the quiet one: a scanned PDF yields
   * nothing, nothing appears, and the learner presses the button on an empty
   * box believing their essay went with it. So there is no branch that returns
   * null, and every branch says the box is untouched.
   */
  assert.equal(
    uploadOutcomeLine({ kind: 'text', format: 'docx', text: 'x' }, 'assignment.docx'),
    'Read assignment.docx into the box. Check it before you send it, and change anything that came through wrong.',
  );
  assert.equal(
    uploadOutcomeLine({ kind: 'unsupported' }, 'essay.doc'),
    'I can read .txt, .md, .docx and .pdf. essay.doc is none of those, so I have not touched the box.',
  );
  assert.equal(
    uploadOutcomeLine({ kind: 'too-big', format: 'pdf', capBytes: 10_000_000 }, 'handbook.pdf'),
    'handbook.pdf is bigger than 10MB, which is more than I will open. Nothing has gone into the box.',
  );
  // The one that actually helps: a scanned PDF is not a broken PDF, and saying
  // "could not open" sends that learner looking for a corrupt file. It used to
  // stop there, which was true and was a dead end. There is a route now, and
  // the sentence names it rather than leaving somebody holding a scan.
  assert.equal(
    uploadOutcomeLine({ kind: 'no-text', format: 'pdf' }, 'scan.pdf'),
    'There is no text in scan.pdf for me to lift out. It looks like scanned pages, so send it as its pages instead.',
  );
  assert.equal(
    uploadOutcomeLine({ kind: 'no-text', format: 'text' }, 'empty.txt'),
    'There is no text in empty.txt that I can find. Nothing has gone into the box.',
  );
  assert.equal(
    uploadOutcomeLine({ kind: 'unreadable', format: 'docx' }, 'broken.docx'),
    "I couldn't open broken.docx as a Word document. Nothing has gone into the box.",
  );
  for (const kind of ['unsupported', 'too-big', 'no-text', 'unreadable'] as const) {
    const line = uploadOutcomeLine(
      { kind, format: 'pdf', capBytes: 10_000_000 } as never, 'x.pdf',
    );
    assert.ok(line && line.length > 20, kind);
  }
});

test('a course-source screenshot becomes editable words, never an invisible import', () => {
  assert.equal(sourceImageTranscriptionLine('transcribed'),
    'I read the image and typed it into the source box. Check the words against the picture before you review the import.');
  assert.match(sourceImageTranscriptionLine('nothing-found'), /Nothing has gone into the source box/);
  assert.match(sourceImageTranscriptionLine('model-failed'), /Nothing has gone into the source box/);
  assert.equal(sourceImageReadLine({ kind: 'pages', pages: ['data:image/jpeg;base64,AA=='] }, 'x.png'), null);
  assert.equal(
    sourceImageReadLine({ kind: 'unreadable', format: 'image' }, 'broken.png'),
    'I could not open broken.png as an image. Nothing has gone into the source box.',
  );
});

// --------------------------------- the file that goes as it stands (new)

test('the chip says what is attached and how much of it, in pages', () => {

  assert.equal(attachedPagesLine('essay.pdf', 4), 'essay.pdf, 4 pages. I send the pages as they are.');
  assert.equal(attachedPagesLine('one.pdf', 1), 'one.pdf, 1 page. I send the pages as they are.');
  assert.equal(attachedPagesLine('diagram.png', 1, 'image'),
    'diagram.png, 1 image. I send it as a picture.');
  // A pathological filename cannot become the sentence.
  assert.ok(attachedPagesLine('x'.repeat(200), 2).length < 120);
});

test('the pages are not on the character meter, and the screen says which fact the meter is about', () => {
  // Saying nothing would look safer and be worse: a learner with twelve pages
  // attached and a meter reading zero should be told why it reads zero.
  assert.ok(attachedMeterNote(12).includes('do not count towards the characters'));
  assert.ok(attachedMeterNote(1).includes('The page goes'));
  assert.ok(attachedMeterNote(3).includes('The 3 pages go'));
  assert.ok(attachedMeterNote(1, 'image').includes('The image goes'));
});

test('every way of failing to attach the pages says so, and says nothing is attached', () => {
  assert.equal(pagesOutcomeLine({ kind: 'pages', pages: ['data:image/jpeg;base64,AA=='] }, 'e.pdf'), null,
    'a page that worked is not a sentence');
  assert.equal(
    pagesOutcomeLine({ kind: 'too-many-pages', pageCount: 64, capPages: 20 }, 'thesis.pdf'),
    'thesis.pdf is 64 pages, and I send at most 20 at a time. Nothing is attached. '
    + 'Send the part you want looked at as its own file.',
    'the refusal names the count, because a silent slice of the front of a thesis is the other option',
  );
  // Not nineteen pages of twenty. A partial submission marked as a whole one is
  // the failure the whole screen is arranged against.
  assert.equal(
    pagesOutcomeLine({ kind: 'page-failed', page: 7, pageCount: 12 }, 'essay.pdf'),
    'Page 7 of essay.pdf would not draw, so I have attached none of it. '
    + 'A piece of work with a page missing is not the piece of work.',
  );
  assert.equal(
    pagesOutcomeLine({ kind: 'unreadable', format: 'pdf' }, 'broken.pdf'),
    "I couldn't open broken.pdf as a PDF. Nothing is attached.",
  );
  assert.equal(
    pagesOutcomeLine({ kind: 'too-big', format: 'pdf', capBytes: 10_000_000 }, 'big.pdf'),
    'big.pdf is bigger than 10MB, which is more than I will open. Nothing is attached.',
  );
  assert.ok(pagesOutcomeLine({ kind: 'unsupported' }, 'notes.docx')?.includes('PDF, PNG or JPEG'));
  assert.ok(pagesOutcomeLine({ kind: 'unreadable', format: 'image' }, 'broken.png')
    ?.includes('as an image'));
  for (const kind of ['unsupported', 'too-big', 'too-many-pages', 'page-failed', 'unreadable'] as const) {
    const line = pagesOutcomeLine(
      { kind, format: 'pdf', capBytes: 1, page: 1, pageCount: 1, capPages: 20 } as never, 'x.pdf',
    );
    assert.ok(line && /attach/i.test(line), kind);
  }
});

test('asking for the text of a scan keeps the pages rather than leaving nothing at all', () => {
  // The one outcome this control could produce that would be worse than not
  // offering it: an empty box and no file.
  assert.ok(noTextKeptPagesLine('scan.pdf').includes('left the pages attached'));
});

// ------------------------------- the criteria box, which needs the rows (new)

test('a scanned rubric is told why pixels will not do, and offered the way round it', () => {
  /**
   * The structured-criteria contract is the reason this box is different from the one above it. The
   * criteria are split out in code, verbatim, one row each, and every one gets
   * a row in the mark whether the model noticed it or not. That needs words.
   */
  const line = scannedRubricLine('criteria.pdf');
  assert.ok(line.includes('criteria.pdf'));
  assert.ok(line.includes('one criterion at a time'), line);
});

test('SB-153: repeated document markers repair title and wrapped-line damage', () => {
  const extracted = [
    'COMP4021 Coursework 3 - Marking criteria',
    '1. Accuracy. Technical claims are correct and supported.',
    '2. Depth of analysis. The essay goes beyond description and explains the trade-offs between',
    'competing scheduling policies.',
    '3. Structure. The argument has a clear progression.',
    '4. Sources. Claims use primary references.',
  ].join('\n');
  assert.equal(repairImportedRubric(extracted), [
    'Accuracy. Technical claims are correct and supported.',
    'Depth of analysis. The essay goes beyond description and explains the trade-offs between competing scheduling policies.',
    'Structure. The argument has a clear progression.',
    'Sources. Claims use primary references.',
  ].join('\n'));
});

test('SB-153: unstructured imported criteria remain exactly as extracted', () => {
  const extracted = 'Marking guide\nExplain the mechanism in your own words.\nUse evidence from the source.';
  assert.equal(repairImportedRubric(extracted), extracted);
});

test('SB-153: labelled and bullet lists repair only when their own structure repeats', () => {
  assert.equal(repairImportedRubric('Guide\nCriterion 1: Name the cause\ncontinued clearly\nCriterion 2: Cite the source'),
    'Name the cause continued clearly\nCite the source');
  assert.equal(repairImportedRubric('Guide\n• Name the cause in full\nwrapped words\n• Cite the source in context'),
    'Name the cause in full wrapped words\nCite the source in context');
  const one = 'Guide\n1. One numbered sentence\nA separate plain sentence';
  assert.equal(repairImportedRubric(one), one, 'one marker is not enough authority to rewrite a document');
});

test('a transcription is proposed, never imposed, and says so in the sentence that lands it', () => {
  const done = transcribeOutcomeLine('transcribed', 3);
  assert.ok(done.includes('all 3 pages'), done);
  assert.ok(done.includes('Read them against the paper'), done);
  assert.ok(transcribeOutcomeLine('transcribed', 1).includes('the page'));
  assert.ok(transcribeOutcomeLine('nothing-found', 2).includes('could not find any words'));
  // Fail closed, the same way `reviewSummary` does: an outcome this build does
  // not know reads as the failure rather than as the success.
  for (const outcome of ['model-failed', 'no-pages', 'something-new']) {
    assert.ok(transcribeOutcomeLine(outcome, 2).includes('did not run'), outcome);
  }
});

test('a filename long enough to be an attack does not become the sentence', () => {
  const line = uploadOutcomeLine({ kind: 'unsupported' }, `${'a'.repeat(400)}.doc`)!;
  assert.ok(line.length < 200, line.length.toString());
  assert.ok(line.includes('…'));
});

test('the caps the meter warns against come off the wire, and survive a receipt that did not', () => {
  // A `/model-config` that answered with nulls must produce a meter that is
  // slightly stale, never one that crashes and never one that has quietly
  // stopped warning. The second is the dangerous failure: it looks like
  // everything fits.
  assert.deepEqual(checkLimitsFrom(null), CHECK_LIMITS_FALLBACK);
  assert.deepEqual(checkLimitsFrom({}), CHECK_LIMITS_FALLBACK);
  assert.deepEqual(
    checkLimitsFrom({ markWorkChars: 0, contextChars: -1, reviewDraftChars: Number.NaN }),
    CHECK_LIMITS_FALLBACK,
    'a zero cap would warn about every paste, which is the same as warning about none',
  );
  assert.equal(checkLimitsFrom({ markWorkChars: 20_000 }).markWorkChars, 20_000);
  assert.equal(checkLimitsFrom({ markWorkChars: 20_000 }).contextChars, 4_000);
});

test('the draft is measured against whichever agent is about to read it', () => {
  // The learner never picks a mode: pasting the criteria IS the choice, and it
  // changes how much of their work gets read.
  assert.equal(draftCap(CHECK_LIMITS_FALLBACK, false), 6_000);
  assert.equal(draftCap(CHECK_LIMITS_FALLBACK, true), 12_000);
  assert.equal(rubricSoftCap(CHECK_LIMITS_FALLBACK), 24 * 400);
});

test('the pre-send receipt names the exact text slice, page range and mixed hand-off', () => {
  const lines = checkHandoffLines({
    draftChars: 7_000,
    rubric: '',
    contextChars: 4_600,
    attachment: { name: 'final essay.pdf', pages: 4 },
  }, CHECK_LIMITS_FALLBACK);
  assert.deepEqual(lines, [
    'Draft review for clarity and reasoning, using any evidence-backed weak areas from your board.',
    'Draft text: first 6,000 characters of 7,000. The final 1,000 characters will not be checked.',
    'final essay.pdf: all 4 pages (pages 1 to 4), sent as pictures.',
    'Context: first 4,000 characters of 4,600. The final 600 characters will not be checked; instruction-like lines may also be held back and named in the result.',
    'Nothing is sent until you press Check it.',
  ]);
});

test('the pre-send receipt names a direct screenshot as one image', () => {
  const lines = checkHandoffLines({
    draftChars: 0,
    rubric: '',
    contextChars: 0,
    attachment: { name: 'architecture.png', pages: 1, kind: 'image' },
  }, CHECK_LIMITS_FALLBACK);
  assert.deepEqual(lines, [
    'Draft review for clarity and reasoning, using any evidence-backed weak areas from your board.',
    'architecture.png: 1 image, sent as a picture.',
    'Nothing is sent until you press Check it.',
  ]);
});

test('the pre-send receipt names criteria admission without pretending every entered line qualifies', () => {
  const rubric = Array.from({ length: 26 }, (_, i) => `Criterion ${i + 1} says enough`).join('\n');
  const lines = checkHandoffLines({
    draftChars: 12_000, rubric, contextChars: 1, attachment: null,
  }, CHECK_LIMITS_FALLBACK);
  assert.deepEqual(lines, [
    'Criteria-led mark.',
    'Draft text: all 12,000 characters.',
    'Criteria: 26 entered lines; up to 24 eligible lines, first 400 characters each. Held-back lines are named in the result.',
    'Context: all 1 character. Instruction-like lines may be held back and named in the result.',
    'Nothing is sent until you press Check it.',
  ]);
});

test('the pre-send receipt names the active minimum and exact remaining draft before Check', () => {
  assert.deepEqual(checkHandoffLines({
    draftChars: 151, draftReadyChars: 151,
    rubric: 'Uses specific evidence\nExplains causation',
    contextChars: 0, attachment: null,
  }, CHECK_LIMITS_FALLBACK), [
    'Criteria-led mark.',
    'Draft text: all 151 characters.',
    'Your draft is 151 of 200 characters needed for a criteria-led mark. Add 49 characters more, or attach its pages.',
    'Criteria: 2 entered lines; up to 24 eligible lines, first 400 characters each. Held-back lines are named in the result.',
    'Nothing is sent until you press Check it.',
  ]);

  assert.match(checkHandoffLines({
    draftChars: 79, draftReadyChars: 79, rubric: '', contextChars: 0, attachment: null,
  }, CHECK_LIMITS_FALLBACK).join(' '),
  /79 of 80 characters needed for a board-informed review.*Add 1 character more/);
  assert.doesNotMatch(checkHandoffLines({
    draftChars: 1, draftReadyChars: 1, rubric: 'Criterion', contextChars: 0,
    attachment: { name: 'essay.pdf', pages: 2 },
  }, CHECK_LIMITS_FALLBACK).join(' '), /characters needed/,
  'attached pages are the work and must bypass the text minimum');
});

test('Check readiness is one short action line, with transport detail kept underneath', () => {
  assert.equal(checkReadinessLine({
    draftChars: 0, draftReadyChars: 0, rubric: '', contextChars: 0, attachment: null,
  }, CHECK_LIMITS_FALLBACK), 'Add your work to begin.');
  assert.equal(checkReadinessLine({
    draftChars: 151, draftReadyChars: 151, rubric: 'Criterion one requires evidence.',
    contextChars: 0, attachment: null,
  }, CHECK_LIMITS_FALLBACK), '49 characters to go');
  assert.equal(checkReadinessLine({
    draftChars: 315, draftReadyChars: 315,
    rubric: 'First criterion requires evidence.\nSecond criterion requires reasoning.',
    contextChars: 22, attachment: null,
  }, CHECK_LIMITS_FALLBACK), 'Ready · 315 characters · 2 criteria · context included');
  assert.equal(checkReadinessLine({
    draftChars: 0, draftReadyChars: 0, rubric: '', contextChars: 0,
    attachment: { name: 'diagram.png', pages: 1, kind: 'image' },
  }, CHECK_LIMITS_FALLBACK), 'Ready · 1 image · clarity and reasoning review');
});

test('the empty hand-off and unresolved-file copy are explicit and filename-bounded', () => {
  assert.deepEqual(checkHandoffLines({
    draftChars: 0, rubric: '', contextChars: 0, attachment: null,
  }, CHECK_LIMITS_FALLBACK), [
    'Nothing is ready yet.', 'Nothing is sent until you press Check it.',
  ]);
  assert.equal(LEAVE_FILE_OUT, 'Leave this file out');
  assert.match(filePendingLine('scan.pdf'), /scan\.pdf is still being prepared/);
  assert.match(fileBlockingLine('scan.pdf'), /scan\.pdf is not included/);
  assert.equal(fileLeftOutLine('scan.pdf', 'rubric'),
    'scan.pdf will be left out. Your existing criteria are unchanged.');
  assert.ok(fileBlockingLine('x'.repeat(200)).length < 180);
});

test('the meter says nothing until eighty per cent, then says the number and the consequence', () => {
  /**
   * This product counts nothing it does not have to. A counter under an empty
   * box is a form telling somebody off in advance, and there is nothing on this
   * screen that length blocks.
   */
  assert.equal(SIZE_WARN_AT, 0.8);
  assert.equal(sizeWarningLine('draft', 0, 6_000), null);
  assert.equal(sizeWarningLine('draft', 4_799, 6_000), null);
  assert.equal(
    sizeWarningLine('draft', 4_800, 6_000),
    'That is 4,800 characters of 6,000. Past 6,000 I read the first 6,000 and tell you I stopped.',
  );
  assert.equal(
    sizeWarningLine('draft', 13_200, 12_000),
    'That is 13,200 characters. I read the first 12,000 and tell you where I stopped. '
    + 'What is below that is not looked at.',
  );
  assert.equal(
    sizeWarningLine('context', 3_500, 4_000),
    'That is 3,500 characters of 4,000. Past 4,000 I never see the rest.',
  );
  assert.equal(
    sizeWarningLine('context', 4_600, 4_000),
    'That is 4,600 characters of context. I read the first 4,000 and never see the rest.',
  );
  // The rubric's real limits are per criterion, so the sentence names the shape
  // of the rule rather than inventing a character limit the box does not have.
  const rubric = sizeWarningLine('rubric', 8_000, 9_600)!;
  assert.ok(rubric.includes('one per line'), rubric);
  assert.ok(!/\bcap\b|\blimit\b/.test(rubric), rubric);
  // A cap that arrived as zero cannot divide, and must not warn about nothing.
  assert.equal(sizeWarningLine('draft', 100, 0), null);
});

test('no size warning is a score, a percentage or a countdown', () => {
  // A meter that fills up is a countdown, and this screen blocks nothing.
  for (const box of ['draft', 'rubric', 'context'] as const) {
    for (const chars of [9_000, 20_000]) {
      const line = sizeWarningLine(box, chars, 9_600) ?? '';
      assert.ok(!/%/.test(line), line);
      assert.ok(!/\b(?:limit reached|too long|cannot|can't send|blocked)\b/i.test(line), line);
    }
  }
});

test('the model window is the second layer, and it is silent when nobody published one', () => {
  /**
   * A local model is whatever the operator pulled, and the service returns
   * `null` rather than inventing a window. Reading that `null` as a small
   * number would be a warning on every paste, which is the same thing as no
   * warning at all.
   */
  assert.equal(CHARS_PER_TOKEN, 4);
  assert.equal(windowWarningLine(4_000_000, null), null);
  assert.equal(windowWarningLine(4_000_000, undefined), null);
  assert.equal(windowWarningLine(4_000_000, 0), null);
  // Gemini's window: this effectively never fires, which is the correct
  // outcome. A warning that fires on ordinary work is one people learn to skip.
  assert.equal(windowWarningLine(100_000, 1_048_576), null);
  const line = windowWarningLine(8_000, 1_000)!;
  assert.ok(line.includes('too large for the model'), line);
  assert.ok(line.includes('cut'), line);
});

test('a check that did not happen says which of the three it was', () => {
  /**
   * `api()` collapses a dead service, a 401 and a 500 into one `null`, and for
   * a board zone that is the design. For a screen somebody reached by pressing
   * something it is not: a 401 is a service running perfectly and refusing this
   * panel, and telling them it could not be reached sends whoever is deploying
   * to look at their network on the day it matters.
   */
  assert.equal(
    checkUnreadableLine('unreachable', null),
    'I could not reach your board, so nothing read your work. '
    + 'Start Virgil and press the button again. Nothing about your draft has changed.',
  );
  assert.equal(
    checkUnreadableLine('refused', 401),
    'I could not confirm which board is yours. Sign in again and retry. '
    + 'Nothing about your draft has changed.',
  );
  assert.equal(checkUnreadableLine('refused', 403), checkUnreadableLine('refused', 401));
  assert.equal(
    checkUnreadableLine('refused', 500),
    'I could not check your work. This is mine to fix, not yours. '
    + 'Nothing about your draft has changed.',
  );
  assert.equal(
    checkUnreadableLine('refused', null),
    'I could not check your work. This is mine to fix, not yours. '
    + 'Nothing about your draft has changed.',
  );
  // The clause that is true on every branch and is the one thing the learner
  // needs to hear: their work is untouched and nothing was concluded about it.
  for (const line of [
    checkUnreadableLine('unreachable', null),
    checkUnreadableLine('refused', 401),
    checkUnreadableLine('refused', 500),
  ]) {
    assert.ok(line.includes('Nothing about your draft has changed.'), line);
  }
});

test('an edited submission makes the visible result explicitly previous', () => {
  assert.equal(
    CHECK_RESULT_STALE,
    'This result is from before your changes. Check it again when you’re ready.',
  );
});

test('the reviewer says it stopped reading, in the marker’s own words', () => {
  // `/review` cut a draft over the cap in silence, so "nothing jumped out" could
  // be a claim about the first four pages of eight. Same fact, same voice, on
  // the other half of the same screen.
  assert.equal(
    reviewTruncatedLine(),
    'This is longer than I can read in one go, so I read the start of it. '
    + 'What is below that has not been looked at.',
  );
});

test('a context that was cut says it was never seen, not that it was shortened', () => {
  // The service caps context BEFORE it scans it. "Shortened" would let somebody
  // believe the gist of the rest got through; nothing past the cap was loaded.
  assert.equal(
    contextTruncatedLine(4_000),
    'Your context ran past 4,000 characters. I read the first 4,000 and never saw the rest.',
  );
  assert.ok(contextTruncatedLine(4_000).includes('never saw the rest'));
});

test('a line held back names the box it came out of', () => {
  assert.equal(
    quarantineLine(1),
    'One line in the criteria you pasted told me what to conclude rather than what to check, '
    + 'so I have not used it:',
  );
  assert.equal(
    quarantineLine(2, 'context'),
    '2 lines in the context you gave me told me what to conclude rather than what to check, '
    + 'so I have not used them:',
  );
});

test('held-back lines group by their box, criteria first, and an old service still reads', () => {
  const groups = quarantineGroups([
    { text: 'a', patterns: [], source: 'context' },
    { text: 'b', patterns: [], source: 'rubric' },
    { text: 'c', patterns: [], source: 'context' },
  ]);
  assert.deepEqual(groups.map((g) => [g.source, g.lines.length]), [['rubric', 1], ['context', 2]]);
  // A service that predates the field said nothing but could only mean the one
  // box that existed then.
  assert.deepEqual(
    quarantineGroups([{ text: 'a', patterns: [] }]).map((g) => g.source), ['rubric'],
  );
  assert.deepEqual(quarantineGroups([]), []);
  assert.deepEqual(quarantineGroups(null), []);
  assert.deepEqual(quarantineGroups(undefined), []);
});

test('a finding can be kept whether or not the model supplied a board label', () => {
  // The deliberate-capture precedence: a suggestion the user confirms, never a silent write. The line
  // is a statement about what was seen, not an instruction.
  assert.deepEqual(findingPinOffer({
    quote: 'q', problem: 'Retries can duplicate the write.', relatedTopicId: null,
    relatedTopicLabel: null, pinSuggestion: 'Retry semantics',
  }), { label: 'Retry semantics', line: 'Worth keeping: Retry semantics.' });
  assert.deepEqual(findingPinOffer({
    quote: 'q', problem: 'Retries can duplicate the write.', relatedTopicId: null,
    relatedTopicLabel: null, pinSuggestion: null,
  }), {
    label: 'Retries can duplicate the write.',
    line: 'Keep this finding so it can shape a later lesson.',
  });
  assert.equal(FINDING_PIN_ACTION, 'Keep it on the board');
  assert.equal(FINDING_PIN_DONE, 'On your board.');
  assert.equal(FINDING_LEARN_ACTION, 'Learn this now');
  assert.equal(FINDING_PIN_FAILED, "That didn't go through. Nothing is on the board.");
  for (const line of [
    findingPinOffer({
      quote: 'q', problem: 'x', relatedTopicId: null, relatedTopicLabel: null, pinSuggestion: null,
    }).line,
    FINDING_PIN_ACTION, FINDING_PIN_DONE,
  ]) {
    assert.ok(!/\byou should\b|\bmust\b/i.test(line), line);
  }
});

// ------------------------------------------- SB-59/60/61: the quick take

test('SB-60: the take is subordinate by what it shows, not by a caption', () => {
  assert.equal(quickTakeStandingLine(), '');
});

test('SB-283: three answers close it, and asking is not one of them', () => {
  /**
   * §3 said *"Closes with one tap: Got it / Still shaky. No essay, no rating
   * scale"*, and this asserted two labels. SB-283's walkthrough found the
   * third answer neither of them covers: *I read it, and not today*. Before
   * that, the only way to say it was the back button, which nothing hears.
   *
   * Engagement is still not a verdict. The box and the shortcuts sit above
   * this row and neither closes the screen nor writes anything, which is what
   * §3's actual fear was about: a rating scale, and there still is not one.
   */
  assert.deepEqual(QUICK_TAKE_CHOICES.map((c) => c.verdict),
    ['got-it', 'still-shaky', 'not-now']);
  assert.deepEqual(QUICK_TAKE_CHOICES.map((c) => c.label),
    ['Got it', 'Still fuzzy', 'Not now']);
  for (const c of QUICK_TAKE_CHOICES) {
    assert.ok(!/\d|scale|rate|score/i.test(c.label), '§3 still holds: no scale, no score');
  }
  // The vocabulary is closed, and a value the service invents is not one of
  // them: the receipt path narrows on this rather than trusting the wire.
  assert.ok(QUICK_TAKE_CHOICES.every((c) => isQuickTakeVerdict(c.verdict)));
  for (const bad of ['maybe', '', 'GOT-IT', null, 5]) assert.equal(isQuickTakeVerdict(bad), false);
});

test('the way out of a take is a place, not a direction', () => {
  // Every exit in this product is named for where it goes. A take opened from
  // a pin card came from the board, and "back" is a browser word for a history
  // these surfaces do not have.
  assert.equal(BOARD_EXIT, 'Your board');
  assert.ok(!/back|return|previous|←/i.test(BOARD_EXIT));
});

test('the shortcuts are questions, and they are questions a person would ask', () => {
  // Not a mode and not a ladder: each one puts its text in the box, so the
  // learner can see what is being asked and change it before sending.
  assert.deepEqual(ASK_SHORTCUTS.map((s) => s.label), ['Simpler', 'Go deeper', 'Example']);
  for (const s of ASK_SHORTCUTS) {
    assert.ok(s.question.length > s.label.length, 'the shortcut sends its label rather than a question');
    assert.ok(!/chatbot|assistant/i.test(s.question));
  }
  // The one that used to be a register step is now a request, which is the
  // difference between being met further back and being talked down to.
  assert.match(ASK_SHORTCUTS[0]!.question, /more simply|assuming less/i);
});

test('the receipts say what happens next, not how the learner is doing', () => {
  // The complaint that shaped these lines: answering "I do not understand" with
  // a backlog. The label may describe the reading now, because the sentence
  // underneath it promises the lesson rather than a queue.
  assert.equal(quickTakeAnsweredLine('still-shaky'), "Added. I'll bring it back in a lesson.",
    'the answer promises inclusion without inventing capacity in the next short session');
  // SB-283: the deferral names the window the service actually applied, rather
  // than the panel carrying its own copy of a number that can move.
  assert.equal(quickTakeAnsweredLine('not-now', 7), 'Put down. It comes back in about 7 days.');
  assert.equal(quickTakeAnsweredLine('not-now', 1), 'Put down. It comes back tomorrow.');
  assert.equal(quickTakeAnsweredLine('not-now'), 'Put down. It comes back later.',
    'an older service that names no window is not made to invent one');
});

test('SB-283: each answer says what happened to the pin, and none is a verdict on them', () => {
  const lines = ['got-it', 'still-shaky', 'not-now'].map((v) => quickTakeAnsweredLine(v, 7));
  assert.equal(new Set(lines).size, 3, 'the three answers are not the same promise');
  assert.match(lines[1]!, /added|lesson/i, 'the deferral says where it went');
  assert.match(lines[2]!, /comes back/i, 'a not now says it is coming back, because it is');
  for (const line of [...lines, QUICK_TAKE_ANSWER_UNCHANGED, QUICK_TAKE_CLOSE_FAILED]) {
    assert.ok(!/well done|great|nice|good job|streak|keep it up/i.test(line),
      'no praise, no consolation, and no streak');
    assert.doesNotMatch(line, /[—–]/, 'the copy law, on the copy this slice added');
  }
});

test('SB-60: each way a take can fail is said plainly, and only one of them is us', () => {
  // The one sentence this screen may never say about a take that did not happen
  // is anything that reads like teaching. It also may not blame the model for a
  // failure the model never saw: this screen is the guide's twin and carried the
  // identical defect, one sentence for four different causes.
  for (const cause of ['model', 'not-saved', 'unreachable', 'refused', 'no-answer'] as const) {
    const line = quickTakeFailedLine(cause);
    assert.ok(!/this run/i.test(line), `a time this product does not choose: ${cause}`);
    assert.ok(!/\?$/.test(line), `it does not ask them anything: ${cause}`);
    assert.ok(line.length > 0, cause);
  }
  // Where the pin genuinely did not land, nothing may promise that it did. The
  // reassurance is that the page is not lost, which is a different claim.
  assert.doesNotMatch(quickTakeFailedLine('not-saved'), /saved|on your board/i);
  assert.match(quickTakeFailedLine('not-saved'), /did not reach me/);
  // And the one that IS us says so, rather than pointing at the page.
  assert.match(quickTakeFailedLine('model'), /that is me, not the page/i);
});

test('the untrusted-label rendering contract: a runaway topic label is cut at render, and only at render', () => {
  // The label is model output over pinned text, rendered in a narrow
  // single-column panel. The untrusted-label rendering contract: cap at the untrusted boundary and at
  // render, ellipsis at render, the full label retained in the data.
  const long = 'Firestore composite index field ordering and the query planner\'s constraints';
  const cut = shortLabel(long);
  assert.ok(cut.length < long.length, 'a label long enough to scroll is not a heading');
  assert.ok(cut.endsWith('…'), 'and the learner can see that it was cut');
  assert.equal(shortLabel('IAM conditions'), 'IAM conditions', 'a real label is untouched');
  assert.equal(shortLabel('  spaced   out  '), 'spaced out');
  assert.equal(shortLabel(null), '', 'nothing to say is nothing rendered');
});

// ---------------------------------- SB-59: the copy under "what you pinned"

test('SB-59: a selection is called the learner’s, a whole page is not', () => {
  assert.equal(pinnedHeading('selection'), 'What you pinned');
  assert.equal(pinnedHeading('page'), 'What I read');
  // Anything this build does not recognise takes the modest one. Claiming the
  // learner chose something they may not have is the failure that matters.
  assert.equal(pinnedHeading('something-new'), 'What I read');
});

test('SB-59: only a whole-page pin gets the sentence explaining itself', () => {
  assert.equal(pinnedNote('selection'), null);
  const note = pinnedNote('page');
  assert.match(String(note), /without selecting anything/);
  assert.match(String(note), /Select the part you care about/, 'the fix, not only the cause');
});

test('SB-59: the passage folds at a word, and collapses the page’s own whitespace', () => {
  const short = pinnedPreview('A composite index covers a query.');
  assert.deepEqual(short, { shown: 'A composite index covers a query.', rest: '' });

  // Page text arrives with the markup's newlines in it. Reproduced faithfully
  // it reads as broken output rather than as a quotation.
  assert.equal(pinnedPreview('  one\n\n   two \t three  ').shown, 'one two three');

  const long = pinnedPreview(`${'index '.repeat(200)}END`);
  assert.ok(long.shown.length <= PINNED_PREVIEW, 'the fold does not bound the preview');
  assert.ok(!long.shown.endsWith(' '), 'a preview ending in a space is a cut mid-token');
  assert.ok(long.rest.endsWith('END'), 'the remainder must carry the rest of it');
  assert.equal(`${long.shown} ${long.rest}`.replace(/\s+/g, ' '),
    `${'index '.repeat(200)}END`.replace(/\s+/g, ' ').trim(),
    'shown plus rest is the whole passage, losing nothing in the middle');

  // Nothing pinned is no block at all, which is the caller's cue not to draw
  // a heading over an empty quotation.
  assert.equal(pinnedPreview('').shown, '');
  assert.equal(pinnedPreview('   ').shown, '');
});

test('the untrusted-label rendering contract still holds, and now cuts at a word: a runaway label is cut at render', () => {
  // The first real pin produced "Deep Learning with PyTorch - Network Arc",
  // which reads as a bug rather than an abbreviation (2026-08-22).
  const cut = shortLabel('Deep Learning with PyTorch and the Network Architectures Solution');
  assert.ok(cut.length <= 48);
  assert.ok(cut.endsWith('…'));
  assert.ok(!/\bArc…$/.test(cut), 'cut through a word');
  assert.ok(!/\b(a|an|the|and|of|for|to|with)…$/i.test(cut), 'left a dangling function word');
  assert.equal(shortLabel('Firestore indexes'), 'Firestore indexes', 'a label that fits is untouched');
});

// ------------------------------------------------------- my studies (SB-80)

test('the studying room is named for what it holds, and keeps the key it had', () => {

  const door = DOORS.find((d) => d.key === 'courses');
  assert.ok(door, 'the studying room lost its door');
  assert.equal(door.label, 'My studies');
  assert.equal(door.kind, 'room');
  assert.ok(!DOORS.some((d) => d.label === 'Studying'), 'both names are in the bar');
});

test('material is grouped by what it is, in the order a course is read in', () => {
  const material = [
    { id: 'a', kind: 'reading' }, { id: 'b', kind: 'video' },
    { id: 'c', kind: 'class' }, { id: 'd', kind: 'video' },
  ];
  const groups = groupMaterial(material);
  assert.deepEqual(groups.map((g) => g.kind), ['video', 'class', 'reading']);
  assert.deepEqual(groups.map((g) => g.label), ['Videos', 'Classes', 'Readings']);
  assert.deepEqual(groups[0]!.items.map((m) => m.id), ['b', 'd']);
  // A group with nothing in it is not returned: an empty heading is a promise
  // the course did not keep.
  assert.ok(!groups.some((g) => g.items.length === 0));
  assert.deepEqual(groupMaterial([]), []);
});

test('a kind this product does not name falls into Other rather than inventing a heading', () => {
  // A store written by a newer version must not be able to add a heading to
  // this room by putting a word in a field.
  const groups = groupMaterial([{ kind: 'podcast' }, { kind: 'other' }]);
  assert.deepEqual(groups.map((g) => g.kind), ['other']);
  assert.equal(groups[0]!.items.length, 2);
  assert.equal(MATERIAL_GROUPS[MATERIAL_GROUPS.length - 1]!.kind, 'other',
    '"Other" is no longer last, so it is a category rather than a remainder');
});

test('what is next is stated as a fact, and never as a count of what is left', () => {
  assert.equal(nextUpLine('Lecture 4'), 'Next up · Lecture 4');
  // SB-18 and SB-33: no backlog, no number of its own, nothing to clear. The
  // only digits this line can carry are the ones in the learner's own title.
  const line = nextUpLine('The scene that turns');
  assert.ok(!/\d/.test(line));
  assert.ok(!/left|remaining|to go|outstanding/i.test(line));
});

test('the four ways in are named as things rather than as sentences', () => {
  assert.deepEqual(ADD_ROUTES.map((r) => r.key),
    ['syllabus', 'course', 'material', 'dated', 'result']);
  for (const route of ADD_ROUTES) {
    assert.ok(!/[?.]/.test(route.label), `"${route.label}" is a sentence, not a name`);
    assert.ok(route.label.split(' ').length <= 4, `"${route.label}" is too long to be a tab`);
  }
});

// ============================================== the spend limit (2026-08-24)

/**
 * What the budget screen is allowed to say.
 *
 * These are not decorative strings. The service can stop somebody's model work
 * on a number they set, and every sentence here is either the thing that makes
 * that legible or a lie the screen could tell once and not take back:
 *
 * - **No money, ever.** There is no price table anywhere in this build. A
 *   currency figure on this screen would be a number about somebody's bank
 *   account that the panel invented against prices it has never seen.
 * - **Both numbers, never a bare percentage.** `fraction` is on the receipt and
 *   is deliberately not rendered on its own. "80%" is not a thing anybody can
 *   decide about; "8,400 of 10,000 tokens" is.
 * - **Cloud only.** Local and Agent CLI are counted and never stopped, and the
 *   exhausted sentence has to say so — read as total, a stop looks like the
 *   product breaking rather than a limit doing its job.
 * - **Unsized calls stay outside every total.** The usage-accounting contract presumes them billed
 *   and the provider reported no tokens for them. Folding an invented number in
 *   to make the arithmetic tidy is the same failure as inventing a price.
 */

const receipt = (over: {
  limit?: number | null; used?: number; status?: string;
  cloud?: Record<string, number>; local?: Record<string, number>; cli?: Record<string, number>;
  since?: string | null; totalTokens?: number;
} = {}): Record<string, unknown> => {
  const row = (o: Record<string, number> = {}): Record<string, number> =>
    ({ calls: 0, inputTokens: 0, outputTokens: 0, issuedNotReturned: 0, ...o });
  const connections = { cloud: row(over.cloud), local: row(over.local), cli: row(over.cli) };
  const used = over.used ?? connections.cloud['inputTokens']! + connections.cloud['outputTokens']!;
  const limit = over.limit ?? null;
  return {
    budget: limit === null ? null : { limit, unit: 'tokens', window: 'total', setAt: '2026-08-24T09:00:00.000Z' },
    state: {
      status: over.status ?? (limit === null ? 'off'
        : used >= limit ? 'exhausted' : used >= limit * 0.8 ? 'warning' : 'ok'),
      limit, unit: 'tokens', window: 'total', used,
      remaining: limit === null ? null : Math.max(0, limit - used),
      fraction: limit === null ? null : used / limit,
      warnAtFraction: 0.8, guards: ['cloud'],
      setAt: null, since: over.since === undefined ? null : over.since,
    },
    spend: { since: over.since === undefined ? null : over.since, connections },
    ...(over.totalTokens === undefined ? {} : { totalTokens: over.totalTokens }),
    notes: [],
  };
};

/** No price, in any of the shapes a price comes in. */
const noPrice = (said: string): void => {
  assert.ok(!/[£$€]\s?\d/.test(said), said);
  assert.ok(!/\b\d+(?:\.\d\d)?\s?(?:USD|GBP|EUR|dollars?|pounds?|cents?)\b/i.test(said), said);
};

test('enabled model connections with no assigned work are named without blocking standby', () => {
  const providers = {
    cloud: { enabled: true }, local: { enabled: true }, cli: { enabled: false },
  };
  assert.equal(unusedModelProvidersLine(providers, {
    quick: 'cloud', deep: 'cloud', images: 'cloud',
  }), 'Local is on, but no work is assigned to it.');
  assert.equal(unusedModelProvidersLine({ ...providers, cli: { enabled: true } }, {
    quick: 'cloud', deep: 'cloud', images: 'cloud',
  }), 'Local and Agent CLI are on, but no work is assigned to them.');
  assert.equal(unusedModelProvidersLine(providers, {
    quick: 'local', deep: 'cloud', images: 'cloud',
  }), null);
});

test('a receipt with nothing in it reads as off and counted-nothing, never as a limit in force', () => {
  const reading = budgetReadingFrom(null);
  assert.equal(reading.status, 'off');
  assert.equal(reading.limit, null);
  assert.equal(reading.learnerLimit, null);
  assert.equal(reading.operatorLimit, null);
  assert.equal(reading.limitSource, null);
  assert.equal(reading.used, 0);
  assert.equal(reading.remaining, null);
  assert.equal(reading.totalTokens, 0);
  assert.equal(reading.since, null);
  for (const mode of ['cloud', 'local', 'cli'] as const) {
    assert.deepEqual(reading.connections[mode],
      { calls: 0, inputTokens: 0, outputTokens: 0, tokens: 0, issuedNotReturned: 0 });
  }
  // The direction that matters: a field that did not arrive must never become a
  // stop the learner cannot find, so `status` follows the limit rather than the
  // other way round.
  assert.equal(budgetReadingFrom({ state: { status: 'exhausted' } }).status, 'off');
});

test('a service-owned ceiling is named and is not presented as the learner’s removable limit', () => {
  const raw = receipt({ limit: 100, used: 100 });
  raw.learnerBudget = null;
  raw.operatorLimit = 100;
  const reading = budgetReadingFrom(raw as never);

  assert.equal(reading.limit, 100);
  assert.equal(reading.learnerLimit, null);
  assert.equal(reading.operatorLimit, 100);
  assert.equal(reading.limitSource, 'operator');
  assert.match(budgetStatusLine(reading), /^This service has a 100 token ceiling\./);
});

test('a learner limit below the service ceiling remains the learner’s own removable limit', () => {
  const raw = receipt({ limit: 80, used: 20 });
  raw.learnerBudget = { limit: 80 };
  raw.operatorLimit = 100;
  const reading = budgetReadingFrom(raw as never);

  assert.equal(reading.learnerLimit, 80);
  assert.equal(reading.limitSource, 'learner');
  assert.doesNotMatch(budgetStatusLine(reading), /service has/);
});

test('a total the service did not send is summed rather than shown as zero', () => {
  // A screen reading "0 tokens" over three rows that plainly are not zero is
  // worse than one that adds them up itself.
  const reading = budgetReadingFrom(receipt({
    cloud: { inputTokens: 100, outputTokens: 20 }, local: { inputTokens: 400, outputTokens: 0 },
  }) as never);
  assert.equal(reading.totalTokens, 520);
  assert.equal(reading.connections.cloud.tokens, 120);
});

test('the limit is measured against the guarded connection alone', () => {
  const reading = budgetReadingFrom(receipt({
    limit: 1_000, used: 300,
    cloud: { calls: 2, inputTokens: 300, outputTokens: 0 },
    local: { calls: 40, inputTokens: 90_000, outputTokens: 9_000 },
  }) as never);
  assert.equal(reading.used, 300, 'free local work was charged against a paid limit');
  assert.equal(reading.remaining, 700);
  assert.equal(reading.totalTokens, 99_300, 'and the local work is still visible');
});

test('with no budget the line says exactly what is and is not happening', () => {
  const said = budgetStatusLine(budgetReadingFrom(receipt() as never));
  assert.equal(said, 'No budget is set. Nothing is stopped.');
  noPrice(said);
});

test('an ordinary window says both numbers and what is left, and never a bare percentage', () => {
  const said = budgetStatusLine(budgetReadingFrom(receipt({
    limit: 50_000, cloud: { calls: 3, inputTokens: 1_000, outputTokens: 200 },
  }) as never));
  assert.equal(said,
    'I have used 1,200 of 50,000 tokens, so 48,800 tokens are left before I stop Cloud/API work.');
  assert.ok(!/%/.test(said), 'a percentage is not something anybody can decide about');
  noPrice(said);
});

test('four fifths is a flag that says nothing has slowed down', () => {
  const said = budgetStatusLine(budgetReadingFrom(receipt({
    limit: 10_000, cloud: { inputTokens: 8_400, outputTokens: 0 },
  }) as never));
  assert.match(said, /I have used 8,400 of 10,000 tokens/);
  assert.match(said, /past the four fifths I flag at/);
  assert.match(said, /Nothing has slowed down/);
  // A warning that reads as a stop makes somebody go looking for a fault.
  assert.ok(!/stopping/.test(said), said);
  assert.ok(!/%/.test(said), said);
});

test('a spent budget names what is stopped and what is not', () => {
  const said = budgetStatusLine(budgetReadingFrom(receipt({
    limit: 5_000, cloud: { inputTokens: 5_000, outputTokens: 0 },
  }) as never));
  assert.match(said, /I have used 5,000 of 5,000 tokens, which is the whole limit/);
  assert.match(said, /I am stopping Cloud\/API calls before they are sent/);
  // Without this clause a stop reads as total, and somebody with a local model
  // sitting right there thinks the product has broken.
  assert.match(said, /Local and Agent CLI still run/);
  noPrice(said);
});

test('the window is stated as a fact, and as nothing at all when there is none', () => {
  const now = Date.parse('2026-08-24T12:00:00.000Z');
  assert.equal(budgetWindowLine(null, now), 'Nothing has been counted yet.');
  assert.equal(budgetWindowLine('2026-08-24T11:30:00.000Z', now), 'This window opened 30 min ago.');
  // A timestamp nothing can parse loses the clause rather than printing NaN.
  assert.equal(budgetWindowLine('the other day', now), 'This window is already open.');
});

test('a connection with nothing on it says so, rather than showing three zeroes', () => {
  assert.equal(budgetConnectionLine(
    { calls: 0, inputTokens: 0, outputTokens: 0, tokens: 0, issuedNotReturned: 0 }),
  'Nothing has run here.');
  assert.equal(budgetConnectionLine(
    { calls: 1, inputTokens: 900, outputTokens: 100, tokens: 1_000, issuedNotReturned: 0 }),
  '1 call · 1,000 tokens (900 in, 100 out)');
  assert.equal(budgetConnectionLine(
    { calls: 12, inputTokens: 1_200, outputTokens: 300, tokens: 1_500, issuedNotReturned: 0 }),
  '12 calls · 1,500 tokens (1,200 in, 300 out)');
});

test('calls with no returned size are explicitly outside the backstop count', () => {
  assert.equal(budgetIssuedLine(0), null, 'an empty line is a claim about nothing');
  assert.equal(budgetIssuedLine(-3), null);
  assert.equal(budgetIssuedLine(1),
    '1 call returned no size; it may be billed and is not in this token count.');
  assert.equal(budgetIssuedLine(4),
    '4 calls returned no size; they may be billed and are not in this token count.');
  // Both halves have to be there: they happened, and their size is not above.
  for (const count of [1, 4]) {
    assert.match(budgetIssuedLine(count)!, /may be billed/);
    assert.match(budgetIssuedLine(count)!, /not in this token count/);
  }
});

test('the total says what it is a total of, and what the limit is not measured against', () => {
  const said = budgetTotalLine(99_300);
  assert.equal(said,
    '99,300 tokens across all three connections. The limit is measured against Cloud/API alone.');
  noPrice(said);
});

test('the panel refuses exactly what the endpoint refuses, and says the same rule', () => {
  // The service's own list, from `model-budget-endpoints.test.ts`.
  assert.equal(budgetLimitRefusal('1'), null);
  assert.equal(budgetLimitRefusal(' 50000 '), null);
  assert.equal(budgetLimitRefusal(String(MAX_BUDGET_TOKENS_VIEW)), null);
  assert.equal(budgetLimitRefusal(''), 'Type a limit first: a whole number of tokens.');
  for (const bad of ['0', '-5', '1.5', 'lots', String(MAX_BUDGET_TOKENS_VIEW + 1), '1e30']) {
    assert.equal(budgetLimitRefusal(bad),
      'A limit is a whole number of tokens between 1 and 1,000,000,000. I have not sent that one.', bad);
  }
  assert.equal(MAX_BUDGET_TOKENS_VIEW, 1_000_000_000, 'the panel drifted from the endpoint ceiling');
});

test('the screen says once that tokens are not a price, and never renders one', () => {
  assert.match(BUDGET_TOKENS_NOT_MONEY, /safety limit on model tokens/);
  assert.match(BUDGET_TOKENS_NOT_MONEY, /not a bill or a currency total/);
  for (const said of [
    BUDGET_TOKENS_NOT_MONEY, BUDGET_GUARD_LINE, BUDGET_SAVE_NOTE, BUDGET_CLEAR_NOTE,
    BUDGET_RESET_NOTE, BUDGET_STOPPED_LINE,
  ]) noPrice(said);
});

test('the guard is explained in one sentence, and the free connections are named in it', () => {
  assert.match(BUDGET_GUARD_LINE, /backstop rather than exact spend accounting/);
  assert.match(BUDGET_GUARD_LINE, /Self-hosted routes are never stopped/);
});

test('none of the three controls implies a change it does not make', () => {
  // The one somebody reaches for at the worst moment: raising a limit is not a
  // reset, and a sentence that let them believe it was would have them wonder
  // why the stop came back immediately.
  assert.match(BUDGET_SAVE_NOTE, /moves the line, not the count/);
  assert.match(BUDGET_SAVE_NOTE, /still counts against the new number/);
  assert.ok(!/reset|start again|fresh/i.test(BUDGET_SAVE_NOTE), BUDGET_SAVE_NOTE);
  // Off keeps the record; a new window keeps the limit. Each says its own.
  assert.match(BUDGET_CLEAR_NOTE, /count of what has been spent stays exactly as it is/);
  assert.match(BUDGET_RESET_NOTE, /any limit you have set stays where it is/);
  /**
   * And the new window says which count it is talking about.
   *
   * It used to say "the count", and it used to clear all three. Sam pressed it
   * to restart a figure the page had just told him is measured against
   * Cloud/API alone, and lost the record of what his own machine had done. The
   * service clears only the guarded row now, so the note has to name it and
   * name what survives.
   */
  assert.match(BUDGET_RESET_NOTE, /sets the Cloud\/API count back to zero/);
  assert.match(BUDGET_RESET_NOTE, /Local and Agent CLI keep theirs/);
});

// ------------------------------------------------ the stop, never mislabelled

test('a 402 on the check screen is the learner’s own limit, not a fault of ours', () => {
  const said = checkUnreadableLine('refused', 402);
  assert.match(said, /Your budget stopped this before anything was sent\./);
  // The clause every branch of this line keeps.
  assert.match(said, /Nothing about your draft has changed\./);
  // And the two sentences that would send somebody to the wrong place.
  assert.ok(!/mine to fix/.test(said), said);
  assert.ok(!/not running on this computer/.test(said), said);
  assert.ok(!/shared secret/.test(said), said);
  // The other statuses are untouched by the new branch.
  assert.match(checkUnreadableLine('refused', 401), /Sign in again/);
  assert.match(checkUnreadableLine('refused', 500), /I could not check your work/);
  assert.match(checkUnreadableLine('unreachable', null), /I could not reach your board/);
});

test('the guide and the take name a budget stop rather than blaming the model', () => {
  for (const [what, said] of [
    ['take', quickTakeFailedLine('budget')], ['guide', guideFailedLine('budget')],
  ] as const) {
    assert.match(said, /Your budget stopped this before anything was sent\./, what);
    assert.ok(!/mine to fix/.test(said), `${what}: ${said}`);
    assert.ok(!/That is me, not the page/.test(said), `${what}: ${said}`);
  }
  // Every other cause still says what it always said.
  assert.match(guideFailedLine('refused'), /mine to fix/);
  assert.match(quickTakeFailedLine('model'), /That is me, not the page/);
});

test('a budget stop names only free connections that are genuinely ready to use', () => {
  assert.equal(budgetFreeRouteLine([
    { connection: 'local', enabled: true, readiness: 'ready' },
    { connection: 'cli', enabled: false, readiness: 'ready' },
  ]), 'Local is ready to use. Agent CLI is available but turned off. I did not move any model work. Open Models to choose which work to move.');
  assert.equal(budgetFreeRouteLine([
    { connection: 'local', enabled: true, readiness: 'ready' },
    { connection: 'cli', enabled: true, readiness: 'ready' },
  ]), 'Local and Agent CLI are ready to use. I did not move any model work. Open Models to choose which work to move.');
  assert.equal(budgetFreeRouteLine([
    { connection: 'local', enabled: false, readiness: 'unreachable' },
    { connection: 'cli', enabled: false, readiness: 'needs-setup' },
  ]), 'No free connection is ready yet. I did not move any model work. Open Models to set up or check Local and Agent CLI.');
  assert.equal(budgetFreeRouteLine(undefined),
    'I could not confirm whether Local or Agent CLI is ready. I did not move any model work. Open Models to check them.');
});

test('a transcription stopped by the budget says so, and says the box is untouched', () => {
  const said = transcribeOutcomeLine('budget-stopped', 3);
  assert.match(said, /Your budget stopped this before anything was sent\./);
  assert.match(said, /Nothing has gone into the box/);
  assert.match(said, /your criteria are where you left them/);
  // The generic failure is still the generic failure.
  assert.match(transcribeOutcomeLine('model-failed', 3), /That did not run/);
  assert.ok(!/budget/i.test(transcribeOutcomeLine('model-failed', 3)));
});

test('a 409 with no key saved is its own refusal, and never the budget’s', () => {
  /**
   * Dev's blocker: the deep route pointed at Cloud/API, the cloud provider had
   * no credential, and every rubric check came back instantly as "That check
   * did not run" with no reason and no hint that the fix was two clicks away.
   * The service knew precisely why and the screen said nothing.
   *
   * The two named refusals must never be said in each other's words. A limit
   * somebody chose and a setup step nobody finished send a person to two
   * different controls, and the wrong sentence has them raising a number that
   * was never the problem.
   */
  const said = checkUnreadableLine('refused', 409,
    { stoppedBy: 'model-credential', connection: 'cloud' });
  assert.match(said, /The Cloud\/API connection has no key saved/);
  assert.match(said, /Add one in Settings → Models\./);
  assert.match(said, /Nothing about your draft has changed\./);
  assert.ok(!/budget|limit|spent/i.test(said), said);
  assert.ok(!/mine to fix/.test(said), said);
  // The internal key never reaches the screen, and a connection this build does
  // not know still gets a sentence somebody can act on.
  assert.ok(!/\bcli\b|'cloud'/.test(credentialMissingLine('cli')), credentialMissingLine('cli'));
  assert.match(credentialMissingLine('cli'), /The Agent CLI connection/);
  assert.match(credentialMissingLine('something-new'), /The model connection for this work/);
  assert.match(credentialMissingLine(null), /Open Settings → Models to finish it\./);
  assert.match(credentialMissingLine('local'), /The Local connector is not running/);
  assert.match(credentialMissingLine('local'), /Start the connector shown in Settings → Models/);

  // A 409 without the discriminator is the refusal it always was: this branch
  // is keyed on what the service called it, not on the status alone.
  assert.match(checkUnreadableLine('refused', 409), /I could not check your work/);
  // And the budget's own branch is untouched.
  assert.match(checkUnreadableLine('refused', 402), /Your budget stopped this/);
});

test('a lesson answer names no input, no reading and each real refusal honestly', () => {
  assert.equal(LESSON_ANSWER_REQUIRED, 'Write your answer first.');
  assert.equal(
    lessonAnswerUnreadableLine('no-reading'),
    'I could not read the result. Your answer is still here. Try again.',
  );
  assert.match(lessonAnswerUnreadableLine('unreachable'), /I could not reach your board/);
  assert.match(
    lessonAnswerUnreadableLine('refused', 409,
      { stoppedBy: 'model-credential', connection: 'cloud' }),
    /Cloud\/API connection has no key saved/,
  );
  assert.match(
    lessonAnswerUnreadableLine('refused', 402,
      { stoppedBy: 'model-budget', connection: 'cloud' }),
    /Your budget stopped this before anything was sent/,
  );
});

test('the guide, the take and the transcription each name an unavailable connection without naming a limit', () => {
  for (const [what, said] of [
    ['take', quickTakeFailedLine('credential')],
    ['guide', guideFailedLine('credential')],
    ['transcription', transcribeOutcomeLine('credential-missing', 2)],
  ] as const) {
    assert.match(said, /connection for this work is not ready/, what);
    assert.match(said, /Open Settings → Models to finish or restart it\./, what);
    assert.ok(!/budget|spent/i.test(said), `${what}: ${said}`);
    assert.ok(!/mine to fix/.test(said), `${what}: ${said}`);
  }
  // Each still says what was lost, in its own room's words.
  assert.match(quickTakeFailedLine('credential'), /No take was written\./);
  assert.match(guideFailedLine('credential'), /No guide was written\./);
  assert.match(transcribeOutcomeLine('credential-missing', 2), /Nothing has gone into the box/);
});

// ======================================================= the plan room (2026-08-24)


const dated = (over: Partial<CommitmentView> = {}): CommitmentView => ({
  id: 'c1', title: 'Marketing analysis', kind: 'assignment', courseId: null,
  dueAt: '2026-09-01T23:59:00.000Z', plannedFor: null, estimateMinutes: null,
  doneAt: null, state: 'soon', ...over,
});

test('the three lanes are projections of the service state, and Late is not one of them', () => {
  assert.equal(laneOf('late'), 'now');
  assert.equal(laneOf('today'), 'now');
  assert.equal(laneOf('soon'), 'week');
  assert.equal(laneOf('later'), 'ahead');
  // An unrecognised state from an older or newer service lands somewhere real
  // rather than vanishing out of the room.
  assert.equal(laneOf('whatever-comes-next'), 'ahead');

  const headings = PLAN_LANES.map((l) => l.heading);
  assert.deepEqual(headings, ['Now', 'This week', 'Ahead']);
  assert.ok(!headings.some((h) => /late|overdue|behind|missed/i.test(h)), headings.join(', '));
});

test('what is late leads the Now lane, and nothing else is re-sorted', () => {
  /**
   * The service owns the ordering (`orderCommitments`). The ONE decision taken
   * in the panel is inside Now, because Now merges two of the service's states
   * and which of them leads is therefore the lane's own question.
   */
  const lanes = planLanes([
    dated({ id: 'today-1', state: 'today', title: 'Today one' }),
    dated({ id: 'late-1', state: 'late', title: 'Missed one' }),
    dated({ id: 'today-2', state: 'today', title: 'Today two' }),
    dated({ id: 'soon-1', state: 'soon', title: 'This week' }),
    dated({ id: 'later-1', state: 'later', title: 'Further out' }),
  ]);
  assert.deepEqual(lanes.now.map((c) => c.id), ['late-1', 'today-1', 'today-2']);
  assert.deepEqual(lanes.week.map((c) => c.id), ['soon-1']);
  assert.deepEqual(lanes.ahead.map((c) => c.id), ['later-1']);
});

test('a done commitment is in no lane, because the lanes are what is still on', () => {
  const lanes = planLanes([
    dated({ id: 'closed', state: 'done', doneAt: '2026-08-24T09:00:00.000Z' }),
    dated({ id: 'open', state: 'soon' }),
  ]);
  assert.deepEqual([...lanes.now, ...lanes.week, ...lanes.ahead].map((c) => c.id), ['open']);
});

test('an empty lane says what is true, and never says nothing-is-zero', () => {
  const lanes = planLanes([]);
  assert.deepEqual([lanes.now, lanes.week, lanes.ahead], [[], [], []]);
  for (const said of Object.values(PLAN_LANE_EMPTY)) {
    assert.match(said, /^Nothing/, said);
    // Not an achievement, and not a number. A product that congratulates
    // somebody for an empty lane is a product that wants it to fill up.
    assert.ok(!/\d/.test(said), said);
    assert.ok(!/caught up|well done|great/i.test(said), said);
  }
});

// ------------------------------------------------------------- three weeks

test('the strip opens on last Monday and runs three whole weeks', () => {
  // A Friday.
  const friday = Date.parse('2026-08-28T09:00:00.000Z');
  assert.equal(new Date(friday).getUTCDay(), 5);
  assert.equal(calendarStart(friday), '2026-08-17');

  const weeks = calendarWeeks([], friday);
  assert.equal(weeks.length, CALENDAR_WEEKS);
  for (const week of weeks) assert.equal(week.length, 7);
  assert.equal(weeks[0]![0]!.iso, '2026-08-17');
  assert.equal(weeks[2]![6]!.iso, '2026-09-06');
  // Monday first, and the labels agree with the columns they head.
  assert.deepEqual(weeks[1]!.map((d) => d.weekday), [...WEEKDAYS]);

  // A Sunday is the END of its week, not the start of one. Getting this wrong
  // moves every deadline one column and is invisible until a Sunday.
  const sunday = Date.parse('2026-08-30T09:00:00.000Z');
  assert.equal(new Date(sunday).getUTCDay(), 0);
  assert.equal(calendarStart(sunday), '2026-08-17');
  // And a Monday opens exactly one week back.
  assert.equal(calendarStart(Date.parse('2026-08-31T09:00:00.000Z')), '2026-08-24');
});

test('today is marked once, in the middle week', () => {
  const now = Date.parse('2026-08-28T09:00:00.000Z');
  const days = calendarWeeks([], now).flat();
  const marked = days.filter((d) => d.today);
  assert.equal(marked.length, 1);
  assert.equal(marked[0]!.iso, '2026-08-28');
  assert.equal(marked[0]!.week, 1, 'today is not in this week');
  assert.deepEqual(days.map((d) => d.week).filter((w, i, a) => a.indexOf(w) === i), [0, 1, 2]);
});

test('a deadline and a promised day are two different facts in two different cells', () => {
  const now = Date.parse('2026-08-28T09:00:00.000Z');
  const c = dated({
    dueAt: '2026-09-01T23:59:00.000Z', plannedFor: '2026-08-30T23:59:00.000Z',
  });
  const days = calendarWeeks([c], now).flat();
  const due = days.filter((d) => d.due.length);
  const planned = days.filter((d) => d.planned.length);
  assert.deepEqual(due.map((d) => d.iso), ['2026-09-01']);
  assert.deepEqual(planned.map((d) => d.iso), ['2026-08-30']);
  // The same commitment in both places, which is the point: this is where you
  // said you would do it, and that is when it is actually due.
  assert.equal(due[0]!.due[0]!.id, planned[0]!.planned[0]!.id);
});

test('the calendar is what is coming, so finished work is not drawn on it', () => {
  const now = Date.parse('2026-08-28T09:00:00.000Z');
  const days = calendarWeeks([
    dated({ id: 'closed', doneAt: '2026-08-26T10:00:00.000Z', dueAt: '2026-08-26T23:59:00.000Z' }),
  ], now).flat();
  assert.deepEqual(days.flatMap((d) => d.due.map((c) => c.id)), []);
});

test('a cell carries the thing itself and never a number', () => {
  /**
   * Open Question 7's proposed bound, ruled and accepted: the calendar shows
   * the things and never tallies. A day with four deadlines draws four titles.
   * The moment it draws "4" instead, SB-18 has been broken on the one surface
   * that grows a number in every square without anybody deciding to.
   */
  const now = Date.parse('2026-08-28T09:00:00.000Z');
  const four = ['a', 'b', 'c', 'd'].map((id) =>
    dated({ id, title: `Thing ${id}`, dueAt: '2026-08-31T23:59:00.000Z' }));
  const day = calendarWeeks(four, now).flat().find((d) => d.iso === '2026-08-31')!;
  assert.equal(day.due.length, 4);
  // The view carries the four commitments, and the only strings on the day are
  // its own date and weekday. There is nowhere for a count to live.
  assert.deepEqual(Object.keys(day).sort(),
    ['date', 'due', 'iso', 'planned', 'today', 'week', 'weekday']);
  assert.equal(day.date, '31');
});

test('the day picker offers exactly the days the strip is showing', () => {
  // One list behind both gestures, so a keyboard and a mouse cannot put a card
  // on days the other cannot reach.
  const now = Date.parse('2026-08-28T09:00:00.000Z');
  const days = calendarDays(now);
  assert.equal(days.length, CALENDAR_WEEKS * 7);
  assert.deepEqual(days, calendarWeeks([], now).flat().map((d) => d.iso));
});

test('a stored deadline keeps the calendar date the learner entered', () => {
  // A deadline is a declared date rather than an observed instant. The local
  // timezone applies to today and completion, not to rewriting that date.
  assert.equal(dayKey('2026-08-28T23:59:00.000Z'), '2026-08-28');
  assert.equal(dayKey('2026-08-28T00:00:00.000Z'), '2026-08-28');
});

test('a timed deadline renders its stated wall time and zone without UTC date drift', () => {
  const due = dated({
    dueAt: '2026-09-10T06:30:00.000Z', dueTime: '23:30',
    dueTimeZone: 'America/Los_Angeles',
  });
  assert.equal(commitmentDueDay(due), '2026-09-09');
  assert.equal(dueLine(due, Date.parse('2026-09-10T06:29:00.000Z')),
    'due today at 11:30 pm America/Los_Angeles');
  assert.equal(dueLine(due, Date.parse('2026-09-10T06:31:00.000Z')),
    'was due at 11:30 pm America/Los_Angeles');
  const marker = calendarWeeks([due], Date.parse('2026-09-09T12:00:00.000Z'))
    .flat().find((day) => day.due.some((c) => c.id === due.id));
  assert.equal(marker?.iso, '2026-09-09');
});

test('Plan reads today from the learner’s zone at a UTC date boundary', () => {
  const boundary = Date.parse('2026-08-27T00:30:00.000Z');
  const due = dated({ dueAt: '2026-08-26T23:59:00.000Z', plannedFor: '2026-08-26T23:59:00.000Z' });
  assert.equal(localDayKey(boundary, 'America/Los_Angeles'), '2026-08-26');
  assert.equal(localDayKey(boundary, 'Australia/Sydney'), '2026-08-27');
  assert.equal(dueLine(due, boundary, 'America/Los_Angeles'), 'due today');
  assert.equal(plannedLine(due.plannedFor, boundary, 'America/Los_Angeles'), 'you said today');
  const today = calendarWeeks([due], boundary, 'America/Los_Angeles')
    .flat().filter((day) => day.today);
  assert.deepEqual(today.map((day) => day.iso), ['2026-08-26']);
});

// ------------------------------------------------------------- the gesture

test('a card dropped on a day moves the promise, and can never move a deadline', () => {
  /**
   * The load-bearing assertion of the whole gesture. A due date is somebody
   * else's fact, and a drag that could move one lets a learner reschedule an
   * exam by accident. `plannedFor` is the only date on a commitment the learner
   * owns, and it is the one `awardsForClosing` pays the kept-promise award
   * against, which is the point of being able to move it.
   */
  const write = plannedForFromDrop('c1', '2026-08-30')!;
  assert.equal(write.id, 'c1');
  assert.deepEqual(write.body, { plannedFor: '2026-08-30' });
  assert.deepEqual(Object.keys(write.body), ['plannedFor'],
    'the drop carries a second field, and one of them could be a due date');
});

test('a drop that carried nothing usable sends nothing at all', () => {
  for (const [id, day] of [
    [null, '2026-08-30'], ['', '2026-08-30'], ['   ', '2026-08-30'],
    ['c1', null], ['c1', ''], ['c1', 'tomorrow'], ['c1', '2026-08-30T00:00:00.000Z'],
    ['c1', '30/08/2026'], ['c1', '2026-13-45'],
  ] as const) {
    assert.equal(plannedForFromDrop(id, day), null, `${String(id)} / ${String(day)}`);
  }
  // Whitespace around a real pair is a real pair.
  assert.deepEqual(plannedForFromDrop(' c1 ', ' 2026-08-30 '),
    { id: 'c1', body: { plannedFor: '2026-08-30' } });
});

// ------------------------------------------------------------ the tutor line

test('the tutor line is the next move and the service’s own first reason', () => {
  assert.equal(
    tutorLine('Marketing analysis', [{ text: 'This is due in 3 days.' }, { text: 'Ignored.' }]),
    'Marketing analysis · This is due in 3 days.');
  // Verbatim. When an assessed result reweighted what `/today` chose, the
  // reason already carries it; a sentence invented here would be the panel
  // making a claim the service did not make.
  assert.equal(
    tutorLine('Repair tool boundaries', [{ text: 'A recent assessed result exposed a gap in this lesson.' }]),
    'Repair tool boundaries · A recent assessed result exposed a gap in this lesson.');
  // A move with no reason is still a move, and is not padded with one.
  assert.equal(tutorLine('Marketing analysis', []), 'Marketing analysis');
  assert.equal(tutorLine('', [{ text: 'Why' }]), '', 'a reason with nothing to explain');
  // The house separator, not the mark `copy-style.test.ts` bans.
  assert.ok(!/[—–]/.test(tutorLine('A', [{ text: 'B' }])));
});

test('the room points ready lessons to Learn without explaining its pipeline', () => {
  // A lesson remains absent from the calendar, but the learner only needs the
  // destination. The old sentence made them decode why the pipeline worked.
  assert.equal(PLAN_SESSION_NOTE, 'Lessons appear in Learn when they are ready.');
  assert.ok(!/\d/.test(PLAN_SESSION_NOTE), PLAN_SESSION_NOTE);
});

test('the two ways into the Plan are the two the room can honestly offer', () => {
  assert.deepEqual(PLAN_ADD_ROUTES.map((r) => r.key), ['dated', 'result']);
  assert.deepEqual(PLAN_ADD_ROUTES.map((r) => r.label),
    ['Something with a date', 'Record a result']);
});

test('a card says how long and what was promised, and says nothing when it does not know', () => {
  assert.equal(estimateLine(45), '45 min');
  assert.equal(estimateLine(null), '');
  assert.equal(estimateLine(0), '', 'a zero-minute estimate is not an estimate');
  assert.equal(estimateLine(undefined), '');

  const now = Date.parse('2026-08-28T09:00:00.000Z');
  assert.equal(plannedLine(null, now), '');
  assert.equal(plannedLine('2026-08-28T23:59:00.000Z', now), 'you said today');
  assert.equal(plannedLine('2026-08-29T23:59:00.000Z', now), 'you said tomorrow');
  assert.equal(plannedLine('2026-08-30T23:59:00.000Z', now), 'you said in 2 days');
  // Behind the day they promised, said without a number of days attached. How
  // far behind somebody is is not something they can act on.
  assert.equal(plannedLine('2026-08-20T23:59:00.000Z', now), 'you said earlier');
  assert.equal(plannedLine('2026-09-04T23:59:00.000Z', now), 'you said in 7 days');
  assert.equal(plannedLine('2026-09-20T23:59:00.000Z', now), 'you said 2026-09-20');
});

test('a promise made after the deadline is named, and nothing else is', () => {
  /**
   * "due today" and "you said tomorrow" sat on one card in silence. This is the
   * one moment in the loop where the product knows something about the learner
   * that she has not admitted to herself, and it said nothing.
   *
   * What it must not become is a punishment. The sentence states the fact and
   * stops: no lateness, no count of days, no "you will not make it".
   */
  const card = (over: Partial<CommitmentView>): CommitmentView => ({
    id: 'c1', title: 'Blue Ocean case', kind: 'assignment',
    dueAt: '2026-08-28T23:59:00.000Z', plannedFor: null, estimateMinutes: null,
    doneAt: null, state: 'today', ...over,
  });
  assert.equal(plannedAfterDueLine(card({ plannedFor: '2026-08-29T23:59:00.000Z' })),
    'That is after it is due.');
  // The same day is not after it.
  assert.equal(plannedAfterDueLine(card({ plannedFor: '2026-08-28T08:00:00.000Z' })), '');
  assert.equal(plannedAfterDueLine(card({ plannedFor: '2026-08-27T23:59:00.000Z' })), '');
  // No promise, nothing to say about one.
  assert.equal(plannedAfterDueLine(card({})), '');
  // And a closed commitment is left alone: pointing at a deadline somebody has
  // already met is the punishment register by the back door.
  assert.equal(plannedAfterDueLine(card({
    plannedFor: '2026-08-29T23:59:00.000Z', doneAt: '2026-08-29T10:00:00.000Z',
  })), '');

  const said = plannedAfterDueLine(card({ plannedFor: '2026-08-30T23:59:00.000Z' }));
  for (const word of ['late', 'overdue', 'behind', 'missed', 'should']) {
    assert.ok(!said.toLowerCase().includes(word), `${word}: ${said}`);
  }
});

test('the card menu says which of the two dates each control moves', () => {
  // The promise/deadline split is the product's whole idea, and this menu is
  // the only place a learner meets both of them at once. The note element was
  // already in the markup and was rendered empty on every card.
  assert.match(PLAN_MENU_NOTE, /when you plan to do it/);
  assert.match(PLAN_MENU_NOTE, /deadline/);
  assert.match(PLAN_MENU_NOTE, /somebody else/,
    'the note does not say whose fact a deadline usually is');
  // One sentence. A paragraph of help inside a four-item menu is a help screen
  // that has moved in.
  assert.equal(PLAN_MENU_NOTE.split('. ').length, 1);
});


// ------------------------------------- building one, from the page that offers it

/**
 * The next move can BE a build now: a dated piece of work that names topics on
 * the board and has no lesson yet is offered the run that would make one. What
 * the page says afterwards is the whole of the honesty here, because the run
 * outlives the click by minutes.
 */
test('the build lines say what is happening and never promise a time', () => {
  assert.match(BUILD_STARTED_LINE, /working through your board now/);
  // The caveat that belongs on the screen rather than in a release note.
  assert.match(BUILD_STARTED_LINE, /takes a while/);
  assert.match(BUILD_STARTED_LINE, /do not have to wait here/);
  for (const line of [BUILD_STARTED_LINE, BUILD_ALREADY_RUNNING_LINE]) {
    assert.ok(!/\b\d+\s*(second|minute|min)\b/i.test(line),
      `a duration nobody can predict is a promise nobody can keep: ${line}`);
  }
  // Pressed twice is not a second run, and the sentence does not pretend it is.
  assert.match(BUILD_ALREADY_RUNNING_LINE, /already working through your board/);
  // And the line for somebody who did not press it and arrived while it runs.
  assert.match(BUILDING_NOW_LINE, /working through your board right now/);
  assert.match(BUILDING_NOW_LINE, /do not have to wait/);
  assert.ok(!/\b\d+\s*(second|minute|min)\b/i.test(BUILDING_NOW_LINE));
  // And a failure changes nothing, which is the part a learner needs.
  assert.match(BUILD_NOT_STARTED_LINE, /Nothing has changed/);
});

test('a live build names real stages without inventing a percentage', () => {
  assert.match(buildingStageLine('queued', 15), /safely queued for background processing/);
  assert.match(buildingStageLine('forage', 15), /Reading 15 saved items/);
  assert.match(buildingStageLine('cluster', 15), /Grouping/);
  assert.match(buildingStageLine('compose', 15), /Writing the lesson/);
  assert.match(buildingStageLine('verify', 15), /Checking the lesson/);
  assert.equal(buildingStageLine(null, 15), BUILDING_NOW_LINE);
  for (const stage of ['forage', 'cluster', 'compose', 'verify']) {
    assert.doesNotMatch(buildingStageLine(stage, 15), /%|percent/i);
    assert.match(buildingStageLine(stage, 15), /do not have to wait/i);
  }
});

test('a returned batch receipt translates agent stages and offers one useful recovery', () => {
  const activity = (over: Partial<BatchActivityView> = {}): BatchActivityView => ({
    state: 'finished', startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: '2026-08-26T00:26:42.000Z', currentStage: null,
    reports: [], outcome: 'session', remaining: 0, withheld: 0,
    failure: null, ...over,
  });
  assert.equal(batchActivityLine(activity()), 'Processing finished. Your checked lesson is ready.');
  assert.match(batchActivityLine(activity({ state: 'queued', outcome: null })), /safely queued/);
  assert.equal(batchRecoveryAction(activity({ state: 'queued', outcome: null })), null);
  assert.equal(
    batchActivityLine(activity({ learnerCorrections: 1 })),
    'Processing finished. Your checked lesson is ready. Your Insights correction was carried into its teaching brief.',
  );
  assert.match(batchActivityLine(activity({ learnerCorrections: 2 })), /corrections were carried/);
  assert.equal(batchRecoveryAction(activity()), 'lesson');
  assert.equal(batchRecoveryAction(activity({ outcome: 'quota-degraded' })), 'models');
  assert.equal(batchRecoveryAction(activity({ state: 'failed', outcome: null })), 'process');
  assert.equal(batchRecoveryAction(activity({
    state: 'failed', outcome: null, failureReason: 'model-credential',
  })), 'models');
  assert.match(batchActivityLine(activity({
    state: 'failed', outcome: null, failureReason: 'model-credential',
  })), /connection needs setup/i);
  assert.equal(batchRecoveryAction(activity({
    state: 'failed', outcome: null, failureReason: 'model-budget',
  })), 'models');
  assert.match(batchActivityLine(activity({
    state: 'failed', outcome: null, failureReason: 'model-budget',
  })), /model limit/i);
  assert.match(batchActivityLine(activity({
    outcome: 'no-session',
    reports: [{ stage: 'compose', ms: 90_000, failed: true, degradeReason: 'transport' }],
  })), /model work failed/i);
  assert.match(batchActivityLine(activity({
    outcome: 'no-session', outcomeReason: 'model-failed', reports: [],
  })), /model work failed/i);
  assert.equal(batchRecoveryAction(activity({
    outcome: 'no-session', outcomeReason: 'model-failed', reports: [],
  })), 'models');
  assert.equal(batchActivityLine(activity({
    outcome: 'no-session', outcomeReason: 'learner-context-changed', reports: [],
  })), 'Your Insights changed while this lesson was being written, so that draft was not saved. Process again to build from your current words.');
  assert.equal(batchRecoveryAction(activity({
    outcome: 'no-session', outcomeReason: 'learner-context-changed', reports: [],
  })), 'process');
  assert.match(batchActivityLine(activity({
    outcome: 'no-session', outcomeReason: 'nothing-to-teach', reports: [],
  })), /not enough supported material/i);
  assert.equal(
    batchStageReceiptLine({ stage: 'compose', ms: 243_000, failed: false }),
    'Lesson written · 4m 3s',
  );
  assert.match(
    batchStageReceiptLine({ stage: 'verify', ms: 461_500, failed: true }),
    /Lesson checked · 7m 42s · needs attention/,
  );
});

test('SB-285: a lean night is said once, and only on a night that was actually lean', () => {
  /**
   * The run this line exists for finished green with a checked lesson waiting,
   * and was the weakest night the board had produced. So the sentence is
   * appended to whatever the outcome already says rather than replacing it, and
   * it appears on exactly one condition: the run finished, and it produced no
   * observation, no statement and no proposal.
   */
  const activity = (over: Partial<BatchActivityView> = {}): BatchActivityView => ({
    state: 'finished', startedAt: '2026-08-28T00:00:00.000Z',
    finishedAt: '2026-08-28T00:26:42.000Z', currentStage: null,
    reports: [], outcome: 'session', remaining: 0, withheld: 0,
    failure: null, ...over,
  });

  assert.equal(
    batchActivityLine(activity({ lean: true })),
    `Processing finished. Your checked lesson is ready. ${LEAN_NIGHT_LINE}`,
    'a night can be lean and still have a lesson in it, and the receipt says both',
  );
  assert.doesNotMatch(batchActivityLine(activity()), /lean night/,
    'a night that produced something says nothing about being lean');
  assert.doesNotMatch(batchActivityLine(activity()), /lean night/,
    'an older service that answers nothing here is not reported as lean');
  assert.doesNotMatch(batchActivityLine(activity({ state: 'running', lean: true })), /lean night/,
    'a run still going has produced nothing YET, which is a different sentence');
  assert.doesNotMatch(
    batchActivityLine(activity({ state: 'failed', outcome: null, lean: true })), /lean night/);
  assert.doesNotMatch(batchActivityLine(activity({
    lean: true, outcome: 'no-session',
    reports: [{ stage: 'analyse', ms: 152_300, failed: true, degradeReason: 'transport' }],
  })), /lean night/, 'a degraded stage already explains the night, and two explanations is one too many');

  // The learner-controlled lineup contract's copy law, on a sentence a learner reads about their own night.
  assert.doesNotMatch(LEAN_NIGHT_LINE, /[—–]/);
  assert.doesNotMatch(LEAN_NIGHT_LINE, /sorry|apolog|great|well done|tomorrow|overnight/i,
    'no apology, no praise, and no promise about hours nobody controls');
});

test('a refused build names the pause rather than guessing at a status', () => {
  // The collection-pause contract: a pause is a pause and a button is not a way round it, so the
  // one status this panel can explain is explained, with where to undo it.
  assert.match(buildRefusedLine(409), /paused/);
  assert.match(buildRefusedLine(409), /Settings/);
  // Anything else says what happened and stops.
  assert.match(buildRefusedLine(500), /I could not start the build/);
  assert.match(buildRefusedLine(500), /Nothing has changed/);
  assert.match(buildRefusedLine(null), /Nothing has changed/);
  assert.ok(!buildRefusedLine(null).includes('null'));
});

// ------------------------------------------- linking work to what it leans on

test('the topic link says what it is for, not what it is called in the store', () => {
  // The learner does not call it a topic id. They call it what they are
  // studying, and the board is where they have seen it.
  assert.match(LINK_TO_TOPICS, /what you are studying/i);
  assert.ok(!/topicIds|field|array/i.test(LINK_TO_TOPICS));
  // The note is the reason to bother: the deadline changes what gets taught.
  assert.match(LINK_TO_TOPICS_NOTE, /teaches those things first/);
  assert.match(LINK_TO_TOPICS_NOTE, /date gets closer/);
  assert.match(LINK_TO_TOPICS_SAVE, /^Save/);
  // A refused write leaves the links where they were, and says so.
  assert.match(LINK_TO_TOPICS_FAILED, /as they were/);
});

test('a card says what it leans on, or says nothing at all', () => {
  const label = (id: string): string | undefined =>
    ({ t1: 'Tool boundaries', t2: 'IAM conditions', t3: 'TLS' })[id];
  assert.equal(linkedTopicsLine([], label), '');
  assert.equal(linkedTopicsLine(undefined, label), '');
  assert.equal(linkedTopicsLine(['t1'], label), 'Leans on Tool boundaries.');
  assert.equal(linkedTopicsLine(['t1', 't2'], label), 'Leans on Tool boundaries and IAM conditions.');
  assert.equal(linkedTopicsLine(['t1', 't2', 't3'], label),
    'Leans on Tool boundaries, IAM conditions and TLS.');
  // A link to something the board no longer has is dropped rather than printed
  // as a raw id, and a card with nothing left to name says nothing.
  assert.equal(linkedTopicsLine(['gone'], label), '');
  assert.equal(linkedTopicsLine(['gone', 't3'], label), 'Leans on TLS.');
});


// --------------------------------------- where the model work came from


test('the two lanes are named for what the learner can do about them', () => {
  assert.match(USAGE_HEADING, /where the work came from/i);
  // Their own taps, and the board's runs. Not "foreground" and not "batch".
  assert.match(USAGE_TAPS_LABEL, /pressed/i);
  assert.match(USAGE_RUNS_LABEL, /board runs/i);
  assert.match(USAGE_TOTAL_LABEL, /everything/i);
  for (const line of [USAGE_HEADING, USAGE_TAPS_LABEL, USAGE_RUNS_LABEL, USAGE_TOTAL_LABEL]) {
    assert.ok(!/llm|token row|batch|lane|foreground/i.test(line), line);
  }
});

test('the count says how far back it goes, because it does not survive a restart', () => {
  // The meter lives in the running service; the budget's own count is in the
  // store. Two windows, and the reason they differ is stated rather than left
  // to be discovered by somebody adding them up.
  assert.match(USAGE_SINCE_LINE, /since I started up/);
  assert.match(USAGE_SINCE_LINE, /budget above keeps its own longer count/);
});

test('a lane reads as calls and tokens, and says so plainly when it is empty', () => {
  assert.equal(usageCountLine({ calls: 0, inputTokens: 0, outputTokens: 0 }), 'Nothing has run here.');
  assert.equal(usageCountLine(undefined), 'Nothing has run here.',
    'an older service that sends no split must not render "undefined"');
  assert.equal(usageCountLine({ calls: 1, inputTokens: 310, outputTokens: 24 }),
    '1 call · 334 tokens (310 in, 24 out)');
  assert.equal(usageCountLine({ calls: 7, inputTokens: 11_500, outputTokens: 2_980 }),
    '7 calls · 14,480 tokens (11,500 in, 2,980 out)');
  // Tokens, never money. The claim this whole screen rests on.
  assert.ok(!/[£$€]|cost|price|spent/i.test(
    usageCountLine({ calls: 2, inputTokens: 4, outputTokens: 1 })));
});

test('embedding is counted in calls and text, because it reports no tokens', () => {
  assert.equal(usageEmbedLine({ calls: 0, inputs: 0, inputChars: 0 }), null,
    'a zero embedding line is a row about nothing');
  assert.equal(usageEmbedLine(undefined), null);
  const one = usageEmbedLine({ calls: 1, inputs: 1, inputChars: 20 });
  assert.match(String(one), /^1 embedding call over 1 piece of text\./);
  const many = usageEmbedLine({ calls: 3, inputs: 21, inputChars: 4000 });
  assert.match(String(many), /3 embedding calls over 21 pieces of text/);
  assert.match(String(many), /no token count/);
});

test('which of these numbers has a bill behind it is said once', () => {
  assert.match(USAGE_WHICH_BILLS, /Only Cloud\/API work can bill you/);
  // And the other half, which is what stops somebody switching everything off:
  // local work is counted here and costs nothing.
  assert.match(USAGE_WHICH_BILLS, /cost tokens and no money/);
});

// ---------------------------------------------- The learner-controlled lineup contract: tonight's lineup

/**
 * WHAT THE HERO SAYS, AND THE TWO PIECES OF ARITHMETIC UNDER IT.
 *
 * `panel-wiring.test.ts` proves which endpoint each control reaches. This is
 * the other half: the sentences the learner reads, and the two pure functions
 * that decide where a row lands when it is moved — which are the only part of
 * the drag-and-drop a hand-built DOM can hold, and are the same functions the
 * accessible move controls use.
 */

const lineupSection = (over: Partial<SectionView> = {}): SectionView => ({
  topicId: 't1', heading: 'How TLS gets its keys', depth: 'building',
  estimatedMinutes: 5, sourceIds: [], completed: false, why: 'due for a check', ...over,
});

const lineupSession = (sections: SectionView[]): SessionView =>
  ({ builtAt: '2026-08-24T20:00:00.000Z', fromPinCount: 3, sections });

test('the lineup is the session read the way the session room reads it', () => {
  const items = lineupItems(lineupSession([
    lineupSection(),
    lineupSection({ topicId: 't2', heading: '  Why forward  secrecy ', depth: 'fluent', estimatedMinutes: 4 }),
  ]));
  assert.deepEqual(items.map((i) => i.subject),
    ['How TLS gets its keys', 'Why forward secrecy']);
  assert.deepEqual(items.map((i) => i.registerLabel), ['building', 'fluent']);
  assert.deepEqual(items.map((i) => i.minutesLabel), ['5 min', '4 min']);
});

test('a completed section is not lined up: the lineup is what is still to do', () => {
  const items = lineupItems(lineupSession([
    lineupSection({ completed: true }),
    lineupSection({ topicId: 't2', heading: 'Why forward secrecy' }),
  ]));
  assert.deepEqual(items.map((i) => i.topicId), ['t2']);
});

test('a row with no topic id is dropped rather than drawn with dead controls', () => {
  // Every control on a row addresses the service by topic. A row without one
  // is eight buttons that cannot reach anything.
  const items = lineupItems(lineupSession([
    { depth: 'building', estimatedMinutes: 5, sourceIds: [], completed: false, heading: 'Orphan' },
    lineupSection(),
  ]));
  assert.deepEqual(items.map((i) => i.subject), ['How TLS gets its keys']);
});

test('a register this build does not know is dropped, never printed raw', () => {
  // The same rule `registerChips` keeps: the level strip is a colour key, and a
  // machine name on it would be the screen showing its own internals.
  const [item] = lineupItems(lineupSession([lineupSection({ depth: 'expert' })]));
  assert.equal(item?.register, '');
  assert.equal(item?.registerLabel, '');
});

test('provenance is a per-lesson fact behind the control that asks why', () => {
  // The hero carried "built at 21:49 from 3 things you pinned" over the whole
  // list. The time was a fact about a pipeline; the count is worth keeping at
  // the scale somebody can check it.
  assert.equal(lineupBuiltLine(3), 'Built from 3 things you pinned.');
  assert.equal(lineupBuiltLine(1), 'Built from one thing you pinned.');
  // A zero is not provenance, so the disclosure stays the reason and nothing
  // else rather than the reason and a nought.
  for (const n of [0, -1, NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(lineupBuiltLine(n), null, String(n));
  }
});

test('(i) turns the legacy empty-history reason into learner-facing language', () => {
  assert.equal(lineupWhyLine('nothing has been asked about this yet'),
    'Starting with the foundations until you show what you already know.');
  assert.equal(lineupWhyLine('you had this, and something recent suggests it has slipped.'),
    'You had this, and something recent suggests it has slipped.');
  // A reason nothing recorded is said as such. A screen that made one up would
  // defeat the entire point of the control.
  assert.equal(lineupWhyLine(null),
    'This one was picked before Virgil started recording why. The next lineup will say.');
});

test('every sentence on the lineup is free of the two dashes', () => {
  // The rule this whole window exists under, asserted on the copy it added.
  const said = [
    LINEUP_NOT_SAVED,
    LINEUP_WHY_LABEL,
    LINEUP_GOOD_LABEL, LINEUP_BAD_LABEL, LINEUP_UP_LABEL, LINEUP_DOWN_LABEL,
    LINEUP_REMOVE_LABEL,
    lineupWhyLine(null), lineupVerdictLine('good'), lineupVerdictLine('bad'),
    lineupRemovedLine('TLS', 7), lineupLevelLine('building'),
  ];
  for (const line of said) {
    assert.ok(!line.includes('—') && !line.includes('–'), line);
  }
});

test('the removal line says when it comes back, in the service’s own number', () => {
  assert.equal(lineupRemovedLine('TLS handshakes', 7),
    'Took TLS handshakes out of tonight. It comes back in about 7 days.');
  assert.equal(lineupRemovedLine('TLS handshakes', 1),
    'Took TLS handshakes out of tonight. It comes back tomorrow.');
  // A service that did not say is not a service that said zero.
  assert.equal(lineupRemovedLine('TLS handshakes', NaN),
    'Took TLS handshakes out of tonight. It comes back later.');
});

test('the verdict is acknowledged as a preference, never as a grade', () => {
  assert.equal(lineupVerdictLine('good'), 'Noted. More like this one.');
  assert.equal(lineupVerdictLine('bad'), 'Noted. Less like this one.');
  // The thing these sentences must never say. A thumbs-down is about the
  // choice; reading it as "you are bad at this" is the failure the domain
  // prevents by type and the copy must not reintroduce.
  for (const call of ['good', 'bad']) {
    assert.ok(!/know|struggl|good at|bad at|level/i.test(lineupVerdictLine(call)),
      lineupVerdictLine(call));
  }
});

test('the level is said in words as well as shown as a chip', () => {
  assert.equal(lineupLevelLine('from-nothing'), 'Starting from scratch on this one.');
  assert.equal(lineupLevelLine('building'), 'Building on what you already have.');
  assert.equal(lineupLevelLine('fluent'), 'Pitched at someone who mostly has this.');
  assert.equal(lineupLevelLine('expert'), 'The level for this one is not set.');
});

test('move up and move down walk the list, and stop at the ends', () => {
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], 'b', 'up'), ['b', 'a', 'c']);
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], 'b', 'down'), ['a', 'c', 'b']);
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], 'a', 'up'), ['a', 'b', 'c'],
    'a move off the top is the order unchanged, not a wrap');
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], 'c', 'down'), ['a', 'b', 'c']);
  assert.deepEqual(moveInOrder(['a', 'b', 'c'], 'z', 'up'), ['a', 'b', 'c'],
    'a topic that is not in the list moves nothing');
});

test('a drop lands where the pointer looks like it is landing, in both directions', () => {
  // Dragging downwards puts the row AFTER the one it was dropped on; dragging
  // upwards puts it before. Anything else and the row appears to jump past the
  // place it was released.
  assert.deepEqual(dropInOrder(['a', 'b', 'c', 'd'], 'a', 'c'), ['b', 'c', 'a', 'd']);
  assert.deepEqual(dropInOrder(['a', 'b', 'c', 'd'], 'd', 'b'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(dropInOrder(['a', 'b', 'c'], 'b', 'b'), ['a', 'b', 'c'],
    'dropping a row on itself is not a move');
  assert.deepEqual(dropInOrder(['a', 'b', 'c'], 'z', 'b'), ['a', 'b', 'c']);
  assert.deepEqual(dropInOrder(['a', 'b', 'c'], 'a', 'z'), ['a', 'b', 'c']);
});

test('a reorder never changes the set, only its order', () => {
  // The one property that separates a sort from a delete. The service holds the
  // same rule on the way in; this holds it on the way out.
  const order = ['a', 'b', 'c', 'd'];
  for (const [moved, onto] of [['a', 'd'], ['d', 'a'], ['b', 'c'], ['c', 'b']]) {
    assert.deepEqual([...dropInOrder(order, moved!, onto!)].sort(), [...order].sort());
  }
  for (const direction of ['up', 'down'] as const) {
    for (const id of order) {
      assert.deepEqual([...moveInOrder(order, id, direction)].sort(), [...order].sort());
    }
  }
});


test('a written summary is taken as it is', () => {
  assert.equal(lineupSummary('How the moon and sun combine to size the tides'),
    'How the moon and sun combine to size the tides');
});

test('the model’s light markup is not part of a label', () => {
  assert.equal(lineupSummary('**How the moon** and sun size the `tides`'),
    'How the moon and sun size the tides');
  assert.equal(lineupSummary('See [the RFC](https://example.test) for the detail'),
    'See the RFC for the detail');
});

test('these are labels, so a trailing full stop goes', () => {
  // A column of one-line labels reads better without them, and the Composer is
  // told not to write one. This is the guard for when it does anyway.
  assert.equal(lineupSummary('How the moon and sun size the tides.'),
    'How the moon and sun size the tides');
});

test('whitespace is flattened, because this is one line under a heading', () => {
  assert.equal(lineupSummary('  How the moon\n  and sun size the tides  '),
    'How the moon and sun size the tides');
});

test('the two banned dashes are normalised, even when a model wrote them', () => {
  // It is learner-facing copy the moment it is drawn, and the learner-controlled lineup contract's rule
  // has no exception for text that came out of a model.
  const said = lineupSummary('How the moon and sun — together — size the tides');
  assert.equal(said, 'How the moon and sun, together, size the tides');
  assert.ok(!said?.includes('—') && !said?.includes('–'));
});

test('a line longer than the cap is cut at a word, never mid-word', () => {
  const out = lineupSummary(`${'alpha '.repeat(60)}omega`) as string;
  assert.ok(out.length <= LINEUP_SUMMARY_CHARS + 1, `line was ${out.length} characters`);
  assert.ok(out.endsWith('…'));
  assert.ok(out.slice(0, -1).endsWith('alpha'), `cut mid-word: ${JSON.stringify(out.slice(-12))}`);
});

test('nothing usable is null, so the row simply has no summary line', () => {
  // Never a placeholder, and never the body. A row with a heading and a level
  // is still a row.
  for (const raw of [undefined, null, 42, {}, '', '   ', '\n\t']) {
    assert.equal(lineupSummary(raw as string), null, JSON.stringify(raw));
  }
});

test('the summary and the subject reach the lineup row', () => {
  const [item] = lineupItems(lineupSession([lineupSection({
    summary: 'How TLS agrees a key without sending one',
    subject: { courseId: 'c-net', title: 'Networks  and Security ' },
  })]));
  assert.equal(item?.summary, 'How TLS agrees a key without sending one');
  assert.deepEqual(item?.course, { id: 'c-net', title: 'Networks and Security' });
});

test('a subject with no id or no title is no subject: a label with no door', () => {
  for (const subject of [
    null, undefined, {}, { courseId: 'c1' }, { title: 'Networks' },
    { courseId: '', title: 'Networks' }, { courseId: 'c1', title: '  ' },
    { courseId: 7, title: 'Networks' },
  ]) {
    const [item] = lineupItems(lineupSession([lineupSection({
      subject: subject as { courseId: string; title: string } | null,
    })]));
    assert.equal(item?.course, null, JSON.stringify(subject));
  }
});


test('an owed lesson keeps its name and the pin behind it, and nothing else', () => {
  const [item] = upcomingItems([{
    topicId: 'u1', label: '  Certificate  chains ', register: 'building',
    why: 'due a quick check so it stays put', pinId: 'p1', quickTakeMinutes: 3,
  }]);
  assert.equal(item?.label, 'Certificate chains');
  assert.equal(item?.pinId, 'p1');
  assert.equal(item?.quickTakeMinutes, 3);
  // The scheduler's sentence does not travel to the rail at all. It cannot be
  // shown honestly beside a link, and translating it would be worse.
  assert.equal(JSON.stringify(item).includes('due a quick check'), false, JSON.stringify(item));
  assert.equal(JSON.stringify(item).includes('building'), false, JSON.stringify(item));
});

test('held back travels as a fact, for the row that can act on it', () => {
  // §5: the withhold is the product working and the UI is not to be embarrassed
  // by it. It is said on the pressable row, in `HELD_BACK_TAKE_LINE`, because
  // there it changes what the learner is choosing between.
  const [item] = upcomingItems([{ topicId: 'u1', label: 'Key exchange', heldBack: true, why: 'in progress' }]);
  assert.equal(item?.heldBack, true);
  assert.match(HELD_BACK_TAKE_LINE, /checked separately/);
});

test('a row in the alternatives says what it is and what it costs', () => {
  assert.equal(railRowLabel('Certificate chains', 3), 'Certificate chains · 3 min');
  assert.equal(railRowLabel('Take a recall burst', 5.4), 'Take a recall burst · 5 min');
  // An older service, or an option the ranker had no figure for. The row still
  // draws; a made-up length would be worse than none.
  for (const missing of [undefined, null, 0, -2, NaN, 'soon']) {
    assert.equal(railRowLabel('Certificate chains', missing), 'Certificate chains', String(missing));
  }
});

test('an upcoming take never exceeds either the source or the learner window', () => {
  assert.equal(boundedQuickTakeWindow(5, 1), 1);
  assert.equal(boundedQuickTakeWindow(3, 5), 3);
  assert.equal(boundedQuickTakeWindow(1, 3), 1);
  assert.equal(boundedQuickTakeWindow(5, null), null);
  assert.equal(boundedQuickTakeWindow(3, 2), 1,
    'a non-contract service value did not fail down to a real learner window');
});

test('a prepared lesson states a built fact with a real figure on it', () => {
  assert.equal(preparedReadyLine('6 min'), 'Ready in your prepared session · 6 min.');
});

test('a row with no topic or no name is not a row', () => {
  assert.deepEqual(upcomingItems([
    { topicId: '', label: 'Nameless' },
    { topicId: 'u1' } as never,
  ]), []);
  assert.deepEqual(upcomingItems(undefined), [], 'an older service sends nothing, and that is fine');
});

test('SB-241: only immediately openable material is a learn-now alternative', () => {
  /**
   * The defect the rail's rework fixes. A commitment here was the same dated
   * work the hero had just named and the Plan already lists, as a link back to
   * the Plan. What stays is a move that is itself learning.
   */
  const kept = learningAlternatives([
    { kind: 'commitment' }, { kind: 'burst' },
    { kind: 'course-material', url: 'https://example.test/lesson' },
    { kind: 'course-material', url: null },
    { kind: 'session' }, { kind: 'clarify-intake' }, { kind: 'capture-material' },
  ]);
  assert.deepEqual(kept.map((a) => a.kind), ['burst', 'course-material', 'session']);
  assert.equal(kept[1]?.url, 'https://example.test/lesson',
    'a linkless repair is not advertised under Something else instead');
  assert.deepEqual(learningAlternatives(undefined), []);
});

test('the heading names the offer, and says nothing about how clever it is', () => {
  assert.equal(INSTEAD_HEADING, 'Something else instead');
});

test('the rail’s own copy carries neither dash', () => {
  for (const line of [INSTEAD_HEADING, RAIL_EMPTY_HEADING, RAIL_EMPTY_LINE,
    HELD_BACK_TAKE_LINE, preparedReadyLine('6 min'), railRowLabel('A lesson', 3)]) {
    assert.ok(!line.includes('—') && !line.includes('–'), line);
  }
});

// ============================= The affordance-first interface contract: show, do not tell

test('the kicker is what the work costs, and it is a real figure', () => {
  // It read "Best next move · 5 min": the product's opinion of its own output,
  // over a number bounded by the time chip rather than by the lineup.
  assert.equal(expectedTimeLine(3), 'Expected time · 3 min');
  assert.equal(expectedTimeLine(0), 'Expected time · 0 min');
  assert.equal(expectedTimeLine(4.6), 'Expected time · 5 min');
  for (const bad of [NaN, -2, Number.POSITIVE_INFINITY]) {
    assert.equal(expectedTimeLine(bad), 'Expected time · 0 min', String(bad));
  }
  assert.ok(!/best|next move/i.test(expectedTimeLine(3)),
    'the kicker is still the ranker talking about the ranker');
});

test('the model notice says what a model wrote and what to do about it', () => {

  assert.match(MODEL_NOTICE, /Model-written lessons and marking can be wrong/);
  assert.match(MODEL_NOTICE, /Lesson sections show their sources/, 'it says what to do, and the interface can keep it');
  assert.ok(!/Every section/i.test(MODEL_NOTICE), 'the global shell must not promise sources in deterministic rooms');
  assert.ok(!MODEL_NOTICE.includes('—') && !MODEL_NOTICE.includes('–'));
  // SB-18's guard bans the vocabulary of a backlog everywhere, and does not
  // care that "behind" here would have meant "underneath". This is the line
  // that caught it.
  assert.ok(!/\b(behind|overdue|unread|to clear)\b/i.test(MODEL_NOTICE), MODEL_NOTICE);
  // Not a warning. `--warn` is for warnings; this is a standing condition, and
  // a footer that shouts is a footer nobody reads twice.
  assert.ok(!/warning|caution|disclaimer|please note/i.test(MODEL_NOTICE));
});

test('the empty rail names what will fill it rather than apologising', () => {
  assert.match(RAIL_EMPTY_LINE, /Pin something/);
  assert.ok(!/sorry|unfortunately|oops|nothing to see/i.test(RAIL_EMPTY_LINE));
  assert.ok(!RAIL_EMPTY_HEADING.includes('—') && !RAIL_EMPTY_LINE.includes('—'));
});

/**
 * SB-279. The first-run rail used to be one sentence about the loop, which was
 * true and sold one intake out of three. It names all three now, and this is
 * the copy law over them: three kinds of thing, a door only where there is a
 * room behind it, and no hour the product does not control.
 */
test('the arrival rail names three ways in rather than one verb', () => {
  assert.equal(ARRIVAL_WAYS_HEADING, 'Ways to add');
  assert.deepEqual(ARRIVAL_WAYS.map((way) => way.lead),
    ['A course', 'Your own work', 'The web, as you browse']);
  assert.deepEqual(ARRIVAL_WAYS.map((way) => way.door), ['capture', 'plan', null]);

  for (const way of ARRIVAL_WAYS) {
    assert.ok(!way.lead.includes('—') && !way.line.includes('—'), way.lead);
    assert.ok(!way.lead.includes('–') && !way.line.includes('–'), way.lead);
    assert.doesNotMatch(`${way.lead} ${way.line}`,
      /this run|this evening|overnight|sorry|unfortunately|oops/i);
    // The model never decides what somebody learns, and no row may imply it.
    assert.doesNotMatch(way.line, /decides what (?:you|to) learn/i);
  }

  // Each row says what happens to the thing, not what the pipeline does with it.
  assert.match(ARRIVAL_WAYS[0]!.line, /screenshot of the syllabus/);
  assert.match(ARRIVAL_WAYS[0]!.line, /you review every line before it counts/);
  assert.match(ARRIVAL_WAYS[1]!.line, /the minutes you actually have/);
  assert.match(ARRIVAL_WAYS[2]!.line, /one pin away/);
  assert.match(ARRIVAL_WAYS[2]!.line, /Before your next session/);
});

test('the caught-up rail explains return without asking for more material', () => {
  assert.equal(RAIL_CAUGHT_UP_HEADING, 'What happens next');
  assert.match(RAIL_CAUGHT_UP_LINE, /bring this back when recall is due/);
  assert.match(RAIL_CAUGHT_UP_LINE, /New things you pin join the next run/);
  assert.doesNotMatch(`${RAIL_CAUGHT_UP_HEADING} ${RAIL_CAUGHT_UP_LINE}`,
    /add one real thing|expected time|nothing.*yet/i);
});

test('a non-session move does not borrow the nightly rail copy', () => {
  assert.equal(RAIL_ONE_MOVE_HEADING, 'One move for now');
  assert.match(RAIL_ONE_MOVE_LINE, /record what happened/);
  assert.match(RAIL_ONE_MOVE_LINE, /choosing again/);
  assert.doesNotMatch(`${RAIL_ONE_MOVE_HEADING} ${RAIL_ONE_MOVE_LINE}`, /tonight|next run/i);
});

// ------------------------------------------- The single-session learning flow: the session room

test('the session rail names lessons and counts nothing', () => {
  // SB-18: nothing on any screen is a tally the learner can fall behind on, and
  // a lesson they finished is a thing they did rather than a number.
  // "Coming up", because the face toggle owns "Up next" since the 2026-08-29
  // rename and one screen must not say the same words about two things.
  assert.equal(SESSION_UP_NEXT, 'Coming up');
  assert.equal(SESSION_DONE_HEADING, 'Already done');
  for (const line of [SESSION_UP_NEXT, SESSION_DONE_HEADING, SESSION_NEXT, SESSION_FINISH]) {
    assert.ok(!/\d|left to|remaining|to clear|behind|complete/i.test(line), line);
    assert.ok(!line.includes('—') && !line.includes('–'), line);
  }
});

test('a lesson in the rail says how long it runs, and nothing else about it', () => {
  assert.equal(sessionRailLine(5), '5 min');
  assert.equal(sessionRailLine(4.4), '4 min');
  // An estimate that is not one is not shown as a fraction or a NaN.
  for (const bad of [0, -3, NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(sessionRailLine(bad), '0 min', String(bad));
  }
});

test('a write that landed and a screen that did not refresh are different sentences', () => {
  /**
   * Telling the learner nothing changed would be false: the mark went through
   * and was answered. Telling them it worked while moving them on would be
   * optimism about a read that failed.
   */
  assert.notEqual(SESSION_NOT_REFRESHED, LINEUP_NOT_SAVED);
  assert.match(SESSION_NOT_REFRESHED, /saved/i);
  assert.match(SESSION_NOT_REFRESHED, /could not catch up/i);
  assert.ok(!SESSION_NOT_REFRESHED.includes('—'));
});

test('what is left of a session counts the lesson on screen', () => {
  /**
   * The kicker's figure in the learning state. A number that dropped the moment
   * the learner opened something would be counting intent rather than work.
   */
  const s = (over: Partial<SectionView>[]): SessionView => ({
    builtAt: '2026-08-25T20:00:00.000Z', fromPinCount: 3,
    sections: over.map((o) => ({
      depth: 'building', estimatedMinutes: 5, sourceIds: [], completed: false, ...o,
    })),
  });
  assert.equal(remainingMinutes(s([{ estimatedMinutes: 6 }, { estimatedMinutes: 4 }])), 10);
  assert.equal(
    remainingMinutes(s([{ estimatedMinutes: 6, completed: true }, { estimatedMinutes: 4 }])), 4);
  assert.equal(remainingMinutes(s([])), 0);
  assert.equal(remainingMinutes(null), 0);
  // A section with no usable estimate still costs something to read, so it is
  // never nothing: the same floor the lineup row uses.
  assert.equal(remainingMinutes(s([{ estimatedMinutes: 0 }])), 1);
});

test('the four Learn faces are named for the material each one shows', () => {

  assert.deepEqual(FACES.map((f) => f.key), ['learn', 'pins', 'board', 'external']);
  assert.deepEqual(FACES.map((f) => f.label), ['Up next', 'Pins', 'Board', 'External']);
  for (const face of FACES) {
    assert.ok(!face.label.includes('—') && !face.label.includes('–'));
  }
  // A group of two buttons with no accessible name is a pair of unrelated
  // controls to a screen reader. A visible label would be the interface
  // explaining itself, which The affordance-first interface contract bans.
  assert.equal(FACE_TOGGLE_LABEL, 'What to show');
});

test('the board is no longer a room, and no door opens one', () => {
  // The types say so too: `board` is not a `DoorKey` or a `RoomKey` any more,
  // so a door pointing at one is a compile error rather than a dead control.
  assert.ok(!(DOOR_KEYS as readonly string[]).includes('board'));
  assert.ok(!(ROOM_KEYS as readonly string[]).includes('board'));
  assert.ok(!DOORS.some((d) => (d.key as string) === 'board'));
  assert.deepEqual(DOORS.filter((d) => d.kind === 'room').map((d) => d.label),
    ['Learn', 'Plan', 'My studies']);
});
