import { SystemSecret, AuditLog } from "@/models";
import { sanitizeWebsiteConfig } from "@/lib/sections/sanitize-section-html";

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

// Initial default website structure containing strictly Header and Footer
export const HEADER_SECTION_CODE = `<header style="background: #0d1527; color: #ffffff; padding: 18px 40px; display: flex; align-items: center; justify-content: space-between; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box; border-bottom: 1px solid rgba(255,255,255,0.1); position: relative;">
  <div style="display: flex; align-items: center; gap: 12px;">
    <div style="width: 40px; height: 40px; border-radius: 10px; background: #2563eb; color: #ffffff; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 18px;">🎓</div>
    <span style="font-size: 20px; font-weight: 900; color: #ffffff; white-space: nowrap;">GREENFIELD UNIVERSITY</span>
  </div>
  <nav style="display: flex; gap: 24px; font-size: 14px; font-weight: 700;">
    <a href="#about" style="color: #cbd5e1; text-decoration: none;">About</a>
    <a href="#courses" style="color: #cbd5e1; text-decoration: none;">Academics</a>
    <a href="#admissions" style="color: #cbd5e1; text-decoration: none;">Admissions</a>
    <a href="#contact" style="color: #cbd5e1; text-decoration: none;">Contact</a>
  </nav>
  <a href="#apply" style="background: #2563eb; color: #ffffff; padding: 10px 24px; border-radius: 10px; font-size: 13px; font-weight: 800; text-decoration: none;">Apply Now</a>
</header>`;

export const FOOTER_SECTION_CODE = `<footer style="background: #090d16; color: #94a3b8; padding: 40px 40px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box; border-top: 1px solid #1e293b; text-align: center;">
  <p style="font-size: 13px; font-weight: 700; color: #cbd5e1; margin: 0;">© 2026 Greenfield University. All Rights Reserved.</p>
  <p style="font-size: 12px; color: #64748b; margin-top: 8px;">Approved by AICTE, UGC & Accredited by NAAC A++ Grade.</p>
</footer>`;

const INITIAL_DEFAULT_WEBSITE: DefaultWebsiteConfig = {
  pages: [
    {
      slug: "/home",
      title: "Home",
      sections: [
        {
          id: "def-home-navbar",
          title: "Navbar / Header",
          sectionType: "navbar",
          sortOrder: 0,
          code: HEADER_SECTION_CODE,
        },
        {
          id: "def-home-footer",
          title: "Footer",
          sectionType: "footer",
          sortOrder: 1,
          code: FOOTER_SECTION_CODE,
        },
      ],
    },
    { slug: "/about", title: "About Us", sections: [] },
    { slug: "/academics", title: "Academics", sections: [] },
    { slug: "/placements", title: "Placements", sections: [] },
    { slug: "/contact", title: "Contact Us", sections: [] },
  ],
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
