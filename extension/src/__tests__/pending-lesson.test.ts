import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clearPendingLessonResults, runPendingLesson } from '../pending-lesson.js';

const ready = {
  kind: 'ok' as const,
  body: {
    outcome: 'ready', body: 'A checked lesson.', heading: 'Ready', label: 'Ready',
    register: 'building' as const,
  },
};

const furniture = () => {
  const status = { textContent: '' } as HTMLElement;
  const card = { querySelector: () => status } as unknown as HTMLElement;
  let focused = false;
  const button = {
    disabled: false, textContent: 'Run then learn', focus: () => { focused = true; },
  } as unknown as HTMLButtonElement;
  return { status, card, button, focused: () => focused };
};

test('a ready pending lesson survives leaving the Board and opens on the next press', async () => {
  clearPendingLessonResults();
  const first = furniture();
  let opened = 0;
  const deps = {
    restingLabel: 'Run then learn', onScreen: () => false,
    run: async () => ready,
    open: async () => { opened += 1; }, failureLine: () => 'Failed.',
  };
  await runPendingLesson(first.card, { pinId: 'p1', minutes: 3, heldBack: false }, first.button, deps);
  assert.equal(first.status.textContent, 'Ready to open.');
  assert.equal(opened, 0);

  const second = furniture();
  await runPendingLesson(second.card, { pinId: 'p1', minutes: 3, heldBack: false }, second.button, {
    ...deps, onScreen: () => true,
  });
  assert.equal(opened, 1);
});

test('a refused or unchecked pending lesson restores the same focused control', async () => {
  clearPendingLessonResults();
  const refused = furniture();
  await runPendingLesson(refused.card, { pinId: 'p2', minutes: 1, heldBack: false }, refused.button, {
    restingLabel: 'Run then learn', onScreen: () => true,
    run: async () => ({ kind: 'refused', status: 429 }),
    open: async () => {}, failureLine: () => 'The model limit stopped this run.',
  });
  assert.match(refused.status.textContent ?? '', /model limit/);
  assert.equal(refused.focused(), true);

  const unchecked = furniture();
  await runPendingLesson(unchecked.card, { pinId: 'p3', minutes: 5, heldBack: true }, unchecked.button, {
    restingLabel: 'Run then learn', onScreen: () => true,
    run: async () => ({ ...ready, body: { ...ready.body, outcome: 'unverified', body: '' } }),
    open: async () => {}, failureLine: () => 'Failed.',
  });
  assert.match(unchecked.status.textContent ?? '', /did not pass its source check/);
  assert.equal(unchecked.focused(), true);
});
