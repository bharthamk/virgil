#!/usr/bin/env node

/**
 * One-time operator bridge from a Desktop OAuth client to Secret Manager.
 *
 * The client JSON is read once from stdin and the refresh token is piped
 * straight to `gcloud secrets`; neither is printed or written to disk. The
 * browser receives only Google's consent URL. This is intentionally not a
 * learner-facing setup path—the hosted product uses the resulting managed
 * grant and keeps its foreground flow on the narrow drive.file scope.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

import { DRIVE_SCOPE, DriveTokens, LoopbackConsent } from '../runner/dist/drive-oauth.js';

const input = createInterface({ input: process.stdin, terminal: false });
if (process.stdin.isTTY) spawnSync('stty', ['-echo'], { stdio: 'inherit' });
const first = await input.question('');
if (process.stdin.isTTY) spawnSync('stty', ['echo'], { stdio: 'inherit' });
input.close();

const config = JSON.parse(first);
for (const key of ['clientId', 'clientSecret', 'account', 'project', 'secretName', 'runtimeSa']) {
  if (typeof config[key] !== 'string' || !config[key].trim()) {
    throw new Error(`missing ${key}`);
  }
}

const client = { clientId: config.clientId.trim(), clientSecret: config.clientSecret.trim() };
const consent = new LoopbackConsent({ client, clock: { now: () => new Date() } });
const started = await consent.start();
console.log(`consent-url ${started.url}`);
// LoopbackConsent deliberately unrefs its listener so a local service can exit
// cleanly. This one-shot process has no service listener, so keep it alive only
// until the browser returns.
const keepAlive = setInterval(() => {}, 1_000);
const grant = await consent.granted.finally(() => clearInterval(keepAlive));
if (!grant.scope.split(/\s+/).includes(DRIVE_SCOPE)) {
  throw new Error(`Google did not grant ${DRIVE_SCOPE}`);
}

const tokens = new DriveTokens({
  client: () => client,
  refreshToken: () => grant.refreshToken,
  clock: { now: () => new Date() },
});
const about = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
  headers: { authorization: `Bearer ${await tokens.accessToken()}` },
});
const body = await about.json();
const actualAccount = body?.user?.emailAddress;
if (!about.ok || typeof actualAccount !== 'string'
  || actualAccount.toLowerCase() !== config.account.trim().toLowerCase()) {
  throw new Error('the Google account that granted Drive access was not the configured Notebook account');
}

const secretPayload = JSON.stringify({
  type: 'authorized_user',
  account: actualAccount,
  client_id: client.clientId,
  client_secret: client.clientSecret,
  refresh_token: grant.refreshToken,
});

const run = (args, data = null) => new Promise((resolve, reject) => {
  const child = spawn('gcloud', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code) => code === 0
    ? resolve(stdout)
    : reject(new Error(stderr.trim() || `gcloud exited ${code}`)));
  if (data === null) child.stdin.end();
  else child.stdin.end(data);
});

let exists = true;
try {
  await run(['secrets', 'describe', config.secretName, '--project', config.project]);
} catch { exists = false; }
if (exists) {
  await run(['secrets', 'versions', 'add', config.secretName,
    '--data-file=-', '--project', config.project], secretPayload);
} else {
  await run(['secrets', 'create', config.secretName,
    '--replication-policy=automatic', '--data-file=-', '--project', config.project], secretPayload);
}
await run(['secrets', 'add-iam-policy-binding', config.secretName,
  '--member', `serviceAccount:${config.runtimeSa}`,
  '--role', 'roles/secretmanager.secretAccessor', '--project', config.project]);
console.log(`provisioned ${config.secretName} for ${actualAccount} with ${DRIVE_SCOPE}`);
