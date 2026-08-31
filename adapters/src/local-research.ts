import {
  htmlToText as structuredHtmlToText,
  type FetchedPage, type Research, type SourceRecord,
} from '@sb/core';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';

type PublicFetch = (url: string, init: RequestInit, address: string) => Promise<Response>;

/**
 * Local outside-world adapter.
 *
 * `hasGrounding` is false here and true at port (Gemini's Google Search
 * grounding). Forager reads that flag and narrows its claims rather than
 * pretending — which is the honest-degradation rule applied to
 * infrastructure rather than content.
 */
export class LocalResearch implements Research {
  readonly hasGrounding = false;

  constructor(
    private readonly userAgent = 'Virgil/0.1 (local build)',
    private readonly language = 'en-GB,en;q=0.9',
    private readonly resolveHost: (hostname: string) => Promise<readonly string[]> =
      async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((row) => row.address),
    private readonly fetchPublic: PublicFetch = pinnedFetch,
  ) {}

  async fetchPage(url: string): Promise<FetchedPage | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      let target = url;
      let r: Response | null = null;
      for (let redirects = 0; redirects <= 5; redirects++) {
        const address = await assertPublicTarget(target, this.resolveHost);
        r = await this.fetchPublic(target, {
          headers: {
            'user-agent': this.userAgent,
            // Vendor documentation sites localise by Accept-Language. Without
            // this, cloud.google.com returned Spanish for an English page the
            // learner had pinned, and the "verbatim" extraction faithfully
            // extracted Spanish. Re-fetch must return the language the learner
            // actually read.
            'accept-language': this.language,
            'accept-encoding': 'identity',
          },
          redirect: 'manual',
          signal: ctrl.signal,
        }, address);
        if (r.status < 300 || r.status >= 400) break;
        const location = r.headers.get('location');
        if (!location || redirects === 5) return null;
        target = new URL(location, target).href;
      }
      if (!r) return null;
      if (!r.ok) return null; // gated or dead — caller falls back
      const html = await boundedText(r, 5 * 1024 * 1024);
      return {
        // Forager deliberately keeps its compact prose and existing evidence
        // contract. Course intake can choose the block-aware sibling instead.
        text: flattenedHtmlToText(html),
        structuredText: structuredHtmlToText(html),
        title: titleOf(html),
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** No grounding locally. Returning empty is honest; inventing sources is not. */
  async findReferences(_query: string, _limit: number): Promise<readonly SourceRecord[]> {
    return [];
  }
}

function publicIp(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && c <= 2)
      || (a === 198 && (b === 18 || b === 19 || b === 51))
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  const normal = address.toLowerCase();
  if (normal.startsWith('::ffff:')) return publicIp(normal.slice(7));
  return normal !== '::' && normal !== '::1'
    && !normal.startsWith('fc') && !normal.startsWith('fd')
    && !/^fe[89ab]/.test(normal) && !normal.startsWith('ff')
    && !normal.startsWith('2001:db8');
}

async function assertPublicTarget(
  value: string, resolveHost: (hostname: string) => Promise<readonly string[]>,
): Promise<string> {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('source URL is not a public HTTP address');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')
      || hostname.endsWith('.local') || hostname.endsWith('.internal')
      || hostname === 'metadata.google.internal') {
    throw new Error('source URL is not a public host');
  }
  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
  if (!addresses.length || addresses.some((address) => !publicIp(address))) {
    throw new Error('source URL resolved outside the public internet');
  }
  return addresses[0]!;
}

/** Connects to the address already validated above, closing DNS-rebinding TOCTOU. */
export function pinnedFetch(value: string, init: RequestInit, address: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = new URL(value);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((content, name) => { headers[name] = content; });
    const lookupPinned: LookupFunction = (_hostname, options, callback): void => {
      const family = isIP(address);
      callback(null, options.all ? [{ address, family }] : address, options.all ? undefined : family);
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: init.method ?? 'GET', headers, lookup: lookupPinned,
      ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > 5 * 1024 * 1024) request.destroy(new Error('source page is too large'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        const responseHeaders = new Headers();
        for (const [name, raw] of Object.entries(response.headers)) {
          for (const item of Array.isArray(raw) ? raw : raw == null ? [] : [raw]) {
            responseHeaders.append(name, String(item));
          }
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 500,
          ...(response.statusMessage ? { statusText: response.statusMessage } : {}),
          headers: responseHeaders,
        }));
      });
    });
    request.once('error', reject);
    if (init.signal?.aborted) request.destroy(init.signal.reason);
    else init.signal?.addEventListener('abort', () => request.destroy(init.signal?.reason), { once: true });
    request.end();
  });
}

async function boundedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw new Error('source page is too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new Error('source page is too large');
    }
    chunks.push(part.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const titleOf = (html: string): string | null =>
  /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;

const flattenedHtmlToText = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
