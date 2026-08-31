import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from '../json-schema.js';
import { OllamaLlm } from '../ollama-llm.js';


const SECTION_SCHEMA = {
  type: 'object',
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topicId: { type: 'string' },
          body: { type: 'string' },
          estimatedMinutes: { type: 'number' },
          mediumWarning: { type: ['string', 'null'] },
        },
        required: ['topicId', 'body', 'estimatedMinutes', 'mediumWarning'],
      },
    },
    closingNote: { type: ['string', 'null'] },
  },
  required: ['sections', 'closingNote'],
};

const good = {
  sections: [{ topicId: 't1', body: 'text', estimatedMinutes: 3, mediumWarning: null }],
  closingNote: null,
};

// ---------------------------------------------------------------- validator

test('conforming output produces no violations', () => {
  assert.deepEqual(validateSchema(good, SECTION_SCHEMA), []);
});

test('a missing required property is a violation, named by path', () => {
  const v = validateSchema({ sections: [], closingNote: null, extra: 1 }, SECTION_SCHEMA);
  assert.deepEqual(v, []);
  const missing = validateSchema({ sections: [] }, SECTION_SCHEMA);
  assert.equal(missing.length, 1);
  assert.match(missing[0] as string, /closingNote.*required/);
});

test('a required property nested inside an array item is checked', () => {
  const v = validateSchema({ sections: [{ topicId: 't1', body: 'x', mediumWarning: null }], closingNote: null }, SECTION_SCHEMA);
  assert.equal(v.length, 1);
  assert.match(v[0] as string, /sections\[0\]\.estimatedMinutes/);
});

test('the wrong type for a right-named property is a violation', () => {
  const drifted = { sections: [{ ...good.sections[0], estimatedMinutes: '3 minutes' }], closingNote: null };
  const v = validateSchema(drifted, SECTION_SCHEMA);
  assert.equal(v.length, 1);
  assert.match(v[0] as string, /expected number, got string/);
});

test('a union type accepts either member and rejects the rest', () => {
  assert.deepEqual(validateSchema({ ...good, closingNote: 'three clauses' }, SECTION_SCHEMA), []);
  assert.deepEqual(validateSchema({ ...good, closingNote: null }, SECTION_SCHEMA), []);
  const v = validateSchema({ ...good, closingNote: ['a', 'b'] }, SECTION_SCHEMA);
  assert.match(v[0] as string, /expected string or null, got array/);
});

test('an integer satisfies a number, but a number does not satisfy an integer', () => {
  assert.deepEqual(validateSchema(3, { type: 'number' }), []);
  assert.deepEqual(validateSchema(3.5, { type: 'number' }), []);
  assert.deepEqual(validateSchema(3, { type: 'integer' }), []);
  assert.equal(validateSchema(3.5, { type: 'integer' }).length, 1);
});

test('extra properties pass unless the schema closes the object', () => {
  const open = { type: 'object', properties: { a: { type: 'string' } } };
  assert.deepEqual(validateSchema({ a: 'x', b: 2 }, open), []);
  assert.equal(validateSchema({ a: 'x', b: 2 }, { ...open, additionalProperties: false }).length, 1);
});

test('enum membership is checked', () => {
  const s = { type: 'string', enum: ['keep', 'withhold'] };
  assert.deepEqual(validateSchema('keep', s), []);
  assert.match(validateSchema('maybe', s)[0] as string, /expected one of/);
});

test('a wholly wrong shape reports the one fact that matters, not every child', () => {
  const v = validateSchema('not an object at all', SECTION_SCHEMA);
  assert.equal(v.length, 1, 'children of a wrong-typed value are noise');
  assert.match(v[0] as string, /\$: expected object, got string/);
});

// ------------------------------------------------------------------ adapter

/** One Ollama NDJSON reply, streamed the way the adapter reads it. */
const reply = (content: string): Response => {
  const line = JSON.stringify({ message: { content }, prompt_eval_count: 10, eval_count: 20 });
  return new Response(new TextEncoder().encode(`${line}\n`), { status: 200 });
};

