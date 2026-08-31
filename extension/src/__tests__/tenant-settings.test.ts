import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderTenantSettings, type TenantMembershipView } from '../tenant-settings.js';
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
