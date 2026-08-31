/**
 * What Virgil offers a browser agent, without the browser.
 *
 * WebMCP is the replacement for the discovery door at `GET /agent/capabilities`.
 * That endpoint asked an agent to read a JSON contract and then hand-write four
 * HTTP requests against it; `document.modelContext` lets the page itself declare
 * the same four lanes as tools the agent can call, on the learner's own board,
 * inside the learner's own session. The lanes underneath are unchanged — these
 * tools post to the endpoints the panel already posts to.
 *
 * ## Why the descriptions are in a pure file
 *
 * A tool description is the whole of what the agent knows before it acts. It is
 * the same class of surface as `notebook.ts`'s label: copy that is a control
 * rather than decoration, and therefore copy a test can point at. Two laws hold
 * over every string here.
 *
 *  1. **Nothing becomes authoritative without learner review.** Three of these
 *     lanes write drafts and one writes drafts and material. None of them writes
 *     a course, a commitment, a deadline, a topic or a signal, and every
 *     description says so in its own words rather than relying on the agent to
 *     have read a shared preamble it was never sent.
 *  2. **A cap is stated before it is hit.** The service refuses an oversized
 *     batch with a 400, which reaches the agent as a failure it can only guess
 *     at. The bounds are published in the schema, checked here, and refused in a
 *     sentence naming the number that was sent and the number allowed.
 *
 * The caps themselves are the service's, restated. They must match
 * `runner/src/service.ts`, where they are function-local and cannot be imported.
 */

/**
 * Current WebMCP serializes the callback value itself. This is deliberately a
 * string, not the `{ content: [...] }` envelope used by server MCP transports.
 */
export type WebMcpToolResult = string;

/**
 * Enough JSON Schema for four narrow inputs.
 *
 * Hand-declared because the platform ships no types for this API yet and a
 * broad `object` would put the one thing an agent reads before calling — what
 * each property means — outside the type system.
 */
export interface JsonSchema {
  readonly type: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean';
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly items?: JsonSchema;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly oneOf?: readonly JsonSchema[];
}

/** Must match `CLASSIFICATION_PREVIEW_LIMIT` in `runner/src/service.ts`. */
export const CLASSIFICATION_PREVIEW_LIMIT = 100;
/** Must match `DROP_ITEM_LIMIT` in `runner/src/service.ts`. */
export const DROP_ITEM_LIMIT = 300;
/** Must match `CLASSIFICATION_CLIENT_REF_MAX_CHARS`/`DROP_CLIENT_REF_MAX_CHARS`. */
export const CLIENT_REF_MAX_CHARS = 180;
/** Must match `DROP_ID_MAX_CHARS`. */
export const DROP_ID_MAX_CHARS = 120;
/** Must match the corresponding domain/service limits. */
export const INTAKE_SOURCE_MAX_CHARS = 60_000;
export const SOURCE_TITLE_MAX_CHARS = 160;
export const CLASSIFICATION_TEXT_MAX_CHARS = 4_000;
export const DROP_TEXT_MAX_CHARS = 200_000;
export const SOURCE_URL_MAX_CHARS = 2_048;
export const DROP_NAME_MAX_CHARS = 200;
/** Chrome's current security guidance recommends at most 1.5K per output. */
export const TOOL_OUTPUT_MAX_CHARS = 1_500;

/** The source kinds both intake and the drop accept, in the service's order. */
export const COURSE_SOURCE_KINDS = [
  'syllabus', 'rubric', 'assignment-brief', 'course-page',
  'learner-note', 'image', 'other',
] as const;

export const TOOL_STUDY_STATE = 'get_study_state';
export const TOOL_DRAFT_INTAKE = 'draft_course_intake';
export const TOOL_PREVIEW_CLASSIFICATION = 'preview_classification';
export const TOOL_DROP_MATERIALS = 'drop_course_materials';

export const STUDY_STATE_DESCRIPTION =
  'Read the learner\'s current Virgil study state: the one action Virgil is offering '
  + 'next, how many active courses and open dated commitments there are, and how many '
  + 'course drafts are waiting for review. Reads only; writes nothing.';

export const DRAFT_INTAKE_DESCRIPTION =
  'Turn one course source — a syllabus, rubric, assignment brief, course page or note — '
  + 'into a single Virgil intake draft. Deterministic: no model call runs. It writes a '
  + 'draft and nothing else. No course, commitment, deadline, topic or signal exists '
  + 'until the learner reviews that draft and applies it themselves.';

