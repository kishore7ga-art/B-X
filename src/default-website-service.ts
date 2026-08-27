import { SystemSecret, AuditLog } from "@/models";
import { sanitizeWebsiteConfig } from "@/lib/sections/sanitize-section-html";
import {
  SECTION_CATEGORY_IDS,
  resolveCategory,
  type SectionCategoryId,
} from "@/lib/sections/categories";
import { SECTION_STARTERS } from "@/lib/sections/section-starters";
import { getSectionLibrary } from "@/section-library-service";

export type DefaultWebsiteSection = {
  id: string;
  title: string;
  sectionType: string;
  code: string;
  sortOrder: number;
};

export type DefaultWebsitePage = {
  slug: string;
  title: string;
  sections: DefaultWebsiteSection[];
};

export type DefaultWebsiteConfig = {
  pages: DefaultWebsitePage[];
};

/** The five pages the platform ships with, and their titles. */
const DEFAULT_PAGES: ReadonlyArray<{ slug: string; title: string }> = [
  { slug: "/home", title: "Home" },
  { slug: "/about", title: "About Us" },
  { slug: "/academics", title: "Academics" },
  { slug: "/placements", title: "Placements" },
  { slug: "/contact", title: "Contact Us" },
];

/** `/home` -> `home`, for building a section id that is stable and readable. */
function slugKey(slug: string): string {
  return (slug || "").replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "page";
}

/** One starter section, as a page entry. */
function starterSection(
  slug: string,
  category: SectionCategoryId,
  sortOrder: number,
): DefaultWebsiteSection {
  const starter = SECTION_STARTERS[category];
  return {
    id: `def-${slugKey(slug)}-${category}`,
    title: starter.title,
    sectionType: category,
    sortOrder,
    code: starter.code,
  };
}

/**
 * Every page, with all twenty sections.
 *
 * This used to be a header and a footer on `/home` and four empty pages — so a
 * new deployment served a two-section site, and a tenant pressing Add Section
 * on About got the picker rather than a page. The editor seeds a page from the
 * Admin's page at the same slug, which means whatever is here is what every
 * college starts from; four empty pages made that seeding look broken when it
 * was working exactly as written.
 *
 * Only a database with no `DEFAULT_WEBSITE_CONFIG` record reaches this. An
 * existing deployment has a stored config and keeps it — see
 * `fillPagesWithEverySection`, which is how that one is brought up to twenty.
 */
const INITIAL_DEFAULT_WEBSITE: DefaultWebsiteConfig = {
  pages: DEFAULT_PAGES.map(({ slug, title }) => ({
    slug,
    title,
    sections: SECTION_CATEGORY_IDS.map((category, index) =>
      starterSection(slug, category, index),
    ),
  })),
};

let inMemoryDefaultWebsite: DefaultWebsiteConfig | null = null;

/**
 * Every page's sections, in the order the Admin arranged them.
 *
 * `sortOrder` is the field the Admin Studio writes when a section is moved,
 * added or removed, but nothing read it back — every consumer took the array
 * in whatever order it happened to be stored in. That held only for as long as
 * every writer kept the two in step, and the editor now seeds a whole page from
 * this config in one go, so the order is the difference between a page that
 * comes out header-first and one that does not.
 *
 * The array index is the tiebreaker, which makes the sort stable and leaves a
 * config whose sections all share a `sortOrder` (or have none at all) exactly
 * as it was rather than shuffled into an arbitrary order.
 */
function orderPageSections(config: DefaultWebsiteConfig): DefaultWebsiteConfig {
  if (!config || !Array.isArray(config.pages)) return { pages: [] };

  return {
    ...config,
    pages: config.pages.map((page) => {
      const sections = Array.isArray(page?.sections) ? page.sections : [];
      return {
        ...page,
        sections: sections
          .map((section, index) => ({ section, index }))
          .sort((a, b) => {
            const aOrder = Number.isFinite(a.section?.sortOrder) ? a.section.sortOrder : a.index;
            const bOrder = Number.isFinite(b.section?.sortOrder) ? b.section.sortOrder : b.index;
            return aOrder === bOrder ? a.index - b.index : aOrder - bOrder;
          })
          .map(({ section }) => section),
      };
    }),
  };
}

/** Ensure system_secrets collection holds default website config with clean sections and pages */
/**
 * The platform default, sanitised before it leaves this module.
 *
 * This config is rendered with `dangerouslySetInnerHTML` exactly as a tenant's
 * own sections are — it is what every college with no sections of its own
 * serves, and what the editor seeds a new page from — so it goes through the
 * same pass. Wrapped around the loader rather than added to each of its five
 * return paths, because one of those paths is where the next one gets missed.
 */
export async function getDefaultWebsiteConfig(): Promise<DefaultWebsiteConfig> {
  return sanitizeWebsiteConfig(await loadDefaultWebsiteConfig());
}

