import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, freshImport, jsonResponse, type ChromeStub } from './chrome-stub.js';
import { SERVICE, SHARED_SECRET_HEADER, SHARED_SECRET_KEY } from '../service.js';
import type { ModelContext, ModelContextTool } from '../webmcp.js';
import {
  batchRefusal, boundedToolOutput, CLASSIFICATION_PREVIEW_LIMIT, classificationSummary,
  DRAFT_INTAKE_DESCRIPTION, DRAFT_INTAKE_SCHEMA, draftIntakeSummary, DROP_ID_MAX_CHARS,
  DROP_ITEM_LIMIT, DROP_MATERIALS_DESCRIPTION, DROP_MATERIALS_SCHEMA, dropSummary,
  PREVIEW_CLASSIFICATION_DESCRIPTION, PREVIEW_CLASSIFICATION_SCHEMA,
  serviceRefusalLine, STUDY_STATE_DESCRIPTION, studyStateSummary, TOOL_OUTPUT_MAX_CHARS,
  TOOL_DRAFT_INTAKE, TOOL_DROP_MATERIALS, TOOL_PREVIEW_CLASSIFICATION, TOOL_STUDY_STATE,
  validateClassification, validateDraftIntake, validateDropMaterials,
} from '../webmcp-core.js';
import {
  GUIDE_VIEW_DESCRIPTION, GUIDE_VIEW_SCHEMA, TOOL_GUIDE_VIEW, validateGuideView,
} from '../guide-core.js';

/**
 * The service lanes and presentation guide, as an agent meets them.
 *
 * Two halves, for the reason `notebook-seam.test.ts` has two: the sentences an
 * agent reads before it acts are a control and are asserted verbatim, and the
 * registration itself is behavioural — a fake `document.modelContext` collects
 * what was registered, and the tools are then executed against the same in-process
 * service stub the rest of this suite uses, so "it routes to the service client"
 * is a request that arrived rather than a call that was wired.
 */

// ------------------------------------------------------------- what it claims

test('every tool that writes says the learner reviews before anything is authoritative', () => {
  for (const description of [DRAFT_INTAKE_DESCRIPTION, DROP_MATERIALS_DESCRIPTION]) {
    assert.match(description, /learner/);
    assert.match(description, /review/);
  }
  assert.match(DRAFT_INTAKE_DESCRIPTION,
    /No course, commitment, deadline, topic or signal exists until the learner reviews/);
});

test('the two read-only lanes say they write nothing', () => {
  assert.match(STUDY_STATE_DESCRIPTION, /Reads only; writes nothing\./);
  assert.match(PREVIEW_CLASSIFICATION_DESCRIPTION, /nothing is filed, moved or written/);
});

test('the drop carries the same honesty as the lane it replaces', () => {
  /**
   * `GET /agent/capabilities` declared this lane `material-and-drafts` rather
   * than `draft-only` and spent nine lines on why. A tool description that
   * quietly rounded that back down to "it makes drafts" would be the one thing
   * the whole declaration exists not to do.
   */
  assert.match(DROP_MATERIALS_DESCRIPTION, /not draft-only/);
  assert.match(DROP_MATERIALS_DESCRIPTION, /writes material/);
  assert.match(DROP_MATERIALS_DESCRIPTION, /visible there at once/);
  assert.match(DROP_MATERIALS_DESCRIPTION,
    /no course, no commitment, no deadline, no topic and no signal/);
  assert.match(DROP_MATERIALS_DESCRIPTION, /no model call runs/);
});

