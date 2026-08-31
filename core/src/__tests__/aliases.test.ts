import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ALIAS_HOPS, absorbedInto, isAbsorbed, resolveOn, resolveOnNullable,
  resolveTopicId, withAlias, type AliasMap,
} from '../domain/aliases.js';

/**
 * The alias map is what lets a merge retire a topic id without touching one
 * signal. The ledger is append-only because history is what makes regression
 * detectable , so the union of two merged histories has to happen in the
 * reader — which means resolution has to be total, deterministic, and safe on a
 * map that has been chained, hand-edited or corrupted.
 */

test('an id nothing points at resolves to itself', () => {
  assert.equal(resolveTopicId('T1', {}), 'T1');
  assert.equal(resolveTopicId('T1', { T2: 'T3' }), 'T1');
});

test('one merge resolves one hop', () => {
  assert.equal(resolveTopicId('T2', { T2: 'T1' }), 'T1');
});

test('a chain of merges resolves to the live topic at the end of it', () => {
  // Merge C into B, then B into A. The map keeps both entries — uncompressed,
  // because it is the record of what the learner actually did.
  const aliases: AliasMap = { C: 'B', B: 'A' };
  assert.equal(resolveTopicId('C', aliases), 'A');
  assert.equal(resolveTopicId('B', aliases), 'A');
  assert.equal(resolveTopicId('A', aliases), 'A');
});

test('a long chain still resolves', () => {
  const aliases: Record<string, string> = {};
  for (let i = 0; i < 20; i++) aliases[`T${i}`] = `T${i + 1}`;
  assert.equal(resolveTopicId('T0', aliases), 'T20');
});

test('a cycle does not hang, and every id in it gets the same answer', () => {
  // Cannot be produced by `withAlias`, so this is a hand-edited or corrupted
  // store. It must not spin the nightly run, and it must not scatter one
  // history across two ids — which is the failure the whole design exists to
  // prevent. Smallest id in the cycle, from every entry point.
  const aliases: AliasMap = { A: 'B', B: 'C', C: 'A' };
  assert.equal(resolveTopicId('A', aliases), 'A');
  assert.equal(resolveTopicId('B', aliases), 'A');
  assert.equal(resolveTopicId('C', aliases), 'A');
});

test('a chain that runs into a cycle resolves inside the cycle, not before it', () => {
  const aliases: AliasMap = { Z: 'B', B: 'C', C: 'B' };
  assert.equal(resolveTopicId('Z', aliases), 'B');
});

test('a self-referential entry resolves to itself rather than looping', () => {
  assert.equal(resolveTopicId('T1', { T1: 'T1' }), 'T1');
});

test('a chain longer than the hop cap terminates', () => {
  const aliases: Record<string, string> = {};
  for (let i = 0; i < MAX_ALIAS_HOPS + 40; i++) aliases[`T${i}`] = `T${i + 1}`;
  const out = resolveTopicId('T0', aliases);
  assert.equal(typeof out, 'string');
  assert.ok(out.length > 0);
});

test('a topic id that collides with an Object prototype key is not an alias', () => {
  // The map arrives from JSON. `__proto__` and `constructor` as topic ids must
  // read as "no alias here" rather than reaching into the prototype chain.
  assert.equal(resolveTopicId('__proto__', {}), '__proto__');
  assert.equal(resolveTopicId('constructor', {}), 'constructor');
  assert.equal(resolveTopicId('toString', {}), 'toString');
});

test('an empty or non-string target is ignored rather than trusted', () => {
  assert.equal(resolveTopicId('A', { A: '' }), 'A');
  assert.equal(resolveTopicId('A', { A: 42 } as unknown as AliasMap), 'A');
});

test('isAbsorbed asks whether the id still names a topic', () => {
  assert.equal(isAbsorbed('B', { B: 'A' }), true);
  assert.equal(isAbsorbed('A', { B: 'A' }), false, 'being a merge target is not being absorbed');
});

test('absorbedInto finds every id whose history now belongs to a topic', () => {
  assert.deepEqual(absorbedInto('A', { C: 'B', B: 'A', X: 'A' }), ['B', 'C', 'X']);
  assert.deepEqual(absorbedInto('B', { C: 'B', B: 'A' }), [], 'B is not live, nothing lands on it');
});

test('an alias that would close a cycle is refused', () => {
  assert.throws(() => withAlias({ B: 'A' }, 'A', 'B'), /cycle/);
  assert.throws(() => withAlias({}, 'A', 'A'), /itself/);
});

test('withAlias records one merge and leaves the rest of the map alone', () => {
  const before: AliasMap = { C: 'B' };
  const after = withAlias(before, 'B', 'A');
  assert.deepEqual(after, { C: 'B', B: 'A' });
  assert.deepEqual(before, { C: 'B' }, 'the map is not mutated in place');
});

test('resolving a row rewrites only the topic id, and only when it changes', () => {
  const signal = { id: 'g1', topicId: 'B', direction: 'positive' as const };
  const moved = resolveOn(signal, { B: 'A' });
  assert.equal(moved.topicId, 'A');
  assert.equal(moved.direction, 'positive');
  assert.equal(signal.topicId, 'B', 'the row handed in is not mutated — this is a read projection');
  assert.equal(resolveOn(signal, {}), signal, 'unchanged rows are returned as-is');
});

test('a null topic id stays null', () => {
  const pin = { id: 'p1', topicId: null };
  assert.equal(resolveOnNullable(pin, { B: 'A' }).topicId, null);
});
