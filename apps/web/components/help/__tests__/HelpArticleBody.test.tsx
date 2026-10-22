import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/Toast";
import type { HelpArticle } from "@/lib/help/types";
import { HelpArticleBody } from "../HelpArticleBody";

afterEach(cleanup);

const ARTICLE: HelpArticle = {
  slug: "fixture",
  title: "Fixture",
  summary: "Every block type.",
  category: "troubleshooting",
  audience: "all",
  keywords: ["fixture"],
  updated: "2026-10-22",
  related: [],
  body: [
    { type: "paragraph", text: "Open [Devices](/devices), read [Getting started](/help/getting-started) or [the channel](https://www.youtube.com/@ReSpOnSeSC2). [bad](javascript:alert(1))" },
    { type: "heading", text: "A sub-heading" },
    { type: "steps", items: ["**First.** Do this.", "Then `that`."] },
    { type: "list", items: ["One *item*"] },
    { type: "callout", tone: "warning", title: "Careful", text: "Mind the gap." },
    { type: "settingsLink", label: "Open Settings → Overlay", href: "/settings?tab=overlay" },
    { type: "image", src: "/logo.png", alt: "The logo", caption: "Our *logo*" },
    { type: "table", head: ["Command", "Does"], rows: [["`!rank`", "Your rank"]] },
    { type: "widget", widget: "chat-commands" },
  ],
};

function renderBody(props: Partial<Parameters<typeof HelpArticleBody>[0]> = {}) {
  return render(
    <ToastProvider>
      <HelpArticleBody article={ARTICLE} {...props} />
    </ToastProvider>,
  );
}

describe("HelpArticleBody", () => {
  it("renders every block type with the right semantics", () => {
    renderBody();
    expect(screen.getByRole("heading", { level: 2, name: "A sub-heading" })).toBeTruthy();
    const steps = screen.getAllByRole("list")[0];
    expect(steps.tagName).toBe("OL");
    expect(within(steps).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("First.").tagName).toBe("STRONG");
    expect(screen.getByText("that").tagName).toBe("CODE");
    expect(screen.getByText("item").tagName).toBe("EM");
    const note = screen.getByRole("note");
    expect(note.textContent).toContain("Careful");
    expect(note.textContent).toContain("Mind the gap.");
    expect(screen.getByRole("link", { name: "Open Settings → Overlay" }).getAttribute("href")).toBe(
      "/settings?tab=overlay",
    );
    expect(screen.getByRole("img", { name: "The logo" }).getAttribute("loading")).toBe("lazy");
    expect(screen.getByRole("columnheader", { name: "Command" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Table: Command, Does" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy for your bio/ })).toBeTruthy();
  });

  it("renders safe links and leaves unsafe ones as text", () => {
    renderBody();
    expect(screen.getByRole("link", { name: "Devices" }).getAttribute("href")).toBe("/devices");
    expect(screen.getByRole("link", { name: "Getting started" }).getAttribute("href")).toBe("/help/getting-started");
    const external = screen.getByRole("link", { name: /the channel/ });
    expect(external.getAttribute("target")).toBe("_blank");
    expect(external.getAttribute("rel")).toBe("noopener noreferrer");
    expect(external.textContent).toContain("(opens in a new tab)");
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(document.body.textContent).toContain("[bad](javascript:alert(1))");
  });

  it("uses h3 headings when compact and routes article links through the host", () => {
    const onOpenArticle = vi.fn();
    renderBody({
      variant: "compact",
      links: { articleHref: (slug) => `/settings?tab=help#${slug}`, onOpenArticle },
    });
    expect(screen.getByRole("heading", { level: 3, name: "A sub-heading" })).toBeTruthy();
    const link = screen.getByRole("link", { name: "Getting started" });
    expect(link.getAttribute("href")).toBe("/settings?tab=help#getting-started");
    fireEvent.click(link);
    expect(onOpenArticle).toHaveBeenCalledWith("getting-started");
  });
});
