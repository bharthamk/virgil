import { esc, safeHref } from './panel-core.js';

export interface CourseMaterialView {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly kind: string;
  readonly minutes: number | null;
  readonly doneAt: string | null;
  readonly progressMinutes?: number;
}

export interface MaterialCourseView {
  readonly id: string;
  readonly title: string;
}

type WriteResult<T> =
  | { readonly kind: 'ok'; readonly body: T }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'refused'; readonly status: number | null };

export interface CourseMaterialActions {
  readonly write: <T>(path: string, init?: RequestInit) => Promise<WriteResult<T>>;
  readonly recoverIdentity: (
    result: WriteResult<unknown>, resume: () => void | Promise<void>,
  ) => Promise<boolean>;
  readonly redraw: (courseId: string, materialId?: string, materialLink?: boolean) => void;
  /** The course-level Continue block already owns this row's missing-link repair. */
  readonly isNext?: boolean;
  /** Present only when Learn sent the learner here to repair this exact item. */
  readonly afterLinkSave?: () => void;
}

const el = (html: string): HTMLElement => {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html.trim();
  return wrapper.firstElementChild as HTMLElement;
};

const MATERIAL_KINDS = ['video', 'reading', 'class', 'exercise', 'other'] as const;
const MATERIAL_TITLE_MAX_CHARS = 180;

/** The study room's Add control owns the page while its form is open. */
export function exclusiveAddToggle(
  add: HTMLButtonElement,
  host: HTMLElement,
  content: HTMLElement,
  guard: (continueNavigation: () => void) => void,
  build: () => HTMLElement,
): () => void {
  const hideRoom = (hidden: boolean): void => {
    for (const child of Array.from(content.children)) {
      if (child !== host) (child as HTMLElement).hidden = hidden;
    }
  };
  return (): void => {
    if (host.firstElementChild) {
      guard(() => {
        host.replaceChildren();
        add.setAttribute('aria-expanded', 'false');
        add.textContent = 'Add';
        hideRoom(false);
        add.focus();
      });
      return;
    }
    host.replaceChildren();
    add.setAttribute('aria-expanded', 'true');
    add.textContent = 'Close';
    const sheet = build();
    host.append(sheet);
    hideRoom(true);
    (sheet.querySelector('[aria-current="page"]') as HTMLElement | null)?.focus();
  };
}

/** The course's one real next move: open its source, or repair that exact gap. */
export function courseNextMove(
  material: CourseMaterialView,
  repairMissingLink: () => void,
): HTMLElement {
  const node = el(`<section class="course-next-move">
    <div class="course-next-copy"><span class="eyebrow">Continue</span><strong></strong><span class="meta"></span></div>
    <div class="course-next-action"></div>
  </section>`);
  (node.querySelector('strong') as HTMLElement).textContent = material.title;
  (node.querySelector('.meta') as HTMLElement).textContent = material.minutes
    ? `${material.minutes} min · ${material.kind}` : material.kind;
  const href = safeHref(material.url);
  const actionHost = node.querySelector('.course-next-action') as HTMLElement;
  if (href) {
    const action = el('<a class="primary course-continue" target="_blank" rel="noopener noreferrer">Open material</a>') as HTMLAnchorElement;
    action.setAttribute('href', href);
    actionHost.append(action);
  } else {
    const repair = el('<button class="primary course-continue">Add its link</button>') as HTMLButtonElement;
    repair.setAttribute('aria-label', `Add link for ${material.title}`);
    repair.addEventListener('click', repairMissingLink);
    actionHost.append(repair);
  }
  return node;
}

