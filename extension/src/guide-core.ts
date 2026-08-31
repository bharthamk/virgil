import type { JsonSchema } from './webmcp-core.js';

export const GUIDE_SURFACES = [
  'current', 'capture', 'learn', 'grow', 'manage', 'customize',
] as const;
export type GuideSurface = typeof GUIDE_SURFACES[number];

export const GUIDE_TARGETS = [
  'top', 'capture-entry', 'captured-item', 'pins',
  'learn-surface', 'grow-surface', 'manage-surface', 'customize-settings',
  'current-priority',
] as const;
export type GuideTarget = typeof GUIDE_TARGETS[number];

export const GUIDE_SECTION_IDS = [
  'capture-form', 'source-pin', 'quick-lesson', 'topic',
  'process', 'manage-state', 'settings-choice',
] as const;
export type GuideSectionId = typeof GUIDE_SECTION_IDS[number];

export const TOOL_GUIDE_VIEW = 'guide_virgil_view';
export const GUIDE_MESSAGE_MAX_CHARS = 240;
export const GUIDE_VIEW_DESCRIPTION =
  'Explain one named target on the visible Virgil page. Presentation only: it never navigates, '
  + 'opens hidden areas, changes learner data or accepts a decision. Use refresh after navigation.';

export const GUIDE_VIEW_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    surface: {
      type: 'string', enum: GUIDE_SURFACES,
      description: 'The visible Virgil surface expected for this explanation.',
    },
    target: {
      type: 'string', enum: GUIDE_TARGETS,
      description: 'One stable Virgil target. Arbitrary selectors are not accepted.',
    },
    refresh: {
      type: 'boolean',
      description: 'Re-read the visible page after navigation or a normal product update.',
    },
    message: {
      type: 'string', maxLength: GUIDE_MESSAGE_MAX_CHARS,
      description: 'A concise explanation of this product concept. Optional.',
    },
    pauseForNext: {
      type: 'boolean',
      description: 'Wait at this concept for the person to press the visible Next button.',
    },
    exactSectionId: {
      type: 'string', enum: GUIDE_SECTION_IDS,
      description: 'Optional stable section within the named target.',
    },
  },
  required: ['surface', 'target', 'refresh'],
  additionalProperties: false,
};

export interface GuideViewInput {
  readonly surface: GuideSurface;
  readonly target: GuideTarget;
  readonly refresh: boolean;
  readonly message?: string;
  readonly pauseForNext?: boolean;
  readonly exactSectionId?: GuideSectionId;
}

export type GuideCheck =
  | { readonly ok: true; readonly value: GuideViewInput }
  | { readonly ok: false; readonly message: string };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateGuideView(input: unknown): GuideCheck {
  if (!record(input)) return { ok: false, message: 'Input must be an object. Nothing was shown.' };
  const allowed = ['surface', 'target', 'refresh', 'message', 'pauseForNext', 'exactSectionId'];
  const extra = Object.keys(input).find((key) => !allowed.includes(key));
  if (extra) return { ok: false, message: `Unknown field “${extra}”. Nothing was shown.` };
  if (!GUIDE_SURFACES.includes(input.surface as GuideSurface)) {
    return { ok: false, message: `surface must be one of ${GUIDE_SURFACES.join(', ')}. Nothing was shown.` };
  }
  if (!GUIDE_TARGETS.includes(input.target as GuideTarget)) {
    return { ok: false, message: `target must be one of ${GUIDE_TARGETS.join(', ')}. Nothing was shown.` };
  }
  if (typeof input.refresh !== 'boolean') {
    return { ok: false, message: 'refresh must be true or false. Nothing was shown.' };
  }
  if (input.pauseForNext !== undefined && typeof input.pauseForNext !== 'boolean') {
    return { ok: false, message: 'pauseForNext must be true or false. Nothing was shown.' };
  }
  if (input.message !== undefined
      && (typeof input.message !== 'string'
        || Array.from(input.message).length > GUIDE_MESSAGE_MAX_CHARS)) {
    return { ok: false, message: `message must be at most ${GUIDE_MESSAGE_MAX_CHARS} characters. Nothing was shown.` };
  }
  if (input.exactSectionId !== undefined
      && !GUIDE_SECTION_IDS.includes(input.exactSectionId as GuideSectionId)) {
    return { ok: false, message: 'exactSectionId is not a named Virgil guide section. Nothing was shown.' };
  }
  return {
    ok: true,
    value: {
      surface: input.surface as GuideSurface, target: input.target as GuideTarget,
      refresh: input.refresh,
      ...(input.message === undefined ? {} : { message: input.message }),
      ...(input.pauseForNext === undefined ? {} : { pauseForNext: input.pauseForNext }),
      ...(input.exactSectionId === undefined
        ? {} : { exactSectionId: input.exactSectionId as GuideSectionId }),
    },
  };
}
