import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  allowedEmailsFrom, learnerAccessPolicy, memberEmail, ownerEmailFrom, requestsPerMinuteFrom,
  type TenantDirectorySnapshot,
} from '../access-policy.js';

test('the testing allowlist is normalized and rejects malformed configuration', () => {
  assert.deepEqual(allowedEmailsFrom(' Owner@Example.com,owner@example.com '), ['owner@example.com']);
  assert.throws(() => allowedEmailsFrom('not-an-address'));
  assert.equal(memberEmail(' New@Example.com '), 'new@example.com');
  assert.throws(() => memberEmail('not-an-address'));
  assert.equal(ownerEmailFrom(' Owner@Example.com ', []), 'owner@example.com');
  assert.equal(ownerEmailFrom(undefined, ['fallback@example.com']), 'fallback@example.com');
  assert.equal(requestsPerMinuteFrom(undefined), 120);
  assert.throws(() => requestsPerMinuteFrom('0'));
});

test('admission requires the allowed account and rate limits a verified uid', () => {
  const access = learnerAccessPolicy({ allowedEmails: ['owner@example.com'], requestsPerMinute: 10 });
  assert.equal(access.allows({ id: 'owner', email: 'OWNER@example.com' }), true);
  assert.equal(access.allows({ id: 'other', email: 'other@example.com' }), false);
  for (let i = 0; i < 10; i += 1) assert.equal(access.take('owner', 1_000).allowed, true);
  assert.equal(access.take('owner', 1_000).allowed, false);
  assert.equal(access.take('owner', 61_001).allowed, true);
});

test('only the owner can manage a durable member list', async () => {
  let snapshot: TenantDirectorySnapshot = {
    ownerEmail: 'owner@example.com', memberEmails: ['owner@example.com', 'member@example.com'],
  };
  const directory = {
    addMember: async (email: string) => (snapshot = {
      ...snapshot, memberEmails: [...new Set([...snapshot.memberEmails, email])],
    }),
    removeMember: async (email: string) => (snapshot = {
      ...snapshot, memberEmails: snapshot.memberEmails.filter((member) => member !== email),
    }),
  };
  const access = learnerAccessPolicy({
    ownerEmail: snapshot.ownerEmail,
    allowedEmails: snapshot.memberEmails,
    requestsPerMinute: 10,
    directory,
  });
  const owner = { id: 'owner', email: 'OWNER@example.com' };
  const member = { id: 'member', email: 'member@example.com' };
  assert.deepEqual(access.membership(owner), {
    role: 'owner', editable: true, members: ['owner@example.com', 'member@example.com'],
  });
  assert.deepEqual(access.membership(member), { role: 'member', editable: false, members: null });
  assert.equal(await access.addMember(member, 'new@example.com'), null);
  assert.ok(await access.addMember(owner, 'new@example.com'));
  assert.equal(access.allows({ id: 'new', email: 'new@example.com' }), true);
  assert.ok(await access.removeMember(owner, 'member@example.com'));
  assert.equal(access.allows(member), false);
});

test('simultaneous owner changes cannot leave the running allowlist behind Firestore', async () => {
  let snapshot: TenantDirectorySnapshot = {
    ownerEmail: 'owner@example.com', memberEmails: ['owner@example.com'],
  };
  let firstEntered!: () => void;
  let releaseFirst!: () => void;
  const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const directory = {
    addMember: async (email: string) => {
      calls += 1;
      if (calls === 1) { firstEntered(); await release; }
      snapshot = { ...snapshot, memberEmails: [...new Set([...snapshot.memberEmails, email])] };
      return snapshot;
    },
    removeMember: async () => snapshot,
  };
  const access = learnerAccessPolicy({
    ownerEmail: snapshot.ownerEmail, allowedEmails: snapshot.memberEmails,
    requestsPerMinute: 10, directory,
  });
  const owner = { id: 'owner', email: 'owner@example.com' };
  const first = access.addMember(owner, 'first@example.com');
  await entered;
  const second = access.addMember(owner, 'second@example.com');
  await Promise.resolve();
  assert.equal(calls, 1, 'the second write passed the unfinished first write');
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(access.allows({ id: 'first', email: 'first@example.com' }), true);
  assert.equal(access.allows({ id: 'second', email: 'second@example.com' }), true);
});
