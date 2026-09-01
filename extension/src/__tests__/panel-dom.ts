/**
 * A DOM small enough to run the panel in, and nothing more.
 *
 * `dom-stub.ts` next door models a *page* being read — a frozen tree that
 * capture walks. The panel is the opposite shape: it builds its whole tree from
 * template strings, then mutates it in place from event handlers. Nothing in
 * that file can hold it, and no `jsdom` is coming, because this repository takes
 * no runtime dependencies.
 *
 * So this is the other half: a mutable element with the members `panel.ts`
 * actually touches, listed here so the list can be checked against the source.
 *
 *   document.getElementById   document.createElement
 *   innerHTML (set)           firstElementChild
 *   append   replaceChildren  remove
 *   querySelector             querySelectorAll
 *   addEventListener(type)    fireEvent(type)
 *   getAttribute setAttribute  textContent (get/set)   focus()
 *   className (set)           style.opacity
 *   value  checked  disabled
 *
 * Three deliberate choices:
 *
 *  - **The HTML is really parsed.** The panel's markup is its behaviour — the
 *    `data-` hooks its handlers hang off are attributes in a template string,
 *    and `esc()`'s output is only correct if something un-escapes it. A stub
 *    that stored the string and answered `querySelector` from a map would agree
 *    with a typo. Void elements, bare attributes and entities are handled
 *    because the shipped templates contain all three.
 *  - **Unsupported selectors throw.** A selector engine that quietly returns
 *    `null` for a shape it does not understand turns a wiring bug into a passing
 *    test. Every selector in `panel.ts` is a tag, a class or an attribute, and
 *    anything else is an error rather than a shrug.
 *  - **`click()` awaits the handler.** A real browser does not: the handlers
 *    here are `async` and the browser drops the promise on the floor. Awaiting
 *    is a test convenience for observing the request that comes out the far
 *    side, and it means these tests cannot say anything about what the screen
 *    looks like *during* an in-flight request.
 *
 * It cannot tell you the panel renders. It can tell you which request each
 * control makes, and what it does with the answer.
 */
import { settle } from './chrome-stub.js';

const VOID = new Set(['AREA', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'SOURCE', 'TRACK', 'WBR']);

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ',
};

/** The other half of `esc()`. Without it every assertion about a quoted topic
 *  label would be asserting the escaping rather than the copy. */
export const decodeEntities = (s: string): string =>
  s.replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (whole, name: string) => ENTITIES[name] ?? whole);

/**
 * An event, with the two members the panel's handlers reach for.
 *
 * `preventDefault` is not decoration here: the Check screen's drop handler must
 * call it or the browser navigates the whole side panel to the dropped file,
 * and a stub whose event object did not have the method would have thrown
 * rather than proved it. The open index signature is how a test hands a handler
 * the rest of a real event — a `dataTransfer` carrying files, say.
 */
export interface FakeEvent {
  type: string;
  target: El;
  preventDefault(): void;
  stopPropagation(): void;
  [key: string]: unknown;
}

export type Listener = (event: FakeEvent) => unknown;

/** An element, or — when `isText` — a text node. */
export class El {
  readonly tagName: string;
  readonly isText: boolean;
  data = '';
  readonly attrs = new Map<string, string>();
  readonly nodes: El[] = [];
  readonly style: Record<string, string> = {};
  private readonly listeners = new Map<string, Listener[]>();
  parentElement: El | null = null;

  // Form-control state. Plain fields, because that is what the panel treats
  // them as: it reads `.value` and writes `.disabled` and never asks the DOM.
  value = '';
  checked = false;
  disabled = false;
  /** What an `<input type="file">` is holding. `null` until a test puts
   *  something there, which is what an untouched picker looks like. */
  files: readonly unknown[] | null = null;

  constructor(tagName: string, isText = false) {
    this.tagName = isText ? '#text' : tagName.toUpperCase();
    this.isText = isText;
  }

