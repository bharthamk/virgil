/**
 * §5d, walked: the hand-off to Gemini Notebook, in a real browser.
 *
 * The seam is built, unit-tested and **has never been used by a person**. It is
 * also the one place this product touches a Google product, which for a
 * public release run by Google is the surface least worth leaving unwalked.
 *
 * What this proves, and the order it proves it in, is §5d's own order —
 * *resolve, copy, say what happened, open* — because the failure that matters
 * is a learner ending up with an open Notebook tab and an empty clipboard,
 * which is the one failure the label already promised otherwise about.
 *
 * **It signs into nothing.** A throwaway profile, signed out, which is also the
 * case §5d legislates for: the affordance says *opens* rather than *sends*
 * precisely because a signed-out browser meets a sign-in page and nothing has
 * gone anywhere. Driving somebody's signed-in Notebook would be automating a
 * product that has no consumer API and has said so — the wall this seam exists
 * to respect.
 *
 *   node scripts/probe-handoff.mjs --port 8793 --store.data-handoff/store.json
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION = fileURLToPath(new URL('../extension', import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9339;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg('port', '8793'));
const STORE = arg('store', '.data-handoff/store.json');

/** Copy notes are §5d law, checked against the strings the screen actually shows. */
const BANNED = ['integrated', 'connected', 'synced', 'linked'];

async function main() {
  // The service this walk reads, on its own port and its own store, so nothing
  // touches the board somebody is using.
  const service = spawn(process.execPath, ['runner/dist/service.js'], {
    env: { ...process.env, SB_DB: STORE, SB_PORT: String(PORT) },
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'ignore',
  });
  let health = null;
  for (let i = 0; i < 40 && !health; i += 1) {
    await sleep(250);
    health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json()).catch(() => null);
  }
  if (!health) throw new Error(`no service on ${PORT}`);
  console.log(`service: ${JSON.stringify(health)}  store: ${STORE}`);

  const session = await fetch(`http://127.0.0.1:${PORT}/session`).then((r) => r.json()).catch(() => null);
  const sections = session?.session?.sections ?? session?.sections ?? [];
  console.log(`session: ${sections.length} sections`);
  if (!sections.length) throw new Error('no composed session in this store — nothing to hand off');

  // The extension is hard-wired to 8791; a throwaway copy is repointed.
  const copy = mkdtempSync(join(tmpdir(), 'virgil-ho-'));
  const extension = join(copy, 'extension');
  cpSync(EXTENSION, extension, { recursive: true });
  for (const f of ['manifest.json', 'dist/service.js']) {
    const p = join(extension, f);
    try { writeFileSync(p, readFileSync(p, 'utf8').replaceAll('127.0.0.1:8791', `127.0.0.1:${PORT}`)); } catch { /* not built */ }
  }

  const profile = mkdtempSync(join(tmpdir(), 'virgil-ho-profile-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60 && !version; i += 1) {
    await sleep(250);
    version = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.json()).catch(() => null);
  }
  if (!version) throw new Error('Chrome never opened its debugging port');
  console.log('browser:', version['Browser']);

  const browser = await connect(version.webSocketDebuggerUrl);
  const { id } = await browser.send('Extensions.loadUnpacked', { path: extension });
  console.log('extension:', id);

  const { targetId } = await browser.send('Target.createTarget', { url: `http://127.0.0.1:${PORT}/app/` });
  await sleep(3500);
  const page = await attach(browser, targetId);
  await page.send('Runtime.enable');
  const read = async (expression) => {
    const r = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  // Into the session. The board leads; the session is the screen the hand-off
  // is allowed to live on and the only one.
  console.log('\n--- finding the session ---');
  const opened = await read(`(() => {
    const start = [...document.querySelectorAll('button, a')]
      .find((b) => /^(start|resume|continue)/i.test(b.textContent.trim()));
    if (!start) return 'NO START CONTROL: ' + document.body.innerText.slice(0, 200);
    start.click();
    return 'pressed: ' + start.textContent.trim();
  })()`);
  console.log(opened);
  await sleep(2500);

  console.log('\n--- is the hand-off on the session, and only there? ---');
  console.log('handoff zones on screen:', await read("document.querySelectorAll('[data-zone=\"handoff\"]').length"));
  console.log('label:', JSON.stringify(await read("document.querySelector('[data-handoff]')?.textContent ?? null")));
  console.log('seam line:', JSON.stringify(await read("document.querySelector('.notebook .seam')?.textContent ?? null")));

  console.log('\n--- pressing it ---');
  const before = (await browser.send('Target.getTargets')).targetInfos.length;
  await read("document.querySelector('[data-handoff]').click()");
  await sleep(4000);

  const after = await read(`JSON.stringify({
    said: document.querySelector('.handoff-out .copied')?.textContent ?? null,
    unresolved: document.querySelector('.handoff-out .unresolved')?.textContent ?? null,
    unreadable: document.querySelector('.handoff-out .unreadable')?.textContent ?? null,
    urls: [...document.querySelectorAll('.handoff-out .url')].map((u) => u.textContent),
    doubtful: [...document.querySelectorAll('.handoff-out .url.doubtful')].map((u) => u.textContent),
    file: document.querySelector('.handoff-out a.download')?.getAttribute('download') ?? null,
    fileHrefIsData: (document.querySelector('.handoff-out a.download')?.getAttribute('href') ?? '').startsWith('data:'),
  }, null, 1)`);
  console.log(after);

  const targets = (await browser.send('Target.getTargets')).targetInfos;
  const notebook = targets.filter((t) => t.url.includes('notebook.google.com'));
  console.log(`tabs opened: ${targets.length - before}  at notebook.google.com: ${notebook.length}`);
  if (notebook.length) console.log('landed on:', notebook[0].url);

  console.log('\n--- §5d copy law ---');
  const screen = String(await read('document.body.innerText')).toLowerCase();
  const found = BANNED.filter((w) => screen.includes(w));
  console.log(found.length ? `BANNED WORDS ON SCREEN: ${found.join(', ')}` : 'no banned word on the screen');
  const label = String(await read("document.querySelector('[data-handoff]')?.textContent ?? ''")).toLowerCase();
  console.log(`label says "open": ${label.includes('open')}   label says "send": ${label.includes('send')}`);

  const parsed = JSON.parse(after);
  const ok = parsed.urls.length > 0 && notebook.length === 1 && !found.length && label.includes('open') && !label.includes('send');
  console.log(ok ? '\nRESULT: the hand-off hands off.' : '\nRESULT: something in the hand-off does not hold.');

  chrome.kill();
  service.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); rmSync(copy, { recursive: true, force: true }); } catch { /* ages out */ }
  process.exit(ok ? 0 : 1);
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
