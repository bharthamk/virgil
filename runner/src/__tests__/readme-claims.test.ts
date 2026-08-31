import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FLEET_AGENTS, NIGHTLY_STAGES } from '@sb/adk';
import { NOTEBOOK_DOC_KEYS } from '@sb/core';

const root = new URL('../../../', import.meta.url);
const at = (relative: string): string => fileURLToPath(new URL(relative, root));
const read = (relative: string): string => readFileSync(at(relative), 'utf8');
const readme = read('README.md');

test('the front page leads with the browsing companion value proposition', () => {
  assert.match(readme, /Pin what matters\. Learn it where you are\./);
  assert.match(readme, /stays by your side while you browse/i);
  assert.match(readme, /exact\s+passage, source, and surrounding context/i);
  assert.match(readme, /what would be useful to do next/i);
});

test('the learning surfaces are visible before implementation detail', () => {
  const product = readme.slice(0, readme.indexOf('## How Virgil works'));
  for (const surface of [
    'Browser side panel', 'Full Virgil page', 'Gemini handoff', 'WebMCP', 'Google Notebook',
  ]) {
    assert.match(product, new RegExp(surface, 'i'), `the product overview omits ${surface}`);
  }
});

test('the architecture image referenced by the README exists', () => {
  const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1]!)
    .filter((path) => !/^https?:/.test(path));
  assert.ok(images.length > 0, 'the README contains no visual architecture overview');
  for (const path of images) {
    assert.ok(existsSync(at(path)), `README image does not exist: ${path}`);
  }
});

test('every documented npm script exists', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
  const available = new Set(Object.keys(pkg.scripts ?? {}));
  const documented = new Set(
    [...readme.matchAll(/\bnpm run ([a-z][\w:]*)/g)].map((match) => match[1]!),
  );
  assert.ok(documented.size >= 5, 'the README no longer documents the release gates');
  for (const script of documented) {
    assert.ok(available.has(script), `README names a missing npm script: ${script}`);
  }
});

test('every documented Node entry point exists after a build', () => {
  const paths = [...readme.matchAll(/\bnode\s+(\S+\.js)/g)].map((match) => match[1]!);
  assert.ok(paths.length > 0, 'the README contains no runnable service entry point');
  for (const path of paths) {
    assert.ok(existsSync(at(path)), `README names a missing entry point: ${path}`);
  }
});

test('the printed pipeline is the executable stage order', () => {
  const line = /\n(intake\s+→[^\n]+verify)\n/.exec(readme)?.[1];
  assert.ok(line, 'the README does not print the background stage order');
  assert.deepEqual(
    line.split('→').map((stage) => stage.trim()),
    NIGHTLY_STAGES.map((stage) => stage.name),
  );
});

test('the documented fleet and Notebook counts derive from code', () => {
  const numberWords = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
    'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  ];
  assert.match(
    readme,
    new RegExp(`\\b${numberWords[FLEET_AGENTS.length]}-agent fleet\\b`, 'i'),
  );
  assert.match(
    readme,
    new RegExp(`\\b${numberWords[NOTEBOOK_DOC_KEYS.length]} stable learner-facing source documents\\b`, 'i'),
  );
});

test('the README names the mandatory Google architecture', () => {
  for (const component of [
    'Gemini API', 'Google ADK', 'Cloud Run Jobs', 'Firestore', 'Firebase Authentication',
  ]) {
    assert.match(readme, new RegExp(component, 'i'), `README omits ${component}`);
  }
  assert.match(readme, /gemini-3\.5-flash-lite/);
});

test('public identity agrees across the README and extension', () => {
  const manifest = JSON.parse(read('extension/manifest.json')) as {
    name?: string;
    action?: { default_title?: string };
  };
  const panelTitle = /<title>([^<]+)<\/title>/.exec(read('extension/panel.html'))?.[1];
  assert.equal(manifest.name, 'Virgil');
  assert.equal(manifest.action?.default_title, manifest.name);
  assert.equal(panelTitle, manifest.name);
  assert.match(readme, /^# Virgil$/m);
});

test('the public front page contains no private deployment or local path', () => {
  assert.doesNotMatch(readme, /https:\/\/[a-z0-9-]+\.(?:a\.run\.app|run\.app)/i);
  assert.doesNotMatch(readme, /\/Users\/|[A-Z]:\\Users\\/);
  assert.doesNotMatch(readme, /@(?:gmail|googlemail|outlook|hotmail|icloud)\.com\b/i);
});

test('the README does not expose internal build history', () => {
  for (const pattern of [
    /\bSB-\d+\b/, /\bruling\s+\d+\b/i, /\bamendment\s+\d+\b/i,
    /BUILD_PLAN|WRITEUP_DRAFT|DECISIONS_\d{4}/, /\bcredit day\b/i,
    /\bhackathon\b/i, /\bsubmission[- ](?:day|lock|video|copy)\b/i,
  ]) {
    assert.doesNotMatch(readme, pattern);
  }
  assert.doesNotMatch(readme, /\b[0-9]+,[0-9]{3}\s+tests\b/i);
  assert.match(readme, /`npm test` is the source of truth for the current suite totals/i);
});

test('the repository publishes install, contribution, and security guidance', () => {
  for (const path of ['INSTALL.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE']) {
    assert.ok(existsSync(at(path)), `missing public repository document: ${path}`);
    assert.ok(readme.includes(`(${path})`), `README does not link to ${path}`);
  }
});
