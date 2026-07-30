import { z } from "zod";

import {
  accessRequestSchema,
  activateGoogleSchema,
  activatePasswordSchema,
} from "@/access-service";
import { credentialsSchema } from "@/auth-service";
import { startWithDesignSchema } from "@/design-service";
import { adminLoginSchema } from "@/admin-service";
import { templateDetailsSchema, templateSlotsSchema } from "@/library-service";
import { onboardingSchema } from "@/onboarding-service";
import { restoreSchema, saveSchema } from "@/sections-service";

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
      "The API behind xite.co.in. Every read and write the frontend performs " +
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
    { url: "https://api.xite.co.in", description: "Production" },
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
    "/api/v1/sites/{subdomain}": {
      get: {
        tags: ["Public"],
        summary: "One page of a published college site",
        description:
          "The multi-tenant rendering read. Published sites are open to " +
          "everyone; a draft answers 404 to the public but renders for its own " +
          "signed-in college, so the editor's \"View site\" works before " +
          "publishing. `isOwnerPreview` says which of those happened, and is " +
          "what the draft banner is drawn from.\n\n" +
          "Hidden sections are never returned here. The editor gets those from " +
          "`/api/v1/editor/{subdomain}`, behind a session.",
        security: [],
        parameters: [
          { name: "subdomain", in: "path", required: true, schema: str },
          {
            name: "page",
            in: "query",
            required: false,
            schema: str,
            description: "Page slug. Defaults to the first page in nav order.",
          },
        ],
        responses: {
          "200": json(
            {
              oneOf: [
                {
                  title: "Not built yet",
                  description:
                    "The college exists but has not chosen a design, so it has " +
                    "no pages to render. Distinct from 404 on purpose: it is one " +
                    "click from being a website, and calling it missing is a dead end.",
                  type: "object",
                  properties: {
                    built: { const: false },
                    college: { type: "object", properties: { name: str, subdomain: str } },
                  },
                  required: ["built", "college"],
                },
                {
              title: "A page",
              type: "object",
              properties: {
                built: { const: true },
                college: {
                  type: "object",
                  properties: { id: str, name: str, subdomain: str, status: str },
                },
                theme: THEME,
                pages: { type: "array", items: NAV_PAGE },
                currentPage: NAV_PAGE,
                seo: {
                  type: "object",
                  properties: {
                    metaTitle: nullableStr,
                    metaDescription: nullableStr,
                    ogImage: nullableStr,
                    canonicalSlug: nullableStr,
                  },
                },
                sections: { type: "array", items: RENDERABLE_SECTION },
                isOwnerPreview: bool,
                  },
                  required: ["built"],
                },
              ],
            },
            "The page, or a college with nothing built on it yet.",
          ),
          ...errors(
            [404, "No such site or page — or a draft, to anyone but its owner."],
            [500, "Unexpected server error."],
          ),
        },
      },
    },

    "/api/v1/onboarding": {
      post: {
        tags: ["Onboarding"],
        summary: "Record the college's name and type",
        description:
          "Step 2 of the flow. Rewrites the subdomain from the new name only " +
          "while nothing is built on it — once a site has sections its address " +
          "is in the editor URL, the public URL and possibly a bookmark.\n\n" +
          "Sections still showing the template's starter copy are re-personalised " +
          "with the new name. A section somebody has edited keeps every word of " +
          "it, including the old name, because they may have written it deliberately.",
        security: SESSION_COOKIE,
        requestBody: body(onboardingSchema),
        responses: {
          "200": json(
            { type: "object", properties: { subdomain: str, next: str } },
            "Saved; `next` is where the caller should go.",
          ),
          ...errors(
            [400, "Validation failed."],
            [401, "Not signed in."],
            [404, "The session's college no longer exists."],
            [500, "Unexpected server error."],
          ),
        },
      },
    },
    "/api/v1/onboarding/build": {
      post: {
        tags: ["Onboarding"],
        summary: "Build a site from the college's type",
        description:
          "Picks the template matching the type given at onboarding, takes the " +
          "theme from that template's demo college so the site opens looking " +
          "like the gallery advertises, and provisions the starter pages and " +
          "sections. Deliberately not random: answering \"Medical\" twice should " +
          "not produce two different sites.",
        security: SESSION_COOKIE,
        responses: {
          "200": json(
            { type: "object", properties: { subdomain: str, next: str } },
            "Site built; `next` is the editor.",
          ),
          ...errors(
            [400, "The college has not been asked its type yet."],
            [401, "Not signed in."],
            [404, "The session's college no longer exists."],
            [500, "Template not seeded, or no palettes/font packs configured."],
          ),
        },
      },
    },
    "/api/v1/design": {
      post: {
        tags: ["Onboarding"],
        summary: "Start with a chosen template and theme",
        description:
          "Saves the template, palette and font pack onto the college and " +
          "provisions starter sections if it has none. Existing content is never " +
          "touched — re-picking a theme rewrites three foreign keys and nothing else.",
        security: SESSION_COOKIE,
        requestBody: body(startWithDesignSchema),
        responses: {
          "200": json(
            { type: "object", properties: { subdomain: str, next: str } },
            "Applied; `next` is the editor.",
          ),
          ...errors(
            [400, "Validation failed."],
            [401, "Not signed in."],
            [404, "College, template, palette or font pack not found."],
            [500, "Unexpected server error."],
          ),
        },
      },
    },
    "/api/v1/design/cycle": {
      post: {
        tags: ["Onboarding"],
        summary: "Swap the template underneath the whole site",
        description:
          "Moves every section to the next template in name order, keeping the " +
          "college's text: content is stored keyed by section type rather than " +
          "by template, so re-pointing the ids carries the words across.\n\n" +
          "A section type the new template lacks is hidden rather than deleted, " +
          "so the text returns on the next cycle. A type the college never had " +
          "is added hidden, with starter copy, rather than published empty. " +
          "Palette and fonts are untouched — this changes layout, not colours.\n\n" +
          "`changed: false` when there is only one template to cycle between; " +
          "not an error, the button is disabled for the same reason.",
        security: SESSION_COOKIE,
        responses: {
          "200": json(
            { type: "object", properties: { subdomain: str, changed: bool } },
            "Cycled, or nothing to cycle to.",
          ),
          ...errors(
            [401, "Not signed in."],
            [404, "The session's college no longer exists."],
            [500, "Unexpected server error."],
          ),
        },
      },
    },
    "/api/v1/sites/{subdomain}/preview": {
      get: {
        tags: ["Onboarding"],
        summary: "What a template would look like, without saving it",
        description:
          "Renders what \"Start with this design\" is about to create — same " +
          "starter pages, same lead variant per section, same default copy with " +
          "this college's name in it. Nothing is written. Section ids are prefixed " +
          "`preview:` so one can never be mistaken for a real row and edited.\n\n" +
          "Answers the same shape as the public site read, so one renderer draws both.",
        security: SESSION_COOKIE,
        parameters: [
          { name: "subdomain", in: "path", required: true, schema: str },
          {
            name: "template",
            in: "query",
            required: true,
            schema: str,
            description: "The template to preview.",
          },
        ],
        responses: {
          "200": json({ type: "object" }, "A site page, generated not stored."),
          ...errors(
            [400, "template query parameter missing."],
            [401, "Not signed in."],
            [403, "Not your college."],
            [404, "No such college or template."],
            [500, "Unexpected server error."],
          ),
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
        summary: "The signed-in admin",
        security: SESSION_COOKIE,
        responses: {
          "200": json({ type: "object" }, "The admin."),
          ...errors([401, "Not signed in."], [503, "Admin panel not configured."]),
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
              enum: ["PENDING", "APPROVED", "REJECTED"],
              default: "PENDING",
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
              },
              required: ["approved", "email", "expiresAt", "delivered"],
            },
            "Approved. The token is not included, by design.",
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

    "/api/v1/me": {
      get: {
        tags: ["Editor"],
        summary: "The signed-in college",
        description:
          "204 rather than 404 for a session whose college has been deleted: " +
          "the request was understood and answered, there simply is no college.",
        security: SESSION_COOKIE,
        responses: {
          "200": json(
            { type: "object", properties: { college: COLLEGE } },
            "The caller's college.",
          ),
          "204": { description: "Signed in, but the college no longer exists." },
          ...errors([401, "Not signed in."], [500, "Unexpected server error."]),
        },
      },
    },
    "/api/v1/editor/{subdomain}": {
      get: {
        tags: ["Editor"],
        summary: "Everything the editor needs for one page",
        description:
          "Includes hidden sections, which the public read does not — the " +
          "editor has to be able to switch them back on. Scoped to the caller's " +
          "own college; asking for another's is 403.",
        security: SESSION_COOKIE,
        parameters: [
          { name: "subdomain", in: "path", required: true, schema: str },
          { name: "page", in: "query", required: false, schema: str },
        ],
        responses: {
          "200": json(
            {
              type: "object",
              properties: {
                college: { type: "object" },
                theme: THEME,
                pages: { type: "array", items: NAV_PAGE },
                currentPage: { type: "object" },
                sections: { type: "array" },
                addableSections: { type: "array" },
                templateCount: int,
              },
            },
            "Editor payload.",
          ),
          ...errors(
            [401, "Not signed in."],
            [403, "Not your college."],
            [404, "No such site or page."],
            [500, "Unexpected server error."],
          ),
        },
      },
    },

    "/api/v1/sections/{id}": {
      get: {
        tags: ["Sections"],
        summary: "Version history for a section",
        security: SESSION_COOKIE,
        parameters: [{ name: "id", in: "path", required: true, schema: str }],
        responses: {
          "200": json(
            {
              type: "object",
              properties: {
                versions: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: str,
                      savedAt: { type: "string", format: "date-time" },
                      saveTrigger: str,
                      isCurrent: bool,
                    },
                  },
                },
              },
            },
            "Newest first.",
          ),
          ...errors(
            [401, "Not signed in."],
            [404, "No such section for this college."],
            [500, "Unexpected server error."],
          ),
        },
      },
      patch: {
        tags: ["Sections"],
        summary: "Save section content",
        description:
          "Files a history snapshot only when the content actually changed, " +
          "compared on a stable key order so a byte-identical payload does not " +
          "bury the versions that differ. History is capped at 50 per section.",
        security: SESSION_COOKIE,
        parameters: [{ name: "id", in: "path", required: true, schema: str }],
        requestBody: body(saveSchema),
        responses: {
          "200": json(
            { type: "object", properties: { savedAt: { type: "string", format: "date-time" } } },
            "Saved.",
          ),
          ...errors(
            [400, "Content failed the section's schema, or the type is not editable."],
            [401, "Not signed in."],
            [404, "No such section for this college."],
            [500, "Unexpected server error."],
          ),
        },
      },
      post: {
        tags: ["Sections"],
        summary: "Restore a previous version",
        description: "Restoring is itself a save, so it lands in history and can be undone.",
        security: SESSION_COOKIE,
        parameters: [{ name: "id", in: "path", required: true, schema: str }],
        requestBody: body(restoreSchema),
        responses: {
          "200": json(
            { type: "object", properties: { savedAt: { type: "string", format: "date-time" } } },
            "Restored.",
          ),
          ...errors(
            [400, "versionId missing."],
            [401, "Not signed in."],
            [404, "No such section, or that version no longer exists."],
            [500, "Unexpected server error."],
          ),
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
    .map(({ method, path }) => ({
      method,
      // `/api/v1/sections/:id` -> `/api/v1/sections/{id}`
      path: path.replace(/:([A-Za-z0-9_]+)/g, "{$1}"),
    }))
    .filter(({ method, path }) => !documented.has(`${method} ${path}`))
    .map(({ method, path }) => `${method} ${path}`);
}
