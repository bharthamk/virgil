import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  COLLAPSE_WINDOW_MS, MEMORY_KEY, MOUSE_FIRST_MS, RIGHT_BUTTON,
  contains, installSelectionMemory, isOneToken, markMenuResult, recovers,
  type Remembered, type SelectionMemory,
} from '../selection-memory.js';

/**
 * The selection the right-click took away.
 *
 * Reported from real use on macOS: highlight a phrase, right-click, and the
 * pin carries a single word. The collapse is the mousedown's default action,
 * so a capture-phase listener on that event sees the selection the learner
 * still had, and there is nothing left to infer.
 *
 * The first version of this file inferred anyway. It watched `selectionchange`
 * and recovered the earlier selection only when the collapsed word sat inside
 * it, which quietly excluded the case being reported: a right-click landing
 * beside the highlight rather than on it. It was tried, it did not work, and
 * the tests passed throughout. That is what these ones are written against.
 */

function fakeRange(id = 'r'): Range {
  return { id, cloneRange(): Range { return this as unknown as Range; } } as unknown as Range;
}

const remembered = (text: string, at: number, collapsedAtMenu = true): Remembered => ({
  text, range: fakeRange(), at, collapsedAtMenu, afterMenuText: collapsedAtMenu ? 'fields' : text,
});
const NOW = 1_000_000;
const held = (text: string, at = NOW - 50): SelectionMemory => ({ atMenu: remembered(text, at) });

test('the highlight is recovered when the browser left less than there was', () => {
  const got = recovers(held('fields match the query'), 'fields', NOW);
  assert.equal(got?.text, 'fields match the query');
});

test('a pre-menu snapshot alone never triggers the workaround', () => {
  assert.equal(recovers({ atMenu: remembered('fields match the query', NOW - 50, false) }, 'fields', NOW), null);
});

test('the context-menu event marks only an observed shortening', () => {
  const changed = { atMenu: remembered('fields match the query', NOW - 50, false) };
  markMenuResult(changed, 'fields', NOW);
  assert.equal(changed.atMenu?.collapsedAtMenu, true);
  assert.equal(changed.atMenu?.afterMenuText, 'fields');

  const kept = { atMenu: remembered('fields match the query', NOW - 50, false) };
  markMenuResult(kept, 'fields match the query', NOW);
  assert.equal(kept.atMenu?.collapsedAtMenu, false);
});

test('a right-click that took the whole selection away still recovers it', () => {
  // The case the first version missed. Nothing survives the collapse at all,
  // which is a shorter selection than the one that was there.
  assert.equal(recovers(held('fields match the query'), '', NOW)?.text, 'fields match the query');
});

test('a selection the browser did not touch is the learner’s own', () => {
  // Right-clicking inside a selection preserves it on every platform this
  // runs on. The snapshot and the live selection are then the same string,
  // and recovering would be replacing something with itself.
  assert.equal(recovers(held('fields match the query'), 'fields match the query', NOW), null);
});

test('a selection made larger since the snapshot is not a collapse', () => {
  assert.equal(recovers(held('fields'), 'fields match the query', NOW), null);
});

test('a snapshot older than the window is a highlight from another reading', () => {
  assert.equal(recovers(held('fields match the query', NOW - COLLAPSE_WINDOW_MS - 1), 'fields', NOW), null);
  // And one inside it still counts: a context menu can sit open a while.
  assert.equal(recovers(held('fields match the query', NOW - COLLAPSE_WINDOW_MS + 1), 'fields', NOW)?.text,
    'fields match the query');
});

test('nothing held is nothing recovered', () => {
  assert.equal(recovers(null, 'fields', NOW), null);
  assert.equal(recovers(undefined, 'fields', NOW), null);
  assert.equal(recovers({ atMenu: null }, 'fields', NOW), null);
  assert.equal(recovers(held('   '), 'fields', NOW), null, 'whitespace is not a selection');
});

// ------------------------------------------------------- the resident half

interface Wired {
  memory: SelectionMemory;
  set: (text: string) => void;
  fire: (type: string, event?: Record<string, unknown>) => void;
  listeners: string[];
}

