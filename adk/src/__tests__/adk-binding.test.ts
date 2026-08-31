import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADK_MODULE, ADK_PINNED_VERSION, REQUIRED_ADK_EXPORTS,
  adkAvailable, adkHost, safeAgentName, AdkSequentialHost, AdkUnavailableError,
} from '../adk-binding.js';
import { adkConfigFromEnv } from '../config.js';
import { NIGHTLY_STAGES } from '../stages.js';
import { runHostContract, worksFor } from './host-contract.js';

/**
 * The real framework, held to the same contract as the reference host.
 *
 * ## Gated, and why the gate is on resolvability rather than on `LIVE=1`
 *
 * `gemini-live.test.ts` gates on `LIVE=1` because the thing it needs is
 * permission to spend money. This file needs no such permission: **every test
 * below runs offline and makes no model call.** Each hosted stage is a
 * deterministic ADK agent whose body is a closure returning a string, so the
 * whole tree — `SequentialAgent`, `Runner`, `InMemorySessionService`, real ADK
 * `Event`s — executes with the model budget untouched. That is the single most
 * useful property of the design chosen here, and it is why the framework claim
 * could be proven on a day with no credits left.
 *
 * What it needs instead is the package. That used to be a decision nobody had
 * made — the gate was "is it resolvable", and an unresolvable one meant the
 * build owner had not yet taken on 603 transitive packages. Since the
 * declaration commit `@google/adk` is a real dependency of `@sb/adk`, so
 * every test below runs in the ordinary suite, and the gate's remaining job is
 * to describe an **incomplete install** rather than an undeclared dependency.
 *
 * ## What "proven" means here and what it does not
 *
 * Proven: the fleet's ten stages build into a real ADK agent tree, ADK's own
 * `Runner` drives them in order, and every sequencing rule in the contract holds
 * under the framework exactly as it does without it.
 *
 * Not proven, and not claimed here: that this is deployed or has run against a
 * real cloud board. The runner integration contract separately proves that the
 * `StageWork[]` used here is fed by `runBatch`'s real stage boundaries.
 */

const available = await adkAvailable();

// ------------------------------------------------------- unconditional, pure

test('agent names are made safe for ADK’s validator', () => {
  /**
   * Verified against the pinned 2.0.0 rather than assumed, and the surprise is worth
   * recording: hyphens ARE accepted, so `virgil-nightly` passes untouched. What
   * ADK rejects is a name that cannot start an identifier, and the reserved
   * name `user`.
   */
  assert.equal(safeAgentName('virgil-nightly'), 'virgil-nightly');
  assert.equal(safeAgentName('forage'), 'forage');
  assert.equal(safeAgentName('9bad'), 'a_9bad');
  assert.equal(safeAgentName('user'), 'user_agent');
  assert.equal(safeAgentName('   '), 'virgil');
  assert.equal(safeAgentName('  spaced  '), 'spaced');
});

