import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { onboardingPayloadFor, onboardingSchema } from "@/onboarding-service";
import { destinationFor } from "@/auth-service";
import { EDITOR_FONT_IDS, EDITOR_THEME_IDS } from "@/lib/editor-themes";
import { ONBOARDING_ROLES } from "@/lib/api-contract";

const valid = {
  role: "principal",
  themePaletteId: "academic-blue",
  themeFontId: "inter",
};

describe("onboardingSchema — three answers, all of them checked", () => {
  it("accepts a complete, valid set", () => {
    const parsed = onboardingSchema.safeParse(valid);
    assert.equal(parsed.success, true);
  });

  it("accepts every role the wizard is allowed to offer", () => {
    // The form renders its buttons from this same list. A role that renders and
    // then fails to submit is the exact failure the shared list exists to stop.
    for (const role of ONBOARDING_ROLES) {
      const parsed = onboardingSchema.safeParse({ ...valid, role: role.id });
      assert.equal(parsed.success, true, `role ${role.id} was rejected`);
    }
  });

  it("accepts every theme and font the renderer actually ships", () => {
    for (const themePaletteId of EDITOR_THEME_IDS) {
      assert.equal(onboardingSchema.safeParse({ ...valid, themePaletteId }).success, true);
    }
    for (const themeFontId of EDITOR_FONT_IDS) {
      assert.equal(onboardingSchema.safeParse({ ...valid, themeFontId }).success, true);
    }
  });

  it("refuses a theme no renderer answers to", () => {
    // Storing one is a site that loads with no styling, and the tenant's only
    // clue is that it looked right in the wizard.
    const parsed = onboardingSchema.safeParse({ ...valid, themePaletteId: "cyber-neon" });
    assert.equal(parsed.success, false);
  });

  it("refuses a font no renderer answers to", () => {
    assert.equal(onboardingSchema.safeParse({ ...valid, themeFontId: "comic" }).success, false);
  });

  it("refuses a role that is not on the list", () => {
    assert.equal(onboardingSchema.safeParse({ ...valid, role: "superuser" }).success, false);
  });

  it("refuses a partial answer rather than storing two of three", () => {
    // Half a wizard leaves a college with a theme, no font, and no state that
    // anything downstream knows how to render.
    for (const key of ["role", "themePaletteId", "themeFontId"] as const) {
      const partial: Record<string, unknown> = { ...valid };
      delete partial[key];
      assert.equal(onboardingSchema.safeParse(partial).success, false, `${key} was optional`);
    }
  });

  it("survives junk without throwing", () => {
    for (const input of [null, undefined, "", 0, [], { role: [] }]) {
      assert.doesNotThrow(() => onboardingSchema.safeParse(input));
      assert.equal(onboardingSchema.safeParse(input).success, false);
    }
  });

  it("says which answer was wrong, not that the form was invalid", () => {
    const parsed = onboardingSchema.safeParse({ ...valid, themeFontId: "comic" });
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.match(parsed.error.issues[0].message, /font/i);
    }
  });
});

describe("onboardingPayloadFor — completed is derived, never stored twice", () => {
  it("reports a stamped college as completed", () => {
    const at = new Date("2026-01-02T03:04:05.000Z");
    const payload = onboardingPayloadFor({
      ownerRole: "principal",
      themePaletteId: "academic-blue",
      themeFontId: "inter",
      onboardingCompletedAt: at,
    });
    assert.equal(payload.completed, true);
    assert.equal(payload.completedAt, at.toISOString());
    assert.equal(payload.role, "principal");
  });

  it("reports a college that predates the wizard as not completed", () => {
    // Every tenant provisioned before onboarding existed lands here, and the
    // nulls are the honest answer: nobody ever asked them.
    const payload = onboardingPayloadFor({});
    assert.deepEqual(payload, {
      completed: false,
      role: null,
      themePaletteId: null,
      themeFontId: null,
      completedAt: null,
    });
  });

  it("does not call a college onboarded just because it has a theme", () => {
    // A theme set from the editor drawer is not a wizard that was completed,
    // and conflating the two would skip onboarding for someone who never saw it.
    const payload = onboardingPayloadFor({
      themePaletteId: "emerald-gold",
      themeFontId: "outfit",
      onboardingCompletedAt: null,
    });
    assert.equal(payload.completed, false);
  });
});

describe("destinationFor — where a sign-in lands", () => {
  it("sends an un-onboarded college to the wizard", () => {
    assert.equal(destinationFor({ subdomain: "stanford" }), "/onboarding");
  });

  it("sends an onboarded college to its own editor", () => {
    assert.equal(
      destinationFor({ subdomain: "stanford", onboardingCompletedAt: new Date() }),
      "/editor/stanford",
    );
  });

  it("never sends anyone to another tenant's editor", () => {
    // This returned a hardcoded `/editor/mec` in two of the frontend's routes.
    const next = destinationFor({ subdomain: "greenfield", onboardingCompletedAt: new Date() });
    assert.equal(next, "/editor/greenfield");
    assert.doesNotMatch(next, /mec/);
  });
});
