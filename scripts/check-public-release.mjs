#!/usr/bin/env node
/** Fail closed on files and values that must not enter Virgil's public tree. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

const problems = [];
let candidates;
if (existsSync('.git')) {
  candidates = execFileSync(
    'git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' },
  ).split('\0').filter(Boolean).filter(existsSync);
} else {
  const receiptPath = 'virgil-source-package.json';
  if (!existsSync(receiptPath)) {
    throw new Error('public-release check needs a Git tree or a Virgil source-package receipt');
  }
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (!['virgil-source-package-v1', 'virgil-source-package-v2'].includes(receipt.schema)
      || !Array.isArray(receipt.files)
      || receipt.fileCount !== receipt.files.length) {
    throw new Error('Virgil source-package receipt has no complete file manifest');
  }
  const root = resolve('.');
  candidates = [];
  for (const entry of receipt.files) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      problems.push(`${receiptPath}: malformed file-manifest entry`);
      continue;
    }
    const target = resolve(root, entry.path);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      problems.push(`${receiptPath}: file path escapes the package`);
      continue;
    }
    if (!existsSync(target)) {
      problems.push(`${entry.path}: packaged file is missing`);
      continue;
    }
    candidates.push(entry.path);
    const actual = createHash('sha256').update(readFileSync(target)).digest('hex');
    if (actual !== entry.sha256) problems.push(`${entry.path}: differs from the source-package receipt`);
  }
}
const forbiddenPaths = [
  /^\.firebaserc$/,
  /(?:^|\/)(?:\.claude|\.anthropic)(?:\/|$)/i,
  /(?:^|\/)CLAUDE\.md$/i,
  /^\.data\/(?:\.virgil-secrets|learner-|usage-|.*\.log)/,
  /(?:^|\/)\.env(?:\.|$)/,
  /\.(?:pem|p12|pfx|key)$/i,
  /^deploy\/.*\.(?:plan|rendered)\.yaml$/,
  /^release\//,
];
for (const file of candidates) {
  if (forbiddenPaths.some((pattern) => pattern.test(file))) {
    problems.push(`${file}: forbidden release path`);
  }
}

const textExtensions = new Set([
  '', '.css', '.html', '.js', '.json', '.md', '.mjs', '.sh', '.ts', '.txt', '.yaml', '.yml',
]);
const allowedSecretFakes = new Set([
  'AIzaSyNotARealKey000000000000000000000000',
  'AIzaSyFAKE_NOT_A_REAL_KEY',
  'AIza-real-looking-test-key',
]);
const secretPatterns = [
  /AIza[0-9A-Za-z_-]{20,}/g,
  /AQ\.[0-9A-Za-z_-]{20,}/g,
  /sk-ant-[0-9A-Za-z_-]{12,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];
const agentOwnershipPatterns = [
  /(?:ANTHROPIC_API_KEY|CLAUDE_[A-Z0-9_]+)\s*[:=]/gi,
  /(?:Co-Authored-By|Signed-off-by):[^\n]*(?:Claude|Anthropic)/gi,
  /Generated (?:by|with)[^\n]*(?:Claude|Anthropic)/gi,
];
const internalProcessPatterns = [
  /\b(?:(?:rulings?|decisions?)[ -](?:#\s*)?\d+[a-z]?|amendments? \d+|credit day|BUILD_PLAN(?:\.md)?|submission video)\b/gi,
  /\bRuled\s+\d+\b/gi,
  /\bDecision-sheet item\s+\d+\b/gi,
  /\bcredit-day\b/gi,
  /\bRuling:/gi,
  /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+amendment\b/gi,
  /\b(?:ruling|decision)\s+(?:dated\s+|of\s+)?20\d{2}-\d{2}-\d{2}\b/gi,
];
for (const file of candidates) {
  if (!textExtensions.has(extname(file))) continue;
  const buffer = readFileSync(file);
  if (buffer.includes(0)) continue;
  const source = buffer.toString('utf8');
  for (const pattern of secretPatterns) {
    for (const match of source.matchAll(pattern)) {
      if (!allowedSecretFakes.has(match[0])) problems.push(`${file}: secret-shaped value`);
    }
  }
  // This file necessarily spells the patterns it enforces. Everything else in
  // the public package must remain free of agent-vendor ownership/config
  // residue; technical vendor names in boundary tests remain legitimate.
  if (file !== 'scripts/check-public-release.mjs') {
    for (const pattern of agentOwnershipPatterns) {
      if (pattern.test(source)) problems.push(`${file}: agent ownership or credential marker`);
      pattern.lastIndex = 0;
    }
    for (const pattern of internalProcessPatterns) {
      if (pattern.test(source)) problems.push(`${file}: internal build-decision marker`);
      pattern.lastIndex = 0;
    }
  }
  if (/@(?:gmail|googlemail)\.com\b/i.test(source)) problems.push(`${file}: personal email address`);
}

if (existsSync('.git')) {
  const records = execFileSync('git', [
    'log', '--all', '--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e',
  ], { encoding: 'utf8' }).split('\x1e').filter((record) => record.trim());
  for (const record of records) {
    const [hash = 'unknown', author = '', authorEmail = '', committer = '', committerEmail = '', body = ''] =
      record.split('\x1f');
    if ([author, authorEmail, committer, committerEmail].some((value) => /claude|anthropic/i.test(value))) {
      problems.push(`${hash.trim()}: agent vendor appears in Git author or committer identity`);
    }
    if (/(?:Co-Authored-By|Signed-off-by):[^\n]*(?:Claude|Anthropic)/i.test(body)
        || /Generated (?:by|with)[^\n]*(?:Claude|Anthropic)/i.test(body)) {
      problems.push(`${hash.trim()}: agent vendor appears in Git ownership metadata`);
    }
  }
}

const corpora = new Map();
for (const [corpus, expectedCount] of [
  ['scripts/eval-pins.json', 21],
  ['scripts/real-pins.json', 50],
  ['scripts/scale-pins.json', 80],
]) {
  const pins = JSON.parse(readFileSync(corpus, 'utf8'));
  corpora.set(corpus, pins);
  if (pins.length !== expectedCount) {
    problems.push(`${corpus}: expected ${expectedCount} authored pins, found ${pins.length}`);
  }
  if (pins.some((pin) => new URL(pin.url).hostname !== 'example.invalid')) {
    problems.push(`${corpus}: corpus must use authored example.invalid sources only`);
  }
}
const realExpected = JSON.parse(readFileSync('scripts/real-expected.json', 'utf8'));
const realPins = corpora.get('scripts/real-pins.json') ?? [];
if (realExpected.length !== 50
    || JSON.stringify(realExpected.map((row) => row.id)) !== JSON.stringify(realPins.map((pin) => pin.id))) {
  problems.push('scripts/real-expected.json: expected-label joins do not match the 50-pin corpus');
}
if (existsSync('runner/src/seed/selections.json')) {
  problems.push('runner/src/seed/selections.json: captured-page overlay must stay absent');
}

const demo = JSON.parse(readFileSync('.data/store.json', 'utf8'));
const demoOrder = JSON.parse(readFileSync('.data/seed-pin-order.json', 'utf8'));
const authoredSeed = corpora.get('scripts/eval-pins.json') ?? [];
const demoPins = Array.isArray(demo.pins) ? demo.pins : [];
const demoById = new Map(demoPins.map((pin) => [pin.id, pin]));
if (demoPins.length !== 21 || demoOrder.length !== 21 || new Set(demoOrder).size !== 21) {
  problems.push('.data: demonstration board must retain one ordered record for each of 21 authored pins');
} else {
  for (const [index, id] of demoOrder.entries()) {
    const pin = demoById.get(id);
    const authored = authoredSeed[index];
    const envelope = pin?.envelope;
    const authoredSurrounding = authored?.surrounding?.replace(
      / Synthetic fixture marker: [a-z0-9-]+\.$/, '',
    );
    const matches = pin && authored && pin.type === authored.type
      && envelope?.selection === authored.selection
      && envelope?.surroundingText === authoredSurrounding
      && JSON.stringify(envelope?.headingPath) === JSON.stringify(authored.headings)
      && envelope?.pageTitle === `${authored.title} — synthetic demo`
      && (pin.note ?? null) === (authored.note ?? null);
    if (!matches) {
      problems.push(`.data/store.json: demo pin ${index + 1} does not match its authored seed`);
      break;
    }
  }
}
for (const pin of demo.pins ?? []) {
  if (new URL(pin.envelope.url).hostname !== 'example.invalid') {
    problems.push('.data/store.json: demo capture points at a live external source');
    break;
  }
  for (const reference of pin.enrichment?.references ?? []) {
    if (reference.url && new URL(reference.url).hostname !== 'example.invalid') {
      problems.push('.data/store.json: demo provenance points at a live external source');
      break;
    }
  }
}

if (problems.length) {
  console.error(`public-release check failed (${problems.length})`);
  for (const problem of [...new Set(problems)].sort()) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`public-release check clean: ${candidates.length} release-candidate files; synthetic corpora and demo board verified`);