async function loadDefaultWebsiteConfig(): Promise<DefaultWebsiteConfig> {
  const currentMem = inMemoryDefaultWebsite;
  if (currentMem && Array.isArray(currentMem.pages) && currentMem.pages.length > 0) {
    try {
      const secret = await SystemSecret.findOne({ name: "DEFAULT_WEBSITE_CONFIG" });
      if (secret && secret.value) {
        const parsed = typeof secret.value === "string" ? JSON.parse(secret.value) : secret.value;
        if (parsed && Array.isArray(parsed.pages) && parsed.pages.length > 0) {
          const ordered = orderPageSections(parsed);
          inMemoryDefaultWebsite = ordered;
          return ordered;
        }
      }
    } catch {}
    return orderPageSections(currentMem);
  }

  try {
    const secret = await SystemSecret.findOne({ name: "DEFAULT_WEBSITE_CONFIG" });
    if (secret && secret.value) {
      const parsed = typeof secret.value === "string" ? JSON.parse(secret.value) : secret.value;
      if (parsed && Array.isArray(parsed.pages) && parsed.pages.length > 0) {
        const existingSlugs = new Set(parsed.pages.map((p: any) => p.slug));
        const mergedPages = [...parsed.pages];
        INITIAL_DEFAULT_WEBSITE.pages.forEach((initPage) => {
          if (!existingSlugs.has(initPage.slug)) {
            mergedPages.push(initPage);
          }
        });
        const ordered = orderPageSections({ pages: mergedPages });
        inMemoryDefaultWebsite = ordered;
        return ordered;
      }
    }
  } catch (err) {
    console.error("Error reading default website config from MongoDB:", err);
  }

  // Force seed database if record missing
  try {
    await updateDefaultWebsiteConfig(INITIAL_DEFAULT_WEBSITE);
  } catch {}

  inMemoryDefaultWebsite = INITIAL_DEFAULT_WEBSITE;
  return orderPageSections(INITIAL_DEFAULT_WEBSITE);
}

export async function updateDefaultWebsiteConfig(
  rawConfig: DefaultWebsiteConfig
): Promise<DefaultWebsiteConfig> {
  // Sanitised on write as well as on read. This body reaches every tenant that
  // has not customised their site, so it is the single highest-leverage place
  // in the platform to put section markup.
  const config = sanitizeWebsiteConfig(rawConfig);
  inMemoryDefaultWebsite = config;

  try {
    await SystemSecret.findOneAndUpdate(
      { name: "DEFAULT_WEBSITE_CONFIG" },
      { name: "DEFAULT_WEBSITE_CONFIG", value: config },
      { upsert: true, new: true }
    );

    await AuditLog.create({
      action: "EDITOR_CONFIG_UPDATED",
      tenantId: "system",
      details: { pagesCount: config.pages?.length || 0 },
    }).catch(() => null);
  } catch (err) {
    console.warn("Could not persist default website config to MongoDB, saved to memory fallback:", err);
  }

  return config;
}

/**
 * Bring pages up to all twenty sections, in canonical order.
 *
 * ── What it is for ────────────────────────────────────────────────────────
 *
 * `INITIAL_DEFAULT_WEBSITE` only reaches a database that has never stored a
 * config. Every deployment that has been up for five minutes has one, so this
 * is how an existing Default Website is filled in — the Admin's "Add every
 * section" button posts to it.
 *
 * ── The three rules ───────────────────────────────────────────────────────
 *
 * **Nothing an admin arranged is discarded.** A page that already has a
 * section of a category keeps that exact section — its id, its title and its
 * markup — and it simply moves into that category's slot. Anything left over
 * (a second Hero, or a `custom` section that matches no category) is appended
 * after the twenty in the order it was already in, rather than deleted. That
 * is what makes this safe to press on `/home`, which is the page most likely
 * to have real work in it.
 *
 * **The library wins over the starter.** For a category the page does not
 * have, the first published template in Admin › Templates for that category is
 * used, and only a category with no template at all falls back to
 * `SECTION_STARTERS`. So the button gets better as the library fills up, and a
 * college never receives a placeholder for a category where the admin has
 * published a real design.
 *
 * **It is idempotent.** Pressing it twice produces the same config as pressing
 * it once: the second pass finds every category already present and keeps it.
 * A button whose second press quietly doubles a page is a button nobody dares
 * use.
 *
 * @param slugs  Which pages to fill, or omitted for every page.
 */
export async function fillPagesWithEverySection(
  slugs?: string[],
): Promise<DefaultWebsiteConfig> {
  const config = await getDefaultWebsiteConfig();

  // An empty library is a legitimate state — a fresh deployment has none — so
  // a failure here falls back to the starters rather than to an error. The
  // caller asked for twenty sections; twenty is what it gets.
  let byCategory: Record<string, Array<{ id: string; name: string; code: string }>> = {};
  try {
    byCategory = (await getSectionLibrary()).byCategory;
  } catch {
    byCategory = {};
  }

  const wanted = slugs && slugs.length > 0 ? new Set(slugs.map(slugKey)) : null;

  const pages = config.pages.map((page) =>
    wanted && !wanted.has(slugKey(page.slug)) ? page : fillPageSections(page, byCategory),
  );

  return updateDefaultWebsiteConfig({ pages });
}

