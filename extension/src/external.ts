/**
 * EXTERNAL — where the thread comes back.
 *
 * The lesson rail offers four ways to take a lesson to Gemini, and every one of
 * them used to be the end of the story. The learner pressed a button, something
 * opened somewhere else, and whatever they did out there happened to somebody
 * this product could not see. Four doors out, and none back.
 *
 * This face is the way back. It lists what still needs clearing, and beside
 * each row it puts the one question worth asking about it: how did that go.
 * The answer is the only thing here that reaches the board, and it reaches it
 * through marks the product already had words for.
 *
 * ## What this module is careful about
 *
 *  - **A marked row clears.** This is a clearinghouse, not the receipt store.
 *    The service keeps the complete row and its evidence, while this active
 *    surface removes it immediately and excludes it again after a reload.
 *  - **Remove writes nothing, and says nothing else either.** No confirm step
 *    and no consolation line: the learner asked for a row to go.
 *  - **A row with nothing on the board behind it says so.** Something typed in
 *    about a video a friend sent has no subject to be about, so its answer is
 *    recorded on the row and the line under it does not pretend otherwise.
 *  - **Nothing here writes on render.** Every request in this file happens
 *    inside a press.
 *
 * A rendering module on the `insights.ts` model: it builds DOM, it holds no
 * route, and anything that writes is handed in by the shell.
 */

// ------------------------------------------------------------- the wire

/** The value the panel sends, which is the value the endpoint validates
 *  against, so there is one vocabulary and not two spellings of one. */
export type ExternalMark = 'done' | 'easy' | 'hard' | 'skipped';
export type ExternalKind = 'lesson' | 'material' | 'manual';
export type ExternalDestination = 'new-tab' | 'window' | 'side-panel' | 'notebook' | 'manual';
export type ExternalMethod = 'read' | 'watched' | 'listened' | 'hands-on';

/** One row, as the service sends it. Every field but the first four is optional
 *  because an installation older than this page answers with fewer of them. */
export interface ExternalEntryView {
  readonly id: string;
  readonly kind: ExternalKind;
  readonly label: string;
  readonly destination: ExternalDestination;
  readonly sentAt: string;
  readonly destinationSaid?: string | null;
  readonly topicId?: string | null;
  readonly note?: string | null;
  readonly methods?: readonly string[];
  readonly mark?: ExternalMark | null;
  readonly markLocalOnly?: boolean;
}

/** What the service says back about one answer. `wrote` is null exactly when
 *  nothing on the board claims the row. */
export interface ExternalMarkReply {
  readonly entry?: ExternalEntryView;
  readonly wrote?: string | null;
  readonly backAfterDays?: number;
  readonly adaptation?: {
    readonly changed: boolean;
    readonly before: { readonly id?: string; readonly title?: string };
    readonly after: { readonly id?: string; readonly title?: string };
    readonly changedBecause: string;
  };
}

/** What one answer carries: the mark, and whatever the learner filled in under
 *  it. The methods and the note ride with the press, so there is one write. */
export interface ExternalMarkBody {
  readonly mark: ExternalMark;
  readonly methods: readonly ExternalMethod[];
  readonly note: string | null;
  readonly availableMinutes?: 1 | 3 | 5;
}

// --------------------------------------------------------------- the copy

/** The empty face still has one job: explain why this clearinghouse exists.
 *  The sentence connects a third-party handoff to the evidence loop without
 *  turning an empty queue into onboarding furniture. */
export const EXTERNAL_EMPTY =
  'Learned somewhere else? Add it here. Lessons sent out from Virgil return here too, so the result can shape what comes next.';

/** The older-installation state. A missing capability, said plainly, with the
 *  face still drawing its own intro above it. Never an error. */
export const EXTERNAL_OLDER =
  'This Virgil installation is older than the extension, so it is not keeping this record yet.';

export const EXTERNAL_TITLE = 'Learning elsewhere';
export const EXTERNAL_EXPLAINER =
  'Tell Virgil what happened so it can shape what comes next.';
