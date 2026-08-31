/**
 * Learning data stays in the service; the browser stores only the selected
 * account's token and provider address. Self-hosted deployments supply their
 * own public Firebase project configuration.
 */

/** Where this self-hosted deployment's provider is, and which project. Absent
 *  means the deployment did not provision account identity. */
export interface AuthConfig {
  readonly apiKey: string;
  readonly projectId: string;
  /** An Auth emulator's `host:port`. Absent is Google's real endpoints. */
  readonly emulatorHost?: string | null;
}

/** What a sign-in leaves behind. Never the password. */
export interface Session {
  readonly idToken: string;
  readonly refreshToken: string;
  /** Epoch ms. Compared against an injected now, never a wall clock read here. */
  readonly expiresAt: number;
  readonly uid: string;
  readonly email: string | null;
}

export const AUTH_CONFIG_KEY = 'sb_auth_config';
export const SESSION_KEY = 'sb_session';

/**
 * Refresh this long before expiry.
 *
 * A token that expires mid-request is a 401 on a pin somebody just made, and
 * the pin is the one thing in this product that must not be lost to a retry
 * somebody has to notice. Sixty seconds is longer than any request this
 * extension makes by two orders of magnitude.
 */
export const REFRESH_MARGIN_MS = 60_000;

// ------------------------------------------------------------------ the shapes

export function isAuthConfig(value: unknown): value is AuthConfig {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return typeof c['apiKey'] === 'string' && c['apiKey'] !== ''
    && typeof c['projectId'] === 'string' && c['projectId'] !== ''
    && (c['emulatorHost'] == null || typeof c['emulatorHost'] === 'string');
}

export function isSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return typeof s['idToken'] === 'string' && s['idToken'] !== ''
    && typeof s['refreshToken'] === 'string'
    && typeof s['expiresAt'] === 'number' && Number.isFinite(s['expiresAt'])
    && typeof s['uid'] === 'string' && s['uid'] !== ''
    && (s['email'] === null || typeof s['email'] === 'string');
}

/** Whether a token is still worth sending. */
export function isFresh(session: Session, now: number): boolean {
  return session.expiresAt - REFRESH_MARGIN_MS > now;
}

// ----------------------------------------------------------------- the addresses

/**
 * The identity endpoint. `http` for an emulator on a host:port, `https` for
 * Google — an emulator reached over https answers nothing, and Google over
 * http is a token in clear text.
 */
export function identityUrl(config: AuthConfig, method: string): string {
  const base = config.emulatorHost
    ? `http://${config.emulatorHost}/identitytoolkit.googleapis.com/v1`
    : 'https://identitytoolkit.googleapis.com/v1';
  return `${base}/accounts:${method}?key=${encodeURIComponent(config.apiKey)}`;
}

export function refreshUrl(config: AuthConfig): string {
  const base = config.emulatorHost
    ? `http://${config.emulatorHost}/securetoken.googleapis.com/v1`
    : 'https://securetoken.googleapis.com/v1';
  return `${base}/token?key=${encodeURIComponent(config.apiKey)}`;
}

// ------------------------------------------------------------------- the replies

/** `expiresIn` arrives as a string of seconds. A reply missing it is a reply
 *  this cannot honour, rather than one to guess a lifetime for. */
export function sessionFrom(reply: unknown, now: number): Session | null {
  if (!reply || typeof reply !== 'object') return null;
  const r = reply as Record<string, unknown>;
  const idToken = typeof r['idToken'] === 'string' ? r['idToken'] : '';
  const refreshToken = typeof r['refreshToken'] === 'string' ? r['refreshToken'] : '';
  const uid = typeof r['localId'] === 'string' ? r['localId'] : '';
  const seconds = Number(r['expiresIn']);
  if (!idToken || !refreshToken || !uid || !Number.isFinite(seconds) || seconds <= 0) return null;
  return {
    idToken, refreshToken, uid,
    email: typeof r['email'] === 'string' && r['email'] !== '' ? r['email'] : null,
    expiresAt: now + seconds * 1000,
  };
}

