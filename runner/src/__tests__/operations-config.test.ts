import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

test('the live audit is read-only and blocks a split service/Job release', () => {
  const script = read('deploy/audit-live.sh');
  assert.match(script, /service and Job share immutable release tag/);
  assert.match(script, /anonymous board access is refused with 401/);
  assert.match(script, /runtime project IAM is exactly roles\/datastore\.user/);
  assert.match(script, /default compute service account has no project role/);
  assert.match(script, /unused legacy shared-secret versions are disabled/);
  assert.match(script, /never reads a secret payload and never changes Google Cloud/);
  assert.doesNotMatch(script, /gcloud\s+(?:run|projects|secrets|artifacts|firestore)[^\n]*\s(?:create|update|delete|destroy|add-iam-policy-binding)\b/);
});

test('monitoring is explicit, idempotent and bounded to the public health contract', () => {
  const script = read('deploy/observe.sh');
  assert.match(script, /require_confirmation/);
  assert.match(script, /displayName.*Virgil service health|UPTIME_NAME='Virgil service health'/);
  assert.match(script, /--path=\/health/);
  assert.match(script, /--matcher-content='"ok":true'/);
  assert.match(script, /--period=5/);
  assert.match(script, /--regions=usa-iowa,europe,asia-pacific/);
  assert.match(script, /--validate-ssl=true/);
  assert.match(script, /already exists/);
  assert.match(script, /no ALERT_CHANNELS supplied/);
  assert.match(script, /--set-notification-channels=/);
});

test('the runbook treats release rollback, data recovery and secret rotation separately', () => {
  const runbook = read('docs/OPERATIONS.md');
  assert.match(runbook, /Rollback is a pair, not a traffic-only action/);
  assert.match(runbook, /update-traffic virgil-service/);
  assert.match(runbook, /run jobs update virgil-nightly/);
  assert.match(runbook, /Never roll back Firestore data merely because code was rolled\s+back/);
  assert.match(runbook, /disable the previous version—do not destroy it yet/);
  assert.match(runbook, /Local Gemma connector/);
  assert.match(runbook, /expired or revoked grant/);
});
