import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));

afterEach(cleanup);

/** A fresh module each test, so HelpLink has not loaded yet. */
let LazyHelpLink: typeof import("../LazyHelpLink").LazyHelpLink;
beforeEach(async () => {
  vi.resetModules();
  ({ LazyHelpLink } = await import("../LazyHelpLink"));
});

const LOADED = { timeout: 10_000 };

describe("LazyHelpLink", () => {
  it("shows a plain link to the article until HelpLink loads, then opens the side sheet", async () => {
    render(<LazyHelpLink slug="stream-dock">Dock help</LazyHelpLink>);
    const fallback = screen.getByRole("link", { name: "Dock help" });
    expect(fallback.getAttribute("href")).toBe("/help/stream-dock");
    expect(fallback.getAttribute("aria-haspopup")).toBeNull();

    await vi.waitFor(
      () => expect(screen.getByRole("link", { name: "Dock help" }).getAttribute("aria-haspopup")).toBe("dialog"),
      LOADED,
    );
    fireEvent.click(screen.getByRole("link", { name: "Dock help" }));
    expect(screen.getByRole("dialog", { name: "Stream Dock (your control panel)" })).toBeTruthy();
  });

  it("keeps the icon look before and after loading", async () => {
    render(<LazyHelpLink slug="analyzer-filters" variant="icon" />);
    const fallback = screen.getByRole("link", { name: "Help" });
    expect(fallback.getAttribute("href")).toBe("/help/analyzer-filters");
    expect(fallback.className).toContain("rounded-full");

    const loaded = await screen.findByRole(
      "link",
      { name: "Help: Filters: date, matchup, region and more" },
      LOADED,
    );
    expect(loaded.getAttribute("href")).toBe("/help/analyzer-filters");
    expect(loaded.className).toContain("rounded-full");
  });
});
