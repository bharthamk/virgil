import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixedClock, projectProgression, type Store } from '@sb/core';
import { JsonStore } from '@sb/adapters';

import { progressionSnapshot } from '../progression-source.js';

/**
 * UX_SPEC §5a's architectural law, checked by a machine rather than by
 * remembering it:
 *
 *   **gamification is a read-only projection of the ledger.** It reads comfort
 *   transitions and session outcomes; it never writes signals, never weights
 *   them, and never influences composition, register selection or scheduling.
 *
 * The rationale is worth repeating where the check lives, because the check
 * looks pedantic and the failure it prevents is not: the moat is a truthful
 * learner model, and any reward that feeds back into the signals pays the
 * learner to lie to it. Keep the seam and the worst case is cosmetics; break it
 * and the model of the learner is poisoned by the thing celebrating them.
 *
 * Enforced the same way `seam-purity.test.ts` enforces the port's law, and for
 * the same reason — every violation of a law like this starts as one convenient
 * import in one file that nothing complains about. Two halves:
 *
 *  1. **The import graph**, read off the real files that will ship. Progression
 *     may reach the domain and the Registrar's arithmetic and nothing else; no
 *     agent, no composition root and no scheduler may reach progression.
 *  2. **The runtime shape.** The import graph cannot see through a `Store`
 *     handle — a projection handed the real store could call `appendSignal` and
 *     no static check would know. So the gatherer is run against a store whose
 *     every write method throws on *access*, not on call, which fails even if
 *     the reference is only taken.
 */

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const at = (...parts: string[]): string => join(repo, ...parts);
const read = (p: string): string => readFileSync(p, 'utf8');
const show = (p: string): string => relative(repo, p);

/** Every `.ts` file under a directory, tests excluded — this guards what ships. */
function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) { if (entry !== '__tests__') walk(p); continue; }
      if (p.endsWith('.ts')) out.push(p);
    }
  };
  walk(at(dir));
  return out;
}

/** Comments removed the same way the seam guard removes them, and for the same
 *  reason: this file is full of prose naming the things it forbids. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function imports(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  for (const m of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) out.push(m[1] as string);
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1] as string);
  for (const m of code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1] as string);
  return out;
}

const PROGRESSION = sources('core/src/progression');

test('the guard is reading the real projection, not an empty directory', () => {
  // Every check below passes vacuously against nothing.
  assert.ok(PROGRESSION.length >= 4, `expected the whole projection, found ${PROGRESSION.length} files`);
  assert.ok(PROGRESSION.some((p) => p.endsWith('project.ts')), 'the entry point is not being read');
  assert.ok(PROGRESSION.some((p) => p.endsWith('badges.ts')), 'the badges are not being read');
});

/**
 * The allowlist, named rather than implied.
 *
 * `agents/registrar.js` is on it deliberately and is the only agent that is.
 * The Registrar *is* the comfort ledger's arithmetic, and a projection that
 * copied `computeComfort`'s thresholds instead of calling it would drift from
 * the model it claims to be reporting — which is a learner-facing lie of
 * exactly the kind §3a catalogues. Reading it is the point. Everything else in
 * `agents/` writes, decides or teaches.
 */
const ALLOWED_OUTSIDE = new Set(['../agents/registrar.js']);

test('the projection reaches the domain and the ledger arithmetic, and nothing else', () => {
  const strays: string[] = [];
  for (const file of PROGRESSION) {
    for (const spec of imports(read(file))) {
      if (spec.startsWith('./')) continue;                    // its own siblings
      if (spec.startsWith('../domain/')) continue;            // types and arithmetic
      if (ALLOWED_OUTSIDE.has(spec)) continue;
      strays.push(`${show(file)} imports ${spec}`);
    }
  }
  assert.deepEqual(strays, [],
    'a projection that reaches further than the ledger is no longer a projection of it');
});

