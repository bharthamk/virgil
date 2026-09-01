import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OrchestratorSpecError, orchestratorChoice } from '../runtime.js';

/**
 * Which orchestration host runs the night, named rather than guessed.
 *
 * The orchestration dependency boundary said the ADK dependency is declared *"in the commit where the ADK
 * host becomes the nightly's real Cloud Run entrypoint"*. This is the grammar
 * that makes that sentence checkable: the deployed Job says which host it wants,
 * in a committed file, and a container that cannot read the answer refuses to
 * start rather than quietly running the other one.
 *
 * The idiom is `SB_STORE`'s, deliberately and line for line:
 *
 *  - **Unset is the old behaviour, byte for byte.** Every existing invocation in
 *    the README, the scripts and the artefacts keeps working, and a laptop gains
 *    no variable. That is what makes this safe before deployment.
 *  - **An unrecognised spec throws.** `SB_ORCHESTRATOR=adk ` with a typo falling
 *    back to the framework-free host would deploy happily, run every night
 *    without the framework, and report a green execution — and the one claim the
 *    deployment exists to support would be false with nothing to say so.
 *  - **It is never a silent fallback.** A host that is missing its package is a
 *    startup failure with a name in it, not a downgrade nobody notices.
 *
 * What it is NOT is a switch for whether the framework claim is true. The nine
 * stages build into a real ADK `SequentialAgent` under `adk-binding.test.ts`
 * whatever this variable says; this decides what the *deployed* night runs
 * inside.
 */

test('unset is the framework-free host, so nothing changes for a laptop', () => {
  assert.deepEqual(orchestratorChoice(undefined), { kind: 'local' });
  assert.deepEqual(orchestratorChoice(''), { kind: 'local' });
  assert.deepEqual(orchestratorChoice('   '), { kind: 'local' });
});

test('both hosts can be named, and naming the default is not the same as omitting it', () => {
  // Worth being able to say out loud. `deploy/service.yaml` names no host and
  // means it; a Job that names `local` has decided, and the two read
  // differently to whoever opens the file next.
  assert.deepEqual(orchestratorChoice('local'), { kind: 'local' });
  assert.deepEqual(orchestratorChoice('adk'), { kind: 'adk' });
  assert.deepEqual(orchestratorChoice('  adk  '), { kind: 'adk' });
});

test('a spec this build cannot host refuses, and says what it knows', () => {
  for (const bad of ['adk:1.6.0', 'ADK', 'google-adk', 'sequential', 'true', '1']) {
    assert.throws(() => orchestratorChoice(bad), OrchestratorSpecError,
      `SB_ORCHESTRATOR=${bad} was accepted — an unrecognised host must not fall back to the other one`);
  }
  assert.throws(() => orchestratorChoice('adk:1.6.0'), /Known: local, adk/);
});

test('the refusal is a config failure, which is the exit code that says do not retry', () => {
  // Same family as `StoreSpecError`: a Cloud Run Job that fails this way fails
  // its retries identically and the fix is in the YAML, not in this repository.
  const err = orchestratorChoice.length >= 0
    ? (() => { try { orchestratorChoice('nope'); return null; } catch (e) { return e; } })()
    : null;
  assert.ok(err instanceof OrchestratorSpecError);
  assert.match((err as Error).message, /SB_ORCHESTRATOR=nope/);
});
