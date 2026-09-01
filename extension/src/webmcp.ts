/**
 * Virgil's browser-agent boundary.
 *
 * WebMCP is a progressive enhancement over the authenticated learner page. It
 * exposes four narrow service lanes plus one presentation-only guide, uses the page's existing identity, and
 * never calls a model. Runtime validation is intentional: the JSON Schema is
 * guidance for agents, not the security boundary for Virgil's service.
 */
import { serviceFetch } from './service.js';
import {
  boundedToolOutput, cancelledLine, classificationSummary,
  DRAFT_INTAKE_DESCRIPTION, DRAFT_INTAKE_SCHEMA, draftIntakeSummary,
  DROP_MATERIALS_DESCRIPTION, DROP_MATERIALS_SCHEMA, type DropReading, dropSummary,
  type JsonSchema, PREVIEW_CLASSIFICATION_DESCRIPTION, PREVIEW_CLASSIFICATION_SCHEMA,
  protocolFailureLine, serviceRefusalLine, STUDY_STATE_DESCRIPTION, STUDY_STATE_SCHEMA,
  studyStateSummary, studyStateUnavailable, TOOL_DRAFT_INTAKE, TOOL_DROP_MATERIALS,
  TOOL_PREVIEW_CLASSIFICATION, TOOL_STUDY_STATE, validateClassification,
  validateDraftIntake, validateDropMaterials, validateEmptyInput, type WebMcpToolResult,
  writeFailureLine,
} from './webmcp-core.js';
import {
  GUIDE_VIEW_DESCRIPTION, GUIDE_VIEW_SCHEMA, TOOL_GUIDE_VIEW, validateGuideView,
} from './guide-core.js';
import { guideVirgilView } from './guide-view.js';

export interface ToolExecuteOptions { readonly signal?: AbortSignal }

export interface ModelContextTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly untrustedContentHint: boolean;
  };
  execute(input: unknown, options?: ToolExecuteOptions): Promise<WebMcpToolResult>;
}

export interface ModelContext {
  registerTool(tool: ModelContextTool, options?: { signal?: AbortSignal }): Promise<undefined>;
}

export const WEBMCP_RECEIPT_EVENT = 'virgil:webmcp-receipt';
export interface WebMcpReceipt {
  readonly kind: 'draft' | 'drop';
  readonly summary: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const aborted = (signal: AbortSignal | undefined, error?: unknown): boolean =>
  signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError');
const result = (value: string): WebMcpToolResult => boundedToolOutput(value);

function modelContext(): ModelContext | null {
  if (typeof document === 'undefined') return null;
  const host = (document as unknown as { modelContext?: unknown }).modelContext;
  if (host === null || typeof host !== 'object') return null;
  return typeof (host as { registerTool?: unknown }).registerTool === 'function'
    ? host as ModelContext : null;
}

type Read<T> =
  | { readonly kind: 'ok'; readonly body: T }
  | { readonly kind: 'refused'; readonly status: number }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'malformed' };

async function read<T>(path: string, signal?: AbortSignal): Promise<Read<T>> {
  if (signal?.aborted) return { kind: 'cancelled' };
  let response: Response;
  try { response = await serviceFetch(path, signal ? { signal } : {}); }
  catch (error) {
    return aborted(signal, error) ? { kind: 'cancelled' } : { kind: 'unreachable' };
  }
  if (!response.ok) return { kind: 'refused', status: response.status };
  try { return { kind: 'ok', body: await response.json() as T }; }
  catch { return { kind: 'malformed' }; }
}

type Posted<T> =
  | { readonly kind: 'ok'; readonly body: T }
  | { readonly kind: 'refused'; readonly status: number }
  | { readonly kind: 'uncertain' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'malformed' };

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<Posted<T>> {
  if (signal?.aborted) return { kind: 'cancelled' };
  let response: Response;
  try {
    response = await serviceFetch(path, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), ...(signal ? { signal } : {}),
    });
  } catch (error) {
    return aborted(signal, error) ? { kind: 'cancelled' } : { kind: 'uncertain' };
  }
  if (!response.ok) return { kind: 'refused', status: response.status };
  try { return { kind: 'ok', body: await response.json() as T }; }
  catch { return { kind: 'malformed' }; }
}

