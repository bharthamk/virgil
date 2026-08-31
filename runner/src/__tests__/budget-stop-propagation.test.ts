import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LlmRefused, emptyModelSpend, modelBudgetState,
  type Deps, type Llm, type ModelSpend,
} from '@sb/core';
import { adkConfigFromEnv, localHost, NIGHTLY_STAGES } from '@sb/adk';

import { ModelBudgetLedger, ModelBudgetStop, budgetedLlm } from '../model-budget.js';
import { runBatch } from '../pipeline.js';
import { HostedNightly } from '../hosted-nightly.js';
import { NOW, bench, generateBoard } from './batch-harness.js';


/** Refuses before anything is sent, the way the ledger's gate refuses. */
const refusing = (): Llm => ({
  complete: async () => { throw new StubStop(); },
  structured: async () => { throw new StubStop(); },
});

class StubStop extends LlmRefused {
  constructor() {
    super('your model budget stopped this before anything was sent');
    this.name = 'StubStop';
  }
}

const withLlm = (deps: Deps, llm: Llm): Deps => ({ ...deps, llm });

// -------------------------------------------------------------- the type tie

test('the kill switch is an instance of the seam’s own refusal', () => {
  const spent: ModelSpend = {
    since: NOW,
    connections: {
      ...emptyModelSpend().connections,
      cloud: { calls: 1, inputTokens: 1_000, outputTokens: 0, issuedNotReturned: 0 },
    },
  };
  const state = modelBudgetState(
    { limit: 1_000, unit: 'tokens', window: 'total', setAt: NOW }, spent,
  );
  const stop = new ModelBudgetStop('cloud', state);
  assert.ok(stop instanceof LlmRefused,
    'core/ cannot import this class, so the base type is the only thing an agent can test');
  assert.ok(stop instanceof Error, 'and it is still an error, for every catch that only knows that');
  assert.equal(stop.name, 'ModelBudgetStop', 'the specific name survives the subclassing');
  assert.equal(stop.connection, 'cloud');
});

// ------------------------------------------------------------ the plain lane

test('a refusal ends the run rather than degrading every stage in turn', async () => {
  const b = await bench('stop-plain', generateBoard(4, 2));

  await assert.rejects(
    runBatch(withLlm(b.deps, refusing()), { concurrency: 2 }),
    (err: unknown) => err instanceof LlmRefused,
    'the run resolved, which is what hid the stop behind a row of failed stages',
  );
});

test('an ordinary model failure still degrades stage by stage', async () => {
  // The property the fix must not cost. A night where one agent falls over is
  // still a night, and the run still comes back with everything else in it.
  const b = await bench('stop-plain-control', generateBoard(4, 2), { fail: ['analyse'] });

  const result = await runBatch(b.deps, { concurrency: 2 });

  assert.equal(result.reports.find((r) => r.stage === 'analyse')?.failed, true);
  assert.ok(result.reports.some((r) => r.stage === 'compose'), 'the run stopped at the failure');
});

test('the stop reaches the caller carrying the connection it happened on', async () => {
  // What `cli.ts` prints and what the panel reads both come off the error
  // itself, so a run that rejected with something generic would still leave
  // "raise the limit or reset the window" unsayable.
  const b = await bench('stop-plain-shape', generateBoard(4, 2));
  const store = b.store;
  const spend: ModelSpend = {
    since: NOW,
    connections: {
      ...emptyModelSpend().connections,
      cloud: { calls: 1, inputTokens: 5_000, outputTokens: 0, issuedNotReturned: 0 },
    },
  };
  await store.putPrefs({
    ...(await store.getPrefs()),
    modelBudget: { limit: 1_000, unit: 'tokens', window: 'total', setAt: NOW },
    modelSpend: spend,
  });
  const ledger = new ModelBudgetLedger({ store, clock: b.deps.clock });

  await assert.rejects(
    runBatch(withLlm(b.deps, budgetedLlm(b.deps.llm, ledger)), { concurrency: 2 }),
    (err: unknown) => err instanceof ModelBudgetStop
      && err.connection === 'cloud'
      && err.state.status === 'exhausted',
  );
});

// ----------------------------------------------------------- the hosted lane

test('a refusal inside a hosted stage still ends the run', async () => {
  /**
   * The lane where the throw does not come back to `pipeline.ts` at all.
   *
   * `HostedNightly` hands each stage body to an ADK child, and a body that
   * throws comes back as the host's own *resolved, failed* report — correct for
   * a degraded stage, and a refusal swallowed whole. Aborting the pipeline
   * instead is not available here: the framework asks for the next stage and
   * only the pipeline can hand it over, so a run that stopped in the middle
   * would hang rather than fail. The refusal is kept as it passes and raised
   * from `result()`, which is where `cli.ts` is already listening.
   */
  const b = await bench('stop-hosted', generateBoard(4, 2));
  const nightly = new HostedNightly(withLlm(b.deps, refusing()), NIGHTLY_STAGES, { concurrency: 2 });
  const host = await localHost(nightly.works, adkConfigFromEnv({}));

  nightly.start();
  await host.run({ onStage: (report) => nightly.accept(report) });

  await assert.rejects(
    nightly.result(),
    (err: unknown) => err instanceof LlmRefused,
    'the hosted run reported nine stages and never said which one nothing was sent on',
  );
});

test('the hosted host is still answered for the stage that refused', async () => {
  // The half that is easy to get wrong in the other direction. Every child must
  // still reach a report: a run stopped by starving the host of its next stage
  // is a hang, and a hang at 3am is worse than the swallow this replaces.
  const b = await bench('stop-hosted-answered', generateBoard(4, 2));
  const nightly = new HostedNightly(withLlm(b.deps, refusing()), NIGHTLY_STAGES, { concurrency: 2 });
  const host = await localHost(nightly.works, adkConfigFromEnv({}));

  nightly.start();
  const hosted = await host.run({ onStage: (report) => nightly.accept(report) });

  assert.equal(hosted.reports.length, NIGHTLY_STAGES.length,
    'every child ran to a report; the run stops at the pipeline, not by starving the host');
  await assert.rejects(nightly.result(), (err: unknown) => err instanceof LlmRefused);
});