export const EXTERNAL_ADD = 'Add learning from elsewhere';
export const EXTERNAL_ADD_WHAT = 'What did you learn somewhere else?';
export const EXTERNAL_ADD_WHERE = 'Where did it happen?';
export const EXTERNAL_ADD_WHERE_PICK = 'Choose a location';
export const EXTERNAL_ADD_WHERE_NEW = 'Add a new location';
export const EXTERNAL_ADD_WHERE_NAME = 'New location';
export const EXTERNAL_ADD_WHERE_LIMIT = 'Up to 180 characters. I save the whole location.';
export const EXTERNAL_ADD_SAVE = 'Add it';
export const EXTERNAL_ADD_LIMIT = 'Up to 180 characters. I save the whole title.';
export const EXTERNAL_ADD_FAILED = 'That did not go through. Nothing has been added.';

/** The group of answers, named for the question it asks rather than for what it
 *  records. Read out as the group's accessible name, because five buttons in a
 *  row with no name are five unrelated controls to a screen reader. */
export const EXTERNAL_MARK_LABEL = 'How did it go?';

export const EXTERNAL_MORE = 'Add what you learned';
/** Said once, above the two fields, so neither of them needs a save button of
 *  its own and nobody has to guess when they land. */
export const EXTERNAL_MORE_NOTE =
  'These details are saved when you answer “How did it go?” above.';
export const EXTERNAL_METHODS_LABEL = 'How did you work on it?';
export const EXTERNAL_NOTE_LABEL = 'Anything you want to remember about it';
export const EXTERNAL_NOTE_LIMIT = 'Up to 1,000 characters. I save the whole note.';
/** The deliberate control the note needs before it becomes a sentence about the
 *  learner. Nothing is offered to that door without this press. */
export const EXTERNAL_KEEP_INSIGHT = 'Keep this as an insight';
export const EXTERNAL_KEPT_INSIGHT = 'Kept. It is in your insights now.';
export const EXTERNAL_KEEP_FAILED = 'That did not go through. Your note is still here.';
export const EXTERNAL_MARK_FAILED = 'That did not go through. Nothing changed.';
export const EXTERNAL_MARK_SAVED = 'Saved. That item is no longer waiting.';
export const EXTERNAL_REMOVE_FAILED = 'That did not go through. It is still here.';

/**
 * The five presses on a row, and only four of them are answers.
 *
 * `Remove` is here because it answers the same question the other four do, and
 * it is separated in the code because it writes nothing at all: it takes the
 * row away and records neither a deferral nor a withdrawal.
 */
export const EXTERNAL_CHOICES: readonly {
  readonly mark: ExternalMark;
  readonly label: string;
  readonly title: string;
}[] = [
  { mark: 'done', label: 'Done', title: 'Records that you finished it, and tells your board it landed.' },
  { mark: 'easy', label: 'Easy', title: 'Tells your board this one landed.' },
  { mark: 'hard', label: 'Hard', title: 'Tells your board this one is still shaky.' },
  { mark: 'skipped', label: 'Skipped', title: 'Puts the subject down for a while. I will bring it back.' },
];

export const EXTERNAL_REMOVE = 'Remove';
export const EXTERNAL_REMOVE_TITLE = 'Takes this row away. Nothing is recorded.';

/** The four ways of working on something, in the learner's own words. A closed
 *  set, because an open field about how somebody learns fills up with
 *  categories nobody can check. */
export const EXTERNAL_METHOD_CHOICES: readonly {
  readonly method: ExternalMethod;
  readonly label: string;
}[] = [
  { method: 'read', label: 'Read it' },
  { method: 'watched', label: 'Watched it' },
  { method: 'listened', label: 'Listened to it' },
  { method: 'hands-on', label: 'Did it hands on' },
];

/** Where a send went, in the words the button used. `manual` has none of its
 *  own, so the row says what the learner said or nothing. */
export const EXTERNAL_DESTINATION_WORDS: Readonly<Record<ExternalDestination, string>> = {
  'new-tab': 'New tab',
  window: 'Pop out',
  'side-panel': 'Side panel',
  notebook: 'Google Notebook',
  manual: 'Somewhere else',
};

/** The compact card's destination. The stored time remains part of the record
 *  but is not useful enough to consume a second visible line on every card. */
export function externalDestinationLabel(entry: ExternalEntryView): string {
  if (entry.destination === 'manual') {
    const said = (entry.destinationSaid ?? '').trim();
    return said || EXTERNAL_DESTINATION_WORDS.manual;
  }
  return EXTERNAL_DESTINATION_WORDS[entry.destination];
}

