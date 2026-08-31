import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Clock } from '@sb/core';
import type { DriveAuth } from '@sb/adapters';
import type { DriveClientCredential } from './drive-credentials.js';

/**
 * The OAuth half of the Drive seam: Authorization Code with PKCE, on loopback.
 *
 * `NOTEBOOK_SEAM_V2.md` §4. The whole trust argument of this seam lives in this
 * file, so the properties are worth stating rather than leaving to be read out
 * of the code:
 *
 *  - **The grant is between the learner's Google account and the learner's own
 *    localhost service.** There is no Virgil server, no relay, and no callback
 *    on a domain anybody else controls. The redirect is a loopback address,
 *    which is the flow Google publishes for exactly this case.
 *  - **`127.0.0.1` only.** The listener binds the loopback interface and no
 *    other, on a port the operating system picks. A consent listener on
 *    `0.0.0.0` would be an authorization code arriving over somebody's wifi.
 *  - **One scope**, and §4.2 makes it a line rather than a default:
 *    `drive.file` grants access to the files this app created and nothing else.
 *    Adding a second scope is a decision that has to be argued on its own
 *    merits, with the verification burden and the consent-screen cost named in
 *    the argument. It does not arrive as an implementation detail.
 *  - **Nothing here is logged.** Not the code, not the tokens, not the client
 *    secret. §4.1's law: a Drive token is never returned by any endpoint, never
 *    written into the board, never logged, and never included in a receipt.
 *
 * ## Why PKCE on a flow that also has a client secret
 *
 * Google's desktop-app clients are public clients: the secret ships wherever the
 * app ships and is not a secret in the sense the word usually means. PKCE is
 * what actually binds the authorization code to the process that asked for it,
 * so an authorization code intercepted on its way to a loopback port is a code
 * nobody else can spend. Google's own guidance for installed apps requires it.
 */

/** §4.2. One scope, and it is a line. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** The one path the loopback listener answers. Anything else is a 404, because
 *  a browser tab wandering onto this port should find nothing. */
const CALLBACK_PATH = '/oauth2/drive';

/**
 * How long a consent URL is good for.
 *
 * Five minutes: long enough to pick a Google account and read a consent screen,
 * short enough that a listener nobody came back to does not sit on a port for
 * the rest of the day. When it lapses the listener closes, the state is
 * forgotten, and the URL becomes a link to a redirect that no longer resolves.
 */
export const CONSENT_WINDOW_MS = 5 * 60_000;

/** Access tokens are good for an hour; this asks for a new one a minute early
 *  so a nightly cannot start a request with sixteen seconds left on it. */
const TOKEN_SKEW_MS = 60_000;

const base64url = (buf: Buffer): string => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

/** 32 random bytes, base64url, and its SHA-256. Google requires `S256`; `plain`
 *  is accepted by the spec and is not used here, because a challenge equal to
 *  its verifier proves nothing about who is spending the code. */
export function pkce(): Pkce {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export interface ConsentUrlInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly state: string;
}

/**
 * The URL the learner's browser opens. Pure, so it can be asserted on.
 *
 * `access_type=offline` with `prompt=consent` is what makes Google return a
 * refresh token. Without both, a second connection on an account that has
 * already granted returns an access token alone, and the seam would work for an
 * hour and then quietly stop — which is the exact failure §11 exists to prevent,
 * arriving through the front door.
 */
export function consentUrl(input: ConsentUrlInput): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', DRIVE_SCOPE);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', input.state);
  return url.href;
}

/** Compared without saying how far the comparison got, the same way the shared
 *  secret is. A state parameter is short and an attacker can retry. */
