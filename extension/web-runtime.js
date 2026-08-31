/**
 * The small browser boundary for Virgil's service-hosted page.
 *
 * The full page and the extension panel deliberately share one UI module.
 * `panel.ts` needs only storage, identity and opening a URL from Chrome; this
 * file supplies those same capabilities on the user's own HTTPS deployment.
 * It owns no board data and no credential. The Firebase and OAuth values are
 * public, deployment-owned configuration served by `/app/config.js`.
 */
(() => {
  const config = globalThis.__VIRGIL_WEB_CONFIG__ ?? {};
  const sessionBridgeSource = 'virgil-hosted-session-v1';
  const storageKey = 'virgil-web-storage';
  const stored = (() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); }
    catch { return {}; }
  })();
  // Deployment-owned boundaries win over anything left by an older revision
  // in this browser. Only the learner's session and preferences persist.
  const values = Object.assign(Object.create(null), stored, {
    sb_service_url: location.origin,
    ...(config.authConfig ? { sb_auth_config: config.authConfig } : {}),
  });
  const listeners = new Set();
  const persist = () => localStorage.setItem(storageKey, JSON.stringify(values));
  const publishSession = () => window.postMessage({
    source: sessionBridgeSource,
    authConfig: values.sb_auth_config ?? null,
    session: values.sb_session ?? null,
  }, location.origin);
  const changed = (next) => {
    const change = {};
    for (const [key, value] of Object.entries(next)) {
      change[key] = { oldValue: values[key], newValue: value };
      values[key] = value;
    }
    persist();
    for (const listener of listeners) listener(change, 'local');
    publishSession();
  };

  const loadGoogle = async () => {
    if (globalThis.google?.accounts?.oauth2) return;
    await new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-virgil-google]');
      if (existing) {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', reject, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.dataset.virgilGoogle = 'true';
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
  };

  const googleToken = async ({ scopes = [] } = {}) => {
    if (config.authConfig?.emulatorHost) {
      // The Auth emulator accepts an unsigned Google-shaped ID token. This is
      // local proof only; no real Google identity or credential is touched.
      return { token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJxYS1nb29nbGUtdXNlciIsImVtYWlsIjoicWEtdXNlckBleGFtcGxlLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJhdWQiOiJxYS1jbGllbnQifQ.' };
    }
    const webClientId = config.googleWebClientId ?? config.googleClientId;
    if (!webClientId) throw new Error('Google sign-in is not provisioned for this Virgil deployment.');
    await loadGoogle();
    return await new Promise((resolve, reject) => {
      const client = globalThis.google.accounts.oauth2.initTokenClient({
        client_id: webClientId,
        scope: scopes.join(' '),
        callback: (reply) => reply?.access_token
          ? resolve({ token: reply.access_token })
          : reject(new Error(reply?.error ?? 'Google sign-in did not finish.')),
        error_callback: (error) => reject(new Error(error?.type ?? 'Google sign-in did not finish.')),
      });
      client.requestAccessToken({ prompt: 'select_account' });
    });
  };

  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === 'string') return { [keys]: values[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, values[key]]));
          return { ...(keys ?? {}), ...values };
        },
        async set(next) { changed(next); },
        async remove(keys) {
          const change = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            change[key] = { oldValue: values[key], newValue: undefined };
            delete values[key];
          }
          persist();
          for (const listener of listeners) listener(change, 'local');
        },
      },
      onChanged: {
        addListener(listener) { listeners.add(listener); },
        removeListener(listener) { listeners.delete(listener); },
      },
    },
    runtime: {
      id: '',
      getURL(path) { return new URL(path, location.href).href; },
      async sendMessage() {},
    },
    identity: { getAuthToken: googleToken },
    tabs: {
      async create({ url }) {
        const opened = globalThis.open(url, '_blank', 'noopener');
        if (!opened) location.href = url;
      },
    },
  };
  // Covers a page that was already signed in before this load. Later sign-in,
  // refresh and sign-out writes publish again through `changed` above.
  publishSession();
})();
