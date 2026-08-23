# Security

## Reporting

Email the maintainer directly. Do not open a public issue for anything that
would give somebody access they should not have.

---

## Credential exposure — 2026-08-20

Recorded here because the useful part of an incident is the shape of it, and
the shape of this one is worth not repeating.

### What happened

The production API was running with these values:

```
SESSION_SECRET=super-secret-session-key-for-xite-local-dev-32chars
ADMIN_SESSION_SECRET=super-secret-admin-session-key-32chars
```

Both were the literal placeholders committed in this repository's own
`.env.example`, and the repository was public. They were fetchable by anyone:

```
curl https://raw.githubusercontent.com/<org>/B-X/main/.env.example
```

Sessions here are HS256 JWTs. The signing key *is* authentication — holding it
lets anyone mint a valid `college_session` for any `collegeId`, or an admin
session, without guessing a password, tripping a rate limit, or touching the
login endpoint at all. Every access control in the service was decorative for as
long as this was true.

Separately, a working MongoDB Atlas connection string — username and password —
was hardcoded in three committed scripts (`prove-prod-flow.mjs`,
`prove-editor-contract.mjs`, `live-production-browser-flow.mjs`), giving direct
read/write access to every tenant's data, bypassing the API entirely.

### Why nothing caught it

A placeholder is a valid string of sufficient length. `secretKey()` accepted it,
the service booted, the logs were clean, and the product behaved exactly as
designed. There is no symptom to notice. The only way this surfaces is if
something is specifically looking for it, and nothing was.

### What changed

- `src/lib/secret-hygiene.ts` refuses to start the API when a signing key is
  missing, under 32 characters, matches a value that has ever appeared in this
  repository, or reads as a placeholder. Fatal in every environment, including
  development — warning in development and failing in production is precisely
  how a placeholder reaches production.
- `xite-F/scripts/start.mjs` carries the same check, with one deliberate
  difference: a *published* key is fatal, a *missing* key only warns. The
  frontend verifies sessions but never issues them, and every published college
  site works without one — taking those down would be a larger outage than the
  bug.
- The three scripts read `MONGODB_URI` from the environment and exit if it is
  absent.
- `.env.example` ships empty secret fields and the command to generate them.

---

## Full platform audit — 2026-08-23

A complete review of xite-B, xite-F and xite-admin: authentication,
authorisation, tenant isolation, MongoDB access, the API surface, the renderer,
uploads, domains, deployment and dependencies. Recorded at the same length as
the incident above, for the same reason.

Six issues were rated Critical. Every one of them was reachable in production
and four needed no credentials at all.

### C-01 — A hardcoded Super Admin password

`admin-service.ts` accepted the literal string `"2008"` as a Super Admin
password, in three independent places:

- when no admin row matched the submitted email, it **created** one —
  `AdminUser.create({ email, role: "SUPER_ADMIN" })` — so any address plus that
  password provisioned a new Super Admin;
- when no admin existed at all, it returned a synthetic `super-admin-root`
  session signed with the real admin key;
- for an admin that *did* exist, `if (!match && password !== "2008")` discarded
  the result of the bcrypt comparison, so the real password was never required.
  The same clause guarded the TOTP branch, so enrolled second factors were
  bypassed by the same string.

`ADMIN_BOOTSTRAP_PASSWORD` was checked identically alongside it, which made a
one-time setup value into a permanent standing credential.

`admin-bootstrap.ts` supplied the other half: `DEFAULT_ADMIN = { email:
"admin@xite.co.in", password: "2008" }`, applied on **every** boot. The marker
that was supposed to make it run once was written and never read, so a
deployment that had rotated its admin password had it reset to a four-digit
literal on the next container restart.

Fixed. Login resolves exactly one account by email, requires its stored bcrypt
hash to match, and enforces TOTP with no bypass. Bootstrap runs once per
database, refuses a placeholder password, generates a random one when nothing is
configured, and prints it to the server log a single time.

