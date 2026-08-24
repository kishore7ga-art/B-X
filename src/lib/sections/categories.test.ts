import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeCategory, resolveCategory, SECTION_CATEGORY_IDS, UNCATEGORISED } from "@/lib/sections/categories";

describe("normalizeCategory — the aliases that were getting sections mis-filed", () => {
  it("files an admissions section as admissions, not vision", () => {
    // "admission" contains "mission". The old ladder tested vision first, so
    // every Admissions template in the library was a Vision & Mission variant.
    assert.equal(normalizeCategory("Admission Enquiry"), "admissions");
    assert.equal(normalizeCategory("admissions"), "admissions");
    assert.equal(normalizeCategory("Vision & Mission"), "vision");
  });

  it("files campus life under gallery and campus facilities under facilities", () => {
    assert.equal(normalizeCategory("Gallery / Campus Life"), "gallery");
    assert.equal(normalizeCategory("Campus Facilities"), "facilities");
  });

  it("treats every spelling of the top bar as navbar", () => {
    for (const spelling of ["navbar", "Header", "Header Navigation", "nav", "Top Bar"]) {
      assert.equal(normalizeCategory(spelling), "navbar", `for ${spelling}`);
    }
  });

  it("reads the Admin Studio's [bracket] convention", () => {
    assert.equal(normalizeCategory("[navbar] Dark header"), "navbar");
    assert.equal(normalizeCategory("[Placements] Top recruiters"), "placements");
  });

  it("passes every canonical id through unchanged", () => {
    for (const id of SECTION_CATEGORY_IDS) {
      assert.equal(normalizeCategory(id), id);
    }
  });

  it("says nothing for nothing, and custom for something unrecognised", () => {
    assert.equal(normalizeCategory(""), "");
    assert.equal(normalizeCategory(null), "");
    assert.equal(normalizeCategory("Quantum Teleportation Bay"), UNCATEGORISED);
  });
});

describe("resolveCategory — explicit beats inferred", () => {
  it("believes the author's category over the markup", () => {
    assert.equal(
      resolveCategory({ category: "contact", code: "<section><footer>legal</footer></section>" }),
      "contact",
    );
  });

  it("falls back through sectionType, then type, then the name", () => {
    assert.equal(resolveCategory({ sectionType: "banner" }), "hero");
    assert.equal(resolveCategory({ type: "recruiters" }), "placements");
    assert.equal(resolveCategory({ name: "Student Testimonials" }), "testimonials");
  });

  it("sniffs only the two structural tags, and only as a last resort", () => {
    assert.equal(resolveCategory({ code: "<header>x</header>" }), "navbar");
    assert.equal(resolveCategory({ code: "<footer>x</footer>" }), "footer");
    // `<head` must not match `<header` — that mis-match is what used to strip
    // the wrapper element off every navbar section on the canvas.
    assert.equal(resolveCategory({ code: "<head><title>x</title></head>" }), UNCATEGORISED);
  });

  it("returns custom when nothing says anything", () => {
    assert.equal(resolveCategory({ code: "<div>plain</div>" }), UNCATEGORISED);
    assert.equal(resolveCategory({}), UNCATEGORISED);
  });
});