/**
 * Places this board has already used, reduced to names that make sense in a
 * "where did it happen?" chooser. Gemini's three presentation routes are one
 * place; Notebook is another; learner-authored places keep the learner's own
 * words. Newest-first service order must not make the chooser jump around, so
 * the deduplicated result is alphabetical.
 */
export function externalLocationOptions(entries: readonly ExternalEntryView[]): readonly string[] {
  const locations = new Set<string>();
  for (const entry of entries) {
    if (entry.destination === 'notebook') locations.add('Google Notebook');
    else if (entry.destination === 'new-tab' || entry.destination === 'window'
      || entry.destination === 'side-panel') locations.add('Gemini');
    else {
      const said = (entry.destinationSaid ?? '').trim();
      if (said) locations.add(said);
    }
  }
  return [...locations].sort((a, b) => a.localeCompare(b));
}

// --------------------------------------------------------------- the face

export interface ExternalFaceDeps {
  /** The panel's own element builder, handed in rather than imported, so this
   *  module carries no opinion about how the room makes DOM. */
  readonly el: (html: string) => HTMLElement;
  /** The unresolved entries, or null when this installation has no door to ask. */
  readonly entries: readonly ExternalEntryView[] | null;
  readonly add: (label: string, where: string) => Promise<ExternalEntryView | null>;
  readonly mark: (id: string, body: ExternalMarkBody) => Promise<ExternalMarkReply | null>;
  readonly remove: (id: string) => Promise<boolean>;
  /** Return through Today's reader. The receipt is a consequence, not a
   *  second cached claim about what is current now. */
  readonly seeNext: () => void;
  /** The insight door, exactly as the Insights room's own control uses it. */
  readonly keepInsight: (text: string) => Promise<boolean>;
}

/**
 * The whole face: one control and the unresolved rows.
 *
 * Built in one pass with no request in it. Everything it draws was handed in,
 * and every request below happens inside a press.
 */
export function externalFace(deps: ExternalFaceDeps): HTMLElement {
  const node = deps.el(`<section class="external-face">
    <header class="external-head">
      <div>
        <h1 class="external-title"></h1>
        <p class="external-explainer"></p>
      </div>
      <div class="external-add"></div>
    </header>
    <div class="external-add-body"></div>
    <div class="external-entries"></div>
    <p class="external-face-said meta" role="status" aria-live="polite"></p>
  </section>`);

  (node.querySelector('.external-title') as HTMLElement).textContent = EXTERNAL_TITLE;
  (node.querySelector('.external-explainer') as HTMLElement).textContent = EXTERNAL_EXPLAINER;

  const rows = node.querySelector('.external-entries') as HTMLElement;

  // An installation with no door draws its sentence and no control: an Add
  // button over a service that cannot store anything is a button that lies.
  if (deps.entries === null) {
    (node.querySelector('.external-add') as HTMLElement).remove();
    (node.querySelector('.external-add-body') as HTMLElement).remove();
    rows.append(line(deps, EXTERNAL_OLDER));
    return node;
  }

  (node.querySelector('.external-add') as HTMLElement)
    .append(addControl(
      deps,
      node.querySelector('.external-add-body') as HTMLElement,
      externalLocationOptions(deps.entries),
      (entry) => {
      const empty = rows.querySelector('.empty');
      if (empty) empty.remove();
      rows.insertBefore(entryRow(deps, entry), rows.children[0] ?? null);
      },
    ));

  // Defence in depth for a panel temporarily paired with an older service:
  // marked receipts are durable history, not active cards.
  const pending = deps.entries.filter((entry) => !entry.mark);
  if (!pending.length) rows.append(line(deps, EXTERNAL_EMPTY));
  for (const entry of pending) rows.append(entryRow(deps, entry));
  return node;
}

const line = (deps: ExternalFaceDeps, text: string): HTMLElement => {
  const node = deps.el(`<p class="empty"></p>`);
  node.textContent = text;
  return node;
};

/**
 * The manual entry: what, and optionally where.
 *
 * Closed until it is asked for, because most of what this face holds arrives by
 * itself and a form sitting open above the history would be the screen asking a
 * question nobody had.
 */