### C-02 — Unauthenticated sign-in through the Google callback

`xite-F/src/app/api/auth/google/callback/route.ts` caught a missing code, a
missing or mismatched OAuth `state`, and any failure of the token exchange — and
answered all three by substituting a hardcoded identity, then falling through to
issue a real session cookie. A bare `GET /api/auth/google/callback` with no
query string took that branch.

It did not stop at a demo account. The lookup fell back to
`admin@greenfield.edu.in`, and failing that created a user with an empty password
hash attached to `prisma.college.findFirst()` — whichever college was first.

Fixed. A missing or mismatched `state` is a refusal, a failed exchange is a
refusal, an unverified Google address is a refusal, and an address with no
existing account is a refusal. Google sign-in no longer provisions accounts.

### C-03 — Stored XSS in tenant sections, escalating across tenants

Section markup is stored as a raw HTML string and rendered with
`dangerouslySetInnerHTML`. `PUT /api/v1/my-website` accepted whatever JSON it was
sent and nothing sanitised it at any point on the way to the page.

That is not confined to the tenant's own site. `xite-F` serves a tenant's
sections from the platform apex as well — `webxite.org/site/<tenant>`,
`/preview/<tenant>` and `/<tenant>` — which is the same origin as the sign-in
page, the editor, and the `next.config.ts` rewrite that proxies `/admin/*`
straight onto the admin API. On `<tenant>.webxite.org` the session cookie's
`.webxite.org` scope and `isAllowedOrigin`'s `*.webxite.org` suffix rule produce
the same result one step less directly.

So one `<img src=x onerror=...>` in a section, viewed by a signed-in Super Admin
— which is what happens when anyone opens a tenant site to check it — reaches
`GET /admin/users`, `PATCH /admin/users/:id/password` and
`DELETE /admin/users/:id`.

`site-settings-service.ts` had already reasoned this through for the `customCode`
field. Section markup was the same input through a different door with none of
the same protection.

Fixed. `src/lib/sections/sanitize-section-html.ts` parses section markup with an
allowlist and is applied on write (`PUT /api/v1/my-website`), on the public read
(`/api/v1/public/site/:subdomain`), on the editor read (`/api/v1/editor/:subdomain`
and `/api/v1/my-website`), and on the platform default. Applying it on read as
well as on write matters: every section stored before this existed is untrusted,
and read-side cleaning is what makes existing sites safe at deploy time rather
than the next time an owner presses save.

### C-04 — Unauthenticated disclosure of every password hash

`GET /api/v1/editor/:subdomain` is public and takes a subdomain from the URL. One
of its branches responded with the Mongoose College document itself.
`CollegeSchema`'s `toJSON` transform removes `_id` and `__v` and nothing else, so
the response carried `users[]` in full — every account's email address and its
bcrypt `passwordHash` — plus the unpublished draft and the tenant's domain
verification tokens.

It was reachable whenever `publishedSiteConfig()` returned without a `pages`
array, which is the ordinary state of a college that has never published.

Fixed. The branch returns an explicit four-field projection. A literal cannot
grow a field because a model did.

### C-05 — Account hijack before approval

`POST /api/v1/access-requests` is public. When a PENDING request already existed
for an address, it overwrote that row's `passwordHash`, `collegeName` and
`applicantName` with whatever the new caller sent. Nothing proved the second
caller was the first.

Submit a request naming somebody else's work address and a password of your
choosing; the Super Admin approves the application they already had in their
queue; `approveAccessRequest` creates that college's owner account carrying your
hash. Completed by the administrator, against a row they believed they were
reading, with nothing recording that it had changed hands.

Fixed. A duplicate submission is answered 202 and writes nothing — the response
is unchanged so an address still cannot be probed for.

### C-06 — A committed default account password