function announce(receipt: WebMcpReceipt): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function'
      || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent<WebMcpReceipt>(WEBMCP_RECEIPT_EVENT, { detail: receipt }));
}

interface TodayRead { next?: { primary?: unknown } | null }
interface CoursesRead { courses?: unknown; unattached?: unknown }
interface IntakeListRead { drafts?: unknown }

async function studyState(input: unknown, options?: ToolExecuteOptions): Promise<WebMcpToolResult> {
  const checked = validateEmptyInput(input);
  if (!checked.ok) return result(checked.message);
  const reads = await Promise.all([
    read<TodayRead>('/today', options?.signal),
    read<CoursesRead>('/courses', options?.signal),
    read<IntakeListRead>('/course-intakes', options?.signal),
  ]);
  if (reads.some((item) => item.kind === 'cancelled')) return result(cancelledLine(false));
  const names = ['Today', 'courses', 'course drafts'];
  const missing = reads.flatMap((item, index) => item.kind === 'ok' ? [] : [names[index] ?? 'board']);
  if (missing.length) {
    const authentication = reads.some((item) => item.kind === 'refused'
      && (item.status === 401 || item.status === 403));
    return result(studyStateUnavailable(missing, authentication));
  }
  const [todayRead, coursesRead, intakeRead] = reads as [
    Extract<Read<TodayRead>, { kind: 'ok' }>,
    Extract<Read<CoursesRead>, { kind: 'ok' }>,
    Extract<Read<IntakeListRead>, { kind: 'ok' }>,
  ];
  const today = todayRead.body;
  const courses = coursesRead.body;
  const intakes = intakeRead.body;
  if (!record(today) || !record(courses) || !record(intakes)
      || !Array.isArray(courses.courses) || !Array.isArray(intakes.drafts)) {
    return result(protocolFailureLine(false));
  }
  const live = courses.courses;
  let openCommitments = 0;
  for (const course of live) {
    if (!record(course) || !Array.isArray(course.commitments)) return result(protocolFailureLine(false));
    openCommitments += course.commitments.length;
  }
  if (courses.unattached !== undefined) {
    if (!record(courses.unattached) || !Array.isArray(courses.unattached.commitments)) {
      return result(protocolFailureLine(false));
    }
    openCommitments += courses.unattached.commitments.length;
  }
  let primary: { title: string; detail: string; minutes: number } | null = null;
  if (today.next !== undefined && today.next !== null) {
    if (!record(today.next)) return result(protocolFailureLine(false));
    const candidate = today.next.primary;
    if (candidate !== undefined && candidate !== null) {
      if (!record(candidate) || typeof candidate.title !== 'string'
          || typeof candidate.detail !== 'string' || !whole(candidate.minutes)) {
        return result(protocolFailureLine(false));
      }
      primary = { title: candidate.title, detail: candidate.detail, minutes: candidate.minutes };
    }
  }
  if (intakes.drafts.some((draft) => !record(draft) || typeof draft.status !== 'string')) {
    return result(protocolFailureLine(false));
  }
  const pendingDrafts = intakes.drafts.filter((draft) =>
    record(draft) && draft.status !== 'applied').length;
  return result(studyStateSummary({
    primary, courses: live.length, openCommitments, pendingDrafts,
  }));
}

interface DraftIntakeRead { draft?: unknown; repeated?: unknown }

