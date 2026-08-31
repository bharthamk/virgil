import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Deps } from '@sb/core';

import { SHARED_SECRET_HEADER } from '../runtime.js';
import { startService } from '../service.js';
import { StubLlm } from './service-harness.js';

/**
 * **The service-protection contract: an exposed single-board service carries an operator secret.**
 *
 * The hosted-identity contract supersedes this as the production learner route: that service
 * verifies Firebase identity and needs no second secret. The rule here still
 * protects a self-hosted or legacy service that deliberately binds beyond
 * loopback without knowing which learner is asking.
 *
 * Everything below is over a real socket rather than against `createApp`,
 * because the question is not only what the router does with a header — it is
 * whether a container that was handed no secret is allowed to bind an interface
 * at all. That decision is made before the listener, and a test that reached
 * past `startService` could not see it.
 *
 * The bind is what turns the requirement on, not `K_SERVICE`. See
 * `runtime.test.ts` for why.
 */

const SECRET = 'a-secret-long-enough-to-be-one';
const offline = (): Partial<Deps> => ({ llm: new StubLlm() });

/** Ephemeral port, memory store, every interface — the deployed shape. */
const EXPOSED = {
  SB_PORT: '0', SB_STORE: 'memory', K_SERVICE: 'virgil-service', SB_SHARED_SECRET: SECRET,
} as const;

const get = (port: number, path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers });

test('an exposed service with no secret refuses to start, rather than binding an open door', async () => {
  // The failure that matters most is the quiet one: a revision that deploys,
  // passes its health check, and serves an unauthenticated destructive API to
  // whoever reaches it. A container that cannot describe a safe run stops.
  await assert.rejects(
    startService({ SB_PORT: '0', SB_STORE: 'memory', K_SERVICE: 'virgil-service' }, offline()),
    /SB_SHARED_SECRET/);
});

test('a request without the header is refused, and every route is behind it', async () => {
  /**
   * Including `/health`. It reports the board's pin count, which is the
   * learner's data, and a single route left open is where the next one gets
   * added. Cloud Run's default startup probe is TCP on the port rather than an
   * HTTP GET, so nothing on the platform needs a way past this.
   */
  const svc = await startService(EXPOSED, offline());
  try {
    for (const path of ['/health', '/session', '/board', '/prefs', '/progression', '/usage']) {
      assert.equal((await get(svc.port, path)).status, 401, `${path} answered without the header`);
    }
  } finally { await svc.close(); }
});

test('a request with the header is served exactly as it always was', async () => {
  const svc = await startService(EXPOSED, offline());
  try {
    const res = await get(svc.port, '/health', { [SHARED_SECRET_HEADER]: SECRET });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true, pins: 0,
      compatibility: {
        protocol: 'virgil-browser-service', serviceSchema: 1,
        minClientSchema: 1, maxClientSchema: 1, modelConfigSchema: 1,
      },
    });
  } finally { await svc.close(); }
});

test('a wrong secret is refused, and the refusal says nothing about how wrong it was', async () => {
  // The body is the same string for a missing header and a wrong one. A refusal
  // that distinguished them would answer "keep going, the shape is right".
  const svc = await startService(EXPOSED, offline());
  try {
    const missing = await get(svc.port, '/health');
    const wrong = await get(svc.port, '/health', { [SHARED_SECRET_HEADER]: 'not-the-secret-at-all' });
    // The same length as the real one, so nothing but the bytes differ.
    const nearly = await get(svc.port, '/health', { [SHARED_SECRET_HEADER]: `x${SECRET.slice(1)}` });
    assert.equal(wrong.status, 401);
    assert.equal(nearly.status, 401);

    const said = await missing.json();
    assert.deepEqual(await wrong.json(), said);
    assert.deepEqual(await nearly.json(), said);
  } finally { await svc.close(); }
});

test('a destructive route is refused too, which is the whole reason the door exists', async () => {
  const svc = await startService(EXPOSED, offline());
  try {
    const res = await fetch(`http://127.0.0.1:${svc.port}/everything`, { method: 'DELETE' });
    assert.equal(res.status, 401);
  } finally { await svc.close(); }
});

test('the preflight is answered without the header, and names it as one the browser may send', async () => {
  /**
   * CORS is decided before any credential is presented — a preflight that
   * needed the header could never be sent with one, and every request would
   * fail with a browser error naming nothing. So `OPTIONS` stays open and the
   * allowed-headers list has to include this one, or the browser strips it and
   * every real request is a 401 nobody can explain.
   */
  const svc = await startService(EXPOSED, offline());
  try {
    const res = await fetch(`http://127.0.0.1:${svc.port}/pins`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.match(String(res.headers.get('access-control-allow-headers')), new RegExp(SHARED_SECRET_HEADER));
  } finally { await svc.close(); }
});

test('a loopback service with no secret still answers everything, so a laptop gained nothing to set', async () => {
  const svc = await startService({ SB_PORT: '0', SB_STORE: 'memory' }, offline());
  try {
    assert.equal(svc.host, '127.0.0.1');
    assert.equal((await get(svc.port, '/health')).status, 200);
    // And a client that sends a header anyway is not punished for it: the door
    // is not there, so there is nothing for a stray header to fail against.
    assert.equal((await get(svc.port, '/health', { [SHARED_SECRET_HEADER]: 'anything' })).status, 200);
  } finally { await svc.close(); }
});

test('a secret set on loopback closes the door there too, which is how the deployment is rehearsed', async () => {
  const svc = await startService({ SB_PORT: '0', SB_STORE: 'memory', SB_SHARED_SECRET: SECRET }, offline());
  try {
    assert.equal((await get(svc.port, '/health')).status, 401);
    assert.equal((await get(svc.port, '/health', { [SHARED_SECRET_HEADER]: SECRET })).status, 200);
  } finally { await svc.close(); }
});
