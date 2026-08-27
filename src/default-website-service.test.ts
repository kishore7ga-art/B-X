import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fillPageSections, type LibraryChoice } from "@/default-website-service";
import { SECTION_CATEGORY_IDS } from "@/lib/sections/categories";
import { SECTION_STARTERS } from "@/lib/sections/section-starters";
import { sanitizeSectionHtml } from "@/lib/sections/sanitize-section-html";

const emptyLibrary: Record<string, LibraryChoice[]> = {};

const page = (sections: Array<Record<string, unknown>> = []) => ({
  slug: "/home",
  title: "Home",
  sections: sections.map((section, index) => ({
    id: `s${index}`,
    title: "Section",
    sectionType: "custom",
    code: "<section><p>hello</p></section>",
    sortOrder: index,
    ...section,
  })) as never,
});

describe("fillPageSections — every category, in the order a site is read", () => {
  it("gives an empty page all twenty", () => {
    const filled = fillPageSections(page(), emptyLibrary);
    assert.equal(filled.sections.length, SECTION_CATEGORY_IDS.length);
    assert.deepEqual(
      filled.sections.map((s) => s.sectionType),
      [...SECTION_CATEGORY_IDS],
    );
  });

  it("puts the navbar first and the footer last", () => {
    // Canonical order is not decoration: the editor seeds a whole page from
    // this config in one go, so this order *is* the tenant's page.
    const filled = fillPageSections(page(), emptyLibrary);
    assert.equal(filled.sections[0].sectionType, "navbar");
    assert.equal(filled.sections[filled.sections.length - 1].sectionType, "footer");
  });

  it("numbers sortOrder by position, which is what every reader sorts on", () => {
    const filled = fillPageSections(page(), emptyLibrary);
    filled.sections.forEach((section, index) => assert.equal(section.sortOrder, index));
  });
});

describe("fillPageSections — nothing an admin arranged is discarded", () => {
  it("keeps an existing section's id, title and markup, and moves it to its slot", () => {
    const filled = fillPageSections(
      page([
        { id: "my-footer", title: "Our footer", sectionType: "footer", code: "<footer>ours</footer>" },
        { id: "my-nav", title: "Our navbar", sectionType: "navbar", code: "<header>ours</header>" },
      ]),
      emptyLibrary,
    );

    const navbar = filled.sections[0];
    assert.equal(navbar.id, "my-nav");
    assert.equal(navbar.title, "Our navbar");
    assert.equal(navbar.code, "<header>ours</header>");

    const footer = filled.sections[SECTION_CATEGORY_IDS.length - 1];
    assert.equal(footer.id, "my-footer");
    assert.equal(footer.code, "<footer>ours</footer>");
  });

  it("recognises a section by its title when its type is missing", () => {
    // Sections predating the canonical ids carry a type the platform does not
    // know, and `resolveCategory` is the one rule that reads them.
    const filled = fillPageSections(
      page([{ id: "old", title: "Hero Banner", sectionType: "", code: "<section>old</section>" }]),
      emptyLibrary,
    );
    const hero = filled.sections.find((s) => s.sectionType === "hero");
    assert.equal(hero?.id, "old");
    assert.equal(filled.sections.length, SECTION_CATEGORY_IDS.length);
  });

  it("keeps a leftover after the twenty rather than dropping it", () => {
    // A second Hero, and a section belonging to no category. Deleting either
    // would make this button destructive on the one page most likely to have
    // real work in it.
    const filled = fillPageSections(
      page([
        { id: "hero-a", sectionType: "hero", title: "Hero A" },
        { id: "hero-b", sectionType: "hero", title: "Hero B" },
        { id: "odd", sectionType: "custom", title: "Sponsor strip" },
      ]),
      emptyLibrary,
    );

    assert.equal(filled.sections.length, SECTION_CATEGORY_IDS.length + 2);
    const tail = filled.sections.slice(SECTION_CATEGORY_IDS.length).map((s) => s.id);
    assert.deepEqual(tail, ["hero-b", "odd"], "the leftovers lost their order");
    assert.equal(filled.sections.find((s) => s.sectionType === "hero")?.id, "hero-a");
  });
});

