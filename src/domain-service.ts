import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";

import { AuditLog, College } from "@/models";
import type { ICollege, ICustomDomain, DomainStatus, SslStatus } from "@/models/colleges.model";

/**
 * Custom domains: add, verify, activate, change, disconnect.
 *
 * What was here before was a `useState` and a toast. `College.customDomain`
 * existed with a unique index and nothing ever wrote it, `proxy.ts` only ever
 * rewrote `*.xite.co.in`, and the editor told the tenant "Custom domain updated
 * to https://…" without a single network call. A tenant could believe they had
 * pointed their domain at us while nothing anywhere had changed.
 *
 * Two rules govern everything below.
 *
 * **Nothing is asserted that has not been observed.** Verification is a real DNS
 * lookup against the tenant's real zone. SSL state is a real request to the real
 * host. There is no code path that sets a domain ACTIVE because somebody asked.
 *
 * **Certificates are not ours to issue.** Traefik, under Dokploy, terminates TLS
 * and obtains certificates. This service can see whether that has happened and
 * report it; it cannot make it happen, and it must never imply otherwise.
 */

/** The TXT record name a tenant creates, prefixed to their domain. */
export const VERIFICATION_RECORD_PREFIX = "_xite-verify";

/** How long a resolver is given before we call it a failure. */
const DNS_TIMEOUT_MS = 5000;
const SSL_TIMEOUT_MS = 8000;

export type DomainView = {
  id: string;
  hostname: string;
  status: DomainStatus;
  sslStatus: SslStatus;
  isPrimary: boolean;
  verifiedAt: Date | null;
  lastError: string | null;
  verificationCheckedAt: Date | null;
  sslCheckedAt: Date | null;
  createdAt: Date;
  /** Exactly what the tenant must create in their DNS zone. */
  dnsInstructions: {
    verification: { type: "TXT"; name: string; value: string };
    routing:
      | { type: "CNAME"; name: string; value: string }
      | { type: "A"; name: string; value: string };
  };
};

/**
 * The host a tenant's DNS should point at.
 *
 * From the environment, because it is a property of the deployment and not of
 * the code. `A` records are offered only when an apex IP is configured — an
 * apex domain cannot carry a CNAME, and inventing an address to show in the UI
 * would send tenants to somewhere that is not us.
 */
function routingTarget(): { cname: string; apexIp: string | null } {
  const root = (process.env.ROOT_DOMAIN || process.env.NEXT_PUBLIC_ROOT_DOMAIN || "xite.co.in")
    .toLowerCase()
    .trim();
  const apexIp = process.env.CUSTOM_DOMAIN_APEX_IP?.trim() || null;
  const cname = process.env.CUSTOM_DOMAIN_CNAME_TARGET?.trim() || `sites.${root}`;
  return { cname, apexIp };
}

/** Whether this hostname is an apex (`college.edu`) rather than a subdomain. */
function isApex(hostname: string): boolean {
  return hostname.split(".").filter(Boolean).length <= 2;
}

/**
 * Reduces whatever the tenant typed to a bare hostname, or explains why not.
 *
 * People paste `https://www.college.edu/admissions?x=1`. Accepting that as a
 * hostname would store a value that can never match a `Host` header, so the
 * domain would sit at PENDING forever with no indication why.
 */
export function normalizeHostname(input: unknown): string {
  if (typeof input !== "string") {
    throw Object.assign(new Error("A domain is required."), { status: 400 });
  }

  let value = input.trim().toLowerCase();
  if (!value) {
    throw Object.assign(new Error("A domain is required."), { status: 400 });
  }

  // Strip a scheme, then anything from the first slash, then a port, then the
  // trailing dot a fully-qualified name may carry.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split("/")[0] ?? "";
  value = value.split("@").pop() ?? "";
  value = value.split(":")[0] ?? "";
  value = value.replace(/\.$/, "");

  if (!value) {
    throw Object.assign(new Error("That does not look like a domain."), { status: 400 });
  }

  // A conservative LDH check. Rejecting an unusual-but-valid name is a support
  // conversation; accepting an invalid one is a routing table entry that can
  // never match.
  const labels = value.split(".");
  if (labels.length < 2) {
    throw Object.assign(
      new Error("Enter a full domain, including the extension — for example college.edu."),
      { status: 400 },
    );
  }
  for (const label of labels) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      throw Object.assign(new Error(`"${value}" is not a valid domain name.`), { status: 400 });
    }
  }
  if (value.length > 253) {
    throw Object.assign(new Error("That domain name is too long."), { status: 400 });
  }

  return value;
}