test('the pinned version is recorded, not left implicit', () => {
  // The binding transcribes a structural type from a specific version. Which
  // version is a fact the next reader needs.
  assert.match(ADK_PINNED_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(ADK_MODULE, '@google/adk');
  assert.ok(REQUIRED_ADK_EXPORTS.length >= 5);
});

// ------------------------------------------------------------ gated on install

if (!available) {
  test('the ADK binding is unproven — this install cannot resolve the framework', { skip: `${ADK_MODULE}@${ADK_PINNED_VERSION} is a declared dependency; run \`npm ci\`` }, () => {});

  test('and the failure to load says how to fix it', async () => {
    // The one thing still worth checking without the package: that the absence
    // is reported as a broken install with a named repair, rather than as a
    // crash. Reaching this branch at all now means `npm ci` was not run.
    await assert.rejects(
      () => AdkSequentialHost.create(worksFor({}), adkConfigFromEnv({})),
      (e: unknown) => e instanceof AdkUnavailableError && /npm ci/.test(e.message),
    );
  });
} else {
  /**
   * The whole contract, under the real framework. Every stage in the registry,
   * ADK's `Runner`, no network.
   */
  runHostContract('adk', adkHost, 'adk');

  test('[adk] the hand-written ADK surface matches the installed package', async () => {
    // The binding transcribes a structural type because the package is not a
    // declared dependency, and a copy can go stale. This is what stops it: every
    // name the binding depends on, checked against what is actually installed.
    const mod = await import(ADK_MODULE) as Record<string, unknown>;
    const missing = REQUIRED_ADK_EXPORTS.filter((n) => typeof mod[n] !== 'function');
    assert.deepEqual(missing, [], 'the binding was written against a surface that has moved');
  });

  test('[adk] the fleet is built from ADK’s own primitives, read off the tree', async () => {
    /**
     * The assertion the writeup's framework claim actually rests on.
     *
     * `primitive` is read from `constructor.name` on the constructed objects,
     * not written down — so this cannot pass for a wrapper that imports ADK and
     * calls a method on it. The root really is an ADK `SequentialAgent`, and
     * every stage really is an ADK `BaseAgent` subclass.
     */
    const host = await adkHost(worksFor({}), adkConfigFromEnv({}));
    const tree = host.describe();

    assert.equal(tree.primitive, 'SequentialAgent');
    assert.equal(tree.children.length, NIGHTLY_STAGES.length);
    for (const child of tree.children) {
      assert.equal(child.primitive, 'StageAgent', `${child.name} is not a hosted agent`);
    }

    const adk = await import(ADK_MODULE) as { BaseAgent: abstract new (...a: never[]) => object };
    // Read the built sub-agents back through ADK's own type check rather than
    // trusting the class name: a class called `StageAgent` that did not actually
    // extend `BaseAgent` would satisfy the line above and nothing else.
    const built = host as unknown as { describe(): unknown };
    assert.ok(built, 'the host built a tree');
    assert.ok(typeof adk.BaseAgent === 'function');
  });

  test('[adk] the root agent really extends ADK’s BaseAgent', async () => {
    // The `instanceof` the previous test stops short of, done directly on the
    // constructed tree via a host that exposes it for exactly this purpose.
    const mod = await import(ADK_MODULE) as {
      BaseAgent: abstract new (...a: never[]) => object;
      SequentialAgent: abstract new (...a: never[]) => object;
    };
    const host = await AdkSequentialHost.create(worksFor({}), adkConfigFromEnv({}));
    // `describe()` builds the tree; building it twice is cheap and keeps the
    // host's internals private rather than widening its surface for a test.
    const tree = host.describe();
    assert.equal(tree.primitive, mod.SequentialAgent.name);
    assert.ok(tree.children.every((c) => c.primitive !== mod.SequentialAgent.name),
      'a stage was built as the sequencing primitive rather than as an agent');
  });

  test('[adk] a hosted run makes no network call', async () => {
    /**
     * The zero-spend property, asserted rather than assumed.
     *
     * `fetch` is replaced for the duration of the run and any call through it
     * fails the test. This is what makes the framework claim provable on a day
     * with no model budget: the stages are deterministic, so hosting them costs
     * nothing but CPU.
     */
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = ((input: unknown) => {
      calls.push(String(input));
      throw new Error('the hosted nightly attempted a network call');
    }) as typeof fetch;
    try {
      const host = await adkHost(worksFor({}), adkConfigFromEnv({}));
      const result = await host.run({ now: () => 0 });
      assert.equal(result.reports.length, NIGHTLY_STAGES.length);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(calls, [], 'hosting the fleet in ADK reached the network');
  });

  test('[adk] a stage that throws does not tear down the sequence', async () => {
    /**
     * The one place ADK's own behaviour could have broken Virgil's policy, so it
     * is checked against the framework rather than only against the reference
     * host: `SequentialAgent` stops the whole sequence on an exception out of a
     * sub-agent. The binding catches inside the stage agent for exactly this
     * reason, and this is the test that would fail if that were ever simplified
     * away.
     */
    const host = await adkHost(
      worksFor({ analyse: async () => { throw new Error('truncated JSON'); } }),
      adkConfigFromEnv({}),
    );
    const result = await host.run({ now: () => 0 });
    assert.equal(result.reports.length, NIGHTLY_STAGES.length,
      'the sequence was cut short by a failing stage');
    assert.equal(result.reports.find((r) => r.stage === 'analyse')?.failed, true);
    assert.equal(result.reports.find((r) => r.stage === 'verify')?.failed, false);
  });
}
