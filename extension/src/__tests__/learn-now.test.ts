import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chromeHandoffStorage, handoffFor, HANDOFF_KEY, HANDOFF_MAX_AGE_MS, LEARN_NOW,
  pendingTake,
  isAwaitingPin, pendingHandoff,
} from '../learn-now.js';
import { learnNowOffer, LEARN_NOW_LABEL } from '../pin-body.js';

/**
 * The hand-off between the toast and the panel (SB-59).
 *
 * The tap happens in a page and the take is read in the side panel, and nothing
 * in Chrome carries an argument from one to the other. So the tap writes down
 * what it was about and the panel picks it up — which makes this a small piece
 * of state that outlives a service-worker death, and every one of those in this
 * extension is a place where the failure direction is the whole design.
 *
 * Here it is: a hand-off this file cannot read is *no take waiting*, and the
 * panel lands on the ordinary home screen. The cost of that is a take the
 * learner has to ask for again. The cost of the other direction is a panel that
 * hijacks itself onto a stale take and will not show them the session,
 * which §5 says is the front door, always.
 */

const NOW = Date.parse('2026-08-20T12:00:00.000Z');

test('a hand-off written a moment ago is a take waiting', () => {
  const h = handoffFor('p-1', 'Firestore indexes', NOW);
  assert.deepEqual(pendingTake(h, NOW + 1_000),
    { pinId: 'p-1', label: 'Firestore indexes', at: NOW, intent: 'take', failure: null });
});

test('an unnamed pin is still a take — the label is a heading, not the point', () => {
  assert.equal(pendingTake(handoffFor('p-1', null, NOW), NOW)?.label, null);
  assert.equal(pendingTake(handoffFor('p-1', '', NOW), NOW)?.label, null,
    'an empty label is no label, as it is everywhere else in this extension');
});

test('every unreadable hand-off is no take, and lands on the ordinary home screen', () => {
  const nothing = [
    undefined, null, 'a string', 42, [], [{ pinId: 'p-1', at: NOW }],
    {},
    { pinId: '', at: NOW },
    { pinId: 'p-1' },
    { pinId: 'p-1', at: 'yesterday' },
    { pinId: 'p-1', at: NaN },
    { pinId: 'p-1', at: Infinity },
    { pinId: 7, at: NOW },
  ];
  for (const raw of nothing) {
    assert.equal(pendingTake(raw, NOW), null, `${JSON.stringify(raw)} was read as a take`);
  }
});

test('a tap the learner has walked away from stops being one', () => {
  const fresh = handoffFor('p-1', null, NOW);
  assert.ok(pendingTake(fresh, NOW + HANDOFF_MAX_AGE_MS - 1));
  assert.equal(pendingTake(fresh, NOW + HANDOFF_MAX_AGE_MS + 1), null);
  assert.ok(HANDOFF_MAX_AGE_MS <= 15 * 60_000,
    'a window long enough to surprise somebody is a window that takes the front door away');
});

test('a stamp from the future is refused, like every other stamp in this extension', () => {
  // Same reason `isFresh` refuses one: a record written by a clock we cannot
  // trust is a record whose age we cannot read.
  assert.equal(pendingTake(handoffFor('p-1', null, NOW + 60_000), NOW), null);
});

// ------------------------------------------------------------- the storage

test('the hand-off round-trips through storage and is cleared to nothing', async () => {
  const store: Record<string, unknown> = {};
  const local = {
    get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
    set: async (items: Record<string, unknown>) => { Object.assign(store, items); },
  };
  const storage = chromeHandoffStorage(local, HANDOFF_KEY);

  assert.equal(await storage.read(), undefined, 'nothing waiting to begin with');
  await storage.write(handoffFor('p-1', 'TLS', NOW));
  assert.deepEqual(await storage.read(), { pinId: 'p-1', label: 'TLS', at: NOW, intent: 'take', failure: null });

  await storage.clear();
  assert.equal(pendingTake(await storage.read(), NOW), null, 'read once, and only once');
});

// --------------------------------------------------------------- the offer

test('SB-59: a take is offered only for a pin the service took and named', () => {
  assert.deepEqual(learnNowOffer({ ok: true, label: 'TLS', id: 'p-1' }),
    // Two labels, and they are two different sentences: `label` is what the
    // learner presses, `pinLabel` is what it is about. The second one is what
    // heads the quick-take screen while the take is still being written, and it
    // used to be dropped here — so the panel opened on a blank heading.
    { label: LEARN_NOW_LABEL, pinId: 'p-1', pinLabel: 'TLS' });

  // SB-47 protects capture from the network; consumption is allowed to need
  // it. A queued pin has no id and the service has never heard of it, so there
  // is nothing to offer a take against — and offering one would mean the
  // learner taps "now" and is handed an explanation at some later moment for a
  // passage they have stopped thinking about, with a comfort signal on it.
  assert.equal(learnNowOffer({ ok: false, label: null, id: null }), null);
  assert.equal(learnNowOffer({ ok: true, label: 'TLS', id: null }), null,
    'a reply we cannot address is not one to offer a take against');
  assert.equal(learnNowOffer({ ok: true, label: null, id: 'p-1' })?.pinId, 'p-1',
    'a pin the Scout could not name is still a pin there is something to say about');
  assert.equal(learnNowOffer({ ok: true, label: null, id: 'p-1' })?.pinLabel, null,
    'and it says so, rather than heading the screen with an empty string');
  assert.equal(learnNowOffer({ ok: true, label: '', id: 'p-1' })?.pinLabel, null);
});

test('the message kind the toast spells out is the one the worker listens for', () => {
  // `toast.ts` cannot import this constant: the whole function is serialised
  // across the `executeScript` boundary and an imported binding is `undefined`
  // in the page. So the literal is asserted against the constant here, and the
  // tap is exercised end to end in `toast-shell.test.ts`.
  assert.equal(LEARN_NOW, 'sb-learn-now');
});


test('the intent says which screen, and anything unrecognised is the take', () => {
  // A record from a build before guides existed carries no intent, and one
  // carrying a word this build does not know is a screen it cannot draw.
  // Both land on the screen that has always been there rather than nowhere.
  assert.equal(pendingTake(handoffFor('p-1', null, NOW, 'guide'), NOW)?.intent, 'guide');
  assert.equal(pendingTake(handoffFor('p-1', null, NOW), NOW)?.intent, 'take');
  assert.equal(pendingTake({ pinId: 'p-1', at: NOW }, NOW)?.intent, 'take');
  assert.equal(pendingTake({ pinId: 'p-1', at: NOW, intent: 'sideways' }, NOW)?.intent, 'take');
  assert.equal(pendingTake({ pinId: 'p-1', at: NOW, intent: 7 }, NOW)?.intent, 'take');
});

test('a pin still being made carries its intent with it', () => {
  // The menu routes open the panel before the pin exists, so the screen has to
  // be decided by the record that has no pin in it yet.
  const waiting = pendingHandoff('Training a network', NOW, 'guide');
  assert.equal(waiting.pinId, null);
  assert.equal(isAwaitingPin(waiting), true);
  assert.equal(pendingTake(waiting, NOW)?.intent, 'guide');
  assert.equal(isAwaitingPin(handoffFor('p-1', null, NOW)), false);
});
