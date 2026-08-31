/** The panel never presents saved material as an unread backlog to clear. */
import { mainPageHash, mainPageRoute, type MainPageRoute } from './surfaces.js';
import {
  clearPendingLessonResults, runPendingLesson as coordinatePendingLesson,
  type ForegroundQuickTakeReply, type PendingBoardLesson,
} from './pending-lesson.js';
import { checkFormHtml, checkReadinessLine, groupCheckCriteria } from './check-surface.js';
import {
  ADD_ROUTES, type AddRouteKey, groupMaterial,
  resultsUnreadableLine, draftsUnreadableLine,
  awardsHeading, awardLine, boardCard, boardColumns, burstReasonLine,
  BOARD_IN_LESSON, BOARD_PINS_TOGGLE, boardTitleDoorLine,
  cardHeading, cardIsStartable, criterionVerdictLine, dueLine,
  markFailedLine, markRelatedLine, markSummaryDetail, markTooShortLine, markTruncatedLine, markVerdictLine,
  quarantineLine, rubricWhyLine, rubricLimitLine, rubricRefusal, starLine,
  LINK_TO_TOPICS, CHANGE_STUDY_LINK, LINK_TO_COURSE_FIELD, LINK_TO_TOPICS_FAILED,
  LINK_TO_TOPICS_FIELD,
  LINK_TO_TOPICS_NOTE,
  LINK_TO_TOPICS_SAVE, linkedTopicsLine,
  // The Plan room: a tutor line, three lanes, three weeks.
  calendarDays, calendarWeeks, commitmentDueDay, estimateLine, localDayKey, localZone,
  planLanes, plannedForFromDrop,
  plannedLine, plannedAfterDueLine, tutorLine, PLAN_ADD_ROUTES, PLAN_LANES,
  PLAN_DONE_HEADING, PLAN_MENU, PLAN_MENU_NOTE, PLAN_SESSION_NOTE, WEEKDAYS,
  MOVE_TO_A_DAY, MOVE_TO_DAY_FIELD, MOVE_TO_DAY_SAVE,
  REMOVE_PLANNED_DAY,
  CHANGE_THE_DATE, SAVE_THE_DATE, REOPEN_ACTION,
  ONLY_THIS_DATE, THIS_AND_LATER, SKIP_THIS_DATE, STOP_THIS_AND_LATER,
  recurrenceLine, weeklyPreviewDates,
  DELETE_ACTION, DELETE_CONFIRM, DELETE_CONFIRM_ACTION, KEEP_IT,
  type MarkView,
  type AwardView, type BurstItemView, type CommitmentView, type PlanView,
  isTheme, unfiledArea, type Theme, type UnfiledPin,
  MODEL_NOTICE,
  BACK_TO_DRAFT, CHECK_RESULT_STALE,
  // The learning-navigation contract: the board became a face of Learn rather than a room.
  FACES, FACE_TOGGLE_LABEL, type FaceKey,
  repairImportedRubric, mapPayloadChunks, folderItemPath,
  interruptedCourseDropLine,
} from './panel-core.js';
import {
  deleteAccount, discoverAuthConfig, learnerLabel, readAuthConfig, readSession,
  signInWithGoogle, signOut,
} from './identity.js';
import { EFFORT_CHOICES, PIN_NOTE_MAX_CHARS } from './pin-box.js';
import {
  checkRefusal, deleteStatementConfirmLines,
  findingTopicLine, reviewBasisLine, reviewSummary,
  domainListNote, esc, flaggedLine, hasSomethingReady, isPausedNow,
  matchesSearch, matchesPinSearch, searchCommitments, searchCourses, searchEmptyLine,
  SEARCH_BOARD_HEADING, SEARCH_COURSES_HEADING, SEARCH_COURSES_WAITING,
  SEARCH_COURSES_UNREADABLE, SEARCH_PLAN_HEADING, type CommitmentHitView,
  VIRGIL_UNAVAILABLE,
  mergeConfirmLines, modelEmptyLine, momentumLine,
  BUILD_ALREADY_RUNNING_LINE, BUILD_NOT_STARTED_LINE, BUILD_STARTED_LINE, buildRefusedLine,
  USAGE_HEADING, USAGE_KICKER, USAGE_RUNS_LABEL, USAGE_SETUP_LABEL, USAGE_SETUP_LINE,
  USAGE_SINCE_LINE, USAGE_TAPS_LABEL,
  USAGE_TOTAL_LABEL, USAGE_WHICH_BILLS, usageCountLine, usageEmbedLine,
  type UsageReportView,
  AUTO_CHOICES, AUTO_HEADING, autoStateLine, autoThreshold,
  offLimitsLines, parseDomainList, PAUSE_CHOICES, PAUSE_SCOPE_LINE,
  pausedBannerNote, pauseStateLine, pauseUntil,
  // The learner-lineup contract: tonight's lineup, its five controls, and their sentences.
  dropInOrder, lineupItems, lineupBuiltLine, lineupLevelLine, lineupSummary, learningAlternatives,
  remainingMinutes,
  upcomingItems, INSTEAD_HEADING, preparedReadyLine, railRowLabel,
  type UpcomingView,
  lineupRemovedLine, lineupVerdictLine, lineupWhyLine, moveInOrder,
  LINEUP_BAD_LABEL, LINEUP_DOWN_LABEL,
  LINEUP_GOOD_LABEL, LINEUP_NOT_SAVED, LINEUP_ORDER_SAVED, LINEUP_ORDER_SAVING,
  LINEUP_REMOVE_SAVING, LINEUP_VERDICT_SAVING, MODEL_WORDS_SAVING,
  expectedTimeLine, lineupServesTitle,
  LINEUP_HEADING_SENT, lineupHeading,
  SESSION_UP_NEXT, SESSION_DONE_HEADING,
  sessionClosingLine, sessionRailLine,
  LINEUP_REMOVE_LABEL, LINEUP_UP_LABEL, LINEUP_WHY_LABEL,
  lineupCourseTitle, lineupOpenTitle,
  type LineupItem,
  registerChips, registerLabel,
  safeHref, sourceAvailabilityLine, splitConfirmLines, splitRefusal,
  TOPIC_LABEL_LIMIT_LINE,
  splittable, statementBadge, statementEditAction, statementEditLabel,
  statementDeleteAction, statementConfirmAction, statementActionLabel,
  STATEMENT_CONFIRM_ACTION, STATEMENT_CONFIRM_FAILED,
  STATEMENT_CONFIRMED_LINE,
  MODEL_CORRECTION_SAVED_LINE, statementEditChanged,
  statementEditNoChangeLine, statementEditRefusal, withheldLines,
  MODEL_INTRO_LINE, MODEL_ADD_ACTION, MODEL_ADD_LABEL, MODEL_ADD_PLACEHOLDER,
  LEARNER_STATEMENT_MAX_CHARS, MODEL_INSIGHT_LIMIT_LINE,
  statementAddRefusal,
  GUIDE_CHOICES, guideFailedLine, guideFinishedLine, guideNoSubjectLine, guideProgressLine,
  guideStuckFailedLine, savedPinLine, withheldSourceLine, PANEL_PICK_UNAVAILABLE, boardUnreadableLine,
  LOADING_PINS, LOADING_SPLIT_PINS, boardPinsUnreadableLine, BOARD_EXIT,
  withheldNextLine,
  DOORS, roomMeasure, type DoorKey, type RoomKey,
  HOW_TO_PIN,
  MOMENTUM_HEADING,
  type GuideFailure,
  PINNED_LESS, PINNED_MORE, pinnedHeading, pinnedNote, pinnedPreview,
  LOADING_ASK, LOADING_CHECK, LOADING_GUIDE, LOADING_HOME, LOADING_SLOW_NOTE, LOADING_STUCK,
  LOADING_TAKE,
  ASK_PLACEHOLDER, ASK_SEND, ASK_SHORTCUTS, ASK_YOU, askFailedLine,
  OFFER_AS_PIN_ACTION, OFFER_AS_PIN_DONE, offerAsPinLine,
  quickTakeFailedLine,
  shortLabel,
  modelConfigFrom, compatibilityReading, MODEL_MODES, MODEL_ROUTES, MODEL_CONNECTION_LABEL,
  unusedModelProvidersLine,
  contextWhyLine, contextTruncatedLine,
  uploadOutcomeLine, READING_FILE, RENDERING_PAGES,
  CHECK_TITLE, draftWhyLine,
  attachedPagesLine, attachedMeterNote, pagesOutcomeLine, noTextKeptPagesLine,
  READ_TEXT_INSTEAD, REMOVE_ATTACHMENT,
  scannedRubricLine, TRANSCRIBE_ACTION, TRANSCRIBING_PAGES, transcribeOutcomeLine,
  sourceImageTranscriptionLine, TRANSCRIBING_SOURCE_IMAGE,
  sourceImageReadLine,
  type TranscribeView,
  CHECK_LIMITS_FALLBACK, checkLimitsFrom, draftCap, rubricSoftCap, sizeWarningLine,
  checkHandoffLines, checkMinimumShortfall,
  filePendingLine, fileBlockingLine, fileLeftOutLine, LEAVE_FILE_OUT,
  windowWarningLine, checkUnreadableLine, reviewTruncatedLine, quarantineGroups,
  findingPinOffer, FINDING_PIN_ACTION, FINDING_PIN_DONE, FINDING_LEARN_ACTION, FINDING_PIN_FAILED,
  budgetReadingFrom, budgetStatusLine, budgetWindowLine, budgetConnectionLine,
  budgetIssuedLine, budgetTotalLine, budgetLimitRefusal,
  BUDGET_KICKER, BUDGET_HEADING, BUDGET_TOKENS_NOT_MONEY, BUDGET_GUARD_LINE,
  BUDGET_ACTIVITY_HEADING, BUDGET_LIMIT_LABEL, BUDGET_SAVE_ACTION,
  BUDGET_CLEAR_ACTION, BUDGET_RESET_ACTION, BUDGET_SAVE_NOTE, BUDGET_CLEAR_NOTE,
  BUDGET_RESET_NOTE, BUDGET_SAVED, BUDGET_CLEARED, BUDGET_WINDOW_RESET,
  BUDGET_WRITE_UNREACHABLE, BUDGET_WRITE_REFUSED,
  BUDGET_READ_UNREACHABLE, BUDGET_READ_REFUSED, MAX_BUDGET_TOKENS_VIEW,
  budgetFreeRouteLine, type BudgetFreeConnectionView,
  DRIVE_KICKER, DRIVE_HEADING, DRIVE_CONSENT_LINE, DRIVE_LOCAL_LINE,
  DRIVE_CONNECT_ACTION, DRIVE_DISCONNECT_ACTION, DRIVE_ADD_SOURCES_LINE,
  DRIVE_VALUE_LINE, DRIVE_NOTEBOOK_LINE,
  DRIVE_FOLDER_ACTION, DRIVE_NOT_WRITTEN_YET, DRIVE_UNREACHABLE, DRIVE_REFUSED,
  DRIVE_OPEN_PERMISSION_ACTION, DRIVE_PERMISSION_TAB_FAILED,
  driveBadge, driveClientLine, driveConnectLine, driveDocRow, driveForgetConfirmLines,
  type BudgetReading, type ModelBudgetReceiptView,
  type CheckLimitsView, type ReviewView, type QuarantinedLineView, type HealthView,
  type CompatibilityReading,
  type FindingView, type FlaggedRowView, type ModelConfigView, type ModelModeView,
  type ModelProviderSetupView, type ModelRouteView, type NormalisedModelConfig,
  type PrefsView, type ProgressionEventView,
  type SessionCardView, type SessionView, type StatementView,
} from './panel-core.js';
/** The lesson module builds the DOM; this file provides its navigation doors. */
import {
  clearLessonMemory, hasLessonDrafts, lessonSurfaces, lessonTitle, subjectOf,
  type LearnNextRow, type LessonShell, type Section, type Session,
} from './lesson.js';
import { PREFS_CHANGED } from './prefs.js';
import {
  foregroundLessonSurfaces,
  type ForegroundAskTurn,
} from './foreground-lesson.js';
import {
  quickTakeAnsweredLine, quickTakeClose,
  type QuickTakeCloseReply, type QuickTakeVerdict,
} from './quick-take-close.js';
import { quickTakeOffer, type QuickTakeSwap } from './quick-take-offer.js';
import { GLYPH, iconButton } from './panel-glyphs.js';
import {
  AWAITING_PIN_TIMEOUT_MS, HANDOFF_KEY, HANDOFF_STARTED, handoffFor, isAwaitingPin, pendingTake,
  type Handoff,
} from './learn-now.js';
import { HandoffPresentation } from './handoff-presentation.js';
import {
  HOSTED_NOTEBOOK_DOC_KEYS, LEARN_NOW_DOC, NOTEBOOK_PUSH_LABEL,
  hostedNotebookWrittenLine,
  notebookClipboardText, notebookCopiedLine, notebookCopyFailedLine, notebookNotKeptLine,
  notebookPushFailedLine, notebookPushSeamLine, notebookPushedLine, notebookTabFailedLine,
  notebookTarget,
} from './notebook.js';
import {
  writeHostedNotebookDocuments, type HostedNotebookDocument,
} from './notebook-drive.js';
import {
  TUTOR_BESIDE_LABEL, TUTOR_COPY_LABEL, TUTOR_FORWARD_LABEL, TUTOR_ROUTES_HEADING,
  besideWindow, popupFeatures, tutorClipboardPrompt,
  tutorForwardedLine, tutorForwardTarget,
  tutorOpenFailedLine, tutorRouteTitle,
  topicClipboardPrompt, topicForwardTarget,
  type ForwardWhere, type TutorBrief,
} from './tutor-brief.js';
import {
  externalFace, BOARD_LEARN, BOARD_RUN_THEN_LEARN, BOARD_SEND, BOARD_SEND_TITLE,
  SEND_CARRIES_LESSON, SEND_CARRIES_NOTHING, SEND_CARRIES_SAVED, SEND_NO_NOTEBOOK,
  type ExternalEntryView, type ExternalMarkReply,
} from './external.js';
import {
  agentCapabilityUrl, boardPageUrl, CLIENT_SCHEMA_VERSION, serviceBase, serviceFetch,
} from './service.js';
import {
  EXPERIMENTAL_CAPTURE_CHANGED, EXPERIMENTAL_WHOLE_PAGE_KEY, OPEN_SELECTOR,
} from './pin-modes.js';
import { newClientRef } from './pin-body.js';
import { flushExternalPending, recordExternal } from './external-receipts.js';
import { renderHostedDriveSettings } from './hosted-drive-settings.js';
import { renderTenantSettings } from './tenant-settings.js';
import { SELECT_STATUS, selectorStatusLine, type SelectStatus } from './selector.js';
import { applyDocumentTheme, THEME_KEY } from './theme.js';
import { AccountScope } from './account-scope.js';
import { RoomLifecycle, type RoomOwnership } from './room-lifecycle.js';
import { materialCheckInPrompt, materialCheckInReceipt } from './material-check-in.js';
import { BrowserTabs } from './browser-tabs.js';
import { courseMaterialRow, courseNextMove, exclusiveAddToggle } from './course-material.js';
import { caughtUpBlock, railEmptyBlock, waysToAddBlock, type ArrivalDoor } from './arrival.js';
import { initWebMcp, WEBMCP_RECEIPT_EVENT, type WebMcpReceipt } from './webmcp.js';
import { mountWebMcpReceipt } from './webmcp-receipt.js';
import { prospectSection, prospectSettingRow, statementsCitedByProposals,
  PROSPECT_SETTING_FAILED,
  PROSPECT_SETTING_SAVING, type ProspectDecision, type ProspectProposalView } from './prospect.js';
import { boardWaiting, processControl } from './process-bar.js';
import {
  CAPTURE_SESSION_ADDED, CAPTURE_SESSION_KEY, CAPTURE_SESSION_REMOVED,
  captureSessionPins, dismissCaptureSessionPin, type CaptureSessionPin,
} from './capture-session.js';
import { insightFirstUse, insightSections, modalityQuestion, slippingSection,
  MODEL_PAGE_TITLE,
  statementConsequence, statementEvidence,
  type InsightSectionKey, type InsightStatementView,
  type SlippingRowView } from './insights.js';
import {
  appendText, pageFormatOf, readPages, readUpload, UPLOAD_ACCEPT, VISION_UPLOAD_ACCEPT,
  type PageInputFormat, type UploadFile,
} from './upload.js';
import { mountPinsFace, type PinSummary, type PinsRead } from './pins-face.js';
import { restoreGuidePresentation } from './guide-view.js';

const app = document.getElementById('app')!;

/**
 * The surface content is written onto.
 *
 * On the main page every room uses one framed board canvas. The Board room
 * already creates its own `.board`; the other rooms receive `.room-board` from
 * `frame()`. The side panel stays a compact column and writes straight to app.
 */
let roomContent: HTMLElement = app;
/** Last compatibility fact this surface has actually received. `null` is no
 * claim; an unreachable service is not silently turned into version skew. */
let SERVICE_COMPATIBILITY: CompatibilityReading | null = null;
/**
 * The identity of the room that currently owns `#app`.
 *
 * A page render often waits on several service reads. Navigation is allowed
 * while those reads are in flight, so a continuation must prove it still owns
 * the room before it paints. The content node alone is not enough on the side
 * panel, where every screen writes directly to the same `#app` element.
 */
const ROOM_LIFECYCLE = new RoomLifecycle<HTMLElement>();
const roomOwnership = (): RoomOwnership<HTMLElement> => ROOM_LIFECYCLE.ownership(roomContent);
const ownsRoom = (owner: RoomOwnership<HTMLElement>): boolean =>
  ROOM_LIFECYCLE.owns(owner, roomContent);
const beginRoom = (): void => ROOM_LIFECYCLE.begin();

/** Cancel only reads when a learner leaves the room. A write they already
 * asked for must be allowed to reach an answer; cancelling it at the browser
 * would leave the service's state unknowable to the screen that initiated it. */
const inRoom = (init: RequestInit = {}): RequestInit =>
  ROOM_LIFECYCLE.read(init);

/** The side panel hosts momentary actions; `/app/` hosts persistent rooms. */
const SURFACE: 'panel' | 'page' = app?.dataset?.surface === 'page' ? 'page' : 'panel';
const BROWSER_TABS = new BrowserTabs(SURFACE);

let panelPickTabId: number | null = null;
let panelPickFeedback: {
  line: string; state: 'working' | 'done' | 'failed'; manualAdd?: boolean;
} | null = null;
const panelSelectStatus = { lane: Promise.resolve() as Promise<void> };
const HANDOFF_PRESENTATION = new HandoffPresentation(chrome.storage.local, async (pending) => {
  if (pending.intent === 'guide') await renderGuide(pending);
  else await renderQuickTake(pending);
});

const paintPanelPickFeedback = (): void => {
  const status = app.querySelector('.panel-tool-status') as HTMLElement | null;
  if (!status) return;
  status.replaceChildren();
  status.textContent = panelPickFeedback?.line ?? '';
  if (panelPickFeedback) status.setAttribute('data-state', panelPickFeedback.state);
  else status.removeAttribute('data-state');
  if (panelPickFeedback?.manualAdd) {
    const add = el(`<button class="link">Add it another way</button>`);
    add.addEventListener('click', () => void openAddSourcePage());
    status.append(add);
  }
};

async function receivePanelSelectStatus(status: Partial<SelectStatus> | null): Promise<void> {
  if (status?.kind !== SELECT_STATUS) return;
  if (status.state !== 'saving' && status.state !== 'saved' && status.state !== 'failed') return;
  if (!Number.isInteger(status.count) || !Number.isInteger(status.queued)) return;
  // The picker may have been opened from the toolbar popup while this panel
  // was already visible. In that route the panel did not originate the
  // request, so bind the first status only when it names the ordinary page
  // currently beside this panel. Once bound, keep that exact tab through the
  // whole save even if focus moves.
  if (panelPickTabId === null) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    if (typeof tab?.id !== 'number' || tab.id !== status.tabId) return;
    panelPickTabId = tab.id;
  }
  if (status.tabId !== panelPickTabId) return;
  // Capture confirms what landed and lets the learner choose what happens
  // next. Saving a pin is not consent to spend a model call or to choose the
  // quick lesson over Gemini, Notebook or simply leaving it on the board.
  // The stored quick-take handoff is cleared because the live receipt now owns
  // this exact picker outcome; an explicitly chosen Learn action recreates it.
  if (status.state === 'saved' && status.count === 1 && status.queued === 0
    && typeof status.lessonPinId === 'string' && status.lessonPinId) {
    const pinId = status.lessonPinId;
    const label = typeof status.lessonLabel === 'string' ? status.lessonLabel : null;
    panelPickFeedback = null;
    panelPickTabId = null;
    void chrome.storage.local.set({ [HANDOFF_KEY]: null }).catch(() => {});
    void renderCaptureReceipt(pinId, label);
    return;
  }
  panelPickFeedback = {
    line: selectorStatusLine(status as SelectStatus),
    state: status.state === 'saving' ? 'working' : status.state === 'saved' ? 'done' : 'failed',
  };
  paintPanelPickFeedback();
  if (status.state !== 'saving') panelPickTabId = null;
}

if (SURFACE === 'panel') {
  chrome.runtime.onMessage.addListener((message: unknown) => {
    const notice = message as { kind?: unknown; pinId?: unknown; handoff?: unknown } | null;
    if (notice?.kind === HANDOFF_STARTED) {
      const pending = pendingTake(notice.handoff, Date.now());
      if (pending) void HANDOFF_PRESENTATION.present(pending);
      return false;
    }
    if (notice?.kind === CAPTURE_SESSION_ADDED && typeof notice.pinId === 'string' && notice.pinId) {
      void openSessionPin(notice.pinId).catch(() => {});
      return false;
    }
    if (notice?.kind === CAPTURE_SESSION_REMOVED && typeof notice.pinId === 'string' && notice.pinId) {
      void refreshCaptureAfterRemoval(notice.pinId).catch(() => {});
      return false;
    }
    const status = message as Partial<SelectStatus> | null;
    if (status?.kind !== SELECT_STATUS) return false;
    if (panelPickTabId !== null) {
      // The panel-originated route already owns an exact tab and remains
      // synchronous, so its working/saved receipt paints with the message.
      void receivePanelSelectStatus(status).catch(() => {});
      return false;
    }
    // Preserve worker message order while the fallback adjacent-tab lookup is
    // asynchronous; otherwise a fast `saved` could paint before `saving` and
    // then be overwritten by the older receipt.
    panelSelectStatus.lane = panelSelectStatus.lane
      .then(() => receivePanelSelectStatus(status))
      .catch(() => {});
    return false;
  });
}

/**
 * A new browser tab from either of Virgil's two real execution contexts.
 *
 * The side panel is an extension page and owns `chrome.tabs`. The full product
 * page is deliberately served by the learner's local/cloud service, so it is
 * an ordinary HTTP page and does not. Calling the extension API there was a
 * latent TypeError behind every external lesson/source/Notebook door.
 *
 * Async hand-offs try the same native door after their service read. If the
 * browser's gesture window has expired, their existing in-page fallback keeps
 * the exact destination as a second explicit press. Opening a blank tab first
 * would steal focus before the clipboard write and manufacture a different
 * failure.
 */
const openBrowserTab = (
  url: string, reuseKey: string | null = null,
): Promise<'opened' | 'reused'> =>
  BROWSER_TABS.open(url, reuseKey);

/** Open the main page, or come back to it. On a page this is navigation the
 *  learner can see; from the panel it is a tab, which is the whole point. */
async function openMainPage(): Promise<void> {
  if (SURFACE === 'page') return renderHome();
  try {
    await chrome.tabs.create({ url: await boardPageUrl() });
  } catch {
    // No tabs API (a test host, or a surface that is neither): the main screen
    // in place beats a control that does nothing when pressed.
    return renderHome();
  }
}

/** The honest route from a browser-owned page: the reviewed source intake,
 * opened on its first real field, with no write implied by navigation. */
async function openAddSourcePage(): Promise<void> {
  if (SURFACE === 'page') {
    STUDIES_ADD_ROUTE = 'syllabus';
    return renderCourses(null, true, null, null, false, '.source-text');
  }
  try {
    await chrome.tabs.create({ url: await boardPageUrl('add-source') });
  } catch {
    STUDIES_ADD_ROUTE = 'syllabus';
    return renderCourses(null, true, null, null, false, '.source-text');
  }
}

/** The actionable destination named by budget and credential refusals. */
async function openModelsPage(): Promise<void> {
  if (SURFACE === 'page') return renderSettings('models', true);
  try {
    await chrome.tabs.create({ url: `${await boardPageUrl()}${mainPageHash('models')}` });
  } catch {
    return renderSettings('models', true);
  }
}

/**
 * The two persistent tools at the top of the side panel.
 *
 * Chrome already draws Virgil's name and icon in the native side-panel header,
 * so repeating the brand here spends the narrowest part of the surface on no
 * new information. This row begins immediately beneath Chrome's header and
 * stays there while the lesson scrolls.
 *
 * Visit full site leaves for the hosted full page. Pick what to pin acts on
 * the ordinary web page beside the panel through the worker's one Selector
 * route; the panel does not grow a second injection implementation of its own.
 */
function panelTools(): HTMLElement {
  const node = el(`<header class="panel-tools"></header>`);
  const open = el(`<button class="panel-tool panel-tool-site" title="Visit the full Virgil site">
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M8 4H4.5A1.5 1.5 0 0 0 3 5.5v10A1.5 1.5 0 0 0 4.5 17h10a1.5 1.5 0 0 0 1.5-1.5V12"></path>
      <path d="M10 3h7v7M17 3l-8 8"></path>
    </svg>
    <span>Visit full site</span>
  </button>`);
  open.addEventListener('click', () => void openMainPage());

  const pick = el(`<button class="panel-tool panel-tool-pick" title="Pick parts from the page beside Virgil">
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7 3H3v4M13 3h4v4M3 13v4h4M17 13v4h-4"></path>
      <circle cx="10" cy="10" r="2.5"></circle>
    </svg>
    <span>Pick what to pin</span>
  </button>`) as HTMLButtonElement;
  const status = el(`<p class="panel-tool-status" role="status"></p>`);
  if (panelPickFeedback) {
    status.textContent = panelPickFeedback.line;
    status.setAttribute('data-state', panelPickFeedback.state);
    if (panelPickFeedback.manualAdd) {
      const add = el(`<button class="link">Add it another way</button>`);
      add.addEventListener('click', () => void openAddSourcePage());
      status.append(add);
    }
  }
  pick.addEventListener('click', async () => {
    panelPickFeedback = { line: 'Opening the picker…', state: 'working' };
    paintPanelPickFeedback();
    pick.disabled = true;
    // Name the page beside this panel while the learner's click is still here.
    // Asking the service worker to rediscover an "active tab" later made the
    // target depend on worker/window focus and was the reason this control could
    // answer without putting a picker on the page the learner was looking at.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    panelPickTabId = typeof tab?.id === 'number' ? tab.id : null;
    const reply = await chrome.runtime.sendMessage({ kind: OPEN_SELECTOR, tabId: tab?.id }).catch(() => null) as
      { ok?: boolean } | null;
    pick.disabled = false;
    if (reply?.ok === true) {
      panelPickFeedback = { line: 'Picker open on the page. Choose what to keep, then confirm it.', state: 'working' };
    } else {
      panelPickFeedback = { line: PANEL_PICK_UNAVAILABLE, state: 'failed', manualAdd: true };
      panelPickTabId = null;
    }
    paintPanelPickFeedback();
  });
  node.append(open, pick, status);
  return node;
}

/** `Section` and `Session` moved to `lesson.ts` with the surfaces that build
 *  them: the shapes belong with the module that reads every field. */
interface Topic {
  id: string; label: string; state: string; pinIds: string[]; summary?: string;
  /** Human board projection from the service; absent on an older service. */
  area?: string;
}
interface PinDetail {
  id: string; type: 'interest' | 'struggle'; note: string | null;
  label: string | null; capturedAt: string; topicId: string | null;
  requestedRegister: 'from-nothing' | 'building' | 'fluent' | null;
  requestedMinutes: number | null;
  source: {
    text: string; kind: string; pageTitle: string; url: string | null;
    headingPath: string[];
    availability: {
      status: 'available' | 'unavailable'; checkedAt: string; checkedBy: 'learner';
    } | null;
  };
}

/**
 * Which board owns this panel's temporary capture shortcuts.
 *
 * `null` is the deliberately single-board self-hosted mode. `undefined` means
 * this deployment uses accounts but nobody is signed in, so no previous
 * account's labels are allowed to appear.
 */
async function captureSessionOwner(): Promise<string | null | undefined> {
  const config = await readAuthConfig();
  if (config === null) return null;
  return (await readSession())?.uid;
}

async function currentCaptureSessionPins(): Promise<CaptureSessionPin[]> {
  const ownerUid = await captureSessionOwner();
  if (ownerUid === undefined) return [];
  try {
    const got = await chrome.storage.session.get(CAPTURE_SESSION_KEY);
    return captureSessionPins(got?.[CAPTURE_SESSION_KEY], ownerUid);
  } catch { return []; }
}

async function dismissCaptureShortcut(pinId: string): Promise<CaptureSessionPin[]> {
  const ownerUid = await captureSessionOwner();
  if (ownerUid === undefined) return [];
  try {
    const got = await chrome.storage.session.get(CAPTURE_SESSION_KEY);
    const nextRaw = dismissCaptureSessionPin(got?.[CAPTURE_SESSION_KEY], pinId, ownerUid);
    await chrome.storage.session.set({ [CAPTURE_SESSION_KEY]: nextRaw });
    return captureSessionPins(nextRaw, ownerUid);
  } catch { return currentCaptureSessionPins(); }
}

async function openSessionPin(pinId: string): Promise<void> {
  const held = await currentCaptureSessionPins();
  const pin = held.find((row) => row.pinId === pinId);
  if (pin) await renderCaptureReceipt(pin.pinId, pin.label);
}

async function refreshCaptureAfterRemoval(pinId: string): Promise<void> {
  const shown = app.querySelector('.capture-result') as HTMLElement | null;
  if (!shown) return;
  const activeId = shown.getAttribute('data-pin-id');
  const held = await currentCaptureSessionPins();
  if (activeId === pinId) {
    const next = held[0];
    if (next) await renderCaptureReceipt(next.pinId, next.label);
    else await renderHome();
    return;
  }
  const active = held.find((row) => row.pinId === activeId);
  if (active) await renderCaptureReceipt(active.pinId, active.label);
}

function captureSessionSwitcher(
  held: readonly CaptureSessionPin[], recent: readonly PinSummary[], activePinId: string,
): HTMLElement | null {
  const heldIds = new Set(held.map((pin) => pin.pinId));
  const saved = recent.filter((pin) => !heldIds.has(pin.id));
  if (!held.length && !saved.length) return null;
  const details = el(`<details class="capture-session">
    <summary></summary>
    <div class="capture-session-list" role="list"></div>
  </details>`);
  (details.querySelector('summary') as HTMLElement).textContent = saved.length
    ? `Pinned · ${held.length + saved.length}`
    : `This session · ${held.length}`;
  const list = details.querySelector('.capture-session-list') as HTMLElement;
  const group = (label: string): void => {
    const heading = el(`<div class="capture-session-group"></div>`);
    heading.textContent = label;
    list.append(heading);
  };
  if (held.length && saved.length) group('This session');
  for (const pin of held) {
    const current = pin.pinId === activePinId;
    const row = el(`<div class="capture-session-row" role="listitem"></div>`);
    row.setAttribute('data-current', String(current));
    const choose = el(`<button class="capture-session-pin"></button>`) as HTMLButtonElement;
    choose.textContent = pin.label;
    if (current) choose.setAttribute('aria-current', 'true');
    choose.addEventListener('click', () => {
      if (!current) void renderCaptureReceipt(pin.pinId, pin.label);
    });
    const dismiss = el(`<button class="capture-session-dismiss">×</button>`) as HTMLButtonElement;
    const dismissLabel = `Dismiss ${pin.label} from this session. The pin stays on your board.`;
    dismiss.setAttribute('aria-label', dismissLabel);
    dismiss.setAttribute('title', dismissLabel);
    dismiss.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void dismissCaptureShortcut(pin.pinId).then(async (next) => {
        if (current) {
          const replacement = next[0];
          if (replacement) await renderCaptureReceipt(replacement.pinId, replacement.label);
          else await renderHome();
          return;
        }
        const active = next.find((row) => row.pinId === activePinId);
        if (active) await renderCaptureReceipt(active.pinId, active.label);
      });
    });
    row.append(choose, dismiss);
    list.append(row);
  }
  if (saved.length) {
    if (held.length) group('Recent');
    for (const pin of saved) {
      const current = pin.id === activePinId;
      const row = el(`<div class="capture-session-row capture-session-recent" role="listitem"></div>`);
      row.setAttribute('data-current', String(current));
      const choose = el(`<button class="capture-session-pin"></button>`) as HTMLButtonElement;
      choose.textContent = pin.label;
      if (current) choose.setAttribute('aria-current', 'true');
      choose.addEventListener('click', () => {
        if (!current) void renderCaptureReceipt(pin.id, pin.label);
      });
      row.append(choose);
      list.append(row);
    }
  }
  return details;
}

/**
 * The immediate result of a successful picker capture.
 *
 * This is deliberately a receipt plus choices, not a lesson. Capture has one
 * job: prove what entered Virgil. Learning and hand-off are separate learner
 * decisions and every paid/model-backed route begins on its own named press.
 */
async function renderCaptureReceipt(pinId: string, fallbackLabel: string | null): Promise<void> {
  frame('take', { title: 'Pinned', route: 'home' });
  const owner = roomOwnership();
  const host = el(`<section class="capture-result" aria-labelledby="capture-result-heading">
    <div class="capture-session-head"><span class="take-label">Pinned</span><div class="capture-session-slot"></div></div>
    <h1 id="capture-result-heading" tabindex="-1"></h1>
    <div class="capture-receipt"></div>
  </section>`);
  host.setAttribute('data-pin-id', pinId);
  const heading = host.querySelector('h1') as HTMLElement;
  heading.textContent = fallbackLabel || 'Pinned';
  const receipt = host.querySelector('.capture-receipt') as HTMLElement;
  receipt.append(thinking('Opening what you pinned…', true));
  owner.content.append(host);
  heading.focus();

  const [read, held, recentRead] = await Promise.all([
    apiResult<PinDetail>(`/pins/${encodeURIComponent(pinId)}`),
    currentCaptureSessionPins(),
    apiResult<PinsRead>('/pins?limit=8'),
  ]);
  if (!ownsRoom(owner)) return;
  const slot = host.querySelector('.capture-session-slot') as HTMLElement;
  const recent = recentRead.kind === 'ok' ? recentRead.body.pins : [];
  const switcher = captureSessionSwitcher(held, recent, pinId);
  if (switcher) slot.append(switcher);
  receipt.replaceChildren();
  if (read.kind !== 'ok') {
    receipt.append(el(`<p role="alert">Pinned. It is on your board, but I could not reopen the receipt here.</p>`));
    return;
  }

  const pin = read.body;
  const label = pin.label || fallbackLabel || pin.source.pageTitle || 'What you saved';
  heading.textContent = label;
  const source = pinnedSource({ ...pin.source, note: pin.note });
  if (source) receipt.append(source);

  const saved = el(`<p class="capture-saved" role="status">Pinned. It is on your board.</p>`);
  const choose = el(`<section class="capture-next" aria-label="What to do next">
    <div class="take-label">What next</div>
    <button class="primary" data-capture-learn>Learn with Virgil</button>
  </section>`);
  const learn = choose.querySelector('[data-capture-learn]') as HTMLButtonElement;
  learn.setAttribute('title', 'Ask Virgil to write and verify a quick lesson from this pin.');
  learn.addEventListener('click', () => {
    void renderQuickTake(handoffFor(pinId, label, Date.now()));
  });
  receipt.append(saved, choose, captureForwardRoutes(pin, label));
}

/** The same external destinations a lesson offers, carrying the saved source
 * rather than pretending a lesson already exists. Notebook uses the honest
 * visible copy-and-open handoff; stable lesson documents remain lesson-only. */
function captureForwardRoutes(
  pin: { source: { text: string }; topicId: string | null }, label: string,
): HTMLElement {
  const node = el(`<div class="gemini-routes capture-routes rail-block" data-zone="capture-routes">
    <span class="alt-label">Learn elsewhere</span>
    <div class="routes"></div>
    <div class="routes-out" role="status" aria-live="polite"></div>
  </div>`);
  const routes = node.querySelector('.routes') as HTMLElement;
  const out = node.querySelector('.routes-out') as HTMLElement;
  const material = pin.source.text ?? '';

  const press = async (where: ForwardWhere): Promise<void> => {
    out.replaceChildren();
    try {
      let carriesBody: boolean;
      if (where === 'copy') {
        const payload = topicClipboardPrompt(label, null, material);
        await navigator.clipboard.writeText(payload.text);
        carriesBody = payload.carriesBody;
      } else {
        const target = topicForwardTarget(label, null, material);
        if (where === 'beside') await openBeside(target.url); else await openBrowserTab(target.url);
        carriesBody = target.carriesBody;
      }
      await recordExternal({
        kind: 'material', label, destination: FORWARD_DESTINATION[where],
        topicId: pin.topicId, sessionId: null,
      });
      const line = where === 'copy'
        ? tutorForwardedLine(carriesBody, where)
        : carriesBody
          ? `Opened ${where === 'beside' ? 'a window beside this page' : 'a new tab'} with what you pinned.`
          : `Opened ${where === 'beside' ? 'a window beside this page' : 'a new tab'} with its subject. The full pin was too long for one address.`;
      out.append(el(`<div class="meta forwarded">${esc(line)}</div>`));
    } catch {
      const line = where === 'copy'
        ? 'I could not copy it. The pin is still on your board.'
        : `I could not open ${where === 'beside' ? 'the window' : 'the tab'}. The pin is still on your board.`;
      out.append(el(`<div class="meta failed">${esc(line)}</div>`));
    }
  };

  for (const [where, routeLabel] of [
    ['tab', TUTOR_FORWARD_LABEL], ['beside', TUTOR_BESIDE_LABEL],
  ] as const) {
    const button = el(`<button data-tutor="${where}"></button>`) as HTMLButtonElement;
    button.textContent = routeLabel;
    const title = `Opens ${where === 'beside' ? 'a small window beside this page' : 'a new tab'} with what you pinned already written out.`;
    button.setAttribute('title', title);
    button.setAttribute('aria-label', title);
    button.addEventListener('click', () => void press(where));
    routes.append(button);
  }

  const notebook = el(`<button data-handoff="notebook"></button>`) as HTMLButtonElement;
  notebook.textContent = NOTEBOOK_PUSH_LABEL;
  const notebookTitle = 'Copies what you pinned and opens Google Notebook for you to paste it. Virgil cannot see your notebook.';
  notebook.setAttribute('title', notebookTitle);
  notebook.setAttribute('aria-label', notebookTitle);
  notebook.addEventListener('click', async () => {
    out.replaceChildren();
    try {
      await navigator.clipboard.writeText(notebookClipboardText(label, material, null));
    } catch {
      out.append(el(`<div class="meta failed">${esc(notebookCopyFailedLine())}</div>`));
      return;
    }
    const destination = await configuredNotebookDestination();
    let opened = true;
    try { await openBrowserTab(destination); } catch { opened = false; }
    await recordExternal({
      kind: 'material', label, destination: 'notebook', topicId: pin.topicId, sessionId: null,
    });
    out.append(el(`<div class="meta forwarded">${esc(notebookCopiedLine(opened))}</div>`));
  });
  routes.append(notebook);
  return node;
}

/** Resolve the deployment's live notebook only when a learner presses its
 * door. This endpoint is a public setup receipt and makes no model call. */
async function configuredNotebookDestination(): Promise<string> {
  const setup = await apiResult<{ notebookUrl?: unknown }>('/notebook/drive/hosted-setup');
  return notebookTarget(setup.kind === 'ok' ? setup.body.notebookUrl : null);
}
interface Suggestion { id: string; passage: string; url: string; reason: string }

type AvailableMinutes = 1 | 3 | 5;
type ActionMinutes = 1 | 2 | 3 | 4 | 5;
interface ActionOptionView {
  id: string;
  kind: 'clarify-intake' | 'commitment' | 'session' | 'burst' | 'course-material'
    | 'quick-take' | 'capture-material' | 'caught-up';
  targetId: string | null;
  title: string;
  detail: string;
  minutes: ActionMinutes;
  destination: 'intake' | 'plan' | 'session' | 'take' | 'burst' | 'courses' | 'capture' | 'build' | 'board';
  planIntent?: 'links';
  url?: string | null;
  materialId?: string | null;
  materialTotalMinutes?: number | null;
  materialProgressMinutes?: number | null;
  sessionTopicIds?: string[];
  /** how many other topics the ranker has ready behind a quick take's
   *  pick. Absent on every other kind and on an older service, which is why the
   *  swap control is drawn only where this says something. */
  othersReady?: number;
  cta: string;
  reasons: { code: string; text: string }[];
}
interface NextActionView {
  availableMinutes: AvailableMinutes;
  primary: ActionOptionView;
  alternatives: ActionOptionView[];
}

const el = (html: string): HTMLElement => {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
};
/**
 * The panel, thinking.
 *
 * Three dots that move, a line naming the work, and on the slow ones a second
 * line saying it is seconds rather than instants. An element rather than a
 * string because it is replaced when the answer lands, and because a wait with
 * no motion in it reads as a screen that has stopped.
 */
const thinking = (what: string, slow = false): HTMLElement => {
  const node = el(`<div class="thinking">
    <span class="dots"><i></i><i></i><i></i></span>
    <span class="what"></span>
    <span class="slow"></span>
  </div>`);
  (node.querySelector('.what') as HTMLElement).textContent = what;
  if (slow) (node.querySelector('.slow') as HTMLElement).textContent = LOADING_SLOW_NOTE;
  return node;
};

const api = async <T>(path: string, init?: RequestInit): Promise<T | null> => {
  try {
    // Through `serviceFetch` so the shared secret is attached: a private
    // service answers 401 to a request without it, and every zone below reads
    // this `null` as an empty state rather than as a locked door.
    const r = await serviceFetch(path, inRoom(init));
    return r.ok ? (await r.json()) as T : null;
  } catch { return null; }
};

/**
 * The same call, with the difference kept.
 *
 * `api` above collapses a dead service, a 401, a 500 and a timeout into one
 * `null`. For the board zones that is the design: an empty zone is an honest
 * empty zone. For the screens a learner reached by *pressing something* it is
 * not, and it cost an hour on 2026-08-22 to find out why a guide had failed,
 * because the only thing the product could say was that the model could not
 * write one. The model had never been asked, and nothing anywhere recorded
 * which of the four it was.
 *
 * So the screens that report a failure to a waiting person use this one, and
 * say which failure it was. `unreachable` is the service being off or
 * unroutable; `refused` is a service that answered and said no, carrying its
 * status because 401 and 500 are different conversations; `ok` carries the
 * body. A body that will not parse is `refused` with no status: something
 * answered and it was not this product.
 */
export type ApiResult<T> =
  | { readonly kind: 'ok'; readonly body: T }
  | { readonly kind: 'unreachable' }
  | {
    readonly kind: 'refused'; readonly status: number | null;
    /**
     * What the service called this refusal, when it named one.
     *
     * Two refusals in this product are not faults and have a control behind
     * them: a spend limit the learner set (`model-budget`, 402) and a
     * connection with no key saved (`model-credential`, 409). Both carry the
     * same discriminator, so the screens switch on one field instead of
     * pattern-matching a status.
     *
     * Nothing else is lifted out of a refusal body. `api` above collapses every
     * failure into `null` and this one deliberately keeps only the KIND of it:
     * the service's prose belongs on the one screen written to show it, and the
     * budget settings still read it themselves for exactly that reason.
     */
    readonly stoppedBy?: string | null;
    /** Which connection the refusal was about, in the service's own key. */
    readonly connection?: string | null;
    /** Redacted readiness of the two connections this budget never stops. */
    readonly freeConnections?: readonly BudgetFreeConnectionView[];
    /** Which installed half must be updated for a version-skew refusal. */
    readonly update?: 'extension' | 'service' | null;
  };

const apiResult = async <T>(path: string, init?: RequestInit): Promise<ApiResult<T>> => {
  let r: Response;
  try {
    r = await serviceFetch(path, inRoom(init));
  } catch {
    return { kind: 'unreachable' };
  }
  if (!r.ok) {
    // The body is read only for the discriminator, and a body that is missing
    // or unreadable is the refusal it always was rather than an error of its
    // own: nothing here may turn a status somebody could act on into a crash.
    const named = await r.json().catch(() => null) as
      {
        stoppedBy?: unknown; connection?: unknown; freeConnections?: unknown;
        update?: unknown;
      } | null;
    const stoppedBy = typeof named?.stoppedBy === 'string' ? named.stoppedBy : null;
    const connection = typeof named?.connection === 'string' ? named.connection : null;
    const update = named?.update === 'extension' || named?.update === 'service'
      ? named.update : null;
    if (r.status === 426 && stoppedBy === 'version-skew' && update) {
      SERVICE_COMPATIBILITY = {
        status: update === 'service' ? 'update-service' : 'update-extension',
        label: update === 'service' ? 'Update Virgil' : 'Update the extension',
        detail: update === 'service'
          ? 'This Virgil installation is older than the extension. Update and restart Virgil.'
          : 'This extension is older than the Virgil installation. Update the extension.',
        blocking: true,
      };
    }
    const freeConnections = Array.isArray(named?.freeConnections)
      ? named.freeConnections.flatMap((value): BudgetFreeConnectionView[] => {
        if (!value || typeof value !== 'object') return [];
        const row = value as Record<string, unknown>;
        const mode = row.connection;
        const state = row.readiness;
        if ((mode !== 'local' && mode !== 'cli')
          || (state !== 'ready' && state !== 'needs-setup'
            && state !== 'unreachable' && state !== 'not-checked')) return [];
        return [{ connection: mode, enabled: row.enabled === true, readiness: state }];
      }) : undefined;
    return {
      kind: 'refused', status: r.status, stoppedBy, connection,
      ...(freeConnections ? { freeConnections } : {}), update,
    };
  }
  try {
    return { kind: 'ok', body: (await r.json()) as T };
  } catch {
    return { kind: 'refused', status: null };
  }
};

/** One learner-facing failure vocabulary for authored form writes. */
const authoredWriteFailure = (result: ApiResult<unknown>, work: string): string => {
  if (result.kind === 'unreachable') {
    return `I could not save that. Your ${work} is still here; try again.`;
  }
  if (result.kind === 'refused' && (result.status === 400 || result.status === 422)) {
    return `I could not use that input. Check your ${work}; nothing was recorded.`;
  }
  return `I could not save that. Your ${work} is still here; nothing was recorded.`;
};

/**
 * A rejected browser session is a door, not a failed form submission.
 *
 * Importantly this does not call `forgetLocalDrafts()`: an expired token has
 * not changed who owns the words on screen. `renderHome()` adopts the signed-in
 * uid after Google returns and clears the memory if that uid is different, so
 * same-account re-authentication restores the draft while an account switch
 * cannot expose it. Nothing is retried automatically; the learner must press
 * the submit control again after they have seen their work restored.
 */
let resumeAfterExpiredIdentity: (() => void | Promise<void>) | null = null;
const reopenSignInForExpiredIdentity = async (
  result: ApiResult<unknown>, resume: () => void | Promise<void>,
): Promise<boolean> => {
  if (result.kind !== 'refused' || (result.status !== 401 && result.status !== 403)) return false;
  resumeAfterExpiredIdentity = resume;
  await signOut();
  await renderSignIn();
  return true;
};

/**
 * Tell the worker its cached prefs are out of date (, ).
 *
 * The service is the authority and the worker's `sb_prefs` is a cache of it, so
 * anything here that changes prefs has to say so or the change waits for the
 * refresh alarm. Pressing Pause and having the next page observed anyway is
 * exactly the kind of thing that makes a control worthless.
 */
const prefsChanged = (): void => {
  // Nothing here waits on it or reads the reply: the write has already landed on
  // the authority, and this is only the cache catching up. A sleeping worker
  // rejects rather than throwing, and the alarm covers that case anyway.
  try { void chrome.runtime?.sendMessage({ kind: PREFS_CHANGED })?.catch(() => {}); } catch { /* not in the extension */ }
};

/**
 * The main page keeps the primary action first, places momentum and flagged
 * material as peers, and omits empty secondary zones.
 */
/**
 * Which function each door calls.
 *
 * Split from `DOORS` because the *set* of doors is a product fact and the
 * function behind one is wiring. `Record<…>` over the room keys rather than a
 * loose object: a door added to the table in `panel-core.ts` with nothing to
 * open is a type error here rather than a dead control in the top bar.
 */
const DOOR_TARGETS: Record<DoorKey, () => Promise<void>> = {
  today: () => renderHome(),
  plan: () => renderPlan(),
  courses: () => renderCourses(),
  check: () => renderCheck(),
  model: () => renderModel(),
  privacy: () => renderSettings(),
};

/** A client-side room change removes the control that owned keyboard focus.
 *  Land on the room's own heading (or its main region when it has no heading)
 *  so the learner hears where the door went instead of falling back to body. */
function focusRoomStart(): void {
  const heading = roomContent.querySelector('h1') as HTMLElement | null;
  const target = heading ?? roomContent;
  if (target.getAttribute('tabindex') === null) target.setAttribute('tabindex', '-1');
  target.focus();
}

function focusAfterRoom(work: Promise<void>, room: RoomKey): void {
  void work.then(() => {
    if (app.dataset.room === room) focusRoomStart();
  });
}

interface FrameOptions {
  /** Passed through to the masthead. See `MastheadOptions.account`. */
  readonly account?: boolean;
  /** Passed through to the masthead. Signed-out Virgil has no live room doors. */
  readonly navigation?: boolean;
  /**
   * The room's title, drawn as the `<h1>` under the bar.
   *
   * Omitted where the screen names itself with something better than a generic
   * noun — a session is headed with the thing being taught, a quick take with
   * the passage's label — which is a decision those screens already made and
   * this shell does not take back off them.
   */
  readonly title?: string;
  /**
   * One control, on the title row.
   *
   * For the room whose whole reshape was to stop opening with a stack of forms:
   * the way IN has to be visible without being the first thing on the screen,
   * and beside the title is the only place that is both. Built by the caller
   * before `frame()` runs, because `frame()` clears the surface.
   */
  readonly action?: HTMLElement | null;
  /** The refreshable address this screen owns. Null keeps the address of the
   * room that sent the learner here, for transient screens such as a take. */
  readonly route?: MainPageRoute | null;
  /** False on identity-only walls, where no model output is present to check. */
  readonly modelNotice?: boolean;
}

/**
 * Draw a consistent page shell. The side panel keeps only its compact tools;
 * full-page rooms receive navigation, theme, account, measure, and room hooks.
 */
/** Preserve unsent Check inputs in memory while the learner visits Settings. */
interface CheckMemory {
  draft: string; rubric: string; context: string;
  attached: {
    name: string; pages: readonly string[]; file: UploadFile; kind: PageInputFormat;
  } | null;
  fileBlocks?: Partial<Record<'draft' | 'rubric', { name: string; line: string }>>;
}
let CHECK_MEMORY: CheckMemory | null = null;

/** Everything a lesson holds unsent lives in `lesson.ts` with the controls that
 *  write it; `clearAccountScopedState` still empties it with the account. */
const LEARNER_ANSWER_MAX_CHARS = 1_500;
const PANEL_ASK_MAX_CHARS = 1_200;
const OUTCOME_TITLE_MAX_CHARS = 180;
const OUTCOME_FEEDBACK_MAX_CHARS = 6_000;
const STUDY_TEXT_LIMITS = {
  title: 160, provider: 120, objective: 300, materialTitle: 180,
  commitmentTitle: 180, sourceTitle: 160, sourceText: 60_000,
} as const;
const unicodeChars = (value: string): number => Array.from(value).length;
const refuseAuthoredOverflow = (
  value: string, maxChars: number, label: string, status: HTMLElement,
  field: HTMLInputElement | HTMLTextAreaElement,
  trimOutside = true,
): boolean => {
  const chars = unicodeChars(trimOutside ? value.trim() : value);
  if (chars <= maxChars) return false;
  status.textContent = `That ${label} is ${chars.toLocaleString('en-US')} characters. `
    + `Keep it to ${maxChars.toLocaleString('en-US')} so I can save all of it. Nothing was sent.`;
  field.focus();
  return true;
};
interface PinEditDraft {
  type: 'interest' | 'struggle'; note: string;
  requestedRegister: 'from-nothing' | 'building' | 'fluent' | null;
  requestedMinutes: number | null;
}
const PIN_EDIT_DRAFTS = new Map<string, PinEditDraft>();
/**
 * Drawer choices in the Insights room, for this visit only.
 *
 * Unanswered sections open by default; confirmed reads are settled history and
 * begin compact. An explicit press overrides either default until the account
 * scope changes. This is reading state, not a learner preference or unsent
 * work, so it never enters storage or a leave-warning.
 */
const INSIGHT_SECTION_CHOICES = new Map<InsightSectionKey, boolean>();
interface IntakeMemory { kind: string; title: string; text: string }
let INTAKE_MEMORY: IntakeMemory | null = null;
type CourseDropKind = 'syllabus' | 'rubric' | 'assignment-brief' | 'learner-note';
interface CourseDropItemDraft {
  readonly clientRef: string;
  readonly name: string;
  readonly kind: CourseDropKind;
  readonly mimeType: string;
  readonly text: string | null;
}
interface CourseDropDraft {
  readonly title: string;
  readonly dropId: string;
  readonly items: readonly CourseDropItemDraft[];
}
interface CourseDropSelection {
  readonly title: string;
  readonly dropId: string;
  readonly files: readonly UploadFile[];
  /** Highest sequential item acknowledged by a successful request. This is
   *  bounded progress metadata, never extracted learner content. */
  checkedThrough: number;
  /** Whether the next request failed or required sign-in after selection. */
  interrupted: boolean;
}
/**
 * A chosen folder is learner-authored work until `/course-drops` answers.
 * Keep only its browser File handles across navigation and same-account
 * re-authentication. Each retry rereads those same immutable handles under the
 * same ids; extracted text is released after its bounded part is sent. Never
 * persist the files or carry them to another account.
 */
let COURSE_DROP_MEMORY: CourseDropSelection | null = null;
/** One post-write sentence survives the redraw that reveals the new proposals. */
let COURSE_DROP_NOTICE: string | null = null;
/** A successful result write redraws My studies so the new evidence appears in
 * its owning course. Keep the causal replanning receipt across that one redraw
 * and attach it to the exact result row rather than leaving it in a closed Add
 * sheet. */
let COURSE_RESULT_NOTICE: {
  readonly outcomeId: string;
  readonly line: string;
  readonly changed: boolean;
} | null = null;
interface CourseDropIssue { readonly name: string; readonly detail: string }
/** Per-file repair survives redraws until the learner dismisses it or chooses
 *  another folder. A count without these names is not a usable receipt. */
let COURSE_DROP_ISSUES: readonly CourseDropIssue[] = [];
/** Added sources whose tail did not fit the published document boundary. */
let COURSE_DROP_SHORTENED: readonly CourseDropIssue[] = [];
/**
 * Corrections typed into a reviewed intake are still drafts until their exact
 * Save control answers. Keep them in the same account-scoped, in-memory layer
 * as the original pasted source so a successful neighbouring correction — or
 * an expired browser session — cannot erase work the learner has not sent.
 */
const INTAKE_REVIEW_DRAFTS = new Map<string, Map<string, string>>();
const intakeReviewValue = (draftId: string, key: string, fallback: string): string => {
  const memory = INTAKE_REVIEW_DRAFTS.get(draftId);
  return memory?.has(key) ? memory.get(key)! : fallback;
};
const rememberIntakeReviewValue = (draftId: string, key: string, value: string): void => {
  let memory = INTAKE_REVIEW_DRAFTS.get(draftId);
  if (!memory) { memory = new Map(); INTAKE_REVIEW_DRAFTS.set(draftId, memory); }
  memory.set(key, value);
};
/** Hand-entered Add forms are drafts too. Route changes and re-authentication
 * may rebuild their DOM, but neither is permission to erase what was typed. */
const ADD_FORM_DRAFTS = new Map<string, Map<string, string>>();
let STUDIES_ADD_ROUTE: AddRouteKey = 'syllabus';
let PLAN_ADD_ROUTE = 'dated';
/** Never stored: only the same in-memory lifetime as the password field. */
let CLOUD_KEY_DRAFT: string | null = null;
let MODEL_ROUTING_MEMORY: ModelRoutingDraft | null = null;
/** Re-open the destructive key-custody decision after same-account sign-in.
 * This is a destination only: DELETE is never replayed. */
let CLOUD_KEY_REMOVE_CONFIRM = false;
/** One post-write sentence survives the redraw that removes the old control. */
let CLOUD_KEY_REMOVE_NOTICE: string | null = null;
/** Preference fields are drafts until `/prefs` confirms them. Keep only the
 * two controls that contain learner-authored choices; pause is a one-tap
 * action and is reconstructed from service truth after sign-in. `undefined`
 * distinguishes "no threshold draft" from the deliberate manual-only null. */
let AUTO_AFTER_DRAFT: number | null | undefined;
let EXCLUDED_DOMAINS_DRAFT: string | null = null;
interface AccountBackupDraft {
  readonly name: string;
  readonly backup: unknown;
  line: string;
  canRestore: boolean;
  canRetry: boolean;
}
/** A browser will not repopulate a file input after sign-in. Keep the parsed
 * learner copy in the same account-scoped memory as other unsent drafts so the
 * exact Check/Restore action can return without persisting the file. */
let ACCOUNT_BACKUP_DRAFT: AccountBackupDraft | null = null;
/** A number typed here is not the budget until the service says it is. Keep
 * that unsent value through same-account sign-in, and nowhere durable. */
let BUDGET_LIMIT_DRAFT: string | null = null;
/** Re-open the destructive Drive confirmation after an expired session. The
 * learner still has to press the final action again; this is a destination,
 * never permission to replay it. */
let DRIVE_DISCONNECT_CONFIRM = false;

/**
 * A form whose values have not crossed the service boundary yet.
 *
 * Most long-lived Virgil drafts already survive room changes in the account-
 * scoped maps above. This registry is for the remaining mounted forms whose
 * DOM is their only copy. It gives all of them one navigation law without
 * teaching the masthead what an Insight, result or recall answer looks like.
 */
interface UnsentWork {
  readonly root: HTMLElement;
  readonly label: string;
  readonly dirty: () => boolean;
  readonly discard: () => void;
  readonly focus: () => void;
}
const UNSENT_WORK = new Set<UnsentWork>();
const isMounted = (node: HTMLElement): boolean => {
  let at: HTMLElement | null = node;
  while (at) {
    if (at === app) return true;
    at = at.parentElement;
  }
  return false;
};
const fieldValue = (field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string =>
  field.tagName === 'INPUT'
    && (field.getAttribute('type') === 'checkbox' || field.getAttribute('type') === 'radio')
    ? String((field as HTMLInputElement).checked) : field.value;
const protectUnsentForm = (
  root: HTMLElement,
  label: string,
  fields: readonly (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[],
  discard: () => void,
  focus: () => void,
): (() => void) => {
  const baseline = fields.map(fieldValue);
  const entry: UnsentWork = {
    root, label,
    dirty: () => fields.some((field, index) => fieldValue(field) !== baseline[index]),
    discard, focus,
  };
  UNSENT_WORK.add(entry);
  return () => { UNSENT_WORK.delete(entry); };
};
const mountedUnsentWork = (): UnsentWork[] => {
  const live: UnsentWork[] = [];
  for (const entry of UNSENT_WORK) {
    if (!isMounted(entry.root)) { UNSENT_WORK.delete(entry); continue; }
    if (entry.dirty()) live.push(entry);
  }
  return live;
};
const mapHasWords = (map: ReadonlyMap<string, string>): boolean =>
  [...map.values()].some((value) => value.trim().length > 0);
const hasPreservedDrafts = (): boolean => !!(
  (CHECK_MEMORY && (CHECK_MEMORY.draft.trim() || CHECK_MEMORY.rubric.trim()
    || CHECK_MEMORY.context.trim() || CHECK_MEMORY.attached || CHECK_MEMORY.fileBlocks))
  || hasLessonDrafts()
  || PIN_EDIT_DRAFTS.size
  || (INTAKE_MEMORY && (INTAKE_MEMORY.title.trim() || INTAKE_MEMORY.text.trim()))
  || COURSE_DROP_MEMORY
  || [...INTAKE_REVIEW_DRAFTS.values()].some(mapHasWords)
  || [...ADD_FORM_DRAFTS.values()].some(mapHasWords)
  || CLOUD_KEY_DRAFT?.trim()
  || MODEL_ROUTING_MEMORY
  || AUTO_AFTER_DRAFT !== undefined
  || EXCLUDED_DOMAINS_DRAFT !== null
  || ACCOUNT_BACKUP_DRAFT
  || BUDGET_LIMIT_DRAFT?.trim()
);
let abandonPrompt: HTMLElement | null = null;
const guardNavigation = (
  action: () => void | Promise<void>,
  opts: { readonly includePreserved?: boolean } = {},
): void => {
  const pending = mountedUnsentWork();
  if (!pending.length && !(opts.includePreserved && hasPreservedDrafts())) {
    void action();
    return;
  }
  abandonPrompt?.remove();
  const warning = el(`<aside class="unsent-warning" role="alertdialog" aria-modal="false" aria-labelledby="unsent-warning-title" aria-describedby="unsent-warning-note">
    <strong id="unsent-warning-title"></strong>
    <p id="unsent-warning-note">Keep editing, or leave and discard this unsent work.</p>
    <div class="row"><button class="primary" data-stay>Keep editing</button><button class="link danger-link" data-leave>Leave without saving</button></div>
  </aside>`);
  const labels = [...new Set(pending.map((entry) => entry.label))];
  (warning.querySelector('strong') as HTMLElement).textContent = labels.length === 1
    ? `Your ${labels[0]} has not been sent.`
    : 'You have unsent work on this page.';
  const stay = warning.querySelector('[data-stay]') as HTMLButtonElement;
  const leave = warning.querySelector('[data-leave]') as HTMLButtonElement;
  stay.addEventListener('click', () => {
    warning.remove(); abandonPrompt = null;
    pending[0]?.focus();
  });
  leave.addEventListener('click', () => {
    for (const entry of pending) { UNSENT_WORK.delete(entry); entry.discard(); }
    warning.remove(); abandonPrompt = null;
    void action();
  });
  abandonPrompt = warning;
  roomContent.append(warning);
  stay.focus();
};
const addDraftValue = (formKey: string, field: string, fallback = ''): string => {
  const draft = ADD_FORM_DRAFTS.get(formKey);
  return draft?.has(field) ? draft.get(field)! : fallback;
};
const rememberAddDraft = (formKey: string, fields: Readonly<Record<string, string>>): void => {
  let draft = ADD_FORM_DRAFTS.get(formKey);
  if (!draft) { draft = new Map(); ADD_FORM_DRAFTS.set(formKey, draft); }
  for (const [field, value] of Object.entries(fields)) draft.set(field, value);
};
const clearAccountScopedState = (): void => {
  resetCourseSearchIndex();
  CHECK_MEMORY = null;
  clearLessonMemory();
  PIN_EDIT_DRAFTS.clear();
  INSIGHT_SECTION_CHOICES.clear();
  INTAKE_MEMORY = null;
  COURSE_DROP_MEMORY = null;
  COURSE_DROP_NOTICE = null;
  COURSE_DROP_ISSUES = [];
  COURSE_DROP_SHORTENED = [];
  INTAKE_REVIEW_DRAFTS.clear();
  ADD_FORM_DRAFTS.clear();
  STUDIES_ADD_ROUTE = 'syllabus';
  PLAN_ADD_ROUTE = 'dated';
  CLOUD_KEY_DRAFT = null;
  MODEL_ROUTING_MEMORY = null;
  CLOUD_KEY_REMOVE_CONFIRM = false;
  CLOUD_KEY_REMOVE_NOTICE = null;
  AUTO_AFTER_DRAFT = undefined;
  EXCLUDED_DOMAINS_DRAFT = null;
  ACCOUNT_BACKUP_DRAFT = null;
  BUDGET_LIMIT_DRAFT = null;
  DRIVE_DISCONNECT_CONFIRM = false;
  clearPendingLessonResults();
};
const ACCOUNT_SCOPE = new AccountScope(clearAccountScopedState);
const forgetLocalDrafts = (): void => ACCOUNT_SCOPE.forget();
const adoptLocalDraftOwner = (owner: string): void => ACCOUNT_SCOPE.adopt(owner);

/**
 * How the memory is taken: a closure the Check room hands the shell, called
 * once, on the way out.
 *
 * On the way out rather than on every keystroke, because an `input` listener
 * would be a second place that decides what the boxes hold, and the two would
 * disagree the first time anything else wrote into one — a file read in, a
 * scanned rubric transcribed, pages swapped for text. Reading the boxes at the
 * moment the surface is cleared cannot disagree with them.
 */
let rememberCheck: (() => void) | null = null;

const PAGE_ROUTE_BY_ROOM: Partial<Record<RoomKey, MainPageRoute>> = {
  today: 'home', plan: 'plan', courses: 'courses', check: 'check', model: 'insights',
  privacy: 'settings', account: 'account', signin: 'account',
};
let acceptedPageHash = SURFACE === 'page' && typeof location !== 'undefined'
  ? location.hash
  : '';

/** Give every durable page room an address. Repainting the same room does not
 * add history; crossing into another one does, so Refresh and Back both keep
 * their ordinary browser meanings. */
function rememberPageRoute(room: RoomKey, override?: MainPageRoute | null): void {
  if (SURFACE !== 'page' || typeof location === 'undefined') return;
  const route = override === undefined ? PAGE_ROUTE_BY_ROOM[room] : override;
  if (!route) return;
  const next = mainPageHash(route);
  if (location.hash !== next) {
    try { history.pushState(null, '', next); } catch { /* a test/non-page runtime */ }
  }
  acceptedPageHash = next;
}

function frame(room: RoomKey, opts: FrameOptions = {}): HTMLElement {
  beginRoom();
  // Before the surface is cleared, and exactly once: the handler holds the
  // boxes it was built with, so a second call would re-read a tree nobody is
  // looking at any more.
  if (rememberCheck) { const take = rememberCheck; rememberCheck = null; take(); }
  app.className = '';
  /**
   * The Learn room's live nodes go with the page they were part of.
   *
   * `frame` is the only thing that rebuilds `#app`, so clearing here is what
   * guarantees the swap never writes into an element nobody is looking at.
   */
  learnMount = null;
  app.replaceChildren();
  app.dataset.room = room;
  app.dataset.measure = roomMeasure(room);
  rememberPageRoute(room, opts.route);

  // The full page has a long, stable masthead. At narrow width that is ten
  // useful controls before the learner reaches the room they opened. Keep the
  // visual hierarchy, but give keyboard users the conventional first-tab door
  // past it. The panel has only two tools and does not need a skip link.
  let skipLink: HTMLElement | null = null;
  if (SURFACE === 'page') {
    skipLink = el(`<a class="skip-link" href="#virgil-main">Skip to content</a>`);
    app.append(skipLink);
  }

  const head = SURFACE === 'page'
    ? masthead({
      ...(opts.account === false ? { account: false } : {}),
      ...(opts.navigation === false ? { navigation: false } : {}),
      current: room,
    })
    : panelTools();
  app.append(head);
  if (SERVICE_COMPATIBILITY
    && SERVICE_COMPATIBILITY.status !== 'compatible'
    && SERVICE_COMPATIBILITY.status !== 'unreachable') {
    const warning = el(`<aside class="compatibility-warning" role="status"></aside>`);
    const strong = el(`<strong></strong>`);
    strong.textContent = SERVICE_COMPATIBILITY.label;
    const detail = el(`<span></span>`);
    detail.textContent = SERVICE_COMPATIBILITY.detail;
    warning.append(strong, detail);
    app.append(warning);
  }
  roomContent = app;
  /**
   * Every page room gets the shared canvas now. The board was the one exception
   * — it drew its own `.board` straight into `#app` — and it stopped being a
   * room on 2026-08-25, when it became a face of Learn. The face is hosted
   * inside this canvas, which the stylesheet strips back so there is not a
   * chalkboard inside a chalkboard.
   */
  if (SURFACE === 'page') {
    roomContent = el(`<main id="virgil-main" class="room-board" tabindex="-1"></main>`);
    app.append(roomContent);
    // Focus the landmark without replacing the room's refreshable address with
    // an element fragment. The href remains as the no-script fallback.
    skipLink?.addEventListener('click', (event) => {
      event.preventDefault();
      roomContent.focus();
    });
  }
  /** The shared shell appends the model-accuracy notice to every page room. */
  if (opts.modelNotice !== false) {
    const notice = el(`<p class="page-notice"></p>`);
    notice.textContent = MODEL_NOTICE;
    app.append(notice);
  }

  if (opts.title) {
    const h1 = el(`<h1></h1>`);
    h1.textContent = opts.title;
    if (opts.action) {
      const row = el(`<div class="room-head"></div>`);
      row.append(h1, opts.action);
      roomContent.append(row);
    } else {
      roomContent.append(h1);
    }
  }
  return head;
}

interface MastheadOptions {
  /**
   * Whether to draw the account control. False on the sign-in screen itself,
   * which otherwise carries TWO controls labelled "Sign in" — the masthead's
   * door and the form's own button — a foot from each other. A door to the
   * room you are standing in.
   */
  readonly account?: boolean;
  /** The signed-out wall has nowhere behind these doors to go yet. */
  readonly navigation?: boolean;
  /**
   * Which room the learner is standing in, so the nav can say so.
   *
   * A row of seven identical words with no mark on any of them is a list of
   * places, not a position. It was survivable while only two screens drew this
   * bar; the moment every screen draws it, an unmarked nav means the bar looks
   * the same in all twelve rooms and stops being a way of knowing where you
   * are. A room with no door of its own — the burst, a session — passes
   * nothing, and nothing is marked. That is the honest answer.
   */
  readonly current?: RoomKey;
}

function masthead(opts: MastheadOptions = {}): HTMLElement {
  // Board search mounts in the shared masthead; CSS hides this slot elsewhere.
  const node = el(`<header class="masthead" data-guide-target="top">
    <button class="wordmark"></button>
    <div class="find"></div>
    <nav class="utility"></nav>
  </header>`);
  // The wordmark is the way home, which is what a masthead means everywhere
  // else and is what replaced the seven "← back" controls. Going home is a
  // re-read rather than a cached screen: a session built while the learner was
  // on the board is the whole premise of Virgil.
  const home = node.querySelector('.wordmark') as HTMLElement;
  home.textContent = 'Virgil';
  home.addEventListener('click', () => guardNavigation(async () => {
    await renderHome();
    {
      if (app.dataset.room === 'today') focusRoomStart();
    }
  }));
  const utility = node.querySelector('.utility') as HTMLElement;

  // The arrival page first, then the board: the nav opens with the room the
  // product opens on, and the rooms the learner works in come before the tools
  // they use and leave.

  // Navigation labels name destinations; room headings retain longer copy.
  if (opts.navigation !== false) {
    for (const door of DOORS) {
      const b = el(`<button class="link ${door.kind}"></button>`);
      b.textContent = door.label;
      b.addEventListener('click', () => guardNavigation(() => {
        // Navigation starts immediately; a slow room must never block a second
        // door. Focus only when this render finishes and still owns the room,
        // so a late response cannot steal focus back from where the learner
        // went next.
        void DOOR_TARGETS[door.key]().then(() => {
          if (app.dataset.room === door.key) focusRoomStart();
        });
      }));
      // `aria-current` rather than a class, because "this is the page you are
      // on" is a thing the accessibility tree already has a word for, and the
      // stylesheet can hang the mark off the same attribute a screen reader
      // reads. A door to the room you are standing in stays pressable — it is a
      // re-read, which is the one thing the wordmark could already do and no
      // other door could.
      if (opts.current === door.key) b.setAttribute('aria-current', 'page');
      utility.append(b);
    }
  }

  /** Theme selection lives in Settings while its choice still applies globally. */
  // Last, because it is the only thing in the masthead that is about a person
  // rather than about the product.
  if (opts.account !== false) {
    const account = el(`<span class="account"></span>`);
    utility.append(account);
    void paintAccount(account);
  }
  return node;
}

/** Paint the account switcher only for account-backed installations. */
async function paintAccount(host: HTMLElement): Promise<void> {
  const config = await readAuthConfig();
  if (!config) {
    host.replaceChildren();
    return;
  }

  const session = await readSession();
  host.replaceChildren();

  if (!session) {
    const go = el(`<button class="link dest"></button>`);
    go.textContent = 'Sign in';
    go.addEventListener('click', () => focusAfterRoom(renderSignIn(), 'signin'));
    host.append(go);
    return;
  }

  // Their address if they have one, never a bare 28-character uid. A control
  // rather than a label, because it is the way to the account screen — where
  // proving the address and leaving both live.
  const who = el(`<button class="link who"></button>`);
  const name = el(`<span class="account-name"></span>`);
  name.textContent = learnerLabel(session) ?? '';
  who.append(name);
  who.addEventListener('click', () => guardNavigation(
    () => focusAfterRoom(renderAccount(), 'account'), { includePreserved: true },
  ));
  host.append(who);
}

/** The popup's Account door adapts to the copy of Virgil in this browser. A
 *  one-board install has no account to open, so the door goes where its data
 *  controls went: the Settings section that holds them. */
async function renderAccountEntry(): Promise<void> {
  const config = await readAuthConfig();
  if (!config) return renderSettings('data');
  const session = await readSession();
  return session ? renderAccount() : renderSignIn();
}

/**
 * The sign-in screen.
 *
 * There is no Virgil username or password. Google establishes who the learner
 * is; the Firebase project belonging to this self-hosted deployment turns that
 * into the token its own service verifies. Drive remains a later, separate
 * permission requested only when the learner connects it.
 */
async function renderSignIn(
  mode: 'sign-in' | 'switch-user' = 'sign-in', notice: string | null = null,
): Promise<void> {
  const switching = mode === 'switch-user';
  const current = switching ? await readSession() : null;
  frame('signin', {
    account: false, navigation: false, modelNotice: false,
    route: switching ? 'switch-user' : 'account',
  });

  const config = await readAuthConfig();
  if (!config) {
    roomContent.append(el(`<section class="signin signin-shell signin-unavailable">
      <div class="setting-kicker">Virgil account</div>
      <h1>Sign in</h1>
      <p>Sign-in is not available in this build of Virgil. There is nothing for you to configure here.</p>
    </section>`));
    return;
  }

  const form = el(`<section class="signin signin-shell">
    <div class="signin-intro">
      <div class="setting-kicker">${switching ? 'Virgil account' : 'Virgil · AI learning manager'}</div>
      <h1>${switching ? 'Switch account' : 'Sign in'}</h1>
      ${switching ? '' : '<p class="signin-promise">Stop collecting things to learn. Start knowing what to do next.</p>'}
      <p class="signin-lead">${switching
    ? 'Move to another Virgil board without abandoning this one first.'
    : 'Capture what you are already reading or working on. Virgil turns it into a short lesson, learns from what is still fuzzy, and keeps one useful next move ready.'}</p>
      ${switching ? '' : `<ol class="signin-loop" aria-label="How Virgil works">
        <li><strong>Capture</strong><span>Pin a source or add your own material.</span></li>
        <li><strong>Learn</strong><span>Use Virgil, Gemini or Google Notebook.</span></li>
        <li><strong>Grow</strong><span>Your signals update the board and shape what comes next.</span></li>
      </ol>`}
      <p class="meta">${switching
    ? 'Your lessons, plan and progress stay with the account you choose.'
    : 'Your account keeps the same board, plan and progress across this Virgil installation.'}</p>
    </div>
    <div class="signin-card">
      <div class="setting-kicker">Google account</div>
      <h2>${switching ? 'Choose another account' : 'Open your learning board'}</h2>
      ${switching && current ? `<p class="current-account">Signed in now as <strong>${esc(learnerLabel(current) ?? 'this account')}</strong>.</p>` : ''}
      <div class="row"><button class="primary google-signin" data-google>${switching
    ? 'Continue with another Google account'
    : 'Continue with Google'}</button>${switching && current
    ? '<button data-stay>Keep this account</button>'
    : ''}</div>
      <p class="signin-trust">Google handles sign-in. Virgil never receives or stores your password.</p>
      <p class="signin-separate">Your Google Notebook connection is separate. Signing in here does not change its account.</p>
      <p class="refusal" role="alert"></p>
    </div>
  </section>`);
  const refusal = form.querySelector('.refusal') as HTMLElement;
  if (notice) refusal.textContent = notice;
  const google = form.querySelector('[data-google]') as HTMLButtonElement;

  google.addEventListener('click', async () => {
    refusal.textContent = '';
    google.disabled = true;
    const result = await signInWithGoogle();
    google.disabled = false;
    if (result.refusal !== null) { refusal.textContent = result.refusal; return; }
    const session = await readSession();
    if (session) adoptLocalDraftOwner(session.uid);
    const resume = resumeAfterExpiredIdentity;
    resumeAfterExpiredIdentity = null;
    if (resume) await resume();
    else { await renderHome(); focusRoomStart(); }
  });
  form.querySelector('[data-stay]')?.addEventListener('click', () => focusAfterRoom(renderHome(), 'today'));
  roomContent.append(form);
}

/** Account switching and sign-out live here; data controls live in Settings. */
async function renderAccount(): Promise<void> {
  frame('account', { account: false });
  const owner = roomOwnership();

  const session = await readSession();
  if (!ownsRoom(owner)) return;
  if (!session) {
    owner.content.append(el(`<p class="empty">Nobody is signed in.</p>`));
    return;
  }

  const hero = el(`<section class="account-hero">
    <div>
      <div class="setting-kicker">Virgil account</div>
      <h1>Your account</h1>
      <p class="account-email"></p>
      <p class="state">Signed in with Google. Virgil never receives or stores your password.</p>
    </div>
    <span class="connection-badge good">Signed in</span>
  </section>`);
  (hero.querySelector('.account-email') as HTMLElement).textContent = learnerLabel(session) ?? 'This account';
  owner.content.append(hero);

  const access = el(`<section class="account-block account-access">
    <h2>Account access</h2>
    <div class="account-choice">
      <div><strong>Use another Google account</strong><p>This board stays signed in until another account succeeds.</p></div>
      <button data-switch>Switch account</button>
    </div>
    <div class="account-choice">
      <div><strong>Leave this browser</strong><p>Your board and Google Notebook connection stay unchanged.</p></div>
      <button class="link" data-signout>Sign out</button>
    </div>
  </section>`);
  access.querySelector('[data-switch]')!.addEventListener('click', () => guardNavigation(
    () => focusAfterRoom(renderSignIn('switch-user'), 'signin'), { includePreserved: true },
  ));
  access.querySelector('[data-signout]')!.addEventListener('click', () => guardNavigation(async () => {
      forgetLocalDrafts();
      await signOut();
      await renderSignIn();
      focusRoomStart();
    }, { includePreserved: true }));
  owner.content.append(access);

  // Where the rest of what happens to this board now lives, said once and
  // pressable. A room that quietly stopped holding account deletion, with no
  // line saying where it went, would be a room that had lost a capability.
  const pointer = el(`<section class="account-block account-data-pointer">
    <div><strong>Your data</strong><p>Backup, restore and permanent deletion live in Settings.</p></div>
    <button class="link" data-data-settings>Open Your data</button>
  </section>`);
  pointer.querySelector('[data-data-settings]')!.addEventListener('click', () => guardNavigation(
    () => void renderSettings('data', true), { includePreserved: true },
  ));
  owner.content.append(pointer);
}

/** Draw backup, restore, and deletion for the active identity mode. */
async function dataSettings(
  board: HTMLElement,
  resumeAction: DataResumeAction = null,
): Promise<void> {
  const config = await readAuthConfig();
  const localBoard = !config;
  const session = localBoard ? null : await readSession();
  board.replaceChildren();
  if (localBoard) {
    board.append(el(`<p class="meta">This is the one board on this Virgil installation. It does not need a sign-in.</p>`));
  }

  // --- learner-owned copy and recovery -----------------------------------
  const transfer = el(`<div class="account-block account-data">
    <h2>Backup and restore</h2>
    <p class="state">Download a portable copy of this board and its preferences, or restore one onto an empty board. It includes model routes, your Local endpoint, budget and Privacy choices. Saved model keys and Google sign-in stay out of it.</p>
    <div class="row">
      <button class="link" data-download-backup>Download a copy</button>
      <button class="link" data-choose-backup>Choose a backup to restore</button>
      <input data-backup-file type="file" accept="application/json,.json" aria-label="Virgil backup file" hidden>
    </div>
    <div class="backup-result" aria-live="polite"></div>
  </div>`);
  const transferResult = transfer.querySelector('.backup-result') as HTMLElement;
  const download = transfer.querySelector('[data-download-backup]') as HTMLButtonElement;
  const choose = transfer.querySelector('[data-choose-backup]') as HTMLButtonElement;
  const picker = transfer.querySelector('[data-backup-file]') as HTMLInputElement;
  let backupHref: string | null = null;
  const transferBusy = (busy: boolean): void => {
    if (busy) transfer.setAttribute('aria-busy', 'true');
    else transfer.removeAttribute('aria-busy');
    download.disabled = busy;
    choose.disabled = busy;
    picker.disabled = busy;
  };
  const transferLine = (line: string): HTMLElement => {
    const note = el(`<p class="note" role="status"></p>`);
    note.textContent = line;
    return note;
  };
  download.addEventListener('click', async () => {
    transferBusy(true);
    transferResult.replaceChildren(transferLine('Preparing your copy…'));
    const out = await apiResult<{
      backup: unknown; filename: string; counts: {
        pins?: number; courses?: number; outcomes?: number;
        currentOutcomes?: number; outcomeHistory?: number;
      };
      secretsIncluded: boolean;
    }>('/account/backup');
    if (await reopenSignInForExpiredIdentity(out, async () => {
      await renderSettings('data', false, 'download');
      (roomContent.querySelector('[data-download-backup]') as HTMLElement | null)?.focus();
    })) return;
    transferBusy(false);
    if (out.kind !== 'ok') {
      transferResult.replaceChildren(transferLine('I could not prepare your copy. Nothing changed.'));
      download.focus();
      return;
    }
    if (backupHref) URL.revokeObjectURL(backupHref);
    backupHref = URL.createObjectURL(new Blob([JSON.stringify(out.body.backup, null, 2)], {
      type: 'application/json',
    }));
    const link = el(`<a class="backup-download" download>Save the backup</a>`) as HTMLAnchorElement;
    link.href = backupHref;
    link.setAttribute('href', backupHref);
    link.download = out.body.filename || 'virgil-backup.json';
    // The DOM test harness does not reflect this property back to the content
    // attribute; setting both also makes the downloaded filename explicit in
    // the markup a browser exposes to accessibility and inspection tools.
    link.setAttribute('download', link.download);
    const counts = out.body.counts ?? {};
    const receipt = el(`<p class="note"></p>`);
    const counted = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
    const hasOutcomeBreakdown = typeof counts.currentOutcomes === 'number'
      && typeof counts.outcomeHistory === 'number';
    let resultCount = hasOutcomeBreakdown
      ? counted(counts.currentOutcomes!, 'current result')
      : counted(counts.outcomes ?? 0, 'result record');
    if (hasOutcomeBreakdown && counts.outcomeHistory! > 0) {
      resultCount += `, plus ${counted(counts.outcomeHistory!, 'earlier result record')} kept for history`;
    }
    receipt.textContent = `Copy ready: ${counted(counts.pins ?? 0, 'pin')}, ${counted(counts.courses ?? 0, 'course')}, ${resultCount}. No saved keys or sign-in details are included.`;
    transferResult.replaceChildren(receipt, link);
    link.focus();
  });

  choose.addEventListener('click', () => picker.click());

  let previewDraft!: (button: HTMLButtonElement) => Promise<void>;
  let restoreDraft!: (button: HTMLButtonElement) => Promise<void>;
  const paintBackupDraft = (focus = false): void => {
    const draft = ACCOUNT_BACKUP_DRAFT;
    if (!draft) return;
    if (!draft.canRestore && !draft.canRetry) {
      transferResult.replaceChildren(transferLine(draft.line));
      if (focus) choose.focus();
      return;
    }
    const action = el(`<button data-backup-retry></button>`) as HTMLButtonElement;
    action.textContent = draft.canRestore ? 'Restore this backup' : 'Check this backup again';
    if (draft.canRestore) action.setAttribute('data-restore-backup', '');
    action.addEventListener('click', () => void (draft.canRestore ? restoreDraft(action) : previewDraft(action)));
    transferResult.replaceChildren(transferLine(draft.line), action);
    if (focus) action.focus();
  };

  previewDraft = async (button: HTMLButtonElement): Promise<void> => {
    const draft = ACCOUNT_BACKUP_DRAFT;
    if (!draft) return;
    transferBusy(true);
    button.disabled = true;
    transferResult.replaceChildren(transferLine(`Checking ${draft.name}…`));
    let response: Response | null = null;
    let body: Record<string, unknown> = {};
    try {
      response = await serviceFetch('/account/restore/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ backup: draft.backup }),
      });
      body = await response.json().catch(() => ({})) as Record<string, unknown>;
    } catch { /* handled as a retryable unreachable service below */ }
    if (response && await reopenSignInForExpiredIdentity(
      { kind: 'refused', status: response.status }, async () => { await renderSettings('data', false, 'preview'); },
    )) return;
    transferBusy(false);
    if (!response) {
      draft.line = 'I could not check that backup. Nothing changed.';
      draft.canRestore = false;
      draft.canRetry = true;
      paintBackupDraft(true);
      return;
    }
    const state = typeof body.state === 'string' ? body.state : '';
    const line = response.ok && state === 'same' ? 'This backup is already restored.'
      : response.ok && state === 'resume' ? 'An interrupted restore can resume without duplicating anything.'
        : response.ok && state === 'empty' ? 'This board is empty and ready for this backup.'
          : state === 'conflict'
            ? 'This board already has different learning in it. I will not merge this backup into it.'
            : 'I could not use that backup. Nothing changed.';
    draft.line = line;
    draft.canRestore = response.ok && body.state !== 'same';
    draft.canRetry = false;
    if (draft.canRestore) { paintBackupDraft(true); return; }
    transferResult.replaceChildren(transferLine(line));
    choose.focus();
  };

  restoreDraft = async (button: HTMLButtonElement): Promise<void> => {
    const draft = ACCOUNT_BACKUP_DRAFT;
    if (!draft) return;
    transferBusy(true);
    button.disabled = true;
    transferResult.replaceChildren(transferLine('Restoring this backup…'));
    const result = await apiResult<{ line: string }>('/account/restore', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backup: draft.backup }),
    });
    if (await reopenSignInForExpiredIdentity(result, async () => { await renderSettings('data', false, 'restore'); })) return;
    transferBusy(false);
    if (result.kind !== 'ok') {
      draft.line = 'The restore did not complete. The same checked backup is ready to retry.';
      draft.canRestore = true;
      draft.canRetry = false;
      paintBackupDraft(true);
      return;
    }
    ACCOUNT_BACKUP_DRAFT = null;
    transferResult.replaceChildren(transferLine(result.body.line));
    const openBoard = el(`<button class="link">Open my board</button>`);
    openBoard.addEventListener('click', () => void renderHome());
    transferResult.append(openBoard);
    openBoard.focus();
  };

  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    if (!file) return;
    transferResult.replaceChildren(transferLine(`Reading ${file.name}…`));
    let backup: unknown;
    try { backup = JSON.parse(new TextDecoder().decode(await file.arrayBuffer())); }
    catch {
      ACCOUNT_BACKUP_DRAFT = null;
      transferResult.replaceChildren(transferLine('That file is not a readable Virgil backup.'));
      choose.focus();
      return;
    }
    ACCOUNT_BACKUP_DRAFT = {
      name: file.name, backup, line: `Ready to check ${file.name}.`, canRestore: false, canRetry: true,
    };
    const proxy = el(`<button></button>`) as HTMLButtonElement;
    await previewDraft(proxy);
  });
  board.append(transfer);
  if (ACCOUNT_BACKUP_DRAFT) {
    paintBackupDraft(resumeAction === 'preview' || resumeAction === 'restore');
  } else if (resumeAction === 'download') {
    download.focus();
  }

  // --- leaving ------------------------------------------------------------
  const danger = el(`<div class="account-block danger">
    <h2>${localBoard ? 'Delete this board' : 'Delete your account'}</h2>
    <p class="state" role="status" aria-live="polite">${localBoard
    ? 'This permanently deletes all learning data on this board: pins, topics, lessons, courses and material, planned work, results, Insights, suggestions and awards. It also resets board settings, including model routes, budget and Privacy choices. Virgil stays installed. Saved model keys and Google sign-in stay outside the board. There is no undo. Download a copy from Backup and restore above before you continue if you may want it back.'
    : 'Deleting this account permanently deletes all learning data on its board: pins, topics, lessons, courses and material, planned work, results, Insights, suggestions and awards. It also resets board settings, including model routes, budget and Privacy choices. Your Google account and saved model keys are not deleted. There is no undo. Download a copy from Backup and restore above before you continue if you may want it back.'}</p>
    <div class="row"><button class="warn" data-delete>${localBoard ? 'Delete this board' : 'Delete my account'}</button></div>
    <div class="confirm-host"></div>
  </div>`);
  const host = danger.querySelector('.confirm-host') as HTMLElement;
  const state = danger.querySelector('.state') as HTMLElement;
  const deleteButton = danger.querySelector('[data-delete]') as HTMLButtonElement;

  const openDeleteConfirm = (): void => {
    host.replaceChildren();
    const box = el(`<div class="confirm">
      <div>${localBoard
    ? 'This deletes the only board on this Virgil installation.'
    : `This deletes the account for ${esc(learnerLabel(session) ?? 'this learner')}.`}</div>
      <div>All learning data and board settings are deleted permanently.</div>
      <div class="row"><button class="primary" data-go>Delete everything</button><button class="link" data-cancel>Cancel</button></div>
    </div>`);
    const go = box.querySelector('[data-go]') as HTMLButtonElement;
    const cancel = box.querySelector('[data-cancel]') as HTMLButtonElement;
    cancel.addEventListener('click', () => {
      host.replaceChildren();
      deleteButton.focus();
    });
    go.addEventListener('click', async () => {
      go.disabled = true;
      cancel.disabled = true;
      danger.setAttribute('aria-busy', 'true');
      state.textContent = 'Deleting…';
      if (localBoard) {
        const gone = await apiResult<{ ok: boolean }>('/everything', { method: 'DELETE' });
        danger.removeAttribute('aria-busy');
        if (gone.kind !== 'ok' || gone.body.ok !== true) {
          state.textContent = 'I could not delete this board. Nothing changed.';
          go.disabled = false;
          cancel.disabled = false;
          go.focus();
          return;
        }
        host.replaceChildren();
        forgetLocalDrafts();
        await renderHome();
        focusRoomStart();
        return;
      }
      let identityExpired = false;
      const out = await deleteAccount(async () => {
        const gone = await apiResult<{ ok: boolean }>('/everything', { method: 'DELETE' });
        if (await reopenSignInForExpiredIdentity(gone, async () => { await renderSettings('data', false, 'delete'); })) {
          identityExpired = true;
          return false;
        }
        return gone.kind === 'ok' && gone.body.ok === true;
      });
      if (identityExpired) return;
      danger.removeAttribute('aria-busy');
      state.textContent = out.note;
      if (out.stage === 'none') {
        go.disabled = false;
        cancel.disabled = false;
        go.focus();
        return;
      }
      host.replaceChildren();
      forgetLocalDrafts();
      if (out.gone) { await renderHome(); focusRoomStart(); return; }
      await renderSignIn('sign-in', out.note);
      focusRoomStart();
    });
    host.append(box);
    go.focus();
  };
  deleteButton.addEventListener('click', openDeleteConfirm);
  board.append(danger);
  if (resumeAction === 'delete') openDeleteConfirm();
}


/**
 * How many unfiled pins the board shows before it says "and N more".
 *
 * Enough that an afternoon's pinning is visibly there, few enough that the
 * board is still a board. The rest are not hidden — they are counted, and the
 * count is of their own work.
 */
const UNFILED_SHOWN = 6;
let currentTheme: Theme = 'system';

/**
 * `system` writes nothing, so the stylesheet's own media query decides — which
 * is the whole point of having a third state rather than two.
 *
 * Nothing is relabelled afterwards any more. The only control that names the
 * current theme is the select in Settings, and a select that fired this change
 * already holds the value it fired with.
 */
function applyTheme(theme: Theme): void {
  currentTheme = applyDocumentTheme(document, theme);
}

/** Learn keeps choosing and teaching as states of the same page. */
interface Learning {
  /** The lesson to open, or null for wherever the resume point lands. */
  readonly at: string | null;
  /** The close, asked for by the last lesson's forward control. */
  readonly close: boolean;
  /** The exact prepared block Today promised for this time window. Null means
   *  the full stored session, as on direct board and historical routes. */
  readonly topicIds?: readonly string[] | null;
}

async function renderHome(
  said: string | null = null, learning: Learning | null = null,
  face: FaceKey = 'learn',
  boardQuery = '',
  focusPrimaryAction = false,
): Promise<void> {
  // A configured copy is multi-user. Establish whose page this is before any
  // learner-data request leaves the browser: opening Virgil with no session is
  // the sign-in door, not a board request followed by an infrastructure error.
  const config = await readAuthConfig();
  const browserSession = config ? await readSession() : null;
  if (config && !browserSession) return renderSignIn();
  adoptLocalDraftOwner(config ? browserSession!.uid : 'single-board');
  void flushExternalPending();

  const head = frame('today');
  const owner = roomOwnership();

  const wait = thinking(LOADING_HOME);
  owner.content.append(wait);

  /** First paint distinguishes an absent service from an authentication refusal. */
  const [sessionRead, prefs, todayRead, progression] = await Promise.all([
    apiResult<{
      session: Session | null; card: SessionCardView | null; upcoming?: UpcomingView[];
    }>('/session'),
    api<PrefsView & { availableMinutes?: AvailableMinutes }>('/prefs'),
    apiResult<{ next: NextActionView }>('/today'),
    api<{ strip: ProgressionEventView[] }>('/progression'),
  ]);
  if (!ownsRoom(owner)) return;

  // A stored session is only a claim until this deployment accepts it. The
  // old path painted the learner's page, let four personal reads fail, then
  // stranded them behind "Sign in again". A rejected identity is the sign-in
  // door itself: forget the unusable session and go there without another
  // click or an infrastructure-shaped detour.
  if ([sessionRead, todayRead].some((read) =>
    read.kind === 'refused' && (read.status === 401 || read.status === 403))) {
    if (config) await signOut();
    const recovered = config ?? await discoverAuthConfig(await serviceBase());
    if (recovered) {
      if (!ownsRoom(owner)) return;
      return renderSignIn();
    }
  }
  wait.remove();

  /** A failed `/today` ranking must not hide the independently loaded board. */
  const unreadable = todayRead.kind !== 'ok'
    ? (todayRead.kind === 'refused'
      ? boardUnreadableLine('refused', todayRead.status)
      : boardUnreadableLine('unreachable', null))
    : null;

  // The processing-pause contract, above everything: while collection is off, "is it off?" outranks
  // whatever the day holds.
  const paused = pausedBanner(prefs);
  if (paused) owner.content.append(paused);

  const sessionData = sessionRead.kind === 'ok' ? sessionRead.body : null;

  /** Build the room shell once; lesson transitions replace only column contents. */
  /**
   * The toggle sits above everything a face change touches, so it never moves.
   * Two faces of the same page: what the product has lined up, and everything
   * the learner has put on the board.
   */
  // Learn/Board is page navigation. The side panel is the current lesson and
  // Visit full site is its door to the full board, so drawing the page toggle here
  // both lies about the surface and (because it is board-positioned) collides
  // with the persistent picker tools at 360px.
  const toggle = SURFACE === 'page'
    ? faceToggle((picked) => void showFace(picked))
    : el(`<div class="panel-face-anchor"></div>`);
  if (SURFACE === 'page') owner.content.append(toggle);

  /**
   * The chips are the learner's own stored preference, so they are drawn from
   * it rather than from the ranking's echo of it. That is also what lets them
   * survive a `/today` that will not answer.
   */
  const chips = timeChoice(validMinutes(
    todayRead.kind === 'ok' ? todayRead.body.next.availableMinutes : prefs?.availableMinutes));
  const modeToggle = learnModeToggle();
  owner.content.append(modeToggle);

  /** The stylesheet collapses this main-and-rail layout at narrow widths. */
  const columns = el(`<div class="room-columns" data-guide-target="learn-surface">
    <div class="room-main"></div>
    <aside class="room-rail"></aside>
  </div>`);
  owner.content.append(columns);

  /** Keep the `.next-action` card mounted while `paintLearn` swaps its contents. */
  const cardNode = el(`<section class="next-action" data-guide-target="current-priority"></section>`);
  const mainCol = columns.querySelector('.room-main') as HTMLElement;
  mainCol.append(cardNode);

  learnMount = {
    board: owner.content,
    columns,
    chips,
    modeToggle,
    main: columns.querySelector('.room-main') as HTMLElement,
    rail: columns.querySelector('.room-rail') as HTMLElement,
    cardNode,
    pinsHost: el(`<div class="pins-face" data-guide-target="pins"></div>`),
    boardHost: el(`<div class="board-face" data-guide-target="grow-surface"></div>`),
    externalHost: el(`<div class="external-face-host"></div>`),
    find: (head.querySelector('.find') as HTMLElement | null) ?? el(`<div class="find"></div>`),
    boardSearch: null,
    boardQuery,
    toggle,
    face: 'learn',
    boardDrawn: false,
    next: todayRead.kind === 'ok' ? todayRead.body.next : null,
    passedOver: [],
    unreadable,
    card: sessionData?.card ?? null,
    upcoming: sessionData?.upcoming ?? [],
    progression,
    session: sessionData?.session ?? null,
    said,
    state: null,
    mode: learning ? 'current' : 'lineup',
    currentCard: null,
    currentRail: null,
    currentKind: null,
    currentRailState: null,
  };
  await showFace(face, learning);
  if (focusPrimaryAction && face === 'learn' && !learning) {
    (learnMount?.cardNode.querySelector('[data-start]') as HTMLElement | null)?.focus();
  }
}

/** Swap Learn faces without rebuilding the shell; re-read only external handoffs. */
async function showFace(face: FaceKey, learning: Learning | null = null): Promise<void> {
  const m = learnMount;
  if (!m) return;
  m.face = face;
  m.board.setAttribute('data-learn-face', face);
  m.columns.setAttribute('data-face', face);
  for (const button of Array.from(m.toggle.querySelectorAll('[data-face-key]'))) {
    button.setAttribute('aria-pressed',
      String(button.getAttribute('data-face-key') === face));
  }

  if (face === 'external') {
    // The search bar filters the board and nothing else, so it leaves with the
    // board face exactly as it does on the way to Learn.
    m.find.replaceChildren();
    m.main.replaceChildren(m.externalHost);
    await drawExternalFace(m);
    return;
  }

  if (face === 'pins') {
    m.find.replaceChildren();
    m.main.replaceChildren(m.pinsHost);
    await drawPinsFace(m);
    return;
  }

  if (face === 'board') {
    m.main.replaceChildren(m.boardHost);
    if (!m.boardDrawn) {
      m.boardDrawn = true;
      await drawBoardFace(m);
    } else if (m.boardSearch) {
      // Learn empties the masthead slot because this search cannot filter that
      // face. Move the cached Board's own bar back on return: rebuilding it
      // would discard the learner's query and misrepresent a cached face.
      m.find.replaceChildren(m.boardSearch);
    }
    return;
  }

  // The search bar belongs to the board face. The slot stays; what is in it
  // goes, so the bar cannot sit over a lineup it cannot filter.
  m.find.replaceChildren();
  m.main.replaceChildren(m.cardNode);
  if (m.cardNode.querySelector('[data-foreground-lesson]')) return;
  await paintLearn(learning);
}

/**
 * The toggle, in the house's own segmented idiom.
 *
 * The same shape as the time chips one row down — a row of quiet buttons where
 * the chosen one is filled — because this product should have one answer to "a
 * row of things you can be in one of" rather than two. It is navigation, so it
 * is quiet: `--accent` stays with Start, and the filled state is the same
 * muted-until-chosen treatment the chips and the nav doors already use.
 *
 * Built once and never rebuilt, which is what lets it sit above everything that
 * changes without moving when the face does.
 */
/** One of the three the chips offer, or the middle one. The panel's own copy of
 *  the domain's `validAvailableMinutes`, which it may not import. */
const validMinutes = (value: unknown): AvailableMinutes =>
  ([1, 3, 5] as const).find((n) => n === Number(value)) ?? 3;

function faceToggle(onPick: (face: FaceKey) => void): HTMLElement {
  const node = el(`<div class="face-toggle" role="group"></div>`);
  node.setAttribute('aria-label', FACE_TOGGLE_LABEL);
  for (const face of FACES) {
    const button = el(`<button class="face" data-face-key="${esc(face.key)}"></button>`) as HTMLButtonElement;
    button.textContent = face.label;
    button.setAttribute('aria-pressed', String(face.key === 'learn'));
    button.addEventListener('click', () => {
      if (learnMount?.face === face.key) return;
      guardNavigation(() => onPick(face.key));
    });
    node.append(button);
  }
  return node;
}

/**
 * The live nodes Learn swaps between its two states, and the data both need.
 *
 * Held on the module rather than passed around because the point is that they
 * are the SAME nodes: a state change replaces the children of two elements and
 * touches nothing else on the page. The masthead, the chips, the columns
 * container, the aside and the footer notice are all still the objects they
 * were before the learner pressed anything.
 *
 * Cleared by `frame`, which is the only thing that rebuilds `#app`. So a room
 * change tears this down by construction and there is no stale reference to a
 * node nobody is looking at.
 */
interface LearnMount {
  readonly board: HTMLElement;
  /** Where the board face draws itself. Built empty and filled once per visit;
   *  see `showFace`. */
  readonly boardHost: HTMLElement;
  /** The capture inbox. Re-read on entry because browser captures can arrive
   *  while another face is visible. */
  readonly pinsHost: HTMLElement;
  /** The masthead's search slot. The bar the board face mounts there is the one
   *  thing about the top bar a face change touches, and it changes the slot's
   *  contents rather than the bar. */
  readonly find: HTMLElement;
  /** Detached while Learn is visible, then reattached with the cached Board. */
  boardSearch: HTMLElement | null;
  /** The query that owns a newly drawn Board, including a return from a take. */
  boardQuery: string;
  readonly toggle: HTMLElement;
  readonly columns: HTMLElement;
  readonly chips: HTMLElement;
  readonly modeToggle: HTMLElement;
  readonly main: HTMLElement;
  readonly rail: HTMLElement;
  /** The bordered card with the accent line. The one thing on this page the eye
   *  anchors on, and the one node a state change may never rebuild. */
  readonly cardNode: HTMLElement;
  /** Swapped in place by  *show me another*, which re-reads the ranking
   *  and repaints this one card rather than the page. */
  next: NextActionView | null;
  /** The quick-take pins refused on this visit. It dies with the mount, so a
   *  fresh arrival offers the board's best pick again; the durable record of
   *  the same gesture is the passed-over ledger. */
  passedOver: readonly string[];
  /** What `/today` said when it refused, or null. The learn face draws it in
   *  the card; the board face is unaffected and stays reachable. */
  readonly unreadable: string | null;
  /** A 401/403 on a configured copy means identity no longer opens a board. */
  readonly card: SessionCardView | null;
  upcoming: readonly UpcomingView[];
  readonly progression: { strip: ProgressionEventView[] } | null;
  /** Re-read by a terminal action, which is the one thing that changes it. */
  session: Session | null;
  said: string | null;
  /** Which state is painted, so a control outside the card can tell whether
   *  acting on it would throw the learner out of a lesson. */
  state: Learning | null;
  mode: 'current' | 'lineup';
  currentCard: readonly Node[] | null;
  currentRail: readonly Node[] | null;
  currentKind: string | null;
  currentRailState: string | null;
  /** Where the External clearinghouse draws its latest unresolved read. */
  readonly externalHost: HTMLElement;
  /** Which face is showing, and whether the cached Board has been built yet. */
  face: FaceKey;
  boardDrawn: boolean;
}

let learnMount: LearnMount | null = null;

function updateLearnModeToggle(m: LearnMount): void {
  for (const button of Array.from(m.modeToggle.querySelectorAll('[data-learn-mode]')) as HTMLButtonElement[]) {
    const mode = button.getAttribute('data-learn-mode');
    button.setAttribute('aria-pressed', String(mode === m.mode));
    button.disabled = mode === 'current' && !m.state && !m.currentCard;
  }
}

function learnModeToggle(): HTMLElement {
  const node = el(`<div class="learn-mode-toggle" role="group" aria-label="Lesson view">
    <button data-learn-mode="current">Current</button>
    <button data-learn-mode="lineup">Lineup</button>
  </div>`);
  for (const button of Array.from(node.querySelectorAll('[data-learn-mode]')) as HTMLButtonElement[]) {
    button.addEventListener('click', () => {
      const mode = button.getAttribute('data-learn-mode') as 'current' | 'lineup';
      showLearnMode(mode);
    });
  }
  return node;
}

function showLearnMode(mode: 'current' | 'lineup'): void {
  const m = learnMount;
  if (!m || m.face !== 'learn' || m.mode === mode) return;
  if (mode === 'lineup') {
    if (m.mode === 'current') {
      m.currentCard = Array.from(m.cardNode.children);
      m.currentRail = Array.from(m.rail.children);
      m.currentKind = m.cardNode.getAttribute('data-kind');
      m.currentRailState = m.columns.getAttribute('data-rail');
    }
    m.mode = 'lineup';
    updateLearnModeToggle(m);
    paintLearnView(m);
    (m.modeToggle.querySelector('[data-learn-mode="lineup"]') as HTMLElement | null)?.focus();
    return;
  }
  if (!m.state) return;
  m.mode = 'current';
  updateLearnModeToggle(m);
  m.board.setAttribute('data-learning', 'yes');
  if (m.currentCard && m.currentRail) {
    m.cardNode.replaceChildren(...m.currentCard);
    m.rail.replaceChildren(...m.currentRail);
    if (m.currentKind) m.cardNode.setAttribute('data-kind', m.currentKind);
    else m.cardNode.removeAttribute('data-kind');
    m.columns.setAttribute('data-rail', m.currentRailState ?? 'yes');
  } else paintLearnView(m);
  (m.modeToggle.querySelector('[data-learn-mode="current"]') as HTMLElement | null)?.focus();
}

/** Replace only the Learn columns; a sessionless request falls back to lineup. */
async function paintLearn(state: Learning | null): Promise<void> {
  const m = learnMount;
  if (!m) return;
  const learning = state && m.session && m.session.sections.length ? state : null;
  m.state = learning;
  m.mode = learning ? 'current' : 'lineup';
  m.currentCard = null;
  m.currentRail = null;
  m.currentKind = null;
  m.currentRailState = null;
  updateLearnModeToggle(m);
  paintLearnView(m);
}

function paintLearnView(m: LearnMount): void {
  const learning = m.mode === 'current' ? m.state : null;
  m.board.setAttribute('data-learning', learning ? 'yes' : 'no');
  m.cardNode.replaceChildren();
  m.rail.replaceChildren();

  const firstRun = !learning && m.next?.primary.kind === 'capture-material';
  const caughtUp = !learning && m.next?.primary.kind === 'caught-up';
  const pendingChoice = !learning && m.next?.primary.kind === 'quick-take'
    && m.next.primary.destination === 'board';
  // Only the explicit repair action is untimed. Older/self-hosted services and
  // deliberately sparse fixtures can omit `url` from an otherwise valid
  // Open-material action, so absence alone is not enough to reclassify study
  // as repair work.
  const missingMaterialLink = !learning
    && m.next?.primary.kind === 'course-material'
    && m.next.primary.cta === 'Add its link';

  /** Rail time shows the lineup total or the current lesson's remaining time. */
  if (!firstRun && !caughtUp && !pendingChoice && !missingMaterialLink) {
    const visibleSession = learning?.topicIds?.length
      ? { ...m.session!, sections: m.session!.sections.filter(
        (section) => learning.topicIds!.includes(section.topicId),
      ) }
      : m.session;
    const minutes = learning
      ? remainingMinutes(visibleSession as unknown as SessionView)
      : lineupTotal(m);
    // Zero is the absence of work, not a useful duration. A finished lesson
    // already owns an explicit completion receipt; printing "Expected time ·
    // 0 min" beside it makes a correct session total look like a broken
    // estimate. Mixed sessions keep the kicker because their unfinished work
    // still has a real cost.
    if (!learning || minutes > 0) m.rail.append(railKicker(minutes));
  }

  if (learning) paintLesson(m, learning);
  else {
    paintLineup(m);
    m.cardNode.insertBefore(m.chips, m.cardNode.firstChild);
  }

  m.columns.setAttribute('data-rail', 'yes');
  if (learning) return;

  // The arrival screen, and the two other states the rail has nothing to list
  // in. All three are drawn in `arrival.ts`; what a way-to-add row PRESSES is
  // decided here, because rooms are the shell's to open.
  if (firstRun) {
    m.rail.append(waysToAddBlock(openArrivalDoor));
    m.columns.setAttribute('data-rail', 'empty');
    return;
  }

  if (caughtUp) {
    m.rail.append(caughtUpBlock(m.next?.primary.destination ?? null));
    m.columns.setAttribute('data-rail', 'empty');
    return;
  }

  if (pendingChoice) {
    m.columns.setAttribute('data-rail', 'empty');
    return;
  }

  // The kicker is above the line and does not count as content for this,
  // because it is furniture rather than something to go and do.
  if (m.rail.children.length <= 1) {
    m.rail.append(railEmptyBlock(m.next?.primary.kind === 'session'));
    m.columns.setAttribute('data-rail', 'empty');
  }
}

/**
 * Where a way-to-add row lands, and why each one is the honest room for it.
 *
 * `capture` is the intake sheet in My studies, which is where a syllabus, a
 * document or a screenshot of one is read. `plan` opens the Plan's own Add,
 * whose first route is "Something with a date" — the room that actually takes
 * an obligation. Neither row invents a destination the nav does not already
 * have a door to.
 */
const openArrivalDoor = (door: ArrivalDoor): void => {
  if (door === 'plan') return void renderPlan(null, false, true);
  void renderCourses(null, true);
};

/** What the whole lineup costs, or what the next move costs when there is no
 *  lineup to sum. */
function lineupTotal(m: LearnMount): number {
  let items = m.next?.primary.kind === 'session'
    && m.session && cardIsStartable(m.card) && hasSomethingReady(m.session)
    ? lineupItems(m.session) : [];
  const bounded = m.next?.primary.kind === 'session'
    ? m.next.primary.sessionTopicIds : null;
  if (bounded?.length) {
    const ids = new Set(bounded);
    items = items.filter((item) => ids.has(item.topicId));
  }
  if (items.length) return items.reduce((a, i) => a + i.minutes, 0);
  return m.next?.primary.minutes ?? 0;
}

/** Above the line, in both states. */
function railKicker(minutes: number): HTMLElement {
  const node = el(`<p class="rail-kicker"></p>`);
  node.textContent = expectedTimeLine(minutes);
  return node;
}

const emptyLine = (line: string): HTMLElement => {
  const node = el(`<p class="empty"></p>`);
  node.textContent = line;
  return node;
};

/** The choosing state: the hero and tonight's lineup, and what else there is. */
function paintLineup(m: LearnMount): void {
  if (!m.next) {
    // The ranking could not be read. One honest line, in the card, with the
    // toggle beside it still working: the board is the learner's own material
    // and does not depend on this endpoint.
    m.cardNode.setAttribute('data-kind', 'unreadable');
    m.cardNode.replaceChildren(emptyLine(m.unreadable ?? ''));
    return;
  }
  m.cardNode.setAttribute('data-kind', m.next.primary.kind);
  fillNextAction(m.cardNode, m.next, m.session, m.card);

  // What the last press did, when it was a press whose work outlives the click.
  // Inside the card, so the column's own children never change and the card
  // never has a sibling appearing and disappearing beneath it.
  if (m.said) {
    const note = el(`<p class="meta build-note" role="status" aria-live="polite"></p>`);
    note.textContent = m.said;
    m.cardNode.append(note);
    if (m.said === BUILD_STARTED_LINE || m.said === BUILD_ALREADY_RUNNING_LINE) {
      const oldStart = m.cardNode.querySelector('[data-start]') as HTMLButtonElement | null;
      const actions = oldStart?.parentElement;
      if (actions) {
        const progress = el(`<button class="primary big">See progress on Board</button>`) as HTMLButtonElement;
        progress.addEventListener('click', () => void showFace('board'));
        actions.replaceChildren(progress);
      }
    }
  }

  // A safety decision is the first fact in the rail. The ranked next move still
  // owns the hero and its only accent, but a learner who just pressed Process
  // must not scroll past future work and alternatives to discover why the
  // session they expected is absent.
  if (m.card && m.card.state === 'withheld') m.rail.append(heldBack(m.card));

  /** The rail contains actionable or already-prepared learning, never tasks. */
  const allPrepared = lineupItems(m.session);
  const selectedSessionTopics = new Set(m.next.primary.kind === 'session'
    ? (m.next.primary.sessionTopicIds ?? allPrepared.map((item) => item.topicId)) : []);
  // Only the new bounded actions project a stored session into the rail. An
  // older service names no section ids, while a non-session action may coexist
  // with stale session data in a mixed-version install; neither may invent a
  // new rail contract from information the ranker did not send.
  const projectsPrepared = m.next.primary.kind === 'quick-take'
    || (m.next.primary.kind === 'session' && !!m.next.primary.sessionTopicIds?.length);
  const prepared = (projectsPrepared ? allPrepared : [])
    .filter((item) => !selectedSessionTopics.has(item.topicId));
  // Source-viable but unbuilt lessons live in the Board's Pending area. Only
  // already-real learning alternatives remain beside a timed Learn choice.
  const ready = readyBlock(prepared);
  if (ready) m.rail.append(ready);

  const instead = insteadBlock(m.next, m.session);
  if (instead) m.rail.append(instead);

  // What already happened, beside what there is to do.
  const strips = el(`<div class="strips"></div>`);
  if (renderMomentum(strips, m.progression)) m.rail.append(strips);
}

/** Explain withheld sections without presenting them as actions. */
function heldBack(card: SessionCardView): HTMLElement {
  const node = el(`<div class="ready zone" data-zone="held-back">
    <div class="eyebrow">Your session</div>
    <h2></h2>
    <div class="meta"></div>
    <div class="withheld"></div>
    <p class="next"></p>
  </div>`);
  (node.querySelector('h2') as HTMLElement).textContent = cardHeading(card);
  (node.querySelector('.meta') as HTMLElement).textContent = card.reason ?? '';
  const held = node.querySelector('.withheld') as HTMLElement;
  for (const line of withheldLines(card)) {
    const row = el(`<div class="held"></div>`);
    row.textContent = line;
    held.append(row);
  }
  (node.querySelector('.next') as HTMLElement).textContent = withheldNextLine();
  return node;
}

/** Available time is the learner's constraint, not a planning preference. */
function timeChoice(current: AvailableMinutes): HTMLElement {
  const node = el(`<div class="time-choice">
    <span data-time-label>Session length</span><div class="time-options"></div>
    <span class="meta time-said" role="status" aria-live="polite"></span>
  </div>`);
  const host = node.querySelector('.time-options') as HTMLElement;
  const said = node.querySelector('.time-said') as HTMLElement;
  let chosen: AvailableMinutes = current;
  let saving = false;
  /** The chips themselves, so the pressed state can be moved without asking the
   *  DOM to find them again by their own labels. */
  const chips: { minutes: AvailableMinutes; button: HTMLButtonElement }[] = [];
  for (const minutes of [1, 3, 5] as const) {
    const button = el(`<button class="time"></button>`) as HTMLButtonElement;
    button.textContent = `${minutes} min`;
    button.setAttribute('data-minutes', String(minutes));
    if (minutes === current) button.setAttribute('aria-pressed', 'true');
    button.addEventListener('click', async () => {
      if (minutes === chosen || saving) return;
      saving = true;
      said.textContent = '';
      node.setAttribute('aria-busy', 'true');
      for (const chip of chips) chip.button.disabled = true;
      const saved = await api('/prefs', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ availableMinutes: minutes }),
      });
      node.removeAttribute('aria-busy');
      saving = false;
      for (const chip of chips) chip.button.disabled = false;
      if (!saved) {
        said.textContent = 'That time did not save. Your previous choice is unchanged.';
        button.focus();
        return;
      }
      chosen = minutes;
      for (const chip of chips) {
        chip.button.setAttribute('aria-pressed', String(chip.minutes === minutes));
      }
      await refreshLearnLineup();
      (learnMount?.chips.querySelector(`[data-minutes="${minutes}"]`) as HTMLElement | null)?.focus();
    });
    chips.push({ minutes, button });
    host.append(button);
  }
  return node;
}

async function refreshLearnLineup(said: string | null = null): Promise<void> {
  const m = learnMount;
  if (!m) return;
  const [sessionData, todayRead] = await Promise.all([
    api<{ session: Session | null; card: SessionCardView | null; upcoming?: UpcomingView[] }>('/session'),
    apiResult<{ next: NextActionView }>('/today'),
  ]);
  if (learnMount !== m) return;
  if (sessionData) {
    m.session = sessionData.session;
    m.upcoming = sessionData.upcoming ?? [];
  }
  if (todayRead.kind === 'ok') m.next = todayRead.body.next;
  if (said) m.said = said;
  if (m.mode === 'lineup') paintLearnView(m);
}

/**
 * What `/today` named, marked where it is rather than at the top of the room.
 *
 * One gesture for every room the next move can point into. The Plan had it and
 * nowhere else did, so a next move naming a course draft opened My studies at
 * the top and left the learner to find the thing the product had just told
 * them about.
 */
function markIfNamed(node: HTMLElement, id: string, focus: string | null): void {
  if (!focus || focus !== id) return;
  node.classList.add('attention');
  (node as unknown as { scrollIntoView?: () => void }).scrollIntoView?.();
}

function openAction(action: ActionOptionView, session: Session | null): void {
  if (action.destination === 'session') {
    // The board rather than a repaint of this screen when the lesson itself
    // cannot be read: `/session` is down and the material is still somewhere.
    // Learning happens on this page. `openAction` is the hero's own press and
    // the rail's alternatives; both open the lesson in place rather than
    // sending anybody to a room.
    return void (session ? openLesson(
      action.sessionTopicIds?.[0] ?? null, session, false, action.sessionTopicIds ?? null,
    ) : openBoardFace());
  }
  if (action.destination === 'take' && action.targetId) {
    return void openTake(
      action.targetId, action.title.replace(/^A quick take on /, ''), validMinutes(action.minutes),
    );
  }
  if (action.destination === 'burst') return void renderBurst();
  if (action.destination === 'plan') return void renderPlan(
    action.targetId ?? null,
    // Ordinary exact-work handoffs focus the card. The link-repair intent
    // opens and focuses its own editor during card construction, so the final
    // card focus must not steal that more specific destination.
    action.planIntent !== 'links',
    false, false, null, action.planIntent ?? null,
  );
  if (action.destination === 'build') return void buildFromHere();
  if (action.destination === 'board') return void openBoardFace();
  if (action.kind === 'course-material' && action.url) {
    // Opening a link is not learning evidence. Leave an explicit return
    // receipt in this tab; only the learner's check-in records the bounded
    // block Today offered.
    const checkIn = renderMaterialCheckIn(action);
    const tabKey = `course:${action.targetId ?? ''}:material:${action.materialId ?? action.url}`;
    void openBrowserTab(action.url, tabKey).then((state) => {
      if (state !== 'reused') return;
      const opened = checkIn.querySelector('.bare') as HTMLElement | null;
      if (opened) opened.textContent = 'This material is already open in another tab. '
        + 'Return to it, then come back here when this block is done.';
    }).catch(() => renderCourses(action.targetId ?? null));
    return;
  }
  if (action.kind === 'course-material' && action.targetId && action.materialId) {
    // A retained book/LMS item with no URL is real material, but it is not an
    // immediately openable lesson. Land on the exact repair rather than a
    // completion tick that would turn missing location into claimed study.
    return void renderCourses(
      action.targetId, false, action.materialId, null, false, null, null, true,
      false, null, { returnToLearnAfterLinkRepair: true },
    );
  }
  // A capture action is the empty-state route INTO intake, so it opens the Add
  // sheet rather than leaving the learner one press short. An intake action
  // points at a draft that already exists and therefore keeps the focus id.
  if (action.destination === 'capture') return void renderCourses(null, true);
  return void renderCourses(action.targetId ?? null);
}

/** The honest return path after Today opens a longer course item. */
function renderMaterialCheckIn(action: ActionOptionView, focusRecord = false): HTMLElement {
  frame('material-check-in', { title: action.title });
  const startingProgress = Math.max(0, action.materialProgressMinutes ?? 0);
  const prompt = materialCheckInPrompt(action.minutes, startingProgress, action.materialTotalMinutes);
  const node = el(`<section class="material-check-in">
    <p class="bare"></p>
    <p class="meta check-in-note"></p>
    <div class="row check-in-actions">
      <button class="primary" data-record></button>
      <button data-not-yet>Not yet</button>
    </div>
    <p class="said" role="status" aria-live="polite"></p>
  </section>`);
  const opened = node.querySelector('.bare') as HTMLElement;
  const checkInNote = node.querySelector('.check-in-note') as HTMLElement;
  opened.textContent =
    'Virgil opened the material in a new tab. Come back here when this block is done.';
  checkInNote.textContent = prompt.note;
  const record = node.querySelector('[data-record]') as HTMLButtonElement;
  const notYet = node.querySelector('[data-not-yet]') as HTMLButtonElement;
  const actions = node.querySelector('.check-in-actions') as HTMLElement;
  const said = node.querySelector('.said') as HTMLElement;
  record.textContent = prompt.recordLabel;
  record.addEventListener('click', async () => {
    if (!action.targetId || !action.materialId) {
      said.textContent = 'Open My studies to update this item.';
      record.focus();
      return;
    }
    record.disabled = true; notYet.disabled = true;
    node.setAttribute('aria-busy', 'true');
    said.textContent = 'Recording this block…';
    const updated = await apiResult<{
      material: { progressMinutes?: number; doneAt?: string | null };
      alreadyRecorded?: boolean;
    }>(`/courses/${encodeURIComponent(action.targetId)}/material/${encodeURIComponent(action.materialId)}/progress`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        minutes: action.minutes,
        expectedProgressMinutes: startingProgress,
      }),
    });
    if (await reopenSignInForExpiredIdentity(
      updated, () => { renderMaterialCheckIn(action, true); },
    )) return;
    if (updated.kind !== 'ok') {
      said.textContent = updated.kind === 'unreachable'
        ? 'I could not confirm this block. Try again; the same block will not be counted twice.'
        : 'I could not save this check-in. Return to Learn if the material changed, or try again.';
      node.removeAttribute('aria-busy');
      record.disabled = false; notYet.disabled = false;
      record.focus();
      return;
    }
    said.textContent = materialCheckInReceipt(
      action.minutes, startingProgress, action.materialTotalMinutes, updated.body.material,
    );
    opened.remove();
    checkInNote.remove();
    node.removeAttribute('aria-busy');
    actions.replaceChildren();
    const next = el(`<button class="primary">See what’s next</button>`) as HTMLButtonElement;
    next.addEventListener('click', () => void renderHome());
    actions.append(next);
    next.focus();
  });
  notYet.addEventListener('click', () => {
    said.textContent = 'Nothing recorded.';
    actions.replaceChildren();
    const back = el(`<button>Back to Learn</button>`) as HTMLButtonElement;
    back.addEventListener('click', () => void renderHome());
    actions.append(back);
    back.focus();
  });
  roomContent.append(node);
  if (focusRecord) record.focus();
  return node;
}

/**
 * Building tonight's session, from the button that offered to.
 *
 * `POST /sessions/build` takes no body and builds from the whole board, which
 * is the honest shape: the run is a run, not a query, and a parameterised build
 * would be a promise to teach one thing that the Gardener is the only thing
 * entitled to make. What the deadline does is weigh the board (`dueWeight`), so
 * the commitment that sent somebody here is already shaping what comes out.
 *
 * The screen redraws with one line about what is happening. It does not wait:
 * the run re-fetches every pinned page and takes minutes, and a panel holding a
 * spinner over it would be lying about how long it has.
 */
async function buildFromHere(): Promise<void> {
  const r = await apiResult<{ ok: boolean; started?: boolean; already?: boolean }>(
    '/sessions/build', { method: 'POST' },
  );
  if (r.kind === 'ok') {
    return void renderHome(r.body.already ? BUILD_ALREADY_RUNNING_LINE : BUILD_STARTED_LINE);
  }
  return void renderHome(
    r.kind === 'refused' ? buildRefusedLine(r.status) : BUILD_NOT_STARTED_LINE);
}

/** One hero decision. Alternatives are context, never rival primary cards. */
function fillNextAction(
  node: HTMLElement,
  next: NextActionView, session: Session | null, card: SessionCardView | null = null,
): void {
  const action = next.primary;
  // Built into a throwaway wrapper and moved across, so the CARD survives: it
  // is the element with the accent line, and rebuilding it is what made every
  // previous attempt feel like navigation.
  const built = el(`<div>
    <h1></h1>
    <p class="action-detail"></p>
    <p class="built"></p>
    <div class="registers"></div>
    <div class="action-reasons"></div>
    <div class="lineup-host"></div>
    <div class="row"><button class="primary big" data-start></button></div>
    <div class="offer-host"></div>
    <div class="alternatives"></div>
  </div>`);
  node.replaceChildren(...Array.from(built.children));
  /** Localize only the known time-sensitive lineup title from the browser clock. */
  (node.querySelector('h1') as HTMLElement).textContent = action.title === LINEUP_HEADING_SENT
    ? lineupHeading(new Date().getHours())
    : action.title;

  const isSession = action.destination === 'session'
    && cardIsStartable(card) && hasSomethingReady(session);

  /** Session rows carry their own details, so omit duplicated hero scaffolding. */
  const detail = node.querySelector('.action-detail') as HTMLElement;
  if (isSession) detail.remove();
  else detail.textContent = action.detail;
  (node.querySelector('.built') as HTMLElement).remove();

  /**
   * The session-wide register strip, kept for every state EXCEPT the one where
   * the lineup replaces it.
   *
   * The learner-lineup contract: *"the expected level (the existing register chips)"* is now
   * shown per row, on the thing it is actually about. A strip above the list
   * saying the same three words about the whole evening would be the summary
   * card surviving inside the thing that replaced it, and the learner would be
   * reading one colour key twice.
   */
  const registers = node.querySelector('.registers') as HTMLElement;
  let items = isSession && session ? lineupItems(session) : [];
  if (action.sessionTopicIds?.length) {
    const ids = new Set(action.sessionTopicIds);
    items = items.filter((item) => ids.has(item.topicId));
  }

  /** The persistent rail owns duration because the hero is replaceable. */
  const chips = isSession && card && !items.length ? registerChips(card.registers) : [];
  for (const chip of chips) {
    const pill = el(`<span class="register" data-register="${esc(chip.value)}"></span>`);
    pill.textContent = chip.label;
    registers.append(pill);
  }
  if (!chips.length) registers.remove();

  /** Omit hero reasons when lineup rows already expose them in place. */
  const reasons = node.querySelector('.action-reasons') as HTMLElement;
  for (const reason of items.length ? [] : action.reasons) {
    const line = el(`<p class="why"></p>`);
    line.textContent = reason.text;
    reasons.append(line);
  }
  /**
   * The card's one why-line, kept only where nothing better replaces it.
   *
   * It is the highest-priority reason across the whole night, said once. With
   * the lineup on screen every row carries its own reason behind `(i)`, and a
   * night-wide sentence above a list of per-row sentences is the same claim
   * made twice at two different scales.
   */
  if (isSession && card?.why && !items.length) {
    const line = el(`<p class="why" data-from="card"></p>`);
    line.textContent = card.why;
    reasons.append(line);
  }

  const lineupHost = node.querySelector('.lineup-host') as HTMLElement;
  if (items.length && session) lineupHost.append(lineup(session, items));
  else lineupHost.remove();

  const start = node.querySelector('[data-start]') as HTMLButtonElement;
  start.textContent = action.cta;
  start.addEventListener('click', () => openAction(action, session));

  // the one-minute hero's own pre-read controls, under the one accent.
  // Only on the quick take, because every other hero either already carries the
  // lineup and its six controls per row, or is a state with nothing to refuse:
  // an empty board, a caught-up night, a missing link to repair.
  const offerHost = node.querySelector('.offer-host') as HTMLElement;
  const pinId = action.kind === 'quick-take' && action.destination === 'take'
    ? action.targetId : null;
  if (pinId) {
    offerHost.append(quickTakeOffer({
      el, othersReady: (action.othersReady ?? 0) > 0,
      defer: () => deferTake(pinId), another: () => anotherTake(pinId),
    }).node);
  } else offerHost.remove();

  // The alternatives are their own block in the rail now. See
  // `alternativesBlock`, and the room that places it.
  (node.querySelector('.alternatives') as HTMLElement).remove();
}

/** Show already-prepared lessons without competing with the primary action. */
function readyBlock(items: readonly LineupItem[]): HTMLElement | null {
  if (!items.length) return null;
  const node = el(`<div class="rail-block" data-rail="ready">
    <ul class="rail-list"></ul>
  </div>`);
  const list = node.querySelector('.rail-list') as HTMLElement;
  for (const item of items) {
    const row = el(`<li class="rail-row" data-topic="${esc(item.topicId)}">
      <span class="register" data-register="${esc(item.register)}"></span>
      <span class="rail-name"></span>
      <p class="meta rail-why"></p>
    </li>`);
    const chip = row.querySelector('.register') as HTMLElement;
    if (item.register) {
      chip.textContent = item.registerLabel;
      chip.setAttribute('title', lineupLevelLine(item.register));
    } else chip.remove();
    (row.querySelector('.rail-name') as HTMLElement).textContent = item.subject;
    (row.querySelector('.rail-why') as HTMLElement).textContent =
      preparedReadyLine(item.minutesLabel);
    list.append(row);
  }
  return node;
}

/** List timed learning alternatives without implying that they rebuild the lineup. */
function insteadBlock(
  next: NextActionView, session: Session | null,
): HTMLElement | null {
  const others = learningAlternatives(next.alternatives);
  if (!others.length) return null;

  const node = el(`<div class="rail-block" data-rail="instead">
    <span class="alt-label"></span>
    <div class="rail-actions"></div>
  </div>`);
  (node.querySelector('.alt-label') as HTMLElement).textContent = INSTEAD_HEADING;

  const host = node.querySelector('.rail-actions') as HTMLElement;
  for (const alternative of others) {
    const button = el(`<button class="link alt"><span class="what"></span></button>`) as HTMLButtonElement;
    (button.querySelector('.what') as HTMLElement).textContent =
      railRowLabel(alternative.title, alternative.minutes);
    button.addEventListener('click', () => {
      recordPassedOver(next.primary, alternative);
      openAction(alternative, session);
    });
    host.append(button);
  }
  return node;
}

/**
 * SOMETHING ELSE WAS ON OFFER, AND THIS IS WHAT THEY STARTED.
 *
 * The only place the forward-only ledger is written, and it is written on a
 * press: a record that grew on render would count reading a list as choosing
 * something off it. Fire and forget, because this is a note about what the
 * learner did rather than part of doing it.
 */
function recordPassedOver(primary: ActionOptionView, chosen: ActionOptionView): void {
  if (primary.id === chosen.id) return;
  void api('/model/slipping/passed-over', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      offeredId: primary.id, chosenId: chosen.id,
      offeredReason: primary.reasons?.[0]?.code ?? 'unstated',
    }),
  });
}

/**
 *  — THE TWO GESTURES ON THE ONE MINUTE HERO.
 *
 * `quick-take-offer.ts` owns the controls and their words; the door each one
 * knocks on is here, because only this file holds the mount. They end
 * differently on purpose. *Not now* writes a mark, so the board it has just
 * changed is read again whole, which is what the lineup's X has done since
 * The learner-lineup contract. *Show me another* writes no mark and moves nothing, so only the
 * ranking is re-read and only the card is repainted: rebuilding the page around
 * a refusal that changed nothing is the navigation feel the mount exists to
 * prevent.
 */
async function deferTake(pinId: string): Promise<boolean> {
  const r = await api<{ ok: boolean; backAfterDays?: number }>(
    `/pins/${encodeURIComponent(pinId)}/quick-take/verdict`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'not-now' }),
    });
  if (!r?.ok) return false;
  // The close's own door, the close's own sentence, and the service's own
  // window rather than a copy of it: one decision about timing, in one
  // vocabulary wherever the learner happens to say it.
  await renderHome(quickTakeAnsweredLine('not-now', r.backAfterDays ?? null));
  return true;
}

/**
 * *Show me another*: the pick refused, the topic left alone.
 *
 * `recordPassedOver` is the rail's own call on the rail's own route, made only
 * once the replacement is known, because that door takes two DIFFERENT action
 * ids. The ordering is also what makes the no-op honest: where the ranker has
 * nothing else, nothing was passed over and nothing is recorded. An older
 * service that does not know the parameter answers with the pick it already
 * gave, and saying so is the only move left. No receipt on success: the new
 * pick IS the receipt, and restating what the screen now shows is the narration
 * The interface-affordance contract bans.
 */
async function anotherTake(pinId: string): Promise<QuickTakeSwap> {
  const m = learnMount;
  if (!m?.next) return 'failed';
  const offered = m.next.primary;
  const skipped = [...m.passedOver, pinId];
  const query = skipped.map((id) => `passedOver=${encodeURIComponent(id)}`).join('&');
  const read = await apiResult<{ next: NextActionView }>(`/today?${query}`);
  if (read.kind !== 'ok') return 'failed';
  if (read.body.next.primary.id === offered.id) return 'none';
  recordPassedOver(offered, read.body.next.primary);
  m.next = read.body.next;
  m.passedOver = skipped;
  m.said = null;
  await paintLearn(null);
  return 'swapped';
}

/**
 * Render the session lineup with server-confirmed mutations. Pointer and
 * keyboard reordering share the same persisted order; each row exposes its
 * own register, controls, and ranking reason.
 */

function lineup(session: Session, items: readonly LineupItem[]): HTMLElement {
  /**
   * No heading and no total.
   *
   * *"What you are learning tonight"* sat directly above a list of what the
   * learner is learning tonight, and *"3 things, about 15 minutes in all"*
   * repeated the figure the hero's one surviving line already computes against
   * the chosen time. The list leads.
   */
  /** Affordances and accessible labels replace a separate instruction footer. */
  const node = el(`<div class="lineup">
    <ol class="lineup-list"></ol>
  </div>`);

  const list = node.querySelector('.lineup-list') as HTMLElement;
  const order = (): string[] => items.map((i) => i.topicId);

  /**
   * The row being dragged, held here rather than read back off the event.
   *
   * `dataTransfer` is the browser's channel and it is the right one to write
   * to, so a drop onto anything else in the page gets a topic id rather than
   * nothing. It is not the right one to READ from: it is absent on a drop the
   * panel constructed and it is not guaranteed readable outside a real drop
   * handler, and a reorder that silently did nothing would be indistinguishable
   * from one that failed.
   */
  let dragging: string | null = null;

  /** One order, one endpoint, both gestures. Repaints from the service. */
  const persist = async (
    next: readonly string[], row: HTMLElement, launcher: HTMLButtonElement | null = null,
  ): Promise<void> => {
    const said = row.querySelector('.lineup-said') as HTMLElement;
    const moves = Array.from(row.querySelectorAll('[data-move]')) as HTMLButtonElement[];
    row.setAttribute('aria-busy', 'true');
    for (const button of moves) button.disabled = true;
    said.textContent = LINEUP_ORDER_SAVING;
    const r = await api<{ ok: boolean; topicIds: string[] }>(
      `/sessions/${session.id}/sections/order`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topicIds: next }),
      });
    if (!r) {
      row.removeAttribute('aria-busy');
      for (const button of moves) button.disabled = false;
      said.textContent = LINEUP_NOT_SAVED;
      launcher?.focus();
      return;
    }
    await refreshLearnLineup(LINEUP_ORDER_SAVED);
  };

  for (const item of items) {
    /** Keep lesson controls on the lesson row; disclosures remain below it. */
    const row = el(`<li class="lineup-item" draggable="true" data-topic="${esc(item.topicId)}">
      <div class="lineup-what">
        <svg class="glyph grip" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${GLYPH.grip}</svg>
        <span class="register" data-register="${esc(item.register)}"></span>
        <button class="link lineup-open" data-open></button>
        <span class="lineup-minutes"></span>
        <button class="link lineup-course" data-course></button>
        <button class="link lineup-serves" data-serves></button>
        <span class="lineup-controls">
          ${iconButton(LINEUP_WHY_LABEL, GLYPH.why, 'data-why')}
          ${iconButton(LINEUP_GOOD_LABEL, GLYPH.good, 'data-call="good"')}
          ${iconButton(LINEUP_BAD_LABEL, GLYPH.bad, 'data-call="bad"')}
          ${iconButton(LINEUP_UP_LABEL, GLYPH.up, 'data-move="up"')}
          ${iconButton(LINEUP_DOWN_LABEL, GLYPH.down, 'data-move="down"')}
          ${iconButton(LINEUP_REMOVE_LABEL, GLYPH.remove, 'data-remove')}
        </span>
      </div>
      <p class="meta lineup-summary"></p>
      <p class="meta lineup-why"></p>
      <p class="meta lineup-said" role="status" aria-live="polite"></p>
    </li>`);

    const chip = row.querySelector('.register') as HTMLElement;
    if (item.register) {
      chip.textContent = item.registerLabel;
      // The level is the chip, and what the level MEANS is on the chip's own
      // title. The contract asks for the expected level to be shown; a
      // three-word register that a learner has to infer is shown, not said.
      chip.setAttribute('title', lineupLevelLine(item.register));
    } else chip.remove();
    /** Open this section without mutating the learner's resume point. */
    const open = row.querySelector('[data-open]') as HTMLButtonElement;
    open.textContent = item.subject;
    open.setAttribute('title', lineupOpenTitle(item.subject));
    open.addEventListener('click', () => openLesson(
      item.topicId, session, false, items.map((row) => row.topicId),
    ));

    (row.querySelector('.lineup-minutes') as HTMLElement).textContent = item.minutesLabel;

    /** Show a course door only when the stored topic-to-course link exists. */
    const course = row.querySelector('[data-course]') as HTMLButtonElement;
    if (item.course) {
      course.textContent = item.course.title;
      course.setAttribute('title', lineupCourseTitle(item.course.title));
      course.addEventListener('click', () => void renderCourses(item.course!.id));
    } else course.remove();

    /** Keep each linked commitment on the lesson row it describes. */
    const serves = row.querySelector('[data-serves]') as HTMLButtonElement;
    if (item.serves) {
      serves.textContent = item.serves.title;
      serves.setAttribute('title', lineupServesTitle(item.serves.title));
      serves.addEventListener('click', () => void renderPlan(item.serves!.id));
    } else serves.remove();

    // What is in it, in one sentence the Composer already wrote. Never a model
    // call, and never a placeholder where there is no sentence to take.
    const summary = row.querySelector('.lineup-summary') as HTMLElement;
    if (item.summary) summary.textContent = item.summary; else summary.remove();

    const why = row.querySelector('.lineup-why') as HTMLElement;
    const said = row.querySelector('.lineup-said') as HTMLElement;

    // (i) — the ranker's own sentence, disclosed in place. It writes nothing,
    // for the same reason the provenance tap writes nothing: a learner who is
    // scored for asking why stops asking why.
    const ask = row.querySelector('[data-why]') as HTMLButtonElement;
    ask.setAttribute('aria-expanded', 'false');
    ask.addEventListener('click', () => {
      const open = ask.getAttribute('aria-expanded') === 'true';
      ask.setAttribute('aria-expanded', open ? 'false' : 'true');
      why.textContent = open ? '' : [lineupWhyLine(item.why), lineupBuiltLine(item.sources)]
        .filter(Boolean).join(' ');
    });

    /** Choice verdicts influence ranking, not the learner's comfort model. */
    for (const call of ['good', 'bad'] as const) {
      const control = row.querySelector(`[data-call="${call}"]`) as HTMLButtonElement;
      control.setAttribute('aria-pressed', 'false');
      control.addEventListener('click', async () => {
        const verdicts = Array.from(row.querySelectorAll('[data-call]')) as HTMLButtonElement[];
        row.setAttribute('aria-busy', 'true');
        for (const button of verdicts) button.disabled = true;
        said.textContent = LINEUP_VERDICT_SAVING;
        const r = await api<{ ok: boolean; call: string }>(
          `/sessions/${session.id}/sections/${item.topicId}/verdict`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ call }),
          });
        row.removeAttribute('aria-busy');
        for (const button of verdicts) button.disabled = false;
        if (!r) {
          said.textContent = LINEUP_NOT_SAVED;
          control.focus();
          return;
        }
        // The mark the service recorded, which is not always the one this
        // button asked for: the pair is exclusive, so pressing one withdraws
        // the other, and the row reads back whichever one now stands.
        for (const other of ['good', 'bad'] as const) {
          const button = row.querySelector(`[data-call="${other}"]`);
          button?.setAttribute('aria-pressed', String(other === r.call));
        }
        said.textContent = lineupVerdictLine(r.call);
      });
    }

    for (const direction of ['up', 'down'] as const) {
      const control = row.querySelector(`[data-move="${direction}"]`) as HTMLButtonElement;
      const at = items.indexOf(item);
      const stuck = direction === 'up' ? at === 0 : at === items.length - 1;
      if (stuck) { control.remove(); continue; }
      control.addEventListener('click', async () => {
        await persist(moveInOrder(order(), item.topicId, direction), row, control);
      });
    }

    /**
     * The X. It takes the row out of tonight AND records the "not now", which
     * is why it is one request rather than two: a removal the ledger did not
     * hear about is a choice the next run makes all over again.
     */
    const remove = row.querySelector('[data-remove]') as HTMLButtonElement;
    remove.addEventListener('click', async () => {
      const controls = Array.from(row.querySelectorAll('.lineup-controls button')) as HTMLButtonElement[];
      row.setAttribute('aria-busy', 'true');
      for (const button of controls) button.disabled = true;
      said.textContent = LINEUP_REMOVE_SAVING;
      const r = await api<{ ok: boolean; backAfterDays: number; topicIds: string[] }>(
        `/sessions/${session.id}/sections/${item.topicId}/remove`, { method: 'POST' });
      if (!r) {
        row.removeAttribute('aria-busy');
        for (const button of controls) button.disabled = false;
        said.textContent = LINEUP_NOT_SAVED;
        remove.focus();
        return;
      }
      // The screen is redrawn rather than the row hidden: the lineup is
      // shorter, so the total, the hero's minutes and what `/today` ranks are
      // all different facts now, and hiding one row would leave the rest of the
      // screen describing an evening that no longer exists.
      void refreshLearnLineup(lineupRemovedLine(item.subject, r.backAfterDays));
    });

    // Drag and drop, on the page surface. The accessible controls above do the
    // same job on the same endpoint, which is what makes this an addition
    // rather than the only way to reorder.
    row.addEventListener('dragstart', (event) => {
      dragging = item.topicId;
      (event as DragEvent).dataTransfer?.setData('text/plain', item.topicId);
    });
    row.addEventListener('dragend', () => { dragging = null; });
    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (dragging && dragging !== item.topicId) row.classList.add('over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('over'));
    row.addEventListener('drop', async (event) => {
      event.preventDefault();
      row.classList.remove('over');
      const moved = dragging;
      dragging = null;
      if (!moved || moved === item.topicId) return;
      await persist(dropInOrder(order(), moved, item.topicId), row);
    });

    list.append(row);
  }
  return node;
}

/** The routes the Process strip has and does not know: it builds its own DOM
 *  and every door out of it is opened here. */
const PROCESS_BAR_SHELL = {
  api,
  onScreen: (node: HTMLElement) => onScreen(node),
  openLesson: () => void renderHome(null, { at: null, close: false }),
  openModels: () => void renderSettings('models', true),
  openStudies: () => void renderCourses(),
};

async function drawPinsFace(m: LearnMount): Promise<void> {
  const lessonRoute = async () => {
    const read = await apiResult<ModelConfigView>('/model-config');
    if (read.kind !== 'ok') return {
      label: 'Model connection', readiness: 'not-checked' as const,
    };
    const config = modelConfigFrom(read.body);
    const mode = config.routes.quick;
    return { label: MODEL_CONNECTION_LABEL[mode], readiness: config.providers[mode].readiness };
  };
  await mountPinsFace(m.pinsHost, {
    read: () => apiResult<PinsRead>('/pins?limit=80'),
    save: (body) => apiResult<{ id: string; label: string }>('/pins', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    remove: (pin) => apiResult<{ ok: boolean }>(
      `/pins/${encodeURIComponent(pin.id)}?keepTopic=true`, { method: 'DELETE' },
    ),
    addToBoard: (pin) => apiResult<{ ok: boolean; topicId: string; label: string }>(
      `/pins/${encodeURIComponent(pin.id)}/board`, { method: 'POST' },
    ),
    lessonRoute,
    openModels: () => { void openModelsPage(); },
    learn: (pin) => openTake(pin.id, pin.label, null, 'pins'),
    routes: (pin) => captureForwardRoutes(pin, pin.label),
    board: () => { void showFace('board'); },
  });
}

/** Draw the board with its own search and Process control. */
async function drawBoardFace(m: LearnMount): Promise<void> {
  const host = m.boardHost;
  const wait = thinking(LOADING_HOME);
  host.append(wait);
  const boardRead = await apiResult<{
    topics: Topic[]; suggestions: Suggestion[]; unfiled?: UnfiledPin[]; pinInbox?: boolean;
  }>('/board');
  const sessionRead = await apiResult<{
    session: Session | null; card: SessionCardView | null; upcoming?: UpcomingView[];
  }>('/session');

  const config = await readAuthConfig();
  if (config && [boardRead, sessionRead].some((read) =>
    read.kind === 'refused' && (read.status === 401 || read.status === 403))) {
    await signOut();
    return renderSignIn();
  }

  const board = boardRead.kind === 'ok' ? boardRead.body : null;
  const data = sessionRead.kind === 'ok' ? sessionRead.body : null;
  if (data?.upcoming) m.upcoming = data.upcoming;

  if (!board) {
    wait.remove();
    const line = boardRead.kind === 'refused'
      ? boardUnreadableLine('refused', boardRead.status)
      : boardUnreadableLine('unreachable', null);
    host.append(emptyLine(line));
    return;
  }

  // the reveal. A proposal the user confirms — never a silent write.
  // Older extension builds could observe the hosted Virgil page itself. Hide
  // those already-stored false positives as well as preventing new ones in the
  // worker; a product warning is interface chrome, not something the learner
  // came back to understand.
  const ownServiceOrigin = await serviceBase();
  const suggestions = (board.suggestions ?? []).filter((suggestion) => {
    try { return new URL(suggestion.url).origin !== ownServiceOrigin; }
    catch { return true; }
  });
  for (const s of suggestions) {
    const card = el(`<div class="suggestion">
      <div>${esc(s.reason)}</div>
      <blockquote>${esc(s.passage.slice(0, 240))}</blockquote>
      <div class="row"><button class="primary" data-add>Add it</button><button data-no>Not this</button></div>
      <p class="suggestion-status" role="status" aria-live="polite"></p>
    </div>`);
    const accept = card.querySelector('[data-add]') as HTMLButtonElement;
    const reject = card.querySelector('[data-no]') as HTMLButtonElement;
    const status = card.querySelector('.suggestion-status') as HTMLElement;
    const answer = async (
      button: HTMLButtonElement, verb: 'accept' | 'reject', pending: string, failed: string,
    ): Promise<boolean> => {
      accept.disabled = true;
      reject.disabled = true;
      status.textContent = pending;
      const result = await apiResult<{ ok: boolean }>(
        `/suggestions/${encodeURIComponent(s.id)}/${verb}`, { method: 'POST' },
      );
      if (await reopenSignInForExpiredIdentity(result, () => renderHome(null, null, 'board'))) {
        return false;
      }
      if (result.kind !== 'ok' || !result.body.ok) {
        status.textContent = failed;
        accept.disabled = false;
        reject.disabled = false;
        button.focus();
        return false;
      }
      return true;
    };
    accept.addEventListener('click', async () => {
      if (!await answer(accept, 'accept', 'Adding this to your board…',
        'That did not go through. The suggestion is still here.')) return;
      await redrawBoardFace();
      (m.toggle.querySelector('[data-face-key="board"]') as HTMLElement | null)?.focus();
    });
    reject.addEventListener('click', async () => {
      if (!await answer(reject, 'reject', 'Removing this suggestion…',
        'That did not go through. The suggestion is still here.')) return;
      prefsChanged();
      const next = card.nextElementSibling?.querySelector('button') as HTMLElement | null;
      card.remove();
      (next ?? m.toggle.querySelector('[data-face-key="board"]') as HTMLElement | null)?.focus();
    });
    host.append(card);
  }

  const inSession = new Set((data?.session?.sections ?? []).map((sec) => sec.topicId));
  const marks = await flaggedMarks(inSession);
  /**
   * What the night proposed and nobody has answered yet.
   *
   * Read here because the strip below says what is waiting, and three
   * suggestions sitting in My studies are waiting. A service too old to answer
   * `/prospects` returns nothing through `api`, which is zero proposals and the
   * board exactly as it was: a missing capability, not a fault.
   */
  const scouted = await api<{ proposals: ProspectProposalView[] }>('/prospects');
  // Tonight's lineup, from the session read this face already made. The mark on
  // a card and the lesson its title opens must be the same session or the board
  // would be telling the learner about a night the Learn face is not showing.
  const tonight = new Set(lineupItems(data?.session ?? null).map((item) => item.topicId));
  const pendingLessons = new Map<string, PendingBoardLesson>(upcomingItems(m.upcoming)
    .filter((item) => item.pinId && item.quickTakeMinutes)
    .map((item) => [item.topicId, {
      pinId: item.pinId as string,
      minutes: item.quickTakeMinutes as AvailableMinutes,
      heldBack: item.heldBack,
    }]));
  /** Face changes replace masthead search content without rebuilding the masthead. */
  const hasLearningMaterial = (board.topics ?? []).some((topic) => topic.pinIds.length > 0)
    || (board.unfiled ?? []).length > 0;
  const hasSettledLearning = (board.topics ?? []).some((topic) => topic.area
    ? topic.area === 'learnt' || topic.area === 'recharging'
    : topic.state === 'settled');
  const process = await processControl(
    PROCESS_BAR_SHELL,
    hasLearningMaterial,
    hasSettledLearning,
    boardWaiting(data?.card ?? null, data?.session ?? null, (scouted?.proposals ?? []).length),
  );
  wait.remove();
  m.boardSearch = await boardSurface(
    host, { ...board, unfiled: board.pinInbox ? [] : (board.unfiled ?? []) }, m.boardQuery, m.find, marks,
    process,
    tonight,
    pendingLessons,
  );

  // Rewards stay behind the work on the board surface.
  await paintStars(host);
}

/** Draw external handoffs, including the mixed-version unavailable state. */
async function drawExternalFace(m: LearnMount): Promise<void> {
  const host = m.externalHost;
  const wait = thinking(LOADING_HOME);
  // A return is a fresh queue, not another face below the cached one. Replacing
  // the host also makes the wait node a cheap generation token: if a second
  // return starts before this read finishes, only the newer wait remains.
  host.replaceChildren(wait);
  const read = await apiResult<{ entries: ExternalEntryView[] }>('/external');
  if (learnMount !== m || wait.parentElement !== host) return;

  host.replaceChildren(externalFace({
    el,
    entries: read.kind === 'ok' ? read.body.entries ?? [] : null,
    add: async (label, where) => {
      const made = await api<{ entry: ExternalEntryView }>('/external', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'manual', destination: 'manual', label, destinationSaid: where || null,
        }),
      });
      return made?.entry ?? null;
    },
    mark: (id, body) => api<ExternalMarkReply>(
      `/external/${encodeURIComponent(id)}/mark`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        ...body, availableMinutes: m.next?.availableMinutes ?? 3,
      }) },
    ),
    remove: async (id) => {
      const gone = await api<{ ok: boolean }>(
        `/external/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return gone?.ok === true;
    },
    /**
     * The insight door, and the same one the Insights room writes through.
     *
     * A note on a row is bookkeeping about one handoff. A sentence in the
     * learner model is read by every lesson after it, so turning one into the
     * other is a different act and gets the learner's own deliberate press.
     */
    keepInsight: async (text) => {
      const kept = await api<{ statement: unknown }>('/model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      return kept !== null;
    },
    seeNext: () => { void renderHome(null, null, 'learn', '', true); },
  }));
}

/**
 * The board face, drawn again after something changed it.
 *
 * Toggling between faces costs nothing — see `showFace` — because the face is
 * kept once it is built. That is only honest while the board it shows is still
 * the board that is there, so anything which mutates it comes through here.
 */
async function redrawBoardFace(said: string | null = null): Promise<void> {
  const m = learnMount;
  if (!m) return void renderHome(null, null, 'board');
  m.boardQuery = (m.boardSearch?.querySelector('.search') as HTMLInputElement | null)?.value
    ?? m.boardQuery;
  m.boardHost.replaceChildren();
  m.find.replaceChildren();
  m.boardSearch = null;
  await drawBoardFace(m);
  if (said && learnMount === m) {
    const receipt = el(`<p class="board-write-receipt" role="status" aria-live="polite"></p>`);
    receipt.textContent = said;
    m.boardHost.insertBefore(receipt, m.boardHost.children[0] ?? null);
  }
}

const openBoardFace = (): void => {
  if (learnMount) { void showFace('board'); return; }
  void renderHome(null, null, 'board');
};

function pausedBanner(prefs: PrefsView | null): HTMLElement | null {
  const now = Date.now();
  if (!isPausedNow(prefs, now)) return null;

  const node = el(`<div class="paused zone" data-zone="paused">
    <h2>${esc(pauseStateLine(prefs, now))}</h2>
    <div class="meta">${esc(pausedBannerNote())}</div>
    <div class="row"><button class="primary" data-resume>Start again now</button></div>
    <div class="note"></div>
  </div>`);

  const note = node.querySelector('.note') as HTMLElement;
  node.querySelector('[data-resume]')!.addEventListener('click', async () => {
    const r = await api<PrefsView>('/prefs', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pausedUntil: null }),
    });
    // A resume that did not land must not look like one that did — the learner
    // would walk away believing collection was back on. Same failure as the
    // pause it undoes, in the other direction.
    if (!r) { note.textContent = "That didn't go through. Nothing changed."; return; }
    prefsChanged();
    void renderHome();
  });
  return node;
}

/** Reviews learner-owned work without producing submittable replacement copy. */
async function renderCheck(): Promise<void> {
  frame('check', { title: CHECK_TITLE });
  roomContent.setAttribute('data-guide-target', 'manage-surface');
  roomContent.setAttribute('data-guide-section', 'manage-state');

  // Criteria choose rubric marking; without them the draft gets a broad review.
  // Explanation precedes controls and transient status in each input group.
  const form = el(checkFormHtml(VISION_UPLOAD_ACCEPT, UPLOAD_ACCEPT));
  const ta = form.querySelector('textarea.draft') as HTMLTextAreaElement;
  const rubric = form.querySelector('textarea.rubric') as HTMLTextAreaElement;
  const context = form.querySelector('textarea.context') as HTMLTextAreaElement;
  const editor = form.querySelector('.check-editor') as HTMLDetailsElement;
  const editorSummary = form.querySelector('.check-editor-summary') as HTMLElement;
  const readyLine = form.querySelector('.check-ready-line') as HTMLElement;
  const rubricOption = form.querySelector('[data-option="rubric"]') as HTMLDetailsElement;
  const contextOption = form.querySelector('[data-option="context"]') as HTMLDetailsElement;
  (form.querySelector('.draft-why') as HTMLElement).textContent = draftWhyLine();
  (form.querySelector('.rubric-why') as HTMLElement).textContent = rubricWhyLine();
  (form.querySelector('.context-why') as HTMLElement).textContent = contextWhyLine();
  const note = form.querySelector('.note') as HTMLElement;
  const btn = form.querySelector('[data-check]') as HTMLButtonElement;
  const handoffLines = form.querySelector('.check-handoff-lines') as HTMLElement;
  const fileBlockLine = form.querySelector('.check-file-block') as HTMLElement;
  const fileRecovery = form.querySelector('.check-file-recovery') as HTMLElement;
  const out = el(`<div class="findings" role="region" aria-label="Draft check result" tabindex="-1"></div>`);

  /**
   * Finish one check in the place the learner is already waiting.
   *
   * A result can be much taller than this panel. Moving focus to its named
   * region makes completion observable without announcing the entire answer,
   * and the return control at its foot avoids a long scroll back to the box
   * they actually need to revise.
   */
  const showCheckResult = (
    blocks: readonly HTMLElement[], failure: GuideFailure | null = null,
  ): void => {
    const back = el(`<div class="row check-return"></div>`);
    if (failure === 'budget' || failure === 'credential') {
      const models = el(`<button class="primary">Open Models</button>`) as HTMLButtonElement;
      // The refusal names an exact place to fix the connection. Make that
      // place the next press while leaving the draft in this room for the
      // learner's return; `openModelsPage` also preserves the side-panel/full-
      // page boundary used by every other model recovery.
      models.addEventListener('click', () => void openModelsPage());
      back.append(models);
    }
    const go = el(`<button class="link"></button>`) as HTMLButtonElement;
    go.textContent = BACK_TO_DRAFT;
    go.addEventListener('click', () => {
      form.setAttribute('data-phase', 'compose');
      editor.setAttribute('open', '');
      ta.focus();
    });
    back.append(go);
    out.replaceChildren(...blocks, back);
    out.removeAttribute('data-stale');
    out.setAttribute('aria-label', 'Draft check result');
    out.removeAttribute('aria-busy');
    form.setAttribute('data-phase', failure ? 'compose' : 'result');
    if (!failure) editor.removeAttribute('open');
    out.focus();
  };

  /**
   * The meter, which shows nothing until there is something to say.
   *
   * Length arithmetic on `input`, and nothing else: no request, no debounce, no
   * count under an empty box. A character counter that is always on turns a box
   * somebody is thinking in into a form with a limit, and this product counts
   * nothing it does not have to.
   *
   * The draft's cap is the one that moves — pasting criteria changes which
   * agent reads it and therefore how much of it is read — so both boxes repaint
   * whichever one was typed in.
   */
  let limits: CheckLimitsView = CHECK_LIMITS_FALLBACK;
  (form.querySelector('.rubric-limit') as HTMLElement).textContent = rubricLimitLine(limits);
  let deepWindow: number | null = null;
  let imagesWindow: number | null = null;
  let attached: {
    name: string; pages: readonly string[]; file: UploadFile; kind: PageInputFormat;
  } | null = null;
  type FileBox = 'draft' | 'rubric';
  type FileState = { readonly name: string; readonly phase: 'pending' | 'failed'; readonly line: string };
  const fileStates: Partial<Record<FileBox, FileState>> = {};
  const fileEpoch: Record<FileBox, number> = { draft: 0, rubric: 0 };
  let checkRunning = false;
  editor.querySelector('summary')!.addEventListener('click', (event) => {
    // The submitted snapshot stays visible while it is being read. Collapsing
    // it at that point would make the wait look detached from the work it owns.
    if (checkRunning) event.preventDefault();
  });
  const say = (host: HTMLElement, line: string | null): void => { host.textContent = line ?? ''; };
  const sizeNote = (box: string): HTMLElement =>
    form.querySelector(`.paste-box[data-box="${box}"] .size-note`) as HTMLElement;
  const windowNote = form.querySelector('.window-note') as HTMLElement;

  const paintReadiness = (): void => {
    const handoff = {
      draftChars: ta.value.length,
      draftReadyChars: ta.value.trim().length,
      rubric: rubric.value,
      contextChars: context.value.length,
      attachment: attached
        ? { name: attached.name, pages: attached.pages.length, kind: attached.kind }
        : null,
    };
    const lines = checkHandoffLines(handoff, limits);
    const readiness = checkReadinessLine(handoff, limits);
    readyLine.textContent = readiness;
    editorSummary.textContent = readiness;
    handoffLines.replaceChildren(...lines.map((line) => {
      const p = el(`<p></p>`);
      p.textContent = line;
      return p;
    }));

    const blocked = fileStates.draft ?? fileStates.rubric;
    fileBlockLine.textContent = blocked?.line ?? '';
    fileRecovery.replaceChildren();
    if (blocked?.phase === 'failed') {
      if (fileStates.rubric) rubricOption.setAttribute('open', '');
      const leave = el(`<button class="link"></button>`) as HTMLButtonElement;
      leave.textContent = LEAVE_FILE_OUT;
      const box: FileBox = fileStates.draft ? 'draft' : 'rubric';
      leave.addEventListener('click', () => {
        const state = fileStates[box];
        if (!state) return;
        fileEpoch[box] += 1;
        delete fileStates[box];
        if (box === 'rubric') transcribeOffer.replaceChildren();
        report(noteFor(box), fileLeftOutLine(state.name, box), false);
        paintReadiness();
        const next = fileRecovery.querySelector('button') as HTMLButtonElement | null;
        (next ?? btn).focus();
      });
      fileRecovery.append(leave);
    }
    btn.disabled = checkRunning || Boolean(fileStates.draft || fileStates.rubric)
      || checkMinimumShortfall(handoff, limits) > 0;
  };

  /**
   * One visible form is one submitted snapshot while its reader is working.
   *
   * Leaving the boxes live under `Reading…` let the handoff repaint from text
   * that was never in the already-issued request, so the eventual result could
   * appear to assess a different draft. Navigation remains available; only the
   * inputs that define this review are locked, then restored together.
   */
  const setCheckRunning = (running: boolean): void => {
    checkRunning = running;
    form.setAttribute('data-phase', running ? 'running' : 'compose');
    if (running) editor.setAttribute('open', '');
    for (const field of [ta, rubric, context]) field.disabled = running;
    for (const control of Array.from(form.querySelectorAll('[data-pick], input[data-file]'))) {
      (control as HTMLButtonElement | HTMLInputElement).disabled = running;
    }
    if (running) form.setAttribute('aria-busy', 'true');
    else form.removeAttribute('aria-busy');
    paintReadiness();
    btn.textContent = running ? 'Reading…' : 'Check it';
  };

  const meter = (): void => {
    const marked = !!rubric.value.trim();
    say(sizeNote('draft'), sizeWarningLine('draft', ta.value.length, draftCap(limits, marked)));
    say(sizeNote('rubric'), sizeWarningLine('rubric', rubric.value.length, rubricSoftCap(limits)));
    say(sizeNote('context'), sizeWarningLine('context', context.value.length, limits.contextChars));
    say(windowNote, windowWarningLine(
      ta.value.length + rubric.value.length + context.value.length,
      attached ? imagesWindow : deepWindow,
    ));
    paintReadiness();
  };
  const staleResult = (): void => {
    if (!out.children.length || out.getAttribute('aria-busy') === 'true'
      || out.getAttribute('data-stale') === 'yes') return;
    const stale = el(`<p class="meta check-stale" role="status"></p>`);
    stale.textContent = CHECK_RESULT_STALE;
    out.insertBefore(stale, out.children[0] ?? null);
    form.setAttribute('data-phase', 'compose');
    editor.setAttribute('open', '');
    out.setAttribute('data-stale', 'yes');
    out.setAttribute('aria-label', 'Previous draft check result');
  };
  for (const box of [ta, rubric, context]) {
    box.addEventListener('input', () => { meter(); staleResult(); });
  }

  /**
   * A file, read into the box the learner dropped it on.
   *
   * The whole of the trust rule is the last line of this function: the text
   * goes into the textarea, and nothing is sent. Messy input is proposed, never
   * imposed — they can read it, cut the bits the extractor mangled, and delete
   * the lot. Appended behind a blank line when the box already has something in
   * it, because a box that silently swallowed what somebody had typed would be
   * the same failure in the other direction.
   */
  const transcribeOffer = form.querySelector('.transcribe-offer') as HTMLElement;

  const noteFor = (box: 'draft' | 'rubric'): HTMLElement =>
    form.querySelector(`.paste-box[data-box="${box}"] .read-note`) as HTMLElement;

  /** Amber only when something was refused. A file that read fine is a status
   *  line, and colouring every one of them as a warning is how a colour that
   *  means "look at this" stops meaning anything. */
  const report = (host: HTMLElement, line: string, refused: boolean): void => {
    host.textContent = line;
    host.classList.toggle('refused', refused);
  };

  /**
   * A file operation is part of the pending submission from the moment the
   * learner chooses it. Check cannot race ahead with the previous box state,
   * and an older slow read cannot overwrite a newer file choice.
   */
  const beginFile = (box: FileBox, file: UploadFile): number => {
    const token = ++fileEpoch[box];
    fileStates[box] = { name: file.name, phase: 'pending', line: filePendingLine(file.name) };
    paintReadiness();
    return token;
  };
  const currentFile = (box: FileBox, token: number): boolean => fileEpoch[box] === token;
  const failFile = (box: FileBox, file: UploadFile, token: number): void => {
    if (!currentFile(box, token)) return;
    fileStates[box] = { name: file.name, phase: 'failed', line: fileBlockingLine(file.name) };
    paintReadiness();
  };
  const finishFile = (box: FileBox, token: number): boolean => {
    if (!currentFile(box, token)) return false;
    delete fileStates[box];
    paintReadiness();
    return true;
  };

  const readInto = async (box: 'draft' | 'rubric', file: UploadFile | null): Promise<void> => {
    if (!file) return;
    const token = beginFile(box, file);
    const target = box === 'draft' ? ta : rubric;
    const said = noteFor(box);
    report(said, READING_FILE, false);
    // Any offer on screen is about the LAST file, and a control that would
    // transcribe a document the learner has already replaced is worse than no
    // control at all: it lands somebody else's pages in the box they are about
    // to be marked against.
    if (box === 'rubric') transcribeOffer.replaceChildren();
    const outcome = await readUpload(file);
    if (!currentFile(box, token)) return;
    if (outcome.kind !== 'text') {
      // The criteria box has somewhere to go from here that the draft box does
      // not need: a scan cannot be split into rows, so the pages are read and
      // typed out instead. Offered rather than done.
      if (box === 'rubric' && outcome.kind === 'no-text' && outcome.format === 'pdf') {
        report(said, scannedRubricLine(file.name), true);
        failFile(box, file, token);
        offerTranscribe(file, token);
        return;
      }
      report(said, uploadOutcomeLine(outcome, file.name) ?? '', true);
      failFile(box, file, token);
      return;
    }
    if (!finishFile(box, token)) return;
    report(said, uploadOutcomeLine(outcome, file.name) ?? '', false);
    target.value = appendText(target.value,
      box === 'rubric' ? repairImportedRubric(outcome.text) : outcome.text);
    meter();
    staleResult();
  };

  /** Keep original pages as the default attachment; extracted text is optional. */
  const attachment = form.querySelector('.paste-box[data-box="draft"] .attachment') as HTMLElement;
  const paintAttachment = (): void => {
    if (!attached) { attachment.replaceChildren(); return; }
    const chip = el(`<div class="attached" data-pages="${attached.pages.length}">
      <span class="what"></span>
      <span class="meta note"></span>
      <div class="row">
        <button class="link" data-read-text></button>
        <button class="link" data-remove-file></button>
      </div>
    </div>`);
    (chip.querySelector('.what') as HTMLElement).textContent =
      attachedPagesLine(attached.name, attached.pages.length, attached.kind);
    (chip.querySelector('.note') as HTMLElement).textContent =
      attachedMeterNote(attached.pages.length, attached.kind);
    const readText = chip.querySelector('[data-read-text]') as HTMLButtonElement;
    const remove = chip.querySelector('[data-remove-file]') as HTMLButtonElement;
    remove.textContent = REMOVE_ATTACHMENT;

    if (attached.kind === 'pdf') {
      readText.textContent = READ_TEXT_INSTEAD;
      readText.addEventListener('click', () => { void readTextInstead(); });
    } else {
      readText.remove();
    }
    remove.addEventListener('click', () => {
      attached = null;
      paintAttachment();
      noteFor('draft').textContent = '';
      meter();
      staleResult();
    });
    attachment.replaceChildren(chip);
  };

  /**
   * What was here last time, put back before anything else touches the boxes.
   *
   * After `paintAttachment` because it draws the chip, and before the meter's
   * first reading because a restored draft is a draft the size note has an
   * opinion about. The memo is left in place rather than consumed: the room is
   * about to hand the shell a fresh one on the way out, and dropping it here
   * would lose the boxes if this render never finished.
   */
  if (CHECK_MEMORY) {
    ta.value = CHECK_MEMORY.draft;
    rubric.value = CHECK_MEMORY.rubric;
    context.value = CHECK_MEMORY.context;
    if (rubric.value.trim()) rubricOption.setAttribute('open', '');
    if (context.value.trim()) contextOption.setAttribute('open', '');
    attached = CHECK_MEMORY.attached;
    for (const box of ['draft', 'rubric'] as const) {
      const blocked = CHECK_MEMORY.fileBlocks?.[box];
      if (blocked) fileStates[box] = { ...blocked, phase: 'failed' };
    }
    paintAttachment();
    meter();
    staleResult();
  }
  rememberCheck = (): void => {
    CHECK_MEMORY = {
      draft: ta.value, rubric: rubric.value, context: context.value, attached,
      fileBlocks: Object.fromEntries((['draft', 'rubric'] as const)
        .flatMap((box) => fileStates[box]
          ? [[box, { name: fileStates[box]!.name, line: fileBlockingLine(fileStates[box]!.name) }]]
          : [])),
    };
  };

  const attachPages = async (file: UploadFile): Promise<void> => {
    const token = beginFile('draft', file);
    const said = noteFor('draft');
    report(said, RENDERING_PAGES, false);
    const outcome = await readPages(file);
    if (!currentFile('draft', token)) return;
    if (outcome.kind !== 'pages') {
      // Nothing is attached, and whatever was attached before stays where it
      // was: a failed second file must not silently take the first one away.
      report(said, pagesOutcomeLine(outcome, file.name) ?? '', true);
      failFile('draft', file, token);
      return;
    }
    if (!finishFile('draft', token)) return;
    const kind = pageFormatOf(file.name, file.type ?? '');
    if (!kind) {
      report(said, pagesOutcomeLine({ kind: 'unsupported' }, file.name) ?? '', true);
      failFile('draft', file, token);
      return;
    }
    attached = { name: file.name, pages: outcome.pages, file, kind };
    // The chip carries the sentence, so the status line has nothing left to
    // say and an empty one is one line less on a narrow screen.
    report(said, '', false);
    paintAttachment();
    meter();
  };

  /**
   * The other route, taken on purpose.
   *
   * The pages are thrown away only once there is text to replace them with. A
   * scan that yields nothing keeps its attachment rather than leaving somebody
   * with an empty box and no file, which is the one outcome this control could
   * produce that would be worse than not offering it.
   */
  const readTextInstead = async (): Promise<void> => {
    if (!attached || attached.kind !== 'pdf') return;
    const file = attached.file;
    const token = beginFile('draft', file);
    const said = noteFor('draft');
    report(said, READING_FILE, false);
    const outcome = await readUpload(file);
    if (!currentFile('draft', token)) return;
    if (outcome.kind !== 'text') {
      // The file remains complete and usable as its already-rendered pages.
      // This route failed, but no submission material disappeared.
      finishFile('draft', token);
      report(said, outcome.kind === 'no-text'
        ? noTextKeptPagesLine(file.name)
        : uploadOutcomeLine(outcome, file.name) ?? '', true);
      return;
    }
    if (!finishFile('draft', token)) return;
    attached = null;
    paintAttachment();
    report(said, uploadOutcomeLine(outcome, file.name) ?? '', false);
    ta.value = appendText(ta.value, outcome.text);
    meter();
    staleResult();
  };

  /**
   * The criteria box's own second route ( the criteria-extraction contract).
   *
   * A rubric never rides as pictures: the criteria are split in code, verbatim,
   * one row each, and every one of them gets a row in the mark whether the
   * model noticed it or not. That needs words. So a scanned rubric is offered a
   * transcription, which lands IN the box, editable, with a sentence telling
   * the learner to check it before anything is marked against it.
   */
  const offerTranscribe = (file: UploadFile, token: number): void => {
    const offer = el(`<div class="offer"><button class="link" data-transcribe></button></div>`);
    const go = offer.querySelector('[data-transcribe]') as HTMLButtonElement;
    go.textContent = TRANSCRIBE_ACTION;
    go.addEventListener('click', () => { void transcribe(file, go, token); });
    transcribeOffer.replaceChildren(offer);
  };

  const transcribe = async (file: UploadFile, go: HTMLButtonElement, token: number): Promise<void> => {
    if (!currentFile('rubric', token)) return;
    fileStates.rubric = { name: file.name, phase: 'pending', line: filePendingLine(file.name) };
    paintReadiness();
    const said = noteFor('rubric');
    go.disabled = true;
    report(said, TRANSCRIBING_PAGES, false);
    const rendered = await readPages(file);
    if (!currentFile('rubric', token)) return;
    if (rendered.kind !== 'pages') {
      go.disabled = false;
      report(said, pagesOutcomeLine(rendered, file.name) ?? '', true);
      failFile('rubric', file, token);
      return;
    }
    const r = await apiResult<TranscribeView>('/transcribe-pages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ media: rendered.pages }),
    });
    if (!currentFile('rubric', token)) return;
    go.disabled = false;
    // A request that never landed and a transcription that could not run are
    // the same fact to the learner: nothing went into the box. A budget stop is
    // NOT the same fact — it is a limit they set, with a control behind it —
    // and 402 is the only status in this service that means it.
    const outcome = r.kind === 'ok' ? String(r.body.outcome ?? '')
      : r.kind === 'refused' && r.status === 402 ? 'budget-stopped'
        : r.kind === 'refused' && r.status === 409 && r.stoppedBy === 'model-credential'
          ? 'credential-missing'
          : 'model-failed';
    const pages = r.kind === 'ok' ? Number(r.body.pageCount ?? rendered.pages.length) : rendered.pages.length;
    report(said, transcribeOutcomeLine(outcome, pages), outcome !== 'transcribed');
    if (r.kind !== 'ok') appendBudgetRecovery(said, r);
    if (outcome !== 'transcribed' || r.kind !== 'ok' || !r.body.text) {
      failFile('rubric', file, token);
      return;
    }
    if (!finishFile('rubric', token)) return;
    transcribeOffer.replaceChildren();
    rubric.value = appendText(rubric.value, repairImportedRubric(r.body.text));
    meter();
    staleResult();
  };

  for (const box of ['draft', 'rubric'] as const) {
    /**
     * Which of the two routes a file takes, decided by the box and the format.
     *
     * A PDF or screenshot on the draft box is attached as pictures. Everything
     * else is read into the box it landed on, which is what a.txt and a.docx
     * have always done and is the only thing they can do: nobody takes a.docx
     * natively, including the cloud provider this ships against, so there is
     * no as-is route to offer for one.
     */
    const handOver = (file: UploadFile | null): void => {
      if (!file || checkRunning) return;
      if (box === 'draft' && pageFormatOf(file.name, file.type ?? '')) {
        void attachPages(file);
        return;
      }
      void readInto(box, file);
    };

    const picker = form.querySelector(`input[data-file="${box}"]`) as HTMLInputElement;
    form.querySelector(`[data-pick="${box}"]`)!.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => {
      handOver(picker.files?.[0] ?? null);
      // So dropping the same file twice in a row is two reads rather than one.
      picker.value = '';
    });

    const target = box === 'draft' ? ta : rubric;
    const zone = form.querySelector(`.paste-box[data-box="${box}"]`) as HTMLElement;
    for (const kind of ['dragover', 'dragenter'] as const) {
      target.addEventListener(kind, (e: Event) => {
        // Without this the browser navigates the whole side panel to the file.
        e.preventDefault();
        zone.classList.add('over');
      });
    }
    for (const kind of ['dragleave', 'dragend'] as const) {
      target.addEventListener(kind, () => zone.classList.remove('over'));
    }
    target.addEventListener('drop', (e: Event) => {
      e.preventDefault();
      zone.classList.remove('over');
      if (checkRunning) return;
      handOver((e as DragEvent).dataTransfer?.files?.[0] ?? null);
    });
  }

  form.querySelector('[data-check]')!.addEventListener('click', async () => {
    if (fileStates.draft || fileStates.rubric) {
      note.textContent = 'Finish the file choice above, or leave that file out, before checking.';
      fileRecovery.querySelector('button')?.focus();
      return;
    }
    // An empty box with pages clipped to it is a complete submission, so the
    // refusal knows about the attachment rather than reading the textarea alone.
    const refusal = checkRefusal(ta.value, !!attached);
    if (refusal) { note.textContent = refusal; out.replaceChildren(); return; }
    const criteriaRefusal = rubricRefusal(rubric.value, limits);
    if (criteriaRefusal) {
      note.textContent = criteriaRefusal;
      out.replaceChildren();
      rubric.focus();
      return;
    }

    setCheckRunning(true);
    note.textContent = '';
    // A previous refusal is not the status of this request. Leaving it visible
    // beside “Reading…” tells the learner their corrected retry was rejected
    // while the model is in fact working.
    out.replaceChildren();
    out.removeAttribute('data-stale');
    out.setAttribute('aria-label', 'Draft check result');
    out.setAttribute('aria-busy', 'true');
    out.append(thinking(LOADING_CHECK, true));

    // Omitted rather than sent empty. The service treats `""`, `null` and an
    // absent field as the same thing, so this is about the request body being
    // the truth about what was asked rather than about the service's parser.
    const extra = context.value.trim() ? { context: context.value } : {};
    // The same rule for the pages: absent when there are none, rather than an
    // empty array claiming a file was considered.
    const pages = attached ? { media: attached.pages } : {};

    if (rubric.value.trim()) {
      const marked = await apiResult<MarkView>('/mark', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ work: ta.value, rubric: rubric.value, ...extra, ...pages }),
      });
      if (await reopenSignInForExpiredIdentity(marked, () => renderCheck())) return;
      setCheckRunning(false);
      showCheckResult(
        marked.kind === 'ok' ? markBlocks(marked.body, limits) : [unreadable(marked)],
        marked.kind === 'ok' ? null : failureOf(marked),
      );
      return;
    }

    const r = await apiResult<ReviewView>('/review', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: ta.value, ...extra, ...pages }),
    });
    if (await reopenSignInForExpiredIdentity(r, () => renderCheck())) return;
    setCheckRunning(false);

    // A request that never landed and a review that could not run are the same
    // fact to the learner, and both must read as the failure. The one sentence
    // this screen may never say about a check that did not happen is that
    // nothing was wrong. What has changed since that rule was written is that
    // the screen now says WHICH failure it was: a 401 is a service running
    // perfectly and refusing this panel, and telling somebody it could not be
    // reached sends them to look at their network for an hour.
    if (r.kind !== 'ok') { showCheckResult([unreadable(r)], failureOf(r)); return; }
    showCheckResult(reviewBlocks(r.body, limits));
  });

  const workspace = el(`<div class="check-workspace"></div>`);
  workspace.append(out, form);
  roomContent.append(workspace);

  /**
   * The two numbers the meter needs, asked for once per session.
   *
   * After the form is on screen, deliberately: the boxes are what the learner
   * came for and they must not wait on a receipt. The memo is module level and
   * the Settings screen clears it on every save, so a learner who repoints the
   * deep route at a local model does not keep a warning about Gemini's window.
   */
  const facts = await checkFacts();
  limits = facts.limits;
  (form.querySelector('.rubric-limit') as HTMLElement).textContent = rubricLimitLine(limits);
  deepWindow = facts.deepWindow;
  imagesWindow = facts.imagesWindow;
  meter();
}

/**
 * The service's own caps, and the window of whatever the deep route points at.
 *
 * Memoised for the life of the panel because it is a receipt rather than a
 * reading: the numbers change when somebody saves the Settings screen, and that
 * is the one place `checkFactsChanged` is called from. Re-fetching per render
 * would put a request on a screen whose whole claim is that opening it costs
 * nothing, in exchange for a freshness nothing needs.
 */
let CHECK_FACTS: {
  limits: CheckLimitsView; deepWindow: number | null; imagesWindow: number | null;
} | null = null;

const checkFactsChanged = (): void => { CHECK_FACTS = null; };

async function checkFacts(): Promise<{
  limits: CheckLimitsView; deepWindow: number | null; imagesWindow: number | null;
}> {
  if (CHECK_FACTS) return CHECK_FACTS;
  const raw = await api<ModelConfigView>('/model-config');
  // `modelConfigFrom` is the null-safe reader for the routing half, and a
  // receipt that did not arrive falls back to the shipped caps rather than to a
  // meter that has quietly stopped warning.
  const routes = modelConfigFrom(raw).routes;
  const windowFor = (route: 'deep' | 'images'): number | null => {
    const value = raw?.providers?.[routes[route]]?.models?.deep?.maxInputTokens;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  };
  CHECK_FACTS = {
    limits: checkLimitsFrom(raw?.limits),
    deepWindow: windowFor('deep'),
    imagesWindow: windowFor('images'),
  };
  return CHECK_FACTS;
}

/**
 * Which of the failures a non-answer was, for the screens that name them.
 *
 * 402 is the only route to that status in this service and it means one thing:
 * the learner's own spend limit stopped the call before it was sent. Every
 * other refusal sentence on those screens ends in "this is mine to fix, not
 * yours", which is false here twice over — nothing is broken, and the person
 * reading it is the only person who can change it.
 */
type Unreadable = Exclude<ApiResult<unknown>, { kind: 'ok' }>;

const failureOf = (r: Unreadable): GuideFailure =>
  r.kind === 'unreachable' ? 'unreachable'
    : r.status === 426 && r.stoppedBy === 'version-skew' && r.update === 'service'
      ? 'update-service'
      : r.status === 426 && r.stoppedBy === 'version-skew' && r.update === 'extension'
        ? 'update-extension'
    : r.status === 402 ? 'budget'
      // The second refusal that is not a fault. It is the connection's setup
      // rather than the learner's limit, and saying it in the budget's words
      // would send somebody to raise a number that is not the problem.
      : r.status === 409 && r.stoppedBy === 'model-credential' ? 'credential'
          : 'refused';

/**
 * Name the free work that can genuinely run after a 402, without moving it.
 *
 * Kept as a separate paragraph so every existing work-preservation sentence
 * remains exact. The server receipt is already in the refusal; this performs
 * no second read, no retry and no write. Older services omit it and receive the
 * explicit uncertainty branch from `budgetFreeRouteLine`.
 */
const appendBudgetRecovery = (host: HTMLElement, r: Unreadable): void => {
  if (failureOf(r) !== 'budget') return;
  const line = el(`<p class="meta budget-free-recovery"></p>`);
  line.textContent = budgetFreeRouteLine(r.kind === 'refused' ? r.freeConnections : undefined);
  host.append(line);
};

/** A check that did not happen, named. */
const unreadable = (r: Unreadable): HTMLElement => {
  const node = el(`<div class="meta failed"></div>`);
  node.textContent = r.kind === 'unreachable'
    ? checkUnreadableLine('unreachable', null)
    : checkUnreadableLine('refused', r.status, r);
  appendBudgetRecovery(node, r);
  return node;
};

/**
 * A review, as blocks.
 *
 * Three of these fields are new and two of them were being dropped on the
 * floor: `/review` cut a draft over the cap in silence, so "this reads sound"
 * could be a claim about the first four pages of eight, and a context line that
 * told the model what to conclude was held back with nothing on screen about
 * it. The Marker has said both of these since it was written; this is the same
 * fact, in the same words, on the other half of the same screen.
 */
function reviewBlocks(r: ReviewView, limits: CheckLimitsView): HTMLElement[] {
  const findings = r.findings ?? [];
  const blocks: HTMLElement[] = [
    el(`<div class="result-head review-head" data-outcome="${esc(r.outcome ?? 'model-failed')}">
      <p class="verdict">${esc(reviewSummary(r.outcome ?? 'model-failed', findings.length))}</p>
    </div>`),
  ];
  if (r.outcome === 'reviewed' || r.outcome === 'nothing-found') {
    const basis = reviewBasisLine(r.weakTopicCount);
    if (basis) blocks.push(el(`<div class="meta review-basis">${esc(basis)}</div>`));
  }
  blocks.push(...truncationBlocks(r.truncated === true, r.contextTruncated === true, limits, 'review'));
  blocks.push(...quarantineBlocks(r.quarantined));

  for (const finding of findings) {
    const topic = findingTopicLine(finding);
    const node = el(`<div class="finding">
      <blockquote>${esc(finding.quote)}</blockquote>
      <div>${esc(finding.problem)}</div>
      ${topic ? `<div class="meta">${esc(topic)}</div>` : ''}
      <div class="offer"></div>
    </div>`);
    offerFindingAsPin(node.querySelector('.offer') as HTMLElement, finding);
    blocks.push(node);
  }
  return blocks;
}

/**
 *  — the finding that has become a subject.
 *
 * The Ask room's pattern, and deliberately the same one: an offer line, one
 * control, and nothing happens until it is pressed. The learner-confirmation contract — a suggestion
 * the user confirms, never a silent write — matters more here than it does
 * there, because a review of a long essay can produce five findings at once and
 * a screen that filed all five would have made somebody's board about an
 * afternoon's proofreading.
 *
 * The finding carries no url, so the envelope is synthesised the way Ask's is:
 * what it is about, and the sentence it came out of as its surroundings.
 */
function offerFindingAsPin(host: HTMLElement, finding: FindingView): void {
  const offer = findingPinOffer(finding);
  const label = offer.label;

  const line = el(`<span class="meta"></span>`);
  line.textContent = offer.line;
  const put = el(`<button class="link"></button>`) as HTMLButtonElement;
  // This finding, not its temporary position or reusable label, owns the
  // receipt. Keep it in the mounted offer so an uncertain write retries the
  // same gesture and a later review cannot accidentally claim this pin.
  const findingClientRef = newClientRef();
  put.textContent = FINDING_PIN_ACTION;
  put.addEventListener('click', async () => {
    put.disabled = true;
    const made = await api<{ id: string }>('/pins', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // A finding is by construction the thing they did not get right.
        type: 'struggle',
        clientRef: findingClientRef,
        envelope: {
          selection: label, parts: [], surroundingText: finding.quote,
          // Not a page, and the envelope must not pretend it was one. The
          // service requires a non-empty url, and an opaque scheme is the
          // documented shape for "no site here" — `originOf` buckets it under
          // its own `url:` prefix rather than any real origin, and both deep
          // link builders answer null for it. `url: null` was tried first and
          // is a 400: the domain envelope's url is not nullable.
          headingPath: [], pageTitle: label, url: 'virgil:check-draft',
        },
      }),
    });
    if (!made) {
      // The button stays usable: a pin that did not land is a thing to try
      // again, not a thing to lose.
      put.disabled = false;
      line.textContent = FINDING_PIN_FAILED;
      put.focus();
      return;
    }
    put.remove();
    line.textContent = FINDING_PIN_DONE;
    const learn = el(`<button class="link"></button>`) as HTMLButtonElement;
    learn.textContent = FINDING_LEARN_ACTION;
    // A learner checking work is already in the moment of repair. Saving the
    // weakness for later must not be the end of the route when the exact-pin
    // lesson already exists; make it an explicit choice so a result with
    // several findings never yanks them away after the first save.
    learn.addEventListener('click', () => {
      void renderQuickTake(handoffFor(made.id, label, Date.now()));
    });
    host.append(learn);
  });
  host.append(line, put);
}

/** What was cut before anybody read it, on either endpoint. */
function truncationBlocks(
  truncated: boolean, contextTruncated: boolean, limits: CheckLimitsView, side: 'mark' | 'review',
): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (truncated) {
    const cut = el(`<p class="meta truncated"></p>`);
    cut.textContent = side === 'mark' ? markTruncatedLine() : reviewTruncatedLine();
    out.push(cut);
  }
  if (contextTruncated) {
    const cut = el(`<p class="meta truncated context-truncated"></p>`);
    cut.textContent = contextTruncatedLine(limits.contextChars);
    out.push(cut);
  }
  return out;
}

/**
 * A mark, as rows.
 *
 * The verdict is the service's, computed from the rows by a rule neither this
 * file nor the agent can reach into — **one miss is a send-back, and nothing
 * averages it away.** The screen states it and does not soften it: a piece of
 * work that fails a criterion is not "nearly there", and a product that says so
 * has told the learner the opposite of what the marker will.
 */
function markBlocks(m: MarkView | null, limits: CheckLimitsView): HTMLElement[] {
  // A request that never landed and a mark that could not run are the same fact
  // to the learner, and both read as the failure. The sentence this screen may
  // never say about a mark that did not happen is that nothing was wrong.
  if (!m || m.outcome === 'model-failed') {
    return [
      el(`<div class="meta">${esc(markFailedLine())}</div>`),
      ...quarantineBlocks(m?.quarantined),
    ];
  }
  // The two refusals happen before a model is called, and they still carry the
  // quarantine and truncation receipts: a brief that was cut at 4,000
  // characters was cut whether or not there turned out to be criteria in it.
  if (m.outcome === 'no-criteria') {
    return [
      el(`<div class="meta">${esc(m.summary)}</div>`),
      ...truncationBlocks(false, m.contextTruncated === true, limits, 'mark'),
      ...quarantineBlocks(m.quarantined),
    ];
  }
  if (m.outcome === 'too-short') {
    return [
      el(`<div class="meta">${esc(markTooShortLine())}</div>`),
      ...truncationBlocks(false, m.contextTruncated === true, limits, 'mark'),
      ...quarantineBlocks(m.quarantined),
    ];
  }

  const head = el(`<div class="result-head mark-head" data-verdict="${esc(m.verdict)}">
    <p class="verdict"></p>
    <p class="meta"></p>
  </div>`);
  (head.querySelector('.verdict') as HTMLElement).textContent = markVerdictLine(m.verdict);
  (head.querySelector('.meta') as HTMLElement).textContent = markSummaryDetail(m.verdict, m.summary);

  const rows = m.rows.map((r) => {
    const node = el(`<div class="criterion" data-verdict="${esc(r.verdict)}">
      <p class="what"></p>
      <p class="said"></p>
      <blockquote class="evidence"></blockquote>
      <p class="evidence-absence"></p>
      <p class="fix"></p>
      <p class="meta related"></p>
    </div>`);
    (node.querySelector('.what') as HTMLElement).textContent = r.criterion;
    (node.querySelector('.said') as HTMLElement).textContent = criterionVerdictLine(r.verdict);
    const ev = node.querySelector('.evidence') as HTMLElement;
    const absence = node.querySelector('.evidence-absence') as HTMLElement;
    if (r.evidenceKind === 'absence') {
      ev.remove();
      absence.textContent = r.evidence;
    } else {
      absence.remove();
      if (r.evidence && r.evidenceKind !== 'none') ev.textContent = r.evidence; else ev.remove();
    }
    const fix = node.querySelector('.fix') as HTMLElement;
    if (r.fix) fix.textContent = r.fix; else fix.remove();
    const related = node.querySelector('.related') as HTMLElement;
    // The half no generic checker can ship: this miss is the thing the board
    // already says you are shaky on.
    if (r.relatedTopicLabel) related.textContent = markRelatedLine(r.relatedTopicLabel);
    else related.remove();
    return { verdict: r.verdict, node };
  });

  const rowGroups = groupCheckCriteria(rows).map((group) => {
    const section = el(`<section class="criterion-group" data-group="${group.key}">
      <h2>${group.title}</h2><div class="criterion-rows"></div>
    </section>`);
    (section.querySelector('.criterion-rows') as HTMLElement)
      .append(...group.rows.map(({ node }) => node));
    return section;
  });

  const notes = truncationBlocks(m.truncated === true, m.contextTruncated === true, limits, 'mark');
  return [head, ...notes, ...quarantineBlocks(m.quarantined), ...rowGroups];
}

/**
 * What was held back out of the brief, and why. Never silently dropped.
 *
 * One block per box it came out of. There are two boxes that can carry an
 * instruction aimed at the model now, and a screen that told somebody to look
 * at their criteria for a line that was in their context would be sending them
 * to the wrong paste with a straight face.
 */
function quarantineBlocks(quarantined: readonly QuarantinedLineView[] | undefined): HTMLElement[] {
  return quarantineGroups(quarantined).map((group) => {
    const node = el(`<div class="quarantine" data-source="${esc(group.source)}">
      <p class="meta"></p>
      <div class="lines"></div>
    </div>`);
    (node.querySelector('.meta') as HTMLElement).textContent =
      quarantineLine(group.lines.length, group.source);
    const lines = node.querySelector('.lines') as HTMLElement;
    for (const q of group.lines) {
      const line = el(`<blockquote></blockquote>`);
      line.textContent = q.text;
      lines.append(line);
    }
    return node;
  });
}

/**
 * Zone 2 — the momentum strip. An echo of what session end already showed.
 *
 * The service caps it at three; this drops anything it cannot word, and renders
 * nothing at all when that leaves nothing. A strip is not owed a presence.
 */
function renderMomentum(
  into: HTMLElement, data: { strip: ProgressionEventView[] } | null,
): boolean {
  const lines = (data?.strip ?? []).map(momentumLine).filter((l): l is string => !!l);
  if (!lines.length) return false;

  into.append(el(`<div class="momentum zone" data-zone="momentum">
    <h2>${esc(MOMENTUM_HEADING)}</h2>
    ${lines.map((l) => `<div class="fact">${esc(l)}</div>`).join('')}
  </div>`));
  return true;
}

/**
 * What the learner asked to come back to — as a mark on the topic, not a list.
 *
 * A separate list would duplicate topics already present on the board, so this
 * returns the mark per topic id and
 * `topicCard` draws it under the card's own summary.
 *
 * The service's cap (`FLAGGED_ROWS`, four) is unchanged and still applies: it
 * is a cap on how many flags the product surfaces at once, and four cards
 * carrying a mark is what that now looks like. The "and N more" line went with
 * the list, because a remainder points at rows, and there are no rows.
 */
async function flaggedMarks(inSession: ReadonlySet<string>): Promise<ReadonlyMap<string, string>> {
  const data = await api<{ rows: FlaggedRowView[]; more: number }>('/flagged');
  const now = Date.now();
  const rows = (data?.rows ?? [])
    /**
     * Only the model's own observation stops repeating itself.
     *
     * The demo board put "Firestore Composite Indexes — you had this, and
     * something recent suggests it has slipped" in the session's reason and
     * then, four hundred pixels down, "Firestore Composite Indexes / you had
     * this and it has slipped" as a flagged row. One topic, one screen, the
     * same sentence twice.
     *
     * A `regression` row is the Gardener saying a topic slipped, which is
     * exactly what zone 1's why-line already says when that topic is the reason
     * for the session. **The learner's own marks are never dropped** — a
     * still-shaky tap or a resurface request is a thing they asked for, and
     * quietly removing it because the product happened to schedule the topic
     * would be answering a request by hiding it.
     */
    .filter((r) => !(r.source === 'regression' && inSession.has(r.topicId)));

  const marks = new Map<string, string>();
  for (const r of rows) {
    const line = flaggedLine(r, now);
    // First one wins: the rows arrive newest first, and a topic flagged twice
    // is one topic with the more recent reason on it.
    if (line && !marks.has(r.topicId)) marks.set(r.topicId, line);
  }
  return marks;
}

/**
 * Zone 4 — a door, not a view.
 *
 * §5 is a list of things this must not be: no thumbnails, no unread badges, no
 * pile preview. What is left is a search box, a count of topics, and a way in.
 * The search runs on the board screen — typing here and pressing the button
 * opens the board filtered, which is one screen fewer than opening it and
 * searching again.
 */
type SettingsTab = 'general' | 'models' | 'privacy' | 'connections' | 'data';

/**
 * What the learner may pick up, replay from and delete, without leaving.
 *
 * A resumed action exists because an expired sign-in interrupts a press: the
 * screen is redrawn behind the door and the thing they were doing is put back
 * in front of them rather than replayed at them.
 */
type DataResumeAction = 'download' | 'preview' | 'restore' | 'delete' | null;

const SETTINGS_TABS: readonly { key: SettingsTab; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'connections', label: 'Connections' },
  { key: 'privacy', label: 'Privacy' },
  // Last, because it is the section that ends in the one thing this product
  // cannot undo.
  { key: 'data', label: 'Your data' },
  { key: 'models', label: 'Advanced' },
];

function settingsFrame(active: SettingsTab, focusActive = false): HTMLElement {
  const route: MainPageRoute = active === 'general' ? 'settings' : active;
  frame('privacy', { title: 'Settings', route });
  const workspace = el(`<div class="settings-workspace"></div>`);
  const tabs = el(`<nav class="settings-tabs" aria-label="Settings sections"></nav>`);
  for (const tab of SETTINGS_TABS) {
    const button = el(`<button class="settings-tab"></button>`);
    button.textContent = tab.label;
    if (tab.key === active) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => void renderSettings(tab.key, true));
    tabs.append(button);
  }
  const board = el(`<section class="settings-subboard" data-settings-panel="${active}" data-guide-target="customize-settings" data-guide-section="settings-choice">
    <div class="settings-loading" role="status" aria-live="polite">
      <span aria-hidden="true"></span>Opening ${esc(SETTINGS_TABS.find((tab) => tab.key === active)?.label ?? 'settings')}…
    </div>
  </section>`);
  workspace.append(tabs, board);
  roomContent.append(workspace);
  if (focusActive) {
    const current = Array.from(tabs.querySelectorAll('button'))
      .find((button) => button.getAttribute('aria-current') === 'page') as HTMLElement | undefined;
    current?.focus();
  }
  return board;
}

/** One authority boundary for every learner preference write. A control stays
 * mounted while its request is pending or refused, all conflicting actions
 * are suppressed, and an expired identity opens the door without replaying
 * the write. Callers decide what confirmed service truth should redraw. */
async function preferenceWrite(
  owner: HTMLElement,
  button: HTMLButtonElement | HTMLSelectElement | HTMLInputElement,
  status: HTMLElement,
  patch: Partial<PrefsView>,
  pending: string,
  failed: string,
  resume: () => void | Promise<void>,
  controls: readonly (HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement | HTMLInputElement)[] = [button],
): Promise<PrefsView | null> {
  for (const control of controls) control.disabled = true;
  owner.setAttribute('aria-busy', 'true');
  status.textContent = pending;
  const result = await apiResult<PrefsView>('/prefs', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (await reopenSignInForExpiredIdentity(result, resume)) return null;
  if (result.kind !== 'ok') {
    owner.removeAttribute('aria-busy');
    for (const control of controls) control.disabled = false;
    status.textContent = failed;
    button.focus();
    return null;
  }
  owner.removeAttribute('aria-busy');
  for (const control of controls) control.disabled = false;
  prefsChanged();
  return result.body;
}

function appearanceSettings(): HTMLElement {
  const node = el(`<section class="settings-section appearance-setting">
    <div class="setting-kicker">Appearance</div>
    <h2>Boards</h2>
    <p class="setting-explain">Choose how the boards are lit.</p>
    <div class="setting-grid">
      <label class="setting-select"><span>Board theme</span><select data-theme>
        <option value="system">Match my system</option>
        <option value="light">Whiteboard</option>
        <option value="dark">Blackboard</option>
      </select></label>
    </div>
  </section>`);
  const theme = node.querySelector('[data-theme]') as HTMLSelectElement;
  theme.value = currentTheme;
  theme.addEventListener('change', () => {
    if (!isTheme(theme.value)) return;
    applyTheme(theme.value);
    void chrome.storage?.local?.set({ [THEME_KEY]: currentTheme }).catch(() => {});
  });
  return node;
}

function processingSettings(prefs: PrefsView): HTMLElement {
  const unavailable = prefs.automaticProcessing?.available === false;
  const paused = isPausedNow(prefs, Date.now());
  const node = el(`<section class="schedule settings-section">
    <div class="setting-kicker">Model work</div>
    <h2>${esc(AUTO_HEADING)}</h2>
    <p class="setting-explain">${unavailable
    ? 'This hosted installation has not connected its background worker yet. Your saved material is safe, but processing cannot be started here.'
    : paused
      ? 'Page activity is paused. You can start it again from Privacy.'
    : 'Choose whether Virgil waits for you to press Process or starts one batch after enough pinned things are waiting.'}</p>
    <div class="meta state"></div>
    <div class="row">
      <label class="setting-select"><span>When to process</span><select data-auto>${AUTO_CHOICES.map((choice) =>
    `<option value="${choice.value === null ? '' : String(choice.value)}">${esc(choice.label)}</option>`).join('')}</select></label>
    </div>
    <div class="note" role="status" aria-live="polite"></div>
  </section>`);
  const select = node.querySelector('[data-auto]') as HTMLSelectElement;
  const state = node.querySelector('.state') as HTMLElement;
  const note = node.querySelector('.note') as HTMLElement;
  if (unavailable) {
    select.disabled = true;
  }
  const show = (value: number | null): void => {
    state.textContent = autoStateLine(value);
    select.value = value === null ? '' : String(value);
  };
  show(AUTO_AFTER_DRAFT !== undefined
    ? autoThreshold(AUTO_AFTER_DRAFT)
    : autoThreshold(prefs.autoAfter ?? null));
  select.addEventListener('change', async () => {
    AUTO_AFTER_DRAFT = select.value === '' ? null : autoThreshold(Number(select.value));
    const next = select.value === '' ? null : Number(select.value);
    const receipt = await preferenceWrite(
      node, select, note, { autoAfter: next } as Partial<PrefsView>,
      'Saving when Virgil processes…', "That didn't go through. Nothing changed.",
      async () => {
        await renderSettings('general');
        (roomContent.querySelector('.schedule [data-auto]') as HTMLElement | null)?.focus();
      },
      [select],
    );
    if (!receipt) return;
    AUTO_AFTER_DRAFT = undefined;
    show(autoThreshold(receipt.autoAfter ?? null));
    note.textContent = 'Saved.';
  });
  node.append(prospectSettingRow(prefs.prospect !== false, async (next, control, status) => {
    const receipt = await preferenceWrite(node, control, status, { prospect: next } as Partial<PrefsView>,
      PROSPECT_SETTING_SAVING, PROSPECT_SETTING_FAILED,
      async () => { await renderSettings('general'); }, [control]);
    if (receipt) status.textContent = 'Saved.';
    return Boolean(receipt);
  }));
  return node;
}

const HOSTED_EXPERIMENT_REQUEST = 'virgil-hosted-experiment-v1';
const HOSTED_EXPERIMENT_REPLY = 'virgil-extension-experiment-v1';

type HostedExperimentReply = { ok: boolean; enabled: boolean };

/** The hosted Settings page asks the installed extension to read or change its
 * own local switch. The service page never receives extension storage access;
 * it gets one boolean receipt for one named preference. */
function hostedExperimentRequest(enabled?: boolean): Promise<HostedExperimentReply | null> {
  if (typeof window === 'undefined' || typeof window.postMessage !== 'function') {
    return Promise.resolve(null);
  }
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    let finished = false;
    const done = (reply: HostedExperimentReply | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      resolve(reply);
    };
    const receive = (event: MessageEvent): void => {
      const data = event.data as Record<string, unknown> | null;
      if (event.source !== window || event.origin !== location.origin
        || data?.source !== HOSTED_EXPERIMENT_REPLY || data.requestId !== requestId) return;
      done({ ok: data.ok === true, enabled: data.enabled === true });
    };
    const timer = setTimeout(() => done(null), 350);
    window.addEventListener('message', receive);
    window.postMessage({
      source: HOSTED_EXPERIMENT_REQUEST,
      requestId,
      kind: enabled === undefined ? 'read' : 'write',
      ...(enabled === undefined ? {} : { enabled }),
    }, location.origin);
  });
}

/** A browser-local escape hatch for contributors improving page extraction.
 * It appears only when the installed extension answers the hosted page, so a
 * web-only installation is not shown a control it cannot operate. */
async function mountExperimentalCaptureSettings(node: HTMLElement): Promise<void> {
  const initial = SURFACE === 'panel'
    ? await chrome.storage.local.get(EXPERIMENTAL_WHOLE_PAGE_KEY)
      .then((stored) => ({ ok: true, enabled: stored[EXPERIMENTAL_WHOLE_PAGE_KEY] === true }))
      .catch(() => null)
    : await hostedExperimentRequest();
  if (!initial?.ok) { node.remove(); return; }
  node.removeAttribute('hidden');
  node.className = 'settings-section experimental-capture-setting';
  node.innerHTML = `
    <div class="setting-kicker">Experimental</div>
    <h2>Whole-page capture</h2>
    <p class="setting-explain">Pages can include navigation, notices and other text you did not mean to save. Selected text and Pick what to pin are the reliable capture paths.</p>
    <label class="experimental-switch">
      <input type="checkbox" role="switch" data-whole-page${initial.enabled ? ' checked' : ''}>
      <span>Show “Pin the whole page” in the browser menu</span>
    </label>
    <div class="note" role="status" aria-live="polite"></div>
  `;
  const control = node.querySelector('[data-whole-page]') as HTMLInputElement;
  const status = node.querySelector('.note') as HTMLElement;
  control.addEventListener('change', async () => {
    const next = control.checked;
    control.disabled = true;
    node.setAttribute('aria-busy', 'true');
    status.textContent = 'Updating the browser menu…';
    try {
      const reply = SURFACE === 'panel'
        ? await chrome.storage.local.set({ [EXPERIMENTAL_WHOLE_PAGE_KEY]: next })
          .then(() => chrome.runtime.sendMessage({ kind: EXPERIMENTAL_CAPTURE_CHANGED })) as
            { ok?: boolean } | undefined
        : await hostedExperimentRequest(next);
      if (reply?.ok !== true) throw new Error('menu was not rebuilt');
      status.textContent = 'Saved. Your browser menu has been updated.';
    } catch {
      control.checked = !next;
      status.textContent = 'I could not update that setting. Nothing changed.';
      if (SURFACE === 'panel') {
        await chrome.storage.local.set({ [EXPERIMENTAL_WHOLE_PAGE_KEY]: !next }).catch(() => {});
      }
    } finally {
      control.disabled = false;
      node.removeAttribute('aria-busy');
    }
  });
}

function privacySettings(prefs: PrefsView): HTMLElement[] {
  const now = Date.now();
  const paused = isPausedNow(prefs, now);
  const activity = el(`<section class="settings-section activity-setting">
    <div class="setting-head">
      <div><div class="setting-kicker">Capture and suggestions</div><h2>Page activity</h2></div>
      <strong class="setting-status">${paused ? 'Paused' : 'On'}</strong>
    </div>
    <p class="setting-explain">Virgil notices when you return to the same material so it can suggest something worth pinning. That activity signal stays on this device unless a suggestion is raised.</p>
    <p class="setting-state-line">${esc(pauseStateLine(prefs, now))}</p>
    <p class="meta setting-pause-scope">${esc(PAUSE_SCOPE_LINE)}</p>
    <div class="setting-controls"><span class="setting-control-label">${paused ? 'Control' : 'Pause for'}</span><div class="row" data-choices></div></div>
    <div class="note" role="status" aria-live="polite"></div>
  </section>`);
  const choices = activity.querySelector('[data-choices]') as HTMLElement;
  const pauseNote = activity.querySelector('.note') as HTMLElement;
  const setPause = async (
    pausedUntil: string | null, choiceKey: string, button: HTMLButtonElement,
  ): Promise<void> => {
    const receipt = await preferenceWrite(
      activity, button, pauseNote, { pausedUntil },
      'Saving page activity…', "That didn't go through. Page activity has not changed.",
      async () => {
        await renderSettings('privacy');
        (roomContent.querySelector(`[data-pause-choice="${choiceKey}"]`) as HTMLElement | null)?.focus();
      },
      Array.from(choices.querySelectorAll('button')) as HTMLButtonElement[],
    );
    if (receipt) void renderSettings('privacy', true);
  };
  if (paused) {
    const resume = el(`<button class="primary" data-pause-choice="resume">Start again now</button>`) as HTMLButtonElement;
    resume.addEventListener('click', () => void setPause(null, 'resume', resume));
    choices.append(resume);
  } else {
    for (const choice of PAUSE_CHOICES) {
      const choiceKey = choice.minutes === null ? 'until-resumed' : String(choice.minutes);
      const button = el(`<button data-pause-choice="${choiceKey}">${esc(choice.label)}</button>`) as HTMLButtonElement;
      button.addEventListener('click', () => void setPause(
        pauseUntil(choice.minutes, Date.now()), choiceKey, button,
      ));
      choices.append(button);
    }
  }

  const lines = offLimitsLines();
  const excluded = el(`<section class="repair-choice settings-section excluded-setting">
    <div class="setting-kicker">Never observe</div>
    <h2>Excluded sites</h2>
    <p class="setting-explain">Add banking, health, work, or any other domains where Virgil should never observe page activity.</p>
    <label for="excluded-domains">Domains</label>
    <textarea id="excluded-domains" aria-label="Excluded domains" class="statement-edit domains"></textarea>
    <div class="row"><button data-save>Save</button></div>
    <div class="note" role="status" aria-live="polite"></div>
    ${lines.map((line) => `<div class="meta">${esc(line)}</div>`).join('')}
  </section>`);
  const textarea = excluded.querySelector('textarea') as HTMLTextAreaElement;
  textarea.value = EXCLUDED_DOMAINS_DRAFT ?? (prefs.excludedDomains ?? []).join('\n');
  textarea.addEventListener('input', () => { EXCLUDED_DOMAINS_DRAFT = textarea.value; });
  const note = excluded.querySelector('.note') as HTMLElement;
  const saveExcluded = excluded.querySelector('[data-save]') as HTMLButtonElement;
  saveExcluded.addEventListener('click', async () => {
    EXCLUDED_DOMAINS_DRAFT = textarea.value;
    const dropped = domainListNote(textarea.value);
    const excludedDomains = parseDomainList(textarea.value);
    const receipt = await preferenceWrite(
      excluded, saveExcluded, note, { excludedDomains },
      'Saving excluded sites…', "That didn't go through. Nothing changed.",
      async () => {
        await renderSettings('privacy');
        (roomContent.querySelector('.excluded-setting [data-save]') as HTMLElement | null)?.focus();
      },
      [saveExcluded, textarea],
    );
    if (!receipt) return;
    EXCLUDED_DOMAINS_DRAFT = null;
    textarea.value = (receipt.excludedDomains ?? []).join('\n');
    note.textContent = dropped ?? 'Saved.';
  });
  return [activity, excluded];
}

function connectionRow(label: string, state: string, detail: string, kind: 'good' | 'quiet' = 'quiet'): HTMLElement {
  const row = el(`<div class="connection-row" data-state="${kind}">
    <div><strong>${esc(label)}</strong><p>${esc(detail)}</p></div><span>${esc(state)}</span>
  </div>`);
  return row;
}

const MODEL_PROVIDER_COPY: Readonly<Record<ModelModeView, {
  label: string; meta: string; detail: string;
}>> = {
  cloud: {
    // The names come from the one table, so a refusal that says "Cloud/API" and
    // a settings card that says something else cannot happen.
    label: MODEL_CONNECTION_LABEL.cloud, meta: 'Google · Recommended',
    detail: "Google's hosted model connection and the recommended setup for most people.",
  },
  local: {
    label: MODEL_CONNECTION_LABEL.local, meta: 'Runs on your computer',
    detail: 'Use models served by your own computer or network.',
  },
  cli: {
    label: MODEL_CONNECTION_LABEL.cli, meta: 'Quick setup / testing',
    detail: "Connect an installed agent or harness for real model work. It is useful for quick setup and testing, but it is not Virgil's general default.",
  },
};

const MODEL_ROUTE_COPY: Readonly<Record<ModelRouteView, { label: string; detail: string }>> = {
  quick: { label: 'Quick tasks', detail: 'Naming and sorting what you pin.' },
  deep: { label: 'Deep tasks', detail: 'Lessons, course understanding and assignment review.' },
  images: { label: 'Images', detail: 'Reading diagrams and screenshots you capture.' },
};

type ModelRoutingDraft = {
  providers: Record<ModelModeView, {
    enabled: boolean; readiness: string; detail: string; endpoint: string;
    setup?: ModelProviderSetupView;
  }>;
  routes: Record<ModelRouteView, ModelModeView>;
};

const routingDraft = (config: NormalisedModelConfig): ModelRoutingDraft => ({
  providers: Object.fromEntries(MODEL_MODES.map((mode) => [mode, {
    ...config.providers[mode], endpoint: config.providers[mode].endpoint ?? '',
  }])) as ModelRoutingDraft['providers'],
  routes: { ...config.routes },
});

const readinessLabel = (mode: ModelModeView, state: string): string => {
  if (state === 'unreachable') return 'Unreachable';
  if (state === 'not-checked') return 'Not checked';
  if (state === 'needs-setup') return 'Needs setup';
  return mode === 'cloud' ? 'Configured' : 'Endpoint answered';
};

const modelRoutingShell = (): HTMLElement => el(`<section class="settings-section model-routing-settings">
  <div class="setting-kicker">Advanced</div>
  <h2>Model connection</h2>
  <p class="setting-explain">Virgil is already set up for normal learning. Change this only when you are deliberately running your own model service or testing a different route.</p>
  <div class="recommended-model">
    <div><strong>Recommended setup</strong><p>Google Gemini handles naming, lessons, marking and images. Other routes stay off.</p><small>Model work can use the service account's Google Cloud allowance. The usage guard below is a token backstop, not a currency bill.</small></div>
    <button data-recommended>Use recommended settings</button>
  </div>
  <div class="model-providers"><div class="model-primary-provider"></div></div>
  <details class="advanced-provider-settings">
    <summary>Other model connections and routing</summary>
    <p class="meta">These controls are for deliberate model-routing choices. Virgil never falls back to another provider.</p>
    <div class="model-other-providers"></div>
    <section class="model-route-settings">
      <div class="setting-kicker">Routing</div><h2>Assign work</h2><div class="model-route-list"></div>
    </section>
    <p class="model-route-summary" aria-live="polite"></p>
    <div class="model-actions"><button data-save-model>Save changes</button><p class="model-status" role="status" aria-live="polite"></p></div>
  </details>
</section>`);

const localModelSetup = (connector: boolean, paired = false): string => connector
  ? `<div class="model-setup-guide local-connector-setup">
      <strong>${paired ? 'This computer is connected' : 'Run Local on this computer'}</strong>
      <p>${paired ? 'Start the connector whenever you want Virgil to use this computer.' : 'Connect this account once, then run the connector from your Virgil folder.'} Virgil calls Ollama here; the hosted service never gets access to localhost.</p>
      <button data-pair-local>${paired ? 'Replace connection' : 'Connect this computer'}</button>
      <button class="link" data-unpair-local${paired ? '' : ' hidden'}>Disconnect</button>
      <div data-local-pair-receipt hidden><code data-local-command></code><button class="link" data-copy-local-command>Copy command</button></div>
      <small data-local-pair-status role="status" aria-live="polite"></small>
    </div>`
  : `<details class="model-setup-guide"><summary>Local setup</summary><code>ollama serve</code><code>ollama pull gemma4:12b-mlx</code><code>ollama pull qwen3.8:27b-mlx</code><code>ollama pull qwen3-vl:8b</code><code>ollama pull nomic-embed-text</code></details>`;

const wireLocalModelPairing = (section: HTMLElement, currentServiceBase: string): void => {
  const pair = section.querySelector('[data-pair-local]') as HTMLButtonElement | null;
  if (!pair) return;
  pair.addEventListener('click', async () => {
    const line = section.querySelector('[data-local-pair-status]') as HTMLElement;
    const receipt = section.querySelector('[data-local-pair-receipt]') as HTMLElement;
    const command = section.querySelector('[data-local-command]') as HTMLElement;
    pair.disabled = true; line.textContent = 'Connecting this computer…';
    const result = await apiResult<{ token: string }>('/local-connector/pair', { method: 'POST' });
    pair.disabled = false;
    if (result.kind !== 'ok') {
      line.textContent = result.kind === 'unreachable' ? 'Virgil could not be reached.' : 'Virgil could not create the local pairing.';
      return;
    }
    const run = `VIRGIL_SERVICE_URL='${currentServiceBase}' VIRGIL_CONNECTOR_TOKEN='${result.body.token}' npm run connector`;
    command.textContent = run; receipt.removeAttribute('hidden');
    pair.textContent = 'Replace connection';
    (section.querySelector('[data-unpair-local]') as HTMLButtonElement).removeAttribute('hidden');
    line.textContent = 'Connected until you disconnect it. Run this command from the Virgil folder, then use Check connection.';
    (receipt.querySelector('[data-copy-local-command]') as HTMLButtonElement).addEventListener('click', async () => {
      await navigator.clipboard.writeText(run);
      line.textContent = 'Command copied. This computer stays connected until you disconnect it.';
    }, { once: true });
  });
  const unpair = section.querySelector('[data-unpair-local]') as HTMLButtonElement | null;
  unpair?.addEventListener('click', async () => {
    if (unpair.dataset.confirm !== 'yes') {
      unpair.dataset.confirm = 'yes'; unpair.textContent = 'Disconnect this computer?'; return;
    }
    unpair.disabled = true;
    const result = await apiResult<{ disconnected: boolean }>('/local-connector/pair', { method: 'DELETE' });
    unpair.disabled = false;
    if (result.kind !== 'ok') {
      (section.querySelector('[data-local-pair-status]') as HTMLElement).textContent = 'Virgil could not disconnect this computer.'; return;
    }
    unpair.setAttribute('hidden', ''); pair.textContent = 'Connect this computer';
    (section.querySelector('[data-local-pair-receipt]') as HTMLElement).setAttribute('hidden', '');
    (section.querySelector('[data-local-pair-status]') as HTMLElement).textContent = 'This computer is disconnected.';
  });
};

/**
 * Models are a routing map, not one global radio. Provider switches say what
 * is available; the three native radio groups say which available provider
 * owns each kind of work. Nothing in this screen invents a fallback order.
 */
async function modelRoutingSettings(host: HTMLElement): Promise<void> {
  const [receipt, currentServiceBase] = await Promise.all([
    api<ModelConfigView>('/model-config'), serviceBase(),
  ]);
  if (!receipt) {
    host.replaceChildren(el(`<p class="empty">Virgil isn't responding, so no model connection is being claimed.</p>`));
    return;
  }
  host.replaceChildren();
  const receiptDraft = routingDraft(modelConfigFrom(receipt));
  let authoritative = routingDraft(modelConfigFrom(receipt));
  let draft: ModelRoutingDraft = MODEL_ROUTING_MEMORY ? {
    providers: Object.fromEntries(MODEL_MODES.map((mode) => [mode, {
      ...receiptDraft.providers[mode],
      enabled: MODEL_ROUTING_MEMORY!.providers[mode].enabled,
      endpoint: MODEL_ROUTING_MEMORY!.providers[mode].endpoint,
    }])) as ModelRoutingDraft['providers'],
    routes: { ...MODEL_ROUTING_MEMORY.routes },
  } : receiptDraft;
  const section = modelRoutingShell();
  const primaryProvider = section.querySelector('.model-primary-provider') as HTMLElement;
  const otherProviders = section.querySelector('.model-other-providers') as HTMLElement;
  for (const mode of MODEL_MODES) {
    const copy = MODEL_PROVIDER_COPY[mode];
    const provider = draft.providers[mode];
    const id = `model-${mode}-enabled`;
    const setup = provider.setup;
    const connectorSupported = mode === 'local' && setup?.connector === 'supported';
    const endpoint = mode === 'cloud' ? '' : `<label class="model-endpoint" data-endpoint-for="${mode}" for="${id}-endpoint"${connectorSupported ? ' hidden' : ''}>
      <span>${mode === 'local' ? 'Local endpoint' : 'Agent CLI endpoint'}</span>
      <input id="${id}-endpoint" type="url" value="${esc(provider.endpoint)}" inputmode="url" autocomplete="off" spellcheck="false"${mode === 'cli' ? ' readonly aria-readonly="true"' : ''}>
      <small>${mode === 'local'
    ? 'The Virgil service connects to this address. Credentials in the URL are refused.'
    : 'The service operator starts and configures this authenticated bridge. Virgil sends requests to it; Virgil never runs a shell command.'}</small>
    </label>`;
    const cloudSetup = mode === 'cloud' ? (setup?.editable
      ? `<div class="cloud-credential" data-cloud-credential>
          <label for="cloud-api-key"><span>Google Gemini API key</span><input id="cloud-api-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="Paste a key from Google AI Studio"></label>
          <div class="row"><button data-save-cloud-key>Save API key</button>${setup.credential === 'configured' ? '<button class="link" data-remove-cloud-key>Remove saved key</button>' : ''}</div>
          <small role="status" aria-live="polite">The key is stored by the local Virgil service, never on your board or returned to this browser.</small>
        </div>`
      : `<p class="model-setup-note">${setup?.managed
        ? 'The Google credential is managed by this Virgil service.'
        : 'This connection is managed outside Virgil and cannot be changed here.'}</p>`)
      : '';
    const setupGuide = mode === 'local'
      ? localModelSetup(connectorSupported, setup?.paired === true)
      : mode === 'cli'
        ? `<details class="model-setup-guide"><summary>Agent CLI setup</summary><p>Run the supplied bridge with the same service-owned token configured for Virgil.</p><code>SB_CLI_TOKEN='same-service-token' npm run cli:bridge</code></details>`
        : '';
    const agentWork = mode === 'cli' ? `<div class="agent-capabilities">
      <strong>Agent work</strong>
      <p>A connected agent can use its own computer tools to collect material, then hand bounded proposals to Virgil for review.</p>
      <ul>
        <li>Content extraction and bulk imports become drafts; never automatic course changes.</li>
        <li>Sorting returns a preview against existing board topics; never an automatic move.</li>
      </ul>
      <span>Capability endpoint</span><code>${esc(agentCapabilityUrl(currentServiceBase))}</code>
    </div>` : '';
    const card = el(`<section class="model-choice" data-model-choice="${mode}" data-model-provider="${mode}">
      <div class="model-choice-main">
        <div class="model-choice-copy"><h3>${esc(copy.label)}</h3><small>${esc(copy.meta)}</small></div>
        <label class="model-switch" for="${id}">
          <input id="${id}" type="checkbox" role="switch" name="model-provider" value="${mode}"${provider.enabled ? ' checked' : ''} aria-label="Turn ${esc(copy.label)} ${provider.enabled ? 'off' : 'on'}" aria-describedby="${id}-detail ${id}-readiness">
          <span data-switch-state>${provider.enabled ? 'On' : 'Off'}</span>
        </label>
        <span class="model-readiness" id="${id}-readiness" data-readiness="${esc(provider.readiness)}">${esc(readinessLabel(mode, provider.readiness))}</span>
      </div>
      <p id="${id}-detail">${esc(copy.detail)}</p>
      <p class="model-receipt-detail">${esc(provider.detail)}</p>
      ${cloudSetup}
      ${endpoint}
      ${setupGuide}
      <div class="model-connection-actions"><button data-check-provider="${mode}">Check connection</button><p class="model-check-status" role="status" aria-live="polite"></p></div>
      ${agentWork}
    </section>`);
    (mode === 'cloud' ? primaryProvider : otherProviders).append(card);
  }

  const routes = section.querySelector('.model-route-list') as HTMLElement;
  for (const route of MODEL_ROUTES) {
    routes.append(el(`<label class="model-route-row" for="model-route-${route}">
      <span><strong>${esc(MODEL_ROUTE_COPY[route].label)}</strong><small>${esc(MODEL_ROUTE_COPY[route].detail)}</small></span>
      <select id="model-route-${route}" data-model-route="${route}">
        ${MODEL_MODES.map((mode) => `<option value="${mode}">${esc(MODEL_PROVIDER_COPY[mode].label)}</option>`).join('')}
      </select>
    </label>`));
  }

  const status = section.querySelector('.model-status') as HTMLElement;
  const summary = section.querySelector('.model-route-summary') as HTMLElement;
  const save = section.querySelector('[data-save-model]') as HTMLButtonElement;
  const recommended = section.querySelector('[data-recommended]') as HTMLButtonElement;
  const recommendedBlock = section.querySelector('.recommended-model') as HTMLElement;
  const recommendedLabel = recommendedBlock.querySelector('strong') as HTMLElement;
  const switches = (): HTMLInputElement[] =>
    Array.from(section.querySelectorAll<HTMLInputElement>('input[name="model-provider"]'));
  const routeInputs = (): HTMLSelectElement[] =>
    Array.from(section.querySelectorAll<HTMLSelectElement>('select[data-model-route]'));
  const endpointInput = (mode: 'local' | 'cli'): HTMLInputElement =>
    section.querySelector(`[data-endpoint-for="${mode}"] input`) as HTMLInputElement;
  const sameDraft = (): boolean => JSON.stringify(draft) === JSON.stringify(authoritative);
  const rememberDraft = (): void => {
    MODEL_ROUTING_MEMORY = {
      providers: Object.fromEntries(MODEL_MODES.map((mode) => [mode, {
        ...draft.providers[mode],
      }])) as ModelRoutingDraft['providers'],
      routes: { ...draft.routes },
    };
  };
  const invalidRoutes = (): ModelRouteView[] => MODEL_ROUTES.filter((route) =>
    !draft.providers[draft.routes[route]].enabled);
  const recommendedActive = (): boolean => authoritative.providers.cloud.enabled
    && !authoritative.providers.local.enabled && !authoritative.providers.cli.enabled
    && MODEL_ROUTES.every((route) => authoritative.routes[route] === 'cloud');
  const applyDraft = (message?: string): void => {
    const currentRecommended = recommendedActive();
    recommended.hidden = currentRecommended;
    recommendedBlock.setAttribute('data-active', String(currentRecommended));
    recommendedLabel.textContent = currentRecommended ? 'Recommended setup active' : 'Recommended setup';
    for (const toggle of switches()) {
      const mode = toggle.value as ModelModeView;
      const on = draft.providers[mode].enabled;
      toggle.checked = on;
      toggle.setAttribute('aria-checked', String(on));
      toggle.setAttribute('aria-label', `Turn ${MODEL_PROVIDER_COPY[mode].label} ${on ? 'off' : 'on'}`);
      const card = section.querySelector(`[data-model-provider="${mode}"]`) as HTMLElement;
      card.setAttribute('data-enabled', String(on));
      (card.querySelector('[data-switch-state]') as HTMLElement).textContent = on ? 'On' : 'Off';
      const field = card.querySelector('.model-endpoint') as HTMLElement | null;
      if (field) {
        field.setAttribute('data-visible', 'true');
        (field.querySelector('input') as HTMLInputElement).disabled = false;
      }
    }
    for (const input of routeInputs()) {
      const route = input.getAttribute('data-model-route') as ModelRouteView;
      input.value = draft.routes[route];
      for (const option of Array.from(input.querySelectorAll('option'))) {
        option.disabled = !draft.providers[option.value as ModelModeView].enabled;
      }
      input.disabled = false;
    }
    const invalid = invalidRoutes();
    save.disabled = invalid.length > 0 || sameDraft();
    const mapLine = MODEL_ROUTES.map((route) =>
      `${MODEL_ROUTE_COPY[route].label.replace(' tasks', '')} · ${MODEL_PROVIDER_COPY[draft.routes[route]].label}`).join(' · ');
    const unusedLine = unusedModelProvidersLine(draft.providers, draft.routes);
    summary.textContent = unusedLine ? `${mapLine}. ${unusedLine}` : mapLine;
    if (message !== undefined) status.textContent = message;
    else if (invalid.length) {
      const route = invalid[0]!;
      status.textContent = `${MODEL_PROVIDER_COPY[draft.routes[route]].label} is still used for ${MODEL_ROUTE_COPY[route].label}. Move that work before turning it off.`;
    } else status.textContent = sameDraft() ? '' : 'Not saved.';
  };

  for (const toggle of switches()) {
    toggle.addEventListener('change', () => {
      const mode = toggle.value as ModelModeView;
      draft.providers[mode].enabled = toggle.checked;
      rememberDraft();
      applyDraft();
    });
  }
  for (const input of routeInputs()) {
    input.addEventListener('change', () => {
      const route = input.getAttribute('data-model-route') as ModelRouteView;
      const mode = input.value as ModelModeView;
      draft.routes[route] = mode;
      rememberDraft();
      applyDraft(`${MODEL_ROUTE_COPY[route].label} moved to ${MODEL_PROVIDER_COPY[mode].label}.`);
    });
  }
  for (const mode of ['local', 'cli'] as const) {
    endpointInput(mode).addEventListener('input', () => {
      draft.providers[mode].endpoint = endpointInput(mode).value;
      rememberDraft();
      applyDraft();
    });
  }

  for (const check of Array.from(section.querySelectorAll<HTMLButtonElement>('[data-check-provider]'))) {
    check.addEventListener('click', async () => {
      const mode = check.getAttribute('data-check-provider') as ModelModeView;
      const card = section.querySelector(`[data-model-provider="${mode}"]`) as HTMLElement;
      const line = card.querySelector('.model-check-status') as HTMLElement;
      check.disabled = true;
      line.textContent = 'Checking connection…';
      const result = await apiResult<{
        provider: ModelModeView; ok: boolean; status: string; detail: string;
      }>(`/model-connections/${mode}/check`, { method: 'POST' });
      check.disabled = false;
      if (result.kind === 'ok') {
        line.textContent = result.body.detail;
        const badge = card.querySelector('.model-readiness') as HTMLElement;
        badge.textContent = result.body.ok ? 'Connected' : result.body.status.replace(/-/g, ' ');
        badge.setAttribute('data-readiness', result.body.ok ? 'ready' : 'unreachable');
        return;
      }
      line.textContent = result.kind === 'unreachable'
        ? 'The Virgil service could not be reached.'
        : result.status === 401 || result.status === 403
          ? 'Virgil could not confirm your account. Sign in again before checking.'
          : 'The connection check did not complete.';
    });
  }

  wireLocalModelPairing(section, currentServiceBase);

  const cloudKey = section.querySelector('#cloud-api-key') as HTMLInputElement | null;
  const saveCloudKey = section.querySelector('[data-save-cloud-key]') as HTMLButtonElement | null;
  if (cloudKey) {
    cloudKey.value = CLOUD_KEY_DRAFT ?? '';
    cloudKey.addEventListener('input', () => { CLOUD_KEY_DRAFT = cloudKey.value; });
  }
  saveCloudKey?.addEventListener('click', async () => {
    const key = cloudKey?.value.trim() ?? '';
    const line = (section.querySelector('[data-cloud-credential] small') ?? status) as HTMLElement;
    if (key.length < 12) { line.textContent = 'Paste the complete Google Gemini API key.'; return; }
    saveCloudKey.disabled = true;
    line.textContent = 'Saving the key to the Virgil service…';
    const result = await apiResult<ModelConfigView>('/model-connections/cloud/credential', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: key }),
    });
    if (await reopenSignInForExpiredIdentity(result, async () => {
      await renderSettings('models');
      (roomContent.querySelector('[data-save-cloud-key]') as HTMLElement | null)?.focus();
    })) return;
    if (result.kind === 'ok') {
      CLOUD_KEY_DRAFT = null;
      if (cloudKey) cloudKey.value = '';
      await renderSettings('models', true);
      return;
    }
    saveCloudKey.disabled = false;
    saveCloudKey.focus();
    line.textContent = result.kind === 'unreachable'
      ? 'The Virgil service could not be reached.'
      : 'The service refused this key.';
  });
  const removeCloudKey = section.querySelector('[data-remove-cloud-key]') as HTMLButtonElement | null;
  const cloudActions = section.querySelector('[data-cloud-credential] .row') as HTMLElement | null;
  const cloudRouteNames = (map: ModelRoutingDraft): string[] => MODEL_ROUTES
    .filter((route) => map.routes[route] === 'cloud')
    .map((route) => MODEL_ROUTE_COPY[route].label);
  const listNames = (names: readonly string[]): string => names.length < 2
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const stoppedRouteLine = (map: ModelRoutingDraft, afterRemoval = false): string => {
    const names = cloudRouteNames(map);
    if (!names.length) return afterRemoval
      ? 'Saved key removed. No saved work route currently points to Cloud/API.'
      : 'No saved work route currently uses Cloud/API. Removing the key will leave this connection unavailable until you save another.';
    const verb = names.length === 1 ? 'is' : 'are';
    return afterRemoval
      ? `Saved key removed. ${listNames(names)} ${verb} still routed to Cloud/API and will stop until you save another key or move ${names.length === 1 ? 'that route' : 'those routes'}.`
      : `${listNames(names)} ${verb} routed here. ${names.length === 1 ? 'It' : 'They'} will stop until you save another key or move ${names.length === 1 ? 'that route' : 'those routes'}.`;
  };
  const openCloudKeyRemoval = (): void => {
    if (!removeCloudKey || !saveCloudKey || !cloudActions) return;
    CLOUD_KEY_REMOVE_CONFIRM = true;
    status.textContent = '';
    const confirm = el(`<div class="credential-remove-confirm repair-choice">
      <p class="bare">Remove the saved Cloud/API key?</p>
      <p class="impact"></p>
      <p class="meta">Your routing map, board, waiting captures and saved work stay exactly where they are. Virgil will not fall back to another provider.</p>
      <p class="draft-note" hidden></p>
      <div class="row"><button class="danger confirm">Remove key</button><button class="link keep">Keep key</button></div>
      <p class="note" role="status" aria-live="polite"></p>
    </div>`);
    (confirm.querySelector('.impact') as HTMLElement).textContent = stoppedRouteLine(authoritative);
    const draftNote = confirm.querySelector('.draft-note') as HTMLElement;
    if (!sameDraft()) {
      draftNote.removeAttribute('hidden');
      draftNote.textContent = 'Your unsaved routing changes are not active. The routes named above come from the saved map.';
    }
    const action = confirm.querySelector('.confirm') as HTMLButtonElement;
    const keep = confirm.querySelector('.keep') as HTMLButtonElement;
    const line = confirm.querySelector('[role="status"]') as HTMLElement;
    keep.addEventListener('click', () => {
      CLOUD_KEY_REMOVE_CONFIRM = false;
      cloudActions.replaceChildren(saveCloudKey, removeCloudKey);
      removeCloudKey.focus();
    });
    action.addEventListener('click', async () => {
      action.disabled = true; keep.disabled = true;
      confirm.setAttribute('aria-busy', 'true');
      line.textContent = 'Removing the saved key…';
      const result = await apiResult<ModelConfigView>(
        '/model-connections/cloud/credential', { method: 'DELETE' },
      );
      confirm.removeAttribute('aria-busy');
      if (result.kind === 'refused' && (result.status === 401 || result.status === 403)) {
        CLOUD_KEY_REMOVE_CONFIRM = true;
      }
      if (await reopenSignInForExpiredIdentity(result, () => renderSettings('models'))) return;
      if (result.kind !== 'ok') {
        action.disabled = false; keep.disabled = false;
        line.textContent = result.kind === 'unreachable'
          ? 'The Virgil service could not be reached. The saved key is still there.'
          : 'The saved key could not be removed. It is still there.';
        action.focus();
        return;
      }
      CLOUD_KEY_REMOVE_CONFIRM = false;
      CLOUD_KEY_REMOVE_NOTICE = `${stoppedRouteLine(routingDraft(modelConfigFrom(result.body)), true)}${
        sameDraft() ? '' : ' Your unsaved routing changes are still not active.'
      }`;
      await renderSettings('models');
    });
    cloudActions.replaceChildren(confirm);
    action.focus();
  };
  removeCloudKey?.addEventListener('click', openCloudKeyRemoval);

  const setBusy = (busy: boolean): void => {
    save.disabled = busy || invalidRoutes().length > 0 || sameDraft();
    recommended.disabled = busy;
    for (const input of [...switches(), ...routeInputs(), endpointInput('local'), endpointInput('cli')]) {
      input.disabled = busy;
    }
  };
  const accept = (next: ModelConfigView, message: string): void => {
    // The Check screen's meter is memoised off this same receipt, and the deep
    // route is exactly what this screen changes. Cleared here rather than
    // re-fetched per render: both PUTs on this screen funnel through here, so
    // this is the one place the numbers can go stale.
    checkFactsChanged();
    authoritative = routingDraft(modelConfigFrom(next));
    draft = routingDraft(modelConfigFrom(next));
    MODEL_ROUTING_MEMORY = null;
    endpointInput('local').value = draft.providers.local.endpoint;
    endpointInput('cli').value = draft.providers.cli.endpoint;
    setBusy(false);
    applyDraft(message);
  };

  save.addEventListener('click', async () => {
    if (invalidRoutes().length) { applyDraft(); return; }
    setBusy(true);
    status.textContent = 'Saving…';
    const next = await apiResult<ModelConfigView>('/model-config', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: {
          cloud: { enabled: draft.providers.cloud.enabled },
          local: { enabled: draft.providers.local.enabled, endpoint: draft.providers.local.endpoint.trim() },
          cli: { enabled: draft.providers.cli.enabled, endpoint: draft.providers.cli.endpoint.trim() },
        },
        routes: { ...draft.routes },
      }),
    });
    if (await reopenSignInForExpiredIdentity(next, async () => {
      await renderSettings('models');
      (roomContent.querySelector('[data-save-model]') as HTMLElement | null)?.focus();
    })) return;
    if (next.kind === 'ok') accept(next.body, 'Saved. New model work will follow this map.');
    else {
      setBusy(false);
      applyDraft("That didn't go through. Nothing changed.");
      save.focus();
    }
  });

  recommended.addEventListener('click', async () => {
    // Recommended is an immediate authority change, not a draft. A missing
    // Cloud credential would otherwise disable a working self-hosted route and
    // guarantee that the next model action stops. Keep the exact current map,
    // say what must happen first, and put the learner at that control.
    if (authoritative.providers.cloud.readiness !== 'ready') {
      status.textContent = 'Save a Google Gemini API key first. Your current model settings have not changed.';
      (cloudKey ?? recommended).focus();
      return;
    }
    setBusy(true);
    status.textContent = 'Saving…';
    const next = await apiResult<ModelConfigView>('/model-config', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preset: 'recommended' }),
    });
    if (await reopenSignInForExpiredIdentity(next, async () => {
      await renderSettings('models');
      (roomContent.querySelector('[data-recommended]') as HTMLElement | null)?.focus();
    })) return;
    if (next.kind === 'ok') accept(next.body, 'Recommended settings saved. New model work will use Cloud/API.');
    else {
      setBusy(false);
      applyDraft("That didn't go through. Nothing changed.");
      recommended.focus();
    }
  });

  applyDraft();
  host.append(section);
  if (CLOUD_KEY_REMOVE_CONFIRM && removeCloudKey) {
    openCloudKeyRemoval();
  } else if (CLOUD_KEY_REMOVE_NOTICE) {
    status.textContent = CLOUD_KEY_REMOVE_NOTICE;
    CLOUD_KEY_REMOVE_NOTICE = null;
    cloudKey?.focus();
  }
}

/**
 * The spend limit, on the tab where the spending is configured.
 *
 * Its own section under the routing map rather than a fifth tab, because the
 * decision it belongs beside is the one directly above it: that screen says
 * WHICH connection model work runs on, and this one says how much of it the
 * learner is willing to buy. Splitting them would put the limit two clicks from
 * the switch that decides whether the limit applies to anything at all.
 *
 * Everything here is drawn from one receipt. `PUT`, `DELETE` and the reset all
 * answer with the same shape `GET` does, so a change repaints from what the
 * service just said rather than from a second request or — worse — from what
 * this file assumed the change would do. A panel that drew "0 used" after a
 * reset it only hoped had happened is the failure that shape prevents.
 *
 * There is no bar and no percentage. See `panel-core.ts`.
 */
async function modelBudgetSettings(host: HTMLElement): Promise<void> {
  const first = await apiResult<ModelBudgetReceiptView>('/model-budget');
  if (first.kind !== 'ok') {
    const line = el(`<p class="empty budget-unreadable"></p>`);
    line.textContent = first.kind === 'unreachable' ? BUDGET_READ_UNREACHABLE : BUDGET_READ_REFUSED;
    host.append(line);
    return;
  }

  /**
   * The two ways out of a stopped budget are controls, not sentences.
   *
   * They were `class="link"`, which this stylesheet draws as 22px of underlined
   * text with no padding at all, while the harmless "Save the limit" beside
   * them is a real button. Sam, on a 1280x800 desktop: the click aimed at
   * "Start a new window" landed in the 34px of whitespace above it and fired no
   * request, with nothing on screen to say whether he had pressed anything.
   * The pair that wipes a ledger and disables a spending guard must not be the
   * smallest targets on the page.
   *
   * Not `.primary` either, and deliberately: neither of them is the thing
   * somebody came to this section to press, and an accent-coloured "Turn the
   * budget off" would be inviting the click it is trying to survive.
   */
  const section = el(`<section class="settings-section model-budget-settings">
    <div class="setting-kicker">${esc(BUDGET_KICKER)}</div>
    <h2>${esc(BUDGET_HEADING)}</h2>
    <p class="setting-explain">${esc(BUDGET_TOKENS_NOT_MONEY)}</p>
    <p class="setting-explain budget-guard">${esc(BUDGET_GUARD_LINE)}</p>
    <p class="budget-state"></p>
    <p class="budget-window"></p>
    <div class="budget-activity">
      <div class="setting-control-label">${esc(BUDGET_ACTIVITY_HEADING)}</div>
      ${MODEL_MODES.map((mode) => `<div class="budget-row" data-budget-connection="${mode}">
        <strong>${esc(MODEL_PROVIDER_COPY[mode].label)}</strong>
        <span class="budget-figures"></span>
        <p class="budget-unreturned"></p>
      </div>`).join('')}
      <p class="budget-total"></p>
    </div>
    <div class="budget-controls">
      <label class="budget-limit" for="model-budget-limit">
        <span>${esc(BUDGET_LIMIT_LABEL)}</span>
        <input id="model-budget-limit" type="number" inputmode="numeric" step="1"
          min="1" max="${MAX_BUDGET_TOKENS_VIEW}" autocomplete="off" spellcheck="false">
        <small>${esc(BUDGET_SAVE_NOTE)}</small>
      </label>
      <div class="row"><button data-save-budget>${esc(BUDGET_SAVE_ACTION)}</button></div>
      <div class="budget-action budget-reset">
        <div class="row"><button data-reset-budget>${esc(BUDGET_RESET_ACTION)}</button></div>
        <small>${esc(BUDGET_RESET_NOTE)}</small>
      </div>
      <div class="budget-action budget-clear">
        <div class="row"><button data-clear-budget>${esc(BUDGET_CLEAR_ACTION)}</button></div>
        <small>${esc(BUDGET_CLEAR_NOTE)}</small>
      </div>
      <p class="budget-status" role="status" aria-live="polite"></p>
    </div>
  </section>`);

  const limitField = section.querySelector('#model-budget-limit') as HTMLInputElement;
  const stateLine = section.querySelector('.budget-state') as HTMLElement;
  const windowLine = section.querySelector('.budget-window') as HTMLElement;
  const totalLine = section.querySelector('.budget-total') as HTMLElement;
  const status = section.querySelector('.budget-status') as HTMLElement;
  const clearBlock = section.querySelector('.budget-clear') as HTMLElement;
  const save = section.querySelector('[data-save-budget]') as HTMLButtonElement;
  const buttons = (): HTMLButtonElement[] =>
    Array.from(section.querySelectorAll<HTMLButtonElement>('.budget-controls button'));

  /**
   * The screen, from the receipt. Called on arrival and after every write, so
   * there is exactly one path from a number the service said to a number the
   * learner reads.
   */
  const paint = (reading: BudgetReading, message: string, preserveDraft = false): void => {
    section.setAttribute('data-budget-status', reading.status);
    stateLine.setAttribute('data-budget-status', reading.status);
    stateLine.textContent = budgetStatusLine(reading);
    windowLine.textContent = budgetWindowLine(reading.since, Date.now());
    for (const mode of MODEL_MODES) {
      const row = section.querySelector(`[data-budget-connection="${mode}"]`) as HTMLElement;
      const spend = reading.connections[mode];
      (row.querySelector('.budget-figures') as HTMLElement).textContent = budgetConnectionLine(spend);
      // Its own line, and only when there is one: a count of calls whose size
      // nobody knows is a fact, and an empty paragraph claiming one is not.
      (row.querySelector('.budget-unreturned') as HTMLElement).textContent =
        budgetIssuedLine(spend.issuedNotReturned) ?? '';
    }
    totalLine.textContent = budgetTotalLine(reading.totalTokens);
    // The field holds what is in force, so somebody raising a limit edits the
    // number they actually have rather than typing over a blank.
    limitField.value = preserveDraft && BUDGET_LIMIT_DRAFT !== null
      ? BUDGET_LIMIT_DRAFT
      : reading.learnerLimit === null ? '' : String(reading.learnerLimit);
    // A deployment ceiling is visible but is not the learner's to remove.
    clearBlock.setAttribute('data-visible', String(reading.learnerLimit !== null));
    status.textContent = message;
  };

  const busy = (on: boolean): void => {
    for (const b of buttons()) b.disabled = on;
    limitField.disabled = on;
    if (on) section.setAttribute('aria-busy', 'true');
    else section.removeAttribute('aria-busy');
  };

  /**
   * One write, one repaint, one sentence.
   *
   * Its own fetch rather than `apiResult`, and for one reason: `apiResult`
   * deliberately drops the body of a non-2xx, because every other screen in
   * this panel wants the KIND of failure and not the service's prose. The
   * budget endpoint is the exception — its 400s name the field that was wrong,
   * in words written to be read, and a panel that answered "refused" to a limit
   * one digit too long would be hiding the only sentence that helps. Nothing is
   * paraphrased: the service's own text goes on screen as it was written.
   *
   * Exactly one request per press, whatever the answer. A second read to
   * recover the sentence would re-send the write.
   */
  const write = async (
    action: 'save' | 'clear' | 'reset', button: HTMLButtonElement,
    init: RequestInit, done: string, path = '/model-budget',
  ): Promise<void> => {
    busy(true);
    status.textContent = 'Saving…';
    let answer: { ok: boolean; status: number; body: unknown } | null;
    try {
      const r = await serviceFetch(path, init);
      answer = { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
    } catch { answer = null; }
    busy(false);
    if (!answer) {
      status.textContent = BUDGET_WRITE_UNREACHABLE;
      button.focus();
      return;
    }
    if (answer.ok) {
      if (action === 'save') BUDGET_LIMIT_DRAFT = null;
      paint(budgetReadingFrom(answer.body as ModelBudgetReceiptView), done, action !== 'save');
      (action === 'clear' ? save : button).focus();
      return;
    }
    if (await reopenSignInForExpiredIdentity(
      { kind: 'refused', status: answer.status },
      async () => {
        await renderSettings('models');
        const retry = roomContent.querySelector<HTMLElement>(action === 'save' ? '[data-save-budget]'
          : action === 'clear' ? '[data-clear-budget]' : '[data-reset-budget]');
        retry?.focus();
      },
    )) return;
    const said = (answer.body as { error?: unknown } | null)?.error;
    status.textContent = typeof said === 'string' && said.trim() ? said : BUDGET_WRITE_REFUSED;
    button.focus();
  };

  limitField.addEventListener('input', () => { BUDGET_LIMIT_DRAFT = limitField.value; });
  save.addEventListener('click', () => {
    const refusal = budgetLimitRefusal(limitField.value);
    if (refusal) { status.textContent = refusal; save.focus(); return; }
    void write('save', save, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: Number(limitField.value.trim()) }),
    }, BUDGET_SAVED);
  });
  const clear = section.querySelector('[data-clear-budget]') as HTMLButtonElement;
  const reset = section.querySelector('[data-reset-budget]') as HTMLButtonElement;
  const armedBudgetActions = new Map<HTMLButtonElement, string>();
  const disarmBudgetActions = (): void => {
    for (const [control, original] of armedBudgetActions) {
      control.textContent = original;
      control.removeAttribute('data-confirming');
    }
    armedBudgetActions.clear();
  };
  const confirmBudgetAction = (
    button: HTMLButtonElement, confirmation: string, warning: string, action: () => void,
  ): void => {
    const original = button.textContent ?? '';
    button.addEventListener('click', () => {
      if (!armedBudgetActions.has(button)) {
        disarmBudgetActions();
        armedBudgetActions.set(button, original);
        button.textContent = confirmation;
        button.setAttribute('data-confirming', 'true');
        status.textContent = warning;
        return;
      }
      disarmBudgetActions();
      action();
    });
  };
  confirmBudgetAction(clear, 'Confirm remove',
    'This removes your limit. A service ceiling may remain; the recorded count will stay. Press again to confirm.', () => {
      void write('clear', clear, { method: 'DELETE' }, BUDGET_CLEARED);
    });
  confirmBudgetAction(reset, 'Confirm reset',
    'This sets the counted Cloud/API tokens back to zero without changing Google billing. Press again to confirm.', () => {
      void write('reset', reset, { method: 'POST' }, BUDGET_WINDOW_RESET, '/model-budget/reset');
    });

  paint(budgetReadingFrom(first.body), '', true);
  host.append(section);
}

async function connectionSettings(host: HTMLElement): Promise<void> {
  const [healthResult, config, session, modelsResult] = await Promise.all([
    apiResult<HealthView>('/health'), readAuthConfig(), readSession(),
    apiResult<ModelConfigView>('/model-config'),
  ]);
  const health = healthResult.kind === 'ok' ? healthResult.body : null;
  const models = modelsResult.kind === 'ok' ? modelsResult.body : null;
  const explicitUpdate = healthResult.kind === 'refused' && healthResult.status === 426
    && healthResult.stoppedBy === 'version-skew' ? healthResult.update : null;
  const serviceReached = health?.ok === true || explicitUpdate !== null;
  const compatibility: CompatibilityReading = explicitUpdate ? {
    status: explicitUpdate === 'service' ? 'update-service' : 'update-extension',
    label: explicitUpdate === 'service' ? 'Update Virgil' : 'Update the extension',
    detail: explicitUpdate === 'service'
      ? 'This Virgil installation is older than the extension. Update and restart Virgil.'
      : 'This extension is older than the Virgil installation. Update the extension.',
    blocking: true,
  } : compatibilityReading(health, models, CLIENT_SCHEMA_VERSION);
  SERVICE_COMPATIBILITY = compatibility;
  host.replaceChildren();
  const service = el(`<section class="settings-section connection-group"><div class="setting-kicker">Service</div><h2>Virgil service</h2></section>`);
  service.append(
    connectionRow('Service', serviceReached ? 'Connected' : 'Unavailable',
      serviceReached ? 'This browser can reach the Virgil service that holds your board.' : 'I could not check this connection just now.',
      serviceReached ? 'good' : 'quiet'),
    connectionRow('Compatibility', compatibility.label, compatibility.detail,
      compatibility.status === 'compatible' ? 'good' : 'quiet'),
  );

  const identity = el(`<section class="settings-section connection-group"><div class="setting-kicker">Account</div><h2>Virgil account</h2></section>`);
  if (!config) {
    identity.append(connectionRow('Sign in', 'Not available in this build', 'There is nothing for you to configure here.'));
  } else {
    identity.append(connectionRow('Virgil account', session ? 'Signed in' : 'Not signed in',
      session ? `${learnerLabel(session) ?? 'This account'} owns this Virgil board and learning history.`
        : 'Sign in to open your page and your board.', session ? 'good' : 'quiet'));
    if (!session) {
      const go = el(`<button class="primary">Sign in</button>`);
      go.addEventListener('click', () => focusAfterRoom(renderSignIn(), 'signin'));
      identity.append(go);
    }
  }

  host.append(identity);
  await driveSettings(host);
  host.append(service);
}

/**
 * THE DRIVE BLOCK — §7's setup, drawn once and then never needed again.
 *
 * `NOTEBOOK_SEAM_V2.md` §7. It lives under Connections rather than in a room of
 * its own because that is what it is: a connection between this learner's Google
 * account and this learner's own service, beside the page connection and account
 * ownership that are already reported here.
 *
 * **Absent is off, and off draws nothing.** A service with no Drive lane answers
 * 404, and this returns without appending a section, without a warning, and
 * without an empty heading. A capability this build does not have is not a
 * capability that failed, and a settings screen that showed a greyed-out Drive
 * block on every self-hosted install would be advertising an unmade choice as a
 * missing feature.
 *
 * **The screen does not move on until the documents exist.** §7 step 2: Virgil
 * makes the folder and writes the three documents before the learner is shown the
 * link, so nobody is handed a folder that is about to fill up later. The
 * service reports `waiting`, then `writing`, then `connected`, and this polls
 * rather than guessing, because the browser leaves for Google's consent screen
 * in the middle and comes back through a loopback port this page never sees.
 */
interface DriveStatusView {
  /** Whether this build has a Google sign in at all. It is the whole of what
   *  the screen needs: the two states are *there is one* and *there is not*,
   *  and which of the three places it came from is nobody's business here. */
  readonly client: { readonly configured: boolean; readonly source: string };
  readonly connection: { readonly connected: boolean; readonly connectedAt: string | null };
  readonly folder: { readonly link: string | null } | null;
  readonly connect: { readonly state: string; readonly detail: string };
  readonly documents: readonly { readonly key: string; readonly title: string }[];
  readonly lastWrite: {
    readonly line: string;
    readonly docs: readonly { readonly title: string; readonly written: boolean; readonly error: string | null }[];
  } | null;
}

/** How long to keep asking while an attempt is in flight. The consent window is
 *  five minutes and the service closes its listener at the end of it, so this
 *  stops where the service stops rather than at a number of its own. */
/**
 * Does this node still reach the panel root.
 *
 * Walked rather than asked, because a navigation in this panel replaces the
 * children of the ROOM, not of the block: the block's own parent is still its
 * parent, and that parent is the thing that was thrown away. A poll that only
 * checked its own parent would go on asking for ever, one request a second, at
 * a service the learner has walked away from.
 */
function onScreen(node: HTMLElement): boolean {
  // A panel document can be torn down while one of its timers is waiting. The
  // detached tree still reaches its old `app`, so ancestry alone would call it
  // live and let that old poll issue requests inside a replacement panel (and
  // in the test estate, inside the next learner story). Require the document's
  // current root as well as ancestry. Navigation within one panel keeps the
  // same root and is still handled by the walk below.
  if (typeof document === 'undefined' || document.getElementById('app') !== app) return false;
  for (let at: HTMLElement | null = node; at; at = at.parentElement) {
    if (at === app) return true;
  }
  return false;
}

const DRIVE_POLL_MS = 1200;
const DRIVE_POLL_LIMIT = 300;

async function driveSettings(host: HTMLElement): Promise<void> {
  if (await renderHostedDriveSettings(host)) return;
  const read = await apiResult<DriveStatusView>('/notebook/drive');
  // Not configured, not reachable, or refused: nothing is drawn either way. A
  // 404 here is a lane this build does not have.
  if (read.kind !== 'ok') return;

  const section = el(`<section class="settings-section connection-group drive-settings">
    <div class="setting-kicker"></div>
    <h2></h2>
    <div class="drive-state"><span class="drive-badge"></span><p class="drive-detail"></p></div>
    <div class="drive-copy"></div>
    <div class="drive-client"></div>
    <div class="row drive-actions"></div>
    <div class="drive-folder"></div>
    <div class="note drive-note" role="status" aria-live="polite"></div>
  </section>`);
  (section.querySelector('.setting-kicker') as HTMLElement).textContent = DRIVE_KICKER;
  (section.querySelector('h2') as HTMLElement).textContent = DRIVE_HEADING;
  host.append(section);

  const note = section.querySelector('.drive-note') as HTMLElement;
  let polls = 0;

  const paint = (status: DriveStatusView): void => {
    if (note.getAttribute('data-permission-fallback') === 'true'
      && status.connect.state !== 'waiting' && status.connect.state !== 'writing') {
      note.replaceChildren();
      note.removeAttribute('data-permission-fallback');
    }
    const hasClient = status.client.configured;
    const badge = section.querySelector('.drive-badge') as HTMLElement;
    badge.textContent = driveBadge(status.connection.connected, status.connect.state, hasClient);
    badge.setAttribute('data-state', status.connection.connected ? 'good' : 'quiet');
    const detail = section.querySelector('.drive-detail') as HTMLElement;
    detail.textContent = driveConnectLine(status.connect.state, status.connect.detail) ?? '';

    /* Builds without Google sign-in show no unusable credential fields. */
    const copy = section.querySelector('.drive-copy') as HTMLElement;
    copy.replaceChildren();
    if (hasClient) {
      for (const [cls, line] of [
        ['drive-value', DRIVE_VALUE_LINE],
        ['drive-notebook', DRIVE_NOTEBOOK_LINE],
        ['drive-consent', DRIVE_CONSENT_LINE],
        ['drive-local', DRIVE_LOCAL_LINE],
      ] as const) {
        copy.append(el(`<p class="setting-explain ${cls}">${esc(line)}</p>`));
      }
    }

    // ---- the one state that has copy of its own: no sign in at all
    const client = section.querySelector('.drive-client') as HTMLElement;
    client.replaceChildren();
    const clientLine = driveClientLine(hasClient);
    if (clientLine) client.append(el(`<p class="setting-explain">${esc(clientLine)}</p>`));

    // ---- the one action there is
    const actions = section.querySelector('.drive-actions') as HTMLElement;
    actions.replaceChildren();
    const busy = status.connect.state === 'waiting' || status.connect.state === 'writing';
    if (!status.connection.connected && hasClient) {
      const connect = el(`<button data-connect-drive>${esc(DRIVE_CONNECT_ACTION)}</button>`) as HTMLButtonElement;
      connect.disabled = busy;
      actions.append(connect);
      connect.addEventListener('click', async () => {
        connect.disabled = true;
        section.setAttribute('aria-busy', 'true');
        note.textContent = 'Opening Google permission…';
        const started = await apiResult<{ url: string }>('/notebook/drive/connect', { method: 'POST' });
        section.removeAttribute('aria-busy');
        if (await reopenSignInForExpiredIdentity(started, async () => {
          await renderSettings('connections');
          (roomContent.querySelector('[data-connect-drive]') as HTMLElement | null)?.focus();
        })) return;
        if (started.kind !== 'ok') {
          connect.disabled = false;
          note.textContent = started.kind === 'unreachable' ? DRIVE_UNREACHABLE : DRIVE_REFUSED;
          connect.focus();
          return;
        }
        note.textContent = '';
        // Google's own consent screen, in a tab of its own. The service is
        // already listening on a loopback port for the browser to come back.
        try {
          await openBrowserTab(started.body.url);
        } catch {
          const fallback = el(`<a target="_blank" rel="noreferrer"></a>`) as HTMLAnchorElement;
          fallback.textContent = DRIVE_OPEN_PERMISSION_ACTION;
          fallback.setAttribute('href', started.body.url);
          note.replaceChildren(el(`<span>${esc(DRIVE_PERMISSION_TAB_FAILED)} </span>`), fallback);
          note.setAttribute('data-permission-fallback', 'true');
          fallback.focus();
        }
        polls = 0;
        void poll();
      });
    }
    if (status.connection.connected) {
      const forget = el(`<button class="link" data-forget-drive>${esc(DRIVE_DISCONNECT_ACTION)}</button>`) as HTMLButtonElement;
      actions.append(forget);
      const openForget = (): void => {
        note.replaceChildren();
        const box = el(`<div class="confirm">
          ${driveForgetConfirmLines().map((line) => `<div>${esc(line)}</div>`).join('')}
          <div class="row"><button class="primary" data-go-drive-disconnect>Forget it</button><button class="link" data-cancel>Cancel</button></div>
          <p class="note" role="status" aria-live="polite"></p>
        </div>`);
        const go = box.querySelector('[data-go-drive-disconnect]') as HTMLButtonElement;
        const cancel = box.querySelector('[data-cancel]') as HTMLButtonElement;
        const resultLine = box.querySelector('[role="status"]') as HTMLElement;
        go.addEventListener('click', async () => {
          go.disabled = true;
          cancel.disabled = true;
          section.setAttribute('aria-busy', 'true');
          resultLine.textContent = 'Forgetting this connection…';
          const done = await apiResult<DriveStatusView>('/notebook/drive/disconnect', { method: 'POST' });
          section.removeAttribute('aria-busy');
          if (done.kind === 'refused' && (done.status === 401 || done.status === 403)) {
            DRIVE_DISCONNECT_CONFIRM = true;
          }
          if (await reopenSignInForExpiredIdentity(done, async () => {
            await renderSettings('connections');
          })) return;
          if (done.kind !== 'ok') {
            go.disabled = false;
            cancel.disabled = false;
            resultLine.textContent = done.kind === 'unreachable' ? DRIVE_UNREACHABLE : DRIVE_REFUSED;
            go.focus();
            return;
          }
          DRIVE_DISCONNECT_CONFIRM = false;
          note.replaceChildren();
          paint(done.body);
          (section.querySelector('[data-connect-drive]') as HTMLElement | null)?.focus();
        });
        cancel.addEventListener('click', () => {
          DRIVE_DISCONNECT_CONFIRM = false;
          note.replaceChildren();
          forget.focus();
        });
        note.append(box);
        go.focus();
      };
      forget.addEventListener('click', openForget);
      if (DRIVE_DISCONNECT_CONFIRM) {
        DRIVE_DISCONNECT_CONFIRM = false;
        openForget();
      }
    }

    // ---- the folder, the three titles, and the honest write report
    const folder = section.querySelector('.drive-folder') as HTMLElement;
    folder.replaceChildren();
    if (!status.connection.connected) return;
    if (status.folder?.link) {
      folder.append(el(`<p><a href="${esc(status.folder.link)}" target="_blank" rel="noreferrer">${esc(DRIVE_FOLDER_ACTION)}</a></p>`));
    }
    folder.append(el(`<p class="setting-explain">${esc(DRIVE_ADD_SOURCES_LINE)}</p>`));
    const list = el('<ul class="drive-documents"></ul>');
    for (const doc of status.documents) list.append(el(`<li>${esc(doc.title)}</li>`));
    folder.append(list);

    // §11: what Virgil last wrote, one row per document, and never a word about
    // what Google read out of that folder or when.
    if (!status.lastWrite) {
      folder.append(el(`<p class="meta">${esc(DRIVE_NOT_WRITTEN_YET)}</p>`));
      return;
    }
    folder.append(el(`<p class="meta drive-last-write">${esc(status.lastWrite.line)}</p>`));
    const rows = el('<ul class="drive-write-rows"></ul>');
    for (const doc of status.lastWrite.docs) {
      rows.append(el(`<li data-written="${doc.written ? 'yes' : 'no'}">${esc(driveDocRow(doc))}</li>`));
    }
    folder.append(rows);
  };

  const poll = async (): Promise<void> => {
    polls += 1;
    // Stop the moment this block is no longer on screen. A learner who walks
    // away mid-consent should not leave a request going to their own service
    // every second for the rest of the consent window, and a section that no
    // longer reaches the panel root is the honest signal that they did.
    if (polls > DRIVE_POLL_LIMIT || !onScreen(section)) return;
    const next = await apiResult<DriveStatusView>('/notebook/drive');
    if (!onScreen(section)) return;
    if (await reopenSignInForExpiredIdentity(next, async () => {
      await renderSettings('connections');
    })) return;
    if (next.kind !== 'ok') return;
    paint(next.body);
    if (next.body.connect.state === 'waiting' || next.body.connect.state === 'writing') {
      setTimeout(() => { void poll(); }, DRIVE_POLL_MS);
    }
  };

  paint(read.body);
  if (read.body.connect.state === 'waiting' || read.body.connect.state === 'writing') {
    setTimeout(() => { void poll(); }, DRIVE_POLL_MS);
  }
}

/** Show usage by source and in total; omit the section when unavailable. */
async function modelUsageSettings(host: HTMLElement): Promise<void> {
  const read = await apiResult<UsageReportView>('/usage');
  if (read.kind !== 'ok') return;
  const report = read.body;

  const section = el(`<section class="settings-section model-usage-settings">
    <div class="setting-kicker"></div>
    <h2></h2>
    <p class="setting-explain usage-since"></p>
    <div class="usage-rows">
      <div class="usage-row" data-usage-lane="taps"><strong></strong><span></span></div>
      <div class="usage-row" data-usage-lane="runs"><strong></strong><span></span></div>
      <div class="usage-row" data-usage-lane="setup"><strong></strong><span></span></div>
      <div class="usage-row usage-all" data-usage-lane="all"><strong></strong><span></span></div>
    </div>
    <p class="setting-explain usage-setup"></p>
    <p class="usage-embed"></p>
    <p class="setting-explain usage-bills"></p>
  </section>`);
  (section.querySelector('.setting-kicker') as HTMLElement).textContent = USAGE_KICKER;
  (section.querySelector('h2') as HTMLElement).textContent = USAGE_HEADING;
  (section.querySelector('.usage-since') as HTMLElement).textContent = USAGE_SINCE_LINE;

  const row = (lane: string, label: string, said: string): void => {
    const node = section.querySelector(`[data-usage-lane="${lane}"]`) as HTMLElement;
    (node.querySelector('strong') as HTMLElement).textContent = label;
    (node.querySelector('span') as HTMLElement).textContent = said;
  };
  row('taps', USAGE_TAPS_LABEL, usageCountLine(report.llm?.byLane?.taps));
  row('runs', USAGE_RUNS_LABEL, usageCountLine(report.llm?.byLane?.runs));
  row('setup', USAGE_SETUP_LABEL, usageCountLine(report.llm?.byLane?.setup));
  // The sum is the service's own, not this file's arithmetic over the two lines
  // above it. A total added up here could disagree with the one the endpoint
  // reports, and then there would be two answers to the question.
  row('all', USAGE_TOTAL_LABEL, usageCountLine(report.llm?.totals));
  (section.querySelector('.usage-setup') as HTMLElement).textContent = USAGE_SETUP_LINE;

  const embed = section.querySelector('.usage-embed') as HTMLElement;
  const embedLine = usageEmbedLine(report.embed?.totals);
  if (embedLine) embed.textContent = embedLine; else embed.remove();

  (section.querySelector('.usage-bills') as HTMLElement).textContent = USAGE_WHICH_BILLS;
  host.append(section);
}

async function renderSettings(
  active: SettingsTab = 'general',
  focusActive = false,
  resumeAction: DataResumeAction = null,
): Promise<void> {
  const subboard = settingsFrame(active, focusActive);
  if (active === 'data') {
    // Before the preferences read, like the two sections above it: what this
    // one draws comes from identity and from the two account endpoints, and a
    // service too old to answer `/prefs` must not cost somebody the way to
    // their own backup.
    await dataSettings(subboard, resumeAction);
    return;
  }
  if (active === 'models') {
    await modelRoutingSettings(subboard);
    // Under the routing map, on the same tab: spend belongs beside the
    // connections that spend it, and the limit is meaningless without knowing
    // which connection the work runs on.
    await modelBudgetSettings(subboard);
    // And under the limit, what the work actually was. The limit says which
    // connection may bill and how much is allowed; this says where the work
    // came from, which is the half a learner can change.
    await modelUsageSettings(subboard);
    return;
  }
  if (active === 'connections') {
    await connectionSettings(subboard);
    return;
  }
  const prefs = await api<PrefsView>('/prefs');
  if (!prefs) { subboard.replaceChildren(el(`<p class="empty">${esc(VIRGIL_UNAVAILABLE)}</p>`)); return; }
  if (active === 'privacy') {
    subboard.replaceChildren(...privacySettings(prefs));
    return;
  }
  const general = [appearanceSettings(), processingSettings(prefs)];
  const experimentSlot = el(`<section class="settings-section" hidden data-experiment-slot></section>`);
  general.push(experimentSlot);
  subboard.replaceChildren(...general);
  void mountExperimentalCaptureSettings(experimentSlot);
  await renderTenantSettings(subboard);
}

/**
 *  — the learner model, in sentences, editable.
 *
 * `GET/PUT/DELETE /model` have been tested since they were written and had no
 * screen, so the beat that converts a profile into a collaboration had nowhere
 * to happen. This is deliberately the plainest screen in the panel: no model
 * calls, no scores, no confidence, no ordering cleverness. What it thinks, in
 * the order it wrote it, and three things you can do about each line.
 */
async function renderModel(correctionSaved = false): Promise<void> {
  frame('model', { title: MODEL_PAGE_TITLE });
  const owner = roomOwnership();

  const [data, today, currentSession, scouted] = await Promise.all([
    api<{
      statements: InsightStatementView[];
      hasLearningMaterial?: boolean;
      slipping?: SlippingRowView[];
    }>('/model'),
    correctionSaved ? api<{ next: NextActionView }>('/today') : Promise.resolve(null),
    correctionSaved ? api<{ session: Session | null }>('/session') : Promise.resolve(null),
    /**
     * What the night proposed and nobody has answered yet.
     *
     * Read here because some of it stands on the sentences this room draws, and
     * a learner deciding whether a read of them is right should know that
     * something is already waiting on it. A service too old to answer
     * `/prospects` returns nothing through `api`, which is no proposals, no
     * lines and the room exactly as it was: a missing capability, not a fault.
     */
    api<{ proposals: ProspectProposalView[] }>('/prospects'),
  ]);
  if (!ownsRoom(owner)) return;
  if (!data) { owner.content.append(el(`<p class="empty">${esc(VIRGIL_UNAVAILABLE)}</p>`)); return; }
  const statements = data.statements ?? [];
  // Nothing at all when nothing is slipping: the block returns null and there
  // is no congratulation to put in its place. It is appended after the learner
  // model, where a deterministic work signal cannot displace the room's actual
  // purpose.
  const slipping = slippingSection(data.slipping ?? [], async (key) => {
    const answered = await api('/model/slipping/set-aside', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    return answered !== null;
  });
  const intro = el(`<p class="model-intro"></p>`);
  intro.textContent = MODEL_INTRO_LINE;
  if (correctionSaved) {
    const next = today?.next?.primary ?? null;
    const receipt = el(`<div class="zone model-correction-receipt" role="status">
      <p class="line"></p>
      <div class="model-next"><span class="label">Next</span><strong class="title"></strong><button class="link"></button></div>
    </div>`);
    (receipt.querySelector('.line') as HTMLElement).textContent = MODEL_CORRECTION_SAVED_LINE;
    const useButton = receipt.querySelector('button') as HTMLButtonElement;
    (receipt.querySelector('.title') as HTMLElement).textContent =
      next?.title ?? (data.hasLearningMaterial === false
        ? 'Add something to learn' : 'Choose what to learn next');
    useButton.textContent = next?.cta ?? 'Go to Learn';
    useButton.addEventListener('click', () => {
      if (!next || (next.destination === 'session' && !currentSession?.session)) {
        void renderHome();
        return;
      }
      openAction(next, currentSession?.session ?? null);
    });
    owner.content.append(receipt);
    // Save redraws the whole room, so the Save button no longer exists. Put
    // keyboard focus on the causal next action rather than dropping it onto the
    // document body after a successful correction.
    useButton.focus();
  }
  // Yes is its own door; no is the ordinary rejection, which also records the
  // learner's answer where the preferences door cannot reach it.
  const answerModality = async (id: string, confirmed: boolean): Promise<boolean> =>
    await api(`/model/${encodeURIComponent(id)}${confirmed ? '/confirm' : ''}`,
      { method: confirmed ? 'POST' : 'DELETE' }) !== null;
  const add = el(`<div class="model-add">
    <button data-add></button><div class="repair-form"></div>
  </div>`);
  const addButton = add.querySelector('[data-add]') as HTMLButtonElement;
  addButton.textContent = MODEL_ADD_ACTION;
  addButton.addEventListener('click', () => {
    add.classList.add('editing');
    addButton.setAttribute('hidden', '');
    addStatement(add.querySelector('.repair-form') as HTMLElement, addButton);
  });
  if (!statements.length) {
    owner.content.append(insightFirstUse(modelEmptyLine(), add));
    if (slipping) owner.content.append(slipping);
    return;
  }
  const lead = el(`<div class="model-lead"></div>`);
  lead.append(intro, add);
  owner.content.append(lead);

  /**
   * Which of these sentences already has something standing on it.
   *
   * Statement-level, because that is what the record actually holds: two of the
   * scout's six gap kinds are keyed to a statement id and the other four are
   * keyed to a signal, a topic, a concept or a plan item. Nothing is inferred
   * from a topic they happen to share, because a proposal about a topic is not
   * a proposal about a sentence.
   */
  const cited = statementsCitedByProposals(scouted?.proposals ?? []);

  /**
   * The room's own copy of what it drew, and the receipts it owes.
   *
   * A press that changes a row's standing moves it into a different section, so
   * the sections are repainted from `rows` rather than patched in place. What a
   * row has to SAY about the press outlives the node that was pressed, so it is
   * kept here by statement id and read back as the replacement row is built.
   */
  let rows: readonly InsightStatementView[] = statements;
  const receipts = new Map<string, string>();
  const sections = el(`<div class="insight-sections"></div>`);

  const statementRow = (s: InsightStatementView): HTMLElement => {
    // a modality read nobody has answered is a question, and it is the
    // only row on this screen with a different pair of controls. Once confirmed
    // it falls through and is drawn as the ordinary machine read it now is.
    if (s.modality && !s.modality.confirmed) return modalityQuestion(s, answerModality);
    const node = el(`<div class="statement" data-statement="${esc(s.id)}">
      <div class="text">${esc(s.text)}</div>
      <div class="state">${esc(statementBadge(s))}</div>
      <div class="row repair">
        <button class="link" data-edit></button>
        <button class="link" data-delete></button>
      </div>
      <div class="repair-form"></div>
      <p class="note" role="status" aria-live="polite"></p>
    </div>`);
    const host = node.querySelector('.repair-form') as HTMLElement;
    const note = node.querySelector('.note') as HTMLElement;
    const actions = node.querySelector('.repair') as HTMLElement;
    note.textContent = receipts.get(s.id) ?? '';

    if (!s.userEdited) node.insertBefore(statementEvidence(s), actions);
    if (cited.has(s.id)) {
      node.insertBefore(statementConsequence(() => void renderCourses()), actions);
    }

    const editButton = node.querySelector('[data-edit]') as HTMLButtonElement;
    editButton.textContent = statementEditAction(s.userEdited);
    editButton.setAttribute('aria-label', statementActionLabel(editButton.textContent, s.text));
    editButton.addEventListener('click', () => editStatement(host, s, editButton));
    const deleteButton = node.querySelector('[data-delete]') as HTMLButtonElement;
    deleteButton.textContent = statementDeleteAction(s.userEdited);
    deleteButton.setAttribute('aria-label', statementActionLabel(deleteButton.textContent, s.text));
    deleteButton.addEventListener('click', () => {
      // The confirmation owns this statement until Cancel, refusal or success.
      // Leaving the original row mounted produced two live Delete/Reject
      // controls with the same statement-qualified name. Remove both ordinary
      // actions rather than asking a visual or screen-reader user which one is
      // the irreversible step.
      const actionRow = node.querySelector('.repair') as HTMLElement;
      const restoreActionRow = (): void => {
        if (!actionRow.parentElement) node.insertBefore(actionRow, host);
      };
      actionRow.remove();
      const confirmAction = statementConfirmAction(s.userEdited);
      confirmStep(host, deleteStatementConfirmLines(s.userEdited), confirmAction, async () => {
        const r = await api(`/model/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
        if (!r) {
          restoreActionRow();
          const failure = el(`<p class="empty" role="alert" tabindex="-1">That didn't go through. Nothing changed.</p>`);
          host.replaceChildren(failure);
          failure.focus();
          return;
        }
        await renderModel();
      }, deleteButton, restoreActionRow);
      const confirmButton = host.querySelector('[data-go]') as HTMLButtonElement | null;
      confirmButton?.setAttribute('aria-label', statementActionLabel(confirmAction, s.text));
    });

    /**
     * THE THIRD ANSWER, AND THE ONE THIS ROOM DID NOT HAVE.
     *
     * A learner could rewrite a read of them or reject it, and could do nothing
     * at all about one that was simply right. So the honest answer to "yes,
     * that is me" was to retype Virgil's sentence in your own words, which
     * takes the authorship and loses the evidence receipt underneath it.
     *
     * It writes through the door  built and marks the row endorsed
     * without touching a character of it. Correct it and Reject it stay, and
     * this control goes, because it is the only one of the three that has
     * nothing left to say once it has been pressed.
     */
    if (!s.userEdited && !s.confirmed) {
      const confirm = el(`<button class="link" data-confirm></button>`) as HTMLButtonElement;
      confirm.textContent = STATEMENT_CONFIRM_ACTION;
      confirm.setAttribute('aria-label', statementActionLabel(STATEMENT_CONFIRM_ACTION, s.text));
      confirm.addEventListener('click', () => void (async () => {
        confirm.disabled = true;
        const answered = await api(`/model/${encodeURIComponent(s.id)}/confirm`, { method: 'POST' });
        if (answered === null) {
          confirm.disabled = false;
          note.textContent = STATEMENT_CONFIRM_FAILED;
          confirm.focus();
          return;
        }
        /**
         * The row moves, because what changed is where it belongs.
         *
         * Agreeing with a read makes it one of the things this person has
         * confirmed, and that is a section on this screen rather than a badge
         * on a card. The rest of the room is left alone — no reload, no scroll
         * to the top — and the row is followed: focus lands on the same row's
         * Correct it where it now sits, which is the control a learner who has
         * just agreed with something is next most likely to want.
         */
        rows = rows.map((item) => (item.id === s.id ? { ...item, confirmed: true } : item));
        receipts.set(s.id, STATEMENT_CONFIRMED_LINE);
        paintSections();
        // Found by walking rather than by a built selector: a statement id is
        // whatever the store minted, and an id with a quote in it would make a
        // selector string that either throws or matches the wrong row.
        const moved = Array.from(sections.querySelectorAll('[data-statement]'))
          .find((row) => (row as HTMLElement).dataset['statement'] === s.id);
        (moved?.querySelector('[data-edit]') as HTMLButtonElement | null)?.focus();
      })());
      actions.insertBefore(confirm, editButton);
    }
    return node;
  };

  /**
   * The five sections, drawn from `rows` and nothing else.
   *
   * A whole repaint of the section list rather than a surgical move, because a
   * row leaving one section can empty it, and an empty section is not drawn at
   * all. Working out which drawers that opens and shuts by hand is exactly the
   * kind of bookkeeping that goes wrong on the third case.
   */
  function paintSections(): void {
    sections.replaceChildren(...insightSections(rows, statementRow, {
      // Confirmed rows are the only passive section. Everything unanswered is
      // open on arrival; settled reads stay one explicit press away.
      open: (key) => INSIGHT_SECTION_CHOICES.get(key) ?? key !== 'confirmed',
      toggled: (key, open) => INSIGHT_SECTION_CHOICES.set(key, open),
    }));
  }
  paintSections();
  owner.content.append(sections);
  if (slipping) owner.content.append(slipping);
}

/** Start the learner model with the learner's own words. This is the same
 * authoritative, unscoped record a correction becomes; it merely removes the
 * requirement that Virgil make a guess before the learner is allowed to speak. */
function addStatement(host: HTMLElement, launcher: HTMLButtonElement): void {
  host.replaceChildren();
  const form = el(`<div class="repair-choice">
    <textarea class="statement-edit"></textarea>
    <p class="meta insight-limit"></p>
    <div class="row"><button data-save>Save</button><button class="link" data-cancel>Cancel</button></div>
    <div class="note" role="status" aria-live="polite"></div>
  </div>`);
  const ta = form.querySelector('textarea') as HTMLTextAreaElement;
  ta.setAttribute('aria-label', MODEL_ADD_LABEL);
  ta.setAttribute('placeholder', MODEL_ADD_PLACEHOLDER);
  (form.querySelector('.insight-limit') as HTMLElement).textContent = MODEL_INSIGHT_LIMIT_LINE;
  const note = form.querySelector('.note') as HTMLElement;
  const save = form.querySelector('[data-save]') as HTMLButtonElement;
  const cancel = form.querySelector('[data-cancel]') as HTMLButtonElement;
  const clientRef = newClientRef();
  const release = protectUnsentForm(
    form, 'new insight', [ta], () => host.replaceChildren(), () => ta.focus(),
  );
  cancel.addEventListener('click', () => {
    release();
    host.replaceChildren();
    launcher.removeAttribute('hidden');
    host.parentElement?.classList.remove('editing');
    launcher.focus();
  });
  save.addEventListener('click', async () => {
    const refusal = statementAddRefusal(ta.value);
    if (refusal) {
      note.textContent = refusal;
      if (Array.from(ta.value.trim()).length > LEARNER_STATEMENT_MAX_CHARS) ta.focus();
      else save.focus();
      return;
    }
    form.setAttribute('aria-busy', 'true');
    save.disabled = true;
    cancel.disabled = true;
    note.textContent = MODEL_WORDS_SAVING;
    const r = await apiResult('/model', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: ta.value.trim(), clientRef }),
    });
    if (r.kind !== 'ok') {
      form.removeAttribute('aria-busy');
      save.disabled = false;
      cancel.disabled = false;
      note.textContent = authoredWriteFailure(r, 'new insight');
      save.focus();
      return;
    }
    release();
    await renderModel(true);
  });
  host.append(form);
  ta.focus();
}

/** In place, prefilled with what it currently says. Correcting a sentence should
 *  feel like correcting a sentence, not like filling in a form about yourself. */
function editStatement(host: HTMLElement, s: StatementView, launcher: HTMLButtonElement): void {
  host.replaceChildren();
  const form = el(`<div class="repair-choice">
    <textarea class="statement-edit"></textarea>
    <p class="meta insight-limit"></p>
    <div class="row"><button data-save>Save</button><button class="link" data-cancel>Cancel</button></div>
    <div class="note" role="status" aria-live="polite"></div>
  </div>`);
  const ta = form.querySelector('textarea') as HTMLTextAreaElement;
  ta.value = s.text;
  ta.setAttribute('aria-label', statementEditLabel(s.userEdited));
  (form.querySelector('.insight-limit') as HTMLElement).textContent = MODEL_INSIGHT_LIMIT_LINE;
  const note = form.querySelector('.note') as HTMLElement;
  const save = form.querySelector('[data-save]') as HTMLButtonElement;
  const cancel = form.querySelector('[data-cancel]') as HTMLButtonElement;
  const syncSave = (): void => {
    const changed = statementEditChanged(ta.value, s.text);
    save.disabled = !changed;
    note.textContent = changed ? '' : statementEditNoChangeLine(s.userEdited);
  };
  ta.addEventListener('input', syncSave);
  syncSave();
  const release = protectUnsentForm(
    form, 'insight edit', [ta], () => host.replaceChildren(), () => ta.focus(),
  );
  cancel.addEventListener('click', () => {
    release();
    host.replaceChildren();
    launcher.focus();
  });
  save.addEventListener('click', async () => {
    if (!statementEditChanged(ta.value, s.text)) {
      note.textContent = statementEditNoChangeLine(s.userEdited);
      ta.focus();
      return;
    }
    const refusal = statementEditRefusal(ta.value);
    if (refusal) {
      note.textContent = refusal;
      if (Array.from(ta.value.trim()).length > LEARNER_STATEMENT_MAX_CHARS) ta.focus();
      else save.focus();
      return;
    }
    form.setAttribute('aria-busy', 'true');
    save.disabled = true;
    cancel.disabled = true;
    note.textContent = MODEL_WORDS_SAVING;
    const r = await apiResult(`/model/${encodeURIComponent(s.id)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: ta.value.trim() }),
    });
    if (r.kind !== 'ok') {
      form.removeAttribute('aria-busy');
      save.disabled = !statementEditChanged(ta.value, s.text);
      cancel.disabled = false;
      note.textContent = authoredWriteFailure(r, 'insight edit');
      if (save.disabled) ta.focus();
      else save.focus();
      return;
    }
    release();
    await renderModel(true);
  });
  host.append(form);
  ta.focus();
}

/**
 * Which session the recap has already been fetched for.
 *
 * The recap is the one thing on this surface that can cost a model call, and
 * Learn redraws on every move between lessons. Without this, walking a
 * six-lesson session would ask for a recap six times — of the same session, to
 * say the same two lines. It is a fact about arriving, so it is fetched once
 * per arrival and remembered by session id.
 */
let recapShownFor: string | null = null;

/** The lesson after this one, in order. A pager, not a completion tracker:
 *  moving on is not evidence and marks nothing. */
const afterInOrder = (session: Session, index: number): Section | null =>
  session.sections[index + 1] ?? null;

/** Open a lesson without leaving Learn. Every entry point into learning goes
 *  through here, so there is one answer to "where does a lesson open". */
/**
 * Open a lesson without leaving Learn, and without rebuilding it.
 *
 * When the room is already mounted this is a swap: two columns of content
 * replaced, nothing above them touched. Otherwise the learner is arriving from
 * somewhere else and the room is built first, which is the one case where a
 * page rebuild is what actually happened.
 */
/**
 * A topic on the board that has a lesson in the current session IS that lesson,
 * so pressing it swaps to the Learn face and opens it — the same
 * `{at: topicId}` the lineup's own control sends, through the same face
 * machinery. Only when the topic has no lesson tonight does the card keep its
 * other job, opening onto the pins inside it: sending a Learnt topic to a
 * lesson it is not in would open whatever lesson happened to be owed, which is
 * a worse lie than a disclosure.
 */
const lessonOnBoard = (topicId: string): boolean => {
  const m = learnMount;
  if (!m?.session?.sections?.some((s) => s.topicId === topicId)) return false;
  void showFace('learn', { at: topicId, close: false });
  return true;
};

const openLesson = (
  at: string | null,
  from: Session | null,
  close = false,
  topicIds: readonly string[] | null = learnMount?.state?.topicIds ?? null,
): void => {
  if (learnMount) {
    // A terminal action has just re-read the session to find out what its own
    // write did. That reading is the one the columns repaint from.
    if (from) learnMount.session = from;
    void paintLearn({ at, close, topicIds });
    return;
  }
  void renderHome(null, { at, close, topicIds });
};

/** There was a `showLineup` here — back to the lineup in place, for anything
 *  inside the room that needed it. Nothing ever did: the Learn door in the nav
 *  is how a learner leaves a lesson, and it is the only way anyone asked for. */

/**
 * Every door a lesson has, handed to the module that draws one.
 *
 * `lesson.ts` builds both sides of a lesson and holds no route: the requests it
 * makes, the rooms it opens and the sign-in it may have to survive all come
 * from here, which is the only place that knows the mount.
 */
const lessonShell: LessonShell = {
  api,
  apiResult,
  failureOf,
  appendBudgetRecovery,
  reopenSignIn: reopenSignInForExpiredIdentity,
  openLesson: (at, from, close = false) => openLesson(at, from, close),
  reopenAt: (topicId) => void renderHome(null, { at: topicId, close: false }),
  openModels: () => void openModelsPage(),
  openCourse: (courseId) => void renderCourses(courseId),
  openHome: () => void renderHome(),
  confirmStep: (host, lines, verb, go, returnFocus = null) =>
    confirmStep(host, lines, verb, go, returnFocus),
};

/**
 * Paint learning inline by replacing only the two mounted columns.
 *
 * Which lesson: the one asked for, else the first still owed.  had a
 * `resumeIndex` in `panel-core.ts` that took the LOWER of the store's stated
 * index and that, to fail closed — with every section stacked on one page,
 * opening too early cost a scroll past something already read and opening too
 * late cost a section nobody saw. With ONE lesson on screen that trade is gone
 * and the lower value is actively wrong: it lands on a finished lesson, which
 * offers no controls and is a dead end. This reads the half that was always
 * the answer, and still cannot skip unfinished work. `resumeIndex` was left
 * behind uncalled and has since been deleted; the stored index is the
 * service's own bookkeeping and is still written there.
 */
function paintLesson(m: LearnMount, learning: Learning): void {
  const stored = m.session as Session;
  const session = learning.topicIds?.length ? {
    ...stored,
    sections: stored.sections.filter((section) => learning.topicIds!.includes(section.topicId)),
  } : stored;
  const sections = session.sections;
  const owed = sections.findIndex((s) => !s.completed);
  const askedIndex = learning.at ? sections.findIndex((s) => s.topicId === learning.at) : -1;
  /**
   * A pressed lesson wins, because it is a thing somebody just chose and the
   * resume point is a thing they did days ago — including a finished one, which
   * is how a learner re-reads. An `at` naming a lesson this session does not
   * have is ignored rather than respected: that is the honest answer for a
   * lineup drawn against a session which has since changed underneath it.
   */
  const index = askedIndex >= 0 ? askedIndex : (owed < 0 ? sections.length : owed);
  const current = learning.close ? null : sections[index] ?? null;

  /**
   *  other half: a session left long enough to go cold opens with two
   * lines about what they already did. Asked for only when this is a resume,
   * and only once per arrival — the recap is the one thing on this surface that
   * can cost a model call, and the columns repaint on every move. Whether the
   * session IS cold is the service's answer, not this file's guess.
   */
  m.cardNode.setAttribute('data-kind', 'lesson');

  if (owed > 0 && recapShownFor !== session.id) {
    recapShownFor = session.id;
    const host = el(`<div class="recap"></div>`);
    m.cardNode.append(host);
    void (async () => {
      const r = await api<{ lines: string[] }>(`/sessions/${session.id}/recap`);
      const lines = (r?.lines ?? []).filter((l) => typeof l === 'string' && l.trim());
      // Nothing is nothing: no heading, no placeholder. A recap that could not
      // be written costs the learner a reminder and never the session.
      if (!lines.length) { host.remove(); return; }
      for (const line of lines) {
        const fact = el(`<div class="fact"></div>`);
        fact.textContent = line;
        host.append(fact);
      }
    })();
  }

  let teaching: HTMLElement | null = null;
  if (current) {
    const surfaces = lessonSurfaces(
      lessonShell, session, current, index, learnNextRows(m, session),
    );
    teaching = surfaces.panel;
    const heading = surfaces.face.querySelector('.lesson-area') as HTMLElement;
    heading.setAttribute('tabindex', '-1');
    m.cardNode.append(surfaces.face);
    heading.focus();
  }
  else {
    const close = sessionClose(session);
    m.cardNode.append(close);
    close.focus();
    // The close is where the awards belong, and `renderAwards` decides for
    // itself whether the session earned any. Inside the same card, so the award
    // moment does not open a page of its own and does not change the shape of
    // the one the learner is looking at.
    void renderAwards(session, m.cardNode);
  }

  m.rail.append(sessionRail(session, current, teaching));
}

/**
 * WHAT TO LEARN AFTER THIS ONE, OUT OF THE MACHINERY THAT ALREADY RANKED IT.
 *
 * The same two sources the choosing rail's *Something else instead* uses, and
 * they are the only two the product has: a topic that is owed a lesson and has
 * a viable pin behind it, which opens the quick take at the largest honest
 * window no greater than the chips; and whatever `/today` ranked that is itself learning, with
 * the figure the ranker sent. Three at most, tonight's own lessons excluded
 * because they are already in the rail beside this one.
 *
 * Every press through the same doors as the rail's, including the forward-only
 * ledger: choosing something off this list is choosing it, wherever the list is
 * drawn.
 */
function learnNextRows(m: LearnMount, session: Session): LearnNextRow[] {
  const primary = m.next?.primary ?? null;
  const others: LearnNextRow[] = learningAlternatives(m.next?.alternatives)
    .map((alternative) => ({
      label: alternative.title,
      minutes: alternative.minutes,
      press: () => {
        if (primary) recordPassedOver(primary, alternative);
        openAction(alternative, session);
      },
    }));
  return others.slice(0, 3);
}

/**
 * The rest of the session, beside the lesson rather than under it — and, since
 * 2026-08-29, the teaching itself above all of it.
 *
 * Two lists and no numbers. What is still to come, and what is already done —
 *  forbids a tally somebody can fall behind on, so neither list is
 * counted and the done one is not a score. Both are pressable, because moving
 * between lessons is navigation: a done lesson can be re-read and a later one
 * can be jumped to, and neither writes anything.
 *
 * The teaching panel leads; session navigation follows it.
 */
function sessionRail(
  session: Session, current: Section | null, teaching: HTMLElement | null,
): HTMLElement {
  const node = el(`<div class="rail-block" data-rail="session">
    <span class="alt-label"></span>
    <ul class="rail-list" data-list="next"></ul>
    <span class="alt-label" data-done-label></span>
    <ul class="rail-list" data-list="done"></ul>
  </div>`);
  const next = node.querySelector('[data-list="next"]') as HTMLElement;
  const done = node.querySelector('[data-list="done"]') as HTMLElement;

  for (const section of session.sections) {
    if (section.topicId === current?.topicId) continue;
    const row = el(`<li class="rail-row${section.completed ? ' done' : ''}" data-topic="${esc(section.topicId)}">
      <button class="link rail-name"></button>
      <span class="register" data-register="${esc(section.depth)}"></span>
      <span class="rail-minutes"></span>
    </li>`);
    const open = row.querySelector('.rail-name') as HTMLButtonElement;
    open.textContent = section.heading;
    open.setAttribute('title', lineupOpenTitle(section.heading));
    open.addEventListener('click', () => openLesson(section.topicId, session));
    (row.querySelector('.register') as HTMLElement).textContent = registerLabel(section.depth);
    (row.querySelector('.rail-minutes') as HTMLElement).textContent =
      sessionRailLine(section.estimatedMinutes);
    (section.completed ? done : next).append(row);
  }

  const label = node.querySelector('.alt-label') as HTMLElement;
  if (next.children.length) label.textContent = SESSION_UP_NEXT; else { label.remove(); next.remove(); }
  const doneLabel = node.querySelector('[data-done-label]') as HTMLElement;
  if (done.children.length) doneLabel.textContent = SESSION_DONE_HEADING;
  else { doneLabel.remove(); done.remove(); }

  const wrap = el(`<div class="rail-stack"></div>`);
  // ONE SIDE IS THE QUICK LESSON, THE OTHER IS GOING DEEPER. The teaching panel
  // is the reason this column exists while a lesson is open, so it is the first
  // thing in it: the question, the answer, the mark, and everything Virgil says
  // back. It survives a finished lesson as the ask box always did.
  if (teaching) wrap.append(teaching);

  // A one-lesson session has nothing beside it, and a heading over nothing is
  // scaffolding. The hand-off still belongs to the session either way.
  if (node.children.length) wrap.append(node);
  /**
   * Prompt forwarding and notebook hand-off share the lesson-scoped rail. It is drawn only while there is a lesson open
   * and unfinished: a finished section is a re-read with no next step to carry,
   * and the close has no lesson at all.
   *
   * The group uses the narrower lesson scope shared by every destination.
   */
  if (current && !current.completed) {
    wrap.append(geminiRoutes(
      current, afterInOrder(session, session.sections.indexOf(current)), session.id,
    ));
  }
  return wrap;
}

/** three clauses, and the end of the thing. No dashboard, no percentage,
 *  no chart. It is the close of a session rather than a footer under every
 *  lesson, so it is drawn once, when there is no lesson left to show. */
function sessionClose(session: Session): HTMLElement {
  const node = el(`<div class="session-close" role="status" aria-live="polite" tabindex="-1"></div>`);
  const closing = el(`<div class="closing"></div>`);
  closing.textContent = sessionClosingLine(session.sections);
  const next = el(`<button data-after-session>See what’s next</button>`) as HTMLButtonElement;
  next.addEventListener('click', () => void renderHome());
  node.append(closing, el(`<div class="row session-next"></div>`));
  node.querySelector('.session-next')!.append(next);
  return node;
}

function geminiRoutes(
  section: Section, after: Section | null, sessionId: string | null,
  externalTopicId: string | null = section.topicId,
): HTMLElement {
  const brief = {
    heading: section.heading,
    summary: lineupSummary(section.summary),
    depth: section.depth,
    // A foreground lesson may have a real Board topic without belonging to a
    // course yet. Carry that subject into the hand-off instead of flattening
    // the continuation back to the specific lesson heading.
    course: section.subject?.title ?? section.topicLabel ?? null,
    serves: section.serves?.title ?? null,
    next: after?.heading ?? null,
  };

  // No explainer line: it was compensating for a heading with no object and
  // three place names that hid which one was a copy. The object is in the
  // heading, and what each press does is on each press. The outcome is a live
  // region because two of the four open nothing where the learner is looking,
  // and an unannounced clipboard write looks like a control that did not work.
  const node = el(`<div class="gemini-routes rail-block" data-zone="gemini">
    <span class="alt-label"></span>
    <div class="routes"></div>
    <div class="routes-out" role="status" aria-live="polite"></div>
  </div>`);
  // The heading carries the object once, so the buttons under it only have to
  // carry the difference between them.
  (node.querySelector('.alt-label') as HTMLElement).textContent = TUTOR_ROUTES_HEADING;
  const routes = node.querySelector('.routes') as HTMLElement;
  const out = node.querySelector('.routes-out') as HTMLElement;

  /**
   * Three prompt destinations share one payload builder. This offers a new tab, a window
   * beside the page, and a copy for the browser's own assistant panel — which
   * cannot be opened by a page and does not read the page until the learner
   * points it there.
   *
   * The prompt is built from the same arguments by the same functions for all
   * three, which is what makes "the same continuation whichever door" a fact
   * rather than a coincidence three call sites currently agree on. The one
   * difference is the url cap, and it is a difference by argument: it bounds an
   * address, and the clipboard has no address in it.
   *
   * The fourth destination in the row is `notebookRoute`, and it deliberately
   * does not come through here: it carries no prompt, makes a request, and has
   * three outcomes of its own. What it shares with these is the row it sits in
   * and the live region it reports into.
   */
  const press = async (where: ForwardWhere): Promise<void> => {
    out.replaceChildren();
    const question = section.question?.prompt ?? null;
    try {
      let carriesBody: boolean;
      if (where === 'copy') {
        const payload = tutorClipboardPrompt(brief, question, section.body);
        // The gesture-backed clipboard API, and this is the one control that
        // wants it: a click handler is a live gesture, which is exactly what a
        // clipboard write needs and exactly what nothing else here has to do.
        await navigator.clipboard.writeText(payload.text);
        carriesBody = payload.carriesBody;
      } else {
        /**
         * The target decides for itself whether the lesson fits in one address
         * and says so, and the sentence under the buttons reports which of the
         * two happened — a learner about to read a chat should know what it was
         * given, and "its summary went instead" is a fact they can act on.
         */
        const target = tutorForwardTarget(brief, question, section.body);
        if (where === 'beside') await openBeside(target.url);
        else await openBrowserTab(target.url);
        carriesBody = target.carriesBody;
      }
      /**
       * The row, after the thing actually happened.
       *
       * Inside the `try` and after the await, so a tab that would not open and
       * a clipboard that refused both fall to the catch and record nothing. A
       * row claiming a send that failed is worse than no row at all, because
       * the External face would then ask the learner how it went.
       */
      await recordExternal({
        kind: 'lesson', label: section.heading, destination: FORWARD_DESTINATION[where],
        topicId: externalTopicId, sessionId,
      });
      out.append(el(`<div class="meta forwarded">${esc(tutorForwardedLine(carriesBody, where))}</div>`));
    } catch {
      out.append(el(`<div class="meta">${esc(tutorOpenFailedLine(where))}</div>`));
    }
  };

  for (const [where, label] of [
    ['tab', TUTOR_FORWARD_LABEL], ['beside', TUTOR_BESIDE_LABEL], ['copy', TUTOR_COPY_LABEL],
  ] as const) {
    // Match the Notebook hand-off's button idiom across every destination.
    const btn = el(`<button data-tutor="${where}"></button>`) as HTMLButtonElement;
    btn.textContent = label;
    // The label is a place; the title is the sentence. Same string in both, so
    // the control is not two controls depending on how you meet it.
    const title = tutorRouteTitle(where);
    btn.setAttribute('title', title);
    btn.setAttribute('aria-label', title);
    btn.addEventListener('click', () => press(where));
    routes.append(btn);
  }
  routes.append(notebookRoute(out, section, sessionId, externalTopicId));
  return node;
}

/**
 * The rail's three doors, in the words the External record uses.
 *
 * A map rather than the same string spelled twice, because the panel's word for
 * a press and the stored word for a destination drifting apart is exactly how a
 * history comes to describe a send that never happened that way.
 */
const FORWARD_DESTINATION: Readonly<Record<ForwardWhere, 'new-tab' | 'window' | 'side-panel'>> = {
  tab: 'new-tab', beside: 'window', copy: 'side-panel',
};

/**
 * The chat, in a window beside the lesson.
 *
 * **`chrome.windows.create` rather than `window.open`**, because this is an
 * extension surface and that is the API for it: it takes real geometry instead
 * of a feature string, it is not subject to the popup blocker, and it needs no
 * permission the manifest does not already have — a window with a url on it is
 * not a capability, it is a navigation.
 *
 * The geometry is computed from the learner's own window rather than from the
 * screen, so somebody with a browser on half a monitor gets a chat on the same
 * half. Right-aligned and level with the top: the lesson keeps the left of the
 * screen and the chat takes the right, which is the entire difference this
 * control offers over the tab.
 *
 * **The `qa/extension.html` branch is not dead code.** That page runs the compiled panel
 * on localhost with a hand-built `chrome` object which has no `windows` on it,
 * and browser QA should exercise this control rather than skip the one thing
 * about it that is hard to get right. `window.open` from inside a click handler
 * carries the user gesture the browser requires. A script-initiated open with
 * no gesture may be blocked; a button press is not that case.
 */
async function openBeside(url: string): Promise<void> {
  const windows = (chrome as { windows?: {
    getCurrent?: () => Promise<{ left?: number; top?: number; width?: number; height?: number }>;
    create?: (props: Record<string, unknown>) => Promise<unknown>;
  } }).windows;

  if (windows?.create) {
    let current: { left?: number; top?: number; width?: number; height?: number } | null = null;
    // A `getCurrent` that will not answer is not a reason to refuse the window:
    // `besideWindow` has an answer for nothing, and a chat in the wrong place
    // beats no chat at all.
    try { current = (await windows.getCurrent?.()) ?? null; } catch { current = null; }
    const box = besideWindow(current);
    await windows.create({ url, type: 'popup', focused: true, ...box });
    return;
  }

  const opened = (globalThis as { open?: (u: string, t: string, f: string) => unknown })
    .open?.(url, '_blank', popupFeatures(besideWindow(null)));
  if (!opened) throw new Error('the window did not open');
}

function notebookRoute(
  out: HTMLElement, section: Section, sessionId: string | null,
  externalTopicId: string | null = section.topicId,
): HTMLButtonElement {
  const btn = el(`<button data-handoff>${esc(NOTEBOOK_PUSH_LABEL)}</button>`) as HTMLButtonElement;
  // The label is a destination; this is the whole sentence, on both attributes,
  // exactly as the three doors beside it carry theirs.
  btn.setAttribute('title', notebookPushSeamLine());
  btn.setAttribute('aria-label', notebookPushSeamLine());

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    out.replaceChildren();

    // A foreground lesson has no stored Learn-now document to rewrite. Its
    // honest Notebook path is therefore the hosted fallback directly: copy
    // the exact visible lesson, open Notebook, and record only after the copy
    // succeeded. Rewriting the current nightly session here would send a
    // different lesson from the one beside this control.
    if (sessionId === null) {
      try {
        const title = lessonTitle(section.heading, subjectOf(section));
        await navigator.clipboard.writeText(notebookClipboardText(
          title.family ? `${title.family}\n${title.area}` : title.area,
          section.body, section.question?.prompt ?? null,
        ));
      } catch {
        btn.disabled = false;
        out.append(el(`<div class="meta failed">${esc(notebookCopyFailedLine())}</div>`));
        return;
      }
      const destination = await configuredNotebookDestination();
      let opened = true;
      try { await openBrowserTab(destination); } catch { opened = false; }
      btn.disabled = false;
      await recordExternal({
        kind: 'lesson', label: section.heading, destination: 'notebook',
        topicId: externalTopicId, sessionId: null,
      });
      out.append(el(`<div class="meta wrote">${esc(notebookCopiedLine(opened))}</div>`));
      return;
    }

    /*
     * The scope, and nothing else. Which lesson is current is read off the store
     * by the engine that writes the document, so there is no field in this body
     * through which this panel's idea of the current lesson could disagree with
     * the board's — which is exactly the disagreement a second panel, or a stale
     * tab, would otherwise produce.
     */
    const wrote = await apiResult<{ ok?: boolean; line?: string; notebookUrl?: unknown }>('/notebook/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docs: [LEARN_NOW_DOC] }),
    });
    btn.disabled = false;

    if (wrote.kind === 'refused' && wrote.status === 404) {
      // The hosted page keeps the short-lived Drive grant in the browser, not
      // in Cloud Run. Ask the service only for the pure document, then create
      // or rewrite the learner's native Doc directly from this page. The
      // extension/local build retains its visible clipboard fallback below.
      if (chrome.runtime.id === '') {
        const [setup, learner, origin] = await Promise.all([
          apiResult<{ expectedAccount?: string; notebookUrl?: unknown }>('/notebook/drive/hosted-setup'),
          readSession(),
          serviceBase(),
        ]);
        if (setup.kind !== 'ok' || !setup.body.expectedAccount || !learner) {
          out.append(el(`<div class="meta failed">${esc(notebookPushFailedLine())}</div>`));
          return;
        }
        const sources = await apiResult<{ documents?: HostedNotebookDocument[] }>(
          '/notebook/documents',
        );
        if (sources.kind !== 'ok' || !Array.isArray(sources.body.documents)
          || HOSTED_NOTEBOOK_DOC_KEYS.some((key) =>
            !sources.body.documents?.some((document) => document.key === key))) {
          out.append(el(`<div class="meta failed">${esc(notebookPushFailedLine())}</div>`));
          return;
        }
        try {
          const documents = HOSTED_NOTEBOOK_DOC_KEYS.flatMap((key) =>
            sources.body.documents?.filter((document) => document.key === key).slice(0, 1) ?? []);
          const written = await writeHostedNotebookDocuments(documents, {
            learnerId: learner.uid,
            serviceOrigin: origin,
            expectedAccount: setup.body.expectedAccount,
          });
          const files = Object.fromEntries(
            written.documents.map((document) => [document.key, document.fileId]),
          );
          const background = await apiResult<{ connected?: boolean }>(
            '/notebook/drive/hosted-setup',
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                account: written.account,
                folderId: written.folderId,
                files,
              }),
            },
          );
          const destination = notebookTarget(setup.body.notebookUrl);
          let opened = true;
          try { await openBrowserTab(destination); } catch { opened = false; }
          await recordExternal({
            kind: 'lesson', label: section.heading, destination: 'notebook',
            topicId: externalTopicId, sessionId,
          });
          const line = hostedNotebookWrittenLine(
            written.account,
            written.documents.filter((document) => document.created).map((document) => document.key),
          );
          out.append(el(`<div class="meta wrote">${esc(line)}</div>`));
          if (background.kind === 'ok' && background.body.connected === true) {
            out.append(el('<div class="meta">Automatic refresh is on.</div>'));
          } else if (!(background.kind === 'refused' && background.status === 404)) {
            out.append(el('<div class="meta failed">The sources are in Drive, but automatic refresh did not switch on.</div>'));
          }
          if (!opened) {
            const failed = el(`<div class="meta"></div>`);
            failed.append(el(`<span>${esc(notebookTabFailedLine())} </span>`));
            const retry = el(`<a class="link" target="_blank" rel="noreferrer">Open Google Notebook</a>`);
            retry.setAttribute('href', destination);
            failed.append(retry);
            out.append(failed);
          }
        } catch (error) {
          const line = error instanceof Error ? error.message
            : 'Google Drive connection did not finish. Nothing was sent.';
          out.append(el(`<div class="meta failed">${esc(line)}</div>`));
        }
        return;
      }

      out.append(el(`<div class="meta not-kept">${esc(notebookNotKeptLine())}</div>`));
      try {
        await navigator.clipboard.writeText(notebookClipboardText(
          section.heading, section.body, section.question?.prompt ?? null,
        ));
      } catch {
        out.append(el(`<div class="meta failed">${esc(notebookCopyFailedLine())}</div>`));
        return;
      }

      const destination = await configuredNotebookDestination();
      let opened = true;
      try { await openBrowserTab(destination); } catch { opened = false; }
      await recordExternal({
        kind: 'lesson', label: section.heading, destination: 'notebook',
        topicId: externalTopicId, sessionId,
      });
      out.append(el(`<div class="meta wrote">${esc(notebookCopiedLine(opened))}</div>`));
      return;
    }

    // A 207 is a real answer with `ok: false` in it, and it means the document
    // did not land. Reported as the same fact as a refusal, because from where
    // the learner is standing it is the same fact: what their notebook has is
    // what it had before.
    if (wrote.kind !== 'ok' || wrote.body?.ok !== true) {
      out.append(el(`<div class="meta failed">${esc(notebookPushFailedLine())}</div>`));
      return;
    }

    // The service's own sentence about its own write, never a second one
    // composed here: the panel, the settings screen and the run log all read
    // the same line so that one write cannot be described three ways.
    const line = typeof wrote.body.line === 'string' ? wrote.body.line : '';
    const destination = notebookTarget(wrote.body.notebookUrl);

    // The document really was rewritten, which is the success this door has.
    // Whether the notebook tab then opened is a separate fact and not a reason
    // to forget that the lesson went.
    await recordExternal({
      kind: 'lesson', label: section.heading, destination: 'notebook',
      topicId: externalTopicId, sessionId,
    });

    // Last, per the note above. The root and nothing deeper: there is no
    // documented create-a-notebook link, and a guessed path that lands somewhere
    // other than where it promised is how a learner stops trusting links.
    let opened = true;
    try {
      await openBrowserTab(destination);
    } catch {
      opened = false;
    }
    out.append(el(`<div class="meta wrote">${esc(opened ? notebookPushedLine(line) : line)}</div>`));
    if (!opened) {
      const failed = el(`<div class="meta"></div>`);
      failed.append(el(`<span>${esc(notebookTabFailedLine())} </span>`));
      const retry = el(`<a class="link" target="_blank" rel="noreferrer">Open Gemini Notebook</a>`);
      retry.setAttribute('href', destination);
      failed.append(retry);
      out.append(failed);
    }
  });
  return btn;
}

/**
 * The award moment (§5) — session close, where it was earned.
 *
 * Shown once the whole session is done, and only then: an award offered halfway
 * through would be the lobby the spec refuses, and the main page's strip is an
 * echo of this rather than the other way round. Nothing here is a total, and
 * there is no line for a session that moved nothing — no award for turning up.
 */
async function renderAwards(session: Session, host: HTMLElement = roomContent): Promise<void> {
  if (!session.sections.length || !session.sections.every((s) => s.completed)) return;

  const data = await api<{ awards: ProgressionEventView[] }>(`/sessions/${session.id}/awards`);
  const lines = (data?.awards ?? []).map(momentumLine).filter((l): l is string => !!l);
  const heading = awardsHeading(lines.length);
  if (!heading) return;

  host.append(el(`<div class="awards">
    <h2>${esc(heading)}</h2>
    ${lines.map((l) => `<div class="fact">${esc(l)}</div>`).join('')}
  </div>`));
}

/**
 * The board, drawn into whatever is hosting it.
 *
 * There is no separate board screen; the former arrival surface duplicated the
 * same pins, fewer of them, a second Process button, and a
 * link to the real thing.
 *
 * So this is the page, and `renderHome` puts the session above it when there is
 * one. What  protects is unchanged and is the reason this is careful: no
 * count of things to clear, no unread badge, nothing that empties anything.
 */
/**
 * A pin is a door to five minutes with the tutor.
 *
 * A pin card on the board opens the quick take on that pin.
 * The evidence unit is still the evidence unit —  is untouched, a pin is
 * not promoted to a subject and nothing about the card claims it is — and it
 * is also the one thing on the board that can be taught right now, because the
 * take is written from the passage the pin holds.
 *
 * The hand-off is built here and handed straight to the screen. `sb_quick_take`
 * is the toast's rail to the panel and is read once and cleared; writing
 * through it from a board that is already looking at the screen would put a
 * record in storage for a panel to find later, which is how a tap becomes a
 * stale take somebody gets for some other reason.
 */
function boardReturnQuery(): string | null {
  const search = learnMount?.face === 'board'
    ? learnMount.boardSearch?.querySelector('.search') as HTMLInputElement | null
    : null;
  return search?.value.trim() ? search.value : null;
}

function openTake(
  pinId: string, label: string | null, requestedMinutes: AvailableMinutes | null = null,
  savedWhere: 'board' | 'pins' = 'board',
): void {
  const returnQuery = boardReturnQuery();
  void renderQuickTake(handoffFor(pinId, label, Date.now()), returnQuery, requestedMinutes, savedWhere);
}

/**
 * one pin, before another model call.
 *
 * The title on a board pin remains the direct five-minute lesson. **Details** is the quiet trust/repair door beside it: exact captured
 * material, page, location and time, then only the things the learner said
 * about that immutable receipt. A save cannot edit source history because the
 * service does not accept those fields.
 */
function openPinDetails(pinId: string, label: string | null): void {
  void renderPinDetails(pinId, label, boardReturnQuery());
}

async function renderPinDetails(
  pinId: string, fallbackLabel: string | null, returnQuery: string | null,
): Promise<void> {
  frame('take', { title: 'Saved pin', route: 'home' });
  const host = el(`<section class="pin-detail" aria-labelledby="pin-detail-heading">
    <h2 id="pin-detail-heading" tabindex="-1"></h2>
    <div class="pin-receipt"></div>
  </section>`);
  const heading = host.querySelector('h2') as HTMLElement;
  heading.textContent = fallbackLabel || 'Saved material';
  const receiptHost = host.querySelector('.pin-receipt') as HTMLElement;
  receiptHost.append(thinking('Opening the saved source…', true));
  roomContent.append(host);
  if (SURFACE === 'page') roomContent.append(boardExit(returnQuery));
  heading.focus();

  const read = await apiResult<PinDetail>(`/pins/${encodeURIComponent(pinId)}`);
  if (read.kind !== 'ok') {
    receiptHost.replaceChildren();
    const failed = el(`<div class="pin-detail-failure" role="alert">
      <p>I could not open this saved pin. Nothing changed.</p>
      <button class="link">Try again</button>
    </div>`);
    const retry = failed.querySelector('button') as HTMLButtonElement;
    retry.addEventListener('click', () => void renderPinDetails(pinId, fallbackLabel, returnQuery));
    receiptHost.append(failed);
    retry.focus();
    return;
  }

  let baseline = read.body;
  heading.textContent = baseline.label || fallbackLabel || baseline.source.pageTitle || 'Saved material';
  receiptHost.replaceChildren();
  const source = pinnedSource({
    ...baseline.source,
    note: null,
  });
  if (source) receiptHost.append(source);

  // availability is what the learner observed after opening the link,
  // not a server claim about a remote page. The answer controls are revealed
  // only after the source link has actually been pressed.
  const sourceLink = source?.querySelector('.from a') as HTMLAnchorElement | null;
  if (sourceLink) {
    const availability = el(`<div class="source-availability-check">
      <p class="meta source-availability-state" tabindex="-1"></p>
      <div class="source-availability-question" role="group" aria-label="Did the saved source open?" hidden>
        <span>Did it open?</span>
        <button class="link" type="button" data-source-available>Yes, it opened</button>
        <button class="link" type="button" data-source-unavailable>No, unavailable</button>
      </div>
    </div>`);
    const availabilityState = availability.querySelector('.source-availability-state') as HTMLElement;
    const availabilityQuestion = availability.querySelector('.source-availability-question') as HTMLElement;
    availabilityQuestion.hidden = true;
    const available = availability.querySelector('[data-source-available]') as HTMLButtonElement;
    const unavailable = availability.querySelector('[data-source-unavailable]') as HTMLButtonElement;
    const paintAvailability = (): void => {
      availabilityState.textContent = sourceAvailabilityLine(baseline.source.availability);
    };
    paintAvailability();
    sourceLink.addEventListener('click', () => {
      availabilityQuestion.hidden = false;
      availabilityState.textContent = 'Source opened in a new tab. Did it open?';
    });
    const saveAvailability = async (
      status: 'available' | 'unavailable', control: HTMLButtonElement,
    ): Promise<void> => {
      available.disabled = true;
      unavailable.disabled = true;
      availabilityState.textContent = 'Saving your link check…';
      const result = await apiResult<PinDetail>(
        `/pins/${encodeURIComponent(pinId)}/source-availability`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status }),
        },
      );
      available.disabled = false;
      unavailable.disabled = false;
      if (await reopenSignInForExpiredIdentity(result, () => renderPinDetails(
        pinId, baseline.label ?? fallbackLabel, returnQuery,
      ))) return;
      if (result.kind !== 'ok') {
        availabilityState.textContent = 'That link check did not save. Your previous answer is unchanged.';
        control.focus();
        return;
      }
      baseline = result.body;
      availabilityQuestion.hidden = true;
      paintAvailability();
      availabilityState.focus();
    };
    available.addEventListener('click', () => void saveAvailability('available', available));
    unavailable.addEventListener('click', () => void saveAvailability('unavailable', unavailable));
    receiptHost.append(availability);
  }

  const when = new Date(baseline.capturedAt);
  const captured = Number.isNaN(when.getTime())
    ? 'Saved time unavailable'
    : `Saved ${when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
  const place = (baseline.source.headingPath ?? []).filter(Boolean).join(' → ');
  const facts = el(`<div class="pin-facts meta">
    <div class="captured-at"></div>
    ${place ? '<div class="source-place"></div>' : ''}
  </div>`);
  (facts.querySelector('.captured-at') as HTMLElement).textContent = captured;
  if (place) (facts.querySelector('.source-place') as HTMLElement).textContent = `On the page: ${place}`;
  receiptHost.append(facts);

  const remembered = PIN_EDIT_DRAFTS.get(pinId);
  const requestValue = (
    register: PinEditDraft['requestedRegister'], minutes: number | null,
  ): string => EFFORT_CHOICES.find((choice) => (
    choice.register === register && choice.minutes === minutes
  ))?.value ?? (register === null && minutes === null ? 'none' : 'legacy');
  const baselineRequestValue = requestValue(baseline.requestedRegister, baseline.requestedMinutes);
  const levelOptions = [
    '<option value="none">Not set at capture</option>',
    ...EFFORT_CHOICES.map((choice) => (
      `<option value="${esc(choice.value)}">${esc(choice.label)}</option>`
    )),
    ...(baselineRequestValue === 'legacy'
      ? ['<option value="legacy">Saved lesson level (unchanged)</option>'] : []),
  ].join('');
  const form = el(`<form class="pin-edit">
    <label for="pin-intent-${esc(pinId)}">Why you saved it</label>
    <select id="pin-intent-${esc(pinId)}" class="pin-intent">
      <option value="interest">I was interested</option>
      <option value="struggle">I was stuck</option>
    </select>
    <label for="pin-level-${esc(pinId)}">Desired lesson level</label>
    <select id="pin-level-${esc(pinId)}" class="pin-level">${levelOptions}</select>
    <label for="pin-note-${esc(pinId)}">Your note <span class="meta">(optional)</span></label>
    <textarea id="pin-note-${esc(pinId)}" class="pin-note" rows="3"></textarea>
    <p class="meta input-limit">Up to 1,000 characters. I save the whole note.</p>
    <p class="meta immutable">The saved source and time stay unchanged.</p>
    <div class="row pin-detail-actions">
      <button class="primary" type="submit">Save changes</button>
      <button type="button" data-learn>Learn this now</button>
      <button class="link" type="button" data-discard>Discard changes</button>
    </div>
    <p class="pin-edit-status" role="status" aria-live="polite" tabindex="-1"></p>
  </form>`);
  const intent = form.querySelector('.pin-intent') as HTMLSelectElement;
  const level = form.querySelector('.pin-level') as HTMLSelectElement;
  const note = form.querySelector('.pin-note') as HTMLTextAreaElement;
  const save = form.querySelector('button[type=submit]') as HTMLButtonElement;
  const discard = form.querySelector('[data-discard]') as HTMLButtonElement;
  const learn = form.querySelector('[data-learn]') as HTMLButtonElement;
  const status = form.querySelector('.pin-edit-status') as HTMLElement;

  intent.value = remembered?.type ?? baseline.type;
  level.value = remembered
    ? requestValue(remembered.requestedRegister, remembered.requestedMinutes)
    : baselineRequestValue;
  note.value = remembered?.note ?? baseline.note ?? '';
  const current = (): PinEditDraft => {
    const choice = EFFORT_CHOICES.find((item) => item.value === level.value);
    const request = level.value === 'legacy'
      ? { requestedRegister: baseline.requestedRegister, requestedMinutes: baseline.requestedMinutes }
      : choice
        ? { requestedRegister: choice.register, requestedMinutes: choice.minutes }
        : { requestedRegister: null, requestedMinutes: null };
    return {
      type: intent.value === 'struggle' ? 'struggle' : 'interest',
      note: note.value,
      ...request,
    };
  };
  const dirty = (): boolean => {
    const draft = current();
    return draft.type !== baseline.type || draft.note.trim() !== (baseline.note ?? '')
      || draft.requestedRegister !== baseline.requestedRegister
      || draft.requestedMinutes !== baseline.requestedMinutes;
  };
  const remember = (): void => {
    const draft = current();
    if (dirty()) PIN_EDIT_DRAFTS.set(pinId, draft); else PIN_EDIT_DRAFTS.delete(pinId);
    save.disabled = !dirty();
    discard.disabled = !dirty();
    status.textContent = '';
  };
  intent.addEventListener('change', remember);
  level.addEventListener('change', remember);
  note.addEventListener('input', remember);
  discard.addEventListener('click', () => {
    PIN_EDIT_DRAFTS.delete(pinId);
    intent.value = baseline.type;
    level.value = requestValue(baseline.requestedRegister, baseline.requestedMinutes);
    note.value = baseline.note ?? '';
    remember();
    intent.focus();
  });
  learn.addEventListener('click', () => {
    void renderQuickTake(handoffFor(pinId, baseline.label ?? fallbackLabel, Date.now()), returnQuery);
  });
  const saveEdit = async (event: Event): Promise<void> => {
    event.preventDefault();
    const draft = current();
    PIN_EDIT_DRAFTS.set(pinId, draft);
    const noteChars = unicodeChars(draft.note.trim());
    if (noteChars > PIN_NOTE_MAX_CHARS) {
      status.textContent = `That note is ${noteChars.toLocaleString('en-US')} characters. `
        + 'Keep it to 1,000 so I can save all of it. Nothing was sent.';
      note.focus();
      return;
    }
    form.setAttribute('aria-busy', 'true');
    for (const control of [intent, level, note, save, discard, learn]) control.disabled = true;
    status.textContent = 'Saving your details…';
    const result = await apiResult<PinDetail & { changed: boolean }>(
      `/pins/${encodeURIComponent(pinId)}`,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) },
    );
    if (await reopenSignInForExpiredIdentity(result, () => renderPinDetails(
      pinId, baseline.label ?? fallbackLabel, returnQuery,
    ))) return;
    form.removeAttribute('aria-busy');
    for (const control of [intent, level, note, save, discard, learn]) control.disabled = false;
    if (result.kind !== 'ok') {
      status.textContent = 'That did not save. Your changes are still here.';
      save.focus();
      return;
    }
    baseline = result.body;
    PIN_EDIT_DRAFTS.delete(pinId);
    intent.value = baseline.type;
    level.value = requestValue(baseline.requestedRegister, baseline.requestedMinutes);
    note.value = baseline.note ?? '';
    save.disabled = true;
    discard.disabled = true;
    status.textContent = result.body.changed
      ? 'Saved. The original source and saved time did not change.'
      : 'Already saved. Nothing needed to change.';
    status.focus();
  };
  // The explicit click listener keeps the write testable in the small DOM
  // harness; preventing its default means a real browser does not also emit a
  // second submit. Enter in either field still follows the form submit path.
  save.addEventListener('click', (event) => { void saveEdit(event); });
  form.addEventListener('submit', (event) => { void saveEdit(event); });
  remember();
  receiptHost.append(form);
}

interface BoardPayload { topics: Topic[]; unfiled?: UnfiledPin[] }

async function boardSurface(
  host: HTMLElement,
  board: BoardPayload | null,
  query = '',
  /**
   * Where the search box goes. The masthead's `.find` slot when the caller has
   * one — the top bar is where search belongs —
   * and above the board otherwise, which is the panel and every caller that
   * draws a board without furniture around it. Passed rather than looked up:
   * `.masthead.find` is a descendant selector and the DOM stub the wiring
   * suite runs on answers simple ones only.
   */
  mount: HTMLElement | null = null,
  /** What the learner asked to come back to, by topic id. Drawn on the card
   *  rather than in a list of its own — see `flaggedMarks`. */
  marks: ReadonlyMap<string, string> = new Map(),
  /** The Process control, built once by the caller and moved to the bottom of
   *  the board it acts on. Null when the service is too old to answer
   *  `/batch`, which draws no control rather than an error. */
  control: HTMLElement | null = null,
  /** The topics tonight's prepared session teaches, by id. Empty when there is
   *  no session, which is when no card carries the mark. */
  tonight: ReadonlySet<string> = new Set(),
  /** Unbuilt, source-viable lessons. They have one explicit action of their
   *  own and therefore never appear as ready timed alternatives on Learn. */
  pendingLessons: ReadonlyMap<string, PendingBoardLesson> = new Map(),
): Promise<HTMLElement | null> {
  // Handed the payload rather than fetching it. The first draft asked `/board`
  // a second time, on a page whose caller had just read it — the cost of a
  // screen must not grow because two parts of it want the same fact.
  if (!board) {
    host.append(el(`<p class="empty">${esc(VIRGIL_UNAVAILABLE)}</p>`));
    return null;
  }
  const all = board.topics ?? [];
  boardTopics = all;
  const unfiled = board.unfiled ?? [];

  const bar = el(`<div class="boardbar">
    <input class="search" type="text" placeholder="Search what you're learning">
  </div>`);
  const search = bar.querySelector('.search') as HTMLInputElement;
  search.value = query;
  (mount ?? host).append(bar);

  const surface = el(`<div class="board"></div>`);
  host.append(surface);

  /** An unfiled pin, drawn the one way it is drawn. Lifted out of the board's
   *  own loop when the search started answering with them too: two renderings
   *  of one card is how two parts of a screen come to disagree about it. */
  const pinCard = (p: UnfiledPin): HTMLElement => {
    const card = el(`<article class="card pin-card">
      <button class="label" data-open></button>
      <p class="gist"></p>
      <div class="row pin-actions"><button class="link" data-details>Details</button></div>
    </article>`);
    const label = card.querySelector('[data-open]') as HTMLElement;
    label.textContent = p.title;
    label.addEventListener('click', () => openTake(p.id, p.title));
    const details = card.querySelector('[data-details]') as HTMLButtonElement;
    details.setAttribute('data-pin-details', p.id);
    details.addEventListener('click', () => openPinDetails(p.id, p.title));
    const gist = card.querySelector('.gist') as HTMLElement;
    if (p.gist) gist.textContent = p.gist; else gist.remove();
    return card;
  };

  /** A thing that lives in My studies, and the press that opens the room it is
   *  in. The material row carries the course it came out of, because a title on
   *  its own answers half the question somebody asked. */
  const studyHit = (
    label: string, where: string, courseId: string, returnQuery: string,
    materialId: string | null = null,
  ): HTMLElement => {
    const row = el(`<button class="link study-hit">
      <span class="label"></span><span class="where"></span>
    </button>`);
    (row.querySelector('.label') as HTMLElement).textContent = label;
    (row.querySelector('.where') as HTMLElement).textContent = where;
    row.addEventListener('click', () => void renderCourses(
      courseId, false, materialId, null, materialId === null,
      null, null, false, materialId !== null, returnQuery,
    ));
    return row;
  };

  /** Planned work has its own room and opens there in one press. */
  const planHit = (hit: CommitmentHitView, returnQuery: string): HTMLElement => {
    const row = el(`<button class="link study-hit">
      <span class="label"></span><span class="where"></span>
    </button>`);
    (row.querySelector('.label') as HTMLElement).textContent = hit.title;
    (row.querySelector('.where') as HTMLElement).textContent = hit.courseTitle;
    row.addEventListener('click', () => void renderPlan(
      hit.id, true, false, false, null, null, returnQuery,
    ));
    return row;
  };

  /** Group search results by their destination room, including unfiled pins. */
  const searchResults = (q: string): void => {
    const block = el(`<div class="search-results"></div>`);
    const group = (key: string, heading: string): HTMLElement => {
      const node = el(`<section class="found" data-found="${esc(key)}">
        <h2></h2><div class="hits"></div>
      </section>`);
      (node.querySelector('h2') as HTMLElement).textContent = heading;
      block.append(node);
      return node.querySelector('.hits') as HTMLElement;
    };
    const nothing = (host: HTMLElement, line: string): void => {
      const said = el(`<p class="bare"></p>`);
      said.textContent = line;
      host.append(said);
    };

    const topics = all.filter((t) => matchesSearch(t, q));
    const pins = unfiled.filter((p) => matchesPinSearch(p, q));
    const appendBoardHits = (): void => {
      if (!topics.length && !pins.length) return;
      const onBoard = group('board', SEARCH_BOARD_HEADING);
      for (const t of topics) onBoard.append(topicCard(
        t, marks.get(t.id), tonight.has(t.id), pendingLessons.get(t.id) ?? null,
      ));
      for (const p of pins) onBoard.append(pinCard(p));
    };

    if (COURSE_INDEX === null) {
      appendBoardHits();
      const inCourses = group('courses', SEARCH_COURSES_HEADING);
      // Not "nothing", because nothing has been looked at yet. A group that
      // reported a miss before it had read the courses would be lying about
      // the half of the answer still in flight.
      nothing(inCourses, SEARCH_COURSES_WAITING);
    } else if (COURSE_INDEX_UNREADABLE_STATE) {
      appendBoardHits();
      const inCourses = group('courses', SEARCH_COURSES_HEADING);
      const failed = el(`<div class="search-unreadable" role="status" aria-live="polite">
        <p class="bare"></p><button class="link">Try courses again</button>
      </div>`);
      (failed.querySelector('p') as HTMLElement).textContent = SEARCH_COURSES_UNREADABLE;
      const retry = failed.querySelector('button') as HTMLButtonElement;
      retry.addEventListener('click', () => {
        COURSE_INDEX = null;
        COURSE_INDEX_UNREADABLE_STATE = false;
        draw(q);
        void readCourses(q);
      });
      inCourses.append(failed);
    } else {
      const hit = searchCourses(COURSE_INDEX, q);
      const planHits = searchCommitments(PLAN_SEARCH_INDEX, q);
      const boardHasHits = Boolean(topics.length || pins.length);
      const coursesHaveHits = Boolean(hit.courses.length || hit.material.length);
      if (!boardHasHits && !coursesHaveHits && !planHits.length) {
        const empty = el(`<p class="bare search-empty" role="status"></p>`);
        empty.textContent = searchEmptyLine(q);
        block.append(empty);
      } else {
        appendBoardHits();
        if (coursesHaveHits) {
          const inCourses = group('courses', SEARCH_COURSES_HEADING);
          for (const c of hit.courses) inCourses.append(studyHit(c.title, '', c.id, q));
          for (const m of hit.material) {
            inCourses.append(studyHit(m.title, m.courseTitle, m.courseId, q, m.id));
          }
        }
        if (planHits.length) {
          const inPlan = group('plan', SEARCH_PLAN_HEADING);
          for (const commitment of planHits) inPlan.append(planHit(commitment, q));
        }
      }
    }
    surface.append(block);
  };

  const draw = (q: string): void => {
    surface.replaceChildren();
    if (q.trim()) { searchResults(q); return; }
    const topics = all;

    // Only when nothing is being searched: a filter is a question about the
    // board, and answering it with a strip that ignores the question is how a
    // search stops meaning anything.
    /**
     * A board with nothing on it at all still has its named areas.
     *
     * The first-run note explains the gesture, but it is not a replacement for
     * the board's structure. Removing the areas made a new learner see an empty
     * framed rectangle with no account of what the product would organise.
     */
    if (!topics.length && !unfiled.length) {
      const first = el(`<div class="firstrun">
        <h2>Nothing here yet</h2>
        <p class="meta"></p>
        <p class="how"></p>
      </div>`);
      (first.querySelector('.meta') as HTMLElement).textContent =
        'Pin something you want to understand, and it lands here.';
      (first.querySelector('.how') as HTMLElement).textContent = HOW_TO_PIN;
      surface.append(first);
    }

    const just = unfiledArea(unfiled, UNFILED_SHOWN);

    for (const column of boardColumns(topics, new Set(pendingLessons.keys()))) {
      const first = column.key === 'get-started';
      // The heading is a row, not a word: it carries the area's name at one end
      // and, on Get Started, the control for what is in it at the other. The
      // rule in the area's colour runs under both, because they are one line.
      const area = el(`<section class="area" data-area="${esc(column.key)}">
        <div class="head"><h2>${esc(column.heading)}</h2><div class="doing"></div></div>
        <div class="cards"></div>
      </section>`);
      const cards = area.querySelector('.cards') as HTMLElement;

      // An empty area still says where its things will go — all five of them,
      // every time. What must never appear here is a count
      // of zero: the line is what the area is FOR, not how little is in it.
      if (!column.topics.length && !(first && just)) {
        const bare = el(`<p class="bare"></p>`);
        bare.textContent = column.empty;
        cards.append(bare);
      }

      // Topics first, then the pins.  order — the display unit before
      // the evidence unit — and it is also the only order in which the note
      // and the overflow line land beside the things they are about. Drawn the
      // other way round first, and "and 2 more" ended up marooned in the middle
      // of the area with topics under it, counting neither.
      for (const t of column.topics as Topic[]) {
        cards.append(topicCard(
          t, marks.get(t.id), tonight.has(t.id), pendingLessons.get(t.id) ?? null,
        ));
      }

      if (first && just) {
        const note = el(`<p class="note"></p>`);
        note.textContent = just.note;
        cards.append(note);
        for (const p of just.pins) cards.append(pinCard(p));
        if (just.more) {
          const more = el(`<p class="bare"></p>`);
          more.textContent = just.more;
          cards.append(more);
        }
      }
      surface.append(area);
    }
    // The bottom of the board, under every area. Moved, not rebuilt — the same
    // node every draw, so a run the learner started survives them typing in
    // the search.
    if (control) surface.append(control);
  };

  /**
   * The one request the search costs, and it costs it once.
   *
   * Not on arrival: the board is drawn from the payload the caller already has,
   * and a room that fetched My studies in case somebody might type would have
   * grown a request for every learner who never uses the box. Not per
   * keystroke either — the index is read the first time a query is typed and
   * then answered from memory, and My studies refreshes it every time it draws
   * itself, so nothing here can go stale behind the room that owns it.
   *
   * A read that fails leaves an empty index rather than a null one: the group
   * then says honestly that nothing in the courses matched, which is what the
   * panel knows. Guessing the other way would promise material it cannot see.
   */
  const readCourses = async (q: string): Promise<void> => {
    if ((COURSE_INDEX !== null && !COURSE_INDEX_UNREADABLE_STATE) || courseIndexInFlight) return;
    const generation = courseIndexGeneration;
    COURSE_INDEX = null;
    COURSE_INDEX_UNREADABLE_STATE = false;
    courseIndexInFlight = true;
    draw(q);
    const read = await apiResult<CoursesView>('/courses');
    // The learner changed while this request was away. Its reply belongs to
    // the retired index and must not repopulate the new account's cache.
    if (generation !== courseIndexGeneration) return;
    courseIndexInFlight = false;
    COURSE_INDEX = read.kind === 'ok' ? read.body.courses ?? [] : [];
    if (read.kind === 'ok') {
      const labels = new Map(COURSE_INDEX.map((course) => [course.id, course.title]));
      const commitments = new Map<string, CommitmentHitView>();
      for (const course of COURSE_INDEX) {
        for (const commitment of course.commitments ?? []) {
          commitments.set(commitment.id, {
            id: commitment.id, title: commitment.title, courseTitle: course.title,
          });
        }
      }
      for (const commitment of read.body.unattached?.commitments ?? []) {
        commitments.set(commitment.id, {
          id: commitment.id, title: commitment.title,
          courseTitle: commitment.courseId ? labels.get(commitment.courseId) ?? '' : '',
        });
      }
      PLAN_SEARCH_INDEX = [...commitments.values()];
    } else PLAN_SEARCH_INDEX = [];
    COURSE_INDEX_UNREADABLE_STATE = read.kind !== 'ok';
    // Only if they are still asking the same question. Redrawing under a query
    // somebody has moved on from would replace what they are reading now.
    if (search.value === q) draw(search.value);
  };

  search.addEventListener('input', () => {
    const q = search.value;
    draw(q);
    if (q.trim()) void readCourses(q);
  });
  draw(query);
  if (query.trim()) void readCourses(query);
  return bar;
}

/**
 * What My studies holds, as far as the search box knows.
 *
 * `null` is "nobody has looked yet" and is the state the group says so about;
 * an array is an answer, including an empty one. Module level for the same
 * reason `boardTopics` is: the board is redrawn on every keystroke and an index
 * that lived in the closure would be re-read on every one of them.
 */
let COURSE_INDEX: readonly CourseView[] | null = null;
let PLAN_SEARCH_INDEX: readonly CommitmentHitView[] = [];
let COURSE_INDEX_UNREADABLE_STATE = false;
let courseIndexInFlight = false;
let courseIndexGeneration = 0;

/**
 * Search memory belongs to the learner whose service reads populated it.
 *
 * The visible drafts already crossed through `forgetLocalDrafts` and
 * `adoptLocalDraftOwner`; the course index did not. On a shared browser that
 * let the next account search course titles from the previous account without
 * even asking `/courses`. Incrementing the generation also makes an older
 * in-flight read harmless if it answers after the account boundary.
 */
function resetCourseSearchIndex(): void {
  courseIndexGeneration += 1;
  COURSE_INDEX = null;
  PLAN_SEARCH_INDEX = [];
  COURSE_INDEX_UNREADABLE_STATE = false;
  courseIndexInFlight = false;
}

/**
 * The Pending card's one model action.
 *
 * The board stays put while the lesson is written and independently checked.
 * Only a ready answer opens Learn, so the learner never arrives on the lesson
 * page merely to watch the product manufacture the thing it called a lesson.
 * Send is a sibling control and remains fully independent throughout.
 */
async function runPendingLesson(
  card: HTMLElement, lesson: PendingBoardLesson, label: string,
  button: HTMLButtonElement,
): Promise<void> {
  await coordinatePendingLesson(card, lesson, button, {
    restingLabel: BOARD_RUN_THEN_LEARN,
    onScreen,
    run: () => apiResult<ForegroundQuickTakeReply>(
      `/pins/${encodeURIComponent(lesson.pinId)}/quick-take?minutes=${lesson.minutes}`,
      { method: 'POST' },
    ),
    open: (result) => renderForegroundQuickTake(
      handoffFor(lesson.pinId, label, Date.now()), lesson.minutes,
      { pinId: lesson.pinId, result },
    ),
    failureLine: (result) => quickTakeFailedLine(failureOf(result)),
  });
}

/**
 * A topic, as a thing on a board rather than a row in a list.
 *
 * A topic draws its label, count, and summary; without the summary it reads as
 * a list entry rather than a board card. The
 * `summary` — the one field that says what the topic is actually about — was
 * returned by `GET /board` and rendered nowhere. Seven subjects somebody chose
 * for themselves read as seven index entries.
 *
 * There is no comfort on the card and no percentage.  is that comfort is
 * never shown as a number, and a bar is a number drawn sideways; a board you
 * can score is a board you can fall behind on, which is the one thing this
 * product exists not to be.
 */
function topicCard(
  t: Topic, mark?: string, inLesson = false, pendingLesson: PendingBoardLesson | null = null,
): HTMLElement {
  const view = boardCard(t);
  const node = el(`<article class="card" data-state="${esc(pendingLesson ? 'pending' : view.state)}" data-guide-section="topic">
    <div class="card-head">
      <button class="disclose" data-disclose aria-expanded="false"></button>
      <button class="label" data-open></button>
    </div>
    <p class="tonight"></p>
    <p class="gist"></p>
    <p class="flag-note"></p>
    <p class="count"></p>
    <div class="row card-actions"></div>
    <p class="run-status" role="status" aria-live="polite"></p>
    <div class="send-menu"></div>
    <div class="pins"></div>
    <div class="repair-form"></div>
  </article>`);
  const label = node.querySelector('[data-open]') as HTMLElement;
  label.textContent = view.label;
  /**
   * TWO PRESSES ON ONE CARD, EACH SAYING WHAT IT IS.
   *
   * The title press is the high-consequence one: on a topic tonight's lesson
   * carries it leaves the board and opens that lesson, and on every other topic
   * it opens the pins underneath. It had no affordance at rest and no promise
   * about either, so both doors were discovered by pressing. The interface-affordance contract forbids
   * a sentence explaining them, and the house already has the answer: the
   * lineup's own lesson names are links whose underline arrives under the
   * cursor, and every icon control on that row carries its sentence as its
   * accessible name and its tooltip. Same treatment here, and the sentence is
   * written per case, because a label that named the lesson door on a topic with
   * no lesson tonight would be true half the time.
   *
   * The triangle is its own button with its own name for the same reason. It was
   * a `::before` marker on the title, which is a picture of a control drawn on a
   * different control.
   */
  const door = boardTitleDoorLine(view.label, inLesson);
  label.setAttribute('aria-label', door);
  label.setAttribute('title', door);
  const disclose = node.querySelector('[data-disclose]') as HTMLButtonElement;
  disclose.setAttribute('aria-label', BOARD_PINS_TOGGLE);
  disclose.setAttribute('title', BOARD_PINS_TOGGLE);
  // The night's decision, on the subjects it was made about. Absent rather than
  // empty, like the summary and the flag below it.
  const tonight = node.querySelector('.tonight') as HTMLElement;
  if (inLesson) tonight.textContent = BOARD_IN_LESSON; else tonight.remove();
  const gist = node.querySelector('.gist') as HTMLElement;
  // Absent rather than empty: a topic whose summary never arrived should not
  // leave a card with a hole in it where a sentence goes.
  if (view.gist) gist.textContent = view.gist; else gist.remove();
  // The mark, where the thing it is about is. Absent rather than empty, like
  // the summary above it: a card with a blank line reserved for a flag it does
  // not carry is a card with a hole in it.
  const flag = node.querySelector('.flag-note') as HTMLElement;
  if (mark) flag.textContent = mark; else flag.remove();
  (node.querySelector('.count') as HTMLElement).textContent = view.count;

  const pins = node.querySelector('.pins') as HTMLElement;
  const host = node.querySelector('.repair-form') as HTMLElement;

  /**
   * A topic opens onto the pins inside it.
   *
   * The board is where every failure screen sends a learner — "It is saved and
   * it is on your board" — and it showed them a count and no way to see either
   * of the things it was counting. A count is not evidence that the thing they
   * saved is there.
   *
   * The repair controls come with it rather than sitting on every row. Merge
   * and Split are rare operations on a topic the Clusterer got wrong; on a
   * board of seven they were fourteen underlined links, the most repeated thing
   * on the screen and level with the subjects themselves.
   */
  let open = false;
  const disclosure = async (): Promise<void> => {
    open = !open;
    node.className = open ? 'card open' : 'card';
    disclose.setAttribute('aria-expanded', String(open));
    if (!open) { pins.replaceChildren(); host.replaceChildren(); return; }

    pins.replaceChildren(thinking(LOADING_PINS));
    const got = await api<{ pins: { id: string; title: string; gist: string }[] }>(
      `/topics/${encodeURIComponent(t.id)}/pins`);
    pins.replaceChildren();
    // Told apart, like everywhere else: a topic with nothing readable in it and
    // a service that did not answer are different facts about somebody's work.
    if (!got) { pins.append(el(`<p class="empty">${esc(boardPinsUnreadableLine())}</p>`)); return; }
    // A filed pin is a door too. Being inside a topic changes where the
    // evidence sits and not what it is, so the row opens the same take the
    // card on Get Started opens, through the same control.
    for (const pin of got.pins ?? []) {
      const row = el(`<div class="pin"><button class="pin-title"></button><div class="gist"></div>
        <div class="row pin-actions"><button class="link" data-details>Details</button></div></div>`);
      const title = row.querySelector('.pin-title') as HTMLElement;
      title.textContent = pin.title || 'Untitled page';
      title.addEventListener('click', () => openTake(pin.id, pin.title || null));
      const details = row.querySelector('[data-details]') as HTMLButtonElement;
      details.setAttribute('data-pin-details', pin.id);
      details.addEventListener('click', () => openPinDetails(pin.id, pin.title || null));
      (row.querySelector('.gist') as HTMLElement).textContent = pin.gist;
      pins.append(row);
    }

    const repair = el(`<div class="row repair">
      <button class="link" data-merge>Merge into…</button>
      <button class="link" data-split>Split…</button>
    </div>`);
    const merge = repair.querySelector('[data-merge]') as HTMLButtonElement;
    const split = repair.querySelector('[data-split]') as HTMLButtonElement;
    merge.addEventListener('click', () => mergeFlow(host, t, boardSiblings(t), merge));
    split.addEventListener('click', () => void splitFlow(host, t, split));
    pins.append(repair);
  };
  disclose.addEventListener('click', () => void disclosure());
  // The lesson first, when there is one — the disclosure is what is left for
  // topics the session does not carry tonight, and it is what the triangle
  // beside this always does.
  const openTopic = (): void => { if (!lessonOnBoard(t.id)) void disclosure(); };
  label.addEventListener('click', openTopic);

  /**
   * Learn and Send are explicit controls.
   *
   * `Learn` is the title door with a name on it for a prepared lesson. A topic
   * in Pending is different: its button says **Run then learn**, the board stays
   * visible while generation and verification run, and only the cleared result
   * opens the ordinary Learn surface. The title itself remains the evidence
   * disclosure, so running paid model work is never hidden in a topic-name tap.
   *
   * For every other topic, `Learn` is the title door: the same call, so there is one
   * behaviour and not two that have to be kept in step. The title keeps working
   * because a thing that reads like a link should behave like one; what changes
   * is that the board no longer requires anybody to discover that by pressing.
   *
   * `Send` is new, and it is the board's half of the four destinations a lesson
   * already offers. It costs nothing to draw: what it will carry is decided
   * from the session already in hand and the count already on the card.
   */
  const actions = node.querySelector('.card-actions') as HTMLElement;
  const learn = el(`<button data-card-learn></button>`) as HTMLButtonElement;
  if (pendingLesson) {
    const runDoor = `Write and check a ${pendingLesson.minutes}-minute lesson on ${view.label}, then open it in Learn`;
    learn.textContent = BOARD_RUN_THEN_LEARN;
    learn.setAttribute('title', runDoor);
    learn.setAttribute('aria-label', runDoor);
    learn.addEventListener('click', () => void runPendingLesson(node, pendingLesson, view.label, learn));
  } else {
    learn.textContent = BOARD_LEARN;
    learn.setAttribute('title', door);
    learn.setAttribute('aria-label', door);
    learn.addEventListener('click', openTopic);
  }
  actions.append(learn);

  const menuHost = node.querySelector('.send-menu') as HTMLElement;
  const send = el(`<button data-card-send></button>`) as HTMLButtonElement;
  send.textContent = BOARD_SEND;
  send.setAttribute('title', BOARD_SEND_TITLE);
  send.setAttribute('aria-label', BOARD_SEND_TITLE);
  send.setAttribute('aria-expanded', 'false');
  send.addEventListener('click', () => {
    if (menuHost.firstElementChild) {
      menuHost.replaceChildren();
      send.setAttribute('aria-expanded', 'false');
      send.focus();
      return;
    }
    send.setAttribute('aria-expanded', 'true');
    menuHost.append(sendMenu(t, view.label));
  });
  actions.append(send);
  return node;
}

/**
 * THE BOARD'S SEND POPUP, AND THE TWO THINGS IT REFUSES TO PRETEND.
 *
 * **It says what it is carrying.** A prepared lesson when the session has one
 * for this subject, and what the learner saved when it does not. Those are
 * different payloads with different prompts behind them (`tutorForwardTarget`
 * against `topicForwardTarget`), and a control that offered the same four words
 * over either would be hiding the difference that matters most.
 *
 * **It offers Google Notebook only where that document is about this.** The
 * learn now document is written from the lesson in front of the learner. A push
 * from a card the session is not teaching would rewrite it about something else
 * and then open it, which is the one failure that hand-off cannot see from the
 * inside. So the fourth destination is absent for every other card and the
 * popup says why: truthfulness beats symmetry.
 *
 * Drawing it makes no request. The saved pages are read on the press that
 * actually sends them, which is also the only press that needs them.
 */
function sendMenu(t: Topic, label: string): HTMLElement {
  const node = el(`<div class="send-choices">
    <p class="meta send-carrying"></p>
    <div class="row send-routes"></div>
    <p class="meta send-note"></p>
    <div class="send-out" role="status" aria-live="polite"></div>
  </div>`);
  const carrying = node.querySelector('.send-carrying') as HTMLElement;
  const routes = node.querySelector('.send-routes') as HTMLElement;
  const note = node.querySelector('.send-note') as HTMLElement;
  const out = node.querySelector('.send-out') as HTMLElement;

  const section = boardLessonFor(t.id);
  const saved = t.pinIds?.length ?? 0;
  carrying.textContent = section ? SEND_CARRIES_LESSON
    : saved ? SEND_CARRIES_SAVED : SEND_CARRIES_NOTHING;
  // Nothing to carry is not a row of disabled buttons. A card with nothing
  // saved on it has nothing to send, and the line above says so.
  if (!section && !saved) { note.remove(); return node; }

  // The document is about the lesson in front of the learner, so it is offered
  // on that card and nowhere else. See the note above.
  const notebook = section !== null && boardLessonIsCurrent(t.id);
  if (notebook) note.remove(); else note.textContent = SEND_NO_NOTEBOOK;

  const press = async (where: ForwardWhere): Promise<void> => {
    out.replaceChildren();
    try {
      let carriesBody: boolean;
      if (section) {
        const brief = boardBriefFor(section);
        if (where === 'copy') {
          const payload = tutorClipboardPrompt(brief, section.question?.prompt ?? null, section.body);
          await navigator.clipboard.writeText(payload.text);
          carriesBody = payload.carriesBody;
        } else {
          const target = tutorForwardTarget(brief, section.question?.prompt ?? null, section.body);
          if (where === 'beside') await openBeside(target.url); else await openBrowserTab(target.url);
          carriesBody = target.carriesBody;
        }
      } else {
        // Read on the press, because this is the press that needs them. A popup
        // that fetched on open would cost a request per card somebody looked at.
        const body = await savedPagesFor(t.id);
        if (where === 'copy') {
          const payload = topicClipboardPrompt(label, t.summary ?? null, body);
          await navigator.clipboard.writeText(payload.text);
          carriesBody = payload.carriesBody;
        } else {
          const target = topicForwardTarget(label, t.summary ?? null, body);
          if (where === 'beside') await openBeside(target.url); else await openBrowserTab(target.url);
          carriesBody = target.carriesBody;
        }
      }
      // After the thing actually happened, exactly as the lesson rail records
      // its own four presses. A row for a send that failed would put a question
      // on the External face about something that never left.
      await recordExternal({
        kind: section ? 'lesson' : 'material',
        label: section ? section.heading : label,
        destination: FORWARD_DESTINATION[where],
        topicId: t.id,
        sessionId: section ? learnMount?.session?.id ?? null : null,
      });
      out.append(el(`<div class="meta forwarded">${esc(tutorForwardedLine(carriesBody, where))}</div>`));
    } catch {
      out.append(el(`<div class="meta">${esc(tutorOpenFailedLine(where))}</div>`));
    }
  };

  for (const [where, routeLabel] of [
    ['tab', TUTOR_FORWARD_LABEL], ['beside', TUTOR_BESIDE_LABEL], ['copy', TUTOR_COPY_LABEL],
  ] as const) {
    const btn = el(`<button data-card-route="${where}"></button>`) as HTMLButtonElement;
    btn.textContent = routeLabel;
    const title = tutorRouteTitle(where);
    btn.setAttribute('title', title);
    btn.setAttribute('aria-label', title);
    btn.addEventListener('click', () => press(where));
    routes.append(btn);
  }
  if (notebook) routes.append(notebookRoute(
    out, section as Section, learnMount?.session?.id ?? null,
  ));
  return node;
}

/** The section tonight's stored session carries for this subject, or null. The
 *  same read `lessonOnBoard` makes, so the card's two controls cannot disagree
 *  about whether there is a lesson behind it. */
const boardLessonFor = (topicId: string): Section | null =>
  learnMount?.session?.sections?.find((s) => s.topicId === topicId) ?? null;

/**
 * Whether this subject is the lesson actually in front of the learner.
 *
 * Narrower than `boardLessonFor` on purpose, and only the notebook destination
 * asks: `learn-now` is written from the session's current section, so it is
 * about this subject exactly when the resume point is this subject.
 */
function boardLessonIsCurrent(topicId: string): boolean {
  const session = learnMount?.session;
  if (!session) return false;
  const at = session.currentSectionIndex ?? 0;
  return session.sections?.[at]?.topicId === topicId;
}

/** The lesson's own brief, built the one way it is built. Lifted out of
 *  `geminiRoutes` when the board grew a second caller: two constructions of one
 *  payload is how two surfaces come to send different prompts. */
const boardBriefFor = (section: Section): TutorBrief => ({
  heading: section.heading,
  summary: lineupSummary(section.summary),
  depth: section.depth,
  course: section.subject?.title ?? null,
  serves: section.serves?.title ?? null,
  next: null,
});

/**
 * What the learner saved on a subject, as the body of a forwarded prompt.
 *
 * One read, on the press. A subject whose pins will not load carries no body
 * rather than an apology: `topicForwardTarget` already has an honest prompt for
 * that case, and it is the same one an over-long list produces.
 */
async function savedPagesFor(topicId: string): Promise<string | null> {
  const got = await api<{ pins: { id: string; title: string; gist: string }[] }>(
    `/topics/${encodeURIComponent(topicId)}/pins`);
  const lines = (got?.pins ?? [])
    .map((pin) => [pin.title || 'Untitled page', pin.gist].filter(Boolean).join(': '))
    .filter(Boolean);
  return lines.length ? lines.join('\n') : null;
}

/** Merge offers the other topics on the board. Held here because the card no
 *  longer closes over the filtered list it was drawn from — merging into a
 *  topic the search happened to be hiding is still a legitimate repair. */
let boardTopics: readonly Topic[] = [];
const boardSiblings = (t: Topic): Topic[] => boardTopics.filter((o) => o.id !== t.id) as Topic[];

/**
 * Split and merge — the learner's repair control.
 *
 * The nightly clusterer never moves a pin that already has a topic, which is
 * what stops the board reshuffling overnight and is also why it cannot fix its
 * own mistakes. These two controls are the only way a wrong merge comes apart
 * or a wrong split comes together, so they are deliberately plain: a link, a
 * choice, and a sentence saying exactly what is about to happen to the history
 * before anything happens to it. This is a trust control, not a feature — it
 * lives at the bottom of a topic on the second screen and looks like it.
 */
function confirmStep(
  host: HTMLElement, lines: readonly string[], verb: string, go: () => Promise<void>,
  returnFocus: HTMLElement | null = null,
  beforeReturn: (() => void) | null = null,
): void {
  host.replaceChildren();
  const box = el(`<div class="confirm">
    ${lines.map((l) => `<div>${esc(l)}</div>`).join('')}
    <div class="row"><button class="primary" data-go>${esc(verb)}</button><button class="link" data-cancel>Cancel</button></div>
    <p class="confirm-status"></p>
  </div>`);
  const btn = box.querySelector('[data-go]') as HTMLButtonElement;
  const cancel = box.querySelector('[data-cancel]') as HTMLButtonElement;
  const status = box.querySelector('.confirm-status') as HTMLElement;
  if (host.getAttribute('role') !== 'status') {
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
  }
  btn.addEventListener('click', async () => {
    box.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    cancel.disabled = true;
    status.textContent = `${verb}…`;
    await go();
    if (box.parentElement) {
      box.removeAttribute('aria-busy');
      btn.disabled = false;
      cancel.disabled = false;
      btn.focus();
    }
  });
  cancel.addEventListener('click', () => {
    host.replaceChildren();
    beforeReturn?.();
    returnFocus?.focus();
  });
  host.append(box);
  btn.focus();
}

function mergeFlow(
  host: HTMLElement, topic: Topic, others: readonly Topic[], launcher: HTMLElement,
): void {
  host.replaceChildren();
  if (!others.length) {
    const status = el(`<p class="empty" role="status" tabindex="-1">There is nothing else on the board to merge into yet.</p>`);
    host.append(status);
    status.focus();
    return;
  }
  const form = el(`<div class="repair-choice">
    <label>Merge <b>${esc(topic.label)}</b> into</label>
    <select>${others.map((o) => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('')}</select>
    <div class="row"><button data-next>Continue</button><button class="link" data-cancel>Cancel</button></div>
  </div>`);
  const select = form.querySelector('select') as HTMLSelectElement;
  form.querySelector('[data-cancel]')!.addEventListener('click', () => {
    host.replaceChildren();
    launcher.focus();
  });
  form.querySelector('[data-next]')!.addEventListener('click', () => {
    const into = others.find((o) => o.id === select.value);
    if (!into) return;
    confirmStep(host, mergeConfirmLines(topic, into), 'Merge', async () => {
      const r = await api(`/topics/${encodeURIComponent(topic.id)}/merge`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ into: into.id }),
      });
      if (!r) {
        const failure = el(`<p class="empty" role="alert" tabindex="-1">That didn't go through. Nothing changed.</p>`);
        host.replaceChildren(failure);
        failure.focus();
        return;
      }
      await redrawBoardFace('Topics merged.');
    }, launcher);
  });
  host.append(form);
  select.focus();
}

async function splitFlow(host: HTMLElement, topic: Topic, launcher: HTMLElement): Promise<void> {
  host.replaceChildren(thinking(LOADING_SPLIT_PINS));
  const data = await api<{ pins: { id: string; title: string; gist: string }[] }>(
    `/topics/${encodeURIComponent(topic.id)}/pins`);
  /**
   * Told apart, exactly as the card two hundred lines up tells them apart.
   *
   * `data?.pins ?? []` collapsed a service that did not answer into a topic
   * with nothing in it, and both came out of this function as the same
   * sentence: *"A topic needs at least two things pinned before it can be
   * split."* So a learner standing in front of a downed service was told what
   * they had pinned, which is the one claim the read had just failed to make —
   * on the screen where they are trying to repair the history they built.
   */
  if (!data) {
    const status = el(`<p class="empty" role="alert" tabindex="-1">${esc(boardPinsUnreadableLine())}</p>`);
    host.replaceChildren(status);
    status.focus();
    return;
  }
  const pins = data.pins ?? [];
  if (!splittable(pins.length)) {
    const status = el(`<p class="empty" role="status" tabindex="-1">A topic needs at least two things pinned before it can be split.</p>`);
    host.replaceChildren(status);
    status.focus();
    return;
  }
  const form = el(`<div class="repair-choice">
    <label>Move these out of <b>${esc(topic.label)}</b></label>
    ${pins.map((p) => `<label class="pick">
      <input type="checkbox" value="${esc(p.id)}">
      <span><b>${esc(p.title)}</b> ${esc(p.gist)}</span>
    </label>`).join('')}
    <label>and call the new topic</label>
    <input class="name" type="text" placeholder="What is this actually about?">
    <p class="meta topic-name-limit"></p>
    <div class="row"><button data-next>Continue</button><button class="link" data-cancel>Cancel</button></div>
    <div class="note" role="alert"></div>
  </div>`);
  const name = form.querySelector('.name') as HTMLInputElement;
  (form.querySelector('.topic-name-limit') as HTMLElement).textContent = TOPIC_LABEL_LIMIT_LINE;
  const note = form.querySelector('.note') as HTMLElement;
  form.querySelector('[data-cancel]')!.addEventListener('click', () => {
    host.replaceChildren();
    launcher.focus();
  });
  form.querySelector('[data-next]')!.addEventListener('click', () => {
    const chosen = Array.from(form.querySelectorAll('input[type=checkbox]'))
      .filter((c) => (c as HTMLInputElement).checked)
      .map((c) => (c as HTMLInputElement).value);
    const label = name.value.trim();
    // Refused here as well as in the store, so the learner finds out before the
    // confirm step rather than after it. Taking everything is a rename.
    const refusal = splitRefusal(chosen.length, pins.length, label);
    if (refusal) {
      note.textContent = refusal;
      if (chosen.length > 0 && chosen.length < pins.length) name.focus();
      return;
    }
    confirmStep(host, splitConfirmLines(topic, chosen.length, pins.length, label), 'Split', async () => {
      const r = await api(`/topics/${encodeURIComponent(topic.id)}/split`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pinIds: chosen, label }),
      });
      if (!r) {
        const failure = el(`<p class="empty" role="alert" tabindex="-1">That didn't go through. Nothing changed.</p>`);
        host.replaceChildren(failure);
        failure.focus();
        return;
      }
      await redrawBoardFace('New topic created.');
    }, launcher);
  });
  host.replaceChildren(form);
  (form.querySelector('input[type=checkbox]') as HTMLElement | null)?.focus();
}

/**
 *  — the quick take, the "now" moment of the three-moment loop.
 *
 * A screen of its own and deliberately not a zone. §5 fixes what the main page
 * is, and the take is not on it: there is no "learn something now" button on
 * the front door, because §3 says no surface may solicit taps to manufacture
 * engagement and that button is exactly that surface.
 *
 * Two doors reach it, and both are opened by the learner about a thing that is
 * already theirs. The toast, after capture, which is where the escalation has
 * always lived. And a **pin**, on the board or inside the topic that holds it
 * a piece of evidence they chose, on a screen they walked
 * to, asking for the passage in front of them to be explained. What §3 forbids
 * is a surface proposing work; neither of these proposes anything.
 *
 * Everything here is subordinate to a session on purpose. The standing
 * line says so in words; the markup says so by having none of the things a
 * verified section has — no register strip, no source count, no question.
 */
/**
 * Wait for the worker to write the pin id into the hand-off it already left.
 *
 * `storage.onChanged` rather than a poll: the write is one event and polling
 * for it would keep a panel busy through the whole of a slow capture. The
 * timeout is the honest end of it — past `AWAITING_PIN_TIMEOUT_MS` the pin did
 * not reach the service, and saying so beats a heading over nothing for ever.
 */
type AwaitedPin = { pinId: string | null; cause: GuideFailure | null };

async function awaitPin(since: number): Promise<AwaitedPin> {
  const read = (raw: unknown): AwaitedPin | null => {
    const h = pendingTake(raw, Date.now());
    if (h?.pinId) return { pinId: h.pinId, cause: null };
    if (h?.failure === 'post-failed') return { pinId: null, cause: 'not-saved' };
    return null;
  };

  const already = read((await chrome.storage.local.get(HANDOFF_KEY))?.[HANDOFF_KEY]);
  if (already) return already;

  return new Promise<AwaitedPin>((resolve) => {
    let done = false;
    const finish = (result: AwaitedPin): void => {
      if (done) return;
      done = true;
      chrome.storage.onChanged.removeListener(onChange);
      clearTimeout(timer);
      resolve(result);
    };
    const onChange = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
      if (area !== 'local' || !(HANDOFF_KEY in changes)) return;
      const next = read(changes[HANDOFF_KEY]?.newValue);
      if (next) finish(next);
    };
    const timer = setTimeout(() => finish({ pinId: null, cause: 'no-answer' }),
      Math.max(0, AWAITING_PIN_TIMEOUT_MS - (Date.now() - since)));
    chrome.storage.onChanged.addListener(onChange);
  });
}

/**
 * What the take was written from, as the learner sees it.
 *
 * A quotation, its source, and on a whole-page pin the sentence explaining why
 * the quotation looks like that. Deliberately not a card (the no-cards rule):
 * a rule down the left, muted text, no background, nothing that competes with
 * the take it introduces.
 *
 * Returns null when there is nothing honest to show. An empty block headed
 * "What you pinned" is worse than no block, because it reads as though the
 * pin captured nothing when the truth may be that an older service answered
 * without the field.
 */
function pinnedSource(
  pinned: { text: string; kind: string; pageTitle: string; url: string | null; note: string | null } | null,
): HTMLElement | null {
  const preview = pinnedPreview(pinned?.text ?? '');
  if (!preview.shown) return null;

  const node = el(`<div class="pinned">
    <div class="meta pinned-label">${esc(pinnedHeading(pinned!.kind))}</div>
    <blockquote></blockquote>
  </div>`);
  const quote = node.querySelector('blockquote') as HTMLElement;
  quote.textContent = preview.shown + (preview.rest ? '…' : '');

  // The fold, only where there is something folded. `textContent` on both
  // branches: this is page text and has never been anything else.
  if (preview.rest) {
    const more = el(`<button class="link more"></button>`);
    let open = false;
    more.textContent = PINNED_MORE;
    more.addEventListener('click', () => {
      open = !open;
      quote.textContent = open ? `${preview.shown} ${preview.rest}` : `${preview.shown}…`;
      more.textContent = open ? PINNED_LESS : PINNED_MORE;
    });
    node.append(more);
  }

  // The learner's own note outranks the page, so it sits closest to the quote.
  if (pinned!.note) {
    const own = el(`<div class="own-note"></div>`);
    own.textContent = `Your note: ${pinned!.note}`;
    node.append(own);
  }

  const title = (pinned!.pageTitle ?? '').replace(/\s+/g, ' ').trim();
  const href = safeHref(pinned!.url ?? undefined);
  if (title || href) {
    const from = el(`<div class="meta from">${href
      ? `<a href="${esc(href)}" target="_blank" rel="noreferrer noopener">${esc(title || 'Open source')}</a>`
      : esc(title)}</div>`);
    node.append(from);
  }

  const note = pinnedNote(pinned!.kind);
  if (note) {
    const why = el(`<div class="meta why"></div>`);
    why.textContent = note;
    node.append(why);
  }
  return node;
}

/**
 * The way out of a take, on the surface a board is on.
 *
 * The panel's exit is drawn by `frame` and says *Visit full site*, because a panel
 * holds one screen and the board is not in it. On the page the take was opened
 * from a pin somebody was looking at, so the honest destination is the board
 * they were looking at it on, and the control is named for it.
 *
 * At the end rather than at the top: on a page no screen opens with a bare
 * link any more, and the way back out of a room you were sent to belongs after
 * the thing you were sent for, which is where the burst already puts it.
 */
function boardExit(returnQuery: string | null = null): HTMLElement {
  const node = el(`<button class="link board-exit"></button>`);
  node.textContent = returnQuery ? 'Back to search results' : BOARD_EXIT;
  node.addEventListener('click', () => {
    if (returnQuery) void renderHome(null, null, 'board', returnQuery);
    else openBoardFace();
  });
  return node;
}

/** The same Learn-next read as a stored lesson, excluding the foreground
 * lesson itself rather than a Session section. */
function foregroundLearnNextRows(
  m: LearnMount, topicId: string | null, pinId: string,
): LearnNextRow[] {
  const primary = m.next?.primary ?? null;
  const others: LearnNextRow[] = learningAlternatives(m.next?.alternatives)
    .filter((alternative) => alternative.targetId !== topicId)
    .map((alternative) => ({
      label: alternative.title,
      minutes: alternative.minutes,
      press: () => {
        if (primary) recordPassedOver(primary, alternative);
        openAction(alternative, m.session);
      },
    }));
  return others.slice(0, 3);
}

/**
 * The full-page home for an immediate lesson.
 *
 * This deliberately does not promote the take into a Session. It keeps the
 * quick-take verdict and pin-question routes, but mounts their lesson into the
 * same card and rail the session uses. The distinction remains in storage and
 * disappears from navigation, where it never belonged.
 */
async function renderForegroundQuickTake(
  pending: Handoff,
  requestedMinutes: AvailableMinutes | null,
  prepared: {
    pinId: string; result: ApiResult<ForegroundQuickTakeReply>;
  } | null = null,
  savedWhere: 'board' | 'pins' = 'board',
): Promise<void> {
  if (!learnMount) await renderHome();
  let m = learnMount;
  if (!m) return;
  if (m.face !== 'learn') {
    await showFace('learn');
    m = learnMount;
    if (!m) return;
  }

  const waited: AwaitedPin = prepared
    ? { pinId: prepared.pinId, cause: null }
    : isAwaitingPin(pending)
      ? await awaitPin(pending.at)
      : { pinId: pending.pinId, cause: pending.failure === 'post-failed' ? 'not-saved' : null };
  const label = shortLabel(pending.label);
  const minutes = requestedMinutes ?? validMinutes(m.next?.availableMinutes);
  m.board.setAttribute('data-learning', 'yes');
  m.state = { at: null, close: false };
  m.mode = 'current';
  m.currentCard = null;
  m.currentRail = null;
  m.currentKind = null;
  m.currentRailState = null;
  updateLearnModeToggle(m);
  m.cardNode.setAttribute('data-kind', 'lesson');
  m.cardNode.replaceChildren();
  m.rail.replaceChildren(railKicker(minutes));
  m.columns.setAttribute('data-rail', 'yes');

  if (!prepared) {
    const loading = el(`<div class="section foreground-lesson loading">
      <h1 class="lesson-area" tabindex="-1"></h1><div class="body"></div>
    </div>`);
    (loading.querySelector('.lesson-area') as HTMLElement).textContent = label;
    (loading.querySelector('.body') as HTMLElement).append(thinking(LOADING_TAKE, true));
    m.cardNode.append(loading);
    (loading.querySelector('.lesson-area') as HTMLElement).focus();
  }

  const fail = (
    cause: GuideFailure, shownLabel: string, source: HTMLElement | null,
    retryPinId: string | null, refusal: Unreadable | null = null,
  ): void => {
    const face = el(`<div class="section foreground-lesson failed">
      <h1 class="lesson-area" tabindex="-1"></h1>
      <div class="foreground-source-slot"></div>
    </div>`);
    (face.querySelector('.lesson-area') as HTMLElement).textContent = shownLabel;
    if (source) {
      const details = el(`<details class="foreground-source" open>
        <summary class="link">Show source</summary><div class="foreground-source-body"></div>
      </details>`);
      (details.querySelector('.foreground-source-body') as HTMLElement).append(source);
      (face.querySelector('.foreground-source-slot') as HTMLElement).append(details);
    }
    const recovery = el(`<div class="rail-stack foreground-lesson-rail">
      <div class="rail-block teaching quick-take-recovery">
        <p role="alert"></p><p class="meta"></p><div class="row"></div>
      </div>
    </div>`);
    (recovery.querySelector('[role="alert"]') as HTMLElement).textContent = quickTakeFailedLine(cause);
    (recovery.querySelector('.meta') as HTMLElement).textContent = cause === 'unverified'
      ? withheldSourceLine(shownLabel, savedWhere) : savedPinLine(shownLabel, savedWhere);
    if (refusal) appendBudgetRecovery(recovery, refusal);
    const actions = recovery.querySelector('.row') as HTMLElement;
    if (cause === 'unverified') {
      const back = el('<button class="primary">Back to choices</button>') as HTMLButtonElement;
      back.addEventListener('click', () => void renderHome());
      actions.append(back);
    }
    if (cause === 'budget' || cause === 'credential') {
      const models = el('<button class="link">Open Models</button>') as HTMLButtonElement;
      models.addEventListener('click', () => void openModelsPage());
      actions.append(models);
    } else if (retryPinId) {
      const retry = el('<button class="link"></button>') as HTMLButtonElement;
      retry.textContent = cause === 'unverified' ? 'Write another version' : 'Try this lesson again';
      retry.addEventListener('click', () => void renderForegroundQuickTake(
        handoffFor(retryPinId, shownLabel, Date.now()), requestedMinutes, null, savedWhere,
      ));
      actions.append(retry);
    }
    m!.cardNode.replaceChildren(face);
    m!.rail.replaceChildren(railKicker(minutes), recovery);
    (face.querySelector('.lesson-area') as HTMLElement).focus();
  };

  if (!waited.pinId) {
    fail(waited.cause ?? 'no-answer', label, null, null);
    return;
  }
  const pinId = waited.pinId;
  const takePath = `/pins/${encodeURIComponent(pinId)}/quick-take`
    + (requestedMinutes === null ? '' : `?minutes=${requestedMinutes}`);
  const result = prepared?.result
    ?? await apiResult<ForegroundQuickTakeReply>(takePath, { method: 'POST' });
  if (result.kind !== 'ok') {
    fail(failureOf(result), label, null, pinId, result);
    return;
  }
  const answer = result.body;
  const shownLabel = shortLabel(answer.label ?? pending.label);
  const source = pinnedSource(answer.pinned ?? null);
  if (answer.outcome !== 'ready' || !answer.body) {
    fail(answer.outcome === 'unverified' ? 'unverified' : 'model', shownLabel, source, pinId);
    return;
  }

  const topicId = answer.topicId ?? null;
  const depth: Section['depth'] = answer.register === 'from-nothing'
    || answer.register === 'fluent' ? answer.register : 'building';
  const section: Section = {
    topicId: topicId ?? `pin:${pinId}`,
    heading: shortLabel(answer.heading ?? shownLabel),
    body: answer.body,
    depth,
    estimatedMinutes: minutes,
    sourceIds: [pinId],
    question: null,
    completed: false,
    topicLabel: answer.topicLabel ?? shownLabel,
    subject: answer.subject ?? null,
  };
  const title = lessonTitle(section.heading, subjectOf(section));
  const surfaces = foregroundLessonSurfaces({
    el,
    family: title.family,
    area: title.area,
    body: answer.body,
    source,
    learnNext: foregroundLearnNextRows(m, topicId, pinId),
    handoffs: geminiRoutes(section, null, null, topicId),
    ask: async (question: string, exchange: readonly ForegroundAskTurn[]) =>
      await api(`/pins/${encodeURIComponent(pinId)}/ask`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, exchange }),
      }),
    saveOffer: async (passage: string, question: string, clientRef: string) =>
      await api('/pins', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'interest', clientRef,
          envelope: {
            selection: passage, parts: [], surroundingText: question,
            headingPath: [], pageTitle: passage, url: 'virgil:ask',
          },
        }),
      }) !== null,
    answer: (verdict: QuickTakeVerdict) => api<QuickTakeCloseReply>(
      `/pins/${encodeURIComponent(pinId)}/quick-take/verdict`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict }),
      }),
    protectQuestion: (root, field) => {
      protectUnsentForm(root, 'quick-lesson question', [field], () => {
        field.value = '';
      }, () => {
        field.focus();
      });
    },
    closed: (receipt: string) => void renderHome(receipt).then(() => focusRoomStart()),
  });
  m.cardNode.replaceChildren(surfaces.face);
  m.rail.replaceChildren(railKicker(minutes), surfaces.panel);
  surfaces.heading.setAttribute('tabindex', '-1');
  surfaces.heading.focus();
}

async function renderQuickTake(
  pending: Handoff,
  returnQuery: string | null = null,
  requestedMinutes: AvailableMinutes | null = null,
  savedWhere: 'board' | 'pins' = 'board',
): Promise<void> {
  if (SURFACE === 'page') {
    await renderForegroundQuickTake(pending, requestedMinutes, null, savedWhere);
    return;
  }
  frame('take');

  // Headed with the label the toast used, so the screen says what it is about
  // before the take lands. Cut at render, the model-label contract: the label is model output
  // over pinned text, and this is a narrow single column.
  // The slot is drawn empty and filled when the service answers, because what
  // the take was written from arrives with the take. Appending into a slot
  // rather than inserting before the body keeps the order of this screen a
  // property of its markup, where it can be read.
  const node = el(`<div class="quick-take">
    <h1 tabindex="-1">${esc(shortLabel(pending.label))}</h1>
    <div class="pinned-slot"></div>
    <section class="take-lesson">
      <div class="take-label">Quick lesson</div>
      <div class="body"></div>
    </section>
  </div>`);
  roomContent.append(node);
  (node.querySelector('h1') as HTMLElement).focus();
  // Appended beside the take rather than into it, so it is the last thing in
  // the room on every path through this screen: the take that landed, and the
  // four that could not.
  const body = node.querySelector('.body') as HTMLElement;
  body.append(thinking(LOADING_TAKE, true));

  /**
   * The pin, which on the menu route does not exist yet.
   *
   * `mode-learn-now` opens this panel from inside the click that authorised
   * it, which is hundreds of milliseconds before the page has been captured
   * and the service has named an id. So the hand-off arrives with `pinId:
   * null` and the id is written into it when it lands. Waiting here rather
   * than anywhere else because this is the only screen that needs it, and
   * because the wait has a visible answer either way: the take, or the
   * sentence saying the pin never reached the service.
   */
  /**
   * The same five answers the guide screen gives, for the same reason.
   *
   * This screen is the guide's twin and had the identical defect: one sentence
   * for four different failures, naming the model for all of them, on the one
   * screen that tells the learner their pin is safe without saying where it is.
   * The same failure taxonomy keeps both twin surfaces consistent.
   */
  const giveUp = (
    cause: GuideFailure, label: string | null, saved: boolean, retryPinId: string | null = null,
    refusal: Unreadable | null = null,
  ): void => {
    body.replaceChildren();
    const said = el(`<p role="alert"></p>`);
    said.textContent = quickTakeFailedLine(cause);
    body.append(said);
    if (refusal) appendBudgetRecovery(body, refusal);
    if (!saved) return;
    const where = el(`<p class="meta"></p>`);
    where.textContent = cause === 'unverified'
      ? withheldSourceLine(label, savedWhere) : savedPinLine(label, savedWhere);
    body.append(where);
    if (cause === 'budget' || cause === 'credential') {
      const models = el(`<button class="link">Open Models</button>`);
      models.addEventListener('click', () => void openModelsPage());
      body.append(models);
    } else if (retryPinId) {
      const actions = el(`<div class="row quick-take-recovery"></div>`);
      if (cause === 'unverified') {
        const next = el(`<button class="primary">Back to choices</button>`);
        next.addEventListener('click', () => void renderHome());
        actions.append(next);
      }
      const retry = el(`<button class="link"></button>`);
      retry.textContent = cause === 'unverified' ? 'Write another version' : 'Try this lesson again';
      retry.addEventListener('click', () => {
        void renderQuickTake(
          handoffFor(retryPinId, label, Date.now()), returnQuery, requestedMinutes, savedWhere,
        );
      });
      actions.append(retry);
      body.append(actions);
    }
    // The panel's persistent Visit full site tool is already the board door.
    // Repeating it here as Open my board gives one destination two names on
    // the same 360px surface. On the full page `boardExit()` is already the
    // last thing in this room, so neither surface needs a second door here.
  };

  const waited: AwaitedPin = isAwaitingPin(pending)
    ? await awaitPin(pending.at)
    : { pinId: pending.pinId, cause: pending.failure === 'post-failed' ? 'not-saved' : null };
  if (!waited.pinId) {
    return giveUp(waited.cause ?? 'no-answer', pending.label, waited.cause !== 'not-saved');
  }
  const pinId = waited.pinId;
  // Still thinking, and now about a pin that exists.
  body.replaceChildren(thinking(LOADING_TAKE, true));

  const takePath = `/pins/${encodeURIComponent(pinId)}/quick-take`
    + (requestedMinutes === null ? '' : `?minutes=${requestedMinutes}`);
  const result = await apiResult<{
    outcome: string; body: string; label: string | null;
    pinned?: { text: string; kind: string; pageTitle: string; url: string | null; note: string | null };
  }>(takePath, { method: 'POST' });
  if (result.kind !== 'ok') {
    return giveUp(failureOf(result), pending.label, true, pinId, result);
  }
  const answer = result.body;

  // What the take was written from, above the take itself.
  //
  // Added the first day somebody used this for real: the screen was a model's
  // label over a model's prose with nothing of the learner's own on it, so
  // there was no way to tell a good explanation of the wrong passage from a
  // good explanation of the right one. It goes above rather than below because
  // it is the thing that makes the paragraphs beneath it readable, and reading
  // it after them is reading them twice.
  const pinnedNode = pinnedSource(answer?.pinned ?? null);
  if (pinnedNode) (node.querySelector('.pinned-slot') as HTMLElement).append(pinnedNode);

  // A request that never landed, a take the model could not write, and a take
  // the independent check withheld all leave no teaching to draw. Their causes
  // remain distinct because the last one is a product safety decision, not a
  // failed generation. None may expose verdict controls over an empty body.
  const took = answer?.outcome === 'ready' && !!answer.body;
  if (answer?.label) (node.querySelector('h1') as HTMLElement).textContent = shortLabel(answer.label);
  if (!took) {
    giveUp(answer?.outcome === 'unverified' ? 'unverified' : 'model',
      answer?.label ?? pending.label, true, pinId);
  } else {
    body.textContent = answer.body;
  }

  // Nothing to answer about. A learner who read nothing has nothing to report,
  // and a comfort signal collected from a blank screen would be a reading of a
  // passage nobody was ever shown.
  if (!took) return;

  /**
   * The exchange, which is the part that was missing.
   *
   * A box they can type in, three shortcuts for the things people ask most,
   * and the answers underneath. Bounded by size rather than by refusal: the
   * last few turns travel with each question, so the tenth costs what the
   * first did.
   *
   * Held here and nowhere else. It is a foreground artefact of one screen, and
   * writing a transcript to a board whose one-ledger law is about material
   * would be putting the wrong thing in it.
   */
  const turns: { who: 'learner' | 'virgil'; text: string }[] = [];

  const exchange = el(`<div class="exchange"></div>`);
  const asker = el(`<div class="ask">
    <div class="take-label">Shape this explanation</div>
    <div class="row shortcuts">
      ${ASK_SHORTCUTS.map((sc) => `<button data-shortcut="${esc(sc.key)}">${esc(sc.label)}</button>`).join('')}
    </div>
    <label class="ask-label" for="quick-take-question">Ask a follow-up</label>
    <div class="row field">
      <input id="quick-take-question" class="ask-box" type="text" />
      <button data-send></button>
    </div>
    <div class="meta input-limit">Up to 1,200 characters. Sending makes one API call to your configured model.</div>
    <div class="meta ask-status" role="status" aria-live="polite"></div>
  </div>`);
  const box = asker.querySelector('.ask-box') as HTMLInputElement;
  const send = asker.querySelector('[data-send]') as HTMLButtonElement;
  const askStatus = asker.querySelector('.ask-status') as HTMLElement;
  box.setAttribute('placeholder', ASK_PLACEHOLDER);
  send.textContent = ASK_SEND;

  /**
   * the close, which is what makes this screen a surface rather than a
   * page. Built in `quick-take-close.ts`; the room only says where the tap goes
   * and what to do once it has landed.
   */
  const close = quickTakeClose({
    el,
    busy: () => interactionPending,
    setBusy: (pending) => setInteractionPending(pending),
    answer: (choice: QuickTakeVerdict) => api<QuickTakeCloseReply>(
      `/pins/${encodeURIComponent(pinId)}/quick-take/verdict`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: choice }),
      }),
    closed: (receipt) => void renderHome(receipt).then(() => focusRoomStart()),
  });
  const shortcutButtons = Array.from(asker.querySelectorAll('[data-shortcut]')) as HTMLButtonElement[];
  const verdictButtons = close.buttons;
  const said = close.said;
  let interactionPending = false;
  let failedAttempt: {
    question: string; questionNode: HTMLElement; replyNode: HTMLElement;
  } | null = null;

  const setInteractionPending = (pending: boolean): void => {
    interactionPending = pending;
    send.disabled = pending;
    box.disabled = pending;
    for (const button of shortcutButtons) button.disabled = pending;
    for (const button of verdictButtons) button.disabled = pending;
    if (pending) node.setAttribute('aria-busy', 'true');
    else node.removeAttribute('aria-busy');
  };

  const ask = async (question: string): Promise<void> => {
    if (interactionPending) return;
    const asked = question.trim();
    if (!asked) return;
    const questionChars = unicodeChars(asked);
    if (questionChars > PANEL_ASK_MAX_CHARS) {
      askStatus.textContent = `That question is ${questionChars.toLocaleString('en-US')} characters. `
        + 'Keep it to 1,200 so I can read all of it. Nothing was sent.';
      box.focus();
      return;
    }
    if (failedAttempt?.question === asked) {
      failedAttempt.questionNode.remove();
      failedAttempt.replyNode.remove();
      failedAttempt = null;
    }
    const draftBefore = box.value;
    const manualQuestion = draftBefore.trim() === asked;
    askStatus.textContent = '';
    setInteractionPending(true);

    // Theirs on screen immediately: a question that vanishes into a spinner is
    // a question they cannot check was heard.
    const mine = el(`<div class="turn learner"><div class="who"></div><div class="what"></div></div>`);
    (mine.querySelector('.who') as HTMLElement).textContent = ASK_YOU;
    (mine.querySelector('.what') as HTMLElement).textContent = asked;
    exchange.append(mine);

    const wait = thinking(LOADING_ASK, true);
    exchange.append(wait);

    const answer = await api<{ outcome: string; body: string; offerAsPin: string | null }>(
      `/pins/${encodeURIComponent(pinId)}/ask`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: asked, exchange: turns }),
      });
    wait.remove();
    setInteractionPending(false);

    const reply = el(`<div class="turn virgil"><div class="what"></div><div class="offer"></div></div>`);
    const what = reply.querySelector('.what') as HTMLElement;
    const ok = answer?.outcome === 'ready' && !!answer.body;
    what.textContent = ok ? answer!.body : askFailedLine();
    exchange.append(reply);

    if (!ok) {
      failedAttempt = { question: asked, questionNode: mine, replyNode: reply };
      if (manualQuestion) box.value = draftBefore;
      box.focus();
      return;
    }
    if (manualQuestion) box.value = '';
    turns.push({ who: 'learner', text: asked }, { who: 'virgil', text: answer!.body });

    //  route back to the pin mechanic, and the half of it worth
    // keeping: an answer is one screen, a subject is something the fleet
    // should build properly. Offered, never substituted for the answer.
    if (answer!.offerAsPin) {
      const offer = reply.querySelector('.offer') as HTMLElement;
      const line = el(`<span class="meta"></span>`);
      line.textContent = offerAsPinLine(answer!.offerAsPin);
      const put = el(`<button class="link"></button>`) as HTMLButtonElement;
      // One learner gesture owns one opaque receipt. Deriving this from the
      // pin and in-memory turn count aliases a different offer after the panel
      // is reopened; retaining it in this closure also makes a lost response
      // safely retry the write that may already have landed.
      const offerClientRef = newClientRef();
      put.textContent = OFFER_AS_PIN_ACTION;
      put.addEventListener('click', async () => {
        put.disabled = true;
        line.textContent = 'Putting it on the board…';
        const made = await api<{ id: string }>('/pins', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'interest',
            clientRef: offerClientRef,
            envelope: {
              selection: answer!.offerAsPin, parts: [], surroundingText: asked,
              // Same shape as the Check room's offer, and for the same reason:
              // `url: null` is a 400 from `pinRequestFrom`, which means this
              // offer had never once landed a pin until the Check room's twin
              // of it failed live and both were fixed together.
              headingPath: [], pageTitle: answer!.offerAsPin, url: 'virgil:ask',
            },
          }),
        });
        if (!made) {
          put.disabled = false;
          line.textContent = "That didn't go through. Nothing changed.";
          put.focus();
          return;
        }
        put.remove();
        line.textContent = OFFER_AS_PIN_DONE;
      });
      offer.append(line, put);
    }
  };

  for (const shortcut of ASK_SHORTCUTS) {
    // Pressed, and it happens. The first build put the question in the box and
    // waited for a second press, on the reasoning that a learner should see
    // what is being sent. A shortcut that
    // costs two presses is not one, and what was sent is on screen a moment
    // later as their own turn anyway, which is where it can be read.
    asker.querySelector(`[data-shortcut=${shortcut.key}]`)!
      .addEventListener('click', () => void ask(shortcut.question));
  }
  send.addEventListener('click', () => void ask(box.value));
  box.addEventListener('input', () => { askStatus.textContent = ''; });
  box.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void ask(box.value);
  });

  // Last in the room and below the take, because it is the answer to something
  // that has to have been read first. Nothing is written until one is pressed:
  // a learner who closes the panel here has answered nothing, and the board
  // records nothing, which is the honest reading of walking away.
  const closing = el(`<section class="take-close">
    <div class="take-label">What should Virgil do next?</div>
    <p class="meta">Your answer changes what comes back into your learning plan.</p>
  </section>`);
  closing.append(close.row, said);
  node.append(exchange, asker, closing);
}

/**
 * `mode-guide-me`: the task, one step at a time.
 *
 * Same rails as the quick take, including the wait for a pin the worker is
 * still making, and the same standing line saying what this is and is not.
 * What differs is that the answer is walked rather than read.
 *
 * The list is held here and nowhere else. It is a foreground artefact of one
 * screen, and writing it to the ledger would put a second copy of the night's
 * material in a store whose one-ledger law exists to prevent exactly that. The
 * one thing that IS written is the signal when a learner says they are stuck,
 * which is the strongest negative evidence this product can collect short of a
 * wrong answer, and which is the reason the mode earns its place at all.
 */
async function renderGuide(pending: Handoff): Promise<void> {
  frame('guide');

  const node = el(`<div class="quick-take guide">
    <h1 tabindex="-1">${esc(shortLabel(pending.label))}</h1>
    <div class="pinned-slot"></div>
    <div class="progress meta"></div>
    <div class="steps"></div>
  </div>`);
  roomContent.append(node);
  (node.querySelector('h1') as HTMLElement).focus();
  const steps = node.querySelector('.steps') as HTMLElement;
  const progress = node.querySelector('.progress') as HTMLElement;
  steps.append(thinking(LOADING_GUIDE, true));

  const giveUp = (
    cause: GuideFailure, label: string | null, saved: boolean, retryPinId: string | null = null,
    refusal: Unreadable | null = null,
  ): void => {
    steps.replaceChildren();
    const said = el(`<p></p>`);
    said.textContent = guideFailedLine(cause);
    steps.append(said);
    if (refusal) appendBudgetRecovery(steps, refusal);
    if (saved) {
      const where = el(`<p class="meta"></p>`);
      where.textContent = savedPinLine(label);
      steps.append(where);
      if (cause === 'budget' || cause === 'credential') {
        const models = el(`<button class="link">Open Models</button>`);
        models.addEventListener('click', () => void openModelsPage());
        steps.append(models);
      } else if (retryPinId) {
        const retry = el(`<button class="link">Try this guide again</button>`);
        retry.addEventListener('click', () => {
          void renderGuide(handoffFor(retryPinId, label, Date.now(), 'guide'));
        });
        steps.append(retry);
      }
      // The panel already has Visit full site above every guide screen. The
      // page has no persistent panel tool, so it alone gets the local exit.
      if (SURFACE !== 'page') return;
      const go = el(`<button class="link"></button>`);
      go.textContent = 'Show me the board';
      go.addEventListener('click', () => void openMainPage());
      steps.append(go);
    }
  };

  // A hand-off that already carries a failure is not waiting for anything, so
  // it never reaches `awaitPin` and has to bring its own reason with it.
  const waited: AwaitedPin = isAwaitingPin(pending)
    ? await awaitPin(pending.at)
    : { pinId: pending.pinId, cause: pending.failure === 'post-failed' ? 'not-saved' : null };
  if (!waited.pinId) {
    // `post-failed` is the worker telling us the service never took it, which
    // is the only case here where the material is genuinely not on the board.
    return giveUp(waited.cause ?? 'no-answer', pending.label, waited.cause !== 'not-saved');
  }
  const pinId = waited.pinId;

  const answer = await apiResult<{
    outcome: string; steps: { action: string; why: string }[]; label: string | null;
    pinned?: { text: string; kind: string; pageTitle: string; url: string | null; note: string | null };
  }>(`/pins/${encodeURIComponent(pinId)}/guide`, { method: 'POST' });

  if (answer.kind !== 'ok') {
    return giveUp(failureOf(answer), pending.label, true, pinId, answer);
  }
  const body = answer.body;

  const pinnedNode = pinnedSource(body?.pinned ?? null);
  if (pinnedNode) (node.querySelector('.pinned-slot') as HTMLElement).append(pinnedNode);
  if (body?.label) (node.querySelector('h1') as HTMLElement).textContent = shortLabel(body.label);

  // Material with no subject in it and a model that failed are two different
  // facts and the learner is owed the difference: one is the page, and only
  // the other is us.
  if (body?.outcome === 'no-subject') { steps.textContent = guideNoSubjectLine(); return; }
  const list = body?.outcome === 'ready' ? (body.steps ?? []) : [];
  if (!list.length) { return giveUp('model', body?.label ?? pending.label, true, pinId); }

  steps.replaceChildren();
  let done = 0;
  let stuckCount = 0;
  let finished = false;
  const say = (): void => {
    progress.textContent = guideProgressLine(done + stuckCount, list.length, stuckCount);
  };
  const finish = (): void => {
    if (finished || done + stuckCount < list.length) return;
    finished = true;
    const receipt = guideFinishedLine(stuckCount);
    const end = el(`<div class="guide-finished">
      <p class="meta finished-note"></p>
      <button class="primary">Continue in Learn</button>
    </div>`);
    (end.querySelector('.finished-note') as HTMLElement).textContent = receipt;
    end.querySelector('button')!.addEventListener('click', async () => {
      await renderHome(receipt);
      focusRoomStart();
    });
    node.append(end);
  };
  say();

  for (const [index, step] of list.entries()) {
    const row = el(`<div class="step">
      <div class="what"></div>
      <div class="why meta"></div>
      <div class="row acts">
        ${GUIDE_CHOICES.map((c) => `<button data-act="${esc(c.verdict)}">${esc(c.label)}</button>`).join('')}
      </div>
      <div class="said"></div>
    </div>`);
    (row.querySelector('.what') as HTMLElement).textContent = `${index + 1}. ${step.action}`;
    (row.querySelector('.why') as HTMLElement).textContent = step.why;
    const said = row.querySelector('.said') as HTMLElement;
    const acts = row.querySelector('.acts') as HTMLElement;

    acts.querySelector('[data-act=done]')!.addEventListener('click', () => {
      acts.remove();
      row.className = 'step finished';
      done += 1;
      say();
      finish();
    });

    acts.querySelector('[data-act=stuck]')!.addEventListener('click', async () => {
      acts.remove();
      row.className = 'step stuck';
      stuckCount += 1;
      said.replaceChildren(thinking(LOADING_STUCK, true));
      const help = await api<{ outcome: string; body: string }>(
        `/pins/${encodeURIComponent(pinId)}/guide/stuck`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: step.action, why: step.why }),
        });
      said.replaceChildren();
      said.textContent = help?.outcome === 'ready' && help.body ? help.body : guideStuckFailedLine();
      say();
      finish();
    });

    steps.append(row);
  }
}

/**
 * Which screen this is.
 *
 * A current hand-off still owns the panel. Without one, the panel opens the
 * current lesson in Learn: useful beside whatever is being read, without
 * writing progress merely because the panel opened.
 *
 * Read once and cleared before the screen is drawn, so a reload is home rather
 * than the same take a second time.
 */
async function renderMainPageRoute(): Promise<void> {
  const route = mainPageRoute(typeof location === 'undefined' ? '' : location.hash);
  if (route === 'switch-user') return renderSignIn('switch-user');
  if (route === 'sign-out') {
    forgetLocalDrafts();
    await signOut();
    try { history.replaceState(null, '', mainPageHash('account')); } catch { /* a test/non-page runtime */ }
    return renderSignIn();
  }
  if (route === 'account') return renderAccountEntry();
  if (route === 'add-source') {
    STUDIES_ADD_ROUTE = 'syllabus';
    return renderCourses(null, true, null, null, false, '.source-text');
  }
  if (route === 'plan') return renderPlan();
  if (route === 'courses') return renderCourses();
  if (route === 'check') return renderCheck();
  if (route === 'insights') return renderModel();
  if (route === 'models') return renderSettings('models');
  if (route === 'privacy') return renderSettings('privacy');
  if (route === 'connections') return renderSettings('connections');
  if (route === 'data') return renderSettings('data');
  if (route === 'settings') return renderSettings();
  return renderHome();
}

async function boot(): Promise<void> {
  // Whatever agent is driving this browser, told what Virgil's four lanes are.
  // Not awaited: on the ordinary load with no agent behind it this is a property
  // read that answers null, and the screen must not queue behind it either way.
  void initWebMcp();

  // The theme first, before anything is drawn. A screen that paints in the
  // system's colours and then swaps to the learner's is a flash of the thing
  // they went out of their way to turn off.
  try {
    const got = await chrome.storage?.local?.get(THEME_KEY);
    const stored = got?.[THEME_KEY];
    // Anything unrecognised — an older build's value, a hand-edited entry —
    // reads as `system` rather than breaking the screen it is meant to colour.
    applyTheme(isTheme(stored) ? stored : 'system');
  } catch { /* not in the extension, or storage is unavailable: system it is */ }

  // The main page is the main page. It never draws somebody's pending take,
  // and it never consumes the hand-off out from under the panel that is
  // waiting for it: a learner who presses Learn it now and happens to have a
  // Virgil tab open must not lose the take to the tab.
  if (SURFACE === 'page') {
    await renderMainPageRoute();
    await restoreGuidePresentation();
    return;
  }

  let pending: Handoff | null = null;
  try {
    const got = await chrome.storage.local.get(HANDOFF_KEY);
    pending = pendingTake(got?.[HANDOFF_KEY], Date.now());
  } catch { /* not in the extension, or storage is unavailable: this is idle */ }

  if (pending) return HANDOFF_PRESENTATION.present(pending);
  const held = await currentCaptureSessionPins();
  if (held[0]) return renderCaptureReceipt(held[0].pinId, held[0].label);
  return renderHome(null, { at: null, close: false });
}

void boot();

// `pushState` does not fire this handler; only the learner moving through their
// browser history does. On that move, redraw the address that is now current.
if (SURFACE === 'page' && typeof window !== 'undefined') {
  window.addEventListener(WEBMCP_RECEIPT_EVENT, (event) => {
    const detail = (event as CustomEvent<WebMcpReceipt>).detail;
    if (!detail || (detail.kind !== 'draft' && detail.kind !== 'drop')) return;
    mountWebMcpReceipt(app, detail, el, () => guardNavigation(() => {
      void renderCourses().then(() => focusRoomStart());
    }));
  });
  let acceptNextHistoryMove = false;
  window.addEventListener('popstate', () => {
    if (acceptNextHistoryMove) {
      acceptNextHistoryMove = false;
      acceptedPageHash = location.hash;
      void renderMainPageRoute().then(() => focusRoomStart());
      return;
    }
    const target = location.hash;
    if (!mountedUnsentWork().length) {
      acceptedPageHash = target;
      void renderMainPageRoute().then(() => focusRoomStart());
      return;
    }
    // `popstate` is delivered after the address has moved. Restore the page
    // the learner is still looking at while they decide. If they discard, the
    // second Back returns to the exact history entry they originally chose;
    // it is not an invented redirect or a duplicate page transition.
    try { history.pushState(null, '', acceptedPageHash); } catch { /* non-page runtime */ }
    guardNavigation(() => {
      acceptNextHistoryMove = true;
      try { history.back(); } catch {
        acceptNextHistoryMove = false;
        try { history.replaceState(null, '', target); } catch { /* non-page runtime */ }
        acceptedPageHash = target;
        void renderMainPageRoute().then(() => focusRoomStart());
      }
    });
  });
  window.addEventListener('beforeunload', (event) => {
    if (!mountedUnsentWork().length && !hasPreservedDrafts()) return;
    event.preventDefault();
    // Browsers intentionally own this copy. Assigning a value is still needed
    // by older Chromium builds even though the displayed sentence is generic.
    (event as BeforeUnloadEvent).returnValue = '';
  });
}

async function renderPlan(
  focus: string | null = null, focusAfterWrite = false, openAdd = false,
  focusAddAction = false, completionReceipt: string | null = null,
  focusIntent: 'links' | null = null,
  returnQuery: string | null = null,
): Promise<void> {
  // Built before the frame, which clears the surface it would be appended to.
  const add = el(`<button class="primary" data-add-open>Add</button>`) as HTMLButtonElement;
  add.setAttribute('aria-expanded', 'false');
  add.setAttribute('aria-controls', 'plan-add-sheet');
  frame('plan', { title: 'Your plan', action: add });
  roomContent.setAttribute('data-guide-target', 'manage-surface');
  roomContent.setAttribute('data-guide-section', 'manage-state');
  const owner = roomOwnership();
  if (returnQuery) owner.content.append(boardExit(returnQuery));

  // `/session` names the prepared lesson and lets the tutor action open it.
  const [plan, context, todayRead, sessionRead] = await Promise.all([
    api<PlanView>('/plan'),
    api<OutcomeContextView>('/outcome-context'),
    apiResult<{ next: NextActionView }>('/today'),
    apiResult<{ session: Session | null; card: SessionCardView | null }>('/session'),
  ]);
  if (!ownsRoom(owner)) return;
  if (!plan) {
    (add as HTMLButtonElement).disabled = true;
    owner.content.append(el(`<p class="empty">${esc(VIRGIL_UNAVAILABLE)}</p>`));
    return;
  }

  const again = (commitmentId: string | null = null): void => {
    void renderPlan(commitmentId, commitmentId !== null);
  };
  const completed = (commitmentId: string, receipt: string): void => {
    void renderPlan(commitmentId, true, false, false, receipt);
  };
  const now = Date.now();
  const courses = context?.courses ?? [];
  const label = new Map(courses.map((c) => [c.id, c.title] as const));
  const topics = context?.topics ?? [];
  const planContent: HTMLElement[] = [];
  const trackPlanContent = (node: HTMLElement): HTMLElement => {
    node.setAttribute('data-plan-content', '');
    planContent.push(node);
    return node;
  };
  const setPlanContentHidden = (hidden: boolean): void => {
    for (const node of planContent) node.hidden = hidden;
  };
  const tutor = planTutor(
    todayRead.kind === 'ok' ? todayRead.body.next : null,
    sessionRead.kind === 'ok' ? sessionRead.body.session : null,
    focusIntent === 'links',
  );
  owner.content.append(tutor.node);
  trackPlanContent(tutor.node);
  const sheetHost = el(`<div id="plan-add-sheet" class="add-sheet-host"></div>`);
  owner.content.append(sheetHost);
  const toggleAdd = (plannedDay: string | null = null): void => {
    const open = sheetHost.firstElementChild !== null;
    if (open) {
      guardNavigation(() => {
        sheetHost.replaceChildren();
        add.setAttribute('aria-expanded', 'false');
        add.textContent = 'Add';
        setPlanContentHidden(false);
        add.focus();
      });
      return;
    }
    sheetHost.replaceChildren();
    add.setAttribute('aria-expanded', 'true');
    add.textContent = 'Close';
    const sheet = addSheet(PLAN_ADD_ROUTES, (key) => (
      key === 'dated'
        ? commitmentForm(
          again, courses, topics, () => renderPlan(null, false, true, true), plannedDay,
        )
        : context
          ? outcomeForm(context, tutor.changed)
          : el(`<p class="bare">A result belongs to something you are studying, and I cannot read your courses right now.</p>`)
    ), PLAN_ADD_ROUTE, (key) => { PLAN_ADD_ROUTE = key; });
    sheetHost.append(sheet);
    setPlanContentHidden(true);
    (sheet.querySelector('.add-commitment .title') as HTMLElement | null
      ?? sheet.querySelector('[aria-current="page"]') as HTMLElement | null)?.focus();
  };
  add.addEventListener('click', () => toggleAdd());

  const openCommitments = plan.commitments.filter((c) => !c.doneAt);
  if (!openCommitments.length) {
    const first = el(`<section class="plan-first">
      <h2>Nothing with a date yet</h2>
      <p>Add an assignment, class, or study session. Virgil keeps its deadline separate from the day you plan to work on it.</p>
      <button class="primary" data-first-plan>Add something with a date</button>
    </section>`);
    first.querySelector('[data-first-plan]')!.addEventListener('click', () => toggleAdd());
    owner.content.append(first);
    trackPlanContent(first);
  } else {
    const wall = el(`<div class="plan-wall"></div>`);
    const lanes = el(`<div class="plan-lanes"></div>`);
    const projected = planLanes(plan.commitments);
    for (const lane of PLAN_LANES) {
      const cards = projected[lane.key];
      if (!cards.length) continue;
      const node = el(`<section class="lane" data-lane="${esc(lane.key)}">
        <h2></h2><div class="rows"></div>
      </section>`);
      (node.querySelector('h2') as HTMLElement).textContent = lane.heading;
      const rows = node.querySelector('.rows') as HTMLElement;
      for (const c of cards) rows.append(planCard(c, {
        now, label, again: () => again(c.id), completed: (receipt) => completed(c.id, receipt),
        focus, focusIntent, topics, courses,
      }));
      lanes.append(node);
    }
    wall.append(lanes, planCalendar(plan.commitments, now, () => again(), (day) => toggleAdd(day)));
    owner.content.append(wall);
    trackPlanContent(wall);
  }

  const done = plan.commitments.filter((c) => c.doneAt);
  if (done.length || plan.stars > 0 || plan.points > 0) {
    const closed = el(`<section class="zone plan-done">
      <div class="head"><h2></h2></div>
      <div class="rows"></div>
    </section>`);
    (closed.querySelector('h2') as HTMLElement).textContent = PLAN_DONE_HEADING;
    const rows = closed.querySelector('.rows') as HTMLElement;
    for (const c of done.slice(0, 12)) {
      rows.append(planCard(c, {
        now, label, again: () => again(c.id), completed: (receipt) => completed(c.id, receipt),
        focus, focusIntent, topics, courses,
      }));
    }
    if (plan.stars > 0 || plan.points > 0) {
      const score = el(`<p class="score"></p>`);
      score.textContent = starLine(plan.stars, plan.points);
      closed.append(score);
    }
    owner.content.append(closed);
    trackPlanContent(closed);
  }

  if (openAdd) toggleAdd();

  if (focusAddAction) {
    (sheetHost.querySelector('[data-add]') as HTMLElement | null)?.focus();
  } else if (focusAfterWrite && focus) {
    const changed = Array.from(owner.content.querySelectorAll('.plan-card')).find(
      (card) => card.getAttribute('data-commitment') === focus,
    ) as HTMLElement | undefined;
    if (changed) {
      if (completionReceipt) {
        (changed.querySelector('.earned') as HTMLElement).textContent = completionReceipt;
      }
      changed.setAttribute('tabindex', '-1');
      changed.focus();
    }
  }
}

/** The next move and the in-place receipt when a recorded result changes it. */
function planTutor(
  next: NextActionView | null,
  session: Session | null,
  planIntentAlreadyOpen = false,
): {
  node: HTMLElement; changed: (said: string) => void;
} {
  const node = el(`<div class="tutor hushed">
    <p class="tutor-line"></p>
    <div class="tutor-go"></div>
    <p class="tutor-changed"></p>
  </div>`);
  const line = node.querySelector('.tutor-line') as HTMLElement;
  const go = node.querySelector('.tutor-go') as HTMLElement;
  const changedLine = node.querySelector('.tutor-changed') as HTMLElement;

  const action = next?.primary ?? null;
  if (action) {
    const section = action.destination === 'session' && session
      ? session.sections[session.currentSectionIndex]
        ?? session.sections.find((candidate) => !candidate.completed)
        ?? session.sections[0]
      : null;
    const title = section?.topicLabel?.trim() || section?.heading?.trim() || action.title;
    line.textContent = `Next: ${tutorLine(title, action.reasons)}`;
    // A Plan-bound action keeps its advice but gets no no-op control.
    if (action.destination !== 'plan' || (action.planIntent && !planIntentAlreadyOpen)) {
      const button = el(`<button class="primary" data-tutor-go></button>`) as HTMLButtonElement;
      button.textContent = action.destination === 'session' && action.cta === 'Start'
        ? 'Start lesson'
        : action.cta;
      button.addEventListener('click', () => openAction(action, session));
      go.append(button);
    }
    node.classList.remove('hushed');
  }

  return {
    node,
    changed: (said: string): void => {
      changedLine.textContent = said;
      if (said) node.classList.remove('hushed');
    },
  };
}

interface CardContext {
  readonly now: number;
  readonly label: ReadonlyMap<string, string>;
  readonly again: () => void;
  readonly completed: (completionReceipt: string) => void;
  readonly focus: string | null;
  /** An explicit Today handoff that opens an existing editor on this card. */
  readonly focusIntent: 'links' | null;
  /** The board's topics, for the link that makes a deadline shape teaching. */
  readonly topics: readonly TopicPick[];
  /** The learner's courses, for the other half of the same link: which subject
   *  this belongs to. See the menu action below. */
  readonly courses: readonly CoursePick[];
}

interface TopicPick { id: string; label: string }

/**
 * One commitment, everything it can honestly say about itself, and one menu.
 *
 * The tick is still the only scoring event and still says what it earned where
 * it happened. Everything else the service has always accepted and the room
 * never offered — editing, moving, reopening, deleting — is behind `More`,
 * because a card that shows five controls at rest is a control panel and this
 * is a thing somebody has to do.
 *
 *  is the reopen: `POST /commitments/{id}/reopen` was written, tested and
 * never wired, so a learner who ticked the wrong row had no way back.
 */
function planCard(c: CommitmentView, ctx: CardContext): HTMLElement {
  const node = el(`<article class="plan-card" data-state="${esc(c.state)}" data-commitment="${esc(c.id)}">
    <button class="tick" title="Done"></button>
    <div class="what">
      <span class="label"></span>
      <span class="course"></span>
      <span class="when"></span>
      <span class="estimate"></span>
      <span class="promised"></span>
      <span class="clash"></span>
      <span class="leans"></span>
    </div>
    <div class="card-menu"><button class="link" data-menu></button></div>
    <div class="earned" role="status" aria-live="polite"></div>
    <div class="menu-body"></div>
  </article>`);
  (node.querySelector('.label') as HTMLElement).textContent = c.title;
  (node.querySelector('.course') as HTMLElement).textContent =
    (c.courseId && ctx.label.get(c.courseId)) || '';
  (node.querySelector('.when') as HTMLElement).textContent = dueLine(c, ctx.now);
  (node.querySelector('.estimate') as HTMLElement).textContent = estimateLine(c.estimateMinutes);
  (node.querySelector('.promised') as HTMLElement).textContent = c.doneAt
    ? '' : plannedLine(c.plannedFor, ctx.now);
  // Beside the two dates it is about, and empty whenever they agree. A span
  // with nothing in it draws nothing, so an ordinary card is the card it has
  // always been.
  (node.querySelector('.clash') as HTMLElement).textContent = plannedAfterDueLine(c);
  // What it leans on, written back where it was set. A link nobody can see is
  // a link nobody can tell they made, or correct.
  (node.querySelector('.leans') as HTMLElement).textContent = linkedTopicsLine(
    c.topicIds, (id) => ctx.topics.find((t) => t.id === id)?.label);
  const earned = node.querySelector('.earned') as HTMLElement;

  markIfNamed(node, c.id, ctx.focus);

  const tick = node.querySelector('.tick') as HTMLButtonElement;
  tick.textContent = c.doneAt ? '✓' : '';
  tick.setAttribute('aria-label', c.doneAt ? `Done: ${c.title}` : `Mark ${c.title} done`);
  if (c.doneAt) {
    // A done card's tick is a statement, not a control: closing is idempotent
    // server-side, so a second press would be a button that pays nothing.
    tick.disabled = true;
    tick.setAttribute('aria-disabled', 'true');
  } else {
    tick.addEventListener('click', async () => {
      tick.disabled = true;
      const r = await api<{ awarded: AwardView[]; points: number }>(
        `/commitments/${encodeURIComponent(c.id)}/done`, { method: 'POST' },
      );
      if (!r) {
        earned.textContent = 'That did not go through. Nothing has changed.';
        tick.disabled = false;
        return;
      }
      // One authoritative repaint owns all consequences of a completion: lane,
      // Done record, score, calendar, tutor and the award receipt. Mutating the
      // old card first made one live page contradict itself until a timer fired.
      // The attachment guard still matters when a slow service answer arrives
      // after the learner has deliberately gone elsewhere.
      let parent: HTMLElement | null = node;
      while (parent && parent !== app) parent = parent.parentElement;
      if (parent === app && document.getElementById('app') === app) {
        ctx.completed(awardLine(r.awarded));
      }
    });
  }

  const menu = node.querySelector('[data-menu]') as HTMLButtonElement;
  const body = node.querySelector('.menu-body') as HTMLElement;
  const menuId = `plan-menu-${c.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  body.setAttribute('id', menuId);
  menu.setAttribute('aria-controls', menuId);
  menu.textContent = PLAN_MENU;
  menu.setAttribute('aria-label', `${PLAN_MENU} options for ${c.title}`);
  menu.setAttribute('aria-expanded', 'false');
  const openMenu = (intent: 'links' | null = null): void => {
    const open = body.firstElementChild !== null;
    body.replaceChildren();
    menu.setAttribute('aria-expanded', open ? 'false' : 'true');
    if (open) { menu.focus(); return; }
    const choices = cardMenu(c, ctx, body);
    body.append(choices);
    if (intent === 'links') {
      (choices.querySelector('[data-study-links]') as HTMLButtonElement | null)?.click();
    } else {
      (choices.querySelector('button') as HTMLElement | null)?.focus();
    }
  };
  menu.addEventListener('click', () => openMenu());
  if (ctx.focus === c.id && ctx.focusIntent === 'links') openMenu('links');

  // The enhancement on top of the keyboard route, never instead of it. Cards
  // carry the id; the day cells read it back on drop.
  node.setAttribute('draggable', c.doneAt ? 'false' : 'true');
  if (!c.doneAt) {
    node.addEventListener('dragstart', (e: Event) => {
      (e as DragEvent).dataTransfer?.setData('text/plain', c.id);
    });
  }
  return node;
}

/**
 * The card's menu: the small set of commitment changes the service accepts.
 *
 * `Move to a day` and `Change the date` are two different facts and are two
 * different controls on purpose. Moving is the learner's own promise
 * (`plannedFor`) and is the gesture the calendar also offers; changing the date
 * is a deadline (`dueAt`), which is usually somebody else's and is never a drag.
 */
function cardMenu(c: CommitmentView, ctx: CardContext, host: HTMLElement): HTMLElement {
  const node = el(`<div class="menu-choices"><p class="note"></p><p class="write-status" role="status" aria-live="polite"></p></div>`);
  const note = node.querySelector('.note') as HTMLElement;
  const writeStatus = node.querySelector('.write-status') as HTMLElement;
  // The element was already here and was already empty on every card. It says
  // the one thing the two controls above it do not say about themselves — but
  // only while both of them are on the menu: a done card is offered Reopen and
  // Delete, and a sentence about moving and deadlines would be about nothing.
  if (!c.doneAt) note.textContent = [recurrenceLine(c), PLAN_MENU_NOTE].filter(Boolean).join(' ');

  const action = (
    label: string, run: (button: HTMLButtonElement) => void, intent: 'study-links' | null = null,
  ): void => {
    const button = el(`<button class="link"></button>`) as HTMLButtonElement;
    button.textContent = label;
    if (intent) button.setAttribute(`data-${intent}`, '');
    button.addEventListener('click', () => run(button));
    node.append(button);
  };

  const cardWrite = async (
    path: string, init: RequestInit, status: HTMLElement, button: HTMLButtonElement,
    working: string, failed: string,
  ): Promise<boolean> => {
    button.disabled = true;
    status.textContent = working;
    const saved = await apiResult<unknown>(path, init);
    if (await reopenSignInForExpiredIdentity(saved, () => renderPlan(c.id))) return false;
    if (saved.kind !== 'ok') {
      status.textContent = failed;
      button.disabled = false;
      button.focus();
      return false;
    }
    return true;
  };

  action('Edit details', () => {
    const edit = el(`<div class="commitment-details-edit">
      <p class="scope-note"></p>
      <div class="fields">
        <label class="field"><span>Name</span><input class="title" type="text" aria-describedby="commitment-edit-title-limit"></label>
        <span id="commitment-edit-title-limit" class="meta input-limit">Up to 180 characters. I save the whole name.</span>
        <label class="field"><span>Kind</span><select class="kind">
          <option value="assignment">Assignment</option>
          <option value="lesson">Lesson or class</option>
          <option value="study">Study time</option>
          <option value="task">Something else</option>
        </select></label>
      </div>
      <div class="row"><button class="link" data-save>Save details</button></div>
      <p class="note" role="status" aria-live="polite"></p>
    </div>`);
    const scope = edit.querySelector('.scope-note') as HTMLElement;
    if (c.recurrence) {
      scope.textContent = 'This changes this date only. The other dates in the series keep their details.';
    } else {
      scope.remove();
    }
    const title = edit.querySelector('.title') as HTMLInputElement;
    const kind = edit.querySelector('.kind') as HTMLSelectElement;
    const save = edit.querySelector('[data-save]') as HTMLButtonElement;
    const editNote = edit.querySelector('[role=status]') as HTMLElement;
    title.value = c.title;
    kind.value = c.kind;
    save.addEventListener('click', async () => {
      if (!title.value.trim()) {
        editNote.textContent = 'It needs a name.';
        title.focus();
        return;
      }
      if (refuseAuthoredOverflow(title.value, STUDY_TEXT_LIMITS.commitmentTitle,
        'assignment name', editNote, title)) return;
      if (await cardWrite(
        `/commitments/${encodeURIComponent(c.id)}`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: title.value, kind: kind.value }),
        }, editNote, save, 'Saving the details…',
        'Those details did not change. Your edit is still here.',
      )) ctx.again();
    });
    host.replaceChildren(edit);
    title.focus();
  });

  if (!c.doneAt) {
    action(MOVE_TO_A_DAY, () => {
      const shown = calendarDays(ctx.now);
      const picker = el(`<div class="date-edit move-date" aria-label="${esc(MOVE_TO_A_DAY)}">
        <label class="field"><span class="move-day-label"></span><input class="planned" type="date"></label>
        <button class="link" data-save></button>
        <p class="note" role="status" aria-live="polite"></p>
      </div>`);
      const pickerStatus = picker.querySelector('.note') as HTMLElement;
      const label = picker.querySelector('.move-day-label') as HTMLElement;
      label.textContent = MOVE_TO_DAY_FIELD;
      const field = picker.querySelector('.planned') as HTMLInputElement;
      const firstDay = shown[0] ?? '';
      const lastDay = shown[shown.length - 1] ?? '';
      field.setAttribute('min', firstDay);
      field.setAttribute('max', lastDay);
      const planned = c.plannedFor?.slice(0, 10) ?? '';
      field.value = shown.includes(planned) ? planned : localDayKey(ctx.now);
      const save = picker.querySelector('[data-save]') as HTMLButtonElement;
      save.textContent = MOVE_TO_DAY_SAVE;
      save.addEventListener('click', async () => {
        const write = plannedForFromDrop(c.id, field.value);
        if (!write) { pickerStatus.textContent = 'Pick a day first.'; field.focus(); return; }
        if (field.value < firstDay || field.value > lastDay) {
          pickerStatus.textContent = 'Pick a day from the three weeks on the calendar.';
          field.focus();
          return;
        }
        if (await cardWrite(
          `/commitments/${encodeURIComponent(c.id)}`, {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(write.body),
          }, pickerStatus, save, 'Moving it…', 'That did not move. It is where it was.',
        )) ctx.again();
      });
      host.replaceChildren(picker);
      field.focus();
    });

    if (c.plannedFor) {
      action(REMOVE_PLANNED_DAY, async (button) => {
        const cleared = await cardWrite(
          `/commitments/${encodeURIComponent(c.id)}`, {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ plannedFor: null }),
          }, writeStatus, button,
          'Removing your planned day…', 'That did not change. Your planned day is still there.',
        );
        if (cleared) ctx.again();
      });
    }
  }

  /**
   * The link that makes a deadline change what tonight teaches.
   *
   * This remains editable after completion. Course/topic filing describes the
   * work rather than whether it is finished; forcing a learner to reopen a
   * misfiled record would temporarily falsify Plan and Today merely to repair
   * its history. Dates stay locked once done, but identity and study links do
   * not require a completion-state change.
   */
    if (ctx.topics.length || ctx.courses.length) {
      const studyLinkAction = c.courseId || (c.topicIds?.length ?? 0) > 0
        ? CHANGE_STUDY_LINK
        : LINK_TO_TOPICS;
      action(studyLinkAction, () => {
        const edit = el(`<div class="topic-edit">
          <p class="why"></p>
          <div class="fields"></div>
          <div class="row"><button class="link" data-save></button></div>
          <p class="note" role="status" aria-live="polite"></p>
        </div>`);
        (edit.querySelector('.why') as HTMLElement).textContent = LINK_TO_TOPICS_NOTE;
        const fields = edit.querySelector('.fields') as HTMLElement;
        // The subject first: it is the coarser question, and the one a learner
        // can answer about a row they have forgotten the detail of.
        const course = ctx.courses.length
          ? coursePicker(fields, ctx.courses, LINK_TO_COURSE_FIELD)
          : null;
        // Set from what is stored, so opening the menu on a linked row shows
        // the link rather than offering to make one that is already there.
        if (course) course.value = c.courseId ?? '';
        const picker = ctx.topics.length
          ? topicPicker(fields, ctx.topics, LINK_TO_TOPICS_FIELD, c.topicIds ?? [])
          : null;
        const save = edit.querySelector('[data-save]') as HTMLButtonElement;
        save.textContent = LINK_TO_TOPICS_SAVE;
        const editNote = edit.querySelector('.note') as HTMLElement;
        save.addEventListener('click', async () => {
          // Only what this menu actually asked about. A body that also sent the
          // fields it did not offer would be this control quietly rewriting a
          // date somebody set somewhere else.
          const patch: Record<string, unknown> = {};
          if (course) patch['courseId'] = course.value || null;
          if (picker) patch['topicIds'] = picker.chosen();
          const saved = await cardWrite(
            `/commitments/${encodeURIComponent(c.id)}`, {
              method: 'PUT', headers: { 'content-type': 'application/json' },
              body: JSON.stringify(patch),
            }, editNote, save, 'Saving the links…', LINK_TO_TOPICS_FAILED,
          );
          // Repainted from the service rather than from what was ticked here:
          // the room shows what was stored, which is the only thing that is
          // going to weigh anything tonight.
          if (saved) ctx.again();
        });
        host.replaceChildren(edit);
        (course ?? picker?.node.querySelector('input') ?? save).focus();
      }, 'study-links');
    }

  if (!c.doneAt) {
    action(CHANGE_THE_DATE, () => {
      const showEditor = (scope: 'one' | 'remaining'): void => {
        const edit = el(`<div class="date-edit">
          <label class="field"><span>New deadline</span><input class="due" type="date"></label>
          <label class="field"><span>Time <em>(optional)</em></span><input class="due-time" type="time"></label>
          <p class="deadline-zone"></p>
          <button class="link" data-save></button>
          <p class="note" role="status" aria-live="polite"></p>
        </div>`);
        const field = edit.querySelector('.due') as HTMLInputElement;
        const dueTime = edit.querySelector('.due-time') as HTMLInputElement;
        field.value = commitmentDueDay(c);
        dueTime.value = c.dueTime ?? '';
        (edit.querySelector('.deadline-zone') as HTMLElement).textContent = scope === 'remaining'
          ? `Later open dates keep this weekly wall time in ${c.recurrence?.timeZone || localZone() || 'the series timezone'}. Completed dates and your planned days stay as they are.`
          : `A time uses ${c.dueTimeZone || localZone() || "your board's timezone"}. Leave it empty for a date-only deadline.`;
        const save = edit.querySelector('[data-save]') as HTMLButtonElement;
        save.textContent = scope === 'remaining' ? THIS_AND_LATER : SAVE_THE_DATE;
        const editNote = edit.querySelector('[role=status]') as HTMLElement;
        save.addEventListener('click', async () => {
          if (!field.value) { editNote.textContent = 'A date, or it is not a deadline.'; return; }
          if (await cardWrite(
            `/commitments/${encodeURIComponent(c.id)}${scope === 'remaining' ? '?scope=remaining' : ''}`, {
              method: 'PUT', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                dueAt: field.value,
                ...(dueTime.value ? { dueTime: dueTime.value } : c.dueTime ? { dueTime: null } : {}),
              }),
            }, editNote, save,
            scope === 'remaining' ? 'Changing this and later…' : 'Saving the date…',
            scope === 'remaining' ? 'Those dates did not change.' : 'That date did not go through.',
          )) ctx.again();
        });
        host.replaceChildren(edit);
        field.focus();
      };

      if (!c.recurrence) { showEditor('one'); return; }
      const scope = el(`<div class="series-scope"><p></p></div>`);
      (scope.querySelector('p') as HTMLElement).textContent =
        'Change only this deadline, or re-anchor this and the open dates after it?';
      const one = el(`<button class="link"></button>`) as HTMLButtonElement;
      one.textContent = ONLY_THIS_DATE;
      one.addEventListener('click', () => showEditor('one'));
      const later = el(`<button class="link"></button>`) as HTMLButtonElement;
      later.textContent = THIS_AND_LATER;
      later.addEventListener('click', () => showEditor('remaining'));
      scope.append(one, later);
      host.replaceChildren(scope);
      one.focus();
    });
  }

  if (c.doneAt) {
    action(REOPEN_ACTION, async (button) => {
      const back = await cardWrite(
        `/commitments/${encodeURIComponent(c.id)}/reopen`, { method: 'POST' },
        writeStatus, button, 'Reopening it…', 'That did not reopen. It is still closed.',
      );
      // The awards stay. A ledger that can be rewound by unticking is one
      // somebody can farm, and an award is a record of a moment.
      if (back) ctx.again();
    });
  }

  action(DELETE_ACTION, () => {
    const confirm = el(`<div class="delete-confirm"><p></p><p class="note" role="status" aria-live="polite"></p></div>`);
    (confirm.querySelector('p') as HTMLElement).textContent = !c.doneAt && c.recurrence
      ? 'Skip this open date, or stop this and the open dates after it? Completed dates and anything earned stay.'
      : DELETE_CONFIRM;
    const confirmNote = confirm.querySelector('.note') as HTMLElement;
    const yes = el(`<button class="link"></button>`) as HTMLButtonElement;
    yes.textContent = !c.doneAt && c.recurrence ? SKIP_THIS_DATE : DELETE_CONFIRM_ACTION;
    yes.addEventListener('click', async () => {
      if (await cardWrite(
        `/commitments/${encodeURIComponent(c.id)}`, { method: 'DELETE' }, confirmNote,
        yes, !c.doneAt && c.recurrence ? 'Skipping this date…' : 'Deleting it…',
        !c.doneAt && c.recurrence
          ? 'That did not go through. This date is still here.'
          : 'That did not go through. It is still here.',
      )) ctx.again();
    });
    if (!c.doneAt && c.recurrence) {
      const stop = el(`<button class="link"></button>`) as HTMLButtonElement;
      stop.textContent = STOP_THIS_AND_LATER;
      stop.addEventListener('click', async () => {
        if (await cardWrite(
          `/commitments/${encodeURIComponent(c.id)}?scope=remaining`,
          { method: 'DELETE' }, confirmNote, stop,
          'Stopping this and later…', 'That did not go through. The open dates are still here.',
        )) ctx.again();
      });
      confirm.append(yes, stop);
    } else {
      confirm.append(yes);
    }
    const no = el(`<button class="link"></button>`) as HTMLButtonElement;
    no.textContent = KEEP_IT;
    no.addEventListener('click', () => {
      host.replaceChildren();
      (host.parentElement?.querySelector('[data-menu]') as HTMLElement | null)?.focus();
    });
    confirm.append(no);
    host.replaceChildren(confirm);
    yes.focus();
  });

  return node;
}

/**
 * THREE WEEKS — the one behind, this one, the one ahead.
 *
 * Deadlines are drawn solid and planned study lighter, because they are two
 * different kinds of fact: one is usually somebody else's and one is the
 * learner's own promise to themselves. **The cell holds the thing, never a
 * number** — Open Question 7's proposed bound, which is  applied to the
 * one surface that most naturally grows a tally in every square.
 *
 * The drop is the enhancement; `Move to a day` in the card menu is the route,
 * and both go through `plannedForFromDrop`, so a keyboard and a mouse cannot
 * send different things.
 */
function planCalendar(
  commitments: readonly CommitmentView[], now: number, again: () => void,
  addOnDay: (day: string) => void,
): HTMLElement {
  const node = el(`<section class="plan-calendar" aria-label="Three weeks">
    <div class="cal-title"><h2>Three weeks</h2><span class="cal-range"></span></div>
    <div class="cal-heads"></div>
    <div class="cal-key" aria-label="Calendar key">
      <span data-kind="due">Deadline</span>
      <span data-kind="planned">Your planned day</span>
    </div>
    <div class="cal-weeks"></div>
    <p class="cal-note"></p>
  </section>`);
  const heads = node.querySelector('.cal-heads') as HTMLElement;
  for (const day of WEEKDAYS) {
    const head = el(`<span class="cal-head"></span>`);
    head.textContent = day;
    heads.append(head);
  }

  const weeks = node.querySelector('.cal-weeks') as HTMLElement;
  const drawn = calendarWeeks(commitments, now);
  const firstDay = drawn[0]?.[0]?.iso;
  const lastDay = drawn[drawn.length - 1]?.[6]?.iso;
  if (firstDay && lastDay) {
    const short = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' });
    const first = short.format(new Date(`${firstDay}T12:00:00`));
    const last = short.format(new Date(`${lastDay}T12:00:00`));
    (node.querySelector('.cal-range') as HTMLElement).textContent = `${first} to ${last}`;
  }
  for (const week of drawn) {
    const row = el(`<div class="cal-week" data-week="${week[0]!.week}"></div>`);
    for (const day of week) {
      const cell = el(`<button type="button" class="cal-day" data-day="${esc(day.iso)}"></button>`);
      if (day.today) cell.setAttribute('data-today', 'true');
      const dayFacts = [
        ...day.due.map((commitment) => `Deadline: ${commitment.title}`),
        ...day.planned.map((commitment) => `Your planned day: ${commitment.title}`),
      ];
      cell.setAttribute('aria-label', `Plan something for ${day.iso}`
        + (dayFacts.length ? `. ${dayFacts.join('. ')}` : ''));
      const date = el(`<span class="cal-date"></span>`);
      date.textContent = day.date;
      cell.append(date);
      const items = el(`<div class="cal-items"></div>`);
      for (const c of day.due) {
        const item = el(`<span class="cal-item" data-kind="due"></span>`);
        item.textContent = c.title;
        item.setAttribute('aria-label', `Deadline: ${c.title}`);
        items.append(item);
      }
      for (const c of day.planned) {
        const item = el(`<span class="cal-item" data-kind="planned"></span>`);
        item.textContent = c.title;
        item.setAttribute('aria-label', `Your planned day: ${c.title}`);
        items.append(item);
      }
      cell.append(items);

      for (const kind of ['dragover', 'dragenter'] as const) {
        cell.addEventListener(kind, (e: Event) => {
          // Without this the browser refuses the drop and the card springs back.
          e.preventDefault();
          cell.classList.add('over');
        });
      }
      for (const kind of ['dragleave', 'dragend'] as const) {
        cell.addEventListener(kind, () => cell.classList.remove('over'));
      }
      cell.addEventListener('drop', async (e: Event) => {
        e.preventDefault();
        cell.classList.remove('over');
        const id = (e as DragEvent).dataTransfer?.getData('text/plain') ?? '';
        const write = plannedForFromDrop(id, day.iso);
        if (!write) return;
        const saved = await api(`/commitments/${encodeURIComponent(write.id)}`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(write.body),
        });
        if (saved) again();
      });
      cell.addEventListener('click', () => addOnDay(day.iso));
      row.append(cell);
    }
    weeks.append(row);
  }
  (node.querySelector('.cal-note') as HTMLElement).textContent = PLAN_SESSION_NOTE;
  return node;
}

interface OutcomeContextView {
  courses: { id: string; title: string }[];
  commitments: { id: string; title: string; courseId: string | null }[];
  topics: { id: string; label: string }[];
}
interface OutcomeView {
  id: string; kind: string; title: string; courseId: string | null; commitmentId: string | null;
  topicIds: string[]; score: number | null; maxScore: number | null; summary: string;
  feedback: string; criteria: unknown[]; source: unknown; recordedAt: string;
}
interface AdaptationView {
  changed: boolean;
  before: ActionOptionView;
  after: ActionOptionView;
  changedBecause: string;
}

function optionsFor(rows: readonly { id: string; title?: string; label?: string }[], empty: string): string {
  return `<option value="">${esc(empty)}</option>` + rows.map((row) =>
    `<option value="${esc(row.id)}">${esc(row.title ?? row.label ?? row.id)}</option>`).join('');
}

/**
 * Keep the visible result relationship internally possible.
 *
 * An assignment already knows which course owns it. Selecting that assignment
 * therefore carries the course into view; changing the course away from that
 * owner clears the now-contradictory assignment instead of letting the form
 * send a graph the service must refuse. An older unfiled assignment has no
 * course authority and can still sit beside an independently chosen course.
 */
function bindOutcomeRelationship(
  course: HTMLSelectElement, commitment: HTMLSelectElement, context: OutcomeContextView,
): void {
  const selected = (): OutcomeContextView['commitments'][number] | null =>
    context.commitments.find((row) => row.id === commitment.value) ?? null;
  const carryCourse = (): void => {
    const owner = selected()?.courseId;
    if (owner) course.value = owner;
  };
  commitment.addEventListener('input', carryCourse);
  course.addEventListener('input', () => {
    const owner = selected()?.courseId;
    if (owner && course.value !== owner) commitment.value = '';
  });
  carryCourse();
}

/**
 * Capture reality after the task—not completion as a proxy for learning.
 *
 * Behind Add now rather than standing in the Plan's body: the results
 * THEMSELVES live in My studies, per course, where the work is. What stays here
 * is the recording, because the natural moment to record one is the moment
 * after ticking the thing off — which happens in this room.
 *
 * `announce` is how the replanning receipt reaches the tutor line. The form is
 * inside a sheet the learner is about to close, and a receipt that says the
 * next move just changed belongs beside the next move.
 */
function outcomeForm(
  context: OutcomeContextView, announce: (said: string) => void = () => {},
  onRecorded: ((outcome: OutcomeView, adaptation: AdaptationView) => void) | null = null,
): HTMLElement {
  const form = el(`<section class="outcome-capture">
    <div class="eyebrow">Close the learning loop</div>
    <h2>Record what actually happened</h2>
    <p class="meta">A grade or rubric result is evidence. Ticking a task complete is not.</p>
    <div class="fields">
      <label class="field"><span>Result</span><input class="name title" placeholder="Architecture report grade"><span class="meta input-limit">Up to 180 characters. I save the whole result name.</span></label>
      <label class="field"><span>Kind</span><select class="kind"><option value="grade">Grade</option><option value="rubric">Rubric result</option><option value="teacher-feedback">Teacher feedback</option><option value="self-assessment">Self-assessment</option><option value="real-world">Real-world result</option></select></label>
      <label class="field"><span>Score <em>(optional)</em></span><input class="name score" type="number" min="0"></label>
      <label class="field"><span>Out of <em>(optional)</em></span><input class="name max" type="number" min="1"></label>
      <label class="field"><span>Course <em>(optional)</em></span><select class="course-pick"></select></label>
      <label class="field"><span>Assignment <em>(optional)</em></span><select class="commitment"></select></label>
      <label class="field"><span>What did this test? <em>(optional)</em></span><select class="topic"></select></label>
    </div>
    <label class="field feedback-field"><span>Feedback or what you noticed <em>(optional)</em></span><textarea class="feedback" rows="3"></textarea><span class="meta input-limit">Up to 6,000 characters. I save the whole note.</span></label>
    <div class="row"><button class="primary" data-record>Record result</button></div>
    <div class="adaptation" role="status" aria-live="polite" tabindex="-1"></div>
  </section>`);
  const course = form.querySelector('.course-pick') as HTMLSelectElement;
  const commitment = form.querySelector('.commitment') as HTMLSelectElement;
  const topic = form.querySelector('.topic') as HTMLSelectElement;
  course.innerHTML = optionsFor(context.courses, 'No course link');
  commitment.innerHTML = optionsFor(context.commitments, 'No assignment link');
  topic.innerHTML = optionsFor(context.topics, 'No topic link');
  bindOutcomeRelationship(course, commitment, context);
  const title = form.querySelector('.title') as HTMLInputElement;
  const kind = form.querySelector('.kind') as HTMLSelectElement;
  const score = form.querySelector('.score') as HTMLInputElement;
  const max = form.querySelector('.max') as HTMLInputElement;
  const feedback = form.querySelector('.feedback') as HTMLTextAreaElement;
  const receipt = form.querySelector('.adaptation') as HTMLElement;
  const button = form.querySelector('[data-record]') as HTMLButtonElement;
  const clientRef = newClientRef();
  const release = protectUnsentForm(
    form, 'result draft', [title, kind, score, max, course, commitment, topic, feedback],
    () => form.remove(), () => title.focus(),
  );
  button.addEventListener('click', async () => {
    if (!title.value.trim()) { receipt.textContent = 'Name the result first.'; title.focus(); return; }
    const titleChars = unicodeChars(title.value);
    if (titleChars > OUTCOME_TITLE_MAX_CHARS) {
      receipt.textContent = `That result name is ${titleChars.toLocaleString('en-US')} characters. `
        + 'Keep it to 180 so I can save all of it. Nothing was sent.';
      title.focus();
      return;
    }
    const feedbackChars = unicodeChars(feedback.value);
    if (feedbackChars > OUTCOME_FEEDBACK_MAX_CHARS) {
      receipt.textContent = `That result note is ${feedbackChars.toLocaleString('en-US')} characters. `
        + 'Keep it to 6,000 so I can save all of it. Nothing was sent.';
      feedback.focus();
      return;
    }
    if ((score.value && !max.value) || (!score.value && max.value)) {
      receipt.textContent = 'Give both the score and what it was out of.'; return;
    }
    button.disabled = true;
    form.setAttribute('aria-busy', 'true');
    receipt.textContent = 'Recording the result…';
    const recorded = await apiResult<{ outcome: OutcomeView; adaptation: AdaptationView }>('/outcomes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: kind.value, title: title.value, score: score.value || null,
        maxScore: max.value || null, feedback: feedback.value,
        courseId: course.value || null, commitmentId: commitment.value || null,
        topicIds: topic.value ? [topic.value] : [], availableMinutes: 3, clientRef,
      }),
    });
    if (recorded.kind !== 'ok') {
      receipt.textContent = authoredWriteFailure(recorded, 'result draft');
      form.removeAttribute('aria-busy');
      button.disabled = false;
      button.focus();
      return;
    }
    release();
    if (onRecorded) {
      onRecorded(recorded.body.outcome, recorded.body.adaptation);
      return;
    }
    receipt.replaceChildren();
    const line = el(`<p class="receipt-line"></p>`);
    line.textContent = recorded.body.adaptation.changedBecause;
    const see = el(`<button class="link">See the updated next move</button>`);
    see.addEventListener('click', () => void renderHome());
    receipt.append(line, see);
    form.removeAttribute('aria-busy');
    see.focus();
    // And where the learner is actually looking: replanning that happens out of
    // sight is replanning nobody knows about.
    announce(recorded.body.adaptation.changedBecause);
  });
  return form;
}

/**
 * One recorded result, and the control that corrects it.
 *
 * Pulled out of the Plan's own result list when My studies started showing a
 * course's results, and the last renderer standing when that list left the Plan
 * on 2026-08-24: a result read in the room where the work lives has to be the
 * same object wherever else it appears, including the way it is put right. Two
 * renderings of one fact is how two rooms come to disagree about it.
 */
function outcomeRow(outcome: OutcomeView, context: OutcomeContextView | null = null): HTMLElement {
    const row = el(`<div class="outcome-row" data-outcome="${esc(outcome.id)}"><div><strong></strong><span class="result"></span><p class="meta result-context"></p><p class="result-note"></p></div><button class="link">Correct result</button><div class="correction"></div></div>`);
    const open = row.querySelector('button') as HTMLButtonElement;
    const host = row.querySelector('.correction') as HTMLElement;

    let current = outcome;
    const paint = (o: OutcomeView): void => {
      current = o;
      (row.querySelector('strong') as HTMLElement).textContent = o.title;
      (row.querySelector('.result') as HTMLElement).textContent = o.score !== null && o.maxScore !== null
        ? `${o.score} / ${o.maxScore}` : o.kind.replace(/-/g, ' ');
      const work = o.commitmentId
        ? context?.commitments.find((item) => item.id === o.commitmentId)?.title ?? null
        : null;
      const topics = o.topicIds
        .map((id) => context?.topics.find((item) => item.id === id)?.label ?? null)
        .filter((label): label is string => !!label);
      const links = [...(work ? [work] : []), ...topics];
      (row.querySelector('.result-context') as HTMLElement).textContent = links.length
        ? `For ${links.join(' · ')}` : '';
      (row.querySelector('.result-note') as HTMLElement).textContent = o.feedback || o.summary;
    };
    paint(outcome);

    /** Back where it was — between the result and the form it opens — because
     *  a control that returns somewhere else is a different control. */
    const offerAgain = (): void => { if (!open.parentElement) row.insertBefore(open, host); };

    open.addEventListener('click', () => {
      open.remove();
      const edit = el(`<div class="correction-fields"><label><span>Result</span><input class="corrected-result" aria-label="Corrected result"><span class="meta input-limit">Up to 180 characters. I save the whole result name.</span></label><label><span>Kind</span><select class="corrected-kind" aria-label="Corrected kind"><option value="grade">Grade</option><option value="rubric">Rubric result</option><option value="teacher-feedback">Teacher feedback</option><option value="self-assessment">Self-assessment</option><option value="real-world">Real-world result</option></select></label><div class="score-fields"><label><span>Score <em>(optional)</em></span><input class="corrected-score" type="number" min="0" aria-label="Corrected score"></label><span>out of</span><label><span>Maximum <em>(optional)</em></span><input class="corrected-maximum" type="number" min="1" aria-label="Corrected maximum"></label></div>${context ? `<label><span>Course <em>(optional)</em></span><select class="corrected-course" aria-label="Corrected course"></select></label><label><span>Assignment <em>(optional)</em></span><select class="corrected-commitment" aria-label="Corrected assignment"></select></label><div class="corrected-topic-host"></div>` : ''}<label><span>Feedback or what you noticed <em>(optional)</em></span><textarea class="corrected-feedback" rows="3" aria-label="Corrected feedback"></textarea><span class="meta input-limit">Up to 6,000 characters. I save the whole note.</span></label><div class="row"><button>Save correction</button><button class="link" data-cancel-correction>Cancel</button></div><p class="note" role="status" aria-live="polite"></p></div>`);
      const title = edit.querySelector('.corrected-result') as HTMLInputElement;
      const kind = edit.querySelector('.corrected-kind') as HTMLSelectElement;
      const score = edit.querySelector('.corrected-score') as HTMLInputElement;
      const maximum = edit.querySelector('.corrected-maximum') as HTMLInputElement;
      const feedback = edit.querySelector('.corrected-feedback') as HTMLTextAreaElement;
      const course = edit.querySelector('.corrected-course') as HTMLSelectElement | null;
      const commitment = edit.querySelector('.corrected-commitment') as HTMLSelectElement | null;
      if (course && context) {
        course.innerHTML = optionsFor(context.courses, 'No course link');
        course.value = current.courseId ?? '';
      }
      if (commitment && context) {
        commitment.innerHTML = optionsFor(context.commitments, 'No assignment link');
        commitment.value = current.commitmentId ?? '';
      }
      if (course && commitment && context) bindOutcomeRelationship(course, commitment, context);
      const topicLinks = context
        ? topicPicker(
          edit.querySelector('.corrected-topic-host') as HTMLElement,
          context.topics, 'What did this test? (optional)', current.topicIds,
        )
        : null;
      topicLinks?.node.classList.add('corrected-topic-links');
      title.value = current.title;
      kind.value = current.kind;
      score.value = current.score === null ? '' : String(current.score);
      maximum.value = current.maxScore === null ? '' : String(current.maxScore);
      feedback.value = current.feedback || current.summary;
      const note = edit.querySelector('.note') as HTMLElement;
      const save = edit.querySelector('button') as HTMLButtonElement;
      const cancel = edit.querySelector('[data-cancel-correction]') as HTMLButtonElement;
      const clientRef = newClientRef();
      const release = protectUnsentForm(
        edit, 'result correction', [
          title, kind, score, maximum, ...(course ? [course] : []),
          ...(commitment ? [commitment] : []),
          ...Array.from(topicLinks?.node.querySelectorAll('input[type=checkbox]') ?? [])
            .map((box) => box as HTMLInputElement),
          feedback,
        ],
        () => { host.replaceChildren(); offerAgain(); }, () => title.focus(),
      );
      cancel.addEventListener('click', () => {
        release();
        host.replaceChildren();
        offerAgain();
        open.focus();
      });
      save.addEventListener('click', async () => {
        if (!title.value.trim()) { note.textContent = 'Name the result.'; title.focus(); return; }
        const titleChars = unicodeChars(title.value);
        if (titleChars > OUTCOME_TITLE_MAX_CHARS) {
          note.textContent = `That result name is ${titleChars.toLocaleString('en-US')} characters. `
            + 'Keep it to 180 so I can save all of it. Nothing was sent.';
          title.focus();
          return;
        }
        const feedbackChars = unicodeChars(feedback.value);
        if (feedbackChars > OUTCOME_FEEDBACK_MAX_CHARS) {
          note.textContent = `That result note is ${feedbackChars.toLocaleString('en-US')} characters. `
            + 'Keep it to 6,000 so I can save all of it. Nothing was sent.';
          feedback.focus();
          return;
        }
        if ((score.value && !maximum.value) || (!score.value && maximum.value)) {
          note.textContent = 'Give both numbers, or leave both blank.';
          (score.value ? maximum : score).focus();
          return;
        }
        save.disabled = true;
        edit.setAttribute('aria-busy', 'true');
        note.textContent = 'Saving the correction…';
        const courseId = course ? course.value || null : current.courseId;
        const commitmentId = commitment ? commitment.value || null : current.commitmentId;
        const topicIds = topicLinks ? topicLinks.chosen() : current.topicIds;
        const placementChanged = courseId !== current.courseId
          || commitmentId !== current.commitmentId
          || [...topicIds].sort().join('\u0000') !== [...current.topicIds].sort().join('\u0000');
        const saved = await apiResult<{ outcome?: OutcomeView; adaptation: AdaptationView }>(
          `/outcomes/${encodeURIComponent(current.id)}/correct`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...current, title: title.value, kind: kind.value,
            score: score.value || null, maxScore: maximum.value || null,
            feedback: feedback.value, courseId, commitmentId, topicIds, clientRef,
            availableMinutes: 3,
          }),
        });
        // Nothing was corrected, so nothing on the row changes. The same Save
        // action is restored inside the form with every edit intact; opening
        // a second editor beside it would be two retry routes for one write.
        if (saved.kind !== 'ok') {
          note.textContent = authoredWriteFailure(saved, 'result correction');
          edit.removeAttribute('aria-busy');
          save.disabled = false;
          save.focus();
          return;
        }
        release();
        const replacement = saved.body.outcome ?? {
          ...current, title: title.value, kind: kind.value,
          score: score.value ? Number(score.value) : null,
          maxScore: maximum.value ? Number(maximum.value) : null,
          feedback: feedback.value, courseId, commitmentId, topicIds,
        };
        if (placementChanged) {
          COURSE_RESULT_NOTICE = {
            outcomeId: replacement.id,
            line: saved.body.adaptation.changedBecause,
            changed: saved.body.adaptation.changed,
          };
          void renderCourses(replacement.courseId);
          return;
        }
        paint(replacement);
        // The form is finished with. What replaces it is the receipt — the same
        // sentence the recording form shows, in the row that now reads right.
        const line = el(`<p class="receipt-line" role="status" aria-live="polite"></p>`);
        line.textContent = saved.body.adaptation.changedBecause;
        const see = el(`<button class="link"></button>`);
        see.textContent = saved.body.adaptation.changed
          ? 'See the updated next move'
          : 'See the current next move';
        // Reread, rather than trusting `adaptation.after` after the write: a
        // second event may already have changed the ranking, and Today owns the
        // current answer. This is the same door initial result capture uses.
        see.addEventListener('click', () => void renderHome());
        host.replaceChildren(line, see);
        offerAgain();
        see.focus();
      });
      host.replaceChildren(edit);
      title.focus();
    });
  return row;
}

/** A dated commitment: core planning first; course/topic administration behind More. */
function commitmentForm(
  after: (createdId?: string, courseId?: string | null) => void,
  courses: readonly CoursePick[] = [], topics: readonly TopicPick[] = [],
  resume: () => void | Promise<void> = () => renderPlan(null, false, true, true),
  plannedDay: string | null = null,
): HTMLElement {
  const form = el(`<div class="repair-choice add-commitment">
    <label for="commitment-title">What do you need to do?</label>
    <input id="commitment-title" class="name title" type="text" placeholder="Marketing analysis" aria-describedby="commitment-title-limit">
    <span id="commitment-title-limit" class="meta input-limit">Up to 180 characters. I save the whole name.</span>
    <div class="fields commitment-essentials">
      <label class="field"><span>Deadline</span><input class="due" type="date"></label>
      <label class="field"><span>I plan to do it on <em>(optional)</em></span><input class="planned" type="date"></label>
    </div>
    <details class="commitment-more">
      <summary>More options</summary>
      <div class="fields commitment-options">
        <label class="field"><span>Kind</span><select class="kind">
          <option value="assignment">Assignment</option>
          <option value="lesson">Lesson or class</option>
          <option value="study">Study time</option>
          <option value="task">Something else</option>
        </select></label>
        <label class="field"><span>Deadline time <em>(optional)</em></span><input class="due-time" type="time"></label>
        <label class="field"><span>Repeat</span><select class="repeat-rule">
          <option value="none">Doesn't repeat</option>
          <option value="weekly">Every week</option>
        </select></label>
        <label class="field repeat-count" hidden><span>How many dates?</span><input type="number" min="2" max="20" step="1" value="6"></label>
      </div>
      <p class="deadline-zone"></p>
      <section class="recurrence-preview" aria-live="polite" hidden>
        <p></p><ol></ol>
      </section>
    </details>
    <div class="row"><button class="primary" data-add>Add it</button></div>
    <p class="note" role="status" aria-live="polite"></p>
  </div>`);
  const formKey = 'dated';
  const title = form.querySelector('.title') as HTMLInputElement;
  const kind = form.querySelector('.kind') as HTMLSelectElement;
  const due = form.querySelector('.due') as HTMLInputElement;
  const dueTime = form.querySelector('.due-time') as HTMLInputElement;
  const planned = form.querySelector('.planned') as HTMLInputElement;
  const repeatRule = form.querySelector('.repeat-rule') as HTMLSelectElement;
  const repeatCount = form.querySelector('.repeat-count input') as HTMLInputElement;
  const repeatCountField = form.querySelector('.repeat-count') as HTMLElement;
  const repeatPreview = form.querySelector('.recurrence-preview') as HTMLElement;
  const repeatPreviewLine = repeatPreview.querySelector('p') as HTMLElement;
  const repeatPreviewList = repeatPreview.querySelector('ol') as HTMLOListElement;
  const note = form.querySelector('[role=status]') as HTMLElement;
  const button = form.querySelector('[data-add]') as HTMLButtonElement;
  const optionalFields = form.querySelector('.commitment-options') as HTMLElement;
  const course = courses.length
    ? coursePicker(optionalFields, courses, 'Part of <em>(optional)</em>')
    : null;
  let rememberedTopics: string[] = [];
  try {
    const value = JSON.parse(addDraftValue(formKey, 'topicIds', '[]')) as unknown;
    if (Array.isArray(value)) rememberedTopics = value.filter((id): id is string => typeof id === 'string');
  } catch { /* a stale browser-only draft falls back to no topic links */ }
  const linked = topics.length
    ? topicPicker(optionalFields, topics, LINK_TO_TOPICS_FIELD, rememberedTopics)
    : null;

  title.value = addDraftValue(formKey, 'title');
  kind.value = addDraftValue(formKey, 'kind', kind.value);
  due.value = addDraftValue(formKey, 'due');
  dueTime.value = addDraftValue(formKey, 'dueTime');
  planned.value = plannedDay ?? addDraftValue(formKey, 'planned');
  repeatRule.value = addDraftValue(formKey, 'repeatRule', 'none');
  repeatCount.value = addDraftValue(formKey, 'repeatCount', '6');
  const seriesClientRef = addDraftValue(formKey, 'seriesClientRef', newClientRef());
  (form.querySelector('.deadline-zone') as HTMLElement).textContent =
    `A time uses ${localZone() || "your board's timezone"}. Leave it empty for a date-only deadline.`;
  if (course) course.value = addDraftValue(formKey, 'courseId', course.value);
  const remember = (): void => rememberAddDraft(formKey, {
    title: title.value, kind: kind.value, due: due.value, dueTime: dueTime.value,
    planned: planned.value, repeatRule: repeatRule.value, repeatCount: repeatCount.value,
    seriesClientRef,
    courseId: course?.value ?? '', topicIds: JSON.stringify(linked?.chosen() ?? []),
  });
  const updateRepeatPreview = (): void => {
    const weekly = repeatRule.value === 'weekly';
    repeatCountField.hidden = !weekly;
    repeatPreview.hidden = !weekly;
    if (!weekly) { button.disabled = false; return; }
    const count = Number(repeatCount.value);
    const dates = weeklyPreviewDates(due.value, count);
    repeatPreviewList.replaceChildren();
    if (!dates.length) {
      repeatPreviewLine.textContent = due.value
        ? 'Choose between 2 and 20 dates.'
        : 'Choose the first deadline to preview every date.';
      button.disabled = true;
      return;
    }
    repeatPreviewLine.textContent = `${dates.length} weekly deadlines will be added:`;
    const format = new Intl.DateTimeFormat('en', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    });
    for (const date of dates) {
      const item = el(`<li></li>`);
      item.textContent = `${format.format(new Date(`${date}T12:00:00.000Z`))}${
        dueTime.value ? ` at ${dueTime.value} ${localZone() || "your board's timezone"}` : ''}`;
      repeatPreviewList.append(item);
    }
    button.disabled = false;
  };
  for (const field of [
    title, kind, due, dueTime, planned, repeatRule, repeatCount, ...(course ? [course] : []),
  ]) {
    field.addEventListener('input', remember);
    field.addEventListener('change', remember);
  }
  for (const field of [due, dueTime, repeatRule, repeatCount]) {
    field.addEventListener('input', updateRepeatPreview);
    field.addEventListener('change', updateRepeatPreview);
  }
  for (const box of Array.from(linked?.node.querySelectorAll('input[type=checkbox]') ?? [])) {
    box.addEventListener('change', remember);
  }

  updateRepeatPreview();
  button.addEventListener('click', async () => {
    // Refused here rather than by the service, so the commonest mistake costs
    // no round trip.
    if (!title.value.trim()) { note.textContent = 'It needs a name.'; return; }
    if (refuseAuthoredOverflow(title.value, STUDY_TEXT_LIMITS.commitmentTitle,
      'assignment name', note, title)) return;
    if (!due.value) { note.textContent = 'And a deadline, or it is not a plan.'; return; }
    remember();
    const recurring = repeatRule.value === 'weekly';
    const dates = weeklyPreviewDates(due.value, Number(repeatCount.value));
    if (recurring && !dates.length) {
      note.textContent = 'Choose a first deadline and between 2 and 20 dates.';
      updateRepeatPreview();
      return;
    }
    const made = await addFormWrite<{
      commitment?: { id: string }; commitments?: { id: string }[];
    }>(form, button, note, recurring ? '/commitment-series' : '/commitments', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: title.value, kind: kind.value, dueAt: due.value,
        ...(dueTime.value ? { dueTime: dueTime.value } : {}),
        plannedFor: planned.value || null,
        courseId: course?.value || null,
        topicIds: linked ? linked.chosen() : [],
        ...(recurring ? {
          count: Number(repeatCount.value), clientRef: seriesClientRef,
        } : {}),
      }),
    }, 'Adding it to your plan…', 'That did not go through. Nothing has been added and your draft is still here.', resume);
    if (!made) return;
    ADD_FORM_DRAFTS.delete(formKey);
    after(made.body.commitment?.id ?? made.body.commitments?.[0]?.id, course?.value || null);
  });
  return form;
}

interface CoursePick { id: string; title: string }

/**
 * Which course this belongs to, appended to a form's own field grid.
 *
 * One picker, two forms, because "which course" is one question and a room that
 * asks it two different ways is a room with two answers to it. Built into the
 * existing `.fields` grid rather than above it, so it inherits the form's
 * geometry instead of setting its own.
 */
function coursePicker(
  fields: HTMLElement, courses: readonly CoursePick[], label: string,
  allowNone = true,
): HTMLSelectElement {
  const field = el(`<label class="field"><span>${label}</span><select class="course-pick"></select></label>`);
  const select = field.querySelector('select') as HTMLSelectElement;
  const add = (value: string, text: string): void => {
    const option = el(`<option></option>`) as HTMLOptionElement;
    option.setAttribute('value', value);
    option.value = value;
    option.textContent = text;
    select.append(option);
  };
  if (allowNone) add('', 'No course');
  for (const c of courses) add(c.id, c.title);
  // Set rather than inferred: the options are appended after the markup was
  // parsed, and a select whose value was never written is a select that posts
  // an empty string for whatever is showing in it.
  select.value = allowNone ? '' : (courses[0]?.id ?? '');
  fields.append(field);
  return select;
}

/**
 * WHAT THIS WORK LEANS ON — several answers, so several boxes.
 *
 * The course picker beside it is a select because a piece of work belongs to
 * one course. This is the other shape: an assignment leans on however many
 * things it leans on, and a select that forced one would be asking a question
 * the learner cannot answer honestly.
 *
 * The same `pick` row the split form uses, in the form's own field grid, so it
 * inherits the geometry rather than setting its own.
 */
function topicPicker(
  fields: HTMLElement, topics: readonly TopicPick[], label: string,
  already: readonly string[],
): { readonly node: HTMLElement; chosen(): string[] } {
  const field = el(`<div class="field topic-links">
    <span>${label}</span><div class="picks"></div>
  </div>`);
  const host = field.querySelector('.picks') as HTMLElement;
  for (const t of topics) {
    const row = el(`<label class="pick"><input type="checkbox"><span></span></label>`);
    const box = row.querySelector('input') as HTMLInputElement;
    box.setAttribute('value', t.id);
    box.value = t.id;
    if (already.includes(t.id)) {
      box.setAttribute('checked', 'checked');
      box.checked = true;
    }
    (row.querySelector('span') as HTMLElement).textContent = t.label;
    host.append(row);
  }
  fields.append(field);
  return {
    node: field,
    chosen: () => Array.from(field.querySelectorAll('input[type=checkbox]'))
      .filter((c) => (c as HTMLInputElement).checked)
      .map((c) => (c as HTMLInputElement).value),
  };
}

/**
 * MY STUDIES — everything being studied, and one way in.
 *
 * The room displays existing study material first; data-entry surfaces open
 * only after Add. The former room opened with
 * three forms — paste a syllabus, add a course, add material — stacked ABOVE
 * the first course, so a learner arriving to see what they were studying was
 * shown a page of data entry for things they had already entered. Everything
 * the room actually knew came after it, and half of what it knew was not drawn
 * at all: a course's kinds of material were carried on the wire and rendered
 * flat, its deadlines lived in the Plan, its results lived in the Plan, and the
 * topics it had grown on the board were counted and never named.
 *
 * So: recognition first. The room is what you are studying, in the order you
 * would look for it, and every way of putting something IN is behind the one
 * control on the title row.
 *
 * Two counts and never a percentage (`courseProgress`) still holds: what has
 * been got through, which the learner reports, and what has landed, which the
 * board knows. A course percentage is a comfort number with a course's name on
 * it, and  is that comfort is never shown as a number. Nothing here counts
 * what is left, either — a room that opens with "7 things outstanding" is the
 * backlog  forbids, wearing a different room's clothes.
 */
interface IntakeReviewFocus {
  readonly draftId: string;
  readonly selector: string;
}

interface CourseJourney {
  readonly returnToLearnAfterLinkRepair: boolean;
}

async function renderCourses(
  focus: string | null = null, openAdd = false, focusMaterial: string | null = null,
  reviewFocus: IntakeReviewFocus | null = null, focusNamedAfterWrite = false,
  addFocusSelector: string | null = null, writeFocusSelector: string | null = null,
  focusMaterialLink = false, focusMaterialPrimaryAction = false,
  returnQuery: string | null = null,
  journey: CourseJourney | null = null,
): Promise<void> {
  // Built before the frame, which clears the surface it would be appended to.
  const add = el(`<button class="primary" data-add-open>Add</button>`) as HTMLButtonElement;
  add.setAttribute('aria-expanded', 'false');
  add.setAttribute('aria-controls', 'studies-add-sheet');
  frame('courses', { title: 'My studies', action: add });
  roomContent.setAttribute('data-guide-target', 'manage-surface');
  roomContent.setAttribute('data-guide-section', 'manage-state');
  const owner = roomOwnership();

  // Board pin results already return to the exact search that opened them.
  // Course and material hits are the same search journey across a room seam:
  // preserve the query explicitly rather than making the learner reconstruct
  // it through Learn → Board. This does not take focus from the exact hit below.
  if (returnQuery) owner.content.append(boardExit(returnQuery));

  const sheetHost = el(`<div id="studies-add-sheet" class="add-sheet-host"></div>`);
  owner.content.append(sheetHost);
  if (COURSE_DROP_NOTICE) {
    const notice = el('<p class="course-drop-notice" role="status" aria-live="polite" tabindex="-1"></p>');
    notice.textContent = COURSE_DROP_NOTICE;
    COURSE_DROP_NOTICE = null;
    owner.content.append(notice);
  }
  if (COURSE_DROP_ISSUES.length) {
    const issues = el(`<details class="course-drop-issues">
      <summary></summary>
      <p class="meta">These files were not added. Their names and repair are kept here so you do not have to guess which ones they were.</p>
      <ul></ul>
      <div class="row"><button class="primary" data-add-another>Add one another way</button><button class="link" data-dismiss-issues>Dismiss this list</button></div>
    </details>`);
    (issues.querySelector('summary') as HTMLElement).textContent =
      `${COURSE_DROP_ISSUES.length} ${COURSE_DROP_ISSUES.length === 1 ? 'file needs' : 'files need'} another route`;
    const list = issues.querySelector('ul') as HTMLElement;
    for (const issue of COURSE_DROP_ISSUES) {
      const row = el('<li><strong></strong><span></span></li>');
      (row.querySelector('strong') as HTMLElement).textContent = issue.name;
      (row.querySelector('span') as HTMLElement).textContent = issue.detail;
      list.append(row);
    }
    issues.querySelector('[data-add-another]')!.addEventListener('click', () => {
      void renderCourses(null, true, null, null, false, '.source-text');
    });
    issues.querySelector('[data-dismiss-issues]')!.addEventListener('click', () => {
      COURSE_DROP_ISSUES = [];
      issues.remove();
      add.focus();
    });
    owner.content.append(issues);
  }
  if (COURSE_DROP_SHORTENED.length) {
    const shortened = el(`<details class="course-drop-issues course-drop-shortened">
      <summary></summary>
      <p class="meta">These files are on your board, but their full text did not fit the document boundary. Their names are kept here so you can add the missing part if it matters.</p>
      <ul></ul>
      <div class="row"><button class="primary" data-add-tail>Add missing part</button><button class="link" data-dismiss-shortened>Dismiss this list</button></div>
    </details>`);
    (shortened.querySelector('summary') as HTMLElement).textContent =
      `${COURSE_DROP_SHORTENED.length} ${COURSE_DROP_SHORTENED.length === 1 ? 'file was' : 'files were'} shortened`;
    const list = shortened.querySelector('ul') as HTMLElement;
    for (const issue of COURSE_DROP_SHORTENED) {
      const row = el('<li><strong></strong><span></span></li>');
      (row.querySelector('strong') as HTMLElement).textContent = issue.name;
      (row.querySelector('span') as HTMLElement).textContent = issue.detail;
      list.append(row);
    }
    shortened.querySelector('[data-add-tail]')!.addEventListener('click', () => {
      void renderCourses(null, true, null, null, false, '.source-text');
    });
    shortened.querySelector('[data-dismiss-shortened]')!.addEventListener('click', () => {
      COURSE_DROP_SHORTENED = [];
      shortened.remove();
      add.focus();
    });
    owner.content.append(shortened);
  }

  const [data, intake, results, scouted] = await Promise.all([
    api<CoursesView>('/courses'),
    api<{ drafts: IntakeDraftView[] }>('/course-intakes'),
    api<{ outcomes: OutcomeView[] }>('/outcomes'),
    api<{ proposals: ProspectProposalView[] }>('/prospects'),
  ]);
  if (!ownsRoom(owner)) return;
  if (!data) {
    // Every route in the sheet posts to the service, so a control that opened
    // one here would be a control that cannot do the thing it offers. Disabled
    // and left visible: the room is not pretending the way in has gone.
    (add as HTMLButtonElement).disabled = true;
    owner.content.append(el(`<p class="empty">${esc(VIRGIL_UNAVAILABLE)}</p>`));
    return;
  }

  const again = (
    courseId: string | null = null, materialId: string | null = null, materialLink = false,
  ): void => {
    void renderCourses(courseId, false, materialId, null, false, null, null, materialLink);
  };
  const courses = data.courses ?? [];
  // The room that owns this read hands it to the search box, so the board's
  // index is refreshed by every visit here rather than aging quietly behind a
  // course somebody has just added.
  COURSE_INDEX = courses;
  COURSE_INDEX_UNREADABLE_STATE = false;
  /**
   * Read, or not read at all — and the difference travels rather than being
   * flattened here.
   *
   * `results?.outcomes ?? []` turned a `/outcomes` that never answered into a
   * learner with no results, and a learner with no results is drawn by drawing
   * no Results section anywhere. So `/courses` succeeding while `/outcomes`
   * failed produced a room where every recorded grade had silently stopped
   * existing, on the two surfaces built to show them. `null` goes down to the
   * sections that draw them and each one says what could not be read, in the
   * place the results would have been.
   */
  const outcomes = results ? results.outcomes ?? [] : null;
  const unattached = data.unattached ?? { commitments: [], topics: [] };
  const archivedCourses = data.archivedCourses ?? [];
  /**
   * Every topic the room already knows about, so the date form can offer the
   * link that makes a deadline shape teaching. Read out of what is on screen
   * rather than fetched again: `/courses` carries each course's topics and the
   * loose ones, which between them are the board.
   */
  const boardTopics: TopicPick[] = [];
  for (const chip of [...courses.flatMap((c) => c.topics ?? []), ...(unattached.topics ?? [])]) {
    if (!boardTopics.some((t) => t.id === chip.id)) boardTopics.push(chip);
  }

  const toggleAdd = exclusiveAddToggle(add, sheetHost, owner.content, guardNavigation, () =>
    addSheet(
      ADD_ROUTES,
      (key) => routeForm(
        key as AddRouteKey, courses, again, boardTopics, data.outcomeContext ?? null,
      ),
      STUDIES_ADD_ROUTE,
      (key) => { STUDIES_ADD_ROUTE = key as AddRouteKey; },
    ));
  add.addEventListener('click', toggleAdd);

  /**
   * The drafts, above the courses, under one honest heading.
   *
   * The rule is the simplest one that is true: **every unapplied draft needs
   * the learner's eye**, because a draft is a proposal and nothing in it has
   * reached the plan. A blocking question changes what the card lets them do —
   * "Confirm and add" stays disabled — and does not change whether the card is
   * their business. So one section, one rule, and no draft ever disappears
   * because it happened to answer its own questions.
   *
   * And `null` when the read did not happen, carried for the same reason
   * `outcomes` is: a draft is something the learner pasted in and is waiting to
   * confirm, and a section that is not drawn says they have nothing waiting.
   * A section that says it could not look says the thing that is true.
   */
  const drafts = intake ? (intake.drafts ?? []).filter((d) => d.status === 'draft') : null;
  // A successful apply removes the draft from service truth. Once that read is
  // known-good, its browser-only corrections no longer have anything to own.
  if (drafts !== null) {
    const liveDrafts = new Set(drafts.map((draft) => draft.id));
    for (const draftId of INTAKE_REVIEW_DRAFTS.keys()) {
      if (!liveDrafts.has(draftId)) INTAKE_REVIEW_DRAFTS.delete(draftId);
    }
  }
  const needs = drafts === null || drafts.length
    ? el(`<section class="needs-eye"><h2>Needs your eye</h2></section>`) : null;
  if (needs) {
    if (drafts === null) needs.append(el(`<p class="empty">${esc(draftsUnreadableLine())}</p>`));
    else for (const draft of drafts) needs.append(intakeDraftBlock(draft, focus));
    owner.content.append(needs);
  }

  // What the night proposed, beside what the learner handed over: both are
  // proposals, both wait on the same person, so both are in this room.
  if (scouted?.proposals?.length) {
    owner.content.append(prospectSection(scouted.proposals, (id, state) =>
      api(`/prospects/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ field: 'state', value: state satisfies ProspectDecision }),
      }).then((answer) => answer !== null)));
  }

  const outcomeContext = data.outcomeContext ?? null;
  for (const c of courses) owner.content.append(courseBlock(
    c, courses, outcomes, outcomeContext,
    (courseId: string, materialId?: string, materialLink?: boolean) =>
      again(courseId, materialId ?? null, materialLink ?? false),
    focus,
    journey?.returnToLearnAfterLinkRepair ? focusMaterial : null,
  ));

  if (archivedCourses.length) {
    const shelf = el(`<details class="archived-shelf"><summary>Archived</summary><div class="rows"></div></details>`);
    const rows = shelf.querySelector('.rows') as HTMLElement;
    for (const c of archivedCourses) rows.append(archivedCourseBlock(
      c, outcomes, outcomeContext, again, focus,
    ));
    owner.content.append(shelf);
  }

  const knownCourseIds = new Set([...courses, ...archivedCourses].map((course) => course.id));
  const loose = notInACourse(unattached, outcomes, knownCourseIds, outcomeContext);
  if (loose) owner.content.append(loose);

  /**
   * The result write happened in this room, so its authoritative reread and
   * the reason the next move did or did not change land together. A missing
   * row means `/outcomes` could not be reread; the write receipt still survives
   * above the courses rather than being mistaken for a failed write.
   */
  if (COURSE_RESULT_NOTICE) {
    const notice = COURSE_RESULT_NOTICE;
    COURSE_RESULT_NOTICE = null;
    const row = Array.from(owner.content.querySelectorAll('.outcome-row'))
      .find((candidate) => candidate.getAttribute('data-outcome') === notice.outcomeId) as HTMLElement | undefined;
    const receipt = el(`<div class="adaptation result-recorded" role="status" aria-live="polite">
      <p class="receipt-line"></p><button class="link"></button>
    </div>`);
    (receipt.querySelector('.receipt-line') as HTMLElement).textContent = notice.line;
    const next = receipt.querySelector('button') as HTMLButtonElement;
    next.textContent = notice.changed ? 'See the updated next move' : 'See the current next move';
    next.addEventListener('click', () => void renderHome());
    if (row) {
      row.append(receipt);
      row.setAttribute('tabindex', '-1');
      row.focus();
    } else {
      const unread = el(`<div class="course-result-notice" tabindex="-1">
        <p class="meta">The result was recorded, but I could not reread your results here.</p>
      </div>`);
      unread.append(receipt);
      owner.content.insertBefore(unread, owner.content.children[1] ?? null);
      unread.focus();
    }
  }

  // Nothing added yet is a claim about the learner, so it is made only when all
  // three reads landed and all three were genuinely empty. A read that failed
  // has already drawn its own line above and is not evidence of an empty room.
  if (!courses.length && !archivedCourses.length && !needs && !loose) {
    owner.content.append(el(`<p class="bare">Nothing added yet. A course is somewhere your material comes from: a class, a channel, a book.</p>`));
  }

  // Open after the room is complete so deep links hide every course card too.
  if (openAdd) toggleAdd();

  if (writeFocusSelector) {
    const target = owner.content.querySelector(writeFocusSelector) as HTMLElement | null;
    if (target) {
      // Native interactive targets keep their tab stop after the write. Plain
      // receipts need -1 only so focus can announce them once.
      if (!target.matches('summary, button, input, select, textarea, a[href]')) {
        target.setAttribute('tabindex', '-1');
      }
      target.focus();
    }
    else add.focus();
  } else if (addFocusSelector) {
    (sheetHost.querySelector(addFocusSelector) as HTMLElement | null)?.focus();
  } else if (focusMaterial) {
    const material = Array.from(owner.content.querySelectorAll('.material')).find(
      (row) => row.getAttribute('data-material') === focusMaterial,
    );
    if (focusMaterialLink) {
      const link = material?.querySelector('a[href]') as HTMLElement | null;
      if (link) link.focus();
      else (material?.querySelector('[data-edit-link]') as HTMLElement | null)?.click();
    } else if (focusMaterialPrimaryAction) {
      const link = material?.querySelector('a[href]') as HTMLElement | null;
      if (link) link.focus();
      else (material?.querySelector('.tick') as HTMLElement | null)?.focus();
    } else (material?.querySelector('.tick') as HTMLElement | null)?.focus();
  } else if (reviewFocus) {
    const review = Array.from(owner.content.querySelectorAll('.intake-review')).find(
      (candidate) => candidate.getAttribute('data-draft') === reviewFocus.draftId,
    );
    const target = review?.querySelector(reviewFocus.selector) as HTMLElement | null;
    // Corrections and rejected proposals both live in disclosures. A redraw
    // recreates those disclosures closed, and real browsers refuse to focus a
    // hidden descendant — leaving the learner at BODY after a successful save.
    // Open whichever disclosure owns the exact return target before focusing.
    for (const disclosure of Array.from(review?.querySelectorAll('details') ?? [])) {
      if (disclosure.querySelector(reviewFocus.selector)) disclosure.setAttribute('open', '');
    }
    target?.focus();
  } else if (focusNamedAfterWrite && focus) {
    const named = Array.from(owner.content.querySelectorAll('.course, .archived-course, .intake-review')).find(
      (candidate) => candidate.getAttribute('data-course') === focus
        || candidate.getAttribute('data-draft') === focus,
    ) as HTMLElement | undefined;
    if (named) {
      // An archived course is redrawn inside a closed disclosure. Browsers do
      // not move focus into hidden descendants, even though the DOM test
      // environment permits it. Open only the owning shelf so the learner
      // lands on the exact course that just moved instead of falling to BODY.
      let ownerDisclosure: HTMLElement | null = named.parentElement;
      while (ownerDisclosure && !ownerDisclosure.matches('.archived-shelf')) {
        ownerDisclosure = ownerDisclosure.parentElement;
      }
      ownerDisclosure?.setAttribute('open', '');
      named.setAttribute('tabindex', '-1');
      named.focus();
    }
  }
}

/**
 * The four ways in, behind one control.
 *
 * Same four forms, same four endpoints, same copy — moved. The sheet closes
 * itself on a successful submit because every one of them redraws the room, and
 * a form still standing open over the thing it just created is a form that looks
 * like it did not work.
 */
function addSheet(
  routes: readonly { readonly key: string; readonly label: string }[],
  form: (key: string) => HTMLElement,
  initialKey = routes[0]!.key,
  onRoute: (key: string) => void = () => {},
): HTMLElement {
  const node = el(`<section class="add-sheet">
    <nav class="add-routes" aria-label="What to add"></nav>
    <div class="add-route"></div>
  </section>`);
  const tabs = node.querySelector('.add-routes') as HTMLElement;
  const body = node.querySelector('.add-route') as HTMLElement;

  const draw = (key: string): void => {
    onRoute(key);
    for (const tab of Array.from(tabs.querySelectorAll('button'))) {
      tab.setAttribute('aria-current', tab.getAttribute('data-route') === key ? 'page' : 'false');
    }
    body.replaceChildren(form(key));
    // A prerequisite named inside a route must be a route, not an instruction
    // to reverse-engineer the tabs above it. `data-add-route` keeps the handoff
    // inside this one sheet and `data-route-focus` lands on the first real
    // decision in the destination form.
    for (const handoff of Array.from(body.querySelectorAll('[data-add-route]'))) {
      handoff.addEventListener('click', () => {
        const target = handoff.getAttribute('data-add-route') ?? '';
        if (!routes.some((route) => route.key === target)) return;
        const focus = handoff.getAttribute('data-route-focus');
        guardNavigation(() => {
          draw(target);
          if (focus) (body.querySelector(focus) as HTMLElement | null)?.focus();
        });
      });
    }
  };

  for (const route of routes) {
    const tab = el(`<button class="add-route-tab" data-route="${esc(route.key)}"></button>`);
    tab.textContent = route.label;
    tab.addEventListener('click', () => guardNavigation(() => draw(route.key)));
    tabs.append(tab);
  }
  draw(routes.some((route) => route.key === initialKey) ? initialKey : routes[0]!.key);
  return node;
}

/** One request-state contract for the hand-entered Add forms. */
async function addFormWrite<T>(
  form: HTMLElement, button: HTMLButtonElement, note: HTMLElement,
  path: string, init: RequestInit, pending: string, failed: string,
  resume: () => void | Promise<void>,
): Promise<{ readonly kind: 'ok'; readonly body: T } | null> {
  button.disabled = true;
  form.setAttribute('aria-busy', 'true');
  note.textContent = pending;
  const result = await apiResult<T>(path, init);
  if (await reopenSignInForExpiredIdentity(result, resume)) return null;
  if (result.kind !== 'ok') {
    note.textContent = failed;
    form.removeAttribute('aria-busy');
    button.disabled = false;
    button.focus();
    return null;
  }
  return result;
}

function routeForm(
  key: AddRouteKey, courses: readonly CoursePick[], after: () => void,
  topics: readonly TopicPick[] = [], outcomeContext: OutcomeContextView | null = null,
): HTMLElement {
  const resume = (): void => {
    void renderCourses(null, true, null, null, false, '[data-add]');
  };
  if (key === 'course') return courseForm(after, resume);
  if (key === 'material') {
    // Material belongs to a course by construction, so this route says what is
    // is missing and completes the route to it rather than offering a form
    // that cannot be sent or making the learner infer a neighbouring tab.
    if (!courses.length) {
      return el(`<div class="repair-choice material-needs-course">
        <p class="bare">Material lives in a course. Add the course first and this fills up.</p>
        <div class="row"><button class="primary" data-add-route="course" data-route-focus=".title">Add a course</button></div>
      </div>`);
    }
    return materialForm(courses, after, resume);
  }
  if (key === 'dated') return commitmentForm((_createdId, courseId) => {
    void renderCourses(courseId, false, null, null, !!courseId);
  }, courses, topics, resume);
  if (key === 'result') {
    if (!outcomeContext) {
      const fallback = el(`<div class="repair-choice result-needs-context">
        <p class="bare">I cannot read the course and assignment choices here right now.</p>
        <div class="row"><button class="primary">Open the result form in Plan</button></div>
      </div>`);
      fallback.querySelector('button')!.addEventListener('click', () => {
        PLAN_ADD_ROUTE = 'result';
        void renderPlan(null, false, true, true);
      });
      return fallback;
    }
    return outcomeForm(outcomeContext, () => {}, (outcome, adaptation) => {
      COURSE_RESULT_NOTICE = {
        outcomeId: outcome.id,
        line: adaptation.changedBecause,
        changed: adaptation.changed,
      };
      void renderCourses(outcome.courseId, false, null, null, false);
    });
  }
  return intakeForm();
}

interface CoursesView {
  courses: CourseView[];
  archivedCourses?: CourseView[];
  /** The choices for the result form this room owns. Projected by `/courses`
   * from lists it already reads, so opening My studies costs no extra request. */
  outcomeContext?: OutcomeContextView;
  /** Added 2026-08-24. Absent from an older service, which draws no section. */
  unattached?: { commitments: CommitmentView[]; topics: TopicChipView[] };
}
interface TopicChipView { id: string; label: string }
interface CourseView {
  id: string; title: string; provider: string; url: string;
  archivedAt?: string | null;
  material: MaterialView[];
  objectives?: { id: string; text: string; source: { sourceId: string; quote: string } | null }[];
  sources?: {
    id: string; title: string; kind: string; digest: string;
    text?: string; url?: string | null; capturedAt?: string;
  }[];
  /** This course's open obligations, joined by the service. */
  commitments?: CommitmentView[];
  /** The board's labels for the topics this course grew. */
  topics?: TopicChipView[];
  progress: { covered: number; materialCount: number; learnt: number; topicCount: number };
}
interface MaterialView {
  id: string; title: string; url: string; kind: string;
  minutes: number | null; doneAt: string | null; progressMinutes?: number;
}

interface IntakeDraftView {
  id: string; status: 'draft' | 'applied'; title: string; provider: string; url: string;
  source: { id: string; title: string; kind: string; text: string; digest: string };
  objectives: { id: string; text: string; source: { sourceId: string; quote: string } | null }[];
  material: { id: string; title: string; url: string; kind: string; minutes: number | null; source: { quote: string } }[];
  commitments: {
    id: string; title: string; dueAt: string | null;
    dueTime?: string | null; dueTimeZone?: string | null;
    source: { quote: string }; rubricCriteria: { label: string }[];
  }[];
  questions: { id: string; field: string; prompt: string; blocking: boolean; resolvedAt: string | null }[];
  rejected?: { kind: 'objective' | 'material' | 'commitment'; id: string; rejectedAt: string }[];
  warnings: string[];
  enrichment?: {
    outcome: 'enriched' | 'nothing-added' | 'model-failed'; attemptedAt: string;
    added: { objectives: number; commitments: number; questions: number };
  };
}

const COURSE_DROP_LIMIT = 300;
/** Four MiB below the deployed HTTP/1 boundary; mirrored and source-guarded
 *  against `runner/src/service.ts`. A large folder is chunked, not refused. */
const COURSE_DROP_REQUEST_BYTES = 28 * 1024 * 1024;

/**
 * Cheap, inspectable triage for a folder before it reaches the deterministic
 * course-drop boundary. Planning-shaped files become proposals; everything
 * else becomes material only. A false positive can therefore create review
 * work, never a course or deadline, while a false negative still lands safely
 * on the board and can be added as a source later.
 */
function courseDropKind(name: string, text: string | null): CourseDropKind {
  const named = name.toLowerCase().replace(/[_-]+/g, ' ');
  if (/\b(rubric|marking (guide|criteria)|grading criteria)\b/.test(named)) return 'rubric';
  if (/\b(syllabus|unit outline|course outline|subject outline|unit guide)\b/.test(named)) return 'syllabus';
  if (/\b(assignment|assessment|project) (brief|task|sheet)\b/.test(named)) return 'assignment-brief';

  const sample = (text ?? '').slice(0, 12_000).toLowerCase();
  if (/\b(rubric|marking criteria|grading criteria)\b/.test(sample)) return 'rubric';
  if (/\b(syllabus|unit outline|course outline|subject outline)\b/.test(sample)
    || (/\blearning outcomes\b/.test(sample) && /\b(assessment|schedule|week)\b/.test(sample))) {
    return 'syllabus';
  }
  if (/\b(assignment brief|assessment task|submission requirements)\b/.test(sample)) {
    return 'assignment-brief';
  }
  return 'learner-note';
}

/** Paste or choose one source, or hand Virgil the whole course folder. */
function intakeForm(): HTMLElement {
  const form = el(`<section class="intake-start">
    <div class="eyebrow">Turn the messy version into a plan</div>
    <h2>Add course sources</h2>
    <p class="meta">Paste one source, choose one file, or hand Virgil a whole course folder. Planning details stay as proposals until you review them.</p>
    <div class="fields">
      <label class="field"><span>What is it?</span><select class="kind">
        <option value="syllabus">Syllabus or course outline</option>
        <option value="rubric">Rubric</option>
        <option value="assignment-brief">Assignment brief</option>
        <option value="course-page">Course page</option>
        <option value="learner-note">My notes</option>
      </select></label>
      <label class="field"><span>Source name <em>(optional)</em></span><input class="name source-title" placeholder="Unit outline"><span class="meta input-limit">Up to 160 characters. I save the whole source name.</span></label>
    </div>
    <label for="intake-source">Source</label>
    <textarea id="intake-source" class="source-text" rows="8" placeholder="Paste the real source here…" aria-describedby="intake-source-limit intake-source-help intake-source-status"></textarea>
    <span id="intake-source-limit" class="meta input-limit">Up to 60,000 characters. I keep the whole source for review.</span>
    <div class="dropper">
      <button class="link" data-pick-source>Upload source file</button>
      <input type="file" class="picker" data-file-source accept="${VISION_UPLOAD_ACCEPT}" hidden>
      <span id="intake-source-help" class="meta how">Pick a document, PNG or JPEG. I put the words in this box for you to check before anything is imported.</span>
    </div>
    <p id="intake-source-status" class="meta read-note" aria-live="polite"></p>
    <div class="row"><button class="primary" data-review>Review the import</button></div>
    <p class="note" role="status" aria-live="polite"></p>
    <section class="semester-drop">
      <div class="eyebrow">A whole course at once</div>
      <h3>Add a folder</h3>
      <p class="meta">Choose up to 300 .txt, .md, .docx or .pdf files. Virgil reads each one, puts readable material on your board, and separates likely syllabuses, rubrics and briefs for review. Nothing becomes a deadline without you.</p>
      <div class="row">
        <button class="primary" data-pick-folder>Choose course folder</button>
        <button class="primary" data-send-folder hidden>Import ready folder</button>
        <input type="file" class="folder-picker" data-folder-source accept="${UPLOAD_ACCEPT}" webkitdirectory directory multiple hidden>
      </div>
      <p class="meta folder-status" role="status" aria-live="polite"></p>
    </section>
  </section>`);
  const text = form.querySelector('.source-text') as HTMLTextAreaElement;
  const kind = form.querySelector('.kind') as HTMLSelectElement;
  const title = form.querySelector('.source-title') as HTMLInputElement;
  const note = form.querySelector('.note') as HTMLElement;
  const readNote = form.querySelector('.read-note') as HTMLElement;
  const picker = form.querySelector('[data-file-source]') as HTMLInputElement;
  const button = form.querySelector('[data-review]') as HTMLButtonElement;
  const folderPicker = form.querySelector('[data-folder-source]') as HTMLInputElement;
  const folderButton = form.querySelector('[data-pick-folder]') as HTMLButtonElement;
  const folderSend = form.querySelector('[data-send-folder]') as HTMLButtonElement;
  const folderStatus = form.querySelector('.folder-status') as HTMLElement;
  let sourceReadEpoch = 0;

  if (INTAKE_MEMORY) {
    kind.value = INTAKE_MEMORY.kind;
    title.value = INTAKE_MEMORY.title;
    text.value = INTAKE_MEMORY.text;
  }
  const remember = (): void => {
    INTAKE_MEMORY = { kind: kind.value, title: title.value, text: text.value };
  };
  kind.addEventListener('change', remember);
  title.addEventListener('input', remember);
  text.addEventListener('input', remember);

  const readIntoSource = async (file: UploadFile | null): Promise<void> => {
    if (!file) return;
    const token = ++sourceReadEpoch;
    const image = pageFormatOf(file.name, file.type ?? '') === 'image';
    button.disabled = true;
    picker.disabled = true;
    form.setAttribute('aria-busy', 'true');
    readNote.textContent = image ? TRANSCRIBING_SOURCE_IMAGE : READING_FILE;
    readNote.classList.remove('refused');
    try {
      if (image) {
        const rendered = await readPages(file);
        if (token !== sourceReadEpoch) return;
        if (rendered.kind !== 'pages') {
          readNote.textContent = sourceImageReadLine(rendered, file.name) ?? '';
          readNote.classList.add('refused');
          return;
        }
        const typed = await apiResult<TranscribeView>('/transcribe-pages', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ media: rendered.pages }),
        });
        if (token !== sourceReadEpoch) return;
        if (await reopenSignInForExpiredIdentity(
          typed, () => renderCourses(null, true, null, null, false, '[data-pick-source]'),
        )) return;
        const outcome = typed.kind === 'ok' ? String(typed.body.outcome ?? '')
          : typed.kind === 'refused' && typed.status === 402 ? 'budget-stopped'
            : typed.kind === 'refused' && typed.status === 409
              && typed.stoppedBy === 'model-credential' ? 'credential-missing'
                : 'model-failed';
        readNote.textContent = sourceImageTranscriptionLine(outcome);
        readNote.classList.toggle('refused', outcome !== 'transcribed');
        if (typed.kind !== 'ok') appendBudgetRecovery(readNote, typed);
        if (typed.kind === 'ok' && outcome === 'transcribed' && typed.body.text?.trim()) {
          text.value = appendText(text.value, typed.body.text);
          remember();
        }
        return;
      }

      const outcome = await readUpload(file);
      if (token !== sourceReadEpoch) return;
      const line = uploadOutcomeLine(outcome, file.name) ?? '';
      readNote.textContent = line;
      readNote.classList.toggle('refused', outcome.kind !== 'text');
      if (outcome.kind === 'text') {
        text.value = appendText(text.value, outcome.text);
        remember();
      }
    } finally {
      if (token === sourceReadEpoch) {
        button.disabled = false;
        picker.disabled = false;
        form.removeAttribute('aria-busy');
      }
    }
  };

  form.querySelector('[data-pick-source]')!.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    void readIntoSource((picker.files?.[0] as UploadFile | undefined) ?? null);
    picker.value = '';
  });
  text.addEventListener('dragover', (event) => event.preventDefault());
  text.addEventListener('drop', (event) => {
    event.preventDefault();
    void readIntoSource((event.dataTransfer?.files?.[0] as UploadFile | undefined) ?? null);
  });

  const sendFolder = async (): Promise<void> => {
    const selection = COURSE_DROP_MEMORY;
    if (!selection) return;
    folderButton.disabled = true;
    folderSend.disabled = true;
    form.setAttribute('aria-busy', 'true');
    type DropResult = {
      read: number; failed: number; planned: number;
      items: {
        draftId?: string | null; ok?: boolean; name?: string; detail?: string;
        truncated?: boolean;
      }[];
      queue: { nights: number };
    };
    const results: DropResult[] = [];
    const draftFor = (items: CourseDropItemDraft[]): CourseDropDraft => ({
      title: selection.title, dropId: selection.dropId, items,
    });
    try {
      const chunks = mapPayloadChunks(
        selection.files,
        async (file, index): Promise<CourseDropItemDraft> => {
          const visiblePath = folderItemPath(file.name, file.webkitRelativePath);
          folderStatus.textContent = `Reading ${index + 1} of ${selection.files.length}: ${visiblePath}`;
          const outcome = await readUpload(file);
          const relative = file.webkitRelativePath?.trim() || file.name;
          const sourceText = outcome.kind === 'text' ? outcome.text : null;
          return {
            // The path is provenance and stays in `name`; it is not a safe
            // protocol key. Course folders can contain invisible controls or
            // paths longer than the service identity bound, either of which
            // turns a deterministic 400 into an endless Finish-folder loop.
            // File order is fixed inside the retained selection and `dropId`
            // is fresh for every selection, so the bounded ordinal is the
            // exact, stable retry identity this browser owns.
            clientRef: `item-${index + 1}`,
            name: visiblePath,
            kind: courseDropKind(relative, sourceText),
            mimeType: file.type ?? '',
            text: sourceText,
          };
        },
        draftFor,
        COURSE_DROP_REQUEST_BYTES,
        (item) => new Error(`one file exceeds the course-drop request limit: ${item.name}`),
      );
      for await (const chunk of chunks) {
        folderStatus.textContent = chunk.from === chunk.to
          ? `Adding file ${chunk.to} of ${chunk.total} to your board…`
          : `Adding files ${chunk.from} to ${chunk.to} of ${chunk.total} to your board…`;
        const made = await apiResult<DropResult>('/course-drops', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(draftFor([...chunk.items])),
        });
        if (made.kind !== 'ok') selection.interrupted = true;
        if (await reopenSignInForExpiredIdentity(made, () => {
          void renderCourses(null, true, null, null, false, '[data-send-folder]');
        })) return;
        if (made.kind !== 'ok') {
          folderStatus.textContent = interruptedCourseDropLine(
            selection.checkedThrough, selection.files.length,
          );
          form.removeAttribute('aria-busy');
          folderButton.disabled = false;
          folderSend.disabled = false;
          folderSend.hidden = false;
          folderSend.textContent = 'Finish folder import';
          folderSend.focus();
          return;
        }
        results.push(made.body);
        selection.checkedThrough = Math.max(selection.checkedThrough, chunk.to);
      }
    } catch (error) {
      // This is not a transport interruption: the generator proved one item
      // cannot fit even in an otherwise empty request. Retaining a retry button
      // would offer an action that can only fail again, and a later redraw used
      // to resurrect exactly that dead action from COURSE_DROP_MEMORY.
      COURSE_DROP_MEMORY = null;
      const detail = error instanceof Error && error.message
        ? `${error.message[0]!.toUpperCase()}${error.message.slice(1)}`
        : 'One extracted file exceeds the course-drop request limit';
      folderStatus.textContent = `${detail}. Choose the folder again without that file.`;
      form.removeAttribute('aria-busy');
      folderButton.disabled = false;
      folderSend.disabled = false;
      folderSend.hidden = true;
      folderButton.focus();
      return;
    }

    COURSE_DROP_MEMORY = null;
    const read = results.reduce((sum, result) => sum + result.read, 0);
    const failed = results.reduce((sum, result) => sum + result.failed, 0);
    // `planned` in each service receipt means newly created in that request.
    // A retry deliberately replays every chunk under the same drop/item ids, so
    // already-created proposals return as repeated. Count the proposal ids in
    // the converged receipt instead: that is what now needs the learner's eye.
    const planned = results
      .flatMap((result) => result.items)
      .filter((item) => Boolean(item.draftId))
      .length;
    const queue = results.at(-1)?.queue ?? { nights: 1 };
    COURSE_DROP_ISSUES = results.flatMap((result) => result.items)
      .filter((item) => item.ok === false)
      .map((item) => ({
        name: item.name?.trim() || 'Unnamed file',
        detail: item.detail?.trim() || 'Virgil could not read this file. Add it another way.',
      }));
    COURSE_DROP_SHORTENED = results.flatMap((result) => result.items)
      .filter((item) => item.ok !== false && item.truncated === true)
      .map((item) => ({
        name: item.name?.trim() || 'Unnamed file',
        detail: item.detail?.trim()
          || 'Only the first 200,000 characters were kept. Add the missing part as another source if it matters.',
      }));
    const parts = [
      `${read} ${read === 1 ? 'file is' : 'files are'} on your board.`,
      failed ? `${failed} ${failed === 1 ? 'file needs' : 'files need'} your attention.` : '',
      COURSE_DROP_SHORTENED.length
        ? `${COURSE_DROP_SHORTENED.length} ${COURSE_DROP_SHORTENED.length === 1 ? 'file was' : 'files were'} shortened and named below.`
        : '',
      planned
        ? `${planned} ${planned === 1 ? 'plan proposal needs' : 'plan proposals need'} your eye.`
        : 'No plan proposals were made.',
      read ? `Background reading is queued across about ${queue.nights} ${queue.nights === 1 ? 'run' : 'runs'}.` : '',
    ].filter(Boolean);
    COURSE_DROP_NOTICE = parts.join(' ');
    const firstDraft = results.flatMap((result) => result.items)
      .find((item) => item.draftId)?.draftId ?? null;
    void renderCourses(
      firstDraft, false, null, null, firstDraft !== null, null,
      firstDraft === null
        ? (COURSE_DROP_ISSUES.length
          ? '.course-drop-issues summary'
          : COURSE_DROP_SHORTENED.length ? '.course-drop-shortened summary' : '.course-drop-notice')
        : null,
    );
  };

  folderButton.addEventListener('click', () => folderPicker.click());
  folderSend.addEventListener('click', () => { void sendFolder(); });
  if (COURSE_DROP_MEMORY) {
    folderSend.hidden = false;
    if (COURSE_DROP_MEMORY.interrupted) {
      folderSend.textContent = 'Finish folder import';
      folderStatus.textContent = interruptedCourseDropLine(
        COURSE_DROP_MEMORY.checkedThrough, COURSE_DROP_MEMORY.files.length,
      );
    } else {
      folderStatus.textContent = `${COURSE_DROP_MEMORY.files.length} ${COURSE_DROP_MEMORY.files.length === 1 ? 'file is' : 'files are'} ready to import.`;
    }
  }
  folderPicker.addEventListener('change', () => {
    const files = Array.from(folderPicker.files ?? []) as UploadFile[];
    folderPicker.value = '';
    if (!files.length) return;
    if (files.length > COURSE_DROP_LIMIT) {
      COURSE_DROP_MEMORY = null;
      folderSend.hidden = true;
      folderStatus.textContent = `That folder has ${files.length} files. Choose a folder with ${COURSE_DROP_LIMIT} or fewer.`;
      folderButton.focus();
      return;
    }
    COURSE_DROP_ISSUES = [];
    COURSE_DROP_SHORTENED = [];
    const firstPath = files[0]?.webkitRelativePath?.split('/').filter(Boolean) ?? [];
    COURSE_DROP_MEMORY = {
      title: firstPath.length > 1 ? firstPath[0]! : 'Course folder',
      dropId: `drop-${newClientRef()}`,
      files,
      checkedThrough: 0,
      interrupted: false,
    };
    folderStatus.textContent = `${files.length} ${files.length === 1 ? 'file is' : 'files are'} selected. Reading and adding them now…`;
    void sendFolder();
  });
  button.addEventListener('click', async () => {
    if (!text.value.trim()) { note.textContent = 'Paste the source first.'; return; }
    if (refuseAuthoredOverflow(title.value, STUDY_TEXT_LIMITS.sourceTitle,
      'source name', note, title)) return;
    if (refuseAuthoredOverflow(text.value, STUDY_TEXT_LIMITS.sourceText,
      'source', note, text, false)) return;
    button.disabled = true;
    note.textContent = 'Reading the structure, dates, and source lines…';
    const made = await apiResult<{ draft: { id: string } }>('/course-intakes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: kind.value, title: title.value, text: text.value, enhance: false }),
    });
    if (await reopenSignInForExpiredIdentity(made, () => renderCourses(null, true))) return;
    if (made.kind !== 'ok') {
      note.textContent = 'That source could not be reviewed. Nothing was added.';
      button.disabled = false;
      button.focus();
      return;
    }
    INTAKE_MEMORY = null;
    void renderCourses(made.body.draft.id, false, null, null, true);
  });
  return form;
}

function intakeDraftBlock(
  draft: IntakeDraftView, focus: string | null = null,
): HTMLElement {
  const isRejected = (kind: 'objective' | 'material' | 'commitment', id: string): boolean =>
    (draft.rejected ?? []).some((entry) => entry.kind === kind && entry.id === id);
  const unresolved = draft.questions.filter((q) => {
    if (!q.blocking || q.resolvedAt) return false;
    const commitment = /^commitments\.(\d+)\./.exec(q.field);
    if (!commitment) return true;
    const proposed = draft.commitments[Number(commitment[1])];
    return proposed ? !isRejected('commitment', proposed.id) : true;
  });
  const node = el(`<section class="intake-review" data-draft="${esc(draft.id)}">
    <div class="review-head"><div><div class="eyebrow">Review before import</div><h2></h2></div><span class="source-kind"></span></div>
    <div class="course-detail-fields"><div class="review-field"><label><span>Course title</span><input class="name" aria-label="Course title"><span class="meta input-limit">Course titles: up to 160 characters.</span></label><button class="link" data-title>Save title</button></div><div class="review-field"><label><span>Provider</span><input class="provider" aria-label="Provider"><span class="meta input-limit">Providers: up to 120 characters.</span></label><button class="link" data-provider>Save provider</button></div><p class="detail-note" role="status" aria-live="polite"></p></div>
    <div class="questions"></div>
    <div class="intake-grid"><div class="objectives"><h3>Objectives</h3></div><div class="material"><h3>Course material</h3></div><div class="obligations"><h3>Upcoming work</h3></div></div>
    <details class="rejected-proposals"><summary></summary><div class="rejected-proposal-rows"></div></details>
    <details class="source-receipt"><summary>Source receipt</summary><pre></pre><p class="digest"></p></details>
    <div class="warnings"></div>
    <div class="enrichment-row"><button class="link" data-enhance></button><span class="enrichment-note" role="status" aria-live="polite"></span></div>
    <div class="row"><button class="primary" data-apply></button><span class="apply-note" role="status" aria-live="polite"></span></div>
  </section>`);
  markIfNamed(node, draft.id, focus);
  (node.querySelector('.review-head h2') as HTMLElement).textContent = draft.title;
  (node.querySelector('.source-kind') as HTMLElement).textContent = draft.source.kind.replace(/-/g, ' ');
  const title = node.querySelector('.course-detail-fields .name') as HTMLInputElement;
  const provider = node.querySelector('.course-detail-fields .provider') as HTMLInputElement;
  const detailNote = node.querySelector('.detail-note') as HTMLElement;
  const redrawAt = (selector: string): void => {
    void renderCourses(draft.id, false, null, { draftId: draft.id, selector });
  };
  const reviewWrite = async <T>(
    button: HTMLButtonElement, status: HTMLElement, path: string, init: RequestInit,
    pending: string, failed: string, resumeSelector: string,
  ): Promise<{ readonly kind: 'ok'; readonly body: T } | null> => {
    button.disabled = true;
    status.textContent = pending;
    const saved = await apiResult<T>(path, init);
    if (await reopenSignInForExpiredIdentity(
      saved, () => renderCourses(draft.id, false, null, { draftId: draft.id, selector: resumeSelector }),
    )) return null;
    if (saved.kind !== 'ok') {
      status.textContent = failed;
      button.disabled = false;
      button.focus();
      return null;
    }
    return saved;
  };

  title.value = intakeReviewValue(draft.id, 'title', draft.title);
  provider.value = intakeReviewValue(draft.id, 'provider', draft.provider);
  title.addEventListener('input', () => rememberIntakeReviewValue(draft.id, 'title', title.value));
  provider.addEventListener('input', () => rememberIntakeReviewValue(draft.id, 'provider', provider.value));
  const titleButton = node.querySelector('[data-title]') as HTMLButtonElement;
  titleButton.addEventListener('click', async () => {
    if (refuseAuthoredOverflow(title.value, STUDY_TEXT_LIMITS.title,
      'course title', detailNote, title)) return;
    const saved = await reviewWrite<unknown>(titleButton, detailNote,
      `/course-intakes/${encodeURIComponent(draft.id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ field: 'title', value: title.value }),
      }, 'Saving the title…', 'That title did not save. Your edit is still here.', '[data-title]');
    if (saved) redrawAt('[data-title]');
  });
  const providerButton = node.querySelector('[data-provider]') as HTMLButtonElement;
  providerButton.addEventListener('click', async () => {
    if (refuseAuthoredOverflow(provider.value, STUDY_TEXT_LIMITS.provider,
      'provider', detailNote, provider)) return;
    const saved = await reviewWrite<unknown>(providerButton, detailNote,
      `/course-intakes/${encodeURIComponent(draft.id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ field: 'provider', value: provider.value }),
      }, 'Saving the provider…', 'That provider did not save. Your edit is still here.', '[data-provider]');
    if (saved) redrawAt('[data-provider]');
  });

  const setProposalRejected = async (
    kind: 'objective' | 'material' | 'commitment', id: string, index: number,
    rejected: boolean, button: HTMLButtonElement, status: HTMLElement,
  ): Promise<void> => {
    const mainClass = kind === 'objective' ? 'objective-proposal'
      : kind === 'material' ? 'material-proposal' : 'commitment-proposal';
    const mainIndex = kind === 'objective' ? 'data-objective'
      : kind === 'material' ? 'data-material-index' : 'data-commitment-index';
    const destination = rejected
      ? `.rejected-proposal[data-rejected-kind="${kind}"][data-rejected-index="${index}"] [data-restore]`
      : `.${mainClass}[${mainIndex}="${index}"] [data-reject]`;
    const saved = await reviewWrite<unknown>(button, status,
      `/course-intakes/${encodeURIComponent(draft.id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ field: `rejected.${kind}.${id}`, value: String(rejected) }),
      }, rejected ? 'Leaving this out…' : 'Restoring this proposal…',
      rejected
        ? 'That did not go through. This proposal is still in the import.'
        : 'That did not go through. This proposal is still left out.', destination);
    if (saved) redrawAt(destination);
  };

  const questions = node.querySelector('.questions') as HTMLElement;
  for (const question of unresolved) {
    const row = el(`<div class="intake-question"><label></label><div><input type="date"><button>Use this date</button></div><p class="note" role="status" aria-live="polite"></p></div>`);
    const label = row.querySelector('label') as HTMLLabelElement;
    label.textContent = question.prompt;
    const value = row.querySelector('input') as HTMLInputElement;
    const inputId = `intake-question-${question.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    value.setAttribute('id', inputId);
    label.setAttribute('for', inputId);
    const questionKey = `question.${question.id}`;
    value.value = intakeReviewValue(draft.id, questionKey, '');
    value.addEventListener('input', () => rememberIntakeReviewValue(draft.id, questionKey, value.value));
    const note = row.querySelector('.note') as HTMLElement;
    const questionButton = row.querySelector('button') as HTMLButtonElement;
    questionButton.setAttribute('data-question-save', inputId);
    questionButton.addEventListener('click', async () => {
      if (!value.value) { note.textContent = 'Choose the date you mean.'; return; }
      const selector = `[data-question-save="${inputId}"]`;
      const saved = await reviewWrite<unknown>(questionButton, note,
        `/course-intakes/${encodeURIComponent(draft.id)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ field: question.field, value: value.value }),
        }, 'Saving the date…', 'That date did not save. Your answer is still here.', selector);
      if (saved) redrawAt(selector);
    });
    questions.append(row);
  }

  const objectives = node.querySelector('.objectives') as HTMLElement;
  if (!draft.objectives.length) objectives.append(el(`<p class="bare">None found explicitly.</p>`));
  for (const [index, objective] of draft.objectives.entries()) {
    if (isRejected('objective', objective.id)) continue;
    const item = el(`<div class="extracted objective-proposal" data-objective="${index}"><span class="fact"></span><q></q><details class="proposal-correction"><summary>Correct</summary><label><span>Objective</span><input class="correct-objective"><span class="meta input-limit">Objectives: up to 300 characters.</span></label><button class="link" data-save-objective>Save objective</button><p class="note" role="status" aria-live="polite"></p></details><div class="proposal-actions"><button class="link" data-reject>Leave this out</button><span class="proposal-note" role="status" aria-live="polite"></span></div></div>`);
    (item.querySelector('.fact') as HTMLElement).textContent = objective.text;
    (item.querySelector('q') as HTMLElement).textContent = objective.source?.quote ?? '';
    const correction = item.querySelector('.correct-objective') as HTMLInputElement;
    const correctionNote = item.querySelector('.proposal-correction [role=status]') as HTMLElement;
    const objectiveKey = `objective.${index}`;
    correction.value = intakeReviewValue(draft.id, objectiveKey, objective.text);
    correction.addEventListener('input', () => rememberIntakeReviewValue(draft.id, objectiveKey, correction.value));
    const objectiveButton = item.querySelector('[data-save-objective]') as HTMLButtonElement;
    objectiveButton.addEventListener('click', async () => {
      if (!correction.value.trim()) { correctionNote.textContent = 'An objective needs some text.'; return; }
      if (refuseAuthoredOverflow(correction.value, STUDY_TEXT_LIMITS.objective,
        'objective', correctionNote, correction)) return;
      const selector = `.objective-proposal[data-objective="${index}"] [data-save-objective]`;
      const saved = await reviewWrite<unknown>(objectiveButton, correctionNote,
        `/course-intakes/${encodeURIComponent(draft.id)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ field: `objectives.${index}.text`, value: correction.value }),
        }, 'Saving the objective…', 'That objective did not save. Your edit is still here.', selector);
      if (saved) redrawAt(selector);
    });
    const reject = item.querySelector('[data-reject]') as HTMLButtonElement;
    reject.setAttribute('aria-label', `Leave objective out: ${objective.text}`);
    reject.addEventListener('click', () => void setProposalRejected(
      'objective', objective.id, index, true, reject,
      item.querySelector('.proposal-note') as HTMLElement,
    ));
    objectives.append(item);
  }
  const material = node.querySelector('.material') as HTMLElement;
  if (!draft.material.length) material.append(el(`<p class="bare">None found explicitly.</p>`));
  for (const [index, sourceMaterial] of draft.material.entries()) {
    if (isRejected('material', sourceMaterial.id)) continue;
    const item = el(`<div class="extracted material-proposal" data-material-index="${index}"><span class="fact"></span><span class="material-meta"></span><span class="material-url-host"></span><q></q><details class="proposal-correction"><summary>Correct</summary><label><span>Title</span><input class="correct-material-title"><span class="meta input-limit">Material titles: up to 180 characters.</span></label><button class="link" data-save-material-title>Save title</button><label><span>Link</span><input class="correct-material-url" type="url"></label><button class="link" data-save-material-url>Save link</button><label><span>Kind</span><select class="correct-material-kind"><option value="video">Video</option><option value="reading">Reading</option><option value="class">Class</option><option value="exercise">Exercise</option><option value="other">Other</option></select></label><button class="link" data-save-material-kind>Save kind</button><label><span>Minutes <em>(optional)</em></span><input class="correct-material-minutes" type="number" min="1" max="600"></label><button class="link" data-save-material-minutes>Save minutes</button><p class="note" role="status" aria-live="polite"></p></details><div class="proposal-actions"><button class="link" data-reject>Leave this out</button><span class="proposal-note" role="status" aria-live="polite"></span></div></div>`);
    (item.querySelector('.fact') as HTMLElement).textContent = sourceMaterial.title;
    (item.querySelector('.material-meta') as HTMLElement).textContent = [
      sourceMaterial.kind.replace(/-/g, ' '),
      sourceMaterial.minutes === null ? null : `${sourceMaterial.minutes} min`,
    ].filter(Boolean).join(' · ');
    const materialHref = safeHref(sourceMaterial.url);
    if (materialHref) {
      const materialUrl = el(`<a class="material-url" target="_blank" rel="noreferrer"></a>`);
      materialUrl.setAttribute('href', materialHref);
      materialUrl.textContent = materialHref;
      (item.querySelector('.material-url-host') as HTMLElement).append(materialUrl);
    }
    (item.querySelector('q') as HTMLElement).textContent = sourceMaterial.source.quote;
    const titleCorrection = item.querySelector('.correct-material-title') as HTMLInputElement;
    const urlCorrection = item.querySelector('.correct-material-url') as HTMLInputElement;
    const kindCorrection = item.querySelector('.correct-material-kind') as HTMLSelectElement;
    const minutesCorrection = item.querySelector('.correct-material-minutes') as HTMLInputElement;
    const correctionNote = item.querySelector('.proposal-correction .note') as HTMLElement;
    const materialTitleKey = `material.${index}.title`;
    const materialUrlKey = `material.${index}.url`;
    const materialKindKey = `material.${index}.kind`;
    const materialMinutesKey = `material.${index}.minutes`;
    titleCorrection.value = intakeReviewValue(draft.id, materialTitleKey, sourceMaterial.title);
    urlCorrection.value = intakeReviewValue(draft.id, materialUrlKey, sourceMaterial.url);
    kindCorrection.value = intakeReviewValue(draft.id, materialKindKey, sourceMaterial.kind);
    minutesCorrection.value = intakeReviewValue(draft.id, materialMinutesKey,
      sourceMaterial.minutes === null ? '' : String(sourceMaterial.minutes));
    titleCorrection.addEventListener('input', () => rememberIntakeReviewValue(draft.id, materialTitleKey, titleCorrection.value));
    urlCorrection.addEventListener('input', () => rememberIntakeReviewValue(draft.id, materialUrlKey, urlCorrection.value));
    kindCorrection.addEventListener('change', () => rememberIntakeReviewValue(draft.id, materialKindKey, kindCorrection.value));
    minutesCorrection.addEventListener('input', () => rememberIntakeReviewValue(draft.id, materialMinutesKey, minutesCorrection.value));
    const saveMaterialField = async (
      field: 'title' | 'url' | 'kind' | 'minutes', value: string, button: HTMLButtonElement,
    ): Promise<void> => {
      if (field === 'title' && refuseAuthoredOverflow(value, STUDY_TEXT_LIMITS.materialTitle,
        'material title', correctionNote, titleCorrection)) return;
      const selector = `.material-proposal[data-material-index="${index}"] [data-save-material-${field}]`;
      const saved = await reviewWrite<unknown>(button, correctionNote,
        `/course-intakes/${encodeURIComponent(draft.id)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ field: `material.${index}.${field}`, value }),
        }, `Saving the ${field}…`, `That ${field} did not save. Your edit is still here.`, selector);
      if (saved) redrawAt(selector);
    };
    const materialTitleButton = item.querySelector('[data-save-material-title]') as HTMLButtonElement;
    const materialUrlButton = item.querySelector('[data-save-material-url]') as HTMLButtonElement;
    const materialKindButton = item.querySelector('[data-save-material-kind]') as HTMLButtonElement;
    const materialMinutesButton = item.querySelector('[data-save-material-minutes]') as HTMLButtonElement;
    materialTitleButton.addEventListener('click', () => {
      void saveMaterialField('title', titleCorrection.value, materialTitleButton);
    });
    materialUrlButton.addEventListener('click', () => {
      void saveMaterialField('url', urlCorrection.value, materialUrlButton);
    });
    materialKindButton.addEventListener('click', () => {
      void saveMaterialField('kind', kindCorrection.value, materialKindButton);
    });
    materialMinutesButton.addEventListener('click', () => {
      void saveMaterialField('minutes', minutesCorrection.value, materialMinutesButton);
    });
    const reject = item.querySelector('[data-reject]') as HTMLButtonElement;
    reject.setAttribute('aria-label', `Leave material out: ${sourceMaterial.title}`);
    reject.addEventListener('click', () => void setProposalRejected(
      'material', sourceMaterial.id, index, true, reject,
      item.querySelector('.proposal-note') as HTMLElement,
    ));
    material.append(item);
  }
  const obligations = node.querySelector('.obligations') as HTMLElement;
  if (!draft.commitments.length) obligations.append(el(`<p class="bare">None found explicitly.</p>`));
  for (const [index, commitment] of draft.commitments.entries()) {
    if (isRejected('commitment', commitment.id)) continue;
    const item = el(`<div class="extracted commitment-proposal" data-commitment-index="${index}"><span class="fact"></span><span class="date"></span><q></q><details class="proposal-correction"><summary>Correct</summary><label><span>Assignment</span><input class="correct-commitment-title"><span class="meta input-limit">Assignment titles: up to 180 characters.</span></label><button class="link" data-save-commitment-title>Save assignment</button><label><span>Due date</span><input class="correct-commitment-date" type="date"></label><button class="link" data-save-commitment-date>Save due date</button><label><span>Due time <em>(optional)</em></span><input class="correct-commitment-time" type="time"></label><button class="link" data-save-commitment-time>Save due time</button><p class="deadline-zone"></p><p class="note" role="status" aria-live="polite"></p></details><div class="proposal-actions"><button class="link" data-reject>Leave this out</button><span class="proposal-note" role="status" aria-live="polite"></span></div></div>`);
    (item.querySelector('.fact') as HTMLElement).textContent = commitment.title;
    const dueDay = commitment.dueAt ? commitmentDueDay({
      dueAt: commitment.dueAt,
      ...(commitment.dueTime ? { dueTime: commitment.dueTime } : {}),
      ...(commitment.dueTimeZone ? { dueTimeZone: commitment.dueTimeZone } : {}),
    }) : '';
    (item.querySelector('.date') as HTMLElement).textContent = dueDay
      ? `${dueDay}${commitment.dueTime && commitment.dueTimeZone
        ? ` at ${commitment.dueTime} ${commitment.dueTimeZone}` : ''}`
      : 'Date needs confirmation';
    (item.querySelector('q') as HTMLElement).textContent = commitment.source.quote;
    const titleCorrection = item.querySelector('.correct-commitment-title') as HTMLInputElement;
    const dateCorrection = item.querySelector('.correct-commitment-date') as HTMLInputElement;
    const timeCorrection = item.querySelector('.correct-commitment-time') as HTMLInputElement;
    const correctionNote = item.querySelector('.proposal-correction [role=status]') as HTMLElement;
    const commitmentTitleKey = `commitment.${index}.title`;
    const commitmentDateKey = `commitment.${index}.dueAt`;
    const commitmentTimeKey = `commitment.${index}.dueTime`;
    titleCorrection.value = intakeReviewValue(draft.id, commitmentTitleKey, commitment.title);
    dateCorrection.value = intakeReviewValue(draft.id, commitmentDateKey, dueDay);
    timeCorrection.value = intakeReviewValue(draft.id, commitmentTimeKey, commitment.dueTime ?? '');
    (item.querySelector('.deadline-zone') as HTMLElement).textContent =
      `A changed time uses ${localZone() || "your board's timezone"}. Leave it empty for a date-only deadline.`;
    titleCorrection.addEventListener('input', () => rememberIntakeReviewValue(draft.id, commitmentTitleKey, titleCorrection.value));
    dateCorrection.addEventListener('input', () => rememberIntakeReviewValue(draft.id, commitmentDateKey, dateCorrection.value));
    timeCorrection.addEventListener('input', () => rememberIntakeReviewValue(draft.id, commitmentTimeKey, timeCorrection.value));
    const saveCommitmentField = async (
      field: 'title' | 'dueAt' | 'dueTime', value: string, button: HTMLButtonElement,
    ): Promise<void> => {
      const label = field === 'title' ? 'assignment' : field === 'dueAt' ? 'due date' : 'due time';
      if (field !== 'dueTime' && !value.trim()) { correctionNote.textContent = `Choose a ${label}.`; return; }
      if (field === 'title' && refuseAuthoredOverflow(value, STUDY_TEXT_LIMITS.commitmentTitle,
        'assignment title', correctionNote, titleCorrection)) return;
      const data = field === 'title' ? 'data-save-commitment-title'
        : field === 'dueAt' ? 'data-save-commitment-date' : 'data-save-commitment-time';
      const selector = `.commitment-proposal[data-commitment-index="${index}"] [${data}]`;
      const saved = await reviewWrite<unknown>(button, correctionNote,
        `/course-intakes/${encodeURIComponent(draft.id)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ field: `commitments.${index}.${field}`, value }),
        }, `Saving the ${label}…`, `That ${label} did not save. Your edit is still here.`, selector);
      if (saved) redrawAt(selector);
    };
    const commitmentTitleButton = item.querySelector('[data-save-commitment-title]') as HTMLButtonElement;
    const commitmentDateButton = item.querySelector('[data-save-commitment-date]') as HTMLButtonElement;
    const commitmentTimeButton = item.querySelector('[data-save-commitment-time]') as HTMLButtonElement;
    commitmentTitleButton.addEventListener('click', () => {
      void saveCommitmentField('title', titleCorrection.value, commitmentTitleButton);
    });
    commitmentDateButton.addEventListener('click', () => {
      void saveCommitmentField('dueAt', dateCorrection.value, commitmentDateButton);
    });
    commitmentTimeButton.addEventListener('click', () => {
      void saveCommitmentField('dueTime', timeCorrection.value, commitmentTimeButton);
    });
    const reject = item.querySelector('[data-reject]') as HTMLButtonElement;
    reject.setAttribute('aria-label', `Leave upcoming work out: ${commitment.title}`);
    reject.addEventListener('click', () => void setProposalRejected(
      'commitment', commitment.id, index, true, reject,
      item.querySelector('.proposal-note') as HTMLElement,
    ));
    obligations.append(item);
  }

  const rejectedRows = node.querySelector('.rejected-proposal-rows') as HTMLElement;
  const rejectedDetails = node.querySelector('.rejected-proposals') as HTMLDetailsElement;
  const rejectedItems: {
    kind: 'objective' | 'material' | 'commitment'; id: string; index: number; label: string;
  }[] = [
    ...draft.objectives.map((item, index) => ({ kind: 'objective' as const, id: item.id, index, label: item.text })),
    ...draft.material.map((item, index) => ({ kind: 'material' as const, id: item.id, index, label: item.title })),
    ...draft.commitments.map((item, index) => ({ kind: 'commitment' as const, id: item.id, index, label: item.title })),
  ].filter((item) => isRejected(item.kind, item.id));
  if (!rejectedItems.length) rejectedDetails.remove();
  else {
    (rejectedDetails.querySelector('summary') as HTMLElement).textContent = `Not importing (${rejectedItems.length})`;
    for (const item of rejectedItems) {
      const row = el(`<div class="rejected-proposal"><span class="fact"></span><button class="link" data-restore>Restore</button><span class="proposal-note" role="status" aria-live="polite"></span></div>`);
      row.setAttribute('data-rejected-kind', item.kind);
      row.setAttribute('data-rejected-index', String(item.index));
      (row.querySelector('.fact') as HTMLElement).textContent = item.label;
      const restore = row.querySelector('[data-restore]') as HTMLButtonElement;
      restore.setAttribute('aria-label', `Restore ${item.kind}: ${item.label}`);
      restore.addEventListener('click', () => void setProposalRejected(
        item.kind, item.id, item.index, false, restore,
        row.querySelector('.proposal-note') as HTMLElement,
      ));
      rejectedRows.append(row);
    }
  }
  (node.querySelector('.source-receipt pre') as HTMLElement).textContent = draft.source.text;
  (node.querySelector('.digest') as HTMLElement).textContent = draft.source.digest;
  const warnings = node.querySelector('.warnings') as HTMLElement;
  for (const warning of draft.warnings) {
    const line = el(`<p class="note"></p>`); line.textContent = warning; warnings.append(line);
  }
  const enhance = node.querySelector('[data-enhance]') as HTMLButtonElement;
  const enrichmentNote = node.querySelector('.enrichment-note') as HTMLElement;
  enhance.textContent = draft.enrichment ? 'Run the deeper pass again' : 'Ask Virgil for a deeper pass';
  if (draft.enrichment?.outcome === 'enriched') {
    const a = draft.enrichment.added;
    enrichmentNote.textContent = `Deep pass added ${a.objectives} objective(s), ${a.commitments} obligation(s), and ${a.questions} question(s).`;
  } else if (draft.enrichment?.outcome === 'nothing-added') {
    enrichmentNote.textContent = 'Deep pass found nothing sound to add. The local review stands.';
  } else if (draft.enrichment?.outcome === 'model-failed') {
    enrichmentNote.textContent = 'Deep pass was unavailable. The local review is still safe to use.';
  } else {
    enrichmentNote.textContent = 'Optional. The reviewed local extraction is already usable.';
  }
  enhance.addEventListener('click', async () => {
    const saved = await reviewWrite<unknown>(enhance, enrichmentNote,
      `/course-intakes/${encodeURIComponent(draft.id)}/enhance`, { method: 'POST' },
      'Looking for structure the local pass may have missed…',
      'Deep pass did not answer. The local review and your edits are unchanged.', '[data-enhance]');
    if (saved) redrawAt('[data-enhance]');
  });
  const apply = node.querySelector('[data-apply]') as HTMLButtonElement;
  const applyNote = node.querySelector('.apply-note') as HTMLElement;
  apply.textContent = unresolved.length ? 'Answer the questions first' : 'Confirm and add to Virgil';
  apply.disabled = unresolved.length > 0;
  apply.addEventListener('click', async () => {
    const saved = await reviewWrite<{ course: { id: string } }>(apply, applyNote,
      `/course-intakes/${encodeURIComponent(draft.id)}/apply`, { method: 'POST' },
      'Adding the reviewed facts…',
      'That did not go through. The reviewed draft is still here and nothing new was added.', '[data-apply]');
    if (!saved) return;
    INTAKE_REVIEW_DRAFTS.delete(draft.id);
    void renderCourses(saved.body.course.id, false, null, null, true);
  });
  return node;
}

/**
 * One course, and everything the product knows about it.
 *
 * The order is the order somebody looks: what it is, where it stands, what is
 * next, what is in it, what is coming, how it has gone, and what it has grown
 * on the board. The two things a course is *described* by rather than *worked
 * from* — its objectives and the sources they were read out of — are folded
 * away, because they are read once and then never again, and a card that opens
 * with a syllabus is a syllabus.
 */
function courseBlock(
  c: CourseView,
  courses: readonly CourseView[],
  /** The room's results, or `null` when the read that would have carried them
   *  did not answer. See `renderCourses`: absence and unreadability are two
   *  different facts about somebody's grades, and this card draws both. */
  outcomes: readonly OutcomeView[] | null,
  outcomeContext: OutcomeContextView | null,
  after: (courseId: string, materialId?: string, materialLink?: boolean) => void,
  focus: string | null = null,
  returnToLearnMaterial: string | null = null,
): HTMLElement {
  const node = el(`<section class="course" data-course="${esc(c.id)}">
    <div class="head"><div class="course-name"><h2></h2><span class="provider"></span></div><span class="meta"></span><button class="link course-options">Course options</button></div>
    <div class="course-maintenance"></div>
    <div class="course-next"></div>
    <div class="rows"></div>
    <div class="extras"></div>
    <div class="add"></div>
  </section>`);
  markIfNamed(node, c.id, focus);
  (node.querySelector('h2') as HTMLElement).textContent = c.title;
  (node.querySelector('.provider') as HTMLElement).textContent = c.provider || '';
  const options = node.querySelector('.course-options') as HTMLButtonElement;
  options.setAttribute('aria-label', `Course options for ${c.title}`);
  options.addEventListener('click', () => {
    const host = node.querySelector('.course-maintenance') as HTMLElement;
    if (host.firstElementChild) { host.replaceChildren(); options.focus(); return; }
    host.append(courseMaintenance(c, after));
    (host.querySelector('button') as HTMLElement | null)?.focus();
  });
  const progress: string[] = [];
  if (c.progress.materialCount) {
    progress.push(`${c.progress.covered} of ${c.progress.materialCount} covered`);
  }
  if (c.progress.topicCount) {
    progress.push(`${c.progress.learnt} of ${c.progress.topicCount} learnt`);
  }
  (node.querySelector('.meta') as HTMLElement).textContent = progress.join(' · ');

  // The one thing to do next, named. Said only when there is one: a finished
  // course that still carried this line would be inventing work for somebody
  // who has none left.
  const next = c.material.find((m) => !m.doneAt) ?? null;
  const nextHost = node.querySelector('.course-next') as HTMLElement;
  if (next) {
    nextHost.append(courseNextMove(next, () => {
      const row = Array.from(node.querySelectorAll('.material')).find(
        (candidate) => candidate.getAttribute('data-material') === next.id,
      );
      (row?.querySelector('[data-edit-link]') as HTMLElement | null)?.click();
    }));
  }
  const rows = node.querySelector('.rows') as HTMLElement;
  // Grouped by what the thing IS. The kind was already on every row as
  // `data-kind` and was already on the wire; it simply never laid anything out,
  // so fourteen rows of video, reading and class read as one undifferentiated
  // list of links.
  for (const group of groupMaterial(c.material)) {
    const block = el(`<div class="material-group" data-kind="${esc(group.kind)}"><h3></h3></div>`);
    (block.querySelector('h3') as HTMLElement).textContent = group.label;
    for (const m of group.items) block.append(courseMaterialRow(c.id, m, courses, {
      write: apiResult,
      isNext: m.id === next?.id,
      recoverIdentity: (result, resume) => reopenSignInForExpiredIdentity(result, resume),
      redraw: (courseId, materialId, materialLink) => void renderCourses(
        courseId, false, materialId ?? null, null, !materialId, null, null, materialLink ?? false,
      ),
      ...(returnToLearnMaterial === m.id
        ? { afterLinkSave: () => void renderHome(null, null, 'learn', '', true) }
        : {}),
    }));
    rows.append(block);
  }

  const extras = node.querySelector('.extras') as HTMLElement;
  const coming = c.commitments ?? [];
  if (coming.length) {
    const zone = el(`<section class="coming-up"><h3>Coming up</h3><div class="rows"></div></section>`);
    const list = zone.querySelector('.rows') as HTMLElement;
    for (const k of coming) list.append(commitmentGlance(k));
    extras.append(zone);
  }

  // Drawn when there are results, and drawn when nobody knows whether there
  // are. A course card that quietly has no Results heading is this product
  // saying nothing was ever recorded against this course, which is a claim it
  // cannot make off a read that failed.
  const mine = outcomes === null ? null : outcomes.filter((o) => o.courseId === c.id);
  if (mine === null || mine.length) {
    const zone = el(`<section class="results"><h3>Results</h3><div class="rows"></div></section>`);
    const list = zone.querySelector('.rows') as HTMLElement;
    if (mine === null) list.append(el(`<p class="empty">${esc(resultsUnreadableLine())}</p>`));
    else for (const o of mine) list.append(outcomeRow(o, outcomeContext));
    extras.append(zone);
  }

  const topics = c.topics ?? [];
  if (topics.length) {
    const zone = el(`<section class="on-board"><h3>On your board</h3><div class="chips"></div></section>`);
    const chips = zone.querySelector('.chips') as HTMLElement;
    for (const t of topics) chips.append(topicChip(t));
    extras.append(zone);
  }

  const objectives = c.objectives ?? [];
  const sources = c.sources ?? [];
  if (objectives.length || sources.length) {
    const detail = el(`<details class="course-detail"><summary>Objectives and sources</summary></details>`);
    if (objectives.length) {
      const list = el(`<div class="course-objectives"><strong>What this course expects</strong><ul></ul></div>`);
      const items = list.querySelector('ul') as HTMLElement;
      for (const objective of objectives) {
        const item = el(`<li></li>`); item.textContent = objective.text; items.append(item);
      }
      detail.append(list);
    }
    for (const source of sources) {
      const receipt = el(`<div class="course-source">
        <div class="source-head"><span class="what"></span><span class="kind"></span></div>
        <div class="source-disclosures"></div>
      </div>`);
      (receipt.querySelector('.what') as HTMLElement).textContent = source.title;
      (receipt.querySelector('.kind') as HTMLElement).textContent = source.kind.replace(/-/g, ' ');
      const disclosures = receipt.querySelector('.source-disclosures') as HTMLElement;
      const href = safeHref(source.url);
      const captured = source.capturedAt && Number.isFinite(Date.parse(source.capturedAt))
        ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })
          .format(new Date(source.capturedAt))
        : '';
      if (source.text || href || captured) {
        const copy = el(`<details class="source-copy"><summary>View exact source</summary>
          <p class="meta source-captured"></p><pre class="source-text"></pre>
        </details>`);
        (copy.querySelector('.source-captured') as HTMLElement).textContent = captured
          ? `Saved ${captured}` : '';
        (copy.querySelector('.source-text') as HTMLElement).textContent = source.text ?? '';
        if (href) {
          const link = el(`<a class="source-url" target="_blank" rel="noreferrer">Open original page</a>`) as HTMLAnchorElement;
          link.setAttribute('href', href);
          copy.append(link);
        }
        disclosures.append(copy);
      }
      const technical = el(`<details class="technical-receipt"><summary>Technical receipt</summary><code class="digest"></code></details>`);
      (technical.querySelector('.digest') as HTMLElement).textContent = source.digest;
      disclosures.append(technical);
      detail.append(receipt);
    }
    extras.append(detail);
  }

  const add = node.querySelector('.add') as HTMLElement;
  const open = el(`<button class="link">Add material</button>`) as HTMLButtonElement;
  open.setAttribute('aria-label', `Add material to ${c.title}`);
  open.addEventListener('click', () => {
    open.remove();
    add.append(materialForm(
      c.id,
      () => after(c.id),
      undefined,
      () => { add.replaceChildren(open); open.focus(); },
      c.title,
    ));
  });
  add.append(open);
  return node;
}

function courseMaintenance(
  course: CourseView,
  after: (courseId: string, materialId?: string) => void,
): HTMLElement {
  const host = el(`<div class="repair-choice course-maintenance-menu">
    <p class="bare">Repair the course record or put it away. Material, results and Board learning are separate records.</p>
    <div class="row"><button class="link edit">Edit course</button><button class="link archive">Archive course</button></div>
  </div>`);
  const edit = host.querySelector('.edit') as HTMLButtonElement;
  const archive = host.querySelector('.archive') as HTMLButtonElement;

  edit.addEventListener('click', () => {
    const form = el(`<div class="repair-choice course-edit">
      <label class="field"><span>Course name</span><input class="name title"><span class="meta input-limit">Up to 160 characters. I save the whole course name.</span></label>
      <label class="field"><span>Provider <em>(optional)</em></span><input class="name provider"><span class="meta input-limit">Up to 120 characters. I save the whole provider name.</span></label>
      <label class="field"><span>Course page <em>(optional)</em></span><input class="name url" type="url"></label>
      <p class="status" role="status" aria-live="polite"></p>
      <div class="row"><button class="primary save">Save course</button><button class="link cancel">Cancel</button></div>
    </div>`);
    (form.querySelector('.title') as HTMLInputElement).value = course.title;
    (form.querySelector('.provider') as HTMLInputElement).value = course.provider || '';
    (form.querySelector('.url') as HTMLInputElement).value = course.url || '';
    host.replaceChildren(form);
    const title = form.querySelector('.title') as HTMLInputElement;
    const provider = form.querySelector('.provider') as HTMLInputElement;
    const save = form.querySelector('.save') as HTMLButtonElement;
    const status = form.querySelector('.status') as HTMLElement;
    (form.querySelector('.cancel') as HTMLButtonElement).addEventListener('click', () => {
      host.replaceChildren(courseMaintenance(course, after));
      (host.querySelector('.edit') as HTMLElement | null)?.focus();
    });
    save.addEventListener('click', async () => {
      if (!title.value.trim()) { status.textContent = 'Give the course a name first.'; title.focus(); return; }
      if (refuseAuthoredOverflow(title.value, STUDY_TEXT_LIMITS.title,
        'course name', status, title)) return;
      if (refuseAuthoredOverflow(provider.value, STUDY_TEXT_LIMITS.provider,
        'provider name', status, provider)) return;
      save.disabled = true;
      status.textContent = 'Saving the course…';
      const saved = await apiResult<{ course: CourseView }>(`/courses/${encodeURIComponent(course.id)}`, {
        method: 'PUT', body: JSON.stringify({
          title: title.value,
          provider: provider.value,
          url: (form.querySelector('.url') as HTMLInputElement).value,
        }),
      });
      if (await reopenSignInForExpiredIdentity(saved, () => renderCourses(course.id))) return;
      if (saved.kind !== 'ok') {
        status.textContent = 'That change did not go through. Your course is unchanged.';
        save.disabled = false; save.focus(); return;
      }
      void renderCourses(course.id, false, null, null, true);
    });
    title.focus();
  });

  archive.addEventListener('click', () => {
    const confirm = el(`<div class="repair-choice course-archive-confirm">
      <p class="bare">This puts the course under Archived. Plan work, results and Board learning stay where they are.</p>
      <p class="status" role="status" aria-live="polite"></p>
      <div class="row"><button class="primary confirm">Archive course</button><button class="link keep">Keep active</button></div>
    </div>`);
    host.replaceChildren(confirm);
    const action = confirm.querySelector('.confirm') as HTMLButtonElement;
    const status = confirm.querySelector('.status') as HTMLElement;
    (confirm.querySelector('.keep') as HTMLButtonElement).addEventListener('click', () => {
      host.replaceChildren(courseMaintenance(course, after));
      (host.querySelector('.archive') as HTMLElement | null)?.focus();
    });
    action.addEventListener('click', async () => {
      action.disabled = true; status.textContent = 'Archiving the course…';
      const saved = await apiResult<unknown>(`/courses/${encodeURIComponent(course.id)}`, {
        method: 'PUT', body: JSON.stringify({ archived: true }),
      });
      if (await reopenSignInForExpiredIdentity(saved, () => renderCourses(course.id))) return;
      if (saved.kind !== 'ok') {
        status.textContent = 'That did not go through. The course is still active.';
        action.disabled = false; action.focus(); return;
      }
      void renderCourses(course.id, false, null, null, true);
    });
    action.focus();
  });
  return host;
}

function archivedCourseBlock(
  course: CourseView,
  outcomes: readonly OutcomeView[] | null,
  outcomeContext: OutcomeContextView | null,
  after: (courseId?: string | null, materialId?: string | null) => void,
  focus: string | null,
): HTMLElement {
  const node = el(`<section class="archived-course" data-course="${esc(course.id)}">
    <div class="head"><h3></h3><span class="provider"></span></div>
    <p class="meta"></p><div class="archive-details"></div><div class="archive-actions row"></div>
  </section>`);
  markIfNamed(node, course.id, focus);
  (node.querySelector('h3') as HTMLElement).textContent = course.title;
  (node.querySelector('.provider') as HTMLElement).textContent = course.provider || '';
  (node.querySelector('.meta') as HTMLElement).textContent = course.material.length
    ? `${course.material.length} ${course.material.length === 1 ? 'piece' : 'pieces'} of material kept`
    : 'No material in this course';
  const details = node.querySelector('.archive-details') as HTMLElement;
  if (course.material.length) {
    const material = el(`<details><summary>Material</summary><ul></ul></details>`);
    const list = material.querySelector('ul') as HTMLElement;
    for (const row of course.material) { const item = el(`<li></li>`); item.textContent = row.title; list.append(item); }
    details.append(material);
  }
  const mine = outcomes === null ? null : outcomes.filter((outcome) => outcome.courseId === course.id);
  if (mine === null || mine.length) {
    const result = el(`<details><summary>Results</summary><div class="rows"></div></details>`);
    const rows = result.querySelector('.rows') as HTMLElement;
    if (mine === null) rows.append(el(`<p class="empty">${esc(resultsUnreadableLine())}</p>`));
    else for (const outcome of mine) rows.append(outcomeRow(outcome, outcomeContext));
    details.append(result);
  }
  const actions = node.querySelector('.archive-actions') as HTMLElement;
  const restore = el(`<button class="link">Restore</button>`) as HTMLButtonElement;
  const remove = el(`<button class="link danger-link">Delete permanently</button>`) as HTMLButtonElement;
  actions.append(restore, remove);
  const status = el(`<p class="status" role="status" aria-live="polite"></p>`);
  node.append(status);
  restore.addEventListener('click', async () => {
    restore.disabled = true; status.textContent = 'Restoring the course…';
    const saved = await apiResult<unknown>(`/courses/${encodeURIComponent(course.id)}`, {
      method: 'PUT', body: JSON.stringify({ archived: false }),
    });
    if (await reopenSignInForExpiredIdentity(saved, () => renderCourses(course.id))) return;
    if (saved.kind !== 'ok') {
      status.textContent = 'That did not go through. The course is still archived.';
      restore.disabled = false; restore.focus(); return;
    }
    void renderCourses(course.id, false, null, null, true);
  });
  remove.addEventListener('click', () => {
    const objectiveCount = course.objectives?.length ?? 0;
    const sourceCount = course.sources?.length ?? 0;
    const confirm = el(`<div class="repair-choice archive-delete-confirm">
      <p class="bare"></p>
      <p class="meta">Plan work, results and Board learning stay. They will appear under Not in a course.</p>
      <div class="row"><button class="danger confirm">Delete permanently</button><button class="link keep">Keep course</button></div>
    </div>`);
    (confirm.querySelector('.bare') as HTMLElement).textContent =
      `This permanently removes ${course.material.length} material, ${objectiveCount} objectives and ${sourceCount} source receipts from ${course.title}.`;
    actions.replaceChildren(confirm);
    const action = confirm.querySelector('.confirm') as HTMLButtonElement;
    (confirm.querySelector('.keep') as HTMLButtonElement).addEventListener('click', () => {
      actions.replaceChildren(restore, remove); remove.focus();
    });
    action.addEventListener('click', async () => {
      action.disabled = true; status.textContent = 'Deleting the archived course…';
      const saved = await apiResult<unknown>(`/courses/${encodeURIComponent(course.id)}`, { method: 'DELETE' });
      if (await reopenSignInForExpiredIdentity(saved, () => renderCourses(course.id))) return;
      if (saved.kind !== 'ok') {
        status.textContent = 'That did not go through. The archived course is unchanged.';
        action.disabled = false; action.focus(); return;
      }
      // The course no longer exists, so returning focus to its old control
      // would fall through to BODY. Land on the surviving history when there
      // is some, or the room's Add control when the deleted course was empty.
      void renderCourses(null, false, null, null, false, null, '.not-in-course');
    });
    action.focus();
  });
  return node;
}

/**
 * A deadline, seen from the room where the work is.
 *
 * Deliberately not `commitmentRow`: that row carries the tick, and the tick is
 * the only scoring event in the product. Closing something is a decision made
 * in the Plan, where the whole plan is visible; here it would be a control that
 * scores points from a screen that cannot show what else is due. So this is a
 * glance and a way through — the title, when it is due, and a press that opens
 * the Plan.
 */
function commitmentGlance(c: CommitmentView): HTMLElement {
  const row = el(`<button class="link due-glance" data-state="${esc(c.state)}" data-commitment="${esc(c.id)}">
    <span class="label"></span><span class="when"></span>
  </button>`);
  (row.querySelector('.label') as HTMLElement).textContent = c.title;
  (row.querySelector('.when') as HTMLElement).textContent = dueLine(c, Date.now());
  // This is a handoff to one exact piece of work, not merely a room change.
  // Reuse Plan's authoritative reread-and-focus path so a long plan does not
  // make the learner find the deadline they just chose. A missing historical
  // target simply leaves the ordinary Plan intact.
  row.addEventListener('click', () => void renderPlan(c.id, true));
  return row;
}

/** A topic, in the board's own words, opening the board. */
function topicChip(t: TopicChipView): HTMLElement {
  const chip = el(`<button class="link topic-chip"></button>`);
  chip.textContent = t.label;
  chip.addEventListener('click', () => openBoardFace());
  return chip;
}

/**
 * What is being studied that no course claims.
 *
 * The half of the room that the old screen could not have drawn at all. Study
 * time and lessons typed straight into the plan belong to nothing, and topics
 * grow on the board from anything the learner pins — so a room that showed only
 * courses showed a tidy fiction. Named plainly and put last, because it is a
 * list of loose ends rather than a rebuke: nothing here is counted, and nothing
 * here asks to be filed.
 */
function notInACourse(
  unattached: { commitments: CommitmentView[]; topics: TopicChipView[] },
  /**
   * The results that belong to no course.
   *
   * Ana's blocker of 2026-08-24: she files a grade, is told it "is now
   * evidence", and it appears nowhere. `courseBlock` shows a course's results,
   * so a result recorded without a course link — which is what the form's own
   * "No course link" default produces — had no section anywhere in the product
   * that would draw it. The Plan's banner is a moment and is gone on the next
   * navigation, which is correct for a banner and no substitute for somewhere
   * to look.
   *
   * Here, and with the same row a course card uses, because a result read in
   * two rooms has to be the same object: `outcomeRow` carries the correction
   * control, so a grade filed loose can still be put right.
   *
   * `null` is the read that did not happen, and it draws the section rather
   * than skipping it: a learner who has filed one loose grade and cannot see it
   * is Ana's blocker again, and it does not become a different blocker because
   * the cause was the network rather than a missing renderer.
   */
  outcomes: readonly OutcomeView[] | null = [],
  knownCourseIds: ReadonlySet<string> = new Set(),
  outcomeContext: OutcomeContextView | null = null,
): HTMLElement | null {
  const commitments = unattached.commitments ?? [];
  const topics = unattached.topics ?? [];
  const loose = outcomes === null ? null : outcomes.filter((o) =>
    !o.courseId || !knownCourseIds.has(o.courseId));
  if (!commitments.length && !topics.length && loose !== null && !loose.length) return null;
  const node = el(`<section class="not-in-course">
    <h2>Not in a course</h2>
    <p class="meta">Study you saved independently from your courses.</p>
    <div class="rows"></div>
    <div class="chips"></div>
    <div class="extras"></div>
  </section>`);
  const rows = node.querySelector('.rows') as HTMLElement;
  if (commitments.length) rows.append(el('<h3 class="loose-heading">On your plan</h3>'));
  for (const c of commitments) rows.append(commitmentGlance(c));
  const chips = node.querySelector('.chips') as HTMLElement;
  if (topics.length) chips.append(el('<h3 class="loose-heading">From your board</h3>'));
  for (const t of topics) chips.append(topicChip(t));
  if (loose === null || loose.length) {
    const zone = el(`<section class="results"><h3>Results</h3><div class="rows"></div></section>`);
    const list = zone.querySelector('.rows') as HTMLElement;
    if (loose === null) list.append(el(`<p class="empty">${esc(resultsUnreadableLine())}</p>`));
    else for (const o of loose) list.append(outcomeRow(o, outcomeContext));
    (node.querySelector('.extras') as HTMLElement).append(zone);
  }
  return node;
}

function courseForm(after: () => void, resume: () => void | Promise<void>): HTMLElement {
  const form = el(`<div class="repair-choice add-course">
    <label>Add a course</label>
    <div class="fields">
      <label class="field"><span>Name</span><input class="name title" type="text" placeholder="Short story writing"><span class="meta input-limit">Up to 160 characters. I save the whole course name.</span></label>
      <label class="field"><span>Provider or place <em>(optional)</em></span><input class="name provider" type="text" placeholder="Udacity"><span class="meta input-limit">Up to 120 characters. I save the whole provider name.</span></label>
    </div>
    <div class="row"><button class="primary" data-add>Add course</button></div>
    <p class="note" role="status" aria-live="polite"></p>
  </div>`);
  const formKey = 'course';
  const title = form.querySelector('.title') as HTMLInputElement;
  const provider = form.querySelector('.provider') as HTMLInputElement;
  const note = form.querySelector('.note') as HTMLElement;
  title.value = addDraftValue(formKey, 'title');
  provider.value = addDraftValue(formKey, 'provider');
  const remember = (): void => rememberAddDraft(formKey, {
    title: title.value, provider: provider.value,
  });
  title.addEventListener('input', remember);
  provider.addEventListener('input', remember);
  const button = form.querySelector('[data-add]') as HTMLButtonElement;
  button.addEventListener('click', async () => {
    if (!title.value.trim()) { note.textContent = 'It needs a name.'; return; }
    if (refuseAuthoredOverflow(title.value, STUDY_TEXT_LIMITS.title,
      'course name', note, title)) return;
    if (refuseAuthoredOverflow(provider.value, STUDY_TEXT_LIMITS.provider,
      'provider name', note, provider)) return;
    remember();
    const made = await addFormWrite<{ course?: { id: string } }>(form, button, note, '/courses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: title.value, provider: provider.value }),
    }, 'Adding the course…', 'That did not go through. Your course draft is still here.', resume);
    if (!made) return;
    ADD_FORM_DRAFTS.delete(formKey);
    if (made.body.course?.id) void renderCourses(made.body.course.id, false, null, null, true);
    else after();
  });
  return form;
}

/**
 * Material, added by hand.
 *
 * `course` is either the one it is going into — the per-course control, which
 * knows — or the list to choose from, which is the Add sheet, where the learner
 * has not said yet. One form either way: two forms for one write is how the
 * same field comes to be validated twice and differently.
 */
function materialForm(
  course: string | readonly CoursePick[], after: () => void,
  resume: () => void | Promise<void> = () => renderCourses(
    typeof course === 'string' ? course : null, false, null, null, typeof course === 'string',
  ),
  cancel: (() => void) | null = null,
  courseTitle = '',
): HTMLElement {
  const form = el(`<div class="repair-choice add-material">
    <div class="fields">
      <label class="field"><span>Title</span><input class="name title" type="text"><span class="meta input-limit">Up to 180 characters. I save the whole material title.</span></label>
      <label class="field"><span>Link <em>(optional)</em></span><input class="name url" type="text" placeholder="https://"></label>
      <label class="field"><span>Kind</span><select class="kind">
        <option value="video">Video</option>
        <option value="reading">Reading</option>
        <option value="class">Class</option>
        <option value="exercise">Exercise</option>
        <option value="other">Other</option>
      </select></label>
      <label class="field"><span>Minutes <em>(optional)</em></span><input class="name minutes" type="number" min="1"></label>
    </div>
    <div class="row"><button class="primary" data-add>Add material</button></div>
    <p class="note" role="status" aria-live="polite"></p>
  </div>`);
  const formKey = `material:${typeof course === 'string' ? course : 'sheet'}`;
  const title = form.querySelector('.title') as HTMLInputElement;
  const link = form.querySelector('.url') as HTMLInputElement;
  const kind = form.querySelector('.kind') as HTMLSelectElement;
  const minutes = form.querySelector('.minutes') as HTMLInputElement;
  const note = form.querySelector('.note') as HTMLElement;
  const picked = typeof course === 'string'
    ? null
    : coursePicker(form.querySelector('.fields') as HTMLElement, course, 'Course', false);
  title.value = addDraftValue(formKey, 'title');
  link.value = addDraftValue(formKey, 'url');
  kind.value = addDraftValue(formKey, 'kind', kind.value);
  minutes.value = addDraftValue(formKey, 'minutes');
  if (picked) picked.value = addDraftValue(formKey, 'courseId', picked.value);
  const remember = (): void => rememberAddDraft(formKey, {
    title: title.value, url: link.value, kind: kind.value, minutes: minutes.value,
    courseId: picked?.value ?? (typeof course === 'string' ? course : ''),
  });
  for (const field of [title, link, kind, minutes, ...(picked ? [picked] : [])]) {
    field.addEventListener('input', remember);
    field.addEventListener('change', remember);
  }
  const button = form.querySelector('[data-add]') as HTMLButtonElement;
  if (courseTitle) button.setAttribute('aria-label', `Add material to ${courseTitle}`);
  if (cancel) {
    const cancelButton = el(`<button class="link" data-cancel>Cancel</button>`) as HTMLButtonElement;
    cancelButton.setAttribute('aria-label', courseTitle
      ? `Cancel adding material to ${courseTitle}` : 'Cancel adding material');
    cancelButton.addEventListener('click', () => {
      ADD_FORM_DRAFTS.delete(formKey);
      cancel();
    });
    button.parentElement?.append(cancelButton);
  }
  button.addEventListener('click', async () => {
    if (!title.value.trim()) { note.textContent = 'It needs a title.'; return; }
    if (refuseAuthoredOverflow(title.value, STUDY_TEXT_LIMITS.materialTitle,
      'material title', note, title)) return;
    const courseId = typeof course === 'string' ? course : picked?.value ?? '';
    if (!courseId) { note.textContent = 'Choose the course it goes in.'; return; }
    remember();
    const made = await addFormWrite<{ course?: { id: string; material?: { id: string }[] } }>(form, button, note,
      `/courses/${encodeURIComponent(courseId)}/material`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: title.value, url: link.value, kind: kind.value,
        minutes: minutes.value || null,
      }),
    }, 'Adding the material…',
    'That did not go through. Your material draft is still here. If you pasted a link, it has to be a web address.',
    resume);
    // The one refusal worth wording here: a link that is not a link. It is
    // refused rather than stored, because this string becomes an href.
    if (!made) return;
    ADD_FORM_DRAFTS.delete(formKey);
    const created = made.body.course?.material?.at(-1)?.id;
    if (made.body.course?.id) void renderCourses(made.body.course.id, false, created ?? null);
    else after();
  });
  return form;
}

/**
 * QUICK BURST — five minutes, one prompt at a time.
 *
 * The answers are real recall signals and go to the ledger. Finishing the room
 * adds no second participation award: an honest "I don't remember" must never
 * turn into points merely because the learner reached the end.
 * Every prompt says why it is being asked, because an unexplained prompt is a
 * quiz, and this product does not test people.
 */
async function renderBurst(): Promise<void> {
  frame('burst', { title: 'Five-minute recall' });
  const owner = roomOwnership();

  const data = await api<{ minutes: number; items: BurstItemView[] }>('/burst');
  if (!ownsRoom(owner)) return;
  if (!data) { owner.content.append(el(`<p class="empty">${esc(VIRGIL_UNAVAILABLE)}</p>`)); return; }
  if (!data.items.length) {
    owner.content.append(el(`<p class="bare">Nothing to bring back yet. Pin something, press Process, and this fills up.</p>`));
    return;
  }

  const host = el(`<div class="burst"></div>`);
  owner.content.append(host);
  let index = 0;

  const show = (): void => {
    const item = data.items[index];
    if (!item) return;
    const card = el(`<section class="burst-item">
      <p class="meta burst-progress"></p>
      <h2></h2>
      <p class="why"></p>
      <p class="burst-prompt"></p>
      <label class="field" for="burst-recall"><span>Your recall</span>
        <textarea id="burst-recall" rows="5" placeholder="Say what you remember. Uncertainty is useful."></textarea>
        <span class="meta input-limit">Up to 1,500 characters. I check the whole recall.</span>
      </label>
      <div class="row">
        <button class="primary" data-check>Check my recall</button>
        <button data-no>I don't remember</button>
      </div>
      <p class="said" role="status" aria-live="polite"></p>
    </section>`);
    (card.querySelector('.burst-progress') as HTMLElement).textContent =
      `Recall ${index + 1} of ${data.items.length}`;
    (card.querySelector('h2') as HTMLElement).textContent = item.label;
    (card.querySelector('.why') as HTMLElement).textContent = burstReasonLine(item.reason);
    (card.querySelector('.burst-prompt') as HTMLElement).textContent = item.prompt;
    const said = card.querySelector('.said') as HTMLElement;
    const recall = card.querySelector('textarea') as HTMLTextAreaElement;
    const check = card.querySelector('[data-check]') as HTMLButtonElement;
    const no = card.querySelector('[data-no]') as HTMLButtonElement;
    const answerClientRef = newClientRef();
    const release = protectUnsentForm(
      card, 'recall answer', [recall], () => host.replaceChildren(), () => recall.focus(),
    );

    const answer = async (body: { answer: string } | { verdict: 'not-really' }): Promise<void> => {
      check.disabled = true; no.disabled = true; recall.disabled = true;
      card.setAttribute('aria-busy', 'true');
      said.textContent = 'Checking your recall…';
      const r = await apiResult<{ ok: boolean; verdict: 'got-it' | 'not-really'; feedback: string | null }>('/burst/answer', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topicId: item.topicId, ...body, clientRef: answerClientRef }),
      });
      if (r.kind !== 'ok') {
        said.textContent = authoredWriteFailure(r, 'recall answer');
        check.disabled = false; no.disabled = false; recall.disabled = false;
        card.removeAttribute('aria-busy');
        (body as { answer?: string }).answer === undefined ? no.focus() : check.focus();
        return;
      }
      release();
      card.removeAttribute('aria-busy');
      said.textContent = r.body.feedback || 'Noted. I will bring it back sooner.';
      card.className = `${card.className} answered`;
      const next = el(`<button class="primary" data-next>${index + 1 === data.items.length ? 'Finish burst' : 'Next recall'}</button>`) as HTMLButtonElement;
      next.addEventListener('click', () => {
        if (index + 1 === data.items.length) {
          finishBurst(host, data.items.length);
        } else {
          index += 1;
          show();
        }
      });
      card.append(el(`<div class="row burst-next"></div>`));
      card.querySelector('.burst-next')!.append(next);
    };
    check.addEventListener('click', () => {
      const written = recall.value.trim();
      if (!written) {
        said.textContent = 'Write what you remember, or choose I don’t remember.';
        recall.focus();
        return;
      }
      const answerChars = unicodeChars(written);
      if (answerChars > LEARNER_ANSWER_MAX_CHARS) {
        said.textContent = `That answer is ${answerChars.toLocaleString('en-US')} characters. `
          + 'Keep it to 1,500 so I can check all of it. Nothing was sent.';
        recall.focus();
        return;
      }
      void answer({ answer: written });
    });
    no.addEventListener('click', () => void answer({ verdict: 'not-really' }));
    host.replaceChildren(card);
    recall.focus();
  };
  show();
}

/** The end of a burst: the work just completed, and the way back. */
function finishBurst(host: HTMLElement, checked: number): void {
  const receipt = `Burst finished · ${checked} ${checked === 1 ? 'topic' : 'topics'} checked.`;
  const end = el(`<div class="burst-end">
    <p class="earned"></p>
    <div class="row"><button class="primary" data-home>Continue in Learn</button></div>
  </div>`);
  (end.querySelector('.earned') as HTMLElement).textContent = receipt;
  end.querySelector('[data-home]')!.addEventListener('click', async () => {
    await renderHome(receipt);
    focusRoomStart();
  });
  host.replaceChildren(end);
}

/** Draw rewards at fixed, faint positions behind the board content. */
async function paintStars(host: HTMLElement): Promise<void> {
  const plan = await api<PlanView>('/plan');
  const board = host.querySelector('.board') as HTMLElement | null;
  if (!plan || !board || plan.stars < 1) return;

  const sky = el(`<div class="sky" aria-hidden="true"></div>`);
  // Twelve fixed places, in the order they fill. Past twelve the board would be
  // a sky rather than a board, so the count is said in words instead.
  const spots = [
    [86, 12], [62, 26], [91, 44], [70, 58], [95, 71], [58, 84],
    [78, 92], [45, 17], [38, 63], [30, 88], [52, 46], [22, 33],
  ];
  for (let i = 0; i < Math.min(plan.stars, spots.length); i += 1) {
    const [x, y] = spots[i] as [number, number];
    const star = el(`<span class="star">★</span>`);
    star.setAttribute('style', `left:${x}%;top:${y}%`);
    sky.append(star);
  }
  board.prepend(sky);
}
