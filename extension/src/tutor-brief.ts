

// ------------------------------------------------------------------ the route

/**
 * Google AI Mode, and the only place the address is written down.
 *
 * The host root and the search path, with no query on it: the query is built by
 * `forwardUrl` out of encoded parts, because a template with a `q=` already in
 * it is a template somebody appends a raw string to.
 */
export const AI_MODE_SEARCH = 'https://www.google.com/search';

/** The parameter that makes it AI Mode rather than a results page, and its one
 *  value. Named rather than inlined so the assertion has something to hold. */
export const AI_MODE_PARAM = 'udm';
export const AI_MODE_VALUE = '50';

/**
 * How long the forwarded url may get before the lesson body stops travelling.
 *
 * Deliberately conservative. There is no published limit for this surface, and
 * the failure mode of guessing high is the worst one available: a truncated
 * prompt still runs, still answers, and answers about half a lesson without
 * saying so. Six thousand characters is comfortably inside what browsers and
 * intermediaries handle without argument, and a lesson too long to fit is not
 * lost — the brief carries the Composer's summary of it either way, which is a
 * shorter true account rather than a longer maimed one.
 */
export const FORWARD_URL_CAP = 6000;


export const POPUP_WIDTH = 440;
export const POPUP_HEIGHT = 760;

/** Where the popup goes, given where the learner's window is. */
export interface PopupBox {
  readonly width: number; readonly height: number;
  readonly left: number; readonly top: number;
}

/**
 * **Beside the lesson, and never on top of it.**
 *
 * Right-aligned inside the learner's own window and level with its top, so the
 * lesson keeps the left of the screen and the chat takes the right. Computed
 * from the current window rather than from the screen, because a learner with a
 * browser on half a monitor should get a popup on the same half.
 *
 * Every input is treated as untrusted: `chrome.windows.getCurrent` returns
 * `left`, `top`, `width` and `height` as optional, and a fullscreen or
 * minimised window can answer with a zero or a negative. Falling back to a
 * sensible box is right, because the alternative is a window at `NaN` which
 * Chrome places somewhere nobody can predict.
 */
