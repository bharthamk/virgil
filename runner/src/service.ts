import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  awardsForSession, boardAreaFor, computeComfort, flaggedRows, FLAGGED_ROWS, isStaleResume,
  unpaidAwardsForClosing, commitmentState, courseProgress, deadlineDay,
  calendarDateAfterWeeks, hasRecurrence, weeklyDates,
  WEEKLY_RECURRENCE_MIN, WEEKLY_RECURRENCE_MAX,
  COMMITMENT_TITLE_MAX_CHARS,
  COURSE_PROVIDER_MAX_CHARS, COURSE_SOURCE_TITLE_MAX_CHARS,
  COURSE_TITLE_MAX_CHARS, MATERIAL_TITLE_MAX_CHARS, INTAKE_SOURCE_MAX_CHARS,
  isOpenableUrl, orderCommitments, resolveLocalDeadline,
  buildDeterministicIntake, editIntakeDraft, enrichCourseIntake,
  isIntakeProposalRejected, validateIntakeDraft,
  outcomeSignalSeeds, signalsForOutcome, validAvailableMinutes,
  starsFrom, totalPoints,
  planBurst, burstPrompt, burstSignalFor, BURST_MINUTES,
  markAssignment, markSummary, MAX_CONTEXT_CHARS, MAX_CRITERIA, MAX_CRITERION,
  MAX_DRAFT_CHARS, MAX_WORK_CHARS, MIN_DRAFT_CHARS, MIN_WORK_CHARS, RubricLimitError,
  LlmCredentialMissing, LlmRefused,
  isLocalConnectorStore,
  type Llm,
  type QcOutcome,
  type Award, type Commitment, type Course, type Material, type CourseSourceKind,
  type AvailableMinutes, type CriterionOutcome, type LearningOutcome, type OutcomeKind,
  lastTouchedAt, markAnswer, markRecallAnswer, LEARNER_ANSWER_MAX_CHARS,
  fallbackLabel, momentHref, pdfPageHref, projectProgression, recapSoFar, rendersEmpty,
  askAboutPin, ASK_TURN_CHARS, answerTangent, TANGENT_ANSWER_CHARS,
  TANGENT_QUESTION_CHARS, handleCorrection, projectSafeSession, retireConcededLessonShell, explainStep,
  guideSteps, GUIDE_MATERIAL, REGISTER_ORDER, type AskTurn,
  scheduleFrom, dayKeyFor, isZone,
  planBatch, estimateCalls, autoThreshold, owedEnrichment, owesIntakeEnrichment,
  observableMaterial,
  workCapFrom, DEFAULT_WORK_CAP,
  capDocumentText, describeExtraction, documentFormatOf, extractDocumentText, htmlTitle,
  SERVER_PARSE_COVERAGE, DOCUMENT_CAPS, DOCUMENT_TEXT_CHARS, tidyText,
  type ExtractionOutcome,
  quickTake, QUICK_TAKE_MATERIAL, clampTakeMinutes, quickTakeMaterialFor,
  quickTakeMaterialKey, quickTakeOfferMinutes, registerFor, lessonGroundingFor,
  matchTopics, resolveContext, topicDocument, MATCH_MATERIAL,
  type ComfortRead, type LiveContext, type TopicMatch,
  review, rewriteAtDepth, scout, transcribePages,
  sessionCard, shiftRegister, stripInvisible, stripFrom, cleanSectionBody, ensureLearnerAction,
  tend, TopicOpError,
  NOT_NOW_DAYS, QUICK_TAKE_MARKS, QUICK_TAKE_VERDICTS,
  subjectForTopic, commitmentForTopic, unframeGist,
  type Pin, type Deps, type Store, type Session, type DepthRegister, type Signal, type Suggestion,
  type Topic, type PrereqEdge, type Statement,
  type ExternalEntry, type ProspectProposal, type PassedOverLedger,
  type LearnerPrefs, type HostedProcessingReceipt,
  type CourseIntakeDraft, type Identity, type Learner,
  boardIdFor,
  allWritten, failedDocs, receiptLine,
  NOTEBOOK_DOC_KEYS, notebookDocTitle,
  type NotebookExport, type WriteReceipt,
  mutateLearnerPrefs, mutateStoredPin,
  EMPTY_PASSED_OVER_LEDGER,
} from '@sb/core';
import { progressionSnapshot } from './progression-source.js';
import { reviseCourseMaterial } from './course-material-edit.js';
import { parseCourseMaterialProgress } from './course-material-progress.js';
import { runBatch, sessionLearnerContext, type StageReport } from './pipeline.js';
import {
  NotebookScopeError, exportNotebook, notebookScope,
} from './notebook-export.js';
import { UsageMeter, meterEmbedder, meterLlm, meterLlmAs } from './usage.js';
import {
  EXIT_CONFIG, LOOPBACK, MEMORY_BOARD_PATH, SHARED_SECRET_HEADER, StoreSpecError,
  bindHost, firestoreWiring, gracefulClose, identityChoice, identityIsSafeHere,
  learnerBoardPath, llmChoice, memoryFs, outcomeOf, sharedSecret, storeChoice,
  warmupWanted,
  type FirestoreWiring, type ShutdownResult, type StoreChoice,
} from './runtime.js';
import {
  CliEndpointLlm, FirebaseAuth, FirestoreStore, GeminiLlm, KeyLadderLlm, OllamaLlm,
  OllamaEmbedder, TfIdfEmbedder, JsonStore, LocalResearch, LocalNotebookExport,
  DriveNotebookExport, DRIVE_FOLDER_NAME, driveFolderLink,
  GEMINI_TIERS, modelInputWindow, modelInputWindowForId, VertexCredential, VERTEX_GEMINI_TIERS, vertexModelEndpoint,
  type ModelInputWindow,
} from '@sb/adapters';
import { systemClock } from '@sb/core';
import {
  DEFAULT_CLI_MODEL_ENDPOINT, DEFAULT_LOCAL_MODEL_ENDPOINT, DEFAULT_MODEL_MODE,
  DEFAULT_MODEL_PROVIDERS, DEFAULT_MODEL_ROUTES, ModelRouter,
  effectiveModelProviders, effectiveModelRoutes, isModelProviderToggles, isModelRoutes,
  modelEndpoint, type ModelMode, type ModelProviderToggles, type ModelRoutes,
} from './model-routing.js';
import { LocalCloudCredential, type CloudCredentialControl } from './model-credentials.js';
import { LocalDriveCredential, type DriveClientCredential } from './drive-credentials.js';
import { DriveTokens, LoopbackConsent, DRIVE_SCOPE } from './drive-oauth.js';
import { notebookDestination } from './notebook-targets.js';
import { managedDriveGrant } from './managed-drive.js';
import { handleHostedNotebookRoute, hostedNotebookUrl } from './hosted-notebook-routes.js';
import {
  ModelBudgetLedger, ModelBudgetStop, budgetStopInScope, budgetedLlm, firePaidGateInScope,
  operatorModelBudgetFrom, withBudgetScope,
} from './model-budget.js';
import {
  type LearnerAccessPolicy,
} from './access-policy.js';
import { openTenantAccess } from './tenant-access.js';
import {
  LocalConnectorLlm, createLocalConnectorToken, localConnectorLearnerId,
  localConnectorPairingReceipt, localConnectorTokenHash,
} from './local-model-connector.js';
import { handleTenantMemberRoute, type TenantMemberRouteContext } from './tenant-members-routes.js';
import {
  CloudRunJobConfigError, CloudRunJobLaunchError, CloudRunJobLauncher, cloudRunJobTarget,
  type HostedRunLauncher,
} from './cloud-run-job.js';
import { HOSTED_ATTEMPT_LEASE_MS, hostedProcessingVersion } from './hosted-processing.js';
import { handleLearnerOverviewRoute } from './learner-overview-routes.js';
import { handleModelBudgetRoute } from './model-budget-routes.js';
import { handleLearnerModelRoute } from './learner-model-routes.js';
import { handleProspectRoute } from './prospect-routes.js';
import { handleExternalRoute } from './external-routes.js';
import { pinsInbox } from './pins-inbox.js';
import { readNextActionFor } from './today-source.js';
import {
  dropArtifactId, dropDisplayName, exactAgentIdentity, intakeArtifactId, sameDropSource,
} from './agent-intake-identity.js';
import { validatePortableDomain } from './portable-backup-validation.js';
/**
 * The local stand-in for Cloud Run.
 *
 * Deliberately thin: it holds no logic of its own, only wiring. Everything it
 * does is `core/` agents plus adapters, so porting to Cloud Run replaces this
 * file and nothing else.
 *
 * The routing lives in `createApp(deps)`, which builds a request handler and
 * listens to nothing. That split exists so the endpoints can be exercised
 * against an injected store and a stub `Llm` — before this, the only way to
 * reach a handler was to start the real service on the real port and curl it,
 * which is why the split/merge endpoints shipped with no test at all. Running
 * this file directly is unchanged: same env vars, same port, same log lines.
 */

/**
 * Which origins are allowed to READ a reply from this service.
 *
 * This was `*`, under a comment saying the extension is the only client. That
 * comment was true about who calls and beside the point about who can read.
 * `*` is a grant to every page on the internet. On a single-board loopback
 * service `runtime.ts` deliberately requires neither account identity nor a
 * shared secret, so on the shape local development actually runs, bound to
 * 127.0.0.1 with `SB_SHARED_SECRET` unset, any tab left open anywhere could
 * call `DELETE /everything`, `DELETE /pins/:id` or `PUT /model/:id` *and read
 * the answer back*. Without the header a hostile page can still send the
 * request; what `*` added was handing it the board.
 *
 * Two origin shapes are echoed and nothing else:
 *
 *  - `chrome-extension://…` — the panel, the action popup and the service
 *    worker. The id changes per browser profile and per unpacked load, so it
 *    cannot be a fixed string in this file; the SCHEME is the part worth
 *    trusting, because only an installed extension is served one and a web page
 *    cannot forge the Origin its own browser sends.
 *  - `http://127.0.0.1:<port>` and `http://localhost:<port>` — `qa/extension.html`,
 *    which runs the real compiled panel off a throwaway `http.server` on
 *    whatever port is free and talks to the real service on 8791. That is a
 *    cross-origin call between two loopback ports and it is the only browser
 *    client that is not the extension. Echoing it grants nothing new: anything
 *    already running on this machine's loopback can reach these routes
 *    directly, without a browser and without a header.
 *
 * No other origin gets an `access-control-allow-origin` at all. An absent
 * header is how "not allowed" is spelled in CORS, and sending a value the
 * browser is going to reject would only make the reply harder to read for
 * whoever is trying to work out why their fetch failed.
 */
const LOOPBACK_ORIGIN_HOSTS: readonly string[] = ['127.0.0.1', 'localhost'];
const TIME_ZONE_HEADER = 'x-virgil-time-zone';
const CLIENT_SCHEMA_HEADER = 'x-virgil-client-schema';
const LOCAL_CONNECTOR_HEADER = 'x-virgil-local-connector';
const SERVICE_SCHEMA_VERSION = 1;
const MIN_CLIENT_SCHEMA_VERSION = 1;
const MAX_CLIENT_SCHEMA_VERSION = 1;
const MODEL_CONFIG_SCHEMA_VERSION = 1;

const compatibilityReceipt = () => ({
  protocol: 'virgil-browser-service',
  serviceSchema: SERVICE_SCHEMA_VERSION,
  minClientSchema: MIN_CLIENT_SCHEMA_VERSION,
  maxClientSchema: MAX_CLIENT_SCHEMA_VERSION,
  modelConfigSchema: MODEL_CONFIG_SCHEMA_VERSION,
});

export interface BoardWebOptions {
  readonly root: string;
  readonly authConfig: {
    readonly apiKey: string;
    readonly projectId: string;
    readonly emulatorHost?: string;
  } | null;
  /** Web-application OAuth client, authorised for this service origin. The
   * extension's Chrome-app client is a different installation artefact. */
  readonly googleWebClientId: string | null;
}

const BOARD_WEB_ROOT = fileURLToPath(new URL('../../extension/', import.meta.url));

const boardMime = (path: string): string => {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.ttf')) return 'font/ttf';
  if (path.endsWith('.pfb')) return 'application/octet-stream';
  return 'application/octet-stream';
};

/** The board page is public furniture; the data routes behind it are not. */
function serveBoardWeb(req: IncomingMessage, res: ServerResponse, web: BoardWebOptions): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/') {
    res.writeHead(302, { location: '/app/', 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  if (path === '/app') {
    res.writeHead(308, { location: '/app/', 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  if (!path.startsWith('/app/')) return false;

  if (path === '/app/config.js' || path === '/app/config.json') {
    const publicConfig = JSON.stringify({
      authConfig: web.authConfig,
      googleWebClientId: web.googleWebClientId,
    }).replaceAll('<', '\\u003c');
    const origin = allowedOrigin(req.headers.origin);
    if (path === '/app/config.json') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        vary: 'origin',
        ...(origin === null ? {} : { 'access-control-allow-origin': origin }),
      });
      res.end(req.method === 'HEAD' ? undefined : publicConfig);
      return true;
    }
    const body = `globalThis.__VIRGIL_WEB_CONFIG__ = ${publicConfig};\n`;
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  let relative = 'web.html';
  if (path !== '/app/') {
    try {
      relative = decodeURIComponent(path.slice('/app/'.length));
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return true;
    }
  }
  const allowed = relative === 'web.html' || relative === 'panel.css' || relative === 'web-runtime.js'
    || (/^(?:dist|assets|vendor)\/[A-Za-z0-9._/-]+$/.test(relative) && !relative.includes('__tests__'));
  if (!allowed || relative.split('/').includes('..')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return true;
  }
  const root = resolve(web.root);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return true;
  }
  try {
    const body = readFileSync(target);
    res.writeHead(200, {
      'content-type': boardMime(target),
      // These filenames are stable across upgrades rather than content-hashed.
      // Revalidation keeps an already-open self-hosted browser from running a
      // previous panel against a newly upgraded service for five minutes.
      'cache-control': relative === 'web.html' ? 'no-store' : 'no-cache',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      // WebMCP requires an origin-keyed agent cluster. State the deployment
      // property explicitly so a proxy/default change cannot silently remove
      // the page's tools.
      'origin-agent-cluster': '?1',
      'referrer-policy': 'same-origin',
      // `tools` defaults to self in the draft; naming it here keeps the
      // capability closed to embeds even if that platform default moves.
      'permissions-policy': 'tools=(self), camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'content-security-policy': [
        "default-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'none'",
        "script-src 'self' https://accounts.google.com",
        "style-src 'self'",
        "img-src 'self' data: blob: https://*.googleusercontent.com",
        "font-src 'self' data:",
        "connect-src 'self' https://accounts.google.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com",
        "frame-src https://accounts.google.com",
        "worker-src 'self' blob:",
      ].join('; '),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
  return true;
}

const allowedOrigin = (origin: string | undefined): string | null => {
  if (!origin) return null;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return null; }
  /**
   * Re-serialised and compared byte for byte, because an origin is a scheme, a
   * host and an optional port and nothing else. Neither obvious check works
   * here: `new URL` accepts a path, a query and embedded credentials without
   * complaint, and `parsed.origin` is the literal string `"null"` for every
   * non-special scheme, `chrome-extension:` included. Rebuilding the header a
   * browser would have sent and demanding it match rejects anything wearing a
   * tail.
   */
  const bare = parsed.port
    ? `${parsed.protocol}//${parsed.hostname}:${parsed.port}`
    : `${parsed.protocol}//${parsed.hostname}`;
  if (bare !== origin) return null;
  if (parsed.protocol === 'chrome-extension:') return origin;
  if (parsed.protocol === 'http:' && LOOPBACK_ORIGIN_HOSTS.includes(parsed.hostname)) return origin;
  return null;
};

const json = (res: ServerResponse, code: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  /**
   * Did the learner's own spend limit stop a model call while this request was
   * being answered?
   *
   * On the reply rather than only in the body, because the handlers that most
   * need to say it are the ones that catch a model failure and degrade — a pin
   * that fell back to a plain label, a mark that reports the check did not run.
   * Those bodies are shaped by the endpoint and cannot carry a new field each;
   * this header is one place, on every reply, and a panel that reads it can
   * always tell "your budget stopped this" from "the model failed".
   *
   * Exposed by name in the CORS block or the browser strips it and the panel
   * reads nothing at all — the same failure the shared-secret header had.
   */
  const stopped = budgetStopInScope();
  // Read off the response's own request rather than threaded through every one
  // of the several hundred `json(...)` call sites below. Every reply this
  // service sends goes through here, including both `OPTIONS` short-circuits,
  // which is what makes one allowlist enough to cover the preflight too.
  const origin = allowedOrigin(res.req.headers.origin);
  res.writeHead(code, {
    'content-type': 'application/json',
    // Every JSON route describes mutable learner state. Without an explicit
    // policy, a browser may reuse a provenance, session or plan GET after the
    // learner has changed it; the live source-receipt repair exposed exactly
    // that by returning the pre-upgrade response after a service restart.
    'cache-control': 'no-store',
    ...(stopped ? { 'x-virgil-model-budget': `stopped:${stopped}` } : {}),
    'access-control-expose-headers': 'x-virgil-model-budget',
    // The reply now differs by Origin, so anything caching it has to be told
    // which request header it was keyed on. See `allowedOrigin` for the list.
    vary: 'origin',
    ...(origin === null ? {} : { 'access-control-allow-origin': origin }),
    // PATCH is used by reviewed-intake corrections. Browsers preflight that
    // verb, so direct endpoint success alone is not enough for a working UI.
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    // Both doors are named here. A multi-user service uses Authorization; a
    // protected single-board service uses the shared-secret header.
    'access-control-allow-headers': `content-type, authorization, ${SHARED_SECRET_HEADER}, ${TIME_ZONE_HEADER}, ${CLIENT_SCHEMA_HEADER}, ${LOCAL_CONNECTOR_HEADER}`,
  });
  res.end(payload);
};

/**
 * Two secrets, compared without saying how far the comparison got.
 *
 * `===` on a string leaves at the first differing byte, which is a measurable
 * difference over a network for a caller who can retry. The lengths are
 * compared first because `timingSafeEqual` throws on unequal ones — so length
 * is the one thing this does leak, and a floor of sixteen characters is what
 * makes that worth nothing.
 */
function secretMatches(sent: string | undefined, wanted: string): boolean {
  if (typeof sent !== 'string') return false;
  const a = Buffer.from(sent, 'utf8');
  const b = Buffer.from(wanted, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A write receipt, as the wire sees it.
 *
 * `line` is the sentence a surface can show without composing one of its own,
 * so that the panel and the log cannot describe the same receipt differently.
 * `failed` is the keys rather than the titles, because a caller acts on keys
 * and reads titles.
 *
 * **Nothing here says the notebook is up to date**, and nothing built on it may
 * either. This reports what Virgil last wrote to a folder. What Google read out
 * of that folder, and when, is not something this process can see.
 */
const notebookBody = (receipt: WriteReceipt, configuredUrl?: string | null): Record<string, unknown> => ({
  ok: allWritten(receipt),
  ran: true,
  at: receipt.at,
  target: receipt.target,
  line: receiptLine(receipt),
  failed: failedDocs(receipt).map((d) => d.key),
  docs: receipt.docs,
  notebookUrl: hostedNotebookUrl(configuredUrl),
});

class BadRequest extends Error {}
const refuseBadRequest = (message: string): never => { throw new BadRequest(message); };
class Forbidden extends Error {}
class PayloadTooLarge extends Error {}

/**
 * Below Cloud Run's 32 MiB HTTP/1 ceiling by four MiB, so Virgil—not the
 * platform—answers an oversized request consistently on hosted and local
 * installs. The margin covers request framing and prevents a product promise
 * from depending on which proxy terminates HTTP.
 */
export const REQUEST_BODY_LIMIT_BYTES = 28 * 1024 * 1024;

const PORTABLE_BACKUP_FORMAT = 'virgil-learner-backup';
const LEGACY_PORTABLE_BACKUP_VERSION = 1;
const PORTABLE_BACKUP_VERSION = 2;
type PortableBackupVersion = typeof LEGACY_PORTABLE_BACKUP_VERSION | typeof PORTABLE_BACKUP_VERSION;

interface PortableData {
  readonly pins: readonly Pin[];
  readonly topics: readonly Topic[];
  readonly edges: readonly PrereqEdge[];
  readonly signals: readonly Signal[];
  readonly statements: readonly Statement[];
  readonly sessions: readonly Session[];
  readonly suggestions: readonly Suggestion[];
  readonly commitments: readonly Commitment[];
  readonly awards: readonly Award[];
  readonly courses: readonly Course[];
  readonly intakeDrafts: readonly CourseIntakeDraft[];
  readonly prospectProposals: readonly ProspectProposal[];
  readonly externalEntries: readonly ExternalEntry[];
  readonly passedOver: PassedOverLedger;
  readonly outcomes: readonly LearningOutcome[];
  readonly prefs: LearnerPrefs;
}

interface PortableBackupCore {
  readonly format: typeof PORTABLE_BACKUP_FORMAT;
  readonly version: PortableBackupVersion;
  readonly ownerEmail: string | null;
  readonly exportedAt: string;
  readonly data: PortableData;
}

interface PortableBackup extends PortableBackupCore {
  readonly digest: string;
}

const portableDigest = (core: PortableBackupCore): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(core)).digest('hex')}`;

/**
 * A hosted-processing receipt belongs to one deployment, not to the learner.
 * In particular its Cloud Run Operation name cannot be resumed by another
 * installation, and an active lease copied there would suppress the new
 * installation's own worker. Keep that operational state on the live board
 * while leaving every learner-owned preference portable.
 */
const portablePrefs = (prefs: LearnerPrefs): LearnerPrefs => {
  const {
    hostedProcessing: _deploymentReceipt,
    modelBudgetLease: _budgetCoordination,
    modelBudget: _liveLimit,
    modelSpend: _liveSpend,
    ...learnerPrefs
  } = prefs;
  return learnerPrefs;
};

async function portableData(store: Store): Promise<PortableData> {
  const [pins, topics, edges, signals, statements, sessions, suggestions,
    commitments, awards, courses, intakeDrafts, prospectProposals, externalEntries,
    passedOver, outcomes, prefs] = await Promise.all([
    store.listPins(), store.listTopics(), store.listEdges(), store.listSignals(),
    store.listStatements(), store.listSessions(), store.listSuggestions(),
    store.listCommitments(), store.listAwards(), store.listCourses(),
    store.listIntakeDrafts(), store.listProspectProposals(), store.listExternalEntries(),
    store.getPassedOverLedger(), store.listOutcomes(), store.getPrefs(),
  ]);
  // Alias rows are deliberately not exported. Every Store read above resolves
  // them, so the backup carries the current learner-owned truth rather than an
  // adapter's internal identity-repair machinery.
  return {
    pins, topics, edges, signals, statements,
    sessions: sessions.map((session) => projectSafeSession(session, topics)), suggestions,
    commitments, awards, courses, intakeDrafts, prospectProposals, externalEntries,
    passedOver, outcomes, prefs: portablePrefs(prefs),
  };
}

const portableCounts = (data: PortableData): Record<string, number> => {
  const currentOutcomes = data.outcomes.filter((outcome) => !outcome.deletedAt).length;
  return {
    pins: data.pins.length, topics: data.topics.length, evidence: data.signals.length,
    statements: data.statements.length, sessions: data.sessions.length,
    suggestions: data.suggestions.length, commitments: data.commitments.length,
    awards: data.awards.length, courses: data.courses.length,
    intakeDrafts: data.intakeDrafts.length, prospectProposals: data.prospectProposals.length,
    externalEntries: data.externalEntries.length, passedOverMarks: data.passedOver.marks.length,
    outcomes: data.outcomes.length,
    currentOutcomes, outcomeHistory: data.outcomes.length - currentOutcomes,
  };
};

const portableRowCount = (data: PortableData): number => {
  const { currentOutcomes: _current, outcomeHistory: _history, ...stored } = portableCounts(data);
  return Object.values(stored).reduce((sum, count) => sum + count, 0) + data.edges.length;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

function readPortableBackup(value: unknown, ownerEmail: string | null): PortableBackup {
  const raw = record(value);
  if (!raw || raw.format !== PORTABLE_BACKUP_FORMAT
      || (raw.version !== LEGACY_PORTABLE_BACKUP_VERSION && raw.version !== PORTABLE_BACKUP_VERSION)) {
    throw new BadRequest('this is not a supported Virgil learner backup');
  }
  const backupOwner = raw.ownerEmail === null ? null
    : typeof raw.ownerEmail === 'string' ? raw.ownerEmail.trim().toLowerCase() : undefined;
  if (backupOwner === undefined) throw new BadRequest('the backup owner is missing');
  const expectedOwner = ownerEmail?.trim().toLowerCase() ?? null;
  if (backupOwner !== expectedOwner) {
    throw new Forbidden('this backup belongs to a different learner');
  }
  const data = record(raw.data);
  const legacyNames = ['pins', 'topics', 'edges', 'signals', 'statements', 'sessions', 'suggestions',
    'commitments', 'awards', 'courses', 'intakeDrafts', 'outcomes'] as const;
  const names = [...legacyNames, 'prospectProposals', 'externalEntries'] as const;
  const requiredNames = raw.version === LEGACY_PORTABLE_BACKUP_VERSION ? legacyNames : names;
  if (!data || requiredNames.some((name) => !Array.isArray(data[name])) || !record(data.prefs)
      || (raw.version === PORTABLE_BACKUP_VERSION && !record(data.passedOver))) {
    throw new BadRequest('the backup data is incomplete');
  }
  validatePortableDomain(data, refuseBadRequest);
  // Every row restored through an id-keyed or append-only Store lane must name
  // itself. Edges are the sole exception and name both ends instead.
  for (const name of requiredNames.filter((name) => name !== 'edges')) {
    if ((data[name] as unknown[]).some((row) => typeof record(row)?.id !== 'string' || !String(record(row)?.id).trim())) {
      throw new BadRequest(`the backup contains an invalid ${name} row`);
    }
  }
  if ((data.edges as unknown[]).some((edge) => {
    const e = record(edge);
    return typeof e?.from !== 'string' || typeof e?.to !== 'string';
  })) throw new BadRequest('the backup contains an invalid prerequisite row');

  const digestCore: PortableBackupCore = {
    format: PORTABLE_BACKUP_FORMAT,
    version: raw.version,
    ownerEmail: backupOwner,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    data: data as unknown as PortableData,
  };
  if (!digestCore.exportedAt || raw.digest !== portableDigest(digestCore)) {
    throw new BadRequest('the backup is incomplete or its integrity check does not match');
  }
  // Version 1 predates hosted workers, so an older or hand-built but otherwise
  // valid v1 backup may still contain this newly introduced service field.
  // Validate the original bytes first, then discard deployment-local state.
  return {
    ...digestCore,
    data: {
      ...digestCore.data,
      ...(raw.version === LEGACY_PORTABLE_BACKUP_VERSION ? {
        prospectProposals: [], externalEntries: [], passedOver: EMPTY_PASSED_OVER_LEDGER,
      } : {}),
      prefs: portablePrefs(digestCore.data.prefs),
    },
    digest: raw.digest as string,
  };
}

const sameRow = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Empty, already restored, or a byte-for-byte prefix left by an interrupted restore. */
function restoreCompatibility(current: PortableData, wanted: PortableData): 'empty' | 'same' | 'resume' | 'conflict' {
  if (portableRowCount(current) === 0) return 'empty';
  const collections = ['pins', 'topics', 'signals', 'statements', 'sessions', 'suggestions',
    'commitments', 'awards', 'courses', 'intakeDrafts', 'prospectProposals',
    'externalEntries', 'outcomes'] as const;
  for (const name of collections) {
    const byId = new Map(wanted[name].map((row) => [row.id, row]));
    if (current[name].some((row) => !byId.has(row.id) || !sameRow(row, byId.get(row.id)))) return 'conflict';
  }
  const wantedEdges = new Set(wanted.edges.map((edge) => JSON.stringify(edge)));
  if (current.edges.some((edge) => !wantedEdges.has(JSON.stringify(edge)))) return 'conflict';
  if (current.passedOver.marks.length && !sameRow(current.passedOver, wanted.passedOver)) return 'conflict';
  const allRowsPresent = portableRowCount(current) === portableRowCount(wanted);
  // Preferences are learner-owned state too. A board with every record but a
  // different preference document is an interrupted restore, not an
  // already-restored one; calling it "same" would leave routing, language or
  // accessibility choices behind while claiming the copy was complete.
  return allRowsPresent && sameRow(current.passedOver, wanted.passedOver)
    && sameRow(current.prefs, wanted.prefs) ? 'same' : 'resume';
}

async function restorePortableData(store: Store, wanted: PortableData): Promise<void> {
  for (const row of wanted.pins) await store.putPin(row);
  for (const row of wanted.topics) await store.putTopic(row);
  await store.putEdges(wanted.edges);
  const signalIds = new Set((await store.listSignals()).map((row) => row.id));
  for (const row of wanted.signals) if (!signalIds.has(row.id)) await store.appendSignal(row);
  for (const row of wanted.statements) await store.putStatement(row);
  for (const row of wanted.sessions) await store.putSession(row);
  for (const row of wanted.suggestions) await store.putSuggestion(row);
  for (const row of wanted.commitments) await store.putCommitment(row);
  const awardIds = new Set((await store.listAwards()).map((row) => row.id));
  for (const row of wanted.awards) if (!awardIds.has(row.id)) await store.appendAward(row);
  for (const row of wanted.courses) await store.putCourse(row);
  for (const row of wanted.intakeDrafts) await store.putIntakeDraft(row);
  for (const row of wanted.prospectProposals) await store.putProspectProposal(row);
  for (const row of wanted.externalEntries) await store.putExternalEntry(row);
  await store.putPassedOverLedger(wanted.passedOver);
  for (const row of wanted.outcomes) await store.putOutcome(row);
  const currentPrefs = await store.getPrefs();
  await store.putPrefs({
    ...wanted.prefs,
    ...(currentPrefs.modelBudget !== undefined ? { modelBudget: currentPrefs.modelBudget } : {}),
    ...(currentPrefs.modelSpend !== undefined ? { modelSpend: currentPrefs.modelSpend } : {}),
  });
}

/**
 * The body, parsed, and an object.
 *
 * A JSON parse failure is the client's, not ours, so it does not reach the
 * error log — an unparseable body is a fact about one request, and logging it
 * teaches nobody anything the 400 did not already say.
 */
const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > REQUEST_BODY_LIMIT_BYTES) {
    throw new PayloadTooLarge(`request body must be at most ${REQUEST_BODY_LIMIT_BYTES} bytes`);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const c of req) {
    const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
    bytes += chunk.byteLength;
    if (bytes > REQUEST_BODY_LIMIT_BYTES) {
      throw new PayloadTooLarge(`request body must be at most ${REQUEST_BODY_LIMIT_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest('body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequest('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
};

/**
 * A field the client had to send, and had to send something in.
 *
 * "Something" is `rendersEmpty` rather than `.trim()`. Whitespace is not the
 * only way to send nothing: the bidi overrides and the zero-width characters
 * are not whitespace, survive a trim, and display as an empty field wherever
 * they land — including the learner model, the one surface whose whole point is
 * that the learner can read what the product believes about them. The value is
 * returned stripped as well as checked, so a string that is *mostly* invisible
 * is stored as the part of it that is real.
 */
const requireString = (body: Record<string, unknown>, field: string): string => {
  const v = body[field];
  if (typeof v !== 'string' || rendersEmpty(v)) throw new BadRequest(`${field} is required, as a non-empty string`);
  return stripInvisible(v);
};

/** Learner-authored text is accepted whole or refused before work begins.
 * Counting Unicode code points avoids rejecting one emoji as two characters
 * or cutting it into an invalid surrogate pair at the boundary. */
const requireBoundedString = (
  body: Record<string, unknown>, field: string, maxChars: number, label = field,
): string => {
  const value = requireString(body, field);
  if (Array.from(value).length > maxChars) {
    throw new BadRequest(`${label} must contain at most ${maxChars.toLocaleString('en-US')} characters`);
  }
  return value;
};

const unicodePrefix = (value: string, maxChars: number): string =>
  Array.from(value).slice(0, maxChars).join('');

const requireTrimmedBoundedString = (
  body: Record<string, unknown>, field: string, maxChars: number, label = field,
): string => {
  const value = requireString(body, field).trim();
  if (Array.from(value).length > maxChars) {
    throw new BadRequest(`${label} must contain at most ${maxChars.toLocaleString('en-US')} characters`);
  }
  return value;
};

/**
 * An id read out of the path, as the caller meant it rather than as the wire
 * spelled it.
 *
 * Ids are not all bare uuids. An imported course is `course:<uuid>`, and a
 * colon is not a legal path character, so the browser sends `course%3A<uuid>`.
 * Reading the raw capture looked the id up under a name nothing was ever
 * stored under, and every route that took one answered "no such course" to a
 * course that was sitting right there. Decoding is done once, here, so a
 * future id with a space or a slash-free punctuation mark in it cannot
 * reintroduce the same silent miss.
 *
 * A malformed escape is returned unchanged rather than thrown: a 404 for an id
 * that cannot exist is the honest answer, and a 500 is not.
 */
const decodeId = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const pathId = (match: RegExpExecArray, index: number): string => decodeId(match[index] as string);

const requireOneOf = <T extends string>(
  body: Record<string, unknown>, field: string, allowed: readonly T[],
): T => {
  const v = body[field];
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new BadRequest(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return v as T;
};

/**
 * A date the learner typed, as an ISO instant.
 *
 * Accepts a bare `YYYY-MM-DD` because that is what a date input sends and what
 * a person means by a deadline — and pins it to the END of that day rather than
 * to midnight. A deadline of "Friday" entered as `2026-08-28` and stored as
 * `T00:00` would be a deadline that expired before Friday began.
 */
const requireDate = (body: Record<string, unknown>, field: string): string => {
  const v = body[field];
  if (typeof v !== 'string' || !v.trim()) throw new BadRequest(`${field} is required, as a date`);
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? `${v.trim()}T23:59:00.000Z` : v.trim();
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw new BadRequest(`${field} is not a date I can read`);
  return new Date(t).toISOString();
};

const optionalDate = (body: Record<string, unknown>, field: string): string | null => {
  const v = body[field];
  if (v === undefined || v === null || v === '') return null;
  return requireDate(body, field);
};

/** A deadline can be a calendar date or an exact wall time in an IANA zone.
 * Legacy callers that send only `dueAt` retain the date-only contract. A caller
 * changing the date of an existing timed row without naming `dueTime` keeps
 * that time; an explicit null/empty time returns it to date-only. */
const deadlineFromBody = (
  body: Record<string, unknown>, timeZone: string, existing?: Commitment,
): Pick<Commitment, 'dueAt' | 'dueTime' | 'dueTimeZone'> => {
  const dateValue = body.dueAt === undefined
    ? existing ? deadlineDay(existing) : undefined
    : body.dueAt;
  if (typeof dateValue !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(dateValue.trim())) {
    if (body.dueTime !== undefined) throw new BadRequest('dueAt is required as YYYY-MM-DD when a time is set');
    const dueAt = requireDate(body, 'dueAt');
    // A raw ISO instant is the legacy, date-only API shape. Do not leave an
    // existing wall time and zone attached to it: that would make the stored
    // row claim two different deadlines. Clients retaining a timed deadline
    // send its YYYY-MM-DD date (and may omit dueTime); clients replacing it
    // with a legacy value deliberately return it to date-only semantics.
    return existing?.dueTime
      ? { dueAt, dueTime: null, dueTimeZone: null }
      : { dueAt };
  }
  const date = dateValue.trim();
  const requestedTime = body.dueTime === undefined ? existing?.dueTime ?? null : body.dueTime;
  if (requestedTime === null || requestedTime === '') {
    const dateOnly = requireDate({ dueAt: date }, 'dueAt');
    return existing?.dueTime
      ? { dueAt: dateOnly, dueTime: null, dueTimeZone: null }
      : { dueAt: dateOnly };
  }
  if (typeof requestedTime !== 'string' || !/^\d{2}:\d{2}$/.test(requestedTime)) {
    throw new BadRequest('dueTime must be HH:mm, or empty for a date-only deadline');
  }
  // An existing timed deadline owns its declared zone. Opening the same board
  // from another browser must not silently reinterpret 5pm as 5pm somewhere
  // else when the learner changes only the date or wall time.
  const owningZone = existing?.dueTimeZone && isZone(existing.dueTimeZone)
    ? existing.dueTimeZone : timeZone;
  const resolved = resolveLocalDeadline(date, requestedTime, owningZone);
  if (!resolved) {
    throw new BadRequest(`dueTime does not exist on that date in ${owningZone}`);
  }
  return { dueAt: resolved, dueTime: requestedTime, dueTimeZone: owningZone };
};

const seriesIdentity = (clientRef: unknown): { seriesId: string; clientRef: string } => {
  if (typeof clientRef !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(clientRef)) {
    throw new BadRequest('clientRef is required for a recurring commitment');
  }
  return {
    clientRef,
    seriesId: `series_${createHash('sha256').update(clientRef).digest('hex').slice(0, 32)}`,
  };
};

/** Stable identity for one learner-authored form attempt. Optional keeps older
 * clients working; current clients send it so a lost success converges before
 * any second model call or append. */
const clientReceiptId = (prefix: string, clientRef: unknown): string | null => {
  if (clientRef === undefined || clientRef === null) return null;
  if (typeof clientRef !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(clientRef)) {
    throw new BadRequest('clientRef must be 8 to 160 letters, numbers, dashes or underscores');
  }
  return `${prefix}_${createHash('sha256').update(clientRef).digest('hex').slice(0, 32)}`;
};

const recurrenceHash = (value: unknown): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

const occurrenceId = (seriesId: string, index: number): string =>
  `${seriesId}_${String(index + 1).padStart(2, '0')}`;

const optionalMinutes = (body: Record<string, unknown>, field: string): number | null => {
  const v = body[field];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 24 * 60) {
    throw new BadRequest(`${field} must be a number of minutes between 1 and 1440`);
  }
  return Math.round(n);
};

/** Topic ids the client claims this leans on, as ids and nothing else. */
const optionalIds = (body: Record<string, unknown>, field: string): string[] => {
  const v = body[field];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new BadRequest(`${field} must be an array of ids`);
  }
  return (v as string[]).map((x) => stripInvisible(x)).filter(Boolean);
};

const optionalText = (body: Record<string, unknown>, field: string): string => {
  const v = body[field];
  if (typeof v !== 'string') return '';
  return stripInvisible(v);
};

/**
 * A field the client may leave out, and may not send as something else.
 *
 * `optionalText` answers the same question by shrugging: anything that is not a
 * string reads as absent. That is right where the field is a flag beside a real
 * one, and wrong where it is the whole content of a box the learner typed into
 * — a client that sent it as an array would be told nothing while the box was
 * silently dropped, and the learner would read a mark that never saw what they
 * pasted. Absent is absent; the wrong type is a 400 that names the field.
 */
const optionalString = (body: Record<string, unknown>, field: string): string => {
  const v = body[field];
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new BadRequest(`${field} must be a string, or left out`);
  return stripInvisible(v);
};

/** Optional learner-authored text has the same whole-or-refuse law as required text. */
const optionalBoundedString = (
  body: Record<string, unknown>, field: string, maxChars: number, label = field,
): string => {
  const value = optionalString(body, field);
  if (Array.from(value).length > maxChars) {
    throw new BadRequest(`${label} must contain at most ${maxChars.toLocaleString('en-US')} characters`);
  }
  return value;
};

const optionalTrimmedBoundedString = (
  body: Record<string, unknown>, field: string, maxChars: number, label = field,
): string => {
  const value = optionalString(body, field).trim();
  if (Array.from(value).length > maxChars) {
    throw new BadRequest(`${label} must contain at most ${maxChars.toLocaleString('en-US')} characters`);
  }
  return value;
};

/** Source receipts retain the exact learner-supplied text, including line
 * endings and outside whitespace. Validation may inspect it; it may not rewrite
 * the bytes whose digest the receipt publishes. */
const requireRawBoundedString = (
  body: Record<string, unknown>, field: string, maxChars: number, label = field,
): string => {
  const value = body[field];
  if (typeof value !== 'string' || rendersEmpty(value)) {
    throw new BadRequest(`${field} is required, as a non-empty string`);
  }
  if (Array.from(value).length > maxChars) {
    throw new BadRequest(`${label} must contain at most ${maxChars.toLocaleString('en-US')} characters`);
  }
  return value;
};

/**
 * What a request may attach, as pictures.
 *
 * Two numbers, both about what a service on somebody's laptop should agree to
 * hold in memory while it base64-decodes it to check the size. Twenty pages at
 * one megabyte each expand to about 26.7MB in base64; with the JSON envelope
 * they still fit under `REQUEST_BODY_LIMIT_BYTES`. A hundred pages is a denial
 * of service written by an accident in the panel.
 *
 * The panel renders at `PAGE_EDGE_PX` and JPEG quality 0.85, which puts an
 * ordinary text page around 200KB. The cap is roughly five times that, so it
 * is a guard against something having gone wrong rather than a limit a real
 * page is expected to meet.
 */
export const MEDIA_CAPS = {
  /** Pages per request. The extension refuses at the same number, earlier. */
  items: 20,
  /** Decoded bytes per page, before base64's four-for-three. */
  bytesPerItem: 1_000_000,
} as const;

/** `data:image/jpeg;base64,` or `data:image/png;base64,` and nothing else.
 *  An allow-list for the same reason `image.ts` keeps one: a type the vision
 *  path cannot read is a call that costs what a vision call costs and comes
 *  back describing nothing. */
const MEDIA_URI = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/;

/** How many bytes a base64 payload decodes to, without decoding it. */
const decodedBytes = (base64: string): number => {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
};

/**
 * The pages a request attached, validated, or a 400 that names the field.
 *
 * Every refusal names `media` and the index inside it, because the client that
 * gets this wrong is the panel and the person reading the message is whoever is
 * debugging why one page of twelve would not go. A bare "bad request" on a
 * thirty-megabyte body is an afternoon.
 *
 * Absent, `null` and `[]` are the same thing: no pages. The endpoints below
 * read the length rather than the presence, so a client that sends an empty
 * array gets the behaviour it had before this existed.
 */
const optionalMedia = (body: Record<string, unknown>, field: string): string[] => {
  const v = body[field];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new BadRequest(`${field} must be an array of data: image URIs, or left out`);
  }
  if (v.length > MEDIA_CAPS.items) {
    throw new BadRequest(`${field} carries ${v.length} images, and I take at most ${MEDIA_CAPS.items}`);
  }
  return v.map((item, i) => {
    if (typeof item !== 'string') throw new BadRequest(`${field}[${i}] must be a data: image URI string`);
    const found = MEDIA_URI.exec(item);
    if (!found) throw new BadRequest(`${field}[${i}] must be a data:image/jpeg or data:image/png base64 URI`);
    const bytes = decodedBytes(found[2] as string);
    if (bytes > MEDIA_CAPS.bytesPerItem) {
      throw new BadRequest(
        `${field}[${i}] is ${bytes} bytes, and I take at most ${MEDIA_CAPS.bytesPerItem} per image`,
      );
    }
    return item;
  });
};

/**
 * The top-of-mark sentence when the mark never happened.
 *
 * `markSummary` speaks about verdicts, and a refusal has none: handed the empty
 * list it says "I could not find any criteria in what you pasted", which on
 * these paths is the wrong diagnosis told confidently. `no-criteria` keeps that
 * sentence because there it is the right one.
 */
const markRefusalSummary = (outcome: QcOutcome): string | null => {
  if (outcome === 'too-short') return 'There is not enough here to mark against criteria yet.';
  if (outcome === 'model-failed') {
    return 'That check did not run, so nothing about the work is known either way.';
  }
  return null;
};

const optionalScore = (body: Record<string, unknown>, field: string): number | null => {
  const value = body[field];
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
    throw new BadRequest(`${field} must be a non-negative number`);
  }
  return n;
};

