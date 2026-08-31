import { writeSession } from './identity.js';
import { serviceFetch } from './service.js';

export const DEMO_WORKSPACE_ID = 'judge-workspace-v1';

export interface DemoAccessView {
  readonly active: true;
  readonly dailyCloudTokens: number;
  readonly resets: '00:00 UTC';
  readonly isolatedBoard: true;
  readonly personalConnections: false;
}

type DemoAccessResult = { readonly kind: 'ok'; readonly body: DemoAccessView }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'refused'; readonly status: number | null };

interface DemoLoginView extends DemoAccessView {
  readonly token: string;
  readonly expiresAt: number;
  readonly uid: string;
}

/** The query is only an unlinked entrance. Deployment configuration is the
 * off-by-default switch; the password remains the credential. */
export const demoEntryRequested = (surface: 'panel' | 'page'): boolean => surface === 'page'
  && typeof location !== 'undefined'
  && (globalThis as typeof globalThis & {
    __VIRGIL_WEB_CONFIG__?: { readonly judgeDemoEnabled?: boolean };
  }).__VIRGIL_WEB_CONFIG__?.judgeDemoEnabled === true
  && new URLSearchParams(location.search).get('judge') === '1';

const loginView = (value: unknown): DemoLoginView | null => {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  return row.active === true && row.isolatedBoard === true && row.personalConnections === false
    && row.resets === '00:00 UTC' && Number.isSafeInteger(row.dailyCloudTokens)
    && typeof row.token === 'string' && row.token !== ''
    && Number.isFinite(row.expiresAt) && typeof row.uid === 'string' && row.uid !== ''
    ? row as unknown as DemoLoginView : null;
};

export type DemoLoginResult = { readonly kind: 'ok'; readonly uid: string }
  | { readonly kind: 'unreachable' | 'refused' };

/** Password in, opaque session out. The password is never persisted. */
export async function loginToDemo(pass: string): Promise<DemoLoginResult> {
  let response: Response;
  try {
    response = await serviceFetch('/judge/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pass }),
    });
  } catch { return { kind: 'unreachable' }; }
  if (!response.ok) return { kind: 'refused' };
  const body = loginView(await response.json().catch(() => null));
  if (!body) return { kind: 'refused' };
  await writeSession({
    idToken: body.token, refreshToken: '', expiresAt: body.expiresAt,
    uid: body.uid, email: null,
  });
  return { kind: 'ok', uid: body.uid };
}

const html = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function signInMarkup(options: {
  readonly switching: boolean; readonly demo: boolean; readonly currentLabel: string | null;
}): string {
  const { switching, demo } = options;
  return `<section class="signin signin-shell">
    <div class="signin-intro">
      <div class="setting-kicker">${switching ? 'Virgil account' : 'Virgil · AI learning manager'}</div>
      <h1>${switching ? 'Switch account' : 'Sign in'}</h1>
      ${switching ? '' : '<p class="signin-promise">Stop collecting things to learn. Start knowing what to do next.</p>'}
      <p class="signin-lead">${switching ? 'Move to another Virgil board without abandoning this one first.' : 'Capture what you are already reading or working on. Virgil turns it into a short lesson, learns from what is still fuzzy, and keeps one useful next move ready.'}</p>
      ${switching ? '' : '<ol class="signin-loop" aria-label="How Virgil works"><li><strong>Capture</strong><span>Pin a source or add your own material.</span></li><li><strong>Learn</strong><span>Use Virgil, Gemini or Google Notebook.</span></li><li><strong>Grow</strong><span>Your signals update the board and shape what comes next.</span></li></ol>'}
      <p class="meta">${switching ? 'Your lessons, plan and progress stay with the account you choose.' : 'Your account keeps the same board, plan and progress across this Virgil installation.'}</p>
    </div>
    <form class="signin-card${demo ? ' judge-entry-card' : ''}" data-signin-form>
      <div class="setting-kicker">${demo ? 'Private demo access' : 'Google account'}</div>
      <h2>${switching ? 'Choose another account' : demo ? 'Open demo mode' : 'Open your learning board'}</h2>
      ${switching && options.currentLabel ? `<p class="current-account">Signed in now as <strong>${html(options.currentLabel)}</strong>.</p>` : ''}
      ${demo ? '<div class="judge-entry"><p>This password opens the full Virgil build on a shared demo board with a server-enforced hosted-model allowance. Personal connections start off.</p><label for="judge-pass">Demo password</label><input id="judge-pass" data-judge-pass type="password" autocomplete="off" spellcheck="false" placeholder="Enter the password supplied with the submission"></div>' : ''}
      <div class="row"><button class="primary google-signin" data-google${demo ? ' type="submit"' : ' type="button"'}>${switching ? 'Continue with another Google account' : demo ? 'Open demo mode' : 'Continue with Google'}</button>${switching && options.currentLabel ? '<button type="button" data-stay>Keep this account</button>' : ''}</div>
      <p class="signin-trust">${demo ? 'The demo password is checked by this Virgil deployment and is not saved in the browser.' : 'Google handles sign-in. Virgil never receives or stores your password.'}</p>
      <p class="signin-separate">${demo ? 'This is the same product build as the main app; only the starting board and connection state differ.' : 'Your Google Notebook connection is separate. Signing in here does not change its account.'}</p>
      <p class="refusal" role="alert"></p>
    </form>
  </section>`;
}

