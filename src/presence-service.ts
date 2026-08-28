/**
 * Who is actually using the platform right now.
 *
 * ── What "live" means here, precisely ──────────────────────────────────────
 *
 * A user whose session made an authenticated request to this API within the
 * last `LIVE_WINDOW_SECONDS`. Not "has an account", not "has an unexpired
 * cookie" — a session token is valid for a week, so counting those would report
 * everyone who signed in since last Tuesday as being on the site.
 *
 * The admin dashboard previously had no such number at all, and the closest
 * thing to it — `adminOverview().users` — was the total count of every
 * embedded user document on every college. That is a useful figure and it is
 * still reported, as `total`. It is not a measure of activity, and labelling it
 * one is how a dashboard ends up lying quietly for months.
 *
 * ── Why the write is throttled ─────────────────────────────────────────────
 *
 * Presence is recorded from middleware that runs on every authenticated
 * request. Writing on each one would put a database write in front of every
 * read in the product — the editor alone autosaves every two seconds per dirty
 * page — for a figure that is only ever read at minute resolution.
 *
 * So each user is written at most once per `WRITE_THROTTLE_MS`, tracked in
 * memory. The consequence is bounded and worth stating: presence can be up to
 * that interval stale, and a process restart forgets the throttle and lets one
 * extra write through per active user. Both are acceptable for a number
 * rendered as "12 active now".
 *
 * The throttle map is per-process, like the rate limiter above it. A second
 * replica keeps its own, which means at most one extra write per user per
 * replica per interval — not a correctness problem, because the write is an
 * idempotent `$set` of a timestamp.
 */

import { College } from "@/models";

/**
 * How recently a session must have been used to count as live.
 *
 * Five minutes. Long enough that somebody reading a page rather than clicking
 * through one does not blink out of the count, short enough that the number
 * means "now" rather than "this afternoon".
 */
export const LIVE_WINDOW_SECONDS = 5 * 60;

/** At most one presence write per user per minute. See the note above. */
const WRITE_THROTTLE_MS = 60_000;

/**
 * userId -> when we last wrote a timestamp for them.
 *
 * Bounded by pruning on write rather than left to grow: this is keyed by user
 * id on a long-lived process, and an unbounded map keyed by anything a caller
 * influences is a slow leak. Entries older than the throttle window can never
 * suppress a write, so they are dead weight by definition.
 */
const lastWrite = new Map<string, number>();

function prune(now: number): void {
  if (lastWrite.size < 1000) return;
  for (const [userId, at] of lastWrite) {
    if (now - at > WRITE_THROTTLE_MS) lastWrite.delete(userId);
  }
}

/**
 * Records that this session is in use, at most once a minute per user.
 *
 * Deliberately swallows its own errors and never awaits anything the caller
 * depends on. This runs in middleware ahead of every route: a presence write
 * that failed, or that was slow, must not turn a working request into a broken
 * one. A dashboard number is not worth an outage.
 */
export async function touchPresence(session: {
  userId: string;
  collegeId: string;
}): Promise<void> {
  // Open-access sessions are synthetic — nobody signed in for one, and there is
  // no embedded user row to write against.
  if (session.userId.startsWith("open-access:")) return;

  const now = Date.now();
  const previous = lastWrite.get(session.userId);
  if (previous !== undefined && now - previous < WRITE_THROTTLE_MS) return;

  lastWrite.set(session.userId, now);
  prune(now);

  try {
    await College.updateOne(
      { _id: session.collegeId, "users.id": session.userId },
      { $set: { "users.$.lastSeenAt": new Date(now) } },
    );
  } catch (error) {
    // Roll the throttle back so the next request retries rather than waiting
    // out a minute on a write that never landed.
    lastWrite.delete(session.userId);
    console.error("[presence] could not record activity:", (error as Error).message);
  }
}

export type PresenceCounts = {
  /** Every user account on every non-demo college. */
  total: number;
  /** Of those, the ones seen inside the live window. */
  live: number;
  /** How long a session counts as live, so the UI can say so rather than guess. */
  windowSeconds: number;
};

/**
 * Both figures in one pass.
 *
 * An aggregation rather than two `find()`s and a count in JavaScript: users are
 * embedded in the college document, and a college document carries two complete
 * website configs made of raw section HTML. Fetching every one of them to count
 * an array length is the single most expensive way to answer this, and it is
 * what `adminOverview` did — `College.find({ isDemo: false }).select("users")`
 * over the whole collection, on every dashboard load.
 */
export async function presenceCounts(): Promise<PresenceCounts> {
  const cutoff = new Date(Date.now() - LIVE_WINDOW_SECONDS * 1000);

  const [row] = await College.aggregate<{ total: number; live: number }>([
    { $match: { isDemo: false } },
    { $project: { users: { $ifNull: ["$users", []] } } },
    { $unwind: "$users" },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        live: {
          $sum: {
            $cond: [{ $gt: ["$users.lastSeenAt", cutoff] }, 1, 0],
          },
        },
      },
    },
  ]);

  return {
    total: row?.total ?? 0,
    live: row?.live ?? 0,
    windowSeconds: LIVE_WINDOW_SECONDS,
  };
}
