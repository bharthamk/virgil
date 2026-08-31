#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const lanes = [
  { name: 'core', lines: 90, branches: 85, functions: 90 },
  { name: 'adapters', lines: 80, branches: 80, functions: 70 },
  { name: 'runner', lines: 90, branches: 85, functions: 85 },
  // `panel.ts` is mounted through isolated DOM workers and reports a low V8
  // aggregate despite its 807 behavioural contracts. This is an honest floor,
  // not a target; the real-browser gate and room extraction are how it rises.
  { name: 'extension', lines: 20, branches: 30, functions: 18, heap: 6_144 },
  { name: 'adk', lines: 95, branches: 85, functions: 80 },
  { name: 'trigger', lines: 80, branches: 85, functions: 70 },
];

for (const lane of lanes) {
  const report = join(tmpdir(), `virgil-${lane.name}-coverage-${process.pid}.txt`);
  const args = [
    ...(lane.heap ? [`--max-old-space-size=${lane.heap}`] : []),
    '--test', '--experimental-test-coverage',
    '--test-reporter=spec', `--test-reporter-destination=${report}`,
    `--test-coverage-include=${lane.name}/dist/**/*.js`,
    '--test-coverage-exclude=**/__tests__/**',
    `--test-coverage-lines=${lane.lines}`,
    `--test-coverage-branches=${lane.branches}`,
    `--test-coverage-functions=${lane.functions}`,
    `${lane.name}/dist/__tests__/**/*.test.js`,
  ];
  try {
    execFileSync(process.execPath, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    console.log(`coverage ok: ${lane.name} >= lines ${lane.lines}, branches ${lane.branches}, functions ${lane.functions}`);
  } catch (error) {
    try {
      const lines = readFileSync(report, 'utf8').trim().split('\n');
      console.error(lines.slice(-80).join('\n'));
    } catch { /* The process failed before its reporter opened. */ }
    throw error;
  } finally {
    rmSync(report, { force: true });
  }
}
