import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GeminiLlm, GEMINI_TIERS, GEMMA_SCOUT_TIERS } from '../gemini-llm.js';
import { OllamaLlm, LOCAL_TIERS } from '../ollama-llm.js';
import type { LlmRequest } from '@sb/core';

/**
 * WHICH MODEL ANSWERS A REQUEST THAT CARRIES PICTURES.
 *
 * Both adapters forced their vision model on any request with media, whatever
 * tier it asked for. That was harmless for as long as the only thing in the
 * fleet that carried an image was a pinned diagram going to the fast tier
 * anyway , and it stopped being harmless on 2026-08-24, when the Check
 * screen started attaching a learner's coursework as rendered pages.
 *
 * A deep mark quietly answered by the cheap model is the worst kind of wrong:
 * nothing fails, the rows come back, and the judgement behind them is not the
 * one the tier asked for. So the rule is a capability question now rather than
 * a tier one, and the two providers answer it differently on purpose:
 *
 *   provider   tier   media   model                    why
 *   Gemini     fast   no      gemini-3.5-flash-lite    the tier map
 *   Gemini     fast   yes     gemini-3.5-flash-lite    unchanged: it is multimodal
 *   Gemini     deep   no      gemini-3.7-flash         the tier map
 *   Gemini     deep   yes     gemini-3.7-flash         CHANGED: it is multimodal too
 *   Gemini     fast   yes     gemini-3.5-flash-lite    on the Gemma map: gemma is text-only
 *   Ollama     fast   no      gemma4:12b-mlx           the tier map
 *   Ollama     fast   yes     qwen3-vl:8b              gemma4 is a text build
 *   Ollama     deep   no      qwen3.8:27b-mlx          the tier map
 *   Ollama     deep   yes     qwen3-vl:8b              qwen3.8 is a text build
 *
 * The local downgrade is real and it is the honest one available: qwen3-vl is
 * the strongest vision model installed on this machine, and the alternative is
 * a mark on pages the model never saw. It is visible rather than silent —
 * `modelId` in the result is the model that answered, and the ledger reads it.
 *
 * NOTHING HERE REACHES A NETWORK. Both endpoints resolve to nothing.
 */

const encoder = new TextEncoder();

const stream = (text: string): Response => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(encoder.encode(text));
    controller.close();
  },
}));

const PAGE = { kind: 'image' as const, ref: 'data:image/jpeg;base64,iVBORw0KGgo=' };

/** Every model the adapter asked for, in order, whichever way it names one. */
function recording(readModel: (url: string, body: Record<string, unknown>) => string) {
  const models: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const model = readModel(String(url), body);
    models.push(model);
    // Enough of each provider's stream to resolve, and nothing more: which
    // model was asked for is settled before a byte of the reply is read.
    return stream(String(url).includes('stub.invalid')
      ? `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        modelVersion: model,
      })}\r\n\r\n`
      : `${JSON.stringify({ message: { content: 'ok' }, prompt_eval_count: 1, eval_count: 1 })}\n`);
  }) as unknown as typeof globalThis.fetch;
  return { models, close: () => { globalThis.fetch = real; } };
}

const geminiModels = () => recording((url) => /\/models\/([^:]+):/.exec(url)?.[1] ?? '');
const ollamaModels = () => recording((_url, body) => String(body['model'] ?? ''));

const ask = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  tier: 'deep', system: 'be brief', prompt: 'read this', ...over,
});

// ------------------------------------------------------------------ gemini

test('a deep Gemini request that carries pages stays on the deep model', async () => {
  /**
   * The defect this closes. `gemini-3.7-flash` is multimodal, and forcing
   * flash-lite on it because an image arrived was a silent tier downgrade on
   * the one screen whose whole promise is that it tells you what it did.
   */
  const seen = geminiModels();
  try {
    const llm = new GeminiLlm({ endpoint: 'https://stub.invalid/v1beta', apiKey: 'not-a-real-key' });
    const withPages = await llm.complete(ask({ media: [PAGE, PAGE] }));
    assert.deepEqual(seen.models, [GEMINI_TIERS.deep]);
    // And the receipt says which model answered, so the ledger and the screen
    // can both be right about it.
    assert.equal(withPages.modelId, GEMINI_TIERS.deep);
  } finally { seen.close(); }
});

