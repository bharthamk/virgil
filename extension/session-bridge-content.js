/**
 * Keep the hosted Virgil page and its extension panel signed in as one browser.
 *
 * The page owns an HTTP(S)-origin localStorage and the extension owns
 * chrome.storage. They cannot read each other directly. The hosted runtime
 * therefore publishes its already-validated Firebase session through the
 * shared window; this isolated content script accepts it only on the exact
 * service origin this installation is configured to use, validates every
 * field again, and writes only the public auth config plus the session token.
 *
 * Any script running on that trusted app origin can already read the page's
 * localStorage token. Pages on every other origin are ignored, including a
 * page that merely copies the message shape.
 */
void (() => {
  const SOURCE = 'virgil-hosted-session-v1';
  const EXPERIMENT_SOURCE = 'virgil-hosted-experiment-v1';
  const EXPERIMENT_REPLY = 'virgil-extension-experiment-v1';
  const EXPERIMENT_KEY = 'sb_experimental_whole_page';
  const EXPERIMENT_CHANGED = 'sb-experimental-capture-changed';
  const SERVICE_KEY = 'sb_service_url';
  const AUTH_KEY = 'sb_auth_config';
  const SESSION_KEY = 'sb_session';
  const DEFAULT_SERVICE = 'http://127.0.0.1:8791';

  const serviceOrigin = (value) => {
    if (typeof value !== 'string') return DEFAULT_SERVICE;
    try {
      const parsed = new URL(value);
      const loopback = parsed.protocol === 'http:'
        && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
      const remote = parsed.protocol === 'https:';
      if ((!loopback && !remote) || parsed.username || parsed.password) return DEFAULT_SERVICE;
      return parsed.origin;
    } catch { return DEFAULT_SERVICE; }
  };

  const authConfig = (value) => value && typeof value === 'object'
    && typeof value.apiKey === 'string' && value.apiKey !== ''
    && typeof value.projectId === 'string' && value.projectId !== ''
    && (value.emulatorHost == null || typeof value.emulatorHost === 'string');

  const session = (value) => value && typeof value === 'object'
    && typeof value.idToken === 'string' && value.idToken !== ''
    && typeof value.refreshToken === 'string'
    && Number.isFinite(value.expiresAt)
    && typeof value.uid === 'string' && value.uid !== ''
    && (value.email === null || typeof value.email === 'string');

  const receive = async (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (!event.data || (event.data.source !== SOURCE && event.data.source !== EXPERIMENT_SOURCE)) return;
    const stored = await chrome.storage.local.get(SERVICE_KEY);
    if (serviceOrigin(stored[SERVICE_KEY]) !== location.origin) return;
    if (location.pathname !== '/app' && !location.pathname.startsWith('/app/')) return;
    if (event.data.source === EXPERIMENT_SOURCE) {
      const requestId = typeof event.data.requestId === 'string' ? event.data.requestId : '';
      if (!requestId || (event.data.kind !== 'read' && event.data.kind !== 'write')) return;
      if (event.data.kind === 'write') {
        if (typeof event.data.enabled !== 'boolean') return;
        const before = await chrome.storage.local.get(EXPERIMENT_KEY);
        const previous = before[EXPERIMENT_KEY] === true;
        await chrome.storage.local.set({ [EXPERIMENT_KEY]: event.data.enabled });
        const reply = await chrome.runtime.sendMessage({ kind: EXPERIMENT_CHANGED }).catch(() => null);
        if (!reply || reply.ok !== true) {
          await chrome.storage.local.set({ [EXPERIMENT_KEY]: previous }).catch(() => {});
          window.postMessage({
            source: EXPERIMENT_REPLY, requestId, ok: false, enabled: previous,
          }, location.origin);
          return;
        }
      }
      const current = await chrome.storage.local.get(EXPERIMENT_KEY);
      window.postMessage({
        source: EXPERIMENT_REPLY, requestId, ok: true,
        enabled: current[EXPERIMENT_KEY] === true,
      }, location.origin);
      return;
    }
    if (!authConfig(event.data.authConfig)) return;
    if (event.data.session !== null && !session(event.data.session)) return;
    await chrome.storage.local.set({
      [AUTH_KEY]: event.data.authConfig,
      [SESSION_KEY]: event.data.session,
    });
  };

  window.addEventListener('message', (event) => { void receive(event); });
})();