async function draftIntake(input: unknown, options?: ToolExecuteOptions): Promise<WebMcpToolResult> {
  const checked = validateDraftIntake(input);
  if (!checked.ok) return result(checked.message);
  const made = await post<DraftIntakeRead>(
    '/course-intakes', { ...checked.value, enhance: false }, options?.signal,
  );
  if (made.kind === 'cancelled') return result(cancelledLine(true, 'clientRef'));
  if (made.kind === 'uncertain') return result(writeFailureLine(null, 'clientRef'));
  if (made.kind === 'refused') return result(writeFailureLine(made.status, 'clientRef'));
  if (made.kind === 'malformed') return result(protocolFailureLine(true, 'clientRef'));
  const draft = made.body.draft;
  if (!record(draft) || typeof draft.title !== 'string'
      || !Array.isArray(draft.objectives) || !Array.isArray(draft.commitments)) {
    return result(protocolFailureLine(true, 'clientRef'));
  }
  const summary = `${draftIntakeSummary({
    title: draft.title, objectives: draft.objectives.length, commitments: draft.commitments.length,
  })}${made.body.repeated === true ? '\nThis was the existing draft for that clientRef; no duplicate was added.' : ''}`;
  announce({ kind: 'draft', summary });
  return result(summary);
}

interface ClassificationRead { preview?: unknown; authoritativeWrites?: unknown; results?: unknown }

async function previewClassification(
  input: unknown, options?: ToolExecuteOptions,
): Promise<WebMcpToolResult> {
  const checked = validateClassification(input);
  if (!checked.ok) return result(checked.message);
  const preview = await post<ClassificationRead>(
    '/classification-previews', checked.value, options?.signal,
  );
  if (preview.kind === 'cancelled') return result(cancelledLine(false));
  if (preview.kind === 'uncertain') return result(serviceRefusalLine(null));
  if (preview.kind === 'malformed') return result(protocolFailureLine(false));
  if (preview.kind === 'refused') return result(serviceRefusalLine(preview.status));
  if (preview.body.preview !== true || preview.body.authoritativeWrites !== 0
      || !Array.isArray(preview.body.results)
      || preview.body.results.length !== checked.value.items.length) {
    return result(protocolFailureLine(false));
  }
  const expected = new Set(checked.value.items.map((item) => item.clientRef));
  const results: { clientRef: string; matches: { label: string | null; similarity: number }[] }[] = [];
  for (const row of preview.body.results) {
    if (!record(row) || typeof row.clientRef !== 'string' || !expected.delete(row.clientRef)
        || !Array.isArray(row.matches) || row.matches.length > 5) {
      return result(protocolFailureLine(false));
    }
    const matches: { label: string | null; similarity: number }[] = [];
    for (const match of row.matches) {
      if (!record(match) || (match.label !== null && typeof match.label !== 'string')
          || typeof match.similarity !== 'number' || !Number.isFinite(match.similarity)
          || match.similarity < -1 || match.similarity > 1) {
        return result(protocolFailureLine(false));
      }
      matches.push({ label: match.label, similarity: match.similarity });
    }
    results.push({ clientRef: row.clientRef, matches });
  }
  return result(classificationSummary(results));
}

interface DropRead extends Partial<DropReading> {
  authoritativeWrites?: unknown;
  queue?: { nights?: unknown };
}

async function dropMaterials(input: unknown, options?: ToolExecuteOptions): Promise<WebMcpToolResult> {
  const checked = validateDropMaterials(input);
  if (!checked.ok) return result(checked.message);
  const dropped = await post<DropRead>('/course-drops', checked.value, options?.signal);
  if (dropped.kind === 'cancelled') return result(cancelledLine(true, 'dropId'));
  if (dropped.kind === 'uncertain') return result(writeFailureLine(null, 'dropId'));
  if (dropped.kind === 'refused') return result(writeFailureLine(dropped.status, 'dropId'));
  if (dropped.kind === 'malformed') return result(protocolFailureLine(true, 'dropId'));
  const body = dropped.body;
  const numbers = [body.read, body.failed, body.repeated, body.planned, body.queue?.nights];
  if (body.dropId !== checked.value.dropId || body.authoritativeWrites !== 0
      || !numbers.every(whole) || (body.read as number) + (body.failed as number) !== checked.value.items.length
      || (body.queue?.nights as number) < 1
      || (body.repeated as number) > (body.read as number)
      || (body.planned as number) > (body.read as number)) {
    return result(protocolFailureLine(true, 'dropId'));
  }
  const summary = dropSummary({
    dropId: body.dropId, read: body.read as number, failed: body.failed as number,
    repeated: body.repeated as number, planned: body.planned as number,
    nights: body.queue?.nights as number,
  });
  announce({ kind: 'drop', summary });
  return result(summary);
}

