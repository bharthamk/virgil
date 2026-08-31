/**
 * Does the selection survive a real right-click, in a real Chrome, on a page
 * with a real CSP?
 *
 * Three builds of the recovery rule shipped on reasoning and none of them
 * worked, which is what this exists to stop. It drives branded Chrome over
 * CDP: loads the extension unpacked, serves a page carrying the exact CSP
 * header Udacity sends, selects a sentence, dispatches a genuine
 * right-button mousedown through the browser's own input pipeline, and reads
 * back what the extension's isolated world actually holds.
 *
 * Run: node scripts/probe-selection.mjs
 * It launches its own Chrome on a throwaway profile and closes it after.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION = fileURLToPath(new URL('../extension', import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const PAGE_PORT = 8799;

/** The header that turned the mechanism off. Copied from the live response. */
const UDACITY_CSP = "default-src 'self' 'unsafe-inline' 'unsafe-eval' * blob:;  "
  + "script-src 'self' 'unsafe-inline' 'unsafe-eval' * blob:; style-src 'self' 'unsafe-inline' * blob:; "
  + 'img-src \'self\' data: * blob:; font-src \'self\' data: blob: *; connect-src \'self\' blob: *;';

const SENTENCE = "Represent data using Python's data types: integers, floats, booleans, "
  + 'strings, lists, tuples, sets, dictionaries, compound data structures';

/**
 * Markup built like an app rather than written like a document: the headings
 * are in sibling containers, not siblings of the passage. This is the shape
 * that produced empty heading paths on every real pin.
 */
