import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureSessionPins, dismissCaptureSessionPin, holdCaptureSessionPin,
  type CaptureSessionPin,
} from '../capture-session.js';

const pin = (
  pinId: string, label: string, at: number, ownerUid: string | null = null,
): CaptureSessionPin => ({ pinId, label, at, ownerUid });

test('the session tray is newest first and scoped to the current board owner', () => {
  const raw = [
    pin('p-old', 'Older', 10, 'u1'), pin('p-other', 'Private to someone else', 30, 'u2'),
    pin('p-new', 'Newer', 20, 'u1'),
  ];
  assert.deepEqual(captureSessionPins(raw, 'u1').map((row) => row.pinId), ['p-new', 'p-old']);
  assert.deepEqual(captureSessionPins(raw, 'u2').map((row) => row.pinId), ['p-other']);
});

test('holding the same pin refreshes one shortcut rather than making a duplicate', () => {
  const held = holdCaptureSessionPin(
    [pin('p1', 'Old label', 10), pin('p2', 'Second', 5)],
    pin('p1', 'Current label', 20),
  );
  assert.deepEqual(held, [pin('p1', 'Current label', 20), pin('p2', 'Second', 5)]);
});

test('dismiss removes only the shortcut for this owner', () => {
  const raw = [pin('same', 'Mine', 20, 'u1'), pin('same', 'Theirs', 10, 'u2')];
  assert.deepEqual(dismissCaptureSessionPin(raw, 'same', 'u1'), [pin('same', 'Theirs', 10, 'u2')]);
});

test('unreadable storage rows never become panel shortcuts', () => {
  assert.deepEqual(captureSessionPins([
    null, {}, { pinId: 'p1', label: '', at: 1, ownerUid: null },
    { pinId: 'p2', label: 'Fine', at: 'later', ownerUid: null },
    { pinId: 'p3', label: 'Fine', at: 3, ownerUid: '' },
  ], null), []);
});
