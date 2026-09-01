import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lessonGroundingLine } from '../domain/lesson-grounding.js';

const now = new Date('2026-08-29T09:00:00Z');

const saved = (at: string, page = 'https://example.test/a') => ({ at, page });

test('the line places the lesson in what the learner saved and when', () => {
  assert.equal(lessonGroundingLine({
    saved: [saved('2026-07-04T10:00:00Z'), saved('2026-07-19T10:00:00Z', 'https://example.test/b')],
    register: 'from-nothing', now,
  }), 'You saved two pages about this in July. This is the groundwork, so this is where we start.');
});

test('one page is one page, and the count is of pages rather than of pins', () => {
  const line = lessonGroundingLine({
    saved: [saved('2026-07-04T10:00:00Z'), saved('2026-07-04T11:00:00Z')],
    register: 'from-nothing', now,
  });
  assert.match(line ?? '', /^You saved one page about this in July\./);
});

test('the second sentence follows the register rather than repeating its chip', () => {
  const building = lessonGroundingLine({
    saved: [saved('2026-08-02T10:00:00Z')], register: 'building', now,
  });
  const fluent = lessonGroundingLine({
    saved: [saved('2026-08-02T10:00:00Z')], register: 'fluent', now,
  });
  assert.match(building ?? '', /pick it up from there\.$/);
  assert.match(fluent ?? '', /still open\.$/);
  assert.doesNotMatch(`${building} ${fluent}`, /new to you|building|fluent/i);
});

test('a month outside this year says which year, so the memory is checkable', () => {
  assert.match(lessonGroundingLine({
    saved: [saved('2025-11-02T10:00:00Z')], register: 'building', now,
  }) ?? '', /in November 2025\./);
});

test('pages saved across different months drop the when rather than inventing one', () => {
  const line = lessonGroundingLine({
    saved: [saved('2026-06-02T10:00:00Z'), saved('2026-08-02T10:00:00Z', 'https://example.test/b')],
    register: 'building', now,
  });
  assert.equal(line, 'You saved two pages about this. You have met some of this already, so we pick it up from there.');
});

test('an unreadable date is dropped and the pages it belongs to still count', () => {
  assert.match(lessonGroundingLine({
    saved: [saved('not a date'), saved('2026-07-02T10:00:00Z', 'https://example.test/b')],
    register: 'from-nothing', now,
  }) ?? '', /^You saved two pages about this\. /);
});

test('nothing the learner saved means no line at all, not a sentence about nothing', () => {
  assert.equal(lessonGroundingLine({ saved: [], register: 'from-nothing', now }), null);
});

test('the line never carries a dash the house style bans', () => {
  for (const register of ['from-nothing', 'building', 'fluent'] as const) {
    const line = lessonGroundingLine({ saved: [saved('2026-07-02T10:00:00Z')], register, now }) ?? '';
    assert.doesNotMatch(line, /[–—]/, 'no em-dash and no en-dash in anything a learner reads');
  }
});
