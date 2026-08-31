/**
 * Two people, one service.
 *
 * Before this, that sentence described something impossible: `boardId` was an
 * environment variable read once at startup, so a running service was one
 * board was one person. These are the tests for the thing that makes it a
 * sentence about software.
 *
 * The ones that matter are the ones about the boundary: a token must not reach
 * another learner's board, and a request with no token must not reach anyone's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixedClock, type Deps, type Identity, type Learner } from '@sb/core';
import { JsonStore } from '@sb/adapters';
import { createApp } from '../service.js';
import {
  CloudRunJobLaunchError, type HostedRunLauncher, type HostedRunRequest,
} from '../cloud-run-job.js';
import { markHostedProcessing } from '../hosted-processing.js';
import { learnerAccessPolicy, type LearnerAccessPolicy } from '../access-policy.js';
import {
  StubLlm, stubEmbedder, stubResearch, NOW, pin, topic, session, section,
} from './service-harness.js';

/** The shape `POST /pins` takes, with the selection swapped so each learner's
 *  pin is identifiable in whichever board it ends up in. */
const capture = (selection: string): unknown => ({
  type: 'interest' as const,
  envelope: { ...pin('unused', null).envelope, selection },
  note: null,
});

/** A verifier with no cryptography in it. What is being tested here is the
 *  SERVICE's use of the port, not the port's own attack surface — that is
 *  `adapters/__tests__/firebase-auth.test.ts`, which is where the JWTs are. */
const stubIdentity = (table: Record<string, Learner>): Identity => ({
  verify: async (token) => table[token] ?? null,
});

const ALICE: Learner = { id: 'aliceUid', email: 'alice@example.com' };
const BOB: Learner = { id: 'bobUid', email: 'bob@example.com' };

interface Rig {
  url: string;
  boards: Map<string, JsonStore>;
  opened: string[];
  call(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

async function rig(over: {
  identity?: Identity;
  secret?: string;
  hostedRun?: HostedRunLauncher;
  hosted?: boolean;
  access?: LearnerAccessPolicy;
} = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'sb-multi-'));
  const boards = new Map<string, JsonStore>();
  const opened: string[] = [];

  const base: Omit<Deps, 'store'> = {
    llm: new StubLlm(), embedder: stubEmbedder, research: stubResearch, clock: fixedClock(NOW),
  };