function stateMatches(sent: string | null, wanted: string): boolean {
  if (typeof sent !== 'string') return false;
  const a = Buffer.from(sent, 'utf8');
  const b = Buffer.from(wanted, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The page the learner's browser lands on. Plain, self-contained, and it says
 *  the one thing they need: go back to Virgil. No script, no asset, no link. */
const landingPage = (heading: string, line: string): string =>
  '<!DOCTYPE html><html><head><meta charset="utf-8">'
  + '<title>Virgil</title></head><body style="font-family:system-ui;margin:3rem auto;max-width:32rem">'
  + `<h1 style="font-size:1.25rem">${heading}</h1><p>${line}</p></body></html>`;

export interface TokenGrant {
  readonly refreshToken: string;
  readonly scope: string;
}

export interface ConsentStart {
  readonly url: string;
  readonly redirectUri: string;
  readonly expiresAt: string;
}

export interface LoopbackConsentOptions {
  readonly client: DriveClientCredential;
  readonly clock: Clock;
  /** Overridden only by the in-process fake in the tests. */
  readonly tokenEndpoint?: string;
  readonly windowMs?: number;
}

/**
 * One consent attempt: a loopback listener, a URL, and a promise for the grant.
 *
 * Single-use by construction. `start` binds a port and returns the URL;
 * `granted` resolves when Google's browser redirect arrives and the code has
 * been exchanged, or rejects with a sentence a person can read. Either way the
 * listener closes and the state cannot be replayed.
 */
export class LoopbackConsent {
  private server: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private settled = false;
  private readonly state = base64url(randomBytes(24));
  private readonly verifier: string;
  private readonly challenge: string;
  private readonly tokenEndpoint: string;
  private readonly windowMs: number;
  private redirectUri = '';
  private resolve!: (grant: TokenGrant) => void;
  private reject!: (error: Error) => void;

  /** Resolves with the grant, or rejects with a sentence. Read once. */
  readonly granted: Promise<TokenGrant>;

  constructor(private readonly opts: LoopbackConsentOptions) {
    const pair = pkce();
    this.verifier = pair.verifier;
    this.challenge = pair.challenge;
    this.tokenEndpoint = opts.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT;
    this.windowMs = opts.windowMs ?? CONSENT_WINDOW_MS;
    this.granted = new Promise<TokenGrant>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // Nobody may be awaiting this at the moment it fails, and an unhandled
    // rejection would take the service down over a consent attempt somebody
    // abandoned. The real reader still sees the rejection.
    this.granted.catch(() => { /* the caller reads it, or nobody does */ });
  }

  async start(): Promise<ConsentStart> {
    const server = createServer((req, res) => { void this.handle(req.url ?? '', res); });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // 127.0.0.1 and port 0. The loopback interface, and a port the operating
      // system picks so two Virgils on one machine cannot collide.
      server.listen(0, '127.0.0.1', resolve);
    });
    // A consent nobody came back to must never be the reason a process refuses
    // to exit. The service's own listener is what keeps the loop alive.
    server.unref?.();
    const port = (server.address() as AddressInfo).port;
    this.redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

    this.timer = setTimeout(() => {
      this.fail('The Google sign in took too long, so I stopped waiting. Press Connect again.');
    }, this.windowMs);
    // A pending consent must never be the reason a process refuses to exit.
    this.timer.unref?.();

    return {
      url: consentUrl({
        clientId: this.opts.client.clientId,
        redirectUri: this.redirectUri,
        challenge: this.challenge,
        state: this.state,
      }),
      redirectUri: this.redirectUri,
      expiresAt: new Date(this.opts.clock.now().getTime() + this.windowMs).toISOString(),
    };
  }

  /** Abandon this attempt. Used when a second Connect replaces a first. */
  cancel(): void {
    this.fail('That sign in was replaced by a newer one.');
  }

  private async handle(rawUrl: string, res: { writeHead: (s: number, h: Record<string, string>) => void; end: (b?: string) => void }): Promise<void> {
    const url = new URL(rawUrl, 'http://127.0.0.1');
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    const answer = (heading: string, line: string): void => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(landingPage(heading, line));
    };

    if (!stateMatches(url.searchParams.get('state'), this.state)) {
      answer('That did not come from Virgil', 'Nothing was changed. You can close this tab and try again in Virgil.');
      this.fail('That sign in did not come back the way it went out, so I stopped it.');
      return;
    }
    const refused = url.searchParams.get('error');
    if (refused) {
      answer('No permission was given', 'Nothing was changed. You can close this tab.');
      this.fail(refused === 'access_denied'
        ? 'You did not give Virgil permission, so nothing was connected.'
        : 'Google stopped the sign in before it finished.');
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      answer('Something was missing', 'Nothing was changed. You can close this tab and try again in Virgil.');
      this.fail('Google did not send back what I needed to finish connecting.');
      return;
    }

    try {
      const grant = await exchangeCode({
        tokenEndpoint: this.tokenEndpoint,
        client: this.opts.client,
        code,
        verifier: this.verifier,
        redirectUri: this.redirectUri,
      });
      answer('Virgil is connected to your Drive',
        'You can close this tab. Virgil is writing your documents now.');
      this.done(grant);
    } catch (error) {
      answer('That did not go through', 'Nothing was changed. You can close this tab and try again in Virgil.');
      this.fail(error instanceof Error ? error.message : 'Connecting to Google Drive did not go through.');
    }
  }

  private done(grant: TokenGrant): void {
    if (this.settled) return;
    this.settled = true;
    this.stop();
    this.resolve(grant);
  }

  private fail(message: string): void {
    if (this.settled) return;
    this.settled = true;
    this.stop();
    this.reject(new Error(message));
  }

  private stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    // Closed rather than left listening: a port that stays open after the
    // exchange is a redirect somebody can replay a code at.
    this.server?.close();
    this.server = null;
  }
}

