import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonStore } from '@sb/adapters';
import {
  LOCAL_CONNECTOR_LEASE_MS, fixedClock, type Deps, type LocalConnectorJob, type LocalConnectorResult,
} from '@sb/core';
import { createApp } from '../service.js';
import { NOW, StubLlm, stubEmbedder, stubResearch } from './service-harness.js';

class ConnectorStore extends JsonStore {
  tokenHash = '';
  lastSeenAt = '';
  readonly jobs = new Map<string, LocalConnectorJob>();
  async pairLocalConnector(tokenHash: string): Promise<void> { this.tokenHash = tokenHash; }
  async unpairLocalConnector(): Promise<void> { this.tokenHash = ''; this.lastSeenAt = ''; }
  async localConnectorPaired(): Promise<boolean> { return Boolean(this.tokenHash); }
  async verifyLocalConnector(tokenHash: string): Promise<boolean> { return tokenHash === this.tokenHash; }
  async touchLocalConnector(now: string): Promise<void> { this.lastSeenAt = now; }
  async localConnectorReady(): Promise<boolean> { return Boolean(this.lastSeenAt); }
  async enqueueLocalConnectorJob(job: LocalConnectorJob): Promise<void> { this.jobs.set(job.id, job); }
  async claimLocalConnectorJob(now: string, leaseId: string): Promise<LocalConnectorJob | null> {
    const job = [...this.jobs.values()].find((row) => (row.state === 'queued'
      || (row.state === 'claimed' && (!row.leaseUntil || row.leaseUntil <= now))) && row.expiresAt > now);
    if (!job) return null;
    const claimed = { ...job, state: 'claimed' as const, leaseId,
      leaseUntil: new Date(Date.parse(now) + LOCAL_CONNECTOR_LEASE_MS).toISOString() };
    this.jobs.set(job.id, claimed); return claimed;
  }
  async renewLocalConnectorJob(id: string, leaseId: string, now: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'claimed' || job.leaseId !== leaseId) return false;
    this.jobs.set(id, { ...job,
      leaseUntil: new Date(Date.parse(now) + LOCAL_CONNECTOR_LEASE_MS).toISOString() });
    return true;
  }
  async finishLocalConnectorJob(
    id: string, leaseId: string, outcome: { result: LocalConnectorResult } | { error: string },
  ): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || job.leaseId !== leaseId) return false;
    this.jobs.set(id, 'result' in outcome
      ? { ...job, state: 'completed', result: outcome.result }
      : { ...job, state: 'failed', error: outcome.error });
    return true;
  }
  async readLocalConnectorJob(id: string): Promise<LocalConnectorJob | null> {
    return this.jobs.get(id) ?? null;
  }
  async deleteLocalConnectorJob(id: string): Promise<void> { this.jobs.delete(id); }
}

test('hosted connector token reaches one learner mailbox and no board route', async (t) => {
  const store = new ConnectorStore(join(mkdtempSync(join(tmpdir(), 'virgil-connector-')), 'board.json'));
  const deps: Deps = {
    store, llm: new StubLlm(), embedder: stubEmbedder, research: stubResearch, clock: fixedClock(NOW),
  };
  const app = createApp(deps, {
    identity: { verify: async (token) => token === 'firebase-token' ? { id: 'learner_123', email: null } : null },
    forLearner: async () => deps,
    models: { hosted: true },
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const paired = await call('/local-connector/pair', {
    method: 'POST', headers: { authorization: 'Bearer firebase-token' },
  });
  assert.equal(paired.status, 200);
  const token = paired.body.token as string;
  assert.equal(token.includes('firebase-token'), false);
  assert.equal('expiresAt' in paired.body, false);

  const connectorHeaders = { 'x-virgil-local-connector': token };
  assert.equal((await call('/pins', { headers: connectorHeaders })).status, 403);
  assert.equal((await call('/local-connector/jobs/next', { headers: connectorHeaders })).status, 204);
  assert.ok(store.lastSeenAt);

  await store.enqueueLocalConnectorJob({
    id: 'job-1', state: 'queued', createdAt: NOW, expiresAt: '2026-08-20T03:00:00.000Z',
    request: { tier: 'fast', system: 's', prompt: 'p', structured: false },
  });
  const next = await call('/local-connector/jobs/next', { headers: connectorHeaders });
  assert.equal(next.status, 200);
  assert.equal(next.body.job.id, 'job-1');
  store.lastSeenAt = '';
  assert.deepEqual(await call('/local-connector/jobs/heartbeat', {
    method: 'POST', headers: { ...connectorHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: 'job-1', leaseId: next.body.job.leaseId }),
  }), { status: 200, body: { ready: true } });
  assert.ok(store.lastSeenAt);
  const finished = await call('/local-connector/jobs/job-1/complete', {
    method: 'POST', headers: { ...connectorHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      leaseId: next.body.job.leaseId,
      result: { value: 'answer', modelId: 'gemma4:12b-mlx', inputTokens: 2, outputTokens: 1 },
    }),
  });
  assert.deepEqual(finished, { status: 200, body: { accepted: true } });
  assert.equal((await store.readLocalConnectorJob('job-1'))?.result?.value, 'answer');

  assert.deepEqual(await call('/local-connector/pair', {
    method: 'DELETE', headers: { authorization: 'Bearer firebase-token' },
  }), { status: 200, body: { disconnected: true } });
  assert.equal((await call('/local-connector/jobs/next', { headers: connectorHeaders })).status, 401);
});