function addControl(
  deps: ExternalFaceDeps,
  body: HTMLElement,
  locations: readonly string[],
  added: (entry: ExternalEntryView) => void,
): HTMLElement {
  const host = deps.el(`<div class="external-add-host"></div>`);
  const open = deps.el(`<button class="link" data-external-add></button>`) as HTMLButtonElement;
  open.textContent = EXTERNAL_ADD;
  open.setAttribute('aria-expanded', 'false');
  host.append(open);

  open.addEventListener('click', () => {
    if (body.firstElementChild) {
      body.replaceChildren();
      open.setAttribute('aria-expanded', 'false');
      open.focus();
      return;
    }
    open.setAttribute('aria-expanded', 'true');
    const form = deps.el(`<div class="external-add-form">
      <label class="field what-field"><span class="what-label"></span>
        <input class="what" type="text" maxlength="180">
        <span class="meta input-limit"></span></label>
      <label class="field where-field"><span class="where-label"></span>
        <select class="where-choice" required></select></label>
      <div class="external-new-location"></div>
      <div class="row external-add-actions"><button class="primary" data-external-save></button></div>
      <p class="meta add-said" role="status" aria-live="polite"></p>
    </div>`);
    (form.querySelector('.what-label') as HTMLElement).textContent = EXTERNAL_ADD_WHAT;
    (form.querySelector('.where-label') as HTMLElement).textContent = EXTERNAL_ADD_WHERE;
    (form.querySelector('.input-limit') as HTMLElement).textContent = EXTERNAL_ADD_LIMIT;
    const what = form.querySelector('.what') as HTMLInputElement;
    const whereChoice = form.querySelector('.where-choice') as HTMLSelectElement;
    const newLocation = form.querySelector('.external-new-location') as HTMLElement;
    const choose = deps.el(`<option value="" selected></option>`) as HTMLOptionElement;
    choose.textContent = EXTERNAL_ADD_WHERE_PICK;
    choose.disabled = true;
    whereChoice.append(choose);
    for (const location of locations) {
      const option = deps.el(`<option></option>`) as HTMLOptionElement;
      option.value = location;
      option.textContent = location;
      whereChoice.append(option);
    }
    const addNew = deps.el(`<option value="new"></option>`) as HTMLOptionElement;
    addNew.textContent = EXTERNAL_ADD_WHERE_NEW;
    whereChoice.append(addNew);
    whereChoice.value = '';

    let where: HTMLInputElement | null = null;
    const drawNewLocation = (): void => {
      if (whereChoice.value !== 'new') {
        newLocation.replaceChildren();
        where = null;
        return;
      }
      const field = deps.el(`<label class="field new-location-field">
        <span class="new-location-label"></span>
        <input class="where" type="text" maxlength="180">
        <span class="meta where-limit"></span>
      </label>`);
      (field.querySelector('.new-location-label') as HTMLElement).textContent = EXTERNAL_ADD_WHERE_NAME;
      (field.querySelector('.where-limit') as HTMLElement).textContent = EXTERNAL_ADD_WHERE_LIMIT;
      where = field.querySelector('.where') as HTMLInputElement;
      newLocation.replaceChildren(field);
      where.focus();
    };
    whereChoice.addEventListener('change', drawNewLocation);
    if (!locations.length) {
      whereChoice.value = 'new';
      drawNewLocation();
    }
    const said = form.querySelector('.add-said') as HTMLElement;
    const save = form.querySelector('[data-external-save]') as HTMLButtonElement;
    save.textContent = EXTERNAL_ADD_SAVE;
    save.addEventListener('click', async () => {
      const label = what.value.trim();
      // Nothing to record is not a failure and is not a sentence: the field is
      // empty and the learner can see that it is.
      if (!label) { what.focus(); return; }
      const place = whereChoice.value === 'new' ? where?.value.trim() ?? '' : whereChoice.value.trim();
      if (!place) {
        if (whereChoice.value === 'new') where?.focus();
        else whereChoice.focus();
        return;
      }
      save.disabled = true;
      const entry = await deps.add(label, place);
      save.disabled = false;
      if (!entry) { said.textContent = EXTERNAL_ADD_FAILED; return; }
      body.replaceChildren();
      open.setAttribute('aria-expanded', 'false');
      added(entry);
      open.focus();
    });
    body.append(form);
    what.focus();
  });
  return host;
}

