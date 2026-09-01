import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mountAccountSurface } from '../account-surface.js';
import { El, click, find, installPanelDom, text } from './panel-dom.js';

const make = (markup: string): HTMLElement => {
  const host = new El('div');
  host.innerHTML = markup;
  return host.firstElementChild as unknown as HTMLElement;
};

test('the Demo account surface wires all three exits without claiming Google sign-in', async (t) => {
  const dom = installPanelDom();
  t.after(() => dom.uninstall());
  const calls: string[] = [];
  mountAccountSurface({
    content: dom.app as unknown as HTMLElement, label: 'Demo mode', demo: true, make,
    onSwitch: () => { calls.push('switch'); },
    onSignOut: () => { calls.push('signout'); },
    onData: () => { calls.push('data'); },
  });
  assert.match(text(dom.app), /private Demo password/);
  assert.doesNotMatch(text(dom.app), /Signed in with Google/);
  await click(find(dom.app, '[data-switch]'));
  await click(find(dom.app, '[data-signout]'));
  await click(find(dom.app, '[data-data-settings]'));
  assert.deepEqual(calls, ['switch', 'signout', 'data']);
});
