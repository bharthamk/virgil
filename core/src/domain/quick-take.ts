import type { DepthRegister, Pin, QuickTakeFailureReceipt } from './types.js';

/** Learner-facing quick-take windows, shared by ranking and source eligibility. */
export const QUICK_TAKE_WINDOWS = [1, 3, 5] as const;
export type QuickTakeWindow = typeof QUICK_TAKE_WINDOWS[number];

/**
 * Minimum captured words that may advertise each window.
 *
 * A quick take may explain at greater length than its source. It may not turn
 * one sentence into a multi-minute general lecture. The ratio is deliberately
 * generous because the independent Verifier still owns the written draft;
 * this is an availability floor, not a replacement source check.
 */
export const QUICK_TAKE_SOURCE_WORDS: Readonly<Record<QuickTakeWindow, number>> = {
  1: 8,
  3: 24,
  5: 40,
};

const comparable = (text: string): string => text.toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Selection plus its real containing context is one source. Unrelated
 * fallback text is never silently joined to make a thin pin look sufficient. */
export function quickTakeMaterialFor(pin: Pin, maxChars = 1_500): string {
  const selected = pin.envelope.selection?.replace(/\s+/g, ' ').trim() ?? '';
  const context = pin.envelope.surroundingText.replace(/\s+/g, ' ').trim();
  if (!selected) return context.slice(0, maxChars);
  const selectedKey = comparable(selected);
  const contextKey = comparable(context);
  if (contextKey && selectedKey && contextKey !== selectedKey && contextKey.includes(selectedKey)) {
    // The context already contains the selection. Returning both made the
    // source look longer than it is and let a thirteen-word passage advertise
    // a three-minute lesson. The containing context is the one source.
    return context.slice(0, maxChars);
  }
  return selected.slice(0, maxChars);
}

export function quickTakeSourceWords(material: string): number {
  const clean = material.trim();
  return clean ? clean.split(/\s+/).length : 0;
}

/** Pure non-security identity for matching an operational failure receipt to
 * the captured material it describes. */
export function quickTakeMaterialKey(material: string): string {
  const text = comparable(material);
  let hash = 2_166_136_261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

const sourceBoundFailure = (
  receipt: QuickTakeFailureReceipt | null | undefined,
  material: string,
  register: DepthRegister,
): QuickTakeFailureReceipt | null => {
  if (!receipt || receipt.materialKey !== quickTakeMaterialKey(material)
      || receipt.register !== register) return null;
  return receipt.reason === 'source-drift' || receipt.reason === 'verifier-defect'
    ? receipt : null;
};

/**
 * Largest honest offer at or below the learner's requested window.
 *
 * A source-bound failure suppresses the same and longer attempts; a shorter
 * attempt remains possible because it asks the writer to make fewer claims.
 * Provider/generation failures remain retryable and are retained only for
 * diagnosis rather than turning the source into permanently unavailable work.
 */
export function quickTakeOfferMinutes(
  pin: Pin, requested: QuickTakeWindow, register: DepthRegister,
): QuickTakeWindow | null {
  const material = quickTakeMaterialFor(pin);
  const words = quickTakeSourceWords(material);
  const failed = sourceBoundFailure(pin.quickTakeFailure, material, register);
  const choices = QUICK_TAKE_WINDOWS.filter((minutes) => minutes <= requested
    && words >= QUICK_TAKE_SOURCE_WORDS[minutes]
    && (!failed || minutes < failed.minutes));
  return choices.at(-1) ?? null;
}
