import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adkConfigFromEnv, AdkConfigError, CREDENTIAL_PATTERN, DEFAULT_APP_NAME } from '../config.js';

/**
 * Config, and the one property that matters more than any of it: **no key
 * material reaches this layer.**
 *
 * The model credential is the `Llm` adapter's business and the adapter reads it
 * itself. An orchestration host that also read it would be a second place a key
 * lives, and the second place is the one that ends up in a log line. This is
 * checked by a machine rather than by remembering it, because the realistic
 * failure is one convenient field added in six months by somebody who has not
 * read this comment.
 */

const here = fileURLToPath(new URL('../../src/', import.meta.url));

function sources(): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) { if (entry !== '__tests__') walk(p); continue; }
      if (p.endsWith('.ts')) out.push(p);
    }
  };
  walk(here);
  return out;
}

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the guard is reading real sources', () => {
  const files = sources();
  assert.ok(files.length >= 5, `expected the workspace’s sources, found ${files.length}`);
  assert.ok(files.some((f) => f.endsWith('adk-binding.ts')), 'the binding is not being read');
});

test('no source in this workspace reads a credential from the environment', () => {
  /**
   * Stated as a pattern rather than a blocklist of names. A list of exact names
   * is a list the next credential is not on; the pattern catches
   * `GEMINI_API_KEY`, `GOOGLE_API_KEY`, anything `_SECRET`, `_TOKEN`,
   * `_PASSWORD` or `_CREDENTIALS`, and the ones nobody has invented yet.
   *
   * Prose is excluded, because this file and `config.ts` both discuss these
   * names at length and a guard that read its own explanation would fail on the
   * comment that explains why it exists.
   */
  const found: string[] = [];
  for (const file of sources()) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const m of code.matchAll(/['"]([A-Z][A-Z0-9_]{2,})['"]/g)) {
      const name = m[1] as string;
      // `CREDENTIAL_PATTERN`'s own definition lives in code, not a string, so
      // the only string literals matching here would be real variable names.
      if (CREDENTIAL_PATTERN.test(name)) found.push(`${file.slice(here.length)} names ${name}`);
    }
  }
  assert.deepEqual(found, [],
    'the orchestration layer holds no credentials — the adapter reads the key, and only the adapter');
});

test('the credential pattern catches what it claims to', () => {
  // The mutation check on the guard above. A pattern nobody tests is a pattern
  // that quietly matches nothing.
  for (const name of [
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY', 'OPENAI_API_KEY',
    'DB_PASSWORD', 'SESSION_SECRET', 'AUTH_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS',
  ]) {
    assert.ok(CREDENTIAL_PATTERN.test(name), `${name} should be caught`);
  }
  for (const name of [
    'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_GENAI_USE_VERTEXAI',
    'VIRGIL_ADK_APP_NAME', 'VIRGIL_ADK_SESSION_BACKEND', 'VIRGIL_ADK_ALLOW_NETWORK',
  ]) {
    assert.ok(!CREDENTIAL_PATTERN.test(name), `${name} is not a credential and must be readable`);
  }
});

test('an empty environment is a valid, offline, in-memory config', () => {
  // The default has to be the safe one. A layer that needs configuring before it
  // is safe is a layer that is unsafe on the machine where somebody forgot.
  const c = adkConfigFromEnv({});
  assert.equal(c.appName, DEFAULT_APP_NAME);
  assert.equal(c.sessionBackend, 'memory');
  assert.equal(c.allowNetwork, false);
  assert.equal(c.useVertex, false);
  assert.equal(c.project, null);
});

test('the network switch opens for exactly one value', () => {
  // A switch that opens on a truthy value opens on the string "false".
  assert.equal(adkConfigFromEnv({ VIRGIL_ADK_ALLOW_NETWORK: '1' }).allowNetwork, true);
  for (const v of ['0', 'false', 'true', 'yes', '', ' 1 ', 'TRUE']) {
    assert.equal(adkConfigFromEnv({ VIRGIL_ADK_ALLOW_NETWORK: v }).allowNetwork, false,
      `${JSON.stringify(v)} must not open the network`);
  }
});

test('an empty string is an absent variable, not a name', () => {
  // An unset variable in a shell script is very often an empty one, and an app
  // name of '' would namespace every session under nothing.
  assert.equal(adkConfigFromEnv({ VIRGIL_ADK_APP_NAME: '   ' }).appName, DEFAULT_APP_NAME);
});

test('an unrecognised session backend is refused rather than guessed', () => {
  assert.throws(
    () => adkConfigFromEnv({ VIRGIL_ADK_SESSION_BACKEND: 'firestore' }),
    (e: unknown) => e instanceof AdkConfigError && /not one of/.test(e.message),
  );
});

test('a backend that needs more than it was given says so before the run', () => {
  assert.throws(() => adkConfigFromEnv({ VIRGIL_ADK_SESSION_BACKEND: 'database' }), AdkConfigError);
  assert.throws(() => adkConfigFromEnv({ VIRGIL_ADK_SESSION_BACKEND: 'vertex' }), AdkConfigError);
  assert.doesNotThrow(() => adkConfigFromEnv({
    VIRGIL_ADK_SESSION_BACKEND: 'vertex',
    GOOGLE_CLOUD_PROJECT: 'virgil-dev',
    GOOGLE_CLOUD_LOCATION: 'us-central1',
  }));
});

test('a session URI with an inline password is refused, not redacted', () => {
  // Something redacted in one log line is printed in the next. The layer holds
  // no credentials, so the credential does not get to arrive and be handled.
  assert.throws(
    () => adkConfigFromEnv({
      VIRGIL_ADK_SESSION_BACKEND: 'database',
      VIRGIL_ADK_SESSION_URI: 'postgresql://virgil:hunter2@10.0.0.4/sessions',
    }),
    (e: unknown) => e instanceof AdkConfigError && /inline password/.test(e.message),
  );

  // And a URI without one is fine, so the check is not simply refusing everything.
  assert.doesNotThrow(() => adkConfigFromEnv({
    VIRGIL_ADK_SESSION_BACKEND: 'database',
    VIRGIL_ADK_SESSION_URI: 'postgresql:///sessions?host=/cloudsql/virgil:us-central1:db',
  }));
});

test('Vertex is opt-in by exact string, matching the pinned ADK bundle', () => {
  // `GOOGLE_GENAI_USE_VERTEXAI` is what the shipped package reads — verified
  // against the installed bundle, not assumed. Upstream is renaming it to
  // `GOOGLE_GENAI_USE_ENTERPRISE`; when that lands in a published version this
  // test is the thing that fails and says so.
  assert.equal(adkConfigFromEnv({ GOOGLE_GENAI_USE_VERTEXAI: 'true' }).useVertex, true);
  assert.equal(adkConfigFromEnv({ GOOGLE_GENAI_USE_VERTEXAI: 'TRUE' }).useVertex, true);
  assert.equal(adkConfigFromEnv({ GOOGLE_GENAI_USE_VERTEXAI: '1' }).useVertex, false);
  assert.equal(adkConfigFromEnv({}).useVertex, false);
});
