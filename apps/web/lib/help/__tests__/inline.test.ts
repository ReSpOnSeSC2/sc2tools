import { describe, expect, it } from "vitest";
import {
  helpArticleSlugFromHref,
  helpHrefKind,
  helpInlineLinks,
  helpInlinePlainText,
  parseHelpInline,
} from "../inline";

describe("parseHelpInline", () => {
  it("parses bold, italic, code and links", () => {
    expect(parseHelpInline("Press **Save**, then *wait* for `!rank` in [Devices](/devices).")).toEqual([
      { kind: "text", text: "Press " },
      { kind: "strong", children: [{ kind: "text", text: "Save" }] },
      { kind: "text", text: ", then " },
      { kind: "em", children: [{ kind: "text", text: "wait" }] },
      { kind: "text", text: " for " },
      { kind: "code", text: "!rank" },
      { kind: "text", text: " in " },
      { kind: "link", href: "/devices", hrefKind: "internal", children: [{ kind: "text", text: "Devices" }] },
      { kind: "text", text: "." },
    ]);
  });

  it("allows emphasis and code inside a link label, but no nested links", () => {
    expect(parseHelpInline("[**Open** `x`](/a)")).toEqual([
      {
        kind: "link",
        href: "/a",
        hrefKind: "internal",
        children: [
          { kind: "strong", children: [{ kind: "text", text: "Open" }] },
          { kind: "text", text: " " },
          { kind: "code", text: "x" },
        ],
      },
    ]);
  });

  it("leaves unsafe or unknown link targets as literal text", () => {
    for (const href of ["javascript:alert(1)", "//evil.example", "http://plain.example", "data:text/html,x", "#anchor"]) {
      expect(parseHelpInline(`[go](${href})`)).toEqual([{ kind: "text", text: `[go](${href})` }]);
    }
  });

  it("treats a backslash-escaped marker as a literal character", () => {
    expect(helpInlinePlainText("2 \\* 3 and \\`x\\`")).toBe("2 * 3 and `x`");
    expect(parseHelpInline("\\*\\*not bold\\*\\*")).toEqual([{ kind: "text", text: "**not bold**" }]);
  });

  it("keeps unmatched markers and plain punctuation as text", () => {
    expect(helpInlinePlainText("5 * 3 = 15, a ** b")).toBe("5 * 3 = 15, a ** b");
    expect(helpInlinePlainText("Ctrl+Enter confirms")).toBe("Ctrl+Enter confirms");
  });
});

describe("helpHrefKind", () => {
  it("classifies site paths, https and mailto", () => {
    expect(helpHrefKind("/settings?tab=help#build-check-in")).toBe("internal");
    expect(helpHrefKind("/")).toBe("internal");
    expect(helpHrefKind("https://www.youtube.com/@ReSpOnSeSC2")).toBe("external");
    expect(helpHrefKind("mailto:someone@example.com")).toBe("email");
    expect(helpHrefKind("//host/path")).toBeNull();
    expect(helpHrefKind("/\\host")).toBeNull();
    expect(helpHrefKind("ftp://x")).toBeNull();
  });
});

describe("helpers", () => {
  it("strips markup to the visible text", () => {
    expect(helpInlinePlainText("Press **Save** in [Settings → Overlay](/settings?tab=overlay)")).toBe(
      "Press Save in Settings → Overlay",
    );
  });

  it("lists every link target", () => {
    expect(helpInlineLinks("See [A](/a), **[B](/help/b)** and [mail](mailto:x@y.z)")).toEqual([
      "/a",
      "/help/b",
      "mailto:x@y.z",
    ]);
  });

  it("recognises help article paths", () => {
    expect(helpArticleSlugFromHref("/help/getting-started")).toBe("getting-started");
    expect(helpArticleSlugFromHref("/help")).toBeNull();
    expect(helpArticleSlugFromHref("/help/x/y")).toBeNull();
  });
});