  const app = createApp({ ...base, store: new JsonStore(join(dir, 'unused.json')) }, {
    identity: over.identity ?? stubIdentity({ 'alice-token': ALICE, 'bob-token': BOB }),
    ...(over.secret ? { secret: over.secret } : {}),
    ...(over.hostedRun ? { hostedRun: over.hostedRun } : {}),
    ...(over.hosted ? { models: { hosted: true } } : {}),
    ...(over.access ? { access: over.access } : {}),
    forLearner: async (learner) => {
      opened.push(learner.id);
      let store = boards.get(learner.id);
      if (!store) { store = new JsonStore(join(dir, `${learner.id}.json`)); boards.set(learner.id, store); }
      return { ...base, store };
    },
  });

  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url, boards, opened,
    call: async (token, method, path, body) => {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* left as text */ }
      return { status: res.status, body: parsed as any };
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

class RunLauncherStub implements HostedRunLauncher {
  readonly launches: HostedRunRequest[] = [];
  private n = 0;
  async launch(request: HostedRunRequest) {
    this.launches.push(request);
    this.n += 1;
    return {
      operationName: `projects/virgil-test/locations/us-central1/operations/op_${this.n}`,
    };
  }
}

// ============================================================== the boundary

test('two learners on one service have two boards', async (t) => {
  const r = await rig();
  t.after(() => r.close());

  await r.call('alice-token', 'POST', '/pins', capture('alice pinned this'));
  await r.call('bob-token', 'POST', '/pins', capture('bob pinned this'));

  const alice = await r.call('alice-token', 'GET', '/board');
  const bob = await r.call('bob-token', 'GET', '/board');
  assert.equal(alice.status, 200);
  assert.equal(bob.status, 200);

  const alicePins = await r.boards.get('aliceUid')!.listPins();
  const bobPins = await r.boards.get('bobUid')!.listPins();
  assert.equal(alicePins.length, 1);
  assert.equal(bobPins.length, 1);
  assert.match(alicePins[0]!.envelope.selection ?? '', /alice/);
  assert.match(bobPins[0]!.envelope.selection ?? '', /bob/);
});

test('the owner can add and remove members without exposing the list to a member', async (t) => {
  let emails = ['alice@example.com'];
  const directory = {
    addMember: async (email: string) => ({
      ownerEmail: 'alice@example.com', memberEmails: (emails = [...new Set([...emails, email])]),
    }),
    removeMember: async (email: string) => ({
      ownerEmail: 'alice@example.com', memberEmails: (emails = emails.filter((member) => member !== email)),
    }),
  };
  const access = learnerAccessPolicy({
    ownerEmail: 'alice@example.com', allowedEmails: emails, requestsPerMinute: 120, directory,
  });
  const r = await rig({ access });
  t.after(() => r.close());

  assert.equal((await r.call('bob-token', 'GET', '/board')).status, 403);
  const added = await r.call('alice-token', 'POST', '/tenant/members', { email: 'BOB@example.com' });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.members, ['alice@example.com', 'bob@example.com']);
  assert.equal((await r.call('bob-token', 'GET', '/board')).status, 200);
  const member = await r.call('bob-token', 'GET', '/tenant/members');
  assert.deepEqual(member.body, {
    role: 'member', editable: false, members: null, sharedModelSetup: true, isolatedBoard: true,
  });
  assert.equal((await r.call('bob-token', 'POST', '/tenant/members', { email: 'other@example.com' })).status, 403);
  assert.equal((await r.call('alice-token', 'DELETE', '/tenant/members', { email: 'alice@example.com' })).status, 400);
  assert.equal((await r.call('alice-token', 'DELETE', '/tenant/members', { email: 'bob@example.com' })).status, 200);
  assert.equal((await r.call('bob-token', 'GET', '/board')).status, 403);
  assert.equal((await r.boards.get('bobUid')!.listPins()).length, 0, 'removing access deleted the learner board');
});

test('hosted automatic processing dispatches one Job to the verified learner board', async (t) => {
  const worker = new RunLauncherStub();
  const r = await rig({ hostedRun: worker, hosted: true });
  t.after(() => r.close());
  assert.equal((await r.call('alice-token', 'PUT', '/prefs', { autoAfter: 3 })).status, 200);

  await r.call('alice-token', 'POST', '/pins', capture('alice one'));
  await r.call('alice-token', 'POST', '/pins', capture('alice two'));
  const threshold = await r.call('alice-token', 'POST', '/pins', capture('alice three'));

  assert.equal(threshold.status, 201);
  assert.equal(threshold.body.automaticProcessing, 'queued');
  assert.equal(worker.launches.length, 1);
  assert.deepEqual({ ...worker.launches[0], receiptId: undefined }, {
    boardId: 'learner-aliceUid', batchKey: NOW.slice(0, 10), asked: false,
    receiptId: undefined,
  });
  assert.match(worker.launches[0]!.receiptId, /^[A-Za-z0-9-]{16,128}$/);
  assert.equal((await r.boards.get('aliceUid')!.listPins()).length, 3);
  assert.equal(r.boards.has('bobUid'), false);
  const receipt = (await r.boards.get('aliceUid')!.getPrefs()).hostedProcessing!;
  assert.equal(receipt.state, 'launching');
});

test('a second hosted request sees the persisted active operation and does not launch twice', async (t) => {
  const worker = new RunLauncherStub();
  const r = await rig({ hostedRun: worker, hosted: true });
  t.after(() => r.close());
  await r.call('alice-token', 'PUT', '/prefs', { autoAfter: 3 });
  for (const word of ['one', 'two', 'three']) {
    await r.call('alice-token', 'POST', '/pins', capture(word));
  }
  const again = await r.call('alice-token', 'POST', '/batch');
  assert.equal(again.status, 200);
  assert.equal(again.body.already, true);
  assert.equal(worker.launches.length, 1);
  const state = await r.call('alice-token', 'GET', '/batch');
  assert.equal(state.body.building, true);
  assert.equal(state.body.activity.state, 'queued');
});

