import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderTenantSettings, type TenantMembershipView } from '../tenant-settings.js';
import {
  mountPinsFace, type PinSummary, type PinsFaceShell, type PinsLessonRoute,
} from '../pins-face.js';
import { button, click, find, installPanelDom, text, type El } from './panel-dom.js';

const response = (body: TenantMembershipView, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the owner sees members, inherited setup and a two-step removal', async (t) => {
  const dom = installPanelDom();
  t.after(dom.uninstall);
  const host = (globalThis.document as Document).createElement('div') as unknown as El;
  dom.app.append(host);
  const calls: { path: string; method: string }[] = [];
  const owner: TenantMembershipView = {
    role: 'owner', editable: true,
    members: ['owner@example.com', 'member@example.com'],
    sharedModelSetup: true, isolatedBoard: true,
  };
  const fetcher = async (path: string, init?: RequestInit): Promise<Response> => {
    calls.push({ path, method: init?.method ?? 'GET' });
    return response(init?.method === 'DELETE' ? { ...owner, members: ['owner@example.com'] } : owner);
  };
  assert.equal(await renderTenantSettings(host as unknown as HTMLElement, fetcher), true);
  assert.match(text(host), /People/);
  assert.match(text(host), /model connections and spend boundary/);
  assert.match(text(host), /separate private study board/);
  assert.match(text(host), /owner@example.comOwner/);
  assert.match(text(host), /member@example.comRemove/);

  const remove = button(host, 'Remove');
  await click(remove);
  assert.equal(calls.length, 1, 'the first press removed access instead of asking');
  assert.equal(text(remove), 'Confirm remove');
  await click(remove);
  assert.deepEqual(calls, [
    { path: '/tenant/members', method: 'GET' },
    { path: '/tenant/members', method: 'DELETE' },
  ]);
  assert.doesNotMatch(text(find(host, '.tenant-members')), /member@example.com/);
  assert.match(text(host), /board was not deleted/);
});

test('a member sees the shared setup fact but no other account list', async (t) => {
  const dom = installPanelDom();
  t.after(dom.uninstall);
  const host = (globalThis.document as Document).createElement('div') as unknown as El;
  dom.app.append(host);
  const member: TenantMembershipView = {
    role: 'member', editable: false, members: null,
    sharedModelSetup: true, isolatedBoard: true,
  };
  assert.equal(await renderTenantSettings(host as unknown as HTMLElement,
    async () => response(member)), true);
  assert.match(text(host), /model connections and spend boundary/);
  assert.match(text(host), /study board stays separate/);
  assert.doesNotMatch(text(host), /@example\.com/);
});