/**
 * One row: what it was, where it went, and the answer.
 *
 * Only unresolved rows reach this renderer. Once an answer lands, the row is
 * removed from the working surface while the service retains its receipt.
 */
function entryRow(deps: ExternalFaceDeps, entry: ExternalEntryView): HTMLElement {
  const node = deps.el(`<article class="external-entry">
    <div class="external-card-head">
      <p class="label"></p>
      <p class="destination"></p>
    </div>
    <p class="external-mark-label"></p>
    <div class="row marks" role="group"></div>
    <p class="meta answered" role="status" aria-live="polite"></p>
    <div class="external-more-host"></div>
  </article>`);
  node.setAttribute('data-external', entry.id);
  node.setAttribute('data-destination', entry.destination);
  (node.querySelector('.label') as HTMLElement).textContent = entry.label;
  (node.querySelector('.destination') as HTMLElement).textContent = externalDestinationLabel(entry);
  (node.querySelector('.external-mark-label') as HTMLElement).textContent = EXTERNAL_MARK_LABEL;

  const answered = node.querySelector('.answered') as HTMLElement;
  const more = advanced(deps, entry);
  (node.querySelector('.external-more-host') as HTMLElement).append(more.host);

  const marks = node.querySelector('.marks') as HTMLElement;
  marks.setAttribute('aria-label', EXTERNAL_MARK_LABEL);
  const buttons: HTMLButtonElement[] = [];
  const busy = (state: boolean): void => { for (const b of buttons) b.disabled = state; };

  for (const choice of EXTERNAL_CHOICES) {
    const button = deps.el(`<button></button>`) as HTMLButtonElement;
    button.setAttribute('data-external-mark', choice.mark);
    button.textContent = choice.label;
    button.setAttribute('title', choice.title);
    button.setAttribute('aria-label', choice.title);
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', async () => {
      busy(true);
      const reply = await deps.mark(entry.id, {
        mark: choice.mark, methods: more.methods(), note: more.note(),
      });
      busy(false);
      if (!reply?.entry) { answered.textContent = EXTERNAL_MARK_FAILED; return; }
      clearEntry(deps, node, reply);
    });
    marks.append(button);
    buttons.push(button);
  }

  const remove = deps.el(`<button data-external-remove></button>`) as HTMLButtonElement;
  remove.textContent = EXTERNAL_REMOVE;
  remove.setAttribute('title', EXTERNAL_REMOVE_TITLE);
  remove.setAttribute('aria-label', EXTERNAL_REMOVE_TITLE);
  remove.addEventListener('click', async () => {
    busy(true);
    remove.disabled = true;
    const gone = await deps.remove(entry.id);
    if (!gone) {
      busy(false);
      remove.disabled = false;
      answered.textContent = EXTERNAL_REMOVE_FAILED;
      return;
    }
    // Nothing is said on the way out. The row was the thing, and it is gone.
    clearEntry(deps, node);
  });
  marks.append(remove);
  buttons.push(remove);
  return node;
}

/** Clear one active card without deleting the durable record behind a mark. */
function clearEntry(
  deps: ExternalFaceDeps, node: HTMLElement, reply?: ExternalMarkReply,
): void {
  const rows = node.parentElement;
  const face = rows?.parentElement;
  node.remove();
  if (rows && !rows.querySelector('.external-entry')) rows.append(line(deps, EXTERNAL_EMPTY));
  const status = face?.querySelector('.external-face-said') as HTMLElement | null;
  if (status) status.textContent = reply?.adaptation?.changedBecause
    ?? (reply ? EXTERNAL_MARK_SAVED : '');
  if (reply?.adaptation && face) {
    const see = deps.el(`<button class="link external-see-next"></button>`) as HTMLButtonElement;
    see.textContent = reply.adaptation.changed
      ? 'See the updated next move'
      : 'See the current next move';
    see.addEventListener('click', deps.seeNext);
    face.append(see);
    see.focus();
    return;
  }
  const next = rows?.querySelector('button') as HTMLButtonElement | null
    ?? face?.querySelector('button') as HTMLButtonElement | null;
  next?.focus();
}

/** What the advanced disclosure knows, so the mark press can carry it. */
interface Advanced {
  readonly host: HTMLElement;
  readonly methods: () => readonly ExternalMethod[];
  readonly note: () => string | null;
}

