import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adkConfigFromEnv, hostFactoryFor, localHost, NIGHTLY_STAGES } from '@sb/adk';
import { HostedNightly } from '../hosted-nightly.js';
import { bench, generateBoard } from './batch-harness.js';

test('the composition root gives the host the real nightly, whole', async () => {
  const b = await bench('hosted-real', generateBoard(4, 2));
  const nightly = new HostedNightly(b.deps, NIGHTLY_STAGES, { concurrency: 2 });
  const host = await localHost(nightly.works, adkConfigFromEnv({}));

  assert.deepEqual(
    host.describe().children.map((x) => x.name),
    NIGHTLY_STAGES.map((x) => x.name),
  );

  nightly.start();
  const hosted = await host.run({ onStage: (report) => nightly.accept(report) });
  const result = await nightly.result();

  assert.deepEqual(result.reports.map((x) => x.stage), NIGHTLY_STAGES.map((x) => x.name));
  assert.deepEqual(hosted.reports.map((x) => x.stage), result.reports.map((x) => x.stage));
  assert.equal(result.session?.outcome, 'composed');
  assert.ok(b.llm.countOf('compose') > 0, 'the hosted compose child did not run the real Composer');
  assert.ok(b.llm.countOf('verify') > 0, 'the hosted verify child did not run the real Verifier');
  assert.ok(await b.store.latestSession(), 'the hosted tree did not persist the real pipeline result');
});

test('one hosted model-stage failure degrades and the later children still execute', async () => {
  const b = await bench('hosted-degrade', generateBoard(4, 2), { fail: ['analyse'] });
  const nightly = new HostedNightly(b.deps, NIGHTLY_STAGES, { concurrency: 2 });
  const host = await localHost(nightly.works, adkConfigFromEnv({}));

  nightly.start();
  await host.run({ onStage: (report) => nightly.accept(report) });
  const result = await nightly.result();

  assert.equal(result.reports.find((x) => x.stage === 'analyse')?.failed, true);
  assert.ok(result.reports.some((x) => x.stage === 'garden'), 'the sequence stopped before pure planning');
  assert.ok(result.reports.some((x) => x.stage === 'verify'), 'the sequence stopped before verification');
});

test('ADK Runner drives every real pipeline body offline', async () => {
  const b = await bench('hosted-adk-real', generateBoard(4, 2));
  const nightly = new HostedNightly(b.deps, NIGHTLY_STAGES, { concurrency: 2 });
  const host = await (await hostFactoryFor('adk'))(nightly.works, adkConfigFromEnv({}));
  assert.equal(host.describe().primitive, 'SequentialAgent');
  assert.equal(host.describe().children.length, NIGHTLY_STAGES.length);

  nightly.start();
  await host.run({ onStage: (report) => nightly.accept(report) });
  const result = await nightly.result();

  assert.equal(result.reports.length, NIGHTLY_STAGES.length);
  assert.equal(result.session?.outcome, 'composed');
  assert.ok(await b.store.latestSession());
});
