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
| `SESSION_COOKIE_DOMAIN` | API | `.xite.co.in`, so `admin.` and `api.` share the cookie. Unset locally. |
| `TRUST_PROXY` | API | `1` behind Traefik. Rate limits key partly on client address; without this every caller looks like the proxy. |
| `ENABLE_RATE_LIMIT` | API | On unless exactly `"false"`. There is no reason to set it outside a load test. |
| `AUTH_DISABLED` | frontend | `false`. `true` opens the editor to anyone as a shared tenant. |
| `MONGODB_URI` | API | Never in a file. Environment only. |

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