test('the caps an agent must respect are published in the schema, not only enforced', () => {
  assert.equal(DROP_MATERIALS_SCHEMA.properties?.items?.maxItems, DROP_ITEM_LIMIT);
  assert.equal(DROP_MATERIALS_SCHEMA.properties?.items?.minItems, 1);
  assert.equal(DROP_MATERIALS_SCHEMA.additionalProperties, false);
  const item = DROP_MATERIALS_SCHEMA.properties?.items?.items;
  assert.deepEqual(item?.required, ['clientRef', 'kind']);
  assert.deepEqual(DROP_MATERIALS_SCHEMA.required, ['dropId', 'items']);
  assert.equal(DROP_MATERIALS_SCHEMA.properties?.dropId?.maxLength, DROP_ID_MAX_CHARS);
  assert.equal(DRAFT_INTAKE_SCHEMA.required?.includes('clientRef'), true);
  assert.equal(PREVIEW_CLASSIFICATION_SCHEMA.properties?.items?.maxItems,
    CLASSIFICATION_PREVIEW_LIMIT);
  // Every property an agent may send carries its own sentence: a narrow schema
  // whose fields are unexplained is a wide one with extra steps.
  for (const [name, property] of Object.entries(item?.properties ?? {})) {
    assert.ok(property.description, `${name} is offered to an agent with nothing said about it`);
  }
});

test('runtime validation is the boundary even when a browser skips schema validation', () => {
  assert.equal(validateDraftIntake({
    clientRef: 'source-1', text: 'Course: Systems', kind: 'syllabus',
  }).ok, true);
  for (const refused of [
    validateDraftIntake(null),
    validateDraftIntake({ clientRef: 'source-1', text: 'x', kind: 'other', surprise: true }),
    validateDraftIntake({ clientRef: 'source-1\u200b', text: 'x', kind: 'other' }),
    validateDraftIntake({ clientRef: 'source-1', text: 'x', kind: 'other', url: 'javascript:alert(1)' }),
    validateClassification({ items: [
      { clientRef: 'same', text: 'a' }, { clientRef: 'same', text: 'b' },
    ] }),
    validateDropMaterials({
      dropId: 'bad:id', items: [{ clientRef: 'a', kind: 'other', text: 'x' }],
    }),
    validateDropMaterials({
      dropId: 'drop-1', items: [{ clientRef: 'a', kind: 'other', text: 'x', url: 'https://example.test' }],
    }),
    validateDropMaterials({
      dropId: 'drop-1', items: [{ clientRef: 'a', kind: 'other' }],
    }),
  ]) {
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.message, /Nothing was sent/);
  }
});

test('the guide accepts only named visible-product targets and bounded copy', () => {
  assert.equal(validateGuideView({
    surface: 'learn', target: 'learn-surface', refresh: true,
    message: 'This pin is becoming a quick lesson.', pauseForNext: true,
    exactSectionId: 'quick-lesson',
  }).ok, true);
  for (const refused of [
    validateGuideView({ surface: 'learn', target: '#anything', refresh: true }),
    validateGuideView({ surface: 'https://example.test', target: 'top', refresh: true }),
    validateGuideView({ surface: 'current', target: 'top', refresh: true, selector: 'body' }),
  ]) assert.equal(refused.ok, false);
  assert.match(GUIDE_VIEW_DESCRIPTION, /never navigates/);
  assert.equal(GUIDE_VIEW_SCHEMA.additionalProperties, false);
});

test('tool output is bounded to the browser-agent budget without splitting Unicode', () => {
  const output = boundedToolOutput('🙂'.repeat(TOOL_OUTPUT_MAX_CHARS + 20));
  assert.equal(Array.from(output).length, TOOL_OUTPUT_MAX_CHARS);
  assert.match(output, /Output shortened by Virgil\.$/);
  assert.doesNotMatch(output, /\uFFFD/);
});

test('tool metadata stays inside Chrome security guidance budgets', async (t) => {
  board(t);
  const agent = installAgent(t);
  await init();
  const inspect = (schema: typeof DRAFT_INTAKE_SCHEMA): void => {
    if (schema.description) assert.ok(schema.description.length <= 150,
      `parameter description is ${schema.description.length} characters`);
    for (const child of Object.values(schema.properties ?? {})) inspect(child);
    if (schema.items) inspect(schema.items);
    for (const choice of schema.oneOf ?? []) inspect(choice);
  };
  for (const tool of agent.tools) {
    assert.ok(tool.name.length <= 30);
    assert.ok(tool.description.length <= 500);
    inspect(tool.inputSchema);
  }
});

// -------------------------------------------------------------- the sentences