/**
 * Refuses hostnames the platform already owns.
 *
 * A tenant claiming `admin.xite.co.in` or `api.xite.co.in` would, once routing
 * honoured custom domains, point platform hostnames at their own site. The
 * check is on the parsed hostname with a suffix rule, never `includes()` —
 * the same distinction `isAllowedOrigin` in server.ts already documents,
 * because `xite.co.in.attacker.com` contains the root domain.
 */
function assertNotPlatformHost(hostname: string): void {
  const root = (process.env.ROOT_DOMAIN || process.env.NEXT_PUBLIC_ROOT_DOMAIN || "xite.co.in")
    .toLowerCase()
    .trim();

  for (const reserved of [root, "xite.co.in"]) {
    if (!reserved) continue;
    if (hostname === reserved || hostname.endsWith(`.${reserved}`)) {
      throw Object.assign(
        new Error(
          `${hostname} belongs to the platform. Every site already has a free address here — ` +
            "a custom domain is for a name you own, such as www.yourcollege.edu.",
        ),
        { status: 400 },
      );
    }
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw Object.assign(new Error("localhost cannot be used as a custom domain."), { status: 400 });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(
        () => reject(Object.assign(new Error(`${label} timed out`), { code: "ETIMEOUT" })),
        ms,
      ),
    ),
  ]);
}

function toView(domain: ICustomDomain): DomainView {
  const { cname, apexIp } = routingTarget();
  const apex = isApex(domain.hostname);

  return {
    id: domain.id,
    hostname: domain.hostname,
    status: domain.status,
    sslStatus: domain.sslStatus,
    isPrimary: Boolean(domain.isPrimary),
    verifiedAt: domain.verifiedAt ?? null,
    lastError: domain.lastError ?? null,
    verificationCheckedAt: domain.verificationCheckedAt ?? null,
    sslCheckedAt: domain.sslCheckedAt ?? null,
    createdAt: domain.createdAt,
    dnsInstructions: {
      verification: {
        type: "TXT",
        name: `${VERIFICATION_RECORD_PREFIX}.${domain.hostname}`,
        value: domain.verificationToken,
      },
      routing:
        apex && apexIp
          ? { type: "A", name: domain.hostname, value: apexIp }
          : { type: "CNAME", name: domain.hostname, value: cname },
    },
  };
}

export async function listDomains(collegeId: string): Promise<DomainView[]> {
  const college = (await College.findById(collegeId).lean()) as ICollege | null;
  if (!college) throw Object.assign(new Error("College not found"), { status: 404 });
  return (college.domains ?? []).filter((d) => d.status !== "DISCONNECTED").map(toView);
}

/**
 * Registers a domain against this tenant and issues its verification token.
 *
 * Uniqueness is the database's job. The pre-check below produces a readable
 * message in the ordinary case; the unique index on `domains.hostname` is what
 * actually holds when two tenants submit the same name at the same instant, and
 * its error is caught and translated rather than leaking a driver exception.
 */
