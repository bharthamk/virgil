/**
 * A board id made out of a token claim.
 *
 * `sub` comes from a bearer token, which is the least trusted thing in this
 * system, and it becomes a filename on one store adapter and a document id on
 * another. Everything here is about what must not get through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardIdFor, isLearnerId } from '../domain/learner-board.js';

test('an ordinary provider uid names a board', () => {
  // 28 URL-safe characters, which is what Firebase issues.
  assert.equal(boardIdFor('kZ9xQw2vTbN4pL7yR1sD3fG5hJ8m'), 'learner-kZ9xQw2vTbN4pL7yR1sD3fG5hJ8m');
  assert.ok(isLearnerId('a-b_C9'));
});

test('a board id is never bare token input, even when the token is honest', () => {
  // Prefixed so a store can be swept for boards without guessing, and so a uid
  // can never collide with a document this system writes for its own reasons.
  assert.ok(boardIdFor('abc')!.startsWith('learner-'));
});

test('a learner id that would climb out of a directory is refused', () => {
  for (const nasty of ['..', '.', '../../etc/passwd', 'a/b', 'a\\b', './x']) {
    assert.equal(boardIdFor(nasty), null, nasty);
  }
});

test('a learner id that would inject a firestore path is refused', () => {
  for (const nasty of ['boards/x/pins/y', '__proto__/x', 'a b', 'a.b']) {
    assert.equal(boardIdFor(nasty), null, nasty);
  }
});

test('an empty, absent or non-string claim is refused rather than defaulted', () => {
  // A default here would be a shared board that every broken token lands in.
  for (const nothing of ['', null, undefined, 0, {}, [], true]) {
    assert.equal(boardIdFor(nothing as unknown), null, JSON.stringify(nothing));
  }
});

test('a claim long enough to be an attack on the store is refused', () => {
  assert.equal(boardIdFor('a'.repeat(129)), null);
  assert.ok(isLearnerId('a'.repeat(128)));
});

test('two learners never share a board', () => {
  assert.notEqual(boardIdFor('learnerOne'), boardIdFor('learnerTwo'));
});

test('a learner id that only differs by case is a different learner', () => {
  // Firebase uids are case-sensitive, and a store on a case-insensitive
  // filesystem would otherwise hand one learner another's board.
  assert.notEqual(boardIdFor('abcDEF'), boardIdFor('ABCdef'));
});
