import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DRIVE_ADD_SOURCES_LINE, DRIVE_CONNECT_ACTION, DRIVE_CONSENT_LINE, DRIVE_DISCONNECT_ACTION,
  DRIVE_HEADING, DRIVE_KICKER, DRIVE_LOCAL_LINE, DRIVE_NOTEBOOK_LINE, DRIVE_NO_CLIENT_LINE,
  DRIVE_NOT_WRITTEN_YET, DRIVE_OPEN_PERMISSION_ACTION, DRIVE_PERMISSION_TAB_FAILED, DRIVE_VALUE_LINE,
  driveBadge, driveClientLine, driveConnectLine, driveDocRow, driveForgetConfirmLines,
} from '../panel-core.js';


// ------------------------------------------------------------- the two states

test('with a sign in present there is no copy about where it came from', () => {
  // Every configured source used to get a sentence naming it, and all three were
  // self-narration under the affordance-first interface contract. A learner with a working button does not
  // need to know which of three places a client id came from.
  assert.equal(driveClientLine(true), null);
});

test('with none, the copy is a refusal that asks for nothing', () => {
  const line = driveClientLine(false);
  assert.equal(line, DRIVE_NO_CLIENT_LINE);
  assert.ok(line);
  // A missing capability, not an unfinished chore. The second sentence is the
  // one that stops it reading as a broken product.
  assert.match(line, /cannot offer a Drive connection/);
  assert.match(line, /nothing for you to do about it/);
});

test('nothing in any Drive copy teaches Google Cloud', () => {
  const everything = [
    DRIVE_KICKER, DRIVE_HEADING, DRIVE_VALUE_LINE, DRIVE_NOTEBOOK_LINE, DRIVE_CONSENT_LINE,
    DRIVE_LOCAL_LINE, DRIVE_CONNECT_ACTION, DRIVE_DISCONNECT_ACTION, DRIVE_NO_CLIENT_LINE,
    DRIVE_ADD_SOURCES_LINE, DRIVE_NOT_WRITTEN_YET, DRIVE_OPEN_PERMISSION_ACTION,
    DRIVE_PERMISSION_TAB_FAILED, ...driveForgetConfirmLines(),
  ].join(' ');
  for (const banned of [/client id/i, /client secret/i, /google cloud/i, /\bconsole\b/i,
    /oauth/i, /desktop app/i, /\bcredential/i, /\bapi key/i, /paste/i]) {
    assert.doesNotMatch(everything, banned, `learner copy said ${banned}`);
  }
});

// ------------------------------------------------------------------ the value

test('the value line says what the learner gets, in the three documents\' own terms', () => {
  // Value leads. It is the answer to the only question somebody reading this
  // block is actually asking, and it was the third paragraph before the ruling.
  assert.match(DRIVE_VALUE_LINE, /three documents in a folder in your Drive/);
  // Named by the moment they are reached for rather than by the shape of the
  // board underneath, which is the whole of what changed when five became three.
  assert.match(DRIVE_VALUE_LINE, /the lesson you are on right now/);
  assert.match(DRIVE_VALUE_LINE, /everything on your board/);
  assert.match(DRIVE_VALUE_LINE, /the subjects you have held before/);
  // Rewritten in place is what makes the setup a one-time thing, which is the
  // fact somebody is deciding whether to start.
  assert.match(DRIVE_VALUE_LINE, /rewrites those same three in place/);
});

test('the permission fact is a reassurance and not the headline', () => {
  // It stays, in full, because §4.2's scope is the one screen in this flow that
  // Virgil does not draw. It is simply no longer the first thing read.
  assert.match(DRIVE_CONSENT_LINE, /only permission it asks for/);
  assert.match(DRIVE_CONSENT_LINE, /does not reach anything else in your Drive/);
  assert.match(DRIVE_LOCAL_LINE, /between your Google account and Virgil on this computer/);
});

test('what the notebook does is said as Google\'s claim, never as Virgil\'s promise', () => {
  assert.match(DRIVE_NOTEBOOK_LINE, /^Google says/);
  assert.match(DRIVE_NOTEBOOK_LINE, /on its own schedule/);
  assert.match(DRIVE_NOTEBOOK_LINE, /Virgil cannot see your notebook/);
});

