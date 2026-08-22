# Publishing, custom domains and site settings — deployment notes

What an operator needs to know to deploy, configure and verify the publishing
and custom-domain system. Written against the infrastructure that actually
exists, which is **Traefik managed by Dokploy**, with Nixpacks builds and
MongoDB Atlas. No Cloudflare, AWS or Vercel is involved anywhere.

---

## 1. Deploy order

**`xite-B` first, then `xite-F`.** Both directions are survivable, but only one
has no window:

| Order | What happens in between |
|---|---|
| Backend first | Public reads switch to `publishedConfig`, which falls back to the draft for every tenant at `publishedVersion: 0`. Nothing visible changes. New routes exist with nothing calling them. |
| Frontend first | Published pages ask for `settings` and get nothing back, so they fall to safe defaults — indexing on, maintenance off, no custom code. A tenant who had maintenance mode **on** would briefly serve their real site. |

## 2. Migration

There isn't one, deliberately.

`websiteConfig` keeps its name and keeps being the draft. `publishedConfig` is
a new field, and `publishedSiteConfig()` falls back to the draft while
`publishedVersion` is 0 — which, on the day this shipped, was every tenant. No
site goes dark, and no script has to run. The fallback stops applying to each
tenant the first time they publish.

## 3. Index builds on first boot

Mongoose creates these when the models initialise:

| Collection | Index | Notes |
|---|---|---|
| `colleges` | `{ "domains.hostname": 1 }` unique, sparse | Every existing document lacks the field, so it builds near-instantly. |
| `invoices` | `{ tenantId: 1, issuedAt: -1 }` | New collection, empty. |
| `invoices` | `{ number: 1 }` unique | New collection, empty. |
| `paymentMethods` | `{ provider: 1, providerRef: 1 }` unique | New collection, empty. |

If the service is slow to report healthy on the first boot after deploy, this is
where to look.

## 4. Environment

Nothing new is **required**. These change behaviour when set:

| Variable | Service | Effect if unset |
|---|---|---|
| `CUSTOM_DOMAIN_CNAME_TARGET` | `xite-B` | Falls back to `sites.<ROOT_DOMAIN>`. Tenants are shown a CNAME target that may not route. |
| `CUSTOM_DOMAIN_APEX_IP` | `xite-B` | Apex domains are offered **no A record**, only a CNAME their provider may refuse at the apex. |
| `ROOT_DOMAIN` / `NEXT_PUBLIC_ROOT_DOMAIN` | both | Defaults to `webxite.org`. Decides which hosts are platform-owned and therefore refused as custom domains. |
| `PAYMENT_PROVIDER` | `xite-B` | Billing reports "no provider connected", which is correct — see §7. |

`PAYMENT_PROVIDER` accepts only `stripe` or `razorpay`, and **neither is
implemented**. Anything else — including a real provider not on that list — is
treated as unset, so a client cannot open a card flow the server could not
finish. Leave it unset.

## 5. Manual infrastructure — custom domains cannot work without this

A custom domain can reach **VERIFIED** on code alone. It cannot reach **ACTIVE**
without a human doing the following, because *application code cannot issue a
TLS certificate*. Traefik does that, under Dokploy, and there are no Traefik
labels in these repositories.

For each custom domain a tenant connects:

1. Add the hostname as a domain on the **frontend** service in Dokploy.
2. Point it at container port `3000`.
3. Enable Let's Encrypt for it so Traefik requests a certificate.

Until that is done, `verifyDomain` will correctly report ownership proven,
routing proven, and the certificate missing. The tenant sees "Almost there",
which is honest — but will look stuck to anyone who does not know step 1 exists.

Still outstanding platform-wide:

- Wildcard DNS and a wildcard certificate for `*.webxite.org`.
- A Dokploy API token, if domain attachment is ever to be automated rather than
  clicked.

## 6. Verifying a deploy

```bash
# The API is up and connected.
curl -s https://api.webxite.org/api/health

# The new routes exist. 401 means deployed; 404 means not.
curl -s -o /dev/null -w '%{http_code}\n' https://api.webxite.org/api/v1/publish/status
curl -s -o /dev/null -w '%{http_code}\n' https://api.webxite.org/api/v1/site-settings

# Control: a route that has never existed should be 404, not 401.
curl -s https://api.webxite.org/api/v1/no-such-route

# The frontend is deployed: this meta tag did not exist before.
curl -s https://webxite.org/site/greenfield | grep -o '<meta name="robots"[^>]*>'
```

Then, signed in:

1. Edit a section, save, reload the public site — the edit must **not** appear.
2. Press Publish, reload — now it appears.
3. Toggle maintenance mode on, reload the public site in a private window — the
   maintenance page, not the site.
4. Toggle SEO indexing off — `<meta name="robots" content="noindex, nofollow">`.

## 7. What this system deliberately does not do

Stated so nobody builds on an assumption it does not support.

- **It does not issue certificates.** SSL status is the result of a real HTTPS
  request to the real host. There is no code path that sets it optimistically.
- **It does not bill anyone.** Nothing prices a plan, meters usage or raises an
  invoice. `invoices` is a ledger a Super Admin writes to; an empty list means
  nothing has been billed, and the UI says exactly that.
- **It does not accept card details.** `attachPaymentMethod` refuses a body
  carrying `number`, `pan`, `cvc` or `cvv` outright. Only a provider's token and
  display metadata are stored. Collecting a PAN would put this platform in
  PCI-DSS scope.
- **It does not execute tenant script on `*.webxite.org`.** Those hosts share a
  registrable domain with the platform: the session cookie is scoped to
  `.webxite.org`, it is `SameSite=None`, and CORS admits every platform
  subdomain. Tenant script there could call the API as whoever is browsing.
  Custom code is stored verbatim and rendered with executable content stripped
  until the tenant connects their own domain.

## 8. Known limitations

- `isApex()` has no public-suffix list, so `college.edu.in` reads as a subdomain
  and is offered a CNAME. Such a tenant needs the A-record path, which requires
  `CUSTOM_DOMAIN_APEX_IP`.
- `stripExecutable()` is regex-based. It handles the cases in its test suite and
  errs toward removing too much, but a regex is not an HTML parser.
- `publishedConfig` roughly doubles a large tenant's document against Mongo's
  16MB per-document ceiling. No publish history is kept, for that reason.
- `verifyDocs()` in `server.ts` only warns about undocumented routes despite its
  comment claiming it is fatal outside production — which is why 15 routes once
  shipped undocumented. `npm run check:openapi` now runs in `prebuild` and does
  exit non-zero.
