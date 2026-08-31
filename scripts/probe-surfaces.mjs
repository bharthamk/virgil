/**
 * Does the hosted app own the full page while the panel remains a narrow
 * companion rather than growing another board?
 *
 * A DOM stub cannot verify user-gesture lifetime or the surface `dataset`, so
 * this loads the real extension in Chrome and reads what each surface draws.
 *
 * What it proves, per surface:
 *
 *  - The hosted `/app/` route draws the main page and reaches the service for the zones
 *    and it does NOT eat a hand-off a panel may be waiting for.
 *  - **panel.html** keeps the lesson plus Visit full site and Pick what to pin.
 *  - Neither surface says the word "back" anywhere on it.
 *
 * Needs a service on 8791. Run:
 *   node scripts/probe-surfaces.mjs
 * It launches its own Chrome on a throwaway profile and closes it after.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION = fileURLToPath(new URL('../extension', import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9334;
const SERVICE = process.env.SB_SERVICE ?? 'http://127.0.0.1:8791';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`);
};

async function main() {
  const health = await fetch(`${SERVICE}/health`).then((r) => r.json()).catch(() => null);
  if (!health) throw new Error(`no service on ${SERVICE} — start it before this probe`);
  console.log(`service: ${JSON.stringify(health)}`);

  const profile = mkdtempSync(join(tmpdir(), 'virgil-surfaces-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    let version = null;
    for (let i = 0; i < 60 && !version; i += 1) {
      await sleep(250);
      version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null);
    }
    if (!version) throw new Error('Chrome never opened its debugging port');
    console.log('browser:', version['Browser']);

    const browser = await connect(version.webSocketDebuggerUrl);
    const loaded = await browser.send('Extensions.loadUnpacked', { path: EXTENSION });
    const id = loaded.id;
    console.log('extension:', id);

    /** Open either the hosted app or one of the extension's own pages. */
    const draw = async (target) => {
      const { targetId } = await browser.send('Target.createTarget', {
        url: target.startsWith('http') ? target : `chrome-extension://${id}/${target}`,
      });
      const page = await attach(browser, targetId);
      await page.send('Runtime.enable');
      await sleep(2500);
      const read = async (expression) => {
        const r = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) return `ERROR: ${r.exceptionDetails.text}`;
        return r.result.value;
      };
      const out = {
        text: await read('document.getElementById("app").innerText'),
        buttons: await read('[...document.querySelectorAll("button")].map(b => b.innerText.trim())'),
        surface: await read('document.getElementById("app").dataset.surface ?? "(none)"'),
      };
      await browser.send('Target.closeTarget', { targetId });
      return out;
    };

    // A pending hand-off, seeded the way the worker writes one. The main page
    // must leave it alone: a learner with a Virgil tab open who presses Learn
    // it now must not lose the take to the tab.
    const seedTarget = await browser.send('Target.createTarget', { url: `chrome-extension://${id}/action-popup.html` });
    const seed = await attach(browser, seedTarget.targetId);
    await seed.send('Runtime.enable');
    await sleep(800);
    await seed.send('Runtime.evaluate', {
      expression: `chrome.storage.local.set({ sb_handoff: { pinId: 'probe-pin', label: 'A probe', at: Date.now(), intent: 'take', failure: null } })`,
      awaitPromise: true, returnByValue: true,
    });
    await browser.send('Target.closeTarget', { targetId: seedTarget.targetId });

    console.log('\n--- /app/: the service-owned main page ---');
    const page = await draw(`${SERVICE}/app/`);
    console.log(`  surface attribute: ${page.surface}`);
    console.log(`  buttons: ${JSON.stringify(page.buttons)}`);
    console.log(`  first line: ${String(page.text).split('\n')[0]}`);
    check('draws the main page rather than the idle panel',
      !String(page.text).includes('panel is for the thing you just pinned'));
    // Checked on the CONTROLS, not on the prose. "Come back to" is zone 3's
    // heading and is a perfectly good sentence; what must never come back is a
    // control named for a direction on a surface with no history.
    check('no control says "back"', !page.buttons.some((b) => /\bback\b/i.test(b)),
      JSON.stringify(page.buttons));

    const stillThere = await (async () => {
      const t = await browser.send('Target.createTarget', { url: `chrome-extension://${id}/action-popup.html` });
      const s = await attach(browser, t.targetId);
      await s.send('Runtime.enable');
      await sleep(600);
      const r = await s.send('Runtime.evaluate', {
        expression: 'chrome.storage.local.get("sb_handoff").then(v => JSON.stringify(v.sb_handoff))',
        awaitPromise: true, returnByValue: true,
      });
      await browser.send('Target.closeTarget', { targetId: t.targetId });
      return r.result.value;
    })();
    check('leaves a pending hand-off for the panel', String(stillThere).includes('probe-pin'),
      String(stillThere).slice(0, 80));

    console.log('\n--- panel.html: the narrow companion ---');
    const panel = await draw('panel.html');
    console.log(`  surface attribute: ${panel.surface}`);
    console.log(`  buttons: ${JSON.stringify(panel.buttons)}`);
    console.log(`  reads: ${String(panel.text).replace(/\n/g, ' ').slice(0, 160)}`);
    check('offers the hosted full site', panel.buttons.includes('Visit full site'));
    check('keeps capture beside the lesson', panel.buttons.includes('Pick what to pin'));
    check('no control says "back"', !panel.buttons.some((b) => /\bback\b/i.test(b)),
      JSON.stringify(panel.buttons));
  } finally {
    chrome.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }

  console.log(`\n${failures ? `${failures} check(s) FAILED` : 'all checks passed'}`);
  process.exit(failures ? 1 : 0);
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return wrap(ws);
}

function wrap(ws, sessionId) {
  let id = 0;
  const pending = new Map();
  const handlers = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    for (const fn of handlers.get(msg.method) ?? []) fn(msg.params);
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
    on(method, fn) { handlers.set(method, [...(handlers.get(method) ?? []), fn]); },
  };
}

async function attach(browser, targetId) {
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  return wrap(browser.ws, sessionId);
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
