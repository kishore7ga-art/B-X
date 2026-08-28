/**
 * The three questions a new tenant answers before they reach the editor.
 *
 * ── Why this is a service and not three fields on a route ──────────────────
 *
 * Role, theme and font are one decision made in one sitting, and they have to
 * land together. Written a field at a time — which is what the editor's
 * `PUT /my-theme` does, correctly, for somebody changing their mind later — a
 * tenant who closes the tab after question two is left with a theme, no font
 * and no record of where they got to. Neither "onboarded" nor "new", and the
 * only two states anything downstream knows how to render.
 *
 * So `completeOnboarding` validates all three and writes all three, or writes
 * nothing. `onboardingCompletedAt` is set in the same update, which makes
 * "finished the wizard" and "has a theme and a font" the same fact rather than
 * two that can disagree.
 *
 * ── Why it does not own theme and font ─────────────────────────────────────
 *
 * It writes `themePaletteId` and `themeFontId` — the fields the editor drawer,
 * the preview and the published renderer already read. It does not introduce
 * an onboarding-specific copy of them. A second place a project's theme could
 * live is precisely how a site ends up rendering one theme in the studio and
 * another in public, and the whole point of asking at onboarding is that the
 * answer is the project default from that moment on.
 */

import { z } from "zod";

import { College } from "@/models";
import { AuthError } from "@/auth-service";
import { NotFound } from "@/errors";
import { EDITOR_FONT_IDS, EDITOR_THEME_IDS } from "@/lib/editor-themes";
import { ONBOARDING_ROLES, type OnboardingPayload } from "@/lib/api-contract";

/**
 * Built from the shared list rather than written out here.
 *
 * `z.enum` needs a non-empty tuple, hence the spread with an explicit first
 * element — which also means adding a role to the contract cannot silently
 * leave this behind, because removing them all stops compiling.
 */
const ROLE_IDS = ONBOARDING_ROLES.map((role) => role.id);

export const onboardingSchema = z.object({
  role: z.enum(ROLE_IDS as [string, ...string[]], {
    error: "Choose the option that best describes your role",
  }),
  /**
   * Validated against the renderer's own list, not against a copy.
   *
   * `EDITOR_THEME_IDS` is what the frontend actually ships components for. A
   * theme id that passes here but has no renderer is a site that loads with no
   * styling at all, and the tenant's only clue is that it looked fine in the
   * wizard.
   */
  themePaletteId: z.enum(EDITOR_THEME_IDS, {
    error: "Choose one of the available website themes",
  }),
  themeFontId: z.enum(EDITOR_FONT_IDS, {
    error: "Choose one of the available fonts",
  }),
});

export type OnboardingInput = z.infer<typeof onboardingSchema>;

/** The wire shape, from a college document. */
function toPayload(college: {
  ownerRole?: string | null;
  themePaletteId?: string | null;
  themeFontId?: string | null;
  onboardingCompletedAt?: Date | null;
}): OnboardingPayload {
  const completedAt = college.onboardingCompletedAt ?? null;
  return {
    completed: Boolean(completedAt),
    role: college.ownerRole ?? null,
    themePaletteId: college.themePaletteId ?? null,
    themeFontId: college.themeFontId ?? null,
    completedAt: completedAt ? completedAt.toISOString() : null,
  };
}

/** Exported for the `/me` route, which answers the same question inline. */
export function onboardingPayloadFor(college: Parameters<typeof toPayload>[0]): OnboardingPayload {
  return toPayload(college);
}

export async function getOnboarding(collegeId: string): Promise<OnboardingPayload> {
  const college = await College.findById(collegeId).select(
    "ownerRole themePaletteId themeFontId onboardingCompletedAt",
  );
  if (!college) throw new NotFound("College not found");
  return toPayload(college);
}

/**
 * Records all three answers, or none of them.
 *
 * Idempotent on purpose. Somebody who reopens the wizard from their account
 * screen to change a theme should be able to submit it again, and a double-click
 * on the final step must not be a different outcome from a single one — so this
 * overwrites rather than refusing a college that is already onboarded.
 *
 * `onboardingCompletedAt` is only stamped the first time. Re-running the wizard
 * changes the answers; it does not restart the clock on when this tenant was
 * set up, which is the thing that timestamp is asked about.
 */
export async function completeOnboarding(
  collegeId: string,
  input: unknown,
): Promise<OnboardingPayload> {
  const parsed = onboardingSchema.safeParse(input);
  if (!parsed.success) {
    throw new AuthError(parsed.error.issues[0]?.message || "Invalid onboarding details", 400);
  }

  const { role, themePaletteId, themeFontId } = parsed.data;

  const existing = await College.findById(collegeId).select("onboardingCompletedAt");
  if (!existing) throw new NotFound("College not found");

  const college = await College.findByIdAndUpdate(
    collegeId,
    {
      $set: {
        ownerRole: role,
        themePaletteId,
        themeFontId,
        onboardingCompletedAt: existing.onboardingCompletedAt ?? new Date(),
      },
    },
    { new: true },
  ).select("ownerRole themePaletteId themeFontId onboardingCompletedAt");

  if (!college) throw new NotFound("College not found");
  return toPayload(college);
}
