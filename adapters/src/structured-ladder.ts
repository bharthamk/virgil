import type { LlmRequest, LlmResult } from '@sb/core';
import { validateSchema } from './json-schema.js';

/**
 * The structured-output recovery ladder, once, for every adapter.
 *
 * `Llm.structured` promises the caller two things no provider gives for free:
 * the reply is parsed, and the schema is ENFORCED. Getting from a text endpoint
 * to that promise took three attempts, each addressing a different cause, and
 * every one of them was learned from a failure rather than designed:
 *
 *   1. as asked
 *   2. same, with double the headroom — fixes plain truncation, which is graceful-degradation constraint:
 *      a reasoning pass ate the budget and the JSON was cut mid-object, and the
 *      nine-minute nightly run died with it
 *   3. reasoning off — the thinking pass is usually what ate the budget, so the
 *      last attempt stops paying for it
 *
 * And two rules about what NOT to retry, which matter as much:
 *
 *  - A transport failure or a fired deadline leaves the ladder immediately.
 *    Retrying a dead connection with double the budget only takes longer to fail
 *    the same way, and on the nightly run that time is multiplied across every
 *    stage.
 *  - A reply that never parsed gets headroom and no lecture; a reply that parsed
 *    but did not conform gets the violations named. Telling a model its truncated
 *    output "did not match the required schema" teaches it nothing, and retrying
 *    drift with the identical prompt asks it to guess again.
 *
 * ## Why it is here and not in each adapter
 *
 * It was written for Ollama and then copied, comment for comment, into the
 * Gemini skeleton — because it is not local-model behaviour. Every item on that
 * list is a property of asking a language model for JSON, and the second adapter
 * needed all of it despite sharing no wire format, no error envelope and no
 * schema mechanism with the first. A ladder that lives in each adapter is a
 * ladder that drifts: the next provider gets whichever copy was pasted, and the
 * contract in `__tests__/llm-contract.ts` would keep passing against both while
 * they slowly stopped being the same thing.
 *
 * What stays in the adapter is exactly what differs: how one attempt reaches its
 * provider. That is the provider-seam contract: a port costs an
 * adapter, not a rewrite — applied to the adapters themselves.
 */

/** The budget an unstated request gets. graceful-degradation constraint is what happens when it is too low. */
export const DEFAULT_OUTPUT_TOKENS = 2048;

/** One attempt, delivered to whatever provider the adapter speaks to. */
export type StructuredAttempt = (req: LlmRequest) => Promise<LlmResult<string>>;

export async function runStructuredLadder<T>(
  req: LlmRequest & { schema: unknown },
  attempt: StructuredAttempt,
): Promise<LlmResult<T>> {
  const budget = req.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
  const ladder: LlmRequest[] = [
    req,
    { ...req, maxOutputTokens: budget * 2 },
    { ...req, maxOutputTokens: budget * 2, reasoning: 'off' },
  ];

  let last: unknown;
  // Non-empty only after a reply that parsed but did not conform.
  let repair = '';
  for (const rung of ladder) {
    // Not caught: a transport failure is not a parse problem, so it leaves the
    // ladder and the pipeline stage handles it.
    const res = await attempt(repair ? { ...rung, prompt: `${rung.prompt}\n\n${repair}` } : rung);

    let parsed: unknown;
    try {
      parsed = JSON.parse(firstBalancedObject(res.value));
    } catch (err) {
      // Truncated or unparseable: more headroom, not repair instructions.
      last = err;
      repair = '';
      continue;
    }

    const violations = validateSchema(parsed, req.schema);
    if (!violations.length) return { ...res, value: parsed as T };

    last = new Error(`schema drift — ${violations.slice(0, 5).join('; ')}`);
    repair = [
      'Your previous reply was valid JSON but did not match the required schema:',
      ...violations.slice(0, 8).map((v) => `- ${v}`),
      'Return the corrected JSON object and nothing else.',
    ].join('\n');
  }
  throw new Error(`structured output did not conform after ${ladder.length} attempts: ${String(last)}`);
}

/**
 * The first balanced JSON object in a reply.
 *
 * Models wrap JSON in fences, prefix it with stray tokens, and sometimes emit a
 * partial key before the real object. Extracting the first balanced object is
 * more robust than trusting any of that, and it keeps every agent from having to
 * care. Kept even where the provider has a native `responseSchema` that should
 * make it unnecessary, because it costs nothing and every model this project has
 * met has at some point wrapped its JSON in a sentence.
 */
export const firstBalancedObject = (s: string): string => {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(s);
  const body = fenced?.[1] ?? s;
  const start = body.indexOf('{');
  if (start < 0) return body.trim();
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return body.slice(start, i + 1);
  }
  return body.slice(start).trim();
};