export const PREVIEW_CLASSIFICATION_DESCRIPTION =
  'Ask which existing board topics a piece of text most resembles. Returns up to five '
  + `ranked topics per item for up to ${CLASSIFICATION_PREVIEW_LIMIT} items. This is a `
  + 'preview: nothing is filed, moved or written, and the learner is never shown a result '
  + 'of this call unless they ask for one.';

/**
 * The honesty this lane is named after.
 *
 * `GET /agent/capabilities` declared `imports.course-drop` with
 * `effect: 'material-and-drafts'` rather than `draft-only`, and wrote nine lines
 * explaining why the tidier label would have been a lie. The tool inherits both
 * the effect and the explanation: an agent choosing between these four tools is
 * in exactly the position that declaration was written for, and it is the only
 * one of the four whose writes are visible on the learner's board immediately.
 */
export const DROP_MATERIALS_DESCRIPTION =
  'Hand a whole folder of course documents to Virgil in one call, up to '
  + `${DROP_ITEM_LIMIT} items. This one is not draft-only. It writes material — every `
  + 'readable item becomes a pin on the learner\'s board and is visible there at once — '
  + 'and it writes proposals, which are drafts nobody has applied. It writes no course, '
  + 'no commitment, no deadline, no topic and no signal, and no model call runs while a '
  + 'drop is being accepted. Everything it proposes still waits for the learner\'s review.';

const CLIENT_REF_DESCRIPTION =
  'The caller\'s own name for this item, echoed back exactly. Must be unique within '
  + `the call and at most ${CLIENT_REF_MAX_CHARS} characters.`;

const KIND_DESCRIPTION =
  '`syllabus`, `rubric`, `assignment-brief` and `course-page` may propose a plan; '
  + '`learner-note`, `image` and `other` become material only.';

export const STUDY_STATE_SCHEMA: JsonSchema = {
  type: 'object', properties: {}, additionalProperties: false,
};

export const DRAFT_INTAKE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    clientRef: {
      type: 'string', minLength: 1, maxLength: CLIENT_REF_MAX_CHARS,
      description: 'A stable caller-owned retry ID. Reuse it when retrying this same source.',
    },
    text: {
      type: 'string', minLength: 1, maxLength: INTAKE_SOURCE_MAX_CHARS,
      description: 'The full text of the source, already extracted by the caller. '
        + 'Virgil does not fetch it.',
    },
    kind: { type: 'string', enum: COURSE_SOURCE_KINDS, description: KIND_DESCRIPTION },
    title: {
      type: 'string', maxLength: SOURCE_TITLE_MAX_CHARS,
      description: 'What to call this source in the review screen. Optional.',
    },
    url: {
      type: 'string', maxLength: SOURCE_URL_MAX_CHARS, format: 'uri',
      description: 'Where the source came from, kept as provenance. Optional; never fetched.',
    },
  },
  required: ['clientRef', 'text', 'kind'],
  additionalProperties: false,
};

export const PREVIEW_CLASSIFICATION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description: `The passages to sort, at most ${CLASSIFICATION_PREVIEW_LIMIT}.`,
      minItems: 1,
      maxItems: CLASSIFICATION_PREVIEW_LIMIT,
      items: {
        type: 'object',
        properties: {
          clientRef: {
            type: 'string', minLength: 1, maxLength: CLIENT_REF_MAX_CHARS,
            description: CLIENT_REF_DESCRIPTION,
          },
          text: {
            type: 'string', minLength: 1, maxLength: CLASSIFICATION_TEXT_MAX_CHARS,
            description: 'The passage to match against board topics.',
          },
        },
        required: ['clientRef', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

export const DROP_MATERIALS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string', maxLength: SOURCE_TITLE_MAX_CHARS,
      description: 'What to call this drop on the board. Optional.',
    },
    dropId: {
      type: 'string', minLength: 1, maxLength: DROP_ID_MAX_CHARS, pattern: '^[^:]+$',
      description: 'The caller\'s name for this gesture, so a retry of the same drop adds '
        + 'nothing twice. Required; reuse it for a retry. No colon.',
    },
    items: {
      type: 'array',
      description: `The documents, at most ${DROP_ITEM_LIMIT}.`,
      minItems: 1,
      maxItems: DROP_ITEM_LIMIT,
      items: {
        type: 'object',
        properties: {
          clientRef: {
            type: 'string', minLength: 1, maxLength: CLIENT_REF_MAX_CHARS,
            description: CLIENT_REF_DESCRIPTION,
          },
          name: {
            type: 'string', maxLength: DROP_NAME_MAX_CHARS,
            description: 'The document\'s file name or title. Optional.',
          },
          kind: { type: 'string', enum: COURSE_SOURCE_KINDS, description: KIND_DESCRIPTION },
          text: {
            type: 'string', minLength: 1, maxLength: DROP_TEXT_MAX_CHARS,
            description: 'The document\'s text, already extracted by the caller. '
              + 'Supply this or `url`, never both.',
          },
          url: {
            type: 'string', maxLength: SOURCE_URL_MAX_CHARS, format: 'uri',
            description: 'An HTTP or HTTPS address Virgil should read the document from. '
              + 'Supply this or `text`, never both.',
          },
        },
        required: ['clientRef', 'kind'],
        additionalProperties: false,
        oneOf: [
          { type: 'object', required: ['text'] },
          { type: 'object', required: ['url'] },
        ],
      },
    },
  },
  required: ['dropId', 'items'],
  additionalProperties: false,
};