const criteriaFrom = (value: unknown): CriterionOutcome[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequest('criteria must be an array');
  return value.slice(0, 50).map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequest(`criteria.${index} must be an object`);
    }
    const row = raw as Record<string, unknown>;
    const verdict = row.verdict === null || row.verdict === undefined || row.verdict === ''
      ? null : requireOneOf(row, 'verdict', ['strong', 'mixed', 'gap'] as const);
    const score = optionalScore(row, 'score');
    const maxScore = optionalScore(row, 'maxScore');
    if ((score === null) !== (maxScore === null)) {
      throw new BadRequest(`criteria.${index} score and maxScore must be supplied together`);
    }
    if (score !== null && maxScore !== null && (maxScore <= 0 || score > maxScore)) {
      throw new BadRequest(`criteria.${index} score must be between zero and maxScore`);
    }
    return {
      criterionId: typeof row.criterionId === 'string' && row.criterionId ? row.criterionId : null,
      label: requireString(row, 'label').slice(0, 140), score, maxScore, verdict,
      feedback: optionalText(row, 'feedback').slice(0, 2_000),
      topicIds: optionalIds(row, 'topicIds'),
    };
  });
};

interface PinRequest {
  type: Pin['type'];
  envelope: Pin['envelope'];
  /** A learner-supplied title. Supplying one makes capture a storage-only
   *  operation; Scout is reserved for browser captures that need naming. */
  label?: string;
  note?: string | null;
  capturedAt?: string;
  /** What the client calls this pin, so a retried post is the same pin rather
   *  than a second one. See `Pin.clientRef`. */
  clientRef?: string;
  /** The depth the learner asked for. See `Pin.requestedRegister`. */
  requestedRegister?: DepthRegister | null;
  /** How long they asked for. See `Pin.requestedMinutes`. */
  requestedMinutes?: number | null;
}

/** The learner's reason for saving a pin: trim its outside, alter nothing inside. */
const pinNoteFrom = (body: Record<string, unknown>): string | null => {
  const raw = body.note;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new BadRequest('note must be a string or null');
  if (stripInvisible(raw) !== raw) {
    throw new BadRequest('note must not contain invisible control characters');
  }
  const note = raw.trim();
  if (!note) return null;
  if (Array.from(note).length > 1_000) {
    throw new BadRequest('note must contain at most 1,000 characters');
  }
  return note;
};

/**
 * A capture the rest of the service can rely on.
 *
 * Only the envelope fields something downstream actually dereferences are
 * required — `fallbackLabel` reads `headingPath` and `pageTitle`, and a pin with
 * no url is not a pin. Validating more than that would be inventing a contract
 * the extension has never had to meet; validating less leaves the 500 where it
 * was.
 */
const pinRequestFrom = (body: Record<string, unknown>): PinRequest => {
  const type = requireOneOf(body, 'type', ['interest', 'struggle'] as const);
  const e = body['envelope'];
  if (e === null || typeof e !== 'object' || Array.isArray(e)) {
    throw new BadRequest('envelope is required, as a JSON object');
  }
  const env = e as Record<string, unknown>;
  // The return value, not merely the check: `requireString` is the sanitiser as
  // well as the guard, and a url admitted but stored raw keeps the bidi
  // overrides and zero-width spaces every other admitted string has had removed.
  const url = requireString(env, 'url');
  if (typeof env['pageTitle'] !== 'string') throw new BadRequest('envelope.pageTitle is required');
  if (!Array.isArray(env['headingPath'])) throw new BadRequest('envelope.headingPath is required, as an array');
  let label: string | undefined;
  if (body.label !== undefined && body.label !== null) {
    if (typeof body.label !== 'string') throw new BadRequest('label must be a string');
    if (stripInvisible(body.label) !== body.label) {
      throw new BadRequest('label must not contain invisible control characters');
    }
    label = body.label.replace(/\s+/g, ' ').trim();
    if (!label) throw new BadRequest('label must not be empty');
    if (Array.from(label).length > 120) {
      throw new BadRequest('label must contain at most 120 characters');
    }
  }
  return {
    type,
    // `parts` is required by the domain type and two agents dereference it
    // without a guard. Defaulting it here rather than demanding it keeps every
    // client that already works working, and means no pin can be stored in a
    // shape that crashes the cluster stage this run.
    envelope: {
      ...env, url, parts: Array.isArray(env['parts']) ? env['parts'] : [],
    } as unknown as Pin['envelope'],
    ...(label ? { label } : {}),
    note: pinNoteFrom(body),
    ...(typeof body['capturedAt'] === 'string' ? { capturedAt: body['capturedAt'] } : {}),
    // The client's own name for this pin, where it gave one. See `Pin.clientRef`.
    ...(typeof body['clientRef'] === 'string' && body['clientRef']
      ? { clientRef: body['clientRef'] } : {}),
    // A depth this build does not recognise is no request at all: a register
    // the code cannot honour must not be stored as though it could.
    ...(REGISTER_ORDER.includes(body['requestedRegister'] as DepthRegister)
      ? { requestedRegister: body['requestedRegister'] as DepthRegister } : {}),
    ...(typeof body['requestedMinutes'] === 'number' && Number.isFinite(body['requestedMinutes'])
      ? { requestedMinutes: body['requestedMinutes'] } : {}),
  };
};

/**
 * The pin a confirmed suggestion becomes (, step 4: "It becomes a struggle
 * pin").
 *
 * Everything here comes from what the detector actually saw. It is a thinner
 * envelope than a hand-made pin — there is no surrounding block group, because
 * the passage *is* the block the learner kept coming back to — and that is
 * stated by carrying the passage in all three text fields rather than by
 * padding it with page text nobody looked at.
 */
const envelopeFromSuggestion = (s: Suggestion): Pin['envelope'] => ({
  selection: s.passage,
  parts: [{ role: 'passage', text: s.passage }],
  surroundingText: s.passage,
  // `?? []` and `?? ''` because suggestions written before these fields existed
  // are still in the store, and the pin they become must still be labellable.
  headingPath: s.headingPath ?? [],
  pageTitle: s.pageTitle ?? '',
  url: s.url,
  canonicalUrl: null,
  siteName: null,
  contentLanguage: null,
  media: null,
});

/**
 * The fields of `LearnerPrefs` a client may set, and what each one has to be.
 *
 * Only fields that are present are validated and returned, because this is a
 * patch. A field that is present and wrong is a 400 rather than a silent drop:
 * the panel is the only writer, and a panel sending the wrong type is a bug
 * somebody needs to see, not a preference to be quietly ignored.
 *
 * `rejectedOrigins` is deliberately absent from this list. It is the
 * counter, it is written by the reject endpoint from what the learner actually
 * did, and a client that can set it directly can quiet the detector on any site
 * without a rejection ever having happened.
 */
const validPrefsPatch = (body: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  const take = (
    field: string, ok: (v: unknown) => boolean, what: string,
    clean?: (v: unknown) => unknown,
  ): void => {
    if (!(field in body)) return;
    if (!ok(body[field])) throw new BadRequest(`${field} must be ${what}`);
    out[field] = clean ? clean(body[field]) : body[field];
  };
  take('targetMinutes', (v) => v === 5 || v === 15 || v === 45, 'one of: 5, 15, 45');
  take('availableMinutes', (v) => [1, 3, 5].includes(Number(v)),
    'one of: 1, 3, 5', (v) => Number(v));
  // `!!v.trim()` admitted a language made of bidi overrides and zero-width
  // spaces, which then rendered as blank on the control whose whole job is to
  // say what language the panel speaks. Same pair as every other admitted
  // string: `rendersEmpty` decides, `stripInvisible` is what gets stored.
  take('interfaceLanguage', (v) => typeof v === 'string' && !rendersEmpty(v),
    'a non-empty string', (v) => stripInvisible(v as string));
  take('timeZone', (v) => typeof v === 'string' && isZone(v),
    'an IANA time zone');
  take('pausedUntil',
    (v) => v === null || (typeof v === 'string' && Number.isFinite(Date.parse(v))),
    'null, or a timestamp that parses');
  take('excludedDomains',
    (v) => Array.isArray(v) && v.every((d) => typeof d === 'string'),
    'an array of strings');
  // The manual-processing contract. Null means never automatic, which is the default and the only
  // state in which nothing is ever spent unasked. A number is a count of
  // things waiting; `autoThreshold` is what stops one pin counting as a batch,
  // and it is applied on the way OUT rather than here, so a learner who set 25
  // and later lowers the floor keeps the number they chose.
  take('autoAfter',
    (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0),
    'null, or a positive number of things to wait for');
  take('prospect', (v) => typeof v === 'boolean', 'true or false');
  take('interview',
    (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
      && Object.values(v as object).every((x) => typeof x === 'string'),
    'an object of strings');
  // When this learner's sessions get built. Validated by the domain rather
  // than here, so the one description of a legal schedule is the one the
  // runner reads it back with. A `daily` whose hour or zone this build cannot
  // honour is refused rather than quietly stored as on-demand: a learner who
  // set a time and got none would have no way to tell.
  take('schedule',
    (v) => {
      if (v === null || typeof v !== 'object') return false;
      const kind = (v as Record<string, unknown>)['kind'];
      if (kind === 'on-demand') return true;
      return kind === 'daily' && scheduleFrom(v).kind === 'daily';
    },
    'either { kind: "on-demand" } or { kind: "daily", hour: 0-23, timeZone: an IANA zone }',
    (v) => scheduleFrom(v));
  return out;
};

/**
 * The site a suggestion came from, for the  count. Null if unparseable.
 *
 * `new URL(x).origin` answers the *string* "null" for every opaque origin — a
 * `data:` url, a `javascript:` url, a blob from a sandboxed frame — so all of
 * them shared one bucket named "null".  quiets at two rejections, which
 * made one rejection on one unrelated page plus one on another enough to quiet
 * the detector on both, and on every other page with no real origin.
 *
 * An opaque origin is not a site, so there is no site to count. The closest
 * stable thing is the url itself, and it is counted under a prefix nothing with
 * a real origin can produce: an origin is `scheme://host[:port]` and a scheme
 * cannot contain a colon. Quieting stays per-page rather than becoming
 * per-nothing, and a real origin is unchanged, byte for byte.
 */
const originOf = (url: string): string | null => {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  return parsed.origin === 'null' ? `url:${parsed.href}` : parsed.origin;
};

const DEPTH_GUIDE: Record<DepthRegister, string> = {
  'from-nothing': 'Assume no prior knowledge. Lead with a concrete analogy or example before any terminology. Define every term you use.',
  'building': 'Assume the basics. Lead with a worked example that extends what they already have. Do not re-explain fundamentals.',
  'fluent': 'Assume fluency. One dense paragraph. No analogies, no scaffolding, no recap. Go straight to the nuance or the edge case.',
};

/** One source, as  tap needs it: whose page it was, what it was called,
 *  where it is, and when it entered the learner's world. */
interface ResolvedSource {
  readonly id: string;
  readonly origin: 'user-pin' | 'agent-sourced';
  readonly title: string | null;
  readonly url: string | null;
  readonly at: string | null;
  /**
   * seconds into the video this pin was made at, or null.
   *
   * The seconds and not the words. "at 12:34" is copy, and copy is the panel's
   * business; whether there was a moment at all is a fact about the pin. The
   * `url` beside it already carries the timestamp where the site has a
   * convention for one, so a learner can both see where they were and go there.
   */
  readonly moment: number | null;
  /** which page of the PDF, when the pin came off one. */
  readonly page: number | null;
  /**
   * Did Virgil's own fetch of this page come back usable — the Forager's
   * `confidence`, flattened. Null where nothing was tried.
   *
   * Read by the §5d hand-off and by nothing else: a page Virgil met a sign-in
   * wall on is a page Gemini Notebook's fetcher is likely to meet the same wall
   * on, and saying so beside the paste is the one useful thing this seam can do
   * for its partner without an API it does not have.
   */
  readonly readByVirgil: boolean | null;
  /** The learner-selected evidence behind a pin, when capture supplied it. */
  readonly excerpt: string | null;
  readonly availability: Pin['sourceAvailability'] | null;
}

/**
 * A section's source ids, turned back into the pages behind them.
 *
 * Two kinds of id exist, and both are minted by `offeredSourceIdsFor`:
 * `<pinId>:origin` is the page the learner pinned, and an enrichment
 * reference's own id is something the Forager went and found. The index is
 * built over the whole board rather than over this topic's pins, exactly as the
 * Composer's resolver checks against the whole brief — an id borrowed from a
 * neighbouring section still resolves to a real page, and refusing it would
 * report a dead reference that is not dead.
 *
 * An id that matches nothing is counted and dropped. There is no nearest match
 * and no guess: on the surface whose entire job is being checkable, a
 * plausible-looking wrong source is worse than an admitted missing one.
 */
function resolveSources(
  ids: readonly string[], pins: readonly Pin[],
): { sources: ResolvedSource[]; unresolved: number } {
  const index = new Map<string, ResolvedSource>();
  for (const p of pins) {
    const moment = p.envelope.videoMoment ?? null;
    const pdfPage = p.envelope.pdfPage ?? null;
    const address = p.envelope.canonicalUrl ?? p.envelope.url ?? null;
    // Both deep links are built in `core/`, and both answer null wherever the
    // convention is not real. A pin is one or the other or neither, so the
    // order between them never decides anything.
    const deep = address ? momentHref(address, moment) ?? pdfPageHref(address, pdfPage) : null;
    index.set(`${p.id}:origin`, {
      id: `${p.id}:origin`,
      origin: 'user-pin',
      title: p.envelope.pageTitle || null,
      url: deep ?? address,
      at: p.capturedAt,
      // Stated even where they are null, like `media` on the envelope: a field
      // that appears only when something happened is one every reader guesses at.
      moment: moment?.timestampSeconds ?? null,
      page: pdfPage,
      // What happened when the Forager fetched this page from outside the
      // learner's browser, which is the position Gemini Notebook's fetcher is
      // in. `null` where nothing was tried: silence is not evidence of a wall.
      readByVirgil: p.enrichment ? p.enrichment.confidence === 'full' : null,
      excerpt: (p.envelope.selection ?? p.envelope.surroundingText)
        .replace(/\s+/g, ' ').trim().slice(0, 500) || null,
      availability: p.sourceAvailability ?? null,
    });
    for (const r of p.enrichment?.references ?? []) {
      // The Forager commonly returns the pin's own `<pin>:origin` reference.
      // That is attribution, not a replacement record. Overwriting the index
      // here discarded the learner's selected excerpt, video moment, PDF page
      // and fetch receipt immediately after we had resolved them from capture.
      if (r.origin === 'user-pin' && index.has(r.id)) continue;
      // A reference the Forager attributed to the pin itself stays a user pin:
      // the record carries its own origin, and this reads it rather than
      // assuming that anything enrichment touched is the agent's.
      index.set(r.id, {
        id: r.id, origin: r.origin, title: r.title, url: r.url, at: r.retrievedAt,
        // A reference is a page the Forager fetched. It has no playhead and no
        // reading position.
        moment: null,
        page: null,
        // And it is a page the Forager found rather than one it re-fetched, so
        // there is no reading of its own to report.
        readByVirgil: null,
        excerpt: null,
        availability: null,
      });
    }
  }

  const sources: ResolvedSource[] = [];
  let unresolved = 0;
  for (const id of Array.isArray(ids) ? ids : []) {
    const found = typeof id === 'string' ? index.get(id) : undefined;
    if (found) sources.push(found); else unresolved++;
  }
  return { sources, unresolved };
}

/**
 * The evidence a five-minute recall answer is checked against.
 *
 * Selection first, then the captured surrounding passage, with exact repeats
 * removed. Learner notes are included because remembering why they kept a page
 * is legitimate recall evidence; page chrome and enrichment prose are not.
 * Bounded before it reaches the Tutor so a topic with a long capture history
 * cannot turn one foreground check into a context-window event.
 */
function burstEvidence(topic: Topic, pins: readonly Pin[]): string {
  const ids = new Set(topic.pinIds);
  const seen = new Set<string>();
  const lines: string[] = [];
  if (topic.summary?.trim()) lines.push(topic.summary.trim());
  for (const pin of pins) {
    if (!ids.has(pin.id)) continue;
    for (const raw of [pin.envelope.selection, pin.envelope.surroundingText, pin.note]) {
      const line = raw?.replace(/\s+/g, ' ').trim();
      if (!line || seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  }
  return (lines.join('\n') || topic.label).slice(0, 5_000);
}

/**
 * How many upcoming lessons the rail shows.
 *
 * Capped for the same reason the flagged list is (§5): a column long enough to
 * scroll is a pile, and the pile is the thing this product refuses to be. Four
 * is enough to say "there is more after tonight" without becoming a backlog
 * beside the one thing to do.
 */
export const UPCOMING_ROWS = 4;

/** progress is tracked per section so a resume does not discard the
 *  first half of a session the learner already did. */
function markCompleted(
  session: Session, topicId: string, completionEvidence: 'answer' | 'known',
): Session {
  const sections = session.sections.map((s) => s.topicId === topicId
    ? { ...s, completed: true, completionEvidence }
    : s);
  const next = sections.findIndex((s) => !s.completed);
  return { ...session, sections, currentSectionIndex: next < 0 ? sections.length : next };
}

/**
 * The session with one section taken out of it — the learner-lineup contract’s X.
 *
 * Removal rather than completion, and the difference is the whole point: a
 * completed section is something the learner did and stays on screen, and this
 * is something they said they did not want tonight. `markCompleted` would leave
 * it in the lineup with a tick on it, which is the product arguing.
 *
 * The resume point is recomputed rather than adjusted, for the same reason
 * `markCompleted` recomputes it: an index is a position in a list, and a list
 * that just got shorter has no use for the position it had before.
 */
function removeSection(session: Session, topicId: string): Session {
  const sections = session.sections.filter((s) => s.topicId !== topicId);
  const next = sections.findIndex((s) => !s.completed);
  return {
    ...session,
    sections,
    currentSectionIndex: next < 0 ? sections.length : next,
    // Summed over every section that is left, completed or not, because that
    // is what the field has meant since the Composer wrote it. The panel's own
    // "minutes left" is computed from the flags where it is needed; a second
    // meaning for one field is how two screens come to disagree about an hour.
    estimatedMinutes: Math.round(
      sections.reduce((a, s) => a + (Number(s.estimatedMinutes) || 0), 0) * 10) / 10,
  };
}

/**
 * The session's sections in the order the learner put them — the learner-lineup contract’s
 * drag-and-drop, and the move-up/move-down controls beside it.
 *
 * The request names the whole order rather than one move, because one endpoint
 * has to serve both gestures and a drop is not expressible as a sequence of
 * swaps the service could reconstruct. What it is NOT allowed to do is change
 * the set: an id the session does not have is ignored, and anything the request
 * left out keeps its relative position at the end. A reorder that could drop a
 * section would be a delete wearing a sort's clothes, and the delete has its
 * own control and its own signal.
 */
function reorderSections(session: Session, topicIds: readonly string[]): Session {
  const wanted: string[] = [];
  for (const id of topicIds) {
    if (typeof id !== 'string' || wanted.includes(id)) continue;
    if (session.sections.some((s) => s.topicId === id)) wanted.push(id);
  }
  const byId = new Map(session.sections.map((s) => [s.topicId, s]));
  const sections = [
    ...wanted.map((id) => byId.get(id)!),
    ...session.sections.filter((s) => !wanted.includes(s.topicId)),
  ];
  const next = sections.findIndex((s) => !s.completed);
  return { ...session, sections, currentSectionIndex: next < 0 ? sections.length : next };
}

/**
 * The whole HTTP surface, bound to one set of capabilities and nothing else.
 *
 * Returns a handler. It does not create a server and it does not listen — the
 * caller decides that, which is what makes both `service.js` and a test able to
 * use it.
 */
export interface AppOptions {
  /** The full page served by this deployment, or absent for an API-only test. */
  readonly web?: BoardWebOptions | null;
  /** Optional shared-secret request boundary. */
  readonly secret?: string | null;
  /** Verified identity boundary for a hosted multi-learner service. */
  readonly identity?: Identity | null;
  /** Opens the board selected by the verified identity, never request input. */
  readonly forLearner?: ((learner: Learner) => Promise<Deps>) | null;
  /** Verified owner carried only into that learner's inner router. */
  readonly learner?: Learner | null;
  /** Exact board selected by a verified, expiring local connector token. */
  readonly connectorAuthenticated?: boolean;
  /** Operator-owned admission and abuse boundary for a hosted identity door. */
  readonly access?: LearnerAccessPolicy | null;
  /** Service-owned model capability receipt. Credentials never cross it. */
  readonly models?: ModelServiceOptions;
  /** Optional destination for learner-owned notebook documents. */
  readonly notebook?: NotebookExport | null;
  /** Optional foreground Google Drive setup capability. */
  readonly drive?: DriveServiceOptions | null;
  /** Account named by the hosted background Drive grant. */
  readonly hostedNotebookDriveAccount?: string | null;
  /** Public URL of the live Google Notebook fed by the stable Drive sources. */
  readonly hostedNotebookUrl?: string | null;
  /** Maximum queued items one run may process. */
  readonly workCap?: number | null;
  /**
   * Durable hosted batch boundary. Absent locally, where the service process is
   * the worker; present in the shipped multi-user Cloud Run service, where a
   * finished HTTP request cannot own background CPU.
   */
  readonly hostedRun?: HostedRunLauncher | null;
  /** Receives the metered single-board model lane used for optional warm-up. */
  readonly onWarmupLane?: (llm: Llm) => void;
}

/**
 * What the service needs to run one Drive connection, and no more than that.
 *
 * The credential store and the token cache are built in a composition root, as
 * every adapter is. `consent` is a factory rather than a class so that a test
 * can point the same flow at an in-process fake Google without this file
 * knowing a test exists.
 */
export interface DriveServiceOptions {
  readonly credential: LocalDriveCredential;
  /** Cleared whenever the grant changes, so a reconnect cannot keep using the
   *  access token the previous account was issued. */
  readonly tokens: Pick<DriveTokens, 'forget'>;
  readonly consent: (client: DriveClientCredential) => LoopbackConsent;
  /** The folder the documents live in, once there is one. Read from the id map,
   *  never from a stored URL: a stored URL is a second thing that goes stale. */
  readonly folderLink: () => Promise<string | null>;
}
export interface ModelServiceOptions {
  readonly defaultMode?: ModelMode; readonly cloudDeepModelId?: string;
  /** The cloud connection has a free arm, so budget gating defers to it. */
  readonly freeArm?: boolean;
  readonly cloudReady?: boolean;
  /** Service-owned credential state. Its value is never part of a receipt. */
  readonly cloudCredential?: CloudCredentialControl;
  /** ListModels through the already-constructed dynamic Gemini adapter. */
  readonly checkCloud?: (() => Promise<{ readonly models: readonly string[] }>) | undefined;
  readonly localEndpoint?: string;
  readonly cliEndpoint?: string;
  /** Service-owned bridge credential. It is used for probes but never returned. */
  readonly cliToken?: string;
  readonly allowRemoteEndpoints?: boolean;
  /** A hosted service may not be pointed back into its own private network. */
  readonly hosted?: boolean;
  /** Hard deployment ceiling that learner settings cannot raise or clear. */
  readonly operatorLimit?: number | null;
  /** Set per request from the service's existing secret/identity boundary. */
  readonly setupAuthenticated?: boolean;
  /** Set only by the runtime when the service is bound to 127.0.0.1. The
   * service-hosted Settings page is then the trusted setup boundary: remote
   * pages are held out by CORS and the service cannot be reached off-device. */
  readonly setupTrustedLocal?: boolean;
}

type ModelReadiness = 'ready' | 'needs-setup' | 'unreachable';

interface ModelChoiceReceipt {
  readonly label: string;
  readonly enabled: boolean;
  readonly recommended: boolean;
  readonly readiness: ModelReadiness;
  readonly detail: string;
  readonly endpoint?: string;
  /**
   * What a call on this connection would go to, per workload route, and how
   * much of a paste that model can read.
   *
   * Only `deep` today, because `deep` is the route the Check screen uses and a
   * route nobody is warning about is a number nobody can check. Keyed by route
   * rather than flattened so the second one costs a line here and nothing at
   * the panel.
   */
  readonly models: { readonly deep: ModelInputWindow };
  readonly setup: {
    readonly editable: boolean;
    readonly managed: boolean;
    readonly credential: 'configured' | 'missing' | 'not-required';
    readonly check: 'available';
    readonly connector?: 'supported';
  };
}

const tenantMemberContext = (opts: AppOptions): TenantMemberRouteContext => ({
  access: opts.access ?? null,
  learner: opts.learner ?? null,
  readBody,
  reply: json,
  badRequest: (message) => { throw new BadRequest(message); },
  forbidden: (message) => { throw new Forbidden(message); },
});

/**
 * What a paste is allowed to be, in one place the panel can read.
 *
 * The Check screen has to warn a learner BEFORE they press the button, and the
 * numbers that decide it live in `core/` where they belong — one of them
 * (`MAX_CRITERION`) had to be exported to get here, which is the point: a
 * second copy of "12,000" in the panel is a second copy that drifts, and the
 * first anybody would hear of the drift is a learner told their work fits when
 * the marker is about to cut it.
 *
 * Characters rather than tokens, deliberately. A token count is a property of
 * whichever model the route is pointed at; these are the product's own caps and
 * they apply on every connection.
 */
const CHECK_LIMITS = {
  markWorkChars: MAX_WORK_CHARS,
  reviewDraftChars: MAX_DRAFT_CHARS,
  markWorkMinChars: MIN_WORK_CHARS,
  reviewDraftMinChars: MIN_DRAFT_CHARS,
  contextChars: MAX_CONTEXT_CHARS,
  rubricCriteria: MAX_CRITERIA,
  rubricCriterionChars: MAX_CRITERION,
} as const;

const endpointReachable = async (
  endpoint: string, path: string, headers?: Readonly<Record<string, string>>,
): Promise<boolean> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 700);
  try {
    const response = await fetch(`${endpoint}${path}`, {
      signal: ctrl.signal,
      ...(headers ? { headers } : {}),
    });
    return response.ok;
  } catch { return false; }
  finally { clearTimeout(timer); }
};

async function modelReceipt(store: Deps['store'], options: ModelServiceOptions = {}) {
  const prefs = await store.getPrefs();
  const fallback = options.defaultMode ?? DEFAULT_MODEL_MODE;
  const enabled = effectiveModelProviders(prefs, fallback);
  const routes = effectiveModelRoutes(prefs, fallback);
  const allowRemote = options.allowRemoteEndpoints ?? false;
  const localEndpoint = modelEndpoint(
    prefs.localModelEndpoint,
    options.localEndpoint ?? DEFAULT_LOCAL_MODEL_ENDPOINT,
    allowRemote,
  );
  const cliEndpoint = modelEndpoint(
    undefined,
    options.cliEndpoint ?? DEFAULT_CLI_MODEL_ENDPOINT,
    true,
  );
  const cliToken = options.cliToken?.trim() ?? '';
  const connector = options.hosted && isLocalConnectorStore(store) ? store : null;
  const connectorSupported = Boolean(connector);
  const [localReady, localPaired, cliReady] = await Promise.all([
    connector
      ? connector.localConnectorReady(new Date().toISOString())
      : !options.hosted && endpointReachable(localEndpoint, '/api/tags'),
    connector ? connector.localConnectorPaired() : false,
    !options.hosted && cliToken.length >= 16 && endpointReachable(
      cliEndpoint,
      '/health',
      { authorization: `Bearer ${cliToken}` },
    ),
  ]);
  const cloudConfigured = options.cloudCredential?.configured() ?? Boolean(options.cloudReady);
  const setupAllowed = Boolean(options.setupAuthenticated || options.setupTrustedLocal);
  const cloudEditable = Boolean(options.cloudCredential?.editable && setupAllowed);
  const providers: Record<ModelMode, ModelChoiceReceipt> = {
    cloud: {
      label: 'Cloud/API', enabled: enabled.cloud, recommended: true,
      readiness: cloudConfigured ? 'ready' : 'needs-setup',
      detail: cloudConfigured
        ? 'This service has Google Gemini credentials. No model call was made to check them.'
        : 'Google credentials are still needed. Non-model parts of Virgil continue to work.',
      models: { deep: options.cloudDeepModelId ? modelInputWindowForId(options.cloudDeepModelId) : modelInputWindow('cloud', 'deep') },
      setup: {
        editable: cloudEditable,
        managed: options.cloudCredential ? !options.cloudCredential.editable : true,
        credential: cloudConfigured ? 'configured' : 'missing',
        check: 'available',
      },
    },
    local: {
      label: 'Local', enabled: enabled.local, recommended: false,
      readiness: localReady ? 'ready' : options.hosted ? 'needs-setup' : 'unreachable',
      detail: options.hosted
        ? localReady
          ? 'Your paired computer is online and ready to run Local model work.'
          : connectorSupported && localPaired
            ? 'This computer is connected. Start its connector whenever you want Virgil to use Local models.'
            : connectorSupported
              ? 'Connect this computer once, then start its connector whenever you want Virgil to use Local models.'
            : 'This deployment has no Local connector store.'
        : localReady ? 'The self-hosted model endpoint answered. No model work was run.' : 'The self-hosted model endpoint did not answer.',
      ...(!options.hosted ? { endpoint: localEndpoint } : {}),
      models: { deep: modelInputWindow('local', 'deep') },
      setup: {
        editable: !options.hosted || connectorSupported, managed: false,
        credential: connectorSupported ? (localPaired ? 'configured' : 'missing') : 'not-required',
        check: 'available',
        ...(connectorSupported ? { connector: 'supported' as const, paired: localPaired } : {}),
      },
    },
    cli: {
      label: 'Agent CLI', enabled: enabled.cli, recommended: false,
      readiness: cliReady ? 'ready' : options.hosted || cliToken.length < 16 ? 'needs-setup' : 'unreachable',
      detail: options.hosted
        ? 'CLI endpoints are available only from a self-hosted Virgil service.'
        : cliToken.length < 16
          ? 'Start an authenticated Agent CLI bridge to use this connection.'
        : cliReady
          ? 'The Agent CLI endpoint answered. No model work was run.'
          : 'The Agent CLI endpoint did not answer.',
      endpoint: cliEndpoint,
      models: { deep: modelInputWindow('cli', 'deep') },
      setup: {
        editable: false, managed: true,
        credential: cliToken.length >= 16 ? 'configured' : 'missing', check: 'available',
      },
    },
  };
  // Additive, and the panel already fetches this on the way into Settings and
  // into Check: one request tells it what the product will accept and what the
  // route it is pointed at can read.
  return { schemaVersion: MODEL_CONFIG_SCHEMA_VERSION, providers, routes, limits: CHECK_LIMITS };
}

type ModelCheckStatus = 'ready' | 'missing-credential' | 'unreachable' | 'invalid-contract' | 'refused';
interface ModelConnectionCheckReceipt {
  readonly provider: ModelMode;
  readonly ok: boolean;
  readonly status: ModelCheckStatus;
  readonly detail: string;
}

const connectionCheck = (
  provider: ModelMode, ok: boolean, status: ModelCheckStatus, detail: string,
): ModelConnectionCheckReceipt => ({ provider, ok, status, detail });

async function checkedJson(
  endpoint: string, path: string, headers?: Readonly<Record<string, string>>,
): Promise<{ readonly status: number; readonly ok: boolean; readonly body: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2_000);
  try {
    const response = await fetch(`${endpoint}${path}`, {
      signal: ctrl.signal, ...(headers ? { headers } : {}),
    });
    if (!response.body) return { status: response.status, ok: response.ok, body: null };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 262_144) {
        await reader.cancel();
        throw new Error('connection receipt exceeded 256 KiB');
      }
      chunks.push(part.value);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* invalid-contract below */ }
    return { status: response.status, ok: response.ok, body };
  } finally { clearTimeout(timer); }
}

async function checkModelConnection(
  mode: ModelMode, store: Deps['store'], options: ModelServiceOptions,
): Promise<ModelConnectionCheckReceipt> {
  if (mode === 'cloud') {
    const configured = options.cloudCredential?.configured() ?? Boolean(options.cloudReady);
    if (!configured) {
      return connectionCheck('cloud', false, 'missing-credential', 'Google Gemini credentials are missing.');
    }
    if (!options.checkCloud) {
      return connectionCheck('cloud', false, 'invalid-contract', 'This service cannot validate its Cloud/API connection.');
    }
    try {
      const result = await options.checkCloud();
      return connectionCheck('cloud', true, 'ready',
        `Google accepted the credential and listed ${result.models.length} model(s); no generation call was made.`);
    } catch (error) {
      const status = Number((error as { status?: unknown } | null)?.status);
      return Number.isFinite(status) && status >= 400 && status < 500
        ? connectionCheck('cloud', false, 'refused', 'Google refused the configured credential or model access.')
        : connectionCheck('cloud', false, 'unreachable', 'Google model access could not be reached.');
    }
  }

  if (options.hosted && mode === 'local' && isLocalConnectorStore(store)) {
    const ready = await store.localConnectorReady(new Date().toISOString());
    return ready
      ? connectionCheck('local', true, 'ready', 'The paired local connector is polling; no model work was run.')
      : connectionCheck('local', false, 'unreachable', 'Start or re-pair the local connector on your computer.');
  }
  if (options.hosted) {
    return connectionCheck(mode, false, 'refused', 'Agent CLI is self-hosted only.');
  }
  const prefs = await store.getPrefs();
  if (mode === 'local') {
    let endpoint: string;
    try {
      endpoint = modelEndpoint(
        prefs.localModelEndpoint,
        options.localEndpoint ?? DEFAULT_LOCAL_MODEL_ENDPOINT,
        options.allowRemoteEndpoints ?? false,
      );
    } catch {
      return connectionCheck('local', false, 'refused', 'The Local endpoint is not permitted by this service.');
    }
    try {
      const response = await checkedJson(endpoint, '/api/tags');
      return response.ok
        ? connectionCheck('local', true, 'ready', 'The Local endpoint answered; no model work was run.')
        : connectionCheck('local', false, 'refused', `The Local endpoint answered with HTTP ${response.status}.`);
    } catch {
      return connectionCheck('local', false, 'unreachable', 'The Local endpoint could not be reached.');
    }
  }

  const token = options.cliToken?.trim() ?? '';
  if (token.length < 16) {
    return connectionCheck('cli', false, 'missing-credential', 'The service operator has not configured an Agent CLI token.');
  }
  const endpoint = modelEndpoint(undefined, options.cliEndpoint ?? DEFAULT_CLI_MODEL_ENDPOINT, true);
  try {
    const response = await checkedJson(endpoint, '/v1/capabilities', { authorization: `Bearer ${token}` });
    if (!response.ok) {
      return connectionCheck('cli', false, 'refused', `The Agent CLI endpoint answered with HTTP ${response.status}.`);
    }
    const body = response.body as Record<string, unknown> | null;
    const operations = body && typeof body.operations === 'object' && body.operations !== null
      ? body.operations as Record<string, unknown> : null;
    if (body?.protocol !== 'virgil-agent-endpoint' || body.version !== 1
      || !operations || typeof operations.complete !== 'object' || operations.complete === null) {
      return connectionCheck('cli', false, 'invalid-contract',
        'The Agent CLI endpoint answered but did not present Virgil model-worker protocol v1.');
    }
    return connectionCheck('cli', true, 'ready',
      'The authenticated Agent CLI endpoint presented Virgil model-worker protocol v1; no model work was run.');
  } catch {
    return connectionCheck('cli', false, 'unreachable', 'The Agent CLI endpoint could not be reached.');
  }
}