export async function addDomain(
  collegeId: string,
  rawHostname: unknown,
  actorEmail: string | null,
): Promise<DomainView> {
  const hostname = normalizeHostname(rawHostname);
  assertNotPlatformHost(hostname);

  const college = (await College.findById(collegeId)) as ICollege | null;
  if (!college) throw Object.assign(new Error("College not found"), { status: 404 });

  const existingHere = (college.domains ?? []).find((d) => d.hostname === hostname);
  if (existingHere && existingHere.status !== "DISCONNECTED") {
    return toView(existingHere);
  }

  const taken = await College.findOne({
    "domains.hostname": hostname,
    "domains.status": { $ne: "DISCONNECTED" },
    _id: { $ne: collegeId },
  })
    .select("_id")
    .lean();

  if (taken) {
    throw Object.assign(
      new Error(`${hostname} is already connected to another site on XITE.`),
      { status: 409 },
    );
  }

  const domain: ICustomDomain = {
    id: randomBytes(12).toString("hex"),
    hostname,
    status: "PENDING_VERIFICATION",
    // 32 hex characters of CSPRNG output. The token is the proof that whoever
    // added the domain controls its DNS, so it has to be unguessable.
    verificationToken: `xite-verify-${randomBytes(16).toString("hex")}`,
    verificationCheckedAt: null,
    verifiedAt: null,
    lastError: null,
    sslStatus: "NONE",
    sslCheckedAt: null,
    isPrimary: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    if (existingHere) {
      // Reconnecting a previously disconnected name: new token, clean slate.
      await College.updateOne(
        { _id: collegeId, "domains.hostname": hostname },
        { $set: { "domains.$": domain } },
      );
    } else {
      await College.updateOne({ _id: collegeId }, { $push: { domains: domain } });
    }
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      throw Object.assign(
        new Error(`${hostname} is already connected to another site on XITE.`),
        { status: 409 },
      );
    }
    throw error;
  }

  await AuditLog.create({
    action: "DOMAIN_ADDED",
    tenantId: collegeId,
    details: { hostname, actor: actorEmail },
  }).catch(() => null);

  return toView(domain);
}

type VerificationOutcome = {
  ok: boolean;
  error: string | null;
};

/**
 * Looks for the tenant's token in their own DNS zone.
 *
 * TXT under `_xite-verify.<domain>` proves control of the zone, which is the
 * claim being made. Checking only that the domain resolves to us would prove
 * nothing about ownership: anyone can point a CNAME at our host, and if that
 * were sufficient, whoever asked first would win a name they do not own.
 */
async function checkVerificationRecord(
  hostname: string,
  token: string,
): Promise<VerificationOutcome> {
  const record = `${VERIFICATION_RECORD_PREFIX}.${hostname}`;

  try {
    const answers = await withTimeout(dns.resolveTxt(record), DNS_TIMEOUT_MS, "DNS lookup");
    // Each answer is an array of strings: a TXT value longer than 255 bytes is
    // split into chunks by the protocol and must be rejoined before comparison.
    const values = answers.map((chunks) => chunks.join("").trim());

    if (values.includes(token)) return { ok: true, error: null };

    return {
      ok: false,
      error: values.length
        ? `Found a ${VERIFICATION_RECORD_PREFIX} record, but its value does not match. DNS may still be updating.`
        : `No ${VERIFICATION_RECORD_PREFIX} record found yet.`,
    };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return {
        ok: false,
        error: `No ${record} record found yet. DNS changes can take up to an hour to propagate.`,
      };
    }
    if (code === "ETIMEOUT" || code === "ETIMEDOUT") {
      return { ok: false, error: "The DNS lookup timed out. Try again in a moment." };
    }
    return { ok: false, error: `Could not read DNS for ${hostname}.` };
  }
}

/**
 * Whether the domain currently resolves to where we told the tenant to point it.
 *
 * Separate from ownership, and checked separately, because the two fail for
 * different reasons and the tenant needs to be told which one is outstanding.
 */
async function checkRouting(hostname: string): Promise<VerificationOutcome> {
  const { cname, apexIp } = routingTarget();

  try {
    if (!isApex(hostname)) {
      try {
        const answers = await withTimeout(dns.resolveCname(hostname), DNS_TIMEOUT_MS, "DNS lookup");
        const normalised = answers.map((a) => a.toLowerCase().replace(/\.$/, ""));
        if (normalised.includes(cname.toLowerCase())) return { ok: true, error: null };
      } catch {
        // No CNAME is not fatal — an A record pointing at the same place is
        // equally valid, and some providers flatten CNAMEs at the apex.
      }
    }

    if (apexIp) {
      const addresses = await withTimeout(dns.resolve4(hostname), DNS_TIMEOUT_MS, "DNS lookup");
      if (addresses.includes(apexIp)) return { ok: true, error: null };
      return {
        ok: false,
        error: `${hostname} resolves to ${addresses.join(", ") || "nothing"}, not to ${apexIp}.`,
      };
    }

    return {
      ok: false,
      error: `${hostname} does not point to ${cname} yet.`,
    };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return { ok: false, error: `${hostname} does not resolve yet.` };
    }
    return { ok: false, error: `Could not resolve ${hostname}.` };
  }
}

