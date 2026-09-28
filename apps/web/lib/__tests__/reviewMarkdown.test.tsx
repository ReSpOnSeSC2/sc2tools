import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewMarkdown, parseBlocks, safeHttpUrl } from "../reviewMarkdown";

afterEach(() => cleanup());

describe("review markdown sanitizer", () => {
  it("never renders raw HTML — tags stay literal text", () => {
    const { container } = render(
      <ReviewMarkdown text={'<script>alert(1)</script> <img src=x onerror="alert(2)"> <b>bold?</b>'} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.textContent).toContain("<b>bold?</b>");
  });

  it("links only http(s) URLs, with nofollow ugc and a new tab", () => {
    const { container } = render(
      <ReviewMarkdown text={"See [this guide](https://liquipedia.net/starcraft2/Blink) and https://example.com/vod. Not [this](javascript:alert(1)) or [that](data:text/html,x)."} />,
    );
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://liquipedia.net/starcraft2/Blink",
      "https://example.com/vod",
    ]);
    for (const a of links) {
      expect(a.getAttribute("rel")).toBe("nofollow ugc noopener noreferrer");
      expect(a.getAttribute("target")).toBe("_blank");
    }
    expect(container.textContent).toContain("[this](javascript:alert(1))");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("  https://ok.example/path ")).toBe("https://ok.example/path");
  });

  it("supports the subset: emphasis, code, lists, quotes, line breaks", () => {
    const { container } = render(
      <ReviewMarkdown text={"**Scout** at *4:30* with `probe`\nsecond line\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted"} />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("Scout");
    expect(container.querySelector("em")).not.toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("probe");
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.querySelector("blockquote")?.textContent).toBe("quoted");
    expect(container.querySelector("br")).not.toBeNull();
    expect(parseBlocks("a\n\n\n\nb").map((b) => b.kind)).toEqual(["p", "p"]);
  });

  it("turns game-clock timestamps into seek chips inside the game only", () => {
    const onSeek = vi.fn();
    render(<ReviewMarkdown text={"Blink at 5:12, retreat by 1:02:03, ignore 99:59 and 3:1."} onSeek={onSeek} maxSeconds={640} />);
    fireEvent.click(screen.getByRole("button", { name: "Jump to 5:12" }));
    expect(onSeek).toHaveBeenCalledWith(312);
    // 1:02:03 = 3723 s is past a 640 s game; 99:59 too; 3:1 isn't a clock.
    expect(screen.queryByRole("button", { name: "Jump to 1:02:03" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Jump to 99:59" })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("never nests links or seek buttons inside a link label", () => {
    const { container } = render(
      <ReviewMarkdown text={"[see https://liquipedia.net/x at 5:12](https://liquipedia.net/x)"} onSeek={() => {}} maxSeconds={640} />,
    );
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0].querySelector("a, button")).toBeNull();
    expect(links[0].textContent).toBe("see https://liquipedia.net/x at 5:12");
  });
});
