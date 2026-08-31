import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomLifecycle } from '../room-lifecycle.js';

test('a room owns its continuation until navigation begins', () => {
  const rooms = new RoomLifecycle<object>();
  const content = {};
  const owner = rooms.ownership(content);
  assert.equal(rooms.owns(owner, content), true);
  rooms.begin();
  assert.equal(rooms.owns(owner, content), false);
});

test('ownership also requires the same mounted content node', () => {
  const rooms = new RoomLifecycle<object>();
  const owner = rooms.ownership({});
  assert.equal(rooms.owns(owner, {}), false);
});

test('begin aborts old reads without aborting the new room signal', () => {
  const rooms = new RoomLifecycle<object>();
  const oldSignal = rooms.read().signal;
  assert.equal(oldSignal?.aborted, false);
  rooms.begin();
  assert.equal(oldSignal?.aborted, true);
  assert.equal(rooms.read().signal?.aborted, false);
});