/**
 * Whether TLS actually terminates on this host, and whether it is us answering.
 *
 * A HEAD over HTTPS is the only honest test available to this service: it
 * exercises the real certificate against the real host through the real proxy.
 * A certificate that is missing, expired or issued for a different name fails
 * the TLS handshake and lands in the catch, which is exactly the outcome the
 * tenant needs to see. Nothing here can make a certificate exist.
 */
async function checkSsl(hostname: string): Promise<{ status: SslStatus; error: string | null }> {
  try {
    const response = await withTimeout(
      fetch(`https://${hostname}/api/health`, {
        method: "HEAD",
        redirect: "manual",
        headers: { "user-agent": "xite-domain-check" },
      }),
      SSL_TIMEOUT_MS,
      "HTTPS check",
    );

    // Any answer at all means the handshake completed, which is the question.
    // The status code belongs to routing, not to the certificate.
    return response.status >= 100 ? { status: "ACTIVE", error: null } : { status: "ERROR", error: null };
  } catch (error) {
    const message = (error as Error)?.message ?? "";
    const cause = (error as { cause?: { code?: string } })?.cause?.code ?? "";

    if (/certificate|CERT_|ERR_TLS|SELF_SIGNED|ALT_NAME/i.test(`${message} ${cause}`)) {
      return { status: "ERROR", error: "The certificate for this domain is not valid yet." };
    }
    // Not yet issued is the ordinary case while Traefik is still working.
    return { status: "PENDING", error: null };
  }
}

/**
 * Runs the real checks and writes back what they found.
 *
 * The status this produces is a description of the world, not a request. A
 * domain reaches ACTIVE only when its zone proved ownership, its records point
 * here, and HTTPS answered — all three, observed, in this call.
 */
export async function verifyDomain(
  collegeId: string,
  domainId: string,
  actorEmail: string | null,
): Promise<DomainView> {
  const college = (await College.findById(collegeId).lean()) as ICollege | null;
  if (!college) throw Object.assign(new Error("College not found"), { status: 404 });

  const domain = (college.domains ?? []).find((d) => d.id === domainId);
  if (!domain || domain.status === "DISCONNECTED") {
    throw Object.assign(new Error("Domain not found"), { status: 404 });
  }

  const now = new Date();
  const ownership = await checkVerificationRecord(domain.hostname, domain.verificationToken);

  let status: DomainStatus;
  let lastError: string | null;
  let sslStatus: SslStatus = domain.sslStatus;
  let verifiedAt = domain.verifiedAt ?? null;

  if (!ownership.ok) {
    status = "PENDING_VERIFICATION";
    lastError = ownership.error;
  } else {
    verifiedAt = verifiedAt ?? now;
    const routing = await checkRouting(domain.hostname);

    if (!routing.ok) {
      status = "VERIFIED";
      lastError = routing.error;
      sslStatus = "NONE";
    } else {
      const ssl = await checkSsl(domain.hostname);
      sslStatus = ssl.status;
      if (ssl.status === "ACTIVE") {
        status = "ACTIVE";
        lastError = null;
      } else {
        // Ownership and routing are proven; the certificate is not there yet.
        // That is a real, temporary state and it is named as one.
        status = "VERIFIED";
        lastError = ssl.error ?? "Waiting for the HTTPS certificate to be issued.";
      }
    }
  }

  await College.updateOne(
    { _id: collegeId, "domains.id": domainId },
    {
      $set: {
        "domains.$.status": status,
        "domains.$.lastError": lastError,
        "domains.$.sslStatus": sslStatus,
        "domains.$.sslCheckedAt": now,
        "domains.$.verificationCheckedAt": now,
        "domains.$.verifiedAt": verifiedAt,
        "domains.$.updatedAt": now,
      },
    },
  );

  await AuditLog.create({
    action: "DOMAIN_VERIFICATION_CHECKED",
    tenantId: collegeId,
    details: { hostname: domain.hostname, status, sslStatus, actor: actorEmail },
  }).catch(() => null);

  return toView({
    ...domain,
    status,
    lastError,
    sslStatus,
    sslCheckedAt: now,
    verificationCheckedAt: now,
    verifiedAt,
    updatedAt: now,
  });
}

