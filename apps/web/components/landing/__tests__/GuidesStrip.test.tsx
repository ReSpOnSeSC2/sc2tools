import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { GuidesStrip } from "../GuidesStrip";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("GuidesStrip (landing)", () => {
  it("links the guide hub and all nine matchup pages while guides are on", () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "true");
    render(<GuidesStrip />);
    expect(screen.getByRole("link", { name: /Browse build guides/ }).getAttribute("href")).toBe("/guides");
    const list = screen.getByRole("list", { name: "Build guides by matchup" });
    const hrefs = within(list)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual([
      "/guides/pvp",
      "/guides/pvt",
      "/guides/pvz",
      "/guides/tvp",
      "/guides/tvt",
      "/guides/tvz",
      "/guides/zvp",
      "/guides/zvt",
      "/guides/zvz",
    ]);
    expect(within(list).getByRole("link", { name: "PvZ build guides" })).toBeTruthy();
  });

  it("carries no numbers (the guides hold the real win rates)", () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "1");
    render(<GuidesStrip />);
    expect(screen.getByTestId("landing-guides-strip").textContent).not.toMatch(/\d/);
  });

  it("renders nothing while guides are off", () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "0");
    const { container } = render(<GuidesStrip />);
    expect(container.innerHTML).toBe("");
  });
});
