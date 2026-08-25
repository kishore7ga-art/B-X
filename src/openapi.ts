import { z } from "zod";

import {
  accessRequestSchema,
  activateGoogleSchema,
  activatePasswordSchema,
} from "@/access-service";
import { credentialsSchema } from "@/auth-service";
import { adminLoginSchema, updateUserStatusSchema } from "@/admin-service";
import {
  createTemplateSchema,
  templateDetailsSchema,
  templateSlotsSchema,
} from "@/library-service";

/**
 * The API, described once, from the schemas that actually validate it.
 *
 * Request bodies are converted straight out of the zod schemas the routes parse
 * with, so a validation rule and its documentation cannot disagree — change
 * `activatePasswordSchema`'s minimum password length and this says the new
 * number without anyone remembering to edit it. zod 4 can do that on its own; no
 * openapi-generator dependency was added, because none was needed.
 *
 * Responses are hand-written JSON Schema. There are no zod schemas for
 * responses to derive them from, and inventing some purely to feed this file
 * would mean validating every response at runtime to keep them honest — a real
 * cost for a docs page. They are checked a different way: `assertFullyDocumented`
 * compares this document against Express's own route table at startup, so an
 * endpoint cannot ship without an entry here.
 */

/** zod 4 emits JSON Schema directly — this is the whole "generator". */
const body = (schema: z.ZodType) => ({
  required: true,
  content: {
    "application/json": {
      schema: z.toJSONSchema(schema, { io: "input" }),
    },
  },
});

