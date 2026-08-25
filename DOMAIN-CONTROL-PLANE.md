# Domains, DNS, SSL and routing

How a tenant's site gets an address, what verification actually proves, and the
one thing an operator has to wire before custom domains work at all.

---

## Read this first

**A custom domain will verify and still not be served until the edge is
configured.**

Verification proves three things: the tenant controls the zone, the records
point here, and HTTPS answers. **None of them makes the reverse proxy route the
hostname.** Nothing in this repository did, until `domain-router.ts`, and its
default implementation deliberately does nothing.

So on a deployment with no edge configured, the API logs this at boot:

```
[domains] edge routing is not configured. Custom domains will verify but will
not be served until the host is added to the reverse proxy by hand. Set
DOKPLOY_API_URL, DOKPLOY_API_TOKEN and DOKPLOY_APPLICATION_ID to automate it.
```

and every custom domain stops at `VERIFIED` with that sentence as its
`lastError`, rather than claiming `ACTIVE`.

That is the honest state, and it is a change: previously such a domain reached
`ACTIVE` and returned 502 to every visitor, with a green tick and nothing
anywhere explaining why. TLS answers from the platform's wildcard certificate
whether or not the proxy knows that particular hostname, so the TLS check alone
could never tell the difference.

**To make custom domains serve:** either add each host to the reverse proxy by
hand, or set the three variables below and let this service do it.

---

## 1. Two kinds of address

| | Platform subdomain | Custom domain |
| :--- | :--- | :--- |
| Example | `stanford.webxite.org` | `www.mycollege.edu` |
| Set up | automatically, at signup | by the tenant, in Settings › Domains |
| DNS | the platform's own wildcard | the tenant's own zone |
| Verification | none needed | TXT ownership + records + TLS |

A tenant's platform subdomain never goes away. Adding a custom domain is an
addition, not a replacement, and the UI says so.

---

## 2. What a tenant is asked to do

Two records. The first proves they control the zone; the second points it here.

```
TXT    _xite-verify.www.mycollege.edu    <token from the dashboard>
CNAME  www.mycollege.edu                 cname.webxite.org
```

At an apex (`mycollege.edu` with no subdomain) a CNAME is not legal, so an `A`
record to the platform address is accepted instead — `checkRouting` tries CNAME
first and falls back to `A`.

**WebXite never edits a customer's zone.** There is no provider API integration
and no plan for one: doing that requires the customer to delegate DNS or hand
over an API key, and neither is something to imply we have.

---

## 3. Verification — what each check proves

`verifyDomain` runs three checks in order, and the status it writes is a
description of what it observed, never what the caller asked for.

1. **Ownership** — `_xite-verify` TXT matches the token. Without this, anyone
   could attach any hostname to their own site.
2. **Records** — CNAME resolves to `cname.webxite.org`, or `A` to the platform
   address.
3. **Edge** — `domainRouter().ensure(hostname)`. See "Read this first".
4. **TLS** — a real HTTPS request. Nothing here can make a certificate exist;
   the check only reports whether one does.

A domain reaches `ACTIVE` only when all four pass in the same call.

| Status | Means |
| :--- | :--- |
| `PENDING_VERIFICATION` | the TXT record is not visible yet |
| `VERIFIED` | ownership proven; records, edge or certificate outstanding — `stage` says which |
| `ACTIVE` | all four checks passed |
| `FAILED` | checked repeatedly and still not working |
| `DISCONNECTED` | removed by the tenant, or disabled by an admin. Never served |

### `stage` — what is outstanding

`status` says how far along a domain is. **`stage` says what is being waited
on**, and they are not the same question: three quite different situations all
sit at `VERIFIED`, and only one of them is the tenant's to fix.

| `stage` | Waiting on | Whose |
| :--- | :--- | :--- |
| `ownership` | the `_xite-verify` TXT record | the tenant |
| `routing` | CNAME/A pointing here | the tenant |
| `edge` | the host being added to the proxy | us |
| `tls` | the certificate | automatic |
| `done` | nothing — all four passed | — |

