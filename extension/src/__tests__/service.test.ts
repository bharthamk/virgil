import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  agentCapabilityUrl, boardPageUrlFromOrigin, SERVICE, serviceOrigin, withReadDeadline,
  withRoomReadCancellation,
} from '../service.js';

test('the source build belongs to the self-hosted service on this machine', () => {
  assert.equal(SERVICE, 'http://127.0.0.1:8791');
});

test('local QA may point the compiled panel at loopback', () => {
  assert.equal(serviceOrigin('http://127.0.0.1:8791/path'), 'http://127.0.0.1:8791');
  assert.equal(serviceOrigin('http://localhost:8791'), 'http://localhost:8791');
});

test('a self-hosted HTTPS deployment is a valid provisioned origin', () => {
  assert.equal(serviceOrigin('https://virgil.example.test/path'), 'https://virgil.example.test');
});

test('the board page lives on the service locally and in the cloud', () => {
  assert.equal(boardPageUrlFromOrigin('http://127.0.0.1:8791'), 'http://127.0.0.1:8791/app/');
  assert.equal(boardPageUrlFromOrigin('https://virgil.example.test', 'add-source'),
    'https://virgil.example.test/app/#add-source');
  assert.equal(boardPageUrlFromOrigin('https://virgil.example.test', 'account'),
    'https://virgil.example.test/app/#account');
  assert.equal(boardPageUrlFromOrigin('https://virgil.example.test', 'switch-user'),
    'https://virgil.example.test/app/#switch-user');
  assert.equal(boardPageUrlFromOrigin('https://virgil.example.test', 'sign-out'),
    'https://virgil.example.test/app/#sign-out');
  assert.equal(boardPageUrlFromOrigin('https://virgil.example.test', 'settings'),
    'https://virgil.example.test/app/#settings');
});

test('the agent capability endpoint belongs to the configured service origin', () => {
  assert.equal(agentCapabilityUrl('http://127.0.0.1:8882/path'),
    'http://127.0.0.1:8882/agent/capabilities');
  assert.equal(agentCapabilityUrl('https://virgil.example.test/app/'),
    'https://virgil.example.test/agent/capabilities');
  assert.equal(agentCapabilityUrl('http://unsafe.example.test'),
    `${SERVICE}/agent/capabilities`);
});

test('provisioning refuses unsafe or credential-bearing service origins', () => {
  for (const value of [null, '', 'not a url', 'http://example.test',
    'ftp://example.test', 'https://user:pass@example.test', 'http://127.0.0.1.example.test:8791']) {
    assert.equal(serviceOrigin(value), SERVICE, String(value));
  }
});

test('an idempotent service read inherits both the room cancellation and a deadline', async () => {
  for (const method of ['GET', 'HEAD']) {
    const room = new AbortController();
    const inRoom = withRoomReadCancellation({ method }, room.signal);
    assert.equal(inRoom.signal, room.signal, `${method} did not inherit room cancellation`);
    const timed = withReadDeadline(inRoom, 10);
    assert.notEqual(timed.init.signal, room.signal, 'the shared deadline did not join the room signal');
    assert.equal(timed.init.signal?.aborted, false);
    room.abort();
    assert.equal(timed.init.signal?.aborted, true, `leaving a room did not cancel its ${method}`);
    timed.finish();

    const deadline = withReadDeadline(withRoomReadCancellation({ method }, new AbortController().signal), 5);
    await new Promise((resolve) => { setTimeout(resolve, 15); });
    assert.equal(deadline.init.signal?.aborted, true, `${method} may still wait forever`);
    deadline.finish();
  }

  const own = new AbortController();
  assert.equal(withRoomReadCancellation({ signal: own.signal }, new AbortController().signal).signal, own.signal,
    'a caller-owned cancellation was replaced');
});

test('a mutating request is not given an ambiguous browser-side deadline', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const own = new AbortController();
    const init = { method, signal: own.signal };
    const request = withReadDeadline(init, 1);
    await new Promise((resolve) => { setTimeout(resolve, 3); });
    assert.equal(request.init, init);
    assert.equal(request.init.signal?.aborted, false, `${method} was timed out after it may have landed`);
    request.finish();
  }
});
