/**
 * A JSON Schema check small enough to read in one sitting.
 *
 * The `Llm` port says structured output "enforces the schema and retries on
 * drift". Until now the local adapter only proved the bytes *parsed* — a reply
 * that was valid JSON of entirely the wrong shape sailed through and the agent
 * found out later, or worse, did not. `format: 'json'` at the Ollama end buys
 * well-formedness, not conformance.
 *
 * At port this role belongs to Gemini's native `responseSchema`, so this stays
 * deliberately small: it covers exactly the subset the agents' schemas use —
 * type (including union types like `['object','null']`), properties, required,
 * array items, enum, and additionalProperties when a schema opts into it. It is
 * not a general validator and does not pretend to be one.
 *
 * Violations are returned as human-readable paths because they are fed straight
 * back to the model as repair instructions; a boolean would be useless there.
 */

type Json = unknown;

interface SchemaNode {
  type?: string | readonly string[];
  properties?: Record<string, SchemaNode>;
  required?: readonly string[];
  items?: SchemaNode;
  enum?: readonly Json[];
  additionalProperties?: boolean | SchemaNode;
}

const typeOfJson = (v: Json): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
};

/** `integer` satisfies `number`; nothing else widens. */
const satisfies = (actual: string, want: string): boolean =>
  actual === want || (want === 'number' && actual === 'integer') || (want === 'integer' && actual === 'integer');

const MAX_VIOLATIONS = 20;

/**
 * @returns one message per violation, empty when the value conforms. Capped —
 * a wholly wrong shape can produce hundreds and the first few tell the story.
 */
export function validateSchema(value: Json, schema: unknown): string[] {
  const out: string[] = [];
  walk(value, schema as SchemaNode, '$', out);
  return out;
}

function walk(value: Json, schema: SchemaNode | undefined, path: string, out: string[]): void {
  if (!schema || typeof schema !== 'object' || out.length >= MAX_VIOLATIONS) return;

  if (schema.type !== undefined) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type as string];
    const actual = typeOfJson(value);
    if (!wanted.some((w) => satisfies(actual, w))) {
      out.push(`${path}: expected ${wanted.join(' or ')}, got ${actual}`);
      // Reporting the children of a value that is the wrong type outright is
      // noise; the model needs the one fact that matters.
      return;
    }
  }

  if (schema.enum && !schema.enum.some((e) => e === value)) {
    out.push(`${path}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
    return;
  }

  if (Array.isArray(value)) {
    if (schema.items) value.forEach((v, i) => walk(v, schema.items, `${path}[${i}]`, out));
    return;
  }

  // Only descend into properties for a genuine object. A schema written as
  // `type: ['object','null']` with properties beside it must accept null.
  if (value === null || typeof value !== 'object') return;
  const obj = value as Record<string, Json>;

  for (const key of schema.required ?? []) {
    if (!(key in obj)) out.push(`${path}.${key}: required property missing`);
  }

  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    if (key in obj) walk(obj[key], sub, `${path}.${key}`, out);
  }

  if (schema.additionalProperties === false) {
    const known = new Set(Object.keys(schema.properties ?? {}));
    for (const key of Object.keys(obj)) {
      if (!known.has(key)) out.push(`${path}.${key}: unexpected property`);
    }
  }
}
