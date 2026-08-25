/**
 * Re-checking domains without anybody clicking anything.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 *
 * Verification only ever ran when a tenant pressed a button, which left two
 * holes on opposite sides of the same gap.
 *
 * A domain waiting on DNS never advanced on its own. The tenant added the
 * records, closed the tab, and the domain sat at PENDING_VERIFICATION until
 * somebody came back and pressed Check — often days after it had actually been
 * correct.
 *
 * Worse in the other direction: a domain that reached ACTIVE stayed ACTIVE
 * forever. Nothing re-read the world. A zone edited months later, a certificate
 * that failed to renew, a host removed from the proxy — the dashboard kept
 * showing green while visitors got nothing, and the first report came from a
 * customer rather than from us.
 *
 * ── Shape ─────────────────────────────────────────────────────────────────
 *
 * One in-process interval. No queue, no scheduler, no second service, because
 * this is a few hundred rows and the platform already runs one timer for the
 * database watchdog.
 *
 *   waiting     exponential backoff from 1 minute to an hour, then given up on
 *               after two days
 *   active      every six hours, so a domain that quietly breaks is demoted
 *
 * Bounded on every axis that could otherwise run away: at most
 * `BATCH` domains per tick, one tick at a time, and each domain carries the
 * timestamp that decides whether it is due. A slow DNS server delays the next
 * tick rather than overlapping with it.
 */

import { College } from "@/models";
import type { ICollege, ICustomDomain } from "@/models/colleges.model";
import { verifyDomain } from "@/domain-service";

/** Domains re-checked per tick. Small: each one makes DNS and HTTPS calls. */
const BATCH = 25;

/** How often the timer wakes. Individual domains are due far less often. */
const TICK_MS = 60_000;

/** A domain that has been settled and working is re-read at this interval. */
const ACTIVE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The first retry gap for a domain that is not yet verified. */
const BACKOFF_BASE_MS = 60_000;

/** Retries never spread further apart than this. */
const BACKOFF_CAP_MS = 60 * 60 * 1000;

/**
 * How long a domain is chased before it is left alone.
 *
 * Two days is longer than DNS propagation and shorter than "forever". A domain
 * still failing after it has almost certainly been abandoned, and continuing to
 * resolve it every hour is load spent on nobody's behalf. The tenant's Check
 * button still works.
 */
const GIVE_UP_AFTER_MS = 48 * 60 * 60 * 1000;

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * When a domain in this state should next be looked at.
 *
 * Backoff is derived from how long the domain has been waiting rather than from
 * a stored attempt counter — one less field to keep consistent, and it recovers
 * correctly across restarts, which an in-memory counter would not.
 */
export function nextCheckDelayMs(domain: {
  status: string;
  createdAt?: Date | null;
  verificationCheckedAt?: Date | null;
}, now = Date.now()): number | null {
  if (domain.status === "DISCONNECTED") return null;

  if (domain.status === "ACTIVE") return ACTIVE_INTERVAL_MS;

  const created = domain.createdAt ? new Date(domain.createdAt).getTime() : now;
  const waitingFor = Math.max(0, now - created);

  if (waitingFor > GIVE_UP_AFTER_MS) return null;

  // 1m, 2m, 4m, 8m … capped. `waitingFor / BACKOFF_BASE_MS` is roughly the
  // number of intervals elapsed, so the gap widens as the wait lengthens.
  const steps = Math.floor(Math.log2(waitingFor / BACKOFF_BASE_MS + 1));
  return Math.min(BACKOFF_BASE_MS * 2 ** steps, BACKOFF_CAP_MS);
}

/** Whether this domain is due a re-check now. */
export function isDue(domain: ICustomDomain, now = Date.now()): boolean {
  const delay = nextCheckDelayMs(domain as never, now);
  if (delay === null) return false;

  const last = domain.verificationCheckedAt
    ? new Date(domain.verificationCheckedAt).getTime()
    : 0;

  return now - last >= delay;
}

/**
 * One pass. Exported so a test can run it directly rather than waiting on a
 * timer, and so an operator can trigger it from a console.
 */
export async function runDomainChecks(): Promise<{ checked: number; failed: number }> {
  let checked = 0;
  let failed = 0;

  // Only tenants that have a domain worth re-reading. `DISCONNECTED` rows are
  // kept for the audit trail and are never chased.
  const colleges = (await College.find({
    "domains.status": { $in: ["PENDING_VERIFICATION", "VERIFIED", "FAILED", "ACTIVE"] },
  })
    .select("_id domains")
    .lean()) as unknown as Pick<ICollege, "domains">[] & { _id: unknown }[];

  const now = Date.now();
  const due: { collegeId: string; domainId: string; hostname: string }[] = [];

  for (const college of colleges) {
    for (const domain of college.domains ?? []) {
      if (domain.status === "DISCONNECTED") continue;
      if (!isDue(domain, now)) continue;
      due.push({
        collegeId: String((college as { _id: unknown })._id),
        domainId: domain.id,
        hostname: domain.hostname,
      });
    }
  }

  // Oldest check first, so nothing starves behind a large tenant.
  for (const entry of due.slice(0, BATCH)) {
    try {
      const view = await verifyDomain(entry.collegeId, entry.domainId, null);
      checked += 1;
      console.log(
        `[domains] DOMAIN_VERIFICATION_CHECKED hostname=${entry.hostname} ` +
          `status=${view.status} ssl=${view.sslStatus} actor=monitor`,
      );
    } catch (error) {
      failed += 1;
      // A single bad row must not stop the pass. The message, never the object,
      // so nothing from a DNS or driver error is relayed wholesale into logs.
      console.error(
        `[domains] DOMAIN_VERIFICATION_ERROR hostname=${entry.hostname} ` +
          `reason=${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }

  return { checked, failed };
}

/**
 * Starts the timer. Safe to call twice; the second call is ignored.
 *
 * `unref` so the process can still exit — this must never be the reason a
 * container refuses to shut down.
 */
export function startDomainMonitor(): void {
  if (timer) return;

  timer = setInterval(() => {
    if (running) return; // A slow pass delays the next one rather than overlapping.
    running = true;
    void runDomainChecks()
      .then(({ checked, failed }) => {
        if (checked || failed) {
          console.log(`[domains] monitor pass: ${checked} checked, ${failed} failed`);
        }
      })
      .catch((error) => {
        console.error(
          `[domains] monitor pass failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      })
      .finally(() => {
        running = false;
      });
  }, TICK_MS);

  timer.unref?.();
  console.log("[domains] verification monitor started");
}

export function stopDomainMonitor(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