/** Serves canned replies in order and records the prompts it was asked with. */
function stubOllama(bodies: readonly string[]): { prompts: string[]; formats: unknown[]; restore: () => void } {
  const prompts: string[] = [];
  const formats: unknown[] = [];
  const real = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const sent = JSON.parse(init.body) as { format?: unknown; messages: { role: string; content: string }[] };
    prompts.push(sent.messages.find((m) => m.role === 'user')?.content ?? '');
    formats.push(sent.format);
    return reply(bodies[Math.min(i++, bodies.length - 1)] as string);
  }) as unknown as typeof globalThis.fetch;
  return { prompts, formats, restore: () => { globalThis.fetch = real; } };
}

test('structured calls send the JSON schema to Ollama as the response format', async () => {
  const stub = stubOllama([JSON.stringify(good)]);
  try {
    await new OllamaLlm().structured({ tier: 'deep', system: 's', prompt: 'p', schema: SECTION_SCHEMA });
    assert.deepEqual(stub.formats, [SECTION_SCHEMA]);
  } finally {
    stub.restore();
  }
});

test('valid JSON of the wrong shape does not reach the caller', async () => {
  const stub = stubOllama([JSON.stringify({ sections: 'a paragraph instead of an array', closingNote: null })]);
  try {
    await assert.rejects(
      () => new OllamaLlm().structured({ tier: 'deep', system: 's', prompt: 'p', schema: SECTION_SCHEMA }),
      /did not conform/,
      'well-formed JSON used to pass straight through',
    );
    assert.equal(stub.prompts.length, 3, 'all three attempts are spent before giving up');
  } finally {
    stub.restore();
  }
});

test('drift is retried, and the retry is told what was wrong', async () => {
  const drifted = JSON.stringify({ sections: [{ topicId: 't1', body: 'x', estimatedMinutes: 'three', mediumWarning: null }], closingNote: null });
  const stub = stubOllama([drifted, JSON.stringify(good)]);
  try {
    const res = await new OllamaLlm().structured({ tier: 'deep', system: 's', prompt: 'p', schema: SECTION_SCHEMA });
    assert.deepEqual(res.value, good);
    assert.equal(stub.prompts.length, 2, 'it recovered on the second attempt');
    assert.match(stub.prompts[1] as string, /did not match the required schema/);
    assert.match(stub.prompts[1] as string, /estimatedMinutes/, 'the repair names the offending field');
    assert.doesNotMatch(stub.prompts[0] as string, /did not match/, 'the first attempt carries no repair text');
  } finally {
    stub.restore();
  }
});

/**
 * Truncation, not drift, is the dominant local failure. An unparseable reply
 * needs headroom, not a lecture about a schema it never got far enough to
 * violate.
 */
test('an unparseable reply is retried without repair instructions', async () => {
  const stub = stubOllama(['{"sections": [{"topicId": "t1", "bod', JSON.stringify(good)]);
  try {
    const res = await new OllamaLlm().structured({ tier: 'deep', system: 's', prompt: 'p', schema: SECTION_SCHEMA });
    assert.deepEqual(res.value, good);
    assert.doesNotMatch(stub.prompts[1] as string, /did not match the required schema/);
  } finally {
    stub.restore();
  }
});

/**
 * Belt and braces: `format: 'json'` constrains the sampler, but prose still
 * leaks around the object on some models. The extractor is the layer that
 * survives the port, where Gemini's responseSchema takes the sampler's role.
 */
test('prose around a conforming object is stripped rather than failed', async () => {
  const leaky = `Here is the session you asked for:\n\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\`\n\nLet me know if you want it shorter.`;
  const stub = stubOllama([leaky]);
  try {
    const res = await new OllamaLlm().structured({ tier: 'deep', system: 's', prompt: 'p', schema: SECTION_SCHEMA });
    assert.deepEqual(res.value, good);
    assert.equal(stub.prompts.length, 1, 'no retry needed — the extractor handled it');
  } finally {
    stub.restore();
  }
});
