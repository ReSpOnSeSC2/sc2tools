import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { HelpArticle } from "@/lib/help/types";

// A small registry with a renamed section, so the legacy-anchor path is
// exercised without depending on shipped content.
vi.mock("@/lib/help/articles/index.generated", () => {
  const base: Pick<HelpArticle, "category" | "audience" | "keywords" | "updated" | "related"> = {
    category: "builds",
    audience: "all",
    keywords: ["k"],
    updated: "2026-10-22",
    related: [],
  };
  const articles: HelpArticle[] = [
    {
      ...base,
      slug: "planned-builds",
      title: "Planned builds",
      summary: "Count the build you went for.",
      legacyAnchors: ["old-check-in"],
      body: [{ type: "paragraph", text: "See [Other topic](/help/other-topic) too." }],
    },
    {
      ...base,
      slug: "other-topic",
      title: "Other topic",
      summary: "Something else.",
      body: [{ type: "paragraph", text: "Other body." }],
    },
  ];
  return { ALL_HELP_ARTICLES: articles };
});
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));

import { HelpCenter } from "../HelpCenter";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

function withScroll(run: (scroll: ReturnType<typeof vi.fn>) => void) {
  const scrollIntoView = vi.fn();
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  try {
    run(scrollIntoView);
  } finally {
    HTMLElement.prototype.scrollIntoView = original;
  }
}

describe("HelpCenter", () => {
  it("opens the renamed section for an old anchor and rewrites the URL to its slug", () => {
    window.history.replaceState(null, "", "/settings?tab=help#old-check-in");
    withScroll((scroll) => {
      render(<HelpCenter />);
      expect((document.getElementById("planned-builds") as HTMLDetailsElement).open).toBe(true);
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(window.location.hash).toBe("#planned-builds");
      expect(window.location.search).toBe("?tab=help");
    });
  });

  it("ignores an anchor that names no article", () => {
    window.history.replaceState(null, "", "/settings?tab=help#nothing-here");
    withScroll((scroll) => {
      render(<HelpCenter />);
      expect(scroll).not.toHaveBeenCalled();
      expect(window.location.hash).toBe("#nothing-here");
    });
  });

  it("groups sections under their topic and keeps links between articles in Settings", () => {
    withScroll(() => {
      render(<HelpCenter />);
      expect(screen.getByRole("heading", { level: 3, name: "Builds" })).toBeTruthy();
      const link = screen.getByRole("link", { name: "Other topic" });
      expect(link.getAttribute("href")).toBe("/settings?tab=help#other-topic");
    });
  });
});
