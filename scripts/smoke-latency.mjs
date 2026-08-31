import { OllamaLlm } from '../adapters/dist/index.js';
const llm = new OllamaLlm();
const schema = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] };
const passages = [
  'Pub/Sub subscriptions can be pull or push. Push delivers to an endpoint you own.',
  'IAM condition expressions let you grant access only when attributes match.',
  'Cloud Run cold starts happen when no instance is warm and a request arrives.',
];
console.log('Scout path (fast tier, reasoning off) — SB-03 budget is 1500ms:');
for (const p of passages) {
  const t = Date.now();
  const r = await llm.structured({ tier: 'fast', reasoning: 'off', system: 'Label learning material. JSON only.',
    prompt: `Passage: "${p}"\nShort topic label (2-4 words). Return {"label":"..."}`, schema });
  const ms = Date.now() - t;
  console.log(`  ${String(ms).padStart(5)}ms ${ms < 1500 ? 'OK ' : 'OVER'}  ${JSON.stringify(r.value)}`);
}
