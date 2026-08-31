import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUDGETED_CONNECTIONS, BUDGET_WARN_FRACTION, MAX_BUDGET_TOKENS,
  MODEL_BUDGET_UNIT, MODEL_BUDGET_WINDOW,
  addIssuedNotReturned, addLlmSpend, budgetStops, budgetedTokens, emptyModelSpend,
  isBudgetedConnection, isModelBudgetLimit, modelBudgetState, readModelBudget, readModelSpend,
  resetModelSpend, totalTokens,
  type ModelBudget, type ModelSpend,
} from '../index.js';

/**
 * The budget, as arithmetic.
 *
 * Everything here is a pure function of a stored limit and a stored count, and
 * that is the point: the guard in the runner and the endpoint that reports the
 * state both call these, so "your budget stopped this" and "you are at 92%"
 * cannot be computed two different ways and disagree in front of a learner.
 *
 * The boundary cases are the whole file. A kill switch that fires at 99% takes
 * work away that was paid for; one that fires at 101% is not a limit.
 */

const AT = '2026-08-19T03:00:00.000Z';
const LATER = '2026-08-20T09:00:00.000Z';

const budget = (limit: number, setAt = AT): ModelBudget => ({
  limit, unit: MODEL_BUDGET_UNIT, window: MODEL_BUDGET_WINDOW, setAt,
});

/** A window with one connection's numbers filled in. */
const spending = (
  over: Partial<Record<'cloud' | 'local' | 'cli', Partial<ModelSpend['connections']['cloud']>>>,
  since: string | null = AT,
): ModelSpend => {
  const base = emptyModelSpend();
  return {
    since,
    connections: {
      cloud: { ...base.connections.cloud, ...over.cloud },
      local: { ...base.connections.local, ...over.local },
      cli: { ...base.connections.cli, ...over.cli },
    },
  };
};

// ------------------------------------------------------------ what is guarded

test('the cloud connection is the guarded one, and it is the only one', () => {
  // The decision this whole feature rests on, written where it can be read.
  // Cloud is billed by Google; Ollama runs on the learner's own machine and the
  // Agent CLI is the operator's own harness. A spend limit that stopped the
  // free connections would take away the cheap option at the exact moment the
  // paid one ran out.
  assert.deepEqual([...BUDGETED_CONNECTIONS], ['cloud']);
  assert.equal(isBudgetedConnection('cloud'), true);
  assert.equal(isBudgetedConnection('local'), false);
  assert.equal(isBudgetedConnection('cli'), false);
});

test('only the guarded connection counts against the limit, and all three are shown', () => {
  const spend = spending({
    cloud: { calls: 2, inputTokens: 100, outputTokens: 50 },
    local: { calls: 9, inputTokens: 9_000, outputTokens: 9_000 },
    cli: { calls: 4, inputTokens: 400, outputTokens: 400 },
  });
  assert.equal(budgetedTokens(spend), 150, 'a free connection cannot spend a budget');
  assert.equal(totalTokens(spend), 18_950, 'and the display still sees everything that ran');
});

// --------------------------------------------------------- the state machine

test('no limit is not a limit of zero — nothing is stopped and nothing is implied', () => {
  const state = modelBudgetState(null, spending({ cloud: { inputTokens: 5_000 } }));
  assert.equal(state.status, 'off');
  assert.equal(state.limit, null);
  assert.equal(state.remaining, null, 'there is no remainder of a limit that does not exist');
  assert.equal(state.fraction, null);
  assert.equal(state.used, 5_000, 'the count is still honest about what has been spent');
  assert.equal(state.unit, 'tokens');
});

test('under four fifths is ok, four fifths is the warning, and the warning throttles nothing', () => {
  const under = modelBudgetState(budget(1_000), spending({ cloud: { inputTokens: 799 } }));
  assert.equal(under.status, 'ok');

  const at = modelBudgetState(budget(1_000), spending({ cloud: { inputTokens: 800 } }));
  assert.equal(at.status, 'warning', 'the flag is raised AT the fraction, not past it');
  assert.equal(at.warnAtFraction, BUDGET_WARN_FRACTION);
  assert.equal(at.fraction, 0.8);
  assert.equal(at.remaining, 200, 'and there is still budget to spend — a warning is not a stop');
});

