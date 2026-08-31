/**
 * What a person actually sees when they click the toolbar button.
 *
 * The popup's shape is a pure function over a `Document` and is tested in
 * `action-popup.test.ts`. What no unit test can reach is whether Chrome renders
 * it, whether `capturePermitted` gets a real url to judge, and whether pressing
 * *Pick what to pin* reaches the worker and puts the picker on the page. This
 * asks a real Chrome all three.
 *
 * The popup is opened as a background tab rather than by clicking the toolbar,
 * because CDP cannot press a browser chrome button. Everything else is real:
 * the same extension page, the same `chrome.tabs.query`, the same message.
 *
 *   node scripts/probe-popup.mjs                    # an ordinary page
 *   node scripts/probe-popup.mjs --active chrome://settings
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION = fileURLToPath(new URL('../extension', import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9338;
const PAGE_PORT = 9099;   // a host the manifest already allows, so `tab.url` is readable without the toolbar grant CDP cannot give
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Kept in step with `action-popup.ts` by the test that reads both. */
const PICK_UNAVAILABLE_TEXT = 'Virgil only reads ordinary web pages, and this is not one.';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const PAGE = `<!doctype html><html><head><title>Short stories</title></head><body>
<main><h1>How to write a short story</h1>
<section><h2>How to develop characters</h2>
<p id="a">Character development in short stories is not always about change, but about understanding.</p>
<p id="b">A second paragraph, long enough for the picker to consider it worth offering.</p>
</section></main></body></html>`;

