import { newClientRef } from './pin-body.js';
import {
  appendText, pageFormatOf, readPages, readUpload, VISION_UPLOAD_ACCEPT,
  type UploadFile,
} from './upload.js';

export interface PinSummary {
  id: string; type: 'interest' | 'struggle'; label: string; note: string | null;
  capturedAt: string; topicId: string | null; topicLabel: string | null;
  status: 'new' | 'processed';
  source: { text: string; kind: string; pageTitle: string; url: string | null };
}
export interface PinsRead { pins: PinSummary[] }

/** Firestore's single-field ceiling is just over one million bytes. A data URI
 *  is already encoded text, so this cap applies to the exact stored string. */
export const PIN_IMAGE_WIRE_CHARS = 980_000;

export interface PinsLessonRoute {
  readonly label: string;
  readonly readiness: 'ready' | 'needs-setup' | 'unreachable' | 'not-checked';
}

type ReadResult<T> =
  | { readonly kind: 'ok'; readonly body: T }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'refused'; readonly status?: number | null };

export interface PinsFaceShell {
  read(): Promise<ReadResult<PinsRead>>;
  save(body: Record<string, unknown>): Promise<ReadResult<{ id: string; label: string }>>;
  remove(pin: PinSummary): Promise<ReadResult<{ ok: boolean }>>;
  addToBoard(pin: PinSummary): Promise<ReadResult<{ ok: boolean; topicId: string; label: string }>>;
  lessonRoute(): Promise<PinsLessonRoute>;
  openModels(): void;
  learn(pin: PinSummary): void;
  routes(pin: PinSummary): HTMLElement;
  board(): void;
}

const el = (html: string): HTMLElement => {
  const node = document.createElement('div');
  node.innerHTML = html.trim();
  return node.firstElementChild as HTMLElement;
};

const cleanTitle = (
  supplied: string, material: string, fileName: string | null, sourceUrl: string,
): string => {
  const explicit = supplied.replace(/\s+/g, ' ').trim();
  if (explicit) return Array.from(explicit).slice(0, 120).join('');
  const firstLine = material.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  if (firstLine) return Array.from(firstLine).slice(0, 80).join('');
  if (fileName) return fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 120);
  try { return new URL(sourceUrl).hostname.replace(/^www\./, '').slice(0, 120); } catch { /* no url */ }
  return 'Saved material';
};

const safeHttpUrl = (value: string | null): string | null => {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch { return null; }
};

let justSaved: string | null = null;
let justBoarded: { label: string } | null = null;