const PAGE = `<!doctype html><html><head><title>Data types</title></head><body>
<header><h1>Welcome to Neural Networks</h1></header>
<main>
  <section><h2>Prerequisites</h2></section>
  <section><div><p id="target">${SENTENCE}</p></div></section>
  <section><h2>Later section</h2></section>
</main>
</body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const withCsp = process.argv.includes('--no-csp') ? null : UDACITY_CSP;
  const server = createServer((req, res) => {
    const headers = { 'content-type': 'text/html; charset=utf-8' };
    if (withCsp) headers['content-security-policy'] = withCsp;
    res.writeHead(200, headers);
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(PAGE_PORT, '127.0.0.1', r));
  console.log(`page on http://127.0.0.1:${PAGE_PORT}  CSP: ${withCsp ? 'yes (Udacity’s)' : 'none'}`);

  const profile = mkdtempSync(join(tmpdir(), 'virgil-probe-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    `http://127.0.0.1:${PAGE_PORT}/`,
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60 && !version; i += 1) {
    await sleep(250);
    version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null);
  }
  if (!version) throw new Error('Chrome never opened its debugging port');
  console.log('browser:', version['Browser']);

  const browser = await connect(version.webSocketDebuggerUrl);

  // Load the extension the way the earlier probes did.
  const loaded = await browser.send('Extensions.loadUnpacked', { path: EXTENSION }).catch((e) => ({ error: e.message }));
  console.log('extension:', loaded.id ?? loaded.error);

  // The page has to be loaded AFTER the extension, or no content script is in it.
  const targets = await browser.send('Target.getTargets');
  const pageTarget = targets.targetInfos.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'));
  const page = await attach(browser, pageTarget.targetId);
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  const contexts = [];
  page.on('Runtime.executionContextCreated', (p) => contexts.push(p.context));

  await page.send('Page.reload', { ignoreCache: true });
  await sleep(2500);

  const isolated = contexts.filter((c) => c.auxData?.type === 'isolated');
  console.log(`isolated worlds present: ${isolated.length}`,
    isolated.map((c) => c.name).join(' | ') || '(none)');

  const inWorld = async (expression) => {
    if (!isolated.length) return { error: 'no isolated world at all' };
    const r = await page.send('Runtime.evaluate', {
      expression, contextId: isolated[0].id, returnByValue: true, awaitPromise: true,
    });
    return r.exceptionDetails ? { error: r.exceptionDetails.text } : r.result.value;
  };

  console.log('\n--- is the listener installed? ---');
  console.log(await inWorld('typeof globalThis.__sbSelectionMemory'));

  // Select the sentence, exactly as a person dragging across it would leave it.
  await page.send('Runtime.evaluate', {
    expression: `(() => {
      const t = document.getElementById('target').firstChild;
      const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, t.length);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return s.toString().length;
    })()`,
    returnByValue: true,
  });
  console.log('selected in page:', (await page.send('Runtime.evaluate', {
    expression: 'getSelection().toString().slice(0,40)', returnByValue: true,
  })).result.value, '…');

  // Where the word "data" sits, so the right-click lands on a DIFFERENT word
  // inside the sentence: the case that collapses a selection.
  const box = (await page.send('Runtime.evaluate', {
    expression: `(() => {
      const t = document.getElementById('target').firstChild;
      const i = t.data.indexOf('integers');
      const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 8);
      const b = r.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`,
    returnByValue: true,
  })).result.value;

  console.log('\n--- a real right-button mousedown at', box, '---');
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', button: 'right', buttons: 2, clickCount: 1, x: box.x, y: box.y,
  });
  await sleep(150);

  console.log('page selection after the press:',
    JSON.stringify((await page.send('Runtime.evaluate', {
      expression: 'getSelection().toString()', returnByValue: true,
    })).result.value));

  const held = await inWorld(`(() => {
    const m = globalThis.__sbSelectionMemory;
    if (!m) return 'NO MEMORY OBJECT';
    if (!m.atMenu) return 'MEMORY PRESENT, NOTHING HELD';
    return { text: m.atMenu.text.slice(0, 60), age: Date.now() - m.atMenu.at };
  })()`);
  console.log('what the memory holds:', JSON.stringify(held));

  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', button: 'right', buttons: 0, clickCount: 1, x: box.x, y: box.y,
  });

  console.log('\n--- what capture would send ---');
  const captured = await inWorld(`(() => {
    const live = getSelection();
    const liveText = live ? live.toString().trim() : '';
    const m = globalThis.__sbSelectionMemory;
    const held = m && m.atMenu;
    const had = held ? held.text.trim() : '';
    const recovered = held && had && (Date.now() - held.at <= 60000) && had.length > liveText.length;
    return { liveText: liveText.slice(0, 40), recovered: !!recovered, wouldSend: (recovered ? had : liveText).slice(0, 70) };
  })()`);
  console.log(JSON.stringify(captured, null, 2));

  // ------------------------------------------------------------------------
  // The case the rule exists for: a right-click that lands OUTSIDE the
  // selection, which is what collapses it.
  console.log('\n=== right-click outside the selection ===');
  await page.send('Runtime.evaluate', {
    expression: `(() => {
      const t = document.getElementById('target').firstChild;
      const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 38);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return s.toString();
    })()`,
    returnByValue: true,
  });
  const heading = (await page.send('Runtime.evaluate', {
    expression: `(() => { const b = document.querySelector('h1').getBoundingClientRect();
      return { x: Math.round(b.left + 20), y: Math.round(b.top + b.height / 2) }; })()`,
    returnByValue: true,
  })).result.value;

  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', button: 'right', buttons: 2, clickCount: 1, x: heading.x, y: heading.y,
  });
  await sleep(150);
  console.log('page selection after the press:',
    JSON.stringify((await page.send('Runtime.evaluate', {
      expression: 'getSelection().toString()', returnByValue: true,
    })).result.value));
  console.log('memory:', JSON.stringify(await inWorld(`(() => {
    const m = globalThis.__sbSelectionMemory;
    return m && m.atMenu ? m.atMenu.text.slice(0, 50) : 'NOTHING HELD';
  })()`)));
  console.log('capture would send:', JSON.stringify(await inWorld(`(() => {
    const live = getSelection();
    const liveText = live ? live.toString().trim() : '';
    const m = globalThis.__sbSelectionMemory;
    const held = m && m.atMenu;
    const had = held ? held.text.trim() : '';
    const recovered = held && had && (Date.now() - held.at <= 60000) && had.length > liveText.length;
    return { liveText, recovered: !!recovered, wouldSend: (recovered ? had : liveText).slice(0, 60) };
  })()`), null, 2));

  // ------------------------------------------------------------------------
  // Was the CSP ever the problem? The detector still reaches its modules by
  // dynamic import, and a content script's import() is said to be checked
  // against the page's CSP. Asked directly rather than assumed.
  console.log('\n=== what capture reads off this page ===');
  console.log(JSON.stringify(await inWorld(`
    import(chrome.runtime.getURL('dist/capture.js')).then((m) => {
      const t = document.getElementById('target').firstChild;
      const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 30);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      const e = m.capture();
      return { headingPath: e.headingPath, siteName: e.siteName, selection: e.selection.slice(0, 30) };
    }).catch((err) => 'FAILED: ' + String(err).slice(0, 120))
  `), null, 2));

  console.log('\n=== what Standard’s box opens on, in a real select ===');
  console.log(JSON.stringify(await inWorld(`
    import(chrome.runtime.getURL('dist/pin-box.js')).then((m) => {
      const built = m.buildPinBox(document, {
        selection: 'a passage', pageTitle: 'A page', headingPath: ['Section'],
        siteName: 'example.test', url: 'https://example.test/x',
      });
      return {
        selectValue: built.effort.value,
        selectedLabel: built.effort.options[built.effort.selectedIndex]?.textContent,
        wouldSend: {
          register: built.result().requestedRegister,
          minutes: built.result().requestedMinutes,
        },
      };
    }).catch((e) => 'FAILED: ' + String(e).slice(0, 140))
  `), null, 2));

  console.log('\n=== can a content script import an extension module here? ===');
  console.log(JSON.stringify(await inWorld(`
    import(chrome.runtime.getURL('dist/reread-core.js'))
      .then((m) => 'IMPORT OK: ' + Object.keys(m).slice(0, 3).join(','))
      .catch((e) => 'IMPORT REFUSED: ' + String(e).slice(0, 120))
  `)));
  console.log('detector booted?', JSON.stringify(await inWorld(
    `typeof globalThis.__sbRereadBooted`)));

  chrome.kill();
  server.close();
  rmSync(profile, { recursive: true, force: true });
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
  const session = wrap(browser.ws, sessionId);
  // The browser socket is shared, so the session needs its own listeners.
  return session;
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
