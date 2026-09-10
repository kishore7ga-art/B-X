import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CATALOGUE, normaliseCatalogue } from "@/device-catalogue-service";

describe("normaliseCatalogue", () => {
  it("accepts the seed and serves it sorted by tier order then width", () => {
    const { tiers, presets } = normaliseCatalogue(DEFAULT_CATALOGUE);
    assert.deepEqual(
      tiers.map((t) => t.id),
      ["desktop", "tablet", "phone"],
    );
    const widths = presets.map((p) => `${p.tierId}:${p.width}`);
    assert.equal(widths[0], "desktop:1024");
    assert.equal(widths[9], "desktop:3840");
    assert.equal(widths[10], "tablet:600");
    assert.equal(widths[29], "phone:540");
    assert.equal(presets.length, 30);
  });

  it("gives every preset an id and exactly one default per tier", () => {
    const { presets } = normaliseCatalogue(DEFAULT_CATALOGUE);
    assert.ok(presets.every((p) => typeof p.id === "string" && p.id.length > 0));
    const defaults = presets.filter((p) => p.isDefault).map((p) => `${p.tierId}:${p.width}`);
    assert.deepEqual(defaults, ["desktop:1440", "tablet:768", "phone:390"]);
  });

  it("makes the smallest width the default when a tier names none", () => {
    const { presets } = normaliseCatalogue({
      tiers: [{ id: "watch", label: "Watch", icon: "phone", order: 0 }],
      presets: [
        { tierId: "watch", width: 240 },
        { tierId: "watch", width: 200 },
      ],
    });
    assert.deepEqual(
      presets.map((p) => [p.width, p.isDefault]),
      [
        [200, true],
        [240, false],
      ],
    );
  });

  it("keeps a tier with no presets — the editor shows it disabled", () => {
    const { tiers, presets } = normaliseCatalogue({
      tiers: [
        { id: "tv", label: "TV", icon: "desktop", order: 0 },
        { id: "phone", label: "Phone", icon: "phone", order: 1 },
      ],
      presets: [{ tierId: "phone", width: 390 }],
    });
    assert.equal(tiers.length, 2);
    assert.equal(presets.length, 1);
  });

  it("rejects what would break a cycling client", () => {
    const tiers = [{ id: "phone", label: "Phone", icon: "phone", order: 0 }];
    assert.throws(
      () => normaliseCatalogue({ tiers, presets: [{ tierId: "phone", width: 390 }, { tierId: "phone", width: 390 }] }),
      /appears twice/,
    );
    assert.throws(
      () => normaliseCatalogue({ tiers, presets: [{ tierId: "tablet", width: 768 }] }),
      /does not exist/,
    );
    assert.throws(
      () =>
        normaliseCatalogue({
          tiers,
          presets: [
            { tierId: "phone", width: 375, isDefault: true },
            { tierId: "phone", width: 390, isDefault: true },
          ],
        }),
      /more than one default/,
    );
    assert.throws(() => normaliseCatalogue({ tiers: [...tiers, ...tiers], presets: [] }), /appears twice/);
    assert.throws(() => normaliseCatalogue({ tiers, presets: [{ tierId: "phone", width: 10 }] }));
    assert.throws(() => normaliseCatalogue({ tiers, presets: [{ tierId: "phone", width: 390.5 }] }));
    assert.throws(() => normaliseCatalogue({ tiers: [{ ...tiers[0], icon: "watch" }], presets: [] }));
  });
});
