import {
  isOpenableUrl, MATERIAL_TITLE_MAX_CHARS, rendersEmpty, stripInvisible,
  type Material, type MaterialKind,
} from '@sb/core';

type MaterialEdit =
  | { readonly ok: true; readonly material: Material }
  | { readonly ok: false; readonly error: string };

const KINDS: readonly MaterialKind[] = ['video', 'reading', 'class', 'exercise', 'other'];

/** Validate the complete learner-editable boundary without touching evidence fields. */
export function reviseCourseMaterial(
  material: Material, body: Record<string, unknown>,
): MaterialEdit {
  const allowed = new Set(['title', 'url', 'kind', 'minutes']);
  const supplied = Object.keys(body);
  if (!supplied.length || supplied.some((key) => !allowed.has(key))) {
    return { ok: false, error: 'change title, link, kind or minutes only' };
  }
  let title = material.title;
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || rendersEmpty(body.title)) {
      return { ok: false, error: 'title is required, as a non-empty string' };
    }
    title = stripInvisible(body.title).trim();
    if (Array.from(title).length > MATERIAL_TITLE_MAX_CHARS) {
      return { ok: false, error: 'material title must contain at most 180 characters' };
    }
  }
  let url = material.url;
  if (body.url !== undefined) {
    if (body.url !== null && typeof body.url !== 'string') {
      return { ok: false, error: 'url must be a string, or left out' };
    }
    url = body.url === null ? '' : stripInvisible(body.url);
  }
  if (url && !isOpenableUrl(url)) return { ok: false, error: 'that link is not one I can open' };
  const kind = body.kind === undefined ? material.kind : body.kind;
  if (typeof kind !== 'string' || !KINDS.includes(kind as MaterialKind)) {
    return { ok: false, error: `kind must be one of: ${KINDS.join(', ')}` };
  }
  let minutes = material.minutes;
  if (body.minutes !== undefined) {
    const value = body.minutes;
    if (value === null || value === '') minutes = null;
    else {
      if (typeof value !== 'number' && typeof value !== 'string') {
        return { ok: false, error: 'minutes must be a number of minutes between 1 and 1440' };
      }
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0 || number > 1440) {
        return { ok: false, error: 'minutes must be a number of minutes between 1 and 1440' };
      }
      minutes = Math.round(number);
    }
  }
  return { ok: true, material: { ...material, title, url, kind: kind as MaterialKind, minutes } };
}
