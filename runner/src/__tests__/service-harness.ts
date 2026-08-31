import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fixedClock,
  type Deps, type Embedder, type Llm, type LlmRequest, type LlmResult,
  type Pin, type Research, type Session, type SessionSection, type Signal,
  type Statement, type Suggestion, type Topic,
} from '@sb/core';
import { JsonStore } from '@sb/adapters';

import { createApp, type AppOptions } from '../service.js';

/**
 * A real service, on a port the operating system picks, over a store in a
 * throwaway directory.
 *
 * Two rules this exists to keep. The port is always ephemeral — 8791 is the
 * learner's own running service and 8787 belongs to something else on this
 * machine, and a test that binds either is a test that takes the developer's
 * tools away from them mid-session. And no model is ever reached: `StubLlm`
 * answers from the schema it is handed, so a network failure can never be the
 * reason one of these tests is red.
 */

/** In the exact form `toISOString` produces, so a stored timestamp written by
 *  the injected clock can be compared to it directly. */
export const NOW = '2026-08-19T03:00:00.000Z';

// ------------------------------------------------------------------- stubs

/** Answers structured calls from the shape of the schema they carry, so one
 *  stub serves Scout, marking and depth rewrites without knowing about any of
 *  them. Overridable per test, and it records every call it took. */
export class StubLlm implements Llm {
  readonly calls: LlmRequest[] = [];
  constructor(private readonly answer?: (req: LlmRequest) => unknown) {}

  async complete(req: LlmRequest): Promise<LlmResult<string>> {
    this.calls.push(req);
    return { value: 'stub', modelId: 'stub', inputTokens: 0, outputTokens: 0 };
  }

  async structured<T>(req: LlmRequest & { schema: unknown }): Promise<LlmResult<T>> {
    this.calls.push(req);
    const override = this.answer?.(req);
    const value = (override ?? StubLlm.bySchema(req.schema)) as T;
    return { value, modelId: 'stub', inputTokens: 0, outputTokens: 0 };
  }

  private static bySchema(schema: unknown): unknown {
    const required = (schema as { required?: readonly string[] } | null)?.required ?? [];
    const has = (k: string): boolean => required.includes(k);
    if (has('substantiallyCorrect')) {
      return {
        response: 'You have the mechanism; the deadline is the part to hold on to.',
        gotRight: ['at-least-once'], missed: [], substantiallyCorrect: true,
      };
    }
    if (has('label')) return { label: 'Stub topic label', matchedExistingLabel: null, confidence: 0.8 };
    if (has('findings')) {
      return {
        findings: [{
          quote: 'it will eventually arrive',
          problem: 'Stated as a guarantee the delivery semantics do not give you.',
          relatedTopicId: 'A',
          pinSuggestion: 'Retry semantics',
        }],
      };
    }
    if (has('defects')) return { defects: [] };
    if (has('body')) return { body: 'Rewritten at the requested register.' };
    return {};
  }
}

/** A model call is the failure. Used where the endpoint must not reach one. */
export const noLlm = (): Llm => ({
  complete: async () => { throw new Error('a model call would itself be the failure here'); },
  structured: async <T>(): Promise<LlmResult<T>> => {
    throw new Error('a model call would itself be the failure here');
  },
});

/** Every call throws — the Scout fallback path () runs on this. */
export const brokenLlm = (): Llm => ({
  complete: async () => { throw new Error('ollama is not running'); },
  structured: async <T>(): Promise<LlmResult<T>> => { throw new Error('ollama is not running'); },
});

export const stubEmbedder: Embedder = { modelId: 'stub-space', embed: async (texts) => texts.map(() => [0, 0]) };

export const stubResearch: Research = {
  fetchPage: async () => null,
  findReferences: async () => [],
  hasGrounding: false,
};

// -------------------------------------------------------------- the harness

export interface Response<T = any> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

