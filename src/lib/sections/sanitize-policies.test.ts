import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sanitizeSectionHtml, sanitizeWebsiteConfig } from "@/lib/sections/sanitize-section-html";
import { sanitizeTemplateCode } from "@/library-service";

/**
 * Two sanitisers guard two different paths, and they disagree about `<script>`.
 *
 * That disagreement is deliberate and worth pinning down, because it decides
 * whether an interactive section works:
 *
 *   `sanitizeTemplateCode`  — admin-authored library templates. Allows
 *                             `<script>`, because the library genuinely
 *                             contains hamburger menus and carousels and
 *                             removing them would break live sites.
 *   `sanitizeSectionHtml`   — tenant-authored section markup arriving through
 *                             `PUT /api/v1/my-website`. Discards `<script>`,
 *                             because a tenant's markup renders on the platform
 *                             apex alongside the sign-in page.
 *
 * The consequence is the thing to keep in view: a template's script survives in
 * the library and does **not** survive being saved into a tenant's page. These
 * tests state that, so nobody "fixes" one side into agreeing with the other
 * without deciding which policy they meant.
 */

const CAROUSEL = `<section class="c">
  <button class="nav-toggle">Menu</button>
  <script>document.querySelector(".nav-toggle").addEventListener("click", () => {});</script>
</section>`;

const HOSTILE = `<section onclick="steal()"><img src=x onerror="steal()"><a href="javascript:steal()">x</a><p>safe</p></section>`;

describe("sanitizeTemplateCode — the admin's library", () => {
  it("keeps a section's own script, which interactive sections depend on", () => {
    assert.match(sanitizeTemplateCode(CAROUSEL), /<script/i);
  });

  it("still strips the things that are never legitimate", () => {
    const out = sanitizeTemplateCode(HOSTILE);
    assert.ok(!/onclick/i.test(out), out);
    assert.ok(!/onerror/i.test(out), out);
    assert.ok(!/javascript:/i.test(out), out);
    assert.ok(out.includes("safe"), out);
  });

  it("preserves <style> blocks, which sanitize-html would otherwise empty", () => {
    const withCss = `<style>.c { color: #2563eb }</style><section class="c">x</section>`;
    const out = sanitizeTemplateCode(withCss);
    assert.ok(out.includes("color: #2563eb"), out);
  });
});

describe("sanitizeSectionHtml — what a tenant may store", () => {
  it("discards <script> entirely, tag and contents", () => {
    const out = sanitizeSectionHtml(CAROUSEL);
    assert.ok(!/<script/i.test(out), out);
    assert.ok(!out.includes("addEventListener"), out);
  });

  it("keeps the markup around it", () => {
    const out = sanitizeSectionHtml(CAROUSEL);
    assert.ok(out.includes("nav-toggle"), out);
  });

  it("strips event handlers and javascript: URLs", () => {
    const out = sanitizeSectionHtml(HOSTILE);
    assert.ok(!/onclick|onerror|javascript:/i.test(out), out);
    assert.ok(out.includes("safe"), out);
  });
});

describe("the boundary between them", () => {
  it("a template's script does not survive being saved into a tenant page", () => {
    // Stated as a fact rather than asserted as desirable. If this ever needs to
    // change, it is a policy decision about what may run on the platform apex,
    // not a sanitiser bug.
    const inLibrary = sanitizeTemplateCode(CAROUSEL);
    const onceSaved = sanitizeSectionHtml(inLibrary);

    assert.match(inLibrary, /<script/i);
    assert.ok(!/<script/i.test(onceSaved), onceSaved);
  });

  it("both are idempotent, so repeated saves do not erode a section", () => {
    assert.equal(sanitizeSectionHtml(sanitizeSectionHtml(HOSTILE)), sanitizeSectionHtml(HOSTILE));
    assert.equal(sanitizeTemplateCode(sanitizeTemplateCode(CAROUSEL)), sanitizeTemplateCode(CAROUSEL));
  });

  it("neither throws on junk", () => {
    for (const input of ["", "   ", "<<<>>>", "<section", null, undefined]) {
      assert.doesNotThrow(() => sanitizeSectionHtml(input as never));
      assert.doesNotThrow(() => sanitizeTemplateCode((input ?? "") as string));
    }
  });
});

describe("which policy a website config is judged by", () => {
  const config = { pages: [{ slug: "/home", sections: [{ id: "s1", code: CAROUSEL }] }] };
  const codeOf = (c: typeof config) => c.pages[0]!.sections[0]!.code;

  it("a tenant's config is judged by the tenant policy, script discarded", () => {
    assert.ok(!/<script/i.test(codeOf(sanitizeWebsiteConfig(config))));
  });

  it("the platform default website keeps the admin's script", () => {
    // The reported bug: the admin publishes an interactive section, it works in
    // Admin, and it arrives in every tenant's editor with the script gone and
    // its content never assembled — a dropdown painting as a solid block, an
    // accordion showing every panel at once. The default website is authored by
    // a Super Admin through an admin-only route, so it is admin content and the
    // admin policy is the one that applies to it.
    assert.match(codeOf(sanitizeWebsiteConfig(config, sanitizeTemplateCode)), /<script/i);
  });

  it("the admin policy still strips hostile markup — it is not a bypass", () => {
    const hostile = { pages: [{ slug: "/home", sections: [{ id: "s1", code: HOSTILE }] }] };
    const out = codeOf(sanitizeWebsiteConfig(hostile, sanitizeTemplateCode));
    assert.ok(!/onclick|onerror|javascript:/i.test(out), out);
    assert.ok(out.includes("safe"), out);
  });
});
