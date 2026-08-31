import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FirestoreStoreError, FirestoreTenantDirectory,
  type FsDocumentReference, type FsDocumentSnapshot, type FsFirestore,
} from '../index.js';

const memoryFirestore = (): FsFirestore => {
  const docs = new Map<string, Record<string, unknown>>();
  const ref = (path: string): FsDocumentReference => ({
    id: path.split('/').at(-1) ?? path,
    path,
    get: async (): Promise<FsDocumentSnapshot> => ({
      id: path, exists: docs.has(path), data: () => docs.get(path),
    }),
    set: async (data) => { docs.set(path, structuredClone(data)); },
    delete: async () => { docs.delete(path); },
    collection: (id) => collection(`${path}/${id}`),
  });
  const collection = (path: string): ReturnType<FsFirestore['collection']> => ({
    doc: (id) => ref(`${path}/${id}`),
    where() { return this; },
    get: async () => ({ size: 0, empty: true, docs: [] }),
  });
  return {
    collection,
    runTransaction: async (update) => update({
      get: (target) => target.get(),
      set: (target, data) => { void target.set(data); return undefined as never; },
    }),
    batch: () => { throw new Error('unused'); },
    recursiveDelete: async () => {},
    terminate: async () => {},
  };
};

test('the tenant directory bootstraps one owner and persists membership changes', async () => {
  const firestore = memoryFirestore();
  const directory = new FirestoreTenantDirectory({
    tenantId: 'tenant-one', ownerEmail: 'Owner@Example.com',
    initialMembers: ['member@example.com'], firestore,
  });
  assert.deepEqual(await directory.ensure(), {
    ownerEmail: 'owner@example.com', memberEmails: ['member@example.com', 'owner@example.com'],
  });
  assert.deepEqual((await directory.addMember('NEW@example.com')).memberEmails,
    ['member@example.com', 'new@example.com', 'owner@example.com']);
  assert.deepEqual((await directory.removeMember('member@example.com')).memberEmails,
    ['new@example.com', 'owner@example.com']);
  await assert.rejects(() => directory.removeMember('owner@example.com'),
    (error: unknown) => error instanceof FirestoreStoreError && error.kind === 'permission-denied');

  const reopened = new FirestoreTenantDirectory({
    tenantId: 'tenant-one', ownerEmail: 'owner@example.com',
    initialMembers: ['ignored@example.com'], firestore,
  });
  assert.deepEqual((await reopened.ensure()).memberEmails, ['new@example.com', 'owner@example.com']);
});

test('a changed deployment owner cannot take over an existing tenant directory', async () => {
  const firestore = memoryFirestore();
  await new FirestoreTenantDirectory({
    tenantId: 'tenant-one', ownerEmail: 'owner@example.com', firestore,
  }).ensure();
  await assert.rejects(() => new FirestoreTenantDirectory({
    tenantId: 'tenant-one', ownerEmail: 'other@example.com', firestore,
  }).ensure(), (error: unknown) =>
    error instanceof FirestoreStoreError && error.kind === 'permission-denied');
});
