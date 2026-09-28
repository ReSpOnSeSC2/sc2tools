import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GUIDE_MARKDOWN_MAX_CHARS,
  GuideMarkdown,
  parseGuideMarkdown,
  renderGuideMarkdown,
  safeGuideHref,
} from "@/lib/guides/markdown";
import { renderInline, safeHttpUrl } from "@/lib/reviewMarkdown";
import { FIXTURE_BUILD_PUBLISHED } from "@/lib/guides/__fixtures__";

afterEach(() => {
  cleanup();
});

function renderNotes(source: string) {
  return render(<GuideMarkdown source={source} />).container;
}

describe("parseGuideMarkdown", () => {
  test("paragraphs, headings and lists", () => {
    expect(
      parseGuideMarkdown("### Plan\nScout early\nand wall.\n\n- Chrono Zealot\n- Pre-build Pylons\nAfter"),
    ).toEqual([
      { kind: "heading", text: "Plan" },
      { kind: "paragraph", text: "Scout early and wall." },
      { kind: "list", items: ["Chrono Zealot", "Pre-build Pylons"] },
      { kind: "paragraph", text: "After" },
    ]);
  });

  test("# and ## also become (h3) headings; #### and #tags stay text", () => {
    expect(parseGuideMarkdown("# One\n## Two\n#### Four\n#PvZ")).toEqual([
      { kind: "heading", text: "One" },
      { kind: "heading", text: "Two" },
      { kind: "paragraph", text: "#### Four #PvZ" },
    ]);
  });

  test("CRLF input and oversized input are bounded", () => {
    expect(parseGuideMarkdown("a\r\nb\r\n\r\nc")).toEqual([
      { kind: "paragraph", text: "a b" },
      { kind: "paragraph", text: "c" },
    ]);
    const huge = "x".repeat(GUIDE_MARKDOWN_MAX_CHARS + 500);
    const [block] = parseGuideMarkdown(huge);
    expect(block.kind === "paragraph" && block.text.length).toBe(GUIDE_MARKDOWN_MAX_CHARS);
    expect(parseGuideMarkdown("")).toEqual([]);
  });
});

describe("GuideMarkdown rendering", () => {
  test("inline bold, italic, code and safe links", () => {
    const container = renderNotes(
      "Lead with **Void Ray**, hide *Twilight*, research `Glaives`. See [Liquipedia](https://liquipedia.net/starcraft2/Adept).",
    );
    expect(container.querySelector("strong")?.textContent).toBe("Void Ray");
    expect(container.querySelector("em")?.textContent).toBe("Twilight");
    expect(container.querySelector("code")?.textContent).toBe("Glaives");
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://liquipedia.net/starcraft2/Adept");
    expect(link?.getAttribute("rel")).toBe("nofollow ugc noopener noreferrer");
    expect(link?.textContent).toBe("Liquipedia");
  });

  test("emphasis inside link text; game clocks stay plain text", () => {
    const container = renderNotes("[**docs**](https://example.com/a) and _hold_ until 4:30");
    expect(container.querySelector("a strong")?.textContent).toBe("docs");
    expect(container.querySelector("em")?.textContent).toBe("hold");
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("until 4:30");
  });

  test("inline rendering is the review renderer's, so the two can never drift", () => {
    const source = "Lead with **Void Ray**, see https://liquipedia.net/starcraft2/Adept. `Glaives` [x](https:evil.example)";
    const notes = renderToStaticMarkup(<GuideMarkdown source={source} />);
    const review = renderToStaticMarkup(<>{renderInline(source, {}, "b0")}</>);
    expect(notes).toContain(review);
    // Bare URLs link (sentence punctuation trimmed); a scheme without "//" never does.
    const links = renderNotes(source).querySelectorAll("a");
    expect([...links].map((a) => a.getAttribute("href"))).toEqual(["https://liquipedia.net/starcraft2/Adept"]);
  });

  test("renders the fixture coach's notes as h3 + list", () => {
    const container = renderNotes(FIXTURE_BUILD_PUBLISHED.notes!.body);
    expect(container.querySelector("h3")?.textContent).toBe("Game plan");
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  test("an unmatched ** stays literal", () => {
    const container = renderNotes("Hold the ramp and **");
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toBe("Hold the ramp and **");
  });

  test("empty source renders nothing", () => {
    expect(renderToStaticMarkup(<GuideMarkdown source={"  \n\n "} />)).toBe("");
    expect(renderGuideMarkdown("")).toEqual([]);
  });
});

describe("XSS attempts render as inert text", () => {
  test("<script> and raw HTML are text, never elements", () => {
    const source = '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)"> <b>bold</b>';
    const container = renderNotes(source);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.textContent).toContain('onerror="alert(1)"');
    const html = renderToStaticMarkup(<GuideMarkdown source={source} />);
    expect(html).not.toMatch(/<(script|img|b)\b/i);
    expect(html).not.toMatch(/<[^>]*\sonerror\s*=/i);
    expect(html).toContain("&lt;script&gt;");
  });

  test.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox",
    "/relative/path",
    "//evil.example/x",
    "mailto:someone@example.com",
  ])("unsafe link target %s renders as source text", (href) => {
    const container = renderNotes(`[click me](${href})`);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe(`[click me](${href})`);
  });

  test("attribute-breaking payloads inside a safe URL stay inside href", () => {
    const source = '[x](https://example.com/"onmouseover="alert)';
    const html = renderToStaticMarkup(<GuideMarkdown source={source} />);
    expect(html).not.toMatch(/<[^>]*\sonmouseover\s*=/i);
    const link = renderNotes(source).querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/%22onmouseover=%22alert");
    expect(link?.getAttribute("onmouseover")).toBeNull();
  });

  test("HTML entities are shown literally, not decoded", () => {
    const container = renderNotes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#60;b&#62;");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toBe("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#60;b&#62;");
  });

  test("code spans never render markup", () => {
    const container = renderNotes("`<svg onload=alert(1)>`");
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("<svg onload=alert(1)>");
  });
});

describe("safeGuideHref", () => {
  test("keeps http(s) and normalises", () => {
    expect(safeGuideHref("https://liquipedia.net/starcraft2")).toBe(
      "https://liquipedia.net/starcraft2",
    );
    expect(safeGuideHref("HTTP://Example.com")).toBe("http://example.com/");
  });

  test("rejects everything else", () => {
    for (const raw of ["javascript:alert(1)", " javascript:alert(1)", "ftp://x.y", "nope", "", "https:evil.example"]) {
      expect(safeGuideHref(raw)).toBeNull();
    }
  });

  test("is the review renderer's URL rule", () => {
    for (const raw of ["https://liquipedia.net/a", "HTTP://Example.com", "https:evil.example", "data:x"]) {
      expect(safeGuideHref(raw)).toBe(safeHttpUrl(raw));
    }
  });
});