  /**
   * `data-*` attributes, the way the panel reads them.
   *
   * Added when the main page became a page: `panel.ts` reads
   * `app.dataset.surface` once at module scope to know which of the two it is
   * drawing, and a stub with no `dataset` would have answered "panel" for both
   * without anything failing.
   */
  get dataset(): Record<string, string | undefined> {
    const attrName = (key: string): string =>
      `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    // A PROXY rather than a snapshot object, because the shell writes as well
    // as reads: `frame()` sets `data-room` and `data-measure` on `#app` for
    // every screen. A plain object would have taken those writes into a value
    // that is thrown away at the end of the expression — the panel would look
    // correct, the browser would be correct, and every test asserting on the
    // room would have been asserting against a stub that quietly dropped it.
    return new Proxy({} as Record<string, string | undefined>, {
      get: (_t, key: string) => this.attrs.get(attrName(key)),
      set: (_t, key: string, value: string) => {
        this.attrs.set(attrName(key), value);
        return true;
      },
      has: (_t, key: string) => this.attrs.has(attrName(key as string)),
      ownKeys: () => [...this.attrs.keys()]
        .filter((k) => k.startsWith('data-'))
        .map((k) => k.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())),
      getOwnPropertyDescriptor: (_t, key: string) => ({
        value: this.attrs.get(attrName(key)), enumerable: true, configurable: true,
      }),
    });
  }

  static text(data: string): El {
    const n = new El('#text', true);
    n.data = data;
    return n;
  }

  // ------------------------------------------------------------- the tree

  get children(): El[] {
    return this.nodes.filter((n) => !n.isText);
  }

  get firstElementChild(): El | null {
    return this.children[0] ?? null;
  }

  get textContent(): string {
    return this.isText ? this.data : this.nodes.map((n) => n.textContent).join('');
  }

  set textContent(value: string) {
    if (this.isText) { this.data = value; return; }
    this.detachAll();
    this.nodes.push(El.text(value));
    this.nodes[0]!.parentElement = this;
  }

  get className(): string { return this.attrs.get('class') ?? ''; }
  set className(value: string) { this.attrs.set('class', value); }

  /**
   * `classList`, because a class the panel adds is state a test should read.
   *
   * The Check screen marks a box `.over` while a file is hovering it and marks
   * a status line `.refused` when a file could not be read. Both are the only
   * record that the handler ran, and `className` string-splicing in the source
   * would have been the alternative — which is exactly the kind of thing a stub
   * should not push a shipped file into.
   */
  get classList(): {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    toggle(name: string, force?: boolean): void;
    contains(name: string): boolean;
  } {
    const parts = (): string[] => this.className.split(/\s+/).filter(Boolean);
    const write = (list: string[]): void => { this.className = list.join(' '); };
    return {
      add: (...names) => write([...new Set([...parts(), ...names])]),
      remove: (...names) => write(parts().filter((c) => !names.includes(c))),
      toggle: (name, force) => {
        const on = force ?? !parts().includes(name);
        write(on ? [...new Set([...parts(), name])] : parts().filter((c) => c !== name));
      },
      contains: (name) => parts().includes(name),
    };
  }

  get id(): string { return this.attrs.get('id') ?? ''; }

  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }

  /**
   * Moving the caret into a field.
   *
   * Modelled because a shortcut that fills the ask box and leaves the caret
   * somewhere else is a shortcut that made the learner reach for the mouse
   * again, and a stub that threw on it made that untestable. It records
   * nothing: what matters is that it exists and does not throw.
   */
  focus(): void {
    const current = (globalThis as Record<string, unknown>)['document'] as
      { activeElement?: El | null } | undefined;
    if (current) current.activeElement = this;
  }

  /** The browser's native validity gate used by email forms. This intentionally
   *  models only constraints shipped by the panel: required and type=email. */
  checkValidity(): boolean {
    if (this.attrs.has('required') && !this.value) return false;
    if (this.attrs.get('type') === 'email' && this.value) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.value);
    }
    return true;
  }

  /** Standard's box sets a placeholder on the note field. Modelled rather than
   *  worked around: an attribute a surface really sets is one a test should be
   *  able to read back. */
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  removeAttribute(name: string): void { this.attrs.delete(name); }

  append(...incoming: El[]): void {
    for (const n of incoming) {
      n.remove();
      n.parentElement = this;
      this.nodes.push(n);
    }
  }

  replaceChildren(...incoming: El[]): void {
    this.detachAll();
    this.append(...incoming);
  }

  /**
   * Putting a node back where it was, rather than at the end.
   *
   * The Results row's Correct control takes itself off screen while the
   * correction form is open and comes back when the form is done with — and it
   * has to come back to the same place, between the result it corrects and the
   * form it opens. `append` would return it below the form, which is a control
   * somewhere else. So the shipped file uses the standard call and the stub
   * models it rather than pushing the source into a workaround.
   */
  insertBefore(node: El, before: El | null): El {
    node.remove();
    node.parentElement = this;
    const at = before ? this.nodes.indexOf(before) : -1;
    if (at >= 0) this.nodes.splice(at, 0, node); else this.nodes.push(node);
    return node;
  }

  remove(): void {
    const siblings = this.parentElement?.nodes;
    if (!siblings) return;
    const i = siblings.indexOf(this);
    if (i >= 0) siblings.splice(i, 1);
    this.parentElement = null;
  }

  private detachAll(): void {
    for (const n of this.nodes) n.parentElement = null;
    this.nodes.length = 0;
  }

  // --------------------------------------------------------- the selectors

  matches(selector: string): boolean {
    return selector.split(',').map((s) => s.trim()).filter(Boolean)
      .some((one) => this.matchesDescendant(one));
  }

  /** `panel.ts` only ever uses single compounds; the descendant form is here
   *  for the assertions (`.ready h2`), which read better than a two-step walk. */
  private matchesDescendant(selector: string): boolean {
    const steps = selector.split(/\s+/).filter(Boolean);
    const own = steps.pop();
    if (!own || !this.matchesOne(own)) return false;
    let node = this.parentElement;
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      while (node && !node.matchesOne(steps[i]!)) node = node.parentElement;
      if (!node) return false;
      node = node.parentElement;
    }
    return true;
  }

  private matchesOne(selector: string): boolean {
    if (this.isText) return false;
    const shape = /^([a-zA-Z][a-zA-Z0-9-]*)?((?:\.[-\w]+|#[-\w]+|\[[^\]]+\])*)$/.exec(selector);
    if (!shape || (!shape[1] && !shape[2])) {
      // Deliberately loud: a stub that shrugged at a selector it did not
      // understand would agree with a handler wired to nothing.
      throw new Error(`panel-dom does not implement the selector "${selector}"`);
    }
    if (shape[1] && shape[1].toUpperCase() !== this.tagName) return false;
    const parts = /\.([-\w]+)|#([-\w]+)|\[([^\]=]+)(?:=("?)([^\]"]*)\4)?\]/g;
    const classes = this.className.split(/\s+/).filter(Boolean);
    let m = parts.exec(shape[2] ?? '');
    while (m) {
      if (m[1] !== undefined && !classes.includes(m[1])) return false;
      if (m[2] !== undefined && this.id !== m[2]) return false;
      if (m[3] !== undefined) {
        const got = this.attrs.get(m[3]);
        if (got === undefined) return false;
        if (m[5] !== undefined && m[0].includes('=') && got !== m[5]) return false;
      }
      m = parts.exec(shape[2] ?? '');
    }
    return true;
  }

  querySelector(selector: string): El | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const deeper = child.querySelector(selector);
      if (deeper) return deeper;
    }
    return null;
  }

  querySelectorAll(selector: string): El[] {
    const out: El[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) out.push(child);
      out.push(...child.querySelectorAll(selector));
    }
    return out;
  }

  // ------------------------------------------------------------- the events

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((a, l) => a + l.length, 0);
  }

  /** Sequential and awaited — see the header. A browser is neither. */
  async fireEvent(type: string, detail: Record<string, unknown> = {}): Promise<void> {
    const event: FakeEvent = {
      type, target: this, preventDefault: () => {}, stopPropagation: () => {}, ...detail,
    };
    for (const fn of [...(this.listeners.get(type) ?? [])]) await fn(event);
  }

  /**
   * What a script-driven press does.
   *
   * The Check screen's file control is a `.link` in front of a hidden
   * `<input type="file">`, and the press goes `button -> picker.click()`. In a
   * browser that opens the OS dialog; here it is the same dispatch every other
   * control gets, which is all the wiring test needs to observe.
   */
  click(): void { void this.fireEvent('click'); }

  /** Enough of a serialiser to read a failing assertion by. */
  get innerHTML(): string {
    return this.nodes.map((n) => (n.isText ? n.data : n.outerHTML)).join('');
  }

  set innerHTML(html: string) {
    this.replaceChildren(...parseHtml(html));
  }

  get outerHTML(): string {
    const attrs = [...this.attrs].map(([k, v]) => ` ${k}="${v}"`).join('');
    const tag = this.tagName.toLowerCase();
    if (VOID.has(this.tagName)) return `<${tag}${attrs}>`;
    return `<${tag}${attrs}>${this.innerHTML}</${tag}>`;
  }
}