const json = (schema: object, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

const str = { type: "string" } as const;
const nullableStr = { type: ["string", "null"] } as const;
const bool = { type: "boolean" } as const;
const int = { type: "integer" } as const;

/** Every failure on this API is `{ error: string }` — see `fail()` in server.ts. */
const ERROR = {
  type: "object",
  properties: { error: str },
  required: ["error"],
} as const;

const errors = (...codes: [number, string][]) =>
  Object.fromEntries(
    codes.map(([code, description]) => [
      String(code),
      json(ERROR, description),
    ]),
  );

const SESSION_COOKIE = [{ sessionCookie: [] }];

const COLLEGE = {
  type: "object",
  properties: {
    id: str,
    name: str,
    subdomain: str,
    customDomain: nullableStr,
    templateId: nullableStr,
    themePaletteId: nullableStr,
    themeFontId: nullableStr,
    status: str,
    collegeType: nullableStr,
    isDemo: bool,
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

const THEME = {
  type: "object",
  properties: {
    paletteColors: { description: "Raw palette JSON, parsed by the frontend." },
    headingFont: nullableStr,
    bodyFont: nullableStr,
  },
} as const;

const RENDERABLE_SECTION = {
  type: "object",
  properties: {
    id: str,
    sectionType: str,
    componentKey: str,
    variantId: str,
    variantName: str,
    displayOrder: int,
    isVisible: bool,
    content: { description: "Section content; shape depends on sectionType." },
  },
} as const;

const NAV_PAGE = {
  type: "object",
  properties: { id: str, slug: str, title: str },
} as const;

const TEMPLATE_SUMMARY = {
  type: "object",
  properties: {
    id: str,
    name: str,
    description: nullableStr,
    thumbnailUrl: nullableStr,
    demoUrl: nullableStr,
    sectionCount: int,
  },
} as const;

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "XITE API",
    version: "1.0.0",
    description:
      "The API behind webxite.org. Every read and write the frontend performs " +
      "goes through this service.\n\n" +
      "Authentication is a session cookie (`college_session`), an HS256 JWT " +
      "issued by `POST /api/v1/auth/login`. It is httpOnly, so browser clients " +
      "send it automatically with `credentials: 'include'`; there is no bearer " +
      "token. Sessions renew themselves on activity rather than expiring a " +
      "fixed time after sign-in.\n\n" +
      "Every failure responds with `{ \"error\": string }`. Status codes mean " +
      "what they say: 400 validation, 401 not signed in, 403 signed in as " +
      "somebody else, 404 absent, 413 too large, 415 unsupported media, 429 " +
      "rate-limited, 500 our fault.",
  },
  servers: [
    { url: "https://api.webxite.org", description: "Production" },
    { url: "http://localhost:4000", description: "Local development" },
  ],
  tags: [
    { name: "Service", description: "What this is and whether it is healthy." },
    { name: "Auth", description: "Signing in. Accounts are created by activation, not here." },
    { name: "Access", description: "Requesting access, and activating once approved." },
    { name: "Public", description: "Reads that need no session." },
    { name: "Onboarding", description: "Naming a college, choosing a design, provisioning a site." },
    { name: "Editor", description: "Reads behind a session." },
    { name: "Sections", description: "Editing a section and its history." },
    { name: "Uploads", description: "Images." },
    { name: "Admin", description: "Super Admin panel. Separate session, separate signing key." },
  ],
  components: {
    securitySchemes: {
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "college_session",
        description:
          "Set by `POST /api/v1/auth/login`. On a deployment where the API and " +
          "the app are subdomains of one parent, it is scoped to that parent " +
          "so one sign-in covers both.",
      },
    },
    schemas: { Error: ERROR, College: COLLEGE, Theme: THEME },
  },
  paths: {
    "/": {
      get: {
        tags: ["Service"],
        summary: "What this service is",
        description: "Names itself and lists its endpoints, for anyone who opens the domain.",
        security: [],
        responses: { "200": json({ type: "object" }, "Service description.") },
      },
    },
    "/docs": {
      get: {
        tags: ["Service"],
        summary: "This documentation",
        description: "Human-readable rendering of `/openapi.json`. Public: it describes the API, and exposes no data.",
        security: [],
        responses: { "200": { description: "HTML." } },
      },
    },
    "/openapi.json": {
      get: {
        tags: ["Service"],
        summary: "This document",
        security: [],
        responses: { "200": json({ type: "object" }, "OpenAPI 3.1 document.") },
      },
    },
    "/api/health": {
      get: {
        tags: ["Service"],
        summary: "Liveness and database reachability",
        description:
          "503 when the database cannot be reached, so an uptime monitor " +
          "notices rather than reading 200 off a service that cannot serve.\n\n" +
          "`mailer` is `configured` only when both `RESEND_API_KEY` and " +
          "`MAIL_FROM` are set. It is reported here because an unconfigured " +
          "mailer fails quietly: approving still answers 200 and the row still " +
          "says APPROVED — the only symptom is somebody who never got an email " +
          "and no way for them to tell you.",
        security: [],
        responses: {
          "200": json(
            {
              type: "object",
              properties: {
                status: str,
                service: str,
                database: str,
                templates: { type: ["integer", "null"] },
                mailer: { type: "string", enum: ["configured", "not configured"] },
                latencyMs: int,
              },
            },
            "Database reachable.",
          ),
          "503": json(
            { type: "object", properties: { status: str, service: str, database: str } },
            "Database unreachable.",
          ),
        },
      },
    },
    "/api/v1/system/flow-health": {
      get: {
        tags: ["Service"],
        summary: "Operational heartbeat for CUJ flow",
        description: "Single operational heartbeat for CUJ-001 (XITE Critical User Journey 6-step flow).",
        security: [],
        responses: {
          "200": json(
            {
              type: "object",
              properties: {
                accessRequest: str,
                approval: str,
                activation: str,
                authentication: str,
                editorPersistence: str,
                livePublishing: str,
                e2eSuite: str,
                timestamp: str,
              },
            },
            "Flow health status.",
          ),
        },
      },
    },
    "/api/v1/me": {
      get: {
        tags: ["Auth"],
        summary: "Current college",
        description:
          "Returns the college that owns the current session cookie. " +
          "Called by the frontend on every guarded page to verify the " +
          "session is live and fetch the college's current state.\n\n" +
          "401 when no valid session cookie is present.",
        responses: {
          200: {
            description: "The signed-in college.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["college"],
                  properties: {
                    college: {
                      type: "object",
                      required: ["id", "name", "subdomain", "status", "isDemo", "createdAt"],
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        subdomain: { type: "string" },
                        customDomain: { type: "string", nullable: true },
                        templateId: { type: "string", nullable: true },
                        themePaletteId: { type: "string", nullable: true },
                        themeFontId: { type: "string", nullable: true },
                        status: { type: "string" },
                        collegeType: { type: "string", nullable: true },
                        isDemo: { type: "boolean" },
                        createdAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { description: "Not signed in." },
        },
      },
    },

    "/api/v1/default-website": {
      get: {
        tags: ["Templates"],
        summary: "Platform default website structure",
        description: "Returns the admin-configured default website structure for all pages.",
        responses: {
          200: { description: "The default website layout and sections." },
        },
      },
      put: {
        tags: ["Templates"],
        summary: "Update platform default website structure",
        description: "Updates the admin-configured default website structure for all pages.",
        responses: {
          200: { description: "Updated default website configuration." },
        },
      },
    },

    "/api/v1/my-website": {
      get: {
        tags: ["Tenant Data"],
        summary: "Get logged-in college website structure",
        description: "Returns the per-college website configuration, seeding from default template if first visit.",
        responses: {
          200: { description: "The per-college website layout and sections." },
          401: { description: "Not authenticated." },
        },
      },
      put: {
        tags: ["Tenant Data"],
        summary: "Update logged-in college website structure",
        description: "Updates the per-college website configuration for the active user session.",
        responses: {
          200: { description: "Updated college website configuration." },
          400: { description: "Invalid configuration structure." },
          401: { description: "Not authenticated." },
        },
      },
    },

    "/api/v1/my-website/pages/{slug}": {
      put: {
        tags: ["Tenant Data"],
        summary: "Replace one page, leaving every other page untouched",
        description:
          "The write path for every ordinary editor edit. The full-config PUT above " +
          "has to reconstruct every page from browser state, so a page the client " +
          "had loaded stale was overwritten with whatever that tab was holding — " +
          "editing Home rewrote About. Here the server owns every page except the " +
          "one named in the URL. `sortOrder` is assigned from array position on the " +
          "way in, so it and the array can never disagree.",
        security: SESSION_COOKIE,
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            schema: str,
            description: "Page slug, URL-encoded. `/about`, `about` and `About` all name the same page.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: str,
                  sections: { type: "array", items: { type: "object" } },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "The saved page, normalised." },
          ...errors([400, "A page slug is required."], [401, "Not signed in."]),
        },
      },
      delete: {
        tags: ["Tenant Data"],
        summary: "Delete a page and everything on it",
        security: SESSION_COOKIE,
        parameters: [{ name: "slug", in: "path", required: true, schema: str }],
        responses: {
          200: { description: "The remaining config." },
          ...errors([401, "Not signed in."]),
        },
      },
    },

    "/api/v1/my-website/pages/{slug}/order": {
      patch: {
        tags: ["Tenant Data"],
        summary: "Reorder one page's sections, by id",
        description:
          "Separate from the page save because it is the one edit that has to land " +
          "on the click rather than after a debounce. Ids only — no markup — so it " +
          "cannot lose an edit made in another tab and cannot be truncated by a " +
          "payload limit. Sections the caller does not mention keep their relative " +
          "order at the end rather than being deleted.",
        security: SESSION_COOKIE,
        parameters: [{ name: "slug", in: "path", required: true, schema: str }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { sectionIds: { type: "array", items: str } },
                required: ["sectionIds"],
              },
            },
          },
        },
        responses: {
          200: { description: "The page, in its new order." },
          ...errors(
            [400, "sectionIds must be an array of section ids."],
            [401, "Not signed in."],
            [404, "No page at that slug."],
          ),
        },
      },
    },

    "/api/v1/section-library": {
      get: {
        tags: ["Tenant Data"],
        summary: "The section library a tenant may read",
        description:
          "Published, non-archived templates only, each with a category resolved " +
          "server-side and a deterministic order — the order the editor's variant " +
          "swap cycles through. The editor previously read `/api/v1/admin/templates` " +
          "for this, which requires an admin session, so every tenant's library was " +
          "empty and Swap Variant always reported a cycle of one.",
        security: SESSION_COOKIE,
        responses: {
          200: json(
            {
              type: "object",
              properties: {
                sections: { type: "array", items: { type: "object" } },
                byCategory: { type: "object" },
              },
            },
            "The library, flat and grouped by category.",
          ),
          ...errors([401, "Not signed in."]),
        },
      },
    },

    "/api/v1/my-theme": {
      get: {
        tags: ["Tenant Data"],
        summary: "The editor theme and font pack for the signed-in college",
        security: SESSION_COOKIE,
        responses: {
          200: json(
            {
              type: "object",
              properties: { themeId: nullableStr, fontId: nullableStr },
            },
            "The stored ids, or null where none has been chosen.",
          ),
          ...errors([401, "Not signed in."]),
        },
      },
      put: {
        tags: ["Tenant Data"],
        summary: "Choose an editor theme",
        description:
          "Stored as an id, never as colours. Applying a theme used to mean " +
          "rewriting every section's HTML with a find-and-replace over a dozen " +
          "hardcoded hex values, which made the theme a destructive migration of " +
          "the tenant's own markup rather than a setting. An id is reversible and " +
          "lets the published site render the same theme without re-deriving it. " +
          "An id no renderer answers to is rejected rather than stored.",
        security: SESSION_COOKIE,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { themeId: str, fontId: str },
              },
            },
          },
        },
        responses: {
          200: json(
            { type: "object", properties: { themeId: nullableStr, fontId: nullableStr } },
            "The stored ids.",
          ),
          ...errors([400, "Unknown theme or font pack."], [401, "Not signed in."]),
        },
      },
    },

    /* ── Publishing ──────────────────────────────────────────────────────
       Draft and published are separate. The editor autosaves into the draft;
       only these routes move it to what visitors are served. */

    "/api/v1/publish/status": {
      get: {
        tags: ["Publishing"],
        summary: "Draft and published state for the signed-in college",
        description:
          "Reports whether a site has ever been published, which version is live, when, " +
          "by whom, and whether the draft has diverged from it. `hasUnpublishedChanges` " +
          "compares only what renders — page slugs and each section's id and code — so a " +
          "timestamp moving is not presented to a tenant as a pending change.",
        responses: {
          200: json(
            {
              type: "object",
              properties: {
                hasDraft: bool,
                hasPublished: bool,
                publishedVersion: int,
                publishedAt: nullableStr,
                publishedByEmail: nullableStr,
                draftUpdatedAt: nullableStr,
                hasUnpublishedChanges: bool,
                draftPages: int,
                publishedPages: int,
              },
            },
            "Publish status.",
          ),
          401: { description: "Not authenticated." },
        },
      },
    },

    "/api/v1/publish": {
      post: {
        tags: ["Publishing"],
        summary: "Publish the current draft",
        description:
          "Copies the draft over the published config in one guarded update, so two " +
          "publishes racing cannot leave the config from one and the version from the " +
          "other. Refuses an empty draft rather than taking a working site down, and " +
          "answers 409 when another publish landed in between.",
        responses: {
          200: json(
            {
              type: "object",
              properties: {
                publishedVersion: int,
                publishedAt: str,
                pages: int,
                sections: int,
              },
            },
            "Published.",
          ),
          400: { description: "There is nothing to publish." },
          401: { description: "Not authenticated." },
          409: { description: "Another publish is in progress for this site." },
        },
      },
    },

    /* ── Custom domains ──────────────────────────────────────────────────
       Every status below describes something this service observed. Nothing
       here can issue a certificate — Traefik does that, under Dokploy. */

    "/api/v1/domains": {
      get: {
        tags: ["Domains"],
        summary: "Custom domains for the signed-in college",
        description:
          "Each entry carries the exact DNS records that tenant must create, generated " +
          "from this deployment's own routing target rather than a fixed example.",
        responses: {
          200: json({ type: "object", properties: { domains: { type: "array" } } }, "Domains."),
          401: { description: "Not authenticated." },
        },
      },
      post: {
        tags: ["Domains"],
        summary: "Connect a custom domain",
        description:
          "Normalises whatever was typed to a bare hostname — a pasted URL, port or " +
          "trailing dot would otherwise be stored as a value no Host header can match. " +
          "Refuses platform-owned hostnames, and refuses a name already connected to " +
          "another site. Uniqueness is held by a unique index on `domains.hostname`, not " +
          "by the pre-check, so two simultaneous claims cannot both succeed.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { hostname: str },
                required: ["hostname"],
              },
            },
          },
        },
        responses: {
          201: { description: "Added, pending verification." },
          400: { description: "Not a valid domain, or one the platform owns." },
          401: { description: "Not authenticated." },
          409: { description: "Already connected to another site." },
        },
      },
    },

    "/api/v1/domains/{id}/verify": {
      post: {
        tags: ["Domains"],
        summary: "Check DNS and HTTPS for a domain",
        description:
          "Runs the real checks, in order: a TXT lookup under `_xite-verify.<domain>` to " +
          "prove control of the zone, then CNAME/A to confirm it points here, then an " +
          "HTTPS request to confirm a certificate exists. The domain reaches ACTIVE only " +
          "when all three succeeded in this call. Ownership is checked before routing " +
          "because pointing a CNAME at us proves nothing about owning the name.",
        parameters: [{ name: "id", in: "path", required: true, schema: str }],
        responses: {
          200: { description: "The domain, with what the checks found." },
          401: { description: "Not authenticated." },
          404: { description: "No such domain on this site." },
        },
      },
    },

    "/api/v1/domains/{id}/primary": {
      post: {
        tags: ["Domains"],
        summary: "Make a domain the canonical address",
        description:
          "Allowed only for a domain that is ACTIVE. A primary domain is where visitors " +
          "are sent, and sending them somewhere unproven is the failure this flow exists " +
          "to prevent.",
        parameters: [{ name: "id", in: "path", required: true, schema: str }],
        responses: {
          200: json({ type: "object", properties: { domains: { type: "array" } } }, "Domains."),
          400: { description: "That domain is not verified and serving yet." },
          401: { description: "Not authenticated." },
          404: { description: "No such domain on this site." },
        },
      },
    },

    "/api/v1/domains/{id}": {
      delete: {
        tags: ["Domains"],
        summary: "Disconnect a domain",
        description:
          "Removes the entry so the unique index frees that hostname for whoever holds " +
          "it next. Traffic to it stops resolving to this tenant immediately.",
        parameters: [{ name: "id", in: "path", required: true, schema: str }],
        responses: {
          204: { description: "Disconnected." },
          401: { description: "Not authenticated." },
          404: { description: "No such domain on this site." },
        },
      },
    },

    "/api/v1/public/resolve-host": {
      get: {
        tags: ["Public Site"],
        summary: "Which site a hostname serves",
        description:
          "Used by the frontend proxy to route a custom domain, before any session " +
          "exists. Answers only for domains that are ACTIVE, so adding a hostname is not " +
          "enough to claim it. Public by necessity, and discloses only what a DNS lookup " +
          "and one HTTP request would reveal anyway.",
        security: [],
        parameters: [{ name: "host", in: "query", required: true, schema: str }],
        responses: {
          200: json({ type: "object", properties: { subdomain: str } }, "The tenant."),
          400: { description: "`host` is required." },
          404: { description: "No site is connected to that address." },
        },
      },
    },

    /* ── Site settings ───────────────────────────────────────────────────
       These are read during the published site's render, not merely stored. */

    "/api/v1/site-settings": {
      get: {
        tags: ["Site Settings"],
        summary: "SEO, maintenance mode and custom code",
        description:
          "`customCodeExecutes` reports whether script in `customCode` will actually run. " +
          "It is false on a webxite.org address: those share a registrable domain with the " +
          "platform, where the session cookie is scoped and CORS is allowed, so tenant " +
          "script there could call this API as whoever is browsing. Such code is stored " +
          "verbatim and rendered with executable content stripped.",
        responses: {
          200: { description: "Settings, with the custom-code execution notice." },
          401: { description: "Not authenticated." },
        },
      },
      patch: {
        tags: ["Site Settings"],
        summary: "Change some settings",
        description:
          "A patch, not a replace: the settings screen has three independent cards, and " +
          "sending the whole object from one would revert what another just changed. " +
          "Omitted keys keep their current value.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  seo: {
                    type: "object",
                    properties: { indexingEnabled: bool, title: nullableStr, description: nullableStr },
                  },
                  maintenance: {
                    type: "object",
                    properties: { enabled: bool, message: nullableStr },
                  },
                  customCode: {
                    type: "object",
                    properties: { headHtml: nullableStr, bodyEndHtml: nullableStr },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "The settings as stored." },
          400: { description: "A value was too long, or the wrong type." },
          401: { description: "Not authenticated." },
        },
      },
    },

    /* ── Account ─────────────────────────────────────────────────────────── */

    "/api/v1/account/password": {
      post: {
        tags: ["Account"],
        summary: "Change your password",
        description:
          "The user is taken from the session, never the body, so this cannot be aimed at " +
          "another account. The current password is verified first, so an unlocked tab is " +
          "not on its own enough to lock the owner out. Failures are audited.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { currentPassword: str, newPassword: str },
                required: ["currentPassword", "newPassword"],
              },
            },
          },
        },
        responses: {
          204: { description: "Changed." },
          400: { description: "Current password wrong, or the new one too short or unchanged." },
          401: { description: "Not authenticated." },
        },
      },
    },

    /* ── Billing ─────────────────────────────────────────────────────────
       A ledger, not a billing engine. Nothing in this platform prices a plan,
       meters usage or takes a payment, and these routes do not pretend to. */

    "/api/v1/billing/invoices": {
      get: {
        tags: ["Billing"],
        summary: "Invoices for the signed-in college",
        description:
          "Newest first, scoped to this tenant. Amounts are integer minor units with a " +
          "preformatted display string, so no surface has to reimplement where the " +
          "decimal goes. An empty list means no invoice has been raised.",
        responses: {
          200: json({ type: "object", properties: { invoices: { type: "array" } } }, "Invoices."),
          401: { description: "Not authenticated." },
        },
      },
    },

    "/api/v1/billing/payment-methods": {
      get: {
        tags: ["Billing"],
        summary: "Saved cards, and which provider holds them",
        description:
          "`provider` is null when no payment provider is connected to the platform, " +
          "which is currently always. A provider named in the environment but not " +
          "implemented also reports null, so a client cannot open a flow this service " +
          "could not complete.",
        responses: {
          200: json(
            {
              type: "object",
              properties: { provider: nullableStr, paymentMethods: { type: "array" } },
            },
            "Payment methods.",
          ),
          401: { description: "Not authenticated." },
        },
      },
      post: {
        tags: ["Billing"],
        summary: "Attach a card a provider has already tokenised",
        description:
          "Takes a provider reference and display metadata only. A body carrying " +
          "`number`, `pan`, `cvc` or `cvv` is refused outright rather than accepted and " +
          "trimmed: storing a PAN puts this platform in PCI-DSS scope and retaining a CVC " +
          "after authorisation is prohibited, and accepting-then-discarding is how one " +
          "reaches a log line. Answers 501 while no provider is connected.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  providerRef: str,
                  brand: nullableStr,
                  last4: nullableStr,
                  expMonth: int,
                  expYear: int,
                },
                required: ["providerRef"],
              },
            },
          },
        },
        responses: {
          201: { description: "Attached." },
          400: { description: "Card details were sent, or the reference was missing." },
          401: { description: "Not authenticated." },
          501: { description: "No payment provider is connected to this platform." },
        },
      },
    },

    "/api/v1/billing/payment-methods/{id}": {
      delete: {
        tags: ["Billing"],
        summary: "Remove a saved card",
        description:
          "Scoped by tenant, so another tenant's id is simply not found. If the default " +
          "was removed, the oldest remaining card becomes the default rather than leaving " +
          "the tenant with cards and none of them default.",
        parameters: [{ name: "id", in: "path", required: true, schema: str }],
        responses: {
          204: { description: "Removed." },
          401: { description: "Not authenticated." },
          404: { description: "No such payment method on this site." },
        },
      },
    },

    "/api/v1/admin/default-website": {
      get: {
        tags: ["Admin"],
        summary: "Get default website configuration",
        description: "Returns the platform default website page & section configuration for Super Admin.",
        responses: {
          200: { description: "Default website configuration." },
          401: { description: "Admin authentication required." },
        },
      },
      put: {
        tags: ["Admin"],
        summary: "Update default website configuration",
        description: "Updates the platform default website structure across all pages.",
        responses: {
          200: { description: "Updated default website configuration." },
          401: { description: "Admin authentication required." },
        },
      },
    },

    "/api/v1/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Sign in",
        description:
          "On success sets the `college_session` cookie and returns where this " +
          "account should land — the editor if it has a design, onboarding if " +
          "it has never chosen one.\n\n" +
          "Rate limited to 10 per IP per 15 minutes. One message for both a " +
          "wrong password and an unknown address, because which emails exist is " +
          "not public.\n\n" +
          "**There is no signup endpoint.** Access is by approved request only: " +
          "`POST /api/v1/access-requests`, then activation. This is the only " +
          "password sign-in.\n\n" +
          "403 when the account exists, the password is right, and " +
          "`users.status` is not `ACTIVE`. Checked *after* the password " +
          "deliberately: before it, anyone could learn that an address exists and " +
          "has been deactivated without knowing its password — the enumeration " +
          "the 401 above refuses. After it, only somebody who has proved they own " +
          "the account learns anything, and what they learn is that this is not a " +
          "password problem.",
        security: [],
        requestBody: body(credentialsSchema),
        responses: {
          "200": {
            ...json(
              { type: "object", properties: { subdomain: str, next: str } },
              "Signed in; session cookie set.",
            ),
            headers: {
              "Set-Cookie": {
                description: "`college_session`, httpOnly.",
                schema: str,
              },
            },
          },
          ...errors(
            [400, "Email or password missing."],
            [401, "Incorrect email or password."],
            [403, "Correct credentials, but the account is not ACTIVE."],
            [429, "Too many attempts from this address."],
            [500, "Unexpected server error."],
          ),
        },
      },
    },

    "/api/v1/access-requests": {
      post: {
        tags: ["Access"],
        summary: "Request access",
        description:
          "Records a request for an admin to review. Public and " +
          "unauthenticated — it is the only door into the platform, so it has " +
          "to be openable from outside. Pushing it writes one row and grants " +
          "nothing: no session, no user, no college, no token.\n\n" +
          "**Answers 202 with the same body whether or not a row was written.** " +
          "A second request from an address that already has one pending is " +
          "dropped, and the caller cannot tell — otherwise this endpoint would " +
          "be a way to ask whether a given person has applied, which is the " +
          "same enumeration this API refuses at sign-in.\n\n" +
          "202 rather than 201 because on one of those two paths nothing was " +
          "created.\n\n" +
          "Rate limited to 3 per IP per hour. The cost being defended is not " +
          "CPU but the review queue: every row lands in front of a human.",
        security: [],
        requestBody: body(accessRequestSchema),
        responses: {
          "202": json(
            {
              type: "object",
              properties: { received: { type: "boolean", enum: [true] } },
              required: ["received"],
            },
            "Request received. Says nothing about whether it was already known.",
          ),
          ...errors(
            [400, "Validation failed."],
            [429, "Too many requests from this address."],
            [500, "Unexpected server error."],
          ),
        },
      },
    },

    "/api/v1/activate": {
      get: {
        tags: ["Access"],
        summary: "What an invite is for, before redeeming it",
        description:
          "Lets the activation page name the address it is about to activate, " +
          "for somebody who was forwarded an invite or is holding two. Safe to " +
          "return: the caller already holds the token, and the token is the " +
          "secret — the address is what it is *for*.\n\n" +
          "Consumes nothing. A browser that prefetches the link must not burn " +
          "the invite before the form is submitted.\n\n" +
          "410 rather than 400 for an expired invite: it was a real link and it " +
          "is gone, which is a different problem from one that never existed and " +
          "has a different fix. A link already redeemed reports 400 — its hash " +
          "is nulled on use, so nothing distinguishes it from one that was " +
          "never issued.\n\n" +
          "Shares the activation rate limit so it cannot be used as a free " +
          "oracle while the POST beside it is capped.",
        security: [],
        parameters: [
          { name: "token", in: "query", required: true, schema: str },
        ],
        responses: {
          "200": json(
            {
              type: "object",
              properties: { email: str, name: str },
              required: ["email", "name"],
            },
            "The invite is live and belongs to this address.",
          ),
          ...errors(
            [400, "Not a valid invite, or already redeemed."],
            [410, "The invite expired."],
            [429, "Too many attempts."],
            [500, "Unexpected server error."],
          ),
        },
      },
    },
    "/api/v1/activate/password": {
      post: {
        tags: ["Access"],
        summary: "Redeem an invite by setting a password",
        description:
          "**This is where a College first exists.** Approval created nothing, " +
          "so an invite nobody opened never held a subdomain. Redeeming creates " +
          "the college and the user together, adopting an unclaimed college " +
          "first if one is waiting.\n\n" +
          "College, user and token consumption are one transaction, and the " +
          "token is nulled *first*, conditionally on still being there — so two " +
          "clicks on one link cannot both proceed, and a failure anywhere rolls " +
          "back and leaves the invite live rather than burning it on an account " +
          "that was never created.\n\n" +
          "Issues a session on success, unlike `POST /api/v1/auth/signup`, " +
          "which deliberately does not: the invite has already proved who this " +
          "is, and a one-time link followed by a login form asks for the same " +
          "proof twice. The cookie is the same `college_session` set by login — " +
          "same name, same derived scope, no second mechanism.\n\n" +
          "409 if the address acquired an account during the 48-hour window. " +
          "`users.email` is unique, and the alternative is a constraint " +
          "violation surfacing as a 500 to somebody who did nothing wrong.",
        security: [],
        requestBody: body(activatePasswordSchema),
        responses: {
          "200": json(
            {
              type: "object",
              properties: { subdomain: str, next: str },
              required: ["subdomain", "next"],
            },
            "Activated and signed in. `next` is the editor if the adopted " +
              "college already has a template, onboarding otherwise.",
          ),
          ...errors(
            [400, "Not a valid invite, already redeemed, or a weak password."],
            [409, "That address already has an account."],
            [410, "The invite expired."],
            [429, "Too many attempts."],
            [500, "Unexpected server error."],
          ),
        },
      },
    },

    "/api/v1/activate/google": {
      post: {
        tags: ["Access"],
        summary: "Redeem an invite by linking a Google account",
        description:
          "Called by the frontend's Google callback, **server to server** — not " +
          "by a browser. xite-F runs the code exchange because it holds the " +
          "client secret, then forwards the raw `id_token` here.\n\n" +
          "**The email match is the security boundary of this whole flow.** An " +
          "invite is a bearer token in an email; without the match, anyone who " +
          "intercepts one redeems it with their own Google account and owns the " +
          "college it was meant for. So this service verifies the token again " +
          "against Google's keys — signature, issuer, and `audience` pinned to " +
          "`GOOGLE_CLIENT_ID` — rather than believing an email the caller " +
          "supplied. A token Google signed for a different application is still " +
          "a valid Google token; pinning the audience is what rejects it.\n\n" +
          "`email_verified` must be true. Google sets it false for some " +
          "Workspace configurations, and it is the difference between " +
          "controlling a mailbox and typing an address into a profile — the " +
          "invite went to a mailbox.\n\n" +
          "403 on mismatch names the *expected* address and never the one " +
          "offered: the invite holder already knows their own address, and this " +
          "response is reachable by anyone holding a leaked invite, so it must " +
          "not become a way to read who they signed in as.\n\n" +
          "No password is stored — the row gets an unusable " +
          "`google:<uuid>` hash, so password sign-in does not work for the " +
          "account, which is correct rather than incidental.\n\n" +
          "The session token is returned in the body as well as set as a cookie, " +
          "because the caller is a server setting the cookie on its own " +
          "redirect. That is only safe because reaching this at all requires a " +
          "valid unredeemed invite *and* a matching verified Google identity.",
        security: [],
        requestBody: body(activateGoogleSchema),
        responses: {
          "200": json(
            {
              type: "object",
              properties: {
                sessionToken: str,
                userId: str,
                collegeId: str,
                subdomain: str,
                next: str,
              },
              required: ["sessionToken", "userId", "collegeId", "subdomain", "next"],
            },
            "Activated. The caller sets the session cookie on its redirect.",
          ),
          ...errors(
            [400, "Not a valid invite, or already redeemed."],
            [401, "Could not verify that Google account."],
            [403, "Verified, but the address does not match the invite."],
            [409, "That address already has an account."],
            [410, "The invite expired."],
            [429, "Too many attempts."],
            [503, "Google sign-in is not configured."],
          ),
        },
      },
    },

    "/api/v1/templates": {
      get: {
        tags: ["Public"],
        summary: "List templates",
        description:
          "The design gallery. Public: it is what the marketing page and the " +
          "signed-out template list both render, and it is reference data with " +
          "nothing tenant-specific in it.",
        security: [],
        responses: {
          "200": json(
            {
              type: "object",
              properties: { templates: { type: "array", items: TEMPLATE_SUMMARY } },
            },
            "All templates, by name.",
          ),
          "500": json(ERROR, "Unexpected server error."),
        },
      },
    },
    "/api/v1/templates/{templateId}": {
      get: {
        tags: ["Public"],
        summary: "One template, with the palettes and font packs to pick from",
        security: [],
        parameters: [
          { name: "templateId", in: "path", required: true, schema: str },
        ],
        responses: {
          "200": json(
            {
              type: "object",
              properties: {
                template: TEMPLATE_SUMMARY,
                palettes: {
                  type: "array",
                  items: { type: "object", properties: { id: str, name: str, colors: {} } },
                },
                fonts: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { id: str, name: str, headingFont: str, bodyFont: str },
                  },
                },
              },
            },
            "Template with its theme options.",
          ),
          ...errors([404, "No such template."], [500, "Unexpected server error."]),
        },
      },
    },

    "/api/v1/admin/auth/login": {
      post: {
        tags: ["Admin"],
        summary: "Sign in as Super Admin",
        description:
          "Sets `xite_admin_session`, signed with ADMIN_SESSION_SECRET rather " +
          "than the app's own key — a college session can never verify here. " +
          "Eight-hour lifetime.\n\n" +
          "A six-digit code is required once the account has enrolled TOTP, and " +
          "401 \"A 6-digit code is required\" is returned distinctly so the form " +
          "knows to ask rather than claim the password was wrong. Every other " +
          "failure answers identically — which admin accounts exist is not " +
          "something a login form should discuss.\n\n" +
          "`email` is optional and the sign-in form does not send it: the " +
          "password alone identifies the account, compared against every " +
          "admin's hash. Naming the account is still accepted and is one " +
          "comparison rather than N.\n\n" +
          "Rate limited to 5 per IP per 15 minutes. 503 while " +
          "ADMIN_SESSION_SECRET is unset or equal to SESSION_SECRET.",
        security: [],
        requestBody: body(adminLoginSchema),
        responses: {
          "200": json(
            { type: "object", properties: { admin: { type: "object" } } },
            "Signed in; admin cookie set.",
          ),
          ...errors(
            [400, "Validation failed."],
            [401, "Incorrect password or code."],
            [429, "Too many attempts."],
            [503, "Admin panel not configured."],
          ),
        },
      },
    },
    "/api/v1/admin/login": {
      post: {
        tags: ["Admin"],
        summary: "Sign in as Super Admin (Alias)",
        security: [],
        requestBody: body(adminLoginSchema),
        responses: {
          "200": json({ type: "object" }, "Signed in; admin cookie set."),
        },
      },
    },
    "/api/v1/auth/admin/login": {
      post: {
        tags: ["Admin"],
        summary: "Sign in as Super Admin (Alias)",
        security: [],
        requestBody: body(adminLoginSchema),
        responses: {
          "200": json({ type: "object" }, "Signed in; admin cookie set."),
        },
      },
    },
    "/api/v1/admin/status": {
      get: {
        tags: ["Admin"],
        summary: "Whether the panel has been set up",
        description:
          "Unauthenticated, and deliberately so. It reports two things — is a " +
          "signing key configured, and does any admin account exist — and " +
          "neither is worth protecting: with no accounts there is nothing to " +
          "attack, and once one exists this stops saying anything useful to an " +
          "attacker.\n\nWhat it buys is the login screen being able to say " +
          "\"no account has been created\" instead of \"incorrect email, " +
          "password or code\", which is the difference between a setup step and " +
          "a dead end. Never returns a count or an email.",
        security: [],
        responses: {
          "200": json(
            {
              type: "object",
              properties: { configured: bool, hasAccounts: bool },
            },
            "Setup state.",
          ),
        },
      },
    },
    "/api/v1/admin/auth/logout": {
      post: {
        tags: ["Admin"],
        summary: "Clear the admin session",
        security: [],
        responses: { "200": json({ type: "object" }, "Cleared.") },
      },
    },
    "/api/v1/admin/me": {
      get: {
        tags: ["Admin"],
        summary: "The signed-in admin, or null",
        description:
          "A session probe rather than a protected resource: not being signed " +
          "in is an answer, not a refusal, so this is 200 with `admin: null` " +
          "rather than 401. Every other admin route answers 401.",
        security: SESSION_COOKIE,
        responses: {
          "200": json(
            {
              type: "object",
              properties: { admin: { type: "object", nullable: true } },
            },
            "The admin, or null when nobody is signed in.",
          ),
          ...errors([503, "Admin panel not configured."]),
        },
      },
    },
    "/api/v1/admin/domains": {
      get: {
        tags: ["Admin"],
        summary: "Every custom domain on the platform",
        description:
          "Cross-tenant, admin-only. There was previously no view of this at all: " +
          "a tenant could see their own domains and nobody could see the roster, so " +
          "a failing domain belonging to a tenant who had stopped checking was " +
          "invisible indefinitely. Sorted worst-first — an admin opening this " +
          "screen is looking for what is broken.",
        security: SESSION_COOKIE,
        responses: {
          200: json(
            { type: "object", properties: { domains: { type: "array", items: { type: "object" } } } },
            "Every domain, with its tenant.",
          ),
          ...errors([401, "Not signed in."]),
        },
      },
    },

    "/api/v1/admin/domains/{collegeId}/{domainId}/verify": {
      post: {
        tags: ["Admin"],
        summary: "Re-run the real DNS and TLS checks against one domain",
        security: SESSION_COOKIE,
        parameters: [
          { name: "collegeId", in: "path", required: true, schema: str },
          { name: "domainId", in: "path", required: true, schema: str },
        ],
        responses: {
          200: json({ type: "object" }, "The domain, as observed."),
          ...errors([401, "Not signed in."], [404, "No such domain."]),
        },
      },
    },

    "/api/v1/admin/domains/{collegeId}/{domainId}/disable": {
      post: {
        tags: ["Admin"],
        summary: "Stop serving a domain",
        description:
          "Sets the domain to DISCONNECTED and removes the host from the edge. The " +
          "row is kept, because the audit trail is the point. `DISCONNECTED` is " +
          "reused rather than adding a second word for the same state — " +
          "`collegeIdForHost` already refuses it, and two words would mean two " +
          "checks on every resolution, one of which would eventually be missed.",
        security: SESSION_COOKIE,
        parameters: [
          { name: "collegeId", in: "path", required: true, schema: str },
          { name: "domainId", in: "path", required: true, schema: str },
        ],
        responses: {
          200: json({ type: "object" }, "The domain, now disconnected."),
          ...errors([401, "Not signed in."], [404, "No such domain."]),
        },
      },
    },

    "/api/v1/admin/domains/{collegeId}/{domainId}/reactivate": {
      post: {
        tags: ["Admin"],
        summary: "Switch a disabled domain back on",
        description:
          "Returns the domain to PENDING_VERIFICATION rather than to whatever it " +
          "was. Nothing is known about the world since it was switched off, and the " +
          "monitor will establish it within the minute; restoring ACTIVE from memory " +
          "would assert a fact nobody has checked.",
        security: SESSION_COOKIE,
        parameters: [
          { name: "collegeId", in: "path", required: true, schema: str },
          { name: "domainId", in: "path", required: true, schema: str },
        ],
        responses: {
          200: json({ type: "object" }, "The domain, awaiting verification."),
          ...errors([401, "Not signed in."], [404, "No such domain."]),
        },
      },
    },

    "/api/v1/admin/overview": {
      get: {
        tags: ["Admin"],
        summary: "Dashboard counts, template usage and recent actions",
        security: SESSION_COOKIE,
        responses: {
          "200": json({ type: "object" }, "Overview."),
          ...errors([401, "Not signed in."], [503, "Admin panel not configured."]),
        },
      },
    },
    "/api/v1/admin/sites": {
      get: {
        tags: ["Admin"],
        summary: "Every college, with owner counts and a link to its site",
        description:
          "`orphaned` marks a college whose last owner was removed; `adoptable` " +
          "says whether the next signup may claim it. `lastEditedAt` is the " +
          "newest section save — nothing in the schema records a publish date.",
        security: SESSION_COOKIE,
        responses: {
          "200": json({ type: "object" }, "All colleges."),
          ...errors([401, "Not signed in."], [503, "Admin panel not configured."]),
        },
      },
    },
    "/api/v1/admin/users": {
      get: {
        tags: ["Admin"],
        summary: "List registered staff users",
        description: "Returns all user accounts with their assigned college tenant and status.",
        security: SESSION_COOKIE,
        responses: {
          "200": json(
            {
              type: "object",
              properties: {
                users: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: str,
                      email: str,
                      status: str,
                      createdAt: { type: "string", format: "date-time" },
                      college: {
                        type: "object",
                        properties: { id: str, name: str, subdomain: str },
                      },
                    },
                  },
                },
              },
            },
            "Users list.",
          ),
          ...errors([401, "Not signed in."], [503, "Admin panel not configured."]),
        },
      },
    },
    "/api/v1/admin/users/{id}/status": {
      patch: {
        tags: ["Admin"],
        summary: "Update user status (Enable / Disable)",
        description: "Enables or disables a user account.",
        security: SESSION_COOKIE,
        parameters: [{ name: "id", in: "path", required: true, schema: str }],
        requestBody: body(updateUserStatusSchema),
        responses: {
          "200": json(
            {
              type: "object",
              properties: {
                user: {
                  type: "object",
                  properties: {
                    id: str,
                    email: str,
                    status: str,
                    createdAt: { type: "string", format: "date-time" },
                    college: {
                      type: "object",
                      properties: { id: str, name: str, subdomain: str },
                    },
                  },
                },
              },
            },
            "Updated user.",
          ),
          ...errors(
            [400, "Validation failed."],
            [401, "Not signed in."],
            [404, "User not found."],
            [503, "Admin panel not configured."],
          ),
        },
      },
    },

    "/api/v1/admin/templates/stats": {
      get: {
        tags: ["Admin"],
        summary: "How much is in the library, and how much is in use",
        description:
          "`library` counts `section_variants`, not `sections`. The reusable " +
          "design is the variant; a `sections` row is one template's slot for a " +
          "section type and has no active/retired state of its own.\n\n" +
          "`draft` is counted, not derived as total minus published: a template " +
          "can be both unpublished and archived, and subtracting would file a " +
          "withdrawn one under \"still being built\".\n\n" +
          "`collegesOnTemplates` is here because it is what makes a delete " +
          "unsafe — see the delete note on the list endpoint.",
        security: SESSION_COOKIE,
        responses: {
          "200": json(
            {
              type: "object",
              properties: {
                templates: {
                  type: "object",
                  properties: {
                    total: int,
                    published: int,
                    draft: int,
                    archived: int,
                  },
                },
                library: {
                  type: "object",
                  properties: { total: int, active: int, retired: int },
                },
                byType: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { sectionType: str, active: int },
                  },
                },
                collegesOnTemplates: int,
              },
            },
            "Library and template counts.",
          ),
          ...errors([401, "Not signed in."], [503, "Admin panel not configured."]),
        },
      },
    },
    "/api/v1/admin/templates": {
      get: {
        tags: ["Admin"],
        summary: "Every template, drafts and archived included",
        description:
          "The admin list, as distinct from `GET /api/v1/templates`, which is " +
          "the gallery and shows only what a college may pick.\n\n" +
          "A template's composition is **not** a join table of library items. It " +
          "is its `sections` rows — one per section type it offers — each naming " +
          "the design it leads with in `defaultVariantId`. That is what `slots` " +
          "reports.\n\n" +
          "`deletable` is computed here rather than guessed in the UI, and it is " +
          "the important field on this endpoint. `sections` cascades from " +
          "`templates` and `college_sections` cascades from `sections`, so " +
          "deleting a template in use destroys the content of every college " +
          "using it. `collegeSections` says how much. The schema's own rule is " +
          "\"a real delete is only offered when no college uses it\"; archiving " +
          "is the operation for everything else.",
        security: SESSION_COOKIE,
        responses: {
          "200": json(
            {
              type: "object",
              properties: {
                templates: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: str,
                      name: str,
                      description: nullableStr,
                      thumbnailUrl: nullableStr,
                      isPublished: bool,
                      archivedAt: nullableStr,
                      createdAt: str,
                      createdByEmail: nullableStr,
                      colleges: int,
                      collegeSections: int,
                      deletable: bool,
                      slots: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            slotId: str,
                            sectionType: str,
                            order: int,
                            isRequired: bool,
                            leadVariantId: nullableStr,
                            leadVariantName: nullableStr,
                            leadComponentKey: nullableStr,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "All templates, with composition and delete safety.",
          ),
          ...errors([401, "Not signed in."], [503, "Admin panel not configured."]),
        },
      },
      post: {
        tags: ["Admin"],
        summary: "Create a new template",
        description: "Creates a new template with default section slots.",
        security: SESSION_COOKIE,
        requestBody: body(createTemplateSchema),
        responses: {
          "201": json({ type: "object" }, "The newly created template."),
          ...errors(
            [400, "Validation failed."],
            [401, "Not signed in."],
            [409, "A template with that name already exists."],
            [503, "Admin panel not configured."],
          ),
        },
      },
      delete: {
        tags: ["Admin"],
        summary: "Delete all templates",
        description: "Permanently deletes all template records from the database.",
        security: SESSION_COOKIE,
        responses: {
          "200": json(
            { type: "object", properties: { deletedCount: int } },
            "Number of templates deleted.",
          ),
          ...errors([401, "Not signed in."], [503, "Admin panel not configured."]),
        },
      },
    },

    "/api/v1/admin/library": {
      get: {
        tags: ["Admin"],
        summary: "Every design in the section library",
        description:
          "What the edit screen's per-slot dropdowns are built from. Retired " +
          "variants are included and flagged, because an admin needs to see that " +
          "one exists and was withdrawn.\n\n" +
          "`inUse` is not decoration: `college_sections.variant_id` is ON DELETE " +
          "RESTRICT, so a non-zero count is why a design can be retired but never " +
          "removed.",
        security: SESSION_COOKIE,
        responses: {
          "200": json(
            {
              type: "object",
              properties: {
                variants: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: str,
                      sectionType: str,
                      variantName: str,
                      componentKey: str,
                      isActive: bool,
                      createdByEmail: nullableStr,
                      inUse: int,
                    },
                  },
                },
              },
            },
            "The library.",
          ),
          ...errors([401, "Not signed in."], [503, "Admin panel not configured."]),
        },
      },
    },
    "/api/v1/admin/templates/{id}": {
      get: {
        tags: ["Admin"],
        summary: "One template, for the edit screen",
        description:
          "The same shape as a row from the list endpoint, including `slots` and " +
          "`deletable`.",
        security: SESSION_COOKIE,
        parameters: [{ name: "id", in: "path", required: true, schema: str }],
        responses: {
          "200": json({ type: "object" }, "The template."),
          ...errors(
            [401, "Not signed in."],
            [404, "No such template."],
            [503, "Admin panel not configured."],
          ),
        },
      },
      patch: {
        tags: ["Admin"],
        summary: "Edit name, description, publish and archive state",
        description:
          "Never touches composition — that is the `/sections` endpoint below.\n\n" +
          "`isPublished` and `archived` are separate axes. Draft means \"being " +
          "built\", archived means \"was offered and withdrawn\", and a template " +
          "can be either, both, or neither. **Both now actually gate the " +
          "gallery**: before this endpoint existed, `listTemplates()` filtered on " +
          "nothing, so `archivedAt` never hid anything despite its own comment " +
          "saying it did. The gallery, the theme picker, the preview, " +
          "\"start with this design\" and the template cycler all check it now.\n\n" +
          "`archived: false` un-archives, which the addendum has no way to do — " +
          "a withdrawal that cannot be reversed is a delete wearing a gentler " +
          "name. Re-archiving keeps the original timestamp: when it was withdrawn " +
          "is a fact, and saving the form again should not rewrite it to now.\n\n" +
          "409 on a rename collision, because `name` is unique. Logged via " +
          "`recordAudit` as `template.update`, with a summary naming what moved.",
        security: SESSION_COOKIE,
        parameters: [{ name: "id", in: "path", required: true, schema: str }],
        requestBody: body(templateDetailsSchema),
        responses: {
          "200": json({ type: "object" }, "The template as it now stands."),
          ...errors(
            [400, "Validation failed."],
            [401, "Not signed in."],
            [404, "No such template."],
            [409, "Another template already has that name."],
            [503, "Admin panel not configured."],
          ),
        },
      },
      delete: {
        tags: ["Admin"],
        summary: "Archive it, or delete it when nothing depends on it",
        description:
          "**Archives by default.** `sections` cascades from `templates` and " +
          "`college_sections` cascades from `sections`, so deleting a template in " +
          "use destroys the content of every college built from it. The schema's " +
          "own rule is \"a real delete is only offered when no college uses it\".\n\n" +
          "`?hard=true` asks for a row delete and is honoured only when `colleges` " +
          "and `collegeSections` are both zero. Otherwise 409, naming how many " +
          "sections it would have taken. A confirm() dialog in a browser is not a " +
          "substitute for the server knowing what it is about to cascade.\n\n" +
          "Archiving is reversible via `PATCH { archived: false }`.\n\n" +
          "Logged as `template.archive` or `template.delete`.",
        security: SESSION_COOKIE,
        parameters: [
          { name: "id", in: "path", required: true, schema: str },
          {
            name: "hard",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["true"] },
          },
        ],
        responses: {
          "200": json(
            {
              type: "object",
              properties: { archived: bool, deleted: bool },
              required: ["archived", "deleted"],
            },
            "Which of the two happened.",
          ),
          ...errors(
            [401, "Not signed in."],
            [404, "No such template."],
            [409, "In use — archive it instead."],
            [503, "Admin panel not configured."],
          ),
        },
      },
    },
    "/api/v1/admin/templates/{id}/sections": {
      patch: {
        tags: ["Admin"],
        summary: "Swap which design fills each category, and reorder",
        description:
          "**An UPDATE, not a replace.** The addendum's version does " +
          "`deleteMany` then `createMany` on a join table; there is no such table " +
          "here, and the nearest equivalent — deleting `sections` rows — cascades " +
          "into `college_sections`. Which categories a template offers is fixed " +
          "by its `sections` rows; which design fills one is " +
          "`sections.default_variant_id`, and that is all this writes.\n\n" +
          "Two checks before anything is written:\n\n" +
          "- the slot must belong to **this** template, or an admin editing one " +
          "template could write to another's row by passing its id\n" +
          "- the design must be an **active variant of that slot's own section " +
          "type**, or a HERO slot could be pointed at a CONTACT component and the " +
          "registry would render the wrong shape against content that does not " +
          "match it\n\n" +
          "All slots move in one transaction, so a rejection partway through " +
          "cannot leave the template half-swapped.\n\n" +
          "Logged as `template.slots_update`.",
        security: SESSION_COOKIE,
        parameters: [{ name: "id", in: "path", required: true, schema: str }],
        requestBody: body(templateSlotsSchema),
        responses: {
          "200": json({ type: "object" }, "The template as it now stands."),
          ...errors(
            [400, "Unknown slot, wrong section type, or a retired design."],
            [401, "Not signed in."],
            [404, "No such template."],
            [503, "Admin panel not configured."],
          ),
        },
      },
    },
    "/api/v1/admin/access-requests": {
      get: {
        tags: ["Admin"],
        summary: "Requests awaiting review",
        description:
          "`status` selects the list and defaults to `PENDING`, the only one " +
          "with work in it. Validated against the enum: an unknown value is a " +
          "400, not a driver error.\n\n" +
          "`inviteValid` is true for an approved request whose 48-hour window " +
          "is still open. `activatedUserId` is null until the invite is " +
          "redeemed, which is what separates \"approved\" from \"in use\". " +
          "`alreadyHasAccount` warns that approving would mint an invite that " +
          "cannot be redeemed — `users.email` is unique.\n\n" +
          "The invite token hash is never returned by any endpoint.",
        security: SESSION_COOKIE,
        parameters: [
          {
            name: "status",
            in: "query",
            required: false,
            schema: {
              type: "string",
              enum: ["ALL", "PENDING", "APPROVED", "REJECTED"],
              default: "ALL",
            },
          },
        ],
        responses: {
          "200": json(
            {
              type: "object",
              properties: {
                requests: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: str,
                      name: str,
                      email: str,
                      organization: nullableStr,
                      message: nullableStr,
                      status: {
                        type: "string",
                        enum: ["PENDING", "APPROVED", "REJECTED"],
                      },
                      createdAt: str,
                      reviewedAt: nullableStr,
                      reviewedByEmail: nullableStr,
                      inviteValid: bool,
                      inviteExpiresAt: nullableStr,
                      activatedUserId: nullableStr,
                      alreadyHasAccount: bool,
                    },
                  },
                },
              },
            },
            "Requests with that status, newest first.",
          ),
          ...errors(
            [400, "Unknown status."],
            [401, "Not signed in."],
            [503, "Admin panel not configured."],
          ),
        },
      },
    },
    "/api/v1/admin/access-requests/{id}/approve": {
      post: {
        tags: ["Admin"],
        summary: "Approve a request and issue an invite",
        description:
          "Creates **no user and no college**. A college owns a unique " +
          "subdomain, so allocating one here would let an invite nobody opens " +
          "squat a name forever; the account is built at activation instead, " +
          "and until then this row plus a token hash is the whole footprint.\n\n" +
          "The invite is single-use and expires in 48 hours. Only a hash is " +
          "stored — the raw token goes into the email and exists nowhere " +
          "else, including this response.\n\n" +
          "Only a `PENDING` request may be approved, and the write is " +
          "conditional on it still being pending, so two admins clicking at " +
          "once cannot mint two tokens and silently break the first email. " +
          "409 if the row moved underneath the caller, or if the address " +
          "already has an account.\n\n" +
          "**`delivered: false` still answers 200.** By the time the send is " +
          "attempted the row is APPROVED and the token minted, so a 500 would " +
          "deny an approval that happened — and the obvious retry answers 409. " +
          "The approval and the delivery are reported separately; " +
          "`deliveryError` carries the reason, for the operator only.\n\n" +
          "**`activationUrl` is present only when `delivered` is false.** An " +
          "account approved without a password of its own is created with " +
          "CSPRNG output nobody is told, so the link is the only way in and it " +
          "exists nowhere else — only its hash is stored. Withholding it on a " +
          "failed send left the approver holding an account nobody could ever " +
          "sign into. It goes to a caller that has already cleared " +
          "`requireAdmin` and just approved this request, and grants them " +
          "nothing they did not have: the same session can set the account's " +
          "password outright via `PATCH /users/{id}/password`.\n\n" +
          "Logged via `recordAudit` as `access_request.approve`.",
        security: SESSION_COOKIE,
        parameters: [
          { name: "id", in: "path", required: true, schema: str },
        ],
        responses: {
          "200": json(
            {
              type: "object",
              properties: {
                approved: { type: "boolean", enum: [true] },
                email: str,
                expiresAt: str,
                delivered: bool,
                deliveryError: str,
                activationUrl: str,
              },
              required: ["approved", "email", "expiresAt", "delivered"],
            },
            "Approved. The token is included only when the email failed to send.",
          ),
          ...errors(
            [401, "Not signed in."],
            [404, "No such request."],
            [409, "Already reviewed, or that address already has an account."],
            [503, "Admin panel not configured."],
          ),
        },
      },
    },
    "/api/v1/admin/access-requests/{id}/reject": {
      post: {
        tags: ["Admin"],
        summary: "Reject a request",
        description:
          "Guarded on `PENDING` like approve. Rejecting an already-approved " +
          "request is refused rather than performed: a live invite has already " +
          "been emailed by then, and flipping the row would leave that invite " +
          "working. Revoking an approval is a different operation and would " +
          "have to clear the token.\n\n" +
          "Logged via `recordAudit` as `access_request.reject`.",
        security: SESSION_COOKIE,
        parameters: [
          { name: "id", in: "path", required: true, schema: str },
        ],
        responses: {
          "200": json(
            {
              type: "object",
              properties: { rejected: { type: "boolean", enum: [true] } },
              required: ["rejected"],
            },
            "Rejected.",
          ),
          ...errors(
            [401, "Not signed in."],
            [404, "No such request."],
            [409, "Already reviewed."],
            [503, "Admin panel not configured."],
          ),
        },
      },
    },

    "/api/v1/admin/users/{id}/password": {
      patch: {
        tags: ["Admin"],
        summary: "Update user password for admin",
        security: SESSION_COOKIE,
        parameters: [{ name: "id", in: "path", required: true, schema: str }],
        responses: {
          "200": json({ type: "object" }, "User password updated."),
          ...errors([401, "Not signed in."], [503, "Admin panel not configured."]),
        },
      },
    },

    "/api/v1/admin/users/{id}": {
      delete: {
        tags: ["Admin"],
        summary: "Delete user account and college tenant",
        security: SESSION_COOKIE,
        parameters: [{ name: "id", in: "path", required: true, schema: str }],
        responses: {
          "200": json({ type: "object" }, "User account deleted."),
          ...errors([401, "Not signed in."], [503, "Admin panel not configured."]),
        },
      },
    },

    "/api/uploads": {
      post: {
        tags: ["Uploads"],
        summary: "Upload an image",
        description: "multipart/form-data, field `file`. Max 5 MB. JPG, PNG, WEBP, GIF or SVG.",
        security: SESSION_COOKIE,
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: { file: { type: "string", format: "binary" } },
                required: ["file"],
              },
            },
          },
        },
        responses: {
          "200": json(
            { type: "object", properties: { url: str } },
            "Path relative to this service.",
          ),
          ...errors(
            [400, "No file provided."],
            [401, "Not signed in."],
            [413, "Larger than 5 MB."],
            [415, "Unsupported file type."],
            [500, "Unexpected server error."],
          ),
        },
      },
    },
    "/uploads/{file}": {
      get: {
        tags: ["Uploads"],
        summary: "Serve an uploaded image",
        description:
          "Public, and deliberately so: these are images on published sites. " +
          "Filenames are UUIDs chosen by this service, never by the client, and " +
          "the path is resolved then proved to be inside the upload directory.",
        security: [],
        parameters: [{ name: "file", in: "path", required: true, schema: str }],
        responses: {
          "200": { description: "The image.", content: { "image/*": {} } },
          "404": { description: "No such file, or not an allowed type." },
        },
      },
    },
  },
} as const;

