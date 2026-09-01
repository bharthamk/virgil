import test from 'node:test';
import assert from 'node:assert/strict';

import { TRIGGER_SCHEMA_VERSION, decode, encode, type BatchRunMessage } from '../message.js';

/**
 * The wire format.
 *
 * Every failure below is *named*, and that is the whole point of the file: the
 * ack decision differs by name, and a decoder that returns `null` forces the
 * handler to treat an unreadable byte string and a message from next month's
 * publisher identically.
 */

const raw = (s: string, attributes: Record<string, string> = {}): Parameters<typeof decode>[0] =>
  ({ data: new TextEncoder().encode(s), attributes });

test('a trigger round-trips, and the attributes index the body', () => {
  const message: BatchRunMessage = { v: 1, kind: 'nightly-run', scheduledAt: '2026-08-20T03:00:00.000Z' };
  const wire = encode(message);

  assert.deepEqual(wire.attributes, { v: '1', kind: 'nightly-run' },
    'filters match on attributes only, never on the body — so kind has to be up here');

  const back = decode(wire);
  assert.ok(back.ok);
  assert.deepEqual(back.message, message);
});

test('a trigger with no timestamp is valid — a Scheduler-published one has none', () => {
  const back = decode(encode({ v: 1, kind: 'nightly-run' }));
  assert.ok(back.ok);
  assert.equal(back.message.scheduledAt, undefined);
});

test('the version is on the wire, and a newer one is a version skew rather than garbage', () => {
  const back = decode(raw(`{"v":${TRIGGER_SCHEMA_VERSION + 1},"kind":"nightly-run"}`));
  assert.ok(!back.ok);
  assert.equal(back.failure, 'unknown-version');
  assert.match(back.detail, /v2/);
});

test('an unknown kind is named as one — the topic may carry a second event later', () => {
  const back = decode(raw('{"v":1,"kind":"pin-created"}'));
  assert.ok(!back.ok);
  assert.equal(back.failure, 'unknown-kind');
});

test('bytes that are not JSON, and JSON that is not an object', () => {
  assert.equal((decode(raw('{not json')) as { failure: string }).failure, 'unparseable');
  assert.equal((decode(raw('[1,2,3]')) as { failure: string }).failure, 'malformed');
  assert.equal((decode(raw('"hello"')) as { failure: string }).failure, 'malformed');
  assert.equal((decode(raw('{"kind":"nightly-run"}')) as { failure: string }).failure, 'malformed');
});

test('a scheduledAt that is not an instant is refused at the edge', () => {
  // Refused here rather than in the handler, so `batchKeyFor` is only ever
  // handed something that parses and its own throw stays unreachable in
  // practice.
  const back = decode(raw('{"v":1,"kind":"nightly-run","scheduledAt":"tuesday"}'));
  assert.ok(!back.ok);
  assert.equal(back.failure, 'malformed');
  assert.match(back.detail, /not an instant/);
});

test('attributes are checked against the body rather than believed', () => {
  /**
   * A publisher that sets `kind=pin-created` on a `nightly-run` body has a bug
   * that only the subscriber can see: the filter routed the message on the
   * attribute and the handler read the body, and the two disagree about what
   * arrived. Trusting either alone hides it.
   */
  const mismatch = decode(raw('{"v":1,"kind":"nightly-run"}', { kind: 'pin-created' }));
  assert.ok(!mismatch.ok);
  assert.equal(mismatch.failure, 'attribute-mismatch');

  const versionMismatch = decode(raw('{"v":1,"kind":"nightly-run"}', { v: '2' }));
  assert.ok(!versionMismatch.ok);
  assert.equal(versionMismatch.failure, 'attribute-mismatch');

  // Absent attributes are not a mismatch: a hand-published message is allowed
  // to carry only a body, and the body is what is authoritative.
  assert.ok(decode(raw('{"v":1,"kind":"nightly-run"}')).ok);
});

test('the message carries no board, no topics and no target duration', () => {
  /**
   * Asserted rather than left to review. Everything the nightly needs is
   * already in the store; a trigger that carried state would be a second source
   * of truth for it, and the first time the two disagreed the message would win
   * silently.
   */
  const keys = Object.keys(JSON.parse(
    new TextDecoder().decode(encode({ v: 1, kind: 'nightly-run', scheduledAt: '2026-08-20T03:00:00.000Z' }).data),
  ) as Record<string, unknown>);
  assert.deepEqual(keys.sort(), ['kind', 'scheduledAt', 'v']);
});
