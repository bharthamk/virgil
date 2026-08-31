import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from './chrome-stub.js';
import { button, clickButton, El } from './panel-dom.js';
import {
  guideVirgilView, restoreGuidePresentation,
} from '../guide-view.js';

interface GuideDom {
  readonly app: El;
  readonly body: El;
  readonly target: El;
  uninstall(): void;
}

function toggleAttribute(element: El, name: string, force?: boolean): boolean {
  const enabled = force ?? !element.attrs.has(name);
  if (enabled) element.attrs.set(name, ''); else element.attrs.delete(name);
  return enabled;
}

function installGuideDom(t: TestContext): GuideDom {
  const app = new El('DIV');
  app.attrs.set('id', 'app');
  app.attrs.set('data-room', 'today');
  const face = new El('MAIN');
  face.attrs.set('data-learn-face', 'pins');
  const target = new El('FORM');
  target.attrs.set('data-guide-target', 'capture-entry');
  target.attrs.set('data-guide-section', 'capture-form');
  Object.assign(target, { scrollIntoView: () => {} });
  face.append(target);
  app.append(face);
  const body = new El('BODY');
  body.append(app);
  const root = new El('HTML');
  root.append(body);
  Object.assign(app, { toggleAttribute: (name: string, force?: boolean) => toggleAttribute(app, name, force) });
  Object.assign(root, { toggleAttribute: (name: string, force?: boolean) => toggleAttribute(root, name, force) });

  const previous = {
    document: (globalThis as Record<string, unknown>)['document'],
    window: (globalThis as Record<string, unknown>)['window'],
    CustomEvent: (globalThis as Record<string, unknown>)['CustomEvent'],
  };
  Object.assign(globalThis, {
    document: {
      body, documentElement: root,
      createElement: (tag: string) => new El(tag),
      getElementById: (id: string) => root.querySelector(`#${id}`),
      querySelector: (selector: string) => root.querySelector(selector),
      querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    },
    window: { dispatchEvent: () => true },
    CustomEvent: class { constructor(readonly type: string) {} },
  });
  const chrome = installChrome();
  t.after(() => { chrome.uninstall(); Object.assign(globalThis, previous); });
  return { app, body, target, uninstall: () => {} };
}

test('one named target is highlighted and a waiting guide changes no accepted state', async (t) => {
  const dom = installGuideDom(t);
  const result = await guideVirgilView({
    surface: 'capture', target: 'capture-entry', refresh: true,
    message: 'Capture keeps the source and learning question together.',
    pauseForNext: true, exactSectionId: 'capture-form',
  });
  assert.match(result, /resultCode: GUIDE_WAITING_FOR_PERSON/);
  assert.match(result, /acceptedStateChanged: false/);
  assert.equal(dom.target.getAttribute('data-guide-spotlight'), 'true');
  assert.ok(button(dom.body, 'Next'));
  assert.equal(dom.body.querySelectorAll('[data-guide-spotlight="true"]').length, 1);
});

test('waiting, pause context and explicit Next survive the presentation lifecycle', async (t) => {
  const dom = installGuideDom(t);
  await guideVirgilView({
    surface: 'capture', target: 'capture-entry', refresh: true,
    message: 'The exact Capture step.', pauseForNext: true,
  });
  dom.body.querySelector('#virgil-guide-overlay')?.remove();
  dom.target.removeAttribute('data-guide-spotlight');
  await restoreGuidePresentation();
  assert.ok(button(dom.body, 'Next'), 'reload did not restore the waiting overlay');
  assert.equal(dom.target.getAttribute('data-guide-spotlight'), 'true');

  await clickButton(dom.body, 'Pause guide');
  assert.equal(dom.app.attrs.has('inert'), true);
  const paused = await guideVirgilView({
    surface: 'capture', target: 'capture-entry', refresh: true,
  });
  assert.match(paused, /resultCode: GUIDE_PAUSED_FOR_QUESTION/);
  assert.match(paused, /pausedAt: Capture: The exact Capture step\./);

  await clickButton(dom.body, 'Resume guide');
  assert.equal(dom.app.attrs.has('inert'), false);
  await clickButton(dom.body, 'Next');
  const continued = await guideVirgilView({
    surface: 'capture', target: 'capture-entry', refresh: true,
    message: 'Continuation was explicit.', pauseForNext: false,
  });
  assert.match(continued, /resultCode: VIEW_GUIDED/);
  assert.match(continued, /Continuation was explicit/);
});

test('an absent real-product target fails closed without stale pause context', async (t) => {
  const dom = installGuideDom(t);
  await guideVirgilView({
    surface: 'capture', target: 'capture-entry', refresh: true,
    message: 'This target is present.',
  });
  dom.target.remove();
  const missing = await guideVirgilView({
    surface: 'capture', target: 'captured-item', refresh: true,
  });
  assert.match(missing, /resultCode: GUIDE_TARGET_NOT_VISIBLE/);
  assert.match(missing, /acceptedStateChanged: false/);
  assert.match(missing, /pausedAt: none/);
  assert.doesNotMatch(missing, /This target is present/);
  assert.equal(dom.body.querySelector('#virgil-guide-overlay'), null);
  assert.equal(dom.body.querySelectorAll('[data-guide-spotlight="true"]').length, 0);
});