async function main() {
  const activeUrl = arg('active', `http://127.0.0.1:${PAGE_PORT}/`);
  const ordinary = activeUrl.startsWith('http');

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(PAGE_PORT, '127.0.0.1', r));

  const profile = mkdtempSync(join(tmpdir(), 'virgil-popup-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    activeUrl,
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60 && !version; i += 1) {
    await sleep(250);
    version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null);
  }
  if (!version) throw new Error('Chrome never opened its debugging port');
  console.log('browser:', version['Browser']);
  console.log('active tab:', activeUrl, ordinary ? '(an ordinary page)' : '(a page no extension may script)');

  const browser = await connect(version.webSocketDebuggerUrl);
  const pageTargetId = (await browser.send('Target.getTargets')).targetInfos
    .find((t) => t.type === 'page')?.targetId;
  const loaded = await browser.send('Extensions.loadUnpacked', { path: EXTENSION }).catch((e) => ({ error: e.message }));
  if (!loaded.id) throw new Error(`extension did not load: ${loaded.error}`);
  console.log('extension:', loaded.id);

  /**
   * One popup, opened fresh.
   *
   * A background tab, so the page under test stays the active one — which is
   * the tab the popup asks about, exactly as it would from the toolbar. Fresh
   * each time because every choice ends in `window.close()`, and a session
   * against a torn-down tab is the "Session with given id not found" this
   * probe hit the first time it pressed two buttons in a row.
   */
  const openPopup = async () => {
    const { targetId } = await browser.send('Target.createTarget', {
      url: `chrome-extension://${loaded.id}/action-popup.html`,
      background: true,
    });
    await sleep(1500);
    const session = await attach(browser, targetId);
    await session.send('Runtime.enable');
    return async (expression) => {
      const r = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    };
  };

  const read = await openPopup();

  console.log('\n--- what the popup renders ---');
  const shown = await read(`JSON.stringify([...document.querySelectorAll('button')].map((b) => ({
    label: b.querySelector('.popup-choice-label')?.textContent,
    note: b.querySelector('.popup-choice-note')?.textContent,
    disabled: b.disabled,
  })), null, 1)`);
  console.log(shown);
  console.log('heading:', await read("document.querySelector('.popup-heading')?.textContent"));
  console.log('painted:', await read(
    "getComputedStyle(document.querySelector('.popup-choice')).backgroundColor"),
    '(a real background, so panel.css is reaching this page)');

  if (!ordinary) {
    /**
     * What this run actually establishes, and what it cannot.
     *
     * `chrome.tabs.query` returns a tab with no `url` unless the extension has
     * host permission for it or `activeTab` has been granted — and CDP cannot
     * press a toolbar button, which is the only thing that grants `activeTab`.
     * So on this run the url is unknown, `canPickOn` offers the picker rather
     * than refusing on a guess, and `PICK_UNAVAILABLE` does not appear.
     *
     * Whether it appears for a real person depends entirely on whether a real
     * toolbar click carries the grant, which is a question for a real toolbar
     * click. Reported rather than asserted.
     */
    const note = await read("document.querySelectorAll('.popup-choice-note')[2].textContent");
    console.log('\nRESULT: the popup renders on a page no extension may script.');
    console.log(note === PICK_UNAVAILABLE_TEXT
      ? 'The url was readable and the refusal is on screen.'
      : 'The url was NOT readable here, so the picker is offered rather than refused on a guess.'
        + ' Whether a real toolbar click reads it is what this probe cannot press.');
    return finish(chrome, server, profile);
  }

  console.log('\n--- pressing "Open my board" ---');
  // The complaint this run exists for: "open my board" opened a PANEL, and the
  // page stayed reachable only from inside it. A side panel cannot be seen
  // over CDP; a tab can, so this asserts the thing that was actually missing.
  await read("document.querySelectorAll('button')[0].click()");
  await sleep(1500);
  const opened = (await browser.send('Target.getTargets')).targetInfos
    .filter((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:8791/app/'));
  console.log('tabs at the hosted app:', opened.length, opened.map((t) => t.url).join(' '));
  let drew = false;
  if (opened.length) {
    const board = await attach(browser, opened[0].targetId);
    await board.send('Runtime.enable');
    await sleep(2000);
    const r = await board.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        surface: document.getElementById('app')?.dataset?.surface,
        stillLoading: document.getElementById('app')?.classList.contains('loading'),
        heading: document.querySelector('h1, h2')?.textContent?.slice(0, 60) ?? null,
      })`,
      returnByValue: true,
    });
    console.log('the page:', r.result.value);
    const seen = JSON.parse(r.result.value);
    drew = seen.surface === 'page' && !seen.stillLoading;
  }
  console.log(drew ? 'the page opened and drew.' : 'THE PAGE DID NOT OPEN OR DID NOT DRAW.');

  console.log('\n--- pressing "Pick what to pin" ---');
  // Back to the page under test first. Opening the board made ITS tab the
  // active one, and the popup asks about the active tab — so without this the
  // second popup judges an extension page, correctly refuses, and the failure
  // would be the probe's own ordering rather than the product's.
  await browser.send('Target.activateTarget', { targetId: pageTargetId });
  await sleep(500);
  const readAgain = await openPopup();
  await readAgain("document.querySelectorAll('button')[2].click()");
  await sleep(1500);

  const targets = await browser.send('Target.getTargets');
  const pageTarget = targets.targetInfos.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'));
  const page = await attach(browser, pageTarget.targetId);
  await page.send('Runtime.enable');
  const onPage = await page.send('Runtime.evaluate', {
    // The picker lives in a CLOSED shadow root, so nothing inside it is
    // readable from here and `innerText` never contains its bar. The host is
    // the handle the picker itself uses to know it is already open.
    expression: `JSON.stringify({
      host: !!document.querySelector('div[data-sb-selector]'),
      hosts: document.querySelectorAll('div[data-sb-selector]').length,
    })`,
    returnByValue: true,
  });
  console.log('on the page:', onPage.result.value);
  const ok = JSON.parse(onPage.result.value).host;
  console.log(ok && drew
    ? '\nRESULT: the board opens as a page, and the picker reaches the page it was asked for.'
    : `\nRESULT: board page ${drew ? 'ok' : 'FAILED'}, picker ${ok ? 'ok' : 'FAILED'}.`);
  await finish(chrome, server, profile);
  process.exit(ok && drew ? 0 : 1);
}

async function finish(chrome, server, profile) {
  chrome.kill();
  server.close();
  // Chrome is still letting go of the profile as this runs; a leftover temp
  // directory is not a reason to report a failed probe.
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* it will age out */ }
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
