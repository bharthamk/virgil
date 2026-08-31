import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TfIdfEmbedder } from '../tfidf-embedder.js';
import { OllamaEmbedder } from '../ollama-embedder.js';
import {
  runEmbedderContract, runEmbedderFailureContract,
  type EmbedderSession, type EmbedderSubject, type FaultyEmbedderSubject,
} from './embedder-contract.js';

/**
 * Both shipped embedders, bound to the `Embedder` contract.
 *
 * The pair is the point. `TfIdfEmbedder` is the honest-degradation path — no
 * model, no dependency, no network — and `OllamaEmbedder` is a real HTTP
 * adapter with chunking, a deadline and a provider that can lie about how many
 * vectors it is returning. One contract has to hold for both, or it is a
 * description of whichever one it was written against.
 *
 * The HTTP boundary is stubbed. No test in this repo may call a model.
 */

// ------------------------------------------------------- the in-process subject

const tfidf: EmbedderSubject = {
  name: 'TfIdfEmbedder',
  // Declared, and the contract checks the declaration: IDF is fitted to the
  // batch, so a text's numbers depend on its company. Correct here because the
  // clusterer embeds the whole board in one call.
  scope: 'per-batch',
  open: (): EmbedderSession => ({
    embedder: new TfIdfEmbedder(),
    fresh: () => new TfIdfEmbedder(),
    close: () => {},
  }),
};

// ------------------------------------------------------------- the HTTP subject

/**
 * A stand-in for an embedding model: deterministic, dense, unit length, and a
 * pure function of the text.
 *
 * Being a pure function is what makes the subject `per-text` and what makes the
 * determinism assertions test the ADAPTER rather than the fake — any drift the
 * contract sees from here can only have come from chunking, ordering or state
 * held on the adapter, which is exactly the class of bug this seam can hide.
 */
const DIMS = 64;
function modelVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
    v[i % DIMS] = (v[i % DIMS] as number) + (((h >>> 8) & 0xff) / 255 - 0.5);
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  if (norm === 0) return v;
  const len = Math.sqrt(norm);
  return v.map((x) => x / len);
}

interface EmbedBody { model: string; input: string[] }

type Reply = (input: readonly string[]) => Response;

/** Swaps `fetch` for one that answers `/api/embed` however the test needs. */
function stubbed(reply: Reply): EmbedderSession {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as EmbedBody;
    assert.ok(Array.isArray(body.input), 'the adapter sent no input array');
    assert.ok(init.signal instanceof AbortSignal,
      'D19: a call with no deadline of its own inherits whatever the runtime feels like');
    return reply(body.input);
  }) as unknown as typeof globalThis.fetch;
  const build = () => new OllamaEmbedder({ host: 'http://stub.invalid' });
  return { embedder: build(), fresh: build, close: () => { globalThis.fetch = real; } };
}

const ok = (vectors: number[][]): Response =>
  new Response(JSON.stringify({ embeddings: vectors }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

const ollama: EmbedderSubject = {
  name: 'OllamaEmbedder',
  scope: 'per-text',
  open: () => stubbed((input) => ok(input.map(modelVector))),
};

const faulty: FaultyEmbedderSubject = {
  name: 'OllamaEmbedder',
  openHttpError: (status) => stubbed(() => new Response('upstream is down', { status })),
  // One vector short: the shape a provider drops a row in, and the shape that
  // would otherwise zip every later vector onto the wrong pin.
  openShortReply: () => stubbed((input) => ok(input.slice(1).map(modelVector))),
  openMalformed: () => stubbed(() => new Response(JSON.stringify({ data: [] }), { status: 200 })),
};

runEmbedderContract(tfidf);
runEmbedderContract(ollama);
runEmbedderFailureContract(faulty);

// ------------------------------------------------ what the contract cannot say

test('[OllamaEmbedder] the batch size is fixed rather than following the board', async () => {
  // Stated on `OllamaEmbedderOptions` as the one thing that could make the same
  // text embed differently on different runs. The contract cannot see it — it is
  // invisible above the seam by design — so it is checked here, where the wire
  // is visible: the same 40 texts must be chunked identically however they
  // arrive, and a chunk must never be the whole board.
  const seen: number[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as EmbedBody;
    seen.push(body.input.length);
    return ok(body.input.map(modelVector));
  }) as unknown as typeof globalThis.fetch;
  try {
    const texts = Array.from({ length: 40 }, (_, i) => `pin ${i}`);
    await new OllamaEmbedder({ host: 'http://stub.invalid' }).embed(texts);
    assert.deepEqual(seen, [16, 16, 8], 'the chunking followed the board rather than the option');
  } finally {
    globalThis.fetch = real;
  }
});