/** The refresh endpoint answers in snake_case, and with no email. Keeping the
 *  old one is right: refreshing a token does not change who you are. */
export function refreshedFrom(reply: unknown, previous: Session, now: number): Session | null {
  if (!reply || typeof reply !== 'object') return null;
  const r = reply as Record<string, unknown>;
  const idToken = typeof r['id_token'] === 'string' ? r['id_token'] : '';
  const refreshToken = typeof r['refresh_token'] === 'string' ? r['refresh_token'] : previous.refreshToken;
  const seconds = Number(r['expires_in']);
  if (!idToken || !Number.isFinite(seconds) || seconds <= 0) return null;
  return { ...previous, idToken, refreshToken, expiresAt: now + seconds * 1000 };
}

/**
 * What to tell somebody whose sign-in did not work.
 *
 * The provider's own codes are shouted constants meant for a developer. A
 * learner gets a sentence and never Firebase vocabulary.
 */
export function signInRefusal(code: unknown, status?: number): string {
  const c = typeof code === 'string' ? code.split(' ')[0] : '';
  switch (c) {
    case 'OPERATION_NOT_ALLOWED':
      return 'Google sign-in is not ready for this copy of Virgil yet.';
    case 'INVALID_IDP_RESPONSE':
    case 'INVALID_CREDENTIAL':
      return 'Google could not confirm that account. Try again.';
    case 'TOO_MANY_ATTEMPTS_TRY_LATER':
      return 'Too many attempts. Wait a minute and try again.';
    case 'USER_DISABLED':
      return 'That account has been disabled.';
    default:
      return status === undefined
        ? "Google sign-in isn't responding right now."
        : 'Google sign-in could not finish. This is mine to fix, not yours.';
  }
}

/** How a learner is named on screen. The address if there is one; otherwise
 *  the account, shortened — never a bare 28-character uid across a masthead. */
export function learnerLabel(session: Session | null): string | null {
  if (!session) return null;
  return session.email ?? `Account ${session.uid.slice(0, 6)}`;
}

// =========================================================== the chrome-shaped part
//
// Everything above is pure and tested against no browser. Everything below is
// storage and three fetches, kept apart for the same reason `queue.ts` and
// `prefs.ts` keep their storage at the bottom: the judgements are the part
// worth testing, and a stub that models nothing is how this project shipped a
// tap that had never once worked.

/**
 * The provider provisioned with this copy of Virgil.
 *
 * There is deliberately no shipped fallback. A universal Firebase project
 * would make an ostensibly self-hosted product send every learner's account
 * record to the project owner. Installation writes the public project config
 * belonging to that learner's deployment; local QA writes the emulator config.
 */
export async function readAuthConfig(): Promise<AuthConfig | null> {
  try {
    const got = await chrome.storage.local.get(AUTH_CONFIG_KEY);
    const value = (got as Record<string, unknown>)[AUTH_CONFIG_KEY];
    return isAuthConfig(value) ? value : null;
  } catch { return null; }
}

/**
 * Recover the public identity boundary from the learner's own service.
 *
 * Installation normally writes this value beside the service origin. The
 * hosted page also publishes it because it is Firebase's public browser
 * configuration, not a credential. Reading it only after a personal endpoint
 * has answered 401/403 keeps an unconfigured single-board laptop exactly as it
 * was and turns a missed provisioning write into a sign-in door instead of an
 * infrastructure refusal.
 */
export async function discoverAuthConfig(serviceOrigin: string): Promise<AuthConfig | null> {
  const saved = await readAuthConfig();
  if (saved) return saved;
  try {
    const reply = await fetch(new URL('/app/config.json', serviceOrigin).href);
    if (!reply.ok) return null;
    const body = await reply.json() as { authConfig?: unknown };
    if (!isAuthConfig(body?.authConfig)) return null;
    await chrome.storage.local.set({ [AUTH_CONFIG_KEY]: body.authConfig });
    return body.authConfig;
  } catch {
    return null;
  }
}