export interface ExchangeInput {
  readonly tokenEndpoint: string;
  readonly client: DriveClientCredential;
  readonly code: string;
  readonly verifier: string;
  readonly redirectUri: string;
}

/**
 * The authorization code, spent.
 *
 * A missing refresh token is treated as a failure rather than as a partial
 * success, because an access token alone works for an hour and then leaves a
 * notebook that silently stops being written to, which is the failure mode this
 * whole seam is built around.
 */
export async function exchangeCode(input: ExchangeInput): Promise<TokenGrant> {
  const body = new URLSearchParams({
    client_id: input.client.clientId,
    client_secret: input.client.clientSecret,
    code: input.code,
    code_verifier: input.verifier,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri,
  });
  const payload = await postForm(input.tokenEndpoint, body);
  if (!payload.ok) throw new Error(tokenFailure(payload.error));
  const refreshToken = payload.value?.refresh_token;
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new Error('Google did not give me a lasting permission, so I could not finish connecting. '
      + 'Removing Virgil from your Google account permissions and connecting again usually fixes it.');
  }
  const scope = typeof payload.value?.scope === 'string' ? payload.value.scope : DRIVE_SCOPE;
  return { refreshToken, scope };
}

/**
 * A live access token, refreshed from the stored grant when it has to be.
 *
 * This is the `DriveAuth` the adapter is handed, and it is the only thing that
 * ever sees the refresh token. It is held in memory for as long as it is good
 * for and asked for again a minute early; `refresh: true` from the adapter,
 * after a 401, forces a new one regardless of what the cache thinks.
 */
export class DriveTokens implements DriveAuth {
  private cached = '';
  private goodUntil = 0;

  constructor(private readonly opts: {
    readonly client: () => DriveClientCredential | null;
    readonly refreshToken: () => string;
    readonly clock: Clock;
    readonly tokenEndpoint?: string;
  }) {}

  /** Forget the cached access token. Called when the grant changes underneath
   *  us, so a reconnect cannot keep using the previous account's token. */
  forget(): void {
    this.cached = '';
    this.goodUntil = 0;
  }

  async accessToken(opts?: { readonly refresh?: boolean }): Promise<string> {
    const now = this.opts.clock.now().getTime();
    if (!opts?.refresh && this.cached && now < this.goodUntil) return this.cached;

    const client = this.opts.client();
    if (!client) {
      throw new Error('Virgil has no Google sign in details, so it cannot reach your Drive.');
    }
    const refreshToken = this.opts.refreshToken();
    if (!refreshToken) {
      throw new Error('Google Drive is not connected yet, so there is nowhere to put your documents.');
    }

    const payload = await postForm(this.opts.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT, new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }));
    if (!payload.ok) throw new Error(tokenFailure(payload.error));
    const token = payload.value?.access_token;
    if (typeof token !== 'string' || !token) {
      throw new Error('Google did not give me permission to write to your Drive this time.');
    }
    const seconds = typeof payload.value?.expires_in === 'number' ? payload.value.expires_in : 3600;
    this.cached = token;
    this.goodUntil = now + Math.max(0, seconds * 1000 - TOKEN_SKEW_MS);
    return token;
  }
}

/** Google's own error code, turned into a sentence. The response body is never
 *  passed through: it is Google's prose about an internal state, and on some
 *  failures it names the client id. */
function tokenFailure(error: string): string {
  if (error === 'invalid_grant') {
    return 'Google is not letting me into your Drive any more. '
      + "That usually means Virgil's access was removed in your Google account. "
      + 'Connecting again will fix it.';
  }
  if (error === 'invalid_client') {
    return 'Google did not recognise the sign in details Virgil was given. '
      + 'Check the client id and secret in Settings.';
  }
  if (error === 'unreachable') return 'I could not reach Google to finish that.';
  return 'Google would not complete that sign in.';
}

interface FormAnswer {
  readonly ok: boolean;
  readonly error: string;
  readonly value: Record<string, unknown> | null;
}

/** One form POST to Google's token endpoint. Nothing about it is logged. */
async function postForm(endpoint: string, body: URLSearchParams): Promise<FormAnswer> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, error: 'unreachable', value: null };
  }
  let value: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(await res.text());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      value = parsed as Record<string, unknown>;
    }
  } catch { value = null; }
  if (res.ok) return { ok: true, error: '', value };
  const named = value?.error;
  return { ok: false, error: typeof named === 'string' ? named : `status-${res.status}`, value: null };
}