test('the projection cannot reach a write path at all', () => {
  // The `Store` interface is where every write in this product lives. The
  // projection is handed plain arrays by its caller and never sees the handle,
  // so the strongest form of the law is that it does not even know the type
  // exists — there is nothing to call `appendSignal` on.
  const reaching: string[] = [];
  for (const file of PROGRESSION) {
    const code = stripComments(read(file));
    if (/\bports\/store\.js/.test(code)) reaching.push(`${show(file)} imports the Store port`);
    for (const m of code.matchAll(/\b(appendSignal|putSignal|putTopic|putSession|putStatement|putPrefs|putPin|putSuggestion|putEdges|invalidateSignals|deletePin|deleteTopic|deleteStatement|deleteEverything|mergeTopics|splitTopic)\b/g)) {
      reaching.push(`${show(file)} names the write ${m[1]}`);
    }
  }
  assert.deepEqual(reaching, [],
    'one-way glass: the projection reads the ledger and has no vocabulary for changing it');
});

test('nothing that composes, schedules or teaches imports the projection', () => {
  // The other direction, and the one that actually poisons the model. A
  // Gardener that could see a chain would be a scheduler with a reason to keep
  // a number alive, and the learner would be being taught what pays.
  const wrong: string[] = [];
  const watched = [
    ...sources('core/src/agents'),
    ...sources('core/src/domain'),
    ...sources('core/src/eval'),
    at('runner/src/pipeline.ts'),
  ];
  for (const file of watched) {
    for (const spec of imports(read(file))) {
      if (/progression/.test(spec)) wrong.push(`${show(file)} imports ${spec}`);
    }
  }
  assert.deepEqual(wrong, [],
    'a reward the composer or the scheduler can see is a reward the learner is paid to chase');
});

test('the nightly run never builds a projection', () => {
  // Belt and braces on the import check: the pipeline is the one place a
  // projection could be built and quietly fed back into the night.
  const pipeline = stripComments(read(at('runner/src/pipeline.ts')));
  assert.ok(!/projectProgression|progressionSnapshot/.test(pipeline),
    'the nightly composes and schedules — it has no business awarding anything');
});

