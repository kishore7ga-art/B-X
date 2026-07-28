import { z } from "zod";

import { credentialsSchema, signupSchema } from "@/auth-service";
import { startWithDesignSchema } from "@/design-service";
import { adminLoginSchema } from "@/admin-service";
import { onboardingSchema } from "@/onboarding-service";
import { restoreSchema, saveSchema } from "@/sections-service";

/**
 * The API, described once, from the schemas that actually validate it.
 *
 * Request bodies are converted straight out of the zod schemas the routes parse
 * with, so a validation rule and its documentation cannot disagree — change
 * `signupSchema`'s minimum password length and this says the new number without
 * anyone remembering to edit it. zod 4 can do that on its own; no
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
    { name: "Auth", description: "Creating an account and signing in." },
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
          "notices rather than reading 200 off a service that cannot serve.",
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

    "/api/v1/auth/signup": {
      post: {
        tags: ["Auth"],
        summary: "Create an account",
        description:
          "Creates a user and a college. Deliberately issues no session: the " +
          "flow is signup → sign in → editor, so the password is proved to work " +
          "as part of creating the account.\n\n" +
          "Rate limited to 5 per IP per hour — it is public, hashes at bcrypt " +
          "cost 12 and writes rows.",
        security: [],
        requestBody: body(signupSchema),
        responses: {
          "201": json(
            { type: "object", properties: { id: str, email: str } },
            "Account created.",
          ),
          ...errors(
            [400, "Validation failed."],
            [409, "That email is already registered."],
            [429, "Too many accounts created from this address."],
            [500, "Unexpected server error."],
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
          "not public.",
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
            [429, "Too many attempts from this address."],
            [500, "Unexpected server error."],
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
            [401, "Incorrect email, password or code."],
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