export function besideWindow(current: {
  left?: number; top?: number; width?: number; height?: number;
} | null | undefined): PopupBox {
  const num = (v: unknown, fallback: number): number =>
    (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const left = num(current?.left, 0);
  const top = num(current?.top, 0);
  const width = Math.max(POPUP_WIDTH, num(current?.width, 1440));
  const height = Math.max(320, num(current?.height, 900));
  return {
    width: POPUP_WIDTH,
    // Never taller than the window it sits beside: a popup running off the
    // bottom of the screen hides the follow-up box, which is the one part of
    // that surface the learner has to reach.
    height: Math.min(POPUP_HEIGHT, height),
    left: left + (width - POPUP_WIDTH),
    top,
  };
}


export function popupFeatures(box: PopupBox): string {
  return `popup=yes,width=${box.width},height=${box.height},left=${box.left},top=${box.top}`;
}

/** What the forwarded prompt is assembled from. Every field is already on the
 *  client when the lesson is drawn, so the control costs nothing to render. */
export interface TutorBrief {
  /** The lesson on screen. */
  readonly heading: string;
  /** The Composer's own one-line description of the section, or null. */
  readonly summary: string | null;
  /** `from-nothing`, `building`, `fluent`, or anything this build does not
   *  know, which is said as not knowing rather than guessed. */
  readonly depth: string;
  /** The course this lesson belongs to, where the board honestly knows. */
  readonly course: string | null;
  /** The dated work it moves forward, where there is one. */
  readonly serves: string | null;
  /** The next lesson in tonight's lineup, or null on the last one. */
  readonly next: string | null;
}

/**
 * Why I am here at all.
 *
 * Both facts are already chips on the lesson (The affordance-first interface contract). Null for neither is
 * a real answer rather than an absence: somebody studying off their own board
 * chose this, and saying so is truer than saying nothing.
 */
export function tutorGoalLine(course: string | null, serves: string | null): string {
  const subject = (course ?? '').trim();
  const work = (serves ?? '').trim();
  if (subject && work) return `I’m studying ${subject}, working towards ${work}.`;
  if (subject) return `I’m studying ${subject}.`;
  if (work) return `I’m working towards ${work}.`;
  return 'I’m studying from things I’ve pinned myself.';
}

/**
 * What I am opening.
 *
 * The summary is the Composer's own sentence about the section, written in the
 * call that wrote it. Not the body, and never the body's first sentence: that
 * mechanism was ruled out on 2026-08-24 because a well-written lesson opens on
 * an analogy often enough that extraction is wrong as a method rather than
 * wrong on a bad day.
 *
 * It carries extra weight when the lesson is too long to travel: this line is
 * then the whole of what the far end knows about the material. Opening is the
 * only progress the press proves; Virgil does not claim the learner read or
 * learnt a word before choosing another teaching surface.
 */
export function tutorNowLine(heading: string, summary: string | null): string {
  const name = (heading ?? '').replace(/\s+/g, ' ').trim() || 'this one';
  const said = (summary ?? '').replace(/\s+/g, ' ').trim().replace(/[.]+$/, '');
  return said
    ? `I’m opening a lesson on ${name}: ${said}.`
    : `I’m opening a lesson on ${name}.`;
}

/**
 * Where I actually am with it, and what I want done about that.
 *
 * The register is a machine word with a real meaning behind it, and the meaning
 * is the useful half. Said in the first person these become **requests I am
 * making of my own tutor**, which is a different thing from instructions a page
 * is slipping to somebody's model: *I have the basics, build on them* is me
 * telling a tutor how to teach me, and I am allowed to do that.
 */
export function tutorRegisterLine(depth: string): string {
  if (depth === 'from-nothing') {
    return 'This topic is new to me, so keep the words plain.';
  }
  if (depth === 'building') {
    return 'I have the basics; build on them, don’t re-explain.';
  }
  if (depth === 'fluent') {
    return 'I know this well; push me on the edge cases.';
  }
  return 'I’m not sure what level to call myself on this one.';
}

/** How I want to start on this topic. The lesson being open is not evidence it
 *  was read, so every branch begins from the learner's recorded level rather
 *  than claiming the material is already covered. */
export function tutorPracticeLine(depth: string): string {
  if (depth === 'from-nothing') {
    return 'I want to learn it from the beginning, one small step at a time.';
  }
  if (depth === 'building') {
    return 'I want to connect it to what I know and use it on a case I haven’t seen yet.';
  }
  if (depth === 'fluent') {
    return 'I want to test the edge cases and where the idea stops holding.';
  }
  return 'I want to work out what I understand and take the next useful step.';
}


export function tutorLineupLine(next: string | null): string {
  const after = (next ?? '').replace(/\s+/g, ' ').trim();
  return after
    ? `After this one I’m on to ${after}.`
    : 'This is the last one in today’s lineup.';
}

// ------------------------------------------------------------ the forwarding

/**
 * The question Virgil has, and the concrete first teaching move.
 *
 * **Both rehearsal findings live in this one function**, because both are about
 * the same three words and separating them is how one of them gets lost.
 *
 * **It takes a string and refuses everything else.** `section.question` is an
 * OBJECT: `{ prompt, expectedPoints }`, and `expectedPoints` is the Marker's
 * rubric — the answer. The rehearsal on 2026-08-25 caught a naive render
 * leaking it into the prompt, which would have handed my assistant the marking
 * scheme for the question it was about to help me attempt. Nothing that is not
 * a string can get through, so the leak has no route back in even if a caller
 * later passes the whole object by mistake.
 *
 * **And the first move is claimed in the same breath.** With only the question,
 * Gemini answered it on the spot. With *let me try*, Gemini waited without
 * asking it. The learner's actual request is both safer and more concrete: ask
 * me this question as the first response, then teach from my answer. The rubric
 * still cannot travel, the answer still stays the learner's, and the hand-off
 * now begins rather than announcing readiness.
 *
 * Emitted as ONE line so there is no arrangement of this file in which the
 * question travels without it.
 */
export const TUTOR_START_WITH_QUESTION =
  'I haven’t answered it. Ask me that question directly as your first response, then teach from my answer.';

export function tutorQuestionLine(prompt: string | null): string | null {
  if (typeof prompt !== 'string') return null;
  const said = prompt.replace(/\s+/g, ' ').trim();
  if (!said) return null;
  return `The lesson has this practice question: “${said}” ${TUTOR_START_WITH_QUESTION}`;
}

/**
 * The hand-over, and the last thing the prompt says.
 *
 * It ends with the transfer itself. The live failure was a welcome, a readiness
 * sentence and a menu — all work handed back to the learner — so the learner
 * says what they do not need and asks for teaching to begin now.
 *
 * Either the lesson travelled and is below, or it did not and the summary
 * further up is the whole account. Saying the wrong one is a small lie that
 * produces a confidently wrong answer at the far end.
 */
export function tutorForwardHandoffLine(carriesBody: boolean): string {
  const start = 'I don’t need a welcome, a menu, or a reminder to reply. Start teaching me now.';
  return carriesBody ? `The lesson itself is below. ${start}` : start;
}


export function tutorForwardLines(
  brief: TutorBrief, question: string | null, carriesBody: boolean,
): string[] {
  const lines = [
    tutorGoalLine(brief.course, brief.serves),
    tutorNowLine(brief.heading, brief.summary),
    tutorRegisterLine(brief.depth),
    tutorPracticeLine(brief.depth),
    tutorLineupLine(brief.next),
  ];
  // The question and the concrete first move are one line, so there is no
  // arrangement of this file in which one travels without the other.
  const asked = tutorQuestionLine(question);
  if (asked) lines.push(asked);
  lines.push(tutorForwardHandoffLine(carriesBody));
  return lines;
}

/**
 * The prompt itself: what I say, and then the lesson where it fits.
 *
 * **There is no heading over it.** The old one read *For your tutor*, which was
 * the whole bug: a line naming an audience is a line telling the model who it
 * is working for, and it worked for them. The prompt now opens with me talking,
 * because that is who is talking.
 *
 * Plain text, because that is what an address bar carries, what a clipboard
 * carries, and what the far end echoes back to me.
 */
export const TUTOR_LESSON_LABEL = 'Here’s the lesson Virgil opened:';

export function tutorForwardPrompt(lines: readonly string[], body: string | null): string {
  const said = (body ?? '').trim();
  const head = lines.join('\n');
  return said ? `${head}\n\n${TUTOR_LESSON_LABEL}\n${said}` : head;
}

/**
 * The url, built out of encoded parts.
 *
 * `URLSearchParams` rather than string concatenation, so a lesson containing an
 * ampersand cannot end the prompt early and start a parameter nobody meant.
 */
export function forwardUrl(prompt: string): string {
  const params = new URLSearchParams();
  params.set(AI_MODE_PARAM, AI_MODE_VALUE);
  params.set('q', prompt);
  return `${AI_MODE_SEARCH}?${params.toString()}`;
}

/** What the press will actually open, and whether the lesson went with it. */
export interface ForwardTarget {
  readonly url: string;
  /** False when the lesson was too long and the summary is carrying it. Read by
   *  the hand-over line, so the prompt never claims a body that is not there. */
  readonly carriesBody: boolean;
}

/**
 * **The whole decision, in one place: does the lesson fit?**
 *
 * Built with the body, measured, and rebuilt without it if the encoded url is
 * over the cap. Measured rather than estimated, because the encoding is where
 * the length actually comes from: a lesson of ordinary prose roughly triples
 * through percent-encoding once the newlines and punctuation are counted, and a
 * character count on the raw text would pass a prompt that the url refuses.
 *
 * Nothing is truncated. A prompt cut off mid-sentence still runs and still
 * answers, about half a lesson, without saying so — which is the failure this
 * whole file exists to avoid. The short branch sends the Composer's summary and
 * a hand-over line that does not claim a lesson is below it.
 */
export function tutorForwardTarget(
  brief: TutorBrief, question: string | null, body: string | null,
): ForwardTarget {
  const withBody = forwardUrl(tutorForwardPrompt(tutorForwardLines(brief, question, true), body));
  if ((body ?? '').trim() && withBody.length <= FORWARD_URL_CAP) {
    return { url: withBody, carriesBody: true };
  }
  return {
    url: forwardUrl(tutorForwardPrompt(tutorForwardLines(brief, question, false), null)),
    carriesBody: false,
  };
}

// --------------------------------------------------------------- the control


export const TUTOR_ROUTES_HEADING = 'Take this lesson to Gemini';

/** A new tab, at AI Mode, with the thread already in it. */
export const TUTOR_FORWARD_LABEL = 'New tab';


export const TUTOR_BESIDE_LABEL = 'Pop out';


export const TUTOR_COPY_LABEL = 'Side panel';


export const TUTOR_COPIED_LINE =
  'Forwarding prompt has been copied to your clipboard. '
  + 'Open your Gemini side panel, paste, and hit enter.';

/**
 * What each door does, as the control's title and its accessible name.
 *
 * The labels are short; this is the whole sentence. Both attributes are set
 * from this one string, because a control whose tooltip and accessible name
 * disagree is two different controls depending on how you meet it — the law the
 * lineup's own icon controls are already held to.
 *
 * *This lesson's thread* was the old wording, and *thread* is a word only this
 * codebase knew. What actually travels is the lesson and where the learner has
 * got to with it, so that is what the sentence says.
 */
export function tutorRouteTitle(where: ForwardWhere): string {
  if (where === 'beside') {
    return 'Opens a small window beside this page, with this lesson and where you have got to with it already written out.';
  }
  if (where === 'copy') {
    return 'Copies this lesson and where you have got to with it to your clipboard. No page can open your browser’s own side panel, so opening it and pasting stays yours.';
  }
  return 'Opens a new tab, with this lesson and where you have got to with it already written out.';
}

/**
 * The clipboard's payload: the same prompt, without the address arithmetic.
 *
 * **Exactly one builder feeds all three doors** — the same statements, the same
 * question handling, the same refusal to carry the Marker's rubric, the same
 * hand-over of the turn. The only difference is the cap, and the difference is
 * that there is not one: `FORWARD_URL_CAP` bounds a url, and this is not going
 * into a url. A lesson too long to fit in an address fits in a clipboard
 * perfectly well, and shortening it here would be carrying a limit from one
 * door to another that does not have it.
 */
export function tutorClipboardPrompt(
  brief: TutorBrief, question: string | null, body: string | null,
): { text: string; carriesBody: boolean } {
  const said = (body ?? '').trim();
  const carriesBody = !!said;
  return {
    text: tutorForwardPrompt(tutorForwardLines(brief, question, carriesBody), said || null),
    carriesBody,
  };
}

/**
 * **THE EXPLAINER UNDER THE BUTTONS IS GONE, AND THAT IS THE FIX.**
 *
 * It read: *"An assistant has to be pointed at this page before it can read any
 * of this. These three take the same words with them instead."* Both sentences
 * were true. Read cold in the rail, on 2026-08-29, they took three passes and
 * still did not say what pressing anything would do — the first sentence is
 * about a route the block does not offer, and *the same words* has no
 * antecedent anywhere on the screen.
 *
 * The house law is that the affordances are the instruction (The affordance-first interface contract), and
 * copy that has to explain a control is the report that the control is wrong.
 * So the object moved into the heading, the acts moved into the labels, and the
 * paragraph compensating for both is deleted rather than rewritten. Nothing
 * true was lost: `tutorRouteTitle` carries the whole sentence on every control,
 * and `TUTOR_COPIED_LINE` carries the one step that happens somewhere Virgil
 * cannot reach.
 *
 * Recorded rather than quietly removed, because a block with no paragraph under
 * it looks like a missing explanation to anyone who has not met the labels.
 */

/**
 * Which of the three doors the press used.
 *
 * Not a preference and nothing is stored: it is which button was pressed, and
 * it only ever changes a sentence.
 */
export type ForwardWhere = 'tab' | 'beside' | 'copy';

/** Where it went, in the words the button used. Said out loud because the
 *  learner is about to look at a chat and should know what it was given, and
 *  because the two controls must not report each other's outcome. */
export function forwardWhereLine(where: ForwardWhere): string {
  return where === 'beside' ? 'a window beside this page' : 'a new tab';
}

/**
 * What travelled, and where to.
 *
 * The copy door has no *too long* branch and never will: the cap is a property
 * of addresses, not of prompts, and a clipboard has no address in it. Saying
 * *this lesson was too long* over a clipboard write that carried the whole
 * lesson would be a sentence that is false in the one place a learner could
 * check it.
 */
export function tutorForwardedLine(carriesBody: boolean, where: ForwardWhere = 'tab'): string {
  // One line, whatever the lesson's length: the clipboard has no cap, so there
  // is no second case to report and nothing for a variant to say.
  if (where === 'copy') return TUTOR_COPIED_LINE;
  const there = forwardWhereLine(where);
  // *The brief* was this line's own word for the payload, and it named nothing
  // the learner had ever been shown: the on-page brief was deleted, so the
  // receipt was reporting the delivery of a thing with no referent. It says
  // what went instead, which is this lesson.
  return carriesBody
    ? `Opened ${there} with this lesson in it.`
    : `Opened ${there} with a summary of this lesson. The whole thing was too long for one address.`;
}

/**
 * It did not open.
 *
 * There is nowhere else to point the learner: the address is thousands of
 * characters of their own lesson and reading it out is not a recovery. What is
 * true and useful is that nothing was lost, because everything it would have
 * carried is the block they are looking at.
 *
 * Named for what failed, because *the tab* and *the window* are two different
 * things that just went wrong and a learner who pressed one should not be told
 * about the other.
 */
export function tutorOpenFailedLine(where: ForwardWhere = 'tab'): string {
  // *Above* was true when this block sat under the lesson. It is in the rail
  // now, beside it, so the recovery names the page rather than a direction.
  const kept = 'Nothing was lost. Everything it would have carried is still on this page.';
  if (where === 'copy') return `I couldn’t copy it. ${kept}`;
  const it = where === 'beside' ? 'the window' : 'the tab';
  return `I couldn’t open ${it}. ${kept}`;
}

// ------------------------------------------------- the same doors, from a topic


export const TOPIC_SAVED_LABEL = 'Here is what I saved on it:';

/** What I am trying to understand, and what the board knows about it. */
export function topicForwardLines(
  label: string, summary: string | null, carriesSaved: boolean,
): string[] {
  const lines = [`I am trying to get my head around ${label}.`];
  const said = (summary ?? '').replace(/\s+/g, ' ').trim();
  if (said) lines.push(said);
  // The same body-truth and no-waiting-room boundary the lesson uses.
  const start = 'I don’t need a welcome or a menu. Help me start learning it now.';
  lines.push(carriesSaved ? `What I saved on it is below. ${start}` : start);
  return lines;
}

export function topicForwardPrompt(lines: readonly string[], saved: string | null): string {
  const body = (saved ?? '').trim();
  const head = lines.join('\n');
  return body ? `${head}\n\n${TOPIC_SAVED_LABEL}\n${body}` : head;
}

/** Does what the learner saved fit in an address? Measured, never estimated,
 *  for the reason `tutorForwardTarget` gives: the encoding is where the length
 *  comes from, and nothing is ever cut off mid-sentence. */
export function topicForwardTarget(
  label: string, summary: string | null, saved: string | null,
): ForwardTarget {
  const withBody = forwardUrl(topicForwardPrompt(topicForwardLines(label, summary, true), saved));
  if ((saved ?? '').trim() && withBody.length <= FORWARD_URL_CAP) {
    return { url: withBody, carriesBody: true };
  }
  return {
    url: forwardUrl(topicForwardPrompt(topicForwardLines(label, summary, false), null)),
    carriesBody: false,
  };
}

/** The clipboard's copy, with no cap on it, exactly as the lesson's has none. */
export function topicClipboardPrompt(
  label: string, summary: string | null, saved: string | null,
): { text: string; carriesBody: boolean } {
  const body = (saved ?? '').trim();
  const carriesBody = !!body;
  return {
    text: topicForwardPrompt(topicForwardLines(label, summary, carriesBody), body || null),
    carriesBody,
  };
}
