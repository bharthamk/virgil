/**
 * Content-script capture.
 *
 * SB-46 is why this is fat: re-fetch fails on gated pages, so what we grab here
 * has to be good enough to teach from on its own. Cheap to over-collect now,
 * impossible to recover later.
 */
/**
 * One block of the pinned material, in document order.
 *
 * The domain type (`CapturePart`) allows `my-answer`, `correct-answer`, `error`
 * and `fix` as well, and the seed corpus uses them. Capture emits only
 * `passage`, and deliberately: those other roles say something about what the
 * learner was doing, and nothing on the page can tell us that. Inventing them
 * from position or punctuation would be fabricating evidence in the one field
 * the Analyst is told to reason about a *delta* from (SB-14). When there is a
 * capture affordance that lets the learner say "this half was my answer", it
 * fills in here; until then the honest role is `passage`.
 */
export interface CapturedPart {
  role: 'passage';
  text: string;
}

/**
 * SB-10: where the playhead was when the learner reached for the hotkey.
 *
 * `player` is how the timestamp was read, not a brand: it is what decides
 * whether a link can carry the moment, and only some sites have a convention
 * for that. `core/src/domain/video.ts` builds one where the convention is real
 * and refuses to invent one anywhere else.
 */
export interface CapturedVideoMoment {
  timestampSeconds: number;
  player: 'youtube' | 'html5';
}

export interface CapturedEnvelope {
  /**
   * Was the selection listener present on this page when the pin was made?
   *
   * Not part of the pin. Stripped by `buildPinBody`, because it is a fact
   * about this browser at this moment and the ledger stores facts about
   * material. It exists so the worker can tell the difference between "the
   * learner selected one word" and "nothing was watching, so one word is all
   * the browser left behind", which look identical from here.
   */
  selectionWatched?: boolean;
  /** True only when this right-click gesture was observed shortening the
   *  selection and the pre-menu passage was restored. Browser-only state,
   *  stripped before storage and used for one transparent confirmation line. */
  selectionRecovered?: boolean;
  selection: string | null;
  /**
   * The material, as blocks rather than as one run of text. Required by the
   * domain type, read by the Clusterer and the Analyst, and — until this was
   * populated — never emitted, so a pin made through the extension crashed the
   * cluster stage on `parts.map` and a board built by real pinning never got
   * topics at all.
   *
   * Nothing new is collected: every character here is already inside
   * `surroundingText`. This is that same text with the page's own block
   * boundaries kept instead of flattened away.
   */
  parts: CapturedPart[];
  surroundingText: string;
  headingPath: string[];
  pageTitle: string;
  url: string;
  canonicalUrl: string | null;
  siteName: string | null;
  contentLanguage: string | null;
  /** SB-10. Null on every page with nothing playing, which is most of them. */
  videoMoment: CapturedVideoMoment | null;
  /**
   * SB-11: what kind of document this is.
   *
   * Only two values, and they are not a taxonomy — they are the answer to one
   * question the worker has to ask: may an empty capture be stored? A thin HTML
   * page is a legitimate whole-page pin the Forager will re-fetch this run; a
   * PDF whose viewer hands over nothing is a pin that will never have anything
   * in it.
   */
  documentKind: 'html' | 'pdf';
  /** SB-11: which page of the PDF, where the viewer says. Usually it does not. */
  pdfPage: number | null;
}

/**
 * D3, the wider form of it: Chrome serialises an injected function across the
 * `executeScript` boundary, so it arrives in the page with no scope of its own.
 * A closure cannot survive that — and neither can a reference to anything at
 * module scope. Every helper this function needs is therefore declared *inside*
 * it. It looks redundant next to the identical walk in `reread-core.ts`; it is
 * not, and the two must not be merged. `capture-envelope.test.ts` reconstructs
 * this function the way Chrome does and will fail if a free variable creeps in.
 */
