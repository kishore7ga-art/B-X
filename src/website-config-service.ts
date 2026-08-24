/**
 * A tenant's draft website: one canonical shape, one place that decides it.
 *
 * The editor used to hold the only opinion about what a saved config looks
 * like, and it changed that opinion depending on which code path did the
 * saving — `handlePersistWebsiteSave` wrote `sortOrder`, the seeding path wrote
 * none, and the reorder path wrote whichever the previous save had left. The
 * API stored all three verbatim. So `sortOrder` and array position could
 * disagree, and which one a reader believed decided whether a reorder had
 * happened.
 *
 * Everything a client sends is normalised here on the way in, and the same
 * normalisation is applied on the way out, so array position IS the order and
 * `sortOrder` is always its index. A client that sends neither still gets a
 * config whose order round-trips.
 */

import { College } from "@/models";
import { sanitizeWebsiteConfig } from "@/lib/sections/sanitize-section-html";
import { resolveCategory, UNCATEGORISED } from "@/lib/sections/categories";
import { Template } from "@/models";
import { sanitizeTemplateCode } from "@/library-service";
import { BadRequest, NotFound } from "@/errors";

export type StoredSection = {
  /** Stable across reorders, edits and swaps. Never reused. */
  id: string;
  title: string;
  /** One of the 19 canonical ids, or "custom". */
  sectionType: string;
  /**
   * Which library template this section is currently showing, when it came from
   * one. This is what makes variant swapping deterministic: the cycle is a
   * position in a list of template ids, not a string comparison of two blobs of
   * HTML that inline editing has already made unequal.
   */
  templateId: string | null;
  /** Position in that category's variant cycle. Advisory; `templateId` wins. */
  variantIndex: number;
  code: string;
  /** Always equal to the array index after normalisation. */
  sortOrder: number;
};

export type StoredPage = {
  /** Stable page identity, independent of the slug the user may rename. */
  id: string;
  slug: string;
  title: string;
  sections: StoredSection[];
};

export type StoredConfig = { pages: StoredPage[] };

/** `/about`, `about`, `//about/` and `About` all name the same page. */
export function canonicalSlug(raw: unknown): string {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return "";
  const trimmed = value.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return "";
  return `/${trimmed.replace(/\s+/g, "-").replace(/[^a-z0-9/_-]/g, "")}`;
}

/**
 * A page id derived from its slug.
 *
 * Deliberately derived rather than random: every config already in the database
 * predates page ids, and a random one would differ on every read until the next
 * write, so a client keying state by page id would see its state reset. Derived
 * ids are stable for existing rows from the first read.
 */
