import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountScope } from '../account-scope.js';

test('same-account re-authentication preserves local drafts', () => {
  let clears = 0;
  const scope = new AccountScope(() => { clears += 1; });
  scope.adopt('learner-a');
  scope.adopt('learner-a');
  assert.equal(clears, 0);
  assert.equal(scope.owner, 'learner-a');
});

test('switching learner clears every account-scoped draft once', () => {
  let clears = 0;
  const scope = new AccountScope(() => { clears += 1; });
  scope.adopt('learner-a');
  scope.adopt('learner-b');
  assert.equal(clears, 1);
  assert.equal(scope.owner, 'learner-b');
});

test('sign out clears state and releases ownership', () => {
  let clears = 0;
  const scope = new AccountScope(() => { clears += 1; });
  scope.adopt('learner-a');
  scope.forget();
  assert.equal(clears, 1);
  assert.equal(scope.owner, null);
});
