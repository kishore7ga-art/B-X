/**
 * Whether a hostname a tenant supplied may be connected to.
 *
 * ── The hole this closes ───────────────────────────────────────────────────
 *
 * Domain verification has to make a real HTTPS request to the tenant's
 * hostname — it is the only honest way to know whether TLS terminates there.
 * That means a request to an address a tenant chose, from inside our network,
 * which is the textbook shape of a Server-Side Request Forgery.
 *
 * `normalizeHostname` validates the *syntax* of a name and `assertNotPlatformHost`
 * refuses names we own. Neither looks at where the name resolves, and resolution
 * is the part an attacker controls: nothing stops `evil.example` having an A
 * record pointing at `169.254.169.254`, at `10.0.0.5`, or at the address of a
 * database that only listens on the private network.
 *
 * The check was also weaker than it looks against literals. `127.0.0.1` passes
 * an LDH label test — four labels, each `[a-z0-9]` — so it survives
 * normalisation and arrives here as an ordinary "domain".
 *
 * ── What it does ───────────────────────────────────────────────────────────
 *
 * Resolves the name and refuses if *any* address it answers with is not
 * publicly routable. Any, not all: a name with one public and one private
 * address is a DNS-rebinding attempt, and treating it as public is how the
 * private one gets connected to on the retry.
 *
 * This cannot close the rebinding window completely — between our resolution
 * and the socket's own, a short-TTL record can change. Node's fetch gives no
 * hook to pin the resolved address, so the residual risk is stated rather than
 * papered over: a blind HEAD, no body returned to the caller, and a hard
 * timeout. What it does remove is the entire class of *static* private targets,
 * which is every practical version of this attack.
 */

import dns from "node:dns/promises";
import net from "node:net";

export type AddressCheck =
  | { allowed: true; addresses: string[] }
  | { allowed: false; reason: string };

/**
 * Ranges that must never be reached from a tenant-supplied name.
 *
 * Written as predicates over the parsed address rather than as string prefixes:
 * `"10."` also matches `100.64.0.1`, and `"127."` misses `0177.0.0.1`.
 */
function isPublicIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return false; // "this network"
  if (a === 10) return false; // RFC1918
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local — cloud metadata lives here
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 192 && b === 0) return false; // IETF protocol assignments, incl. 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51) return false; // TEST-NET-2
  if (a === 203 && b === 0) return false; // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a >= 224) return false; // multicast, reserved, broadcast

  return true;
}

function isPublicIPv6(address: string): boolean {
  const value = address.toLowerCase().split("%")[0] ?? "";

  if (value === "::" || value === "::1") return false; // unspecified, loopback
  if (value.startsWith("fe80")) return false; // link-local
  if (/^f[cd]/.test(value)) return false; // unique local, fc00::/7
  if (value.startsWith("ff")) return false; // multicast

  // IPv4-mapped and IPv4-compatible: ::ffff:10.0.0.1 reaches the private v4
  // address, so it is judged by the v4 rules rather than waved through.
  const mapped = value.match(/(?:^::ffff:|^::)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (mapped?.[1]) return isPublicIPv4(mapped[1]);

  return true;
}

/** Whether one resolved address is on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPublicIPv4(address);
  if (family === 6) return isPublicIPv6(address);
  return false;
}

/**
 * Resolves `hostname` and reports whether every address it answers with is
 * publicly routable.
 *
 * A name that does not resolve is refused rather than allowed — there is
 * nothing to connect to, and "we could not tell" must not read as "safe".
 */
export async function resolvesToPublicAddress(
  hostname: string,
  timeoutMs = 5000,
): Promise<AddressCheck> {
  // A literal that survived hostname validation. `127.0.0.1` passes an LDH
  // label check, so this is a real path rather than a defensive flourish.
  if (net.isIP(hostname)) {
    return isPublicAddress(hostname)
      ? { allowed: true, addresses: [hostname] }
      : { allowed: false, reason: `${hostname} is not a public address.` };
  }

  let addresses: string[];
  try {
    const answers = await Promise.race([
      dns.lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("DNS lookup timed out")), timeoutMs),
      ),
    ]);
    addresses = answers.map((entry) => entry.address);
  } catch {
    return { allowed: false, reason: `${hostname} does not resolve.` };
  }

  if (addresses.length === 0) {
    return { allowed: false, reason: `${hostname} does not resolve.` };
  }

  // Any, not all. One public and one private address is a rebinding attempt,
  // and calling that "public" is how the private one gets connected to.
  const offending = addresses.find((address) => !isPublicAddress(address));
  if (offending) {
    return {
      allowed: false,
      reason: `${hostname} resolves to ${offending}, which is not a public address.`,
    };
  }

  return { allowed: true, addresses };
}