function intakeForm(shell: PinsFaceShell, redraw: () => Promise<void>): HTMLElement {
  const form = el(`<form class="pins-intake" data-pins-intake data-guide-section="capture-form">
    <div class="pins-intake-heading">
      <div><span class="take-label">Add something</span><h2 id="pins-intake-title">Keep it now. Decide what it becomes later.</h2></div>
      <p>Paste text or a link, or add a document or image with context. Saving does not generate a lesson.</p>
    </div>
    <div class="pins-intake-grid">
      <label><span>Title <em>(optional)</em></span><input name="pin-title" maxlength="120" placeholder="What should Virgil call this?"></label>
      <label><span>Source link <em>(optional)</em></span><input name="pin-url" type="url" placeholder="https://…"></label>
      <label class="pins-intake-wide"><span>What are you keeping?</span><textarea name="pin-material" rows="5" placeholder="Paste a passage, an idea, or a question"></textarea></label>
      <label class="pins-intake-wide"><span>Your context <em>(optional)</em></span><textarea name="pin-note" rows="3" maxlength="1000" placeholder="Why this matters, or what is confusing"></textarea></label>
      <label><span>Save as</span><select name="pin-type"><option value="interest">Something I want to learn</option><option value="struggle">Something I am stuck on</option></select></label>
      <label class="pins-file"><span>Attach <em>(optional)</em></span><input name="pin-file" type="file"><small>Text, Markdown, Word, PDF, PNG or JPEG.</small></label>
    </div>
    <div class="pins-intake-actions"><button class="primary" type="submit">Add to Pins</button><p role="status" aria-live="polite"></p></div>
  </form>`);
  const title = form.querySelector('[name="pin-title"]') as HTMLInputElement;
  const url = form.querySelector('[name="pin-url"]') as HTMLInputElement;
  const material = form.querySelector('[name="pin-material"]') as HTMLTextAreaElement;
  const note = form.querySelector('[name="pin-note"]') as HTMLTextAreaElement;
  const type = form.querySelector('[name="pin-type"]') as HTMLSelectElement;
  const file = form.querySelector('[name="pin-file"]') as HTMLInputElement;
  const save = form.querySelector('button[type="submit"]') as HTMLButtonElement;
  const status = form.querySelector('[role="status"]') as HTMLElement;
  file.setAttribute('accept', VISION_UPLOAD_ACCEPT);
  let imageRef: string | null = null;
  let fileName: string | null = null;

  file.addEventListener('change', async () => {
    imageRef = null;
    fileName = null;
    const picked = file.files?.[0] as (File & UploadFile) | undefined;
    if (!picked) { status.textContent = ''; return; }
    fileName = picked.name;
    save.disabled = true;
    status.textContent = `Reading ${picked.name}…`;
    if (pageFormatOf(picked.name, picked.type) === 'image') {
      const rendered = await readPages(picked);
      if (rendered.kind === 'pages' && rendered.pages[0]
        && rendered.pages[0].length <= PIN_IMAGE_WIRE_CHARS) {
        imageRef = rendered.pages[0];
        status.textContent = `${picked.name} is attached. Add a title or context so Virgil knows what matters.`;
      } else if (rendered.kind === 'pages') {
        status.textContent = `${picked.name} is too detailed to store as a pin. Try a smaller image.`;
      } else status.textContent = `I could not read ${picked.name}. Nothing has been saved.`;
    } else {
      const read = await readUpload(picked);
      if (read.kind === 'text') {
        material.value = appendText(material.value, read.text);
        status.textContent = `${picked.name} is in the text box. You can edit it before saving.`;
      } else if (read.kind === 'no-text') {
        status.textContent = `${picked.name} has no selectable text. Nothing has been attached.`;
      } else status.textContent = `I could not read ${picked.name}. Nothing has been attached.`;
    }
    save.disabled = false;
  });

  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    const text = material.value.trim();
    const context = note.value.trim();
    const sourceUrl = url.value.trim();
    if (!text && !imageRef && !sourceUrl) {
      status.textContent = 'Add some text, a link, or an image first.';
      material.focus();
      return;
    }
    const canonicalUrl = safeHttpUrl(sourceUrl);
    if (sourceUrl && !canonicalUrl) {
      status.textContent = 'Use a complete http:// or https:// source link.';
      url.focus();
      return;
    }
    const label = cleanTitle(title.value, text, fileName, sourceUrl);
    const evidence = text || context || label;
    const siteName = canonicalUrl ? new URL(canonicalUrl).hostname.replace(/^www\./, '') : 'Virgil';
    save.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status.textContent = 'Saving to Pins…';
    const made = await shell.save({
      type: type.value, label, note: context || null,
      capturedAt: new Date().toISOString(), clientRef: newClientRef(),
      envelope: {
        selection: evidence, parts: [{ role: 'passage', text: evidence }],
        surroundingText: text || context, headingPath: [], pageTitle: label,
        url: canonicalUrl ?? 'virgil:pins', canonicalUrl, siteName,
        contentLanguage: document.documentElement.lang || null,
        media: imageRef ? { kind: 'image', ref: imageRef } : null,
      },
    });
    if (made.kind !== 'ok') {
      form.removeAttribute('aria-busy');
      save.disabled = false;
      status.textContent = made.kind === 'refused'
        ? 'Virgil could not save that pin. Nothing was changed.'
        : 'Virgil is not reachable. Nothing was saved.';
      return;
    }
    justSaved = made.body.id;
    justBoarded = null;
    await redraw();
  };
  form.addEventListener('submit', (event) => { void submit(event); });
  save.addEventListener('click', (event) => { void submit(event); });
  return form;
}

function intakePopup(shell: PinsFaceShell, redraw: () => Promise<void>): HTMLElement {
  const node = el(`<div class="pins-add" data-guide-target="capture-entry">
    <div class="pins-add-bar">
      <button class="primary" type="button" data-open-pin-intake>Add pin</button>
      <p>Keep something now; decide what it becomes later.</p>
    </div>
    <div class="pins-overlay" data-pins-dialog hidden>
      <section class="pins-dialog" role="dialog" aria-modal="true" aria-labelledby="pins-intake-title">
        <button class="pins-dialog-close" type="button" aria-label="Close add pin" data-close-pin-intake>×</button>
        <div data-pins-dialog-body></div>
      </section>
    </div>
  </div>`);
  const open = node.querySelector('[data-open-pin-intake]') as HTMLButtonElement;
  const overlay = node.querySelector('[data-pins-dialog]') as HTMLElement;
  const close = node.querySelector('[data-close-pin-intake]') as HTMLButtonElement;
  const body = node.querySelector('[data-pins-dialog-body]') as HTMLElement;
  const form = intakeForm(shell, redraw);
  body.append(form);

  const dismiss = (): void => {
    overlay.setAttribute('hidden', '');
    open.focus();
  };
  open.addEventListener('click', () => {
    overlay.removeAttribute('hidden');
    (form.querySelector('[name="pin-title"]') as HTMLInputElement).focus();
  });
  close.addEventListener('click', dismiss);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) dismiss();
  });
  overlay.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape') dismiss();
  });
  return node;
}

