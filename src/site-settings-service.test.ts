import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_CUSTOM_CODE_BYTES,
  mayExecuteCustomCode,
  stripExecutable,
  __testing,
} from "@/site-settings-service";

const { withDefaults, clampString, clampCode } = __testing;

describe("mayExecuteCustomCode — script only on a tenant's own domain", () => {
  it("is false with no domains at all", () => {
    assert.equal(mayExecuteCustomCode({ domains: [] }), false);
    assert.equal(mayExecuteCustomCode({ domains: null }), false);
    assert.equal(mayExecuteCustomCode({}), false);
  });

  // Adding a domain must not be enough. Until it is ACTIVE the tenant is still
  // being served on a hostname inside the platform's cookie scope.
  it("is false while a domain is only pending or verified", () => {
    assert.equal(mayExecuteCustomCode({ domains: [{ status: "PENDING_VERIFICATION" }] }), false);
    assert.equal(mayExecuteCustomCode({ domains: [{ status: "VERIFIED" }] }), false);
    assert.equal(mayExecuteCustomCode({ domains: [{ status: "FAILED" }] }), false);
  });

  it("is true once a domain is active", () => {
    assert.equal(mayExecuteCustomCode({ domains: [{ status: "ACTIVE" }] }), true);
    assert.equal(
      mayExecuteCustomCode({ domains: [{ status: "PENDING_VERIFICATION" }, { status: "ACTIVE" }] }),
      true,
    );
  });
});

/**
 * These are the cases that decide whether a tenant's markup can attack the
 * platform's own cookie scope, so they are enumerated rather than sampled.
 */
