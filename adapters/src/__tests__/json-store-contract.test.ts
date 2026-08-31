import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../json-store.js';
import { MemoryStore } from './memory-store.js';
import { runStoreContract, type StoreSubject } from './store-contract.js';

/**
 * The local store, bound to the `Store` contract — twice.
 *
 * The second binding is the interesting one. It writes through one handle and
 * reads through a handle it opens fresh for every read, so every assertion in
 * the contract additionally proves the write reached disk rather than only the
 * object graph in memory.
 *
 * That is not a hypothetical distinction for the port. A Firestore
 * implementation has a genuine write boundary and a local one does not, so an
 * in-memory-first store passes the whole suite while persisting nothing — and
 * the symptom would be a learner whose board is empty every morning, reported
 * as "the nightly run did nothing".
 */

const path = (tag: string): string => join(mkdtempSync(join(tmpdir(), `sb-contract-${tag}-`)), 'db.json');

const sameHandle: StoreSubject = {
  name: 'JsonStore',
  create: async () => {
    const store = new JsonStore(path('same'));
    return { writer: store, reader: async () => store, dispose: async () => {} };
  },
};

const reopened: StoreSubject = {
  name: 'JsonStore reopened',
  create: async () => {
    const file = path('reopen');
    return {
      writer: new JsonStore(file),
      // A handle that has never loaded this file before. Nothing it answers can
      // have come from anywhere but the bytes on disk.
      reader: async () => new JsonStore(file),
      dispose: async () => {},
    };
  },
};

/**
 * The reference implementation, held to the same contract.
 *
 * A contract with one implementation is a description of that implementation.
 * `MemoryStore` shares no storage code with `JsonStore` — no file, no
 * temp-and-rename, no single-flight load — so whatever both satisfy is a product
 * rule rather than a habit of the local store, and the Firestore implementation
 * has an oracle to be checked against before it is checked against a bill.
 */
const reference: StoreSubject = {
  name: 'MemoryStore',
  create: async () => {
    const store = new MemoryStore();
    return { writer: store, reader: async () => store, dispose: async () => {} };
  },
};

runStoreContract(sameHandle);
runStoreContract(reopened);
runStoreContract(reference);