`approveAccessRequest` hashed the literal `"college123"` for any request approved
without a password, and created the account ACTIVE. `POST /api/v1/auth/login`
accepted it immediately, so knowing an approved applicant's email address was
enough to sign in as the owner of their college. This was the common branch, not
an edge case.

Fixed. The field is filled with CSPRNG output nobody is told; the way in is the
activation link, which sets a password the applicant chooses.

### High

- **H-01** — `access-service.ts` declared a local
  `verifyGoogleIdToken(credential) { return { email: credential } }` that shadowed
  the real JWKS-backed verifier in `google-identity.ts`. The
  `identity.email === request.applicantEmail` comparison — the entire security
  boundary of activation-by-Google — compared the invited address against a
  string the caller chose. Fixed by importing the real verifier.
- **H-02** — SVG uploads were served from the API origin with
  `Content-Type: image/svg+xml`, and the global CSP allows `script-src 'self'
  'unsafe-inline'`. Navigating to an uploaded SVG executed script on
  `api.webxite.org`. Fixed: uploads are served with `default-src 'none'; sandbox`
  and SVG additionally with `Content-Disposition: attachment`. `<img src>` still
  renders — `Content-Disposition` applies to navigations, not subresources.
- **H-03** — `stripExecutable` was five regexes and bypassable four ways:
  `<img/onerror=...>` (the pattern required whitespace before `on`),
  `href="&#106;avascript:..."` (raw-byte comparison, browser decodes after),
  `formaction` (never checked), and handlers on SVG animation elements. Replaced
  with a `sanitize-html` allowlist.
- **H-04** — `sanitizeTemplateCode` set `allowedSchemes: [..., "javascript"]` and
  `allowedScriptDomains: ["*"]` on the reasoning that admin content is trusted.
  Templates render on the platform apex, so the blast radius of one bad template
  is the platform. `javascript:` removed; `<script>` kept, because the library
  genuinely contains menus that need it.
- **H-05** — Passwords submitted through the access-request form were hashed at
  bcrypt cost 8, and that hash was copied verbatim onto the created account — so
  cost 8 governed most real accounts. Now 12 everywhere, with a 10-character
  floor the public form previously did not have at all.
- **H-06** — `GET /admin/templates`, `/admin/templates/:id` and
  `/admin/templates/stats` were unauthenticated and returned full template
  source including unpublished drafts. Now `requireAdmin`.

### Medium

- A second, unguarded `app.put` for the six `default-website` paths. Unreachable
  only because Express matches in registration order — reordering or deleting the
  guarded one above it would have made it an open write endpoint. Removed.
- `AUTH_DISABLED=true` was honoured in production, where it hands every anonymous
  request a session for a real college. Now cleared at boot with a loud error.
- `templateUpload` used `.any()` with a per-file size cap and no file count, into
  memory storage — one multipart POST could exhaust the heap. Now capped.
- No index on `users.email`, `users.id`, `applicantEmail` or `activationToken`.
  Every sign-in was a full scan of the largest collection, from an
  unauthenticated route. Indexes added.
- `x-tenant-id` and `x-request-id` were reflected from the request unvalidated.
  `x-request-id` is now shape-checked; `x-tenant-id` is no longer echoed.
- A catch-all returning `{"status":"ok"}` and `{"admin":null}` for unmatched paths
  by substring. Unreachable, and it would have reported health for routes that do
  not exist. Removed.
- `xite-F` served no security headers. Baseline added in `next.config.ts`.
- Backend `Dockerfile` used `npm install` (not `ci`) and `npm run build || true`.
  Both fixed.
- `xite-F/src/lib/auth/demo.ts` held a plaintext demo login and was imported
  nowhere. Deleted.

### What this audit did not change

- **The in-memory rate limiter.** Correct for one instance and bypassable by
  round-robin across replicas. Moving it to a shared store is an architecture
  change, not a patch.
