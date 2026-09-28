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
  it("names the patch era the win rates cover, not one week", () => {
    render(<MatchupGrid matchups={[PVP, PVT]} period="since patch 5.0.16" />);
    expect(screen.getByText("What's winning since patch 5.0.16")).toBeTruthy();
    expect(screen.queryByText(/this week/i)).toBeNull();
    expect(screen.getByRole("link", { name: "Robo First" }).getAttribute("href")).toBe("/guides/pvt/robo-first");
    expect(screen.getByText("408 games")).toBeTruthy();
  });

  it("says a matchup without a published opener needs more games", () => {
    render(<MatchupGrid matchups={[PVP]} period="since patch 5.0.16" />);
    expect(screen.getByText("Not enough games yet.")).toBeTruthy();
  });
});
