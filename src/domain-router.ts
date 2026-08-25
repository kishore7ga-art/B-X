/**
 * Telling the edge to serve a custom hostname.
 *
 * ── The gap this names ─────────────────────────────────────────────────────
 *
 * Verification proves three things about a domain: the tenant controls the
 * zone, the records point here, and HTTPS answers. None of them makes the
 * reverse proxy *route* the hostname. Nothing in this repository ever did —
 * there is no Traefik configuration, no Dokploy call, no label generation. The
 * domain rows recorded ACTIVE and a human had, separately and by hand, to add
 * the host in Dokploy for the site to actually serve.
 *
 * When nobody did, verification still passed — DNS was correct, and the TLS
 * check answered from the platform's wildcard certificate — and the tenant saw
 * a green domain that returned 502. The product had no way to say "the DNS is
 * right and the edge is not carrying this host yet", because nothing modelled
 * the edge at all.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 *
 * The seam, and an honest default. `ensure()` and `remove()` describe what the
 * edge must be told; the implementation is chosen from the environment. With no
 * edge configured the router answers `NOT_CONFIGURED`, and that answer is
 * carried into the domain's status note so the operator reads the truth instead
 * of a green tick.
 *
 * Deliberately not a provider framework. One implementation, one interface, and
 * a default that admits it does nothing — the alternative was a plugin
 * architecture for a platform that has exactly one edge.
 */

export type RoutingOutcome =
  | { state: "ROUTED"; detail: string | null }
  /** No edge is configured, so nothing was asked to route this host. */
  | { state: "NOT_CONFIGURED"; detail: string }
  /** An edge is configured and refused, or could not be reached. */
  | { state: "FAILED"; detail: string };

export interface DomainRouter {
  /** The name of the edge, for logs and the admin screen. */
  readonly name: string;
  /** Ask the edge to serve `hostname`. Must be safe to call repeatedly. */
  ensure(hostname: string): Promise<RoutingOutcome>;
  /** Ask the edge to stop serving `hostname`. Must tolerate "already gone". */
  remove(hostname: string): Promise<RoutingOutcome>;
}

/**
 * What runs when no edge is configured.
 *
 * It does nothing and says so. That is the whole point: the previous behaviour
 * was to do nothing and say nothing, which is indistinguishable from success
 * until a visitor gets a 502.
 */
const unconfiguredRouter: DomainRouter = {
  name: "none",
  async ensure(hostname) {
    return {
      state: "NOT_CONFIGURED",
      detail:
        `DNS for ${hostname} is correct, but no edge is configured to serve it. ` +
        "Add the host to the reverse proxy, or set DOKPLOY_API_URL and " +
        "DOKPLOY_API_TOKEN so this service can do it.",
    };
  },
  async remove() {
    return { state: "NOT_CONFIGURED", detail: "No edge is configured." };
  },
};

/**
 * The Dokploy edge.
 *
 * Behind environment variables and off by default, because this code has never
 * run against a live Dokploy instance — there is no token in the workspace it
 * was written in. Shipping it enabled would be shipping infrastructure code
 * that has been typechecked and never executed, on the path that decides
 * whether a tenant's site is reachable.
 *
 * Wire it deliberately: set both variables in the API's environment, add one
 * domain, and read the `DOMAIN_ROUTING_*` log line before trusting it.
 */
function dokployRouter(apiUrl: string, token: string, applicationId: string): DomainRouter {
  const base = apiUrl.replace(/\/+$/, "");

  const call = async (path: string, body: unknown): Promise<RoutingOutcome> => {
    try {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Dokploy accepts an API key in this header. Never logged.
          "x-api-key": token,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) return { state: "ROUTED", detail: null };

      // The edge's own message, without the response body, which can carry
      // configuration this service has no business relaying to a tenant.
      return { state: "FAILED", detail: `The edge refused the request (${response.status}).` };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      return { state: "FAILED", detail: `Could not reach the edge: ${reason}` };
    }
  };

  return {
    name: "dokploy",
    ensure: (hostname) =>
      call("/api/domain.create", {
        applicationId,
        host: hostname,
        https: true,
        certificateType: "letsencrypt",
        path: "/",
        port: 3000,
      }),
    remove: (hostname) => call("/api/domain.delete", { applicationId, host: hostname }),
  };
}

let cached: DomainRouter | null = null;

/**
 * The configured edge, or the one that admits it is not configured.
 *
 * Resolved once. Changing the environment requires a restart, which is true of
 * every other secret this service reads and keeps the router from changing
 * underneath an in-flight verification.
 */
export function domainRouter(): DomainRouter {
  if (cached) return cached;

  const apiUrl = process.env.DOKPLOY_API_URL?.trim();
  const token = process.env.DOKPLOY_API_TOKEN?.trim();
  const applicationId = process.env.DOKPLOY_APPLICATION_ID?.trim();

  if (apiUrl && token && applicationId) {
    console.log("[domains] edge routing: dokploy");
    cached = dokployRouter(apiUrl, token, applicationId);
  } else {
    console.warn(
      "[domains] edge routing is not configured. Custom domains will verify but " +
        "will not be served until the host is added to the reverse proxy by hand. " +
        "Set DOKPLOY_API_URL, DOKPLOY_API_TOKEN and DOKPLOY_APPLICATION_ID to automate it.",
    );
    cached = unconfiguredRouter;
  }

  return cached;
}

/** For tests, which must not inherit a router decided by the environment. */
export function __setDomainRouter(router: DomainRouter | null): void {
  cached = router;
}
