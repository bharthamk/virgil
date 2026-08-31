import type { Theme } from './panel-core.js';

/** Presentation belongs to this browser, not the learner ledger. */
export const THEME_KEY = 'sb_theme';

/** One interpretation of stored theme state for every extension surface.
 * Kept here rather than importing the panel's full rendering module into
 * small page-side tools such as the pin form. */
export function normaliseTheme(raw: unknown): Theme {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

/**
 * Put one of Virgil's three real theme states on any extension document.
 * `system` is deliberately represented by no attribute so the media query is
 * the single authority for what the operating system currently prefers.
 */
export function applyDocumentTheme(doc: Document, raw: unknown): Theme {
  const theme = normaliseTheme(raw);
  if (theme === 'system') doc.documentElement.removeAttribute('data-theme');
  else doc.documentElement.setAttribute('data-theme', theme);
  return theme;
}