/**
 * The disclosure: how they worked on it, and anything they want to keep.
 *
 * Closed by default and empty when closed, because this is the second question
 * about a row most people will answer with one press and leave.
 *
 * **The note is not an insight until somebody says it is.** It is stored on the
 * row with the answer above, which is bookkeeping about one handoff. Offering
 * it to the insight door makes it a sentence about the learner that every later
 * lesson reads, and that is a different act, so it has its own control and
 * happens nowhere else.
 */
function advanced(deps: ExternalFaceDeps, entry: ExternalEntryView): Advanced {
  const host = deps.el(`<div class="external-more-block"></div>`);
  const open = deps.el(`<button class="link" data-external-more></button>`) as HTMLButtonElement;
  open.textContent = EXTERNAL_MORE;
  open.setAttribute('aria-expanded', 'false');
  const body = deps.el(`<div class="external-more"></div>`);
  host.append(open, body);

  const chosen = new Set<ExternalMethod>(
    EXTERNAL_METHOD_CHOICES.map((c) => c.method).filter((m) => (entry.methods ?? []).includes(m)));
  let noteValue = entry.note ?? '';

  open.addEventListener('click', () => {
    if (body.firstElementChild) {
      body.replaceChildren();
      open.setAttribute('aria-expanded', 'false');
      return;
    }
    open.setAttribute('aria-expanded', 'true');
    const form = deps.el(`<div class="external-more-form">
      <p class="meta more-note"></p>
      <p class="meta methods-label"></p>
      <div class="row methods" role="group"></div>
      <label class="field"><span class="note-label"></span>
        <textarea class="note" rows="3"></textarea>
        <span class="meta input-limit"></span></label>
      <div class="row"><button class="link" data-external-keep></button></div>
      <p class="meta more-said" role="status" aria-live="polite"></p>
    </div>`);
    (form.querySelector('.more-note') as HTMLElement).textContent = EXTERNAL_MORE_NOTE;
    (form.querySelector('.methods-label') as HTMLElement).textContent = EXTERNAL_METHODS_LABEL;
    (form.querySelector('.note-label') as HTMLElement).textContent = EXTERNAL_NOTE_LABEL;
    (form.querySelector('.input-limit') as HTMLElement).textContent = EXTERNAL_NOTE_LIMIT;

    const group = form.querySelector('.methods') as HTMLElement;
    group.setAttribute('aria-label', EXTERNAL_METHODS_LABEL);
    for (const choice of EXTERNAL_METHOD_CHOICES) {
      const button = deps.el(`<button></button>`) as HTMLButtonElement;
      button.setAttribute('data-external-method', choice.method);
      button.textContent = choice.label;
      button.setAttribute('aria-pressed', String(chosen.has(choice.method)));
      button.addEventListener('click', () => {
        if (chosen.has(choice.method)) chosen.delete(choice.method);
        else chosen.add(choice.method);
        button.setAttribute('aria-pressed', String(chosen.has(choice.method)));
      });
      group.append(button);
    }

    const note = form.querySelector('.note') as HTMLTextAreaElement;
    note.value = noteValue;
    note.addEventListener('input', () => { noteValue = note.value; });
    const said = form.querySelector('.more-said') as HTMLElement;
    const keep = form.querySelector('[data-external-keep]') as HTMLButtonElement;
    keep.textContent = EXTERNAL_KEEP_INSIGHT;
    keep.addEventListener('click', async () => {
      const text = note.value.trim();
      if (!text) { note.focus(); return; }
      keep.disabled = true;
      const kept = await deps.keepInsight(text);
      keep.disabled = false;
      said.textContent = kept ? EXTERNAL_KEPT_INSIGHT : EXTERNAL_KEEP_FAILED;
    });
    body.append(form);
  });

  return {
    host,
    methods: () => EXTERNAL_METHOD_CHOICES.map((c) => c.method).filter((m) => chosen.has(m)),
    note: () => noteValue.trim() || null,
  };
}

// ------------------------------------------- the board's own actions (slice 2)

/** Board cards name their Virgil lesson action; free handoffs reuse Pins. */
export const BOARD_LEARN = 'Learn';
export const BOARD_VIEW_PINS = 'View pins';
export const BOARD_RUN_THEN_LEARN = 'Run then learn';
