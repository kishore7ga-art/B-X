/**
 * The four editor themes, and the font packs, by id.
 *
 * The backend needs the ids only — to reject a theme that no renderer answers
 * to, so a college cannot end up storing `themePaletteId: "cyber-neon"` after
 * the frontend has stopped shipping it and then render as nothing.
 *
 * The colours live in `xite-F/src/lib/editor-themes.ts`, which is the only
 * place that renders them. Duplicating the palettes here would create a second
 * source of truth for values only one side uses; duplicating the ids creates a
 * list of nineteen characters that a test keeps honest.
 */

export const EDITOR_THEME_IDS = [
  "academic-blue",
  "emerald-gold",
  "crimson-slate",
  "midnight-purple",
  "black-and-white",
  "white-and-black",
  "custom",
] as const;

export const EDITOR_FONT_IDS = [
  "inter",
  "outfit",
  "serif",
] as const;

export const DEFAULT_THEME_ID = "academic-blue";
export const DEFAULT_FONT_ID = "inter";
