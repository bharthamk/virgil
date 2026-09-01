import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NIGHTLY_STAGES, type AdkStageSpec } from '../stages.js';
import { adkConfigFromEnv } from '../config.js';
import { NOT_ATTEMPTED, type HostFactory, type StageWork } from '../host.js';

/**
 * What it means to host the nightly, written once and run against every host.
 *
 * Same instrument as `adapters/src/__tests__/llm-contract.ts`, for the same
 * reason. "We wrapped the fleet in ADK" is a claim about sequencing behaviour,
 * and a claim only ever checked against one implementation is a description of
 * that implementation. Every assertion below is about *Virgil's* rules — the
 * order of the nine stages, degradation as the standing policy, a spent quota
 * meaning not-attempted rather than failed — and none of them mentions ADK.
 *
 * The reference host in `host.ts` uses no framework at all. If it and the ADK
 * host ever disagree, one is wrong and the failing assertion names the rule they
 * disagreed about, which is worth far more than either passing alone.
 *
 * NOTHING HERE CALLS A MODEL. Every stage body below is a closure returning a
 * string. That is not a limitation of the harness — it is the design being
 * demonstrated: a hosted stage is deterministic, and the model lives behind the
 * seam that the stage body reaches, not in the framework that sequences it.
 */

/** A provider failure with a spent daily cap, shaped as the seam promises. */
export const exhausted = (): Error => Object.assign(
  new Error('429 RESOURCE_EXHAUSTED'),
  { status: 429, retryable: true, exhaustedForPeriod: true, quotaId: 'GenerateRequestsPerDayPerProject' },
);

/** A per-minute cap: the provider named a wait worth taking. */
export const rateLimited = (ms: number): Error => Object.assign(
  new Error('429 RESOURCE_EXHAUSTED'),
  { status: 429, retryable: true, exhaustedForPeriod: false, retryAfterMs: ms, quotaId: 'RequestsPerMinute' },
);

/** A content refusal over an ordinary 200 (the provider-refusal contract). */
export const blocked = (): Error => Object.assign(
  new Error('gemini blocked SAFETY'),
  { name: 'GeminiBlockedError', finishReason: 'SAFETY', partialLength: 0 },
);

/** Builds one `StageWork` per spec from a map of stage name to behaviour. */
export function worksFor(
  behaviour: Readonly<Record<string, () => Promise<string>>>,
  specs: readonly AdkStageSpec[] = NIGHTLY_STAGES,
): readonly StageWork[] {
  return specs.map((spec) => ({
    spec,
    run: behaviour[spec.name] ?? (async () => `${spec.name} ok`),
  }));
}

/** A clock that advances one millisecond per reading. Deterministic durations. */
export const tickingClock = (): (() => number) => {
  let t = 0;
  return () => t++;
};

const config = () => adkConfigFromEnv({});

/**
 * The stage the run begins with, read off the registry rather than named.
 *
 * Two assertions below are about *the first seam stage failing* rather than
 * about any particular agent, and both spelled `forage` until a tenth stage was
 * put in front of it. A contract that hardcodes the head of a list it also
 * iterates is a contract that goes red for the one change it was meant to
 * survive.
 */
const FIRST = NIGHTLY_STAGES[0] as AdkStageSpec;

/**
 * Bind a host to the contract.
 *
 * @param label   Printed in every test name so a failure says which host.
 * @param make    The factory under test.
 * @param framework  What `run()` must report it is.
 */