/**
 * How many learners' capabilities are held open at once.
 *
 * Bounded because the alternative is a map keyed on a uid that grows for the
 * life of the process, which on a public service is a memory leak with an
 * attacker-controlled key. Oldest out first: a board is cheap to reopen and
 * the store behind it is the authority either way.
 */
const OPEN_BOARDS = 64;

/**
 * The service, with a learner in front of it when there is one.
 *
 * `deps` is still the single-board service and still the default. Multi-tenancy
 * is a thing a composition root turns ON by supplying `identity` and
 * `forLearner`, which is why 2,500 tests that call `createApp(deps)` are
 * unchanged by it.
 */
export function createApp(deps: Deps, opts: AppOptions = {}): RequestListener {
  const identity = opts.identity ?? null;
  const forLearner = opts.forLearner ?? null;
  let dataApp: RequestListener;
  if (!identity || !forLearner) {
    dataApp = routes(deps, opts);
  } else {
    const open = new Map<string, Promise<RequestListener>>();
    const connectorOpen = new Map<string, Promise<{ deps: Deps; app: RequestListener }>>();
    dataApp = async (req, res) => {
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (req.method === 'GET' && new URL(req.url ?? '/', 'http://localhost').pathname === '/health') {
      return json(res, 200, { ok: true, compatibility: compatibilityReceipt() });
    }
    const connectorHeader = req.headers[LOCAL_CONNECTOR_HEADER];
    const connectorToken = typeof connectorHeader === 'string' ? connectorHeader : '';
    if (connectorToken) {
      const learnerId = localConnectorLearnerId(connectorToken);
      if (!learnerId) return json(res, 401, { error: 'local connector pairing is invalid or disconnected' });
      let opening = connectorOpen.get(learnerId);
      if (!opening) {
        const learner = { id: learnerId, email: null };
        opening = forLearner(learner).then((boardDeps) => ({
          deps: boardDeps,
          app: routes(boardDeps, { ...opts, secret: null, learner, connectorAuthenticated: true }),
        }));
        if (connectorOpen.size >= OPEN_BOARDS) connectorOpen.delete(connectorOpen.keys().next().value!);
        connectorOpen.set(learnerId, opening);
      }
      const connected = await opening;
      if (!isLocalConnectorStore(connected.deps.store)
        || !await connected.deps.store.verifyLocalConnector(localConnectorTokenHash(connectorToken))) {
        return json(res, 401, { error: 'local connector pairing is invalid or disconnected' });
      }
      return connected.app(req, res);
    } const header = req.headers.authorization ?? '';
    const token = /^bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? '';
    let learner: Learner | null = null;
    try { learner = token ? await identity.verify(token) : null; } catch { learner = null; }
    if (!learner) return json(res, 401, { error: 'sign in to reach your board' });
    if (opts.access && !opts.access.allows(learner)) {
      return json(res, 403, { error: 'this testing build is limited to approved accounts' });
    }
    const admission = opts.access?.take(learner.id);
    if (admission && !admission.allowed) {
      res.setHeader('retry-after', String(admission.retryAfter));
      return json(res, 429, { error: 'too many requests; wait before trying again' });
    }

    let opening = open.get(learner.id);
    if (!opening) {
      if (open.size >= OPEN_BOARDS) {
        const oldest = open.keys().next();
        if (!oldest.done) open.delete(oldest.value);
      }
      opening = forLearner(learner).then((boardDeps) =>
        routes(boardDeps, { ...opts, secret: null, learner }));
      open.set(learner.id, opening);
      opening.catch(() => {
        if (open.get(learner.id) === opening) open.delete(learner.id);
      });
    }
      const app = await opening;
      return app(req, res);
    };
  }

  const web = opts.web ?? null;
  if (!web) return dataApp;
  return (req, res) => serveBoardWeb(req, res, web) ? undefined : dataApp(req, res);
}

