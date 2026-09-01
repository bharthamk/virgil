import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CREDENTIAL_PATTERN, DEFAULT_LEASE, DEFAULT_SUBSCRIPTION, DEFAULT_TOPIC,
  TriggerConfigError, triggerConfigFromEnv,
} from '../config.js';

/**
 * The environment this layer reads, and the one thing it must never read.
 *
 * Same shape as `adk/src/__tests__/config.test.ts`, and the credential rule is
 * easier to keep here than there: against the emulator there is nothing to
 * authenticate to, and in production the client takes the job's service account
 * through Application Default Credentials, which is ambient to the runtime and
 * never a value this process holds.
 */

const MIN = { GOOGLE_CLOUD_PROJECT: 'virgil-local' } as const;

test('a project is required, because a trigger with none is a 3am failure', () => {
  assert.throws(() => triggerConfigFromEnv({}), TriggerConfigError);
  assert.equal(triggerConfigFromEnv(MIN).projectId, 'virgil-local');
  assert.equal(
    triggerConfigFromEnv({ ...MIN, PUBSUB_PROJECT_ID: 'emulator-proj' }).projectId, 'emulator-proj',
    'PUBSUB_PROJECT_ID wins — it is what the emulator docs set, and it is the more specific name');
});

test('the defaults are the topic and subscription the deploy commit will create', () => {
  const c = triggerConfigFromEnv(MIN);
  assert.equal(c.topic, DEFAULT_TOPIC);
  assert.equal(c.subscription, DEFAULT_SUBSCRIPTION);
  assert.equal(c.emulatorHost, null, 'nothing points at an emulator unless something says so');
});

test('the lease defaults are the ones an eight-minute job needs', () => {
  /**
   * A single ack deadline cannot exceed 600 seconds, so an eight-minute run is
   * held by the client's lease extension rather than by the deadline. These
   * three numbers are the whole of that arrangement and they are asserted so a
   * later edit has to mean it.
   *
   * <https://docs.cloud.google.com/pubsub/docs/subscription-properties>
   * <https://docs.cloud.google.com/pubsub/docs/lease-management>
   */
  const { lease } = triggerConfigFromEnv(MIN);
  assert.equal(lease.ackDeadlineSeconds, 600, 'the server maximum, so a dead subscriber does not release in 10s');
  assert.equal(lease.maxExtensionMinutes, 60, 'comfortably past eight minutes');
  assert.equal(lease.maxMessages, 1, 'one eight-minute night at a time');
  assert.deepEqual(lease, DEFAULT_LEASE);
});

test('an ack deadline outside Pub/Sub’s range is refused, not clamped', () => {
  /**
   * A deployment that asked for a 30-minute deadline has misunderstood how a
   * long job is covered. Silently giving it 600 seconds hides the
   * misunderstanding until the night that ran twice.
   */
  assert.throws(() => triggerConfigFromEnv({ ...MIN, VIRGIL_TRIGGER_ACK_DEADLINE_S: '1800' }), TriggerConfigError);
  assert.throws(() => triggerConfigFromEnv({ ...MIN, VIRGIL_TRIGGER_ACK_DEADLINE_S: '5' }), TriggerConfigError);
  assert.equal(triggerConfigFromEnv({ ...MIN, VIRGIL_TRIGGER_ACK_DEADLINE_S: '600' }).lease.ackDeadlineSeconds, 600);
});

test('the night rule is configurable and validated', () => {
  const c = triggerConfigFromEnv({
    ...MIN, VIRGIL_TRIGGER_NIGHT_TZ: 'Europe/London', VIRGIL_TRIGGER_NIGHT_BOUNDARY_H: '4',
  });
  assert.deepEqual(c.batchKey, { timeZone: 'Europe/London', boundaryHours: 4 });

  // A zone that is not a zone would otherwise be discovered by every night
  // being keyed to the wrong day, which is not a discovery anybody makes.
  assert.throws(() => triggerConfigFromEnv({ ...MIN, VIRGIL_TRIGGER_NIGHT_TZ: 'Mars/Olympus' }), TriggerConfigError);
  assert.throws(() => triggerConfigFromEnv({ ...MIN, VIRGIL_TRIGGER_NIGHT_BOUNDARY_H: '25' }), TriggerConfigError);
});

test('the undeliverable policy is one of two words, and defaults to the safe one', () => {
  assert.equal(triggerConfigFromEnv(MIN).onUndeliverable, 'ack');
  assert.equal(triggerConfigFromEnv({ ...MIN, VIRGIL_TRIGGER_ON_UNDELIVERABLE: 'nack' }).onUndeliverable, 'nack');
  assert.throws(() => triggerConfigFromEnv({ ...MIN, VIRGIL_TRIGGER_ON_UNDELIVERABLE: 'maybe' }), TriggerConfigError);
});

test('the emulator host is read from Google’s own variable', () => {
  // Not a `VIRGIL_` name. `PUBSUB_EMULATOR_HOST` is the client's contract with
  // itself — it is what makes the client skip authentication — and a second
  // name for it would mean the process and the client disagreed about where
  // they are.
  const c = triggerConfigFromEnv({ ...MIN, PUBSUB_EMULATOR_HOST: '127.0.0.1:8681' });
  assert.equal(c.emulatorHost, '127.0.0.1:8681');
});

test('no key material lives in this layer', () => {
  /**
   * A pattern rather than a list of names: a list of exact names is a list the
   * next credential is not on. The realistic failure is somebody adding one
   * convenient field in six months, so this reads the sources rather than
   * asserting an intention.
   */
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) { if (entry !== '__tests__') walk(p); continue; }
      if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(join(repo, 'trigger/src'));

  const found: string[] = [];
  for (const file of files) {
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // String literals only, the way `adk/src/__tests__/config.test.ts` does it.
    // An environment variable is read by name, and a name is a string; scanning
    // bare identifiers instead matches `DEFAULT_NIGHT_KEY_RULE` on the `_KEY_`
    // in the middle of it, which is a guard that fails on its own vocabulary.
    for (const m of code.matchAll(/['"]([A-Z][A-Z0-9_]{2,})['"]/g)) {
      if (CREDENTIAL_PATTERN.test(m[1] as string)) found.push(`${relative(repo, file)} names ${m[1]}`);
    }
  }
  assert.deepEqual(found, [],
    'the trigger holds no credential — the emulator needs none and production uses the job’s own identity');
});

test('the credential pattern catches the shapes it is meant to', () => {
  // The mutation check on the test above. A pattern nobody checks is a pattern
  // that quietly stops matching.
  for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DB_PASSWORD', 'AUTH_TOKEN', 'SOME_SECRET', 'GOOGLE_APPLICATION_CREDENTIALS']) {
    assert.ok(CREDENTIAL_PATTERN.test(name), `${name} should match`);
  }
  for (const name of ['PUBSUB_EMULATOR_HOST', 'GOOGLE_CLOUD_PROJECT', 'VIRGIL_TRIGGER_TOPIC']) {
    assert.ok(!CREDENTIAL_PATTERN.test(name), `${name} should not match`);
  }
});
