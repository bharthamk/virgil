#!/usr/bin/env node
/**
 * Rebuild the 50-pin partition corpus from Virgil-authored synthetic text.
 *
 * The original bake-off used short excerpts captured from public websites.
 * That was useful private evaluation evidence, but it is the wrong payload for
 * a public source repository. This generator preserves the topic/cardinality
 * shape and stable pin ids while every sentence and URL is ours.
 */
import { writeFileSync } from 'node:fs';

const topics = [
  ['kv-edge-caching', 'Edge cache visibility', 3, ['regional cache', 'stale copy', 'negative lookup']],
  ['durable-objects', 'Single-owner objects', 2, ['unique object name', 'single execution location']],
  ['pg-vacuum', 'Database vacuum work', 2, ['cleanup traffic', 'long transaction']],
  ['db-indexes', 'Database index choices', 2, ['equality lookup', 'ordered lookup']],
  ['cors', 'Browser origin checks', 2, ['preflight request', 'response permission']],
  ['http-caching', 'HTTP cache freshness', 2, ['conditional validation', 'reverse cache']],
  ['intervals', 'Musical interval naming', 4, ['letter distance', 'interval quality', 'half-step change', 'perfect family']],
  ['modes', 'Musical mode colour', 3, ['raised sixth', 'tonic relationship', 'characteristic note']],
  ['seventh-chords', 'Seventh chord construction', 2, ['stacked thirds', 'guide tones']],
  ['tritone-substitution', 'Tritone substitution', 2, ['dominant replacement', 'shared guide tones']],
  ['maillard', 'Browning reactions', 2, ['surface heat', 'aroma compounds']],
  ['braising', 'Braising technique', 2, ['dry then wet heat', 'gentle covered cooking']],
  ['emulsions', 'Emulsion stability', 2, ['continuous phase', 'small droplets']],
  ['sourdough-starter', 'Sourdough starter care', 4, ['flour and water culture', 'feeding rhythm', 'ripe starter', 'levain build']],
  ['derailleur-adjustment', 'Derailleur adjustment', 4, ['limit stop', 'cable tension', 'guide pulley', 'barrel adjuster']],
  ['tire-sizing', 'Bicycle tire sizing', 2, ['bead-seat diameter', 'rim compatibility']],
  ['gear-ratios', 'Bicycle gear ratios', 2, ['chainring ratio', 'gain ratio']],
  ['torque-wrench', 'Torque wrench practice', 2, ['smooth pull', 'storage setting']],
  ['procrastination', 'Useful delay', 3, ['important work', 'small task displacement', 'deadline pressure']],
  ['maker-schedule', 'Focused work schedules', 2, ['long focus block', 'meeting fragmentation']],
  ['news-frontpage', 'News page triage', 1, ['mixed front-page topics']],
];

const pins = [];
const expected = [];
let number = 1;
for (const [slug, title, count, concepts] of topics) {
  for (let i = 0; i < count; i += 1) {
    const id = `pin-${String(number).padStart(2, '0')}`;
    const concept = concepts[i % concepts.length];
    const neighbour = concepts[(i + 1) % concepts.length];
    pins.push({
      id,
      capturedAt: `2026-07-${String(1 + ((number * 3) % 27)).padStart(2, '0')}`,
      type: number % 3 === 0 ? 'interest' : 'struggle',
      url: `https://example.invalid/virgil-fixture/${slug}/${i + 1}`,
      site: 'example.invalid',
      title: `${title} — synthetic note ${i + 1}`,
      headings: ['Virgil synthetic learning fixture', title],
      selection: `In this authored ${title.toLowerCase()} example, ${concept} is the main idea. It stays connected to ${neighbour}, but the two terms answer different questions in the worked scenario.`,
      surrounding: `This fictional passage exists only to test whether related notes cluster together while unrelated study areas stay separate. Topic marker: ${slug}.`,
      ...(number % 5 === 0 ? { note: `Synthetic learner note about ${concept}.` } : {}),
    });
    expected.push({
      id,
      expect: slug,
      why: `Virgil-authored synthetic fixture: both the topic marker and worked sentence concern ${title.toLowerCase()} (${concept}).`,
    });
    number += 1;
  }
}

if (pins.length !== 50) throw new Error(`Synthetic corpus must contain 50 pins, got ${pins.length}`);
writeFileSync(new URL('./real-pins.json', import.meta.url), `${JSON.stringify(pins, null, 2)}\n`);
writeFileSync(new URL('./real-expected.json', import.meta.url), `${JSON.stringify(expected, null, 2)}\n`);
console.log(`wrote ${pins.length} synthetic pins and ${expected.length} expected labels`);
