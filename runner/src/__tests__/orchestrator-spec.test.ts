import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OrchestratorSpecError, orchestratorChoice } from '../runtime.js';


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