export type CourseSourceKind = typeof COURSE_SOURCE_KINDS[number];

export interface DraftIntakeInput {
  readonly clientRef: string;
  readonly text: string;
  readonly kind: CourseSourceKind;
  readonly title?: string;
  readonly url?: string;
}

export interface ClassificationInput {
  readonly items: readonly { readonly clientRef: string; readonly text: string }[];
}

export interface DropMaterialsInput {
  readonly dropId: string;
  readonly title?: string;
  readonly items: readonly {
    readonly clientRef: string;
    readonly kind: CourseSourceKind;
    readonly name?: string;
    readonly text?: string;
    readonly url?: string;
  }[];
}

export type Checked<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u115F\u1160\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB]/;
const JOINERS = /[\u034F\u200C\u200D\uFE00-\uFE0F]/g;

const characters = (value: string): number => Array.from(value).length;
const stripInvisible = (value: string): string => value.replace(new RegExp(INVISIBLE.source, 'g'), '');
const rendersEmpty = (value: string): boolean =>
  !stripInvisible(value).replace(JOINERS, '').trim();
const plainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): string | null => {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  return extra ? `Unknown field “${extra}”. Nothing was sent.` : null;
};
const requiredString = (
  value: unknown, label: string, maxChars: number, exact = false,
): Checked<string> => {
  if (typeof value !== 'string' || rendersEmpty(value)) {
    return { ok: false, message: `${label} must be a non-empty string. Nothing was sent.` };
  }
  if (characters(value) > maxChars) {
    return {
      ok: false,
      message: `${label} has ${characters(value).toLocaleString('en-US')} characters; the limit is `
        + `${maxChars.toLocaleString('en-US')}. Nothing was sent.`,
    };
  }
  if (exact && INVISIBLE.test(value)) {
    return { ok: false, message: `${label} must not contain invisible control characters. Nothing was sent.` };
  }
  return { ok: true, value };
};
const optionalString = (
  value: unknown, label: string, maxChars: number,
): Checked<string | undefined> => {
  if (value === undefined) return { ok: true, value: undefined };
  return requiredString(value, label, maxChars);
};
const sourceKind = (value: unknown, label: string): Checked<CourseSourceKind> =>
  typeof value === 'string' && COURSE_SOURCE_KINDS.includes(value as CourseSourceKind)
    ? { ok: true, value: value as CourseSourceKind }
    : {
      ok: false,
      message: `${label} must be one of ${COURSE_SOURCE_KINDS.join(', ')}. Nothing was sent.`,
    };
const httpUrl = (value: unknown, label: string): Checked<string> => {
  const text = requiredString(value, label, SOURCE_URL_MAX_CHARS);
  if (!text.ok) return text;
  try {
    const parsed = new URL(text.value);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && !parsed.username && !parsed.password) return text;
  } catch { /* the sentence below owns every invalid URL shape */ }
  return {
    ok: false,
    message: `${label} must be an HTTP or HTTPS URL with no embedded credentials. Nothing was sent.`,
  };
};

export function validateEmptyInput(input: unknown): Checked<Record<string, never>> {
  if (!plainObject(input)) return { ok: false, message: 'Input must be an object. Nothing was sent.' };
  const extra = onlyKeys(input, []);
  return extra ? { ok: false, message: extra } : { ok: true, value: {} };
}