export function capture(
  recoverMenuSelection: boolean = true,
  pickerVisibleSelection: string | null = null,
): CapturedEnvelope {
  const BLOCK = 'P,LI,PRE,BLOCKQUOTE,TD,DD,SECTION,ARTICLE,DIV';

  /** Text a reader can see. `textContent` includes stylesheet and script text
   *  inside page containers — Wikipedia's hatnotes are a common example — and
   *  that hidden implementation detail must never become learning material. */
  const visibleText = (el: Element | null): string => {
    if (!el) return '';
    const rendered = (el as HTMLElement).innerText;
    return (typeof rendered === 'string' ? rendered : el.textContent ?? '')
      .replace(/\s+/g, ' ').trim();
  };

  /**
   * Where this sits inside a body of knowledge (SB-06), read in document order.
   *
   * It used to climb the ancestors and look at each one's previous siblings.
   * That finds a heading only where the markup puts it as a sibling of the
   * block or of one of its containers, which is how a document is written and
   * is not how most pages are built. On a real course site it found nothing at
   * all: **fourteen of the first sixteen pins anybody made carried an empty
   * heading path**, so the strongest structural signal the topic model gets
   * was blank and nobody could see that it was.
   *
   * So it reads the page the way a person does. Every heading before the
   * passage, in order, and then the breadcrumb is built backwards from the
   * nearest one, each step strictly shallower than the last: an `H3` under an
   * `H2` under an `H1` gives all three, and an `H3` after another `H3` gives
   * only the nearer.
   *
   * One pass, stopping at the passage, so a long page costs the part above the
   * selection and nothing below it.
   */
  const HEADING_TEXT_MAX = 120;
  const HEADING_PATH_MAX = 6;

  const headingPathFor = (node: Node | null): string[] => {
    const anchor = (node instanceof Element ? node : node?.parentElement) ?? null;
    if (!anchor) return [];

    const seen: { level: number; text: string }[] = [];
    let reached = false;
    const walk = (el: Element): void => {
      if (reached) return;
      if (el === anchor) { reached = true; return; }
      const m = /^H([1-6])$/.exec(el.tagName);
      if (m?.[1]) {
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text) seen.push({ level: Number(m[1]), text: text.slice(0, HEADING_TEXT_MAX) });
      }
      for (const child of Array.from(el.children ?? [])) {
        walk(child as Element);
        if (reached) return;
      }
    };
    walk(document.body);

    const path: string[] = [];
    let want = 7;
    for (let i = seen.length - 1; i >= 0; i -= 1) {
      const h = seen[i]!;
      if (h.level < want) { path.unshift(h.text); want = h.level; }
    }
    return path.slice(-HEADING_PATH_MAX);
  };

  /** The group of blocks a selection sits inside — its parent, not the block
   *  itself, because the sentence before and after is most of the context. */
  const blockParentFor = (range: Range | null): Element => {
    const anchor = range?.commonAncestorContainer ?? document.body;
    const block = (anchor instanceof Element ? anchor : anchor.parentElement)?.closest(BLOCK);
    return block?.parentElement ?? document.body;
  };

  const surroundingFor = (range: Range | null): string =>
    visibleText(blockParentFor(range)).slice(0, 4000);

  /** Whole-page pins (SB-07) are legitimate and common — we must not push the
   *  user to pre-curate, so no selection is a first-class case, not an error. */
  const readableRoot = (): Element =>
    document.querySelector('article, main, [role="main"]') ?? document.body;

  const readablePage = (): string =>
    visibleText(readableRoot()).slice(0, 8000);

  /**
   * The same material, kept as the blocks the page itself drew.
   *
   * Innermost wins: a block whose descendants are themselves blocks is a
   * container, and emitting both it and its children would say the same thing
   * twice — which the Clusterer would then weigh twice. Short blocks are
   * dropped because at this size they are navigation, bylines and captions, not
   * the reading.
   */
  const partsUnder = (root: Element): { role: 'passage'; text: string }[] => {
    const PART_BLOCK = 'P,LI,PRE,BLOCKQUOTE,DD,TD';
    const MIN_PART_CHARS = 40;
    const MAX_PARTS = 6;
    const MAX_PART_CHARS = 500;

    const found: string[] = [];
    const walk = (el: Element): boolean => {
      let deeper = false;
      for (const child of Array.from(el.children)) if (walk(child)) deeper = true;
      if (deeper) return true;
      if (!el.matches(PART_BLOCK)) return false;
      const text = visibleText(el);
      if (text.length < MIN_PART_CHARS) return false;
      found.push(text.slice(0, MAX_PART_CHARS));
      return true;
    };
    for (const child of Array.from(root.children)) walk(child);
    return found.slice(0, MAX_PARTS).map((text) => ({ role: 'passage' as const, text }));
  };

  /**
   * SB-10 — the moment, if the learner was watching something.
   *
   * Every guard here exists to avoid inventing one. A page with a muted looping
   * hero video is not a page somebody is watching, and a pin on its text that
   * claimed a moment would send the learner back to second fourteen of a
   * background animation with a confident "at 0:14" beside it. Fail closed: no
   * moment is a pin that says nothing about video, which is the truth on almost
   * every page.
   */
  const videoMomentAt = (): CapturedVideoMoment | null => {
    // Exactly this host or a subdomain of it. `notyoutube.com` and
    // `youtube.com.evil.test` both contain the string, and the cost of reading
    // either as YouTube is a link built to a convention the site does not have.
    const host = (domain: string): boolean =>
      location.hostname === domain || location.hostname.endsWith(`.${domain}`);

    let best: HTMLVideoElement | null = null;
    let bestArea = -1;
    for (const el of Array.from(document.querySelectorAll('video'))) {
      const video = el as HTMLVideoElement;
      const at = Number(video.currentTime);
      // Not started is not a moment; NaN and Infinity survive arithmetic
      // silently and would render as a timestamp nobody can go to.
      if (!Number.isFinite(at) || at <= 0) continue;
      // Muted and looping is the signature of a hero animation rather than of
      // something being watched — and it is the video most likely to be playing
      // on a page whose text is the actual pin.
      if (video.muted && video.loop) continue;
      const area = (Number(video.clientWidth) || 0) * (Number(video.clientHeight) || 0);
      // A player with no size on screen is a preload, an audio element wearing
      // a video tag, or something offscreen. None of them is being watched.
      if (area <= 0) continue;
      if (area > bestArea) { best = video; bestArea = area; }
    }
    if (!best) return null;

    return {
      // Whole seconds: no link seeks to a fraction and no player shows one.
      timestampSeconds: Math.floor(Number(best.currentTime)),
      player: host('youtube.com') || host('youtu.be') ? 'youtube' : 'html5',
    };
  };

  /**
   * SB-11 — is this a PDF, and which page of it?
   *
   * Two signals because they fail in different places. `document.contentType`
   * is what a tab showing a PDF reports and is the reliable one; the `<embed>`
   * is what a page that hosts the plugin itself looks like, whatever it claims
   * to be.
   *
   * The page number comes off the fragment, which is where the PDF open-
   * parameter convention puts it. Chrome's viewer reads `#page=N` on the way in
   * and does not write one as the reader scrolls, so this is populated for a
   * paper opened at a page and null for one scrolled to it. Null is the honest
   * answer there: reporting page 1 as though it were where they were reading
   * would be worse than admitting we do not know.
   */
  const isPdf = (): boolean =>
    document.contentType === 'application/pdf'
    || !!document.querySelector('embed[type="application/pdf"]');

  const pdfPageFrom = (hash: string): number | null => {
    const found = /(?:^#|&)page=(\d+)/.exec(hash);
    const page = found ? Number(found[1]) : Number.NaN;
    return Number.isInteger(page) && page > 0 ? page : null;
  };

  const pdf = isPdf();

  /**
   * The selection, after the right-click may already have destroyed it.
   *
   * Right-clicking a word outside the current selection replaces the selection
   * with that word, on mousedown, before the menu opens. Both the live
   * selection and Chrome's own `info.selectionText` are the word by the time
   * anything of ours runs, so the passage is recovered from what
   * `selection-memory.ts` was watching rather than read from the page.
   *
   * The snapshot is taken at the capture-phase mousedown of the right button,
   * before the collapse, so nothing here has to infer anything: if there was a
   * selection when the menu was summoned and what survives is shorter, the
   * shorter one is the browser's doing.
   *
   * Spelled out rather than imported, like everything else in this function:
   * it is serialised across the `executeScript` boundary and an imported
   * binding would be `undefined` on the other side (D3). `selection-memory.
   * test.ts` asserts this key and that module still agree, and the rule itself
   * lives there where it can be tested without a browser.
   */
  const live = window.getSelection();
  const liveText = live?.toString().trim() ?? '';
  const liveRange = live && live.rangeCount > 0 ? live.getRangeAt(0) : null;

  const memory = (globalThis as unknown as {
    __sbSelectionMemory?: { atMenu: {
      text: string; range: Range; at: number; collapsedAtMenu?: boolean;
    } | null };
  }).__sbSelectionMemory;

  // Is anything watching on this page at all? A content script does not enter
  // a tab that was already open when the extension loaded, and on such a page
  // there is no snapshot and never was. The worker uses this to fix the page
  // for next time and to say so, rather than quietly pinning a word.
  const selectionWatched = !!memory;

  const recovered = ((): { text: string; range: Range } | null => {
    const held = memory?.atMenu;
    const had = held?.text.trim() ?? '';
    if (!held || !had) return null;
    if (!recoverMenuSelection || held.collapsedAtMenu !== true) return null;
    if (Date.now() - held.at > 60_000) return null;
    // Shorter is the browser's doing; equal or longer is the learner's.
    if (had.length <= liveText.length) return null;
    return { text: had, range: held.range };
  })();

  const cleanPickerText = typeof pickerVisibleSelection === 'string'
    ? pickerVisibleSelection.replace(/\s+/g, ' ').trim()
    : '';
  const text = recovered?.text ?? (cleanPickerText || liveText);
  const range = recovered?.range ?? liveRange;
  const hasSelection = text.length > 0;
  // One context menu gets one recovery. A later hotkey, picker or menu must
  // never inherit an earlier gesture's workaround.
  if (memory) memory.atMenu = null;

  const meta = (name: string): string | null =>
    document.querySelector<HTMLMetaElement>(`meta[property="${name}"], meta[name="${name}"]`)?.content ?? null;

  return {
    selectionWatched,
    selectionRecovered: !!recovered,
    selection: hasSelection ? text : null,
    parts: partsUnder(hasSelection ? blockParentFor(range) : readableRoot()),
    surroundingText: hasSelection ? surroundingFor(range) : readablePage(),
    headingPath: hasSelection ? headingPathFor(range?.startContainer ?? null) : [],
    pageTitle: document.title,
    url: location.href,
    canonicalUrl: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? null,
    siteName: meta('og:site_name') ?? location.hostname,
    // D9: Forager re-fetches this page hours later and must be able to tell it
    // got the same language back. Load-bearing, not decoration.
    contentLanguage: document.documentElement.lang || null,
    // SB-10: captured now because by the nightly the tab is closed and the
    // playhead is nowhere.
    videoMoment: videoMomentAt(),
    documentKind: pdf ? 'pdf' : 'html',
    // Only read where the convention exists: `#page=2` on an HTML page is an
    // ordinary anchor and says nothing about any page of anything.
    pdfPage: pdf ? pdfPageFrom(location.hash) : null,
  };
}
