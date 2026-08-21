import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publishedSiteConfig, __testing } from "@/publishing-service";

const { isEmptyConfig, countSections, configFingerprint } = __testing;

const page = (slug: string, sections: { id: string; code: string }[]) => ({
  slug,
  title: slug,
  sections,
});

describe("publishedSiteConfig — what a visitor is served", () => {
  it("serves the published config once a tenant has published", () => {
    const result = publishedSiteConfig({
      publishedVersion: 3,
      publishedConfig: { pages: [page("/home", [{ id: "a", code: "<p>published</p>" }])] } as never,
      websiteConfig: { pages: [page("/home", [{ id: "a", code: "<p>draft</p>" }])] } as never,
    });
    assert.equal(result?.pages[0]?.sections[0]?.code, "<p>published</p>");
  });

  it("never leaks the draft once published, even if the draft has moved on", () => {
    const result = publishedSiteConfig({
      publishedVersion: 1,
      publishedConfig: { pages: [page("/home", [{ id: "a", code: "<p>v1</p>" }])] } as never,
      websiteConfig: { pages: [page("/home", [{ id: "a", code: "<p>half-typed</p>" }])] } as never,
    });
    assert.equal(result?.pages[0]?.sections[0]?.code, "<p>v1</p>");
  });

  // The migration guarantee: on the day this shipped every tenant had
  // publishedVersion 0, and not one of their sites was allowed to go dark.
  it("falls back to the draft for a tenant that has never published", () => {
    const result = publishedSiteConfig({
      publishedVersion: 0,
      publishedConfig: null,
      websiteConfig: { pages: [page("/home", [{ id: "a", code: "<p>existing site</p>" }])] } as never,
    });
    assert.equal(result?.pages[0]?.sections[0]?.code, "<p>existing site</p>");
  });

  it("ignores a stale publishedConfig when the version says never published", () => {
    const result = publishedSiteConfig({
      publishedVersion: 0,
      publishedConfig: { pages: [page("/home", [{ id: "a", code: "<p>stale</p>" }])] } as never,
      websiteConfig: { pages: [page("/home", [{ id: "a", code: "<p>draft</p>" }])] } as never,
    });
    assert.equal(result?.pages[0]?.sections[0]?.code, "<p>draft</p>");
  });

  it("returns null when there is nothing at all", () => {
    assert.equal(publishedSiteConfig({ publishedVersion: 0 }), null);
  });
});

describe("isEmptyConfig — refusing to publish nothing over something", () => {
  it("treats null and undefined as empty", () => {
    assert.equal(isEmptyConfig(null), true);
    assert.equal(isEmptyConfig(undefined), true);
  });

  it("treats a config with no pages as empty", () => {
    assert.equal(isEmptyConfig({ pages: [] } as never), true);
  });

  // The case that matters: pages exist but every one is blank. Publishing this
  // over a working site would take it down.
  it("treats pages that hold no sections as empty", () => {
    assert.equal(isEmptyConfig({ pages: [page("/home", []), page("/about", [])] } as never), true);
  });

  it("is not empty when any page has a section", () => {
    assert.equal(
      isEmptyConfig({ pages: [page("/home", []), page("/about", [{ id: "a", code: "x" }])] } as never),
      false,
    );
  });
});

describe("countSections", () => {
  it("totals across pages", () => {
    assert.equal(
      countSections({
        pages: [
          page("/home", [{ id: "a", code: "x" }, { id: "b", code: "y" }]),
          page("/about", [{ id: "c", code: "z" }]),
        ],
      } as never),
      3,
    );
  });

  it("survives a malformed page", () => {
    assert.equal(countSections({ pages: [{ slug: "/x" }] } as never), 0);
  });
});

describe("configFingerprint — has the tenant got unpublished changes?", () => {
  const draft = { pages: [page("/home", [{ id: "a", code: "<p>one</p>" }])] } as never;

  it("says nothing changed when nothing changed", () => {
    const same = { pages: [page("/home", [{ id: "a", code: "<p>one</p>" }])] } as never;
    assert.equal(configFingerprint(draft), configFingerprint(same));
  });

  it("notices edited section content", () => {
    const edited = { pages: [page("/home", [{ id: "a", code: "<p>two</p>" }])] } as never;
    assert.notEqual(configFingerprint(draft), configFingerprint(edited));
  });

  it("notices a reordered section", () => {
    const a = {
      pages: [page("/home", [{ id: "a", code: "x" }, { id: "b", code: "y" }])],
    } as never;
    const b = {
      pages: [page("/home", [{ id: "b", code: "y" }, { id: "a", code: "x" }])],
    } as never;
    assert.notEqual(configFingerprint(a), configFingerprint(b));
  });

  it("notices an added page", () => {
    const more = {
      pages: [page("/home", [{ id: "a", code: "<p>one</p>" }]), page("/about", [])],
    } as never;
    assert.notEqual(configFingerprint(draft), configFingerprint(more));
  });

  // A publish must not be demanded because Mongo touched a timestamp.
  it("ignores fields that do not render", () => {
    const noisy = {
      pages: [
        {
          slug: "/home",
          title: "Home",
          updatedAt: new Date().toISOString(),
          sections: [{ id: "a", code: "<p>one</p>", sortOrder: 0, variantIndex: 2 }],
        },
      ],
    } as never;
    assert.equal(configFingerprint(draft), configFingerprint(noisy));
  });
});