export function validateDraftIntake(input: unknown): Checked<DraftIntakeInput> {
  if (!plainObject(input)) return { ok: false, message: 'Input must be an object. Nothing was sent.' };
  const extra = onlyKeys(input, ['clientRef', 'text', 'kind', 'title', 'url']);
  if (extra) return { ok: false, message: extra };
  const clientRef = requiredString(input.clientRef, 'clientRef', CLIENT_REF_MAX_CHARS, true);
  const text = requiredString(input.text, 'text', INTAKE_SOURCE_MAX_CHARS);
  const kind = sourceKind(input.kind, 'kind');
  const title = optionalString(input.title, 'title', SOURCE_TITLE_MAX_CHARS);
  const url = input.url === undefined ? { ok: true, value: undefined } as const : httpUrl(input.url, 'url');
  if (!clientRef.ok) return clientRef;
  if (!text.ok) return text;
  if (!kind.ok) return kind;
  if (!title.ok) return title;
  if (!url.ok) return url;
  return {
    ok: true,
    value: {
      clientRef: clientRef.value, text: text.value, kind: kind.value,
      ...(title.value === undefined ? {} : { title: title.value }),
      ...(url.value === undefined ? {} : { url: url.value }),
    },
  };
}

export function validateClassification(input: unknown): Checked<ClassificationInput> {
  if (!plainObject(input)) return { ok: false, message: 'Input must be an object. Nothing was sent.' };
  const extra = onlyKeys(input, ['items']);
  if (extra) return { ok: false, message: extra };
  const items = Array.isArray(input.items) ? input.items : [];
  const batch = batchRefusal('item', items.length, CLASSIFICATION_PREVIEW_LIMIT);
  if (batch) return { ok: false, message: batch };
  const parsed: { clientRef: string; text: string }[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!plainObject(item)) {
      return { ok: false, message: `items.${index} must be an object. Nothing was sent.` };
    }
    const itemExtra = onlyKeys(item, ['clientRef', 'text']);
    if (itemExtra) return { ok: false, message: `items.${index}: ${itemExtra}` };
    const clientRef = requiredString(
      item.clientRef, `items.${index}.clientRef`, CLIENT_REF_MAX_CHARS, true,
    );
    const text = requiredString(item.text, `items.${index}.text`, CLASSIFICATION_TEXT_MAX_CHARS);
    if (!clientRef.ok) return clientRef;
    if (!text.ok) return text;
    if (seen.has(clientRef.value)) {
      return { ok: false, message: 'items must use unique clientRef values. Nothing was sent.' };
    }
    seen.add(clientRef.value);
    parsed.push({ clientRef: clientRef.value, text: text.value });
  }
  return { ok: true, value: { items: parsed } };
}

export function validateDropMaterials(input: unknown): Checked<DropMaterialsInput> {
  if (!plainObject(input)) return { ok: false, message: 'Input must be an object. Nothing was sent.' };
  const extra = onlyKeys(input, ['dropId', 'title', 'items']);
  if (extra) return { ok: false, message: extra };
  const dropId = requiredString(input.dropId, 'dropId', DROP_ID_MAX_CHARS, true);
  if (!dropId.ok) return dropId;
  if (dropId.value.includes(':')) {
    return { ok: false, message: 'dropId must not contain a colon. Nothing was sent.' };
  }
  const title = optionalString(input.title, 'title', SOURCE_TITLE_MAX_CHARS);
  if (!title.ok) return title;
  const items = Array.isArray(input.items) ? input.items : [];
  const batch = batchRefusal('document', items.length, DROP_ITEM_LIMIT);
  if (batch) return { ok: false, message: batch };
  const parsed: DropMaterialsInput['items'][number][] = [];
  const seen = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!plainObject(item)) {
      return { ok: false, message: `items.${index} must be an object. Nothing was sent.` };
    }
    const itemExtra = onlyKeys(item, ['clientRef', 'kind', 'name', 'text', 'url']);
    if (itemExtra) return { ok: false, message: `items.${index}: ${itemExtra}` };
    const clientRef = requiredString(
      item.clientRef, `items.${index}.clientRef`, CLIENT_REF_MAX_CHARS, true,
    );
    const kind = sourceKind(item.kind, `items.${index}.kind`);
    const name = optionalString(item.name, `items.${index}.name`, DROP_NAME_MAX_CHARS);
    if (!clientRef.ok) return clientRef;
    if (!kind.ok) return kind;
    if (!name.ok) return name;
    if (seen.has(clientRef.value)) {
      return { ok: false, message: 'items must use unique clientRef values. Nothing was sent.' };
    }
    seen.add(clientRef.value);
    const hasText = item.text !== undefined;
    const hasUrl = item.url !== undefined;
    if (hasText === hasUrl) {
      return {
        ok: false,
        message: `items.${index} must supply exactly one of text or url. Nothing was sent.`,
      };
    }
    const text = hasText
      ? requiredString(item.text, `items.${index}.text`, DROP_TEXT_MAX_CHARS)
      : { ok: true, value: undefined } as const;
    const url = hasUrl ? httpUrl(item.url, `items.${index}.url`)
      : { ok: true, value: undefined } as const;
    if (!text.ok) return text;
    if (!url.ok) return url;
    parsed.push({
      clientRef: clientRef.value, kind: kind.value,
      ...(name.value === undefined ? {} : { name: name.value }),
      ...(text.value === undefined ? {} : { text: text.value }),
      ...(url.value === undefined ? {} : { url: url.value }),
    });
  }
  return {
    ok: true,
    value: {
      dropId: dropId.value,
      ...(title.value === undefined ? {} : { title: title.value }),
      items: parsed,
    },
  };
}