- **The `*.webxite.org` CORS suffix rule.** With section markup and custom code
  both sanitised, the practical path through it is closed — but it still means a
  subdomain takeover is a credentialed-CORS grant. Narrowing it to resolved
  tenant hostnames is the real fix.
- **`role` on `AdminUser` is never read.** Every administrator is effectively a
  Super Admin. No privilege tiers exist to enforce.
- **`SystemSecret` holds the admin signing key in plaintext** and, separately,
  audit entries under `audit:<timestamp>` keys. Two different lifetimes in one
  collection.
- **`users.email` is not unique.** It should be, but building a unique index on a
  live collection fails if any duplicate exists, and that is not a change to make
  inside a security fix.

---

## Rotating the signing keys

Rotation invalidates every existing session. That is the point: it is what
turns a leaked key into a useless one. Everybody signs in again.

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -base64 48   # ADMIN_SESSION_SECRET
```

Set on the API (`XITE-B`):

```
SESSION_SECRET=<generated>
ADMIN_SESSION_SECRET=<generated>
```

Set on the frontend (`XITE-F`) — the **same** `SESSION_SECRET`, since one
service signs the cookie and the other verifies it:

```
SESSION_SECRET=<the same generated value>
```

Redeploy both. If either refuses to start, it is telling you the key it was
given cannot be trusted; read the message rather than working around it.

### Rotating the database password

1. Atlas → Database Access → edit the user → autogenerate a password.
2. Update `MONGODB_URI` on the API and redeploy.
3. Atlas → Project → Access History. Look for connections from addresses that
   are neither the application server nor a known developer machine.

---

## Required environment

| Variable | Service | Notes |
| --- | --- | --- |
| `SESSION_SECRET` | API + frontend | Must match across both. Generated, never copied. |
| `ADMIN_SESSION_SECRET` | API | Distinct from `SESSION_SECRET`; the service refuses to reuse it. |
| `SESSION_COOKIE_DOMAIN` | API | `.webxite.org`, so `admin.` and `api.` share the cookie. Unset locally. |
| `TRUST_PROXY` | API | `1` behind Traefik. Rate limits key partly on client address; without this every caller looks like the proxy. |
| `ENABLE_RATE_LIMIT` | API | On unless exactly `"false"`. There is no reason to set it outside a load test. |
| `AUTH_DISABLED` | frontend | `false`. `true` opens the editor to anyone as a shared tenant. |
| `MONGODB_URI` | API | Never in a file. Environment only. |
| `AUTH_DISABLED` | API | `false`. Ignored outright in production since 2026-08-23 — it granted anonymous callers a session for a real college. |
| `ADMIN_BOOTSTRAP_PASSWORD` | API | One-time only. Refused if under 12 characters or a known placeholder. Unset it after first sign-in. |
| `GOOGLE_CLIENT_ID` | API + frontend | Same value on both. Unset, activation-by-Google refuses rather than trusting a caller-supplied address. |
| `GOOGLE_CLIENT_SECRET` | frontend only | Never on the API — it runs no code exchange. |

A `docker-compose.yml` default does **not** apply when the platform supplies its
own environment — Dokploy and similar inject variables directly, so anything
relying on `${VAR:-default}` in compose is simply unset in production. That is
how `SESSION_COOKIE_DOMAIN` and `TRUST_PROXY` came to be missing.

---

## Rules

1. **Never commit a working secret**, including in an example file. A
   placeholder that is long enough to be valid is a secret waiting to be used.
2. **Never hardcode a connection string.** Read it from the environment and exit
   if it is absent, so the failure is a clear message rather than a quiet
   connection to somewhere unintended.
3. **A key that has been published is burned permanently.** Rotating fixes the
   exposure; it does not un-publish anything. Add the old value to
   `KNOWN_PUBLISHED_SECRETS` so it can never be used again by accident.
4. **Rotate before scrubbing history.** Anything public has been scraped. Making
   the repository private and rewriting history are damage control; rotation is
   the fix.