test('every projection is fed by the one gatherer, and the gatherer is one file', () => {
  // Not a style rule. `progressionSnapshot` is the only code in the repository
  // that reads a store on the projection's behalf, which is what makes the
  // runtime check underneath it a check on every path rather than on one of
  // several. A caller that assembled its own input would be a second door.
  const shipped = [...sources('runner/src'), ...sources('extension/src'), ...sources('adapters/src')];

  const defines = shipped.filter((f) => /export async function progressionSnapshot\b/.test(read(f)));
  assert.deepEqual(defines.map(show), ['runner/src/progression-source.ts']);

  const unfed = shipped
    .filter((f) => /\bprojectProgression\s*\(/.test(stripComments(read(f))))
    .filter((f) => !/\bprogressionSnapshot\b/.test(stripComments(read(f))))
    .map(show);
  assert.deepEqual(unfed, [],
    'a projection built from anything but the gatherer is a store read nothing checked');
});

// ---------------------------------------------------------- the runtime shape

/**
 * A store that answers reads and detonates on the mere *mention* of a write.
 *
 * On access rather than on call, deliberately. `const write = store.appendSignal`
 * is enough to have handed the projection a way to write, and a throw that
 * waits for the call would pass a test that never happened to reach the
 * branch. This one cannot be got past by not calling it.
 */
const WRITES: readonly (keyof Store)[] = [
  'putPin', 'deletePin', 'putTopic', 'deleteTopic', 'mergeTopics', 'splitTopic',
  'putEdges', 'appendSignal', 'invalidateSignals', 'putStatement', 'deleteStatement',
  'putSession', 'putSuggestion', 'putPrefs', 'deleteEverything',
];

function readOnly(store: Store): Store {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (WRITES.includes(prop as keyof Store)) {
        throw new Error(`the projection reached the write path ${String(prop)}`);
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A real store over a throwaway file, so the runtime checks below run against
 *  the adapter that ships rather than against a double written to suit them. */
const freshStore = (tag: string): JsonStore =>
  new JsonStore(join(mkdtempSync(join(tmpdir(), `sb-prog-${tag}-`)), 'db.json'));

test('the proxy really does detonate — the guard is not guarding nothing', async () => {
  // The mutation check on the check. A read-only proxy that had a typo in its
  // method list would let every test below pass while proving nothing.
  const store = readOnly(freshStore('detonate'));
  assert.equal(await store.latestSession(), null, 'reads still work');
  assert.throws(() => { void store.appendSignal; }, /reached the write path appendSignal/);
  assert.throws(() => { void store.putSession; }, /reached the write path putSession/);
});

test('gathering everything the projection needs touches no write path', async () => {
  const snapshot = await progressionSnapshot(
    readOnly(freshStore('gather')), fixedClock('2026-08-20T21:00:00.000Z'));

  assert.deepEqual([...snapshot.topics], []);
  assert.deepEqual([...snapshot.signals], []);
  assert.deepEqual([...snapshot.sessions], []);
  assert.equal(snapshot.now.toISOString(), '2026-08-20T21:00:00.000Z');
});

test('the session window is capped by the gatherer, at 180, keeping the newest — and the store stays uncapped', async () => {
  // `SESSION_WINDOW`'s own comment states the design: capped here, in the one
  // gatherer, because the sessions table grows forever and the badge this
  // window exists for (medium-follow-through) is about recent momentum, not
  // the whole history. The claim is testable and untested — a store that
  // silently capped its own `listSessions()` would satisfy every other check
  // in this file while moving the cap to the wrong layer, and a gatherer that
  // kept the OLDEST 180 instead of the newest would cap correctly and still
  // answer the medium-follow-through badge from the wrong nights.
  const store = freshStore('window');
  for (let i = 0; i < 185; i += 1) {
    await store.putSession({
      id: `s${i}`, builtAt: new Date(Date.parse('2020-01-01T00:00:00.000Z') + i * 86_400_000).toISOString(),
      fromPinCount: 0, targetMinutes: 15, estimatedMinutes: 0,
      sections: [], currentSectionIndex: 0, closingNote: null,
    });
  }

  // The store itself makes no promise of a cap — SESSION_WINDOW says so.
  assert.equal((await store.listSessions()).length, 185,
    'the cap belongs to the gatherer; a store that pre-trims it moves the law');

  const snapshot = await progressionSnapshot(readOnly(store), fixedClock('2026-08-20T21:00:00.000Z'));
  assert.equal(snapshot.sessions.length, 180);
  const ids = new Set(snapshot.sessions.map((s) => s.id));
  assert.ok(ids.has('s184'), 'the newest session survives the window');
  assert.ok(!ids.has('s0'), 'the oldest 5 are the ones a window of 180 must drop');
  assert.ok(!ids.has('s4'), 'exactly the newest 180 survive, not an arbitrary 180');
});

test('and the projection itself leaves the ledger it was given untouched', async () => {
  // The last door. The projection is handed arrays rather than the store, and
  // arrays can be sorted, spliced and pushed into. A projection that sorted the
  // signal ledger in place would be rewriting history for whatever read it
  // next, without a write method anywhere in sight.
  const signals = Object.freeze([
    Object.freeze({
      id: 'g1', topicId: 't1', type: 'answer-correct' as const, direction: 'positive' as const,
      at: '2026-08-01T09:00:00.000Z', sourceEvent: 'answer:s1:t1', invalidated: false,
    }),
    Object.freeze({
      id: 'g2', topicId: 't1', type: 'answer-correct' as const, direction: 'positive' as const,
      at: '2026-07-01T09:00:00.000Z', sourceEvent: 'answer:s0:t1', invalidated: false,
    }),
  ]);

  // Frozen input: any in-place sort or push throws in strict mode, which every
  // module in this repository is.
  projectProgression({
    topics: Object.freeze([]),
    signals,
    sessions: Object.freeze([]),
    now: new Date('2026-08-20T21:00:00.000Z'),
  });

  assert.deepEqual(signals.map((s) => s.id), ['g1', 'g2'], 'the ledger is in the order it arrived');
});
