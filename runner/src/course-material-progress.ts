export type MaterialBlockMinutes = 1 | 2 | 3 | 4 | 5;

type MaterialProgressInput =
  | {
    readonly ok: true;
    readonly minutes: MaterialBlockMinutes;
    readonly expectedProgressMinutes: number | null;
  }
  | { readonly ok: false; readonly error: string };

/** Exact authority for a bounded material check-in; no JavaScript coercion. */
export function parseCourseMaterialProgress(
  body: Record<string, unknown>,
): MaterialProgressInput {
  const allowed = new Set(['minutes', 'expectedProgressMinutes']);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return { ok: false, error: 'send minutes and expectedProgressMinutes only' };
  }
  const minutes = body['minutes'];
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 5) {
    return { ok: false, error: 'minutes must be a whole number from 1 to 5' };
  }
  const expected = body['expectedProgressMinutes'];
  if (expected !== undefined
    && (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0)) {
    return { ok: false, error: 'expectedProgressMinutes must be a non-negative integer' };
  }
  return {
    ok: true,
    minutes: minutes as MaterialBlockMinutes,
    expectedProgressMinutes: expected === undefined ? null : expected as number,
  };
}