test('no Drive copy anywhere claims the notebook is current', () => {
  const everything = [
    DRIVE_HEADING, DRIVE_VALUE_LINE, DRIVE_NOTEBOOK_LINE, DRIVE_CONSENT_LINE, DRIVE_LOCAL_LINE,
    DRIVE_NO_CLIENT_LINE, DRIVE_ADD_SOURCES_LINE, ...driveForgetConfirmLines(),
    driveBadge(true, 'connected'), driveBadge(false, 'idle'),
  ].join(' ');
  // §5d's vocabulary law and §2's. The button may be called Connect Drive
  // because that is what the OAuth grant is; the notebook is never described
  // that way, and nothing is ever described as up to date.
  for (const banned of [/up to date/i, /\bsynced?\b/i, /\bintegrat/i, /\blinked\b/i,
    /connected to your notebook/i]) {
    assert.doesNotMatch(everything, banned, `learner copy claimed ${banned}`);
  }
});

test('the dash rule holds, as it does in every learner-facing string', () => {
  const everything = [
    DRIVE_KICKER, DRIVE_HEADING, DRIVE_VALUE_LINE, DRIVE_NOTEBOOK_LINE, DRIVE_CONSENT_LINE,
    DRIVE_LOCAL_LINE, DRIVE_NO_CLIENT_LINE, DRIVE_ADD_SOURCES_LINE, DRIVE_NOT_WRITTEN_YET,
    DRIVE_OPEN_PERMISSION_ACTION, DRIVE_PERMISSION_TAB_FAILED, ...driveForgetConfirmLines(),
  ].join(' ');
  assert.equal(/[—–]/.test(everything), false, 'an em-dash or an en-dash reached learner copy');
});

// ------------------------------------------------------------------ the chips

test('the chips report a state and never a refused request', () => {
  // *"Not allowed yet"* reported the truth in the voice of a request that had
  // been turned down, as though the learner had tried something. *"Drive
  // allowed"* did the same in the other direction: a permission granted rather
  // than a thing that is now true.
  assert.equal(driveBadge(false, 'idle', true), 'Not connected');
  assert.equal(driveBadge(true, 'connected', true), 'Connected');
  assert.equal(driveBadge(false, 'idle', false), 'Not available in this build');
  assert.equal(driveBadge(false, 'waiting', true), 'Waiting for Google');
  assert.equal(driveBadge(false, 'writing', true), 'Writing your documents');
});

test('no chip is accusatory, and none of them mentions the notebook', () => {
  const chips = [
    driveBadge(false, 'idle', true), driveBadge(true, 'connected', true),
    driveBadge(false, 'idle', false), driveBadge(false, 'waiting', true),
    driveBadge(false, 'writing', true),
  ];
  for (const chip of chips) {
    for (const banned of [/\ballowed\b/i, /\bdenied\b/i, /\brefused\b/i, /\bfailed\b/i,
      /\byet\b/i, /notebook/i]) {
      assert.doesNotMatch(chip, banned, `the chip "${chip}" said ${banned}`);
    }
  }
});

test('an attempt in flight says what it is doing, and idle says nothing at all', () => {
  assert.equal(driveConnectLine('idle', ''), null);
  assert.equal(driveConnectLine('waiting', 'Waiting for you to give permission in your browser.'),
    'Waiting for you to give permission in your browser.');
  // The service composes the sentence, so the panel and the log cannot describe
  // one attempt in two different ways.
  assert.equal(driveConnectLine('failed', 'You did not give Virgil permission.'),
    'You did not give Virgil permission.');
  assert.equal(driveConnectLine('connected', ''), null);
});

// ------------------------------------------------- the honest write, per §11

test('a written document is its title, and a failed one carries the reason', () => {
  assert.equal(driveDocRow({ title: 'Virgil: your sources', written: true, error: null }),
    'Virgil: your sources');
  assert.equal(
    driveDocRow({
      title: 'Virgil: your sources',
      written: false,
      error: 'There is no room left in your Google Drive, so I could not write it.',
    }),
    'Virgil: your sources. There is no room left in your Google Drive, so I could not write it.',
  );
});

test('a failed row is never blank, even when nothing said why', () => {
  // §11: a failed row carries a one-line reason in plain words, never blank and
  // never an exception's toString. Failure here looks exactly like success from
  // where the learner is standing, so a silent row is the whole problem.
  const row = driveDocRow({ title: 'Virgil: archive', written: false, error: null });
  assert.match(row, /It did not go through\./);
});

test('forgetting a Drive names what stays before it is done', () => {
  const lines = driveForgetConfirmLines();
  assert.match(lines.join(' '), /three documents stay exactly where they are/);
  assert.match(lines.join(' '), /does not delete anything of yours/);
  // §13: the notebook outliving the consent is recorded behaviour, and the
  // honest consequence is said rather than hidden behind the button.
  assert.match(lines.join(' '), /stop changing/);
});
