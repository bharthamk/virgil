import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BoardWebOptions {
  readonly root: string;
  readonly authConfig: {
    readonly apiKey: string;
    readonly projectId: string;
    readonly emulatorHost?: string;
  } | null;
  /** Web OAuth client for the service origin, not the Chrome-app client. */
  readonly googleWebClientId: string | null;
  /** Public capability bit only. The password/hash never leaves the service. */
  readonly judgeDemoEnabled?: boolean;
}

export const BOARD_WEB_ROOT = fileURLToPath(new URL('../../extension/', import.meta.url));

const boardMime = (path: string): string => {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.ttf')) return 'font/ttf';
  if (path.endsWith('.pfb')) return 'application/octet-stream';
  return 'application/octet-stream';
};

/** Public furniture only; every data route remains behind service identity. */
export function serveBoardWeb(
  req: IncomingMessage, res: ServerResponse, web: BoardWebOptions,
  allowedOrigin: (origin: string | undefined) => string | null,
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/' || path === '/app') {
    res.writeHead(path === '/' ? 302 : 308, { location: '/app/', 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  if (!path.startsWith('/app/')) return false;
  if (path === '/app/config.js' || path === '/app/config.json') {
    const publicConfig = JSON.stringify({
      authConfig: web.authConfig,
      googleWebClientId: web.googleWebClientId,
      judgeDemoEnabled: web.judgeDemoEnabled === true,
    }).replaceAll('<', '\\u003c');
    const origin = allowedOrigin(req.headers.origin);
    if (path === '/app/config.json') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', vary: 'origin',
        ...(origin === null ? {} : { 'access-control-allow-origin': origin }),
      });
      res.end(req.method === 'HEAD' ? undefined : publicConfig);
      return true;
    }
    const body = `globalThis.__VIRGIL_WEB_CONFIG__ = ${publicConfig};\n`;
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  let relative = 'web.html';
  if (path !== '/app/') {
    try { relative = decodeURIComponent(path.slice('/app/'.length)); }
    catch { return notFound(res); }
  }
  const allowed = relative === 'web.html' || relative === 'panel.css' || relative === 'web-runtime.js'
    || (/^(?:dist|assets|vendor)\/[A-Za-z0-9._/-]+$/.test(relative) && !relative.includes('__tests__'));
  if (!allowed || relative.split('/').includes('..')) return notFound(res);
  const root = resolve(web.root);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return notFound(res);
  try {
    const body = readFileSync(target);
    res.writeHead(200, {
      'content-type': boardMime(target),
      'cache-control': relative === 'web.html' ? 'no-store' : 'no-cache',
      'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
      'origin-agent-cluster': '?1', 'referrer-policy': 'same-origin',
      'permissions-policy': 'tools=(self), camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'content-security-policy': [
        "default-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'",
        "form-action 'none'", "script-src 'self' https://accounts.google.com", "style-src 'self'",
        "img-src 'self' data: blob: https://*.googleusercontent.com", "font-src 'self' data:",
        "connect-src 'self' https://accounts.google.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com",
        'frame-src https://accounts.google.com', "worker-src 'self' blob:",
      ].join('; '),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { return notFound(res); }
  return true;
}

const notFound = (res: ServerResponse): true => {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
  return true;
};
