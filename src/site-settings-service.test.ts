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
  it("removes a script element and its contents", () => {
    assert.equal(stripExecutable('<script>alert(1)</script>'), "");
    assert.equal(
      stripExecutable('<meta name="a"><script>steal()</script><meta name="b">'),
      '<meta name="a"><meta name="b">',
    );
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
    assert.equal(stripExecutable('<img src="x" onerror="steal()">'), '<img src="x">');
    assert.equal(stripExecutable("<div onclick='go()'>hi</div>"), "<div>hi</div>");
    assert.equal(stripExecutable('<body onload=go()>'), "<body>");
  });

  it("removes javascript: and data: URLs", () => {
    assert.equal(stripExecutable('<a href="javascript:alert(1)">x</a>'), "<a>x</a>");
    assert.equal(stripExecutable('<img src="data:text/html;base64,PHNjcmlwdD4=">'), "<img>");
  });

  // The point of stripping rather than escaping: the tenant asked for markup,
  // and the harmless majority of it should still work.
  it("keeps markup that cannot execute", () => {
    const meta = '<meta name="google-site-verification" content="abc123">';
    assert.equal(stripExecutable(meta), meta);

    const styles = '<link rel="stylesheet" href="https://fonts.example/f.css">';
    assert.equal(stripExecutable(styles), styles);

    assert.equal(stripExecutable("<style>.a{color:red}</style>"), "<style>.a{color:red}</style>");
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
