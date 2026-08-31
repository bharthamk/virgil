import { currentToken } from './identity.js';
/**
 * The one way this extension talks to the service — the service-protection contract.
 *
 * An account-backed service is protected by the Firebase token this module
 * attaches. A single-board service may instead be protected by an operator-
 * provisioned shared-secret header. Those are two deployment shapes, not two
 * credentials a learner has to supply.
 *
 * ## Why there is a module for two lines of header
 *
 * Because "does the extension send the secret" is a property of *every*
 * request, not of the three that happened to be written on the same afternoon.
 * A raw `fetch` added next to the others would be a route that works on a
 * laptop and is dead the moment the service is exposed — answering 401 into
 * paths that all swallow failure by design, so the panel shows an empty state
 * on a healthy board and nothing anywhere says why. `extension-surface.test.ts`
 * enforces that this file is the only door.
 *
 * ## Where a legacy single-board secret comes from
 *
 * `chrome.storage.local`, provisioned with that deployment. Never a literal
 * here: the bundle is a directory anybody with the extension can read, and a
 * default baked in is a default every install shares. It has no learner-facing
 * field. Absent is the ordinary account-backed and loopback case, and then no
 * header is sent at all.
 *
 * Read per request rather than cached. The read is a local key lookup costing
 * nothing against the 2.5s toast budget, and a cache in an MV3 worker that
 * Chrome restarts at will would be a staleness window bought for no measurable
 * saving. It also means deployment provisioning does not need to wake the
 * worker after changing it.
 */

/** The self-hosted service on this machine. A packaged remote deployment
 *  provisions its own HTTPS origin during installation. */
export const SERVICE = 'http://127.0.0.1:8791';
export const SERVICE_OVERRIDE_KEY = 'sb_service_url';

/** The header the service requires. Must match `runner/src/runtime.ts`. */
export const SHARED_SECRET_HEADER = 'x-virgil-secret';
/** The learner's browser-owned IANA zone. It is request context, not a server
 * deployment setting, so two devices can read the same board on their own
 * calendar day without racing a global preference. */
export const TIME_ZONE_HEADER = 'x-virgil-time-zone';
/** Browser/service compatibility protocol. Independent of release semver. */
export const CLIENT_SCHEMA_HEADER = 'x-virgil-client-schema';
export const CLIENT_SCHEMA_VERSION = 1;

/** A room read must eventually become a recovery state rather than an eternal
 * spinner. Writes deliberately do not inherit this deadline: once a mutating
 * request has left the browser, a timeout cannot prove whether it landed and a
 * blind retry would be the more dangerous failure. */
export const SERVICE_READ_DEADLINE_MS = 12_000;

export interface DeadlinedRequest {
  readonly init: RequestInit;
  readonly finish: () => void;
}

/**
 * Give an idempotent room read the room's cancellation signal.
 *
 * Kept beside the shared deadline so GET and HEAD cannot quietly diverge at
 * the two layers. A caller-owned signal wins; this helper never replaces it.
 */
export function withRoomReadCancellation(
  init: RequestInit, signal: AbortSignal,
): RequestInit {
  const method = (init.method ?? 'GET').toUpperCase();
  return (method === 'GET' || method === 'HEAD') && init.signal === undefined
    ? { ...init, signal }
    : init;
}

/**
 * Add the shared read deadline while preserving a room-owned cancellation.
 *
 * Exported for the transport contract tests. Callers still use serviceFetch;
 * this is not a second service door.
 */
export function withReadDeadline(
  init: RequestInit, afterMs = SERVICE_READ_DEADLINE_MS,
): DeadlinedRequest {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return { init, finish: () => {} };

  const controller = new AbortController();
  const upstream = init.signal;
  const abortFromUpstream = (): void => { controller.abort(); };
  if (upstream?.aborted) abortFromUpstream();
  else upstream?.addEventListener('abort', abortFromUpstream, { once: true });
  const timer = setTimeout(() => { controller.abort(); }, afterMs);

  return {
    init: { ...init, signal: controller.signal },
    finish: () => {
      clearTimeout(timer);
      upstream?.removeEventListener('abort', abortFromUpstream);
    },
  };
}

/** Optional deployment provisioning for a protected single-board service. */
export const SHARED_SECRET_KEY = 'sb_shared_secret';

/**
 * The secret, or null.
 *
 * Storage that throws is null rather than an exception: a quota failure or a
 * worker torn down mid-read must not turn a capture into a lost pin, and a
 * request without the header fails visibly at the service instead.
 */