/** One learner-owned material record, including correction and bounded removal. */
export function courseMaterialRow(
  courseId: string,
  material: CourseMaterialView,
  courses: readonly MaterialCourseView[],
  actionsApi: CourseMaterialActions,
): HTMLElement {
  const row = el(`<div class="material" data-kind="${esc(material.kind)}" data-material="${esc(material.id)}">
    <button class="tick" title="Done"></button>
    <span class="what"></span>
    <span class="mins"></span>
    <span class="material-actions"></span>
    <span class="material-status" role="status" aria-live="polite"></span>
  </div>`);
  if (actionsApi.isNext) row.classList.add('course-next-row');
  const tick = row.querySelector('.tick') as HTMLButtonElement;
  const status = row.querySelector('.material-status') as HTMLElement;
  const actions = row.querySelector('.material-actions') as HTMLElement;
  tick.textContent = material.doneAt ? '✓' : '';
  tick.setAttribute('aria-label', material.doneAt
    ? `Mark ${material.title} not covered`
    : `Mark ${material.title} covered`);
  const what = row.querySelector('.what') as HTMLElement;
  const materialHref = safeHref(material.url);
  if (materialHref) {
    const link = el('<a target="_blank" rel="noopener noreferrer"></a>') as HTMLAnchorElement;
    link.setAttribute('href', materialHref);
    link.textContent = material.title;
    what.append(link);
  } else what.textContent = material.title;
  const progressed = Math.max(0, material.progressMinutes ?? 0);
  (row.querySelector('.mins') as HTMLElement).textContent = material.minutes
    ? (progressed > 0 && !material.doneAt
      ? `${progressed} of ${material.minutes} min` : `${material.minutes} min`)
    : (progressed > 0 && !material.doneAt ? `${progressed} min recorded` : '');

  tick.addEventListener('click', async () => {
    tick.disabled = true;
    status.textContent = material.doneAt ? 'Marking this not covered…' : 'Marking this covered…';
    const saved = await actionsApi.write<unknown>(
      `/courses/${encodeURIComponent(courseId)}/material/${encodeURIComponent(material.id)}/done`,
      { method: 'POST' },
    );
    if (await actionsApi.recoverIdentity(saved, () => actionsApi.redraw(courseId))) return;
    if (saved.kind !== 'ok') {
      status.textContent = 'That did not go through. Nothing has changed.';
      tick.disabled = false;
      tick.focus();
      return;
    }
    actionsApi.redraw(courseId, material.id);
  });

  const options = el('<button class="link material-options">Material options</button>') as HTMLButtonElement;
  options.setAttribute('aria-label', `Material options for ${material.title}`);
  const addLink = !material.url
    ? el('<button class="link material-add-link" data-edit-link>Add link</button>') as HTMLButtonElement : null;
  if (addLink) addLink.setAttribute('aria-label', `Add link for ${material.title}`);
  const destinationCourses = courses.filter((course) => course.id !== courseId);
  const move = destinationCourses.length
    ? el('<button class="link material-move-action">Move</button>') as HTMLButtonElement : null;
  if (move) move.setAttribute('aria-label', `Move ${material.title} to another course`);

  const renderActions = (focus?: HTMLElement): void => {
    actions.classList.remove('editing-link', 'expanded');
    actions.replaceChildren(options, ...addLink ? [addLink] : [], ...move ? [move] : []);
    focus?.focus();
  };

  const editForm = (linkOnly = false): void => {
    const form = el(`<div class="material-edit repair-choice">
      <label class="field title-field"><span>Title</span><input class="name title" type="text"></label>
      <p class="meta title-limit">Up to 180 characters. I save the whole material title.</p>
      <label class="field url-field"><span>Link <em>(optional)</em></span><input class="name url" type="url" autocomplete="url"></label>
      <label class="field kind-field"><span>Kind</span><select class="kind"></select></label>
      <label class="field minutes-field"><span>Minutes <em>(optional)</em></span><input class="minutes" type="number" min="1" max="1440"></label>
      <p class="status" role="status" aria-live="polite"></p>
      <div class="row"><button class="primary save">Save material</button><button class="link cancel">Cancel</button></div>
    </div>`);
    const title = form.querySelector('.title') as HTMLInputElement;
    const url = form.querySelector('.url') as HTMLInputElement;
    const kind = form.querySelector('.kind') as HTMLSelectElement;
    const minutes = form.querySelector('.minutes') as HTMLInputElement;
    const note = form.querySelector('.status') as HTMLElement;
    for (const value of MATERIAL_KINDS) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value[0]!.toUpperCase() + value.slice(1);
      kind.append(option);
    }
    title.value = material.title;
    url.value = material.url;
    kind.value = material.kind;
    minutes.value = material.minutes === null ? '' : String(material.minutes);
    if (linkOnly) {
      form.setAttribute('class', 'material-link-edit repair-choice');
      form.querySelector('.title-field')!.remove();
      (form.querySelector('.title-limit') as HTMLElement).textContent =
        'Use the page where you actually read, watch or do this item.';
      (form.querySelector('.url-field span') as HTMLElement).textContent = `Link for ${material.title}`;
      form.querySelector('.kind-field')!.remove();
      form.querySelector('.minutes-field')!.remove();
      (form.querySelector('.save') as HTMLButtonElement).textContent = 'Save link';
      actions.classList.add('editing-link');
    }
    actions.classList.add('expanded');
    actions.replaceChildren(form);
    (form.querySelector('.cancel') as HTMLButtonElement).addEventListener('click', () =>
      linkOnly ? renderActions(addLink ?? options) : openOptions());
    const save = form.querySelector('.save') as HTMLButtonElement;
    save.addEventListener('click', async () => {
      const nextTitle = title.value.trim();
      if (!linkOnly && !nextTitle) {
        note.textContent = 'Give the material a title first.';
        title.focus();
        return;
      }
      if (!linkOnly && Array.from(nextTitle).length > MATERIAL_TITLE_MAX_CHARS) {
        note.textContent = `That material title is ${Array.from(nextTitle).length.toLocaleString('en-US')} characters. Keep it to 180 so I can save all of it. Nothing was sent.`;
        title.focus();
        return;
      }
      const nextUrl = url.value.trim();
      if (nextUrl && !safeHref(nextUrl)) {
        note.textContent = 'Use a full http or https link.';
        url.focus();
        return;
      }
      const rawMinutes = minutes.value.trim();
      const nextMinutes = rawMinutes ? Number(rawMinutes) : null;
      if (!linkOnly && nextMinutes !== null
        && (!Number.isFinite(nextMinutes) || nextMinutes < 1 || nextMinutes > 1440)) {
        note.textContent = 'Use a duration from 1 to 1440 minutes.';
        minutes.focus();
        return;
      }
      save.disabled = true;
      note.textContent = linkOnly ? 'Saving the link…' : 'Saving the material…';
      const body = linkOnly ? { url: nextUrl } : {
        title: nextTitle, url: nextUrl, kind: kind.value, minutes: nextMinutes,
      };
      const saved = await actionsApi.write<{ material: CourseMaterialView }>(
        `/courses/${encodeURIComponent(courseId)}/material/${encodeURIComponent(material.id)}`,
        { method: 'PUT', body: JSON.stringify(body) },
      );
      if (await actionsApi.recoverIdentity(saved,
        () => actionsApi.redraw(courseId, material.id, Boolean(nextUrl)))) return;
      if (saved.kind !== 'ok') {
        note.textContent = linkOnly
          ? 'That link did not go through. The material is unchanged.'
          : 'That change did not go through. The material is unchanged.';
        save.disabled = false;
        save.focus();
        return;
      }
      if (linkOnly && actionsApi.afterLinkSave) actionsApi.afterLinkSave();
      else actionsApi.redraw(courseId, material.id, linkOnly);
    });
    (linkOnly ? url : title).focus();
  };

  const openOptions = (): void => {
    const menu = el(`<div class="repair-choice material-options-menu">
      <div class="row"><button class="link edit">Edit material</button><button class="link danger-link remove">Remove material</button><button class="link cancel">Cancel</button></div>
    </div>`);
    actions.classList.add('expanded');
    actions.replaceChildren(menu);
    (menu.querySelector('.edit') as HTMLButtonElement).addEventListener('click', () => editForm());
    (menu.querySelector('.cancel') as HTMLButtonElement).addEventListener('click', () => renderActions(options));
    (menu.querySelector('.remove') as HTMLButtonElement).addEventListener('click', () => {
      const confirm = el(`<div class="repair-choice material-remove-confirm">
        <p class="bare"></p><p class="meta">Board learning stays where it is.</p>
        <p class="status" role="status" aria-live="polite"></p>
        <div class="row"><button class="danger confirm">Remove material</button><button class="link keep">Keep material</button></div>
      </div>`);
      (confirm.querySelector('.bare') as HTMLElement).textContent =
        `This removes ${material.title} and its recorded progress from this course.`;
      actions.replaceChildren(confirm);
      const remove = confirm.querySelector('.confirm') as HTMLButtonElement;
      const note = confirm.querySelector('.status') as HTMLElement;
      (confirm.querySelector('.keep') as HTMLButtonElement).addEventListener('click', openOptions);
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        note.textContent = 'Removing the material…';
        const saved = await actionsApi.write<unknown>(
          `/courses/${encodeURIComponent(courseId)}/material/${encodeURIComponent(material.id)}`,
          { method: 'DELETE' },
        );
        if (await actionsApi.recoverIdentity(saved, () => actionsApi.redraw(courseId))) return;
        if (saved.kind !== 'ok') {
          note.textContent = 'That did not go through. The material is unchanged.';
          remove.disabled = false;
          remove.focus();
          return;
        }
        actionsApi.redraw(courseId);
      });
      remove.focus();
    });
    (menu.querySelector('.edit') as HTMLButtonElement).focus();
  };

  options.addEventListener('click', openOptions);
  addLink?.addEventListener('click', () => editForm(true));
  move?.addEventListener('click', () => {
    const form = el(`<div class="material-move repair-choice">
      <label class="field"><span></span><select></select></label>
      <p class="meta">Its source, progress and links move with it.</p>
      <div class="row"><button class="primary confirm">Move material</button><button class="link cancel">Cancel</button></div>
    </div>`);
    (form.querySelector('.field span') as HTMLElement).textContent = `Move ${material.title} to`;
    const select = form.querySelector('select') as HTMLSelectElement;
    for (const course of destinationCourses) {
      const option = document.createElement('option');
      option.value = course.id;
      option.textContent = course.title;
      select.append(option);
    }
    actions.classList.add('expanded');
    actions.replaceChildren(form);
    const action = form.querySelector('.confirm') as HTMLButtonElement;
    (form.querySelector('.cancel') as HTMLButtonElement).addEventListener('click', () => renderActions(move));
    action.addEventListener('click', async () => {
      action.disabled = true;
      status.textContent = 'Moving the material…';
      const targetId = select.value;
      const saved = await actionsApi.write<unknown>(
        `/courses/${encodeURIComponent(courseId)}/material/${encodeURIComponent(material.id)}/move`,
        { method: 'POST', body: JSON.stringify({ courseId: targetId }) },
      );
      if (await actionsApi.recoverIdentity(saved, () => actionsApi.redraw(courseId))) return;
      if (saved.kind !== 'ok') {
        status.textContent = 'That did not go through. The material has not moved.';
        action.disabled = false;
        action.focus();
        return;
      }
      actionsApi.redraw(targetId, material.id);
    });
    select.focus();
  });
  renderActions();
  return row;
}