function routes(deps: Deps, opts: AppOptions = {}): RequestListener {
  const secret = opts.secret ?? null;
  const models: ModelServiceOptions = {
    ...(opts.models ?? {}),
    setupAuthenticated: secret !== null || Boolean(opts.identity),
  };
  const modelSetupAllowed = Boolean(models.setupAuthenticated || models.setupTrustedLocal);
  const BULK_INTAKE_LIMIT = 25;
  const CLASSIFICATION_PREVIEW_LIMIT = 100;
  const CLASSIFICATION_CLIENT_REF_MAX_CHARS = 180;
  const CLASSIFICATION_IDENTITY_CONTRACT = {
    exact: true,
    clientRefMaxChars: CLASSIFICATION_CLIENT_REF_MAX_CHARS,
    invisibleControls: false,
  } as const;
  /**
   * How many documents one course drop may carry.
   *
   * `BULK_INTAKE_LIMIT` above is 25 and stays 25: it is the *agent* ingress
   * lane, where an unattended caller proposes course sources and 25 drafts is
   * already more review than anybody does in a sitting. This is the learner's
   * own gesture — they have the folder, they dropped the folder — and 300 is
   * the size of a real semester. The two limits are different numbers because
   * they are different promises, not because one of them is out of date.
   *
   * 300 rather than unbounded because the request is parsed and stored inside
   * one HTTP exchange: every item is read before the first write, so the memory
   * high-water mark of this endpoint is `DROP_ITEM_LIMIT` documents at
   * `DOCUMENT_CAPS.documentBytes` each, and that is a number somebody should be
   * able to look up rather than discover.
   */
  const DROP_ITEM_LIMIT = 300;
  /** Caller-owned idempotence values are bounded but never truncated. */
  const DROP_ID_MAX_CHARS = 120;
  const DROP_CLIENT_REF_MAX_CHARS = 180;
  const DROP_IDENTITY_CONTRACT = {
    exact: true,
    dropIdMaxChars: DROP_ID_MAX_CHARS,
    clientRefMaxChars: DROP_CLIENT_REF_MAX_CHARS,
    dropIdMayContainColon: false,
    invisibleControls: false,
  } as const;
  const DROP_BASE64_CONTRACT = {
    alphabet: 'RFC 4648 standard',
    canonical: true,
    padding: 'optional',
    whitespace: false,
  } as const;
  const DROP_SOURCE_CONTRACT = {
    modes: ['text', 'contentBase64', 'url'],
    maxModesPerItem: 1,
    nullMeansAbsent: true,
    missing: 'per-item no-text receipt',
    text: 'non-empty string',
    urlProtocols: ['http', 'https'],
  } as const;
  /** The pacing the runs this service starts are held to. See `AppOptions`. */
  const workCap = opts.workCap === undefined ? DEFAULT_WORK_CAP : opts.workCap;
  const hostedRun = opts.hostedRun ?? null;
  const hostedNeedsRun = Boolean(models.hosted && opts.learner);
  /**
   * Is a night being built right now?
   *
   * One at a time, per process. Two concurrent runs on one board is the case
   * `batch-racing.test.ts` is about, and a learner pressing a button twice
   * must not be the way into it.
   */
  let building = false;
  /** The stage that has started and not yet reported completion. */
  let currentStage: string | null = null;
  /**
   * The learner-facing receipt for the run this process most recently started.
   *
   * Store data is still the authority for what the run produced. This is the
   * operational receipt: enough to survive room navigation and a page reload,
   * and deliberately free of prompts, provider bodies and exception text.
   */
  let batchActivity: {
    state: 'running' | 'finished' | 'failed';
    startedAt: string;
    finishedAt: string | null;
    currentStage: string | null;
    reports: StageReport[];
    outcome: string | null;
    outcomeReason: string | null;
    remaining: number;
    withheld: number;
    learnerCorrections: number;
    /** The night produced no observation, no statement and no proposal. */
    lean: boolean;
    failure: string | null;
    failureReason: 'model-credential' | 'model-budget' | null;
  } | null = null;

  const hostedActive = (receipt: HostedProcessingReceipt | null | undefined): boolean =>
    Boolean(receipt && ['launching', 'queued', 'running'].includes(receipt.state)
      && Date.parse(receipt.expiresAt) > deps.clock.now().getTime());

  const writeHostedReceipt = async (
    receipt: HostedProcessingReceipt,
    expected: HostedProcessingReceipt | null,
  ): Promise<HostedProcessingReceipt> => {
    const wrote = await deps.store.compareAndSetHostedProcessing(
      expected ? hostedProcessingVersion(expected) : null,
      receipt,
    );
    if (!wrote) throw new Error('hosted processing receipt changed before this write');
    return receipt;
  };

  /**
   * Reconcile only the lease. The worker writes running/finished truth to this
   * same board; the launch-only service identity therefore needs no broad Cloud
   * Run viewer role. A worker that dies before its terminal write remains
   * single-flight until the Job's 30-minute ceiling has passed.
   */
  const reconcileHostedReceipt = async (
    original?: HostedProcessingReceipt | null,
  ): Promise<HostedProcessingReceipt | null> => {
    if (!hostedRun) return null;
    const receipt = original === undefined
      ? (await deps.store.getPrefs()).hostedProcessing ?? null : original;
    if (!receipt || !['launching', 'queued', 'running'].includes(receipt.state)) return receipt;
    const now = deps.clock.now();
    const expired = Date.parse(receipt.expiresAt) <= now.getTime();
    if (!expired) return receipt;
    const failed = { ...receipt, state: 'failed' as const, checkedAt: now.toISOString() };
    const wrote = await deps.store.compareAndSetHostedProcessing(
      hostedProcessingVersion(receipt), failed,
    );
    return wrote ? failed : (await deps.store.getPrefs()).hostedProcessing ?? null;
  };

  type HostedStart =
    | { readonly kind: 'not-due' }
    | { readonly kind: 'already'; readonly receipt: HostedProcessingReceipt }
    | { readonly kind: 'queued'; readonly receipt: HostedProcessingReceipt }
    | { readonly kind: 'failed'; readonly receipt: HostedProcessingReceipt };

  /** Decide and durably dispatch one hosted run. No model work happens here. */
  const startHostedRun = async (asked: boolean): Promise<HostedStart> => {
    if (!hostedRun || !opts.learner) return { kind: 'not-due' };
    const prefs = await deps.store.getPrefs();
    const prior = await reconcileHostedReceipt(prefs.hostedProcessing ?? null);
    if (hostedActive(prior)) return { kind: 'already', receipt: prior! };
    if (pausedNow(prefs)) return { kind: 'not-due' };
    const pins = await deps.store.listPins();
    const unprocessedPins = pins.filter((pin) => !pin.topicId).length;
    const decision = planBatch({
      unprocessedPins, dueForRevision: asked ? await dueForRevision() : 0,
      autoAfter: prefs.autoAfter ?? null, asked,
    });
    if (!decision.run) return { kind: 'not-due' };
    const now = deps.clock.now();
    const base: HostedProcessingReceipt = {
      receiptId: randomUUID(), state: 'launching', batchKey: dayKeyFor(now, zoneOf(prefs)),
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + HOSTED_ATTEMPT_LEASE_MS).toISOString(),
      checkedAt: now.toISOString(), asked, unprocessedPins,
    };
    const claimed = await deps.store.compareAndSetHostedProcessing(
      prior ? hostedProcessingVersion(prior) : null,
      base,
    );
    if (!claimed) {
      const winner = (await deps.store.getPrefs()).hostedProcessing ?? null;
      if (hostedActive(winner)) return { kind: 'already', receipt: winner! };
      return { kind: 'failed', receipt: winner ?? base };
    }
    try {
      await hostedRun.launch({
        boardId: boardIdFor(opts.learner.id)!, batchKey: base.batchKey, asked,
        receiptId: base.receiptId,
      });
      // The operation name is validated by the adapter but deliberately not
      // written after acceptance. The worker may already have advanced this
      // receipt, and a second whole-document write could downgrade `finished`
      // to `queued` without a transactional compare-and-swap.
      return { kind: 'queued', receipt: base };
    } catch (err) {
      console.error('[service] could not hand processing to the hosted worker:', err);
      // A timeout or malformed 2xx may describe an accepted execution. Keep
      // the launch lease in that ambiguous case so a retry cannot buy a second
      // run; the worker may still advance it, otherwise expiry makes it failed.
      if (!(err instanceof CloudRunJobLaunchError) || err.ambiguous) {
        return { kind: 'failed', receipt: base };
      }
      const failed = await writeHostedReceipt({
        ...base, state: 'failed', checkedAt: deps.clock.now().toISOString(),
      }, base).catch(async () => (await deps.store.getPrefs()).hostedProcessing
        ?? { ...base, state: 'failed' as const });
      return { kind: 'failed', receipt: failed };
    }
  };

  const beginBatchActivity = (): void => {
    batchActivity = {
      state: 'running', startedAt: new Date().toISOString(), finishedAt: null,
      currentStage: null, reports: [], outcome: null, outcomeReason: null, remaining: 0,
      withheld: 0, learnerCorrections: 0, lean: false, failure: null, failureReason: null,
    };
  };

  /** Count only what the pipeline actually admitted to the teaching brief. */
  const rememberLearnerContext = (corrections: number): void => {
    if (batchActivity?.state === 'running') batchActivity.learnerCorrections = corrections;
  };

  const startStage = (stage: string): void => {
    currentStage = stage;
    if (batchActivity?.state === 'running') batchActivity.currentStage = stage;
  };

  /**
   * THE RUN SAYS WHAT IT IS DOING.
   *
   * Until 2026-08-24 it said nothing at all. `runBatch` produces a
   * `StageReport` for every stage and offers `onStage` to hear them; the CLI
   * has printed them since it was written and this service passed neither —
   * it threw the reports away in `.then` and logged only a rejection. So a run
   * from a service was a black box: `building` went true, minutes passed, and
   * the only observable was that `POST /batch` kept answering `already`.
   *
   * That is not a small gap in logging. A night here is model work on a local
   * box — a `deep` compose call asks for 6,000 tokens, and the adapter's own
   * abort budget for one of those is twelve and a half minutes — so a run
   * legitimately taking five to ten minutes is indistinguishable, from every
   * surface in the product, from a run that has died. It was found exactly that
   * way: a live QA board where the session existed and the learner's *"Build a
   * session now"* answered *"already working through your board"* for a quarter
   * of an hour with nothing said.
   *
   * Deliberately NOT a watchdog that kills the run. The per-call abort budget
   * already bounds the model, and a run cancelled from out here would stop
   * between two store writes — trading a slow night for a torn one. What was
   * missing was the reporting, so the reporting is what this adds.
   */
  const reportRun = (why: string, run: Promise<Awaited<ReturnType<typeof runBatch>>>): void => {
    const started = Date.now();
    void run
      .then((result) => {
        rememberReceipt(result.notebook);
        const outcome = outcomeOf(result);
        const failed = result.reports.filter((r) => r.failed).map((r) => r.stage);
        if (batchActivity?.state === 'running') {
          batchActivity.state = 'finished';
          batchActivity.finishedAt = new Date().toISOString();
          batchActivity.currentStage = null;
          batchActivity.outcome = outcome.kind;
          batchActivity.outcomeReason = 'reason' in outcome ? outcome.reason : null;
          batchActivity.remaining = result.remaining;
          batchActivity.withheld = result.withheld.length;
          batchActivity.lean = result.lean;
        }
        console.log(`[batch] ${why} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`
          + ` — ${outcome.kind}${failed.length ? `, degraded: ${failed.join(', ')}` : ''}`
          // Said here as well as on the stage lines, because this is the one
          // line a service log keeps for a run nobody watched, and *"there is
          // more of the semester to come"* is the fact a course drop turns on.
          + (result.remaining ? `, ${result.remaining} still queued for the next run` : ''));
      })
      .catch((err) => {
        if (batchActivity?.state === 'running') {
          batchActivity.state = 'failed';
          batchActivity.finishedAt = new Date().toISOString();
          batchActivity.currentStage = null;
          batchActivity.failure = 'The run stopped before it could finish.';
          batchActivity.failureReason = err instanceof LlmCredentialMissing
            ? 'model-credential'
            : err instanceof ModelBudgetStop ? 'model-budget' : null;
        }
        console.error(`[batch] ${why} failed after ${((Date.now() - started) / 1000).toFixed(1)}s:`, err);
      })
      .finally(() => { building = false; currentStage = null; });
  };

  /** One line per stage, in the CLI's own shape, so two lanes read alike. */
  const stageLine = (why: string) => (r: StageReport): void => {
    if (batchActivity?.state === 'running') batchActivity.reports.push(r);
    console.log(`[batch] ${why} ${r.failed ? '!' : ' '} ${r.stage.padEnd(10)}`
      + ` ${String((r.ms / 1000).toFixed(1)).padStart(6)}s  ${r.detail}`);
  };

  /**
   * Where the learner's own documents get published, and what happened last.
   *
   * `NOTEBOOK_SEAM_V2.md` §9. Absent is off, and off is the default: spreading
   * an absent option contributes nothing to `runBatch`, so the night is the
   * night it always was and no code path has to test for a feature flag.
   *
   * The last receipt lives here, per board, for the same reason the meter does:
   * it is a property of the running service rather than of one composition
   * root, so an endpoint test can read it. It is not persisted, and it should
   * not be. It is a receipt for the last thing this process did, not a fact
   * about the learner, and a restart honestly knows nothing about it.
   */
  const notebookOption = opts.notebook ? { notebook: opts.notebook } : {};
  let lastNotebookReceipt: WriteReceipt | null = null;
  const rememberReceipt = (receipt: WriteReceipt | null): void => {
    if (receipt) lastNotebookReceipt = receipt;
  };

  /**
   * One Drive connection attempt at a time, and what became of the last one.
   *
   * §7's setup is three states a learner can be in and they are not the same
   * fact: *waiting on Google's consent screen*, *writing the five documents*,
   * and *done, here is the folder*. The screen has to be able to tell them
   * apart, because the second one is where §7 step 2 lives — **Virgil creates
   * the folder and writes the documents before the screen changes**, so the
   * learner never sees an empty folder that is about to fill up later.
   *
   * Held in the process rather than persisted, like the export receipt above and
   * for the same reason: it is a fact about a thing this process is doing, and a
   * restart honestly knows nothing about it. The connected/not-connected state
   * that outlives a restart is on disk, in the credential store.
   */
  type DriveConnectPhase = 'idle' | 'waiting' | 'writing' | 'connected' | 'failed';
  let pendingConsent: LoopbackConsent | null = null;
  let connectPhase: DriveConnectPhase = 'idle';
  let connectDetail = '';

  /**
   * What the learner's own taps cost, counted where they happen.
   *
   * The nightly has been metered since the cost model was written and this side
   * was not, so every call a learner buys by pressing something — a pin's
   * label, a marked answer, a depth shift, a review, a recap, a quick take —
   * was invisible to the one instrument this project has for saying what it
   * spends. UX_SPEC §3 makes the per-tap line a condition of shipping the quick
   * take, and a line nothing measures is an estimate.
   *
   * The same meter, rows and report shape as the nightly's, deliberately: a
   * second accounting instrument is a second set of numbers to reconcile, which
   * is how a cost model stops being checkable.
   *
   * Built here rather than in `main()` so that it is a property of the service
   * and not of one composition root — the endpoint tests reach `createApp`
   * directly, and a counter only the real process had would be a counter no
   * test could ever read.
   */
  const meter = new UsageMeter();

  /**
   * `deps`, with the model call attributed to the thing the learner pressed.
   *
   * At the call site rather than through `UsageMeter.enter`, because requests
   * to a service overlap and a marker set by one request and read by another
   * puts a pin's label in the answering bucket. `deps` itself stays unmetered,
   * so nothing can be counted twice by reaching the wrong handle.
   */
  /**
   * The learner's spend limit, and the switch that enforces it.
   *
   * Built per board — `routes` is called once per learner in the multi-tenant
   * shape — so one learner's limit can never stop another's work. It holds no
   * running total of its own; the store is the ledger. See `model-budget.ts`.
   */
  const budget = new ModelBudgetLedger({
    store: deps.store,
    clock: deps.clock,
    ...(opts.models?.defaultMode ? { defaultMode: opts.models.defaultMode } : {}),
    ...(opts.models?.operatorLimit ? { operatorLimit: opts.models.operatorLimit } : {}),
    // The call is already paid for by the time a bookkeeping write can fail.
    // Loudly, because a budget that has quietly stopped counting is a budget
    // that has quietly stopped working.
    onWriteError: (err) => console.error('[service] the model budget could not be updated:', err),
  });

  /**
   * `deps`, with the model call attributed to the thing the learner pressed —
   * and refused before it is issued if their budget is spent.
   *
   * The order of the two wrappers is load-bearing. The budget is OUTSIDE the
   * meter, so a stopped call never reaches `meterLlmAs` and is never counted as
   * `issuedNotReturned` — the quota-accounting contract reads that field as "issued and presumed
   * billed", and charging somebody for the call their own limit prevented would
   * be worse than not having the limit.
   */
  const at = (stage: string, lane: 'taps' | 'setup' = 'taps'): Deps => ({
    ...deps,
    llm: budgetedLlm(meterLlmAs(deps.llm, meter, stage, lane), budget),
  });

  /**
   * The boot warm-up's lane, handed to whoever built this app.
   *
   * **Counted as setup, under its own stage.** The warm-up is not a run and it
   * is not something the learner pressed: it composes nothing, teaches nobody,
   * and exists because the first local pin measured 2135ms against a 1500ms
   * toast budget purely from loading the model. The total remains visible while
   * the separate lane prevents a service-start action from impersonating the
   * learner in Models.
   *
   * The gate comes with it, and that is the half that matters: a warm-up now
   * meets the same exhausted budget every other call meets, and is refused
   * before anything is issued. `startService` catches that and comes up cold.
   */
  opts.onWarmupLane?.(at('warmup', 'setup').llm);

  /**
   * Batch and foreground calls share the same budget and usage ledger. The
   * budget is OUTSIDE the meter, so a call the learner's own limit stopped is
   * never counted as one they made. The budget's own per-connection ledger in
   * prefs (`model-budget.ts`) already saw these calls — `budgetedLlm` has
   * wrapped this since it was written — so nothing here starts double-counting
   * anything: the two instruments cut the same calls differently, the budget by
   * connection and this by lane, stage and tier, and they have counted the same
   * set since this line was written.
   *
   * Only the standalone nightly in `cli.ts` is outside this. That is a separate
   * process with its own composition root and no learner in front of it, and it
   * meters itself the same way.
   */
  const budgetedDeps: Deps = {
    ...deps,
    llm: budgetedLlm(meterLlm(deps.llm, meter, 'runs'), budget),
    // The embedder has no budget gate — there is no cost model for embeddings
    // to stop — but it is a call the run makes and the report has an embed
    // section that a service run never wrote to.
    embedder: meterEmbedder(deps.embedder, meter, 'runs'),
  };

  /**
   * The board as the main page needs to read it: comfort per topic, and the
   * Gardener's decisions over them.
   *
   * The same two calls the nightly makes, on the same inputs — which is the
   * point. §5 asks the session card for *the Gardener's actual reason*, and the
   * only way for the card and the run to be unable to disagree is for the card
   * to ask the Gardener rather than to describe what it thinks the Gardener
   * would have said. Deterministic and cheap: arithmetic over topics and
   * signals, and no model call anywhere on this path.
   */
  async function readBoardState(requestedZone?: string): Promise<{
    topics: readonly Awaited<ReturnType<Deps['store']['listTopics']>>[number][];
    signals: readonly Signal[];
    comforts: readonly ReturnType<typeof computeComfort>[];
    decisions: readonly ReturnType<typeof tend>[number][];
    now: Date;
  }> {
    const now = deps.clock.now();
    const [topics, signals, commitments, prefs] = await Promise.all([
      deps.store.listTopics(), deps.store.listSignals(),
      deps.store.listCommitments(), deps.store.getPrefs(),
    ]);
    const comforts = topics.map((t) => computeComfort(t.id, signals, now));
    // The deadlines reach the Gardener here, and this one line is what makes
    // the plan a learning feature rather than a to-do list beside one: an
    // assignment on Friday pulls the topics it leans on forward in what gets
    // taught tonight. Bounded at 1.6x inside `dueWeight`, and applied only to
    // the derived priorities — a typed date never outranks a person.
    const timeZone = zoneOf(prefs, requestedZone);
    return {
      topics, signals, comforts, now,
      decisions: tend({ topics, comforts, signals, now, commitments, timeZone }),
    };
  }

  /** The closed-loop projection behind Today and outcome adaptation receipts.
   *  Its body is `today-source.ts`; this is the binding to this service's
   *  dependencies and its zone rule. */
  const readNextAction = (
    availableMinutes: AvailableMinutes,
    knownPrefs?: Awaited<ReturnType<Deps['store']['getPrefs']>>,
    requestedZone?: string,
    passedOverPinIds: readonly string[] = [],
  ) => readNextActionFor(
    { deps, zoneOf }, availableMinutes, knownPrefs, requestedZone, passedOverPinIds,
  );

  interface IntakeRequest {
    readonly text: string;
    readonly sourceKind: CourseSourceKind;
    readonly sourceTitle: string;
    readonly url: string | null;
  }
  interface IntakeIdentity { readonly draftId: string; readonly sourceId: string }

  const intakeRequestFrom = (body: Record<string, unknown>): IntakeRequest => {
    const suppliedTitle = optionalTrimmedBoundedString(
      body, 'title', COURSE_SOURCE_TITLE_MAX_CHARS, 'source name',
    );
    return {
      text: requireRawBoundedString(
        body, 'text', INTAKE_SOURCE_MAX_CHARS, 'source text',
      ),
      sourceKind: requireOneOf(body, 'kind', [
        'syllabus', 'rubric', 'assignment-brief', 'course-page',
        'learner-note', 'image', 'other',
      ] as const) as CourseSourceKind,
      sourceTitle: suppliedTitle || 'Imported course source',
      url: typeof body.url === 'string' ? body.url : null,
    };
  };

  /** One source crosses the same deterministic draft boundary in every intake route. */
  async function createIntakeDraft(
    input: IntakeRequest, enhance: boolean, timeZone = 'UTC', identity?: IntakeIdentity,
    routeWarnings: readonly string[] = [],
  ) {
    const sourceChars = Array.from(input.text);
    const sourceWasTruncated = sourceChars.length > INTAKE_SOURCE_MAX_CHARS;
    const sourceText = sourceWasTruncated
      ? sourceChars.slice(0, INTAKE_SOURCE_MAX_CHARS).join('') : input.text;
    const now = deps.clock.now().toISOString();
    const base = buildDeterministicIntake({
      draftId: identity?.draftId ?? randomUUID(), sourceId: identity?.sourceId ?? randomUUID(), sourceKind: input.sourceKind,
      sourceTitle: input.sourceTitle, text: sourceText, url: input.url,
      now, id: randomUUID,
      digest: `sha256:${createHash('sha256').update(sourceText).digest('hex')}`,
      timeZone,
    });
    const sourceWarnings = sourceWasTruncated ? [
      `Only the first ${INTAKE_SOURCE_MAX_CHARS.toLocaleString('en-US')} characters of this folder source were kept for review.`,
    ] : [];
    const bounded = sourceWarnings.length || routeWarnings.length ? {
      ...base,
      warnings: [...base.warnings, ...sourceWarnings, ...routeWarnings],
    } : base;
    const enriched = enhance
      ? await enrichCourseIntake(at('course-intake'), bounded, randomUUID)
      : { outcome: 'nothing-added' as const, draft: bounded, added: { objectives: 0, commitments: 0, questions: 0 } };
    await deps.store.putIntakeDraft(enriched.draft);
    return {
      draft: enriched.draft,
      extraction: enriched.outcome === 'model-failed'
        ? 'deterministic-fallback' : enriched.outcome === 'enriched' ? 'model-enriched' : 'deterministic',
      agentAdded: enriched.added,
    };
  }

  const receiveCourseIntake = async (
    body: Record<string, unknown>, timeZone: string,
  ): Promise<{ status: 200 | 201 | 409; body: Record<string, unknown> }> => {
    const request = intakeRequestFrom(body);
    const clientRef = exactAgentIdentity(
      body.clientRef, 'clientRef', DROP_CLIENT_REF_MAX_CHARS, refuseBadRequest,
    );
    if (clientRef === null) {
      return { status: 201, body: await createIntakeDraft(
        request, body.enhance !== false, timeZone,
      ) };
    }
    const identity = {
      draftId: intakeArtifactId('draft', clientRef),
      sourceId: intakeArtifactId('source', clientRef),
    };
    const existing = await deps.store.getIntakeDraft(identity.draftId);
    if (existing) {
      const expectedUrl = request.url && isOpenableUrl(request.url) ? request.url : null;
      if (existing.source.kind !== request.sourceKind
          || existing.source.title !== request.sourceTitle
          || existing.source.text !== request.text
          || existing.source.url !== expectedUrl) {
        return { status: 409, body: {
          error: 'clientRef already names a different course source; reuse it only for an exact retry',
        } };
      }
      return { status: 200, body: {
        draft: existing, extraction: 'existing', repeated: true, authoritativeWrites: 0,
      } };
    }
    return { status: 201, body: {
      ...await createIntakeDraft(request, body.enhance !== false, timeZone, identity),
      repeated: false, authoritativeWrites: 0,
    } };
  };

  // -------------------------------------------------------------- course drop

  /**
   * ONE SEMESTER, ONE GESTURE.
   *
   * The public release claim this repository has been making — *agents that handle
   * the heavy lifting of massive datasets* — asked for a surface where somebody
   * hands over an entire course rather than a page at a time, and there was not
   * one. `POST /course-intakes` takes a single already-decoded source and
   * `POST /course-intakes/bulk` takes 25 of them for an unattended agent. A
   * semester is fifty to three hundred documents with bytes in them, and it is
   * the learner's own folder rather than an agent's proposal.
   *
   * ## What a drop does, and the three lines it will not cross
   *
   * **It reads every item at the door**, because parsing is free and a failure
   * a person can see at the moment they dropped the folder is worth ten times a
   * failure they find in the morning. What cannot be read here is named per
   * item — `SERVER_PARSE_COVERAGE` — and **never silently dropped**, which is
   * the property that makes a count of three hundred honest.
   *
   * **It writes material and proposals, and nothing else.** Each readable item
   * becomes a pin, because a pin is what the learner gave: it is their document,
   * on their board, and the board is where the fleet reads material from. Each
   * syllabus-shaped item additionally becomes an intake *draft* — objectives,
   * dated obligations, open questions — which writes no course, no commitment
   * and no deadline until somebody presses apply. That boundary is
   * `validateIntakeDraft`'s and this route does not widen it by an inch.
   *
   * **It spends nothing.** Not one model call is made inside this request, and
   * that is the whole design rather than an optimisation. `createPin` reaches
   * the Scout for a toast label and `createIntakeDraft(_, true)` reaches the
   * intake specialist; three hundred of either inside one HTTP exchange is the
   * per-item model call that batching exists to abolish, arriving through a new
   * door. So the drop is deterministic end to end, and the model work is a
   * queue the nightly's `intake` and `forage` stages work through at
   * `workCap` a night. The response says how many nights that is.
   */
  const DROP_KINDS = [
    'syllabus', 'rubric', 'assignment-brief', 'course-page',
    'learner-note', 'image', 'other',
  ] as const;

  /**
   * The kinds whose text is worth putting through the deadline extractor.
   *
   * A lecture handout is material and a syllabus is a plan, and running the
   * plan extractor over every one of three hundred lecture notes would produce
   * three hundred near-empty drafts for somebody to review — the review queue
   * as a denial-of-service on the person it is for. `learner-note`, `image` and
   * `other` land as material only, which is what they are.
   */
  const PLANNING_KINDS = new Set<CourseSourceKind>([
    'syllabus', 'rubric', 'assignment-brief', 'course-page',
  ]);

  /**
   * Raw deflate, from the platform rather than from a package.
   *
   * `core/domain/documents.ts` names the capability and refuses to construct
   * one, because a decompressor is I/O-shaped and `core/` is neither vendor nor
   * I/O. Node has had `DecompressionStream` since 18 and the extension's own
   * zip walk uses the identical construction, so the two halves of this
   * product inflate a docx the same way without sharing a line.
   */
  const inflateRaw = async (data: Uint8Array): Promise<Uint8Array> => {
    const stream = new Blob([data as BlobPart]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };

  interface DropItem {
    readonly clientRef: string;
    readonly name: string;
    readonly kind: CourseSourceKind;
    readonly mimeType: string | null;
    readonly url: string | null;
    readonly text: string | null;
    readonly bytes: Uint8Array | null;
  }

  /**
   * Node's base64 decoder is deliberately forgiving: it ignores punctuation
   * and accepts non-zero unused bits. That is useful at a command line and
   * unsafe at an ingestion boundary because malformed caller bytes can become
   * different stored bytes. Accept either canonical padded or canonical
   * unpadded RFC 4648 text, then prove it by round-tripping the decoded bytes.
   */
  const decodeDropBase64 = (value: string, index: number): Uint8Array => {
    const refuse = (): never => {
      throw new BadRequest(`items.${index}.contentBase64 must be canonical base64 `
        + '(RFC 4648 standard alphabet, optional padding, no whitespace)');
    };
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return refuse();
    const bare = value.replace(/=+$/, '');
    if (!bare || bare.length % 4 === 1) return refuse();
    const canonical = `${bare}${'='.repeat((4 - (bare.length % 4)) % 4)}`;
    if (value !== bare && value !== canonical) return refuse();
    const decoded = Buffer.from(canonical, 'base64');
    if (decoded.toString('base64') !== canonical) return refuse();
    return new Uint8Array(decoded);
  };

  const dropItemFrom = (raw: Record<string, unknown>, index: number): DropItem => {
    const name = typeof raw.name === 'string' && !rendersEmpty(raw.name)
      ? dropDisplayName(raw.name) : '';
    const sourceFields = ['text', 'contentBase64', 'url'] as const;
    const supplied = sourceFields.filter((field) => raw[field] !== undefined && raw[field] !== null);
    if (supplied.length > 1) {
      throw new BadRequest('an item may supply at most one of text, contentBase64 or url');
    }
    let text: string | null = null;
    let bytes: Uint8Array | null = null;
    let url: string | null = null;
    if (supplied[0] === 'text') {
      if (typeof raw.text !== 'string' || rendersEmpty(raw.text)) {
        throw new BadRequest(`items.${index}.text must be a non-empty string when supplied`);
      }
      text = raw.text;
    } else if (supplied[0] === 'contentBase64') {
      if (typeof raw.contentBase64 !== 'string' || !raw.contentBase64) {
        throw new BadRequest(`items.${index}.contentBase64 must be a non-empty string when supplied`);
      }
      // Refused rather than repaired. Half of somebody's syllabus — or bytes
      // different from those their agent sent — is worse than none.
      bytes = decodeDropBase64(raw.contentBase64, index);
    } else if (supplied[0] === 'url') {
      if (typeof raw.url !== 'string' || !isOpenableUrl(raw.url)) {
        throw new BadRequest(`items.${index}.url must be a non-empty HTTP or HTTPS URL when supplied`);
      }
      url = raw.url;
    }
    return {
      // The client's own name for the item, honoured the way `Pin.clientRef` is
      // and for the same reason: a drop of three hundred documents is exactly
      // the request most likely to be retried after a timeout, and a retry that
      // made a second copy of a semester would be the worst duplicate in the
      // product.
      clientRef: exactAgentIdentity(
        raw.clientRef, 'clientRef', DROP_CLIENT_REF_MAX_CHARS, refuseBadRequest,
      )
        ?? `item-${index}`,
      name: name || (url ? new URL(url).pathname.split('/').pop() || 'page.html' : `item-${index}`),
      kind: requireOneOf(raw, 'kind', DROP_KINDS) as CourseSourceKind,
      mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : null,
      url,
      text,
      bytes,
    };
  };

  /**
   * One item, to text or to a stated reason.
   *
   * A `url` with no bytes is fetched through the `Research` port, which is the
   * one seam in this product that reaches the outside world and is already the
   * Forager's. The local adapter exposes a second block-aware representation for
   * this path so headings and table rows survive. Older or custom providers can
   * still return only compact prose; that compatibility fallback is named in
   * both the receipt and any planning draft rather than passed off as equivalent.
   */
  interface DropRead {
    readonly outcome: ExtractionOutcome;
    readonly fetchedStructure: 'preserved' | 'flattened' | null;
  }

  async function readDropItem(item: DropItem): Promise<DropRead> {
    if (item.text && item.text.trim()) {
      return {
        outcome: await extractDocumentText({ name: item.name, mimeType: item.mimeType, text: item.text }),
        fetchedStructure: null,
      };
    }
    if (item.bytes) {
      return {
        outcome: await extractDocumentText(
          { name: item.name, mimeType: item.mimeType, bytes: item.bytes }, { inflateRaw }),
        fetchedStructure: null,
      };
    }
    if (!item.url) return {
      outcome: { kind: 'no-text', format: documentFormatOf(item.name, item.mimeType ?? '') ?? 'text' },
      fetchedStructure: null,
    };
    const page = await deps.research.fetchPage(item.url);
    if (!page || !page.text.trim()) {
      return {
        outcome: { kind: 'unreadable', format: 'html', detail: 'the page could not be fetched' },
        fetchedStructure: null,
      };
    }
    const hasStructuredText = typeof page.structuredText === 'string'
      && page.structuredText.trim().length > 0;
    // `Research` returns readable text rather than response bytes. It still
    // enters the same storage boundary as a supplied file: a URL must not gain
    // an unreported 1MB path around the 200,000-character document contract.
    return {
      outcome: capDocumentText('html', tidyText(hasStructuredText ? page.structuredText! : page.text)),
      fetchedStructure: hasStructuredText ? 'preserved' : 'flattened',
    };
  }

  const FLATTENED_PAGE_WARNING = 'This URL was fetched as flattened page text. Check table rows, headings and dates against the original page before applying this plan.';

  const describeDropRead = (read: DropRead): string => {
    const extraction = describeExtraction(read.outcome);
    if (read.fetchedStructure === 'preserved') {
      return `fetched with page blocks kept as lines; ${extraction}`;
    }
    if (read.fetchedStructure === 'flattened') {
      return `fetched as flattened page text; check table rows, headings and dates against the original; ${extraction}`;
    }
    return extraction;
  };

  const dropReadWarnings = (read: DropRead): readonly string[] =>
    read.fetchedStructure === 'flattened' ? [FLATTENED_PAGE_WARNING] : [];

  /** The pin a dropped document becomes: material, unlabelled, unenriched. */
  const pinForDrop = (item: DropItem, dropId: string, title: string, text: string): Pin => ({
    id: dropArtifactId('pin', dropId, item.clientRef),
    type: 'interest',
    envelope: {
      selection: null,
      parts: [],
      surroundingText: text,
      // The drop's own title is the heading path, so the clusterer has the one
      // thing it most wants about a course document — which course it is from —
      // in the first line of what it embeds. Everything in one drop therefore
      // starts with a shared signal, and the partition can still split it on the
      // material, which is what a semester of one subject should do.
      headingPath: [title],
      pageTitle: item.name,
      url: item.url ?? '',
      canonicalUrl: null,
      siteName: null,
      contentLanguage: null,
      media: null,
    },
    note: null,
    capturedAt: deps.clock.now().toISOString(),
    clientRef: `${dropId}:${item.clientRef}`,
    fromSuggestion: false,
    // Both null and both load-bearing. No `label` means nothing paid the Scout
    // for a toast nobody is looking at; no `enrichment` means the pin is owed
    // an attempt, which is exactly how it joins the queue the nightly paces.
    enrichment: null,
    topicId: null,
  });

  /**
   * Topic ids the board actually has, or a refusal naming the one it does not.
   *
   * A result and a commitment both point at topics, and a dangling id is worth
   * the same refusal on both: it is a link to something on the learner's board
   * that is not on their board, and storing it would leave `dueWeight` and
   * every join reading past a topic that never existed. Same shape as the
   * refusals for an unknown `courseId` or `commitmentId` above.
   */
  async function knownTopicIds(ids: readonly string[]): Promise<string[]> {
    for (const topicId of ids) {
      if (!(await deps.store.getTopic(topicId))) {
        throw new BadRequest(`topicIds contains an unknown topic: ${topicId}`);
      }
    }
    return [...ids];
  }

  /**
   * The course an obligation belongs to, checked against the ones that exist.
   *
   * The same rule `knownTopicIds` keeps one function up, and for the same
   * reason: *a dangling link weighs nothing and explains nothing*. It matters
   * more since the learner-lineup contract’s correction, because this id is now the only real
   * join between a topic and a subject — `subjectForTopic` reads it to put a
   * course name beside a lesson on tonight's lineup, and a course id that names
   * nothing produces a row with no subject and no way for the learner to find
   * out why.
   *
   * `null` and the empty string both mean "no course", which is what clearing
   * one looks like on the wire. An **archived** course is accepted: it exists,
   * the learner chose it, and whether an archived subject is worth showing is
   * the lineup's decision rather than this one's. `subjectForTopic` makes that
   * decision and declines it, which is the right place for it.
   */
  async function knownCourseId(value: unknown): Promise<string | null> {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') {
      throw new BadRequest('courseId must be a course id or null');
    }
    if (!(await deps.store.getCourse(value))) {
      throw new BadRequest(`courseId names a course that does not exist: ${value}`);
    }
    return value;
  }

  async function outcomeFromBody(
    body: Record<string, unknown>, id: string, supersedesId: string | null,
  ): Promise<LearningOutcome> {
    const kind = requireOneOf(body, 'kind', [
      'grade', 'rubric', 'teacher-feedback', 'self-assessment', 'real-world',
    ] as const) as OutcomeKind;
    const requestedCourseId = typeof body.courseId === 'string' && body.courseId ? body.courseId : null;
    const commitmentId = typeof body.commitmentId === 'string' && body.commitmentId
      ? body.commitmentId : null;
    const commitment = commitmentId ? await deps.store.getCommitment(commitmentId) : null;
    if (commitmentId && !commitment) throw new BadRequest('commitmentId does not name a commitment');

    // An assignment is already filed. A result cannot name that exact work
    // while discarding its course, or point the same work at another course:
    // that impossible pair is what made assessed Data Structures work render
    // under "Not in a course". The assignment is the stronger relationship.
    // A genuinely unfiled assignment still permits an independently chosen
    // result course, which is useful while repairing older boards.
    let courseId = requestedCourseId;
    if (commitment?.courseId) {
      const owner = await deps.store.getCourse(commitment.courseId);
      if (!owner) throw new BadRequest('assignment belongs to a course that no longer exists');
      if (courseId && courseId !== owner.id) {
        throw new BadRequest(`assignment belongs to ${owner.title}; choose that course or another assignment`);
      }
      courseId = owner.id;
    }
    if (courseId && !(await deps.store.getCourse(courseId))) throw new BadRequest('courseId does not name a course');
    const criteria = criteriaFrom(body.criteria);
    const topicIds = await knownTopicIds([...new Set([
      ...optionalIds(body, 'topicIds'), ...criteria.flatMap((c) => c.topicIds),
    ])]);
    const score = optionalScore(body, 'score');
    const maxScore = optionalScore(body, 'maxScore');
    if ((score === null) !== (maxScore === null)) {
      throw new BadRequest('score and maxScore must be supplied together');
    }
    if (score !== null && maxScore !== null && (maxScore <= 0 || score > maxScore)) {
      throw new BadRequest('score must be between zero and maxScore');
    }
    let source: LearningOutcome['source'] = null;
    if (body.source !== undefined && body.source !== null) {
      if (typeof body.source !== 'object' || Array.isArray(body.source)) {
        throw new BadRequest('source must be an object');
      }
      const row = body.source as Record<string, unknown>;
      source = {
        sourceId: requireString(row, 'sourceId').slice(0, 180),
        quote: requireString(row, 'quote').slice(0, 280),
      };
    }
    return {
      id, kind, courseId, commitmentId, topicIds,
      title: requireBoundedString(body, 'title', 180, 'result name'), score, maxScore,
      summary: optionalText(body, 'summary').slice(0, 1_000),
      feedback: optionalBoundedString(body, 'feedback', 6_000, 'result feedback'), criteria, source,
      recordedAt: deps.clock.now().toISOString(), supersedesId, deletedAt: null,
    };
  }

  /**
   * How many topics have gone soft enough to be worth a look.
   *
   * `tend` is the Gardener and it is pure arithmetic over topics, comforts and
   * signals — no model call anywhere on this path, which is the whole point of
   * being able to answer "is anything worth running?" for free.
   *
   * This is counted so it can be OFFERED. Decay is never a reason to spend
   * somebody's money unasked: a topic going soft is worth telling them about,
   * and buying them a session they did not ask for is the waste the manual-processing contract
   * exists to stop.
   */
  async function dueForRevision(): Promise<number> {
    const { decisions } = await readBoardState();
    // `review` is due-for-a-check and `resurface` is something that slipped.
    // Both are worth telling somebody about; neither is worth buying for them.
    return decisions.filter((d) => d.disposition === 'review' || d.disposition === 'resurface').length;
  }

  /**
   * Run the batch, unasked, when enough has piled up and the learner said to.
   *
   * Never blocks the pin. A capture has a 2.5s budget and the whole reason
   * batching exists is that a learner pinning things as they browse should not
   * buy a model call per pin — making them wait for the batch would be the same
   * cost in a worse place.
   *
   * Off unless the learner turned it on (`autoAfter`), and `AUTO_FLOOR` stops
   * one pin ever counting as a batch.
   */
  async function maybeAutoRun(): Promise<HostedStart | null> {
    // In Cloud Run, the request owns only dispatch. The Job owns every model
    // call and the pin response waits for the Admin API acceptance, never for
    // the batch itself.
    if (hostedRun) return startHostedRun(false);
    if (building) return null;
    building = true;
    let handedToRun = false;
    try {
      const prefs = await deps.store.getPrefs();
      if (pausedNow(prefs)) return null;
      const pins = await deps.store.listPins();
      const decision = planBatch({
        unprocessedPins: pins.filter((p) => !p.topicId).length,
        // Not counted here: decay is never a reason to spend unasked, and this
        // is the unasked path.
        dueForRevision: 0,
        autoAfter: prefs.autoAfter ?? null,
      });
      if (!decision.run) return null;
      const dayKey = dayKeyFor(deps.clock.now(), zoneOf(prefs));
      beginBatchActivity();
      reportRun('the automatic run', runBatch(budgetedDeps, {
        batchKey: dayKey, usage: meter, onStage: stageLine('the automatic run'),
        onStageStart: startStage,
        onLearnerContext: rememberLearnerContext,
        workCap, ...notebookOption,
      }));
      handedToRun = true;
      return null;
    } catch (err) {
      // A pin that landed must never be undone by the thing that runs after
      // it. This path is best-effort by construction.
      console.error('[service] could not consider an automatic run:', err);
      return null;
    } finally {
      if (!handedToRun) building = false;
    }
  }

  /** Whether collection is paused right now (the processing-pause contract). */
  const pausedNow = (prefs: Awaited<ReturnType<Deps['store']['getPrefs']>>): boolean => {
    const until = prefs.pausedUntil;
    return typeof until === 'string' && Date.parse(until) > deps.clock.now().getTime();
  };

  /** The learner's zone, for keying a run to their day. Their schedule is gone
   *  as a clock; the zone survives because a day still has to be somebody's. */
  const zoneOf = (
    prefs: Awaited<ReturnType<Deps['store']['getPrefs']>>, requested?: string,
  ): string => {
    if (requested && isZone(requested)) return requested;
    if (typeof prefs.timeZone === 'string' && isZone(prefs.timeZone)) return prefs.timeZone;
    const schedule = scheduleFrom(prefs.schedule);
    return schedule.kind === 'daily' ? schedule.timeZone : 'UTC';
  };

  /** A malformed zone is absent, never a request failure. The browser's zone
   * is context for calendar language and ranking; it is not authority over
   * learner data. */
  const requestTimeZone = (req: IncomingMessage): string | undefined => {
    const value = req.headers[TIME_ZONE_HEADER];
    return typeof value === 'string' && isZone(value) ? value : undefined;
  };

  /**
   * How much has arrived since the last session was built.
   *
   * The honest source for the "building this run" card. There is no run state in
   * the store — nothing records that a nightly is in flight — so this counts
   * what the next run will have to work with rather than claiming to watch one
   * happening. A pin with an unreadable `capturedAt` is not counted: an
   * unparseable date comparing false is the right answer here, and inventing a
   * pin's age to make a card fuller would be the wrong one.
   */
  const pinsWaitingIn = (pins: readonly Pin[]): number =>
    pins.filter((p) => !p.topicId).length;

  async function createPin(
    body: PinRequest, opts: { fromSuggestion?: boolean; label?: string } = {},
  ): Promise<{ id: string; label: string }> {
    if (body.clientRef) {
      const already = (await deps.store.listPins()).find((p) => p.clientRef === body.clientRef);
      if (already) {
        const topic = already.topicId ? await deps.store.getTopic(already.topicId) : null;
        return {
          id: already.id,
          label: topic?.label ?? already.label ?? fallbackLabel(already.envelope),
        };
      }
    }

    const topics = await deps.store.listTopics();
    const id = randomUUID();

    /**
     * Scout ran on **every pin ever made**, to produce a few words for a toast.
     * On a board that already has a topic about this, those words already exist
     * and are better than anything a fresh call would invent: the topic's own
     * label is what the rest of the product calls this material, so using it
     * makes the toast agree with the board instead of guessing beside it.
     *
     * So the cosine match runs first. A hit costs one embed call and names the
     * pin from the board. A miss is genuinely new material, which is the only
     * case where naming is a language problem and a model earns the call.
     */
    let label: string;
    const suppliedLabel = typeof opts.label === 'string'
      ? stripInvisible(opts.label).replace(/\s+/g, ' ').trim().slice(0, 120)
      : '';
    if (suppliedLabel) {
      // A confirmed tangent already paid the Tutor to name the subject it grew
      // into. Running Scout again would spend another call to disagree with the
      // offer the learner just accepted.
      label = suppliedLabel;
    } else {
      const material = body.envelope.selection ?? body.envelope.surroundingText ?? '';
      const matches = await matchBoard(material);
      const matched = matches[0]
        ? topics.find((t) => t.id === matches[0]!.topicId) ?? null
        : null;
      if (matched) {
        label = matched.label;
      } else {
        // the label goes in the toast, so Scout's failure must never become
        // the user's failure. Fall back rather than surfacing an error.
        try {
          const out = await scout(at('pin'), {
            envelope: body.envelope,
            type: body.type,
            note: body.note ?? null,
            existingTopicLabels: topics.map((t) => t.label),
          });
          label = out.label;
        } catch (err) {
          /**
           * The one place a refusal is deliberately NOT rethrown, and the reason
           * is the pin.
           *
           * Everywhere else a `LlmRefused` travels to the 402 below, because the
           * thing it would otherwise become — "the check did not run" — sends
           * somebody to look at a credential over a limit they set. Here the
           * request has a learner's capture in it and the pin is written after
           * this line. Rethrowing would answer 402 and throw the capture away,
           * which is the same harm the fallback exists to prevent, just bought
           * with a better sentence.
           *
           * The truth still leaves the building: `budgetStopInScope` puts
           * `x-virgil-model-budget: stopped:<connection>` on this 201, and the
           * panel reads it. That is what makes the trade honest rather than a
           * silent swallow, and it is asserted by 'an endpoint that degrades
           * instead of failing still says the budget did it'.
           *
           * Falling back is correct; falling back *silently* is not. A model that
           * is down for a week looks exactly like one that worked, from here.
           */
          console.warn('[service] scout failed, using the fallback label:', err);
          label = fallbackLabel(body.envelope);
        }
      }
    }

    const pin: Pin = {
      id,
      type: body.type,
      envelope: body.envelope,
      note: body.note ?? null,
      // Kept rather than discarded: it is what every foreground surface calls
      // this pin until clustering gives it a topic.
      label,
      capturedAt: body.capturedAt ?? deps.clock.now().toISOString(),
      clientRef: body.clientRef ?? null,
      requestedRegister: body.requestedRegister ?? null,
      requestedMinutes: body.requestedMinutes ?? null,
      // the field existed and was hardcoded false at the only place a
      // pin was made, so "this began as something the agent noticed" was
      // unrecorded and unanswerable. It is the provenance that makes the reveal
      // checkable after the fact.
      fromSuggestion: opts.fromSuggestion ?? false,
      enrichment: null,   // Forager's job, overnight
      topicId: null,      // the Clusterer's job, overnight
    };
    await deps.store.putPin(pin);
    return { id, label };
  }

  /**
   * The learner-owned receipt for one pin.
   *
   * This is deliberately assembled from the stored pin rather than from a
   * derived topic or lesson. Editing the learner-authored metadata fields
   * must never rewrite the captured passage, page, time, client identity or
   * filing history; returning them together lets the foreground prove that
   * invariant after every save.
   */
  const pinReceipt = (pin: Pin): Record<string, unknown> => ({
    id: pin.id,
    type: pin.type,
    note: pin.note,
    requestedRegister: pin.requestedRegister ?? null,
    requestedMinutes: pin.requestedMinutes ?? null,
    label: pin.label ?? null,
    capturedAt: pin.capturedAt,
    topicId: pin.topicId,
    source: {
      text: pin.envelope.selection ?? pin.envelope.surroundingText ?? '',
      kind: pin.envelope.selection ? 'selection' : 'page',
      pageTitle: pin.envelope.pageTitle ?? '',
      url: pin.envelope.url ?? null,
      headingPath: Array.isArray(pin.envelope.headingPath) ? pin.envelope.headingPath : [],
      availability: pin.sourceAvailability ?? null,
    },
  });

  async function matchBoard(material: unknown): Promise<readonly TopicMatch[]> {
    // Through `String` because this runs before the envelope has been validated
    // on the create path, and `service-fuzz` posts a `selection` of `42`. A
    // match is not worth a 500, and refusing the pin is the validator's job
    // rather than this one's.
    const text = typeof material === 'string' ? material.trim() : '';
    if (!text) return [];
    const topics = await deps.store.listTopics();
    if (!topics.length) return [];

    // Retired topics are matched too, and deliberately. Retiring a topic says
    // "stop bringing this up", which governs what the board offers; it does not
    // unlearn it, and pitching a learner from nothing on something they retired
    // as finished would be the same lie in the other direction.
    const pins = await deps.store.listPins();
    const docs = topics.map((t) => topicDocument(t, pins));
    try {
      // Through the meter. The whole argument for matching this way is that it
      // costs an embed call rather than a model call, and a cost nobody can see
      // is a cost nobody checks: `GET /usage` has an embed section that this
      // service never wrote to, so every foreground embed was free by omission.
      // The stage is named rather than left to the marker, because a run may
      // be going while this is pressed and the marker belongs to the run.
      const vectors = await meterEmbedder(deps.embedder, meter, 'taps', 'topic-match')
        .embed([text.slice(0, MATCH_MATERIAL), ...docs]);
      const [materialVector, ...topicVectors] = vectors;
      return matchTopics(
        materialVector ?? [],
        topics.map((t, i) => ({ topicId: t.id, vector: topicVectors[i] ?? [] })),
        deps.embedder.modelId,
      );
    } catch (err) {
      // Degrade to what is filed rather than to an error: a take pitched from
      // nothing is worth more than no take. Loudly, because an embedder that is
      // down for a week looks exactly like a board with nothing on it.
      console.warn('[service] live topic match failed, falling back to what is filed:', err);
      return [];
    }
  }

  /**
   * The register to teach this pin at, from what the board knows right now.
   *
   * The learner's own answer wins over everything (`requestedRegister`), then
   * the filed topic where the partition has reached this pin, then the live
   * match. `from-nothing` survives as an answer for material the board really
   * holds nothing about, which is the one case where it was ever honest.
   */
  async function contextFor(pin: Pin): Promise<{
    context: LiveContext; register: DepthRegister; comfort: ComfortRead | undefined;
    /** The topic whose history is teaching this, filed or matched. Carried so
     *  the surface can head the screen with the board's own name for the
     *  subject rather than with what one pin was called. */
    topic: Topic | null;
  }> {
    const e = pin.envelope;
    const matches = pin.topicId
      ? []
      : await matchBoard(e.selection ?? e.surroundingText ?? '');
    const context = resolveContext(pin.topicId, matches);
    const topic = context.topicId ? await deps.store.getTopic(context.topicId) : null;
    const comfort = topic
      ? computeComfort(topic.id, await deps.store.listSignals(topic.id), deps.clock.now())
      : undefined;
    return { context, comfort, topic, register: pin.requestedRegister ?? registerFor(comfort) };
  }

  async function foregroundTutorContextFor(pin: Pin): Promise<{
    context: LiveContext; register: DepthRegister; comfort: ComfortRead | undefined;
    topic: Topic | null;
    knownAboutLearner: readonly string[];
    learnerCorrections: readonly string[];
  }> {
    const [subject, statements, signals] = await Promise.all([
      contextFor(pin), deps.store.listStatements(), deps.store.listSignals(),
    ]);
    const learner = sessionLearnerContext(statements, signals);
    return {
      ...subject,
      knownAboutLearner: learner.derived,
      learnerCorrections: learner.corrections,
    };
  }

  async function topicForOrphan(orphan: Pin): Promise<string> {
    const e = orphan.envelope;

    const matches = await matchBoard(e.selection ?? e.surroundingText ?? '');
    const matched = matches[0]?.topicId;
    if (matched && await deps.store.getTopic(matched)) {
      await deps.store.putPin({ ...orphan, topicId: matched });
      return matched;
    }

    const id = randomUUID();
    await deps.store.putTopic({
      id,
      label: fallbackLabel(e),
      summary: String(e.selection ?? e.surroundingText ?? '').replace(/\s+/g, ' ').slice(0, 160),
      pinIds: [orphan.id],
      state: 'waiting',
      comfort: 0.15,
      lastExposedAt: null,
      retiredByUser: false,
      createdAt: deps.clock.now().toISOString(),
      // Nothing named this. It exists so the signal above is not orphaned, and
      // its label is whatever the page called itself, which may be a title cut
      // mid-masthead and frozen by the identity
      // promise that exists to protect month-old topics. Flagged, so the
      // cluster stage names it once. See `Topic.provisionalName`.
      provisionalName: true,
    });
    await deps.store.putPin({ ...orphan, topicId: id });
    return id;
  }

  /**
   * The actual cited material a correction can be checked against.
   *
   * A user-pin source uses the capture envelope first, so a login wall or a
   * vanished page cannot erase what the learner selected. An agent-sourced
   * reference is re-fetched at the moment of the challenge. If neither yields
   * text, the service refuses the model call rather than asking it to arbitrate
   * a source it has not read.
   */
  async function correctionEvidence(section: Session['sections'][number]): Promise<{
    text: string;
    resolved: ReturnType<typeof resolveSources>;
  }> {
    const pins = await deps.store.listPins();
    const resolved = resolveSources(section.sourceIds, pins);
    const blocks: string[] = [];
    const seen = new Set<string>();
    const add = (raw: unknown): void => {
      if (typeof raw !== 'string') return;
      const clean = stripInvisible(raw).replace(/\s+/g, ' ').trim();
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      blocks.push(clean);
    };

    for (const sourceId of section.sourceIds) {
      if (sourceId.endsWith(':origin')) {
        const pinId = sourceId.slice(0, -':origin'.length);
        const found = pins.find((pin) => pin.id === pinId);
        if (!found) continue;
        add(found.envelope.selection);
        add(found.envelope.surroundingText);
        continue;
      }

      const reference = pins.flatMap((pin) => pin.enrichment?.references ?? [])
        .find((candidate) => candidate.id === sourceId);
      if (!reference?.url) continue;
      try {
        const page = await deps.research.fetchPage(reference.url);
        add(page?.text);
      } catch { /* An unavailable cited page is reported below, never guessed. */ }
    }

    return { text: blocks.join('\n').slice(0, 5_000), resolved };
  }

  async function appendSignal(
    topicId: string, type: Signal['type'], direction: Signal['direction'], sourceEvent: string,
  ): Promise<void> {
    await deps.store.appendSignal({
      id: randomUUID(), topicId, type, direction,
      at: deps.clock.now().toISOString(), sourceEvent, invalidated: false,
    });
  }

  /**
   * Every request is answered inside a budget scope, so that a stop which one
   * handler swallows is still visible on the reply that handler sends. One
   * record per request; two overlapping requests never share it.
   */
  const handle: RequestListener = async (req, res) => {
    /**
     * The preflight is answered before the secret is asked for, and must be.
     *
     * CORS is decided before any credential is presented: a preflight that
     * required the header could never be sent carrying one, so every real
     * request would fail with a browser error naming nothing. Nothing is read
     * off the store here and nothing is written — the reply is the header
     * block and an empty body.
     */
    if (req.method === 'OPTIONS') return json(res, 204, {});

    /**
     * The service-protection contract’s door, and it is in front of **every** route including
     * `/health`.
     *
     * `/health` reports the board's pin count, which is the learner's data, and
     * one route left open is where the next one gets added next to it. Nothing
     * on the platform needs a way past: Cloud Run's default startup probe is a
     * TCP connect on the port rather than an HTTP GET.
     *
     * The body is the same string for a missing header and a wrong one. A
     * refusal that told them apart would answer "keep going, the shape is
     * right".
     */
    if (secret !== null && !secretMatches(req.headers[SHARED_SECRET_HEADER] as string | undefined, secret)) {
      return json(res, 401, { error: 'this service requires a shared secret' });
    }

    // Missing means a legacy client and remains accepted by protocol 1. Once a
    // client identifies itself, an out-of-range value is version skew rather
    // than a generic endpoint refusal. The update side is enough for recovery;
    // no package, path or stack belongs in this body.
    const clientHeader = req.headers[CLIENT_SCHEMA_HEADER];
    if (typeof clientHeader === 'string' && clientHeader.trim()) {
      const clientSchema = Number(clientHeader);
      if (!Number.isInteger(clientSchema) || clientSchema < MIN_CLIENT_SCHEMA_VERSION) {
        return json(res, 426, {
          error: 'This extension is older than the Virgil service. Update the extension.',
          stoppedBy: 'version-skew', update: 'extension',
        });
      }
      if (clientSchema > MAX_CLIENT_SCHEMA_VERSION) {
        return json(res, 426, {
          error: 'This Virgil service is older than the extension. Update the service.',
          stoppedBy: 'version-skew', update: 'service',
        });
      }
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (opts.connectorAuthenticated && !url.pathname.startsWith('/local-connector/jobs/')) {
        throw new Forbidden('a local connector token reaches only its model mailbox');
      }
      if (req.method === 'POST' && url.pathname === '/local-connector/pair') {
        if (!opts.learner || !modelSetupAllowed || !isLocalConnectorStore(deps.store))
          throw new Forbidden('local connector pairing is unavailable on this service');
        const token = createLocalConnectorToken(opts.learner.id);
        await deps.store.pairLocalConnector(localConnectorTokenHash(token));
        return json(res, 200, localConnectorPairingReceipt(token));
      }
      if (req.method === 'DELETE' && url.pathname === '/local-connector/pair') {
        if (!opts.learner || !modelSetupAllowed || !isLocalConnectorStore(deps.store))
          throw new Forbidden('local connector pairing is unavailable on this service');
        await deps.store.unpairLocalConnector();
        return json(res, 200, { disconnected: true });
      }
      if (req.method === 'GET' && url.pathname === '/local-connector/status') {
        if (!isLocalConnectorStore(deps.store)) return json(res, 200, { supported: false, ready: false });
        return json(res, 200, { supported: true, paired: await deps.store.localConnectorPaired(),
          ready: await deps.store.localConnectorReady(deps.clock.now().toISOString()) });
      }
      if (req.method === 'POST' && url.pathname === '/local-connector/jobs/heartbeat') {
        if (!opts.connectorAuthenticated || !isLocalConnectorStore(deps.store))
          throw new Forbidden('a verified local connector pairing is required');
        const body = await readBody(req), now = deps.clock.now().toISOString();
        if (typeof body.jobId !== 'string' || typeof body.leaseId !== 'string')
          throw new BadRequest('jobId and leaseId are required');
        const renewed = await deps.store.renewLocalConnectorJob(body.jobId, body.leaseId, now);
        if (renewed) await deps.store.touchLocalConnector(now);
        return json(res, renewed ? 200 : 409, { ready: renewed });
      }
      if (req.method === 'GET' && url.pathname === '/local-connector/jobs/next') {
        if (!opts.connectorAuthenticated || !isLocalConnectorStore(deps.store)) {
          throw new Forbidden('a verified local connector pairing is required');
        }
        const now = deps.clock.now().toISOString();
        await deps.store.touchLocalConnector(now);
        const job = await deps.store.claimLocalConnectorJob(now, randomUUID());
        if (!job) return json(res, 204, {});
        return json(res, 200, { job });
      }
      const connectorCompletion = /^\/local-connector\/jobs\/([^/]+)\/complete$/.exec(url.pathname);
      if (req.method === 'POST' && connectorCompletion) {
        if (!opts.connectorAuthenticated || !isLocalConnectorStore(deps.store)) {
          throw new Forbidden('a verified local connector pairing is required');
        }
        const body = await readBody(req);
        if (typeof body.leaseId !== 'string') throw new BadRequest('leaseId is required');
        let outcome: { result: import('@sb/core').LocalConnectorResult } | { error: string };
        if (body.result && typeof body.result === 'object' && !Array.isArray(body.result)) {
          const result = body.result as Record<string, unknown>;
          if (typeof result.modelId !== 'string' || typeof result.inputTokens !== 'number'
            || typeof result.outputTokens !== 'number' || !('value' in result)) {
            throw new BadRequest('result is not a valid model receipt');
          }
          outcome = { result: result as unknown as import('@sb/core').LocalConnectorResult };
        } else if (typeof body.error === 'string') {
          outcome = { error: body.error.slice(0, 1_000) };
        } else throw new BadRequest('result or error is required');
        const accepted = await deps.store.finishLocalConnectorJob(
          decodeURIComponent(connectorCompletion[1]!), body.leaseId, outcome,
        );
        return json(res, accepted ? 200 : 409, { accepted });
      }

      if (req.method === 'GET' && url.pathname === '/agent/capabilities') {
        return json(res, 200, {
          protocol: 'virgil-agent-capabilities',
          version: 1,
          boundaries: {
            agent: {
              computerUse: 'agent-owned',
              detail: 'A connected agent may use its own approved browser or computer tools outside Virgil.',
            },
            virgil: {
              launchesBrowser: false,
              runsCommands: false,
              acceptsAuthoritativeAgentWrites: false,
              detail: 'Virgil accepts bounded proposals. Draft review and explicit learner confirmation own authoritative writes.',
            },
          },
          lanes: [
            {
              id: 'content.extract', status: 'ready', method: 'POST', path: '/course-intakes',
              effect: 'draft-only', review: 'POST /course-intakes/:id/apply',
              identity: {
                exact: true, clientRefMaxChars: DROP_CLIENT_REF_MAX_CHARS,
                invisibleControls: false,
                detail: 'Optional on the HTTP lane and required by WebMCP. An exact retry returns the same draft.',
              },
            },
            {
              id: 'imports.bulk-plan', status: 'ready', method: 'POST', path: '/course-intakes/bulk',
              effect: 'draft-only', maxItems: BULK_INTAKE_LIMIT,
              review: 'Each draft must be reviewed and applied separately.',
            },
            {
              id: 'items.classify', status: 'ready', method: 'POST', path: '/classification-previews',
              effect: 'none', maxItems: CLASSIFICATION_PREVIEW_LIMIT,
              identity: CLASSIFICATION_IDENTITY_CONTRACT,
            },
            {
              /**
               * The semester drop, declared honestly as the one lane here whose
               * effect is not `draft-only`.
               *
               * It writes **material** — the documents become pins on the
               * learner's own board, which is what a document they handed over
               * is — and it writes **proposals**, which are drafts nobody has
               * applied. It writes no course, no commitment, no deadline, no
               * topic and no signal. Calling that `draft-only` to keep the
               * column tidy would be the lane telling a connected agent it
               * touches less than it does, which is the one thing this whole
               * declaration exists not to do.
               */
              id: 'imports.course-drop', status: 'ready', method: 'POST', path: '/course-drops',
              effect: 'material-and-drafts', maxItems: DROP_ITEM_LIMIT,
              identity: DROP_IDENTITY_CONTRACT,
              source: DROP_SOURCE_CONTRACT,
              contentBase64: DROP_BASE64_CONTRACT,
              formats: 'GET /course-drops/formats',
              review: 'Each draft must be reviewed and applied separately. Material is visible on the board immediately.',
              detail: 'No model call is made while a drop is being accepted. The batch works the queue through at '
                + `${workCap ?? 'no'} item(s) a run.`,
            },
            {
              id: 'computer.use', status: 'external', owner: 'connected-agent', path: null,
              effect: 'none',
              detail: 'Virgil does not launch, command, or receive control of a browser.',
            },
          ],
        });
      }

      if (req.method === 'POST' && url.pathname === '/classification-previews') {
        const body = await readBody(req);
        if (!Array.isArray(body.items) || body.items.length === 0) {
          throw new BadRequest('items must be a non-empty array');
        }
        if (body.items.length > CLASSIFICATION_PREVIEW_LIMIT) {
          throw new BadRequest(`items must contain at most ${CLASSIFICATION_PREVIEW_LIMIT} entries`);
        }
        const parsed = body.items.map((raw, index) => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new BadRequest(`items.${index} must be an object`);
          }
          const item = raw as Record<string, unknown>;
          const clientRef = exactAgentIdentity(
            item.clientRef, 'clientRef', CLASSIFICATION_CLIENT_REF_MAX_CHARS, refuseBadRequest,
          );
          if (clientRef === null) {
            throw new BadRequest(`items.${index}: clientRef is required, as a non-empty string`);
          }
          return {
            clientRef,
            text: requireString(item, 'text').slice(0, MATCH_MATERIAL),
          };
        });
        if (new Set(parsed.map((item) => item.clientRef)).size !== parsed.length) {
          throw new BadRequest('items must use unique clientRef values');
        }
        const topics = await deps.store.listTopics();
        const byId = new Map(topics.map((topic) => [topic.id, topic]));
        const results = [];
        for (const item of parsed) {
          const matches = (await matchBoard(item.text)).slice(0, 5).map((match) => ({
            topicId: match.topicId,
            label: byId.get(match.topicId)?.label ?? null,
            similarity: match.similarity,
          }));
          results.push({ clientRef: item.clientRef, matches });
        }
        return json(res, 200, { preview: true, authoritativeWrites: 0, results });
      }

      if (req.method === 'GET' && url.pathname === '/pins') {
        const [pins, topics] = await Promise.all([
          deps.store.listPins(),
          deps.store.listTopics(),
        ]);
        return json(res, 200, pinsInbox(pins, topics, url.searchParams.get('limit')));
      }

      if (req.method === 'POST' && url.pathname === '/pins') {
        const request = pinRequestFrom(await readBody(req));
        const made = await createPin(request, request.label ? { label: request.label } : {});
        // A pin arrival may trigger the learner-configured automatic threshold.
        if (!hostedRun) {
          void maybeAutoRun();
          return json(res, 201, made);
        }
        const automatic = await maybeAutoRun();
        return json(res, 201, {
          ...made,
          automaticProcessing: automatic?.kind === 'queued' ? 'queued'
            : automatic?.kind === 'already' ? 'already-running'
              : automatic?.kind === 'failed' ? 'failed' : 'not-due',
        });
      }

      /**
       * the learner's answer after trying the source link.
       *
       * This endpoint never fetches the URL. A server probe would disclose a
       * source, expose private-network reachability and confuse authentication
       * walls with dead pages. The foreground opens the link before it offers
       * these choices; this stores only what the learner then reports. The
       * spread preserves the complete evidence and learning record.
       */
      const pinSourceAvailability = /^\/pins\/([^/]+)\/source-availability$/.exec(url.pathname);
      if (req.method === 'PUT' && pinSourceAvailability) {
        const id = pathId(pinSourceAvailability, 1);
        const body = await readBody(req);
        const status = requireOneOf(body, 'status', ['available', 'unavailable'] as const);
        const sourceAvailability = {
          status,
          checkedAt: deps.clock.now().toISOString(),
          checkedBy: 'learner' as const,
        };
        const saved = await mutateStoredPin(deps.store, id, (current) => ({
          ...current, sourceAvailability,
        }));
        if (!saved) return json(res, 404, { error: 'no such pin' });
        return json(res, 200, pinReceipt(saved));
      }

      /**
       * inspect the original receipt and repair only what the
       * learner said about it.
       *
       * PUT is a complete replacement of the editable state, not an open patch:
       * unknown or omitted fields cannot silently inherit a value the screen
       * was meant to show. A real change clears only derived enrichment so the
       * next processing pass reads the corrected intent. Source, capture time,
       * topic membership, client identity and existing learning history stay
       * byte-for-byte where they were.
       */
      const pinDetail = /^\/pins\/([^/]+)$/.exec(url.pathname);
      if ((req.method === 'GET' || req.method === 'PUT') && pinDetail) {
        const id = pathId(pinDetail, 1);
        const found = await deps.store.getPin(id);
        if (!found) return json(res, 404, { error: 'no such pin' });
        if (req.method === 'GET') return json(res, 200, pinReceipt(found));

        const body = await readBody(req);
        const type = requireOneOf(body, 'type', ['interest', 'struggle'] as const);
        const note = pinNoteFrom(body);
        if (!Object.prototype.hasOwnProperty.call(body, 'requestedRegister')
          || !Object.prototype.hasOwnProperty.call(body, 'requestedMinutes')) {
          throw new BadRequest('requestedRegister and requestedMinutes are required');
        }
        const requestedRegister = body.requestedRegister === null
          ? null
          : requireOneOf(body, 'requestedRegister', REGISTER_ORDER);
        const requestedMinutes = body.requestedMinutes === null
          ? null
          : (() => {
            const value = body.requestedMinutes;
            if (typeof value !== 'number' || !Number.isFinite(value)) {
              throw new BadRequest('requestedMinutes must be a number or null');
            }
            return value;
          })();
        if ((requestedRegister === null) !== (requestedMinutes === null)) {
          throw new BadRequest('requestedRegister and requestedMinutes must be set together');
        }
        const requestedPair = `${requestedRegister ?? 'none'}:${requestedMinutes ?? 'none'}`;
        const allowedPairs = new Set([
          'none:none', 'from-nothing:2', 'fluent:1', 'building:6', 'from-nothing:6',
        ]);
        let changed = false;
        const saved = await mutateStoredPin(deps.store, id, (current) => {
          const storedPair = `${current.requestedRegister ?? 'none'}:${current.requestedMinutes ?? 'none'}`;
          if (!allowedPairs.has(requestedPair) && requestedPair !== storedPair) {
            throw new BadRequest('requested lesson level is not recognised');
          }
          changed = type !== current.type || note !== current.note
            || requestedRegister !== (current.requestedRegister ?? null)
            || requestedMinutes !== (current.requestedMinutes ?? null);
          return changed
            ? {
              ...current, type, note, requestedRegister, requestedMinutes,
              enrichment: null, quickTakeFailure: null,
            }
            : current;
        });
        if (!saved) return json(res, 404, { error: 'no such pin' });
        return json(res, 200, { ...pinReceipt(saved), changed });
      }

      /**
       * UX_SPEC §3 — the "now" moment. The learner pinned something and asked
       * for it straight away rather than this run.
       *
       * **This handler writes no learner evidence.** Not a signal, topic,
       * comfort reading or completion. The two taps underneath are the signal;
       * opening the take is not one, and it follows the same rule as
       * provenance tap — a learner scored for looking at something stops
       * looking. A failed source check may leave an operational receipt on the
       * pin so the same impossible offer is not immediately advertised again;
       * that receipt is never evidence about the learner.
       *
       * There is no pause check here, and that is the learner-action contract rather than an
       * omission. Pause governs what is *watched*; manual capture has been
       * exempt since it was written, and the Scout's label — a model call —
       * already runs on every paused pin. This is the same class of gesture one
       * step further in.
       */
      const take = /^\/pins\/([^/]+)\/quick-take$/.exec(url.pathname);
      const addPinToBoard = /^\/pins\/([^/]+)\/board$/.exec(url.pathname);
      if (req.method === 'POST' && addPinToBoard) {
        const found = await deps.store.getPin(pathId(addPinToBoard, 1));
        if (!found) return json(res, 404, { error: 'no such pin' });
        const topicId = found.topicId ?? await topicForOrphan(found);
        const topic = await deps.store.getTopic(topicId);
        return json(res, 200, {
          ok: true,
          topicId,
          label: topic?.label ?? found.label ?? fallbackLabel(found.envelope),
        });
      }
      if (req.method === 'POST' && take) {
        const found = await deps.store.getPin(pathId(take, 1));
        if (!found) return json(res, 404, { error: 'no such pin' });

        // Whatever the ledger holds about this thing, worked out now rather
        // than whenever the batch last ran. `contextFor` reads the filed topic
        // where the partition has reached this pin and matches the board live
        // where it has not, which on this route is nearly always: the learner
        // pinned it seconds ago. `from-nothing` survives only for material the
        // board genuinely holds nothing about.
        const { register, topic, knownAboutLearner, learnerCorrections } =
          await foregroundTutorContextFor(found);

        const e = found.envelope;
        const exactSelection = e.selection?.replace(/\s+/g, ' ').trim() ?? '';
        // Computed here rather than inside the agent so the screen can show
        // the learner the same string the model was given, to the character.
        // "What you pinned" that is a paraphrase of what was read is worse
        // than not showing it: it would explain a take that came from
        // something else.
        const material = quickTakeMaterialFor(found, QUICK_TAKE_MATERIAL);
        const windowRaw = url.searchParams.get('minutes');
        const windowMinutes = windowRaw === null ? null : Number(windowRaw);
        if (windowMinutes !== null && !([1, 3, 5] as const).includes(windowMinutes as 1 | 3 | 5)) {
          throw new BadRequest('quick-take minutes must be 1, 3 or 5');
        }
        const result = await quickTake(at('quick-take'), {
          material,
          focus: exactSelection || null,
          headingPath: Array.isArray(e.headingPath) ? e.headingPath : [],
          pageTitle: e.pageTitle ?? '',
          note: found.note,
          register,
          knownAboutLearner,
          learnerCorrections,
          // Follow-on guide/question routes share this input envelope. The
          // quick take itself ignores this broader guide and applies the
          // source-bound QUICK_TAKE_DEPTH_GUIDE in the Tutor.
          guide: DEPTH_GUIDE[register],
          // Standard's lesson level, where the learner set one. Clamped in the
          // agent, so a stored number from an older or stranger client cannot
          // buy an unbounded foreground call. Spread rather than passed as
          // `undefined`: this build states a field or omits it.
          ...(windowMinutes !== null
            ? { minutes: windowMinutes }
            : typeof found.requestedMinutes === 'number' ? { minutes: found.requestedMinutes } : {}),
        });

        const attemptedMinutes = clampTakeMinutes(windowMinutes
          ?? (typeof found.requestedMinutes === 'number' ? found.requestedMinutes : null));
        if (result.outcome !== 'ready' && result.failureReason) {
          const failureReason = result.failureReason;
          await mutateStoredPin(deps.store, found.id, (current) => ({
            ...current,
            quickTakeFailure: {
              materialKey: quickTakeMaterialKey(material),
              register,
              minutes: attemptedMinutes,
              reason: failureReason,
              attemptedAt: deps.clock.now().toISOString(),
            },
          }));
        } else if (result.outcome === 'ready' && found.quickTakeFailure) {
          await mutateStoredPin(deps.store, found.id, (current) => ({
            ...current, quickTakeFailure: null,
          }));
        }

        let subject: ReturnType<typeof subjectForTopic> = null;
        if (topic) {
          const [courses, commitments] = await Promise.all([
            deps.store.listCourses(), deps.store.listCommitments(),
          ]);
          subject = subjectForTopic(topic.id, courses, commitments);
        }
        const topicLabel = topic?.label ?? found.label ?? fallbackLabel(e);
        const sourceArea = [...(Array.isArray(e.headingPath) ? e.headingPath : [])]
          .reverse().find((part) => part.trim() && part.trim().toLowerCase() !== topicLabel.toLowerCase())
          ?? (e.pageTitle?.trim().toLowerCase() !== topicLabel.toLowerCase() ? e.pageTitle : null)
          ?? found.label
          ?? fallbackLabel(e);

        return json(res, 200, {
          outcome: result.outcome,
          failureReason: result.failureReason ?? null,
          body: result.body,
          heading: result.heading ?? sourceArea,
          register: result.register,
          // A foreground lesson is still about the filed topic even though it
          // is not promoted into a stored Session Section. The canonical Learn
          // shell needs the id for destination receipts and to exclude the
          // lesson itself from Learn next; null is honest for a fresh orphan.
          topicId: topic?.id ?? found.topicId ?? null,
          subject,
          topicLabel,
          label: topicLabel,
          /** Return the exact pinned material and whether it was a selection. */
          pinned: {
            // The learner pinned the selection, not its containing paragraph.
            // Context may support the lesson but must not be relabelled as
            // their choice on the receipt above it.
            text: exactSelection || material,
            kind: e.selection ? 'selection' : 'page',
            pageTitle: e.pageTitle ?? '',
            url: e.url ?? null,
            note: found.note,
          },
        });
      }

      /**
       * `mode-guide-me`: the passage turned into the steps it is asking for.
       *
       * Same shape as the quick take and deliberately so: same register off
       * the same ledger, same material, same "there is no Verifier here" rule.
       * What differs is that the answer is a list somebody walks rather than
       * prose somebody reads, and that it can honestly come back saying the
       * passage sets no task at all.
       */
      const guide = /^\/pins\/([^/]+)\/guide$/.exec(url.pathname);
      if (req.method === 'POST' && guide) {
        const found = await deps.store.getPin(pathId(guide, 1));
        if (!found) return json(res, 404, { error: 'no such pin' });

        const { register, topic, knownAboutLearner, learnerCorrections } =
          await foregroundTutorContextFor(found);
        const e = found.envelope;
        const material = (e.selection ?? e.surroundingText ?? '').slice(0, GUIDE_MATERIAL);
        const input = {
          material,
          headingPath: Array.isArray(e.headingPath) ? e.headingPath : [],
          pageTitle: e.pageTitle ?? '',
          note: found.note,
          register,
          guide: DEPTH_GUIDE[register],
          knownAboutLearner,
          learnerCorrections,
        };
        const result = await guideSteps(at('guide'), input);

        return json(res, 200, {
          outcome: result.outcome,
          steps: result.steps,
          register: result.register,
          label: topic?.label ?? found.label ?? fallbackLabel(e),
          pinned: {
            text: material,
            kind: e.selection ? 'selection' : 'page',
            pageTitle: e.pageTitle ?? '',
            url: e.url ?? null,
            note: found.note,
          },
        });
      }

      /**
       * One step, explained, because they said they were stuck on it.
       *
       * The step comes back from the panel rather than being looked up here,
       * because the guide is not stored: it is a foreground artefact of one
       * screen, and writing it to the ledger would put a second copy of the
       * night's material in a store whose one-ledger law exists to prevent
       * exactly that. The panel holds the list it is walking; this endpoint
       * teaches one line of it.
       *
       * The signal IS written, and it is the point. A learner who says they
       * are stuck has told the comfort map something no amount of reading
       * infers, and `struggle-signal` is the same one a struggle pin carries.
       */
      const stuck = /^\/pins\/([^/]+)\/guide\/stuck$/.exec(url.pathname);
      if (req.method === 'POST' && stuck) {
        const pinId = pathId(stuck, 1);
        const found = await deps.store.getPin(pinId);
        if (!found) return json(res, 404, { error: 'no such pin' });
        const body = await readBody(req);
        const action = typeof body['action'] === 'string' ? body['action'] : '';
        const why = typeof body['why'] === 'string' ? body['why'] : '';
        if (!action) return json(res, 400, { error: 'no step' });

        const { register, knownAboutLearner, learnerCorrections } =
          await foregroundTutorContextFor(found);
        const e = found.envelope;
        const explained = await explainStep(at('guide-stuck'), {
          material: (e.selection ?? e.surroundingText ?? '').slice(0, GUIDE_MATERIAL),
          headingPath: Array.isArray(e.headingPath) ? e.headingPath : [],
          pageTitle: e.pageTitle ?? '',
          note: found.note,
          register,
          guide: DEPTH_GUIDE[register],
          knownAboutLearner,
          learnerCorrections,
        }, { action, why });

        // The signal is the point, and it is written whether or not the model
        // managed to explain anything: the learner told us they could not do
        // this step, and that fact does not depend on how well we answered it.
        // One per step per pin, so a learner who taps twice on the same step
        // has said one thing.
        const topicId = found.topicId ?? await topicForOrphan(found);
        const sourceEvent = `guide-stuck:${pinId}:${action.slice(0, 120)}`;
        const already = (await deps.store.listSignals(topicId))
          .find((sig) => sig.sourceEvent === sourceEvent && !sig.invalidated);
        if (!already) await appendSignal(topicId, 'guide-stuck', 'negative', sourceEvent);

        return json(res, 200, {
          outcome: explained.outcome,
          body: explained.body,
          topicId,
          counted: !already,
        });
      }

      /**
       * The learner asks about what they pinned.
       *
       * The answer stays grounded in the learner's material. A question that
       * becomes a subject of its own is offered as a new pin rather than
       * expanded into an unbounded essay. Request size is capped to the source,
       * current register, and a short rolling exchange.
       *
       * The exchange comes from the panel rather than the store. It is a
       * foreground artefact of one screen, and writing it to the ledger would
       * put a transcript in a board whose one-ledger law exists to hold
       * material rather than conversation.
       */
      const ask = /^\/pins\/([^/]+)\/ask$/.exec(url.pathname);
      if (req.method === 'POST' && ask) {
        const pinId = pathId(ask, 1);
        const found = await deps.store.getPin(pinId);
        if (!found) return json(res, 404, { error: 'no such pin' });
        const body = await readBody(req);
        const question = requireTrimmedBoundedString(body, 'question', ASK_TURN_CHARS);
        const exchange = Array.isArray(body['exchange']) ? body['exchange'] as AskTurn[] : [];

        const { register, knownAboutLearner, learnerCorrections } =
          await foregroundTutorContextFor(found);
        const e = found.envelope;

        const answered = await askAboutPin(at('ask'), {
          material: (e.selection ?? e.surroundingText ?? '').slice(0, QUICK_TAKE_MATERIAL),
          headingPath: Array.isArray(e.headingPath) ? e.headingPath : [],
          pageTitle: e.pageTitle ?? '',
          note: found.note,
          register,
          guide: DEPTH_GUIDE[register],
          knownAboutLearner,
          learnerCorrections,
          ...(typeof found.requestedMinutes === 'number' ? { minutes: found.requestedMinutes } : {}),
        }, question, exchange);

        return json(res, 200, {
          outcome: answered.outcome,
          body: answered.body,
          offerAsPin: answered.offerAsPin,
          register,
        });
      }

      /**
       *  — *got it* / *still shaky*, the reason the quick take exists.
       *
       * Two things this has to decide that the agent cannot.
       *
       * **Which topic.** §3's argument for the whole feature is signal *"on day
       * zero of a topic"*, and on day zero there is no topic: clustering is
       * overnight work. So a pin with no topic gets one here, exactly as the
       * cluster stage already does for a pin the partition dropped — its own
       * topic, labelled from the page, which the nightly then treats as an
       * existing topic and attaches to rather than re-deciding. The two
       * alternatives were worse: holding the tap in a second store until the
       * nightly caught up is the parallel bookkeeping the one-ledger law
       * exists to refuse, and dropping it makes  inert in exactly the case
       * it was written for.
       *
       * **That it lands once, and can be corrected.** Same shape as the lineup
       * verdict: one active `sourceEvent` per pin. An identical retry is a
       * no-op; an opposite later choice withdraws the old signal and appends
       * the new one. Reopening a pin is an ordinary learner action, so keeping
       * the first answer forever would make the second button lie. The verdict
       * is validated against the set the panel offers before anything is
       * written; an unrecognised value never defaults into learner evidence.
       *  third answer added no third mechanism: what each tap writes
       * lives in `QUICK_TAKE_MARKS`, beside the consumers that read those kinds.
       */
      const verdict = /^\/pins\/([^/]+)\/quick-take\/verdict$/.exec(url.pathname);
      if (req.method === 'POST' && verdict) {
        const pinId = pathId(verdict, 1);
        const which = requireOneOf(await readBody(req), 'verdict', QUICK_TAKE_VERDICTS);
        const found = await deps.store.getPin(pinId);
        if (!found) return json(res, 404, { error: 'no such pin' });

        const topicId = found.topicId ?? await topicForOrphan(found);
        const sourceEvent = `quick-take:${pinId}`;
        const standing = (await deps.store.listSignals(topicId))
          .filter((s) => s.sourceEvent === sourceEvent && !s.invalidated);
        const { type, direction, backAfterDays } = QUICK_TAKE_MARKS[which];
        const answered = { ok: true, topicId, verdict: which, backAfterDays };
        if (standing.some((s) => s.type === type)) {
          return json(res, 200, { ...answered, alreadyAnswered: true, changed: false });
        }
        if (standing.length) await deps.store.invalidateSignals(sourceEvent);
        await appendSignal(topicId, type, direction, sourceEvent);
        return json(res, 200, { ...answered, changed: standing.length > 0 });
      }
      // §5 zone 1. The session is carried unchanged — every existing client
      // reads it — and the card is the panel's whole first screen beside it.
      /**
       * Served with the model's source markers taken out of the prose.
       *
       * `stripSourceMarkers` runs at composition, so everything written from
       * now on is clean — but every session already in a store was composed
       * before that and still carries "[14a110e6]" mid-sentence. Cleaning on
       * READ rather than migrating the store keeps the ledger exactly as the
       * Composer wrote it, which is what the provenance work depends on, and
       * fixes what a learner sees this run rather than after the next run.
       */
      if (req.method === 'GET' && url.pathname === '/session') {
        const stored = await deps.store.latestSession();
        const { topics, decisions, comforts, signals } =
          await readBoardState(requestTimeZone(req));
        const safeStored = stored ? projectSafeSession(stored, topics) : stored;
        /**
         * The learner-lineup contract’s `(i)`, for a session composed before there was one.
         *
         * The Composer writes `why` onto every section it commissions now, so
         * everything built from here carries the ranker's own sentence. Rows
         * already in the store carry nothing, and the honest answer for those
         * is the same pure ranker read now: `readBoardState` has already run
         * `tend` for the card, and this is the same decision list the card's
         * why-line is drawn from.
         *
         * Filled only where the section is silent. A stored reason is what the
         * run actually ranked on and is never overwritten by a fresher one —
         * that would make the disclosure agree with today instead of with the
         * night the lineup was built.
         */
        const reasons = new Map(decisions.map((d) => [d.topicId, d.reason]));
        /** Derive current course membership instead of freezing it at composition. */
        const [courses, commitments, pins, prefs] = await Promise.all([
          deps.store.listCourses(), deps.store.listCommitments(), deps.store.listPins(),
          deps.store.getPrefs(),
        ]);
        /** Prefer the section summary, then the topic summary; never infer from prose. */
        // Empty labels and summaries are absent; remove prompt framing from gists.
        const named = new Map(topics.map((t) => [t.id,
          { gist: unframeGist(t.summary) || null, label: (t.label ?? '').trim() || null }] as const));
        const actionableSections = safeStored ? ensureLearnerAction(safeStored.sections) : [];
        const session = safeStored
          ? {
            ...safeStored,
            sections: actionableSections.map((sec) => ({
              ...sec,
              body: cleanSectionBody(sec.body),
              why: sec.why ?? reasons.get(sec.topicId) ?? null,
              summary: sec.summary ?? named.get(sec.topicId)?.gist ?? null,
              subject: subjectForTopic(sec.topicId, courses, commitments),
              topicLabel: named.get(sec.topicId)?.label ?? null,

              // The interface-affordance contract: the deadline this lesson moves forward, shown on
              // the row it is about instead of announced over all of them.
              serves: commitmentForTopic(sec.topicId, commitments, deps.clock.now()),
              // Derived, like `subject`: a stored session has to say this too.
              grounding: lessonGroundingFor(sec.topicId, pins, comforts, deps.clock.now()),
            })),
          }
          : safeStored;
        /** List owed topics outside tonight, with only source-supported quick takes. */
        const tonight = new Set(safeStored?.sections.map((sec) => sec.topicId) ?? []);
        const held = new Set((safeStored?.withheld ?? []).map((w) => w.topicId));
        const comfortById = new Map(comforts.map((c) => [c.topicId, c]));
        const byId = new Map(topics.map((t) => [t.id, t]));
        const pinById = new Map(pins.map((pin) => [pin.id, pin]));
        const upcoming = decisions
          .filter((d) => !tonight.has(d.topicId))
          .filter((d) => held.has(d.topicId)
            || d.disposition === 'teach' || d.disposition === 'review'
            || d.disposition === 'resurface'
            || d.reason.startsWith('you took this out of a lineup'))
          .sort((a, b) => (held.has(b.topicId) ? 1 : 0) - (held.has(a.topicId) ? 1 : 0)
            || b.priority - a.priority
            || a.topicId.localeCompare(b.topicId))
          .flatMap((d) => {
            const topic = byId.get(d.topicId);
            if (!topic || topic.retiredByUser) return [];
            /**
             * A quick take is one immediate read of this topic's material.
             * Once either closing verdict lands, offering the same topic again
             * under "Something else instead" contradicts the close in the exact
             * screen it returns to. The row still travels — the Gardener owns
             * whether the topic needs a proper lesson, and a topic with no door
             * on it lives on the board — but the immediate door is removed
             * until a later session exposes the topic and answers that verdict.
             */
            const answeredSinceLesson = signals.some((signal) =>
              signal.topicId === topic.id && !signal.invalidated
              && (signal.type === 'quick-take-got-it' || signal.type === 'quick-take-still-shaky')
              && (!topic.lastExposedAt || signal.at >= topic.lastExposedAt));
            const register = registerFor(comfortById.get(topic.id));
            const viable = topic.pinIds
              .map((id) => pinById.get(id))
              .filter((pin): pin is Pin => Boolean(pin))
              .map((pin) => ({
                pin,
                minutes: quickTakeOfferMinutes(pin, prefs.availableMinutes ?? 5, register),
              }))
              .find((candidate) => candidate.minutes !== null);
            return [{
              topicId: topic.id,
              label: topic.label,
              register,
              why: d.reason,
              // Held back is a different fact from next in the queue, and the
              // panel words it rather than guessing from the reason line.
              heldBack: held.has(topic.id),
              pinId: answeredSinceLesson ? null : viable?.pin.id ?? null,
              quickTakeMinutes: answeredSinceLesson ? null : viable?.minutes ?? null,
            }];
          })
          .slice(0, UPCOMING_ROWS);

        return json(res, 200, {
          session,
          // The card is computed from the STORED session, not the cleaned copy:
          // it reads headings, durations and registers, none of which this
          // touches, and computing it from a derived object would be one more
          // thing that can drift from the ledger.
          card: sessionCard({ session: safeStored, topics, decisions, pinsWaiting: pinsWaitingIn(pins) }),
          upcoming,
        });
      }

      /**
       * §5 zone 3 — the short list of things the learner asked for.
       *
       * Capped here rather than in the panel, so the "and N more" the learner
       * reads is a number the service computed and not one a template counted
       * off a list it had already truncated.
       */
      if (req.method === 'GET' && url.pathname === '/flagged') {
        const { topics, signals, comforts, now } =
          await readBoardState(requestTimeZone(req));
        const rows = flaggedRows({ topics, signals, comforts, now });
        return json(res, 200, {
          rows: rows.slice(0, FLAGGED_ROWS),
          more: Math.max(0, rows.length - FLAGGED_ROWS),
        });
      }

      /**
       * §5 zone 2 — the momentum strip, which is an echo and not a source.
       *
       * Read-only by law (§5a) and by `progression-purity.test.ts`: the
       * projection is built from a snapshot the gatherer took and is handed
       * plain arrays, so there is no path from this endpoint to the ledger.
       */
      if (req.method === 'GET' && url.pathname === '/progression') {
        const strip = stripFrom(projectProgression(await progressionSnapshot(deps.store, deps.clock)));
        return json(res, 200, { strip });
      }

      /**
       * §5 — the award moment: session close, where it was earned.
       *
       * Deliberately a different endpoint from the strip, because they are
       * different moments in the product even though they read one projection.
       * A session id that is not in the store is a 404 rather than an empty
       * list: "this session earned nothing" and "there is no such session" are
       * different answers and the panel should not have to guess which it got.
       */
      const awards = /^\/sessions\/([^/]+)\/awards$/.exec(url.pathname);
      if (req.method === 'GET' && awards) {
        const found = await deps.store.getSession(pathId(awards, 1));
        if (!found) return json(res, 404, { error: 'no such session' });
        const projection = projectProgression(await progressionSnapshot(deps.store, deps.clock));
        return json(res, 200, { awards: awardsForSession(projection, found.builtAt) });
      }

      if (req.method === 'GET' && url.pathname === '/board') {
        /**
         * The board, and the pins that have not reached it yet.
         *
         * `topicId` is written by the nightly Clusterer and by nothing else, so
         * everything pinned since the last run belongs to no topic — and the
         * board returned topics only. A learner who signed in, pinned one thing
         * and opened the board was told "Nothing here yet." three times, on the
         * screen every failure message in this product sends them to with the
         * words "It is saved and it is on your board".
         *
         * Bounded by construction: this list drains at the next run. It is not
         * a queue and there is no endpoint that clears it.
         */
        const pins = await deps.store.listPins();
        const boardNow = deps.clock.now();
        const boardSignals = await deps.store.listSignals();
        return json(res, 200, {
          // Current clients show unprocessed captures in Learn → Pins. The
          // flag lets older extensions keep rendering `unfiled` on Board while
          // current ones avoid showing the same material in two places.
          pinInbox: true,
          topics: (await deps.store.listTopics())
            .map((t) => ({
              ...t,
              // Same repair as the lineup's fallback, at the other place a
              // stored gist reaches a learner. The board renders this sentence
              // under every card, so a framed one is the same defect on more
              // rows: "The learner is trying to understand..." said to the
              // learner. See `unframeGist`.
              summary: unframeGist(t.summary),
              area: boardAreaFor(t, boardSignals, boardNow),
            })),
          suggestions: await deps.store.listSuggestions('pending'),
          unfiled: pins
            .filter((p) => !p.topicId)
            // Newest first: the thing somebody just pinned is the thing they
            // opened the board to look for.
            .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1))
            .map((p) => ({
              id: p.id,
              // The Scout's label if it made one, which is the subject rather
              // than the page's section — the distinction the take screen was
              // getting wrong until the label stopped being discarded.
              title: p.label ?? p.envelope.pageTitle ?? '',
              gist: (p.envelope.selection ?? p.envelope.surroundingText ?? '').slice(0, 140),
            })),
        });
      }
      const recap = /^\/sessions\/([^/]+)\/recap$/.exec(url.pathname);
      if (req.method === 'GET' && recap) {
        const found = await deps.store.getSession(pathId(recap, 1));
        if (!found) return json(res, 404, { error: 'no such session' });

        const touched = lastTouchedAt(found.id, found.builtAt, await deps.store.listSignals());
        const stale = isStaleResume(touched, deps.clock.now().getTime());
        if (!stale) return json(res, 200, { enabled: true, stale, lines: [] });

        // Only what they finished. A section they never saw is not something to
        // be reminded of, and the Tutor's context does not accumulate.
        const finished = found.sections.filter((s) => s.completed);
        return json(res, 200, { enabled: true, stale, lines: recapSoFar(finished) });
      }

      /**
       *  — "Check my work", and the Reviewer's way in.
       *
       * `review()` began as written and tested but unreachable. The review-route contract wired
       * it; ordinary lessons now also reach the Tutor's tangent and full
       * source-rechecking correction behaviors.
       *
       * The plainest handler in the service, and deliberately: it takes a
       * draft, reads the board for the weak spots, answers, and **writes
       * nothing**.  loop back to the board is one tap further on and is
       * the learner's to make — a check that quietly recorded a weakness every
       * time somebody pasted a draft would be scoring them for asking to be
       * checked, which is the same rule that keeps  provenance tap
       * signal-free.
       *
       * A failed review is a 200 that says so rather than a 500. The learner
       * pressed a button and is owed a sentence about what happened; the one
       * thing that must never come back is an empty list read as a clean bill
       * of health, which is why `outcome` exists at all.
       */
      /**
       * ASSIGNMENT QC — the work, the bar it is marked against, and a row each.
       *
       * The sibling of `/review` and a different job: that one reads a draft
       * against what the learner is shaky on, this one reads a piece of work
       * against criteria somebody else set. The rubric is pasted, parsed in
       * code, and scanned for hostile instructions before it reaches a prompt
       * (`domain/rubric.ts`, the fidelity gate).
       *
       * `verdict` is computed from the rows by a rule the agent cannot reach
       * into: **one miss is a send-back, and there is no averaging.**
       */
      if (req.method === 'POST' && url.pathname === '/mark') {
        const body = await readBody(req);
        // Validated before `work`, because it decides whether `work` is
        // required at all: when the learner sent the file as it is, the pages
        // ARE the work and the textarea is legitimately empty.
        const media = optionalMedia(body, 'media');
        const work = media.length ? optionalString(body, 'work') : requireString(body, 'work');
        const rubric = requireString(body, 'rubric');
        // The third box, and the only optional one: what they were asked to do,
        // in their lecturer's words or their own.
        const context = optionalString(body, 'context');
        const { topics, comforts } = await readBoardState(requestTimeZone(req));
        let result;
        try {
          result = await markAssignment(
            at('mark'), work, rubric, topics, comforts, context, media,
          );
        } catch (err) {
          if (err instanceof RubricLimitError) throw new BadRequest(err.message);
          throw err;
        }
        if (result.rewritesDropped > 0) {
          console.warn(`[service] the marker offered ${result.rewritesDropped} rewrite(s); dropped`);
        }
        const labels = new Map(topics.map((t) => [t.id, t.label]));
        return json(res, 200, {
          outcome: result.outcome,
          verdict: result.verdict,
          // The sentence at the top, written where the rule that decides it
          // lives, so the summary and the verdict cannot drift apart. A refusal
          // gets its own sentence: "I could not find any criteria" is the wrong
          // diagnosis when the criteria parsed fine and the model call is what
          // failed, and a learner would act on it by editing a rubric that was
          // never the problem.
          summary: markRefusalSummary(result.outcome)
            ?? markSummary(result.rows.map((r) => r.verdict)),
          rows: result.rows.map((r) => ({
            ...r,
            relatedTopicLabel: r.relatedTopicId ? labels.get(r.relatedTopicId) ?? null : null,
          })),
          // Reported, never silently dropped: a brief carrying an instruction
          // aimed at the AI layer is a fact the learner should be told. Each
          // entry names the box it came out of, so the screen can say which
          // paste to look at rather than which list.
          quarantined: result.quarantined,
          // And so is a piece of work that was longer than the marker could
          // read. "I marked your work" and "I marked the first two thousand
          // words of it" are different claims.
          truncated: result.truncated,
          contextTruncated: result.contextTruncated,
        });
      }

      if (req.method === 'POST' && url.pathname === '/review') {
        const body = await readBody(req);
        const media = optionalMedia(body, 'media');
        const draft = media.length ? optionalString(body, 'draft') : requireString(body, 'draft');
        const context = optionalString(body, 'context');
        const { topics, comforts } = await readBoardState(requestTimeZone(req));
        const result = await review(at('review'), draft, topics, comforts, context, media);
        if (result.rewritesDropped > 0) {
          // The reviewer-boundary contract is the line this product does not cross, so a model
          // that started drafting is a log line rather than a silent filter.
          console.warn(`[service] the reviewer offered ${result.rewritesDropped} rewrite(s); dropped`);
        }
        const labels = new Map(topics.map((t) => [t.id, t.label]));
        return json(res, 200, {
          outcome: result.outcome,
          // The exact list admitted by Reviewer, not a count reconstructed from
          // findings: a clean result can still have used personalised context.
          weakTopicCount: result.weakTopicCount,
          findings: result.findings.map((f) => ({
            ...f,
            // Resolved here rather than in the panel: a finding is read on its
            // own, and the panel should not have to hold the whole board to
            // render one line of it.
            relatedTopicLabel: f.relatedTopicId ? labels.get(f.relatedTopicId) ?? null : null,
          })),
          // The Marker has said both of these since it was written and this
          // endpoint said neither: a draft over the cap was sliced in silence,
          // so "this reads sound" could be a claim about the first four pages
          // of eight. Same fields, same meaning, one screen.
          truncated: result.truncated,
          contextTruncated: result.contextTruncated,
          quarantined: result.quarantined,
        });
      }

      /**
       * The pages, typed out, so the criteria box can hold rows again.
       *
       * The one place the as-is route does NOT go. A draft can be sent to the
       * marker as pictures because the model reads the pictures; the CRITERIA
       * are parsed in code, verbatim, one row per line ( the criteria-extraction contract), and no
       * amount of pixels can be split into rows. A rubric that arrives as a
       * scan therefore has one honest path: read the pages, put the text in the
       * box the learner can edit, and let them check it before it becomes the
       * bar their work is marked against.
       *
       * Two properties this endpoint has and must keep. It writes NOTHING —
       * same rule as `/mark` and `/review` beside it, and for the same reason:
       * a learner scored for asking to be helped stops asking. And it returns
       * text rather than acting on it, so nothing is marked against a
       * transcription nobody has read.
       *
       * `outcome` exists for the same reason it exists on the two endpoints
       * above: an empty string from a failed call and an empty string from a
       * blank page are the same value, and only one of them means "there were
       * no words on those pages".
       */
      if (req.method === 'POST' && url.pathname === '/transcribe-pages') {
        const body = await readBody(req);
        const media = optionalMedia(body, 'media');
        if (!media.length) {
          throw new BadRequest('media is required, as an array of at least one data: image URI');
        }
        const result = await transcribePages(at('transcribe'), media);
        return json(res, 200, {
          outcome: result.outcome,
          text: result.text,
          pageCount: result.pageCount,
        });
      }

      /**
       *  — a lesson can be questioned without turning Virgil into an
       * unbounded generic chat. The current lesson and two rolling turns are
       * the complete context; asking writes no learning evidence. If the Tutor
       * says the question has become its own subject, a second deliberate tap
       * creates an ordinary interest pin from the original lesson source.
       */
      const tangent = /^\/sessions\/([^/]+)\/sections\/([^/]+)\/tangent$/.exec(url.pathname);
      if (req.method === 'POST' && tangent) {
        const [sessionId, topicId] = [pathId(tangent, 1), pathId(tangent, 2)];
        const session = await deps.store.getSession(sessionId);
        const section = session?.sections.find((s) => s.topicId === topicId);
        if (!session || !section) return json(res, 404, { error: 'no such section' });

        const body = await readBody(req);
        const question = requireBoundedString(body, 'question', TANGENT_QUESTION_CHARS);
        const rawHistory = body['history'];
        if (rawHistory !== undefined && !Array.isArray(rawHistory)) {
          throw new BadRequest('history must be an array');
        }
        const history = (Array.isArray(rawHistory) ? rawHistory : []).slice(-2).map((raw, index) => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new BadRequest(`history.${index} must be an object`);
          }
          const turn = raw as Record<string, unknown>;
          return {
            question: requireBoundedString(
              turn, 'question', TANGENT_QUESTION_CHARS, `history.${index}.question`,
            ),
            answer: requireBoundedString(
              turn, 'answer', TANGENT_ANSWER_CHARS, `history.${index}.answer`,
            ),
          };
        });
        const answered = await answerTangent(at('tangent'), question, {
          heading: section.heading, register: section.depth, body: section.body, history,
        });
        const answer = typeof answered.answer === 'string'
          ? unicodePrefix(stripInvisible(answered.answer).trim(), TANGENT_ANSWER_CHARS) : '';
        const offerAsPin = typeof answered.offerAsPin === 'string'
          ? stripInvisible(answered.offerAsPin).replace(/\s+/g, ' ').trim().slice(0, 120) || null
          : null;
        return json(res, 200, { answer, offerAsPin });
      }

      const tangentPin = /^\/sessions\/([^/]+)\/sections\/([^/]+)\/tangent-pin$/.exec(url.pathname);
      if (req.method === 'POST' && tangentPin) {
        const [sessionId, topicId] = [pathId(tangentPin, 1), pathId(tangentPin, 2)];
        const session = await deps.store.getSession(sessionId);
        const section = session?.sections.find((s) => s.topicId === topicId);
        if (!session || !section) return json(res, 404, { error: 'no such section' });

        const body = await readBody(req);
        const question = requireBoundedString(body, 'question', 800);
        const label = requireString(body, 'label').slice(0, 120);
        const clientRef = requireString(body, 'clientRef').slice(0, 180);
        const pins = await deps.store.listPins();
        const topic = await deps.store.getTopic(topicId);
        const directSourceIds = new Set(section.sourceIds
          .filter((id) => typeof id === 'string' && id.endsWith(':origin'))
          .map((id) => id.slice(0, -':origin'.length)));
        const source = pins.find((pin) => directSourceIds.has(pin.id))
          ?? pins.find((pin) => topic?.pinIds.includes(pin.id))
          ?? pins.find((pin) => pin.topicId === topicId)
          ?? null;
        if (!source) {
          return json(res, 409, { error: 'This lesson has no original pin to carry onto the board.' });
        }

        const made = await createPin({
          type: 'interest',
          envelope: {
            ...source.envelope,
            headingPath: [...source.envelope.headingPath, section.heading].slice(-8),
          },
          note: `Question from “${section.heading}”: ${question}`.slice(0, 1_000),
          clientRef,
        }, { label });
        if (!hostedRun) void maybeAutoRun();
        else await maybeAutoRun();
        return json(res, 201, made);
      }

      const src = /^\/sessions\/([^/]+)\/sections\/([^/]+)\/sources$/.exec(url.pathname);
      if (req.method === 'GET' && src) {
        const [sessionId, topicId] = [pathId(src, 1), pathId(src, 2)];
        const found = await deps.store.getSession(sessionId);
        const sec = found?.sections.find((s) => s.topicId === topicId);
        if (!found || !sec) return json(res, 404, { error: 'no such section' });
        return json(res, 200, resolveSources(sec.sourceIds, await deps.store.listPins()));
      }

      /**
       *  — challenge a claim Virgil taught, not a mark Virgil gave.
       *
       * The source recheck and the stored exchange are one operation. Asking a
       * model without cited text would turn a trust surface into another guess,
       * so unavailable evidence is a visible 409 and writes nothing. A stable
       * client reference makes the learner's retry the same exchange rather
       * than a second model argument.
       */
      const correction = /^\/sessions\/([^/]+)\/sections\/([^/]+)\/correction$/.exec(url.pathname);
      if (req.method === 'POST' && correction) {
        const [sessionId, topicId] = [pathId(correction, 1), pathId(correction, 2)];
        const found = await deps.store.getSession(sessionId);
        const sec = found?.sections.find((s) => s.topicId === topicId);
        if (!found || !sec) return json(res, 404, { error: 'no such section' });

        const body = await readBody(req);
        const challenge = requireString(body, 'challenge').trim();
        if (Array.from(challenge).length > 2_000) {
          throw new BadRequest('challenge must contain at most 2,000 characters');
        }
        const clientRef = requireString(body, 'clientRef').trim().slice(0, 200);
        const existing = sec.corrections?.find((entry) => entry.clientRef === clientRef);
        if (existing) {
          const returnedSession = existing.conceded
            ? projectSafeSession(found, await deps.store.listTopics())
            : found;
          return json(res, 200, {
            correction: existing,
            section: returnedSession.sections.find((section) => section.topicId === topicId),
            ...resolveSources(sec.sourceIds, await deps.store.listPins()),
            alreadyChecked: true,
          });
        }

        const evidence = await correctionEvidence(sec);
        if (!evidence.text) {
          return json(res, 409, {
            error: 'Virgil could not reread the cited source. Nothing was changed.',
            stoppedBy: 'source-unavailable',
            ...evidence.resolved,
          });
        }

        const checked = await handleCorrection(at('correction'), sec.body, evidence.text, challenge);
        const reply = stripInvisible(checked.reply).trim().slice(0, 2_000);
        if (!reply) {
          return json(res, 503, {
            error: 'Virgil could not complete the source recheck. Nothing was changed.',
            ...evidence.resolved,
          });
        }

        let withdrawn = 0;
        if (checked.conceded) {
          const derivedEvents = new Set([
            `answer:${sessionId}:${topicId}`,
            `skip:${sessionId}:${topicId}`,
            `depth:${sessionId}:${topicId}`,
            `resurface:${sessionId}:${topicId}`,
          ]);
          const live = (await deps.store.listSignals(topicId))
            .filter((signal) => derivedEvents.has(signal.sourceEvent) && !signal.invalidated);
          withdrawn = live.length;
          for (const sourceEvent of new Set(live.map((signal) => signal.sourceEvent))) {
            await deps.store.invalidateSignals(sourceEvent);
          }
        }

        const record = {
          id: randomUUID(), clientRef, claim: sec.body, challenge, reply,
          conceded: checked.conceded, sourceIds: [...sec.sourceIds], withdrawn,
          at: deps.clock.now().toISOString(),
        };
        const sections = found.sections.map((section) => section.topicId === topicId
          ? {
            ...section,
            ...(record.conceded ? { body: reply } : {}),
            corrections: [...(section.corrections ?? []), record],
          }
          : section);
        const candidate = { ...found, sections };
        // One pure rule serves the new write, historical `/session` reads,
        // Today, backup and Notebook export. A conceded claim cannot survive
        // merely because one consumer forgot which authored field could hold it.
        const updated = record.conceded
          ? retireConcededLessonShell(candidate, await deps.store.listTopics())
          : candidate;
        await deps.store.putSession(updated);
        return json(res, 200, {
          correction: record,
          section: updated.sections.find((section) => section.topicId === topicId),
          ...evidence.resolved,
        });
      }

      /**
       * The learner-lineup contract — the order the learner put tonight's lineup in.
       *
       * Session-scoped rather than section-scoped, because a drop is a
       * statement about the whole list and cannot be expressed as a fact about
       * one row. One endpoint for both gestures: the drag-and-drop and the
       * move-up/move-down controls each compute the full order and send it, so
       * the accessible path and the pointer path cannot diverge in what they
       * persist.
       *
       * **This one writes no signal**, and that is a decision rather than an
       * omission. The three marks that DO write — good call, bad call, not
       * tonight — are each an unambiguous sentence about a topic. A reorder is
       * not: a learner who drags something to the top may be saying it matters
       * most, or that it is the one they can face first, or that they want the
       * short one out of the way. The ledger has no room for a qualifier
       * (`SignalType` says so about the resurface marks and the quick take's
       * two), and a preference signal minted out of a gesture that means three
       * different things is worse than no signal at all. The order is honoured
       * exactly as given, which is the thing the learner actually asked for.
       */
      const ord = /^\/sessions\/([^/]+)\/sections\/order$/.exec(url.pathname);
      if (req.method === 'POST' && ord) {
        const sessionId = pathId(ord, 1);
        const session = await deps.store.getSession(sessionId);
        if (!session) return json(res, 404, { error: 'no such session' });
        const body = await readBody(req);
        const raw = body['topicIds'];
        if (!Array.isArray(raw)) {
          return json(res, 400, { error: 'topicIds must be an array of topic ids' });
        }
        const reordered = reorderSections(session, raw as readonly string[]);
        await deps.store.putSession(reordered);
        return json(res, 200, {
          ok: true, topicIds: reordered.sections.map((s) => s.topicId),
        });
      }

      // --- session interaction. Every one of these writes a signal back to the
      // ledger; an interaction the model does not learn from is wasted evidence.
      const m = /^\/sessions\/([^/]+)\/sections\/([^/]+)\/(depth|skip|answer|contest|resurface|remove|verdict)$/.exec(url.pathname);
      if (req.method === 'POST' && m) {
        const [, rawSession, rawTopic, action] = m as unknown as [string, string, string, string];
        const [sessionId, topicId] = [decodeId(rawSession), decodeId(rawTopic)];
        const session = await deps.store.getSession(sessionId);
        const section = session
          ? ensureLearnerAction(session.sections).find((s) => s.topicId === topicId)
          : undefined;
        if (!session || !section) return json(res, 404, { error: 'no such section' });

        if (action === 'skip') {
          // weaker than a demonstrated answer, and weighted accordingly.
          await appendSignal(topicId, 'self-skip', 'positive', `skip:${sessionId}:${topicId}`);
          await deps.store.putSession(markCompleted(session, topicId, 'known'));
          return json(res, 200, { ok: true });
        }

        /**
         * The learner-lineup contract — the X, which does two things and has to do both.
         *
         * It takes the section out of tonight's lineup, and it records that the
         * learner said no to this topic for now. Either half on its own is a
         * broken promise: removing without recording makes the same choice
         * again on the next run, and recording without removing leaves the
         * thing they just dismissed sitting on the screen.
         *
         * `lineup-not-now` is NEUTRAL, and this is the one place it is worth
         * being exact. "Not tonight" is a statement about timing. It is not a
         * claim that the topic is bad (that is the thumbs-down, which is its
         * own control and its own type) and it is emphatically not a claim
         * about what the learner knows — `domain/signals.ts` keeps all three
         * lineup marks out of the weight table by type so the comfort model
         * cannot read one.
         *
         * Answered once, like every other mark on a section. A double tap and a
         * retried request are the same thing from here, and a second signal
         * would extend a window the learner only meant to open once.
         */
        if (action === 'remove') {
          const sourceEvent = `lineup-remove:${sessionId}:${topicId}`;
          const already = (await deps.store.listSignals(topicId))
            .some((s) => s.sourceEvent === sourceEvent && !s.invalidated);
          if (!already) {
            await appendSignal(topicId, 'lineup-not-now', 'neutral', sourceEvent);
          }
          const shorter = removeSection(session, topicId);
          await deps.store.putSession(shorter);
          return json(res, 200, {
            ok: true,
            alreadyRemoved: already,
            backAfterDays: NOT_NOW_DAYS,
            topicIds: shorter.sections.map((s) => s.topicId),
          });
        }

        /** Choice verdicts are exclusive, changeable, and affect ranking only. */
        if (action === 'verdict') {
          const call = requireOneOf(await readBody(req), 'call', ['good', 'bad'] as const);
          const sourceEvent = `lineup-verdict:${sessionId}:${topicId}`;
          const standing = (await deps.store.listSignals(topicId))
            .filter((s) => s.sourceEvent === sourceEvent && !s.invalidated);
          const type = call === 'good' ? 'lineup-good-call' : 'lineup-bad-call';
          if (standing.some((s) => s.type === type)) {
            return json(res, 200, { ok: true, call, alreadyMarked: true });
          }
          if (standing.length) await deps.store.invalidateSignals(sourceEvent);
          await appendSignal(topicId, type, call === 'good' ? 'positive' : 'negative', sourceEvent);
          return json(res, 200, { ok: true, call, changed: standing.length > 0 });
        }

        /**
         * Answer-mark withdrawal: the learner says the marking was wrong, and
         * the mark goes.  source-rechecking teaching correction is the
         * separate `/correction` route below.
         *
         * `invalidateSignals` has existed since the first commit, is honoured by
         * `computeComfort`, and is proven by `registrar.test.ts:83` — and was
         * called by nothing in the entire repository. The consequence of a
         * mistaken mark was fully built and there was no way to withdraw one,
         * so "mistaken marks leave no trace" was a property of a function nobody
         * could reach. This is that narrow caller.
         *
         * Deliberately narrow. It contests ONE event class — the marking of an
         * answer on this section — because that is the one the ledger actually
         * derives comfort from and the one the learner can be wrongly marked on.
         * It is not a dispute system, it does not re-run the Tutor, and it does
         * not argue: the learner's word settles it, which is the only version of
         * this that is worth anything as a trust surface.
         *
         * What it does NOT do is write a compensating signal. Withdrawing the
         * evidence is the whole point; adding "they said I was wrong" as fresh
         * evidence would leave exactly the mark this is here to remove.
         */
        if (action === 'contest') {
          const sourceEvent = `answer:${sessionId}:${topicId}`;
          const withdrawn = (await deps.store.listSignals(topicId))
            .filter((s) => s.sourceEvent === sourceEvent && !s.invalidated).length;
          await deps.store.invalidateSignals(sourceEvent);
          // The exchange is logged where it happened, so the panel can still say
          // so after a reload and the section does not quietly look unanswered.
          await deps.store.putSession({
            ...session,
            sections: session.sections.map((s) => s.topicId === topicId ? { ...s, contested: true } : s),
          });
          return json(res, 200, { ok: true, withdrawn });
        }

        /**
         *  — "come back to this", with its one nuance.
         *
         * Deliberately not a completion. The mark means *done for now but not
         * done*, so the section stays open and the resume point stays where it
         * was; a mark that ticked the section off would be the one control that
         * says "not finished" finishing it.
         *
         * The two nuances are two signal types rather than one type and a
         * field, because they are opposite statements about the register — see
         * `SignalType`. The nuance is validated against the pair the panel
         * offers before anything is written, so an unrecognised value writes
         * nothing rather than defaulting to one of them: this is the whole of
         * the untrusted boundary for this endpoint, and a default here would
         * put a comfort signal the learner never gave into the ledger.
         *
         * Answered once, the same way `/suggestions/:id/(accept|reject)` is:
         * a retried request and a double-tap are the same thing from here, and
         * a section that has no "answered" state to check ( keeps it open
         * on purpose) still has the one thing every mark on it shares — the
         * `sourceEvent` a mark on this section always writes under. A second
         * POST that found a live signal already there minted a second
         * demonstrated-ish signal into the ledger — one tap doubled into two,
         * quietly moving comfort further than the learner actually asked.
         */
        if (action === 'resurface') {
          const nuance = requireOneOf(await readBody(req), 'nuance', ['refresher', 'deeper'] as const);
          if (nuance === 'deeper' && section.mediumWarning?.trim()) {
            return json(res, 409, { error: 'Pin a better source before asking Virgil to expand this practice.' });
          }
          const sourceEvent = `resurface:${sessionId}:${topicId}`;
          const already = (await deps.store.listSignals(topicId))
            .some((s) => s.sourceEvent === sourceEvent && !s.invalidated);
          if (already) return json(res, 200, { ok: true, nuance, alreadyMarked: true });
          await appendSignal(topicId,
            nuance === 'refresher' ? 'resurface-refresher' : 'resurface-deeper',
            nuance === 'refresher' ? 'negative' : 'positive',
            `resurface:${sessionId}:${topicId}`);
          return json(res, 200, { ok: true, nuance });
        }

        if (action === 'depth') {
          // A medium-limited lesson has already crossed the source-grounding
          // boundary. Rewriting it here is an unverified foreground model call
          // that can reintroduce physical technique the Composer removed. Old
          // panels and direct clients get the same refusal as the current UI;
          // this must hold at the service, not only by hiding two buttons.
          if (section.mediumWarning?.trim()) {
            return json(res, 409, {
              error: 'This practice stays exactly as your saved page puts it. Pin a page that goes further before asking Virgil to expand it.',
            });
          }
          const direction = requireOneOf(await readBody(req), 'direction', ['simpler', 'deeper'] as const);
          const target: DepthRegister = shiftRegister(section.depth, direction);
          const body = await rewriteAtDepth(at('depth'), section, target, DEPTH_GUIDE[target]);
          await appendSignal(topicId,
            direction === 'simpler' ? 'depth-simpler' : 'depth-deeper',
            direction === 'simpler' ? 'negative' : 'positive',
            `depth:${sessionId}:${topicId}`);
          await deps.store.putSession({
            ...session,
            sections: session.sections.map((s) => s.topicId === topicId ? { ...s, body, depth: target } : s),
          });
          return json(res, 200, { body, depth: target });
        }

        const answer = requireTrimmedBoundedString(
          await readBody(req), 'answer', LEARNER_ANSWER_MAX_CHARS,
        );
        const marked = await markAnswer(at('answer'), section, answer);
        // the strongest comfort signal available to the product.
        await appendSignal(topicId, marked.signal,
          marked.signal === 'answer-correct' ? 'positive' : 'negative',
          `answer:${sessionId}:${topicId}`);
        // A wrong answer is evidence about what still needs work, not evidence
        // that the learner completed the requested practice. Keep the section
        // open so the same question can be revised and tried again. A later
        // correct attempt records its own positive signal and closes it.
        if (marked.signal === 'answer-correct') {
          await deps.store.putSession(markCompleted(session, topicId, 'answer'));
        }
        return json(res, 200, marked);
      }

      // a suggestion is a proposal. Accepting promotes it to a pin;
      // rejecting must quiet the detector, not merely hide the card.
      //
      // This is where the re-read detector finally lands. It has been complete
      // and unreachable since it was written, because nothing in the codebase
      // could construct a `Suggestion` — the store could only mutate ones put
      // there by hand.
      if (req.method === 'POST' && url.pathname === '/suggestions') {
        const body = await readBody(req);
        const created: Suggestion = {
          id: randomUUID(),
          passage: requireString(body, 'passage'),
          url: requireString(body, 'url'),
          reason: requireString(body, 'reason'),
          raisedAt: deps.clock.now().toISOString(),
          // The learner-confirmation contract, and the thing that separates this from surveillance:
          // it lands pending and is surfaced by `/board` next time the learner
          // opens the panel. Nothing here can auto-pin, by construction.
          state: 'pending',
          pageTitle: typeof body['pageTitle'] === 'string' ? body['pageTitle'] : null,
          headingPath: Array.isArray(body['headingPath'])
            ? (body['headingPath'] as unknown[]).filter((x): x is string => typeof x === 'string')
            : [],
        };
        await deps.store.putSuggestion(created);
        return json(res, 201, { id: created.id, state: created.state });
      }

      const sm = /^\/suggestions\/([^/]+)\/(accept|reject)$/.exec(url.pathname);
      if (req.method === 'POST' && sm) {
        const [, rawId, verb] = sm as unknown as [string, string, 'accept' | 'reject'];
        const id = decodeId(rawId);
        const found = (await deps.store.listSuggestions()).find((s) => s.id === id);
        if (!found) return json(res, 404, { error: 'no such suggestion' });

        /**
         * A suggestion is answered once.
         *
         * Both verbs were previously re-runnable, and both consequences
         * compound. A second accept made a SECOND struggle pin out of one thing
         * the learner clicked once — a duplicate that then clusters, gets
         * taught and is counted in `fromPinCount`. A second reject counted a
         * second rejection against the site, and  quiets the detector at
         * two: one double-tap on one card, and the detector goes silent on a
         * site the learner had only said no to once.
         *
         * Answered as the state it already has rather than as an error. A
         * double tap and a retried request are the same thing from here, and
         * neither is something to show the learner.
         */
        if (found.state !== 'pending') {
          return json(res, 200, { ok: true, state: found.state, alreadyAnswered: true });
        }

        if (verb === 'accept') {
          const pin = await createPin(
            { type: 'struggle', envelope: envelopeFromSuggestion(found), note: null },
            { fromSuggestion: true },
          );
          await deps.store.putSuggestion({ ...found, state: 'accepted' });
          return json(res, 200, { ok: true, pinId: pin.id, label: pin.label });
        }

        //. The rejection has to reach the detector or it is just a card
        // being dismissed, so it is counted against the site it came from. The
        // content script reads this count before it observes anything; the
        // threshold itself lives with the detector, in `reread-core.ts`, so
        // there is exactly one number and it is next to the rest of them.
        const origin = originOf(found.url);
        if (origin) {
          await mutateLearnerPrefs(deps.store, (prefs) => ({
            ...prefs,
            rejectedOrigins: {
              ...prefs.rejectedOrigins,
              [origin]: (prefs.rejectedOrigins[origin] ?? 0) + 1,
            },
          }));
        }
        await deps.store.putSuggestion({ ...found, state: 'rejected' });
        return json(res, 200, { ok: true });
      }

      // --- topic identity repair. Attach-only clustering (clustering-stability constraint) means a wrong
      // merge and a wrong split are both permanent unless the learner can undo
      // them, so these two endpoints are the only self-repair the board has.
      // Every one of them is an explicit, confirmed user action: nothing here is
      // ever reached by an agent.
      const tpins = /^\/topics\/([^/]+)\/pins$/.exec(url.pathname);
      if (req.method === 'GET' && tpins) {
        // The split picker needs something to pick. Pins, in the topic's own
        // order, with just enough text to recognise one.
        const topic = await deps.store.getTopic(pathId(tpins, 1));
        if (!topic) return json(res, 404, { error: 'no such topic' });
        const pins = await deps.store.listPins();
        const byId = new Map(pins.map((p) => [p.id, p]));
        return json(res, 200, {
          topicId: topic.id,
          label: topic.label,
          pins: topic.pinIds.flatMap((id) => {
            const p = byId.get(id);
            if (!p) return [];
            return [{
              id: p.id,
              title: p.envelope.pageTitle,
              // `String(...)` rather than a bare `??`: `pinRequestFrom` requires
              // a url, a title and a heading path and nothing else, so a pin
              // with neither a selection nor surrounding text — or with a
              // number where the text goes — is a pin this service ADMITTED.
              // Calling `.replace` on it was a TypeError, and the split picker
              // is where the learner goes to repair a bad topic, so the one
              // pin that is malformed took away the tool for the rest.
              gist: String(p.envelope.selection ?? p.envelope.surroundingText ?? '')
                .replace(/\s+/g, ' ').trim().slice(0, 140),
            }];
          }),
        });
      }

      const tops = /^\/topics\/([^/]+)\/(merge|split)$/.exec(url.pathname);
      if (req.method === 'POST' && tops) {
        const [, rawId, verb] = tops as unknown as [string, string, 'merge' | 'split'];
        const id = decodeId(rawId);
        try {
          if (verb === 'merge') {
            // The path id is the topic being absorbed — "merge THIS into that" is
            // the direction the panel offers, and the survivor keeps its name.
            const into = (await readBody(req))['into'];
            if (typeof into !== 'string' || !into) return json(res, 400, { error: 'merge needs a topic to merge into' });
            const kept = await deps.store.mergeTopics(into, id);
            return json(res, 200, {
              ok: true, keptId: kept.id, keptLabel: kept.label,
              absorbedId: id, pinCount: kept.pinIds.length,
            });
          }
          // `splitTopic` already rejects an empty selection and an empty name as
          // TopicOpError, with a message the panel renders. Nothing to add here.
          const body = await readBody(req);
          const pinIds = Array.isArray(body['pinIds']) ? body['pinIds'] as string[] : [];
          const label = typeof body['label'] === 'string' ? body['label'] : '';
          const created = await deps.store.splitTopic(id, pinIds, label);
          const original = await deps.store.getTopic(id);
          return json(res, 200, {
            ok: true, topicId: created.id, label: created.label,
            movedPins: created.pinIds.length, remainingPins: original?.pinIds.length ?? 0,
          });
        } catch (err) {
          // A bad id is the user's panel being stale, not a server fault. Say
          // which, so the panel can refresh rather than show a 500.
          if (err instanceof TopicOpError) {
            return json(res, err.code === 'unknown-topic' ? 404 : 400,
              { error: err.message, code: err.code });
          }
          throw err;
        }
      }

      // --- trust surfaces ( to ).
      // These ship as one coupled unit with the re-read detector. Behavioural
      // monitoring is only acceptable because pause, exclusions, an inspectable
      // model and real deletion all exist and all work.
      // Start one learner-requested run and answer immediately. The old route
      // remains an alias, and an existing run wins over a duplicate request.
      if (req.method === 'POST' && (url.pathname === '/batch' || url.pathname === '/sessions/build')) {
        if (hostedNeedsRun && !hostedRun) {
          return json(res, 503, {
            ok: false,
            error: 'This hosted installation has not connected its background worker.',
          });
        }
        if (hostedRun) {
          const prefs = await deps.store.getPrefs();
          if (pausedNow(prefs)) {
            return json(res, 409, { ok: false, error: 'collection is paused' });
          }
          const started = await startHostedRun(true);
          if (started.kind === 'already') {
            return json(res, 200, { ok: true, already: true, queued: true });
          }
          if (started.kind === 'queued') {
            return json(res, 200, {
              ok: true, started: true, queued: true, dayKey: started.receipt.batchKey,
            });
          }
          if (started.kind === 'failed') {
            return json(res, 503, {
              ok: false,
              error: 'Processing could not be handed to the background worker. Your saved material is still waiting.',
            });
          }
          return json(res, 409, { ok: false, error: 'nothing is ready to process' });
        }
        if (building) return json(res, 200, { ok: true, already: true });
        // Claim before the first await so double clicks cannot start two runs.
        building = true;
        let handedToRun = false;
        try {
          const prefs = await deps.store.getPrefs();
          if (pausedNow(prefs)) {
            // The processing-pause contract. A pause is a pause, and a button is not a way round it.
            return json(res, 409, { ok: false, error: 'collection is paused' });
          }
          // The run is still keyed by the learner's day, which is what stops two
          // runs either side of midnight looking like two days' work.
          const dayKey = dayKeyFor(deps.clock.now(), zoneOf(prefs));
          beginBatchActivity();
          reportRun('the requested run', runBatch(budgetedDeps, {
            batchKey: dayKey, usage: meter, onStage: stageLine('the requested run'),
            onStageStart: startStage,
            onLearnerContext: rememberLearnerContext,
            workCap, ...notebookOption,
          }));
          handedToRun = true;
          return json(res, 200, { ok: true, started: true, dayKey });
        } finally {
          // A paused board, a store that threw, a run that would not even
          // start: none of them are a night, and a flag left true by one of
          // them tells every later request that a night is running when the
          // service is idle — until the process restarts.
          if (!handedToRun) building = false;
        }
      }

      // Pure document reads plus the hosted file-id setup. No model call and
      // therefore no budget gate; absent managed Drive support remains a 404.
      if (await handleHostedNotebookRoute(req, res, url, {
        store: deps.store,
        clock: deps.clock,
        managedAccount: opts.hostedNotebookDriveAccount ?? '',
        notebookUrl: opts.hostedNotebookUrl ?? null,
        readBody,
        requestTimeZone,
        reply: json,
        badRequest: (message) => { throw new BadRequest(message); },
      })) return;

      // The ordinary configured export destination and its last-write receipt.
      if (url.pathname === '/notebook/export') {
        if (!opts.notebook) {
          return json(res, 404, { error: 'this service is not keeping documents for a notebook' });
        }
        if (req.method === 'POST') {
          const receipt = await exportNotebook(deps.store, deps.clock, opts.notebook, notebookScope(await readBody(req)));
          rememberReceipt(receipt);
          return json(res, allWritten(receipt) ? 200 : 207,
            notebookBody(receipt, opts.hostedNotebookUrl));
        }
        if (req.method === 'GET') {
          if (!lastNotebookReceipt) {
            return json(res, 200, {
              ok: false,
              ran: false,
              // Said plainly rather than dressed as a failure. Nothing has gone
              // wrong; this process has not written anything yet, which is the
              // honest state after a restart.
              line: 'I have not written your documents since I started up.',
              docs: [],
            });
          }
          return json(res, 200, notebookBody(lastNotebookReceipt, opts.hostedNotebookUrl));
        }
      }

      /** Report queued work and estimated cost using store arithmetic only. */
      if (req.method === 'GET' && url.pathname === '/batch') {
        const prefs = await deps.store.getPrefs();
        const hostedReceipt = hostedRun
          ? await reconcileHostedReceipt(prefs.hostedProcessing ?? null) : null;
        const hostedBuilding = hostedActive(hostedReceipt);
        const pins = await deps.store.listPins();
        const unprocessed = pins.filter((p) => !p.topicId).length;
        // What the run will actually do, rather than a proxy for it: forage is
        // owed the pins with no usable enrichment, which is not the same set as
        // the pins with no topic. See `estimateCalls`.
        const owed = pins.filter(owedEnrichment).length;
        const allTopics = await deps.store.listTopics();
        const learnerContext = sessionLearnerContext(
          await deps.store.listStatements(), await deps.store.listSignals(),
        );
        const decision = planBatch({
          unprocessedPins: unprocessed,
          dueForRevision: await dueForRevision(),
          paused: pausedNow(prefs),
          autoAfter: prefs.autoAfter ?? null,
          asked: url.searchParams.get('asked') === '1',
        });
        let hostedOutcome: 'session' | 'no-session' | 'quota-degraded' | null
          = hostedReceipt?.result?.outcome ?? null;
        if (hostedReceipt?.state === 'finished' && !hostedReceipt.result) {
          const sessions = await deps.store.listSessions();
          hostedOutcome = sessions.some((session) => session.batchKey === hostedReceipt.batchKey
            && Date.parse(session.builtAt) >= Date.parse(hostedReceipt.requestedAt))
            ? 'session' : null;
        }
        const hostedActivity = hostedReceipt ? {
          state: hostedReceipt.state === 'launching' || hostedReceipt.state === 'queued'
            ? 'queued' : hostedReceipt.state,
          startedAt: hostedReceipt.requestedAt,
          finishedAt: hostedReceipt.state === 'finished' || hostedReceipt.state === 'failed'
            ? hostedReceipt.checkedAt : null,
          currentStage: hostedReceipt.state === 'launching' || hostedReceipt.state === 'queued'
            ? 'queued' : null,
          reports: hostedReceipt.result?.reports ?? [],
          outcome: hostedOutcome,
          // A successful Job Operation only proves that the process exited
          // cleanly. With no new session it does not prove why: there may have
          // been nothing due, everything may have been withheld, or the model
          // may have produced no usable result. Do not invent a diagnosis.
          outcomeReason: hostedReceipt.result?.outcomeReason ?? null,
          remaining: hostedReceipt.result?.remaining ?? unprocessed,
          withheld: hostedReceipt.result?.withheld ?? 0,
          learnerCorrections: 0,
          lean: hostedReceipt.result?.lean ?? false,
          failure: hostedReceipt.state === 'failed'
            ? 'The background worker did not finish this run.' : null,
        } : null;
        return json(res, 200, {
          ...decision,
          unprocessedPins: unprocessed,
          estimatedCalls: estimateCalls({
            owedEnrichment: owed,
            topics: allTopics.length,
            hasPins: pins.length > 0,
            globalLearnerCorrection: learnerContext.globalCorrection,
            sessionMinutes: prefs.availableMinutes ?? 3,
            prospect: prefs.prospect !== false,
            analyseSecondAsk: observableMaterial({ pins, topics: allTopics }),
          }),
          autoAfter: autoThreshold(prefs.autoAfter ?? null),
          /**
           * Is one being worked through right now?
           *
           * The one fact about a run that no surface in the product could ask
           * for. `POST /batch` has answered `already` since it was written, so
           * the state existed and only the button that had just been pressed
           * could ever see it — a learner arriving on any other screen, or
           * returning to this one, had no way to find out that the thing they
           * asked for was still happening. A night is minutes of model work, so
           * that is the ordinary case rather than a corner.
           */
          building: building || hostedBuilding,
          currentStage: hostedBuilding ? hostedActivity?.currentStage ?? null : currentStage,
          activity: batchActivity ? {
            state: batchActivity.state,
            startedAt: batchActivity.startedAt,
            finishedAt: batchActivity.finishedAt,
            currentStage: batchActivity.currentStage,
            reports: batchActivity.reports.map((report) => ({
              stage: report.stage, ms: report.ms, failed: report.failed,
              degradeReason: report.degradeReason ?? null,
              work: report.work ?? null,
            })),
            outcome: batchActivity.outcome,
            outcomeReason: batchActivity.outcomeReason,
            remaining: batchActivity.remaining,
            withheld: batchActivity.withheld,
            learnerCorrections: batchActivity.learnerCorrections,
            lean: batchActivity.lean,
            failure: batchActivity.failure,
            failureReason: batchActivity.failureReason,
          } : hostedActivity,
        });
      }

      /**
       * CONNECT DRIVE — the setup surface, and the four things it needs.
       *
       * `NOTEBOOK_SEAM_V2.md` §4 and §7. Three protected local endpoints:
       * status, start a consent, forget a grant. There is deliberately no
       * fourth for saving a Google sign in — see the note further down, and
       * `drive-shipped-client.ts` for where that route lives now.
       *
       * **Absent is off.** With no Drive lane configured all four answer 404, as
       * `/notebook/export` does with no destination. A capability this build
       * does not have is not a capability that failed.
       *
       * **Nothing here ever returns a token or a secret.** §4.1's law, and it is
       * held structurally rather than carefully: the status body is assembled
       * from `credential.connection()` and `clientConfigured()`, neither of
       * which can reach a value. The echo after a save is *configured or not*,
       * which is exactly what `GET /model-config` says about the Gemini key.
       */
      if (url.pathname === '/notebook/drive' || url.pathname.startsWith('/notebook/drive/')) {
        const drive = opts.drive;
        if (!drive) {
          return json(res, 404, { error: 'this service does not offer a Google Drive connection' });
        }
        if (!modelSetupAllowed) {
          throw new Forbidden('Google Drive setup requires a protected or loopback Virgil service');
        }

        const credential = drive.credential;

        /** Everything a surface may be told, and the whole of it. */
        const driveStatus = async (): Promise<Record<string, unknown>> => ({
          available: true,
          folderName: DRIVE_FOLDER_NAME,
          scope: DRIVE_SCOPE,
          client: {
            // The whole of what a surface needs, because the block has exactly
            // two states: there is a Google sign in on this install, or there is
            // not. Nothing renders `editable` or `managed` any more, so neither
            // is reported: a field on the wire that no reader has is a field
            // that goes stale without anybody noticing.
            configured: credential.clientConfigured(),
            // Which of the three sources it came from. Diagnostic, never a
            // value, and nothing in the product branches on it.
            source: credential.clientSource(),
          },
          connection: credential.connection(),
          folder: credential.connected() ? { link: await drive.folderLink() } : null,
          connect: { state: connectPhase, detail: connectDetail },
          // §7 step 3: the learner is about to add these to a notebook by hand,
          // and a list they can tick off is the whole of what that step needs.
          documents: NOTEBOOK_DOC_KEYS.map((key) => ({ key, title: notebookDocTitle(key) })),
          // What Virgil last wrote, and never a word about what Google read.
          lastWrite: lastNotebookReceipt ? notebookBody(lastNotebookReceipt) : null,
        });

        if (req.method === 'GET' && url.pathname === '/notebook/drive') {
          return json(res, 200, await driveStatus());
        }

        /* Google OAuth client values are configuration, never an HTTP endpoint. */

        /**
         * Start the consent, and finish it when the browser comes back.
         *
         * This answers immediately with the URL, because the learner has to go
         * and look at Google's consent screen and an HTTP request held open
         * through that is a request that dies on a timeout somewhere. The rest
         * happens on the loopback listener: the grant is saved, and then **the
         * five documents are written before the state becomes `connected`**,
         * which is §7 step 2 said in code. The screen polls this and does not
         * move on until it does.
         */
        if (req.method === 'POST' && url.pathname === '/notebook/drive/connect') {
          const client = credential.client();
          if (!client) {
            /*
             * The second of the block's two states, refused rather than
             * degraded. §4.3's rule holds: off, and say so, and do not degrade
             * to anything — a consent screen opened for a client id nobody owns
             * fails at Google with a message about a project the learner has
             * never heard of.
             *
             * The detail names configuration because only the installer can fix it.
             */
            return json(res, 409, {
              ok: false,
              error: 'no-client',
              detail: 'This build has no Google sign in, so there is no consent to ask for. '
                + 'Fill SHIPPED_DRIVE_CLIENT in runner/src/drive-shipped-client.ts, or set '
                + 'SB_DRIVE_CLIENT_ID and SB_DRIVE_CLIENT_SECRET on the service.',
            });
          }
          // A second Connect replaces the first rather than racing it: two
          // listeners on two ports, both waiting for one browser, is a state
          // where the answer depends on which tab the learner finishes in.
          pendingConsent?.cancel();
          const consent = drive.consent(client);
          pendingConsent = consent;
          const started = await consent.start();
          connectPhase = 'waiting';
          connectDetail = 'Waiting for you to give permission in your browser.';

          const store = deps.store;
          const clock = deps.clock;
          /**
           * **Everything after the grant is inside the try, including the token
           * write.**
           *
           * It was outside it, one line above the `try`, and that line is a
           * disk write: `setToken` goes through `writePrivate`, which refuses a
           * symlinked path, re-chmods to `0600` and can fail for every ordinary
           * reason a write fails — a read-only home, a full disk, a board
           * directory owned by another user. This whole chain is `void`ed,
           * because nothing is waiting for it: the HTTP request answered with
           * the consent URL minutes ago and the browser is the only thing left.
           * So a throw from that line was not a failed connection, it was an
           * **unhandled rejection**, and Node's default for one is to kill the
           * process — the learner's service dying because a file could not be
           * written, taking every other lane down with it. What it left behind
           * on the way out was just as bad: `pendingConsent` still set, so the
           * next Connect cancels a listener nobody is waiting on, and
           * `connectPhase` still `'waiting'`, so the setup screen polls a
           * sentence about a browser tab that closed for ever.
           *
           * A storage failure is a failed connection and now reports as one,
           * through the same `failed` phase every other failure here uses.
           */
          void consent.granted.then(async (grant) => {
            if (pendingConsent !== consent) return;
            try {
              await credential.setToken(grant.refreshToken, grant.scope, clock.now().toISOString());
              drive.tokens.forget();
              connectPhase = 'writing';
              connectDetail = 'Making your folder and writing your documents.';
              if (!opts.notebook) throw new Error('there is no destination configured');
              const receipt = await exportNotebook(store, clock, opts.notebook);
              rememberReceipt(receipt);
              connectPhase = 'connected';
              connectDetail = receiptLine(receipt);
            } catch (error) {
              // Which half failed is legible from the phase this throw
              // interrupted, and the two are not the same news: a grant that
              // was never stored is a sign in to do again, while documents that
              // could not be written are a sign in that held. Only the
              // fallback wording differs — a real error message is always
              // preferred to either, and a storage error carries one.
              const failedWriting = connectPhase === 'writing';
              connectPhase = 'failed';
              connectDetail = error instanceof Error && error.message
                ? error.message
                : failedWriting
                  ? 'Your documents could not be written.'
                  : 'That sign in could not be saved on this machine.';
            } finally {
              pendingConsent = null;
            }
          }, (error: unknown) => {
            if (pendingConsent !== consent) return;
            pendingConsent = null;
            connectPhase = 'failed';
            connectDetail = error instanceof Error && error.message
              ? error.message
              : 'That sign in did not go through.';
          });

          // The URL, and when it stops working. Never the state, never the
          // verifier: those are this process's half of the exchange.
          return json(res, 200, { ok: true, url: started.url, expiresAt: started.expiresAt });
        }

        /**
         * Forget the grant. **Nothing in Drive is touched.**
         *
         * §13, and it is recorded behaviour rather than an oversight: the five
         * documents stay where they are, in the learner's own Drive, because
         * they are the learner's. Their notebook goes on holding sources that
         * stop being rewritten, which is the honest consequence of withdrawing
         * permission and is a thing they can undo by connecting again. Deleting
         * them would be Virgil removing sources from a notebook it cannot see,
         * on its way out of a door it was asked to close.
         */
        if (req.method === 'POST' && url.pathname === '/notebook/drive/disconnect') {
          pendingConsent?.cancel();
          pendingConsent = null;
          await credential.disconnect();
          drive.tokens.forget();
          connectPhase = 'idle';
          connectDetail = '';
          return json(res, 200, await driveStatus());
        }
      }

      const connection = /^\/model-connections\/(cloud|local|cli)\/check$/.exec(url.pathname);
      if (req.method === 'POST' && connection) {
        if (!modelSetupAllowed) {
          throw new Forbidden('model connection checks require a protected or loopback Virgil service');
        }
        return json(res, 200, await checkModelConnection(
          connection[1] as ModelMode, deps.store, models));
      }

      if (url.pathname === '/model-connections/cloud/credential'
        && (req.method === 'PUT' || req.method === 'DELETE')) {
        if (!modelSetupAllowed) {
          throw new Forbidden('model credential setup requires a protected or loopback Virgil service');
        }
        const credential = models.cloudCredential;
        if (!credential?.editable) {
          throw new Forbidden('Google Gemini credentials are managed by the service operator');
        }
        if (req.method === 'PUT') {
          const body = await readBody(req);
          if (Object.keys(body).length !== 1 || typeof body.apiKey !== 'string') {
            throw new BadRequest('body must contain only apiKey as a string');
          }
          try { await credential.set(body.apiKey); }
          catch (error) {
            throw new BadRequest(error instanceof Error ? error.message : 'invalid Google Gemini API key');
          }
        } else {
          await credential.clear();
        }
        return json(res, 200, await modelReceipt(deps.store, models));
      }

      if (url.pathname === '/model-config') {
        if (req.method === 'GET') return json(res, 200, await modelReceipt(deps.store, models));
        if (req.method === 'PUT') {
          const body = await readBody(req);
          const prefs = await deps.store.getPrefs();
          if (body.preset === 'recommended') {
            // The preset is a one-press promise that Cloud/API can own the next
            // piece of work. Do not turn off a working Local/CLI route and then
            // leave the learner at a missing-key stop. Explicit custom maps are
            // still allowed to stage a route before setup; “recommended” is the
            // safer product action and becomes authoritative only when its sole
            // provider is actually configured.
            const cloudConfigured = models.cloudCredential?.configured()
              ?? Boolean(models.cloudReady);
            if (!cloudConfigured) {
              return json(res, 409, {
                error: 'Save a Cloud/API credential before using the recommended settings.',
                stoppedBy: 'model-credential', connection: 'cloud', fixAt: 'settings/models',
              });
            }
            await mutateLearnerPrefs(deps.store, (current) => ({
              ...current,
              modelProviders: { ...DEFAULT_MODEL_PROVIDERS },
              modelRoutes: { ...DEFAULT_MODEL_ROUTES },
            }));
            return json(res, 200, await modelReceipt(deps.store, models));
          }

          const rawProviders = body.providers;
          if (!rawProviders || typeof rawProviders !== 'object' || Array.isArray(rawProviders)) {
            throw new BadRequest('providers must contain cloud, local and cli connection settings');
          }
          const entries = rawProviders as Record<string, unknown>;
          const entry = (mode: ModelMode): Record<string, unknown> => {
            const value = entries[mode];
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
              throw new BadRequest(`${mode} provider settings are required`);
            }
            return value as Record<string, unknown>;
          };
          const cloud = entry('cloud');
          const local = entry('local');
          const cli = entry('cli');
          const providers: ModelProviderToggles = {
            cloud: cloud.enabled as boolean,
            local: local.enabled as boolean,
            cli: cli.enabled as boolean,
          };
          if (!isModelProviderToggles(providers)) {
            throw new BadRequest('each provider enabled setting must be true or false');
          }
          if (!Object.values(providers).some(Boolean)) {
            throw new BadRequest('at least one model provider must be on');
          }
          if (!isModelRoutes(body.routes)) {
            throw new BadRequest('routes must assign quick, deep and images to cloud, local or cli');
          }
          const routes = body.routes as ModelRoutes;
          for (const workload of ['quick', 'deep', 'images'] as const) {
            if (!providers[routes[workload]]) {
              throw new BadRequest(`${workload} is assigned to ${routes[workload]}, but that provider is off`);
            }
          }
          if (models.hosted && providers.cli) {
            throw new BadRequest('Agent CLI requires a self-hosted Virgil service');
          }
          if (models.hosted && providers.local && !isLocalConnectorStore(deps.store)) {
            throw new BadRequest('this hosted deployment has no Local connector store');
          }

          const allowRemote = models.allowRemoteEndpoints ?? false;
          let localEndpoint: string;
          try {
            localEndpoint = modelEndpoint(
              local.endpoint,
              prefs.localModelEndpoint ?? models.localEndpoint ?? DEFAULT_LOCAL_MODEL_ENDPOINT,
              allowRemote,
            );
          } catch (error) {
            throw new BadRequest(error instanceof Error ? error.message : 'invalid Local model endpoint');
          }
          const configuredCli = modelEndpoint(
            undefined,
            models.cliEndpoint ?? DEFAULT_CLI_MODEL_ENDPOINT,
            true,
          );
          if (cli.endpoint !== undefined) {
            let requested: string;
            try { requested = modelEndpoint(cli.endpoint, configuredCli, true); }
            catch (error) {
              throw new BadRequest(error instanceof Error ? error.message : 'invalid Agent CLI endpoint');
            }
            if (requested !== configuredCli) {
              throw new BadRequest('the Agent CLI endpoint is configured by the service operator');
            }
          }
          await mutateLearnerPrefs(deps.store, (current) => ({
            ...current,
            modelProviders: providers,
            modelRoutes: routes,
            localModelEndpoint: localEndpoint,
          }));
          return json(res, 200, await modelReceipt(deps.store, models));
        }
      }

      /**
       * ---------------------------------------------------------------------
       * THE SPEND LIMIT — set it, read it, reset the window, turn it off.
       *
       * Beside `/model-config` and shaped like it, because it is the same
       * decision from the other end: that endpoint says WHERE model work runs,
       * this one says how much of it the learner is willing to buy.
       *
       * Every reply is the same receipt, so a client that sets a limit does not
       * have to make a second request to find out what it did. The receipt
       * carries the numbers, the state machine's verdict, and the notes that
       * say what the numbers are not — tokens rather than money, a floor rather
       * than a ceiling. See `core/domain/model-budget.ts`.
       *
       * Nothing here writes to the learning ledger. A budget is not evidence
       * about what somebody understands, and a learner whose spending shaped
       * their board would be a learner taught by their wallet.
       */
      if (await handleModelBudgetRoute(req, res, url, {
        budget,
        readBody,
        reply: json,
        badRequest: (message) => { throw new BadRequest(message); },
      })) return;

      if (await handleProspectRoute(req, res, url, {
        store: deps.store, now: () => deps.clock.now(), readBody, reply: json,
      })) return;

      // What left Virgil for another surface, and what came back. It writes
      // rows, and reaches the ledger only through the marks the quick take's
      // close already defines, so nothing downstream learns a new word.
      if (await handleExternalRoute(req, res, url, {
        store: deps.store, nowIso: () => deps.clock.now().toISOString(),
        readBody, requireText: requireTrimmedBoundedString, pathId, reply: json,
        badRequest: (message) => { throw new BadRequest(message); },
        newId: randomUUID, appendSignal,
        readNextAction: (minutes) => readNextAction(minutes, undefined, requestTimeZone(req)),
      })) return;

      if (await handleLearnerOverviewRoute(req, res, url, {
        store: deps.store,
        now: () => deps.clock.now(),
        hostedNeedsRun,
        hostedRunAvailable: hostedRun !== null,
        readBody,
        validatePrefs: (body) => validPrefsPatch(body) as Partial<LearnerPrefs>,
        readNextAction,
        requestTimeZone,
        zoneOf,
        reply: json,
      })) return;

      /**
       * Real outcomes close the loop. They create evidence only through the
       * explicit outcome-to-signal conversion in core, and every response says
       * whether that evidence changed the product's next decision.
       */
      if (url.pathname === '/outcomes') {
        if (req.method === 'GET') {
          const all = await deps.store.listOutcomes();
          return json(res, 200, {
            outcomes: all.filter((o) => !o.deletedAt)
              .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)),
            history: all.filter((o) => o.deletedAt),
          });
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const minutes = validAvailableMinutes(body.availableMinutes, 3);
          const receiptId = clientReceiptId('outcome', body.clientRef);
          if (receiptId) {
            const existing = await deps.store.getOutcome(receiptId);
            if (existing) {
              const current = await readNextAction(minutes, undefined, requestTimeZone(req));
              return json(res, 200, {
                outcome: existing, signalsAdded: 0, alreadyRecorded: true,
                adaptation: {
                  changed: false, before: current.primary, after: current.primary,
                  changedBecause: `“${existing.title}” was already recorded; the current next move still wins.`,
                },
              });
            }
          }
          const before = await readNextAction(minutes, undefined, requestTimeZone(req));
          const outcome = await outcomeFromBody(body, receiptId ?? randomUUID(), null);
          await deps.store.putOutcome(outcome);
          const seeds = signalsForOutcome(
            outcome, Array.from({ length: outcomeSignalSeeds(outcome).length }, () => randomUUID()));
          for (const signal of seeds) await deps.store.appendSignal(signal);
          const after = await readNextAction(minutes, undefined, requestTimeZone(req));
          const changed = before.primary.id !== after.primary.id;
          return json(res, 201, {
            outcome, signalsAdded: seeds.length,
            adaptation: {
              changed, before: before.primary, after: after.primary,
              changedBecause: changed
                ? `“${outcome.title}” changed the next move from “${before.primary.title}” to “${after.primary.title}”.`
                : `“${outcome.title}” is now evidence; the current next move still wins.`,
            },
          });
        }
      }

      const correctOutcome = /^\/outcomes\/([^/]+)\/correct$/.exec(url.pathname);
      if (req.method === 'POST' && correctOutcome) {
        const body = await readBody(req);
        const minutes = validAvailableMinutes(body.availableMinutes, 3);
        const oldId = pathId(correctOutcome, 1);
        const receiptId = clientReceiptId('outcome-correction', body.clientRef);
        if (receiptId) {
          const existing = await deps.store.getOutcome(receiptId);
          if (existing?.supersedesId === oldId) {
            const current = await readNextAction(minutes, undefined, requestTimeZone(req));
            return json(res, 200, {
              outcome: existing, superseded: oldId, signalsAdded: 0, alreadyRecorded: true,
              adaptation: {
                changed: false, before: current.primary, after: current.primary,
                changedBecause: 'The correction was already recorded; the current next move still wins.',
              },
            });
          }
        }
        const old = await deps.store.getOutcome(oldId);
        if (!old || old.deletedAt) return json(res, 404, { error: 'no such active outcome' });
        const before = await readNextAction(minutes, undefined, requestTimeZone(req));
        // A correction changes only the fields the correction form actually
        // offers. Course, assignment and topic placement are visible controls;
        // omitted fields preserve the active relationship for older clients.
        // Structured criteria and provenance remain hidden, service-owned
        // evidence and cannot be rewritten by browser echoes.
        const replacement = await outcomeFromBody({
          ...body,
          courseId: body.courseId === undefined ? old.courseId : body.courseId,
          commitmentId: body.commitmentId === undefined ? old.commitmentId : body.commitmentId,
          topicIds: body.topicIds === undefined ? old.topicIds : body.topicIds,
          criteria: old.criteria,
          summary: old.summary,
          source: old.source,
        }, receiptId ?? randomUUID(), old.id);
        const correctedAt = deps.clock.now().toISOString();
        // Invalidate first. If the replacement write fails, stale evidence is
        // absent rather than a conceded result continuing to shape teaching.
        await deps.store.invalidateSignals(`outcome:${old.id}`);
        await deps.store.putOutcome({ ...old, deletedAt: correctedAt });
        await deps.store.putOutcome(replacement);
        const seeds = signalsForOutcome(
          replacement, Array.from({ length: outcomeSignalSeeds(replacement).length }, () => randomUUID()));
        for (const signal of seeds) await deps.store.appendSignal(signal);
        const after = await readNextAction(minutes, undefined, requestTimeZone(req));
        const changed = before.primary.id !== after.primary.id;
        return json(res, 200, {
          outcome: replacement, superseded: old.id, signalsAdded: seeds.length,
          adaptation: {
            changed, before: before.primary, after: after.primary,
            changedBecause: changed
              ? `Correcting “${old.title}” changed the next move to “${after.primary.title}”.`
              : `The correction is recorded; the current next move still wins.`,
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/commitment-series') {
        const body = await readBody(req);
        const { seriesId } = seriesIdentity(body.clientRef);
        const count = Number(body.count);
        if (!Number.isInteger(count) || count < WEEKLY_RECURRENCE_MIN
            || count > WEEKLY_RECURRENCE_MAX) {
          throw new BadRequest(`count must be between ${WEEKLY_RECURRENCE_MIN} and ${WEEKLY_RECURRENCE_MAX}`);
        }
        if (typeof body.dueAt !== 'string') throw new BadRequest('dueAt is required, as a date');
        const dates = weeklyDates(body.dueAt.trim(), count);
        if (!dates) throw new BadRequest('dueAt must be a real YYYY-MM-DD date');
        const zone = zoneOf(await deps.store.getPrefs(), requestTimeZone(req));
        const timed = body.dueTime === undefined || body.dueTime === null || body.dueTime === ''
          ? null : body.dueTime;
        if (timed !== null && (typeof timed !== 'string' || !/^\d{2}:\d{2}$/.test(timed))) {
          throw new BadRequest('dueTime must be HH:mm, or empty for a date-only deadline');
        }
        // Resolve every instant before the first store call. One DST gap means
        // no series, not nineteen dates and one error.
        const deadlines = dates.map((date) => deadlineFromBody({
          dueAt: date, ...(timed === null ? {} : { dueTime: timed }),
        }, zone));

        let plannedDates: readonly string[] | null = null;
        if (body.plannedFor !== undefined && body.plannedFor !== null && body.plannedFor !== '') {
          if (typeof body.plannedFor !== 'string') throw new BadRequest('plannedFor is not a date I can read');
          plannedDates = weeklyDates(body.plannedFor.trim(), count);
          if (!plannedDates) throw new BadRequest('plannedFor must be a real YYYY-MM-DD date');
        }
        const title = requireTrimmedBoundedString(
          body, 'title', COMMITMENT_TITLE_MAX_CHARS, 'assignment title',
        );
        const kind = requireOneOf(body, 'kind', ['assignment', 'lesson', 'study', 'task'] as const);
        const courseId = await knownCourseId(body.courseId);
        const topicIds = await knownTopicIds(optionalIds(body, 'topicIds'));
        const estimateMinutes = optionalMinutes(body, 'estimateMinutes');
        const notes = optionalText(body, 'notes');
        const requestHash = recurrenceHash({
          title, kind, courseId, topicIds, dates, timed, zone,
          plannedDates, estimateMinutes, notes, cadence: 'weekly', count,
        });
        const createdAt = deps.clock.now().toISOString();
        const rows: Commitment[] = dates.map((date, index) => ({
          id: occurrenceId(seriesId, index), title, kind, courseId, topicIds,
          ...deadlines[index]!,
          recurrence: {
            seriesId, index, total: count, cadence: 'weekly', timeZone: zone, requestHash,
          },
          plannedFor: plannedDates ? requireDate({ plannedFor: plannedDates[index]! }, 'plannedFor') : null,
          estimateMinutes, notes, doneAt: null, createdAt,
        }));
        const ids = new Set(rows.map((row) => row.id));
        const collisions = (await deps.store.listCommitments()).filter((row) =>
          ids.has(row.id) || (hasRecurrence(row) && row.recurrence.seriesId === seriesId));
        if (collisions.some((row) => !ids.has(row.id) || !hasRecurrence(row)
            || row.recurrence.seriesId !== seriesId || row.recurrence.requestHash !== requestHash)) {
          return json(res, 409, { error: 'this recurring save identity was already used for different dates' });
        }
        const existingById = new Map(collisions.map((row) => [row.id, row]));
        const resultRows = rows.map((row) => existingById.get(row.id) ?? row);
        const missing = resultRows.filter((row) => !existingById.has(row.id));
        if (missing.length) await deps.store.replaceCommitments(missing, []);
        return json(res, collisions.length ? 200 : 201, {
          seriesId, commitments: resultRows, repeated: collisions.length > 0,
        });
      }

      if (req.method === 'POST' && url.pathname === '/commitments') {
        const body = await readBody(req);
        const deadline = deadlineFromBody(
          body, zoneOf(await deps.store.getPrefs(), requestTimeZone(req)),
        );
        const commitment: Commitment = {
          id: randomUUID(),
          title: requireTrimmedBoundedString(
            body, 'title', COMMITMENT_TITLE_MAX_CHARS, 'assignment title',
          ),
          kind: requireOneOf(body, 'kind', ['assignment', 'lesson', 'study', 'task'] as const),
          courseId: await knownCourseId(body.courseId),
          // The link that makes teaching deadline-aware, and the reason this
          // ledger is worth having inside a learning product rather than beside
          // one. Refused rather than stored when it names a topic the board
          // does not have: a dangling link weighs nothing and explains nothing.
          topicIds: await knownTopicIds(optionalIds(body, 'topicIds')),
          ...deadline,
          plannedFor: optionalDate(body, 'plannedFor'),
          estimateMinutes: optionalMinutes(body, 'estimateMinutes'),
          notes: optionalText(body, 'notes'),
          doneAt: null,
          createdAt: deps.clock.now().toISOString(),
        };
        await deps.store.putCommitment(commitment);
        return json(res, 201, { commitment });
      }

      const commitmentRoute = /^\/commitments\/([^/]+)$/.exec(url.pathname);
      if (commitmentRoute) {
        const id = pathId(commitmentRoute, 1);
        const existing = await deps.store.getCommitment(id);
        if (!existing) return json(res, 404, { error: 'no such commitment' });
        const seriesScope = url.searchParams.get('scope');
        if (seriesScope !== null && seriesScope !== 'remaining') {
          throw new BadRequest('scope must be remaining when it is supplied');
        }

        if (req.method === 'DELETE') {
          if (seriesScope === 'remaining') {
            if (!hasRecurrence(existing)) throw new BadRequest('this commitment is not part of a safe recurring series');
            const series = (await deps.store.listCommitments()).filter((row) =>
              hasRecurrence(row) && row.recurrence.seriesId === existing.recurrence.seriesId
              && row.recurrence.index >= existing.recurrence.index);
            const remove = series.filter((row) => !row.doneAt).map((row) => row.id);
            const preservedCompleted = series.length - remove.length;
            await deps.store.replaceCommitments([], remove);
            return json(res, 200, { ok: true, removed: remove.length, preservedCompleted });
          }
          await deps.store.deleteCommitment(id);
          return json(res, 200, { ok: true });
        }
        if (req.method === 'PUT') {
          const body = await readBody(req);
          if (seriesScope === 'remaining') {
            if (!hasRecurrence(existing)) throw new BadRequest('this commitment is not part of a safe recurring series');
            if (existing.doneAt) throw new BadRequest('a completed occurrence keeps its historical deadline');
            if (Object.keys(body).some((key) => key !== 'dueAt' && key !== 'dueTime')) {
              throw new BadRequest('a remaining-series edit changes only its deadline');
            }
            if (typeof body.dueAt !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(body.dueAt.trim())) {
              throw new BadRequest('dueAt is required as YYYY-MM-DD for a remaining-series edit');
            }
            const anchorDate = body.dueAt.trim();
            const all = await deps.store.listCommitments();
            const later = all.filter((row) => hasRecurrence(row)
              && row.recurrence.seriesId === existing.recurrence.seriesId
              && row.recurrence.index >= existing.recurrence.index);
            const targets = later.filter((row) => !row.doneAt).sort((a, b) =>
              (a.recurrence?.index ?? 0) - (b.recurrence?.index ?? 0));
            const changed = targets.map((row) => {
              const recurrence = hasRecurrence(row) ? row.recurrence : existing.recurrence;
              const date = calendarDateAfterWeeks(
                anchorDate, recurrence.index - existing.recurrence.index,
              );
              if (!date) throw new BadRequest('the remaining weekly dates could not be generated');
              const deadlineBody: Record<string, unknown> = { dueAt: date };
              if (body.dueTime !== undefined) deadlineBody.dueTime = body.dueTime;
              return {
                ...row,
                ...deadlineFromBody(deadlineBody, existing.recurrence.timeZone, row),
              };
            });
            await deps.store.replaceCommitments(changed, []);
            return json(res, 200, {
              commitment: changed.find((row) => row.id === id) ?? existing,
              commitments: changed,
              changed: changed.length,
              preservedCompleted: later.length - changed.length,
              scope: 'remaining',
            });
          }
          const deadline = body.dueAt === undefined && body.dueTime === undefined
            ? null
            : deadlineFromBody(
              body, zoneOf(await deps.store.getPrefs(), requestTimeZone(req)), existing,
            );
          const next: Commitment = {
            ...existing,
            title: body.title === undefined ? existing.title : requireTrimmedBoundedString(
              body, 'title', COMMITMENT_TITLE_MAX_CHARS, 'assignment title',
            ),
            kind: body.kind === undefined
              ? existing.kind
              : requireOneOf(body, 'kind', ['assignment', 'lesson', 'study', 'task'] as const),
            ...(deadline ?? {}),
            plannedFor: body.plannedFor === undefined ? existing.plannedFor : optionalDate(body, 'plannedFor'),
            estimateMinutes: body.estimateMinutes === undefined
              ? existing.estimateMinutes : optionalMinutes(body, 'estimateMinutes'),
            courseId: body.courseId === undefined
              ? existing.courseId : await knownCourseId(body.courseId),
            // Writable from the Plan card's menu and from the add form, and
            // held to the same rule as creation: every id names a live topic.
            topicIds: body.topicIds === undefined
              ? existing.topicIds : await knownTopicIds(optionalIds(body, 'topicIds')),
            notes: body.notes === undefined ? existing.notes : optionalText(body, 'notes'),
          };
          await deps.store.putCommitment(next);
          return json(res, 200, { commitment: next });
        }
      }

      /**
       * Closing one — the only scoring event in the product.
       *
       * Idempotent on purpose, and idempotent against the LEDGER rather than
       * against the tick. A double tap, a retried request over a flaky
       * connection, or two tabs open would otherwise pay twice for one piece of
       * work, and a points total that can be farmed by pressing a button
       * repeatedly is not a total worth showing. Reopening and ticking again is
       * the same farm with an extra step, so the reasons this commitment has
       * already been paid for are read back before anything is appended.
       */
      const doneRoute = /^\/commitments\/([^/]+)\/done$/.exec(url.pathname);
      if (req.method === 'POST' && doneRoute) {
        const id = pathId(doneRoute, 1);
        const existing = await deps.store.getCommitment(id);
        if (!existing) return json(res, 404, { error: 'no such commitment' });
        if (existing.doneAt) {
          return json(res, 200, { commitment: existing, awarded: [], alreadyDone: true });
        }
        const closedAt = deps.clock.now().toISOString();
        const closed: Commitment = { ...existing, doneAt: closedAt };
        await deps.store.putCommitment(closed);
        const awarded: Award[] = [];
        const [ledger, prefs] = await Promise.all([
          deps.store.listAwards(), deps.store.getPrefs(),
        ]);
        for (const a of unpaidAwardsForClosing(
          closed, closedAt, ledger, zoneOf(prefs, requestTimeZone(req)),
        )) {
          const award: Award = { ...a, id: randomUUID() };
          await deps.store.appendAward(award);
          awarded.push(award);
        }
        const points = totalPoints(await deps.store.listAwards());
        return json(res, 200, {
          commitment: closed, awarded, points, stars: starsFrom(points),
        });
      }

      /**
       * Re-opening one, which scores nothing and takes nothing away.
       *
       * A learner who ticked the wrong row must be able to untick it. The
       * awards it earned stay in the ledger — they are a record of a moment,
       * and a ledger that can be rewound is one somebody can farm by ticking
       * and unticking. Closing it again is idempotent above, so the second
       * close pays nothing.
       */
      const reopenRoute = /^\/commitments\/([^/]+)\/reopen$/.exec(url.pathname);
      if (req.method === 'POST' && reopenRoute) {
        const id = pathId(reopenRoute, 1);
        const existing = await deps.store.getCommitment(id);
        if (!existing) return json(res, 404, { error: 'no such commitment' });
        const reopened: Commitment = { ...existing, doneAt: null };
        await deps.store.putCommitment(reopened);
        return json(res, 200, { commitment: reopened });
      }

      /**
       * ---------------------------------------------------------------------
       * QUICK BURST — five minutes of recall, from the queue that already exists.
       *
       * The answers are evidence and DO reach the signal ledger: "can you still
       * explain this" is the same question a session's recall check asks, and
       * it is the highest-grade signal this product collects. The burst's own
       * reward does not — points are read from the award ledger, so no amount
       * of bursting can flatter the comfort model.
       */
      if (req.method === 'GET' && url.pathname === '/burst') {
        const now = deps.clock.now();
        const [topics, signals] = await Promise.all([
          deps.store.listTopics(), deps.store.listSignals(),
        ]);
        return json(res, 200, {
          minutes: BURST_MINUTES,
          items: planBurst(topics, signals, now),
        });
      }

      if (req.method === 'POST' && url.pathname === '/burst/answer') {
        const body = await readBody(req);
        const topicId = requireString(body, 'topicId');
        const topic = await deps.store.getTopic(topicId);
        if (!topic) {
          return json(res, 404, { error: 'no such topic' });
        }
        const receiptId = clientReceiptId('burst-answer', body.clientRef);
        if (receiptId) {
          const existing = (await deps.store.listSignals(topicId)).find((signal) => signal.id === receiptId);
          if (existing) {
            return json(res, 200, {
              ok: true,
              verdict: existing.direction === 'positive' ? 'got-it' : 'not-really',
              feedback: null,
              alreadyRecorded: true,
            });
          }
        }
        let verdict: 'got-it' | 'not-really';
        let feedback: string | null = null;
        if (typeof body['answer'] === 'string') {
          const answer = requireTrimmedBoundedString(body, 'answer', LEARNER_ANSWER_MAX_CHARS);
          if (!answer) return json(res, 400, { error: 'answer must not be empty' });
          const prompt = burstPrompt(topic.label);
          const marked = await markRecallAnswer(at('answer'), {
            heading: topic.label,
            evidence: burstEvidence(topic, await deps.store.listPins()),
            prompt,
          }, answer);
          verdict = marked.signal === 'answer-correct' ? 'got-it' : 'not-really';
          feedback = marked.response;
        } else {
          // Backward compatibility only for the explicit “I don't remember”
          // route. An older panel's positive confidence tap is refused: the
          // evidence boundary must hold at the service, not only in current
          // markup.
          verdict = requireOneOf(body, 'verdict', ['got-it', 'not-really'] as const);
          if (verdict === 'got-it') {
            return json(res, 409, { error: 'Write what you remember so Virgil can check it against what you saved.' });
          }
        }
        const { type, direction } = burstSignalFor(verdict);
        await deps.store.appendSignal({
          id: receiptId ?? randomUUID(), topicId, type, direction,
          at: deps.clock.now().toISOString(),
          sourceEvent: 'burst', invalidated: false,
        });
        return json(res, 200, { ok: true, verdict, feedback });
      }

      /**
       * One-release compatibility for panels that still close a burst through
       * this route. Each successful answer has already written its own honest
       * recall signal. Finishing adds no participation award: otherwise three
       * explicit "I don't remember" answers become a points-earning event.
       * Current panels close locally after the last accepted answer.
      */
      if (req.method === 'POST' && url.pathname === '/burst/done') {
        await readBody(req);
        const points = totalPoints(await deps.store.listAwards());
        return json(res, 200, {
          awarded: [], points, stars: starsFrom(points), alreadyFinished: true,
        });
      }

      /**
       * ---------------------------------------------------------------------
       * COURSES — the study controller.
       *
       * Progress is two counts and never a percentage: what has been got
       * through (self-reported) and what the board says has actually landed
       * (evidence). Collapsing them would let the weaker claim borrow the
       * stronger one's authority, and a course percentage is a comfort number
       * with a course's name on it.
       */
      if (req.method === 'GET' && url.pathname === '/courses') {
        const now = deps.clock.now();
        const [courses, topics, commitments, prefs] = await Promise.all([
          deps.store.listCourses(), deps.store.listTopics(), deps.store.listCommitments(),
          deps.store.getPrefs(),
        ]);
        const timeZone = zoneOf(prefs, requestTimeZone(req));
        const settled = new Set(topics.filter((t) => t.state === 'settled').map((t) => t.id));
        const labels = new Map(topics.map((t) => [t.id, t.label]));
        const live = courses.filter((c) => !c.archivedAt);
        const archived = courses.filter((c) => c.archivedAt);
        const knownCourseIds = new Set(courses.map((c) => c.id));
        const open = commitments.filter((c) => !c.doneAt);
        const withState = (list: readonly Commitment[]): unknown[] =>
          orderCommitments(list, now, timeZone)
            .map((c) => ({ ...c, state: commitmentState(c, now, timeZone) }));
        /**
         * A topic can belong to a course in two honest ways: the course names
         * it directly, or the learner linked it to work for that course. The
         * lineup already resolves those claims through `subjectForTopic`; My
         * studies must use the same answer or completed course work appears
         * under "Not in a course" the moment it leaves Coming up.
         *
         * This is a view, not a backfill. In particular, `courseProgress`
         * continues to read the course's canonical `topicIds`: work linked by
         * the learner can explain where a topic belongs without quietly
         * widening the stronger evidence denominator.
         */
        const subjectByTopic = new Map(topics.map((t) => [
          t.id, subjectForTopic(t.id, courses, commitments)?.courseId ?? null,
        ]));
        const inACourse = new Set(
          topics.filter((t) => subjectByTopic.get(t.id) !== null).map((t) => t.id),
        );
        const effectiveTopicIds = (course: Course): string[] => {
          const direct = course.topicIds.filter((id) =>
            labels.has(id) && subjectByTopic.get(id) === course.id);
          const already = new Set(direct);
          const implied = topics
            .filter((t) => !already.has(t.id) && subjectByTopic.get(t.id) === course.id)
            .map((t) => t.id);
          return [...direct, ...implied];
        };
        const courseView = (c: Course, includeComing: boolean) => ({
            ...c,
            progress: courseProgress(c, settled),
            // What this course has coming, ordered the way the Plan orders it,
            // so "coming up" cannot mean two different things in two rooms.
            commitments: includeComing ? withState(open.filter((k) => k.courseId === c.id)) : [],
            // The board's own words for what this course grew. Free: the topics
            // were already read for `settled`.
            topics: (includeComing ? effectiveTopicIds(c) : [...c.topicIds])
              .filter((id) => labels.has(id))
              .map((id) => ({ id, label: labels.get(id) as string })),
          });
        return json(res, 200, {
          courses: live.map((c) => courseView(c, true)),
          archivedCourses: archived.map((c) => courseView(c, false)),
          // My studies owns the result rows, so its Add sheet needs the same
          // choices Plan's result form receives. These three lists are already
          // in this request: projecting them here avoids a fourth endpoint and
          // another three store reads merely because the learner opened the
          // room where the result will be displayed.
          outcomeContext: {
            courses: live.map((c) => ({ id: c.id, title: c.title })),
            commitments: commitments.map((c) => ({
              id: c.id, title: c.title, courseId: c.courseId,
            })),
            topics: topics.filter((t) => !t.retiredByUser)
              .map((t) => ({ id: t.id, label: t.label })),
          },
          /**
           * What the learner is studying that no course claims.
           *
           * Study time and lessons typed in by hand, and topics the board grew
           * from somewhere else. Without this the room would show a tidy set of
           * courses and quietly omit half of what somebody is actually doing,
           * which is the complaint this room was rebuilt for.
           */
          unattached: {
            commitments: withState(open.filter((k) =>
              (!k.courseId && (k.kind === 'study' || k.kind === 'lesson'))
              || (!!k.courseId && !knownCourseIds.has(k.courseId)))),
            topics: topics
              .filter((t) => !t.retiredByUser && !inACourse.has(t.id))
              .map((t) => ({ id: t.id, label: t.label })),
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/courses') {
        const body = await readBody(req);
        const url_ = optionalText(body, 'url');
        const course: Course = {
          id: randomUUID(),
          title: requireTrimmedBoundedString(body, 'title', COURSE_TITLE_MAX_CHARS, 'course name'),
          provider: optionalTrimmedBoundedString(
            body, 'provider', COURSE_PROVIDER_MAX_CHARS, 'course provider',
          ),
          // Refused rather than stored: this string is rendered as an href, and
          // a course can be created from a pasted syllabus — text nobody wrote
          // by hand. `javascript:` and `data:` are how a bookmark list becomes
          // a script injection.
          url: url_ && !isOpenableUrl(url_) ? '' : url_,
          material: [],
          topicIds: [],
          archivedAt: null,
          createdAt: deps.clock.now().toISOString(),
        };
        await deps.store.putCourse(course);
        return json(res, 201, { course });
      }

      /**
       * A+ course intake — propose, inspect, correct, then apply.
       *
       * This first pass is deliberately deterministic so the full product loop
       * works with no provider credits. A model-backed specialist may enrich a
       * proposal, but it reaches the same draft and validation boundary: source
       * text never writes a deadline, signal, award, or link directly.
       */
      if (url.pathname === '/course-intakes') {
        if (req.method === 'GET') {
          return json(res, 200, { drafts: await deps.store.listIntakeDrafts() });
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const timeZone = zoneOf(await deps.store.getPrefs(), requestTimeZone(req));
          const receipt = await receiveCourseIntake(body, timeZone);
          return json(res, receipt.status, receipt.body);
        }
      }

      if (req.method === 'POST' && url.pathname === '/course-intakes/bulk') {
        const body = await readBody(req);
        if (!Array.isArray(body.sources) || body.sources.length === 0) {
          throw new BadRequest('sources must be a non-empty array');
        }
        if (body.sources.length > BULK_INTAKE_LIMIT) {
          throw new BadRequest(`sources must contain at most ${BULK_INTAKE_LIMIT} entries`);
        }
        // Parse every source before the first write. A malformed 25th row must
        // not leave 24 apparently successful drafts behind it.
        const sources = body.sources.map((raw, index) => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new BadRequest(`sources.${index} must be an object`);
          }
          try { return intakeRequestFrom(raw as Record<string, unknown>); }
          catch (error) {
            if (error instanceof BadRequest) throw new BadRequest(`sources.${index}: ${error.message}`);
            throw error;
          }
        });
        const drafts = [];
        const timeZone = zoneOf(await deps.store.getPrefs(), requestTimeZone(req));
        for (const source of sources) {
          // Bulk planning is deliberately deterministic. A learner can ask to
          // enrich one reviewed draft later without buying 25 hidden calls.
          drafts.push(await createIntakeDraft(source, false, timeZone));
        }
        return json(res, 201, { drafts, count: drafts.length, authoritativeWrites: 0 });
      }

      /**
       * What the server can read, before anybody sends it three hundred files.
       *
       * A drop that discovers its PDFs are unreadable *after* uploading eighty
       * megabytes of them has wasted the one thing the learner cannot get back.
       * The table is `core/domain/documents.ts`'s and is served rather than
       * restated, so this endpoint cannot drift from what the parser does.
       */
      if (req.method === 'GET' && url.pathname === '/course-drops/formats') {
        return json(res, 200, {
          maxItems: DROP_ITEM_LIMIT,
          identity: DROP_IDENTITY_CONTRACT,
          source: DROP_SOURCE_CONTRACT,
          contentBase64: DROP_BASE64_CONTRACT,
          caps: { ...DOCUMENT_CAPS, textChars: DOCUMENT_TEXT_CHARS },
          formats: SERVER_PARSE_COVERAGE,
        });
      }

      /**
       * The semester drop. See the block comment above `DROP_KINDS`.
       *
       * Every item is read before the first write, exactly as `/course-intakes/bulk`
       * parses before it writes and for the same reason: a malformed item at
       * position 240 must not leave 239 half-imported documents behind it. What
       * is *different* here is that an item this cannot read is not a malformed
       * request — a folder with PDFs in it is an ordinary folder — so a read
       * failure is a per-item receipt and a 201, while a malformed item is still
       * a 400 for the whole drop.
       */
      if (req.method === 'POST' && url.pathname === '/course-drops') {
        const body = await readBody(req);
        if (!Array.isArray(body.items) || body.items.length === 0) {
          throw new BadRequest('items must be a non-empty array');
        }
        if (body.items.length > DROP_ITEM_LIMIT) {
          throw new BadRequest(`items must contain at most ${DROP_ITEM_LIMIT} entries`);
        }
        const title = typeof body.title === 'string' && !rendersEmpty(body.title)
          ? stripInvisible(body.title).slice(0, 160) : 'Dropped course';
        const parsed = body.items.map((raw, index) => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new BadRequest(`items.${index} must be an object`);
          }
          try { return dropItemFrom(raw as Record<string, unknown>, index); }
          catch (error) {
            if (error instanceof BadRequest) throw new BadRequest(`items.${index}: ${error.message}`);
            throw error;
          }
        });
        if (new Set(parsed.map((item) => item.clientRef)).size !== parsed.length) {
          throw new BadRequest('items must use unique clientRef values');
        }

        /**
         * The drop's id, and the whole of its idempotence.
         *
         * Given by the client where they gave one, because the retry this has to
         * survive is *the same drop sent twice* — a three-hundred-item request
         * over a slow link is the most retryable thing in the product. Every pin
         * it makes is keyed `<dropId>:<clientRef>`, so a repeat finds its own
         * pins already there and adds none. Absent, a fresh id is minted and a
         * repeat is genuinely a second drop, which is the honest reading of a
         * client that declined to name its own gesture.
         */
        const dropId = exactAgentIdentity(
          body.dropId, 'dropId', DROP_ID_MAX_CHARS, refuseBadRequest,
        )
          ?? `drop-${randomUUID()}`;
        /**
         * **A colon is the separator, so a colon cannot be in the left half.**
         *
         * The pin key is `<dropId>:<clientRef>` and the replay scan finds a
         * drop's own pins by that prefix. Both halves were free-form, so the
         * join was ambiguous: drop `cs101` with an item called `week1:notes`
         * writes exactly the key drop `cs101:week1` writes for an item called
         * `notes`. Two learners' folders cannot collide here — it is one board —
         * but two of *their own* drops can, and the failure is the silent one:
         * the second drop finds a pin the first wrote, reports every item as
         * `repeated`, and imports nothing while answering 201.
         *
         * Refusing a colon in the id makes the first colon always the
         * separator, so the pair is recoverable from the key and no two distinct
         * pairs can produce one. The `clientRef` side may still carry ordinary
         * path characters, including colons, inside its separately published
         * exact-value bound.
         *
         * A 400 rather than a quiet rewrite, because the id is the client's
         * name for its own gesture and silently storing pins under a *different*
         * id than the one it sent would break the retry this whole scheme is
         * for. The minted id changed shape with the rule — `drop-<uuid>` — so
         * the thing this endpoint hands out is a thing it will accept back.
         */
        if (dropId.includes(':')) {
          throw new BadRequest('dropId must not contain ":" — it separates the drop from the item; '
            + 'use another character, or send no dropId and use the one this returns');
        }
        const already = new Map(
          (await deps.store.listPins())
            .filter((p) => typeof p.clientRef === 'string' && p.clientRef.startsWith(`${dropId}:`))
            .map((p) => [p.clientRef as string, p]));

        /**
         * WHAT A RESUMED DROP FINDS, INCLUDING ACROSS CHUNKS.
         *
         * A planning item is two writes: the pin, then the draft. Both now have
         * storage ids derived from the drop and item identity. Content matching
         * was sufficient only while all items shared one request-local map. A
         * chunk boundary rebuilt that map and allowed two byte-identical files
         * to claim the same existing draft, permanently hiding the torn one.
         * Stable ids make the missing second write directly observable and make
         * concurrent redelivery an upsert of the same artifacts.
         */
        const draftIdentityFor = (item: DropItem): IntakeIdentity => ({
          draftId: dropArtifactId('draft', dropId, item.clientRef),
          sourceId: dropArtifactId('source', dropId, item.clientRef),
        });
        const draftContentKey = (kind: CourseSourceKind, digest: string): string => `${kind} ${digest}`;
        let legacyDraftsByContent: Map<string, string[]> | null = null;
        const legacyDraftFor = async (kind: CourseSourceKind, text: string): Promise<string | null> => {
          if (!legacyDraftsByContent) {
            legacyDraftsByContent = new Map();
            for (const draft of await deps.store.listIntakeDrafts()) {
              if (draft.id.startsWith('drop_draft_')) continue;
              const key = draftContentKey(draft.source.kind, draft.source.digest);
              const ids = legacyDraftsByContent.get(key);
              if (ids) ids.push(draft.id); else legacyDraftsByContent.set(key, [draft.id]);
            }
          }
          const digest = `sha256:${createHash('sha256').update(text).digest('hex')}`;
          return legacyDraftsByContent.get(draftContentKey(kind, digest))?.pop() ?? null;
        };

        /** The title the fresh path gives a draft — a page's `<title>` beats its
         *  file name, and only a page has one. Hoisted so the replayed path can
         *  make exactly the draft the interrupted attempt would have made. */
        const draftTitleFor = (item: DropItem, format: string): string =>
          (format === 'html' && item.text ? htmlTitle(item.text) : null) ?? item.name;

        const intakeTimeZone = zoneOf(await deps.store.getPrefs(), requestTimeZone(req));
        const receipts = [];
        let read = 0, failed = 0, planned = 0, repeated = 0;
        for (const item of parsed) {
          const itemRead = await readDropItem(item);
          const outcome = itemRead.outcome;
          if (outcome.kind !== 'text') {
            failed++;
            receipts.push({
              clientRef: item.clientRef, name: item.name, ok: false,
              reason: outcome.kind, detail: describeDropRead(itemRead),
            });
            continue;
          }
          read++;
          const key = `${dropId}:${item.clientRef}`;
          const seen = already.get(key);
          if (seen) {
            if (!sameDropSource(seen, item, outcome.text, title)) {
              return json(res, 409, {
                error: 'dropId and clientRef already name different course material; reuse them only for an exact retry',
                clientRef: item.clientRef,
              });
            }
            repeated++;
            // The pin is here. Whether the *draft* is here is a different
            // question, and the one an interrupted attempt can answer no to.
            let draftId: string | null = null;
            let resumed = false;
            if (PLANNING_KINDS.has(item.kind)) {
              const identity = draftIdentityFor(item);
              draftId = (await deps.store.getIntakeDraft(identity.draftId))?.id ?? null;
              // Source built before stable drop identities shipped: preserve
              // its existing proposal instead of creating a migration duplicate.
              if (draftId === null) draftId = await legacyDraftFor(item.kind, outcome.text);
              if (draftId === null) {
                const made = await createIntakeDraft({
                  text: outcome.text, sourceKind: item.kind,
                  sourceTitle: draftTitleFor(item, outcome.format),
                  url: item.url,
                }, false, intakeTimeZone, identity, dropReadWarnings(itemRead));
                draftId = made.draft.id;
                planned++;
                resumed = true;
              }
            }
            const replayDetail = resumed
              ? 'already on the board from an earlier attempt at this drop, which did not get as far as the plan — proposed now'
              : 'already on the board from an earlier attempt at this drop';
            receipts.push({
              clientRef: item.clientRef, name: item.name, ok: true,
              format: outcome.format, pinId: seen.id, draftId, repeated: true,
              truncated: outcome.truncated,
              detail: outcome.truncated || itemRead.fetchedStructure !== null
                ? `${replayDetail}; ${describeDropRead(itemRead)}`
                : replayDetail,
            });
            continue;
          }
          const pin = pinForDrop(item, dropId, title, outcome.text);
          await deps.store.putPin(pin);
          let draftId: string | null = null;
          if (PLANNING_KINDS.has(item.kind)) {
            // Deterministic only. The specialist runs in the nightly's `intake`
            // stage, which is what makes three hundred documents a queue rather
            // than three hundred model calls inside this request.
            // The draft's own title still comes from the source's `Course:`
            // field where it has one; `draftTitleFor` is what it falls back to.
            const made = await createIntakeDraft({
              text: outcome.text, sourceKind: item.kind,
              sourceTitle: draftTitleFor(item, outcome.format),
              url: item.url,
            }, false, intakeTimeZone, draftIdentityFor(item), dropReadWarnings(itemRead));
            draftId = made.draft.id;
            planned++;
          }
          receipts.push({
            clientRef: item.clientRef, name: item.name, ok: true,
            format: outcome.format, pinId: pin.id, draftId, repeated: false,
            truncated: outcome.truncated,
            detail: describeDropRead(itemRead),
          });
        }

        /**
         * What the learner is told, and it is arithmetic rather than a promise.
         *
         * `nights` is `ceil(queued / cap)` over the two paced stages, computed
         * from the same cap the run will actually apply. It is the answer to the
         * only question somebody who has just dropped a semester has, and it is
         * the number this lane exists to be able to state honestly.
         */
        const queuedPins = (await deps.store.listPins({ unenrichedOnly: true })).length;
        const queuedDrafts = (await deps.store.listIntakeDrafts()).filter(owesIntakeEnrichment).length;
        const nights = workCap === null ? 1
          : Math.max(1, Math.ceil(Math.max(queuedPins, queuedDrafts) / workCap));
        return json(res, 201, {
          dropId,
          title,
          items: receipts,
          read,
          failed,
          repeated,
          planned,
          // Said out loud on every drop. Nothing here is a course, a deadline or
          // a commitment until somebody applies the draft it came from.
          authoritativeWrites: 0,
          queue: { pins: queuedPins, drafts: queuedDrafts, perRun: workCap, nights },
        });
      }

      const intakeRoute = /^\/course-intakes\/([^/]+)$/.exec(url.pathname);
      if (intakeRoute) {
        const id = pathId(intakeRoute, 1);
        const draft = await deps.store.getIntakeDraft(id);
        if (!draft) return json(res, 404, { error: 'no such intake draft' });
        if (req.method === 'GET') return json(res, 200, { draft });
        if (req.method === 'PATCH') {
          const body = await readBody(req);
          if (typeof body.value !== 'string') {
            throw new BadRequest('value must be a string');
          }
          let edited;
          try {
            edited = editIntakeDraft(
              draft, requireString(body, 'field'),
              body.value,
              deps.clock.now().toISOString(),
              zoneOf(await deps.store.getPrefs(), requestTimeZone(req)),
            );
          } catch (err) {
            throw new BadRequest(err instanceof Error ? err.message : String(err));
          }
          await deps.store.putIntakeDraft(edited);
          return json(res, 200, { draft: edited });
        }
      }

      const enhanceIntake = /^\/course-intakes\/([^/]+)\/enhance$/.exec(url.pathname);
      if (req.method === 'POST' && enhanceIntake) {
        const id = pathId(enhanceIntake, 1);
        const draft = await deps.store.getIntakeDraft(id);
        if (!draft) return json(res, 404, { error: 'no such intake draft' });
        if (draft.status !== 'draft') return json(res, 409, { error: 'an applied intake cannot be enriched' });
        const enriched = await enrichCourseIntake(at('course-intake'), draft, randomUUID);
        const next = {
          ...enriched.draft,
          enrichment: {
            outcome: enriched.outcome,
            attemptedAt: deps.clock.now().toISOString(),
            added: enriched.added,
          },
        };
        await deps.store.putIntakeDraft(next);
        return json(res, 200, { draft: next, extraction: enriched.outcome, agentAdded: enriched.added });
      }

      const applyIntake = /^\/course-intakes\/([^/]+)\/apply$/.exec(url.pathname);
      if (req.method === 'POST' && applyIntake) {
        const id = pathId(applyIntake, 1);
        const draft = await deps.store.getIntakeDraft(id);
        if (!draft) return json(res, 404, { error: 'no such intake draft' });
        if (draft.status === 'applied') {
          const courseId = `course:${draft.id}`;
          const course = await deps.store.getCourse(courseId);
          if (!course) return json(res, 409, { error: 'applied intake has no course', courseId });
          return json(res, 200, { alreadyApplied: true, courseId, course });
        }
        const errors = validateIntakeDraft(draft);
        if (errors.length) return json(res, 409, { error: 'draft needs review', errors, draft });
        const courseId = `course:${draft.id}`;
        const course: Course = {
          id: courseId, title: draft.title, provider: draft.provider, url: draft.url,
          objectives: draft.objectives.filter((objective) =>
            !isIntakeProposalRejected(draft, 'objective', objective.id)),
          sources: [draft.source], topicIds: [],
          material: draft.material.filter((material) =>
            !isIntakeProposalRejected(draft, 'material', material.id)).map((m) => ({
            id: m.id, title: m.title, url: m.url, kind: m.kind, minutes: m.minutes,
            doneAt: null, pinIds: [], addedAt: draft.createdAt, source: m.source,
          })),
          archivedAt: null, createdAt: draft.createdAt,
        };
        // Stable ids make a retry after a partial store failure an upsert, not
        // a duplicate import. The draft is marked applied last.
        await deps.store.putCourse(course);
        const commitments: Commitment[] = [];
        for (const proposed of draft.commitments.filter((commitment) =>
          !isIntakeProposalRejected(draft, 'commitment', commitment.id))) {
          const commitment: Commitment = {
            id: proposed.id, title: proposed.title, kind: proposed.kind, courseId,
            topicIds: proposed.topicIds, dueAt: proposed.dueAt as string,
            ...(proposed.dueTime && proposed.dueTimeZone
              ? { dueTime: proposed.dueTime, dueTimeZone: proposed.dueTimeZone }
              : {}),
            plannedFor: proposed.plannedFor, estimateMinutes: proposed.estimateMinutes,
            notes: proposed.notes, doneAt: null, createdAt: draft.createdAt,
            source: proposed.source, rubricCriteria: proposed.rubricCriteria,
          };
          await deps.store.putCommitment(commitment);
          commitments.push(commitment);
        }
        const appliedAt = deps.clock.now().toISOString();
        await deps.store.putIntakeDraft({ ...draft, status: 'applied', appliedAt });
        return json(res, 201, { course, commitments, appliedAt });
      }

      const courseRoute = /^\/courses\/([^/]+)$/.exec(url.pathname);
      if (courseRoute) {
        const id = pathId(courseRoute, 1);
        const course = await deps.store.getCourse(id);
        if (!course) return json(res, 404, { error: 'no such course' });
        if (req.method === 'PUT') {
          const body = await readBody(req);
          const allowed = new Set(['title', 'provider', 'url', 'archived']);
          const supplied = Object.keys(body);
          if (!supplied.length || supplied.some((key) => !allowed.has(key))) {
            throw new BadRequest('change title, provider, url or archived only');
          }
          const title = body.title === undefined ? course.title : requireTrimmedBoundedString(
            body, 'title', COURSE_TITLE_MAX_CHARS, 'course name',
          );
          const provider = body.provider === undefined ? course.provider : optionalTrimmedBoundedString(
            body, 'provider', COURSE_PROVIDER_MAX_CHARS, 'course provider',
          );
          const link = body.url === undefined ? course.url : optionalText(body, 'url');
          if (link && !isOpenableUrl(link)) throw new BadRequest('that link is not one I can open');
          if (body.archived !== undefined && typeof body.archived !== 'boolean') {
            throw new BadRequest('archived must be true or false');
          }
          const archivedAt = body.archived === undefined
            ? course.archivedAt
            : (body.archived ? (course.archivedAt ?? deps.clock.now().toISOString()) : null);
          const next: Course = { ...course, title, provider, url: link, archivedAt };
          await deps.store.putCourse(next);
          return json(res, 200, { course: next });
        }
        if (req.method === 'DELETE') {
          if (!course.archivedAt) {
            return json(res, 409, { error: 'archive this course before deleting it' });
          }
          await deps.store.deleteCourse(id);
          return json(res, 200, {
            ok: true,
            deleted: {
              courseId: id,
              materialCount: course.material.length,
              objectiveCount: course.objectives?.length ?? 0,
              sourceCount: course.sources?.length ?? 0,
            },
          });
        }
      }

      const materialItem = /^\/courses\/([^/]+)\/material\/([^/]+)$/.exec(url.pathname);
      if (materialItem && (req.method === 'PUT' || req.method === 'DELETE')) {
        const [courseId, materialId] = [pathId(materialItem, 1), pathId(materialItem, 2)];
        const course = await deps.store.getCourse(courseId);
        if (!course) return json(res, 404, { error: 'no such course' });
        if (course.archivedAt) throw new BadRequest('restore this course before changing its material');
        const material = course.material.find((row) => row.id === materialId);
        if (!material) return json(res, 404, { error: 'no such material' });
        if (req.method === 'DELETE') {
          await deps.store.putCourse({ ...course, material: course.material.filter((row) => row.id !== materialId) });
          return json(res, 200, { ok: true, deleted: { courseId, materialId } });
        }
        const revised = reviseCourseMaterial(material, await readBody(req));
        if (!revised.ok) throw new BadRequest(revised.error);
        const updated = revised.material;
        const next: Course = {
          ...course,
          material: course.material.map((row) => row.id === materialId ? updated : row),
        };
        await deps.store.putCourse(next);
        return json(res, 200, { course: next, material: updated });
      }

      const materialMove = /^\/courses\/([^/]+)\/material\/([^/]+)\/move$/.exec(url.pathname);
      if (req.method === 'POST' && materialMove) {
        const [sourceId, materialId] = [pathId(materialMove, 1), pathId(materialMove, 2)];
        const source = await deps.store.getCourse(sourceId);
        if (!source) return json(res, 404, { error: 'no such course' });
        if (source.archivedAt) throw new BadRequest('restore this course before moving its material');
        const body = await readBody(req);
        if (typeof body.courseId !== 'string' || !body.courseId) {
          throw new BadRequest('courseId must name the destination course');
        }
        if (body.courseId === sourceId) throw new BadRequest('choose a different course');
        const target = await deps.store.getCourse(body.courseId);
        if (!target) return json(res, 404, { error: 'no such destination course' });
        if (target.archivedAt) throw new BadRequest('restore the destination course first');
        const material = source.material.find((row) => row.id === materialId);
        if (!material) return json(res, 404, { error: 'no such material' });
        if (target.material.some((row) => row.id === materialId)) {
          return json(res, 409, { error: 'that material is already in the destination course' });
        }
        const from: Course = {
          ...source, material: source.material.filter((row) => row.id !== materialId),
        };
        const to: Course = { ...target, material: [...target.material, material] };
        await deps.store.replaceCourses([from, to], []);
        return json(res, 200, { source: from, destination: to, material });
      }

      const materialRoute = /^\/courses\/([^/]+)\/material$/.exec(url.pathname);
      if (req.method === 'POST' && materialRoute) {
        const id = pathId(materialRoute, 1);
        const course = await deps.store.getCourse(id);
        if (!course) return json(res, 404, { error: 'no such course' });
        const body = await readBody(req);
        const link = optionalText(body, 'url');
        if (link && !isOpenableUrl(link)) throw new BadRequest('that link is not one I can open');
        const material: Material = {
          id: randomUUID(),
          title: requireTrimmedBoundedString(
            body, 'title', MATERIAL_TITLE_MAX_CHARS, 'material title',
          ),
          url: link,
          kind: requireOneOf(body, 'kind', ['video', 'reading', 'class', 'exercise', 'other'] as const),
          minutes: optionalMinutes(body, 'minutes'),
          doneAt: null,
          pinIds: [],
          addedAt: deps.clock.now().toISOString(),
        };
        const next: Course = { ...course, material: [...course.material, material] };
        await deps.store.putCourse(next);
        return json(res, 201, { course: next });
      }

      const materialDone = /^\/courses\/([^/]+)\/material\/([^/]+)\/done$/.exec(url.pathname);
      if (req.method === 'POST' && materialDone) {
        const [courseId, materialId] = [pathId(materialDone, 1), pathId(materialDone, 2)];
        const course = await deps.store.getCourse(courseId);
        if (!course) return json(res, 404, { error: 'no such course' });
        const found = course.material.some((m) => m.id === materialId);
        if (!found) return json(res, 404, { error: 'no such material' });
        const now = deps.clock.now().toISOString();
        // The learner alone owns completion and can correct it.
        const next: Course = {
          ...course,
          material: course.material.map((m) =>
            m.id === materialId ? { ...m, doneAt: m.doneAt ? null : now } : m),
        };
        await deps.store.putCourse(next);
        return json(res, 200, { course: next });
      }

      const materialProgress = /^\/courses\/([^/]+)\/material\/([^/]+)\/progress$/.exec(url.pathname);
      if (req.method === 'POST' && materialProgress) {
        const [courseId, materialId] = [pathId(materialProgress, 1), pathId(materialProgress, 2)];
        const course = await deps.store.getCourse(courseId);
        if (!course) return json(res, 404, { error: 'no such course' });
        const material = course.material.find((m) => m.id === materialId);
        if (!material) return json(res, 404, { error: 'no such material' });
        const parsed = parseCourseMaterialProgress(await readBody(req));
        if (!parsed.ok) throw new BadRequest(parsed.error);
        const { minutes, expectedProgressMinutes } = parsed;
        const currentProgressMinutes = Math.max(0, material.progressMinutes ?? 0);
        const expectedResult = expectedProgressMinutes === null ? null
          : material.minutes === null
            ? expectedProgressMinutes + minutes
            : Math.min(material.minutes, expectedProgressMinutes + minutes);

        /**
         * The return-card decision is an increment, so its retry needs a
         * compare point rather than a second increment. If the original write
         * landed and only its response was lost, the current counter is exactly
         * the result that request intended; return it as the same success. Any
         * other mismatch is a genuinely stale card and may not guess.
         */
        if (expectedProgressMinutes !== null && currentProgressMinutes !== expectedProgressMinutes) {
          if (currentProgressMinutes === expectedResult) {
            return json(res, 200, { course, material, alreadyRecorded: true });
          }
          return json(res, 409, {
            error: 'material progress changed; return to Learn for a current block',
            currentProgressMinutes,
          });
        }
        if (material.doneAt) return json(res, 409, { error: 'that material is already covered' });
        const now = deps.clock.now().toISOString();
        const progressed = currentProgressMinutes + minutes;
        const progressMinutes = material.minutes === null
          ? progressed
          : Math.min(material.minutes, progressed);
        const doneAt = material.minutes !== null && progressMinutes >= material.minutes ? now : null;
        const next: Course = {
          ...course,
          material: course.material.map((m) => m.id === materialId
            ? { ...m, progressMinutes, doneAt }
            : m),
        };
        await deps.store.putCourse(next);
        return json(res, 200, {
          course: next,
          material: next.material.find((m) => m.id === materialId),
          alreadyRecorded: false,
        });
      }

      // editability turns a derived learner profile into a collaboration.
      if (await handleLearnerModelRoute(req, res, url, {
        store: deps.store,
        deps,
        nowIso: () => deps.clock.now().toISOString(),
        timeZone: async () => zoneOf(await deps.store.getPrefs(), requestTimeZone(req)),
        readBody,
        requireText: requireTrimmedBoundedString,
        receiptId: clientReceiptId,
        pathId,
        reply: json,
        badRequest: (message) => { throw new BadRequest(message); },
        newId: randomUUID,
      })) return;

      // deletion must reach derived state. A deleted pin that still shapes
      // tomorrow's session is a broken promise, and the cascade lives in the Store
      // contract precisely so no caller can forget it.
      const del = /^\/pins\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && del) {
        await deps.store.deletePin(pathId(del, 1), {
          keepEmptyTopic: url.searchParams.get('keepTopic') === 'true',
        });
        return json(res, 200, { ok: true });
      }
      const dtopic = /^\/topics\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && dtopic) {
        const withPins = url.searchParams.get('pins') === 'true';
        await deps.store.deleteTopic(pathId(dtopic, 1), { deletePins: withPins });
        return json(res, 200, { ok: true });
      }
      if (await handleTenantMemberRoute(req, res, url, tenantMemberContext(opts))) return;
      /**
       * The learner's portable copy. This is not Notebook export: it contains
       * the complete learner-owned records needed to move Virgil, never model
       * credentials, Drive tokens or deployment configuration.
       */
      if (req.method === 'GET' && url.pathname === '/account/backup') {
        const core: PortableBackupCore = {
          format: PORTABLE_BACKUP_FORMAT,
          version: PORTABLE_BACKUP_VERSION,
          ownerEmail: opts.learner?.email?.trim().toLowerCase() ?? null,
          exportedAt: deps.clock.now().toISOString(),
          data: await portableData(deps.store),
        };
        const backup: PortableBackup = { ...core, digest: portableDigest(core) };
        return json(res, 200, {
          backup,
          filename: `virgil-backup-${core.exportedAt.slice(0, 10)}.json`,
          counts: portableCounts(core.data),
          secretsIncluded: false,
        });
      }

      if (req.method === 'POST' && (url.pathname === '/account/restore/preview'
        || url.pathname === '/account/restore')) {
        const body = await readBody(req);
        const backup = readPortableBackup(body.backup, opts.learner?.email ?? null);
        const current = await portableData(deps.store);
        const state = restoreCompatibility(current, backup.data);
        if (state === 'conflict') {
          return json(res, 409, {
            ok: false, state,
            error: 'This board already contains different learner data. Virgil will not merge a backup into it.',
            current: portableCounts(current), backup: portableCounts(backup.data),
          });
        }
        if (req.method === 'POST' && url.pathname.endsWith('/preview')) {
          return json(res, 200, {
            ok: true, state, counts: portableCounts(backup.data),
            line: state === 'same' ? 'This backup is already restored.'
              : state === 'resume' ? 'An interrupted restore can resume without duplicating evidence.'
                : 'This board is empty and ready for this backup.',
          });
        }
        if (state !== 'same') await restorePortableData(deps.store, backup.data);
        return json(res, 200, {
          ok: true, state: state === 'same' ? 'already-restored' : 'restored',
          counts: portableCounts(backup.data),
          line: state === 'same' ? 'This backup was already here. Nothing changed.'
            : 'Your Virgil data was restored. Sign-in and model credentials were not part of the backup.',
        });
      }

      if (req.method === 'DELETE' && url.pathname === '/everything') {
        await deps.store.deleteEverything();
        return json(res, 200, { ok: true });
      }

      /**
       * The bill so far, in the nightly's own report shape.
       *
       * An operator surface and never a learner one. UX_SPEC §3 is explicit
       * that no surface may solicit taps to manufacture engagement, and a
       * running cost in front of the learner is the same lever pulled the other
       * way — it would price honesty about not understanding something.
       *
       * In-memory and per-process, like the nightly's. It is the record of what
       * this service has spent since it started, which is the question somebody
       * checking the per-tap line is actually asking.
       */
      if (req.method === 'GET' && url.pathname === '/usage') {
        return json(res, 200, meter.report(deps.clock.now().toISOString()));
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, {
          ok: true,
          pins: (await deps.store.listPins()).length,
          compatibility: compatibilityReceipt(),
        });
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof PayloadTooLarge) return json(res, 413, { error: err.message });
      if (err instanceof BadRequest) return json(res, 400, { error: err.message });
      if (err instanceof NotebookScopeError) return json(res, 400, { error: err.message });
      if (err instanceof Forbidden) return json(res, 403, { error: err.message });
      /**
       * The learner's own limit, and not a fault on anybody's side.
       *
       * 402 rather than 403 or 429: nothing about who is asking is in question
       * and nothing will change by waiting — the request needs the limit raised
       * or the window reset, which is the one thing this status has ever meant.
       * It is the only route to a 402 in this service, so a panel can key on it
       * without reading the body.
       *
       * `stoppedBy` is the machine-readable half and `error` is the sentence a
       * person reads. The full state travels with it so the panel can show what
       * was spent against what was allowed without a second request.
       */
      if (err instanceof ModelBudgetStop) {
        // The stop already knows what did not run. Add only the bounded facts
        // needed to choose a recovery: whether each never-budgeted connection
        // is enabled and ready now. This is the same service-owned receipt as
        // `/model-config`, redacted so a refusal never carries endpoints,
        // credentials or model details. Failure to read readiness is
        // uncertainty, never a reason to delay or mislabel the 402.
        const freeConnections = await modelReceipt(deps.store, models)
          .then((receipt) => (['local', 'cli'] as const).map((connection) => ({
            connection,
            enabled: receipt.providers[connection].enabled,
            readiness: receipt.providers[connection].readiness,
          })))
          .catch(() => []);
        return json(res, 402, {
          error: err.message,
          stoppedBy: 'model-budget',
          connection: err.connection,
          state: err.state,
          freeConnections,
        });
      }
      /**
       * The other refusal: the connection this was routed to has no credential.
       *
       * 409 rather than 402, and deliberately not 402. The budget's 402 is the
       * only route to that status in this service precisely so a panel can key
       * on it without reading a body, and "you have spent your limit" and "you
       * never saved a key" are different facts with different fixes. 409 is the
       * honest one of the remaining choices: the request is well-formed and the
       * caller is who they say they are — it conflicts with the state of the
       * connection it was pointed at, and it will keep conflicting until that
       * state changes. Not 401/403, which are about the LEARNER's standing with
       * this service and would send them looking at their own login. Not 422,
       * which says something about the body they sent, and nothing they typed
       * is wrong.
       *
       * `stoppedBy` is the discriminator, matching the budget's shape exactly,
       * so the panel gets one field to switch on across both refusals rather
       * than a status code and a sentence to pattern-match.
       */
      if (err instanceof LlmCredentialMissing) {
        console.warn(`[service] ${req.method} ${req.url} refused, no credential:`, err.detail);
        return json(res, 409, {
          error: err.message,
          stoppedBy: 'model-credential',
          connection: err.connection,
          fixAt: 'settings/models',
        });
      }
      // Everything else genuinely is a fault on this side. The 500 body is
      // `String(err)` and the extension shows it to nobody, so a failure with no
      // cause recorded here is a failure nobody can diagnose after the fact — it
      // goes to the log with its stack before it goes to the client.
      console.error(`[service] ${req.method} ${req.url} failed:`, err);
      json(res, 500, { error: String(err) });
    }
  };

  return (req, res) => withBudgetScope(() => handle(req, res));
}