const lessonRouteLine = (route: PinsLessonRoute): string => {
  switch (route.readiness) {
    case 'ready': return `${route.label} · ready for this lesson`;
    case 'unreachable': return `${route.label} · not connected`;
    case 'not-checked': return `${route.label} · connection not checked`;
    case 'needs-setup':
    default: return `${route.label} · setup needed`;
  }
};

function pinCard(
  pin: PinSummary, shell: PinsFaceShell, redraw: () => Promise<void>, initialRoute: PinsLessonRoute,
): HTMLElement {
  const card = el(`<article class="pins-item" data-guide-target="captured-item" data-guide-section="source-pin">
    <div class="pins-item-head"><div><span class="pins-state"></span><h3></h3></div><div class="pins-item-meta"><time></time><button class="pins-remove" type="button" data-remove aria-label="Remove pin" title="Remove pin">×</button></div></div>
    <p class="pins-excerpt"></p><button class="link pins-more" type="button" data-more>Show more</button><p class="pins-note"></p><div class="pins-source"></div>
    <div class="pins-learn"><div class="pins-actions"><button data-board-pin>Add to Board</button><button data-learn>Learn with Virgil</button></div><div class="pins-model-route"><span data-lesson-route></span><button class="link" type="button" data-open-models>Open Models</button></div><span class="pins-board-status" role="status" aria-live="polite"></span></div>
    <div class="pins-remove-confirm" data-remove-confirm hidden><span>Remove this pin?</span><button type="button" data-remove-now>Remove</button><button class="link" type="button" data-remove-cancel>Keep it</button><span class="pins-remove-status" role="status" aria-live="polite"></span></div>
  </article>`);
  if (pin.id === justSaved) card.setAttribute('data-just-saved', 'true');
  (card.querySelector('h3') as HTMLElement).textContent = pin.label;
  const state = card.querySelector('.pins-state') as HTMLElement;
  state.textContent = pin.type === 'struggle' ? 'Stuck on this' : 'Want to learn';
  state.setAttribute('data-kind', pin.type);
  const when = card.querySelector('time') as HTMLElement;
  const date = new Date(pin.capturedAt);
  when.textContent = Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' }).format(date) : '';
  const excerpt = card.querySelector('.pins-excerpt') as HTMLElement;
  excerpt.textContent = pin.source.text;
  const more = card.querySelector('[data-more]') as HTMLButtonElement;
  if (!pin.source.text) {
    excerpt.remove();
    more.remove();
  } else if (Array.from(pin.source.text).length <= 220) {
    more.remove();
  } else {
    more.addEventListener('click', () => {
      const expanded = card.getAttribute('data-expanded') === 'true';
      if (expanded) card.removeAttribute('data-expanded');
      else card.setAttribute('data-expanded', 'true');
      more.textContent = expanded ? 'Show more' : 'Show less';
    });
  }
  const own = card.querySelector('.pins-note') as HTMLElement;
  own.textContent = pin.note ? `Your context: ${pin.note}` : '';
  if (!pin.note) own.remove();
  const source = card.querySelector('.pins-source') as HTMLElement;
  const href = safeHttpUrl(pin.source.url);
  if (href) {
    const link = el(`<a target="_blank" rel="noreferrer noopener"></a>`) as HTMLAnchorElement;
    link.href = href;
    link.textContent = pin.source.pageTitle || 'Open source';
    source.append(link);
  } else if (pin.source.pageTitle && pin.source.pageTitle !== pin.label) {
    source.textContent = pin.source.pageTitle;
  } else source.remove();
  const learn = card.querySelector('[data-learn]') as HTMLButtonElement;
  const addToBoard = card.querySelector('[data-board-pin]') as HTMLButtonElement;
  const routeLine = card.querySelector('[data-lesson-route]') as HTMLElement;
  const openModels = card.querySelector('[data-open-models]') as HTMLButtonElement;
  const boardStatus = card.querySelector('.pins-board-status') as HTMLElement;
  const paintRoute = (route: PinsLessonRoute): void => {
    routeLine.textContent = lessonRouteLine(route);
    openModels.hidden = route.readiness === 'ready';
  };
  paintRoute(initialRoute);
  openModels.addEventListener('click', () => shell.openModels());
  learn.addEventListener('click', async () => {
    learn.disabled = true;
    boardStatus.textContent = 'Checking the model connection…';
    const route = await shell.lessonRoute();
    paintRoute(route);
    if (route.readiness === 'ready') {
      boardStatus.textContent = '';
      shell.learn(pin);
      return;
    }
    learn.disabled = false;
    boardStatus.textContent = 'Open Models to reconnect it before starting this lesson.';
    openModels.focus();
  });
  addToBoard.addEventListener('click', async () => {
    addToBoard.disabled = true;
    boardStatus.textContent = 'Adding to Board…';
    const added = await shell.addToBoard(pin);
    if (added.kind === 'ok' && added.body.ok) {
      justBoarded = { label: added.body.label };
      if (justSaved === pin.id) justSaved = null;
      await redraw();
      return;
    }
    addToBoard.disabled = false;
    boardStatus.textContent = added.kind === 'unreachable'
      ? 'Virgil is not reachable. This pin is still waiting.'
      : 'That pin could not be added. It is still waiting.';
    addToBoard.focus();
  });
  card.querySelector('.pins-learn')?.append(shell.routes(pin));

  const remove = card.querySelector('[data-remove]') as HTMLButtonElement;
  const confirm = card.querySelector('[data-remove-confirm]') as HTMLElement;
  const removeNow = card.querySelector('[data-remove-now]') as HTMLButtonElement;
  const cancel = card.querySelector('[data-remove-cancel]') as HTMLButtonElement;
  const removeStatus = card.querySelector('.pins-remove-status') as HTMLElement;
  remove.setAttribute('aria-label', `Remove ${pin.label}`);
  remove.setAttribute('title', `Remove ${pin.label}`);
  remove.addEventListener('click', () => {
    confirm.removeAttribute('hidden');
    removeNow.focus();
  });
  cancel.addEventListener('click', () => {
    confirm.setAttribute('hidden', '');
    remove.focus();
  });
  removeNow.addEventListener('click', async () => {
    removeNow.disabled = true;
    cancel.disabled = true;
    removeStatus.textContent = 'Removing…';
    const removed = await shell.remove(pin);
    if (removed.kind === 'ok') {
      if (justSaved === pin.id) justSaved = null;
      await redraw();
      return;
    }
    removeNow.disabled = false;
    cancel.disabled = false;
    removeStatus.textContent = removed.kind === 'unreachable'
      ? 'Virgil is not reachable. The pin is still here.'
      : 'That pin could not be removed. It is still here.';
    removeNow.focus();
  });
  return card;
}