It is set on **every branch of `verifyDomain`**, beside the `status` and
`lastError` it belongs with, rather than derived afterwards. It was derivable
from `lastError` only by reading the sentence, which is not something a UI can
do — so the tenant screen printed one line of prose and left them to work out
whether they were being asked to act or to wait.

Rows written before the field exists are read through `stageFromStatus`. Only
the two ends can be known: `ACTIVE` is `done`, anything unverified is
`ownership`. A `VERIFIED` row is reported as `routing` — the first of its three
possibilities, the only one the tenant can act on, and the one the next pass
corrects within the minute. Guessing `tls` would tell somebody to wait when
they need to act, which is the worse error.

---

## 4. The SSRF guard

`checkSsl` makes a real HTTPS request to a hostname **the tenant supplied**,
from inside our network. That is the textbook shape of a Server-Side Request
Forgery, and it was one.

`normalizeHostname` validates syntax and `assertNotPlatformHost` refuses names
we own. Neither looks at where the name *resolves*, and resolution is the half
an attacker controls: nothing stopped `evil.example` carrying an A record for
`169.254.169.254` — the cloud metadata endpoint — or for a database listening
only on the private network.

It was weaker than it looks against literals, too: `127.0.0.1` passes an LDH
label check (four labels, each alphanumeric), so it survived normalisation and
arrived as an ordinary "domain".

`lib/net/public-address.ts` resolves the name and refuses if **any** address it
answers with is not publicly routable.

- *Any*, not all. One public and one private address is a rebinding attempt, and
  treating it as public is how the private one gets connected to on the retry.
- Ranges are tested **arithmetically**. A prefix test on `"172."` also refuses
  `172.15`, and one on `"10."` also matches `100.64`.
- IPv4-mapped IPv6 is judged by the IPv4 rules, or `::ffff:10.0.0.1` walks
  straight through.
- A name that does not resolve is refused. "We could not tell" must not read as
  "safe".

**Residual risk, stated rather than papered over:** between our resolution and
the socket's own, a short-TTL record can change. Node's `fetch` offers no hook
to pin a resolved address. What is gone is every *static* private target, which
is every practical version of this attack. The request is a blind `HEAD` with no
body returned to the caller and a hard timeout.

---

## 5. The monitor

Verification used to run only when somebody pressed a button, which left two
holes on opposite sides of one gap:

- a domain waiting on DNS never advanced — the tenant added the records, closed
  the tab, and it sat there;
- a domain that reached `ACTIVE` **stayed `ACTIVE` forever**. A zone edited
  months later, a certificate that failed to renew, a host dropped from the
  proxy — the dashboard kept showing green and the first report came from a
  customer.

`domain-monitor.ts` is one in-process interval, no queue and no second service:

| | Re-checked |
| :--- | :--- |
| waiting | backoff from 1 minute to 1 hour; given up on after 48 hours |
| working | every 6 hours, so one that quietly breaks is demoted |
| disconnected | never |

Bounded on every axis: 25 domains per pass, one pass at a time, `unref`'d so it
can never be why a container will not exit. Backoff is derived from how long a
domain has been waiting rather than a stored counter — one less field to keep
consistent, and it survives a restart.

It starts **before** the database is awaited. `connectDB` retries eight times
with a fifteen-second timeout and throws if the database is unreachable, so
anything sequenced after it either waits two minutes or never runs — meaning a
deployment that came up before Atlas would never re-check a domain until someone
redeployed. A pass with no database logs its failure and returns.

The tenant's Check button still works and is unchanged.

---

## 6. Resolution

```
Host header
  → normalizeHostname            scheme, userinfo, path, port, trailing dot
  → College.findOne({ domains: { $elemMatch: { hostname, status: "ACTIVE" } } })
  → collegeId + subdomain
  → the published site
```

