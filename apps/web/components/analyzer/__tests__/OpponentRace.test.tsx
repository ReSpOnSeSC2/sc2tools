import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OpponentRace } from "../opponents/OpponentRace";
import type { Opp } from "../opponents/types";

const nina: Opp = {
  pulseId: "108307", name: "Ali", revealedName: "Nina",
  race: "P", races: ["P", "Z"], wins: 2, losses: 3, games: 5,
  winRate: 0.4, lastPlayed: "2026-10-29T12:00:00Z",
};

afterEach(cleanup);

describe("opponent recorded races", () => {
  it("shows both races after the same account switches from Zerg to Protoss", () => {
    render(<OpponentRace row={nina} />);
    expect(screen.getAllByRole("img").map(icon => icon.getAttribute("alt"))).toEqual(["Protoss", "Zerg"]);
  });

  it("unions and normalizes recorded races across merged accounts without duplicates", () => {
    render(<OpponentRace row={{ ...nina, identities: [nina, {
      ...nina, pulseId: "other", race: "T", races: [" zerg ", "T", "Protoss", "R", "unknown"],
    }] }} />);
    expect(screen.getAllByRole("img").map(icon => icon.getAttribute("alt"))).toEqual(["Protoss", "Zerg", "Terran", "Random"]);
  });

  it.each([undefined, [], ["unknown"]])("keeps the legacy race when recorded races are %j", races => {
    render(<OpponentRace row={{ ...nina, race: "Zerg", races }} />);
    expect(screen.getByRole("img", { name: "Zerg" })).toBeTruthy();
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("does not turn unrecognized races into Random", () => {
    render(<OpponentRace row={{ ...nina, race: "unknown", races: ["unknown"] }} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByTitle("Race unknown").textContent).toBe("—");
  });
});