test('the limit is reached AT the limit, and stays reached past it', () => {
  const exactly = modelBudgetState(budget(1_000), spending({ cloud: { inputTokens: 600, outputTokens: 400 } }));
  assert.equal(exactly.status, 'exhausted', 'a limit that only fires above itself is not a limit');
  assert.equal(exactly.remaining, 0);
  assert.equal(exactly.fraction, 1);

  const over = modelBudgetState(budget(1_000), spending({ cloud: { inputTokens: 4_000 } }));
  assert.equal(over.status, 'exhausted');
  assert.equal(over.remaining, 0, 'never negative — a learner is not shown a debt');
  assert.equal(over.fraction, 4);
});

test('one token short of the limit is still running', () => {
  const state = modelBudgetState(budget(1_000), spending({ cloud: { inputTokens: 999 } }));
  assert.equal(state.status, 'warning');
  assert.equal(state.remaining, 1);
});

test('input and output are summed, because both are billed', () => {
  const state = modelBudgetState(budget(100), spending({ cloud: { inputTokens: 60, outputTokens: 40 } }));
  assert.equal(state.used, 100);
  assert.equal(state.status, 'exhausted');
});

test('the state carries the window and the unit, so no surface has to guess', () => {
  const state = modelBudgetState(budget(500), emptyModelSpend());
  assert.equal(state.unit, 'tokens', 'this build has no price table; dollars would be invented');
  assert.equal(state.window, 'total');
  assert.equal(state.setAt, AT);
  assert.deepEqual([...state.guards], ['cloud']);
});

// ---------------------------------------------------------------- the switch

test('the switch stops the guarded connection and never the free ones', () => {
  const spent = spending({ cloud: { inputTokens: 1_000 } });
  assert.equal(budgetStops('cloud', budget(1_000), spent), true);
  assert.equal(budgetStops('local', budget(1_000), spent), false,
    'a local model costs nothing and must not be killed by a spend limit');
  assert.equal(budgetStops('cli', budget(1_000), spent), false);
});

test('a warning stops nothing at all', () => {
  assert.equal(budgetStops('cloud', budget(1_000), spending({ cloud: { inputTokens: 800 } })), false);
});

test('no budget stops nothing, however much has been spent', () => {
  assert.equal(budgetStops('cloud', null, spending({ cloud: { inputTokens: 10_000_000 } })), false);
});

// ------------------------------------------------------------- the recording

test('the window opens at the first thing recorded, and does not move afterwards', () => {
  const first = addLlmSpend(emptyModelSpend(), 'cloud', { inputTokens: 10, outputTokens: 5 }, AT);
  assert.equal(first.since, AT);
  const second = addLlmSpend(first, 'cloud', { inputTokens: 1, outputTokens: 1 }, LATER);
  assert.equal(second.since, AT, 'the window is when it opened, not when it was last written to');
  assert.equal(second.connections.cloud.calls, 2);
  assert.equal(budgetedTokens(second), 17);
});

test('a call is recorded against the connection it actually ran on', () => {
  const spend = addLlmSpend(emptyModelSpend(), 'local', { inputTokens: 900, outputTokens: 100 }, AT);
  assert.equal(spend.connections.local.calls, 1);
  assert.equal(spend.connections.cloud.calls, 0);
  assert.equal(budgetedTokens(spend), 0, 'and it did not spend a budget it cannot spend');
});

test('a provider that reports nonsense token counts cannot make the ledger unusable', () => {
  // The failure this guards: one NaN in the total makes every later comparison
  // against the limit false, and a kill switch that has silently stopped
  // killing is the one failure mode this feature must not have.
  const spend = addLlmSpend(
    emptyModelSpend(), 'cloud',
    { inputTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY }, AT,
  );
  assert.equal(spend.connections.cloud.calls, 1, 'the call still happened and is still counted');
  assert.equal(budgetedTokens(spend), 0);
  assert.equal(modelBudgetState(budget(10), spend).status, 'ok');
});

test('an issued request that never came back is counted and given no tokens', () => {
  // The usage-accounting contract: every issued request is presumed billed. Its size is
  // not known, and inventing one to charge against a learner's limit would be
  // worse than a visible count of calls nobody can price.
  const spend = addIssuedNotReturned(emptyModelSpend(), 'cloud', AT);
  assert.equal(spend.connections.cloud.issuedNotReturned, 1);
  assert.equal(spend.connections.cloud.calls, 0);
  assert.equal(budgetedTokens(spend), 0);
  assert.equal(spend.since, AT);
});