export async function sharedSecret(): Promise<string | null> {
  try {
    const got = await chrome.storage.local.get(SHARED_SECRET_KEY);
    const value = (got as Record<string, unknown>)[SHARED_SECRET_KEY];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * The caller's headers with the secret added — added, never replacing.
 *
 * A POST that lost its `content-type` on the way through here would be a 400
 * from the service's own `readBody`, introduced by the code that closed the
 * door.
 */
export async function serviceHeaders(
  base: Record<string, string> = {},
): Promise<Record<string, string>> {
  return serviceHeadersFor(base, await currentToken());
}

/** Use an already-checked identity snapshot; null is an intentional local request. */
export async function serviceHeadersFor(
  base: Record<string, string>, token: string | null,
): Promise<Record<string, string>> {
  const secret = await sharedSecret();
  let timeZone = '';
  try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''; } catch { /* absent */ }
  const withClient = { ...base, [CLIENT_SCHEMA_HEADER]: String(CLIENT_SCHEMA_VERSION) };
  const withZone = timeZone ? { ...withClient, [TIME_ZONE_HEADER]: timeZone } : withClient;
  const withSecret = secret === null
    ? withZone : { ...withZone, [SHARED_SECRET_HEADER]: secret };

  /**
   * And who is asking — the learner-identity contract.
   *
   * Null covers two cases the request cannot tell apart: no provider is
   * configured, which is the ordinary local install reaching the single-board
   * service, and nobody is signed in. Neither sends a header, because an empty
   * `Authorization` is a different thing from an absent one and the service
   * refuses it either way.
   *
   * Here rather than at each call site for the reason the secret is here:
   * `serviceFetch` is the one door out of this extension, and a route that
   * forgot the token would be a learner's pin landing in a 401 nobody wrote a
   * screen for.
   */
  return token === null ? withSecret : { ...withSecret, authorization: `Bearer ${token}` };
}

/** A request to the service, addressed and credentialed. */
export async function serviceFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const [headers, base] = await Promise.all([
    serviceHeaders(init.headers as Record<string, string> | undefined),
    serviceBase(),
  ]);
  const request = withReadDeadline({ ...init, headers });
  try { return await fetch(`${base}${path}`, request.init); }
  finally { request.finish(); }
}

export async function serviceFetchAs(
  path: string, token: string | null, init: RequestInit = {},
): Promise<Response> {
  const [headers, base] = await Promise.all([
    serviceHeadersFor(init.headers as Record<string, string> | undefined ?? {}, token),
    serviceBase(),
  ]);
  const request = withReadDeadline({ ...init, headers });
  try { return await fetch(`${base}${path}`, request.init); }
  finally { request.finish(); }
}

/**
 * The service origin is deployment provisioning, never a learner setting.
 * Loopback is valid for a service on this machine; HTTPS is valid for a service
 * the learner deployed. Plain HTTP to another host is refused because it would
 * send the learner's token across the network in clear text.
 */
export async function serviceBase(): Promise<string> {
  try {
    const got = await chrome.storage.local.get(SERVICE_OVERRIDE_KEY);
    const value = (got as Record<string, unknown>)[SERVICE_OVERRIDE_KEY];
    return serviceOrigin(value);
  } catch { return SERVICE; }
}

export type BoardPageRoute =
  | 'home' | 'add-source' | 'account' | 'switch-user' | 'sign-out' | 'settings' | 'connections';

/** The full page belongs to the service that owns the learner's board. */
export function boardPageUrlFromOrigin(origin: string, route: BoardPageRoute = 'home'): string {
  const page = new URL('/app/', origin);
  if (route !== 'home') page.hash = route;
  return page.href;
}

export async function boardPageUrl(route: BoardPageRoute = 'home'): Promise<string> {
  return boardPageUrlFromOrigin(await serviceBase(), route);
}

/** The agent must receive proposals from the same Virgil installation whose
 * Settings described the contract. A literal default port can point at a dead
 * service or, worse, another live learner board on the same machine. */
export function agentCapabilityUrl(origin: string): string {
  return new URL('/agent/capabilities', serviceOrigin(origin)).href;
}

/** Pure half of deployment provisioning, kept public so transport safety is executable. */
export function serviceOrigin(value: unknown): string {
  if (typeof value !== 'string') return SERVICE;
  try {
    const parsed = new URL(value);
    const loopback = parsed.protocol === 'http:'
      && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
    const remote = parsed.protocol === 'https:';
    if (!loopback && !remote) return SERVICE;
    if (parsed.username || parsed.password) return SERVICE;
    return parsed.origin;
  } catch { return SERVICE; }
}