/** Keep untrusted names one line and keep every result under the agent budget. */
export function boundedToolOutput(value: string): string {
  const visible = stripInvisible(value).trim();
  if (characters(visible) <= TOOL_OUTPUT_MAX_CHARS) return visible;
  const suffix = '\n…Output shortened by Virgil.';
  return `${Array.from(visible).slice(0, TOOL_OUTPUT_MAX_CHARS - characters(suffix)).join('')}${suffix}`;
}

const toolAtom = (value: string, maxChars = 240): string =>
  Array.from(stripInvisible(value).replace(/\s+/g, ' ').trim()).slice(0, maxChars).join('');

/**
 * A batch that is empty or over the lane's cap, refused in a sentence.
 *
 * Returned rather than thrown. A thrown `execute` reaches the agent as a tool
 * failure with no reading on it, and the two things worth knowing — what was
 * sent and what is allowed — would be exactly the two things missing. The
 * service refuses the same batch itself; this only makes the refusal legible
 * without spending the round trip.
 */
export function batchRefusal(what: string, count: number, cap: number): string | null {
  if (count < 1) return `Nothing was sent. Name at least one ${what}.`;
  if (count > cap) {
    return `That is ${count} ${what}s and this lane takes ${cap} at a time. `
      + 'Nothing was sent. Split the batch and call again.';
  }
  return null;
}

/** What Virgil is offering next, and how much is waiting behind it. */
export interface StudyStateReading {
  readonly primary: {
    readonly title: string; readonly detail: string; readonly minutes: number;
  } | null;
  readonly courses: number;
  readonly openCommitments: number;
  readonly pendingDrafts: number;
}

const count = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/**
 * The board in five lines.
 *
 * Deliberately not the payload. An agent handed `/today` and `/courses` whole
 * would be reading the learner's material, objectives and dated work in order to
 * answer "what is next", which is a disclosure the question never asked for.
 */
export function studyStateSummary(reading: StudyStateReading): string {
  const lines = [
    reading.primary
      ? `Next: ${toolAtom(reading.primary.title)} — ${toolAtom(reading.primary.detail)} `
        + `(${count(reading.primary.minutes, 'minute', 'minutes')})`
      : 'Next: nothing is being offered right now.',
    `Active courses: ${reading.courses}.`,
    `Open dated work: ${reading.openCommitments}.`,
    `Course drafts waiting for review: ${reading.pendingDrafts}.`,
    'Nothing here has been changed by this call.',
  ];
  return lines.join('\n');
}

export function studyStateUnavailable(parts: readonly string[], authentication = false): string {
  if (authentication) {
    return 'Virgil could not read this board because the learner is not signed in on this page. '
      + 'Nothing was changed.';
  }
  return `Virgil could not verify the complete study state (${parts.join(', ')} unavailable). `
    + 'No missing value has been reported as zero, and nothing was changed.';
}

