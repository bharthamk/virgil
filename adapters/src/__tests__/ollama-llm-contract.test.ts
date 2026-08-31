import { OllamaLlm } from '../ollama-llm.js';
import {
  runLlmContract, runLlmMediaContract,
  type LlmSession, type LlmSubject, type SeamCall, type TransportOutcome,
} from './llm-contract.js';

/**
 * The local adapter, bound to the `Llm` contract.
 *
 * The binding is the only Ollama-shaped code here: it knows that the request is
 * a `/api/chat` body, that the schema travels inside the user message, that
 * `think` is the reasoning flag and that the reply is NDJSON. Everything being
 * asserted lives in `llm-contract.ts` and knows none of that.
 *
 * A second adapter costs exactly this file again. That is the claim
 * The provider-seam contract, made checkable.
 *
 * The HTTP boundary is stubbed, not reached. No test in this repo may call a
 * model.
 */

interface ChatBody {
  model: string;
  think: boolean;
  format?: 'json' | Record<string, unknown>;
  options: { num_predict: number };
  messages: { role: string; content: string; images?: string[] }[];
}

const encoder = new TextEncoder();

/** One Ollama NDJSON reply, optionally delivered one byte at a time. */
function ndjson(out: Extract<TransportOutcome, { kind: 'text' }>): Response {
  const line = `${JSON.stringify({
    message: { content: out.text },
    prompt_eval_count: out.inputTokens ?? 0,
    eval_count: out.outputTokens ?? 0,
  })}\n`;
  const bytes = encoder.encode(line);
  // One byte per chunk guarantees every multi-byte character is split across a
  // chunk boundary, which is the only way to prove the decoder carries state.
  const chunks = out.splitBytes ? Array.from(bytes, (b) => Uint8Array.of(b)) : [bytes];
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  }), { status: 200 });
}

const subject: LlmSubject = {
  name: 'OllamaLlm',
  open(serve): LlmSession {
    const calls: SeamCall[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as ChatBody;
      const user = body.messages.find((m) => m.role === 'user');
      const decoded: SeamCall = {
        model: body.model,
        system: body.messages.find((m) => m.role === 'system')?.content ?? '',
        prompt: user?.content ?? '',
        jsonMode: body.format === 'json' || typeof body.format === 'object',
        schemaOnWire: typeof body.format === 'object' ? body.format : null,
        thinking: body.think,
        maxOutputTokens: body.options.num_predict,
        images: user?.images ?? [],
        hasAbortSignal: init.signal instanceof AbortSignal,
      };
      calls.push(decoded);

      const outcome = serve(decoded);
      switch (outcome.kind) {
        case 'text': return ndjson(outcome);
        case 'http': return new Response(outcome.body ?? '', { status: outcome.status });
        case 'network': throw new TypeError(`fetch failed: ${outcome.message}`);
        case 'abort': throw new DOMException('This operation was aborted', 'AbortError');
      }
    }) as unknown as typeof globalThis.fetch;

    return {
      // A short host is irrelevant — nothing resolves it. The default tier map
      // is deliberately left in place so the contract checks the real one.
      llm: new OllamaLlm({ host: 'http://stub.invalid' }),
      calls,
      close: () => { globalThis.fetch = real; },
    };
  },
};

runLlmContract(subject);
runLlmMediaContract(subject);
