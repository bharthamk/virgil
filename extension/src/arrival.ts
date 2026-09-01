/**
 * ARRIVAL — what the rail says when there is no lineup to say anything about.
 *
 * Three states, and they were three near-identical blocks inside `paintLearn`:
 * a board with nothing on it yet, a board whose work is finished, and a board
 * whose next move is real but is not a session. They are the only screens in
 * this product a person sees before it has done anything for them, which makes
 * them the screens that decide whether it gets a second visit, and they were
 * living as scaffolding in the middle of the room that paints lessons.
 *
 * SB-279 gave the first of the three actual work to do, so it moved here with
 * the other two rather than growing inside a file that has no room to grow.
 *
 * This module knows how to draw a rail block and nothing else. It holds no
 * route: a row with a door is handed an `open` callback by the shell, because
 * the shell is the only thing that may decide what a press does.
 */
import {
  RAIL_CAUGHT_UP_HEADING, RAIL_CAUGHT_UP_LINE, RAIL_EMPTY_HEADING, RAIL_EMPTY_LINE,
  RAIL_ONE_MOVE_HEADING, RAIL_ONE_MOVE_LINE,
  RAIL_PLAN_CAUGHT_UP_LINE, RAIL_STUDIES_CAUGHT_UP_LINE,
} from './panel-core.js';

const el = (html: string): HTMLElement => {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html.trim();
  return wrapper.firstElementChild as HTMLElement;
};

/** A room the arrival screen can genuinely hand somebody to. */
export type ArrivalDoor = 'capture' | 'plan';

export interface ArrivalWay {
  /** A stable hook, so the row can be found without reading its sentence. */
  readonly key: 'course' | 'own-work' | 'web';
  /** The kind of thing, in two or three words. */
  readonly lead: string;
  /** What happens to it, in one sentence. */
  readonly line: string;
  /** The room this row opens, or null when this surface has no door for it. */
  readonly door: ArrivalDoor | null;
}

/**
 * THE FRONT DOOR, AND WHAT IT IS SELLING.
 *
 * The empty board used to carry one verb — *"Add course material"* — under one
 * sentence, and a person arriving at it learned that this product wanted a
 * syllabus. That is one of three things it takes, and the smallest of them.
 * The whole idea is that you collect anything from anywhere and it comes back
 * as the next move in the minutes you have; a screen that names one intake is
 * a screen that hides two thirds of the product at the only moment somebody is
 * deciding what it is for.
 *
 * So the block names all three, in the order somebody meets them: the course
 * they are enrolled in, the work they owe, and the reading they do anyway.
 *
 * Two of them are doors. The third is not, and it stays a sentence rather than
 * a button, because the pinning it describes happens in the browser and there
 * is nothing on this page to press that would do it. A row that looked like a
 * control and behaved like a caption would be the one promise on the arrival
 * screen that the product cannot keep.
 */
export const ARRIVAL_WAYS_HEADING = 'Ways to add';

export const ARRIVAL_WAYS: readonly ArrivalWay[] = [
  {
    key: 'course',
    lead: 'A course',
    line: 'Paste an outline, drop in documents, or a screenshot of the syllabus. '
      + 'Virgil drafts the plan; you review every line before it counts.',
    door: 'capture',
  },
  {
    key: 'own-work',
    lead: 'Your own work',
    line: 'An essay, a deadline, a draft to check. '
      + 'It gets fitted into the minutes you actually have.',
    door: 'plan',
  },
  {
    /**
     * No door, and the sentence says where the gesture lives instead. The
     * hour is deliberately not named: the run is one UTC cron and the learner
     * is not in UTC, so this promises the next session rather than a time of
     * night this product does not control.
     */
    key: 'web',
    lead: 'The web, as you browse',
    line: 'With the extension, anything worth keeping is one pin away. '
      + 'Before your next session, Virgil reads what you saved and turns it into '
      + 'short lessons on your plan.',
    door: null,
  },
];

/** The shared skeleton: a heading over a column of rows. */
function railBlock(mark: string, heading: string): HTMLElement {
  const node = el(`<div class="rail-block empty" ${mark}>
    <span class="alt-label"></span>
  </div>`);
  (node.querySelector('.alt-label') as HTMLElement).textContent = heading;
  return node;
}

/** A block that is a heading and one paragraph. */
function saidBlock(mark: string, heading: string, line: string): HTMLElement {
  const node = railBlock(mark, heading);
  const p = el(`<p></p>`);
  p.textContent = line;
  node.append(p);
  return node;
}

/**
 * The ways-to-add block, on a genuinely empty board and nowhere else.
 *
 * Each row is a real button where it has a real room behind it, so it is
 * reachable by tab and announced as a control, which is the same treatment the
 * alternatives directly under it get. The doorless row is a `div` for exactly
 * the same reason: what is spoken should be what is true.
 */
export function waysToAddBlock(open: (door: ArrivalDoor) => void): HTMLElement {
  const node = railBlock('data-rail-ways', ARRIVAL_WAYS_HEADING);
  const host = el(`<div class="rail-actions"></div>`);
  for (const way of ARRIVAL_WAYS) {
    const row = way.door
      ? el(`<button class="link alt" data-way="${way.key}"></button>`)
      : el(`<div class="alt plain" data-way="${way.key}"></div>`);
    const lead = el(`<span class="what"></span>`);
    lead.textContent = way.lead;
    const line = el(`<span class="meta"></span>`);
    line.textContent = way.line;
    row.append(lead, line);
    if (way.door) {
      const door = way.door;
      row.addEventListener('click', () => open(door));
    }
    host.append(row);
  }
  node.append(host);
  return node;
}

/** The board whose work is done, and which of its rooms holds what was done. */
export function caughtUpBlock(destination: string | null): HTMLElement {
  return saidBlock('data-rail-caught-up', RAIL_CAUGHT_UP_HEADING,
    destination === 'courses'
      ? RAIL_STUDIES_CAUGHT_UP_LINE
      : destination === 'plan'
        ? RAIL_PLAN_CAUGHT_UP_LINE
        : RAIL_CAUGHT_UP_LINE);
}


export function railEmptyBlock(sessionIsTheMove: boolean): HTMLElement {
  return saidBlock('data-rail-empty',
    sessionIsTheMove ? RAIL_EMPTY_HEADING : RAIL_ONE_MOVE_HEADING,
    sessionIsTheMove ? RAIL_EMPTY_LINE : RAIL_ONE_MOVE_LINE);
}