test('an oversized batch is refused with both numbers in it, and an empty one is refused too', () => {
  const over = batchRefusal('item', 101, CLASSIFICATION_PREVIEW_LIMIT);
  assert.match(String(over), /101 items/);
  assert.match(String(over), /takes 100 at a time/);
  assert.match(String(over), /Nothing was sent/);
  assert.match(String(batchRefusal('document', 0, DROP_ITEM_LIMIT)), /Nothing was sent/);
  assert.equal(batchRefusal('item', 1, CLASSIFICATION_PREVIEW_LIMIT), null);
  assert.equal(batchRefusal('document', DROP_ITEM_LIMIT, DROP_ITEM_LIMIT), null);
});

test('the study state is five lines and none of them is the payload', () => {
  const summary = studyStateSummary({
    primary: { title: 'Finish the graph reading', detail: 'Systems Design', minutes: 3 },
    courses: 2, openCommitments: 4, pendingDrafts: 1,
  });
  assert.match(summary, /^Next: Finish the graph reading — Systems Design \(3 minutes\)$/m);
  assert.match(summary, /^Active courses: 2\.$/m);
  assert.match(summary, /^Open dated work: 4\.$/m);
  assert.match(summary, /^Course drafts waiting for review: 1\.$/m);
  assert.match(summary, /^Nothing here has been changed by this call\.$/m);
});

test('an empty board says so rather than inventing an action', () => {
  const summary = studyStateSummary({
    primary: null, courses: 0, openCommitments: 0, pendingDrafts: 0,
  });
  assert.match(summary, /Next: nothing is being offered right now\./);
});

test('a made draft is reported as a draft', () => {
  const summary = draftIntakeSummary({ title: 'CS101', objectives: 1, commitments: 3 });
  assert.match(summary, /1 proposed objective\b/);
  assert.match(summary, /3 proposed dated items/);
  assert.match(summary, /It is a draft\./);
  assert.match(summary, /until the learner opens it in My studies and applies it/);
});

test('a classification preview names the topics and says nothing moved', () => {
  const summary = classificationSummary([
    { clientRef: 'a', matches: [{ label: 'Graphs', similarity: 0.812 }] },
    { clientRef: 'b', matches: [] },
  ]);
  assert.match(summary, /2 items matched against the board\./);
  assert.match(summary, /a: Graphs \(0\.81\)/);
  assert.match(summary, /b: no board topic resembles this yet\./);
  assert.match(summary, /Preview only\. Nothing was filed, moved or written\./);
});

