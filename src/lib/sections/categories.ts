/**
 * The one place a section's category is decided.
 *
 * There were four copies of this: the editor's `normalizeCategory`, a second
 * heuristic ladder inside the editor's swap handler, a third inside
 * `loadAdminTemplates`, and a fourth in the Admin Studio. Each knew a slightly
 * different set of aliases, so a template filed as "Header Navigation" was a
 * `navbar` to the picker and a `custom` to the swap cycle — which is why a
 * section could be swapped into a variant of an entirely different kind, and
 * why some sections had no variants at all.
 *
 * This file exists byte-identically in xite-F and xite-B. Two repos, one rule;
 * `npm run check:shared` fails the build in either if they drift.
 */

/** The 20 kinds of section the platform knows how to file. */
export const SECTION_CATEGORY_IDS = [
  "navbar",
  "hero",
  "cta",
  "highlights",
  "about",
  "vision",
  "courses",
  "departments",
  "admissions",
  "placements",
  "facilities",
  "research",
  "news",
  "events",
  "gallery",
  "testimonials",
  "achievements",
  "contact",
  "map",
  "footer",
] as const;

export type SectionCategoryId = (typeof SECTION_CATEGORY_IDS)[number];

/** Anything that is not one of the 19. Never matched against a variant list. */
export const UNCATEGORISED = "custom";

const CATEGORY_SET: ReadonlySet<string> = new Set(SECTION_CATEGORY_IDS);

/**
 * Alias -> canonical id, longest match first.
 *
 * Order matters and is load-bearing in three places. "admission" has to be tested
 * before "mission", or every Admissions section is filed under Vision & Mission.
 * "campus life" has to be tested before "campus", or the Gallery rule swallows
 * "Campus Facilities".
 */
const ALIASES: ReadonlyArray<readonly [string, SectionCategoryId]> = [
  // navbar
  ["navbar", "navbar"],
  ["header", "navbar"],
  ["nav", "navbar"],
  ["topbar", "navbar"],
  ["top bar", "navbar"],
  ["menu bar", "navbar"],
  // call to action — before "apply", or every CTA files under Admissions
  ["call to action", "cta"],
  ["call-to-action", "cta"],
  ["cta", "cta"],
  // hero
  ["hero", "hero"],
  ["banner", "hero"],
  ["masthead", "hero"],
  ["jumbotron", "hero"],
  // admissions BEFORE vision, so "admission" never reads as "mission"
  ["admission", "admissions"],
  ["apply", "admissions"],
  ["eligibility", "admissions"],
  ["enrol", "admissions"],
  ["enroll", "admissions"],
  // highlights
  ["highlight", "highlights"],
  ["stat", "highlights"],
  ["metric", "highlights"],
  ["nirf", "highlights"],
  ["accreditation", "highlights"],
  // about
  ["about", "about"],
  ["overview", "about"],
  ["who we are", "about"],
  // vision
  ["vision", "vision"],
  ["mission", "vision"],
  ["principle", "vision"],
  ["core value", "vision"],
  // courses
  ["course", "courses"],
  ["program", "courses"],
  ["degree", "courses"],
  ["curriculum", "courses"],
  // departments
  ["department", "departments"],
  ["faculty", "departments"],
  ["school", "departments"],
  // placements
  ["placement", "placements"],
  ["recruiter", "placements"],
  ["career", "placements"],
  ["hiring", "placements"],
  // facilities
  ["facilit", "facilities"],
  ["infrastruct", "facilities"],
  ["hostel", "facilities"],
  ["library", "facilities"],
  ["amenit", "facilities"],
  // research
  ["research", "research"],
  ["patent", "research"],
  ["r&d", "research"],
  ["innovation", "research"],
  ["laborator", "research"],
  // news
  ["news", "news"],
  ["circular", "news"],
  ["announc", "news"],
  ["notice", "news"],
  ["press", "news"],
  // events
  ["event", "events"],
  ["calendar", "events"],
  ["fest", "events"],
  ["symposium", "events"],
  ["workshop", "events"],
  // gallery — "campus life" before the bare "campus" in facilities' territory
  ["campus life", "gallery"],
  ["gallery", "gallery"],
  ["photo", "gallery"],
  ["album", "gallery"],
  // testimonials
  ["testimonial", "testimonials"],
  ["alumni", "testimonials"],
  ["review", "testimonials"],
  ["what students say", "testimonials"],
  // achievements
  ["achievement", "achievements"],
  ["award", "achievements"],
  ["trophy", "achievements"],
  ["ranking", "achievements"],
  ["recognition", "achievements"],
  // contact
  ["contact", "contact"],
  ["enquir", "contact"],
  ["inquir", "contact"],
  ["helpdesk", "contact"],
  ["get in touch", "contact"],
  // map
  ["map", "map"],
  ["location", "map"],
  ["direction", "map"],
  ["reach us", "map"],
  // footer
  ["footer", "footer"],
  ["copyright", "footer"],
];

/**
 * A raw category/type/name string reduced to one of the 19 ids.
 *
 * Returns `""` — not `UNCATEGORISED` — for an empty input, so a caller can tell
 * "nothing was said" from "something was said and it matched nothing". The
 * first is worth guessing about; the second is not.
 */
export function normalizeCategory(raw?: string | null): SectionCategoryId | "" | typeof UNCATEGORISED {
  if (!raw) return "";
  const value = String(raw).toLowerCase().trim();
  if (!value) return "";
  if (CATEGORY_SET.has(value)) return value as SectionCategoryId;

  // `[navbar] Dark header` — the Admin Studio's bracket convention.
  const bracket = value.match(/\[([^\]]+)\]/);
  if (bracket?.[1]) {
    const inner = bracket[1].trim();
    if (CATEGORY_SET.has(inner)) return inner as SectionCategoryId;
    for (const [alias, id] of ALIASES) {
      if (inner.includes(alias)) return id;
    }
  }

  for (const [alias, id] of ALIASES) {
    if (value.includes(alias)) return id;
  }
  return UNCATEGORISED;
}

/**
 * The category of a section or template, from every field that could carry it.
 *
 * Explicit beats inferred: an author who filed a section as `contact` gets
 * `contact` even if its markup happens to contain a `<footer>`. Markup sniffing
 * is last and only recognises the two structural tags, because those are the
 * two that genuinely determine where a section may sit on a page.
 */
export function resolveCategory(entry: {
  category?: string | null;
  sectionType?: string | null;
  type?: string | null;
  name?: string | null;
  title?: string | null;
  code?: string | null;
}): SectionCategoryId | typeof UNCATEGORISED {
  for (const field of [entry.category, entry.sectionType, entry.type]) {
    const hit = normalizeCategory(field);
    if (hit && hit !== UNCATEGORISED) return hit;
  }
  for (const field of [entry.name, entry.title]) {
    const hit = normalizeCategory(field);
    if (hit && hit !== UNCATEGORISED) return hit;
  }

  const code = (entry.code || "").toLowerCase();
  // `<header` also prefixes nothing else; `<head` would have matched `<header`,
  // which is the bug that used to delete every navbar's wrapper element.
  if (/<header[\s>]/.test(code)) return "navbar";
  if (/<footer[\s>]/.test(code)) return "footer";

  return UNCATEGORISED;
}

/** Sections that may only ever sit at the very top or the very bottom of a page. */
export const PINNED_TOP: SectionCategoryId = "navbar";
export const PINNED_BOTTOM: SectionCategoryId = "footer";