describe("stripExecutable — what a platform subdomain is allowed to render", () => {
  /**
   * These assert behaviour rather than bytes.
   *
   * They used to compare the output string exactly, which worked while this was
   * five regexes over the input and every surviving byte came through
   * untouched. It is `sanitize-html` now — a parser — so void elements come back
   * self-closing (`<meta />`) and `style` attributes come back with their CSS
   * reserialised. The markup is equivalent; the bytes are not, and pinning the
   * bytes would pin the implementation rather than the security property.
   *
   * What each case actually needs to prove is "the executable part is gone and
   * the inert part is still there", so that is what is checked.
   */
  const hasNoScript = (html: string) => !/<script|onerror|onclick|onload|javascript:/i.test(html);

  it("removes a script element and its contents", () => {
    assert.equal(stripExecutable('<script>alert(1)</script>'), "");

    const out = stripExecutable('<meta name="a"><script>steal()</script><meta name="b">');
    assert.ok(hasNoScript(out), out);
    assert.ok(!/steal/.test(out), out);
    assert.match(out, /<meta name="a"/);
    assert.match(out, /<meta name="b"/);
  });

  it("removes a script with attributes", () => {
    assert.equal(stripExecutable('<script src="https://evil.example/x.js" async></script>'), "");
    assert.equal(stripExecutable('<SCRIPT TYPE="text/javascript">x()</SCRIPT>'), "");
  });

  // An unclosed tag would otherwise survive the regex and still execute once
  // the browser's parser closed it.
  it("removes an unclosed script", () => {
    assert.equal(stripExecutable('<script>alert(1)'), "");
  });

  it("removes embedding elements that can host another origin", () => {
    assert.equal(stripExecutable('<iframe src="https://evil.example"></iframe>'), "");
    assert.equal(stripExecutable('<object data="x"></object>'), "");
    assert.equal(stripExecutable('<embed src="x">'), "");
  });

  it("removes inline event handlers", () => {
    const img = stripExecutable('<img src="x" onerror="steal()">');
    assert.ok(hasNoScript(img), img);
    assert.match(img, /src="x"/);

    assert.equal(stripExecutable("<div onclick='go()'>hi</div>"), "<div>hi</div>");

    // `<body>` is not on the allowlist at all — head and body-end code has no
    // business carrying one — so it goes entirely rather than being emptied.
    assert.equal(stripExecutable('<body onload=go()>'), "");
  });

  /**
   * These two are the bypasses the regex version admitted. `/` is a valid
   * attribute separator, so `\son` never matched; and the scheme check ran
   * against raw bytes while the browser decodes entities first.
   */
  it("removes handlers that a whitespace-anchored regex misses", () => {
    const slash = stripExecutable('<img/onerror="steal()" src=x>');
    assert.ok(hasNoScript(slash), slash);

    const newline = stripExecutable('<img src=x\n  onerror\n  =\n  "steal()">');
    assert.ok(hasNoScript(newline), newline);
  });

  it("removes javascript: and data: URLs", () => {
    assert.equal(stripExecutable('<a href="javascript:alert(1)">x</a>'), "<a>x</a>");

    const entity = stripExecutable('<a href="&#106;avascript:alert(1)">x</a>');
    assert.equal(entity, "<a>x</a>");

    const dataImg = stripExecutable('<img src="data:text/html;base64,PHNjcmlwdD4=">');
    assert.ok(!/data:/i.test(dataImg), dataImg);
  });

  // The point of stripping rather than escaping: the tenant asked for markup,
  // and the harmless majority of it should still work.
  it("keeps markup that cannot execute", () => {
    const meta = stripExecutable('<meta name="google-site-verification" content="abc123">');
    assert.match(meta, /name="google-site-verification"/);
    assert.match(meta, /content="abc123"/);

    const styles = stripExecutable('<link rel="stylesheet" href="https://fonts.example/f.css">');
    assert.match(styles, /rel="stylesheet"/);
    assert.match(styles, /href="https:\/\/fonts\.example\/f\.css"/);

    /**
     * The CSS body specifically, because this is the case the parser would
     * otherwise silently eat: sanitize-html drops the text content of a `<style>`
     * element even when the tag is allowed, so the block is lifted out before
     * sanitisation and reattached after.
     */
    assert.equal(stripExecutable("<style>.a{color:red}</style>"), "<style>.a{color:red}</style>");
  });

  it("keeps a stylesheet but strips CSS that reaches outside CSS", () => {
    const out = stripExecutable("<style>.a{color:red;width:expression(alert(1))}</style>");
    assert.match(out, /color:red/);
    assert.ok(!/expression\s*\(/i.test(out), out);
  });

  it("handles empty input", () => {
    assert.equal(stripExecutable(null), "");
    assert.equal(stripExecutable(undefined), "");
    assert.equal(stripExecutable(""), "");
  });
});

describe("withDefaults", () => {
  it("supplies a complete object from nothing", () => {
    const settings = withDefaults(null);
    assert.equal(settings.seo.indexingEnabled, true);
    assert.equal(settings.maintenance.enabled, false);
    assert.equal(settings.customCode.headHtml, null);
  });

  // Indexing defaults to on, so an existing tenant is not silently
  // de-indexed by the arrival of a field they never set.
  it("preserves values that were set", () => {
    const settings = withDefaults({
      seo: { indexingEnabled: false, title: "T", description: null },
      maintenance: { enabled: true, message: "Back soon" },
      customCode: { headHtml: "<meta>", bodyEndHtml: null },
    } as never);
    assert.equal(settings.seo.indexingEnabled, false);
    assert.equal(settings.seo.title, "T");
    assert.equal(settings.maintenance.message, "Back soon");
    assert.equal(settings.customCode.headHtml, "<meta>");
  });
});

describe("validation", () => {
  it("clampString trims, nulls empties, and rejects over-length", () => {
    assert.equal(clampString("  hello  ", 10, "Field"), "hello");
    assert.equal(clampString("", 10, "Field"), null);
    assert.equal(clampString(null, 10, "Field"), null);
    assert.throws(() => clampString("x".repeat(11), 10, "Field"), /too long/);
    assert.throws(() => clampString(42, 10, "Field"), /must be text/);
  });

  it("clampCode measures bytes, not characters", () => {
    // Four-byte characters: 6000 of them is 24000 bytes, over the limit, while
    // being only 6000 characters. A character-based check would let it through.
    const emoji = "\u{1F600}".repeat(6000);
    assert.ok(emoji.length < MAX_CUSTOM_CODE_BYTES);
    assert.throws(() => clampCode(emoji, "Header code"), /too large/);
  });

  it("clampCode accepts code within the limit", () => {
    assert.equal(clampCode("<meta name=x>", "Header code"), "<meta name=x>");
    assert.equal(clampCode("   ", "Header code"), null);
  });
});