/** One draft made, said as what it is rather than as what it will become. */
export function draftIntakeSummary(
  draft: { readonly title: string; readonly objectives: number; readonly commitments: number },
): string {
  return `Draft made: “${toolAtom(draft.title)}”, holding `
    + `${count(draft.objectives, 'proposed objective', 'proposed objectives')} and `
    + `${count(draft.commitments, 'proposed dated item', 'proposed dated items')}.\n`
    + 'It is a draft. No course, commitment, deadline, topic or signal exists until the '
    + 'learner opens it in My studies and applies it.';
}

export interface ClassificationMatch {
  readonly label: string | null;
  readonly similarity: number;
}

/** The ranked topics, one line per item, and nothing written anywhere. */
export function classificationSummary(
  results: readonly {
    readonly clientRef: string; readonly matches: readonly ClassificationMatch[];
  }[],
): string {
  const lines = results.map((result) => {
    const named = result.matches
      .map((match) => `${toolAtom(match.label ?? 'an unnamed topic', 120)} `
        + `(${match.similarity.toFixed(2)})`);
    return named.length
      ? `${toolAtom(result.clientRef, CLIENT_REF_MAX_CHARS)}: ${named.join(', ')}`
      : `${toolAtom(result.clientRef, CLIENT_REF_MAX_CHARS)}: no board topic resembles this yet.`;
  });
  return boundedToolOutput([
    `${count(results.length, 'item', 'items')} matched against the board.`,
    ...lines,
    'Preview only. Nothing was filed, moved or written.',
  ].join('\n'));
}

export interface DropReading {
  readonly dropId: string;
  readonly read: number;
  readonly failed: number;
  readonly repeated: number;
  readonly planned: number;
  readonly nights: number;
}

/**
 * The drop's receipt, with the part that is already on the board said first.
 *
 * `read` and `planned` are different numbers on purpose: a lecture handout is
 * material and never reaches the plan, so a summary that reported only one of
 * them would make three hundred documents look like three hundred proposals or
 * like none.
 */
export function dropSummary(reading: DropReading): string {
  const lines = [
    `Drop ${toolAtom(reading.dropId, DROP_ID_MAX_CHARS)}: ${count(reading.read, 'document', 'documents')} read, `
      + `${reading.failed} unreadable, ${reading.repeated} already here from an earlier attempt.`,
    `${count(reading.read, 'document is', 'documents are')} on the learner's board now as material.`,
    `${count(reading.planned, 'course draft is', 'course drafts are')} proposed and waiting `
      + 'for the learner to review.',
    'No course, commitment, deadline, topic or signal was written.',
    `Virgil expects to work the queue through over ${count(reading.nights, 'night', 'nights')}.`,
  ];
  return lines.join('\n');
}

/**
 * The service said no, or said nothing.
 *
 * Kept distinct the way `apiResult` keeps them in the panel: an agent that reads
 * "unreachable" retries later, and an agent that reads a 400 rewrites its input.
 * Collapsing both into "it failed" is what costs somebody an hour.
 */
export function serviceRefusalLine(status: number | null): string {
  if (status === null) return 'Virgil is not answering. Nothing was changed by this read.';
  if (status === 401 || status === 403) {
    return 'Virgil refused this call as unauthenticated. Nothing was changed. '
      + 'The learner may need to sign in on this page first.';
  }
  return `Virgil refused this call with status ${status}. Nothing was changed by this read.`;
}

export function writeFailureLine(status: number | null, retryName: string): string {
  if (status === 400 || status === 401 || status === 403 || status === 409 || status === 413
      || status === 429) {
    const signIn = status === 401 || status === 403
      ? ' The learner may need to sign in on this page first.' : '';
    const reason = status === 401 || status === 403 ? ' as unauthenticated' : '';
    return `Virgil refused this write${reason} with status ${status}. Nothing was written.${signIn}`;
  }
  return 'Virgil did not return a trustworthy write receipt. The write may have landed. '
    + `Check Virgil before retrying, and reuse the same ${retryName} if you do retry.`;
}

export function cancelledLine(writes: boolean, retryName = 'retry ID'): string {
  return writes
    ? `This call was cancelled. The write may have landed. Check Virgil before retrying, and reuse the same ${retryName}.`
    : 'This read was cancelled. Nothing was changed.';
}

export function protocolFailureLine(writes: boolean, retryName = 'retry ID'): string {
  return writes
    ? 'Virgil returned a write receipt this page could not verify. The write may have landed. '
      + `Check Virgil before retrying, and reuse the same ${retryName}.`
    : 'Virgil returned a study-state response this page could not verify. Nothing was changed.';
}