export async function openStore(
  choice: StoreChoice, wiring: FirestoreWiring | null,
): Promise<Deps['store']> {
  if (choice.kind === 'memory') return new JsonStore(MEMORY_BOARD_PATH, memoryFs());
  if (choice.kind === 'json') return new JsonStore(choice.path);

  if (!wiring) {
    throw new StoreSpecError(
      'SB_STORE names firestore and openStore was handed no wiring. `firestoreWiring` produces it '
      + 'from the same spec, and a store opened without it would reach the adapter default rather '
      + 'than the project this deployment named.');
  }
  return new FirestoreStore(wiring);
}

/** A running service, with the process taken out of it. */
export interface ServiceHandle {
  readonly port: number;
  readonly host: string;
  /** Whether the boot warm-up ran and succeeded. False in Cloud Run, by design. */
  readonly warmedUp: boolean;
  close(): Promise<ShutdownResult>;
}

/**
 * How long to drain for.
 *
 * Cloud Run gives a service *"a 10 second period before the actual shutdown
 * occurs, at which point Cloud Run sends a SIGKILL signal"*. Eight leaves room
 * to log the outcome and exit on our own terms: finishing a moment early is a
 * clean shutdown in the log, and being killed is an instance that reads as a
 * crash.
 */
const SHUTDOWN_GRACE_MS = 8_000;

