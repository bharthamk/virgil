import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installChrome, freshImport, settle, jsonResponse, tab, type ChromeStub, type Injection } from './chrome-stub.js';
import { capture } from '../capture.js';
import { menuModes } from '../pin-modes.js';

/**
 * What the manifest promises Chrome, against what the code actually does.
 *
 * `manifest-paths.test.ts` checks that every file the manifest names exists.
 * This is the other half of the same class of defect: a manifest is a list of
 * strings, and nothing was reading the *names* in it either. A command declared
 * with no handler is a shortcut that does nothing; a handler for a command the
 * manifest does not declare is dead code; a `chrome.*` namespace used without
 * its permission is an exception at the moment the learner presses the key.
 *
 * The command and menu checks are behavioural — the worker is woken and the
 * event is fired — because "there is a handler" and "the handler captures
 * something" are different claims and only the second one is the product.
 */

const extensionDir = new URL('../../', import.meta.url);
const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, extensionDir)), 'utf8');

interface Manifest {
  permissions?: string[];
  host_permissions?: string[];
  oauth2?: { client_id?: string; scopes?: string[] };
  commands?: Record<string, unknown>;
  background?: { service_worker?: string };
  incognito?: string;
  web_accessible_resources?: { resources?: string[]; matches?: string[] }[];
}
interface ManifestAction { default_title?: string; default_icon?: Record<string, string>; default_popup?: string }
const manifest = JSON.parse(read('manifest.json')) as Manifest & { action?: ManifestAction };

test('every dependency of a page-side module is web-accessible too', () => {
  /**
   * Chrome does not grant a module graph because its entry file is listed.
   * Every static dependency fetched from an ordinary page's isolated world
   * must be listed as well. The themed pin form first exposed this: pin-box.js
   * was allowed, its new theme.js import was not, and the whole form vanished.
   */
  const declared = new Set(
    (manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources ?? []),
  );
  for (const resource of declared) {
    if (!resource.endsWith('.js')) continue;
    const source = read(resource);
    for (const match of source.matchAll(/\bfrom\s+['"]\.\/([^'"]+)['"]/g)) {
      const dependency = `dist/${match[1]}`;
      assert.ok(declared.has(dependency),
        `${resource} imports ${dependency}, but Chrome is allowed to load only the entry file`);
    }
  }
});

/** Every `chrome.<namespace>` the shipped source touches, and where. */
function namespacesUsed(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const files = [
    ...readdirSync(fileURLToPath(new URL('src/', extensionDir)))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `src/${f}`),
    'reread-content.js',
    'session-bridge-content.js',
  ];
  for (const file of files) {
    for (const match of read(file).matchAll(/\bchrome\.([a-zA-Z]+)\b/g)) {
      const namespace = match[1]!;
      found.set(namespace, [...(found.get(namespace) ?? []), file]);
    }
  }
  return found;
}

/**
 * Namespaces that need no permission of their own.
 *
 * `runtime` is always available. `tabs` needs no permission for the two things
 * this extension does with it: the worker receives a tab rather than querying
 * for one, and `tabs.create` is unprivileged — the `tabs` permission gates
 * reading a tab's url, title and favicon, which nothing here does. (A permission
 * asked for and unused would break the check two tests below, and would be a
 * promise the off-limits screen could not keep.) `windows` is the same argument
 * for the same reason: §6f-i opens a chat beside the lesson with
 * `windows.create`, which is a navigation rather than a capability, and reads
 * `windows.getCurrent` for the geometry to place it — position and size are
 * always available, and the `windows` permission adds only the tab urls and
 * titles inside a window, which this never looks at. The test below pins the
 * two methods, so the exemption cannot quietly grow to cover an enumeration.
 * `commands` and `action` are
 * declared as manifest *keys* rather than as permissions, and each is checked
 * as one below: a namespace whose key is missing is an undefined at the moment
 * the learner presses something, which is exactly what this file exists to
 * catch, so neither is simply exempt.
 */
const FREE_NAMESPACES = new Set(['runtime', 'tabs', 'windows', 'commands', 'action']);