export function accountMarkup(demo: boolean): {
  readonly hero: string; readonly access: string; readonly data: string;
} {
  const state = demo
    ? 'Signed in with the private Demo password. This browser holds only a temporary Demo session.'
    : 'Signed in with Google. Virgil never receives or stores your password.';
  const switchHeading = demo ? 'Use your own Virgil board' : 'Use another Google account';
  const switchLine = demo
    ? 'Google sign-in opens a separate personal board. It does not attach that account to this shared Demo board.'
    : 'This board stays signed in until another account succeeds.';
  const leaveHeading = demo ? 'Leave Demo mode' : 'Leave this browser';
  const leaveLine = demo
    ? "The shared Demo board stays available for the next judge; this browser forgets its temporary session."
    : 'Your board and Google Notebook connection stay unchanged.';
  const dataLine = demo
    ? 'A portable copy of the shared Demo board is available in Settings. Restore and deletion are held back on this shared workspace.'
    : 'Backup, restore and permanent deletion live in Settings.';
  return {
    hero: `<section class="account-hero"><div><div class="setting-kicker">Virgil account</div><h1>Your account</h1><p class="account-email"></p><p class="state">${state}</p></div><span class="connection-badge good">Signed in</span></section>`,
    access: `<section class="account-block account-access"><h2>Account access</h2><div class="account-choice"><div><strong>${switchHeading}</strong><p>${switchLine}</p></div><button data-switch>${demo ? 'Continue with Google' : 'Switch account'}</button></div><div class="account-choice"><div><strong>${leaveHeading}</strong><p>${leaveLine}</p></div><button class="link" data-signout>Sign out</button></div></section>`,
    data: `<section class="account-block account-data-pointer"><div><strong>Your data</strong><p>${dataLine}</p></div><button class="link" data-data-settings>Open Your data</button></section>`,
  };
}

export function dataTransferMarkup(demo: boolean): string {
  const heading = demo ? 'Download this board' : 'Backup and restore';
  const line = demo
    ? 'Download a portable copy of the shared Demo board and its preferences. Saved keys, sign-in details and personal connections stay out of it.'
    : 'Download a portable copy of this board and its preferences, or restore one onto an empty board. It includes model routes, your Local endpoint, budget and Privacy choices. Saved model keys and Google sign-in stay out of it.';
  return `<div class="account-block account-data"><h2>${heading}</h2><p class="state">${line}</p><div class="row"><button class="link" data-download-backup>Download a copy</button><button class="link" data-choose-backup${demo ? ' hidden' : ''}>Choose a backup to restore</button><input data-backup-file type="file" accept="application/json,.json" aria-label="Virgil backup file" hidden></div><div class="backup-result" aria-live="polite"></div></div>`;
}

export const sharedDemoDataMarkup = (): string =>
  `<div class="account-block"><h2>Shared Demo board</h2><p class="state">This board is disposable but shared between judges. Restore and permanent deletion are held back so one visit cannot erase another. Leaving Demo mode only removes this browser's temporary session.</p></div>`;

export async function submitDemo(
  input: HTMLInputElement, button: HTMLButtonElement, refusal: HTMLElement,
): Promise<string | null> {
  const pass = input.value.trim();
  if (pass.length < 20) {
    refusal.textContent = 'Enter the demo password supplied with the submission.';
    input.focus();
    return null;
  }
  button.disabled = true;
  // Keep the credential in a local string only for the exchange. In
  // particular, do not leave it sitting in inspectable DOM while the network
  // request is in flight or after a refused answer.
  input.value = '';
  const result = await loginToDemo(pass);
  button.disabled = false;
  if (result.kind === 'ok') return result.uid;
  refusal.textContent = result.kind === 'unreachable'
    ? 'Virgil could not check that password. Nothing was opened; try again.'
    : 'That demo password is not valid.';
  return null;
}

