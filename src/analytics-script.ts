/**
 * The tracking script, as a string served to tenant sites.
 *
 * Kept here rather than as a file under `public/` for one reason: the endpoint
 * it posts to has to match this service's own mount path, and a static file
 * cannot know it. It is served with a long cache lifetime and an ETag, so the
 * cost to a visitor is one conditional request.
 *
 * Constraints it is written to, all of which come from running inside somebody
 * else's page:
 *
 *  - **Never block the page.** No synchronous work on load, no layout reads in
 *    a scroll handler. The scroll listener is passive and throttled through
 *    `requestAnimationFrame`.
 *  - **Never throw into the host page.** Everything is inside one try/catch. A
 *    tracking script that breaks a tenant's site is worse than no analytics.
 *  - **Survive the tab closing.** The last beacon is the one that carries the
 *    final scroll depth, and it is sent on `visibilitychange`, not `unload` —
 *    mobile browsers frequently never fire `unload` at all.
 *  - **Send no personal data.** A path, a depth, a duration. No query string,
 *    no referrer chain, no fingerprinting. The visitor hash is computed
 *    server-side and never exists in the browser.
 */
export function trackingScript(apiBase: string): string {
  return `/* WebXite analytics. Anonymous: path, scroll depth, visible time. */
(function () {
  "use strict";
  try {
    var API = ${JSON.stringify(apiBase)} + "/api/v1/telemetry";
    var KEY = "wx_s";
    var host = location.hostname;
    var path = location.pathname;

    /* The session id lives in sessionStorage, so it lasts a tab and not a
       device. A returning visitor tomorrow is a new session, which is what a
       session is. Storage can throw in private mode; that is not fatal. */
    var sid = null;
    try { sid = sessionStorage.getItem(KEY); } catch (e) {}

    var maxDepth = 0;
    var visibleMs = 0;
    var lastResume = document.visibilityState === "visible" ? Date.now() : 0;
    var sentDepth = -1;
    var queued = false;

    function depth() {
      var doc = document.documentElement;
      var body = document.body;
      var scrollTop = window.pageYOffset || doc.scrollTop || 0;
      var viewport = window.innerHeight || doc.clientHeight || 0;
      var total = Math.max(
        doc.scrollHeight || 0, body ? body.scrollHeight : 0,
        doc.offsetHeight || 0, body ? body.offsetHeight : 0
      );
      /* A page shorter than the viewport has been seen in full the moment it
         renders. Reporting 0% for it would put every short page at the bottom
         of the funnel for a reason that has nothing to do with the reader. */
      if (total <= viewport) return 100;
      var pct = ((scrollTop + viewport) / total) * 100;
      return Math.max(0, Math.min(100, Math.round(pct)));
    }

    function accrue() {
      if (lastResume) { visibleMs += Date.now() - lastResume; lastResume = 0; }
    }

    function send(useBeacon) {
      accrue();
      if (document.visibilityState === "visible") lastResume = Date.now();

      var payload = JSON.stringify({
        h: host, p: path, s: sid, d: maxDepth,
        t: Math.round(visibleMs / 1000)
      });
      sentDepth = maxDepth;

      /* sendBeacon survives the page going away; fetch does not reliably. It
         is unavailable in a few environments, hence the fallback. */
      if (useBeacon && navigator.sendBeacon) {
        try {
          navigator.sendBeacon(API, new Blob([payload], { type: "application/json" }));
          return;
        } catch (e) {}
      }
      fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
        credentials: "omit"
      })
        .then(function (r) { return r.ok ? r.json().catch(function () { return null; }) : null; })
        .then(function (data) {
          if (data && data.s && data.s !== sid) {
            sid = data.s;
            try { sessionStorage.setItem(KEY, sid); } catch (e) {}
          }
        })
        .catch(function () {});
    }

    /* Milestones rather than every pixel: four beacons per page view at most,
       instead of one per scroll event. */
    var MILESTONES = [25, 50, 75, 100];
    function onScroll() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        var d = depth();
        if (d <= maxDepth) return;
        maxDepth = d;
        for (var i = 0; i < MILESTONES.length; i++) {
          if (maxDepth >= MILESTONES[i] && sentDepth < MILESTONES[i]) { send(false); return; }
        }
      });
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") {
        send(true);
      } else {
        lastResume = Date.now();
      }
    });

    /* pagehide covers the back/forward cache, where visibilitychange alone can
       miss the final state on Safari. */
    window.addEventListener("pagehide", function () { send(true); });

    /* The opening beacon. Deferred out of the critical path so it cannot
       compete with the page's own resources. */
    if (window.requestIdleCallback) requestIdleCallback(function () { send(false); }, { timeout: 2000 });
    else setTimeout(function () { send(false); }, 300);

    maxDepth = depth();
  } catch (e) {
    /* Silent by design. A tenant's visitors must never see a console full of
       errors from a script they did not ask for. */
  }
})();
`;
}
