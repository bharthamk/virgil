import { OllamaLlm } from '../adapters/dist/index.js';
const llm = new OllamaLlm();
const t0 = Date.now();
const fast = await llm.structured({
  tier: 'fast',
  system: 'You label learning material. Answer only with JSON.',
  prompt: 'Passage: "Pub/Sub subscriptions can be pull or push. Push delivers to an endpoint you own; pull has your client request messages."\nGive a short topic label (2-4 words).',
  schema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
});
console.log(`fast  ${fast.modelId}  ${Date.now() - t0}ms  ->`, JSON.stringify(fast.value));
const t1 = Date.now();
const deep = await llm.complete({
  tier: 'deep',
  system: 'You are a teacher. Be concise.',
  prompt: 'In two sentences, explain a Pub/Sub ordering key to someone already fluent with Pub/Sub basics.',
  maxOutputTokens: 200,
});
console.log(`deep  ${deep.modelId}  ${Date.now() - t1}ms  ${deep.outputTokens}tok`);
console.log(deep.value.trim().slice(0, 300));
