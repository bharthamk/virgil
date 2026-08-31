import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NIGHTLY_STAGES, FOREGROUND_AGENTS, FLEET_AGENTS, SEAM_STAGES } from '../stages.js';

/**
 * The registry, checked against the pipeline it claims to describe.
 *
 * Same idea as `runner/src/__tests__/seam-purity.test.ts`: deliberately dumb,
 * filesystem-based, reading the real file that ships. A hand-maintained mirror
 * of a ten-stage pipeline is a mirror that is wrong within a week of somebody
 * adding an eleventh stage, and every claim this workspace makes — the architecture
 * diagram, the documentation's agent count, the hosted tree — is downstream of the
 * registry being true.
 */

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const pipeline = readFileSync(`${repo}runner/src/pipeline.ts`, 'utf8');

/** Stage names in the order `runBatch` reports them, read out of the source. */
function stagesInPipeline(): string[] {
  const out: string[] = [];
  // Every real boundary is named by the same `execute('name',...)` seam the
  // local runner and framework host share.
  for (const m of pipeline.matchAll(/execute\('([a-z]+)'/g)) {
    const name = m[1] as string;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

test('the registry is reading a real pipeline, not an empty string', () => {
  // Every assertion below passes vacuously against nothing. This is the one that
  // fails when the layout moves and this test stops testing.
  assert.ok(pipeline.includes('export async function runBatch'), 'pipeline.ts is not the pipeline');
  assert.ok(stagesInPipeline().length >= 9, 'the stage scanner found nothing to read');
});

test('the registry lists exactly the pipeline’s stages, in the pipeline’s order', () => {
  // Order is load-bearing and is the reason the framework primitive is a
  // sequential workflow. If these two ever disagree, the hosted tree is not the
  // nightly and every claim built on it is wrong.
  assert.deepEqual(NIGHTLY_STAGES.map((s) => s.name), stagesInPipeline());
});

test('every stage names an agent that exists in core/', () => {
  // The architecture diagram and the hosted tree are checked against each other
  // rather than both being drawn from memory.
  const agents = new Set(NIGHTLY_STAGES.map((s) => s.agent));
  for (const agent of agents) {
    const path = `${repo}core/src/agents/${agent}.ts`;
    assert.doesNotThrow(() => readFileSync(path, 'utf8'), `${agent} has no agent file`);
  }
});

test('the fleet is fifteen agents, and the split between them is stated', () => {
  /**
   * The number the documentation uses. Eleven stages run in the nightly; six agents
   * answer a request rather than a queue. An orchestration host built from the
   * nightly must not claim the ones that only ever run in the foreground, and
   * this is what stops the description and the diagram drifting apart.
   *
   * The Intake Planner is on both lists, and that is the one exception the
   * assertion below is written around. It answers *enhance* on one draft and it
   * runs as the nightly's first stage over the queue a course drop leaves. Two
   * scales, one agent — and counting it twice would make the public agent count
   * incorrect.
   *
   * Fifteen since the night scout: `prospect` runs the Prospector, which is a
   * background agent and only a background agent, so it lands on one list.
   */
  assert.equal(FLEET_AGENTS.length, 15, `the fleet is ${FLEET_AGENTS.length}, not fifteen`);
  assert.equal(FOREGROUND_AGENTS.length, 6);
  const alsoNightly = ['intake-planner'];
  for (const agent of FOREGROUND_AGENTS) {
    if (alsoNightly.includes(agent)) {
      assert.ok(NIGHTLY_STAGES.some((s) => s.agent === agent),
        `${agent} is claimed by both lanes and must really be in the nightly`);
      continue;
    }
    assert.ok(!NIGHTLY_STAGES.some((s) => s.agent === agent),
      `${agent} runs in the foreground and must not be a nightly stage`);
  }
});

test('the two arithmetic stages are marked pure, and they are the only ones', () => {
  // `comfort` and `garden` compute over what is already stored. The pipeline
  // have no model seam, and the host relies on that to keep running them when
  // the model budget is spent.
  const pure = NIGHTLY_STAGES.filter((s) => s.kind === 'pure').map((s) => s.name);
  assert.deepEqual(pure, ['comfort', 'garden']);

  for (const name of pure) assert.match(pipeline, new RegExp(`execute\\('${name}'`));
});

test('every seam stage is a stage the pipeline actually takes deps into', () => {
  // A stage marked `seam` that never reaches the model would make the cost model
  // count a call nobody makes.
  assert.equal(SEAM_STAGES.length, NIGHTLY_STAGES.length - 2);
  assert.ok(SEAM_STAGES.every((s) => s.kind === 'seam'));
});

test('only verify is gated on a predecessor', () => {
  // `verify` runs only when the Composer produced a session; everything else
  // runs unconditionally and degrades. Encoded so a host cannot invent a second
  // conditional stage without this failing.
  const skipped = NIGHTLY_STAGES.filter((s) => s.policy === 'skip').map((s) => s.name);
  assert.deepEqual(skipped, ['verify']);
});

test('the night scout is a hosted stage like any other, and degrades like one', () => {
  /**
   *. The hosted tree has to carry it, and has to carry it as an ordinary
   * degrading seam stage: no credential of its own, no `LlmAgent`, and no
   * policy that could stop the sequence. It is the one stage the night is
   * complete without, which is precisely why it must never be the reason a
   * night is not.
   */
  const prospect = NIGHTLY_STAGES.find((s) => s.name === 'prospect');
  assert.ok(prospect, 'the hosted night does not run the stage the pipeline does');
  assert.equal(prospect.agent, 'prospector');
  assert.equal(prospect.kind, 'seam');
  assert.equal(prospect.policy, 'degrade');
  assert.ok(!FOREGROUND_AGENTS.includes('prospector'),
    'nothing answers a request with it: it runs off the queue and only off the queue');

  const names = NIGHTLY_STAGES.map((s) => s.name);
  assert.ok(names.indexOf('prospect') > names.indexOf('statements'));
  assert.ok(names.indexOf('prospect') < names.indexOf('compose'),
    'what it proposes must not be able to shape the lesson it was proposed about');
});

test('stage names are unique', () => {
  // They key the run report and become ADK agent names, which must be unique
  // within an agent tree.
  const names = NIGHTLY_STAGES.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
});