export async function readSession(): Promise<Session | null> {
  try {
    const got = await chrome.storage.local.get(SESSION_KEY);
    const value = (got as Record<string, unknown>)[SESSION_KEY];
    return isSession(value) ? value : null;
  } catch { return null; }
}

/** Written rather than removed, for the reason the hand-off is: `remove` is a
 *  namespace member some stubs do not have, and null reads the same. */
export async function writeSession(session: Session | null): Promise<void> {
  try { await chrome.storage.local.set({ [SESSION_KEY]: session }); } catch { /* nothing to do */ }
}

/**
 * The token to send, refreshed if it is close to expiring, or null.
 *
 * Null has two meanings that are the same to the caller: no provider is
 * configured (the ordinary local install, which sends no header and reaches
 * the single-board service), and nobody is signed in. The screens tell those
 * apart by asking `readAuthConfig` — this does not, because the request it is
 * about is identical either way.
 */
export interface CurrentIdentity {
  readonly uid: string;
  readonly token: string;
}

/**
 * One refresh per stored credential.
 *
 * A page room starts several personal reads together. If each one rotates the
 * same near-expiry token independently, an old-token refusal can arrive after
 * a successful rotation and clear the new session. Keeping the promise makes
 * every concurrent caller wait for the same provider answer.
 */
let refreshFlight: { key: string; result: Promise<Session | null> } | null = null;

const refreshKey = (session: Session): string =>
  `${session.uid}\u0000${session.idToken}\u0000${session.refreshToken}`;

async function refreshStoredSession(
  config: AuthConfig, previous: Session, now: number,
): Promise<Session | null> {
  const key = refreshKey(previous);
  if (refreshFlight?.key === key) return refreshFlight.result;

  const result = (async (): Promise<Session | null> => {
    const refreshed = await refresh(config, previous, now);
    // Sign out or Switch user can finish while the provider is answering. An
    // old reply must neither overwrite nor erase that newer account.
    const stored = await readSession();
    if (!stored || refreshKey(stored) !== key) return null;
    await writeSession(refreshed);
    return refreshed;
  })();
  refreshFlight = { key, result };
  try {
    return await result;
  } finally {
    if (refreshFlight?.result === result) refreshFlight = null;
  }
}

/** One coherent account snapshot, so ownership checks and credentials cannot drift apart. */
export async function currentIdentity(now: number = Date.now()): Promise<CurrentIdentity | null> {
  const config = await readAuthConfig();
  if (!config) return null;
  const session = await readSession();
  if (!session) return null;
  if (isFresh(session, now)) return { uid: session.uid, token: session.idToken };

  const refreshed = await refreshStoredSession(config, session, now);
  if (!refreshed) return null;
  return { uid: refreshed.uid, token: refreshed.idToken };
}

export async function currentToken(now: number = Date.now()): Promise<string | null> {
  return (await currentIdentity(now))?.token ?? null;
}

async function refresh(config: AuthConfig, session: Session, now: number): Promise<Session | null> {
  try {
    const res = await fetch(refreshUrl(config), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: session.refreshToken }),
    });
    if (!res.ok) return null;
    return refreshedFrom(await res.json(), session, now);
  } catch { return null; }
}

export interface SignInResult {
  readonly session: Session | null;
  /** A sentence for the learner. Null when it worked. */
  readonly refusal: string | null;
}

/** The Google scopes used only to establish identity. Drive is requested later,
 *  in context, when the learner actually connects Drive. */
export const GOOGLE_IDENTITY_SCOPES = Object.freeze([
  'openid',
  'email',
  'profile',
]);

/** Exchange the Google credential Chrome obtained for the Firebase token that
 *  this self-hosted service can verify. */
