import { DRIVE_REFUSED, DRIVE_UNREACHABLE } from './panel-core.js';
import { notebookTarget } from './notebook.js';
import { serviceFetch } from './service.js';

interface HostedDriveStatus {
  readonly connected: boolean;
  readonly expectedAccount: string;
  readonly account: string | null;
  readonly connectedAt: string | null;
  readonly lastWriteAt: string | null;
  readonly folderLink: string | null;
  readonly notebookUrl: string | null;
  readonly documents: readonly string[];
}

const DOCUMENT_LABELS: Readonly<Record<string, string>> = {
  'learn-now': 'Learn now',
  'on-the-board': 'On the board',
  archive: 'Archive',
};

const timeLine = (value: string | null): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `Last successful refresh ${date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`;
};

function section(): HTMLElement {
  const root = document.createElement('section');
  root.className = 'settings-section connection-group drive-settings hosted-drive-settings';
  const kicker = document.createElement('div');
  kicker.className = 'setting-kicker';
  kicker.textContent = 'Notebook account';
  const heading = document.createElement('h2');
  heading.textContent = 'Google Notebook';
  const state = document.createElement('div');
  state.className = 'drive-state';
  const documents = document.createElement('ul');
  documents.className = 'drive-documents';
  const openActions = document.createElement('div');
  openActions.className = 'row drive-open-actions';
  const actions = document.createElement('div');
  actions.className = 'row drive-actions';
  const note = document.createElement('div');
  note.className = 'note drive-note';
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  note.setAttribute('tabindex', '-1');
  root.append(kicker, heading, state, documents, openActions, actions, note);
  return root;
}

async function status(): Promise<HostedDriveStatus | null> {
  try {
    const response = await serviceFetch('/notebook/drive/hosted-setup');
    return response.ok ? await response.json() as HostedDriveStatus : null;
  } catch {
    return null;
  }
}

export async function renderHostedDriveSettings(host: HTMLElement): Promise<boolean> {
  const initial = await status();
  if (!initial) return false;
  const root = section();
  host.append(root);
  const state = root.querySelector('.drive-state') as HTMLElement;
  const documents = root.querySelector('.drive-documents') as HTMLElement;
  const openActions = root.querySelector('.drive-open-actions') as HTMLElement;
  const actions = root.querySelector('.drive-actions') as HTMLElement;
  const note = root.querySelector('.drive-note') as HTMLElement;
  const paint = (current: HostedDriveStatus): void => {
    state.replaceChildren();
    const account = document.createElement('strong');
    account.textContent = current.account ?? current.expectedAccount;
    const description = document.createElement('p');
    description.textContent = current.connected
      ? 'This Google account owns the three Drive sources Virgil refreshes in place.'
      : 'Automatic refresh is off. The existing Drive sources are unchanged.';
    state.append(account, description);
    const refreshed = timeLine(current.lastWriteAt);
    if (refreshed) {
      const line = document.createElement('p');
      line.className = 'meta drive-last-write';
      line.textContent = refreshed;
      state.append(line);
    }
    documents.replaceChildren();
    for (const key of current.documents) {
      const item = document.createElement('li');
      item.textContent = DOCUMENT_LABELS[key] ?? key;
      documents.append(item);
    }
    openActions.replaceChildren();
    if (current.connected) {
      const notebook = document.createElement('a');
      notebook.className = 'settings-link-action primary';
      const notebookUrl = notebookTarget(current.notebookUrl);
      notebook.href = notebookUrl;
      notebook.setAttribute('href', notebookUrl);
      notebook.target = '_blank';
      notebook.setAttribute('target', '_blank');
      notebook.rel = 'noreferrer';
      notebook.setAttribute('rel', 'noreferrer');
      notebook.textContent = 'Open Google Notebook';
      openActions.append(notebook);
      if (current.folderLink) {
        const folder = document.createElement('a');
        folder.className = 'settings-link-action';
        folder.href = current.folderLink;
        folder.setAttribute('href', current.folderLink);
        folder.target = '_blank';
        folder.setAttribute('target', '_blank');
        folder.rel = 'noreferrer';
        folder.setAttribute('rel', 'noreferrer');
        folder.textContent = 'Open source folder';
        openActions.append(folder);
      }
    }
    actions.replaceChildren();
    if (!current.connected) return;
    const disconnect = document.createElement('button');
    disconnect.className = 'link';
    disconnect.textContent = 'Disconnect automatic refresh';
    actions.append(disconnect);
    disconnect.addEventListener('click', async () => {
      disconnect.disabled = true;
      note.textContent = 'Disconnecting…';
      try {
        const response = await serviceFetch('/notebook/drive/hosted-setup', { method: 'DELETE' });
        if (!response.ok) throw new Error(DRIVE_REFUSED);
        note.textContent = 'Automatic refresh is off. No Google Drive file was deleted.';
        paint({ ...current, connected: false });
        note.focus();
      } catch (error) {
        disconnect.disabled = false;
        note.textContent = error instanceof Error && error.message === DRIVE_REFUSED
          ? DRIVE_REFUSED : DRIVE_UNREACHABLE;
      }
    });
  };
  paint(initial);
  return true;
}
