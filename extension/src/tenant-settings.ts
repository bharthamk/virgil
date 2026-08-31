import { serviceFetch } from './service.js';

export interface TenantMembershipView {
  readonly role: 'owner' | 'member';
  readonly editable: boolean;
  readonly members: readonly string[] | null;
  readonly sharedModelSetup: boolean;
  readonly isolatedBoard: boolean;
}

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

const section = (): HTMLElement => {
  const root = document.createElement('section');
  root.className = 'settings-section tenant-settings';
  const kicker = document.createElement('div');
  kicker.className = 'setting-kicker';
  kicker.textContent = 'This Virgil installation';
  const heading = document.createElement('h2');
  heading.textContent = 'People';
  const explanation = document.createElement('p');
  explanation.className = 'state tenant-explanation';
  const list = document.createElement('div');
  list.className = 'tenant-members';
  const form = document.createElement('form');
  form.className = 'tenant-add row';
  const input = document.createElement('input');
  input.type = 'email';
  input.setAttribute('type', 'email');
  input.autocomplete = 'email';
  input.setAttribute('autocomplete', 'email');
  input.placeholder = 'person@example.com';
  input.setAttribute('placeholder', 'person@example.com');
  input.setAttribute('aria-label', 'Email address to add');
  const add = document.createElement('button');
  add.type = 'submit';
  add.textContent = 'Add person';
  form.append(input, add);
  const status = document.createElement('p');
  status.className = 'note tenant-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  root.append(kicker, heading, explanation, list, form, status);
  return root;
};

const request = async (
  fetcher: Fetcher, method: 'POST' | 'DELETE', email: string,
): Promise<TenantMembershipView | null> => {
  try {
    const response = await fetcher('/tenant/members', {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    return response.ok ? await response.json() as TenantMembershipView : null;
  } catch {
    return null;
  }
};

export async function renderTenantSettings(
  host: HTMLElement,
  fetcher: Fetcher = serviceFetch,
): Promise<boolean> {
  let initial: TenantMembershipView;
  try {
    const response = await fetcher('/tenant/members');
    if (!response.ok) return false;
    initial = await response.json() as TenantMembershipView;
  } catch {
    return false;
  }

  const root = section();
  host.append(root);
  const explanation = root.querySelector('.tenant-explanation') as HTMLElement;
  const list = root.querySelector('.tenant-members') as HTMLElement;
  const form = root.querySelector('.tenant-add') as HTMLFormElement;
  const input = form.querySelector('input') as HTMLInputElement;
  const add = form.querySelector('button') as HTMLButtonElement;
  const status = root.querySelector('.tenant-status') as HTMLElement;

  const paint = (current: TenantMembershipView): void => {
    explanation.textContent = current.role === 'owner'
      ? 'People you add use this installation’s model connections and spend boundary. Each person keeps a separate private study board.'
      : 'Your access uses this installation’s model connections and spend boundary. Your study board stays separate from everyone else’s.';
    list.replaceChildren();
    form.hidden = current.role !== 'owner' || !current.editable;
    if (current.role !== 'owner' || !current.members) return;
    for (const [index, email] of current.members.entries()) {
      const row = document.createElement('div');
      row.className = 'tenant-member row';
      const label = document.createElement('span');
      label.textContent = email;
      row.append(label);
      if (index === 0) {
        const role = document.createElement('span');
        role.className = 'meta';
        role.textContent = 'Owner';
        row.append(role);
      } else {
        const remove = document.createElement('button');
        remove.className = 'link';
        remove.textContent = 'Remove';
        let confirmed = false;
        remove.addEventListener('click', async () => {
          if (!confirmed) {
            confirmed = true;
            remove.textContent = 'Confirm remove';
            status.textContent = 'Their board stays stored, but they will lose access to this Virgil installation.';
            return;
          }
          remove.disabled = true;
          status.textContent = 'Removing access…';
          const changed = await request(fetcher, 'DELETE', email);
          if (!changed) {
            remove.disabled = false;
            confirmed = false;
            remove.textContent = 'Remove';
            status.textContent = 'I could not remove that person. Nothing changed.';
            return;
          }
          status.textContent = `${email} no longer has access. Their board was not deleted.`;
          paint(changed);
        });
        row.append(remove);
      }
      list.append(row);
    }
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = input.value.trim();
    input.value = email;
    if (!email || !input.checkValidity()) {
      status.textContent = 'Enter a valid email address.';
      input.focus();
      return;
    }
    input.disabled = true;
    add.disabled = true;
    status.textContent = 'Adding access…';
    const changed = await request(fetcher, 'POST', email);
    input.disabled = false;
    add.disabled = false;
    if (!changed) {
      status.textContent = 'I could not add that person. Nothing changed.';
      return;
    }
    input.value = '';
    status.textContent = `${email.toLowerCase()} can now sign in. They will have their own study board.`;
    paint(changed);
  });

  paint(initial);
  return true;
}
