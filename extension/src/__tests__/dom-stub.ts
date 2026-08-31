/**
 * A DOM small enough to test capture against, and an honest imitation of the
 * `executeScript` boundary.
 *
 * There is no jsdom here on purpose: the repo takes no runtime dependencies and
 * capture only touches a dozen DOM surfaces. What matters is that the function
 * runs the way Chrome actually runs it — source serialised, no scope — which is
 * what `acrossExecuteScriptBoundary` reproduces (D3).
 */

export interface NodeInit {
  tag: string;
  text?: string;
  attrs?: Record<string, string>;
  children?: FakeNode[];
  /**
   * Live properties rather than attributes — `currentTime`, `muted`,
   * `clientWidth`. A `<video>` element's state is not in its markup, and SB-10's
   * whole question is what the player was doing at the moment of the gesture.
   */
  props?: Record<string, unknown>;
}

export class FakeNode {
  readonly tagName: string;
  readonly attrs: Record<string, string>;
  readonly children: FakeNode[];
  parentElement: FakeNode | null = null;
  private readonly ownText: string;

  constructor(init: NodeInit) {
    this.tagName = init.tag.toUpperCase();
    this.ownText = init.text ?? '';
    this.attrs = init.attrs ?? {};
    this.children = init.children ?? [];
    for (const c of this.children) c.parentElement = this;
    Object.assign(this, init.props ?? {});
  }

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }

  get previousElementSibling(): FakeNode | null {
    const sibs = this.parentElement?.children ?? [];
    const i = sibs.indexOf(this);
    return i > 0 ? sibs[i - 1] ?? null : null;
  }

  /** Enough of a selector engine for `tag`, `tag[attr="value"]`, `[attr="value"]`
   *  and comma-separated lists of those. Nothing else is used by capture. */
  matches(selector: string): boolean {
    return selector.split(',').map((s) => s.trim()).filter(Boolean).some((one) => {
      // Digits in the tag, because `H1`..`H6` are tags and a matcher that
      // silently answered false for them would have made the Selector look
      // like it deliberately skipped headings.
      const m = /^([a-zA-Z][a-zA-Z0-9]*)?(?:\[([a-zA-Z-]+)(?:="([^"]*)")?\])?$/.exec(one);
      if (!m) return false;
      const [, tag, attr, value] = m;
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      if (attr) {
        const got = this.attrs[attr];
        if (got === undefined) return false;
        if (value !== undefined && got !== value) return false;
      }
      return true;
    });
  }

  /** The Selector asks whether one pick is inside another, so that picking a
   *  paragraph and then the article around it does not pin the same words
   *  twice. A real element answers this; so does this one. */
  contains(other: FakeNode | null): boolean {
    for (let el: FakeNode | null = other; el; el = el.parentElement) if (el === this) return true;
    return false;
  }

  closest(selector: string): FakeNode | null {
    let el: FakeNode | null = this;
    while (el) {
      if (el.matches(selector)) return el;
      el = el.parentElement;
    }
    return null;
  }

  querySelector(selector: string): FakeNode | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const deeper = child.querySelector(selector);
      if (deeper) return deeper;
    }
    return null;
  }

  /** Document order, like the real one. A container that matches is returned
   *  as well as its descendants — capture reads `<video>`, which has none. */
  querySelectorAll(selector: string): FakeNode[] {
    const found: FakeNode[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }

  find(tag: string): FakeNode {
    const hit = this.tagName === tag.toUpperCase() ? this : this.querySelector(tag);
    if (!hit) throw new Error(`no <${tag}> in the fixture`);
    return hit;
  }

  // Properties capture reads off specific elements.
  get href(): string { return this.attrs['href'] ?? ''; }
  get content(): string { return this.attrs['content'] ?? ''; }
  get lang(): string { return this.attrs['lang'] ?? ''; }
}

export const node = (init: NodeInit): FakeNode => new FakeNode(init);

export interface FakeSelection {
  text: string;
  /** Where the selection starts — drives the heading path. */
  startContainer?: FakeNode;
  /** Where it sits — drives the surrounding text. */
  commonAncestorContainer?: FakeNode;
}

export interface PageInit {
  title?: string;
  url?: string;
  hostname?: string;
  lang?: string;
  /** `document.contentType`. `application/pdf` for a tab showing a PDF (SB-11). */
  contentType?: string;
  /** Everything under <body>. */
  body: FakeNode;
  /** Things that live in <head> — canonical link, og:site_name meta. */
  head?: FakeNode[];
  selection?: FakeSelection | null;
}

/** Installs the page as globals and returns the undo. */
export function installPage(page: PageInit): () => void {
  const head = node({ tag: 'head', children: page.head ?? [] });
  const documentElement = node({ tag: 'html', attrs: { lang: page.lang ?? '' }, children: [head, page.body] });

  const selection = page.selection;
  const range = selection
    ? {
        startContainer: selection.startContainer ?? page.body,
        commonAncestorContainer: selection.commonAncestorContainer ?? selection.startContainer ?? page.body,
      }
    : null;

  const document = {
    title: page.title ?? '',
    contentType: page.contentType ?? 'text/html',
    documentElement,
    body: page.body,
    querySelector: (sel: string): FakeNode | null => documentElement.querySelector(sel),
    querySelectorAll: (sel: string): FakeNode[] => documentElement.querySelectorAll(sel),
  };

  const win = {
    getSelection: () => (selection
      ? {
          toString: () => selection.text,
          rangeCount: selection.text.length ? 1 : 0,
          getRangeAt: () => range,
        }
      : null),
  };

  const previous = {
    document: (globalThis as Record<string, unknown>)['document'],
    window: (globalThis as Record<string, unknown>)['window'],
    location: (globalThis as Record<string, unknown>)['location'],
    Element: (globalThis as Record<string, unknown>)['Element'],
  };

  Object.assign(globalThis, {
    document,
    window: win,
    location: { href: page.url ?? 'https://example.test/page', hostname: page.hostname ?? 'example.test' },
    // capture does `anchor instanceof Element`, and in the page Element is a global.
    Element: FakeNode,
  });

  // `location.hash` is where Chrome's PDF viewer says which page is open, when
  // it says anything at all (SB-11), so it is split off the url the way the
  // real one is rather than being a field of its own.
  const url = page.url ?? 'https://example.test/page';
  const hashAt = url.indexOf('#');
  Object.assign((globalThis as Record<string, unknown>)['location'] as object, {
    hash: hashAt < 0 ? '' : url.slice(hashAt),
  });

  return () => { Object.assign(globalThis, previous); };
}

/**
 * What Chrome does to a function passed as `func`: it serialises the source and
 * evaluates it in the page, so the function arrives with no closure and no
 * module scope — only globals. D3 is the toast half of this lesson; the same
 * rule silently breaks any injected function that leans on a module-level
 * helper, which is why capture is tested through here rather than called
 * directly.
 */
export function acrossExecuteScriptBoundary<T>(fn: () => T): () => T {
  const rebuilt: unknown = Function(`"use strict"; return (${fn.toString()});`)();
  return rebuilt as () => T;
}