test('two simultaneous hosted requests atomically claim one worker dispatch', async (t) => {
  const worker = new RunLauncherStub();
  const r = await rig({ hostedRun: worker, hosted: true });
  t.after(() => r.close());
  await r.call('alice-token', 'POST', '/pins', capture('one waiting item'));

  const [a, b] = await Promise.all([
    r.call('alice-token', 'POST', '/batch'),
    r.call('alice-token', 'POST', '/batch'),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(worker.launches.length, 1, 'a read-then-write race launched two Jobs');
  assert.equal(Boolean(a.body.queued), true);
  assert.equal(Boolean(b.body.queued), true);
  assert.deepEqual([Boolean(a.body.already), Boolean(b.body.already)].sort(), [false, true]);
});

test('a fast worker can finish before launch returns and the service never downgrades it', async (t) => {
  let r!: Rig;
  const worker: HostedRunLauncher = {
    launch: async (request) => {
      const store = r.boards.get('aliceUid')!;
      await markHostedProcessing(store, request.receiptId, 'running');
      await markHostedProcessing(store, request.receiptId, 'finished');
      return { operationName: 'projects/virgil-test/locations/us-central1/operations/op_fast' };
    },
  };
  r = await rig({ hostedRun: worker, hosted: true });
  t.after(() => r.close());
  await r.call('alice-token', 'POST', '/pins', capture('one waiting item'));
  assert.equal((await r.call('alice-token', 'POST', '/batch')).status, 200);
  assert.equal((await r.boards.get('aliceUid')!.getPrefs()).hostedProcessing?.state, 'finished');
});

test('a later request reads the worker-authored terminal receipt and finds its lesson', async (t) => {
  const worker = new RunLauncherStub();
  const r = await rig({ hostedRun: worker, hosted: true });
  t.after(() => r.close());
  await r.call('alice-token', 'POST', '/pins', capture('one waiting item'));
  await r.call('alice-token', 'POST', '/batch');
  const store = r.boards.get('aliceUid')!;
  const prefs = await store.getPrefs();
  await markHostedProcessing(
    store, prefs.hostedProcessing!.receiptId, 'finished', new Date('2026-08-19T03:04:00.000Z'),
  );
  await store.putSession(session('hosted-session', [section('topic-a')], {
    batchKey: NOW.slice(0, 10), builtAt: '2026-08-19T03:04:00.000Z',
  }));
  const state = await r.call('alice-token', 'GET', '/batch');
  assert.equal(state.body.building, false);
  assert.equal(state.body.activity.state, 'finished');
  assert.equal(state.body.activity.outcome, 'session');
  assert.equal((await store.getPrefs()).hostedProcessing?.state, 'finished');
});

test('a finished hosted operation without a new lesson does not invent a reason', async (t) => {
  const worker = new RunLauncherStub();
  const r = await rig({ hostedRun: worker, hosted: true });
  t.after(() => r.close());
  await r.call('alice-token', 'POST', '/pins', capture('one waiting item'));
  await r.call('alice-token', 'POST', '/batch');
  const store = r.boards.get('aliceUid')!;
  const prefs = await store.getPrefs();
  await markHostedProcessing(
    store, prefs.hostedProcessing!.receiptId, 'finished', new Date('2026-08-19T03:04:00.000Z'),
  );

  const state = await r.call('alice-token', 'GET', '/batch');
  assert.equal(state.body.activity.state, 'finished');
  assert.equal(state.body.activity.outcome, null);
  assert.equal(state.body.activity.outcomeReason, null);
});

test('a worker-authored bounded result keeps hosted recovery as useful as local recovery', async (t) => {
  const worker = new RunLauncherStub();
  const r = await rig({ hostedRun: worker, hosted: true });
  t.after(() => r.close());
  await r.call('alice-token', 'POST', '/pins', capture('one waiting item'));
  await r.call('alice-token', 'POST', '/batch');
  const store = r.boards.get('aliceUid')!;
  const prefs = await store.getPrefs();
  await markHostedProcessing(
    store, prefs.hostedProcessing!.receiptId, 'finished', new Date('2026-08-19T03:04:00.000Z'), {
      outcome: 'quota-degraded', outcomeReason: null,
      reports: [{ stage: 'compose', ms: 29_800, failed: true, degradeReason: 'exhausted' }],
      remaining: 3, withheld: 2,
    },
  );

  const state = await r.call('alice-token', 'GET', '/batch');
  assert.equal(state.body.activity.outcome, 'quota-degraded');
  assert.deepEqual(state.body.activity.reports, [
    { stage: 'compose', ms: 29_800, failed: true, degradeReason: 'exhausted' },
  ]);
  assert.equal(state.body.activity.remaining, 3);
  assert.equal(state.body.activity.withheld, 2);
});

test('a failed hosted dispatch keeps the pin and leaves an honest retryable receipt', async (t) => {
  const worker: HostedRunLauncher = {
    launch: async () => { throw new CloudRunJobLaunchError('admin API refused', false); },
  };
  const r = await rig({ hostedRun: worker, hosted: true });
  t.after(() => r.close());
  await r.call('alice-token', 'PUT', '/prefs', { autoAfter: 3 });
  await r.call('alice-token', 'POST', '/pins', capture('one'));
  await r.call('alice-token', 'POST', '/pins', capture('two'));
  const third = await r.call('alice-token', 'POST', '/pins', capture('three'));
  assert.equal(third.status, 201);
  assert.equal(third.body.automaticProcessing, 'failed');
  assert.equal((await r.boards.get('aliceUid')!.listPins()).length, 3);
  assert.equal((await r.boards.get('aliceUid')!.getPrefs()).hostedProcessing?.state, 'failed');
});

test('an ambiguous launch failure keeps its lease and cannot dispatch twice', async (t) => {
  let launches = 0;
  const worker: HostedRunLauncher = {
    launch: async () => {
      launches += 1;
      throw new CloudRunJobLaunchError('response lost after POST', true);
    },
  };
  const r = await rig({ hostedRun: worker, hosted: true });
  t.after(() => r.close());
  await r.call('alice-token', 'PUT', '/prefs', { autoAfter: 3 });
  for (const word of ['one', 'two', 'three']) {
    await r.call('alice-token', 'POST', '/pins', capture(word));
  }
  assert.equal((await r.boards.get('aliceUid')!.getPrefs()).hostedProcessing?.state, 'launching');
  const retry = await r.call('alice-token', 'POST', '/batch');
  assert.equal(retry.body.already, true);
  assert.equal(launches, 1);
});

test('an explicit hosted Process dispatch omits the automatic due gate', async (t) => {
  const worker = new RunLauncherStub();
  const r = await rig({ hostedRun: worker, hosted: true });
  t.after(() => r.close());
  await r.call('bob-token', 'POST', '/pins', capture('one waiting item'));
  const started = await r.call('bob-token', 'POST', '/batch');
  assert.equal(started.status, 200);
  assert.equal(started.body.queued, true);
  const launch = worker.launches.at(-1)!;
  assert.deepEqual({ ...launch, receiptId: undefined }, {
    boardId: 'learner-bobUid', batchKey: NOW.slice(0, 10), asked: true,
    receiptId: undefined,
  });
  assert.match(launch.receiptId, /^[A-Za-z0-9-]{16,128}$/);
});

test('a hosted service without a worker refuses the promise rather than saving it', async (t) => {
  const r = await rig({ hosted: true });
  t.after(() => r.close());
  const prefs = await r.call('alice-token', 'GET', '/prefs');
  assert.deepEqual(prefs.body.automaticProcessing, { available: false, mode: 'unavailable' });
  const save = await r.call('alice-token', 'PUT', '/prefs', { autoAfter: 3 });
  assert.equal(save.status, 409);
  assert.equal((await r.boards.get('aliceUid')!.getPrefs()).autoAfter ?? null, null);
  assert.equal((await r.call('alice-token', 'POST', '/batch')).status, 503);
});

test('a request with no token reaches nobody', async (t) => {
  const r = await rig();
  t.after(() => r.close());
  for (const [method, path] of [['GET', '/board'], ['GET', '/session'], ['POST', '/pins']] as const) {
    const res = await r.call(null, method, path, method === 'POST' ? capture('x') : undefined);
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  assert.deepEqual(r.opened, [], 'and no board was even opened');
});

test('a verified learner never has to present the deployment secret as well', async (t) => {
  const r = await rig({ secret: 'operator-secret-is-not-a-login' });
  t.after(() => r.close());
  const res = await r.call('alice-token', 'GET', '/board');
  assert.equal(res.status, 200);
});

test('a token that does not verify reaches nobody', async (t) => {
  const r = await rig();
  t.after(() => r.close());
  const res = await r.call('not-a-real-token', 'GET', '/board');
  assert.equal(res.status, 401);
  assert.deepEqual(r.opened, []);
});

test('the refusal does not say which part was wrong', async (t) => {
  // A 401 that told a missing token from a bad one would answer "keep going,
  // the shape is right" — the same reason the shared secret says one thing.
  const r = await rig();
  t.after(() => r.close());
  const absent = await r.call(null, 'GET', '/board');
  const wrong = await r.call('not-a-real-token', 'GET', '/board');
  assert.deepEqual(absent.body, wrong.body);
});

test('one learner cannot reach another learner by naming them', async (t) => {
  // The board is chosen by the VERIFIED token and by nothing in the request.
  // If a header, a query string or a body field could pick one, the whole
  // seam is decoration.
  const r = await rig();
  t.after(() => r.close());
  await r.call('bob-token', 'POST', '/pins', capture('bob pinned this'));

  for (const path of ['/board?learner=bobUid', '/board?boardId=learner-bobUid', '/board?uid=bobUid']) {
    const res = await r.call('alice-token', 'GET', path);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.topics ?? [], [], path);
  }
  const alicePins = await r.boards.get('aliceUid')?.listPins() ?? [];
  assert.equal(alicePins.length, 0, "and alice's own board stayed empty");
});

test('a board is opened once per learner, not once per request', async (t) => {
  const r = await rig();
  t.after(() => r.close());
  await r.call('alice-token', 'GET', '/board');
  await r.call('alice-token', 'GET', '/board');
  await r.call('alice-token', 'GET', '/session');
  await r.call('bob-token', 'GET', '/board');
  assert.deepEqual(r.opened, ['aliceUid', 'bobUid']);
});

test('a bearer token is read case-insensitively, the way the header is defined', async (t) => {
  const r = await rig();
  t.after(() => r.close());
  const res = await fetch(`${r.url}/board`, { headers: { authorization: 'bearer alice-token' } });
  assert.equal(res.status, 200);
  await r.close();
});

test('a verifier that throws is a refusal, not a five hundred', async (t) => {
  // A provider outage must not become an unhandled rejection on a public route.
  const r = await rig({ identity: { verify: () => Promise.reject(new Error('provider down')) } });
  t.after(() => r.close());
  const res = await r.call('alice-token', 'GET', '/board');
  assert.equal(res.status, 401);
});

test('health answers without a token, and says nothing about anybody', async (t) => {
  const r = await rig();
  t.after(() => r.close());
  const res = await r.call(null, 'GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(!('pins' in res.body), JSON.stringify(res.body));
});

test('the single-board service still exists, and needs no token', async (t) => {
  // `createApp(deps)` with no identity is the shape every other test in this
  // repo uses and the shape a learner running this on their own machine gets.
  // Multi-tenancy is something a composition root turns ON.
  const dir = mkdtempSync(join(tmpdir(), 'sb-single-'));
  const store = new JsonStore(join(dir, 'db.json'));
  await store.putTopic(topic('t1', ['p1']));
  await store.putPin(pin('p1', 't1'));
  const app = createApp({
    llm: new StubLlm(), embedder: stubEmbedder, research: stubResearch,
    clock: fixedClock(NOW), store,
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/board`);
  assert.equal(res.status, 200);
  assert.equal((await res.json() as any).topics.length, 1);
});
