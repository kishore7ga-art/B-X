/**
 * The wire between the two services, defined once.
 *
 * These shapes crossed the network as hand-written mirrors: the backend built a
 * response and the frontend declared, separately, what it expected to receive.
 * Nothing connected the two. Adding a field to a Mongoose query response, or a value to
 * the save-trigger list, compiled cleanly in both repos and broke at runtime in
 * whichever one was not updated — the same failure the nine copied files
 * already have a checksum guarding, minus the guard.
 *
 * Being in this file changes that in two ways at once. The backend annotates
 * what it returns with these types, so a response that stops matching fails to
 * compile where it is built; and the frontend imports them instead of
 * redeclaring, so there is no second opinion to disagree. The copy in the other
 * repo is checksummed like the rest, which makes editing one and not the other
 * a failed build rather than a silent divergence.
 *
 * Wire types, not database types. `createdAt` is an ISO string here because
 * that is what arrives after JSON — reviving it as a Date would be a lie the
 * frontend then has to work around.
 *
 * Nothing here may import anything: it is copied verbatim into a repo with a
 * different module layout, and an import is what would stop that working.
 */

// --- Colleges -----------------------------------------------------------------

/** `GET /api/v1/me` -> `{ college }`. */
export type CollegePayload = {
  id: string;
  name: string;
  subdomain: string;
  customDomain: string | null;
  templateId: string | null;
  themePaletteId: string | null;
  themeFontId: string | null;
  status: string;
  collegeType: string | null;
  isDemo: boolean;
  /**
   * Who the person signing in says they are, from `ONBOARDING_ROLES`.
   *
   * Null for every account created before onboarding existed, and for one that
   * has not finished it. Nullable rather than defaulted because "we never asked"
   * and "they chose College Owner" are different facts, and only the first of
   * them should send somebody back through the wizard.
   */
  ownerRole: string | null;
  /**
   * Whether the role/theme/font wizard has been completed.
   *
   * Derived on the backend from `onboardingCompletedAt` rather than sent as a
   * timestamp, because every caller asks the same yes/no question and a
   * timestamp invites each of them to re-derive the answer differently.
   */
  onboardingCompleted: boolean;
  /** ISO 8601 — it crossed JSON to get here. */
  createdAt: string;
};

// --- Editor -------------------------------------------------------------------

export type EditorVariantPayload = {
  id: string;
  variantName: string;
  componentKey: string;
};

/**
 * `sectionType` is a bare string on purpose. The backend filters to the types
 * it supports, but the frontend narrows it against its own registry on arrival
 * — a version skew that leaves an unknown type is the frontend's to drop, and
 * typing it as the narrow union here would assert a guarantee the wire cannot
 * make.
 */
export type EditorSectionPayload = {
  id: string;
  sectionId: string;
  sectionType: string;
  variantId: string;
  componentKey: string;
  variantName: string;
  displayOrder: number;
  isVisible: boolean;
  content: unknown;
  /** ISO 8601, or null if never saved. */
  lastSavedAt: string | null;
  variants: EditorVariantPayload[];
};

/** `GET /api/v1/editor/:subdomain`. */
export type EditorPagePayload = {
  college: {
    id: string;
    name: string;
    subdomain: string;
    status: string;
    templateName: string | null;
  };
  /**
   * Raw. The palette's JSON and the font names travel as stored, because
   * parsing them is presentation and the frontend already owns that.
   */
  theme: {
    paletteColors: unknown;
    headingFont: string | null;
    bodyFont: string | null;
  };
  pages: { id: string; slug: string; title: string }[];
  currentPage: {
    id: string;
    slug: string;
    title: string;
    metaTitle: string | null;
    metaDescription: string | null;
    ogImage: string | null;
    canonicalSlug: string | null;
  };
  sections: EditorSectionPayload[];
  addableSections: { sectionId: string; sectionType: string }[];
  /** Whether there is more than one design to cycle through. */
  templateCount: number;
};

// --- Sessions -----------------------------------------------------------------

/**
 * How long a session survives without being used.
 *
 * An inactivity window, not a fixed lifetime. Both services push it forward on
 * activity — the frontend's proxy on every page visit, this service on every
 * authenticated API call — so it only runs out for somebody who has been away
 * the whole time. Before that it was a hard seven days from sign-in, which
 * logged people out mid-edit on the eighth day for no visible reason.
 *
 * Shared because the two services must agree: the backend mints the token at
 * sign-in and both re-mint it afterwards, so a different lifetime on either
 * side would mean the expiry silently changing depending on which service you
 * touched last.
 */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/**
 * How old a token must be before activity re-issues it.
 *
 * Not on every request, though the signing cost would be negligible — a
 * `Set-Cookie` on every response is bytes on the wire and a header that makes
 * responses less cacheable, for no gain. A day means at most one renewal per
 * active user per day, while anyone returning inside the window above stays
 * signed in indefinitely.
 */
export const SESSION_RENEW_AFTER_SECONDS = 60 * 60 * 24;

// --- Sections -----------------------------------------------------------------

/**
 * What caused a save, recorded per snapshot so history reads like a story.
 *
 * The one entry here that is a runtime value rather than a type, because both
 * sides need it as one: the backend builds a zod enum from it to validate the
 * request, and the frontend derives the union it passes. A value added on one
 * side alone used to mean the editor sending a trigger the API rejected, with
 * the rejection surfacing as an unexplained failed save.
 */
export const SAVE_TRIGGERS = [
  "typing",
  "drag",
  "color",
  "font",
  "image",
  "delete",
  "resize",
  "section_update",
  "restore",
] as const;

export type SaveTrigger = (typeof SAVE_TRIGGERS)[number];

/** `PATCH` and `POST /api/v1/sections/:id`. */
export type SavedAtPayload = { savedAt: string };

// --- Onboarding ---------------------------------------------------------------

/**
 * The roles a new account may claim, and the only ones either service accepts.
 *
 * A runtime value rather than a type, for the same reason `SAVE_TRIGGERS` is:
 * the backend builds a zod enum from it to reject anything else, and the
 * frontend renders the wizard's choices from it. Two hand-kept lists would let
 * the form offer an option the API refuses — which surfaces to the person
 * filling it in as a final step that simply fails, with nothing on screen
 * explaining which of their three answers was the unacceptable one.
 *
 * `other` is deliberately last and deliberately present. Without it the honest
 * answer for anyone outside these four is to pick a role that is not theirs,
 * and a field that pushes people into misreporting is worse than no field.
 */
export const ONBOARDING_ROLES = [
  { id: "college-owner", label: "College Owner" },
  { id: "principal", label: "Principal" },
  { id: "management", label: "College Management" },
  { id: "visitor", label: "Visitor" },
  { id: "other", label: "Other" },
] as const;

export type OnboardingRoleId = (typeof ONBOARDING_ROLES)[number]["id"];

/**
 * `GET /api/v1/onboarding` -> this. `PUT` takes the three ids and returns it.
 *
 * The theme and font ids are the project-level defaults every section, the
 * preview and the published site derive from — the same two fields the editor's
 * drawer writes through `PUT /api/v1/my-theme`. Onboarding is the first write
 * to them, not a second place they are stored.
 */
export type OnboardingPayload = {
  completed: boolean;
  role: string | null;
  themePaletteId: string | null;
  themeFontId: string | null;
  /** ISO 8601, or null if the wizard has not been finished. */
  completedAt: string | null;
};
