import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalSlug,
  normalizeConfig,
  pageIdFor,
  restoreTemplateScripts,
} from "@/website-config-service";

const section = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  title: "Section",
  code: "<section><p>hello</p></section>",
  ...over,
});

describe("canonicalSlug — one page, one name", () => {
  it("gives the same answer for every spelling of the same page", () => {
    for (const spelling of ["/about", "about", "//about//", "  About  ", "/About/"]) {
      assert.equal(canonicalSlug(spelling), "/about", `for ${JSON.stringify(spelling)}`);
    }
  });

  it("keeps nesting, and turns spaces into hyphens", () => {
    assert.equal(canonicalSlug("/programs/MBA"), "/programs/mba");
    assert.equal(canonicalSlug("Campus Life"), "/campus-life");
  });

  it("is empty for nothing, so a caller can tell that apart from a real slug", () => {
    assert.equal(canonicalSlug(""), "");
    assert.equal(canonicalSlug("/"), "");
    assert.equal(canonicalSlug(undefined), "");
  });
});

describe("pageIdFor — stable identity for pages that predate page ids", () => {
  it("derives the same id every time, so a client keyed by it never resets", () => {
    assert.equal(pageIdFor("/about"), pageIdFor("about"));
    assert.equal(pageIdFor("/programs/mba"), "page-programs-mba");
  });
});

describe("normalizeConfig — array position IS the order", () => {
  it("renumbers sortOrder to the array index", () => {
    const out = normalizeConfig({
      pages: [{ slug: "/home", title: "Home", sections: [section({ id: "a" }), section({ id: "b" }), section({ id: "c" })] }],
    });
    assert.deepEqual(
      out.pages[0]!.sections.map((s) => [s.id, s.sortOrder]),
      [["a", 0], ["b", 1], ["c", 2]],
    );
  });

  it("honours a sortOrder the client reordered instead of the array", () => {
    const out = normalizeConfig({
      pages: [
        {
          slug: "/home",
          title: "Home",
          sections: [
            section({ id: "a", sortOrder: 2 }),
            section({ id: "b", sortOrder: 0 }),
            section({ id: "c", sortOrder: 1 }),
          ],
        },
      ],
    });
    assert.deepEqual(out.pages[0]!.sections.map((s) => s.id), ["b", "c", "a"]);
    // ...and the two agree afterwards, so the next reader cannot disagree.
    assert.deepEqual(out.pages[0]!.sections.map((s) => s.sortOrder), [0, 1, 2]);
  });

  it("leaves an order alone when every section shares a sortOrder", () => {
    const out = normalizeConfig({
      pages: [
        {
          slug: "/home",
          title: "Home",
          sections: [section({ id: "a", sortOrder: 0 }), section({ id: "b", sortOrder: 0 })],
        },
      ],
    });
    assert.deepEqual(out.pages[0]!.sections.map((s) => s.id), ["a", "b"]);
  });
});

describe("normalizeConfig — the shape every reader can rely on", () => {
  it("resolves a category from whichever field carried it", () => {
    const out = normalizeConfig({
      pages: [
        {
          slug: "/home",
          title: "Home",
          sections: [
            section({ id: "a", category: "Header Navigation" }),
            section({ id: "b", sectionType: "banner" }),
            section({ id: "c", title: "Admission Enquiry" }),
            section({ id: "d", code: "<footer>x</footer>" }),
          ],
        },
      ],
    });
    assert.deepEqual(out.pages[0]!.sections.map((s) => s.sectionType), [
      "navbar",
      "hero",
      "admissions",
      "footer",
    ]);
  });

  it("carries templateId through, which is what makes swapping deterministic", () => {
    const out = normalizeConfig({
      pages: [{ slug: "/home", title: "Home", sections: [section({ templateId: "tpl-7", variantIndex: 2 })] }],
    });
    assert.equal(out.pages[0]!.sections[0]!.templateId, "tpl-7");
    assert.equal(out.pages[0]!.sections[0]!.variantIndex, 2);
  });

  it("accepts html and content as aliases for code", () => {
    const out = normalizeConfig({
      pages: [
        {
          slug: "/home",
          title: "Home",
          sections: [
            { id: "a", html: "<section>from html</section>" },
            { id: "b", content: "<section>from content</section>" },
          ],
        },
      ],
    });
    assert.equal(out.pages[0]!.sections.length, 2);
  });

  it("drops a section with no markup rather than storing an invisible row", () => {
    const out = normalizeConfig({
      pages: [{ slug: "/home", title: "Home", sections: [section({ id: "a" }), { id: "b", code: "   " }] }],
    });
    assert.deepEqual(out.pages[0]!.sections.map((s) => s.id), ["a"]);
  });

  it("re-ids a duplicate rather than letting two sections share one identity", () => {
    const out = normalizeConfig({
      pages: [{ slug: "/home", title: "Home", sections: [section({ id: "dup" }), section({ id: "dup" })] }],
    });
    const ids = out.pages[0]!.sections.map((s) => s.id);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
  });
});

