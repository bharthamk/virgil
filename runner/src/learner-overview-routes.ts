import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  commitmentState, orderCommitments, starsFrom, totalPoints, towardNextStar,
  mutateLearnerPrefs, validAvailableMinutes,
  type AvailableMinutes, type Deps, type LearnerPrefs,
} from '@sb/core';

type Store = Deps['store'];
type StoredPrefs = Awaited<ReturnType<Store['getPrefs']>>;

export interface LearnerOverviewRouteContext {
  readonly store: Store;
  readonly now: () => Date;
  readonly hostedNeedsRun: boolean;
  readonly hostedRunAvailable: boolean;
  readonly readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  readonly validatePrefs: (body: Record<string, unknown>) => Partial<LearnerPrefs>;
  readonly readNextAction: (
    minutes: AvailableMinutes, knownPrefs?: StoredPrefs, requestedZone?: string,
    passedOverPinIds?: readonly string[],
  ) => Promise<unknown>;
  readonly requestTimeZone: (req: IncomingMessage) => string | undefined;
  readonly zoneOf: (prefs: StoredPrefs, requestedZone?: string) => string;
  readonly reply: (res: ServerResponse, code: number, body: unknown) => void;
}

/**
 *  — the picks the learner has already refused on this visit, off the
 * query string.
 *
 * A read stays a read. This says nothing about the board and writes nothing to
 * it: it is the same ranking, asked again with a few candidates held out,
 * because a learner who says *show me another* is owed the ranker's next answer
 * rather than a shuffle the browser made up.
 *
 * Bounded twice over for the same reason every other identifier on this service
 * is. A pin id is a uuid; the length cap is generous enough not to care what a
 * future one looks like and small enough that a hostile query cannot turn a
 * `Set` lookup into work, and the count cap is above any number of refusals a
 * person makes in one sitting. Anything longer is dropped rather than refused:
 * the worst an unrecognised id can do is fail to match a pin, which is the same
 * as not sending it.
 */
const PASSED_OVER_ID_MAX_CHARS = 200;
const PASSED_OVER_MAX = 20;

const passedOverPins = (url: URL): readonly string[] => url.searchParams
  .getAll('passedOver')
  .map((id) => id.trim())
  .filter((id) => id.length > 0 && id.length <= PASSED_OVER_ID_MAX_CHARS)
  .slice(0, PASSED_OVER_MAX);

/**
 * The read-heavy learner overview routes: preferences, Today, Plan and the
 * relationship choices needed by result capture.
 *
 * Keeping them together makes the ownership boundary visible without coupling
 * this module to service authentication, model-budget middleware or mutation
 * routes. `true` means the request was answered; `false` lets the next bounded
 * router inspect it.
 */
export async function handleLearnerOverviewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: LearnerOverviewRouteContext,
): Promise<boolean> {
  const withProcessingCapability = (prefs: LearnerPrefs): Record<string, unknown> => ({
    ...prefs,
    automaticProcessing: {
      available: !ctx.hostedNeedsRun || ctx.hostedRunAvailable,
      mode: ctx.hostedRunAvailable
        ? 'cloud-run-job' : ctx.hostedNeedsRun ? 'unavailable' : 'in-process',
    },
  });

  if (url.pathname === '/prefs') {
    if (req.method === 'GET') {
      ctx.reply(res, 200, withProcessingCapability(await ctx.store.getPrefs()));
      return true;
    }
    if (req.method === 'PUT') {
      const patch = ctx.validatePrefs(await ctx.readBody(req));
      if (ctx.hostedNeedsRun && !ctx.hostedRunAvailable && patch.autoAfter !== null
          && patch.autoAfter !== undefined) {
        ctx.reply(res, 409, {
          error: 'This hosted installation has not connected its background worker.',
        });
        return true;
      }
      const next = await mutateLearnerPrefs(ctx.store, (current) => ({ ...current, ...patch }));
      ctx.reply(res, 200, withProcessingCapability(next));
      return true;
    }
  }

  if (req.method === 'GET' && url.pathname === '/today') {
    const prefs = await ctx.store.getPrefs();
    const minutes = validAvailableMinutes(
      url.searchParams.get('minutes'), validAvailableMinutes(prefs.availableMinutes, 3));
    ctx.reply(res, 200, {
      next: await ctx.readNextAction(
        minutes, prefs, ctx.requestTimeZone(req), passedOverPins(url),
      ),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/plan') {
    const now = ctx.now();
    const [commitments, awards, prefs] = await Promise.all([
      ctx.store.listCommitments(), ctx.store.listAwards(), ctx.store.getPrefs(),
    ]);
    const timeZone = ctx.zoneOf(prefs, ctx.requestTimeZone(req));
    const points = totalPoints(awards);
    ctx.reply(res, 200, {
      commitments: orderCommitments(commitments, now, timeZone)
        .map((commitment) => ({
          ...commitment, state: commitmentState(commitment, now, timeZone),
        })),
      points,
      stars: starsFrom(points),
      towardNextStar: towardNextStar(points),
      recentAwards: [...awards].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 8),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/outcome-context') {
    const [courses, commitments, topics] = await Promise.all([
      ctx.store.listCourses(), ctx.store.listCommitments(), ctx.store.listTopics(),
    ]);
    ctx.reply(res, 200, {
      courses: courses.filter((course) => !course.archivedAt)
        .map((course) => ({ id: course.id, title: course.title })),
      commitments: commitments.map((commitment) => ({
        id: commitment.id, title: commitment.title, courseId: commitment.courseId,
      })),
      topics: topics.filter((topic) => !topic.retiredByUser)
        .map((topic) => ({ id: topic.id, label: topic.label })),
    });
    return true;
  }

  return false;
}
