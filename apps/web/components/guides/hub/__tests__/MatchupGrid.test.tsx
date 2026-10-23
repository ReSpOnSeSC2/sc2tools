import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MatchupGrid } from "../MatchupGrid";
import type { GuideIndexMatchup } from "@/lib/guides/types";

afterEach(cleanup);

const PVT: GuideIndexMatchup = {
  matchup: "PvT",
  slug: "pvt",
  published: true,
  games: 408,
  users: 6,
  publishedBuilds: 1,
  top: [{
    buildKey: "robo-first",
    buildSlug: "robo-first",
    name: "Robo First",
    games: 109,
    users: 5,
    winRate: 0.5505,
    ci: { low: 0.46, high: 0.64 },
    trend: null,
    isNew: false,
  }],
};

const PVP: GuideIndexMatchup = {
  matchup: "PvP", slug: "pvp", published: false, games: 230, users: 6, publishedBuilds: 0, top: [],
};

describe("MatchupGrid", () => {
  it("leaves the era to the section and keeps the opener links independent", () => {
    const { container } = render(<MatchupGrid matchups={[PVP, PVT]} />);
    expect(screen.queryByText(/What's winning/)).toBeNull();
    expect(screen.queryByText(/this week/i)).toBeNull();
    expect(screen.getByRole("link", { name: "Robo First" }).getAttribute("href")).toBe("/guides/pvt/robo-first");
    expect(screen.getByText("408 games")).toBeTruthy();
    expect(container.querySelectorAll("[data-stretched-guide-link]")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Robo First" }).className).toContain("z-10");
    expect(screen.getByRole("link", { name: "All 1 opener →" }).getAttribute("href")).toBe("/guides/pvt");
    expect(screen.getByRole("link", { name: "How to beat Terran openers →" }).getAttribute("href")).toBe("/guides/pvt/counter");
    expect(screen.getByText(/too close to call/).className).toContain("sr-only");
    expect(container.querySelector('[data-race-icon="Protoss"]')?.getAttribute("src")).toContain("protoss.svg");
  });

  it("says a matchup without a published opener needs more games", () => {
    render(<MatchupGrid matchups={[PVP]} period="with 12 starting workers" />);
    expect(screen.getByText("Not enough games yet.")).toBeTruthy();
  });
});
