# XITE — Backend

The API and the database for [xite-F](https://github.com/kishore7ga-art/xite-F).

Express + Prisma + Postgres. Owns the schema: this is the only service that
runs migrations.

```
GET    /api/health              service + database status
GET    /api/v1/sections/:id     version history for a section
PATCH  /api/v1/sections/:id     save content   { content, trigger }
POST   /api/v1/sections/:id     restore        { versionId }
POST   /api/uploads             multipart image upload
GET    /uploads/:file           serve an uploaded image
```

---

## What is shared with the frontend, and why

`prisma/`, `src/lib/sections/`, `src/lib/db-pool.ts` and `src/lib/json-stable.ts`
are copies of the same files in xite-F, at the same paths.

That is a real cost worth naming: **these are two copies of the same
validation rules.** If a section's Zod schema changes in one repo and not the
other, one service will accept content the other rejects, and the symptom will
be a save that works in the editor and fails in the API. Until they are pulled
into a shared package, changing anything under `src/lib/sections/` means
changing it in both repos in the same commit.

They are duplicated rather than imported because the two repos deploy
independently, and a shared package is only worth setting up once the schema
has stopped moving.

---

## Deploying on Dokploy

### 1. Create the service

Dokploy → **Create → Compose**

| Field | Value |
|---|---|
| Repository | `kishore7ga-art/xite-B` |
| Branch | `main` |
| Compose Path | `./docker-compose.yml` |

### 2. Environment

```
SESSION_SECRET=<the SAME 32+ chars as the frontend>
ADMIN_SESSION_SECRET=<32+ chars, DIFFERENT from SESSION_SECRET>
POSTGRES_PASSWORD=<strong random>
CORS_ORIGINS=https://xite.co.in
RESEND_API_KEY=<from resend.com/api-keys>
MAIL_FROM=XITE <no-reply@xite.co.in>
```

**Do not set `AUTH_DISABLED=true`.** It used to be listed here and it is not a
deployment setting — it removes authentication entirely. `getSession()` returns
the oldest college to every caller without reading the cookie, so no `users` row
is consulted at all: access requests, approval and the `status` check on sign-in
all stop meaning anything, and every visitor can edit and publish the site.

`RESEND_API_KEY` and `MAIL_FROM` are what deliver an approved request's invite.
Without both, approving still succeeds and still mints a valid invite — it simply
cannot send it. `/api/health` reports `mailer: "not configured"` so this is
visible rather than discovered by someone who never got an email.

**`SESSION_SECRET` must be byte-identical to the frontend's.** It is the key
the session cookie is signed with — if they differ, every cookie the frontend
issues fails verification here and the editor gets 401 on every save.

Do **not** set `DATABASE_URL`. Compose builds it from `POSTGRES_PASSWORD`.
Never point it at `localhost` — inside a container that is the container
itself, not your server.

### 3. Domain

| Field | Value |
|---|---|
| Host | `api.xite.co.in` |
| Service Name | `api` |
| Container Port | **4000** |
| HTTPS | on (Let's Encrypt) |

Point an A record for `api.xite.co.in` at the same server first, or
certificate issuance fails.

### 4. Deploy, then check

```bash
curl https://api.xite.co.in/api/health
```

```json
{"status":"ok","service":"backend","database":"connected","templates":5}
```

`templates: 5` means migrations ran and the seed populated. `0` means the seed
failed — check the deploy log for `[start] seeding`.

---

## Connecting the frontend to it

In the **xite-F** service's environment:

```
NEXT_PUBLIC_API_BASE_URL=https://api.xite.co.in
```

Redeploy the frontend. Browser calls now go to this service — visible in the
Network tab as `PATCH https://api.xite.co.in/api/v1/sections/...`.

### Two things that will bite you, in this order

**1. CORS.** `CORS_ORIGINS` must name the frontend's origin exactly. It is
already set to `https://xite.co.in` above. A wildcard is not an option — the
browser refuses `*` on a request carrying credentials.

**2. The cookie.** The session cookie is currently issued `SameSite=Lax`, which
a browser will not send to a *different* origin. Until xite-F sets
`SameSite=None; Secure` in `src/lib/auth/session.ts`, authenticated calls to
`api.xite.co.in` arrive signed out — a 401 on every save with CORS looking
fine.

Both disappear if you leave `NEXT_PUBLIC_API_BASE_URL` unset and keep the API
same-origin behind one domain.

---

## How the two services talk

```
                     ┌────────────────────────┐
   browser ─────────▶│  xite-F   (frontend)   │  pages, editor UI
                     └───────────┬────────────┘
                                 │  NEXT_PUBLIC_API_BASE_URL
                                 │  (or same-origin if unset)
                     ┌───────────▼────────────┐
                     │  xite-B   (this repo)  │  API, migrations, seed
                     └───────────┬────────────┘
                                 │
                     ┌───────────▼────────────┐
                     │        postgres        │
                     └────────────────────────┘
```

Same server, two Dokploy services: put both on `dokploy-network` (uncomment the
blocks in `docker-compose.yml`) and the frontend can reach this one privately at
`http://api:4000` — no public hop, no CORS. Use the public
`api.xite.co.in` only for calls the browser makes directly.

---

## Local development

```bash
cp .env.example .env      # set DATABASE_URL and SESSION_SECRET
npm install
npx prisma migrate deploy
npm run dev               # http://localhost:4000
```
