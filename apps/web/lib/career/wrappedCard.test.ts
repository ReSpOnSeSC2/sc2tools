import { expect, it } from "vitest";
import { computeSeasonRecap } from "@/lib/seasonRecap";
import { projectWrappedCard, wrappedShareText } from "./wrappedCard";

it("projects an exact numeric allowlist, excluding private names, IDs, maps and ratings", () => {
  const games = [1, 2].map((number) => ({
    gameId: `Replay/Private ID ${number}.SC2Replay`,
    date: `2026-04-0${number}T02:11:38Z`,
    result: "Win",
    myToonHandle: "1-S2-1-12345",
    myRace: "P",
    myMmr: 5193 + number,
    oppMmr: 5786,
    duration: 600,
    map: "Private Map",
    opponent: { displayName: "Secret Opponent", toonHandle: "1-S2-1-6789", race: "T" },
  }));
  const recap = computeSeasonRecap(games, { since: new Date("2026-01-01") });
  expect(recap.biggestUpset).not.toBeNull();
  const card = projectWrappedCard(recap);
  expect(card).toEqual({ year: 2026, games: 2, wins: 2, losses: 0, minutes: 20, longestWinStreak: 2 });
  expect(wrappedShareText(card)).toBe("My 2026 in StarCraft II\n2 ladder games, 2 wins, 0 losses\nhttps://sc2tools.com/wrapped");
  expect(wrappedShareText({ ...card, games: 1, wins: 1 })).toBe("My 2026 in StarCraft II\n1 ladder game, 1 win, 0 losses\nhttps://sc2tools.com/wrapped");
});
