import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MiniMarkdown, safeMarkdownHref } from "../MiniMarkdown";
afterEach(cleanup);
describe("release note Markdown subset", () => {
  it("renders readable headings, bullets, emphasis and code without executing HTML or images", () => {
    const { container } = render(<MiniMarkdown text={'## Fixes\n\n- **Retry** is clearer\n- Use `Settings`\n\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n![tracking](https://evil.example/pixel)'} />);
    expect(screen.getByText("Fixes")).toBeTruthy(); expect(container.querySelectorAll("li")).toHaveLength(2); expect(container.querySelector("strong")?.textContent).toBe("Retry");
    expect(container.querySelector("code")?.textContent).toBe("Settings"); expect(container.querySelector("script,img")).toBeNull(); expect(container.textContent).toContain("<script>alert(1)</script>");
  });
  it("allows safe same-site and HTTPS links but keeps executable/protocol-relative URLs as text", () => {
    render(<MiniMarkdown text="[Help](/help/notifications) [Release](https://github.com/example/release) [Unsafe](javascript:alert) [Other](//evil.example)" />);
    expect(screen.getByRole("link", { name: "Help" }).getAttribute("href")).toBe("/help/notifications"); expect(screen.getByRole("link", { name: "Release" }).getAttribute("rel")).toContain("noopener");
    expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull(); expect(screen.queryByRole("link", { name: "Other" })).toBeNull();
    for (const url of ["/\\evil", "/\n/evil", "data:text/html,test", "https://user:pass@evil.example"]) expect(safeMarkdownHref(url)).toBe(false);
  });
});
