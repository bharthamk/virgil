/**
 * Does Chrome actually accept every menu item this extension declares?
 *
 * `background-shell.test.ts` proves the worker asks for the items. It cannot
 * prove Chrome *takes* them: `chrome.contextMenus.create` reports its refusals
 * through `chrome.runtime.lastError` in a callback nothing was reading, so an
 * item Chrome rejects — a bad id, a context combination it will not allow —
 * is absent from the menu and silent everywhere else. This probe verifies the
 * browser-level contract that unit tests cannot observe.
 *
 * It launches branded Chrome on a throwaway profile, loads the extension
 * unpacked, attaches to the service worker, clears the menu and rebuilds it
 * from the registry, reading `lastError` after every single create.
 *
 * Run: node scripts/probe-menu.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION = fileURLToPath(new URL('../extension', import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The list is read here rather than in the worker: a service worker may not
 * `import()` at all (the HTML spec forbids it), so the registry is loaded in
 * Node from the same built module the worker itself ships and handed across.
 */
const {
  PIN_MODES, IMAGE_PIN_ID, IMAGE_PIN_TITLE,
  OPEN_BOARD_ID, OPEN_BOARD_TITLE, OPEN_PANEL_ID, OPEN_PANEL_TITLE,
} = await import(new URL('../extension/dist/pin-modes.js', import.meta.url));

const DECLARED = [
  ...PIN_MODES.map((m) => ({ id: m.id, title: m.title, contexts: [...m.contexts] })),
  { id: IMAGE_PIN_ID, title: IMAGE_PIN_TITLE, contexts: ['image'] },
  // Both doors. The board's is the one that did not exist, so a probe that
  // still listed only the panel would report a complete menu that was not.
  { id: OPEN_BOARD_ID, title: OPEN_BOARD_TITLE, contexts: ['action'] },
  { id: OPEN_PANEL_ID, title: OPEN_PANEL_TITLE, contexts: ['action'] },
];

/** Cleared and rebuilt inside the worker, reading `lastError` after each one. */
const rebuild = (items) => `(async () => {
  const create = (opts) => new Promise((res) => {
    chrome.contextMenus.create(opts, () => res(chrome.runtime.lastError ? chrome.runtime.lastError.message : null));
  });
  await new Promise((r) => chrome.contextMenus.removeAll(r));
  const out = [];
  for (const item of ${JSON.stringify(items)}) out.push({ ...item, error: await create(item) });
  return out;
})()`;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'virgil-menu-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60 && !version; i += 1) {
    await sleep(250);
    version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null);
  }
  if (!version) throw new Error('Chrome never opened its debugging port');
  console.log('browser:', version['Browser']);

  const browser = await connect(version.webSocketDebuggerUrl);
  const loaded = await browser.send('Extensions.loadUnpacked', { path: EXTENSION })
    .catch((e) => ({ error: e.message }));
  if (!loaded.id) throw new Error(`extension did not load: ${loaded.error}`);
  console.log('extension:', loaded.id);

  // Asked from one of the extension's own pages rather than from the service
  // worker: a worker target's CDP context carries no extension bindings (its
  // `chrome` has `csi` and `loadTimes` and nothing else), while an extension
  // page shares the very same `chrome.contextMenus` the worker calls. The
  // menu is global to the extension, so it is the same menu either way.
  const { targetId } = await browser.send('Target.createTarget', {
    url: `chrome-extension://${loaded.id}/action-popup.html`,
  });
  await sleep(1500);
  const page = await attach(browser, targetId);
  await page.send('Runtime.enable');
  const bindings = await page.send('Runtime.evaluate', {
    expression: "typeof chrome !== 'undefined' && typeof chrome.contextMenus", returnByValue: true,
  });
  if (bindings.result.value !== 'object') throw new Error(`no contextMenus binding here: ${bindings.result.value}`);

  const r = await page.send('Runtime.evaluate', { expression: rebuild(DECLARED), returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);

  console.log('\n--- what Chrome took ---');
  let refused = 0;
  for (const item of r.result.value) {
    const mark = item.error ? '✖' : '✔';
    if (item.error) refused += 1;
    console.log(`${mark} ${item.id.padEnd(16)} [${item.contexts.join(', ')}]  ${item.title}${item.error ? `  — ${item.error}` : ''}`);
  }

  const select = r.result.value.find((i) => i.id === 'mode-select');
  console.log('\nSelector offered on a selection:', select?.contexts.includes('selection') && !select.error ? 'YES' : 'NO');
  console.log('Selector offered on the toolbar button:', select?.contexts.includes('action') && !select.error ? 'YES' : 'NO');
  console.log(refused === 0 ? '\nRESULT: Chrome accepted every item.' : `\nRESULT: Chrome refused ${refused}.`);

  chrome.kill();
  rmSync(profile, { recursive: true, force: true });
  process.exit(refused === 0 ? 0 : 1);
}

// ---------------------------------------------------------------- tiny CDP
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return wrap(ws);
}

function wrap(ws, sessionId) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  return {
    ws,
    send(method, params = {}) {
      id += 1;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
  };
}

async function attach(browser, targetId) {
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  return wrap(browser.ws, sessionId);
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