/** Starts the container-facing service; `over` supplies network-free test seams. */
export async function startService(
  env: Record<string, string | undefined> = process.env,
  over: Partial<Deps> = {},
): Promise<ServiceHandle> {
  const PORT = Number(env.PORT ?? env.SB_PORT ?? 8791);
  const DB = env.SB_DB ?? '.data/store.json';
  const HOST = bindHost(env.SB_HOST, env.K_SERVICE);
  const auth = identityChoice(env.SB_AUTH);
  const operatorLimit = operatorModelBudgetFrom(env.SB_OPERATOR_MODEL_BUDGET_TOKENS);
  if (env.K_SERVICE && auth.kind !== 'none' && operatorLimit === null) {
    throw new Error('hosted identity requires SB_OPERATOR_MODEL_BUDGET_TOKENS; refusing an unbounded testing build');
  }
  const publicFirebaseApiKey = env.SB_FIREBASE_API_KEY?.trim()
    || (auth.kind === 'firebase' && auth.emulatorHost ? 'fake-api-key' : '');
  const web: BoardWebOptions = {
    root: env.SB_WEB_ROOT?.trim() || BOARD_WEB_ROOT,
    authConfig: auth.kind === 'firebase' && publicFirebaseApiKey
      ? {
        apiKey: publicFirebaseApiKey,
        projectId: auth.projectId,
        ...(auth.emulatorHost ? { emulatorHost: auth.emulatorHost } : {}),
      }
      : null,
    // One-release fallback for existing hosted installs.
    googleWebClientId: env.SB_GOOGLE_WEB_CLIENT_ID?.trim()
      || env.SB_GOOGLE_OAUTH_CLIENT_ID?.trim() || null,
  };
  // Identity replaces the legacy shared-secret door on multi-user installs.
  const secret = sharedSecret(env.SB_SHARED_SECRET, HOST, auth.kind !== 'none');
  const choice = storeChoice(env.SB_STORE, DB);
  const managedDrive = managedDriveGrant(env.SB_NOTEBOOK_DRIVE_CREDENTIAL);
  // Fail Firestore wiring before the process can report healthy.
  const wiring = choice.kind === 'firestore' ? firestoreWiring(choice, env) : null;
  const access = await openTenantAccess({
    env,
    authProjectId: auth.kind === 'none' ? null : auth.projectId,
    wiring,
  });
  const runTarget = cloudRunJobTarget(env.SB_AUTO_RUN_JOB);
  if (runTarget && (choice.kind !== 'firestore' || !wiring)) {
    throw new CloudRunJobConfigError(
      'SB_AUTO_RUN_JOB requires a project-qualified Firestore store so each verified learner can be selected safely.');
  }
  if (runTarget && wiring && runTarget.projectId !== wiring.projectId) {
    throw new CloudRunJobConfigError(
      'SB_AUTO_RUN_JOB and SB_STORE must name the same Google Cloud project.');
  }
  if (runTarget && auth.kind === 'none') {
    throw new CloudRunJobConfigError(
      'SB_AUTO_RUN_JOB requires SB_AUTH; a hosted Job board must come from verified learner identity.');
  }
  const hostedRun: HostedRunLauncher | null = runTarget
    ? new CloudRunJobLauncher({ target: runTarget }) : null;
  // Foreground agents need the same declared model route as the Job.
  const model = llmChoice(env.SB_LLM);
  // A deployed identity configuration must never accept emulator tokens.
  const safe = identityIsSafeHere(auth, env);
  if (!safe.ok) {
    console.error(safe.reason);
    process.exit(EXIT_CONFIG);
  }

  // The endpoint remains configurable for local/container acceptance.
  const localEndpoint = env.SB_LOCAL_ENDPOINT ?? env.SB_OLLAMA_HOST ?? DEFAULT_LOCAL_MODEL_ENDPOINT;
  const cliEndpoint = env.SB_CLI_ENDPOINT ?? DEFAULT_CLI_MODEL_ENDPOINT;
  const cliToken = env.SB_CLI_TOKEN ?? '';
  const allowRemoteEndpoints = env.SB_ALLOW_REMOTE_MODEL_ENDPOINTS === '1';
  const ollama = { host: localEndpoint };
  const hosted = Boolean(env.K_SERVICE?.trim());
  const cloudCredential = await LocalCloudCredential.open({
    dbPath: choice.kind === 'json' ? choice.path : DB,
    ...(env.GEMINI_API_KEY === undefined ? {} : { managedKey: env.GEMINI_API_KEY }),
    editable: choice.kind === 'json' && !hosted,
  });

  /**
   * The model, built here.
   *
   * Duplicated from `cli.ts` rather than shared, and deliberately: the same rule
   * `openStore` lives under. `seam-purity.test.ts` counts the places an adapter
   * is constructed and holds that a provider is chosen in a composition root, so
   * a shared factory would be a third place a port has to find.
   */
  const defaultMode: ModelMode = model.kind === 'ollama' ? 'local' : model.kind === 'cli' ? 'cli' : 'cloud';
  /**
   * The cloud connection, and — contract of 2026-08-25 — its ladder.
   *
   * `GEMINI_API_KEY_FREE` is a second, free-tier key. When it is present the
   * free key answers first and the managed key becomes the paid fallback,
   * reached only when the free pool says 429 or 503 — so a learner runs on
   * their own free allowance until it is genuinely spent. The budget wrappers
   * downstream switch to `defer` in this shape: the kill-switch arms on the
   * request scope and `beforePaid` fires it at the moment money would move,
   * which keeps free calls flowing after the limit and stops only the spend.
   * Without the variable, this is exactly the single-key build it always was.
   */
  const paidKey = (): string => cloudCredential.value();
  const freeKeyValue = env.GEMINI_API_KEY_FREE?.trim() || null;
  const gemini = (apiKey: () => string): GeminiLlm => model.kind === 'gemini' && model.tiers
    ? new GeminiLlm({ tiers: model.tiers, apiKey })
    : new GeminiLlm({ apiKey });
  const ladderActive = freeKeyValue !== null;
  const vertexProject = env.GOOGLE_CLOUD_PROJECT?.trim() ?? '';
  const vertexLocation = env.GOOGLE_CLOUD_LOCATION?.trim() ?? '';
  if (model.kind === 'vertex' && (!vertexProject || !vertexLocation)) {
    console.error('SB_LLM=vertex needs GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION');
    process.exit(EXIT_CONFIG);
  }
  const vertexCredential = model.kind === 'vertex' ? new VertexCredential() : null;
  const paidVertex = model.kind === 'vertex' && vertexCredential
    ? new GeminiLlm({
      tiers: model.tiers ?? VERTEX_GEMINI_TIERS,
      accessToken: () => vertexCredential.token(),
      modelEndpoint: vertexModelEndpoint(vertexProject, vertexLocation),
    })
    : null;
  const paidCloud = paidVertex ?? gemini(paidKey);
  const cloud = ladderActive
    ? new KeyLadderLlm(gemini(() => freeKeyValue), paidCloud, { beforePaid: firePaidGateInScope })
    : paidCloud;
  const store = await openStore(choice, wiring);
  const buildLlm = (selectedStore: Deps['store']) => new ModelRouter({
    store: selectedStore,
    defaultMode,
    defaultLocalEndpoint: localEndpoint,
    defaultCliEndpoint: cliEndpoint,
    allowRemoteEndpoints,
    providers: {
      cloud,
      local: (endpoint) => hosted && isLocalConnectorStore(selectedStore)
        ? new LocalConnectorLlm(selectedStore)
        : new OllamaLlm({ host: endpoint }),
      cli: (endpoint) => new CliEndpointLlm({ endpoint, token: cliToken }),
    },
  });

  const deps: Deps = {
    llm: buildLlm(store),
    embedder: env.SB_EMBEDDER === 'tfidf' ? new TfIdfEmbedder() : new OllamaEmbedder(ollama),
    store,
    research: new LocalResearch(),
    clock: systemClock,
    ...over,
  };

  /**
   * The per-learner half. `boardFor` is what a board IS in this process — a
   * file beside the single-board one locally, a Firestore board deployed — and
   * `learner-<uid>` is produced by `boardIdFor`, which is where a token claim
   * is held to a rule before it becomes a filename or a document id.
   */
  const identity: Identity | null = auth.kind === 'none' ? null : new FirebaseAuth({
    projectId: auth.projectId,
    clock: deps.clock,
    emulatorHost: auth.emulatorHost ?? undefined,
    log: (reason: string) => console.warn(`[auth] refused: ${reason}`),
  });

  const forLearner = identity === null ? null : async (learner: Learner): Promise<Deps> => {
    const board = boardIdFor(learner.id);
    // `verify` already held `sub` to this rule, so reaching here means the
    // verifier and this disagree — which is a programming error, not a request.
    if (!board) throw new Error(`verified learner ${learner.id} is not a usable board id`);
    const perLearner = choice.kind === 'firestore' && wiring
      ? await openStore({ kind: 'firestore', boardId: board, ...(wiring.projectId ? { projectId: wiring.projectId } : {}) },
        { ...wiring, boardId: board })
      : await openStore({ kind: 'json', path: learnerBoardPath(DB, board) }, null);
    return { ...deps, llm: buildLlm(perLearner), store: perLearner };
  };

  /**
   * Where the learner's own documents go, or nowhere.
   *
   * `SB_NOTEBOOK_DIR` unset is the whole feature off, and off is the default.
   * That is the second of `runtime.ts`'s three configuration idioms: an absent
   * variable is a capability this build does not have, not a typo to guess at
   * and not an error to report. Nothing warns, nothing logs, and the two
   * endpoints answer 404 as though they had never been written.
   *
   * A local directory is the only destination that exists today
   * (`NOTEBOOK_SEAM_V2.md` §10 designs the Drive one and does not build it, for
   * want of an OAuth client). It is therefore a local-deployment feature by
   * construction, and that is the honest place for it to be: a container has no
   * durable disk, so documents written inside one would vanish with the task,
   * which is the same argument `cli.ts` already makes about the usage file.
   *
   * Built here because a composition root is where an adapter is built, and
   * this is one of the two.
   */
  const notebookDir = env.SB_NOTEBOOK_DIR?.trim();
  const localNotebook = notebookDir
    ? new LocalNotebookExport({ directory: notebookDir, clock: deps.clock })
    : null;
  if (localNotebook) console.log(`notebook documents: ${notebookDir}`);

  /**
   * The Drive lane, and the same absent-is-off rule the directory follows.
   *
   * `NOTEBOOK_SEAM_V2.md` §4. `SB_NOTEBOOK_DRIVE=1` is the switch, and unset is
   * the whole lane off: the four `/notebook/drive` endpoints answer 404, the
   * Settings block does not render, and nothing warns, because a lane nobody
   * asked for is not a lane that failed. It is `runtime.ts`'s second
   * configuration idiom, exactly as `SB_NOTEBOOK_DIR` is.
   *
   * It is available only where the Gemini key is editable — a local JSON board,
   * not hosted — and that is not a restriction so much as a description. §4's
   * whole argument is that there is no company in the path because *the service
   * is a process on the learner's own machine*; a container writing a refresh
   * token to a disk that vanishes with the task is not that, and would be
   * claiming the property while not having it.
   *
   * The **destination** is resolved per write rather than here, because a
   * learner presses Connect while the service is running: see
   * `notebook-targets.ts`. What is built here is what a composition root builds
   * — the credential store, the token cache, and the adapter factory.
   */
  const driveLane = env.SB_NOTEBOOK_DRIVE?.trim() === '1' && choice.kind === 'json' && !hosted;
  const managedDriveClient: DriveClientCredential | null =
    env.SB_DRIVE_CLIENT_ID?.trim() && env.SB_DRIVE_CLIENT_SECRET?.trim()
      ? { clientId: env.SB_DRIVE_CLIENT_ID.trim(), clientSecret: env.SB_DRIVE_CLIENT_SECRET.trim() }
      : null;
  const driveCredential = driveLane
    ? await LocalDriveCredential.open({
      dbPath: choice.kind === 'json' ? choice.path : DB,
      editable: true,
      managedClient: managedDriveClient,
    })
    : null;
  const driveTokens = driveCredential
    ? new DriveTokens({
      client: () => driveCredential.client(),
      refreshToken: () => driveCredential.refreshToken(),
      clock: deps.clock,
    })
    : null;
  const driveExport = (): NotebookExport | null => (
    driveCredential?.connected() && driveTokens
      ? new DriveNotebookExport({
        auth: driveTokens,
        ids: {
          read: () => driveCredential.readIds(),
          write: (ids) => driveCredential.writeIds(ids),
        },
        clock: deps.clock,
      })
      : null
  );
  if (driveCredential) {
    // Whether the lane is on, and never a word about the credential itself.
    console.log(`notebook Drive lane: on (${driveCredential.connected() ? 'connected' : 'not connected yet'})`);
  }

  const notebook = localNotebook || driveCredential
    ? notebookDestination({ local: localNotebook, drive: driveExport })
    : null;

  /**
   * The lane the warm-up below spends through, taken at construction.
   *
   * `??=` and a snapshot rather than a live handle: the multi-tenant path builds
   * a board per verified learner, so the hook can fire again later, from a
   * request. A lane captured then belongs to a learner, and a warm-up charged to
   * whoever knocked first is worse than no warm-up. So only what
   * `createApp` builds synchronously — the single-board app, the one that
   * belongs to nobody — is ever used, and a multi-tenant service simply starts
   * cold and says so.
   */
  let builtLane: Llm | null = null;
  // Read through a call rather than directly: the only assignment to
  // `builtLane` that TypeScript can see is the `null` above — the hook runs
  // inside `createApp` and narrowing does not follow it there — so a plain read
  // would be typed `null` and the warm-up below would be unreachable code the
  // compiler was sure of.
  const laneBuiltSoFar = (): Llm | null => builtLane;
  const app = createApp(deps, {
    secret,
    web,
    onWarmupLane: (llm) => { builtLane ??= llm; },
    // `SB_WORK_CAP` unset is the default cap and `SB_WORK_CAP=0` is no cap at
    // all. Read here in the same breath as every other operator decision, and
    // passed as a number rather than left for the routes to find, because
    // reading the environment below the composition root is how a second place
    // ends up disagreeing with the first about what a deployment was told.
    workCap: workCapFrom(env.SB_WORK_CAP),
    ...(hostedRun ? { hostedRun } : {}),
    ...(managedDrive ? { hostedNotebookDriveAccount: managedDrive.account } : {}),
    ...(env.SB_NOTEBOOK_URL?.trim() ? { hostedNotebookUrl: env.SB_NOTEBOOK_URL.trim() } : {}),
    ...(notebook ? { notebook } : {}),
    ...(driveCredential && driveTokens
      ? {
        drive: {
          credential: driveCredential,
          tokens: driveTokens,
          consent: (client: DriveClientCredential) =>
            new LoopbackConsent({ client, clock: deps.clock }),
          folderLink: async () => {
            const ids = await driveCredential.readIds();
            return ids.folderId ? driveFolderLink(ids.folderId) : null;
          },
        },
      }
      : {}),
    models: {
      defaultMode,
      cloudDeepModelId: model.kind === 'vertex' ? (model.tiers?.deep ?? VERTEX_GEMINI_TIERS.deep)
        : model.kind === 'gemini' ? (model.tiers?.deep ?? GEMINI_TIERS.deep) : GEMINI_TIERS.deep,
      freeArm: ladderActive,
      cloudReady: model.kind === 'vertex' || cloudCredential.configured(),
      cloudCredential,
      // The saved credential is what the check is about, so it goes straight
      // at the paid arm — a free key answering for it would report a health
      // the managed key does not have.
      checkCloud: () => paidCloud.checkAccess(),
      localEndpoint,
      cliEndpoint,
      cliToken,
      allowRemoteEndpoints,
      hosted,
      operatorLimit,
      setupTrustedLocal: HOST === LOOPBACK,
    },
    ...(identity ? { identity, forLearner, access } : {}),
  });
  // Read once, here, while the only lane that can exist is the one `createApp`
  // just built. Anything the hook records after this line came from a request.
  const warmupLane = laneBuiltSoFar();
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  const bound = (server.address() as AddressInfo).port;
  const where = choice.kind === 'json' ? choice.path : choice.kind;
  const who = auth.kind === 'none'
    ? 'one board, no sign-in'
    : `firebase:${auth.projectId}${auth.emulatorHost ? ` (emulator ${auth.emulatorHost}, UNSIGNED tokens)` : ''}`;
  // Whether the door is shut is the first thing anybody reading this log wants
  // to know about an exposed instance, and it is never the secret itself.
  const door = secret === null ? 'open on loopback' : `${SHARED_SECRET_HEADER} required`;
  console.log(`virgil service on http://${HOST}:${bound}  (store: ${where}, ${door}, auth: ${who})`);

  // Measured: the first pin after boot cost 2135ms against a 1500ms toast
  // budget, purely from loading the model; warm requests ran 367-720ms. A
  // throwaway call on boot moves that cost off the user's first pin — on a
  // laptop. In Cloud Run with min-instances 0 the same call is bought on every
  // cold start, against a free tier of twenty a day, by an instance that may
  // then serve no pin at all.
  //
  // **Through the app's own lane, not through `deps.llm`.** That paragraph
  // above has named the cost since the day it was written and the call went
  // round both instruments that could have shown it: `budgetedLlm` and the
  // `UsageMeter` are built inside `createApp`, so a warm-up was ungated and
  // uncounted — a spend a learner's own limit could not refuse and their own
  // usage report could not see. `onWarmupLane` hands out the decorated lane,
  // and a warm-up is now an ordinary call: metered as a tap under the `warmup`
  // stage, and refused like anything else when the budget is gone.
  let warmedUp = false;
  const shouldWarm = env.SB_WARMUP === undefined
    ? defaultMode === 'local' && warmupWanted(undefined, env.K_SERVICE)
    : warmupWanted(env.SB_WARMUP, env.K_SERVICE);
  if (shouldWarm && !warmupLane) {
    // Multi-tenant: there is no board that belongs to nobody, so there is no
    // budget the warm-up could honestly be charged to. Cold, and said out loud
    // rather than skipped in silence, because an operator who set `SB_WARMUP`
    // is owed the reason it did not happen.
    console.log('fast tier not warmed — this service is per-learner, and a shared warm-up has no board to charge');
  } else if (shouldWarm && warmupLane) {
    const t = Date.now();
    try {
      await warmupLane.complete({ tier: 'fast', reasoning: 'off', system: 'warmup', prompt: 'ok', maxOutputTokens: 1 });
      warmedUp = true;
      console.log(`fast tier warm (${Date.now() - t}ms)`);
    } catch (err) {
      // A refusal is not an outage and must not read as one. `LlmRefused` is
      // the seam's word for "nothing was sent" — a spent budget, or a cloud
      // connection with no key saved — and the service comes up cold either
      // way, because a warm-up is an optimisation and never a precondition.
      console.log(err instanceof LlmRefused
        ? `fast tier not warmed — ${err.message}`
        : 'fast tier unavailable — pins will use the fallback label');
    }
  }

  return {
    port: bound, host: HOST, warmedUp,
    close: () => gracefulClose(server, SHUTDOWN_GRACE_MS),
  };
}

/** The entry point. Wiring, port, the boot warm-up, and an answer to SIGTERM. */
async function main(): Promise<void> {
  const svc = await startService();

  // Without this the process is killed mid-request, and a learner's tap that
  // has already written a signal to the ledger and not yet answered looks to
  // the panel like a network failure.
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      console.log(`${signal} — draining`);
      void svc.close().then((how) => {
        console.log(`shutdown ${how}`);
        process.exit(0);
      });
    });
  }
}

// Run only when this file is the process entry. Importing it — which is how the
// endpoint tests reach `createApp` — must never bind a port or construct an
// Ollama client. `realpathSync` so a symlinked launch still counts as entry.
const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (entry === import.meta.url) {
  main().catch((err: unknown) => {
    // A service that cannot start must say so and fail rather than sit there
    // bound to nothing: Cloud Run reads the ingress container's exit code too.
    console.error('[service] failed to start:', err);
    process.exit(EXIT_CONFIG);
  });
}