describe("normalizeConfig — pages stay separate", () => {
  it("keeps each page's sections on that page", () => {
    const out = normalizeConfig({
      pages: [
        { slug: "/home", title: "Home", sections: [section({ id: "home-1" })] },
        { slug: "/about", title: "About", sections: [section({ id: "about-1" })] },
      ],
    });
    assert.deepEqual(out.pages.map((p) => p.slug), ["/home", "/about"]);
    assert.deepEqual(out.pages[0]!.sections.map((s) => s.id), ["home-1"]);
    assert.deepEqual(out.pages[1]!.sections.map((s) => s.id), ["about-1"]);
  });

  it("merges two spellings of one slug instead of accumulating both", () => {
    const out = normalizeConfig({
      pages: [
        { slug: "/about", title: "About", sections: [section({ id: "old" })] },
        { slug: "about", title: "About Us", sections: [section({ id: "new" })] },
      ],
    });
    assert.equal(out.pages.length, 1);
    assert.deepEqual(out.pages[0]!.sections.map((s) => s.id), ["new"]);
  });

  it("keeps an empty page, because an empty page is a real answer", () => {
    const out = normalizeConfig({ pages: [{ slug: "/contact", title: "Contact", sections: [] }] });
    assert.equal(out.pages.length, 1);
    assert.deepEqual(out.pages[0]!.sections, []);
  });

  it("drops a page with no usable slug rather than filing it under a guess", () => {
    const out = normalizeConfig({
      pages: [{ slug: "", title: "Nameless", sections: [section()] }, { slug: "/home", title: "Home", sections: [] }],
    });
    assert.deepEqual(out.pages.map((p) => p.slug), ["/home"]);
  });

  it("survives junk without throwing", () => {
    assert.deepEqual(normalizeConfig(null), { pages: [] });
    assert.deepEqual(normalizeConfig({ pages: "nope" }), { pages: [] });
    assert.deepEqual(normalizeConfig({ pages: [null, 7, "x"] }), { pages: [] });
  });
});

describe("restoreTemplateScripts — a section built by JavaScript", () => {
  it("leaves a config with no templateIds alone", async () => {
    const config = { pages: [{ slug: "/home", title: "Home", sections: [section()] }] };
    assert.equal(await restoreTemplateScripts(config), config);
  });

  it("survives junk without throwing", async () => {
    assert.deepEqual(await restoreTemplateScripts(null), null);
    assert.deepEqual(await restoreTemplateScripts({ pages: "nope" }), { pages: "nope" });
    assert.deepEqual(await restoreTemplateScripts({}), {});
  });

  it("does not reach the database when nothing references a template", async () => {
    // The guard that keeps `GET /my-website` at one query for the common case:
    // a config whose sections were all hand-added carries no templateId, so
    // there is nothing to look up.
    const config = {
      pages: [
        { slug: "/home", title: "Home", sections: [section({ templateId: null })] },
        { slug: "/about", title: "About", sections: [] },
      ],
    };
    assert.equal(await restoreTemplateScripts(config), config);
  });
});