test('a drop receipt separates what is on the board from what is only proposed', () => {
  const summary = dropSummary({
    dropId: 'drop-1', read: 12, failed: 2, repeated: 0, planned: 3, nights: 2,
  });
  assert.match(summary, /12 documents read, 2 unreadable, 0 already here/);
  assert.match(summary, /12 documents are on the learner's board now as material\./);
  assert.match(summary, /3 course drafts are proposed and waiting for the learner to review\./);
  assert.match(summary, /No course, commitment, deadline, topic or signal was written\./);
  assert.match(summary, /over 2 nights/);
});

test('a refusal keeps the difference between a dead service and one that said no', () => {
  assert.match(serviceRefusalLine(null), /Virgil is not answering\./);
  assert.match(serviceRefusalLine(401), /unauthenticated/);
  assert.match(serviceRefusalLine(401), /may need to sign in/);
  assert.match(serviceRefusalLine(400), /status 400/);
  for (const status of [null, 401, 400]) {
    assert.match(serviceRefusalLine(status), /Nothing was changed/);
  }
});

// -------------------------------------------------- registration, actually run

/** Everything a fake agent was handed, and a way to make one registration fail. */
interface FakeAgent {
  readonly tools: ModelContextTool[];
  readonly signals: AbortSignal[];
  refuse: string | null;
}

function installAgent(t: TestContext, present = true): FakeAgent {
  const agent: FakeAgent = { tools: [], signals: [], refuse: null };
  const modelContext: ModelContext = {
    registerTool: async (tool, options) => {
      if (tool.name === agent.refuse) {
        // What Chrome throws for a name that is already registered.
        throw new DOMException('already registered', 'InvalidStateError');
      }
      agent.tools.push(tool);
      if (options?.signal) {
        agent.signals.push(options.signal);
        options.signal.addEventListener('abort', () => {
          const index = agent.tools.findIndex((candidate) => candidate.name === tool.name);
          if (index >= 0) agent.tools.splice(index, 1);
        }, { once: true });
      }
      return undefined;
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    value: present ? { modelContext } : {}, configurable: true, writable: true,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete (globalThis as Record<string, unknown>)['document'];
  });
  return agent;
}

async function init(): Promise<number> {
  const module = await freshImport('../webmcp.js');
  return await (module['initWebMcp'] as () => Promise<number>)();
}

function board(t: TestContext, store: Record<string, unknown> = {}): ChromeStub {
  const chrome = installChrome({ store });
  t.after(() => { chrome.uninstall(); });
  chrome.fetchHandler = (url, init) => {
    if (url.endsWith('/course-intakes') && (init?.method ?? 'GET') !== 'GET') {
      return jsonResponse({ draft: { title: 'CS101', objectives: [{}], commitments: [] } }, 201);
    }
    if (url.endsWith('/today')) {
      return jsonResponse({
        next: { primary: { title: 'Read the graph notes', detail: 'Systems Design', minutes: 3 } },
      });
    }
    if (url.endsWith('/courses')) {
      return jsonResponse({
        courses: [{ commitments: [{ id: 'k1' }, { id: 'k2' }] }],
        unattached: { commitments: [{ id: 'k3' }] },
      });
    }
    if (url.endsWith('/course-intakes')) {
      return jsonResponse({ drafts: [{ status: 'draft' }, { status: 'applied' }] });
    }
    if (url.endsWith('/classification-previews')) {
      return jsonResponse({
        preview: true, authoritativeWrites: 0,
        results: [{ clientRef: 'one', matches: [{ topicId: 't', label: 'Graphs', similarity: 0.5 }] }],
      });
    }
    if (url.endsWith('/course-drops')) {
      const body = JSON.parse(String(init?.body)) as { dropId: string };
      return jsonResponse({
        dropId: body.dropId, read: 2, failed: 0, repeated: 0, planned: 1,
        authoritativeWrites: 0, queue: { pins: 2, drafts: 1, perRun: 8, nights: 1 },
      }, 201);
    }
    return jsonResponse({ error: 'this stub was never asked for that route' }, 404);
  };
  return chrome;
}

const toolNamed = (agent: FakeAgent, name: string): ModelContextTool => {
  const found = agent.tools.find((tool) => tool.name === name);
  assert.ok(found, `${name} was never registered`);
  return found;
};

const said = async (
  tool: ModelContextTool, input: unknown = {}, options?: { signal?: AbortSignal },
): Promise<string> => await tool.execute(input, options);

test('a page with an agent behind it declares its service lanes and guide once', async (t) => {
  board(t);
  const agent = installAgent(t);
  const module = await freshImport('../webmcp.js');
  const initWebMcp = module['initWebMcp'] as () => Promise<number>;

  assert.equal(await initWebMcp(), 5);
  assert.deepEqual(agent.tools.map((tool) => tool.name), [
    TOOL_GUIDE_VIEW, TOOL_STUDY_STATE, TOOL_DRAFT_INTAKE,
    TOOL_PREVIEW_CLASSIFICATION, TOOL_DROP_MATERIALS,
  ]);
  // The API throws `InvalidStateError` on a duplicate name, so a second boot
  // that re-registered would take the page down rather than register twice.
  assert.equal(await initWebMcp(), 0);
  assert.equal(agent.tools.length, 5);
});

test('only the lanes that write nothing are marked read-only', async (t) => {
  board(t);
  const agent = installAgent(t);
  await init();
  assert.equal(toolNamed(agent, TOOL_STUDY_STATE).annotations?.readOnlyHint, true);
  assert.equal(toolNamed(agent, TOOL_PREVIEW_CLASSIFICATION).annotations?.readOnlyHint, true);
  assert.equal(toolNamed(agent, TOOL_GUIDE_VIEW).annotations?.readOnlyHint, true);
  assert.notEqual(toolNamed(agent, TOOL_DRAFT_INTAKE).annotations?.readOnlyHint, true);
  assert.notEqual(toolNamed(agent, TOOL_DROP_MATERIALS).annotations?.readOnlyHint, true);
  // Service lanes can echo learner- or caller-owned text; the guide accepts only bounded presentation copy.
  for (const tool of agent.tools.filter((candidate) => candidate.name !== TOOL_GUIDE_VIEW)) {
    assert.equal(tool.annotations.untrustedContentHint, true);
  }
  assert.equal(toolNamed(agent, TOOL_GUIDE_VIEW).annotations.untrustedContentHint, false);
});

test('a browser with no agent in it is a page that did nothing at all', async (t) => {
  const chrome = board(t);
  installAgent(t, false);
  assert.equal(await init(), 0);
  assert.deepEqual(chrome.requests, []);
});

test('registration survives one lane an agent refuses', async (t) => {
  board(t);
  const agent = installAgent(t);
  agent.refuse = TOOL_DRAFT_INTAKE;
  const module = await freshImport('../webmcp.js');
  const initWebMcp = module['initWebMcp'] as () => Promise<number>;
  assert.equal(await initWebMcp(), 4);
  assert.deepEqual(agent.tools.map((tool) => tool.name), [
    TOOL_GUIDE_VIEW, TOOL_STUDY_STATE, TOOL_PREVIEW_CLASSIFICATION, TOOL_DROP_MATERIALS,
  ]);
  agent.refuse = null;
  assert.equal(await initWebMcp(), 1, 'a transient failure was permanently hidden by the first boot');
  assert.equal(agent.tools.filter((tool) => tool.name === TOOL_DRAFT_INTAKE).length, 1);
  assert.equal(agent.tools.length, 5, 'retry duplicated lanes that were already registered');
});

test('registration is titled, cancellable, and dispose unregisters every lane', async (t) => {
  board(t);
  const agent = installAgent(t);
  const module = await freshImport('../webmcp.js');
  assert.equal(await (module['initWebMcp'] as () => Promise<number>)(), 5);
  assert.equal(agent.tools.every((tool) => tool.title.length > 0), true);
  assert.equal(agent.signals.length, 5);
  assert.equal(agent.signals.every((signal) => !signal.aborted), true);
  (module['disposeWebMcp'] as () => void)();
  assert.equal(agent.signals.every((signal) => signal.aborted), true);
  assert.deepEqual(agent.tools, []);
});

test('the study state is read through the one door that carries identity', async (t) => {
  const chrome = board(t, { [SHARED_SECRET_KEY]: 'provisioned-secret' });
  const agent = installAgent(t);
  await init();

  const summary = await said(toolNamed(agent, TOOL_STUDY_STATE));
  assert.deepEqual(chrome.requests.map((request) => request.url).sort(), [
    `${SERVICE}/course-intakes`, `${SERVICE}/courses`, `${SERVICE}/today`,
  ]);
  for (const request of chrome.requests) {
    assert.equal(request.method, 'GET');
    assert.equal(request.headers[SHARED_SECRET_HEADER], 'provisioned-secret',
      'a hand-rolled fetch would reach a protected service without the header');
  }
  assert.match(summary, /Next: Read the graph notes — Systems Design \(3 minutes\)/);
  assert.match(summary, /Active courses: 1\./);
  assert.match(summary, /Open dated work: 3\./);
  assert.match(summary, /Course drafts waiting for review: 1\./);
});

test('one intake draft is posted deterministically and reported as a draft', async (t) => {
  const chrome = board(t);
  const agent = installAgent(t);
  await init();

  const summary = await said(toolNamed(agent, TOOL_DRAFT_INTAKE), {
    clientRef: 'course-cs101', text: 'Week 1: graphs', kind: 'syllabus', title: 'CS101',
  });
  assert.equal(chrome.requests.length, 1);
  const [request] = chrome.requests;
  assert.equal(request?.url, `${SERVICE}/course-intakes`);
  assert.equal(request?.method, 'POST');
  // `enhance: false` is what the learner's own form sends. A tool that turned
  // the specialist on would spend somebody's budget on a call they cannot see.
  assert.deepEqual(request?.body, {
    clientRef: 'course-cs101', text: 'Week 1: graphs', kind: 'syllabus',
    title: 'CS101', enhance: false,
  });
  assert.match(summary, /Draft made: “CS101”/);
  assert.match(summary, /It is a draft\./);
});

test('a preview reaches the preview lane and a drop reaches the drop lane', async (t) => {
  const chrome = board(t);
  const agent = installAgent(t);
  await init();

  const preview = await said(toolNamed(agent, TOOL_PREVIEW_CLASSIFICATION), {
    items: [{ clientRef: 'one', text: 'shortest paths' }],
  });
  assert.equal(chrome.requests[0]?.url, `${SERVICE}/classification-previews`);
  assert.match(preview, /one: Graphs \(0\.50\)/);
  assert.match(preview, /Nothing was filed, moved or written\./);

  const dropped = await said(toolNamed(agent, TOOL_DROP_MATERIALS), {
    dropId: 'semester-2026', title: 'Semester', items: [
      { clientRef: 'syllabus', kind: 'syllabus', text: 'a' },
      { clientRef: 'notes', kind: 'other', text: 'b' },
    ],
  });
  assert.equal(chrome.requests[1]?.url, `${SERVICE}/course-drops`);
  assert.deepEqual(chrome.requests[1]?.body, {
    dropId: 'semester-2026', title: 'Semester', items: [
      { clientRef: 'syllabus', kind: 'syllabus', text: 'a' },
      { clientRef: 'notes', kind: 'other', text: 'b' },
    ],
  });
  assert.match(dropped, /2 documents are on the learner's board now as material\./);
  assert.match(dropped, /1 course draft is proposed/);
});

test('confirmed writes emit human-page receipts; reads do not', async (t) => {
  const events: { type: string; detail: unknown }[] = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
  class FakeCustomEvent<T> {
    constructor(readonly type: string, readonly init: { detail: T }) {}
    get detail(): T { return this.init.detail; }
  }
  Object.defineProperty(globalThis, 'window', {
    value: {
      dispatchEvent: (event: { type: string; detail: unknown }) => { events.push(event); return true; },
      addEventListener: () => {},
    }, configurable: true,
  });
  Object.defineProperty(globalThis, 'CustomEvent', {
    value: FakeCustomEvent, configurable: true,
  });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete (globalThis as Record<string, unknown>)['window'];
    if (previousCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', previousCustomEvent);
    else delete (globalThis as Record<string, unknown>)['CustomEvent'];
  });
  board(t);
  const agent = installAgent(t);
  await init();
  await said(toolNamed(agent, TOOL_STUDY_STATE));
  await said(toolNamed(agent, TOOL_DRAFT_INTAKE), {
    clientRef: 'draft-receipt', text: 'Course: Systems', kind: 'syllabus',
  });
  await said(toolNamed(agent, TOOL_DROP_MATERIALS), {
    dropId: 'drop-receipt', items: [
      { clientRef: 'one', kind: 'other', text: 'material' },
      { clientRef: 'two', kind: 'other', text: 'material' },
    ],
  });
  assert.deepEqual(events.map((event) => (event.detail as { kind: string }).kind), ['draft', 'drop']);
});

test('an over-cap batch is refused here rather than spent on a round trip', async (t) => {
  const chrome = board(t);
  const agent = installAgent(t);
  await init();

  const items = Array.from({ length: DROP_ITEM_LIMIT + 1 }, (_, index) => ({
    kind: 'other', clientRef: `item-${index}`, text: 'x',
  }));
  const refusal = await said(toolNamed(agent, TOOL_DROP_MATERIALS), { dropId: 'too-many', items });
  assert.match(refusal, /301 documents and this lane takes 300 at a time/);
  assert.deepEqual(chrome.requests, [], 'the refusal must cost no request');

  const empty = await said(toolNamed(agent, TOOL_PREVIEW_CLASSIFICATION), { items: [] });
  assert.match(empty, /Nothing was sent\./);
  assert.deepEqual(chrome.requests, []);
});

test('hostile and structurally invalid inputs make no service request', async (t) => {
  const chrome = board(t);
  const agent = installAgent(t);
  await init();
  const cases: [string, unknown][] = [
    [TOOL_STUDY_STATE, { leak: true }],
    [TOOL_DRAFT_INTAKE, { clientRef: 'one', text: 'x', kind: 'admin' }],
    [TOOL_PREVIEW_CLASSIFICATION, {
      items: [{ clientRef: 'same', text: 'a' }, { clientRef: 'same', text: 'b' }],
    }],
    [TOOL_DROP_MATERIALS, {
      dropId: 'one:two', items: [{ clientRef: 'a', kind: 'other', text: 'x' }],
    }],
  ];
  for (const [name, input] of cases) {
    assert.match(await said(toolNamed(agent, name), input), /Nothing was sent/);
  }
  assert.deepEqual(chrome.requests, []);
});

test('an already-cancelled execution reaches no service route', async (t) => {
  const chrome = board(t);
  const agent = installAgent(t);
  await init();
  const controller = new AbortController();
  controller.abort();
  assert.match(await said(toolNamed(agent, TOOL_DRAFT_INTAKE), {
    clientRef: 'source-one', text: 'x', kind: 'other',
  }, { signal: controller.signal }), /cancelled/);
  assert.deepEqual(chrome.requests, []);
});

test('one lane cannot be flooded with overlapping executions', async (t) => {
  const chrome = board(t);
  const agent = installAgent(t);
  await init();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  chrome.fetchHandler = async () => {
    await gate;
    return jsonResponse({
      preview: true, authoritativeWrites: 0,
      results: [{ clientRef: 'one', matches: [] }],
    });
  };
  const tool = toolNamed(agent, TOOL_PREVIEW_CLASSIFICATION);
  const first = said(tool, { items: [{ clientRef: 'one', text: 'a' }] });
  const second = await said(tool, { items: [{ clientRef: 'two', text: 'b' }] });
  assert.match(second, /already has a call in progress/);
  release();
  assert.match(await first, /1 item matched against the board/);
  assert.equal(chrome.requests.length, 1);
});

test('a partial study read is named, never converted into plausible zeroes', async (t) => {
  const chrome = board(t);
  const agent = installAgent(t);
  await init();
  const fallback = chrome.fetchHandler;
  chrome.fetchHandler = (url, request) => url.endsWith('/courses')
    ? jsonResponse({ error: 'down' }, 503) : fallback(url, request);
  const summary = await said(toolNamed(agent, TOOL_STUDY_STATE));
  assert.match(summary, /courses unavailable/);
  assert.match(summary, /No missing value has been reported as zero/);
  assert.doesNotMatch(summary, /Active courses: 0/);
});

test('a malformed successful write receipt is treated as uncertain, not success', async (t) => {
  const chrome = board(t);
  const agent = installAgent(t);
  await init();
  chrome.fetchHandler = () => jsonResponse({
    dropId: 'some-other-drop', read: 1, failed: 0, repeated: 0, planned: 0,
    authoritativeWrites: 0, queue: { nights: 1 },
  }, 201);
  const summary = await said(toolNamed(agent, TOOL_DROP_MATERIALS), {
    dropId: 'expected-drop', items: [{ clientRef: 'one', kind: 'other', text: 'a' }],
  });
  assert.match(summary, /receipt this page could not verify/);
  assert.match(summary, /write may have landed/);
});

test('a service that refuses or is unreachable is a sentence, never a thrown tool', async (t) => {
  const chrome = board(t);
  const agent = installAgent(t);
  await init();

  chrome.fetchHandler = () => jsonResponse({ error: 'no' }, 401);
  assert.match(
    await said(toolNamed(agent, TOOL_DRAFT_INTAKE), {
      clientRef: 'source-one', text: 'x', kind: 'other',
    }),
    /unauthenticated/,
  );

  chrome.fetchHandler = () => { throw new TypeError('failed to fetch'); };
  assert.match(
    await said(toolNamed(agent, TOOL_DROP_MATERIALS), {
      dropId: 'drop-one', items: [{ clientRef: 'one', kind: 'other', text: 'a' }],
    }),
    /write may have landed/,
  );
  // And the read lane refuses to turn an unavailable board into dishonest zeroes.
  assert.match(await said(toolNamed(agent, TOOL_STUDY_STATE)), /could not verify the complete study state/);
});