// ------------------------------------------------------------------ parsing

const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/** Enough HTML for the panel's templates: nesting, text, entities, void
 *  elements (`<input>`), and bare attributes (`data-add`). */
export function parseHtml(html: string): El[] {
  const roots: El[] = [];
  const open: El[] = [];
  const put = (n: El): void => {
    const parent = open[open.length - 1];
    if (parent) parent.append(n); else roots.push(n);
  };
  const putText = (raw: string): void => {
    if (!raw) return;
    put(El.text(decodeEntities(raw)));
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { putText(html.slice(i)); break; }
    putText(html.slice(i, lt));
    const gt = html.indexOf('>', lt);
    if (gt < 0) { putText(html.slice(lt)); break; }
    const raw = html.slice(lt + 1, gt);
    i = gt + 1;

    if (raw.startsWith('!')) continue;
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toUpperCase();
      for (let k = open.length - 1; k >= 0; k -= 1) {
        if (open[k]!.tagName === name) { open.length = k; break; }
      }
      continue;
    }

    const selfClosed = raw.endsWith('/');
    const inner = selfClosed ? raw.slice(0, -1) : raw;
    const head = /^([a-zA-Z][a-zA-Z0-9-]*)([\s\S]*)$/.exec(inner);
    if (!head) continue;
    const node = new El(head[1]!);
    ATTR.lastIndex = 0;
    let a = ATTR.exec(head[2] ?? '');
    while (a) {
      node.attrs.set(a[1]!, decodeEntities(a[2] ?? a[3] ?? a[4] ?? ''));
      a = ATTR.exec(head[2] ?? '');
    }
    put(node);
    if (!selfClosed && !VOID.has(node.tagName)) open.push(node);
  }

  for (const root of roots) settleFormState(root);
  return roots;
}