/** The smallest document this installer needs, recording which phase each
 *  listener asked for: the capture phase is the whole mechanism. */
function wire(now: () => number = () => NOW): Wired {
  let text = '';
  const listeners: string[] = [];
  const byType = new Map<string, ((e: unknown) => void)[]>();
  const doc = {
    addEventListener(type: string, fn: (e: unknown) => void, capture?: boolean) {
      listeners.push(`${type}${capture === true ? ':capture' : ''}`);
      byType.set(type, [...(byType.get(type) ?? []), fn]);
    },
    getSelection: () => ({
      toString: () => text,
      rangeCount: text ? 1 : 0,
      getRangeAt: () => fakeRange(),
    }),
  } as unknown as Document;

  const memory = installSelectionMemory(doc, {}, now);
  return {
    memory,
    set: (t) => { text = t; },
    fire: (type, event = {}) => { for (const fn of byType.get(type) ?? []) fn(event); },
    listeners,
  };
}

test('every listener takes the capture phase, which is the whole mechanism', () => {
  const w = wire();
  assert.ok(w.listeners.every((l) => l.endsWith(':capture')),
    'a bubble-phase listener runs after the collapse it exists to beat');
  assert.ok(w.listeners.some((l) => l.startsWith('mousedown')));
  assert.ok(w.listeners.some((l) => l.startsWith('contextmenu')));
});

test('the right button holds what was selected; the left button clears it', () => {
  const w = wire();
  w.set('fields match the query');
  w.fire('mousedown', { button: RIGHT_BUTTON });
  assert.equal(w.memory.atMenu?.text, 'fields match the query');

  // A later left click somewhere else must not leave a highlight behind for a
  // menu summoned afterwards to recover.
  w.fire('mousedown', { button: 0 });
  assert.equal(w.memory.atMenu, null);
});

test('a right-click with nothing selected holds nothing', () => {
  const w = wire();
  w.set('');
  w.fire('mousedown', { button: RIGHT_BUTTON });
  assert.equal(w.memory.atMenu, null);
  w.set('   ');
  w.fire('mousedown', { button: RIGHT_BUTTON });
  assert.equal(w.memory.atMenu, null);
});

test('the keyboard route to the menu is covered, and never overwrites a fresher one', () => {
  // A menu key has no mousedown. It also does not collapse a selection, so
  // what it sees is what the learner had.
  let clock = NOW;
  const w = wire(() => clock);
  w.set('from the keyboard');
  w.fire('contextmenu');
  assert.equal(w.memory.atMenu?.text, 'from the keyboard');

  // And the mouse route wins where both fire: by the time `contextmenu`
  // arrives the collapse has happened, so its view is the damaged one.
  const m = wire(() => clock);
  m.set('fields match the query');
  m.fire('mousedown', { button: RIGHT_BUTTON });
  m.set('fields');
  clock += MOUSE_FIRST_MS - 1;
  m.fire('contextmenu');
  assert.equal(m.memory.atMenu?.text, 'fields match the query',
    'the collapsed selection overwrote the one taken before the collapse');
  assert.equal(m.memory.atMenu?.collapsedAtMenu, true,
    'the workaround was not scoped to the gesture where the shortening was observed');
});

test('installing twice keeps the memory that has been watching', () => {
  const scope: Record<string, unknown> = {};
  const doc = { addEventListener() {}, getSelection: () => null } as unknown as Document;
  const first = installSelectionMemory(doc, scope, () => NOW);
  first.atMenu = remembered('held', NOW);
  assert.equal(installSelectionMemory(doc, scope, () => NOW), first);
  assert.equal((installSelectionMemory(doc, scope, () => NOW)).atMenu?.text, 'held');
});

test('capture reads the key this module writes, and the same window', () => {
  // `capture` is serialised across the `executeScript` boundary and can hold
  // no imports (reviewer-boundary constraint), so it spells both out. Two copies of a rule is two rules
  // the day one of them changes.
  const capture = readFileSync(
    fileURLToPath(new URL('../../src/capture.ts', import.meta.url)), 'utf8');
  assert.equal(MEMORY_KEY, '__sbSelectionMemory');
  assert.ok(capture.includes(MEMORY_KEY), 'capture reads a different key than this module writes');
  assert.ok(capture.includes('atMenu'), 'capture reads a field this module does not write');
  assert.ok(capture.includes(`${COLLAPSE_WINDOW_MS / 1000}_000`),
    'capture and this module disagree about how old a snapshot may be');
});

