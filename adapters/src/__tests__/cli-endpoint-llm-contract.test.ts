import { CliEndpointLlm } from '../cli-endpoint-llm.js';
import {
  runLlmContract, runLlmMediaContract,
  type LlmSession, type LlmSubject, type SeamCall,
} from './llm-contract.js';

interface Body {
  model: string; structured: boolean; reasoning: 'on' | 'off'; system: string; prompt: string;
  media: { kind: 'image'; ref: string }[]; schema?: unknown; maxOutputTokens: number;
}

const subject: LlmSubject = {
  name: 'CliEndpointLlm',
  open(serve): LlmSession {
    const calls: SeamCall[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Body;
      const call: SeamCall = {
        model: body.model, system: body.system, prompt: body.prompt,
        jsonMode: body.structured, schemaOnWire: body.schema ?? null,
        thinking: body.reasoning === 'on', maxOutputTokens: body.maxOutputTokens,
        images: body.media.map((item) => item.ref.replace(/^data:[^;]+;base64,/, '')),
        hasAbortSignal: init.signal instanceof AbortSignal,
      };
      calls.push(call);
      const outcome = serve(call);
      switch (outcome.kind) {
        case 'text': return new Response(JSON.stringify({
          value: outcome.text, modelId: body.model,
          inputTokens: outcome.inputTokens ?? 0, outputTokens: outcome.outputTokens ?? 0,
        }));
        case 'http': return new Response(outcome.body ?? '', { status: outcome.status });
        case 'network': throw new TypeError(`fetch failed: ${outcome.message}`);
        case 'abort': throw new DOMException('This operation was aborted', 'AbortError');
      }
    }) as typeof globalThis.fetch;
    return {
      llm: new CliEndpointLlm({ endpoint: 'http://127.0.0.1:8798', token: 'test-token' }),
      calls,
      close: () => { globalThis.fetch = real; },
    };
  },
};

runLlmContract(subject);
runLlmMediaContract(subject);