test('every chrome namespace the code uses is one the manifest asks permission for', () => {
  const declared = new Set(manifest.permissions ?? []);
  for (const [namespace, files] of namespacesUsed()) {
    if (FREE_NAMESPACES.has(namespace)) continue;
    assert.ok(declared.has(namespace),
      `${files.join(', ')} calls chrome.${namespace} and the manifest never asks for "${namespace}"`);
  }
});

test('the unpermissioned namespaces are used only in the ways that need no permission', () => {
  /**
   * `tabs` and `windows` are exempt above on a specific argument rather than a
   * general one, and an exemption whose argument nobody re-checks is how an
   * extension comes to call `windows.getAll` on a manifest that never asked.
   * So the methods are pinned: creating and being handed things, never reading
   * or enumerating what the learner has open.
   */
  const allowed: Record<string, readonly string[]> = {
    tabs: ['create', 'get', 'query', 'sendMessage', 'update', 'onUpdated', 'onActivated', 'onRemoved'],
    windows: ['create', 'getCurrent'],
  };
  const reading = new Set(['getAll', 'getLastFocused', 'remove']);
  // Lower-case initial only: `chrome.tabs.Tab` is a TYPE annotation, and a
  // regex that could not tell one from a call would be asserting about the
  // shape of an interface rather than about what the extension does.
  const files = readdirSync(fileURLToPath(new URL('src/', extensionDir)))
    .filter((f) => f.endsWith('.ts')).map((f) => `src/${f}`);
  for (const file of files) {
    for (const m of read(file).matchAll(/\bchrome\.(tabs|windows)\.([a-z][a-zA-Z]*)\b/g)) {
      const [, namespace, method] = m as unknown as [string, 'tabs' | 'windows', string];
      assert.ok(!reading.has(method),
        `${file} calls chrome.${namespace}.${method}, which reads what the learner has open — `
        + 'that needs the permission, and the manifest does not ask for it');
      assert.ok(allowed[namespace]!.includes(method),
        `${file} calls chrome.${namespace}.${method}: decide whether it needs the permission `
        + 'before adding it to this list');
    }
  }
});

test('the worker listens for commands only because the manifest declares some', () => {
  const usesCommands = namespacesUsed().has('commands');
  assert.equal(usesCommands, Object.keys(manifest.commands ?? {}).length > 0,
    'a `commands` listener with no declared shortcut can never fire, and the reverse is a dead key');
});

test('the toolbar button asks rather than captures', () => {

  assert.equal(manifest.action?.default_popup, 'action-popup.html');
  assert.ok(!/chrome\.action\.onClicked/.test(read('src/background.ts')),
    'with a popup declared, an action.onClicked listener can never fire');
});

