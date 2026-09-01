import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { PIN_BOX_STYLE } from '../pin-box.js';
import { SELECTOR_STYLE } from '../selector.js';

const CSS_PATH = fileURLToPath(new URL('../../panel.css', import.meta.url));
// Tests execute from `dist/__tests__`; the authored extension sources remain
// beside that compiled tree under `src/` and are the release boundary this
// guard is meant to police.
const SOURCE_DIR = fileURLToPath(new URL('../../src/', import.meta.url));
const CSS = readFileSync(CSS_PATH, 'utf8');

const block = (source: string, selector: string): string => {
  const start = source.indexOf(selector);
  assert.ok(start >= 0, `missing ${selector}`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  assert.ok(open >= 0 && close > open, `unclosed ${selector}`);
  return source.slice(open + 1, close);
};

const token = (source: string, name: string): string => {
  const found = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(source)?.[1];
  assert.ok(found, `missing hex token --${name}`);
  return found;
};

const rgb = (hex: string): readonly number[] => [1, 3, 5]
  .map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
  .map((part) => part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string): number => {
  const [red, green, blue] = rgb(hex);
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
};
const contrast = (one: string, two: string): number => {
  const a = luminance(one);
  const b = luminance(two);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
const passes = (name: string, foreground: string, background: string, minimum: number): void =>
  assert.ok(contrast(foreground, background) >= minimum,
    `${name} is ${contrast(foreground, background).toFixed(2)}:1; needs ${minimum}:1`);

test('Whiteboard and Blackboard tokens meet their text and focus thresholds', () => {
  const themes = [
    ['Whiteboard', block(CSS, ':root {')],
    ['Blackboard', block(CSS, ':root[data-theme="dark"] {')],
  ] as const;
  for (const [theme, rules] of themes) {
    const bg = token(rules, 'bg');
    const card = token(rules, 'card');
    const board = token(rules, 'board');
    const accent = token(rules, 'accent');
    const warning = token(rules, 'warn');
    const surfaces = [['wall', bg], ['card', card], ['board', board]] as const;
    passes(`${theme} foreground on wall`, token(rules, 'fg'), bg, 4.5);
    passes(`${theme} board writing`, token(rules, 'mark-ink'), board, 4.5);
    passes(`${theme} muted board writing`, token(rules, 'board-muted'), board, 4.5);
    passes(`${theme} pending-state writing`, token(rules, 'mark-6'), board, 4.5);
    for (const [surface, colour] of surfaces) {
      passes(`${theme} muted on ${surface}`, token(rules, 'muted'), colour, 4.5);
      passes(`${theme} accent on ${surface}`, accent, colour, 4.5);
      passes(`${theme} warning on ${surface}`, warning, colour, 4.5);
      passes(`${theme} focus against ${surface}`, accent, colour, 3);
    }
    passes(`${theme} primary label`, token(rules, 'on-accent'), accent, 4.5);
    passes(`${theme} panel-tool focus`, token(rules, 'mark-2'), board, 3);
  }
});

test('the closed-shadow pin form meets the same two-theme contract', () => {
  const themes = [
    ['Whiteboard pin form', block(PIN_BOX_STYLE, ':host{')],
    ['Blackboard pin form', block(PIN_BOX_STYLE, ':host([data-theme="dark"]){')],
  ] as const;
  for (const [theme, rules] of themes) {
    const board = token(rules, 'sb-board');
    passes(`${theme} ink`, token(rules, 'sb-ink'), board, 4.5);
    passes(`${theme} muted`, token(rules, 'sb-muted'), board, 4.5);
    passes(`${theme} warning`, token(rules, 'sb-warn'), board, 4.5);
    passes(`${theme} focus`, token(rules, 'sb-focus'), board, 3);
  }
});

test('system theme stays live and explicit themes remain explicit', () => {
  assert.match(block(CSS, ':root {'), /color-scheme:\s*light/);
  assert.match(CSS,
    /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/);
  assert.match(CSS, /:root\[data-theme="dark"\]\s*\{/);
  assert.match(block(CSS, ':root[data-theme="dark"] {'), /color-scheme:\s*dark/);
  assert.match(PIN_BOX_STYLE,
    /@media\(prefers-color-scheme:dark\)\{\s*:host\(:not\(\[data-theme="light"\]\)\)/);
  assert.match(PIN_BOX_STYLE, /:host\(\[data-theme="dark"\]\)\{/);
});

test('fields, buttons, links and disclosure controls all use a governed focus token', () => {
  assert.match(CSS,
    /:is\(select, textarea, input\):focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/s);
  assert.match(CSS,
    /:is\(button, a, summary\):focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/s);
  assert.match(CSS,
    /\.panel-tool:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--mark-2\)/s);
});

test('every shipped animation or transition has a reduced-motion answer', () => {
  const files = [CSS_PATH, ...readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(SOURCE_DIR, name))];
  const declarations = files.flatMap((file) => {
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    return [...source.matchAll(/(?:animation|transition)(?:-[a-z]+)?\s*:/g)]
      .map((match) => `${file.slice(file.lastIndexOf('/') + 1)}:${match[0]}`);
  }).sort();
  assert.deepEqual(declarations, [
    'panel.css:animation-delay:',
    'panel.css:animation-delay:',
    'panel.css:animation:',
    'panel.css:animation:',
    'selector.ts:transition:',
    'selector.ts:transition:',
    'toast.ts:transition:',
  ]);
  assert.match(CSS,
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.thinking \.dots i \{ animation: none/);
  assert.match(SELECTOR_STYLE,
    /@media\(prefers-reduced-motion:reduce\)\{\.sb-mark\{transition:none\}\}/);
  const toast = readFileSync(join(SOURCE_DIR, 'toast.ts'), 'utf8');
  assert.match(toast, /transition:\$\{reduceMotion \? 'none'/);
  assert.match(toast, /if \(reduceMotion\) \{ host\.remove\(\); return; \}/);
});
