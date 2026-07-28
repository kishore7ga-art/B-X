/**
 * Where the session cookie is scoped — decided the same way by both services.
 *
 * The backend issues the session and the frontend reads it on every guarded
 * render, so the two have to agree on the cookie's `Domain` down to the leading
 * dot. They used to agree only by both reading `SESSION_COOKIE_DOMAIN` and
 * hoping an operator had set it in two dashboards. When it was missing the
 * cookie came back scoped to the API's own host, the frontend never saw it, and
 * sign-in returned 200 and left you signed out — with nothing in either log to
 * say so, because from each service's point of view nothing had gone wrong.
 *
 * So it is derived instead. Both services already know the two hostnames
 * involved — the backend from CORS_ORIGINS, the frontend from APP_URL and
 * NEXT_PUBLIC_API_BASE_URL — and those are not optional: CORS fails loudly
 * without them. Deriving from configuration that is already load-bearing turns
 * a silent misconfiguration into no configuration at all.
 *
 * `SESSION_COOKIE_DOMAIN` still wins when set, for a topology this cannot infer.
 */

export type CookieScope =
  | { domain: string; source: "configured" | "derived" }
  | { domain: undefined; source: "host-only"; reason: string };

/**
 * `https://api.xite.co.in/`, `api.xite.co.in:443`, `[::1]:3000` -> the hostname.
 *
 * Takes a full origin or a bare `Host` header, because the callers have one of
 * each and the difference is not interesting here.
 */
export function hostFromOrigin(
  value: string | undefined | null,
): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  try {
    // A scheme is added when absent purely so one parser handles both shapes;
    // it also gets IPv6 bracketing right, which hand-splitting on ":" does not.
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    // A trailing dot is the same name to DNS but a different string to a cookie.
    return url.hostname.toLowerCase().replace(/\.$/, "") || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hosts that cannot carry a `Domain` at all.
 *
 * Browsers reject it for IP literals, and `Domain=localhost` is either dropped
 * or inconsistently honoured. A single-label name is a container on a Docker
 * network, where there is no parent domain to share in the first place.
 */
function cannotCarryDomain(host: string): boolean {
  if (host === "localhost") return true;
  if (host.startsWith("[")) return true; // IPv6 literal
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true; // IPv4
  return !host.includes(".");
}

/**
 * The `Domain` both services should write, given who they are.
 *
 * Only a strict parent/subdomain pair is inferred — `xite.co.in` serving the
 * app and `api.xite.co.in` serving this, which is the shape a split deployment
 * actually takes. Two sibling subdomains share a parent too, but naming it
 * safely means knowing where the registrable domain ends, and guessing that
 * without the Public Suffix List is how you end up asking a browser for
 * `Domain=.co.in` and having the cookie silently dropped. Those say so and ask
 * for SESSION_COOKIE_DOMAIN rather than guessing.
 */
export function sessionCookieScope(input: {
  configured?: string | null;
  frontendHost?: string;
  apiHost?: string;
}): CookieScope {
  const configured = input.configured?.trim();
  if (configured) return { domain: configured, source: "configured" };

  const { frontendHost: frontend, apiHost: api } = input;

  if (!frontend || !api) {
    return {
      domain: undefined,
      source: "host-only",
      reason: !frontend
        ? "the frontend's hostname is not configured"
        : "this service's own hostname could not be determined",
    };
  }

  // One service, or two names for it. A Domain would be redundant, and the
  // cookie already reaches everything that needs it.
  if (frontend === api) {
    return {
      domain: undefined,
      source: "host-only",
      reason: `frontend and API share one host (${frontend})`,
    };
  }

  if (cannotCarryDomain(frontend)) {
    return {
      domain: undefined,
      source: "host-only",
      reason: `${frontend} cannot carry a Domain attribute`,
    };
  }

  if (!api.endsWith(`.${frontend}`)) {
    return {
      domain: undefined,
      source: "host-only",
      reason:
        `${api} is not a subdomain of ${frontend} — set SESSION_COOKIE_DOMAIN ` +
        "to the parent domain they share, or the session cookie will not reach both",
    };
  }

  return { domain: `.${frontend}`, source: "derived" };
}