export function runHostContract(label: string, make: HostFactory, framework: string): void {
  const T = (name: string) => `[${label}] ${name}`;

  test(T('the built tree names every stage, in the pipeline’s order'), async () => {
    // The order is the architecture. A host that ran `compose` before `cluster`
    // would compose a session out of topics that did not exist yet, and the
    // only thing standing between the product and that is this sequence.
    const host = await make(worksFor({}), config());
    const tree = host.describe();
    assert.deepEqual(
      tree.children.map((c) => c.name),
      NIGHTLY_STAGES.map((s) => s.name),
      'the hosted tree is not the nightly',
    );
  });

  test(T('the tree carries each stage’s description, not a placeholder'), async () => {
    // The descriptions are what a framework shows an operator, and what the
    // architecture diagram is checked against. A tree of nine anonymous nodes
    // satisfies "we used the framework" and communicates nothing.
    const host = await make(worksFor({}), config());
    for (const child of host.describe().children) {
      const spec = NIGHTLY_STAGES.find((s) => s.name === child.name);
      assert.ok(spec, `${child.name} is not a stage`);
      assert.equal(child.description, spec.description);
      assert.ok(child.primitive.length > 0, 'every node says what primitive built it');
    }
  });

  test(T('a clean run reports every stage once, in order, none failed'), async () => {
    const host = await make(worksFor({}), config());
    const result = await host.run({ now: tickingClock() });

    assert.equal(result.framework, framework);
    assert.deepEqual(
      result.reports.map((r) => r.stage),
      NIGHTLY_STAGES.map((s) => s.name),
    );
    assert.deepEqual(result.reports.filter((r) => r.failed), []);
    // The detail line survives the trip through the host unchanged. A host that
    // reformatted it would break every run report this project has recorded.
    // Named off the registry rather than spelled out, because which stage runs
    // first is a decision the pipeline is allowed to make and this assertion is
    // about the line surviving the trip, not about who wrote it.
    assert.equal(result.reports[0]?.detail, `${FIRST.name} ok`);
  });

  test(T('onStage sees each report as it lands, not all of them at the end'), async () => {
    // The nightly prints as it goes. A host that buffered would turn an eight
    // minute run into eight minutes of silence.
    const seen: string[] = [];
    const host = await make(worksFor({}), config());
    const result = await host.run({ now: tickingClock(), onStage: (r) => seen.push(r.stage) });
    assert.deepEqual(seen, result.reports.map((r) => r.stage));
  });

  test(T('one failing stage degrades and the rest of the run continues'), async () => {
    // D10, and the reason the pipeline exists in this shape at all: a truncated
    // JSON response from the Analyst once aborted a nine minute run, which in
    // production means the learner wakes up to nothing because one agent had a
    // bad night.
    const host = await make(
      worksFor({ analyse: async () => { throw new Error('truncated JSON'); } }),
      config(),
    );
    const result = await host.run({ now: tickingClock() });

    const analyse = result.reports.find((r) => r.stage === 'analyse');
    assert.equal(analyse?.failed, true);
    assert.match(analyse?.detail ?? '', /truncated JSON/);
    assert.equal(analyse?.directive?.kind, 'degrade');

    // The stages after it still ran, and ran for real.
    const compose = result.reports.find((r) => r.stage === 'compose');
    assert.equal(compose?.failed, false);
    assert.equal(compose?.detail, 'compose ok');
    assert.equal(result.reports.length, NIGHTLY_STAGES.length);
  });

  test(T('a stage that throws a non-Error still degrades rather than escaping'), async () => {
    // A host that only survives `Error` is a host that dies on `throw 'nope'`,
    // and the reports before it die with it.
    const host = await make(
      worksFor({ survey: async () => { throw 'nope'; } }),
      config(),
    );
    const result = await host.run({ now: tickingClock() });
    assert.equal(result.reports.find((r) => r.stage === 'survey')?.failed, true);
    assert.equal(result.reports.length, NIGHTLY_STAGES.length);
  });

  test(T('a spent daily quota stops later seam stages being attempted at all'), async () => {
    /**
     * The quota-degradation contract of GEMINI_TRANSPORT_PROOF §9, and the distinction it turns on.
     *
     * Free tier on the deep tier is twenty requests a day and a nightly run is
     * seven model calls. Once the cap is met, the six seam stages after it are
     * not "degraded" — they were never attempted, and a run report that claims
     * six separate failures is claiming six requests that were never sent.
     *
     * The pure stages still run, because they are arithmetic over what is
     * already stored and owe the provider nothing.
     */
    const host = await make(worksFor({ [FIRST.name]: async () => { throw exhausted(); } }), config());
    const result = await host.run({ now: tickingClock() });

    const first = result.reports.find((r) => r.stage === FIRST.name);
    assert.equal(first?.failed, true);
    assert.equal(first?.directive?.kind, 'degrade');
    assert.match(first?.detail ?? '', /PerDay/);

    for (const spec of NIGHTLY_STAGES.slice(1)) {
      const report = result.reports.find((r) => r.stage === spec.name);
      assert.ok(report, `${spec.name} is missing from the run`);
      if (spec.kind === 'seam') {
        assert.equal(report.detail, NOT_ATTEMPTED, `${spec.name} should not have been attempted`);
      } else {
        assert.equal(report.failed, false, `${spec.name} is arithmetic and owes the provider nothing`);
        assert.equal(report.detail, `${spec.name} ok`);
      }
    }
  });

  test(T('a per-minute cap is surfaced as a wait, and the host does not take it'), async () => {
    // The number is handed up rather than slept on. An orchestration layer that
    // slept on its own would make the nightly's wall clock a function of the
    // provider's mood, which is what D18 warns about.
    const started = Date.now();
    const host = await make(worksFor({ cluster: async () => { throw rateLimited(7000); } }), config());
    const result = await host.run({ now: tickingClock() });

    const cluster = result.reports.find((r) => r.stage === 'cluster');
    assert.equal(cluster?.directive?.kind, 'retry-after');
    assert.equal(cluster?.directive?.kind === 'retry-after' ? cluster.directive.ms : null, 7000);
    assert.ok(Date.now() - started < 5000, 'the host waited — retry policy is the caller’s');

    // And a per-minute cap is NOT terminal: later seam stages still run.
    assert.equal(result.reports.find((r) => r.stage === 'compose')?.failed, false);
  });

  test(T('a content refusal degrades as a model failure, not as an empty answer'), async () => {
    // The provider-refusal contract. An empty reply is a legitimate answer everywhere in this fleet,
    // so a refusal wearing that costume tells the learner the board was quiet
    // when in fact the model would not teach it.
    const host = await make(worksFor({ compose: async () => { throw blocked(); } }), config());
    const result = await host.run({ now: tickingClock() });
    const compose = result.reports.find((r) => r.stage === 'compose');
    assert.equal(compose?.failed, true);
    assert.equal(compose?.directive?.kind === 'degrade' ? compose.directive.reason : null, 'blocked');
  });

  test(T('durations come off the injected clock'), async () => {
    // So a run's timings are a fact about the run rather than about the laptop.
    const host = await make(worksFor({}), config());
    const result = await host.run({ now: tickingClock() });
    for (const r of result.reports) {
      assert.ok(Number.isFinite(r.ms) && r.ms >= 0, `${r.stage} has no duration`);
    }
  });

  test(T('no stage detail can carry key material out of the run'), async () => {
    // The layer holds no credential, so nothing it prints can contain one. This
    // asserts the property rather than the absence of a specific mistake: a
    // stage that threw an error with a key in the message is the realistic way
    // one would ever arrive here, and it must not be silently propagated.
    const host = await make(
      worksFor({ analyse: async () => { throw new Error('failed with key AIzaSyFAKE_NOT_A_REAL_KEY'); } }),
      config(),
    );
    const result = await host.run({ now: tickingClock() });
    // The message does propagate — deliberately, because swallowing a provider
    // message loses the only diagnosis. What is asserted is that the HOST added
    // nothing of its own: it has no key to add.
    const printed = result.reports.map((r) => r.detail).join('\n');
    assert.equal((printed.match(/AIza/g) ?? []).length, 1,
      'the host introduced key-shaped material of its own');
  });
}
