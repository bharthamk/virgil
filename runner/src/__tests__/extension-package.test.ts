import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(repo, 'scripts/package-extension.mjs');
const CLIENT = '123456789-virgil-self-hosted.apps.googleusercontent.com';

const readJson = (path: string): Record<string, any> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

test('the two-stage package keeps one extension id and ships only browser runtime files', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'virgil-extension-package-'));
  t.after(() => { rmSync(temp, { recursive: true, force: true }); });
  const out = join(temp, 'virgil-extension');
  const base = ['--service', 'https://learner.example.test/path', '--out', out];

  const first = execFileSync(process.execPath, [script, ...base], { cwd: repo, encoding: 'utf8' });
  const prepared = readJson(join(out, 'manifest.json'));
  const preparedMeta = readJson(join(out, 'virgil-package.json'));
  assert.match(first, new RegExp(String(preparedMeta['extensionId'])));
  assert.equal(prepared.oauth2, undefined);
  assert.equal(preparedMeta['googleExtensionClientConfigured'], false);
  assert.deepEqual(prepared.host_permissions, [
    'https://learner.example.test/*',
    'https://identitytoolkit.googleapis.com/*',
    'https://securetoken.googleapis.com/*',
  ]);

  const otherOut = join(temp, 'different-id');
  execFileSync(process.execPath,
    [script, '--service', 'https://learner.example.test', '--out', otherOut],
    { cwd: repo, encoding: 'utf8' });
  const differentKey = String(readJson(join(otherOut, 'manifest.json'))['key']);
  assert.notEqual(differentKey, prepared.key);
  assert.throws(() => execFileSync(process.execPath,
    [script, ...base, '--extension-key', differentKey, '--google-extension-client-id', CLIENT],
    { cwd: repo, encoding: 'utf8', stdio: 'pipe' }),
  'finalising with a different key changed the id Google was told to trust');
  assert.equal(readJson(join(out, 'manifest.json'))['key'], prepared.key,
    'a refused final pass damaged the preparation package');

  const second = execFileSync(process.execPath,
    [script, ...base, '--google-extension-client-id', CLIENT], { cwd: repo, encoding: 'utf8' });
  const finished = readJson(join(out, 'manifest.json'));
  const finishedMeta = readJson(join(out, 'virgil-package.json'));
  assert.match(second, /extension ready/i);
  assert.equal(finished.key, prepared.key, 'finalising the package changed its Google-registered extension id');
  assert.equal(finishedMeta['extensionId'], preparedMeta['extensionId']);
  assert.equal(finished.oauth2.client_id, CLIENT);
  assert.equal(finishedMeta['googleExtensionClientConfigured'], true);

  const top = readdirSync(out).sort();
  for (const forbidden of ['main.html', 'web.html', 'web-runtime.js', 'src', 'qa.html']) {
    assert.ok(!top.includes(forbidden), `the browser package carried ${forbidden}`);
  }
  assert.ok(!readdirSync(join(out, 'dist')).some((file) => file.endsWith('.d.ts') || file === '__tests__'));
  assert.match(readFileSync(join(out, 'dist/service.js'), 'utf8'),
    /SERVICE = "https:\/\/learner\.example\.test"/);
  assert.match(readFileSync(join(out, 'session-bridge-content.js'), 'utf8'),
    /DEFAULT_SERVICE = "https:\/\/learner\.example\.test"/);
});

test('packaging refuses unsafe services, dangerous roots and unrelated existing output', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'virgil-extension-refusal-'));
  t.after(() => { rmSync(temp, { recursive: true, force: true }); });
  const unrelated = join(temp, 'family-photos');
  mkdirSync(unrelated);
  writeFileSync(join(unrelated, 'keep.txt'), 'not Virgil');

  for (const args of [
    ['--service', 'http://learner.example.test', '--out', join(tmpdir(), 'virgil-bad-package')],
    ['--service', 'https://learner.example.test', '--out', join(repo, 'extension')],
    ['--service', 'https://learner.example.test', '--out', '/'],
    ['--service', 'https://learner.example.test', '--out', unrelated],
  ]) {
    assert.throws(() => execFileSync(process.execPath, [script, ...args], {
      cwd: repo, encoding: 'utf8', stdio: 'pipe',
    }));
  }
  assert.equal(existsSync(join(unrelated, 'keep.txt')), true,
    'refusing an unrelated destination still deleted its contents');
});
