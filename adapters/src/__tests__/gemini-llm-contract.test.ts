import { GeminiLlm } from '../gemini-llm.js';
import {
  runLlmContract, runLlmMediaContract,
  type LlmSession, type LlmSubject, type SeamCall, type TransportOutcome,
} from './llm-contract.js';


interface GeminiBody {
  systemInstruction: { parts: { text: string }[] };
  contents: { role: string; parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] }[];
  generationConfig: {
    maxOutputTokens: number;
    thinkingConfig?: { thinkingBudget?: number; thinkingLevel?: string };
    responseMimeType?: string;
    responseSchema?: unknown;
  };
}

const encoder = new TextEncoder();

/**
 * One `alt=sse` stream, framed the way the live service frames it.
 *
 * Transcribed from a recorded `gemini-3.5-flash-lite` response. The details that
 * are not decoration:
 *
 *  - `\r\n\r\n` between events, not `\n\n`. A line splitter that forgets the CR
 *    leaves it on the end of every payload.
 *  - `data: ` with a space.
 *  - No `[DONE]`. The stream just stops.
 *  - A second, final event whose only part carries a `thoughtSignature` and an
 *    EMPTY text field. Anything that appends `part.text` without a default puts
 *    the string "undefined" into a learner's section.
 *  - `thoughtsTokenCount` beside `candidatesTokenCount` — 75 thought tokens
 *    against 5 candidate tokens on the recorded call.
 *  - `modelVersion` on every event.
 */
function sse(out: Extract<TransportOutcome, { kind: 'text' }>, model: string): Response {
  const usage = {
    promptTokenCount: out.inputTokens ?? 0,
    candidatesTokenCount: out.outputTokens ?? 0,
    totalTokenCount: (out.inputTokens ?? 0) + (out.outputTokens ?? 0),
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: out.inputTokens ?? 0 }],
    serviceTier: 'standard',
  };
  const responseId = 'recorded-shape-not-a-live-response';
  const events = [
    {
      candidates: [{ content: { parts: [{ text: out.text }], role: 'model' }, index: 0 }],
      usageMetadata: usage,
      modelVersion: model,
      responseId,
    },
    {
      candidates: [{
        content: { parts: [{ text: '', thoughtSignature: 'EqUDCqIDARFNMg8u9Gyole' }], role: 'model' },
        finishReason: 'STOP',
        index: 0,
      }],
      usageMetadata: usage,
      modelVersion: model,
      responseId,
    },
  ];
  const bytes = encoder.encode(events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''));
  const chunks = out.splitBytes ? Array.from(bytes, (b) => Uint8Array.of(b)) : [bytes];
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * The error envelope, recorded. Two things here are load-bearing and neither was
 * in the invented version:
 *
 *  1. `content-type: text/event-stream` on a body that is NOT an SSE stream. The
 *     service does not switch content types for errors. An adapter that decides
 *     how to read a response from its content type reads no `data:` lines, finds
 *     nothing, and resolves a 429 as the empty string.
 *  2. `details[].reason` — the only place that distinguishes a bad key from a
 *     bad request, both of which arrive as 400 INVALID_ARGUMENT.
 */
const errorBody = (status: number): string => JSON.stringify({
  error: {
    code: status,
    message: status === 429
      ? 'You exceeded your current quota, please check your plan and billing details.'
      : 'recorded shape, not a live response',
    status: status === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE',
    details: status === 429
      ? [{
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }],
      }]
      : [],
  },
});

/**
 * `responseSchema` back to JSON Schema — the inverse of the adapter's
 * translation, written independently so that agreement means something.
 *
 * `{"type":"string","nullable":true}` came from `{"type":["string","null"]}` and
 * has to be read back that way, or `schemaReached` in the contract compares a
 * translated schema against the original and fails an adapter that did the right
 * thing.
 */
function fromGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(fromGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;

  const node = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'nullable') continue;
    if (key === 'type' && node.nullable === true) {
      out.type = [value as string, 'null'];
      continue;
    }
    if (key === 'properties' && value && typeof value === 'object') {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        props[name] = fromGeminiSchema(sub);
      }
      out.properties = props;
      continue;
    }
    if (key === 'items') {
      out.items = fromGeminiSchema(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

const subject: LlmSubject = {
  name: 'GeminiLlm',
  open(serve): LlmSession {
    const calls: SeamCall[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as GeminiBody;
      const parts = body.contents[0]?.parts ?? [];
      const decoded: SeamCall = {
        // The model is in the path here rather than in the body, which is
        // exactly the kind of difference the neutral shape exists to absorb.
        model: /\/models\/([^:]+):/.exec(String(url))?.[1] ?? '',
        system: body.systemInstruction.parts.map((p) => p.text).join(''),
        prompt: parts.map((p) => p.text ?? '').join(''),
        jsonMode: body.generationConfig.responseMimeType === 'application/json',
        schemaOnWire: body.generationConfig.responseSchema === undefined
          ? null
          : fromGeminiSchema(body.generationConfig.responseSchema),
        // Reasoning ON sends no thinkingConfig at all — the provider's own
        // dynamic default. Its PRESENCE is the request to stop thinking, because
        // the two models in the tier map spell that request differently and each
        // one's spelling is a 400 on the other.
        thinking: body.generationConfig.thinkingConfig === undefined,
        maxOutputTokens: body.generationConfig.maxOutputTokens,
        images: parts.flatMap((p) => (p.inlineData ? [p.inlineData.data] : [])),
        hasAbortSignal: init.signal instanceof AbortSignal,
      };
      calls.push(decoded);

      const outcome = serve(decoded);
      switch (outcome.kind) {
        case 'text': return sse(outcome, decoded.model);
        case 'http': return new Response(outcome.body ?? errorBody(outcome.status), {
          status: outcome.status,
          // As recorded: the streaming content type, on a body that is not a stream.
          headers: { 'content-type': 'text/event-stream' },
        });
        case 'network': throw new TypeError(`fetch failed: ${outcome.message}`);
        case 'abort': throw new DOMException('This operation was aborted', 'AbortError');
      }
    }) as unknown as typeof globalThis.fetch;

    return {
      // An endpoint that resolves to nothing, and a key that is a literal rather
      // than anything read from the environment — this file must behave the same
      // on a machine that has a real key as on one that does not.
      llm: new GeminiLlm({ endpoint: 'https://stub.invalid/v1beta', apiKey: 'not-a-real-key' }),
      calls,
      close: () => { globalThis.fetch = real; },
    };
  },
};

runLlmContract(subject);
runLlmMediaContract(subject);
