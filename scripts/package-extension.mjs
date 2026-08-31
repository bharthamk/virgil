#!/usr/bin/env node
/**
 * Build one self-hoster-owned, load-unpacked Virgil extension directory.
 *
 * This is deliberately an allowlist, not `cp -R extension`: source, tests,
 * hosted-page files and QA scaffolding are not browser runtime assets.
 *
 * Two passes resolve Google's real dependency order:
 *   1. without --google-extension-client-id, generate a stable manifest key
 *      and report the resulting extension id;
 *   2. create a Google OAuth client of type Chrome extension for that id, then
 *      rerun against the same --out with its client id. The key is reused.
 */
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const source = join(repo, 'extension');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token?.startsWith('--')) throw new Error(`Unexpected argument: ${token ?? ''}`);
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${token} needs a value`);
  args.set(token.slice(2), value);
  i += 1;
}

const serviceValue = args.get('service');
const outValue = args.get('out');
const chromeClientId = args.get('google-extension-client-id')?.trim() || null;
if (!serviceValue || !outValue) {
  throw new Error('Usage: npm run package:extension -- --service https://YOUR-SERVICE --out PATH [--google-extension-client-id ID]');
}

const service = serviceOrigin(serviceValue);
if (chromeClientId && !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(chromeClientId)) {
  throw new Error('--google-extension-client-id is not a Google OAuth client id');
}

const out = resolve(outValue);
if (out === parse(out).root || out === repo || out === source
  || source.startsWith(`${out}${sep}`) || out.startsWith(`${source}${sep}`)) {
  throw new Error('--out must be a separate package directory, never the repository or extension source');
}
mkdirSync(dirname(out), { recursive: true });

const existing = existingPackage(out);
const requestedKey = args.get('extension-key')?.trim() || null;
if (existing && requestedKey && requestedKey !== existing.key) {
  throw new Error('--extension-key cannot change the id of an existing Virgil package');
}
const key = requestedKey || existing?.key || generatedPublicKey();
const extensionId = idFromKey(key);

const stage = mkdtempSync(join(dirname(out), '.virgil-extension-'));
try {
  for (const file of [
    'action-popup.css', 'action-popup.html', 'panel.css', 'panel.html',
    'reread-content.js', 'selection-content.js', 'selector-content.js',
    'session-bridge-content.js',
  ]) copy(file, join(stage, file));
  for (const directory of ['assets', 'vendor']) {
    cpSync(join(source, directory), join(stage, directory), { recursive: true });
  }

  const distOut = join(stage, 'dist');
  mkdirSync(distOut);
  for (const file of readdirSync(join(source, 'dist'))) {
    if (!file.endsWith('.js')) continue;
    copy(join('dist', file), join(distOut, file));
  }

  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
  manifest.key = key;
  manifest.host_permissions = [
    `${service}/*`,
    'https://identitytoolkit.googleapis.com/*',
    'https://securetoken.googleapis.com/*',
  ];
  if (chromeClientId) {
    manifest.oauth2 = { client_id: chromeClientId, scopes: ['openid', 'email', 'profile'] };
  } else {
    delete manifest.oauth2;
  }
  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  replaceExactly(join(stage, 'dist/service.js'),
    "export const SERVICE = 'http://127.0.0.1:8791';",
    `export const SERVICE = ${JSON.stringify(service)};`);
  replaceExactly(join(stage, 'session-bridge-content.js'),
    "const DEFAULT_SERVICE = 'http://127.0.0.1:8791';",
    `const DEFAULT_SERVICE = ${JSON.stringify(service)};`);

  const metadata = {
    schema: 'virgil-extension-package-v1',
    extensionId,
    serviceOrigin: service,
    googleExtensionClientConfigured: chromeClientId !== null,
  };
  writeFileSync(join(stage, 'virgil-package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  if (!chromeClientId) {
    writeFileSync(join(stage, 'NEXT_STEP.txt'), [
      'This is the stable-ID preparation package, not the finished extension.',
      '',
      `Extension ID: ${extensionId}`,
      '',
      'In the same Google Cloud project, create an OAuth client of type Chrome extension',
      'for that exact extension ID. Then rerun the same package command against this',
      'same --out with --google-extension-client-id CLIENT_ID.',
      '',
    ].join('\n'));
  }

  assertPackage(stage, service, chromeClientId !== null);
  if (existsSync(out)) rmSync(out, { recursive: true });
  renameSync(stage, out);
} catch (error) {
  rmSync(stage, { recursive: true, force: true });
  throw error;
}

if (chromeClientId) {
  console.log(`Virgil extension ready: ${out}`);
  console.log(`Extension ID: ${extensionId}`);
  console.log(`Service: ${service}`);
} else {
  console.log(`Virgil extension preparation package: ${out}`);
  console.log(`Stable extension ID: ${extensionId}`);
  console.log(`Next: create a Chrome-extension OAuth client for that ID, then rerun with --google-extension-client-id.`);
}

function serviceOrigin(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('--service must be an absolute URL'); }
  const loopback = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !loopback) {
    throw new Error('--service must use HTTPS, except for loopback development');
  }
  if (parsed.username || parsed.password) throw new Error('--service must not contain credentials');
  return parsed.origin;
}

/** An existing destination is replaceable only when it proves it is ours. */
function existingPackage(path) {
  if (!existsSync(path)) return null;
  try {
    const metadata = JSON.parse(readFileSync(join(path, 'virgil-package.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'));
    const key = typeof manifest.key === 'string' && manifest.key ? manifest.key : null;
    if (metadata.schema !== 'virgil-extension-package-v1' || !key
      || metadata.extensionId !== idFromKey(key)) throw new Error('receipt mismatch');
    return { key };
  } catch {
    throw new Error('--out already exists and is not a valid Virgil extension package');
  }
}

function generatedPublicKey() {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

function idFromKey(value) {
  let der;
  try { der = Buffer.from(value, 'base64'); } catch { throw new Error('--extension-key is not base64'); }
  if (!der.length || der.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new Error('--extension-key is not canonical base64');
  }
  try { createPublicKey({ key: der, format: 'der', type: 'spki' }); }
  catch { throw new Error('--extension-key is not a DER public key'); }
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
}

function copy(from, to) {
  const input = join(source, from);
  if (!existsSync(input)) throw new Error(`Run npm run build first; missing ${relative(repo, input)}`);
  cpSync(input, to);
}

function replaceExactly(file, before, after) {
  const text = readFileSync(file, 'utf8');
  const count = text.split(before).length - 1;
  if (count !== 1) throw new Error(`${relative(repo, file)} has ${count} provisioning sentinels; expected 1`);
  writeFileSync(file, text.replace(before, after));
}

function assertPackage(root, origin, complete) {
  for (const forbidden of ['main.html', 'web.html', 'web-runtime.js', 'src', 'qa.html', 'tsconfig.json', 'tsconfig.tsbuildinfo']) {
    if (existsSync(join(root, forbidden))) throw new Error(`package carried forbidden ${forbidden}`);
  }
  if (readdirSync(join(root, 'dist')).some((file) => file.endsWith('.d.ts') || file === '__tests__')) {
    throw new Error('package carried compiler or test output');
  }
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  if (!manifest.host_permissions.includes(`${origin}/*`)) throw new Error('package cannot reach its service');
  if (complete !== Boolean(manifest.oauth2?.client_id)) throw new Error('package completion state disagrees with OAuth manifest');
}