const running = new Set<string>();
const guarded = (
  name: string,
  execute: (input: unknown, options?: ToolExecuteOptions) => Promise<WebMcpToolResult>,
): ModelContextTool['execute'] => async (input, options) => {
  if (running.has(name)) return result(`The ${name} tool already has a call in progress. Nothing new was sent.`);
  running.add(name);
  try { return await execute(input, options); }
  finally { running.delete(name); }
};

async function guideView(input: unknown): Promise<WebMcpToolResult> {
  const checked = validateGuideView(input);
  if (!checked.ok) return result(checked.message);
  return result(await guideVirgilView(checked.value));
}

export function virgilTools(): readonly ModelContextTool[] {
  return [
    {
      name: TOOL_GUIDE_VIEW, title: 'Guide the visible Virgil view',
      description: GUIDE_VIEW_DESCRIPTION, inputSchema: GUIDE_VIEW_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: guarded(TOOL_GUIDE_VIEW, guideView),
    },
    {
      name: TOOL_STUDY_STATE, title: 'Read Virgil study state',
      description: STUDY_STATE_DESCRIPTION, inputSchema: STUDY_STATE_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: guarded(TOOL_STUDY_STATE, studyState),
    },
    {
      name: TOOL_DRAFT_INTAKE, title: 'Draft a course intake',
      description: DRAFT_INTAKE_DESCRIPTION, inputSchema: DRAFT_INTAKE_SCHEMA,
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: guarded(TOOL_DRAFT_INTAKE, draftIntake),
    },
    {
      name: TOOL_PREVIEW_CLASSIFICATION, title: 'Preview board classification',
      description: PREVIEW_CLASSIFICATION_DESCRIPTION, inputSchema: PREVIEW_CLASSIFICATION_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: guarded(TOOL_PREVIEW_CLASSIFICATION, previewClassification),
    },
    {
      name: TOOL_DROP_MATERIALS, title: 'Drop course materials',
      description: DROP_MATERIALS_DESCRIPTION, inputSchema: DROP_MATERIALS_SCHEMA,
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: guarded(TOOL_DROP_MATERIALS, dropMaterials),
    },
  ];
}

interface RegistrationState {
  readonly host: ModelContext;
  readonly controller: AbortController;
  readonly names: Set<string>;
}

let registration: RegistrationState | null = null;
let initialization: Promise<number> | null = null;
let lifecycleBound = false;

export function disposeWebMcp(): void {
  registration?.controller.abort();
  registration = null;
  initialization = null;
}

function bindLifecycle(): void {
  if (lifecycleBound || typeof window === 'undefined'
      || typeof window.addEventListener !== 'function') return;
  lifecycleBound = true;
  window.addEventListener('pagehide', disposeWebMcp, { once: true });
}

async function registerMissing(host: ModelContext): Promise<number> {
  if (registration?.host !== host) {
    registration?.controller.abort();
    registration = { host, controller: new AbortController(), names: new Set() };
  }
  bindLifecycle();
  let count = 0;
  for (const tool of virgilTools()) {
    if (registration.names.has(tool.name)) continue;
    try {
      await host.registerTool(tool, { signal: registration.controller.signal });
      registration.names.add(tool.name);
      count += 1;
    } catch { /* a later init retries only this missing lane */ }
  }
  return count;
}

export async function initWebMcp(): Promise<number> {
  const host = modelContext();
  if (!host) return 0;
  if (initialization) return initialization;
  initialization = registerMissing(host).finally(() => { initialization = null; });
  return initialization;
}