export function pageIdFor(slug: string): string {
  const clean = canonicalSlug(slug).replace(/^\//, "").replace(/\//g, "-");
  return `page-${clean || "home"}`;
}

let sectionCounter = 0;
function freshSectionId(): string {
  sectionCounter = (sectionCounter + 1) % 1_000_000;
  return `sec-${Date.now().toString(36)}-${sectionCounter.toString(36)}`;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * One section, in the canonical shape.
 *
 * `index` becomes `sortOrder` unconditionally. A caller that wants a different
 * order sends a differently-ordered array; there is no second channel.
 */
function normalizeSection(raw: unknown, index: number): StoredSection | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;

  // `html` and `content` are the two field names older writers used for `code`.
  const code = asString(entry.code) || asString(entry.html) || asString(entry.content);
  if (!code.trim()) return null;

  const category = resolveCategory({
    category: asString(entry.category) || null,
    sectionType: asString(entry.sectionType) || null,
    type: asString(entry.type) || null,
    name: asString(entry.name) || null,
    title: asString(entry.title) || null,
    code,
  });

  const rawVariant = Number(entry.variantIndex);

  return {
    id: asString(entry.id) || freshSectionId(),
    title: asString(entry.title) || asString(entry.name) || "Section",
    sectionType: category || UNCATEGORISED,
    templateId: asString(entry.templateId) || null,
    variantIndex: Number.isFinite(rawVariant) && rawVariant >= 0 ? Math.floor(rawVariant) : 0,
    code,
    sortOrder: index,
  };
}

/**
 * A page's sections, ordered and renumbered.
 *
 * `sortOrder` is honoured on the way in — a client that reordered by rewriting
 * the field rather than the array is not silently ignored — with the array
 * index as the tiebreaker so a config where every section shares a `sortOrder`
 * (or has none) keeps the order it arrived in rather than being shuffled.
 * After this, the two always agree.
 */
function normalizeSections(raw: unknown): StoredSection[] {
  if (!Array.isArray(raw)) return [];

  const ordered = raw
    .map((section, index) => ({ section, index }))
    .sort((a, b) => {
      const av = Number((a.section as Record<string, unknown> | null)?.sortOrder);
      const bv = Number((b.section as Record<string, unknown> | null)?.sortOrder);
      const ao = Number.isFinite(av) ? av : a.index;
      const bo = Number.isFinite(bv) ? bv : b.index;
      return ao === bo ? a.index - b.index : ao - bo;
    });

  const out: StoredSection[] = [];
  const seenIds = new Set<string>();

  ordered.forEach(({ section }) => {
    const normalized = normalizeSection(section, out.length);
    if (!normalized) return;
    // A duplicated id makes two sections one section as far as any keyed client
    // is concerned — React reconciliation, the editor's selection, and the
    // reorder handler all address sections by id. The copy gets a new one.
    if (seenIds.has(normalized.id)) normalized.id = freshSectionId();
    seenIds.add(normalized.id);
    normalized.sortOrder = out.length;
    out.push(normalized);
  });

  return out;
}

function titleFromSlug(slug: string): string {
  const base = slug.replace(/^\//, "").replace(/[-_/]+/g, " ").trim();
  if (!base) return "Home";
  return base.replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizePage(raw: unknown): StoredPage | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const slug = canonicalSlug(entry.slug);
  if (!slug) return null;

  return {
    id: asString(entry.id) || pageIdFor(slug),
    slug,
    title: asString(entry.title) || titleFromSlug(slug),
    sections: normalizeSections(entry.sections),
  };
}

/**
 * A whole config, canonicalised.
 *
 * Two pages that canonicalise to the same slug are merged rather than both
 * kept — the second wins, because it is the later one in the array the client
 * sent. Keeping both is what let `/about` and `about` accumulate as separate
 * pages that the editor then showed under one name.
 */
export function normalizeConfig(raw: unknown): StoredConfig {
  const source = (raw ?? {}) as Record<string, unknown>;
  if (!Array.isArray(source.pages)) return { pages: [] };

  const bySlug = new Map<string, StoredPage>();
  source.pages.forEach((page) => {
    const normalized = normalizePage(page);
    if (normalized) bySlug.set(normalized.slug, normalized);
  });

  return { pages: Array.from(bySlug.values()) };
}

/** Normalised and sanitised: the exact bytes that may be stored or served. */
export function prepareConfig(raw: unknown): StoredConfig {
  return sanitizeWebsiteConfig(normalizeConfig(raw));
}

/**
 * This college's draft, or an empty config.
 *
 * Deliberately does NOT fall back to the platform default. The GET route does
 * that, once, for a college that has never saved anything — this function is
 * what the write paths read, and a write path that read the default would merge
 * the platform's home page into a tenant's config the first time they saved a
 * single unrelated page.
 */
export async function loadDraft(collegeId: string): Promise<StoredConfig> {
  const college = await College.findById(collegeId);
  if (!college?.websiteConfig) return { pages: [] };
  return prepareConfig(college.websiteConfig);
}

async function persist(collegeId: string, config: StoredConfig): Promise<StoredConfig> {
  const college = await College.findById(collegeId);
  if (!college) throw new NotFound("This account is not linked to a college.");

  college.websiteConfig = config;
  // Stamped explicitly: the row's own `updatedAt` also moves for a publish, a
  // domain check and every other write, and the settings screen needs "when the
  // draft last changed" specifically.
  college.draftUpdatedAt = new Date();
  // `markModified` because `websiteConfig` is a nested document that Mongoose
  // does not always see as dirty when it is replaced wholesale — the symptom
  // being a save that returns 200 and changes nothing, which is precisely what
  // "the order does not persist after refresh" looks like from a browser.
  college.markModified("websiteConfig");
  await college.save();

  return config;
}

/** Replace the whole draft. Used by the editor's full-config save. */
export async function saveDraft(collegeId: string, raw: unknown): Promise<StoredConfig> {
  return persist(collegeId, prepareConfig(raw));
}

/**
 * Replace exactly one page, leaving every other page byte-identical.
 *
 * This is the write the editor uses for every ordinary edit, and it is the
 * fix for pages bleeding into each other. The full-config PUT had to reconstruct
 * every page from client state on every keystroke-debounce, so a page the client
 * had loaded stale — or had not loaded at all — was rewritten from whatever the
 * client happened to be holding. Here the server owns the other pages and the
 * client cannot touch them: the only page in the request is the one being saved.
 */
export async function savePage(
  collegeId: string,
  slug: string,
  page: { title?: unknown; sections?: unknown },
): Promise<StoredPage> {
  const canonical = canonicalSlug(slug);
  if (!canonical) throw new BadRequest("A page slug is required.");

  const draft = await loadDraft(collegeId);
  const existing = draft.pages.find((p) => p.slug === canonical);

  const next = normalizePage({
    id: existing?.id ?? pageIdFor(canonical),
    slug: canonical,
    title: asString(page.title) || existing?.title || titleFromSlug(canonical),
    sections: page.sections,
  });
  // `normalizePage` only returns null for an unusable slug, which `canonical`
  // has already ruled out. A page with no sections is a real page.
  const resolved = next ?? { id: pageIdFor(canonical), slug: canonical, title: titleFromSlug(canonical), sections: [] };
  const sanitized = sanitizeWebsiteConfig({ pages: [resolved] }).pages[0]!;

  const pages = existing
    ? draft.pages.map((p) => (p.slug === canonical ? sanitized : p))
    : [...draft.pages, sanitized];

  await persist(collegeId, { pages });
  return sanitized;
}

/**
 * Reorder one page's sections by id, without sending any markup.
 *
 * The editor's move-up/move-down used to persist by re-sending the entire
 * multi-page config, section HTML and all — hundreds of kilobytes to express
 * "these two swapped" — through a debounce that the next click restarted. Two
 * quick presses and a refresh, and nothing had been written.
 *
 * Ids only, so this cannot lose an edit made in another tab, cannot be
 * truncated by a payload limit, and returns fast enough to be called on the
 * click rather than 2 seconds after it.
 */
export async function reorderPageSections(
  collegeId: string,
  slug: string,
  sectionIds: unknown,
): Promise<StoredPage> {
  const canonical = canonicalSlug(slug);
  if (!canonical) throw new BadRequest("A page slug is required.");
  if (!Array.isArray(sectionIds)) throw new BadRequest("sectionIds must be an array of section ids.");

  const draft = await loadDraft(collegeId);
  const page = draft.pages.find((p) => p.slug === canonical);
  if (!page) throw new NotFound(`No page at ${canonical}.`);

  const byId = new Map(page.sections.map((s) => [s.id, s]));
  const ordered: StoredSection[] = [];

  for (const id of sectionIds) {
    const section = byId.get(String(id));
    if (!section) continue;
    byId.delete(section.id);
    ordered.push(section);
  }
  // Anything the client did not mention keeps its relative order at the end,
  // rather than being deleted. A reorder request is not a delete request, and a
  // client running one version behind must not be able to drop a section it has
  // simply never heard of.
  page.sections.forEach((section) => {
    if (byId.has(section.id)) ordered.push(section);
  });

  page.sections = ordered.map((section, index) => ({ ...section, sortOrder: index }));

  await persist(collegeId, draft);
  return page;
}

/** Remove a page and everything on it. */
export async function deletePage(collegeId: string, slug: string): Promise<StoredConfig> {
  const canonical = canonicalSlug(slug);
  const draft = await loadDraft(collegeId);
  return persist(collegeId, { pages: draft.pages.filter((p) => p.slug !== canonical) });
}

/* ── Restoring the scripts a save had to strip ─────────────────────────── */

/**
 * Puts back the JavaScript an admin-authored section came with.
 *
 * ── The bug ───────────────────────────────────────────────────────────────
 *
 * Two sanitisers guard two paths, and they disagree about `<script>` on
 * purpose: `sanitizeTemplateCode` allows it, because the library genuinely
 * contains carousels, sliders and hamburger menus; `sanitizeSectionHtml`
 * discards it, because a tenant's own markup renders on the platform apex
 * beside the sign-in page.
 *
 * A section moves across that boundary the first time it is saved. So:
 *
 *   1. The admin publishes a slider whose slides are built by its script.
 *   2. A tenant adds it. The editor runs the script; the slides appear.
 *   3. The autosave writes it through `PUT /my-website`, which strips the script.
 *   4. On reload the markup is there and the script is not, so the section
 *      renders as an empty rectangle — its own background and padding, and
 *      nothing inside.
 *
 * That is the black band. Not empty space between sections: a section whose
 * content was assembled by code that no longer runs.
 *
 * ── Why restore rather than relax the sanitiser ───────────────────────────
 *
 * Letting `<script>` through `PUT /my-website` would fix the symptom and open
 * the hole the sanitiser exists to close — arbitrary tenant script on
 * `webxite.org`, same origin as the editor, the sign-in page and the `/admin/*`
 * rewrite.
 *
 * So the script is never taken from the request. It is looked up from the
 * `Template` row the section came from, by `templateId`, and only for templates
 * that are still published and unarchived. A tenant can put any `templateId`
 * they like in a request body and the worst they achieve is running a script an
 * administrator already published to the whole platform.
 *
 * Applied on read — the editor's `GET /my-website` and the public site — so
 * nothing is written back and the stored draft stays exactly as sanitised.
 */

const SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;

export async function restoreTemplateScripts<T>(config: T): Promise<T> {
  const source = config as { pages?: unknown } | null;
  if (!source || !Array.isArray(source.pages)) return config;

  // Which templates are actually referenced, so one query covers the whole site.
  const ids = new Set<string>();
  for (const page of source.pages) {
    const sections = (page as { sections?: unknown })?.sections;
    if (!Array.isArray(sections)) continue;
    for (const section of sections) {
      const id = (section as { templateId?: unknown })?.templateId;
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  if (ids.size === 0) return config;

  let scriptsByTemplate = new Map<string, string>();
  try {
    const rows = await Template.find({
      _id: { $in: Array.from(ids) },
      archivedAt: null,
      isPublished: true,
    }).select("code");

    for (const row of rows) {
      const code = typeof row.code === "string" ? row.code : "";
      const blocks = code.match(SCRIPT_BLOCK);
      if (!blocks || blocks.length === 0) continue;
      // Sanitised through the policy that governs the library, so a template
      // edited before that policy existed is still cleaned on the way out.
      const cleaned = sanitizeTemplateCode(blocks.join("\n"));
      if (cleaned.trim()) scriptsByTemplate.set(String(row.id ?? row._id), cleaned);
    }
  } catch (error) {
    // A lookup that fails costs a section its interactivity, which is a much
    // smaller failure than refusing to serve the site at all.
    console.error("[website-config] could not restore template scripts:", error);
    scriptsByTemplate = new Map();
  }

  if (scriptsByTemplate.size === 0) return config;

  return {
    ...(source as object),
    pages: source.pages.map((page) => {
      const entry = page as { sections?: unknown };
      if (!Array.isArray(entry.sections)) return page;

      return {
        ...(entry as object),
        sections: entry.sections.map((section) => {
          const item = section as { templateId?: unknown; code?: unknown };
          const id = typeof item.templateId === "string" ? item.templateId : "";
          const scripts = id ? scriptsByTemplate.get(id) : undefined;
          if (!scripts) return section;

          const code = typeof item.code === "string" ? item.code : "";
          // A section that still has its own script keeps it; this only fills a
          // gap, it never duplicates.
          if (SCRIPT_BLOCK.test(code)) {
            SCRIPT_BLOCK.lastIndex = 0;
            return section;
          }
          SCRIPT_BLOCK.lastIndex = 0;

          return { ...(item as object), code: `${code}\n${scripts}` };
        }),
      };
    }),
  } as T;
}