Two properties worth naming:

- **`status: "ACTIVE"` is part of the query**, not a check afterwards. A
  disconnected domain cannot resolve even if the row is still there.
- **The Host header never becomes a query on its own.** It is normalised and
  LDH-validated first, and a name that fails returns `null` rather than
  searching for it.

---

## 7. Duplicate domains

Prevented **at the database**, not in application code:

```js
CollegeSchema.index({ "domains.hostname": 1 }, { unique: true, sparse: true });
```

Two tenants cannot hold the same hostname whatever the API does. `sparse` so the
many colleges with no domains do not collide on a missing key.

---

## 8. Reserved names

`assertNotPlatformHost` refuses anything under `webxite.org`, under the legacy
`xite.co.in`, and `localhost`.

The check is a **suffix match on the parsed hostname**, never `includes()` —
`webxite.org.attacker.com` contains the root domain and must not pass. The same
distinction is documented on `isAllowedOrigin` in `server.ts`, for the same
reason.

---

## 9. Super Admin

There was no cross-tenant view of domains at all. A tenant could see their own;
nobody could see the roster, so "which domains are failing right now" was
answerable only by querying the database — and a broken domain belonging to a
tenant who had stopped looking was invisible indefinitely.

```
GET  /api/v1/admin/domains                                  worst-first
POST /api/v1/admin/domains/:collegeId/:domainId/verify
POST /api/v1/admin/domains/:collegeId/:domainId/disable
POST /api/v1/admin/domains/:collegeId/:domainId/reactivate
```

Disable reuses `DISCONNECTED` rather than adding a second word for the same
state: `collegeIdForHost` already refuses it, and two words would mean two checks
on every resolution, one of which would eventually be missed.

Re-enabling returns a domain to `PENDING_VERIFICATION` rather than to whatever it
was. Nothing is known about the world since it was switched off, and the monitor
will establish it within the minute. Restoring `ACTIVE` from memory would assert
a fact nobody has checked.

---

## 10. Environment

| Variable | Required | Purpose |
| :--- | :--- | :--- |
| `ROOT_DOMAIN` | no | Platform root. Defaults to `webxite.org` |
| `DOMAIN_CNAME_TARGET` | no | What tenants are told to CNAME to |
| `DOMAIN_APEX_IP` | no | The `A` record value for apex domains |
| `DOKPLOY_API_URL` | for routing | The edge's API |
| `DOKPLOY_API_TOKEN` | for routing | Sent as `x-api-key`. **Never logged** |
| `DOKPLOY_APPLICATION_ID` | for routing | Which application serves tenant sites |

All three Dokploy variables are needed together; with any missing, routing is
"not configured" and says so.

---

## 11. Known and open

- **The Dokploy client has never run against a live instance.** It is behind the
  three variables and off by default, because shipping untested infrastructure
  code on the path that decides whether a tenant's site is reachable is not a
  safe default. Wire it, add one domain, and read the `DOMAIN_ROUTING_*` line
  before trusting it.
- **DNS rebinding has a residual window.** See §4.
- **The tenant-facing UI now shows the four checks.** `DomainSettingsModal`
  renders `domainChecklist()` — one row per check, marked passed, current,
  blocked or failed, each naming whose it is. Two states it used to get wrong
  are fixed with it: a domain that had passed every check while its certificate
  was still issuing was labelled "Pending verification", and a domain an admin
  had **disabled** was told to add a TXT record and press a Check button that
  returns 404 for it. Both sent tenants to edit a zone that was already correct.
  Covered by `publishing-client.test.ts` in `xite-F`.

- **The Super Admin roster has routes but no screen.** `GET /admin/domains` and
  the verify / disable / reactivate routes are live and tested; nothing in
  `xite-admin` calls them yet, so cross-tenant domain triage is still a curl
  away rather than a page.
- **No DNS-provider automation, by design.** See §2.