/** What the browser does once the markup has landed: a control's parsed
 *  attributes become its live state. */
function settleFormState(node: El): void {
  if (node.tagName === 'INPUT') {
    node.value = node.attrs.get('value') ?? '';
    node.checked = node.attrs.has('checked');
    node.disabled = node.attrs.has('disabled');
  }
  if (node.tagName === 'TEXTAREA') node.value = node.textContent;
  if (node.tagName === 'OPTION') node.value = node.attrs.get('value') ?? node.textContent;
  for (const child of node.children) settleFormState(child);
  if (node.tagName === 'SELECT') {
    const first = node.querySelector('option');
    node.value = first ? first.value : '';
  }
}

// ------------------------------------------------------------- installation

export interface PanelDom {
  /** `#app`, exactly as the html ships it — including the loading class. */
  readonly app: El;
  /** `document.documentElement`, which is where the theme is written. */
  readonly root: El;
  /** The control most recently focused by the panel. */
  readonly activeElement: El | null;
  /** The address currently shown by the page stub. */
  readonly hash: string;
  /** New ordinary-browser tabs opened by the service-hosted page. */
  readonly openedTabs: readonly { url: string; closed: boolean }[];
  /** Move through the stub's real history stack and deliver `popstate`. */
  historyBack(): Promise<void>;
  /** Deliver a window event and return whether the page prevented it. */
  fireWindowEvent(type: string): Promise<{ readonly defaultPrevented: boolean; readonly returnValue: unknown }>;
  uninstall(): void;
}