/** A library template, reduced to what a section needs from it. */
export type LibraryChoice = { name: string; code: string };

/**
 * One page, brought up to all twenty sections. The rule, with no I/O in it.
 *
 * Exported so it can be tested for the three properties that make the button
 * safe to press — nothing discarded, library over starter, idempotent — none of
 * which a test could assert through a Mongo round trip.
 */
export function fillPageSections(
  page: DefaultWebsitePage,
  byCategory: Record<string, LibraryChoice[]>,
): DefaultWebsitePage {
  const existing = Array.isArray(page.sections) ? [...page.sections] : [];
  const claimed = new Set<number>();

  /** The page's own section for a category, if it has one. First wins. */
  const takeExisting = (category: SectionCategoryId): DefaultWebsiteSection | null => {
    const index = existing.findIndex(
      (section, i) =>
        !claimed.has(i) &&
        resolveCategory({
          sectionType: section?.sectionType,
          title: section?.title,
          code: section?.code,
        }) === category,
    );
    if (index < 0) return null;
    claimed.add(index);
    return existing[index];
  };

  const sections: DefaultWebsiteSection[] = SECTION_CATEGORY_IDS.map((category, order) => {
    const kept = takeExisting(category);
    if (kept) return { ...kept, sectionType: category, sortOrder: order };

    const fromLibrary = (byCategory[category] || [])[0];
    if (fromLibrary && fromLibrary.code?.trim()) {
      return {
        // Prefixed rather than the raw template id: this is a section on a
        // page, not a reference to the template, and a later edit in Admin ›
        // Templates must not appear to reach into a tenant's copy of it.
        id: `def-${slugKey(page.slug)}-${category}`,
        title: fromLibrary.name || SECTION_STARTERS[category].title,
        sectionType: category,
        sortOrder: order,
        code: fromLibrary.code,
      };
    }

    return starterSection(page.slug, category, order);
  });

  // Whatever the twenty slots did not claim — a duplicate, or a `custom`
  // section — kept, after them, in the order it was already in.
  existing.forEach((section, index) => {
    if (claimed.has(index)) return;
    sections.push({ ...section, sortOrder: sections.length });
  });

  return { ...page, sections };
}

/** Immediately apply newly created or updated Admin Header / Footer section as the live default across all websites */
export async function applyTemplateToDefaultWebsite(
  templateName: string,
  category: string,
  code: string
): Promise<DefaultWebsiteConfig> {
  if (!code || !code.trim()) return getDefaultWebsiteConfig();

  const currentConfig = await getDefaultWebsiteConfig();
  const cleanCategory = (category || "hero").toLowerCase();
  const cleanName = (templateName || "").toLowerCase();

  const isHeader = cleanCategory.includes("header") || cleanCategory.includes("nav") || cleanName.includes("header") || cleanName.includes("nav");
  const isFooter = cleanCategory.includes("footer") || cleanName.includes("footer");

  const targetType = isHeader ? "navbar" : isFooter ? "footer" : cleanCategory;
  const sectionId = isHeader ? "def-home-navbar" : isFooter ? "def-home-footer" : `def-home-${cleanCategory}-${Date.now().toString().slice(-4)}`;

  const updatedPages = currentConfig.pages.map((p) => {
    if (p.slug !== "/home" && p.slug !== "/") return p;

    let sections = Array.isArray(p.sections) ? [...p.sections] : [];

    const secIdx = sections.findIndex((s) => {
      const sType = (s.sectionType || s.id || s.title || "").toLowerCase();
      if (isHeader) return sType.includes("header") || sType.includes("navbar") || sType.includes("nav");
      if (isFooter) return sType.includes("footer");
      return sType === targetType || s.title?.toLowerCase() === templateName.toLowerCase();
    });

    const newSec: DefaultWebsiteSection = {
      id: secIdx >= 0 ? sections[secIdx].id : sectionId,
      title: templateName,
      sectionType: targetType,
      sortOrder: isHeader ? 0 : isFooter ? sections.length : secIdx >= 0 ? sections[secIdx].sortOrder : sections.length,
      code: code,
    };

    if (secIdx >= 0) {
      sections[secIdx] = newSec;
    } else {
      if (isHeader) {
        sections.unshift(newSec);
      } else if (isFooter) {
        sections.push(newSec);
      } else {
        // Insert before footer if footer exists, else append
        const footerIdx = sections.findIndex((s) => (s.sectionType || s.id || "").toLowerCase().includes("footer"));
        if (footerIdx >= 0) {
          sections.splice(footerIdx, 0, newSec);
        } else {
          sections.push(newSec);
        }
      }
    }

    // Re-index sort order
    sections = sections.map((sec, idx) => ({ ...sec, sortOrder: idx }));

    return {
      ...p,
      sections,
    };
  });

  const finalConfig: DefaultWebsiteConfig = { pages: updatedPages };
  return updateDefaultWebsiteConfig(finalConfig);
}