interface SignInActionOptions {
  readonly demo: boolean;
  readonly form?: HTMLFormElement | null;
  readonly input: HTMLInputElement | null;
  readonly button: HTMLButtonElement;
  readonly refusal: HTMLElement;
  readonly google: () => Promise<{ readonly refusal: string | null }>;
  readonly currentUid: () => Promise<string | null>;
  readonly adopt: (uid: string) => void;
  readonly completeDemo: () => Promise<void>;
  readonly completeGoogle: () => Promise<void>;
}

/** One sign-in press, with Demo and Google kept mutually exclusive. This lives
 * beside the Demo credential exchange so isolated panel mounts cannot grow a
 * second, subtly different copy of the identity transition. */
export function wireSignInAction(options: SignInActionOptions): void {
  let submitting = false;
  const submit = async (): Promise<void> => {
    if (submitting) return;
    submitting = true;
    try {
      options.refusal.textContent = '';
      if (options.demo) {
        const uid = options.input
          ? await submitDemo(options.input, options.button, options.refusal) : null;
        if (uid) {
          options.adopt(uid);
          await options.completeDemo();
        }
        return;
      }
      options.button.disabled = true;
      const result = await options.google();
      if (result.refusal !== null) {
        options.button.disabled = false;
        options.refusal.textContent = result.refusal;
        return;
      }
      options.button.disabled = false;
      const uid = await options.currentUid();
      if (uid) options.adopt(uid);
      await options.completeGoogle();
    } finally {
      submitting = false;
    }
  };
  options.input?.addEventListener('input', () => {
    options.refusal.textContent = '';
  });
  options.button.addEventListener('click', (event) => {
    // A real submit button will otherwise dispatch both this click and the
    // form submit below. Preventing the default keeps one exchange per press;
    // the submit listener remains the keyboard/Enter path.
    if (options.demo) event.preventDefault();
    void submit();
  });
  options.form?.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });
}

/** Resolve the private capability only for the shared Demo identity. Keeping
 * this outside panel.ts also keeps repeated isolated panel mounts from
 * rebuilding Demo-only routing state. */
export async function readDemoAccess(
  uid: string | null | undefined,
  read: (path: string) => Promise<DemoAccessResult>,
): Promise<DemoAccessView | null> {
  if (uid !== DEMO_WORKSPACE_ID) return null;
  const result = await read('/judge/access');
  return result.kind === 'ok' ? result.body : null;
}

export function demoAccessCard(
  make: (markup: string) => HTMLElement, demo: DemoAccessView,
): HTMLElement {
  const node = make(`<aside class="judge-access" aria-label="Demo mode">
    <div class="judge-access-mark" aria-hidden="true">D</div>
    <div><div class="setting-kicker">Demo mode</div>
      <strong>Full Virgil build · private demo board</strong>
      <p>Cloud/API model use is capped at <span data-demo-limit></span> tokens per UTC day and resets at ${demo.resets}. Personal Notebook and Drive connections start off.</p>
    </div>
  </aside>`);
  (node.querySelector('[data-demo-limit]') as HTMLElement).textContent =
    Math.max(0, Math.round(demo.dailyCloudTokens)).toLocaleString('en-US');
  return node;
}

/** The shared Demo board can spend through the owner's managed connection,
 * but it must never expose the owner's routing or credential controls. */
export function demoModelReceipt(
  make: (markup: string) => HTMLElement, demo: DemoAccessView,
): HTMLElement {
  const section = make(`<section class="settings-section demo-model-receipt">
    <div class="setting-kicker">Demo mode</div>
    <h2>Model access on this shared board</h2>
    <p class="setting-explain">The full product can use this Virgil deployment’s managed Cloud/API connection. This page is a read-only receipt so every judge uses the same protected setup.</p>
    <dl class="demo-model-facts">
      <div><dt>Connection</dt><dd>Cloud/API · managed by this Virgil deployment</dd></div>
      <div><dt>Daily allowance</dt><dd data-demo-model-limit></dd></div>
      <div><dt>Reset</dt><dd></dd></div>
      <div><dt>Personal connections</dt><dd>Off on the shared Demo board</dd></div>
    </dl>
    <p class="meta demo-model-boundary">Model routing, connection checks, credentials and budget changes are held by the Virgil owner.</p>
  </section>`);
  (section.querySelector('[data-demo-model-limit]') as HTMLElement).textContent =
    `${Math.max(0, Math.round(demo.dailyCloudTokens)).toLocaleString('en-US')} tokens per UTC day`;
  (section.querySelectorAll('dd')[2] as HTMLElement).textContent = demo.resets;
  return section;
}