export async function mountPinsFace(host: HTMLElement, shell: PinsFaceShell): Promise<void> {
  host.replaceChildren(el(`<div class="thinking"><span class="what">Opening your pins…</span></div>`));
  const [read, lessonRoute] = await Promise.all([shell.read(), shell.lessonRoute()]);
  host.replaceChildren();
  const redraw = (): Promise<void> => mountPinsFace(host, shell);
  const intake = intakePopup(shell, redraw);
  if (justSaved) host.append(el(`<p class="pins-saved" role="status">Saved to Pins. No lesson was generated.</p>`));
  if (justBoarded) {
    const receipt = el(`<div class="pins-boarded" role="status"><span></span><button class="link" type="button">View Board</button></div>`);
    (receipt.querySelector('span') as HTMLElement).textContent = `Added to Board · ${justBoarded.label}`;
    (receipt.querySelector('button') as HTMLButtonElement).addEventListener('click', () => {
      justBoarded = null;
      shell.board();
    });
    host.append(receipt);
  }
  if (read.kind !== 'ok') {
    host.append(el(`<p class="empty">I could not open saved pins. You can still add one below.</p>`));
    host.append(intake);
    return;
  }
  const addGroup = (heading: string, detail: string, pins: PinSummary[]): void => {
    const section = el(`<section class="pins-group"><div class="pins-group-head"><div><h2></h2><p></p></div></div><div class="pins-list"></div></section>`);
    (section.querySelector('h2') as HTMLElement).textContent = heading;
    (section.querySelector('p') as HTMLElement).textContent = detail;
    const list = section.querySelector('.pins-list') as HTMLElement;
    if (pins.length) pins.forEach((pin) => list.append(pinCard(pin, shell, redraw, lessonRoute)));
    else list.append(el('<p class="empty">Nothing is waiting. New captures will arrive here.</p>'));
    host.append(section);
  };
  addGroup('New pins', 'Captured and waiting for you to file, learn, or hand off.',
    read.body.pins.filter((pin) => pin.status === 'new'));
  host.append(intake);
}
