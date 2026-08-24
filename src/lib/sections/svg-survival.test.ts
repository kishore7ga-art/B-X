import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sanitizeTemplateCode } from "@/library-service";
import { sanitizeSectionHtml } from "@/lib/sections/sanitize-section-html";

/**
 * A university crest and a social icon row, shaped like the real ones.
 *
 * Logos in this library are inline SVG — a shield built from `<defs>` and a
 * `<clipPath>`, lettering positioned with `transform`, a gradient fill, and a
 * circle for the seal. Social icons are single `<path>`s with `fill-rule`.
 *
 * Every one of those depends on an attribute or an element that an allowlist
 * has to name explicitly. A list that keeps `<svg>` and `<path>` but drops
 * `fill-rule`, `transform` and `<defs>` does not fail loudly: it renders the
 * logo as broken line-art, which is exactly what a mis-rendered crest looks
 * like beside a correct one.
 */
const CREST = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" preserveAspectRatio="xMidYMid meet" role="img" aria-label="JECRC">
  <defs>
    <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">
      <stop offset="0" stop-color="#9c1c2e" stop-opacity="1"></stop>
      <stop offset="1" stop-color="#6d1220"></stop>
    </linearGradient>
    <clipPath id="shield"><path d="M32 2 L60 12 V34 C60 48 46 58 32 62 C18 58 4 48 4 34 V12 Z"></path></clipPath>
  </defs>
  <g clip-path="url(#shield)" transform="translate(0,0)">
    <rect x="0" y="0" width="64" height="64" fill="url(#g1)"></rect>
    <circle cx="32" cy="26" r="10" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"></circle>
    <ellipse cx="32" cy="44" rx="14" ry="5" fill="#ffffff" fill-opacity="0.9"></ellipse>
    <path d="M20 30 L32 20 L44 30" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"></path>
    <text x="32" y="52" text-anchor="middle" font-size="8" fill="#ffffff">JECRC</text>
  </g>
</svg>`;

const SOCIAL_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"></path>
</svg>`;

/**
 * Every attribute the crest above actually uses.
 *
 * `fill-rule` and `clip-rule` are deliberately not here — they belong to the
 * social icon, and asserting them against the crest tests nothing but the test.
 */
const NEEDED_ATTRS = [
  "preserveAspectRatio",
  "gradientUnits",
  "stop-color",
  "stop-opacity",
  "clip-path",
  "transform",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "fill-opacity",
  "text-anchor",
  "font-size",
  "cx",
  "cy",
  "rx",
  "ry",
  'x="0"',
  'y="0"',
  "offset",
];

const NEEDED_TAGS = ["<defs", "<linearGradient", "<stop", "<clipPath", "<ellipse", "<text"];

describe("sanitizeTemplateCode — an inline SVG logo has to survive intact", () => {
  const out = sanitizeTemplateCode(CREST);

  for (const attr of NEEDED_ATTRS) {
    it(`keeps ${attr}`, () => {
      // Case-insensitive: the parser lower-cases attribute names, and the
      // browser's SVG attribute-adjustment step maps them back on parse.
      assert.ok(
        out.toLowerCase().includes(attr.toLowerCase()),
        `dropped — logo renders wrong.\n${out.slice(0, 500)}`,
      );
    });
  }

  for (const tag of NEEDED_TAGS) {
    it(`keeps ${tag}>`, () => {
      assert.ok(
        out.toLowerCase().includes(tag.toLowerCase()),
        `dropped — logo renders wrong.\n${out.slice(0, 500)}`,
      );
    });
  }

  it("keeps the gradient reference that fills the shield", () => {
    assert.ok(out.includes("url(#g1)"), out.slice(0, 400));
  });
});

describe("sanitizeTemplateCode — a social icon has to survive intact", () => {
  it("keeps fill-rule and clip-rule, without which the glyph inverts", () => {
    const out = sanitizeTemplateCode(SOCIAL_ICON);
    assert.ok(out.includes("fill-rule"), out);
    assert.ok(out.includes("clip-rule"), out);
  });

  it("keeps fill=\"currentColor\", without which the icon is black on red", () => {
    assert.ok(sanitizeTemplateCode(SOCIAL_ICON).includes("currentColor"));
  });
});

describe("sanitizeSectionHtml — the same SVG, once a tenant has saved it", () => {
  it("keeps the crest intact through the tenant path too", () => {
    const out = sanitizeSectionHtml(CREST);
    for (const tag of NEEDED_TAGS) {
      assert.ok(
        out.toLowerCase().includes(tag.toLowerCase()),
        `${tag}> dropped on the tenant path.\n${out.slice(0, 500)}`,
      );
    }
  });

  it("keeps the social icon intact", () => {
    const out = sanitizeSectionHtml(SOCIAL_ICON);
    assert.ok(out.includes("fill-rule"), out);
    assert.ok(out.includes("currentColor"), out);
  });
});

describe("what must still not survive, in either policy", () => {
  const HOSTILE = `<svg xmlns="http://www.w3.org/2000/svg" onload="steal()"><a href="javascript:steal()"><path d="M0 0" onclick="steal()"></path></a><foreignObject><body><img src=x onerror="steal()"></body></foreignObject></svg>`;

  for (const [name, run] of [
    ["template policy", sanitizeTemplateCode],
    ["tenant policy", sanitizeSectionHtml],
  ] as const) {
    it(`${name} strips handlers, javascript: and foreignObject`, () => {
      const out = run(HOSTILE);
      assert.ok(!/onload|onclick|onerror/i.test(out), out);
      assert.ok(!/javascript:/i.test(out), out);
      assert.ok(!/foreignObject/i.test(out), out);
    });
  }
});
