export interface ReusableTab {
  /** Focus or restore this exact destination. False means the tab is gone. */
  reuse(url: string): Promise<boolean>;
}

/** Owns only tabs Virgil created itself; it never enumerates browser history. */
export class ReusableTabSet {
  readonly #tabs = new Map<string, ReusableTab>();

  async open(
    key: string | null,
    url: string,
    create: (url: string) => Promise<ReusableTab>,
  ): Promise<'opened' | 'reused'> {
    const previous = key === null ? undefined : this.#tabs.get(key);
    if (previous && await previous.reuse(url)) return 'reused';
    const opened = await create(url);
    if (key !== null) this.#tabs.set(key, opened);
    return 'opened';
  }
}

type Surface = 'panel' | 'page';

/** Safe external-tab behavior shared by the hosted page and extension panel. */
export class BrowserTabs {
  readonly #tabs = new ReusableTabSet();

  constructor(readonly surface: Surface) {}

  async open(url: string, reuseKey: string | null = null): Promise<'opened' | 'reused'> {
    return await this.#tabs.open(reuseKey, url, async (destination) => {
      if (this.surface === 'page') {
        const opened = window.open(destination, '_blank');
        if (!opened) throw new Error('the browser blocked the new tab');
        opened.opener = null;
        return {
          // A disowned cross-origin tab cannot be focused safely from a web
          // page. Knowing it is still open is enough to avoid making copies;
          // the check-in tells the learner to return to that earlier tab.
          reuse: async () => !opened.closed,
        };
      }

      const opened = await chrome.tabs.create({ url: destination });
      return {
        reuse: async (next) => {
          if (opened.id === undefined) return false;
          try {
            // The id came from our own create call. Updating it reads no tab
            // title, URL, history or neighbour and needs no `tabs` permission.
            await chrome.tabs.update(opened.id, { url: next, active: true });
            return true;
          } catch {
            return false;
          }
        },
      };
    });
  }
}
