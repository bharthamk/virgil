import { LocalResearch, pinnedFetch } from '../local-research.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  runResearchContract,
  type FetchCall, type ResearchSession, type ResearchSubject,
} from './research-contract.js';

/**
 * The local outside-world adapter, bound to the `Research` contract.
 *
 * The binding is the only HTTP-shaped code here: it knows that the adapter
 * reaches the world through `fetch`, that its controls travel as headers and
 * that its deadline travels as a signal. A grounded provider — Gemini's Google
 * Search grounding, at port — would decode a very different request into the
 * same `FetchCall` and inherit every assertion.
 *
 * The network is stubbed, not reached.
 */

/**
 * The stub parses the URL the way the platform does.
 *
 * This is not decoration. `fetchPage` is handed a URL out of a capture envelope,
 * which is untrusted input, and `javascript:` or a malformed string reaching the
 * real `fetch` is a `TypeError` that the adapter's own `catch` turns into the
 *  fallback. A stub that answered anything to any string would let an
 * adapter that "helpfully" repaired a bad URL — prefixing a scheme, resolving it
 * against a base — pass a test the real runtime would fail.
 */
const parseable = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
};

const subject: ResearchSubject = {
  name: 'LocalResearch',
  open(serve): ResearchSession {
    const calls: FetchCall[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      const target = String(url);
      if (!parseable(target)) throw new TypeError(`Failed to parse URL from ${target}`);
      const decoded: FetchCall = {
        url: target,
        headers: Object.fromEntries(
          Object.entries((init.headers ?? {}) as Record<string, string>)
            .map(([k, v]) => [k.toLowerCase(), String(v)])),
        hasAbortSignal: init.signal instanceof AbortSignal,
      };
      calls.push(decoded);

      const outcome = serve(decoded);
      switch (outcome.kind) {
        case 'page':
          return new Response(outcome.html, {
            status: outcome.status ?? 200,
            headers: { 'content-type': outcome.contentType ?? 'text/html; charset=utf-8' },
          });
        case 'http': return new Response(outcome.body ?? '', { status: outcome.status });
        case 'network': throw new TypeError(`fetch failed: ${outcome.message}`);
        case 'abort': throw new DOMException('This operation was aborted', 'AbortError');
      }
    }) as unknown as typeof globalThis.fetch;

    return {
      research: new LocalResearch(
        'Virgil/0.1 (local build)', 'en-GB,en;q=0.9', async () => ['93.184.216.34'],
        async (url, init) => fetch(url, init),
      ),
      calls,
      close: () => { globalThis.fetch = real; },
    };
  },
};

runResearchContract(subject);

test('[LocalResearch] private and local URL forms are refused before any socket opens', async () => {
  let sockets = 0;
  const research = new LocalResearch('Virgil/test', 'en',
    async () => ['93.184.216.34'], async () => {
      sockets += 1;
      return new Response('<p>never</p>');
    });
  for (const url of [
    'http://localhost/admin', 'http://service.local/data',
    'http://127.0.0.1/', 'http://2130706433/', 'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'https://user:secret@example.com/private', 'file:///etc/passwd',
  ]) assert.equal(await research.fetchPage(url), null, url);
  assert.equal(sockets, 0);
});

test('[LocalResearch] one private DNS answer poisons the whole hostname', async () => {
  let sockets = 0;
  const research = new LocalResearch('Virgil/test', 'en',
    async () => ['93.184.216.34', '10.0.0.7'], async () => {
      sockets += 1;
      return new Response('<p>never</p>');
    });
  assert.equal(await research.fetchPage('https://mixed.example.test/page'), null);
  assert.equal(sockets, 0);
});

test('[LocalResearch] redirects are re-resolved and cannot pivot into a private network', async () => {
  const sockets: string[] = [];
  const research = new LocalResearch('Virgil/test', 'en',
    async (hostname) => hostname === 'public.example.test' ? ['93.184.216.34'] : ['127.0.0.1'],
    async (url) => {
      sockets.push(url);
      return new Response('', {
        status: 302, headers: { location: 'http://internal.example.test/secrets' },
      });
    });
  assert.equal(await research.fetchPage('https://public.example.test/start'), null);
  assert.deepEqual(sockets, ['https://public.example.test/start']);
});

test('[LocalResearch] the pinned transport connects to the validated address', async (t) => {
  const server = createServer((request, response) => {
    assert.equal(request.headers.host?.startsWith('public.example.test:'), true);
    response.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'x-receipt': ['first', 'second'],
    });
    response.end('transport reached the pinned address');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const { port } = server.address() as AddressInfo;

  const response = await pinnedFetch(
    `http://public.example.test:${port}/source`,
    { headers: { 'user-agent': 'Virgil/test' } },
    '127.0.0.1',
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-receipt'), 'first, second');
  assert.equal(await response.text(), 'transport reached the pinned address');
});
