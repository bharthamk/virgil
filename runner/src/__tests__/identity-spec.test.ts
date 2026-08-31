/**
 * `SB_AUTH`, and the one thing it must never let happen by accident.
 *
 * The emulator form accepts unsigned tokens, which is correct locally and is an
 * authentication bypass in a deployed estate. The learner-identity contract builds against the
 * emulator on purpose, so the guard is not "never" — it is "not there".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityChoice, identityIsSafeHere, IdentitySpecError } from '../runtime.js';

test('unset is the single-board service, which is what a local install is', () => {
  // No default multi-tenancy. A service that silently started requiring tokens
  // would break every local install, and one that silently stopped is worse.
  assert.deepEqual(identityChoice(undefined), { kind: 'none' });
  assert.deepEqual(identityChoice(''), { kind: 'none' });
  assert.deepEqual(identityChoice('  '), { kind: 'none' });
  assert.deepEqual(identityChoice('none'), { kind: 'none' });
});

test('a project verifies signatures against Google', () => {
  assert.deepEqual(identityChoice('firebase:virgil-506009'),
    { kind: 'firebase', projectId: 'virgil-506009', emulatorHost: null });
});

test('the emulator is named explicitly, never sniffed from the environment', () => {
  // FIREBASE_AUTH_EMULATOR_HOST being set by accident in a deployed
  // environment would turn signature checking off. Accepting unsigned tokens
  // is a thing this process is TOLD to do, in a committed file.
  assert.deepEqual(identityChoice('firebase:virgil-506009@127.0.0.1:9099'),
    { kind: 'firebase', projectId: 'virgil-506009', emulatorHost: '127.0.0.1:9099' });
});

test('a spec that names no project is refused, because it would check nothing', () => {
  assert.throws(() => identityChoice('firebase:'), IdentitySpecError);
  assert.throws(() => identityChoice('firebase'), IdentitySpecError);
});

test('a half-written emulator spec is refused rather than half-honoured', () => {
  assert.throws(() => identityChoice('firebase:@127.0.0.1:9099'), IdentitySpecError);
  assert.throws(() => identityChoice('firebase:proj@'), IdentitySpecError);
});

test('a provider this build cannot reach is named rather than ignored', () => {
  assert.throws(() => identityChoice('auth0:whatever'), /Known: none, firebase/);
});

// ------------------------------------------------------- the deployed guard

test('the emulator on Cloud Run is refused, with the variable named', () => {
  const choice = identityChoice('firebase:virgil-506009@127.0.0.1:9099');
  const verdict = identityIsSafeHere(choice, { K_SERVICE: 'virgil-service' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.reason : '', /SB_AUTH/);
  assert.match(verdict.ok === false ? verdict.reason : '', /unsigned/);
});

test('the emulator off Cloud Run is exactly how the learner-identity contract says to build', () => {
  const choice = identityChoice('firebase:virgil-506009@127.0.0.1:9099');
  assert.deepEqual(identityIsSafeHere(choice, {}), { ok: true });
});

test('signed verification is safe everywhere, which is the point of it', () => {
  const choice = identityChoice('firebase:virgil-506009');
  assert.deepEqual(identityIsSafeHere(choice, { K_SERVICE: 'virgil-service' }), { ok: true });
  assert.deepEqual(identityIsSafeHere(choice, {}), { ok: true });
});

test('no identity at all is not something the deployed guard has an opinion on', () => {
  // Whether a deployed service SHOULD require identity is a different question
  // from whether it may accept unsigned tokens, and conflating them here would
  // make this guard the place multi-tenancy is decided.
  assert.deepEqual(identityIsSafeHere({ kind: 'none' }, { K_SERVICE: 'x' }), { ok: true });
});
