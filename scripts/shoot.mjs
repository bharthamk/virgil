/**
 * What does a surface actually look like right now?
 *
 * Every visual defect this project has fixed was found by looking, and every
 * time somebody looked they rebuilt the rig for it. `probe-selection.mjs`,
 * `probe-surfaces.mjs` and two thrown-away probes before them each grew their
 * own copy of launch-Chrome-load-the-extension-and-read-the-page. This is that
 * part, kept, with a camera on it.
 *
 * It renders one of the extension's own pages at a set of widths and writes a
 * PNG per width. It never clicks anything and never posts: it opens a surface,
 * waits for it to settle, and photographs it.
 *
 * The extension is hard-wired to 127.0.0.1:8791 (R1). Rather than make that a
 * reason to stop, `--port` copies the extension to a temp directory and
 * rewrites the origin in the copy, so a probe can point at a scratch service
 * while somebody's real one keeps the default port. The copy is thrown away.
 *
 *   node scripts/shoot.mjs --surface app --out artifacts/look
 *   node scripts/shoot.mjs --surface panel.html --widths 400 --port 8792
 *   node scripts/shoot.mjs --surface app --theme dark --hash /board
 *   node scripts/shoot.mjs --surface app --eval 'getComputedStyle(document.querySelector(".masthead")).paddingLeft'
 *
 * Needs a service on the chosen port, and a Chrome at CHROME below.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION = fileURLToPath(new URL('../extension', import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const surface = arg('surface', 'app');
const outDir = arg('out', 'artifacts/look');
const widths = arg('widths', '1280,760,400').split(',').map((w) => Number(w.trim()));
const port = Number(arg('port', '8791'));
const theme = arg('theme', '');            // '', 'light' or 'dark'
const hash = arg('hash', '');              // e.g. /board
const tag = arg('tag', '');                // filename prefix
const settle = Number(arg('settle', '2500'));
// The surfaces are one page with screens rather than URLs, so reaching the
// board means pressing the thing that opens it. Named by its own text, because
// that is the only stable handle a screen without a route has.
const press = arg('press', '');
/** JSON written into `chrome.storage.local` before the surface is drawn, so a
 *  screen that only exists for a signed-in learner can be photographed. */
const seed = arg('seed', '');
const evaluate = arg('eval', '');

async function main() {
  const service = `http://127.0.0.1:${port}`;
  const health = await fetch(`${service}/health`).then((r) => r.json()).catch(() => null);
  if (!health) throw new Error(`no service on ${service} — start one before this`);
  console.log(`service: ${JSON.stringify(health)}  surface: ${surface}${hash}  theme: ${theme || '(system)'}`);

  // Point a throwaway copy of the extension at this port, so the real one and
  // whatever service is on 8791 are both left alone.
  let extension = EXTENSION;
  let copy = null;
  if (port !== 8791) {
    copy = mkdtempSync(join(tmpdir(), 'virgil-ext-'));
    extension = join(copy, 'extension');
    cpSync(EXTENSION, extension, { recursive: true });
    for (const f of ['manifest.json', 'dist/service.js']) {
      const p = join(extension, f);
      try {
        writeFileSync(p, readFileSync(p, 'utf8').replaceAll('127.0.0.1:8791', `127.0.0.1:${port}`));
      } catch { /* dist/service.js only exists after a build */ }
    }
  }

  mkdirSync(outDir, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'virgil-shoot-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });

  const written = [];
  try {
    let version = null;
    for (let i = 0; i < 60 && !version; i += 1) {
      await sleep(250);
      version = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.json()).catch(() => null);
    }
    if (!version) throw new Error('Chrome never opened its debugging port');
    console.log('browser:', version['Browser']);

    const browser = await connect(version.webSocketDebuggerUrl);
    const { id } = await browser.send('Extensions.loadUnpacked', { path: extension });

    for (const width of widths) {
      const suffix = hash ? `#${hash.replace(/^#/, '')}` : '';
      const url = surface === 'app'
        ? `${service}/app/${suffix}`
        : `chrome-extension://${id}/${surface}${suffix}`;
      const { targetId } = await browser.send('Target.createTarget', { url });
      const page = await attach(browser, targetId);
      await page.send('Runtime.enable');
      await page.send('Page.enable');
      if (seed) {
        if (surface === 'app') throw new Error('--seed belongs to extension storage and cannot seed the hosted app');
        // Written, then the surface is reloaded, because `panel.ts` reads
        // storage as it boots and a write after that is a write nobody read.
        await page.send('Runtime.evaluate', {
          expression: `chrome.storage.local.set(${seed})`,
          awaitPromise: true, returnByValue: true,
        });
        await page.send('Page.reload');
      }
      await page.send('Emulation.setDeviceMetricsOverride', {
        width, height: 900, deviceScaleFactor: 2, mobile: false,
      });
      if (theme) {
        await page.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: theme }],
        });
      }
      await sleep(settle);

      if (press) {
        const clicked = await page.send('Runtime.evaluate', {
          expression: `(() => {
            const want = ${JSON.stringify(press)}.toLowerCase();
            const hit = [...document.querySelectorAll('button, a')]
              .find((b) => b.innerText.trim().toLowerCase().includes(want));
            if (!hit) return 'NOT FOUND: ' + ${JSON.stringify(press)};
            hit.click();
            return 'pressed: ' + hit.innerText.trim();
          })()`,
          returnByValue: true,
        });
        console.log(`  ${clicked.result.value}`);
        await sleep(settle);
      }

      if (evaluate) {
        const got = await page.send('Runtime.evaluate', {
          expression: evaluate, returnByValue: true, awaitPromise: true,
        });
        console.log(`  eval: ${JSON.stringify(got.result.value ?? got.exceptionDetails ?? null)}`);
      }

      const metrics = await page.send('Page.getLayoutMetrics');
      const h = Math.min(Math.ceil(metrics.cssContentSize.height), 6000);
      const shot = await page.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height: h, scale: 1 },
      });
      const name = [tag, surface.replace('.html', ''),
        (hash || press).replace(/\W+/g, '') || null, theme || null, `${width}`]
        .filter(Boolean).join('-') + '.png';
      const path = join(outDir, name);
      writeFileSync(path, Buffer.from(shot.data, 'base64'));
      written.push(`${path}  ${width}x${h}`);

      // Say what is actually on it, so a failed render is obvious without
      // opening the file.
      const r = await page.send('Runtime.evaluate', {
        expression: 'document.getElementById("app")?.innerText?.slice(0, 90) ?? "(no #app)"',
        returnByValue: true,
      });
      console.log(`  ${width}px -> ${name}  ${JSON.stringify(r.result.value)}`);
      await browser.send('Target.closeTarget', { targetId });
    }
  } finally {
    chrome.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
    if (copy) rmSync(copy, { recursive: true, force: true });
  }

  console.log(`\n${written.length} written:`);
  for (const w of written) console.log(`  ${w}`);
}

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

main().catch((e) => { console.error('shoot failed:', e.message); process.exit(1); });