/**
 * Install a document holding the one element the html provides. The panel
 * grabs it at module scope, so this has to be in place before the import.
 *
 * `surface` is which of the two pages this is. Service-owned `web.html` marks
 * itself `data-surface="page"` and draws the main screen; `panel.html` marks nothing
 * and draws whatever the learner just pressed. The default is the page,
 * because that is where all but a handful of these screens live.
 */
export function installPanelDom(
  surface: 'panel' | 'page' = 'page', routeHash?: string, openFails = false,
): PanelDom {
  const app = new El('DIV');
  app.attrs.set('id', 'app');
  app.attrs.set('class', 'loading');
  if (surface === 'page') app.attrs.set('data-surface', 'page');
  app.append(El.text('Loading…'));

  /**
   * `documentElement` is modelled, not omitted.
   *
   * The theme is set by writing `data-theme` on the root element, which is the
   * one place a stub could quietly have nothing and let a test pass for a
   * control that never worked — which is exactly how a tap that had never once
   * opened the panel kept a green suite for the life of the feature. It is a
   * real `El`, so a test can read back what the learner's press actually did.
   */
  const documentElement = new El('HTML');

  const document = {
    documentElement,
    activeElement: null as El | null,
    getElementById: (id: string): El | null => (id === 'app' ? app : null),
    createElement: (tag: string): El => new El(tag),
  };

  const previous = {
    document: (globalThis as Record<string, unknown>)['document'],
    window: (globalThis as Record<string, unknown>)['window'],
    location: (globalThis as Record<string, unknown>)['location'],
    history: (globalThis as Record<string, unknown>)['history'],
    open: (globalThis as Record<string, unknown>)['open'],
  };
  type WindowListener = (event: Record<string, unknown>) => unknown;
  const listeners = new Map<string, WindowListener[]>();
  const openedTabs: { url: string; closed: boolean }[] = [];
  const tabProxy = (entry: { url: string; closed: boolean }): unknown => ({
    opener: null,
    get closed(): boolean { return entry.closed; },
    location: {
      get href(): string { return entry.url; },
      set href(next: string) { entry.url = String(next); },
    },
    focus: (): void => {},
    close: (): void => { entry.closed = true; },
  });
  const openTab = (url = '', _target = '_blank', _features = ''): unknown => {
    if (openFails) return null;
    const entry = { url, closed: false };
    openedTabs.push(entry);
    return tabProxy(entry);
  };
  const fakeWindow = {
    addEventListener: (type: string, listener: WindowListener): void => {
      const registered = listeners.get(type) ?? [];
      registered.push(listener);
      listeners.set(type, registered);
    },
    open: openTab,
  };
  const fireWindowEvent = async (type: string): Promise<{
    readonly defaultPrevented: boolean;
    readonly returnValue: unknown;
  }> => {
    let prevented = false;
    const event: Record<string, unknown> = {
      type,
      returnValue: undefined,
      preventDefault: () => { prevented = true; },
    };
    for (const listener of [...(listeners.get(type) ?? [])]) await listener(event);
    await settle();
    return { defaultPrevented: prevented, returnValue: event.returnValue };
  };
  const fakeLocation = { hash: routeHash ?? '', origin: 'http://127.0.0.1:8791' };
  const initial = fakeLocation.hash;
  const entries = [initial];
  let cursor = 0;
  const hashFrom = (next: string): string =>
    next.startsWith('#') ? next : new URL(next, fakeLocation.origin).hash;
  const fakeHistory = {
    replaceState: (_state: unknown, _title: string, next: string): void => {
      const hash = hashFrom(next);
      entries[cursor] = hash;
      fakeLocation.hash = hash;
    },
    pushState: (_state: unknown, _title: string, next: string): void => {
      const hash = hashFrom(next);
      entries.splice(cursor + 1);
      entries.push(hash);
      cursor = entries.length - 1;
      fakeLocation.hash = hash;
    },
    back: (): void => {
      if (cursor === 0) return;
      cursor -= 1;
      fakeLocation.hash = entries[cursor]!;
      void fireWindowEvent('popstate');
    },
  };
  const globals: Record<string, unknown> = {
    document, window: fakeWindow, location: fakeLocation, history: fakeHistory, open: openTab,
  };
  Object.assign(globalThis, globals);

  return {
    app,
    root: documentElement,
    get activeElement(): El | null { return document.activeElement; },
    get hash(): string { return fakeLocation.hash; },
    openedTabs,
    historyBack: async () => { fakeHistory.back(); await settle(); },
    fireWindowEvent,
    uninstall: () => { Object.assign(globalThis, previous); },
  };
}

