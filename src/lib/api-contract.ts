/**
 * The wire between the two services, defined once.
 *
 * These shapes crossed the network as hand-written mirrors: the backend built a
 * response and the frontend declared, separately, what it expected to receive.
 * Nothing connected the two. Adding a field to a Prisma `select`, or a value to
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