test('the owner can add a valid email through the People form', async (t) => {
  const dom = installPanelDom();
  t.after(dom.uninstall);
  const host = (globalThis.document as Document).createElement('div') as unknown as El;
  dom.app.append(host);
  const owner: TenantMembershipView = {
    role: 'owner', editable: true, members: ['owner@example.com'],
    sharedModelSetup: true, isolatedBoard: true,
  };
  const calls: { path: string; method: string; body?: string }[] = [];
  const fetcher = async (path: string, init?: RequestInit): Promise<Response> => {
    calls.push({ path, method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    return response(init?.method === 'POST'
      ? { ...owner, members: ['owner@example.com', 'person@example.com'] }
      : owner);
  };
  assert.equal(await renderTenantSettings(host as unknown as HTMLElement, fetcher), true);
  const input = find(host, 'input');
  input.value = ' Person@Example.com ';
  await find(host, 'form').fireEvent('submit');
  assert.deepEqual(calls, [
    { path: '/tenant/members', method: 'GET' },
    { path: '/tenant/members', method: 'POST', body: '{"email":"Person@Example.com"}' },
  ]);
  assert.match(text(host), /person@example\.com can now sign in/);
  assert.match(text(find(host, '.tenant-members')), /person@example\.comRemove/);
});

test('an unavailable membership service leaves Settings unchanged', async (t) => {
  const dom = installPanelDom();
  t.after(dom.uninstall);
  const host = (globalThis.document as Document).createElement('div') as unknown as El;
  dom.app.append(host);

  assert.equal(await renderTenantSettings(host as unknown as HTMLElement,
    async () => new Response('', { status: 503 })), false);
  assert.equal(host.children.length, 0);
  assert.equal(await renderTenantSettings(host as unknown as HTMLElement,
    async () => { throw new Error('offline'); }), false);
  assert.equal(host.children.length, 0);
});

test('failed owner changes explain that access did not move', async (t) => {
  const dom = installPanelDom();
  t.after(dom.uninstall);
  const owner: TenantMembershipView = {
    role: 'owner', editable: true,
    members: ['owner@example.com', 'member@example.com'],
    sharedModelSetup: true, isolatedBoard: true,
  };

  const removalHost = (globalThis.document as Document).createElement('div') as unknown as El;
  dom.app.append(removalHost);
  await renderTenantSettings(removalHost as unknown as HTMLElement, async (_path, init) => (
    init?.method === 'DELETE' ? new Response('', { status: 503 }) : response(owner)
  ));
  const remove = button(removalHost, 'Remove');
  await click(remove);
  await click(remove);
  assert.equal(remove.disabled, false);
  assert.equal(text(remove), 'Remove');
  assert.match(text(removalHost), /Nothing changed/);

  const addHost = (globalThis.document as Document).createElement('div') as unknown as El;
  dom.app.append(addHost);
  await renderTenantSettings(addHost as unknown as HTMLElement, async (_path, init) => (
    init?.method === 'POST' ? Promise.reject(new Error('offline')) : response(owner)
  ));
  const input = find(addHost, 'input');
  input.value = 'new@example.com';
  await find(addHost, 'form').fireEvent('submit');
  assert.equal(input.disabled, false);
  assert.equal(button(addHost, 'Add person').disabled, false);
  assert.match(text(addHost), /Nothing changed/);
});

const examplePin: PinSummary = {
  id: 'pin-1', type: 'interest', label: 'Gemma architecture',
  note: 'Compare the decoder and attention choices.'.repeat(8),
  capturedAt: '2026-08-31T00:00:00.000Z', topicId: null, topicLabel: null,
  status: 'new',
  source: {
    text: 'A detailed source passage about the model architecture. '.repeat(8),
    kind: 'selection', pageTitle: 'Gemma documentation',
    url: 'https://ai.google.dev/gemma/docs',
  },
};

const pinsShell = (overrides: Partial<PinsFaceShell> = {}): PinsFaceShell => ({
  read: async () => ({ kind: 'ok', body: { pins: [] } }),
  save: async () => ({ kind: 'ok', body: { id: 'saved', label: 'Saved' } }),
  remove: async () => ({ kind: 'ok', body: { ok: true } }),
  addToBoard: async () => ({ kind: 'ok', body: { ok: true, topicId: 'topic', label: 'Saved' } }),
  lessonRoute: async (): Promise<PinsLessonRoute> => ({ label: 'Gemini', readiness: 'ready' }),
  openModels: () => {}, learn: () => {}, board: () => {},
  routes: () => document.createElement('span'),
  ...overrides,
});

test('Pins stays useful when its read is unavailable and validates manual intake locally', async (t) => {
  const dom = installPanelDom();
  t.after(dom.uninstall);
  const host = document.createElement('div') as unknown as El;
  dom.app.append(host);
  let saves = 0;
  await mountPinsFace(host as unknown as HTMLElement, pinsShell({
    read: async () => ({ kind: 'unreachable' }),
    save: async () => { saves += 1; return { kind: 'unreachable' }; },
  }));
  assert.match(text(host), /could not open saved pins/);
  await click(button(host, 'Add pin'));
  const dialog = find(host, '[data-pins-dialog]');
  assert.equal(dialog.getAttribute('hidden'), null);
  await find(host, '[data-pins-intake]').fireEvent('submit');
  assert.match(text(host), /Add some text, a link, or an image first/);
  assert.equal(saves, 0);
  find(host, '[name="pin-url"]').value = 'javascript:alert(1)';
  await find(host, '[data-pins-intake]').fireEvent('submit');
  assert.match(text(host), /complete http:\/\/ or https:\/\//);
  assert.equal(saves, 0);
  await click(find(host, '[data-close-pin-intake]'));
  assert.equal(dialog.getAttribute('hidden'), '');
});

test('a saved pin exposes its source and recovers honestly from failed actions', async (t) => {
  const dom = installPanelDom();
  t.after(dom.uninstall);
  const host = document.createElement('div') as unknown as El;
  dom.app.append(host);
  let models = 0;
  let lessons = 0;
  await mountPinsFace(host as unknown as HTMLElement, pinsShell({
    read: async () => ({ kind: 'ok', body: { pins: [examplePin] } }),
    lessonRoute: async () => ({ label: 'Gemini', readiness: 'needs-setup' }),
    openModels: () => { models += 1; },
    learn: () => { lessons += 1; },
    addToBoard: async () => ({ kind: 'unreachable' }),
    remove: async () => ({ kind: 'refused', status: 503 }),
  }));
  const card = find(host, '.pins-item');
  assert.match(text(card), /Gemma architecture/);
  assert.match(text(card), /Gemma documentation/);
  assert.match(text(card), /Gemini · setup needed/);
  await click(button(card, 'Show more'));
  assert.equal(card.getAttribute('data-expanded'), 'true');
  await click(button(card, 'Show less'));
  assert.equal(card.getAttribute('data-expanded'), null);
  await click(button(card, 'Open Models'));
  assert.equal(models, 1);
  await click(button(card, 'Learn with Virgil'));
  assert.equal(lessons, 0);
  assert.match(text(card), /reconnect it before starting/);
  await click(button(card, 'Add to Board'));
  assert.match(text(card), /not reachable.*still waiting/);
  await click(find(card, '[data-remove]'));
  await click(button(card, 'Remove'));
  assert.match(text(card), /could not be removed.*still here/);
});