// ------------------------------------------------------------- test helpers

/** Visible text, whitespace collapsed the way a reader sees it. */
export const text = (node: El | null): string =>
  (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

export function find(root: El, selector: string): El {
  const hit = root.querySelector(selector);
  if (!hit) throw new Error(`no ${selector} on screen — screen reads: ${text(root).slice(0, 300)}`);
  return hit;
}

/** The button whose label is exactly this, which is how a learner finds it. */
export function button(root: El, label: string): El {
  const hit = root.querySelectorAll('button').find((b) => text(b) === label);
  if (!hit) {
    const labels = root.querySelectorAll('button').map((b) => text(b));
    throw new Error(`no button labelled "${label}" — screen offers: ${JSON.stringify(labels)}`);
  }
  return hit;
}

/** Click, then let everything the handler kicked off finish. */
export async function click(node: El): Promise<void> {
  await node.fireEvent('click');
  await settle();
}

export const clickButton = async (root: El, label: string): Promise<void> => click(button(root, label));

/** Type into a field the way a learner does: the value changes and the field
 *  says so. The board's search filters on `input` rather than on a submit, so
 *  setting `.value` alone proves nothing about what they would see. */
export async function typeInto(field: El, value: string): Promise<void> {
  field.value = value;
  await field.fireEvent('input');
  await settle();
}

/**
 * A file, the way the panel receives one.
 *
 * Only the four members `upload.ts` reads, so a test can build one out of a
 * string without a `File` constructor and without a temporary directory.
 */
export interface StubFile {
  name: string;
  type?: string;
  size: number;
  webkitRelativePath?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export function stubFile(name: string, bytes: Uint8Array | string, type = ''): StubFile {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return { name, type, size: data.byteLength, arrayBuffer: async () => buffer };
}

/**
 * Let a file read finish.
 *
 * `settle` is sized for a fetch: a handful of microtask turns and one macrotask.
 * Reading a .docx goes through `DecompressionStream` and a `Response` body,
 * which is real stream machinery scheduled across several macrotasks, and a
 * single settle observes an empty textarea and a passing assertion about
 * nothing. Deliberately a fixed number of turns rather than a poll on the
 * value: a helper that waited for the answer it wanted could never fail.
 */
const settleFileRead = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await settle();
};

/** Pick a file through the hidden `<input type="file">`, which is what the
 *  visible control opens. */
export async function pickFile(picker: El, file: StubFile): Promise<void> {
  picker.files = [file];
  await picker.fireEvent('change');
  await settleFileRead();
}

/** Choose a browser folder. The folder picker is still an input change; the
 *  only different fact is that its FileList carries more than one file. */
export async function pickFiles(picker: El, files: readonly StubFile[]): Promise<void> {
  picker.files = [...files];
  await picker.fireEvent('change');
  await settleFileRead();
}

/** Drop a file on a box. The `dataTransfer` shape is the browser's. */
export async function dropFile(target: El, file: StubFile): Promise<void> {
  await target.fireEvent('drop', { dataTransfer: { files: [file] } });
  await settleFileRead();
}