describe("fillPageSections — the library wins over the starter", () => {
  const library: Record<string, LibraryChoice[]> = {
    hero: [
      { name: "Ivy Masthead", code: "<section>ivy</section>" },
      { name: "Second Hero", code: "<section>second</section>" },
    ],
  };

  it("takes the first published template for a category", () => {
    const hero = fillPageSections(page(), library).sections.find((s) => s.sectionType === "hero");
    assert.equal(hero?.code, "<section>ivy</section>");
    assert.equal(hero?.title, "Ivy Masthead");
  });

  it("falls back to the starter only where the library has nothing", () => {
    const filled = fillPageSections(page(), library);
    const about = filled.sections.find((s) => s.sectionType === "about");
    assert.equal(about?.code, SECTION_STARTERS.about.code);
  });

  it("does not reuse the template's own id", () => {
    // This is a section on a page, not a reference to the template. Sharing an
    // id is what lets a later edit in Admin > Templates appear to reach into a
    // tenant's copy of it.
    const hero = fillPageSections(page(), library).sections.find((s) => s.sectionType === "hero");
    assert.equal(hero?.id, "def-home-hero");
  });

  it("ignores a template whose code is blank", () => {
    const filled = fillPageSections(page(), { hero: [{ name: "Empty", code: "   " }] });
    assert.equal(
      filled.sections.find((s) => s.sectionType === "hero")?.code,
      SECTION_STARTERS.hero.code,
    );
  });
});

describe("fillPageSections — idempotent", () => {
  it("a second pass changes nothing", () => {
    // A button whose second press quietly doubles a page is a button nobody
    // dares use.
    const once = fillPageSections(page(), emptyLibrary);
    const twice = fillPageSections(once, emptyLibrary);
    assert.deepEqual(twice, once);
  });

  it("a second pass changes nothing on a page that had sections of its own", () => {
    const start = page([
      { id: "my-nav", sectionType: "navbar", title: "Our navbar" },
      { id: "odd", sectionType: "custom", title: "Sponsor strip" },
    ]);
    const once = fillPageSections(start, emptyLibrary);
    assert.deepEqual(fillPageSections(once, emptyLibrary), once);
  });
});

describe("SECTION_STARTERS — one for every category, and all of them renderable", () => {
  it("covers every canonical id", () => {
    for (const id of SECTION_CATEGORY_IDS) {
      assert.ok(SECTION_STARTERS[id], `no starter for ${id}`);
      assert.ok(SECTION_STARTERS[id].code.trim().length > 0, `${id} has no markup`);
      assert.ok(SECTION_STARTERS[id].title.trim().length > 0, `${id} has no title`);
    }
  });

  it("uses no viewport units", () => {
    // `vw` resolves against the window, which is not the canvas in the editor.
    // See `viewportUnitsToContainer` in section-runtime.ts — the runtime
    // rewrites them, but markup the platform authors itself should not need it.
    for (const id of SECTION_CATEGORY_IDS) {
      assert.doesNotMatch(SECTION_STARTERS[id].code, /\d\s*vw\b/, `${id} uses vw`);
    }
  });

  it("uses no tag the section sanitiser discards", () => {
    // An <iframe> or a <script> here would reach the tenant as an empty band.
    for (const id of SECTION_CATEGORY_IDS) {
      assert.doesNotMatch(SECTION_STARTERS[id].code, /<(script|iframe|object|embed)\b/i, id);
    }
  });

  /**
   * Survives the pass every section goes through on the way to a tenant.
   *
   * `updateDefaultWebsiteConfig` sanitises what it writes, so a starter using a
   * tag or attribute the allowlist does not carry would be stored with pieces
   * missing — and it would look fine here and wrong on the college's site.
   * Asserted on the elements each block is actually built from rather than on
   * byte equality, because the sanitiser normalises quoting and attribute order
   * and that difference is not a loss.
   */
  it("survives sanitisation with its structure and styling intact", () => {
    for (const id of SECTION_CATEGORY_IDS) {
      const before = SECTION_STARTERS[id].code;
      const after = sanitizeSectionHtml(before);

      assert.ok(after.trim().length > 0, `${id} was emptied`);

      const tags = (source: string) =>
        (source.match(/<([a-z][a-z0-9]*)\b/gi) || []).map((tag) => tag.slice(1).toLowerCase()).sort();
      assert.deepEqual(tags(after), tags(before), `${id} lost or gained an element`);

      const styleCount = (source: string) => (source.match(/\sstyle=/gi) || []).length;
      assert.equal(styleCount(after), styleCount(before), `${id} lost an inline style`);
    }
  });
});
