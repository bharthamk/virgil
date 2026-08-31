import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { REREAD_CANDIDATE, REREAD_PREFS, boot } from '../reread-bridge.js';
import type { RereadCandidate } from '../reread.js';

/**
 * The wiring that took the detector from written to running , and the
 * manifest entries without which it silently does not.
 *
 * Two different kinds of risk live here. The bridge decides whether to observe
 * at all and what leaves the page, which is a judgement and is tested as one.
 * The manifest is a list of filenames, and a wrong one fails at runtime on a
 * real page and nowhere else — no compiler, no test and no type sees it — so it
 * is checked against the module graph it has to cover.
 */

// ------------------------------------------------------------------ the bridge

interface Started { quieted: boolean; onCandidate: (c: RereadCandidate) => void }

function harness(reply: unknown | Error): {
  sent: unknown[];
  started: Started[];
  run: () => Promise<() => void>;
} {
  const sent: unknown[] = [];
  const started: Started[] = [];
  const send = async (message: unknown): Promise<unknown> => {
    sent.push(message);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const start = (onCandidate: (c: RereadCandidate) => void, opts: { quieted: boolean }): (() => void) => {
    started.push({ quieted: opts.quieted, onCandidate });
    return () => {};
  };
  return { sent, started, run: () => boot(send, start, 'https://docs.example.test') };
}

const candidate: RereadCandidate = {
  passage: 'Session state is held per user, per app.',
  url: 'https://docs.example.test/adk/sessions',
  pageTitle: 'ADK — Sessions',
  headingPath: ['ADK', 'Sessions'],
  returnCount: 3,
  dwellMs: 9000,
  reason: 'You came back to this 3 times.',
};

test('the detector asks whether it is welcome here before it observes anything', async () => {
  const h = harness({ quieted: false });
  await h.run();
  assert.deepEqual(h.sent[0], { kind: REREAD_PREFS, origin: 'https://docs.example.test' });
  assert.deepEqual(h.started.map((s) => s.quieted), [false]);
});

test('a site the learner has quieted still starts, and starts silent ()', async () => {
  const h = harness({ quieted: true });
  await h.run();
  assert.deepEqual(h.started.map((s) => s.quieted), [true],
    'the detector is told, and it is the detector that stops — not a filter over its output');
});

test('a raised candidate is the only thing that leaves the page ()', async () => {
  const h = harness({ quieted: false });
  await h.run();
  h.started[0]!.onCandidate(candidate);
  assert.deepEqual(h.sent[1], { kind: REREAD_CANDIDATE, candidate });
  assert.equal(h.sent.length, 2, 'the scroll and dwell trace never crosses this line at all');
});

test('an unreachable worker goes quiet rather than loud', async () => {
  // We cannot tell whether they have already said no here. Nagging someone who
  // has, because a fetch timed out, is the exact failure  exists to stop.
  const h = harness(new Error('the worker is asleep'));
  await h.run();
  assert.deepEqual(h.started.map((s) => s.quieted), [true]);
});

test('a reply that says nothing useful is treated as a no', async () => {
  for (const reply of [undefined, {}, { quieted: 'maybe' }]) {
    const h = harness(reply);
    await h.run();
    assert.equal(h.started[0]!.quieted, true, `${JSON.stringify(reply)} is not permission`);
  }
});

// ---------------------------------------------------------------- the manifest

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../manifest.json', import.meta.url)), 'utf8'),
) as {
  manifest_version: number;
  content_scripts?: { matches: string[]; js: string[]; run_at?: string }[];
  web_accessible_resources?: { resources: string[]; matches: string[] }[];
};

test('the re-read detector is registered as a content script ()', () => {
  // Its absence was the whole defect: the best-reasoned file in the extension
  // had never executed, because nothing declared it.
  const scripts = manifest.content_scripts ?? [];
  assert.ok(scripts.some((s) => s.js.includes('reread-content.js')),
    'no content_scripts entry — the detector runs nowhere, exactly as before');
});

test('the modules the content script imports are reachable from a page', () => {
  // MV3 will not run a declared content script as a module, so the loader pulls
  // the graph in with `chrome.runtime.getURL`. Every file it fetches has to be
  // web-accessible, and a missing one fails on a real page and nowhere else.
  const exposed = (manifest.web_accessible_resources ?? []).flatMap((w) => w.resources);
  for (const needed of ['dist/reread-bridge.js', 'dist/reread.js', 'dist/reread-core.js']) {
    assert.ok(exposed.includes(needed), `${needed} is imported at runtime and is not web-accessible`);
  }
});

test('the loader is a classic script, because MV3 will not run a module', () => {
  // This is why that one file is hand-written JavaScript. `tsc` emits
  // `export {};` into any file in this package that has no imports of its own,
  // and that single line is enough for Chrome to refuse to inject it — at
  // runtime, on every page, with nothing failing anywhere else.
  const loader = readFileSync(fileURLToPath(new URL('../../reread-content.js', import.meta.url)), 'utf8');
  const topLevel = loader.split('\n').filter((l) => /^\s*(import|export)\s/.test(l));
  assert.deepEqual(topLevel, [],
    'a top-level import or export makes this a module, and a module is what MV3 refuses to run here');
  for (const needed of ['dist/reread-bridge.js', 'dist/reread.js']) {
    assert.ok(loader.includes(needed), `the loader no longer pulls in ${needed}`);
  }
});