test('the fast tier and the pin triage behave exactly as they did', async () => {
  //  path is unchanged in both directions: the fast model IS the
  // multimodal one, so nothing about a pinned diagram moves.
  const seen = geminiModels();
  try {
    const llm = new GeminiLlm({ endpoint: 'https://stub.invalid/v1beta', apiKey: 'not-a-real-key' });
    await llm.complete(ask({ tier: 'fast' }));
    await llm.complete(ask({ tier: 'fast', media: [PAGE] }));
    await llm.complete(ask({ tier: 'deep' }));
    assert.deepEqual(seen.models, [GEMINI_TIERS.fast, GEMINI_TIERS.fast, GEMINI_TIERS.deep]);
  } finally { seen.close(); }
});

test('a text-only model in the tier map still hands its pictures to the vision model', async () => {
  /**
   * The Gemma map, which is what "Scout onto Gemma" points the fast tier at.
   * `ListModels` offers no capability flag and nothing in this repository has
   * probed either Gemma id with an image. Guessing "yes" on an unprobed model
   * buys a 400 on a live mark; guessing "no" costs a downgrade the learner can
   * see in `modelId`. That asymmetry is why the unknown case falls to the
   * vision model rather than through it.
   */
  const seen = geminiModels();
  try {
    const llm = new GeminiLlm({
      endpoint: 'https://stub.invalid/v1beta', apiKey: 'not-a-real-key', tiers: GEMMA_SCOUT_TIERS,
    });
    await llm.complete(ask({ tier: 'fast', media: [PAGE] }));
    await llm.complete(ask({ tier: 'fast' }));
    // The Gemma map leaves `deep` where GEMINI_TIERS put it, so pages on the
    // deep tier stay on the deep model there too.
    await llm.complete(ask({ tier: 'deep', media: [PAGE] }));
    assert.deepEqual(seen.models, [
      GEMINI_TIERS.fast, GEMMA_SCOUT_TIERS.fast, GEMINI_TIERS.deep,
    ]);
  } finally { seen.close(); }
});

// ------------------------------------------------------------------ ollama

test('neither local tier model can see, so pages go to the installed vision model', async () => {
  /**
   * The other half of the same rule, reaching the opposite answer.
   * `gemma4:12b-mlx` and `qwen3.8:27b-mlx` are the text builds pulled on this
   * machine; handing either an `images` array gets the images ignored rather
   * than an error, which is the failure worth caring about because the reply
   * comes back looking fine and is a verdict on nothing.
   */
  const seen = ollamaModels();
  try {
    const llm = new OllamaLlm({ host: 'http://127.0.0.1:1' });
    await llm.complete(ask({ tier: 'fast', media: [PAGE] }));
    await llm.complete(ask({ tier: 'deep', media: [PAGE] }));
    assert.deepEqual(seen.models, ['qwen3-vl:8b', 'qwen3-vl:8b']);
  } finally { seen.close(); }
});

test('a local request with no pages is untouched by any of this', async () => {
  const seen = ollamaModels();
  try {
    const llm = new OllamaLlm({ host: 'http://127.0.0.1:1' });
    await llm.complete(ask({ tier: 'fast' }));
    await llm.complete(ask({ tier: 'deep' }));
    assert.deepEqual(seen.models, [LOCAL_TIERS.fast, LOCAL_TIERS.deep]);
  } finally { seen.close(); }
});

test('an operator who points a tier at a vision build gets their tier honoured', async () => {
  // Matched by name rather than listed, so a model pulled tomorrow does not
  // inherit a hardcoded exception written before it existed. This is the one
  // assertion here that is about the future rather than about this machine.
  const seen = ollamaModels();
  try {
    const llm = new OllamaLlm({
      host: 'http://127.0.0.1:1',
      tiers: { fast: 'qwen3-vl:8b', deep: 'llama4-vision:70b' },
    });
    await llm.complete(ask({ tier: 'deep', media: [PAGE] }));
    await llm.complete(ask({ tier: 'fast', media: [PAGE] }));
    assert.deepEqual(seen.models, ['llama4-vision:70b', 'qwen3-vl:8b'],
      'a vision model in the tier map was overridden by the vision model');
  } finally { seen.close(); }
});

test('the model that answered is what comes back, whichever way the choice went', async () => {
  // The downgrade is honest only if it is visible. `modelId` is the field the
  // usage ledger records and the receipt reads.
  const seen = ollamaModels();
  try {
    const llm = new OllamaLlm({ host: 'http://127.0.0.1:1' });
    const withPages = await llm.complete(ask({ tier: 'deep', media: [PAGE] }));
    const without = await llm.complete(ask({ tier: 'deep' }));
    assert.equal(withPages.modelId, 'qwen3-vl:8b');
    assert.equal(without.modelId, LOCAL_TIERS.deep);
  } finally { seen.close(); }
});
