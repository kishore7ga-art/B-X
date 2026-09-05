import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatAlternatingWords,
  applyAlternatingSectionTextColors,
} from "./text-highlight";

describe("formatAlternatingWords", () => {
  it("alternates word colors across words with Color 1 -> Color 2 -> Color 1 -> Color 2", () => {
    const input = "Empowering Minds, Shaping Tomorrow's Leaders";
    const colors: [string, string] = ["#0f172a", "#2563eb"];
    const out = formatAlternatingWords(input, colors);

    assert.ok(out.includes('<span style="color: #0f172a;">Empowering</span>'));
    assert.ok(out.includes('<span style="color: #2563eb;">Minds,</span>'));
    assert.ok(out.includes('<span style="color: #0f172a;">Shaping</span>'));
    assert.ok(out.includes('<span style="color: #2563eb;">Tomorrow\'s</span>'));
    assert.ok(out.includes('<span style="color: #0f172a;">Leaders</span>'));
  });

  it("preserves HTML tags such as <br /> and existing spans while alternating text words", () => {
    const input = 'India\'s<br />First AI-Native<br />B.Tech in CSE <span class="ampersand">&amp;</span> AI';
    const colors: [string, string] = ["#ffffff", "#38bdf8"];
    const out = formatAlternatingWords(input, colors);

    assert.ok(out.includes('<span style="color: #ffffff;">India\'s</span><br />'));
    assert.ok(out.includes('<span style="color: #38bdf8;">First</span>'));
    assert.ok(out.includes('<span style="color: #ffffff;">AI-Native</span><br />'));
    assert.ok(out.includes('<span style="color: #38bdf8;">B.Tech</span>'));
    assert.ok(out.includes('<span style="color: #ffffff;">in</span>'));
    assert.ok(out.includes('<span style="color: #38bdf8;">CSE</span>'));
    assert.ok(out.includes('<span class="ampersand"><span style="color: #ffffff;">&amp;</span></span>') || out.includes('&amp;</span>'));
    assert.ok(out.includes('<span style="color: #38bdf8;">AI</span>'));
  });
});

describe("applyAlternatingSectionTextColors", () => {
  it("gives H1 its own distinct colors and P its complementary colors in a section", () => {
    const section = `<section><h1>Empowering Minds</h1><p>Join our community</p></section>`;
    const out = applyAlternatingSectionTextColors(section, {
      h1Colors: ["#0f172a", "#2563eb"],
      pColors: ["#475569", "#0284c7"],
    });

    assert.ok(out.includes('<h1><span style="color: #0f172a;">Empowering</span> <span style="color: #2563eb;">Minds</span></h1>'));
    assert.ok(out.includes('<p><span style="color: #475569;">Join</span> <span style="color: #0284c7;">our</span> <span style="color: #475569;">community</span></p>'));
  });
});