export async function signInWithGoogle(now: number = Date.now()): Promise<SignInResult> {
  const config = await readAuthConfig();
  if (!config) {
    return { session: null, refusal: 'Google sign-in was not provisioned with this copy of Virgil.' };
  }

  let googleToken = '';
  try {
    const reply = await chrome.identity.getAuthToken({
      interactive: true,
      scopes: [...GOOGLE_IDENTITY_SCOPES],
    });
    googleToken = typeof reply === 'string' ? reply : reply.token ?? '';
  } catch {
    return { session: null, refusal: 'Google sign-in did not finish. Nothing was changed.' };
  }
  if (!googleToken) {
    return { session: null, refusal: 'Google sign-in did not return an account. Nothing was changed.' };
  }

  // The Auth emulator cannot validate a real Google access token and accepts
  // an unsigned test ID token instead. Production takes Chrome's access token.
  const credential = config.emulatorHost
    ? `id_token=${encodeURIComponent(googleToken)}`
    : `access_token=${encodeURIComponent(googleToken)}`;
  const postBody = `${credential}&providerId=google.com`;

  try {
    const res = await fetch(identityUrl(config, 'signInWithIdp'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        postBody,
        // Chrome's identity API uses the extension redirect. The same module
        // also runs on the board served by the user's Virgil deployment, where
        // the authorised origin is the page itself and the web runtime marks
        // that shape with an empty runtime id.
        requestUri: chrome.runtime.id
          ? `https://${chrome.runtime.id}.chromiumapp.org/`
          : new URL('/app/', location.origin).href,
        returnIdpCredential: true,
        returnSecureToken: true,
      }),
    });
    const body = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      const detail = body['error'] as Record<string, unknown> | undefined;
      return { session: null, refusal: signInRefusal(detail?.['message'], res.status) };
    }
    const session = sessionFrom(body, now);
    if (!session) return { session: null, refusal: 'Google signed in, but Virgil could not read the account.' };
    await writeSession(session);
    return { session, refusal: null };
  } catch {
    return { session: null, refusal: "Google sign-in isn't responding right now." };
  }
}

/** Sign out. The token goes; the board does not, because the board was never
 *  here — it is on the service, which is what makes it reachable from another
 *  browser at all. */
export async function signOut(): Promise<void> {
  await writeSession(null);
}

export interface DeleteResult {
  readonly gone: boolean;
  /** How far the irreversible sequence reached. The panel needs this to keep a
   * board-delete refusal retryable while routing a board-gone/account-live
   * partial result back through sign-in instead of leaving a dead Account UI. */
  readonly stage: 'none' | 'board' | 'all';
  readonly note: string;
}

/**
 * Delete the account, and the board with it.
 *
 * **Order matters and is the whole design of this function.** The board is
 * deleted first, while the token still works. Deleting the Firebase account
 * first would revoke the token that is the only way to reach the board, and
 * the learner's data would sit on the service for ever with nobody left who
 * could ask for it — the opposite of what they pressed the button for.
 *
 * So: board, then account, then the local token. If the board deletion fails,
 * nothing else happens and they are told, because a half-deleted account is
 * worse than one that is still there.
 */
export async function deleteAccount(
  deleteBoard: () => Promise<boolean>,
): Promise<DeleteResult> {
  const config = await readAuthConfig();
  const token = await currentToken();
  if (!config || !token) return { gone: false, stage: 'none', note: 'Sign in first.' };

  const boardGone = await deleteBoard().catch(() => false);
  if (!boardGone) {
    return {
      gone: false, stage: 'none',
      note: 'I could not delete your board, so I have not touched your account. Nothing has changed.',
    };
  }

  try {
    const res = await fetch(identityUrl(config, 'delete'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });
    if (!res.ok) {
      // The board is gone and the account is not. Said plainly rather than
      // reported as success, because they will otherwise find they can still
      // sign in and will not know what happened to their work.
      await writeSession(null);
      return {
        gone: false, stage: 'board',
        note: 'Your board is deleted. The account itself could not be removed. Sign in again and try once more.',
      };
    }
  } catch {
    await writeSession(null);
    return {
      gone: false, stage: 'board',
      note: 'Your board is deleted, but I could not remove the account itself. Sign in again to finish.',
    };
  }

  await writeSession(null);
  return { gone: true, stage: 'all', note: 'Your account and everything on your board are gone.' };
}