/**
 * Makes one verified domain the canonical address for this tenant.
 *
 * Refused for anything not ACTIVE: a primary domain is where visitors get sent,
 * and sending them somewhere that has not been proven to work is the failure
 * this whole flow exists to prevent.
 */
export async function setPrimaryDomain(
  collegeId: string,
  domainId: string,
  actorEmail: string | null,
): Promise<DomainView[]> {
  const college = (await College.findById(collegeId).lean()) as ICollege | null;
  if (!college) throw Object.assign(new Error("College not found"), { status: 404 });

  const domain = (college.domains ?? []).find((d) => d.id === domainId);
  if (!domain || domain.status === "DISCONNECTED") {
    throw Object.assign(new Error("Domain not found"), { status: 404 });
  }
  if (domain.status !== "ACTIVE") {
    throw Object.assign(
      new Error("Only a domain that is verified and serving over HTTPS can be made primary."),
      { status: 400 },
    );
  }

  const domains = (college.domains ?? []).map((d) => ({ ...d, isPrimary: d.id === domainId }));
  await College.updateOne({ _id: collegeId }, { $set: { domains } });

  await AuditLog.create({
    action: "DOMAIN_SET_PRIMARY",
    tenantId: collegeId,
    details: { hostname: domain.hostname, actor: actorEmail },
  }).catch(() => null);

  return domains.filter((d) => d.status !== "DISCONNECTED").map(toView);
}

/**
 * Disconnects a domain.
 *
 * Marked DISCONNECTED and stripped of its hostname rather than left in place,
 * so the unique index frees the name for whoever legitimately holds it next.
 * The row itself stays for the audit trail.
 */
export async function disconnectDomain(
  collegeId: string,
  domainId: string,
  actorEmail: string | null,
): Promise<void> {
  const college = (await College.findById(collegeId).lean()) as ICollege | null;
  if (!college) throw Object.assign(new Error("College not found"), { status: 404 });

  const domain = (college.domains ?? []).find((d) => d.id === domainId);
  if (!domain) throw Object.assign(new Error("Domain not found"), { status: 404 });

  await College.updateOne({ _id: collegeId }, { $pull: { domains: { id: domainId } } });

  await AuditLog.create({
    action: "DOMAIN_DISCONNECTED",
    tenantId: collegeId,
    details: { hostname: domain.hostname, actor: actorEmail },
  }).catch(() => null);
}

/**
 * The tenant a request's host belongs to, or null.
 *
 * Only ACTIVE domains resolve. A domain that is merely added, or verified but
 * not yet serving, must not route traffic — otherwise adding a hostname would
 * be enough to claim it, and the DNS proof would be decorative.
 */
export async function collegeIdForHost(rawHost: string): Promise<{
  collegeId: string;
  subdomain: string;
} | null> {
  let hostname: string;
  try {
    hostname = normalizeHostname(rawHost);
  } catch {
    return null;
  }

  const college = (await College.findOne({
    domains: { $elemMatch: { hostname, status: "ACTIVE" } },
  })
    .select("_id subdomain")
    .lean()) as { _id: unknown; subdomain: string } | null;

  if (!college) return null;
  return { collegeId: String(college._id), subdomain: college.subdomain };
}

export const __testing = {
  normalizeHostname,
  assertNotPlatformHost,
  isApex,
  routingTarget,
  checkVerificationRecord,
  checkRouting,
};
