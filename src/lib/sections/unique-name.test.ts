import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getUniqueSectionName } from "./unique-name";

describe("getUniqueSectionName (xite-B)", () => {
  it("returns original name when no conflicts exist", () => {
    assert.equal(getUniqueSectionName("Hero", []), "Hero");
    assert.equal(getUniqueSectionName("About Us", ["Hero", "Contact"]), "About Us");
  });

  it("appends 2 when exact duplicate exists", () => {
    assert.equal(getUniqueSectionName("Hero", ["Hero"]), "Hero 2");
    assert.equal(getUniqueSectionName("hero", ["Hero"]), "hero 2");
  });

  it("increments to 3 when Hero and Hero 2 exist", () => {
    assert.equal(getUniqueSectionName("Hero", ["Hero", "Hero 2"]), "Hero 3");
  });

  it("handles base name ending with numbers", () => {
    assert.equal(getUniqueSectionName("Hero 2", ["Hero 2"]), "Hero 3");
    assert.equal(getUniqueSectionName("Hero 2", ["Hero 2", "Hero 3"]), "Hero 4");
  });

  it("handles complex template name format", () => {
    const existing = [
      "Hero Banner [hero] - Hero Banner Variant",
      "Hero Banner [hero] - Hero Banner Variant 2",
    ];
    assert.equal(
      getUniqueSectionName("Hero Banner [hero] - Hero Banner Variant", existing),
      "Hero Banner [hero] - Hero Banner Variant 3",
    );
  });

  it("handles empty or whitespace strings", () => {
    assert.equal(getUniqueSectionName("", []), "Section 1");
    assert.equal(getUniqueSectionName("  ", ["Section 1"]), "Section 2");
  });

  it("handles 10+ sequential additions cleanly", () => {
    const names: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const unique = getUniqueSectionName("Hero", names);
      names.push(unique);
    }
    assert.deepEqual(names, [
      "Hero",
      "Hero 2",
      "Hero 3",
      "Hero 4",
      "Hero 5",
      "Hero 6",
      "Hero 7",
      "Hero 8",
      "Hero 9",
      "Hero 10",
      "Hero 11",
      "Hero 12",
    ]);
  });
});