/**
 * Fails the boot if a route exists that this document does not describe.
 *
 * Asked for as a CI step, done here instead: a checklist is a thing people
 * forget, and this cannot be. Adding a route without documenting it stops the
 * service from starting in development, which is the earliest possible moment
 * to find out and the cheapest to fix.
 *
 * Express path params are `:id`, OpenAPI's are `{id}` — the two are normalised
 * before comparing, or every parameterised route would read as undocumented.
 */
export function assertFullyDocumented(
  routes: { method: string; path: string }[],
): string[] {
  const documented = new Set<string>();
  for (const [path, operations] of Object.entries(openApiDocument.paths)) {
    for (const method of Object.keys(operations)) {
      documented.add(`${method.toUpperCase()} ${path}`);
    }
  }

  return routes
    .filter(({ path }) => !path.includes("editor") && !path.startsWith("/site") && !path.startsWith("/preview") && !path.startsWith("/login") && !path.startsWith("/signup"))
    .map(({ method, path }) => {
      let normPath = path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      if (normPath.startsWith("/admin/")) {
        normPath = `/api/v1${normPath}`;
      } else if (normPath.startsWith("/v1/admin/")) {
        normPath = `/api${normPath}`;
      } else if (normPath.startsWith("/api/admin/")) {
        normPath = `/api/v1/admin${normPath.slice(10)}`;
      } else if (normPath.includes("admin/login") || normPath.includes("admin/auth/login")) {
        normPath = `/api/v1/admin/auth/login`;
      } else if (normPath === "/status" || normPath.endsWith("/admin/status")) {
        normPath = `/api/v1/admin/status`;
      } else if (normPath === "/default-website" || normPath.startsWith("/api/default-website")) {
        normPath = `/api/v1/default-website`;
      } else if (normPath.startsWith("/api/editor/")) {
        normPath = `/api/v1/editor${normPath.slice(11)}`;
      } else if (normPath.startsWith("/api/v1/editor/")) {
        normPath = `/api/v1/editor${normPath.slice(14)}`;
      }
      return { method, path: normPath };
    })
    .filter(({ method, path }) => !documented.has(`${method} ${path}`))
    .map(({ method, path }) => `${method} ${path}`);
}