// The two helpers survive from the first version because they are still the
// honest way to ask their questions, and something may need them again.
test('the helpers still answer what they claim to', () => {
  assert.equal(isOneToken('fields'), true);
  assert.equal(isOneToken('fields match'), false);
  assert.equal(isOneToken('  '), false);
  const outer = { compareBoundaryPoints: () => -1 } as unknown as Range;
  assert.equal(contains(outer, outer), false, 'END_TO_END of -1 is not containment');
  const throws = { compareBoundaryPoints: () => { throw new Error('different documents'); } } as unknown as Range;
  assert.equal(contains(throws, throws), false, 'ranges that cannot be compared are not nested');
});

// ------------------------------- the shipped listeners, which are not these

/**
 * `selection-content.js`, read as text.
 *
 * The listeners ship as a declared classic content script rather than as this
 * module, because a content script's dynamic `import()` is checked against the
 * page's CSP and Udacity's does not cover the `chrome-extension:` scheme. The
 * import was refused, the loader swallowed it, and the whole mechanism was
 * absent on exactly the kind of site somebody learns on.
 *
 * Three copies of three constants now exist: here, in that file, and spelled
 * out inside `capture` (reviewer-boundary constraint). These are the assertions that keep them one.
 */
const shipped = (): string => readFileSync(
  fileURLToPath(new URL('../../selection-content.js', import.meta.url)), 'utf8');

/** The same file with its comments stripped. The header explains the CSP hole
 *  this exists to close, in the words the code must not contain. */
const shippedCode = (): string => shipped()
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('the shipped listeners agree with this module on all three constants', () => {
  const js = shipped();
  assert.match(js, new RegExp(`KEY = '${MEMORY_KEY}'`), 'a different key is a memory nothing reads');
  assert.match(js, new RegExp(`RIGHT_BUTTON = ${RIGHT_BUTTON}`));
  assert.match(js, new RegExp(`MOUSE_FIRST_MS = ${MOUSE_FIRST_MS}`));
});

test('the shipped listeners take the capture phase, on both routes to the menu', () => {
  // The whole mechanism. A bubble-phase listener runs after the collapse it
  // exists to beat, and would restore nothing while looking correct.
  const js = shipped();
  assert.match(js, /addEventListener\('mousedown',[\s\S]*?\}, true\)/);
  assert.match(js, /addEventListener\('contextmenu',[\s\S]*?\}, true\)/);
});

test('the shipped listener records the observed collapse rather than guessing later', () => {
  const js = shippedCode();
  assert.match(js, /collapsedAtMenu:\s*before\.length\s*>\s*after\.length/);
  assert.match(js, /afterMenuText:\s*after/);
});

test('the shipped listeners import nothing at all, which is the point of them', () => {
  const js = shippedCode();
  assert.ok(!/\bimport\s*\(/.test(js), 'a dynamic import here is the CSP hole this file exists to close');
  assert.ok(!/^import\s/m.test(js), 'a declared content script cannot be a module in MV3');
  assert.ok(!/chrome\.runtime\.getURL/.test(js), 'reaching for an extension url is the same hole');
});

test('the manifest declares them early, and before the detector', () => {
  const manifest = JSON.parse(readFileSync(
    fileURLToPath(new URL('../../manifest.json', import.meta.url)), 'utf8')) as {
      content_scripts: { js: string[]; run_at: string }[];
    };
  const mine = manifest.content_scripts.find((c) => c.js.includes('selection-content.js'));
  assert.ok(mine, 'the listeners are not declared, so nothing is listening on any page');
  assert.equal(mine!.run_at, 'document_start',
    'later than this is a page a learner can already be reading and right-clicking on');
  // And it is not folded into the detector's loader: that one is a background
  // nicety a pause may quiet, and a pin outranks what watches ( the learner-confirmation contract).
  assert.ok(!mine!.js.includes('reread-content.js'));
});
