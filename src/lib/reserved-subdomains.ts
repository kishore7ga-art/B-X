/**
 * Subdomains the platform keeps for itself, and never allocates to a tenant.
 *
 * This became load-bearing when the apex moved to the landing site and the
 * editor took `app.webxite.org`. Before that there was no wildcard DNS record
 * at all, so `<tenant>.webxite.org` resolved nowhere and a tenant allocated the
 * name `app` was a curiosity. With `*.webxite.org` resolving, it is a site
 * whose own address belongs to something else.
 *
 * It is not a security control — routing already refuses these. xite-F's
 * `platformSubdomainOf` returns null for every label here, and Traefik matches
 * the exact host rule ahead of the wildcard either way, so a tenant named `api`
 * could never have been served in place of the API. What this prevents is
 * quieter and more likely: handing somebody a share link to an address that
 * belongs to the platform and will never render their site.
 *
 * Kept in step with RESERVED_LABELS in xite-F's src/lib/host-routing.ts. The
 * two are deliberately separate files rather than a mirrored one — this list
 * decides what may be *allocated*, that one decides what may be *routed*, and
 * a name can be withdrawn from allocation long before routing forgets it.
 */
const RESERVED = new Set([
  "admin",
  "api",
  "app",
  "assets",
  "mail",
  "static",
  "www",
]);

/** Whether a tenant may be given this subdomain. */
export function isReservedSubdomain(subdomain: string): boolean {
  return RESERVED.has(subdomain.trim().toLowerCase());
}