test('a reset opens a new window with nothing in the count the limit measures', () => {
  const spent = addLlmSpend(emptyModelSpend(), 'cloud', { inputTokens: 999, outputTokens: 1 }, AT);
  const fresh = resetModelSpend(LATER);
  assert.equal(budgetedTokens(spent), 1_000);
  assert.equal(budgetedTokens(fresh), 0);
  assert.equal(totalTokens(fresh), 0);
  assert.equal(fresh.since, LATER);
});

test('a reset clears the guarded connection and leaves the ones it never measured', () => {
  /*
   * Sam pressed a button described as zeroing a budget count that "is measured
   * against Cloud/API alone", and the record of what his own machine had done
   * went with it — permanently, with no confirmation and no undo. The window is
   * the budget's window, so it opens over the connections the budget guards.
   */
  const both = addLlmSpend(
    addLlmSpend(emptyModelSpend(), 'cloud', { inputTokens: 200, outputTokens: 112 }, AT),
    'local', { inputTokens: 5_200, outputTokens: 1_900 }, AT,
  );
  const fresh = resetModelSpend(LATER, both);

  assert.equal(budgetedTokens(fresh), 0, 'the count the limit is compared against starts again');
  assert.equal(fresh.connections.cloud.calls, 0);
  assert.deepEqual(fresh.connections.local, both.connections.local,
    'nobody asked for the free option’s receipt to be thrown away');
  assert.equal(totalTokens(fresh), 7_100);
  assert.equal(fresh.since, LATER);
});

// ------------------------------------------------- reading it back off a disk

test('a limit is a whole number of tokens inside a range a person could mean', () => {
  for (const good of [1, 1_000, MAX_BUDGET_TOKENS]) {
    assert.equal(isModelBudgetLimit(good), true, `${good} is a limit`);
  }
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_BUDGET_TOKENS + 1,
    '1000', null, undefined, {}, []]) {
    assert.equal(isModelBudgetLimit(bad), false, `${JSON.stringify(bad)} is not a limit`);
  }
});

test('a budget this build cannot read is read as no budget, and that fails open', () => {
  // The direction matters. A stored value this build does not understand is
  // not evidence that a learner asked for their model work to be halted, and
  // absence has always meant "nothing is being stopped".
  for (const bad of [
    null, undefined, 42, 'budget', [],
    { limit: 0, unit: 'tokens', window: 'total', setAt: AT },
    { limit: 100, unit: 'usd', window: 'total', setAt: AT },
    { limit: 100, unit: 'tokens', window: 'monthly', setAt: AT },
    { limit: 100, unit: 'tokens', window: 'total', setAt: 'whenever' },
    { limit: 100, unit: 'tokens', window: 'total' },
  ]) {
    assert.equal(readModelBudget(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(
    readModelBudget({ limit: 100, unit: 'tokens', window: 'total', setAt: AT, extra: 'ignored' }),
    budget(100), 'a field this build does not know does not throw the limit away');
});

test('a spend record with damage in it reads as zeroes rather than as a refusal', () => {
  const read = readModelSpend({
    since: AT,
    connections: {
      cloud: { calls: 3, inputTokens: 'lots', outputTokens: -5, issuedNotReturned: 1 },
      local: 'gone',
    },
  });
  assert.deepEqual(read.connections.cloud, {
    calls: 3, inputTokens: 0, outputTokens: 0, issuedNotReturned: 1,
  });
  assert.deepEqual(read.connections.local, {
    calls: 0, inputTokens: 0, outputTokens: 0, issuedNotReturned: 0,
  });
  assert.equal(read.since, AT, 'the window is not re-opened by a damaged count');
});

test('nothing stored at all is an empty window, not a crash', () => {
  for (const bad of [undefined, null, 'nope', 7, []]) {
    assert.deepEqual(readModelSpend(bad), emptyModelSpend(), JSON.stringify(bad));
  }
  assert.equal(readModelSpend(undefined).since, null);
});

test('a window read back is the window that was written', () => {
  const spend = addLlmSpend(
    addIssuedNotReturned(emptyModelSpend(), 'cli', AT),
    'cloud', { inputTokens: 12, outputTokens: 3 }, AT,
  );
  assert.deepEqual(readModelSpend(JSON.parse(JSON.stringify(spend))), spend);
});