export interface Harness {
  readonly url: string;
  readonly store: JsonStore;
  readonly deps: Deps;
  /** JSON in, JSON out. `body` is omitted rather than sent as `null`. */
  call<T = any>(
    method: string, path: string, body?: unknown, headers?: Readonly<Record<string, string>>,
  ): Promise<Response<T>>;
  /** The same, with the request body sent verbatim — malformed JSON included. */
  raw<T = any>(method: string, path: string, body: string): Promise<Response<T>>;
  close(): Promise<void>;
}

export async function startService(
  tag: string,
  over: Partial<Deps> = {},
  opts: AppOptions = {},
): Promise<Harness> {
  const store = new JsonStore(join(mkdtempSync(join(tmpdir(), `sb-svc-${tag}-`)), 'db.json'));
  const deps: Deps = {
    llm: new StubLlm(),
    embedder: stubEmbedder,
    store,
    research: stubResearch,
    clock: fixedClock(NOW),
    ...over,
  };

  const server: Server = createServer(createApp(deps, opts));
  // Port 0: the OS hands out a free one. Never 8791, never 8787.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const read = async (res: globalThis.Response): Promise<Response> => {
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* left as text */ }
    return { status: res.status, body, headers: res.headers };
  };

  return {
    url, store, deps,
    call: async (method, path, body, headers = {}) => read(await fetch(`${url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })),
    raw: async (method, path, body) => read(await fetch(`${url}${path}`, {
      method, headers: { 'content-type': 'application/json' }, body,
    })),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ------------------------------------------------------------------ fixtures

export const pin = (id: string, topicId: string | null, over: Partial<Pin> = {}): Pin => ({
  id,
  type: 'interest',
  envelope: {
    selection: `what ${id} was about`,
    parts: [],
    surroundingText: `the paragraph around ${id}`,
    headingPath: ['Docs', 'Section'],
    pageTitle: `page for ${id}`,
    url: 'https://example.com/doc',
    canonicalUrl: null,
    siteName: null,
    contentLanguage: 'en',
    media: null,
  },
  note: null,
  capturedAt: '2026-08-01T00:00:00Z',
  fromSuggestion: false,
  enrichment: null,
  topicId,
  ...over,
});

export const topic = (id: string, pinIds: readonly string[], over: Partial<Topic> = {}): Topic => ({
  id,
  label: `label of ${id}`,
  summary: `summary of ${id}`,
  pinIds,
  state: 'working',
  comfort: 0.5,
  lastExposedAt: null,
  retiredByUser: false,
  createdAt: '2026-08-01T00:00:00Z',
  ...over,
});

export const section = (topicId: string, over: Partial<SessionSection> = {}): SessionSection => ({
  topicId,
  heading: `heading for ${topicId}`,
  body: `body for ${topicId}`,
  depth: 'building',
  estimatedMinutes: 5,
  question: { prompt: 'Why is the handler required to be idempotent?', kind: 'free-text', expectedPoints: ['redelivery'] },
  sourceIds: [],
  completed: false,
  ...over,
});

export const session = (id: string, sections: readonly SessionSection[], over: Partial<Session> = {}): Session => ({
  id,
  builtAt: '2026-08-19T03:04:00Z',
  fromPinCount: sections.length,
  targetMinutes: 15,
  estimatedMinutes: sections.length * 5,
  sections,
  currentSectionIndex: 0,
  closingNote: null,
  ...over,
});

export const suggestion = (id: string, over: Partial<Suggestion> = {}): Suggestion => ({
  id,
  passage: 'the passage they came back to three times',
  url: 'https://example.com/doc',
  reason: 're-read three times, then searched for a simpler explanation',
  raisedAt: '2026-08-18T21:00:00Z',
  state: 'pending',
  pageTitle: 'ADK — Sessions',
  headingPath: ['ADK', 'Sessions'],
  ...over,
});

export const statement = (id: string, over: Partial<Statement> = {}): Statement => ({
  id,
  text: 'Your sense of understanding forms before you meet the exceptions.',
  topicId: null,
  userEdited: false,
  evidenceSignalIds: [],
  updatedAt: '2026-08-18T03:00:00Z',
  ...over,
});

export const signalsFor = (signals: readonly Signal[], topicId: string): readonly Signal[] =>
  signals.filter((s) => s.topicId === topicId);