test('every board door opens the configured service app, never an extension page', () => {
  for (const file of ['src/action-popup-main.ts', 'src/background.ts', 'src/panel.ts']) {
    const source = read(file);
    assert.match(source, /boardPageUrl\(/,
      `${file} has a board door but does not resolve it from the configured service`);
    assert.doesNotMatch(source, /runtime\.getURL\([^)]*main\.html|tabs\.create\([^)]*main\.html/,
      `${file} can still open the board at a chrome-extension:// URL`);
  }
});

test('nothing touches chrome.action without the manifest key that defines it', () => {
  /**
   * This used to assert the equality both ways: `chrome.action` used **iff**
   * the manifest declares one. The forward half is still exactly right and is
   * why the test exists — `chrome.action` is undefined without the key, so a
   * listener registered against it throws while the worker is being evaluated,
   * which in MV3 means every listener after it is never registered at all.
   *
   * The reverse half was *"a button that does nothing"*, and it stopped being
   * true when the button grew a `default_popup`: Chrome handles that click
   * itself, so a declared button with no code behind it is now the normal and
   * correct shape. The test above holds the other side of that.
   */
  if (namespacesUsed().has('action')) {
    assert.ok(manifest.action !== undefined,
      'a chrome.action call with no action key is undefined at the moment it runs');
  }
});

test('every permission the manifest asks for is one the code uses', () => {
  // The off-limits screen tells the learner what this extension does and does
  // not watch. A permission it does not need is a promise it cannot keep, and
  // the review that spots it happens after the trust has already been asked for.
  const used = namespacesUsed();
  const grantedByOtherMeans = new Set([
    'activeTab', // the grant `scripting.executeScript` runs under, not a namespace
  ]);
  for (const permission of manifest.permissions ?? []) {
    if (grantedByOtherMeans.has(permission)) continue;
    assert.ok(used.has(permission), `the manifest asks for "${permission}" and nothing calls chrome.${permission}`);
  }
});

test('the hosts the extension may reach are its own service and its sign-in, and nothing else', () => {
  /**
   * This list grew, and the guarantee it carries did not change: **a study tool
   * that can reach anything is a different product with the same name.**
   *
   * It was one entry until the Firebase identity boundary gave learners accounts. The only remote
   * additions are the two identity endpoints. A self-hosted remote service is
   * inserted into its packaged manifest during installation.
   * None of them is a site the learner reads.
   * Nothing here lets this extension fetch a page, and the off-limits screen's
   * promise about what is and is not watched is untouched — what these allow is
   * a Google credential being exchanged for the deployment token and that
   * token being exchanged for a fresher one. Virgil never receives a password.
   *
   * The emulator entry is loopback. A learner never has one; it is how this is
   * developed, and it can only reach a service on their own machine.
   */
  assert.deepEqual(manifest.host_permissions, [
    'http://127.0.0.1:8791/*',                   // the service, and the board
    'http://127.0.0.1:9099/*',                   // a local Auth emulator, loopback only
    'https://identitytoolkit.googleapis.com/*',  // exchange Google identity
    'https://securetoken.googleapis.com/*',      // exchange a refresh token
  ], 'a study tool that can reach anything is a different product with the same name');

  const service = 'http://127.0.0.1:8791';
  // The two files that draw and capture may still reach the service and nothing
  // else. Identity is the one file allowed to talk to a provider, and it is
  // held to the endpoints the manifest names rather than exempted.
  const allowed: Record<string, readonly string[]> = {
    'src/background.ts': [service],
    'src/panel.ts': [service],
    'src/identity.ts': [
      'http://${config.emulatorHost}/identitytoolkit.googleapis.com',
      'http://${config.emulatorHost}/securetoken.googleapis.com',
      'https://identitytoolkit.googleapis.com',
      'https://securetoken.googleapis.com',
      'https://${chrome.runtime.id}.chromiumapp.org/',
    ],
  };
  for (const [file, prefixes] of Object.entries(allowed)) {
    for (const match of read(file).matchAll(/https?:\/\/[^'"`\s)]+/g)) {
      const url = match[0]!;
      assert.ok(prefixes.some((p) => url.startsWith(p)),
        `${file} reaches ${url}, which the manifest does not allow`);
    }
  }
});

test('Google identity is provisioned at install time, not borrowed from a Virgil account tenant', () => {
  assert.equal(manifest.oauth2?.client_id, '__VIRGIL_GOOGLE_EXTENSION_CLIENT_ID__');
  assert.deepEqual(manifest.oauth2?.scopes, ['openid', 'email', 'profile']);
  assert.ok(manifest.permissions?.includes('identity'));
  assert.ok(!read('src/identity.ts').includes('virgil-506009'),
    'the public extension must not silently bind self-hosters to a project-owned Firebase tenant');
});

test('§5d: the Notebook host itself is a tab the learner opens, never a request', () => {
  /**
   * The hand-off names `notebook.google.com` and the manifest grants no host
   * permission for it — correctly, because it is not a host this extension
   * reaches. `openBrowserTab` hands a url to the owning browser surface, which
   * then does
   * what it would do if the learner had typed it; a fetch would be this
   * extension reading someone else's page with the session, the board and the
   * learner model behind it.
   *
   * That distinction is exactly the kind that erodes, so it is written down:
   * the host lives in `notebook.ts`, `notebook.ts` cannot make a request, and
   * `panel.ts` may pass the constant only to the shared navigation door and to
   * the exact fallback link shown when that door is blocked.
   */
  const seam = read('src/notebook.ts');
  assert.match(seam, /https:\/\/notebook\.google\.com\//);
  assert.ok(!/\bfetch\s*\(|serviceFetch/.test(seam),
    'the file that holds the host must have no way to send anything to it');

  const panel = read('src/panel.ts');
  assert.ok(!/notebook\.google\.com/.test(panel),
    'the host is dated evidence and lives in one place — a second copy is the one that goes stale');
  assert.ok(!/NOTEBOOK_HOST/.test(panel),
    'the panel bypassed the validated configured-notebook resolver');
  assert.match(panel, /notebookTarget\(/,
    'the configured live notebook must pass through the one host/path validator');
  assert.match(panel, /setAttribute\('href', destination\)/,
    'a blocked popup must leave the exact validated destination as a visible second press');
  assert.ok(!new RegExp(`(?:fetch|serviceFetch)\\s*\\([^\\n]*NOTEBOOK_HOST`).test(panel),
    'the hosted fallback turned a browser-owned navigation into an extension request');
});

test('every request to the service goes through the one place that carries identity', () => {
  /**
   * **The exposed-service authentication boundary, as a structural rule rather than as three call sites that
   * happen to agree today.**
   *
   * The account-backed service refuses anything without a verified Firebase
   * token. Whether the extension carries it is not a property of `postPin` — it
   * is a property of *every* request, and a raw `fetch` added next to the others
   * would be a learner's request arriving anonymously.
   *
   * So there is one door: `serviceFetch` in `service.ts`. A file that names the
   * service origin and calls `fetch` itself has gone round it.
   */
  for (const file of ['src/background.ts', 'src/panel.ts']) {
    const source = read(file);
    for (const match of source.matchAll(/\bfetch\(\s*`?\$?\{?SERVICE/g)) {
      assert.fail(`${file} calls fetch on the service directly (${match[0]}) — use serviceFetch, `
        + 'which is where account identity is attached');
    }
  }
  // And the door still owns both authenticated and provisioned single-board
  // shapes, rather than enforcing a spelling with no behaviour behind it.
  const door = read('src/service.ts');
  assert.match(door, /SHARED_SECRET_HEADER/);
  assert.match(door, /chrome\.storage\.local/);
});

test('the shared secret is never a literal in anything that ships', () => {
  // The extension bundle is a directory anybody with the crx can read. The
  // secret is the learner's to put in `chrome.storage.local`, and a default
  // baked here would be a default every install shares.
  for (const file of readdirSync(fileURLToPath(new URL('src/', extensionDir))).filter((f) => f.endsWith('.ts'))) {
    if (file.startsWith('__')) continue;
    const source = read(`src/${file}`);
    for (const match of source.matchAll(/SHARED_SECRET_HEADER\s*\]?\s*:\s*'([^']+)'/g)) {
      assert.fail(`src/${file} ships a literal secret (${match[1]!})`);
    }
  }
});

test('the extension is not available in incognito at all', () => {
  // SB-40's third demand: "incognito is excluded by default, always". Chrome's
  // default for an unpacked extension is `spanning` — installed, and running in
  // incognito windows the moment the learner ticks the box in chrome://extensions
  // without ever being asked again. `not_allowed` is the only value that makes
  // the claim true: Chrome refuses to enable the extension there, and the
  // capture path, the re-read detector and the panel are all simply absent.
  //
  // Declared rather than enforced in code on purpose. A check inside the worker
  // is a check that can be got wrong, or reached after something has already
  // been read; a manifest value is enforced by the browser before any of this
  // extension's code exists in that window.
  assert.equal(manifest.incognito, 'not_allowed',
    'the manifest does not exclude incognito, so a learner could enable it there and the story\'s promise is false');
});

// ------------------------------------------------- the events, actually fired

async function wake(t: TestContext): Promise<ChromeStub> {
  const c = installChrome();
  t.after(() => { c.uninstall(); });
  c.injectResult = (injection: Injection) => (injection.func === capture
    ? { selection: 'A selected passage', parts: [], surroundingText: 'A selected passage', headingPath: [], pageTitle: '', url: '', canonicalUrl: null, siteName: null, contentLanguage: null }
    : undefined);
  c.fetchHandler = (url) => (url.endsWith('/pins')
    ? jsonResponse({ label: 'A topic' })
    : jsonResponse({ excludedDomains: [], rejectedOrigins: {}, pausedUntil: null }));
  await freshImport('../background.js');
  await settle();
  return c;
}

test('every keyboard shortcut the manifest declares captures something', async (t) => {
  const commands = Object.keys(manifest.commands ?? {});
  assert.ok(commands.length > 0, 'the manifest declares shortcuts at all');
  for (const command of commands) {
    const c = await wake(t);
    await c.fire.command(command, tab());
    await settle();
    assert.equal(c.requests.filter((r) => r.url.endsWith('/pins')).length, 1,
      `${command} is declared as a shortcut and the worker does nothing with it`);
    c.uninstall();
  }
});

test('every context menu the worker creates is one it also handles', async (t) => {
  // "Handles" rather than "pins": some of these menus capture, one opens the
  // side panel, and one opens the board as a page in a tab. The claim is
  // unchanged — a menu item that exists and does nothing when clicked is the
  // defect — and only the set of things that count as doing something grows.
  //
  // This is the guard that keeps the mode registry honest: a mode declared and
  // routed nowhere fails here, which is why the modes still being built are
  // not in `PIN_MODES` yet.
  const c = await wake(t);
  await c.fire.installed();
  await settle();
  const ids = c.menus.map((m) => m.id!);
  assert.ok(ids.length > 0);
  const capturing: string[] = [];
  for (const id of ids) {
    const pinsBefore = c.requests.filter((r) => r.url.endsWith('/pins')).length;
    const opensBefore = c.panelOpens.length;
    const injectedBefore = c.injections.length;
    const tabsBefore = c.tabsCreated.length;
    await c.fire.menuClick({ menuItemId: id, srcUrl: 'https://example.test/x.png' }, tab());
    await settle();
    const pinned = c.requests.filter((r) => r.url.endsWith('/pins')).length > pinsBefore;
    const opened = c.panelOpens.length > opensBefore;
    // A mode may also do its work in the page: Standard puts a box over it and
    // posts nothing until the learner presses the button. Injecting counts as
    // doing something; injecting nothing never does.
    const drew = c.injections.length > injectedBefore;
    // And a door may simply open a tab: the board is a page, and reaching it
    // is the whole of what that item is for.
    const went = c.tabsCreated.length > tabsBefore;
    assert.ok(pinned || opened || drew || went,
      `the menu item "${id}" exists and clicking it does nothing`);
    if (pinned) capturing.push(id);
  }
  // From the registry rather than a hand-kept list, so a mode added tomorrow
  // is asserted the day it lands: every mode whose action is to pin must pin,
  // and nothing else may. `mode-learn-now` pins too, and also opens the panel,
  // which is why it is counted here rather than exempted.
  // `compose` and `select` reach the page first and post later or never, so
  // they are not expected here. `guide` pins the way `learn` does: both open
  // the panel on a pin they are also making. The registry is what says which.
  const POSTS = new Set(['pin', 'learn', 'guide']);
  const shouldPin = menuModes(false).filter((m) => POSTS.has(m.action)).map((m) => m.id);
  assert.deepEqual(capturing, shouldPin,
    'a menu item pins that the registry does not say pins, or one that should does not');
});

test('a toolbar click reaches no worker code at all, which is the point', async (t) => {

  const c = await wake(t);
  await c.fire.actionClick(tab());
  await settle();
  assert.deepEqual(c.requests.filter((r) => r.url.endsWith('/pins')), [],
    'the click asks a question now; nothing is captured until somebody answers it');
  assert.deepEqual(c.panelOpens, [], 'and the popup opens the panel, from inside its own gesture');
  assert.deepEqual(c.injections, [], 'nothing is even read off the page');
});
