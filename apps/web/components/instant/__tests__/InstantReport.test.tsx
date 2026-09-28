/**
 * InstantReport — null-safety: every card renders only when its report
 * section exists (ALL DATA IS REAL), built from the real warpgate payload.
 * The game-by-game section has its own suite (GamesSection.test.tsx).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildInstantReport, type InstantPayload, type InstantReport as Report } from "@/lib/instant/report";
import { realWin } from "@/lib/instant/__tests__/fixtures/reportGames";
import { InstantReport } from "../InstantReport";
import { LastLossCard, lossContext } from "../report/LastLossCard";
import { MacroCard } from "../report/MacroCard";
import { MmrCard } from "../report/MmrCard";
import { MostFacedCard, knownRace } from "../report/MostFacedCard";
import { OPENERS_SHOWN, OpenersCard, OpponentOpenersCard } from "../report/OpenersCard";
import { RecordByMatchupCard } from "../report/RecordByMatchupCard";
import { winratePercent } from "../report/ReportBits";

// MOCK: the lazily loaded macro chart is exercised in GamesSection.test.tsx;
// here a stub keeps these card-level tests synchronous.
vi.mock("../report/LazyMacroChart", () => ({
  LazyMacroChart: () => <div data-testid="macro-chart-stub" />,
}));
// MOCK: next/image needs the Next runtime; a bare <img> is equivalent here.
vi.mock("next/image", () => ({
  default: (props: { src?: string; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={String(props.src ?? "")} alt={props.alt ?? ""} />
  ),
}));

const NOW = new Date("2026-09-27T12:00:00Z");

/** The real game re-dated as a later loss against the same opponent. */
function realLoss(): InstantPayload {
  return { ...realWin(), gameId: "loss-variant", result: "Defeat", date: "2026-05-09T19:08:12Z" };
}

const CARD_IDS = [
  "report-matchups",
  "report-macro",
  "report-openers",
  "report-opp-openers",
  "report-mmr",
  "report-most-faced",
  "report-last-loss",
  "report-games",
] as const;

function presentCards(): string[] {
  return CARD_IDS.filter((id) => screen.queryByTestId(id) !== null);
}

afterEach(cleanup);

describe("InstantReport", () => {
  it("renders the header totals and every supported card for real games", async () => {
    const report = buildInstantReport([realWin(), realLoss()], NOW);
    render(<InstantReport report={report} />);
    // "Game by game" is code-split: its skeleton shows until the chunk loads.
    await screen.findByTestId("report-games");
    const heading = screen.getByRole("heading", { name: "Your instant report" });
    const totals = within(heading.parentElement ?? document.body);
    expect(totals.getByText("2 games")).toBeTruthy();
    expect(totals.getByText("50% win rate")).toBeTruthy();
    expect(presentCards()).toEqual([...CARD_IDS]);
    const matchups = within(screen.getByTestId("report-matchups"));
    expect(matchups.getByText("Zerg")).toBeTruthy();
    expect(within(screen.getByTestId("report-openers")).getByText("PvZ - Adept Glaives (Robo)")).toBeTruthy();
    expect(within(screen.getByTestId("report-opp-openers")).getByText("ZvP - Speedling Flood")).toBeTruthy();
    expect(within(screen.getByTestId("report-most-faced")).getByText("Squirtuoz")).toBeTruthy();
    expect(within(screen.getByTestId("report-macro")).getByText("72")).toBeTruthy();
  });

  it("hides most-faced, MMR journey and loss autopsy for a single win", async () => {
    render(<InstantReport report={buildInstantReport([realWin()], NOW)} />);
    await screen.findByTestId("report-games");
    expect(presentCards()).toEqual(["report-matchups", "report-macro", "report-openers", "report-opp-openers", "report-games"]);
  });

  it("renders only the header when every section is missing", () => {
    const report: Report = {
      asOf: NOW.toISOString(),
      totals: { games: 1, wins: 1, losses: 0 },
      recordByMatchup: null,
      openers: null,
      opponentOpeners: null,
      mostFaced: null,
      macro: null,
      mmr: null,
      lastLoss: null,
      games: [],
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
    expect(screen.queryByTestId("report-opp-openers")).toBeNull();
  });

  it("keeps opponent openers when only the opponent's strategy is known", () => {
    const win = realWin();
    const theirsOnly = { ...win, myBuild: null };
    render(<InstantReport report={buildInstantReport([theirsOnly], NOW)} />);
    expect(screen.queryByTestId("report-openers")).toBeNull();
    const card = within(screen.getByTestId("report-opp-openers"));
    expect(card.getByText("What your opponents opened with, and how you did against it.")).toBeTruthy();
    expect(card.getByText("ZvP - Speedling Flood")).toBeTruthy();
    expect(card.getByText("100%")).toBeTruthy();
  });

  it("hides opponent openers when no game has an opponent strategy", () => {
    const win = realWin();
    const noStrategy = { ...win, opponent: win.opponent ? { ...win.opponent, strategy: null } : null };
    render(<InstantReport report={buildInstantReport([noStrategy], NOW)} />);
    expect(screen.getByTestId("report-openers")).toBeTruthy();
    expect(screen.queryByTestId("report-opp-openers")).toBeNull();
  });
});

describe("report cards", () => {
  it("each card renders nothing when its section is null", () => {
    const { container } = render(
      <>
        <RecordByMatchupCard rows={null} />
        <RecordByMatchupCard rows={[]} />
        <OpenersCard rows={null} />
        <OpponentOpenersCard rows={null} />
        <OpponentOpenersCard rows={[]} />
        <MmrCard rows={null} />
        <MmrCard rows={[]} />
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
});

describe("MMR card", () => {
  it("shows each queue's first → latest pre-game MMR, change and peak", () => {
    const row = {
      toonHandle: "5-S2-1-526043",
      region: "CN",
      accountLabel: "CN 526043",
      race: "Terran",
      games: 2,
      start: 3703,
      end: 3671,
      peak: 3703,
      delta: -32,
    };
    render(<MmrCard rows={[row]} />);
    const card = within(screen.getByTestId("report-mmr"));
    expect(card.getByText("CN 526043 · Terran queue")).toBeTruthy();
    expect(card.getByText("\u221232")).toBeTruthy();
    expect(card.getByText("peak 3,703")).toBeTruthy();
    expect(card.getByText(/Replays record MMR at the start of each game/)).toBeTruthy();
  });
});

describe("report card details", () => {
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
