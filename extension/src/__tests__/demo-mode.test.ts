import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEMO_WORKSPACE_ID, accountMarkup, dataTransferMarkup, demoEntryRequested, loginToDemo,
  sharedDemoDataMarkup, signInMarkup, submitDemo,
} from '../demo-mode.js';
import { installChrome, jsonResponse } from './chrome-stub.js';

const RECEIPT = {
  active: true, dailyCloudTokens: 500_000, resets: '00:00 UTC',
  isolatedBoard: true, personalConnections: false,
  token: 'virgil-judge-v1.9999999999999.signature',
  expiresAt: Date.now() + 86_400_000, uid: DEMO_WORKSPACE_ID,
} as const;

test('Demo sign-in is a real password form with one submit control', () => {
  const markup = signInMarkup({ switching: false, demo: true, currentLabel: null });
  assert.match(markup, /<form[^>]+data-signin-form/);
  assert.match(markup, /data-judge-pass[^>]+type="password"/);
  assert.match(markup, /data-google type="submit"/);
  assert.match(markup, /autocomplete="off"/);
  assert.doesNotMatch(markup, /value=/, 'the Demo credential was rendered back into the page');
});

test('account copy separates the shared Demo session from an ordinary Google account', () => {
  const demo = accountMarkup(true);
  assert.match(demo.hero, /private Demo password/);
  assert.match(demo.access, /Leave Demo mode/);
  assert.match(demo.data, /shared Demo board/);
  const google = accountMarkup(false);
  assert.match(google.hero, /Signed in with Google/);
  assert.match(google.access, /Use another Google account/);
  assert.match(google.data, /permanent deletion/);
  assert.match(dataTransferMarkup(true), /Download this board/);
  assert.match(dataTransferMarkup(true), /data-choose-backup hidden/);
  assert.match(dataTransferMarkup(false), /Backup and restore/);
  assert.match(sharedDemoDataMarkup(), /one visit cannot erase another/);
});

test('the private query is inert unless this hosted deployment enabled Demo mode', () => {
  const root = globalThis as unknown as Record<string, unknown>;
  const beforeLocation = root['location'];
  const beforeConfig = root['__VIRGIL_WEB_CONFIG__'];
  try {
    root['location'] = { search: '?judge=1' };
    root['__VIRGIL_WEB_CONFIG__'] = { judgeDemoEnabled: false };
    assert.equal(demoEntryRequested('page'), false);
    root['__VIRGIL_WEB_CONFIG__'] = { judgeDemoEnabled: true };
    assert.equal(demoEntryRequested('page'), true);
    assert.equal(demoEntryRequested('panel'), false);
    root['location'] = { search: '?judge=0' };
    assert.equal(demoEntryRequested('page'), false);
  } finally {
    if (beforeLocation === undefined) delete root['location'];
    else root['location'] = beforeLocation;
    if (beforeConfig === undefined) delete root['__VIRGIL_WEB_CONFIG__'];
    else root['__VIRGIL_WEB_CONFIG__'] = beforeConfig;
  }
});

test('a valid Demo exchange stores only its opaque temporary session', async (t) => {
  const chrome = installChrome();
  t.after(() => chrome.uninstall());
  chrome.fetchHandler = (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { pass: 'private-demo-password-long-enough' });
    return jsonResponse(RECEIPT);
  };

  assert.deepEqual(await loginToDemo('private-demo-password-long-enough'), {
    kind: 'ok', uid: DEMO_WORKSPACE_ID,
  });
  assert.deepEqual(chrome.store.sb_session, {
    idToken: RECEIPT.token, refreshToken: '', expiresAt: RECEIPT.expiresAt,
    uid: DEMO_WORKSPACE_ID, email: null,
  });
});

test('a refused or unreachable Demo exchange stores no credential', async (t) => {
  const chrome = installChrome();
  t.after(() => chrome.uninstall());
  chrome.fetchHandler = () => jsonResponse({ error: 'no' }, 403);
  assert.deepEqual(await loginToDemo('wrong-password-that-is-long-enough'), { kind: 'refused' });
  assert.equal(chrome.store.sb_session, undefined);
  chrome.fetchHandler = () => { throw new Error('offline'); };
  assert.deepEqual(await loginToDemo('private-demo-password-long-enough'), { kind: 'unreachable' });
});

test('the Demo form refuses a short value before making a request', async () => {
  let focused = false;
  const input = { value: 'short', focus: () => { focused = true; } } as HTMLInputElement;
  const button = { disabled: false } as HTMLButtonElement;
  const refusal = { textContent: '' } as HTMLElement;
  assert.equal(await submitDemo(input, button, refusal), null);
  assert.equal(focused, true);
  assert.match(refusal.textContent ?? '', /supplied with the submission/);
});

test('the Demo form clears the password and returns the shared workspace only after success', async (t) => {
  const chrome = installChrome();
  t.after(() => chrome.uninstall());
  chrome.fetchHandler = () => jsonResponse(RECEIPT);
  const input = { value: 'private-demo-password-long-enough', focus: () => {} } as HTMLInputElement;
  const button = { disabled: false } as HTMLButtonElement;
  const refusal = { textContent: '' } as HTMLElement;
  assert.equal(await submitDemo(input, button, refusal), DEMO_WORKSPACE_ID);
  assert.equal(input.value, '');
  assert.equal(button.disabled, false);
  assert.equal(refusal.textContent, '');
});

test('the Demo form names a rejected and an unreachable password check separately', async (t) => {
  const chrome = installChrome();
  t.after(() => chrome.uninstall());
  const input = { value: 'wrong-password-that-is-long-enough', focus: () => {} } as HTMLInputElement;
  const button = { disabled: false } as HTMLButtonElement;
  const refusal = { textContent: '' } as HTMLElement;
  chrome.fetchHandler = () => jsonResponse({ error: 'no' }, 403);
  assert.equal(await submitDemo(input, button, refusal), null);
  assert.match(refusal.textContent ?? '', /not valid/);
  input.value = 'private-demo-password-long-enough';
  chrome.fetchHandler = () => { throw new Error('offline'); };
  assert.equal(await submitDemo(input, button, refusal), null);
  assert.match(refusal.textContent ?? '', /could not check/);
});
