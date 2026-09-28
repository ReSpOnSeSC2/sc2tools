/**
 * InstantReport — null-safety: every card renders only when its report
 * section exists (ALL DATA IS REAL), built from the real warpgate payload.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { buildInstantReport, parseInstantPayload, type InstantPayload, type InstantReport as Report } from "@/lib/instant/report";
import { InstantReport } from "../InstantReport";
import { LastLossCard, lossContext } from "../report/LastLossCard";
import { MacroCard } from "../report/MacroCard";
import { MostFacedCard, knownRace } from "../report/MostFacedCard";
import { OPENERS_SHOWN, OpenersCard } from "../report/OpenersCard";
import { RecordByMatchupCard } from "../report/RecordByMatchupCard";
import { winratePercent } from "../report/ReportBits";

const RAW = readFileSync(path.join(__dirname, "../../../lib/instant/__tests__/fixtures/warpgate_payload.json"), "utf8");
const NOW = new Date("2026-09-27T12:00:00Z");

function realWin(): InstantPayload {
  const payload = parseInstantPayload(RAW);
  if (!payload) throw new Error("fixture must parse");
  return payload;
}

/** The real game re-dated as a later loss against the same opponent. */
function realLoss(): InstantPayload {
  return { ...realWin(), gameId: "loss-variant", result: "Defeat", date: "2026-05-09T19:08:12Z" };
}

const CARD_IDS = ["report-matchups", "report-openers", "report-macro", "report-most-faced", "report-last-loss"] as const;

function presentCards(): string[] {
  return CARD_IDS.filter((id) => screen.queryByTestId(id) !== null);
}

afterEach(cleanup);

describe("InstantReport", () => {
  it("renders the header totals and every supported card for real games", () => {
    const report = buildInstantReport([realWin(), realLoss()], NOW);
    render(<InstantReport report={report} />);
    const heading = screen.getByRole("heading", { name: "Your instant report" });
    const totals = within(heading.parentElement ?? document.body);
    expect(totals.getByText("2 games")).toBeTruthy();
    expect(totals.getByText("50% win rate")).toBeTruthy();
    expect(presentCards()).toEqual([...CARD_IDS]);
    const matchups = within(screen.getByTestId("report-matchups"));
    expect(matchups.getByText("Zerg")).toBeTruthy();
    expect(within(screen.getByTestId("report-openers")).getByText("PvZ - Adept Glaives (Robo)")).toBeTruthy();
    expect(within(screen.getByTestId("report-most-faced")).getByText("Squirtuoz")).toBeTruthy();
    expect(within(screen.getByTestId("report-macro")).getByText("72")).toBeTruthy();
  });

  it("hides most-faced and loss autopsy for a single win", () => {
    render(<InstantReport report={buildInstantReport([realWin()], NOW)} />);
    expect(presentCards()).toEqual(["report-matchups", "report-openers", "report-macro"]);
  });

  it("renders only the header when every section is missing", () => {
    const report: Report = {
      asOf: NOW.toISOString(),
      totals: { games: 1, wins: 1, losses: 0 },
      recordByMatchup: null,
      openers: null,
      mostFaced: null,
      macro: null,
      lastLoss: null,
    };
    render(<InstantReport report={report} />);
    expect(screen.getByRole("heading", { name: "Your instant report" })).toBeTruthy();
    expect(presentCards()).toEqual([]);
  });

  it("renders nothing for an empty report", () => {
    const { container } = render(<InstantReport report={buildInstantReport([], NOW)} />);
    expect(container.innerHTML).toBe("");
  });

});

describe("InstantReport macro and missing sections", () => {
  it("drops the macro score but keeps leaks when no game carries a score", () => {
    const noScore = { ...realWin(), macroScore: null };
    render(<InstantReport report={buildInstantReport([noScore], NOW)} />);
    const macro = within(screen.getByTestId("report-macro"));
    expect(macro.queryByText(/average macro score/)).toBeNull();
    expect(macro.getByText("Mineral Float")).toBeTruthy();
  });

  it("hides the macro card when neither score nor leaks exist", () => {
    const bare = { ...realWin(), macroScore: null, macroBreakdown: null };
    render(<InstantReport report={buildInstantReport([bare], NOW)} />);
    expect(screen.queryByTestId("report-macro")).toBeNull();
  });

  it("hides matchups and openers when the payload lacks races and builds", () => {
    const bare = { ...realWin(), myBuild: null, opponent: null };
    render(<InstantReport report={buildInstantReport([bare], NOW)} />);
    expect(screen.queryByTestId("report-matchups")).toBeNull();
    expect(screen.queryByTestId("report-openers")).toBeNull();
  });
});

describe("report cards", () => {
  it("each card renders nothing when its section is null", () => {
    const { container } = render(
      <>
        <RecordByMatchupCard rows={null} />
        <RecordByMatchupCard rows={[]} />
        <OpenersCard rows={null} />
        <MostFacedCard opponent={null} />
        <MacroCard macro={null} />
        <MacroCard macro={{ averageScore: null, games: 0, topLeaks: [] }} />
        <LastLossCard lastLoss={null} />
      </>,
    );
    expect(container.innerHTML).toBe("");
  });

  it("caps the openers list and says how many more exist", () => {
    const rows = Array.from({ length: OPENERS_SHOWN + 2 }, (_, i) => ({
      name: `Build ${i}`,
      games: 1,
      wins: 1,
      losses: 0,
      winrate: 1,
    }));
    render(<OpenersCard rows={rows} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(OPENERS_SHOWN);
    expect(screen.getByText(/\+2 more openers/)).toBeTruthy();
  });

  it("never guesses the most-faced opponent's race", () => {
    expect(knownRace("Zerg")).toBe("Zerg");
    expect(knownRace("random")).toBe("Random");
    expect(knownRace("Unknown")).toBeNull();
    expect(knownRace(null)).toBeNull();
    render(<MostFacedCard opponent={{ name: "Rex", race: "Unknown", games: 2, wins: 1, losses: 1 }} />);
    const card = within(screen.getByTestId("report-most-faced"));
    expect(card.queryByText("Random")).toBeNull();
    expect(card.getByText("Rex")).toBeTruthy();
  });

  it("shows a dash, not 0%, when no game was decided", () => {
    expect(winratePercent(0, 0)).toBeNull();
    render(<RecordByMatchupCard rows={[{ matchup: "vs T", oppRace: "T", games: 1, wins: 0, losses: 0, winrate: 0 }]} />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("describes the last loss with only the parts the game has", () => {
    expect(lossContext({ opponent: "Rex", map: null, date: "2026-05-08T19:08:12Z" })).toBe("vs Rex · May 8, 2026");
    expect(lossContext({ opponent: null, map: null, date: "not a date" })).toBe("");
  });
});
